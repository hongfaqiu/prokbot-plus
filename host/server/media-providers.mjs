import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { check, HttpError } from './security.mjs';
import { checkSchema, downloadMedia, serviceBytes, serviceJson } from './media-http.mjs';

const runFile = promisify(execFile);

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
function reference(value) {
  check(value && imageTypes.has(value.mimeType) && typeof value.data === 'string'
    && value.data.length < 40 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.data), 400, 'Invalid reference image');
  return `data:${value.mimeType};base64,${value.data}`;
}
// Sizes every OpenAI-compatible image or video model accepts.
const standardSizes = ['1024x1024', '1536x1024', '1024x1536'];
const standardVideoSizes = ['1280x720', '720x1280', '1024x1024'];
/** The WIDTHxHEIGHT entry whose ratio is closest to `aspectRatio`; earlier entries win ties. */
export function sizeForAspect(aspectRatio, sizes = standardSizes) {
  const [width, height] = aspectRatio.split(':').map(Number);
  check(width > 0 && height > 0, 400, 'Invalid aspect ratio');
  let best;
  for (const size of sizes) {
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match) continue;
    const distance = Math.abs(Math.log((match[1] / match[2]) / (width / height)));
    if (!best || distance < best.distance - 1e-9) best = { size, distance };
  }
  check(best, 400, 'No configured size matches the aspect ratio');
  return best.size;
}
export function mediaInput(model, input, adapter) {
  check(typeof input.prompt === 'string' && input.prompt.trim().length > 0 && input.prompt.length <= 30_000, 400, 'Invalid media prompt');
  check(!input.references || Array.isArray(input.references) && input.references.length <= 10, 400, 'Too many reference images');
  const body = { ...model.parameters, prompt: input.prompt };
  const properties = model.inputSchema?.properties;
  if (input.aspectRatio) {
    check(typeof input.aspectRatio === 'string' && /^\d{1,2}:\d{1,2}$/.test(input.aspectRatio), 400, 'Invalid aspect ratio');
    // Models that take a pixel size instead of a ratio get the closest listed size; explicit parameters still win below.
    const sizes = Array.isArray(properties?.size?.enum) ? properties.size.enum
      : adapter === 'openai-images' ? standardSizes
      : adapter === 'openai-videos' ? standardVideoSizes : null;
    if (sizes && !properties?.aspect_ratio) body.size = sizeForAspect(input.aspectRatio, sizes);
    else {
      check(!properties || properties.aspect_ratio, 400, 'This model does not accept aspect_ratio; configure its size parameter');
      body.aspect_ratio = input.aspectRatio;
    }
  }
  if (input.references?.length) {
    const images = input.references.map(reference);
    if (properties?.images || !properties) body.images = images;
    else if (properties.image && images.length === 1) body.image = images[0];
    else throw new HttpError(400, 'Choose an image editing model that accepts these references');
  }
  if (input.parameters !== undefined) {
    check(input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters)
      && JSON.stringify(input.parameters).length <= 16_000, 400, 'Invalid generation parameters');
    for (const key of Object.keys(input.parameters)) check(!['prompt', 'images', 'image', 'model'].includes(key), 400, `Reserved parameter ${key}`);
    Object.assign(body, input.parameters);
  }
  checkSchema(body, model.inputSchema);
  return body;
}
function waveResult(result) {
  check(result.code === 200 && result.data, 502, 'Invalid WaveSpeed response'); return result.data;
}

