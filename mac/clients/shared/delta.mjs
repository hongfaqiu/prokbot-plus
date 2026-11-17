import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip, gunzipSync, gzipSync } from 'node:zlib';

export const DELTA_SCHEMA = 'grokbot-delta/v1';
export const DELTA_MAGIC = Buffer.from('GBD1', 'ascii');
export const DEFAULT_MAX_DELTA_TARGET_BYTES = 512 * 1024 * 1024;

const OP_END = 0x00;
const OP_COPY = 0x01;
const OP_ADD = 0x02;

export async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export function encodeUleb128(value) {
  let v = typeof value === 'bigint' ? value : BigInt(value);
  if (v < 0n) throw new RangeError('ULEB128 value must be non-negative');
  const bytes = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0n);
  return Buffer.from(bytes);
}

export function decodeUleb128(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('ULEB128 exceeds safe integer range');
      }
      return { value: Number(result), nextOffset: pos };
    }
    shift += 7n;
    if (shift > 56n) throw new Error('ULEB128 overflow');
  }
  return null;
}

function hashWindow32(buf, pos) {
  // Fast 32-bit FNV-1a mix sampled over 32 bytes for rolling candidate lookup.
  let h = 0x811c9dc5;
  for (let i = 0; i < 32; i += 4) {
    const word = buf[pos + i] | (buf[pos + i + 1] << 8) | (buf[pos + i + 2] << 16) | (buf[pos + i + 3] << 24);
    h = Math.imul(h ^ word, 0x01000193) >>> 0;
  }
  return h;
}

function buildSourceIndex(source) {
  const width = 32;
  if (source.length < width) return null;
  const stride = source.length > 64 * 1024 * 1024 ? 32 : 16;
  const count = Math.floor((source.length - width) / stride) + 1;
  const tableSize = 1 << 21; // 2M buckets -> 8 MB Int32Array
  const mask = tableSize - 1;
  const head = new Int32Array(tableSize).fill(-1);
  const prev = new Int32Array(count).fill(-1);
  for (let slot = 0; slot < count; slot++) {
    const pos = slot * stride;
    const bucket = hashWindow32(source, pos) & mask;
    prev[slot] = head[bucket];
    head[bucket] = slot;
  }
  return { width, stride, mask, head, prev };
}

function matchLength(source, sPos, target, tPos, limit) {
  let len = 0;
  while (len + 8 <= limit &&
      source.readBigUInt64LE(sPos + len) === target.readBigUInt64LE(tPos + len)) {
    len += 8;
  }
  while (len < limit && source[sPos + len] === target[tPos + len]) {
    len += 1;
  }
  return len;
}

export function createDeltaBuffer(source, target) {
  if (!Buffer.isBuffer(source) || !Buffer.isBuffer(target)) {
    throw new TypeError('source and target must be Buffers');
  }
  const sourceShaRaw = createHash('sha256').update(source).digest();
  const targetShaRaw = createHash('sha256').update(target).digest();

  const ops = [];
  const index = buildSourceIndex(source);
  let cursor = 0;
  let pending = 0;

  while (cursor < target.length) {
    let bestStart = 0;
    let bestLen = 0;
    if (index && cursor + index.width <= target.length) {
      const bucket = hashWindow32(target, cursor) & index.mask;
      let slot = index.head[bucket];
      let probes = 0;
      while (slot >= 0 && probes < 4) {
        probes += 1;
        const offset = slot * index.stride;
        if (source.compare(target, cursor, cursor + index.width, offset, offset + index.width) === 0) {
          const limit = Math.min(source.length - offset, target.length - cursor);
          const len = index.width + matchLength(source, offset + index.width, target, cursor + index.width, limit - index.width);
          if (len > bestLen) {
            bestStart = offset;
            bestLen = len;
            if (len >= 65536) break;
          }
        }
        slot = index.prev[slot];
      }
    }

    if (bestLen === 0) {
      cursor += 1;
      continue;
    }

    while (cursor > pending && bestStart > 0 && source[bestStart - 1] === target[cursor - 1]) {
      cursor -= 1;
      bestStart -= 1;
      bestLen += 1;
    }

    if (pending < cursor) {
      const addSlice = target.subarray(pending, cursor);
      const last = ops[ops.length - 1];
      if (last && last.type === OP_ADD) {
        last.chunks.push(addSlice);
        last.length += addSlice.length;
      } else {
        ops.push({ type: OP_ADD, chunks: [addSlice], length: addSlice.length });
      }
    }

    const last = ops[ops.length - 1];
    if (last && last.type === OP_COPY && last.offset + last.length === bestStart) {
      last.length += bestLen;
    } else {
      ops.push({ type: OP_COPY, offset: bestStart, length: bestLen });
    }
    cursor += bestLen;
    pending = cursor;
  }

  if (pending < target.length) {
    const tail = target.subarray(pending);
    const last = ops[ops.length - 1];
    if (last && last.type === OP_ADD) {
      last.chunks.push(tail);
      last.length += tail.length;
    } else {
      ops.push({ type: OP_ADD, chunks: [tail], length: tail.length });
    }
  }

  const parts = [
    DELTA_MAGIC,
    sourceShaRaw,
    encodeUleb128(source.length),
    targetShaRaw,
    encodeUleb128(target.length),
  ];
  for (const op of ops) {
    if (op.type === OP_COPY) {
      parts.push(Buffer.from([OP_COPY]), encodeUleb128(op.offset), encodeUleb128(op.length));
    } else {
      parts.push(Buffer.from([OP_ADD]), encodeUleb128(op.length), ...op.chunks);
    }
  }
  parts.push(Buffer.from([OP_END]));
  const rawStream = Buffer.concat(parts);
  const compressed = gzipSync(rawStream, { level: 9 });
  return compressed;
}

