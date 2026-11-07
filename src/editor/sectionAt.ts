import type { Section, SectionItem, SectionKey, SectionSummary } from '../types.ts';
import { shortHash } from '../util/hash.ts';
import { collapseWhitespace } from '../util/text.ts';
import { taskStatus } from '../util/tasks.ts';

export interface SectionOptions {
  /** Matches heading-less meeting lines, e.g. /^(1:1|Ad ?Hoc|Prep|Steering|Rencontre)\b/i. */
  softMarker: RegExp;
  /** Lowercased names, links and aliases from the entity registry. */
  entityNames?: string[];
  /** Companion prefix, default 'Mtg-'. The plugin's own link line starts with `↳ [[<prefix>`. */
  linkPrefix?: string;
}

const DEFAULT_LINK_PREFIX = 'Mtg-';
const LINK_ARROW = '↳ [[';
const SOFT_MARKER_MAX_LENGTH = 80;
/* Bounds the text a user-supplied pattern runs on, so a slow pattern stays cheap per heading. */
const SOFT_MARKER_SCAN_LENGTH = 200;

/* Line kinds. 1..6 is a heading of that level. From INERT up, a line is
   frontmatter or fenced code: no anchor, no item. */
const TEXT = 0;
const BLANK = 7;
const INERT = 8;
/* The closing line of a fence or of the frontmatter: inert, but a line added after it is not. */
const INERT_END = 9;

const WIKILINK = /!?\[\[([^[\]\n]+)\]\]/g;
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
/* Any single character is a task status: the Tasks plugin uses [/], [-], [>]. */
const CHECKBOX = /^\[[^\]]\](?:[ \t]+|$)/;
const UNICODE_WORD = /[\p{L}\p{N}\p{M}]/u;

/* Hashing is most of the cost of a keystroke in a long section, and every line
   but the one being typed is unchanged since the previous keystroke. */
const HASH_MEMO_LIMIT = 4096;
/* A longer line is hashed every time: with the limit above, this bounds what the memo holds. */
const HASH_MEMO_MAX_TEXT = 256;
const hashMemo = new Map<string, string>();

function itemHash(text: string): string {
  if (text.length > HASH_MEMO_MAX_TEXT) return shortHash(text);
  let hash = hashMemo.get(text);
  if (hash === undefined) {
    if (hashMemo.size >= HASH_MEMO_LIMIT) hashMemo.clear();
    hash = shortHash(text);
    /* `text` is a slice of the note, and in V8 a slice keeps the whole string
       it was cut from alive: as a key it would hold one copy of the note per
       keystroke. Rebuilt from its characters, the key stands on its own. */
    hashMemo.set(text.split('').join(''), hash);
  }
  return hash;
}

interface LinkParts {
  target: string;
  heading: string;
  alias: string;
}

function parseLink(inner: string): LinkParts {
  let left = inner;
  let alias = '';
  const pipe = inner.indexOf('|');
  if (pipe >= 0) {
    left = inner.slice(0, pipe);
    alias = inner.slice(pipe + 1).trim();
    // Inside a table the pipe is written `\|`.
    if (left.endsWith('\\')) left = left.slice(0, -1);
  }
  const hash = left.indexOf('#');
  if (hash < 0) return { target: left.trim(), heading: '', alias };
  return {
    target: left.slice(0, hash).trim(),
    heading: left.slice(hash + 1).replace(/^\^/, '').trim(),
    alias,
  };
}

function lastSegment(target: string): string {
  const slash = target.lastIndexOf('/');
  return slash < 0 ? target : target.slice(slash + 1);
}

/** Wikilink targets in order of first appearance, deduped: `[[a|b]]` -> 'a', `[[a#h]]` -> 'a', `[[dir/a]]` -> 'dir/a'. */
export function wikilinks(text: string): string[] {
  if (text.indexOf('[[') < 0) return [];
  const out: string[] = [];
  WIKILINK.lastIndex = 0;
  for (let m = WIKILINK.exec(text); m !== null; m = WIKILINK.exec(text)) {
    const { target } = parseLink(m[1]);
    if (target !== '' && !out.includes(target)) out.push(target);
  }
  return out;
}

