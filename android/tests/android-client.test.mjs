import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { getEventListeners } from 'node:events';
import { readZip, writeZip, createEntry, entryBytes, signApk, verifyApk, createSigningIdentity } from '../patchers/apk.mjs';
import { androidIndexHtml, preloadMethods, wrapPreload, wrapVncPreload, loadSigningIdentity, BRIDGE_TAGS } from '../patchers/patch.mjs';
import { RENDERER_PATCHES, patchRendererFile } from '../patchers/renderer-patches.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');

// The client modules import ./desktop/*.mjs, which the patcher copies from the shared
// desktop client; load them from the same layout as inside the APK.
async function loadClient() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grokbot-android-client-'));
  await cp(path.join(repo, 'android/client'), root, { recursive: true });
  for (const name of ['i18n.mjs', 'external-url.mjs', 'connectors.mjs', 'dictation.mjs', 'sand-machines.mjs'])
    await cp(path.join(repo, 'mac/clients/desktop', name), path.join(root, 'desktop', name));
  const load = name => import(pathToFileURL(path.join(root, name)).href);
  return { root, services: await load('services.js'), webview: await load('webview.js'), gateway: await load('gateway.js'),
    layout: await load('layout.js'), anchors: await load('anchor-fallback.js') };
}
const client = await loadClient();
test.after(() => rm(client.root, { recursive: true, force: true }));

test('reconnecting releases abort listeners after each wait and handles an already closed workspace', async () => {
  const control = new AbortController();
  for (let i = 0; i < 3; i++) await client.gateway.wait(1, control.signal);
  assert.equal(getEventListeners(control.signal, 'abort').length, 0);
  const pending = client.gateway.wait(5000, control.signal);
  control.abort(new Error('disconnected'));
  await assert.rejects(pending, /disconnected/);
  await assert.rejects(client.gateway.wait(5000, control.signal), /disconnected/);
});

test('attachment download reports a failed system save even after all bytes were written', async t => {
  const calls = [], alerts = [];
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    calls.push(endpoint);
    const body = endpoint.endsWith('save-begin') ? { id: 'demo' }
      : endpoint.endsWith('save-end') && JSON.parse(init.body).ok ? { ok: false, error: 'disk full' } : { ok: true };
    return Response.json(body);
  });
  const old = globalThis.alert; globalThis.alert = message => alerts.push(message);
  t.after(() => { if (old === undefined) delete globalThis.alert; else globalThis.alert = old; });
  const api = client.services.createAttachments({ staging: client.services.createStaging(),
    command: async () => ({ totalSize: 1, bytesBase64: 'eA==' }) });
  assert.equal(await api.downloadAttachment({ path: '/data/demo.txt' }), false);
  assert.ok(calls.includes('/__native/save-chunk?id=demo'));
  assert.equal(alerts.length, 1);
});

test('an unreadable attachment never opens the system picker; a later interruption closes the partial save', async t => {
  const calls = [], reads = [], alerts = [];
  let readableHead = false;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (!url.endsWith('/log')) calls.push([url, url.endsWith('save-end') ? JSON.parse(init.body).ok : null]);
    return Response.json(url.endsWith('save-begin') ? { id: 'demo' } : { ok: true });
  });
  const oldAlert = globalThis.alert; globalThis.alert = text => alerts.push(text);
  t.after(() => { if (oldAlert === undefined) delete globalThis.alert; else globalThis.alert = oldAlert; });
  const api = client.services.createAttachments({ staging: client.services.createStaging(), command: async (_method, { length, offset }) => {
    reads.push({ length, offset });
    if (!length) return { totalSize: 2, bytesBase64: '' };
    if (!readableHead || offset) throw new Error('Fixture interrupted');
    return { totalSize: 2, bytesBase64: 'YQ==' };
  } });
  assert.equal(await api.downloadAttachment({ path: '/demo/file' }), false);
  assert.deepEqual(calls, [], 'a failed first read still created a system document');
  assert.ok(reads[0].length > 0 && reads[0].length <= 65536);
  readableHead = true;
  assert.equal(await api.downloadAttachment({ path: '/demo/file' }), false);
  assert.deepEqual(calls, [['/__native/save-begin', null], ['/__native/save-chunk?id=demo', null], ['/__native/save-end', false]]);
  assert.equal(alerts.length, 2);
});

test('staged attachment previews accept renderer file URLs and downloads never ask the Host for phone bytes', async t => {
  const calls = [], alerts = [], host = [];
  let cancel = false;
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    calls.push([endpoint, init.headers['content-type'] === 'application/json' ? JSON.parse(init.body) : [...init.body]]);
    return Response.json(endpoint.endsWith('save-begin') ? (cancel ? { cancelled: true } : { id: 'demo' }) : { ok: true });
  });
  const oldAlert = globalThis.alert; globalThis.alert = message => alerts.push(message);
  t.after(() => { if (oldAlert === undefined) delete globalThis.alert; else globalThis.alert = oldAlert; });
  const api = client.services.createAttachments({ staging: client.services.createStaging(), command: async method => { host.push(method); return null; } });
  const { path } = await api.stageAttachmentBytes({ filename: 'demo.txt', bytes: new Uint8Array([65, 66]) });
  const input = { path: `file://${path}` };
  assert.equal((await api.readAttachmentText(input)).text, 'AB');
  assert.equal(await api.downloadAttachment(input), true);
  assert.deepEqual(calls, [['/__native/save-begin', { name: 'demo.txt', mime: 'text/plain' }],
    ['/__native/save-chunk?id=demo', [65, 66]], ['/__native/save-end', { id: 'demo', ok: true }]]);
  cancel = true; calls.length = 0;
  assert.equal(await api.downloadAttachment(input), false);
  assert.deepEqual(calls.map(([method]) => method), ['/__native/save-begin']);
  assert.deepEqual(alerts, []);
  assert.deepEqual(host, []);
});

