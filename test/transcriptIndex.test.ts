import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize } from '../src/rag/embed.ts';
import { TranscriptIndex } from '../src/rag/transcriptIndex.ts';
import type { Embedder, SttSource, Turn } from '../src/types.ts';
import { hash53 } from '../src/util/hash.ts';

/** Hashed bag of words: texts that share words score higher. */
function vectorOf(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) v[hash53(word) % dim] += 1;
  return normalize(v);
}

function fakeEmbedder(dim = 256) {
  const documents: Array<{ title?: string; text: string }> = [];
  const queries: string[] = [];
  const failures: unknown[] = [];
  let hold: Promise<void> | null = null;
  let inFlight = 0;
  let maxInFlight = 0;

  const embedder: Embedder = {
    dim,
    async embedQuery(text) {
      queries.push(text);
      return vectorOf(text, dim);
    },
    async embedDocuments(docs) {
      documents.push(...docs);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await (hold ?? Promise.resolve());
        if (failures.length > 0) throw failures.shift();
        return docs.map((d) => vectorOf(d.text, dim));
      } finally {
        inFlight -= 1;
      }
    },
  };

  return {
    embedder,
    documents,
    queries,
    /** The next document request fails with this. */
    failNext(error: unknown = new Error('embedding failed')): void {
      failures.push(error);
    },
    /** Document requests wait until the returned function is called. */
    block(): () => void {
      let release: () => void = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        hold = null;
        release();
      };
    },
    maxInFlight: () => maxInFlight,
  };
}

let turnCounter = 0;
function turn(t0: number, t1: number, text: string, source: SttSource = 'mic'): Turn {
  turnCounter += 1;
  return { id: `t${turnCounter}`, source, t0, t1, text };
}

/** Lets queued promise work run without calling flush(). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

const BUDGET = 'The steering committee approved the budget for the data platform this quarter.';
const HIRING = 'We still need to hire a second analyst before the reporting season starts.';
const MIGRATION = 'Le calendrier de migration des serveurs glisse de deux semaines en novembre.';

/** Three closed chunks, one per topic, 40 seconds each. */
function threeTopics(index: TranscriptIndex): void {
  index.addTurn(turn(0, 40, BUDGET));
  index.addTurn(turn(65, 105, HIRING, 'system'));
  index.addTurn(turn(3700, 3740, MIGRATION));
}

test('a chunk closes once it spans chunkSeconds', async () => {
  const fake = fakeEmbedder();
  const index = new TranscriptIndex({ embedder: fake.embedder });

  const a = turn(0, 9.5, 'First we look at the numbers.');
  const b = turn(10, 19, '  Then at the schedule.  ');
  const c = turn(20, 31, 'And finally at the risks.');
  index.addTurn(a);
  index.addTurn(b);
  assert.deepEqual(index.chunks(), [], 'still open after 19 seconds');
  index.addTurn(c);

  assert.deepEqual(index.chunks(), [
    {
      id: 'E1',
      t0: 0,
      t1: 31,
      text: 'First we look at the numbers. Then at the schedule. And finally at the risks.',
      turnIds: [a.id, b.id, c.id],
    },
  ]);

  index.addTurn(turn(31, 40, 'A new chunk starts here.'));
  assert.equal(index.chunks().length, 1, 'the next turn opens a new chunk');
  await index.flush();
  assert.equal(index.chunks().length, 2);
});

test('exactly chunkSeconds closes, and the setting is honoured', () => {
  const index = new TranscriptIndex({ embedder: fakeEmbedder().embedder, chunkSeconds: 10 });
  index.addTurn(turn(100, 104, 'Short remark.'));
  assert.equal(index.chunks().length, 0);
  index.addTurn(turn(104, 110, 'Another remark.'));
  assert.equal(index.chunks().length, 1);
  assert.equal(index.chunks()[0].t0, 100);
  assert.equal(index.chunks()[0].t1, 110);
});

