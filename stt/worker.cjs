#!/usr/bin/env node
'use strict';

/* The speech worker: binary audio frames in on stdin, JSON lines out on
   stdout. The contract is protocol/segments.md.

   It runs under the user's own Node, outside Obsidian, because the speech
   library is a native addon whose dylibs are found through DYLD_LIBRARY_PATH.
   stdout carries events and nothing else; diagnostics go to stderr. */

const fs = require('node:fs');
const path = require('node:path');
const frames = require('./frames.cjs');
const { createResampler } = require('./resample.cjs');
const { detectLang } = require('./lang.cjs');

const RATE = 16000;
// Audio is decoded in slices of this size whatever the frame size, so that
// partials and endpoints keep the same cadence for any sender.
const SLICE_SAMPLES = RATE / 10;
// 250 ms of audio between two partials of a source: at most 4 per second.
const PARTIAL_GAP_SAMPLES = RATE / 4;
const DEFAULT_STATS_MS = 5000;
// The silence sherpa-onnx's own command-line tool puts before and after a
// file by default. Without it this model can drop the last words.
const LEAD_IN_SECONDS = 0.5;
const TAIL_PADDING_SECONDS = 0.8;
// One encoder frame: how long the last token is assumed to last.
const TOKEN_SECONDS = 0.08;
// A final goes out after this much silence, or when the open piece has run
// this long (then at its last full sentence).
const PAUSE_SECONDS = 0.8;
const LONG_PIECE_SECONDS = 20;
// What the encoder still holds back when the recognizer gives no blank count.
const ENCODER_LAG_SECONDS = 0.5;
const REFEED_MARGIN_SECONDS = 0.24;
const REFEED_KEEP_SECONDS = 6;
const SENTENCE_END = /[.?!…]$/;
const LEADING_MARKS = /^[\s.?!…,;:]+/;
const CONTROL_TOKEN = /^<[^<>\s]*>$|^<\|[^|]*\|>$/;
const DEFAULT_CHUNK_MS = 560;
const SHUTDOWN_GRACE_MS = 1000;
// Speech raised to the level the model knows (see createLevelGain): the loudest recent peaks to
// about -6 dBFS, by +30 dB at most; held 2 s after the last louder peak, then lowered 3 dB a second.
const GAIN_TARGET = 0.5;
const GAIN_MAX = 32;
const GAIN_HOLD_SECONDS = 2;
const GAIN_RELEASE_DB_PER_SECOND = 3;

const EXIT = { ok: 0, error: 1, modelMissing: 2, addonLoadFailed: 3, protocol: 4 };

const SOURCE_NAMES = new Map([
  [frames.SOURCE_MIC, 'mic'],
  [frames.SOURCE_SYSTEM, 'system'],
]);

function log(message) {
  process.stderr.write(`[worker] ${message}\n`);
}

function parseArgs(argv) {
  const opts = {
    model: '',
    lang: 'auto',
    threads: 2,
    selfTest: null,
    fake: false,
    statsMs: DEFAULT_STATS_MS,
  };
  const positive = (name, raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} needs a positive integer, got "${raw}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--model':
        opts.model = value();
        break;
      case '--lang':
        opts.lang = value();
        break;
      case '--threads':
        opts.threads = positive(arg, value());
        break;
      case '--stats-ms':
        opts.statsMs = positive(arg, value());
        break;
      case '--fake':
        opts.fake = true;
        break;
      case '--self-test':
        opts.selfTest = [];
        while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.selfTest.push(argv[++i]);
        if (opts.selfTest.length === 0) throw new Error('--self-test needs at least one WAV file');
        break;
      default:
        throw new Error(`Unknown argument ${arg}`);
    }
  }
  return opts;
}

function createOutput(stream, onBroken) {
  let blocked = false;
  stream.on('drain', () => {
    blocked = false;
  });
  stream.on('error', onBroken);
  return {
    /**
     * Writes one event line. A droppable line (partial, stats) is skipped
     * while the pipe is full, so a slow reader costs partials and never a
     * final, and the worker never waits on stdout.
     */
    write(event, droppable) {
      if (droppable && blocked) return false;
      if (!stream.write(`${JSON.stringify(event)}\n`)) blocked = true;
      return true;
    },
    /** Calls back once everything written so far has left the process. */
    flush(done) {
      stream.write('', done);
    },
  };
}

/**
 * Decodes a 16-bit PCM WAV file, mixing all channels down to mono.
 * @param {Buffer} buf
 * @returns {{ sampleRate: number, channels: number, samples: Int16Array }}
 */
function parseWav(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('latin1', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in the sub-format GUID.
      if (fmt.format === 0xfffe && size >= 26 && body + 26 <= buf.length) {
        fmt.format = buf.readUInt16LE(body + 24);
      }
    } else if (id === 'data') {
      // Recorders that stream to disk leave the size at 0 or 0xFFFFFFFF.
      const end = size === 0 || body + size > buf.length ? buf.length : body + size;
      data = buf.subarray(body, end);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt) throw new Error('The WAV file has no fmt chunk');
  if (!data) throw new Error('The WAV file has no data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error(`Only 16-bit PCM WAV is supported (found format ${fmt.format}, ${fmt.bits} bits)`);
  }
  if (fmt.channels < 1 || fmt.sampleRate < 1) throw new Error('The WAV file has an invalid fmt chunk');

  const count = Math.floor(data.length / (2 * fmt.channels));
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2);
    samples[i] = Math.round(sum / fmt.channels);
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
}

