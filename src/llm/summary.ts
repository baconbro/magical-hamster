import type {
  ChatMessage,
  ChatPurpose,
  ChatRequest,
  ChatResult,
  ChatUsage,
  Lang,
  LanguagePref,
  LlmScheduler,
  OllamaClient,
  SummaryStyle,
  Turn,
} from '../types.ts';
import { langScores, shorthandLang } from '../util/lang.ts';
import { clock, collapseWhitespace, estimateTokens, truncate } from '../util/text.ts';
import {
  ACTIONS_SCHEMA,
  reduceMessages,
  renderActions,
  summaryMessages,
  windowNotesMessages,
} from './prompts.ts';

export interface GenSettings {
  model: string;
  numCtx: number;
  micLabel: string;
  /** How long Ollama keeps the model after a call. Five minutes (`GEN_OPTIONS`) when absent. */
  keepAlive?: number | string;
}

export interface SummaryDeps {
  llm: OllamaClient;
  scheduler: LlmScheduler;
  settings(): GenSettings;
  onUsage(usage: ChatUsage): void;
  glossary?: () => string[];
}

export interface SummaryInput {
  style: SummaryStyle;
  language: LanguagePref;
  title: string;
  date: string;
  shorthand: string[];
  turns: Turn[];
  asTasks: boolean;
  speakerLabels: { mic: string; system: string };
}

/** Sampling shared by summaries and answers. */
export const GEN_OPTIONS = {
  temperature: 0.4,
  topK: 40,
  topP: 0.9,
  repeatPenalty: 1.05,
  keepAlive: '5m',
} as const;

export interface GenDeps {
  llm: OllamaClient;
  scheduler: LlmScheduler;
  onUsage(usage: ChatUsage): void;
}

export type AbortedError = Error & { kind: 'aborted'; status: null; model: string | null };

/** The fields of the client's own abort error, without its class: callers test `kind === 'aborted'`. */
export function abortError(model: string | null = null): AbortedError {
  return Object.assign(new Error('The request was cancelled.'), {
    name: 'AbortError',
    kind: 'aborted' as const,
    status: null,
    model,
  });
}

