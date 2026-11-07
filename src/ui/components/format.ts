import type {
  ChatUsage,
  EnhancedItem,
  FirstWritePreview,
  MeetingListEntry,
  SectionKey,
  SourceDoc,
  Stats,
  Turn,
  VaultIndexStatus,
} from '../../types.ts';
import { clock } from '../../util/text.ts';
import { taskMark } from '../../util/tasks.ts';

/* Pure formatting and derivation for the sidebar. No React and no DOM, so the
   same functions run under `node --test`. */

const NUMBER = new Intl.NumberFormat('en-US');
const LONG_DATE = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

const DAY_MS = 86_400_000;

/** Milliseconds to "mm:ss" (or "h:mm:ss" past an hour). */
export function timer(ms: number): string {
  return clock(ms / 1000);
}

/** 6412 -> "6,412". */
export function int(n: number): string {
  return NUMBER.format(Math.round(n));
}

/** 1234567 -> "1.2M", 45210 -> "45k", 812 -> "812". For labels with no room. */
export function compact(n: number): string {
  const v = Math.round(n);
  /* 999,500 and up would round to "1000k". */
  if (v >= 999_500) return `${trimZero((v / 1_000_000).toFixed(1))}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${trimZero((v / 1000).toFixed(1))}k`;
  return String(v);
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

export function dollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** What the same tokens would have cost at `costPer1k` dollars per 1,000. */
export function savedDollars(stats: Pick<Stats, 'input' | 'output'>, costPer1k: number): number {
  return ((stats.input + stats.output) / 1000) * costPer1k;
}

/* Calendar dates are handled as UTC midnights: a YYYY-MM-DD string names a
   day, not an instant, and local-time arithmetic drifts across DST changes. */
function parseIso(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : t;
}

function toIso(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** "2026-10-09" -> "Friday, October 9". An unparseable value is returned as is. */
export function longDate(iso: string): string {
  const t = parseIso(iso);
  return t === null ? iso : LONG_DATE.format(t);
}

/** The Monday of the ISO week that contains `iso`, as YYYY-MM-DD. */
export function mondayOf(iso: string): string | null {
  const t = parseIso(iso);
  if (t === null) return null;
  const sinceMonday = (new Date(t).getUTCDay() + 6) % 7;
  return toIso(t - sinceMonday * DAY_MS);
}

export interface WeekPoint {
  /** Monday of the week, YYYY-MM-DD. */
  key: string;
  /** Day of the month of that Monday: "5". */
  day: string;
  /** Short month of that Monday: "Oct". */
  month: string;
  input: number;
  output: number;
  total: number;
}

/** The last `weeks` ISO weeks ending with the week of `todayIso`, oldest first, missing weeks as zero. */
export function weeklySeries(
  weekly: Stats['weekly'],
  todayIso: string,
  weeks = 8,
): WeekPoint[] {
  const monday = mondayOf(todayIso);
  if (monday === null) return [];
  const last = parseIso(monday) as number;
  const out: WeekPoint[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const t = last - i * 7 * DAY_MS;
    const key = toIso(t);
    const w = weekly[key];
    const input = w?.input ?? 0;
    const output = w?.output ?? 0;
    out.push({
      key,
      day: String(new Date(t).getUTCDate()),
      month: MONTH.format(t),
      input,
      output,
      total: input + output,
    });
  }
  return out;
}

export function sectionKey(title: string, ordinal: number): SectionKey {
  return `${title}#${ordinal}`;
}

/** A topic line without its heading marks, whichever layer left them in. */
export function topicText(text: string): string {
  return text.replace(/^\s*#{1,6}\s+/, '').trim();
}

/** One enhanced bullet as a Markdown list item. Continuation lines are indented so they stay in the item. */
export function bulletMarkdown(bullet: string): string {
  return `- ${bullet.trim().replace(/\n/g, '\n  ')}`;
}

/**
 * The enhanced notes as Markdown: topics as headings, bullets as `- ` lines. Lines not enhanced yet
 * are left out. A task's bullet is marked with a sign, not a checkbox: a paste must not add a
 * second copy of the task to the vault's task lists.
 */
export function enhancedToMarkdown(items: EnhancedItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === 'topic') {
      if (lines.length > 0) lines.push('');
      lines.push(`#### ${topicText(item.source)}`);
    } else if (item.bullet !== null && item.bullet.trim() !== '') {
      lines.push(bulletMarkdown(`${taskMark(item.task, false)}${item.bullet}`));
    }
  }
  /* A trailing topic with nothing under it yet is noise in a paste. */
  const dangling = (line: string | undefined) => line !== undefined && (line === '' || line.startsWith('#### '));
  while (dangling(lines[lines.length - 1])) lines.pop();
  return lines.join('\n');
}

/** The transcript as plain text, one `[mm:ss] Label: text` line per turn. */
export function transcriptToText(turns: Turn[], micLabel: string): string {
  return turns
    .map((t) => `[${clock(t.t0)}] ${t.source === 'mic' ? micLabel : 'Others'}: ${t.text}`)
    .join('\n');
}

/** What a source chip shows after its number: the note and heading, or the transcript time. */
export function sourceLabel(src: SourceDoc): string {
  if (src.kind === 'transcript') return src.time ? `${src.title} ${src.time}` : src.title;
  return src.heading ? `${src.title} > ${src.heading}` : src.title;
}

export interface UsageFigures {
  /** Share of the prompt served from cache, 0..1. */
  cachedShare: number;
  /** Null when the model reported no generation time. */
  tokensPerSecond: number | null;
  seconds: number;
}

export function usageFigures(u: ChatUsage): UsageFigures {
  return {
    cachedShare: u.promptTokens > 0 ? Math.min(1, u.cachedTokens / u.promptTokens) : 0,
    tokensPerSecond: u.evalMs > 0 ? u.outputTokens / (u.evalMs / 1000) : null,
    seconds: u.totalMs / 1000,
  };
}

/* ───────────────────────── The index: its folders ───────────────────────── */

/** How the index and the settings field spell "every note in the vault". An empty string means the same. */
export const WHOLE_VAULT = '/';

function isWholeVault(folder: string): boolean {
  return folder === WHOLE_VAULT || folder === '';
}

/** A folder as the reader sees it: the whole vault has no name of its own. */
export function folderLabel(folder: string): string {
  return isWholeVault(folder) ? 'Whole vault' : folder;
}

/** True when a selected folder already contains `path`. The whole vault contains every folder. */
export function coveredByAncestor(path: string, selected: ReadonlySet<string>): boolean {
  if (isWholeVault(path)) return false;
  if (selected.has(WHOLE_VAULT) || selected.has('')) return true;
  let cut = path.lastIndexOf('/');
  while (cut > 0) {
    if (selected.has(path.slice(0, cut))) return true;
    cut = path.lastIndexOf('/', cut - 1);
  }
  return false;
}

/** The selection without folders that a selected parent already includes, in the picker's order. */
export function minimalFolders(selected: ReadonlySet<string>, order: string[]): string[] {
  if (selected.has(WHOLE_VAULT) || selected.has('')) return [WHOLE_VAULT];
  const known = new Set(order);
  const extra = [...selected].filter((f) => !known.has(f));
  return [...order, ...extra].filter((f) => selected.has(f) && !coveredByAncestor(f, selected));
}

export interface FolderRow {
  /** The folder as the index and the selection know it. */
  path: string;
  /** What the row shows: the part of the path that the row it sits under does not already say. */
  label: string;
  /** Steps of indentation; 0 for a row that sits under no other. */
  depth: number;
}

/** The closest folder among `paths` that contains `path`, or null. */
function parentRow(path: string, paths: readonly string[]): string | null {
  let cut = path.lastIndexOf('/');
  while (cut > 0) {
    const parent = path.slice(0, cut);
    if (paths.includes(parent)) return parent;
    cut = path.lastIndexOf('/', cut - 1);
  }
  return null;
}

/**
 * The rows of the folder picker: the folders the host lists (two levels of the vault), and every
 * indexed folder it does not list. The settings field accepts the whole vault, a folder three
 * levels down, or one that has since been renamed: without a row of its own such a folder stays
 * selected, out of sight, and is indexed again at every build with no way to untick it.
 */
export function folderRows(listed: readonly string[], indexed: readonly string[]): FolderRow[] {
  const paths: string[] = [];
  for (const folder of listed) {
    if (!isWholeVault(folder) && !paths.includes(folder)) paths.push(folder);
  }
  let whole = false;
  for (const folder of indexed) {
    if (isWholeVault(folder)) {
      whole = true;
      continue;
    }
    if (paths.includes(folder)) continue;
    const parent = parentRow(folder, paths);
    if (parent === null) {
      paths.push(folder);
      continue;
    }
    // Under the folder that contains it, after the rows already there.
    let at = paths.indexOf(parent) + 1;
    while (at < paths.length && paths[at]?.startsWith(`${parent}/`)) at += 1;
    paths.splice(at, 0, folder);
  }

  const depths = new Map<string, number>();
  const depthOf = (path: string): number => {
    const known = depths.get(path);
    if (known !== undefined) return known;
    const parent = parentRow(path, paths);
    const depth = parent === null ? 0 : depthOf(parent) + 1;
    depths.set(path, depth);
    return depth;
  };
  const rows = paths.map((path): FolderRow => {
    const parent = parentRow(path, paths);
    return { path, label: parent === null ? path : path.slice(parent.length + 1), depth: depthOf(path) };
  });
  return whole ? [{ path: WHOLE_VAULT, label: folderLabel(WHOLE_VAULT), depth: 0 }, ...rows] : rows;
}

/** The folder picker while it is open: its rows, what is ticked, and the list it was opened from. */
export interface PickerState {
  /** The folders the session published when the picker was opened: what its ticks started from. */
  from: readonly string[];
  rows: FolderRow[];
  selected: ReadonlySet<string>;
}

/** The picker as it opens over the folders the session publishes: each has a row, and is ticked. */
export function openPicker(listed: readonly string[], folders: readonly string[]): PickerState {
  return {
    from: [...folders],
    rows: folderRows(listed, folders),
    // An empty name is the whole vault too; the row that unticks it is the one for `/`.
    selected: new Set(folders.map((folder) => (folder === '' ? WHOLE_VAULT : folder))),
  };
}

/** The picker after a click on a row: ticked when it was not, unticked when it was. */
export function toggleFolder(picker: PickerState, folder: string): PickerState {
  const selected = new Set(picker.selected);
  if (selected.has(folder)) selected.delete(folder);
  else selected.add(folder);
  return { ...picker, selected };
}

/**
 * True when the folders the session publishes are no longer the list the picker was opened from:
 * the list was changed in the settings while the picker stayed open (it is kept for as long as
 * the sidebar is, whatever tab is shown). Its ticks are then those of a list that no longer
 * stands, and the button under "Rebuild the index to apply" would save them over the new one. The
 * Ask tab closes such a picker, so that the button builds the list of the settings.
 */
export function pickerOutdated(picker: PickerState, folders: readonly string[]): boolean {
  return picker.from.length !== folders.length || picker.from.some((folder, i) => folder !== folders[i]);
}

/** What the build button builds: the ticks of the open picker, else the folders the session publishes. */
export function foldersToBuild(picker: PickerState | null, folders: string[]): string[] {
  if (picker === null) return folders;
  return minimalFolders(
    picker.selected,
    picker.rows.map((row) => row.path),
  );
}

/* ───────────────────────── The index: its status ────────────────────────── */

/** The one line that says where the index stands. */
export function indexSummary(index: VaultIndexStatus): string {
  switch (index.status) {
    case 'none':
      return 'Not indexed yet';
    case 'building':
      return `Indexing ${int(index.done)} of ${int(index.total)} notes`;
    case 'ready':
      return `Indexed ${int(index.files)} notes, ${int(index.chunks)} passages`;
    case 'paused':
      // Only a recording pauses a build, and the session takes it up again by itself.
      return `Paused during the recording at ${int(index.done)} of ${int(index.total)} notes. It continues when the recording stops.`;
    case 'error':
      return index.error ?? 'The index could not be built.';
  }
}

/**
 * The label of the button that starts a build, or null when none can be started: while one runs,
 * and while a recording has paused one. The session refuses a build during a recording, so a
 * "Resume" button there could only raise a notice.
 */
export function indexBuildLabel(status: VaultIndexStatus['status']): string | null {
  if (status === 'building' || status === 'paused') return null;
  return status === 'ready' ? 'Rebuild index' : 'Build index';
}

/**
 * A problem the index reported while staying usable: a note that could not be embedded, an index
 * that could not be saved. Null when there is none, and for the status `error`, whose summary
 * line already is the error.
 */
export function indexProblem(index: VaultIndexStatus): string | null {
  if (index.status === 'error') return null;
  const error = index.error?.trim() ?? '';
  return error === '' ? null : error;
}

/** The tooltip of a build button that cannot be pressed: there is nothing to build over. */
export const INDEX_NEEDS_FOLDER_TEXT = 'Choose at least one folder first';

/** Why the build button is disabled, or null when it can be pressed: a build needs a folder. */
export function indexBuildBlocked(chosen: readonly string[]): string | null {
  return chosen.length === 0 ? INDEX_NEEDS_FOLDER_TEXT : null;
}

/** What the Ask tab says while the index was built over another list of folders than the settings hold. */
export const INDEX_FOLDERS_PENDING_TEXT = 'Folders changed in settings. Rebuild the index to apply.';

/**
 * What it says instead when the list was emptied in the settings: an index over the folders of
 * its last build is still there, the session answers from none of its notes, and "Rebuild" has
 * nothing to build over until a folder is ticked.
 */
export const INDEX_NO_FOLDERS_TEXT =
  'No folder is chosen. Answers use no indexed notes until you choose folders and rebuild the index.';

/**
 * One of those lines, or null: when the session reports no such difference, and while no build
 * can be started (one is running, or a recording has paused it), when the line could only point
 * at a button that is not there.
 */
export function indexFoldersNote(index: VaultIndexStatus): string | null {
  if (index.foldersPending !== true) return null;
  if (indexBuildLabel(index.status) === null) return null;
  return index.folders.length === 0 ? INDEX_NO_FOLDERS_TEXT : INDEX_FOLDERS_PENDING_TEXT;
}

/* ───────────────────────────── The meetings ─────────────────────────────── */

/**
 * True for the row of a meeting started on its own ("New meeting"): it has a note and no section
 * of the daily. Told by the line it has not got, not by its `manual:` key: a heading can be
 * titled "manual: ..." and its key then starts the same way.
 */
export function isManualEntry(entry: Pick<MeetingListEntry, 'anchorLine'>): boolean {
  return entry.anchorLine < 0;
}

export interface MeetingsView {
  /** The rows of the list, in the session's order: the meetings of the daily, then those started on their own. */
  rows: MeetingListEntry[];
  /** The other sections of the daily, offered folded. */
  others: MeetingListEntry[];
  /** What to say besides the list: the daily is missing, or there is no meeting of any kind yet. */
  empty: 'no-daily' | 'no-meetings' | null;
}

/**
 * What the Meetings tab lists. A meeting started on its own lives in its note, not in the daily:
 * it is listed whether or not today's daily exists, next to the sentence that says the daily is
 * missing. Sections are listed only for a daily that exists.
 */
export function meetingsView(sections: readonly MeetingListEntry[], dailyExists: boolean): MeetingsView {
  const rows = sections.filter((entry) => entry.group === 'meeting' && (dailyExists || isManualEntry(entry)));
  const others = dailyExists ? sections.filter((entry) => entry.group === 'other' && !isManualEntry(entry)) : [];
  const empty = !dailyExists ? 'no-daily' : rows.length === 0 ? 'no-meetings' : null;
  return { rows, others, empty };
}

/* ─────────────────────── What the sidebar promises ──────────────────────── */

/* Where answers come from. The session also reads the notes wikilinked in the meeting's section
   of the daily note, in its heading and in any line under it, wherever they are in the vault, so
   neither sentence may say that only the chosen folders are used, or that only the heading counts. */
export const ANSWER_SOURCES_TEXT =
  'Ask a question below. Answers come from this meeting, the notes linked in its section, and the notes you indexed.';
export const INDEX_SCOPE_TEXT =
  'Besides this meeting and the notes linked in its section, answers only use the folders you choose. The index stays on this computer.';

/**
 * What "Create companion note" is about to write. A meeting tied to a section of the daily, or
 * typed in a note of its own, gets a link line there: one started with New meeting gets the note alone.
 */
export function createCompanionHint(folder: string, manual: boolean, noteName: string | null = null): string {
  const where = folder || 'the vault root';
  if (manual) {
    return `Creates one note in ${where}. This meeting is not tied to your notes yet, so no line is added anywhere. Nothing is written before this.`;
  }
  const into = noteName ? `“${noteName}”` : 'your daily note';
  return `Creates one note in ${where} and adds one link line to ${into}. Nothing is written before this.`;
}

/** The text of the confirmation shown before the plugin's first write, for the dialog in Obsidian and the harness's. */
export function confirmWriteText(preview: FirstWritePreview): {
  title: string;
  intro: string;
  rows: Array<{ label: string; value: string; code: boolean }>;
  button: string;
} {
  if (preview.intoNote) {
    return {
      title: 'Write the meeting into this note?',
      intro: 'Magical Hamster will add its sections to this note. Your own text does not change, and nothing else in your vault is changed.',
      rows: [
        { label: 'Note', value: preview.companionPath, code: true },
        { label: 'Added', value: preview.where, code: false },
      ],
      button: 'Write into it',
    };
  }
  const linked = preview.linkLine.trim() !== '';
  const lineNote = preview.lineNote ? `“${preview.lineNote}”` : 'your daily note';
  return {
    title: 'Create the companion note?',
    intro: linked
      ? `Magical Hamster will create one note and add one line to ${lineNote}. Nothing else in your vault is changed.`
      : 'Magical Hamster will create one note. Nothing else in your vault is changed.',
    rows: linked
      ? [
          { label: 'New note', value: preview.companionPath, code: true },
          { label: preview.lineNote ? 'Line added to your note' : 'Line added to the daily note', value: preview.linkLine, code: true },
          { label: 'Where', value: preview.where, code: false },
        ]
      : [
          { label: 'New note', value: preview.companionPath, code: true },
          { label: 'Your notes', value: preview.where, code: false },
        ],
    button: 'Create',
  };
}

/* The microphone meter's thresholds, in dBFS of the last block's peak: a scale in decibels, as a
   sound meter reads, where a linear one leaves ordinary speech on the first bar. Speech said
   close to the microphone peaks around -12; a laptop microphone across a table, around -30. The
   speech worker raises quiet speech by up to 30 dB, so even one bar is usually heard. */
const LEVEL_BAR_DB = [-54, -44, -34, -24, -14];

/** How many of the meter's bars a peak (0..1) lights. */
export function levelBars(peak: number): number {
  if (!(peak > 0)) return 0;
  const db = 20 * Math.log10(Math.min(1, peak));
  return LEVEL_BAR_DB.filter((threshold) => db >= threshold).length;
}
