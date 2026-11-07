import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isLinkLine, sectionAt, stripWikilinks, wikilinks } from '../src/editor/sectionAt.ts';
import {
  companionBasename,
  companionPath,
  dailyLinkLine,
  hasDotSegments,
  sanitizeTitle,
  vaultFolder,
} from '../src/notes/sanitize.ts';

describe('sanitizeTitle', () => {
  test('the example from the plan', () => {
    assert.equal(sanitizeTitle('1:1 Jane Example'), '1-1 Jane Example');
    assert.equal(
      companionBasename('Mtg-', '2026-10-09', '1:1 Jane Example'),
      'Mtg-2026-10-09 — 1-1 Jane Example',
    );
  });

  test('aliases already stripped upstream', () => {
    assert.equal(sanitizeTitle(stripWikilinks('1:1 [[Jane Example|Jane]]')), '1-1 Jane Example');
    assert.equal(sanitizeTitle(stripWikilinks('[[Projects/IAM#Scope]] - dry run')), 'IAM - dry run');
  });

  test('brackets that slip through are removed, not kept', () => {
    assert.equal(sanitizeTitle('1:1 [[Jane Example]]'), '1-1 Jane Example');
    assert.equal(sanitizeTitle('[[Steering Board]]'), 'Steering Board');
  });

  test('R&D survives', () => {
    assert.equal(sanitizeTitle('Steering comittee R&D'), 'Steering comittee R&D');
  });

  test('emoji and accents survive', () => {
    assert.equal(sanitizeTitle('🗄️Work'), '🗄️Work');
    assert.equal(sanitizeTitle('Rencontre équipe · suivi à faire'), 'Rencontre équipe · suivi à faire');
    assert.equal(sanitizeTitle('👩‍💻 Dev sync'), '👩‍💻 Dev sync');
  });

  test('every illegal character is removed', () => {
    assert.equal(sanitizeTitle('a[b]c#d^e|f/g\\h*i?j"k<l>m'), 'abcdefghijklm');
    assert.equal(sanitizeTitle('Review C# plan'), 'Review C plan');
    assert.equal(sanitizeTitle('Q3/Q4 budget?'), 'Q3Q4 budget');
    assert.equal(sanitizeTitle('10:30 sync: part 2'), '10-30 sync- part 2');
  });

  test('whitespace is collapsed and control characters dropped', () => {
    assert.equal(sanitizeTitle('  a \t b\n\nc  '), 'a b c');
    assert.equal(sanitizeTitle('a\u0000b\u0007c\u007fd\u009fe'), 'abcde');
    assert.equal(sanitizeTitle('a | b'), 'a b');
    assert.equal(sanitizeTitle('a \u0001 b'), 'a b');
    assert.equal(sanitizeTitle('a b'), 'a b');
  });

  test('trailing dots and spaces are stripped', () => {
    assert.equal(sanitizeTitle('Rencontre avec Léa, Maya et Tom et Noé.'), 'Rencontre avec Léa, Maya et Tom et Noé');
    assert.equal(sanitizeTitle('To be continued... '), 'To be continued');
    assert.equal(sanitizeTitle('v1.2 review'), 'v1.2 review');
  });

  test('cut to 60 characters at a word boundary', () => {
    const long = 'Quarterly planning review with the whole portfolio team and every stakeholder';
    const cut = sanitizeTitle(long);
    assert.equal(cut, 'Quarterly planning review with the whole portfolio team and');
    assert.ok(cut.length <= 60);
    assert.ok(long.startsWith(`${cut} `));
  });

  test('a title of exactly 60 characters is kept whole', () => {
    const exact = `${'a'.repeat(30)} ${'b'.repeat(29)}`;
    assert.equal(exact.length, 60);
    assert.equal(sanitizeTitle(exact), exact);
    assert.equal(sanitizeTitle(`${exact} more`), exact);
    // The second word now runs past the limit: back to the last whole word.
    assert.equal(sanitizeTitle(`${exact}more`), 'a'.repeat(30));
  });

  test('a single very long word is cut hard rather than lost', () => {
    assert.equal(sanitizeTitle('x'.repeat(200)), 'x'.repeat(60));
    assert.equal(sanitizeTitle(`ab ${'x'.repeat(200)}`), `ab ${'x'.repeat(57)}`);
  });

  test('the cut never leaves a dot, a space or half an emoji at the end', () => {
    assert.equal(sanitizeTitle(`${'a'.repeat(58)}. bcd`), 'a'.repeat(58));
    const emoji = sanitizeTitle(`${'a'.repeat(59)}😀😀`);
    assert.equal(emoji, 'a'.repeat(59));
    assert.equal(sanitizeTitle(`${'a'.repeat(58)}😀😀`), `${'a'.repeat(58)}😀`);
  });

  test('a cut through the second half of a joined emoji leaves no joiner behind', () => {
    const joined = '\u{1f469}\u200d\u{1f4bb}';
    // 56 + woman (2) + joiner (1) + the first half of the laptop (1) = 60.
    const cut = sanitizeTitle(`${'a'.repeat(56)}${joined}x`);
    assert.equal(cut, `${'a'.repeat(56)}\u{1f469}`);
    assert.ok(!/[\u200d\ud800-\udbff]$/.test(cut));
    const family = sanitizeTitle(`${'a'.repeat(52)}\u{1f469}\u200d\u{1f469}\u200d\u{1f467}`);
    assert.ok(!/[\u200d\ud800-\udbff]$/.test(family), JSON.stringify(family.slice(-4)));
  });

  test('half an emoji that arrives in the title is dropped, a whole one is kept', () => {
    // A title cut somewhere upstream; half a pair cannot be written in a file name.
    assert.equal(sanitizeTitle('Budget \ud83d'), 'Budget');
    assert.equal(sanitizeTitle('\udc00Budget \ud83d review'), 'Budget review');
    assert.equal(sanitizeTitle('Budget \u{1f600}'), 'Budget \u{1f600}');
  });

  test('a custom maximum length', () => {
    assert.equal(sanitizeTitle('alpha beta gamma delta', 12), 'alpha beta');
    assert.equal(sanitizeTitle('alpha beta gamma delta', 10), 'alpha beta');
    assert.equal(sanitizeTitle('alpha', 3), 'alp');
    assert.equal(sanitizeTitle('alpha beta gamma', 0), 'alpha beta gamma');
  });

  test('an all-illegal or empty title becomes Meeting', () => {
    assert.equal(sanitizeTitle('[[]]??'), 'Meeting');
    assert.equal(sanitizeTitle('###'), 'Meeting');
    assert.equal(sanitizeTitle('...'), 'Meeting');
    assert.equal(sanitizeTitle('   '), 'Meeting');
    assert.equal(sanitizeTitle(''), 'Meeting');
  });

  test('an accent that meets its letter once a character is removed is still composed', () => {
    // e, an illegal character, then a combining acute: removing the middle one must not leave "e" + accent.
    const clean = sanitizeTitle('Re#\u0301union e\u0000\u0301te\u0301');
    assert.equal(clean, 'R\u00e9union \u00e9t\u00e9');
    assert.equal(clean, clean.normalize('NFC'));
    assert.equal(sanitizeTitle(clean), clean);
  });

  test('composed and decomposed accents give the same name', () => {
    assert.equal(sanitizeTitle('Réunion'), sanitizeTitle('Réunion'));
  });

  test('the result is always a legal file name', () => {
    const titles = ['1:1 [[A|B]]', 'a/b\\c', '  ..  ', 'C# & F#: notes?', '<tag> "quoted" *star*', 'x'.repeat(500), '\t\n'];
    for (const title of titles) {
      const clean = sanitizeTitle(title);
      assert.ok(clean.length >= 1 && clean.length <= 60, title);
      assert.ok(!/[[\]#^|\/\\*?"<>:\u0000-\u001f]/.test(clean), title);
      assert.ok(!/[. ]$/.test(clean) && !clean.startsWith(' '), title);
      assert.equal(sanitizeTitle(clean), clean, 'sanitizing twice changes nothing');
    }
  });
});

describe('companionBasename', () => {
  test('prefix, date, em dash, sanitized title', () => {
    assert.equal(companionBasename('Mtg-', '2026-10-09', '1:1 Jane Example'), 'Mtg-2026-10-09 — 1-1 Jane Example');
    assert.equal(companionBasename('Mtg-', '2026-10-09', 'Steering comittee R&D'), 'Mtg-2026-10-09 — Steering comittee R&D');
    assert.equal(companionBasename('Meet ', '2026-01-02', '🗄️Work'), 'Meet 2026-01-02 — 🗄️Work');
    assert.equal(companionBasename('Mtg-', '2026-10-09', '??'), 'Mtg-2026-10-09 — Meeting');
  });
});

describe('companionPath', () => {
  const base = 'Mtg-2026-10-09 — 1-1 Jane Example';

  test('folder, basename, extension', () => {
    assert.equal(companionPath('00 Inbox', base, () => false), `00 Inbox/${base}.md`);
    assert.equal(companionPath('10 Work/Meetings', base, () => false), `10 Work/Meetings/${base}.md`);
  });

  test('no leading slash for the vault root', () => {
    assert.equal(companionPath('', base, () => false), `${base}.md`);
    assert.equal(companionPath('/', base, () => false), `${base}.md`);
  });

  test('slashes around the folder are ignored', () => {
    assert.equal(companionPath('00 Inbox/', base, () => false), `00 Inbox/${base}.md`);
    assert.equal(companionPath('/00 Inbox//', base, () => false), `00 Inbox/${base}.md`);
  });

  test('a folder that arrived by sync with . or .. segments loses them: nothing is written outside the vault', () => {
    assert.equal(companionPath('../outside', base, () => false), `outside/${base}.md`);
    // The segment is dropped, not resolved: "a/../b" names the folder the user typed, minus the climb.
    assert.equal(companionPath('a/../b', base, () => false), `a/b/${base}.md`);
    assert.equal(companionPath('./x//y', base, () => false), `x/y/${base}.md`);
    assert.equal(companionPath('..', base, () => false), `${base}.md`);
  });

  test('vaultFolder and hasDotSegments', () => {
    assert.equal(vaultFolder(' /10 Work/Meetings/ '), '10 Work/Meetings');
    assert.equal(vaultFolder('/'), '');
    assert.equal(vaultFolder('a/./b/../c'), 'a/b/c');
    assert.equal(hasDotSegments('a/../b'), true);
    assert.equal(hasDotSegments('./a'), true);
    assert.equal(hasDotSegments('a.b/..c/c..'), false);
  });

  test('collision suffixes', () => {
    const taken = new Set([`00 Inbox/${base}.md`]);
    const exists = (path: string): boolean => taken.has(path);
    assert.equal(companionPath('00 Inbox', base, exists), `00 Inbox/${base} (2).md`);
    taken.add(`00 Inbox/${base} (2).md`);
    assert.equal(companionPath('00 Inbox', base, exists), `00 Inbox/${base} (3).md`);
    taken.add(`00 Inbox/${base} (3).md`);
    taken.add(`00 Inbox/${base} (5).md`);
    assert.equal(companionPath('00 Inbox', base, exists), `00 Inbox/${base} (4).md`);
    // Another folder is another namespace.
    assert.equal(companionPath('', base, exists), `${base}.md`);
  });

  test('asks about each candidate once, in order', () => {
    const asked: string[] = [];
    const path = companionPath('f', 'n', (candidate) => {
      asked.push(candidate);
      return asked.length < 3;
    });
    assert.equal(path, 'f/n (3).md');
    assert.deepEqual(asked, ['f/n.md', 'f/n (2).md', 'f/n (3).md']);
  });

  test('gives up instead of looping when every name is taken', () => {
    let calls = 0;
    const path = companionPath('f', 'n', () => {
      calls += 1;
      return true;
    });
    assert.ok(calls <= 1000);
    assert.match(path, /^f\/n \(\d+\)\.md$/);
  });
});

describe('dailyLinkLine', () => {
  const base = companionBasename('Mtg-', '2026-10-09', '1:1 Jane Example');

  test('the exact line', () => {
    assert.equal(dailyLinkLine(base, 'Meeting notes'), '↳ [[Mtg-2026-10-09 — 1-1 Jane Example|Meeting notes]]');
  });

  test('an empty alias leaves a plain link, and an alias cannot break the link', () => {
    assert.equal(dailyLinkLine(base, ''), `↳ [[${base}]]`);
    assert.equal(dailyLinkLine(base, '  '), `↳ [[${base}]]`);
    assert.equal(dailyLinkLine(base, 'notes | [draft]\nv2'), `↳ [[${base}|notes draft v2]]`);
  });

  test('the section parser recognises the line and resolves it to the basename', () => {
    const line = dailyLinkLine(base, 'Meeting notes');
    assert.equal(isLinkLine(line), true);
    assert.deepEqual(wikilinks(line), [base]);

    const daily = `### 1:1 [[Jane Example]]\n- point\n${line}\n`;
    const section = sectionAt(daily, 0, { softMarker: /^1:1\b/i });
    assert.ok(section);
    assert.equal(section.linkLine, 2);
    assert.deepEqual(
      section.items.map((item) => item.text),
      ['point'],
    );
    assert.equal(companionBasename('Mtg-', '2026-10-09', section.title), base);
  });

  test('works with a custom prefix', () => {
    const custom = companionBasename('Meet ', '2026-10-09', 'Steering Board');
    assert.equal(isLinkLine(dailyLinkLine(custom, 'Notes'), 'Meet '), true);
    assert.equal(isLinkLine(dailyLinkLine(custom, 'Notes')), false);
  });
});
