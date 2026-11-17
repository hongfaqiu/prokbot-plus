#!/usr/bin/env node
// Release signing and ECDSA P-256 update-manifest helpers for ProkBot Plus.
// Zero external dependencies; can run locally or on a dedicated signing server.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmod, copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  canonicalAndroidDeltasPayload,
  canonicalDesktopDeltasPayload,
  createDeltaBuffer,
  readAsarHeaderInfo,
  sha256File,
} from '../../mac/clients/shared/delta.mjs';
import { certificateFingerprint, entryBytes, readZip, signApk, verifyApk } from './apk.mjs';
import { readShellManifest } from './shell-version.mjs';

const MANIFEST_KEY_SCHEMA = 'grokbot-release-manifest-key/v1';
export const ANDROID_UPDATE_SCHEMA = 'grokbot-android-update/v1';
export const DESKTOP_UPDATE_SCHEMA = 'grokbot-desktop-update/v1';

const exists = async filename => {
  try { await stat(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

export function normalizeEcPublicKey(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new Error('Update public key cannot be empty.');
  const key = trimmed.includes('BEGIN PUBLIC KEY')
    ? createPublicKey(trimmed)
    : createPublicKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Update public key must be an ECDSA P-256 (prime256v1) SPKI key.');
  }
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

export async function loadManifestSigningKey(filename) {
  if (await exists(filename)) {
    const record = JSON.parse(await readFile(filename, 'utf8'));
    if (record.schema !== MANIFEST_KEY_SCHEMA || !record.privateKey || !record.publicKeySpkiBase64) {
      throw new Error(`Invalid manifest signing key file: ${filename}`);
    }
    const privateKey = createPrivateKey(record.privateKey);
    const publicKeySpkiBase64 = normalizeEcPublicKey(record.publicKeySpkiBase64);
    return { created: false, privateKey, publicKeySpkiBase64 };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeySpkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const payload = {
    schema: MANIFEST_KEY_SCHEMA,
    createdAt: new Date().toISOString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeySpkiBase64,
  };
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await chmod(filename, 0o600).catch(() => {});
  return { created: true, privateKey, publicKeySpkiBase64 };
}

export function canonicalAndroidManifestPayload(record) {
  return [
    record.schema,
    record.track,
    record.packageName,
    record.versionName,
    String(record.versionCode),
    String(record.sha256).toLowerCase(),
    String(record.size),
    String(record.certificateSha256).toLowerCase(),
    record.url,
    record.publishedAt,
  ].join('\n');
}

export function signAndroidUpdateManifest(entry, privateKey) {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const record = { schema: ANDROID_UPDATE_SCHEMA, ...entry };
  const canonical = canonicalAndroidManifestPayload(record);
  const signature = sign('sha256', Buffer.from(canonical, 'utf8'), key).toString('base64');
  return { ...record, signature };
}

export function verifyAndroidUpdateManifest(manifest, publicKeySpkiBase64) {
  if (!manifest || manifest.schema !== ANDROID_UPDATE_SCHEMA) throw new Error('Invalid Android update manifest schema');
  const spki = Buffer.from(normalizeEcPublicKey(publicKeySpkiBase64), 'base64');
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const canonical = canonicalAndroidManifestPayload(manifest);
  const ok = verify('sha256', Buffer.from(canonical, 'utf8'), key, Buffer.from(String(manifest.signature || ''), 'base64'));
  if (!ok) throw new Error('Android update manifest signature invalid');
  return manifest;
}

export function canonicalDesktopManifestPayload(record) {
  return [
    record.schema,
    record.platform,
    record.track,
    record.version,
    String(record.sha256).toLowerCase(),
    String(record.size),
    record.url,
    record.publishedAt,
  ].join('\n');
}

export function signDesktopUpdateManifest(entry, privateKey) {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const record = { schema: DESKTOP_UPDATE_SCHEMA, ...entry };
  const canonical = canonicalDesktopManifestPayload(record);
  const signature = sign('sha256', Buffer.from(canonical, 'utf8'), key).toString('base64');
  return { ...record, signature };
}

export function verifyDesktopUpdateManifest(manifest, publicKeySpkiBase64) {
  if (!manifest || manifest.schema !== DESKTOP_UPDATE_SCHEMA) throw new Error('Invalid desktop update manifest schema');
  const spki = Buffer.from(normalizeEcPublicKey(publicKeySpkiBase64), 'base64');
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const canonical = canonicalDesktopManifestPayload(manifest);
  const ok = verify('sha256', Buffer.from(canonical, 'utf8'), key, Buffer.from(String(manifest.signature || ''), 'base64'));
  if (!ok) throw new Error('Desktop update manifest signature invalid');
  return manifest;
}

function signDeltasWith(canonicalFn, manifest, privateKey) {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const canonical = canonicalFn(manifest);
  const deltasSignature = sign('sha256', Buffer.from(canonical, 'utf8'), key).toString('base64');
  return { ...manifest, deltasSignature };
}

function verifyDeltasWith(canonicalFn, manifest, publicKeySpkiBase64, label) {
  if (!manifest || typeof manifest.deltasSignature !== 'string' || !manifest.deltasSignature) {
    throw new Error(`${label} deltasSignature missing`);
  }
  const spki = Buffer.from(normalizeEcPublicKey(publicKeySpkiBase64), 'base64');
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const ok = verify(
    'sha256',
    Buffer.from(canonicalFn(manifest), 'utf8'),
    key,
    Buffer.from(manifest.deltasSignature, 'base64'),
  );
  if (!ok) throw new Error(`${label} deltasSignature invalid`);
  return manifest;
}

export function signAndroidDeltas(manifest, privateKey) {
  return signDeltasWith(canonicalAndroidDeltasPayload, manifest, privateKey);
}

export function verifyAndroidDeltas(manifest, publicKeySpkiBase64) {
  return verifyDeltasWith(canonicalAndroidDeltasPayload, manifest, publicKeySpkiBase64, 'Android');
}

export function signDesktopDeltas(manifest, privateKey) {
  return signDeltasWith(canonicalDesktopDeltasPayload, manifest, privateKey);
}

export function verifyDesktopDeltas(manifest, publicKeySpkiBase64) {
  return verifyDeltasWith(canonicalDesktopDeltasPayload, manifest, publicKeySpkiBase64, 'Desktop');
}

async function writeAtomic(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, bytes);
  await rename(tmp, target);
}

async function cli() {
  const [command, ...rest] = process.argv.slice(2);
  const arg = name => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : null;
  };
  const argsList = name => {
    const out = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === name && rest[i + 1]) out.push(rest[++i]);
    }
    return out;
  };
  const autoScanPrev = async (dir, matcher, excludePath) => {
    const excluded = path.resolve(excludePath);
    const entries = await readdir(dir).catch(() => []);
    return entries
      .filter(matcher)
      .map(name => path.join(dir, name))
      .filter(full => path.resolve(full) !== excluded)
      .sort()
      .slice(-3);
  };
  if (!command || command === '--help' || rest.includes('--help')) {
    console.log(`Usage:
  node android/patchers/release-sign.mjs init-manifest-key --key <path>
  node android/patchers/release-sign.mjs sign-apk --input <unsigned.apk> --output <signed.apk> --signing-key <android-signing.json>
  node android/patchers/release-sign.mjs publish-android --apk <signed.apk> --out-dir <dir> --base-url <https://.../updates> --manifest-key <path> [--track stable] [--notes <text>]
  node android/patchers/release-sign.mjs publish-desktop --file <installer> --platform <win32-x64|darwin-arm64> --version <ver> --out-dir <dir> --base-url <https://.../updates> --manifest-key <path> [--track stable]`);
    return;
  }

  if (command === 'init-manifest-key') {
    const keyPath = path.resolve(arg('--key') ?? '');
    if (!arg('--key')) throw new Error('Missing --key');
    const info = await loadManifestSigningKey(keyPath);
    console.log(JSON.stringify({ keyPath, created: info.created, publicKeySpkiBase64: info.publicKeySpkiBase64 }, null, 2));
    return;
  }

  if (command === 'sign-apk') {
    const input = path.resolve(arg('--input') ?? '');
    const output = path.resolve(arg('--output') ?? '');
    const signingPath = path.resolve(arg('--signing-key') ?? '');
    if (!arg('--input') || !arg('--output') || !arg('--signing-key')) throw new Error('Missing --input, --output or --signing-key');
    const record = JSON.parse(await readFile(signingPath, 'utf8'));
    if (record.schema !== 'grokbot-android-signing/v1') throw new Error(`Invalid Android signing key schema: ${signingPath}`);
    const unsignedBytes = await readFile(input);
    const identity = { privateKey: createPrivateKey(record.privateKey), certificate: Buffer.from(record.certificate, 'base64') };
    const signedBytes = signApk(unsignedBytes, identity);
    const verified = verifyApk(signedBytes);
    const manifest = readShellManifest(readZip(signedBytes).entries);
    await writeAtomic(output, signedBytes);
    console.log(JSON.stringify({
      output,
      manifest,
      apkSha256: sha256Hex(signedBytes),
      bytes: signedBytes.length,
      certificateSha256: certificateFingerprint(identity.certificate),
      subject: verified.subject.replace(/\n/g, ', '),
    }, null, 2));
    return;
  }

  const writeFileDelta = async ({ prevPath, targetBytes, targetSha, prefix, deltasDir, baseUrl }) => {
    const prevBytes = await readFile(prevPath);
    const prevSha = sha256Hex(prevBytes);
    if (prevSha === targetSha) return null;
    const deltaBytes = createDeltaBuffer(prevBytes, targetBytes);
    if (deltaBytes.length >= targetBytes.length) return null;
    const deltaSha = sha256Hex(deltaBytes);
    const deltaName = `${prefix}-${prevSha.slice(0, 12)}-to-${targetSha.slice(0, 12)}.gbdelta`;
    await writeAtomic(path.join(deltasDir, deltaName), deltaBytes);
    return {
      baseSha256: prevSha,
      baseSize: prevBytes.length,
      sha256: deltaSha,
      size: deltaBytes.length,
      url: `${baseUrl}/deltas/${deltaName}`,
    };
  };

  if (command === 'publish-android') {
    const apkPath = path.resolve(arg('--apk') ?? '');
    const outDir = path.resolve(arg('--out-dir') ?? '');
    const baseUrl = String(arg('--base-url') ?? '').replace(/\/+$/, '');
    const manifestKeyPath = path.resolve(arg('--manifest-key') ?? '');
    const track = arg('--track') ?? 'stable';
    const notes = arg('--notes') ?? '';
    if (!arg('--apk') || !arg('--out-dir') || !baseUrl || !arg('--manifest-key')) {
      throw new Error('Missing --apk, --out-dir, --base-url or --manifest-key');
    }
    if (!['stable', 'nightly', 'dogfood'].includes(track)) throw new Error(`Invalid track: ${track}`);
    const apkBytes = await readFile(apkPath);
    const verified = verifyApk(apkBytes);
    const { entries } = readZip(apkBytes);
    const manifest = readShellManifest(entries);
    const buildEntry = entries.find(e => e.name === 'assets/web/client/build.json');
    const buildRecord = buildEntry ? JSON.parse(entryBytes(buildEntry).toString('utf8')) : {};
    const filename = `GrokBotLocal-${manifest.versionName}-android.apk`;
    const destApk = path.join(outDir, filename);
    await mkdir(outDir, { recursive: true });
    const prevApks = argsList('--prev-apk').map(p => path.resolve(p));
    const baseApks = prevApks.length > 0
      ? prevApks
      : await autoScanPrev(outDir, n => /^GrokBotLocal-.*-android\.apk$/i.test(n), destApk);
    if (path.resolve(apkPath) !== destApk) await copyFile(apkPath, destApk);

    const keyInfo = await loadManifestSigningKey(manifestKeyPath);
    if (typeof buildRecord.updatePublicKey === 'string' && buildRecord.updatePublicKey.trim()) {
      const embeddedPubKey = normalizeEcPublicKey(buildRecord.updatePublicKey);
      if (embeddedPubKey !== keyInfo.publicKeySpkiBase64) {
        throw new Error('APK embedded updatePublicKey does not match --manifest-key');
      }
    }
    const targetSha = sha256Hex(apkBytes);
    const certificateSha256 = sha256Hex(verified.raw).toLowerCase();
    const publishedAt = new Date().toISOString();
    const feedName = track === 'stable' ? 'android.json' : `android-${track}.json`;
    const deltasDir = path.join(outDir, 'deltas');
    const deltas = [];
    for (const prevPath of baseApks) {
      const entry = await writeFileDelta({
        prevPath,
        targetBytes: apkBytes,
        targetSha,
        prefix: `android-${manifest.versionName}`,
        deltasDir,
        baseUrl,
      }).catch(() => null);
      if (entry) deltas.push(entry);
    }
    let signedManifest = signAndroidUpdateManifest({
      track,
      packageName: manifest.packageName,
      versionName: manifest.versionName,
      versionCode: manifest.versionCode,
      rendererVersion: buildRecord.rendererVersion ?? '',
      sha256: targetSha,
      size: apkBytes.length,
      certificateSha256,
      url: `${baseUrl}/${filename}`,
      publishedAt,
      ...(notes ? { notes } : {}),
    }, keyInfo.privateKey);
    if (deltas.length > 0) {
      signedManifest = signAndroidDeltas({ ...signedManifest, deltas }, keyInfo.privateKey);
      verifyAndroidDeltas(signedManifest, keyInfo.publicKeySpkiBase64);
    }
    verifyAndroidUpdateManifest(signedManifest, keyInfo.publicKeySpkiBase64);
    await writeAtomic(path.join(outDir, feedName), JSON.stringify(signedManifest, null, 2) + '\n');
    console.log(JSON.stringify({ published: true, feed: feedName, apk: destApk, manifest: signedManifest, publicKeySpkiBase64: keyInfo.publicKeySpkiBase64 }, null, 2));
    return;
  }

  if (command === 'publish-desktop') {
    const filePath = path.resolve(arg('--file') ?? '');
    const platform = arg('--platform') ?? '';
    const version = arg('--version') ?? '';
    const outDir = path.resolve(arg('--out-dir') ?? '');
    const baseUrl = String(arg('--base-url') ?? '').replace(/\/+$/, '');
    const manifestKeyPath = path.resolve(arg('--manifest-key') ?? '');
    const track = arg('--track') ?? 'stable';
    if (!arg('--file') || !platform || !version || !arg('--out-dir') || !baseUrl || !arg('--manifest-key')) {
      throw new Error('Missing --file, --platform, --version, --out-dir, --base-url or --manifest-key');
    }
    if (!['win32-x64', 'darwin-arm64', 'darwin-x64'].includes(platform)) throw new Error(`Invalid platform: ${platform}`);
    if (!['stable', 'nightly', 'dogfood'].includes(track)) throw new Error(`Invalid track: ${track}`);
    const bytes = await readFile(filePath);
    const filename = path.basename(filePath);
    const destFile = path.join(outDir, filename);
    await mkdir(outDir, { recursive: true });
    const prevFiles = argsList('--prev-file').map(p => path.resolve(p));
    const extRe = platform.startsWith('win32') ? /-x64-Setup\.exe$/i : /-arm64\.dmg$/i;
    const baseFiles = prevFiles.length > 0
      ? prevFiles
      : await autoScanPrev(outDir, n => n.startsWith('GrokBotLocal-') && extRe.test(n), destFile);
    if (path.resolve(filePath) !== destFile) await copyFile(filePath, destFile);
    const keyInfo = await loadManifestSigningKey(manifestKeyPath);
    const feedName = track === 'stable' ? `${platform}.json` : `${platform}-${track}.json`;
    const targetSha = sha256Hex(bytes);
    const deltasDir = path.join(outDir, 'deltas');
    const deltas = [];
    for (const prevPath of baseFiles) {
      const entry = await writeFileDelta({
        prevPath,
        targetBytes: bytes,
        targetSha,
        prefix: `${platform}-${version}`,
        deltasDir,
        baseUrl,
      }).catch(() => null);
      if (entry) deltas.push(entry);
    }
    const asarDeltas = [];
    const targetAsarPath = arg('--asar') ? path.resolve(arg('--asar')) : '';
    const prevAsars = argsList('--prev-asar').map(p => path.resolve(p));
    if (targetAsarPath && prevAsars.length > 0) {
      const targetAsarBytes = await readFile(targetAsarPath);
      const targetAsarSha = await sha256File(targetAsarPath);
      const targetAsarHeader = await readAsarHeaderInfo(targetAsarPath);
      for (const prevAsarPath of prevAsars) {
        const prevAsarBytes = await readFile(prevAsarPath);
        const prevAsarSha = sha256Hex(prevAsarBytes);
        if (prevAsarSha === targetAsarSha) continue;
        const deltaBytes = createDeltaBuffer(prevAsarBytes, targetAsarBytes);
        if (deltaBytes.length >= targetAsarBytes.length) continue;
        const prevHeader = await readAsarHeaderInfo(prevAsarPath);
        const deltaName = `${platform}-asar-${prevAsarSha.slice(0, 12)}-to-${targetAsarSha.slice(0, 12)}.gbdelta`;
        await writeAtomic(path.join(deltasDir, deltaName), deltaBytes);
        asarDeltas.push({
          baseSha256: prevAsarSha,
          baseSize: prevAsarBytes.length,
          baseHeaderSha256: prevHeader.headerSha256,
          targetSha256: targetAsarSha,
          targetSize: targetAsarBytes.length,
          targetHeaderSha256: targetAsarHeader.headerSha256,
          sha256: sha256Hex(deltaBytes),
          size: deltaBytes.length,
          url: `${baseUrl}/deltas/${deltaName}`,
        });
      }
    }
    let signedManifest = signDesktopUpdateManifest({
      platform,
      track,
      version,
      sha256: targetSha,
      size: bytes.length,
      url: `${baseUrl}/${filename}`,
      publishedAt: new Date().toISOString(),
    }, keyInfo.privateKey);
    if (deltas.length > 0 || asarDeltas.length > 0) {
      signedManifest = signDesktopDeltas({
        ...signedManifest,
        ...(deltas.length > 0 ? { deltas } : {}),
        ...(asarDeltas.length > 0 ? { asarDeltas } : {}),
      }, keyInfo.privateKey);
      verifyDesktopDeltas(signedManifest, keyInfo.publicKeySpkiBase64);
    }
    verifyDesktopUpdateManifest(signedManifest, keyInfo.publicKeySpkiBase64);
    await writeAtomic(path.join(outDir, feedName), JSON.stringify(signedManifest, null, 2) + '\n');
    console.log(JSON.stringify({ published: true, feed: feedName, file: destFile, manifest: signedManifest, publicKeySpkiBase64: keyInfo.publicKeySpkiBase64 }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(error => { console.error(error.message); process.exitCode = 1; });
}
