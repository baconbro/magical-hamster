import { estimateTokens } from '../util/text.ts';

export interface ChunkOptions {
  /** Default 480. */
  maxTokens?: number;
  /** Default 5. */
  overlapTokens?: number;
  /** Default 20. */
  minChars?: number;
}

interface Line {
  text: string;
  /** Part of a fenced code block: never a heading, never a paragraph break. */
  code: boolean;
}

interface Piece {
  text: string;
  /** What joins this piece to the text before it. */
  sep: string;
}

/* The companion's transcript region is searched through the transcript index,
   so it stays out of the vault index. The markers are matched here rather than
   imported: this module has no dependency on the notes layer. */
const TRANSCRIPT_BEGIN = /^<!--\s*hamster:begin transcript\s*-->/;
const TRANSCRIPT_END = /<!--\s*hamster:end transcript\s*-->/;
const TRANSCRIPT_BEGIN_LINE = /^\s*<!--\s*hamster:begin transcript\s*-->\s*$/;
// Where a plain comment stops: at its "-->", or at a transcript marker when
// that comes first. A stray "<!--" must not swallow the marker, or the
// transcript after it would be indexed.
const COMMENT_STOP = /-->|<!--\s*hamster:begin transcript\s*-->/;

// The lookbehind stops a match from starting inside a run of punctuation:
// without it a long row of dots is tried again from each of its positions.
const SENTENCE_END = /(?<![.!?…])[.!?…]+["')\]»]*\s+/g;
const LINE_END = /\n+/g;
const SPACE = /\s+/g;
// A list item, a table row or a quote: units that break on lines, not on sentences.
const STRUCTURED_LINE = /^\s*(?:[-*+]\s|\d+[.)]\s|\||>)/;

