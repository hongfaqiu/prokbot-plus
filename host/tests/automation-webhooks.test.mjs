import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AutomationWebhooks,
  hasWebhookTrigger,
  resolveAutomationWebhookCredential,
  resolveWebhookOrigin,
  stableAutomationId,
} from '../server/automation-webhooks.mjs';
import { Webhooks, webhookSignature } from '../server/webhooks.mjs';
import { bearer, check, equal, HttpError, jsonBody, sendJson } from '../server/security.mjs';
import { startLocalWebhooks } from '../runtime/host-webhooks.mjs';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    resolve(`http://127.0.0.1:${addr.port}`);
  }));
}

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(() => resolve()));
}

test('stableAutomationId, trigger detection, and resolveWebhookOrigin behave as expected', () => {
  assert.equal(
    stableAutomationId('70ee72e6-43e6-4e97-970c-82fa27d69e8c', 'qq'),
    '0fdae384-6eb9-5b37-a144-8c93ae3dec81',
  );
  assert.equal(hasWebhookTrigger({ type: 'webhook' }), true);
  assert.equal(hasWebhookTrigger({ type: 'group', listeners: [{ type: 'cron', schedule: '0 * * * *' }, { type: 'webhook' }] }), true);
  assert.equal(hasWebhookTrigger({ type: 'cron', schedule: '0 * * * *' }), false);
  assert.equal(hasWebhookTrigger(null), false);

  assert.equal(
    resolveWebhookOrigin({ canonical: 'https://prokbot.cosfoc.com', requestOrigin: 'http://127.0.0.1:18080', isIngress: false }),
    'https://prokbot.cosfoc.com',
  );
  assert.equal(
    resolveWebhookOrigin({ canonical: 'https://prokbot.cosfoc.com', requestOrigin: 'http://100.64.0.10:18080', isIngress: true }),
    'https://prokbot.cosfoc.com',
  );
  assert.equal(
    resolveWebhookOrigin({ canonical: 'http://127.0.0.1:18080', requestOrigin: 'http://100.64.0.10:18080', isIngress: true }),
    'http://100.64.0.10:18080',
  );
  assert.equal(
    resolveWebhookOrigin({ canonical: null, requestOrigin: 'http://192.168.1.50:18080', isIngress: false }),
    'http://192.168.1.50:18080',
  );
});

