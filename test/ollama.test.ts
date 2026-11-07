import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOllamaClient, isOllamaError, modelInstalled, OllamaError } from '../src/llm/ollama.ts';
import type { ChatRequest, Clock, OllamaErrorKind } from '../src/types.ts';
import { estimateTokens } from '../src/util/text.ts';

const encoder = new TextEncoder();
const BASE = 'http://ollama.test:11434';

interface Call {
  url: string;
  method: string;
  body: any;
  headers: Record<string, string>;
  signal: AbortSignal | null;
}

type Handler = (call: Call, n: number) => Response | Promise<Response>;

function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn: typeof fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: init?.signal ?? null,
    };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { fetch: fn, calls };
}

interface ManualClock extends Clock {
  advance(ms: number): void;
  pending(): number;
}

function manualClock(): ManualClock {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    setInterval() {
      throw new Error('not used by the client');
    },
    clearInterval() {},
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next: { id: number; at: number; fn: () => void } | null = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (next === null || t.at < next.at)) next = { id, ...t };
        }
        if (next === null) break;
        timers.delete(next.id);
        now = next.at;
        next.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

/** Lets promise chains and stream reads run to their next real wait. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** A body the test feeds by hand; it also records whether the reader was cancelled. */
function liveStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    fail: (error: unknown) => controller.error(error),
    cancelled: () => cancelled,
  };
}

/** `count` copies of `chunk`, handed out one read at a time; it records how far the client read. */
function pullStream(chunk: Uint8Array, count: number) {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= count) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(chunk.slice());
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

function ndjson(objects: unknown[], trailingNewline = true): string {
  const text = objects.map((o) => JSON.stringify(o)).join('\n');
  return trailingNewline ? `${text}\n` : text;
}

function splitAt(bytes: Uint8Array, offsets: number[]): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let from = 0;
  for (const to of [...offsets, bytes.length]) {
    parts.push(bytes.slice(from, to));
    from = to;
  }
  return parts;
}

function ok(body: ReadableStream<Uint8Array> | string): Response {
  return new Response(body, { status: 200 });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

const token = (content: string) => ({ model: 'gemma4:12b', message: { role: 'assistant', content }, done: false });

const DONE = {
  model: 'gemma4:12b',
  message: { role: 'assistant', content: '' },
  done: true,
  done_reason: 'stop',
  total_duration: 4_200_000_000,
  load_duration: 1_500_000_000,
  prompt_eval_count: 1000,
  prompt_eval_cached_count: 900,
  prompt_eval_duration: 250_000_000,
  eval_count: 3,
  eval_duration: 120_500_000,
};

const REQ: ChatRequest = {
  model: 'gemma4:12b',
  messages: [{ role: 'user', content: 'bonjour' }],
  numCtx: 16384,
};

async function rejection(promise: Promise<unknown>, kind: OllamaErrorKind): Promise<OllamaError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isOllamaError(error), `expected an OllamaError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    return error;
  }
  assert.fail(`expected a rejection of kind ${kind}`);
}

test('chatStream: reassembles lines and characters cut by chunk boundaries', async () => {
  const text = ndjson(
    [
      token('Résumé'),
      { model: 'gemma4:12b', message: { role: 'assistant', content: '', thinking: 'hidden reasoning' }, done: false },
      token(' de la '),
      token('réunion'),
      DONE,
    ],
    false,
  ).replace('\n', '\n\n \n');
  const bytes = encoder.encode(text);

  const eAcute = bytes.indexOf(0xc3);
  assert.equal(bytes[eAcute + 1], 0xa9);
  const secondLine = text.indexOf('\n\n \n') + 4;
  const midSecondLine = encoder.encode(text.slice(0, secondLine)).length + 20;
  const midLastLine = bytes.length - 30;
  const chunks = splitAt(bytes, [5, eAcute + 1, midSecondLine, midLastLine]);
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(chunks[1]), 'the split must cut a character');

  const clock = manualClock();
  const { fetch, calls } = fakeFetch(() => ok(streamOf(chunks)));
  const client = createOllamaClient({ baseUrl: `${BASE}/`, fetch, clock });

  const seen: Array<[string, string]> = [];
  const result = await client.chatStream(REQ, (delta, full) => seen.push([delta, full]));

  assert.equal(result.text, 'Résumé de la réunion');
  assert.deepEqual(seen, [
    ['Résumé', 'Résumé'],
    [' de la ', 'Résumé de la '],
    ['réunion', 'Résumé de la réunion'],
  ]);
  assert.deepEqual(result.usage, {
    model: 'gemma4:12b',
    promptTokens: 1000,
    cachedTokens: 900,
    outputTokens: 3,
    totalMs: 4200,
    loadMs: 1500,
    promptMs: 250,
    evalMs: 120.5,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${BASE}/api/chat`);
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(clock.pending(), 0, 'no timer may outlive the call');
});

