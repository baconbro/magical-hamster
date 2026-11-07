import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { startMicCapture } from '../audio/micCapture.ts';
import type { MicCapture, MicCaptureOptions } from '../audio/micCapture.ts';
import { defaultRuntimeDir, readRuntime, workerCommand } from '../host/runtime.ts';
import type { RuntimeInfo, WorkerCommand } from '../host/runtime.ts';
import type { Clock, LocalSettings, SttEvent, SttLanguage, SttState, TranscriptSource } from '../types.ts';
import { SttProcess } from './sttProcess.ts';
import type { ChildLike } from './sttProcess.ts';

/* The transcript source the plugin records with: the microphone feeding the
   speech worker, a child process of the user's own Node. SttProcess owns the
   worker's life cycle; this file owns the order in which the two halves are
   brought up and taken down, so that neither a microphone nor a process is
   ever left open behind a failure. */

export interface NodeSttSourceOptions {
  clock: Clock;
  /** Read at each start: `nodePath`, `runtimeDir`, `micDeviceId`. */
  local(): LocalSettings;
  language(): SttLanguage;
}

/** A worker process that also tells when its pipes have been read to the end. A real ChildProcess satisfies it. */
export interface WorkerChild extends ChildLike {
  once(event: 'close', cb: () => void): unknown;
}

/** What the source reaches outside itself for. `createNodeTranscriptSource` supplies the real things; tests supply fakes. */
export interface NodeSttSourceDeps extends NodeSttSourceOptions {
  readRuntime(runtimeDir: string): RuntimeInfo | null;
  baseEnv(): Record<string, string | undefined>;
  spawn(command: WorkerCommand): WorkerChild;
  exists(path: string): boolean;
  startMic(opts: MicCaptureOptions): Promise<MicCapture>;
}

const NOT_SET_UP =
  'Speech recognition is not set up. Run the setup command shown in Settings, Magical Hamster, Speech, once, in Terminal.';
const STOPPED = 'The recording was stopped before it started.';
const MIC_LOST_ADVICE = 'Stop the recording and start it again to continue the transcript.';
const CLOSE_WAIT_MS = 1000;
const MIC_STOP_WAIT_MS = 1000;

function nodeNotFound(path: string): string {
  return `Node was not found at ${path}. Set the path to Node in the plugin settings.`;
}

function isOver(state: SttState): boolean {
  return state === 'failed' || state === 'not-installed';
}

