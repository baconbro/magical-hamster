import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ChatRequest,
  ChatResult,
  ChatUsage,
  Clock,
  EmbedResult,
  EnhancedItem,
  EnhanceStatus,
  Excerpt,
  LlmScheduler,
  OllamaClient,
  Priority,
  SectionItem,
} from '../src/types.ts';
import {
  EnhanceEngine,
  holdsLine,
  tiedTo,
} from '../src/llm/enhance.ts';
import type { EnhanceSettings } from '../src/llm/enhance.ts';
import { shortHash } from '../src/util/hash.ts';

class ManualClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void; every: number | null }>();

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    this.timers.set(++this.seq, { at: this.t + ms, fn, every: null });
    return this.seq;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  setInterval(fn: () => void, ms: number): unknown {
    this.timers.set(++this.seq, { at: this.t + ms, fn, every: ms });
    return this.seq;
  }
  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  pending(): number {
    return this.timers.size;
  }
  /** Moves time forward, firing due timers in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let nextId = 0;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      const timer = this.timers.get(nextId);
      if (!timer) break;
      this.t = timer.at;
      if (timer.every === null) this.timers.delete(nextId);
      else timer.at += timer.every;
      timer.fn();
    }
    this.t = end;
  }
}

function fail(kind: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(kind), { kind, ...extra });
}

interface Sent {
  n: number;
  excerpts: string;
  text: string;
  previous: string | null;
}

/** The items a request carries, read back from its user message. */
function sent(req: ChatRequest): Sent[] {
  const user = req.messages[req.messages.length - 1].content;
  const out: Sent[] = [];
  for (const m of user.matchAll(/<item n="(\d+)" excerpts="([^"]*)">(.*)<\/item>/g)) {
    const previous = new RegExp(`<previous n="${m[1]}">(.*)</previous>`).exec(user);
    out.push({ n: Number(m[1]), excerpts: m[2], text: m[3], previous: previous ? previous[1] : null });
  }
  return out;
}

function gate(): { promise: Promise<void>; open(): void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

interface Scripted {
  pieces: string[];
  /** What the server gives as the reason the answer ended. */
  doneReason?: string;
  /** Runs after each piece has been delivered: lets a test move the clock mid-stream. */
  between?: (index: number) => void;
  /** The call stays open until this resolves (or the signal aborts). */
  hold?: Promise<void>;
}
type Reply = string | Error | Scripted;

class FakeLlm implements OllamaClient {
  requests: ChatRequest[] = [];
  script: Array<Reply | ((req: ChatRequest) => Reply)> = [];

  /** Without a script, every item is answered. */
  answerAll(req: ChatRequest): string {
    return sent(req)
      .map((item) => `${item.n}. **Note:** ${item.text} (call ${this.requests.length})`)
      .join('\n');
  }

  async chatStream(
    req: ChatRequest,
    onToken?: (delta: string, full: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    this.requests.push(req);
    const next = this.script.shift();
    const reply = next === undefined ? this.answerAll(req) : typeof next === 'function' ? next(req) : next;
    if (reply instanceof Error) throw reply;
    const scripted: Scripted = typeof reply === 'string' ? { pieces: [reply] } : reply;
    let full = '';
    scripted.pieces.forEach((piece, index) => {
      full += piece;
      onToken?.(piece, full);
      scripted.between?.(index);
    });
    if (scripted.hold) {
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(fail('aborted')), { once: true });
        void scripted.hold?.then(resolve);
      });
    }
    if (signal?.aborted) throw fail('aborted');
    return {
      text: full,
      doneReason: scripted.doneReason,
      usage: {
        model: req.model,
        promptTokens: 100,
        cachedTokens: 0,
        outputTokens: 20,
        totalMs: 1,
        loadMs: 0,
        promptMs: 0,
        evalMs: 1,
      },
    };
  }
  async embed(): Promise<EmbedResult> {
    return { vectors: [], promptTokens: 0 };
  }
  async tags(): Promise<string[]> {
    return [];
  }
  async ps(): Promise<Array<{ name: string; contextLength: number; sizeBytes: number }>> {
    return [];
  }
  async unload(): Promise<void> {}
}

/** Runs tasks at once. `abortRunning` plays the real queue taking the model away. */
class FakeScheduler implements LlmScheduler {
  calls: Array<{ model: string; priority: Priority; key: string | null }> = [];
  /** When set, tasks wait for it before they start: the model is taken by other work. */
  waitFor: Promise<void> | null = null;
  private running = new Set<AbortController>();

  async run<T>(
    model: string,
    priority: Priority,
    key: string | null,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.calls.push({ model, priority, key });
    if (this.waitFor) await this.waitFor;
    const ctl = new AbortController();
    this.running.add(ctl);
    try {
      const value = await task(ctl.signal);
      if (ctl.signal.aborted) throw fail('aborted');
      return value;
    } finally {
      this.running.delete(ctl);
    }
  }
  busy(): boolean {
    return false;
  }
  cancelAll(): void {
    this.abortRunning();
  }
  abortRunning(): void {
    for (const ctl of this.running) ctl.abort();
  }
  inFlight(): number {
    return this.running.size;
  }
}

/** Lets promise chains and the engine's async run settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Shorthand lines as the section resolver reports them; "#### x" is a topic. */
function section(...lines: string[]): SectionItem[] {
  const seen = new Map<string, number>();
  return lines.map((raw, line) => {
    const topic = raw.startsWith('#### ');
    const text = topic ? raw.slice(5) : raw;
    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    const base = shortHash(text);
    return {
      id: count > 1 ? `${base}#${count}` : base,
      text,
      raw: topic ? raw : `- ${raw}`,
      line,
      kind: topic ? 'topic' : 'item',
    };
  });
}

interface Snapshot {
  items: EnhancedItem[];
  status: EnhanceStatus;
  error: string | null;
}

function setup(
  over: Partial<EnhanceSettings> = {},
  extra: {
    retrieve?: (text: string, signal: AbortSignal) => Promise<Excerpt[]>;
    glossary?: () => string[];
  } = {},
) {
  const clock = new ManualClock();
  const llm = new FakeLlm();
  const scheduler = new FakeScheduler();
  const settings: EnhanceSettings = {
    model: 'gemma4:12b',
    liveModel: 'gemma4:live',
    numCtx: 16384,
    style: 'standard',
    debounceMs: 2500,
    maxWaitMs: 8000,
    micLabel: 'Alex',
    ...over,
  };
  const states: Snapshot[] = [];
  const usages: ChatUsage[] = [];
  const engine = new EnhanceEngine({
    llm,
    scheduler,
    clock,
    settings: () => settings,
    retrieve: extra.retrieve,
    glossary: extra.glossary,
    onState: (items, status, error) => states.push({ items, status, error }),
    onUsage: (usage) => usages.push(usage),
  });
  const last = (): Snapshot => states[states.length - 1];
  /** Statuses in the order they were reported, repeats collapsed. */
  const statuses = (): EnhanceStatus[] =>
    states.map((s) => s.status).filter((status, i, all) => i === 0 || all[i - 1] !== status);
  return { clock, llm, scheduler, settings, states, usages, engine, last, statuses };
}

function excerpt(id: string, score = 0.7, text = `what was said in ${id}`): Excerpt {
  const n = Number(id.slice(1));
  return { id, time: `${String(n).padStart(2, '0')}:00`, text, score };
}

