import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkMarkdown, stripFrontmatter } from '../src/rag/chunk.ts';
import { estimateTokens } from '../src/util/text.ts';

const FENCE = '```';

function texts(markdown: string, opts?: Parameters<typeof chunkMarkdown>[1]): string[] {
  return chunkMarkdown(markdown, opts).map((c) => c.text);
}

function headings(markdown: string, opts?: Parameters<typeof chunkMarkdown>[1]): string[] {
  return chunkMarkdown(markdown, opts).map((c) => c.heading);
}

/** A synthetic sentence of a known shape; `i` keeps each one unique. */
function sentence(i: number): string {
  return `Sentence ${i} is about the platform migration schedule.`;
}

function paragraph(i: number, sentences = 3): string {
  return Array.from({ length: sentences }, (_, s) => `Paragraph ${i} point ${s} covers the vendor review.`).join(' ');
}

test('stripFrontmatter removes a leading YAML block only', () => {
  assert.equal(stripFrontmatter('---\ntitle: Plan\ntags: [a, b]\n---\nBody'), 'Body');
  assert.equal(stripFrontmatter('---\n---\nBody'), 'Body');
  assert.equal(stripFrontmatter('---\r\ntitle: Plan\r\n---\r\nBody\r\n'), 'Body\r\n');
  assert.equal(stripFrontmatter('\uFEFF---\ntitle: Plan\n---\nBody'), 'Body');
  assert.equal(stripFrontmatter('---\ntitle: Plan\n---'), '');
  assert.equal(stripFrontmatter('Body\n---\nnot: frontmatter\n---\n'), 'Body\n---\nnot: frontmatter\n---\n');
  assert.equal(stripFrontmatter('---\nnever closed\nBody'), '---\nnever closed\nBody');
  assert.equal(stripFrontmatter('--- not a fence\nBody'), '--- not a fence\nBody');
  assert.equal(stripFrontmatter(''), '');
});

test('frontmatter does not reach the chunks', () => {
  const chunks = chunkMarkdown('---\ncreated: 2026-01-02\nsecret_key: do-not-index\n---\nThe body of the note is what gets indexed.');
  assert.deepEqual(chunks, [{ heading: '', text: 'The body of the note is what gets indexed.' }]);
});

test('heading is the path of headings above the chunk', () => {
  const markdown = [
    'Text before any heading is kept too.',
    '',
    '# Plan',
    'The plan section has its own text.',
    '',
    '## Risks',
    'The risks section has its own text.',
    '',
    '### Vendor',
    'The vendor section has its own text.',
    '',
    '## Budget ##',
    'The budget section has its own text.',
    '',
    '# Other',
    'The other section has its own text.',
    '',
    '### Deep',
    'A level can be skipped on the way down.',
  ].join('\n');

  assert.deepEqual(chunkMarkdown(markdown), [
    { heading: '', text: 'Text before any heading is kept too.' },
    { heading: 'Plan', text: 'The plan section has its own text.' },
    { heading: 'Plan › Risks', text: 'The risks section has its own text.' },
    { heading: 'Plan › Risks › Vendor', text: 'The vendor section has its own text.' },
    { heading: 'Plan › Budget', text: 'The budget section has its own text.' },
    { heading: 'Other', text: 'The other section has its own text.' },
    { heading: 'Other › Deep', text: 'A level can be skipped on the way down.' },
  ]);
});

test('a tag line or seven hashes is not a heading', () => {
  const markdown = '# Notes\n#followup is a tag and this line is body text.\n####### seven hashes is body text as well.';
  assert.deepEqual(chunkMarkdown(markdown), [
    {
      heading: 'Notes',
      text: '#followup is a tag and this line is body text.\n####### seven hashes is body text as well.',
    },
  ]);
});

