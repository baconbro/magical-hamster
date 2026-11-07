import type {
  ChatRequest,
  ChatResult,
  ChatUsage,
  Clock,
  EnhancedItem,
  EnhanceStatus,
  EnhanceStyle,
  Excerpt,
  LlmScheduler,
  OllamaClient,
  Priority,
  SectionItem,
} from '../types.ts';
import { isFunctionWord } from '../util/lang.ts';
import { collapseWhitespace, estimateTokens, truncate } from '../util/text.ts';
import {
  calendarKey,
  enhanceMessages,
  groupedFigures,
  isCalendarWord,
  isGroupedFigure,
  keepTerms,
  openItemAtEnd,
  parseEnhance,
  plainLinks,
} from './prompts.ts';
import type { EnhancePromptItem } from './prompts.ts';
import { taskMark } from '../util/tasks.ts';

export interface EnhanceSettings {
  model: string;
  liveModel: string;
  numCtx: number;
  style: EnhanceStyle;
  debounceMs: number;
  maxWaitMs: number;
  micLabel: string;
  /**
   * How long Ollama keeps the model after a call. Thirty minutes when absent. Never -1: nothing
   * unloads a model whose last request asked to stay for good, not even quitting Obsidian.
   */
  keepAlive?: number | string;
}

export interface EnhanceEngineDeps {
  llm: OllamaClient;
  scheduler: LlmScheduler;
  clock: Clock;
  settings(): EnhanceSettings;
  /** Top transcript excerpts for one shorthand line. Absent = no transcript yet. */
  retrieve?: (text: string, signal: AbortSignal) => Promise<Excerpt[]>;
  glossary?: () => string[];
  onState(items: EnhancedItem[], status: EnhanceStatus, error: string | null): void;
  onUsage(usage: ChatUsage): void;
}

const BATCH_SIZE = 8;
const STREAM_INTERVAL_MS = 250;
const EXCERPTS_PER_LINE = 3;
/** Excerpt tokens per call. Reading the prompt is most of a live run's delay, so it is capped. */
const EXCERPT_TOKENS = 3000;
/** System text, tags and the meeting header, in tokens. */
const PROMPT_OVERHEAD = 900;
/** Most tokens one call may write, whatever its lines add up to. */
const PREDICT_CAP = 2000;
/** Past this, a line is summed up rather than restated (`holdsLine`). */
const LONG_LINE_CHARS = 200;
/** A run re-evaluates after each pass; two skips end in a fallback, so this is only a guard. */
const MAX_PASSES = 6;
const SCHEDULER_KEY = 'enhance';
const KEEP_ALIVE = '30m';

interface Entry {
  id: string;
  kind: 'item' | 'topic';
  source: string;
  /** The line's task status, as `SectionItem.task`. Never sent to the model: put back on the bullet when written. */
  task?: string;
  /** The last complete bullet. */
  bullet: string | null;
  /** Text of the bullet being generated, shown in the pane but never saved. */
  partial: string | null;
  stale: boolean;
  streaming: boolean;
  /** Excerpts the current bullet was written from. */
  excerptIds: string[];
  /** Every excerpt retrieval has offered for this line once a call has dealt with it. */
  seen: Set<string>;
  /** Style the bullet was written in. */
  style: EnhanceStyle | null;
  /** Consecutive calls that returned nothing for this line. */
  skips: number;
  /** Transcript arrived since this line's excerpts were last searched. */
  recheck: boolean;
  /** The run whose call is generating this line. */
  owner: Run | null;
  /** Excerpts that took this line over once: never offered to it again. */
  distrusted: Set<string>;
}

interface Run {
  priority: Priority;
  abort: AbortController;
  model: string;
  /** Lines in the call that is at the model right now. */
  batch: Entry[];
  /** Those of them the call was to re-check: they get the flag back if the call is dropped. */
  flagged: Set<Entry>;
  /** Retrieval results, kept so that a second pass does not embed the same line again. */
  found: Map<Entry, Excerpt[]>;
  /** Transcript arrived since those results were fetched. */
  outdated: boolean;
}

function isLine(e: Entry): boolean {
  return e.kind === 'item' && e.source.trim() !== '';
}

function kindOf(e: unknown): string | undefined {
  return (e as { kind?: string } | null | undefined)?.kind;
}