test('chatStream: one byte per chunk gives the same answer', async () => {
  const bytes = encoder.encode(ndjson([token('é'), token('→ok'), DONE]));
  const chunks = Array.from(bytes, (b) => Uint8Array.of(b));
  const { fetch } = fakeFetch(() => ok(streamOf(chunks)));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  assert.equal((await client.chatStream(REQ)).text, 'é→ok');
});

test('chatStream: a missing prompt_eval_cached_count counts as 0', async () => {
  const { prompt_eval_cached_count: _dropped, ...done } = DONE;
  const { fetch } = fakeFetch(() => ok(ndjson([token('ok'), done])));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  const { usage } = await client.chatStream(REQ);
  assert.equal(usage.cachedTokens, 0);
  assert.equal(usage.promptTokens, 1000);
  assert.equal(usage.model, 'gemma4:12b');
});

test('chatStream: the purpose of a call, for the Debug tab, is never sent to Ollama', async () => {
  const { fetch, calls } = fakeFetch(() => ok(ndjson([DONE])));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  await client.chatStream({ ...REQ, purpose: 'enhance' });
  assert.equal('purpose' in calls[0]?.body, false);
  assert.equal(JSON.stringify(calls[0]?.body).includes('enhance'), false);
});

test('chatStream: the minimal request carries think false and num_ctx, nothing undefined', async () => {
  const { fetch, calls } = fakeFetch(() => ok(ndjson([DONE])));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  await client.chatStream({ ...REQ, temperature: undefined, keepAlive: undefined, format: undefined });

  assert.deepEqual(calls[0]?.body, {
    model: 'gemma4:12b',
    messages: [{ role: 'user', content: 'bonjour' }],
    stream: true,
    think: false,
    options: { num_ctx: 16384 },
  });
  assert.equal(calls[0]?.headers['Content-Type'], 'application/json');
});

test('chatStream: every option maps to its Ollama name', async () => {
  const { fetch, calls } = fakeFetch(() => ok(ndjson([DONE])));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  const schema = { type: 'object', properties: { items: { type: 'array' } }, required: ['items'] };
  await client.chatStream({
    model: 'gemma4:12b',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    numCtx: 8192,
    temperature: 0,
    seed: 0,
    numPredict: 100,
    topK: 40,
    topP: 0.9,
    repeatPenalty: 1.05,
    format: schema,
    keepAlive: -1,
  });

  assert.deepEqual(calls[0]?.body, {
    model: 'gemma4:12b',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    stream: true,
    think: false,
    keep_alive: -1,
    format: schema,
    options: {
      num_ctx: 8192,
      temperature: 0,
      seed: 0,
      num_predict: 100,
      top_k: 40,
      top_p: 0.9,
      repeat_penalty: 1.05,
    },
  });
});

test('chatStream: keep_alive stays a number or a duration string', async () => {
  const { fetch, calls } = fakeFetch(() => ok(ndjson([DONE])));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  await client.chatStream({ ...REQ, keepAlive: 0 });
  await client.chatStream({ ...REQ, keepAlive: '5m' });
  // Ollama rejects the string "-1"; a numeric string is sent as the number it means.
  await client.chatStream({ ...REQ, keepAlive: '-1' });

  assert.deepEqual(
    calls.map((c) => c.body.keep_alive),
    [0, '5m', -1],
  );
});

test('chatStream: HTTP 404 is model_missing', async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse({ error: "model 'gemma4:12b' not found" }, 404));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  const error = await rejection(client.chatStream(REQ), 'model_missing');
  assert.equal(error.status, 404);
  assert.equal(error.model, 'gemma4:12b');
  assert.match(error.message, /ollama pull gemma4:12b/);
  assert.equal(calls.length, 1, 'a missing model is not retried');
});

test('chatStream: says why the answer ended', async () => {
  const cut = fakeFetch(() => ok(ndjson([token('1. **Budget:** cut'), { ...DONE, done_reason: 'length' }])));
  const result = await createOllamaClient({ baseUrl: BASE, fetch: cut.fetch, clock: manualClock() }).chatStream(REQ);
  assert.equal(result.doneReason, 'length');
  const plain = fakeFetch(() => ok(ndjson([token('ok'), { ...DONE, done_reason: undefined }])));
  const quiet = await createOllamaClient({ baseUrl: BASE, fetch: plain.fetch, clock: manualClock() }).chatStream(REQ);
  assert.equal('doneReason' in quiet, false);
});

test('chatStream: a bare 404 page is a wrong address, not a missing model', async () => {
  // A base URL that ends in /v1, or a proxy: "ollama pull" would not help.
  const { fetch } = fakeFetch(() => new Response('404 page not found', { status: 404 }));
  const client = createOllamaClient({ baseUrl: `${BASE}/v1`, fetch, clock: manualClock() });
  const error = await rejection(client.chatStream(REQ), 'http');
  assert.equal(error.status, 404);
  assert.doesNotMatch(error.message, /ollama pull/);
});