test('wikilinks become readable text, in headings and in bodies', () => {
  const markdown = [
    '## 1:1 [[Jane Example]]',
    'Talked with [[Jane Example|Jane]] about [[Project Phoenix]] and ![[Roadmap 2026]].',
    '',
    '| Who | What |',
    '| --- | --- |',
    '| [[Sam Placeholder\\|Sam]] | owns the rollout |',
  ].join('\n');
  const [chunk] = chunkMarkdown(markdown);
  assert.equal(chunk.heading, '1:1 Jane Example');
  assert.ok(chunk.text.startsWith('Talked with Jane about Project Phoenix and Roadmap 2026.'));
  assert.ok(chunk.text.includes('| Sam | owns the rollout |'));
  assert.ok(!chunk.text.includes('[['));
});

test('paragraphs are packed up to the budget and never cut when they fit', () => {
  const paragraphs = Array.from({ length: 14 }, (_, i) => paragraph(i));
  const maxTokens = 150;
  assert.ok(estimateTokens(paragraphs[0]) < 60, 'a paragraph is well under the budget');
  const chunks = texts(`# Review\n\n${paragraphs.join('\n\n')}`, { maxTokens, overlapTokens: 0 });

  assert.ok(chunks.length > 2 && chunks.length < paragraphs.length, 'several paragraphs share a chunk');
  for (const chunk of chunks) assert.ok(estimateTokens(chunk) <= maxTokens, `chunk of ${estimateTokens(chunk)} tokens`);
  assert.deepEqual(chunks.join('\n\n').split('\n\n'), paragraphs, 'every paragraph is whole, once, in order');
  assert.ok(estimateTokens(`${chunks[0]}\n\n${paragraphs[chunks[0].split('\n\n').length]}`) > maxTokens, 'a chunk is full');
});

test('the default budget is 480 tokens', () => {
  const paragraphs = Array.from({ length: 60 }, (_, i) => paragraph(i));
  const chunks = texts(paragraphs.join('\n\n'));
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(estimateTokens(chunk) <= 480);
  assert.ok(estimateTokens(chunks[0]) > 400, 'chunks are filled close to the budget');
});

test('an oversized paragraph is split on sentence ends', () => {
  const sentences = Array.from({ length: 40 }, (_, i) => sentence(i));
  const maxTokens = 60;
  const chunks = texts(`# Long\n${sentences.join(' ')}`, { maxTokens, overlapTokens: 0 });

  assert.ok(chunks.length > 5);
  for (const chunk of chunks) {
    assert.ok(estimateTokens(chunk) <= maxTokens);
    assert.ok(chunk.startsWith('Sentence '), 'starts at a sentence');
    assert.ok(chunk.endsWith('.'), 'ends at a sentence');
  }
  assert.equal(chunks.join(' '), sentences.join(' '), 'nothing is lost or repeated');
});

test('hard-wrapped lines are the next boundary, then spaces, then length', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `row ${i} has no sentence end and just keeps going with words`);
  const byLine = texts(lines.join('\n'), { maxTokens: 40, overlapTokens: 0 });
  assert.ok(byLine.length > 3);
  for (const chunk of byLine) {
    assert.ok(estimateTokens(chunk) <= 40);
    for (const line of chunk.split('\n')) assert.ok(lines.includes(line), 'only whole lines');
  }
  assert.equal(byLine.join('\n'), lines.join('\n'));

  const words = Array.from({ length: 200 }, (_, i) => `w${i}`);
  const bySpace = texts(words.join(' '), { maxTokens: 30, overlapTokens: 0 });
  assert.ok(bySpace.length > 3);
  for (const chunk of bySpace) assert.ok(estimateTokens(chunk) <= 30);
  assert.equal(bySpace.join(' '), words.join(' '), 'words are never cut');

  const blob = 'x'.repeat(1000);
  const byLength = texts(blob, { maxTokens: 30, overlapTokens: 0 });
  assert.ok(byLength.length > 5);
  for (const chunk of byLength) assert.ok(estimateTokens(chunk) <= 30);
  assert.equal(byLength.join(''), blob);
});

test('a list that fits stays together', () => {
  const intro = 'An opening paragraph that takes up part of the first chunk before the list starts here.';
  const list = Array.from({ length: 6 }, (_, i) => `- Action ${i}: confirm the delivery date with the vendor`).join('\n');
  const maxTokens = 115;
  assert.ok(estimateTokens(list) <= maxTokens - 6, 'the list fits in one chunk');
  assert.ok(estimateTokens(`${intro}\n\n${list}`) > maxTokens, 'but not next to the intro');

  const chunks = texts(`${intro}\n\n${list}`, { maxTokens });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], intro);
  assert.ok(chunks[1].endsWith(list), 'the list moved whole to the next chunk');
});

