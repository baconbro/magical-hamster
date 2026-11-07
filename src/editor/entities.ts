import type { Entity, EntityKind } from '../types.ts';
import { collapseWhitespace } from '../util/text.ts';
import { findWholeWord, stripWikilinks, wikilinks } from './sectionAt.ts';

/* A 1:1 or an ad hoc chat is about people; anything else is about a project or a body. */
const PERSONAL_MEETING = /^(?:prep\s+)?(?:1:1|ad ?hoc)\b/i;
const DELIMITER_CELL = /^:?-+:?$/;
const PLACEHOLDER = /^[-–—]*$/;

interface Columns {
  name: number;
  link: number;
  aliases: number;
  active: number;
}

function norm(text: string): string {
  return collapseWhitespace(text).toLowerCase();
}

function lastSegment(target: string): string {
  const slash = target.lastIndexOf('/');
  return slash < 0 ? target : target.slice(slash + 1);
}

function kindOf(heading: string): EntityKind {
  const text = heading.trim().toLowerCase();
  if (text.startsWith('projects')) return 'project';
  if (text.startsWith('people')) return 'person';
  if (text.startsWith('governance')) return 'governance';
  return 'other';
}

/** Cells of a table row. A pipe inside `[[target|alias]]` or written `\|` does not split. */
function splitRow(row: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let depth = 0;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    const next = row[i + 1];
    if (ch === '\\' && next === '|') {
      cell += '|';
      i += 1;
    } else if (ch === '[' && next === '[') {
      depth += 1;
      cell += '[[';
      i += 1;
    } else if (ch === ']' && next === ']') {
      if (depth > 0) depth -= 1;
      cell += ']]';
      i += 1;
    } else if (ch === '|' && depth === 0) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  // The outer pipes produce an empty first and last cell.
  if (cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function plain(cell: string): string {
  const text = collapseWhitespace(stripWikilinks(cell.replace(/`/g, '')));
  return PLACEHOLDER.test(text) ? '' : text;
}

function linkTarget(cell: string): string {
  const text = cell.replace(/`/g, '');
  const targets = wikilinks(text);
  return targets.length > 0 ? collapseWhitespace(targets[0]) : plain(text);
}

function readHeader(cells: string[]): Columns | null {
  const labels = cells.map((cell) => cell.replace(/[`*_]/g, '').trim().toLowerCase());
  const column = (...wanted: string[]): number => labels.findIndex((label) => wanted.includes(label));
  const columns: Columns = {
    name: column('canonical', 'name'),
    link: column('wikilink', 'link'),
    aliases: column('aliases', 'alias'),
    active: column('active'),
  };
  return columns.name < 0 && columns.link < 0 ? null : columns;
}

function toEntity(cells: string[], columns: Columns, kind: EntityKind): Entity | null {
  const cell = (index: number): string => (index >= 0 && index < cells.length ? cells[index] : '');
  const target = linkTarget(cell(columns.link));
  const name = plain(cell(columns.name)) || lastSegment(target);
  if (name === '') return null;

  const aliases: string[] = [];
  for (const part of cell(columns.aliases).split(/[,;]/)) {
    const alias = plain(part);
    if (alias !== '' && !aliases.includes(alias)) aliases.push(alias);
  }
  return {
    name,
    link: target || name,
    aliases,
    kind,
    // A registry without the column lists only what is in use.
    active: columns.active < 0 ? true : /^(?:y|yes|true)$/i.test(plain(cell(columns.active))),
  };
}

/**
 * Reads the registry note: `## ` sections, one table per section, columns
 * located by header name (`canonical`, `wikilink`, `aliases`, `active`).
 */
export function parseEntities(markdown: string): Entity[] {
  const entities: Entity[] = [];
  let kind: EntityKind = 'other';
  let columns: Columns | null = null;
  /* The last header of this section: a table split by a blank line has no header of its own. */
  let sectionColumns: Columns | null = null;
  let inTable = false;
  let fence = '';
  /* The line of a first row read with the header of the table above it, and
     how many entities there were before it. */
  let borrowedLine = -1;
  let borrowedCount = 0;

  const rawLines = markdown.split('\n');
  for (let lineNumber = 0; lineNumber < rawLines.length; lineNumber++) {
    const line = rawLines[lineNumber].trim();

    const fenceRun = /^(`{3,}|~{3,})/.exec(line);
    if (fence !== '') {
      if (
        fenceRun &&
        fenceRun[1][0] === fence[0] &&
        fenceRun[1].length >= fence.length &&
        line.slice(fenceRun[1].length).trim() === ''
      ) {
        fence = '';
      }
      continue;
    }
    if (fenceRun) {
      fence = fenceRun[1];
      inTable = false;
      continue;
    }

    const heading = /^(#{1,6})[ \t]+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      // A `###` under `## People` still lists people.
      if (level === 2) kind = kindOf(heading[2]);
      else if (level === 1) kind = 'other';
      columns = null;
      sectionColumns = null;
      inTable = false;
      continue;
    }

    if (line.charCodeAt(0) !== 124) {
      inTable = false;
      continue;
    }
    const cells = splitRow(line);
    if (cells.length === 0) continue;
    if (cells.every((cell) => DELIMITER_CELL.test(cell))) {
      /* A delimiter right under that first row makes it a header: this is
         another table, with columns of its own, not the rest of the one above. */
      if (borrowedLine === lineNumber - 1) {
        entities.length = borrowedCount;
        columns = null;
      }
      continue;
    }

    if (!inTable) {
      inTable = true;
      const header = readHeader(cells);
      if (header) {
        columns = header;
        sectionColumns = header;
        continue;
      }
      columns = sectionColumns;
      borrowedLine = lineNumber;
      borrowedCount = entities.length;
    }
    if (!columns) continue;
    const entity = toEntity(cells, columns, kind);
    if (entity) entities.push(entity);
  }
  return entities;
}

/** Lowercased names, links and aliases of active entities, length >= 2, deduped. */
export function entityNames(entities: Entity[]): string[] {
  const names = new Set<string>();
  for (const entity of entities) {
    if (!entity.active) continue;
    // A link written with its folder is typed without it in a heading.
    for (const raw of [entity.name, entity.link, lastSegment(entity.link), ...entity.aliases]) {
      const name = norm(raw);
      if (name.length >= 2) names.add(name);
    }
  }
  return [...names];
}

function lookup(entities: Entity[], wanted: string): Entity | null {
  let best: Entity | null = null;
  let bestRank = 4;
  for (const entity of entities) {
    let rank: number;
    if (
      norm(entity.name) === wanted ||
      norm(entity.link) === wanted ||
      norm(lastSegment(entity.link)) === wanted
    ) {
      rank = 0;
    } else if (entity.aliases.some((alias) => norm(alias) === wanted)) {
      rank = 2;
    } else {
      continue;
    }
    // "Sam" as the name of one person beats "Sam" as the alias of another; active beats retired.
    if (!entity.active) rank += 1;
    if (rank < bestRank) {
      best = entity;
      bestRank = rank;
      if (rank === 0) break;
    }
  }
  return best;
}

/** Case-insensitive on name, link and aliases. Accepts `[[Target|alias]]` and `folder/Target`. */
export function findEntity(entities: Entity[], name: string): Entity | null {
  const text = name.indexOf('[[') >= 0 ? (wikilinks(name)[0] ?? stripWikilinks(name)) : name;
  const wanted = norm(text);
  if (wanted === '') return null;
  const exact = lookup(entities, wanted);
  if (exact) return exact;
  const leaf = norm(lastSegment(text));
  return leaf !== '' && leaf !== wanted ? lookup(entities, leaf) : null;
}

/** The names typed after `1:1` or `Ad Hoc`: "1:1 Maya et Tim - budget" -> Maya, Tim. */
function namesAfterMarker(title: string): string[] {
  const marker = PERSONAL_MEETING.exec(title);
  if (!marker) return [];
  let rest = title.slice(marker[0].length).replace(/^[\s\-–—:]+/, '');
  rest = rest.replace(/^(?:with|avec|w\/)\s+/i, '');
  // The names come first; a dash, a colon or a parenthesis starts the topic.
  rest = rest.split(/\s[-–—]\s|[:(]/)[0];
  return rest
    .split(/,|\s+et\s+|\s+and\s+/i)
    .map((part) => part.trim().replace(/[.;!?]+$/, '').trim())
    .filter((part) => part !== '');
}

/** Active entities named as whole words in the title, left to right; the longest name wins an overlap. */
function mentioned(title: string, entities: Entity[]): Entity[] {
  const hay = title.toLowerCase();
  const hits: Array<{ at: number; length: number; entity: Entity }> = [];
  for (const entity of entities) {
    if (!entity.active) continue;
    for (const raw of [entity.name, entity.link, lastSegment(entity.link), ...entity.aliases]) {
      const name = norm(raw);
      if (name.length < 2) continue;
      for (let at = findWholeWord(hay, name); at >= 0; at = findWholeWord(hay, name, at + name.length)) {
        hits.push({ at, length: name.length, entity });
      }
    }
  }
  hits.sort((a, b) => a.at - b.at || b.length - a.length);
  const found: Entity[] = [];
  let covered = 0;
  for (const hit of hits) {
    if (hit.at < covered) continue;
    covered = hit.at + hit.length;
    if (!found.includes(hit.entity)) found.push(hit.entity);
  }
  return found;
}

/**
 * Sorts the names of a meeting anchor into attendees and projects for the
 * companion's frontmatter. People go to `attendees` under their canonical
 * name; projects and governance bodies go to `projects` under their link.
 */
export function classifyHeading(
  rawTitle: string,
  links: string[],
  entities: Entity[],
): { attendees: string[]; projects: string[] } {
  const title = collapseWhitespace(stripWikilinks(rawTitle));
  const personal = PERSONAL_MEETING.test(title);
  const attendees: string[] = [];
  const projects: string[] = [];
  const add = (list: string[], value: string): void => {
    if (value !== '' && !list.includes(value)) list.push(value);
  };
  const place = (entity: Entity): void => {
    if (entity.kind === 'person') add(attendees, entity.name);
    else if (entity.kind !== 'other') add(projects, entity.link);
  };
  const placeName = (candidate: string): void => {
    const entity = findEntity(entities, candidate);
    if (entity) place(entity);
    else add(personal ? attendees : projects, collapseWhitespace(lastSegment(stripWikilinks(candidate))));
  };
  /* Typed text has no folders: read as a path, "Maya/Tim" would lose Maya.
     It can still hold the brackets of a link that is not closed yet. */
  const placeTyped = (candidate: string): void => {
    const name = collapseWhitespace(candidate.replace(/[[\]]/g, ' '));
    const entity = lookup(entities, name.toLowerCase());
    if (entity) place(entity);
    else add(attendees, name);
  };

  if (links.length > 0) links.forEach(placeName);
  else if (personal) namesAfterMarker(title).forEach(placeTyped);
  else mentioned(title, entities).forEach(place);
  return { attendees, projects };
}