test('upload reaches 100 percent only on Host commit, retries original bytes, and coalesces path aliases', async () => {
  const progress = [], chunks = [];
  let accepted = false;
  const api = client.services.createAttachments({ staging: client.services.createStaging(),
    onProgress: ({ fraction }) => progress.push(fraction), command: async (_method, args) => {
      chunks.push(args.bytesBase64);
      return accepted ? { committedPath: '/demo/note.txt' } : {};
    } });
  const { path } = await api.stageAttachmentBytes({ filename: 'note.txt', bytes: Uint8Array.of(65) });
  const commit = source => api.commitStagedAttachments({ agentId: 'demo', filenames: ['note.txt'], paths: [source], progressKey: 'demo' });
  await assert.rejects(commit(path));
  assert.ok(!progress.includes(1), 'uncommitted bytes reported complete');
  accepted = true;
  assert.deepEqual(await commit(`file://${path}`), ['/demo/note.txt']);
  assert.deepEqual(await commit(path), ['/demo/note.txt']);
  assert.equal(progress.at(-1), 1);
  assert.deepEqual(chunks, ['QQ==', 'QQ==']);
});

test('removing a staged attachment cancels its pending upload before another chunk is sent', async () => {
  const started = Promise.withResolvers(), reply = Promise.withResolvers(), progress = [], offsets = [];
  const api = client.services.createAttachments({ staging: client.services.createStaging(),
    onProgress: ({ fraction }) => progress.push(fraction), command: async (_method, { offset }, signal) => {
      offsets.push(offset);
      if (offset) return { committedPath: '/demo/note.txt' };
      started.resolve(signal);
      return reply.promise;
    } });
  const { path } = await api.stageAttachmentBytes({ filename: 'note.txt', bytes: new Uint8Array(4 * 1024 * 1024 + 1) });
  const pending = api.commitStagedAttachments({ agentId: 'demo', filenames: ['note.txt'], paths: [path], progressKey: 'demo' });
  const signal = await started.promise;
  await api.discardStagedAttachment({ path: `file://${path}` });
  await api.discardStagedAttachment({ path });
  reply.resolve({});
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(signal.aborted, true);
  assert.deepEqual(offsets, [0]);
  assert.deepEqual(progress, [0]);
  assert.equal(await api.readAttachmentBytes({ path }), null);
});

test('each upload chunk gets its own deadline while the complete transfer can take longer', async t => {
  const deadlines = [];
  let elapsed = 0, stalled = false;
  t.mock.method(AbortSignal, 'timeout', ms => {
    const controller = new AbortController();
    deadlines.push({ controller, at: elapsed + ms });
    return controller.signal;
  });
  const api = client.services.createAttachments({ staging: client.services.createStaging(), command: async (_method, args, signal) => {
    elapsed += stalled ? 120001 : 75000;
    for (const { at, controller } of deadlines) if (elapsed >= at) controller.abort(new DOMException('Chunk deadline', 'TimeoutError'));
    if (signal.aborted) throw signal.reason;
    return args.offset ? { committedPath: '/demo/slow.txt' } : {};
  } });
  const { path } = await api.stageAttachmentBytes({ filename: 'slow.txt', bytes: new Uint8Array(4 * 1024 * 1024 + 1) });
  const args = { agentId: 'demo', filenames: ['slow.txt'], paths: [path] };
  assert.deepEqual(await api.commitStagedAttachments(args), ['/demo/slow.txt']);
  assert.equal(elapsed, 150000);
  assert.deepEqual(deadlines.map(d => d.at), [120000, 195000]);
  stalled = true;
  await assert.rejects(api.commitStagedAttachments({ ...args, agentId: 'another' }), { name: 'TimeoutError' });
});

test('failed settings writes do not appear saved in either the preference or persistence API', async t => {
  const storageKey = 'grokbot-android:notification-preferences';
  const original = { sound: 'ping-1-open-blip', playSound: true };
  const next = { sound: 'ping-2-tick', playSound: false };
  const persistence = client.services.createPersistence({ [storageKey]: original });
  const services = client.services.createServices({ gateway: {}, settings: {}, persistence, profile: { handlers: {} } });
  let fail = true;
  t.mock.method(globalThis, 'fetch', async () => Response.json(fail ? { ok: false, error: 'Could not save' } : { ok: true }));
  await assert.rejects(services.call('setDesktopNotificationPreferences', { preferences: next }), /Could not save/);
  assert.deepEqual(await services.call('getNotificationPreferences'), original);
  assert.deepEqual(persistence.readClientPersistence({ key: storageKey }), original);
  fail = false;
  assert.deepEqual(await services.call('setDesktopNotificationPreferences', { preferences: next }), next);
  fail = true;
  await assert.rejects(persistence.removeClientPersistence({ key: storageKey }), /Could not save/);
  await assert.rejects(persistence.migrateClientPersistence({ entries: [{ key: 'fixture', value: true }] }), /Could not save/);
  assert.deepEqual(persistence.readClientPersistence({ key: storageKey }), next);
  assert.equal(persistence.readClientPersistence({ key: 'fixture' }), null);
});

