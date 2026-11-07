/* --------------------------------------------------------------------------
 * Magical Hamster: shared contracts.
 *
 * Types only. Nothing in this file exists at run time, so every module can
 * import from it (with `import type`) without pulling anything in.
 *
 * The layers, from the inside out:
 *
 *   pure logic      editor/sectionAt, notes/companion, llm/*, rag/*, util/*
 *                   No `obsidian`, no Node built-ins, no DOM. Unit-tested.
 *   session         session/meetingSession: the one place that orchestrates.
 *                   Talks to the outside world only through the interfaces
 *                   below (NotesHost, TranscriptSource, OllamaClient...).
 *   hosts           host/*, editor/liveCapture, audio/*, stt/sttProcess:
 *                   Obsidian, WebAudio and child_process adapters.
 *   ui              React, a pure function of (HamsterState, HamsterController).
 *
 * The browser harness in dev/ swaps the hosts for fakes and runs everything
 * else unchanged.
 * ------------------------------------------------------------------------ */

/* ───────────────────────────── Settings ───────────────────────────── */

export type EnhanceStyle = 'standard' | 'concise';
export type SummaryStyle = 'executive' | 'recap' | 'actions';
export type LanguagePref = 'auto' | 'fr' | 'en';
export type Lang = 'fr' | 'en';
/** Full locale codes: the speech model maps a bare `en` to en-GB. */
export type SttLanguage = 'auto' | 'fr-CA' | 'fr-FR' | 'en-US';
export type LinkPlacement = 'section-end' | 'heading';

/** Synced with the vault (plugin data.json). */
export interface HamsterSettings {
  /** Format of data.json: `parseSettings` brings an older one up to date. */
  settingsVersion: number;
  ollamaUrl: string;
  /** Generation model for summaries, Q&A and the Enhance button. */
  llmModel: string;
  /** Generation model for Live Enhance. Empty string means "same as llmModel". */
  liveModel: string;
  embedModel: string;
  /** Sent on EVERY generation call. Ollama reloads a model when it changes. */
  numCtx: number;
  embedNumCtx: number;
  embedDimensions: number;

  enhanceStyle: EnhanceStyle;
  liveEnhanceDefault: boolean;
  enhanceDebounceMs: number;
  enhanceMaxWaitMs: number;

  summaryStyle: SummaryStyle;
  summaryLanguage: LanguagePref;

  sttLanguage: SttLanguage;
  /** Label for the microphone channel in transcripts: "Fred", or "Mic (room)" on speakers. */
  micLabel: string;

  companionFolder: string;
  companionPrefix: string;
  dailyLinkPlacement: LinkPlacement;
  dailyLinkAlias: string;
  actionItemsAsTasks: boolean;
  linkEntitiesInCompanion: boolean;
  /** Vault path of the entity registry (people, projects, governance bodies). */
  entitiesPath: string;
  /** Source of a RegExp (case-insensitive) matching heading-less meeting lines. */
  softMarkerPattern: string;
  /** Extra frontmatter for new companion notes: one `key: value` per line (see parseCompanionProperties). */
  companionProperties: string;

  /** Folders included in the knowledge index. Empty until the user picks them. */
  indexedFolders: string[];
  /** Dollars per 1,000 tokens, for the "saved on-device" figure. */
  costPer1k: number;
}

/** Per device, never synced (Obsidian's vault-scoped localStorage). */
export interface LocalSettings {
  /** Absolute path of the Node binary that runs the speech worker. Empty = the one recorded at setup. */
  nodePath: string;
  /** Absolute path of the runtime directory outside the vault. */
  runtimeDir: string;
  micDeviceId: string;
  /** True once the user has seen and accepted the first-write confirmation. */
  firstWriteConfirmed: boolean;
  /** Shows the Debug tab: every exchange with the model, kept in memory. Per device. */
  debugTab: boolean;
}

/* ─────────────────────── Daily note: sections ─────────────────────── */

