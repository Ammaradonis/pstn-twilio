/* eslint-disable no-undef */
// Peak limiter for the microphone audio a call sends (see src/lib/send-limiter.ts).
//
// Leaves headroom before encoding. It cannot repair distortion already captured
// by the microphone or network/carrier impairments. It looks ahead a few
// milliseconds and lowers the gain before a peak arrives, then lets the gain
// recover. Below the ceiling it does nothing: no compression, no make-up gain.
//
// Loaded with audioWorklet.addModule; plain JavaScript because worklets can't
// import the app's modules. createLimiter is also used by the unit tests.

function createLimiter(sampleRate, options) {
  const o = options || {};
  const ceiling = o.ceiling ?? 0.708; // -3 dBFS
  const lookahead = Math.max(1, Math.round(((o.lookaheadMs ?? 5) * sampleRate) / 1000));
  const attack = Math.exp(-1 / (((o.attackMs ?? 1) * sampleRate) / 1000));
  const release = Math.exp(-1 / (((o.releaseMs ?? 100) * sampleRate) / 1000));
  // Each channel's delay line, so audio reaches the output `lookahead` samples late.
  const delays = [];
  let pos = 0;
  // Monotonic queue of the gains needed over the lookahead window (its front
  // is the smallest), so the window minimum costs O(1) per sample.
  const qGain = new Float64Array(lookahead + 2);
  const qAt = new Float64Array(lookahead + 2);
  let head = 0;
  let tail = 0;
  let t = 0;
  let gain = 1;
  const size = lookahead + 2;

  return {
    lookahead,
    /** Processes one block in place: channels is an array of Float32Arrays. */
    process(channels) {
      const length = channels.length ? channels[0].length : 0;
      while (delays.length < channels.length) delays.push(new Float32Array(lookahead));
      for (let i = 0; i < length; i++, t++) {
        let peak = 0;
        for (let c = 0; c < channels.length; c++) peak = Math.max(peak, Math.abs(channels[c][i]));
        const need = peak > ceiling ? ceiling / peak : 1;
        while (tail !== head && qGain[(tail - 1 + size) % size] >= need)
          tail = (tail - 1 + size) % size;
        qGain[tail] = need;
        qAt[tail] = t;
        tail = (tail + 1) % size;
        // The sample leaving the delay line now entered `lookahead` samples ago.
        while (qAt[head] < t - lookahead) head = (head + 1) % size;
        const target = qGain[head];
        gain =
          target < gain ? target + (gain - target) * attack : target + (gain - target) * release;
        for (let c = 0; c < channels.length; c++) {
          const line = delays[c];
          let out = line[pos] * gain;
          line[pos] = channels[c][i];
          // The one-pole attack can trail a sudden peak by a hair; never let it through.
          if (out > ceiling) out = ceiling;
          else if (out < -ceiling) out = -ceiling;
          channels[c][i] = out;
        }
        pos = (pos + 1) % lookahead;
      }
    },
  };
}

if (typeof registerProcessor === 'function') {
  class SendLimiter extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.limiter = createLimiter(sampleRate, options && options.processorOptions);
    }

    process(inputs, outputs) {
      const input = inputs[0];
      const output = outputs[0];
      if (!input || !input.length) return true;
      for (let c = 0; c < output.length; c++) output[c].set(input[Math.min(c, input.length - 1)]);
      this.limiter.process(output);
      return true;
    }
  }
  registerProcessor('send-limiter', SendLimiter);
}

if (typeof module !== 'undefined') module.exports = { createLimiter };
