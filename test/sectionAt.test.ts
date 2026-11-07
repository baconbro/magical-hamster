import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';

import {
  findSection,
  findWholeWord,
  isLinkLine,
  linkInsertLine,
  listSections,
  parseSectionKey,
  sectionAt,
  sectionKey,
  stripWikilinks,
  wikilinks,
  linkInsertion,
} from '../src/editor/sectionAt.ts';
import type { SectionOptions } from '../src/editor/sectionAt.ts';
import type { Section } from '../src/types.ts';
import { shortHash } from '../src/util/hash.ts';

/* Every note below is synthetic: it copies the shape of a daily, not its text. */

const SOFT = /^(1:1|Ad ?Hoc|Prep|Steering|Rencontre)\b/i;
const NAMES = ['ogov', 'steering board', 'sb', 'jane example', 'iam', 'r&d', 'sam'];
const OPTS: SectionOptions = { softMarker: SOFT, entityNames: NAMES };
const PLAIN: SectionOptions = { softMarker: SOFT };

const doc = (...lines: string[]): string => lines.join('\n');

/** Offset of the first character of a 0-based line. */
function lineStart(text: string, line: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) offset = text.indexOf('\n', offset) + 1;
  return offset;
}

/** Offset just inside the first occurrence of `needle`. */
function inside(text: string, needle: string): number {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `fixture has no "${needle}"`);
  return at + 1;
}

function mustBe(section: Section | null): Section {
  assert.ok(section, 'expected a section');
  return section;
}

const texts = (section: Section): string[] => section.items.map((item) => item.text);
const titles = (text: string, opts: SectionOptions = OPTS): string[] =>
  listSections(text, opts).map((s) => s.title);

describe('wikilinks', () => {
  test('returns targets only', () => {
    assert.deepEqual(wikilinks('1:1 [[Jane Example]]'), ['Jane Example']);
    assert.deepEqual(wikilinks('[[a|b]] [[c#h]] [[dir/d]] [[e#^block|f]]'), ['a', 'c', 'dir/d', 'e']);
    assert.deepEqual(wikilinks('![[embedded]] and [[ spaced ]]'), ['embedded', 'spaced']);
  });

  test('skips links without a target, dedupes, survives broken brackets', () => {
    assert.deepEqual(wikilinks('[[#Heading only]] [[]] [[a]] [[a|again]]'), ['a']);
    assert.deepEqual(wikilinks('[[open [[inner]] ]] [single] [[never closed'), ['inner']);
    assert.deepEqual(wikilinks('no links here'), []);
    assert.deepEqual(wikilinks(''), []);
  });

  test('reads a pipe escaped for a table', () => {
    assert.deepEqual(wikilinks('| `[[IAM\\|identity]]` |'), ['IAM']);
  });

  test('is not confused by a repeated call', () => {
    assert.deepEqual(wikilinks('[[a]] [[b]]'), ['a', 'b']);
    assert.deepEqual(wikilinks('[[a]] [[b]]'), ['a', 'b']);
  });
});

describe('stripWikilinks', () => {
  test('keeps the target, not the alias', () => {
    assert.equal(stripWikilinks('1:1 [[Jane Example]]'), '1:1 Jane Example');
    assert.equal(stripWikilinks('[[a|b]] and [[c#h]]'), 'a and c');
  });

  test('keeps only the last segment of a folder path', () => {
    assert.equal(stripWikilinks('[[10 Work/Projects/IAM]] - dry run'), 'IAM - dry run');
    assert.equal(stripWikilinks('[[dir/a|alias]]'), 'a');
  });

  test('handles embeds, heading-only links and plain text', () => {
    assert.equal(stripWikilinks('see ![[diagram]]'), 'see diagram');
    assert.equal(stripWikilinks('[[#Agenda]]'), 'Agenda');
    assert.equal(stripWikilinks('[[#Agenda|the agenda]]'), 'the agenda');
    assert.equal(stripWikilinks('Steering comittee R&D'), 'Steering comittee R&D');
  });
});

describe('findWholeWord', () => {
  test('requires a boundary on both sides', () => {
    assert.equal(findWholeWord('samedi avec sam', 'sam'), 12);
    assert.equal(findWholeWord('samedi', 'sam'), -1);
    assert.equal(findWholeWord('unisam', 'sam'), -1);
    assert.equal(findWholeWord('weekly sb sync', 'sb'), 7);
  });

  test('treats accented letters and digits as word characters', () => {
    assert.equal(findWholeWord('samé', 'sam'), -1);
    assert.equal(findWholeWord('ésam', 'sam'), -1);
    assert.equal(findWholeWord('sam2', 'sam'), -1);
    assert.equal(findWholeWord('(sam)', 'sam'), 1);
    // A decomposed accent continues the word; an emoji in front of it does not.
    assert.equal(findWholeWord('same\u0301 sam', 'sam'), 6);
    assert.equal(findWholeWord('sam\u0301', 'sam'), -1);
    assert.equal(findWholeWord('🗄️work', 'work'), 3);
    assert.equal(findWholeWord('work🗄️', 'work'), 0);
    assert.equal(findWholeWord('𝒜work', 'work'), -1);
  });

  test('finds names that contain or end with punctuation', () => {
    assert.equal(findWholeWord('steering comittee [[r&d]]', 'r&d'), 20);
    assert.equal(findWholeWord('about c++ today', 'c++'), 6);
    assert.equal(findWholeWord('anything', ''), -1);
  });

  test('searches from an offset', () => {
    assert.equal(findWholeWord('sam and sam', 'sam', 1), 8);
  });
});

describe('section keys', () => {
  test('round trip', () => {
    const key = sectionKey({ title: '1:1 Jane Example', ordinal: 1 });
    assert.equal(key, '1:1 Jane Example#1');
    assert.deepEqual(parseSectionKey(key), { title: '1:1 Jane Example', ordinal: 1 });
  });

  test('split on the last #, because a title may contain one', () => {
    const key = sectionKey({ title: 'Review C# plan #3', ordinal: 0 });
    assert.deepEqual(parseSectionKey(key), { title: 'Review C# plan #3', ordinal: 0 });
    assert.deepEqual(parseSectionKey('#12'), { title: '', ordinal: 12 });
  });

  test('a key without a numeric ordinal reads as ordinal 0', () => {
    assert.deepEqual(parseSectionKey('manual:1700000000'), { title: 'manual:1700000000', ordinal: 0 });
    assert.deepEqual(parseSectionKey('Review C#'), { title: 'Review C#', ordinal: 0 });
  });
});

describe('isLinkLine', () => {
  test('recognises the plugin line', () => {
    assert.equal(isLinkLine('↳ [[Mtg-2026-10-09 — 1-1 Jane Example|Meeting notes]]'), true);
    assert.equal(isLinkLine('   ↳ [[Mtg-2026-10-09 — 1-1 Jane Example|Meeting notes]]\r'), true);
  });

  test('rejects anything else', () => {
    assert.equal(isLinkLine('↳ [[Some other note]]'), false);
    assert.equal(isLinkLine('- ↳ [[Mtg-2026-10-09 — x]]'), false);
    assert.equal(isLinkLine('see [[Mtg-2026-10-09 — x]]'), false);
    assert.equal(isLinkLine(''), false);
  });

  test('honours a custom prefix', () => {
    assert.equal(isLinkLine('↳ [[Meet 2026-10-09 — x|Notes]]', 'Meet '), true);
    assert.equal(isLinkLine('↳ [[Mtg-2026-10-09 — x|Notes]]', 'Meet '), false);
  });
});

