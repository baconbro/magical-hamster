import type { CompanionMeta, MergeResult, Patch, Region } from '../types.ts';

export const REGIONS: readonly Region[] = ['enhanced', 'summary', 'qa', 'transcript'];

export const TRANSCRIPT_CALLOUT = '> [!quote]- Transcript';

const SECTION_HEADINGS: Record<Region, string> = {
  enhanced: 'Enhanced notes',
  summary: 'AI summary',
  qa: 'Q&A insights',
  transcript: 'Transcript',
};

export function beginMarker(region: Region): string {
  return `<!-- hamster:begin ${region} -->`;
}

export function endMarker(region: Region): string {
  return `<!-- hamster:end ${region} -->`;
}

const BYTE_ORDER_MARK = 0xfeff;

/* Cut by hand: a pattern such as `/[ \t\r]+$/` retries from every run inside the
   text, which takes seconds on a gap or a blank stretch tens of thousands long. */
function cutTrailing(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

/* A JSON string is a valid YAML double-quoted scalar, except for the few
   characters YAML reads as line breaks or refuses unescaped. */
function yamlString(value: string): string {
  let out = '';
  for (const ch of JSON.stringify(value)) {
    const code = ch.charCodeAt(0);
    const unsafe =
      (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || code === BYTE_ORDER_MARK;
    out += unsafe ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
  }
  return out;
}

function yamlList(values: string[]): string {
  return `[${values.map(yamlString).join(', ')}]`;
}

/** Unquoted so Obsidian types the property as a date; anything else is quoted to stay valid YAML. */
function yamlDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : yamlString(value);
}

/** A value of the user's own: as typed when it is a plain word or phrase, quoted otherwise. */
function yamlValue(value: string): string {
  return /^[\p{L}\p{N}][\p{L}\p{N} _./-]*$/u.test(value) && !/^(?:true|false|null|yes|no|on|off|~)$/i.test(value)
    ? value
    : yamlString(value);
}

/** The keys the plugin writes and reads back: a property of the user's cannot take their place. */
const OWN_KEYS = new Set(['type', 'created', 'updated', 'date', 'attendees', 'projects', 'links', 'tags', 'hamster_source']);

/**
 * The setting "Extra properties": one `key: value` per line, for new companion notes. Blank lines
 * are skipped. Returns the properties, or the first line that cannot be one, with why.
 */
export function parseCompanionProperties(
  text: string,
): { properties: Array<[string, string]> } | { error: string } {
  const properties: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) return { error: `"${line}" is not key: value.` };
    const [, key, value] = match;
    if (OWN_KEYS.has(key.toLowerCase())) return { error: `"${key}" is written by the plugin itself.` };
    if (seen.has(key.toLowerCase())) return { error: `"${key}" is given twice.` };
    if (value.trim() === '') return { error: `"${key}" has no value.` };
    seen.add(key.toLowerCase());
    properties.push([key, value.trim()]);
  }
  return { properties };
}

