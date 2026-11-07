import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Excerpt, SourceDoc } from '../src/types.ts';
import {
  ACTIONS_SCHEMA,
  enhanceMessages,
  groupedFigures,
  isGroupedFigure,
  isPersonLabel,
  keepTerms,
  parseEnhance,
  plainLinks,
  qaMessages,
  reduceMessages,
  renderActions,
  sourceLabel,
  summaryMessages,
  windowNotesMessages,
} from '../src/llm/prompts.ts';
import type { EnhancePromptInput, SummaryPromptInput } from '../src/llm/prompts.ts';

const excerpts: Excerpt[] = [
  { id: 'E3', time: '04:10', text: 'on vise la fin octobre pour le budget de la gestion des accès', score: 0.71 },
  { id: 'E7', time: '12:55', text: 'the vendor will send the SSO quote on Friday', score: 0.64 },
];

function enhanceInput(over: Partial<EnhancePromptInput> = {}): EnhancePromptInput {
  return {
    title: '1:1 Camille Roy',
    style: 'standard',
    micLabel: 'Alex',
    glossary: ['IAM', 'Camille Roy'],
    items: [
      { n: 1, text: 'budget iam fin oct', excerptIds: ['E3'] },
      { n: 2, text: 'vendor quote sso', previous: '**SSO:** Vendor quote pending.', excerptIds: ['E7', 'E99'] },
      { n: 3, text: 'revoir le plan', excerptIds: [] },
    ],
    excerpts,
    ...over,
  };
}

function summaryInput(over: Partial<SummaryPromptInput> = {}): SummaryPromptInput {
  return {
    style: 'executive',
    language: 'en',
    title: 'Steering committee',
    date: '2026-10-09',
    shorthand: 'budget iam fin oct\nvendor quote sso',
    transcript: '[00:05] Alex: we need the quote by Friday\n[00:12] Others: understood',
    micLabel: 'Alex',
    glossary: ['IAM'],
    ...over,
  };
}

describe('parseEnhance', () => {
  it('reads clean output', () => {
    const out = parseEnhance(
      '1. **Budget IAM :** Le budget est visé pour la fin octobre.\n2. **SSO:** The vendor sends the quote on Friday.',
    );
    assert.deepEqual(
      [...out],
      [
        [1, '**Budget IAM :** Le budget est visé pour la fin octobre.'],
        [2, '**SSO:** The vendor sends the quote on Friday.'],
      ],
    );
  });

  it('tolerates "1)", "- 1.", a leading "*" and a bold number', () => {
    const out = parseEnhance(
      ['1) **A:** one', '- 2. **B:** two', '* 3. **C:** three', '**4.** **D:** four', '**5. E:** five'].join('\n'),
    );
    assert.equal(out.get(1), '**A:** one');
    assert.equal(out.get(2), '**B:** two');
    assert.equal(out.get(3), '**C:** three');
    assert.equal(out.get(4), '**D:** four');
    assert.equal(out.get(5), '**E:** five');
  });

  it('gives a missing or misplaced bold label the standard shape', () => {
    const out = parseEnhance(
      ['1. Budget: approved for October', '2. **Vendor**: quote on Friday', '3. Appeler le fournisseur demain'].join('\n'),
    );
    assert.equal(out.get(1), '**Budget:** approved for October');
    assert.equal(out.get(2), '**Vendor:** quote on Friday');
    assert.equal(out.get(3), 'Appeler le fournisseur demain');
  });

  it('does not bold a sentence that merely contains a colon', () => {
    const out = parseEnhance('1. Le comité a approuvé le budget de la gestion des accès: 1,2 M$ sur deux ans');
    assert.equal(out.get(1), 'Le comité a approuvé le budget de la gestion des accès: 1,2 M$ sur deux ans');
  });

  it('keeps only the numbers the model answered', () => {
    const out = parseEnhance('1. **A:** one\n3. **C:** three');
    assert.deepEqual([...out.keys()], [1, 3]);
    assert.equal(out.has(2), false);
  });

  it('ignores lines without a number and empty items', () => {
    const out = parseEnhance('**A:** not numbered\n\n2.\n3. **C:** three');
    assert.deepEqual([...out.keys()], [3]);
  });

  it('joins a multi-line item', () => {
    const out = parseEnhance('1. **Budget:** The budget is planned\nfor the end of October.\n2. **SSO:** Quote on Friday.');
    assert.equal(out.get(1), '**Budget:** The budget is planned for the end of October.');
    assert.equal(out.get(2), '**SSO:** Quote on Friday.');
  });

  it('does not read a wrapped line that starts with a figure as a new item', () => {
    const out = parseEnhance('1. **Budget:** The total comes to\n3.5 million over two years.');
    assert.deepEqual([...out.keys()], [1]);
    assert.equal(out.get(1), '**Budget:** The total comes to 3.5 million over two years.');
  });

  it('drops a preamble, a closing remark and a code fence', () => {
    const out = parseEnhance(
      [
        'Here are the 2 enhanced notes:',
        '',
        '```',
        '1. **A:** one',
        '2. **B:** two',
        '```',
        '',
        'Let me know if you need anything else.',
      ].join('\n'),
    );
    assert.deepEqual(
      [...out],
      [
        [1, '**A:** one'],
        [2, '**B:** two'],
      ],
    );
  });

  it('keeps the first answer when a number repeats', () => {
    const out = parseEnhance('1. **A:** one\n1. **A:** again');
    assert.equal(out.get(1), '**A:** one');
  });

  it('parses a partial stream', () => {
    const out = parseEnhance('1. **Budget:** Le budget est\n2. **SS');
    assert.equal(out.get(1), '**Budget:** Le budget est');
    assert.equal(out.get(2), '**SS');
  });

  it('does not glue the next number to the bullet before it', () => {
    assert.deepEqual([...parseEnhance('1. **A:** one\n2')], [[1, '**A:** one']]);
    assert.deepEqual([...parseEnhance('1. **A:** one\n2.')], [[1, '**A:** one']]);
    assert.deepEqual([...parseEnhance('1. **A:** one\n2. **')], [[1, '**A:** one']]);
  });

  it('reads an item whose number sits on its own line', () => {
    assert.deepEqual([...parseEnhance('1.\n**A:** one\n2.\n**B:** two')], [
      [1, '**A:** one'],
      [2, '**B:** two'],
    ]);
  });

  it('strips a checkbox the model added', () => {
    assert.equal(parseEnhance('1. [ ] **A:** one').get(1), '**A:** one');
  });
});

