import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GIVE_UP_MS, WriteQueue } from '../src/notes/writeQueue.ts';
import type { WriteQueueDeps, WriteQueueOptions } from '../src/notes/writeQueue.ts';
import type { Clock, Patch, WriteOutcome } from '../src/types.ts';

/** Lets promise continuations run before the next step of a test. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class ManualClock implements Clock {
  private time = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.time + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  setInterval(): unknown {
    throw new Error('The write queue does not use intervals.');
  }

  clearInterval(): void {}

  armed(): number {
    return this.timers.size;
  }

  /** Moves time forward, firing due timers in order and letting promises settle after each. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    await settle();
    for (;;) {
      let next: { id: number; at: number; fn: () => void } | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (next === null || timer.at < next.at)) next = { id, ...timer };
      }
      if (next === null) break;
      this.timers.delete(next.id);
      this.time = next.at;
      next.fn();
      await settle();
    }
    this.time = target;
    await settle();
  }
}

interface WriteCall {
  at: number;
  path: string;
  patches: Patch[];
}

type Answer = WriteOutcome | Error | Promise<WriteOutcome>;

interface Harness {
  clock: ManualClock;
  queue: WriteQueue;
  calls: WriteCall[];
  outcomes: Array<{ path: string; outcome: WriteOutcome }>;
  errors: Array<{ path: string; error: unknown }>;
  pendingLog: number[];
  /** Answers handed out in order; once used up, every write is `ok`. */
  answers: Answer[];
  /** Highest number of writes to one path that were running at the same time. */
  maxOverlap(): number;
}

function harness(opts?: WriteQueueOptions, extra?: Partial<WriteQueueDeps>): Harness {
  const clock = new ManualClock();
  const calls: WriteCall[] = [];
  const outcomes: Harness['outcomes'] = [];
  const errors: Harness['errors'] = [];
  const pendingLog: number[] = [];
  const answers: Answer[] = [];
  const running = new Map<string, number>();
  let overlap = 0;

  const deps: WriteQueueDeps = {
    clock,
    async write(path, patches) {
      calls.push({ at: clock.now(), path, patches });
      const active = (running.get(path) ?? 0) + 1;
      running.set(path, active);
      overlap = Math.max(overlap, active);
      try {
        const answer: Answer = answers.shift() ?? { status: 'ok' };
        if (answer instanceof Error) throw answer;
        return await answer;
      } finally {
        running.set(path, (running.get(path) ?? 1) - 1);
      }
    },
    onOutcome: (path, outcome) => outcomes.push({ path, outcome }),
    onError: (path, error) => errors.push({ path, error }),
    onPendingChange: (pending) => pendingLog.push(pending),
    ...extra,
  };

  return {
    clock,
    queue: new WriteQueue(deps, opts),
    calls,
    outcomes,
    errors,
    pendingLog,
    answers,
    maxOverlap: () => overlap,
  };
}

function deferred(): { promise: Promise<WriteOutcome>; resolve(outcome: WriteOutcome): void; reject(error: unknown): void } {
  let resolve!: (outcome: WriteOutcome) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<WriteOutcome>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** True once the promise has settled, without waiting for it. */
async function isDone(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await settle();
  return done;
}

const A = 'Inbox/Mtg-2026-10-09 - Sync.md';
const B = 'Inbox/Mtg-2026-10-09 - Steering.md';

const enhanced = (content: string): Patch => ({ region: 'enhanced', content });
const summary = (content: string): Patch => ({ region: 'summary', content });
const qa = (content: string): Patch => ({ region: 'qa', content });
const transcript = (append: string): Patch => ({ region: 'transcript', append });

describe('WriteQueue: coalescing', () => {
  it('keeps one patch per region: the newest replace, transcript text in order', async () => {
    const h = harness();
    h.queue.enqueue(A, enhanced('v1'));
    h.queue.enqueue(A, transcript('> one'));
    h.queue.enqueue(A, enhanced('v2'));
    h.queue.enqueue(A, summary('s1'));
    h.queue.enqueue(A, transcript('> two\n'));
    h.queue.enqueue(A, transcript('> three'));
    h.queue.enqueue(A, enhanced('v3'));
    assert.equal(h.queue.pending(), 3);

    await h.clock.advance(5000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].path, A);
    assert.deepEqual(h.calls[0].patches, [enhanced('v3'), transcript('> one\n> two\n> three'), summary('s1')]);
    assert.equal(h.queue.pending(), 0);
  });

  it('keeps paths apart', async () => {
    const h = harness();
    h.queue.enqueue(A, enhanced('for a'));
    h.queue.enqueue(B, enhanced('for b'));
    h.queue.enqueue(B, qa('q'));
    assert.equal(h.queue.pending(), 3);

    await h.clock.advance(5000);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls.find((c) => c.path === A)?.patches, [enhanced('for a')]);
    assert.deepEqual(h.calls.find((c) => c.path === B)?.patches, [enhanced('for b'), qa('q')]);
  });

  it('ignores an empty transcript append', async () => {
    const h = harness();
    h.queue.enqueue(A, transcript(''));
    h.queue.enqueue(A, transcript('\n  \n'));
    assert.equal(h.queue.pending(), 0);
    assert.equal(h.clock.armed(), 0);
    await h.clock.advance(60000);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.pendingLog, []);
  });

  it('writes an empty replace: clearing a region is a real change', async () => {
    const h = harness();
    h.queue.enqueue(A, summary(''));
    await h.clock.advance(5000);
    assert.deepEqual(h.calls[0].patches, [summary('')]);
  });
});