function readVarint(buf, offset, limit) {
  let value = 0;
  let scale = 1;
  for (let i = offset; i < limit; i++) {
    const byte = buf[i];
    // Multiplication, not shifts: lengths in a 600 MB file pass 2^31.
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return { value, next: i + 1 };
    scale *= 128;
  }
  return null;
}

/**
 * Reads `metadata_props` from an ONNX file without loading it: it walks the
 * top-level fields of the ModelProto and seeks over everything else, so it
 * costs a few small reads even on a 600 MB encoder.
 * @param {string} file
 * @returns {Record<string, string> | null} null when the file is not readable as ONNX
 */
function readOnnxMetadata(file) {
  const METADATA_PROPS = 14;
  const MAX_ENTRY = 4 * 1024 * 1024;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    const meta = {};
    let pos = 0;
    while (pos < size) {
      const got = fs.readSync(fd, head, 0, head.length, pos);
      const tag = readVarint(head, 0, got);
      if (!tag) return null;
      const field = Math.floor(tag.value / 8);
      const wire = tag.value % 8;
      if (wire === 0) {
        const v = readVarint(head, tag.next, got);
        if (!v) return null;
        pos += v.next;
      } else if (wire === 1) {
        pos += tag.next + 8;
      } else if (wire === 5) {
        pos += tag.next + 4;
      } else if (wire === 2) {
        const len = readVarint(head, tag.next, got);
        if (!len) return null;
        const body = pos + len.next;
        if (body + len.value > size) return null;
        if (field === METADATA_PROPS && len.value <= MAX_ENTRY) {
          const entry = Buffer.alloc(len.value);
          fs.readSync(fd, entry, 0, entry.length, body);
          const pair = readStringPair(entry);
          if (pair) meta[pair.key] = pair.value;
        }
        pos = body + len.value;
      } else {
        return null;
      }
    }
    return meta;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** A StringStringEntryProto: field 1 is the key, field 2 the value. */
function readStringPair(buf) {
  let key = null;
  let value = '';
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos, buf.length);
    if (!tag || tag.value % 8 !== 2) return null;
    const len = readVarint(buf, tag.next, buf.length);
    if (!len || len.next + len.value > buf.length) return null;
    const text = buf.toString('utf8', len.next, len.next + len.value);
    const field = Math.floor(tag.value / 8);
    if (field === 1) key = text;
    else if (field === 2) value = text;
    pos = len.next + len.value;
  }
  return key === null ? null : { key, value };
}

/** The same normalization sherpa-onnx applies to a language string. */
function normalizeLanguage(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^["'<]+|["'>]+$/g, '')
    .trim()
    .replace(/_/g, '-')
    .toLowerCase();
}

/**
 * The languages a multilingual model accepts, from the `prompt_dictionary`
 * its encoder carries, with the bare-language aliases sherpa-onnx derives
 * ("fr" from "fr-CA"). Null when the model does not say.
 * @param {Record<string, string> | null} meta
 * @returns {Set<string> | null}
 */
function modelLanguages(meta) {
  if (!meta || typeof meta.prompt_dictionary !== 'string') return null;
  let dict;
  try {
    dict = JSON.parse(meta.prompt_dictionary);
  } catch {
    return null;
  }
  if (!dict || typeof dict !== 'object' || Array.isArray(dict)) return null;
  const known = new Set(['auto']);
  for (const key of Object.keys(dict)) {
    const lang = normalizeLanguage(key);
    if (!lang) continue;
    known.add(lang);
    const dash = lang.indexOf('-');
    if (dash > 0) known.add(lang.slice(0, dash));
  }
  return known;
}

function chunkMsOf(modelDir, meta) {
  const named = /-(\d+)ms(?:-|$)/.exec(path.basename(modelDir));
  if (named) return Number(named[1]);
  // chunk_shift counts 10 ms feature frames.
  const frames10ms = Number(meta && meta.chunk_shift);
  if (Number.isFinite(frames10ms) && frames10ms > 0 && frames10ms <= 500) return frames10ms * 10;
  return DEFAULT_CHUNK_MS;
}

/**
 * Finds the transducer's files, preferring the int8 graphs.
 * @param {string} dir
 * @returns {{ files: { encoder: string, decoder: string, joiner: string, tokens: string } | null, missing: string[] }}
 */
function locateModel(dir) {
  const missing = [];
  const pick = (...names) => {
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // try the next name
      }
    }
    missing.push(names[0]);
    return '';
  };
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) return { files: null, missing: [dir] };
  const files = {
    encoder: pick('encoder.int8.onnx', 'encoder.onnx'),
    decoder: pick('decoder.int8.onnx', 'decoder.onnx'),
    joiner: pick('joiner.int8.onnx', 'joiner.onnx'),
    tokens: pick('tokens.txt'),
  };
  return missing.length ? { files: null, missing } : { files, missing };
}

