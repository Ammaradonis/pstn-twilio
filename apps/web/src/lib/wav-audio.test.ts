import { describe, expect, it } from 'vitest';

import { encodeWav, tidySamples } from './wav-audio';

const RATE = 8000;

function signal(parts: Array<{ ms: number; amplitude: number }>): Float32Array {
  const total = parts.reduce((n, p) => n + Math.round((p.ms / 1000) * RATE), 0);
  const out = new Float32Array(total);
  let i = 0;
  for (const part of parts) {
    const n = Math.round((part.ms / 1000) * RATE);
    for (let k = 0; k < n; k += 1, i += 1) out[i] = part.amplitude * (k % 2 ? 1 : -1);
  }
  return out;
}

// jsdom's Blob has no arrayBuffer().
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function peak(samples: Float32Array): number {
  return samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
}

describe('tidySamples', () => {
  it('trims silence around the speech, keeping a little padding', () => {
    const input = signal([
      { ms: 1500, amplitude: 0.001 },
      { ms: 2000, amplitude: 0.3 },
      { ms: 2000, amplitude: 0.001 },
    ]);
    const out = tidySamples(input, RATE);
    // 200 ms before + 2 s of speech + 400 ms after.
    expect(out.length / RATE).toBeCloseTo(2.6, 2);
  });

  it('levels the loudest sample to just under full scale', () => {
    const out = tidySamples(signal([{ ms: 500, amplitude: 0.2 }]), RATE);
    expect(peak(out)).toBeCloseTo(0.89, 3);
  });

  it('never boosts more than 8x, so a quiet take does not become noise', () => {
    const out = tidySamples(signal([{ ms: 500, amplitude: 0.01 }]), RATE);
    expect(peak(out)).toBeCloseTo(0.08, 3);
  });

  it('returns silence untouched', () => {
    const silent = new Float32Array(800);
    expect(tidySamples(silent, RATE)).toBe(silent);
  });
});

describe('encodeWav', () => {
  it('writes an 8 kHz mono 16-bit PCM header', async () => {
    const blob = encodeWav(new Float32Array([0, 1, -1]), RATE);
    const view = new DataView(await readBlob(blob));
    const text = (at: number) =>
      String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)));
    expect(blob.type).toBe('audio/wav');
    expect(text(0)).toBe('RIFF');
    expect(text(8)).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(46, true)).toBe(0x7fff);
    expect(view.getInt16(48, true)).toBe(-0x8000);
  });
});
