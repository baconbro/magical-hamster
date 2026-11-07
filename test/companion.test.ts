import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  beginMarker,
  endMarker,
  merge,
  mergeAll,
  parseCompanionProperties,
  readCompanionKeys,
  readRegion,
  regionRange,
  REGIONS,
  renderCompanion,
  stripRegion,
  TRANSCRIPT_CALLOUT,
} from '../src/notes/companion.ts';
import type { CompanionMeta, MergeResult } from '../src/types.ts';

const META: CompanionMeta = {
  title: '1:1 Alex Sample',
  date: '2026-10-09',
  attendees: ['Alex Sample'],
  projects: [],
  dailyBasename: '2026-10-09',
  source: '1:1 Alex Sample#0',
  // The setting "Extra properties" as the tests' vault has it.
  properties: [
    ['area', 'work'],
    ['status', 'active'],
  ],
};

const TEMPLATE = renderCompanion(META);

function ok(result: MergeResult): { text: string; changed: boolean } {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result;
}

function structureError(result: MergeResult): string {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.error, 'structure');
  return result.region;
}

/** Runs `work` and fails when it takes seconds: the mark of a pattern that is quadratic on a long run. */
function quickly<T>(work: () => T): T {
  const started = performance.now();
  const result = work();
  const took = Math.round(performance.now() - started);
  assert.ok(took < 1500, `took ${took} ms`);
  return result;
}

const LONG_RUN = 200000;

/** A companion the user has written around: text above, between and below the regions. */
function lived(): string {
  return TEMPLATE.replace('# 1:1 Alex Sample\n', '# 1:1 Alex Sample\n\nMy own intro line.\n')
    .replace('\n## AI summary\n', '\n### A heading of mine\n\n- my bullet\n\n## AI summary\n')
    .concat('\n## Afterthoughts\n\nSomething I typed below the transcript.\n');
}

describe('markers', () => {
  it('names the four regions in order', () => {
    assert.deepEqual([...REGIONS], ['enhanced', 'summary', 'qa', 'transcript']);
    assert.equal(beginMarker('enhanced'), '<!-- hamster:begin enhanced -->');
    assert.equal(endMarker('enhanced'), '<!-- hamster:end enhanced -->');
    assert.equal(beginMarker('qa'), '<!-- hamster:begin qa -->');
    assert.equal(endMarker('transcript'), '<!-- hamster:end transcript -->');
    assert.equal(TRANSCRIPT_CALLOUT, '> [!quote]- Transcript');
  });
});