/* The two recognizers below share one shape, so the pipeline does not care
 * which it drives. An engine makes one stream per audio source. A stream is
 * fed 16 kHz mono Float32 and answers:
 *   feed(samples)     accept audio and decode what is ready
 *   read()            { text, start?, end? }: the utterance so far; start/end
 *                     are seconds from the last reset, when the engine knows
 *   isEndpoint()      the utterance is over
 *   finish()          no more audio for this utterance: decode what is buffered
 *   reset()           begin the next utterance
 */

const FAKE_HOP = RATE / 100;
const FAKE_THRESHOLD = 0.02;
const FAKE_SILENCE_HOPS = 60;

/**
 * TEST ONLY (`--fake`). A stand-in recognizer that needs no library and no
 * model: it follows the signal's energy, calls any stretch above the
 * threshold speech, reports it as "speech <seconds>s", and ends the utterance
 * after 0.6 s of silence. Deterministic, so tests and the UI harness can rely
 * on its output.
 */
function createFakeEngine() {
  return {
    model: 'fake',
    chunkMs: 100,
    createStream() {
      let energy = 0;
      let fill = 0;
      let hops = 0;
      let speechStart = -1;
      let speechEnd = 0;
      return {
        feed(samples) {
          for (let i = 0; i < samples.length; i++) {
            energy += samples[i] * samples[i];
            if (++fill < FAKE_HOP) continue;
            if (Math.sqrt(energy / FAKE_HOP) > FAKE_THRESHOLD) {
              if (speechStart < 0) speechStart = hops;
              speechEnd = hops + 1;
            }
            hops += 1;
            energy = 0;
            fill = 0;
          }
        },
        read() {
          if (speechStart < 0) return { text: '' };
          const start = speechStart / 100;
          const end = speechEnd / 100;
          return { text: `speech ${(end - start).toFixed(1)}s`, start, end };
        },
        isEndpoint() {
          return speechStart >= 0 && hops - speechEnd >= FAKE_SILENCE_HOPS;
        },
        finish() {},
        reset() {
          energy = 0;
          fill = 0;
          hops = 0;
          speechStart = -1;
          speechEnd = 0;
        },
      };
    },
  };
}

/**
 * The real recognizer: Nemotron 3.5 ASR Streaming through sherpa-onnx-node.
 * The config mirrors sherpa-onnx's nodejs-addon-examples/test_asr_streaming_nemotron.js,
 * plus endpointing. `warn(code, message)` reports a non-fatal problem once.
 */
