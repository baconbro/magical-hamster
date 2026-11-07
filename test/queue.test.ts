import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isOllamaError } from '../src/llm/ollama.ts';
import { LlmQueue } from '../src/llm/queue.ts';
import type { Priority } from '../src/types.ts';
import { isAborted } from '../src/util/errors.ts';

const MODEL = 'gemma4:12b';

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Probe {
  /** The caller's promise, with rejections captured so nothing is left unhandled. */
  outcome: Promise<{ ok: true; value: string } | { ok: false; error: unknown }>;
  started: boolean;
  signal: AbortSignal | null;
  finish(value?: string): void;
  fail(error: unknown): void;
}

/** Submits a task the test completes by hand, and records when it starts. */
function submit(
  queue: LlmQueue,
  log: string[],
  name: string,
  priority: Priority,
  key: string | null = null,
  model = MODEL,
): Probe {
  let resolve!: (value: string) => void;
  let reject!: (error: unknown) => void;
  const gate = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const probe: Probe = {
    outcome: Promise.resolve({ ok: true, value: '' }),
    started: false,
    signal: null,
    finish: (value = name) => resolve(value),
    fail: (error) => reject(error),
  };
  probe.outcome = queue
    .run(model, priority, key, (signal) => {
      probe.started = true;
      probe.signal = signal;
      log.push(name);
      return gate;
    })
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  return probe;
}

async function assertAborted(probe: Probe): Promise<void> {
  const outcome = await probe.outcome;
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.ok(isOllamaError(outcome.error, 'aborted'), `expected aborted, got ${String(outcome.error)}`);
    assert.equal(outcome.error.model, MODEL);
  }
}

async function assertValue(probe: Probe, value: string): Promise<void> {
  assert.deepEqual(await probe.outcome, { ok: true, value });
}

test('interactive tasks run one at a time, in order, before live ones', async () => {
  const queue = new LlmQueue();
  const log: string[] = [];
  const first = submit(queue, log, 'i1', 'interactive');
  const live = submit(queue, log, 'live', 'live', 'enhance');
  const second = submit(queue, log, 'i2', 'interactive');
  const third = submit(queue, log, 'i3', 'interactive');

  assert.deepEqual(log, ['i1'], 'a free model starts its task at once');
  await settle();
  assert.deepEqual(log, ['i1'], 'one at a time');

  first.finish();
  await assertValue(first, 'i1');
  assert.deepEqual(log, ['i1', 'i2']);
  second.finish();
  await settle();
  assert.deepEqual(log, ['i1', 'i2', 'i3']);
  third.finish();
  await settle();
  assert.deepEqual(log, ['i1', 'i2', 'i3', 'live']);
  live.finish();
  await assertValue(live, 'live');
});

test('live tasks without a key run in order and are never replaced', async () => {
  const queue = new LlmQueue();
  const log: string[] = [];
  const a = submit(queue, log, 'a', 'live');
  const b = submit(queue, log, 'b', 'live');
  const c = submit(queue, log, 'c', 'live');
  await settle();
  assert.equal(a.signal?.aborted, false);

  a.finish();
  await settle();
  b.finish();
  await settle();
  c.finish();
  await assertValue(a, 'a');
  await assertValue(b, 'b');
  await assertValue(c, 'c');
  assert.deepEqual(log, ['a', 'b', 'c']);
});

test('a queued live task is replaced by a newer one with the same key, in the same place', async () => {
  const queue = new LlmQueue();
  const log: string[] = [];
  const blocker = submit(queue, log, 'blocker', 'interactive');
  const oldA = submit(queue, log, 'old-a', 'live', 'a');
  const b = submit(queue, log, 'b', 'live', 'b');
  const newA = submit(queue, log, 'new-a', 'live', 'a');

  await assertAborted(oldA);
  assert.equal(oldA.started, false, 'a replaced task never runs');

  blocker.finish();
  await settle();
  assert.deepEqual(log, ['blocker', 'new-a'], 'the replacement keeps the turn of the task it replaced');
  newA.finish();
  await settle();
  b.finish();
  await assertValue(newA, 'new-a');
  await assertValue(b, 'b');
  assert.deepEqual(log, ['blocker', 'new-a', 'b']);
});

