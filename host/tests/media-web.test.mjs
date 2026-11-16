import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeVideo, collectMedia, mediaInput, pollMedia, sizeForAspect, submitMedia } from '../server/media-providers.mjs';
import { describeMediaModels, validateMediaSettings } from '../server/media-settings.mjs';
import { WebServices } from '../runtime/web-services.mjs';

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
/** Replace global fetch for one test; returns the recorded requests. */
function stubFetch(t, replies) {
  const original = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return replies.shift()(); };
  t.after(() => { globalThis.fetch = original; });
  return requests;
}
const flexible = ['auto', '1024x1024', '1536x1024', '1024x1536', '1536x1152', '1152x1536', '1536x864', '864x1536'];
const imageSchema = { type: 'object', additionalProperties: false, properties: {
  prompt: { type: 'string' }, images: { type: 'array', items: { type: 'string' }, maxItems: 10 },
  size: { type: 'string', enum: flexible }, quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] } } };

test('aspect ratios map to the closest listed size', () => {
  assert.equal(sizeForAspect('1:1'), '1024x1024');
  assert.equal(sizeForAspect('16:9'), '1536x1024');
  assert.equal(sizeForAspect('3:4'), '1024x1536');
  assert.equal(sizeForAspect('16:9', flexible), '1536x864');
  assert.equal(sizeForAspect('4:3', flexible), '1536x1152');
  assert.equal(sizeForAspect('9:16', flexible), '864x1536');
  assert.throws(() => sizeForAspect('0:1'), /Invalid aspect ratio/);
});

test('OpenAI image models receive a size instead of aspect_ratio', () => {
  const plain = { parameters: { size: '1024x1024' } };
  assert.deepEqual(mediaInput(plain, { prompt: 'cat', aspectRatio: '16:9' }, 'openai-images'), { size: '1536x1024', prompt: 'cat' });
  const listed = { parameters: { size: '1024x1024', quality: 'high' }, inputSchema: imageSchema };
  assert.equal(mediaInput(listed, { prompt: 'cat', aspectRatio: '9:16' }, 'openai-images').size, '864x1536');
  // An explicit size from the model wins over the ratio.
  assert.equal(mediaInput(listed, { prompt: 'cat', aspectRatio: '9:16', parameters: { size: '1024x1024' } }, 'openai-images').size, '1024x1024');
  // Schemas that accept aspect_ratio keep it unchanged.
  const ratio = { parameters: {}, inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, aspect_ratio: { type: 'string' } } } };
  assert.deepEqual(mediaInput(ratio, { prompt: 'cat', aspectRatio: '4:3' }, 'wavespeed'), { prompt: 'cat', aspect_ratio: '4:3' });
  assert.throws(() => mediaInput(listed, { prompt: 'cat', parameters: { size: '777x777' } }, 'openai-images'), /Invalid input.size/);
});

test('reference images use the OpenAI edits endpoint', async t => {
  const requests = stubFetch(t, [() => json(200, { data: [{ b64_json: 'aGVsbG8=' }] })]);
  const model = { model: 'gpt-image-x', parameters: { size: '1024x1024', quality: 'high' }, inputSchema: imageSchema };
  const body = mediaInput(model, { prompt: 'add a hat', aspectRatio: '1:1',
    references: [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }, { mimeType: 'image/jpeg', data: '/9j/4AAQ' }] }, 'openai-images');
  const result = await submitMedia({ adapter: 'openai-images', baseUrl: 'https://api.example.com/v1', apiKey: 'k' }, model, body);
  assert.equal(requests[0].url, 'https://api.example.com/v1/images/edits');
  const form = requests[0].options.body;
  assert.ok(form instanceof FormData);
  assert.equal(requests[0].options.headers['content-type'], undefined);
  assert.deepEqual([form.get('model'), form.get('prompt'), form.get('size'), form.get('quality'), form.get('n')],
    ['gpt-image-x', 'add a hat', '1024x1024', 'high', '1']);
  const files = form.getAll('image[]');
  assert.deepEqual(files.map(file => [file.name, file.type]), [['reference-1.png', 'image/png'], ['reference-2.jpeg', 'image/jpeg']]);
  assert.deepEqual(result, { status: 'completed', outputs: [{ base64: 'aGVsbG8=', mimeType: 'image/png' }] });
});

