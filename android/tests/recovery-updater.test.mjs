import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSigningIdentity, wrapPreload } from '../patchers/patch.mjs';
import { createEntry, entryBytes, readZip, signApk, verifyApk, writeZip } from '../patchers/apk.mjs';
import {
  canonicalAndroidManifestPayload,
  loadManifestSigningKey,
  signAndroidUpdateManifest,
  verifyAndroidUpdateManifest,
} from '../patchers/release-sign.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');

async function loadGateway() {
  const root = await mkdtemp(join(tmpdir(), 'grokbot-android-gw-'));
  await cp(path.join(repo, 'android/client'), root, { recursive: true });
  for (const name of ['i18n.mjs', 'external-url.mjs', 'connectors.mjs']) {
    await cp(path.join(repo, 'mac/clients/desktop', name), path.join(root, 'desktop', name));
  }
  const mod = await import(pathToFileURL(path.join(root, 'gateway.js')).href);
  return { root, ...mod };
}

const gatewayMod = await loadGateway();
const { readSse, createGateway } = gatewayMod;
test.after(() => rm(gatewayMod.root, { recursive: true, force: true }));

test('readSse triggers onActivity on heartbeat comments without waiting for data frames', async () => {
  let activity = 0;
  const events = [];
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(':ping\n\n'));
      controller.enqueue(encoder.encode(': heartbeat\n\ndata: {"ok":true}\n\n'));
      controller.close();
    },
  });
  await readSse(stream, frame => events.push(frame.data), { onActivity: () => { activity += 1; } });
  assert.ok(activity >= 2);
  assert.deepEqual(events, [{ ok: true }]);
});