export async function submitMedia(provider, model, body, signal) {
  const common = { apiKey: provider.apiKey, signal, limit: 96 * 1024 * 1024 };
  if (provider.adapter === 'wavespeed') {
    return waveResult(await serviceJson(`${provider.baseUrl}/api/v3/${model.model}`, { ...common, body }));
  }
  if (provider.adapter === 'openai-images') {
    const { aspect_ratio, images, image, ...parameters } = body;
    check(!aspect_ratio, 400, 'OpenAI Images uses the configured size parameter');
    const request = { ...parameters, model: model.model, n: 1 }, references = images ?? (image ? [image] : []);
    let result;
    if (references.length) {
      // Reference images go to the edits endpoint as multipart files.
      const form = new FormData();
      for (const [key, value] of Object.entries(request)) {
        check(value === null || ['string', 'number', 'boolean'].includes(typeof value), 400, `Image edits do not accept parameter ${key}`);
        if (value !== null) form.append(key, String(value));
      }
      references.forEach((url, index) => {
        const [, mimeType, data] = /^data:(image\/[a-z]+);base64,(.*)$/.exec(url);
        form.append('image[]', new Blob([Buffer.from(data, 'base64')], { type: mimeType }), `reference-${index + 1}.${mimeType.slice(6)}`);
      });
      result = await serviceJson(`${provider.baseUrl}/images/edits`, { ...common, form });
    } else result = await serviceJson(`${provider.baseUrl}/images/generations`, { ...common, body: request });
    check(Array.isArray(result.data) && result.data.length, 502, 'Image service returned no image');
    return { status: 'completed', outputs: result.data.map(item => item.b64_json
      ? { base64: item.b64_json, mimeType: 'image/png' } : item.url) };
  }
  if (provider.adapter === 'openai-videos') {
    const { aspect_ratio, images, image, ...parameters } = body;
    check(!aspect_ratio, 400, 'OpenAI Videos uses the configured size parameter');
    const references = images ?? (image ? [image] : []);
    check(references.length <= 1, 400, 'OpenAI Videos accepts at most one reference image');
    const request = { ...parameters, model: model.model,
      ...(references.length ? { input_reference: references[0] } : {}) };
    return serviceJson(`${provider.baseUrl}/videos`, { ...common, body: request });
  }
  return serviceJson(`${provider.baseUrl}/generate`, { ...common,
    body: { model: model.model, kind: model.kind, ...body } });
}

export async function pollMedia(provider, id, signal, { onProgress, intervalMs = 1000 } = {}) {
  check(typeof id === 'string' && /^[a-zA-Z0-9_.-]{1,200}$/.test(id) && !id.includes('..'), 502, 'Invalid media job ID');
  for (;;) {
    const url = provider.adapter === 'wavespeed' ? `${provider.baseUrl}/api/v3/predictions/${id}/result`
      : provider.adapter === 'openai-videos' ? `${provider.baseUrl}/videos/${encodeURIComponent(id)}`
      : `${provider.baseUrl}/jobs/${id}`;
    const response = await serviceJson(url, { apiKey: provider.apiKey, signal, limit: 96 * 1024 * 1024 });
    const result = provider.adapter === 'wavespeed' ? waveResult(response) : response;
    if (result.status === 'completed') {
      if (provider.adapter === 'openai-videos' && !result.outputs) {
        const bytes = await serviceBytes(`${provider.baseUrl}/videos/${encodeURIComponent(id)}/content`, {
          apiKey: provider.apiKey, signal, limit: 64 * 1024 * 1024,
        });
        return { ...result, outputs: [{ bytes }] };
      }
      return result;
    }
    if (['failed', 'cancelled', 'timeout'].includes(result.status))
      throw Object.assign(new HttpError(502, `Media generation ${result.status}`), { mediaStatus: result.status });
    check(['created', 'pending', 'processing', 'queued', 'in_progress'].includes(result.status), 502, 'Invalid media job status');
    await onProgress?.(result.status); await delay(intervalMs, undefined, { signal });
  }
}