describe('WriteQueue: timing', () => {
  it('writes idleMs after the last enqueue', async () => {
    const h = harness();
    h.queue.enqueue(A, enhanced('v1'));
    await h.clock.advance(3000);
    h.queue.enqueue(A, enhanced('v2'));
    await h.clock.advance(4999);
    assert.equal(h.calls.length, 0);
    await h.clock.advance(1);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].at, 8000);
    assert.deepEqual(h.calls[0].patches, [enhanced('v2')]);
  });

  it('writes no later than maxWaitMs after the first pending enqueue', async () => {
    const h = harness();
    for (let i = 0; i < 8; i += 1) {
      h.queue.enqueue(A, enhanced(`v${i}`));
      if (i < 7) await h.clock.advance(4000);
    }
    assert.equal(h.clock.now(), 28000);
    await h.clock.advance(1999);
    assert.equal(h.calls.length, 0);
    await h.clock.advance(1);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].at, 30000);
    assert.deepEqual(h.calls[0].patches, [enhanced('v7')]);
  });

  it('starts a new max-wait window after each write', async () => {
    const h = harness();
    h.queue.enqueue(A, enhanced('first'));
    await h.clock.advance(5000);
    assert.equal(h.calls.length, 1);

    await h.clock.advance(40000);
    h.queue.enqueue(A, enhanced('second'));
    await h.clock.advance(4999);
    assert.equal(h.calls.length, 1);
    await h.clock.advance(1);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].at, 50000);
  });

  it('honours custom idle and max-wait options', async () => {
    const h = harness({ idleMs: 100, maxWaitMs: 250 });
    h.queue.enqueue(A, enhanced('a'));
    await h.clock.advance(90);
    h.queue.enqueue(A, enhanced('b'));
    await h.clock.advance(90);
    h.queue.enqueue(A, enhanced('c'));
    await h.clock.advance(69);
    assert.equal(h.calls.length, 0);
    await h.clock.advance(1);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].at, 250);
  });
});

describe('WriteQueue: one write at a time per path', () => {
  it('does not overlap two flushes', async () => {
    const h = harness();
    const first = deferred();
    const second = deferred();
    h.answers.push(first.promise, second.promise);

    h.queue.enqueue(A, enhanced('v1'));
    const flushOne = h.queue.flush(A);
    assert.equal(h.calls.length, 1);

    h.queue.enqueue(A, enhanced('v2'));
    const flushTwo = h.queue.flush(A);
    await settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.queue.pending(), 1);

    first.resolve({ status: 'ok' });
    await settle();
    assert.equal(await isDone(flushOne), true);
    assert.equal(await isDone(flushTwo), false);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[1].patches, [enhanced('v2')]);

    second.resolve({ status: 'ok' });
    await flushTwo;
    assert.equal(h.maxOverlap(), 1);
    assert.equal(h.queue.pending(), 0);
  });

  it('waits for a timed write in flight before starting the next', async () => {
    const h = harness();
    const first = deferred();
    h.answers.push(first.promise);

    h.queue.enqueue(A, transcript('> one'));
    await h.clock.advance(5000);
    assert.equal(h.calls.length, 1);

    h.queue.enqueue(A, transcript('> two'));
    await h.clock.advance(60000);
    assert.equal(h.calls.length, 1);

    first.resolve({ status: 'ok' });
    await settle();
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[1].patches, [transcript('> two')]);
    assert.equal(h.maxOverlap(), 1);
  });

  it('writes different paths concurrently', async () => {
    const h = harness();
    const first = deferred();
    const second = deferred();
    h.answers.push(first.promise, second.promise);
    h.queue.enqueue(A, enhanced('a'));
    h.queue.enqueue(B, enhanced('b'));

    const flushed = h.queue.flush();
    assert.equal(h.calls.length, 2);
    assert.equal(await isDone(flushed), false);
    first.resolve({ status: 'ok' });
    assert.equal(await isDone(flushed), false);
    second.resolve({ status: 'ok' });
    await flushed;
    assert.equal(h.queue.pending(), 0);
  });
});