test('gateway distinguishes a null reply from malformed or interrupted success responses', async t => {
  const gw = client.gateway.createGateway();
  let response;
  t.mock.method(globalThis, 'fetch', async () => response);
  response = Response.json(null);
  assert.equal(await gw.command('listAgents'), null);
  response = new Response('{');
  await assert.rejects(gw.command('listAgents'), SyntaxError);
  const stop = new DOMException('cancelled while reading', 'AbortError');
  response = new Response(new ReadableStream({ start(controller) { controller.error(stop); } }));
  await assert.rejects(gw.command('listAgents'), error => error === stop);
  response = new Response('not JSON', { status: 502 });
  await assert.rejects(gw.command('listAgents'), error => error.httpStatus === 502 && error.message === 'HTTP 502');
  gw.close();
});

test('reconnect resumes after the last delivered event, then stops on cancellation', async t => {
  const control = new AbortController(), seen = [], requests = [], states = [];
  t.mock.method(globalThis, 'fetch', async (_endpoint, { headers }) => {
    requests.push(headers);
    const id = requests.length;
    return new Response(`id: ${id}\ndata: {"n":${id}}\n\n` + (id === 2 ? 'id: 3\ndata: {"n":3}\n\n' : ''));
  });
  await client.gateway.subscribe('/events', frame => {
    seen.push(frame.data.n);
    if (frame.data.n === 2) control.abort();
  }, control.signal, { onConnected: () => states.push('online'), onDisconnected: () => states.push('reconnecting') });
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(requests, [{}, { 'Last-Event-ID': '1' }]);
  assert.deepEqual(states, ['online', 'reconnecting', 'online']);
  assert.equal(getEventListeners(control.signal, 'abort').length, 0);
});

test('an empty event ID clears the cursor and a revoked connection is not retried', async t => {
  const headers = [], control = new AbortController();
  let unauthorized = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    headers.push(init.headers['Last-Event-ID']);
    return headers.length === 3 ? new Response(null, { status: 401 })
      : new Response(`id: ${headers.length === 1 ? 'demo-1' : ''}\ndata: {}\n\n`);
  });
  await client.gateway.subscribe('/events', () => {}, control.signal, { onUnauthorized: () => { unauthorized++; } });
  assert.deepEqual(headers, [undefined, 'demo-1', undefined]);
  assert.equal(unauthorized, 1);
});

test('short HTTP 200 event streams back off even with a snapshot; a stable stream resets the delay', async t => {
  const delays = [], control = new AbortController();
  let attempt = 0, clock = 0;
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms === 15000) return timer(fn, ms, ...args); // Connection-header timeout, not a retry.
    delays.push(ms);
    return timer(fn, 0, ...args);
  });
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(globalThis, 'fetch', async () => {
    ++attempt;
    if (attempt === 10) return new Response(null, { status: 401 });
    return new Response(attempt === 3 || attempt === 8 ? `data: {"stable":${attempt === 8}}\n\n` : '');
  });
  await client.gateway.subscribe('/events', frame => { if (frame.data.stable) clock += 30001; }, control.signal);
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 10000, 10000, 500, 1000]);
});

test('completed requests release fallback abort listeners on WebViews without AbortSignal.any', async t => {
  const old = AbortSignal.any;
  AbortSignal.any = undefined;
  t.after(() => { AbortSignal.any = old; });
  const control = new AbortController(), gw = client.gateway.createGateway();
  t.mock.method(globalThis, 'fetch', async () => Response.json({}));
  try {
    for (let i = 0; i < 4; ++i) await gw.command('listAgents', {}, control.signal);
    assert.equal(getEventListeners(control.signal, 'abort').length, 0);
  } finally { gw.close(); }
});