describe('parseEnhance: a placeholder label', () => {
  // The four shapes gemma4:12b wrote after a literal "**Topic:**".
  it('takes the label from the first line and the text from the next', () => {
    const out = parseEnhance('1. **Topic:** Q1 Budget\nJane wants option B for the Q1 budget.\n2. **Topic:** PCO hiring\nPost the backfill by Friday.');
    assert.deepEqual(
      [...out],
      [
        [1, '**Q1 Budget:** Jane wants option B for the Q1 budget.'],
        [2, '**PCO hiring:** Post the backfill by Friday.'],
      ],
    );
  });

  it('takes the label in front of a colon or a period', () => {
    assert.equal(parseEnhance('1. **Topic:** Capacity Plan: Send the plan to Jane.').get(1), '**Capacity Plan:** Send the plan to Jane.');
    assert.equal(
      parseEnhance('1. **Topic:** Plan de bascule. Revoir le plan avec le réseau.').get(1),
      '**Plan de bascule:** Revoir le plan avec le réseau.',
    );
    assert.equal(parseEnhance('1. Topic: Vendor contract: renewal may slip.').get(1), '**Vendor contract:** renewal may slip.');
  });

  it('does not take an abbreviation for a label', () => {
    assert.equal(parseEnhance('1. **Topic:** M. Tremblay présentera le budget.').get(1), 'M. Tremblay présentera le budget.');
    assert.equal(parseEnhance('1. **Topic:** Dr. Smith joins in May.').get(1), 'Dr. Smith joins in May.');
  });

  it('drops it when nothing can stand as a label', () => {
    assert.equal(
      parseEnhance('1. **Topic:** The vendor contract renewal may slip to November 14 because legal is late').get(1),
      'The vendor contract renewal may slip to November 14 because legal is late',
    );
    assert.equal(parseEnhance('1. **Sujet :** Le fournisseur tarde encore').get(1), 'Le fournisseur tarde encore');
  });

  it('is no bullet when the answer stopped right after it', () => {
    assert.equal(parseEnhance('1. **Budget:** ok\n2. **Topic:**').has(2), false);
    assert.equal(parseEnhance('1. **Topic:**').size, 0);
  });

  it('drops a label that is the item copied, and keeps one that says more as plain words', () => {
    assert.equal(
      parseEnhance('1. **cutover w/e Nov 17, freeze the 10th:** The cutover weekend is Nov 17, with a freeze from the 10th.').get(1),
      'The cutover weekend is Nov 17, with a freeze from the 10th.',
    );
    // "freeze the 10th" is said nowhere else: dropping the label would lose it.
    assert.equal(
      parseEnhance('1. **cutover w/e Nov 17, freeze the 10th:** The cutover is set for the weekend of Nov 17.').get(1),
      'cutover w/e Nov 17, freeze the 10th: The cutover is set for the weekend of Nov 17.',
    );
    assert.equal(
      parseEnhance('1. **Budget Q4 approuvé par le comité de direction:** 40 000 $ de plus pour le marketing.').get(1),
      'Budget Q4 approuvé par le comité de direction: 40 000 $ de plus pour le marketing.',
    );
    assert.equal(parseEnhance('1. **Cutover weekend:** Set for Nov 17.').get(1), '**Cutover weekend:** Set for Nov 17.');
  });

  it('leaves a real label alone', () => {
    assert.equal(parseEnhance('1. **Topics:** Three topics were raised.').get(1), '**Topics:** Three topics were raised.');
    assert.equal(parseEnhance('1. **Title page:** Redo it.').get(1), '**Title page:** Redo it.');
  });
});

