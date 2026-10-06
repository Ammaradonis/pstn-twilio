// Records a voicemail greeting and turns it into the 8 kHz mono WAV that
// Twilio's <Play> accepts (browsers record WebM/MP4, which Twilio can't play).

export interface RecordedGreeting {
  wavBase64: string;
  durationMs: number;
  previewUrl: string;
}

export interface GreetingRecorder {
  stop: () => Promise<RecordedGreeting>;
  cancel: () => void;
}

const SAMPLE_RATES = [8000, 11025, 16000];

export async function startGreetingRecording(maxMs: number): Promise<GreetingRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const startedAt = Date.now();
  recorder.start();
  const stopTracks = () => stream.getTracks().forEach((track) => track.stop());
  const finished = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  const limit = setTimeout(() => {
    if (recorder.state === 'recording') recorder.stop();
  }, maxMs);

  return {
    async stop() {
      clearTimeout(limit);
      if (recorder.state === 'recording') recorder.stop();
      await finished;
      stopTracks();
      const recorded = new Blob(chunks, { type: recorder.mimeType });
      const wav = await toWav(recorded);
      const durationMs = Math.min(maxMs, Math.max(Date.now() - startedAt, wav.durationMs));
      return {
        wavBase64: await blobToBase64(wav.blob),
        durationMs: Math.round(Math.min(durationMs, wav.durationMs || durationMs)),
        previewUrl: URL.createObjectURL(wav.blob),
      };
    },
    cancel() {
      clearTimeout(limit);
      if (recorder.state === 'recording') recorder.stop();
      stopTracks();
    },
  };
}

async function toWav(blob: Blob): Promise<{ blob: Blob; durationMs: number }> {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const decoder = new Ctor();
  const decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
  void decoder.close();
  let lastError: unknown = null;
  for (const rate of SAMPLE_RATES) {
    try {
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start();
      const rendered = await offline.startRendering();
      return {
        blob: encodeWav(rendered.getChannelData(0), rate),
        durationMs: decoded.duration * 1000,
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not convert the recording');
}

/** 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