/** Replaces each wikilink by its target (not its alias); a folder path keeps only its last segment. */
export function stripWikilinks(text: string): string {
  if (text.indexOf('[[') < 0) return text;
  return text.replace(WIKILINK, (_match, inner: string) => {
    const link = parseLink(inner);
    // `[[#Heading]]` points inside the same note: there is no target to show.
    return link.target !== '' ? lastSegment(link.target) : link.alias || link.heading;
  });
}

function isWordCode(code: number | undefined): boolean {
  if (code === undefined) return false;
  if (code < 128) {
    return (
      (code >= 97 && code <= 122) ||
      (code >= 65 && code <= 90) ||
      (code >= 48 && code <= 57) ||
      code === 95
    );
  }
  // The selector that turns a symbol into an emoji is a mark, but not part of a word: "🗄️Work".
  if (code >= 0xfe00 && code <= 0xfe0f) return false;
  return UNICODE_WORD.test(String.fromCodePoint(code));
}

function wordCharAt(text: string, index: number): boolean {
  return index < text.length && isWordCode(text.codePointAt(index));
}

function wordCharBefore(text: string, index: number): boolean {
  if (index <= 0) return false;
  const low = text.charCodeAt(index - 1);
  const paired = low >= 0xdc00 && low <= 0xdfff && index >= 2;
  return isWordCode(paired ? text.codePointAt(index - 2) : low);
}

/**
 * Index of the first occurrence of `needle` in `haystack` at or after `from`
 * that is not glued to a letter or digit on either side, or -1. Exact case:
 * callers lowercase both. `b&a` is found in `[[b&a]]` but `sam` is not found
 * in `samedi`.
 */
export function findWholeWord(haystack: string, needle: string, from = 0): number {
  if (needle === '') return -1;
  // A name that starts or ends with punctuation ("c++") has no boundary to check on that side.
  const checkBefore = wordCharAt(needle, 0);
  const checkAfter = wordCharBefore(needle, needle.length);
  let at = haystack.indexOf(needle, from);
  while (at >= 0) {
    const end = at + needle.length;
    if (
      (!checkBefore || !wordCharBefore(haystack, at)) &&
      (!checkAfter || !wordCharAt(haystack, end))
    ) {
      return at;
    }
    at = haystack.indexOf(needle, at + 1);
  }
  return -1;
}

export function sectionKey(s: { title: string; ordinal: number }): SectionKey {
  return `${s.title}#${s.ordinal}`;
}

/** Splits on the LAST `#`, because a title may contain one. A key without an ordinal reads as ordinal 0. */
export function parseSectionKey(key: SectionKey): { title: string; ordinal: number } {
  const hash = key.lastIndexOf('#');
  if (hash < 0) return { title: key, ordinal: 0 };
  const tail = key.slice(hash + 1);
  if (!/^\d+$/.test(tail)) return { title: key, ordinal: 0 };
  return { title: key.slice(0, hash), ordinal: Number(tail) };
}

function startsWithLink(line: string, needle: string): boolean {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i += 1;
  }
  return line.startsWith(needle, i);
}

/** True for the line the plugin adds to a section: `↳ [[Mtg-…|Meeting notes]]`. */
export function isLinkLine(line: string, linkPrefix: string = DEFAULT_LINK_PREFIX): boolean {
  return startsWithLink(line, LINK_ARROW + linkPrefix);
}

function isHorizontalRule(trimmed: string): boolean {
  const mark = trimmed.charCodeAt(0);
  if (mark !== 45 && mark !== 42 && mark !== 95) return false;
  let count = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i);
    if (c === mark) count += 1;
    else if (c !== 32 && c !== 9) return false;
  }
  return count >= 3;
}

function stripListMarker(trimmed: string): string {
  const marker = LIST_MARKER.exec(trimmed);
  if (!marker) return trimmed;
  const rest = trimmed.slice(marker[0].length);
  const box = CHECKBOX.exec(rest);
  return box ? rest.slice(box[0].length) : rest;
}