function createSherpaEngine({ sherpa, modelDir, files, threads, lang, warn }) {
  const meta = readOnnxMetadata(files.encoder);
  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 128 },
    modelConfig: {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
    // The recognizer's own endpoints are off. Acting on one means reset(), and a
    // reset throws away what the encoder has already heard of the next word:
    // measured on this model, words were lost at two boundaries in three
    // ("Merci d'être là" came out as "d'être là"). The stream below keeps
    // decoding and cuts its finals out of the token list instead.
    enableEndpoint: false,
  });

  // '' leaves the stream on the model's automatic detection.
  let language = '';
  const wanted = normalizeLanguage(lang);
  if (wanted && wanted !== 'auto') {
    const known = modelLanguages(meta);
    if (known && !known.has(wanted)) {
      // sherpa-onnx would log "Unsupported language" on stderr and fall back
      // to auto on every decode; saying it once here is clearer.
      warn('lang_unsupported', `The speech model has no language "${lang}"; using automatic detection.`);
    } else {
      language = String(lang).trim();
    }
  }

  function newStream() {
    const stream = recognizer.createStream();
    if (language) {
      if (typeof stream.setOption === 'function') {
        stream.setOption('language', language);
      } else {
        warn(
          'lang_unsupported',
          'This sherpa-onnx-node has no per-stream options (stream.setOption); update it by running the speech setup again. Using automatic detection.',
        );
        language = '';
      }
    }
    return stream;
  }

  function decode(stream) {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
  }


  return {
    model: path.basename(modelDir),
    chunkMs: chunkMsOf(modelDir, meta),
    createStream() {
      // Null between a finish() and the next audio: inputFinished() is final
      // for a sherpa stream, so the next utterance needs a new one, and there
      // is no point in making it when the worker is about to exit.
      let stream = newStream();
      let finished = false;
      // Samples accepted since this source began, and the one the current
      // sherpa stream counts its token times from.
      let fed = 0;
      let base = 0;
      // Tokens of the current stream that already went out in a final.
      let committed = 0;
      // The open piece as of the last feed(), and where it ends if a final is due.
      let piece = { text: '' };
      let cut = -1;
      let tokens = [];
      let times = [];
      let blanks = 0;
      // Without token times: the text seen last, when it last grew, and how much of it is out.
      let seenText = '';
      let grewAt = 0;
      let doneChars = 0;
      let cutChars = -1;
      // The last few seconds fed, to hand again to a fresh encoder (see renew).
      const recent = new Float32Array(Math.round(REFEED_KEEP_SECONDS * RATE));
      let recentLength = 0;

      function remember(samples) {
        if (samples.length >= recent.length) {
          recent.set(samples.subarray(samples.length - recent.length));
          recentLength = recent.length;
          return;
        }
        const overflow = recentLength + samples.length - recent.length;
        if (overflow > 0) {
          recent.copyWithin(0, overflow, recentLength);
          recentLength -= overflow;
        }
        recent.set(samples, recentLength);
        recentLength += samples.length;
      }

      function textOf(from, to) {
        return tokens
          .slice(from, to)
          .filter((token) => !CONTROL_TOKEN.test(String(token).trim()))
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
      }

      /* Reads the stream and decides whether a final is due: after a pause, or
         when the open piece has run long, at its last full sentence. */
      function look() {
        piece = { text: '' };
        cut = -1;
        cutChars = -1;
        tokens = [];
        times = [];
        blanks = 0;
        if (!stream) return;
        const result = recognizer.getResult(stream) || {};
        const elapsed = (fed - base) / RATE;
        const listed =
          Array.isArray(result.tokens) &&
          Array.isArray(result.timestamps) &&
          result.timestamps.length >= result.tokens.length &&
          // A token stamped after the audio it was heard in: this library does not
          // count from where we think it does, and its times cannot place anything.
          (result.timestamps.length === 0 || Number(result.timestamps[result.timestamps.length - 1]) <= elapsed + 1);
        if (!listed) {
          lookAtText(result);
          return;
        }
        tokens = result.tokens;
        times = result.timestamps;
        const count = Math.min(tokens.length, times.length);
        const last = count > 0 ? Number(times[count - 1]) : 0;
        // Measured even when nothing is open: the renewal waits for a long pause.
        blanks = Number.isFinite(result.num_trailing_blanks)
          ? result.num_trailing_blanks * TOKEN_SECONDS
          : Math.max(0, elapsed - last - ENCODER_LAG_SECONDS);
        if (count <= committed) return;

        let end = count;
        let due = finished || blanks >= PAUSE_SECONDS;
        if (!due && last - Number(times[committed]) >= LONG_PIECE_SECONDS) {
          due = true;
          // Not at a mark that opens the piece: it closes the sentence before.
          let first = committed;
          while (first < count && /^[\s.?!…,;:]*$/.test(String(tokens[first]))) first += 1;
          for (let k = count - 1; k > first; k--) {
            if (SENTENCE_END.test(String(tokens[k - 1]).trim())) {
              end = k;
              break;
            }
          }
        }
        const text = textOf(committed, end);
        // The mark that closes a sentence comes with the next one: after a
        // pause it opens the piece. It belongs to what is already out.
        const lead = LEADING_MARKS.exec(text);
        const body = lead ? text.slice(lead[0].length) : text;
        piece = {
          text: body,
          t0: round((base + Number(times[committed]) * RATE) / RATE, 3),
          t1: round((base + (Number(times[end - 1]) + TOKEN_SECONDS) * RATE) / RATE, 3),
        };
        if (lead) piece.closes = lead[0].replace(/\s+/g, '');
        if (due) cut = end;
      }

      /* The same without token times (a library that gives only the text, or
         times on a clock of its own): the piece is what the text has gained
         since the last final, and a pause is the text standing still. The
         pipeline then places the piece by its own sample counts. */
      function lookAtText(result) {
        const whole = typeof result.text === 'string' ? result.text.replace(/\s+/g, ' ').trim() : '';
        if (whole.length < doneChars) doneChars = 0;
        if (whole !== seenText) {
          seenText = whole;
          grewAt = fed;
        }
        const text = whole.slice(doneChars).trim();
        if (!text) return;
        const lead = LEADING_MARKS.exec(text);
        piece = { text: lead ? text.slice(lead[0].length) : text };
        if (lead) piece.closes = lead[0].replace(/\s+/g, '');
        blanks = Math.max(0, (fed - grewAt) / RATE - ENCODER_LAG_SECONDS);
        if (finished || blanks >= PAUSE_SECONDS) {
          cut = 0;
          cutChars = whole.length;
        }
      }

      /* A fresh recognizer after each final that ends at a pause, with the
         audio since the last word heard again. Both halves are measured on
         this model. Kept running through a silence, the decoder misses the
         first words of the next sentence ("Combien coûte une journée" was
         never emitted after 2.6 s of silence). Reset without the audio since
         the last word, it loses a word that has just begun. Reset and fed
         again, it lost the fewest words of the three on every recording. Never
         in mid-speech: a piece cut at its 20 s limit leaves the rest open. */
      function renew() {
        // Without token times `committed` stays at 0: such a stream is never renewed.
        if (!stream || finished || committed === 0) return;
        const count = Math.min(tokens.length, times.length);
        if (committed < count || blanks < PAUSE_SECONDS) return;
        const lastEnd = count > 0 ? Number(times[count - 1]) + TOKEN_SECONDS : 0;
        const wanted = base + Math.round((lastEnd + REFEED_MARGIN_SECONDS) * RATE);
        const from = Math.min(fed, Math.max(wanted, fed - recentLength));
        recognizer.reset(stream);
        base = from;
        committed = 0;
        seenText = '';
        doneChars = 0;
        grewAt = fed;
        if (from < fed) {
          stream.acceptWaveform({ samples: recent.slice(recentLength - (fed - from), recentLength), sampleRate: RATE });
          decode(stream);
        }
        look();
      }

      return {
        feed(samples) {
          if (!stream) {
            stream = newStream();
            base = fed;
            committed = 0;
            seenText = '';
            doneChars = 0;
            grewAt = fed;
            recentLength = 0;
          }
          stream.acceptWaveform({ samples, sampleRate: RATE });
          decode(stream);
          fed += samples.length;
          remember(samples);
          look();
          if (cut < 0) renew();
        },
        /** The open piece: `t0`/`t1` are seconds of this source's audio. Up to the cut when a final is due. */
        read() {
          return piece;
        },
        isEndpoint() {
          return Boolean(stream) && !finished && cut >= 0 && piece.text !== '';
        },
        finish() {
          if (!stream || finished) return;
          finished = true;
          stream.acceptWaveform({
            samples: new Float32Array(Math.round(TAIL_PADDING_SECONDS * RATE)),
            sampleRate: RATE,
          });
          stream.inputFinished();
          decode(stream);
          look();
        },
        /** The piece that was read is out: the next one begins after it. */
        reset() {
          if (finished) {
            stream = null;
            finished = false;
            committed = 0;
            piece = { text: '' };
            cut = -1;
            cutChars = -1;
            return;
          }
          if (!stream) return;
          if (cutChars >= 0) doneChars = cutChars;
          else if (cut >= 0) committed = cut;
          look();
        },
      };
    },
  };
}

