import { createHmac, randomUUID } from 'node:crypto';
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

const view = ({ key, ...hook }) => ({ ...hook, hasKey: Boolean(key), path: `/hooks/v1/${hook.id}` });
const eventView = ({ body, ...event }) => event;
export const webhookSignature = (key, path, timestamp, eventId, raw) => createHmac('sha256', key)
  .update(['POST', path, String(timestamp), eventId, hash(raw)].join('\n')).digest('hex');

export class Webhooks {
  constructor(directory, { now = Date.now } = {}) {
    this.store = new JsonStore(join(directory, 'webhooks.json'), { version: 1, hooks: [], events: [], worker: null });
    this.now = now; this.limiter = new RateLimit();
  }
  async load() { await this.store.load(); return this; }
  list() { return this.store.value.hooks.map(view); }
  events() { return this.store.value.events.slice(-200).reverse().map(eventView); }
  async save(input, id) {
    check(input && typeof input.name === 'string' && input.name.trim().length > 0 && input.name.length <= 60, 400, 'Invalid webhook name');
    check(/^[A-Za-z0-9_-]{1,128}$/.test(input.agentId), 400, 'Invalid target Bot');
    check(typeof input.prompt === 'string' && input.prompt.trim().length > 0 && input.prompt.length <= 20000, 400, 'Invalid task template');
    const types = input.eventTypes ?? [];
    check(Array.isArray(types) && types.length <= 30 && types.every(type => typeof type === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(type)), 400, 'Invalid event types');
    const limit = input.ratePerMinute ?? 30;
    check(Number.isInteger(limit) && limit >= 1 && limit <= 120, 400, 'Invalid event rate');
    return this.store.mutate(state => {
      const existing = id && state.hooks.find(hook => hook.id === id);
      check(!id || existing, 404, 'Webhook not found');
      check(existing || state.hooks.length < 100, 409, 'Webhook limit reached');
      check(!existing || existing.agentId === input.agentId, 409, 'Create a new webhook to change its Bot');
      const hook = { id: existing?.id ?? randomUUID(), key: existing?.key ?? secret(), revision: randomUUID(),
        name: input.name.trim(), agentId: input.agentId, prompt: input.prompt.trim(), eventTypes: [...new Set(types)],
        ratePerMinute: limit, enabled: input.enabled !== false, createdAt: existing?.createdAt ?? this.now(), updatedAt: this.now() };
      if (existing) Object.assign(existing, hook); else state.hooks.push(hook);
      if (!hook.enabled) this.cancelQueued(state, hook.id);
      return { ...view(hook), ...(!existing ? { key: hook.key } : {}) };
    });
  }
  cancelQueued(state, id) {
    for (const event of state.events) if (event.hookId === id && event.state === 'queued') {
      event.state = 'cancelled'; event.finishedAt = this.now(); delete event.body;
    }
  }
  async remove(id) {
    return this.store.mutate(state => {
      check(state.hooks.some(hook => hook.id === id), 404, 'Webhook not found');
      state.hooks = state.hooks.filter(hook => hook.id !== id); this.cancelQueued(state, id); return { ok: true };
    });
  }
  async rotate(id) {
    return this.store.mutate(state => {
      const hook = state.hooks.find(hook => hook.id === id); check(hook, 404, 'Webhook not found');
      hook.key = secret(); return { key: hook.key };
    });
  }
  async receive(request, id, path) {
    this.limiter.check(`source:${request.socket.remoteAddress}`, 240);
    const hook = this.store.value.hooks.find(hook => hook.id === id);
    check(hook?.enabled, 404, 'Webhook not found');
    check(String(request.headers['content-type'] ?? '').split(';')[0].trim() === 'application/json', 415, 'JSON required');
    const timestamp = request.headers['x-grokbot-timestamp'], eventId = request.headers['x-grokbot-event-id'];
    const signature = request.headers['x-grokbot-signature'];
    check(typeof timestamp === 'string' && /^\d{10}$/.test(timestamp) && Math.abs(this.now() - Number(timestamp) * 1000) <= 300000, 401, 'Expired webhook signature');
    check(typeof eventId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(eventId), 400, 'Invalid event ID');
    check(typeof signature === 'string' && /^sha256=[a-f0-9]{64}$/.test(signature), 401, 'Invalid webhook signature');
    const raw = await readRawBody(request, WEBHOOK_MAX_BODY);
    check(equal(signature.slice(7), webhookSignature(hook.key, path, timestamp, eventId, raw)), 401, 'Invalid webhook signature');
    let parsed; try { parsed = JSON.parse(raw.toString('utf8')); } catch { check(false, 400, 'Invalid JSON'); }
    check(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 400, 'JSON object required');
    check(!hook.eventTypes.length || hook.eventTypes.includes(parsed.type), 422, 'Event type not allowed');
    const digest = hash(raw);
    return this.store.mutate(state => {
      const current = state.hooks.find(item => item.id === id);
      check(current?.enabled && equal(current.key, hook.key), 401, 'Webhook was revoked');
      const old = state.events.find(event => event.hookId === id && event.eventId === eventId);
      if (old) { check(old.digest === digest, 409, 'Event ID already used with another body'); return { ...eventView(old), duplicate: true }; }
      this.limiter.check(`hook:${id}`, current.ratePerMinute);
      pruneWebhookEvents(state, { incomingBytes: raw.length, now: this.now() });
      const event = { id: randomUUID(), hookId: id, eventId, digest, body: raw.toString('utf8'),
        type: typeof parsed.type === 'string' ? parsed.type.slice(0, 100) : '', state: 'queued', receivedAt: this.now() };
      state.events.push(event); return eventView(event);
    });
  }
  async claim(worker) {
    return claimWebhookEvent(this.store, worker, this.now, (state, event, held) => {
      const hook = state.hooks.find(item => item.id === event.hookId);
      if (held) return { event: { ...event }, hook: hook ? view(hook) : null };
      if (!hook?.enabled) { event.state = 'cancelled'; event.finishedAt = this.now(); delete event.body; return null; }
      markClaimedRunning(event, worker, this.now, { revision: hook.revision });
      return { event: { ...event }, hook: { ...view(hook) } };
    });
  }
  async finish(payload) {
    return finishWebhookEvent(this.store, payload, this.now, eventView);
  }
}