function runLength(text: string, from: number, code: number): number {
  let i = from;
  while (i < text.length && text.charCodeAt(i) === code) i += 1;
  return i - from;
}

function isFrontmatterFence(line: string): boolean {
  return line.startsWith('---') && line.trimEnd() === '---';
}

/** Heading text without the `#` prefix and without a closing `###` run. */
function headingText(line: string, level: number): string {
  const text = line.slice(line.indexOf('#') + level).trim();
  let cut = text.length;
  while (cut > 0 && text.charCodeAt(cut - 1) === 35) cut -= 1;
  if (cut === text.length) return text;
  if (cut === 0) return '';
  const before = text.charCodeAt(cut - 1);
  // `### C#` keeps its hash: a closing run needs a space in front of it.
  return before === 32 || before === 9 ? text.slice(0, cut).trimEnd() : text;
}

interface Anchor {
  line: number;
  isHeading: boolean;
  level: number;
  rawTitle: string;
  title: string;
  links: string[];
  ordinal: number;
  meetingLike: boolean;
}

interface Scan {
  /** Lines without their `\r`. */
  lines: string[];
  /** Offset of each line in the original text. */
  starts: number[];
  kinds: Uint8Array;
  anchors: Anchor[];
  length: number;
}

function classify(lines: string[]): Uint8Array {
  const n = lines.length;
  const kinds = new Uint8Array(n);
  let i = 0;

  if (isFrontmatterFence(lines[0])) {
    let close = -1;
    for (let j = 1; j < n; j++) {
      if (isFrontmatterFence(lines[j])) {
        close = j;
        break;
      }
    }
    // An unclosed `---` on line 0 is a rule, not frontmatter.
    if (close > 0) {
      kinds.fill(INERT, 0, close);
      kinds[close] = INERT_END;
      i = close + 1;
    }
  }

  let fenceCode = 0;
  let fenceLength = 0;
  for (; i < n; i++) {
    const line = lines[i];
    const len = line.length;
    let k = 0;
    let tab = false;
    while (k < len) {
      const c = line.charCodeAt(k);
      if (c === 9) tab = true;
      else if (c !== 32) break;
      k += 1;
    }

    if (fenceCode !== 0) {
      kinds[i] = INERT;
      if (k < len && line.charCodeAt(k) === fenceCode) {
        const run = runLength(line, k, fenceCode);
        if (run >= fenceLength && line.slice(k + run).trim() === '') {
          fenceCode = 0;
          kinds[i] = INERT_END;
        }
      }
      continue;
    }
    if (k === len) {
      kinds[i] = BLANK;
      continue;
    }

    const first = line.charCodeAt(k);
    if (first === 96 || first === 126) {
      // Any indentation opens a fence: Obsidian nests code blocks under list items.
      const run = runLength(line, k, first);
      // "```js```" on one line is inline code, not a fence.
      if (run >= 3 && (first === 126 || line.indexOf('`', k + run) < 0)) {
        fenceCode = first;
        fenceLength = run;
        kinds[i] = INERT;
      }
    } else if (first === 35) {
      if (k <= 3 && !tab) {
        const run = runLength(line, k, 35);
        const after = line.charCodeAt(k + run);
        // `#tag` is a tag: a heading needs a space after its hashes.
        if (run <= 6 && (k + run === len || after === 32 || after === 9)) kinds[i] = run;
      }
    } else if (first > 127 && line.trim() === '') {
      // Only non-breaking or other Unicode spaces.
      kinds[i] = BLANK;
    }
  }
  return kinds;
}

function statelessPattern(pattern: RegExp): RegExp {
  // `test` on a global or sticky pattern remembers where it stopped.
  return pattern.global || pattern.sticky
    ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
    : pattern;
}

/**
 * Marks the headings that name an entity. All pending titles are searched as
 * one string, so the cost is one search per name rather than one per name per
 * heading.
 */
