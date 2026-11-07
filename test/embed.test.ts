import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmbedder, documentPrompt, normalize, queryPrompt } from '../src/rag/embed.ts';
import type { EmbedderOptions } from '../src/rag/embed.ts';
import type { EmbedRequest, EmbedResult, OllamaClient } from '../src/types.ts';
import { estimateTokens } from '../src/util/text.ts';

const DIM = 4;

/** A vector that depends on the prompt, so order mix-ups are visible. Not normalized. */
function rawVector(prompt: string, dim = DIM): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < prompt.length; i++) v[i % dim] += prompt.charCodeAt(i);
  return v;
}

function fakeClient(respond?: (req: EmbedRequest, call: number) => EmbedResult | Promise<EmbedResult>) {
  const requests: EmbedRequest[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const llm: OllamaClient = {
    async chatStream() {
      throw new Error('not used');
    },
    async embed(req, signal) {
      requests.push(req);
      signals.push(signal);
      if (respond) return respond(req, requests.length);
      return { vectors: req.input.map((p) => rawVector(p)), promptTokens: req.input.length * 10 };
    },
    async tags() {
      return [];
    },
    async ps() {
      return [];
    },
    async unload() {},
  };
  return { llm, requests, signals };
}

function options(llm: OllamaClient, extra: Partial<EmbedderOptions> = {}): EmbedderOptions {
  return { llm, model: () => 'embeddinggemma-2:270m', numCtx: () => 2048, dim: () => DIM, ...extra };
}

function length(v: Float32Array): number {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}

function near(actual: number, expected: number, epsilon = 1e-6): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} is not close to ${expected}`);
}

test('queryPrompt and documentPrompt add the EmbeddingGemma prefixes', () => {
  assert.equal(queryPrompt('budget approval'), 'task: search result | query: budget approval');
  assert.equal(documentPrompt('The budget was approved.', 'Steering'), 'title: Steering | text: The budget was approved.');
  assert.equal(documentPrompt('The budget was approved.'), 'title: none | text: The budget was approved.');
  assert.equal(documentPrompt('text', '   '), 'title: none | text: text');
});

test('prompts collapse whitespace', () => {
  assert.equal(queryPrompt('  budget\n\n approval\t now '), 'task: search result | query: budget approval now');
  assert.equal(documentPrompt('- one\n- two\n\n  three', ' Plan \n 2026 '), 'title: Plan 2026 | text: - one - two three');
});

test('long text is cut to about 7,500 tokens at a word boundary', () => {
  const words = Array.from({ length: 12000 }, (_, i) => `mot${i}`);
  const prompt = documentPrompt(words.join(' '), 'Long note');
  const text = prompt.slice('title: Long note | text: '.length);
  assert.ok(estimateTokens(text) <= 7500, 'the text fits the budget');
  assert.ok(estimateTokens(text) > 7400, 'and is not cut much shorter than needed');
  const kept = text.split(' ');
  assert.deepEqual(kept, words.slice(0, kept.length), 'only whole leading words are kept');

  const short = 'a short text';
  assert.equal(documentPrompt(short), `title: none | text: ${short}`);
  assert.ok(estimateTokens(queryPrompt('x'.repeat(60000))) <= 7510);
});

test('normalize scales to unit length in place and leaves a zero vector alone', () => {
  const v = new Float32Array([3, 4]);
  const out = normalize(v);
  assert.equal(out, v);
  near(v[0], 0.6);
  near(v[1], 0.8);

  const zero = new Float32Array(3);
  assert.equal(normalize(zero), zero);
  assert.deepEqual([...zero], [0, 0, 0]);

  const unit = normalize(new Float32Array([0, 1, 0]));
  assert.deepEqual([...unit], [0, 1, 0]);
});

test('embedQuery sends one request and returns a normalized vector', async () => {
  const { llm, requests } = fakeClient();
  const embedder = createEmbedder(options(llm));
  const vector = await embedder.embedQuery('who approves  the budget?');

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    model: 'embeddinggemma-2:270m',
    input: ['task: search result | query: who approves the budget?'],
    numCtx: 2048,
    dimensions: DIM,
    keepAlive: '30m',
  });
  assert.equal(vector.length, DIM);
  near(length(vector), 1);
  assert.equal(embedder.dim, DIM);
});

test('embedDocuments batches in order and returns vectors in input order', async () => {
  const { llm, requests } = fakeClient();
  const embedder = createEmbedder(options(llm, { batchSize: 2 }));
  const docs = [
    { title: 'Alpha', text: 'first passage' },
    { text: 'second passage' },
    { title: 'Gamma', text: 'third passage' },
    { title: 'Delta', text: 'fourth passage' },
    { text: 'fifth passage' },
  ];
  const vectors = await embedder.embedDocuments(docs);

  assert.deepEqual(
    requests.map((r) => r.input),
    [
      ['title: Alpha | text: first passage', 'title: none | text: second passage'],
      ['title: Gamma | text: third passage', 'title: Delta | text: fourth passage'],
      ['title: none | text: fifth passage'],
    ],
  );
  assert.equal(vectors.length, docs.length);
  docs.forEach((doc, i) => {
    const expected = normalize(rawVector(documentPrompt(doc.text, doc.title)));
    assert.deepEqual([...vectors[i]], [...expected], `vector ${i} belongs to document ${i}`);
    near(length(vectors[i]), 1);
  });
});

test('the default batch size is 16 and an empty list sends nothing', async () => {
  const { llm, requests } = fakeClient();
  const embedder = createEmbedder(options(llm));
  const docs = Array.from({ length: 40 }, (_, i) => ({ text: `passage ${i}` }));
  await embedder.embedDocuments(docs);
  assert.deepEqual(
    requests.map((r) => r.input.length),
    [16, 16, 8],
  );

  requests.length = 0;
  assert.deepEqual(await embedder.embedDocuments([]), []);
  assert.equal(requests.length, 0);
});

test('a vector of the wrong length is refused', async () => {
  const { llm } = fakeClient((req) => ({ vectors: req.input.map((p) => rawVector(p, 5)), promptTokens: 1 }));
  const embedder = createEmbedder(options(llm));
  await assert.rejects(embedder.embedQuery('anything'), {
    message: 'Embedding dimension mismatch: expected 4, got 5',
  });
  await assert.rejects(embedder.embedDocuments([{ text: 'one' }]), {
    message: 'Embedding dimension mismatch: expected 4, got 5',
  });
});

test('a missing vector is refused', async () => {
  const { llm } = fakeClient((req) => ({ vectors: req.input.slice(1).map((p) => rawVector(p)), promptTokens: 1 }));
  const embedder = createEmbedder(options(llm));
  await assert.rejects(embedder.embedDocuments([{ text: 'one' }, { text: 'two' }]), /Embedding count mismatch/);
});

test('an abort between batches stops before the next request', async () => {
  const controller = new AbortController();
  const { llm, requests, signals } = fakeClient((req) => {
    controller.abort();
    return { vectors: req.input.map((p) => rawVector(p)), promptTokens: 1 };
  });
  const embedder = createEmbedder(options(llm, { batchSize: 2 }));
  const docs = Array.from({ length: 6 }, (_, i) => ({ text: `passage ${i}` }));

  await assert.rejects(embedder.embedDocuments(docs, controller.signal), (error: unknown) => {
    assert.equal((error as { kind?: string }).kind, 'aborted');
    return true;
  });
  assert.equal(requests.length, 1, 'only the first batch was sent');
  assert.equal(signals[0], controller.signal, 'the signal reaches the client');
});

test('an already aborted signal sends nothing', async () => {
  const controller = new AbortController();
  controller.abort();
  const { llm, requests } = fakeClient();
  const embedder = createEmbedder(options(llm));
  await assert.rejects(embedder.embedDocuments([{ text: 'one' }], controller.signal), { kind: 'aborted' });
  assert.equal(requests.length, 0);
});

test('prompt tokens are reported per request', async () => {
  const spent: number[] = [];
  const { llm } = fakeClient();
  const embedder = createEmbedder(options(llm, { batchSize: 3, onTokens: (n) => spent.push(n) }));
  await embedder.embedDocuments(Array.from({ length: 5 }, (_, i) => ({ text: `passage ${i}` })));
  await embedder.embedQuery('question');
  assert.deepEqual(spent, [30, 20, 10]);
});

test('model, context size, dimension and keep-alive are read at call time', async () => {
  let model = 'embeddinggemma-2:270m';
  let dim = 4;
  const { llm, requests } = fakeClient((req) => ({
    vectors: req.input.map((p) => rawVector(p, req.dimensions)),
    promptTokens: 0,
  }));
  const embedder = createEmbedder({ llm, model: () => model, numCtx: () => 1024, dim: () => dim, keepAlive: -1 });
  await embedder.embedQuery('one');
  model = 'other-embedder';
  dim = 8;
  const vector = await embedder.embedQuery('two');

  assert.equal(requests[0].model, 'embeddinggemma-2:270m');
  assert.equal(requests[0].dimensions, 4);
  assert.equal(requests[0].keepAlive, -1);
  assert.equal(requests[1].model, 'other-embedder');
  assert.equal(requests[1].dimensions, 8);
  assert.equal(requests[1].numCtx, 1024);
  assert.equal(vector.length, 8);
  assert.equal(embedder.dim, 8);
});

test('a client error passes through unchanged', async () => {
  const failure = Object.assign(new Error('Ollama is not running'), { kind: 'unreachable' });
  const { llm } = fakeClient(() => {
    throw failure;
  });
  const embedder = createEmbedder(options(llm));
  await assert.rejects(embedder.embedQuery('anything'), (error: unknown) => error === failure);
});

test('a cut with no word boundary never leaves half of a surrogate pair', () => {
  // 20,001 emoji: the 7,500-token cut lands between the two halves of one.
  const prompt = queryPrompt('😀'.repeat(20001));
  assert.ok(estimateTokens(prompt) <= 7510);
  assert.ok(prompt.endsWith('😀'));
  assert.ok(!/[\uD800-\uDBFF]$/.test(prompt), 'no lone high surrogate at the end');
});

test('a batch size that makes no sense falls back to 16', async () => {
  for (const batchSize of [0, -3, Number.NaN, 0.4]) {
    const { llm, requests } = fakeClient();
    const embedder = createEmbedder(options(llm, { batchSize }));
    const vectors = await embedder.embedDocuments(Array.from({ length: 20 }, (_, i) => ({ text: `passage ${i}` })));
    assert.equal(vectors.length, 20);
    assert.deepEqual(
      requests.map((r) => r.input.length),
      [16, 4],
      `batchSize ${batchSize}`,
    );
  }
});

test('normalize leaves a vector with non-finite values alone', () => {
  const v = new Float32Array([Number.POSITIVE_INFINITY, 1]);
  assert.equal(normalize(v), v);
  assert.deepEqual([...v], [Number.POSITIVE_INFINITY, 1], 'not turned into NaN');
});