test('subscribe with idleTimeoutMs aborts dead streams when no pings arrive, and reconnectStreams wakes backoff immediately', async t => {
  const gw = createGateway({ streamIdleTimeoutMs: 40 });
  const { port1, port2 } = new MessageChannel();
  const dispose = gw.attach(port1);
  t.after(() => { dispose(); port2.close(); gw.close(); });

  let attempts = 0;
  let abortedFirst = false;
  const secondOpened = Promise.withResolvers();
  const thirdOpened = Promise.withResolvers();

  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    if (url !== '/events') return new Response(null, { status: 204 });
    attempts += 1;
    const n = attempts;
    const body = new ReadableStream({
      start(controller) {
        if (n === 1) {
          // Hang silently until idle timeout fires (~40ms).
          signal.addEventListener('abort', () => { abortedFirst = true; controller.close(); }, { once: true });
        } else if (n === 2) {
          controller.enqueue(new TextEncoder().encode(':ping\n\n'));
          secondOpened.resolve();
          signal.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
        } else {
          controller.enqueue(new TextEncoder().encode('data: {"channel":"recovered","payload":{"ok":1}}\n\n'));
          thirdOpened.resolve();
          signal.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
        }
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });

  const frames = [];
  port2.onmessage = ({ data }) => frames.push(data);
  port2.start();
  port2.postMessage({ kind: 'lifecycle', phase: 'hello' });

  await secondOpened.promise;
  assert.equal(abortedFirst, true);

  // Force immediate reconnect via bridge/resume path.
  assert.equal(gw.reconnectStreams(), true);
  await thirdOpened.promise;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(frames.some(f => f.kind === 'event' && f.family === 'recovered'));
  assert.ok(frames.some(f => f.kind === 'event' && f.family === 'transport-connected' && f.payload.generation >= 2));
});

test('bridge resume emits window-focus catchup, calls native resume, and wires update RPCs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'grokbot-bridge-resume-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'desktop'));
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  for (const name of ['bridge.js', 'native.js', 'services.js', 'gateway.js', 'layout.js', 'webview.js', 'anchor-fallback.js']) {
    await copyFile(new URL(`../client/${name}`, import.meta.url), join(dir, name));
  }
  for (const name of ['i18n.mjs', 'connectors.mjs', 'external-url.mjs', 'dictation.mjs']) {
    await copyFile(new URL(`../../mac/clients/desktop/${name}`, import.meta.url), join(dir, 'desktop', name));
  }
  await writeFile(join(dir, 'official-preload.js'), wrapPreload(`
    const { ipcRenderer: ipc, contextBridge: world } = require('electron');
    const t = () => ({ noArgs: null, args: () => null });
    const declarations = { getUpdateStatus:t().noArgs, checkForUpdates:t().noArgs, forceReconnectGateway:t().noArgs };
    world.exposeInMainWorld('desktop', {
      on: (ch, fn) => { ipc.on(ch, fn); return () => ipc.off(ch, fn); },
      call: (method, args) => ipc.invoke('dune-rpc:main:m:' + method, args),
      probe: method => ipc.invoke('dune-rpc:main:probe', method),
    });
  `));

  const calls = [];
  const window = {};
  const restore = [];
  const setGlobal = (key, value) => {
    const prev = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    restore.push(() => { if (prev) Object.defineProperty(globalThis, key, prev); else delete globalThis[key]; });
  };
  t.after(() => { for (const fn of restore.toReversed()) fn(); });

  const events = new EventTarget();
  const sampleUpdateStatus = {
    state: { type: 'ready', version: '1.2.0' },
    currentVersion: '1.1.0',
    currentTrack: 'stable',
    trackOverride: null,
    buildDefaultTrack: 'stable',
    availableTracks: ['stable', 'nightly'],
    isTrackManagedByPolicy: false,
    delivery: 'in-app',
    isBelowMinimumVersion: false,
    autoUpdateWhenIdle: false,
  };
  setGlobal('window', window);
  setGlobal('__grokbotAndroidBoot', {
    appVersion: '1.1.0',
    bundleId: 'dev.grokbot.local',
    settings: { theme: 'dark' },
    systemLocale: 'en',
    updateStatus: sampleUpdateStatus,
  });
  setGlobal('document', {
    visibilityState: 'hidden',
    documentElement: { nodeType: 1, classList: { add() {}, toggle() {} }, querySelectorAll: () => [] },
  });
  setGlobal('addEventListener', events.addEventListener.bind(events));
  setGlobal('MutationObserver', class { observe() {} });
  setGlobal('Node', { ELEMENT_NODE: 1 });
  setGlobal('HTMLElement', class {});
  setGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  setGlobal('requestAnimationFrame', () => 0);
  setGlobal('grokbotActivityTime', undefined);
  setGlobal('CSS', { supports: () => true });

  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body });
    if (url === '/events') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }
    if (url === '/local/profile') return Response.json({ displayName: 'Fixture' });
    if (url === '/local/voice/status') return Response.json({ enabled: false });
    if (url === '/local/device') return new Response(null, { status: 204 });
    if (url === '/__native/resume') return Response.json({ ok: true, reconnected: true });
    if (url === '/__native/update-status') return Response.json({ ok: true, status: sampleUpdateStatus });
    if (url === '/__native/update-check') return Response.json({ ok: true, status: { ...sampleUpdateStatus, state: { type: 'checking' } } });
    if (url === '/api/setWindowFocused' || url === '/api/listAgents') return Response.json([]);
    return Response.json({ ok: true });
  });

  await import(pathToFileURL(join(dir, 'bridge.js')).href);

  let focusEvents = 0;
  let latestUpdate = null;
  window.desktop.on('dune-rpc:main:e:window-focus', () => { focusEvents += 1; });
  window.desktop.on('dune-rpc:main:e:update-status', (_ev, status) => { latestUpdate = status; });

  window.__grokbotAndroid.event({ type: 'focus', payload: { focused: true } });
  await new Promise(resolve => setTimeout(resolve, 25));

  assert.ok(focusEvents >= 1, 'focus -> true must emit window-focus catchup event');
  assert.ok(calls.some(c => c.url === '/__native/resume'), 'focus -> true must invoke native resume probe');
  assert.ok(calls.some(c => c.url === '/local/device' && c.body?.includes('"foreground":true')));

  const updateRes = await window.desktop.call('getUpdateStatus');
  assert.equal(updateRes.ok, true);
  assert.equal(updateRes.value.delivery, 'in-app');

  const checkRes = await window.desktop.call('checkForUpdates');
  assert.equal(checkRes.ok, true);
  assert.equal(latestUpdate?.state?.type, 'checking');

  events.dispatchEvent(new Event('pagehide'));
});