test('chatStream: HTTP 503 three times, then success, waiting 1 s, 2 s, 4 s', async () => {
  const clock = manualClock();
  const { fetch, calls } = fakeFetch((_call, n) =>
    n <= 3 ? jsonResponse({ error: 'server busy, please try again' }, 503) : ok(ndjson([token('enfin'), DONE])),
  );
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const promise = client.chatStream(REQ);

  await settle();
  assert.equal(calls.length, 1);
  for (const [wait, expected] of [
    [1000, 2],
    [2000, 3],
    [4000, 4],
  ] as const) {
    clock.advance(wait - 1);
    await settle();
    assert.equal(calls.length, expected - 1, `no retry before ${wait} ms`);
    clock.advance(1);
    await settle();
    assert.equal(calls.length, expected);
  }

  assert.equal((await promise).text, 'enfin');
  assert.equal(clock.pending(), 0);
});

test('chatStream: HTTP 503 forever is busy after the retries', async () => {
  const clock = manualClock();
  const { fetch, calls } = fakeFetch(() => jsonResponse({ error: 'server busy' }, 503));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const promise = rejection(client.chatStream(REQ), 'busy');

  for (const wait of [1000, 2000, 4000]) {
    await settle();
    clock.advance(wait);
  }
  const error = await promise;
  assert.equal(error.status, 503);
  assert.equal(calls.length, 4);
  assert.equal(clock.pending(), 0);
});

test('chatStream: busyRetries 0 fails on the first 503', async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse({ error: 'server busy' }, 503));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock(), busyRetries: 0 });
  await rejection(client.chatStream(REQ), 'busy');
  assert.equal(calls.length, 1);
});

test('chatStream: a rejected fetch is unreachable', async () => {
  const cause = new TypeError('fetch failed');
  const { fetch } = fakeFetch(() => Promise.reject(cause));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  const error = await rejection(client.chatStream(REQ), 'unreachable');
  assert.equal(error.status, null);
  assert.equal(error.cause, cause);
  assert.match(error.message, /ollama\.test:11434/);
});

test('chatStream: other HTTP errors keep the status and the body text', async () => {
  const { fetch } = fakeFetch(() => jsonResponse({ error: 'invalid options: num_ctx' }, 400));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  const error = await rejection(client.chatStream(REQ), 'http');
  assert.equal(error.status, 400);
  assert.match(error.message, /400/);
  assert.match(error.message, /invalid options: num_ctx/);

  const plain = fakeFetch(() => new Response('upstream exploded', { status: 500 }));
  const client2 = createOllamaClient({ baseUrl: BASE, fetch: plain.fetch, clock: manualClock() });
  const error2 = await rejection(client2.chatStream(REQ), 'http');
  assert.equal(error2.status, 500);
  assert.match(error2.message, /upstream exploded/);
});

test('chatStream: a signal aborted beforehand sends nothing', async () => {
  const { fetch, calls } = fakeFetch(() => ok(ndjson([DONE])));
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const controller = new AbortController();
  controller.abort();
  await rejection(client.chatStream(REQ, undefined, controller.signal), 'aborted');
  assert.equal(calls.length, 0);
  assert.equal(clock.pending(), 0);
});

test('chatStream: an abort while waiting for the answer rejects even if fetch never settles', async () => {
  const { fetch, calls } = fakeFetch(() => new Promise<Response>(() => {}));
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const controller = new AbortController();
  const promise = rejection(client.chatStream(REQ, undefined, controller.signal), 'aborted');
  await settle();
  controller.abort();
  await promise;
  assert.equal(calls[0]?.signal?.aborted, true, 'the request itself is aborted');
  assert.equal(clock.pending(), 0);
});

test('chatStream: an abort during the stream cancels the reader', async () => {
  const body = liveStream();
  const { fetch, calls } = fakeFetch(() => ok(body.stream));
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const controller = new AbortController();
  const seen: string[] = [];
  const promise = rejection(
    client.chatStream(REQ, (delta) => seen.push(delta), controller.signal),
    'aborted',
  );

  body.push(ndjson([token('début')]));
  await settle();
  assert.deepEqual(seen, ['début']);

  controller.abort();
  await promise;
  await settle();
  assert.equal(body.cancelled(), true);
  assert.equal(calls[0]?.signal?.aborted, true);
  assert.equal(clock.pending(), 0);
});

test('chatStream: an abort from inside onToken stops the rest of a chunk that is already in memory', async () => {
  // The whole answer, closing line included, arrives as one network chunk.
  const { fetch } = fakeFetch(() => ok(ndjson([token('un'), token(' deux'), token(' trois'), DONE])));
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const controller = new AbortController();
  const seen: string[] = [];
  const promise = client.chatStream(
    REQ,
    (delta) => {
      seen.push(delta);
      controller.abort();
    },
    controller.signal,
  );
  await rejection(promise, 'aborted');
  assert.deepEqual(seen, ['un'], 'nothing is delivered after the abort');
  assert.equal(clock.pending(), 0);
});