test('a chunk closes once it reaches maxChunkChars', () => {
  const index = new TranscriptIndex({ embedder: fakeEmbedder().embedder, maxChunkChars: 60 });
  const text = 'Twenty-five characters ok';
  index.addTurn(turn(0, 1, text));
  index.addTurn(turn(1, 2, text));
  assert.equal(index.chunks().length, 0, '49 characters so far');
  index.addTurn(turn(2, 3, text));
  assert.equal(index.chunks().length, 1);
  assert.equal(index.chunks()[0].text, `${text} ${text} ${text}`);

  index.addTurn(turn(3, 4, 'x'.repeat(200)));
  assert.equal(index.chunks().length, 2, 'one long turn is a chunk of its own');
});

test('ids count up from E1 and flush closes the open chunk', async () => {
  const fake = fakeEmbedder();
  const index = new TranscriptIndex({ embedder: fake.embedder });
  threeTopics(index);
  index.addTurn(turn(3745, 3750, 'A last short remark before the end.'));
  assert.deepEqual(
    index.chunks().map((c) => c.id),
    ['E1', 'E2', 'E3'],
  );

  await index.flush();
  assert.deepEqual(
    index.chunks().map((c) => c.id),
    ['E1', 'E2', 'E3', 'E4'],
  );
  assert.equal(index.chunks()[3].text, 'A last short remark before the end.');
  await index.flush();
  assert.equal(index.chunks().length, 4, 'flushing twice adds nothing');
});

test('blank turns are ignored and out-of-order turns still give the right span', async () => {
  const index = new TranscriptIndex({ embedder: fakeEmbedder().embedder });
  index.addTurn(turn(5, 6, '   '));
  index.addTurn(turn(12, 20, 'The microphone turn arrives first.', 'mic'));
  index.addTurn(turn(10, 18, 'The system turn started earlier.', 'system'));
  await index.flush();
  const [chunk] = index.chunks();
  assert.equal(index.chunks().length, 1);
  assert.equal(chunk.t0, 10);
  assert.equal(chunk.t1, 20);
  assert.equal(chunk.turnIds.length, 2);
});

test('chunks are embedded as untitled documents, one at a time, in order', async () => {
  const fake = fakeEmbedder();
  const release = fake.block();
  const index = new TranscriptIndex({ embedder: fake.embedder });
  threeTopics(index);
  await settle();
  assert.equal(fake.documents.length, 1, 'the second request waits for the first');

  release();
  await index.flush();
  assert.deepEqual(fake.documents, [{ text: BUDGET }, { text: HIRING }, { text: MIGRATION }]);
  assert.equal(fake.maxInFlight(), 1);
});

test('search ranks chunks by similarity and formats the time', async () => {
  const fake = fakeEmbedder();
  const index = new TranscriptIndex({ embedder: fake.embedder });
  threeTopics(index);
  await index.flush();

  const hits = await index.search('who approved the budget for the data platform', 3, 0);
  assert.equal(hits[0].id, 'E1');
  assert.equal(hits[0].text, BUDGET);
  assert.equal(hits[0].time, '00:00');
  assert.ok(hits[0].score > 0.5);
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score, 'best first');

  const hiring = await index.search('hire a second analyst', 1, 0);
  assert.deepEqual(
    hiring.map((h) => [h.id, h.time]),
    [['E2', '01:05']],
  );
  const french = await index.search('calendrier de migration des serveurs', 5, 0.4);
  assert.deepEqual(
    french.map((h) => [h.id, h.time]),
    [['E3', '1:01:40']],
  );
  assert.deepEqual(fake.queries.length, 3);
});

test('search drops chunks below minScore', async () => {
  const fake = fakeEmbedder();
  const index = new TranscriptIndex({ embedder: fake.embedder });
  threeTopics(index);
  await index.flush();

  const all = await index.search('budget', 10, -1);
  assert.equal(all.length, 3);
  const strict = await index.search('budget', 10, 0.2);
  assert.deepEqual(
    strict.map((h) => h.id),
    ['E1'],
  );
  assert.deepEqual(await index.search('budget', 10, 0.99), []);
  assert.deepEqual(await index.search('zebra umbrella', 10, 0.2), []);
});