test('a running live task is aborted by a newer one with the same key, which runs next', async () => {
  const queue = new LlmQueue();
  const log: string[] = [];
  const running = submit(queue, log, 'a1', 'live', 'a');
  const other = submit(queue, log, 'b', 'live', 'b');
  assert.equal(running.signal?.aborted, false);

  const replacement = submit(queue, log, 'a2', 'live', 'a');
  assert.equal(running.signal?.aborted, true, 'the signal fires at once');

  let settled = false;
  void running.outcome.then(() => {
    settled = true;
  });
  await settle();
  assert.equal(settled, false, 'it rejects only once its own promise settles');
  assert.deepEqual(log, ['a1'], 'and keeps the slot until then');

  running.fail(new Error('fetch aborted'));
  await assertAborted(running);
  assert.deepEqual(log, ['a1', 'a2'], 'the replacement goes ahead of other live work');

  const latest = submit(queue, log, 'a3', 'live', 'a');
  assert.equal(replacement.signal?.aborted, true);
  replacement.finish();
  await assertAborted(replacement);
  assert.deepEqual(log, ['a1', 'a2', 'a3']);
  latest.finish();
  await settle();
  other.finish();
  await assertValue(latest, 'a3');
  await assertValue(other, 'b');
  assert.deepEqual(log, ['a1', 'a2', 'a3', 'b']);
});

test('an interactive task aborts the running live task and starts when it has unwound', async () => {
  const queue = new LlmQueue();
  const log: string[] = [];
  const live = submit(queue, log, 'live', 'live', 'enhance');
  const queuedLive = submit(queue, log, 'live-other', 'live', 'other');
  assert.equal(queue.busy(MODEL), false, 'live work does not make the model busy');

  const ask = submit(queue, log, 'ask', 'interactive');
  assert.equal(live.signal?.aborted, true);
  assert.equal(queue.busy(MODEL), true);
  assert.deepEqual(log, ['live']);

  live.fail(new Error('aborted by the client'));
  await assertAborted(live);
  assert.deepEqual(log, ['live', 'ask']);
  assert.equal(ask.signal?.aborted, false);

  // Live work submitted while interactive work is in flight waits, latest per key.
  const lateOld = submit(queue, log, 'late-old', 'live', 'enhance');
  const lateNew = submit(queue, log, 'late-new', 'live', 'enhance');
  await assertAborted(lateOld);
  assert.equal(ask.signal?.aborted, false, 'live work never aborts interactive work');

  ask.finish();
  await assertValue(ask, 'ask');
  assert.equal(queue.busy(MODEL), false);
  assert.deepEqual(log, ['live', 'ask', 'live-other']);
  queuedLive.finish();
  await settle();
  lateNew.finish();
  await assertValue(lateNew, 'late-new');
  assert.deepEqual(log, ['live', 'ask', 'live-other', 'late-new']);
});

test('an interactive task does not abort a running interactive task', async () => {
  const queue = new LlmQueue();
  const log: string[] = [];
  const summary = submit(queue, log, 'summary', 'interactive');
  const ask = submit(queue, log, 'ask', 'interactive');
  assert.equal(summary.signal?.aborted, false);
  summary.finish();
  await assertValue(summary, 'summary');
  ask.finish();
  await assertValue(ask, 'ask');
});

test('models are independent', async () => {
  const queue = new LlmQueue();
  const log: string[] = [];
  const big = submit(queue, log, 'big', 'interactive', null, 'gemma4:31b');
  const small = submit(queue, log, 'small', 'live', 'enhance', 'gemma4:12b');
  assert.deepEqual(log, ['big', 'small'], 'both run at the same time');
  assert.equal(queue.busy('gemma4:31b'), true);
  assert.equal(queue.busy('gemma4:12b'), false);
  assert.equal(queue.busy('never-used'), false);

  const ask = submit(queue, log, 'ask', 'interactive', null, 'gemma4:31b');
  assert.equal(small.signal?.aborted, false, 'interactive work on one model leaves the other alone');

  small.finish();
  big.finish();
  await settle();
  ask.finish();
  assert.deepEqual(await small.outcome, { ok: true, value: 'small' });
  assert.deepEqual(await big.outcome, { ok: true, value: 'big' });
  assert.deepEqual(await ask.outcome, { ok: true, value: 'ask' });
});