test('gateway command failures classify transportKind so renderer transcript resync retries transient failures', async t => {
  const gw = createGateway({ streamIdleTimeoutMs: 0 });
  const { port1, port2 } = new MessageChannel();
  const dispose = gw.attach(port1);
  t.after(() => { dispose(); port2.close(); gw.close(); });

  let mode = '502';
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    if (url === '/events') {
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    if (mode === '502') return Response.json({ error: 'Upstream down' }, { status: 502 });
    if (mode === '408') return Response.json({ error: 'Timeout' }, { status: 408 });
    if (mode === '401') return Response.json({ error: 'Denied' }, { status: 401 });
    if (mode === '400') return Response.json({ error: 'Bad' }, { status: 400 });
    if (mode === 'refused') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (mode === 'dns') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    if (mode === 'network') throw new TypeError('Failed to fetch');
    if (mode === 'badjson') return new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } });
    return Response.json({});
  });

  const pending = new Map();
  port2.onmessage = ({ data }) => {
    if (data.kind === 'reply') pending.get(data.requestId)?.resolve(data.outcome);
  };
  port2.start();
  port2.postMessage({ kind: 'lifecycle', phase: 'hello' });

  let reqId = 0;
  const invoke = async m => {
    mode = m;
    const id = `r-${++reqId}`;
    const p = Promise.withResolvers();
    pending.set(id, p);
    port2.postMessage({ kind: 'request', requestId: id, method: 'getAgentTranscriptTail', args: { id: 'a1' } });
    return p.promise;
  };

  assert.equal((await invoke('502')).failure.transportKind, 'http_5xx');
  assert.equal((await invoke('408')).failure.transportKind, 'timeout');
  assert.equal((await invoke('401')).failure.transportKind, 'access_denied');
  assert.equal((await invoke('400')).failure.transportKind, undefined);
  assert.equal((await invoke('refused')).failure.transportKind, 'refused');
  assert.equal((await invoke('dns')).failure.transportKind, 'dns');
  assert.equal((await invoke('network')).failure.transportKind, 'network');
  const malformed = await invoke('badjson');
  assert.equal(malformed.failure.code, 'gateway-malformed-reply');
  assert.equal(malformed.failure.transportKind, undefined);
});