describe('enhanceMessages', () => {
  it('is one system message and one user message', () => {
    const messages = enhanceMessages(enhanceInput());
    assert.deepEqual(
      messages.map((m) => m.role),
      ['system', 'user'],
    );
  });

  it('keeps the system text identical across inputs with the same style', () => {
    const a = enhanceMessages(enhanceInput());
    const b = enhanceMessages(
      enhanceInput({
        title: 'Another meeting',
        micLabel: 'Mic (room)',
        glossary: [],
        items: [{ n: 1, text: 'something else', excerptIds: [] }],
        excerpts: [],
      }),
    );
    assert.equal(a[0].content, b[0].content);
    assert.notEqual(a[1].content, b[1].content);
  });

  it('changes the length rule with the style and nothing else in the system text', () => {
    const standard = enhanceMessages(enhanceInput())[0].content;
    const concise = enhanceMessages(enhanceInput({ style: 'concise' }))[0].content;
    assert.notEqual(standard, concise);
    assert.match(standard, /20 to 35 words/);
    assert.match(concise, /at most 12 words/);
    const differing = standard.split('\n').filter((line, i) => line !== concise.split('\n')[i]);
    assert.equal(differing.length, 1);
  });

  it('puts the items last, after the excerpts', () => {
    const user = enhanceMessages(enhanceInput())[1].content;
    assert.ok(user.indexOf('<excerpts>') >= 0);
    assert.ok(user.indexOf('</excerpts>') < user.indexOf('<items>'));
    assert.ok(user.indexOf('</items>') < user.indexOf('<languages>'));
    assert.ok(user.endsWith('</languages>'));
    assert.ok(user.indexOf('<meeting>') < user.indexOf('<excerpts>'));
  });

  it('names the language of each line, last', () => {
    const user = enhanceMessages(
      enhanceInput({
        items: [
          { n: 1, text: 'budget Q1 -> 2 options, Jane veut la B', excerptIds: [] },
          { n: 2, text: 'hiring: backfill, posting by friday', excerptIds: [] },
          { n: 3, text: 'budget ok', excerptIds: [] },
        ],
        excerpts: [],
      }),
    )[1].content;
    assert.ok(user.endsWith('<languages>1: French. 2: English. 3: as written.</languages>'));
  });

  it('lists each item with its excerpts and its previous bullet', () => {
    const user = enhanceMessages(enhanceInput())[1].content;
    assert.ok(user.includes('[E3 04:10] on vise la fin octobre'));
    assert.ok(user.includes('<item n="1" excerpts="E3">budget iam fin oct</item>'));
    // E99 was not handed over: the item must not point at it.
    assert.ok(user.includes('<item n="2" excerpts="E7">vendor quote sso</item>'));
    assert.ok(user.includes('<previous n="2">**SSO:** Vendor quote pending.</previous>'));
    assert.ok(user.includes('<item n="3" excerpts="none">revoir le plan</item>'));
    assert.equal(user.includes('<previous n="1">'), false);
  });

  it('leaves the excerpt block out when there is none', () => {
    const user = enhanceMessages(enhanceInput({ excerpts: [] }))[1].content;
    assert.equal(user.includes('<excerpts>'), false);
    assert.ok(user.includes('<item n="1" excerpts="none">'));
  });

  it('names the note-taker only when the mic label is a person', () => {
    assert.ok(enhanceMessages(enhanceInput())[1].content.includes('<notetaker>Alex</notetaker>'));
    const shared = enhanceMessages(enhanceInput({ micLabel: 'Mic (room)' }))[1].content;
    assert.equal(shared.includes('Mic (room)'), false);
    assert.match(shared, /<notetaker>not identified/);
  });

  it('carries the glossary as known spellings, without duplicates', () => {
    const user = enhanceMessages(enhanceInput({ glossary: ['IAM', 'iam', ' Camille Roy ', ''] }))[1].content;
    assert.ok(user.includes('<spellings>IAM; Camille Roy</spellings>'));
  });

  it('states the rules the product depends on', () => {
    const system = enhanceMessages(enhanceInput())[0].content;
    // No placeholder to copy: gemma4:12b wrote "**Topic:**" as the label of nine bullets in ten.
    assert.equal(system.includes('**Topic:**'), false);
    assert.match(system, /never the word "Topic"/);
    assert.match(system, /never the item copied/);
    assert.match(system, /^1\. \*\*[^*]+:\*\* \S/m);
    assert.match(system, /^2\. \*\*[^*]+:\*\* \S/m);
    assert.match(system, /use it only where it talks about the very thing the item names/);
    assert.match(system, /stays as typed/);
    assert.match(system, /"1 200" never becomes "200"/);
    assert.match(system, /Never translate/);
    assert.match(system, /wikilinks/);
    assert.match(system, /checkboxes/);
  });
});

