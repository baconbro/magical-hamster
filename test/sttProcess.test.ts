import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { SttProcess } from '../src/stt/sttProcess.ts';
import type { ChildLike, SttProcessOptions } from '../src/stt/sttProcess.ts';
import type { Clock, SttEvent, SttState } from '../src/types.ts';

// The adapter hands a real ChildProcess to SttProcessOptions.spawn: it has to fit ChildLike as it is.
type RealChildFits = ChildProcessWithoutNullStreams extends ChildLike ? true : false;
const realChildFits: RealChildFits = true;
void realChildFits;

const require = createRequire(import.meta.url);
const frames = require('../stt/frames.cjs') as {
  createFrameParser(handlers: {
    onFrame(source: number, payload: Uint8Array): void;
    onError(err: Error): void;
  }): { push(chunk: Uint8Array): void };
};

interface ManualClock extends Clock {
  advance(ms: number): void;
  pending(): number;
}

function manualClock(): ManualClock {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      timers.set(nextId, { at: now + ms, fn, every: null });
      return nextId++;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    setInterval(fn, ms) {
      timers.set(nextId, { at: now + ms, fn, every: ms });
      return nextId++;
    },
    clearInterval(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let dueId = -1;
        let dueAt = Infinity;
        for (const [id, timer] of timers) {
          if (timer.at <= end && timer.at < dueAt) {
            dueId = id;
            dueAt = timer.at;
          }
        }
        if (dueId < 0) break;
        const timer = timers.get(dueId)!;
        now = Math.max(now, timer.at);
        if (timer.every === null) timers.delete(dueId);
        else timer.at += timer.every;
        timer.fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

interface SentFrame {
  source: number;
  payload: Uint8Array;
}

class FakeChild implements ChildLike {
  written: Uint8Array[] = [];
  stdinEnded = false;
  kills: string[] = [];
  /** When true, kill() makes the child exit at once, as SIGKILL does. */
  diesWhenKilled = false;

  private stdoutListeners: Array<(chunk: Uint8Array | string) => void> = [];
  private stderrListeners: Array<(chunk: Uint8Array | string) => void> = [];
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private errorListeners: Array<(err: Error & { code?: string }) => void> = [];

  stdin = {
    write: (chunk: Uint8Array): boolean => {
      this.written.push(chunk);
      return true;
    },
    end: (): void => {
      this.stdinEnded = true;
    },
  };

  stdout = {
    on: (_event: 'data', cb: (chunk: Uint8Array | string) => void): void => {
      this.stdoutListeners.push(cb);
    },
  };

  stderr = {
    on: (_event: 'data', cb: (chunk: Uint8Array | string) => void): void => {
      this.stderrListeners.push(cb);
    },
  };

  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', cb: (err: Error & { code?: string }) => void): unknown;
  on(event: 'exit' | 'error', cb: (...args: never[]) => void): unknown {
    if (event === 'exit') this.exitListeners.push(cb as (code: number | null, signal: string | null) => void);
    else this.errorListeners.push(cb as (err: Error & { code?: string }) => void);
    return this;
  }

  kill(signal?: string): boolean {
    this.kills.push(signal ?? 'SIGTERM');
    if (this.diesWhenKilled) this.exit(null, signal ?? 'SIGTERM');
    return true;
  }

  out(chunk: Uint8Array | string): void {
    for (const cb of this.stdoutListeners) cb(chunk);
  }

  emit(event: Record<string, unknown>): void {
    this.out(`${JSON.stringify(event)}\n`);
  }

  err(chunk: Uint8Array | string): void {
    for (const cb of this.stderrListeners) cb(chunk);
  }

  exit(code: number | null, signal: string | null = null): void {
    for (const cb of this.exitListeners) cb(code, signal);
  }

  fail(code: string, message = `spawn node ${code}`): void {
    const error: Error & { code?: string } = new Error(message);
    error.code = code;
    for (const cb of this.errorListeners) cb(error);
  }

  /** Everything written to stdin, decoded by the worker's own parser. */
  frames(): SentFrame[] {
    const sent: SentFrame[] = [];
    const parser = frames.createFrameParser({
      onFrame: (source, payload) => sent.push({ source, payload: Uint8Array.from(payload) }),
      onError: (error) => {
        throw error;
      },
    });
    for (const chunk of this.written) parser.push(chunk);
    return sent;
  }

  controls(): Array<Record<string, unknown>> {
    return this.frames()
      .filter((frame) => frame.source === 255)
      .map((frame) => JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>);
  }

  audio(): SentFrame[] {
    return this.frames().filter((frame) => frame.source !== 255);
  }
}

function setup(overrides: Partial<SttProcessOptions> = {}) {
  const clock = manualClock();
  const children: FakeChild[] = [];
  const events: SttEvent[] = [];
  const states: Array<[SttState, string | undefined]> = [];
  const control = { spawnError: null as (Error & { code?: string }) | null };
  const proc = new SttProcess({
    spawn() {
      if (control.spawnError) throw control.spawnError;
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    clock,
    onEvent: (event) => events.push(event),
    onState: (state, message) => states.push([state, message]),
    ...overrides,
  });
  const last = () => children[children.length - 1];
  const stateNames = () => states.map(([state]) => state);
  const lastMessage = () => states[states.length - 1]?.[1] ?? '';
  return { clock, children, events, states, control, proc, last, stateNames, lastMessage };
}

const READY = { type: 'ready', model: 'fake', chunkMs: 560 };
const STATS = { type: 'stats', rtf: 0.1, backlogMs: 0 };
const samples = Int16Array.from([1, 2, 3, 4]);

/** A process that is up and receiving audio. */
async function running(overrides: Partial<SttProcessOptions> = {}) {
  const t = setup(overrides);
  t.proc.hello('mic', 48000);
  const started = t.proc.start();
  t.last().emit(READY);
  await started;
  t.proc.sendPcm('mic', samples);
  assert.equal(t.proc.state(), 'running');
  return t;
}

test('start resolves on ready and announces the remembered sources', async () => {
  const t = setup();
  assert.equal(t.proc.state(), 'idle');
  t.proc.hello('mic', 48000);
  t.proc.hello('system', 44100);
  const started = t.proc.start();
  assert.equal(t.proc.state(), 'spawning');
  assert.equal(t.children.length, 1);
  assert.deepEqual(t.last().written, [], 'nothing is sent before ready');

  t.last().emit(READY);
  await started;
  assert.equal(t.proc.state(), 'ready');
  assert.deepEqual(t.stateNames(), ['spawning', 'ready']);
  assert.deepEqual(t.events, [READY]);
  assert.deepEqual(t.last().controls(), [
    { type: 'hello', source: 'mic', sampleRate: 48000 },
    { type: 'hello', source: 'system', sampleRate: 44100 },
  ]);
  // The ready timer is gone: nothing fires later.
  t.clock.advance(60_000);
  assert.equal(t.proc.state(), 'ready');
  assert.equal(t.children.length, 1);
});

test('start is one-shot and returns the same promise', async () => {
  const t = setup();
  const first = t.proc.start();
  const second = t.proc.start();
  assert.equal(first, second);
  assert.equal(t.children.length, 1);
  t.last().emit(READY);
  await first;
});

test('ready is recognized when stdout delivers it in pieces, as bytes', async () => {
  const t = setup();
  const started = t.proc.start();
  const bytes = new TextEncoder().encode(`${JSON.stringify(READY)}\n`);
  t.last().out('some library banner\n');
  t.last().out(bytes.subarray(0, 9));
  assert.equal(t.proc.state(), 'spawning');
  t.last().out(bytes.subarray(9));
  await started;
  assert.equal(t.proc.state(), 'ready');
});

test('the first audio frame after ready moves the state to running', async () => {
  const t = setup();
  const started = t.proc.start();
  t.last().emit(READY);
  await started;

  t.proc.hello('system', 16000);
  assert.deepEqual(t.last().controls(), [{ type: 'hello', source: 'system', sampleRate: 16000 }]);

  t.proc.sendPcm('system', Int16Array.from([0x0102, -2]));
  assert.equal(t.proc.state(), 'running');
  assert.deepEqual(t.stateNames(), ['spawning', 'ready', 'running']);
  const audio = t.last().audio();
  assert.equal(audio.length, 1);
  assert.equal(audio[0].source, 1);
  assert.deepEqual([...audio[0].payload], [0x02, 0x01, 0xfe, 0xff]);

  t.proc.sendPcm('mic', samples);
  assert.equal(t.last().audio()[1].source, 0);

  t.proc.flush();
  assert.deepEqual(t.last().controls().at(-1), { type: 'flush' });
});

test('ready must arrive in time, else the worker is killed and start fails', async () => {
  const t = setup();
  const started = t.proc.start();
  t.last().err('loading the model\n');
  t.clock.advance(19_999);
  assert.equal(t.proc.state(), 'spawning');
  t.clock.advance(1);
  await assert.rejects(started, /The speech worker did not start in time/);
  assert.equal(t.proc.state(), 'failed');
  assert.deepEqual(t.last().kills, ['SIGKILL']);
  assert.match(t.lastMessage(), /did not start in time/);
  assert.match(t.lastMessage(), /loading the model/);

  // A late ready from the killed worker changes nothing, and nothing restarts.
  t.last().emit(READY);
  t.last().exit(null, 'SIGKILL');
  t.clock.advance(600_000);
  assert.equal(t.proc.state(), 'failed');
  assert.equal(t.children.length, 1);
  assert.deepEqual(t.events, []);
});

test('readyTimeoutMs is configurable', async () => {
  const t = setup({ readyTimeoutMs: 50 });
  const started = t.proc.start();
  t.clock.advance(50);
  await assert.rejects(started, /did not start in time/);
});

test('a worker that exits before ready fails the start with its stderr', async () => {
  const t = setup();
  const started = t.proc.start();
  t.last().err('TypeError: boom\n    at main (worker.cjs:1:1)\n');
  t.last().exit(1);
  await assert.rejects(started, /stopped while starting \(exit code 1\)[\s\S]*TypeError: boom/);
  assert.equal(t.proc.state(), 'failed');
  t.clock.advance(600_000);
  assert.equal(t.children.length, 1);
});

for (const [code, headline] of [
  [2, 'The speech model is not installed.'],
  [3, 'The speech runtime could not be loaded.'],
] as const) {
  test(`exit code ${code} means not installed: no restart, and the message names the fix`, async () => {
    const t = setup();
    const started = t.proc.start();
    t.last().exit(code);
    await assert.rejects(started, (err: Error) => {
      assert.ok(err.message.startsWith(headline), err.message);
      assert.match(err.message, /Run the speech setup again: the command is in Settings, Magical Hamster, Speech\./);
      return true;
    });
    assert.equal(t.proc.state(), 'not-installed');
    assert.deepEqual(t.stateNames(), ['spawning', 'not-installed']);
    t.clock.advance(600_000);
    assert.equal(t.children.length, 1);
    t.proc.sendPcm('mic', samples);
    assert.deepEqual(t.last().written, []);
  });
}

test('the worker\'s own error event sets not-installed and its message is kept', async () => {
  const t = setup();
  const started = t.proc.start();
  const detail = 'sherpa-onnx-node failed to load: dlopen(sherpa-onnx.node): Library not loaded: @rpath/libonnxruntime.dylib';
  t.last().err(`[worker] ${detail}\n`);
  t.last().emit({ type: 'error', code: 'addon_load_failed', message: detail });
  assert.equal(t.proc.state(), 'not-installed');
  await assert.rejects(started, /could not be loaded[\s\S]*Library not loaded/);
  t.last().exit(3);

  assert.equal(t.proc.state(), 'not-installed');
  assert.ok(t.stateNames().every((state) => state === 'spawning' || state === 'not-installed'));
  // Said once, not once from the event and once from stderr.
  assert.equal(t.lastMessage().split('Library not loaded').length - 1, 1);
  assert.match(t.lastMessage(), /Run the speech setup again/);
  // The state carries it; it is not also forwarded as an event.
  assert.deepEqual(t.events, []);
  t.clock.advance(600_000);
  assert.equal(t.children.length, 1);
});

test('an error line that arrives after the exit still completes the message', async () => {
  const t = setup();
  const started = t.proc.start();
  t.last().exit(2);
  await assert.rejects(started, /speech model is not installed/);
  assert.doesNotMatch(t.lastMessage(), /models\/nemotron/);
  t.last().emit({ type: 'error', code: 'model_missing', message: 'not found: /runtime/models/nemotron' });
  assert.equal(t.proc.state(), 'not-installed');
  assert.match(t.lastMessage(), /speech model is not installed[\s\S]*models\/nemotron/);
});

test('not installed is also reported for a restarted worker', async () => {
  const t = await running();
  t.last().exit(1);
  t.clock.advance(1000);
  assert.equal(t.children.length, 2);
  t.last().exit(3);
  assert.equal(t.proc.state(), 'not-installed');
  t.clock.advance(600_000);
  assert.equal(t.children.length, 2);
});

test('ENOENT from the spawn means Node is missing: not installed, no restart', async () => {
  const t = setup();
  const started = t.proc.start();
  t.last().fail('ENOENT', 'spawn /opt/homebrew/bin/node ENOENT');
  await assert.rejects(started, /Node was not found\. Set the path to Node in the plugin settings\./);
  assert.equal(t.proc.state(), 'not-installed');
  // Node may or may not follow the error with an exit.
  t.last().exit(-2);
  t.clock.advance(600_000);
  assert.equal(t.proc.state(), 'not-installed');
  assert.equal(t.children.length, 1);
});

test('a spawn function that throws is handled the same way', async () => {
  const missing = setup();
  missing.control.spawnError = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  await assert.rejects(missing.proc.start(), /Node was not found/);
  assert.equal(missing.proc.state(), 'not-installed');

  const denied = setup();
  denied.control.spawnError = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
  await assert.rejects(denied.proc.start(), /could not be started: spawn EACCES/);
  assert.equal(denied.proc.state(), 'failed');
  assert.equal(denied.clock.pending(), 0);
});

test('another spawn error fails the start', async () => {
  const t = setup();
  const started = t.proc.start();
  t.last().fail('EACCES', 'spawn EACCES');
  await assert.rejects(started, /The speech worker could not be started: spawn EACCES/);
  assert.equal(t.proc.state(), 'failed');
});

test('a silent worker is killed after the heartbeat timeout and restarted with its hellos', async () => {
  const t = await running();
  const first = t.last();

  t.clock.advance(14_999);
  assert.equal(t.proc.state(), 'running');
  first.emit(STATS);
  t.clock.advance(14_999);
  assert.equal(t.proc.state(), 'running', 'any event resets the heartbeat');
  first.emit({ type: 'segment', source: 'mic', t0: 0, t1: 1, text: 'bonjour', isFinal: true });
  t.clock.advance(14_999);
  assert.equal(t.proc.state(), 'running');

  first.err('stuck in a decode\n');
  t.clock.advance(1);
  assert.equal(t.proc.state(), 'crashed');
  assert.deepEqual(first.kills, ['SIGKILL']);
  assert.match(t.lastMessage(), /stopped responding[\s\S]*stuck in a decode/);

  // Audio keeps coming from the microphone: it is dropped, not queued.
  t.proc.sendPcm('mic', samples);
  // What the dead worker still had in the pipe is ignored, as is its exit.
  const eventsBefore = t.events.length;
  first.emit({ type: 'segment', source: 'mic', t0: 1, t1: 2, text: 'late', isFinal: true });
  first.exit(null, 'SIGKILL');
  assert.equal(t.events.length, eventsBefore);
  assert.equal(t.proc.state(), 'crashed');

  t.clock.advance(999);
  assert.equal(t.children.length, 1);
  t.clock.advance(1);
  assert.equal(t.children.length, 2);
  assert.equal(t.proc.state(), 'spawning');
  const second = t.last();
  assert.deepEqual(second.written, []);

  second.emit(READY);
  assert.equal(t.proc.state(), 'ready');
  assert.deepEqual(second.controls(), [{ type: 'hello', source: 'mic', sampleRate: 48000 }]);
  t.proc.sendPcm('mic', samples);
  assert.equal(t.proc.state(), 'running');
  assert.equal(second.audio().length, 1);
  assert.deepEqual(t.stateNames(), ['spawning', 'ready', 'running', 'crashed', 'spawning', 'ready', 'running']);
});

test('the heartbeat only runs while running', async () => {
  const t = setup();
  const started = t.proc.start();
  t.last().emit(READY);
  await started;
  t.clock.advance(120_000);
  assert.equal(t.proc.state(), 'ready');
  assert.deepEqual(t.last().kills, []);
});

test('heartbeatTimeoutMs is configurable', async () => {
  const t = await running({ heartbeatTimeoutMs: 500 });
  t.clock.advance(499);
  assert.equal(t.proc.state(), 'running');
  t.clock.advance(1);
  assert.equal(t.proc.state(), 'crashed');
});

test('four crashes in a row end in failed; the backoff is 1, 2, then 4 seconds', async () => {
  const t = await running();
  const delays = [1000, 2000, 4000];

  for (let crash = 0; crash < 3; crash++) {
    t.last().err(`crash ${crash + 1}\n`);
    t.last().exit(crash === 1 ? null : 134, crash === 1 ? 'SIGSEGV' : null);
    assert.equal(t.proc.state(), 'crashed');
    assert.match(t.lastMessage(), crash === 1 ? /signal SIGSEGV/ : /exit code 134/);
    assert.match(t.lastMessage(), new RegExp(`crash ${crash + 1}`));

    t.clock.advance(delays[crash] - 1);
    assert.equal(t.children.length, crash + 1, 'not before the backoff has passed');
    t.clock.advance(1);
    assert.equal(t.children.length, crash + 2);
    t.last().emit(READY);
    t.proc.sendPcm('mic', samples);
    assert.equal(t.proc.state(), 'running');
  }

  t.last().err('crash 4\n');
  t.last().exit(134);
  assert.equal(t.proc.state(), 'failed');
  assert.match(t.lastMessage(), /^Transcription stopped after repeated crashes\./);
  assert.match(t.lastMessage(), /crash 4/);
  t.clock.advance(600_000);
  assert.equal(t.children.length, 4, 'no fifth worker');

  // The meeting goes on: audio is dropped quietly.
  t.proc.sendPcm('mic', samples);
  t.proc.hello('mic', 44100);
  t.proc.flush();
  assert.equal(t.last().audio().length, 1);
  assert.equal(t.proc.state(), 'failed');
});

test('a restarted worker that never gets ready counts as another crash', async () => {
  const t = await running();
  t.last().exit(1);
  t.clock.advance(1000);
  assert.equal(t.children.length, 2);

  t.clock.advance(20_000);
  assert.equal(t.proc.state(), 'crashed');
  assert.deepEqual(t.last().kills, ['SIGKILL']);
  assert.match(t.lastMessage(), /did not start in time/);

  t.clock.advance(2000);
  assert.equal(t.children.length, 3);
  t.last().exit(1);
  assert.equal(t.proc.state(), 'crashed');
  t.clock.advance(4000);
  assert.equal(t.children.length, 4);
  t.last().exit(1);
  assert.equal(t.proc.state(), 'failed');
});

test('crashes outside the restart window are forgotten', async () => {
  const t = await running({ restartWindowMs: 10_000 });
  for (let round = 0; round < 6; round++) {
    t.last().exit(1);
    assert.equal(t.proc.state(), 'crashed', `round ${round}`);
    t.clock.advance(1000);
    assert.equal(t.children.length, round + 2, 'the backoff starts over at one second');
    t.last().emit(READY);
    t.proc.sendPcm('mic', samples);
    t.clock.advance(10_000);
    // Keep the heartbeat alive across the quiet stretch.
    t.last().emit(STATS);
  }
  assert.equal(t.proc.state(), 'running');
});

test('maxRestarts and backoffMs are configurable', async () => {
  const t = await running({ maxRestarts: 1, backoffMs: [250] });
  t.last().exit(1);
  t.clock.advance(250);
  assert.equal(t.children.length, 2);
  t.last().emit(READY);
  t.last().exit(1);
  assert.equal(t.proc.state(), 'failed');
});

test('an exit with code 0 that nobody asked for is a crash too', async () => {
  const t = await running();
  t.last().exit(0);
  assert.equal(t.proc.state(), 'crashed');
  t.clock.advance(1000);
  assert.equal(t.children.length, 2);
});

test('other error events are forwarded and leave the state alone', async () => {
  const t = await running();
  const before = t.events.length;
  const protocol = { type: 'error', code: 'protocol', message: 'Audio for system arrived before its hello frame; it was ignored.' };
  const internal = { type: 'error', code: 'internal' };
  t.last().emit(protocol);
  t.last().emit(internal);
  t.last().out('not an event\n{"type":"segment"}\n');
  assert.deepEqual(t.events.slice(before), [protocol, internal]);
  assert.equal(t.proc.state(), 'running');
});

test('an unsupported language is reported once, from the worker or from the library\'s log', async () => {
  const fromWorker = await running();
  const event = { type: 'error', code: 'lang_unsupported', message: 'no such language' };
  fromWorker.last().emit(event);
  fromWorker.last().emit(event);
  fromWorker.last().err("Unsupported language 'xx-YY' for multilingual NeMo transducer; using auto\n");
  assert.deepEqual(
    fromWorker.events.filter((e) => e.type === 'error'),
    [event],
  );

  const fromLog = await running();
  // Split across two stderr chunks.
  fromLog.last().err("online-transducer-nemo-model.cc Unsupported lang");
  fromLog.last().err("uage 'xx-YY' for multilingual NeMo transducer; using auto\n");
  fromLog.last().err("Unsupported language 'xx-YY' for multilingual NeMo transducer; using auto\n");
  const errors = fromLog.events.filter((e) => e.type === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type === 'error' && errors[0].code, 'lang_unsupported');
  assert.equal(fromLog.proc.state(), 'running');
});

test('failure messages carry the last 2,000 characters of stderr', async () => {
  const t = setup();
  const started = t.proc.start();
  t.last().err('BEGIN-MARKER\n');
  t.last().err(`${'x'.repeat(2500)}\n`);
  t.last().err(new TextEncoder().encode('the last line, réglé\n'));
  t.last().exit(1);
  await assert.rejects(started);
  const message = t.lastMessage();
  assert.match(message, /the last line, réglé$/);
  assert.doesNotMatch(message, /BEGIN-MARKER/);
  const [headline, ...rest] = message.split('\n');
  assert.equal(headline, 'The speech worker stopped while starting (exit code 1).');
  assert.ok(rest.join('\n').length <= 2000);
});

test('segment times stay on the recording\'s clock across a restart', async () => {
  const t = setup();
  const second = new Int16Array(16000);
  t.proc.hello('mic', 16000);
  const started = t.proc.start();
  t.last().emit(READY);
  await started;

  for (let i = 0; i < 3; i++) t.proc.sendPcm('mic', second);
  const first = { type: 'segment', source: 'mic', t0: 0.5, t1: 2.4, text: 'un', isFinal: true };
  t.last().emit(first);
  assert.deepEqual(t.events.at(-1), first, 'the first worker started with the recording: nothing to add');

  t.last().exit(1);
  // Two seconds go by with no worker: dropped, but the clock keeps running.
  t.proc.sendPcm('mic', second);
  t.proc.sendPcm('mic', second);
  t.clock.advance(1000);
  t.last().emit(READY);
  t.proc.sendPcm('mic', second);
  assert.equal(t.last().audio().length, 1);

  // The new worker counts from the first sample it was given, five seconds in.
  t.last().emit({ type: 'segment', source: 'mic', t0: 0.2, t1: 0.9, text: 'deux', isFinal: false });
  assert.deepEqual(t.events.at(-1), { type: 'segment', source: 'mic', t0: 5.2, t1: 5.9, text: 'deux', isFinal: false });
  // A source the new worker has not heard yet is left alone.
  const system = { type: 'segment', source: 'system', t0: 0.1, t1: 0.3, text: 'three', isFinal: true };
  t.last().emit(system);
  assert.deepEqual(t.events.at(-1), system);

  // The last finals of a stopped worker are shifted like the others.
  const stopped = t.proc.stop();
  t.last().exit(0);
  t.last().emit({ type: 'segment', source: 'mic', t0: 0.95, t1: 1.0, text: 'trois', isFinal: true });
  await stopped;
  assert.deepEqual(t.events.at(-1), { type: 'segment', source: 'mic', t0: 5.95, t1: 6, text: 'trois', isFinal: true });
});

test('audio offered before the worker was ready counts as recording time', async () => {
  const t = setup();
  t.proc.hello('mic', 48000);
  t.proc.hello('system', 16000);
  const started = t.proc.start();
  // 1.5 s of microphone audio while the model loads.
  for (let i = 0; i < 15; i++) t.proc.sendPcm('mic', new Int16Array(4800));
  assert.deepEqual(t.last().written, []);
  t.last().emit(READY);
  await started;
  t.proc.sendPcm('mic', new Int16Array(4800));
  t.proc.sendPcm('system', new Int16Array(1600));

  t.last().emit({ type: 'segment', source: 'mic', t0: 0.04, t1: 0.1, text: 'late start', isFinal: true });
  assert.deepEqual(t.events.at(-1), { type: 'segment', source: 'mic', t0: 1.54, t1: 1.6, text: 'late start', isFinal: true });
  const system = { type: 'segment', source: 'system', t0: 0.04, t1: 0.1, text: 'on time', isFinal: true };
  t.last().emit(system);
  assert.deepEqual(t.events.at(-1), system, 'each source has its own clock');
});

test('audio is dropped unless the process is up', async () => {
  const t = setup();
  t.proc.sendPcm('mic', samples);
  t.proc.flush();
  assert.equal(t.proc.state(), 'idle');
  assert.equal(t.children.length, 0);

  const started = t.proc.start();
  t.proc.sendPcm('mic', samples);
  t.proc.flush();
  assert.equal(t.proc.state(), 'spawning');
  assert.deepEqual(t.last().written, []);

  t.last().emit(READY);
  await started;
  t.proc.sendPcm('mic', samples);
  assert.equal(t.last().audio().length, 1);

  const stopped = t.proc.stop();
  t.proc.sendPcm('mic', samples);
  assert.equal(t.last().audio().length, 1);
  t.last().exit(0);
  await stopped;
  t.proc.sendPcm('mic', samples);
  assert.equal(t.last().audio().length, 1);
});

test('an oversized block of samples is split into frames the worker accepts', async () => {
  const t = await running();
  const before = t.last().audio().length;
  const big = new Int16Array(600_000);
  big[0] = 7;
  big[599_999] = -7;
  t.proc.sendPcm('mic', big);
  const audio = t.last().audio().slice(before);
  assert.deepEqual(
    audio.map((frame) => frame.payload.length),
    [1024 * 1024, 600_000 * 2 - 1024 * 1024],
  );
  assert.deepEqual([...audio[0].payload.subarray(0, 2)], [7, 0]);
  assert.deepEqual([...audio[1].payload.subarray(-2)], [0xf9, 0xff]);
});

test('a write error on a dead pipe is swallowed', async () => {
  const t = await running();
  t.last().stdin.write = () => {
    throw new Error('write EPIPE');
  };
  t.proc.sendPcm('mic', samples);
  t.proc.flush();
  assert.equal(t.proc.state(), 'running');
});

test('stop says bye, closes stdin and resolves when the worker exits', async () => {
  const t = await running();
  const stopped = t.proc.stop();
  assert.equal(t.proc.state(), 'stopping');
  assert.deepEqual(t.last().controls().at(-1), { type: 'bye' });
  assert.equal(t.last().stdinEnded, true);
  assert.deepEqual(t.last().kills, []);

  // The worker's last finals reach the listener, even those read after the exit.
  const final = { type: 'segment', source: 'mic', t0: 3, t1: 4.5, text: 'à jeudi', isFinal: true };
  t.last().emit(final);
  t.last().exit(0);
  const late = { type: 'segment', source: 'mic', t0: 4.5, t1: 5, text: 'merci', isFinal: true };
  t.last().emit(late);
  await stopped;
  assert.equal(t.proc.state(), 'exited');
  assert.deepEqual(t.events.slice(-2), [final, late]);
  assert.deepEqual(t.stateNames(), ['spawning', 'ready', 'running', 'stopping', 'exited']);

  t.clock.advance(600_000);
  assert.equal(t.children.length, 1, 'nothing restarts after stop');
  assert.deepEqual(t.last().kills, []);
  assert.equal(t.clock.pending(), 0);
});

test('stop waits for the grace period, then kills', async () => {
  const t = await running();
  t.last().diesWhenKilled = true;
  let resolved = false;
  const stopped = t.proc.stop().then(() => {
    resolved = true;
  });
  t.clock.advance(1999);
  await Promise.resolve();
  assert.deepEqual(t.last().kills, []);
  assert.equal(resolved, false);
  assert.equal(t.proc.state(), 'stopping');

  t.clock.advance(1);
  assert.deepEqual(t.last().kills, ['SIGKILL']);
  await stopped;
  assert.equal(t.proc.state(), 'exited');
  assert.equal(t.clock.pending(), 0);
});

test('stop resolves even when the kill is never confirmed', async () => {
  const t = await running({ stopGraceMs: 300 });
  let resolved = false;
  const stopped = t.proc.stop().then(() => {
    resolved = true;
  });
  t.clock.advance(300);
  assert.deepEqual(t.last().kills, ['SIGKILL']);
  await Promise.resolve();
  assert.equal(resolved, false);
  t.clock.advance(300);
  await stopped;
  assert.equal(t.proc.state(), 'exited');
  // The exit that finally arrives is ignored.
  t.last().exit(null, 'SIGKILL');
  assert.equal(t.proc.state(), 'exited');
});

test('stop is idempotent', async () => {
  const t = await running();
  const first = t.proc.stop();
  const second = t.proc.stop();
  assert.equal(first, second);
  t.last().exit(0);
  await first;
  const third = t.proc.stop();
  assert.equal(third, first);
  await third;
  assert.equal(t.last().controls().filter((message) => message.type === 'bye').length, 1);
  assert.deepEqual(t.stateNames().slice(-2), ['stopping', 'exited']);
});

test('stop before start, and start after stop', async () => {
  const t = setup();
  await t.proc.stop();
  assert.equal(t.proc.state(), 'exited');
  await assert.rejects(t.proc.start(), /The speech worker was stopped/);
  assert.equal(t.children.length, 0);
});

test('stop while spawning rejects the start and still shuts the worker down', async () => {
  const t = setup();
  const started = t.proc.start();
  const stopped = t.proc.stop();
  await assert.rejects(started, /stopped before it was ready/);
  assert.equal(t.proc.state(), 'stopping');
  // A ready that crosses the stop on the wire does not revive it.
  t.last().emit(READY);
  assert.equal(t.proc.state(), 'stopping');
  t.clock.advance(20_000);
  assert.deepEqual(t.last().kills, ['SIGKILL']);
  t.last().exit(null, 'SIGKILL');
  await stopped;
  assert.equal(t.proc.state(), 'exited');
  assert.equal(t.children.length, 1);
});

test('stop during the backoff cancels the restart', async () => {
  const t = await running();
  t.last().exit(1);
  assert.equal(t.proc.state(), 'crashed');
  await t.proc.stop();
  assert.equal(t.proc.state(), 'exited');
  t.clock.advance(600_000);
  assert.equal(t.children.length, 1);
  assert.equal(t.clock.pending(), 0);
});

test('stop keeps the failed and not-installed states', async () => {
  const failed = setup();
  const start1 = failed.proc.start();
  failed.clock.advance(20_000);
  await assert.rejects(start1);
  await failed.proc.stop();
  assert.equal(failed.proc.state(), 'failed');

  const missing = setup();
  const start2 = missing.proc.start();
  // The error event arrives while the worker is still on its way out.
  missing.last().emit({ type: 'error', code: 'model_missing', message: 'no model' });
  await assert.rejects(start2);
  const stopped = missing.proc.stop();
  assert.equal(missing.proc.state(), 'not-installed');
  missing.last().exit(2);
  await stopped;
  assert.equal(missing.proc.state(), 'not-installed');
  assert.ok(!missing.stateNames().includes('stopping'));
});

test('audio sent from the ready callback follows the hellos', async () => {
  const clock = manualClock();
  const children: FakeChild[] = [];
  const proc: SttProcess = new SttProcess({
    spawn() {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    clock,
    onEvent: () => {},
    // What an adapter does that kept the audio captured while the model was loading.
    onState: (state) => {
      if (state === 'ready') proc.sendPcm('mic', samples);
    },
  });
  proc.hello('mic', 48000);
  proc.hello('system', 16000);
  const started = proc.start();
  children[0].emit(READY);
  await started;
  assert.equal(proc.state(), 'running');
  assert.deepEqual(
    children[0].frames().map((frame) => frame.source),
    [255, 255, 0],
    'the worker ignores audio that arrives before its hello',
  );

  // The same on a restart.
  children[0].exit(1);
  clock.advance(1000);
  children[1].emit(READY);
  assert.deepEqual(children[1].frames().map((frame) => frame.source), [255, 255, 0]);
});

test('stop called from a state callback leaves no worker and no timer behind', async () => {
  // The state at which the listener answers with stop(), and whether it is the first worker or a replacement.
  const scenarios: Array<[SttState, 'first' | 'replacement']> = [
    ['spawning', 'first'],
    ['spawning', 'replacement'],
    ['ready', 'first'],
    ['running', 'first'],
    ['crashed', 'first'],
  ];
  for (const [target, which] of scenarios) {
    const what = `stop on ${target} (${which} worker)`;
    const clock = manualClock();
    const children: FakeChild[] = [];
    let armed = which === 'first';
    let stopped: Promise<void> | null = null;
    const proc: SttProcess = new SttProcess({
      spawn() {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      clock,
      onEvent: () => {},
      onState: (state) => {
        if (state === target && armed && !stopped) stopped = proc.stop();
      },
    });
    const started = proc.start();
    started.catch(() => {});
    if (target !== 'spawning' || which === 'replacement') {
      children[0].emit(READY);
      if (target !== 'ready') proc.sendPcm('mic', samples);
      if (target === 'crashed' || which === 'replacement') children[0].exit(1);
      if (which === 'replacement') {
        armed = true;
        clock.advance(1000);
      }
    }
    assert.ok(stopped, `${what}: the callback ran`);
    // Whatever worker is alive was told to leave; it does.
    for (const child of children) {
      if (child.stdinEnded) child.exit(0);
    }
    await stopped;
    assert.equal(proc.state(), 'exited', what);
    assert.equal(clock.pending(), 0, `${what}: no timer is left`);
    const expected = target === 'spawning' ? (which === 'first' ? 0 : 1) : 1;
    assert.equal(children.length, expected, `${what}: nothing is spawned once stop has been asked`);
    clock.advance(600_000);
    assert.equal(children.length, expected, what);
    assert.ok(children.every((child) => child.kills.length === 0), what);
  }
});

test('a line that the exit event cuts in two is still delivered', async () => {
  const t = await running();
  const stopped = t.proc.stop();
  const final = { type: 'segment', source: 'mic', t0: 1, t1: 2.5, text: 'à la semaine prochaine', isFinal: true };
  const bytes = new TextEncoder().encode(`${JSON.stringify(final)}\n`);
  // Cut inside the two-byte "à": the pipe is read in pieces and `exit` can come between two of them.
  const cut = bytes.indexOf(0xc3) + 1;
  t.last().out(bytes.subarray(0, cut));
  t.last().exit(0);
  await stopped;
  assert.equal(t.proc.state(), 'exited');
  t.last().out(bytes.subarray(cut));
  assert.deepEqual(t.events.at(-1), final);
});

test('the same for a worker that crashed: its last line is not lost to the restart', async () => {
  const t = await running();
  const final = { type: 'segment', source: 'mic', t0: 3, t1: 4, text: 'merci', isFinal: true };
  const line = `${JSON.stringify(final)}\n`;
  t.last().out(line.slice(0, 20));
  t.last().exit(null, 'SIGSEGV');
  assert.equal(t.proc.state(), 'crashed');
  t.last().out(line.slice(20));
  assert.deepEqual(t.events.at(-1), final);
  // Once the replacement is spawned the old worker is no longer listened to.
  t.clock.advance(1000);
  t.children[0].emit({ type: 'segment', source: 'mic', t0: 5, t1: 6, text: 'stale', isFinal: true });
  assert.deepEqual(t.events.at(-1), final);
});
