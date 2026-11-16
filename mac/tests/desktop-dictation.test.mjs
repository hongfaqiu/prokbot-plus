import assert from 'node:assert/strict';
import test from 'node:test';
import { createDictation, pcmWav } from '../clients/desktop/dictation.mjs';

test('streamed dictation is sent to the Host once as a 16 kHz mono WAV recording', async () => {
  const requests = [], events = [];
  const dictation = createDictation({ emit: value => events.push(value),
    request: async (endpoint, body, signal) => { requests.push({ endpoint, body, signal }); return { text: ' 你好 ', provider: 'fixture' }; } });
  const { sessionId } = dictation.startDictation({ language: 'zh' });
  dictation.pushDictationAudio({ sessionId, pcm16: new Uint8Array([1, 0, 2, 0]) });
  dictation.pushDictationAudio({ sessionId, pcm16: new Uint8Array([3, 0]).buffer });
  dictation.pushDictationAudio({ sessionId: 'unknown', pcm16: new Uint8Array([9, 9]) });
  assert.deepEqual(await dictation.stopDictation({ sessionId }), { text: ' 你好 ' });
  assert.equal(requests.length, 1);
  const { endpoint, body } = requests[0];
  assert.equal(endpoint, '/local/audio/transcriptions');
  assert.equal(body.mimeType, 'audio/wav');
  assert.equal(body.language, 'zh');
  const wav = Buffer.from(body.audioBase64, 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.deepEqual([...wav.subarray(44)], [1, 0, 2, 0, 3, 0]);
  assert.deepEqual(events, []);
  assert.deepEqual(await dictation.stopDictation({ sessionId }), { text: '' }, 'a finished session has nothing left');
});

test('a new, cancelled or silent dictation never reaches the Host and ends the earlier session', async () => {
  const requests = [], events = [];
  const dictation = createDictation({ emit: value => events.push(value), request: async () => { requests.push(1); return { text: 'x' }; } });
  const first = dictation.startDictation();
  dictation.pushDictationAudio({ sessionId: first.sessionId, pcm16: new Uint8Array([1, 0]) });
  const second = dictation.startDictation({});
  assert.notEqual(second.sessionId, first.sessionId);
  assert.deepEqual(events, [{ sessionId: first.sessionId, isEnded: true }]);
  assert.deepEqual(await dictation.stopDictation(first), { text: '' });
  assert.deepEqual(await dictation.stopDictation(second), { text: '' }, 'no audio');
  const third = dictation.startDictation();
  dictation.pushDictationAudio({ sessionId: third.sessionId, pcm16: new Uint8Array([1, 0]) });
  dictation.cancelDictation(third);
  assert.deepEqual(await dictation.stopDictation(third), { text: '' });
  assert.equal(requests.length, 0);
});

test('cancelling while the Host transcribes aborts the request', async () => {
  let seen;
  const dictation = createDictation({ emit: () => {}, request: (_endpoint, _body, signal) => {
    seen = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  } });
  const { sessionId } = dictation.startDictation();
  dictation.pushDictationAudio({ sessionId, pcm16: new Uint8Array([1, 0]) });
  const pending = dictation.stopDictation({ sessionId });
  dictation.cancelDictation({ sessionId });
  await assert.rejects(pending);
  assert.equal(seen.aborted, true);
});

test('WAV header sizes follow the PCM length', () => {
  const wav = pcmWav(new Uint8Array(10), 8000), view = new DataView(wav.buffer);
  assert.equal(wav.length, 54);
  assert.equal(view.getUint32(4, true), 46);
  assert.equal(view.getUint32(28, true), 16000);
  assert.equal(view.getUint32(40, true), 10);
});

test('the module needs no Node built-ins, so the Android WebView shares it', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../clients/desktop/dictation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bBuffer\b|node:|AbortSignal\.(any|timeout)/);
});