test('cancelling a coordinator request aborts its fetch and settles only that request', async t => {
  const gw = client.gateway.createGateway(), { port1, port2 } = new MessageChannel();
  const dispose = gw.attach(port1);
  t.after(() => { dispose(); port2.close(); gw.close(); });
  const started = Promise.withResolvers(), cancelled = Promise.withResolvers(), next = Promise.withResolvers();
  port2.onmessage = ({ data }) => (data.requestId === 'slow' ? cancelled : next).resolve(data.outcome);
  t.mock.method(globalThis, 'fetch', async (endpoint, { signal }) => {
    if (endpoint.endsWith('/listAgents')) {
      started.resolve(signal);
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return Response.json({ theme: 'system' });
  });
  const send = (requestId, method) => port2.postMessage({ kind: 'request', requestId, method, args: {} });
  send('slow', 'listAgents');
  const signal = await started.promise;
  port2.postMessage({ kind: 'cancel', requestId: 'slow' });
  send('next', 'getHostSettings');
  assert.deepEqual(await next.promise, { status: 'ok', value: { theme: 'system' } });
  assert.equal(signal.aborted, true);
  assert.equal((await cancelled.promise).failure.code, 'cancelled');
});

test('APK entries are aligned, signed with scheme v2 and checked against tampering', () => {
  const identity = createSigningIdentity();
  const unsigned = writeZip([
    createEntry('AndroidManifest.xml', Buffer.from('manifest '.repeat(50))),
    createEntry('resources.arsc', Buffer.from('table'), { store: true }),
    createEntry('lib/x86_64/libdemo.so', Buffer.alloc(100, 7), { store: true }),
    createEntry('assets/web/client/bridge.js', Buffer.from('export {};\n'.repeat(20))),
  ]);
  const entries = readZip(unsigned).entries;
  assert.equal(entries.find(entry => entry.name === 'resources.arsc').dataStart % 4, 0);
  assert.equal(entries.find(entry => entry.name.endsWith('.so')).dataStart % 16384, 0);
  assert.equal(entryBytes(entries[0]).toString(), 'manifest '.repeat(50));

  const apk = signApk(unsigned, identity);
  assert.match(verifyApk(apk).subject, /Grok Bot Local/);
  assert.throws(() => signApk(apk, identity), /already signed/);
  const tampered = Buffer.from(apk);
  tampered[readZip(apk).entries.find(entry => entry.name === 'resources.arsc').dataStart] ^= 1;
  assert.throws(() => verifyApk(tampered), /do not match/);
});

test('the signing key is created once, private to the user, and reused', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grokbot-android-key-'));
  try {
    const filename = path.join(directory, 'nested', 'android-signing.json');
    const created = await loadSigningIdentity(filename);
    const loaded = await loadSigningIdentity(filename);
    assert.equal(created.created, true);
    assert.equal(loaded.created, false);
    assert.ok(loaded.certificate.equals(created.certificate));
    if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);
    await writeFile(filename, JSON.stringify({ schema: 'other' }));
    await assert.rejects(loadSigningIdentity(filename), /签名文件格式不正确/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the interface entry gets the bridge before the renderer and may frame the local desktop port', () => {
  const html = '<!doctype html><html><head>' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; frame-src sand-html-preview: sand-canvas: sand-mcp-app:; img-src *">' +
    '<script type="module" crossorigin src="./assets/index-abc.js"></script></head><body></body></html>';
  const result = androidIndexHtml(html);
  assert.ok(result.indexOf(BRIDGE_TAGS) < result.indexOf('./assets/index-abc.js'));
  // The policy sits ahead of the module script; it must still be extended.
  assert.match(result, /frame-src sand-html-preview: sand-canvas: sand-mcp-app: http:\/\/127\.0\.0\.1:\*;/);
  // 1.1.0 lists one more preview scheme.
  assert.match(androidIndexHtml(html.replace('sand-mcp-app:;', 'sand-mcp-app: sand-visualization:;')),
    /frame-src sand-html-preview: sand-canvas: sand-mcp-app: sand-visualization: http:\/\/127\.0\.0\.1:\*;/);
  assert.throws(() => androidIndexHtml(html.replace('frame-src', 'child-src')), /不一致/);
  assert.throws(() => androidIndexHtml(html.replace('</head>', '<script type="module" crossorigin src="./assets/index-x.js"></script></head>')), /不一致/);
});

test('the original preloads run as CommonJS inside their wrappers', async () => {
  const source = '"use strict";var e={};module.exports=e;exports.unused=1;' +
    'const c=require("electron");c.contextBridge.exposeInMainWorld("desktop",{ping:t().noArgs,send:t().args({x:1})});';
  assert.deepEqual(preloadMethods(source), ['ping', 'send']);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'grokbot-android-preload-'));
  try {
    const file = path.join(directory, 'official-preload.mjs');
    await writeFile(file, wrapPreload(source));
    const exposed = {};
    const module = await import(pathToFileURL(file).href);
    globalThis.t = () => ({ noArgs: 'none', args: value => value });
    const electron = { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } } };
    module.default(name => name === 'electron' ? electron : null, {});
    delete globalThis.t;
    assert.deepEqual(Object.keys(exposed.desktop), ['ping', 'send']);
    assert.deepEqual(module.methods, ['ping', 'send']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const sent = [];
  const vncSource = '"use strict";var r={};module.exports=r;var U=require("electron");U.ipcRenderer.sendToHost("sand:vnc-session",process.type);';
  const window = { __grokbotVncPreload: {
    require: name => name === 'electron' ? { ipcRenderer: { sendToHost: (...args) => sent.push(args) } } : null,
    process: { type: 'renderer' } } };
  vm.runInNewContext(wrapVncPreload(vncSource), { window });
  assert.deepEqual(sent, [['sand:vnc-session', 'renderer']]);
});

test('renderer patches apply only to the pinned files and replace unique anchors', () => {
  for (const [version, patches] of Object.entries(RENDERER_PATCHES)) {
    assert.equal(patchRendererFile('assets/unrelated.js', Buffer.from('x'), version), null);
    assert.ok(patches.length > 0, version);
    for (const patch of patches) {
      assert.match(patch.sha256, /^[0-9a-f]{64}$/);
      assert.throws(() => patchRendererFile(patch.file, Buffer.from('not the pinned file'), version), /不一致/);
      for (const [from, to] of patch.edits) assert.notEqual(from, to);
    }
  }
  assert.throws(() => patchRendererFile('assets/unrelated.js', Buffer.from('x'), '0.70.0'), /没有 Windows 0\.70\.0/);
});

