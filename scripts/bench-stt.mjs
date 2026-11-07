#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Plays a WAV file to the speech worker the way the plugin does and reports
 * what came back.
 *
 *   node scripts/bench-stt.mjs <file.wav> [--lang auto] [--runtime <dir>] [--fast] [--fake]
 *
 * stdout: one JSON line per final segment. stderr: progress and the summary.
 * Audio is sent in 100 ms frames in real time, each frame once the time it
 * covers has passed, as a microphone would deliver it; --fast sends without
 * waiting. --fake uses the worker's stand-in recognizer straight from the
 * repository and needs nothing installed.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RUNTIME = join(homedir(), 'Library', 'Application Support', 'magical-hamster');
const ADDON_PACKAGE = 'sherpa-onnx-darwin-arm64';
const FRAME_MS = 100;
const READY_TIMEOUT_MS = 20000;

const require = createRequire(import.meta.url);
const frames = require('../stt/frames.cjs');
const { parseWav } = require('../stt/worker.cjs');

function fail(message) {
  console.error(`bench-stt: ${message}`);
  process.exit(1);
}

function usage(code) {
  console.error('Usage: node scripts/bench-stt.mjs <file.wav> [--lang auto] [--runtime <dir>] [--fast] [--fake]');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { file: '', lang: 'auto', runtime: DEFAULT_RUNTIME, fast: false, fake: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--lang') opts.lang = value();
    else if (arg === '--runtime') opts.runtime = resolve(value());
    else if (arg === '--fast') opts.fast = true;
    else if (arg === '--fake') opts.fake = true;
    else if (arg === '--help' || arg === '-h') usage(0);
    else if (arg.startsWith('--')) fail(`Unknown argument ${arg}`);
    else if (!opts.file) opts.file = arg;
    else fail(`Only one WAV file can be given (got ${opts.file} and ${arg})`);
  }
  if (!opts.file) usage(1);
  return opts;
}

/** The command line and environment the plugin uses for the worker. */
function workerCommand(opts) {
  if (opts.fake) {
    return { node: process.execPath, args: [join(REPO, 'stt', 'worker.cjs'), '--fake'], env: process.env };
  }
  const worker = join(opts.runtime, 'worker.cjs');
  if (!existsSync(worker)) {
    fail(`${worker} is not there. Run \`pnpm setup:stt\` first, or pass --fake.`);
  }
  let record = null;
  try {
    record = JSON.parse(readFileSync(join(opts.runtime, 'runtime.json'), 'utf8'));
  } catch {
    // an install whose self-test did not pass has no runtime.json; look for the model instead
  }
  let modelDir = record?.modelDir;
  if (!modelDir) {
    const models = join(opts.runtime, 'models');
    const dirs = existsSync(models)
      ? readdirSync(models).filter((name) => !name.startsWith('.') && statSync(join(models, name)).isDirectory())
      : [];
    if (dirs.length === 0) fail(`no model in ${models}. Run \`pnpm setup:stt\` first.`);
    modelDir = join(models, dirs.sort()[dirs.length - 1]);
  }
  const args = [worker, '--model', modelDir];
  if (opts.lang !== 'auto') args.push('--lang', opts.lang);
  return {
    node: record?.node ?? process.execPath,
    args,
    env: { ...process.env, DYLD_LIBRARY_PATH: join(opts.runtime, 'node_modules', ADDON_PACKAGE) },
  };
}

function pcmBytes(samples) {
  const bytes = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(samples[i], i * 2);
  return bytes;
}

const control = (message) => frames.encodeFrame(frames.SOURCE_CONTROL, Buffer.from(JSON.stringify(message)));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const seconds = (ms) => (ms / 1000).toFixed(2);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const opts = parseArgs(process.argv.slice(2));

let wav;
try {
  wav = parseWav(readFileSync(opts.file));
} catch (err) {
  fail(`${opts.file}: ${err.message}`);
}
const audioMs = (wav.samples.length / wav.sampleRate) * 1000;
const pcm = pcmBytes(wav.samples);

const command = workerCommand(opts);
console.error(`worker   ${command.node} ${command.args.join(' ')}`);
const spawnedAt = performance.now();
const child = spawn(command.node, command.args, { env: command.env, stdio: ['pipe', 'pipe', 'inherit'] });
child.on('error', (err) => fail(`the worker could not be started: ${err.message}`));
// A worker that dies early closes its stdin under us; the exit code tells the story.
child.stdin.on('error', () => {});

let maxRssKb = 0;
const rssTimer = setInterval(() => {
  execFile('ps', ['-o', 'rss=', '-p', String(child.pid)], (err, stdout) => {
    const kb = err ? NaN : parseInt(stdout, 10);
    if (kb > maxRssKb) maxRssKb = kb;
  });
}, 500);

