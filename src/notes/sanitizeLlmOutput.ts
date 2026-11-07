import { inertMarkdown } from './safeMarkdown.ts';

export interface SanitizeOptions {
  keepWikilinks?: boolean;
  keepTasks?: boolean;
  minHeadingLevel?: number;
}

/* One rule can expose input for another (an alias that is a checkbox, a comment
   hiding a frontmatter fence), so the rules run to a fixed point. That is also
   what makes the result idempotent. Real output settles on the second pass. */
const MAX_PASSES = 8;

/** Applied to everything the model wrote before it is saved to the vault. */
export function sanitizeLlmOutput(markdown: string, opts: SanitizeOptions = {}): string {
  const floor = headingFloor(opts.minHeadingLevel);
  let text = markdown;
  for (let i = 0; i < MAX_PASSES; i += 1) {
    const next = pass(text, opts, floor);
    if (next === text) return text;
    text = next;
  }
  // Only adversarial nesting gets here. Tidiness may be off, the marker guarantee may not,
  // and neither may the one about code.
  return inertMarkdown(disarmCode(stripHamsterComments(text))).trim();
}

function pass(input: string, opts: SanitizeOptions, floor: number): string {
  // Before the lines are read: a fence that lost its language may now close the block it stood in.
  const unmarked = disarmCode(stripHamsterComments(input.replace(/\r\n?/g, '\n')));
  const out: string[] = [];
  let fence: Fence | null = null;
  let afterBlank = false;

  for (const raw of withoutLeadingFence(unmarked.split('\n'))) {
    if (fence) {
      out.push(raw);
      if (closesFence(raw, fence)) fence = null;
      afterBlank = false;
      continue;
    }
    fence = openingFence(raw);
    if (fence) {
      out.push(fence.prefix + fence.mark);
      afterBlank = false;
      continue;
    }

    let line = opts.keepTasks ? raw : withoutCheckbox(raw);
    if (line === null) continue;
    if (!opts.keepWikilinks) line = unlinkCodeLabels(outsideInlineCode(line, unlink));
    line = demoteHeading(line, floor).trimEnd();
    if (demoteUnderlined(out, line, floor)) {
      afterBlank = false;
      continue;
    }

    if (line === '' && afterBlank) continue;
    afterBlank = line === '';
    out.push(line);
  }

  // Generation cut off inside a code block: left open, the fence would swallow
  // the region's end marker and the rest of the note when rendered.
  if (fence) out.push(fence.prefix + fence.mark);

  /* Last, so the link rules above have seen the text as the model wrote it:
     nothing that is left may become an image or an HTML tag, in the note any
     more than in the sidebar. Both are fetched the moment they are drawn. */
  return inertMarkdown(out.join('\n')).trim();
}

/* A comment body stops at the first `-->` on the same line. Reaching across
   lines for one would delete real text whenever an unterminated opener is
   followed, paragraphs later, by an arrow. */
const COMMENT = '<!--[ \\t]*hamster:(?:(?!-->)[^\\n])*-->';
const COMMENT_ONLY_LINES = new RegExp(`(?:^|\\n)[ \\t]*(?:${COMMENT}[ \\t]*)+(?=\\n|$)`, 'g');
const COMMENTS = new RegExp(COMMENT, 'g');
/* Whatever is left of an unterminated or multi-line one: without the opener it is plain text. */
const OPENERS = /<!--\s*hamster:/g;

function stripHamsterComments(text: string): string {
  let current = text;
  // Removing one comment can join the two halves of another. Every round shortens the text.
  for (;;) {
    const next = current.replace(COMMENT_ONLY_LINES, '').replace(COMMENTS, '').replace(OPENERS, '');
    if (next === current) return current;
    current = next;
  }
}