describe('WriteQueue: outcomes', () => {
  it('puts a retried batch back under what arrived meanwhile', async () => {
    const h = harness();
    const first = deferred();
    h.answers.push(first.promise);

    h.queue.enqueue(A, enhanced('old enhanced'));
    h.queue.enqueue(A, qa('old qa'));
    h.queue.enqueue(A, transcript('> one'));
    await h.clock.advance(5000);
    assert.equal(h.calls.length, 1);

    h.queue.enqueue(A, transcript('> two'));
    h.queue.enqueue(A, enhanced('new enhanced'));
    h.queue.enqueue(A, summary('new summary'));
    assert.equal(h.queue.pending(), 4);

    first.resolve({ status: 'retry', afterMs: 1000 });
    await settle();
    assert.equal(h.queue.pending(), 4);
    assert.deepEqual(h.outcomes, []);

    await h.clock.advance(999);
    assert.equal(h.calls.length, 1);
    await h.clock.advance(1);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].at, 6000);
    assert.deepEqual(h.calls[1].patches, [
      enhanced('new enhanced'),
      qa('old qa'),
      transcript('> one\n> two'),
      summary('new summary'),
    ]);
    assert.equal(h.queue.pending(), 0);
  });

  it('retries after afterMs, not after another idle period', async () => {
    const h = harness();
    h.answers.push({ status: 'retry', afterMs: 700 }, { status: 'retry', afterMs: 300 });
    h.queue.enqueue(A, enhanced('v1'));
    await h.clock.advance(5000);
    assert.equal(h.calls.length, 1);

    await h.clock.advance(400);
    h.queue.enqueue(A, summary('late'));
    await h.clock.advance(300);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].at, 5700);
    assert.deepEqual(h.calls[1].patches, [enhanced('v1'), summary('late')]);

    await h.clock.advance(300);
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls[2].at, 6000);
    assert.equal(h.queue.pending(), 0);
  });

  it('never retries in a tight loop', async () => {
    const h = harness();
    h.answers.push({ status: 'retry', afterMs: 0 }, { status: 'retry', afterMs: -5 });
    h.queue.enqueue(A, enhanced('v1'));
    await h.clock.advance(5000);
    assert.equal(h.calls.length, 1);
    await h.clock.advance(49);
    assert.equal(h.calls.length, 1);
    await h.clock.advance(1);
    assert.equal(h.calls.length, 2);
    await h.clock.advance(50);
    assert.equal(h.calls.length, 3);
  });

  it('reports detached and missing, and drops the batch', async () => {
    const h = harness();
    h.answers.push({ status: 'detached', regions: ['summary'] }, { status: 'missing' });

    h.queue.enqueue(A, summary('s'));
    h.queue.enqueue(A, enhanced('e'));
    await h.clock.advance(5000);
    assert.deepEqual(h.outcomes, [{ path: A, outcome: { status: 'detached', regions: ['summary'] } }]);
    assert.equal(h.queue.pending(), 0);

    h.queue.enqueue(A, enhanced('e2'));
    await h.clock.advance(5000);
    assert.deepEqual(h.outcomes[1], { path: A, outcome: { status: 'missing' } });
    assert.equal(h.queue.pending(), 0);

    await h.clock.advance(120000);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.errors, []);
  });

  it('stays quiet about ok and retry: onOutcome is for what was lost', async () => {
    const h = harness();
    h.answers.push({ status: 'retry', afterMs: 100 });
    h.queue.enqueue(A, enhanced('e'));
    await h.clock.advance(5100);
    assert.equal(h.calls.length, 2);
    assert.equal(h.queue.pending(), 0);
    assert.deepEqual(h.outcomes, []);
    assert.deepEqual(h.errors, []);
  });

  it('tries a write that threw again two seconds later, without a word', async () => {
    const h = harness();
    h.answers.push(new Error('the file is locked'));

    h.queue.enqueue(A, transcript('> one'));
    await h.clock.advance(5000);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.errors, []);
    assert.equal(h.queue.pending(), 1, 'still to be written');

    await h.clock.advance(1999);
    assert.equal(h.calls.length, 1);
    await h.clock.advance(1);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].at, 7000);
    assert.deepEqual(h.calls[1].patches, [transcript('> one')]);
    assert.equal(h.queue.pending(), 0);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.outcomes, []);

    // Written once: nothing is left to try a third time.
    await h.clock.advance(120000);
    assert.equal(h.calls.length, 2);
  });

  it('puts a batch whose write threw back under what arrived meanwhile', async () => {
    const h = harness();
    const first = deferred();
    h.answers.push(first.promise);

    h.queue.enqueue(A, enhanced('old enhanced'));
    h.queue.enqueue(A, qa('old qa'));
    h.queue.enqueue(A, transcript('> one'));
    await h.clock.advance(5000);
    assert.equal(h.calls.length, 1);

    h.queue.enqueue(A, transcript('> two'));
    h.queue.enqueue(A, enhanced('new enhanced'));
    h.queue.enqueue(A, summary('new summary'));
    assert.equal(h.queue.pending(), 4);

    first.reject(new Error('nope'));
    await settle();
    assert.equal(h.queue.pending(), 4);
    assert.deepEqual(h.errors, []);

    // The retry, not the idle delay of what was enqueued since, decides when.
    await h.clock.advance(1999);
    assert.equal(h.calls.length, 1);
    await h.clock.advance(1);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[1].patches, [
      enhanced('new enhanced'),
      qa('old qa'),
      transcript('> one\n> two'),
      summary('new summary'),
    ]);
    assert.equal(h.queue.pending(), 0);
  });

  it('drops a batch after three attempts, reports it once, and keeps going', async () => {
    const h = harness();
    const errors = [new Error('disk said no'), new Error('disk said no again'), new Error('disk said no for good')];
    h.answers.push(...errors);

    h.queue.enqueue(A, enhanced('lost'));
    await h.clock.advance(5000 + 2000);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.errors, []);
    assert.equal(h.queue.pending(), 1);

    await h.clock.advance(2000);
    assert.deepEqual(
      h.calls.map((call) => call.at),
      [5000, 7000, 9000],
    );
    // The error of the attempt that gave up: the one the user can still act on.
    assert.deepEqual(h.errors, [{ path: A, error: errors[2] }]);
    assert.deepEqual(h.outcomes, []);
    assert.equal(h.queue.pending(), 0);

    await h.clock.advance(120000);
    assert.equal(h.calls.length, 3, 'a dropped batch is not tried a fourth time');

    // The next batch starts with a clean slate: one failure does not drop it.
    h.answers.push(new Error('once more'));
    h.queue.enqueue(A, enhanced('next'));
    await h.clock.advance(5000 + 2000);
    assert.equal(h.calls.length, 5);
    assert.deepEqual(h.calls[4].patches, [enhanced('next')]);
    assert.equal(h.errors.length, 1);
    assert.equal(h.queue.pending(), 0);
  });

  it('counts the attempts of one batch, whatever the host answers in between', async () => {
    const h = harness();
    h.answers.push(new Error('one'), { status: 'retry', afterMs: 500 }, new Error('two'), new Error('three'));
    h.queue.enqueue(A, enhanced('stubborn'));
    await h.clock.advance(5000 + 2000 + 500 + 2000);
    assert.equal(h.calls.length, 4);
    assert.equal(h.errors.length, 1);
    assert.equal(h.queue.pending(), 0);
  });

  it('gives a failed write its three attempts again once one went through', async () => {
    const h = harness();
    h.answers.push(new Error('one'), new Error('two'), { status: 'ok' }, new Error('three'), new Error('four'));
    h.queue.enqueue(A, enhanced('first'));
    await h.clock.advance(5000 + 2000 + 2000);
    assert.equal(h.calls.length, 3);
    assert.equal(h.queue.pending(), 0);

    h.queue.enqueue(A, enhanced('second'));
    await h.clock.advance(5000 + 2000 + 2000);
    assert.equal(h.calls.length, 6);
    assert.deepEqual(h.calls[5].patches, [enhanced('second')]);
    assert.deepEqual(h.errors, []);
    assert.equal(h.queue.pending(), 0);
  });

  it('treats a write that resolves without an outcome as a failed write', async () => {
    const h = harness();
    const nothing = (): Promise<WriteOutcome> => Promise.resolve(undefined as unknown as WriteOutcome);
    h.answers.push(nothing());
    h.queue.enqueue(A, enhanced('late'));
    await h.clock.advance(5000);
    assert.equal(h.errors.length, 0);
    assert.deepEqual(h.outcomes, [], 'an answer without a status is not an outcome to report');
    assert.equal(h.queue.pending(), 1);
    await h.clock.advance(2000);
    assert.deepEqual(h.calls[1].patches, [enhanced('late')]);
    assert.equal(h.queue.pending(), 0);

    // Three times in a row, and the batch is given up like one whose write threw.
    h.answers.push(nothing(), Promise.resolve({} as WriteOutcome), nothing());
    h.queue.enqueue(A, enhanced('lost'));
    await h.clock.advance(5000 + 2000 + 2000);
    assert.equal(h.errors.length, 1);
    assert.ok(h.errors[0].error instanceof Error);
    assert.deepEqual(h.outcomes, []);
    assert.equal(h.queue.pending(), 0);

    h.queue.enqueue(A, enhanced('next'));
    await h.clock.advance(5000);
    assert.deepEqual(h.calls[h.calls.length - 1].patches, [enhanced('next')]);
  });

  it('survives a write function that throws synchronously', async () => {
    const boom = new Error('not even a promise');
    let throws = 1;
    const calls: Patch[][] = [];
    const h = harness(undefined, {
      write(_path, patches) {
        if (throws > 0) {
          throws -= 1;
          throw boom;
        }
        calls.push(patches);
        return Promise.resolve({ status: 'ok' });
      },
    });

    h.queue.enqueue(A, enhanced('late'));
    const flushed = h.queue.flush(A);
    await h.clock.advance(2000);
    await flushed;
    assert.deepEqual(h.errors, []);
    assert.deepEqual(calls, [[enhanced('late')]]);

    throws = 3;
    h.queue.enqueue(A, enhanced('lost'));
    await h.clock.advance(5000 + 2000 + 2000);
    assert.deepEqual(h.errors, [{ path: A, error: boom }]);
    assert.equal(h.queue.pending(), 0);

    h.queue.enqueue(A, enhanced('next'));
    await h.queue.flush(A);
    assert.deepEqual(calls, [[enhanced('late')], [enhanced('next')]]);
  });

  it('keeps what was enqueued during the write that gave up', async () => {
    const h = harness();
    const last = deferred();
    h.answers.push(new Error('one'), new Error('two'), last.promise);
    h.queue.enqueue(A, enhanced('lost'));
    await h.clock.advance(5000 + 2000 + 2000);
    assert.equal(h.calls.length, 3);
    h.queue.enqueue(A, summary('kept'));

    last.reject(new Error('nope'));
    await settle();
    assert.equal(h.errors.length, 1);
    assert.equal(h.queue.pending(), 1);
    await h.clock.advance(5000);
    assert.deepEqual(h.calls[3].patches, [summary('kept')]);
  });

  it('is not wedged by callbacks that throw', async () => {
    let thrown = 0;
    const listenerBug = (): never => {
      thrown += 1;
      throw new Error('listener bug');
    };
    const h = harness(undefined, {
      onOutcome: listenerBug,
      onError: listenerBug,
      onPendingChange: listenerBug,
    });
    const boom = new Error('disk said no');
    h.answers.push({ status: 'missing' }, boom, boom, boom);

    h.queue.enqueue(A, enhanced('one'));
    await h.clock.advance(5000);
    h.queue.enqueue(A, enhanced('two'));
    await h.clock.advance(5000 + 2000 + 2000);
    h.queue.enqueue(A, enhanced('three'));
    await h.queue.flush(A);

    assert.equal(h.calls.length, 5);
    assert.deepEqual(h.calls[4].patches, [enhanced('three')]);
    assert.equal(h.queue.pending(), 0);
    // One outcome, one error, and six changes of the pending count.
    assert.equal(thrown, 8);
  });

  it('lets callbacks and the write function call back into the queue', async () => {
    const log: string[] = [];
    let writes = 0;
    const h = harness(undefined, {
      write(path, patches) {
        writes += 1;
        log.push(`write ${patches.map((p) => (p.region === 'transcript' ? p.append : p.content)).join('+')}`);
        // A flush from inside the write must not start a second, overlapping write.
        void h.queue.flush(path, 100);
        if (writes === 1) return Promise.resolve({ status: 'missing' });
        // Three in a row: the batch is given up, and onError hears of it.
        if (writes <= 4) return Promise.reject(new Error('disk said no'));
        return Promise.resolve({ status: 'ok' });
      },
      onOutcome: (path, outcome) => {
        log.push(outcome.status);
        h.queue.enqueue(path, enhanced('from onOutcome'));
      },
      onError: (path) => {
        log.push('error');
        h.queue.enqueue(path, enhanced('from onError'));
        h.queue.dispose();
      },
    });

    h.queue.enqueue(A, enhanced('first'));
    await h.clock.advance(60000);
    // The flush still waiting when onError runs writes the patch at once; dispose then silences the rest.
    assert.deepEqual(log, [
      'write first',
      'missing',
      'write from onOutcome',
      'write from onOutcome',
      'write from onOutcome',
      'error',
      'write from onError',
    ]);
    assert.equal(h.queue.pending(), 0);
    assert.equal(h.clock.armed(), 0);
  });

  it('works without optional callbacks', async () => {
    const clock = new ManualClock();
    const written: string[] = [];
    const queue = new WriteQueue({
      clock,
      write: async (path) => {
        written.push(path);
        return { status: 'ok' };
      },
    });
    queue.enqueue(A, enhanced('x'));
    await queue.flush();
    assert.deepEqual(written, [A]);
  });
});