describe('renderCompanion', () => {
  it('matches the template exactly', () => {
    const expected = [
      '---',
      'type: meeting',
      'area: work',
      'status: active',
      'created: 2026-10-09',
      'updated: 2026-10-09',
      'date: 2026-10-09',
      'attendees: ["Alex Sample"]',
      'projects: []',
      'links: ["[[2026-10-09]]"]',
      'tags: [meeting, magical-hamster]',
      'hamster_source: "1:1 Alex Sample#0"',
      '---',
      '',
      '# 1:1 Alex Sample',
      '',
      '## Enhanced notes',
      '<!-- hamster:begin enhanced -->',
      '<!-- hamster:end enhanced -->',
      '',
      '## AI summary',
      '<!-- hamster:begin summary -->',
      '<!-- hamster:end summary -->',
      '',
      '## Q&A insights',
      '<!-- hamster:begin qa -->',
      '<!-- hamster:end qa -->',
      '',
      '## Transcript',
      '<!-- hamster:begin transcript -->',
      '> [!quote]- Transcript',
      '<!-- hamster:end transcript -->',
      '',
    ].join('\n');
    assert.equal(TEMPLATE, expected);
  });

  it('ends with a single newline and holds one wikilink, the daily', () => {
    assert.ok(TEMPLATE.endsWith('-->\n'));
    assert.ok(!TEMPLATE.endsWith('\n\n'));
    assert.deepEqual(TEMPLATE.match(/\[\[[^\]]*\]\]/g), ['[[2026-10-09]]']);
  });

  it('writes several attendees and projects as a flow sequence of JSON strings', () => {
    const text = renderCompanion({
      ...META,
      attendees: ['Alex Sample', 'Jordan "JD" Demo'],
      projects: ['Budget: phase #2'],
    });
    assert.ok(text.includes('attendees: ["Alex Sample", "Jordan \\"JD\\" Demo"]\n'));
    assert.ok(text.includes('projects: ["Budget: phase #2"]\n'));
  });

  it('gives every region a valid, empty structure', () => {
    for (const region of REGIONS) {
      assert.notEqual(regionRange(TEMPLATE, region), null, region);
    }
    assert.equal(readRegion(TEMPLATE, 'enhanced'), '');
    assert.equal(readRegion(TEMPLATE, 'summary'), '');
    assert.equal(readRegion(TEMPLATE, 'qa'), '');
    assert.equal(readRegion(TEMPLATE, 'transcript'), `${TRANSCRIPT_CALLOUT}\n`);
  });

  it('keeps a title with a line break from producing a marker line', () => {
    const text = renderCompanion({ ...META, title: 'Odd title\n<!-- hamster:begin enhanced -->' });
    assert.ok(text.includes('\n# Odd title <!-- hamster:begin enhanced -->\n'));
    assert.notEqual(regionRange(text, 'enhanced'), null);
  });

  it('collapses line breaks in the title and nothing else, however long the gaps', () => {
    const h1 = (title: string): string => renderCompanion({ ...META, title }).split('\n')[14];
    assert.equal(h1('  Weekly   sync\t(room B)  '), '# Weekly   sync\t(room B)');
    assert.equal(h1('\r\n One \r\n\r\n\t two\n\nthree \n'), '# One two three');
    assert.equal(h1(' \n\t\n '), '# ');
    const gap = ' '.repeat(LONG_RUN);
    assert.equal(quickly(() => h1(`Weekly${gap}sync`)), `# Weekly${gap}sync`);
  });

  it('escapes the characters YAML reads as line breaks, and reads them back', () => {
    const odd = 'Line\u2028sep, para\u2029sep, next\u0085line, del\u007f, mark\ufeff, tab\tand\nbreak';
    const text = renderCompanion({ ...META, attendees: [odd], source: `${odd}#0` });
    const frontmatter = text.slice(0, text.indexOf('\n---\n'));
    assert.equal(frontmatter.split('\n').length, 12);
    assert.ok(!/[\u007f-\u009f\u2028\u2029\ufeff\t]/.test(frontmatter));
    assert.ok(frontmatter.includes('Line\\u2028sep, para\\u2029sep, next\\u0085line, del\\u007f, mark\\ufeff, tab\\tand\\nbreak#0"'));
    assert.equal(readCompanionKeys(text).source, `${odd}#0`);
    for (const region of REGIONS) assert.notEqual(regionRange(text, region), null, region);
  });

  it('quotes a date that is not a plain day', () => {
    const text = renderCompanion({ ...META, date: 'soon: maybe' });
    assert.ok(text.includes('\ndate: "soon: maybe"\n'));
    assert.equal(readCompanionKeys(text).date, 'soon: maybe');
  });
});