test('chatStream: an abort wins over chunks that are already buffered', async () => {
  // This fake fetch does not tie the body to the signal, so the buffered
  // chunks stay readable after the abort: the client must not rely on fetch.
  const body = liveStream();
  const { fetch } = fakeFetch(() => ok(body.stream));
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const controller = new AbortController();
  const seen: string[] = [];
  const promise = rejection(
    client.chatStream(REQ, (delta) => seen.push(delta), controller.signal),
    'aborted',
  );

  body.push(ndjson([token('un')]));
  await settle();
  body.push(ndjson([token(' deux')]));
  body.push(ndjson([DONE]));
  controller.abort();
  await promise;
  await settle();
  assert.deepEqual(seen, ['un']);
  assert.equal(body.cancelled(), true);
  assert.equal(clock.pending(), 0);
});

test('chatStream: an abort during the 503 backoff rejects at once and never retries', async () => {
  const clock = manualClock();
  const { fetch, calls } = fakeFetch(() => jsonResponse({ error: 'server busy' }, 503));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const controller = new AbortController();
  const promise = rejection(client.chatStream(REQ, undefined, controller.signal), 'aborted');
  await settle();
  assert.equal(calls.length, 1);
  clock.advance(500);
  controller.abort();
  await promise;
  assert.equal(clock.pending(), 0, 'the backoff timer is cleared');
  clock.advance(60_000);
  await settle();
  assert.equal(calls.length, 1);
});

test('chatStream: the backoff is not a stall, and each attempt gets the full first-token wait', async () => {
  const clock = manualClock();
  const body = liveStream();
  const { fetch, calls } = fakeFetch((_call, n) =>
    n <= 3 ? jsonResponse({ error: 'server busy' }, 503) : ok(body.stream),
  );
  // Shorter than the 2 s and 4 s backoffs on purpose.
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock, firstTokenTimeoutMs: () => 1500 });
  let outcome: unknown = null;
  const promise = client.chatStream(REQ).then(
    (value) => {
      outcome = value;
    },
    (error: unknown) => {
      outcome = error;
    },
  );

  for (const wait of [1000, 2000, 4000]) {
    await settle();
    clock.advance(wait);
  }
  await settle();
  assert.equal(calls.length, 4);
  assert.equal(outcome, null, 'waiting out a backoff is not a stall');
  clock.advance(1499);
  await settle();
  assert.equal(outcome, null);
  clock.advance(1);
  await promise;
  assert.ok(isOllamaError(outcome, 'stalled'));
  assert.equal(clock.pending(), 0);
});

test('chatStream: an exception thrown by onToken propagates unchanged and releases the request', async () => {
  const body = liveStream();
  const { fetch } = fakeFetch(() => ok(body.stream));
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const boom = new Error('boom');
  const promise = client.chatStream(REQ, () => {
    throw boom;
  });
  body.push(ndjson([token('a')]));
  await assert.rejects(promise, (error) => error === boom);
  await settle();
  assert.equal(body.cancelled(), true);
  assert.equal(clock.pending(), 0);
});

test('chatStream: CRLF line endings are tolerated', async () => {
  const text = [token('é'), token('à'), DONE].map((o) => `${JSON.stringify(o)}\r\n`).join('');
  const { fetch } = fakeFetch(() => ok(text));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  const result = await client.chatStream(REQ);
  assert.equal(result.text, 'éà');
  assert.equal(result.usage.promptTokens, 1000);
});

test('the listener on the caller signal is removed after every outcome', async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  let listening = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<typeof add>) => {
    listening += 1;
    add(...args);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
    listening -= 1;
    remove(...args);
  }) as typeof signal.removeEventListener;

  const good = fakeFetch(() => ok(ndjson([token('a'), DONE])));
  await createOllamaClient({ baseUrl: BASE, fetch: good.fetch, clock: manualClock() }).chatStream(REQ, undefined, signal);
  assert.equal(listening, 0, 'after a success');

  const bad = fakeFetch(() => jsonResponse({ error: 'boom' }, 500));
  await rejection(
    createOllamaClient({ baseUrl: BASE, fetch: bad.fetch, clock: manualClock() }).chatStream(REQ, undefined, signal),
    'http',
  );
  assert.equal(listening, 0, 'after a failure');

  const vectors = fakeFetch(() => jsonResponse({ embeddings: [[1, 2]] }));
  await createOllamaClient({ baseUrl: BASE, fetch: vectors.fetch, clock: manualClock() }).embed(
    { model: 'm', input: ['a'], numCtx: 2048 },
    signal,
  );
  assert.equal(listening, 0, 'after an embed');
});

test('chatStream: no first chunk within the first-token timeout is stalled', async () => {
  const { fetch, calls } = fakeFetch(() => new Promise<Response>(() => {}));
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  let settled = false;
  const promise = rejection(client.chatStream(REQ), 'stalled').finally(() => {
    settled = true;
  });

  await settle();
  // A short prompt gets the 120 s floor of the default.
  clock.advance(119_999);
  await settle();
  assert.equal(settled, false);
  clock.advance(1);
  await promise;
  assert.equal(calls[0]?.signal?.aborted, true, 'the stalled request is aborted');
  assert.equal(clock.pending(), 0);
});