describe('isPersonLabel', () => {
  it('tells a name from a device', () => {
    for (const name of ['Alex', 'Marie-Ève Côté', "Sam O'Neil"]) assert.equal(isPersonLabel(name), true, name);
    for (const label of ['Mic (room)', 'Microphone', 'Salle 2', 'Others', 'MacBook Pro Microphone', '']) {
      assert.equal(isPersonLabel(label), false, label);
    }
  });
});

describe('summary prompts', () => {
  const all = (messages: Array<{ content: string }>): string => messages.map((m) => m.content).join('\n');

  it('asks for French headings in French', () => {
    const text = all(summaryMessages(summaryInput({ language: 'fr' })));
    assert.ok(text.includes("### Vue d'ensemble"));
    assert.ok(text.includes('### Actions'));
    assert.ok(text.includes('### Détails'));
    assert.match(text, /in French/);
    assert.equal(text.includes('### Overview'), false);
  });

  it('asks for English headings otherwise', () => {
    const text = all(summaryMessages(summaryInput()));
    assert.ok(text.includes('### Overview'));
    assert.ok(text.includes('### Action items'));
    assert.ok(text.includes('### Details'));
    assert.match(text, /in English/);
  });

  it('carries the transcript, the shorthand and the meeting', () => {
    const user = summaryMessages(summaryInput())[1].content;
    assert.ok(user.includes('<meeting>Steering committee, 2026-10-09</meeting>'));
    assert.ok(user.includes('[00:05] Alex: we need the quote by Friday'));
    assert.ok(user.includes('vendor quote sso'));
    assert.ok(user.includes('Lines labelled "Alex" are the note-taker speaking.'));
    assert.ok(user.indexOf('<transcript>') < user.indexOf('Task:'));
  });

  it('keeps the system text the same for every style, so the transcript is read once', () => {
    const executive = summaryMessages(summaryInput());
    const recap = summaryMessages(summaryInput({ style: 'recap' }));
    assert.equal(executive[0].content, recap[0].content);
    const taskAt = executive[1].content.indexOf('Task:');
    assert.equal(executive[1].content.slice(0, taskAt), recap[1].content.slice(0, taskAt));
  });

  it('asks for bullets without headings in a recap', () => {
    const user = summaryMessages(summaryInput({ style: 'recap' }))[1].content;
    assert.match(user, /5 to 12 bullets/);
    assert.equal(user.includes('###'), false);
  });

  it('asks for JSON in the actions style', () => {
    const user = summaryMessages(summaryInput({ style: 'actions', language: 'fr' }))[1].content;
    assert.ok(user.includes('{"items":[{"owner":"","task":"","due":""}]}'));
    assert.match(user, /one sentence in French/);
  });

  it('does not attribute a shared microphone to the note-taker', () => {
    const user = summaryMessages(summaryInput({ micLabel: 'Mic (room)' }))[1].content;
    assert.match(user, /<notetaker>Not identified\. The "Mic \(room\)" channel/);
  });

  it('builds the map step for one window', () => {
    const messages = windowNotesMessages({
      language: 'fr',
      title: 'Comité directeur',
      window: '10:00 to 20:00',
      transcript: '[10:02] Alex: on reporte la migration',
      micLabel: 'Alex',
      glossary: [],
    });
    assert.equal(messages.length, 2);
    assert.ok(messages[1].content.includes('<part>10:00 to 20:00</part>'));
    assert.ok(messages[1].content.includes('[10:02] Alex: on reporte la migration'));
    assert.match(messages[1].content, /4 to 8 bullets \("- "\) in French/);
  });

  it('builds the reduce step from window notes, with no transcript', () => {
    const { transcript: _unused, ...rest } = summaryInput({ language: 'fr' });
    const messages = reduceMessages({ ...rest, windowNotes: '[00:00 to 10:00]\n- Migration reportée' });
    const user = messages[1].content;
    assert.ok(user.includes('<notes>\n[00:00 to 10:00]\n- Migration reportée\n</notes>'));
    assert.equal(user.includes('<transcript>'), false);
    assert.ok(user.includes("### Vue d'ensemble"));
    assert.ok(user.includes('vendor quote sso'));
    assert.match(messages[0].content, /Rely on the notes first/);
  });
});