describe('merge: replace regions', () => {
  it('replaces the content between the markers', () => {
    const result = ok(merge(TEMPLATE, { region: 'enhanced', content: '* **Budget:** approved\n* **Hiring:** paused' }));
    assert.equal(result.changed, true);
    assert.equal(readRegion(result.text, 'enhanced'), '* **Budget:** approved\n* **Hiring:** paused\n');
    assert.ok(
      result.text.includes(
        '## Enhanced notes\n<!-- hamster:begin enhanced -->\n* **Budget:** approved\n* **Hiring:** paused\n<!-- hamster:end enhanced -->\n\n## AI summary\n',
      ),
    );
  });

  it('replaces what was there, not appends to it', () => {
    const first = ok(merge(TEMPLATE, { region: 'summary', content: 'First version.' }));
    const second = ok(merge(first.text, { region: 'summary', content: 'Second version.' }));
    assert.equal(readRegion(second.text, 'summary'), 'Second version.\n');
    assert.ok(!second.text.includes('First version.'));
  });

  it('trims blank lines around the content and ends it with one newline', () => {
    const result = ok(merge(TEMPLATE, { region: 'qa', content: '\n  \n\n**Q:** Why?\n\n**A:** Because.\n\n\n   \n' }));
    assert.equal(readRegion(result.text, 'qa'), '**Q:** Why?\n\n**A:** Because.\n');
  });

  it('keeps the indentation of the first line', () => {
    const result = ok(merge(TEMPLATE, { region: 'enhanced', content: '\n    indented first line\nsecond' }));
    assert.equal(readRegion(result.text, 'enhanced'), '    indented first line\nsecond\n');
  });

  it('stays fast on content with a very long run of blank lines', () => {
    // A model that degenerates into newlines, saved without passing through the sanitizer.
    for (const blank of ['\n', '  \n', '\r\n']) {
      const content = `first${blank.repeat(LONG_RUN)}last`;
      const result = quickly(() => ok(merge(TEMPLATE, { region: 'summary', content: `\n${content}\n\n` })));
      assert.equal(readRegion(result.text, 'summary'), `${content}\n`);
    }
    const padded = quickly(() => ok(merge(TEMPLATE, { region: 'summary', content: `kept  ${'\r\n \t'.repeat(LONG_RUN)}` })));
    assert.equal(readRegion(padded.text, 'summary'), 'kept  \n');
  });

  it('trims only whole blank lines at the end, whatever the line endings', () => {
    const cases: Array<[string, string]> = [
      ['x  ', 'x  \n'],
      ['x\t \n \n\t', 'x\t \n'],
      ['x\r\n\r\n', 'x\n'],
      ['x\r\n \t\r\n\n', 'x\n'],
      ['x\n\ny  \n\n', 'x\n\ny  \n'],
    ];
    for (const [content, stored] of cases) {
      assert.equal(readRegion(ok(merge(TEMPLATE, { region: 'qa', content })).text, 'qa'), stored, JSON.stringify(content));
    }
  });

  it('makes the marker lines adjacent when the content is empty', () => {
    const filled = ok(merge(TEMPLATE, { region: 'enhanced', content: 'something' }));
    for (const content of ['', '\n\n', '   \n \t \n']) {
      const cleared = ok(merge(filled.text, { region: 'enhanced', content }));
      assert.equal(cleared.changed, true);
      assert.equal(cleared.text, TEMPLATE);
      assert.ok(cleared.text.includes('<!-- hamster:begin enhanced -->\n<!-- hamster:end enhanced -->\n'));
    }
  });

  it('reports no change for an identical replace', () => {
    const first = ok(merge(TEMPLATE, { region: 'summary', content: 'Same text.' }));
    const again = ok(merge(first.text, { region: 'summary', content: 'Same text.' }));
    assert.equal(again.changed, false);
    assert.equal(again.text, first.text);

    const padded = ok(merge(first.text, { region: 'summary', content: '\n\nSame text.\n\n' }));
    assert.equal(padded.changed, false);

    const emptyOnEmpty = ok(merge(TEMPLATE, { region: 'enhanced', content: '' }));
    assert.equal(emptyOnEmpty.changed, false);
    assert.equal(emptyOnEmpty.text, TEMPLATE);
  });
});

describe('merge: transcript', () => {
  it('appends before the end marker, twice, in order', () => {
    const one = ok(merge(TEMPLATE, { region: 'transcript', append: '> **[00:01] Mic:** first line' }));
    assert.equal(one.changed, true);
    const two = ok(
      merge(one.text, { region: 'transcript', append: '> **[00:31] Mic:** second line\n> **[00:40] Mic:** third line\n' }),
    );
    assert.equal(
      readRegion(two.text, 'transcript'),
      [
        '> [!quote]- Transcript',
        '> **[00:01] Mic:** first line',
        '> **[00:31] Mic:** second line',
        '> **[00:40] Mic:** third line',
        '',
      ].join('\n'),
    );
    assert.ok(two.text.endsWith('> **[00:40] Mic:** third line\n<!-- hamster:end transcript -->\n'));
  });

  it('does nothing for an empty append', () => {
    for (const append of ['', '\n', '\r\n\n', '   ']) {
      const result = ok(merge(TEMPLATE, { region: 'transcript', append }));
      assert.equal(result.changed, false);
      assert.equal(result.text, TEMPLATE);
    }
  });

  it('drops newlines around the appended text so the callout stays whole', () => {
    const result = ok(merge(TEMPLATE, { region: 'transcript', append: '\n\n> **[00:05] Mic:** hello\n\n\n' }));
    assert.equal(readRegion(result.text, 'transcript'), '> [!quote]- Transcript\n> **[00:05] Mic:** hello\n');
  });

  it('stays fast on an append with a very long run of line breaks inside', () => {
    for (const eol of ['\n', '\r\n']) {
      const append = `> one${eol.repeat(LONG_RUN)}> two`;
      const result = quickly(() => ok(merge(TEMPLATE, { region: 'transcript', append: `\n${append}${eol}${eol}` })));
      assert.equal(readRegion(result.text, 'transcript'), `${TRANSCRIPT_CALLOUT}\n${append}\n`);
    }
  });

  it('still reports a damaged region when the append is empty', () => {
    const damaged = TEMPLATE.replace(`${endMarker('transcript')}\n`, '');
    assert.equal(structureError(merge(damaged, { region: 'transcript', append: '' })), 'transcript');
  });
});