test('chatStream: the first-token timeout is sized from the prompt and covers headers without a body', async () => {
  const body = liveStream();
  const { fetch } = fakeFetch(() => ok(body.stream));
  const clock = manualClock();
  const asked: number[] = [];
  const client = createOllamaClient({
    baseUrl: BASE,
    fetch,
    clock,
    interChunkTimeoutMs: 1000,
    firstTokenTimeoutMs: (promptTokens) => {
      asked.push(promptTokens);
      return 5000;
    },
  });
  const messages: ChatRequest['messages'] = [
    { role: 'system', content: 'Tu es un assistant de prise de notes.' },
    { role: 'user', content: 'budget Q3: gel des embauches, revoir en novembre' },
  ];
  let settled = false;
  const promise = rejection(client.chatStream({ ...REQ, messages }), 'stalled').finally(() => {
    settled = true;
  });

  await settle();
  assert.deepEqual(asked, [messages.reduce((n, m) => n + estimateTokens(m.content), 0)]);
  // Headers are in but no chunk yet: the short inter-chunk timeout must not apply.
  clock.advance(4999);
  await settle();
  assert.equal(settled, false);
  clock.advance(1);
  await promise;
  await settle();
  assert.equal(body.cancelled(), true);
});

test('chatStream: the default first-token timeout grows with the prompt', async () => {
  const { fetch } = fakeFetch(() => new Promise<Response>(() => {}));
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const content = 'x'.repeat(66_000);
  const expected = 30_000 + estimateTokens(content) * 10;
  assert.ok(expected > 120_000);
  let settled = false;
  const promise = rejection(client.chatStream({ ...REQ, messages: [{ role: 'user', content }] }), 'stalled').finally(
    () => {
      settled = true;
    },
  );

  await settle();
  clock.advance(expected - 1);
  await settle();
  assert.equal(settled, false);
  clock.advance(1);
  await promise;
});

test('chatStream: silence between chunks is stalled, and every chunk restarts the wait', async () => {
  const body = liveStream();
  const { fetch, calls } = fakeFetch(() => ok(body.stream));
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const seen: string[] = [];
  let settled = false;
  const promise = rejection(
    client.chatStream(REQ, (delta) => seen.push(delta)),
    'stalled',
  ).finally(() => {
    settled = true;
  });

  body.push(ndjson([token('un')]));
  await settle();
  clock.advance(40_000);
  body.push(ndjson([token(' deux')]));
  await settle();
  clock.advance(40_000);
  await settle();
  assert.equal(settled, false, '80 s in total, but never 60 s of silence');
  assert.deepEqual(seen, ['un', ' deux']);

  clock.advance(19_999);
  await settle();
  assert.equal(settled, false);
  clock.advance(1);
  const error = await promise;
  await settle();
  assert.match(error.message, /60 s/);
  assert.equal(body.cancelled(), true);
  assert.equal(calls[0]?.signal?.aborted, true);
  assert.equal(clock.pending(), 0);
});

test('chatStream: an error line in the stream is reported', async () => {
  const { fetch } = fakeFetch(() => ok(ndjson([token('par'), { error: 'llama runner process has terminated' }])));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  const seen: string[] = [];
  const error = await rejection(
    client.chatStream(REQ, (delta) => seen.push(delta)),
    'http',
  );
  assert.match(error.message, /runner process has terminated/);
  assert.equal(error.status, null);
  assert.deepEqual(seen, ['par']);

  const missing = fakeFetch(() => ok(ndjson([{ error: "model 'gemma4:12b' not found" }])));
  const client2 = createOllamaClient({ baseUrl: BASE, fetch: missing.fetch, clock: manualClock() });
  await rejection(client2.chatStream(REQ), 'model_missing');
});

test('chatStream: a stream that ends without done is a protocol error', async () => {
  const { fetch } = fakeFetch(() => ok(ndjson([token('coupé')])));
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  await rejection(client.chatStream(REQ), 'protocol');
  assert.equal(clock.pending(), 0);

  const empty = fakeFetch(() => ok(''));
  await rejection(
    createOllamaClient({ baseUrl: BASE, fetch: empty.fetch, clock: manualClock() }).chatStream(REQ),
    'protocol',
  );

  const garbage = fakeFetch(() => ok('<html>not ollama</html>\n'));
  await rejection(
    createOllamaClient({ baseUrl: BASE, fetch: garbage.fetch, clock: manualClock() }).chatStream(REQ),
    'protocol',
  );
});