export function applyDeltaBuffer(source, compressedDelta) {
  const raw = gunzipSync(compressedDelta);
  let pos = 0;
  if (raw.length < 4 + 32 + 1 + 32 + 1 + 1 || !raw.subarray(0, 4).equals(DELTA_MAGIC)) {
    throw new Error('Invalid delta header magic');
  }
  pos += 4;
  const sourceShaHex = raw.subarray(pos, pos + 32).toString('hex');
  pos += 32;
  const sSizeDec = decodeUleb128(raw, pos);
  if (!sSizeDec) throw new Error('Truncated delta sourceSize');
  pos = sSizeDec.nextOffset;
  if (raw.length - pos < 33) throw new Error('Truncated delta target header');
  const targetShaHex = raw.subarray(pos, pos + 32).toString('hex');
  pos += 32;
  const tSizeDec = decodeUleb128(raw, pos);
  if (!tSizeDec) throw new Error('Truncated delta targetSize');
  pos = tSizeDec.nextOffset;

  const actualSourceSha = createHash('sha256').update(source).digest('hex');
  if (source.length !== sSizeDec.value || actualSourceSha !== sourceShaHex) {
    throw new Error('Delta source checksum or size mismatch');
  }
  const out = Buffer.allocUnsafe(tSizeDec.value);
  let written = 0;
  let ended = false;
  while (pos < raw.length) {
    const op = raw[pos++];
    if (op === OP_END) {
      ended = true;
      break;
    }
    if (op === OP_COPY) {
      const offDec = decodeUleb128(raw, pos);
      if (!offDec) throw new Error('Truncated COPY offset');
      const lenDec = decodeUleb128(raw, offDec.nextOffset);
      if (!lenDec) throw new Error('Truncated COPY length');
      pos = lenDec.nextOffset;
      const offset = offDec.value;
      const length = lenDec.value;
      if (length <= 0 || offset + length > source.length || written + length > out.length) {
        throw new Error('Invalid COPY bounds');
      }
      source.copy(out, written, offset, offset + length);
      written += length;
    } else if (op === OP_ADD) {
      const lenDec = decodeUleb128(raw, pos);
      if (!lenDec) throw new Error('Truncated ADD length');
      pos = lenDec.nextOffset;
      const length = lenDec.value;
      if (length <= 0 || pos + length > raw.length || written + length > out.length) {
        throw new Error('Invalid ADD bounds');
      }
      raw.copy(out, written, pos, pos + length);
      pos += length;
      written += length;
    } else {
      throw new Error(`Unknown delta opcode: ${op}`);
    }
  }
  if (!ended || pos !== raw.length || written !== out.length) {
    throw new Error('Incomplete or malformed delta stream');
  }
  if (createHash('sha256').update(out).digest('hex') !== targetShaHex) {
    throw new Error('Delta output SHA-256 verification failed');
  }
  return out;
}