function markEntityHeadings(headings: Anchor[], names: string[]): void {
  const pending: Anchor[] = [];
  const offsets: number[] = [];
  let hay = '';
  for (const heading of headings) {
    if (heading.meetingLike || heading.rawTitle === '') continue;
    pending.push(heading);
    offsets.push(hay.length);
    hay += `${heading.rawTitle.toLowerCase()}\n`;
  }
  let open = pending.length;
  if (open === 0) return;

  for (const raw of names) {
    const name = raw.toLowerCase();
    if (name === '' || name.indexOf('\n') >= 0) continue;
    let at = findWholeWord(hay, name, 0);
    while (at >= 0) {
      let index = pending.length - 1;
      while (offsets[index] > at) index -= 1;
      if (!pending[index].meetingLike) {
        pending[index].meetingLike = true;
        open -= 1;
        if (open === 0) return;
      }
      if (index + 1 >= pending.length) break;
      at = findWholeWord(hay, name, offsets[index + 1]);
    }
  }
}

interface NameIndex {
  names: Set<string>;
  longest: number;
}

function indexNames(list: string[]): NameIndex {
  const names = new Set<string>();
  let longest = 0;
  for (const raw of list) {
    const name = raw.toLowerCase();
    names.add(name);
    if (name.length > longest) longest = name.length;
  }
  return { names, longest };
}

/** True when the whole line is an entity name, give or take `[[ ]]` and a trailing `:` or `.`. */
function isEntityLine(trimmed: string, index: NameIndex): boolean {
  const { names } = index;
  const linked = trimmed.charCodeAt(0) === 91;
  // Most lines are sentences, far longer than any name: skip them before allocating anything.
  if (!linked && trimmed.length > index.longest + 4) return false;
  let text = trimmed;
  const last = text.charCodeAt(text.length - 1);
  if (last === 58 || last === 46) text = text.slice(0, -1).trimEnd();
  if (text === '') return false;

  const candidates: string[] = [];
  if (linked && text.startsWith('[[') && text.endsWith(']]')) {
    const inner = text.slice(2, -2);
    // Two links on one line are a sentence, not a name.
    if (inner.indexOf('[') >= 0 || inner.indexOf(']') >= 0) return false;
    const link = parseLink(inner);
    candidates.push(link.target, lastSegment(link.target), link.alias);
  } else {
    candidates.push(text);
  }
  for (const candidate of candidates) {
    if (candidate === '') continue;
    const lower = candidate.toLowerCase();
    if (names.has(lower)) return true;
    if (
      (lower.indexOf('  ') >= 0 || lower.indexOf('\t') >= 0) &&
      names.has(collapseWhitespace(lower))
    ) {
      return true;
    }
  }
  return false;
}

/** Lines without their `\r` (or a byte order mark), and where each one starts in the original text. */
function splitLines(docText: string): { lines: string[]; starts: number[] } {
  const lines = docText.split('\n');
  const starts = new Array<number>(lines.length);
  let position = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    starts[i] = position;
    position += line.length + 1;
    if (line.charCodeAt(line.length - 1) === 13) lines[i] = line.slice(0, -1);
  }
  if (lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);
  return { lines, starts };
}