describe('heading sections', () => {
  const nested = doc(
    '### 1:1 [[Jane Example]]',
    '- budget -> approved',
    '#### Hiring',
    '- [ ] open the req',
    '##### Détails',
    'ligne simple en français',
    '### [[Steering Board]]',
    '- next step',
  );

  test('#### and ##### nest inside a ### meeting as topics', () => {
    const section = mustBe(sectionAt(nested, inside(nested, 'ligne simple'), OPTS));
    assert.equal(section.title, '1:1 Jane Example');
    assert.equal(section.rawTitle, '1:1 [[Jane Example]]');
    assert.deepEqual(section.links, ['Jane Example']);
    assert.equal(section.isHeading, true);
    assert.equal(section.level, 3);
    assert.equal(section.ordinal, 0);
    assert.equal(section.anchorLine, 0);
    assert.equal(section.bodyStartLine, 1);
    assert.equal(section.bodyEndLine, 6);
    assert.equal(section.linkLine, null);
    assert.deepEqual(
      section.items.map((item) => [item.kind, item.text, item.line]),
      [
        ['item', 'budget -> approved', 1],
        ['topic', 'Hiring', 2],
        ['item', 'open the req', 3],
        ['topic', 'Détails', 4],
        ['item', 'ligne simple en français', 5],
      ],
    );
    assert.equal(section.items[2].raw, '- [ ] open the req');
    assert.equal(section.items[2].task, ' ', 'a task line keeps its status');
    assert.equal('task' in section.items[0], false, 'a plain line has none');
    assert.equal(section.items[1].raw, '#### Hiring');
    assert.equal(section.items[0].id, shortHash('budget -> approved'));
  });

  test('a cursor under a #### still resolves to the ### above', () => {
    const section = mustBe(sectionAt(nested, inside(nested, 'open the req'), OPTS));
    assert.equal(section.title, '1:1 Jane Example');
  });

  const parent = doc(
    '## Meetings',
    'intro line',
    '### 1:1 [[Jane Example]]',
    '- a',
    '### [[Steering Board]]',
    '- b',
    '## Later',
    '- c',
  );

  test('a cursor in a ### child of a ## parent resolves to the child', () => {
    const first = mustBe(sectionAt(parent, inside(parent, '- a'), OPTS));
    assert.equal(first.title, '1:1 Jane Example');
    assert.deepEqual([first.bodyStartLine, first.bodyEndLine], [3, 4]);
    assert.deepEqual(texts(first), ['a']);

    const second = mustBe(sectionAt(parent, inside(parent, '- b'), OPTS));
    assert.equal(second.title, 'Steering Board');
    // A level 3 body stops at the level 2 heading that follows.
    assert.deepEqual([second.bodyStartLine, second.bodyEndLine], [5, 6]);
  });

  test('the ## parent owns its children, as topics', () => {
    const section = mustBe(sectionAt(parent, inside(parent, 'intro line'), OPTS));
    assert.equal(section.title, 'Meetings');
    assert.equal(section.level, 2);
    assert.deepEqual([section.bodyStartLine, section.bodyEndLine], [1, 6]);
    assert.deepEqual(
      section.items.map((item) => [item.kind, item.text]),
      [
        ['item', 'intro line'],
        ['topic', '1:1 [[Jane Example]]'],
        ['item', 'a'],
        ['topic', '[[Steering Board]]'],
        ['item', 'b'],
      ],
    );
  });

  test('a # heading runs to the next # heading or the end', () => {
    const text = doc('# Day', '## A', 'x', '### B', 'y', '# Next', 'z');
    const section = mustBe(sectionAt(text, 0, PLAIN));
    assert.equal(section.level, 1);
    assert.deepEqual([section.bodyStartLine, section.bodyEndLine], [1, 5]);
    const last = mustBe(sectionAt(text, text.length, PLAIN));
    assert.deepEqual([last.title, last.bodyStartLine, last.bodyEndLine], ['Next', 6, 7]);
  });

  test('cursor on the heading line itself', () => {
    const start = lineStart(nested, 6);
    const end = start + '### [[Steering Board]]'.length;
    for (const offset of [start, start + 5, end]) {
      const section = mustBe(sectionAt(nested, offset, OPTS));
      assert.equal(section.title, 'Steering Board');
      assert.equal(section.anchorLine, 6);
    }
    // One character earlier is the end of the previous section's last line.
    assert.equal(mustBe(sectionAt(nested, start - 1, OPTS)).title, '1:1 Jane Example');
    assert.equal(mustBe(sectionAt(nested, 0, OPTS)).anchorLine, 0);
  });

  test('offsets outside the document are clamped', () => {
    assert.equal(mustBe(sectionAt(nested, 10_000, OPTS)).title, 'Steering Board');
    assert.equal(mustBe(sectionAt(nested, -5, OPTS)).title, '1:1 Jane Example');
    assert.equal(mustBe(sectionAt(nested, Number.NaN, OPTS)).title, '1:1 Jane Example');
  });

  test('null before the first anchor', () => {
    const text = doc('loose line', '', '### [[Steering Board]]', '- x');
    assert.equal(sectionAt(text, 3, OPTS), null);
    assert.equal(mustBe(sectionAt(text, inside(text, '- x'), OPTS)).title, 'Steering Board');
  });

  test('heading syntax edge cases', () => {
    const text = doc(
      '#tag is not a heading',
      '####### seven hashes is not a heading',
      '    ### indented four spaces is code',
      '\t### indented with a tab is code too',
      '### Review C#',
      'a',
      '###   Closed heading   ###',
      'b',
      '   ## Indented three ##',
      'c',
      '###',
      'd',
    );
    const sections = listSections(text, PLAIN);
    assert.deepEqual(
      sections.map((s) => [s.title, s.level, s.anchorLine]),
      [
        ['Review C#', 3, 4],
        ['Closed heading', 3, 6],
        ['Indented three', 2, 8],
        ['', 3, 10],
      ],
    );
    assert.deepEqual(texts(mustBe(sectionAt(text, lineStart(text, 11), PLAIN))), ['d']);
  });
});

describe('meeting-like headings', () => {
  const text = doc(
    '# 2026-10-09',
    '### 1:1 [[Jane Example]]',
    '### [[Steering Board]]',
    '### Steering comittee [[R&D]]',
    '### Prep 1:1 [[Jane Example]]',
    '### [[IAM]] - dry run',
    '### Rencontre équipe',
    '### Weekly SB sync',
    '### Budget for Steering Board',
    '### 🗄️Work',
    '### Priority 1:',
    '### Block 1 · Outcome ownership',
    '### Samedi plans',
    '### See [[#Agenda]]',
  );

  test('wikilink, meeting word or entity name', () => {
    const flags = Object.fromEntries(listSections(text, OPTS).map((s) => [s.rawTitle, s.meetingLike]));
    assert.deepEqual(flags, {
      '2026-10-09': false,
      '1:1 [[Jane Example]]': true,
      '[[Steering Board]]': true,
      'Steering comittee [[R&D]]': true,
      'Prep 1:1 [[Jane Example]]': true,
      '[[IAM]] - dry run': true,
      'Rencontre équipe': true,
      'Weekly SB sync': true,
      'Budget for Steering Board': true,
      '🗄️Work': false,
      'Priority 1:': false,
      'Block 1 · Outcome ownership': false,
      // "sam" is a name, but not as part of another word.
      'Samedi plans': false,
      'See [[#Agenda]]': false,
    });
  });

  test('entity names only count when they are given', () => {
    const flags = Object.fromEntries(listSections(text, PLAIN).map((s) => [s.rawTitle, s.meetingLike]));
    assert.equal(flags['Weekly SB sync'], false);
    assert.equal(flags['Budget for Steering Board'], false);
    assert.equal(flags['Rencontre équipe'], true);
  });

  test('summaries carry title, links, level and line', () => {
    const [, first] = listSections(text, OPTS);
    assert.deepEqual(first, {
      title: '1:1 Jane Example',
      rawTitle: '1:1 [[Jane Example]]',
      links: ['Jane Example'],
      ordinal: 0,
      isHeading: true,
      level: 3,
      anchorLine: 1,
      meetingLike: true,
    });
  });

  test('a wikilink alone is enough, with no registry and no meeting word', () => {
    const linked = doc('### [[Unknown Project]] - dry run', '', 'Prep the deck', '', '### Loose notes', '', 'Prep the deck');
    assert.deepEqual(
      listSections(linked, PLAIN).map((s) => [s.title, s.meetingLike, s.anchorLine]),
      [
        ['Unknown Project - dry run', true, 0],
        ['Loose notes', false, 4],
        // Only the line under the heading that is not a meeting starts a section of its own.
        ['Prep the deck', true, 6],
      ],
    );
  });

  test('entity names are matched whatever their case', () => {
    const sections = listSections('### Weekly sb sync', { softMarker: SOFT, entityNames: ['SB'] });
    assert.equal(sections[0].meetingLike, true);
  });
});