export interface SectionItem {
  /** Stable hash of the trimmed line text; duplicates get a `#n` suffix. */
  id: string;
  /** The line without its list marker or checkbox. For a `topic`, the heading text without its `#`s. */
  text: string;
  /** The line as written. */
  raw: string;
  /** 0-based line number in the document. */
  line: number;
  /** `topic` = a sub-heading (####) inside the meeting section. */
  kind: 'item' | 'topic';
  /** The status character of a task line ("- [ ] x" gives " ", "- [x] x" gives "x"); absent for any other line. */
  task?: string;
}

/** A meeting's stretch of the daily note. */
export interface Section {
  /** Human title, wikilink brackets removed: "1:1 Jane Example". Empty for a heading with no text yet. */
  title: string;
  /** Anchor text as written, without leading #: "1:1 [[Jane Example]]". */
  rawTitle: string;
  /** Wikilink targets found in the anchor line. */
  links: string[];
  /** Index among sections with the same title, top to bottom. */
  ordinal: number;
  /** False when the anchor is a plain "soft marker" line such as `1:1 Maya`. */
  isHeading: boolean;
  /** 1..3 for headings, 0 for soft markers. */
  level: number;
  /** 0-based line of the heading or marker. */
  anchorLine: number;
  /** Body lines, 0-based, end exclusive. The body excludes the anchor line. */
  bodyStartLine: number;
  bodyEndLine: number;
  /** Character offsets of the body in the document, end exclusive. */
  from: number;
  to: number;
  items: SectionItem[];
  /**
   * 0-based line of the first plugin link line inside the body, if present.
   * In a section with nested sections it can be a child's link: to know whether
   * THIS companion is linked, compare the line's wikilink target with its basename.
   */
  linkLine: number | null;
}

/** One row of the Meetings tab. */
export interface SectionSummary {
  title: string;
  rawTitle: string;
  links: string[];
  ordinal: number;
  isHeading: boolean;
  level: number;
  anchorLine: number;
  /** True when the anchor looks like a meeting (wikilink, meeting word, or entity name). */
  meetingLike: boolean;
}

/** `title#ordinal`, the durable identity of a section within one daily. */
export type SectionKey = string;

export type EntityKind = 'person' | 'project' | 'governance' | 'other';

export interface Entity {
  /** Canonical name: "Jane Example", "Identity & Access Management". */
  name: string;
  /** Wikilink target used in notes: "Jane Example", "IAM". */
  link: string;
  aliases: string[];
  kind: EntityKind;
  active: boolean;
}

/* ───────────────────────── Companion note ─────────────────────────── */

export type Region = 'enhanced' | 'summary' | 'qa' | 'transcript';

export interface CompanionMeta {
  /** Human title for the H1: "1:1 Jane Example". */
  title: string;
  /** YYYY-MM-DD */
  date: string;
  attendees: string[];
  projects: string[];
  /** Basename of the daily note, for the `links` field: "2026-10-09". */
  dailyBasename: string;
  /** `title#ordinal`, brackets already stripped. */
  source: SectionKey;
  /** Properties of the user's own, from the setting "Extra properties": `[key, value]`, in order. */
  properties?: Array<[string, string]>;
}

export type Patch =
  | { region: 'enhanced' | 'summary' | 'qa'; content: string }
  | { region: 'transcript'; append: string };

export type MergeResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; error: 'structure'; region: Region };

export type WriteOutcome =
  | { status: 'ok' }
  /** The file was edited too recently; try again after `afterMs`. */
  | { status: 'retry'; afterMs: number }
  /** These regions' markers are damaged: their patches were skipped, the others were written. */
  | { status: 'detached'; regions: Region[] }
  | { status: 'missing' };

/* ───────────────────────────── Speech ─────────────────────────────── */

export type SttSource = 'mic' | 'system';

export interface SttSegment {
  type: 'segment';
  source: SttSource;
  /** Seconds since the recording started. */
  t0: number;
  t1: number;
  text: string;
  isFinal: boolean;
  lang?: Lang;
  langSource?: 'heuristic';
  /**
   * On a final: the punctuation that closes the PREVIOUS final of this source ("?", "."). The
   * recognizer writes a sentence's closing mark only once the next sentence has begun, so after
   * a pause it arrives with the next final.
   */
  closes?: string;
}

