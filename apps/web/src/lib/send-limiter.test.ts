import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SEND_LIMITER_OPTIONS, SendLimiter } from './send-limiter';

type Limiter = { lookahead: number; process: (channels: Float32Array[]) => void };

// The worklet is plain JavaScript in public/; evaluate it like the browser does,
// minus registerProcessor, and take its exported limiter.
function loadLimiter(): (sampleRate: number, options?: object) => Limiter {
  const source = readFileSync(resolve(process.cwd(), 'public/audio/send-limiter.js'), 'utf8');
  const module = {
    exports: {} as { createLimiter?: (sampleRate: number, options?: object) => Limiter },
  };
  new Function('module', source)(module);
  return module.exports.createLimiter!;
}

const RATE = 48_000;
const createLimiter = loadLimiter();

function sine(amplitude: number, seconds: number, hz = 220): Float32Array {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}

function run(input: Float32Array, block = 128): Float32Array {
  const limiter = createLimiter(RATE, SEND_LIMITER_OPTIONS);
  const out = Float32Array.from(input);
  for (let i = 0; i < out.length; i += block) limiter.process([out.subarray(i, i + block)]);
  return out;
}

const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('send limiter', () => {
  it('leaves headroom for a sustained over-range signal', () => {
    const out = run(sine(1.27, 1));
    expect(peak(out)).toBeLessThanOrEqual(SEND_LIMITER_OPTIONS.ceiling + 1e-6);
    // Held near the ceiling, not crushed.
    expect(peak(out.subarray(RATE / 2))).toBeGreaterThan(SEND_LIMITER_OPTIONS.ceiling * 0.95);
  });

  it('passes normal speech levels through untouched, only delayed by the lookahead', () => {
    const input = sine(0.3, 0.5);
    const out = run(input);
    const lookahead = Math.round((SEND_LIMITER_OPTIONS.lookaheadMs * RATE) / 1000);
    for (let i = lookahead; i < input.length; i += 97) {
      expect(out[i]).toBeCloseTo(input[i - lookahead]!, 6);
    }
  });

  it('turns the gain down before a sudden peak reaches the output, then recovers', () => {
    const quiet = sine(0.2, 0.3);
    const input = new Float32Array(quiet.length * 2 + RATE / 10);
    input.set(quiet, 0);
    input.set(sine(1.2, 0.1), quiet.length); // a 100 ms shout
    input.set(quiet, quiet.length + RATE / 10);
    const out = run(input);
    expect(peak(out)).toBeLessThanOrEqual(SEND_LIMITER_OPTIONS.ceiling + 1e-6);
    // Half a second after the shout, the quiet speech is back to full level.
    const tail = out.subarray(out.length - RATE / 10);
    expect(peak(tail)).toBeGreaterThan(0.19);
  });

  it('handles every channel with one gain, so stereo images stay put', () => {
    const left = sine(1.1, 0.2);
    const right = sine(0.5, 0.2);
    const limiter = createLimiter(RATE, SEND_LIMITER_OPTIONS);
    for (let i = 0; i < left.length; i += 128) {
      limiter.process([left.subarray(i, i + 128), right.subarray(i, i + 128)]);
    }
    expect(peak(left)).toBeLessThanOrEqual(SEND_LIMITER_OPTIONS.ceiling + 1e-6);
    expect(peak(right.subarray(RATE / 10))).toBeLessThan(0.5 * 0.7);
  });
});

describe('SendLimiter (Voice SDK audio processor)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubAudioContext(state: AudioContextState, addModule: () => Promise<void>) {
    const stop = vi.fn();
    const destinationStream = {
      id: 'processed',
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    const close = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn((node: unknown) => node);
    const created = { limiterNodes: 0, node: null as FakeWorkletNode | null };
    class FakeAudioContext {
      state = state;
      audioWorklet = { addModule };
      resume = vi.fn(() => new Promise<void>(() => {})); // never settles without a gesture
      close = close;
      createMediaStreamSource() {
        return { connect, disconnect: vi.fn() };
      }
      createMediaStreamDestination() {
        return { stream: destinationStream, channelCount: 2 };
      }
    }
    class FakeWorkletNode {
      port = { close: vi.fn() };
      onprocessorerror: (() => void) | null = null;
      constructor() {
        created.limiterNodes++;
        created.node = this;
      }
      connect(node: unknown) {
        return node;
      }
      disconnect = vi.fn();
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    return { destinationStream, created, close, stop, connect };
  }

  const mic = { id: 'mic' } as unknown as MediaStream;

  it('sends the limited stream when the audio engine runs', async () => {
    const { destinationStream, created, close, stop } = stubAudioContext(
      'running',
      async () => undefined,
    );
    const limiter = new SendLimiter();
    await expect(limiter.createProcessedStream(mic)).resolves.toBe(destinationStream);
    expect(created.limiterNodes).toBe(1);
    await limiter.destroyProcessedStream(destinationStream);
    expect(close).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    await limiter.destroyProcessedStream(destinationStream);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('sends the microphone unprocessed rather than silence when the engine is not allowed to start', async () => {
    vi.useFakeTimers();
    stubAudioContext('suspended', async () => undefined);
    const pending = new SendLimiter().createProcessedStream(mic);
    await vi.advanceTimersByTimeAsync(400); // resume() never settles; don't wait for it
    await expect(pending).resolves.toBe(mic);
    vi.useRealTimers();
  });

  it('sends the microphone unprocessed when the worklet cannot load', async () => {
    const { created } = stubAudioContext('running', () => Promise.reject(new Error('blocked')));
    await expect(new SendLimiter().createProcessedStream(mic)).resolves.toBe(mic);
    expect(created.limiterNodes).toBe(0);
  });

  it('does not stall call setup when the worklet download never finishes', async () => {
    vi.useFakeTimers();
    const { close, created } = stubAudioContext('running', () => new Promise(() => {}));
    const pending = new SendLimiter().createProcessedStream(mic);
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(pending).resolves.toBe(mic);
    expect(created.limiterNodes).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('bypasses a failed worklet without replacing the outgoing track', async () => {
    const { created, connect, destinationStream } = stubAudioContext(
      'running',
      async () => undefined,
    );
    const limiter = new SendLimiter();
    await expect(limiter.createProcessedStream(mic)).resolves.toBe(destinationStream);
    created.node!.onprocessorerror!();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[1]![0]).toEqual(
      expect.objectContaining({ stream: destinationStream }),
    );
    await limiter.destroyProcessedStream(destinationStream);
    expect(created.node!.onprocessorerror).toBeNull();
  });
});
