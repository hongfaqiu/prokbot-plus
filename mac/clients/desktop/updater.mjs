import { createHash, createPublicKey, verify } from 'node:crypto';
import { constants, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { access, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyDeltaFile,
  canonicalDesktopDeltasPayload,
  readAsarHeaderInfo,
  sha256File,
} from '../shared/delta.mjs';

export const DESKTOP_UPDATE_SCHEMA = 'grokbot-desktop-update/v1';

export function createTailcatUpdateFetch({
  isTunneled = () => false,
  getServerUrl = () => '',
  getToken = () => '',
  fetchImpl = fetch,
} = {}) {
  return async (targetUrl, init = {}) => {
    const serverUrl = isTunneled() ? String(getServerUrl() ?? '').trim().replace(/\/+$/, '') : '';
    const token = isTunneled() ? String(getToken() ?? '').trim() : '';
    if (!serverUrl || !token) {
      return fetchImpl(targetUrl, init);
    }
    const proxyUrl = `${serverUrl}/local/updates/fetch?url=${encodeURIComponent(targetUrl)}`;
    const headers = new Headers(init.headers ?? {});
    headers.set('authorization', `Bearer ${token}`);
    try {
      const res = await fetchImpl(proxyUrl, { ...init, headers });
      if ([404, 405, 501].includes(res.status)) {
        await res.body?.cancel?.().catch(() => {});
        return fetchImpl(targetUrl, init);
      }
      return res;
    } catch (err) {
      if (init.signal?.aborted) throw err;
      return fetchImpl(targetUrl, init);
    }
  };
}

const SHA_HEX_RE = /^[a-f0-9]{64}$/i;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;

export function normalizeEcPublicKey(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new Error('Empty update public key');
  const key = trimmed.includes('BEGIN PUBLIC KEY')
    ? createPublicKey(trimmed)
    : createPublicKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Update public key must be ECDSA P-256 (prime256v1)');
  }
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

export function validUpdateUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed;
  try { parsed = new URL(raw.trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  if (parsed.protocol === 'http:' && parsed.hostname !== '127.0.0.1') return null;
  return parsed.href.replace(/\/+$/, '');
}

export function canonicalDesktopPayload(record) {
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

export function verifyDesktopManifest(manifest, publicKeySpkiBase64) {
  if (!manifest || manifest.schema !== DESKTOP_UPDATE_SCHEMA) throw new Error('Malformed desktop update feed');
  const key = createPublicKey({ key: Buffer.from(normalizeEcPublicKey(publicKeySpkiBase64), 'base64'), format: 'der', type: 'spki' });
  const ok = verify(
    'sha256',
    Buffer.from(canonicalDesktopPayload(manifest), 'utf8'),
    key,
    Buffer.from(String(manifest.signature || ''), 'base64'),
  );
  if (!ok) throw new Error('Invalid desktop manifest signature');
  return manifest;
}

export function verifyDesktopDeltasManifest(manifest, publicKeySpkiBase64) {
  verifyDesktopManifest(manifest, publicKeySpkiBase64);
  if (typeof manifest.deltasSignature !== 'string' || !manifest.deltasSignature) {
    throw new Error('Missing desktop delta signature');
  }
  const key = createPublicKey({ key: Buffer.from(normalizeEcPublicKey(publicKeySpkiBase64), 'base64'), format: 'der', type: 'spki' });
  const ok = verify(
    'sha256',
    Buffer.from(canonicalDesktopDeltasPayload(manifest), 'utf8'),
    key,
    Buffer.from(manifest.deltasSignature, 'base64'),
  );
  if (!ok) throw new Error('Invalid desktop delta signature');

  for (const d of manifest.deltas ?? []) {
    if (!d || !SHA_HEX_RE.test(String(d.baseSha256 || '')) || !Number.isSafeInteger(d.baseSize) || d.baseSize <= 0 ||
        !SHA_HEX_RE.test(String(d.sha256 || '')) || !Number.isSafeInteger(d.size) || d.size <= 0 || !validUpdateUrl(d.url)) {
      throw new Error('Malformed installer delta record');
    }
  }
  for (const a of manifest.asarDeltas ?? []) {
    if (!a || !SHA_HEX_RE.test(String(a.baseSha256 || '')) || !Number.isSafeInteger(a.baseSize) || a.baseSize <= 0 ||
        !SHA_HEX_RE.test(String(a.targetSha256 || '')) || !Number.isSafeInteger(a.targetSize) || a.targetSize <= 0 ||
        !SHA_HEX_RE.test(String(a.targetHeaderSha256 || '')) ||
        !SHA_HEX_RE.test(String(a.sha256 || '')) || !Number.isSafeInteger(a.size) || a.size <= 0 || !validUpdateUrl(a.url)) {
      throw new Error('Malformed ASAR delta record');
    }
  }
  return true;
}

export function compareVersions(a, b) {
  const pa = String(a ?? '').split('.').map(n => Number.parseInt(n, 10) || 0);
  const pb = String(b ?? '').split('.').map(n => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0, db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

export async function loadDesktopUpdateConfig({ resourcesDir, profileDir } = {}) {
  for (const candidate of [
    resourcesDir && path.join(resourcesDir, 'grokbot-local-update.json'),
    resourcesDir && path.join(resourcesDir, 'grokbot-local.patch.json'),
    profileDir && path.join(profileDir, 'grokbot-local-update.json'),
  ].filter(Boolean)) {
    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf8'));
      const updateUrl = validUpdateUrl(parsed.updateUrl);
      if (updateUrl && parsed.updatePublicKey) {
        return {
          updateUrl,
          updatePublicKey: normalizeEcPublicKey(parsed.updatePublicKey),
          builtAt: typeof parsed.patchedAt === 'string' ? parsed.patchedAt : typeof parsed.builtAt === 'string' ? parsed.builtAt : undefined,
        };
      }
    } catch {}
  }
  return null;
}

async function downloadVerifiedFile({
  fetchImpl,
  url,
  expectedSize,
  expectedSha256,
  tmpFile,
  isCurrentGen,
  onProgress,
}) {
  const dl = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(300000) });
  if (!dl.ok || !dl.body) throw Object.assign(new Error(`Download HTTP ${dl.status}`), { kind: 'update_failed' });
  const total = Number(dl.headers.get('content-length')) || expectedSize;
  await rm(tmpFile, { force: true });
  const handle = await open(tmpFile, 'w');
  const hash = createHash('sha256');
  let received = 0;
  let lastReport = 0;
  try {
    for await (const chunk of dl.body) {
      if (!isCurrentGen()) throw new Error('Track changed');
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > MAX_INSTALLER_BYTES) throw new Error('Artifact too large');
      hash.update(buf);
      let off = 0;
      while (off < buf.length) {
        const { bytesWritten } = await handle.write(buf, off, buf.length - off);
        if (bytesWritten <= 0) throw new Error('Short write downloading update');
        off += bytesWritten;
      }
      const now = Date.now();
      if (now - lastReport >= 250) {
        lastReport = now;
        onProgress(Math.min(1, received / total));
      }
    }
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => {});
    await rm(tmpFile, { force: true }).catch(() => {});
    throw Object.assign(err, { kind: err.kind ?? 'update_failed' });
  }
  if (!isCurrentGen()) {
    await rm(tmpFile, { force: true }).catch(() => {});
    return false;
  }
  const actualSha = hash.digest('hex');
  if (received !== expectedSize || actualSha !== expectedSha256.toLowerCase()) {
    await rm(tmpFile, { force: true });
    throw Object.assign(new Error('Downloaded update checksum mismatch'), { kind: 'installer_signature_invalid' });
  }
  return true;
}

