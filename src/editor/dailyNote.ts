import { moment, normalizePath } from 'obsidian';
import type { App } from 'obsidian';
import type { DailyInfo } from '../types.ts';
import { isoDate } from '../util/text.ts';

export const DEFAULT_DAILY_FORMAT = 'YYYY-MM-DD';

/* Obsidian's typings export Moment as a namespace, which is not callable under
   this project's module settings. At run time it is the usual function. */
const formatDate = (date: Date, format: string): string =>
  (moment as unknown as (date: Date) => { format(format: string): string })(date).format(format);

export interface DailyConfig {
  /** Vault folder of the daily notes. Empty when none is set: see `newNoteLocation`. */
  folder: string;
  /** A Moment.js format. It may contain folders: `YYYY/MM/YYYY-MM-DD`. */
  format: string;
  /**
   * What an empty folder means. True for the core plugin, which then creates
   * the daily where Obsidian puts any new note ("Default location for new
   * notes"). False for Periodic Notes, which uses the vault root.
   */
  newNoteLocation: boolean;
}

function segments(path: string): string[] {
  return path
    .split(/[/\\]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** The vault path and the basename of the daily note named `formattedName` (the date run through the format). */
export function dailyPathFor(folder: string, formattedName: string): { path: string; basename: string } {
  const name = segments(formattedName);
  const parts = [...segments(folder), ...name];
  // With folders in the format, the note's name is the last segment.
  return { path: `${parts.join('/')}.md`, basename: name.length > 0 ? name[name.length - 1] : '' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function configFrom(value: Record<string, unknown>, newNoteLocation: boolean): DailyConfig {
  return {
    folder: textOf(value.folder),
    format: textOf(value.format) || DEFAULT_DAILY_FORMAT,
    newNoteLocation,
  };
}

// The core plugin before anything was set in it: it has no config file until then.
const CORE_DEFAULTS: DailyConfig = { folder: '', format: DEFAULT_DAILY_FORMAT, newNoteLocation: true };

const CORE_DAILY_ID = 'daily-notes';

/**
 * Whether the core Daily notes plugin is switched on, from the parsed
 * `core-plugins.json`: a map of plugin id to on or off, or in older vaults the
 * list of the ids that are on. Anything else (no file yet, unreadable, no
 * entry for the plugin) counts as on, which is how Obsidian starts out.
 */
export function coreDailyEnabled(corePlugins: unknown): boolean {
  if (Array.isArray(corePlugins)) return corePlugins.includes(CORE_DAILY_ID);
  if (isRecord(corePlugins)) return corePlugins[CORE_DAILY_ID] !== false;
  return true;
}

/**
 * Where the daily notes are, from the two places that can say so: the core
 * Daily notes plugin (`daily-notes.json`) first, then Periodic Notes
 * (`data.json`, its `daily` entry, unless switched off). Either argument is the
 * parsed file, or null when it is missing or unreadable.
 *
 * `coreEnabled` false turns the order around. Obsidian keeps `daily-notes.json`
 * after the core plugin is switched off, so the file alone does not say who
 * creates the notes: Periodic Notes is then asked first, and the leftover file
 * only stands in when Periodic Notes has nothing to say.
 */
export function pickDailyConfig(core: unknown, periodic: unknown, coreEnabled = true): DailyConfig {
  const fromPeriodic =
    isRecord(periodic) && isRecord(periodic.daily) && periodic.daily.enabled !== false
      ? configFrom(periodic.daily, false)
      : null;
  if (!coreEnabled && fromPeriodic) return fromPeriodic;
  if (isRecord(core)) return configFrom(core, true);
  return fromPeriodic ?? { ...CORE_DEFAULTS };
}

/** Knows where today's daily note is. The plugin never creates it. */
export class DailyNoteLocator {
  private readonly app: App;
  private config: DailyConfig = { ...CORE_DEFAULTS };

  constructor(app: App) {
    this.app = app;
  }

  /** The three files whose change means `load()` has to run again. */
  configPaths(): string[] {
    const dir = this.app.vault.configDir;
    return [
      normalizePath(`${dir}/daily-notes.json`),
      normalizePath(`${dir}/plugins/periodic-notes/data.json`),
      normalizePath(`${dir}/core-plugins.json`),
    ];
  }

  /**
   * Reads the daily-notes config: the core plugin first when it is switched
   * on, Periodic Notes first when it is not. Call at load and when one of the
   * config files changes.
   */
  async load(): Promise<void> {
    const [corePath, periodicPath, corePluginsPath] = this.configPaths();
    const coreEnabled = coreDailyEnabled(await this.readJson(corePluginsPath));
    const core = await this.readJson(corePath);
    const periodic = coreEnabled && isRecord(core) ? null : await this.readJson(periodicPath);
    this.config = pickDailyConfig(core, periodic, coreEnabled);
  }

  today(now: Date = new Date()): DailyInfo {
    let name: string;
    try {
      name = formatDate(now, this.config.format);
    } catch {
      name = '';
    }
    // A format that produces nothing usable falls back to the plain date.
    if (segments(name).length === 0) name = isoDate(now);
    const { folder, newNoteLocation } = this.config;
    // Normalized as Obsidian stores paths, or the lookup below could miss an existing note.
    const path = normalizePath(
      dailyPathFor(folder === '' && newNoteLocation ? this.newNoteFolder() : folder, name).path,
    );
    return {
      path,
      basename: path.slice(path.lastIndexOf('/') + 1, -'.md'.length),
      // Always the local calendar day, whatever the note is called.
      date: isoDate(now),
      exists: this.app.vault.getFileByPath(path) !== null,
    };
  }

  /* Asked each time rather than kept: the setting can change, and nothing announces it. */
  private newNoteFolder(): string {
    try {
      // With no file given, "Same folder as current file" is the vault root, as it is for the core plugin.
      return this.app.fileManager.getNewFileParent('').path;
    } catch {
      return '';
    }
  }

  private async readJson(path: string): Promise<unknown> {
    try {
      const { adapter } = this.app.vault;
      if (!(await adapter.exists(path))) return null;
      return JSON.parse(await adapter.read(path)) as unknown;
    } catch {
      // Missing, half-written or hand-edited into something else: as if it were not there.
      return null;
    }
  }
}
