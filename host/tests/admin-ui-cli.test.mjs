import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../tools/host-admin.mjs', import.meta.url));

async function demo(t, reply = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const path = req.url.slice('/admin/api/'.length);
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, path, body: body ? JSON.parse(body) : null });
    if (reply[path]) {
      res.writeHead(reply[path], { 'content-type': 'text/html' });
      return res.end('<html><title>DEMO PROXY</title></html>');
    }
    const fixture = { session: { initialized: true }, login: { ok: true }, setup: { ok: true },
      model: { model: 'demo', apiFormat: 'openai', baseUrl: 'https://model.example.invalid/v1' },
      'model/catalog': { models: [{ id: 'demo', efforts: ['low', 'high'] }] }, 'model/test': { ok: true },
      status: { host: { connected: true }, model: { reload: { status: 'applied' } } }, 'pairing-keys': {} };
    res.writeHead(path in fixture ? 200 : 404, { 'content-type': 'application/json' });
    if (path === 'status' && reply.splitWait) fixture.status.host = { connected: false, waitingForExecutionNode: true };
    res.end(JSON.stringify(fixture[path] ?? { error: 'Unknown demo endpoint' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const env = { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    GROKBOT_URL: `http://127.0.0.1:${server.address().port}`, GROKBOT_ADMIN_PASSWORD: 'demo-only-password',
    GROKBOT_SETUP_KEY: 'demo-only', MODEL_API_KEY: 'demo-only' };
  const run = async args => {
    calls.length = 0;
    try { return { code: 0, ...await exec(process.execPath, [cli, ...args], { env, timeout: 8000 }) }; }
    catch (error) { if (!Number.isInteger(error.code)) throw error; return error; }
  };
  return { calls, run };
}

test('malformed admin options fail before login, tests or mutations', async t => {
  const { calls, run } = await demo(t);
  const set = ['model-set', '--model', 'demo'];
  for (const args of [
    [...set, '--test-onyl', 'yes'], ['model-set', '--model', '--test-only'], [...set, '--context'],
    [...set, '--context', 'not-a-number'], [...set, '--context', '1.5'], [...set, '--context', '100000001'],
    [...set, '--format', 'chat'], [...set, '--effort', 'typo'], [...set, '--efforts', 'low,,high'],
    [...set, '--efforts', 'low,typo'], [...set, '--efforts', 'low', '--effort', 'high'],
    [...set, '--base-url', 'not-a-url'], [...set, '--model', 'other'], ['model-set', '--model', '  '],
    [...set, '--test-only=false'], ['pair', '--test-only'], ['pair', '--model', 'demo'],
    ['setup', '--bogus', 'value'], ['model-catalog', '--test-only'],
    [...set, '--api-key-file', 'admin-ui-demo-missing-key'],
  ]) await t.test(args.join(' '), async () => {
    const result = await run(args);
    assert.notEqual(result.code, 0, 'malformed invocation succeeded');
    assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [], 'must fail before any request');
    assert.match(result.stderr, /--[\w-]+/);
  });
});

test('valid model options test once; only a normal model-set saves', async t => {
  const { calls, run } = await demo(t);
  const args = ['model-set', '--model', 'demo', '--format', 'anthropic', '--effort', 'low', '--context', '0'];
  const dry = await run([...args, '--test-only']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(calls.map(call => call.path), ['login', 'model', 'model/catalog', 'model/test']);
  assert.equal(calls.at(-1).body.apiFormat, 'anthropic');
  assert.equal(calls.at(-1).body.contextWindowTokens, 0);
  assert.equal(calls.at(-1).body.policy.effort, 'low');
  const save = await run([...args, '--efforts', 'low,high']);
  assert.equal(save.code, 0, save.stderr);
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`),
    ['POST login', 'GET model', 'POST model/test', 'PUT model', 'GET status']);
});

test('split setup reports a saved model waiting for its execution node immediately, without claiming application', async t => {
  const { calls, run } = await demo(t, { splitWait: true });
  const result = await run(['model-set', '--model', 'demo', '--efforts', 'low']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /执行节点/);
  assert.doesNotMatch(result.stdout, /已应用/);
  assert.deepEqual(calls.slice(-2).map(c => c.path), ['model', 'status']);
});

test('CLI never prints proxy pages or saves after a non-JSON model test', async t => {
  const reply = {}, { calls, run } = await demo(t, reply);
  for (const [path, status] of [['login', 401], ['model/test', 502], ['model/test', 200], ['model/test', 204]]) {
    await t.test(`${path} HTTP ${status}`, async () => {
      reply[path] = status;
      const result = await run(['model-set', '--model', 'demo', '--efforts', 'low']);
      delete reply[path];
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, status === 204 ? /未确认成功/ : new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(result.stdout + result.stderr, /<html|DEMO PROXY/i);
      assert.ok(!calls.some(call => call.method === 'PUT'));
    });
  }
});