test('a search with nothing searchable does not call the embedder', async () => {
  const fake = fakeEmbedder();
  const index = new TranscriptIndex({ embedder: fake.embedder });
  assert.deepEqual(await index.search('budget', 3, 0), []);

  index.addTurn(turn(0, 5, 'An open chunk is not searchable yet.'));
  assert.deepEqual(await index.search('open chunk', 3, 0), []);
  assert.equal(fake.queries.length, 0);

  await index.flush();
  assert.deepEqual(await index.search('   ', 3, 0), []);
  assert.deepEqual(await index.search('open chunk', 0, 0), []);
  assert.equal(fake.queries.length, 0);
  assert.equal((await index.search('open chunk', 3, 0)).length, 1);
  assert.equal(fake.queries.length, 1);
});

test('onAdvance fires each time a chunk becomes searchable', async () => {
  const fake = fakeEmbedder();
  let advanced = 0;
  const index = new TranscriptIndex({ embedder: fake.embedder, onAdvance: () => (advanced += 1) });
  index.addTurn(turn(0, 40, BUDGET));
  assert.equal(advanced, 0, 'not before the embedding lands');
  await settle();
  assert.equal(advanced, 1);
  index.addTurn(turn(40, 80, HIRING));
  index.addTurn(turn(80, 90, MIGRATION));
  await index.flush();
  assert.equal(advanced, 3);
});

test('a failed embedding leaves the chunk unsearchable until flush retries it', async () => {
  const fake = fakeEmbedder();
  const errors: unknown[] = [];
  let advanced = 0;
  const index = new TranscriptIndex({
    embedder: fake.embedder,
    onError: (e) => errors.push(e),
    onAdvance: () => (advanced += 1),
  });
  const failure = new Error('500 from the embedder');
  fake.failNext(failure);
  index.addTurn(turn(0, 40, BUDGET));
  await settle();

  assert.deepEqual(errors, [failure], 'told once');
  assert.equal(advanced, 0);
  assert.equal(index.chunks().length, 1, 'the chunk still exists');
  assert.deepEqual(await index.search('budget', 3, 0), []);
  assert.equal(fake.queries.length, 0);
  await settle();
  assert.equal(fake.documents.length, 1, 'no retry on its own');

  await index.flush();
  assert.equal(fake.documents.length, 2, 'retried once by flush');
  assert.equal(errors.length, 1);
  assert.equal(advanced, 1);
  assert.equal((await index.search('budget', 3, 0))[0].id, 'E1');
});

test('flush retries a failed chunk once, not until it works', async () => {
  const fake = fakeEmbedder();
  const errors: unknown[] = [];
  const index = new TranscriptIndex({ embedder: fake.embedder, onError: (e) => errors.push(e) });
  fake.failNext();
  fake.failNext();
  index.addTurn(turn(0, 40, BUDGET));
  await settle();
  await index.flush();
  assert.equal(fake.documents.length, 2);
  assert.equal(errors.length, 2, 'once per failure');
  assert.deepEqual(await index.search('budget', 3, 0), []);

  await index.flush();
  assert.equal(fake.documents.length, 3);
  assert.equal((await index.search('budget', 3, 0)).length, 1);
});

test('a failed chunk is retried when the next chunk closes, in order', async () => {
  const fake = fakeEmbedder();
  const index = new TranscriptIndex({ embedder: fake.embedder, onError: () => {} });
  fake.failNext();
  index.addTurn(turn(0, 40, BUDGET));
  await settle();
  index.addTurn(turn(40, 80, HIRING));
  await settle();

  assert.deepEqual(
    fake.documents.map((d) => d.text),
    [BUDGET, BUDGET, HIRING],
  );
  const hits = await index.search('budget analyst', 5, -1);
  assert.deepEqual(hits.map((h) => h.id).sort(), ['E1', 'E2']);
});

