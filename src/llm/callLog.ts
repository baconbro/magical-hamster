import type { ChatPurpose, ChatRequest, ChatResult, ChatUsage, Clock, EmbedRequest, OllamaClient } from '../types.ts';

/* The Debug tab: every exchange with the model, as it was sent and as it came back. Recorded at
   the one place every call passes through, a wrapper around the Ollama client, and only while
   the tab is on. Kept in memory only: the prompts hold the user's notes and transcript, so
   nothing here is written to the vault or anywhere else, and it is gone when Obsidian closes. */

export type CallStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface LoggedMessage {
  role: string;
  content: string;
  /** Characters left out at the end, when the message was longer than the log keeps. */
  cut: number;
}

export interface LogEntry {
  id: number;
  kind: 'chat' | 'embed' | 'tags';
  /** Milliseconds since the epoch, from the plugin's clock. */
  startedAt: number;
  model: string;
  status: CallStatus;
  purpose?: ChatPurpose;
  /** Chat: the messages and options as sent. */
  messages?: LoggedMessage[];
  options?: Record<string, unknown>;
  /** Chat: the answer so far, then in full. */
  answer?: string;
  answerCut?: number;
  doneReason?: string;
  usage?: ChatUsage;
  firstTokenMs?: number;
  totalMs?: number;
  error?: string;
  /** Embed: how many texts, the first few shortened, and the tokens Ollama counted. */
  inputCount?: number;
  inputs?: string[];
  promptTokens?: number;
}