test('text-only prompts use the generations endpoint', async t => {
  const requests = stubFetch(t, [() => json(200, { data: [{ b64_json: 'aGVsbG8=' }] })]);
  const model = { model: 'gpt-image-x', parameters: {} };
  await submitMedia({ adapter: 'openai-images', baseUrl: 'https://api.example.com/v1', apiKey: 'k' }, model,
    mediaInput(model, { prompt: 'cat', aspectRatio: '3:4' }, 'openai-images'));
  assert.equal(requests[0].url, 'https://api.example.com/v1/images/generations');
  assert.deepEqual(JSON.parse(requests[0].options.body), { prompt: 'cat', size: '1024x1536', model: 'gpt-image-x', n: 1 });
});

test('reference keys are not advertised as model parameters', () => {
  const text = describeMediaModels([{ id: 'img', name: 'Image', description: 'd', parameters: {}, inputSchema: imageSchema }]);
  assert.match(text, /"size"/);
  assert.doesNotMatch(text, /"images"/);
});

test('Anthropic web tools fall back to automatic tool choice', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'web-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'web-services.json'), JSON.stringify({ version: 1, models: [], defaults: { search: 'a', fetch: 'a' },
    providers: [{ id: 'a', name: 'A', adapter: 'anthropic-tools', baseUrl: 'https://api.example.com/v1', apiKey: 'k', enabled: true, model: 'thinking-model' }] }));
  const found = () => json(200, { content: [{ type: 'server_tool_use' },
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'Source', url: 'https://example.com/a' }] },
    { type: 'text', text: 'Answer' }] });
  const requests = stubFetch(t, [
    () => json(400, { error: { type: 'invalid_request_error', message: 'this model does not accept a forced tool choice (tool_choice type tool)' } }),
    found, found]);
  const web = new WebServices(directory);
  const result = await web.invoke('search', 'news');
  assert.deepEqual(result, { answer: 'Answer', documents: [{ title: 'Source', url: 'https://example.com/a', text: '' }] });
  const choices = requests.map(request => JSON.parse(request.options.body).tool_choice);
  assert.deepEqual(choices, [{ type: 'tool', name: 'web_search' }, { type: 'auto' }]);
  await web.invoke('search', 'more news');
  assert.deepEqual(JSON.parse(requests[2].options.body).tool_choice, { type: 'auto' });
});

test('concurrent Anthropic web calls each retry their own forced request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'web-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'web-services.json'), JSON.stringify({ version: 1, models: [], defaults: { search: 'a', fetch: 'a' },
    providers: [{ id: 'a', name: 'A', adapter: 'anthropic-tools', baseUrl: 'https://api.example.com/v1', apiKey: 'k', enabled: true, model: 'concurrent-model' }] }));
  const original = globalThis.fetch, bodies = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    if (body.tool_choice.type === 'tool') {
      // Both forced requests are in flight before either rejection is processed.
      await new Promise(resolve => setTimeout(resolve, bodies.length === 1 ? 20 : 5));
      return json(400, { error: { message: 'does not accept a forced tool choice' } });
    }
    const name = body.tools[0].name;
    return json(200, { content: [{ type: `${name}_tool_result`, content: name === 'web_search'
      ? [{ type: 'web_search_result', title: 'S', url: 'https://example.com/s' }]
      : { type: 'web_fetch_result', content: { source: { data: 'page text' } } } }, { type: 'text', text: 'ok' }] });
  };
  const web = new WebServices(directory);
  const [search, page] = await Promise.all([web.invoke('search', 'news'), web.invoke('fetch', 'https://example.com/')]);
  assert.equal(search.documents.length, 1);
  assert.equal(page.content, 'page text');
  assert.equal(bodies.filter(body => body.tool_choice.type === 'auto').length, 2);
});

test('Anthropic web search keeps successful calls when a parallel call exceeds max_uses', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'web-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'web-services.json'), JSON.stringify({ version: 1, models: [], defaults: { search: 'a', fetch: 'a' },
    providers: [{ id: 'a', name: 'A', adapter: 'anthropic-tools', baseUrl: 'https://api.example.com/v1', apiKey: 'k', enabled: true, model: 'parallel-model' }] }));
  stubFetch(t, [() => json(200, { content: [{ type: 'server_tool_use' }, { type: 'server_tool_use' },
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'Hit', url: 'https://example.com/hit' }] },
    { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    { type: 'text', text: 'Found it' }] }),
  () => json(200, { content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }] })]);
  const web = new WebServices(directory);
  assert.deepEqual(await web.invoke('search', 'news'),
    { answer: 'Found it', documents: [{ title: 'Hit', url: 'https://example.com/hit', text: '' }] });
  await assert.rejects(web.invoke('search', 'news'), /Native web search failed/);
});