describe('merge: damaged structure is never repaired', () => {
  it('refuses when the end marker is missing', () => {
    const damaged = TEMPLATE.replace(`${endMarker('enhanced')}\n`, '');
    assert.equal(structureError(merge(damaged, { region: 'enhanced', content: 'x' })), 'enhanced');
    assert.equal(readRegion(damaged, 'enhanced'), null);
    assert.equal(regionRange(damaged, 'enhanced'), null);
  });

  it('refuses when the begin marker is missing', () => {
    const damaged = TEMPLATE.replace(`${beginMarker('qa')}\n`, '');
    assert.equal(structureError(merge(damaged, { region: 'qa', content: 'x' })), 'qa');
  });

  it('refuses when the begin marker is duplicated', () => {
    const damaged = TEMPLATE.replace(beginMarker('summary'), `${beginMarker('summary')}\n${beginMarker('summary')}`);
    assert.equal(structureError(merge(damaged, { region: 'summary', content: 'x' })), 'summary');
  });

  it('refuses when the end marker is duplicated far away', () => {
    const damaged = `${TEMPLATE}\n${endMarker('enhanced')}\n`;
    assert.equal(structureError(merge(damaged, { region: 'enhanced', content: 'x' })), 'enhanced');
  });

  it('refuses when a second end marker sits above the region', () => {
    // Nothing lies between the real pair, so only the count can catch this one.
    const damaged = TEMPLATE.replace('## Enhanced notes\n', `${endMarker('enhanced')}\n## Enhanced notes\n`);
    assert.equal(structureError(merge(damaged, { region: 'enhanced', content: 'x' })), 'enhanced');
    assert.equal(regionRange(damaged, 'enhanced'), null);
    assert.equal(ok(merge(damaged, { region: 'summary', content: 'x' })).changed, true);
  });

  it('refuses when a second begin marker sits below the region', () => {
    const damaged = `${TEMPLATE}\n${beginMarker('qa')}\n`;
    assert.equal(structureError(merge(damaged, { region: 'qa', content: 'x' })), 'qa');
    assert.equal(stripRegion(damaged, 'qa'), damaged);
  });

  it('refuses when the end marker comes first', () => {
    const damaged = TEMPLATE.replace(
      `${beginMarker('enhanced')}\n${endMarker('enhanced')}`,
      `${endMarker('enhanced')}\n${beginMarker('enhanced')}`,
    );
    assert.equal(structureError(merge(damaged, { region: 'enhanced', content: 'x' })), 'enhanced');
  });

  it('refuses both regions when they interleave', () => {
    const damaged = [
      '# Note',
      beginMarker('enhanced'),
      'a',
      beginMarker('summary'),
      'b',
      endMarker('enhanced'),
      'c',
      endMarker('summary'),
      '',
    ].join('\n');
    assert.equal(structureError(merge(damaged, { region: 'enhanced', content: 'x' })), 'enhanced');
    assert.equal(structureError(merge(damaged, { region: 'summary', content: 'x' })), 'summary');
  });

  it('refuses a region that swallowed another one whole', () => {
    const damaged = TEMPLATE.replace(`${endMarker('enhanced')}\n`, '').replace(
      `${endMarker('summary')}\n`,
      `${endMarker('summary')}\n${endMarker('enhanced')}\n`,
    );
    assert.equal(structureError(merge(damaged, { region: 'enhanced', content: 'x' })), 'enhanced');
    // The inner region is intact and still writable.
    assert.equal(ok(merge(damaged, { region: 'summary', content: 'x' })).changed, true);
  });

  it('refuses when a reflowed or unknown hamster marker sits inside the region', () => {
    for (const intruder of ['  <!-- hamster:begin summary -->', '<!--hamster:end qa-->', '<!-- hamster:begin future -->']) {
      const damaged = TEMPLATE.replace(
        `${beginMarker('enhanced')}\n`,
        `${beginMarker('enhanced')}\nold content\n${intruder}\n`,
      );
      assert.equal(structureError(merge(damaged, { region: 'enhanced', content: 'x' })), 'enhanced', intruder);
    }
  });

  it('stays fast on a marker-like line with a very long gap in it', () => {
    const gap = ' '.repeat(LONG_RUN);
    const stray = `<!-- hamster:note${gap}still the same comment -->`;
    const outside = `${TEMPLATE}\n${stray}\n`;
    assert.notEqual(quickly(() => regionRange(outside, 'qa')), null);
    const inside = TEMPLATE.replace(`${beginMarker('qa')}\n`, `${beginMarker('qa')}\n${stray}\n`);
    assert.equal(quickly(() => regionRange(inside, 'qa')), null);
    // Trailing spaces after a real marker are still tolerated, however many.
    const spaced = TEMPLATE.replace(endMarker('qa'), `${endMarker('qa')}${gap}`);
    assert.notEqual(quickly(() => regionRange(spaced, 'qa')), null);
  });

  it('does not count a marker that shares its line with other text', () => {
    const text = TEMPLATE.replace(
      '# 1:1 Alex Sample\n',
      `# 1:1 Alex Sample\n\nThe plugin writes between \`${beginMarker('enhanced')}\` and its end marker.\n- ${endMarker('enhanced')}\n`,
    );
    const result = ok(merge(text, { region: 'enhanced', content: 'x' }));
    assert.equal(readRegion(result.text, 'enhanced'), 'x\n');
  });

  it('treats an indented marker as missing', () => {
    const damaged = TEMPLATE.replace(beginMarker('enhanced'), `  ${beginMarker('enhanced')}`);
    assert.equal(structureError(merge(damaged, { region: 'enhanced', content: 'x' })), 'enhanced');
  });

  it('rejects content that carries a marker', () => {
    const cases = [
      `fine\n${endMarker('enhanced')}\nmore`,
      `inline ${beginMarker('summary')} text`,
      '<!--hamster:end enhanced-->',
      '<!--   hamster:anything',
      '<!--\nhamster:begin qa -->',
    ];
    for (const content of cases) {
      assert.equal(structureError(merge(TEMPLATE, { region: 'enhanced', content })), 'enhanced', content);
    }
    assert.equal(
      structureError(merge(TEMPLATE, { region: 'transcript', append: `> said ${endMarker('transcript')}` })),
      'transcript',
    );
  });

  it('accepts ordinary HTML comments in content', () => {
    const result = ok(merge(TEMPLATE, { region: 'summary', content: 'Text <!-- a plain comment --> more' }));
    assert.equal(readRegion(result.text, 'summary'), 'Text <!-- a plain comment --> more\n');
  });
});

