import type {
  ChatUsage,
  DailyInfo,
  DailyUpdate,
  Embedder,
  EnhancedItem,
  EnhanceStatus,
  EnhanceStyle,
  Entity,
  Excerpt,
  HamsterController,
  HamsterSession,
  HamsterSettings,
  HamsterState,
  MeetingListEntry,
  MeetingState,
  Patch,
  QaEntry,
  Region,
  QuestionChip,
  Section,
  SectionItem,
  SectionKey,
  SessionDeps,
  SourceDoc,
  SttEvent,
  SttSegment,
  SttState,
  SummaryStyle,
  TabId,
  TranscriptSource,
  Turn,
  VaultChunk,
  VaultIndexStatus,
  WriteOutcome,
} from '../types.ts';
import { classifyHeading, entityNames } from '../editor/entities.ts';
import {
  findSection,
  isLinkLine,
  listSections,
  parseSectionKey,
  sectionAt,
  sectionKey,
  wholeNoteSection,
  wikilinks,
} from '../editor/sectionAt.ts';
import type { SectionOptions } from '../editor/sectionAt.ts';
import { EnhanceEngine, cleanBullet } from '../llm/enhance.ts';
import type { EnhanceEngineDeps } from '../llm/enhance.ts';
import { modelInstalled } from '../llm/ollama.ts';
import { answerQuestion, buildSources, citedSources, formatInsight, lastSentence, qaSourceBudget, questionsIn } from '../llm/qa.ts';
import { LlmQueue } from '../llm/queue.ts';
import { summarize as writeSummary } from '../llm/summary.ts';
import type { GenSettings } from '../llm/summary.ts';
import { addEmbedTokens, addMeeting, addUsage, normalizeStats } from '../llm/tokens.ts';
import { REGIONS, TRANSCRIPT_CALLOUT, parseCompanionProperties, readRegion, renderCompanion } from '../notes/companion.ts';
import { companionBasename, companionPath, dailyLinkLine } from '../notes/sanitize.ts';
import { disarmCode, sanitizeLlmOutput } from '../notes/sanitizeLlmOutput.ts';
import { transcriptPlain, turnLine } from '../notes/transcriptMd.ts';
import { WriteQueue } from '../notes/writeQueue.ts';
import { createEmbedder } from '../rag/embed.ts';
import { nearBest, retrievalFloors, type RetrievalFloors } from '../rag/relevance.ts';
import { TranscriptIndex } from '../rag/transcriptIndex.ts';
import { VaultIndex } from '../rag/vaultIndex.ts';
import { liveModelOf, softMarkerRegex } from '../settings.ts';
import { isAborted } from '../util/errors.ts';
import { remoteHostOf } from '../util/loopback.ts';
import { clock as clockText, estimateTokens, hhmm } from '../util/text.ts';
import { spokenNumbersToDigits } from '../util/numbers.ts';
import { describeError } from './errors.ts';
import { initialState } from './initialState.ts';
import { createHamsterStore } from './store.ts';
import type { HamsterStoreApi } from './store.ts';
import { leadingTaskMark, withoutTaskMark } from '../util/tasks.ts';

const TICK_MS = 500;
const LEVEL_STEP = 0.02;
const STREAM_INTERVAL_MS = 100;
const STATS_SAVE_MS = 60_000;
const VAULT_CHANGE_DEBOUNCE_MS = 2000;
/* Templater rewrites every new note about 300 ms after it is created. */
const NEW_COMPANION_HOLD_MS = 1000;
const FLUSH_CAP_MS = 3000;
/* Embedding the last chunk must not keep the Stop button spinning when Ollama is slow. */
const INDEX_FLUSH_CAP_MS = 5000;
/* An edited note is saved two seconds after the last keystroke: looked at once it has settled. */
const NOTE_CHECK_MS = 2500;
/* A bullet edited by hand while a run is writing its line is taken in once the run is over. */
const LINK_NOT_ADDED_NOTE = 'The link to the companion note could not be added to your note.';
const NOTE_CHECK_RETRIES = 6;
/* What a write batch that was given up carried is tried again by itself after this long: a file
   locked by a sync client has come free by then. */
const RESEND_MS = 30_000;
const MAX_CHIPS = 12;
const GLOSSARY_SIZE = 60;
const ENHANCE_EXCERPTS = 3;
const QA_VAULT_CHUNKS = 8;
const QA_TRANSCRIPT_CHUNKS = 4;
const QA_LINKED_CHARS = 2500;
const QA_TAIL_SECONDS = 900;
const QA_TAIL_TOKENS = 3000;
/* Lines of one meeting whose excerpts are remembered between two advances of the transcript. */
const EXCERPT_CACHE_SIZE = 300;
const OTHERS_LABEL = 'Others';
/* How long Ollama keeps a model after a call: through the quiet stretches of a meeting while it is
   recorded, five minutes otherwise. Never for good: the last call of a meeting is not always
   followed by another, and nothing would then unload the model. */
const KEEP_ALIVE_RECORDING = '30m';
const KEEP_ALIVE_IDLE = '5m';

const SUMMARY_HEADINGS: Record<SummaryStyle, string> = {
  executive: 'Executive summary',
  recap: 'Recap',
  actions: 'Action items',
};

/** The regions the plugin replaces whole. The transcript is only added to: an edit there is never undone. */
type Replaced = 'enhanced' | 'summary' | 'qa';
const REPLACED: readonly Replaced[] = ['enhanced', 'summary', 'qa'];
const NO_REGIONS: Region[] = [];

const NO_MEETING = 'Select or start a meeting first.';
const EARLIER_NOTES_KEPT =
  'The companion note keeps the enhanced notes of an earlier visit to this meeting. Press Enhance to replace them with the ones shown here.';
const EARLIER_SUMMARY_KEPT =
  'The companion note keeps the summary of an earlier visit to this meeting. Press Summarize again to replace it.';
const NO_SUMMARY_OVER_EARLIER =
  'No summary was written for this recording: the companion note keeps the one of an earlier visit to this meeting. Press Summarize to see a new one.';
const NO_LINK_LINE = 'no line is added to the daily note';
/* The words of the sidebar's banner for a source that gives no reason (STT_FAILED_FALLBACK and
   STT_NOT_INSTALLED_FALLBACK in ui/components/banner.ts). */
const TRANSCRIPT_LOST = 'Transcription stopped. The recording continues without a transcript.';
const TRANSCRIPT_NOT_INSTALLED = 'Transcription is not installed on this Mac.';
const CLOSING = 'Magical Hamster is restarting: that was not done. Try again in a moment.';
const LINK_NOT_ADDED = 'The link to the companion note could not be added to your daily note.';
/* A key no section has: asks the parser which section holds a link, whatever its heading says today. */
const ANY_SECTION = { title: '', ordinal: -1 };
/* The request that discards a recording counts as an answer to the notice only when it comes a
   moment after it, and while it is still up: not the second click of a double click, made before
   the notice could be read, and not a click made long after it has gone. */
const DISCARD_MIN_MS = 1000;
const DISCARD_MAX_MS = 15_000;

type VaultChange =
  | { type: 'modify' | 'delete'; path: string }
  | { type: 'rename'; path: string; oldPath: string };

interface Timer {
  handle: unknown;
}

/** Delivers at most one update per interval, and always the last one. */
interface Throttle {
  push(text: string): void;
  flush(): void;
  cancel(): void;
}

interface SummaryRun {
  abort: AbortController;
  stream: Throttle;
}

interface AskRun {
  abort: AbortController;
  stream: Throttle;
  sources: SourceDoc[];
}

/** A recording on its way up, until it runs, fails or is cancelled. */
interface StartAttempt {
  cancelled: boolean;
  /** Lets the start's own promise settle without waiting for the source. */
  release(): void;
}

/** A section as a lookup needs it: what it is called, and where it stands. */
interface Anchored {
  title: string;
  ordinal: number;
  anchorLine: number;
}

/** What the daily shown says about whose companion is whose. */
interface DailyLinks {
  text: string;
  opts: SectionOptions;
  /** The notes the plugin's own lines link to, by the anchor line of the section each line belongs to. */
  own: Map<number, string[]>;
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameMembers<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.every((value) => b.includes(value)) && b.every((value) => a.includes(value));
}

function sameItem(a: SectionItem, b: SectionItem): boolean {
  return a.id === b.id && a.kind === b.kind && a.line === b.line && a.text === b.text && a.raw === b.raw;
}

function sameItems(a: SectionItem[], b: SectionItem[]): boolean {
  return a.length === b.length && a.every((item, i) => sameItem(item, b[i]));
}

function sameSection(a: Section | null, b: Section | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.title === b.title &&
    a.rawTitle === b.rawTitle &&
    a.ordinal === b.ordinal &&
    a.isHeading === b.isHeading &&
    a.level === b.level &&
    a.anchorLine === b.anchorLine &&
    a.bodyStartLine === b.bodyStartLine &&
    a.bodyEndLine === b.bodyEndLine &&
    a.from === b.from &&
    a.to === b.to &&
    a.linkLine === b.linkLine &&
    sameList(a.links, b.links) &&
    sameItems(a.items, b.items)
  );
}

function sameEntry(a: MeetingListEntry, b: MeetingListEntry): boolean {
  return (
    a.key === b.key &&
    a.title === b.title &&
    a.rawTitle === b.rawTitle &&
    a.ordinal === b.ordinal &&
    a.anchorLine === b.anchorLine &&
    a.isHeading === b.isHeading &&
    a.group === b.group &&
    a.companionPath === b.companionPath &&
    a.current === b.current
  );
}

function sameEnhanced(a: EnhancedItem, b: EnhancedItem): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.source === b.source &&
    a.bullet === b.bullet &&
    a.stale === b.stale &&
    a.streaming === b.streaming &&
    sameList(a.excerptIds, b.excerptIds)
  );
}

/**
 * `next` with every entry that did not change replaced by the object already in
 * the state, and `previous` itself when nothing changed: the UI memoizes rows on identity.
 */
function reuse<T>(previous: T[], next: T[], same: (a: T, b: T) => boolean, idOf?: (item: T) => string): T[] {
  const byId = idOf ? new Map(previous.map((item) => [idOf(item), item])) : null;
  let identical = previous.length === next.length;
  const out = next.map((item, i) => {
    const old = byId && idOf ? byId.get(idOf(item)) : previous[i];
    if (old !== undefined && same(old, item)) {
      if (previous[i] !== old) identical = false;
      return old;
    }
    identical = false;
    return item;
  });
  return identical ? previous : out;
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

function lastSegment(target: string): string {
  return target.slice(target.lastIndexOf('/') + 1);
}

/**
 * The notes each section links to with the plugin's own line, by the line of the section's anchor.
 * A link line belongs to the nearest anchor above it: inside a nested section it is the child's.
 * `stem` is what the name of a linked note has to start with.
 */
function ownLinks(text: string, anchorLines: number[], stem: string): Map<number, string[]> {
  const found = new Map<number, string[]>();
  if (anchorLines.length === 0 || !text.includes(stem)) return found;
  const lines = text.split('\n');
  let next = 0;
  let owner = -1;
  for (let i = 0; i < lines.length; i++) {
    while (next < anchorLines.length && anchorLines[next] <= i) {
      owner = anchorLines[next];
      next += 1;
    }
    if (owner < 0 || !isLinkLine(lines[i], stem)) continue;
    const target = wikilinks(lines[i])[0];
    if (target === undefined) continue;
    const name = basenameOf(target);
    const names = found.get(owner);
    if (!names) found.set(owner, [name]);
    else if (!names.includes(name)) names.push(name);
  }
  return found;
}

/** 0-based line of a character offset. */
function lineAt(text: string, offset: number): number {
  const end = Math.min(Math.max(offset, 0), text.length);
  let line = 0;
  for (let at = text.indexOf('\n'); at !== -1 && at < end; at = text.indexOf('\n', at + 1)) line += 1;
  return line;
}

/** Spellings handed to the model: people by name, projects and bodies by the name of their note. */
function glossaryOf(entities: Entity[]): string[] {
  const names: string[] = [];
  for (const entity of entities) {
    if (!entity.active || entity.kind === 'other') continue;
    const name = (entity.kind === 'person' ? entity.name : lastSegment(entity.link)).trim();
    if (name !== '' && !names.includes(name)) names.push(name);
    if (names.length >= GLOSSARY_SIZE) break;
  }
  return names;
}

/* A note that opens with a heading repeating its own name would be cited as "Name › Name › Section". */
function headingUnderTitle(title: string, heading: string): string {
  if (heading === title) return '';
  return heading.startsWith(`${title} › `) ? heading.slice(title.length + 3) : heading;
}

/* While a long meeting is read window by window, the summarizer reports its progress ("Reading
   minutes 10–20…") through the same callback as the text. Left behind by a cancel, it would read as a summary. */
function withoutProgressNote(markdown: string): string {
  return /^[^\n]*…$/.test(markdown.trim()) ? '' : markdown;
}

/**
 * What a companion's `qa` region holds, without the blank lines around it. Null when the note or
 * the region cannot be read. With Unix line ends, whatever the note uses: it is written back in
 * front of the new insights, and compared with what this session sent.
 */
function qaContentOf(note: string | null): string | null {
  const region = note === null ? null : readRegion(note, 'qa');
  return region === null ? null : regionText(region);
}

/** What a region holds, without the blank lines around it and with Unix line ends. */
function regionText(content: string): string {
  return content
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd();
}

/** True when two versions of a region say the same: a blank line more or a trailing blank is not an edit. */
function sameText(a: string, b: string): boolean {
  if (a === b) return true;
  const lines = (text: string): string[] =>
    text
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line !== '');
  return sameList(lines(a), lines(b));
}

/** True when the note's transcript holds speech already, not just the header of its callout. */
function hasTranscriptLines(note: string | null): boolean {
  const region = note === null ? null : readRegion(note, 'transcript');
  if (region === null) return false;
  return region.split('\n').some((line) => line.trim() !== '' && line.trim() !== TRANSCRIPT_CALLOUT);
}

/**
 * The bullets a note's `enhanced` region holds, in order and without their list marker. Null when
 * the region cannot be read, or holds anything that is not a bullet or a topic heading: text the
 * engine could not hand back as it is.
 */
/** The setting's properties; none when it does not parse (the settings tab says why). */
function companionPropertiesOf(settings: HamsterSettings): Array<[string, string]> {
  const parsed = parseCompanionProperties(settings.companionProperties ?? '');
  return 'properties' in parsed ? parsed.properties : [];
}

/** The bullets of the note's enhanced notes, without the marks of their tasks: those come from the lines. */
function savedBulletsOf(note: string): string[] | null {
  const region = readRegion(note, 'enhanced');
  return region === null ? null : (bulletsIn(region)?.map(withoutTaskMark) ?? null);
}

function bulletsIn(region: string): string[] | null {
  const bullets: string[] = [];
  for (const raw of region.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line === '') continue;
    const bullet = /^- (\S.*)$/.exec(line);
    if (bullet) bullets.push(bullet[1]);
    else if (!/^#{1,6}[ \t]/.test(line)) return null;
  }
  return bullets;
}

const REGION_NAMES: Record<Replaced, { name: string; plural: boolean }> = {
  enhanced: { name: 'enhanced notes', plural: true },
  summary: { name: 'summary', plural: false },
  qa: { name: 'Q&A insights', plural: true },
};

function editedNotice(regions: Replaced[]): string {
  const names = regions.map((region) => REGION_NAMES[region].name);
  const plural = regions.length > 1 || REGION_NAMES[regions[0]].plural;
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  return (
    `The ${list} in the companion note ${plural ? 'were' : 'was'} edited by hand: ` +
    `${plural ? 'they are' : 'it is'} no longer replaced. Run "Create companion note" again to replace ` +
    `${plural ? 'them' : 'it'} with what the sidebar shows.`
  );
}

/** True when the note's `enhanced` region holds at least one bullet. */
function hasBullets(note: string): boolean {
  const region = readRegion(note, 'enhanced');
  return region !== null && /^- \S/m.test(region.replace(/\r\n?/g, '\n'));
}

/** True when the note's `summary` region holds text. */
function hasSummary(note: string): boolean {
  const region = readRegion(note, 'summary');
  return region !== null && region.trim() !== '';
}

function resumeLine(at: number): string {
  return `> **— recording resumed at ${hhmm(new Date(at))} —**`;
}

function emptySummary(style: SummaryStyle): HamsterState['summary'] {
  return { style, status: 'idle', markdown: '', error: null };
}

class MeetingSession implements HamsterSession {
  readonly store: HamsterStoreApi;
  readonly controller: HamsterController;

  private readonly deps: SessionDeps;
  private readonly scheduler: LlmQueue;
  private readonly embedder: Embedder;
  private readonly vaultIndex: VaultIndex | null;
  private readonly writeQueue: WriteQueue;
  private readonly enhance: EnhanceEngine;
  private transcriptIndex: TranscriptIndex;
  /** Chunks of this meeting's transcript that can be searched. */
  private searchable = 0;
  /** Excerpts found for a shorthand line, while that count stands. */
  private readonly excerpts = new Map<string, Excerpt[]>();
  private excerptsAt = 0;

  /** Dispose has started: nothing new is accepted, but the last speech is still saved. */
  private closed = false;
  /** Dispose has finished: the state is frozen. */
  private disposed = false;
  private closing: Promise<void> | null = null;

  private readonly timers = new Set<Timer>();
  /** Finishers of capped waits, so dispose can release them when it clears their timers. */
  private readonly waits = new Set<() => void>();

  private entities: Entity[] = [];
  private entityNameList: string[] = [];
  private glossary: string[] = [];
  private softMarker: { pattern: string; regex: RegExp } | null = null;

  /** The last text and cursor reported for today's daily; null when there is no daily. */
  private dailyText: string | null = null;
  private cursor: number | null = null;
  /** The note last open in the main area when it is not the daily: its text and cursor. */
  private focus: { path: string; text: string; cursor: number | null } | null = null;
  /** False once another note than the daily is open in the main area: no daily section is under the cursor then. */
  private dailyFocused = true;
  /** Text of the note a meeting is typed in, when it is not the daily. */
  private noteText: string | null = null;
  /** Counts reads and updates of the daily, so a slow read never replaces newer text. */
  private dailyRead = 0;
  private rereadAfterStop = false;
  private ollamaCheck = 0;

  /** The daily the current meeting was started from. */
  private meetingDaily: DailyInfo;
  /** The current meeting's section as last found in the daily. */
  private section: Section | null = null;
  private manualCount = 0;
  /**
   * Companions whose section changed its key in this session (a renamed heading, a manual
   * meeting linked later), by day and current key. Their frontmatter still names the old key.
   * A cache: the link line in the daily is what lasts. It still answers where there is no such
   * line to read (it could not be added, or was deleted) or the line names a note that was
   * renamed since.
   */
  private readonly rekeyed = new Map<string, string>();
  /**
   * The meetings started on their own that have a note, by key: they stay in the day's list once
   * they are left, so that they can be picked up again. In memory only: after a restart the note
   * is still in the vault, and nothing but its name ties it to the day.
   */
  private readonly manualMeetings = new Map<string, { title: string; date: string; path: string }>();