test('one bad chunk does not block the ones behind it', async () => {
  const fake = fakeEmbedder();
  const release = fake.block();
  const errors: unknown[] = [];
  const index = new TranscriptIndex({ embedder: fake.embedder, onError: (e) => errors.push(e) });
  fake.failNext(new Error('this text upsets the model'));
  threeTopics(index);
  release();
  await settle();

  assert.equal(errors.length, 1);
  assert.equal(fake.documents.length, 3);
  const hits = await index.search('budget analyst migration', 5, -1);
  assert.deepEqual(hits.map((h) => h.id).sort(), ['E2', 'E3']);
});

test('when Ollama is unreachable the rest of the queue waits instead of failing one by one', async () => {
  const fake = fakeEmbedder();
  const release = fake.block();
  const errors: unknown[] = [];
  const index = new TranscriptIndex({ embedder: fake.embedder, onError: (e) => errors.push(e) });
  const down = Object.assign(new Error('Ollama is not running'), { kind: 'unreachable' });
  fake.failNext(down);
  threeTopics(index);
  release();
  await settle();

  assert.deepEqual(errors, [down]);
  assert.equal(fake.documents.length, 1, 'E2 and E3 were not attempted');
  assert.deepEqual(await index.search('budget', 5, -1), []);

  await index.flush();
  assert.deepEqual(
    fake.documents.map((d) => d.text),
    [BUDGET, BUDGET, HIRING, MIGRATION],
  );
  assert.equal((await index.search('budget analyst migration', 5, -1)).length, 3);
  assert.equal(errors.length, 1);
});

test('reset discards results that arrive later', async () => {
  const fake = fakeEmbedder();
  const release = fake.block();
  let advanced = 0;
  const errors: unknown[] = [];
  const index = new TranscriptIndex({
    embedder: fake.embedder,
    onAdvance: () => (advanced += 1),
    onError: (e) => errors.push(e),
  });
  index.addTurn(turn(0, 40, BUDGET));
  index.addTurn(turn(40, 80, HIRING));
  await settle();
  assert.equal(fake.documents.length, 1, 'E1 is in flight');

  index.reset();
  assert.deepEqual(index.chunks(), []);
  release();
  await settle();

  assert.equal(advanced, 0, 'the late result was dropped');
  assert.equal(fake.documents.length, 1, 'the queued chunk of the old meeting was never sent');
  assert.deepEqual(await index.search('budget', 3, -1), []);
  assert.equal(fake.queries.length, 0);
  assert.deepEqual(errors, []);

  index.addTurn(turn(0, 40, MIGRATION));
  await index.flush();
  assert.deepEqual(
    index.chunks().map((c) => [c.id, c.text]),
    [['E1', MIGRATION]],
  );
  const hits = await index.search('budget migration', 5, -1);
  assert.deepEqual(
    hits.map((h) => h.text),
    [MIGRATION],
  );
});

test('reset during a failing request does not report the old failure', async () => {
  const fake = fakeEmbedder();
  const release = fake.block();
  const errors: unknown[] = [];
  const index = new TranscriptIndex({ embedder: fake.embedder, onError: (e) => errors.push(e) });
  fake.failNext();
  index.addTurn(turn(0, 40, BUDGET));
  await settle();
  index.reset();
  release();
  await settle();
  await index.flush();
  assert.deepEqual(errors, []);
  assert.equal(fake.documents.length, 1, 'nothing of the old meeting is retried');
});

test('a search that was waiting when reset happened returns nothing', async () => {
  const fake = fakeEmbedder();
  const index = new TranscriptIndex({ embedder: fake.embedder });
  index.addTurn(turn(0, 40, BUDGET));
  await index.flush();
  const pending = index.search('budget', 3, -1);
  index.reset();
  assert.deepEqual(await pending, []);
});

test('addTurn does not throw when the embedder throws synchronously', async () => {
  const errors: unknown[] = [];
  const boom = new Error('thrown before any promise');
  const embedder: Embedder = {
    dim: 8,
    embedQuery() {
      throw boom;
    },
    embedDocuments() {
      throw boom;
    },
  };
  const index = new TranscriptIndex({ embedder, onError: (e) => errors.push(e) });
  assert.doesNotThrow(() => index.addTurn(turn(0, 40, BUDGET)));
  assert.doesNotThrow(() => index.addTurn({ id: 'bad', source: 'mic', t0: 41, t1: 42 } as unknown as Turn));
  await index.flush();
  assert.equal(index.chunks().length, 1);
  assert.ok(errors.length >= 1);
  assert.equal(errors[0], boom);
});

