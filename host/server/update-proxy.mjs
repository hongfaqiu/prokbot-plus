import { lookup } from 'node:dns/promises';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import nodePath from 'node:path';
import { publicAddress } from './media-http.mjs';
import { check, HttpError } from './security.mjs';

export const MAX_UPDATE_PROXY_BYTES = 512 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Map([
  ['.json', 'application/json; charset=utf-8'],
  ['.apk', 'application/vnd.android.package-archive'],
  ['.exe', 'application/vnd.microsoft.portable-executable'],
  ['.dmg', 'application/x-apple-diskimage'],
  ['.gbdelta', 'application/octet-stream'],
]);

export async function resolveSafeUpdateTarget(raw, { allowOrigin = null, lookupImpl = lookup } = {}) {
  let target;
  try {
    target = new URL(String(raw ?? '').trim());
  } catch {
    throw new HttpError(400, 'Invalid update URL');
  }
  check(!target.username && !target.password, 400, 'Invalid update URL');
  const matchesConfiguredOrigin = Boolean(allowOrigin && target.origin === allowOrigin);
  if (matchesConfiguredOrigin) {
    check(['https:', 'http:'].includes(target.protocol), 400, 'Unsupported update URL protocol');
    return { target, selectedAddress: null };
  }
  check(target.protocol === 'https:', 400, 'Update proxy requires HTTPS');
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookupImpl(hostname, { all: true });
  check(addresses.length > 0 && addresses.every(item => publicAddress(item.address)), 403, 'Update URL must use a public address');
  return { target, selectedAddress: addresses[0] };
}

async function tryServeLocalMirror(target, method, updateDir, response) {
  if (!updateDir) return false;
  const pathname = target.pathname.replace(/^\/+/, '');
  const sub = pathname.startsWith('updates/') ? pathname.slice('updates/'.length) : nodePath.posix.basename(pathname);
  const parts = sub.split('/').filter(Boolean);
  if (!parts.length || parts.some(seg => seg === '.' || seg === '..' || !/^[A-Za-z0-9._-]+$/.test(seg))) {
    return false;
  }
  const base = nodePath.resolve(updateDir);
  const candidate = nodePath.resolve(base, ...parts);
  if (candidate !== base && !candidate.startsWith(`${base}${nodePath.sep}`)) return false;
  const info = await stat(candidate).catch(() => null);
  if (!info?.isFile() || info.size > MAX_UPDATE_PROXY_BYTES) return false;
  const contentType = ALLOWED_MIME_TYPES.get(nodePath.extname(candidate).toLowerCase()) ?? 'application/octet-stream';
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': String(info.size),
    'cache-control': 'no-store',
  });
  if (method === 'HEAD') {
    response.end();
    return true;
  }
  const stream = createReadStream(candidate);
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
  return true;
}

async function requestStream({ target, selectedAddress, method, signal, redirects = 3, allowOrigin, lookupImpl }) {
  const upstream = await new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(
      target,
      {
        method,
        signal,
        ...(selectedAddress
          ? { lookup: (_host, opts, done) => (opts.all ? done(null, [selectedAddress]) : done(null, selectedAddress.address, selectedAddress.family)) }
          : {}),
        headers: {
          accept: 'application/json, application/octet-stream, */*',
          'cache-control': 'no-store',
        },
      },
      resolve,
    );
    req.setTimeout(30_000, () => req.destroy(new HttpError(504, 'Update upstream timed out')));
    req.once('error', reject);
    req.end();
  });

  if ([301, 302, 303, 307, 308].includes(upstream.statusCode)) {
    const location = upstream.headers.location;
    upstream.resume();
    check(redirects > 0 && location, 502, 'Too many update redirects');
    const nextRaw = new URL(location, target).href;
    const resolved = await resolveSafeUpdateTarget(nextRaw, { allowOrigin, lookupImpl });
    return requestStream({
      target: resolved.target,
      selectedAddress: resolved.selectedAddress,
      method,
      signal,
      redirects: redirects - 1,
      allowOrigin,
      lookupImpl,
    });
  }
  return upstream;
}

export async function handleUpdateProxy(
  request,
  response,
  path,
  url,
  { device, connections, allowOrigin = process.env.GROKBOT_UPDATE_UPSTREAM_ORIGIN || null, updateDir = process.env.GROKBOT_UPDATE_DIR || null, lookupImpl = lookup } = {},
) {
  if (path !== '/local/updates/fetch') return false;
  check(['GET', 'HEAD'].includes(request.method), 405, 'Unsupported method');
  const found = device(request);
  connections.track(found.id, response);

  const rawUrl = url.searchParams.get('url');
  check(typeof rawUrl === 'string' && rawUrl.trim().length > 0 && rawUrl.length <= 2048, 400, 'Missing url parameter');
  const { target, selectedAddress } = await resolveSafeUpdateTarget(rawUrl, { allowOrigin, lookupImpl });

  if (await tryServeLocalMirror(target, request.method, updateDir, response)) {
    return true;
  }

  const abort = new AbortController();
  const onClose = () => abort.abort();
  response.once('close', onClose);

  try {
    const upstream = await requestStream({
      target,
      selectedAddress,
      method: request.method,
      signal: abort.signal,
      allowOrigin,
      lookupImpl,
    });
    const declaredLen = Number(upstream.headers['content-length']);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_UPDATE_PROXY_BYTES) {
      upstream.destroy();
      throw new HttpError(502, 'Update payload too large');
    }

    const outHeaders = { 'cache-control': 'no-store' };
    for (const key of ['content-type', 'content-length', 'etag', 'last-modified']) {
      const value = upstream.headers[key];
      if (typeof value === 'string' && value) outHeaders[key] = value;
    }
    response.writeHead(upstream.statusCode || 502, outHeaders);
    if (request.method === 'HEAD') {
      upstream.resume();
      response.off('close', onClose);
      response.end();
      return true;
    }

    let transferred = 0;
    upstream.on('data', chunk => {
      transferred += chunk.length;
      if (transferred > MAX_UPDATE_PROXY_BYTES) {
        upstream.destroy(new HttpError(502, 'Update payload exceeded size limit'));
        response.destroy();
      }
    });
    upstream.once('end', () => response.off('close', onClose));
    upstream.once('error', () => {
      response.off('close', onClose);
      if (!response.destroyed) response.destroy();
    });
    upstream.pipe(response);
  } catch (err) {
    response.off('close', onClose);
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, err?.message || 'Update fetch failed');
  }
  return true;
}