function scan(docText: string, opts: SectionOptions): Scan {
  const { lines, starts } = splitLines(docText);
  const n = lines.length;
  const kinds = classify(lines);
  const soft = statelessPattern(opts.softMarker);
  const names = opts.entityNames ?? [];
  const linkNeedle = LINK_ARROW + (opts.linkPrefix ?? DEFAULT_LINK_PREFIX);

  const headings: Anchor[] = [];
  for (let i = 0; i < n; i++) {
    const level = kinds[i];
    if (level < 1 || level > 3) continue;
    const rawTitle = headingText(lines[i], level);
    const links = wikilinks(rawTitle);
    headings.push({
      line: i,
      isHeading: true,
      level,
      rawTitle,
      title: collapseWhitespace(stripWikilinks(rawTitle)),
      links,
      ordinal: 0,
      meetingLike: links.length > 0 || soft.test(rawTitle.slice(0, SOFT_MARKER_SCAN_LENGTH)),
    });
  }
  if (names.length > 0) markEntityHeadings(headings, names);

  const anchors: Anchor[] = [];
  let nameIndex: NameIndex | null = null;
  let nextHeading = 0;
  // A meeting heading owns its whole body: no soft markers below it.
  let underMeeting = false;
  let seenLine = false;
  for (let i = 0; i < n; i++) {
    const kind = kinds[i];
    if (kind >= INERT) continue;
    if (kind >= 1 && kind <= 3) {
      const heading = headings[nextHeading];
      nextHeading += 1;
      anchors.push(heading);
      underMeeting = heading.meetingLike;
    } else if (kind === TEXT && !underMeeting && !startsWithLink(lines[i], linkNeedle)) {
      /* The plugin's own line is looked through: adding it must never change
         what the sections are. Only a line that is not one itself looks up, so
         a run of them is walked once rather than once per line of the run. */
      let above = i - 1;
      while (above >= 0 && kinds[above] === TEXT && startsWithLink(lines[above], linkNeedle)) above -= 1;
      const previous = above >= 0 ? kinds[above] : BLANK;
      if (!seenLine || previous === BLANK || (previous >= 1 && previous <= 6)) {
        const trimmed = lines[i].trim();
        let isMarker = false;
        if (
          trimmed.length <= SOFT_MARKER_MAX_LENGTH &&
          trimmed.charCodeAt(0) !== 62 &&
          !LIST_MARKER.test(trimmed) &&
          !trimmed.startsWith(linkNeedle)
        ) {
          if (soft.test(trimmed)) {
            isMarker = true;
          } else if (names.length > 0) {
            if (nameIndex === null) nameIndex = indexNames(names);
            isMarker = isEntityLine(trimmed, nameIndex);
          }
        }
        if (isMarker) {
          anchors.push({
            line: i,
            isHeading: false,
            level: 0,
            rawTitle: trimmed,
            title: collapseWhitespace(stripWikilinks(trimmed)),
            links: wikilinks(trimmed),
            ordinal: 0,
            meetingLike: true,
          });
        }
      }
    }
    if (!seenLine && !(kind === TEXT && startsWithLink(lines[i], linkNeedle))) seenLine = true;
  }

  const counts = new Map<string, number>();
  for (const anchor of anchors) {
    const earlier = counts.get(anchor.title) ?? 0;
    anchor.ordinal = earlier;
    counts.set(anchor.title, earlier + 1);
  }

  return { lines, starts, kinds, anchors, length: docText.length };
}

/** Index of the last entry whose value is <= `wanted`, or -1. */
function lastAtOrBefore<T>(list: T[], wanted: number, valueOf: (entry: T) => number): number {
  let low = 0;
  let high = list.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (valueOf(list[mid]) <= wanted) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

const anchorLineOf = (anchor: Anchor): number => anchor.line;
const identity = (value: number): number => value;

/** The items of the lines `bodyStartLine` to `bodyEndLine`, and the first plugin link line among them. */
function collectItems(
  doc: Scan,
  bodyStartLine: number,
  bodyEndLine: number,
  linkNeedle: string,
): { items: SectionItem[]; linkLine: number | null } {
  const { lines, kinds } = doc;
  const items: SectionItem[] = [];
  const seen = new Map<string, number>();
  let linkLine: number | null = null;
  for (let i = bodyStartLine; i < bodyEndLine; i++) {
    const kind = kinds[i];
    if (kind >= BLANK) continue;
    const raw = lines[i];
    let text: string;
    let itemKind: SectionItem['kind'];
    let task: string | null = null;
    if (kind === TEXT) {
      const trimmed = raw.trim();
      if (trimmed.startsWith(linkNeedle)) {
        if (linkLine === null) linkLine = i;
        continue;
      }
      if (isHorizontalRule(trimmed)) continue;
      text = stripListMarker(trimmed);
      itemKind = 'item';
      task = taskStatus(trimmed);
    } else {
      text = headingText(raw, kind);
      itemKind = 'topic';
    }
    // A bullet or heading with nothing typed after it yet.
    if (text === '') continue;
    const hash = itemHash(text);
    const occurrence = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, occurrence);
    items.push({
      id: occurrence === 1 ? hash : `${hash}#${occurrence}`,
      text,
      raw,
      line: i,
      kind: itemKind,
      ...(task !== null ? { task } : {}),
    });
  }
  return { items, linkLine };
}