test('a list larger than the budget breaks between items', () => {
  const items = Array.from({ length: 30 }, (_, i) => `- Item ${i}: follow up with the vendor. Confirm the date.`);
  const chunks = texts(items.join('\n'), { maxTokens: 60, overlapTokens: 0 });
  assert.ok(chunks.length > 3);
  for (const chunk of chunks) {
    assert.ok(estimateTokens(chunk) <= 60);
    for (const line of chunk.split('\n')) assert.ok(items.includes(line), `whole item: ${line}`);
  }
  assert.equal(chunks.join('\n'), items.join('\n'));
});

test('consecutive chunks of a section overlap by the last words of the previous one', () => {
  const sentences = Array.from({ length: 24 }, (_, i) => sentence(i));
  const maxTokens = 60;
  const overlapTokens = 5;
  const chunks = texts(sentences.join(' '), { maxTokens, overlapTokens });
  assert.ok(chunks.length > 4);

  for (let i = 1; i < chunks.length; i++) {
    const firstNew = chunks[i].indexOf('Sentence ');
    const carried = chunks[i].slice(0, firstNew).trim();
    assert.ok(carried.length > 0, `chunk ${i} starts with carried words`);
    assert.ok(estimateTokens(carried) <= overlapTokens, `"${carried}" fits the overlap`);
    assert.ok(chunks[i - 1].endsWith(carried), `"${carried}" ends chunk ${i - 1}`);
    assert.ok(estimateTokens(chunks[i]) <= maxTokens, 'the overlap counts toward the budget');
  }
  assert.ok(chunks[0].startsWith('Sentence 0 '), 'the first chunk has nothing to carry');

  const wider = texts(sentences.join(' '), { maxTokens, overlapTokens: 12 });
  const carriedWide = wider[1].slice(0, wider[1].indexOf('Sentence ')).trim();
  assert.ok(carriedWide.split(' ').length > 3, 'a larger overlap carries more words');
  assert.ok(wider[0].endsWith(carriedWide));
});

test('overlap does not cross a heading', () => {
  const first = Array.from({ length: 12 }, (_, i) => sentence(i)).join(' ');
  const second = Array.from({ length: 12 }, (_, i) => sentence(100 + i)).join(' ');
  const chunks = chunkMarkdown(`# First\n${first}\n\n# Second\n${second}`, { maxTokens: 60, overlapTokens: 5 });

  const firstChunks = chunks.filter((c) => c.heading === 'First');
  const secondChunks = chunks.filter((c) => c.heading === 'Second');
  assert.ok(firstChunks.length > 1 && secondChunks.length > 1);
  assert.ok(secondChunks[0].text.startsWith('Sentence 100 '), 'a new section starts clean');
  assert.ok(!secondChunks[1].text.startsWith('Sentence '), 'and overlaps within itself');
  assert.ok(firstChunks[0].text.startsWith('Sentence 0 '));
});

test('overlapTokens 0 turns the overlap off', () => {
  const sentences = Array.from({ length: 12 }, (_, i) => sentence(i));
  for (const chunk of texts(sentences.join(' '), { maxTokens: 60, overlapTokens: 0 })) {
    assert.ok(chunk.startsWith('Sentence '));
  }
});

test('dataview blocks are dropped, other code is kept', () => {
  const markdown = [
    '# Dashboard',
    'Real text before the query stays in the index.',
    '',
    `${FENCE}dataview`,
    'TABLE file.mtime FROM "10 Projects"',
    '# not a heading',
    FENCE,
    '',
    `${FENCE}dataviewjs`,
    'dv.list(dv.pages().file.name)',
    FENCE,
    '',
    '> [!info] Open items',
    `> ${FENCE}dataview`,
    '> TASK FROM "20 Areas"',
    `> ${FENCE}`,
    '',
    `${FENCE}js`,
    'const kept = "ordinary code stays";',
    FENCE,
    '',
    'Real text after the query stays as well.',
  ].join('\n');
  const chunks = chunkMarkdown(markdown);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, 'Dashboard');
  const text = chunks[0].text;
  assert.ok(text.includes('Real text before the query'));
  assert.ok(text.includes('Real text after the query'));
  assert.ok(text.includes('ordinary code stays'));
  for (const gone of ['TABLE', 'dv.list', 'TASK FROM', 'dataview', 'not a heading']) {
    assert.ok(!text.includes(gone), `"${gone}" is gone`);
  }
});

