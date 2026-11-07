/* A flat store of normalized vectors with brute-force search. A few thousand
   chunks of 768 floats scan in milliseconds, so there is no ANN structure. */

const INITIAL_ROWS = 32;
const BYTES_PER_FLOAT = 4;

function corrupt(reason: string): Error {
  return new Error(`Corrupt index: ${reason}`);
}

export class VectorStore<M> {
  readonly dim: number;
  private data: Float32Array;
  private ids: string[] = [];
  private metas: M[] = [];
  // Rows move on swap-remove, so insertion order is tracked separately: it
  // breaks score ties and fixes the order of entries() and serialize().
  private seqs: number[] = [];
  private nextSeq = 0;
  private rowOf = new Map<string, number>();

  constructor(dim: number) {
    if (!Number.isInteger(dim) || dim <= 0) throw new Error(`Invalid vector dimension: ${dim}`);
    this.dim = dim;
    this.data = new Float32Array(INITIAL_ROWS * dim);
  }

  get size(): number {
    return this.ids.length;
  }

  has(id: string): boolean {
    return this.rowOf.has(id);
  }

  /** The vector is a copy: rows move when the store grows or shrinks. */
  get(id: string): { vector: Float32Array; meta: M } | null {
    const row = this.rowOf.get(id);
    if (row === undefined) return null;
    return { vector: this.data.slice(row * this.dim, (row + 1) * this.dim), meta: this.metas[row] };
  }

  /** Adds or replaces. A replaced id keeps its place in the insertion order. */
  upsert(id: string, vector: Float32Array, meta: M): void {
    this.checkLength(vector);
    let row = this.rowOf.get(id);
    if (row === undefined) {
      row = this.ids.length;
      this.reserve(row + 1);
      this.ids.push(id);
      this.metas.push(meta);
      this.seqs.push(this.nextSeq++);
      this.rowOf.set(id, row);
    } else {
      this.metas[row] = meta;
    }
    this.data.set(vector, row * this.dim);
  }

  remove(id: string): boolean {
    const row = this.rowOf.get(id);
    if (row === undefined) return false;
    this.removeRow(row);
    return true;
  }

  removeWhere(pred: (id: string, meta: M) => boolean): number {
    let removed = 0;
    // Backwards: the row swapped into a freed slot comes from the end and was already tested.
    for (let row = this.ids.length - 1; row >= 0; row--) {
      if (!pred(this.ids[row], this.metas[row])) continue;
      this.removeRow(row);
      removed += 1;
    }
    return removed;
  }

  /** Dot product against every row (inputs are normalized, so this is cosine). */
  search(
    query: Float32Array,
    k: number,
    opts: { minScore?: number; filter?: (id: string, meta: M) => boolean } = {},
  ): Array<{ id: string; score: number; meta: M }> {
    const count = this.ids.length;
    if (!(k > 0) || count === 0) return [];
    this.checkLength(query);
    const { minScore, filter } = opts;
    const { dim, data, ids, metas, seqs } = this;
    const hits: Array<{ row: number; score: number }> = [];
    for (let row = 0; row < count; row++) {
      if (filter && !filter(ids[row], metas[row])) continue;
      const base = row * dim;
      let score = 0;
      for (let i = 0; i < dim; i++) score += query[i] * data[base + i];
      if (Number.isNaN(score)) continue;
      if (minScore !== undefined && score < minScore) continue;
      hits.push({ row, score });
    }
    hits.sort((a, b) => b.score - a.score || seqs[a.row] - seqs[b.row]);
    return hits.slice(0, k).map((hit) => ({ id: ids[hit.row], score: hit.score, meta: metas[hit.row] }));
  }

  /** In insertion order. */
  entries(): Array<{ id: string; meta: M }> {
    return this.order().map((row) => ({ id: this.ids[row], meta: this.metas[row] }));
  }