function buildSection(doc: Scan, index: number, linkNeedle: string): Section {
  const { lines, starts, anchors } = doc;
  const anchor = anchors[index];
  const n = lines.length;

  let bodyEndLine = n;
  for (let j = index + 1; j < anchors.length; j++) {
    const next = anchors[j];
    // A soft marker ends at any anchor; a heading only at one of its own level or higher.
    if (!anchor.isHeading || (next.isHeading && next.level <= anchor.level)) {
      bodyEndLine = next.line;
      break;
    }
  }
  const bodyStartLine = anchor.line + 1;

  const { items, linkLine } = collectItems(doc, bodyStartLine, bodyEndLine, linkNeedle);

  return {
    title: anchor.title,
    rawTitle: anchor.rawTitle,
    links: anchor.links.slice(),
    ordinal: anchor.ordinal,
    isHeading: anchor.isHeading,
    level: anchor.level,
    anchorLine: anchor.line,
    bodyStartLine,
    bodyEndLine,
    from: bodyStartLine < n ? starts[bodyStartLine] : doc.length,
    to: bodyEndLine < n ? starts[bodyEndLine] : doc.length,
    items,
    linkLine,
  };
}

/* Where the plugin's own sections begin in a note that is its own meeting note: the first
   `<!-- hamster:begin … -->` marker, with the `## …` heading and blank lines just above it. */
const PLUGIN_REGION = /^\s*<!--\s*hamster:begin\b/;

/** The line where the plugin's sections begin in a note, or the line count when it has none. */
export function pluginRegionsStart(lines: readonly string[]): number {
  const marker = lines.findIndex((line) => PLUGIN_REGION.test(line));
  if (marker < 0) return lines.length;
  let end = marker;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  if (end > 0 && /^##\s/.test(lines[end - 1])) end -= 1;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  return end;
}

/**
 * A whole note as one section, for a meeting typed in a note of its own: everything after the
 * frontmatter, up to the plugin's own sections when the note is its own meeting note. `title` is
 * what the meeting is called, usually the note's name. Headings in it are items, like topics.
 */
export function wholeNoteSection(docText: string, title: string, opts: SectionOptions): Section {
  const doc = scan(docText, opts);
  const { lines, starts } = doc;
  const n = lines.length;
  const bodyEndLine = pluginRegionsStart(lines);
  const { items, linkLine } = collectItems(doc, 0, bodyEndLine, LINK_ARROW + (opts.linkPrefix ?? DEFAULT_LINK_PREFIX));
  return {
    title,
    rawTitle: title,
    links: [],
    ordinal: 0,
    isHeading: false,
    level: 0,
    anchorLine: -1,
    bodyStartLine: 0,
    bodyEndLine,
    from: 0,
    to: bodyEndLine < n ? starts[bodyEndLine] : doc.length,
    items,
    linkLine,
  };
}

/** Every anchor in document order. Soft-marker anchors are always meeting-like. */
export function listSections(docText: string, opts: SectionOptions): SectionSummary[] {
  return scan(docText, opts).anchors.map((anchor) => ({
    title: anchor.title,
    rawTitle: anchor.rawTitle,
    links: anchor.links.slice(),
    ordinal: anchor.ordinal,
    isHeading: anchor.isHeading,
    level: anchor.level,
    anchorLine: anchor.line,
    meetingLike: anchor.meetingLike,
  }));
}

/** The section of the nearest anchor at or above the cursor, or null when there is none. */
export function sectionAt(docText: string, offset: number, opts: SectionOptions): Section | null {
  const doc = scan(docText, opts);
  if (doc.anchors.length === 0) return null;
  const clamped = Math.min(Math.max(Number.isFinite(offset) ? offset : 0, 0), doc.length);
  const line = lastAtOrBefore(doc.starts, clamped, identity);
  const index = lastAtOrBefore(doc.anchors, line, anchorLineOf);
  if (index < 0) return null;
  return buildSection(doc, index, LINK_ARROW + (opts.linkPrefix ?? DEFAULT_LINK_PREFIX));
}

function linksTo(line: string, basename: string): boolean {
  if (line.indexOf(basename) < 0) return false;
  for (const target of wikilinks(line)) {
    const leaf = lastSegment(target);
    // Compared whole, so "… Jane Example" does not match the link to "… Jane Example (2)".
    if (leaf === basename || leaf === `${basename}.md`) return true;
  }
  return false;
}

/**
 * The section with that title and ordinal. When the heading was renamed since,
 * the link to the companion is the back-reference: the section holding it.
 */
export function findSection(
  docText: string,
  key: { title: string; ordinal: number },
  opts: SectionOptions,
  companionBasename?: string,
): Section | null {
  const doc = scan(docText, opts);
  const linkNeedle = LINK_ARROW + (opts.linkPrefix ?? DEFAULT_LINK_PREFIX);
  const { anchors, lines, kinds } = doc;

  let keyed = -1;
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i].ordinal === key.ordinal && anchors[i].title === key.title) {
      keyed = i;
      break;
    }
  }
  if (!companionBasename) return keyed < 0 ? null : buildSection(doc, keyed, linkNeedle);

  /* Once a companion exists, the plugin's own link line is the durable identity
     of its section. The title#ordinal key is not: renaming the heading loses it,
     and a same-titled section inserted above captures it. */
  let mention = -1;
  /* The first section, other than the keyed one, that holds a link line to the companion. */
  let elsewhere = -1;
  let own: Section | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (kinds[i] >= BLANK) continue;
    if (!linksTo(lines[i], companionBasename)) continue;
    const index = lastAtOrBefore(anchors, i, anchorLineOf);
    if (index < 0) continue;
    if (startsWithLink(lines[i], LINK_ARROW)) {
      // No section of that key: of two lines to one note the first counts.
      if (keyed < 0) return buildSection(doc, index, linkNeedle);
      /* The keyed section still owns the link, possibly inside a nested
         child section: keep the meeting on the section the user chose,
         wherever else in the note a copy of the line stands. */
      own ??= buildSection(doc, keyed, linkNeedle);
      if (i >= own.bodyStartLine && i < own.bodyEndLine) return own;
      if (elsewhere < 0) elsewhere = index;
      continue;
    }
    // A mention of the companion elsewhere in the note is only a last resort.
    if (mention < 0) mention = index;
  }
  if (elsewhere >= 0) return buildSection(doc, elsewhere, linkNeedle);
  if (keyed >= 0) return own ?? buildSection(doc, keyed, linkNeedle);
  return mention < 0 ? null : buildSection(doc, mention, linkNeedle);
}