test('a task that throws rejects its caller and does not block the queue', async () => {
  const queue = new LlmQueue();
  const boom = new Error('boom');
  const syncBoom = new Error('sync boom');

  const rejected = queue.run(MODEL, 'interactive', null, async () => {
    throw boom;
  });
  const threw = queue.run(MODEL, 'interactive', null, () => {
    throw syncBoom;
  });
  const after = queue.run(MODEL, 'live', 'enhance', async () => 'still running');

  await assert.rejects(rejected, (error) => error === boom);
  await assert.rejects(threw, (error) => error === syncBoom);
  assert.equal(await after, 'still running');
  assert.equal(queue.busy(MODEL), false);
});

test('a task that throws something other than an Error rejects with an Error that keeps it', async () => {
  const queue = new LlmQueue();
  const thrown = { kind: 'aborted', model: MODEL };
  const threw = queue.run(MODEL, 'interactive', null, () => {
    throw thrown;
  });
  await assert.rejects(threw, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.cause, thrown);
    // What callers read off a rejection is still there.
    assert.equal(isAborted(error), true);
    assert.equal((error as Error & { model?: unknown }).model, MODEL);
    assert.equal(error.message, '');
    return true;
  });
});

test('cancelAll aborts what runs and rejects what waits', async () => {
  const queue = new LlmQueue();
  const log: string[] = [];
  const running = submit(queue, log, 'running', 'interactive');
  const waiting = submit(queue, log, 'waiting', 'interactive');
  const live = submit(queue, log, 'live', 'live', 'enhance');
  const otherModel = submit(queue, log, 'other', 'live', 'enhance', 'gemma4:31b');

  queue.cancelAll();
  assert.equal(running.signal?.aborted, true);
  assert.equal(otherModel.signal?.aborted, true);
  await assertAborted(waiting);
  await assertAborted(live);
  assert.equal(waiting.started, false);
  assert.equal(live.started, false);

  running.fail(new Error('aborted'));
  otherModel.finish();
  await assertAborted(running);
  const other = await otherModel.outcome;
  assert.equal(other.ok, false);
  if (!other.ok) assert.ok(isOllamaError(other.error, 'aborted'));
  assert.equal(queue.busy(MODEL), false);
  assert.deepEqual(log, ['running', 'other']);

  // Still usable afterwards, and safe to call when idle.
  queue.cancelAll();
  assert.equal(await queue.run(MODEL, 'interactive', null, async () => 'again'), 'again');
});

test('a task that ignores its signal and resolves anyway still rejects as aborted', async () => {
  const queue = new LlmQueue();
  const log: string[] = [];
  const stubborn = submit(queue, log, 'stubborn', 'live', 'enhance');
  const ask = submit(queue, log, 'ask', 'interactive');
  assert.equal(stubborn.signal?.aborted, true);

  stubborn.finish('a result nobody wants');
  await assertAborted(stubborn);
  assert.deepEqual(log, ['stubborn', 'ask']);
  ask.finish();
  await assertValue(ask, 'ask');
});

test('a task may submit more work from inside itself', async () => {
  const queue = new LlmQueue();
  const order: string[] = [];
  let inner: Promise<string> | null = null;
  const outer = queue.run(MODEL, 'interactive', null, async () => {
    order.push('outer');
    inner = queue.run(MODEL, 'interactive', null, async () => {
      order.push('inner');
      return 'inner';
    });
    return 'outer';
  });
  assert.equal(await outer, 'outer');
  assert.ok(inner);
  assert.equal(await inner, 'inner');
  assert.deepEqual(order, ['outer', 'inner']);
});

