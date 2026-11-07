import type { Clock, SttEvent, SttSource, SttState } from '../types.ts';
import {
  EXIT,
  MAX_PAYLOAD,
  createLineSplitter,
  encodeControl,
  encodePcm,
  parseEventLine,
  sourceByte,
} from './protocol.ts';

/* Supervises the speech worker: handshake, heartbeat, restarts, shutdown.
   Pure: the child process and the clock are injected, so the whole state
   machine runs under `node --test` with a fake child. */

/** The slice of Node's ChildProcess the supervisor uses. A real ChildProcess satisfies it. */
export interface ChildLike {
  stdin: {
    write(chunk: Uint8Array): boolean;
    end(): void;
    /** Optional. When present the supervisor listens, so an EPIPE on a dead child cannot surface as an uncaught error. */
    on?(event: 'error', cb: (err: Error) => void): unknown;
  } | null;
  stdout: { on(event: 'data', cb: (chunk: Uint8Array | string) => void): unknown } | null;
  stderr: { on(event: 'data', cb: (chunk: Uint8Array | string) => void): unknown } | null;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', cb: (err: Error & { code?: string }) => void): unknown;
  /** Narrower than `string` so that Node's own `kill(signal?: NodeJS.Signals | number)` fits. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): boolean;
}

export interface SttProcessOptions {
  /** Starts the worker. Called again for every restart. */
  spawn(): ChildLike;
  clock: Clock;
  onEvent(e: SttEvent): void;
  onState(state: SttState, message?: string): void;
  /** Default 20000. */
  readyTimeoutMs?: number;
  /** Default 15000. */
  heartbeatTimeoutMs?: number;
  /** Default 3. */
  maxRestarts?: number;
  /** Default 300000. */
  restartWindowMs?: number;
  /** Default [1000, 2000, 4000]. */
  backoffMs?: number[];
  /** Default 2000. */
  stopGraceMs?: number;
}

const STDERR_TAIL_CHARS = 2000;
const SETUP_HINT = 'Run the speech setup again: the command is in Settings, Magical Hamster, Speech.';
const MESSAGES = {
  modelMissing: `The speech model is not installed. ${SETUP_HINT}`,
  addonLoadFailed: `The speech runtime could not be loaded. ${SETUP_HINT}`,
  nodeMissing: 'Node was not found. Set the path to Node in the plugin settings.',
  readyTimeout: 'The speech worker did not start in time.',
  unresponsive: 'The speech worker stopped responding.',
  gaveUp: 'Transcription stopped after repeated crashes.',
  stoppedEarly: 'The speech worker was stopped before it was ready.',
  stopped: 'The speech worker was stopped.',
  langUnsupported: 'The speech model does not support the selected language; using automatic detection.',
} as const;

type NotInstalledCode = 'model_missing' | 'addon_load_failed';