describe('merge: everything outside the region is preserved', () => {
  it('tolerates trailing spaces and tabs after a marker', () => {
    const spaced = TEMPLATE.replace(beginMarker('enhanced'), `${beginMarker('enhanced')}  \t`).replace(
      endMarker('enhanced'),
      `${endMarker('enhanced')}   `,
    );
    const result = ok(merge(spaced, { region: 'enhanced', content: 'x' }));
    assert.ok(result.text.includes(`${beginMarker('enhanced')}  \t\nx\n${endMarker('enhanced')}   \n`));
  });

  it('leaves user text and user headings untouched, byte for byte', () => {
    const before = lived();
    const patches = [
      { region: 'enhanced', content: '* **Topic:** rewritten\n* **Other:** line' },
      { region: 'summary', content: 'A summary.' },
      { region: 'qa', content: '**Q:** One?\n\n**A:** Yes.' },
    ] as const;

    for (const patch of patches) {
      const range = regionRange(before, patch.region);
      assert.ok(range);
      const after = ok(merge(before, patch)).text;
      const newRange = regionRange(after, patch.region);
      assert.ok(newRange);
      assert.equal(after.slice(0, newRange.from), before.slice(0, range.from));
      assert.equal(after.slice(newRange.to), before.slice(range.to));
      assert.equal(after.slice(newRange.from, newRange.to), `${patch.content}\n`);
    }

    const range = regionRange(before, 'transcript');
    assert.ok(range);
    const after = ok(merge(before, { region: 'transcript', append: '> **[00:01] Mic:** hi' })).text;
    assert.equal(after.slice(0, range.to), before.slice(0, range.to));
    assert.equal(after.slice(range.to), `> **[00:01] Mic:** hi\n${before.slice(range.to)}`);
    assert.ok(after.includes('### A heading of mine\n\n- my bullet\n'));
    assert.ok(after.endsWith('\n## Afterthoughts\n\nSomething I typed below the transcript.\n'));
  });

  it('keeps a file without a trailing newline that way', () => {
    const bare = TEMPLATE.slice(0, -1);
    assert.ok(bare.endsWith(endMarker('transcript')));

    const appended = ok(merge(bare, { region: 'transcript', append: '> **[00:01] Mic:** hi' })).text;
    assert.ok(appended.endsWith(`> **[00:01] Mic:** hi\n${endMarker('transcript')}`));

    const replaced = ok(merge(bare, { region: 'enhanced', content: 'x' })).text;
    assert.ok(replaced.endsWith(endMarker('transcript')));
    assert.equal(replaced.length, bare.length + 2);
  });

  it('keeps user text after the last region when the file has no final newline', () => {
    const text = `${TEMPLATE}\nlast words`;
    const result = ok(merge(text, { region: 'qa', content: 'x' })).text;
    assert.ok(result.endsWith(`${endMarker('transcript')}\n\nlast words`));
  });

  it('works on a CRLF file and leaves its line endings alone', () => {
    const crlf = lived().replace(/\n/g, '\r\n');
    const range = regionRange(crlf, 'enhanced');
    assert.ok(range);
    assert.equal(crlf.slice(range.from - 2, range.from), '\r\n');

    const result = ok(merge(crlf, { region: 'enhanced', content: 'one\ntwo' }));
    assert.equal(result.changed, true);
    const newRange = regionRange(result.text, 'enhanced');
    assert.ok(newRange);
    assert.equal(result.text.slice(0, newRange.from), crlf.slice(0, range.from));
    assert.equal(result.text.slice(newRange.to), crlf.slice(range.to));
    assert.equal(readRegion(result.text, 'enhanced'), 'one\ntwo\n');

    const again = ok(merge(result.text, { region: 'enhanced', content: 'one\ntwo' }));
    assert.equal(again.changed, false);

    const appended = ok(merge(crlf, { region: 'transcript', append: '> **[00:01] Mic:** hi' })).text;
    assert.equal(readRegion(appended, 'transcript'), '> [!quote]- Transcript\r\n> **[00:01] Mic:** hi\n');
    for (const region of REGIONS) assert.notEqual(regionRange(appended, region), null, region);
  });
});