test('chatStream: a stream line that never ends is a protocol error, read no further than 1 MB', async () => {
  // 2 MB without a newline, 64 KB at a time.
  const body = pullStream(encoder.encode('x'.repeat(64 << 10)), 32);
  const { fetch } = fakeFetch(() => ok(body.stream));
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const error = await rejection(client.chatStream(REQ), 'protocol');
  assert.match(error.message, /too long/);
  await settle();
  assert.ok(body.pulled() < 32, `stopped after ${body.pulled()} chunks`);
  assert.equal(body.cancelled(), true);
  assert.equal(clock.pending(), 0);

  // The bound is on one line, not on the answer: many short lines can add up to more.
  const lines = Array.from({ length: 20_000 }, () => token('x'.repeat(50)));
  const long = ndjson([...lines, DONE]);
  assert.ok(encoder.encode(long).length > 2 << 20);
  const { fetch: fetchLong } = fakeFetch(() => ok(long));
  const result = await createOllamaClient({ baseUrl: BASE, fetch: fetchLong, clock: manualClock() }).chatStream(REQ);
  assert.equal(result.text.length, 20_000 * 50);
});

test('an error body is read up to 64 KB and no further', async () => {
  // A 1 MB 404 page: its first words are all the message shows.
  const body = pullStream(encoder.encode('Not found here. '.repeat(4096)), 16);
  const { fetch } = fakeFetch(() => new Response(body.stream, { status: 404 }));
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const error = await rejection(client.chatStream(REQ), 'http');
  assert.equal(error.status, 404);
  assert.match(error.message, /Not found here/);
  assert.ok(error.message.length < 70_000);
  await settle();
  assert.ok(body.pulled() < 16, `stopped after ${body.pulled()} chunks`);
  assert.equal(body.cancelled(), true);
  assert.equal(clock.pending(), 0);
});

test('chatStream: a connection lost mid-stream is unreachable', async () => {
  const body = liveStream();
  const { fetch } = fakeFetch(() => ok(body.stream));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  const promise = rejection(client.chatStream(REQ), 'unreachable');
  body.push(ndjson([token('a')]));
  await settle();
  body.fail(new TypeError('terminated'));
  await promise;
});

test('chatStream: the answer is returned as soon as done arrives, without waiting for the close', async () => {
  const body = liveStream();
  const { fetch } = fakeFetch(() => ok(body.stream));
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const promise = client.chatStream(REQ);
  body.push(ndjson([token('fini'), DONE]));
  assert.equal((await promise).text, 'fini');
  await settle();
  assert.equal(body.cancelled(), true);
  assert.equal(clock.pending(), 0);
});

test('baseUrl may be a function, read on every call', async () => {
  let url = 'http://one.test:1///';
  const { fetch, calls } = fakeFetch(() => jsonResponse({ models: [] }));
  const client = createOllamaClient({ baseUrl: () => url, fetch, clock: manualClock() });
  await client.tags();
  url = ' http://two.test:2 ';
  await client.tags();
  assert.deepEqual(
    calls.map((c) => c.url),
    ['http://one.test:1/api/tags', 'http://two.test:2/api/tags'],
  );
});

test('embed: sends the batch and returns Float32Array vectors in order', async () => {
  const { fetch, calls } = fakeFetch(() =>
    jsonResponse({
      model: 'embeddinggemma-2:270m',
      embeddings: [
        [0.25, -0.5, 1],
        [0, 0.125, -1],
      ],
      prompt_eval_count: 17,
    }),
  );
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const result = await client.embed({
    model: 'embeddinggemma-2:270m',
    input: ['task: search result | query: budget', 'title: none | text: le budget est gelé'],
    numCtx: 2048,
    dimensions: 768,
    keepAlive: '30m',
  });

  assert.equal(calls[0]?.url, `${BASE}/api/embed`);
  assert.equal(calls[0]?.method, 'POST');
  assert.deepEqual(calls[0]?.body, {
    model: 'embeddinggemma-2:270m',
    input: ['task: search result | query: budget', 'title: none | text: le budget est gelé'],
    truncate: true,
    dimensions: 768,
    keep_alive: '30m',
    options: { num_ctx: 2048 },
  });
  assert.equal(result.promptTokens, 17);
  assert.equal(result.vectors.length, 2);
  assert.ok(result.vectors.every((v) => v instanceof Float32Array));
  assert.deepEqual(Array.from(result.vectors[0] ?? []), [0.25, -0.5, 1]);
  assert.deepEqual(Array.from(result.vectors[1] ?? []), [0, 0.125, -1]);
  assert.equal(clock.pending(), 0);
});

test('embed: optional keys are left out', async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse({ embeddings: [[1, 2]] }));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  const result = await client.embed({ model: 'm', input: ['a'], numCtx: 2048 });
  assert.deepEqual(calls[0]?.body, { model: 'm', input: ['a'], truncate: true, options: { num_ctx: 2048 } });
  assert.equal(result.promptTokens, 0);
});

test('embed: an empty input returns empty without a request', async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse({ embeddings: [] }));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  assert.deepEqual(await client.embed({ model: 'm', input: [], numCtx: 2048 }), { vectors: [], promptTokens: 0 });
  assert.equal(calls.length, 0);
});