test('a Linked mentions section is dropped up to the next heading of its level', () => {
  const markdown = [
    '# Jane Example',
    'Role and context for this person, written by hand.',
    '',
    '## Linked mentions',
    'Rendered excerpts that must not be indexed.',
    '',
    '### 2026-10-09',
    'An excerpt under a deeper heading, also dropped.',
    '',
    '## Notes',
    'Hand-written notes after the mentions are kept.',
    '',
    '# Appendix',
    'A later top-level section is kept.',
    '',
    '### linked mentions:',
    'Dropped again, whatever the level or the case.',
    '',
    '#### Detail',
    'Still inside the dropped section.',
    '',
    '## Closing',
    'A shallower heading ends the dropped section.',
  ].join('\n');

  assert.deepEqual(chunkMarkdown(markdown), [
    { heading: 'Jane Example', text: 'Role and context for this person, written by hand.' },
    { heading: 'Jane Example › Notes', text: 'Hand-written notes after the mentions are kept.' },
    { heading: 'Appendix', text: 'A later top-level section is kept.' },
    { heading: 'Appendix › Closing', text: 'A shallower heading ends the dropped section.' },
  ]);
});

test('a Linked mentions section at the end of a note is dropped to the end', () => {
  const markdown = '# Topic\nThe hand-written part of the note stays.\n\n## Linked mentions\nExcerpt one.\n\nExcerpt two is long enough to be a chunk.';
  assert.deepEqual(texts(markdown), ['The hand-written part of the note stays.']);
});

test('the transcript region of a companion is dropped', () => {
  const markdown = [
    '# 1:1 Jane Example',
    '<!-- hamster:begin enhanced -->',
    '- **Budget:** approved for the next quarter.',
    '<!-- hamster:end enhanced -->',
    '',
    '## Transcript',
    '<!-- hamster:begin transcript -->',
    '[00:01] Mic: this spoken text is searched through the transcript index.',
    '',
    '[00:12] Mic: so it must not be indexed here.',
    '<!-- hamster:end transcript -->',
    '',
    'A note typed under the transcript by hand stays.',
  ].join('\n');
  const chunks = chunkMarkdown(markdown);

  assert.deepEqual(chunks, [
    { heading: '1:1 Jane Example', text: '- **Budget:** approved for the next quarter.' },
    { heading: '1:1 Jane Example › Transcript', text: 'A note typed under the transcript by hand stays.' },
  ]);
});

test('a transcript region whose end marker is missing is dropped to the end of the note', () => {
  const markdown = [
    'The enhanced notes above the transcript stay.',
    '',
    '<!-- hamster:begin transcript -->',
    '[00:01] Mic: spoken text without a closing marker.',
    '',
    '## A heading inside the spoken text',
    'More spoken text that is long enough to be a chunk.',
  ].join('\n');
  assert.deepEqual(chunkMarkdown(markdown), [{ heading: '', text: 'The enhanced notes above the transcript stay.' }]);
});

