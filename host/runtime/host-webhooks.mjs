import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonStore } from '../server/storage.mjs';
import { hasWebhookTrigger } from '../server/automation-webhooks.mjs';

function publicOrigin(configured, fallbackOrigin) {
  if (!configured) return fallbackOrigin;
  try {
    const url = new URL(configured);
    if (['http:', 'https:'].includes(url.protocol)) return url.origin;
  } catch {}
  return fallbackOrigin;
}

/** A claimed event enters the original event-automation runtime, never the user-send API. */
export async function startLocalWebhooks(context, { call, interval = 1500, directory = process.env.GROKBOT_DATA_DIR } = {}) {
  let baseOrigin = 'http://127.0.0.1:8000';
  if (!call) {
    if (!process.env.GROKBOT_NOTIFICATION_URL || !process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE) {
      return { suspend() {}, resume() {}, async close() {} };
    }
    const base = new URL(process.env.GROKBOT_NOTIFICATION_URL);
    baseOrigin = base.origin;
    const token = (await readFile(process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE, 'utf8')).trim();
    call = async (channel, method, body) => {
      const response = await fetch(new URL(`/internal/${channel}/${method}`, base), {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Webhook service (${channel}): ${response.status}`); }
      return response.json();
    };
  }
  const mappings = await new JsonStore(join(directory, 'webhook-automations.json'), { version: 1, mappings: {} }).load();
  const worker = randomUUID(), transcript = context.deps.transcript;
  let stopped = false, suspended = false, timer, inFlight = null, pendingFinish, activeKey;

  async function ensureAutomation(hook) {
    const stored = mappings.value.mappings[hook.id];
    const definitions = await transcript.getAgentAutomations(hook.agentId);
    const marker = ` · ${hook.id.slice(0, 8)}`, name = hook.name.slice(0, 60) + marker;
    let automation = definitions.find(item => item.id === stored?.id) ?? definitions.find(item => item.name.endsWith(marker) && item.trigger.type === 'webhook');
    if (automation && stored?.revision === hook.revision) return automation;
    const spec = { name, prompt: hook.prompt, trigger: { type: 'webhook' }, isEnabled: hook.enabled };
    const next = automation ? await transcript.updateAgentAutomation(hook.agentId, automation.id, spec)
      : await transcript.createAgentAutomation(hook.agentId, spec, 'user');
    automation = next.find(item => item.id === automation?.id) ?? next.find(item => item.name === name);
    if (!automation) throw new Error('Could not create the webhook routine');
    await mappings.mutate(state => { state.mappings[hook.id] = { id: automation.id, revision: hook.revision }; });
    return automation;
  }

  async function runHookEvent(claimed) {
    const { event, hook } = claimed;
    if (!hook?.enabled) return 'skipped';
    const automation = await ensureAutomation(hook);
    if (!automation.isEnabled) return 'skipped';
    const result = await transcript.runServerAutomationForEvent({
      agentId: hook.agentId, automation, runUuid: event.runUuid,
      event: {
        source: 'webhook', headers: { 'x-grokbot-event-id': event.eventId }, bodyDigest: event.digest,
        body: event.body, context: `${hook.name}${event.type ? `: ${event.type}` : ''}`, timestampMs: event.receivedAt,
      },
    });
    return result === 'ok' ? 'completed' : result === 'error' || result === 'interrupted' ? 'failed' : 'skipped';
  }

  async function runAutomationWebhookEvent(claimed) {
    const { event } = claimed;
    const definitions = await transcript.getAgentAutomations(event.agentId);
    const automation = definitions.find(item => item.id === event.localId);
    if (!automation?.isEnabled || !hasWebhookTrigger(automation.trigger)) return 'skipped';
    const result = await transcript.runServerAutomationForEvent({
      agentId: event.agentId, automation, runUuid: event.runUuid,
      event: {
        source: 'webhook',
        headers: event.headers ?? {},
        bodyDigest: event.digest,
        body: event.body ?? '',
        context: event.context || automation.name,
        timestampMs: event.receivedAt,
      },
    });
    return result === 'ok' ? 'completed' : result === 'error' || result === 'interrupted' ? 'failed' : 'skipped';
  }

  async function drainChannel(channel, runner) {
    let progressed = false;
    while (!stopped && !suspended) {
      const claimed = await call(channel, 'claim', { worker });
      if (!claimed || stopped) return progressed;
      const { event } = claimed;
      const key = `${channel}:${event.id}`;
      // A response lost after claiming remains owned by this worker; execution starts only here.
      if (activeKey === key) return progressed;
      activeKey = key;
      let outcome = 'skipped', detail = '';
      try {
        outcome = await runner(claimed);
      } catch (error) {
        outcome = 'failed';
        detail = String(error?.message ?? error);
      }
      pendingFinish = { channel, payload: { worker, id: event.id, runUuid: event.runUuid, state: outcome, detail } };
      await call(channel, 'finish', pendingFinish.payload);
      pendingFinish = null;
      activeKey = null;
      progressed = true;
    }
    return progressed;
  }

  function tick() {
    if (stopped || suspended) return inFlight ?? Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        if (pendingFinish) {
          await call(pendingFinish.channel, 'finish', pendingFinish.payload);
          pendingFinish = null;
          activeKey = null;
        }
        if (!await context.deps['turn-execution'].isRunReady() || stopped || suspended) return;
        while (!stopped && !suspended) {
          const ranHook = await drainChannel('webhooks', runHookEvent);
          const ranAuto = await drainChannel('automation-webhooks', runAutomationWebhookEvent);
          if (!ranHook && !ranAuto) break;
        }
      } catch (error) { context.host.log(`[webhooks] ${error.message}`); }
      finally { inFlight = null; }
    })();
    return inFlight;
  }

  async function getWebhookCredential({ agentId, localId }) {
    const definitions = await transcript.getAgentAutomations(agentId);
    const automation = definitions.find(item => item.id === localId);
    if (!automation) throw new Error(`Automation not found: ${localId}`);
    if (!hasWebhookTrigger(automation.trigger)) throw new Error(`Automation is not webhook-triggered: ${localId}`);
    const credential = await call('automation-webhooks', 'credential', {
      agentId, localId, createdAt: automation.createdAt,
    });
    const origin = publicOrigin(process.env.GROKBOT_PUBLIC_URL, baseOrigin);
    return { url: `${origin}/automations/webhook/${credential.automationId}`, key: credential.key };
  }

  timer = setInterval(() => void tick(), interval); timer.unref();
  const api = {
    tick,
    getWebhookCredential,
    suspend() { suspended = true; },
    resume() { suspended = false; void tick(); },
    async close() { stopped = true; clearInterval(timer); await inFlight; await mappings.tail; },
  };
  context.onStop(() => api.close()); void tick(); return api;
}