describe('EnhanceEngine: what is sent', () => {
  it('enhances every line on the first run, with the documented options', async () => {
    const t = setup();
    t.engine.setTitle('1:1 Camille Roy');
    t.engine.setItems(section('budget iam fin oct', 'vendor quote sso'));
    await t.engine.runNow();

    assert.equal(t.llm.requests.length, 1);
    const req = t.llm.requests[0];
    assert.deepEqual(
      sent(req).map((i) => [i.n, i.text]),
      [
        [1, 'budget iam fin oct'],
        [2, 'vendor quote sso'],
      ],
    );
    assert.equal(req.model, 'gemma4:12b');
    assert.equal(req.numCtx, 16384);
    assert.equal(req.temperature, 0.2);
    assert.equal(req.seed, 7);
    // 90 per line, plus one and a half times what the line itself holds.
    assert.equal(req.numPredict, 197);
    // Never for good: nothing would unload a model whose last request asked for that.
    assert.equal(req.keepAlive, '30m');
    assert.ok(req.messages[1].content.includes('<meeting>1:1 Camille Roy</meeting>'));
    assert.deepEqual(t.scheduler.calls, [{ model: 'gemma4:12b', priority: 'interactive', key: 'enhance' }]);

    assert.deepEqual(
      t.engine.items().map((i) => i.bullet),
      ['**Note:** budget iam fin oct (call 1)', '**Note:** vendor quote sso (call 1)'],
    );
    assert.deepEqual(t.statuses(), ['idle', 'evaluating', 'structuring', 'up-to-date']);
    assert.equal(t.usages.length, 1);
    assert.equal(t.last().error, null);
  });

  it('sends only the lines that changed', async () => {
    const t = setup();
    t.engine.setItems(section('line a', 'line b'));
    await t.engine.runNow();

    t.engine.setItems(section('line a', 'line b', 'line c'));
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 2);
    assert.deepEqual(
      sent(t.llm.requests[1]).map((i) => [i.n, i.text]),
      [[1, 'line c']],
    );
    assert.equal(t.llm.requests[1].numPredict, 93);

    // Nothing changed: no call at all.
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 2);
    assert.equal(t.last().status, 'up-to-date');

    assert.deepEqual(
      t.engine.items().map((i) => i.bullet),
      ['**Note:** line a (call 1)', '**Note:** line b (call 1)', '**Note:** line c (call 2)'],
    );
  });

  it('uses the concise token budget and rewrites bullets when the style changes', async () => {
    const t = setup({ style: 'concise' });
    t.engine.setItems(section('line a', 'line b', 'line c'));
    await t.engine.runNow();
    assert.equal(t.llm.requests[0].numPredict, 126);
    assert.match(t.llm.requests[0].messages[0].content, /at most 12 words/);

    t.settings.style = 'standard';
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 2);
    // A bullet in the other style is not offered as something to keep.
    assert.deepEqual(
      sent(t.llm.requests[1]).map((i) => i.previous),
      [null, null, null],
    );
    assert.match(t.llm.requests[1].messages[0].content, /20 to 35 words/);
  });

  it('gives a long line room in proportion, up to the cap', async () => {
    const t = setup();
    const long = 'x'.repeat(660);
    t.engine.setItems(section(long));
    await t.engine.runNow();
    // 660 characters are 200 estimated tokens: 90 + 300.
    assert.equal(t.llm.requests[0].numPredict, 390);

    const huge = setup();
    huge.engine.setItems(section(...Array.from({ length: 8 }, (_unused, i) => `${i} ${'y'.repeat(1500)}`)));
    await huge.engine.runNow();
    assert.equal(huge.llm.requests[0].numPredict, 2000);
  });

  it('does not save the line an answer was cut in, and sends it again with twice the room', async () => {
    const t = setup();
    t.engine.setItems(section('vendor freeze starts Dec 15', 'Jane absente lundi'));
    t.llm.script.push({
      pieces: ['1. **Freeze:** The vendor freeze starts Dec 15.\n2. **Absence:** Jane est absente lun'],
      doneReason: 'length',
    });
    await t.engine.runNow();

    assert.equal(t.llm.requests.length, 2);
    assert.deepEqual(
      sent(t.llm.requests[1]).map((i) => i.text),
      ['Jane absente lundi'],
    );
    // 90 + 9 for the line, twice.
    assert.equal(t.llm.requests[1].numPredict, 198);
    const [first, second] = t.engine.items();
    assert.equal(first.bullet, '**Freeze:** The vendor freeze starts Dec 15.');
    assert.match(second.bullet ?? '', /Jane absente lundi \(call 2\)/);
    assert.equal(t.engine.markdown().includes('absente lun\n'), false);
  });

  it('shows the line as written when its answer is cut twice', async () => {
    const t = setup();
    t.engine.setItems(section('Jane absente lundi'));
    const cut = { pieces: ['1. **Absence:** Jane est absente lun'], doneReason: 'length' };
    t.llm.script.push(cut, cut);
    await t.engine.runNow();

    assert.equal(t.llm.requests.length, 2);
    assert.equal(t.engine.items()[0].bullet, 'Jane absente lundi');
    assert.equal(t.engine.settled(), true);
  });

  it('batches above 8 lines', async () => {
    const t = setup();
    const lines = Array.from({ length: 19 }, (_unused, i) => `line number ${i + 1}`);
    t.engine.setItems(section(...lines));
    await t.engine.runNow();

    assert.deepEqual(
      t.llm.requests.map((r) => sent(r).length),
      [8, 8, 3],
    );
    assert.deepEqual(
      sent(t.llm.requests[1]).map((i) => i.n),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(sent(t.llm.requests[2])[0].text, 'line number 17');
    assert.deepEqual(
      t.llm.requests.map((r) => r.numPredict),
      [768, 782, 294],
    );
    assert.equal(t.scheduler.calls.length, 3);
    assert.equal(t.usages.length, 3);
    assert.ok(t.engine.items().every((i) => i.bullet !== null));
    assert.equal(t.engine.settled(), true);
  });

  it('never sends topics and passes them through to markdown()', async () => {
    const t = setup();
    t.engine.setItems(section('#### Budget', 'line a', '#### Risks', 'line b'));
    await t.engine.runNow();

    assert.deepEqual(
      sent(t.llm.requests[0]).map((i) => i.text),
      ['line a', 'line b'],
    );
    assert.equal(
      t.engine.markdown(),
      ['#### Budget', '- **Note:** line a (call 1)', '', '#### Risks', '- **Note:** line b (call 1)'].join('\n'),
    );
    const topic = t.engine.items()[0];
    assert.equal(topic.kind, 'topic');
    assert.equal(topic.bullet, null);
    assert.equal(topic.source, 'Budget');
  });

  it('leaves a line without a bullet out of markdown() and cleans what it writes', async () => {
    const t = setup();
    t.engine.setItems(section('suivi Camille IAM'));
    t.llm.script.push('1. - **Suivi :** voir [[Camille Roy|Camille]] pour le [[IAM]]');
    await t.engine.runNow();
    t.engine.setItems(section('suivi Camille IAM', 'not enhanced yet'));

    assert.equal(t.engine.markdown(), '- **Suivi :** voir Camille pour le IAM');
    assert.equal(t.engine.items()[1].bullet, null);
  });
});

describe('EnhanceEngine: continuity', () => {
  it('carries the old bullet to an edited line and sends it as previous', async () => {
    const t = setup();
    t.engine.setItems(section('line a', 'line b'));
    await t.engine.runNow();
    const oldBullet = t.engine.items()[1].bullet;

    t.engine.setItems(section('line a', 'line b with more detail'));
    const edited = t.engine.items()[1];
    assert.equal(edited.source, 'line b with more detail');
    assert.equal(edited.bullet, oldBullet);
    assert.equal(edited.stale, true);
    assert.equal(t.engine.items()[0].stale, false);
    assert.equal(t.engine.settled(), false);
    assert.equal(t.last().status, 'idle');

    await t.engine.runNow();
    assert.deepEqual(sent(t.llm.requests[1]), [
      { n: 1, excerpts: 'none', text: 'line b with more detail', previous: oldBullet },
    ]);
    const after = t.engine.items()[1];
    assert.equal(after.bullet, '**Note:** line b with more detail (call 2)');
    assert.equal(after.stale, false);
    assert.equal(t.engine.settled(), true);
  });

  it('keeps the bullet through every keystroke of an edit', async () => {
    const t = setup();
    t.engine.setItems(section('line a'));
    await t.engine.runNow();
    const oldBullet = t.engine.items()[0].bullet;

    for (const text of ['line a!', 'line a!!', 'line a!!!']) t.engine.setItems(section(text));
    assert.equal(t.engine.items()[0].bullet, oldBullet);
    assert.equal(t.engine.items()[0].stale, true);
  });

  it('does not treat a line inserted above as an edit', async () => {
    const t = setup();
    t.engine.setItems(section('line a', 'line b'));
    await t.engine.runNow();

    t.engine.setItems(section('new first line', 'line a', 'line b'));
    const items = t.engine.items();
    assert.equal(items[0].bullet, null);
    assert.equal(items[0].stale, false);
    assert.equal(items[1].bullet, '**Note:** line a (call 1)');
    assert.equal(items[1].stale, false);
    assert.equal(items[2].bullet, '**Note:** line b (call 1)');

    await t.engine.runNow();
    assert.deepEqual(sent(t.llm.requests[1]), [{ n: 1, excerpts: 'none', text: 'new first line', previous: null }]);
  });

  it('drops the bullet of a deleted line and keeps the others', async () => {
    const t = setup();
    t.engine.setItems(section('line a', 'line b', 'line c'));
    await t.engine.runNow();
    t.engine.setItems(section('line a', 'line c'));
    assert.deepEqual(
      t.engine.items().map((i) => [i.bullet, i.stale]),
      [
        ['**Note:** line a (call 1)', false],
        ['**Note:** line c (call 1)', false],
      ],
    );
    assert.equal(t.last().status, 'up-to-date');
  });

  it('reports nothing when the same lines are set again', async () => {
    const t = setup();
    t.engine.setItems(section('line a'));
    const before = t.states.length;
    t.engine.setItems(section('line a'));
    assert.equal(t.states.length, before);
  });
});