export function stripFrontmatter(markdown: string): string {
  const text = markdown.replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

function readableLinks(text: string): string {
  return text.replace(
    /!?\[\[([^[\]|]+?)(?:\\?\|([^[\]]*))?\]\]/g,
    (_all, target: string, alias: string | undefined) => alias?.trim() || target.trim(),
  );
}

function openFence(line: string): { char: string; length: number; dataview: boolean } | null {
  // `>` is allowed in front: Dataview blocks often sit inside callouts.
  const match = /^[\s>]*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const [, mark, info] = match;
  // ```code``` on one line is an inline span, not a fence.
  if (mark[0] === '`' && info.includes('`')) return null;
  return { char: mark[0], length: mark.length, dataview: /^\s*dataview(?:js)?(?:\s|$)/i.test(info) };
}

function closesFence(line: string, char: string, length: number): boolean {
  const mark = line.replace(/^[\s>]*/, '').trimEnd();
  if (mark.length < length) return false;
  for (const c of mark) if (c !== char) return false;
  return true;
}

/** Drops frontmatter, Dataview blocks, HTML comments and the transcript region; marks code lines. */
function cleanLines(markdown: string): Line[] {
  const src = stripFrontmatter(markdown).replace(/\r\n?/g, '\n').split('\n');
  const out: Line[] = [];
  // What earlier searches for a comment's end already established, so a note
  // full of unterminated "<!--" stays linear: no "-->" from here to the end of
  // the note, or none before the transcript marker on this line.
  let noCloseAhead = false;
  let markerLine = -1;

  /**
   * The line a comment ends on and the text after it. When it never ends,
   * how much of `tail` is literal text: up to the transcript marker on the
   * same line, or all of it. An opener in that stretch would run the same
   * search and get the same answer, so the caller skips it in one step.
   */
  const closeComment = (line: number, tail: string): { line: number; after: string } | { literal: number } => {
    const same = COMMENT_STOP.exec(tail.slice(4));
    if (same) {
      return same[0] === '-->' ? { line, after: tail.slice(4 + same.index + 3) } : { literal: 4 + same.index };
    }
    const never = { literal: tail.length };
    if (noCloseAhead || line < markerLine) return never;
    for (let j = line + 1; j < src.length; j++) {
      const stop = COMMENT_STOP.exec(src[j]);
      if (!stop) continue;
      if (stop[0] === '-->') return { line: j, after: src[j].slice(stop.index + 3) };
      markerLine = j;
      return never;
    }
    noCloseAhead = true;
    return never;
  };

  const closeTranscript = (line: number, tail: string): { line: number; after: string } | null => {
    for (let j = line; j < src.length; j++) {
      const text = j === line ? tail : src[j];
      const end = TRANSCRIPT_END.exec(text);
      if (end) return { line: j, after: text.slice(end.index + end[0].length) };
    }
    return null;
  };

  let i = 0;
  while (i < src.length) {
    const fence = openFence(src[i]);
    if (fence) {
      // An unclosed fence runs to the end of the note, but not over the
      // transcript marker: generated text cut short inside a code block would
      // otherwise turn the whole transcript into code, and index it.
      let end = i + 1;
      let closed = false;
      while (end < src.length && !TRANSCRIPT_BEGIN_LINE.test(src[end])) {
        closed = closesFence(src[end], fence.char, fence.length);
        if (closed) break;
        end += 1;
      }
      const last = closed ? end : end - 1;
      if (!fence.dataview) {
        for (let j = i; j <= last; j++) out.push({ text: src[j], code: true });
      }
      i = last + 1;
      continue;
    }

    let kept = '';
    let rest = src[i];
    for (;;) {
      const at = rest.indexOf('<!--');
      if (at < 0) {
        kept += rest;
        break;
      }
      kept += rest.slice(0, at);
      const tail = rest.slice(at);
      const close = TRANSCRIPT_BEGIN.test(tail) ? closeTranscript(i, tail) : closeComment(i, tail);

      if (!close) {
        // A begin marker without its end: the transcript is the last region of
        // a companion, so everything after the marker is treated as transcript.
        i = src.length;
        break;
      }
      if ('literal' in close) {
        // An unterminated "<!--" is literal text, as it is in a rendered note.
        kept += tail.slice(0, close.literal);
        rest = tail.slice(close.literal);
        continue;
      }
      i = close.line;
      // "a <!-- x --> b" reads "a b", not "a  b".
      rest = /\s$/.test(kept) ? close.after.replace(/^[ \t]+/, '') : close.after;
    }
    out.push({ text: readableLinks(kept), code: false });
    i += 1;
  }
  return out;
}

function parseHeading(line: string): { level: number; text: string } | null {
  // Whitespace after the hashes is required: `#tag` is a tag, not a heading.
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
  if (!match) return null;
  const text = (match[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
  return { level: match[1].length, text };
}

function isLinkedMentions(heading: string): boolean {
  return /^linked mentions:?$/i.test(heading.replace(/[*_`]/g, '').trim());
}

function splitSections(lines: Line[]): Array<{ heading: string; lines: Line[] }> {
  let current: { heading: string; lines: Line[] } = { heading: '', lines: [] };
  const out = [current];
  const path: Array<{ level: number; text: string }> = [];
  // Level of the "Linked mentions" heading being skipped, 0 when none.
  let skipping = 0;

  for (const line of lines) {
    const heading = line.code ? null : parseHeading(line.text);
    if (!heading) {
      if (!skipping) current.lines.push(line);
      continue;
    }
    if (skipping && heading.level > skipping) continue;
    skipping = 0;
    while (path.length > 0 && path[path.length - 1].level >= heading.level) path.pop();
    if (isLinkedMentions(heading.text)) {
      skipping = heading.level;
      continue;
    }
    path.push(heading);
    current = {
      heading: path
        .map((h) => h.text)
        .filter(Boolean)
        .join(' › '),
      lines: [],
    };
    out.push(current);
  }
  return out;
}

/** Blank-line separated blocks. A fenced block is one block even with blank lines inside. */
function splitBlocks(lines: Line[]): Array<{ text: string; structured: boolean }> {
  const out: Array<{ text: string; structured: boolean }> = [];
  let block: Line[] = [];
  const flush = (): void => {
    if (block.length === 0) return;
    const text = block
      .map((l) => l.text.trimEnd())
      .join('\n')
      .trim();
    if (text) {
      out.push({ text, structured: block.some((l) => l.code) || STRUCTURED_LINE.test(block[0].text) });
    }
    block = [];
  };
  for (const line of lines) {
    if (!line.code && line.text.trim() === '') flush();
    else block.push(line);
  }
  flush();
  return out;
}

/** Splits after each match of `boundary`; the pieces concatenate back to `text`. */
function splitAfter(text: string, boundary: RegExp): string[] {
  const out: string[] = [];
  let last = 0;
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].length;
    if (end <= last || end >= text.length) continue;
    out.push(text.slice(last, end));
    last = end;
  }
  out.push(text.slice(last));
  return out;
}

/** For a run with no whitespace to split on (a long URL, an encoded blob). */
function cutByLength(text: string, budget: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (estimateTokens(rest) > budget) {
    let n = Math.max(1, Math.floor((rest.length * budget) / estimateTokens(rest)));
    while (n > 1 && estimateTokens(rest.slice(0, n)) > budget) n -= 1;
    const last = rest.charCodeAt(n - 1);
    if (n > 1 && last >= 0xd800 && last <= 0xdbff) n -= 1;
    out.push(rest.slice(0, n));
    rest = rest.slice(n);
  }
  if (rest) out.push(rest);
  return out;
}

function atomize(text: string, budget: number, boundaries: RegExp[]): string[] {
  if (estimateTokens(text) <= budget) return [text];
  if (boundaries.length === 0) return cutByLength(text, budget);
  const [boundary, ...finer] = boundaries;
  return splitAfter(text, boundary).flatMap((part) => atomize(part, budget, finer));
}

/** Breaks a block that exceeds the budget into pieces that fit, at the coarsest boundary that works. */
function splitOversized(block: { text: string; structured: boolean }, budget: number): Piece[] {
  // Prose breaks on sentences first. A list, a table or code breaks on lines
  // first, so an item is not cut in the middle when whole items would fit.
  const boundaries = block.structured ? [LINE_END, SENTENCE_END, SPACE] : [SENTENCE_END, LINE_END, SPACE];
  const raw: string[] = [];
  let current = '';
  for (const atom of atomize(block.text, budget, boundaries)) {
    if (current && estimateTokens((current + atom).trim()) > budget) {
      raw.push(current);
      current = '';
    }
    current += atom;
  }
  if (current) raw.push(current);

  const pieces: Piece[] = [];
  let gap = '';
  for (const part of raw) {
    const text = part.trim();
    if (!text) {
      gap += part;
      continue;
    }
    const between = gap + part.slice(0, part.length - part.trimStart().length);
    pieces.push({ text, sep: pieces.length === 0 ? '\n\n' : between.includes('\n') ? '\n' : ' ' });
    gap = part.slice(part.trimEnd().length);
  }
  return pieces;
}

/** The last words of `text` that fit in `tokens`. */
function tailWords(text: string, tokens: number): string {
  if (tokens <= 0) return '';
  const words = text.split(/\s+/).filter(Boolean);
  let tail = '';
  for (let i = words.length - 1; i >= 0; i--) {
    const longer = tail ? `${words[i]} ${tail}` : words[i];
    if (estimateTokens(longer) > tokens) break;
    tail = longer;
  }
  return tail;
}

function inkLength(text: string): number {
  return text.replace(/\s+/g, '').length;
}

function pack(pieces: Piece[], maxTokens: number, overlapTokens: number, minChars: number): string[] {
  const out: string[] = [];
  let text = '';
  // Characters of the chunk's own content: the words carried over from the
  // previous chunk do not make a tiny chunk worth keeping.
  let ink = 0;
  let previous = '';
  const emit = (): void => {
    if (ink >= minChars) out.push(text);
    previous = text;
    text = '';
    ink = 0;
  };

  for (const piece of pieces) {
    if (text) {
      const joined = text + piece.sep + piece.text;
      if (estimateTokens(joined) <= maxTokens) {
        text = joined;
        ink += inkLength(piece.text);
        continue;
      }
      emit();
    }
    const carried = previous ? tailWords(previous, overlapTokens) : '';
    const withOverlap = carried ? carried + piece.sep + piece.text : piece.text;
    text = estimateTokens(withOverlap) <= maxTokens ? withOverlap : piece.text;
    ink = inkLength(piece.text);
  }
  if (text) emit();
  return out;
}

function option(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}

/**
 * Splits a note into heading-scoped chunks for embedding. `heading` is the path
 * of headings above the chunk ("Plan › Risks"), empty before the first heading.
 */
export function chunkMarkdown(markdown: string, opts: ChunkOptions = {}): Array<{ heading: string; text: string }> {
  const maxTokens = Math.max(8, option(opts.maxTokens, 480));
  const overlapTokens = Math.min(Math.max(0, option(opts.overlapTokens, 5)), Math.floor(maxTokens / 4));
  const minChars = Math.max(0, option(opts.minChars, 20));
  // Room is left for the carried-over words and their separator, so a chunk
  // that starts with an overlap still fits in maxTokens.
  const budget = overlapTokens > 0 ? maxTokens - overlapTokens - 1 : maxTokens;

  const out: Array<{ heading: string; text: string }> = [];
  for (const section of splitSections(cleanLines(markdown))) {
    const pieces = splitBlocks(section.lines).flatMap((block): Piece[] =>
      estimateTokens(block.text) <= budget ? [{ text: block.text, sep: '\n\n' }] : splitOversized(block, budget),
    );
    for (const text of pack(pieces, maxTokens, overlapTokens, minChars)) {
      out.push({ heading: section.heading, text });
    }
  }
  return out;
}