function describeError(e: unknown, model: string): string {
  const err = e as { model?: string | null; message?: string } | null | undefined;
  switch (kindOf(e)) {
    case 'unreachable':
      return 'Ollama is not running';
    case 'model_missing':
      return `Model ${err?.model || model} is not installed`;
    case 'busy':
      return 'Ollama is busy, try again in a moment';
    case 'stalled':
      return 'The model stopped responding';
    default: {
      const detail = collapseWhitespace(String(err?.message ?? ''));
      return truncate(detail ? `Enhance failed: ${detail}` : 'Enhance failed', 140);
    }
  }
}

/**
 * The local pass over a bullet: plain text for wikilinks, no list marker, one line. It is what
 * `markdown()` writes after the `- `, so it also tells whether a bullet would be written as it stands.
 */
export function cleanBullet(text: string): string {
  return collapseWhitespace(plainLinks(text))
    .replace(/^(?:(?:[-+•]|\*(?!\*)|\d{1,3}[.)])\s+)+/, '')
    .replace(/^(?:\[[ xX]\]|[☐☑])\s+/u, '')
    .trim();
}

/** Lower case and without accents: "Gelés" and "geles" are one word. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** The words of four letters or more: shorter ones ("the", "de", "is") are in every note. */
function longWords(text: string): string[] {
  return fold(text).match(/\p{L}{4,}/gu) ?? [];
}

/** True when `text` holds `term` at the start of a word: "nov" is in "november", not in "innovation". Both already folded. */
function holdsTerm(text: string, term: string): boolean {
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1])) return true;
  }
  return false;
}

/** The numbers written in a text, without leading zeros: "14h30" gives 14 and 30, "03" gives 3. */
function digitRuns(text: string): string[] {
  return (text.match(/\d+/g) ?? []).map((run) => run.replace(/^0+(?=\d)/, ''));
}

/**
 * True when a bullet still carries what a term of its line was kept for. A model reformats
 * figures as a matter of course ("10%" as "10 %", "14h30" as "14 h 30", "40k" as "40 000"), so
 * a term that holds digits is recognised by one of its numbers; a name or an acronym by its
 * letters, accents and case aside ("Dec" in "décembre").
 */
function keepsTerm(bullet: string, bulletNumbers: Set<string>, term: string): boolean {
  const numbers = digitRuns(term);
  if (numbers.length === 0) {
    // A day or a month in either language: "avant Thu" is kept by "avant jeudi".
    const day = calendarKey(term);
    if (day) return calendarKeys(bullet).has(day) || holdsTerm(fold(bullet), fold(term));
    return holdsTerm(fold(bullet), fold(term));
  }
  // "1 200" is one figure: its bullet holds it whole ("1 200", "1,200", "1200"), not "200". A
  // range or an amount with cents holds each of its grouped figures: "10 000-15 000 $".
  if (isGroupedFigure(term)) return groupedFigures(term).every((n) => bulletNumbers.has(n.replace(/^0+(?=\d)/, '')));
  return numbers.some((n) => bulletNumbers.has(n));
}

/** The days and months a text names, by what they name. */
function calendarKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const word of text.match(/\p{L}+\.?/gu) ?? []) {
    const key = calendarKey(word);
    if (key) keys.add(key);
  }
  return keys;
}

/** The numbers a bullet holds, for `keepsTerm`: its digit runs, and its grouped figures as one number each. */
function numbersIn(bullet: string): Set<string> {
  return new Set([...digitRuns(bullet), ...groupedFigures(bullet).map((n) => n.replace(/^0+(?=\d)/, ''))]);
}

/**
 * True when a bullet found in a note can be tied to this line: it still carries every term the
 * line's bullet had to keep (`keepTerms`), and the two share a word of four letters or more. A
 * line with no such word is tied by its terms alone ("go Q4"), or, with none, only to a bullet
 * that holds its text. Nothing else says which line a saved bullet was written for: its place
 * in the note does not, once lines were edited, replaced or moved.
 *
 * Known limit: an edit between two visits that changes only a lone digit or swaps one common
 * word for another ("2 postes" to "3 postes") is not seen, and the line keeps its old bullet
 * until it is edited again.
 */
export function tiedTo(line: string, bullet: string): boolean {
  const terms = keepTerms(line);
  const numbers = numbersIn(bullet);
  if (!terms.every((term) => keepsTerm(bullet, numbers, term))) return false;
  const words = longWords(line);
  if (words.length === 0) {
    if (terms.length > 0) return true;
    const text = fold(cleanBullet(line));
    return text !== '' && fold(collapseWhitespace(bullet)).includes(text);
  }
  const theirs = longWords(bullet);
  return words.some((word) => theirs.some((other) => sameWord(word, other)));
}

