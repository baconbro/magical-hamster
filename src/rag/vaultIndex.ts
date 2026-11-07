import type { Clock, Embedder, VaultChunk, VaultIndexIO, VaultIndexStatus } from '../types.ts';
import { shortHash } from '../util/hash.ts';
import { chunkMarkdown } from './chunk.ts';
import { VectorStore } from './vectorStore.ts';

export interface VaultIndexDeps {
  io: VaultIndexIO;
  embedder: Embedder;
  clock: Clock;
  /** Identifies the embedding space, e.g. 'embeddinggemma-2:270m@768'. A change invalidates the stored index. */
  modelId(): string;
  onStatus(status: VaultIndexStatus): void;
  /** Default 30000. */
  saveEveryMs?: number;
  /** Extra exclusions, on top of the folder selection. */
  exclude?: (path: string) => boolean;
}

interface FileEntry {
  mtime: number;
  chunkIds: string[];
}

const DEFAULT_MIN_SCORE = 0.25;

// VaultIndexIO.read does not report a modification time, so a file indexed by
// updateFile is stored with this and re-read by the next build. Its unchanged
// chunks are recognised by hash, so that costs a read, not an embedding.
const MTIME_UNKNOWN = -1;

const MODEL_CHANGED = 'The embedding model changed during indexing. Build the index again.';

/* What an error in the status is about, when something later can prove it over: the save, or one
   note. An error about anything else (Ollama down, the vault not listed) stands until the next build. */
const ABOUT_SAVE = 'save';