describe('renderActions', () => {
  const json = JSON.stringify({
    items: [
      { owner: 'Camille', task: 'Send the SSO quote', due: 'Friday' },
      { owner: '', task: 'Book the steering room', due: '' },
      { owner: 'Alex', task: 'Revoir le budget IAM', due: 'none' },
    ],
  });

  it('exposes a schema with the three fields', () => {
    const schema = ACTIONS_SCHEMA as {
      properties: { items: { items: { required: string[] } } };
      required: string[];
    };
    assert.deepEqual(schema.required, ['items']);
    assert.deepEqual(schema.properties.items.items.required, ['owner', 'task', 'due']);
  });

  it('renders valid JSON as a list', () => {
    assert.equal(
      renderActions(json, false, 'en'),
      ['- **Camille**: Send the SSO quote (Friday)', '- Book the steering room', '- **Alex**: Revoir le budget IAM'].join('\n'),
    );
  });

  it('renders checkboxes when asked', () => {
    assert.equal(
      renderActions(json, true, 'en'),
      [
        '- [ ] **Camille**: Send the SSO quote (Friday)',
        '- [ ] Book the steering room',
        '- [ ] **Alex**: Revoir le budget IAM',
      ].join('\n'),
    );
  });

  it('reads JSON wrapped in a code fence', () => {
    const fenced = `Here you go:\n\`\`\`json\n${json}\n\`\`\`\n`;
    assert.equal(renderActions(fenced, false, 'en').split('\n').length, 3);
  });

  it('accepts a bare array', () => {
    assert.equal(renderActions('[{"owner":"Sam","task":"Call the vendor","due":""}]', false, 'en'), '- **Sam**: Call the vendor');
  });

  it('keeps the complete entries of an answer cut at the token limit', () => {
    const cut = '{"items":[{"owner":"Camille","task":"Send the quote","due":"Friday"},{"owner":"Alex","ta';
    assert.equal(renderActions(cut, false, 'en'), '- **Camille**: Send the quote (Friday)');
  });

  it('answers one line when there is nothing to list', () => {
    assert.equal(renderActions('{"items":[]}', false, 'en'), 'No action items.');
    assert.equal(renderActions('{"items":[]}', true, 'fr'), 'Aucune action à retenir.');
  });

  it('answers the same line on garbage', () => {
    assert.equal(renderActions('I could not find any action items.', false, 'en'), 'No action items.');
    assert.equal(renderActions('', false, 'fr'), 'Aucune action à retenir.');
    assert.equal(renderActions('42', false, 'en'), 'No action items.');
  });

  it('takes wikilinks and duplicates out', () => {
    const noisy = JSON.stringify({
      items: [
        { owner: '[[Camille Roy|Camille]]', task: 'Send the [[SSO]] quote', due: '' },
        { owner: 'Camille', task: 'Send the SSO quote', due: '' },
        { owner: 'Alex', task: '   ', due: 'Monday' },
      ],
    });
    assert.equal(renderActions(noisy, false, 'en'), '- **Camille**: Send the SSO quote');
  });
});