test('attachments from the Host are remote paths, never local files', () => {
  const { remoteAttachmentPath, resolveLanguage, mimeFor } = client.services;
  assert.equal(remoteAttachmentPath('file:///home/bot/%E5%9B%BE.png'), '/home/bot/图.png');
  assert.equal(remoteAttachmentPath('/workspace/report.pdf'), '/workspace/report.pdf');
  assert.equal(remoteAttachmentPath('file://other-host/etc/passwd'), null);
  assert.equal(remoteAttachmentPath('https://example.com/a.png'), null);
  assert.equal(remoteAttachmentPath('a\0b'), null);
  assert.equal(resolveLanguage('zh-Hant-TW'), 'zh-TW');
  assert.equal(resolveLanguage('zh-CN'), 'zh-CN');
  assert.equal(resolveLanguage('fr-FR'), 'fr');
  assert.equal(mimeFor('Photo.JPG'), 'image/jpeg');
  assert.equal(mimeFor('archive.unknown'), 'application/octet-stream');
});

test('only computer view pages of the paired Host load in the webview frame', () => {
  const { mapDesktopSource } = client.webview;
  const options = { hostOrigin: 'http://host.test:18080', vncOrigin: 'http://127.0.0.1:39720', base: 'http://127.0.0.1:39710/app/renderer/index.html' };
  const mapped = new URL(mapDesktopSource('http://host.test:18080/vnc/fork/vnc.html?path=%2Fvnc%2Ffork%2Fwebsockify&encrypt=1', options));
  assert.equal(mapped.origin, options.vncOrigin);
  assert.equal(mapped.pathname, '/vnc/fork/vnc.html');
  assert.equal(mapped.searchParams.get('encrypt'), '0');
  assert.equal(mapped.searchParams.get('path'), '/vnc/fork/websockify');
  assert.equal(mapDesktopSource('http://host.test:18080/api/listAgents', options), null);
  assert.equal(mapDesktopSource('http://elsewhere.test/vnc/desktop/vnc.html', options), null);
  assert.equal(mapDesktopSource('javascript:alert(1)', options), null);
  const tailcatOptions = { ...options, hostOrigin: () => 'tailcat://connect/tcExample?port=8000', tailcat: () => true };
  assert.equal(new URL(mapDesktopSource('http://127.0.0.1:41234/vnc/desktop/vnc.html', tailcatOptions)).origin, options.vncOrigin);
  assert.equal(mapDesktopSource('https://127.0.0.1:41234/vnc/desktop/vnc.html', tailcatOptions), null);
});

test('the computer view swaps in a current ticket for an address read long ago', async t => {
  const { withDesktopTicket } = client.webview;
  const old = 'http://127.0.0.1:39720/vnc/fork/vnc.html?path=%2Fvnc%2Ffork%2Fwebsockify%3Ftoken%3D2%26ticket%3Dold&encrypt=0&ticket=old';
  const fresh = new URL(withDesktopTicket(old, 'new'));
  assert.equal(fresh.searchParams.get('ticket'), 'new');
  assert.equal(fresh.searchParams.get('path'), '/vnc/fork/websockify?token=2&ticket=new');
  assert.equal(fresh.searchParams.get('encrypt'), '0');

  const gw = client.gateway.createGateway(), calls = [];
  const box = ticket => ({ state: 'running', vncUrl: `http://host.test/vnc/fork/vnc.html?ticket=${ticket}`,
    windows: [{ vncUrl: `http://host.test/vnc/fork/vnc.html?ticket=${ticket}` }] });
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    calls.push([url, JSON.parse(body)]);
    return Response.json(url === '/api/getSubagents' ? [] : box(calls.length === 1 ? 'old' : 'new'));
  });
  // Unknown until a box status names the Bot that owns the slot.
  assert.equal(await gw.desktopTicket('fork'), null);
  await gw.command('getForeverBoxStatus', { id: 'bot-1' });
  await gw.command('getSubagents', { id: 'bot-2' });
  assert.equal(await gw.desktopTicket('fork'), 'new');
  assert.equal(await gw.desktopTicket('desktop'), null);
  assert.deepEqual(calls.map(([url, args]) => `${url} ${args.id}`),
    ['/api/getForeverBoxStatus bot-1', '/api/getSubagents bot-2', '/api/getForeverBoxStatus bot-1']);
  gw.close();
});

test('server-sent events are parsed across chunk boundaries', async () => {
  const chunks = ['id: 1\nevent: agent\ndata: {"a":', '1}\n\n: keep-alive\n\ndata: {"b":2}\r\n', '\r\n'];
  const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
  const events = [];
  await client.gateway.readSse(body, event => { events.push(event); });
  assert.deepEqual(events, [{ data: { a: 1 }, id: '1', event: 'agent' }, { data: { b: 2 }, id: undefined, event: undefined }]);
});