describe('EnhanceEngine: live scheduling', () => {
  it('waits for the debounce after the last change', async () => {
    const t = setup();
    t.engine.setLive(true);
    t.engine.setItems(section('line a'));
    t.clock.advance(2000);
    t.engine.setItems(section('line a', 'line b'));
    t.clock.advance(2499);
    await settle();
    assert.equal(t.llm.requests.length, 0);

    t.clock.advance(1);
    await settle();
    assert.equal(t.llm.requests.length, 1);
    assert.equal(sent(t.llm.requests[0]).length, 2);
    assert.equal(t.llm.requests[0].model, 'gemma4:live');
    assert.deepEqual(t.scheduler.calls, [{ model: 'gemma4:live', priority: 'live', key: 'enhance' }]);
    assert.equal(t.last().status, 'up-to-date');
    assert.equal(t.clock.pending(), 0);
  });

  it('runs at the maximum wait when the typing never pauses', async () => {
    const t = setup();
    t.engine.setLive(true);
    let text = 'typing';
    t.engine.setItems(section(text));
    for (let elapsed = 2000; elapsed < 8000; elapsed += 2000) {
      t.clock.advance(2000);
      await settle();
      assert.equal(t.llm.requests.length, 0, `no run at ${elapsed} ms`);
      text += ' more';
      t.engine.setItems(section(text));
    }
    // Last change at 6000 ms: the debounce alone would wait until 8500.
    t.clock.advance(1999);
    await settle();
    assert.equal(t.llm.requests.length, 0);
    t.clock.advance(1);
    await settle();
    assert.equal(t.llm.requests.length, 1);
    assert.equal(sent(t.llm.requests[0])[0].text, 'typing more more more');
  });

  it('falls back to the main model when no live model is set', async () => {
    const t = setup({ liveModel: '' });
    t.engine.setLive(true);
    t.engine.setItems(section('line a'));
    t.clock.advance(2500);
    await settle();
    assert.equal(t.llm.requests[0].model, 'gemma4:12b');
  });

  it('does nothing on its own when live is off', async () => {
    const t = setup();
    t.engine.setItems(section('line a'));
    t.clock.advance(60_000);
    await settle();
    assert.equal(t.llm.requests.length, 0);
    assert.equal(t.clock.pending(), 0);
  });

  it('cancels the timer when live is turned off, and picks pending lines up when turned on', async () => {
    const t = setup();
    t.engine.setLive(true);
    t.engine.setItems(section('line a'));
    t.engine.setLive(false);
    t.clock.advance(10_000);
    await settle();
    assert.equal(t.llm.requests.length, 0);

    t.engine.setLive(true);
    t.clock.advance(2500);
    await settle();
    assert.equal(t.llm.requests.length, 1);
  });

  it('turning live off leaves a running interactive run alone', async () => {
    const t = setup();
    const held = gate();
    t.engine.setLive(true);
    t.engine.setItems(section('line a'));
    t.llm.script.push((req) => ({ pieces: [t.llm.answerAll(req)], hold: held.promise }));
    const done = t.engine.runNow();
    await settle();
    assert.equal(t.clock.pending(), 0, 'the button run replaces the pending live run');

    t.engine.setLive(false);
    held.open();
    await done;
    assert.equal(t.engine.items()[0].bullet, '**Note:** line a (call 1)');
    assert.equal(t.last().status, 'up-to-date');
  });

  it('lets a live call finish when its lines are untouched, then takes the new line', async () => {
    const t = setup();
    const held = gate();
    t.engine.setLive(true);
    t.engine.setItems(section('line a'));
    t.llm.script.push((req) => ({ pieces: [t.llm.answerAll(req)], hold: held.promise }));
    t.clock.advance(2500);
    await settle();
    assert.equal(t.scheduler.inFlight(), 1);

    t.engine.setItems(section('line a', 'line b'));
    t.clock.advance(2500);
    await settle();
    assert.equal(t.llm.requests.length, 1, 'the call in flight is not thrown away');

    held.open();
    await settle();
    assert.equal(t.llm.requests.length, 2);
    assert.deepEqual(
      sent(t.llm.requests[1]).map((i) => i.text),
      ['line b'],
    );
    assert.deepEqual(
      t.engine.items().map((i) => i.bullet),
      ['**Note:** line a (call 1)', '**Note:** line b (call 2)'],
    );
    assert.equal(t.last().status, 'up-to-date');
  });

  it('drops a live call whose line was edited meanwhile', async () => {
    const t = setup();
    const held = gate();
    t.engine.setLive(true);
    t.engine.setItems(section('line a'));
    t.llm.script.push((req) => ({ pieces: [t.llm.answerAll(req)], hold: held.promise }));
    t.clock.advance(2500);
    await settle();

    t.engine.setItems(section('line a, edited'));
    t.clock.advance(2500);
    await settle();
    assert.equal(t.llm.requests.length, 2);
    assert.deepEqual(
      sent(t.llm.requests[1]).map((i) => i.text),
      ['line a, edited'],
    );
    assert.deepEqual(
      t.engine.items().map((i) => i.bullet),
      ['**Note:** line a, edited (call 2)'],
    );
    assert.equal(t.last().status, 'up-to-date');
    assert.equal(t.last().error, null);
    assert.equal(t.usages.length, 1, 'the dropped call reports no usage');
  });

  it('gives way to the Enhance button', async () => {
    const t = setup();
    const held = gate();
    t.engine.setLive(true);
    t.engine.setItems(section('line a'));
    t.llm.script.push((req) => ({ pieces: [t.llm.answerAll(req)], hold: held.promise }));
    t.clock.advance(2500);
    await settle();

    await t.engine.runNow();
    assert.deepEqual(
      t.scheduler.calls.map((c) => c.priority),
      ['live', 'interactive'],
    );
    assert.equal(t.engine.items()[0].bullet, '**Note:** line a (call 2)');
    assert.equal(t.last().status, 'up-to-date');
  });
});

