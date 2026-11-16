import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import test from 'node:test';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Auth } from '../server/auth.mjs';
import { PushService } from '../server/push-service.mjs';
import { PushError, PushTransports, pinnedPost, readBoundedText } from '../server/push-transports.mjs';

function memory(store) {
  store.value = structuredClone(store.initial);
  store.mutate = async update => update(store.value);
}

function makePush({ fetchImpl, lookupImpl } = {}) {
  const auth = new Auth('.');
  memory(auth.store);
  const transports = new PushTransports({ fetchImpl, lookupImpl });
  const push = new PushService('.', auth, { transports });
  memory(push.store);
  memory(push.config.store);
  return { auth, push, transports };
}

test('Android foreground stream suppresses pushes until stream closes or foreground becomes false', async () => {
  const calls = [];
  const { auth, push } = makePush({
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response('ok', { status: 200 });
    },
  });
  const { pairingKey } = await auth.createPairing();
  const { deviceId } = await auth.pair({ platform: 'desktop', deviceName: 'Find X9', clientKind: 'android', pairingKey });
  await push.register(deviceId, {
    kind: 'desktop',
    clientKind: 'android',
    bundleId: 'dev.grokbot.local',
    appVersion: '1.2.0',
    authorization: 'granted',
    push: { provider: 'unifiedpush', endpoint: 'https://push.example/up/endpoint-1' },
  });
  assert.equal(push.get(deviceId).push.provider, 'unifiedpush');
  assert.equal(push.get(deviceId).push.configured, true);

  const stream = new EventEmitter();
  push.trackForegroundStream(deviceId, stream);
  assert.equal(push.isForeground(deviceId), true);

  const item1 = {
    id: 'n-fg-1', type: 'message', agentId: 'bot-1', title: 'Hi', body: 'Foreground message',
    createdAt: new Date(Date.now() + 1000).toISOString(), deepLink: 'grokbot-local://agent/bot-1',
  };
  await push.enqueue(item1);
  await push.flush();
  assert.equal(calls.length, 0);

  stream.emit('close');
  assert.equal(push.isForeground(deviceId), false);
  const item2 = {
    id: 'n-bg-1', type: 'message', agentId: 'bot-1', title: '回复来了', body: 'Background reply',
    createdAt: new Date(Date.now() + 2000).toISOString(), deepLink: 'grokbot-local://agent/bot-1',
  };
  await push.enqueue(item2);
  await push.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://push.example/up/endpoint-1');
  assert.equal(calls[0].body.notificationId, 'n-bg-1');
  assert.equal(calls[0].body.agentId, 'bot-1');
});

test('UnifiedPush 410 invalidates stale endpoint and ntfy/webhook deliver cleanly', async () => {
  const deliveries = [];
  let failUp = false;
  const { auth, push } = makePush({
    fetchImpl: async (url, init) => {
      deliveries.push({ url, headers: init.headers, body: init.body });
      if (failUp && url.includes('/up/')) return new Response('Gone', { status: 410 });
      return new Response('{"id":"ok"}', { status: 200 });
    },
  });

  const { pairingKey: k1 } = await auth.createPairing();
  const { deviceId: d1 } = await auth.pair({ platform: 'desktop', deviceName: 'UP', clientKind: 'android', pairingKey: k1 });
  await push.register(d1, {
    kind: 'android',
    authorization: 'granted',
    push: { provider: 'unifiedpush', endpoint: 'https://push.example/up/abc' },
  });
  failUp = true;
  const res = await push.test(d1, 'bot-1');
  assert.equal(res.ok, false);
  assert.equal(push.get(d1).push.configured, false);
  assert.match(push.get(d1).push.registrationError, /UnifiedPush/);

  const { pairingKey: k2 } = await auth.createPairing();
  const { deviceId: d2 } = await auth.pair({ platform: 'desktop', deviceName: 'NTFY', clientKind: 'android', pairingKey: k2 });
  await push.register(d2, {
    kind: 'android',
    authorization: 'granted',
    push: { provider: 'ntfy', ntfyUrl: 'https://ntfy.example/sub/grokbot-topic', ntfyToken: 'tk_demo_123' },
  });
  const r2 = await push.test(d2, 'bot-2');
  assert.equal(r2.ok, true);
  const ntfyCall = deliveries.find(d => d.url === 'https://ntfy.example/sub');
  assert.ok(ntfyCall);
  assert.equal(ntfyCall.headers.authorization, 'Bearer tk_demo_123');
  assert.equal(JSON.parse(ntfyCall.body).topic, 'grokbot-topic');

  const { pairingKey: k3 } = await auth.createPairing();
  const { deviceId: d3 } = await auth.pair({ platform: 'desktop', deviceName: 'WH', clientKind: 'android', pairingKey: k3 });
  await push.register(d3, {
    kind: 'android',
    authorization: 'granted',
    push: { provider: 'webhook', webhookUrl: 'https://hooks.example/grok', webhookSecret: 'sec_99' },
  });
  const r3 = await push.test(d3, 'bot-3');
  assert.equal(r3.ok, true);
  const whCall = deliveries.find(d => d.url === 'https://hooks.example/grok');
  assert.ok(whCall);
  assert.equal(whCall.headers.authorization, 'Bearer sec_99');
  const expectedSig = `sha256=${createHmac('sha256', 'sec_99').update(whCall.body).digest('hex')}`;
  assert.equal(whCall.headers['x-grokbot-signature-256'], expectedSig);
});