describe('WriteQueue: hold', () => {
  it('delays a scheduled write until the hold expires', async () => {
    const h = harness();
    h.queue.hold(A, 8000);
    h.queue.enqueue(A, enhanced('held'));
    await h.clock.advance(7999);
    assert.equal(h.calls.length, 0);
    await h.clock.advance(1);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].at, 8000);
  });

  it('applies to a write that was already scheduled, and only to its path', async () => {
    const h = harness();
    h.queue.enqueue(A, enhanced('a'));
    h.queue.enqueue(B, enhanced('b'));
    await h.clock.advance(4000);
    h.queue.hold(A, 3000);
    await h.clock.advance(1000);
    assert.deepEqual(h.calls.map((c) => c.path), [B]);
    await h.clock.advance(1999);
    assert.equal(h.calls.length, 1);
    await h.clock.advance(1);
    assert.deepEqual(h.calls.map((c) => [c.path, c.at]), [[B, 5000], [A, 7000]]);
  });

  it('does not delay a write that is due later anyway, and a shorter hold never shortens a longer one', async () => {
    const h = harness();
    h.queue.hold(A, 1000);
    h.queue.enqueue(A, enhanced('a'));
    await h.clock.advance(5000);
    assert.equal(h.calls[0].at, 5000);

    h.queue.hold(B, 9000);
    h.queue.hold(B, 10);
    h.queue.enqueue(B, enhanced('b'));
    await h.clock.advance(8999);
    assert.equal(h.calls.length, 1);
    await h.clock.advance(1);
    assert.equal(h.calls.length, 2);
  });

  it('ignores a hold that is not a finite time instead of wedging the path', async () => {
    for (const ms of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const h = harness();
      h.queue.hold(A, ms);
      h.queue.enqueue(A, enhanced('still written'));
      await h.clock.advance(5000);
      assert.equal(h.calls.length, 1, String(ms));
      assert.equal(h.queue.pending(), 0);
      assert.equal(h.clock.armed(), 0);
    }
  });

  it('makes flush wait for the hold', async () => {
    const h = harness();
    h.queue.hold(A, 1000);
    h.queue.enqueue(A, enhanced('held'));
    const flushed = h.queue.flush(A);
    assert.equal(h.calls.length, 0);
    await h.clock.advance(999);
    assert.equal(h.calls.length, 0);
    assert.equal(await isDone(flushed), false);
    await h.clock.advance(1);
    assert.equal(h.calls.length, 1);
    assert.equal(await isDone(flushed), true);
  });

  it('lets flush give up at its cap when the hold is longer', async () => {
    const h = harness();
    h.queue.hold(A, 10000);
    h.queue.enqueue(A, enhanced('held'));
    const flushed = h.queue.flush(A, 3000);
    await h.clock.advance(2999);
    assert.equal(await isDone(flushed), false);
    await h.clock.advance(1);
    assert.equal(await isDone(flushed), true);
    assert.equal(h.calls.length, 0);
    assert.equal(h.queue.pending(), 1);

    await h.clock.advance(7000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].at, 10000);
    assert.equal(h.queue.pending(), 0);
  });
});

