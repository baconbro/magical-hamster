import type { Lang, SttEvent, SttSegment, SttSource } from '../types.ts';

/* The plugin's half of the speech worker protocol: frames out, event lines
   back. The contract is protocol/segments.md; stt/frames.cjs is the worker's
   copy of the frame constants and must stay in step with this file. */

export const SOURCE_MIC = 0;
export const SOURCE_SYSTEM = 1;
export const SOURCE_CONTROL = 255;

export const FRAME_VERSION = 1;
export const HEADER_BYTES = 8;
/** Largest payload the worker accepts in one frame. */
export const MAX_PAYLOAD = 1024 * 1024;

/** The worker's exit codes. */
export const EXIT = { ok: 0, error: 1, modelMissing: 2, addonLoadFailed: 3, protocol: 4 } as const;

const MAGIC_M = 0x4d;
const MAGIC_H = 0x48;

/** The source byte of an audio source. */
export function sourceByte(source: SttSource): number {
  return source === 'system' ? SOURCE_SYSTEM : SOURCE_MIC;
}

/** Wraps a payload in the 8-byte header. Throws a RangeError for a bad source or an oversized payload. */
export function encodeFrame(source: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(source) || source < 0 || source > 255) {
    throw new RangeError(`Frame source must be 0..255, got ${source}`);
  }
  if (payload.length > MAX_PAYLOAD) {
    throw new RangeError(`Frame payload is ${payload.length} bytes, the limit is ${MAX_PAYLOAD}`);
  }
  const frame = new Uint8Array(HEADER_BYTES + payload.length);
  frame[0] = MAGIC_M;
  frame[1] = MAGIC_H;
  frame[2] = FRAME_VERSION;
  frame[3] = source;
  new DataView(frame.buffer).setUint32(4, payload.length, true);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

/** An audio frame. Samples are written little-endian whatever the platform's byte order. */
export function encodePcm(source: number, samples: Int16Array): Uint8Array {
  const payload = new Uint8Array(samples.length * 2);
  const view = new DataView(payload.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], true);
  return encodeFrame(source, payload);
}

/** A control frame: `{type:'hello',source,sampleRate}`, `{type:'flush'}` or `{type:'bye'}`. */
export function encodeControl(message: Record<string, unknown>): Uint8Array {
  return encodeFrame(SOURCE_CONTROL, new TextEncoder().encode(JSON.stringify(message)));
}

/** WebAudio floats to 16-bit PCM. Values outside [-1, 1] are clamped; NaN becomes silence. */
export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s >= 1) out[i] = 32767;
    else if (s <= -1) out[i] = -32768;
    else if (!Number.isNaN(s)) out[i] = Math.round(s * (s < 0 ? 32768 : 32767));
  }
  return out;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isLang(value: unknown): value is Lang {
  return value === 'fr' || value === 'en';
}

/** Parses one stdout line. Returns null for blank lines and for anything that is not a well-formed event. */
export function parseEventLine(line: string): SttEvent | null {
  const text = line.trim();
  // Cheap rejection of the native library's own chatter before JSON.parse.
  if (text.length < 2 || text[0] !== '{') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  switch (o.type) {
    case 'ready':
      if (typeof o.model !== 'string' || !isNumber(o.chunkMs)) return null;
      return { type: 'ready', model: o.model, chunkMs: o.chunkMs };

    case 'segment': {
      if (o.source !== 'mic' && o.source !== 'system') return null;
      if (!isNumber(o.t0) || !isNumber(o.t1) || typeof o.text !== 'string' || typeof o.isFinal !== 'boolean') {
        return null;
      }
      const segment: SttSegment = {
        type: 'segment',
        source: o.source,
        t0: o.t0,
        t1: o.t1,
        text: o.text,
        isFinal: o.isFinal,
      };
      if (o.isFinal && typeof o.closes === 'string' && /^[.?!…,;:]{1,4}$/.test(o.closes)) segment.closes = o.closes;
      // An unknown language value is dropped, not fatal: `lang` is a hint.
      if (isLang(o.lang)) {
        segment.lang = o.lang;
        if (o.langSource === 'heuristic') segment.langSource = 'heuristic';
      }
      return segment;
    }

    case 'stats':
      if (!isNumber(o.rtf) || !isNumber(o.backlogMs)) return null;
      return { type: 'stats', rtf: o.rtf, backlogMs: o.backlogMs };

    case 'error': {
      if (typeof o.code !== 'string' || o.code === '') return null;
      return typeof o.message === 'string'
        ? { type: 'error', code: o.code, message: o.message }
        : { type: 'error', code: o.code };
    }

    default:
      return null;
  }
}

// A line longer than this is not an event; dropping it bounds memory when a
// child writes binary garbage with no newline.
const MAX_LINE_CHARS = 1024 * 1024;

/** Splits a stream of stdout chunks into lines; keeps the unfinished tail. `end()` emits a last line with no newline. */
export function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: Uint8Array | string): void;
  end(): void;
} {
  // Streaming decode: a multi-byte character may straddle two chunks.
  const decoder = new TextDecoder('utf-8');
  let tail = '';

  function feed(text: string): void {
    if (text === '') return;
    const data = tail + text;
    let start = 0;
    try {
      for (let nl = data.indexOf('\n', start); nl >= 0; nl = data.indexOf('\n', start)) {
        const end = nl > start && data.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
        const line = data.slice(start, end);
        start = nl + 1;
        onLine(line);
      }
    } finally {
      // Also when a listener throws: what it has not seen yet is kept for
      // the next chunk, so one bad line costs that line and nothing else.
      tail = data.slice(start);
      if (tail.length > MAX_LINE_CHARS) tail = '';
    }
  }

  return {
    push(chunk) {
      feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    },
    end() {
      feed(decoder.decode());
      if (tail !== '') {
        const last = tail;
        tail = '';
        onLine(last);
      }
    },
  };
}