test('FCM HTTP v1 exchanges service account JWT, caches access token, and handles UNREGISTERED', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = JSON.stringify({
    project_id: 'grok-demo-123',
    client_email: 'fcm-sender@grok-demo-123.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });

  let oauthCount = 0;
  let fcmUnregistered = false;
  const fcmCalls = [];
  const { auth, push } = makePush({
    fetchImpl: async (url, init) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        oauthCount += 1;
        return new Response(JSON.stringify({ access_token: 'goog-access-token', expires_in: 3600 }), { status: 200 });
      }
      fcmCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      if (fcmUnregistered) {
        return new Response(JSON.stringify({
          error: { code: 404, status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] },
        }), { status: 404 });
      }
      return new Response(JSON.stringify({ name: 'projects/grok-demo-123/messages/m1' }), { status: 200 });
    },
  });

  const saved = await push.config.save({ fcm: { enabled: true, serviceAccount: sa } });
  assert.equal(saved.fcm.ready, true);
  assert.equal(saved.fcm.projectId, 'grok-demo-123');
  assert.equal(saved.fcm.privateKey, undefined);

  const { pairingKey } = await auth.createPairing();
  const { deviceId } = await auth.pair({ platform: 'desktop', deviceName: 'Pixel', clientKind: 'android', pairingKey });
  await push.register(deviceId, {
    kind: 'android',
    authorization: 'granted',
    push: { provider: 'fcm', fcmToken: 'fcm-device-token-1234567890' },
  });

  const okRes = await push.test(deviceId, 'bot-1');
  assert.equal(okRes.ok, true);
  assert.equal(oauthCount, 1);
  assert.equal(fcmCalls.length, 1);
  assert.equal(fcmCalls[0].body.message.token, 'fcm-device-token-1234567890');
  assert.equal(fcmCalls[0].body.message.android.notification.channel_id, 'messages');

  await push.enqueue({
    id: 'attn-1', type: 'attention', agentId: 'bot-1', title: '需要确认', body: 'Approve action',
    createdAt: new Date(Date.now() + 2000).toISOString(), deepLink: 'grokbot-local://agent/bot-1',
  });
  await push.flush();
  assert.equal(fcmCalls.length, 2);
  assert.equal(fcmCalls[1].body.message.android.notification.channel_id, 'attention');

  fcmUnregistered = true;
  const failRes = await push.test(deviceId, 'bot-1');
  assert.equal(failRes.ok, false);
  assert.equal(oauthCount, 1); // Cached access token reused.
  assert.equal(push.get(deviceId).push.configured, false);
  assert.match(push.get(deviceId).push.registrationError, /FCM/);
});

