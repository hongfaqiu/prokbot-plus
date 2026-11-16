import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { JsonStore } from './storage.mjs';
import { check, equal, hash, secret, RateLimit } from './security.mjs';
import {
  claimWebhookEvent,
  finishWebhookEvent,
  markClaimedRunning,
  pruneWebhookEvents,
  readRawBody,
  WEBHOOK_MAX_BODY,
} from './webhook-queue.mjs';

const MAX_EVENT_BODY = 32768;
const EXCLUDED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'x-real-ip',
  'forwarded',
]);

const isLoopbackOrigin = value => /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(value);

/** Prefer the Host's configured public origin over a loopback connection, unless on Tailcat with no public URL. */
export function resolveWebhookOrigin({ canonical, requestOrigin, isIngress = false }) {
  return isIngress && (!canonical || isLoopbackOrigin(canonical)) ? requestOrigin : (canonical ?? requestOrigin);
}

/** Match the deterministic UUID v5-style automation ID used by the original Sand host. */
export function stableAutomationId(agentId, localId) {
  const hex = createHash('sha256').update(`${agentId}\0${localId}`).digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function hasWebhookTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object') return false;
  if (trigger.type === 'webhook') return true;
  return trigger.type === 'group' && Array.isArray(trigger.listeners) && trigger.listeners.some(item => item?.type === 'webhook');
}

function bearerToken(request) {
  const value = request.headers?.authorization;
  const match = typeof value === 'string' ? /^Bearer\s+([A-Za-z0-9_-]{32,256})$/i.exec(value.trim()) : null;
  return match ? match[1] : null;
}

function sanitizeHeaders(rawHeaders) {
  const headers = {};
  if (!rawHeaders || typeof rawHeaders !== 'object') return headers;
  let count = 0;
  for (const [name, value] of Object.entries(rawHeaders)) {
    const key = name.toLowerCase();
    if (EXCLUDED_HEADERS.has(key) || key.startsWith('x-forwarded-')) continue;
    const text = Array.isArray(value) ? value.join(', ') : value;
    if (typeof text !== 'string' || !text.length) continue;
    headers[key] = text.slice(0, 500);
    if (++count >= 20) break;
  }
  return headers;
}

function cancelQueued(state, automationId, now) {
  for (const event of state.events) {
    if (event.automationId === automationId && event.state === 'queued') {
      event.state = 'cancelled';
      event.finishedAt = now;
      delete event.body;
    }
  }
}

/** Persistent bearer credentials and inbound queue for native webhook-triggered routines. */
export class AutomationWebhooks {
  constructor(directory, { now = Date.now } = {}) {
    this.store = new JsonStore(join(directory, 'automation-webhooks.json'), {
      version: 1,
      credentials: {},
      events: [],
      worker: null,
    });
    this.now = now;
    this.limiter = new RateLimit();
  }
  async load() { await this.store.load(); return this; }
  async ensureCredential({ agentId, localId, createdAt }) {
    check(typeof agentId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(agentId), 400, 'Invalid target Bot');
    check(typeof localId === 'string' && localId.length > 0 && localId.length <= 200, 400, 'Invalid routine ID');
    const automationId = stableAutomationId(agentId, localId);
    const existing = this.store.value.credentials[automationId];
    if (existing && (createdAt === undefined || existing.createdAt === createdAt)) {
      return { ...existing };
    }
    return this.store.mutate(state => {
      const current = state.credentials[automationId];
      if (current && (createdAt === undefined || current.createdAt === createdAt)) {
        return { ...current };
      }
      const entry = {
        automationId,
        agentId,
        localId,
        key: secret(),
        createdAt: createdAt ?? this.now(),
        updatedAt: this.now(),
      };
      state.credentials[automationId] = entry;
      return { ...entry };
    });
  }
  async removeAgents(agentIds) {
    const doomed = new Set(agentIds ?? []);
    if (!doomed.size) return;
    await this.store.mutate(state => {
      const now = this.now();
      for (const [automationId, entry] of Object.entries(state.credentials)) {
        if (!doomed.has(entry.agentId)) continue;
        delete state.credentials[automationId];
        cancelQueued(state, automationId, now);
      }
    });
  }
  async receive(request, automationId, { verifyAutomation }) {
    this.limiter.check(`source:${request.socket?.remoteAddress ?? 'unknown'}`, 240);
    const cred = this.store.value.credentials[automationId];
    check(cred, 404, 'Webhook not found');
    const token = bearerToken(request);
    check(token && equal(token, cred.key), 401, 'Invalid webhook credential');
    const raw = await readRawBody(request, WEBHOOK_MAX_BODY);
    const digest = `sha256:${hash(raw)}`;
    const bodyText = raw.toString('utf8').slice(0, MAX_EVENT_BODY);
    let eventType = '';
    if (raw.length > 0) {
      try {
        const parsed = JSON.parse(raw.toString('utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.type === 'string') {
          eventType = parsed.type.slice(0, 100);
        }
      } catch {}
    }
    const status = await verifyAutomation(cred.agentId, cred.localId);
    if (!status?.exists || (status.createdAt !== undefined && cred.createdAt !== status.createdAt)) {
      await this.store.mutate(state => {
        if (state.credentials[automationId]?.createdAt === cred.createdAt) {
          delete state.credentials[automationId];
          cancelQueued(state, automationId, this.now());
        }
      });
      check(false, 404, 'Webhook not found');
    }
    check(status.enabled, 409, 'Routine is disabled');
    const headers = sanitizeHeaders(request.headers);
    const label = status.name || cred.localId;
    const context = eventType ? `${label}: ${eventType}` : label;
    return this.store.mutate(state => {
      const current = state.credentials[automationId];
      check(current && equal(current.key, cred.key), 401, 'Webhook credential was rotated');
      this.limiter.check(`automation:${automationId}`, 60);
      pruneWebhookEvents(state, { incomingBytes: raw.length, now: this.now() });
      const event = {
        id: randomUUID(),
        automationId,
        agentId: current.agentId,
        localId: current.localId,
        headers,
        digest,
        body: bodyText,
        context,
        state: 'queued',
        receivedAt: this.now(),
      };
      state.events.push(event);
      return { ok: true, id: event.id, automationId, state: event.state };
    });
  }
  async claim(worker) {
    return claimWebhookEvent(this.store, worker, this.now, (_state, event) => {
      if (event.state === 'queued') markClaimedRunning(event, worker, this.now);
      return { event: { ...event } };
    });
  }
  async finish(payload) {
    return finishWebhookEvent(this.store, payload, this.now);
  }
}

export async function resolveAutomationWebhookCredential({
  automationWebhooks,
  agentId,
  localId,
  verifyAgent,
  hostCall,
  origin,
}) {
  check(typeof agentId === 'string' && typeof localId === 'string', 400, 'Invalid request');
  await verifyAgent(agentId);
  const list = await hostCall('getAgentAutomations', { id: agentId });
  const automation = Array.isArray(list) ? list.find(item => item.id === localId) : null;
  check(automation, 404, `Automation not found: ${localId}`);
  check(hasWebhookTrigger(automation.trigger), 400, `Automation is not webhook-triggered: ${localId}`);
  const credential = await automationWebhooks.ensureCredential({
    agentId,
    localId,
    createdAt: automation.createdAt,
  });
  return {
    url: `${origin}/automations/webhook/${credential.automationId}`,
    key: credential.key,
  };
}

