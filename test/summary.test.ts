import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ChatRequest,
  ChatResult,
  ChatUsage,
  EmbedResult,
  LlmScheduler,
  OllamaClient,
  Priority,
  Turn,
} from '../src/types.ts';
import { ACTIONS_SCHEMA } from '../src/llm/prompts.ts';
import { endOnCompleteLine, pickLanguage, polishSummary, summarize, windows } from '../src/llm/summary.ts';
import type { GenSettings, SummaryInput } from '../src/llm/summary.ts';
import { estimateTokens } from '../src/util/text.ts';

function fail(kind: string): Error {
  return Object.assign(new Error(kind), { kind });
}

type Reply = string | Error | { text: string; hold: Promise<void> };

/** Answers from `reply`, streaming the text in pieces of 12 characters. */
class FakeLlm implements OllamaClient {
  requests: ChatRequest[] = [];
  reply: (req: ChatRequest, index: number) => Reply = () => 'ok';

  async chatStream(
    req: ChatRequest,
    onToken?: (delta: string, full: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    this.requests.push(req);
    const reply = this.reply(req, this.requests.length - 1);
    if (reply instanceof Error) throw reply;
    const text = typeof reply === 'string' ? reply : reply.text;
    let full = '';
    for (let i = 0; i < text.length; i += 12) {
      const piece = text.slice(i, i + 12);
      full += piece;
      onToken?.(piece, full);
    }
    if (typeof reply !== 'string') {
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(fail('aborted')), { once: true });
        void reply.hold.then(resolve);
      });
    }
    if (signal?.aborted) throw fail('aborted');
    return {
      text: full,
      usage: {
        model: req.model,
        promptTokens: 1000,
        cachedTokens: 0,
        outputTokens: 50,
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
  /** What happened to the holds, in order: `hold <model>` and `release <model>`. */
  holds: string[] = [];
  hold(model: string): () => void {
    this.holds.push(`hold ${model}`);
    return () => {
      this.holds.push(`release ${model}`);
    };
  }
  cancelAll(): void {
    for (const ctl of this.running) ctl.abort();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function setup(over: Partial<GenSettings> = {}, glossary?: () => string[]) {
  const llm = new FakeLlm();
  const scheduler = new FakeScheduler();
  const settings: GenSettings = { model: 'gemma4:12b', numCtx: 16384, micLabel: 'Alex', ...over };
  const usages: ChatUsage[] = [];
  const texts: string[] = [];
  const deps = { llm, scheduler, settings: () => settings, onUsage: (u: ChatUsage) => usages.push(u), glossary };
  const onText = (markdown: string): void => {
    texts.push(markdown);
  };
  return { llm, scheduler, settings, usages, texts, deps, onText };
}

function turn(t0: number, text: string, source: 'mic' | 'system' = 'mic'): Turn {
  return { id: `t${t0}`, source, t0, t1: t0 + 8, text };
}

const EN_SENTENCE =
  'We need to review the access budget before the committee meets, and the vendor has to confirm the quote for the single sign-on work this week.';
const FR_SENTENCE =
  'Il faut revoir le budget de la gestion des accès avant le comité, et le fournisseur doit confirmer la soumission pour le projet cette semaine.';

/** One turn every 10 s: `count` of them fill `count / 60` ten-minute windows. */
function longMeeting(count: number, sentence = EN_SENTENCE): Turn[] {
  return Array.from({ length: count }, (_unused, i) => turn(i * 10, `${sentence} (${i})`, i % 2 === 0 ? 'mic' : 'system'));
}

function input(over: Partial<SummaryInput> = {}): SummaryInput {
  return {
    style: 'executive',
    language: 'auto',
    title: 'Steering committee',
    date: '2026-10-09',
    shorthand: ['budget iam end of oct', 'vendor quote sso'],
    turns: [turn(5, 'We need the quote by Friday.'), turn(12, 'Understood, I will send it.', 'system')],
    asTasks: false,
    speakerLabels: { mic: 'Alex', system: 'Others' },
    ...over,
  };
}

const userOf = (req: ChatRequest): string => req.messages[req.messages.length - 1].content;

describe('windows', () => {
  it('splits on the recording clock and leaves empty windows out', () => {
    const turns = [0, 300, 599, 600, 1250, 3000].map((t0) => turn(t0, 'x'));
    assert.deepEqual(
      windows(turns, 600).map((w) => w.map((t) => t.t0)),
      [[0, 300, 599], [600], [1250], [3000]],
    );
  });

  it('sorts turns that arrive out of order, without touching the input', () => {
    const turns = [turn(700, 'b'), turn(10, 'a'), turn(650, 'c')];
    assert.deepEqual(
      windows(turns, 600).map((w) => w.map((t) => t.t0)),
      [[10], [650, 700]],
    );
    assert.deepEqual(
      turns.map((t) => t.t0),
      [700, 10, 650],
    );
  });

  it('returns nothing for no turns', () => {
    assert.deepEqual(windows([], 600), []);
  });
});

describe('pickLanguage', () => {
  const french = [turn(0, FR_SENTENCE), turn(10, 'On va faire le point avec le comité dans deux semaines.')];
  const english = [turn(0, EN_SENTENCE)];

  it('picks French for auto on French turns', () => {
    assert.equal(pickLanguage('auto', french, []), 'fr');
    assert.equal(pickLanguage('auto', french, ['we need the budget for the committee']), 'fr');
  });

  it('picks English for auto on English turns', () => {
    assert.equal(pickLanguage('auto', english, ['il faut revoir le budget']), 'en');
  });

  it('follows the setting when it is not auto', () => {
    assert.equal(pickLanguage('en', french, []), 'en');
    assert.equal(pickLanguage('fr', english, []), 'fr');
  });

  it('uses the shorthand when there is no speech, and English when nothing decides', () => {
    assert.equal(pickLanguage('auto', [], ['il faut revoir le budget avec le comité']), 'fr');
    assert.equal(pickLanguage('auto', [], ['budget IAM']), 'en');
    assert.equal(pickLanguage('auto', [], []), 'en');
  });

  it('reads terse French notes that have no function word', () => {
    assert.equal(pickLanguage('auto', [], ['budget formation 12 k$ approuvé', 'Jane absente lundi', 'relancer Marc demain']), 'fr');
  });

  it('does not let a sentence or two of speech outvote the notes', () => {
    const soundCheck: Turn[] = [{ id: 'T1', source: 'mic', t0: 0, t1: 3, text: 'Can you hear me? Is this on?' }];
    const notes = ['il faut revoir le budget avec le comité', 'Jane absente lundi', 'on attend la signature du contrat', 'prochain point jeudi', 'retard de 2 semaines sur la migration'];
    assert.equal(pickLanguage('auto', soundCheck, notes), 'fr');
  });
});

describe('polishSummary', () => {
  it('drops an announcing line and demotes headings above level 3', () => {
    const raw = ['Here is the summary of the meeting:', '', '# Overview', 'Text.', '## Action items', '- A', '#### Deep'].join('\n');
    assert.equal(polishSummary(raw), ['### Overview', 'Text.', '### Action items', '- A', '#### Deep'].join('\n'));
  });

  it('drops a French announcing line before bullets', () => {
    assert.equal(polishSummary('Voici le récapitulatif\n\n- Un\n- Deux'), '- Un\n- Deux');
    assert.equal(polishSummary('**Résumé de la réunion**\n\n### Vue d\'ensemble\nTexte.'), "### Vue d'ensemble\nTexte.");
  });

  it('keeps an opening paragraph that is content', () => {
    const raw = 'The committee approved the budget and postponed the migration.\n\n### Action items\n- A';
    assert.equal(polishSummary(raw), raw);
  });

  it('unwraps a code fence around the whole answer', () => {
    assert.equal(polishSummary('```markdown\n### Overview\nText.\n```'), '### Overview\nText.');
    // Mid-stream, only the opening fence has arrived.
    assert.equal(polishSummary('```markdown\n## Overview\nTe'), '### Overview\nTe');
  });

  it('leaves tags and fenced code alone', () => {
    const raw = ['### Details', '#budget is a tag', '```', '# not a heading', '```'].join('\n');
    assert.equal(polishSummary(raw), raw);
  });
});

describe('summarize', () => {
  it('makes one call for a short meeting, with the documented options', async () => {
    const t = setup({}, () => ['IAM']);
    t.llm.reply = () => 'Here is the summary:\n\n# Overview\nThe quote is due Friday.\n\n## Action items\n- **Others**: send the quote (Friday)\n\n## Details\n- Quote';
    const out = await summarize(t.deps, input(), t.onText);

    assert.equal(t.llm.requests.length, 1);
    const req = t.llm.requests[0];
    assert.equal(req.model, 'gemma4:12b');
    assert.equal(req.numCtx, 16384);
    assert.equal(req.temperature, 0.4);
    assert.equal(req.topK, 40);
    assert.equal(req.topP, 0.9);
    assert.equal(req.repeatPenalty, 1.05);
    assert.equal(req.numPredict, 2000);
    assert.equal(req.keepAlive, '5m');
    assert.equal(req.format, undefined);
    assert.deepEqual(t.scheduler.calls, [{ model: 'gemma4:12b', priority: 'interactive', key: null }]);

    const user = userOf(req);
    assert.ok(user.includes('<transcript>\n[00:05] Alex: We need the quote by Friday.\n[00:12] Others: Understood, I will send it.\n</transcript>'));
    assert.ok(user.includes('<shorthand>\nbudget iam end of oct\nvendor quote sso\n</shorthand>'));
    assert.ok(user.includes('<spellings>IAM</spellings>'));
    assert.ok(user.includes('### Overview'));

    assert.equal(
      out,
      '### Overview\nThe quote is due Friday.\n\n### Action items\n- **Others**: send the quote (Friday)\n\n### Details\n- Quote',
    );
    // Streamed text grows, already tidied, and ends on the final text.
    assert.ok(t.texts.length > 2);
    assert.equal(t.texts[t.texts.length - 1], out);
    assert.ok(t.texts.every((text) => !text.includes('# Overview') || text.includes('### Overview')));
    assert.ok(t.texts.some((text) => text.startsWith('### Overview') && text.length < out.length));
    assert.equal(t.usages.length, 1);
  });

  it('labels the channels as the caller says, falling back to the mic label of the settings', async () => {
    const t = setup({ micLabel: 'Sam' });
    await summarize(t.deps, input({ speakerLabels: { mic: '', system: 'Remote' } }), t.onText);
    const user = userOf(t.llm.requests[0]);
    assert.ok(user.includes('[00:05] Sam: We need the quote by Friday.'));
    assert.ok(user.includes('[00:12] Remote: Understood, I will send it.'));
    assert.ok(user.includes('Lines labelled "Sam" are the note-taker speaking.'));
  });

  it('stays single pass up to the threshold', async () => {
    const t = setup();
    // 200 turns of about 50 tokens each: just under 10,000 tokens.
    const turns = longMeeting(200);
    await summarize(t.deps, input({ turns }), t.onText);
    const transcript = /<transcript>\n([\s\S]*)\n<\/transcript>/.exec(userOf(t.llm.requests[0]));
    assert.ok(transcript);
    assert.ok(estimateTokens(transcript[1]) <= 10_000);
    assert.ok(estimateTokens(transcript[1]) > 9_800);
    assert.equal(t.llm.requests.length, 1);
  });

  it('switches to windows just above the threshold', async () => {
    const t = setup();
    const turns = longMeeting(203);
    t.llm.reply = () => '- note';
    await summarize(t.deps, input({ turns, style: 'recap' }), t.onText);
    // Four windows and the reduce.
    assert.equal(t.llm.requests.length, 5);
  });

  it('maps over ten-minute windows above the threshold, then reduces', async () => {
    const t = setup();
    // 210 turns, 35 minutes, about 10,400 tokens.
    const turns = longMeeting(210);
    t.llm.reply = (_req, index) => (index < 4 ? `- note from window ${index + 1}` : '### Overview\nFinal.');
    const out = await summarize(t.deps, input({ turns }), t.onText);

    assert.equal(t.llm.requests.length, 5);
    assert.deepEqual(
      t.llm.requests.map((r) => r.numPredict),
      [300, 300, 300, 300, 2000],
    );
    assert.ok(t.scheduler.calls.every((c) => c.priority === 'interactive' && c.key === null));
    assert.ok(t.llm.requests.every((r) => r.numCtx === 16384 && r.keepAlive === '5m' && r.temperature === 0.4));

    const first = userOf(t.llm.requests[0]);
    assert.ok(first.includes('<part>00:00 to 09:58</part>'));
    assert.ok(first.includes('[09:50] Others:'));
    assert.equal(first.includes('[10:00] Alex:'), false);
    assert.ok(userOf(t.llm.requests[3]).includes('<part>30:00 to 34:58</part>'));

    const reduce = userOf(t.llm.requests[4]);
    const windowNotes = [
      '[00:00 to 09:58]\n- note from window 1',
      '[10:00 to 19:58]\n- note from window 2',
      '[20:00 to 29:58]\n- note from window 3',
      '[30:00 to 34:58]\n- note from window 4',
    ].join('\n\n');
    assert.ok(reduce.includes(`<notes>\n${windowNotes}\n</notes>`));
    assert.equal(reduce.includes('<transcript>'), false);
    assert.ok(reduce.includes('vendor quote sso'));
    assert.ok(reduce.includes('### Overview'));

    assert.deepEqual(t.texts.slice(0, 4), [
      'Reading minutes 0–10…',
      'Reading minutes 10–20…',
      'Reading minutes 20–30…',
      'Reading minutes 30–40…',
    ]);
    assert.equal(out, '### Overview\nFinal.');
    assert.equal(t.texts[t.texts.length - 1], out);
    assert.equal(t.usages.length, 5);
  });

  it('keeps live work off the model from its first call to its last, whichever way it ends', async () => {
    // Between two windows the model is free for an instant: a live request started then is dropped at once.
    const t = setup();
    const seen: number[] = [];
    t.llm.reply = () => {
      seen.push(t.scheduler.holds.length);
      return '- note';
    };
    await summarize(t.deps, input({ turns: longMeeting(210) }), t.onText);
    assert.deepEqual(t.scheduler.holds, ['hold gemma4:12b', 'release gemma4:12b']);
    assert.deepEqual(seen, [1, 1, 1, 1, 1], 'held during every call, released after the last');

    const failing = setup();
    failing.llm.reply = (_req, index) => (index === 1 ? fail('unreachable') : '- note');
    await assert.rejects(summarize(failing.deps, input({ turns: longMeeting(210) }), failing.onText));
    assert.deepEqual(failing.scheduler.holds, ['hold gemma4:12b', 'release gemma4:12b']);

    // A scheduler that knows no holds is used as before.
    const plain = setup();
    const bare = { ...plain.deps, scheduler: { run: plain.scheduler.run.bind(plain.scheduler), busy: () => false, cancelAll: () => {} } };
    assert.equal(await summarize(bare, input(), plain.onText), 'ok');
  });

  it('writes in French for auto on French turns, progress included', async () => {
    const t = setup();
    const turns = longMeeting(210, FR_SENTENCE);
    t.llm.reply = (_req, index) => (index < 4 ? '- note' : "### Vue d'ensemble\nFin.");
    await summarize(t.deps, input({ turns, shorthand: [] }), t.onText);

    assert.equal(t.texts[0], 'Lecture des minutes 0 à 10…');
    assert.match(userOf(t.llm.requests[0]), /4 to 8 bullets \("- "\) in French/);
    const reduce = t.llm.requests[t.llm.requests.length - 1];
    assert.match(reduce.messages[0].content, /Write in French/);
    assert.ok(userOf(reduce).includes("### Vue d'ensemble"));
    assert.equal(userOf(reduce).includes('<shorthand>'), false);
  });

  it('reads a meeting in smaller parts when the context is small', async () => {
    const t = setup({ numCtx: 4096 });
    // One ten-minute window of about 3,700 tokens does not fit beside the prompt.
    const turns = longMeeting(60);
    t.llm.reply = (req) => (req.numPredict === 300 ? '- note' : '- final');
    await summarize(t.deps, input({ turns, style: 'recap' }), t.onText);

    const maps = t.llm.requests.filter((r) => r.numPredict === 300);
    assert.ok(maps.length >= 2);
    for (const req of maps) {
      const total = req.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
      assert.ok(total + 300 <= 4096, `map prompt of ${total} tokens fits`);
    }
    assert.equal(t.texts[0], 'Reading minutes 0–10…');
    assert.equal(t.texts[1], 'Reading minutes 0–10…');
  });

  it('uses the schema for action items and never shows partial JSON', async () => {
    const t = setup();
    t.llm.reply = () =>
      JSON.stringify({
        items: [
          { owner: 'Camille', task: 'Send the SSO quote', due: 'Friday' },
          { owner: '', task: 'Book the room', due: '' },
        ],
      });
    const out = await summarize(t.deps, input({ style: 'actions' }), t.onText);

    assert.equal(t.llm.requests.length, 1);
    assert.equal(t.llm.requests[0].format, ACTIONS_SCHEMA);
    assert.ok(userOf(t.llm.requests[0]).includes('{"items":[{"owner":"","task":"","due":""}]}'));
    assert.equal(out, '- **Camille**: Send the SSO quote (Friday)\n- Book the room');
    assert.deepEqual(t.texts, [out]);

    const tasks = await summarize(t.deps, input({ style: 'actions', asTasks: true }), () => {});
    assert.equal(tasks, '- [ ] **Camille**: Send the SSO quote (Friday)\n- [ ] Book the room');
  });

  it('says so in the meeting language when there are no action items', async () => {
    const t = setup();
    t.llm.reply = () => '{"items":[]}';
    const out = await summarize(
      t.deps,
      input({ style: 'actions', turns: [turn(0, FR_SENTENCE)], shorthand: [] }),
      t.onText,
    );
    assert.equal(out, 'Aucune action à retenir.');
  });

  it('keeps the format on the reduce call of a long meeting only', async () => {
    const t = setup();
    t.llm.reply = (req) => (req.format ? '{"items":[{"owner":"Sam","task":"Call","due":""}]}' : '- note');
    const out = await summarize(t.deps, input({ style: 'actions', turns: longMeeting(210) }), t.onText);
    assert.deepEqual(
      t.llm.requests.map((r) => r.format !== undefined),
      [false, false, false, false, true],
    );
    assert.equal(out, '- **Sam**: Call');
    assert.deepEqual(t.texts.slice(4), [out]);
  });

  it('summarizes shorthand alone, and a transcript alone', async () => {
    const t = setup();
    await summarize(t.deps, input({ turns: [] }), t.onText);
    assert.ok(userOf(t.llm.requests[0]).includes('<transcript>\n(no transcript)\n</transcript>'));
    await summarize(t.deps, input({ shorthand: ['  ', ''] }), t.onText);
    assert.equal(userOf(t.llm.requests[1]).includes('<shorthand>'), false);
  });

  it('throws on empty input without calling the model', async () => {
    const t = setup();
    await assert.rejects(
      summarize(t.deps, input({ turns: [turn(0, '   ')], shorthand: ['', '  '] }), t.onText),
      { message: 'Nothing to summarize yet' },
    );
    assert.equal(t.llm.requests.length, 0);
    assert.equal(t.scheduler.calls.length, 0);
  });

  it('rejects at once when the caller aborts during the call', async () => {
    const t = setup();
    const never = new Promise<void>(() => {});
    t.llm.reply = () => ({ text: '### Overview\nHalf', hold: never });
    const ctl = new AbortController();
    const run = summarize(t.deps, input(), t.onText, ctl.signal);
    await settle();
    const shown = t.texts.length;
    assert.ok(shown > 0);

    ctl.abort();
    await assert.rejects(run, (e: unknown) => (e as { kind?: string }).kind === 'aborted');
    await settle();
    assert.equal(t.texts.length, shown, 'nothing is reported after the abort');
    assert.equal(t.usages.length, 0);
  });

  it('stops a map-reduce at the abort', async () => {
    const t = setup();
    const never = new Promise<void>(() => {});
    t.llm.reply = (_req, index) => (index === 1 ? { text: '- half', hold: never } : '- note');
    const ctl = new AbortController();
    const run = summarize(t.deps, input({ turns: longMeeting(210) }), t.onText, ctl.signal);
    await settle();
    assert.equal(t.llm.requests.length, 2);
    ctl.abort();
    await assert.rejects(run, (e: unknown) => (e as { kind?: string }).kind === 'aborted');
    await settle();
    assert.equal(t.llm.requests.length, 2);
  });

  it('rejects at once when aborted while still waiting for the model, and never calls it', async () => {
    const t = setup();
    let release = (): void => {};
    t.scheduler.waitFor = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctl = new AbortController();
    const run = summarize(t.deps, input(), t.onText, ctl.signal);
    await settle();
    assert.equal(t.scheduler.calls.length, 1);
    assert.equal(t.llm.requests.length, 0);

    ctl.abort();
    await assert.rejects(run, (e: unknown) => (e as { kind?: string }).kind === 'aborted');
    // Its turn comes later: the task gives the slot back without a request.
    release();
    await settle();
    assert.equal(t.llm.requests.length, 0);
    assert.equal(t.usages.length, 0);
  });

  it('rejects without a call when the signal is already aborted', async () => {
    const t = setup();
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(
      summarize(t.deps, input(), t.onText, ctl.signal),
      (e: unknown) => (e as { kind?: string }).kind === 'aborted',
    );
    assert.equal(t.llm.requests.length, 0);
  });

  it('passes on an abort that comes from the queue', async () => {
    const t = setup();
    const never = new Promise<void>(() => {});
    t.llm.reply = () => ({ text: '', hold: never });
    const run = summarize(t.deps, input(), t.onText);
    await settle();
    t.scheduler.cancelAll();
    await assert.rejects(run, (e: unknown) => (e as { kind?: string }).kind === 'aborted');
  });

  it('passes model errors on unchanged', async () => {
    const t = setup();
    const down = fail('unreachable');
    t.llm.reply = () => down;
    await assert.rejects(summarize(t.deps, input(), t.onText), (e: unknown) => e === down);
  });
});

describe('endOnCompleteLine', () => {
  it('drops the line the token limit cut', () => {
    assert.equal(endOnCompleteLine('# Overview\nThe launch moves to November.\n- Dana owns the rollback pla'), '# Overview\nThe launch moves to November.');
    assert.equal(endOnCompleteLine('One line only, cut in the mid'), 'One line only, cut in the mid');
  });
});
