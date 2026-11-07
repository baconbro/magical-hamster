import type { LlmScheduler, Priority } from '../types.ts';
import { OllamaError } from './ollama.ts';
import { asError } from '../util/errors.ts';

interface Job {
  priority: Priority;
  key: string | null;
  start: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  controller: AbortController;
  aborted: boolean;
}

interface Lane {
  running: Job | null;
  interactive: Job[];
  live: Job[];
  /** Holds not yet released: while there is one, live tasks wait. */
  holds: number;
}

function abortedError(model: string): OllamaError {
  return new OllamaError('aborted', 'The request was cancelled.', { model });
}

/**
 * One generation at a time per model, interactive work first.
 *
 * An aborted task keeps its slot until its promise settles: Ollama serves one
 * request per model, so the next task would only wait inside Ollama behind a
 * request that is still unwinding. A task must therefore honour its signal.
 */
export class LlmQueue implements LlmScheduler {
  private readonly lanes = new Map<string, Lane>();

  run<T>(
    model: string,
    priority: Priority,
    key: string | null,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        priority,
        key,
        start: task,
        resolve: resolve as (value: unknown) => void,
        reject,
        controller: new AbortController(),
        aborted: false,
      };
      const lane = this.laneFor(model);
      if (priority === 'interactive') {
        lane.interactive.push(job);
        // The person is waiting on this one; the live run is redone on the next edit anyway.
        if (lane.running?.priority === 'live') this.abort(lane.running);
      } else {
        this.enqueueLive(model, lane, job);
      }
      this.pump(model, lane);
    });
  }

  hold(model: string): () => void {
    const lane = this.laneFor(model);
    lane.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lane.holds -= 1;
      this.pump(model, lane);
    };
  }

  busy(model: string): boolean {
    const lane = this.lanes.get(model);
    if (!lane) return false;
    return lane.running?.priority === 'interactive' || lane.interactive.length > 0;
  }

  cancelAll(): void {
    for (const [model, lane] of [...this.lanes]) {
      const queued = [...lane.interactive, ...lane.live];
      lane.interactive = [];
      lane.live = [];
      for (const job of queued) job.reject(abortedError(model));
      if (lane.running) this.abort(lane.running);
      // A lane that is held stays: its hold still has to find it to let the next live task go.
      else if (lane.holds === 0) this.lanes.delete(model);
    }
  }

  private laneFor(model: string): Lane {
    let lane = this.lanes.get(model);
    if (!lane) {
      lane = { running: null, interactive: [], live: [], holds: 0 };
      this.lanes.set(model, lane);
    }
    return lane;
  }

  private enqueueLive(model: string, lane: Lane, job: Job): void {
    if (job.key !== null) {
      const at = lane.live.findIndex((queued) => queued.key === job.key);
      if (at >= 0) {
        // Same place in line: a key that is updated often must not starve.
        const old = lane.live[at];
        lane.live[at] = job;
        old?.reject(abortedError(model));
        return;
      }
      if (lane.running?.priority === 'live' && lane.running.key === job.key) {
        // It takes over the slot of the run it supersedes, ahead of other live work.
        // Queued before the abort: a listener may submit the key again from inside
        // it, and that newer task has to find this one in line to replace it.
        lane.live.unshift(job);
        this.abort(lane.running);
        return;
      }
    }
    lane.live.push(job);
  }

  private abort(job: Job): void {
    if (job.aborted) return;
    job.aborted = true;
    job.controller.abort();
  }

  private pump(model: string, lane: Lane): void {
    if (lane.running) return;
    const job = lane.interactive.shift() ?? (lane.holds > 0 ? undefined : lane.live.shift());
    if (!job) {
      if (lane.holds === 0) this.lanes.delete(model);
      return;
    }
    lane.running = job;

    let work: Promise<unknown>;
    try {
      work = Promise.resolve(job.start(job.controller.signal));
    } catch (error) {
      work = Promise.reject(asError(error));
    }

    const settle = (deliver: () => void): void => {
      lane.running = null;
      // Whatever an aborted task ended with, its caller asked for something that is now obsolete.
      if (job.aborted) job.reject(abortedError(model));
      else deliver();
      this.pump(model, lane);
    };
    work.then(
      (value) => settle(() => job.resolve(value)),
      (error) => settle(() => job.reject(error)),
    );
  }
}