describe('EnhanceEngine: aborts and errors', () => {
  it('treats an abort as a pause and schedules again', async () => {
    const t = setup();
    const held = gate();
    t.engine.setLive(true);
    t.engine.setItems(section('line a'));
    t.llm.script.push({ pieces: ['1. **Note:** half a bul'], hold: held.promise });
    t.clock.advance(2500);
    await settle();
    assert.equal(t.last().status, 'structuring');
    assert.equal(t.engine.items()[0].streaming, true);
    assert.equal(t.engine.items()[0].bullet, '**Note:** half a bul');

    // The queue takes the model away for a question or a summary.
    t.scheduler.abortRunning();
    await settle();
    assert.equal(t.last().status, 'idle');
    assert.equal(t.last().error, null);
    assert.equal(t.engine.items()[0].bullet, null, 'half a bullet is not kept');
    assert.equal(t.engine.items()[0].streaming, false);
    assert.equal(t.clock.pending(), 1, 'a new run is scheduled');

    t.clock.advance(2500);
    await settle();
    assert.equal(t.llm.requests.length, 2);
    assert.equal(t.engine.items()[0].bullet, '**Note:** line a (call 2)');
    assert.equal(t.last().status, 'up-to-date');
  });

  it('does not schedule again after an abort when live is off', async () => {
    const t = setup();
    const held = gate();
    t.engine.setItems(section('line a'));
    t.llm.script.push({ pieces: [], hold: held.promise });
    const done = t.engine.runNow();
    await settle();
    t.scheduler.cancelAll();
    await done;
    assert.equal(t.last().status, 'idle');
    assert.equal(t.last().error, null);
    assert.equal(t.clock.pending(), 0);
  });

  it('reports a missing model by name, keeps old bullets, and works again afterwards', async () => {
    const t = setup();
    t.engine.setItems(section('line a', 'line b'));
    await t.engine.runNow();
    const oldBullet = t.engine.items()[1].bullet;

    t.engine.setItems(section('line a', 'line b, edited'));
    t.llm.script.push(fail('model_missing', { model: 'gemma4:12b', status: 404 }));
    await t.engine.runNow();
    assert.equal(t.last().status, 'error');
    assert.equal(t.last().error, 'Model gemma4:12b is not installed');
    assert.equal(t.engine.items()[0].bullet, '**Note:** line a (call 1)');
    assert.equal(t.engine.items()[1].bullet, oldBullet);
    assert.equal(t.engine.items()[1].stale, true);
    assert.equal(t.engine.items()[1].streaming, false);
    assert.equal(t.usages.length, 1);

    await t.engine.runNow();
    assert.equal(t.last().status, 'up-to-date');
    assert.equal(t.last().error, null);
    assert.equal(t.engine.items()[1].bullet, '**Note:** line b, edited (call 3)');
    assert.equal(t.engine.items()[1].stale, false);
  });

  it('names the model of the request when the error does not', async () => {
    const t = setup();
    t.engine.setLive(true);
    t.engine.setItems(section('line a'));
    t.llm.script.push(fail('model_missing'));
    t.clock.advance(2500);
    await settle();
    assert.equal(t.last().error, 'Model gemma4:live is not installed');
    assert.equal(t.clock.pending(), 0, 'a failed run is not retried on a timer');
  });

  it('maps the other error kinds to short messages', async () => {
    const cases: Array<[Error, string]> = [
      [fail('unreachable'), 'Ollama is not running'],
      [fail('busy'), 'Ollama is busy, try again in a moment'],
      [fail('stalled'), 'The model stopped responding'],
      [Object.assign(new Error('HTTP 500: boom'), { kind: 'http' }), 'Enhance failed: HTTP 500: boom'],
      [new Error('something odd'), 'Enhance failed: something odd'],
    ];
    for (const [error, message] of cases) {
      const t = setup();
      t.engine.setItems(section('line a'));
      t.llm.script.push(error);
      await t.engine.runNow();
      assert.equal(t.last().status, 'error');
      assert.equal(t.last().error, message);
    }
  });

  it('never rejects from runNow', async () => {
    const t = setup();
    t.engine.setItems(section('line a'));
    t.llm.script.push(new Error('boom'));
    await assert.doesNotReject(t.engine.runNow());
  });
});

describe('EnhanceEngine: skipped lines', () => {
  it('asks again for a skipped line, then falls back to the shorthand', async () => {
    const t = setup();
    t.engine.setItems(section('first only', 'voir  [[Camille Roy|Camille]] pour le budget'));
    t.llm.script.push('1. **Note:** first only', 'Sorry, nothing to add.');
    await t.engine.runNow();

    assert.equal(t.llm.requests.length, 2);
    assert.deepEqual(
      sent(t.llm.requests[1]).map((i) => i.text),
      ['voir [[Camille Roy|Camille]] pour le budget'],
    );
    assert.deepEqual(
      t.engine.items().map((i) => i.bullet),
      ['**Note:** first only', 'voir Camille pour le budget'],
    );
    assert.equal(t.engine.settled(), true);
    assert.equal(t.last().status, 'up-to-date');
    assert.equal(t.engine.markdown(), '- **Note:** first only\n- voir Camille pour le budget');

    // The fallback counts as done: nothing more is sent.
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 2);
  });

  it('keeps the previous bullet while a skipped line waits', async () => {
    const t = setup();
    const held = gate();
    t.engine.setItems(section('line a'));
    await t.engine.runNow();
    const oldBullet = t.engine.items()[0].bullet;

    t.engine.setItems(section('line a, edited'));
    t.llm.script.push('', { pieces: [], hold: held.promise });
    const done = t.engine.runNow();
    await settle();
    // First skip behind us, second call in flight: the old bullet is still shown.
    assert.equal(t.llm.requests.length, 3);
    assert.equal(t.engine.items()[0].bullet, oldBullet);
    assert.equal(t.engine.items()[0].stale, true);

    held.open();
    await done;
    assert.equal(t.engine.items()[0].bullet, 'line a, edited');
    assert.equal(t.engine.items()[0].stale, false);
  });

  it('accepts unnumbered answers when there is one labelled line per item', async () => {
    const t = setup();
    t.engine.setItems(section('budget fin octobre'));
    t.llm.script.push('**Budget:** Le budget est visé pour la fin octobre.');
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 1);
    assert.equal(t.engine.items()[0].bullet, '**Budget:** Le budget est visé pour la fin octobre.');

    t.engine.setItems(section('budget fin octobre', 'b two', 'c three'));
    t.llm.script.push('- **B:** two\n- **C:** three');
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 2);
    assert.deepEqual(
      t.engine.items().map((i) => i.bullet),
      ['**Budget:** Le budget est visé pour la fin octobre.', '**B:** two', '**C:** three'],
    );
  });

  it('does not take an unnumbered remark for a bullet', async () => {
    const t = setup();
    t.engine.setItems(section('line a', 'line b'));
    // One labelled line for two items: which item it answers is anyone's guess.
    t.llm.script.push('**Note:** only one line', 'I cannot help with that.\nSorry.');
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 2);
    assert.deepEqual(
      t.engine.items().map((i) => i.bullet),
      ['line a', 'line b'],
    );
  });

  it('does not keep a bullet that is about something else, and asks again without its excerpts', async () => {
    const t = setup({}, { retrieve: async () => [excerpt('E3', 0.71, 'the north parking lot closes next week')] });
    t.engine.setItems(section('rappeler garderie pour jeudi'));
    t.llm.script.push(
      '1. **rappeler garderie pour jeudi:** Le stationnement du pavillon nord sera fermé la semaine prochaine.',
      '1. **Garderie:** Rappeler la garderie pour jeudi.',
    );
    await t.engine.runNow();

    assert.equal(t.llm.requests.length, 2);
    assert.equal(sent(t.llm.requests[0])[0].excerpts, 'E3');
    assert.equal(sent(t.llm.requests[1])[0].excerpts, 'none', 'the excerpt that took the line over is not sent again');
    assert.equal(t.engine.items()[0].bullet, '**Garderie:** Rappeler la garderie pour jeudi.');
  });

  it('does not keep a bullet that lost the day the line gives', async () => {
    const t = setup();
    t.engine.setItems(section('hiring: coordinator posting by Thu'));
    t.llm.script.push('1. **Hiring:** The coordinator posting must be out by Friday.', '1. **Hiring:** The coordinator posting is due by Thursday.');
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 2);
    assert.equal(t.engine.items()[0].bullet, '**Hiring:** The coordinator posting is due by Thursday.');
  });

  it('keeps the bullet of an unchanged line when a change of style gets no answer', async () => {
    const t = setup();
    t.engine.setItems(section('budget fin octobre'));
    t.llm.script.push('1. **Budget:** Le budget est visé pour la fin octobre.');
    await t.engine.runNow();
    t.settings.style = 'concise';
    t.llm.script.push('Sorry.', 'Sorry.');
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 3);
    assert.equal(t.engine.items()[0].bullet, '**Budget:** Le budget est visé pour la fin octobre.');
    assert.equal(t.engine.settled(), true);
  });

  it('takes a line that was skipped once when the second call answers it', async () => {
    const t = setup();
    t.engine.setItems(section('line a', 'second only'));
    t.llm.script.push('2. **Note:** second only');
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 2);
    assert.deepEqual(
      t.engine.items().map((i) => i.bullet),
      ['**Note:** line a (call 2)', '**Note:** second only'],
    );
  });
});