test('bridge resume awaits native Tailcat recovery before emitting window-focus and handles quitAndInstallUpdate status', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'grokbot-bridge-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'desktop'));
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  for (const name of ['bridge.js', 'native.js', 'services.js', 'gateway.js', 'layout.js', 'webview.js', 'anchor-fallback.js']) {
    await copyFile(new URL(`../client/${name}`, import.meta.url), join(dir, name));
  }
  for (const name of ['i18n.mjs', 'connectors.mjs', 'external-url.mjs', 'dictation.mjs']) {
    await copyFile(new URL(`../../mac/clients/desktop/${name}`, import.meta.url), join(dir, 'desktop', name));
  }
  await writeFile(join(dir, 'official-preload.js'), wrapPreload(`
    const { ipcRenderer: ipc, contextBridge: world } = require('electron');
    const t = () => ({ noArgs: null, args: () => null });
    const declarations = { quitAndInstallUpdate:t().args() };
    world.exposeInMainWorld('desktop', {
      on: (ch, fn) => { ipc.on(ch, fn); return () => ipc.off(ch, fn); },
      call: (method, args) => ipc.invoke('dune-rpc:main:m:' + method, args),
      probe: method => ipc.invoke('dune-rpc:main:probe', method),
    });
  `));

  const restore = [];
  const setGlobal = (key, value) => {
    const prev = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    restore.push(() => { if (prev) Object.defineProperty(globalThis, key, prev); else delete globalThis[key]; });
  };
  t.after(() => { for (const fn of restore.toReversed()) fn(); });

  const window = {};
  const events = new EventTarget();
  setGlobal('window', window);
  setGlobal('__grokbotAndroidBoot', {
    appVersion: '1.2.0',
    bundleId: 'dev.grokbot.local',
    settings: { theme: 'dark' },
    systemLocale: 'en',
  });
  setGlobal('document', {
    visibilityState: 'hidden',
    documentElement: { nodeType: 1, classList: { add() {}, toggle() {} }, querySelectorAll: () => [] },
  });
  setGlobal('addEventListener', events.addEventListener.bind(events));
  setGlobal('MutationObserver', class { observe() {} });
  setGlobal('Node', { ELEMENT_NODE: 1 });
  setGlobal('HTMLElement', class {});
  setGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  setGlobal('requestAnimationFrame', () => 0);
  setGlobal('grokbotActivityTime', undefined);
  setGlobal('CSS', { supports: () => true });

  const timeline = [];
  let installStatus = 'requested';
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (url === '/events') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }
    if (url === '/__native/resume') {
      timeline.push('native-resume-start');
      await new Promise(resolve => setTimeout(resolve, 25));
      timeline.push('native-resume-end');
      return Response.json({ ok: true, reconnected: true });
    }
    if (url === '/api/setWindowFocused') {
      timeline.push('setWindowFocused');
      return Response.json({});
    }
    if (url === '/__native/update-install') return Response.json({ ok: true, status: installStatus });
    if (url === '/local/profile') return Response.json({ displayName: 'Fixture' });
    if (url === '/local/voice/status') return Response.json({ enabled: false });
    if (url === '/local/device') return new Response(null, { status: 204 });
    return Response.json({ ok: true });
  });

  await import(pathToFileURL(join(dir, 'bridge.js')).href);
  window.desktop.on('dune-rpc:main:e:window-focus', () => timeline.push('window-focus'));

  window.__grokbotAndroid.event({ type: 'focus', payload: { focused: true, awayMs: 9000 } });
  await new Promise(resolve => setTimeout(resolve, 60));

  const endIdx = timeline.indexOf('native-resume-end');
  const focusIdx = timeline.indexOf('window-focus');
  assert.ok(endIdx >= 0 && focusIdx > endIdx, `window-focus must fire after native resume completes: ${JSON.stringify(timeline)}`);

  const req = await window.desktop.call('quitAndInstallUpdate', { expectedVersion: '1.2.1' });
  assert.deepEqual(req, { ok: true, value: { status: 'requested' } });
  installStatus = 'superseded';
  const sup = await window.desktop.call('quitAndInstallUpdate', { expectedVersion: '1.2.1' });
  assert.deepEqual(sup, { ok: true, value: { status: 'superseded' } });

  events.dispatchEvent(new Event('pagehide'));
});