describe('soft markers', () => {
  test('one soft marker owns 70 blank-separated lines', () => {
    const lines = ['1:1 Maya', ''];
    for (let i = 1; i <= 70; i++) lines.push(`pensée ${i} -> suivi à faire`, '');
    const text = lines.join('\n');

    assert.deepEqual(titles(text), ['1:1 Maya']);
    for (const offset of [0, inside(text, 'pensée 1 '), inside(text, 'pensée 35 '), text.length]) {
      const section = mustBe(sectionAt(text, offset, OPTS));
      assert.equal(section.title, '1:1 Maya');
      assert.equal(section.isHeading, false);
      assert.equal(section.level, 0);
      assert.equal(section.anchorLine, 0);
      assert.equal(section.bodyStartLine, 1);
      assert.equal(section.bodyEndLine, lines.length);
      assert.equal(section.items.length, 70);
      assert.equal(section.items[69].text, 'pensée 70 -> suivi à faire');
      assert.equal(section.to, text.length);
    }
  });

  test('a body ends at the next soft marker or the next heading up to level 3, never at ####', () => {
    const text = doc(
      '1:1 Maya',
      '',
      'first thought',
      '',
      '#### side topic',
      'still Maya',
      '',
      'Rencontre avec Léa, Maya et Tom et Noé.',
      '',
      'second thought',
      '### 🗄️Work',
      '- [ ] task',
    );
    const sections = listSections(text, OPTS);
    assert.deepEqual(
      sections.map((s) => [s.title, s.isHeading, s.level, s.meetingLike, s.anchorLine]),
      [
        ['1:1 Maya', false, 0, true, 0],
        ['Rencontre avec Léa, Maya et Tom et Noé.', false, 0, true, 7],
        ['🗄️Work', true, 3, false, 10],
      ],
    );
    const maya = mustBe(sectionAt(text, inside(text, 'still Maya'), OPTS));
    assert.deepEqual([maya.bodyStartLine, maya.bodyEndLine], [1, 7]);
    assert.deepEqual(
      maya.items.map((item) => [item.kind, item.text]),
      [
        ['item', 'first thought'],
        ['topic', 'side topic'],
        ['item', 'still Maya'],
      ],
    );
    const meeting = mustBe(sectionAt(text, inside(text, 'second thought'), OPTS));
    assert.deepEqual([meeting.bodyStartLine, meeting.bodyEndLine], [8, 10]);
  });

  const mixed = doc(
    '### 1:1 [[Jane Example]]',
    '- point',
    '',
    'Prep the deck',
    '',
    'OGOV',
    '',
    '### 🗄️Work',
    '- [ ] ship it',
    '',
    '1:1 Sam',
    'talked about onboarding',
    '',
    'Prep the deck for Monday',
    '- slides',
  );

  test('a soft-marker-looking line inside a meeting heading is not an anchor', () => {
    const anchors = listSections(mixed, OPTS).map((s) => s.anchorLine);
    assert.ok(!anchors.includes(3));
    assert.ok(!anchors.includes(5));
    const section = mustBe(sectionAt(mixed, inside(mixed, 'Prep the deck'), OPTS));
    assert.equal(section.title, '1:1 Jane Example');
    assert.deepEqual(texts(section), ['point', 'Prep the deck', 'OGOV']);
  });

  test('a soft marker inside a non-meeting heading is an anchor', () => {
    assert.deepEqual(titles(mixed), [
      '1:1 Jane Example',
      '🗄️Work',
      '1:1 Sam',
      'Prep the deck for Monday',
    ]);
    const sam = mustBe(sectionAt(mixed, inside(mixed, 'talked about'), OPTS));
    assert.equal(sam.title, '1:1 Sam');
    assert.equal(sam.isHeading, false);
    assert.deepEqual([sam.anchorLine, sam.bodyStartLine, sam.bodyEndLine], [10, 11, 13]);
    assert.deepEqual(texts(sam), ['talked about onboarding']);

    // The heading itself still owns everything down to the next heading.
    const work = mustBe(sectionAt(mixed, inside(mixed, 'ship it'), OPTS));
    assert.equal(work.title, '🗄️Work');
    assert.deepEqual([work.bodyStartLine, work.bodyEndLine], [8, 15]);
  });

  test('an entity name is an anchor only when it is the whole line', () => {
    const text = doc(
      '# 2026-10-09',
      '',
      'OGOV',
      '',
      '- budget freeze',
      '',
      'OGOV wants the report by Friday',
      '',
      '[[Steering Board]]:',
      '',
      '- agenda',
      '',
      'sb.',
      '',
      '[[Governance/Steering Board|the board]]',
      '',
      'Jane   Example :',
    );
    assert.deepEqual(
      listSections(text, OPTS).map((s) => [s.title, s.anchorLine, s.links]),
      [
        ['2026-10-09', 0, []],
        ['OGOV', 2, []],
        ['Steering Board:', 8, ['Steering Board']],
        ['sb.', 12, []],
        ['Steering Board', 14, ['Governance/Steering Board']],
        ['Jane Example :', 16, []],
      ],
    );
    const ogov = mustBe(sectionAt(text, inside(text, 'wants the report'), OPTS));
    assert.equal(ogov.title, 'OGOV');
    assert.deepEqual(texts(ogov), ['budget freeze', 'OGOV wants the report by Friday']);

    // Without the registry the same line is plain text.
    assert.deepEqual(titles(text, PLAIN), ['2026-10-09']);
  });

  test('what disqualifies a line', () => {
    const long = `1:1 Sam ${'x'.repeat(80)}`;
    const text = doc(
      '### Notes',
      '',
      '- 1:1 Sam',
      '',
      '* Prep slides',
      '',
      '1. Prep slides',
      '',
      '> 1:1 Sam',
      '',
      long,
      '',
      'some text',
      '1:1 Sam',
      '',
      '↳ [[Mtg-2026-10-09 — 1-1 Sam|Meeting notes]]',
      '',
      'Preparation is not Prep',
    );
    assert.deepEqual(titles(text), ['Notes']);
  });

  test('what qualifies a line', () => {
    const exactly80 = `1:1 ${'x'.repeat(76)}`;
    assert.equal(exactly80.length, 80);
    const text = doc(
      '### Notes',
      '1:1 Sam',
      'body',
      '#### sub',
      'Ad Hoc with the vendor',
      '',
      '   AdHoc indented',
      '',
      exactly80,
    );
    assert.deepEqual(titles(text), ['Notes', '1:1 Sam', 'Ad Hoc with the vendor', 'AdHoc indented', exactly80]);
  });

  test('80 characters is the last length that qualifies', () => {
    const tooLong = `1:1 ${'x'.repeat(77)}`;
    assert.equal(tooLong.length, 81);
    assert.deepEqual(titles(doc('### Notes', '', tooLong)), ['Notes']);
    // Measured without the indentation and the trailing spaces.
    assert.deepEqual(titles(doc('### Notes', '', `   ${tooLong.slice(0, 80)}   `)), ['Notes', tooLong.slice(0, 80)]);
  });

  test('a quote, a list item and the link line are ruled out by their shape, whatever the pattern', () => {
    // Not anchored at the start of the line, so the pattern itself matches every line below.
    const loose: SectionOptions = { softMarker: /Sam/i };
    const text = doc(
      '### Notes',
      '',
      '> 1:1 Sam',
      '',
      '- 1:1 Sam',
      '',
      '* Sam',
      '',
      '+ Sam',
      '',
      '12. Sam',
      '',
      '↳ [[Mtg-2026-10-09 — 1-1 Sam|Meeting notes]]',
      '',
      '  ↳ [[Mtg-2026-10-09 — 1-1 Sam|Meeting notes]]',
      '',
      'with Sam',
    );
    assert.deepEqual(
      listSections(text, loose).map((s) => [s.title, s.anchorLine]),
      [
        ['Notes', 0],
        ['with Sam', 16],
      ],
    );
  });

  test('the link line is looked through under the configured prefix only', () => {
    const custom = '↳ [[Meet 2026-10-09 — Work|Notes]]';
    const text = doc('### 🗄️Work', custom, '1:1 Sam', 'note');
    assert.deepEqual(titles(text, { ...OPTS, linkPrefix: 'Meet ' }), ['🗄️Work', '1:1 Sam']);
    // Under the default prefix that line is ordinary text, and the marker is glued to it.
    assert.deepEqual(titles(text, OPTS), ['🗄️Work']);
  });

  test('the first line of a document can be a soft marker', () => {
    assert.deepEqual(titles(doc('1:1 Sam', 'note')), ['1:1 Sam']);
    assert.deepEqual(titles(doc('', '', '1:1 Sam', 'note')), ['1:1 Sam']);
  });

  test('the plugin link line above a soft marker does not hide it', () => {
    const link = '↳ [[Mtg-2026-10-09 — Work|Meeting notes]]';
    const before = doc('### 🗄️Work', '1:1 Sam', 'note', '', 'OGOV', 'more');
    const after = doc('### 🗄️Work', link, '1:1 Sam', 'note', '', link, 'OGOV', 'more');
    assert.deepEqual(titles(before), ['🗄️Work', '1:1 Sam', 'OGOV']);
    assert.deepEqual(titles(after), ['🗄️Work', '1:1 Sam', 'OGOV']);
    assert.deepEqual(titles(doc(link, '1:1 Sam', 'note')), ['1:1 Sam']);
    assert.deepEqual(titles(doc('---', 'x: 1', '---', link, '1:1 Sam')), ['1:1 Sam']);
    // Looked through, not treated as a blank line.
    assert.deepEqual(titles(doc('### 🗄️Work', 'text', link, '1:1 Sam')), ['🗄️Work']);
  });

  test('a soft marker keeps its wikilinks', () => {
    const text = doc('1:1 [[Jane Example|Jane]]', '', 'note');
    const section = mustBe(sectionAt(text, text.length, OPTS));
    assert.equal(section.title, '1:1 Jane Example');
    assert.equal(section.rawTitle, '1:1 [[Jane Example|Jane]]');
    assert.deepEqual(section.links, ['Jane Example']);
  });

  test('a global or sticky pattern does not carry state between lines', () => {
    const text = doc('1:1 Sam', '', 'a', '', '1:1 Alex', '', 'b', '', '1:1 Robin', '', 'c');
    for (const flags of ['gi', 'iy']) {
      const opts = { softMarker: new RegExp(SOFT.source, flags) };
      assert.deepEqual(titles(text, opts), ['1:1 Sam', '1:1 Alex', '1:1 Robin']);
      assert.deepEqual(titles(text, opts), ['1:1 Sam', '1:1 Alex', '1:1 Robin']);
    }
  });
});