test('a damaged marker or an unclosed fence above the transcript does not expose it', () => {
  const transcript = [
    '<!-- hamster:begin transcript -->',
    '[00:01] Mic: spoken words that belong to the transcript index only.',
    '<!-- hamster:end transcript -->',
    'Typed by hand under the transcript, long enough to keep.',
  ];
  const spoken = (markdown: string): boolean => texts(markdown).some((t) => t.includes('spoken words'));

  // The end marker of the region above lost its "-->".
  const damaged = ['Notes typed above the transcript, long enough to keep.', '<!-- hamster:end qa', ...transcript].join('\n');
  assert.equal(spoken(damaged), false);
  assert.deepEqual(texts(damaged), [
    'Notes typed above the transcript, long enough to keep.\n<!-- hamster:end qa\n\nTyped by hand under the transcript, long enough to keep.',
  ]);

  const sameLine = `Before the marker <!-- stray ${transcript[0]}spoken words${transcript[2]} and after it, on one line.`;
  assert.deepEqual(texts(sameLine), ['Before the marker <!-- stray and after it, on one line.']);

  // Generated text that was cut short inside a code block.
  const unclosed = ['A summary that ends in the middle of a code block.', `${FENCE}json`, '{ "actions": [', ...transcript].join('\n');
  assert.equal(spoken(unclosed), false);
  assert.ok(texts(unclosed).some((t) => t.includes('"actions"')), 'the code above the marker is still indexed');
  assert.ok(texts(unclosed).some((t) => t.includes('Typed by hand under the transcript')));

  const callout = ['> [!note] A callout whose query block was never closed.', `> ${FENCE}dataview`, '> LIST', ...transcript].join('\n');
  assert.equal(spoken(callout), false);
});

test('HTML comments are dropped, an unterminated one is kept as text', () => {
  const markdown = [
    'Visible start <!-- a hidden remark --> visible end of the line.',
    '',
    '<!--',
    'A whole hidden block,',
    'with a # heading-like line',
    '# and a real-looking heading',
    '-->',
    'Text right after the hidden block.',
  ].join('\n');
  assert.deepEqual(texts(markdown), ['Visible start visible end of the line.\n\nText right after the hidden block.']);

  const literal = 'Write `<!--` to open a comment, as this sentence explains.\n\nThe paragraph after it is still indexed.';
  assert.deepEqual(texts(literal), [literal]);
});

test('a code fence with # lines is not split into sections', () => {
  const markdown = [
    '# Setup',
    'How to install the tools on a new machine.',
    '',
    `${FENCE}bash`,
    '# install the dependencies',
    'pnpm install',
    '',
    '## not a heading either',
    'pnpm test',
    FENCE,
    '',
    '~~~python',
    '# a comment in another kind of fence',
    'print("ok")',
    '~~~',
    '',
    '## Usage',
    'How to run the tools once they are installed.',
  ].join('\n');
  const chunks = chunkMarkdown(markdown);

  assert.deepEqual(
    chunks.map((c) => c.heading),
    ['Setup', 'Setup › Usage'],
  );
  assert.ok(chunks[0].text.includes('# install the dependencies\npnpm install\n\n## not a heading either\npnpm test'));
  assert.ok(chunks[0].text.includes('# a comment in another kind of fence'));
  assert.equal(chunks[1].text, 'How to run the tools once they are installed.');
});

test('a code block with blank lines stays in one chunk when it fits', () => {
  const code = [`${FENCE}ts`, 'const a = 1;', '', 'const b = 2;', '', 'const c = a + b;', FENCE].join('\n');
  const before = paragraph(1, 2);
  const maxTokens = estimateTokens(code) + 12;
  assert.ok(estimateTokens(`${before}\n\n${code}`) > maxTokens);

  const chunks = texts(`${before}\n\n${code}`, { maxTokens, overlapTokens: 0, minChars: 1 });
  assert.equal(chunks[chunks.length - 1], code, 'the block is whole, blank lines included');
});

test('an unclosed fence runs to the end of the note', () => {
  const markdown = `# Draft\nSome text before the code that is long enough.\n\n${FENCE}\n# still code\nmore code`;
  assert.deepEqual(headings(markdown), ['Draft']);
});

test('chunks with fewer than minChars visible characters are dropped', () => {
  const markdown = [
    '# Decisions',
    'Go.',
    '',
    '## Empty',
    '',
    '## Rationale',
    'The reasoning behind the decision is long enough.',
    '',
    '## Spaced',
    'a  b  c  d  e  f  g  h  i  j  k  l  m  n',
  ].join('\n');

  assert.deepEqual(chunkMarkdown(markdown), [
    { heading: 'Decisions › Rationale', text: 'The reasoning behind the decision is long enough.' },
  ]);
  assert.deepEqual(headings(markdown, { minChars: 3 }), ['Decisions', 'Decisions › Rationale', 'Decisions › Spaced']);
  assert.deepEqual(headings(markdown, { minChars: 0 }), ['Decisions', 'Decisions › Rationale', 'Decisions › Spaced']);
});