describe('qaMessages', () => {
  const sources: SourceDoc[] = [
    { n: 1, kind: 'linked', title: 'IAM roadmap', path: 'notes/IAM roadmap.md', text: 'The migration ends in March.' },
    { n: 2, kind: 'note', title: 'Vendors', path: 'notes/Vendors.md', heading: 'SSO › Pricing', text: 'Quote expected Friday.' },
    { n: 3, kind: 'transcript', title: 'Transcript', time: '14:03', text: 'we said March for the migration' },
  ];

  it('numbers the sources and puts the question last', () => {
    const messages = qaMessages({
      question: 'Quand finit la migration ?',
      language: 'fr',
      title: 'Comité directeur',
      date: '2026-10-09',
      shorthand: 'migration mars',
      transcriptTail: '[14:03] Alex: on a dit mars',
      sources,
    });
    assert.deepEqual(
      messages.map((m) => m.role),
      ['system', 'user'],
    );
    const user = messages[1].content;
    assert.ok(user.includes('[1] IAM roadmap\nThe migration ends in March.'));
    assert.ok(user.includes('[2] Vendors › SSO › Pricing\nQuote expected Friday.'));
    assert.ok(user.includes('[3] Transcript 14:03\nwe said March for the migration'));
    assert.ok(user.endsWith('Question: Quand finit la migration ?'));
    assert.ok(user.indexOf('<sources>') < user.indexOf('<transcript>'));
    assert.match(messages[0].content, /Answer in French/);
    assert.match(messages[0].content, /120 words/);
    assert.match(messages[0].content, /15 February \[2\]/);
    assert.match(messages[0].content, /never as \[transcript\]/);
    assert.match(messages[0].content, /not with the name of who spoke/);
    assert.match(user, /<notetaker>/);
    assert.match(messages[0].content, /No guessing/);
  });

  it('leaves empty blocks out', () => {
    const user = qaMessages({
      question: 'What is the deadline?',
      language: 'en',
      title: 'Steering',
      date: '',
      shorthand: '',
      transcriptTail: '',
      sources: [],
    })[1].content;
    assert.equal(user, '<meeting>Steering</meeting>\n\nQuestion: What is the deadline?');
  });
});

describe('small helpers', () => {
  it('turns wikilinks into plain text', () => {
    assert.equal(plainLinks('see [[Camille Roy|Camille]] and [[notes/IAM#Budget]] and ![[chart.png]]'), 'see Camille and IAM and chart.png');
  });

  it('keeps the heading of a link into the same note', () => {
    assert.equal(plainLinks('voir [[#Budget 2027]] et [[#Risques|les risques]]'), 'voir Budget 2027 et les risques');
    assert.equal(plainLinks('see [[#^a1b2c3]] here'), 'see  here');
  });

  it('opens up a wikilink that a stream has not closed yet', () => {
    assert.equal(plainLinks('see [[IAM road'), 'see IAM road');
    assert.equal(plainLinks('see [[IAM roadmap|the road'), 'see the road');
    assert.equal(plainLinks('see [[IAM roadmap]'), 'see IAM roadmap');
    assert.equal(plainLinks('cited [1] and [2'), 'cited [1] and [2');
  });

  it('labels a source by kind', () => {
    assert.equal(sourceLabel({ n: 1, kind: 'note', title: 'Vendors', heading: 'SSO', text: '' }), 'Vendors › SSO');
    assert.equal(sourceLabel({ n: 2, kind: 'linked', title: 'IAM roadmap', text: '' }), 'IAM roadmap');
    assert.equal(sourceLabel({ n: 3, kind: 'transcript', title: 'Transcript', time: '14:03', text: '' }), 'Transcript 14:03');
  });
});

