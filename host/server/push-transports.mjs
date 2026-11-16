import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash, createHmac, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { isPublicPushHost } from './push-config.mjs';

export class PushError extends Error {
  constructor(reason, { retryable = false, invalidToken = false } = {}) {
    super(reason); this.retryable = retryable; this.invalidToken = invalidToken;
  }
}
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export function signApnsToken(config, now = Date.now()) {
  const unsigned = `${b64({ alg: 'ES256', kid: config.keyId })}.${b64({ iss: config.teamId, iat: Math.floor(now / 1000) })}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key: createPrivateKey(config.privateKey), dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${signature.toString('base64url')}`;
}
export function signFcmAssertion(fcm, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: fcm.clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com',
    iat,
    exp: iat + 3600,
  })}`;
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), createPrivateKey(fcm.privateKey));
  return `${unsigned}.${signature.toString('base64url')}`;
}
export function apnsPayload(item) {
  const payload = { aps: { alert: { title: item.title, body: item.body }, sound: 'default', 'thread-id': item.agentId },
    notificationId: item.id, agentId: item.agentId, deepLink: item.deepLink };
  while (Buffer.byteLength(JSON.stringify(payload)) > 4096 && payload.aps.alert.body.length)
    payload.aps.alert.body = [...payload.aps.alert.body].slice(0, -100).join('');
  return JSON.stringify(payload);
}
export function boundedJsonPushPayload(item, maxBytes = 3800) {
  const payload = {
    grokbot: 1,
    notificationId: item.id,
    type: item.type,
    agentId: item.agentId,
    title: item.title,
    body: item.body,
    createdAt: item.createdAt,
    deepLink: item.deepLink,
  };
  while (Buffer.byteLength(JSON.stringify(payload)) > maxBytes && payload.body.length) {
    const chars = [...payload.body];
    payload.body = chars.slice(0, Math.max(0, chars.length - 80)).join('');
  }
  return JSON.stringify(payload);
}
export async function readBoundedText(response, maxBytes = 16384) {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body ?? []) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) throw new Error('oversize');
      chunks.push(buf);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } catch (error) {
    response.body?.destroy?.();
    void response.body?.cancel?.().catch(() => {});
    throw error;
  }
}
export function pinnedPost(url, addresses, { headers, body, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    const payload = Buffer.from(String(body ?? ''), 'utf8');
    const requestHeaders = {
      ...headers,
      'content-length': String(payload.byteLength),
    };
    const req = transport.request(url, {
      method: 'POST',
      headers: requestHeaders,
      agent: false,
      signal,
      lookup: (_host, options, done) => {
        if (typeof options === 'function') {
          done = options;
          options = {};
        }
        const family = options?.family === 4 || options?.family === 6 ? options.family : 0;
        const matching = family ? addresses.filter(item => item.family === family) : addresses;
        if (!matching.length) {
          done(Object.assign(new Error('No verified address'), { code: 'ENOTFOUND' }));
          return;
        }
        if (options?.all) done(null, matching);
        else done(null, matching[0].address, matching[0].family);
      },
    }, res => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.destroy();
        reject(new Error(`Redirect blocked (${status})`));
        return;
      }
      resolve({
        ok: status >= 200 && status < 300,
        status,
        body: res,
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
export class PushTransports {
  constructor({ fetchImpl, connect = http2.connect, lookupImpl } = {}) {
    this.hasCustomFetch = typeof fetchImpl === 'function';
    this.fetch = fetchImpl ?? fetch;
    this.connect = connect;
    this.hasCustomLookup = typeof lookupImpl === 'function';
    this.lookup = lookupImpl ?? lookup;
    this.sessions = new Map();
    this.tokens = new Map(); this.fcmTokens = new Map();
    this.abort = new AbortController();
  }
  async resolvePublicEndpoint(rawEndpoint, { urlLabel, connLabel }, signal) {
    let url;
    try { url = new URL(rawEndpoint); } catch {
      throw new PushError(`${urlLabel}不能使用本机、内网或保留地址`, { retryable: false });
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !isPublicPushHost(url.hostname)) {
      throw new PushError(`${urlLabel}不能使用本机、内网或保留地址`, { retryable: false });
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    const literalFamily = isIP(hostname);
    if (literalFamily) {
      return { url, addresses: [{ address: hostname, family: literalFamily }] };
    }
    if (this.hasCustomFetch && !this.hasCustomLookup) {
      return { url, addresses: null };
    }
    if (signal?.aborted) {
      throw new PushError(`${connLabel} 连接失败`, { retryable: true });
    }
    let addresses;
    try {
      let onAbort;
      const abortPromise = signal ? new Promise((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }) : null;
      try {
        const lookupPromise = this.lookup(hostname, { all: true });
        addresses = await (abortPromise ? Promise.race([lookupPromise, abortPromise]) : lookupPromise);
      } finally {
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      }
    } catch {
      throw new PushError(`${connLabel} 连接失败`, { retryable: true });
    }
    if (!Array.isArray(addresses) || !addresses.length) {
      throw new PushError(`${urlLabel}不能使用本机、内网或保留地址`, { retryable: false });
    }
    const normalized = addresses.map(item => {
      const address = typeof item?.address === 'string' ? item.address.trim() : '';
      const ipFamily = isIP(address);
      const declaredFamily = item?.family;
      const familyValid = declaredFamily === undefined || declaredFamily === 0 || declaredFamily === ipFamily;
      return { address, family: ipFamily, familyValid };
    });
    if (normalized.some(item => !item.address || !(item.family === 4 || item.family === 6) || !item.familyValid || !isPublicPushHost(item.address))) {
      throw new PushError(`${urlLabel}不能使用本机、内网或保留地址`, { retryable: false });
    }
    return { url, addresses: normalized.map(({ address, family }) => ({ address, family })) };
  }
  async postPublicEndpoint(rawEndpoint, { urlLabel, connLabel, headers, body, signal }) {
    const { url, addresses } = await this.resolvePublicEndpoint(rawEndpoint, { urlLabel, connLabel }, signal);
    try {
      if (this.hasCustomFetch) {
        return await this.fetch(rawEndpoint, { method: 'POST', redirect: 'error', headers, body, signal });
      }
      return await pinnedPost(url, addresses, { headers, body, signal });
    } catch {
      throw new PushError(`${connLabel} 连接失败`, { retryable: true });
    }
  }
  async bark(device, item) {
    const response = await this.postPublicEndpoint(device.bark.endpoint, {
      urlLabel: 'Bark 链接',
      connLabel: 'Bark',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_key: device.bark.key, title: item.title, body: item.body,
        group: 'Grok Bot', ...(device.iconUrl ? { icon: device.iconUrl } : {}), url: item.deepLink, isArchive: '1' }),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
    });
    // Do not retain arbitrary response text, which may contain the credential URL.
    let raw = '';
    try { raw = await readBoundedText(response); }
    catch { throw new PushError('Bark 响应无效', { retryable: true }); }
    let result; try { result = JSON.parse(raw); } catch {}
    if (!response.ok || result?.code !== 200)
      throw new PushError(`Bark 返回 ${response.status}${Number.isInteger(result?.code) ? ` / ${result.code}` : ''}`, { retryable: response.status === 429 || response.status >= 500 });
    return { provider: 'bark', accepted: true };
  }
  async ntfy(device, item) {
    const headers = { 'content-type': 'application/json' };
    if (device.ntfy.token) headers.authorization = `Bearer ${device.ntfy.token}`;
    const body = JSON.stringify({
      topic: device.ntfy.topic,
      title: item.title,
      message: item.body || item.title,
      priority: ['attention', 'failed'].includes(item.type) ? 4 : 3,
      tags: ['grokbot'],
      click: item.deepLink,
      ...(device.iconUrl ? { icon: device.iconUrl } : {}),
    });
    const response = await this.postPublicEndpoint(device.ntfy.baseUrl, {
      urlLabel: 'ntfy 地址',
      connLabel: 'ntfy',
      headers,
      body,
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
    });
    try { await readBoundedText(response); } catch {}
    if (!response.ok) {
      throw new PushError(`ntfy 返回 ${response.status}`, { retryable: response.status === 429 || response.status >= 500 });
    }
    return { provider: 'ntfy', accepted: true };
  }
  async unifiedpush(device, item) {
    const response = await this.postPublicEndpoint(device.unifiedpush.endpoint, {
      urlLabel: 'UnifiedPush 端点',
      connLabel: 'UnifiedPush',
      headers: {
        'content-type': 'application/json',
        'urgency': 'high',
        'ttl': '86400',
      },
      body: boundedJsonPushPayload(item, 3800),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
    });
    try { await readBoundedText(response); } catch {}
    if (response.status === 404 || response.status === 410) {
      throw new PushError(`UnifiedPush 端点已失效 (${response.status})`, { retryable: false, invalidToken: true });
    }
    if (!response.ok) {
      throw new PushError(`UnifiedPush 返回 ${response.status}`, { retryable: response.status === 429 || response.status >= 500 });
    }
    return { provider: 'unifiedpush', accepted: true };
  }
  async webhook(device, item) {
    const body = JSON.stringify({
      notificationId: item.id,
      id: item.id,
      type: item.type,
      agentId: item.agentId,
      title: item.title,
      body: item.body,
      createdAt: item.createdAt,
      deepLink: item.deepLink,
    });
    const headers = { 'content-type': 'application/json' };
    if (device.webhook.secret) {
      headers.authorization = `Bearer ${device.webhook.secret}`;
      headers['x-grokbot-signature-256'] = `sha256=${createHmac('sha256', device.webhook.secret).update(body).digest('hex')}`;
    }
    const response = await this.postPublicEndpoint(device.webhook.endpoint, {
      urlLabel: 'Webhook 地址',
      connLabel: 'Webhook',
      headers,
      body,
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
    });
    try { await readBoundedText(response); } catch {}
    if (!response.ok) {
      throw new PushError(`Webhook 返回 ${response.status}`, { retryable: response.status === 429 || response.status >= 500 });
    }
    return { provider: 'webhook', accepted: true };
  }
  async fcmAccessToken(fcm) {
    const id = createHash('sha256').update(`${fcm.projectId}:${fcm.clientEmail}:${fcm.privateKey}`).digest('hex');
    const cached = this.fcmTokens.get(id);
    if (cached && Date.now() < cached.expiresAt - 60000) return cached.value;
    this.fcmTokens.clear();
    let response;
    try {
      response = await this.fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: signFcmAssertion(fcm),
        }).toString(),
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
      });
    } catch { throw new PushError('Firebase OAuth 连接失败', { retryable: true }); }
    const raw = await readBoundedText(response).catch(() => '');
    let parsed; try { parsed = JSON.parse(raw); } catch {}
    if (!response.ok || typeof parsed?.access_token !== 'string') {
      throw new PushError(`Firebase OAuth ${response.status}`, { retryable: response.status === 429 || response.status >= 500 });
    }
    const ttlMs = Math.max(300, Math.min(3600, Number(parsed.expires_in) || 3600)) * 1000;
    this.fcmTokens.set(id, { value: parsed.access_token, expiresAt: Date.now() + ttlMs });
    return parsed.access_token;
  }
  async fcm(device, item, config) {
    const fcm = config?.fcm;
    if (!fcm?.enabled || !fcm?.projectId || !fcm?.clientEmail || !fcm?.privateKey) {
      throw new PushError('Host 尚未配置 FCM', { retryable: false });
    }
    const accessToken = await this.fcmAccessToken(fcm);
    let response;
    try {
      response = await this.fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(fcm.projectId)}/messages:send`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          message: {
            token: device.fcmToken,
            notification: { title: item.title, body: item.body },
            data: {
              notificationId: item.id,
              type: item.type,
              agentId: item.agentId,
              deepLink: item.deepLink,
              title: item.title,
              body: item.body,
            },
            android: {
              priority: 'HIGH',
              ttl: '86400s',
              notification: { channel_id: item.type === 'attention' ? 'attention' : 'messages', sound: 'default' },
            },
          },
        }),
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
      });
    } catch { throw new PushError('FCM 连接失败', { retryable: true }); }
    const raw = await readBoundedText(response).catch(() => '');
    if (response.ok) return { provider: 'fcm', accepted: true };
    let parsed; try { parsed = JSON.parse(raw); } catch {}
    const detailCode = parsed?.error?.details?.find?.(d => typeof d?.errorCode === 'string')?.errorCode;
    const statusText = detailCode || parsed?.error?.status || 'Unknown';
    if (response.status === 401) this.fcmTokens.clear();
    throw new PushError(`FCM ${response.status} ${statusText}`, {
      retryable: response.status === 401 || response.status === 429 || response.status >= 500,
      invalidToken: response.status === 404 || ['UNREGISTERED', 'INVALID_ARGUMENT'].includes(statusText),
    });
  }
  session(config, environment) {
    const origin = environment === 'development' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    const identity = createHash('sha256').update(`${config.mode}:${config.privateKey}:${config.certificate ?? ''}`).digest('hex');
    const id = `${origin}:${identity}`;
    let session = this.sessions.get(id);
    if (!session || session.destroyed || session.closed) {
      session = this.connect(origin, config.mode === 'certificate' ? { cert: config.certificate, key: config.privateKey } : {});
      session.on('error', () => {});
      session.once('close', () => { if (this.sessions.get(id) === session) this.sessions.delete(id); });
      session.setTimeout?.(60000, () => session.close());
      this.sessions.set(id, session);
    }
    return session;
  }
  token(config) {
    const id = createHash('sha256').update(`${config.keyId}:${config.teamId}:${config.privateKey}`).digest('hex');
    const cached = this.tokens.get(id);
    if (cached && Date.now() - cached.created < 40 * 60000) return cached.value;
    this.tokens.clear();
    const value = signApnsToken(config); this.tokens.set(id, { value, created: Date.now() }); return value;
  }
  async apns(device, item, config) {
    const headers = { ':method': 'POST', ':path': `/3/device/${device.token}`,
      'apns-topic': config.topic, 'apns-push-type': 'alert', 'apns-priority': '10',
      'apns-id': randomUUID(), 'apns-collapse-id': createHash('sha256').update(item.id).digest('hex'),
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 86400), 'content-type': 'application/json' };
    if (config.mode === 'token') headers.authorization = `bearer ${this.token(config)}`;
    let reply;
    try {
      reply = await new Promise((resolve, reject) => {
        const request = this.session(config, device.environment).request(headers);
        let status, text = '';
        const timer = setTimeout(() => { request.destroy(); reject(new Error('timeout')); }, 15000);
        request.on('response', headers => { status = Number(headers[':status']); });
        request.on('data', chunk => { text += chunk; if (text.length > 16384) request.destroy(new Error('oversize')); });
        request.on('end', () => { clearTimeout(timer); resolve({ status, text }); });
        request.on('error', error => { clearTimeout(timer); reject(error); });
        request.end(apnsPayload(item));
      });
    } catch { throw new PushError('APNs 连接失败', { retryable: true }); }
    if (reply.status === 200) return { provider: 'apns', accepted: true };
    let reason; try { reason = JSON.parse(reply.text).reason; } catch {}
    const safeReason = typeof reason === 'string' && /^[A-Za-z]{1,80}$/.test(reason) ? reason : 'Unknown';
    if (safeReason === 'ExpiredProviderToken') this.tokens.clear();
    throw new PushError(`APNs ${reply.status} ${safeReason}`, {
      retryable: reply.status === 429 || reply.status >= 500 || safeReason === 'ExpiredProviderToken',
      invalidToken: reply.status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(safeReason),
    });
  }
  close() { this.abort.abort(); for (const session of this.sessions.values()) session.destroy(); this.sessions.clear(); this.fcmTokens.clear(); }
}
