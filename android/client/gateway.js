// Host access for the workspace, ported from mac/clients/desktop/gateway.mjs and
// streams.mjs. Requests go to the page's own origin; the Android shell forwards
// them to the paired Host and adds the device credential, which the page never holds.
import { grokText } from './desktop/i18n.mjs';
import { combineSignals, timeout } from './native.js';

const FIRST_RETRY_MS = 500, MAX_RETRY_MS = 10000, STABLE_STREAM_MS = 30000;
const COORDINATOR_VERSION = 3;
const VALID_TRANSPORT_KINDS = new Set([
  'refused', 'timeout', 'http_5xx', 'dns', 'no_storage', 'access_denied', 'box_blocked', 'network', 'pod_hibernated',
]);
// Replies and events that carry the address of a Bot computer.
const DESKTOP_METHODS = new Set(['getForeverBoxStatus', 'ensureForeverBox', 'getSubagents']);

export function desktopSlot(address) {
  try { return /^\/vnc\/(desktop|fork)\//.exec(new URL(address, globalThis.location?.href).pathname)?.[1] ?? null; }
  catch { return null; }
}

export function classifyTransportKind(error) {
  if (!error || error instanceof SyntaxError) return undefined;
  if (VALID_TRANSPORT_KINDS.has(error.transportKind)) return error.transportKind;
  if (typeof error.httpStatus === 'number') {
    if (error.httpStatus === 401 || error.httpStatus === 403) return 'access_denied';
    if (error.httpStatus === 408 || error.httpStatus === 504) return 'timeout';
    if (error.httpStatus === 507) return 'no_storage';
    if (error.httpStatus >= 500 && error.httpStatus <= 599) return 'http_5xx';
    return undefined;
  }
  const code = error?.cause?.code ?? error?.code;
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return 'timeout';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (error.name === 'TimeoutError' || /timed?\s*out/i.test(String(error.message ?? ''))) return 'timeout';
  return 'network';
}

export async function readSse(body, consume, options = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value?.byteLength) options?.onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 16 * 1024 * 1024) throw new Error('事件超过大小限制');
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        options?.onActivity?.();
        const lines = block.split(/\r?\n/);
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        await consume({ data: JSON.parse(data),
          id: lines.find(line => line.startsWith('id:'))?.slice(3).trim(),
          event: lines.find(line => line.startsWith('event:'))?.slice(6).trim() });
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

export function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function subscribe(endpoint, consume, signal, options = {}) {
  let retryMs = FIRST_RETRY_MS, lastId = options.lastId ?? '';
  let currentAttempt = null, currentWait = null, reconnectRequested = false;
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) && options.idleTimeoutMs > 0 ? options.idleTimeoutMs : 0;
  const unregisterReconnect = options.registerReconnect?.(() => {
    retryMs = FIRST_RETRY_MS;
    reconnectRequested = true;
    currentAttempt?.abort(new Error('Stream reconnect requested'));
    currentWait?.abort();
  });
  try {
    while (!signal.aborted) {
      reconnectRequested = false;
      let openedAt, idleTimer;
      const request = new AbortController();
      currentAttempt = request;
      const abort = () => request.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => request.abort(), 15000);
      const touchActivity = () => {
        options.onActivity?.();
        if (idleTimeoutMs > 0 && !request.signal.aborted) {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => request.abort(new Error('事件流心跳超时')), idleTimeoutMs);
        }
      };
      try {
        const response = await fetch(endpoint, {
          headers: lastId ? { 'Last-Event-ID': lastId } : {},
          signal: request.signal, redirect: 'error', credentials: 'same-origin', cache: 'no-store',
        });
        clearTimeout(timer);
        if (request.signal.aborted) throw request.signal.reason;
        if (response.status === 401) { options.onUnauthorized?.(); return; }
        if (response.status !== 200 || !response.body) throw new Error(`HTTP ${response.status}`);
        if (options.requireEventStream && response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'text/event-stream')
          throw new Error('Expected a text/event-stream response');
        openedAt = performance.now();
        touchActivity();
        options.onConnected?.();
        await readSse(response.body, async frame => {
          if (request.signal.aborted) throw request.signal.reason;
          await consume(frame);
          if (frame.id !== undefined && !frame.id.includes('\0')) lastId = frame.id;
        }, { onActivity: touchActivity });
        throw new Error('事件连接结束');
      } catch {
        if (signal.aborted) return;
        // A proxy may send 200 (even an initial snapshot) and immediately close each time.
        if (reconnectRequested || (openedAt !== undefined && performance.now() - openedAt >= STABLE_STREAM_MS)) {
          retryMs = FIRST_RETRY_MS;
        }
        options.onDisconnected?.();
      } finally {
        clearTimeout(idleTimer);
        clearTimeout(timer);
        currentAttempt = null;
        signal.removeEventListener('abort', abort);
        request.abort();
      }
      if (!reconnectRequested) {
        const waitControl = new AbortController();
        currentWait = waitControl;
        const combined = combineSignals([signal, waitControl.signal]);
        try { await wait(retryMs, combined.signal); }
        catch { if (signal.aborted) return; }
        finally { currentWait = null; combined.dispose(); }
      }
      if (signal.aborted) return;
      retryMs = reconnectRequested ? FIRST_RETRY_MS : Math.min(retryMs * 2, MAX_RETRY_MS);
    }
  } finally {
    unregisterReconnect?.();
  }
}

