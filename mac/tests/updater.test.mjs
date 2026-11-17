import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadManifestSigningKey, signDesktopDeltas, signDesktopUpdateManifest } from '../../android/patchers/release-sign.mjs';
import { createDeltaBuffer } from '../clients/shared/delta.mjs';
import { replaceWindowsAsarIntegrityHex } from '../clients/desktop/asar-install.mjs';
import { createDesktopUpdater, createTailcatUpdateFetch } from '../clients/desktop/updater.mjs';

test('desktop updater stays disabled without manifest config', async () => {
  const updater = createDesktopUpdater({ appVersion: '0.71.2', profileDir: os.tmpdir(), config: null });
  assert.equal(updater.status().state.type, 'disabled');
  assert.equal(updater.status().delivery, 'package-manager');
  assert.equal((await updater.check()).state.type, 'disabled');
});

test('desktop updater verifies signature, downloads artifact, verifies checksum, and stages ready update', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grokbot-desktop-updater-'));
  try {
    const key = await loadManifestSigningKey(path.join(dir, 'manifest.json'));
    const installerBytes = Buffer.from('fake-desktop-installer-payload-0.72.0');
    const sha256 = createHash('sha256').update(installerBytes).digest('hex');

    const manifest = signDesktopUpdateManifest({
      platform: 'win32-x64',
      track: 'stable',
      version: '0.72.0',
      sha256,
      size: installerBytes.length,
      url: 'https://updates.example/GrokBotLocal-0.72.0-x64-Setup.exe',
      publishedAt: '2026-11-16T12:00:00.000Z',
    }, key.privateKey);

    let corruptBody = false;
    const states = [];
    const installed = [];
    const updater = createDesktopUpdater({
      appVersion: '0.71.2',
      platformId: 'win32-x64',
      profileDir: dir,
      config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
      onStatus: s => states.push(s.state.type),
      onInstallFile: async (file, version) => installed.push({ bytes: (await readFile(file)).length, version }),
      fetchImpl: async url => {
        if (url.includes('/win32-x64.json')) return new Response(JSON.stringify(manifest), { status: 200 });
        return new Response(corruptBody ? Buffer.from('tampered') : installerBytes, {
          status: 200,
          headers: { 'content-length': String(installerBytes.length) },
        });
      },
    });

    corruptBody = true;
    const failed = await updater.check();
    assert.equal(failed.state.type, 'idle');
    assert.equal(failed.state.lastCheck.result, 'error');
    assert.equal(failed.state.lastCheck.failure.kind, 'installer_signature_invalid');

    corruptBody = false;
    const ready = await updater.check();
    assert.equal(ready.state.type, 'ready');
    assert.equal(ready.state.version, '0.72.0');
    assert.ok(states.includes('checking'));
    assert.ok(states.includes('staging'));

    const installRes = await updater.quitAndInstall({ expectedVersion: '0.72.0' });
    assert.deepEqual(installRes, { status: 'requested' });
    assert.deepEqual(installed, [{ bytes: installerBytes.length, version: '0.72.0' }]);

    const supersededRes = await updater.quitAndInstall({ expectedVersion: '0.71.9' });
    assert.deepEqual(supersededRes, { status: 'superseded' });

    updater.setTrack({ track: 'nightly' });
    updater.setAutoUpdateWhenIdle({ enabled: true });
    await new Promise(resolve => setTimeout(resolve, 15));
    const reloaded = createDesktopUpdater({
      appVersion: '0.71.2',
      platformId: 'win32-x64',
      profileDir: dir,
      config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
    });
    assert.equal(reloaded.status().currentTrack, 'nightly');
    assert.equal(reloaded.status().autoUpdateWhenIdle, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('desktop updater discards in-flight check result if setTrack switches track concurrently', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grokbot-desktop-track-race-'));
  try {
    const key = await loadManifestSigningKey(path.join(dir, 'manifest.json'));
    const installerBytes = Buffer.from('stable-payload');
    const manifest = signDesktopUpdateManifest({
      platform: 'win32-x64',
      track: 'stable',
      version: '0.72.0',
      sha256: createHash('sha256').update(installerBytes).digest('hex'),
      size: installerBytes.length,
      url: 'https://updates.example/GrokBotLocal-0.72.0-x64-Setup.exe',
      publishedAt: '2026-11-16T12:00:00.000Z',
    }, key.privateKey);
    const gate = Promise.withResolvers();
    const updater = createDesktopUpdater({
      appVersion: '0.71.2',
      platformId: 'win32-x64',
      profileDir: dir,
      config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
      fetchImpl: async url => {
        if (url.includes('/win32-x64.json')) {
          await gate.promise;
          return new Response(JSON.stringify(manifest), { status: 200 });
        }
        return new Response(installerBytes, { status: 200 });
      },
    });
    const inFlight = updater.check();
    updater.setTrack({ track: 'nightly' });
    gate.resolve();
    const settled = await inFlight;
    assert.equal(settled.currentTrack, 'nightly');
    assert.equal(updater.status().state.type, 'idle');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function buildSyntheticAsar(headerObj, payloadText) {
  const json = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const pickleSize = 4 + 4 + json.length;
  const alignedSize = Math.ceil(pickleSize / 4) * 4;
  const buf = Buffer.alloc(8 + alignedSize + Buffer.byteLength(payloadText));
  buf.writeUInt32LE(4, 0);
  buf.writeUInt32LE(alignedSize, 4);
  buf.writeUInt32LE(pickleSize, 8);
  buf.writeInt32LE(json.length, 12);
  json.copy(buf, 16);
  buf.write(payloadText, 8 + alignedSize, 'utf8');
  return {
    bytes: buf,
    headerSha256: createHash('sha256').update(json).digest('hex'),
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}

test('desktop updater stages installer binary delta without downloading full installer, and falls back if tampered', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grokbot-desktop-delta-'));
  try {
    const key = await loadManifestSigningKey(path.join(dir, 'manifest.json'));
    const sharedTail = Buffer.alloc(128 * 1024, 0x41);
    const oldInstaller = Buffer.concat([Buffer.from('OLD-HDR-0.71.2-'), sharedTail, Buffer.from('-END')]);
    const newInstaller = Buffer.concat([Buffer.from('NEW-HDR-0.72.0-'), sharedTail, Buffer.from('-PATCHED')]);
    const deltaBytes = createDeltaBuffer(oldInstaller, newInstaller);
    assert.ok(deltaBytes.length < 4096, `expected tiny delta, got ${deltaBytes.length}`);

    const updatesDir = path.join(dir, 'updates');
    await mkdir(updatesDir, { recursive: true });
    await writeFile(path.join(updatesDir, 'ready-stable-0.71.2.exe'), oldInstaller);

    const signed = signDesktopDeltas(
      signDesktopUpdateManifest({
        platform: 'win32-x64',
        track: 'stable',
        version: '0.72.0',
        sha256: createHash('sha256').update(newInstaller).digest('hex'),
        size: newInstaller.length,
        url: 'https://updates.example/GrokBotLocal-0.72.0-x64-Setup.exe',
        publishedAt: '2026-11-16T12:00:00.000Z',
      }, key.privateKey)
        ? {
            ...signDesktopUpdateManifest({
              platform: 'win32-x64',
              track: 'stable',
              version: '0.72.0',
              sha256: createHash('sha256').update(newInstaller).digest('hex'),
              size: newInstaller.length,
              url: 'https://updates.example/GrokBotLocal-0.72.0-x64-Setup.exe',
              publishedAt: '2026-11-16T12:00:00.000Z',
            }, key.privateKey),
            deltas: [{
              baseSha256: createHash('sha256').update(oldInstaller).digest('hex'),
              baseSize: oldInstaller.length,
              sha256: createHash('sha256').update(deltaBytes).digest('hex'),
              size: deltaBytes.length,
              url: 'https://updates.example/deltas/0720.gbdelta',
            }],
          }
        : {},
      key.privateKey,
    );

    const fetched = [];
    const installed = [];
    const updater = createDesktopUpdater({
      appVersion: '0.71.2',
      platformId: 'win32-x64',
      profileDir: dir,
      config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
      onInstallFile: async (file, ver) => installed.push({ bytes: await readFile(file), ver }),
      fetchImpl: async url => {
        fetched.push(url);
        if (url.includes('/win32-x64.json')) return new Response(JSON.stringify(signed), { status: 200 });
        if (url.includes('0720.gbdelta')) return new Response(deltaBytes, { status: 200, headers: { 'content-length': String(deltaBytes.length) } });
        return new Response(newInstaller, { status: 200, headers: { 'content-length': String(newInstaller.length) } });
      },
    });

    const ready = await updater.check();
    assert.equal(ready.state.type, 'ready');
    assert.equal(fetched.some(u => u.includes('0720.gbdelta')), true);
    assert.equal(fetched.some(u => u.includes('Setup.exe')), false);
    await updater.quitAndInstall({ expectedVersion: '0.72.0' });
    assert.equal(installed.length, 1);
    assert.ok(installed[0].bytes.equals(newInstaller));

    // If delta signature is tampered, updater safely falls back to full installer download.
    const profile2 = await mkdtemp(path.join(os.tmpdir(), 'grokbot-desktop-fallback-'));
    try {
      await mkdir(path.join(profile2, 'updates'), { recursive: true });
      await writeFile(path.join(profile2, 'updates', 'base-stable.exe'), oldInstaller);
      const tamperedSigned = { ...signed, deltasSignature: 'AAAA' };
      const fetched2 = [];
      const updater2 = createDesktopUpdater({
        appVersion: '0.71.2',
        platformId: 'win32-x64',
        profileDir: profile2,
        config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
        fetchImpl: async url => {
          fetched2.push(url);
          if (url.includes('/win32-x64.json')) return new Response(JSON.stringify(tamperedSigned), { status: 200 });
          if (url.includes('0720.gbdelta')) throw new Error('should not download delta with bad deltasSignature');
          return new Response(newInstaller, { status: 200, headers: { 'content-length': String(newInstaller.length) } });
        },
      });
      const fallbackReady = await updater2.check();
      assert.equal(fallbackReady.state.type, 'ready');
      assert.equal(fetched2.some(u => u.includes('Setup.exe')), true);
    } finally {
      await rm(profile2, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('desktop updater stages ASAR incremental delta and passes header hashes to onInstallAsar', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grokbot-desktop-asar-delta-'));
  try {
    const key = await loadManifestSigningKey(path.join(dir, 'manifest.json'));
    const resDir = path.join(dir, 'resources');
    const profileDir = path.join(dir, 'profile');
    await mkdir(resDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const oldAsar = buildSyntheticAsar({ files: { 'a.js': { size: 1000, offset: '0' } } }, 'A'.repeat(40000));
    const newAsar = buildSyntheticAsar({ files: { 'a.js': { size: 1000, offset: '0' }, 'b.js': { size: 5, offset: '40000' } } }, 'A'.repeat(40000) + 'hello');
    await writeFile(path.join(resDir, 'app.asar'), oldAsar.bytes);
    const asarDelta = createDeltaBuffer(oldAsar.bytes, newAsar.bytes);
    const fullInstaller = Buffer.from('full-installer-fallback');

    const baseManifest = signDesktopUpdateManifest({
      platform: 'darwin-arm64',
      track: 'stable',
      version: '0.72.0',
      sha256: createHash('sha256').update(fullInstaller).digest('hex'),
      size: fullInstaller.length,
      url: 'https://updates.example/GrokBotLocal-0.72.0-arm64.dmg',
      publishedAt: '2026-11-16T12:00:00.000Z',
    }, key.privateKey);
    const signed = signDesktopDeltas({
      ...baseManifest,
      asarDeltas: [{
        baseSha256: oldAsar.sha256,
        baseSize: oldAsar.bytes.length,
        baseHeaderSha256: oldAsar.headerSha256,
        targetSha256: newAsar.sha256,
        targetSize: newAsar.bytes.length,
        targetHeaderSha256: newAsar.headerSha256,
        sha256: createHash('sha256').update(asarDelta).digest('hex'),
        size: asarDelta.length,
        url: 'https://updates.example/deltas/mac-asar.gbdelta',
      }],
    }, key.privateKey);

    const asarInstalls = [];
    const fetched = [];
    const updater = createDesktopUpdater({
      appVersion: '0.71.2',
      platformId: 'darwin-arm64',
      profileDir,
      resourcesDir: resDir,
      execPath: path.join(dir, 'Grok Bot'),
      config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
      canUseAsarUpdate: async () => true,
      onInstallAsar: async info => asarInstalls.push(info),
      fetchImpl: async url => {
        fetched.push(url);
        if (url.includes('/darwin-arm64.json')) return new Response(JSON.stringify(signed), { status: 200 });
        if (url.includes('mac-asar.gbdelta')) return new Response(asarDelta, { status: 200 });
        return new Response(fullInstaller, { status: 200 });
      },
    });

    const ready = await updater.check();
    assert.equal(ready.state.type, 'ready');
    assert.equal(fetched.some(u => u.includes('mac-asar.gbdelta')), true);
    assert.equal(fetched.some(u => u.includes('.dmg')), false);
    await updater.quitAndInstall({ expectedVersion: '0.72.0' });
    assert.equal(asarInstalls.length, 1);
    assert.equal(asarInstalls[0].headerSha256, newAsar.headerSha256);
    assert.equal(asarInstalls[0].baseHeaderSha256, oldAsar.headerSha256);
    assert.ok((await readFile(asarInstalls[0].asarFile)).equals(newAsar.bytes));

    // Also verify Windows PE integrity record replacement helper.
    const oldHash = '0'.repeat(64);
    const newHash = 'f'.repeat(64);
    const fakeExe = Buffer.from(`MZ...[{"file":"resources\\\\app.asar","alg":"SHA256","value":"${oldHash}"}]...`, 'latin1');
    const patchedExe = replaceWindowsAsarIntegrityHex(fakeExe, oldHash, newHash);
    assert.equal(patchedExe.toString('latin1').includes(newHash), true);
    assert.equal(patchedExe.length, fakeExe.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createTailcatUpdateFetch routes manifest and installer downloads through Host /local/updates/fetch and falls back when older Host returns 404', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grokbot-tailcat-updater-'));
  try {
    const key = await loadManifestSigningKey(path.join(dir, 'manifest.json'));
    const installerBytes = Buffer.from('tailcat-tunneled-installer-0.72.0');
    const manifest = signDesktopUpdateManifest({
      platform: 'win32-x64',
      track: 'stable',
      version: '0.72.0',
      sha256: createHash('sha256').update(installerBytes).digest('hex'),
      size: installerBytes.length,
      url: 'https://updates.example/GrokBotLocal-0.72.0-x64-Setup.exe',
      publishedAt: '2026-11-16T12:00:00.000Z',
    }, key.privateKey);

    const calls = [];
    const proxiedFetch = createTailcatUpdateFetch({
      isTunneled: () => true,
      getServerUrl: () => 'http://127.0.0.1:41234',
      getToken: () => 'tailcat-device-token',
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers ?? {});
        calls.push({ url, auth: headers.get('authorization') });
        if (url.startsWith('http://127.0.0.1:41234/local/updates/fetch?')) {
          const inner = decodeURIComponent(new URL(url).searchParams.get('url'));
          assert.equal(headers.get('authorization'), 'Bearer tailcat-device-token');
          if (inner.includes('/win32-x64.json')) return new Response(JSON.stringify(manifest), { status: 200 });
          if (inner.includes('Setup.exe')) return new Response(installerBytes, { status: 200, headers: { 'content-length': String(installerBytes.length) } });
        }
        throw new Error(`unexpected direct fetch: ${url}`);
      },
    });

    const updater = createDesktopUpdater({
      appVersion: '0.71.2',
      platformId: 'win32-x64',
      profileDir: dir,
      config: { updateUrl: 'https://updates.example', updatePublicKey: key.publicKeySpkiBase64 },
      fetchImpl: proxiedFetch,
    });

    const ready = await updater.check();
    assert.equal(ready.state.type, 'ready');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(c => c.url.startsWith('http://127.0.0.1:41234/local/updates/fetch?')));

    // Older Host returning 404 on /local/updates/fetch falls back to direct URL cleanly.
    const fallbackCalls = [];
    const fallbackFetch = createTailcatUpdateFetch({
      isTunneled: () => true,
      getServerUrl: () => 'http://127.0.0.1:41234',
      getToken: () => 'tailcat-device-token',
      fetchImpl: async url => {
        fallbackCalls.push(url);
        if (url.startsWith('http://127.0.0.1:41234/')) return new Response('not found', { status: 404 });
        return new Response('direct-ok', { status: 200 });
      },
    });
    const directRes = await fallbackFetch('https://updates.example/win32-x64.json');
    assert.equal(directRes.status, 200);
    assert.equal(await directRes.text(), 'direct-ok');
    assert.equal(fallbackCalls.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