describe('EnhanceEngine: retrieval', () => {
  it('attaches excerpts per line and reports the retrieving step', async () => {
    const asked: string[] = [];
    const t = setup(
      {},
      {
        retrieve: async (text) => {
          asked.push(text);
          return text === 'line a' ? [excerpt('E2', 0.8), excerpt('E1', 0.6)] : [excerpt('E2', 0.7)];
        },
        glossary: () => ['IAM'],
      },
    );
    t.engine.setItems(section('#### Topic', 'line a', 'line b'));
    await t.engine.runNow();

    assert.deepEqual(asked.sort(), ['line a', 'line b']);
    const user = t.llm.requests[0].messages[1].content;
    // Shared excerpt once, in chronological order.
    assert.ok(user.includes('<excerpts>\n[E1 01:00] what was said in E1\n[E2 02:00] what was said in E2\n</excerpts>'));
    assert.deepEqual(
      sent(t.llm.requests[0]).map((i) => i.excerpts),
      ['E2 E1', 'E2'],
    );
    assert.ok(user.includes('<spellings>IAM</spellings>'));
    assert.deepEqual(t.engine.items()[1].excerptIds, ['E2', 'E1']);
    assert.deepEqual(t.engine.items()[2].excerptIds, ['E2']);
    assert.deepEqual(t.statuses(), ['idle', 'evaluating', 'retrieving', 'structuring', 'up-to-date']);
  });

  it('carries on without excerpts when retrieval fails', async () => {
    const t = setup(
      {},
      {
        retrieve: async (text) => {
          if (text === 'line a') throw new Error('embedding model not loaded');
          return [excerpt('E4')];
        },
      },
    );
    t.engine.setItems(section('line a', 'line b'));
    await t.engine.runNow();

    assert.deepEqual(
      sent(t.llm.requests[0]).map((i) => i.excerpts),
      ['none', 'E4'],
    );
    assert.equal(t.last().status, 'up-to-date');
    assert.equal(t.last().error, null);
    assert.ok(t.engine.items().every((i) => i.bullet !== null));
  });

  it('keeps the three best excerpts per line, whatever order they come in', async () => {
    const t = setup(
      {},
      { retrieve: async () => [excerpt('E2', 0.6), excerpt('E5', 0.9), excerpt('E3', 0.7), excerpt('E1', 0.8)] },
    );
    t.engine.setItems(section('line a'));
    await t.engine.runNow();
    assert.equal(sent(t.llm.requests[0])[0].excerpts, 'E5 E1 E3');
  });

  it('takes up a line edited while its excerpts were being fetched', async () => {
    const waiting: Array<() => void> = [];
    const t = setup(
      {},
      {
        retrieve: (text) =>
          text === 'line a'
            ? new Promise<Excerpt[]>((resolve) => waiting.push(() => resolve([excerpt('E1')])))
            : Promise.resolve([excerpt('E2')]),
      },
    );
    t.engine.setItems(section('line a'));
    const done = t.engine.runNow();
    await settle();
    assert.equal(t.last().status, 'retrieving');

    t.engine.setItems(section('line a, edited'));
    waiting[0]();
    await done;
    assert.equal(t.llm.requests.length, 1);
    assert.deepEqual(sent(t.llm.requests[0]), [{ n: 1, excerpts: 'E2', text: 'line a, edited', previous: null }]);
    assert.equal(t.last().status, 'up-to-date');
    assert.equal(t.engine.settled(), true);
  });

  it('trims excerpts to what the context can hold, weakest first', async () => {
    const long = 'mot '.repeat(600);
    const t = setup(
      { numCtx: 2400 },
      {
        retrieve: async (text) =>
          text === 'line a'
            ? [excerpt('E1', 0.9, long), excerpt('E2', 0.5, long)]
            : [excerpt('E3', 0.4, long), excerpt('E2', 0.3, long)],
      },
    );
    t.engine.setItems(section('line a', 'line b'));
    await t.engine.runNow();
    // Room for one excerpt only: each line gives up its second one, then the weaker line its last.
    assert.deepEqual(
      sent(t.llm.requests[0]).map((i) => i.excerpts),
      ['E1', 'none'],
    );
  });

  it('re-checks after new transcript and re-runs only lines that gain an excerpt', async () => {
    let chunks = 1;
    const t = setup(
      {},
      {
        retrieve: async (text) => {
          const all = [excerpt('E1')];
          if (chunks >= 2 && text === 'line a') all.unshift(excerpt('E2', 0.9));
          return all;
        },
      },
    );
    t.engine.setItems(section('line a', 'line b'));
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 1);

    // Transcript advanced, but retrieval offers nothing new.
    t.engine.transcriptAdvanced();
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 1);
    assert.equal(t.last().status, 'up-to-date');

    chunks = 2;
    // Without the signal that transcript arrived, nothing is searched again.
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 1);

    t.engine.transcriptAdvanced();
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 2);
    assert.deepEqual(sent(t.llm.requests[1]), [
      { n: 1, excerpts: 'E2 E1', text: 'line a', previous: '**Note:** line a (call 1)' },
    ]);
    assert.deepEqual(t.engine.items()[0].excerptIds, ['E2', 'E1']);
    assert.equal(t.engine.items()[0].bullet, '**Note:** line a (call 2)');

    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 2);
  });

  it('keeps a good bullet when the model skips its refresh twice', async () => {
    let chunks = 1;
    const t = setup({}, { retrieve: async () => (chunks >= 2 ? [excerpt('E2'), excerpt('E1')] : [excerpt('E1')]) });
    t.engine.setItems(section('line a'));
    await t.engine.runNow();

    chunks = 2;
    t.engine.transcriptAdvanced();
    t.llm.script.push('', '');
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 3);
    assert.equal(t.engine.items()[0].bullet, '**Note:** line a (call 1)');
    assert.equal(t.last().status, 'up-to-date');

    // The excerpt has been dealt with: it does not trigger a run every time.
    t.engine.transcriptAdvanced();
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 3);
  });

  it('does not run a line again for a new excerpt ranked below the ones it uses', async () => {
    let chunks = 4;
    const t = setup(
      {},
      {
        retrieve: async () => {
          const all = [excerpt('E1', 0.9), excerpt('E2', 0.8), excerpt('E3', 0.7), excerpt('E4', 0.6)];
          if (chunks >= 5) all.push(excerpt('E5', 0.3));
          if (chunks >= 6) all.unshift(excerpt('E6', 0.95));
          return all;
        },
      },
    );
    t.engine.setItems(section('line a'));
    await t.engine.runNow();
    assert.equal(sent(t.llm.requests[0])[0].excerpts, 'E1 E2 E3');

    // E5 would not be in the prompt: a call for it would repeat the last one.
    chunks = 5;
    t.engine.transcriptAdvanced();
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 1);
    assert.equal(t.last().status, 'up-to-date');

    // E6 takes a place among the three: that is worth a call.
    chunks = 6;
    t.engine.transcriptAdvanced();
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 2);
    assert.equal(sent(t.llm.requests[1])[0].excerpts, 'E6 E1 E2');
  });

  it('applies transcript that arrives while a line is first being written', async () => {
    let chunks = 1;
    const held = gate();
    const t = setup({}, { retrieve: async () => (chunks >= 2 ? [excerpt('E2', 0.9), excerpt('E1')] : [excerpt('E1')]) });
    t.engine.setItems(section('line a'));
    t.llm.script.push((req) => ({ pieces: [t.llm.answerAll(req)], hold: held.promise }));
    const done = t.engine.runNow();
    await settle();
    assert.equal(sent(t.llm.requests[0])[0].excerpts, 'E1');

    // The last chunk of the recording lands during the call: nothing else will announce it.
    chunks = 2;
    t.engine.transcriptAdvanced();
    held.open();
    await done;

    assert.equal(t.llm.requests.length, 2);
    assert.deepEqual(sent(t.llm.requests[1]), [
      { n: 1, excerpts: 'E2 E1', text: 'line a', previous: '**Note:** line a (call 1)' },
    ]);
    assert.deepEqual(t.engine.items()[0].excerptIds, ['E2', 'E1']);
    assert.equal(t.last().status, 'up-to-date');
  });

  it('searches again when transcript arrives while it is searching', async () => {
    let offered = [excerpt('E1')];
    let hold = false;
    const waiting: Array<() => void> = [];
    const t = setup(
      {},
      {
        retrieve: (): Promise<Excerpt[]> => {
          const found = offered;
          if (!hold) return Promise.resolve(found);
          return new Promise<Excerpt[]>((resolve) => waiting.push(() => resolve(found)));
        },
      },
    );
    t.engine.setItems(section('line a'));
    await t.engine.runNow();

    // A chunk with nothing for this line starts a re-check...
    t.engine.transcriptAdvanced();
    hold = true;
    const done = t.engine.runNow();
    await settle();
    assert.equal(t.last().status, 'retrieving');

    // ...and the chunk that matters lands before the search has answered.
    offered = [excerpt('E3', 0.9), excerpt('E1')];
    t.engine.transcriptAdvanced();
    hold = false;
    waiting[0]();
    await done;

    assert.equal(t.llm.requests.length, 2);
    assert.equal(sent(t.llm.requests[1])[0].excerpts, 'E3 E1');
    assert.deepEqual(t.engine.items()[0].excerptIds, ['E3', 'E1']);
    assert.equal(t.last().status, 'up-to-date');

    // Answered: nothing is left to ask.
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 2);
  });

  it('searches again for the lines of a later batch when transcript arrives mid-run', async () => {
    let chunks = 1;
    const held = gate();
    const t = setup(
      {},
      {
        retrieve: async (text) =>
          chunks >= 2 && text === 'line 9' ? [excerpt('E2', 0.9), excerpt('E1')] : [excerpt('E1')],
      },
    );
    t.engine.setItems(section(...Array.from({ length: 9 }, (_unused, i) => `line ${i + 1}`)));
    t.llm.script.push((req) => ({ pieces: [t.llm.answerAll(req)], hold: held.promise }));
    const done = t.engine.runNow();
    await settle();
    assert.equal(t.llm.requests.length, 1);

    chunks = 2;
    t.engine.transcriptAdvanced();
    held.open();
    await done;

    // The second batch went out with what was found before the chunk: one more call brings it in.
    assert.deepEqual(t.engine.items()[8].excerptIds, ['E2', 'E1']);
    const last = t.llm.requests[t.llm.requests.length - 1];
    assert.deepEqual(
      sent(last).map((i) => [i.text, i.excerpts]),
      [['line 9', 'E2 E1']],
    );
    assert.equal(t.llm.requests.length, 3);
    assert.equal(t.last().status, 'up-to-date');
  });

  it('the Enhance button does not lose the refresh it interrupts', async () => {
    let chunks = 1;
    const held = gate();
    const t = setup({}, { retrieve: async () => (chunks >= 2 ? [excerpt('E2', 0.9), excerpt('E1')] : [excerpt('E1')]) });
    t.engine.setLive(true);
    t.engine.setItems(section('line a'));
    t.clock.advance(2500);
    await settle();
    assert.equal(t.llm.requests.length, 1);

    chunks = 2;
    t.engine.transcriptAdvanced();
    t.llm.script.push({ pieces: [], hold: held.promise });
    t.clock.advance(2500);
    await settle();
    assert.equal(t.llm.requests.length, 2, 'the live refresh is at the model');

    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 3);
    assert.equal(sent(t.llm.requests[2])[0].excerpts, 'E2 E1');
    assert.deepEqual(t.engine.items()[0].excerptIds, ['E2', 'E1']);
    assert.equal(t.engine.items()[0].bullet, '**Note:** line a (call 3)');
    assert.equal(t.last().status, 'up-to-date');
  });

  it('schedules a live run when transcript arrives', async () => {
    let chunks = 1;
    const t = setup({}, { retrieve: async () => (chunks >= 2 ? [excerpt('E2'), excerpt('E1')] : [excerpt('E1')]) });
    t.engine.setLive(true);
    t.engine.setItems(section('line a'));
    t.clock.advance(2500);
    await settle();
    assert.equal(t.llm.requests.length, 1);
    assert.equal(t.clock.pending(), 0);

    chunks = 2;
    t.engine.transcriptAdvanced();
    assert.equal(t.clock.pending(), 1);
    t.clock.advance(2500);
    await settle();
    assert.equal(t.llm.requests.length, 2);
    assert.equal(sent(t.llm.requests[1])[0].excerpts, 'E2 E1');
    assert.equal(t.engine.settled(), true);
  });

  it('ignores transcript arriving when there is no retrieval', async () => {
    const t = setup();
    t.engine.setLive(true);
    t.engine.setItems(section('line a'));
    t.clock.advance(2500);
    await settle();
    t.engine.transcriptAdvanced();
    assert.equal(t.clock.pending(), 0);
  });
});