describe('keepTerms', () => {
  it('keeps digits, names mid-line and capitals', () => {
    assert.deepEqual(keepTerms('vendor contract renewal may slip to Nov'), ['Nov']);
    assert.deepEqual(keepTerms('budget Q1 -> 2 options, Jane veut la B'), ['Q1', 'Jane', 'B']);
    assert.deepEqual(keepTerms('hiring: PCO backfill, posting by friday'), ['PCO', 'friday']);
    // A day or a month is kept whatever its case: "avant jeudi" must not become "avant vendredi".
    assert.deepEqual(keepTerms('dispos fêtes avant jeudi'), ['jeudi']);
    assert.deepEqual(keepTerms('kick-off le 3 nov.'), ['nov']);
    assert.deepEqual(keepTerms('formation outil de suivi sem du 17'), ['17']);
    assert.deepEqual(keepTerms('budget 40k, go-live 2026-11-03'), ['40k', '2026-11-03']);
  });

  it('ignores a capital that only opens the line, lone digits and plain words', () => {
    assert.deepEqual(keepTerms('Budget ok'), []);
    assert.deepEqual(keepTerms("dépendance sur l'équipe réseau pour la bascule"), []);
    assert.deepEqual(keepTerms('I think a plan B exists'), ['B']);
    assert.deepEqual(keepTerms(''), []);
  });

  it('reads through wikilinks and caps the list', () => {
    assert.deepEqual(keepTerms('sync with [[Jane Example|Jane]] re: [[CPR]]'), ['Jane', 'CPR']);
    assert.equal(keepTerms('A1 B2 C3 D4 E5 F6 G7 H8 J9 K10').length, 8);
  });

  it('keeps a figure written in groups whole', () => {
    assert.deepEqual(keepTerms('vague 1 : 1 200 usagers, vague 2 : 4 500 comptes'), ['1 200', '4 500']);
    assert.deepEqual(keepTerms('wave 1 covers 1,200 users'), ['1,200']);
    assert.deepEqual(keepTerms('budget 48 000 $ approuvé'), ['48 000 $']);
    assert.deepEqual(keepTerms('total 1 250 000 $'), ['1 250 000 $']);
    assert.deepEqual(keepTerms('taux 28,5 % en hausse'), ['28,5 %']);
    assert.deepEqual(keepTerms('call at 10:30 with PCO'), ['10:30', 'PCO']);
    // Not a group: a count next to another number.
    assert.deepEqual(keepTerms('3 lots de 25 postes'), ['25']);
  });

  it('adds lone digits only when asked', () => {
    assert.deepEqual(keepTerms('budget Q1 -> 2 options, Jane wants B'), ['Q1', 'Jane', 'B']);
    assert.deepEqual(keepTerms('budget Q1 -> 2 options, Jane wants B', { loneDigits: true }), ['Q1', '2', 'Jane', 'B']);
  });

  it('tells a grouped figure and reads the ones of a bullet as plain numbers', () => {
    assert.equal(isGroupedFigure('1 200'), true);
    assert.equal(isGroupedFigure('48 000 $'), true);
    assert.equal(isGroupedFigure('1,200'), true);
    assert.equal(isGroupedFigure('28,5 %'), false);
    assert.equal(isGroupedFigure('40k'), false);
    assert.deepEqual(groupedFigures('1 200 usagers, 4,500 accounts and 9.800 clients, not 2026'), ['1200', '4500', '9800']);
  });

  it('is listed per item in the prompt, before the languages', () => {
    const user = enhanceMessages(
      enhanceInput({
        items: [
          { n: 1, text: 'vendor contract renewal may slip to Nov', excerptIds: [] },
          { n: 2, text: 'revoir le plan', excerptIds: [] },
        ],
        excerpts: [],
      }),
    )[1].content;
    assert.ok(user.includes('<keep>\n1: "Nov"\n</keep>'));
    assert.ok(user.indexOf('<keep>') < user.indexOf('<languages>'));
  });
});