/* Two forms of one word: "relance" and "relancer", and a shorthand cut short, "budg" and
   "budget", "info" and "information". Both already folded. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  return b.startsWith(a.slice(0, 5)) || a.startsWith(b.slice(0, 5));
}

/** The words of four letters or more that carry meaning: not "pour", "with", "dans". */
function contentWords(text: string): string[] {
  return longWords(text).filter((word) => !isFunctionWord(word));
}

/**
 * True when a bullet the model has just written is still about its line. A transcript excerpt
 * on another subject can take a line over: "rappeler garderie pour jeudi" came back as a
 * sentence about the parking lot. Such a bullet shares no word with its line once its label is
 * set aside (the model often copies the line into the label), or has lost the line's figures,
 * days and months ("by Thu" became "by Friday" when the transcript said Friday).
 *
 * Lenient where a style legitimately leaves things out: a long line written concisely keeps
 * half of its figures.
 */
export function holdsLine(line: string, bullet: string): boolean {
  const flat = collapseWhitespace(bullet);
  const label = /^\*\*([^*]+)\*\*/.exec(flat)?.[1] ?? '';
  const body = flat.slice(label ? label.length + 4 : 0).trim();
  const ours = contentWords(line);
  // A label that is the line copied proves nothing: the facts must then be in the text.
  const inLabel = contentWords(label);
  const echoed =
    ours.length > 0 && ours.filter((word) => inLabel.some((other) => sameWord(word, other))).length * 5 >= ours.length * 3;
  // A line of one or two words ("carrière", "Projet Alpha") may well live in the label alone;
  // with more, the text must carry one of them: the label is often the line copied.
  const where = ours.length >= 3 ? body : flat;
  if (ours.length > 0) {
    const theirs = contentWords(where);
    if (!ours.some((word) => theirs.some((other) => sameWord(word, other)))) return false;
  }
  // A long line is summed up, not restated: its figures cannot all stay in a concise bullet.
  if (line.length > LONG_LINE_CHARS) return true;
  const facts = keepTerms(line).filter((term) => /\p{N}/u.test(term) || isCalendarWord(term));
  if (facts.length === 0) return true;
  const text = echoed ? body : flat;
  const numbers = numbersIn(text);
  const kept = facts.filter((term) => keepsTerm(text, numbers, term)).length;
  return facts.length <= 3 ? kept === facts.length : kept * 2 >= facts.length;
}

/** A bullet cut mid-stream may end inside its bold label: close it so the pane does not flash raw asterisks. */
function closeBold(text: string): string {
  const trimmed = text.replace(/(?<!\*)\*$/, '');
  const marks = trimmed.match(/\*\*/g)?.length ?? 0;
  return marks % 2 === 1 ? `${trimmed}**` : trimmed;
}

/* A model answering a single item often drops the "1.". Unnumbered lines are
   taken in order, but only when each opens with a bold label and there is one
   per item: an apology or a preamble must not become a bullet. */