function loadSherpa() {
  // Resolved from this file's directory: in the runtime directory the package
  // sits in ./node_modules whatever the working directory is.
  return require(require.resolve('sherpa-onnx-node', { paths: [__dirname] }));
}

const round = (value, digits) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/**
 * Raises quiet speech to the level the model knows, in place, a slice at a time. This model reads
 * absolute levels (its features are not normalized), and a quiet microphone costs words: clean
 * speech at -47 dBFS lost 9 % of its words, and speech at -35 dBFS with room noise 8 %; raised to
 * full level, 1 % and 3 %. Only ever raised: loud input passes as it is. The gain follows the
 * loudest recent speech, down at once when it gets louder, held, then up slowly, and never above
 * GAIN_MAX, so that the silence of a room is not made into loud noise. Returns the gain applied.
 */
function createLevelGain() {
  const floor = GAIN_TARGET / GAIN_MAX;
  let envelope = floor;
  // In samples: whole numbers, where seconds added up would drift.
  let sinceRise = 0;
  return {
    process(samples) {
      let peak = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i] < 0 ? -samples[i] : samples[i];
        if (v > peak) peak = v;
      }
      if (peak >= envelope) {
        envelope = peak;
        sinceRise = 0;
      } else {
        sinceRise += samples.length;
        if (sinceRise > GAIN_HOLD_SECONDS * RATE) {
          const seconds = samples.length / RATE;
          envelope = Math.max(floor, envelope * 10 ** ((-GAIN_RELEASE_DB_PER_SECOND * seconds) / 20));
        }
      }
      // The envelope is at least this slice's peak: the gain cannot push it past GAIN_TARGET.
      const gain = Math.min(GAIN_MAX, Math.max(1, GAIN_TARGET / envelope));
      if (gain > 1) for (let i = 0; i < samples.length; i++) samples[i] *= gain;
      return gain;
    },
  };
}

/**
 * Frames in, events out. Audio is resampled on arrival and queued; the queue
 * is drained one slice per event-loop turn so that stdin keeps being read
 * while the recognizer works, which is what makes `backlogMs` measurable.
 *
 * @param {{ engine: any, out: any, quiet: boolean, onDone(code: number): void }} deps
 *   `quiet` suppresses partials (self-test).
 */
