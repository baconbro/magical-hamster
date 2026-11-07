import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SOURCE_MIC,
  SOURCE_SYSTEM,
  createLineSplitter,
  encodeControl,
  encodeFrame,
  encodePcm,
} from '../src/stt/protocol.ts';
import { SttProcess } from '../src/stt/sttProcess.ts';
import type { Clock, SttEvent, SttState } from '../src/types.ts';
import { detectLang as detectLangTs } from '../src/util/lang.ts';

/* The worker is run for real, as a child process. Three recognizers stand in
   for the real one, none of which needs sherpa-onnx or a model:
     --fake            the worker's built-in energy detector
     a stub library    a JavaScript `sherpa-onnx-node` written into a temporary
                       runtime directory, so the real recognizer code path runs
     a broken library  the same, throwing on load */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STT_DIR = join(REPO, 'stt');
const WORKER = join(STT_DIR, 'worker.cjs');

type Json = Record<string, unknown>;

const require = createRequire(import.meta.url);
const { createResampler } = require('../stt/resample.cjs') as {
  createResampler(
    from: number,
    to: number,
  ): { process(input: Float32Array): Float32Array; flush(): Float32Array; reset(): void };
};
const langCjs = require('../stt/lang.cjs') as {
  detectLang(text: string): 'fr' | 'en' | undefined;
  langScores(text: string): { fr: number; en: number; total: number };
};
const workerModule = require('../stt/worker.cjs') as {
  parseWav(buf: Uint8Array): { sampleRate: number; channels: number; samples: Int16Array };
  readOnnxMetadata(file: string): Record<string, string> | null;
  normalizeLanguage(raw: unknown): string;
  modelLanguages(meta: Record<string, string> | null): Set<string> | null;
  locateModel(dir: string): { files: Record<string, string> | null; missing: string[] };
  parseArgs(argv: string[]): Json;
};

const tempDirs: string[] = [];
const spawned: ChildProcessWithoutNullStreams[] = [];