async function findMatchingBaseInstaller(updatesDir, deltas) {
  const entries = await readdir(updatesDir).catch(() => []);
  const sizeMatches = new Map();
  for (const name of entries) {
    if (!name.startsWith('ready-') && !name.startsWith('base-')) continue;
    if (name.endsWith('.json') || name.includes('.tmp-')) continue;
    const full = path.join(updatesDir, name);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) continue;
    for (const d of deltas) {
      if (d.baseSize === info.size) {
        sizeMatches.set(full, d);
        break;
      }
    }
  }
  for (const [full] of sizeMatches) {
    const sha = await sha256File(full).catch(() => '');
    const matched = deltas.find(d => d.baseSha256.toLowerCase() === sha);
    if (matched) return { baseFile: full, delta: matched };
  }
  return null;
}

async function pruneOldInstallers(updatesDir, keepFile, track, ext) {
  const entries = await readdir(updatesDir).catch(() => []);
  const candidates = [];
  for (const name of entries) {
    if (name.includes('.tmp-')) {
      await rm(path.join(updatesDir, name), { force: true }).catch(() => {});
      continue;
    }
    const full = path.join(updatesDir, name);
    if (full === keepFile) continue;
    if (name.startsWith(`ready-${track}-`) && name.endsWith(ext)) {
      const info = await stat(full).catch(() => null);
      if (info?.isFile()) candidates.push({ full, mtimeMs: info.mtimeMs });
    }
  }
  // Keep 1 newest prior installer as base-<track><ext> for future binary delta patches.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length > 0) {
    const baseKeep = path.join(updatesDir, `base-${track}${ext}`);
    await rename(candidates[0].full, baseKeep).catch(() => {});
    for (const stale of candidates.slice(1)) {
      await rm(stale.full, { force: true }).catch(() => {});
    }
  }
}