  private source: TranscriptSource | null = null;
  private unsubscribe: Array<() => void> = [];
  private recordingOp: Promise<void> | null = null;
  /** Set while a recording is starting: what a cancel needs. */
  private startAttempt: StartAttempt | null = null;
  /** Codes of the speech warnings already shown in this recording. */
  private readonly warned = new Set<string>();
  /** The user was told that this recording has lost its transcript. */
  private transcriptLossSaid = false;
  private ticker: unknown = null;
  private ticking = false;
  private recordingSince = 0;
  /** Seconds recorded in this meeting before the current recording. */
  private offsetSec = 0;
  private turnCount = 0;
  /** Set when a recording starts; written in front of its first turn when speech came before it. */
  private resumeNote: string | null = null;
  /** The companion already held speech when this session met it, from an earlier visit to the meeting. */
  private priorTranscript = false;
  /** Separator lines, by the index of the turn they precede. */
  private separators = new Map<number, string>();

  /** Session-wide, never reset: ids must not repeat across meetings. */
  private chipCount = 0;
  /** The last final of each source, for the question mark that arrives with the next one. */
  private lastFinal = new Map<string, Turn>();
  /** The partial still open from the speech worker: kept as a final if the worker dies before it ends. */
  private openPartial: SttSegment | null = null;
  private askCount = 0;
  private summaryRun: SummaryRun | null = null;
  private readonly asks = new Map<string, AskRun>();

  /* The transcript region only grows, so each turn must reach the note exactly once.
     Three marks into `turns`: handed to the write queue, carried by a batch that has
     ended (written or lost), and known to be on disk, counted from the first turn. */
  private savedTurns = 0;
  private takenTurns = 0;
  private writtenTurns = 0;
  /** Bumped whenever those marks start over, so a write that lands late does not move them. */
  private companionEpoch = 0;
  /** The turns of the last write that failed: the queue tries it again, or gives it up and says so. */
  private failedBatch: { epoch: number; from: number; upTo: number } | null = null;
  private savedEnhanced: string | null = null;
  /**
   * What the companion's `qa` region held before this session wrote to it: kept insights are
   * added to it. Not read again for a note that only moved: by then it holds this session's own
   * insights. Null until a read has shown the region whole: nothing is written there before,
   * or the insights of an earlier session would be replaced.
   */
  private qaPrefix: string | null = null;
  /** The note that prefix belongs to: the one it was read from, or the one created empty. */
  private qaNote: string | null = null;
  /**
   * Everything this session sent to the `qa` region in this meeting, with the kept answers each
   * version carried: how its own note is told from another, and which answers a version holds.
   */
  private readonly qaSent = new Map<string, string[]>();
  /** Kept answers that are part of `qaPrefix` since the region was edited by hand: not added a second time. */
  private readonly qaFolded = new Set<string>();
  /**
   * What each region the plugin replaces held when it last wrote or read it. A region found to
   * hold something else was edited by hand: the edit is taken in where it can be (a bullet, the
   * insights), and where it cannot the region is no longer written to (`editedOutside`).
   */
  private readonly noteHeld = new Map<Replaced, string>();
  /** What the write under way is putting there: not an edit by hand either. */
  private readonly flying = new Map<Replaced, string>();
  private noteCheck: Timer | null = null;
  private noteCheckTries = 0;
  /**
   * What a batch carried for a region that turned out to be edited by hand, and was left out of
   * the write. The queue still holds it when the rest of the batch has to be tried again: it must
   * not go out then either.
   */
  private readonly stale = new Map<Region, string>();
  /** Regions set aside without a word, while a correction waits for the run that is writing its line. */
  private readonly unsaid = new Set<Replaced>();
  /** Bumped when those marks stop describing the note in hand, so a write that lands late does not set them. */
  private noteEpoch = 0;
  /** The enhanced notes last handed to the queue, and the lines their bullets belong to, in order. */
  private enhancedSent: { content: string; ids: string[] } | null = null;
  /** The lines the bullets in the note belong to, in order. Null when that is not known. */
  private noteBulletIds: string[] | null = null;
  private noteInspected = false;
  /**
   * The transcript of a meeting is in memory for one visit only. What an earlier visit wrote from
   * it, the note still holds, and this visit could only write it again from less. So:
   *
   * `priorEnhanced`: the note holds bullets the engine was not handed (or it is not known yet
   * what the note holds). Nothing replaces them unasked: not a Live run, not a change of style,
   * not a run that stopped half-way. The new bullets are shown, the user is told once that the
   * note keeps the earlier ones, and Enhance pressed after that replaces them, once the run has
   * dealt with every line.
   * `earlierBullets`: the note held bullets when this visit met it, handed to the engine or not.
   * `priorSummary`: the note holds a summary of an earlier visit (or it is not known yet). No
   * summary is started over it at a stop, and one that is asked for is shown without being
   * saved; the user is told once, and Summarize pressed after that replaces it.
   */
  private priorEnhanced = false;
  private earlierBullets = false;
  private priorSummary = false;
  /** Enhance was pressed in this visit by a user who knew what it replaces. */
  private enhanceAsked = false;
  /** The user was told that the note keeps the earlier notes, the earlier summary. */
  private earlierNotesNoticed = false;
  private earlierSummaryNoticed = false;
  private noSummaryNoticed = false;
  /** While the note's own bullets are handed to the engine: there is nothing to save. */
  private seeding = false;
  /** That one read is under way. */
  private inspecting = false;
  /** Settles when that one read has. */
  private inspection: Promise<void> = Promise.resolve();
  /** Bumped when the meeting changes, so a read that lands late is dropped. */
  private meetingEpoch = 0;
  private creating = false;
  /** Calls of endMeeting still under way. */
  private ending = 0;
  private missingNoticed = false;
  private writeErrorNoticed = false;
  /** The queue gave a batch up: the regions it carried are not in the note, and go again with the next try. */
  private resend = false;
  /** That next try, when nothing else brings one: armed when a batch is given up, one at a time. */
  private resendTimer: Timer | null = null;
  /**
   * The note the three turn marks count against. It outlives `companionPath`, which is cleared
   * when the note is reported missing: lines queued for it are still written if it comes back.
   */
  private turnsNote: string | null = null;
  /**
   * What was refused because it would drop a recording that is in no note, and when the notice
   * went up: asked again while that notice is being read, it goes through.
   */
  private discardAsked: { id: string; at: number } | null = null;

  /** The Enhance style the settings held when last looked at: a change there is taken, a choice made in the sidebar is kept. */
  private settingsStyle: EnhanceStyle;

  private statsDirty = false;
  private statsTimer: Timer | null = null;

  private indexAbort: AbortController | null = null;
  private indexRun: Promise<void> | null = null;
  private readonly vaultTimers = new Map<string, Timer>();
  private heldChanges: VaultChange[] = [];

  constructor(deps: SessionDeps) {
    this.deps = deps;
    const settings = deps.settings();
    this.settingsStyle = settings.enhanceStyle;
    this.store = createHamsterStore(initialState(settings, deps.notes.today()));
    this.meetingDaily = this.store.getState().daily;

    this.scheduler = new LlmQueue();
    this.embedder = createEmbedder({
      llm: deps.llm,
      model: () => deps.settings().embedModel,
      numCtx: () => deps.settings().embedNumCtx,
      dim: () => deps.settings().embedDimensions,
      onTokens: (tokens) => this.onEmbedTokens(tokens),
    });
    this.vaultIndex = deps.vaultIndexIO
      ? new VaultIndex({
          io: deps.vaultIndexIO,
          embedder: this.embedder,
          clock: deps.clock,
          modelId: () => {
            const s = deps.settings();
            return `${s.embedModel}@${s.embedDimensions}`;
          },
          onStatus: (status) => this.onIndexStatus(status),
        })
      : null;
    this.writeQueue = new WriteQueue({
      write: (path, patches) => this.writeBatch(path, patches),
      clock: deps.clock,
      onOutcome: (path, outcome) => this.onWriteOutcome(path, outcome),
      onError: (path, error) => this.onWriteError(path, error),
      onPendingChange: (pending) => this.patch({ pendingWrites: pending }),
    });
    this.enhance = new EnhanceEngine(this.enhanceDeps());
    this.enhance.setLive(this.state.liveEnhance);
    this.transcriptIndex = this.newTranscriptIndex();
    this.controller = this.buildController();
  }

  /* ───────────────────────────── Life cycle ───────────────────────────── */

  async init(): Promise<void> {
    if (this.closed) return;
    try {
      const loaded = await this.deps.statsIO.load();
      if (!this.closed) this.patch({ stats: normalizeStats(loaded) });
    } catch {
      // No stats file is not a reason to refuse to start.
    }
    try {
      // Beside the daily, not before it: a server that takes the connection and never answers is given a minute.
      const ollama = this.checkOllamaAndIndex();
      await this.loadEntities();
      if (!this.closed) {
        this.patchDaily(this.deps.notes.today());
        await this.readDaily();
      }
      await ollama;
    } catch (e) {
      this.report(e);
    }
  }

  private async checkOllamaAndIndex(): Promise<void> {
    try {
      if (this.vaultIndex) await this.vaultIndex.load();
      await this.refreshOllama();
      this.buildIndexAtStartup();
    } catch (e) {
      this.report(e);
    }
  }

  flushAll(capMs: number = FLUSH_CAP_MS): Promise<void> {
    if (this.disposed) return Promise.resolve();
    // What a batch that was given up carried goes with this flush: it may be the last one.
    if (this.resend && this.state.meeting?.companionPath) this.safely(() => this.sendDropped());
    const work = Promise.all([this.writeQueue.flush(undefined, capMs), this.saveStats()]);
    return this.capped(work, capMs);
  }

  dispose(): Promise<void> {
    this.closing ??= this.shutDown();
    return this.closing;
  }

  private async shutDown(): Promise<void> {
    this.closed = true;
    this.stopTicker();
    // A start still under way ends here: its promise settles, and what its source answers later is not heard.
    const attempt = this.startAttempt;
    this.startAttempt = null;
    if (attempt) {
      attempt.cancelled = true;
      attempt.release();
    }
    const source = this.source;
    if (source) {
      try {
        // The handlers stay attached: the worker's last finals arrive during the stop.
        await source.stop();
      } catch {
        // A source that cannot stop cleanly is still done.
      }
      this.detachSource();
    }
    // Also for a start that was being cancelled: its source is detached already, and stops on its own.
    if (this.state.recording !== 'idle') this.patch({ recording: 'idle', partial: null, micLevel: 0 });
    this.cancelGeneration();
    this.scheduler.cancelAll();
    this.enhance.dispose();
    this.indexAbort?.abort();
    this.transcriptIndex.reset();
    try {
      // The final flush. It first sends again what a batch that was given up carried (`flushAll`):
      // after this nothing is left to try it.
      await this.flushAll();
    } catch {
      // Best effort: the queue has its own cap.
    }
    // Capped: its last save waits behind whatever it is doing, and an embedding request can hang
    // for minutes. The index is brought up to date from the vault at the next start.
    if (this.vaultIndex) await this.capped(this.vaultIndex.dispose(), FLUSH_CAP_MS);
    this.writeQueue.dispose();
    this.disposed = true;
    this.clearTimers();
  }

  /* ─────────────────────────── State plumbing ─────────────────────────── */

  private get state(): HamsterState {
    return this.store.getState();
  }

  /** Writes only the slices that differ, so subscribers are not woken for nothing. */
  private patch(patch: Partial<HamsterState>): void {
    if (this.disposed) return;
    const state = this.store.getState();
    const changed: Partial<HamsterState> = {};
    let any = false;
    for (const key of Object.keys(patch) as Array<keyof HamsterState>) {
      if (Object.is(state[key], patch[key])) continue;
      (changed as Record<string, unknown>)[key] = patch[key];
      any = true;
    }
    if (any) this.store.setState(changed);
  }

  private patchMeeting(change: Partial<MeetingState>): void {
    const meeting = this.state.meeting;
    if (!meeting) return;
    const keys = Object.keys(change) as Array<keyof MeetingState>;
    if (keys.every((key) => Object.is(meeting[key], change[key]))) return;
    this.patch({ meeting: { ...meeting, ...change } });
  }

  private patchDaily(daily: DailyInfo): void {
    const now = this.state.daily;
    if (
      now.path === daily.path &&
      now.basename === daily.basename &&
      now.date === daily.date &&
      now.exists === daily.exists
    ) {
      return;
    }
    this.patch({ daily });
  }

  private notice(message: string): void {
    if (this.disposed) return;
    try {
      this.deps.notes.notice(message);
    } catch {
      // A host that cannot show a notice must not break the action that wanted one.
    }
  }

  private report(e: unknown): void {
    if (isAborted(e)) return;
    this.notice(describeError(e));
  }

  /** For the entry points the host calls: they must never throw back into Obsidian. */
  private safely(run: () => void): void {
    try {
      run();
    } catch (e) {
      this.report(e);
    }
  }