test('ECDSA P-256 update manifest signing verifies valid manifests and rejects any tampering or mismatched APK key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'grokbot-release-sign-'));
  try {
    const keyPath = join(dir, 'manifest-key.json');
    const otherKeyPath = join(dir, 'other-manifest-key.json');
    const apkKeyPath = join(dir, 'apk-signing.json');
    const keyInfo = await loadManifestSigningKey(keyPath);
    const otherKey = await loadManifestSigningKey(otherKeyPath);
    assert.equal(keyInfo.created, true);
    if (process.platform !== 'win32') assert.equal((await stat(keyPath)).mode & 0o777, 0o600);

    const apkIdentity = await loadSigningIdentity(apkKeyPath);
    const buildJson = JSON.stringify({
      shell: { versionName: '1.2.0', versionCode: 10200 },
      updateUrl: 'https://updates.example',
      updatePublicKey: keyInfo.publicKeySpkiBase64,
    });
    const shellBytes = await readFile(join(repo, 'android/dist/grokbot-android-shell.apk'));
    const { entries: shellEntries, entryBytes } = await import('../patchers/apk.mjs').then(m => {
      const z = readZip(shellBytes);
      return { entries: z.entries, entryBytes: m.entryBytes };
    });
    const manifestAxEntry = shellEntries.find(e => e.name === 'AndroidManifest.xml');
    const unsigned = writeZip([
      createEntry('AndroidManifest.xml', entryBytes(manifestAxEntry)),
      createEntry('assets/web/client/build.json', Buffer.from(buildJson)),
    ]);
    const signed = signApk(unsigned, apkIdentity);
    const signedPath = join(dir, 'signed.apk');
    await writeFile(signedPath, signed);
    const verifiedApk = verifyApk(signed);
    assert.ok(verifiedApk.raw.equals(apkIdentity.certificate));

    const manifest = signAndroidUpdateManifest({
      track: 'stable',
      packageName: 'dev.grokbot.local',
      versionName: '1.2.0',
      versionCode: 10200,
      sha256: 'a'.repeat(64),
      size: signed.length,
      certificateSha256: 'b'.repeat(64),
      url: 'https://updates.example/GrokBotLocal-1.2.0-android.apk',
      publishedAt: '2026-11-16T12:00:00.000Z',
    }, keyInfo.privateKey);

    assert.equal(canonicalAndroidManifestPayload(manifest).split('\n').length, 10);
    assert.equal(verifyAndroidUpdateManifest(manifest, keyInfo.publicKeySpkiBase64).versionCode, 10200);

    assert.throws(() => verifyAndroidUpdateManifest({ ...manifest, versionCode: 10201 }, keyInfo.publicKeySpkiBase64), /invalid/);
    assert.throws(() => verifyAndroidUpdateManifest({ ...manifest, sha256: 'c'.repeat(64) }, keyInfo.publicKeySpkiBase64), /invalid/);
    assert.throws(() => verifyAndroidUpdateManifest({ ...manifest, url: 'https://evil.example/a.apk' }, keyInfo.publicKeySpkiBase64), /invalid/);

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const runFile = promisify(execFile);
    await assert.rejects(
      runFile(process.execPath, [
        join(repo, 'android/patchers/release-sign.mjs'),
        'publish-android',
        '--apk', signedPath,
        '--out-dir', join(dir, 'out'),
        '--base-url', 'https://updates.example',
        '--manifest-key', otherKeyPath,
      ]),
      /does not match --manifest-key/,
    );
    assert.notEqual(otherKey.publicKeySpkiBase64, keyInfo.publicKeySpkiBase64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('compiled Android ConnectionStore and UnifiedPushReceiver reject timestamp poisoning and mismatched tokens on JVM', async () => {
  const { existsSync } = await import('node:fs');
  const { readdir } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const runFile = promisify(execFile);

  const classesDir = join(repo, 'android/shell/app/build/intermediates/built_in_kotlinc/release/compileReleaseKotlin/classes');
  const androidSdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
  const androidJar = androidSdk ? join(androidSdk, 'platforms/android-36/android.jar') : '';
  const javaHome = process.env.JAVA_HOME || '';
  const gradleHome = process.env.GRADLE_USER_HOME || join(homedir(), '.gradle');

  if (!existsSync(join(classesDir, 'dev/grokbot/local/ConnectionStore.class')) || !androidJar || !existsSync(androidJar)) {
    return; // Requires locally compiled shell classes and Android SDK 36 (run release-shell.mjs first).
  }

  const kotlinCache = join(gradleHome, 'caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib');
  let stdlibJar = '';
  if (existsSync(kotlinCache)) {
    const walk = async dir => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/^kotlin-stdlib-[\d.]+\.jar$/.test(entry.name)) stdlibJar = full;
      }
    };
    await walk(kotlinCache);
  }
  if (!stdlibJar) return;

  const probeDir = join(here, 'native-notifications');
  const javaFiles = [];
  const collectJava = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await collectJava(full);
      else if (entry.name.endsWith('.java')) javaFiles.push(full);
    }
  };
  await collectJava(probeDir);

  const tmpOut = await mkdtemp(join(tmpdir(), 'grokbot-notify-jvm-'));
  try {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const javacBin = javaHome ? join(javaHome, 'bin', `javac${ext}`) : `javac${ext}`;
    const javaBin = javaHome ? join(javaHome, 'bin', `java${ext}`) : `java${ext}`;
    const cp = [tmpOut, classesDir, stdlibJar, androidJar].join(path.delimiter);
    await runFile(javacBin, ['-nowarn', '-cp', cp, '-d', tmpOut, ...javaFiles.sort()]);
    const { stdout } = await runFile(javaBin, ['-cp', cp, 'dev.grokbot.local.NotificationStoreProbe']);
    assert.match(stdout, /PASS compiled ConnectionStore \+ UnifiedPushReceiver \+ PushManager/);
  } finally {
    await rm(tmpOut, { recursive: true, force: true });
  }
});