test('anchor positions resolve against the containing block', () => {
  const { resolveAnchorExpression: resolve } = client.anchors;
  const anchor = { top: 100, left: 50, width: 200, height: 120 }, box = { top: 10, left: 0, width: 400, height: 800 };
  assert.equal(resolve('anchor(top)', 'top', anchor, box), '90px');
  assert.equal(resolve('anchor(bottom)', 'bottom', anchor, box), '590px');
  assert.equal(resolve('anchor(left)', 'left', anchor, box), '50px');
  assert.equal(resolve('anchor(right)', 'right', anchor, box), '150px');
  assert.equal(resolve('anchor-size(width)', 'width', anchor, box), '200px');
  assert.equal(resolve('anchor-size(height)', 'height', anchor, box), '120px');
  assert.equal(resolve('calc(anchor(start, 0px) + 16px)', 'insetInlineStart', anchor, box), 'calc(50px + 16px)');
  assert.equal(resolve('anchor(start)', 'insetInlineStart', anchor, box, { rtl: true }), '150px');
  assert.equal(resolve('anchor(--other center)', 'top', null, box, { named: () => anchor }), '150px');
  assert.equal(resolve('anchor(start, 0px)', 'insetInlineStart', null, box), '0px');
  assert.equal(resolve('anchor(top)', 'top', null, box), null);
});

test('wide image attachments are scaled down to the message column', () => {
  const frame = (width, height, available) => ({ style: { width: `${width}px`, height: `${height}px` }, parentElement: { clientWidth: available } });
  const wide = frame(320, 180, 240), narrow = frame(160, 90, 240);
  client.layout.fitAttachmentFrames({ querySelectorAll: () => [wide, narrow] });
  assert.deepEqual(wide.style, { width: '240px', height: '135px' });
  assert.deepEqual(narrow.style, { width: '160px', height: '90px' });
  wide.parentElement.clientWidth = 360;
  client.layout.fitAttachmentFrames({ querySelectorAll: () => [wide] });
  assert.deepEqual(wide.style, { width: '320px', height: '180px' });
  Object.assign(wide.style, { width: '400px', height: '200px' });
  client.layout.fitAttachmentFrames({ querySelectorAll: () => [wide] });
  assert.deepEqual(wide.style, { width: '360px', height: '180px' });
});


test('on a phone, a created Bot opens its conversation and a deleted one returns to the list', () => {
  const next = (change) => client.layout.screenAfterAgentChange({ previousListed: true, currentKnown: true, userCaused: true, ...change });
  // The list loading for the first time, or selecting nothing new, keeps the screen.
  assert.equal(next({ previous: undefined, current: 'a', screen: 'list', currentKnown: false }), 'list');
  assert.equal(next({ previous: 'a', current: 'a', screen: 'chat' }), 'chat');
  // In the list: a Bot the user just created opens; deleting the selected Bot selects another and stays.
  assert.equal(next({ previous: 'a', current: 'b', screen: 'list', currentKnown: false }), 'chat');
  assert.equal(next({ previous: null, current: 'b', screen: 'list', currentKnown: false }), 'chat');
  assert.equal(next({ previous: 'a', current: 'b', screen: 'list', currentKnown: false, userCaused: false }), 'list');
  assert.equal(next({ previous: 'a', current: 'b', screen: 'list', previousListed: false }), 'list');
  // The Host can take a while to make a Bot: after "Create" its conversation opens even when its
  // row was already listed and the tap was long ago; the selection clearing first keeps the list.
  assert.equal(next({ previous: null, current: 'b', screen: 'list', userCaused: false, creating: true }), 'chat');
  assert.equal(next({ previous: 'a', current: null, screen: 'list', creating: true }), 'list');
  // In a conversation: following a link to another Bot stays; the open Bot being deleted returns.
  assert.equal(next({ previous: 'a', current: 'b', screen: 'chat' }), 'chat');
  assert.equal(next({ previous: 'a', current: 'b', screen: 'chat', previousListed: false }), 'list');
  assert.equal(next({ previous: 'a', current: null, screen: 'chat', previousListed: false }), 'list');
});

test('a Bot row shows when the Bot was last active, as the official phone app does', () => {
  const now = new Date(2026, 10, 11, 15, 0).getTime(); // a Wednesday
  const time = (date, locale = 'en-US') => {
    const text = client.layout.activityTime(date instanceof Date ? date.getTime() : date, now, locale);
    return text === null ? null : text.replace(/\s/g, ' ');
  };
  assert.equal(time(new Date(2026, 10, 11, 8, 41)), '8:41 AM');
  assert.equal(time(new Date(2026, 10, 11, 8, 41), 'zh-CN'), '8:41');
  assert.equal(time(new Date(2026, 10, 10, 23, 59)), 'Yesterday');
  assert.equal(time(new Date(2026, 10, 10, 0, 1), 'zh-CN'), '昨天');
  assert.equal(time(new Date(2026, 10, 9, 12, 0)), 'Monday');
  assert.equal(time(new Date(2026, 10, 1, 12, 0)), 'Nov 1');
  assert.equal(time(new Date(2025, 0, 2, 12, 0)), 'Jan 2, 2025');
  assert.equal(time(null), null);
  assert.equal(time(0), null);
});