function readAnswers(text: string, count: number): Map<number, string> {
  const parsed = parseEnhance(text);
  if (parsed.size > 0) return parsed;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^(```|~~~)/.test(line));
  if (lines.length !== count) return parsed;
  if (!lines.every((line) => /^(?:[-+•*]\s+)?\*\*[^*]+\*\*/.test(line))) return parsed;
  return new Map(lines.map((line, i) => [i + 1, line]));
}

function chunkNumber(id: string): number {
  const digits = /\d+/.exec(id);
  return digits ? Number(digits[0]) : Number.NaN;
}

function tokensOf(excerpts: Iterable<Excerpt>): number {
  let total = 0;
  for (const x of excerpts) total += estimateTokens(x.text) + 6;
  return total;
}

/* The excerpts one call carries: the best few per line, shared lines counted
   once. Over budget, every line gives up its weakest match before any line
   loses its only one. */
function selectExcerpts(
  batch: Entry[],
  found: Map<Entry, Excerpt[]>,
  budget: number,
): { excerpts: Excerpt[]; perItem: string[][] } {
  let union = new Map<string, Excerpt>();
  let perItem: string[][] = [];
  for (let cap = EXCERPTS_PER_LINE; cap >= 1; cap--) {
    const picked = new Map<string, Excerpt>();
    perItem = batch.map((e) => {
      const top = (found.get(e) ?? []).slice(0, cap);
      for (const x of top) if (!picked.has(x.id)) picked.set(x.id, x);
      return top.map((x) => x.id);
    });
    union = picked;
    if (tokensOf(union.values()) <= budget) break;
  }
  const weakestFirst = [...union.values()].sort((a, b) => a.score - b.score);
  let total = tokensOf(union.values());
  for (const x of weakestFirst) {
    if (total <= budget) break;
    union.delete(x.id);
    total -= estimateTokens(x.text) + 6;
  }
  // Chronological, so the excerpt block of consecutive calls shares a prefix.
  const excerpts = [...union.values()].sort((a, b) => {
    const d = chunkNumber(a.id) - chunkNumber(b.id);
    return Number.isNaN(d) ? 0 : d;
  });
  return { excerpts, perItem: perItem.map((ids) => ids.filter((id) => union.has(id))) };
}

/** What retrieval offers a line, without the excerpts that took it over before. */
function trusted(e: Entry, found: Excerpt[]): Excerpt[] {
  return e.distrusted.size === 0 ? found : found.filter((x) => !e.distrusted.has(x.id));
}

/** Follows two signals. `release` drops the listeners once the call is over. */
function linkSignals(a: AbortSignal, b: AbortSignal): { signal: AbortSignal; release(): void } {
  const ctl = new AbortController();
  const abort = (): void => ctl.abort();
  if (a.aborted || b.aborted) ctl.abort();
  else {
    a.addEventListener('abort', abort, { once: true });
    b.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: ctl.signal,
    release() {
      a.removeEventListener('abort', abort);
      b.removeEventListener('abort', abort);
    },
  };
}

/** What the client and the queue raise for a dropped call, as far as this engine reads it. */
function cancelled(): Error {
  return Object.assign(new Error('The request was cancelled.'), { kind: 'aborted' });
}

/**
 * Settles like `work`, or rejects as soon as `signal` fires: a call that is
 * still waiting its turn at the model must not hold up a run that was cancelled.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancelled());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Turns shorthand lines into bullets, one model call per batch of lines that
 * need it. State is per line id; a run re-evaluates after every call, so edits
 * made while it works are picked up without starting over.
 */
export class EnhanceEngine {
  private readonly deps: EnhanceEngineDeps;
  private entries: Entry[] = [];
  private title = '';
  private live = false;
  private status: EnhanceStatus = 'idle';
  private error: string | null = null;
  private timer: { handle: unknown } | null = null;
  private firstChangeAt: number | null = null;
  private run: Run | null = null;
  private interactive: Promise<void> | null = null;
  /** A run has finished since the last reset: "up to date" means something. */
  private completedOnce = false;
  private disposed = false;

  constructor(deps: EnhanceEngineDeps) {
    this.deps = deps;
  }

  setTitle(title: string): void {
    this.title = title;
  }

  /**
   * The current shorthand lines. Schedules a live run when live mode is on and the lines changed
   * because the user typed (`typed`): lines that changed some other way (a meeting was selected,
   * the note was read again, a sync brought them) wait for the next keystroke, the next stretch of
   * transcript or the Enhance button.
   */
  setItems(items: SectionItem[], typed = true): void {
    if (this.disposed) return;
    const old = this.entries;
    const unchanged =
      old.length === items.length &&
      items.every(
        (it, i) => old[i].id === it.id && old[i].kind === it.kind && old[i].source === it.text && old[i].task === it.task,
      );
    // Cursor moves report the same lines again: they must not push the debounce back.
    if (unchanged) return;

    const byId = new Map(old.map((e) => [e.id, e]));
    const kept = new Set(items.map((it) => it.id));
    this.entries = items.map((item, index) => {
      const same = byId.get(item.id);
      if (same && same.kind === item.kind) {
        same.source = item.text;
        // A task ticked or unticked is the same line: its bullet stands, only its mark changes.
        same.task = item.task;
        return same;
      }
      const entry: Entry = {
        id: item.id,
        kind: item.kind,
        source: item.text,
        task: item.task,
        bullet: null,
        partial: null,
        stale: false,
        streaming: false,
        excerptIds: [],
        seen: new Set(),
        style: null,
        skips: 0,
        recheck: false,
        owner: null,
        distrusted: new Set(),
      };
      // An edited line is a new id at the same index: its old bullet stays on
      // screen, dimmed, until the new one arrives.
      const before = old[index];
      if (
        before &&
        !kept.has(before.id) &&
        before.kind === 'item' &&
        item.kind === 'item' &&
        before.bullet !== null
      ) {
        entry.bullet = before.bullet;
        entry.stale = true;
        entry.style = before.style;
        entry.excerptIds = before.excerptIds;
      }
      return entry;
    });

    if (!this.run && this.status !== 'error') this.status = this.restingStatus();
    this.emit();
    if (typed && this.live && this.hasWork()) this.schedule();
  }

  setLive(on: boolean): void {
    if (this.disposed || this.live === on) return;
    this.live = on;
    if (on) {
      if (!this.run && this.hasWork()) this.schedule();
      return;
    }
    this.cancelTimer();
    if (this.run?.priority === 'live') {
      this.cancelRun();
      this.setStatus(this.restingStatus(), null);
    }
  }

  /** The Enhance button: interactive priority, no debounce. Resolves when the run ends. Never rejects. */
  runNow(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    // A run in progress re-evaluates until nothing is pending: a second click joins it.
    if (this.interactive) return this.interactive;
    this.cancelTimer();
    const done: Promise<void> = this.execute('interactive')
      .catch(() => undefined)
      .then(() => {
        if (this.interactive === done) this.interactive = null;
      });
    this.interactive = done;
    return done;
  }

  /** New transcript arrived: lines may gain excerpts. Re-checks on the next run; schedules one when live. */
  transcriptAdvanced(): void {
    if (this.disposed) return;
    for (const e of this.entries) {
      // A line without a bullet too: its first call may be on its way with what was found before.
      if (isLine(e)) e.recheck = true;
    }
    // A run in progress sees the flags at its next pass, and must search again for them.
    if (this.run) this.run.outdated = true;
    if (this.live && !this.run && this.timer === null && this.hasWork()) this.schedule();
  }

  items(): EnhancedItem[] {
    return this.entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      source: e.source,
      ...(e.task !== undefined ? { task: e.task } : {}),
      bullet: e.partial ?? e.bullet,
      stale: e.stale && e.partial === null,
      streaming: e.streaming,
      excerptIds: [...e.excerptIds],
    }));
  }

  /**
   * Content for the companion's `enhanced` region. Complete bullets only: never text that is still
   * streaming. A task line's bullet carries its mark: a checkbox when `tasksAsCheckboxes`, a sign
   * otherwise (src/util/tasks.ts).
   */
  markdown(tasksAsCheckboxes = false): string {
    const out: string[] = [];
    for (const e of this.entries) {
      if (e.kind === 'topic') {
        const text = collapseWhitespace(plainLinks(e.source)).replace(/^#+\s*/, '');
        if (!text) continue;
        if (out.length > 0) out.push('');
        out.push(`#### ${text}`);
        continue;
      }
      const bullet = e.bullet === null ? '' : cleanBullet(e.bullet);
      if (bullet) out.push(`- ${taskMark(e.task, tasksAsCheckboxes)}${bullet}`);
    }
    return out.join('\n');
  }

  /**
   * Bullets a note already holds for these lines, in order: what an earlier visit to the meeting
   * wrote. They are taken as the lines' own only when there is one per line, each can be tied to
   * the line it would go to (`tiedTo`), no line has a bullet yet and no run is under way. The
   * meeting is then not pending: a line typed later is the only one generated, and the others
   * keep what was written when the transcript was at hand. As many bullets as lines is not
   * enough: a line edited, replaced or moved since would be marked up to date with the note of
   * another, and Enhance would do nothing for it.
   */
  seed(bullets: string[]): boolean {
    if (this.disposed || this.run) return false;
    const lines = this.entries.filter(isLine);
    if (bullets.length === 0 || lines.length !== bullets.length || lines.some((e) => e.bullet !== null)) {
      return false;
    }
    if (!lines.every((e, i) => tiedTo(e.source, bullets[i]))) return false;
    const style = this.deps.settings().style;
    lines.forEach((e, i) => {
      e.bullet = bullets[i];
      e.stale = false;
      e.style = style;
      e.skips = 0;
    });
    // A run that was waiting for these lines alone has nothing left to do.
    if (!this.hasWork()) this.cancelTimer();
    // Every line has its note, as after a run: "up to date" means something.
    this.completedOnce = true;
    if (this.status !== 'error') this.status = this.restingStatus();
    this.emit();
    return true;
  }

  /** The ids of the lines `markdown()` writes a bullet for, in the same order. */
  bulletIds(): string[] {
    const ids: string[] = [];
    for (const e of this.entries) {
      if (e.kind !== 'topic' && e.bullet !== null && cleanBullet(e.bullet)) ids.push(e.id);
    }
    return ids;
  }

  /**
   * The bullet of one line as the note holds it now, after an edit by hand: it replaces the
   * engine's, so the next save carries the edit instead of undoing it. False when the line is
   * gone, or is being written right now (the call that is out would overwrite it).
   */
  setBullet(id: string, bullet: string): boolean {
    if (this.disposed) return false;
    const e = this.entries.find((entry) => entry.id === id);
    if (!e || !isLine(e) || e.owner !== null) return false;
    if (e.bullet !== bullet) {
      e.bullet = bullet;
      this.emit();
    }
    return true;
  }

  /** True when every item line has an up-to-date bullet. */
  settled(): boolean {
    return this.entries.every((e) => !isLine(e) || (e.bullet !== null && !e.stale && !e.streaming));
  }

  reset(): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.cancelRun();
    this.entries = [];
    this.completedOnce = false;
    this.setStatus('idle', null);
  }

  dispose(): void {
    this.cancelTimer();
    this.cancelRun();
    this.disposed = true;
  }

  private emit(): void {
    if (!this.disposed) this.deps.onState(this.items(), this.status, this.error);
  }

  private setStatus(status: EnhanceStatus, error: string | null): void {
    this.status = status;
    this.error = error;
    this.emit();
  }

  private pending(e: Entry, style: EnhanceStyle): boolean {
    return isLine(e) && (e.bullet === null || e.stale || e.style !== style);
  }

  private wantsRecheck(e: Entry): boolean {
    return isLine(e) && e.recheck && e.bullet !== null && this.deps.retrieve !== undefined;
  }

  private hasWork(): boolean {
    const style = this.deps.settings().style;
    return this.entries.some((e) => this.pending(e, style) || this.wantsRecheck(e));
  }

  /** The status between runs: nothing while lines wait, "up to date" once a run has left none waiting. */
  private restingStatus(): EnhanceStatus {
    const style = this.deps.settings().style;
    if (this.entries.some((e) => this.pending(e, style))) return 'idle';
    return this.completedOnce ? 'up-to-date' : 'idle';
  }

  private owns(run: Run): boolean {
    return this.run === run && !this.disposed;
  }

  private cancelTimer(): void {
    if (this.timer) this.deps.clock.clearTimeout(this.timer.handle);
    this.timer = null;
    this.firstChangeAt = null;
  }

  /** Trailing debounce, capped at `maxWaitMs` from the first change not yet handled. */
  private schedule(): void {
    const { clock } = this.deps;
    const s = this.deps.settings();
    const now = clock.now();
    if (this.firstChangeAt === null) this.firstChangeAt = now;
    if (this.timer) clock.clearTimeout(this.timer.handle);
    const left = this.firstChangeAt + s.maxWaitMs - now;
    const delay = Math.max(0, Math.min(s.debounceMs, left));
    this.timer = { handle: clock.setTimeout(() => this.fire(), delay) };
  }

  private fire(): void {
    this.timer = null;
    this.firstChangeAt = null;
    if (this.disposed || !this.live) return;
    const run = this.run;
    // A run whose lines are all still there finishes its call and then picks
    // up the changes. Only a call for a line that has since been edited is
    // wasted work, and only a live one may be dropped for it.
    if (run && (run.priority === 'interactive' || run.batch.every((e) => this.entries.includes(e)))) {
      return;
    }
    void this.execute('live').catch(() => undefined);
  }

  private release(run: Run): void {
    for (const e of run.batch) {
      if (e.owner !== run) continue;
      e.owner = null;
      e.streaming = false;
      e.partial = null;
      // Given back at once: the run that takes over must see it in its first pass.
      if (run.flagged.has(e)) e.recheck = true;
    }
    run.batch = [];
    run.flagged.clear();
  }

  private cancelRun(): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    this.interactive = null;
    run.abort.abort();
    this.release(run);
  }

  private async execute(priority: Priority): Promise<void> {
    const previous = this.run;
    if (previous) {
      previous.abort.abort();
      this.release(previous);
    }
    const run: Run = {
      priority,
      abort: new AbortController(),
      model: '',
      batch: [],
      flagged: new Set(),
      found: new Map(),
      outdated: false,
    };
    this.run = run;

    let failed = false;
    try {
      await this.passes(run);
    } catch (e) {
      if (this.owns(run)) {
        this.release(run);
        if (kindOf(e) === 'aborted') {
          this.setStatus(this.restingStatus(), null);
        } else {
          failed = true;
          this.setStatus('error', describeError(e, run.model));
        }
      }
    }
    if (this.run !== run) return;
    this.run = null;
    // After an abort (a question or a summary took the model) or a run that
    // hit the pass guard. Not after an error: that would retry a dead server forever.
    if (!failed && !this.disposed && this.live && this.timer === null && this.hasWork()) {
      this.schedule();
    }
  }

  private async passes(run: Run): Promise<void> {
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const s = this.deps.settings();
      run.model = run.priority === 'live' ? s.liveModel.trim() || s.model : s.model;
      const candidates = this.entries.filter((e) => this.pending(e, s.style) || this.wantsRecheck(e));
      // The check after a pass is silent when it finds nothing: no flash of "evaluating".
      if (pass === 0 || candidates.length > 0) this.setStatus('evaluating', null);
      if (candidates.length === 0) break;

      const retrieve = this.deps.retrieve;
      if (run.outdated) {
        run.outdated = false;
        run.found.clear();
      }
      const missing = retrieve ? candidates.filter((e) => !run.found.has(e)) : [];
      if (retrieve && missing.length > 0) {
        this.setStatus('retrieving', null);
        await Promise.all(
          missing.map(async (e) => {
            try {
              const offered = await retrieve(e.source, run.abort.signal);
              run.found.set(e, [...offered].sort((a, b) => b.score - a.score));
            } catch {
              // Not fatal: the line is enhanced from its own text.
            }
          }),
        );
        if (!this.owns(run)) return;
      }

      const todo: Entry[] = [];
      let edited = false;
      for (const e of candidates) {
        if (!this.entries.includes(e)) {
          edited = true;
          continue;
        }
        // Only the excerpts a call would carry count: one ranked below them changes nothing.
        const best = trusted(e, run.found.get(e) ?? []).slice(0, EXCERPTS_PER_LINE);
        if (this.pending(e, s.style) || best.some((x) => !e.seen.has(x.id))) todo.push(e);
        // Nothing new for this bullet, or retrieval failed: the next transcript advance asks again.
        // One that came during this very search is not answered yet: the flag stays.
        else if (!run.outdated) e.recheck = false;
      }
      if (todo.length === 0) {
        // Lines edited during retrieval are new entries, and transcript that
        // arrived during it has not been searched: the next pass takes both.
        if (edited || run.outdated) continue;
        break;
      }

      this.setStatus('structuring', null);
      for (let i = 0; i < todo.length; i += BATCH_SIZE) {
        const batch = todo.slice(i, i + BATCH_SIZE).filter((e) => this.entries.includes(e));
        if (batch.length === 0) continue;
        await this.runBatch(run, batch, s);
        if (!this.owns(run)) return;
      }
    }
    this.completedOnce = true;
    this.setStatus(this.restingStatus(), null);
  }

  private async runBatch(run: Run, batch: Entry[], s: EnhanceSettings): Promise<void> {
    const glossary = this.deps.glossary?.() ?? [];
    /* Room for each line by what it has to restate: a standard bullet says everything its item
       says and then adds to it, so a 600-character item needs far more than a ten-word one. A
       flat allowance cut the long ones in mid-sentence ("Dec 15" saved as "Dec 1"). */
    const numPredict = Math.min(
      PREDICT_CAP,
      batch.reduce((sum, e) => {
        const item = estimateTokens(e.source);
        const room = s.style === 'concise' ? 40 + item : 90 + Math.ceil(item * 1.5);
        // A line whose last answer was cut or missing goes again with twice the room.
        return sum + (e.skips > 0 ? room * 2 : room);
      }, 0),
    );
    const fixed =
      PROMPT_OVERHEAD +
      estimateTokens(batch.map((e) => `${e.source} ${e.bullet ?? ''}`).join(' ')) +
      Math.min(300, estimateTokens(glossary.join('; ')));
    const budget = Math.max(0, Math.min(EXCERPT_TOKENS, s.numCtx - numPredict - fixed));
    const usable = new Map(batch.map((e) => [e, trusted(e, run.found.get(e) ?? [])]));
    const { excerpts, perItem } = selectExcerpts(batch, usable, budget);

    const items: EnhancePromptItem[] = batch.map((e, i) => ({
      n: i + 1,
      text: e.source,
      // A bullet in the other style is rewritten, not kept: no `previous` for it.
      previous: e.bullet !== null && e.style === s.style ? e.bullet : undefined,
      excerptIds: perItem[i],
    }));
    const req: ChatRequest = {
      purpose: run.priority === 'live' ? 'live' : 'enhance',
      model: run.model,
      messages: enhanceMessages({
        title: this.title,
        style: s.style,
        micLabel: s.micLabel,
        glossary,
        items,
        excerpts,
      }),
      numCtx: s.numCtx,
      temperature: 0.2,
      seed: 7,
      numPredict,
      keepAlive: s.keepAlive ?? KEEP_ALIVE,
    };

    const offered = batch.map((e) => run.found.get(e) ?? []);
    const flagged = batch.map((e) => e.recheck);
    run.flagged = new Set(batch.filter((e) => e.recheck));
    for (const e of batch) {
      e.owner = run;
      e.streaming = true;
      e.partial = null;
      // The call answers the re-check; a transcript advance during it raises the
      // flag again. If transcript arrived after this run searched, the flag
      // stays: the excerpts are already old and the next pass searches again.
      if (!run.outdated) e.recheck = false;
    }
    run.batch = batch;
    this.emit();

    let lastShown = Number.NEGATIVE_INFINITY;
    const onToken = (_delta: string, full: string): void => {
      if (!this.owns(run)) return;
      const now = this.deps.clock.now();
      if (now - lastShown < STREAM_INTERVAL_MS) return;
      lastShown = now;
      let changed = false;
      for (const [n, body] of readAnswers(full, batch.length)) {
        const e = batch[n - 1];
        if (!e || e.owner !== run) continue;
        const text = closeBold(cleanBullet(body));
        if (text && text !== e.partial) {
          e.partial = text;
          changed = true;
        }
      }
      if (changed) this.emit();
    };

    let result: ChatResult;
    try {
      const call = this.deps.scheduler.run(run.model, run.priority, SCHEDULER_KEY, async (signal) => {
        // Cancelled while it waited its turn: the slot goes back without a request.
        if (run.abort.signal.aborted) throw cancelled();
        const link = linkSignals(signal, run.abort.signal);
        try {
          return await this.deps.llm.chatStream(req, onToken, link.signal);
        } finally {
          link.release();
        }
      });
      result = await untilAborted(call, run.abort.signal);
    } catch (e) {
      this.release(run);
      throw e;
    }
    if (!this.disposed) this.deps.onUsage(result.usage);
    if (!this.owns(run)) return;

    const parsed = readAnswers(result.text, batch.length);
    /* The token limit stopped the answer: its last line is cut somewhere, and nothing says where.
       That line counts as not answered, like the ones after it: it stays pending, goes again in
       a smaller call with more room, and shows as written if that is cut too. */
    if (result.doneReason === 'length' && parsed.size > 0) {
      // Only the item still open at the end: one that ended before a blank line is complete.
      const open = openItemAtEnd(result.text);
      if (open === undefined) parsed.delete(Math.max(...parsed.keys()));
      else if (open !== null) parsed.delete(open);
    }
    batch.forEach((e, i) => {
      if (e.owner !== run) return;
      e.owner = null;
      e.streaming = false;
      e.partial = null;
      let body = cleanBullet(parsed.get(i + 1) ?? '');
      if (body && !holdsLine(e.source, body)) {
        // About something else, or the line's facts are gone: its excerpts are to blame when it
        // had any. Not saved; the line goes again without them.
        for (const id of perItem[i]) e.distrusted.add(id);
        body = '';
      }
      if (body) {
        e.bullet = body;
        e.stale = false;
        e.style = s.style;
        e.excerptIds = perItem[i];
        e.skips = 0;
        for (const x of offered[i]) e.seen.add(x.id);
        return;
      }
      // Skipped: the line keeps what it had and stays pending for the next pass.
      e.skips += 1;
      if (e.skips < 2) {
        if (flagged[i]) e.recheck = true;
        return;
      }
      // Skipped twice: show the line as written rather than leave a hole. A
      // bullet of an unchanged line is still good and stays, even one written
      // in the other style: better than the line as written.
      if (e.bullet === null || e.stale) {
        e.bullet = cleanBullet(e.source) || e.source.trim();
        e.excerptIds = [];
      }
      e.stale = false;
      e.style = s.style;
      e.skips = 0;
      for (const x of offered[i]) e.seen.add(x.id);
    });
    run.batch = [];
    this.emit();
  }
}