function createPipeline({ engine, out, quiet, onDone }) {
  const sources = new Map();
  const warned = new Set();
  const chunkSamples = Math.round((engine.chunkMs / 1000) * RATE);

  let queue = [];
  let head = 0;
  let queuedSamples = 0;
  let scheduled = false;
  let stopped = false;

  // Since the last stats line.
  let decodeNs = 0n;
  let decodedSamples = 0;
  // Since the start.
  let totalDecodeNs = 0n;
  let totalSamples = 0;
  let finals = 0;

  function warnOnce(key, code, message) {
    if (warned.has(key)) return;
    warned.add(key);
    log(message);
    out.write({ type: 'error', code, message }, false);
  }

  function newSource(name) {
    return {
      name,
      stream: engine.createStream(),
      resampler: null,
      gain: createLevelGain(),
      // All counters are in 16 kHz samples handed to the recognizer.
      fed: 0,
      segStart: 0,
      textSince: -1,
      lastChange: 0,
      text: '',
      result: { text: '' },
      partialText: '',
      partialAt: -PARTIAL_GAP_SAMPLES,
      // Where the last final of this source ended, in seconds.
      lastEnd: 0,
    };
  }

  function note(src, result, before) {
    src.result = result;
    if (result.text === src.text) return;
    if (!src.text) src.textSince = before;
    src.text = result.text;
    src.lastChange = src.fed;
  }

  function span(src) {
    const segStart = src.segStart / RATE;
    const now = src.fed / RATE;
    const { start, end } = src.result;
    let t0;
    let t1;
    // Times the engine gives on this source's own clock are taken as they are.
    const { t0: at0, t1: at1 } = src.result;
    if (Number.isFinite(at0) && Number.isFinite(at1) && at0 >= 0 && at1 >= at0 && at0 <= now + 1) {
      // Never before the end of the final that came before: a token is stamped
      // at its start, so two neighbours can overlap by a few hundredths.
      const from = Math.max(at0, src.lastEnd);
      return { t0: round(from, 2), t1: round(Math.max(from, Math.min(at1, Math.max(now, at0))), 2) };
    }
    // The engine's own token times, when they make sense as offsets into this
    // utterance. Otherwise: text shows up one chunk after the speech began.
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start && segStart + end <= now + 1) {
      t0 = segStart + start;
      t1 = Math.min(segStart + end, Math.max(now, segStart + start));
    } else {
      t0 = Math.max(src.segStart, src.textSince - chunkSamples) / RATE;
      t1 = src.lastChange / RATE;
    }
    return { t0: round(t0, 2), t1: round(Math.max(t0, t1), 2) };
  }

  function segment(src, isFinal) {
    const { t0, t1 } = span(src);
    const event = { type: 'segment', source: src.name, t0, t1, text: src.text, isFinal };
    // The mark that closes the previous final of this source ("?" most of all):
    // the recognizer writes it only once the next sentence has begun.
    if (isFinal && src.result.closes) event.closes = src.result.closes;
    const lang = detectLang(src.text);
    if (lang) {
      event.lang = lang;
      event.langSource = 'heuristic';
    }
    return event;
  }

  function endUtterance(src) {
    if (src.text) {
      const event = segment(src, true);
      out.write(event, false);
      src.lastEnd = event.t1;
      finals += 1;
    }
    src.stream.reset();
    src.segStart = src.fed;
    src.textSince = -1;
    src.lastChange = src.fed;
    src.text = '';
    src.result = { text: '' };
    src.partialText = '';
  }

  function maybePartial(src) {
    if (quiet || !src.text || src.text === src.partialText) return;
    if (src.fed - src.partialAt < PARTIAL_GAP_SAMPLES) return;
    if (!out.write(segment(src, false), true)) return;
    src.partialText = src.text;
    src.partialAt = src.fed;
  }

  function decodeSlice(src, samples) {
    const before = src.fed;
    const started = process.hrtime.bigint();
    src.stream.feed(samples);
    const result = src.stream.read();
    const endpoint = src.stream.isEndpoint();
    const spent = process.hrtime.bigint() - started;
    decodeNs += spent;
    totalDecodeNs += spent;
    decodedSamples += samples.length;
    totalSamples += samples.length;
    src.fed += samples.length;
    note(src, result, before);
    if (endpoint) endUtterance(src);
    else maybePartial(src);
  }

  /** Finalizes every open utterance now, without waiting for silence. */
  function flushAll() {
    for (const src of sources.values()) {
      // Nothing fed since the last final, and nothing left open by a cut in mid-speech.
      // Nor the rest of a piece cut at its 20 s limit, still open in the engine.
      if (src.fed === src.segStart && !src.text && !src.stream.read().text) continue;
      src.stream.finish();
      note(src, src.stream.read(), src.fed);
      endUtterance(src);
    }
  }

  function take() {
    const item = queue[head];
    queue[head++] = undefined;
    if (head > 1024 && head * 2 > queue.length) {
      queue = queue.slice(head);
      head = 0;
    }
    return item;
  }

  function kick() {
    if (scheduled || stopped || head >= queue.length) return;
    scheduled = true;
    setImmediate(pump);
  }

  function pump() {
    scheduled = false;
    if (stopped || head >= queue.length) return;
    const item = take();
    if (item.samples) {
      queuedSamples -= item.samples.length;
      decodeSlice(item.src, item.samples);
    } else if (item.control === 'flush') {
      flushAll();
    } else {
      flushAll();
      stopped = true;
      onDone(EXIT.ok);
      return;
    }
    kick();
  }

  function hello(message) {
    const name = message.source;
    const rate = message.sampleRate;
    if (name !== 'mic' && name !== 'system') {
      return warnOnce(`hello:${name}`, 'protocol', `hello names an unknown source "${name}"; it was ignored.`);
    }
    if (!Number.isInteger(rate) || rate < 8000 || rate > 192000) {
      return warnOnce(`rate:${name}`, 'protocol', `hello for ${name} has an unusable sampleRate (${rate}); it was ignored.`);
    }
    let src = sources.get(name);
    if (!src) {
      src = newSource(name);
      sources.set(name, src);
    }
    // A fresh resampler on every hello: after a device change the old filter
    // state belongs to another signal, and the rate may differ. So does the level.
    drainResampler(src);
    src.resampler = createResampler(rate, RATE);
    src.gain = createLevelGain();
  }

  function enqueue(src, samples) {
    for (let offset = 0; offset < samples.length; offset += SLICE_SAMPLES) {
      // slice(), not subarray(): the addon gets a tight array of its own
      // rather than a view into a larger buffer.
      const slice = samples.slice(offset, offset + SLICE_SAMPLES);
      src.gain.process(slice);
      queue.push({ src, samples: slice });
    }
    queuedSamples += samples.length;
    kick();
  }

  /** Queues the millisecond of audio the resampler holds back, so that a flush covers everything received before it. */
  function drainResampler(src) {
    if (src.resampler) enqueue(src, src.resampler.flush());
  }

  function mark(type) {
    for (const src of sources.values()) drainResampler(src);
    queue.push({ control: type });
    kick();
  }

  function control(payload) {
    let message;
    try {
      message = JSON.parse(payload.toString('utf8'));
    } catch {
      message = null;
    }
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      return warnOnce('control:json', 'protocol', 'A control frame did not hold a JSON object with a type; it was ignored.');
    }
    switch (message.type) {
      case 'hello':
        hello(message);
        break;
      case 'flush':
      case 'bye':
        mark(message.type);
        break;
      default:
        // A newer sender may know control messages this worker does not.
        log(`ignoring control message "${message.type}"`);
    }
  }

  function audio(sourceByte, payload) {
    const name = SOURCE_NAMES.get(sourceByte);
    if (!name) {
      if (!warned.has(`source:${sourceByte}`)) {
        warned.add(`source:${sourceByte}`);
        log(`ignoring frames from unknown source ${sourceByte}`);
      }
      return;
    }
    const src = sources.get(name);
    if (!src || !src.resampler) {
      return warnOnce(`early:${name}`, 'protocol', `Audio for ${name} arrived before its hello frame; it was ignored.`);
    }
    if (payload.length % 2 === 1 && !warned.has(`odd:${name}`)) {
      warned.add(`odd:${name}`);
      log(`an audio frame for ${name} has an odd number of bytes; the last byte was dropped`);
    }
    const count = payload.length >> 1;
    if (count === 0) return;
    const float = new Float32Array(count);
    for (let i = 0; i < count; i++) float[i] = payload.readInt16LE(i * 2) / 32768;
    enqueue(src, src.resampler.process(float));
  }

  return {
    onFrame(sourceByte, payload) {
      if (stopped) return;
      if (sourceByte === frames.SOURCE_CONTROL) control(payload);
      else audio(sourceByte, payload);
    },
    /** Ends the input: everything queued is decoded, then onDone(0). */
    end() {
      mark('bye');
    },
    /** Finalizes now and drops audio still queued: for signals and protocol errors. */
    abort() {
      if (stopped) return;
      stopped = true;
      flushAll();
    },
    stats() {
      const seconds = decodedSamples / RATE;
      const rtf = seconds > 0 ? Number(decodeNs) / 1e9 / seconds : 0;
      decodeNs = 0n;
      decodedSamples = 0;
      return { type: 'stats', rtf: round(rtf, 3), backlogMs: Math.round(queuedSamples / (RATE / 1000)) };
    },
    totals() {
      const seconds = totalSamples / RATE;
      return { finals, seconds, rtf: seconds > 0 ? Number(totalDecodeNs) / 1e9 / seconds : 0 };
    },
  };
}

