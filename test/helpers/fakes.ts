import { UNMEASURED_FLOORS } from '../../src/rag/relevance.ts';
import type {
  ChatRequest,
  ChatResult,
  Clock,
  DailyInfo,
  EmbedRequest,
  EmbedResult,
  Entity,
  FirstWritePreview,
  HamsterSettings,
  LinkPlacement,
  LocalSettings,
  NotesHost,
  OllamaClient,
  Patch,
  SectionKey,
  SessionDeps,
  Stats,
  StatsIO,
  SttEvent,
  SttSource,
  SttState,
  TranscriptSource,
  VaultIndexIO,
  WriteOutcome,
} from '../../src/types.ts';
import { entityNames, parseEntities } from '../../src/editor/entities.ts';
import { findSection, isLinkLine, linkInsertion, wholeNoteSection, wikilinks } from '../../src/editor/sectionAt.ts';
import type { SectionOptions } from '../../src/editor/sectionAt.ts';
import { OllamaError } from '../../src/llm/ollama.ts';
import { mergeAll, readCompanionKeys, regionSkeleton } from '../../src/notes/companion.ts';
import { DEFAULT_LOCAL, DEFAULT_SETTINGS, softMarkerRegex } from '../../src/settings.ts';

/**
 * The settings the tests were written against: the plugin's defaults, with the values of the vault
 * it was first built for (a PARA vault: dailies and companions in 00 Inbox, an entity registry,
 * its own meeting words and properties). The released defaults are generic.
 */
export const TEST_SETTINGS: HamsterSettings = {
  ...DEFAULT_SETTINGS,
  micLabel: 'Fred',
  companionFolder: '00 Inbox',
  entitiesPath: '40 Resources/_entities.md',
  softMarkerPattern: '^(1:1|Ad ?Hoc|Prep|Steering|Rencontre)\\b',
  companionProperties: 'area: work\nstatus: active',
};
import { abortError } from '../../src/util/errors.ts';
import { hash53 } from '../../src/util/hash.ts';
import { estimateTokens } from '../../src/util/text.ts';

/* Stand-ins for everything the session reaches through SessionDeps. The unit
   tests and the browser harness share them, so nothing here may import
   `node:*` or touch the DOM. */

/* ─────────────────────────────── Clock ──────────────────────────────── */

interface ArmedTimer {
  at: number;
  fn: () => void;
  every: number | null;
}

/** Time that only moves when a test says so. */
export class ManualClock implements Clock {
  private time: number;
  private nextId = 1;
  private readonly timers = new Map<number, ArmedTimer>();

  /** Starts at 14:05 local time on 2026-10-09: the date the fake vault calls today. */
  constructor(start: number = new Date(2026, 9, 9, 14, 5, 0).getTime()) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), fn, every: null });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  setInterval(fn: () => void, ms: number): unknown {
    const every = Math.max(1, ms);
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + every, fn, every });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Timers and intervals still armed. */
  pending(): number {
    return this.timers.size;
  }

  /** Moves time forward, firing due timers in order, including those armed on the way. */
  advance(ms: number): void {
    const end = this.time + Math.max(0, ms);
    for (;;) {
      let nextId = 0;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      const timer = this.timers.get(nextId);
      if (!timer) break;
      this.time = Math.max(this.time, timer.at);
      if (timer.every === null) this.timers.delete(nextId);
      else timer.at += timer.every;
      timer.fn();
    }
    this.time = end;
  }
}

/* ─────────────────────────────── Vault ──────────────────────────────── */

