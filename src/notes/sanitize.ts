const DEFAULT_MAX_LENGTH = 60;
/* Past this many taken names something is wrong with `exists`; stop rather than spin. */
const MAX_COLLISION_SUFFIX = 999;

/* Illegal in a file name on macOS or Windows, or meaningful inside a wikilink. */
const ILLEGAL = /[[\]#^|/\\*?"<>]/g;
/** The text without C0 and C1 control characters (U+0000 to U+001F, U+007F to U+009F). */
function withoutControlCharacters(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    out += ch;
  }
  return out;
}
/* Half of a surrogate pair, left by a cut made elsewhere: it cannot be encoded in a file name.
   With the `u` flag this class leaves whole pairs alone. */
const LONE_SURROGATE = /[\ud800-\udfff]/gu;

function cutAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  let cut = text.slice(0, maxLen);
  // Cutting inside a word: back up to the last whole one, unless that throws most of the title away.
  if (text[maxLen] !== ' ') {
    const space = cut.lastIndexOf(' ');
    if (space >= maxLen / 2) cut = cut.slice(0, space);
  }
  // Never leave half of an emoji or a dangling joiner behind. Dropping the half can uncover the joiner.
  for (;;) {
    const last = cut.charCodeAt(cut.length - 1);
    if (!((last >= 0xd800 && last <= 0xdbff) || last === 0x200d)) break;
    cut = cut.slice(0, -1);
  }
  return cut;
}

/** A meeting title made safe for a file name and for the inside of a wikilink. */
export function sanitizeTitle(title: string, maxLen: number = DEFAULT_MAX_LENGTH): string {
  const limit = Number.isFinite(maxLen) && maxLen >= 1 ? Math.floor(maxLen) : DEFAULT_MAX_LENGTH;
  // Tabs and line breaks become spaces before the other control characters are dropped.
  const clean = withoutControlCharacters(title.replace(/:/g, '-').replace(ILLEGAL, '').replace(/\s+/g, ' '))
    .replace(LONE_SURROGATE, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    /* One spelling per accented letter, so the file name and the link to it
       always agree. After the removals: one of them can bring a letter and its
       accent together. Before the cut: the length is counted on this form. */
    .normalize('NFC');
  // Obsidian and macOS dislike a name that ends with a dot or a space.
  const cut = cutAtWord(clean, limit).replace(/[. ]+$/, '');
  return cut === '' ? 'Meeting' : cut;
}

/** `Mtg-2026-10-09 — 1-1 Jane Example` */
export function companionBasename(prefix: string, date: string, title: string): string {
  return `${prefix}${date} — ${sanitizeTitle(title)}`;
}

/** Vault path of a new companion: ` (2)`, ` (3)`... is added while the path is taken. */
export function companionPath(
  folder: string,
  basename: string,
  exists: (path: string) => boolean,
): string {
  const dir = folder.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const stem = dir === '' ? basename : `${dir}/${basename}`;
  let path = `${stem}.md`;
  for (let n = 2; exists(path) && n <= MAX_COLLISION_SUFFIX; n++) {
    path = `${stem} (${n}).md`;
  }
  return path;
}

/** The one line the plugin adds to the daily note. */
export function dailyLinkLine(basename: string, alias: string): string {
  // A bracket, a pipe or a line break in the alias would break the link.
  const label = alias.replace(/[[\]|\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  return label === '' ? `↳ [[${basename}]]` : `↳ [[${basename}|${label}]]`;
}
