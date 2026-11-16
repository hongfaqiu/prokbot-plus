import { grokText } from './i18n.mjs';

// Desktop 1.1.0 streams 16 kHz mono PCM16 while the microphone is open and
// waits for the text when recording stops. The Host transcribes whole
// recordings, so each session is buffered here and sent once as a WAV file.
// Plain bytes only: the Android client runs this module in its WebView.
const SAMPLE_RATE = 16000;
const MAX_PCM_BYTES = 25 * 1024 * 1024 - 44; // The Host accepts up to 25 MB per recording.
const TRANSCRIBE_MS = 120000;

export function pcmWav(pcm, sampleRate = SAMPLE_RATE) {
  const wav = new Uint8Array(44 + pcm.length), view = new DataView(wav.buffer);
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + pcm.length, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return wav;
}

function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function joined(chunks, length) {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function createDictation({ request, emit }) {
  const sessions = new Map();
  let sequence = 0;
  // Like the original desktop, a superseded or cancelled session reports that it ended.
  const end = sessionId => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId); session.abort.abort();
    emit({ sessionId, isEnded: true });
  };
  return {
    startDictation: ({ language } = {}) => {
      for (const sessionId of [...sessions.keys()]) end(sessionId);
      const sessionId = `dictation-${++sequence}`;
      sessions.set(sessionId, { language: language || null, chunks: [], bytes: 0, overflow: false, abort: new AbortController() });
      return { sessionId };
    },
    pushDictationAudio: ({ sessionId, pcm16 }) => {
      const session = sessions.get(sessionId);
      if (!session || session.overflow) return null;
      const chunk = (ArrayBuffer.isView(pcm16) ? new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength) : new Uint8Array(pcm16)).slice();
      if (session.bytes + chunk.length > MAX_PCM_BYTES) { session.overflow = true; return null; }
      session.chunks.push(chunk); session.bytes += chunk.length;
      return null;
    },
    stopDictation: async ({ sessionId }) => {
      const session = sessions.get(sessionId);
      if (!session) return { text: '' };
      const timer = setTimeout(() => session.abort.abort(new DOMException('Transcription timed out.', 'TimeoutError')), TRANSCRIBE_MS);
      try {
        if (session.overflow) throw new Error(grokText('录音太长，请分段输入。', 'The recording is too long. Dictate in shorter parts.'));
        if (session.bytes === 0) return { text: '' };
        const result = await request('/local/audio/transcriptions', {
          audioBase64: base64(pcmWav(joined(session.chunks, session.bytes))), mimeType: 'audio/wav',
          ...(session.language ? { language: session.language } : {}),
        }, session.abort.signal);
        return { text: typeof result?.text === 'string' ? result.text : '' };
      } finally {
        clearTimeout(timer);
        if (sessions.get(sessionId) === session) sessions.delete(sessionId);
      }
    },
    cancelDictation: ({ sessionId }) => { end(sessionId); return null; },
  };
}