function main() {
  let exiting = false;
  let statsTimer = null;

  function exit(code) {
    if (exiting) return;
    exiting = true;
    if (statsTimer) clearInterval(statsTimer);
    process.stdin.pause();
    // stdout is asynchronous on a pipe: leaving before it drains loses the
    // last lines. The timer covers a reader that is gone or stuck.
    setTimeout(() => process.exit(code), SHUTDOWN_GRACE_MS);
    out.flush(() => process.exit(code));
  }

  const out = createOutput(process.stdout, (err) => {
    // EPIPE: the parent died. There is nobody left to tell.
    process.exit(err && err.code === 'EPIPE' ? EXIT.ok : EXIT.error);
  });
  // Diagnostics are best effort: a closed stderr must not take the worker down.
  process.stderr.on('error', () => {});

  function fatal(code, message, exitCode) {
    log(message);
    out.write({ type: 'error', code, message }, false);
    exit(exitCode);
  }

  let pipeline = null;

  process.on('uncaughtException', (err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    if (exiting) process.exit(EXIT.error);
    out.write({ type: 'error', code: 'internal', message: String(err && err.message ? err.message : err) }, false);
    exit(EXIT.error);
  });
  process.on('unhandledRejection', (reason) => {
    throw reason instanceof Error ? reason : new Error(String(reason));
  });

  let selfTesting = false;
  const onSignal = () => {
    if (exiting) return;
    if (pipeline) pipeline.abort();
    // An interrupted self-test has shown nothing, and its caller reads exit 0 as a pass.
    exit(selfTesting ? EXIT.error : EXIT.ok);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    return fatal('internal', err.message, EXIT.error);
  }

  let engine;
  if (opts.fake) {
    engine = createFakeEngine();
  } else {
    if (!opts.model) return fatal('internal', 'Missing --model <dir>', EXIT.error);
    const modelDir = path.resolve(opts.model);
    // Checked before the addon is loaded: it is cheap, and a missing model is
    // then reported as such even when the library is missing too.
    const located = locateModel(modelDir);
    if (!located.files) {
      return fatal(
        'model_missing',
        `The speech model is missing or incomplete in ${modelDir} (not found: ${located.missing.join(', ')})`,
        EXIT.modelMissing,
      );
    }
    let sherpa;
    try {
      sherpa = loadSherpa();
      if (!sherpa || typeof sherpa.OnlineRecognizer !== 'function') {
        throw new Error('sherpa-onnx-node does not export OnlineRecognizer');
      }
    } catch (err) {
      // The classic cause, stated only when it is observably the case.
      const dyld = process.env.DYLD_LIBRARY_PATH || '';
      const hint =
        process.platform === 'darwin' && !dyld.includes('sherpa-onnx-')
          ? ' (DYLD_LIBRARY_PATH does not point at node_modules/sherpa-onnx-darwin-arm64)'
          : '';
      return fatal('addon_load_failed', `sherpa-onnx-node failed to load: ${err.message}${hint}`, EXIT.addonLoadFailed);
    }
    log(`sherpa-onnx ${sherpa.version || '(unknown version)'}, model ${path.basename(modelDir)}`);
    const warned = new Set();
    try {
      engine = createSherpaEngine({
        sherpa,
        modelDir,
        files: located.files,
        threads: opts.threads,
        lang: opts.lang,
        warn(code, message) {
          if (warned.has(code)) return;
          warned.add(code);
          log(message);
          out.write({ type: 'error', code, message }, false);
        },
      });
    } catch (err) {
      return fatal('internal', `The recognizer could not be created: ${err.message}`, EXIT.error);
    }
  }

  if (opts.selfTest) {
    selfTesting = true;
    return selfTest(opts.selfTest, engine, out, exit);
  }

  pipeline = createPipeline({ engine, out, quiet: false, onDone: exit });
  const parser = frames.createFrameParser({
    onFrame: pipeline.onFrame,
    onError(err) {
      // Open utterances are still good: only what follows the bad frame is lost.
      pipeline.abort();
      fatal('protocol', err.message, EXIT.protocol);
    },
  });

  out.write({ type: 'ready', model: engine.model, chunkMs: engine.chunkMs }, false);
  // The stats line doubles as the heartbeat: it is sent with or without audio.
  statsTimer = setInterval(() => out.write(pipeline.stats(), true), opts.statsMs);

  process.stdin.on('data', (chunk) => parser.push(chunk));
  process.stdin.on('end', () => pipeline.end());
  process.stdin.on('error', () => pipeline.end());
}