test('a listener that throws does not stall the queue', async () => {
  const fake = fakeEmbedder();
  const index = new TranscriptIndex({
    embedder: fake.embedder,
    onAdvance: () => {
      throw new Error('listener bug');
    },
    onError: () => {
      throw new Error('listener bug');
    },
  });
  fake.failNext();
  threeTopics(index);
  await index.flush();
  assert.equal((await index.search('budget analyst migration', 5, -1)).length, 3);
});

test('a search error reaches the caller', async () => {
  const fake = fakeEmbedder();
  const index = new TranscriptIndex({ embedder: fake.embedder });
  index.addTurn(turn(0, 40, BUDGET));
  await index.flush();
  const down = Object.assign(new Error('Ollama is not running'), { kind: 'unreachable' });
  fake.embedder.embedQuery = async () => {
    throw down;
  };
  await assert.rejects(index.search('budget', 3, 0), (error: unknown) => error === down);
});

test('the search signal is passed to the embedder', async () => {
  const fake = fakeEmbedder();
  const index = new TranscriptIndex({ embedder: fake.embedder });
  index.addTurn(turn(0, 40, BUDGET));
  await index.flush();
  const seen: Array<AbortSignal | undefined> = [];
  const original = fake.embedder.embedQuery.bind(fake.embedder);
  fake.embedder.embedQuery = (text, signal) => {
    seen.push(signal);
    return original(text, signal);
  };
  const controller = new AbortController();
  await index.search('budget', 3, 0, controller.signal);
  assert.deepEqual(seen, [controller.signal]);
});

test('exactly maxChunkChars closes the chunk', () => {
  const index = new TranscriptIndex({ embedder: fakeEmbedder().embedder, maxChunkChars: 21 });
  index.addTurn(turn(0, 1, 'ten chars!'));
  assert.equal(index.chunks().length, 0);
  index.addTurn(turn(1, 2, 'ten chars?'));
  assert.equal(index.chunks().length, 1, 'ten, a space and ten');
  assert.equal(index.chunks()[0].text.length, 21);
});

test('a search from before a reset does not answer from the next meeting', async () => {
  const fake = fakeEmbedder();
  const index = new TranscriptIndex({ embedder: fake.embedder });
  index.addTurn(turn(0, 40, BUDGET));
  await index.flush();

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const embedQuery = fake.embedder.embedQuery.bind(fake.embedder);
  fake.embedder.embedQuery = async (text, signal) => {
    await gate;
    return embedQuery(text, signal);
  };
  const pending = index.search('budget analyst', 3, -1);
  index.reset();
  index.addTurn(turn(0, 40, HIRING));
  await index.flush();
  assert.equal(index.chunks().length, 1, 'the next meeting is searchable by now');

  release();
  assert.deepEqual(await pending, []);
});

test('flush after a reset waits for the new meeting, even once the old request has landed', async () => {
  const fake = fakeEmbedder();
  const releaseOld = fake.block();
  const index = new TranscriptIndex({ embedder: fake.embedder });
  index.addTurn(turn(0, 40, BUDGET));
  await settle();
  assert.equal(fake.documents.length, 1, 'the old meeting has a request out');

  index.reset();
  const releaseNew = fake.block();
  index.addTurn(turn(0, 40, HIRING));
  await settle();
  assert.equal(fake.documents.length, 2, 'the new meeting does not wait for it');

  // The old request lands first. It must not mark the new meeting's work as done.
  releaseOld();
  await settle();
  let flushed = false;
  const flushing = index.flush().then(() => {
    flushed = true;
  });
  await settle();
  assert.equal(flushed, false, 'the new chunk is still being embedded');
  assert.deepEqual(await index.search('analyst', 3, -1), []);

  releaseNew();
  await flushing;
  assert.deepEqual(
    (await index.search('hire a second analyst', 3, -1)).map((h) => h.text),
    [HIRING],
  );
});