/* Other plugins run what a rendered note carries. Dataview, with its JavaScript queries switched
   on, executes a ```dataviewjs block and any code that opens with `$=` (`=` for a query), in the
   companion and in the sidebar alike. Obsidian finds a block by the class its language gives the
   <code> element, and Dataview reads the text of every <code>, inline or not. So nothing the model
   wrote may carry a language on a fence, a <code> tag of its own, or code that opens on a query.
   (The first was read in the bundle of Obsidian 1.14.4, which also lets a raw <code> tag with a
   class through its HTML filter. The second is how Dataview is known to work: it was not run here.)

   What is a block and what is a span depends on the reader: a fence inside a quote or a list item
   ends with it, and backticks pair up over line ends. The rules below do not decide; they leave
   no line and no run of backticks that any reading could take for one of those. */

/* Whatever may stand in front of a fence that opens a block: indentation, quote and list markers,
   a checkbox, the label of a footnote. Each marker takes the blanks after it, so no stretch of
   blanks can be split two ways. */
const FENCE_WITH_INFO =
  /^([ \t]*(?:(?:>|[-*+]|\d{1,9}[.)]|\[.\]|\[\^[^\]\s]+\]:)[ \t]*)*)(`{3,}(?!`)|~{3,}(?!~))[ \t]*(\S.*)$/;

function withoutFenceInfo(line: string): string {
  const m = FENCE_WITH_INFO.exec(line);
  // Backticks after the opening ones make it inline code, not a fence.
  if (!m || (m[2][0] === '`' && m[3].includes('`'))) return line;
  return m[1] + m[2];
}

/* Backticks or a fence, then nothing but blanks, line ends and quote markers, then the prefix of a
   script. Dataview trims the text of the code before it looks, so every kind of blank counts, and
   it reads a whole block as it reads inline code. A run is taken whole, from its first character:
   tried from every backtick of a long run, the pattern would take seconds. */