function sniff(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return 'video/webm';
  return null;
}
export async function collectMedia(result, kind, signal, download = downloadMedia) {
  check(Array.isArray(result.outputs) && result.outputs.length > 0 && result.outputs.length <= 16,
    502, 'Media service returned no outputs');
  const outputs = [];
  for (const item of result.outputs) {
    let bytes;
    if (item?.bytes instanceof Uint8Array) {
      check(item.bytes.length <= 64 * 1024 * 1024, 502, 'Service response is too large');
      bytes = Buffer.isBuffer(item.bytes) ? item.bytes : Buffer.from(item.bytes);
    } else {
      const base64 = typeof item === 'object' ? item?.base64 : typeof item === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(item) ? item : undefined;
      if (base64 !== undefined) {
        check(typeof base64 === 'string' && base64.length <= 90 * 1024 * 1024
          && base64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(base64), 502, 'Invalid media encoding');
        bytes = Buffer.from(base64, 'base64');
      } else {
        const url = typeof item === 'string' ? item : item?.url;
        ({ bytes } = await download(url, { signal }));
      }
    }
    const mimeType = sniff(bytes);
    check(mimeType?.startsWith(`${kind}/`), 502, 'Media output has an unexpected format');
    outputs.push({ bytes, mimeType });
  }
  return outputs;
}

export async function extractVideoFrames(videoBase64, mimeType, { maxFrames = 8, signal } = {}) {
  const count = Math.max(1, Math.min(16, Number.isInteger(maxFrames) ? maxFrames : 8));
  const directory = await mkdtemp(join(tmpdir(), 'grokbot-video-'));
  try {
    const extension = mimeType === 'video/webm' ? 'webm' : 'mp4';
    const inputPath = join(directory, `input.${extension}`);
    await writeFile(inputPath, Buffer.from(videoBase64, 'base64'), { mode: 0o600 });
    let duration = 0;
    try {
      const { stdout } = await runFile('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', inputPath,
      ], { signal, timeout: 10_000 });
      const parsed = Number.parseFloat(stdout.trim());
      if (Number.isFinite(parsed) && parsed > 0) duration = parsed;
    } catch { /* fall back to direct frame sampling when duration is unavailable */ }
    const scale = "scale='min(1024,iw)':-2";
    const filter = duration > 0 ? `fps=${Math.max(0.1, Math.min(2, count / duration)).toFixed(4)},${scale}` : scale;
    await runFile('ffmpeg', [
      '-y', '-v', 'error', '-i', inputPath, '-vf', filter, '-frames:v', String(count), '-q:v', '4',
      join(directory, 'frame-%03d.jpg'),
    ], { signal, timeout: 30_000 });
    const files = (await readdir(directory)).filter(name => /^frame-\d+\.jpg$/.test(name)).sort();
    check(files.length > 0, 502, 'Could not extract video frames');
    return await Promise.all(files.map(async name => `data:image/jpeg;base64,${(await readFile(join(directory, name))).toString('base64')}`));
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function analyzeVideo(provider, model, input, signal, extractFrames = extractVideoFrames) {
  check(['http-json', 'openai-video-frames'].includes(provider.adapter), 400, 'Unsupported video analysis adapter');
  check(typeof input.prompt === 'string' && input.prompt.length <= 30_000 && typeof input.videoBase64 === 'string'
    && /^video\/[a-zA-Z0-9.+-]+$/.test(input.mimeType) && input.videoBase64.length % 4 === 0
    && input.videoBase64.length <= 90 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(input.videoBase64), 400, 'Invalid video analysis input');
  if (provider.adapter === 'openai-video-frames') {
    const { maxFrames = 8, ...parameters } = model.parameters ?? {};
    const frames = await extractFrames(input.videoBase64, input.mimeType, { maxFrames, signal });
    const prompt = `[Video analysis based on ${frames.length} sampled frames in chronological order]\n\n${input.prompt}`;
    const result = await serviceJson(`${provider.baseUrl}/chat/completions`, {
      apiKey: provider.apiKey, signal,
      body: {
        ...parameters, model: model.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...frames.map(url => ({ type: 'image_url', image_url: { url } }))] }],
      },
    });
    const content = result.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
    check(typeof text === 'string' && text.trim().length > 0 && text.length <= 200_000, 502, 'Invalid video analysis response');
    return { text };
  }
  const result = await serviceJson(`${provider.baseUrl}/analyze`, { apiKey: provider.apiKey, signal,
    body: { ...model.parameters, ...input, model: model.model, kind: model.kind } });
  check(typeof result.text === 'string' && result.text.length <= 200_000, 502, 'Invalid video analysis response');
  return { text: result.text };
}