test('a leftover made only of carried words is not a chunk', () => {
  // Sized so that the second chunk is exactly full and the short last
  // paragraph has to start a third one, behind 15 carried characters.
  const sized = (length: number, ending: string): string => {
    const body = 'word '.repeat(80).slice(0, length - ending.length - 1).replace(/ $/, 'x');
    return `${body} ${ending}`;
  };
  const first = sized(178, 'aaaaaaa bbbbbbbb');
  const second = sized(178, 'ccccccc dddddddd');
  const leftover = 'Fine, yes.';
  const markdown = [first, second, leftover].join('\n\n');
  assert.equal(first.length, 178);

  const chunks = texts(markdown, { maxTokens: 60, overlapTokens: 5, minChars: 20 });
  assert.deepEqual(chunks, [first, `aaaaaaa bbbbbbbb\n\n${second}`]);

  const kept = texts(markdown, { maxTokens: 60, overlapTokens: 5, minChars: 5 });
  assert.equal(kept.length, 3);
  assert.equal(kept[2], `ccccccc dddddddd\n\n${leftover}`);
});

test('empty and whitespace-only notes give no chunks', () => {
  assert.deepEqual(chunkMarkdown(''), []);
  assert.deepEqual(chunkMarkdown('\n\n   \n'), []);
  assert.deepEqual(chunkMarkdown('---\ntitle: Only frontmatter\n---\n'), []);
  assert.deepEqual(chunkMarkdown('# Only\n## Headings\n### Here'), []);
});

test('Windows line endings are handled', () => {
  const markdown = '# Plan\r\nThe plan section has its own text.\r\n\r\n## Risks\r\nThe risks section has its own text.\r\n';
  assert.deepEqual(chunkMarkdown(markdown), [
    { heading: 'Plan', text: 'The plan section has its own text.' },
    { heading: 'Plan › Risks', text: 'The risks section has its own text.' },
  ]);
});

test('odd options fall back to sane values', () => {
  const sentences = Array.from({ length: 30 }, (_, i) => sentence(i)).join(' ');
  for (const opts of [{ maxTokens: Number.NaN }, { overlapTokens: -4 }, { overlapTokens: 9999 }, { minChars: Number.NaN }]) {
    const chunks = texts(sentences, opts);
    assert.ok(chunks.length >= 1);
    for (const chunk of chunks) assert.ok(estimateTokens(chunk) <= 480);
  }
  for (const chunk of texts(sentences, { maxTokens: 1 })) assert.ok(estimateTokens(chunk) <= 8);
});

test('a note with many unterminated comment openers is still chunked quickly', () => {
  const markdown = Array.from({ length: 4000 }, (_, i) => `Line ${i} mentions <!-- without ever closing it.`).join('\n');
  const started = performance.now();
  const chunks = chunkMarkdown(markdown);
  assert.ok(chunks.length > 10);
  assert.ok(performance.now() - started < 2000);
});

test('a long run of sentence punctuation does not stall the chunker', () => {
  // A dot leader or a row of "?!" with no space after it: every position used
  // to be tried as the start of a sentence end.
  const dots = '.'.repeat(60000);
  const shout = `Vraiment${'?!'.repeat(30000)}fin`;
  const started = performance.now();
  const byDots = texts(dots, { overlapTokens: 0 });
  const byShout = texts(shout, { overlapTokens: 0 });
  assert.ok(performance.now() - started < 1500, `took ${Math.round(performance.now() - started)} ms`);
  assert.equal(byDots.join(''), dots);
  assert.equal(byShout.join(''), shout);
});

test('sentence ends are found inside and after runs of punctuation', () => {
  const paragraph = [
    'Is the vendor contract really signed?!',
    'Yes!!! It was signed on Monday...',
    'He said "not before the audit." Fine…',
    'then we wait (really?) Très bien !',
    'On continue demain.',
  ];
  // Each cut falls after a whole run of punctuation and its closing quote or bracket.
  assert.deepEqual(texts(paragraph.join(' '), { maxTokens: 12, overlapTokens: 0, minChars: 0 }), paragraph);
});