describe('WriteQueue: flush', () => {
  it('writes now instead of waiting for the idle timer', async () => {
    const h = harness();
    h.queue.enqueue(A, enhanced('now'));
    const flushed = h.queue.flush(A);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].at, 0);
    await flushed;
    assert.equal(h.queue.pending(), 0);
    assert.equal(h.clock.armed(), 0);
  });

  it('resolves at once when there is nothing to write', async () => {
    const h = harness();
    await h.queue.flush();
    await h.queue.flush(A);
    h.queue.enqueue(A, enhanced('x'));
    await h.queue.flush(B);
    assert.equal(h.calls.length, 0);
    assert.equal(h.clock.armed(), 1);
  });

  it('flushes only the path it was given', async () => {
    const h = harness();
    h.queue.enqueue(A, enhanced('a'));
    h.queue.enqueue(B, enhanced('b'));
    await h.queue.flush(B);
    assert.deepEqual(h.calls.map((c) => c.path), [B]);
    assert.equal(h.queue.pending(), 1);
  });

  it('honours retry outcomes until the write goes through', async () => {
    const h = harness();
    h.answers.push({ status: 'retry', afterMs: 800 }, { status: 'retry', afterMs: 400 });
    h.queue.enqueue(A, enhanced('x'));
    const flushed = h.queue.flush(A);
    await h.clock.advance(799);
    assert.equal(h.calls.length, 1);
    await h.clock.advance(1);
    assert.equal(h.calls.length, 2);
    assert.equal(await isDone(flushed), false);
    await h.clock.advance(400);
    assert.equal(h.calls.length, 3);
    assert.equal(await isDone(flushed), true);
    assert.equal(h.clock.now(), 1200);
    assert.equal(h.queue.pending(), 0);
  });

  it('gives up at capMs, never rejects, and leaves the patches queued', async () => {
    const h = harness();
    for (let i = 0; i < 6; i += 1) h.answers.push({ status: 'retry', afterMs: 1000 });
    h.queue.enqueue(A, enhanced('stubborn'));
    const flushed = h.queue.flush(A);
    await h.clock.advance(2999);
    assert.equal(h.calls.length, 3);
    assert.equal(await isDone(flushed), false);
    await h.clock.advance(1);
    assert.equal(await isDone(flushed), true);
    assert.equal(h.queue.pending(), 1);

    await h.clock.advance(10000);
    assert.equal(h.queue.pending(), 0);
    assert.deepEqual(h.calls[h.calls.length - 1].patches, [enhanced('stubborn')]);
  });

  it('caps a write that never settles', async () => {
    const h = harness();
    h.answers.push(deferred().promise);
    h.queue.enqueue(A, enhanced('stuck'));
    const flushed = h.queue.flush(undefined, 500);
    await h.clock.advance(499);
    assert.equal(await isDone(flushed), false);
    await h.clock.advance(1);
    assert.equal(await isDone(flushed), true);
    assert.equal(h.queue.pending(), 1);
  });

  it('waits for the second attempt of a write that threw', async () => {
    const h = harness();
    h.answers.push(new Error('nope'), { status: 'missing' });
    h.queue.enqueue(A, enhanced('x'));
    const flushed = h.queue.flush(A);
    assert.equal(h.calls.length, 1);
    await h.clock.advance(1999);
    assert.equal(await isDone(flushed), false);
    await h.clock.advance(1);
    assert.equal(await isDone(flushed), true);
    assert.equal(h.calls.length, 2);
    assert.equal(h.errors.length, 0);
    assert.equal(h.outcomes.length, 1);
    assert.equal(h.queue.pending(), 0);
    assert.equal(h.clock.armed(), 0);
  });

  it('keeps its cap when the write keeps failing, and never rejects', async () => {
    const h = harness();
    h.answers.push(new Error('one'), new Error('two'), new Error('three'));
    h.queue.enqueue(A, enhanced('x'));
    const flushed = h.queue.flush(A);
    await h.clock.advance(2999);
    assert.equal(h.calls.length, 2);
    assert.equal(await isDone(flushed), false);
    await h.clock.advance(1);
    assert.equal(await isDone(flushed), true);
    assert.equal(h.queue.pending(), 1, 'the third attempt is still to come');
    assert.deepEqual(h.errors, []);

    // The attempt the flush did not wait for still happens on time, and ends the batch.
    await h.clock.advance(1000);
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls[2].at, 4000);
    assert.equal(h.errors.length, 1);
    assert.equal(h.queue.pending(), 0);
    assert.equal(h.clock.armed(), 0);

    // A flush is released when the batch it waited for is dropped.
    h.answers.push(new Error('four'), new Error('five'), new Error('six'));
    h.queue.enqueue(A, enhanced('y'));
    const second = h.queue.flush(A, 10000);
    await h.clock.advance(4000);
    assert.equal(await isDone(second), true);
    assert.equal(h.errors.length, 2);
  });

  it('has given a batch whose writes keep throwing up within GIVE_UP_MS of its first try', async () => {
    const h = harness();
    h.answers.push(new Error('one'), new Error('two'), new Error('three'));
    h.queue.enqueue(A, enhanced('x'));
    // A caller that waits that long hears the batch given up, and is released with it.
    const flushed = h.queue.flush(A, GIVE_UP_MS);
    await h.clock.advance(GIVE_UP_MS);
    assert.deepEqual(
      h.calls.map((call) => call.at),
      [0, 2000, 4000],
      'the third try, the one that gives the batch up, two seconds after the second',
    );
    assert.ok(h.calls[2].at <= GIVE_UP_MS);
    assert.equal(h.errors.length, 1);
    assert.equal(await isDone(flushed), true);
    assert.equal(h.queue.pending(), 0);
    assert.equal(h.clock.armed(), 0);
  });

  it('does not wait for what is enqueued after it was called', async () => {
    const h = harness();
    const first = deferred();
    const second = deferred();
    h.answers.push(first.promise, second.promise);
    h.queue.enqueue(A, enhanced('v1'));
    const flushed = h.queue.flush(A);
    h.queue.enqueue(A, enhanced('v2'));

    first.resolve({ status: 'ok' });
    await settle();
    assert.equal(await isDone(flushed), true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.queue.pending(), 1);

    await h.clock.advance(5000);
    assert.equal(h.calls.length, 2);
    second.resolve({ status: 'ok' });
    await settle();
    assert.equal(h.queue.pending(), 0);
  });

  it('waits for a write already in flight', async () => {
    const h = harness();
    const first = deferred();
    h.answers.push(first.promise);
    h.queue.enqueue(A, enhanced('v1'));
    await h.clock.advance(5000);
    assert.equal(h.calls.length, 1);

    const flushed = h.queue.flush(A);
    assert.equal(await isDone(flushed), false);
    first.resolve({ status: 'ok' });
    assert.equal(await isDone(flushed), true);
    assert.equal(h.calls.length, 1);
  });
});

