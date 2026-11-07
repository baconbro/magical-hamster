'use strict';

/* Streaming sample-rate conversion for the speech worker.

   A polyphase windowed-sinc filter: each output sample is the input convolved
   with a low-pass kernel centred on the output's position. The cutoff sits
   just under the lower of the two Nyquist frequencies, so decimation
   (48000 -> 16000, 44100 -> 16000) does not alias. The kernel is centred, so
   the output is not delayed against the input: sample counters stay usable as
   a clock. */

// Half-width of the kernel in zero crossings of the sinc. 16 gives a
// transition band of about 2.5 kHz at 48000 -> 16000 with 108 taps.
const ZERO_CROSSINGS = 16;
// Cutoff as a fraction of the lower Nyquist frequency.
const ROLLOFF = 0.9;
// Rates with a large reduced ratio (44100 -> 48000 is 160/147, but 16001 ->
// 16000 is not small) fall back to the nearest of this many phases.
const MAX_PHASES = 2048;

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function checkRate(name, rate) {
  if (!Number.isInteger(rate) || rate <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${rate}`);
  }
}

/**
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {{ process(input: Float32Array): Float32Array, flush(): Float32Array, reset(): void }}
 *   `process` may return its argument unchanged when the rates are equal.
 *   `flush` returns the output still owed for the input so far (the filter
 *   looks about a millisecond ahead, so that much is always held back), as if
 *   silence followed, and then starts over like `reset`.
 */
function createResampler(fromRate, toRate) {
  checkRate('fromRate', fromRate);
  checkRate('toRate', toRate);
  if (fromRate === toRate) {
    return { process: (input) => input, flush: () => new Float32Array(0), reset() {} };
  }

  const divisor = gcd(fromRate, toRate);
  const up = toRate / divisor;
  const down = fromRate / divisor;
  // Cycles per input sample.
  const cutoff = 0.5 * Math.min(1, toRate / fromRate) * ROLLOFF;
  const half = Math.ceil(ZERO_CROSSINGS / (2 * cutoff));
  const taps = 2 * half;
  const phases = Math.min(up, MAX_PHASES);

  // table[p * taps + j] weighs input sample (i - half + 1 + j) for an output
  // at position i + p / phases.
  const table = new Float32Array(phases * taps);
  for (let p = 0; p < phases; p++) {
    const frac = p / phases;
    const row = p * taps;
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const d = j - half + 1 - frac;
      const sinc = d === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * d) / (Math.PI * d);
      const x = (Math.PI * d) / half;
      const blackman = 0.42 + 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
      table[row + j] = sinc * blackman;
      sum += table[row + j];
    }
    // Unity gain at DC for every phase, or the window's ripple would show up
    // as a faint tone at the output rate.
    for (let j = 0; j < taps; j++) table[row + j] /= sum;
  }

  const step = Math.floor(down / up);
  const stepRem = down % up;

  // `kept` holds the input still needed, starting at absolute index `base`.
  // The stream is treated as preceded by silence.
  let kept;
  let base;
  // The next output sits at input position `pos + phase / up`.
  let pos;
  let phase;

  function reset() {
    kept = new Float32Array(half - 1);
    base = -(half - 1);
    pos = 0;
    phase = 0;
  }
  reset();

  function process(input) {
    if (input.length === 0) return new Float32Array(0);
    const data = new Float32Array(kept.length + input.length);
    data.set(kept, 0);
    data.set(input, kept.length);
    const end = base + data.length;

    const room = Math.max(0, Math.ceil(((end - half - pos) * up) / down) + 1);
    const out = new Float32Array(room);
    let n = 0;
    // An output needs input up to pos + half.
    while (pos + half < end) {
      const first = pos - half + 1 - base;
      const row = (phases === up ? phase : Math.floor((phase * phases) / up)) * taps;
      let acc = 0;
      for (let j = 0; j < taps; j++) acc += data[first + j] * table[row + j];
      out[n++] = acc;
      pos += step;
      phase += stepRem;
      if (phase >= up) {
        phase -= up;
        pos += 1;
      }
    }

    const drop = Math.max(0, pos - half + 1 - base);
    kept = data.slice(drop);
    base += drop;
    return out.subarray(0, n);
  }

  function flush() {
    const out = process(new Float32Array(half));
    reset();
    return out;
  }

  return { process, flush, reset };
}

module.exports = { createResampler };