  private later(run: () => void, ms: number): Timer {
    const timer: Timer = { handle: null };
    // Work that was cancelled by dispose may still unwind: it must not arm anything.
    if (this.disposed) return timer;
    timer.handle = this.deps.clock.setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, Math.max(0, ms));
    this.timers.add(timer);
    return timer;
  }

  private cancel(timer: Timer | null): void {
    if (!timer || !this.timers.delete(timer)) return;
    this.deps.clock.clearTimeout(timer.handle);
  }

  private clearTimers(): void {
    this.stopTicker();
    for (const finish of [...this.waits]) finish();
    for (const timer of [...this.timers]) this.cancel(timer);
    this.statsTimer = null;
    this.resendTimer = null;
    this.vaultTimers.clear();
  }

  /** Resolves when `work` settles or after `ms`, whichever comes first. Never rejects. */
  private capped(work: Promise<unknown>, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        if (!this.waits.delete(finish)) return;
        this.cancel(timer);
        resolve();
      };
      this.waits.add(finish);
      const timer = this.later(finish, ms);
      work.then(finish, finish);
    });
  }

  private throttle(apply: (text: string) => void): Throttle {
    let waiting: string | null = null;
    let timer: Timer | null = null;
    let last = Number.NEGATIVE_INFINITY;
    const deliver = (): void => {
      timer = null;
      if (waiting === null) return;
      const text = waiting;
      waiting = null;
      last = this.deps.clock.now();
      apply(text);
    };
    return {
      push: (text) => {
        waiting = text;
        const wait = last + STREAM_INTERVAL_MS - this.deps.clock.now();
        if (wait <= 0) deliver();
        else timer ??= this.later(deliver, wait);
      },
      flush: () => {
        this.cancel(timer);
        deliver();
      },
      cancel: () => {
        this.cancel(timer);
        timer = null;
        waiting = null;
      },
    };
  }

  private buildController(): HamsterController {
    /* Between the start of a shutdown and its end (a reload of the plugin, at most a few
       seconds) the sidebar is still there: an action pressed then is not done, and says so. */
    const refused = (): void => this.notice(CLOSING);
    const sync =
      <A extends unknown[]>(run: (...args: A) => void) =>
      (...args: A): void => {
        if (this.closed) return refused();
        this.safely(() => run(...args));
      };
    const task =
      <A extends unknown[]>(run: (...args: A) => Promise<void>) =>
      async (...args: A): Promise<void> => {
        if (this.closed) return refused();
        try {
          await run(...args);
        } catch (e) {
          this.report(e);
        }
      };

    return {
      setTab: sync((tab: TabId) => this.patch({ tab })),
      selectSection: sync((key: SectionKey) => this.selectSection(key)),
      newMeeting: sync(() => this.newMeeting()),
      linkAtCursor: task(() => this.linkAtCursor()),
      useActiveNote: task(() => this.useActiveNote(false)),
      writeIntoActiveNote: task(() => this.writeIntoActiveNote()),
      endMeeting: task(() => this.endMeeting()),
      createCompanion: task(() => this.createCompanion()),
      openCompanion: sync(() => this.openCompanion()),
      openDaily: sync(() => this.openDaily()),
      startRecording: task(() => this.startRecording()),
      stopRecording: task(() => this.stopRecording(true)),
      setLiveEnhance: sync((on: boolean) => this.setLiveEnhance(on)),
      setEnhanceStyle: sync((style: EnhanceStyle) => this.setEnhanceStyle(style)),
      enhanceNow: task(() => this.enhanceNow()),
      // Told that the note keeps the summary of an earlier visit, and asked again: this one replaces it.
      summarize: task((style: SummaryStyle) =>
        this.summarize(style, true, this.priorSummary && this.earlierSummaryNoticed),
      ),
      cancelSummary: sync(() => this.cancelSummary()),
      ask: task((question: string, chipId?: string) => this.ask(question, chipId)),
      cancelAsk: sync((id: string) => this.cancelAsk(id)),
      keepInsight: task((id: string) => this.keepInsight(id)),
      dismissChip: sync((id: string) => this.dismissChip(id)),
      listFolders: () => {
        if (this.closed) return [];
        try {
          return this.deps.notes.listFolders();
        } catch {
          return [];
        }
      },
      buildIndex: task((folders: string[]) => this.buildIndex(folders)),
      cancelIndex: sync(() => this.indexAbort?.abort()),
      refreshOllama: task(() => this.refreshOllama()),
      copy: sync((text: string) => this.deps.clipboard(text)),
    };
  }

  /* ───────────────────────────── Ollama status ────────────────────────── */

  private async refreshOllama(): Promise<void> {
    const check = ++this.ollamaCheck;
    let status: HamsterState['ollama']['status'];
    let missing: string[] = [];
    try {
      const tags = await this.deps.llm.tags();
      const s = this.deps.settings();
      const wanted = [s.llmModel, liveModelOf(s), s.embedModel].map((model) => model.trim());
      const distinct = [...new Set(wanted)].filter((model) => model !== '');
      status = 'ok';
      missing = distinct.filter((model) => !modelInstalled(tags, model));
    } catch {
      status = 'unreachable';
    }
    // A slower, older answer must not overwrite a newer one.
    if (this.closed || check !== this.ollamaCheck) return;
    this.setOllama(status, missing);
  }

  /**
   * Publishes what is known of Ollama. Where it is comes from the settings as they are now, not
   * from the check: an address that is not this computer is said the moment it is typed, whether
   * or not anything answers there.
   */
  private setOllama(status: HamsterState['ollama']['status'], missingModels: string[]): void {
    const now = this.state.ollama;
    const remoteHost = remoteHostOf(this.deps.settings().ollamaUrl);
    const sameModels = sameList(now.missingModels, missingModels);
    if (now.status === status && now.remoteHost === remoteHost && sameModels) return;
    this.patch({ ollama: { status, missingModels: sameModels ? now.missingModels : missingModels, remoteHost } });
  }

  /* ───────────────────────────── The daily note ───────────────────────── */

  handleDailyUpdate(update: DailyUpdate): void {
    if (this.closed) return;
    this.safely(() => {
      const today = this.deps.notes.today();
      if (today.date !== this.state.daily.date) this.handleDailyAvailability();
      if (update.path !== today.path) return;
      // A read that started before this update holds older text.
      this.dailyRead += 1;
      this.patchDaily(today);
      this.dailyText = update.text;
      this.cursor = update.cursor;
      if (update.cursor !== null) this.setFocus(today.path, true);
      this.derive(update.userTyped === true);
    });
  }

  handleNoteUpdate(update: DailyUpdate): void {
    if (this.closed) return;
    if (update.path === this.deps.notes.today().path) {
      this.handleDailyUpdate(update);
      return;
    }
    this.safely(() => {
      const meetingNote = this.state.meeting?.notePath === update.path;
      // A change typed or a cursor moved there: that note is the one in front of the user.
      if (update.cursor !== null || this.focus?.path === update.path) {
        this.focus = { path: update.path, text: update.text, cursor: update.cursor };
        this.setFocus(update.path, false);
      }
      if (meetingNote) this.noteText = update.text;
      if (meetingNote || this.focus?.path === update.path) this.derive(meetingNote && update.userTyped === true);
    });
  }

  handleFocus(focus: { path: string; text: string | null; cursor: number | null }): void {
    if (this.closed) return;
    this.safely(() => {
      const daily = focus.path === this.deps.notes.today().path;
      if (!daily) {
        const known = this.focus?.path === focus.path ? this.focus.text : '';
        this.focus = { path: focus.path, text: focus.text ?? known, cursor: focus.cursor };
        if (focus.text !== null && this.state.meeting?.notePath === focus.path) this.noteText = focus.text;
      }
      this.setFocus(focus.path, daily);
      this.derive();
    });
  }

  private setFocus(path: string, daily: boolean): void {
    this.dailyFocused = daily;
    const now = this.state.focusedNote;
    if (now?.path === path && now.daily === daily) return;
    this.patch({ focusedNote: { path, basename: basenameOf(path), daily } });
  }

  handleDailyAvailability(): void {
    if (this.closed) return;
    this.safely(() => {
      const before = this.state.daily;
      const today = this.deps.notes.today();
      this.patchDaily(today);
      if (today.date !== before.date) {
        if (this.state.recording !== 'idle') {
          // A recording that runs past midnight is not disturbed: the new daily is read once it stops.
          this.rereadAfterStop = true;
          return;
        }
        this.dailyRead += 1;
        this.dailyText = null;
        this.cursor = null;
        this.derive();
      }
      void this.readDaily();
    });
  }

  handleSettingsChange(): void {
    if (this.closed) return;
    this.safely(() => {
      const s = this.deps.settings();
      this.patch({ micLabel: s.micLabel, costPer1k: s.costPer1k, companionFolder: s.companionFolder });
      // Before the check below has an answer, and when it never gets one: where the meeting goes is known already.
      this.setOllama(this.state.ollama.status, this.state.ollama.missingModels);
      if (s.enhanceStyle !== this.settingsStyle) {
        this.settingsStyle = s.enhanceStyle;
        this.setEnhanceStyle(s.enhanceStyle);
      }
      // The indexed folders may have been typed in the settings tab, or have arrived by sync.
      if (this.vaultIndex) this.onIndexStatus(this.vaultIndex.status());
      void this.refreshOllama();
      // The soft-marker pattern or the companion prefix may have changed.
      this.derive();
      // So may the path of the entity registry.
      void this.loadEntities();
    });
  }

  private async readDaily(): Promise<void> {
    const read = ++this.dailyRead;
    let text: string | null = null;
    try {
      text = await this.deps.notes.readDaily();
    } catch {
      text = null;
    }
    if (this.closed || read !== this.dailyRead) return;
    this.safely(() => {
      this.patchDaily(this.deps.notes.today());
      this.dailyText = text;
      this.cursor = null;
      this.derive();
    });
  }

  /** Reads again the note a meeting is typed in, when it changed outside an editor. */
  private async rereadNote(path: string): Promise<void> {
    let text: string | null = null;
    try {
      text = await this.deps.notes.readNote(path);
    } catch {
      return;
    }
    if (this.closed || text === null || this.state.meeting?.notePath !== path) return;
    this.safely(() => {
      this.noteText = text;
      if (this.focus?.path === path) this.focus = { ...this.focus, text };
      this.derive();
    });
  }

  private async loadEntities(): Promise<void> {
    let entities: Entity[];
    try {
      entities = await this.deps.notes.entities();
    } catch {
      // Keep the registry read before: a meeting heading must not stop being one.
      return;
    }
    if (this.closed) return;
    this.entities = entities;
    this.entityNameList = entityNames(entities);
    this.glossary = glossaryOf(entities);
    if (this.dailyText !== null) this.safely(() => this.derive());
  }

  private sectionOptions(): SectionOptions {
    const s = this.deps.settings();
    if (this.softMarker?.pattern !== s.softMarkerPattern) {
      this.softMarker = { pattern: s.softMarkerPattern, regex: softMarkerRegex(s) };
    }
    return { softMarker: this.softMarker.regex, entityNames: this.entityNameList, linkPrefix: s.companionPrefix };
  }

  /** The note whose frontmatter names that section. */
  private keyedCompanion(date: string, key: SectionKey): string | null {
    try {
      return this.deps.notes.findCompanion(date, key);
    } catch {
      return null;
    }
  }

  /** The note a link line names. */
  private linkedCompanion(basename: string): string | null {
    try {
      return this.deps.notes.findCompanionByBasename(basename);
    } catch {
      return null;
    }
  }

  /** The note this session knows under that key, whatever its frontmatter says. */
  private rememberedCompanion(date: string, key: SectionKey): string | null {
    const id = `${date}\n${key}`;
    const path = this.rekeyed.get(id);
    if (path === undefined) return null;
    if (!this.gone(path)) return path;
    this.rekeyed.delete(id);
    return null;
  }

  /**
   * Whose companion is whose in the daily in hand: the note of each section, by the line of its
   * anchor. A note is one section's only, and which one is decided the way a meeting is followed
   * through the note (`findSection`): the section its frontmatter names, as long as the link line
   * is inside it; failing that, the section the link line stands in. That line is what lasts: the
   * key in the frontmatter goes stale when the heading is renamed or a section of the same title
   * is added above.
   */
  private companionsIn(
    text: string,
    date: string,
    anchors: ReadonlyArray<Anchored>,
    opts: SectionOptions,
  ): Map<number, string> {
    // Only the lines that name a companion of that day: a section copied over from another
    // day's note brings that day's line along, and must not take that day's note with it.
    const stem = `${opts.linkPrefix ?? ''}${date}`;
    const links: DailyLinks = {
      text,
      opts,
      // Most days hold no such line at all: nothing to go through the note for.
      own: text.includes(stem) ? ownLinks(text, anchors.map((anchor) => anchor.anchorLine), stem) : new Map<number, string[]>(),
    };
    const found = new Map<number, string>();
    /** Notes that have their section. */
    const held = new Set<string>();
    const give = (anchor: Anchored, path: string): void => {
      found.set(anchor.anchorLine, path);
      held.add(path);
    };

    for (const anchor of anchors) {
      const keyed = this.keyedCompanion(date, sectionKey(anchor));
      if (keyed === null || held.has(keyed) || this.linkedElsewhere(links, anchor, keyed)) continue;
      give(anchor, keyed);
    }
    for (const anchor of anchors) {
      if (found.has(anchor.anchorLine)) continue;
      for (const basename of links.own.get(anchor.anchorLine) ?? []) {
        const path = this.linkedCompanion(basename);
        // Held: the note of the section this one is nested in, whose line ends up down here.
        if (path === null || held.has(path)) continue;
        // The parser has the last word: a line inside a code block is no link, and of two lines to one note the first counts.
        if (findSection(text, ANY_SECTION, opts, basename)?.anchorLine !== anchor.anchorLine) continue;
        give(anchor, path);
        break;
      }
    }
    for (const anchor of anchors) {
      if (found.has(anchor.anchorLine)) continue;
      const path = this.rememberedCompanion(date, sectionKey(anchor));
      if (path !== null && !held.has(path)) give(anchor, path);
    }
    return found;
  }

  /** The companion of one section of the daily in hand. */
  private companionOf(date: string, section: Anchored): string | null {
    const text = this.dailyText;
    const key = sectionKey(section);
    if (text === null) return this.keyedCompanion(date, key) ?? this.rememberedCompanion(date, key);
    const opts = this.sectionOptions();
    return this.companionsIn(text, date, listSections(text, opts), opts).get(section.anchorLine) ?? null;
  }

  /**
   * True when the daily links that note from another section: its key was taken over by a
   * section of the same title added above the one the note belongs to.
   */
  private linkedElsewhere(links: DailyLinks, section: Anchored, path: string): boolean {
    const basename = basenameOf(path);
    let suspected = false;
    for (const [anchorLine, names] of links.own) {
      if (anchorLine === section.anchorLine || !names.includes(basename)) continue;
      suspected = true;
      break;
    }
    if (!suspected) return false;
    // Under a nested heading the line is still inside this section: the parser knows the whole body.
    const holder = findSection(links.text, section, links.opts, basename);
    return holder !== null && holder.anchorLine !== section.anchorLine;
  }

  /** The note a meeting would be given, were it asked for now. */
  private meetingCompanion(meeting: MeetingState): string | null {
    const text = this.dailyText;
    if (meeting.source && text !== null && this.meetingDailyShown()) {
      // Found afresh: where the section was last seen, another one may stand by now.
      const section = findSection(text, meeting.source, this.sectionOptions());
      if (section) return this.companionOf(meeting.date, section);
    }
    return this.keyedCompanion(meeting.date, meeting.key) ?? this.rememberedCompanion(meeting.date, meeting.key);
  }

  /** The section of a companion goes by a new key from now on. */
  private rekey(date: string, oldKey: string, newKey: SectionKey, path: string): void {
    this.rekeyed.delete(`${date}\n${oldKey}`);
    this.rekeyed.set(`${date}\n${newKey}`, path);
  }

  /** True when the host says the note is not there. A host that cannot tell says nothing. */
  private gone(path: string): boolean {
    try {
      return !this.deps.notes.exists(path);
    } catch {
      return false;
    }
  }

  /** A meeting belongs to the daily of its day: the next day's note may hold a section of the same name. */
  private meetingDailyShown(): boolean {
    return this.meetingDaily.date === this.state.daily.date;
  }

  /**
   * Recomputes everything that is read from the daily: sections, active section, shorthand, cursor hint.
   * `typed`: the daily changed under the user's own keystrokes, the one change Live Enhance runs for.
   */
  private derive(typed = false): void {
    const state = this.state;
    const text = this.dailyText;
    const cursor = this.cursor;
    let meeting = state.meeting;
    let shorthand = state.shorthand;
    let active = state.activeSection;
    let sections = state.sections;

    if (text === null) {
      active = null;
      sections = reuse(sections, this.manualRows(meeting), sameEntry);
      if (!meeting) shorthand = [];
    } else {
      const opts = this.sectionOptions();
      // Another note in front: no section of the daily is under the cursor, whatever it was last.
      if (!this.dailyFocused) active = null;
      // Without a cursor the same section stays active; its lines may have changed under it.
      else if (cursor !== null) active = sectionAt(text, cursor, opts);
      else if (active) active = findSection(text, active, opts);
      if (sameSection(state.activeSection, active)) active = state.activeSection;

      if (meeting?.source) {
        const basename = meeting.companionPath ? basenameOf(meeting.companionPath) : undefined;
        // A meeting left open overnight must not take over today's section of the same name.
        const found = this.meetingDailyShown() ? findSection(text, meeting.source, opts, basename) : null;
        if (found) {
          this.section = found;
          shorthand = found.items;
          const line = cursor === null ? -1 : lineAt(text, cursor);
          const outside = cursor !== null && (line < found.anchorLine || line >= found.bodyEndLine);
          // Found through the link line after a rename. A heading emptied on its way to a new name is not one yet.
          const renamed =
            found.title !== '' &&
            (found.title !== meeting.source.title || found.ordinal !== meeting.source.ordinal);
          if (renamed) {
            if (meeting.companionPath) {
              this.rekey(state.daily.date, meeting.key, sectionKey(found), meeting.companionPath);
            }
            meeting = {
              ...meeting,
              key: sectionKey(found),
              title: found.title,
              source: { title: found.title, ordinal: found.ordinal },
              cursorOutside: outside,
            };
          } else if (meeting.cursorOutside !== outside) {
            meeting = { ...meeting, cursorOutside: outside };
          }
        } else if (!meeting.cursorOutside) {
          meeting = { ...meeting, cursorOutside: true };
        }
      } else if (meeting) {
        shorthand = [];
      } else {
        shorthand = active?.items ?? [];
      }
      sections = this.listEntries(text, opts, meeting, state.sections);
    }

    // A meeting typed in another note: its shorthand is that note's.
    if (meeting?.notePath) {
      const noted = this.noteShorthand(meeting);
      shorthand = noted.items;
      if (meeting.cursorOutside !== noted.outside) meeting = { ...meeting, cursorOutside: noted.outside };
    }

    this.patch({
      sections,
      activeSection: active,
      meeting,
      shorthand: reuse(state.shorthand, shorthand, sameItem),
    });
    if (meeting) {
      this.enhance.setTitle(meeting.title);
      this.enhance.setItems(this.state.shorthand, typed);
    }
  }

  /** The shorthand of a meeting typed in another note, and whether the cursor there is outside it. */
  private noteShorthand(meeting: MeetingState): { items: SectionItem[]; outside: boolean } {
    const text = this.noteText;
    if (text === null || !meeting.notePath) return { items: [], outside: false };
    const opts = this.sectionOptions();
    const basename = meeting.companionPath ? basenameOf(meeting.companionPath) : undefined;
    const found = meeting.noteSection
      ? findSection(text, meeting.noteSection, opts, basename)
      : wholeNoteSection(text, meeting.title, opts);
    if (!found) return { items: [], outside: true };
    const cursor = this.focus?.path === meeting.notePath ? this.focus.cursor : null;
    if (cursor === null || !meeting.noteSection) return { items: found.items, outside: false };
    const line = lineAt(text, cursor);
    return { items: found.items, outside: line < found.anchorLine || line >= found.bodyEndLine };
  }

  private listEntries(
    text: string,
    opts: SectionOptions,
    meeting: MeetingState | null,
    previous: MeetingListEntry[],
  ): MeetingListEntry[] {
    const date = this.state.daily.date;
    const shown = this.meetingDailyShown();
    const next: MeetingListEntry[] = [];
    const anchors = listSections(text, opts);
    const notes = this.companionsIn(text, date, anchors, opts);
    for (const anchor of anchors) {
      // A heading still being typed (`### `) is not a meeting yet.
      if (anchor.title === '') continue;
      const key = sectionKey(anchor);
      const current = meeting !== null && shown && meeting.key === key;
      // After a rename the companion still carries the old key in its frontmatter.
      const companion =
        current && meeting.companionPath ? meeting.companionPath : (notes.get(anchor.anchorLine) ?? null);
      next.push({
        key,
        title: anchor.title,
        rawTitle: anchor.rawTitle,
        ordinal: anchor.ordinal,
        anchorLine: anchor.anchorLine,
        isHeading: anchor.isHeading,
        group: anchor.meetingLike ? 'meeting' : 'other',
        companionPath: companion,
        current,
      });
    }
    next.push(...this.manualRows(meeting));
    return reuse(previous, next, sameEntry);
  }

  /** The day's meetings started on their own, the current one left out: the sidebar shows that one by itself. */
  private manualRows(meeting: MeetingState | null): MeetingListEntry[] {
    const rows: MeetingListEntry[] = [];
    const date = this.state.daily.date;
    for (const [key, manual] of [...this.manualMeetings]) {
      if (this.gone(manual.path)) {
        this.manualMeetings.delete(key);
        continue;
      }
      if (manual.date !== date || meeting?.key === key) continue;
      rows.push({
        key,
        title: manual.title,
        rawTitle: manual.title,
        ordinal: 0,
        anchorLine: -1,
        isHeading: false,
        group: 'meeting',
        companionPath: manual.path,
        current: false,
      });
    }
    return rows;
  }

  /* ─────────────────────────────── Meetings ───────────────────────────── */

  /**
   * False, with a notice, the first time a recorded meeting that has no companion is about to be
   * left: its transcript is nowhere but in memory, and no audio is kept. The same request, made
   * again once the notice could be read and before it is forgotten, discards it; made at any
   * other moment it is refused like the first, with the notice again. Only speech counts:
   * bullets, a summary and answers can be made again.
   */
  private mayLeave(request: string, again: string): boolean {
    const state = this.state;
    const meeting = state.meeting;
    if (!meeting || meeting.companionPath !== null || state.turns.length === 0) {
      this.discardAsked = null;
      return true;
    }
    // With what was said so far: more speech since is not what the first request was warned about.
    const id = `${meeting.key}\n${request}\n${state.turns.length}`;
    const now = this.deps.clock.now();
    const asked = this.discardAsked;
    if (asked?.id === id) {
      const waited = now - asked.at;
      if (waited >= DISCARD_MIN_MS && waited <= DISCARD_MAX_MS) {
        this.discardAsked = null;
        return true;
      }
    }
    this.discardAsked = { id, at: now };
    this.notice(
      `This meeting is not saved yet. Create the companion note to keep it, or ${again} again to discard it.`,
    );
    return false;
  }

  /** Picks a meeting started on its own up again: it has no section, only its note. */
  private selectManual(key: string, manual: { title: string; date: string; path: string }): void {
    const state = this.state;
    if (state.meeting?.key === key) {
      this.patch({ tab: 'notes' });
      return;
    }
    if (state.recording !== 'idle') {
      this.notice('Stop the recording before switching to another meeting.');
      return;
    }
    if (!this.mayLeave(`select ${key}`, 'select the other meeting')) return;
    this.leaveMeeting();
    this.meetingDaily = state.daily;
    this.turnsNote = manual.path;
    this.patch({
      ...this.clearedMeetingState(),
      meeting: {
        key,
        title: manual.title,
        date: manual.date,
        manual: true,
        source: null,
        companionPath: manual.path,
        startedAt: null,
        endedAt: null,
        detachedRegions: [],
        cursorOutside: false,
      },
      tab: 'notes',
    });
    this.inspectCompanion(manual.path);
    this.derive();
  }

  private selectSection(requested: SectionKey): void {
    const state = this.state;
    const manual = this.manualMeetings.get(requested);
    if (manual && manual.date === state.daily.date && !this.gone(manual.path)) {
      this.selectManual(requested, manual);
      return;
    }
    const wanted = parseSectionKey(requested);
    // In its full form: a key given without its ordinal names the same section.
    const key = sectionKey(wanted);
    if (state.meeting?.key === key && this.meetingDailyShown()) {
      this.patch({ tab: 'notes' });
      return;
    }
    if (state.recording !== 'idle') {
      this.notice('Stop the recording before switching to another meeting.');
      return;
    }
    if (wanted.title === '') {
      this.notice('Give the section a title first.');
      return;
    }
    const text = this.dailyText;
    const section = text === null ? null : findSection(text, wanted, this.sectionOptions());
    if (!section) {
      this.notice("That section is no longer in today's note.");
      return;
    }
    if (!this.mayLeave(`select ${key}`, 'select the other meeting')) return;

    const daily = state.daily;
    const companion = this.companionOf(daily.date, section);
    this.leaveMeeting();
    this.meetingDaily = daily;
    this.section = section;
    this.turnsNote = companion;
    this.patch({
      ...this.clearedMeetingState(),
      meeting: {
        key,
        title: section.title,
        date: daily.date,
        manual: false,
        source: { title: section.title, ordinal: section.ordinal },
        companionPath: companion,
        startedAt: null,
        endedAt: null,
        detachedRegions: [],
        cursorOutside: false,
      },
      tab: 'notes',
    });
    if (companion) this.inspectCompanion(companion);
    this.derive();
  }

  private newMeeting(): void {
    const state = this.state;
    if (state.recording !== 'idle') {
      this.notice('Stop the recording before starting another meeting.');
      return;
    }
    if (!this.mayLeave('new', 'press New meeting')) return;
    const now = this.deps.clock.now();
    let key = `manual:${now}`;
    // Two meetings started in the same millisecond still need two keys.
    if (state.meeting?.key.startsWith(key)) key = `${key}.${++this.manualCount}`;
    this.leaveMeeting();
    this.meetingDaily = state.daily;
    this.patch({
      ...this.clearedMeetingState(),
      meeting: {
        key,
        title: `New meeting ${hhmm(new Date(now))}`,
        date: state.daily.date,
        manual: true,
        source: null,
        companionPath: null,
        startedAt: null,
        endedAt: null,
        detachedRegions: [],
        cursorOutside: false,
      },
      tab: 'notes',
    });
    this.derive();
  }

  private async linkAtCursor(): Promise<void> {
    const state = this.state;
    const meeting = state.meeting;
    if (!meeting || !meeting.manual) return;
    // The note in front is not the daily: the meeting goes there.
    if (!this.dailyFocused && this.focus) {
      await this.useActiveNote(false);
      return;
    }
    const target = state.activeSection;
    if (!target || target.title === '') {
      this.notice('Put the cursor in a section of your daily note, or open the note to use and press "Use this note".');
      return;
    }
    const key = sectionKey(target);
    const existing = meeting.companionPath === null ? this.companionOf(state.daily.date, target) : null;
    // Its note was created under the manual key: the section's row has to find it all the same.
    if (meeting.companionPath !== null) this.rekey(state.daily.date, meeting.key, key, meeting.companionPath);
    // It has a section from now on, and is listed with it.
    this.manualMeetings.delete(meeting.key);
    this.section = target;
    this.meetingDaily = state.daily;
    this.patch({
      meeting: {
        ...meeting,
        key,
        title: target.title,
        manual: false,
        source: { title: target.title, ordinal: target.ordinal },
      },
    });
    this.derive();
    if (existing) {
      // The section already has a note: what was recorded so far belongs in it.
      await this.adoptCompanion(existing);
      return;
    }
    // Its own note was created without a line in the daily: it had no section to put one in.
    // Now it has, and the line is what ties the two together once this session is over.
    // Not for a note deleted behind the plugin's back: the line would link to nothing.
    const own = meeting.companionPath;
    if (own === null || this.gone(own)) return;
    const now = this.state.meeting;
    if (now?.key === key && now.companionPath === own) await this.ensureDailyLink(own);
  }

  /**
   * The note in front (not the daily) holds the meeting: the section under the cursor, or the
   * whole note. `wholeNote` asks for the whole note whatever the cursor (one-file meetings).
   */
  private async useActiveNote(wholeNote: boolean): Promise<void> {
    const state = this.state;
    const focus = this.focus;
    if (!focus || this.dailyFocused) {
      this.notice('Open the note to use in the main area first, then press "Use this note".');
      return;
    }
    const path = focus.path;
    const s = this.deps.settings();
    const basename = basenameOf(path);
    if (path === state.meeting?.companionPath && state.meeting.notePath !== path) {
      this.notice("That is this meeting's companion note: type your notes in another note.");
      return;
    }
    if (basename.startsWith(s.companionPrefix) && !this.ownMeetingNote(focus.text)) {
      this.notice('That note is a companion note of a meeting: type your notes in another note.');
      return;
    }
    const opts = this.sectionOptions();
    const at = !wholeNote && focus.cursor !== null ? sectionAt(focus.text, focus.cursor, opts) : null;
    const section = at && at.title !== '' ? { title: at.title, ordinal: at.ordinal } : null;
    const title = section ? section.title : basename;
    const key = section ? `note:${path}#${sectionKey(section)}` : `note:${path}`;
    const meeting = state.meeting;
    if (meeting?.key === key) {
      this.patch({ tab: 'notes' });
      return;
    }

    if (meeting?.manual) {
      // A meeting started with "New meeting", recording or not, moves into the note.
      const companion = meeting.companionPath && !this.gone(meeting.companionPath) ? meeting.companionPath : null;
      this.manualMeetings.delete(meeting.key);
      if (companion) this.rekey(meeting.date, meeting.key, key, companion);
      this.noteText = focus.text;
      this.patch({
        meeting: { ...meeting, key, title, manual: false, source: null, notePath: path, noteSection: section },
        tab: 'notes',
      });
      this.derive();
      if (companion) {
        await this.ensureNoteLink(companion);
        return;
      }
      const existing = this.noteCompanion(meeting.date, key, focus.text, path, section, title);
      if (existing) await this.adoptCompanion(existing);
      return;
    }

    if (meeting && state.recording !== 'idle') {
      this.notice('Stop the recording before moving to a meeting in another note.');
      return;
    }
    if (meeting && !this.mayLeave(`note ${key}`, 'use the other note')) return;
    const daily = state.daily;
    const companion = this.noteCompanion(daily.date, key, focus.text, path, section, title);
    this.leaveMeeting();
    this.meetingDaily = daily;
    this.section = null;
    this.turnsNote = companion;
    this.noteText = focus.text;
    this.patch({
      ...this.clearedMeetingState(),
      meeting: {
        key,
        title,
        date: daily.date,
        manual: false,
        source: null,
        notePath: path,
        noteSection: section,
        companionPath: companion,
        startedAt: null,
        endedAt: null,
        detachedRegions: [],
        cursorOutside: false,
      },
      tab: 'notes',
    });
    if (companion) this.inspectCompanion(companion);
    this.derive();
  }

  /** True for a note that is its own meeting note: its frontmatter names a meeting and it holds the plugin's sections. */
  private ownMeetingNote(text: string): boolean {
    return /^hamster_source:/m.test(text.slice(0, 4000)) && text.includes('<!-- hamster:begin');
  }

  /**
   * The companion of a meeting typed in a note: the note itself when it is its own meeting note,
   * the note its frontmatter key names, or the one its link line points to.
   */
  private noteCompanion(
    date: string,
    key: string,
    text: string,
    path: string,
    section: { title: string; ordinal: number } | null,
    title: string,
  ): string | null {
    if (this.ownMeetingNote(text)) return path;
    const keyed = this.keyedCompanion(date, key) ?? this.rememberedCompanion(date, key);
    if (keyed) return keyed;
    const opts = this.sectionOptions();
    const found = section ? findSection(text, section, opts) : wholeNoteSection(text, title, opts);
    if (!found) return null;
    const lines = text.split('\n');
    for (let i = found.bodyStartLine; i < Math.min(found.bodyEndLine, lines.length); i++) {
      if (!isLinkLine(lines[i], opts.linkPrefix)) continue;
      const target = wikilinks(lines[i])[0];
      if (target === undefined) continue;
      const leaf = target.slice(target.lastIndexOf('/') + 1).replace(/\.md$/, '');
      try {
        const linked = this.deps.notes.findCompanionByBasename(leaf, path);
        if (linked) return linked;
      } catch {
        // Not found that way: nothing to adopt.
      }
    }
    return null;
  }

  /** The note in front becomes the meeting note itself: the plugin's sections go below its text. */
  private async writeIntoActiveNote(): Promise<void> {
    const focus = this.focus;
    if (!focus || this.dailyFocused) {
      this.notice('Open the note to write the meeting into first. The daily note cannot hold one.');
      return;
    }
    await this.useActiveNote(true);
    const meeting = this.state.meeting;
    if (!meeting || meeting.notePath !== focus.path || meeting.noteSection) return;
    const path = focus.path;
    if (meeting.companionPath === path) {
      this.notice('This note already holds the meeting.');
      return;
    }
    if (meeting.companionPath !== null) {
      this.notice(`This meeting already has its companion note: ${meeting.companionPath}`);
      return;
    }
    const accepted = await this.deps.notes.confirmFirstWrite({
      companionPath: path,
      linkLine: '',
      intoNote: true,
      where:
        "Below your text: four sections (Enhanced notes, AI summary, Q&A insights, Transcript). In the properties: type, tags and hamster_source are added, and date is set to the meeting's day.",
    });
    if (!accepted || this.state.meeting?.key !== meeting.key) return;
    this.deps.setLocal({ firstWriteConfirmed: true });
    let result: Awaited<ReturnType<SessionDeps['notes']['prepareMeetingNote']>>;
    try {
      result = await this.deps.notes.prepareMeetingNote(path, { date: meeting.date, source: meeting.key });
    } catch {
      result = 'busy';
    }
    if (this.state.meeting?.key !== meeting.key) return;
    if (result === 'missing') {
      this.notice('That note is no longer there.');
      return;
    }
    if (result === 'busy') {
      this.notice('The note is being edited: try again in a moment.');
      return;
    }
    // Read again: what the editor binding reports of the plugin's own edit may not have come yet.
    try {
      const text = await this.deps.notes.readNote(path);
      if (text !== null) this.noteText = text;
    } catch {
      // The editor binding will bring it.
    }
    this.bindCompanion(path, result === 'done');
    this.saveEverything();
    this.derive();
  }

  /** Adds the link line of a meeting typed in another note to that note, unless it is there. */
  private async ensureNoteLink(path: string): Promise<void> {
    const meeting = this.state.meeting;
    const notePath = meeting?.notePath;
    // A note that is its own meeting note links to nothing.
    if (!meeting || !notePath || path === notePath) return;
    const s = this.deps.settings();
    const basename = basenameOf(path);
    const line = dailyLinkLine(basename, s.dailyLinkAlias);
    if (!isLinkLine(line, s.companionPrefix)) return;
    let added: Awaited<ReturnType<SessionDeps['notes']['insertNoteLink']>>;
    try {
      added = await this.deps.notes.insertNoteLink({
        path: notePath,
        section: meeting.noteSection ?? null,
        title: meeting.title,
        companionBasename: basename,
        line,
        placement: s.dailyLinkPlacement,
      });
    } catch {
      this.notice(LINK_NOT_ADDED_NOTE);
      return;
    }
    if (added.status === 'exists') return;
    if (added.status !== 'inserted') {
      this.notice(LINK_NOT_ADDED_NOTE);
      return;
    }
    if (added.via === 'vault') this.notice(`Added to ${notePath}: ${line}`);
    try {
      const text = await this.deps.notes.readNote(notePath);
      if (text !== null && this.state.meeting?.notePath === notePath) {
        this.noteText = text;
        this.derive();
      }
    } catch {
      // The editor binding will bring it.
    }
  }

  private async endMeeting(): Promise<void> {
    // Seen by a stop that is still saving: it starts no summary either.
    this.ending += 1;
    try {
      // A start still under way is cancelled, not waited for: its source may take its time, or never answer.
      if (this.state.recording === 'starting') await this.stopRecording(false);
      else if (this.recordingOp) await this.recordingOp;
      // No summary: the meeting it would be written for is about to be cleared.
      if (this.state.recording === 'recording') await this.stopRecording(false);
      const meeting = this.state.meeting;
      if (!meeting) return;
      if (!this.mayLeave('end', 'press End')) return;
      // One more try for what a failed write dropped.
      this.sendDropped();
      await this.writeQueue.flush();
      if (this.closed || this.state.meeting?.key !== meeting.key || this.state.recording !== 'idle') return;
      this.leaveMeeting();
      this.patch({ ...this.clearedMeetingState(), meeting: null });
      this.derive();
    } finally {
      this.ending -= 1;
    }
  }

  private openCompanion(): void {
    const path = this.state.meeting?.companionPath;
    if (!path) return;
    if (this.deps.notes.exists(path)) this.deps.notes.openNote(path);
    else this.companionMissing(path);
  }

  private openDaily(): void {
    const daily = this.deps.notes.today();
    this.patchDaily(daily);
    if (this.deps.notes.exists(daily.path)) this.deps.notes.openNote(daily.path);
  }

  /** Stops everything that belongs to the current meeting. The state is cleared by the caller. */
  private leaveMeeting(): void {
    const old = this.state.meeting;
    // What a batch that was given up carried is nowhere but in memory, which is about to be
    // cleared: one more try, while the meeting still points at its note.
    if (this.resend && old?.companionPath) this.safely(() => this.sendDropped());
    this.cancel(this.resendTimer);
    this.resendTimer = null;
    this.cancelGeneration();
    this.enhance.reset();
    this.transcriptIndex.reset();
    this.transcriptIndex = this.newTranscriptIndex();
    this.searchable = 0;
    this.excerpts.clear();
    this.section = null;
    this.offsetSec = 0;
    this.turnCount = 0;
    this.resumeNote = null;
    this.priorTranscript = false;
    this.separators = new Map();
    this.lastFinal.clear();
    this.savedTurns = 0;
    this.takenTurns = 0;
    this.writtenTurns = 0;
    this.companionEpoch += 1;
    this.failedBatch = null;
    this.savedEnhanced = null;
    this.qaPrefix = null;
    this.qaNote = null;
    this.qaSent.clear();
    this.qaFolded.clear();
    this.forgetNote();
    this.enhancedSent = null;
    this.noteInspected = false;
    this.priorEnhanced = false;
    this.earlierBullets = false;
    this.priorSummary = false;
    this.enhanceAsked = false;
    this.earlierNotesNoticed = false;
    this.earlierSummaryNoticed = false;
    this.noSummaryNoticed = false;
    this.inspecting = false;
    this.inspection = Promise.resolve();
    this.meetingEpoch += 1;
    this.missingNoticed = false;
    this.writeErrorNoticed = false;
    this.resend = false;
    this.turnsNote = null;
    this.discardAsked = null;
    // The note changed all through the meeting; now that it is over, it can be searched like any other.
    if (old?.companionPath) this.indexWhenWritten(old.companionPath);
  }

  private clearedMeetingState(): Partial<HamsterState> {
    const state = this.state;
    const idle = state.summary.status === 'idle' && state.summary.markdown === '' && state.summary.error === null;
    // A missing runtime is a fact about this Mac; how the last recording ended belongs to the meeting.
    const installed = state.stt !== 'not-installed';
    return {
      turns: state.turns.length > 0 ? [] : state.turns,
      partial: null,
      elapsedMs: 0,
      micLevel: 0,
      recordingError: null,
      stt: installed ? 'idle' : state.stt,
      sttMessage: installed ? null : state.sttMessage,
      enhanced: state.enhanced.length > 0 ? [] : state.enhanced,
      enhanceStatus: 'idle',
      enhanceError: null,
      summary: idle ? state.summary : emptySummary(state.summary.style),
      qa: state.qa.entries.length > 0 || state.qa.chips.length > 0 ? { entries: [], chips: [] } : state.qa,
    };
  }

  private cancelGeneration(): void {
    const summary = this.summaryRun;
    this.summaryRun = null;
    if (summary) {
      summary.stream.cancel();
      summary.abort.abort();
    }
    const asks = [...this.asks.values()];
    this.asks.clear();
    for (const ask of asks) {
      ask.stream.cancel();
      ask.abort.abort();
    }
  }

  private indexWhenWritten(path: string): void {
    const index = this.vaultIndex;
    if (!index) return;
    void this.writeQueue
      .flush(path)
      .then(() => {
        if (this.closed) return undefined;
        // Deleted in the meantime: reading it would only leave an error on the index.
        return this.gone(path) ? index.removeFile(path) : index.updateFile(path);
      })
      .catch(() => undefined);
  }

  /* ────────────────────────────── The companion ───────────────────────── */

  private async createCompanion(): Promise<void> {
    const meeting = this.state.meeting;
    if (!meeting) {
      this.notice(NO_MEETING);
      return;
    }
    // A second click while the confirmation is open must not create a second note.
    if (this.creating) return;
    this.creating = true;
    try {
      await this.createOrAdopt(meeting);
    } catch (e) {
      this.notice(`The companion note could not be created. ${describeError(e)}`);
    } finally {
      this.creating = false;
    }
  }

  private async createOrAdopt(meeting: MeetingState): Promise<void> {
    const { notes } = this.deps;
    const s = this.deps.settings();
    const sameMeeting = (): boolean => !this.closed && this.state.meeting?.key === meeting.key;

    const attached =
      meeting.companionPath !== null && notes.exists(meeting.companionPath) ? meeting.companionPath : null;
    const existing = attached ?? this.meetingCompanion(meeting);
    if (existing) {
      await this.adoptCompanion(existing);
      // Asked for by name, unlike a selection: the one way to get the line back when adding it failed.
      if (sameMeeting() && this.state.meeting?.companionPath === existing) await this.ensureDailyLink(existing);
      return;
    }

    const section = meeting.source ? this.section : null;
    const { attendees, projects } = section
      ? classifyHeading(section.rawTitle, section.links, this.entities)
      : { attendees: [], projects: [] };
    const path = companionPath(
      s.companionFolder,
      companionBasename(s.companionPrefix, meeting.date, meeting.title),
      (candidate) => notes.exists(candidate),
    );
    // Taken from the path: a name that was already used carries a ` (2)` the link must carry too.
    const basename = basenameOf(path);
    const line = dailyLinkLine(basename, s.dailyLinkAlias);

    if (!this.deps.local().firstWriteConfirmed) {
      const inNote = meeting.notePath !== undefined;
      const linked = inNote || (meeting.source !== null && this.linkableToday());
      const accepted = await notes.confirmFirstWrite({
        companionPath: path,
        linkLine: linked ? line : '',
        ...(inNote ? { lineNote: basenameOf(meeting.notePath ?? '') } : {}),
        where: !linked
          ? NO_LINK_LINE
          : inNote
            ? meeting.noteSection
              ? `end of the section “${meeting.title}” in ${meeting.notePath}`
              : `end of the note ${meeting.notePath}`
            : this.describePlacement(meeting, section, s.dailyLinkPlacement),
      });
      if (!accepted) return;
      this.deps.setLocal({ firstWriteConfirmed: true });
      if (!sameMeeting()) return;
    }

    // The note the meeting pointed at is gone. Lines still queued for it would be written into
    // the new one if it takes the same path, on top of everything that is sent again below.
    if (meeting.companionPath !== null) this.patchMeeting({ companionPath: null, detachedRegions: [] });
    await this.writeQueue.flush(path);
    if (!sameMeeting()) return;

    await notes.createCompanion(
      path,
      renderCompanion({
        title: meeting.title,
        date: meeting.date,
        attendees,
        projects,
        dailyBasename: meeting.notePath ? basenameOf(meeting.notePath) : this.meetingDaily.basename,
        source: meeting.key,
        properties: companionPropertiesOf(this.deps.settings()),
      }),
    );
    this.writeQueue.hold(path, NEW_COMPANION_HOLD_MS);
    if (!sameMeeting()) return;
    this.bindCompanion(path, true);
    // Queued before the link is added: that can take seconds, and the meeting may be left
    // meanwhile. The queue then still carries to the note what was asked to be kept.
    this.saveEverything();

    const source = this.state.meeting?.source;
    if (source) {
      let failed = !this.linkableToday();
      if (!failed) {
        try {
          const result = await notes.insertDailyLink({
            section: source,
            companionBasename: basename,
            line,
            placement: s.dailyLinkPlacement,
          });
          if (result.status === 'inserted' && result.via === 'vault') {
            this.notice(`Added to your daily note: ${line}`);
          }
          failed = result.status === 'no-daily' || result.status === 'no-section';
        } catch {
          failed = true;
        }
      }
      if (failed) {
        this.notice('The companion note was created, but its link could not be added to your daily note.');
      }
      // The plugin's own edit is not reported back by the editor binding.
      await this.readDaily();
    } else if (this.state.meeting?.notePath) {
      await this.ensureNoteLink(path);
    } else {
      this.derive();
    }
    if (sameMeeting()) this.saveEverything();
  }

  /** The host adds the link to today's daily only: a meeting of another day gets its note without the line. */
  private linkableToday(): boolean {
    return this.meetingDaily.date === this.deps.notes.today().date;
  }

  /** Adds the line of a note that already exists to its section, unless it is there. */
  private async ensureDailyLink(path: string): Promise<void> {
    if (this.state.meeting?.notePath) {
      await this.ensureNoteLink(path);
      return;
    }
    const source = this.state.meeting?.source;
    if (!source || !this.linkableToday()) return;
    const s = this.deps.settings();
    const basename = basenameOf(path);
    const line = dailyLinkLine(basename, s.dailyLinkAlias);
    // A note renamed out of the plugin's naming would get a line the plugin does not know
    // for its own: it would be read as shorthand, and added again at every call.
    if (!isLinkLine(line, s.companionPrefix)) return;
    let added: Awaited<ReturnType<SessionDeps['notes']['insertDailyLink']>>;
    try {
      added = await this.deps.notes.insertDailyLink({
        section: source,
        companionBasename: basename,
        line,
        placement: s.dailyLinkPlacement,
      });
    } catch {
      this.notice(LINK_NOT_ADDED);
      return;
    }
    if (added.status === 'exists') return;
    if (added.status !== 'inserted') {
      this.notice(LINK_NOT_ADDED);
      return;
    }
    if (added.via === 'vault') this.notice(`Added to your daily note: ${line}`);
    // The plugin's own edit is not reported back by the editor binding.
    await this.readDaily();
  }

  private describePlacement(
    meeting: MeetingState,
    section: Section | null,
    placement: 'section-end' | 'heading',
  ): string {
    const where = `“${meeting.title}” in ${this.meetingDaily.path}`;
    if (placement === 'heading') {
      return `directly under the ${section && !section.isHeading ? 'line' : 'heading'} ${where}`;
    }
    return `end of the section ${where}`;
  }

  /** Points the meeting at a note that already exists and saves to it what is in memory. */
  private async adoptCompanion(path: string): Promise<void> {
    const key = this.state.meeting?.key;
    const again = this.state.meeting?.companionPath === path;
    let note: string | null = null;
    try {
      note = await this.deps.notes.readCompanion(path);
    } catch {
      note = null;
    }
    // A read started when the meeting was selected may still be on its way.
    await this.inspection;
    if (this.closed || this.state.meeting?.key !== key) return;
    // The regions the user was told are set aside for an edit by hand: asked for again, they are
    // to be replaced with what the sidebar shows.
    let asked: readonly Region[] = NO_REGIONS;
    if (note !== null) {
      // Asked for by name on a note that was edited by hand: what can be taken in is, and the
      // rest is replaced with what the sidebar shows. Another note is met as it is.
      if (again) {
        asked = this.state.meeting?.editedOutside ?? NO_REGIONS;
        this.lookAtNote(note, true);
      } else {
        this.forgetNote();
      }
      this.rememberNote(note);
    }
    // Another note than the one this visit has been saving to, which is gone: what it holds of an
    // earlier visit is no more this visit's to replace than if it had been met first.
    const another = this.noteInspected && !again && note !== null && !this.ownNote(note);
    if (!this.noteInspected || another) {
      this.noteInspected = true;
      this.priorTranscript = hasTranscriptLines(note);
      // What was asked for before the note was met was asked of a meeting that had nothing to replace.
      this.enhanceAsked = false;
      if (another) {
        // And what was said of the note that is gone was not said of this one.
        this.earlierNotesNoticed = false;
        this.earlierSummaryNoticed = false;
        this.noSummaryNoticed = false;
      }
      this.metEarlierWork(note);
      // What was recorded before the note was adopted goes in after what the note already holds.
      const meeting = this.state.meeting;
      if (this.priorTranscript && this.state.turns.length > 0 && !this.separators.has(0)) {
        this.separators.set(0, resumeLine(meeting?.startedAt ?? this.deps.clock.now()));
      }
    }
    const held = qaContentOf(note);
    if (this.qaPrefix === null) {
      // Still unknown when the one read failed or found the region damaged: this read may tell.
      this.qaPrefix = held;
    } else if (path !== this.qaNote && held !== null && held !== this.qaPrefix && !this.qaSent.has(held)) {
      // Not the note this session has been writing to, found again under another path: another
      // note of the same meeting. What it holds was never read, and must not be replaced either.
      this.qaPrefix = held;
      this.qaFolded.clear();
    }
    if (this.qaPrefix !== null) this.qaNote = path;
    // Known before the first write: a region whose markers are damaged is not written to, and one
    // whose markers were repaired is written to again. A note that could not be read told nothing.
    const known = again ? (this.state.meeting?.detachedRegions ?? []) : [];
    const damaged = note === null ? known : REGIONS.filter((region) => readRegion(note, region) === null);
    if (!again && note !== null && this.writtenTurns > 0 && !this.holdsWrittenTurns(note)) {
      // Not the note the lines were written to, found again: another note, and that one is gone.
      // None of them is in this one, so they all go again, after whatever it holds already.
      this.writtenTurns = 0;
      // Also when it stands at the path of the one that is gone, with lines still queued for
      // that path: the count starts from the first line all the same. A line the queue still
      // holds is then written twice, where the lines before it would not be written at all.
      this.turnsNote = null;
      if (hasTranscriptLines(note)) {
        this.priorTranscript = true;
        if (!this.separators.has(0)) {
          this.separators.set(0, resumeLine(this.state.meeting?.startedAt ?? this.deps.clock.now()));
        }
      }
    }
    this.bindCompanion(path, false, damaged);
    this.derive();
    this.saveEverything(asked);
    if (again && note !== null && damaged.length > 0) {
      const regions = damaged.join(', ');
      this.notice(
        `The companion note is still damaged (${regions}). Restore its markers, or delete the note and create it again.`,
      );
    }
  }

  /**
   * True when the note holds something this session put there in this meeting: the note it has
   * been saving to, wherever it is found again. Its first line of transcript, a version of the
   * insights it sent, the enhanced notes it sent last, or the very summary the sidebar shows.
   * A note that holds none of them is taken for another: it is met as a note of an earlier visit.
   */
  private ownNote(note: string): boolean {
    if (this.writtenTurns > 0 && readRegion(note, 'transcript') !== null && this.holdsWrittenTurns(note)) return true;
    const insights = qaContentOf(note);
    if (insights !== null && insights !== '' && this.qaSent.has(insights)) return true;
    const enhanced = readRegion(note, 'enhanced');
    const sent = this.enhancedSent?.content ?? '';
    if (enhanced !== null && sent !== '' && sameText(regionText(enhanced), sent)) return true;
    const summary = readRegion(note, 'summary');
    const shown = this.summaryContent();
    return summary !== null && shown !== null && sameText(regionText(summary), regionText(shown));
  }

  /**
   * True when the note's transcript holds the first line this session wrote: the note the lines
   * went to, whatever its path is now. A line whose label or text was changed since is not found;
   * the lines are then sent again, which doubles them where the other mistake would lose them.
   */
  private holdsWrittenTurns(note: string): boolean {
    const region = readRegion(note, 'transcript');
    // Damaged: nothing is written there, and nothing can be told.
    if (region === null) return true;
    const labels = this.labels();
    const turns = this.state.turns;
    for (let i = 0; i < this.writtenTurns && i < turns.length; i++) {
      const line = turnLine(turns[i], labels);
      if (line !== '') return region.replace(/\r\n?/g, '\n').split('\n').includes(line);
    }
    return true;
  }

  private bindCompanion(path: string, fresh: boolean, damaged: Region[] = []): void {
    const meeting = this.state.meeting;
    if (!meeting) return;
    const moved = meeting.companionPath !== path;
    if (fresh) {
      this.writtenTurns = 0;
      this.qaPrefix = '';
      this.qaNote = path;
      this.qaFolded.clear();
      // A new note: its regions are empty.
      this.forgetNote();
      for (const region of REPLACED) this.noteHeld.set(region, '');
      this.noteBulletIds = [];
      this.noteInspected = true;
      this.priorTranscript = false;
      this.priorEnhanced = false;
      this.earlierBullets = false;
      this.priorSummary = false;
    }
    // What was queued for another path died with it, and what a batch lost can go again. Only
    // lines still waiting in the queue for this same note must not be handed over a second time:
    // also when the note was reported missing meanwhile, and is back where it was.
    if (fresh || this.turnsNote !== path || this.takenTurns === this.savedTurns) {
      this.savedTurns = this.writtenTurns;
      this.takenTurns = this.writtenTurns;
      this.companionEpoch += 1;
    }
    this.turnsNote = path;
    if (fresh || moved) {
      this.savedEnhanced = null;
      this.missingNoticed = false;
      this.writeErrorNoticed = false;
    }
    // Regions that were damaged get another chance: their markers may have been repaired since.
    this.patchMeeting({
      companionPath: path,
      detachedRegions: sameList(meeting.detachedRegions, damaged) ? meeting.detachedRegions : damaged,
    });
    if (meeting.manual) this.manualMeetings.set(meeting.key, { title: meeting.title, date: meeting.date, path });
  }

  /* ───────────────────── The companion, edited by hand ─────────────────── */

  /** Nothing is known of the note in hand any more: another note, or none. */
  private forgetNote(): void {
    this.noteHeld.clear();
    this.flying.clear();
    this.stale.clear();
    this.unsaid.clear();
    this.noteBulletIds = null;
    this.noteCheckTries = 0;
    this.cancel(this.noteCheck);
    this.noteCheck = null;
    this.noteEpoch += 1;
    if ((this.state.meeting?.editedOutside ?? NO_REGIONS).length > 0) this.patchMeeting({ editedOutside: [] });
  }

  /** The note as it was just read is what later versions are compared with. */
  private rememberNote(note: string): void {
    for (const region of REPLACED) {
      const content = readRegion(note, region);
      if (content === null) this.noteHeld.delete(region);
      else this.noteHeld.set(region, regionText(content));
    }
  }

  private scheduleNoteCheck(): void {
    this.cancel(this.noteCheck);
    this.noteCheck = this.later(() => {
      this.noteCheck = null;
      void this.checkNote();
    }, NOTE_CHECK_MS);
  }

  /** Reads the note once it has settled after a change, and sees what the change was. */
  private async checkNote(): Promise<void> {
    const path = this.state.meeting?.companionPath;
    if (!path || this.closed) return;
    const epoch = this.noteEpoch;
    let note: string | null = null;
    try {
      note = await this.deps.notes.readCompanion(path);
    } catch {
      note = null;
    }
    if (this.closed || epoch !== this.noteEpoch || this.state.meeting?.companionPath !== path) return;
    // Not known: it is read again before anything is replaced.
    if (note === null) return;
    const text = note;
    this.safely(() => this.lookAtNote(text));
  }

  /**
   * Compares the note with what the plugin last wrote or read, region by region, and returns the
   * regions that hold something else: edited by hand. A corrected bullet goes into the engine and
   * edited insights become what later ones are added to, so that nothing saved afterwards undoes
   * them. An edit that cannot be taken in sets its region aside: the plugin stops writing there.
   * With `adopting`, the user has asked for the note to be taken as it is: nothing stays set aside.
   */
  private lookAtNote(note: string, adopting = false): Replaced[] {
    const meeting = this.state.meeting;
    if (!meeting) return [];
    const before = (meeting.editedOutside ?? NO_REGIONS) as Replaced[];
    const aside = new Set<Replaced>(before);
    const changed: Replaced[] = [];
    let busy = false;
    for (const region of REPLACED) {
      const content = readRegion(note, region);
      // Damaged markers are the write's own business: it reports them.
      if (content === null) continue;
      const now = regionText(content);
      const held = this.noteHeld.get(region);
      if (held === undefined) {
        this.noteHeld.set(region, now);
        continue;
      }
      if (sameText(now, held)) {
        aside.delete(region);
        continue;
      }
      // The write that is out put it there, and has not reported back yet.
      const out = this.flying.get(region);
      if (out !== undefined && sameText(now, out)) continue;
      changed.push(region);
      let taken = false;
      if (region === 'qa') {
        taken = this.takeEditedInsights(now, held);
      } else if (region === 'enhanced') {
        const outcome = this.takeEditedBullets(now, held);
        taken = outcome === 'taken';
        busy = outcome === 'busy';
      }
      if (taken) {
        this.noteHeld.set(region, now);
        aside.delete(region);
      } else {
        aside.add(region);
      }
    }
    if (adopting) aside.clear();
    const next = REPLACED.filter((region) => aside.has(region));
    if (!sameList(before, next)) this.patchMeeting({ editedOutside: next });
    // A bullet that only waits for its line to be written is taken in a moment: looked at again
    // then, and nothing is said of it meanwhile.
    const waiting = busy && !adopting && this.noteCheckTries < NOTE_CHECK_RETRIES;
    const toSay = next.filter(
      (region) => (!before.includes(region) || this.unsaid.has(region)) && !(waiting && region === 'enhanced'),
    );
    this.unsaid.clear();
    if (waiting && next.includes('enhanced')) this.unsaid.add('enhanced');
    if (toSay.length > 0) this.notice(editedNotice(toSay));
    if (waiting) {
      this.noteCheckTries += 1;
      this.scheduleNoteCheck();
    } else {
      this.noteCheckTries = 0;
    }
    if (!adopting) {
      // What was taken in may leave something to write: a newer bullet, an answer kept since.
      if (changed.includes('enhanced') && !aside.has('enhanced')) this.saveEnhanced();
      if (changed.includes('qa')) this.saveInsights();
    }
    return changed;
  }

  /**
   * Bullets edited in the note go into the engine, each to the line it was written for. Only
   * when the note still holds one bullet per bullet written: a line added or removed by hand,
   * or other text between them, is nothing the engine can carry.
   */
  private takeEditedBullets(now: string, held: string): 'taken' | 'busy' | 'no' {
    const ids = this.noteBulletIds;
    const edited = bulletsIn(now);
    const written = bulletsIn(held);
    if (!ids || !edited || !written || edited.length !== ids.length || written.length !== ids.length) return 'no';
    let any = false;
    let busy = false;
    for (let i = 0; i < ids.length; i++) {
      if (edited[i] === written[i]) continue;
      any = true;
      // A task is the user's line: ticked in the companion instead, the mark cannot be carried back to it.
      if (leadingTaskMark(edited[i]) !== leadingTaskMark(written[i])) return 'no';
      const text = withoutTaskMark(edited[i]);
      // Taken in only if the next save writes it back as the user left it.
      if (!this.writtenAsIs(text)) return 'no';
      if (this.enhance.setBullet(ids[i], text)) continue;
      // Being written right now, or its line is gone from the daily.
      if (this.state.enhanced.some((item) => item.id === ids[i] && item.streaming)) busy = true;
      else return 'no';
    }
    if (busy) return 'busy';
    // Nothing but the bullets may differ: a heading or a paragraph changed by hand cannot be carried.
    return any && this.sanitizedBulletsMatch(now, held, edited, written) ? 'taken' : 'no';
  }

  /** What the companion's enhanced notes would hold now: tasks as checkboxes only when the user asked for them. */
  private enhancedMarkdown(): string {
    return this.enhance.markdown(this.deps.settings().actionItemsAsTasks);
  }

  /** True when a bullet read from the note would go back into it unchanged: the engine and the sanitizer leave it alone. */
  private writtenAsIs(bullet: string): boolean {
    return this.sanitized(`- ${cleanBullet(bullet)}`) === `- ${bullet}`;
  }

  /** True when `now` is `held` with only its bullets changed. */
  private sanitizedBulletsMatch(now: string, held: string, edited: string[], written: string[]): boolean {
    let at = 0;
    const rebuilt = held
      .split('\n')
      .map((line) => {
        if (!/^- \S/.test(line.trimEnd())) return line;
        const i = at;
        at += 1;
        return written[i] === edited[i] ? line : `- ${edited[i]}`;
      })
      .join('\n');
    return sameText(rebuilt, now);
  }

  /**
   * Insights edited in the note: the region as it is now becomes what later insights are added
   * to, and the answers it already carried are not added a second time.
   */
  private takeEditedInsights(now: string, held: string): boolean {
    for (const id of this.qaSent.get(held) ?? []) this.qaFolded.add(id);
    this.qaPrefix = now;
    this.qaNote = this.state.meeting?.companionPath ?? this.qaNote;
    return true;
  }

  /** True for a batch that replaces a region of the note in hand. One that only adds lines to the transcript undoes nothing. */
  private needsVetting(path: string, patches: Patch[]): boolean {
    return this.state.meeting?.companionPath === path && patches.some((patch) => patch.region !== 'transcript');
  }

  /**
   * What a batch may write: not a region that was edited by hand since the plugin last saw it.
   * The note is read first, every time and not only once the vault has reported a change: an
   * edit typed in the note's own editor is reported when Obsidian saves it, two seconds after
   * the last keystroke, and until then the write would go straight into the text being typed.
   */
  private async vetted(path: string, patches: Patch[]): Promise<Patch[]> {
    const current = (): boolean => this.state.meeting?.companionPath === path;
    let changed: Region[] = [];
    const epoch = this.noteEpoch;
    let note: string | null = null;
    try {
      note = await this.deps.notes.readCompanion(path);
    } catch {
      note = null;
    }
    // A note that could not be read told nothing: what is known of it stands.
    if (note !== null && epoch === this.noteEpoch && current() && !this.closed) changed = this.lookAtNote(note);
    if (!current()) return patches;
    const aside = this.state.meeting?.editedOutside ?? NO_REGIONS;
    // What was taken in is queued again by now, as it should be written; the rest stays as the user left it.
    return patches.filter((patch) => {
      if (patch.region === 'transcript') return true;
      if (changed.includes(patch.region)) this.stale.set(patch.region, patch.content);
      return this.stale.get(patch.region) !== patch.content && !aside.includes(patch.region);
    });
  }

  /**
   * Reads the note once: what its `qa` region already holds, so that kept insights are
   * added to it, and whether it has a transcript that a new recording must be set apart from.
   */
  private inspectCompanion(path: string): void {
    if (this.noteInspected) return;
    this.noteInspected = true;
    // Until the note has been read, it is taken to hold the work of an earlier visit.
    this.metEarlierWork(null);
    const epoch = this.meetingEpoch;
    this.inspecting = true;
    this.inspection = (async () => {
      let note: string | null = null;
      try {
        note = await this.deps.notes.readCompanion(path);
      } catch {
        note = null;
      }
      if (epoch !== this.meetingEpoch) return;
      this.inspecting = false;
      this.qaPrefix = qaContentOf(note);
      this.qaNote = path;
      this.priorTranscript = hasTranscriptLines(note);
      if (this.closed) return;
      this.safely(() => {
        // A read that failed told nothing: the note keeps the benefit of the doubt.
        if (note !== null) {
          this.rememberNote(note);
          this.metEarlierWork(note);
        }
        // What was written while the note was being read was held back until now.
        this.saveEnhanced();
        this.saveSummary();
      });
    })();
  }

  /**
   * What the note holds of an earlier visit, when this visit meets it. A note that was not read
   * (not yet, or not at all) is taken to hold both: nothing is replaced unseen. Bullets that are
   * one per line of the section are handed to the engine: the lines then have their notes, and
   * what the engine holds is what the note holds.
   */
  private metEarlierWork(note: string | null): void {
    this.priorSummary = note === null || hasSummary(note);
    this.earlierBullets = note === null || hasBullets(note);
    this.priorEnhanced = this.earlierBullets;
    const bullets = note === null ? null : savedBulletsOf(note);
    if (bullets === null || bullets.length === 0) return;
    // Only bullets that would be written back as they stand: one with a link typed by hand, say,
    // is the user's text, and stays where it is until Enhance is asked to replace it.
    if (!bullets.every((bullet) => this.writtenAsIs(bullet))) return;
    let seeded = false;
    this.seeding = true;
    try {
      seeded = this.enhance.seed(bullets);
    } finally {
      this.seeding = false;
    }
    /* The engine refuses lines that already have a bullet. When what it holds is exactly what
       the note holds (the meeting's own note, found again after it was moved), there is nothing
       to hand over and nothing of an earlier visit to protect. */
    const written = bulletsIn(this.sanitized(this.enhancedMarkdown()))?.map(withoutTaskMark) ?? [];
    if (!seeded && !sameList(written, bullets)) return;
    this.priorEnhanced = false;
    this.savedEnhanced = this.enhancedMarkdown();
    this.noteBulletIds = this.enhance.bulletIds();
  }

  private companionMissing(path: string): void {
    const meeting = this.state.meeting;
    if (!meeting || meeting.companionPath !== path) return;
    this.savedEnhanced = null;
    this.forgetNote();
    this.patchMeeting({ companionPath: null, detachedRegions: [] });
    if (!this.missingNoticed) {
      this.missingNoticed = true;
      this.notice('The companion note is no longer there. Create it again to keep saving.');
    }
    this.derive();
  }

  /** The note was renamed or moved in the vault: it is the same note, and saving goes on under its new path. */
  private companionMoved(path: string): void {
    const meeting = this.state.meeting;
    if (!meeting?.companionPath || meeting.companionPath === path) return;
    if (this.qaNote === meeting.companionPath) this.qaNote = path;
    // Whatever was still queued under the old path is lost with it: it is sent again.
    this.savedTurns = this.writtenTurns;
    this.takenTurns = this.writtenTurns;
    this.companionEpoch += 1;
    this.turnsNote = path;
    this.patchMeeting({ companionPath: path });
    this.derive();
    this.saveEverything();
  }

  /**
   * The queue's write, watched on its way: only here is it known which transcript
   * lines reached the note, and so which ones to send again if the note is adopted anew.
   */
  private async writeBatch(path: string, patches: Patch[]): Promise<WriteOutcome> {
    // Not `companionPath`: a note reported missing may be back before the queue writes to it.
    const tracked = this.turnsNote === path;
    const epoch = this.companionEpoch;
    // This batch carries every turn handed over since the last batch that ended.
    const from = this.takenTurns;
    const upTo = this.savedTurns;
    let outcome: WriteOutcome | null = null;
    // Awaited only for a batch that replaces a region: lines of transcript go out in the same instant.
    const sent = this.needsVetting(path, patches) ? await this.vetted(path, patches) : patches;
    const note = this.noteEpoch;
    const mine = this.state.meeting?.companionPath === path;
    if (mine) {
      for (const patch of sent) {
        if (patch.region !== 'transcript') this.flying.set(patch.region, regionText(patch.content));
      }
    }
    try {
      // Nothing left to write: every patch was for a region the user has edited.
      outcome = sent.length === 0 ? { status: 'ok' } : await this.deps.notes.writeCompanion(path, sent);
      return outcome;
    } finally {
      if (mine && note === this.noteEpoch) this.landed(sent, outcome);
      if (tracked && epoch === this.companionEpoch) {
        if (typeof outcome?.status !== 'string') {
          // The write threw, or answered nothing, which the queue reads as a failure too. It keeps
          // the batch and tries again, so nothing was taken and nothing is sent a second time. Only
          // when it gives the batch up (onWriteError) are these turns the session's to send again.
          this.failedBatch = { epoch, from, upTo };
        } else {
          this.failedBatch = null;
          // After `retry` the batch goes back into the queue as well: nothing was taken.
          if (outcome.status !== 'retry') {
            this.takenTurns = upTo;
            const written =
              outcome.status === 'ok' || (outcome.status === 'detached' && !outcome.regions.includes('transcript'));
            if (written && from <= this.writtenTurns) this.writtenTurns = Math.max(this.writtenTurns, upTo);
          }
        }
      }
    }
  }

  /** A batch for the note in hand came back: what it wrote is what the note holds now. */
  private landed(sent: Patch[], outcome: WriteOutcome | null): void {
    this.flying.clear();
    if (outcome === null || (outcome.status !== 'ok' && outcome.status !== 'detached')) return;
    for (const patch of sent) {
      if (patch.region === 'transcript') continue;
      if (outcome.status === 'detached' && outcome.regions.includes(patch.region)) continue;
      const content = regionText(patch.content);
      this.noteHeld.set(patch.region, content);
      if (patch.region === 'enhanced') {
        // Known only for the version handed over last: an older one that was still out carried other lines.
        this.noteBulletIds = this.enhancedSent?.content === content ? this.enhancedSent.ids : null;
      }
    }
  }

  private onWriteOutcome(path: string, outcome: WriteOutcome): void {
    const meeting = this.state.meeting;
    // A late write to the note of a meeting that was left concerns nobody any more.
    if (this.disposed || !meeting || meeting.companionPath !== path) return;
    if (outcome.status === 'detached') {
      const added = outcome.regions.filter((region) => !meeting.detachedRegions.includes(region));
      if (added.length > 0) this.patchMeeting({ detachedRegions: [...meeting.detachedRegions, ...added] });
    } else if (outcome.status === 'missing') {
      this.companionMissing(path);
    }
  }

  /** The queue gave a batch up after trying it three times. */
  private onWriteError(path: string, error: unknown): void {
    if (this.disposed || this.state.meeting?.companionPath !== path) return;
    const lost = this.failedBatch;
    this.failedBatch = null;
    if (lost && lost.epoch === this.companionEpoch) {
      // With nothing queued behind them, its lines can go again with the next ones, in order.
      // Otherwise they are left as taken: a hole in the note, filled when the note is adopted
      // again, at the price of sending twice what was written after it.
      if (this.savedTurns === lost.upTo) this.savedTurns = lost.from;
      else this.takenTurns = lost.upTo;
    }
    // The enhanced notes, the summary and the insights the batch carried are not in the note
    // either. Each is sent once, when it changes: without this they would never go again.
    this.savedEnhanced = null;
    this.resend = true;
    this.armResend(path);
    if (this.writeErrorNoticed) return;
    this.writeErrorNoticed = true;
    this.notice(`The companion note could not be saved. ${describeError(error)}`);
  }

  private save(patch: Patch): boolean {
    const meeting = this.state.meeting;
    if (!meeting?.companionPath || meeting.detachedRegions.includes(patch.region)) return false;
    // Edited by hand in a way that could not be taken in: left as it is until the note is adopted again.
    if (meeting.editedOutside?.includes(patch.region)) return false;
    this.writeQueue.enqueue(meeting.companionPath, patch);
    // The queue keeps the newest version of a region only: the one that was left out is gone from it.
    this.stale.delete(patch.region);
    return true;
  }

  /** The note's own sections are level 2: nothing generated sits at their level or above. */
  private sanitized(markdown: string, minHeadingLevel = 3): string {
    const s = this.deps.settings();
    return sanitizeLlmOutput(markdown, {
      keepWikilinks: s.linkEntitiesInCompanion,
      keepTasks: s.actionItemsAsTasks,
      minHeadingLevel,
    });
  }

  private labels(): { mic: string; system: string } {
    return { mic: this.deps.settings().micLabel, system: OTHERS_LABEL };
  }

  /**
   * `asked`: the user asked for the notes in the note to be replaced with these ("Save there
   * again" on notes that were set aside). Over the notes of an earlier visit that is the ask
   * the guard waits for, whatever the run has dealt with.
   */
  private saveEnhanced(force = false, asked = false): void {
    if (this.seeding) return;
    const markdown = this.enhancedMarkdown();
    if (!force && markdown === this.savedEnhanced) return;
    const content = this.sanitized(markdown);
    // Topics alone are not notes yet: the companion may hold bullets from an earlier session.
    // Counted in what would be written: a bullet can be nothing but text the sanitizer removes.
    if (!/^- \S/m.test(content)) return;
    const earlier = this.priorEnhanced;
    if (earlier && !asked && !(this.enhanceAsked && this.enhance.settled())) {
      this.sayEarlierNotesKept();
      return;
    }
    if (!this.save({ region: 'enhanced', content })) return;
    this.savedEnhanced = markdown;
    this.enhancedSent = { content: regionText(content), ids: this.enhance.bulletIds() };
    if (earlier) {
      // From here on the note holds this visit's own notes.
      this.priorEnhanced = false;
      this.earlierBullets = false;
    }
  }

  /** Once per visit, and only where there is a note that could have been written to. */
  private sayEarlierNotesKept(): void {
    const meeting = this.state.meeting;
    if (this.earlierNotesNoticed || this.enhanceAsked) return;
    if (!meeting?.companionPath || meeting.detachedRegions.includes('enhanced')) return;
    this.earlierNotesNoticed = true;
    this.notice(EARLIER_NOTES_KEPT);
  }

  /** A summary is shown that was not saved over the earlier one: said once, and Summarize then replaces it. */
  private sayEarlierSummaryKept(): void {
    const meeting = this.state.meeting;
    if (this.earlierSummaryNoticed) return;
    if (!meeting?.companionPath || meeting.detachedRegions.includes('summary')) return;
    this.earlierSummaryNoticed = true;
    this.notice(EARLIER_SUMMARY_KEPT);
  }

  /** Appends the turns the companion does not have yet. The region only grows, so each turn goes once. */
  private saveTurns(): void {
    const turns = this.state.turns;
    if (this.savedTurns >= turns.length) return;
    const labels = this.labels();
    const lines: string[] = [];
    for (let i = this.savedTurns; i < turns.length; i++) {
      const separator = this.separators.get(i);
      if (separator !== undefined) lines.push(separator);
      const line = turnLine(turns[i], labels);
      if (line !== '') lines.push(line);
    }
    if (this.save({ region: 'transcript', append: lines.join('\n') })) this.savedTurns = turns.length;
  }

  /** The summary the sidebar shows, as it is saved. Null when there is none to save. */
  private summaryContent(): string | null {
    const { style, status, markdown } = this.state.summary;
    if (status !== 'done') return null;
    // One level under the heading that names the style: the model's sections belong to it, not beside it.
    const body = this.sanitized(markdown, 4);
    return body === '' ? null : `### ${SUMMARY_HEADINGS[style]}\n\n${body}`;
  }

  /** `asked`: the user asked for the summary in the note to be replaced with this one ("Save there again"). */
  private saveSummary(asked = false): void {
    const content = this.summaryContent();
    if (content === null) return;
    // Written without being asked for (at a stop, before the note was adopted): the summary of an
    // earlier visit, made from speech this visit does not have, is not replaced by it.
    if (this.priorSummary && !asked) {
      this.sayEarlierSummaryKept();
      return;
    }
    // Replaced because it was asked for: from here on the note holds this visit's own summary.
    if (this.save({ region: 'summary', content }) && asked) this.priorSummary = false;
  }

  private saveInsights(): void {
    const prefix = this.qaPrefix;
    // What the region holds is not known: a replace would lose it.
    if (prefix === null) return;
    // Not those the prefix already holds, since the region was edited by hand with them in it.
    const kept = this.state.qa.entries.filter((entry) => entry.kept && !this.qaFolded.has(entry.id));
    const blocks = kept
      .map((entry) =>
        this.sanitized(
          formatInsight({
            clockTime: hhmm(new Date(entry.askedAt)),
            question: entry.question,
            answer: entry.answer,
            sources: entry.sources,
          }),
        ),
      )
      .filter((block) => block !== '');
    if (blocks.length === 0) return;
    const parts = prefix === '' ? blocks : [prefix, ...blocks];
    const content = parts.join('\n\n');
    if (!this.save({ region: 'qa', content })) return;
    this.qaSent.set(
      regionText(content),
      kept.map((entry) => entry.id),
    );
  }

  /**
   * `asked`: the regions the user asked to have replaced with what the sidebar shows. For those
   * the ask also stands for the one the notes and the summary of an earlier visit wait for, and
   * only where the sidebar has something to put in their place.
   */
  private saveEverything(asked: readonly Region[] = NO_REGIONS): void {
    this.saveEnhanced(true, asked.includes('enhanced'));
    this.saveTurns();
    this.saveSummary(asked.includes('summary'));
    this.saveInsights();
  }

  /**
   * One more try for what a failed write dropped: the lines, and after a batch that was given up,
   * every region. Sending a region again is safe: it replaces what is there with the same text.
   */
  private sendDropped(): void {
    if (!this.resend) {
      this.saveTurns();
      return;
    }
    this.resend = false;
    // A batch given up while later lines were queued behind it left its own as taken: a hole in
    // the note. The count starts over from the last line known to be there: the hole is filled,
    // and what followed it is written a second time, which is better than a line that is missing.
    if (this.writtenTurns < this.takenTurns) {
      this.savedTurns = this.writtenTurns;
      this.takenTurns = this.writtenTurns;
      this.companionEpoch += 1;
    }
    this.saveEverything();
  }

  /**
   * One later try, by itself, for what a batch that was given up carried: no stop, no End and no
   * other meeting may ever follow. One at a time, and only for the note the batch was for.
   */
  private armResend(path: string): void {
    if (this.resendTimer !== null) return;
    this.resendTimer = this.later(() => {
      this.resendTimer = null;
      if (this.closed || !this.resend || this.state.meeting?.companionPath !== path) return;
      this.safely(() => this.sendDropped());
    }, RESEND_MS);
  }

  /* ────────────────────────────── Recording ───────────────────────────── */

  private startRecording(): Promise<void> {
    const state = this.state;
    if (!state.meeting) {
      this.notice(NO_MEETING);
      return Promise.resolve();
    }
    if (state.recording !== 'idle') return Promise.resolve();
    return this.trackRecording(this.beginRecording());
  }

  private stopRecording(summarizeAfter: boolean): Promise<void> {
    const attempt = this.startAttempt;
    // Nothing was recorded yet: there is nothing to save, and nothing to summarize.
    if (this.state.recording === 'starting' && attempt) return this.trackRecording(this.cancelStart(attempt));
    if (this.state.recording !== 'recording') return Promise.resolve();
    return this.trackRecording(this.finishRecording(summarizeAfter));
  }

  private trackRecording(work: Promise<void>): Promise<void> {
    const op: Promise<void> = work.finally(() => {
      if (this.recordingOp === op) this.recordingOp = null;
    });
    this.recordingOp = op;
    return op;
  }

  private async beginRecording(): Promise<void> {
    this.patch({ recording: 'starting' });
    // What the sidebar says of Ollama dates from the last check, which may be hours old, and this
    // is the moment it matters. Asked beside the start, not before it: the recording does not wait.
    void this.refreshOllama();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempt: StartAttempt = { cancelled: false, release };
    this.startAttempt = attempt;
    this.warned.clear();
    this.transcriptLossSaid = false;
    let source: TranscriptSource;
    try {
      this.lastFinal.clear();
      source = this.deps.createTranscriptSource();
    } catch (e) {
      this.startAttempt = null;
      this.startFailed(e);
      return;
    }
    this.source = source;
    this.unsubscribe = [];
    try {
      // One at a time: a source that refuses the second listener still has to let go of the first.
      this.unsubscribe.push(
        source.onEvent((event) => {
          if (this.source === source) this.onSttEvent(event);
        }),
      );
      this.unsubscribe.push(
        source.onState((stt, message) => {
          if (this.source === source) this.onSttState(stt, message);
        }),
      );
      // A cancel does not wait for the source: loading the model takes seconds, and a start that
      // was stopped may only fail much later. Whatever it answers then is nobody's any more.
      await Promise.race([source.start(), released]);
    } catch (e) {
      // Stopped on purpose: the source says so by failing its start, and that is no error.
      if (attempt.cancelled) return;
      this.startAttempt = null;
      if (this.source === source) this.detachSource();
      let stt = this.state.stt;
      try {
        stt = source.state();
      } catch {
        // The state last reported stands.
      }
      this.startFailed(e, stt);
      this.afterRecording();
      return;
    }
    // Cancelled or disposed while the worker was starting, even in the instant it succeeded:
    // whoever did it stops the source and owns the state.
    if (attempt.cancelled) return;
    this.startAttempt = null;

    const now = this.deps.clock.now();
    const state = this.state;
    const meeting = state.meeting;
    const first = meeting !== null && meeting.startedAt === null;
    this.recordingSince = now;
    this.resumeNote = resumeLine(now);
    this.patch({
      recording: 'recording',
      recordingError: null,
      meeting: meeting ? { ...meeting, startedAt: meeting.startedAt ?? now, endedAt: null } : null,
      stats: first ? addMeeting(state.stats) : state.stats,
    });
    if (first) this.statsChanged();
    this.ticker = this.deps.clock.setInterval(() => this.tick(), TICK_MS);
    this.ticking = true;
    this.vaultIndex?.pause();
  }

  /**
   * A start that failed is said as well as shown: the banner is in the sidebar, which may be
   * closed or behind another pane, and the user would go on talking to a meeting that hears nothing.
   */
  private startFailed(e: unknown, stt: SttState = this.state.stt): void {
    const message = describeError(e);
    this.patch({ recording: 'idle', recordingError: message, stt });
    this.notice(message);
  }

  /** Gives up a recording that has not begun: back to idle, with nothing to explain. */
  private async cancelStart(attempt: StartAttempt): Promise<void> {
    attempt.cancelled = true;
    this.startAttempt = null;
    const source = this.source;
    // Nothing was recorded: what the source still says while it is taken down is not a transcript.
    this.detachSource();
    this.patch({ recording: 'stopping' });
    attempt.release();
    let stt = this.state.stt;
    if (source) {
      try {
        // The real source answers by failing its start. Waited for: the next start must not find the microphone taken.
        await source.stop();
      } catch {
        // The start is given up either way.
      }
      try {
        stt = source.state();
      } catch {
        // The state last reported stands.
      }
    }
    if (this.closed) return;
    this.patch({ recording: 'idle', recordingError: null, partial: null, micLevel: 0, stt, sttMessage: null });
    this.afterRecording();
  }

  /** What waited for the recording to be over, whichever way it ended. */
  private afterRecording(): void {
    this.releaseHeldChanges();
    if (this.rereadAfterStop) {
      this.rereadAfterStop = false;
      void this.readDaily();
    }
  }

  private async finishRecording(summarizeAfter: boolean): Promise<void> {
    const source = this.source;
    const epoch = this.meetingEpoch;
    // The microphone is released first: what the worker and the index still take is not recorded time.
    const askedAt = this.deps.clock.now();
    // The summary that follows opens its tab for a user who is still where Stop was pressed.
    const tabAtStop = this.state.tab;
    this.patch({ recording: 'stopping' });
    this.stopTicker();
    if (source) {
      try {
        await source.stop();
      } catch {
        // The recording is over either way.
      }
    }
    // Only now: the worker's last finals arrive during the stop.
    this.detachSource();
    await this.capped(this.transcriptIndex.flush(), INDEX_FLUSH_CAP_MS);
    if (this.closed) return;

    const now = this.deps.clock.now();
    const turns = this.state.turns;
    const lastSpoken = turns.length > 0 ? turns[turns.length - 1].t1 : 0;
    // Never behind the last turn: the next recording's times must not run backwards.
    this.offsetSec = Math.max(this.offsetSec + Math.max(0, askedAt - this.recordingSince) / 1000, lastSpoken);
    const meeting = this.state.meeting;
    this.patch({
      recording: 'idle',
      partial: null,
      micLevel: 0,
      elapsedMs: Math.round(this.offsetSec * 1000),
      meeting: meeting ? { ...meeting, endedAt: now } : null,
    });

    this.vaultIndex?.resume();
    this.afterRecording();
    const path = meeting?.companionPath;
    if (path) {
      try {
        await this.deps.notes.touchCompanion(path, this.deps.notes.today().date);
      } catch {
        // The date in the frontmatter is a convenience; the notes themselves are saved below.
      }
    }
    // One more try for what a failed write dropped.
    if (epoch === this.meetingEpoch) this.sendDropped();
    await this.writeQueue.flush();
    await this.saveStats();
    if (this.closed || !summarizeAfter) return;

    // Known before a summary is started by itself: whether the note already holds one.
    if (this.inspecting) await this.inspection;
    // The last lines took a moment to save. Another meeting may have been selected meanwhile, or
    // this one ended: a summary now would be written for a meeting that was not recorded.
    if (this.closed || epoch !== this.meetingEpoch || this.ending > 0) return;
    const state = this.state;
    const hasMaterial = state.turns.length > 0 || state.shorthand.length > 0;
    // Not when the next recording has already started: its own stop will summarize the lot.
    if (state.meeting && state.recording === 'idle' && hasMaterial && state.summary.status !== 'running') {
      // Not over the summary of an earlier visit either: the turns in memory are this visit's
      // only, and a summary of them would replace one of the whole meeting.
      if (this.priorSummary && state.meeting.companionPath !== null) {
        if (!this.noSummaryNoticed && !this.earlierSummaryNoticed) {
          this.noSummaryNoticed = true;
          this.notice(NO_SUMMARY_OVER_EARLIER);
        }
        return;
      }
      // Saving the last lines can take seconds. Whoever went to another tab meanwhile is reading
      // or typing there: the summary is written all the same, and waits in its own tab.
      void this.summarize(this.deps.settings().summaryStyle, this.state.tab === tabAtStop);
    }
  }

  private detachSource(): void {
    for (const off of this.unsubscribe) {
      try {
        off();
      } catch {
        // Nothing to do about a listener that will not let go.
      }
    }
    this.unsubscribe = [];
    this.source = null;
  }

  private stopTicker(): void {
    if (!this.ticking) return;
    this.ticking = false;
    this.deps.clock.clearInterval(this.ticker);
    this.ticker = null;
  }

  private elapsedMs(): number {
    return Math.round(this.offsetSec * 1000) + Math.max(0, this.deps.clock.now() - this.recordingSince);
  }

  private tick(): void {
    const state = this.state;
    const source = this.source;
    if (state.recording !== 'recording' || !source) return;
    const patch: Partial<HamsterState> = { elapsedMs: this.elapsedMs() };
    let level = 0;
    try {
      level = source.level();
    } catch {
      level = 0;
    }
    level = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    // The meter has five bars: smaller moves would only repaint it.
    if (Math.abs(level - state.micLevel) > LEVEL_STEP) patch.micLevel = level;
    this.patch(patch);
  }

  private onSttState(stt: SttState, message?: string): void {
    /* A worker that dies takes the sentence it was hearing with it: up to twenty seconds already
       on screen as a partial. It is kept as said, before the restart begins a new one. */
    const open = this.openPartial;
    if ((stt === 'crashed' || stt === 'failed') && open) {
      this.openPartial = null;
      this.onSttEvent({ ...open, isFinal: true });
    }
    const said = message !== undefined && message.trim() !== '' ? message : null;
    // `failed` and `not-installed` leave the recording as it is: the meeting goes on without a transcript.
    this.patch({ stt, sttMessage: said });
    // Said as well as shown, once: with the sidebar out of view, the user would find out at the
    // end of the meeting. Only while it records: a start that fails says so itself.
    if (stt !== 'failed' && stt !== 'not-installed') return;
    if (this.state.recording !== 'recording' || this.transcriptLossSaid) return;
    this.transcriptLossSaid = true;
    this.notice(said?.trim() ?? (stt === 'failed' ? TRANSCRIPT_LOST : TRANSCRIPT_NOT_INSTALLED));
  }

  private onSttEvent(event: SttEvent): void {
    if (this.disposed) return;
    if (event.type === 'error') {
      const message = event.message?.trim() ?? '';
      this.patch({ sttMessage: message || `Transcription error: ${event.code}` });
      // The banner only speaks for a transcription that stopped. A warning that leaves it running
      // (another language than the one asked for, a line the worker could not read) is said once.
      if (message !== '' && !this.warned.has(event.code)) {
        this.warned.add(event.code);
        this.notice(message);
      }
      return;
    }
    if (event.type !== 'segment') return;
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    const state = this.state;

    if (!event.isFinal) {
      this.openPartial = text !== '' ? event : null;
      const now = state.partial;
      if (text !== '' && (now?.text !== text || now.source !== event.source)) {
        this.patch({ partial: { source: event.source, text } });
      }
      return;
    }
    if (this.openPartial?.source === event.source) this.openPartial = null;
    if (text === '') {
      this.patch({ partial: null });
      return;
    }

    this.turnCount += 1;
    const turn: Turn = {
      id: `T${this.turnCount}`,
      source: event.source,
      t0: event.t0 + this.offsetSec,
      t1: event.t1 + this.offsetSec,
      // The recognizer spells numbers out; every later step works from digits (src/util/numbers.ts).
      text: spokenNumbersToDigits(text),
    };
    if (event.lang) turn.lang = event.lang;
    if (this.resumeNote !== null) {
      // Set apart from what was said before, in this session or in an earlier one.
      if (state.turns.length > 0 || this.priorTranscript) this.separators.set(state.turns.length, this.resumeNote);
      this.resumeNote = null;
    }

    /* One chip per question, not per segment: a final holds up to twenty seconds of speech. The
       "?" of a question asked just before a pause comes with this final (`closes`): it makes a
       chip of the last sentence of the final before, from the same source. */
    const asked: Array<{ text: string; turn: Turn }> = [];
    if (event.closes?.includes('?')) {
      const before = this.lastFinal.get(event.source);
      const question = before ? lastSentence(before.text) : null;
      if (before && question) asked.push({ text: /\?$/.test(question) ? question : `${question}?`, turn: before });
    }
    for (const question of questionsIn(turn.text)) asked.push({ text: question, turn });
    this.lastFinal.set(event.source, turn);

    let qa = state.qa;
    const plain = (text: string): string => text.toLowerCase().replace(/[?\s]+$/, '');
    for (const { text: question, turn: from } of asked) {
      const wanted = plain(question);
      // Once per question: the same words again, or one chip of a turn holding another of that turn.
      const known = qa.chips.some((chip) => {
        const have = plain(chip.text);
        return have === wanted || (chip.turnId === from.id && (have.includes(wanted) || wanted.includes(have)));
      });
      if (known) continue;
      this.chipCount += 1;
      const chip: QuestionChip = {
        id: `C${this.chipCount}`,
        text: question,
        time: clockText(from.t0),
        turnId: from.id,
      };
      qa = { ...qa, chips: [...qa.chips, chip].slice(-MAX_CHIPS) };
    }

    this.patch({ turns: [...state.turns, turn], partial: null, qa });
    this.transcriptIndex.addTurn(turn);
    this.saveTurns();
  }

  private newTranscriptIndex(): TranscriptIndex {
    const index: TranscriptIndex = new TranscriptIndex({
      embedder: this.embedder,
      onAdvance: () => {
        if (this.transcriptIndex !== index) return;
        this.searchable += 1;
        if (!this.closed) this.enhance.transcriptAdvanced();
      },
    });
    return index;
  }

  /* ─────────────────────────────── Enhance ────────────────────────────── */

  private enhanceDeps(): EnhanceEngineDeps {
    const retrieve = (text: string, signal: AbortSignal): Promise<Excerpt[]> => this.excerptsFor(text, signal);
    const hasTranscript = (): boolean => this.transcriptIndex.chunks().length > 0;
    return {
      llm: this.deps.llm,
      scheduler: this.scheduler,
      clock: this.deps.clock,
      settings: () => {
        const s = this.deps.settings();
        return {
          model: s.llmModel,
          liveModel: liveModelOf(s),
          numCtx: s.numCtx,
          style: this.state.enhanceStyle,
          debounceMs: s.enhanceDebounceMs,
          maxWaitMs: s.enhanceMaxWaitMs,
          micLabel: s.micLabel,
          keepAlive: this.keepAlive(),
        };
      },
      // Read on every pass. Absent until there is transcript to search, as the engine expects.
      get retrieve() {
        return hasTranscript() ? retrieve : undefined;
      },
      glossary: () => this.glossary,
      onState: (items, status, error) => this.onEnhanceState(items, status, error),
      onUsage: (usage) => this.onUsage(usage),
    };
  }

  /** The relevance floors of the embedding model in use. */
  private floors(): RetrievalFloors {
    return (this.deps.retrievalFloors ?? retrievalFloors)(this.deps.settings().embedModel);
  }

  /**
   * The transcript excerpts for a shorthand line. The engine asks for every line again on each
   * run, and each answer costs an embedding request: while no new chunk has become searchable,
   * the same line gets the same answer, so it is kept.
   */
  private async excerptsFor(text: string, signal: AbortSignal): Promise<Excerpt[]> {
    const index = this.transcriptIndex;
    const chunks = this.searchable;
    if (this.excerptsAt !== chunks) {
      this.excerpts.clear();
      this.excerptsAt = chunks;
    }
    const kept = this.excerpts.get(text);
    if (kept) return kept.slice();
    const floors = this.floors();
    const found = nearBest(await index.search(text, ENHANCE_EXCERPTS, floors.enhance, signal), floors.enhanceGap);
    // Not when a chunk arrived or the meeting changed during the search: the answer may be of another moment.
    if (index === this.transcriptIndex && chunks === this.searchable && chunks === this.excerptsAt) {
      if (this.excerpts.size >= EXCERPT_CACHE_SIZE) {
        // The oldest goes: a Map hands out its keys in the order they were added.
        const oldest = this.excerpts.keys().next();
        if (!oldest.done) this.excerpts.delete(oldest.value);
      }
      this.excerpts.set(text, found);
    }
    return found.slice();
  }

  private onEnhanceState(items: EnhancedItem[], status: EnhanceStatus, error: string | null): void {
    if (this.disposed) return;
    // The sidebar renders what the model wrote as Markdown, with every plugin of the vault
    // looking on: nothing in it may be code one of them would run. The note gets the full sanitizer.
    const shown = items.map((item) => {
      const bullet = item.bullet === null ? null : disarmCode(item.bullet);
      return bullet === item.bullet ? item : { ...item, bullet };
    });
    this.patch({
      // The engine hands out fresh objects every time; rows that did not change keep theirs.
      enhanced: reuse(this.state.enhanced, shown, sameEnhanced, (item) => item.id),
      enhanceStatus: status,
      enhanceError: error,
    });
    this.saveEnhanced();
  }

  private setLiveEnhance(on: boolean): void {
    this.patch({ liveEnhance: on });
    this.enhance.setLive(on);
  }

  private setEnhanceStyle(style: EnhanceStyle): void {
    const state = this.state;
    if (state.enhanceStyle === style) return;
    this.patch({ enhanceStyle: style });
    // That run writes every bullet anew, from the shorthand and from what this visit has of the
    // transcript. Over the notes of an earlier visit, a change of style alone does not save it.
    if (this.earlierBullets) {
      this.priorEnhanced = true;
      this.enhanceAsked = false;
    }
    // A bullet written in the other style counts as pending: one run rewrites them all.
    if (state.meeting && state.shorthand.length > 0) void this.enhance.runNow();
  }

  private async enhanceNow(): Promise<void> {
    if (!this.state.meeting) {
      this.notice(NO_MEETING);
      return;
    }
    const epoch = this.meetingEpoch;
    if (this.inspecting) {
      // The note's own bullets first: lines that have their notes are not written again.
      await this.inspection;
      if (this.closed || epoch !== this.meetingEpoch) return;
    }
    // Over the notes of an earlier visit, the first press shows what it would write and says
    // that the note keeps the others; pressed again, it replaces them.
    if (!this.priorEnhanced || this.earlierNotesNoticed) this.enhanceAsked = true;
    await this.enhance.runNow();
    // The run may have found nothing left to do: what a Live run wrote before the button is saved now.
    if (!this.closed && epoch === this.meetingEpoch) this.saveEnhanced();
  }

  /* ────────────────────────────── Summaries ───────────────────────────── */

  private keepAlive(): string {
    return this.state.recording === 'idle' ? KEEP_ALIVE_IDLE : KEEP_ALIVE_RECORDING;
  }

  private genSettings(): GenSettings {
    const s = this.deps.settings();
    return { model: s.llmModel, numCtx: s.numCtx, micLabel: s.micLabel, keepAlive: this.keepAlive() };
  }

  /**
   * `show`: brings the Summary tab forward. Not for a summary nobody asked for, once the user has moved on.
   * `replace`: asked for by a user who was told that the note keeps the summary of an earlier visit.
   */
  private async summarize(style: SummaryStyle, show = true, replace = false): Promise<void> {
    const previous = this.summaryRun;
    if (previous) {
      previous.stream.cancel();
      previous.abort.abort();
    }
    const abort = new AbortController();
    const mine = (): boolean => this.summaryRun === run;
    const stream = this.throttle((text) => {
      if (mine()) this.patch({ summary: { style, status: 'running', markdown: disarmCode(text), error: null } });
    });
    const run: SummaryRun = { abort, stream };
    this.summaryRun = run;
    const running: HamsterState['summary'] = { style, status: 'running', markdown: '', error: null };
    this.patch(show ? { summary: running, tab: 'summary' } : { summary: running });

    try {
      const state = this.state;
      const s = this.deps.settings();
      const written = await writeSummary(
        {
          llm: this.deps.llm,
          scheduler: this.scheduler,
          settings: () => this.genSettings(),
          // One summary is one assist, however many calls a long meeting takes.
          onUsage: (usage) => this.onUsage(usage, false),
          glossary: () => this.glossary,
        },
        {
          style,
          language: s.summaryLanguage,
          title: state.meeting?.title ?? state.activeSection?.title ?? '',
          date: state.meeting?.date ?? state.daily.date,
          shorthand: state.shorthand.map((item) => item.text),
          turns: state.turns,
          asTasks: s.actionItemsAsTasks,
          speakerLabels: this.labels(),
        },
        (text) => stream.push(text),
        abort.signal,
      );
      stream.cancel();
      if (!mine()) return;
      this.summaryRun = null;
      const markdown = disarmCode(written);
      const stats = this.state.stats;
      this.patch({
        summary: { style, status: 'done', markdown, error: null },
        stats: { ...stats, assists: stats.assists + 1 },
      });
      this.statsChanged();
      // Only now that there is a summary to put in its place: a run that failed or was cancelled
      // replaced nothing, and the earlier one is still not for a stop to write over.
      if (replace && this.earlierSummaryNoticed) this.priorSummary = false;
      // Saved once it is known what the note holds: the read that tells also saves what waited for it.
      if (!this.inspecting) this.saveSummary();
    } catch (e) {
      // Cancelled by a newer run, by the user or by a change of meeting: they own the state now.
      if (!mine()) return;
      stream.flush();
      this.summaryRun = null;
      const markdown = withoutProgressNote(this.state.summary.markdown);
      this.patch({
        summary: isAborted(e)
          ? { style, status: 'idle', markdown, error: null }
          : { style, status: 'error', markdown, error: describeError(e) },
      });
    }
  }

  private cancelSummary(): void {
    const run = this.summaryRun;
    if (!run) return;
    // The text that arrived stays; delivered before the run is disowned, or it would be dropped.
    run.stream.flush();
    this.summaryRun = null;
    run.abort.abort();
    const { style, markdown } = this.state.summary;
    this.patch({ summary: { style, status: 'idle', markdown: withoutProgressNote(markdown), error: null } });
  }

  /* ──────────────────────────────── Q&A ───────────────────────────────── */

  private patchEntry(id: string, change: Partial<QaEntry>): void {
    const qa = this.state.qa;
    const now = qa.entries.find((entry) => entry.id === id);
    if (!now) return;
    // A second click on Keep, a piece of answer delivered twice: the row keeps its object.
    const keys = Object.keys(change) as Array<keyof QaEntry>;
    if (keys.every((key) => Object.is(now[key], change[key]))) return;
    this.patch({
      qa: { ...qa, entries: qa.entries.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)) },
    });
  }

  private async ask(question: string, chipId?: string): Promise<void> {
    const text = question.trim();
    if (text === '') return;

    const state = this.state;
    const meeting = state.meeting;
    this.askCount += 1;
    const id = `Q${this.askCount}`;
    const live = (): boolean => this.asks.get(id) === run;
    const stream = this.throttle((answer) => {
      if (live()) this.patchEntry(id, { answer: disarmCode(answer) });
    });
    const run: AskRun = { abort: new AbortController(), stream, sources: [] };
    this.asks.set(id, run);
    const entry: QaEntry = {
      id,
      askedAt: this.deps.clock.now(),
      meetingTime: state.recording === 'recording' ? clockText(this.elapsedMs() / 1000) : null,
      question: text,
      answer: '',
      status: 'running',
      error: null,
      sources: [],
      kept: false,
    };
    this.patch({ qa: { ...state.qa, entries: [...state.qa.entries, entry] }, tab: 'ask' });

    try {
      const [linked, vault, transcript] = await Promise.all([
        this.linkedNotes(meeting),
        this.vaultPassages(text, meeting),
        this.transcriptExcerpts(text, meeting, run.abort.signal),
      ]);
      if (!live()) return;
      const now = this.state;
      // Outside a meeting the question is about the vault, not about the section under the cursor.
      const shorthand = meeting ? now.shorthand.map((item) => item.text) : [];
      run.sources = buildSources({
        linked,
        vault,
        transcript,
        maxTokens: qaSourceBudget(this.genSettings().numCtx, text, shorthand.join('\n')),
      });

      const answered = await answerQuestion(
        {
          llm: this.deps.llm,
          scheduler: this.scheduler,
          settings: () => this.genSettings(),
          onUsage: (usage) => this.onUsage(usage),
        },
        {
          question: text,
          title: meeting?.title ?? '',
          date: meeting?.date ?? now.daily.date,
          shorthand,
          transcriptTail: meeting ? this.transcriptTail() : '',
          sources: run.sources,
        },
        (text) => stream.push(text),
        run.abort.signal,
      );
      stream.cancel();
      if (!live()) return;
      this.asks.delete(id);
      const answer = disarmCode(answered);
      const qa = this.state.qa;
      const asked = chipId !== undefined && qa.chips.some((chip) => chip.id === chipId);
      this.patch({
        qa: {
          entries: qa.entries.map((e) =>
            e.id === id ? { ...e, answer, sources: citedSources(answer, run.sources), status: 'done' } : e,
          ),
          chips: asked ? qa.chips.filter((chip) => chip.id !== chipId) : qa.chips,
        },
      });
    } catch (e) {
      if (!live()) return;
      if (isAborted(e)) {
        this.finishCancelled(id, run);
        return;
      }
      stream.flush();
      this.asks.delete(id);
      this.patchEntry(id, { status: 'error', error: describeError(e) });
    }
  }

  private cancelAsk(id: string): void {
    const run = this.asks.get(id);
    if (!run) return;
    run.abort.abort();
    this.finishCancelled(id, run);
  }

  /** A cancelled answer keeps what had arrived; with nothing to show, the entry goes. */
  private finishCancelled(id: string, run: AskRun): void {
    run.stream.flush();
    this.asks.delete(id);
    const qa = this.state.qa;
    const entry = qa.entries.find((e) => e.id === id);
    if (!entry) return;
    if (entry.answer.trim() === '') {
      this.patch({ qa: { ...qa, entries: qa.entries.filter((e) => e.id !== id) } });
    } else {
      this.patchEntry(id, { status: 'done', sources: citedSources(entry.answer, run.sources) });
    }
  }

  private async linkedNotes(
    meeting: MeetingState | null,
  ): Promise<Array<{ title: string; path: string; text: string }>> {
    const section = meeting?.source ? this.section : null;
    // The heading's own links first: the host reads a few notes only.
    const links = section ? [...section.links] : [];
    for (const item of section?.items ?? []) {
      for (const link of wikilinks(item.raw)) {
        if (!links.includes(link)) links.push(link);
      }
    }
    if (links.length === 0) return [];
    try {
      return await this.deps.notes.readLinkedNotes(links, QA_LINKED_CHARS);
    } catch {
      return [];
    }
  }

  private async vaultPassages(
    question: string,
    meeting: MeetingState | null,
  ): Promise<Array<VaultChunk & { score: number }>> {
    const index = this.vaultIndex;
    const status = this.state.index.status;
    if (!index || (status !== 'ready' && status !== 'paused')) return [];
    // The meeting's own notes reach the model as shorthand and transcript, not as sources.
    const excludePaths = [this.state.daily.path];
    if (meeting && this.meetingDaily.path !== this.state.daily.path) excludePaths.push(this.meetingDaily.path);
    if (meeting?.companionPath) excludePaths.push(meeting.companionPath);
    // The note the meeting is typed in reaches the model as shorthand already.
    if (meeting?.notePath) excludePaths.push(meeting.notePath);
    // A folder taken off the list in the settings is no longer answered from, rebuilt or not.
    // An emptied list is a choice too: no folder, so nothing of the index is searched.
    const wanted = this.deps.settings().indexedFolders;
    if (wanted.length === 0) return [];
    try {
      const minScore = this.floors().vault;
      const hits = await index.search(question, QA_VAULT_CHUNKS, { excludePaths, folders: wanted, minScore });
      return hits.map((hit) => ({ ...hit, heading: headingUnderTitle(hit.title, hit.heading) }));
    } catch {
      return [];
    }
  }

  private async transcriptExcerpts(
    question: string,
    meeting: MeetingState | null,
    signal: AbortSignal,
  ): Promise<Excerpt[]> {
    if (!meeting) return [];
    try {
      const floor = this.floors().transcript;
      return await this.transcriptIndex.search(question, QA_TRANSCRIPT_CHUNKS, floor, signal);
    } catch {
      return [];
    }
  }

  /** The last fifteen minutes of speech, newest lines kept when they do not all fit. */
  private transcriptTail(): string {
    const state = this.state;
    const turns = state.turns;
    if (turns.length === 0) return '';
    const recorded = state.recording === 'recording' ? this.elapsedMs() / 1000 : 0;
    const end = Math.max(turns[turns.length - 1].t1, recorded);
    const recent = turns.filter((turn) => turn.t1 >= end - QA_TAIL_SECONDS);
    const lines = transcriptPlain(recent, this.labels()).split('\n');
    const kept: string[] = [];
    let tokens = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const cost = estimateTokens(lines[i]) + 1;
      if (tokens + cost > QA_TAIL_TOKENS) break;
      kept.push(lines[i]);
      tokens += cost;
    }
    return kept.reverse().join('\n');
  }

  private async keepInsight(id: string): Promise<void> {
    const meeting = this.state.meeting;
    if (!meeting?.companionPath) {
      this.notice('Create the companion note first.');
      return;
    }
    const wanted = this.state.qa.entries.find((entry) => entry.id === id);
    if (!wanted || wanted.status !== 'done' || wanted.kept) return;
    // Writing before the existing insights are known would replace them.
    await this.inspection;
    if (this.closed || this.state.meeting?.key !== meeting.key) return;
    if (this.qaPrefix === null) {
      const settled = await this.readQaPrefix();
      if (!settled || this.closed || this.state.meeting?.key !== meeting.key) return;
    }
    this.patchEntry(id, { kept: true });
    this.saveInsights();
  }

  /**
   * The one read of the note failed, or found the `qa` region damaged. It may have been
   * repaired since: read again. False when the note still cannot be read, and nothing can be kept yet.
   */
  private async readQaPrefix(): Promise<boolean> {
    const path = this.state.meeting?.companionPath;
    if (!path) return true;
    const epoch = this.meetingEpoch;
    let note: string | null = null;
    try {
      note = await this.deps.notes.readCompanion(path);
    } catch {
      note = null;
    }
    const meeting = this.state.meeting;
    if (this.closed || epoch !== this.meetingEpoch || meeting?.companionPath !== path) return true;
    this.qaPrefix ??= qaContentOf(note);
    if (this.qaPrefix !== null) {
      this.qaNote = path;
      return true;
    }
    if (note !== null) {
      // What the host would answer to the write: the region is left alone until its markers are back.
      if (!meeting.detachedRegions.includes('qa')) {
        this.patchMeeting({ detachedRegions: [...meeting.detachedRegions, 'qa'] });
      }
      return true;
    }
    if (this.gone(path)) {
      this.companionMissing(path);
      return true;
    }
    this.notice('The companion note could not be read. Try keeping the insight again in a moment.');
    return false;
  }

  private dismissChip(id: string): void {
    const qa = this.state.qa;
    if (!qa.chips.some((chip) => chip.id === id)) return;
    this.patch({ qa: { ...qa, chips: qa.chips.filter((chip) => chip.id !== id) } });
  }

  /* ─────────────────────────── Knowledge index ────────────────────────── */

  private onIndexStatus(status: VaultIndexStatus): void {
    if (this.disposed) return;
    const now = this.state.index;
    // The folders chosen in the settings are what the picker shows and what "Build index" starts
    // from, whether they were typed there or saved by the sidebar's own build. Shown over the
    // index's own list, the sidebar would hand the old list back at the next rebuild. Not while a
    // build runs: it shows the folders it is building. An emptied list is shown as it is, none:
    // the folders of the index in its place would be answered from, and written back into the
    // settings by the next rebuild. Before the first build the index has none either.
    const wanted = this.deps.settings().indexedFolders;
    const building = status.status === 'building' || status.status === 'paused';
    const folders = building ? status.folders : wanted;
    // The index still holds the folders of its last build: only a rebuild applies the new list.
    const pending = !building && status.status !== 'none' && !sameMembers(folders, status.folders);
    if (
      now.status === status.status &&
      now.files === status.files &&
      now.chunks === status.chunks &&
      now.done === status.done &&
      now.total === status.total &&
      now.error === status.error &&
      (now.foldersPending ?? false) === pending &&
      sameList(now.folders, folders)
    ) {
      return;
    }
    const next: VaultIndexStatus = { ...status, folders: sameList(now.folders, folders) ? now.folders : folders };
    if (pending) next.foldersPending = true;
    this.patch({ index: next });
  }

  private buildIndexAtStartup(): void {
    const s = this.deps.settings();
    const ollama = this.state.ollama;
    if (this.closed || !this.vaultIndex || s.indexedFolders.length === 0) return;
    if (ollama.status !== 'ok' || ollama.missingModels.includes(s.embedModel.trim())) return;
    // Incremental: files that did not change since the last build are skipped.
    void this.runBuild(s.indexedFolders);
  }

  private async buildIndex(folders: string[]): Promise<void> {
    if (!this.vaultIndex) {
      this.notice('The knowledge index is not available.');
      return;
    }
    if (this.state.recording !== 'idle') {
      this.notice('Stop the recording before building the index.');
      return;
    }
    await this.runBuild(folders, () => this.deps.updateSettings({ indexedFolders: [...folders] }));
  }

  private async runBuild(folders: string[], prepare?: () => Promise<void>): Promise<void> {
    const index = this.vaultIndex;
    if (!index) return;
    const previous = this.indexRun;
    this.indexAbort?.abort();
    // Registered before anything is awaited, so that a cancel always finds the run it is meant for.
    const abort = new AbortController();
    this.indexAbort = abort;
    const run = (async () => {
      // A build in progress ignores new arguments: it has to end before another folder list can start.
      await previous?.catch(() => undefined);
      await prepare?.();
      if (this.closed || abort.signal.aborted) return;
      await index.build([...folders], abort.signal);
    })();
    this.indexRun = run;
    try {
      await run;
    } finally {
      if (this.indexAbort === abort) {
        this.indexAbort = null;
        this.indexRun = null;
      }
    }
  }

  handleVaultChange(change: VaultChange): void {
    if (this.closed) return;
    this.safely(() => {
      const registry = this.deps.settings().entitiesPath;
      if (change.path === registry || (change.type === 'rename' && change.oldPath === registry)) {
        void this.loadEntities();
      }
      if (change.type === 'rename') {
        for (const [id, path] of this.rekeyed) {
          if (path === change.oldPath) this.rekeyed.set(id, change.path);
        }
        for (const manual of this.manualMeetings.values()) {
          if (manual.path === change.oldPath) manual.path = change.path;
        }
        // The note a meeting is typed in, renamed: the meeting follows it.
        const typedIn = this.state.meeting;
        if (typedIn?.notePath === change.oldPath) {
          this.patch({ meeting: { ...typedIn, notePath: change.path } });
        }
        if (this.focus?.path === change.oldPath) this.focus = { ...this.focus, path: change.path };
      }
      // Changed outside its editor (a sync, another device): read again.
      if (change.type === 'modify' && change.path === this.state.meeting?.notePath && change.path !== this.state.meeting?.companionPath) {
        void this.rereadNote(change.path);
      }
      // A note of a meeting started on its own, deleted or renamed while that meeting is not the
      // current one: its row follows.
      const listed =
        change.type !== 'modify' &&
        this.state.sections.some(
          (entry) => entry.anchorLine < 0 && entry.companionPath === (change.type === 'rename' ? change.oldPath : change.path),
        );
      const companion = this.state.meeting?.companionPath;
      if (companion && change.type === 'rename' && change.oldPath === companion) {
        this.companionMoved(change.path);
        // Its old name must not linger in the index; the new one is indexed when the meeting is left.
        void this.vaultIndex?.removeFile(change.oldPath);
        return;
      }
      if (companion && change.type === 'delete' && change.path === companion) {
        // Whatever the index held of it goes now: nothing will report this path again.
        void this.vaultIndex?.removeFile(companion);
        if (this.gone(companion)) this.companionMissing(companion);
        return;
      }
      if (companion && change.type === 'modify' && change.path === companion) {
        // Its own writes come back this way too: what the note holds tells them from an edit by hand.
        this.noteCheckTries = 0;
        this.scheduleNoteCheck();
      }
      if (listed) this.derive();
      // Also while a build runs or waits for a recording to end: the index takes a change behind
      // the build, which may already be past that note. Not after a build that failed: every change
      // would be one more request to a server that just gave up, and the next build reads the lot.
      const indexing = this.state.index.status;
      if (!this.vaultIndex || (indexing !== 'ready' && indexing !== 'building' && indexing !== 'paused')) return;
      // It changes every few seconds during a meeting; it is indexed when the meeting is left.
      if (change.path === companion) return;
      if (this.state.recording !== 'idle') {
        const waiting = this.heldChanges.some((held) => held.type === 'modify' && held.path === change.path);
        if (change.type !== 'modify' || !waiting) this.heldChanges.push(change);
        return;
      }
      this.applyVaultChange(change);
    });
  }

  private applyVaultChange(change: VaultChange): void {
    const index = this.vaultIndex;
    if (!index) return;
    // Deletes and renames embed nothing, and must not be lost behind a later change to the same path.
    if (change.type === 'rename') {
      const pending = this.dropVaultTimer(change.oldPath);
      void index.renameFile(change.oldPath, change.path);
      // The edit that was waiting under the old name still has to be indexed.
      if (pending) this.applyVaultChange({ type: 'modify', path: change.path });
      return;
    }
    const path = change.path;
    this.dropVaultTimer(path);
    if (change.type === 'delete') {
      void index.removeFile(path);
      return;
    }
    // Obsidian saves a note every two seconds while it is typed in: one update once it settles.
    this.vaultTimers.set(
      path,
      this.later(() => {
        this.vaultTimers.delete(path);
        void index.updateFile(path);
      }, VAULT_CHANGE_DEBOUNCE_MS),
    );
  }

  /** True when an update was waiting for that path. */
  private dropVaultTimer(path: string): boolean {
    const pending = this.vaultTimers.get(path);
    if (!pending) return false;
    this.cancel(pending);
    this.vaultTimers.delete(path);
    return true;
  }

  private releaseHeldChanges(): void {
    const held = this.heldChanges;
    this.heldChanges = [];
    for (const change of held) this.applyVaultChange(change);
  }

  /* ──────────────────────────────── Stats ─────────────────────────────── */

  private onUsage(usage: ChatUsage, countAssist = true): void {
    if (this.disposed) return;
    const when = new Date(this.deps.clock.now());
    this.patch({ stats: addUsage(this.state.stats, usage, when, countAssist), lastUsage: usage });
    this.statsChanged();
  }

  private onEmbedTokens(tokens: number): void {
    if (this.disposed) return;
    this.patch({ stats: addEmbedTokens(this.state.stats, tokens, new Date(this.deps.clock.now())) });
    this.statsChanged();
  }

  /** At most one save a minute while the figures move; stop, flush and dispose save at once. */
  private statsChanged(): void {
    this.statsDirty = true;
    if (this.statsTimer || this.closed) return;
    this.statsTimer = this.later(() => {
      this.statsTimer = null;
      void this.saveStats();
    }, STATS_SAVE_MS);
  }

  private async saveStats(): Promise<void> {
    this.cancel(this.statsTimer);
    this.statsTimer = null;
    if (!this.statsDirty) return;
    this.statsDirty = false;
    try {
      await this.deps.statsIO.save(this.state.stats);
    } catch {
      // Still to be saved: the next change or flush tries again.
      this.statsDirty = true;
    }
  }
}

export function createSession(deps: SessionDeps): HamsterSession {
  return new MeetingSession(deps);
}