export function createDesktopUpdater({
  appVersion,
  platformId = `${process.platform}-${process.arch}`,
  profileDir,
  resourcesDir,
  execPath = process.execPath,
  config = null,
  onStatus = () => {},
  onInstallFile = async () => {},
  onInstallAsar = null,
  canUseAsarUpdate = null,
  fetchImpl = fetch,
} = {}) {
  const enabled = Boolean(config?.updateUrl && config?.updatePublicKey);
  const prefsFile = enabled && profileDir ? path.join(profileDir, 'updater-prefs.json') : null;
  let savedPrefs = {};
  if (prefsFile) {
    try { savedPrefs = JSON.parse(readFileSync(prefsFile, 'utf8')) ?? {}; } catch {}
  }
  let track = ['stable', 'nightly', 'dogfood'].includes(savedPrefs.track) ? savedPrefs.track : 'stable';
  let autoUpdateWhenIdle = Boolean(savedPrefs.autoUpdateWhenIdle);
  let state = enabled ? { type: 'idle' } : { type: 'disabled', reason: 'disabled-by-env' };
  let stagedFile = null;
  let stagedAsarInfo = null;
  let stagedVersion = null;
  let checking = null;
  let checkGeneration = 0;

  const savePrefs = () => {
    if (!prefsFile) return;
    try {
      mkdirSync(path.dirname(prefsFile), { recursive: true });
      const tmp = `${prefsFile}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ track, autoUpdateWhenIdle }, null, 2));
      renameSync(tmp, prefsFile);
    } catch {}
  };

  const status = () => ({
    state,
    currentVersion: appVersion ?? '',
    ...(config?.builtAt ? { currentBuiltAt: config.builtAt } : {}),
    currentTrack: track,
    trackOverride: null,
    buildDefaultTrack: enabled ? 'stable' : null,
    availableTracks: enabled ? ['stable', 'nightly'] : ['stable'],
    isTrackManagedByPolicy: !enabled,
    delivery: enabled ? 'in-app' : 'package-manager',
    isBelowMinimumVersion: false,
    autoUpdateWhenIdle,
  });

  const emit = nextState => {
    state = nextState;
    const snap = status();
    try { onStatus(snap); } catch {}
    return snap;
  };

  async function tryStageAsarDelta({ manifest, updatesDir, activeTrack, isCurrentGen }) {
    if (!resourcesDir || typeof onInstallAsar !== 'function' || !Array.isArray(manifest.asarDeltas) || manifest.asarDeltas.length === 0) {
      return null;
    }
    const asarMetaPath = path.join(updatesDir, `ready-asar-${activeTrack}-${manifest.version}.json`);
    try {
      const existing = JSON.parse(await readFile(asarMetaPath, 'utf8'));
      const info = await stat(existing.asarFile);
      if (info.isFile() && info.size === existing.size &&
          (await sha256File(existing.asarFile)) === existing.sha256.toLowerCase()) {
        const hdr = await readAsarHeaderInfo(existing.asarFile);
        if (hdr.headerSha256 === existing.headerSha256.toLowerCase()) {
          return existing;
        }
      }
    } catch {}

    const currentAsar = path.join(resourcesDir, 'app.asar');
    const asarStat = await stat(currentAsar).catch(() => null);
    if (!asarStat?.isFile()) return null;
    const candidates = manifest.asarDeltas.filter(a => a.baseSize === asarStat.size);
    if (candidates.length === 0) return null;

    if (typeof canUseAsarUpdate === 'function') {
      if (!(await canUseAsarUpdate({ resourcesDir, execPath }))) return null;
    } else {
      try { await access(resourcesDir, constants.W_OK); } catch { return null; }
    }

    const currentAsarSha = await sha256File(currentAsar);
    const matching = candidates.find(a => a.baseSha256.toLowerCase() === currentAsarSha);
    if (!matching) return null;

    verifyDesktopDeltasManifest(manifest, config.updatePublicKey);
    const currentHeader = await readAsarHeaderInfo(currentAsar);
    if (matching.baseHeaderSha256 && matching.baseHeaderSha256.toLowerCase() !== currentHeader.headerSha256) {
      return null;
    }

    if (!isCurrentGen()) return null;
    emit({ type: 'available', version: manifest.version });
    const tmpDelta = path.join(updatesDir, `asar-${activeTrack}-${manifest.version}.gbdelta.tmp-${process.pid}`);
    const ok = await downloadVerifiedFile({
      fetchImpl,
      url: matching.url,
      expectedSize: matching.size,
      expectedSha256: matching.sha256,
      tmpFile: tmpDelta,
      isCurrentGen,
      onProgress: progress => emit({ type: 'downloading', version: manifest.version, progress }),
    });
    if (!ok) return null;

    emit({ type: 'staging', version: manifest.version });
    const targetAsar = path.join(updatesDir, `asar-${activeTrack}-${manifest.version}.asar`);
    try {
      await applyDeltaFile(currentAsar, tmpDelta, targetAsar, {
        expectedSourceSha256: matching.baseSha256,
        expectedTargetSha256: matching.targetSha256,
        expectedTargetSize: matching.targetSize,
      });
      const targetHdr = await readAsarHeaderInfo(targetAsar);
      if (targetHdr.headerSha256 !== matching.targetHeaderSha256.toLowerCase()) {
        throw new Error('Reconstructed ASAR header integrity mismatch');
      }
      const meta = {
        version: manifest.version,
        asarFile: targetAsar,
        sha256: matching.targetSha256.toLowerCase(),
        size: matching.targetSize,
        headerSha256: matching.targetHeaderSha256.toLowerCase(),
        baseHeaderSha256: currentHeader.headerSha256,
        resourcesDir,
        execPath,
      };
      const metaTmp = `${asarMetaPath}.tmp-${process.pid}`;
      await writeFile(metaTmp, JSON.stringify(meta, null, 2));
      await rename(metaTmp, asarMetaPath);
      return meta;
    } finally {
      await rm(tmpDelta, { force: true }).catch(() => {});
    }
  }

  async function tryStageInstallerDelta({ manifest, updatesDir, target, isCurrentGen }) {
    if (!Array.isArray(manifest.deltas) || manifest.deltas.length === 0) return false;
    const found = await findMatchingBaseInstaller(updatesDir, manifest.deltas);
    if (!found) return false;

    verifyDesktopDeltasManifest(manifest, config.updatePublicKey);
    if (!isCurrentGen()) return false;
    emit({ type: 'available', version: manifest.version });
    const tmpDelta = `${target}.gbdelta.tmp-${process.pid}`;
    const ok = await downloadVerifiedFile({
      fetchImpl,
      url: found.delta.url,
      expectedSize: found.delta.size,
      expectedSha256: found.delta.sha256,
      tmpFile: tmpDelta,
      isCurrentGen,
      onProgress: progress => emit({ type: 'downloading', version: manifest.version, progress }),
    });
    if (!ok) return false;

    emit({ type: 'staging', version: manifest.version });
    try {
      await applyDeltaFile(found.baseFile, tmpDelta, target, {
        expectedSourceSha256: found.delta.baseSha256,
        expectedTargetSha256: manifest.sha256,
        expectedTargetSize: manifest.size,
        maxTargetBytes: MAX_INSTALLER_BYTES,
      });
      return true;
    } finally {
      await rm(tmpDelta, { force: true }).catch(() => {});
    }
  }

  async function check() {
    if (!enabled) return status();
    if (checking) return checking;
    const myGen = ++checkGeneration;
    const activeTrack = track;
    const isCurrentGen = () => myGen === checkGeneration;

    const promise = (async () => {
      emit({ type: 'checking' });
      try {
        const feedName = activeTrack === 'stable' ? `${platformId}.json` : `${platformId}-${activeTrack}.json`;
        const feedUrl = `${config.updateUrl}/${feedName}?t=${Date.now()}`;
        const res = await fetchImpl(feedUrl, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
        if (!isCurrentGen()) return status();
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: 'feed_http_status', httpStatus: res.status });
        let manifest;
        try { manifest = await res.json(); } catch { throw Object.assign(new Error('Invalid feed JSON'), { kind: 'feed_malformed' }); }
        if (!manifest || typeof manifest.url !== 'string' || !validUpdateUrl(manifest.url) ||
            !SHA_HEX_RE.test(String(manifest.sha256 || '')) || !Number.isSafeInteger(manifest.size) || manifest.size <= 0) {
          throw Object.assign(new Error('Invalid manifest fields'), { kind: 'feed_malformed' });
        }
        try { verifyDesktopManifest(manifest, config.updatePublicKey); }
        catch (err) { throw Object.assign(err, { kind: 'installer_signature_invalid' }); }
        if (manifest.platform !== platformId || manifest.track !== activeTrack) {
          throw Object.assign(new Error('Manifest target mismatch'), { kind: 'feed_malformed' });
        }

        if (compareVersions(manifest.version, appVersion) <= 0) {
          return isCurrentGen()
            ? emit({ type: 'idle', lastCheck: { at: Date.now(), result: 'up-to-date' } })
            : status();
        }

        const updatesDir = path.join(profileDir, 'updates');
        await mkdir(updatesDir, { recursive: true });
        const ext = path.extname(new URL(manifest.url).pathname) || (process.platform === 'win32' ? '.exe' : '.dmg');
        const target = path.join(updatesDir, `ready-${activeTrack}-${manifest.version}${ext}`);

        // 1. Check already-staged full installer first.
        let needFullOrDelta = true;
        try {
          const info = await stat(target);
          if (info.isFile() && info.size === manifest.size && (await sha256File(target)) === manifest.sha256.toLowerCase()) {
            needFullOrDelta = false;
          }
        } catch {}

        if (!needFullOrDelta) {
          if (!isCurrentGen()) return status();
          stagedAsarInfo = null;
          stagedFile = target;
          stagedVersion = manifest.version;
          return emit({ type: 'ready', version: manifest.version });
        }

        // 2. Try lightweight ASAR incremental update when eligible (falls back cleanly if unavailable or failed).
        try {
          const asarStaged = await tryStageAsarDelta({ manifest, updatesDir, activeTrack, isCurrentGen });
          if (asarStaged && isCurrentGen()) {
            stagedFile = null;
            stagedAsarInfo = asarStaged;
            stagedVersion = manifest.version;
            return emit({ type: 'ready', version: manifest.version });
          }
        } catch {}
        if (!isCurrentGen()) return status();

        // 3. Try binary delta against cached previous installer (falls back cleanly if base/delta fails).
        let stagedByDelta = false;
        try {
          stagedByDelta = await tryStageInstallerDelta({ manifest, updatesDir, target, isCurrentGen });
        } catch {
          await rm(target, { force: true }).catch(() => {});
        }
        if (!isCurrentGen()) return status();

        // 4. Fallback to full installer download when no verified incremental path applies.
        if (!stagedByDelta) {
          emit({ type: 'available', version: manifest.version });
          const tmpFile = `${target}.tmp-${process.pid}`;
          const ok = await downloadVerifiedFile({
            fetchImpl,
            url: manifest.url,
            expectedSize: manifest.size,
            expectedSha256: manifest.sha256,
            tmpFile,
            isCurrentGen,
            onProgress: progress => emit({ type: 'downloading', version: manifest.version, progress }),
          });
          if (!ok) return status();
          emit({ type: 'staging', version: manifest.version });
          await rename(tmpFile, target);
        }

        await pruneOldInstallers(updatesDir, target, activeTrack, ext);
        if (!isCurrentGen()) return status();
        stagedAsarInfo = null;
        stagedFile = target;
        stagedVersion = manifest.version;
        return emit({ type: 'ready', version: manifest.version });
      } catch (err) {
        if (!isCurrentGen()) return status();
        const failure = err.kind === 'feed_http_status'
          ? { kind: 'feed_http_status', httpStatus: err.httpStatus }
          : { kind: err.kind ?? 'update_failed' };
        return emit({ type: 'idle', lastCheck: { at: Date.now(), result: 'error', failure, errorMessage: err.message } });
      } finally {
        if (checking === promise) checking = null;
      }
    })();
    checking = promise;
    return promise;
  }

  return {
    status,
    check,
    setTrack({ track: next } = {}) {
      if (!['stable', 'nightly', 'dogfood'].includes(next)) throw new Error('Invalid track');
      checkGeneration += 1;
      checking = null;
      track = next;
      stagedFile = null;
      stagedAsarInfo = null;
      stagedVersion = null;
      savePrefs();
      return enabled ? emit({ type: 'idle' }) : status();
    },
    setAutoUpdateWhenIdle({ enabled: val } = {}) {
      autoUpdateWhenIdle = Boolean(val);
      savePrefs();
      return emit(state);
    },
    async quitAndInstall({ expectedVersion } = {}) {
      if (!enabled || (!stagedFile && !stagedAsarInfo)) throw new Error('No update ready');
      if (expectedVersion && stagedVersion && expectedVersion !== stagedVersion) {
        return { status: 'superseded' };
      }
      if (stagedAsarInfo) {
        await onInstallAsar(stagedAsarInfo);
      } else {
        await onInstallFile(stagedFile, stagedVersion);
      }
      return { status: 'requested' };
    },
  };
}