test('many unterminated comment openers on one line are still chunked quickly', () => {
  const openers = '<!-- opened and never closed '.repeat(40000);
  const opts = { overlapTokens: 0, minChars: 0 };
  const started = performance.now();
  const literal = texts(openers, opts);
  // The same line, ending in a transcript region.
  const withTranscript = texts(
    `${openers}<!-- hamster:begin transcript -->spoken words<!-- hamster:end transcript --> typed after the transcript.`,
    opts,
  );
  assert.ok(performance.now() - started < 2000, `took ${Math.round(performance.now() - started)} ms`);

  // assert.ok, not assert.equal: a megabyte of diff helps nobody.
  assert.ok(literal.join(' ') === openers.trim(), 'the openers are literal text');
  assert.ok(withTranscript.join(' ') === `${openers}typed after the transcript.`, 'only the transcript is gone');
});

test('a literal opener does not hide a real comment later on its line', () => {
  const transcript = '<!-- hamster:begin transcript -->spoken words<!-- hamster:end transcript -->';
  assert.deepEqual(texts(`First <!-- stray, then ${transcript} then <!-- a real comment --> the visible end of the line.`), [
    'First <!-- stray, then then the visible end of the line.',
  ]);
  assert.deepEqual(texts('Opener one <!-- and opener two <!-- share the one closer --> and the visible rest.'), [
    'Opener one and the visible rest.',
  ]);
});

test('backticks around inline code at the start of a line do not open a fence', () => {
  const markdown = [
    `${FENCE}pnpm test${FENCE} runs the whole suite, as this line explains.`,
    '',
    '# Usage',
    'The section after the inline code is still a section.',
  ].join('\n');
  assert.deepEqual(chunkMarkdown(markdown), [
    { heading: '', text: `${FENCE}pnpm test${FENCE} runs the whole suite, as this line explains.` },
    { heading: 'Usage', text: 'The section after the inline code is still a section.' },
  ]);
});

test('blank lines inside a code block neither split it nor collapse', () => {
  const code = [`${FENCE}ts`, 'const first = 1;', '', '', 'const second = 2;', '', 'const third = first + second;', FENCE].join('\n');
  const before = 'A short lead-in.';
  // Room for the lead-in and the first lines of the code, not for all of it.
  const maxTokens = estimateTokens(code) + 3;
  assert.ok(estimateTokens(`${before}\n\n${code}`) > maxTokens);
  assert.ok(estimateTokens(`${before}\n\n${FENCE}ts\nconst first = 1;`) <= maxTokens);

  const chunks = texts(`${before}\n\n${code}`, { maxTokens, overlapTokens: 0, minChars: 1 });
  assert.deepEqual(chunks, [before, code], 'the block moved whole, both blank lines kept');
});

test('a list is cut between items even when a sentence end inside an item fits better', () => {
  const items = Array.from({ length: 12 }, (_, i) => `- Item ${i}: go. Then confirm the delivery date with the vendor soon`);
  const maxTokens = 30;
  // One item and the first sentence of the next would fit together.
  assert.ok(estimateTokens(`${items[0]}\n- Item 1: go.`) <= maxTokens);
  assert.ok(estimateTokens(`${items[0]}\n${items[1]}`) > maxTokens);

  const chunks = texts(items.join('\n'), { maxTokens, overlapTokens: 0 });
  assert.deepEqual(chunks, items, 'one whole item per chunk');
});

test('a cut by length never splits a surrogate pair', () => {
  // The leading letter puts every budget-sized cut in the middle of an emoji.
  const blob = `a${'😀'.repeat(300)}`;
  const chunks = texts(blob, { maxTokens: 8, overlapTokens: 0, minChars: 0 });
  assert.ok(chunks.length > 10);
  for (const chunk of chunks) {
    assert.ok(estimateTokens(chunk) <= 8);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk), 'no lone surrogate');
  }
  assert.equal(chunks.join(''), blob);
});
