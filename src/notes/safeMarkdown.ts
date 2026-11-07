/* Text a model wrote, on its way into the companion note.
 *
 * Obsidian renders that note, and its renderer turns `![](https://...)` into
 * an image and keeps raw HTML (`<img>`, `<iframe>`, a `style` with a `url()`):
 * each of those is fetched the moment the note is drawn. A note the model was
 * given as a source can ask it to write one with the meeting's text in the
 * address. So before the text is saved, everything that could become an image
 * or an HTML tag is turned into the characters it is made of. (The sidebar
 * needs none of this: its own renderer builds text nodes and nothing else.)
 *
 * Whether a stretch of text is code decides only how that is written, never
 * whether it is done: a guess about where code starts and ends that differs
 * from the renderer's must not let anything through. Both spellings are
 * harmless in both places.
 */

/* Invisible, and enough to keep `<` from opening a tag and `!` from making
   the link that follows an image. Used where an escape would be shown as
   written: in code, and after a backslash. */
const ZERO_WIDTH_SPACE = '\u200B';

const OPENS_TAG = /[A-Za-z/!?]/;
// A bare line break, the one tag models commonly write (in table cells). It can load nothing.
const LINE_BREAK = /^<br[ \t]*\/?>/i;

interface Fence {
  char: string;
  length: number;
}

function openingFence(line: string): Fence | null {
  const found = /^[ \t>]*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!found) return null;
  // ```code``` on one line is an inline span, not a fence.
  if (found[1][0] === '`' && found[2].includes('`')) return null;
  return { char: found[1][0], length: found[1].length };
}

function closesFence(line: string, fence: Fence): boolean {
  const mark = line.replace(/^[ \t>]*/, '').trimEnd();
  if (mark.length < fence.length) return false;
  for (const char of mark) if (char !== fence.char) return false;
  return true;
}

/** What stands for the character at `at`: itself, unless it would open a tag or an image. */
function defused(text: string, at: number, asCode: boolean): string {
  const char = text[at];
  const next = text[at + 1] ?? '';
  if (char === '<' && OPENS_TAG.test(next) && !LINE_BREAK.test(text.slice(at, at + 8))) {
    return asCode ? `<${ZERO_WIDTH_SPACE}` : '&lt;';
  }
  if (char === '!' && next === '[') return asCode ? `!${ZERO_WIDTH_SPACE}` : '!\\';
  return char;
}

function defusedCode(text: string): string {
  let out = '';
  for (let at = 0; at < text.length; at++) out += defused(text, at, true);
  return out;
}

function defusedLine(line: string): string {
  let out = '';
  let at = 0;
  while (at < line.length) {
    const char = line[at];
    if (char === '\\') {
      // The next character is escaped: a backtick opens nothing, and an escape of ours would show.
      out += char;
      if (at + 1 < line.length) out += defused(line, at + 1, true);
      at += 2;
      continue;
    }
    if (char === '`') {
      let length = 1;
      while (line[at + length] === '`') length += 1;
      const ticks = line.slice(at, at + length);
      const close = closingTicks(line, at + length, length);
      if (close < 0) {
        out += ticks;
        at += length;
      } else {
        out += ticks + defusedCode(line.slice(at + length, close)) + ticks;
        at = close + length;
      }
      continue;
    }
    out += defused(line, at, false);
    at += 1;
  }
  return out;
}

/** Start of the next run of exactly `length` backticks at or after `from`, or -1. */
function closingTicks(line: string, from: number, length: number): number {
  let at = line.indexOf('`', from);
  while (at >= 0) {
    let run = 1;
    while (line[at + run] === '`') run += 1;
    if (run === length) return at;
    at = line.indexOf('`', at + run);
  }
  return -1;
}

/**
 * `markdown` with nothing left in it that the renderer would fetch: no image
 * (`![`), no embed (`![[`), no HTML tag. It reads the same when rendered. In
 * code, and after a backslash, a zero-width space does what an escape does
 * elsewhere. Running it twice changes nothing more.
 */
export function inertMarkdown(markdown: string): string {
  const out: string[] = [];
  let fence: Fence | null = null;
  for (const line of markdown.split('\n')) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      out.push(defusedCode(line));
      continue;
    }
    fence = openingFence(line);
    out.push(fence ? defusedCode(line) : defusedLine(line));
  }
  return out.join('\n');
}