export function createGateway({ onUnauthorized, onConnected, onStateChanged, streamIdleTimeoutMs = 45000 } = {}) {
  const lifetime = new AbortController();
  const streams = new Set();
  const reconnectors = new Set();
  let state = 'connecting';
  let lastActivityAt = 0;
  const updateState = value => { if (state !== value) { state = value; onStateChanged?.(value); } };
  const closed = () => new Error(grokText('已退出连接，请重新连接。', 'Disconnected. Connect again.'));
  // Each vncUrl holds a ticket that expires ten minutes after the Host issues it, but the
  // renderer keeps the address from the last box status it read and on a phone builds the
  // computer view only when it opens. Remember which Bot each desktop slot belongs to so
  // the view can read a current ticket then.
  const desktopOwners = new Map();
  const noteDesktops = (value, owner) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) noteDesktops(item, owner); return; }
    const id = typeof value.agentId === 'string' ? value.agentId : owner;
    for (const [key, item] of Object.entries(value)) {
      if (key !== 'vncUrl') noteDesktops(item, id);
      else if (typeof item === 'string' && typeof id === 'string' && desktopSlot(item)) desktopOwners.set(desktopSlot(item), id);
    }
  };

  async function request(endpoint, args, signal, method = 'POST') {
    if (lifetime.signal.aborted) throw closed();
    const combined = combineSignals([signal, lifetime.signal]);
    try {
      const response = await fetch(endpoint, {
        method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
        ...(method === 'GET' ? {} : { body: JSON.stringify(args ?? {}) }),
        signal: combined.signal,
      });
      if (combined.signal.aborted) throw combined.signal.reason;
      if (response.status === 401) onUnauthorized?.();
      if (!response.ok) {
        const value = await response.json().catch(() => null);
        throw Object.assign(new Error(value?.message ?? value?.error ?? `HTTP ${response.status}`),
          { httpStatus: response.status, failureCode: value?.failureCode, transportKind: value?.transportKind });
      }
      return response.status === 204 || response.status === 205 ? null : await response.json();
    } finally { combined.dispose(); }
  }

  async function command(method, args = {}, signal) {
    if (lifetime.signal.aborted) throw closed();
    if (method === 'getServerAgentRoster') return { status: 'disabled' };
    if (method === 'getMainAgent') return { agentId: null };
    if (method === 'resolveAgentCreation') return { kind: 'box' };
    if (method === 'restoreTemporalAgentRouting' || method === 'noteMountedAgent') return null;
    if (method === 'createAgent') { const { creationRoute, ...rest } = args ?? {}; args = rest; }
    // Desktop 1.1.0 renamed global search and pages older results; the Host answers in one page.
    if (method === 'searchMessages' || method === 'searchFiles') {
      const matches = await request(`/api/${method === 'searchMessages' ? 'searchAgents' : 'searchMedia'}`, { query: args?.query }, signal);
      return { matches, coverage: { kind: 'complete' } };
    }
    // The Host keeps no read receipts for transcripts and has no pending lessons to offer.
    if (method === 'noteTranscriptOpened') return null;
    if (method === 'takeTeachLearningPrompts') return [];
    const transientRetry = async () => {
      try {
        return await request(`/api/${encodeURIComponent(method)}`, args, signal);
      } catch (error) {
        if (method === 'getForeverBoxStatus' && error?.httpStatus == null && !signal?.aborted && !lifetime.signal.aborted) {
          await wait(250, signal ? combineSignals([signal, lifetime.signal]).signal : lifetime.signal).catch(() => {});
          if (!signal?.aborted && !lifetime.signal.aborted) {
            return await request(`/api/${encodeURIComponent(method)}`, args, signal);
          }
        }
        throw error;
      }
    };
    const value = await transientRetry();
    if (DESKTOP_METHODS.has(method)) noteDesktops(value, args?.id);
    return value;
  }

  /** A ticket for the desktop slot that is valid now, or null when the Bot computer is not running. */
  async function desktopTicket(slot, signal) {
    const id = desktopOwners.get(slot);
    if (!id) return null;
    const status = await request('/api/getForeverBoxStatus', { id }, signal);
    const found = [];
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (key === 'vncUrl' && typeof item === 'string' && desktopSlot(item) === slot) found.push(item);
        else walk(item);
      }
    };
    walk(status);
    return found.length ? new URL(found[0], globalThis.location?.href).searchParams.get('ticket') : null;
  }

  /** Serves the original coordinator protocol on a MessagePort from the renderer. */
  function attach(port) {
    const controller = new AbortController();
    if (lifetime.signal.aborted) { port.close(); return () => {}; }
    let subscribed = false, generation = 0;
    let unregisterReconnect = null;
    const pending = new Map();
    const send = frame => { if (!controller.signal.aborted) port.postMessage(frame); };
    const emit = (family, payload) => send({ kind: 'event', family, payload });
    const receive = async ({ data: frame }) => {
      if (!frame || controller.signal.aborted) return;
      if (frame.kind === 'lifecycle' && frame.phase === 'hello') {
        // Legacy renderers omit the version; an explicit mismatch tears down even a live port.
        if (Object.prototype.hasOwnProperty.call(frame, 'protocolVersion') && frame.protocolVersion !== COORDINATOR_VERSION) {
          dispose(); return;
        }
        if (subscribed) return;
        subscribed = true;
        send({ kind: 'lifecycle', phase: 'ready', protocolVersion: COORDINATOR_VERSION });
        void subscribe('/events', ({ data }) => {
          if (data.channel === 'forever-box') noteDesktops(data.payload);
          if (data.channel) emit(data.channel, data.payload);
        }, controller.signal, {
          requireEventStream: true,
          idleTimeoutMs: streamIdleTimeoutMs,
          onActivity: () => { lastActivityAt = Date.now(); },
          registerReconnect: fn => {
            reconnectors.add(fn);
            unregisterReconnect = () => reconnectors.delete(fn);
            return unregisterReconnect;
          },
          onConnected: () => {
            streams.add(controller); updateState('online');
            emit('coordinator-transport-state', { state: 'connected' });
            emit('transport-connected', { generation: ++generation }); onConnected?.();
          },
          onDisconnected: () => {
            streams.delete(controller); if (!streams.size) updateState('reconnecting');
            emit('coordinator-transport-state', { state: 'down' });
            emit('transport-down', { generation, reason: 'stream-error', cause: null });
          },
          onUnauthorized,
        });
      } else if (frame.kind === 'lifecycle' && frame.phase === 'shutdown') {
        dispose();
      } else if (frame.kind === 'cancel') {
        pending.get(frame.requestId)?.abort();
      } else if (frame.kind === 'request' && !pending.has(frame.requestId)) {
        const call = new AbortController();
        pending.set(frame.requestId, call);
        try {
          const value = await command(frame.method, frame.args, call.signal);
          if (call.signal.aborted) throw call.signal.reason;
          send({ kind: 'reply', requestId: frame.requestId,
            outcome: { status: 'ok', value } });
        } catch (error) {
          const transportKind = call.signal.aborted ? undefined : classifyTransportKind(error);
          send({ kind: 'reply', requestId: frame.requestId, outcome: { status: 'failed', failure: {
            code: call.signal.aborted ? 'cancelled' : error instanceof SyntaxError ? 'gateway-malformed-reply' : 'gateway-command-failed',
            message: error.message,
            ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
            ...(error.failureCode ? { failureCode: error.failureCode } : {}),
            ...(transportKind ? { transportKind } : {}),
          } } });
        } finally { pending.delete(frame.requestId); }
      }
    };
    const listener = event => { void receive(event); };
    const cleanup = () => {
      if (controller.signal.aborted) return;
      controller.abort(); streams.delete(controller); unregisterReconnect?.();
      for (const call of pending.values()) call.abort();
      pending.clear();
      lifetime.signal.removeEventListener('abort', dispose);
      port.removeEventListener('message', listener);
      port.removeEventListener('close', cleanup);
      if (!streams.size && !lifetime.signal.aborted) updateState('reconnecting');
    };
    const dispose = () => { if (!controller.signal.aborted) { cleanup(); port.close(); } };
    lifetime.signal.addEventListener('abort', dispose, { once: true });
    port.addEventListener('message', listener);
    port.addEventListener('close', cleanup);
    port.start();
    return dispose;
  }

  function reconnectStreams({ onlyIfStaleMs = 0 } = {}) {
    if (lifetime.signal.aborted) return false;
    const stale = !streams.size || onlyIfStaleMs <= 0 || lastActivityAt === 0 || Date.now() - lastActivityAt >= onlyIfStaleMs;
    if (!stale) return false;
    for (const reconnect of [...reconnectors]) reconnect();
    return reconnectors.size > 0;
  }

  return { command, request, attach, desktopTicket, getState: () => state,
    reconnectStreams, getLastActivityAt: () => lastActivityAt,
    close: () => { lifetime.abort(); updateState('disconnected'); } };
}

export { timeout };