function leafOf(target: string): string {
  return target.slice(target.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

export interface FakeNotesOptions {
  /** Read on every call, so a test can change the prefix or the soft markers. */
  settings?: () => HamsterSettings;
  /** YYYY-MM-DD */
  date?: string;
  dailyFolder?: string;
}

/** An in-memory vault with the real region and link-line logic. */
export class FakeNotesHost implements NotesHost {
  /** Path to text: the daily, the companions and every other note. */
  readonly files = new Map<string, string>();
  date: string;
  dailyFolder: string;
  /** Markdown of the entity registry. */
  entitiesText = '';
  /** What the first-write confirmation answers. */
  confirmAnswer = true;
  /** While true, `writeCompanion` answers `retry`, as within 2.5 s of an edit in an editor. */
  recentlyEdited = false;
  retryAfterMs = 500;
  /** How `insertDailyLink` says the line was written. */
  linkVia: 'editor' | 'vault' = 'editor';
  /** Overrides the folders derived from the files. */
  folders: string[] | null = null;
  /**
   * Called with the path of a companion each time the plugin itself changes it, as Obsidian's
   * `modify` event is: a test or the harness can hand it on to `handleVaultChange`.
   */
  onWrite: ((path: string) => void) | null = null;

  readonly confirmations: FirstWritePreview[] = [];
  /** Link lines added to notes other than the daily. */
  readonly noteLinks: Array<{ path: string; line: string }> = [];
  /** Notes turned into their own meeting note. */
  readonly preparedNotes: string[] = [];
  readonly notices: string[] = [];
  readonly opened: string[] = [];
  readonly writes: Array<{ path: string; patches: Patch[]; outcome: WriteOutcome }> = [];
  readonly touched: Array<{ path: string; isoDate: string }> = [];
  readonly linkedReads: Array<{ links: string[]; maxChars: number }> = [];

  private readonly settings: () => HamsterSettings;

  constructor(options: FakeNotesOptions = {}) {
    this.settings = options.settings ?? (() => TEST_SETTINGS);
    this.date = options.date ?? '2026-10-09';
    this.dailyFolder = options.dailyFolder ?? '00 Inbox';
  }

  /** Text of today's daily, or null when it does not exist. */
  get dailyText(): string | null {
    return this.files.get(this.today().path) ?? null;
  }

  /** Writes today's daily; null deletes it. */
  setDaily(text: string | null): void {
    const path = this.today().path;
    if (text === null) this.files.delete(path);
    else this.files.set(path, text);
  }

  today(): DailyInfo {
    const folder = this.dailyFolder.replace(/\/+$/, '');
    const path = folder === '' ? `${this.date}.md` : `${folder}/${this.date}.md`;
    return { path, basename: this.date, date: this.date, exists: this.files.has(path) };
  }

  async readDaily(): Promise<string | null> {
    return this.dailyText;
  }

  async entities(): Promise<Entity[]> {
    return parseEntities(this.entitiesText);
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  findCompanion(date: string, source: SectionKey): string | null {
    for (const [path, text] of this.files) {
      if (!text.includes('hamster_source')) continue;
      const keys = readCompanionKeys(text);
      if (keys.date === date && keys.source === source) return path;
    }
    return null;
  }

  findCompanionByBasename(basename: string): string | null {
    for (const path of this.files.keys()) {
      // A link resolves to a note: an attachment of the same name is not one.
      if (/\.md$/i.test(path) && leafOf(path) === basename) return path;
    }
    return null;
  }

  async createCompanion(path: string, content: string): Promise<void> {
    if (this.files.has(path)) throw new Error(`A note already exists at ${path}.`);
    this.files.set(path, content);
    this.onWrite?.(path);
  }

  async writeCompanion(path: string, patches: Patch[]): Promise<WriteOutcome> {
    const before = this.files.get(path);
    const outcome = this.applyPatches(path, patches);
    this.writes.push({ path, patches, outcome });
    if (this.files.get(path) !== before) this.onWrite?.(path);
    return outcome;
  }

  private applyPatches(path: string, patches: Patch[]): WriteOutcome {
    const text = this.files.get(path);
    if (text === undefined) return { status: 'missing' };
    if (this.recentlyEdited) return { status: 'retry', afterMs: this.retryAfterMs };
    const merged = mergeAll(text, patches);
    if (merged.changed) this.files.set(path, merged.text);
    return merged.detached.length > 0 ? { status: 'detached', regions: merged.detached } : { status: 'ok' };
  }

  async touchCompanion(path: string, isoDate: string): Promise<void> {
    this.touched.push({ path, isoDate });
    const text = this.files.get(path);
    if (text === undefined) return;
    const next = text.replace(/^updated: .*$/m, `updated: ${isoDate}`);
    this.files.set(path, next);
    if (next !== text) this.onWrite?.(path);
  }

  async readCompanion(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async insertDailyLink(args: {
    section: { title: string; ordinal: number };
    companionBasename: string;
    line: string;
    placement: LinkPlacement;
  }): Promise<
    | { status: 'inserted'; via: 'editor' | 'vault' }
    | { status: 'exists' }
    | { status: 'no-daily' }
    | { status: 'no-section' }
  > {
    const text = this.dailyText;
    if (text === null) return { status: 'no-daily' };
    const options = this.sectionOptions();
    const section = findSection(text, args.section, options, args.companionBasename);
    if (!section) return { status: 'no-section' };

    const lines = text.split('\n');
    const end = Math.min(section.bodyEndLine, lines.length);
    for (let i = section.bodyStartLine; i < end; i++) {
      if (!isLinkLine(lines[i], options.linkPrefix)) continue;
      // The target, not the text of the line: the alias may have been changed in settings since.
      if (wikilinks(lines[i]).some((target) => leafOf(target) === args.companionBasename)) {
        return { status: 'exists' };
      }
    }

    const { afterLine, blankBefore } = linkInsertion(text, section, args.placement);
    lines.splice(afterLine + 1, 0, ...(blankBefore ? ['', args.line] : [args.line]));
    this.setDaily(lines.join('\n'));
    return { status: 'inserted', via: this.linkVia };
  }

  async readNote(path: string): Promise<string | null> {
    if (path === this.today().path) return this.dailyText;
    return this.files.get(path) ?? null;
  }

  async insertNoteLink(args: {
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
  > {
    const text = this.files.get(args.path);
    if (text === undefined) return { status: 'no-daily' };
    const options = this.sectionOptions();
    const section = args.section
      ? findSection(text, args.section, options, args.companionBasename)
      : wholeNoteSection(text, args.title, options);
    if (!section) return { status: 'no-section' };
    const lines = text.split('\n');
    const end = Math.min(section.bodyEndLine, lines.length);
    for (let i = section.bodyStartLine; i < end; i++) {
      if (!isLinkLine(lines[i], options.linkPrefix)) continue;
      if (wikilinks(lines[i]).some((target) => leafOf(target) === args.companionBasename)) return { status: 'exists' };
    }
    const at = linkInsertion(text, section, args.section ? args.placement : 'section-end');
    const afterLine = Math.max(0, at.afterLine);
    lines.splice(afterLine + 1, 0, ...(at.blankBefore ? ['', args.line] : [args.line]));
    this.files.set(args.path, lines.join('\n'));
    this.noteLinks.push({ path: args.path, line: args.line });
    return { status: 'inserted', via: this.linkVia };
  }

  async prepareMeetingNote(
    path: string,
    meta: { date: string; source: string },
  ): Promise<'done' | 'busy' | 'missing' | 'exists'> {
    const text = this.files.get(path);
    if (text === undefined) return 'missing';
    if (text.includes('<!-- hamster:begin')) return 'exists';
    const props = [`type: meeting`, `date: ${meta.date}`, `hamster_source: "${meta.source}"`, 'tags: [meeting, magical-hamster]'];
    let body = text;
    let front = props;
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    if (fm) {
      front = [...fm[1].split('\n').filter((line) => !/^(date|hamster_source|tags):/.test(line)), ...props.filter((p) => !(p.startsWith('type:') && /^type:/m.test(fm[1])))];
      body = text.slice(fm[0].length);
    }
    const trimmed = body.replace(/\s+$/, '');
    this.files.set(path, `---\n${front.join('\n')}\n---\n${trimmed}\n${regionSkeleton().join('\n')}\n`);
    this.preparedNotes.push(path);
    return 'done';
  }

  async confirmFirstWrite(preview: FirstWritePreview): Promise<boolean> {
    this.confirmations.push(preview);
    return this.confirmAnswer;
  }

  async readLinkedNotes(
    links: string[],
    maxChars: number,
  ): Promise<Array<{ title: string; path: string; text: string }>> {
    this.linkedReads.push({ links: [...links], maxChars });
    const found: Array<{ title: string; path: string; text: string }> = [];
    for (const link of links) {
      const wanted = leafOf(link);
      for (const [path, text] of this.files) {
        if (leafOf(path) !== wanted) continue;
        found.push({ title: wanted, path, text: text.slice(0, maxChars) });
        break;
      }
    }
    return found;
  }

  listFolders(): string[] {
    if (this.folders) return [...this.folders];
    const folders = new Set<string>();
    for (const path of this.files.keys()) {
      const parts = path.split('/').slice(0, -1);
      if (parts.length >= 1) folders.add(parts[0]);
      if (parts.length >= 2) folders.add(`${parts[0]}/${parts[1]}`);
    }
    return [...folders].sort();
  }

  openNote(path: string): void {
    this.opened.push(path);
  }

  notice(message: string): void {
    this.notices.push(message);
  }

  private sectionOptions(): SectionOptions & { linkPrefix: string } {
    const s = this.settings();
    return {
      softMarker: softMarkerRegex(s),
      entityNames: entityNames(parseEntities(this.entitiesText)),
      linkPrefix: s.companionPrefix,
    };
  }
}

/* ─────────────────────────────── Speech ─────────────────────────────── */

/** A transcript source driven by hand: `say`, `partial`, `emit`, `setState`. */
export class FakeTranscriptSource implements TranscriptSource {
  /** When set, `start()` rejects with it after reporting `failState`. */
  startError: Error | null = null;
  failState: SttState = 'failed';
  /** When set, `start()` waits for it: the worker is still loading its model. */
  startGate: Promise<void> | null = null;
  /** Events the worker still emits while it stops: its last finals. */
  lastWords: SttEvent[] = [];
  micLevel = 0;
  starts = 0;
  stops = 0;

  private current: SttState = 'idle';
  private readonly eventListeners = new Set<(e: SttEvent) => void>();
  private readonly stateListeners = new Set<(s: SttState, message?: string) => void>();
  private stopping: Promise<void> | null = null;

  async start(): Promise<void> {
    this.starts += 1;
    this.setState('spawning');
    if (this.startGate) await this.startGate;
    if (this.startError) {
      this.setState(this.failState, this.startError.message);
      throw this.startError;
    }
    if (this.stopping) throw new Error('The recording was stopped before it started.');
    this.setState('ready');
    this.setState('running');
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.stops += 1;
      this.setState('stopping');
      for (const event of this.lastWords) this.emit(event);
      this.setState('exited');
    })();
    return this.stopping;
  }

  onEvent(cb: (e: SttEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  onState(cb: (s: SttState, message?: string) => void): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  state(): SttState {
    return this.current;
  }

  level(): number {
    return this.micLevel;
  }

  /** How many listeners are still subscribed: a session that stopped should hold none. */
  listeners(): number {
    return this.eventListeners.size + this.stateListeners.size;
  }

  emit(event: SttEvent): void {
    for (const listener of [...this.eventListeners]) listener(event);
  }

  setState(state: SttState, message?: string): void {
    this.current = state;
    for (const listener of [...this.stateListeners]) listener(state, message);
  }

  /** A finished stretch of speech. Times are seconds since this recording started. */
  say(text: string, t0: number, t1: number, source: SttSource = 'mic'): void {
    this.emit({ type: 'segment', source, t0, t1, text, isFinal: true });
  }

  /** Speech still being recognised. */
  partial(text: string, source: SttSource = 'mic'): void {
    this.emit({ type: 'segment', source, t0: 0, t1: 0, text, isFinal: false });
  }
}

/* ─────────────────────────────── Ollama ─────────────────────────────── */

export type FakeAnswer = (req: ChatRequest) => string | Error;

/** The numbered items of an Enhance request, read back from its user message. */
export function promptItems(req: ChatRequest): Array<{ n: number; text: string }> {
  const user = req.messages[req.messages.length - 1]?.content ?? '';
  const items: Array<{ n: number; text: string }> = [];
  for (const m of user.matchAll(/<item n="(\d+)" excerpts="[^"]*">(.*)<\/item>/g)) {
    items.push({ n: Number(m[1]), text: m[2] });
  }
  return items;
}

/** A plausible answer to each kind of request the plugin makes. */
export function defaultAnswer(req: ChatRequest): string {
  const user = req.messages[req.messages.length - 1]?.content ?? '';
  const items = promptItems(req);
  if (items.length > 0) return items.map((item) => `${item.n}. **Note:** ${item.text}`).join('\n');
  if (req.format !== undefined) {
    return JSON.stringify({ items: [{ owner: 'Jane', task: 'Send the plan', due: 'Friday' }] });
  }
  if (/^Question: /m.test(user)) return 'The notes say so [1].';
  return [
    '### Overview',
    'The meeting covered the plan and the budget.',
    '',
    '### Action items',
    '- **Jane**: send the plan (Friday)',
    '',
    '### Details',
    '- The budget stays as it is',
  ].join('\n');
}

export function unreachableError(): OllamaError {
  return new OllamaError('unreachable', 'Ollama is not reachable at http://localhost:11434.');
}

export function missingModelError(model: string): OllamaError {
  return new OllamaError('model_missing', `Model ${model} is not installed in Ollama.`, { status: 404, model });
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'what', 'was', 'are', 'les', 'des', 'une', 'est', 'pour', 'que',
  'qui', 'dans', 'sur',
]);

/* The embedder wraps every text in the model's task prefix. Left in, those
   words would be most of a short text and everything would look alike. */
function embeddedText(prompt: string): string {
  const query = /^task: [^|]*\| query: /.exec(prompt);
  if (query) return prompt.slice(query[0].length);
  const doc = /^title: (.*?) \| text: /.exec(prompt);
  if (doc) return `${doc[1] === 'none' ? '' : doc[1]} ${prompt.slice(doc[0].length)}`;
  return prompt;
}

/** Hashed bag of words: texts that share words score higher. */
export function bagOfWords(prompt: string, dim: number): Float32Array {
  const vector = new Float32Array(dim);
  for (const word of embeddedText(prompt).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (word.length >= 3 && !STOP_WORDS.has(word)) vector[hash53(word) % dim] += 1;
  }
  return vector;
}

function inPieces(text: string, count: number): string[] {
  const words = text.split(/(?<=\s)/).filter((word) => word !== '');
  const size = Math.max(1, Math.ceil(words.length / Math.max(1, count)));
  const pieces: string[] = [];
  for (let i = 0; i < words.length; i += size) pieces.push(words.slice(i, i + size).join(''));
  return pieces;
}

function untilAborted(wait: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return wait;
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    void wait.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

export interface FakeOllamaOptions {
  /** With `pieceDelayMs`, spaces the pieces of an answer out in time (the harness shows them arrive). */
  clock?: Clock;
  pieceDelayMs?: number;
  /** How many pieces an answer is streamed in. Default 4. */
  pieces?: number;
}

/** Answers from a function, streams in a few pieces, embeds deterministically. */
export class FakeOllama implements OllamaClient {
  /** What `tags()` answers. An Error is thrown instead: Ollama is down. */
  installed: string[] | Error = [DEFAULT_SETTINGS.llmModel, DEFAULT_SETTINGS.embedModel];
  answer: FakeAnswer = defaultAnswer;
  /** When set, every embedding request fails with it. */
  embedError: Error | null = null;
  readonly chats: ChatRequest[] = [];
  readonly embeds: EmbedRequest[] = [];
  readonly unloaded: string[] = [];

  private readonly options: FakeOllamaOptions;
  private gate: Promise<void> | null = null;

  constructor(options: FakeOllamaOptions = {}) {
    this.options = options;
  }

  /**
   * Chats started from now on stop after their first piece. The returned
   * function lets them finish. An abort ends a held chat at once.
   */
  hold(): () => void {
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.gate = gate;
    return () => {
      if (this.gate === gate) this.gate = null;
      open();
    };
  }

  async chatStream(
    req: ChatRequest,
    onToken?: (delta: string, full: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    this.chats.push(req);
    const gate = this.gate;
    // Like the network: nothing comes back in the same tick.
    await Promise.resolve();
    if (signal?.aborted) throw abortError();
    const reply = this.answer(req);
    if (reply instanceof Error) throw reply;

    const pieces = inPieces(reply, this.options.pieces ?? 4);
    let full = '';
    for (let i = 0; i < pieces.length; i++) {
      full += pieces[i];
      onToken?.(pieces[i], full);
      if (i === 0 && gate) await untilAborted(gate, signal);
      else await this.pause(signal);
      if (signal?.aborted) throw abortError();
    }
    if (pieces.length === 0 && gate) await untilAborted(gate, signal);
    if (signal?.aborted) throw abortError();

    const promptTokens = req.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const outputTokens = estimateTokens(full);
    return {
      text: full,
      usage: {
        model: req.model,
        promptTokens,
        cachedTokens: 0,
        outputTokens,
        totalMs: 40 + outputTokens * 30,
        loadMs: 0,
        promptMs: 40,
        evalMs: outputTokens * 30,
      },
    };
  }

  async embed(req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResult> {
    this.embeds.push(req);
    await Promise.resolve();
    if (signal?.aborted) throw abortError();
    if (this.embedError) throw this.embedError;
    const dim = req.dimensions ?? DEFAULT_SETTINGS.embedDimensions;
    return {
      vectors: req.input.map((text) => bagOfWords(text, dim)),
      promptTokens: req.input.reduce((sum, text) => sum + estimateTokens(text), 0),
    };
  }

  async tags(): Promise<string[]> {
    if (this.installed instanceof Error) throw this.installed;
    return [...this.installed];
  }

  async ps(): Promise<Array<{ name: string; contextLength: number; sizeBytes: number }>> {
    return [];
  }

  async unload(model: string): Promise<void> {
    this.unloaded.push(model);
  }

  private pause(signal: AbortSignal | undefined): Promise<void> {
    const { clock, pieceDelayMs } = this.options;
    if (!clock || !pieceDelayMs || pieceDelayMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clock.clearTimeout(handle);
        reject(abortError());
      };
      const handle = clock.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, pieceDelayMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/* ───────────────────────────── Persistence ──────────────────────────── */

export interface MemoryStatsIO extends StatsIO {
  /** What a fresh start would load. */
  stored: Stats | null;
  saves: number;
}

export function memoryStatsIO(initial: Stats | null = null): MemoryStatsIO {
  const io: MemoryStatsIO = {
    stored: initial,
    saves: 0,
    async load() {
      return io.stored;
    },
    async save(stats) {
      io.stored = stats;
      io.saves += 1;
    },
  };
  return io;
}

export interface MemoryVaultIndexIO extends VaultIndexIO {
  /** The persisted index, as the last `save` left it. */
  saved: { index: string; vectors: Uint8Array } | null;
  readonly reads: string[];
}

/**
 * Index I/O over a map of notes. Pass the fake vault's own `files` to index
 * what the session writes. A file's modification time is a hash of its text:
 * it changes when the text does.
 */
export function memoryVaultIndexIO(files: Map<string, string> | Record<string, string> = {}): MemoryVaultIndexIO {
  const vault = files instanceof Map ? files : new Map(Object.entries(files));
  const io: MemoryVaultIndexIO = {
    saved: null,
    reads: [],
    async listMarkdown(folders) {
      const prefixes = folders
        .map((folder) => folder.trim().replace(/^\/+|\/+$/g, ''))
        .map((folder) => (folder === '' ? '' : `${folder}/`));
      const listed: Array<{ path: string; mtime: number }> = [];
      for (const [path, text] of vault) {
        if (!/\.md$/i.test(path) || !prefixes.some((prefix) => path.startsWith(prefix))) continue;
        listed.push({ path, mtime: hash53(text) });
      }
      return listed;
    },
    async read(path) {
      io.reads.push(path);
      const text = vault.get(path);
      if (text === undefined) throw new Error(`Cannot read ${path}`);
      return text;
    },
    async load() {
      return io.saved;
    },
    async save(index, vectors) {
      io.saved = { index, vectors: vectors.slice() };
    },
  };
  return io;
}

/* ─────────────────────────────── Wiring ─────────────────────────────── */

/** A complete SessionDeps on fakes and TEST_SETTINGS. Pass the fakes a test wants to keep a hand on. */
export function makeDeps(overrides: Partial<SessionDeps> = {}): SessionDeps {
  let settings: HamsterSettings = { ...TEST_SETTINGS, indexedFolders: [...TEST_SETTINGS.indexedFolders] };
  let local: LocalSettings = { ...DEFAULT_LOCAL };
  const readSettings = overrides.settings ?? (() => settings);
  return {
    settings: readSettings,
    async updateSettings(patch) {
      settings = { ...settings, ...patch };
    },
    local: () => local,
    setLocal(patch) {
      local = { ...local, ...patch };
    },
    notes: new FakeNotesHost({ settings: readSettings }),
    llm: new FakeOllama(),
    createTranscriptSource: () => new FakeTranscriptSource(),
    vaultIndexIO: null,
    statsIO: memoryStatsIO(),
    clock: new ManualClock(),
    clipboard: () => {},
    // The fake embedder's scores are not EmbeddingGemma's: the floors measured on the real
    // model would drop every passage here.
    retrievalFloors: () => UNMEASURED_FLOORS,
    ...overrides,
  };
}

export interface FakeWorldOptions {
  settings?: Partial<HamsterSettings>;
  local?: Partial<LocalSettings>;
  /** Text of today's daily. Left out or null: the daily does not exist. */
  daily?: string | null;
  /** YYYY-MM-DD */
  date?: string;
  /** Other notes of the vault, path to text. */
  files?: Record<string, string>;
  /** Markdown of the entity registry. */
  entities?: string;
  /** Gives the session a knowledge index over the fake vault. */
  index?: boolean;
  stats?: Stats | null;
  ollama?: FakeOllamaOptions;
}

/** The fakes behind one SessionDeps, each within reach. */
export interface FakeWorld {
  deps: SessionDeps;
  clock: ManualClock;
  notes: FakeNotesHost;
  llm: FakeOllama;
  statsIO: MemoryStatsIO;
  indexIO: MemoryVaultIndexIO | null;
  /** Every source handed to the session, oldest first. */
  sources: FakeTranscriptSource[];
  /** Runs on each new source before the session sees it, to script a failure for instance. */
  prepareSource: ((source: FakeTranscriptSource) => void) | null;
  clipboard: string[];
  settings(): HamsterSettings;
  setSettings(patch: Partial<HamsterSettings>): void;
  local(): LocalSettings;
}

export function makeWorld(options: FakeWorldOptions = {}): FakeWorld {
  let settings: HamsterSettings = { ...TEST_SETTINGS, indexedFolders: [], ...options.settings };
  let local: LocalSettings = { ...DEFAULT_LOCAL, ...options.local };

  const clock = new ManualClock();
  const notes = new FakeNotesHost({ settings: () => settings, date: options.date });
  for (const [path, text] of Object.entries(options.files ?? {})) notes.files.set(path, text);
  if (options.entities !== undefined) notes.entitiesText = options.entities;
  if (typeof options.daily === 'string') notes.setDaily(options.daily);

  const llm = new FakeOllama(options.ollama);
  const statsIO = memoryStatsIO(options.stats ?? null);
  const indexIO = options.index ? memoryVaultIndexIO(notes.files) : null;

  const world: FakeWorld = {
    deps: makeDeps({
      settings: () => settings,
      async updateSettings(patch) {
        settings = { ...settings, ...patch };
      },
      local: () => local,
      setLocal(patch) {
        local = { ...local, ...patch };
      },
      notes,
      llm,
      createTranscriptSource() {
        const source = new FakeTranscriptSource();
        world.prepareSource?.(source);
        world.sources.push(source);
        return source;
      },
      vaultIndexIO: indexIO,
      statsIO,
      clock,
      clipboard(text) {
        world.clipboard.push(text);
      },
    }),
    clock,
    notes,
    llm,
    statsIO,
    indexIO,
    sources: [],
    prepareSource: null,
    clipboard: [],
    settings: () => settings,
    setSettings(patch) {
      settings = { ...settings, ...patch };
    },
    local: () => local,
  };
  return world;
}