export function renderCompanion(meta: CompanionMeta): string {
  const date = yamlDate(meta.date);
  // A line break in the title could put a marker alone on a line of its own.
  const title = meta.title
    .split(/[\r\n]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');

  const lines = [
    '---',
    'type: meeting',
    ...(meta.properties ?? []).map(([key, value]) => `${key}: ${yamlValue(value)}`),
    `created: ${date}`,
    `updated: ${date}`,
    `date: ${date}`,
    `attendees: ${yamlList(meta.attendees)}`,
    `projects: ${yamlList(meta.projects)}`,
    `links: ${yamlList([`[[${meta.dailyBasename}]]`])}`,
    'tags: [meeting, magical-hamster]',
    `hamster_source: ${yamlString(meta.source)}`,
    '---',
    '',
    `# ${title}`,
  ];
  lines.push(...regionSkeleton());
  return `${lines.join('\n')}\n`;
}

/** The plugin's four sections, empty, each opened by a blank line: what a companion holds below its title. */
export function regionSkeleton(): string[] {
  const lines: string[] = [];
  for (const region of REGIONS) {
    lines.push('', `## ${SECTION_HEADINGS[region]}`, beginMarker(region));
    if (region === 'transcript') lines.push(TRANSCRIPT_CALLOUT);
    lines.push(endMarker(region));
  }
  return lines;
}

interface MarkerLine {
  /** Offset of the line's first character. */
  start: number;
  /** Offset just past the line's newline, or the end of the text. */
  next: number;
  /** The line without trailing spaces, tabs or `\r`. */
  body: string;
}

const HINT = 'hamster:';

/* Any line that is nothing but a hamster comment, however it is indented or
   spaced. Looser than the exact markers on purpose: a marker someone reflowed
   still has to block a write across it. */
const MARKER_LIKE = /^\s*<!--\s*hamster:[^]*-->\s*$/;

/* What a patch may never carry. Kept at least as loose as MARKER_LIKE, so
   nothing this module writes can later read as a marker. */
const MARKER_OPENER = /<!--\s*hamster:/;

function markerLines(text: string): MarkerLine[] {
  const found: MarkerLine[] = [];
  let hit = text.indexOf(HINT);
  while (hit !== -1) {
    const start = text.lastIndexOf('\n', hit) + 1;
    const newline = text.indexOf('\n', hit);
    const stop = newline === -1 ? text.length : newline;
    const line = text.slice(start, stop);
    if (MARKER_LIKE.test(line)) {
      found.push({
        start,
        next: newline === -1 ? text.length : newline + 1,
        body: cutTrailing(line, ' \t\r'),
      });
    }
    hit = text.indexOf(HINT, stop);
  }
  return found;
}

/** Character offsets of the content between the marker lines: [end of begin-marker line incl. newline, start of end-marker line). */
export function regionRange(text: string, region: Region): { from: number; to: number } | null {
  const beginText = beginMarker(region);
  const endText = endMarker(region);
  const lines = markerLines(text);

  let begin: MarkerLine | null = null;
  let end: MarkerLine | null = null;
  for (const line of lines) {
    if (line.body === beginText) {
      if (begin) return null;
      begin = line;
    } else if (line.body === endText) {
      if (end) return null;
      end = line;
    }
  }
  if (!begin || !end || begin.start >= end.start) return null;
  for (const line of lines) {
    if (line.start > begin.start && line.start < end.start) return null;
  }
  return { from: begin.next, to: end.start };
}

/** Content between the marker lines, exactly as stored. Null when the structure is damaged. */
export function readRegion(text: string, region: Region): string | null {
  const range = regionRange(text, region);
  return range ? text.slice(range.from, range.to) : null;
}

/** The note with that region's content removed (markers kept). Unchanged when the region is damaged. */
export function stripRegion(text: string, region: Region): string {
  const range = regionRange(text, region);
  return range ? text.slice(0, range.from) + text.slice(range.to) : text;
}

function trimBlankLines(content: string): string {
  const body = content.replace(/^(?:[ \t]*\r?\n)+/, '');
  // The same cut as cutTrailing, one blank line at a time.
  let end = body.length;
  for (;;) {
    let at = end;
    while (at > 0 && (body[at - 1] === ' ' || body[at - 1] === '\t')) at -= 1;
    if (at === 0 || body[at - 1] !== '\n') break;
    at -= 1;
    if (at > 0 && body[at - 1] === '\r') at -= 1;
    end = at;
  }
  const trimmed = body.slice(0, end);
  return trimmed.trim() === '' ? '' : trimmed;
}

export function merge(text: string, patch: Patch): MergeResult {
  const damaged: MergeResult = { ok: false, error: 'structure', region: patch.region };

  const incoming = patch.region === 'transcript' ? patch.append : patch.content;
  if (MARKER_OPENER.test(incoming)) return damaged;

  const range = regionRange(text, patch.region);
  if (!range) return damaged;

  if (patch.region === 'transcript') {
    // A blank line would close the callout, so stray newlines at either end are dropped.
    const addition = cutTrailing(patch.append.replace(/^[\r\n]+/, ''), '\r\n');
    if (addition.trim() === '') return { ok: true, text, changed: false };
    return {
      ok: true,
      text: `${text.slice(0, range.to)}${addition}\n${text.slice(range.to)}`,
      changed: true,
    };
  }

  const content = trimBlankLines(patch.content);
  const next = text.slice(0, range.from) + (content === '' ? '' : `${content}\n`) + text.slice(range.to);
  return { ok: true, text: next, changed: next !== text };
}

/** Applies each patch independently: a damaged region is skipped, the others still apply. */
export function mergeAll(
  text: string,
  patches: Patch[],
): { text: string; changed: boolean; detached: Region[] } {
  let current = text;
  const detached: Region[] = [];
  for (const patch of patches) {
    const result = merge(current, patch);
    if (result.ok) current = result.text;
    else if (!detached.includes(result.region)) detached.push(result.region);
  }
  return { text: current, changed: current !== text, detached };
}

function frontmatter(text: string): string | null {
  const body = text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text;
  const open = /^---[ \t]*\r?\n/.exec(body);
  if (!open) return null;
  let at = open[0].length;
  while (at <= body.length) {
    const newline = body.indexOf('\n', at);
    const stop = newline === -1 ? body.length : newline;
    if (cutTrailing(body.slice(at, stop), ' \t\r') === '---') return body.slice(open[0].length, at);
    if (newline === -1) break;
    at = newline + 1;
  }
  return null;
}

/* One-line scalars only: plain, single-quoted or double-quoted. That covers
   what renderCompanion writes and what Obsidian's property editor rewrites it to. */
function scalar(block: string, key: string): string | null {
  const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(block);
  return line ? scalarValue(line[1]) : null;
}

/** The string a one-line value reads as; null when it is empty or not a scalar. */
function scalarValue(text: string): string | null {
  const raw = text.trim();
  if (raw === '') return null;

  if (raw.startsWith('"')) {
    const quoted = /^"(?:[^"\\]|\\.)*"/.exec(raw);
    if (!quoted) return null;
    try {
      const value: unknown = JSON.parse(quoted[0]);
      return typeof value === 'string' ? value : null;
    } catch {
      // A YAML-only escape (\x41, \e): keep the text, drop the backslashes.
      return quoted[0].slice(1, -1).replace(/\\(.)/g, '$1');
    }
  }
  if (raw.startsWith("'")) {
    const quoted = /^'((?:[^']|'')*)'/.exec(raw);
    return quoted ? quoted[1].replace(/''/g, "'") : null;
  }
  // Collections, block scalars, anchors, aliases and tags are not plain scalars.
  if (/^[[{|>&*!]/.test(raw)) return null;
  // One space is enough to find the comment (the trim takes the rest); `\s+` here is quadratic on a long gap.
  const plain = raw.replace(/\s#.*$/, '').trim();
  return plain === '' ? null : plain;
}

/** `date` and `hamster_source` from the frontmatter, for matching a companion to its section. */
export function readCompanionKeys(text: string): { date: string | null; source: string | null } {
  const block = frontmatter(text);
  if (block === null) return { date: null, source: null };
  const date = scalar(block, 'date');
  // The property may have been retyped as a date-time; the day is what identifies the meeting.
  const day = date === null ? null : /^(\d{4}-\d{2}-\d{2})[T ]/.exec(date);
  return { date: day ? day[1] : date, source: scalar(block, 'hamster_source') };
}

/** The line ending the text uses: that of its first line, `\n` when it has none. */
function lineEnding(text: string): string {
  const first = text.indexOf('\n');
  return first > 0 && text.charCodeAt(first - 1) === 13 ? '\r\n' : '\n';
}

interface FrontmatterLine {
  /** Offset of the line's first character. */
  at: number;
  /** The line without its `\r`. */
  body: string;
}

/**
 * The lines of the frontmatter block, nested ones included, and where its
 * closing `---` starts. Null when there is no block: an opening `---` that
 * never closes is a rule, not frontmatter.
 */
function frontmatterLines(text: string): { lines: FrontmatterLine[]; close: number } | null {
  const lines: FrontmatterLine[] = [];
  let at = text.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;
  for (let n = 0; at <= text.length; n++) {
    const newline = text.indexOf('\n', at);
    const stop = newline < 0 ? text.length : newline;
    const raw = text.slice(at, stop);
    const body = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (n === 0) {
      if (body.trimEnd() !== '---') return null;
    } else if (body.trimEnd() === '---') {
      return { lines, close: at };
    } else {
      lines.push({ at, body });
    }
    if (newline < 0) break;
    at = newline + 1;
  }
  return null;
}

/** The index of the top-level line that holds `key`; -1 when there is none. */
function keyLine(lines: FrontmatterLine[], key: string): number {
  return lines.findIndex((line) => line.body.startsWith(`${key}:`));
}

function replaceLine(text: string, line: FrontmatterLine, body: string): string {
  return text.slice(0, line.at) + body + text.slice(line.at + line.body.length);
}

/** `text` with `line` added to its frontmatter, just above the closing `---`. */
function addFrontmatterLine(text: string, line: string, eol: string): string {
  const block = frontmatterLines(text);
  if (!block) return text;
  return text.slice(0, block.close) + line + eol + text.slice(block.close);
}

/**
 * `text` with the value of a top-level, one-line frontmatter key replaced.
 * Returned unchanged when there is no frontmatter, no such key, or a value
 * that spans several lines: nothing is added and nothing is reformatted.
 */
export function setFrontmatterValue(text: string, key: string, value: string): string {
  const block = frontmatterLines(text);
  if (!block) return text;
  const { lines } = block;
  const head = `${key}:`;
  const i = keyLine(lines, key);
  if (i < 0) return text;
  const line = lines[i];
  const current = line.body.slice(head.length).trim();
  const continued = i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1].body);
  if (current === '' || /^[|>[{&*!]/.test(current) || continued) return text;
  const next = `${head} ${value}`;
  return line.body === next ? text : replaceLine(text, line, next);
}

/** Tags typed as one string, `a, b` or `#a #b`: each without its `#`, none empty. */
export function splitTags(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((tag) => (tag.startsWith('#') ? tag.slice(1) : tag))
    .filter((tag) => tag !== '');
}

const MEETING_TAGS = ['meeting', 'magical-hamster'];

/** What a tag written in a list is called: without quotes and without a leading `#`. */
function tagName(item: string): string {
  const bare = /^(["']).*\1$/.test(item) ? item.slice(1, -1) : item;
  return bare.startsWith('#') ? bare.slice(1) : bare;
}

function missingTags(present: string[]): string[] {
  const names = new Set(present.map(tagName));
  return MEETING_TAGS.filter((tag) => !names.has(tag));
}

/**
 * The `tags` line, or lines, with `meeting` and `magical-hamster` among them.
 * A flow list keeps its items and gets the missing ones; a block list gets
 * them as items of its own, at the same indent; a string is read as tags
 * separated by commas or spaces and written back as a flow list. Anything
 * else (a map, a block scalar) is left alone.
 */
function withMeetingTags(text: string, eol: string): string {
  const block = frontmatterLines(text);
  if (!block) return text;
  const { lines } = block;
  const i = keyLine(lines, 'tags');
  if (i < 0) return addFrontmatterLine(text, `tags: [${MEETING_TAGS.join(', ')}]`, eol);
  const line = lines[i];
  const raw = line.body.slice('tags:'.length).trim();

  if (raw === '' || raw.startsWith('#')) {
    const items: Array<{ line: FrontmatterLine; indent: string; name: string }> = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const item = /^([ \t]*)-(?:[ \t]+(.*))?$/.exec(lines[j].body);
      if (!item) break;
      items.push({ line: lines[j], indent: item[1], name: (item[2] ?? '').trim() });
    }
    if (items.length > 0) {
      const missing = missingTags(items.map((item) => item.name));
      if (missing.length === 0) return text;
      const last = items[items.length - 1];
      const end = last.line.at + last.line.body.length;
      const added = missing.map((tag) => `${eol}${last.indent}- ${tag}`).join('');
      return text.slice(0, end) + added + text.slice(end);
    }
    /* No value at all: it is replaced when what follows is plainly another key
       or the closing line, and left alone when it could be a value of a kind
       not read here (a map, a comment ahead of the list). A comment on the
       line itself (`tags: #work` is one, to YAML) stays. */
    const after = j < lines.length ? lines[j].body : '---';
    if (!/^[^\s#-]/.test(after)) return text;
    return replaceLine(text, line, `tags: [${MEETING_TAGS.join(', ')}]${raw === '' ? '' : ` ${raw}`}`);
  }

  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close < 0) return text;
    const items = raw
      .slice(1, close)
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    const missing = missingTags(items);
    if (missing.length === 0) return text;
    return replaceLine(text, line, `tags: [${[...items, ...missing].join(', ')}]${raw.slice(close + 1)}`);
  }

  const value = scalarValue(raw);
  if (value === null) return text;
  const tags = splitTags(value);
  return replaceLine(text, line, `tags: [${[...tags.map(yamlValue), ...missingTags(tags)].join(', ')}]`);
}

/**
 * `text` with the properties of a meeting note: `type: meeting` when it has no
 * type, `date` and `hamster_source` as `meta` says, and the plugin's two tags
 * among its tags. Everything is done on the lines of the text: a present key
 * is changed on its own line, an absent one is added above the closing `---`,
 * and a note without frontmatter gets a block of these four; nothing else in
 * the block is reformatted. `date` is kept when it already names the day, as
 * a date or a date-time, and replaced otherwise: with `hamster_source` it is
 * how the next visit finds the note again, and a note the session cannot find
 * is worse than a changed property. Calling it again changes nothing.
 */
export function meetingFrontmatter(text: string, meta: { date: string; source: string }): string {
  const eol = lineEnding(text);
  const source = yamlString(meta.source);
  if (!frontmatterLines(text)) {
    const block = [
      '---',
      'type: meeting',
      `date: ${yamlDate(meta.date)}`,
      `tags: [${MEETING_TAGS.join(', ')}]`,
      `hamster_source: ${source}`,
      '---',
    ];
    const bom = text.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;
    return text.slice(0, bom) + block.join(eol) + eol + text.slice(bom);
  }
  let out = text;
  const has = (key: string): boolean => keyLine(frontmatterLines(out)?.lines ?? [], key) >= 0;
  if (!has('type')) out = addFrontmatterLine(out, 'type: meeting', eol);
  if (!has('date')) out = addFrontmatterLine(out, `date: ${yamlDate(meta.date)}`, eol);
  else if (readCompanionKeys(out).date !== meta.date) out = setFrontmatterValue(out, 'date', yamlDate(meta.date));
  out = withMeetingTags(out, eol);
  return has('hamster_source')
    ? setFrontmatterValue(out, 'hamster_source', source)
    : addFrontmatterLine(out, `hamster_source: ${source}`, eol);
}