const SCRIPT_IN_CODE = /(?<![`~])(`+(?!`)|~{3,}(?!~))([\s>]*)(\$=)/g;
/* The same at the start of a line: indented by four blanks or a tab, it is a code block. The
   indentation is measured afterwards: a pattern that looked for it would try a long run of
   blanks from every one of them. */
const SCRIPT_AT_LINE_START = /^([ \t>]*)(\$=)/gm;
const CODE_INDENT = / {4}|\t/;
/* A query cannot run code, only show what the vault holds: it is kept out of inline code, where
   it would be evaluated in the middle of a sentence, and a line of `=` under a block is left alone. */
const QUERY_IN_CODE = /(?<!`)(`+)(?!`)([^\S\n]*)(=)/g;
const PARAGRAPH_END = /\n[ \t>]*\n/g;

/** Where the runs of backticks are and where the paragraphs end: asked for every candidate, so found once. */
interface CodeMap {
  runs: Array<{ at: number; length: number }>;
  ends: number[];
}

function codeMap(text: string): CodeMap {
  const runs: CodeMap['runs'] = [];
  for (const m of text.matchAll(/`+/g)) runs.push({ at: m.index, length: m[0].length });
  const ends: number[] = [];
  for (const m of text.matchAll(PARAGRAPH_END)) ends.push(m.index);
  return { runs, ends };
}

/** Index of the first entry at or after `from`. */
function firstFrom<T>(list: T[], from: number, at: (entry: T) => number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (at(list[mid]) < from) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** True when as many backticks come again before the paragraph ends: only then can `length` of them open code. */
function closedLater(map: CodeMap, from: number, length: number): boolean {
  const end = map.ends[firstFrom(map.ends, from, (at) => at)] ?? Number.POSITIVE_INFINITY;
  for (let i = firstFrom(map.runs, from, (run) => run.at); i < map.runs.length && map.runs[i].at < end; i++) {
    if (map.runs[i].length === length) return true;
  }
  return false;
}

/* A backslash in front of the prefix: inside code it is text, and the code no longer opens on a
   query; outside code it is an escape, and the reader sees what was written. */
function withoutQueries(text: string): string {
  let out = text;
  if (out.includes('$=')) {
    const map = codeMap(out);
    out = out
      .replace(SCRIPT_IN_CODE, (match, run: string, gap: string, prefix: string, at: number) => {
        // One or two backticks are no fence: `x` $= 1 with nothing after it stays as written.
        const inline = run[0] === '`' && run.length < 3;
        return inline && !closedLater(map, at + match.length, run.length) ? match : `${run}${gap}\\${prefix}`;
      })
      .replace(SCRIPT_AT_LINE_START, (match, lead: string, prefix: string) =>
        CODE_INDENT.test(lead) ? `${lead}\\${prefix}` : match,
      );
  }
  if (!out.includes('`')) return out;
  const map = codeMap(out);
  return out.replace(QUERY_IN_CODE, (match, run: string, gap: string, prefix: string, at: number) =>
    closedLater(map, at + match.length, run.length) ? `${run}${gap}\\${prefix}` : match,
  );
}

/**
 * The text with nothing in it that another plugin would run when it is rendered: code blocks lose
 * their language, and code that would open on a Dataview query gets a backslash in front of the
 * `=`. (A raw `<code>` tag is dealt with by `inertMarkdown`, with every other tag.) Everything else is left as it is, wikilinks and tasks
 * included, so it suits text that is only shown. Safe on text that is still arriving.
 */
export function disarmCode(markdown: string): string {
  let text = markdown;
  if (text.includes('```') || text.includes('~~~')) {
    text = text
      .split('\n')
      .map((line) => (line.includes('```') || line.includes('~~~') ? withoutFenceInfo(line) : line))
      .join('\n');
  }
  /* A raw <code> tag is left to inertMarkdown, which turns every tag into its
     characters on the way to the note. Rewriting it here as well would put a
     literal "&lt;" in the sidebar, whose renderer draws text as it is. */
  return text.includes('=') ? withoutQueries(text) : text;
}

const YAML_FENCE = /^---[ \t]*$/;
/* Lowercase keys only: `type:` is frontmatter, `Decision:` is a sentence. */
const YAML_KEY = /^[a-z_][a-z0-9_-]*:(?:[ \t].*)?$/;
const YAML_CONTINUATION = /^(?:[ \t]+\S|- )/;
const YAML_MAX_LINES = 40;

/** Index of the fence closing a frontmatter block that starts at `from`, or -1 when what follows is not one. */
function frontmatterEnd(lines: string[], from: number): number {
  let sawKey = false;
  for (let i = from; i < lines.length && i - from <= YAML_MAX_LINES; i += 1) {
    const line = lines[i];
    if (YAML_FENCE.test(line)) return i;
    if (YAML_KEY.test(line)) sawKey = true;
    else if (!sawKey || !YAML_CONTINUATION.test(line)) return -1;
  }
  return -1;
}

function withoutLeadingFence(lines: string[]): string[] {
  let rest = lines;
  for (;;) {
    let top = 0;
    while (top < rest.length && rest[top].trim() === '') top += 1;
    // The result is trimmed, so the first line counts without its indentation;
    // judged as written, a stack of indented fences would cost one pass each.
    if (top >= rest.length || !YAML_FENCE.test(rest[top].trimStart())) return rest;
    // A whole block goes with its fences: left behind, the closing fence would
    // turn the last key into a heading. A lone fence goes alone.
    const close = frontmatterEnd(rest, top + 1);
    rest = rest.slice((close === -1 ? top : close) + 1);
  }
}

interface Fence {
  /** Indentation and blockquote markers in front of the fence. */
  prefix: string;
  mark: string;
}

const FENCE_LINE = /^([ \t]*(?:>[ \t]*)*)(`{3,}|~{3,})(.*)$/;

function openingFence(line: string): Fence | null {
  const m = FENCE_LINE.exec(line);
  if (!m) return null;
  // Backticks in the info string make it inline code, not a fence.
  if (m[2][0] === '`' && m[3].includes('`')) return null;
  return { prefix: m[1], mark: m[2] };
}

function closesFence(line: string, fence: Fence): boolean {
  const m = FENCE_LINE.exec(line);
  return (
    m !== null && m[2][0] === fence.mark[0] && m[2].length >= fence.mark.length && m[3].trim() === ''
  );
}

function closingRun(line: string, from: number, length: number): number {
  let at = from;
  while (at < line.length) {
    if (line[at] !== '`') {
      at += 1;
      continue;
    }
    const start = at;
    while (line[at] === '`') at += 1;
    if (at - start === length) return start;
  }
  return -1;
}