/** The source with its outside world passed in. One recording per instance. */
export function createTranscriptSourceWith(deps: NodeSttSourceDeps): TranscriptSource {
  // One entry per subscription, so that a callback subscribed twice is called
  // twice and each unsubscribe removes its own.
  const eventListeners = new Set<{ cb(e: SttEvent): void }>();
  const stateListeners = new Set<{ cb(s: SttState, message?: string): void }>();
  let current: SttState = 'idle';
  let currentMessage: string | undefined = undefined;

  let supervisor: SttProcess | null = null;
  let mic: MicCapture | null = null;
  /** True from the hello to the stop: blocks from the microphone go to the worker. */
  let capturing = false;
  /** Set when the microphone ended on its own mid-recording. The source is `failed` from then on, whatever the worker reports on its way out. */
  let micLost = false;
  let stopRequested = false;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  /** Settles when the latest child's pipes have closed. */
  let pipesClosed: Promise<void> = Promise.resolve();

  // The contract says listeners do not throw. One that does anyway must not
  // unwind into the supervisor's stdout handler, or cost the other listeners.
  function guarded(call: () => void): void {
    try {
      call();
    } catch (error) {
      console.error('[magical-hamster]', error);
    }
  }

  function emitEvent(event: SttEvent): void {
    for (const listener of [...eventListeners]) guarded(() => listener.cb(event));
  }

  function setState(state: SttState, message?: string): void {
    if (state === current && message === currentMessage) return;
    current = state;
    currentMessage = message;
    for (const listener of [...stateListeners]) guarded(() => listener.cb(state, message));
  }

  /** Waits for `work` to settle either way, but no longer than `ms`: a stop has to end even when a part of it does not. */
  function within(work: Promise<unknown>, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = deps.clock.setTimeout(resolve, ms);
      const done = (): void => {
        deps.clock.clearTimeout(timer);
        resolve();
      };
      work.then(done, done);
    });
  }

  async function releaseMic(): Promise<void> {
    capturing = false;
    const open = mic;
    mic = null;
    if (!open) return;
    try {
      // Capped: the worker is stopped after the microphone, and must be stopped
      // whatever WebAudio does. The tracks are off as soon as stop() is called.
      await within(open.stop(), MIC_STOP_WAIT_MS);
    } catch (error) {
      // A capture's stop() does not throw. Were it to, the worker still has
      // to be stopped after it, and nobody awaits a release started on a loss.
      console.error('[magical-hamster]', error);
    }
  }

  /** Stops the worker and waits until everything it wrote has been delivered. */
  async function shutDown(worker: SttProcess): Promise<void> {
    try {
      await worker.stop();
    } catch {
      // stop() does not reject; nothing here may keep a caller from finishing.
    }
    // The process is gone at `exit`, but its last finals can still be in the
    // stdout pipe; they have all been read at `close`. Capped, because a pipe
    // kept open by something else must not hold the caller.
    await within(pipesClosed, CLOSE_WAIT_MS);
  }

  async function run(): Promise<void> {
    const local = deps.local();
    const info = deps.readRuntime(local.runtimeDir.trim() || defaultRuntimeDir());
    if (!info) {
      setState('not-installed', NOT_SET_UP);
      throw new Error(NOT_SET_UP);
    }
    const command = workerCommand(info, {
      nodePath: local.nodePath,
      language: deps.language(),
      baseEnv: deps.baseEnv(),
    });
    // The supervisor knows only that the spawn found nothing to run. Which
    // path it tried is what the user needs to fix the setting. Only for that
    // failure: a worker that ran and found no model is `not-installed` too,
    // and a command found through the PATH is not a file that exists.
    let nothingToRun = false;
    const explain = (state: SttState, message: string | undefined): string | undefined =>
      state === 'not-installed' && nothingToRun && !deps.exists(command.command)
        ? nodeNotFound(command.command)
        : message;

    const worker = new SttProcess({
      clock: deps.clock,
      spawn() {
        nothingToRun = false;
        let child: WorkerChild;
        try {
          child = deps.spawn(command);
        } catch (error) {
          // Node reports a missing program through the child's `error` event,
          // but nothing promises that a spawn never throws it instead.
          if ((error as { code?: unknown } | null)?.code === 'ENOENT') nothingToRun = true;
          throw error;
        }
        // Added before the supervisor's own listener, so the flag is set by
        // the time its state arrives.
        child.on('error', (error) => {
          if (error.code === 'ENOENT') nothingToRun = true;
        });
        pipesClosed = new Promise<void>((resolve) => {
          child.once('close', () => resolve());
        });
        return child;
      },
      onEvent: emitEvent,
      onState(state, message) {
        if (micLost) return;
        setState(state, explain(state, message));
        // Nothing can use the audio any more: do not keep listening.
        if (isOver(state)) void releaseMic();
      },
    });
    supervisor = worker;

    try {
      await worker.start();
      if (stopRequested) throw new Error(STOPPED);

      const opened = await deps.startMic({
        deviceId: local.micDeviceId,
        onPcm(samples) {
          if (capturing) worker.sendPcm('mic', samples);
        },
        onError(error) {
          if (!capturing) return;
          // `failed` and not an error event: it is the state the sidebar
          // explains while the recording goes on without a transcript.
          micLost = true;
          setState('failed', `${error.message} ${MIC_LOST_ADVICE}`);
          void releaseMic();
          // No audio will follow, so the worker is not kept either. What was
          // said before the microphone went still arrives as a final.
          worker.flush();
          void shutDown(worker);
        },
      });
      mic = opened;
      // The microphone can take long to open (a permission prompt). The
      // recording may have been stopped, or the worker lost for good, meanwhile.
      if (stopRequested) throw new Error(STOPPED);
      if (isOver(current)) throw new Error(currentMessage ?? 'The speech worker is not running.');

      worker.hello('mic', opened.sampleRate);
      capturing = true;
    } catch (error) {
      await releaseMic();
      await shutDown(worker);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(explain(worker.state(), message) ?? message, { cause: error });
    }
  }

  return {
    start() {
      if (startPromise) return startPromise;
      if (stopRequested) return Promise.reject(new Error(STOPPED));
      // In place before run() begins: the first state reaches the listeners
      // inside it, and one that calls start() must get this start, not a second worker.
      let begin!: (work: Promise<void>) => void;
      startPromise = new Promise<void>((resolve) => {
        begin = resolve;
      });
      begin(run());
      return startPromise;
    },

    stop() {
      if (stopPromise) return stopPromise;
      stopRequested = true;
      stopPromise = (async () => {
        // The microphone first: no audio may arrive after the flush.
        await releaseMic();
        if (supervisor) {
          supervisor.flush();
          await shutDown(supervisor);
        } else if (current === 'idle') {
          setState('exited');
        }
      })();
      return stopPromise;
    },

    onEvent(cb) {
      const listener = { cb };
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },

    onState(cb) {
      const listener = { cb };
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },

    state: () => current,
    level: () => (capturing && mic ? mic.level() : 0),
  };
}

/** The microphone and the speech worker under the user's Node, as one transcript source. */
export function createNodeTranscriptSource(opts: NodeSttSourceOptions): TranscriptSource {
  return createTranscriptSourceWith({
    clock: opts.clock,
    local: () => opts.local(),
    language: () => opts.language(),
    readRuntime,
    baseEnv: () => process.env,
    spawn: (command) =>
      spawn(command.command, command.args, {
        env: command.env,
        cwd: command.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    exists: existsSync,
    startMic: startMicCapture,
  });
}
