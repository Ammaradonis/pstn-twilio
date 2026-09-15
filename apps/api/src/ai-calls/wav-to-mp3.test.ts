import { describe, expect, it } from 'vitest';

import { isMp3, isWav, readPcmWav, wavToMp3 } from './wav-to-mp3';

function wav({
  sampleRate = 16000,
  channels = 1,
  seconds = 1,
  bitsPerSample = 16,
}: { sampleRate?: number; channels?: number; seconds?: number; bitsPerSample?: number } = {}) {
  const frames = sampleRate * seconds;
  const dataBytes = frames * channels * (bitsPerSample / 8);
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buf.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  if (bitsPerSample === 16) {
    for (let i = 0; i < frames; i++) {
      // 440 Hz tone, left and right opposite so a downmix is silent.
      const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
      for (let c = 0; c < channels; c++) {
        buf.writeInt16LE(c === 1 ? -sample : sample, 44 + (i * channels + c) * 2);
      }
    }
  }
  return buf;
}

describe('wav-to-mp3', () => {
  it('detects formats', () => {
    expect(isWav(wav())).toBe(true);
    expect(isMp3(wav())).toBe(false);
    expect(isMp3(Buffer.from('ID3'))).toBe(true);
    expect(isMp3(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe(true);
  });

  it('reads PCM and downmixes stereo to mono', () => {
    expect(readPcmWav(wav({ sampleRate: 24000 }))).toMatchObject({ sampleRate: 24000 });
    const stereo = readPcmWav(wav({ channels: 2 }));
    expect(stereo.samples.length).toBe(16000);
    expect(Math.max(...stereo.samples.slice(0, 2000).map(Math.abs))).toBe(0);
  });

  it('encodes a one-second recording to a real MP3', async () => {
    const mp3 = await wavToMp3(wav({ sampleRate: 16000, seconds: 1 }));
    expect(isMp3(mp3)).toBe(true);
    // 64 kbps for one second is roughly 8 KB.
    expect(mp3.length).toBeGreaterThan(4000);
    expect(mp3.length).toBeLessThan(12000);
  });

  it('rejects audio it cannot convert', async () => {
    await expect(wavToMp3(Buffer.from('not audio'))).rejects.toThrow('Not a WAV file');
    await expect(wavToMp3(wav({ bitsPerSample: 8 }))).rejects.toThrow('16-bit PCM');
    await expect(wavToMp3(wav({ sampleRate: 16001 }))).rejects.toThrow('Unsupported sample rate');
  });
});