describe('inert regions', () => {
  const text = doc(
    '---',
    'title: 1:1 Sam',
    'tags: [meeting]',
    '---',
    '1:1 Sam',
    'note one',
    '',
    '```md',
    '### 1:1 [[Fake Person]]',
    '',
    '1:1 Ghost',
    '```',
    '',
    'note two',
    '~~~',
    '### not a heading',
    '```',
    '~~~',
    '',
    '- ```inline```',
    '  ```',
    '  ### nested under a list item',
    '  ```',
    'note three',
  );

  test('frontmatter holds no anchor and the cursor in it has no section', () => {
    assert.equal(sectionAt(text, 0, OPTS), null);
    assert.equal(sectionAt(text, inside(text, 'title: 1:1 Sam'), OPTS), null);
    assert.equal(sectionAt(text, lineStart(text, 3), OPTS), null);
  });

  test('the first line after frontmatter can be a soft marker', () => {
    assert.deepEqual(
      listSections(text, OPTS).map((s) => [s.title, s.anchorLine]),
      [['1:1 Sam', 4]],
    );
  });

  test('fenced lines are neither anchors nor items', () => {
    const section = mustBe(sectionAt(text, text.length, OPTS));
    assert.deepEqual(texts(section), ['note one', 'note two', '```inline```', 'note three']);
    // A cursor inside the fence still belongs to the section around it.
    assert.equal(mustBe(sectionAt(text, inside(text, '1:1 Ghost'), OPTS)).title, '1:1 Sam');
  });

  test('a closing fence must match the opening one', () => {
    const fenced = doc('### [[Steering Board]]', '````', '```', '### inside', '````', 'after');
    assert.deepEqual(titles(fenced), ['Steering Board']);
    assert.deepEqual(texts(mustBe(sectionAt(fenced, 0, OPTS))), ['after']);
  });

  test('an unclosed fence swallows the rest of the note', () => {
    const open = doc('### [[Steering Board]]', 'before', '```', '### inside', 'code');
    assert.deepEqual(titles(open), ['Steering Board']);
    assert.deepEqual(texts(mustBe(sectionAt(open, 0, OPTS))), ['before']);
  });

  test('an unclosed --- on the first line is a rule, not frontmatter', () => {
    const open = doc('---', '### [[Steering Board]]', '- x');
    assert.deepEqual(titles(open), ['Steering Board']);
    const late = doc('intro', '---', 'title: x', '---', '### [[Steering Board]]');
    assert.deepEqual(titles(late), ['Steering Board']);
  });
});

describe('items', () => {
  test('list markers and checkboxes are removed from the text, not from raw', () => {
    const text = doc(
      '### [[Steering Board]]',
      '- dash',
      '* star',
      '+ plus',
      '1. numbered',
      '2) parenthesis',
      '- [ ] open task',
      '* [x] done task',
      '- [/] in progress',
      '\t- nested -> with arrow',
      '    - [ ] nested task',
      'plain line  ',
      '> quoted',
      '- [[Jane Example]] said yes',
      '-not a list',
    );
    const section = mustBe(sectionAt(text, 0, OPTS));
    assert.deepEqual(texts(section), [
      'dash',
      'star',
      'plus',
      'numbered',
      'parenthesis',
      'open task',
      'done task',
      'in progress',
      'nested -> with arrow',
      'nested task',
      'plain line',
      '> quoted',
      '[[Jane Example]] said yes',
      '-not a list',
    ]);
    assert.equal(section.items[8].raw, '\t- nested -> with arrow');
    assert.equal(section.items[10].raw, 'plain line  ');
    assert.ok(section.items.every((item) => item.kind === 'item'));
    assert.deepEqual(
      section.items.map((item) => item.line),
      Array.from({ length: 14 }, (_, i) => i + 1),
    );
  });

  test('blank lines, rules and empty bullets are not items', () => {
    const text = doc(
      '### [[Steering Board]]',
      '',
      '---',
      '***',
      '_ _ _',
      '- - -',
      '- ',
      '-',
      '- [ ] ',
      '- [ ]',
      '####',
      '   ',
      'kept',
      '--',
    );
    assert.deepEqual(texts(mustBe(sectionAt(text, 0, OPTS))), ['kept', '--']);
  });

  test('duplicate lines get #2, #3', () => {
    const text = doc(
      '### [[Steering Board]]',
      '- follow up',
      'other',
      '- [ ] follow up',
      '#### follow up',
      '### [[IAM]]',
      '- follow up',
    );
    const hash = shortHash('follow up');
    const section = mustBe(sectionAt(text, 0, OPTS));
    assert.deepEqual(
      section.items.map((item) => item.id),
      [hash, shortHash('other'), `${hash}#2`, `${hash}#3`],
    );
    assert.equal(new Set(section.items.map((item) => item.id)).size, section.items.length);
    // Counting starts again in the next section.
    assert.deepEqual(
      mustBe(sectionAt(text, text.length, OPTS)).items.map((item) => item.id),
      [hash],
    );
  });

  test('ids are stable when other lines change', () => {
    const before = doc('### [[IAM]]', '- alpha', '- beta');
    const after = doc('### [[IAM]]', '- new first line', '- alpha', '', '* beta');
    const ids = (text: string): Map<string, string> =>
      new Map(mustBe(sectionAt(text, 0, OPTS)).items.map((item) => [item.text, item.id]));
    assert.equal(ids(after).get('alpha'), ids(before).get('alpha'));
    assert.equal(ids(after).get('beta'), ids(before).get('beta'));
  });

  test('the link line is not an item and is reported in linkLine', () => {
    const text = doc(
      '### 1:1 [[Jane Example]]',
      '- point',
      '↳ [[Mtg-2026-10-09 — 1-1 Jane Example|Meeting notes]]',
      '',
      '### [[Steering Board]]',
      '- other',
      '↳ [[Some unrelated note]]',
    );
    const first = mustBe(sectionAt(text, 0, OPTS));
    assert.deepEqual(texts(first), ['point']);
    assert.equal(first.linkLine, 2);

    const second = mustBe(sectionAt(text, text.length, OPTS));
    assert.equal(second.linkLine, null);
    assert.deepEqual(texts(second), ['other', '↳ [[Some unrelated note]]']);
  });

  test('the link line follows the configured prefix', () => {
    const text = doc('### [[IAM]]', '- point', '↳ [[Meet 2026-10-09 — IAM|Notes]]');
    const custom = mustBe(sectionAt(text, 0, { ...OPTS, linkPrefix: 'Meet ' }));
    assert.equal(custom.linkLine, 2);
    assert.deepEqual(texts(custom), ['point']);
    const standard = mustBe(sectionAt(text, 0, OPTS));
    assert.equal(standard.linkLine, null);
    assert.equal(standard.items.length, 2);
  });
});

describe('ordinals', () => {
  const text = doc(
    '### 1:1 [[Jane Example]]',
    '- morning',
    '### Notes',
    '',
    '1:1 Jane Example',
    'midday, without a heading',
    '### 1:1 [[Jane Example|Jane]]',
    '- afternoon',
    '### [[Steering Board]]',
  );

  test('duplicate titles get ordinals 0, 1, 2 across both kinds of anchor', () => {
    assert.deepEqual(
      listSections(text, OPTS).map((s) => [s.title, s.ordinal, s.isHeading]),
      [
        ['1:1 Jane Example', 0, true],
        ['Notes', 0, true],
        ['1:1 Jane Example', 1, false],
        ['1:1 Jane Example', 2, true],
        ['Steering Board', 0, true],
      ],
    );
    assert.equal(mustBe(sectionAt(text, inside(text, '- morning'), OPTS)).ordinal, 0);
    assert.equal(mustBe(sectionAt(text, inside(text, 'midday'), OPTS)).ordinal, 1);
    assert.equal(mustBe(sectionAt(text, inside(text, '- afternoon'), OPTS)).ordinal, 2);
  });

  test('sectionAt and listSections agree on every anchor', () => {
    for (const summary of listSections(text, OPTS)) {
      const section = mustBe(sectionAt(text, lineStart(text, summary.anchorLine), OPTS));
      assert.equal(sectionKey(section), sectionKey(summary));
      assert.equal(section.anchorLine, summary.anchorLine);
      assert.equal(section.rawTitle, summary.rawTitle);
      assert.deepEqual(section.links, summary.links);
      assert.equal(section.isHeading, summary.isHeading);
      assert.equal(section.level, summary.level);
    }
  });
});