describe('mergeAll', () => {
  it('applies every patch in order', () => {
    const result = mergeAll(TEMPLATE, [
      { region: 'enhanced', content: 'E' },
      { region: 'transcript', append: '> one' },
      { region: 'summary', content: 'S' },
      { region: 'transcript', append: '> two' },
    ]);
    assert.equal(result.changed, true);
    assert.deepEqual(result.detached, []);
    assert.equal(readRegion(result.text, 'enhanced'), 'E\n');
    assert.equal(readRegion(result.text, 'summary'), 'S\n');
    assert.equal(readRegion(result.text, 'transcript'), '> [!quote]- Transcript\n> one\n> two\n');
  });

  it('skips a damaged region, applies the rest and reports it once', () => {
    const damaged = TEMPLATE.replace(`${endMarker('summary')}\n`, '');
    const result = mergeAll(damaged, [
      { region: 'summary', content: 'S1' },
      { region: 'enhanced', content: 'E' },
      { region: 'summary', content: 'S2' },
      { region: 'transcript', append: '> one' },
    ]);
    assert.equal(result.changed, true);
    assert.deepEqual(result.detached, ['summary']);
    assert.equal(readRegion(result.text, 'enhanced'), 'E\n');
    assert.equal(readRegion(result.text, 'transcript'), '> [!quote]- Transcript\n> one\n');
    assert.ok(!result.text.includes('S1') && !result.text.includes('S2'));
  });

  it('reports no change when nothing applies or nothing differs', () => {
    assert.deepEqual(mergeAll(TEMPLATE, []), { text: TEMPLATE, changed: false, detached: [] });
    assert.deepEqual(mergeAll('no markers here', [{ region: 'qa', content: 'x' }]), {
      text: 'no markers here',
      changed: false,
      detached: ['qa'],
    });
    const once = mergeAll(TEMPLATE, [{ region: 'qa', content: 'x' }]).text;
    assert.equal(mergeAll(once, [{ region: 'qa', content: 'x' }]).changed, false);
  });
});