test('PushTransports blocks delivery-time DNS rebinding and private resolved IPs for bark, ntfy, unifiedpush, and webhook', async () => {
  const sampleItem = {
    id: 'n-ssrf-1',
    type: 'message',
    agentId: 'bot-1',
    title: 'Hello',
    body: 'Body',
    createdAt: new Date().toISOString(),
    deepLink: 'grokbot-local://agent/bot-1',
  };

  for (const resolved of [
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: '10.0.0.5', family: 4 }],
    [{ address: '100.64.0.1', family: 4 }],
    [{ address: '::1', family: 6 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }],
    [{ address: 'fd7a:115c:a1e0::1', family: 6 }],
    // Mixed public + private answers must still fail closed.
    [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.10', family: 4 }],
    // Non-IP or family-mismatched answers must also fail closed.
    [{ address: 'evil.example', family: 4 }],
    [{ address: '::1', family: 4 }],
    [{ address: '93.184.216.34', family: 6 }],
    [],
  ]) {
    let fetchCalled = 0;
    const transports = new PushTransports({
      lookupImpl: async () => resolved,
      fetchImpl: async () => {
        fetchCalled += 1;
        return new Response('ok', { status: 200 });
      },
    });

    await assert.rejects(
      () => transports.bark({ bark: { endpoint: 'https://rebind.example/push', key: 'k12345678' } }, sampleItem),
      err => err instanceof PushError && err.retryable === false && /保留地址/.test(err.message),
    );
    await assert.rejects(
      () => transports.ntfy({ ntfy: { baseUrl: 'https://rebind.example/sub', topic: 'demo' } }, sampleItem),
      err => err instanceof PushError && err.retryable === false && /保留地址/.test(err.message),
    );
    await assert.rejects(
      () => transports.unifiedpush({ unifiedpush: { endpoint: 'https://rebind.example/up/1' } }, sampleItem),
      err => err instanceof PushError && err.retryable === false && /保留地址/.test(err.message),
    );
    await assert.rejects(
      () => transports.webhook({ webhook: { endpoint: 'https://rebind.example/hook' } }, sampleItem),
      err => err instanceof PushError && err.retryable === false && /保留地址/.test(err.message),
    );
    assert.equal(fetchCalled, 0, 'blocked DNS resolution must never trigger an HTTP request');
  }

  // Defense in depth: literal private IPs or credentials passed directly to PushTransports are also rejected.
  let directFetchCalled = 0;
  const directTransports = new PushTransports({
    fetchImpl: async () => {
      directFetchCalled += 1;
      return new Response('ok', { status: 200 });
    },
  });
  await assert.rejects(
    () => directTransports.webhook({ webhook: { endpoint: 'http://127.0.0.1:8080/hook' } }, sampleItem),
    err => err instanceof PushError && err.retryable === false,
  );
  await assert.rejects(
    () => directTransports.bark({ bark: { endpoint: 'https://user:pass@api.day.app/push', key: 'k12345678' } }, sampleItem),
    err => err instanceof PushError && err.retryable === false,
  );
  assert.equal(directFetchCalled, 0);

  // PushService immediately settles DNS-rebinding failures as failed (no retries).
  const { auth, push } = makePush({
    lookupImpl: async () => [{ address: '169.254.169.254', family: 4 }],
    fetchImpl: async () => { throw new Error('should not reach fetch'); },
  });
  const { pairingKey } = await auth.createPairing();
  const { deviceId } = await auth.pair({ platform: 'desktop', deviceName: 'SSRF', clientKind: 'android', pairingKey });
  await push.register(deviceId, {
    kind: 'android',
    authorization: 'granted',
    push: { provider: 'webhook', webhookUrl: 'https://rebind.example/hook' },
  });
  const res = await push.test(deviceId, 'bot-1');
  assert.equal(res.ok, false);
  assert.equal(res.status, 'failed');
  assert.match(res.reason, /保留地址/);
  assert.equal(push.store.value.jobs.at(-1).attempts, 1);
});