describe('WriteQueue: pending count', () => {
  it('counts (path, region) entries, in flight included', async () => {
    const h = harness();
    const first = deferred();
    h.answers.push(first.promise);
    assert.equal(h.queue.pending(), 0);

    h.queue.enqueue(A, enhanced('a1'));
    h.queue.enqueue(A, enhanced('a2'));
    h.queue.enqueue(A, transcript('> t'));
    h.queue.enqueue(B, enhanced('b1'));
    assert.equal(h.queue.pending(), 3);

    void h.queue.flush(A);
    assert.equal(h.calls.length, 1);
    assert.equal(h.queue.pending(), 3);

    // The same region queued again behind the write in flight is still one entry.
    h.queue.enqueue(A, enhanced('a3'));
    assert.equal(h.queue.pending(), 3);
    h.queue.enqueue(A, qa('q'));
    assert.equal(h.queue.pending(), 4);

    first.resolve({ status: 'ok' });
    await settle();
    assert.equal(h.queue.pending(), 3);
    await h.queue.flush();
    assert.equal(h.queue.pending(), 0);
  });

  it('calls onPendingChange only when the count changes', async () => {
    const h = harness();
    h.queue.enqueue(A, enhanced('a1'));
    h.queue.enqueue(A, enhanced('a2'));
    h.queue.enqueue(A, summary('s'));
    h.queue.enqueue(B, transcript('> t1'));
    h.queue.enqueue(B, transcript('> t2'));
    assert.deepEqual(h.pendingLog, [1, 2, 3]);

    await h.queue.flush(A);
    assert.deepEqual(h.pendingLog, [1, 2, 3, 1]);
    await h.clock.advance(5000);
    assert.deepEqual(h.pendingLog, [1, 2, 3, 1, 0]);
  });

  it('does not report a change for a retry', async () => {
    const h = harness();
    h.answers.push({ status: 'retry', afterMs: 100 });
    h.queue.enqueue(A, enhanced('x'));
    await h.clock.advance(5000);
    assert.deepEqual(h.pendingLog, [1]);
    await h.clock.advance(100);
    assert.deepEqual(h.pendingLog, [1, 0]);
  });

  it('keeps counting a batch whose write threw until it is written or dropped', async () => {
    const h = harness();
    h.answers.push(new Error('one'), new Error('two'), new Error('three'));
    h.queue.enqueue(A, enhanced('x'));
    await h.clock.advance(5000 + 2000);
    assert.deepEqual(h.pendingLog, [1]);
    await h.clock.advance(2000);
    assert.deepEqual(h.pendingLog, [1, 0]);
  });
});

