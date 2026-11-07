import type {
  ChatRequest,
  ChatResult,
  ChatUsage,
  Clock,
  EmbedRequest,
  EmbedResult,
  OllamaClient,
  OllamaErrorKind,
} from '../types.ts';
import { estimateTokens } from '../util/text.ts';

export class OllamaError extends Error {
  kind: OllamaErrorKind;
  /** HTTP status when the server answered with one. */
  status: number | null;
  model: string | null;

  constructor(
    kind: OllamaErrorKind,
    message: string,
    info: { status?: number | null; model?: string | null; cause?: unknown } = {},
  ) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = 'OllamaError';
    this.kind = kind;
    this.status = info.status ?? null;
    this.model = info.model ?? null;
  }
}

export function isOllamaError(e: unknown, kind?: OllamaErrorKind): e is OllamaError {
  return e instanceof OllamaError && (kind === undefined || e.kind === kind);
}

export interface OllamaClientOptions {
  /** A function is read on every call, so a settings change applies at once. */
  baseUrl: string | (() => string);
  /** Default: the window's, which exists wherever the plugin runs (Obsidian, the dev page). */
  fetch?: typeof fetch;
  /** No default: in Obsidian the bare timers can be Node's, so the caller picks (the plugin passes the window's). */
  clock: Clock;
  /** Longest silence tolerated once the answer has started. Default 60000. */
  interChunkTimeoutMs?: number;
  /** Longest wait for the first chunk. Default max(120000, 30000 + promptTokens * 10). */
  firstTokenTimeoutMs?: (promptTokens: number) => number;
  /** Retries after HTTP 503, waiting 1 s, 2 s, 4 s... Default 3. */
  busyRetries?: number;
}

type Json = Record<string, unknown>;

const DEFAULT_INTER_CHUNK_MS = 60_000;
const DEFAULT_BUSY_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const ERROR_DETAIL_CHARS = 300;

/* Nothing is streamed while the prompt is processed, so the wait for the
   first chunk has to grow with the prompt. */