describe('findSection', () => {
  const basename = 'Mtg-2026-10-09 — 1-1 Jane Example';
  const text = doc(
    '### 1:1 [[Jane Example]]',
    '- morning',
    '### [[Steering Board]]',
    '- agenda',
    '### 1:1 [[Jane Example]]',
    '- afternoon',
    `↳ [[${basename}|Meeting notes]]`,
    '',
  );

  test('by title and ordinal', () => {
    const first = mustBe(findSection(text, { title: '1:1 Jane Example', ordinal: 0 }, OPTS));
    assert.equal(first.anchorLine, 0);
    assert.deepEqual(texts(first), ['morning']);
    const second = mustBe(findSection(text, parseSectionKey('1:1 Jane Example#1'), OPTS));
    assert.equal(second.anchorLine, 4);
    assert.equal(second.linkLine, 6);
    assert.equal(findSection(text, { title: '1:1 Jane Example', ordinal: 2 }, OPTS), null);
    assert.equal(findSection(text, { title: 'Nobody', ordinal: 0 }, OPTS), null);
  });

  test('by companion basename after the heading was renamed', () => {
    const renamed = text.replace('### 1:1 [[Jane Example]]\n- afternoon', '### Catch-up with [[Jane Example]]\n- afternoon');
    assert.equal(findSection(renamed, { title: '1:1 Jane Example', ordinal: 1 }, OPTS), null);
    const found = mustBe(findSection(renamed, { title: '1:1 Jane Example', ordinal: 1 }, OPTS, basename));
    assert.equal(found.title, 'Catch-up with Jane Example');
    assert.equal(found.anchorLine, 4);
    assert.equal(found.linkLine, 6);
  });

  test('by companion basename after an earlier duplicate was deleted', () => {
    const shifted = text.replace('### 1:1 [[Jane Example]]\n- morning\n', '');
    const found = mustBe(findSection(shifted, { title: '1:1 Jane Example', ordinal: 1 }, OPTS, basename));
    assert.equal(found.ordinal, 0);
    assert.deepEqual(texts(found), ['afternoon']);
  });

  test('the link line wins over a key that points at a section without it', () => {
    const found = mustBe(findSection(text, { title: 'Steering Board', ordinal: 0 }, OPTS, basename));
    assert.equal(found.title, '1:1 Jane Example');
    assert.notEqual(found.linkLine, null);
  });

  test('the key is used when no companion basename is given', () => {
    const found = mustBe(findSection(text, { title: 'Steering Board', ordinal: 0 }, OPTS));
    assert.equal(found.title, 'Steering Board');
  });

  test('a longer basename is a different companion', () => {
    const other = doc('### Renamed', `↳ [[${basename} (2)|Meeting notes]]`);
    assert.equal(findSection(other, { title: 'gone', ordinal: 0 }, OPTS, basename), null);
    assert.equal(mustBe(findSection(other, { title: 'gone', ordinal: 0 }, OPTS, `${basename} (2)`)).title, 'Renamed');
  });

  test('a link written with its folder still counts', () => {
    const pathed = doc('### Renamed', `↳ [[00 Inbox/${basename}|Meeting notes]]`);
    assert.equal(mustBe(findSection(pathed, { title: 'gone', ordinal: 0 }, OPTS, basename)).title, 'Renamed');
  });

  test('the plugin line wins over a mention elsewhere, and code is ignored', () => {
    const mentions = doc(
      '### Morning',
      `see [[${basename}]] later`,
      '```',
      `↳ [[${basename}|Meeting notes]]`,
      '```',
      '### Afternoon',
      `↳ [[${basename}|Meeting notes]]`,
    );
    assert.equal(mustBe(findSection(mentions, { title: 'gone', ordinal: 0 }, OPTS, basename)).title, 'Afternoon');
    const onlyMention = doc('### Morning', `see [[${basename}]] later`);
    assert.equal(mustBe(findSection(onlyMention, { title: 'gone', ordinal: 0 }, OPTS, basename)).title, 'Morning');
  });

  test('null when the link sits above every anchor or nowhere', () => {
    const above = doc(`↳ [[${basename}|Meeting notes]]`, '### Later', '- x');
    assert.equal(findSection(above, { title: 'gone', ordinal: 0 }, OPTS, basename), null);
    assert.equal(findSection('### Later', { title: 'gone', ordinal: 0 }, OPTS, basename), null);
    assert.equal(findSection('### Later', { title: 'gone', ordinal: 0 }, OPTS, ''), null);
  });
});

describe('offsets', () => {
  function bodyLines(text: string, section: Section): string {
    const lines = text.split('\n');
    if (section.bodyStartLine === section.bodyEndLine) return '';
    const body = lines.slice(section.bodyStartLine, section.bodyEndLine).join('\n');
    return section.bodyEndLine < lines.length ? `${body}\n` : body;
  }

  const base = doc(
    '# 2026-10-09',
    '',
    '### 1:1 [[Jane Example]]',
    '- émoji 🗄️ and accents',
    '#### Sub',
    'text',
    '',
    '### 🗄️Work',
    '',
    '1:1 Sam',
    '',
    'thought',
    '',
    '### Empty',
    '### [[Steering Board]]',
    'last line',
  );

  for (const [label, text] of [
    ['no trailing newline', base],
    ['trailing newline', `${base}\n`],
    ['trailing blank lines', `${base}\n\n\n`],
    ['CRLF', base.replace(/\n/g, '\r\n')],
    ['CRLF with trailing newline', `${base.replace(/\n/g, '\r\n')}\r\n`],
  ] as const) {
    test(`from/to slice the exact body: ${label}`, () => {
      const sections = listSections(text, OPTS);
      assert.equal(sections.length, 6);
      for (const summary of sections) {
        const section = mustBe(findSection(text, summary, OPTS));
        assert.equal(text.slice(section.from, section.to), bodyLines(text, section), section.title);
        assert.equal(section.from, lineStart(text, section.bodyStartLine));
        assert.ok(section.from <= section.to);
      }
      const last = mustBe(sectionAt(text, text.length, OPTS));
      assert.equal(last.to, text.length);
      assert.equal(last.bodyEndLine, text.split('\n').length);
    });
  }

  test('a section with no body has an empty range', () => {
    const empty = mustBe(findSection(base, { title: 'Empty', ordinal: 0 }, OPTS));
    assert.equal(empty.bodyStartLine, empty.bodyEndLine);
    assert.equal(empty.from, empty.to);
    assert.deepEqual(empty.items, []);
  });

  test('a heading on the last line without a newline', () => {
    const text = doc('intro', '### [[Steering Board]]');
    const section = mustBe(sectionAt(text, text.length, OPTS));
    assert.deepEqual([section.bodyStartLine, section.bodyEndLine], [2, 2]);
    assert.deepEqual([section.from, section.to], [text.length, text.length]);
  });

  test('the soft-marker body runs through blank lines to the next anchor', () => {
    const sam = mustBe(findSection(base, { title: '1:1 Sam', ordinal: 0 }, OPTS));
    assert.equal(base.slice(sam.from, sam.to), '\nthought\n\n');
  });
});

describe('CRLF input', () => {
  const lf = doc(
    '---',
    'x: 1',
    '---',
    '### 1:1 [[Jane Example]]',
    '- [ ] task',
    '```',
    '### fenced',
    '```',
    '↳ [[Mtg-2026-10-09 — 1-1 Jane Example|Meeting notes]]',
    '',
    '### 🗄️Work',
    '',
    'OGOV',
    'note',
    '',
  );
  const crlf = lf.replace(/\n/g, '\r\n');

  test('parses the same as LF', () => {
    assert.deepEqual(listSections(crlf, OPTS), listSections(lf, OPTS));
    const a = mustBe(sectionAt(lf, inside(lf, '- [ ] task'), OPTS));
    const b = mustBe(sectionAt(crlf, inside(crlf, '- [ ] task'), OPTS));
    assert.deepEqual(b.items, a.items);
    assert.equal(b.linkLine, 8);
    assert.equal(b.rawTitle, '1:1 [[Jane Example]]');
    assert.ok(b.items.every((item) => !item.raw.includes('\r') && !item.text.includes('\r')));
  });

  test('offsets point into the original text', () => {
    const section = mustBe(sectionAt(crlf, lineStart(crlf, 13), OPTS));
    assert.equal(section.title, 'OGOV');
    assert.equal(crlf.slice(section.from, section.to), 'note\r\n');
    const jane = mustBe(findSection(crlf, { title: '1:1 Jane Example', ordinal: 0 }, OPTS));
    assert.ok(crlf.slice(jane.from, jane.to).startsWith('- [ ] task\r\n```\r\n'));
    assert.ok(crlf.slice(jane.from, jane.to).endsWith('Meeting notes]]\r\n\r\n'));
  });

  test('a cursor on the \\r or the \\n of a heading line is on that line', () => {
    const start = crlf.indexOf('### 🗄️Work');
    const cr = start + '### 🗄️Work'.length;
    assert.equal(mustBe(sectionAt(crlf, cr, OPTS)).title, '🗄️Work');
    assert.equal(mustBe(sectionAt(crlf, cr + 1, OPTS)).title, '🗄️Work');
  });
});

