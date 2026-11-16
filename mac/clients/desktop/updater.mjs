import { createHash, createPublicKey, verify } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const DESKTOP_UPDATE_SCHEMA = 'grokbot-desktop-update/v1';

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

async function sha256File(filename) {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
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

export function createDesktopUpdater({
  appVersion,
  platformId = `${process.platform}-${process.arch}`,
  profileDir,
  config = null,
  onStatus = () => {},
  onInstallFile = async () => {},
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

  async function check() {
    if (!enabled) return status();
    if (checking) return checking;
    const myGen = ++checkGeneration;
    const activeTrack = track;
    const promise = (async () => {
      emit({ type: 'checking' });
      try {
        const feedName = activeTrack === 'stable' ? `${platformId}.json` : `${platformId}-${activeTrack}.json`;
        const feedUrl = `${config.updateUrl}/${feedName}?t=${Date.now()}`;
        const res = await fetchImpl(feedUrl, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
        if (myGen !== checkGeneration) return status();
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: 'feed_http_status', httpStatus: res.status });
        let manifest;
        try { manifest = await res.json(); } catch { throw Object.assign(new Error('Invalid feed JSON'), { kind: 'feed_malformed' }); }
        if (!manifest || typeof manifest.url !== 'string' || !validUpdateUrl(manifest.url) ||
            !/^[a-f0-9]{64}$/i.test(String(manifest.sha256 || '')) || !Number.isSafeInteger(manifest.size) || manifest.size <= 0) {
          throw Object.assign(new Error('Invalid manifest fields'), { kind: 'feed_malformed' });
        }
        try { verifyDesktopManifest(manifest, config.updatePublicKey); }
        catch (err) { throw Object.assign(err, { kind: 'installer_signature_invalid' }); }
        if (manifest.platform !== platformId || manifest.track !== activeTrack) {
          throw Object.assign(new Error('Manifest target mismatch'), { kind: 'feed_malformed' });
        }

        if (compareVersions(manifest.version, appVersion) <= 0) {
          return myGen === checkGeneration
            ? emit({ type: 'idle', lastCheck: { at: Date.now(), result: 'up-to-date' } })
            : status();
        }

        const updatesDir = path.join(profileDir, 'updates');
        await mkdir(updatesDir, { recursive: true });
        const ext = path.extname(new URL(manifest.url).pathname) || (process.platform === 'win32' ? '.exe' : '.dmg');
        const target = path.join(updatesDir, `ready-${activeTrack}-${manifest.version}${ext}`);
        let needDownload = true;
        try {
          const info = await stat(target);
          if (info.isFile() && info.size === manifest.size && (await sha256File(target)) === manifest.sha256.toLowerCase()) {
            needDownload = false;
          }
        } catch {}

        if (needDownload) {
          if (myGen !== checkGeneration) return status();
          emit({ type: 'available', version: manifest.version });
          const dl = await fetchImpl(manifest.url, { cache: 'no-store', signal: AbortSignal.timeout(300000) });
          if (!dl.ok || !dl.body) throw Object.assign(new Error(`Download HTTP ${dl.status}`), { kind: 'update_failed' });
          const total = Number(dl.headers.get('content-length')) || manifest.size;
          const tmpFile = `${target}.tmp-${process.pid}`;
          await rm(tmpFile, { force: true });
          const writer = createWriteStream(tmpFile);
          let received = 0, lastReport = 0;
          try {
            for await (const chunk of dl.body) {
              if (myGen !== checkGeneration) throw new Error('Track changed');
              received += chunk.length;
              if (received > 512 * 1024 * 1024) throw new Error('Installer too large');
              writer.write(chunk);
              const now = Date.now();
              if (now - lastReport >= 250) {
                lastReport = now;
                emit({ type: 'downloading', version: manifest.version, progress: Math.min(1, received / total) });
              }
            }
            await new Promise((resolve, reject) => writer.end(err => err ? reject(err) : resolve()));
          } catch (err) {
            writer.destroy();
            await rm(tmpFile, { force: true }).catch(() => {});
            throw Object.assign(err, { kind: 'update_failed' });
          }
          if (myGen !== checkGeneration) {
            await rm(tmpFile, { force: true }).catch(() => {});
            return status();
          }
          emit({ type: 'staging', version: manifest.version });
          const info = await stat(tmpFile);
          const actualSha = await sha256File(tmpFile);
          if (info.size !== manifest.size || actualSha !== manifest.sha256.toLowerCase()) {
            await rm(tmpFile, { force: true });
            throw Object.assign(new Error('Downloaded installer checksum mismatch'), { kind: 'installer_signature_invalid' });
          }
          await rename(tmpFile, target);
        }
        if (myGen !== checkGeneration) return status();
        stagedFile = target;
        stagedVersion = manifest.version;
        return emit({ type: 'ready', version: manifest.version });
      } catch (err) {
        if (myGen !== checkGeneration) return status();
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
      if (!enabled || !stagedFile) throw new Error('No update ready');
      if (expectedVersion && stagedVersion && expectedVersion !== stagedVersion) {
        return { status: 'superseded' };
      }
      await onInstallFile(stagedFile, stagedVersion);
      return { status: 'requested' };
    },
  };
}
