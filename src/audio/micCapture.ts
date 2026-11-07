import workletSource from './pcm-worklet.js?raw';

/* Microphone capture: getUserMedia into an AudioWorklet that hands back
   100 ms blocks of 16-bit PCM. WebAudio only, so it runs in Obsidian's
   renderer and not under `node --test`. */

export interface MicCapture {
  /** The context's real sample rate. */
  readonly sampleRate: number;
  /** Last block's peak, 0..1. */
  level(): number;
  stop(): Promise<void>;
}

export interface MicCaptureOptions {
  /** Empty for the system's default microphone. */
  deviceId: string;
  /** One block of mono PCM, about 100 ms of it. */
  onPcm(samples: Int16Array): void;
  /** The capture ended on its own (the device was unplugged). Nothing more is delivered; `stop()` still has to be called. */
  onError(error: Error): void;
}

const PROCESSOR_NAME = 'hamster-pcm';
const TARGET_RATE = 16000;
const RESUME_TIMEOUT_MS = 5000;

const DENIED = 'Microphone access was denied. Allow Obsidian in System Settings, Privacy & Security, Microphone.';
const NOT_FOUND = 'No microphone was found.';
const DISCONNECTED = 'The microphone was disconnected.';

/** An error whose message is already written for the user. */
class CaptureError extends Error {}

/** Read structurally: Chromium's OverconstrainedError is not an Error. */
function field(e: unknown, key: 'name' | 'message'): string {
  if (typeof e !== 'object' || e === null) return '';
  const value = (e as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function describe(e: unknown): Error {
  if (e instanceof CaptureError) return e;
  const name = field(e, 'name');
  if (name === 'NotAllowedError' || name === 'SecurityError') return new CaptureError(DENIED);
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new CaptureError(NOT_FOUND);
  return new CaptureError(`The microphone could not be started: ${field(e, 'message') || name || String(e)}`);
}

function constraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      // Tuned for calls, not for recognition: they reshape speech and duck
      // the far voices in a room.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };
}

async function openStream(deviceId: string): Promise<MediaStream> {
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) throw new CaptureError('The microphone is not available here.');
  try {
    return await devices.getUserMedia(constraints(deviceId));
  } catch (err) {
    const name = field(err, 'name');
    if (!deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw err;
    // The saved device is not plugged in today: that must not block a recording.
    return await devices.getUserMedia(constraints(''));
  }
}

function createContext(): AudioContext {
  try {
    // The recognizer's own rate: Chromium resamples the device once, and the
    // worker is left with nothing to convert.
    return new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' });
  } catch {
    // Any rate will do: the worker resamples what it is told it receives.
    return new AudioContext({ latencyHint: 'interactive' });
  }
}

/** `resume()` never settles on a context that cannot reach an output device, and a start that never settles cannot be cancelled. */
async function resumeWithin(ctx: AudioContext, ms: number): Promise<void> {
  const resumed = ctx.resume();
  // If the timer wins, the context is closed under this promise.
  resumed.catch(() => {});
  let timer: number | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new CaptureError('Audio capture did not start in time.')), ms);
  });
  try {
    await Promise.race([resumed, late]);
  } finally {
    window.clearTimeout(timer);
  }
}

async function loadProcessor(ctx: AudioContext): Promise<void> {
  const url = URL.createObjectURL(new Blob([workletSource], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Opens the microphone and starts delivering PCM. Rejects with an Error whose message is fit to show the user. */
export async function startMicCapture(opts: MicCaptureOptions): Promise<MicCapture> {
  let stream: MediaStream;
  try {
    stream = await openStream(opts.deviceId);
  } catch (err) {
    throw describe(err);
  }

  const track: MediaStreamTrack | undefined = stream.getAudioTracks()[0];
  let ctx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;
  let mute: GainNode | null = null;
  let level = 0;
  /** False once stopped or failed: nothing is delivered after that. */
  let live = true;
  let stopping: Promise<void> | null = null;

  const fail = (error: Error): void => {
    if (!live) return;
    live = false;
    opts.onError(error);
  };
  const onEnded = (): void => fail(new CaptureError(DISCONNECTED));

  const release = async (): Promise<void> => {
    live = false;
    track?.removeEventListener('ended', onEnded);
    if (node) {
      node.port.onmessage = null;
      node.onprocessorerror = null;
    }
    for (const part of [source, node, mute]) {
      try {
        part?.disconnect();
      } catch {
        // Never connected.
      }
    }
    // Stopping the tracks is what turns off the system's microphone indicator.
    for (const t of stream.getTracks()) {
      try {
        t.stop();
      } catch {
        // Already ended.
      }
    }
    try {
      if (ctx && ctx.state !== 'closed') await ctx.close();
    } catch {
      // Already closing.
    }
  };
  const stop = (): Promise<void> => (stopping ??= release());

  try {
    if (!track) throw new CaptureError(NOT_FOUND);
    ctx = createContext();
    await resumeWithin(ctx, RESUME_TIMEOUT_MS);
    await loadProcessor(ctx);

    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    mute = ctx.createGain();
    mute.gain.value = 0;

    node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; peak: number }>) => {
      if (!live) return;
      level = event.data.peak;
      opts.onPcm(new Int16Array(event.data.pcm));
    };
    node.onprocessorerror = () => fail(new CaptureError('Audio capture stopped unexpectedly.'));

    // A graph is only rendered when it leads to the destination. The muted
    // gain gives it that path without playing the microphone back.
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);

    // It may have been unplugged while the graph was being built.
    if (track.readyState === 'ended') throw new CaptureError(DISCONNECTED);
    track.addEventListener('ended', onEnded);
  } catch (err) {
    // Not awaited: the tracks are stopped at once, and a context that would
    // not start may not finish closing either.
    void stop();
    throw describe(err);
  }

  return {
    sampleRate: ctx.sampleRate,
    level: () => (live ? level : 0),
    stop,
  };
}