function aboutFile(path: string): string {
  return `file\n${path}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function kindOf(error: unknown): unknown {
  return (error as { kind?: unknown } | null)?.kind;
}

/** Ollama down or the model not pulled: every other file would fail the same way. */
function looksGlobal(error: unknown): boolean {
  const kind = kindOf(error);
  return kind === 'unreachable' || kind === 'model_missing';
}

function titleOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

/** '' for the whole vault, otherwise the folder with one trailing slash. */
function folderPrefix(folder: string): string {
  const trimmed = folder.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `${trimmed}/` : '';
}

/**
 * The title a chunk is embedded under: the note name followed by its heading
 * path, so a short passage under "Risks" still carries what it is about.
 * A leading heading that repeats the note name is not said twice.
 */
function embedTitle(chunk: VaultChunk): string {
  const { title } = chunk;
  let heading = chunk.heading;
  if (heading === title) heading = '';
  else if (heading.startsWith(`${title} › `)) heading = heading.slice(title.length + 3);
  return heading ? `${title} › ${heading}` : title;
}

/** Chunks with the same key have the same embedding, apart from a renamed note's title. */
function reuseKey(chunk: VaultChunk): string {
  return `${chunk.hash}\n${chunk.heading}`;
}

/** The knowledge index: chunks of the vault's notes, persisted outside the vault. */
export class VaultIndex {
  private readonly deps: VaultIndexDeps;
  private readonly saveEveryMs: number;

  private store: VectorStore<VaultChunk> | null = null;
  private files = new Map<string, FileEntry>();
  // As given by the caller: the folder picker compares these strings with its own.
  private folders: string[] = [];
  private model: string | null = null;
  private state: VaultIndexStatus = {
    status: 'none',
    files: 0,
    chunks: 0,
    done: 0,
    total: 0,
    folders: [],
    error: null,
  };
  // What `state.error` is about (ABOUT_SAVE, aboutFile). Null when there is no error, or one
  // that no later success takes back.
  private errorAbout: string | null = null;

  // Every operation that changes the index runs through this chain, one at a
  // time, so a build and an incremental update never interleave on a file.
  private tail: Promise<void> = Promise.resolve();
  private building: Promise<void> | null = null;
  private abortBuild: (() => void) | null = null;

  private paused = false;
  private waking: Array<() => void> = [];
  // Files that changed while paused; re-indexed on resume().
  private deferred = new Set<string>();

  private dirty = false;
  private lastSaveAt = 0;
  private saveTimer: unknown = null;
  private saveScheduled = false;
  private disposed = false;

  constructor(deps: VaultIndexDeps) {
    this.deps = deps;
    this.saveEveryMs = deps.saveEveryMs ?? 30000;
  }

  /**
   * Loads the persisted index. A missing, corrupt or other-model index leaves
   * the store empty (status 'none'). Never throws.
   */
  load(): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return;
      this.store = null;
      this.files = new Map();
      this.folders = [];
      this.model = null;
      this.dirty = false;
      try {
        const saved = await this.deps.io.load();
        if (saved) this.restore(saved.index, saved.vectors);
      } catch {
        // A damaged index is rebuilt, never repaired.
      }
      const count = this.files.size;
      this.report({ status: this.usable() ? 'ready' : 'none', done: count, total: count, error: null });
    });
  }

  /**
   * Full sync of `folders`: embeds new and changed chunks, removes vanished files.
   * Resolves (never rejects) when done, aborted, or stopped by an error; see status().
   * While a build runs, another call returns the same promise and its arguments are ignored.
   */
  build(folders: string[], signal?: AbortSignal): Promise<void> {
    if (this.building) return this.building;
    if (this.disposed) return Promise.resolve();

    // dispose() must be able to stop a build whose caller passed no signal.
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    this.abortBuild = abort;

    const wanted = [...folders];
    const run = this.enqueue(() => this.runBuild(wanted, controller.signal)).finally(() => {
      signal?.removeEventListener('abort', abort);
      if (this.building !== run) return;
      this.building = null;
      this.abortBuild = null;
    });
    this.building = run;
    return run;
  }

  /**
   * Re-indexes one file, embedding only its changed chunks. Deferred until
   * resume() while paused. Never rejects: a failure lands in status().error.
   */
  updateFile(path: string): Promise<void> {
    if (this.disposed || !this.usable() || !this.inScope(path)) return Promise.resolve();
    if (this.paused) {
      this.deferred.add(path);
      return Promise.resolve();
    }
    return this.enqueue(() => this.refreshFile(path));
  }

  /** Never rejects. */
  removeFile(path: string): Promise<void> {
    this.deferred.delete(path);
    if (this.disposed || !this.store) return Promise.resolve();
    return this.enqueue(async () => {
      // A note that could not be indexed and is now deleted: there is nothing left to complain about.
      this.overcome(aboutFile(path));
      if (!this.files.has(path)) return;
      this.dropFile(path);
      this.afterChange();
    });
  }

  /**
   * Re-keys the file's chunks without re-embedding. A file moved into the
   * indexed folders is indexed; one moved out is removed. A note whose last
   * change could not be indexed is tried again under its new name.
   */
  renameFile(oldPath: string, newPath: string): Promise<void> {
    if (this.deferred.delete(oldPath) && this.inScope(newPath)) this.deferred.add(newPath);
    if (this.disposed || !this.store) return Promise.resolve();
    return this.enqueue(async () => {
      const store = this.store;
      const entry = this.files.get(oldPath);
      // No note goes by the old name any more: an error about it would name a note nobody can find.
      const complained = oldPath !== newPath && this.errorAbout === aboutFile(oldPath);
      if (complained) this.report({ error: null });
      if (!store || !entry) {
        await this.refreshFile(newPath);
        return;
      }
      if (oldPath === newPath) return;
      if (!this.usable() || !this.inScope(newPath)) {
        this.dropFile(oldPath);
        this.afterChange();
        return;
      }
      if (this.files.has(newPath)) {
        // The note that was there is replaced: so is whatever was wrong with it.
        this.dropFile(newPath);
        this.overcome(aboutFile(newPath));
      }
      const title = titleOf(newPath);
      const chunkIds: string[] = [];
      for (const id of entry.chunkIds) {
        const stored = store.get(id);
        if (!stored) continue;
        store.remove(id);
        const moved: VaultChunk = { ...stored.meta, id: `${newPath}#${chunkIds.length}`, path: newPath, title };
        store.upsert(moved.id, stored.vector, moved);
        chunkIds.push(moved.id);
      }
      this.files.delete(oldPath);
      this.files.set(newPath, { mtime: entry.mtime, chunkIds });
      this.dirty = true;
      this.afterChange();
      // Its last change was never indexed: the chunks that moved are those of the text before it.
      // Tried again under the new name, which is where the error goes if it still fails.
      if (complained) await this.refreshFile(newPath);
    });
  }

  /**
   * Top `k` chunks by score. Rejects when the query cannot be embedded. With `folders`, only
   * notes under one of them count: the index may still hold a folder the user has since removed
   * from the list, until the next build drops it.
   */
  async search(
    query: string,
    k: number,
    opts: { minScore?: number; excludePaths?: string[]; folders?: string[] } = {},
  ): Promise<Array<VaultChunk & { score: number }>> {
    if (!this.usable() || this.store?.size === 0 || !(k > 0) || !query.trim()) return [];
    const model = this.model;
    const vector = await this.deps.embedder.embedQuery(query);
    // Re-read: a build may have replaced the store while the query was embedded.
    const store = this.store;
    if (!store || this.model !== model || vector.length !== store.dim) return [];
    const excluded = new Set(opts.excludePaths ?? []);
    const prefixes = opts.folders?.map(folderPrefix) ?? null;
    const everywhere = prefixes === null || prefixes.includes('');
    const hits = store.search(vector, k, {
      minScore: opts.minScore ?? DEFAULT_MIN_SCORE,
      filter:
        excluded.size > 0 || !everywhere
          ? (_id, meta) =>
              !excluded.has(meta.path) && (everywhere || prefixes.some((prefix) => meta.path.startsWith(prefix)))
          : undefined,
    });
    return hits.map((hit) => ({ ...hit.meta, score: hit.score }));
  }

  /** A running build stops before its next file. Changed files reported meanwhile wait for resume(). */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const waking = this.waking;
    this.waking = [];
    for (const wake of waking) wake();
    const waiting = [...this.deferred];
    this.deferred.clear();
    for (const path of waiting) void this.updateFile(path);
  }

  status(): VaultIndexStatus {
    return { ...this.state, folders: [...this.state.folders] };
  }

  /** Stops a running build, then saves if anything changed since the last save. */
  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.abortBuild?.();
      if (this.saveScheduled) {
        this.deps.clock.clearTimeout(this.saveTimer);
        this.saveScheduled = false;
      }
    }
    await this.enqueue(() => this.saveIfDirty());
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.tail.then(op).catch((error: unknown) => {
      // Operations handle their own failures; this is the net under them.
      this.report({ error: messageOf(error) });
    });
    this.tail = run;
    return run;
  }

  /** True when the in-memory index belongs to the current embedding model and has folders. */
  private usable(): boolean {
    return (
      this.store !== null &&
      this.folders.length > 0 &&
      this.model === this.deps.modelId() &&
      this.store.dim === this.deps.embedder.dim
    );
  }

  private inScope(path: string): boolean {
    if (!/\.md$/i.test(path)) return false;
    // Dot-folders hold configuration and trash, not notes.
    if (/(?:^|\/)\./.test(path)) return false;
    const inFolder = this.folders.some((folder) => {
      const prefix = folderPrefix(folder);
      return prefix === '' || path.startsWith(prefix);
    });
    return inFolder && !this.deps.exclude?.(path);
  }

  /** `about`: what the error in `patch` concerns, when a later success can take it back. */
  private report(patch: Partial<VaultIndexStatus>, about: string | null = null): void {
    if ('error' in patch) this.errorAbout = typeof patch.error === 'string' ? about : null;
    this.state = {
      ...this.state,
      ...patch,
      files: this.files.size,
      chunks: this.store?.size ?? 0,
      folders: [...this.folders],
    };
    try {
      this.deps.onStatus(this.status());
    } catch {
      // A listener that throws must not leave a build half done.
    }
  }

  /**
   * What had failed has now worked, or no longer needs to: the error that said so is taken back.
   * Without this the status would show, until the next full build, an error about a note that was
   * indexed since or a save that went through at the next try.
   */
  private overcome(about: string): void {
    if (this.errorAbout === about) this.report({ error: null });
  }

  private restore(index: string, vectors: Uint8Array): void {
    const parsed = JSON.parse(index) as {
      v?: unknown;
      model?: unknown;
      folders?: unknown;
      files?: unknown;
      store?: unknown;
    } | null;
    if (!parsed || parsed.v !== 1) throw new Error('Corrupt index: unknown format');
    // Vectors from another model or dimension cannot be compared with new ones.
    if (parsed.model !== this.deps.modelId()) throw new Error('The index was built with another model');
    const { folders, files } = parsed;
    if (!Array.isArray(folders) || folders.some((f) => typeof f !== 'string')) {
      throw new Error('Corrupt index: folders');
    }
    if (typeof files !== 'object' || files === null) throw new Error('Corrupt index: files');

    const store = VectorStore.deserialize<VaultChunk>(JSON.stringify(parsed.store), vectors);
    if (store.dim !== this.deps.embedder.dim) throw new Error('The index has another dimension');
    const pathOf = new Map<string, unknown>();
    for (const { id, meta } of store.entries()) {
      if (typeof meta?.text !== 'string') throw new Error('Corrupt index: chunk');
      pathOf.set(id, meta.path);
    }

    const restored = new Map<string, FileEntry>();
    let listed = 0;
    for (const [path, entry] of Object.entries(files as Record<string, Partial<FileEntry> | null>)) {
      if (!entry || typeof entry.mtime !== 'number' || !Array.isArray(entry.chunkIds)) {
        throw new Error('Corrupt index: file entry');
      }
      for (const id of entry.chunkIds) {
        if (pathOf.get(id) !== path) throw new Error('Corrupt index: chunk without its file');
      }
      listed += entry.chunkIds.length;
      restored.set(path, { mtime: entry.mtime, chunkIds: [...entry.chunkIds] });
    }
    if (listed !== store.size) throw new Error('Corrupt index: orphan chunks');
    if (folders.length === 0 && restored.size > 0) throw new Error('Corrupt index: files without folders');

    this.store = store;
    this.files = restored;
    this.folders = folders as string[];
    this.model = parsed.model as string;
  }

  private async runBuild(folders: string[], signal: AbortSignal): Promise<void> {
    if (this.disposed) return;
    const { io, embedder, clock } = this.deps;
    const model = this.deps.modelId();

    if (this.store && (this.model !== model || this.store.dim !== embedder.dim)) {
      this.store = null;
      this.files = new Map();
      this.dirty = true;
    }
    if (folders.length !== this.folders.length || folders.some((f, i) => f !== this.folders[i])) {
      // The folder list is part of the saved index. Without an index there is nothing to update.
      if (this.store) this.dirty = true;
      this.folders = folders;
    }
    this.model = model;

    if (folders.length === 0) {
      for (const path of [...this.files.keys()]) this.dropFile(path);
      this.report({ status: 'none', done: 0, total: 0, error: null });
      await this.saveIfDirty();
      return;
    }

    this.report({ status: 'building', done: 0, total: 0, error: null });
    let listing: Array<{ path: string; mtime: number }>;
    try {
      this.store ??= new VectorStore<VaultChunk>(embedder.dim);
      const byPath = new Map<string, { path: string; mtime: number }>();
      for (const file of await io.listMarkdown(folders)) {
        if (this.inScope(file.path)) byPath.set(file.path, file);
      }
      listing = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    } catch (error) {
      this.report({ status: 'error', error: messageOf(error) });
      return;
    }

    const present = new Set(listing.map((file) => file.path));
    for (const path of [...this.files.keys()]) {
      if (!present.has(path)) this.dropFile(path);
    }

    // The first periodic save comes saveEveryMs into the build, not after its first file.
    this.lastSaveAt = clock.now();
    let done = 0;
    let stopped: 'aborted' | 'failed' | null = null;
    let failure = '';
    this.report({ total: listing.length });

    for (const file of listing) {
      if (!(await this.passGate(signal))) {
        stopped = 'aborted';
        break;
      }
      if (this.files.get(file.path)?.mtime === file.mtime) {
        done += 1;
        continue;
      }
      // The settings can change under a long or paused build. What is left
      // would be embedded by the other model into an index that is not its own.
      if (this.deps.modelId() !== model) {
        stopped = 'failed';
        failure = MODEL_CHANGED;
        break;
      }
      try {
        await this.indexFile(file.path, file.mtime, signal);
        done += 1;
        this.report({ done });
      } catch (error) {
        if (signal.aborted || kindOf(error) === 'aborted') {
          stopped = 'aborted';
          break;
        }
        if (looksGlobal(error) || this.deps.modelId() !== model) {
          stopped = 'failed';
          failure = messageOf(error);
          break;
        }
        // The file keeps its previous chunks and its old mtime, so the next build tries it again.
        done += 1;
        this.report({ done, error: `${file.path}: ${messageOf(error)}` }, aboutFile(file.path));
      }
      if (this.dirty && clock.now() - this.lastSaveAt >= this.saveEveryMs) await this.save();
    }

    await this.saveIfDirty();
    if (stopped === 'failed') this.report({ status: 'error', done, error: failure });
    else if (stopped === 'aborted') this.report({ status: this.files.size > 0 ? 'ready' : 'none', done });
    else this.report({ status: 'ready', done });
  }

  /** Waits out a pause. False when the build should stop. */
  private async passGate(signal: AbortSignal): Promise<boolean> {
    while (this.paused && !signal.aborted) {
      if (this.state.status !== 'paused') this.report({ status: 'paused' });
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal.removeEventListener('abort', wake);
          this.waking = this.waking.filter((w) => w !== wake);
          resolve();
        };
        this.waking.push(wake);
        signal.addEventListener('abort', wake, { once: true });
      });
    }
    if (signal.aborted) return false;
    if (this.state.status === 'paused') this.report({ status: 'building' });
    return true;
  }

  /** Runs inside the queue. */
  private async refreshFile(path: string): Promise<void> {
    if (this.disposed || !this.usable() || !this.inScope(path)) return;
    if (this.paused) {
      this.deferred.add(path);
      return;
    }
    try {
      await this.indexFile(path, MTIME_UNKNOWN);
      this.afterChange();
    } catch (error) {
      this.report({ error: `${path}: ${messageOf(error)}` }, aboutFile(path));
    }
  }

  /**
   * Reads, chunks and embeds one file, then swaps its chunks in. Everything
   * that can fail happens before the store is touched, so an error or an abort
   * leaves the file as it was.
   */
  private async indexFile(path: string, mtime: number, signal?: AbortSignal): Promise<void> {
    const store = this.store;
    if (!store) return;
    const text = await this.deps.io.read(path);
    const title = titleOf(path);
    const chunks: VaultChunk[] = chunkMarkdown(text).map((part, i) => ({
      id: `${path}#${i}`,
      path,
      title,
      heading: part.heading,
      text: part.text,
      hash: shortHash(part.text),
    }));

    const previous = this.files.get(path)?.chunkIds ?? [];
    const known = new Map<string, Float32Array>();
    for (const id of previous) {
      const stored = store.get(id);
      if (stored) known.set(reuseKey(stored.meta), stored.vector);
    }
    const vectors = chunks.map((chunk) => known.get(reuseKey(chunk)) ?? null);
    const fresh = chunks.filter((_chunk, i) => vectors[i] === null);
    if (fresh.length > 0) {
      const embedded = await this.deps.embedder.embedDocuments(
        fresh.map((chunk) => ({ title: embedTitle(chunk), text: chunk.text })),
        signal,
      );
      // The model can be switched while the request is out, and switched
      // back later: its vectors must never land in this index.
      if (this.deps.modelId() !== this.model) throw new Error(MODEL_CHANGED);
      if (embedded.length !== fresh.length) {
        throw new Error(`Embedding count mismatch: expected ${fresh.length}, got ${embedded.length}`);
      }
      // Checked here, not by the store: a throw in the middle of the swap
      // below would leave the file listing chunks that are gone.
      for (const vector of embedded) {
        if (vector.length !== store.dim) {
          throw new Error(`Embedding dimension mismatch: expected ${store.dim}, got ${vector.length}`);
        }
      }
      let next = 0;
      for (let i = 0; i < vectors.length; i++) {
        if (vectors[i] === null) vectors[i] = embedded[next++];
      }
    }

    for (const id of previous) store.remove(id);
    chunks.forEach((chunk, i) => store.upsert(chunk.id, vectors[i] as Float32Array, chunk));
    this.files.set(path, { mtime, chunkIds: chunks.map((chunk) => chunk.id) });
    this.dirty = true;
    this.overcome(aboutFile(path));
  }

  private dropFile(path: string): void {
    const entry = this.files.get(path);
    if (!entry) return;
    for (const id of entry.chunkIds) this.store?.remove(id);
    this.files.delete(path);
    this.dirty = true;
  }

  /** After an incremental change: fresh counts for the UI, and a save before long. */
  private afterChange(): void {
    this.report(this.state.status === 'none' && this.files.size > 0 ? { status: 'ready' } : {});
    if (this.saveScheduled || this.disposed || !this.dirty) return;
    this.saveScheduled = true;
    this.saveTimer = this.deps.clock.setTimeout(() => {
      this.saveScheduled = false;
      void this.enqueue(() => this.saveIfDirty());
    }, this.saveEveryMs);
  }

  private async saveIfDirty(): Promise<void> {
    if (this.dirty) await this.save();
  }

  private async save(): Promise<void> {
    // Cleared first: the snapshot is taken now, and a failure sets it back.
    this.dirty = false;
    try {
      const store = this.store ?? new VectorStore<VaultChunk>(this.deps.embedder.dim);
      const { index, vectors } = store.serialize();
      const head = JSON.stringify({
        v: 1,
        model: this.model,
        folders: this.folders,
        files: Object.fromEntries(this.files),
      });
      // The store's JSON is spliced in as it is: with a few thousand chunks of
      // text it runs to megabytes, and re-encoding it would double every save.
      await this.deps.io.save(`${head.slice(0, -1)},"store":${index}}`, vectors);
      this.lastSaveAt = this.deps.clock.now();
      this.overcome(ABOUT_SAVE);
    } catch (error) {
      this.dirty = true;
      this.report({ error: `Could not save the index: ${messageOf(error)}` }, ABOUT_SAVE);
    }
  }
}