/** Applies `change` to the parts of a line that are not inline code. */
function outsideInlineCode(line: string, change: (text: string) => string): string {
  if (!line.includes('`')) return change(line);
  let out = '';
  let textFrom = 0;
  let at = 0;
  while (at < line.length) {
    if (line[at] !== '`') {
      at += 1;
      continue;
    }
    const open = at;
    while (line[at] === '`') at += 1;
    const close = closingRun(line, at, at - open);
    // Unpaired backticks are ordinary text.
    if (close === -1) continue;
    const end = close + (at - open);
    out += change(line.slice(textFrom, open)) + line.slice(open, end);
    textFrom = end;
    at = end;
  }
  return out + change(line.slice(textFrom));
}

/* The body may hold single brackets but never `[[` or `]]`, so the innermost
   link matches first and no input can make the pattern backtrack at length. */
const WIKILINK = /(!?)\[\[((?:(?!\[\[|\]\])[^\n])+)\]\]/g;

function linkText(inner: string, embed: boolean): string {
  const bar = inner.indexOf('|');
  // In a table the pipe is written `\|`.
  const target = (bar === -1 ? inner : inner.slice(0, bar)).replace(/\\$/, '').trim();
  const alias = bar === -1 ? '' : inner.slice(bar + 1).trim();
  // An embed's "alias" is a display size (![[plan.png|300]]), not a name.
  if (alias !== '' && !(embed && /^\d+(?:x\d+)?$/.test(alias))) return alias;

  const hash = target.indexOf('#');
  const file = (hash === -1 ? target : target.slice(0, hash)).trim();
  // [[#Heading]] points into the same note: the heading is all there is to show.
  if (file === '') return target.slice(hash + 1).replace(/^\^/, '').trim();
  const name = file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/i, '').trim();
  return name === '' ? file : name;
}

/* `[text](target)`, as a link or as an embed. The text may hold brackets one level deep, the
   target parentheses one level deep and, as Obsidian allows, spaces. Each alternative starts on a
   different character, so nothing here can be matched two ways. */
const MARKDOWN_LINK = /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(((?:[^()\n]|\([^()\n]*\))*)\)/g;
const LINK_TITLE = /[ \t]+(?:"[^"]*"|'[^']*'|\([^()]*\))$/;
/* The schemes a link the model wrote may keep: nothing fetches a web or a mail address until it is
   clicked, and the address shows on hover. Any other scheme is a command behind a label: a source
   can plant `obsidian://` (which runs one) or `file:` (which opens a path) under innocent text. */
const SAFE_SCHEME = /^(?:https?|mailto):/i;

/**
 * True for a Markdown link that stays as written: empty, to a heading of the note itself, or to a
 * web or mail address. A target with no scheme is a file of the vault, which Obsidian resolves like
 * a wikilink and would put the note in backlinks; one with another scheme is reduced with it.
 */
function keepsLink(inside: string): boolean {
  let target = inside.trim().replace(LINK_TITLE, '').trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  return target === '' || target.startsWith('#') || SAFE_SCHEME.test(target);
}

/* `[`config.md`](40 Resources/config.md)`: the label holds a code span, so the pass that works
   outside inline code never sees the whole link. Obsidian resolves it all the same. */