export type SttEvent =
  | { type: 'ready'; model: string; chunkMs: number }
  | SttSegment
  | { type: 'stats'; rtf: number; backlogMs: number }
  | { type: 'error'; code: string; message?: string };

export type SttState =
  | 'idle'
  | 'spawning'
  | 'ready'
  | 'running'
  | 'stopping'
  | 'exited'
  | 'crashed'
  /** Transcription cannot continue (repeated crashes, or the microphone was lost); the meeting goes on without transcript. */
  | 'failed'
  /** The runtime or the model is not installed (`pnpm setup:stt`). */
  | 'not-installed';

/** A finalized stretch of speech. */
export interface Turn {
  id: string;
  source: SttSource;
  t0: number;
  t1: number;
  text: string;
  lang?: Lang;
}

/**
 * Whatever produces transcript segments: mic + speech worker, or a fake.
 * Listeners must not throw. `stop()` gives the worker up to 2 s to emit its
 * last finals before it resolves.
 */
export interface TranscriptSource {
  /** Rejects with an Error whose message is fit to show the user. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Subscribes; returns the unsubscribe function. */
  onEvent(cb: (e: SttEvent) => void): () => void;
  onState(cb: (s: SttState, message?: string) => void): () => void;
  state(): SttState;
  /** Microphone level 0..1, for the meter. */
  level(): number;
}

/* ─────────────────────────────── LLM ──────────────────────────────── */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** What a chat call is for: shown in the Debug tab, never sent to Ollama. */
export type ChatPurpose = 'enhance' | 'live' | 'summary-window' | 'summary' | 'actions' | 'qa';

export interface ChatRequest {
  /** What the call is for, for the Debug tab. Not sent: `chatBody` copies only Ollama's fields. */
  purpose?: ChatPurpose;
  model: string;
  messages: ChatMessage[];
  numCtx: number;
  temperature?: number;
  seed?: number;
  /** Maximum tokens to generate. */
  numPredict?: number;
  topK?: number;
  topP?: number;
  repeatPenalty?: number;
  /** JSON schema for structured output. */
  format?: unknown;
  /** Seconds as a number (-1 = keep loaded) or a duration string ("5m"). */
  keepAlive?: number | string;
}

export interface ChatUsage {
  model: string;
  /** All prompt tokens, including the cached ones. */
  promptTokens: number;
  /** The part of `promptTokens` served from Ollama's cache. 0 when not reported. */
  cachedTokens: number;
  outputTokens: number;
  totalMs: number;
  loadMs: number;
  promptMs: number;
  evalMs: number;
}

export interface ChatResult {
  text: string;
  usage: ChatUsage;
  /** Why the model stopped, as Ollama reports it: "stop", or "length" when the token limit cut the answer. */
  doneReason?: string;
}

export interface EmbedRequest {
  model: string;
  input: string[];
  numCtx: number;
  dimensions?: number;
  keepAlive?: number | string;
}

export interface EmbedResult {
  /** One vector per input, in order, as returned by the model (not normalized). */
  vectors: Float32Array[];
  promptTokens: number;
}

/**
 * `unreachable` also covers a connection lost mid-stream. `stalled` can come
 * from any call against a host that accepts the connection and never answers.
 */
export type OllamaErrorKind =
  | 'unreachable'
  | 'model_missing'
  | 'busy'
  | 'stalled'
  | 'aborted'
  | 'http'
  | 'protocol';

