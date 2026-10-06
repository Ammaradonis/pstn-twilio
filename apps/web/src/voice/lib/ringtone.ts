/**
 * Ringtones and keypad tones, synthesized with Web Audio so nothing has to be
 * downloaded before a call can ring. Browsers only allow sound after the user
 * has touched the page, so the app calls unlockAudio() on the first tap.
 */

export type RingtoneId = 'voice' | 'classic' | 'marimba' | 'chime' | 'digital' | 'silent';

export const RINGTONES: Array<{ id: RingtoneId; label: string }> = [
  { id: 'voice', label: 'Voice' },
  { id: 'classic', label: 'Classic phone' },
  { id: 'marimba', label: 'Marimba' },
  { id: 'chime', label: 'Chime' },
  { id: 'digital', label: 'Digital' },
  { id: 'silent', label: 'Silent' },
];

interface Note {
  at: number;
  freq: number | [number, number];
  length: number;
  wave?: OscillatorType;
  gain?: number;
  // Seconds over which the note fades; short for plucked sounds.
  decay?: number;
  tremolo?: number;
}

const PATTERNS: Record<Exclude<RingtoneId, 'silent'>, { period: number; notes: Note[] }> = {
  voice: {
    period: 2.2,
    notes: [
      { at: 0, freq: 784, length: 0.14, decay: 0.12 },
      { at: 0.16, freq: 1047, length: 0.2, decay: 0.18 },
      { at: 0.5, freq: 784, length: 0.14, decay: 0.12 },
      { at: 0.66, freq: 1047, length: 0.2, decay: 0.18 },
    ],
  },
  classic: {
    period: 3,
    notes: [
      { at: 0, freq: [440, 480], length: 0.45, tremolo: 24, gain: 0.35 },
      { at: 0.6, freq: [440, 480], length: 0.45, tremolo: 24, gain: 0.35 },
    ],
  },
  marimba: {
    period: 1.8,
    notes: [523, 659, 784, 1047, 784, 659].map((freq, i) => ({
      at: i * 0.12,
      freq,
      length: 0.22,
      wave: 'triangle' as const,
      decay: 0.2,
      gain: 0.6,
    })),
  },
  chime: {
    period: 2.6,
    notes: [
      { at: 0, freq: 1175, length: 1, decay: 0.9, gain: 0.45 },
      { at: 0.35, freq: 1568, length: 1.2, decay: 1.1, gain: 0.4 },
    ],
  },
  digital: {
    period: 1.6,
    notes: [0, 0.12, 0.24, 0.36].map((at) => ({
      at,
      freq: 1320,
      length: 0.07,
      wave: 'square' as const,
      gain: 0.18,
    })),
  },
};

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  context ??= new Ctor();
  return context;
}

/** Call from a tap so later ringing is allowed to make sound. */
export function unlockAudio(): void {
  const ctx = audioContext();
  if (ctx?.state === 'suspended') void ctx.resume().catch(() => undefined);
}

/**
 * Whether our synthesized tones can actually be heard right now. Browsers keep
 * an AudioContext suspended until the user has interacted with the page, so
 * before the first tap anything we play is silent.
 */
export function canPlayAudio(): boolean {
  const ctx = audioContext();
  return Boolean(ctx && ctx.state === 'running');
}

function playNote(ctx: AudioContext, destination: AudioNode, note: Note, start: number): void {
  const freqs = Array.isArray(note.freq) ? note.freq : [note.freq];
  const gain = ctx.createGain();
  const peak = (note.gain ?? 0.5) / freqs.length;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.01);
  const end = start + note.length;
  if (note.decay) {
    gain.gain.exponentialRampToValueAtTime(0.0001, start + note.decay);
  } else {
    gain.gain.setValueAtTime(peak, end - 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
  }
  let output: AudioNode = gain;
  if (note.tremolo) {
    const tremolo = ctx.createGain();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = note.tremolo;
    depth.gain.value = 0.5;
    tremolo.gain.value = 0.5;
    lfo.connect(depth).connect(tremolo.gain);
    gain.connect(tremolo);
    output = tremolo;
    lfo.start(start);
    lfo.stop(end + 0.05);
  }
  output.connect(destination);
  for (const freq of freqs) {
    const osc = ctx.createOscillator();
    osc.type = note.wave ?? 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(start);
    osc.stop(end + 0.05);
  }
}