let readyResolve;
const ready = new Promise((done) => {
  readyResolve = done;
});
let audioStartedAt = null;
let finals = 0;
let partials = 0;
let firstPartialMs = null;
let lastRtf = null;
let maxBacklogMs = 0;
const lags = [];
const errors = [];

function onEvent(event) {
  const now = performance.now();
  if (event.type === 'ready') {
    console.error(`ready    ${event.model}, ${event.chunkMs} ms chunks, after ${seconds(now - spawnedAt)} s`);
    readyResolve(event);
  } else if (event.type === 'segment' && event.isFinal) {
    finals += 1;
    process.stdout.write(`${JSON.stringify(event)}\n`);
    // Only meaningful in real time: then the audio at t1 was "spoken" t1 seconds after the start.
    if (!opts.fast && audioStartedAt !== null) lags.push(now - audioStartedAt - event.t1 * 1000);
  } else if (event.type === 'segment') {
    partials += 1;
    if (firstPartialMs === null && audioStartedAt !== null) firstPartialMs = now - audioStartedAt - event.t0 * 1000;
  } else if (event.type === 'stats') {
    if (event.rtf > 0) lastRtf = event.rtf;
    if (event.backlogMs > maxBacklogMs) maxBacklogMs = event.backlogMs;
  } else if (event.type === 'error') {
    errors.push(event);
    console.error(`error    ${event.code}: ${event.message ?? ''}`);
  }
}

let tail = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (text) => {
  const lines = (tail + text).split('\n');
  tail = lines.pop();
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object') onEvent(event);
    } catch {
      // the worker writes only JSON lines; anything else is noise from a native library
    }
  }
});

const exited = new Promise((done) => {
  child.on('exit', (code, signal) => done({ code, signal }));
});

const startup = await Promise.race([
  ready,
  exited.then(() => 'exited'),
  sleep(READY_TIMEOUT_MS).then(() => 'timeout'),
]);
if (startup === 'timeout') {
  child.kill('SIGKILL');
  fail(`the worker was not ready after ${READY_TIMEOUT_MS / 1000} s`);
}

if (startup !== 'exited') {
  child.stdin.write(control({ type: 'hello', source: 'mic', sampleRate: wav.sampleRate }));
  const frameBytes = Math.round((wav.sampleRate * FRAME_MS) / 1000) * 2;
  audioStartedAt = performance.now();
  for (let offset = 0, n = 1; offset < pcm.length; offset += frameBytes, n++) {
    // A worker ended by a signal (a crash in native code, the OOM killer) has no exit code.
    if (child.exitCode !== null || child.signalCode !== null) break;
    if (!opts.fast) {
      // Paced against the start, not the previous frame, so timer jitter does not add up.
      const due = audioStartedAt + n * FRAME_MS;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
    }
    const ok = child.stdin.write(frames.encodeFrame(frames.SOURCE_MIC, pcm.subarray(offset, offset + frameBytes)));
    // The stdin of a worker that died never drains: its exit ends the wait as well.
    if (!ok && opts.fast) await Promise.race([new Promise((done) => child.stdin.once('drain', done)), exited]);
  }
  child.stdin.write(control({ type: 'bye' }));
  child.stdin.end();
}

const { code, signal } = await exited;
clearInterval(rssTimer);
const wallMs = performance.now() - (audioStartedAt ?? spawnedAt);

const lagLine =
  lags.length > 0
    ? `median ${seconds(median(lags))} s, max ${seconds(Math.max(...lags))} s (end of speech to final)`
    : opts.fast
      ? 'not measured with --fast'
      : 'no finals';
console.error('');
console.error(`audio      ${seconds(audioMs)} s (${wav.sampleRate} Hz, ${wav.channels} channel${wav.channels === 1 ? '' : 's'})`);
console.error(`wall       ${seconds(wallMs)} s${opts.fast ? ' (--fast)' : ''}`);
console.error(`finals     ${finals}`);
console.error(`partials   ${partials}`);
if (firstPartialMs !== null && !opts.fast) console.error(`first text ${seconds(firstPartialMs)} s after its speech began`);
console.error(`final lag  ${lagLine}`);
console.error(`rtf        ${lastRtf ?? 'n/a'} (last stats line), backlog at most ${maxBacklogMs} ms`);
console.error(`max RSS    ${maxRssKb > 0 ? `${Math.round(maxRssKb / 1024)} MB` : 'n/a'}`);
console.error(`exit       ${code ?? signal}`);

process.exit(code === 0 && errors.length === 0 ? 0 : 1);