after(() => {
  for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hamster-stt-'));
  tempDirs.push(dir);
  return dir;
}

interface Worker {
  child: ChildProcessWithoutNullStreams;
  events: Json[];
  /** stdout lines that were not JSON objects: there must be none. */
  noise: string[];
  stderr(): string;
  send(bytes: Uint8Array): void;
  /** Resolves with the first event, past or future, that satisfies `match`. */
  waitFor(what: string, match: (event: Json, all: Json[]) => boolean, timeoutMs?: number): Promise<Json>;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

function startWorker(args: string[], script = WORKER, readStdout = true, env?: Record<string, string>): Worker {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : process.env,
  });
  spawned.push(child);
  const events: Json[] = [];
  const noise: string[] = [];
  const waiters: Array<{ match: (event: Json, all: Json[]) => boolean; resolve: (event: Json) => void }> = [];
  let stderr = '';

  const lines = createLineSplitter((line) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      event = null;
    }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      noise.push(line);
      return;
    }
    events.push(event as Json);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(event as Json, events)) waiters.splice(i, 1)[0].resolve(event as Json);
    }
  });
  if (readStdout) child.stdout.on('data', (chunk: Buffer) => lines.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  // A worker that exits on its own closes the pipe under a pending write.
  child.stdin.on('error', () => {});

  const exited = new Promise<{ code: number | null; signal: string | null }>((done) => {
    // `close`, not `exit`: by then stdout has been read to its end.
    child.on('close', (code, signal) => {
      lines.end();
      done({ code, signal });
    });
  });

  return {
    child,
    events,
    noise,
    stderr: () => stderr,
    send: (bytes) => {
      child.stdin.write(bytes);
    },
    waitFor(what, match, timeoutMs = 10_000) {
      const found = events.find((event) => match(event, events));
      if (found) return Promise.resolve(found);
      return new Promise<Json>((done, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${what}.\nevents: ${JSON.stringify(events)}\nstderr: ${stderr}`));
        }, timeoutMs);
        waiters.push({
          match,
          resolve: (event) => {
            clearTimeout(timer);
            done(event);
          },
        });
      });
    },
    exited,
  };
}

const isFinal = (event: Json) => event.type === 'segment' && event.isFinal === true;
const isPartial = (event: Json) => event.type === 'segment' && event.isFinal === false;
const finalsOf = (worker: Worker, source?: string) =>
  worker.events.filter((event) => isFinal(event) && (source === undefined || event.source === source));
const partialsOf = (worker: Worker) => worker.events.filter(isPartial);
const errorsOf = (worker: Worker) => worker.events.filter((event) => event.type === 'error');
const waitForFinals = (worker: Worker, count: number) =>
  worker.waitFor(`${count} final(s)`, (_event, all) => all.filter(isFinal).length >= count);

function near(actual: unknown, expected: number, tolerance: number, what: string): void {
  assert.equal(typeof actual, 'number', what);
  assert.ok(Math.abs((actual as number) - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);
}

function tone(rate: number, seconds: number, hz = 440, amplitude = 0.5): Int16Array {
  const out = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * hz * i) / rate));
  return out;
}

function silence(rate: number, seconds: number): Int16Array {
  return new Int16Array(Math.round(rate * seconds));
}

function joinPcm(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Sends audio the way the plugin does: 100 ms frames. */
function sendAudio(worker: Worker, source: number, rate: number, samples: Int16Array): void {
  const step = rate / 10;
  for (let offset = 0; offset < samples.length; offset += step) {
    worker.send(encodePcm(source, samples.subarray(offset, offset + step)));
  }
}

const hello = (source: 'mic' | 'system', sampleRate: number) => encodeControl({ type: 'hello', source, sampleRate });
const bye = () => encodeControl({ type: 'bye' });

function wavFile(rate: number, channels: number, mono: Int16Array): Buffer {
  const data = Buffer.alloc(mono.length * channels * 2);
  for (let i = 0; i < mono.length; i++) {
    for (let c = 0; c < channels; c++) data.writeInt16LE(mono[i], (i * channels + c) * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const MODEL_NAME = 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11';

/* A JavaScript sherpa-onnx-node with the API surface the worker uses
   (streaming-asr.js of sherpa-onnx-node 1.13.8). It "recognizes" one word per
   200 ms of signal, French when the stream's language option starts with fr.
   Like the real library: the token list of a stream keeps growing (the worker
   no longer resets at a pause), each token is stamped at its start in seconds
   since the stream began or was last reset, num_trailing_blanks counts the
   80 ms frames of quiet since the last word, and a stream refuses audio after
   inputFinished(). */
const STUB_SHERPA = String.raw`'use strict';
const fs = require('node:fs');
const WORDS = {
  fr: ['bonjour', 'nous', 'avons', 'le', 'budget', 'pour', 'la', 'semaine'],
  en: ['hello', 'we', 'have', 'the', 'budget', 'for', 'this', 'week'],
};
const note = (text) => process.stderr.write('[stub] ' + text + '\n');

class OnlineStream {
  constructor() {
    this.options = {};
    this.finished = false;
    this.pending = false;
    this.clear();
  }
  clear() {
    this.energy = 0;
    this.fill = 0;
    this.hops = 0;
    // One per stretch of signal; 0.3 s of quiet closes it.
    this.stretches = [];
    this.open = null;
  }
  acceptWaveform(obj) {
    if (this.finished) throw new Error('acceptWaveform called after inputFinished');
    if (!(obj.samples instanceof Float32Array)) throw new Error('samples must be a Float32Array');
    if (obj.sampleRate !== 16000) throw new Error('the worker must always feed 16000 Hz, got ' + obj.sampleRate);
    for (const s of obj.samples) {
      if (s > 1 || s < -1) throw new Error('sample out of [-1, 1]');
      this.energy += s * s;
      if (++this.fill < 160) continue;
      if (Math.sqrt(this.energy / 160) > 0.02) {
        if (!this.open) {
          this.open = { start: this.hops, end: this.hops + 1 };
          this.stretches.push(this.open);
        } else {
          this.open.end = this.hops + 1;
        }
      } else if (this.open && this.hops - this.open.end >= 30) {
        this.open = null;
      }
      this.hops += 1;
      this.energy = 0;
      this.fill = 0;
    }
    this.pending = true;
  }
  inputFinished() {
    this.finished = true;
  }
  setOption(key, value) {
    this.options[key] = value;
    note('setOption ' + key + '=' + value);
  }
  getOption(key) {
    return this.options[key] || '';
  }
  hasOption(key) {
    return key in this.options;
  }
}

class OnlineRecognizer {
  constructor(config) {
    this.config = config;
    note('config ' + JSON.stringify(config));
    const t = config.modelConfig.transducer;
    for (const file of [t.encoder, t.decoder, t.joiner, config.modelConfig.tokens]) fs.accessSync(file);
  }
  createStream() {
    note('createStream');
    return new OnlineStream();
  }
  isReady(stream) {
    return stream.pending;
  }
  decode(stream) {
    stream.pending = false;
  }
  isEndpoint() {
    throw new Error('the worker must not rely on the recognizer endpoints');
  }
  reset(stream) {
    note('reset');
    stream.clear();
  }
  getResult(stream) {
    const lang = String(stream.options.language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en';
    const tokens = [];
    const timestamps = [];
    for (const [index, stretch] of stream.stretches.entries()) {
      const count = Math.min(WORDS[lang].length, 1 + Math.floor((stretch.end - stretch.start) / 20));
      for (let i = 0; i < count; i++) {
        tokens.push(' ' + WORDS[lang][i]);
        timestamps.push((stretch.start + i * 20) / 100);
      }
    }
    const last = stream.stretches[stream.stretches.length - 1];
    return {
      text: tokens.join('') + ' ',
      tokens,
      timestamps,
      num_trailing_blanks: last ? Math.floor((stream.hops - last.end) / 8) : 0,
    };
  }
}

module.exports = { OnlineRecognizer, version: '0.0.0-stub' };
`;

const BROKEN_SHERPA = String.raw`'use strict';
throw new Error("dlopen(sherpa-onnx.node, 0x0001): Library not loaded: @rpath/libonnxruntime.1.23.2.dylib");
`;

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function varint(value: number): Uint8Array {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return Uint8Array.from(out);
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const delimited = (field: number, body: Uint8Array) => concatBytes(varint(field * 8 + 2), varint(body.length), body);

/** The outline of an ONNX ModelProto: enough for a reader that only wants metadata_props. */
function fakeOnnx(metadata: Record<string, string>): Uint8Array {
  return concatBytes(
    concatBytes(varint(1 * 8 + 0), varint(9)), // ir_version
    delimited(2, utf8('pytorch')), // producer_name
    delimited(7, new Uint8Array(70_000).fill(0x2a)), // graph: to be skipped, never parsed
    concatBytes(varint(90 * 8 + 1), new Uint8Array(8)), // an unknown fixed64
    concatBytes(varint(91 * 8 + 5), new Uint8Array(4)), // an unknown fixed32
    ...Object.entries(metadata).map(([key, value]) =>
      delimited(14, concatBytes(delimited(1, utf8(key)), delimited(2, utf8(value)))),
    ),
    delimited(8, concatBytes(varint(2 * 8 + 0), varint(17))), // opset_import
  );
}

const MODEL_METADATA = {
  prompt_dictionary: JSON.stringify({ auto: 101, 'en-US': 0, 'en-GB': 1, 'fr-FR': 4, 'fr-CA': 5, 'ja-JP': 15 }),
  auto_prompt_id: '101',
  chunk_shift: '56',
  vocab_size: '1024',
};

interface Runtime {
  dir: string;
  worker: string;
  modelDir: string;
}

/** Lays out a directory like the real runtime: worker scripts, node_modules, models. */
function makeRuntime(sherpaSource: string | null, modelName = MODEL_NAME): Runtime {
  const dir = tempDir();
  for (const name of readdirSync(STT_DIR)) {
    if (name.endsWith('.cjs')) copyFileSync(join(STT_DIR, name), join(dir, name));
  }
  if (sherpaSource !== null) {
    const pkg = join(dir, 'node_modules', 'sherpa-onnx-node');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'sherpa-onnx-node', version: '0.0.0', main: 'index.js' }));
    writeFileSync(join(pkg, 'index.js'), sherpaSource);
  }
  const modelDir = join(dir, 'models', modelName);
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, 'encoder.int8.onnx'), fakeOnnx(MODEL_METADATA));
  writeFileSync(join(modelDir, 'decoder.int8.onnx'), 'not a real decoder');
  writeFileSync(join(modelDir, 'joiner.int8.onnx'), 'not a real joiner');
  writeFileSync(join(modelDir, 'tokens.txt'), '<blk> 0\n');
  return { dir, worker: join(dir, 'worker.cjs'), modelDir };
}

for (const rate of [48000, 16000, 44100]) {
  test(`--fake at ${rate} Hz: ready, partials, two finals, stats, exit 0 on bye`, async () => {
    const worker = startWorker(['--fake', '--stats-ms', '40']);
    const ready = await worker.waitFor('ready', (event) => event.type === 'ready');
    assert.deepEqual(ready, { type: 'ready', model: 'fake', chunkMs: 100 });
    assert.equal(worker.events[0], ready, 'ready comes first');

    worker.send(hello('mic', rate));
    sendAudio(
      worker,
      SOURCE_MIC,
      rate,
      joinPcm(silence(rate, 0.5), tone(rate, 1.0), silence(rate, 1.0), tone(rate, 0.7), silence(rate, 1.0)),
    );
    await waitForFinals(worker, 2);
    const stats = await worker.waitFor('a stats line', (event) => event.type === 'stats');
    assert.equal(typeof stats.rtf, 'number');
    assert.ok((stats.rtf as number) >= 0);
    assert.ok(Number.isInteger(stats.backlogMs) && (stats.backlogMs as number) >= 0);

    worker.send(bye());
    assert.deepEqual(await worker.exited, { code: 0, signal: null });

    const finals = finalsOf(worker);
    assert.equal(finals.length, 2);
    assert.deepEqual(
      finals.map((event) => [event.source, event.text]),
      [
        ['mic', 'speech 1.0s'],
        ['mic', 'speech 0.7s'],
      ],
    );
    near(finals[0].t0, 0.5, 0.03, 'first t0');
    near(finals[0].t1, 1.5, 0.03, 'first t1');
    near(finals[1].t0, 2.5, 0.03, 'second t0');
    near(finals[1].t1, 3.2, 0.03, 'second t1');
    assert.ok(!('lang' in finals[0]), 'no language is claimed for text without function words');

    // Partials: growing text, each different from the one before, at most 4 per second.
    const firstFinalAt = worker.events.indexOf(finals[0]);
    const firstUtterance = worker.events.slice(0, firstFinalAt).filter(isPartial);
    assert.ok(firstUtterance.length >= 2, 'partials precede the final');
    assert.ok(firstUtterance.length <= 5);
    for (const partial of partialsOf(worker)) assert.match(partial.text as string, /^speech \d+\.\ds$/);
    for (let i = 1; i < firstUtterance.length; i++) {
      assert.notEqual(firstUtterance[i].text, firstUtterance[i - 1].text);
      assert.ok(parseFloat((firstUtterance[i].text as string).slice(7)) > parseFloat((firstUtterance[i - 1].text as string).slice(7)));
      // For this recognizer t1 is where the audio stood when the partial was sent.
      assert.ok((firstUtterance[i].t1 as number) - (firstUtterance[i - 1].t1 as number) >= 0.24, 'at least 250 ms of audio apart');
    }

    assert.deepEqual(worker.noise, [], 'stdout carries JSON lines only');
    assert.deepEqual(errorsOf(worker), []);
    assert.ok(worker.events.every((event) => ['ready', 'segment', 'stats'].includes(event.type as string)));
  });
}

test('--fake keeps one stream and one clock per source', async () => {
  const worker = startWorker(['--fake']);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  worker.send(hello('mic', 16000));
  worker.send(hello('system', 48000));
  const mic = joinPcm(silence(16000, 0.5), tone(16000, 1.0), silence(16000, 1.5));
  const system = joinPcm(silence(48000, 1.2), tone(48000, 0.8, 300), silence(48000, 1.0));
  // Interleaved frame by frame, as two live sources would arrive.
  for (let frame = 0; frame < 30; frame++) {
    worker.send(encodePcm(SOURCE_MIC, mic.subarray(frame * 1600, (frame + 1) * 1600)));
    worker.send(encodePcm(SOURCE_SYSTEM, system.subarray(frame * 4800, (frame + 1) * 4800)));
  }
  worker.send(bye());
  assert.equal((await worker.exited).code, 0);

  const micFinals = finalsOf(worker, 'mic');
  const systemFinals = finalsOf(worker, 'system');
  assert.deepEqual(micFinals.map((event) => event.text), ['speech 1.0s']);
  assert.deepEqual(systemFinals.map((event) => event.text), ['speech 0.8s']);
  near(micFinals[0].t0, 0.5, 0.03, 'mic t0');
  near(micFinals[0].t1, 1.5, 0.03, 'mic t1');
  near(systemFinals[0].t0, 1.2, 0.03, 'system t0');
  near(systemFinals[0].t1, 2.0, 0.03, 'system t1');
  assert.deepEqual(errorsOf(worker), []);
});

for (const rate of [16000, 48000]) {
  test(`flush finalizes an open utterance at once and the worker carries on (${rate} Hz)`, async () => {
    const worker = startWorker(['--fake']);
    await worker.waitFor('ready', (event) => event.type === 'ready');
    worker.send(hello('mic', rate));
    sendAudio(worker, SOURCE_MIC, rate, joinPcm(silence(rate, 0.3), tone(rate, 0.6)));
    worker.send(encodeControl({ type: 'flush' }));
    const first = await waitForFinals(worker, 1);
    assert.equal(first.text, 'speech 0.6s');
    near(first.t0, 0.3, 0.03, 't0');
    near(first.t1, 0.9, 0.03, 't1');

    // A second flush with nothing open says nothing. Nor does the quiet that
    // follows: no scrap of the tone is left over to start an utterance.
    worker.send(encodeControl({ type: 'flush' }));
    sendAudio(worker, SOURCE_MIC, rate, joinPcm(silence(rate, 1.0), tone(rate, 0.5), silence(rate, 0.1)));
    worker.send(bye());
    assert.equal((await worker.exited).code, 0);
    const finals = finalsOf(worker);
    assert.deepEqual(finals.map((event) => event.text), ['speech 0.6s', 'speech 0.5s']);
    near(finals[1].t0, 1.9, 0.03, 'the clock runs on across the flush');
    near(finals[1].t1, 2.4, 0.03, 't1');
  });
}

test('the end of stdin finalizes and exits 0, without a bye', async () => {
  const worker = startWorker(['--fake']);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  worker.send(hello('mic', 48000));
  sendAudio(worker, SOURCE_MIC, 48000, joinPcm(silence(48000, 0.2), tone(48000, 0.9)));
  worker.child.stdin.end();
  assert.deepEqual(await worker.exited, { code: 0, signal: null });
  assert.deepEqual(finalsOf(worker).map((event) => event.text), ['speech 0.9s']);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${signal} finalizes the open utterance and exits 0`, async () => {
    const worker = startWorker(['--fake']);
    await worker.waitFor('ready', (event) => event.type === 'ready');
    worker.send(hello('mic', 16000));
    sendAudio(worker, SOURCE_MIC, 16000, joinPcm(silence(16000, 0.2), tone(16000, 1.0)));
    await worker.waitFor('the last partial', (event) => isPartial(event) && event.text === 'speech 1.0s');
    assert.equal(finalsOf(worker).length, 0);
    worker.child.kill(signal);
    assert.deepEqual(await worker.exited, { code: 0, signal: null });
    const finals = finalsOf(worker);
    assert.deepEqual(finals.map((event) => event.text), ['speech 1.0s']);
    near(finals[0].t0, 0.2, 0.03, 't0');
    near(finals[0].t1, 1.2, 0.03, 't1');
  });
}

test('a hello sent again switches the sample rate mid-stream', async () => {
  const worker = startWorker(['--fake']);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  worker.send(hello('mic', 48000));
  sendAudio(worker, SOURCE_MIC, 48000, joinPcm(silence(48000, 0.5), tone(48000, 1.0), silence(48000, 1.0)));
  worker.send(hello('mic', 16000));
  sendAudio(worker, SOURCE_MIC, 16000, joinPcm(silence(16000, 0.5), tone(16000, 0.7), silence(16000, 1.0)));
  worker.send(bye());
  assert.equal((await worker.exited).code, 0);
  const finals = finalsOf(worker);
  assert.deepEqual(finals.map((event) => event.text), ['speech 1.0s', 'speech 0.7s']);
  near(finals[1].t0, 3.0, 0.05, 'second t0');
  near(finals[1].t1, 3.7, 0.05, 'second t1');
  assert.deepEqual(errorsOf(worker), []);
});

test('--fake --self-test transcribes WAV files and reports', async () => {
  const dir = tempDir();
  const speech = join(dir, 'speech.wav');
  const quiet = join(dir, 'quiet.wav');
  writeFileSync(speech, wavFile(44100, 2, joinPcm(silence(44100, 0.4), tone(44100, 1.2), silence(44100, 1.0), tone(44100, 0.8))));
  writeFileSync(quiet, wavFile(16000, 1, silence(16000, 2)));

  const good = startWorker(['--fake', '--self-test', speech, quiet]);
  assert.deepEqual(await good.exited, { code: 0, signal: null });
  assert.deepEqual(
    good.events.map((event) => event.type),
    ['segment', 'segment', 'selftest'],
    'finals and the summary, no ready, no partials, no stats',
  );
  assert.deepEqual(finalsOf(good).map((event) => event.text), ['speech 1.2s', 'speech 0.8s']);
  const summary = good.events[2];
  assert.equal(summary.ok, true);
  assert.equal(summary.finals, 2);
  near(summary.seconds, 3.4 + 2, 0.01, 'seconds of audio');
  assert.equal(typeof summary.rtf, 'number');
  assert.deepEqual(good.noise, []);

  const silent = startWorker(['--fake', '--self-test', quiet]);
  assert.equal((await silent.exited).code, 1, 'nothing recognized is a failure');
  assert.deepEqual(silent.events, [{ type: 'selftest', ok: false, finals: 0, seconds: 2, rtf: silent.events[0].rtf }]);

  const missing = startWorker(['--fake', '--self-test', join(dir, 'absent.wav')]);
  assert.equal((await missing.exited).code, 1);
  assert.equal(missing.events[0].type, 'error');
  assert.equal(missing.events[0].code, 'internal');
  assert.equal(missing.events.at(-1)?.ok, false);
});

test('a garbage header is a protocol error: one error line, exit 4', async () => {
  const worker = startWorker(['--fake']);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  worker.send(new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n'));
  assert.deepEqual(await worker.exited, { code: 4, signal: null });
  const errors = errorsOf(worker);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'protocol');
  assert.match(errors[0].message as string, /magic/i);
  assert.deepEqual(worker.noise, []);
});

test('an oversized or wrongly versioned frame is a protocol error too, after the finals', async () => {
  const oversized = startWorker(['--fake']);
  await oversized.waitFor('ready', (event) => event.type === 'ready');
  oversized.send(hello('mic', 16000));
  sendAudio(oversized, SOURCE_MIC, 16000, joinPcm(silence(16000, 0.2), tone(16000, 0.5)));
  await oversized.waitFor('a partial', isPartial);
  const header = new Uint8Array(8);
  header.set([0x4d, 0x48, 1, 0]);
  new DataView(header.buffer).setUint32(4, 1024 * 1024 + 1, true);
  oversized.send(header);
  assert.equal((await oversized.exited).code, 4);
  const tail = oversized.events.filter((event) => isFinal(event) || event.type === 'error');
  assert.deepEqual(
    tail.map((event) => event.type),
    ['segment', 'error'],
    'what was heard before the bad frame is not lost',
  );
  assert.equal(tail[1].code, 'protocol');

  const versioned = startWorker(['--fake']);
  await versioned.waitFor('ready', (event) => event.type === 'ready');
  const frame = encodeControl({ type: 'flush' });
  frame[2] = 9;
  versioned.send(frame);
  assert.equal((await versioned.exited).code, 4);
  assert.equal(errorsOf(versioned)[0].code, 'protocol');
});

test('recoverable protocol mistakes are reported once and do not stop the worker', async () => {
  const worker = startWorker(['--fake']);
  await worker.waitFor('ready', (event) => event.type === 'ready');

  // Audio before its hello, twice: one report.
  worker.send(encodePcm(SOURCE_MIC, tone(16000, 0.1)));
  worker.send(encodePcm(SOURCE_MIC, tone(16000, 0.1)));
  // Control frames that make no sense.
  worker.send(encodeFrame(255, new TextEncoder().encode('{not json')));
  worker.send(encodeControl({ type: 'hello', source: 'loopback', sampleRate: 48000 }));
  worker.send(encodeControl({ type: 'hello', source: 'mic', sampleRate: 12 }));
  // Tolerated silently: a control message from a newer sender, a source byte nobody uses yet.
  worker.send(encodeControl({ type: 'marker', label: 'agenda item 2' }));
  worker.send(encodeFrame(7, new Uint8Array(320)));

  worker.send(hello('mic', 16000));
  sendAudio(worker, SOURCE_MIC, 16000, joinPcm(silence(16000, 0.2), tone(16000, 0.5), silence(16000, 1.0)));
  worker.send(bye());
  assert.equal((await worker.exited).code, 0);

  const errors = errorsOf(worker);
  assert.equal(errors.length, 4);
  assert.ok(errors.every((event) => event.code === 'protocol'));
  assert.match(errors[0].message as string, /before its hello/);
  assert.deepEqual(finalsOf(worker).map((event) => event.text), ['speech 0.5s']);
  near(finalsOf(worker)[0].t0, 0.2, 0.03, 'audio sent before the hello does not count');
});

test('bad arguments are an internal error, exit 1', async () => {
  const unknown = startWorker(['--fake', '--frobnicate']);
  assert.equal((await unknown.exited).code, 1);
  assert.equal(errorsOf(unknown)[0].code, 'internal');

  const noModel = startWorker([]);
  assert.equal((await noModel.exited).code, 1);
  assert.match(errorsOf(noModel)[0].message as string, /--model/);
});

test('--model /nonexistent exits 2 with model_missing', async () => {
  // The model directory is checked before the library is loaded, so this is
  // exit 2 whether or not sherpa-onnx-node can be found.
  const worker = startWorker(['--model', '/nonexistent/hamster-model']);
  assert.deepEqual(await worker.exited, { code: 2, signal: null });
  assert.equal(worker.events.length, 1);
  assert.equal(worker.events[0].type, 'error');
  assert.equal(worker.events[0].code, 'model_missing');
  assert.match(worker.events[0].message as string, /\/nonexistent\/hamster-model/);
  assert.deepEqual(worker.noise, []);
});

test('an incomplete model directory exits 2 and names the missing files', async () => {
  const runtime = makeRuntime(STUB_SHERPA);
  rmSync(join(runtime.modelDir, 'joiner.int8.onnx'));
  rmSync(join(runtime.modelDir, 'tokens.txt'));
  const worker = startWorker(['--model', runtime.modelDir], runtime.worker);
  assert.equal((await worker.exited).code, 2);
  assert.equal(worker.events[0].code, 'model_missing');
  assert.match(worker.events[0].message as string, /joiner\.int8\.onnx, tokens\.txt/);
});

test('a present model without the library exits 3 with addon_load_failed', async () => {
  const absent = makeRuntime(null);
  const worker = startWorker(['--model', absent.modelDir], absent.worker);
  assert.deepEqual(await worker.exited, { code: 3, signal: null });
  assert.equal(worker.events.length, 1);
  assert.equal(worker.events[0].code, 'addon_load_failed');
  assert.match(worker.events[0].message as string, /sherpa-onnx-node/);
});

test('a library that fails to load exits 3 and passes on the underlying message', async () => {
  const broken = makeRuntime(BROKEN_SHERPA);
  const worker = startWorker(['--model', broken.modelDir], broken.worker);
  assert.equal((await worker.exited).code, 3);
  assert.equal(worker.events[0].code, 'addon_load_failed');
  assert.match(worker.events[0].message as string, /Library not loaded: @rpath\/libonnxruntime/);
  assert.match(worker.stderr(), /Library not loaded/);
});

test('the sherpa path: config, pinned language, finals with times and language', async () => {
  const runtime = makeRuntime(STUB_SHERPA);
  const worker = startWorker(['--model', runtime.modelDir, '--lang', 'fr-CA', '--threads', '3'], runtime.worker);
  const ready = await worker.waitFor('ready', (event) => event.type === 'ready');
  assert.deepEqual(ready, { type: 'ready', model: MODEL_NAME, chunkMs: 560 });

  worker.send(hello('mic', 48000));
  sendAudio(worker, SOURCE_MIC, 48000, joinPcm(silence(48000, 0.5), tone(48000, 1.0), silence(48000, 1.2)));
  const first = await waitForFinals(worker, 1);
  assert.deepEqual(first, {
    type: 'segment',
    source: 'mic',
    t0: first.t0,
    t1: first.t1,
    text: 'bonjour nous avons le budget pour',
    isFinal: true,
    lang: 'fr',
    langSource: 'heuristic',
  });
  // From the recognizer's token times: first token at 0.5 s, last at 1.5 s plus one frame.
  near(first.t0, 0.5, 0.03, 't0');
  near(first.t1, 1.58, 0.03, 't1');
  assert.ok(partialsOf(worker).length >= 2);
  assert.ok(partialsOf(worker).every((event) => (event.t1 as number) >= (event.t0 as number)));

  // A flush ends the stream for good (inputFinished); the next audio needs a new one.
  sendAudio(worker, SOURCE_MIC, 48000, tone(48000, 0.5));
  worker.send(encodeControl({ type: 'flush' }));
  const second = await waitForFinals(worker, 2);
  assert.equal(second.text, 'bonjour nous avons');
  near(second.t0, 2.7, 0.03, 'second t0');

  sendAudio(worker, SOURCE_MIC, 48000, joinPcm(silence(48000, 0.3), tone(48000, 0.7), silence(48000, 1.2)));
  const third = await waitForFinals(worker, 3);
  assert.equal(third.text, 'bonjour nous avons le');
  // Starting at 3.5 s and not at the flush shows that the flush took all of
  // the tone, including the millisecond the resampler was still holding.
  near(third.t0, 3.5, 0.03, 'third t0');
  worker.send(bye());
  assert.deepEqual(await worker.exited, { code: 0, signal: null });
  assert.deepEqual(errorsOf(worker), []);
  assert.deepEqual(worker.noise, []);

  const stderr = worker.stderr();
  const config = JSON.parse(/\[stub\] config (.*)/.exec(stderr)![1]) as Record<string, any>;
  assert.deepEqual(config.featConfig, { sampleRate: 16000, featureDim: 128 });
  assert.deepEqual(config.modelConfig, {
    transducer: {
      encoder: join(runtime.modelDir, 'encoder.int8.onnx'),
      decoder: join(runtime.modelDir, 'decoder.int8.onnx'),
      joiner: join(runtime.modelDir, 'joiner.int8.onnx'),
    },
    tokens: join(runtime.modelDir, 'tokens.txt'),
    numThreads: 3,
    provider: 'cpu',
    debug: 0,
  });
  assert.equal(config.decodingMethod, 'greedy_search');
  // The worker cuts its finals itself, and resets only once a final has ended at a pause.
  assert.equal(config.enableEndpoint, false);
  assert.equal(stderr.split('[stub] reset').length - 1, 2, 'after the first and the third final, not at the flush');
  assert.equal(stderr.split('[stub] createStream').length - 1, 2, 'one stream, replaced once after the flush');
  assert.equal(stderr.split('[stub] setOption language=fr-CA').length - 1, 2, 'the language is pinned on each stream');
});

test('the sherpa path: a mark at the head of a piece is taken off its text and sent as closes', async () => {
  // The model writes a sentence's closing mark once the next one has begun: at the head of a piece it belongs to the final before.
  const stub = STUB_SHERPA.replace(
    "      for (let i = 0; i < count; i++) {",
    "      tokens.push('?');\n      timestamps.push(stretch.start / 100);\n      for (let i = 0; i < count; i++) {",
  );
  assert.notEqual(stub, STUB_SHERPA);
  const runtime = makeRuntime(stub);
  const worker = startWorker(['--model', runtime.modelDir], runtime.worker);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  worker.send(hello('mic', 16000));
  sendAudio(worker, SOURCE_MIC, 16000, joinPcm(tone(16000, 0.6), silence(16000, 1.2), tone(16000, 0.6), silence(16000, 1.2)));
  worker.send(bye());
  assert.equal((await worker.exited).code, 0);
  assert.deepEqual(
    finalsOf(worker).map((event) => [event.text, event.closes]),
    [
      ['hello we have the', '?'],
      ['hello we have the', '?'],
    ],
  );
  assert.deepEqual(errorsOf(worker), []);
});

test('the sherpa path: a fresh recognizer after each final at a pause, with times that go on', async () => {
  const runtime = makeRuntime(STUB_SHERPA);
  const worker = startWorker(['--model', runtime.modelDir], runtime.worker);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  worker.send(hello('mic', 16000));
  // Speech at 0-1 s, a pause of 3 s, then speech at 4-4.6 s.
  sendAudio(worker, SOURCE_MIC, 16000, joinPcm(tone(16000, 1.0), silence(16000, 3.0), tone(16000, 0.6), silence(16000, 1.2)));
  worker.send(bye());
  assert.equal((await worker.exited).code, 0);
  const finals = finalsOf(worker);
  assert.equal(finals.length, 2);
  assert.equal(worker.stderr().split('[stub] reset').length - 1, 2, 'one after each final');
  near(finals[0].t0 as number, 0, 0.05, 'first t0');
  // On the source's own clock after the renewal, not counted from the reset.
  near(finals[1].t0 as number, 4.0, 0.05, 'second t0');
  assert.equal(finals[1].text, 'hello we have the');
  assert.deepEqual(errorsOf(worker), []);
});

test('the sherpa path: a piece that runs on is cut at its last full sentence', async () => {
  // One token every 200 ms for as long as the signal lasts, a sentence every eight words.
  const stub = STUB_SHERPA.replace(
    'const count = Math.min(WORDS[lang].length, 1 + Math.floor((stretch.end - stretch.start) / 20));',
    'const count = 1 + Math.floor((stretch.end - stretch.start) / 20);',
  ).replace("tokens.push(' ' + WORDS[lang][i]);", "tokens.push(' ' + WORDS[lang][i % 8] + (i % 8 === 7 ? '.' : ''));");
  assert.notEqual(stub, STUB_SHERPA);
  const runtime = makeRuntime(stub);
  const worker = startWorker(['--model', runtime.modelDir], runtime.worker);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  worker.send(hello('mic', 16000));
  sendAudio(worker, SOURCE_MIC, 16000, joinPcm(tone(16000, 23.0), silence(16000, 1.2)));
  worker.send(bye());
  assert.equal((await worker.exited).code, 0);
  const finals = finalsOf(worker);
  assert.ok(finals.length >= 2, 'cut before the pause');
  assert.match(finals[0].text as string, /week\.$/, 'at the end of a sentence');
  assert.ok((finals[0].t1 as number) - (finals[0].t0 as number) <= 20.5);
  const words = finals.flatMap((event) => (event.text as string).split(' '));
  assert.equal(words.length, 1 + Math.floor(2300 / 20), 'no word lost or repeated at the cut');
  for (let i = 1; i < finals.length; i++) assert.ok((finals[i].t0 as number) >= (finals[i - 1].t1 as number));
});

test('the sherpa path: a stop right after a cut at the length limit loses nothing', async () => {
  const stub = STUB_SHERPA.replace(
    'const count = Math.min(WORDS[lang].length, 1 + Math.floor((stretch.end - stretch.start) / 20));',
    'const count = 1 + Math.floor((stretch.end - stretch.start) / 20);',
  ).replace("tokens.push(' ' + WORDS[lang][i]);", "tokens.push(' ' + WORDS[lang][i % 8] + (i % 8 === 7 ? '.' : ''));");
  const runtime = makeRuntime(stub);
  const worker = startWorker(['--model', runtime.modelDir], runtime.worker);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  worker.send(hello('mic', 16000));
  sendAudio(worker, SOURCE_MIC, 16000, tone(16000, 20.0));
  worker.send(bye());
  assert.equal((await worker.exited).code, 0);
  const words = finalsOf(worker).flatMap((event) => (event.text as string).split(' '));
  assert.equal(words.length, 1 + Math.floor(2000 / 20));
});

test('the sherpa path: a mark that opens a long piece is not where it is cut', async () => {
  const stub = STUB_SHERPA.replace(
    'const count = Math.min(WORDS[lang].length, 1 + Math.floor((stretch.end - stretch.start) / 20));',
    'const count = 1 + Math.floor((stretch.end - stretch.start) / 20);',
  ).replace("      for (let i = 0; i < count; i++) {", "      tokens.push('.');\n      timestamps.push(stretch.start / 100);\n      for (let i = 0; i < count; i++) {");
  const runtime = makeRuntime(stub);
  const worker = startWorker(['--model', runtime.modelDir], runtime.worker);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  worker.send(hello('mic', 16000));
  sendAudio(worker, SOURCE_MIC, 16000, joinPcm(tone(16000, 30.0), silence(16000, 1.2)));
  worker.send(bye());
  assert.equal((await worker.exited).code, 0);
  const finals = finalsOf(worker);
  assert.ok(finals.length >= 2, 'cut at its length limit');
  assert.ok((finals[0].t1 as number) - (finals[0].t0 as number) <= 21);
});

test('the sherpa path: automatic language sets no option', async () => {
  const runtime = makeRuntime(STUB_SHERPA);
  const worker = startWorker(['--model', runtime.modelDir], runtime.worker);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  worker.send(hello('system', 16000));
  sendAudio(worker, SOURCE_SYSTEM, 16000, joinPcm(silence(16000, 0.2), tone(16000, 1.0)));
  worker.child.stdin.end();
  assert.equal((await worker.exited).code, 0);
  const finals = finalsOf(worker);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].source, 'system');
  assert.equal(finals[0].text, 'hello we have the budget for');
  assert.equal(finals[0].lang, 'en');
  assert.doesNotMatch(worker.stderr(), /setOption/);
  const config = JSON.parse(/\[stub\] config (.*)/.exec(worker.stderr())![1]) as Record<string, any>;
  assert.equal(config.modelConfig.numThreads, 2);
});

test('the sherpa path: a language the model lacks is reported once and falls back to auto', async () => {
  const runtime = makeRuntime(STUB_SHERPA);
  const worker = startWorker(['--model', runtime.modelDir, '--lang', 'zz-ZZ'], runtime.worker);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  worker.send(hello('mic', 16000));
  worker.send(hello('system', 16000));
  sendAudio(worker, SOURCE_MIC, 16000, joinPcm(tone(16000, 0.6), silence(16000, 1.0)));
  sendAudio(worker, SOURCE_SYSTEM, 16000, joinPcm(tone(16000, 0.6), silence(16000, 1.0)));
  worker.send(bye());
  assert.equal((await worker.exited).code, 0);
  const errors = errorsOf(worker);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'lang_unsupported');
  assert.match(errors[0].message as string, /zz-ZZ/);
  assert.equal(finalsOf(worker).length, 2);
  assert.doesNotMatch(worker.stderr(), /setOption/);
});

test('the sherpa path: locale spellings the model knows are passed through', async () => {
  const runtime = makeRuntime(STUB_SHERPA);
  for (const lang of ['fr_ca', 'fr', 'EN-us']) {
    const worker = startWorker(['--model', runtime.modelDir, '--lang', lang], runtime.worker);
    await worker.waitFor('ready', (event) => event.type === 'ready');
    worker.send(hello('mic', 16000));
    worker.send(bye());
    assert.equal((await worker.exited).code, 0);
    assert.deepEqual(errorsOf(worker), [], lang);
    assert.ok(worker.stderr().includes(`[stub] setOption language=${lang}`), lang);
  }
});

test('the sherpa path: the chunk size falls back to the model metadata, and to fp32 graphs', async () => {
  const runtime = makeRuntime(STUB_SHERPA, 'renamed-model');
  // An fp32 package: encoder.onnx and so on.
  for (const part of ['encoder', 'decoder', 'joiner']) {
    writeFileSync(join(runtime.modelDir, `${part}.onnx`), readFileSync(join(runtime.modelDir, `${part}.int8.onnx`)));
    rmSync(join(runtime.modelDir, `${part}.int8.onnx`));
  }
  const worker = startWorker(['--model', runtime.modelDir], runtime.worker);
  const ready = await worker.waitFor('ready', (event) => event.type === 'ready');
  assert.deepEqual(ready, { type: 'ready', model: 'renamed-model', chunkMs: 560 });
  worker.send(bye());
  assert.equal((await worker.exited).code, 0);
  assert.match(worker.stderr(), /encoder\.onnx/);
});

test('the sherpa path: --self-test', async () => {
  const runtime = makeRuntime(STUB_SHERPA);
  const wav = join(runtime.dir, 'clip.wav');
  writeFileSync(wav, wavFile(44100, 2, joinPcm(silence(44100, 0.3), tone(44100, 1.0), silence(44100, 1.2), tone(44100, 0.6))));
  const worker = startWorker(['--model', runtime.modelDir, '--lang', 'fr-FR', '--self-test', wav], runtime.worker);
  assert.deepEqual(await worker.exited, { code: 0, signal: null });
  assert.deepEqual(
    worker.events.map((event) => event.type),
    ['segment', 'segment', 'selftest'],
  );
  assert.deepEqual(finalsOf(worker).map((event) => event.text), ['bonjour nous avons le budget pour', 'bonjour nous avons le']);
  assert.equal(worker.events[2].ok, true);
  assert.equal(worker.events[2].finals, 2);
  near(worker.events[2].seconds, 3.1, 0.01, 'seconds');
});

test('an exception inside the recognizer is an internal error, exit 1', async () => {
  const throwing = STUB_SHERPA.replace("this.pending = true;", "throw new Error('decoder exploded');");
  assert.notEqual(throwing, STUB_SHERPA);
  const runtime = makeRuntime(throwing);
  const worker = startWorker(['--model', runtime.modelDir], runtime.worker);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  worker.send(hello('mic', 16000));
  sendAudio(worker, SOURCE_MIC, 16000, tone(16000, 0.2));
  assert.deepEqual(await worker.exited, { code: 1, signal: null });
  const errors = errorsOf(worker);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'internal');
  assert.match(errors[0].message as string, /decoder exploded/);
  assert.deepEqual(worker.noise, []);
});