// A hidden tab has its timers throttled to roughly one tick per second, which
// would make a setInterval-per-cycle ringtone stutter or stall. Scheduling a few
// cycles ahead keeps the sound even while the page is in the background.
const LOOKAHEAD_CYCLES = 4;
const LOOKAHEAD_BATCH = 2;

function startLoop(pattern: { period: number; notes: Note[] }): () => void {
  const ctx = audioContext();
  if (!ctx) return () => undefined;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  let scheduled = 0;
  let stopped = false;
  const startAt = ctx.currentTime + 0.05;
  const schedule = () => {
    if (stopped) return;
    const horizon = ctx.currentTime + pattern.period * LOOKAHEAD_CYCLES;
    while (startAt + scheduled * pattern.period < horizon) {
      const cycleStart = startAt + scheduled * pattern.period;
      for (const note of pattern.notes) playNote(ctx, master, note, cycleStart + note.at);
      scheduled += 1;
      if (!stopped && scheduled % LOOKAHEAD_BATCH === 0) return;
    }
  };
  schedule();
  const timer = setInterval(schedule, (pattern.period * 1000) / 2);
  return () => {
    stopped = true;
    clearInterval(timer);
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + 0.05);
    setTimeout(() => master.disconnect(), 200);
  };
}

/** Plays a ringtone until the returned function is called. */
export function startRingtone(id: RingtoneId, options: { once?: boolean } = {}): () => void {
  if (id === 'silent') return () => undefined;
  if (options.once) {
    const pattern = PATTERNS[id];
    const ctx = audioContext();
    if (!ctx) return () => undefined;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    for (const note of pattern.notes)
      playNote(ctx, ctx.destination, note, ctx.currentTime + note.at);
    return () => undefined;
  }
  return startLoop(PATTERNS[id]);
}

/**
 * The tone you hear while the other end is ringing. It is deliberately not one
 * of the ringtones above: the network's "ring… ring…" is slower and duller than
 * a phone ringing in the room, so it reads as "we are calling them" rather than
 * "somebody is calling me".
 */
const RINGBACK: { period: number; notes: Note[] } = {
  period: 6,
  notes: [
    { at: 0, freq: [440, 480], length: 2, gain: 0.22 },
    { at: 3, freq: [440, 480], length: 2, gain: 0.22 },
  ],
};

/** Plays the outbound ringback until the returned function is called. */
export function startRingback(): () => void {
  return startLoop(RINGBACK);
}

/** A short tone when a call ends, so a dropped call is noticed. */
export function playEndTone(): void {
  const ctx = audioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  playNote(ctx, ctx.destination, { at: 0, freq: 620, length: 0.16, gain: 0.3 }, ctx.currentTime);
  playNote(ctx, ctx.destination, { at: 0.19, freq: 466, length: 0.3, gain: 0.3 }, ctx.currentTime);
}

const DTMF: Record<string, [number, number]> = {
  '1': [697, 1209],
  '2': [697, 1336],
  '3': [697, 1477],
  '4': [770, 1209],
  '5': [770, 1336],
  '6': [770, 1477],
  '7': [852, 1209],
  '8': [852, 1336],
  '9': [852, 1477],
  '*': [941, 1209],
  '0': [941, 1336],
  '#': [941, 1477],
};

/** The short tone a phone keypad makes. */
export function playKeyTone(key: string): void {
  const freq = DTMF[key];
  const ctx = audioContext();
  if (!freq || !ctx) return;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  playNote(ctx, ctx.destination, { at: 0, freq, length: 0.12, gain: 0.16 }, ctx.currentTime);
}

// Vibration that follows the ring: on, off, on, long pause.
export const RING_VIBRATION = [700, 300, 700, 1500];

export function vibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
  } catch {
    /* not allowed before the first tap */
  }
}