test('a same-key task submitted from the abort listener of the running one replaces the task that caused the abort', async () => {
  const queue = new LlmQueue();
  const log: string[] = [];
  let failFirst!: (error: unknown) => void;
  const unwinding = new Promise<string>((_, reject) => {
    failFirst = reject;
  });
  let third: Promise<string> | null = null;

  const first = queue.run(MODEL, 'live', 'enhance', (signal) => {
    log.push('first');
    // A caller that reacts to the cancellation by asking again, synchronously.
    signal.addEventListener('abort', () => {
      third = queue.run(MODEL, 'live', 'enhance', async () => {
        log.push('third');
        return 'third';
      });
      failFirst(new Error('fetch aborted'));
    });
    return unwinding;
  });
  const second = queue.run(MODEL, 'live', 'enhance', async () => {
    log.push('second');
    return 'second';
  });

  await assert.rejects(first, (error) => isOllamaError(error, 'aborted'));
  await assert.rejects(second, (error) => isOllamaError(error, 'aborted'), 'only the latest task of a key may run');
  assert.ok(third);
  assert.equal(await third, 'third');
  assert.deepEqual(log, ['first', 'third']);
});

test('cancelAll from inside a task aborts that task and leaves the queue usable', async () => {
  const queue = new LlmQueue();
  const inside = queue.run(MODEL, 'interactive', null, async () => {
    queue.cancelAll();
    return 'ignored';
  });
  const after = queue.run(MODEL, 'interactive', null, async () => 'after');
  await assert.rejects(inside, (error) => isOllamaError(error, 'aborted'));
  assert.equal(await after, 'after');
  assert.equal(queue.busy(MODEL), false);
});

test('a hold keeps live tasks waiting between two interactive ones, and lets them go when released', async () => {
  const queue = new LlmQueue();
  const log: string[] = [];
  // A summary read in several calls: between two of them the model is free for an instant.
  const release = queue.hold(MODEL);
  const first = submit(queue, log, 'window-1', 'interactive');
  const live = submit(queue, log, 'live', 'live', 'enhance');
  first.finish();
  await settle();
  assert.deepEqual(log, ['window-1'], 'the live task is not started in the gap');
  assert.equal(live.started, false);

  // Interactive work is not held back: a question asked meanwhile gets the model.
  const question = submit(queue, log, 'question', 'interactive');
  const second = submit(queue, log, 'window-2', 'interactive');
  assert.deepEqual(log, ['window-1', 'question']);
  question.finish();
  await settle();
  second.finish();
  await settle();
  assert.deepEqual(log, ['window-1', 'question', 'window-2']);
  assert.equal(live.started, false);

  release();
  assert.deepEqual(log, ['window-1', 'question', 'window-2', 'live']);
  // Released twice, it counts once.
  release();
  live.finish();
  await assertValue(live, 'live');
});

test('a hold on one model leaves the others alone, and two holds need two releases', async () => {
  const queue = new LlmQueue();
  const log: string[] = [];
  const releaseA = queue.hold(MODEL);
  const releaseB = queue.hold(MODEL);
  const other = submit(queue, log, 'other', 'live', 'enhance', 'gemma4:4b');
  const held = submit(queue, log, 'held', 'live', 'enhance');
  assert.deepEqual(log, ['other']);
  releaseA();
  await settle();
  assert.equal(held.started, false);
  releaseB();
  assert.equal(held.started, true);
  other.finish();
  held.finish();
  await assertValue(held, 'held');
});

test('cancelAll rejects a live task that a hold kept waiting, and the hold still ends cleanly', async () => {
  const queue = new LlmQueue();
  const log: string[] = [];
  const release = queue.hold(MODEL);
  const live = submit(queue, log, 'live', 'live', 'enhance');
  queue.cancelAll();
  await assertAborted(live);
  assert.equal(live.started, false);

  // Work submitted after the cancel, while the hold is still open, waits like before.
  const next = submit(queue, log, 'next', 'live', 'enhance');
  await settle();
  assert.equal(next.started, false);
  release();
  assert.equal(next.started, true);
  next.finish();
  await assertValue(next, 'next');
  assert.equal(queue.busy(MODEL), false);
});
