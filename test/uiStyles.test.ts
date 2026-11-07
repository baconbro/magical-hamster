import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/* Obsidian loads the plugin's stylesheet for the whole app. A rule that does not
   name the plugin's own root restyles notes, other plugins and Obsidian itself,
   so the sources are read here the way the build reads them. */

const STYLES = new URL('../src/styles/', import.meta.url);

function source(name: string): string {
  return readFileSync(new URL(name, STYLES), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

interface Rule {
  prelude: string;
  body: string;
}

/** The rules of one block, one level deep. Statements that end in `;` are skipped. */
function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  let at = 0;
  while (at < css.length) {
    const open = css.indexOf('{', at);
    if (open < 0) break;
    const semicolon = css.indexOf(';', at);
    if (semicolon >= 0 && semicolon < open) {
      at = semicolon + 1;
      continue;
    }
    let depth = 1;
    let end = open + 1;
    for (; end < css.length && depth > 0; end++) {
      if (css[end] === '{') depth += 1;
      else if (css[end] === '}') depth -= 1;
    }
    rules.push({ prelude: css.slice(at, open).trim(), body: css.slice(open + 1, end - 1) });
    at = end;
  }
  return rules;
}

test('styles: the Tailwind utilities are generated inside the plugin root, never for the whole app', () => {
  const css = source('styles.css');
  /* Either of these emits `.hidden`, `.container`, `.table`... as bare classes. */
  assert.doesNotMatch(css, /@import\s+["']tailwindcss(\/utilities(\.css)?)?["']/);

  const emitters = rulesOf(css).filter((rule) => /@tailwind\s+utilities/.test(rule.body));
  assert.deepEqual(
    emitters.map((rule) => rule.prelude),
    [':where(.mh-root)'],
  );
  /* And nowhere at the top level, outside that block. */
  const outside = rulesOf(css).reduce((rest, rule) => rest.replace(rule.body, ''), css);
  assert.doesNotMatch(outside, /@tailwind/);
});

test('styles: every rule of the plugin names its own root', () => {
  const scoped = (selector: string): boolean => selector.includes('.mh-root') || selector.includes('.mh-view');
  const loose: string[] = [];
  const check = (css: string, file: string): void => {
    for (const rule of rulesOf(css)) {
      if (rule.prelude.startsWith('@media') || rule.prelude.startsWith('@supports')) check(rule.body, file);
      else if (rule.prelude.startsWith('@')) continue;
      else if (!scoped(rule.prelude)) loose.push(`${file}: ${rule.prelude}`);
    }
  };
  for (const file of ['styles.css', 'reset.css', 'theme.css', 'markdown.css']) check(source(file), file);
  assert.deepEqual(loose, []);
});

test('styles: the prose rules cover what the Markdown renderer builds', () => {
  const css = source('markdown.css');
  const styled = (element: string, property: string): boolean =>
    rulesOf(css).some((rule) => new RegExp(`:where\\([^)]*\\b${element}\\b[^)]*\\)`).test(rule.prelude) && rule.body.includes(property));
  /* The reset leaves a heading bare: a level without a rule here reads as a line of the paragraph above. */
  for (const level of [1, 2, 3, 4, 5, 6]) assert.ok(styled(`h${level}`, 'font-weight'), `h${level}`);
  for (const element of ['p', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre']) {
    assert.ok(rulesOf(css).some((rule) => new RegExp(`:where\\([^)]*\\b${element}\\b`).test(rule.prelude)), element);
  }
  /* Nested lists are real lists inside their item: nothing hangs on a depth attribute any more. */
  assert.ok(styled('li ul', 'list-style-type'));
  assert.doesNotMatch(css, /data-depth/);
  /* Nothing for a link or a quote: the renderer builds neither, and a rule would suggest it does. */
  assert.doesNotMatch(css, /:where\((a|blockquote)\)/);
});