test('a reader that stalls costs partials, never finals, and never blocks the worker', async () => {
  const bursts = 1200;
  const rate = 8000;
  const worker = startWorker(['--fake'], WORKER, false);
  worker.send(hello('mic', rate));
  const burst = joinPcm(tone(rate, 1.0), silence(rate, 0.7));
  for (let i = 0; i < bursts; i++) sendAudio(worker, SOURCE_MIC, rate, burst);

  /* Nobody reads stdout while the worker goes through 34 minutes of audio. Its lines fill this
     side's buffer, then the pipe, then the worker's own buffer, about 200 KB in all: only then
     does the worker find its output blocked. Waited for, not timed, since a slower computer gets
     there later; then a moment more for the worker to decode while blocked. The 1,200 bursts
     write some 600 KB, far past the buffers. */
  const out = worker.child.stdout;
  const deadline = Date.now() + 30_000;
  while (out.readableLength < out.readableHighWaterMark && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.ok(out.readableLength >= out.readableHighWaterMark, 'the unread output filled the reading side');
  await new Promise((done) => setTimeout(done, 500));
  // Collected by hand: startWorker did not attach its reader for this worker.
  const collected: Json[] = [];
  const lines = createLineSplitter((line) => {
    if (line.trim()) collected.push(JSON.parse(line) as Json);
  });
  worker.child.stdout.on('data', (chunk: Buffer) => lines.push(chunk));
  worker.send(bye());
  assert.deepEqual(await worker.exited, { code: 0, signal: null });

  const finals = collected.filter(isFinal);
  const partials = collected.filter(isPartial);
  assert.equal(finals.length, bursts, 'every final arrives');
  assert.ok(finals.every((event) => event.text === 'speech 1.0s'));
  near(finals[bursts - 1].t0, (bursts - 1) * 1.7, 0.05, 'the last final is the last burst');
  // With a reader that keeps up there are 4 partials per burst.
  assert.ok(partials.length < bursts * 4, `partials were dropped (${partials.length} of ${bursts * 4})`);
  assert.ok(partials.length > 0);
});

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

async function until(what: string, condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** The supervisor with a real child process, as the plugin's adapter will wire it. */
function supervise(args: string[], overrides: { backoffMs?: number[]; heartbeatTimeoutMs?: number } = {}) {
  const events: SttEvent[] = [];
  const states: Array<[SttState, string | undefined]> = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const proc = new SttProcess({
    spawn() {
      const child = spawn(process.execPath, [WORKER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      spawned.push(child);
      children.push(child);
      return child;
    },
    clock: realClock,
    onEvent: (event) => events.push(event),
    onState: (state, message) => states.push([state, message]),
    ...overrides,
  });
  const finals = () => events.filter((event) => event.type === 'segment' && event.isFinal);
  const send = (samples: Int16Array, rate: number) => {
    for (let offset = 0; offset < samples.length; offset += rate / 10) {
      proc.sendPcm('mic', samples.subarray(offset, offset + rate / 10));
    }
  };
  return { proc, events, states, children, finals, send };
}

test('SttProcess drives a real worker from start to stop', async () => {
  const t = supervise(['--fake', '--stats-ms', '30']);
  t.proc.hello('mic', 48000);
  await t.proc.start();
  assert.equal(t.proc.state(), 'ready');
  assert.deepEqual(t.events[0], { type: 'ready', model: 'fake', chunkMs: 100 });

  t.send(joinPcm(silence(48000, 0.5), tone(48000, 1.0), silence(48000, 1.0), tone(48000, 0.4)), 48000);
  assert.equal(t.proc.state(), 'running');
  await until('the first final', () => t.finals().length >= 1);
  await until('a heartbeat', () => t.events.some((event) => event.type === 'stats'));

  await t.proc.stop();
  assert.equal(t.proc.state(), 'exited');
  // The utterance that was open at the stop is finalized by the bye.
  await until('the last final', () => t.finals().length >= 2);
  const finals = t.finals() as Array<Extract<SttEvent, { type: 'segment' }>>;
  assert.deepEqual(finals.map((event) => event.text), ['speech 1.0s', 'speech 0.4s']);
  near(finals[0].t0, 0.5, 0.03, 't0');
  near(finals[1].t0, 2.5, 0.03, 'second t0');
  assert.deepEqual(t.states.map(([state]) => state), ['spawning', 'ready', 'running', 'stopping', 'exited']);
  assert.equal(t.children.length, 1);
  assert.equal(t.children[0].exitCode, 0, 'the worker left on its own, without the kill');
});

test('SttProcess replaces a worker that dies, and the times carry on', async () => {
  const t = supervise(['--fake'], { backoffMs: [30] });
  t.proc.hello('mic', 16000);
  await t.proc.start();
  t.send(joinPcm(silence(16000, 0.5), tone(16000, 0.5), silence(16000, 1.0)), 16000);
  await until('the first final', () => t.finals().length >= 1);

  t.children[0].kill('SIGKILL');
  await until('the crash to be seen', () => t.proc.state() === 'crashed');
  assert.match(t.states.at(-1)?.[1] ?? '', /stopped unexpectedly \(signal SIGKILL\)/);
  // One second of audio that no worker hears.
  t.send(silence(16000, 1.0), 16000);
  await until('the replacement', () => t.proc.state() === 'ready');
  assert.equal(t.children.length, 2);

  t.send(joinPcm(silence(16000, 0.5), tone(16000, 0.7), silence(16000, 1.0)), 16000);
  await until('the second final', () => t.finals().length >= 2);
  const finals = t.finals() as Array<Extract<SttEvent, { type: 'segment' }>>;
  assert.equal(finals[1].text, 'speech 0.7s');
  // 2 s before the crash, 1 s lost, then 0.5 s of silence: the new worker's 0.5 s is 3.5 s into the recording.
  near(finals[1].t0, 3.5, 0.03, 't0 on the recording clock');
  near(finals[1].t1, 4.2, 0.03, 't1 on the recording clock');
  await t.proc.stop();
  assert.equal(t.proc.state(), 'exited');
});

test('SttProcess reports a worker without its model as not installed', async () => {
  const t = supervise(['--model', '/nonexistent/hamster-model']);
  await assert.rejects(t.proc.start(), /The speech model is not installed\. Run the speech setup again: the command is in Settings, Magical Hamster, Speech\./);
  assert.equal(t.proc.state(), 'not-installed');
  // Whichever of the exit code and the error line came first, the detail ends up in the message.
  await until('the detail', () => /\/nonexistent\/hamster-model/.test(t.states.at(-1)?.[1] ?? ''));
  assert.equal(t.children.length, 1);
  assert.deepEqual(t.events, []);
  await t.proc.stop();
  assert.equal(t.proc.state(), 'not-installed');
});

test('a parent that stops listening altogether: the worker leaves quietly', async () => {
  const worker = startWorker(['--fake', '--stats-ms', '20']);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  // What the worker sees when Obsidian dies: nobody at the other end of stdout and stderr.
  worker.child.stdout.destroy();
  worker.child.stderr.destroy();
  worker.send(hello('mic', 16000));
  sendAudio(worker, SOURCE_MIC, 16000, joinPcm(tone(16000, 0.5), silence(16000, 1.0)));
  const { code, signal } = await worker.exited;
  assert.equal(signal, null);
  assert.equal(code, 0);
});

function sine(rate: number, hz: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (to - from));
}

function risingZeroCrossings(samples: Float32Array): number {
  let count = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) count++;
  return count;
}

const decibels = (ratio: number) => 20 * Math.log10(ratio);

for (const from of [48000, 44100]) {
  test(`resample ${from} -> 16000: a 1 kHz tone keeps its length, pitch and level`, () => {
    const out = createResampler(from, 16000).process(sine(from, 1000, 1));
    assert.ok(Math.abs(out.length - 16000) <= 160, `length ${out.length} is within 1% of 16000`);
    const seconds = out.length / 16000;
    const hz = risingZeroCrossings(out) / seconds;
    assert.ok(Math.abs(hz - 1000) <= 5, `frequency ${hz}`);
    // Away from the edges the tone passes at unity gain.
    const level = decibels(rms(out, 400, out.length - 400) / Math.SQRT1_2);
    assert.ok(Math.abs(level) < 0.1, `passband level ${level} dB`);
  });

  test(`resample ${from} -> 16000: a 10 kHz tone is attenuated by at least 30 dB`, () => {
    const input = sine(from, 10000, 1);
    const out = createResampler(from, 16000).process(input);
    const attenuation = decibels(rms(out, 400, out.length - 400) / rms(input));
    assert.ok(attenuation <= -30, `10 kHz came out at ${attenuation.toFixed(1)} dB`);
    assert.ok(attenuation <= -60, 'well inside the stop band it is far lower still');
  });
}

test('resampling in chunks gives the same samples as resampling at once', () => {
  for (const from of [48000, 44100, 8000]) {
    const input = sine(from, 700, 0.5);
    const whole = createResampler(from, 16000).process(input);
    const streaming = createResampler(from, 16000);
    const pieces: number[] = [];
    const sizes = [1, 7, 480, 441, 1023, 3, 4800, 160];
    for (let offset = 0, i = 0; offset < input.length; i++) {
      const size = sizes[i % sizes.length];
      pieces.push(...streaming.process(input.subarray(offset, offset + size)));
      offset += size;
    }
    assert.equal(pieces.length, whole.length, `${from}: same length`);
    for (let i = 0; i < whole.length; i++) {
      if (pieces[i] !== whole[i]) assert.fail(`${from}: sample ${i} differs (${pieces[i]} vs ${whole[i]})`);
    }
  }
});

test('the resampler does not shift the signal in time', () => {
  // A click at 0.5 s must come out at 0.5 s: sample counters are the worker's clock.
  const input = new Float32Array(48000);
  input[24000] = 1;
  const out = createResampler(48000, 16000).process(input);
  let peak = 0;
  for (let i = 1; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[peak])) peak = i;
  assert.equal(peak, 8000);
});

test('flush returns the samples the filter was holding back, then starts over', () => {
  for (const from of [48000, 44100, 8000]) {
    const input = sine(from, 600, 1);
    const resampler = createResampler(from, 16000);
    const head = resampler.process(input);
    const tail = resampler.flush();
    assert.ok(tail.length > 0 && tail.length < 40, `${from}: about a millisecond (${tail.length} samples)`);
    assert.equal(head.length + tail.length, 16000, `${from}: one second in, one second out`);
    assert.equal(resampler.flush().length, 0);
    // After a flush the resampler behaves like a new one.
    assert.deepEqual(resampler.process(input), createResampler(from, 16000).process(input));
  }
  assert.equal(createResampler(16000, 16000).flush().length, 0);
});

test('upsampling works and reset starts a new stream', () => {
  const up = createResampler(8000, 16000);
  const out = up.process(sine(8000, 500, 1));
  assert.ok(Math.abs(out.length - 16000) <= 160);
  assert.ok(Math.abs(risingZeroCrossings(out) / (out.length / 16000) - 500) <= 5);

  const input = sine(48000, 1000, 0.25);
  const resampler = createResampler(48000, 16000);
  const first = Float32Array.from(resampler.process(input));
  resampler.process(sine(48000, 3000, 0.1));
  resampler.reset();
  assert.deepEqual(resampler.process(input), first);
});

test('equal rates are the identity, and bad rates are refused', () => {
  const input = sine(16000, 440, 0.1);
  const same = createResampler(16000, 16000);
  assert.deepEqual(same.process(input), input);
  same.reset();
  assert.throws(() => createResampler(0, 16000), RangeError);
  assert.throws(() => createResampler(44100.5, 16000), RangeError);
  assert.equal(createResampler(48000, 16000).process(new Float32Array(0)).length, 0);
});

test('stt/lang.cjs carries the same word lists as src/util/lang.ts', () => {
  const ts = readFileSync(join(REPO, 'src', 'util', 'lang.ts'), 'utf8');
  const cjs = readFileSync(join(STT_DIR, 'lang.cjs'), 'utf8');
  const wordList = (source: string, name: string): string[] => {
    const block = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(source);
    assert.ok(block, `${name} list found`);
    return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  };
  for (const name of ['FR', 'EN']) {
    const expected = wordList(ts, name);
    assert.ok(expected.length > 50);
    assert.deepEqual(wordList(cjs, name), expected, `${name} words`);
  }
});

test('stt/lang.cjs decides like src/util/lang.ts', () => {
  const samples = [
    '',
    'ok',
    'Budget',
    'On se revoit jeudi pour le budget, et il faut que tout soit prêt.',
    'We need to have the numbers before the steering committee, so that is the plan.',
    "C'est ce qu'on a dit, mais il n'y a pas de plan pour ça.",
    "I don't know if they will be there, but we should ask.",
    'Le budget is not ready',
    'the plan pour la semaine and the budget pour le mois',
    'OÙ est le rapport? Très bien, après la réunion.',
    'yes no oui non',
    'PMO R&D OGOV 2026',
    'on',
    'on on',
    'a a a de de',
    'de de de a a',
    'speech 1.0s',
    'bonjour nous avons le budget pour',
    'hello we have the budget for',
  ];
  for (const text of samples) assert.equal(langCjs.detectLang(text), detectLangTs(text), JSON.stringify(text));
  assert.equal(langCjs.detectLang(samples[3]), 'fr');
  assert.equal(langCjs.detectLang(samples[4]), 'en');
  assert.equal(langCjs.detectLang('ok'), undefined);
  assert.deepEqual(langCjs.langScores("C'est l'heure"), { fr: 1, en: 0, total: 2 });
});

test('parseWav reads mono, stereo and extensible 16-bit PCM', () => {
  const mono = workerModule.parseWav(wavFile(16000, 1, Int16Array.from([1, -2, 300])));
  assert.equal(mono.sampleRate, 16000);
  assert.equal(mono.channels, 1);
  assert.deepEqual([...mono.samples], [1, -2, 300]);

  const stereoBytes = wavFile(44100, 2, Int16Array.from([0, 0]));
  // Left 100 and right 300 average to 200; left -3 and right -4 round to -3 (ties go up).
  stereoBytes.writeInt16LE(100, 44);
  stereoBytes.writeInt16LE(300, 46);
  stereoBytes.writeInt16LE(-3, 48);
  stereoBytes.writeInt16LE(-4, 50);
  const stereo = workerModule.parseWav(stereoBytes);
  assert.equal(stereo.sampleRate, 44100);
  assert.equal(stereo.channels, 2);
  assert.deepEqual([...stereo.samples], [200, -3]);

  // A LIST chunk before the data, an odd-sized chunk with its pad byte, and
  // a WAVE_FORMAT_EXTENSIBLE header.
  const plain = wavFile(48000, 1, Int16Array.from([5, 6]));
  const fmt = Buffer.alloc(8 + 40);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(40, 4);
  fmt.writeUInt16LE(0xfffe, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(48000, 12);
  fmt.writeUInt32LE(96000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  fmt.writeUInt16LE(22, 24);
  fmt.writeUInt16LE(1, 32);
  const list = Buffer.concat([Buffer.from('LIST', 'latin1'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc'), Buffer.from([0])]);
  const extensible = Buffer.concat([plain.subarray(0, 12), fmt, list, plain.subarray(36)]);
  const parsed = workerModule.parseWav(extensible);
  assert.equal(parsed.sampleRate, 48000);
  assert.deepEqual([...parsed.samples], [5, 6]);
});

test('parseWav refuses what it cannot play', () => {
  assert.throws(() => workerModule.parseWav(Buffer.from('not a wav file at all')), /RIFF/);
  const float = wavFile(16000, 1, Int16Array.from([1]));
  float.writeUInt16LE(3, 20);
  assert.throws(() => workerModule.parseWav(float), /16-bit PCM/);
  const eightBit = wavFile(16000, 1, Int16Array.from([1]));
  eightBit.writeUInt16LE(8, 34);
  assert.throws(() => workerModule.parseWav(eightBit), /16-bit PCM/);
  assert.throws(() => workerModule.parseWav(wavFile(16000, 1, Int16Array.from([1])).subarray(0, 36)), /data chunk/);
});

test('readOnnxMetadata finds metadata_props without reading the graph', () => {
  const dir = tempDir();
  const file = join(dir, 'encoder.onnx');
  writeFileSync(file, fakeOnnx(MODEL_METADATA));
  assert.deepEqual(workerModule.readOnnxMetadata(file), MODEL_METADATA);

  assert.equal(workerModule.readOnnxMetadata(join(dir, 'absent.onnx')), null);
  const truncated = join(dir, 'truncated.onnx');
  writeFileSync(truncated, fakeOnnx(MODEL_METADATA).subarray(0, 5000));
  assert.equal(workerModule.readOnnxMetadata(truncated), null);
  const text = join(dir, 'text.onnx');
  writeFileSync(text, 'not a real decoder');
  assert.equal(workerModule.modelLanguages(workerModule.readOnnxMetadata(text)), null);
});

test('modelLanguages and normalizeLanguage follow sherpa-onnx', () => {
  assert.equal(workerModule.normalizeLanguage(' fr_CA '), 'fr-ca');
  assert.equal(workerModule.normalizeLanguage('<en-US>'), 'en-us');
  assert.equal(workerModule.normalizeLanguage('"AUTO"'), 'auto');
  assert.equal(workerModule.normalizeLanguage(undefined), '');

  const known = workerModule.modelLanguages(MODEL_METADATA);
  assert.ok(known);
  assert.deepEqual([...known].sort(), ['auto', 'en', 'en-gb', 'en-us', 'fr', 'fr-ca', 'fr-fr', 'ja', 'ja-jp']);
  // English-only models carry no dictionary: nothing can be said.
  assert.equal(workerModule.modelLanguages({ chunk_shift: '56' }), null);
  assert.equal(workerModule.modelLanguages({ prompt_dictionary: 'not json' }), null);
  assert.equal(workerModule.modelLanguages(null), null);
});

test('locateModel and parseArgs', () => {
  const runtime = makeRuntime(null);
  const located = workerModule.locateModel(runtime.modelDir);
  assert.deepEqual(located.missing, []);
  assert.equal(located.files?.encoder, join(runtime.modelDir, 'encoder.int8.onnx'));
  assert.deepEqual(workerModule.locateModel(join(runtime.dir, 'nowhere')), { files: null, missing: [join(runtime.dir, 'nowhere')] });

  assert.deepEqual(workerModule.parseArgs(['--model', '/m', '--lang', 'fr-CA', '--threads', '4']), {
    model: '/m',
    lang: 'fr-CA',
    threads: 4,
    selfTest: null,
    fake: false,
    statsMs: 5000,
  });
  assert.deepEqual(workerModule.parseArgs(['--self-test', 'a.wav', 'b.wav', '--fake']).selfTest, ['a.wav', 'b.wav']);
  assert.throws(() => workerModule.parseArgs(['--threads', 'many']), /positive integer/);
  assert.throws(() => workerModule.parseArgs(['--self-test']), /at least one WAV/);
  assert.throws(() => workerModule.parseArgs(['--model']), /needs a value/);
});

test('a signal during --self-test is not a pass', async () => {
  // A recognizer slow enough for the signal to land mid-file: 4 ms per 100 ms slice.
  const slow = STUB_SHERPA.replace(
    'this.pending = true;',
    'const until = Date.now() + 4; while (Date.now() < until) {} this.pending = true;',
  );
  assert.notEqual(slow, STUB_SHERPA);
  const runtime = makeRuntime(slow);
  const wav = join(runtime.dir, 'long.wav');
  const burst = joinPcm(silence(16000, 0.3), tone(16000, 0.6), silence(16000, 1.1));
  writeFileSync(wav, wavFile(16000, 1, joinPcm(...Array.from({ length: 30 }, () => burst))));
  const worker = startWorker(['--model', runtime.modelDir, '--self-test', wav], runtime.worker);
  await waitForFinals(worker, 1);
  worker.child.kill('SIGTERM');
  const { code } = await worker.exited;
  // `pnpm setup:stt` reads exit 0 as "the model transcribes": a run cut short must not say so.
  assert.ok(!worker.events.some((event) => event.type === 'selftest'), 'the run was interrupted before its summary');
  assert.notEqual(code, 0);
});

test('frames far smaller than a slice keep the clock and the partial rate', async () => {
  // An AudioWorklet posts 128-sample quanta; nothing obliges the sender to regroup them.
  const worker = startWorker(['--fake']);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  worker.send(hello('mic', 48000));
  const audio = joinPcm(silence(48000, 0.4), tone(48000, 2.0), silence(48000, 1.0), tone(48000, 0.5), silence(48000, 0.2));
  for (let offset = 0; offset < audio.length; offset += 128) {
    worker.send(encodePcm(SOURCE_MIC, audio.subarray(offset, offset + 128)));
  }
  worker.send(bye());
  assert.equal((await worker.exited).code, 0);
  const finals = finalsOf(worker);
  assert.deepEqual(finals.map((event) => event.text), ['speech 2.0s', 'speech 0.5s']);
  near(finals[0].t0, 0.4, 0.03, 'first t0');
  near(finals[0].t1, 2.4, 0.03, 'first t1');
  near(finals[1].t0, 3.4, 0.03, 'second t0');
  near(finals[1].t1, 3.9, 0.03, 'second t1');
  const firstFinalAt = worker.events.indexOf(finals[0]);
  const partials = worker.events.slice(0, firstFinalAt).filter(isPartial);
  // Two seconds of speech and 0.6 s of trailing silence: at most 4 per second of audio.
  assert.ok(partials.length >= 4 && partials.length <= 9, `${partials.length} partials`);
  // t1 is the last voiced 10 ms step, so two partials 250 ms apart can read 0.24 s apart.
  for (let i = 1; i < partials.length; i++) {
    assert.ok((partials[i].t1 as number) - (partials[i - 1].t1 as number) > 0.235, 'at least 250 ms of audio apart');
  }
  assert.deepEqual(errorsOf(worker), []);
});

test('ten minutes at 44.1 kHz with a hello every ten seconds: the clock does not drift', async () => {
  const rate = 44100;
  const worker = startWorker(['--fake']);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  const quiet = silence(rate, 10);
  for (let block = 0; block < 60; block++) {
    worker.send(hello('mic', rate));
    sendAudio(worker, SOURCE_MIC, rate, quiet);
  }
  worker.send(hello('mic', rate));
  sendAudio(worker, SOURCE_MIC, rate, joinPcm(silence(rate, 0.5), tone(rate, 1.0), silence(rate, 1.0)));
  worker.send(bye());
  assert.equal((await worker.exited).code, 0);
  const finals = finalsOf(worker);
  assert.deepEqual(finals.map((event) => event.text), ['speech 1.0s']);
  near(finals[0].t0, 600.5, 0.03, 't0 after ten minutes');
  near(finals[0].t1, 601.5, 0.03, 't1 after ten minutes');
});

test('a hello in the middle of an utterance does not cut it', async () => {
  const worker = startWorker(['--fake']);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  worker.send(hello('mic', 48000));
  sendAudio(worker, SOURCE_MIC, 48000, joinPcm(silence(48000, 0.3), tone(48000, 0.5)));
  // The device changes while someone is speaking.
  worker.send(hello('mic', 44100));
  sendAudio(worker, SOURCE_MIC, 44100, joinPcm(tone(44100, 0.5), silence(44100, 1.0)));
  worker.send(bye());
  assert.equal((await worker.exited).code, 0);
  const finals = finalsOf(worker);
  assert.deepEqual(finals.map((event) => event.text), ['speech 1.0s']);
  near(finals[0].t0, 0.3, 0.03, 't0');
  near(finals[0].t1, 1.3, 0.03, 't1');
});

test('degenerate input is survived: nothing sent, empty and odd frames, control frames that are not objects', async () => {
  const empty = startWorker(['--fake']);
  await empty.waitFor('ready', (event) => event.type === 'ready');
  empty.child.stdin.end();
  assert.deepEqual(await empty.exited, { code: 0, signal: null });
  assert.deepEqual(empty.events.map((event) => event.type), ['ready']);

  const worker = startWorker(['--fake']);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  // Flush and audio-less frames before anything is known about a source.
  worker.send(encodeControl({ type: 'flush' }));
  for (const body of ['null', '[]', '7', '"hello"', '{"type":7}', '']) {
    worker.send(encodeFrame(255, new TextEncoder().encode(body)));
  }
  worker.send(encodeControl({ type: 'hello' }));
  worker.send(encodeControl({ type: 'hello', source: 'mic', sampleRate: '48000' }));
  worker.send(encodeControl({ type: 'hello', source: 'mic', sampleRate: 16000.5 }));
  worker.send(hello('mic', 16000));
  worker.send(encodeFrame(SOURCE_MIC, new Uint8Array(0)));
  worker.send(encodeFrame(SOURCE_MIC, new Uint8Array(1)));
  // An odd payload loses its last byte, not its alignment: each frame stands alone.
  const speech = tone(16000, 0.5);
  const bytes = encodePcm(SOURCE_MIC, speech).subarray(8);
  worker.send(encodeFrame(SOURCE_MIC, Uint8Array.from([...bytes.subarray(0, 8001)])));
  worker.send(encodeFrame(SOURCE_MIC, bytes.subarray(8000)));
  sendAudio(worker, SOURCE_MIC, 16000, silence(16000, 1.0));
  worker.send(bye());
  assert.deepEqual(await worker.exited, { code: 0, signal: null });
  assert.deepEqual(finalsOf(worker).map((event) => event.text), ['speech 0.5s']);
  assert.ok(errorsOf(worker).every((event) => event.code === 'protocol'));
  assert.deepEqual(worker.noise, []);
});

test('a frame of the largest size is decoded whole', async () => {
  const worker = startWorker(['--fake']);
  await worker.waitFor('ready', (event) => event.type === 'ready');
  worker.send(hello('system', 16000));
  // 1 MiB is 32.768 s at 16 kHz.
  const audio = new Int16Array(524288);
  audio.set(tone(16000, 30.0), 16000);
  worker.send(encodePcm(SOURCE_SYSTEM, audio));
  worker.send(bye());
  assert.equal((await worker.exited).code, 0);
  const finals = finalsOf(worker, 'system');
  assert.deepEqual(finals.map((event) => event.text), ['speech 30.0s']);
  near(finals[0].t0, 1.0, 0.03, 't0');
  near(finals[0].t1, 31.0, 0.03, 't1');
});

test('SttProcess kills a real worker that hangs and carries on with a new one', async () => {
  const t = supervise(['--fake', '--stats-ms', '25'], { backoffMs: [30], heartbeatTimeoutMs: 1000 });
  t.proc.hello('mic', 16000);
  await t.proc.start();
  t.send(joinPcm(silence(16000, 0.2), tone(16000, 0.5), silence(16000, 1.0)), 16000);
  await until('the first final', () => t.finals().length >= 1);
  // With stats every 25 ms the heartbeat holds for as long as the worker lives.
  await new Promise((done) => setTimeout(done, 1300));
  assert.equal(t.proc.state(), 'running');

  // Frozen, not dead: no exit event will ever come by itself.
  t.children[0].kill('SIGSTOP');
  await until('the hang to be noticed', () => t.states.some(([state]) => state === 'crashed'), 5000);
  const crash = t.states.find(([state]) => state === 'crashed');
  assert.match(crash?.[1] ?? '', /stopped responding/);
  await until('the frozen worker to be gone', () => t.children[0].signalCode === 'SIGKILL');
  await until('the replacement', () => t.proc.state() === 'ready');
  assert.equal(t.children.length, 2);

  t.send(joinPcm(silence(16000, 0.2), tone(16000, 0.4), silence(16000, 1.0)), 16000);
  await until('a final from the replacement', () => t.finals().length >= 2);
  await t.proc.stop();
  assert.equal(t.proc.state(), 'exited');
  assert.equal(t.children[1].exitCode, 0);
});

test('SttProcess stopped right after start: the real worker leaves on the bye, without a kill', async () => {
  const t = supervise(['--fake']);
  t.proc.hello('mic', 16000);
  const started = t.proc.start();
  const began = Date.now();
  const stopped = t.proc.stop();
  await assert.rejects(started, /stopped before it was ready/);
  await stopped;
  assert.equal(t.proc.state(), 'exited');
  assert.ok(Date.now() - began < 1500, 'well inside the two-second grace period');
  assert.equal(t.children[0].exitCode, 0);
  assert.equal(t.children[0].signalCode, null);
  assert.deepEqual(t.states.map(([state]) => state), ['spawning', 'stopping', 'exited']);
});

for (const [name, patch] of [
  // A library whose token times do not count from the stream's start: they cannot place anything.
  [
    'token times on a clock of their own',
    (stub: string) => stub.replace('timestamps.push((stretch.start + i * 20) / 100);', 'timestamps.push(500 + (stretch.start + i * 20) / 100);'),
  ],
  ['no token times at all', (stub: string) => stub.replace("      timestamps,\n      num_trailing_blanks", '      num_trailing_blanks')],
  ['no token list at all', (stub: string) => stub.replace("      tokens,\n      timestamps,\n      num_trailing_blanks: last ? Math.floor((stream.hops - last.end) / 8) : 0,\n", '')],
] as const) {
  test(`the sherpa path: ${name} still give times inside the utterance`, async () => {
    const patched = patch(STUB_SHERPA);
    assert.notEqual(patched, STUB_SHERPA);
    const runtime = makeRuntime(patched);
    const worker = startWorker(['--model', runtime.modelDir], runtime.worker);
    await worker.waitFor('ready', (event) => event.type === 'ready');
    worker.send(hello('mic', 16000));
    // Speech at 0.5-1.5 s, 3.0-3.8 s and 6.0-7.0 s.
    sendAudio(
      worker,
      SOURCE_MIC,
      16000,
      joinPcm(
        silence(16000, 0.5),
        tone(16000, 1.0),
        silence(16000, 1.5),
        tone(16000, 0.8),
        silence(16000, 2.2),
        tone(16000, 1.0),
        silence(16000, 1.0),
      ),
    );
    worker.send(bye());
    assert.equal((await worker.exited).code, 0);
    const finals = finalsOf(worker);
    assert.equal(finals.length, 3);
    const spoken = [
      [0.5, 1.5],
      [3.0, 3.8],
      [6.0, 7.0],
    ];
    for (const [i, final] of finals.entries()) {
      const t0 = final.t0 as number;
      const t1 = final.t1 as number;
      assert.ok(t0 <= t1, `final ${i}: t0 ${t0} <= t1 ${t1}`);
      // "Accurate to about half a second" (protocol/segments.md): one 560 ms chunk either way.
      near(t0, spoken[i][0], 0.6, `final ${i} t0`);
      near(t1, spoken[i][1], 0.6, `final ${i} t1`);
      if (i > 0) assert.ok(t0 >= (finals[i - 1].t1 as number), `final ${i} starts after final ${i - 1} ended`);
    }
    for (const partial of partialsOf(worker)) assert.ok((partial.t0 as number) <= (partial.t1 as number));
    assert.deepEqual(errorsOf(worker), []);
  });
}

describe('createLevelGain', () => {
  const { createLevelGain } = require('../stt/worker.cjs') as {
    createLevelGain(): { process(samples: Float32Array): number };
  };
  /** 100 ms of a 440 Hz tone at this peak. */
  const slice = (peak: number): Float32Array => {
    const out = new Float32Array(1600);
    for (let i = 0; i < out.length; i++) out[i] = peak * Math.sin((2 * Math.PI * 440 * i) / 16000);
    return out;
  };
  const peakOf = (samples: Float32Array): number => samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const db = (gain: number): number => 20 * Math.log10(gain);

  test('speech at a normal level passes untouched, and nothing is ever lowered', () => {
    const gain = createLevelGain();
    for (const peak of [0.5, 0.9, 1]) {
      const samples = slice(peak);
      const before = Float32Array.from(samples);
      assert.equal(gain.process(samples), 1);
      assert.deepEqual(samples, before);
    }
  });

  test('quiet speech is raised to about -6 dBFS, in place, by +30 dB at most', () => {
    const gain = createLevelGain();
    const quiet = slice(0.02); // -34 dBFS
    assert.ok(Math.abs(gain.process(quiet) - 25) < 0.01);
    assert.ok(Math.abs(peakOf(quiet) - 0.5) < 1e-3, `peak ${peakOf(quiet)}`);
    const faint = createLevelGain();
    const whisper = slice(0.002); // -54 dBFS
    assert.equal(faint.process(whisper), 32, 'capped');
    assert.ok(peakOf(whisper) < 0.07);
  });

  test('a louder sound lowers the gain at once, so it is never pushed past the target', () => {
    const gain = createLevelGain();
    gain.process(slice(0.01));
    const loud = slice(0.4);
    gain.process(loud);
    assert.ok(peakOf(loud) <= 0.5 + 1e-6, `peak ${peakOf(loud)}`);
  });

  test('after the loudest speech the gain is held 2 s, then rises 3 dB a second, up to the cap', () => {
    const gain = createLevelGain();
    const first = gain.process(slice(0.25)); // about 2
    assert.ok(Math.abs(first - 2) < 0.01);
    const gains: number[] = [];
    for (let i = 0; i < 300; i++) gains.push(gain.process(slice(0)));
    assert.ok(gains.slice(0, 20).every((g) => g === first), 'held for 2 s');
    assert.ok(gains[20] > first, 'then it rises');
    // 3 dB a second: ten slices (one second) into the release, 3 dB more.
    assert.ok(Math.abs(db(gains[29]) - db(first) - 3) < 0.01, `${db(gains[29]) - db(first)}`);
    assert.equal(gains.at(-1), 32, 'never above the cap');
  });
});