/**
 * Transcribes WAV files through the same frame handler stdin feeds, prints
 * the finals and one summary line. Exit 0 only if something was recognized.
 */
function selfTest(files, engine, out, exit) {
  let seconds = 0;
  const pipeline = createPipeline({
    engine,
    out,
    quiet: true,
    onDone() {
      const totals = pipeline.totals();
      const ok = totals.finals > 0;
      out.write(
        { type: 'selftest', ok, finals: totals.finals, seconds: round(seconds, 2), rtf: round(totals.rtf, 3) },
        false,
      );
      exit(ok ? EXIT.ok : EXIT.error);
    },
  });
  const controlFrame = (message) => pipeline.onFrame(frames.SOURCE_CONTROL, Buffer.from(JSON.stringify(message)));
  const frameBytes = (rate) => Math.round(rate / 10) * 2;

  for (const file of files) {
    let wav;
    try {
      wav = parseWav(fs.readFileSync(file));
    } catch (err) {
      const message = `${file}: ${err.message}`;
      log(message);
      out.write({ type: 'error', code: 'internal', message }, false);
      continue;
    }
    seconds += wav.samples.length / wav.sampleRate;
    controlFrame({ type: 'hello', source: 'mic', sampleRate: wav.sampleRate });
    const leadIn = Math.round(LEAD_IN_SECONDS * wav.sampleRate) * 2;
    const pcm = Buffer.alloc(leadIn + wav.samples.length * 2);
    for (let i = 0; i < wav.samples.length; i++) pcm.writeInt16LE(wav.samples[i], leadIn + i * 2);
    const step = frameBytes(wav.sampleRate);
    for (let offset = 0; offset < pcm.length; offset += step) {
      pipeline.onFrame(frames.SOURCE_MIC, pcm.subarray(offset, offset + step));
    }
    controlFrame({ type: 'flush' });
  }
  pipeline.end();
}

module.exports = {
  EXIT,
  parseArgs,
  parseWav,
  readOnnxMetadata,
  normalizeLanguage,
  modelLanguages,
  locateModel,
  createFakeEngine,
  createSherpaEngine,
  createPipeline,
  createLevelGain,
};

if (require.main === module) main();