export async function createDeltaFile(sourcePath, targetPath, deltaPath) {
  const { readFile, writeFile } = await import('node:fs/promises');
  const [sourceBuf, targetBuf] = await Promise.all([readFile(sourcePath), readFile(targetPath)]);
  const compressed = createDeltaBuffer(sourceBuf, targetBuf);
  const roundTrip = applyDeltaBuffer(sourceBuf, compressed);
  if (!roundTrip.equals(targetBuf)) throw new Error('Delta round-trip mismatch');
  await mkdir(path.dirname(deltaPath), { recursive: true });
  const tmp = `${deltaPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, compressed);
  await rename(tmp, deltaPath);
  return {
    sourceSha256: createHash('sha256').update(sourceBuf).digest('hex'),
    sourceSize: sourceBuf.length,
    targetSha256: createHash('sha256').update(targetBuf).digest('hex'),
    targetSize: targetBuf.length,
    deltaSha256: createHash('sha256').update(compressed).digest('hex'),
    deltaSize: compressed.length,
  };
}

export async function applyDeltaFile(
  sourcePath,
  deltaPath,
  outPath,
  {
    expectedSourceSha256,
    expectedTargetSha256,
    expectedTargetSize,
    maxTargetBytes = DEFAULT_MAX_DELTA_TARGET_BYTES,
    onProgress,
  } = {},
) {
  const sourceStat = await stat(sourcePath);
  const actualSourceSha = await sha256File(sourcePath);
  if (expectedSourceSha256 && actualSourceSha !== expectedSourceSha256.toLowerCase()) {
    throw new Error('Delta base file SHA-256 mismatch');
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  const tmpOut = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  const sourceHandle = await open(sourcePath, 'r');
  const outHandle = await open(tmpOut, 'w');
  const outHash = createHash('sha256');
  const copyBuf = Buffer.allocUnsafe(64 * 1024);

  const writeChunk = async chunkBuf => {
    outHash.update(chunkBuf);
    let offset = 0;
    while (offset < chunkBuf.length) {
      const { bytesWritten } = await outHandle.write(chunkBuf, offset, chunkBuf.length - offset);
      if (bytesWritten <= 0) throw new Error('Short write on delta output');
      offset += bytesWritten;
    }
  };

  let buf = Buffer.alloc(0);
  let headerParsed = false;
  let sourceSize = 0;
  let targetSize = 0;
  let targetShaHex = '';
  let written = 0;
  let remainingAdd = 0;
  let sawEnd = false;
  let lastProgressAt = 0;

  const reportProgress = () => {
    if (!onProgress || targetSize <= 0) return;
    const now = Date.now();
    if (now - lastProgressAt >= 150) {
      lastProgressAt = now;
      onProgress(Math.min(1, written / targetSize));
    }
  };

  const gunzip = createGunzip();
  const input = createReadStream(deltaPath);
  input.on('error', err => gunzip.destroy(err));
  input.pipe(gunzip);

  try {
    for await (const chunk of gunzip) {
      if (sawEnd) throw new Error('Unexpected data after delta END marker');
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

      while (true) {
        if (remainingAdd > 0) {
          if (buf.length === 0) break;
          const take = Math.min(remainingAdd, buf.length);
          if (written + take > targetSize) throw new Error('Delta ADD overflow');
          await writeChunk(buf.subarray(0, take));
          written += take;
          remainingAdd -= take;
          buf = buf.subarray(take);
          reportProgress();
          continue;
        }

        if (!headerParsed) {
          if (buf.length < 4 + 32 + 1) break;
          if (!buf.subarray(0, 4).equals(DELTA_MAGIC)) throw new Error('Invalid delta magic');
          const headerSourceSha = buf.subarray(4, 36).toString('hex');
          const sDec = decodeUleb128(buf, 36);
          if (!sDec) break;
          if (buf.length < sDec.nextOffset + 32 + 1) break;
          targetShaHex = buf.subarray(sDec.nextOffset, sDec.nextOffset + 32).toString('hex');
          const tDec = decodeUleb128(buf, sDec.nextOffset + 32);
          if (!tDec) break;

          sourceSize = sDec.value;
          targetSize = tDec.value;
          if (sourceSize !== sourceStat.size || headerSourceSha !== actualSourceSha) {
            throw new Error('Delta header source mismatch');
          }
          if (expectedTargetSize != null && targetSize !== expectedTargetSize) {
            throw new Error('Delta target size mismatch');
          }
          if (expectedTargetSha256 && targetShaHex !== expectedTargetSha256.toLowerCase()) {
            throw new Error('Delta target SHA-256 mismatch');
          }
          if (targetSize < 0 || targetSize > maxTargetBytes) {
            throw new Error('Delta target exceeds max allowed size');
          }
          buf = buf.subarray(tDec.nextOffset);
          headerParsed = true;
          continue;
        }

        if (buf.length === 0) break;
        const op = buf[0];
        if (op === OP_END) {
          sawEnd = true;
          buf = buf.subarray(1);
          if (buf.length > 0) throw new Error('Trailing bytes after delta END marker');
          break;
        }
        if (op === OP_COPY) {
          const offDec = decodeUleb128(buf, 1);
          if (!offDec) break;
          const lenDec = decodeUleb128(buf, offDec.nextOffset);
          if (!lenDec) break;
          const offset = offDec.value;
          const length = lenDec.value;
          if (length <= 0 || offset + length > sourceSize || written + length > targetSize) {
            throw new Error('Delta COPY bounds invalid');
          }
          buf = buf.subarray(lenDec.nextOffset);
          let left = length;
          let srcPos = offset;
          while (left > 0) {
            const want = Math.min(left, copyBuf.length);
            const { bytesRead } = await sourceHandle.read(copyBuf, 0, want, srcPos);
            if (bytesRead <= 0) throw new Error('Unexpected EOF reading delta base');
            await writeChunk(copyBuf.subarray(0, bytesRead));
            srcPos += bytesRead;
            written += bytesRead;
            left -= bytesRead;
          }
          reportProgress();
          continue;
        }
        if (op === OP_ADD) {
          const lenDec = decodeUleb128(buf, 1);
          if (!lenDec) break;
          if (lenDec.value <= 0 || written + lenDec.value > targetSize) {
            throw new Error('Delta ADD bounds invalid');
          }
          remainingAdd = lenDec.value;
          buf = buf.subarray(lenDec.nextOffset);
          continue;
        }
        throw new Error(`Unknown delta opcode: ${op}`);
      }
    }

    if (!headerParsed || !sawEnd || remainingAdd !== 0 || written !== targetSize) {
      throw new Error('Delta stream ended prematurely');
    }
    const actualOutSha = outHash.digest('hex');
    if (actualOutSha !== targetShaHex) {
      throw new Error('Reconstructed delta output SHA-256 mismatch');
    }
    await outHandle.close();
    await rename(tmpOut, outPath);
    return { sha256: actualOutSha, size: written };
  } catch (err) {
    await outHandle.close().catch(() => {});
    await rm(tmpOut, { force: true }).catch(() => {});
    throw err;
  } finally {
    await sourceHandle.close().catch(() => {});
  }
}

/** Read Electron app.asar raw JSON header string digest (same value stored in ElectronAsarIntegrity). */
export async function readAsarHeaderInfo(asarPath) {
  const handle = await open(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, 16, 0);
    if (bytesRead < 16) throw new Error('Truncated ASAR header');
    const sizeSize = head.readUInt32LE(0);
    const headerSize = head.readUInt32LE(4);
    const stringLen = head.readInt32LE(12);
    if (sizeSize !== 4 || headerSize <= 8 || stringLen <= 0 || stringLen > 64 * 1024 * 1024 || stringLen > headerSize) {
      throw new Error('Invalid ASAR header structure');
    }
    const headerBytes = Buffer.allocUnsafe(stringLen);
    const bodyRead = await handle.read(headerBytes, 0, stringLen, 16);
    if (bodyRead.bytesRead !== stringLen) throw new Error('Truncated ASAR header JSON');
    JSON.parse(headerBytes.toString('utf8'));
    const headerSha256 = createHash('sha256').update(headerBytes).digest('hex');
    return { headerSha256, headerSize: headerSize + 8 };
  } finally {
    await handle.close();
  }
}

export const ANDROID_DELTAS_SCHEMA = 'grokbot-android-deltas/v1';
export const DESKTOP_DELTAS_SCHEMA = 'grokbot-desktop-deltas/v1';

export function canonicalAndroidDeltasPayload(manifest) {
  const deltas = Array.isArray(manifest?.deltas) ? manifest.deltas : [];
  const header = [
    ANDROID_DELTAS_SCHEMA,
    manifest.track,
    manifest.packageName,
    manifest.versionName,
    String(manifest.versionCode),
    String(manifest.sha256).toLowerCase(),
    String(manifest.size),
    String(manifest.certificateSha256).toLowerCase(),
  ];
  const lines = deltas.map(d => [
    String(d.baseSha256).toLowerCase(),
    String(d.baseSize),
    String(d.sha256).toLowerCase(),
    String(d.size),
    d.url,
  ].join('|'));
  return [...header, ...lines].join('\n');
}

export function canonicalDesktopDeltasPayload(manifest) {
  const deltas = Array.isArray(manifest?.deltas) ? manifest.deltas : [];
  const asarDeltas = Array.isArray(manifest?.asarDeltas) ? manifest.asarDeltas : [];
  const header = [
    DESKTOP_DELTAS_SCHEMA,
    manifest.platform,
    manifest.track,
    manifest.version,
    String(manifest.sha256).toLowerCase(),
    String(manifest.size),
  ];
  const installerLines = deltas.map(d => [
    'installer',
    String(d.baseSha256).toLowerCase(),
    String(d.baseSize),
    String(d.sha256).toLowerCase(),
    String(d.size),
    d.url,
  ].join('|'));
  const asarLines = asarDeltas.map(a => [
    'asar',
    String(a.baseSha256).toLowerCase(),
    String(a.baseSize),
    String(a.targetSha256).toLowerCase(),
    String(a.targetSize),
    String(a.targetHeaderSha256).toLowerCase(),
    String(a.sha256).toLowerCase(),
    String(a.size),
    a.url,
  ].join('|'));
  return [...header, ...installerLines, ...asarLines].join('\n');
}