export interface OllamaClient {
  /**
   * Streams a chat completion. `onToken` receives each delta and the text so far.
   * Once `signal` aborts, `onToken` is not called again and the promise rejects
   * with kind `aborted`, even if the rest of the answer had already arrived.
   */
  chatStream(
    req: ChatRequest,
    onToken?: (delta: string, full: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult>;
  embed(req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResult>;
  /** Names of the models installed locally. */
  tags(): Promise<string[]>;
  /** Models currently loaded. */
  ps(): Promise<Array<{ name: string; contextLength: number; sizeBytes: number }>>;
  /** Unloads a model now (keep_alive 0). */
  unload(model: string): Promise<void>;
}

export type Priority = 'interactive' | 'live';

/**
 * One generation request at a time per model (Ollama's own limit).
 * Interactive tasks run before live ones. A new live task with the same `key`
 * replaces a queued one and aborts a running one. An interactive task arriving
 * while a live task runs aborts the live task so it starts promptly.
 * An aborted or replaced task rejects with an error of kind `aborted` (test it
 * with `isAborted` from util/errors.ts). An aborted RUNNING task rejects only
 * once its own promise settles and holds the model's slot until then, so a task
 * must honour its AbortSignal.
 */
export interface LlmScheduler {
  run<T>(
    model: string,
    priority: Priority,
    key: string | null,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  /**
   * Interactive work made of several calls is under way for that model (a long summary, read
   * window by window). Between two of its calls the model is free for an instant: until the
   * returned function is called, live tasks wait instead of starting only to be aborted.
   * Interactive tasks are not held back. Optional: a scheduler without it starts live tasks as before.
   */
  hold?(model: string): () => void;
  /** True while an interactive task is running or queued for that model. */
  busy(model: string): boolean;
  /** Aborts everything, running and queued. */
  cancelAll(): void;
}

/* ───────────────────────────── Retrieval ──────────────────────────── */

/** EmbeddingGemma 2 with its task prefixes applied. Vectors are L2-normalized. */
export interface Embedder {
  readonly dim: number;
  embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array>;
  embedDocuments(
    docs: Array<{ title?: string; text: string }>,
    signal?: AbortSignal,
  ): Promise<Float32Array[]>;
}

/** A stretch of transcript (about 30 s of speech) with its embedding. */
export interface TranscriptChunk {
  /** "E1", "E2"... in order of creation. */
  id: string;
  t0: number;
  t1: number;
  text: string;
  turnIds: string[];
}

/** A transcript chunk retrieved for a shorthand line. */
export interface Excerpt {
  id: string;
  /** "mm:ss" of the chunk's start. */
  time: string;
  text: string;
  score: number;
}

/** A numbered source handed to the model for Q&A. */
export interface SourceDoc {
  n: number;
  kind: 'note' | 'linked' | 'transcript';
  /** Note name, or "Transcript". */
  title: string;
  path?: string;
  heading?: string;
  /** "mm:ss" for transcript sources. */
  time?: string;
  text: string;
  score?: number;
}

/** A chunk of a vault note in the knowledge index. */
export interface VaultChunk {
  /** `${path}#${index}` */
  id: string;
  path: string;
  title: string;
  heading: string;
  text: string;
  /** Hash of `text`, to skip re-embedding unchanged chunks. */
  hash: string;
}

export interface VaultIndexStatus {
  status: 'none' | 'building' | 'ready' | 'paused' | 'error';
  files: number;
  chunks: number;
  done: number;
  total: number;
  /**
   * As the index reports it: the folders it was built over. As the session publishes it: the
   * folders chosen in the settings, which the picker and the next build start from, except while
   * a build runs (then the folders being built).
   */
  folders: string[];
  error: string | null;
  /**
   * Set by the session, and only when true: `folders` is not the list the index was built over.
   * The list was changed in the settings since; "Rebuild index" applies it.
   */
  foldersPending?: boolean;
  /**
   * Set only when true: the index in memory was built with another embedding model or dimension
   * than the settings hold, so no note is answered from it; "Build index" applies the current one.
   */
  modelPending?: boolean;
}

/** File access for the knowledge index. Obsidian + node:fs in the plugin, memory in the harness. */
export interface VaultIndexIO {
  /** Markdown files under the given folders ('' or '/' = whole vault). */
  listMarkdown(folders: string[]): Promise<Array<{ path: string; mtime: number }>>;
  read(path: string): Promise<string>;
  /** The persisted index, or null when none exists. */
  load(): Promise<{ index: string; vectors: Uint8Array } | null>;
  save(index: string, vectors: Uint8Array): Promise<void>;
}

/* ─────────────────────────────── Stats ────────────────────────────── */

export interface Stats {
  input: number;
  output: number;
  cached: number;
  /** Keyed by the Monday of the ISO week, YYYY-MM-DD. */
  weekly: Record<string, { input: number; output: number }>;
  meetings: number;
  /** Enhance runs, summaries and answers delivered. */
  assists: number;
}

/* ───────────────────────── Hosts (the outside) ────────────────────── */

export interface DailyInfo {
  /** Vault path of today's daily note, whether or not it exists. */
  path: string;
  basename: string;
  /** YYYY-MM-DD */
  date: string;
  exists: boolean;
}

export interface FirstWritePreview {
  companionPath: string;
  /** The exact line added to the user's note. */
  linkLine: string;
  /** Human description of where it lands: "end of section 1:1 Jane Example". */
  where: string;
  /** The note the line goes into, when it is not the daily. */
  lineNote?: string;
  /** No new note: `companionPath` is the user's own note, which gets the plugin's sections. */
  intoNote?: boolean;
}

/** Everything the session needs from the vault. */
export interface NotesHost {
  today(): DailyInfo;
  /** Current text of today's daily: the editor buffer when open, else the file. Null when missing. */
  readDaily(): Promise<string | null>;
  /** Parsed entity registry; empty when the file is missing. */
  entities(): Promise<Entity[]>;

  exists(path: string): boolean;
  /** Path of the companion whose frontmatter matches, or null. */
  findCompanion(date: string, source: SectionKey): string | null;
  /**
   * Path of the note a link line in the daily points to, or null. `basename`
   * is the link target without folder or `.md`. The link line is the durable
   * identity of a meeting's companion: the frontmatter key goes stale when the
   * heading is renamed. `from` is the note the line is in (the daily when absent).
   */
  findCompanionByBasename(basename: string, from?: string): string | null;
  /** Current text of any note: the editor buffer when open, else the file. Null when missing. */
  readNote(path: string): Promise<string | null>;
  /**
   * Adds the link line to a note other than the daily: at the end of its section `section`, or
   * at the end of the note when null. Idempotent.
   */
  insertNoteLink(args: {
    path: string;
    section: { title: string; ordinal: number } | null;
    title: string;
    companionBasename: string;
    line: string;
    placement: LinkPlacement;
  }): Promise<
    | { status: 'inserted'; via: 'editor' | 'vault' }
    | { status: 'exists' }
    | { status: 'no-daily' }
    | { status: 'no-section' }
  >;
  /**
   * Turns a note into the meeting note itself: the meeting properties are added to its
   * frontmatter and the plugin's empty sections below its text. Nothing else in it changes.
   */
  prepareMeetingNote(
    path: string,
    meta: { date: string; source: string },
  ): Promise<'done' | 'busy' | 'missing' | 'exists'>;
  /** Creates the note in one write. Rejects if the path exists. */
  createCompanion(path: string, content: string): Promise<void>;
  /** Applies region patches. Never throws for expected conditions; see WriteOutcome. */
  writeCompanion(path: string, patches: Patch[]): Promise<WriteOutcome>;
  /** Sets `updated` in the companion's frontmatter. */
  touchCompanion(path: string, isoDate: string): Promise<void>;
  /** Reads a companion's current text, or null. */
  readCompanion(path: string): Promise<string | null>;

  /**
   * Adds the link line to the section in today's daily. Idempotent.
   * `via` tells how it was written, so the caller can show a notice.
   */
  insertDailyLink(args: {
    section: { title: string; ordinal: number };
    companionBasename: string;
    line: string;
    placement: LinkPlacement;
  }): Promise<
    | { status: 'inserted'; via: 'editor' | 'vault' }
    | { status: 'exists' }
    | { status: 'no-daily' }
    | { status: 'no-section' }
  >;
  /** Shows the first-write confirmation. Resolves true when accepted. */
  confirmFirstWrite(preview: FirstWritePreview): Promise<boolean>;

  /** Resolves wikilink targets and returns each note's text, trimmed to `maxChars`. */
  readLinkedNotes(
    links: string[],
    maxChars: number,
  ): Promise<Array<{ title: string; path: string; text: string }>>;

  /** Top-level and second-level vault folders, for the index folder picker. */
  listFolders(): string[];
  openNote(path: string): void;
  notice(message: string, ms?: number): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface StatsIO {
  load(): Promise<Stats | null>;
  save(stats: Stats): Promise<void>;
}

export interface SessionDeps {
  settings(): HamsterSettings;
  /** Persists a settings change made from the sidebar (for example the indexed folders). */
  updateSettings(patch: Partial<HamsterSettings>): Promise<void>;
  local(): LocalSettings;
  setLocal(patch: Partial<LocalSettings>): void;
  notes: NotesHost;
  llm: OllamaClient;
  /** A fresh source per recording. */
  createTranscriptSource(): TranscriptSource;
  /** Null disables the knowledge index. */
  vaultIndexIO: VaultIndexIO | null;
  statsIO: StatsIO;
  clock: Clock;
  clipboard(text: string): void;
  /**
   * How close a passage must score to count as related, for an embedding model. Left out, the
   * measured values of `retrievalFloors` in src/rag/relevance.ts apply.
   */
  retrievalFloors?: (embedModel: string) => {
    enhance: number;
    enhanceGap: number;
    transcript: number;
    vault: number;
  };
}

/* ──────────────────────── State and controller ────────────────────── */

export type TabId = 'meetings' | 'notes' | 'summary' | 'transcript' | 'ask' | 'stats' | 'debug';
export type RecordingState = 'idle' | 'starting' | 'recording' | 'stopping';
export type EnhanceStatus =
  | 'idle'
  | 'evaluating'
  | 'retrieving'
  | 'structuring'
  | 'up-to-date'
  | 'error';

export interface MeetingListEntry {
  /**
   * The section key, or `manual:<timestamp>` for a meeting started on its own. Those are listed,
   * after the sections, while they have a note and are not the current meeting: they can be
   * picked up again with `selectSection`.
   */
  key: SectionKey;
  title: string;
  rawTitle: string;
  ordinal: number;
  /** -1 for a meeting that is not tied to a section of the daily. */
  anchorLine: number;
  isHeading: boolean;
  /** `other` rows are shown collapsed, with a "Treat as meeting" action. */
  group: 'meeting' | 'other';
  companionPath: string | null;
  /** True for the current meeting. */
  current: boolean;
}

export interface MeetingState {
  /** The section key, or `manual:<timestamp>` for a meeting not bound to a section. */
  key: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** Started with "New meeting" and not yet bound to a section of the daily. */
  manual: boolean;
  source: { title: string; ordinal: number } | null;
  companionPath: string | null;
  /** Wall-clock ms; null before the first recording. */
  startedAt: number | null;
  endedAt: number | null;
  /** Regions whose markers are damaged in the companion. */
  detachedRegions: Region[];
  /**
   * Regions of the companion whose text was changed by hand since the plugin last wrote or read
   * them, in a way it could not take in: it no longer writes there, so the edit stays, until the
   * note is adopted again (`createCompanion`), which replaces them with what the sidebar shows.
   * Absent or empty when there is none. The transcript is never listed: it is only added to.
   */
  editedOutside?: Region[];
  /** The cursor is in the daily but outside this meeting's section. */
  cursorOutside: boolean;
  /**
   * A meeting typed in a note other than the daily: that note's path. Its shorthand is read from
   * there, its link line goes there, and `source` stays null (that one is for a daily section).
   */
  notePath?: string;
  /** In that note, the heading section the meeting is; null for the whole note. */
  noteSection?: { title: string; ordinal: number } | null;
}

/** The note last open in the main area, as far as a meeting is concerned. */
export interface FocusedNote {
  path: string;
  basename: string;
  /** True when it is today's daily. */
  daily: boolean;
}

export interface EnhancedItem {
  id: string;
  kind: 'item' | 'topic';
  /** The shorthand line. */
  source: string;
  /** Markdown of the enhanced bullet, without a list marker: "**Topic:** text". Null until first enhanced. */
  bullet: string | null;
  /** The status of the task the shorthand line is, as `SectionItem.task`; absent when it is none. */
  task?: string;
  /** The shorthand changed since this bullet was produced. */
  stale: boolean;
  /** Being generated right now. */
  streaming: boolean;
  excerptIds: string[];
}

/** A cancelled answer keeps its partial text with status `done`, or is removed when it has none. */
export interface QaEntry {
  id: string;
  askedAt: number;
  /** "mm:ss" into the recording, or null outside a recording. */
  meetingTime: string | null;
  question: string;
  answer: string;
  status: 'running' | 'done' | 'error';
  error: string | null;
  sources: SourceDoc[];
  /** Saved to the companion. */
  kept: boolean;
}

export interface QuestionChip {
  id: string;
  text: string;
  time: string;
  turnId: string;
}

/**
 * The session replaces only what changed: an untouched `turns[i]`,
 * `enhanced[i]` or `qa.entries[i]` keeps its object identity across updates.
 * The UI's row memoization relies on it.
 */
export interface HamsterState {
  /**
   * `missingModels` holds no duplicates. `remoteHost` is the host of the Ollama
   * address when that address is not this computer, else null: everything the
   * plugin sends to Ollama is meeting content, so the sidebar says so.
   */
  ollama: { status: 'unknown' | 'ok' | 'unreachable'; missingModels: string[]; remoteHost: string | null };
  daily: DailyInfo;
  sections: MeetingListEntry[];
  /** The section under the cursor in today's daily, when there is no pinned meeting. */
  activeSection: Section | null;
  meeting: MeetingState | null;
  /** Shorthand lines of the current meeting's section (or of the active section). */
  shorthand: SectionItem[];

  recording: RecordingState;
  recordingError: string | null;
  elapsedMs: number;
  micLevel: number;
  stt: SttState;
  /** Null, never an empty string, when there is nothing to say. */
  sttMessage: string | null;
  turns: Turn[];
  partial: { source: SttSource; text: string } | null;

  liveEnhance: boolean;
  enhanceStyle: EnhanceStyle;
  enhanceStatus: EnhanceStatus;
  enhanceError: string | null;
  enhanced: EnhancedItem[];

  /** A cancelled run goes back to `idle` and keeps whatever text had arrived. */
  summary: {
    style: SummaryStyle;
    status: 'idle' | 'running' | 'done' | 'error';
    markdown: string;
    error: string | null;
  };

  qa: { entries: QaEntry[]; chips: QuestionChip[] };

  stats: Stats;
  lastUsage: ChatUsage | null;
  index: VaultIndexStatus;

  tab: TabId;
  /** The note last open in the main area; null before one has been. */
  focusedNote: FocusedNote | null;
  /** Region writes not yet on disk. */
  pendingWrites: number;
  micLabel: string;
  costPer1k: number;
  /** Where companion notes are created, for the UI's explanation. */
  companionFolder: string;
}

/** Every action the UI can take. Every promise settles, and none rejects. */
export interface HamsterController {
  setTab(tab: TabId): void;

  /**
   * Makes a section of today's daily the current meeting, or picks up again a meeting started on
   * its own, by its `manual:` key. Like `newMeeting` and `endMeeting`, it leaves the current
   * meeting: when that one was recorded and has no companion, the first call only says so in a
   * notice, and the same call made again discards it.
   */
  selectSection(key: SectionKey): void;
  /** Starts a meeting not yet bound to a section ("New meeting"). */
  newMeeting(): void;
  /** Binds a manual meeting to the section under the cursor, in the daily or in the note open. */
  linkAtCursor(): Promise<void>;
  /**
   * Makes the note open in the main area (not the daily) hold the current meeting's shorthand:
   * the section under the cursor, or the whole note. A meeting started with "New meeting", even
   * recording, moves there; with no meeting, one starts. Its companion is linked from that note.
   */
  useActiveNote(): Promise<void>;
  /** The same, and the note becomes the meeting note itself: the plugin's sections are added below its text. */
  writeIntoActiveNote(): Promise<void>;
  /** Clears the current meeting from the sidebar. Stops the recording first if needed. */
  endMeeting(): Promise<void>;

  /**
   * The only action that writes to the vault for the first time. For a meeting whose note
   * exists, reads the note again and saves to it what the sidebar shows: the way to write over a
   * region that was set aside (`detachedRegions` once repaired, `editedOutside`).
   */
  createCompanion(): Promise<void>;
  openCompanion(): void;
  openDaily(): void;

  startRecording(): Promise<void>;
  /** Stops the recording. While it is still starting, cancels the start. */
  stopRecording(): Promise<void>;

  setLiveEnhance(on: boolean): void;
  setEnhanceStyle(style: EnhanceStyle): void;
  /**
   * Runs Enhance now. Also the one way to replace the enhanced notes an earlier visit to the
   * meeting left in the companion: Live Enhance and a change of style show theirs in the sidebar only.
   */
  enhanceNow(): Promise<void>;

  /** Writes a summary. Asked for here, it replaces the one an earlier visit left in the companion; the one written at a stop does not. */
  summarize(style: SummaryStyle): Promise<void>;
  cancelSummary(): void;

  ask(question: string, chipId?: string): Promise<void>;
  cancelAsk(id: string): void;
  keepInsight(id: string): Promise<void>;
  dismissChip(id: string): void;

  listFolders(): string[];
  buildIndex(folders: string[]): Promise<void>;
  cancelIndex(): void;

  refreshOllama(): Promise<void>;
  copy(text: string): void;
}

/** What the editor binding reports about today's daily note. */
export interface DailyUpdate {
  path: string;
  text: string;
  /** Cursor offset in `text`, or null when the daily has no focused editor. */
  cursor: number | null;
  /**
   * True when the change came from the user typing or deleting. The session takes the text either
   * way; only a typed change schedules a Live Enhance run.
   */
  userTyped: boolean;
}

/** Subscribable state container (a zustand vanilla store satisfies this). */
export interface HamsterStore {
  getState(): HamsterState;
  subscribe(listener: (state: HamsterState, prev: HamsterState) => void): () => void;
}

export interface HamsterSession {
  store: HamsterStore;
  controller: HamsterController;
  /** Loads stats and the persisted index, checks Ollama, reads today's daily. */
  init(): Promise<void>;
  /** Called by the editor binding on every change or cursor move in today's daily. */
  handleDailyUpdate(update: DailyUpdate): void;
  /** The same for another note: the one open in the main area, or the one a meeting is typed in. */
  handleNoteUpdate(update: DailyUpdate): void;
  /** The note open in the main area changed. `text` is null when it is not known yet. */
  handleFocus(focus: { path: string; text: string | null; cursor: number | null }): void;
  /** Called when today's daily is created, deleted, renamed, or the date rolls over. */
  handleDailyAvailability(): void;
  /** Called when a vault note changes, for incremental re-indexing. */
  handleVaultChange(change: { type: 'modify' | 'delete'; path: string } | { type: 'rename'; path: string; oldPath: string }): void;
  /** Called when settings change. */
  handleSettingsChange(): void;
  /** Writes everything pending. Resolves within `capMs`. */
  flushAll(capMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

/** What React needs from the host besides state and actions. */
export interface UiHost {
  /**
   * Renders Markdown into `el`, replacing what was there, and returns a cleanup
   * function. The text is a model's: an implementation must build its output
   * from inert elements only (see src/ui/miniMarkdown.ts) and must never hand
   * it to Obsidian's renderer, whose post-processors run code blocks.
   */
  renderMarkdown(markdown: string, el: HTMLElement): () => void;
  /** The exchanges with the model, for the Debug tab. Absent: no Debug tab. */
  callLog?: import('./llm/callLog.ts').CallLog;
  /** The Terminal command that sets speech recognition up for this version of the plugin (`speechSetupCommand`). */
  speechSetupCommand: string;
}
