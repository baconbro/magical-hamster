import { normalizePath } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type { HamsterSettings, SectionKey } from '../types.ts';
import type { TextTarget } from './textTarget.ts';

export interface CompanionKey {
  /** YYYY-MM-DD */
  date: string;
  source: SectionKey;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const TOUCH_RETRY_MS = 3000;
/* The index follows vault and metadata events. Should one be missed, a wrong
   answer lasts this long at most. */
const INDEX_MAX_AGE_MS = 30_000;
const BYTE_ORDER_MARK = 0xfeff;

/** The calendar day of a frontmatter value, which YAML may hand over as a string, a number or a Date. */
export function dayOf(value: unknown): string | null {
  if (value instanceof Date) {
    // An unquoted YAML date is midnight UTC.
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const day = String(value).trim().slice(0, 10);
  return day === '' ? null : day;
}

/** The identity of a companion as its frontmatter states it, or null when it is not one. */
export function companionKeyOf(frontmatter: unknown): CompanionKey | null {
  if (typeof frontmatter !== 'object' || frontmatter === null) return null;
  const { date, hamster_source: source } = frontmatter as { date?: unknown; hamster_source?: unknown };
  const day = dayOf(date);
  if (day === null || typeof source !== 'string' || source === '') return null;
  return { date: day, source };
}

/**
 * `text` with the value of a top-level, one-line frontmatter key replaced.
 * Returned unchanged when there is no frontmatter, no such key, or a value
 * that spans several lines: nothing is added and nothing is reformatted.
 */
export function setFrontmatterValue(text: string, key: string, value: string): string {
  const start = text.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;
  const lines: Array<{ at: number; body: string }> = [];
  let at = start;
  let closed = false;
  for (let n = 0; at <= text.length; n++) {
    const newline = text.indexOf('\n', at);
    const stop = newline < 0 ? text.length : newline;
    const raw = text.slice(at, stop);
    const body = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (n === 0) {
      if (body.trimEnd() !== '---') return text;
    } else if (body.trimEnd() === '---') {
      closed = true;
      break;
    } else {
      lines.push({ at, body });
    }
    if (newline < 0) break;
    at = newline + 1;
  }
  // An opening `---` that never closes is a rule, not frontmatter.
  if (!closed) return text;

  const head = `${key}:`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.body.startsWith(head)) continue;
    const current = line.body.slice(head.length).trim();
    const continued = i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1].body);
    if (current === '' || /^[|>[{&*!]/.test(current) || continued) return text;
    const next = `${head} ${value}`;
    if (line.body === next) return text;
    return text.slice(0, line.at) + next + text.slice(line.at + line.body.length);
  }
  return text;
}