export interface CallLog {
  enabled(): boolean;
  setEnabled(on: boolean): void;
  entries(): readonly LogEntry[];
  clear(): void;
  /** Called when the entries or the switch change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** What the client wrapper uses to write into the log. */
export interface CallLogWriter extends CallLog {
  start(entry: Omit<LogEntry, 'id' | 'startedAt' | 'status'>): number;
  update(id: number, patch: Partial<LogEntry>, opts?: { streaming?: boolean }): void;
  readonly clock: Pick<Clock, 'now'>;
}

export interface CallLogOptions {
  clock: Pick<Clock, 'now'>;
  enabled?: boolean;
  /** Entries kept, newest first. */
  max?: number;
  /** Characters kept per message and per answer. */
  maxChars?: number;
  /** While an answer streams, listeners hear of it at most this often. */
  streamIntervalMs?: number;
}

export const LOG_MAX_ENTRIES = 100;
export const LOG_MAX_CHARS = 20_000;
const EMBED_INPUTS_SHOWN = 3;
const EMBED_INPUT_CHARS = 300;

export function clip(text: string, max: number): { text: string; cut: number } {
  return text.length <= max ? { text, cut: 0 } : { text: text.slice(0, max), cut: text.length - max };
}

export function createCallLog(opts: CallLogOptions): CallLogWriter {
  const max = opts.max ?? LOG_MAX_ENTRIES;
  const streamInterval = opts.streamIntervalMs ?? 250;
  let on = opts.enabled ?? false;
  let list: LogEntry[] = [];
  let nextId = 1;
  let lastStreamNotice = Number.NEGATIVE_INFINITY;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  return {
    clock: opts.clock,
    enabled: () => on,
    setEnabled(next) {
      if (next === on) return;
      on = next;
      // Off means nothing is kept: what was recorded goes with it.
      if (!on) list = [];
      notify();
    },
    entries: () => list,
    clear() {
      list = [];
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(entry) {
      const id = nextId++;
      const fresh: LogEntry = { ...entry, id, startedAt: opts.clock.now(), status: 'running' };
      list = [fresh, ...list].slice(0, max);
      notify();
      return id;
    },
    update(id, patch, updateOpts) {
      const at = list.findIndex((e) => e.id === id);
      if (at === -1) return;
      list = list.map((e, i) => (i === at ? { ...e, ...patch } : e));
      if (updateOpts?.streaming) {
        const now = opts.clock.now();
        if (now - lastStreamNotice < streamInterval) return;
        lastStreamNotice = now;
      }
      notify();
    },
  };
}

function errorText(error: unknown): { status: CallStatus; error: string } {
  const kind = (error as { kind?: string } | null)?.kind;
  const message = error instanceof Error ? error.message : String(error);
  if (kind === 'aborted') return { status: 'cancelled', error: 'Cancelled' };
  return { status: 'error', error: kind ? `${kind}: ${message}` : message };
}

function chatOptions(req: ChatRequest): Record<string, unknown> {
  const options: Record<string, unknown> = { numCtx: req.numCtx };
  for (const key of ['temperature', 'seed', 'numPredict', 'topK', 'topP', 'repeatPenalty', 'keepAlive'] as const) {
    if (req[key] !== undefined) options[key] = req[key];
  }
  if (req.format !== undefined) options.format = 'JSON schema';
  return options;
}

/**
 * The Ollama client, recording each call in `log` while it is on. Calls pass through unchanged:
 * same arguments, same results, same errors.
 */
export function withCallLog(client: OllamaClient, log: CallLogWriter): OllamaClient {
  const maxChars = LOG_MAX_CHARS;
  return {
    async chatStream(req, onToken, signal): Promise<ChatResult> {
      if (!log.enabled()) return client.chatStream(req, onToken, signal);
      const started = log.clock.now();
      const id = log.start({
        kind: 'chat',
        model: req.model,
        purpose: req.purpose,
        messages: req.messages.map((m) => {
          const { text, cut } = clip(m.content, maxChars);
          return { role: m.role, content: text, cut };
        }),
        options: chatOptions(req),
      });
      let firstTokenMs: number | undefined;
      try {
        const result = await client.chatStream(
          req,
          (delta, full) => {
            if (firstTokenMs === undefined) firstTokenMs = log.clock.now() - started;
            const { text, cut } = clip(full, maxChars);
            log.update(id, { answer: text, answerCut: cut, firstTokenMs }, { streaming: true });
            onToken?.(delta, full);
          },
          signal,
        );
        const { text, cut } = clip(result.text, maxChars);
        log.update(id, {
          status: 'done',
          answer: text,
          answerCut: cut,
          doneReason: result.doneReason,
          usage: result.usage,
          firstTokenMs,
          totalMs: log.clock.now() - started,
        });
        return result;
      } catch (error) {
        log.update(id, { ...errorText(error), firstTokenMs, totalMs: log.clock.now() - started });
        throw error;
      }
    },

    async embed(req: EmbedRequest, signal?: AbortSignal) {
      if (!log.enabled()) return client.embed(req, signal);
      const started = log.clock.now();
      const id = log.start({
        kind: 'embed',
        model: req.model,
        inputCount: req.input.length,
        inputs: req.input.slice(0, EMBED_INPUTS_SHOWN).map((text) => clip(text, EMBED_INPUT_CHARS).text),
        options: { numCtx: req.numCtx, dimensions: req.dimensions },
      });
      try {
        const result = await client.embed(req, signal);
        log.update(id, { status: 'done', promptTokens: result.promptTokens, totalMs: log.clock.now() - started });
        return result;
      } catch (error) {
        log.update(id, { ...errorText(error), totalMs: log.clock.now() - started });
        throw error;
      }
    },

    async tags() {
      if (!log.enabled()) return client.tags();
      const started = log.clock.now();
      const id = log.start({ kind: 'tags', model: '' });
      try {
        const names = await client.tags();
        log.update(id, { status: 'done', answer: names.join(', '), totalMs: log.clock.now() - started });
        return names;
      } catch (error) {
        log.update(id, { ...errorText(error), totalMs: log.clock.now() - started });
        throw error;
      }
    },

    ps: () => client.ps(),
    unload: (model) => client.unload(model),
  };
}

/** One entry as JSON, for the Copy buttons. */
export function entryJson(entry: LogEntry): string {
  return JSON.stringify(entry, null, 2);
}