function defaultFirstTokenTimeoutMs(promptTokens: number): number {
  return Math.max(120_000, 30_000 + promptTokens * 10);
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function nsToMs(value: unknown): number {
  return count(value) / 1e6;
}

function withoutUndefined(source: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/* Ollama rejects keep_alive "-1": a bare number has to travel as a JSON
   number. Duration strings ("5m") pass through. */
function keepAliveValue(value: number | string | undefined): number | string | undefined {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
}

function chatBody(req: ChatRequest): Json {
  return withoutUndefined({
    model: req.model,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    // Gemma 4 has a thinking mode; left on, the answer waits behind hidden reasoning.
    think: false,
    keep_alive: keepAliveValue(req.keepAlive),
    format: req.format,
    options: withoutUndefined({
      // Always sent: without it the model loads with the app's 262144 default.
      num_ctx: req.numCtx,
      temperature: req.temperature,
      seed: req.seed,
      num_predict: req.numPredict,
      top_k: req.topK,
      top_p: req.topP,
      repeat_penalty: req.repeatPenalty,
    }),
  });
}

function embedBody(req: EmbedRequest): Json {
  return withoutUndefined({
    model: req.model,
    input: req.input,
    truncate: true,
    dimensions: req.dimensions,
    keep_alive: keepAliveValue(req.keepAlive),
    options: { num_ctx: req.numCtx },
  });
}

function saysNotFound(text: string): boolean {
  return /not found/i.test(text);
}

function missingModel(model: string | null, status: number | null): OllamaError {
  const message = model
    ? `Model ${model} is not installed in Ollama. Run: ollama pull ${model}`
    : 'The model is not installed in Ollama.';
  return new OllamaError('model_missing', message, { status, model });
}

function protocolError(what: string, model: string | null): OllamaError {
  return new OllamaError('protocol', `Unexpected response from Ollama: ${what}`, { model });
}

/** The server's own words from an error body, shortened. */
function errorDetail(body: string): string {
  let detail = body.trim();
  try {
    const parsed: unknown = JSON.parse(detail);
    if (isRecord(parsed) && typeof parsed.error === 'string') detail = parsed.error;
  } catch {
    // Not JSON: keep the raw text.
  }
  return detail.length > ERROR_DETAIL_CHARS ? `${detail.slice(0, ERROR_DETAIL_CHARS)}...` : detail;
}

function discard(res: Response): void {
  void res.body?.cancel().catch(() => {});
}

interface Guard {
  /** Handed to fetch; aborted when the caller cancels or the watchdog fires. */
  signal: AbortSignal;
  /** The abort or stall error once the call is over, else null. */
  failure(): OllamaError | null;
  /** Settles like `work`, or rejects as soon as the call is aborted or stalls. */
  race<T>(work: Promise<T>): Promise<T>;
  /** Restarts the watchdog. */
  arm(ms: number): void;
  disarm(): void;
  dispose(): void;
}

/* One per call. It turns "the caller aborted" and "the server went silent"
   into a single rejection that every await in the call races against, so the
   call ends promptly even if fetch or the body reader is slow to notice. */
function createGuard(clock: Clock, caller: AbortSignal | undefined, model: string | null): Guard {
  const controller = new AbortController();
  let failure: OllamaError | null = null;
  let timer: unknown = null;
  let armed = false;
  let rejectTripped: (error: OllamaError) => void = () => {};
  const tripped = new Promise<never>((_, reject) => {
    rejectTripped = reject;
  });
  // It can trip while nothing is racing against it; that is not an unhandled rejection.
  tripped.catch(() => {});

  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    clock.clearTimeout(timer);
  };

  const trip = (error: OllamaError): void => {
    if (failure) return;
    failure = error;
    disarm();
    rejectTripped(error);
    controller.abort();
  };

  const onAbort = (): void => trip(new OllamaError('aborted', 'The request was cancelled.', { model }));
  if (caller?.aborted) onAbort();
  else caller?.addEventListener('abort', onAbort, { once: true });

  return {
    signal: controller.signal,
    failure: () => failure,
    race: (work) => Promise.race([work, tripped]),
    arm(ms) {
      disarm();
      if (failure) return;
      armed = true;
      timer = clock.setTimeout(() => {
        armed = false;
        const seconds = Math.round(ms / 1000);
        trip(new OllamaError('stalled', `Ollama sent nothing for ${seconds} s.`, { model }));
      }, ms);
    },
    disarm,
    dispose() {
      disarm();
      caller?.removeEventListener('abort', onAbort);
    },
  };
}

export function createOllamaClient(opts: OllamaClientOptions): OllamaClient {
  const clock = opts.clock;
  const interChunkMs = opts.interChunkTimeoutMs ?? DEFAULT_INTER_CHUNK_MS;
  const firstTokenMs = opts.firstTokenTimeoutMs ?? defaultFirstTokenTimeoutMs;
  const busyRetries = Math.max(0, opts.busyRetries ?? DEFAULT_BUSY_RETRIES);
  // Kept as a bare function: window.fetch throws "Illegal invocation" when
  // called as a method of another object.
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => window.fetch(input, init));

  const baseUrl = (): string => {
    const raw = (typeof opts.baseUrl === 'function' ? opts.baseUrl() : opts.baseUrl).trim();
    /* Without a user name or password: fetch refuses an address that carries
       them, and the "not reachable" message quotes the address. The settings
       refuse such an address too; this covers one that arrived another way. */
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    } catch {
      return raw.replace(/\/+$/, '');
    }
  };

  async function guarded<T>(
    caller: AbortSignal | undefined,
    model: string | null,
    work: (guard: Guard) => Promise<T>,
  ): Promise<T> {
    const guard = createGuard(clock, caller, model);
    try {
      return await work(guard);
    } finally {
      guard.dispose();
    }
  }

  async function pause(guard: Guard, ms: number): Promise<void> {
    let handle: unknown;
    const sleep = new Promise<void>((resolve) => {
      handle = clock.setTimeout(resolve, ms);
    });
    try {
      await guard.race(sleep);
    } finally {
      clock.clearTimeout(handle);
    }
  }

  async function httpError(res: Response, guard: Guard, model: string | null): Promise<OllamaError> {
    let body = '';
    try {
      body = await guard.race(res.text());
    } catch {
      const stopped = guard.failure();
      if (stopped) return stopped;
    }
    const detail = errorDetail(body);
    // Without a model in the request, a 404 means the URL is not an Ollama server. With one,
    // Ollama answers JSON that names the model; a bare "404 page not found" is a wrong address
    // too (a base URL that ends in /v1, a proxy), and "ollama pull" would not help.
    if (res.status === 404 && model !== null && (body.trim() === '' || /^\s*\{/.test(body) || /model/i.test(detail))) {
      return missingModel(model, 404);
    }
    if (res.status === 503) {
      return new OllamaError('busy', 'Ollama is busy (HTTP 503). Try again in a moment.', {
        status: 503,
        model,
      });
    }
    return new OllamaError('http', `Ollama answered HTTP ${res.status}${detail ? `: ${detail}` : ''}`, {
      status: res.status,
      model,
    });
  }

  /**
   * Sends one request and returns the 2xx response with its body unread.
   * The watchdog is left running at `waitMs` for whoever reads the body.
   */
  async function send(
    guard: Guard,
    method: 'GET' | 'POST',
    path: string,
    body: Json | undefined,
    waitMs: number,
    model: string | null,
  ): Promise<Response> {
    const base = baseUrl();
    const init: RequestInit = { method, signal: guard.signal };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }

    for (let attempt = 0; ; attempt += 1) {
      const stopped = guard.failure();
      if (stopped) throw stopped;

      guard.arm(waitMs);
      let res: Response;
      try {
        res = await guard.race(doFetch(`${base}${path}`, init));
      } catch (cause) {
        throw (
          guard.failure() ??
          new OllamaError('unreachable', `Ollama is not reachable at ${base}.`, { model, cause })
        );
      }
      if (res.ok) return res;

      if (res.status === 503 && attempt < busyRetries) {
        discard(res);
        // The backoff is our own wait, not the server's silence.
        guard.disarm();
        await pause(guard, BACKOFF_BASE_MS * 2 ** attempt);
        continue;
      }
      throw await httpError(res, guard, model);
    }
  }

  async function readJson(res: Response, guard: Guard, model: string | null): Promise<Json> {
    guard.arm(interChunkMs);
    let text: string;
    try {
      text = await guard.race(res.text());
    } catch (cause) {
      throw (
        guard.failure() ??
        new OllamaError('unreachable', 'The connection to Ollama was lost.', { model, cause })
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw protocolError('the body is not JSON.', model);
    }
    if (!isRecord(parsed)) throw protocolError('the body is not an object.', model);
    return parsed;
  }

  async function readChat(
    res: Response,
    guard: Guard,
    model: string,
    onToken: ((delta: string, full: string) => void) | undefined,
  ): Promise<ChatResult> {
    if (!res.body) throw protocolError('the answer has no body.', model);
    const reader = res.body.getReader();
    // Streaming mode: a multi-byte character may be cut by a chunk boundary.
    const decoder = new TextDecoder();
    let pending = '';
    let full = '';
    let final: Json | null = null;
    let ended = false;

    /** Handles one NDJSON line; returns the closing object when it is the last one. */
    const take = (line: string): Json | null => {
      const text = line.trim();
      if (!text) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw protocolError('a stream line is not JSON.', model);
      }
      if (!isRecord(parsed)) throw protocolError('a stream line is not an object.', model);
      if (typeof parsed.error === 'string') {
        const detail = errorDetail(parsed.error);
        throw saysNotFound(detail)
          ? missingModel(model, null)
          : new OllamaError('http', `Ollama reported an error: ${detail}`, { model });
      }
      // `message.thinking` is ignored on purpose: only the answer is wanted.
      const delta =
        isRecord(parsed.message) && typeof parsed.message.content === 'string'
          ? parsed.message.content
          : '';
      if (delta) {
        full += delta;
        onToken?.(delta, full);
        // The callback may have cancelled the call; the rest of this chunk is
        // already in memory and would otherwise still be delivered.
        const stopped = guard.failure();
        if (stopped) throw stopped;
      }
      return parsed.done === true ? parsed : null;
    };

    try {
      while (!final) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await guard.race(reader.read());
        } catch (cause) {
          throw (
            guard.failure() ??
            new OllamaError('unreachable', 'The connection to Ollama was lost.', { model, cause })
          );
        }
        // A chunk that was already buffered wins the race against an abort.
        const stopped = guard.failure();
        if (stopped) throw stopped;
        if (chunk.done) {
          ended = true;
          break;
        }
        // The answer has started: from here on, only silence between chunks counts.
        guard.arm(interChunkMs);
        pending += decoder.decode(chunk.value, { stream: true });
        let newline = pending.indexOf('\n');
        while (!final && newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          final = take(line);
          newline = pending.indexOf('\n');
        }
      }
      // The last line may arrive without its newline.
      if (!final) final = take(pending + decoder.decode());
    } finally {
      if (!ended) void reader.cancel().catch(() => {});
    }

    if (!final) throw protocolError('the stream ended before the answer was complete.', model);

    const usage: ChatUsage = {
      model,
      promptTokens: count(final.prompt_eval_count),
      cachedTokens: count(final.prompt_eval_cached_count),
      outputTokens: count(final.eval_count),
      totalMs: nsToMs(final.total_duration),
      loadMs: nsToMs(final.load_duration),
      promptMs: nsToMs(final.prompt_eval_duration),
      evalMs: nsToMs(final.eval_duration),
    };
    const doneReason = typeof final.done_reason === 'string' ? final.done_reason : undefined;
    return doneReason === undefined ? { text: full, usage } : { text: full, usage, doneReason };
  }

  return {
    chatStream(req, onToken, signal) {
      return guarded(signal, req.model, async (guard) => {
        const promptTokens = req.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
        const res = await send(guard, 'POST', '/api/chat', chatBody(req), firstTokenMs(promptTokens), req.model);
        return readChat(res, guard, req.model, onToken);
      });
    },

    async embed(req, signal) {
      if (req.input.length === 0) return { vectors: [], promptTokens: 0 };
      return guarded<EmbedResult>(signal, req.model, async (guard) => {
        // Not streamed: the whole batch is computed before the first byte.
        const promptTokens = req.input.reduce((n, text) => n + estimateTokens(text), 0);
        const res = await send(guard, 'POST', '/api/embed', embedBody(req), firstTokenMs(promptTokens), req.model);
        const data = await readJson(res, guard, req.model);
        const rows = data.embeddings;
        if (!Array.isArray(rows) || rows.length !== req.input.length) {
          const got = Array.isArray(rows) ? rows.length : 0;
          throw protocolError(`${got} embeddings for ${req.input.length} inputs.`, req.model);
        }
        const vectors = rows.map((row: unknown) => {
          if (!Array.isArray(row) || row.length === 0 || row.some((x) => typeof x !== 'number')) {
            throw protocolError('an embedding is not a list of numbers.', req.model);
          }
          return Float32Array.from(row as number[]);
        });
        return { vectors, promptTokens: count(data.prompt_eval_count) };
      });
    },

    tags() {
      return guarded(undefined, null, async (guard) => {
        const res = await send(guard, 'GET', '/api/tags', undefined, interChunkMs, null);
        const data = await readJson(res, guard, null);
        if (!Array.isArray(data.models)) throw protocolError('the model list is missing.', null);
        const names: string[] = [];
        for (const entry of data.models as unknown[]) {
          if (!isRecord(entry)) continue;
          const name = typeof entry.name === 'string' ? entry.name : entry.model;
          if (typeof name === 'string' && name) names.push(name);
        }
        return names;
      });
    },

    ps() {
      return guarded(undefined, null, async (guard) => {
        const res = await send(guard, 'GET', '/api/ps', undefined, interChunkMs, null);
        const data = await readJson(res, guard, null);
        if (!Array.isArray(data.models)) throw protocolError('the list of loaded models is missing.', null);
        const loaded: Array<{ name: string; contextLength: number; sizeBytes: number }> = [];
        for (const entry of data.models as unknown[]) {
          if (!isRecord(entry)) continue;
          const name = typeof entry.name === 'string' ? entry.name : entry.model;
          if (typeof name !== 'string' || !name) continue;
          loaded.push({ name, contextLength: count(entry.context_length), sizeBytes: count(entry.size) });
        }
        return loaded;
      });
    },

    async unload(model) {
      try {
        await guarded(undefined, model, async (guard) => {
          const body = { model, keep_alive: 0, stream: false };
          const res = await send(guard, 'POST', '/api/generate', body, interChunkMs, model);
          discard(res);
        });
      } catch (error) {
        // A model that is not installed is certainly not loaded.
        if (!isOllamaError(error, 'model_missing')) throw error;
      }
    },
  };
}

/* Ollama stores an untagged name as `name:latest`. A colon before the last
   slash belongs to a registry host ("localhost:5000/x"), not to a tag. */
function canonicalName(name: string): string {
  // The registry's default namespace is implied: "library/gemma4:12b" and
  // "registry.ollama.ai/library/gemma4:12b" are the "gemma4:12b" that /api/tags lists.
  const text = name
    .trim()
    .toLowerCase()
    .replace(/^(?:(?:registry\.ollama\.ai|ollama\.com)\/)?library\//, '');
  return text.lastIndexOf(':') > text.lastIndexOf('/') ? text : `${text}:latest`;
}

/** True when `model` is in `tags`, treating `name` and `name:latest` as the same. */
export function modelInstalled(tags: string[], model: string): boolean {
  if (!model.trim()) return false;
  const wanted = canonicalName(model);
  return tags.some((tag) => canonicalName(tag) === wanted);
}