/** Segment times carry two decimals on the wire; adding an offset must not add noise digits. */
function roundTime(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

export class SttProcess {
  private readonly opts: SttProcessOptions;
  private readonly readyTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly backoffMs: number[];
  private readonly stopGraceMs: number;

  private current: SttState = 'idle';
  private currentMessage: string | undefined = undefined;
  private child: ChildLike | null = null;
  /** Changes whenever a child is started or given up on; callbacks of an older child are ignored. */
  private generation = 0;
  private readonly hellos = new Map<SttSource, number>();
  /** Seconds of audio offered per source since the recording began, whether or not a worker was up to take it. */
  private readonly offered = new Map<SttSource, number>();
  /** Per source, where the current worker's clock started on the recording's clock. */
  private readonly clockStart = new Map<SttSource, number>();
  private stderrTail = '';
  /** The worker's own account of why it cannot run, from its `error` event. */
  private workerError: string | undefined = undefined;
  private langWarned = false;
  /** False until the first `ready`: before it a failure ends `start()`, after it a failure is a crash to recover from. */
  private everReady = false;
  private stopRequested = false;
  /** Clock times of the restarts still inside the window. */
  private restarts: number[] = [];

  private readyTimer: unknown = null;
  private heartbeatTimer: unknown = null;
  private restartTimer: unknown = null;
  private graceTimer: unknown = null;

  private startPromise: Promise<void> | null = null;
  private settleStart: { resolve(): void; reject(err: Error): void } | null = null;
  private stopPromise: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;

  constructor(opts: SttProcessOptions) {
    this.opts = opts;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 20000;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 15000;
    this.maxRestarts = opts.maxRestarts ?? 3;
    this.restartWindowMs = opts.restartWindowMs ?? 300000;
    this.backoffMs = opts.backoffMs && opts.backoffMs.length > 0 ? opts.backoffMs : [1000, 2000, 4000];
    this.stopGraceMs = opts.stopGraceMs ?? 2000;
  }

  /**
   * Spawns and resolves once `ready` arrives. Rejects with an Error whose message is fit to show the user.
   * One-shot: later calls return the same promise, and an instance that was stopped cannot be started again.
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.stopRequested) return Promise.reject(new Error(MESSAGES.stopped));
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.settleStart = { resolve, reject };
    });
    // Every failure is also reported through onState, so a caller that drops
    // this promise must not turn it into an unhandled rejection in Obsidian.
    this.startPromise.catch(() => {});
    this.spawnChild();
    return this.startPromise;
  }

  /** Announces a source's sample rate. Remembered and re-sent after a restart. */
  hello(source: SttSource, sampleRate: number): void {
    this.hellos.set(source, sampleRate);
    if (this.isUp()) this.write(encodeControl({ type: 'hello', source, sampleRate }));
  }

  /**
   * Sends an audio frame. Dropped silently unless the process is running.
   * The first frame after `ready` is what moves the state to `running`.
   */
  sendPcm(source: SttSource, samples: Int16Array): void {
    const sampleRate = this.hellos.get(source);
    const before = this.offered.get(source) ?? 0;
    if (sampleRate) this.offered.set(source, before + samples.length / sampleRate);

    if (this.current === 'ready') {
      this.setState('running');
      this.armHeartbeat();
    }
    if (this.current !== 'running') return;
    // A worker counts time from the first sample it receives. Remembering
    // where that sample sits in the recording keeps segment times continuous
    // across a restart, and across audio dropped while no worker was up.
    if (!this.clockStart.has(source)) this.clockStart.set(source, before);
    const max = MAX_PAYLOAD / 2;
    for (let offset = 0; offset < samples.length; offset += max) {
      this.write(encodePcm(sourceByte(source), samples.subarray(offset, offset + max)));
    }
  }

  /** Asks the worker to finalize any open utterance now. */
  flush(): void {
    if (this.isUp()) this.write(encodeControl({ type: 'flush' }));
  }

  /** Asks the worker to finish (bye), waits `stopGraceMs`, then kills. Resolves when the process is gone. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopRequested = true;
    this.clearTimer('restartTimer');
    this.clearTimer('readyTimer');
    this.clearTimer('heartbeatTimer');
    this.rejectStart(MESSAGES.stoppedEarly);

    const child = this.child;
    if (!child) {
      this.markExited();
      this.stopPromise = Promise.resolve();
      return this.stopPromise;
    }

    if (!this.isTerminal()) this.setState('stopping');
    this.stopPromise = new Promise<void>((resolve) => {
      this.resolveStop = resolve;
    });
    this.write(encodeControl({ type: 'bye' }));
    try {
      child.stdin?.end();
    } catch {
      // The pipe is already gone; the kill below still applies.
    }
    const clock = this.opts.clock;
    this.graceTimer = clock.setTimeout(() => {
      this.graceTimer = null;
      try {
        child.kill('SIGKILL');
      } catch {
        // Nothing left to kill.
      }
      if (this.child !== child) return;
      // A process that cannot be killed must not keep the caller waiting.
      this.graceTimer = clock.setTimeout(() => this.finishStop(), this.stopGraceMs);
    }, this.stopGraceMs);
    return this.stopPromise;
  }

  state(): SttState {
    return this.current;
  }

  private isUp(): boolean {
    return this.current === 'ready' || this.current === 'running';
  }

  private isTerminal(): boolean {
    return this.current === 'failed' || this.current === 'not-installed';
  }

  private setState(state: SttState, message?: string): void {
    if (state === this.current && message === this.currentMessage) return;
    this.current = state;
    this.currentMessage = message;
    this.opts.onState(state, message);
  }

  private clearTimer(name: 'readyTimer' | 'heartbeatTimer' | 'restartTimer' | 'graceTimer'): void {
    if (this[name] === null) return;
    this.opts.clock.clearTimeout(this[name]);
    this[name] = null;
  }

  private armHeartbeat(): void {
    this.clearTimer('heartbeatTimer');
    const gen = this.generation;
    this.heartbeatTimer = this.opts.clock.setTimeout(() => this.onHeartbeatTimeout(gen), this.heartbeatTimeoutMs);
  }

  private write(bytes: Uint8Array): void {
    const stdin = this.child?.stdin;
    if (!stdin) return;
    try {
      stdin.write(bytes);
    } catch (err) {
      this.noteStderr(`stdin: ${(err as Error).message}\n`);
    }
  }

  /** The headline, then what the worker said about it. */
  private describe(headline: string): string {
    // The start banner says nothing about what went wrong.
    const tail = this.stderrTail
      .split('\n')
      .filter((line) => !/^\[worker\] sherpa-onnx \S+, model /.test(line.trim()))
      .join('\n')
      .trim();
    const parts = [headline];
    // The worker also logs its fatal message, so the tail usually has it already.
    const said = this.workerError?.trim();
    if (said && !tail.includes(said)) parts.push(said);
    if (tail) parts.push(tail);
    return parts.join('\n');
  }

  private rejectStart(message: string): void {
    const settle = this.settleStart;
    this.settleStart = null;
    settle?.reject(new Error(message));
  }

  private spawnChild(): void {
    const gen = ++this.generation;
    this.stderrTail = '';
    this.workerError = undefined;
    this.langWarned = false;
    this.clockStart.clear();
    this.setState('spawning');
    // A listener may answer `spawning` with stop(): nothing must be started after that.
    if (this.stopRequested) return;

    let child: ChildLike;
    try {
      child = this.opts.spawn();
    } catch (err) {
      this.onSpawnFailure(err as Error & { code?: string });
      return;
    }
    this.child = child;

    const lines = createLineSplitter((line) => this.onLine(gen, line));
    const stderrDecoder = new TextDecoder('utf-8');
    child.stdout?.on('data', (chunk) => lines.push(chunk));
    child.stderr?.on('data', (chunk) => {
      if (gen !== this.generation) return;
      this.noteStderr(typeof chunk === 'string' ? chunk : stderrDecoder.decode(chunk, { stream: true }));
    });
    child.stdin?.on?.('error', (err) => {
      if (gen === this.generation) this.noteStderr(`stdin: ${err.message}\n`);
    });
    // The splitter is not ended here: stdout can outlive `exit`, and a line
    // cut in two by it must still be put together. The worker ends every
    // line it writes, so nothing whole is left in the tail.
    child.on('exit', (code, signal) => this.onExit(gen, code, signal));
    child.on('error', (err) => this.onChildError(gen, err));

    this.readyTimer = this.opts.clock.setTimeout(() => this.onReadyTimeout(gen), this.readyTimeoutMs);
  }

  /** Stops listening to the current child and kills it. */
  private abandonChild(): void {
    const child = this.child;
    this.child = null;
    this.generation += 1;
    this.clearTimer('readyTimer');
    this.clearTimer('heartbeatTimer');
    try {
      child?.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  private noteStderr(text: string): void {
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
    // Backstop for a language the worker could not check itself: sherpa-onnx
    // logs this and silently falls back to automatic detection.
    if (!this.langWarned && !this.stopRequested && this.stderrTail.includes('Unsupported language')) {
      this.langWarned = true;
      this.opts.onEvent({ type: 'error', code: 'lang_unsupported', message: MESSAGES.langUnsupported });
    }
  }

  private onLine(gen: number, line: string): void {
    if (gen !== this.generation) return;
    let event = parseEventLine(line);
    if (!event) return;
    if (this.current === 'running') this.armHeartbeat();

    if (event.type === 'segment') {
      const shift = this.clockStart.get(event.source) ?? 0;
      if (shift > 0) event = { ...event, t0: roundTime(event.t0 + shift), t1: roundTime(event.t1 + shift) };
    }

    if (event.type === 'ready') {
      if (this.current !== 'spawning' || !this.child) return;
      this.onReady();
    } else if (event.type === 'error') {
      if ((event.code === 'model_missing' || event.code === 'addon_load_failed') && !this.stopRequested) {
        this.workerError = event.message;
        this.notInstalled(event.code);
        return;
      }
      if (event.code === 'lang_unsupported') {
        if (this.langWarned) return;
        this.langWarned = true;
      }
    }
    // Lines can arrive after `exit` (the last finals of a stopped worker):
    // they are still delivered.
    this.opts.onEvent(event);
  }

  private onReady(): void {
    this.clearTimer('readyTimer');
    this.everReady = true;
    // Before the state is announced: a listener may send audio from its
    // `ready` callback, and the worker ignores audio that precedes the hello.
    for (const [source, sampleRate] of this.hellos) {
      this.write(encodeControl({ type: 'hello', source, sampleRate }));
    }
    this.setState('ready');
    const settle = this.settleStart;
    this.settleStart = null;
    settle?.resolve();
  }

  private onReadyTimeout(gen: number): void {
    if (gen !== this.generation || this.current !== 'spawning') return;
    this.readyTimer = null;
    this.abandonChild();
    this.onFailure(MESSAGES.readyTimeout);
  }

  private onHeartbeatTimeout(gen: number): void {
    if (gen !== this.generation || this.current !== 'running') return;
    this.heartbeatTimer = null;
    this.abandonChild();
    this.crash(MESSAGES.unresponsive);
  }

  private onChildError(gen: number, err: Error & { code?: string }): void {
    if (gen !== this.generation) return;
    if (this.current !== 'spawning' || !this.child) {
      // Past the spawn, `error` reports a failed kill or write; `exit` tells the rest.
      this.noteStderr(`${err.message}\n`);
      return;
    }
    // The process never started, and Node does not promise an `exit` after this.
    this.child = null;
    this.generation += 1;
    this.clearTimer('readyTimer');
    this.onSpawnFailure(err);
  }

  private onSpawnFailure(err: Error & { code?: string }): void {
    this.clearTimer('readyTimer');
    if (err.code === 'ENOENT') {
      this.setState('not-installed', MESSAGES.nodeMissing);
      this.rejectStart(MESSAGES.nodeMissing);
      return;
    }
    this.onFailure(`The speech worker could not be started: ${err.message}`);
  }

  private onExit(gen: number, code: number | null, signal: string | null): void {
    if (gen !== this.generation || !this.child) return;
    this.child = null;
    this.clearTimer('readyTimer');
    this.clearTimer('heartbeatTimer');
    if (this.stopRequested) {
      this.finishStop();
      return;
    }
    if (code === EXIT.modelMissing) return this.notInstalled('model_missing');
    if (code === EXIT.addonLoadFailed) return this.notInstalled('addon_load_failed');
    if (this.isTerminal()) return;
    const how = code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`;
    this.onFailure(
      this.everReady
        ? `The speech worker stopped unexpectedly (${how}).`
        : `The speech worker stopped while starting (${how}).`,
    );
  }

  /** Not a crash: restarting cannot help until the user installs the runtime. */
  private notInstalled(code: NotInstalledCode): void {
    this.clearTimer('readyTimer');
    this.clearTimer('heartbeatTimer');
    this.clearTimer('restartTimer');
    const message = this.describe(code === 'model_missing' ? MESSAGES.modelMissing : MESSAGES.addonLoadFailed);
    // Called for the `error` event and again for the exit code, in either
    // order; the second call only adds detail.
    this.setState('not-installed', message);
    this.rejectStart(message);
  }

  private onFailure(message: string): void {
    if (this.everReady) this.crash(message);
    else this.fail(message);
  }

  private fail(message: string): void {
    const full = this.describe(message);
    this.setState('failed', full);
    this.rejectStart(full);
  }

  private crash(message: string): void {
    const clock = this.opts.clock;
    const now = clock.now();
    this.restarts = this.restarts.filter((at) => now - at < this.restartWindowMs);
    if (this.restarts.length >= this.maxRestarts) {
      this.fail(MESSAGES.gaveUp);
      return;
    }
    const delay = this.backoffMs[Math.min(this.restarts.length, this.backoffMs.length - 1)];
    this.restarts.push(now);
    this.setState('crashed', this.describe(message));
    // As in spawnChild: the listener may have stopped everything from its callback.
    if (this.stopRequested) return;
    this.restartTimer = clock.setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopRequested) this.spawnChild();
    }, delay);
  }

  private markExited(): void {
    // `failed` and `not-installed` say more than `exited` and are kept.
    if (!this.isTerminal()) this.setState('exited');
  }

  private finishStop(): void {
    this.clearTimer('graceTimer');
    // The generation is left alone: the worker's last finals may still be in the pipe.
    this.child = null;
    this.markExited();
    const resolve = this.resolveStop;
    this.resolveStop = null;
    resolve?.();
  }
}