describe('WriteQueue: dispose', () => {
  it('clears timers and drops what was pending', async () => {
    const h = harness();
    h.queue.enqueue(A, enhanced('a'));
    h.queue.enqueue(B, transcript('> t'));
    h.queue.hold(B, 500);
    assert.equal(h.clock.armed(), 2);

    h.queue.dispose();
    assert.equal(h.clock.armed(), 0);
    assert.equal(h.queue.pending(), 0);
    await h.clock.advance(120000);
    assert.equal(h.calls.length, 0);
  });

  it('forgets a batch that was waiting to be tried again', async () => {
    const h = harness();
    h.answers.push(new Error('nope'));
    h.queue.enqueue(A, enhanced('a'));
    await h.clock.advance(5000);
    assert.equal(h.clock.armed(), 1);

    h.queue.dispose();
    assert.equal(h.clock.armed(), 0);
    await h.clock.advance(120000);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.errors, []);
  });

  it('ignores everything afterwards', async () => {
    const h = harness();
    h.queue.dispose();
    h.queue.dispose();
    h.queue.enqueue(A, enhanced('late'));
    h.queue.hold(A, 100);
    await h.queue.flush();
    await h.queue.flush(A);
    await h.clock.advance(60000);
    assert.equal(h.calls.length, 0);
    assert.equal(h.queue.pending(), 0);
    assert.equal(h.clock.armed(), 0);
    assert.deepEqual(h.pendingLog, []);
  });

  it('releases a flush that is waiting and stays quiet when the write lands later', async () => {
    const h = harness();
    const first = deferred();
    h.answers.push(first.promise);
    h.queue.enqueue(A, enhanced('a'));
    const flushed = h.queue.flush(A);
    assert.equal(h.calls.length, 1);

    h.queue.dispose();
    assert.equal(await isDone(flushed), true);
    assert.equal(h.clock.armed(), 0);

    first.resolve({ status: 'retry', afterMs: 10 });
    await h.clock.advance(1000);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.outcomes, []);
    assert.deepEqual(h.pendingLog, [1]);
  });
});