describe('empty and degenerate documents', () => {
  test('empty document', () => {
    assert.equal(sectionAt('', 0, OPTS), null);
    assert.deepEqual(listSections('', OPTS), []);
    assert.equal(findSection('', { title: '', ordinal: 0 }, OPTS), null);
    assert.equal(findSection('', { title: 'x', ordinal: 0 }, OPTS, 'Mtg-x'), null);
  });

  test('only blank lines, only text, only frontmatter', () => {
    assert.equal(sectionAt('\n\n\n', 2, OPTS), null);
    assert.equal(sectionAt('just a line\nand another', 5, OPTS), null);
    assert.deepEqual(listSections('---\ntitle: x\n---', OPTS), []);
  });

  test('a byte order mark does not hide the first heading', () => {
    const text = '﻿### [[Steering Board]]\n- x';
    const section = mustBe(sectionAt(text, text.length, OPTS));
    assert.equal(section.title, 'Steering Board');
    assert.equal(text.slice(section.from, section.to), '- x');
  });

  test('a heading alone', () => {
    const section = mustBe(sectionAt('### [[Steering Board]]', 3, OPTS));
    assert.deepEqual(section.items, []);
    assert.deepEqual([section.from, section.to], [22, 22]);
  });
});

describe('linkInsertLine', () => {
  const text = doc(
    '### 1:1 [[Jane Example]]',
    '- point one',
    '- point two',
    '',
    '',
    '### Empty',
    '',
    '### [[Steering Board]]',
    '',
    '1:1 Sam',
  );

  test('heading placement is the anchor line', () => {
    const section = mustBe(sectionAt(text, 0, OPTS));
    assert.equal(linkInsertLine(text, section, 'heading'), 0);
    const empty = mustBe(findSection(text, { title: 'Empty', ordinal: 0 }, OPTS));
    assert.equal(linkInsertLine(text, empty, 'heading'), 5);
  });

  test('section-end placement is the last non-blank body line', () => {
    const section = mustBe(sectionAt(text, 0, OPTS));
    assert.equal(linkInsertLine(text, section, 'section-end'), 2);
  });

  test('an empty or blank body falls back to the anchor line', () => {
    const empty = mustBe(findSection(text, { title: 'Empty', ordinal: 0 }, OPTS));
    assert.equal(linkInsertLine(text, empty, 'section-end'), 5);
    const last = mustBe(sectionAt('### [[IAM]]', 0, OPTS));
    assert.equal(linkInsertLine('### [[IAM]]', last, 'section-end'), 0);
    const blank = mustBe(sectionAt('### [[IAM]]\n\n   \n', 0, OPTS));
    assert.equal(linkInsertLine('### [[IAM]]\n\n   \n', blank, 'section-end'), 0);
  });

  test('a body that runs to the end of the document', () => {
    const section = mustBe(findSection(text, { title: 'Steering Board', ordinal: 0 }, OPTS));
    assert.equal(linkInsertLine(text, section, 'section-end'), 9);
  });

  test('section-end goes after a closed code block', () => {
    const fenced = doc('### [[IAM]]', '- point', '```sql', 'select 1;', '```', '', '### Next');
    const section = mustBe(sectionAt(fenced, 0, OPTS));
    assert.equal(linkInsertLine(fenced, section, 'section-end'), 4);
  });

  test('section-end never lands inside an unclosed code block', () => {
    const open = doc('### [[IAM]]', '- point', '', '```sql', 'select 1;', '', 'still code');
    const section = mustBe(sectionAt(open, 0, OPTS));
    assert.equal(section.bodyEndLine, 7);
    assert.equal(linkInsertLine(open, section, 'section-end'), 1);
    const onlyCode = doc('### [[IAM]]', '```', 'code');
    assert.equal(linkInsertLine(onlyCode, mustBe(sectionAt(onlyCode, 0, OPTS)), 'section-end'), 0);
  });

  test('soft-marker sections and CRLF', () => {
    const soft = doc('1:1 Sam', '', 'a', '', 'b', '', '', '### 🗄️Work').replace(/\n/g, '\r\n');
    const section = mustBe(sectionAt(soft, 0, OPTS));
    assert.equal(linkInsertLine(soft, section, 'section-end'), 4);
    assert.equal(linkInsertLine(soft, section, 'heading'), 0);
  });
});

/* A slow, literal reading of the rules, to hold the fast parser against on random notes. */
interface Expected {
  line: number;
  isHeading: boolean;
  level: number;
  title: string;
  meetingLike: boolean;
  ordinal: number;
  bodyEnd: number;
  linkLine: number | null;
  items: Array<[string, string, number]>;
}

function naive(text: string, softMarker: RegExp, names: string[]): Expected[] {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const n = lines.length;
  const inert: boolean[] = new Array<boolean>(n).fill(false);

  if (/^---[ \t]*$/.test(lines[0])) {
    const close = lines.findIndex((line, i) => i > 0 && /^---[ \t]*$/.test(line));
    for (let i = 0; i <= close; i++) inert[i] = true;
  }
  let fence: string | null = null;
  for (let i = 0; i < n; i++) {
    if (inert[i]) continue;
    const m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (fence !== null) {
      inert[i] = true;
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && m[2].trim() === '') fence = null;
    } else if (m && (m[1][0] === '~' || !m[2].includes('`'))) {
      fence = m[1];
      inert[i] = true;
    }
  }

  const blank = (i: number): boolean => !inert[i] && lines[i].trim() === '';
  const heading = (i: number): { level: number; text: string } | null => {
    if (inert[i]) return null;
    const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(lines[i]);
    if (!m) return null;
    let body = (m[2] ?? '').trim();
    body = /^#+$/.test(body) ? '' : body.replace(/[ \t]+#+$/, '').trim();
    return { level: m[1].length, text: body };
  };
  const targets = (line: string): string[] =>
    [...line.matchAll(/\[\[([^[\]\n]+)\]\]/g)]
      .map((m) => m[1].split('|')[0].split('#')[0].trim())
      .filter((target) => target !== '');
  const strip = (line: string): string =>
    line
      .replace(/!?\[\[([^[\]\n]+)\]\]/g, (_all, inner: string) => {
        const [left, alias = ''] = inner.split('|');
        const [target, anchor = ''] = left.split('#');
        // A link to a heading of the same note has no target to show.
        return target.trim() === '' ? alias.trim() || anchor.trim() : (target.trim().split('/').pop() ?? '');
      })
      .replace(/\s+/g, ' ')
      .trim();
  const escape = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namesWord = (line: string): boolean =>
    names.some((name) => new RegExp(`(?<![\\p{L}\\p{N}_])${escape(name)}(?![\\p{L}\\p{N}_])`, 'iu').test(line));
  const wholeName = (line: string): boolean => {
    const bare = line.replace(/[:.]$/, '').trim();
    const linked = /^\[\[([^[\]]+)\]\]$/.exec(bare);
    const candidates = linked ? [linked[1].split('|')[0].split('#')[0].trim()] : [bare];
    return candidates.some((candidate) => names.includes(candidate.toLowerCase()));
  };
  const isLink = (line: string): boolean => /^\s*↳ \[\[Mtg-/.test(line);

  const anchors: Expected[] = [];
  let underMeeting = false;
  let seen = false;
  for (let i = 0; i < n; i++) {
    if (inert[i]) continue;
    const h = heading(i);
    if (h && h.level <= 3) {
      const meetingLike = targets(h.text).length > 0 || softMarker.test(h.text) || namesWord(h.text);
      anchors.push({ line: i, isHeading: true, level: h.level, title: strip(h.text), meetingLike, ordinal: 0, bodyEnd: n, linkLine: null, items: [] });
      underMeeting = meetingLike;
    } else if (!h && !blank(i) && !underMeeting) {
      const trimmed = lines[i].trim();
      let above = i - 1;
      while (above >= 0 && !inert[above] && isLink(lines[above])) above -= 1;
      const previousOk = !seen || above < 0 || blank(above) || heading(above) !== null;
      if (
        previousOk &&
        trimmed.length <= 80 &&
        !/^(?:[-*+]|\d+[.)])(?:\s|$)/.test(trimmed) &&
        !trimmed.startsWith('>') &&
        !isLink(trimmed) &&
        (softMarker.test(trimmed) || wholeName(trimmed))
      ) {
        anchors.push({ line: i, isHeading: false, level: 0, title: strip(trimmed), meetingLike: true, ordinal: 0, bodyEnd: n, linkLine: null, items: [] });
      }
    }
    if (!isLink(lines[i])) seen = true;
  }

  anchors.forEach((anchor, index) => {
    anchor.ordinal = anchors.slice(0, index).filter((earlier) => earlier.title === anchor.title).length;
    const next = anchors.slice(index + 1).find((later) => !anchor.isHeading || (later.isHeading && later.level <= anchor.level));
    anchor.bodyEnd = next ? next.line : n;
    for (let i = anchor.line + 1; i < anchor.bodyEnd; i++) {
      if (inert[i] || blank(i)) continue;
      const h = heading(i);
      if (h) {
        if (h.text !== '') anchor.items.push(['topic', h.text, i]);
        continue;
      }
      const trimmed = lines[i].trim();
      if (isLink(trimmed)) {
        anchor.linkLine ??= i;
        continue;
      }
      if (/^([-*_])(?:[ \t]*\1){2,}$/.test(trimmed)) continue;
      const marker = /^(?:[-*+]|\d+[.)])(?:[ \t]+|$)/.exec(trimmed);
      let itemText = trimmed;
      if (marker) itemText = trimmed.slice(marker[0].length).replace(/^\[[^\]]\](?:[ \t]+|$)/, '');
      if (itemText !== '') anchor.items.push(['item', itemText, i]);
    }
  });
  return anchors;
}

