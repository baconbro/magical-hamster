import type { Clock, Patch, Region, WriteOutcome } from '../types.ts';

export interface WriteQueueDeps {
  write(path: string, patches: Patch[]): Promise<WriteOutcome>;
  clock: Clock;
  onOutcome?(path: string, outcome: WriteOutcome): void;
  /** The write threw, or answered nothing, three times in a row: its batch is dropped. Not called for a failure that is tried again. */
  onError?(path: string, error: unknown): void;
  onPendingChange?(pending: number): void;
}

export interface WriteQueueOptions {
  idleMs?: number;
  maxWaitMs?: number;
}

const DEFAULT_IDLE_MS = 5000;
const DEFAULT_MAX_WAIT_MS = 30000;
const DEFAULT_FLUSH_CAP_MS = 3000;
/* A host that keeps answering "retry in 0 ms" must not spin the event loop. */
const MIN_RETRY_MS = 50;
/* A write that threw is tried again before its batch is given up: a file locked by a sync
   client or caught in the middle of a rename is free a moment later. */
const FAILED_RETRY_MS = 2000;
const MAX_ATTEMPTS = 3;
/**
 * Within this long of its first try, a batch whose writes keep throwing has been given up
 * (`onError`): the tries are FAILED_RETRY_MS apart, and the rest is room for the writes
 * themselves. A caller that must hear the batch written or given up waits this long for it.
 */
export const GIVE_UP_MS = FAILED_RETRY_MS * MAX_ATTEMPTS;

interface Waiter {
  /** The enqueue count this flush has to see written. */
  seq: number;
  done(): void;
}

interface PathState {
  path: string;
  queued: Map<Region, Patch>;
  inFlight: Patch[] | null;
  /** Counts enqueues. A batch that finishes records the count it started at. */
  seq: number;
  flightSeq: number;
  settledSeq: number;
  /** Time of the first and the last enqueue of what is queued. */
  firstAt: number;
  lastAt: number;
  /** Set when the batch has to be tried again later; it then waits for nothing else. */
  retryAt: number | null;
  /** Writes of the queued batch that threw so far. */
  failures: number;
  holdUntil: number;
  /** Wrapped because a clock may hand out any value as a handle, 0 and undefined included. */
  timer: { handle: unknown } | null;
  /** Flushes waiting on this path. While there is one, the path writes as soon as it may. */
  waiters: Waiter[];
}

/* Transcript text only ever accumulates; a replace is only ever worth its latest version.
   Newlines at the seam are dropped: a blank line would close the transcript callout. */
function stack(older: Patch | undefined, newer: Patch): Patch {
  if (older?.region === 'transcript' && newer.region === 'transcript') {
    return {
      region: 'transcript',
      append: `${older.append.replace(/[\r\n]+$/, '')}\n${newer.append.replace(/^[\r\n]+/, '')}`,
    };
  }
  return newer;
}

/** Coalesces region patches per companion and writes them one batch at a time per path. */
export class WriteQueue {
  private readonly deps: WriteQueueDeps;
  private readonly idleMs: number;
  private readonly maxWaitMs: number;
  private readonly paths = new Map<string, PathState>();
  /** Finishers of the flushes still waiting, so dispose can release them. */
  private readonly flushes = new Set<() => void>();
  private reported = 0;
  private disposed = false;

