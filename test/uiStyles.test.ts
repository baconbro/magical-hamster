import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { TAILWIND_DIRECTIVES, withDirectives } from '../src/styles/tailwind.ts';

/* Obsidian loads the plugin's stylesheet for the whole app. A rule that does not
   name the plugin's own root restyles notes, other plugins and Obsidian itself,
   so the sources are read here the way the build reads them, and the built
   stylesheet, which holds what Tailwind adds, is read when there is one. */

const STYLES = new URL('../src/styles/', import.meta.url);
const DIST = new URL('../dist/styles.css', import.meta.url);

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

/* What Tailwind adds is only in the built file: the theme variables it writes to `:root` for the
   utilities it generates, the `@property` registrations of its `--tw-*` variables, and a global
   `@keyframes` for each `animate-*` utility. In Obsidian `:root` is the whole app's, so the plugin's
   tokens are set on `.mh-root` and Tailwind's own values go into the utilities themselves (styles.css).
   The `@property` rules stay: they register names no other stylesheet sets, and a registration
   repeated by another plugin built with Tailwind is the same one. */
describe('styles: the built stylesheet', { skip: existsSync(DIST) ? false : 'dist/styles.css is missing: run pnpm build first' }, () => {
  const built = (): string => withoutComments(readFileSync(DIST, 'utf8'));
  const scoped = (selector: string): boolean =>
    selector.includes('.mh-root') || selector.includes('.mh-view') || selector.includes('.mh-modal');
  /** Every rule, at the top level and inside each at-rule that holds rules, with where it was found. */
  const everyRule = (css: string): Array<{ rule: Rule; inside: string[] }> => {
    const found: Array<{ rule: Rule; inside: string[] }> = [];
    const walk = (block: string, inside: string[]): void => {
      for (const rule of rulesOf(block)) {
        found.push({ rule, inside });
        if (/^@(media|supports|layer|container)\b/.test(rule.prelude)) walk(rule.body, [...inside, rule.prelude]);
      }
    };
    walk(css, []);
    return found;
  };

  test('nothing is set on :root or :host, where every window of Obsidian would read it', () => {
    const css = built();
    assert.deepEqual(
      everyRule(css)
        .filter(({ rule }) => /:root|:host/.test(rule.prelude))
        .map(({ rule }) => rule.prelude),
      [],
    );
    /* The tokens are set on the plugin's root instead, from Obsidian's, so theming still works.
       The minifier splits the block of theme.css: a token whose value is a color-mix() gets a
       plain fallback and a copy of its own under @supports, so all the `.mh-root` rules together
       are the declarations. */
    const declarations = everyRule(css)
      .filter(({ rule }) => rule.prelude === '.mh-root')
      .map(({ rule }) => rule.body)
      .join(';');
    for (const token of ['--color-surface', '--color-ink', '--color-line', '--color-danger', '--font-mono']) {
      assert.match(declarations, new RegExp(`${token}:(var|color-mix)\\(`), token);
    }
    /* Tailwind's own values went into the utilities: nothing reads a `:root` variable that is no
       longer there. What is read is set on `.mh-root`, is Obsidian's, or is a `--tw-*` of
       Tailwind's own, which a utility sets or reads with its fallback written in. */
    const read = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
    const declared = new Set([...declarations.matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
    const obsidian = (name: string): boolean => /^--(background|text|interactive|font|size|mh)-/.test(name);
    assert.deepEqual(
      [...read].filter((name) => !declared.has(name) && !name.startsWith('--tw-') && !obsidian(name)),
      [],
    );
  });

  test('every rule names the plugin root, and every @keyframes is the plugin\'s own', () => {
    const css = built();
    const loose: string[] = [];
    for (const { rule, inside } of everyRule(css)) {
      if (rule.prelude.startsWith('@')) continue;
      if (scoped(rule.prelude)) continue;
      /* Tailwind's one fallback for a browser without @property: every `--tw-*` set to its
         initial value on everything, behind a @supports that Electron does not match. Inert as
         long as it sets nothing but Tailwind's own variables. */
      const fallback = inside[0] === '@layer properties' && inside.some((at) => at.startsWith('@supports'));
      const onlyTw = rule.body.split(';').every((declaration) => declaration.trim() === '' || /^--tw-[\w-]+:/.test(declaration.trim()));
      if (fallback && onlyTw) continue;
      loose.push(`${inside.join(' > ')} > ${rule.prelude}`);
    }
    assert.deepEqual(loose, []);

    const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    assert.ok(keyframes.includes('mh-spin'), 'the spinner');
    assert.deepEqual(
      keyframes.filter((name) => !name.startsWith('mh-')),
      [],
    );
  });

  test('the utilities are inside :where(.mh-root) and read the tokens from it', () => {
    const css = built();
    assert.match(css, /:where\(\.mh-root\) \.bg-surface\{background-color:var\(--color-surface[,)]/);
    assert.match(css, /:where\(\.mh-root\) \.text-danger\{color:var\(--color-danger[,)]/);
    assert.match(css, /:where\(\.mh-root\) \.font-mono\{font-family:var\(--font-mono[,)]/);
    assert.match(css, /\.mh-root \.mh-spin\{animation:[^}]*mh-spin/);
    /* Every utility: not one generated for the whole app by mistake. */
    const bare = rulesOf(css).filter((rule) => /^\.[\w\\:/.-]+$/.test(rule.prelude) && !scoped(rule.prelude));
    assert.deepEqual(bare.map((rule) => rule.prelude), []);
  });
});
