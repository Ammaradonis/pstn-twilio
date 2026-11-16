// Audio for Twilio <Play>: browsers record WebM/Opus or MP4/AAC, which Twilio
// can't play, so recordings and uploaded files become 8 kHz mono 16-bit WAV
// (the phone network's own rate, so nothing is lost on the way).

export interface WavAudio {
  blob: Blob;
  durationMs: number;
  /** Loudest sample before levelling, 0-1. Near 0 means the microphone heard nothing. */
  peak: number;
}

export interface MicRecording {
  /** Stops and returns what was recorded, in the browser's own format. */
  stop: () => Promise<Blob>;
  cancel: () => void;
}

// Fallbacks for browsers whose OfflineAudioContext refuses 8 kHz.
const SAMPLE_RATES = [8000, 11025, 16000];

/**
 * Records the microphone until stop() or maxMs. onLevel gets the input level
 * (0-1) about 20 times a second, for a meter; onLimit fires if maxMs is hit.
 */
export async function startMicRecording(opts: {
  maxMs: number;
  deviceId?: string;
  onLevel?: (level: number) => void;
  onLimit?: () => void;
}): Promise<MicRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(opts.deviceId ? { deviceId: { ideal: opts.deviceId } } : {}),
    },
  });
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream);
  } catch (err) {
    stream.getTracks().forEach((track) => track.stop());
    throw err;
  }
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const finished = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  const stopMeter = opts.onLevel ? meter(stream, opts.onLevel) : () => undefined;
  recorder.start();

  const release = () => {
    stopMeter();
    stream.getTracks().forEach((track) => track.stop());
  };
  const limit = setTimeout(() => {
    if (recorder.state !== 'inactive') {
      recorder.stop();
      opts.onLimit?.();
    }
  }, opts.maxMs);

  return {
    async stop() {
      clearTimeout(limit);
      if (recorder.state !== 'inactive') recorder.stop();
      await finished;
      release();
      return new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || 'audio/webm' });
    },
    cancel() {
      clearTimeout(limit);
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
  };
}

function meter(stream: MediaStream, onLevel: (level: number) => void): () => void {
  let context: AudioContext;
  try {
    context = new (audioContextClass())();
  } catch {
    return () => undefined;
  }
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    // RMS of speech sits around 0.05-0.2; stretch it so the meter moves.
    onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 5));
  }, 50);
  return () => {
    clearInterval(timer);
    void context.close();
  };
}

/**
 * Converts any audio the browser can decode to 8 kHz mono WAV. With tidy, the
 * silence before and after the speech is trimmed and the level is raised so
 * the loudest part sits just under full scale.
 */
export async function audioToWav(source: Blob, opts: { tidy?: boolean } = {}): Promise<WavAudio> {
  const decoder = new (audioContextClass())();
  let decoded: AudioBuffer;
  try {
    decoded = await decoder.decodeAudioData(await source.arrayBuffer());
  } finally {
    void decoder.close();
  }
  let lastError: unknown = null;
  for (const rate of SAMPLE_RATES) {
    try {
      const offline = new OfflineAudioContext(
        1,
        Math.max(1, Math.ceil(decoded.duration * rate)),
        rate,
      );
      const node = offline.createBufferSource();
      node.buffer = decoded;
      node.connect(offline.destination);
      node.start();
      const rendered = await offline.startRendering();
      const raw = rendered.getChannelData(0);
      const peak = peakOf(raw);
      const samples = opts.tidy ? tidySamples(raw, rate) : raw;
      return {
        blob: encodeWav(samples, rate),
        durationMs: (samples.length / rate) * 1000,
        peak,
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not convert the audio');
}

const LEAD_PAD_MS = 200;
const TAIL_PAD_MS = 400;
// Speech starts where the signal first passes this share of the peak.
const SPEECH_THRESHOLD = 0.06;
const TARGET_PEAK = 0.89; // -1 dBFS
const MAX_GAIN = 8;

/** Trims leading/trailing silence and levels the peak; silence comes back as is. */
export function tidySamples(samples: Float32Array, sampleRate: number): Float32Array {
  const peak = peakOf(samples);
  if (peak < 1e-4) return samples;
  const threshold = peak * SPEECH_THRESHOLD;
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]!) < threshold) first += 1;
  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last]!) < threshold) last -= 1;
  const start = Math.max(0, first - Math.round((LEAD_PAD_MS / 1000) * sampleRate));
  const end = Math.min(samples.length, last + 1 + Math.round((TAIL_PAD_MS / 1000) * sampleRate));
  const gain = Math.min(MAX_GAIN, TARGET_PEAK / peak);
  const out = new Float32Array(end - start);
  for (let i = 0; i < out.length; i += 1) out[i] = samples[start + i]! * gain;
  return out;
}

function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  return peak;
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

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function audioContextClass(): typeof AudioContext {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  );
}