test('embed: a wrong number of vectors is a protocol error', async () => {
  const { fetch } = fakeFetch(() => jsonResponse({ embeddings: [[1, 2, 3]], prompt_eval_count: 4 }));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  await rejection(client.embed({ model: 'm', input: ['a', 'b'], numCtx: 2048 }), 'protocol');

  const none = fakeFetch(() => jsonResponse({ prompt_eval_count: 4 }));
  const client2 = createOllamaClient({ baseUrl: BASE, fetch: none.fetch, clock: manualClock() });
  await rejection(client2.embed({ model: 'm', input: ['a'], numCtx: 2048 }), 'protocol');

  const ragged = fakeFetch(() => jsonResponse({ embeddings: [[1, 2], 'oops'] }));
  const client3 = createOllamaClient({ baseUrl: BASE, fetch: ragged.fetch, clock: manualClock() });
  await rejection(client3.embed({ model: 'm', input: ['a', 'b'], numCtx: 2048 }), 'protocol');
});

test('embed: a body past 16 MB is a protocol error, read no further', async () => {
  // 24 MB of digits, 1 MB at a time: never parsed, never held whole.
  const body = pullStream(encoder.encode('1'.repeat(1 << 20)), 24);
  const { fetch } = fakeFetch(() => ok(body.stream));
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  const error = await rejection(client.embed({ model: 'm', input: ['a'], numCtx: 2048 }), 'protocol');
  assert.match(error.message, /too large/);
  await settle();
  assert.ok(body.pulled() < 24, `stopped after ${body.pulled()} chunks`);
  assert.equal(body.cancelled(), true);
  assert.equal(clock.pending(), 0);
});

test('embed: errors and aborts map like chat', async () => {
  const missing = fakeFetch(() => jsonResponse({ error: 'model "m" not found, try pulling it first' }, 404));
  const client = createOllamaClient({ baseUrl: BASE, fetch: missing.fetch, clock: manualClock() });
  const error = await rejection(client.embed({ model: 'm', input: ['a'], numCtx: 2048 }), 'model_missing');
  assert.equal(error.model, 'm');

  const hanging = fakeFetch(() => new Promise<Response>(() => {}));
  const client2 = createOllamaClient({ baseUrl: BASE, fetch: hanging.fetch, clock: manualClock() });
  const controller = new AbortController();
  const promise = rejection(client2.embed({ model: 'm', input: ['a'], numCtx: 2048 }, controller.signal), 'aborted');
  await settle();
  controller.abort();
  await promise;

  const clock = manualClock();
  const client3 = createOllamaClient({ baseUrl: BASE, fetch: hanging.fetch, clock });
  const stalled = rejection(client3.embed({ model: 'm', input: ['a'], numCtx: 2048 }), 'stalled');
  await settle();
  clock.advance(120_000);
  await stalled;
});

test('embed: headers followed by a body that never arrives is stalled', async () => {
  const body = liveStream();
  const { fetch, calls } = fakeFetch(() => ok(body.stream));
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock, interChunkTimeoutMs: 1000 });
  let settled = false;
  const promise = rejection(client.embed({ model: 'm', input: ['a'], numCtx: 2048 }), 'stalled').finally(() => {
    settled = true;
  });
  await settle();
  clock.advance(999);
  await settle();
  assert.equal(settled, false);
  clock.advance(1);
  await promise;
  assert.equal(calls[0]?.signal?.aborted, true);
  assert.equal(clock.pending(), 0);
});

test('tags: lists the installed model names', async () => {
  const { fetch, calls } = fakeFetch(() =>
    jsonResponse({ models: [{ name: 'gemma4:31b', size: 1 }, { name: 'qwen3-embedding:8b' }, { size: 3 }] }),
  );
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  assert.deepEqual(await client.tags(), ['gemma4:31b', 'qwen3-embedding:8b']);
  assert.equal(calls[0]?.url, `${BASE}/api/tags`);
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.body, undefined);
});

test('tags: an unreachable server, a foreign 404 and a foreign body', async () => {
  const down = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
  await rejection(createOllamaClient({ baseUrl: BASE, fetch: down.fetch, clock: manualClock() }).tags(), 'unreachable');

  // No model is involved, so a 404 here cannot mean "model missing".
  const notOllama = fakeFetch(() => new Response('Not Found', { status: 404 }));
  const error = await rejection(
    createOllamaClient({ baseUrl: BASE, fetch: notOllama.fetch, clock: manualClock() }).tags(),
    'http',
  );
  assert.equal(error.status, 404);

  const html = fakeFetch(() => ok('<html></html>'));
  await rejection(createOllamaClient({ baseUrl: BASE, fetch: html.fetch, clock: manualClock() }).tags(), 'protocol');

  const shape = fakeFetch(() => jsonResponse({ hello: 'world' }));
  await rejection(createOllamaClient({ baseUrl: BASE, fetch: shape.fetch, clock: manualClock() }).tags(), 'protocol');
});