test('other Anthropic web tool errors are not retried', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'web-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'web-services.json'), JSON.stringify({ version: 1, models: [], defaults: { search: 'a', fetch: 'a' },
    providers: [{ id: 'a', name: 'A', adapter: 'anthropic-tools', baseUrl: 'https://api.example.com/v1', apiKey: 'k', enabled: true, model: 'other-model' }] }));
  const requests = stubFetch(t, [() => json(400, { error: { message: 'invalid model' } })]);
  await assert.rejects(new WebServices(directory).invoke('fetch', 'https://example.com/'), /HTTP 400/);
  assert.equal(requests.length, 1);
});

test('OpenAI video models submit, poll with dotted IDs, and collect MP4 bytes', async t => {
  const mp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const requests = stubFetch(t, [
    () => json(200, { id: 'video_grok.abc.123', status: 'queued' }),
    () => json(200, { id: 'video_grok.abc.123', status: 'in_progress', progress: 50 }),
    () => json(200, { id: 'video_grok.abc.123', status: 'completed', progress: 100 }),
    () => new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4' } }),
  ]);
  const provider = { id: 'v', name: 'V', adapter: 'openai-videos', baseUrl: 'https://api.example.com/v1', apiKey: 'secret', enabled: true };
  const model = { id: 'vid', providerId: 'v', model: 'grok/grok-imagine-video', kind: 'video', enabled: true, name: 'Video', description: 'd', parameters: { seconds: 8 } };
  validateMediaSettings({ providers: [provider], models: [model], defaults: { video: 'vid' } });
  const body = mediaInput(model, { prompt: 'ocean wave', aspectRatio: '16:9',
    references: [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }] }, 'openai-videos');
  const submitted = await submitMedia(provider, model, body);
  assert.equal(submitted.id, 'video_grok.abc.123');
  assert.equal(requests[0].url, 'https://api.example.com/v1/videos');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    seconds: 8, prompt: 'ocean wave', size: '1280x720', model: 'grok/grok-imagine-video',
    input_reference: 'data:image/png;base64,iVBORw0KGgo=',
  });
  const polled = await pollMedia(provider, submitted.id, undefined, { intervalMs: 1 });
  assert.equal(requests[1].url, 'https://api.example.com/v1/videos/video_grok.abc.123');
  assert.equal(requests[3].url, 'https://api.example.com/v1/videos/video_grok.abc.123/content');
  assert.equal(requests[3].options.headers.authorization, 'Bearer secret');
  const outputs = await collectMedia(polled, 'video');
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].mimeType, 'video/mp4');
  assert.deepEqual(outputs[0].bytes, mp4);
});

test('OpenAI video frames adapter extracts frames and sends them to chat completions', async t => {
  const requests = stubFetch(t, [
    () => json(200, { choices: [{ message: { content: 'A cat walks across the room.' } }] }),
  ]);
  const provider = { id: 'vf', name: 'VF', adapter: 'openai-video-frames', baseUrl: 'https://api.example.com/v1', apiKey: 'k', enabled: true };
  const watch = { id: 'w', providerId: 'vf', model: 'grok/grok-4.7', kind: 'watchVideo', enabled: true, name: 'Watch', description: 'd', parameters: { maxFrames: 4 } };
  const review = { id: 'r', providerId: 'vf', model: 'codex/gpt-6-luna', kind: 'videoReview', enabled: true, name: 'Review', description: 'd', parameters: { maxFrames: 4 } };
  validateMediaSettings({ providers: [provider], models: [watch, review], defaults: { watchVideo: 'w', videoReview: 'r' } });
  const result = await analyzeVideo(provider, watch, {
    prompt: 'What happens?', mimeType: 'video/mp4', videoBase64: 'AAAA',
  }, undefined, async (_b64, _mime, opts) => {
    assert.equal(opts.maxFrames, 4);
    return ['data:image/jpeg;base64,/9j/1', 'data:image/jpeg;base64,/9j/2'];
  });
  assert.equal(result.text, 'A cat walks across the room.');
  assert.equal(requests[0].url, 'https://api.example.com/v1/chat/completions');
  const sent = JSON.parse(requests[0].options.body);
  assert.equal(sent.model, 'grok/grok-4.7');
  assert.equal(sent.maxFrames, undefined);
  assert.equal(sent.messages[0].content.length, 3);
  assert.equal(sent.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,/9j/1');
});