describe('EnhanceEngine: streaming', () => {
  it('shows partial bullets at most every 250 ms and never saves them', async () => {
    const t = setup();
    const seen: Array<string | null> = [];
    t.engine.setItems(section('budget visé', 'SSO quote Friday'));
    t.llm.script.push({
      pieces: ['1. **Bud', 'get:** Le budget', ' est visé\n2. **SS', 'O:** Quote on Friday'],
      between: (index) => {
        seen.push(t.engine.items()[0].bullet);
        // 100 ms after each of the first two pieces, 300 ms after the third.
        t.clock.advance(index === 2 ? 300 : 100);
        if (index === 2) assert.equal(t.engine.markdown(), '', 'a partial bullet is not content to save');
      },
    });
    await t.engine.runNow();

    assert.deepEqual(seen, [
      '**Bud**',
      // 100 ms and 200 ms later: too soon to show more.
      '**Bud**',
      '**Bud**',
      '**Budget:** Le budget est visé',
    ]);
    const streaming = t.states.filter((s) => s.items.some((i) => i.streaming));
    assert.ok(streaming.length >= 2);
    assert.ok(streaming.every((s) => s.status === 'structuring'));

    assert.deepEqual(
      t.engine.items().map((i) => [i.bullet, i.streaming]),
      [
        ['**Budget:** Le budget est visé', false],
        ['**SSO:** Quote on Friday', false],
      ],
    );
    assert.equal(t.engine.markdown(), '- **Budget:** Le budget est visé\n- **SSO:** Quote on Friday');
  });

  it('marks the lines of the call as streaming before the first token', async () => {
    const t = setup();
    const held = gate();
    t.engine.setItems(section('#### Topic', 'line a'));
    t.llm.script.push({ pieces: [], hold: held.promise });
    const done = t.engine.runNow();
    await settle();
    assert.deepEqual(
      t.engine.items().map((i) => i.streaming),
      [false, true],
    );
    assert.equal(t.engine.settled(), false);
    held.open();
    await done;
  });
});

describe('EnhanceEngine: settled, reset, dispose', () => {
  it('is settled only when every line has an up-to-date bullet', async () => {
    const t = setup();
    assert.equal(t.engine.settled(), true);
    t.engine.setItems(section('#### Topic only'));
    assert.equal(t.engine.settled(), true);
    t.engine.setItems(section('#### Topic only', 'line a'));
    assert.equal(t.engine.settled(), false);
    await t.engine.runNow();
    assert.equal(t.engine.settled(), true);
    t.engine.setItems(section('#### Topic only', 'line a changed'));
    assert.equal(t.engine.settled(), false);
    await t.engine.runNow();
    assert.equal(t.engine.settled(), true);
  });

  it('reports up-to-date for a run with nothing to do', async () => {
    const t = setup();
    await t.engine.runNow();
    assert.equal(t.last().status, 'up-to-date');
    assert.equal(t.llm.requests.length, 0);
  });

  it('joins a second click to the run in progress', async () => {
    const t = setup();
    const held = gate();
    t.engine.setItems(section('line a'));
    t.llm.script.push((req) => ({ pieces: [t.llm.answerAll(req)], hold: held.promise }));
    const first = t.engine.runNow();
    const second = t.engine.runNow();
    assert.equal(first, second);
    held.open();
    await first;
    assert.equal(t.llm.requests.length, 1);
  });

  it('reset clears the items, cancels the work and leaves the engine usable', async () => {
    const t = setup();
    const held = gate();
    t.engine.setLive(true);
    t.engine.setItems(section('line a'));
    t.llm.script.push({ pieces: ['1. **Note:** half'], hold: held.promise });
    const done = t.engine.runNow();
    await settle();

    t.engine.reset();
    assert.deepEqual(t.last(), { items: [], status: 'idle', error: null });
    assert.equal(t.clock.pending(), 0);
    await done;
    await settle();
    assert.deepEqual(t.last(), { items: [], status: 'idle', error: null });
    assert.equal(t.engine.markdown(), '');

    t.engine.setItems(section('line b'));
    await t.engine.runNow();
    assert.equal(t.engine.items()[0].bullet, '**Note:** line b (call 2)');
    assert.equal(t.last().status, 'up-to-date');
  });

  it('ends a cancelled run at once, even while its call waits for the model', async () => {
    const t = setup();
    const busy = gate();
    t.scheduler.waitFor = busy.promise;
    t.engine.setItems(section('line a'));
    let ended = false;
    const done = t.engine.runNow().then(() => {
      ended = true;
    });
    await settle();
    assert.equal(t.scheduler.calls.length, 1);
    assert.equal(ended, false);

    t.engine.reset();
    await settle();
    assert.equal(ended, true, 'the promise of runNow does not wait for the queue');

    // Its turn comes later: the slot goes back without a request.
    busy.open();
    await done;
    await settle();
    assert.equal(t.llm.requests.length, 0);
    assert.equal(t.usages.length, 0);
    assert.deepEqual(t.last(), { items: [], status: 'idle', error: null });
  });

  it('dispose stops every report', async () => {
    const t = setup();
    const held = gate();
    t.engine.setLive(true);
    t.engine.setItems(section('line a'));
    t.llm.script.push({ pieces: ['1. **Note:** half'], hold: held.promise });
    void t.engine.runNow();
    await settle();

    t.engine.dispose();
    const reports = t.states.length;
    held.open();
    await settle();
    t.engine.setItems(section('line b'));
    await t.engine.runNow();
    t.clock.advance(10_000);
    await settle();
    assert.equal(t.states.length, reports);
    assert.equal(t.clock.pending(), 0);
    assert.equal(t.llm.requests.length, 1);
  });
});