test('Android connect page supports switching between pairing code and Host admin password', async t => {
  const { readFile } = await import('node:fs/promises');
  class ClassList {
    constructor() { this.set = new Set(); }
    toggle(name, force) { if (force === undefined) { if (this.set.has(name)) this.set.delete(name); else this.set.add(name); } else if (force) this.set.add(name); else this.set.delete(name); }
    contains(name) { return this.set.has(name); }
  }
  class Elem extends EventTarget {
    constructor() {
      super();
      this.value = '';
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
      this.textContent = '';
      this.placeholder = '';
      this.attrs = {};
      this.classList = new ClassList();
      this.options = Array.from({ length: 5 }, () => ({ textContent: '' }));
    }
    setAttribute(k, v) { this.attrs[k] = v; }
    focus() {}
    replaceChildren() {}
  }
  const elements = new Map();
  const getEl = sel => {
    if (!elements.has(sel)) elements.set(sel, new Elem());
    return elements.get(sel);
  };
  const connectJsPath = path.join(client.root, 'connect.js');
  const connectHtml = await readFile(path.join(repo, 'android/client/connect.html'), 'utf8');
  assert.match(connectHtml, /id="mode-code"/);
  assert.match(connectHtml, /id="mode-password"/);
  assert.match(connectHtml, /id="password"/);

  const pairPayloads = [];
  const oldGlobals = {
    document: globalThis.document,
    window: globalThis.window,
    matchMedia: globalThis.matchMedia,
    Option: globalThis.Option,
  };
  let pairIndex = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === '/__native/pair') {
      pairPayloads.push(JSON.parse(init.body));
      return Response.json(pairIndex++ === 0 ? { ok: false, error: 'expired' } : { ok: true });
    }
    return Response.json({ ok: true });
  });
  Object.assign(globalThis, {
    document: { documentElement: {}, title: '', querySelector: getEl },
    window: { __grokbotAndroidBoot: { locale: 'en', connection: { paired: false } } },
    matchMedia: () => ({ matches: true }),
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
  });
  t.after(() => {
    for (const [k, v] of Object.entries(oldGlobals)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  });

  await import(pathToFileURL(connectJsPath).href);
  assert.equal(getEl('#key-group').hidden, false);
  assert.equal(getEl('#password-group').hidden, true);

  getEl('#server').value = 'https://host.example';
  getEl('#key').value = 'ab-c234';
  getEl('#form').dispatchEvent(new Event('submit', { cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pairPayloads[0], { server: 'https://host.example', key: 'ABC234', edit: false });

  getEl('#mode-password').dispatchEvent(new Event('click'));
  assert.equal(getEl('#key-group').hidden, true);
  assert.equal(getEl('#password-group').hidden, false);

  // Empty password should not call /__native/pair.
  getEl('#password').value = '';
  getEl('#form').dispatchEvent(new Event('submit', { cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pairPayloads.length, 1);

  getEl('#password').value = 'AdminSecret123';
  getEl('#form').dispatchEvent(new Event('submit', { cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pairPayloads[1], { server: 'https://host.example', password: 'AdminSecret123', edit: false });
  assert.equal(getEl('#password').value, '');
});

test('android.css and MainActivity guard against phone horizontal overflow and WebView blank screens', async () => {
  const [css, layoutSrc, activitySrc] = await Promise.all([
    readFile(path.join(repo, 'android/client/android.css'), 'utf8'),
    readFile(path.join(repo, 'android/client/layout.js'), 'utf8'),
    readFile(path.join(repo, 'android/shell/app/src/main/java/dev/grokbot/local/MainActivity.kt'), 'utf8'),
  ]);
  assert.match(css, /html\.grokbot-phone \.sand-virtual-transcript\s*\{[^}]*overflow-x:\s*clip\s*!important/);
  assert.match(css, /html\.grokbot-phone \.sand-message-prose :is\(p, li, code, a\)\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /html\.grokbot-android \.sand-chat\s*\{[^}]*--sand-chat-min-width:\s*0px/);
  assert.match(layoutSrc, /scrollLeft\s*=\s*0/);
  assert.match(layoutSrc, /phone\.screen === 'chat' && !current && !newChat && listed\.size > 0/);
  assert.match(activitySrc, /pendingWebRecovery/);
  assert.match(activitySrc, /verifyWebViewHealthy/);
  assert.match(activitySrc, /onReceivedError/);
  assert.match(activitySrc, /onReceivedHttpError/);
});

test('formatMoreUnreadsLabel formats unread count pill text across locales and edge inputs', () => {
  const { formatMoreUnreadsLabel } = client.layout;
  assert.equal(formatMoreUnreadsLabel('1 条未读消息', true), '1个未读');
  assert.equal(formatMoreUnreadsLabel('12 条未读消息', false), '12个未读');
  assert.equal(formatMoreUnreadsLabel('3 則未讀訊息', false), '3個未讀');
  assert.equal(formatMoreUnreadsLabel('1 unread message', false), '1 unread');
  assert.equal(formatMoreUnreadsLabel('1,234 unread messages', true), '1234 unread');
  assert.equal(formatMoreUnreadsLabel('5 items', true), '5个未读');
  assert.equal(formatMoreUnreadsLabel('0 unread messages', false), null);
  assert.equal(formatMoreUnreadsLabel('More unreads', true), null);
  assert.equal(formatMoreUnreadsLabel(null, true), null);
});

test('android.css positions unread pill above search bar and keeps expanded composer full-width without clipping buttons', async () => {
  const [css, layoutSrc] = await Promise.all([
    readFile(path.join(repo, 'android/client/android.css'), 'utf8'),
    readFile(path.join(repo, 'android/client/layout.js'), 'utf8'),
  ]);
  assert.match(css, /button\.sand-agents-more-unreads:not\(\[data-direction="above"\]\)[^}]*bottom:\s*68px\s*!important/);
  assert.match(css, /button\.sand-agents-more-unreads\[data-direction="above"\][^}]*top:\s*10px\s*!important/);
  assert.match(css, /button\.sand-agents-more-unreads\[data-grokbot-label\]::before\s*\{[^}]*content:\s*attr\(data-grokbot-label\)/);
  assert.doesNotMatch(css, /\.sand-prompt-form\s*\{\s*padding-left:\s*52px/);
  assert.doesNotMatch(css, /\.sand-prompt-shell:not\(\[data-expanded\]\):has\(\.sand-prompt-field > p\.is-editor-empty:only-child\)\s+\.sand-prompt-pad/);
  assert.match(css, /\.sand-prompt-shell:has\(\.sand-prompt-field > p\.is-editor-empty:only-child\)\s+\.sand-prompt-send\[type="button"\]/);
  assert.match(css, /\.sand-prompt-shell\[data-expanded\]:not\(\[data-expanded="false"\]\)\s+\.sand-prompt-pad\s*\{[^}]*padding:\s*10px\s+16px\s+46px\s+16px\s*!important/);
  assert.match(css, /\.sand-prompt-ghost-mic-seat:not\(\.sand-nalus7\):not\(:has\(\.sand-prompt-mic\[inert\]\)\)\s*\{[^}]*width:\s*32px\s*!important[^}]*overflow:\s*visible\s*!important/);
  assert.match(layoutSrc, /attributeFilter:\s*\[[^\]]*'title'/);
});

test('swipeReplyDisplacement, timestampPeekAmount and findReplyActionButton handle right-swipe quote and left-swipe timestamps', () => {
  const { swipeReplyDisplacement, timestampPeekAmount, findReplyActionButton } = client.layout;
  assert.equal(swipeReplyDisplacement(0), 0);
  assert.equal(swipeReplyDisplacement(-24), 0);
  assert.equal(swipeReplyDisplacement(30), 30);
  assert.equal(swipeReplyDisplacement(56), 56);
  assert.ok(swipeReplyDisplacement(100) > 56 && swipeReplyDisplacement(100) <= 76);
  assert.equal(swipeReplyDisplacement(10000), 76);

  assert.deepEqual(timestampPeekAmount(0), { peekPx: 0, progress: 0 });
  assert.deepEqual(timestampPeekAmount(24), { peekPx: 0, progress: 0 });
  assert.deepEqual(timestampPeekAmount(-24), { peekPx: 24, progress: 0.5 });
  assert.deepEqual(timestampPeekAmount(-48), { peekPx: 48, progress: 1 });
  assert.deepEqual(timestampPeekAmount(-200), { peekPx: 82, progress: 1 });

  const mkBtn = (label, hasPopup = false) => ({
    getAttribute: k => (k === 'aria-label' ? label : null),
    hasAttribute: k => k === 'aria-haspopup' && hasPopup,
  });
  const mkAnchor = buttons => ({ querySelectorAll: () => buttons });

  const zhBtn = mkBtn('回复 ikun 的消息');
  assert.equal(findReplyActionButton(mkAnchor([mkBtn('Expand'), zhBtn, mkBtn('More options', true)])), zhBtn);

  const svBtn = mkBtn('Svara på meddelande');
  assert.equal(findReplyActionButton(mkAnchor([mkBtn('展開'), svBtn, mkBtn('Fler val', true)])), svBtn);
  assert.equal(findReplyActionButton(mkAnchor([mkBtn('Expand'), mkBtn('More', true)])), null);
  assert.equal(findReplyActionButton(null), null);
});


test('boot reads give up after a bounded wait instead of holding the interface blank', async t => {
  t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(new DOMException('Timed out', 'TimeoutError')));
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    seen.push(endpoint);
    if (init.signal.aborted) throw init.signal.reason;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  });
  const gateway = client.gateway.createGateway();
  await assert.rejects(gateway.command('getHostSettings'), /Timed out/);
  await assert.rejects(gateway.command('getMcpState'), /Timed out/);
  await assert.rejects(gateway.command('listAgents'), /Timed out/);
  assert.deepEqual(seen, ['/api/getHostSettings', '/api/getMcpState', '/api/listAgents']);
});

test('the hub counts the Bot\'s switched-on routines, not its skills, and a paused routine is not counted', () => {
  const { countActiveRoutines } = client.layout;
  assert.equal(countActiveRoutines([]), 0);
  assert.equal(countActiveRoutines([{ id: 'a', isEnabled: false }, { id: 'b', isEnabled: true }]), 1);
  assert.equal(countActiveRoutines([{ id: 'a', isEnabled: true }, { id: 'b' }, null, { id: 'c', paused: true }]), 2);
});