const CODE_LABEL_LINK = /(!?)\[((?:[^\]\n`\\]|\\.)*`[^`\n]*`(?:[^\]\n`\\]|\\.|`[^`\n]*`)*)\]\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g;

function unlinkCodeLabels(line: string): string {
  if (!line.includes('](') || !line.includes('`')) return line;
  return line.replace(CODE_LABEL_LINK, (match, _bang: string, shown: string, inside: string) =>
    keepsLink(inside) ? match : shown,
  );
}

function unlink(text: string): string {
  let current = text;
  // Unwrapping an inner link can complete an outer one. Every round shortens the text.
  for (;;) {
    const next = current
      .replace(WIKILINK, (_match, bang: string, inner: string) => linkText(inner, bang === '!'))
      // A Markdown link to a note is indexed like a wikilink; one with a scheme that is not the
      // web's or mail's is a command. Either is reduced to its text.
      .replace(MARKDOWN_LINK, (match, _bang: string, shown: string, inside: string) =>
        keepsLink(inside) ? match : shown,
      );
    if (next === current) return current;
    current = next;
  }
}

/* Any single character between the brackets is a task status to the Tasks plugin. */
const TASK_BOXES = /^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d{1,9}[.)])[ \t]+)(?:\[[^[\]]\](?:[ \t]+|$))+/;

/** The line without its checkbox, or null when the checkbox was all the item held. */
function withoutCheckbox(line: string): string | null {
  const m = TASK_BOXES.exec(line);
  if (!m) return line;
  const rest = line.slice(m[0].length);
  // A bare `-` under a paragraph would read as a heading underline.
  return rest.trim() === '' ? null : m[1] + rest;
}

function headingFloor(level: number | undefined): number {
  if (level === undefined || !Number.isFinite(level)) return 1;
  return Math.min(6, Math.max(1, Math.floor(level)));
}

const ATX_HEADING = /^( {0,3})(#{1,6})(?=[ \t]|$)/;

function demoteHeading(line: string, floor: number): string {
  if (floor <= 1) return line;
  const m = ATX_HEADING.exec(line);
  if (!m || m[2].length >= floor) return line;
  return m[1] + '#'.repeat(floor) + line.slice(m[0].length);
}

const UNDERLINE = /^ {0,3}(=+|-+)$/;
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
/* How a line starts when it is not the text of a paragraph: indented code, a
   heading, a quote, HTML, math, a comment, a footnote, a list item, a fence, a
   rule or another underline. Every fence line is one of these, so the walk
   back from an underline can never enter a code block. */
const NOT_PARAGRAPH =
  /^(?: {0,3}\t| {4}| {0,3}(?:#{1,6}(?:[ \t]|$)|[><]|\$\$|%%|\[\^|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)|`{3}|~{3}|[=-]+$|(?:[-*_][ \t]*){3,}$))/;

/* A pipe may make the line a table row, with or without a leading pipe; a
   table must never be folded into a heading, so such a line is left alone. */
function paragraphText(line: string): boolean {
  return line !== '' && !line.includes('|') && !NOT_PARAGRAPH.test(line);
}

/**
 * A paragraph over a line of `=` or `-` is a level 1 or 2 heading, also when the
 * model only meant a rule under a sentence. Shallower than the floor, it is
 * rewritten in `out` as an ATX heading at the floor. True when `line` was such an underline.
 */
function demoteUnderlined(out: string[], line: string, floor: number): boolean {
  const m = UNDERLINE.exec(line);
  if (!m || (m[1][0] === '=' ? 1 : 2) >= floor) return false;

  let first = out.length;
  while (first > 0 && paragraphText(out[first - 1])) first -= 1;
  if (first === out.length) return false;
  // Straight under a list item or a quote the text continues that block and the
  // underline makes no heading. Only a blank line, a heading or a rule starts a paragraph for sure.
  const above = first === 0 ? '' : out[first - 1];
  if (above !== '' && !ATX_HEADING.test(above) && !RULE.test(above)) return false;

  const indent = /^ */.exec(out[first])?.[0] ?? '';
  const text = out
    .splice(first)
    .map((part) => part.trim())
    .join(' ');
  out.push(`${indent}${'#'.repeat(floor)} ${text}`);
  return true;
}