function indexId(date: string, source: SectionKey): string {
  return `${date}\n${source}`;
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/**
 * A note's name as a link to it is compared: without `.md`, and with one
 * spelling per accented letter, which is how Obsidian keeps its paths.
 */
function linkName(name: string): string {
  return name.replace(/\.md$/i, '').normalize('NFC');
}

/** Finds, creates and dates companion notes. Region writes go through the TextTarget. */
export class CompanionStore {
  private readonly app: App;
  private readonly settings: () => HamsterSettings;
  private readonly target: TextTarget;
  /* Companions created or found in this session. The metadata cache learns
     about a new file only after a while, and this is asked on every keystroke. */
  private readonly overlay = new Map<string, CompanionKey>();
  private index: Map<string, string> | null = null;
  private indexPrefix = '';
  private indexAt = 0;

  constructor(app: App, settings: () => HamsterSettings, target: TextTarget) {
    this.app = app;
    this.settings = settings;
    this.target = target;
  }

  /** True when a file or a folder already has this path. */
  exists(path: string): boolean {
    const { vault } = this.app;
    return (
      vault.getAbstractFileByPath(path) !== null ||
      vault.getAbstractFileByPath(normalizePath(path)) !== null
    );
  }

  /** The companion for a section of a day: frontmatter `hamster_source` and `date` match. */
  find(date: string, source: SectionKey): string | null {
    for (const [path, key] of this.overlay) {
      if (key.date !== date || key.source !== source) continue;
      if (this.app.vault.getFileByPath(path)) return path;
      this.overlay.delete(path);
    }
    const path = this.scan().get(indexId(date, source));
    if (path === undefined) return null;
    this.overlay.set(path, { date, source });
    return path;
  }

  /**
   * The note a link line points to. `basename` is the link's target without
   * folder or `.md`; `from` is the note that holds the link, which is how
   * Obsidian chooses between two notes of the same name. This is how a
   * companion is still found once its heading was renamed and the key in its
   * frontmatter no longer names the section.
   */
  findByBasename(basename: string, from: string): string | null {
    const target = basename.trim();
    const name = linkName(target);
    // An empty link path is, to Obsidian, the note the link is in.
    if (name === '') return null;
    /* This session's companions first: they are known here from the moment
       they are created or found, whatever the metadata cache has caught up
       with. A target that carries a folder matches none of them and is left
       to Obsidian. */
    for (const path of this.overlay.keys()) {
      if (linkName(basenameOf(path)) !== name) continue;
      if (this.app.vault.getFileByPath(path)) return path;
      this.overlay.delete(path);
    }
    const file = this.app.metadataCache.getFirstLinkpathDest(target, from);
    // A link can also lead to an image or a PDF, and a note is never its own companion.
    if (!file || file.extension !== 'md' || file.path === from) return null;
    return file.path;
  }

  /** One `vault.create` with the complete text. Creates the folder when missing. Rejects when the path exists. */
  async create(path: string, content: string, key: CompanionKey): Promise<void> {
    if (this.exists(path)) throw new Error(`A note already exists at ${path}.`);
    await this.ensureFolder(parentOf(normalizePath(path)));
    /* The whole note in one write: Templater rewrites a new file about 300 ms
       after it appears, and a second write of ours would race it. */
    const file = await this.app.vault.create(path, content);
    this.overlay.set(file?.path ?? normalizePath(path), { date: key.date, source: key.source });
    this.index = null;
  }

  read(path: string): Promise<string | null> {
    return this.target.read(path);
  }

  /** Sets `updated` in the frontmatter. Skipped while the note is open in an editor or was just edited. */
  async touch(path: string, isoDate: string): Promise<void> {
    if (!ISO_DAY.test(isoDate)) return;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        // The field is cosmetic: not worth a change in a note the user has in front of them.
        if (this.target.openEditor(path)) return;
        const result = await this.target.rewrite(path, (data) =>
          setFrontmatterValue(data, 'updated', isoDate),
        );
        if (result !== 'busy' || attempt > 0) return;
        await this.target.wait(TOUCH_RETRY_MS);
      }
    } catch (error) {
      console.error('Magical Hamster: could not date the companion note', error);
    }
  }

  /** A file was deleted. */
  forget(path: string): void {
    this.overlay.delete(path);
    this.index = null;
  }

  /** A file was renamed or moved. */
  renamed(oldPath: string, newPath: string): void {
    const key = this.overlay.get(oldPath);
    if (key) {
      this.overlay.delete(oldPath);
      this.overlay.set(newPath, key);
    }
    this.index = null;
  }

  /** A note was created or its metadata changed (`path`), or the metadata cache caught up (no argument). */
  refresh(path?: string): void {
    if (path === undefined) {
      this.index = null;
      return;
    }
    const known = this.overlay.has(path);
    // Every save of every note ends up here: only a possible companion is worth a new scan.
    if (!known && !basenameOf(path).startsWith(this.settings().companionPrefix)) return;
    this.index = null;
    if (!known) return;
    const file = this.app.vault.getFileByPath(path);
    const frontmatter = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    // No frontmatter in the cache yet says nothing; one without our keys does.
    if (frontmatter === undefined) return;
    const key = companionKeyOf(frontmatter);
    if (key) this.overlay.set(path, key);
    else this.overlay.delete(path);
  }

  /* Companions are filed away later, so they are looked for anywhere in the
     vault, by prefix. Walking every note is too slow to do per keystroke:
     the result is kept until something changes. */
  private scan(): Map<string, string> {
    const prefix = this.settings().companionPrefix;
    const now = Date.now();
    if (
      this.index &&
      this.indexPrefix === prefix &&
      now - this.indexAt >= 0 &&
      now - this.indexAt < INDEX_MAX_AGE_MS
    ) {
      return this.index;
    }
    const owners = new Map<string, TFile>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.basename.startsWith(prefix)) continue;
      const key = companionKeyOf(this.app.metadataCache.getFileCache(file)?.frontmatter);
      if (!key) continue;
      const id = indexId(key.date, key.source);
      const held = owners.get(id);
      // Two notes claiming one meeting (a duplicated file): the older one is the original.
      if (!held || isOlder(file, held)) owners.set(id, file);
    }
    const index = new Map<string, string>();
    for (const [id, file] of owners) index.set(id, file.path);
    this.index = index;
    this.indexPrefix = prefix;
    this.indexAt = now;
    return index;
  }

  private async ensureFolder(folder: string): Promise<void> {
    if (folder === '' || folder === '/') return;
    const { vault } = this.app;
    let path = '';
    for (const part of folder.split('/')) {
      path = path === '' ? part : `${path}/${part}`;
      if (vault.getFolderByPath(path)) continue;
      if (vault.getAbstractFileByPath(path)) throw new Error(`${path} is a file, not a folder.`);
      try {
        await vault.createFolder(path);
      } catch (error) {
        // Created by someone else in the meantime (sync, another plugin): that is fine.
        if (!vault.getFolderByPath(path)) throw error;
      }
    }
  }
}

function isOlder(a: TFile, b: TFile): boolean {
  if (a.stat.ctime !== b.stat.ctime) return a.stat.ctime < b.stat.ctime;
  return a.path < b.path;
}
