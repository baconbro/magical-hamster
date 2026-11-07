import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ChatRequest,
  ChatResult,
  ChatUsage,
  EmbedResult,
  Excerpt,
  LlmScheduler,
  OllamaClient,
  Priority,
  SourceDoc,
} from '../src/types.ts';
import {
  answerQuestion,
  buildSources,
  citedSources,
  formatInsight,
  lastSentence,
  looksLikeQuestion,
  qaSourceBudget,
  questionLanguage,
  questionsIn,
  sentencesOf,
} from '../src/llm/qa.ts';
import type { QaInput } from '../src/llm/qa.ts';
import type { GenSettings } from '../src/llm/summary.ts';
import { estimateTokens } from '../src/util/text.ts';

function fail(kind: string): Error {
  return Object.assign(new Error(kind), { kind });
}

class FakeLlm implements OllamaClient {
  requests: ChatRequest[] = [];
  text = 'The migration ends in March [1].';
  hold: Promise<void> | null = null;

  async chatStream(
    req: ChatRequest,
    onToken?: (delta: string, full: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    this.requests.push(req);
    let full = '';
    for (const piece of this.text.split(/(?<= )/)) {
      full += piece;
      onToken?.(piece, full);
    }
    const hold = this.hold;
    if (hold) {
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(fail('aborted')), { once: true });
        void hold.then(resolve);
      });
    }
    if (signal?.aborted) throw fail('aborted');
    return {
      text: full,
      usage: {
        model: req.model,
        promptTokens: 500,
        cachedTokens: 0,
        outputTokens: 12,
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
  private running = new Set<AbortController>();

  async run<T>(
    model: string,
    priority: Priority,
    key: string | null,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.calls.push({ model, priority, key });
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
    for (const ctl of this.running) ctl.abort();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function setup(over: Partial<GenSettings> = {}) {
  const llm = new FakeLlm();
  const scheduler = new FakeScheduler();
  const settings: GenSettings = { model: 'gemma4:12b', numCtx: 16384, micLabel: 'Alex', ...over };
  const usages: ChatUsage[] = [];
  const texts: string[] = [];
  const deps = { llm, scheduler, settings: () => settings, onUsage: (u: ChatUsage) => usages.push(u) };
  const onText = (markdown: string): void => {
    texts.push(markdown);
  };
  return { llm, scheduler, settings, usages, texts, deps, onText };
}

const sources: SourceDoc[] = [
  { n: 1, kind: 'linked', title: 'IAM roadmap', path: 'notes/IAM roadmap.md', text: 'The migration ends in March.' },
  { n: 2, kind: 'note', title: 'Vendors', path: 'notes/Vendors.md', heading: 'SSO › Pricing', text: 'Quote expected Friday.', score: 0.6 },
  { n: 3, kind: 'transcript', title: 'Transcript', time: '14:03', text: 'we said March for the migration', score: 0.5 },
];

function question(over: Partial<QaInput> = {}): QaInput {
  return {
    question: 'When does the migration end?',
    title: 'Steering committee',
    date: '2026-10-09',
    shorthand: ['migration march', 'vendor quote sso'],
    transcriptTail: '[14:03] Alex: we said March for the migration',
    sources,
    ...over,
  };
}

const userOf = (req: ChatRequest): string => req.messages[req.messages.length - 1].content;

describe('looksLikeQuestion', () => {
  const yes = [
    'When does the migration end?',
    'Est-ce que le budget est approuvé',
    "Est-ce qu'on a une date pour la migration",
    'Qu’est-ce que ça change pour nous',
    "Qu'est-ce qu'on fait avec le fournisseur ?",
    'Pourquoi on a choisi ce fournisseur',
    'Comment on va financer la phase deux',
    'Quand est-ce que la migration se termine',
    'Combien ça coûte par année',
    'Où en est le dossier IAM',
    'Qui est responsable du suivi',
    'Quel est le budget prévu',
    'Quelle équipe prend le relais',
    'Quels sont les risques principaux',
    'Quelles options reste-t-il',
    'What is the deadline for the quote',
    'Why did we pick this vendor',
    'How do we fund phase two',
    'When is the next steering committee',
    'Who owns the follow-up',
    'Which team takes over',
    'Where are we on the audit',
    'Can we move the date',
    'Could we split the invoice',
    'Should we wait for the audit',
    'Do we have a fallback',
    'Does the quote include support',
    'Is there a risk for the launch',
    'Are there any blockers left',
    'So the budget is approved, right?',
    'Le budget est approuvé ?',
    '  what   is the plan  ',
    '- How long will it take',
    'WHAT IS THE PLAN',
    'He asked "are we done here?"',
  ];
  const no = [
    'ok?',
    'right?',
    'Why not?',
    'Vraiment ?',
    '',
    '   ',
    'We approved the budget yesterday.',
    'Le budget est approuvé.',
    'However the date moved again',
    'Whatever we decide is fine',
    'Commentaire reçu du fournisseur hier',
    'Quittons la salle à midi',
    'Ou bien on attend la semaine prochaine',
    'Whenever you are ready we start',
    'Howard will send the quote',
    'Quelque chose ne va pas',
    "Doesn't matter for this quarter",
    'The question is why we waited so long.',
  ];
  for (const text of yes) {
    it(`yes: ${JSON.stringify(text)}`, () => assert.equal(looksLikeQuestion(text), true));
  }
  it('reads accents written as combining marks', () => {
    // "où" as o + U+0300, as some speech models and macOS file names spell it.
    assert.equal(looksLikeQuestion('Ou\u0300 en est le dossier'), true);
    assert.equal(looksLikeQuestion('Ou en est le dossier'), false);
  });
  for (const text of no) {
    it(`no: ${JSON.stringify(text)}`, () => assert.equal(looksLikeQuestion(text), false));
  }
});

describe('questionsIn: what a speech recognizer really hands over', () => {
  it('takes each question of a long final as its own sentence', () => {
    assert.deepEqual(
      questionsIn(
        "merci d'être là. Maël, peux tu nous faire un résumé de ce qui s'est passé depuis la dernière fois? Oui, certainement, on a terminé l'analyse.",
      ),
      ["Maël, peux tu nous faire un résumé de ce qui s'est passé depuis la dernière fois?"],
    );
    assert.deepEqual(questionsIn('What about the room? Is it booked? Yes, since Monday.'), ['What about the room?', 'Is it booked?']);
  });

  it('reads the forms a recognizer writes without hyphens', () => {
    assert.deepEqual(questionsIn("Est ce qu'on a un engagement par écrit de sa part"), ["Est ce qu'on a un engagement par écrit de sa part"]);
    assert.deepEqual(questionsIn('avez vous réservé la salle pour janvier'), ['avez vous réservé la salle pour janvier']);
    assert.deepEqual(questionsIn('y a t il autre chose avant de finir'), ['y a t il autre chose avant de finir']);
    assert.deepEqual(questionsIn('comment on va choisir les priorités'), ['comment on va choisir les priorités']);
    assert.deepEqual(questionsIn('Does Marc know about the freeze'), ['Does Marc know about the freeze']);
    assert.deepEqual(questionsIn('so, did they sign the addendum'), ['so, did they sign the addendum']);
  });

  it('finds a question that follows on in mid-sentence, and starts the chip there', () => {
    assert.deepEqual(questionsIn('great, and the API connector when will it be ready we need three more weeks'), [
      'when will it be ready we need three more weeks',
    ]);
    assert.deepEqual(
      questionsIn("on va commencer la rencontre de suivi du projet Balise Thomas, est-ce que le connecteur a été livré cette semaine"),
      ['est-ce que le connecteur a été livré cette semaine'],
    );
    assert.deepEqual(questionsIn("ça fait trois fois qu'il repousse quand est ce que le test a lieu"), ['quand est ce que le test a lieu']);
    assert.deepEqual(questionsIn('the room is free, is it booked for us'), ['is it booked for us']);
  });

  it('does not take a statement that opens on an interrogative word for a question', () => {
    for (const text of [
      'Quand on a lancé le pilote, tout le monde était content.',
      'Comment dire, je ne suis pas certaine que tout le monde soit content.',
      'When we ran the pilot the numbers were better.',
      'What I mean is that the vendor is late.',
      'Which is why we moved the date.',
      'How it works is described in the guide.',
      'Do it before Friday.',
      'Have a look at the draft tonight.',
      'Quand on aura sa réponse on pourra décider.',
    ]) {
      assert.deepEqual(questionsIn(text), [], text);
    }
  });

  it('cuts a long run-on that ends in a question mark to the question', () => {
    const runOn =
      "Camille propose de passer à quatorze séances pour les cinquante huit participants et on verra ensuite pour le reste du calendrier de l'automne avez vous réservé la salle pour janvier?";
    assert.deepEqual(questionsIn(runOn), ['avez vous réservé la salle pour janvier?']);
  });

  it('gives the last sentence of a final, for the mark that comes with the next one', () => {
    assert.equal(lastSentence("C'est noté. Qui va s'occuper de la formation des utilisateurs"), "Qui va s'occuper de la formation des utilisateurs");
    assert.equal(lastSentence('Parfait. Ok'), null);
    assert.equal(lastSentence(''), null);
  });

  it('splits sentences at their closing marks only', () => {
    assert.deepEqual(sentencesOf('Budget ok. On vise le 3.5 M$ ? Oui… peut-être'), ['Budget ok.', 'On vise le 3.5 M$ ?', 'Oui…', 'peut-être']);
  });
});

describe('buildSources', () => {
  const linked = [
    { title: 'IAM roadmap', path: 'notes/IAM roadmap.md', text: 'Roadmap text.' },
    { title: 'Camille Roy', path: 'people/Camille Roy.md', text: 'Person note.' },
  ];
  const vault = [
    { path: 'notes/Vendors.md', title: 'Vendors', heading: 'SSO', text: 'Low score chunk.', score: 0.41 },
    { path: 'notes/IAM roadmap.md', title: 'IAM roadmap', heading: 'Plan', text: 'Already linked.', score: 0.95 },
    { path: 'notes/Budget.md', title: 'Budget', heading: '', text: 'High score chunk.', score: 0.82 },
  ];
  const transcript: Excerpt[] = [
    { id: 'E4', time: '02:00', text: 'weaker excerpt', score: 0.5 },
    { id: 'E9', time: '14:03', text: 'stronger excerpt', score: 0.7 },
  ];

  it('orders linked notes, vault chunks by score, then transcript, numbered from 1', () => {
    const out = buildSources({ linked, vault, transcript, maxTokens: 10_000 });
    assert.deepEqual(
      out.map((s) => [s.n, s.kind, s.title, s.text]),
      [
        [1, 'linked', 'IAM roadmap', 'Roadmap text.'],
        [2, 'linked', 'Camille Roy', 'Person note.'],
        [3, 'note', 'Budget', 'High score chunk.'],
        [4, 'note', 'Vendors', 'Low score chunk.'],
        [5, 'transcript', 'Transcript', 'stronger excerpt'],
        [6, 'transcript', 'Transcript', 'weaker excerpt'],
      ],
    );
    assert.equal(out[0].path, 'notes/IAM roadmap.md');
    assert.equal(out[2].score, 0.82);
    assert.equal('heading' in out[2], false);
    assert.equal(out[3].heading, 'SSO');
    assert.equal(out[4].time, '14:03');
  });

  it('drops a vault chunk of a note that is already linked', () => {
    const out = buildSources({ linked, vault, transcript: [], maxTokens: 10_000 });
    assert.equal(
      out.some((s) => s.kind === 'note' && s.path === 'notes/IAM roadmap.md'),
      false,
    );
    assert.equal(out.length, 4);
    // Without the link, the chunk is there and comes first among the chunks.
    const unlinked = buildSources({ linked: [], vault, transcript: [], maxTokens: 10_000 });
    assert.deepEqual(
      unlinked.map((s) => s.title),
      ['IAM roadmap', 'Budget', 'Vendors'],
    );
  });

  it('stops adding when the budget would be exceeded', () => {
    const text = 'x'.repeat(330);
    const chunks = [0.9, 0.8, 0.7, 0.6].map((score, i) => ({
      path: `n${i}.md`,
      title: `N${i}`,
      heading: '',
      text,
      score,
    }));
    assert.equal(estimateTokens(text), 100);
    assert.equal(buildSources({ linked: [], vault: chunks, transcript: [], maxTokens: 250 }).length, 2);
    assert.equal(buildSources({ linked: [], vault: chunks, transcript: [], maxTokens: 300 }).length, 3);
    assert.equal(buildSources({ linked: [], vault: chunks, transcript: [], maxTokens: 299 }).length, 2);
    // It stops there: a smaller source further down does not jump the queue.
    const mixed = buildSources({
      linked: [],
      vault: chunks.slice(0, 2),
      transcript: [{ id: 'E1', time: '00:10', text: 'short', score: 0.9 }],
      maxTokens: 150,
    });
    assert.deepEqual(
      mixed.map((s) => s.title),
      ['N0'],
    );
  });

  it('shortens a first source that is over budget on its own', () => {
    const long = 'mot '.repeat(500).trim();
    const out = buildSources({
      linked: [{ title: 'Long note', path: 'long.md', text: long }],
      vault: [{ path: 'b.md', title: 'B', heading: '', text: 'short', score: 0.9 }],
      transcript: [],
      maxTokens: 100,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].n, 1);
    assert.equal(out[0].title, 'Long note');
    assert.ok(out[0].text.endsWith('…'));
    assert.ok(out[0].text.length > 250);
    assert.ok(estimateTokens(out[0].text) <= 100);
  });

  it('skips empty sources and returns nothing for no budget', () => {
    const out = buildSources({
      linked: [{ title: 'Empty', path: 'e.md', text: '   ' }],
      vault: [{ path: 'b.md', title: 'B', heading: '', text: 'short', score: 0.9 }],
      transcript: [],
      maxTokens: 100,
    });
    assert.deepEqual(
      out.map((s) => [s.n, s.title]),
      [[1, 'B']],
    );
    assert.deepEqual(buildSources({ linked, vault, transcript, maxTokens: 0 }), []);
  });
});

describe('qaSourceBudget', () => {
  const q = 'When does the migration end?';

  it('gives the sources 6,000 tokens when the context has them to spare', () => {
    assert.equal(qaSourceBudget(16384, q, 'migration march\nvendor quote sso'), 6000);
    assert.equal(qaSourceBudget(16384, q, ''), 6000);
  });

  it('follows the context down, and never below 500 tokens', () => {
    const small = qaSourceBudget(6144, q, 'migration march');
    assert.ok(small < 6000 && small > 500, `${small} tokens at 6,144`);
    assert.ok(qaSourceBudget(6144, q, 'x'.repeat(12_000)) < small, 'a long shorthand leaves the sources less');
    // At the smallest setting a 12,000-character shorthand leaves nothing: the sources keep their floor.
    assert.equal(qaSourceBudget(4096, q, 'x'.repeat(12_000)), 500);
    assert.ok(qaSourceBudget(4096, q, '') >= 500);
  });
});

describe('citedSources', () => {
  it('returns the sources the answer cites, in source order', () => {
    assert.deepEqual(
      citedSources('It ends in March [3], as planned [1].', sources).map((s) => s.n),
      [1, 3],
    );
    assert.deepEqual(
      citedSources('Both say so [1, 2].', sources).map((s) => s.n),
      [1, 2],
    );
    assert.deepEqual(
      citedSources('See [2][3].', sources).map((s) => s.n),
      [2, 3],
    );
  });

  it('reads ranges, lists in words and full-width digits', () => {
    assert.deepEqual(citedSources('See [1-3].', sources).map((s) => s.n), [1, 2, 3]);
    assert.deepEqual(citedSources('See [1 and 3].', sources).map((s) => s.n), [1, 3]);
    assert.deepEqual(citedSources('Voir ［２］.', sources).map((s) => s.n), [2]);
  });

  it('lists the sources an uncited answer draws on, by their figures and names, and none otherwise', () => {
    const rich: SourceDoc[] = [
      { n: 1, kind: 'note', title: 'Balise - Budget', path: 'b.md', text: 'The steering board approved 184,000 $ on 18 June 2026.' },
      { n: 2, kind: 'note', title: 'Halcyon', path: 'h.md', text: 'Data warehouse consolidation. Budget: 310,000 $. Go-live: 1 June 2027.' },
    ];
    assert.deepEqual(citedSources('The board approved 184 000 $ for Balise on 18 June 2026.', rich).map((s) => s.n), [1]);
    assert.deepEqual(citedSources('The material does not say.', rich), []);
    assert.deepEqual(citedSources('It ends in March.', sources), []);
    // Brackets that name the transcript are not sources, and do not count as an answer drawn on one.
    assert.deepEqual(citedSources('Staging is due on October 30th [transcript].', rich), []);
    assert.deepEqual(citedSources('See [9] and [link](https://example.com) and [1](x).', sources), []);
    assert.deepEqual(citedSources('Anything [1].', []), []);
  });
});

describe('formatInsight', () => {
  it('lays out the heading, the answer and the sources', () => {
    const block = formatInsight({
      clockTime: '14:05',
      question: 'When does the  migration end?',
      answer: 'It ends in March [1].\n',
      sources,
    });
    assert.equal(
      block,
      [
        '### 14:05 — When does the migration end?',
        '',
        'It ends in March [1].',
        '',
        'Sources: IAM roadmap; Vendors › SSO › Pricing; Transcript 14:03',
      ].join('\n'),
    );
  });

  it('omits the sources line when there are none', () => {
    assert.equal(
      formatInsight({ clockTime: '09:00', question: 'Is there a plan?', answer: 'Not in the notes.', sources: [] }),
      '### 09:00 — Is there a plan?\n\nNot in the notes.',
    );
  });

  it('writes no wikilinks and lists a note once', () => {
    const block = formatInsight({
      clockTime: '10:30',
      question: 'Que dit [[Camille Roy|Camille]] ?',
      answer: 'Voir [[IAM roadmap]] [1].',
      sources: [
        { n: 1, kind: 'note', title: '[[IAM roadmap]]', heading: 'Plan', text: 'a' },
        { n: 2, kind: 'note', title: 'IAM roadmap', heading: 'Plan', text: 'b' },
      ],
    });
    assert.equal(block, '### 10:30 — Que dit Camille ?\n\nVoir IAM roadmap [1].\n\nSources: IAM roadmap › Plan');
    assert.equal(block.includes('[['), false);
  });
});

describe('answerQuestion', () => {
  it('answers through the queue with the documented options and streams the text', async () => {
    const t = setup();
    const out = await answerQuestion(t.deps, question(), t.onText);

    assert.equal(out, 'The migration ends in March [1].');
    assert.equal(t.llm.requests.length, 1);
    const req = t.llm.requests[0];
    assert.equal(req.model, 'gemma4:12b');
    assert.equal(req.numCtx, 16384);
    assert.equal(req.numPredict, 400);
    assert.equal(req.temperature, 0.4);
    assert.equal(req.topK, 40);
    assert.equal(req.topP, 0.9);
    assert.equal(req.repeatPenalty, 1.05);
    assert.equal(req.keepAlive, '5m');
    assert.deepEqual(t.scheduler.calls, [{ model: 'gemma4:12b', priority: 'interactive', key: null }]);

    const user = userOf(req);
    assert.ok(user.includes('[1] IAM roadmap\nThe migration ends in March.'));
    assert.ok(user.includes('<transcript>\n[14:03] Alex: we said March for the migration\n</transcript>'));
    assert.ok(user.includes('<shorthand>\nmigration march\nvendor quote sso\n</shorthand>'));
    assert.ok(user.endsWith('Question: When does the migration end?'));
    assert.match(req.messages[0].content, /Answer in English/);

    assert.deepEqual(t.texts.slice(0, 2), ['The', 'The migration']);
    assert.equal(t.texts[t.texts.length - 1], out);
    assert.equal(t.usages.length, 1);
  });

  it('answers in the language of the question', async () => {
    const t = setup();
    await answerQuestion(t.deps, question({ question: 'Quand est-ce que la migration se termine pour nous ?' }), t.onText);
    assert.match(t.llm.requests[0].messages[0].content, /Answer in French/);
  });

  it('reads a short question the way a line of shorthand is read', async () => {
    const t = setup();
    await answerQuestion(t.deps, question({ question: 'Nadia absente jusqu’à quand ?', shorthand: [] }), t.onText);
    assert.match(t.llm.requests[0].messages[0].content, /Answer in French/);
    await answerQuestion(t.deps, question({ question: 'Is the Nordvik invoice paid?', shorthand: ['le budget est à revoir avec le comité'] }), t.onText);
    assert.match(t.llm.requests[1].messages[0].content, /Answer in English/);
  });

  it('asks for the language of the question when it cannot tell, not for the language of the notes', async () => {
    const t = setup();
    const terse = "Budget l'IAM 2027?";
    await answerQuestion(
      t.deps,
      question({ question: terse, shorthand: ['le budget est à revoir avec le comité', 'il faut une soumission'] }),
      t.onText,
    );
    const system = t.llm.requests[0].messages[0].content;
    assert.match(system, /Answer in the language the question is asked in/);
    assert.doesNotMatch(system, /Answer in (French|English)/);
  });

  it('takes a bare question for English, and one typed the French way for French', () => {
    assert.equal(questionLanguage('Go-live date?'), 'en');
    assert.equal(questionLanguage('Trainer name?'), 'en');
    assert.equal(questionLanguage('Budget Balise ?'), 'fr');
    assert.equal(questionLanguage('Délai de paiement ?'), 'fr');
    assert.equal(questionLanguage("Statut de l'audit?"), 'fr');
    assert.equal(questionLanguage('IAM 2027 Q4?'), 'en');
    assert.equal(questionLanguage('???'), null);
  });

  it('keeps the number of a citation that also names the transcript', async () => {
    const t = setup();
    t.llm.text = 'Staging is due on October 30th [1, transcript].';
    assert.equal(await answerQuestion(t.deps, question({}), t.onText), 'Staging is due on October 30th [1].');
  });

  it('drops the brackets that name the transcript from the answer', async () => {
    const t = setup();
    t.llm.text = 'Staging is due on October 30th [transcript]. The connector needs three weeks [Transcript, shorthand].';
    const answer = await answerQuestion(t.deps, question({}), t.onText);
    assert.equal(answer, 'Staging is due on October 30th. The connector needs three weeks.');
  });

  it('strips wikilinks and an "Answer:" label from what the model wrote', async () => {
    const t = setup();
    t.llm.text = 'Answer: see [[IAM roadmap|the roadmap]] [1].';
    const out = await answerQuestion(t.deps, question(), t.onText);
    assert.equal(out, 'see the roadmap [1].');
    assert.ok(t.texts.every((text) => !text.includes('[[')));
  });

  it('keeps the newest transcript lines when the context is too small for all of them', async () => {
    const t = setup({ numCtx: 2048 });
    const tail = Array.from({ length: 200 }, (_unused, i) => `[${String(i).padStart(2, '0')}:00] Alex: line number ${i} of the meeting`).join('\n');
    await answerQuestion(t.deps, question({ transcriptTail: tail }), t.onText);
    const req = t.llm.requests[0];
    const user = userOf(req);
    assert.ok(user.includes('line number 199 of the meeting'));
    assert.equal(user.includes('line number 0 of the meeting'), false);
    const total = req.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    assert.ok(total + 400 <= 2048, `prompt of ${total} tokens fits`);
    // The cut falls between lines.
    const kept = /<transcript>\n([\s\S]*)\n<\/transcript>/.exec(user);
    assert.ok(kept);
    assert.ok(kept[1].split('\n').every((line) => /^\[\d+:00\] Alex: line number \d+ of the meeting$/.test(line)));
  });

  it('cuts the shorthand to what the context leaves beside the sources', async () => {
    // 400 lines of notes, over 12,000 characters: more than a 4,096 context holds beside the answer.
    const notes = Array.from({ length: 400 }, (_unused, i) => `line ${i} budget iam fin oct, vendor quote sso`);
    assert.ok(notes.join('\n').length >= 12_000);
    const t = setup({ numCtx: 4096 });
    const budget = qaSourceBudget(4096, 'When does the migration end?', notes.join('\n'));
    assert.equal(budget, 500);
    await answerQuestion(t.deps, question({ shorthand: notes }), t.onText);
    const req = t.llm.requests[0];
    const total = req.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    assert.ok(total <= 4096 - 400, `prompt of ${total} tokens fits beside the answer`);
    const user = userOf(req);
    assert.ok(user.includes('<shorthand>\nline 0 budget iam fin oct, vendor quote sso\n'));
    assert.equal(user.includes('line 399 budget'), false);
    // The sources and the question are still there, in full.
    assert.ok(user.includes('[1] IAM roadmap\nThe migration ends in March.'));
    assert.ok(user.endsWith('Question: When does the migration end?'));
  });

  it('carries at most 12,000 characters of shorthand, whatever the context', async () => {
    const notes = Array.from({ length: 800 }, (_unused, i) => `line ${i} vendor quote sso, budget iam fin oct`);
    assert.ok(notes.join('\n').length >= 20_000);
    const t = setup();
    await answerQuestion(t.deps, question({ shorthand: notes }), t.onText);
    const block = /<shorthand>\n([\s\S]*)\n<\/shorthand>/.exec(userOf(t.llm.requests[0]));
    assert.ok(block);
    assert.ok(block[1].length <= 12_001, `${block[1].length} characters`);
    assert.ok(block[1].endsWith('…'));
    assert.ok(block[1].startsWith('line 0 vendor quote sso, budget iam fin oct\n'));
  });

  it('rejects at once when the caller aborts', async () => {
    const t = setup();
    t.llm.hold = new Promise<void>(() => {});
    const ctl = new AbortController();
    const run = answerQuestion(t.deps, question(), t.onText, ctl.signal);
    await settle();
    assert.ok(t.texts.length > 0);
    ctl.abort();
    await assert.rejects(run, (e: unknown) => (e as { kind?: string }).kind === 'aborted');
    assert.equal(t.usages.length, 0);
  });

  it('does not call the model for a signal that is already aborted', async () => {
    const t = setup();
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(
      answerQuestion(t.deps, question(), t.onText, ctl.signal),
      (e: unknown) => (e as { kind?: string }).kind === 'aborted',
    );
    assert.equal(t.llm.requests.length, 0);
  });
});
