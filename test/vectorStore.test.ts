import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VectorStore } from '../src/rag/vectorStore.ts';

interface Meta {
  label: string;
}

function unit(values: number[]): Float32Array {
  const v = new Float32Array(values);
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm > 0 ? v.map((x) => x / norm) : v;
}

/** A distinct direction per number, in `dim` dimensions. */
function numbered(n: number, dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin((n + 1) * (i + 1)) + (i === n % dim ? 2 : 0);
  return unit([...v]);
}

function near(actual: number, expected: number, epsilon = 1e-6): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} is not close to ${expected}`);
}

test('upsert, has, get and size', () => {
  const store = new VectorStore<Meta>(3);
  assert.equal(store.dim, 3);
  assert.equal(store.size, 0);
  assert.equal(store.get('a'), null);

  const a = unit([1, 2, 2]);
  store.upsert('a', a, { label: 'A' });
  assert.equal(store.size, 1);
  assert.ok(store.has('a'));
  assert.ok(!store.has('b'));
  assert.deepEqual([...(store.get('a')?.vector ?? [])], [...a]);
  assert.deepEqual(store.get('a')?.meta, { label: 'A' });
});

test('the store keeps its own copy of a vector', () => {
  const store = new VectorStore<Meta>(2);
  const v = unit([1, 0]);
  store.upsert('a', v, { label: 'A' });
  v[0] = 99;
  assert.deepEqual([...(store.get('a')?.vector ?? [])], [1, 0]);

  const out = store.get('a');
  assert.ok(out);
  out.vector[1] = 42;
  assert.deepEqual([...(store.get('a')?.vector ?? [])], [1, 0]);
});

test('upsert replaces an existing id in place', () => {
  const store = new VectorStore<Meta>(2);
  store.upsert('a', unit([1, 0]), { label: 'old' });
  store.upsert('b', unit([0, 1]), { label: 'B' });
  store.upsert('a', unit([0, 1]), { label: 'new' });

  assert.equal(store.size, 2);
  assert.deepEqual([...(store.get('a')?.vector ?? [])], [0, 1]);
  assert.deepEqual(store.get('a')?.meta, { label: 'new' });
  assert.deepEqual(
    store.entries().map((e) => e.id),
    ['a', 'b'],
  );
});

test('a vector or a query of the wrong length is refused', () => {
  const store = new VectorStore<Meta>(3);
  assert.throws(() => store.upsert('a', new Float32Array(2), { label: 'A' }), /Vector length mismatch: expected 3, got 2/);
  assert.equal(store.size, 0);
  store.upsert('a', unit([1, 0, 0]), { label: 'A' });
  assert.throws(() => store.search(new Float32Array(4), 1), /Vector length mismatch: expected 3, got 4/);
  // Named, so that an index can tell it from a failure of one chunk: the next vector is as wrong.
  assert.throws(() => store.upsert('b', new Float32Array(2), { label: 'B' }), { kind: 'dimension' });
  assert.throws(() => new VectorStore<Meta>(0), /Invalid vector dimension/);
  assert.throws(() => new VectorStore<Meta>(1.5), /Invalid vector dimension/);
});

test('remove swaps the last row in and keeps every other row right', () => {
  const store = new VectorStore<Meta>(4);
  const ids = ['a', 'b', 'c', 'd', 'e'];
  ids.forEach((id, i) => store.upsert(id, numbered(i, 4), { label: id.toUpperCase() }));

  assert.equal(store.remove('b'), true);
  assert.equal(store.remove('b'), false);
  assert.equal(store.remove('zz'), false);
  assert.equal(store.size, 4);
  assert.equal(store.get('b'), null);
  assert.ok(!store.has('b'));

  for (const [i, id] of ids.entries()) {
    if (id === 'b') continue;
    assert.deepEqual([...(store.get(id)?.vector ?? [])], [...numbered(i, 4)], `vector of ${id}`);
    assert.deepEqual(store.get(id)?.meta, { label: id.toUpperCase() });
    const [best] = store.search(numbered(i, 4), 1);
    assert.equal(best.id, id, `search finds ${id}`);
    near(best.score, 1);
  }

  assert.equal(store.remove('e'), true, 'removing the last row needs no swap');
  assert.equal(store.remove('a'), true);
  assert.deepEqual(
    store.entries().map((e) => e.id),
    ['c', 'd'],
  );
  assert.deepEqual([...(store.get('d')?.vector ?? [])], [...numbered(3, 4)]);

  store.upsert('b', numbered(1, 4), { label: 'B again' });
  assert.equal(store.search(numbered(1, 4), 1)[0].id, 'b');
});

test('removeWhere removes every match and reports the count', () => {
  const store = new VectorStore<Meta>(4);
  for (let i = 0; i < 10; i++) store.upsert(`n${i}`, numbered(i, 4), { label: i % 2 === 0 ? 'even' : 'odd' });

  assert.equal(store.removeWhere((_id, meta) => meta.label === 'even'), 5);
  assert.equal(store.size, 5);
  assert.deepEqual(
    store.entries().map((e) => e.id),
    ['n1', 'n3', 'n5', 'n7', 'n9'],
  );
  for (const i of [1, 3, 5, 7, 9]) {
    assert.deepEqual([...(store.get(`n${i}`)?.vector ?? [])], [...numbered(i, 4)]);
  }
  assert.equal(store.removeWhere((id) => id === 'n9' || id === 'nope'), 1);
  assert.equal(store.removeWhere(() => false), 0);
  assert.equal(store.removeWhere(() => true), 4);
  assert.equal(store.size, 0);
});

test('search returns the best scores first', () => {
  const store = new VectorStore<Meta>(2);
  store.upsert('far', unit([0, 1]), { label: 'far' });
  store.upsert('close', unit([1, 0.1]), { label: 'close' });
  store.upsert('mid', unit([1, 1]), { label: 'mid' });
  store.upsert('opposite', unit([-1, 0]), { label: 'opposite' });

  const hits = store.search(unit([1, 0]), 10);
  assert.deepEqual(
    hits.map((h) => h.id),
    ['close', 'mid', 'far', 'opposite'],
  );
  near(hits[0].score, 1 / Math.sqrt(1.01));
  near(hits[1].score, Math.SQRT1_2);
  near(hits[2].score, 0);
  near(hits[3].score, -1);
  assert.deepEqual(hits[0].meta, { label: 'close' });

  assert.deepEqual(
    store.search(unit([1, 0]), 2).map((h) => h.id),
    ['close', 'mid'],
  );
});

test('search honours minScore, filter and a non-positive k', () => {
  const store = new VectorStore<Meta>(2);
  store.upsert('far', unit([0, 1]), { label: 'x' });
  store.upsert('close', unit([1, 0.1]), { label: 'y' });
  store.upsert('mid', unit([1, 1]), { label: 'x' });

  const query = unit([1, 0]);
  assert.deepEqual(
    store.search(query, 10, { minScore: 0.5 }).map((h) => h.id),
    ['close', 'mid'],
  );
  assert.deepEqual(
    store.search(query, 10, { filter: (_id, meta) => meta.label === 'x' }).map((h) => h.id),
    ['mid', 'far'],
  );
  assert.deepEqual(
    store.search(query, 10, { minScore: 0.5, filter: (id) => id !== 'close' }).map((h) => h.id),
    ['mid'],
  );
  assert.deepEqual(store.search(query, 10, { minScore: 2 }), []);
  assert.deepEqual(store.search(query, 0), []);
  assert.deepEqual(store.search(query, -3), []);
  assert.deepEqual(new VectorStore<Meta>(2).search(query, 5), []);
});

test('equal scores come back in insertion order, also after removals moved rows', () => {
  const store = new VectorStore<Meta>(2);
  const same = unit([1, 1]);
  store.upsert('first-gone', same, { label: '' });
  for (const id of ['t1', 't2', 't3', 't4']) store.upsert(id, same, { label: '' });
  // t4 is swapped into row 0, ahead of t1 in memory.
  store.remove('first-gone');
  store.upsert('t5', same, { label: '' });
  // Replacing keeps the original place.
  store.upsert('t2', same, { label: 'replaced' });

  const order = ['t1', 't2', 't3', 't4', 't5'];
  assert.deepEqual(
    store.search(same, 10).map((h) => h.id),
    order,
  );
  assert.deepEqual(
    store.search(same, 3).map((h) => h.id),
    order.slice(0, 3),
  );
  assert.deepEqual(
    store.entries().map((e) => e.id),
    order,
  );
});

test('the store grows past its initial capacity', () => {
  const dim = 16;
  const store = new VectorStore<Meta>(dim);
  const count = 500;
  for (let i = 0; i < count; i++) store.upsert(`n${i}`, numbered(i, dim), { label: `L${i}` });
  assert.equal(store.size, count);

  for (const i of [0, 1, 31, 32, 33, 63, 64, 65, 255, 256, 499]) {
    assert.deepEqual([...(store.get(`n${i}`)?.vector ?? [])], [...numbered(i, dim)], `row ${i} survived growth`);
    assert.deepEqual(store.get(`n${i}`)?.meta, { label: `L${i}` });
  }
  const [best] = store.search(numbered(321, dim), 1);
  assert.equal(best.id, 'n321');
  near(best.score, 1, 1e-5);
});

test('serialize writes the documented format', () => {
  const store = new VectorStore<Meta>(2);
  store.upsert('a', unit([1, 0]), { label: 'A' });
  store.upsert('b', unit([0, 1]), { label: 'B' });
  const { index, vectors } = store.serialize();

  assert.deepEqual(JSON.parse(index), { v: 1, dim: 2, ids: ['a', 'b'], metas: [{ label: 'A' }, { label: 'B' }] });
  assert.equal(vectors.byteLength, 2 * 2 * 4);
  const view = new DataView(vectors.buffer, vectors.byteOffset, vectors.byteLength);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => view.getFloat32(i * 4, true)),
    [1, 0, 0, 1],
  );

  // A copy: later changes to the store do not reach bytes already handed out.
  store.upsert('a', unit([0, 1]), { label: 'changed' });
  store.upsert('c', unit([1, 1]), { label: 'C' });
  assert.equal(view.getFloat32(0, true), 1);
  assert.equal(vectors.byteLength, 16);

  const empty = new VectorStore<Meta>(8).serialize();
  assert.equal(empty.vectors.byteLength, 0);
  assert.deepEqual(JSON.parse(empty.index), { v: 1, dim: 8, ids: [], metas: [] });
});

test('serialize and deserialize round trip', () => {
  const dim = 8;
  const store = new VectorStore<Meta>(dim);
  for (let i = 0; i < 70; i++) store.upsert(`n${i}`, numbered(i, dim), { label: `L${i}` });
  store.remove('n3');
  store.remove('n40');

  const { index, vectors } = store.serialize();
  assert.equal(vectors.byteLength, 68 * dim * 4);
  const copy = VectorStore.deserialize<Meta>(index, vectors);

  assert.equal(copy.dim, dim);
  assert.equal(copy.size, 68);
  assert.deepEqual(copy.entries(), store.entries());
  for (const { id } of store.entries()) {
    assert.deepEqual([...(copy.get(id)?.vector ?? [])], [...(store.get(id)?.vector ?? [])]);
  }
  const query = numbered(17, dim);
  assert.deepEqual(copy.search(query, 5), store.search(query, 5));

  // The copy is a working store, not a frozen snapshot.
  copy.upsert('extra', numbered(200, dim), { label: 'extra' });
  copy.remove('n0');
  assert.equal(copy.size, 68);
  assert.equal(copy.search(numbered(200, dim), 1)[0].id, 'extra');
  assert.equal(store.size, 68);
  assert.ok(store.has('n0'));
});

test('deserialize accepts bytes that do not start on a 4-byte boundary', () => {
  const dim = 3;
  const store = new VectorStore<Meta>(dim);
  for (let i = 0; i < 5; i++) store.upsert(`n${i}`, numbered(i, dim), { label: `L${i}` });
  const { index, vectors } = store.serialize();

  for (const offset of [1, 2, 3, 5]) {
    const padded = new Uint8Array(vectors.byteLength + offset + 7);
    padded.set(vectors, offset);
    const unaligned = padded.subarray(offset, offset + vectors.byteLength);
    assert.equal(unaligned.byteOffset % 4 !== 0, true);

    const copy = VectorStore.deserialize<Meta>(index, unaligned);
    for (let i = 0; i < 5; i++) {
      assert.deepEqual([...(copy.get(`n${i}`)?.vector ?? [])], [...numbered(i, dim)], `offset ${offset}, row ${i}`);
    }
  }
});

test('deserialize refuses a corrupt payload', () => {
  const store = new VectorStore<Meta>(2);
  store.upsert('a', unit([1, 0]), { label: 'A' });
  store.upsert('b', unit([0, 1]), { label: 'B' });
  const { index, vectors } = store.serialize();
  const good = JSON.parse(index) as { v: number; dim: number; ids: string[]; metas: Meta[] };
  const json = (patch: Record<string, unknown>): string => JSON.stringify({ ...good, ...patch });
  const corrupt = { message: /^Corrupt index: / };

  assert.throws(() => VectorStore.deserialize<Meta>('{not json', vectors), corrupt);
  assert.throws(() => VectorStore.deserialize<Meta>('null', vectors), corrupt);
  assert.throws(() => VectorStore.deserialize<Meta>('[]', vectors), corrupt);
  assert.throws(() => VectorStore.deserialize<Meta>(json({ v: 2 }), vectors), corrupt);
  assert.throws(() => VectorStore.deserialize<Meta>(json({ dim: 0 }), vectors), corrupt);
  assert.throws(() => VectorStore.deserialize<Meta>(json({ dim: '2' }), vectors), corrupt);
  assert.throws(() => VectorStore.deserialize<Meta>(json({ dim: 3 }), vectors), corrupt);
  assert.throws(() => VectorStore.deserialize<Meta>(json({ ids: ['a'] }), vectors), corrupt);
  assert.throws(() => VectorStore.deserialize<Meta>(json({ ids: 'ab' }), vectors), corrupt);
  assert.throws(() => VectorStore.deserialize<Meta>(json({ metas: undefined }), vectors), corrupt);
  assert.throws(() => VectorStore.deserialize<Meta>(json({ ids: ['a', 'a'] }), vectors), corrupt);
  assert.throws(() => VectorStore.deserialize<Meta>(json({ ids: ['a', 7] }), vectors), corrupt);
  assert.throws(() => VectorStore.deserialize<Meta>(index, vectors.subarray(0, 15)), corrupt);
  assert.throws(() => VectorStore.deserialize<Meta>(index, new Uint8Array(20)), corrupt);
  assert.throws(() => VectorStore.deserialize<Meta>(index, new Uint8Array(0)), corrupt);

  assert.equal(VectorStore.deserialize<Meta>(index, vectors).size, 2);
});

test('a score equal to minScore is kept', () => {
  const store = new VectorStore<Meta>(2);
  store.upsert('exact', new Float32Array([0.5, 0]), { label: '' });
  store.upsert('below', new Float32Array([0.25, 0]), { label: '' });
  const hits = store.search(new Float32Array([1, 0]), 5, { minScore: 0.5 });
  assert.deepEqual(
    hits.map((h) => [h.id, h.score]),
    [['exact', 0.5]],
  );
});

test('deserialize reports a dimension it cannot allocate as corruption', () => {
  const index = JSON.stringify({ v: 1, dim: 2 ** 40, ids: [], metas: [] });
  assert.throws(() => VectorStore.deserialize<Meta>(index, new Uint8Array(0)), { message: /^Corrupt index: / });
});

test('a row whose score is not a number is never a hit', () => {
  const store = new VectorStore<Meta>(2);
  store.upsert('broken', new Float32Array([Number.NaN, 0]), { label: '' });
  store.upsert('fine', new Float32Array([1, 0]), { label: '' });
  assert.deepEqual(
    store.search(new Float32Array([1, 0]), 5).map((h) => h.id),
    ['fine'],
  );
  assert.deepEqual(
    store.search(new Float32Array([1, 0]), 5, { minScore: -1 }).map((h) => h.id),
    ['fine'],
  );
});