describe('regionRange, readRegion, stripRegion', () => {
  it('slices exactly the content', () => {
    const text = ok(merge(lived(), { region: 'summary', content: 'Line one.\n\nLine two.' })).text;
    const range = regionRange(text, 'summary');
    assert.ok(range);
    assert.equal(text.slice(range.from, range.to), 'Line one.\n\nLine two.\n');
    assert.ok(text.slice(0, range.from).endsWith(`${beginMarker('summary')}\n`));
    assert.ok(text.slice(range.to).startsWith(endMarker('summary')));
    assert.equal(readRegion(text, 'summary'), text.slice(range.from, range.to));
  });

  it('gives an empty range for an empty region', () => {
    const range = regionRange(TEMPLATE, 'qa');
    assert.ok(range);
    assert.equal(range.from, range.to);
    assert.equal(range.to, TEMPLATE.indexOf(endMarker('qa')));
  });

  it('strips the transcript, callout line included, and keeps the markers', () => {
    const full = mergeAll(lived(), [
      { region: 'transcript', append: '> **[00:01] Mic:** hello\n> **[00:09] Mic:** bye' },
      { region: 'enhanced', content: 'kept' },
    ]).text;
    const stripped = stripRegion(full, 'transcript');
    assert.ok(!stripped.includes('[!quote]'));
    assert.ok(!stripped.includes('hello'));
    assert.ok(stripped.includes(`${beginMarker('transcript')}\n${endMarker('transcript')}\n`));
    assert.equal(readRegion(stripped, 'transcript'), '');
    assert.equal(readRegion(stripped, 'enhanced'), 'kept\n');
    assert.ok(stripped.endsWith('Something I typed below the transcript.\n'));
  });

  it('leaves the note unchanged when the region is damaged', () => {
    const damaged = TEMPLATE.replace(beginMarker('transcript'), '');
    assert.equal(stripRegion(damaged, 'transcript'), damaged);
  });
});