test('PushTransports real pinned-IP transport pins resolved public IPs, rejects redirects, and surfaces DNS errors as retryable', async t => {
  const sampleItem = {
    id: 'n-pin-1',
    type: 'message',
    agentId: 'bot-1',
    title: 'Pinned',
    body: 'Hello',
    createdAt: new Date().toISOString(),
    deepLink: 'grokbot-local://agent/bot-1',
  };

  const requests = [];
  let replyStatus = 200;
  let replyBody = '{"code":200,"message":"success"}';

  t.mock.method(http, 'request', (url, options, callback) => {
    const captured = { url: url.href, method: options.method, headers: options.headers, agent: options.agent, lookup: options.lookup };
    requests.push(captured);

    const req = new EventEmitter();
    req.end = payload => {
      captured.payload = payload.toString('utf8');
      const res = new PassThrough();
      res.statusCode = replyStatus;
      res.headers = replyStatus >= 300 && replyStatus < 400 ? { location: 'http://127.0.0.1/steal' } : {};
      callback(res);
      res.end(replyBody);
    };
    return req;
  });

  const transports = new PushTransports({
    lookupImpl: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ],
  });

  const barkRes = await transports.bark({ bark: { endpoint: 'http://push.example/push', key: 'k12345678' } }, sampleItem);
  assert.deepEqual(barkRes, { provider: 'bark', accepted: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://push.example/push');
  assert.equal(requests[0].agent, false);

  // Verify the pinned lookup returns ONLY the verified public addresses.
  await new Promise((resolve, reject) => {
    requests[0].lookup('push.example', { all: true }, (err, list) => {
      if (err) reject(err);
      else {
        assert.deepEqual(list, [
          { address: '93.184.216.34', family: 4 },
          { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
        ]);
        resolve();
      }
    });
  });
  await new Promise((resolve, reject) => {
    requests[0].lookup('push.example', { family: 4 }, (err, addr, fam) => {
      if (err) reject(err);
      else {
        assert.equal(addr, '93.184.216.34');
        assert.equal(fam, 4);
        resolve();
      }
    });
  });

  // 3xx redirects must be rejected without following.
  replyStatus = 302;
  replyBody = '';
  await assert.rejects(
    () => transports.webhook({ webhook: { endpoint: 'http://push.example/hook' } }, sampleItem),
    err => err instanceof PushError && err.retryable === true && /连接失败/.test(err.message),
  );

  // Transient DNS failure maps to retryable PushError.
  const failingDns = new PushTransports({
    lookupImpl: async () => { throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); },
  });
  await assert.rejects(
    () => failingDns.ntfy({ ntfy: { baseUrl: 'http://missing.example/sub', topic: 'demo' } }, sampleItem),
    err => err instanceof PushError && err.retryable === true && /连接失败/.test(err.message),
  );
});

test('pinnedPost uses real sockets with Host/TLS SNI preservation and readBoundedText decodes split UTF-8 and enforces byte bounds', async t => {
  // 1. Real HTTP server: non-existent hostname pinned to 127.0.0.1, split multi-byte UTF-8 response, and 302 redirect blocking.
  let mode = 'utf8';
  let seenHost = '';
  const server = http.createServer((req, res) => {
    seenHost = req.headers.host ?? '';
    req.resume();
    if (mode === 'redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1/' });
      res.end();
      return;
    }
    if (mode === 'oversize') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      // 6000 3-byte UTF-8 chars = 18000 bytes (> 16384), even though JS string length is 6000.
      res.end('中'.repeat(6000));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    const full = Buffer.from('{"code":200,"message":"设备密钥校验成功"}', 'utf8');
    // Deliberately split inside a 3-byte Chinese UTF-8 character.
    const splitAt = full.indexOf(Buffer.from('密', 'utf8')) + 1;
    res.write(full.subarray(0, splitAt));
    setTimeout(() => res.end(full.subarray(splitAt)), 10);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();

  const res = await pinnedPost(
    new URL(`http://pinned.example:${port}/push`),
    [{ address: '127.0.0.1', family: 4 }],
    { headers: { 'content-type': 'application/json' }, body: '{"ok":true}', signal: AbortSignal.timeout(5000) },
  );
  assert.equal(seenHost, `pinned.example:${port}`);
  assert.equal(res.status, 200);
  assert.equal(await readBoundedText(res), '{"code":200,"message":"设备密钥校验成功"}');

  mode = 'oversize';
  const bigRes = await pinnedPost(
    new URL(`http://pinned.example:${port}/push`),
    [{ address: '127.0.0.1', family: 4 }],
    { headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) },
  );
  await assert.rejects(() => readBoundedText(bigRes), /oversize/);

  // Web ReadableStream oversize cancels cleanly too.
  let webCancelled = false;
  const webRes = {
    body: new ReadableStream({
      pull(controller) { controller.enqueue(Buffer.from('中'.repeat(6000), 'utf8')); },
      cancel() { webCancelled = true; },
    }),
  };
  await assert.rejects(() => readBoundedText(webRes), /oversize/);
  assert.equal(webCancelled, true);

  mode = 'redirect';
  await assert.rejects(
    () => pinnedPost(
      new URL(`http://pinned.example:${port}/push`),
      [{ address: '127.0.0.1', family: 4 }],
      { headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) },
    ),
    /Redirect blocked \(302\)/,
  );

  // 2. Real TLS server: verify pinnedPost connects to pinned IP and passes target hostname as TLS SNI.
  let seenSni = '';
  const tlsServer = https.createServer({
    SNICallback(servername, cb) {
      seenSni = servername;
      cb(new Error('abort-after-sni'));
    },
  });
  await new Promise(resolve => tlsServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => tlsServer.close(resolve)));
  const tlsPort = tlsServer.address().port;
  await assert.rejects(
    () => pinnedPost(
      new URL(`https://sni-check.example:${tlsPort}/hook`),
      [{ address: '127.0.0.1', family: 4 }],
      { headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) },
    ),
  );
  assert.equal(seenSni, 'sni-check.example');
});