test('ps: reports loaded models with their context and size', async () => {
  const { fetch, calls } = fakeFetch(() =>
    jsonResponse({
      models: [{ name: 'gemma4:12b', model: 'gemma4:12b', size: 9_800_000_000, context_length: 16384 }, { name: 'bare' }],
    }),
  );
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock: manualClock() });
  assert.deepEqual(await client.ps(), [
    { name: 'gemma4:12b', contextLength: 16384, sizeBytes: 9_800_000_000 },
    { name: 'bare', contextLength: 0, sizeBytes: 0 },
  ]);
  assert.equal(calls[0]?.url, `${BASE}/api/ps`);
  assert.equal(calls[0]?.method, 'GET');
});

test('unload: asks for keep_alive 0 and ignores a model that is not installed', async () => {
  const { fetch, calls } = fakeFetch((call) =>
    call.body.model === 'ghost'
      ? jsonResponse({ error: "model 'ghost' not found" }, 404)
      : jsonResponse({ model: call.body.model, done: true, done_reason: 'unload' }),
  );
  const clock = manualClock();
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  await client.unload('gemma4:12b');
  await client.unload('ghost');

  assert.equal(calls[0]?.url, `${BASE}/api/generate`);
  assert.equal(calls[0]?.method, 'POST');
  assert.deepEqual(calls[0]?.body, { model: 'gemma4:12b', keep_alive: 0, stream: false });
  assert.equal(calls.length, 2);
  assert.equal(clock.pending(), 0);

  const broken = fakeFetch(() => new Response('boom', { status: 500 }));
  await rejection(
    createOllamaClient({ baseUrl: BASE, fetch: broken.fetch, clock: manualClock() }).unload('gemma4:12b'),
    'http',
  );
});

test('modelInstalled: the prefixes of the default registry name the same model', () => {
  const tags = ['gemma4:12b', 'embeddinggemma-2:270m'];
  assert.equal(modelInstalled(tags, 'library/gemma4:12b'), true);
  assert.equal(modelInstalled(tags, 'registry.ollama.ai/library/gemma4:12b'), true);
  assert.equal(modelInstalled(tags, 'ollama.com/library/embeddinggemma-2:270m'), true);
  // Another namespace is another model.
  assert.equal(modelInstalled(tags, 'someone/gemma4:12b'), false);
  assert.equal(modelInstalled(tags, 'gemma4'), false);
});

test('modelInstalled: name and name:latest are the same model', () => {
  const tags = ['gemma4:31b', 'nemotron-cascade-2:latest', 'qwen3-embedding:8b', 'localhost:5000/team/custom'];
  assert.equal(modelInstalled(tags, 'gemma4:31b'), true);
  assert.equal(modelInstalled(tags, 'nemotron-cascade-2'), true);
  assert.equal(modelInstalled(tags, 'nemotron-cascade-2:latest'), true);
  assert.equal(modelInstalled(['nemotron-cascade-2'], 'nemotron-cascade-2:latest'), true);
  assert.equal(modelInstalled(tags, 'Gemma4:31B'), true);
  assert.equal(modelInstalled(tags, 'localhost:5000/team/custom:latest'), true);

  assert.equal(modelInstalled(tags, 'gemma4:12b'), false);
  assert.equal(modelInstalled(tags, 'gemma4'), false, 'an untagged name means :latest, not any tag');
  assert.equal(modelInstalled(tags, 'qwen3-embedding'), false);
  assert.equal(modelInstalled(tags, ''), false);
  assert.equal(modelInstalled([], 'gemma4:12b'), false);
});

test('isOllamaError: narrows by kind', () => {
  const error = new OllamaError('busy', 'busy', { status: 503, model: 'm' });
  assert.equal(error.name, 'OllamaError');
  assert.ok(error instanceof Error);
  assert.equal(isOllamaError(error), true);
  assert.equal(isOllamaError(error, 'busy'), true);
  assert.equal(isOllamaError(error, 'aborted'), false);
  assert.equal(isOllamaError(new Error('plain')), false);
  assert.equal(isOllamaError(null), false);
  assert.equal(new OllamaError('protocol', 'x').status, null);
  assert.equal(new OllamaError('protocol', 'x').model, null);
});

test('the default timeouts work on real timers', async () => {
  const clock: Clock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  };
  const { fetch } = fakeFetch(() => ok(ndjson([token('ok'), DONE])));
  const client = createOllamaClient({ baseUrl: BASE, fetch, clock });
  assert.equal((await client.chatStream(REQ)).text, 'ok');
});

test('without a fetch, the client uses the window’s', async (t) => {
  const { fetch, calls } = fakeFetch(() => ok(ndjson([token('ok'), DONE])));
  const globals = globalThis as Record<string, unknown>;
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globals.window = { fetch };
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'window', saved);
    else delete globals.window;
  });
  const client = createOllamaClient({ baseUrl: BASE, clock: manualClock() });
  assert.equal((await client.chatStream(REQ)).text, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/api/chat`);
});