/**
 * 0-based line AFTER which the plugin's link line goes: the anchor line, or
 * the last line of the body that has text and is not inside a code fence.
 */
export function linkInsertLine(
  docText: string,
  section: Section,
  placement: 'section-end' | 'heading',
): number {
  if (placement === 'heading') return section.anchorLine;
  const { lines } = splitLines(docText);
  const kinds = classify(lines);
  const end = Math.min(section.bodyEndLine, lines.length);
  for (let i = end - 1; i >= section.bodyStartLine; i--) {
    // Inside a code fence the line would be code: the parser would never see it again.
    if (kinds[i] !== BLANK && kinds[i] !== INERT) return i;
  }
  return section.anchorLine;
}

/**
 * Where and how the plugin's link line goes in. `blankBefore` asks for an empty
 * line first: directly after a list item, a table row or a quote, a lone line
 * is absorbed into that block (it renders as part of the last bullet, and
 * inside a table the alias pipe breaks the link).
 */
export function linkInsertion(
  docText: string,
  section: Section,
  placement: 'section-end' | 'heading',
): { afterLine: number; blankBefore: boolean } {
  const afterLine = linkInsertLine(docText, section, placement);
  if (placement === 'heading' || afterLine === section.anchorLine) {
    return { afterLine, blankBefore: false };
  }
  const { lines } = splitLines(docText);
  const trimmed = (lines[afterLine] ?? '').trimStart();
  const inBlock =
    LIST_MARKER.test(trimmed) || trimmed.startsWith('|') || trimmed.startsWith('>');
  return { afterLine, blankBefore: inBlock };
}