describe('EnhanceEngine: lines that changed without typing', () => {
  it('schedules nothing for them, and still shows them', async () => {
    const t = setup();
    t.engine.setLive(true);
    // A meeting is selected, the daily is read again, a sync brings a line: nobody typed.
    t.engine.setItems(section('budget iam', 'vendor quote'), false);
    assert.equal(t.clock.pending(), 0);
    assert.deepEqual(
      t.last().items.map((i) => [i.source, i.bullet]),
      [
        ['budget iam', null],
        ['vendor quote', null],
      ],
    );
    t.clock.advance(20_000);
    await settle();
    assert.equal(t.llm.requests.length, 0);

    // The next keystroke takes every waiting line along.
    t.engine.setItems(section('budget iam', 'vendor quote', 'hiring'), true);
    t.clock.advance(2500);
    await settle();
    assert.equal(t.llm.requests.length, 1);
    assert.equal(sent(t.llm.requests[0]).length, 3);
  });

  it('leaves a run that typing had scheduled where it was', async () => {
    const t = setup();
    t.engine.setLive(true);
    t.engine.setItems(section('budget iam'));
    t.clock.advance(2000);
    t.engine.setItems(section('budget iam', 'synced line'), false);
    t.clock.advance(500);
    await settle();
    assert.equal(t.llm.requests.length, 1, 'not pushed back, not dropped');
    assert.equal(sent(t.llm.requests[0]).length, 2);
  });
});

describe('EnhanceEngine: bullets a note already holds', () => {
  it('takes one bullet per line as theirs: nothing is pending, and a new line is the only one sent', async () => {
    const t = setup();
    t.engine.setLive(true);
    t.engine.setItems(section('budget iam', '#### Risks', 'vendor quote'), false);
    assert.equal(t.engine.seed(['**Budget:** frozen until January', '**Vendor:** quote due Friday']), true);
    assert.deepEqual(
      t.last().items.map((i) => [i.kind, i.bullet, i.stale, i.streaming]),
      [
        ['item', '**Budget:** frozen until January', false, false],
        ['topic', null, false, false],
        ['item', '**Vendor:** quote due Friday', false, false],
      ],
    );
    assert.equal(t.engine.settled(), true);
    assert.equal(t.last().status, 'up-to-date');
    assert.deepEqual(t.engine.bulletIds(), [t.last().items[0].id, t.last().items[2].id]);
    assert.equal(t.engine.markdown(), '- **Budget:** frozen until January\n\n#### Risks\n- **Vendor:** quote due Friday');
    await t.engine.runNow();
    t.clock.advance(20_000);
    await settle();
    assert.equal(t.llm.requests.length, 0);

    t.engine.setItems(section('budget iam', '#### Risks', 'vendor quote', 'hiring'), true);
    t.clock.advance(2500);
    await settle();
    assert.equal(t.llm.requests.length, 1);
    assert.deepEqual(
      sent(t.llm.requests[0]).map((i) => i.text),
      ['hiring'],
    );
    assert.equal(t.last().items[0].bullet, '**Budget:** frozen until January');
  });

  it('hands a seeded bullet back as the previous one when its line is edited', async () => {
    const t = setup();
    t.engine.setItems(section('budget iam'), false);
    t.engine.seed(['**Budget:** frozen until January']);
    t.engine.setItems(section('budget iam, two roles'));
    assert.equal(t.last().items[0].stale, true);
    await t.engine.runNow();
    assert.equal(sent(t.llm.requests[0])[0].previous, '**Budget:** frozen until January');
  });

  it('cancels the run that was waiting for those lines alone', async () => {
    const t = setup();
    t.engine.setLive(true);
    t.engine.setItems(section('budget iam', 'vendor quote'));
    assert.equal(t.clock.pending(), 1);
    assert.equal(t.engine.seed(['**Budget:** a', '**Vendor:** b']), true);
    assert.equal(t.clock.pending(), 0);
  });

  it('refuses them when they are not one per line, when a line has its bullet, or while a run is under way', async () => {
    const t = setup();
    t.engine.setItems(section('budget iam', 'vendor quote'), false);
    assert.equal(t.engine.seed([]), false);
    assert.equal(t.engine.seed(['**Budget:** a']), false);
    assert.equal(t.engine.seed(['**Budget:** a', '**Vendor:** b', '**Hiring:** c']), false);
    assert.deepEqual(
      t.last().items.map((i) => i.bullet),
      [null, null],
    );

    const held = gate();
    t.llm.script.push((req) => ({ pieces: [t.llm.answerAll(req)], hold: held.promise }));
    const running = t.engine.runNow();
    await settle();
    assert.equal(t.engine.seed(['**Budget:** a', '**Vendor:** b']), false, 'a run is writing them');
    held.open();
    await running;
    assert.equal(t.engine.seed(['**Budget:** a', '**Vendor:** b']), false, 'they have their own');
    assert.match(t.last().items[0].bullet ?? '', /call 1/);

    t.engine.dispose();
    assert.equal(t.engine.seed(['**Budget:** a', '**Vendor:** b']), false);
  });
});