  /**
   * `index` is JSON `{ v: 1, dim, ids, metas }`; `vectors` holds exactly
   * `size * dim` little-endian floats in the same order as `ids`.
   * Every platform Obsidian runs on is little-endian, so the bytes are copied as they are.
   */
  serialize(): { index: string; vectors: Uint8Array } {
    const { dim } = this;
    const order = this.order();
    const floats = new Float32Array(order.length * dim);
    order.forEach((row, i) => floats.set(this.data.subarray(row * dim, (row + 1) * dim), i * dim));
    const index = JSON.stringify({
      v: 1,
      dim,
      ids: order.map((row) => this.ids[row]),
      metas: order.map((row) => this.metas[row]),
    });
    return { index, vectors: new Uint8Array(floats.buffer) };
  }

  static deserialize<M>(index: string, vectors: Uint8Array): VectorStore<M> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(index);
    } catch {
      throw corrupt('the index is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null) throw corrupt('the index is not an object');
    const { v, dim, ids, metas } = parsed as { v?: unknown; dim?: unknown; ids?: unknown; metas?: unknown };
    if (v !== 1) throw corrupt(`unknown format version ${String(v)}`);
    if (typeof dim !== 'number' || !Number.isInteger(dim) || dim <= 0) throw corrupt('invalid dimension');
    if (!Array.isArray(ids) || !Array.isArray(metas)) throw corrupt('ids or metas missing');
    if (ids.length !== metas.length) {
      throw corrupt(`${ids.length} ids for ${metas.length} metas`);
    }
    const expected = ids.length * dim * BYTES_PER_FLOAT;
    if (vectors.byteLength !== expected) {
      throw corrupt(`expected ${expected} bytes of vectors, got ${vectors.byteLength}`);
    }

    let store: VectorStore<M>;
    let floats: Float32Array;
    try {
      store = new VectorStore<M>(dim);
      floats = new Float32Array(Math.max(ids.length, INITIAL_ROWS) * dim);
    } catch {
      // A dimension too large to allocate is damage too, not a RangeError for the caller.
      throw corrupt('invalid dimension');
    }
    // Copied byte by byte into a fresh buffer: a Uint8Array read from disk can
    // start at any offset, and a Float32Array view needs a multiple of 4.
    new Uint8Array(floats.buffer).set(vectors);
    store.data = floats;
    for (let row = 0; row < ids.length; row++) {
      const id: unknown = ids[row];
      if (typeof id !== 'string') throw corrupt('an id is not a string');
      if (store.rowOf.has(id)) throw corrupt(`duplicate id ${id}`);
      store.rowOf.set(id, row);
      store.ids.push(id);
      store.metas.push(metas[row] as M);
      store.seqs.push(store.nextSeq++);
    }
    return store;
  }

  private checkLength(vector: Float32Array): void {
    if (vector.length !== this.dim) {
      // The embedder's dimension changed under the store: nothing it returns from now on fits.
      throw Object.assign(new Error(`Vector length mismatch: expected ${this.dim}, got ${vector.length}`), {
        kind: 'dimension' as const,
      });
    }
  }

  private reserve(rows: number): void {
    const capacity = this.data.length / this.dim;
    if (rows <= capacity) return;
    const grown = new Float32Array(Math.max(rows, capacity * 2) * this.dim);
    grown.set(this.data.subarray(0, this.ids.length * this.dim));
    this.data = grown;
  }

  private removeRow(row: number): void {
    const { dim } = this;
    const last = this.ids.length - 1;
    this.rowOf.delete(this.ids[row]);
    if (row !== last) {
      this.data.copyWithin(row * dim, last * dim, (last + 1) * dim);
      this.ids[row] = this.ids[last];
      this.metas[row] = this.metas[last];
      this.seqs[row] = this.seqs[last];
      this.rowOf.set(this.ids[row], row);
    }
    this.ids.pop();
    this.metas.pop();
    this.seqs.pop();
  }

  private order(): number[] {
    const rows = this.ids.map((_, row) => row);
    return rows.sort((a, b) => this.seqs[a] - this.seqs[b]);
  }
}