  constructor(deps: WriteQueueDeps, opts: WriteQueueOptions = {}) {
    this.deps = deps;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  enqueue(path: string, patch: Patch): void {
    if (this.disposed) return;
    // Nothing to write, so nothing to count as pending.
    if (patch.region === 'transcript' && patch.append.trim() === '') return;

    const s = this.stateOf(path);
    const now = this.deps.clock.now();
    if (s.queued.size === 0) s.firstAt = now;
    s.lastAt = now;
    s.seq += 1;
    s.queued.set(patch.region, stack(s.queued.get(patch.region), patch));
    this.reportPending();
    this.arm(s);
  }

  /** No write to `path` before `ms` from now (used right after creating the file). */
  hold(path: string, ms: number): void {
    // A NaN or endless hold would keep the path from ever being written.
    if (this.disposed || !Number.isFinite(ms)) return;
    const s = this.stateOf(path);
    s.holdUntil = Math.max(s.holdUntil, this.deps.clock.now() + ms);
    this.arm(s);
  }

  /**
   * Writes pending patches now. Honours `retry` outcomes and the wait after a write that threw,
   * until done or `capMs` (default 3000) has passed.
   */
  flush(path?: string, capMs: number = DEFAULT_FLUSH_CAP_MS): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const known = path === undefined ? [...this.paths.values()] : [this.paths.get(path)];
    const open = known.filter((s): s is PathState => s !== undefined && s.seq > s.settledSeq);
    if (open.length === 0) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const mine = new Map<PathState, Waiter>();
      let left = open.length;
      let cap: { handle: unknown } | null = null;

      const finish = (): void => {
        if (!this.flushes.delete(finish)) return;
        if (cap) this.deps.clock.clearTimeout(cap.handle);
        for (const [s, waiter] of mine) {
          const i = s.waiters.indexOf(waiter);
          if (i !== -1) s.waiters.splice(i, 1);
        }
        resolve();
        // What this flush gave up on goes back to its ordinary schedule.
        for (const s of mine.keys()) this.arm(s);
      };

      this.flushes.add(finish);
      for (const s of open) {
        const waiter: Waiter = {
          seq: s.seq,
          done: () => {
            left -= 1;
            if (left === 0) finish();
          },
        };
        mine.set(s, waiter);
        s.waiters.push(waiter);
      }
      cap = { handle: this.deps.clock.setTimeout(finish, Math.max(0, capMs)) };
      for (const s of open) this.arm(s);
    });
  }

  /** Number of (path, region) entries not yet written. */
  pending(): number {
    let count = 0;
    for (const s of this.paths.values()) {
      count += s.queued.size;
      // Still in flight is still not on disk; a region queued again behind it counts once.
      for (const patch of s.inFlight ?? []) {
        if (!s.queued.has(patch.region)) count += 1;
      }
    }
    return count;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.paths.values()) this.disarm(s);
    this.paths.clear();
    // Their cap timers die with the clock, so the flushes are released here.
    for (const finish of [...this.flushes]) finish();
  }

  private stateOf(path: string): PathState {
    let s = this.paths.get(path);
    if (!s) {
      s = {
        path,
        queued: new Map(),
        inFlight: null,
        seq: 0,
        flightSeq: 0,
        settledSeq: 0,
        firstAt: 0,
        lastAt: 0,
        retryAt: null,
        failures: 0,
        holdUntil: 0,
        timer: null,
        waiters: [],
      };
      this.paths.set(path, s);
    }
    return s;
  }

  private disarm(s: PathState): void {
    if (!s.timer) return;
    this.deps.clock.clearTimeout(s.timer.handle);
    s.timer = null;
  }

  private dueAt(s: PathState, now: number): number {
    let due: number;
    if (s.retryAt !== null) due = s.retryAt;
    else if (s.waiters.length > 0) due = now;
    else due = Math.min(s.lastAt + this.idleMs, s.firstAt + this.maxWaitMs);
    return Math.max(due, s.holdUntil);
  }

  /** (Re)schedules the path's next write, or starts it when it is already due. */
  private arm(s: PathState): void {
    this.disarm(s);
    if (this.disposed || s.inFlight !== null || s.queued.size === 0) return;
    const now = this.deps.clock.now();
    const due = this.dueAt(s, now);
    if (due <= now) {
      void this.run(s);
      return;
    }
    const timer = {
      handle: this.deps.clock.setTimeout(() => {
        if (s.timer !== timer) return;
        s.timer = null;
        this.arm(s);
      }, due - now),
    };
    s.timer = timer;
  }

  private async run(s: PathState): Promise<void> {
    const batch = [...s.queued.values()];
    s.queued = new Map();
    s.inFlight = batch;
    s.flightSeq = s.seq;
    s.retryAt = null;

    let outcome: WriteOutcome | undefined;
    let failure: { error: unknown } | null = null;
    try {
      outcome = await this.deps.write(s.path, batch);
      if (typeof outcome?.status !== 'string') {
        failure = { error: new Error('The companion write returned no outcome.') };
      }
    } catch (error) {
      failure = { error };
    }
    if (this.disposed) return;

    s.inFlight = null;
    const asked = !failure && outcome?.status === 'retry' ? outcome : null;
    const again = failure !== null && s.failures + 1 < MAX_ATTEMPTS;
    if (asked || again) {
      // Back UNDER whatever arrived meanwhile: a newer replace wins, older transcript text goes first.
      const merged = new Map<Region, Patch>();
      for (const patch of batch) merged.set(patch.region, patch);
      for (const patch of s.queued.values()) merged.set(patch.region, stack(merged.get(patch.region), patch));
      s.queued = merged;
      if (asked) {
        const afterMs = Number.isFinite(asked.afterMs) ? asked.afterMs : 0;
        s.retryAt = this.deps.clock.now() + Math.max(MIN_RETRY_MS, afterMs);
      } else {
        s.failures += 1;
        s.retryAt = this.deps.clock.now() + FAILED_RETRY_MS;
      }
    } else {
      // Written, or dropped: the host already wrote what it could, or the write threw once too often.
      s.settledSeq = s.flightSeq;
      s.failures = 0;
    }

    // State is final before any callback runs, so a callback may enqueue, flush or dispose.
    if (failure && !again) {
      const { error } = failure;
      this.notify(() => this.deps.onError?.(s.path, error));
    } else if (outcome && !failure && outcome.status !== 'ok' && outcome.status !== 'retry') {
      // Only the outcomes that lost something: `ok` is silent and `retry` is still pending.
      const lost = outcome;
      this.notify(() => this.deps.onOutcome?.(s.path, lost));
    }
    this.reportPending();
    this.release(s);
    this.arm(s);
  }

  private release(s: PathState): void {
    if (s.waiters.length === 0) return;
    const ready = s.waiters.filter((w) => w.seq <= s.settledSeq);
    if (ready.length === 0) return;
    s.waiters = s.waiters.filter((w) => w.seq > s.settledSeq);
    for (const waiter of ready) waiter.done();
  }

  private reportPending(): void {
    if (this.disposed) return;
    const count = this.pending();
    if (count === this.reported) return;
    this.reported = count;
    this.notify(() => this.deps.onPendingChange?.(count));
  }

  /** A throwing callback must not wedge the queue. */
  private notify(call: () => void): void {
    try {
      call();
    } catch {
      // The callback's failure is its owner's to handle; the queue carries on.
    }
  }
}
