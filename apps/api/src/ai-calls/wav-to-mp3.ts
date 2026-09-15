// Converts a PCM WAV recording to MP3 with a pure-JS LAME encoder, so older
// Vapi recordings (stored as WAV) download as MP3 like new ones.

interface Mp3EncoderInstance {
  encodeBuffer(left: Int16Array): Int8Array | Uint8Array;
  flush(): Int8Array | Uint8Array;
}
type Mp3EncoderCtor = new (
  channels: number,
  sampleRate: number,
  kbps: number,
) => Mp3EncoderInstance;

const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const FRAME_SAMPLES = 1152;

let encoderCtor: Promise<Mp3EncoderCtor> | null = null;

// The package's CommonJS build doesn't export anything; load its ESM build
// with a real dynamic import that TypeScript won't rewrite into require().
function loadEncoder(): Promise<Mp3EncoderCtor> {
  encoderCtor ??= (
    new Function('specifier', 'return import(specifier)') as (s: string) => Promise<unknown>
  )('@breezystack/lamejs').then((mod) => (mod as { Mp3Encoder: Mp3EncoderCtor }).Mp3Encoder);
  return encoderCtor;
}

export function isWav(buffer: Buffer): boolean {
  return (
    buffer.length > 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  );
}

export function isMp3(buffer: Buffer): boolean {
  if (buffer.length < 3) return false;
  if (buffer.toString('ascii', 0, 3) === 'ID3') return true;
  return buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0;
}

interface PcmAudio {
  sampleRate: number;
  samples: Int16Array; // mono
}

export function readPcmWav(buffer: Buffer): PcmAudio {
  if (!isWav(buffer)) throw new Error('Not a WAV file');
  let offset = 12;
  let format: {
    audioFormat: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
  } | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, Math.min(buffer.length, offset + 8 + size));
    if (id === 'fmt ') {
      format = {
        audioFormat: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bitsPerSample: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      data = body;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!format || !data) throw new Error('WAV file is missing its format or data');
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) {
    throw new Error('Only 16-bit PCM WAV recordings can be converted');
  }
  const frames = Math.floor(data.length / (2 * format.channels));
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < format.channels; c++)
      sum += data.readInt16LE((i * format.channels + c) * 2);
    samples[i] = Math.round(sum / format.channels);
  }
  return { sampleRate: format.sampleRate, samples };
}

export async function wavToMp3(buffer: Buffer): Promise<Buffer> {
  const { sampleRate, samples } = readPcmWav(buffer);
  if (!MP3_SAMPLE_RATES.includes(sampleRate)) {
    throw new Error(`Unsupported sample rate for MP3: ${sampleRate}`);
  }
  const Mp3Encoder = await loadEncoder();
  const encoder = new Mp3Encoder(1, sampleRate, sampleRate <= 12000 ? 32 : 64);
  const chunks: Buffer[] = [];
  for (let i = 0; i < samples.length; i += FRAME_SAMPLES) {
    const encoded = encoder.encodeBuffer(samples.subarray(i, i + FRAME_SAMPLES));
    if (encoded.length > 0)
      chunks.push(Buffer.from(encoded.buffer, encoded.byteOffset, encoded.length));
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(Buffer.from(tail.buffer, tail.byteOffset, tail.length));
  return Buffer.concat(chunks);
}
