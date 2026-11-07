/* The audio-thread half of the microphone path. It gathers the 128-frame render
   quanta into 100 ms blocks of 16-bit PCM, the frame size the speech worker's
   cadence is tuned for, and posts each block with its peak level.

   micCapture.ts loads this file as text through a Blob URL, so it cannot
   import anything: the conversion below repeats floatToInt16 from
   src/stt/protocol.ts and must stay in step with it. The names the worklet
   scope provides are declared for the type checker in pcm-worklet-scope.d.ts. */

const QUANTUM_FRAMES = 128;
const SILENCE = new Float32Array(QUANTUM_FRAMES);

class HamsterPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global of the worklet scope: the context's real rate.
    this.blockFrames = Math.max(1, Math.round(sampleRate / 10));
    this.block = new Int16Array(this.blockFrames);
    this.filled = 0;
    this.peak = 0;
  }

  /** @param {Float32Array[][]} inputs Per input, one array per channel. */
  process(inputs) {
    // An input has no channel while its source is not producing (a muted
    // track, a node being disconnected). Counting those quanta as silence
    // keeps the sample clock, which is the transcript's clock, on real time.
    const input = (inputs[0] && inputs[0][0]) || SILENCE;
    for (let i = 0; i < input.length; i++) {
      const s = input[i];
      let value = 0;
      if (s >= 1) value = 32767;
      else if (s <= -1) value = -32768;
      else if (!Number.isNaN(s)) value = Math.round(s * (s < 0 ? 32768 : 32767));

      // NaN fails both comparisons and leaves the peak alone.
      const magnitude = s < 0 ? -s : s;
      if (magnitude > this.peak) this.peak = magnitude;

      this.block[this.filled++] = value;
      if (this.filled === this.blockFrames) this.post();
    }
    // Keeps the processor alive for as long as the node exists.
    return true;
  }

  post() {
    const pcm = this.block.buffer;
    this.port.postMessage({ pcm, peak: Math.min(1, this.peak) }, [pcm]);
    // The buffer left with the message: the next block needs its own.
    this.block = new Int16Array(this.blockFrames);
    this.filled = 0;
    this.peak = 0;
  }
}

registerProcessor('hamster-pcm', HamsterPcmProcessor);
