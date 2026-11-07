import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCallLog, LOG_MAX_CHARS, LOG_MAX_ENTRIES, withCallLog } from '../src/llm/callLog.ts';
import type { ChatRequest, ChatResult, EmbedRequest, OllamaClient } from '../src/types.ts';

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const USAGE = { model: 'gemma4:12b', promptTokens: 120, cachedTokens: 0, outputTokens: 9, totalMs: 900, loadMs: 0, promptMs: 300, evalMs: 600 };

function fakeClient(over: Partial<OllamaClient> = {}): OllamaClient {
  return {
    async chatStream(req: ChatRequest, onToken?: (delta: string, full: string) => void): Promise<ChatResult> {
      onToken?.('1. **Budget:**', '1. **Budget:**');
      onToken?.(' ok', '1. **Budget:** ok');
      return { text: '1. **Budget:** ok', usage: { ...USAGE, model: req.model }, doneReason: 'stop' };
    },
    async embed(req: EmbedRequest) {
      return { vectors: req.input.map(() => new Float32Array(4)), promptTokens: 42 };
    },
    async tags() {
      return ['gemma4:12b', 'embeddinggemma-2:270m'];
    },
    async ps() {
      return [];
    },
    async unload() {},
    ...over,
  };
}

const REQ: ChatRequest = {
  purpose: 'enhance',
  model: 'gemma4:12b',
  numCtx: 16384,
  temperature: 0.2,
  messages: [
    { role: 'system', content: 'You rewrite shorthand.' },
    { role: 'user', content: '<items>budget ok</items>' },
  ],
};

test('callLog: records a chat call as sent and as answered, and passes everything through', async () => {
  const c = clock();
  const log = createCallLog({ clock: c, enabled: true });
  const client = withCallLog(fakeClient(), log);
  const seen: string[] = [];
  const result = await client.chatStream(REQ, (_d, full) => seen.push(full));

  assert.equal(result.text, '1. **Budget:** ok');
  assert.deepEqual(seen, ['1. **Budget:**', '1. **Budget:** ok']);
  const [entry] = log.entries();
  assert.equal(entry.kind, 'chat');
  assert.equal(entry.purpose, 'enhance');
  assert.equal(entry.status, 'done');
  assert.deepEqual(
    entry.messages?.map((m) => [m.role, m.content, m.cut]),
    [
      ['system', 'You rewrite shorthand.', 0],
      ['user', '<items>budget ok</items>', 0],
    ],
  );
  assert.equal(entry.answer, '1. **Budget:** ok');
  assert.equal(entry.doneReason, 'stop');
  assert.equal(entry.usage?.promptTokens, 120);
  assert.deepEqual(entry.options, { numCtx: 16384, temperature: 0.2 });
});

test('callLog: records nothing while off, and forgets everything when switched off', async () => {
  const log = createCallLog({ clock: clock() });
  const client = withCallLog(fakeClient(), log);
  await client.chatStream(REQ);
  await client.embed({ model: 'e', input: ['a'], numCtx: 2048 });
  assert.equal(log.entries().length, 0);

  log.setEnabled(true);
  await client.chatStream(REQ);
  assert.equal(log.entries().length, 1);
  log.setEnabled(false);
  assert.equal(log.entries().length, 0);
});

test('callLog: an error and a cancel are recorded, and still thrown', async () => {
  const log = createCallLog({ clock: clock(), enabled: true });
  const failing = withCallLog(
    fakeClient({
      async chatStream() {
        throw Object.assign(new Error('Model gemma4:99b is not installed'), { kind: 'model_missing' });
      },
    }),
    log,
  );
  await assert.rejects(failing.chatStream(REQ), /not installed/);
  assert.equal(log.entries()[0].status, 'error');
  assert.match(log.entries()[0].error ?? '', /^model_missing: /);

  const cancelled = withCallLog(
    fakeClient({
      async chatStream() {
        throw Object.assign(new Error('aborted'), { kind: 'aborted' });
      },
    }),
    log,
  );
  await assert.rejects(cancelled.chatStream(REQ));
  assert.equal(log.entries()[0].status, 'cancelled');
});

test('callLog: an embedding call keeps its count and the first texts, shortened', async () => {
  const log = createCallLog({ clock: clock(), enabled: true });
  const client = withCallLog(fakeClient(), log);
  await client.embed({ model: 'embeddinggemma-2:270m', input: ['a', 'b', 'c', 'd', 'x'.repeat(1000)], numCtx: 2048 });
  const [entry] = log.entries();
  assert.equal(entry.kind, 'embed');
  assert.equal(entry.inputCount, 5);
  assert.deepEqual(entry.inputs, ['a', 'b', 'c']);
  assert.equal(entry.promptTokens, 42);
});

test('callLog: keeps the last 100 calls and cuts a long message, saying how much', async () => {
  const log = createCallLog({ clock: clock(), enabled: true });
  const client = withCallLog(fakeClient(), log);
  for (let i = 0; i < LOG_MAX_ENTRIES + 5; i++) await client.tags();
  assert.equal(log.entries().length, LOG_MAX_ENTRIES);

  await client.chatStream({ ...REQ, messages: [{ role: 'user', content: 'y'.repeat(LOG_MAX_CHARS + 500) }] });
  const [entry] = log.entries();
  assert.equal(entry.messages?.[0].content.length, LOG_MAX_CHARS);
  assert.equal(entry.messages?.[0].cut, 500);
});

test('callLog: listeners hear of a streaming answer at most four times a second', async () => {
  const c = clock();
  const log = createCallLog({ clock: c, enabled: true });
  let notices = 0;
  log.subscribe(() => notices++);
  const id = log.start({ kind: 'chat', model: 'm' });
  notices = 0;
  for (let i = 0; i < 10; i++) {
    log.update(id, { answer: `part ${i}` }, { streaming: true });
    c.advance(50);
  }
  assert.ok(notices <= 3, `${notices} notices for 500 ms of streaming`);
  log.update(id, { status: 'done' });
  assert.equal(log.entries()[0].answer, 'part 9');
});
