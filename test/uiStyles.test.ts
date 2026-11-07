import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TAILWIND_DIRECTIVES, withDirectives } from '../src/styles/tailwind.ts';

/* Obsidian loads the plugin's stylesheet for the whole app. A rule that does not
   name the plugin's own root restyles notes, other plugins and Obsidian itself,
   so the sources are read here the way the build reads them. */

const STYLES = new URL('../src/styles/', import.meta.url);

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

function source(name: string): string {
  return withoutComments(readFileSync(new URL(name, STYLES), 'utf8'));
}

/** styles.css as Tailwind reads it: with the directives the build adds (src/styles/tailwind.ts). */
function built(): string {
  return withoutComments(withDirectives(readFileSync(new URL('styles.css', STYLES), 'utf8')));
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
  const css = built();
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
  // The sidebar's roots, and the first-write dialog's (an Obsidian Modal, outside the sidebar).
  const scoped = (selector: string): boolean =>
    selector.includes('.mh-root') || selector.includes('.mh-view') || selector.includes('.mh-modal');
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

test('styles: no .css file holds a Tailwind directive, which CSS linters report as unknown at-rules', () => {
  const files = readdirSync(STYLES).filter((name) => name.endsWith('.css'));
  assert.ok(files.includes('styles.css'));
  for (const name of files) {
    assert.doesNotMatch(source(name), /@(?:tailwind|source|custom-variant|theme|utility|variant|plugin|config|apply)\b/, name);
  }
});

test('styles: the build adds the directives right after the @import lines, where they belong', () => {
  const css = withDirectives('@import "a.css";\n@import "b.css";\n.mh-root .x { color: red; }\n');
  const lines = css.split('\n');
  assert.equal(lines[0], '@import "a.css";');
  assert.equal(lines[1], '@import "b.css";');
  assert.ok(css.indexOf('@tailwind utilities') > css.indexOf('@import "b.css"'));
  assert.ok(css.indexOf('@tailwind utilities') < css.indexOf('.mh-root .x'));
  assert.ok(css.includes(TAILWIND_DIRECTIVES));
  assert.throws(() => withDirectives('.mh-root .x { color: red; }'), /no @import/);
});