describe('random notes', () => {
  const VOCABULARY = [
    '', '', '', '', '', '', '   ', '\t',
    '### 1:1 [[Jane Example]]', '### [[Steering Board]]', '### 🗄️Work', '### Priority 1:', '## Meetings',
    '# Day', '#### Sub topic', '##### Deep ##', '### Weekly SB sync', '### Steering comittee [[R&D]]', '###',
    '### Samedi', '### See [[#Agenda]]', '   ## Indented', '#tag line', '### 1:1 [[Jane Example|Jane]]',
    '1:1 Sam', '1:1 Sam', '1:1 Maya', 'OGOV', 'ogov:', '[[OGOV]]', '[[Steering Board|board]].', 'Prep the deck',
    'Rencontre avec Léa et Tim.', 'Steering', 'SB', 'sam', '  1:1 Indented', 'OGOV wants a report', 'Samedi',
    `1:1 ${'long '.repeat(20)}`,
    '- point', '- point', '- [ ] task', '* [x] done', '1. first', '2) second', '> quote', 'plain thought',
    'plain thought', 'another -> arrow', '- 1:1 Sam', '> 1:1 Sam', '-', '- [ ]', '\t- nested [[Jane Example]]',
    '```', '```', '```js', '~~~', '````', '``` not `a` fence', '---', '***', '- - -', '--',
    '↳ [[Mtg-2026-10-09 — 1-1 Sam|Meeting notes]]', '  ↳ [[Mtg-2026-10-09 — OGOV|Meeting notes]]', '↳ [[Other]]',
  ];
  const names = ['ogov', 'steering board', 'sb', 'sam', 'jane example', 'r&d'];
  const opts: SectionOptions = { softMarker: SOFT, entityNames: names };

  /* mulberry32: the same notes on every run. */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function note(next: () => number): string {
    const lines: string[] = [];
    if (next() < 0.2) lines.push('---', 'title: 1:1 Sam', '### not a heading');
    if (next() < 0.9 && lines.length > 0) lines.push('---');
    const count = Math.floor(next() * 45);
    for (let i = 0; i < count; i++) lines.push(VOCABULARY[Math.floor(next() * VOCABULARY.length)]);
    const text = lines.join(next() < 0.25 ? '\r\n' : '\n');
    return next() < 0.3 ? `${text}\n` : text;
  }

  test('the parser agrees with a literal reading of the rules', () => {
    const next = random(20261009);
    let anchorsSeen = 0;
    let softSeen = 0;
    for (let round = 0; round < 400; round++) {
      const text = note(next);
      const expected = naive(text, SOFT, names);
      const context = JSON.stringify(text);
      anchorsSeen += expected.length;
      softSeen += expected.filter((anchor) => !anchor.isHeading).length;

      assert.deepEqual(
        listSections(text, opts).map((s) => [s.anchorLine, s.isHeading, s.level, s.title, s.meetingLike, s.ordinal]),
        expected.map((e) => [e.line, e.isHeading, e.level, e.title, e.meetingLike, e.ordinal]),
        context,
      );

      const lineCount = text.split('\n').length;
      for (let line = 0; line < lineCount; line++) {
        const owner = expected.filter((anchor) => anchor.line <= line).pop() ?? null;
        const start = lineStart(text, line);
        const section = sectionAt(text, start, opts);
        if (owner === null) {
          assert.equal(section, null, context);
          continue;
        }
        assert.ok(section, context);
        assert.equal(section.anchorLine, owner.line, context);
        assert.equal(section.bodyStartLine, owner.line + 1, context);
        assert.equal(section.bodyEndLine, owner.bodyEnd, context);
        assert.equal(section.linkLine, owner.linkLine, context);
        assert.deepEqual(
          section.items.map((item) => [item.kind, item.text, item.line]),
          owner.items,
          context,
        );
        assert.ok(line < section.bodyEndLine, context);
        assert.equal(section.from, section.bodyStartLine < lineCount ? lineStart(text, section.bodyStartLine) : text.length, context);
        assert.equal(section.to, section.bodyEndLine < lineCount ? lineStart(text, section.bodyEndLine) : text.length, context);
        assert.equal(new Set(section.items.map((item) => item.id)).size, section.items.length, context);
        for (const item of section.items) {
          assert.equal(item.raw, text.split('\n')[item.line].replace(/\r$/, ''), context);
        }
        assert.deepEqual(findSection(text, section, opts), section, context);
      }
    }
    // The generator must actually exercise both kinds of anchor.
    assert.ok(anchorsSeen > 1000, String(anchorsSeen));
    assert.ok(softSeen > 150, `${softSeen} of ${anchorsSeen}`);
  });

  test('adding the link line is always seen again and never moves a section', () => {
    const next = random(9102026);
    const link = '↳ [[Mtg-2026-10-09 — Fixture|Meeting notes]]';
    let inserted = 0;
    for (let round = 0; round < 250; round++) {
      // Start from a note the plugin has not touched yet.
      const text = note(next)
        .split('\n')
        .filter((line) => !isLinkLine(line))
        .join('\n');
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const before = listSections(text, opts);
      for (const summary of before) {
        const section = mustBe(findSection(text, summary, opts));
        assert.equal(section.linkLine, null);
        for (const placement of ['section-end', 'heading'] as const) {
          const after = linkInsertLine(text, section, placement);
          const context = JSON.stringify({ text, title: section.title, placement, after });
          assert.ok(after >= section.anchorLine && after < Math.max(section.bodyEndLine, section.anchorLine + 1), context);

          const lines = text.split('\n');
          const last = after === lines.length - 1;
          // The last line of a note has no line break of its own to push down.
          if (last) lines[after] = `${lines[after]}${eol}${link}`;
          else lines.splice(after + 1, 0, link + (eol === '\r\n' ? '\r' : ''));
          const linked = lines.join('\n');

          const shift = (line: number): number => (line > after ? line + 1 : line);
          assert.deepEqual(
            listSections(linked, opts),
            before.map((s) => ({ ...s, anchorLine: shift(s.anchorLine) })),
            context,
          );
          const again = mustBe(findSection(linked, summary, opts));
          assert.equal(again.linkLine, after + 1, context);
          assert.deepEqual(
            again.items,
            section.items.map((item) => ({ ...item, line: shift(item.line) })),
            context,
          );
          assert.equal(mustBe(findSection(linked, { title: 'no such title', ordinal: 9 }, opts, 'Mtg-2026-10-09 — Fixture')).linkLine, after + 1, context);
          inserted += 1;
        }
      }
    }
    assert.ok(inserted > 1000, String(inserted));
  });
});

