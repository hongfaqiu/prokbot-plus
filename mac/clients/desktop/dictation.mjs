import { grokText } from './i18n.mjs';

// Desktop 1.1.0 streams 16 kHz mono PCM16 while the microphone is open and
// waits for the text when recording stops. The Host transcribes whole
// recordings, so each session is buffered here and sent once as a WAV file.
const SAMPLE_RATE = 16000;
const MAX_PCM_BYTES = 25 * 1024 * 1024 - 44; // The Host accepts up to 25 MB per recording.

export function pcmWav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
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
      const chunk = Buffer.from(pcm16);
      if (session.bytes + chunk.length > MAX_PCM_BYTES) { session.overflow = true; return null; }
      session.chunks.push(chunk); session.bytes += chunk.length;
      return null;
    },
    stopDictation: async ({ sessionId }) => {
      const session = sessions.get(sessionId);
      if (!session) return { text: '' };
      try {
        if (session.overflow) throw new Error(grokText('录音太长，请分段输入。', 'The recording is too long. Dictate in shorter parts.'));
        if (session.bytes === 0) return { text: '' };
        const result = await request('/local/audio/transcriptions', {
          audioBase64: pcmWav(Buffer.concat(session.chunks)).toString('base64'), mimeType: 'audio/wav',
          ...(session.language ? { language: session.language } : {}),
        }, AbortSignal.any([session.abort.signal, AbortSignal.timeout(120000)]));
        return { text: typeof result?.text === 'string' ? result.text : '' };
      } finally {
        if (sessions.get(sessionId) === session) sessions.delete(sessionId);
      }
    },
    cancelDictation: ({ sessionId }) => { end(sessionId); return null; },
  };
}