test('getAutomationWebhookCredential mints persistent keys using publicUrl and executes POST /automations/webhook/<id>', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'grokbot-auto-webhooks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const internalToken = 'internal_token_for_testing_1234567890abcd';
  const deviceToken = 'device_token_for_testing_1234567890abcdef';
  const tokenFile = join(dir, 'internal-host-token');
  await writeFile(tokenFile, `${internalToken}\n`, { mode: 0o600 });

  const agentId = '70ee72e6-43e6-4e97-970c-82fa27d69e8c';
  const localId = 'qq';
  const automations = [
    {
      id: localId,
      name: 'QQ桥接消息接收',
      prompt: 'Process QQ webhook',
      trigger: { type: 'webhook' },
      isEnabled: true,
      createdAt: 1794762635000,
    },
    {
      id: 'cron-job',
      name: 'Hourly check',
      prompt: 'Check',
      trigger: { type: 'cron', schedule: '0 * * * *' },
      isEnabled: true,
      createdAt: 1794762635001,
    },
  ];

  const automationWebhooks = await new AutomationWebhooks(dir).load();
  const hostCall = async (method, args) => {
    if (method === 'getAgentAutomations') return args.id === agentId ? automations : [];
    throw new HttpError(404, 'not found');
  };
  const verifyAgent = async id => {
    check(id === agentId, 404, 'Bot not found');
  };

  const server = http.createServer((req, res) => {
    (async () => {
      const reqPath = req.url.split('?')[0];
      const hookMatch = /^\/automations\/webhook\/([a-f0-9-]{36})$/.exec(reqPath);
      if (hookMatch && req.method === 'POST') {
        const result = await automationWebhooks.receive(req, hookMatch[1], {
          verifyAutomation: async (id, lid) => {
            const list = await hostCall('getAgentAutomations', { id });
            const item = list.find(candidate => candidate.id === lid);
            if (!item || !hasWebhookTrigger(item.trigger)) return { exists: false, enabled: false };
            return { exists: true, enabled: Boolean(item.isEnabled), name: item.name, createdAt: item.createdAt };
          },
        });
        return sendJson(res, 202, result);
      }
      if (req.method === 'POST' && reqPath === '/api/getAutomationWebhookCredential') {
        check(equal(bearer(req), deviceToken), 401, 'Unauthorized');
        const input = await jsonBody(req);
        return sendJson(res, 200, await resolveAutomationWebhookCredential({
          automationWebhooks,
          agentId: input?.id,
          localId: input?.automationId,
          verifyAgent,
          hostCall,
          origin: resolveWebhookOrigin({ canonical: 'https://prokbot.cosfoc.com', requestOrigin: 'http://127.0.0.1:18080', isIngress: false }),
        }));
      }
      if (req.method === 'POST' && reqPath.startsWith('/internal/automation-webhooks/')) {
        check(equal(bearer(req), internalToken), 401, 'Unauthorized');
        const body = await jsonBody(req);
        if (reqPath === '/internal/automation-webhooks/credential') {
          return sendJson(res, 200, await automationWebhooks.ensureCredential(body));
        }
        if (reqPath === '/internal/automation-webhooks/claim') {
          return sendJson(res, 200, await automationWebhooks.claim(body.worker));
        }
        if (reqPath === '/internal/automation-webhooks/finish') {
          return sendJson(res, 200, await automationWebhooks.finish(body));
        }
      }
      if (req.method === 'POST' && reqPath === '/internal/webhooks/claim') {
        check(equal(bearer(req), internalToken), 401, 'Unauthorized');
        await jsonBody(req);
        return sendJson(res, 200, null);
      }
      throw new HttpError(404, 'Not found');
    })().catch(err => sendJson(res, err.status ?? 500, { error: err.message }));
  });
  const serverUrl = await listen(server);
  t.after(() => closeServer(server));

  const rpc = (method, payload) => fetch(`${serverUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify(payload),
  });

  // 1. Even when the client connects over 127.0.0.1 loopback, publicUrl is used for the external webhook URL.
  const credRes1 = await rpc('getAutomationWebhookCredential', { id: agentId, automationId: localId });
  assert.equal(credRes1.status, 200);
  const cred1 = await credRes1.json();
  assert.equal(cred1.url, 'https://prokbot.cosfoc.com/automations/webhook/0fdae384-6eb9-5b37-a144-8c93ae3dec81');
  assert.match(cred1.key, /^[A-Za-z0-9_-]{32,256}$/);

  // Repeated reads return the exact same persistent key.
  const credRes2 = await rpc('getAutomationWebhookCredential', { id: agentId, automationId: localId });
  assert.equal(credRes2.status, 200);
  const cred2 = await credRes2.json();
  assert.deepEqual(cred2, cred1);

  // Non-webhook or missing routines are rejected cleanly.
  const nonWebhookRes = await rpc('getAutomationWebhookCredential', { id: agentId, automationId: 'cron-job' });
  assert.equal(nonWebhookRes.status, 400);
  const missingRes = await rpc('getAutomationWebhookCredential', { id: agentId, automationId: 'nope' });
  assert.equal(missingRes.status, 404);

  // 2. Inbound POST authentication and validation.
  const hookPath = '/automations/webhook/0fdae384-6eb9-5b37-a144-8c93ae3dec81';
  const badAuth = await fetch(`${serverUrl}${hookPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer wrong_token_value_12345678901234567890' },
    body: JSON.stringify({ id: 'msg-1' }),
  });
  assert.equal(badAuth.status, 401);

  const payloadBody = JSON.stringify({ type: 'qq.message', message_id: '42', port: 8787 });
  const goodRes = await fetch(`${serverUrl}${hookPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cred1.key}`,
      cookie: 'should_strip=1',
      'x-bridge-port': '8787',
    },
    body: payloadBody,
  });
  assert.equal(goodRes.status, 202);
  const queued = await goodRes.json();
  assert.equal(queued.ok, true);
  assert.equal(queued.automationId, '0fdae384-6eb9-5b37-a144-8c93ae3dec81');
  assert.equal(queued.state, 'queued');

  // Disabled routine rejects inbound POST with 409.
  automations[0].isEnabled = false;
  const disabledRes = await fetch(`${serverUrl}${hookPath}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cred1.key}` },
    body: 'ping',
  });
  assert.equal(disabledRes.status, 409);
  automations[0].isEnabled = true;

  // 3. startLocalWebhooks drains the queued event and calls runServerAutomationForEvent with sanitized headers.
  const fired = [];
  const originalEnv = {
    url: process.env.GROKBOT_NOTIFICATION_URL,
    tokenFile: process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE,
    publicUrl: process.env.GROKBOT_PUBLIC_URL,
  };
  process.env.GROKBOT_NOTIFICATION_URL = `${serverUrl}/internal/notifications`;
  process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE = tokenFile;
  process.env.GROKBOT_PUBLIC_URL = 'https://prokbot.cosfoc.com';
  t.after(() => {
    for (const [k, v] of Object.entries({
      GROKBOT_NOTIFICATION_URL: originalEnv.url,
      GROKBOT_INTERNAL_HOST_TOKEN_FILE: originalEnv.tokenFile,
      GROKBOT_PUBLIC_URL: originalEnv.publicUrl,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const hooksRuntime = await startLocalWebhooks({
    deps: {
      'turn-execution': { isRunReady: async () => true },
      transcript: {
        getAgentAutomations: async id => (id === agentId ? automations : []),
        runServerAutomationForEvent: async args => { fired.push(args); return 'ok'; },
      },
    },
    host: { log() {} },
    onStop() {},
  }, { directory: dir, interval: 60000 });
  t.after(() => hooksRuntime.close());

  await hooksRuntime.tick();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].agentId, agentId);
  assert.equal(fired[0].automation.id, localId);
  assert.equal(fired[0].event.source, 'webhook');
  assert.equal(fired[0].event.body, payloadBody);
  assert.equal(fired[0].event.bodyDigest, `sha256:${createHash('sha256').update(payloadBody).digest('hex')}`);
  assert.equal(fired[0].event.headers.authorization, undefined);
  assert.equal(fired[0].event.headers.cookie, undefined);
  assert.equal(fired[0].event.headers['x-bridge-port'], '8787');
  assert.equal(fired[0].event.context, 'QQ桥接消息接收: qq.message');

  // Host-side getWebhookCredential also returns the same public URL and key.
  const hostCred = await hooksRuntime.getWebhookCredential({ agentId, localId });
  assert.deepEqual(hostCred, cred1);

  // Queue is now empty; event marked completed.
  const stored = automationWebhooks.store.value.events.find(item => item.id === queued.id);
  assert.equal(stored.state, 'completed');
  assert.equal(stored.body, undefined);
});

test('Admin Webhooks (/hooks/v1/:id) continue to receive, claim, and finish cleanly', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'grokbot-admin-hooks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const webhooks = await new Webhooks(dir).load();
  const created = await webhooks.save({
    name: 'Test Hook',
    agentId: 'agent-1',
    prompt: 'Handle {{event}}',
    eventTypes: ['ping'],
  });
  assert.ok(created.key);

  const payload = Buffer.from(JSON.stringify({ type: 'ping' }));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const eventId = 'evt-1';
  const sig = webhookSignature(created.key, created.path, timestamp, eventId, payload);
  const req = Object.assign((async function* () { yield payload; })(), {
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      'content-type': 'application/json',
      'x-grokbot-timestamp': timestamp,
      'x-grokbot-event-id': eventId,
      'x-grokbot-signature': `sha256=${sig}`,
    },
  });
  const queued = await webhooks.receive(req, created.id, created.path);
  assert.equal(queued.state, 'queued');

  const worker = '11111111-1111-4111-8111-111111111111';
  const claimed = await webhooks.claim(worker);
  assert.equal(claimed.event.id, queued.id);
  assert.equal(claimed.hook.id, created.id);
  const finished = await webhooks.finish({
    worker,
    id: claimed.event.id,
    runUuid: claimed.event.runUuid,
    state: 'completed',
    detail: '',
  });
  assert.equal(finished.state, 'completed');
});

test('AutomationWebhooks rotates key if routine createdAt changes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'grokbot-auto-rotate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = await new AutomationWebhooks(dir).load();
  const first = await store.ensureCredential({ agentId: 'a1', localId: 'r1', createdAt: 100 });
  const same = await store.ensureCredential({ agentId: 'a1', localId: 'r1', createdAt: 100 });
  assert.equal(same.key, first.key);
  const recreated = await store.ensureCredential({ agentId: 'a1', localId: 'r1', createdAt: 200 });
  assert.notEqual(recreated.key, first.key);
  assert.equal(recreated.automationId, first.automationId);
});
