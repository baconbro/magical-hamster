import type { Plugin } from 'vite';

/* Tailwind's own directives for src/styles/styles.css. The build adds them to that file just
   before Tailwind reads it (tailwindDirectives, in vite.config.ts and vite.dev.config.ts), right
   after its @import lines, where they would otherwise be written. They are kept out of the .css
   files because a CSS linter that does not know Tailwind, the Obsidian community directory's among
   them, reports every one of them as an unknown at-rule; the released styles.css has none.

   The utilities are generated inside `:where(.mh-root)`, which adds the scope and no specificity:
   Obsidian loads the stylesheet for the whole app, and a bare `.hidden`, `.container` or `.table`
   would restyle whatever else carries the name. A utility still weighs 0-1-0 against the reset and
   against the other utilities. It works on a descendant of the root, not on the root element
   itself, which carries none. `@source` points at src/, relative to styles.css.

   The tokens in @theme only make Tailwind generate the utilities (bg-surface, text-muted,
   font-mono...), which read them as var(--color-surface) and so on; the real values are set on
   `.mh-root` in theme.css, from the reader's Obsidian theme. `reference` keeps Tailwind from
   writing these placeholder values to `:root` as well, which would reach the whole app. */
export const TAILWIND_DIRECTIVES = `
:where(.mh-root) {
  @tailwind utilities;
}

@source "../";

@custom-variant dark (&:where(.mh-root.dark, .mh-root.dark *));

@theme reference {
  /* Obsidian's own monospace font (the \`font-mono\` utility), not Tailwind's default stack. */
  --font-mono: var(--font-monospace, SFMono-Regular, Menlo, monospace);
  --color-surface: #ffffff;
  --color-surface-alt: #f6f6f6;
  --color-ink: #222222;
  --color-muted: #5c5c5c;
  --color-faint: #ababab;
  --color-brand: #7852ee;
  --color-brand-hover: #8a6cf0;
  --color-on-brand: #ffffff;
  --color-line: #e0e0e0;
  --color-hover: #f2f2f2;
  --color-chip: #ece6fd;
  --color-danger: #e93147;
  --color-ok: #08b94e;
  --color-warn: #ec7500;
}
`;

const ENTRY = /\/src\/styles\/styles\.css(?:\?.*)?$/;

/** Adds `directives` to `css` after its last @import line, where @import rules must stay first. */
export function withDirectives(css: string, directives: string = TAILWIND_DIRECTIVES): string {
  const lines = css.split('\n');
  let last = -1;
  lines.forEach((line, index) => {
    if (/^@import\s/.test(line)) last = index;
  });
  if (last < 0) throw new Error('src/styles/styles.css has no @import line to put the Tailwind directives after');
  return [...lines.slice(0, last + 1), directives, ...lines.slice(last + 1)].join('\n');
}

/** The Vite plugin: goes before tailwindcss() in the plugin list, so that Tailwind reads the whole. */
export function tailwindDirectives(): Plugin {
  return {
    name: 'magical-hamster:tailwind-directives',
    enforce: 'pre',
    transform(code, id) {
      return ENTRY.test(id.replace(/\\/g, '/')) ? withDirectives(code) : null;
    },
  };
}
