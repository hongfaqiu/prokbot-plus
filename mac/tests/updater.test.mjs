import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadManifestSigningKey, signDesktopUpdateManifest } from '../../android/patchers/release-sign.mjs';
import { createDesktopUpdater } from '../clients/desktop/updater.mjs';

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