function linkSignals(
  a: AbortSignal,
  b: AbortSignal | undefined,
): { signal: AbortSignal; release(): void } {
  if (!b) return { signal: a, release() {} };
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

/**
 * One interactive model call. Resolves with the full text. `onFull` receives
 * the text so far on every token. When `signal` fires the promise rejects at
 * once with an `aborted` error, even while the task is still waiting its turn.
 */
export async function generate(
  deps: GenDeps,
  req: ChatRequest,
  onFull?: (full: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  return (await generateResult(deps, req, onFull, signal)).text;
}

/** `generate`, with why the answer ended. */
export async function generateResult(
  deps: GenDeps,
  req: ChatRequest,
  onFull?: (full: string) => void,
  signal?: AbortSignal,
): Promise<ChatResult> {
  if (signal?.aborted) throw abortError(req.model);
  const call = deps.scheduler.run(req.model, 'interactive', null, async (taskSignal) => {
    if (signal?.aborted) throw abortError(req.model);
    const link = linkSignals(taskSignal, signal);
    try {
      return await deps.llm.chatStream(
        req,
        onFull
          ? (_delta, full) => {
              if (!link.signal.aborted) onFull(full);
            }
          : undefined,
        link.signal,
      );
    } finally {
      link.release();
    }
  });
  const result = await (signal
    ? new Promise<Awaited<typeof call>>((resolve, reject) => {
        const onAbort = (): void => reject(abortError(req.model));
        signal.addEventListener('abort', onAbort, { once: true });
        call.then(
          (value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      })
    : call);
  if (signal?.aborted) throw abortError(req.model);
  deps.onUsage(result.usage);
  return result;
}

/**
 * A summary the token limit stopped: its last line is cut somewhere in mid-sentence. Saved as it
 * stands it would end on half a sentence; it ends instead on the last complete line.
 */
export function endOnCompleteLine(text: string): string {
  const cut = text.lastIndexOf('\n');
  if (cut <= 0) return text;
  const kept = text.slice(0, cut).trimEnd();
  return /[\p{L}\p{N}]/u.test(kept) ? kept : text;
}

function tally(texts: string[]): { fr: number; en: number } {
  let fr = 0;
  let en = 0;
  for (const text of texts) {
    const s = langScores(text);
    fr += s.fr;
    en += s.en;
  }
  return { fr, en };
}

/* Below this many function words, what was said is too little to outweigh the notes: one
   English sound check must not turn the summary of five lines of French notes into English. */
const FEW_SPOKEN = 12;

/**
 * `auto` is the language the meeting was mostly spoken in. The shorthand counts too, and decides
 * when little was said: by its function words and by the language of each line, so that terse
 * notes with no function word at all ("budget formation 12 k$ approuvé", "Jane absente lundi")
 * are still read as French. English when nothing tells.
 */
export function pickLanguage(pref: LanguagePref, turns: Turn[], shorthand: string[]): Lang {
  if (pref !== 'auto') return pref;
  const spoken = tally(turns.map((t) => t.text));
  if (spoken.fr + spoken.en >= FEW_SPOKEN && spoken.fr !== spoken.en) return spoken.fr > spoken.en ? 'fr' : 'en';
  const written = tally(shorthand);
  let fr = spoken.fr + written.fr;
  let en = spoken.en + written.en;
  for (const line of shorthand) {
    const lang = shorthandLang(line);
    if (lang === 'fr') fr += 1;
    if (lang === 'en') en += 1;
  }
  if (fr !== en) return fr > en ? 'fr' : 'en';
  return spoken.fr > spoken.en ? 'fr' : 'en';
}

/** Splits turns into consecutive windows of `seconds`, aligned on the recording clock. Empty windows are left out. */
export function windows(turns: Turn[], seconds: number): Turn[][] {
  const span = seconds > 0 ? seconds : 600;
  const sorted = [...turns].sort((a, b) => a.t0 - b.t0);
  const out: Turn[][] = [];
  let current = -1;
  for (const turn of sorted) {
    const index = Math.floor(Math.max(0, turn.t0) / span);
    if (index !== current || out.length === 0) {
      out.push([]);
      current = index;
    }
    out[out.length - 1].push(turn);
  }
  return out;
}

interface Part {
  turns: Turn[];
  text: string;
}

function turnLine(turn: Turn, labels: { mic: string; system: string }): string {
  const label = turn.source === 'mic' ? labels.mic : labels.system;
  return `[${clock(turn.t0)}] ${label}: ${collapseWhitespace(turn.text)}`;
}

/** A window that would not fit the context (fast talkers, a small `numCtx`) is cut further, on turn boundaries. */
function fitParts(
  wins: Turn[][],
  labels: { mic: string; system: string },
  maxTokens: number,
): Part[] {
  const parts: Part[] = [];
  for (const win of wins) {
    let turns: Turn[] = [];
    let lines: string[] = [];
    let tokens = 0;
    for (const turn of win) {
      const line = turnLine(turn, labels);
      const cost = estimateTokens(line) + 1;
      if (turns.length > 0 && tokens + cost > maxTokens) {
        parts.push({ turns, text: lines.join('\n') });
        turns = [];
        lines = [];
        tokens = 0;
      }
      turns.push(turn);
      lines.push(line);
      tokens += cost;
    }
    if (turns.length > 0) parts.push({ turns, text: lines.join('\n') });
  }
  return parts;
}

function progressText(language: Lang, part: Part, seconds: number): string {
  const from = Math.floor(Math.max(0, part.turns[0].t0) / seconds) * Math.round(seconds / 60);
  const to = from + Math.round(seconds / 60);
  return language === 'fr' ? `Lecture des minutes ${from} à ${to}…` : `Reading minutes ${from}–${to}…`;
}

const PREAMBLE =
  /^(here(?:'s| is| are)|voici|sure|certainly|of course|okay|ok|absolutely|bien sûr|d'accord|below|ci-dessous|summary|résumé|recap|récapitulatif)(?![\p{L}\p{N}])/iu;

function structural(line: string): boolean {
  return /^(#{1,6}\s|[-*+•]\s|\d+[.)]\s)/.test(line.trim());
}

/** Tidies what the model wrote: no wrapping code fence, no "Here is..." line before the content, no heading above level 3. */
export function polishSummary(markdown: string): string {
  let text = markdown.replace(/\r\n/g, '\n').trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(text);
  // While streaming only the opening fence is there yet.
  text = fenced ? fenced[1].trim() : text.replace(/^```(?:markdown|md)?\n/i, '');

  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  const next = lines.findIndex((l, i) => i > first && l.trim() !== '');
  if (first >= 0 && next > first) {
    const head = lines[first].trim();
    const bare = head.replace(/^[*_]+/, '').replace(/[*_]+$/, '');
    const announces = /[:：]$/.test(bare) || PREAMBLE.test(bare);
    // A paragraph that opens the summary without a heading is content: only
    // a short line announcing what follows is dropped.
    if (!structural(head) && structural(lines[next]) && head.length <= 200 && announces) {
      lines.splice(0, next);
    }
  }

  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : line.replace(/^(\s{0,3})#{1,2}(?=\s)/, '$1###');
    })
    .join('\n')
    .trim();
}

/** Above this many transcript tokens the meeting is read in windows first. */
const SINGLE_PASS_TOKENS = 10_000;
const WINDOW_SECONDS = 600;
/* Room for the summary itself. A four-hour meeting summarized in the executive style needed more
   than 1,200 tokens and was cut in mid-sentence. */
const SUMMARY_TOKENS = 2000;
const WINDOW_NOTE_TOKENS = 300;
/** System text, task, tags and header, in tokens. */
const PROMPT_OVERHEAD = 900;
const MAX_SHORTHAND_CHARS = 12_000;

export async function summarize(
  deps: SummaryDeps,
  input: SummaryInput,
  onText: (markdown: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const turns = input.turns.filter((t) => t.text.trim() !== '').sort((a, b) => a.t0 - b.t0);
  const notes = input.shorthand.map((line) => line.trim()).filter(Boolean);
  if (turns.length === 0 && notes.length === 0) throw new Error('Nothing to summarize yet');
  if (signal?.aborted) throw abortError();

  const s = deps.settings();
  const language = pickLanguage(input.language, turns, notes);
  const glossary = deps.glossary?.() ?? [];
  // The prompt must describe the label the transcript lines really carry.
  const labels = {
    mic: input.speakerLabels.mic.trim() || s.micLabel.trim() || 'Mic',
    system: input.speakerLabels.system.trim() || 'Others',
  };
  const shorthand = truncate(notes.join('\n'), MAX_SHORTHAND_CHARS);
  const base = {
    style: input.style,
    language,
    title: input.title,
    date: input.date,
    shorthand,
    micLabel: labels.mic,
    glossary,
  };
  const request = (messages: ChatMessage[], numPredict: number, purpose: ChatPurpose): ChatRequest => ({
    purpose,
    model: s.model,
    messages,
    numCtx: s.numCtx,
    numPredict,
    ...GEN_OPTIONS,
    keepAlive: s.keepAlive ?? GEN_OPTIONS.keepAlive,
  });

  const transcript = turns.map((t) => turnLine(t, labels)).join('\n');
  // What the context can hold besides the prompt, the shorthand and the answer.
  const room = Math.max(
    1000,
    s.numCtx - SUMMARY_TOKENS - PROMPT_OVERHEAD - estimateTokens(shorthand),
  );

  // A long meeting is several calls. Between two of them the model is free for an instant: a live
  // request that took it then would be sent and dropped at once, at every window.
  const release = deps.scheduler.hold?.(s.model);
  try {
    let messages: ChatMessage[];
    if (estimateTokens(transcript) <= Math.min(SINGLE_PASS_TOKENS, room)) {
      messages = summaryMessages({ ...base, transcript });
    } else {
      const mapRoom = Math.max(1000, s.numCtx - WINDOW_NOTE_TOKENS - PROMPT_OVERHEAD);
      const parts = fitParts(windows(turns, WINDOW_SECONDS), labels, mapRoom);
      const collected: string[] = [];
      for (const part of parts) {
        onText(progressText(language, part, WINDOW_SECONDS));
        const range = `${clock(part.turns[0].t0)} to ${clock(part.turns[part.turns.length - 1].t1)}`;
        const text = await generate(
          deps,
          request(
            windowNotesMessages({
              language,
              title: input.title,
              window: range,
              transcript: part.text,
              micLabel: labels.mic,
              glossary,
            }),
            WINDOW_NOTE_TOKENS,
            'summary-window',
          ),
          undefined,
          signal,
        );
        if (text.trim()) collected.push(`[${range}]\n${text.trim()}`);
      }
      // A very long meeting: every window gives up the same share rather than the last ones being cut off.
      const perWindow = Math.floor((room * 3.3) / Math.max(1, collected.length));
      const windowNotes =
        estimateTokens(collected.join('\n\n')) <= room
          ? collected.join('\n\n')
          : collected.map((note) => truncate(note, perWindow)).join('\n\n');
      messages = reduceMessages({ ...base, windowNotes });
    }

    let final: string;
    if (input.style === 'actions') {
      // Half a JSON document is noise in the pane: only the rendered list is shown.
      const json = await generate(
        deps,
        { ...request(messages, SUMMARY_TOKENS, 'actions'), format: ACTIONS_SCHEMA },
        undefined,
        signal,
      );
      final = renderActions(json, input.asTasks, language);
    } else {
      const result = await generateResult(
        deps,
        request(messages, SUMMARY_TOKENS, 'summary'),
        (full) => onText(polishSummary(full)),
        signal,
      );
      final = polishSummary(result.doneReason === 'length' ? endOnCompleteLine(result.text) : result.text);
    }
    onText(final);
    return final;
  } finally {
    release?.();
  }
}