describe('readCompanionKeys', () => {
  it('round-trips with renderCompanion', () => {
    assert.deepEqual(readCompanionKeys(TEMPLATE), { date: '2026-10-09', source: '1:1 Alex Sample#0' });
  });

  it('round-trips a title with #, quotes, colons and a backslash', () => {
    const source = 'Budget "Q4" #2: review \\ plan — été#3';
    const text = renderCompanion({ ...META, title: 'Budget "Q4" #2: review', source });
    assert.deepEqual(readCompanionKeys(text), { date: '2026-10-09', source });
  });

  it('still reads the keys after the regions were written and on CRLF files', () => {
    const written = mergeAll(TEMPLATE, [{ region: 'enhanced', content: 'date: 1999-01-01' }]).text;
    assert.deepEqual(readCompanionKeys(written), { date: '2026-10-09', source: '1:1 Alex Sample#0' });
    assert.deepEqual(readCompanionKeys(TEMPLATE.replace(/\n/g, '\r\n')), {
      date: '2026-10-09',
      source: '1:1 Alex Sample#0',
    });
  });

  it('reads a file that starts with a byte order mark', () => {
    assert.deepEqual(readCompanionKeys(`\ufeff${TEMPLATE}`), { date: '2026-10-09', source: '1:1 Alex Sample#0' });
  });

  it('reads plain and single-quoted scalars, as other tools rewrite them', () => {
    const plain = '---\ndate: 2026-10-09   # the day\nhamster_source: 1:1 Alex Sample#0\n---\nbody\n';
    assert.deepEqual(readCompanionKeys(plain), { date: '2026-10-09', source: '1:1 Alex Sample#0' });

    const single = "---\ndate: '2026-10-09'\nhamster_source: 'It''s a title#1'\n---\n";
    assert.deepEqual(readCompanionKeys(single), { date: '2026-10-09', source: "It's a title#1" });

    const dateTime = '---\ndate: 2026-10-09T00:00:00\nhamster_source: "Steering#0"\n---\n';
    assert.deepEqual(readCompanionKeys(dateTime), { date: '2026-10-09', source: 'Steering#0' });
  });

  it('returns nulls without frontmatter, with an unclosed one, or without the keys', () => {
    const none = { date: null, source: null };
    assert.deepEqual(readCompanionKeys('# Just a note\n\ndate: 2026-10-09\n'), none);
    assert.deepEqual(readCompanionKeys(''), none);
    assert.deepEqual(readCompanionKeys('---\ndate: 2026-10-09\nhamster_source: "x#0"\n'), none);
    assert.deepEqual(readCompanionKeys('\n---\ndate: 2026-10-09\n---\n'), none);
    assert.deepEqual(readCompanionKeys('---\ntype: meeting\n---\n'), none);
    assert.deepEqual(readCompanionKeys('---\ndate:\nhamster_source: [a, b]\n---\n'), none);
  });

  it('stays fast on frontmatter lines with a very long run of spaces', () => {
    const gap = ' '.repeat(LONG_RUN);
    const text = `---\nnote: a${gap}b\ndate: 2026-10-09${gap}# the day\nhamster_source: Weekly${gap}sync#0\n---${gap}\nbody\n`;
    assert.deepEqual(quickly(() => readCompanionKeys(text)), { date: '2026-10-09', source: `Weekly${gap}sync#0` });
  });

  it('cuts a plain value at its comment and nowhere else', () => {
    const read = (value: string): string | null => readCompanionKeys(`---\nhamster_source: ${value}\n---\n`).source;
    assert.equal(read('Sync#0 \t # note # more'), 'Sync#0');
    assert.equal(read('Budget#2 review#0'), 'Budget#2 review#0');
    assert.equal(read('Sync   #0'), 'Sync');
  });

  it('ignores nested keys and keys below the frontmatter', () => {
    const text = '---\nmeta:\n  date: 1999-01-01\ndate: 2026-10-09\n---\nhamster_source: "below#0"\n';
    assert.deepEqual(readCompanionKeys(text), { date: '2026-10-09', source: null });
  });
});

describe('extra properties', () => {
  it('none by default: the plugin writes only its own', () => {
    const text = renderCompanion({ ...META, properties: undefined });
    assert.doesNotMatch(text, /^area:|^status:/m);
    assert.match(text, /^---\ntype: meeting\ncreated: 2026-10-09\n/);
  });

  it('as typed when plain, quoted when YAML would read them otherwise', () => {
    const text = renderCompanion({
      ...META,
      properties: [
        ['area', 'work'],
        ['team', 'Platform & Identity'],
        ['done', 'yes'],
        ['note', 'a: b'],
      ],
    });
    assert.match(text, /^area: work$/m);
    assert.match(text, /^team: "Platform & Identity"$/m);
    assert.match(text, /^done: "yes"$/m, 'not a boolean');
    assert.match(text, /^note: "a: b"$/m);
  });

  it('parseCompanionProperties reads key: value lines and refuses what would break the note', () => {
    assert.deepEqual(parseCompanionProperties('area: work\n\n  status :  active  '), {
      properties: [
        ['area', 'work'],
        ['status', 'active'],
      ],
    });
    assert.deepEqual(parseCompanionProperties(''), { properties: [] });
    assert.match(String((parseCompanionProperties('just text') as { error: string }).error), /not key: value/);
    assert.match(String((parseCompanionProperties('tags: x') as { error: string }).error), /written by the plugin/);
    assert.match(String((parseCompanionProperties('Date: x') as { error: string }).error), /written by the plugin/);
    assert.match(String((parseCompanionProperties('a: 1\nA: 2') as { error: string }).error), /twice/);
    assert.match(String((parseCompanionProperties('area:') as { error: string }).error), /no value/);
  });
});