describe('performance', () => {
  test('a full parse of 1,000 lines stays well under 1 ms', () => {
    const names: string[] = [];
    for (let i = 0; i < 150; i++) names.push(`entity number ${i}`, `e${i}x`);
    const opts: SectionOptions = { softMarker: SOFT, entityNames: [...names, ...NAMES] };

    const lines: string[] = ['# 2026-10-09', ''];
    for (let block = 0; lines.length < 1000; block++) {
      lines.push(
        `### 1:1 [[Person ${block}]]`,
        '- point about the budget -> approved',
        '- [ ] follow up with finance',
        '#### Sujet',
        'ligne en français, un peu plus longue que les autres',
        '',
        `### Priority ${block}:`,
        'plain text under a heading that is not a meeting',
        '',
        `1:1 Sam${block}`,
        '',
        'short thought',
        '',
        'another short thought',
        '',
        'OGOV',
        '',
        'more words on the governance body',
        '',
        '```js',
        'const x = 1;',
        '```',
        '',
      );
    }
    const text = lines.join('\n');
    const run = (): void => {
      listSections(text, opts);
      sectionAt(text, text.length >> 1, opts);
    };
    for (let i = 0; i < 200; i++) run();
    // The best of several batches: a busy machine slows some of them, not all.
    let best = Number.POSITIVE_INFINITY;
    for (let batch = 0; batch < 8; batch++) {
      const started = performance.now();
      for (let i = 0; i < 50; i++) run();
      best = Math.min(best, (performance.now() - started) / 100);
    }
    assert.ok(best < 1, `one parse took ${best.toFixed(3)} ms`);
  });

  test('a long run of link lines is read in linear time', () => {
    const link = '↳ [[Mtg-2026-10-09 — Fixture|Meeting notes]]';
    const text = doc('### 🗄️Work', ...new Array<string>(6000).fill(link), '1:1 Sam', 'note');
    listSections(doc('### 🗄️Work', link, '1:1 Sam'), OPTS);
    const started = performance.now();
    const sections = listSections(text, OPTS);
    const elapsed = performance.now() - started;
    assert.deepEqual(
      sections.map((s) => [s.title, s.anchorLine]),
      [
        ['🗄️Work', 0],
        ['1:1 Sam', 6001],
      ],
    );
    // Walking back up the run from each of its lines took about half a second here.
    assert.ok(elapsed < 100, `${elapsed.toFixed(0)} ms`);
  });

  test('a long line of brackets or spaces does not blow up', () => {
    const nasty = doc(
      `### ${'[['.repeat(20_000)}`,
      `### ${' '.repeat(20_000)}#`,
      `1:1 ${'[[a'.repeat(10_000)}`,
      `- ${'[ ] '.repeat(10_000)}`,
    );
    const started = performance.now();
    listSections(nasty, OPTS);
    sectionAt(nasty, nasty.length, OPTS);
    assert.ok(performance.now() - started < 250);
  });
});

describe('memory', () => {
  /* A slice of a string keeps the whole string alive in V8, and every item is a
     slice of the note. Nothing the parser keeps between calls may hold one. */
  v8.setFlagsFromString('--expose-gc');
  const collect = vm.runInNewContext('gc') as () => void;
  const heapUsed = (): number => {
    collect();
    collect();
    return process.memoryUsage().heapUsed;
  };

  const shortLines = ['### 1:1 [[Jane Example]]'];
  for (let i = 0; i < 1000; i++) shortLines.push(`- point ${i} about the budget and the roadmap for the next quarter, détails à suivre`);
  const paragraph = `### [[Steering Board]]\n- ${'un long paragraphe collé tel quel '.repeat(1500)}`;

  for (const [label, head, tail] of [
    ['many short lines', shortLines.join('\n'), '\n- line being typed, keystroke '],
    ['one very long line', paragraph, ' keystroke '],
  ] as const) {
    test(`a parse per keystroke does not keep the earlier versions of the note: ${label}`, () => {
      assert.ok(head.length > 45_000, String(head.length));
      const keystrokes = 300;
      // Twice, so that the parser emptying a cache of its own in one round cannot hide the other.
      for (let round = 0; round < 2; round++) {
        mustBe(sectionAt(head, head.length, PLAIN));
        const before = heapUsed();
        for (let key = 0; key < keystrokes; key++) {
          // A new string per keystroke, as an editor hands it over.
          const text = `${head}${tail}${round}.${key}`;
          const section = mustBe(sectionAt(text, text.length, PLAIN));
          assert.equal(section.items[section.items.length - 1].raw.endsWith(`${round}.${key}`), true);
        }
        const retained = heapUsed() - before;
        // One version of the note per keystroke would be 300 x 50 KB or more.
        assert.ok(retained < 4_000_000, `${(retained / 1e6).toFixed(1)} MB kept after ${keystrokes} keystrokes in a ${Math.round(head.length / 1000)} KB note`);
      }
    });
  }
});

describe('findSection: the link line outranks the key', () => {
  const opts = { softMarker: /^(1:1|Ad ?Hoc|Prep|Steering|Rencontre)\b/i };
  const base = 'Mtg-2026-01-05 — 1-1 Jane Example';

  test('a same-titled section inserted above does not capture the meeting', () => {
    const doc = [
      '### 1:1 [[Jane Example]]',
      'new section typed later',
      '',
      '### 1:1 [[Jane Example]]',
      'the original lines',
      `↳ [[${base}|Meeting notes]]`,
    ].join('\n');
    const found = findSection(doc, { title: '1:1 Jane Example', ordinal: 0 }, opts, base);
    assert.equal(found?.anchorLine, 3);
    assert.equal(found?.ordinal, 1);
  });

  test('the keyed section keeps the meeting when it still holds the link', () => {
    const doc = ['### 1:1 [[Jane Example]]', 'a', `↳ [[${base}|Meeting notes]]`, '', '### Other', 'b'].join('\n');
    const found = findSection(doc, { title: '1:1 Jane Example', ordinal: 0 }, opts, base);
    assert.equal(found?.anchorLine, 0);
  });

  test('a link nested in a child section still resolves to the keyed parent', () => {
    const doc = ['## 1:1 [[Jane Example]]', 'a', '### Budget', 'b', `↳ [[${base}|Meeting notes]]`].join('\n');
    const found = findSection(doc, { title: '1:1 Jane Example', ordinal: 0 }, opts, base);
    assert.equal(found?.anchorLine, 0);
  });

  test('without a link line the key is used', () => {
    const doc = ['### 1:1 [[Jane Example]]', 'a'].join('\n');
    assert.equal(findSection(doc, { title: '1:1 Jane Example', ordinal: 0 }, opts, base)?.anchorLine, 0);
  });

  test('a copy of the link line above the meeting does not take the meeting from the section that still holds its own', () => {
    const link = `↳ [[${base}|Meeting notes]]`;
    const key = { title: '1:1 Jane Example', ordinal: 0 };
    const above = ['### Agenda', link, '', '### 1:1 [[Jane Example]]', '- a', link].join('\n');
    assert.equal(findSection(above, key, opts, base)?.title, '1:1 Jane Example');
    // Which line comes first in the note decides nothing.
    const below = ['### 1:1 [[Jane Example]]', '- a', link, '', '### Agenda', link].join('\n');
    assert.equal(findSection(below, key, opts, base)?.title, '1:1 Jane Example');
    // Its own line nested under a sub-heading, the copy above: still the keyed section.
    const nested = ['### Agenda', link, '## 1:1 [[Jane Example]]', 'a', '### Budget', link].join('\n');
    assert.equal(findSection(nested, key, opts, base)?.anchorLine, 2);

    // Once the keyed section has lost its line, the first section that holds one has the meeting.
    const moved = ['### Agenda', link, '', '### 1:1 [[Jane Example]]', '- a', '', '### Later', link].join('\n');
    assert.equal(findSection(moved, key, opts, base)?.title, 'Agenda');
    // And with no section of that key at all, the first line counts, as before.
    assert.equal(findSection(above, { title: '', ordinal: -1 }, opts, base)?.title, 'Agenda');
  });
});

describe('linkInsertion', () => {
  const opts = { softMarker: /^(1:1|Ad ?Hoc|Prep|Steering|Rencontre)\b/i };
  const at = (doc: string) => sectionAt(doc, doc.indexOf('\n') + 1, opts)!;

  test('plain text needs no blank line', () => {
    const doc = '### 1:1 [[Jane Example]]\nbudget -> option B\n';
    assert.deepEqual(linkInsertion(doc, at(doc), 'section-end'), { afterLine: 1, blankBefore: false });
  });

  test('after a list item, a task, a quote or a table row it asks for a blank line', () => {
    for (const last of ['- item', '- [ ] send the plan', '1. first', '> quoted', '| a | b |']) {
      const doc = `### 1:1 [[Jane Example]]\ntext\n${last}\n`;
      assert.deepEqual(linkInsertion(doc, at(doc), 'section-end'), { afterLine: 2, blankBefore: true }, last);
    }
  });

  test('heading placement and an empty body never ask for one', () => {
    const doc = '### 1:1 [[Jane Example]]\n- item\n';
    assert.deepEqual(linkInsertion(doc, at(doc), 'heading'), { afterLine: 0, blankBefore: false });
    const empty = '### 1:1 [[Jane Example]]\n\n### Next\n- x\n';
    assert.deepEqual(linkInsertion(empty, at(empty), 'section-end'), { afterLine: 0, blankBefore: false });
  });
});
