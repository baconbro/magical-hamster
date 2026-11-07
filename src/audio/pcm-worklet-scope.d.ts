/* The names an AudioWorkletGlobalScope gives pcm-worklet.js, which no
   TypeScript lib declares. They are declared on that file alone, as exports
   it is seen to have, because module exports are in scope in the module's own
   body: as globals they would also type-check in the renderer, where none of
   them exists. Nothing imports pcm-worklet.js as a module (it is loaded as
   text), so the exports are never looked for at runtime. */

export {};

declare module './pcm-worklet.js' {
  export class AudioWorkletProcessor {
    /** Talks to the AudioWorkletNode's own port in the renderer. */
    readonly port: MessagePort;
  }

  export function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void;

  /** The context's sample rate. */
  export const sampleRate: number;
}