describe('EnhanceEngine: bullets a note holds for other lines than these', () => {
  const untouched = (t: ReturnType<typeof setup>): void => {
    assert.ok(t.last().items.every((item) => item.bullet === null), 'no line was given a bullet');
    assert.equal(t.engine.settled(), false);
  };

  it('refuses them when the lines changed places: each bullet would go to another line', async () => {
    const t = setup();
    t.engine.setItems(section('vendor quote', 'budget iam'), false);
    assert.equal(t.engine.seed(['**Budget:** frozen until January', '**Vendor:** quote due Friday']), false);
    untouched(t);
    // Asked for, every line is written: nothing was marked up to date.
    await t.engine.runNow();
    assert.deepEqual(
      sent(t.llm.requests[0]).map((item) => [item.text, item.previous]),
      [
        ['vendor quote', null],
        ['budget iam', null],
      ],
    );
  });

  it('refuses them when a line was replaced by another, the count being the same', () => {
    const t = setup();
    t.engine.setItems(section('hiring: two roles open', 'vendor quote'), false);
    assert.equal(t.engine.seed(['**Budget:** frozen until January', '**Vendor:** quote due Friday']), false);
    untouched(t);
  });

  it('refuses them when a line no longer holds a term its bullet was to keep', () => {
    const month = setup();
    month.engine.setItems(section('vendor contract renewal may slip to Dec'), false);
    assert.equal(month.engine.seed(['**Vendor contract:** The renewal may slip to November.']), false);
    untouched(month);

    const quarter = setup();
    quarter.engine.setItems(section('Q1 roadmap: identity migration first', 'budget 40k approved'), false);
    assert.equal(
      quarter.engine.seed(['**Roadmap:** In Q4 the identity migration goes first.', '**Budget:** 40k approved.']),
      false,
    );
    untouched(quarter);
  });

  it('takes them when each holds the terms of its line, whatever their case, and a term written out in full', () => {
    const t = setup();
    t.engine.setItems(
      section('vendor contract renewal may slip to Nov', 'hiring: PCO backfill, posting by friday', 'budget 40k, go-live 2026-11-03'),
      false,
    );
    assert.equal(
      t.engine.seed([
        '**Vendor contract:** The renewal may slip to November.',
        '**Hiring:** The pco backfill is posted by Friday.',
        '**Budget:** A budget of 40K, with the go-live on 2026-11-03.',
      ]),
      true,
    );
    assert.equal(t.engine.settled(), true);
  });

  it('does not take a term found in the middle of a word for that term', () => {
    const t = setup();
    t.engine.setItems(section('renewal may slip to Nov'), false);
    assert.equal(t.engine.seed(['**Renewal:** An innovation in the renewal process.']), false);
  });

  it('wants a word of four letters or more in common, accents and case aside', () => {
    const accents = setup();
    accents.engine.setItems(section("dépendance sur l'équipe réseau"), false);
    assert.equal(accents.engine.seed(["**Reseau:** La bascule attend l'equipe."]), true);

    // Short words in common are not enough: "the", "to", "is" are in every note.
    const short = setup();
    short.engine.setItems(section('the plan is to wait'), false);
    assert.equal(short.engine.seed(['**Vote:** the vote is due to end']), false);
    untouched(short);
  });

  it('takes a line with no such word by its terms, or failing those only for a bullet that holds its text', () => {
    const held = setup();
    held.engine.setItems(section('Q4 ok', 'RH: oui'), false);
    assert.equal(held.engine.seed(['**Note:** Q4 OK', '**Note:** rh: oui (confirmed)']), true);

    // "Q4" is all that names the line, and the bullet carries it.
    const byTerm = setup();
    byTerm.engine.setItems(section('Q4 ok'), false);
    assert.equal(byTerm.engine.seed(['**Roadmap:** Q4 is confirmed']), true);

    const otherQuarter = setup();
    otherQuarter.engine.setItems(section('Q4 ok'), false);
    assert.equal(otherQuarter.engine.seed(['**Roadmap:** Q3 is confirmed']), false);
    untouched(otherQuarter);

    // No term and no long word: only its own text ties it.
    const bare = setup();
    bare.engine.setItems(section('ok go'), false);
    assert.equal(bare.engine.seed(['**Note:** we proceed']), false);
    untouched(bare);
  });

  it('recognises a figure the model reformatted, and a term whatever its accents', () => {
    const cases: Array<[string, string]> = [
      ['adoption: 10% des équipes', '**Adoption :** 10 % des équipes'],
      ['démo à 14h30 jeudi', '**Démo :** la démo est jeudi à 14 h 30'],
      ['budget 40k pour la formation', '**Budget :** 40 000 pour la formation'],
      ['go-live Dec avec le vendor', '**Go-live :** mise en production en décembre avec le vendor'],
      ['revue le 03 avec Jane', '**Revue :** revue le 3 avec Jane'],
    ];
    for (const [line, bullet] of cases) {
      const t = setup();
      t.engine.setItems(section(line), false);
      assert.equal(t.engine.seed([bullet]), true, `${line} -> ${bullet}`);
    }
  });

  it('still refuses a bullet whose figure is another one', () => {
    const t = setup();
    t.engine.setItems(section('formation outil de suivi sem du 24'), false);
    assert.equal(t.engine.seed(['**Formation :** formation sur l\'outil de suivi la semaine du 17']), false);
    untouched(t);
  });
});

describe('EnhanceEngine: a bullet corrected by hand', () => {
  it('replaces the engine\'s own, for the line it was written for', async () => {
    const t = setup();
    t.engine.setItems(section('budget iam', 'vendor quote'));
    await t.engine.runNow();
    const [first, second] = t.engine.bulletIds();
    assert.equal(t.engine.setBullet(second, '**Vendor:** quote due Friday, says Sam'), true);
    assert.equal(t.last().items[1].bullet, '**Vendor:** quote due Friday, says Sam');
    assert.match(t.engine.markdown(), /^- \*\*Note:\*\* budget iam \(call 1\)\n- \*\*Vendor:\*\* quote due Friday, says Sam$/);
    assert.equal(t.engine.settled(), true);
    // Nothing is asked of the model for it, and the same text again reports nothing.
    const reports = t.states.length;
    assert.equal(t.engine.setBullet(second, '**Vendor:** quote due Friday, says Sam'), true);
    assert.equal(t.states.length, reports);
    await t.engine.runNow();
    assert.equal(t.llm.requests.length, 1);
    assert.equal(t.engine.setBullet(first, '**Budget:** fixed'), true);
  });

  it('is refused for a line that is gone, for a topic, and while the line is being written', async () => {
    const t = setup();
    t.engine.setItems(section('budget iam', '#### Risks'));
    assert.equal(t.engine.setBullet('no-such-line', 'x'), false);
    assert.equal(t.engine.setBullet(t.last().items[1].id, 'x'), false);

    const held = gate();
    t.llm.script.push((req) => ({ pieces: [t.llm.answerAll(req)], hold: held.promise }));
    const running = t.engine.runNow();
    await settle();
    const id = t.last().items[0].id;
    assert.equal(t.engine.setBullet(id, '**Budget:** mine'), false, 'the call that is out would overwrite it');
    held.open();
    await running;
    assert.equal(t.engine.setBullet(id, '**Budget:** mine'), true);
    assert.deepEqual(t.engine.bulletIds(), [id]);
  });
});

describe('holdsLine: a bullet still about its line', () => {
  it('takes a line copied as its own bullet, figures with cents and ranges included', () => {
    for (const line of ['facture 1 200,50 $ à payer', 'invoice $1,200.50 due', 'budget 10 000-15 000 $']) {
      assert.equal(holdsLine(line, line), true, line);
      assert.equal(tiedTo(line, line), true, line);
    }
  });

  it('reads a shorthand word cut short, and a label that is the whole of a short line', () => {
    assert.equal(holdsLine('budg Q4 fin oct', '**Budget Q4:** The Q4 budget is due at the end of October.'), true);
    assert.equal(holdsLine('dept info sess', '**Information session:** Information session for the department.'), true);
    assert.equal(holdsLine('Projet Alpha', '**Projet Alpha:** Lancement reporté à mars faute de ressources.'), true);
    assert.equal(holdsLine('Jean Tremblay', '**Jean Tremblay:** Confirmé comme responsable du dossier.'), true);
  });

  it('reads a day or a month in the other language, and not "mon" or "sept" as one', () => {
    assert.equal(holdsLine('relancer Jean avant Thu', '**Relance:** Relancer Jean avant jeudi.'), true);
    assert.equal(holdsLine('budget final avant 15 Aug', '**Budget final:** À remettre avant le 15 août.'), true);
    assert.equal(holdsLine('voir avec mon boss pour le budget', '**Budget:** Voir avec son patron pour le budget.'), true);
    assert.equal(holdsLine('embaucher sept personnes', '**Embauche:** Embaucher 7 personnes.'), true);
    assert.equal(holdsLine('dispos fêtes avant jeudi', '**Disponibilités:** À envoyer avant vendredi.'), false);
  });

  it('still refuses a bullet about something else', () => {
    assert.equal(
      // What gemma4:12b wrote, given an excerpt about the parking lot.
      holdsLine(
        'rappeler garderie pour jeudi',
        '**rappeler garderie pour jeudi:** Il faut rappeler aux équipes que le stationnement du pavillon nord sera fermé la semaine prochaine pour des travaux.',
      ),
      false,
    );
    assert.equal(
      holdsLine(
        'demander remboursement cellulaire',
        "**demander remboursement cellulaire:** Priya doit s'inscrire au cours de gestion de produit pour 1 800 $ avant le 15 et inclure l'examen de certification à 450 $.",
      ),
      false,
    );
  });
});

describe('EnhanceEngine: an answer cut after a complete line', () => {
  it('keeps the complete lines and sends again only the one that was open', async () => {
    const t = setup();
    t.engine.setItems(section('vendor freeze starts Dec 15', 'Jane absente lundi', 'budget Q4 à revoir'));
    t.llm.script.push({
      pieces: ['1. **Freeze:** The vendor freeze starts Dec 15.\n2. **Absence:** Jane est absente lundi.\n3. **'],
      doneReason: 'length',
    });
    await t.engine.runNow();
    assert.deepEqual(
      sent(t.llm.requests[1]).map((i) => i.text),
      ['budget Q4 à revoir'],
    );
    assert.equal(t.engine.items()[1].bullet, '**Absence:** Jane est absente lundi.');
  });
});
