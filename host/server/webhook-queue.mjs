import { randomUUID } from 'node:crypto';
import { check, HttpError } from './security.mjs';

export const WEBHOOK_MAX_BODY = 1024 * 1024;
export const WEBHOOK_DAY_MS = 86400000;
export const WEBHOOK_TERMINAL_STATES = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'skipped']);

export async function readRawBody(request, maxBytes = WEBHOOK_MAX_BODY, tooLargeMessage = 'Event too large') {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    check(size <= maxBytes, 413, tooLargeMessage);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function pruneWebhookEvents(state, { maxEvents = 10000, maxPending = 100, maxPendingBytes = 32 * WEBHOOK_MAX_BODY, incomingBytes = 0, now = Date.now() } = {}) {
  state.events = state.events.filter(event => !WEBHOOK_TERMINAL_STATES.has(event.state) || event.finishedAt > now - 30 * WEBHOOK_DAY_MS);
  if (state.events.length >= maxEvents) throw new HttpError(429, 'Webhook history limit reached');
  const pending = state.events.filter(event => !WEBHOOK_TERMINAL_STATES.has(event.state));
  const pendingBytes = pending.reduce((sum, event) => sum + Buffer.byteLength(event.body ?? ''), 0);
  if (pending.length >= maxPending || pendingBytes + incomingBytes > maxPendingBytes) {
    throw new HttpError(429, 'Webhook queue full');
  }
}

export async function claimWebhookEvent(store, worker, now, resolveClaimed) {
  check(typeof worker === 'string' && /^[a-f0-9-]{36}$/.test(worker), 400, 'Invalid worker');
  if (store.value.worker === worker && !store.value.events.some(event => ['queued', 'running'].includes(event.state))) return null;
  return store.mutate(state => {
    if (state.worker !== worker) {
      for (const event of state.events) if (event.state === 'running') {
        event.state = 'interrupted'; event.finishedAt = now(); event.detail = 'Host restarted'; delete event.body;
      }
      state.worker = worker;
    }
    // The Host owns one batch at a time; failed HTTP responses can safely fetch the same claim.
    const held = state.events.find(event => event.state === 'running' && event.worker === worker);
    if (held) return resolveClaimed(state, held, true);
    const event = state.events.find(item => item.state === 'queued');
    if (!event) return null;
    return resolveClaimed(state, event, false);
  });
}

export async function finishWebhookEvent(store, { worker, id, runUuid, state: outcome, detail }, now, view = ({ body, ...event }) => event) {
  check(['completed', 'failed', 'skipped'].includes(outcome), 400, 'Invalid event outcome');
  return store.mutate(state => {
    const event = state.events.find(item => item.id === id);
    check(event && event.worker === worker && event.runUuid === runUuid, 409, 'Event owner changed');
    if (WEBHOOK_TERMINAL_STATES.has(event.state)) return view(event);
    check(event.state === 'running', 409, 'Event is not running');
    Object.assign(event, { state: outcome, finishedAt: now(), detail: String(detail ?? '').slice(0, 300) });
    delete event.body;
    return view(event);
  });
}

export function markClaimedRunning(event, worker, now, extra = {}) {
  Object.assign(event, { state: 'running', worker, runUuid: randomUUID(), startedAt: now(), ...extra });
}
