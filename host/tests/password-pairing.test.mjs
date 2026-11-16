import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Auth, handleConnectPair } from '../server/auth.mjs';
import { HttpError, originFor, RateLimit, sendJson } from '../server/security.mjs';
import { tailcatIngress } from '../server/tailcat-ingress.mjs';

function memory(store) {
  store.value = structuredClone(store.initial);
  store.mutate = async update => update(store.value);
}

async function startPairFixture(t, { role = 'primary' } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'grokbot-pwd-pair-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const auth = await new Auth(dataDir).load();
  const limiter = new RateLimit();
  const federation = { role: () => role };
  let origin = '';
  const server = http.createServer(async (request, response) => {
    try {
      const reqPath = request.url.split('?')[0];
      if (request.method === 'POST' && reqPath === '/connect/pair') {
        return await handleConnectPair({ request, response, origin, auth, federation, limiter });
      }
      if (request.method === 'GET' && reqPath === '/connect/status') {
        const header = request.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        const found = auth.authenticate(token);
        if (!found) return sendJson(response, 401, { error: 'unauthorized' });
        return sendJson(response, 200, {
          deviceId: found.id,
          deviceName: found.name,
          platform: found.platform,
          connected: true,
        });
      }
      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      if (error instanceof HttpError) return sendJson(response, error.status, { error: error.message });
      sendJson(response, 500, { error: error.message });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  origin = `http://127.0.0.1:${port}`;
  return { auth, origin };
}

test('Auth.pair supports Host admin password alongside pairing codes and enforces validation rules', async () => {
  const auth = new Auth('.');
  memory(auth.store);

  await assert.rejects(
    auth.pair({ password: 'admin-password-10', deviceName: 'My Mac', platform: 'desktop' }),
    error => error.status === 409,
  );

  auth.setupKey = 'setup-secret';
  await auth.setup('setup-secret', 'Pass123456');

  await assert.rejects(
    auth.pair({ deviceName: 'My Mac', platform: 'desktop' }),
    error => error.status === 400,
  );
  await assert.rejects(
    auth.pair({ pairingKey: 'ABC234', password: 'Pass123456', deviceName: 'My Mac', platform: 'desktop' }),
    error => error.status === 400,
  );
  await assert.rejects(
    auth.pair({ password: '', deviceName: 'My Mac', platform: 'desktop' }),
    error => error.status === 400,
  );
  await assert.rejects(
    auth.pair({ password: 12345678, deviceName: 'My Mac', platform: 'desktop' }),
    error => error.status === 400,
  );
  await assert.rejects(
    auth.pair({ password: 'WrongPassword1', deviceName: 'My Mac', platform: 'desktop' }),
    error => error.status === 401,
  );

  const desktop = await auth.pair({ password: 'Pass123456', deviceName: 'MacBook Pro', platform: 'desktop' });
  assert.ok(desktop.deviceId);
  assert.ok(desktop.token.length >= 16);
  assert.equal(auth.authenticate(desktop.token).platform, 'desktop');

  const android = await auth.pair({
    password: 'Pass123456',
    deviceName: 'Pixel 9',
    platform: 'desktop',
    clientKind: 'android',
  });
  assert.equal(auth.authenticate(android.token).platform, 'android');

  const { pairingKey } = await auth.createPairing();
  const byCode = await auth.pair({ pairingKey, deviceName: 'Windows PC', platform: 'desktop' });
  assert.equal(auth.authenticate(byCode.token).name, 'Windows PC');
});

test('POST /connect/pair handles password pairing, uninitialized state, conflicts, role gating, and pairingKey coexistence', async t => {
  const member = await startPairFixture(t, { role: 'member' });
  const memberRes = await fetch(`${member.origin}/connect/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'Pass123456', deviceName: 'Phone', platform: 'desktop' }),
  });
  assert.equal(memberRes.status, 403);

  const { auth, origin } = await startPairFixture(t);
  const postPair = body => fetch(`${origin}/connect/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Uninitialized Host rejects password pairing with 409.
  const uninit = await postPair({ password: 'Pass123456', deviceName: 'Phone', platform: 'desktop', clientKind: 'android' });
  assert.equal(uninit.status, 409);

  await auth.setup(auth.setupKey, 'Pass123456');

  // Conflict between pairingKey and password returns 400.
  const conflict = await postPair({ pairingKey: 'ABC234', password: 'Pass123456', deviceName: 'Phone', platform: 'desktop' });
  assert.equal(conflict.status, 400);

  // Valid admin password pairs cleanly and issues a working device token.
  const ok = await postPair({ password: 'Pass123456', deviceName: 'Android Phone', platform: 'desktop', clientKind: 'android' });
  assert.equal(ok.status, 201);
  const paired = await ok.json();
  assert.equal(paired.gatewayUrl, origin);
  assert.equal(paired.notificationUrl, `${origin}/notifications/events`);
  assert.ok(paired.token.length >= 16);

  const statusRes = await fetch(`${origin}/connect/status`, {
    headers: { Authorization: `Bearer ${paired.token}` },
  });
  assert.equal(statusRes.status, 200);
  const statusJson = await statusRes.json();
  assert.equal(statusJson.deviceId, paired.deviceId);
  assert.equal(statusJson.platform, 'android');
  assert.equal(statusJson.connected, true);

  // Existing pairing code flow also continues to work.
  const { pairingKey } = await auth.createPairing();
  const codeOk = await postPair({ pairingKey, deviceName: 'Desktop', platform: 'desktop' });
  assert.equal(codeOk.status, 201);
});

test('POST /connect/pair enforces strict brute-force rate limiting on password attempts', async t => {
  const { auth, origin } = await startPairFixture(t);
  await auth.setup(auth.setupKey, 'Pass123456');

  const postPair = body => fetch(`${origin}/connect/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  for (let i = 0; i < 5; i++) {
    const res = await postPair({ password: `WrongPassword${i}`, deviceName: 'Attacker', platform: 'desktop' });
    assert.equal(res.status, 401);
  }
  const blocked = await postPair({ password: 'Pass123456', deviceName: 'Attacker', platform: 'desktop' });
  assert.equal(blocked.status, 429);
});

test('POST /connect/pair handles password pairing identically over direct HTTPS/canonical origin and Tailcat ingress', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'grokbot-host-pwd-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const auth = await new Auth(dataDir).load();
  await auth.setup(auth.setupKey, 'qqhsfa.com');
  const limiter = new RateLimit();
  const federation = { role: () => 'primary' };
  const canonical = 'https://host.example';
  let ingress;
  const server = http.createServer(async (request, response) => {
    try {
      const reqPath = request.url.split('?')[0];
      const origin = originFor(request, ingress?.matches(request) ? '' : canonical);
      delete request.headers['x-grokbot-tailcat-ingress'];
      if (request.method === 'POST' && reqPath === '/connect/pair') {
        return await handleConnectPair({ request, response, origin, auth, federation, limiter });
      }
      if (request.method === 'GET' && reqPath === '/connect/status') {
        const header = request.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        const found = auth.authenticate(token);
        if (!found) return sendJson(response, 401, { error: 'unauthorized' });
        return sendJson(response, 200, {
          deviceId: found.id,
          deviceName: found.name,
          platform: found.platform,
          connected: true,
        });
      }
      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      if (error instanceof HttpError) return sendJson(response, error.status, { error: error.message });
      sendJson(response, 500, { error: error.message });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const directBase = `http://127.0.0.1:${server.address().port}`;
  ingress = await tailcatIngress(`127.0.0.1:${server.address().port}`);
  t.after(() => ingress.close());
  const ingressBase = `http://${ingress.target}`;

  const directRes = await fetch(`${directBase}/connect/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'qqhsfa.com', deviceName: 'Direct Mac', platform: 'desktop' }),
  });
  assert.equal(directRes.status, 201);
  const directJson = await directRes.json();
  assert.equal(directJson.gatewayUrl, canonical);

  const ingressRes = await fetch(`${ingressBase}/connect/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'qqhsfa.com', deviceName: 'Tailcat Phone', platform: 'desktop', clientKind: 'android' }),
  });
  assert.equal(ingressRes.status, 201);
  const ingressJson = await ingressRes.json();
  assert.equal(ingressJson.gatewayUrl, ingressBase);
  assert.equal(ingressJson.notificationUrl, `${ingressBase}/notifications/events`);

  const statusRes = await fetch(`${ingressBase}/connect/status`, {
    headers: { Authorization: `Bearer ${ingressJson.token}` },
  });
  assert.equal(statusRes.status, 200);
  const statusJson = await statusRes.json();
  assert.equal(statusJson.platform, 'android');
  assert.equal(statusJson.connected, true);
});
