import type { Embedder, Excerpt, TranscriptChunk, Turn } from '../types.ts';
import { clock } from '../util/text.ts';
import { VectorStore } from './vectorStore.ts';

export interface TranscriptIndexDeps {
  embedder: Embedder;
  /** Speech covered by one chunk. Default 30. */
  chunkSeconds?: number;
  /** Default 900. */
  maxChunkChars?: number;
  /** A new chunk became searchable. */
  onAdvance?(): void;
  onError?(error: unknown): void;
}

/**
 * Requests made for one chunk that failed on the chunk's own account. Past this it stays closed
 * and unsearchable: asked for again at every close, a chunk the server refuses would cost a
 * request per close for the rest of the meeting, and k such chunks k requests each.
 */
const MAX_CHUNK_ATTEMPTS = 3;

/**
 * Ollama down, the model not pulled, or vectors of another dimension than the store's: the next
 * request would fail the same way, whatever the chunk.
 */
function looksGlobal(error: unknown): boolean {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return kind === 'unreachable' || kind === 'model_missing' || kind === 'dimension';
}

function chunkNumber(chunk: TranscriptChunk): number {
  return Number(chunk.id.slice(1));
}

/** The transcript of one meeting, in memory, searchable by meaning. */
export class TranscriptIndex {
  private readonly deps: TranscriptIndexDeps;
  private readonly chunkSeconds: number;
  private readonly maxChunkChars: number;

  private open: Turn[] = [];
  private openChars = 0;
  private closed: TranscriptChunk[] = [];
  private counter = 0;

  private queue: TranscriptChunk[] = [];
  private failed: TranscriptChunk[] = [];
  // Failed requests per chunk id, the global failures left out: those say nothing about the chunk.
  private attempts = new Map<string, number>();
  private running: Promise<void> | null = null;
  // Created with the first vector: the dimension is the embedder's to decide.
  private store: VectorStore<TranscriptChunk> | null = null;
  // Bumped by reset(), so work started for the previous meeting is discarded when it lands.
  private epoch = 0;

  constructor(deps: TranscriptIndexDeps) {
    this.deps = deps;
    this.chunkSeconds = deps.chunkSeconds ?? 30;
    this.maxChunkChars = deps.maxChunkChars ?? 900;
  }

  addTurn(turn: Turn): void {
    // Called from the speech event stream: a malformed turn is skipped, never thrown on.
    const text = typeof turn?.text === 'string' ? turn.text.trim() : '';
    if (!text) return;
    this.openChars += text.length + (this.open.length > 0 ? 1 : 0);
    this.open.push(turn);
    const span = turn.t1 - this.open[0].t0;
    if (span >= this.chunkSeconds || this.openChars >= this.maxChunkChars) this.close();
  }

  /** Closes the open chunk and waits for pending embeddings (failed ones are retried once). */
  async flush(): Promise<void> {
    this.close(false);
    await this.idle();
    // One retry for whatever failed, before this call or during it.
    this.retryFailed();
    await this.idle();
  }

  /** Rejects when the query cannot be embedded. */
  async search(query: string, k: number, minScore: number, signal?: AbortSignal): Promise<Excerpt[]> {
    if (!this.store || this.store.size === 0 || !(k > 0) || !query.trim()) return [];
    const epoch = this.epoch;
    const vector = await this.deps.embedder.embedQuery(query, signal);
    const store = this.store;
    if (this.epoch !== epoch || !store || vector.length !== store.dim) return [];
    return store.search(vector, k, { minScore }).map((hit) => ({
      id: hit.id,
      time: clock(hit.meta.t0),
      text: hit.meta.text,
      score: hit.score,
    }));
  }

  /** Every closed chunk, searchable or not, in order. */
  chunks(): TranscriptChunk[] {
    return this.closed.slice();
  }

  reset(): void {
    this.epoch += 1;
    this.open = [];
    this.openChars = 0;
    this.closed = [];
    this.counter = 0;
    this.queue = [];
    this.failed = [];
    this.attempts.clear();
    this.running = null;
    this.store = null;
  }

  private close(retry = true): void {
    if (this.open.length === 0) return;
    const turns = this.open;
    this.open = [];
    this.openChars = 0;
    this.counter += 1;
    const chunk: TranscriptChunk = {
      id: `E${this.counter}`,
      // Mic and system turns can interleave slightly out of order.
      t0: Math.min(...turns.map((t) => t.t0)),
      t1: Math.max(...turns.map((t) => t.t1)),
      text: turns.map((t) => t.text.trim()).join(' '),
      turnIds: turns.map((t) => t.id),
    };
    this.closed.push(chunk);
    this.queue.push(chunk);
    if (retry) this.retryFailed();
    this.pump();
  }

  private async idle(): Promise<void> {
    this.pump();
    while (this.running) await this.running;
  }

  private retryFailed(): void {
    if (this.failed.length === 0) return;
    const again = this.failed.filter((chunk) => (this.attempts.get(chunk.id) ?? 0) < MAX_CHUNK_ATTEMPTS);
    this.failed = [];
    if (again.length === 0) return;
    this.queue = [...again, ...this.queue].sort((a, b) => chunkNumber(a) - chunkNumber(b));
  }

  /** Embeds queued chunks one at a time, in order. Never rejects. */
  private pump(): void {
    if (this.running || this.queue.length === 0) return;
    const epoch = this.epoch;

    const run = async (): Promise<void> => {
      while (this.epoch === epoch && this.queue.length > 0) {
        const chunk = this.queue.shift() as TranscriptChunk;
        try {
          // No title: the embedder writes "none", as the model expects for untitled text.
          const [vector] = await this.deps.embedder.embedDocuments([{ text: chunk.text }]);
          if (this.epoch !== epoch) return;
          if (!vector) throw new Error('The embedder returned no vector');
          this.store ??= new VectorStore<TranscriptChunk>(vector.length);
          this.store.upsert(chunk.id, vector, chunk);
        } catch (error) {
          if (this.epoch !== epoch) return;
          this.failed.push(chunk);
          if (looksGlobal(error)) {
            // The rest would fail the same way: wait for the next close or flush.
            this.failed.push(...this.queue);
            this.queue = [];
          } else {
            this.attempts.set(chunk.id, (this.attempts.get(chunk.id) ?? 0) + 1);
          }
          this.tell(() => this.deps.onError?.(error));
          continue;
        }
        this.tell(() => this.deps.onAdvance?.());
      }
    };

    const done = run().finally(() => {
      if (this.running !== done) return;
      this.running = null;
      // A chunk can be queued between the loop's last check and this callback.
      this.pump();
    });
    this.running = done;
  }

  /** A throwing listener must not stall the queue or count as an embedding failure. */
  private tell(notify: () => void): void {
    try {
      notify();
    } catch {
      // The listener's own problem.
    }
  }
}
