import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { MicCapture, MicCaptureOptions } from '../src/audio/micCapture.ts';
import {
  defaultRuntimeDir,
  expandHome,
  parseRuntime,
  readRuntime,
  resolveNodePath,
  resolveRuntimeDir,
  workerCommand,
  workerOutdated,
} from '../src/host/runtime.ts';
import type { RuntimeInfo, WorkerCommand } from '../src/host/runtime.ts';
import { createStatsIO } from '../src/host/statsIO.ts';
import { DEFAULT_LOCAL } from '../src/settings.ts';
import type { WorkerChild } from '../src/stt/nodeSttSource.ts';
import { floatToInt16 } from '../src/stt/protocol.ts';
import type { Clock, LocalSettings, SttEvent, SttLanguage, SttState } from '../src/types.ts';

/* Module J: the runtime record, the worklet, the microphone capture and the
   transcript source. The last three run in Obsidian's renderer; here the
   worklet is evaluated against a stand-in for its global scope, the capture
   against stand-ins for WebAudio, and the source against a fake microphone
   with either a fake child or the real worker and its test recognizer. */

// micCapture.ts takes its worklet as text through Vite's `?raw`. Node has no
// such import, so the same thing is served here before the module is loaded.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('?raw')) return nextLoad(url, context);
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  },
});
const { startMicCapture } = await import('../src/audio/micCapture.ts');
const { createNodeTranscriptSource, createTranscriptSourceWith } = await import('../src/stt/nodeSttSource.ts');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const WORKLET_SOURCE = readFileSync(join(REPO, 'src', 'audio', 'pcm-worklet.js'), 'utf8');

const require = createRequire(import.meta.url);
const frames = require('../stt/frames.cjs') as {
  createFrameParser(handlers: {
    onFrame(source: number, payload: Uint8Array): void;
    onError(err: Error): void;
  }): { push(chunk: Uint8Array): void };
};

const tempDirs: string[] = [];
const spawned: ChildProcess[] = [];
after(() => {
  for (const child of spawned) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hamster-runtime-'));
  tempDirs.push(dir);
  return dir;
}

/** Lets pending promise continuations run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const RT = '/Users/someone/Library/Application Support/magical-hamster';
const MODEL = 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11';
/** What `pnpm setup:stt` writes. */
const RECORD = {
  node: '/opt/homebrew/bin/node',
  runtimeDir: RT,
  model: MODEL,
  modelDir: `${RT}/models/${MODEL}`,
  chunkMs: 560,
  sha256: 'c6bf5e0df765f9d5b43bc9e0536d4b4b3e7d40bdf5ecf13e45f134c51c05ae3a',
  sherpaVersion: '1.13.8',
  workerVersion: '0.1.4',
  installedAt: '2026-10-10T12:00:00.000Z',
};
const INFO: RuntimeInfo = {
  node: '/opt/homebrew/bin/node',
  runtimeDir: RT,
  modelDir: `${RT}/models/${MODEL}`,
  model: MODEL,
  chunkMs: 560,
  workerVersion: '0.1.4',
};

test('defaultRuntimeDir is the directory setup:stt installs into', () => {
  assert.equal(defaultRuntimeDir(homedir(), 'darwin'), join(homedir(), 'Library', 'Application Support', 'magical-hamster'));
  assert.equal(defaultRuntimeDir(homedir(), process.platform), defaultRuntimeDir(), 'this platform when none is named');
});

test('defaultRuntimeDir has a place on every desktop platform, since the stats and the index live there too', () => {
  assert.equal(defaultRuntimeDir('/home/x', 'linux', {}), '/home/x/.local/share/magical-hamster');
  assert.equal(defaultRuntimeDir('/home/x', 'linux', { XDG_DATA_HOME: '/data/x' }), '/data/x/magical-hamster');
  assert.equal(defaultRuntimeDir('/home/x', 'linux', { XDG_DATA_HOME: '  ' }), '/home/x/.local/share/magical-hamster', 'blank is unset');
  assert.equal(defaultRuntimeDir('/home/x', 'freebsd', {}), '/home/x/.local/share/magical-hamster');
  assert.equal(
    defaultRuntimeDir('C:\\Users\\x', 'win32', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }),
    'C:\\Users\\x\\AppData\\Roaming\\magical-hamster',
  );
  assert.equal(defaultRuntimeDir('C:\\Users\\x', 'win32', {}), 'C:\\Users\\x\\AppData\\Roaming\\magical-hamster');
  assert.equal(
    defaultRuntimeDir('/Users/x', 'darwin', { XDG_DATA_HOME: '/data/x', APPDATA: 'C:\\x' }),
    '/Users/x/Library/Application Support/magical-hamster',
    'a Mac ignores the other platforms’ variables',
  );
});

test('expandHome replaces a leading ~ by the home directory', () => {
  const home = '/Users/someone';
  assert.equal(expandHome('~', home), '/Users/someone');
  assert.equal(expandHome('~/x', home), '/Users/someone/x');
  assert.equal(expandHome('~/', home), '/Users/someone');
  assert.equal(
    expandHome('~/Library/Application Support/magical-hamster', home),
    '/Users/someone/Library/Application Support/magical-hamster',
    'spaces and deeper folders are kept',
  );
  assert.equal(expandHome('~/x', '/Users/someone/'), '/Users/someone/x', 'a home written with its slash');
});

test('expandHome leaves every other path as it is', () => {
  const home = '/Users/someone';
  assert.equal(expandHome('~user/x', home), '~user/x', 'another user’s home is not ours to guess');
  assert.equal(expandHome('~user', home), '~user');
  assert.equal(expandHome('/Volumes/Fast/hamster', home), '/Volumes/Fast/hamster');
  assert.equal(expandHome('/Users/someone/~/x', home), '/Users/someone/~/x', 'only a leading ~ means home');
  assert.equal(expandHome('runtime/~', home), 'runtime/~');
  assert.equal(expandHome('x~/y', home), 'x~/y');
  assert.equal(expandHome('', home), '');
  assert.equal(expandHome(' ~/x', home), ' ~/x', 'trimming is the caller’s business');
});

test('expandHome expands nothing when the home directory is unknown', () => {
  assert.equal(expandHome('~', ''), '~');
  assert.equal(expandHome('~/x', ''), '~/x');
});

test('resolveRuntimeDir is the default directory for an empty setting', () => {
  assert.equal(resolveRuntimeDir(''), defaultRuntimeDir());
  assert.equal(resolveRuntimeDir('   '), defaultRuntimeDir());
  assert.equal(resolveRuntimeDir('', '/Users/someone', 'darwin'), '/Users/someone/Library/Application Support/magical-hamster');
  assert.equal(defaultRuntimeDir('/Users/someone', 'darwin'), '/Users/someone/Library/Application Support/magical-hamster');
  assert.equal(resolveRuntimeDir('', '/home/x', 'linux', { XDG_DATA_HOME: '/data/x' }), '/data/x/magical-hamster');
});

test('resolveRuntimeDir expands a leading ~ and leaves an absolute folder alone', () => {
  const home = '/Users/someone';
  assert.equal(resolveRuntimeDir('~/hamster', home, 'darwin'), '/Users/someone/hamster');
  assert.equal(resolveRuntimeDir('  ~/hamster ', home, 'darwin'), '/Users/someone/hamster', 'as typed, spaces around included');
  assert.equal(resolveRuntimeDir('~', home, 'darwin'), '/Users/someone');
  assert.equal(resolveRuntimeDir('/Volumes/Fast/hamster', home, 'darwin'), '/Volumes/Fast/hamster');
  assert.equal(resolveRuntimeDir('~/hamster'), join(homedir(), 'hamster'), 'the real home when none is given');
  assert.equal(
    resolveRuntimeDir('~/Library/Application Support/magical-hamster', homedir(), 'darwin'),
    defaultRuntimeDir(homedir(), 'darwin'),
    'the default, spelled the way the documentation spells it',
  );
});

test('resolveRuntimeDir takes a relative folder from the home directory, not from where Obsidian was started', () => {
  const home = '/Users/x';
  assert.equal(resolveRuntimeDir('hamster', home, 'darwin'), '/Users/x/hamster');
  assert.equal(resolveRuntimeDir('./hamster', home, 'darwin'), '/Users/x/hamster');
  assert.equal(resolveRuntimeDir('speech/runtime', home, 'darwin'), '/Users/x/speech/runtime');
  // Another user's home is not ours to guess: it is a folder of that name, in ours.
  assert.equal(resolveRuntimeDir('~someone/hamster', home, 'darwin'), '/Users/x/~someone/hamster');
  assert.equal(resolveRuntimeDir('hamster', '', 'darwin'), 'hamster', 'nothing to take it from without a home');
});

test('resolveNodePath expands a leading ~ like the runtime folder, and keeps an empty setting empty', () => {
  const home = '/Users/x';
  assert.equal(resolveNodePath('~/bin/node', home), '/Users/x/bin/node');
  assert.equal(resolveNodePath('~/.nvm/versions/node/v24.0.0/bin/node', home), '/Users/x/.nvm/versions/node/v24.0.0/bin/node');
  assert.equal(resolveNodePath('  /opt/homebrew/bin/node ', home), '/opt/homebrew/bin/node');
  assert.equal(resolveNodePath('node', home), 'node', 'a bare command is left to the PATH');
  assert.equal(resolveNodePath('', home), '', 'empty means the Node the setup recorded');
  assert.equal(resolveNodePath('   ', home), '');
  assert.equal(resolveNodePath('~/bin/node'), join(homedir(), 'bin', 'node'), 'the real home when none is given');
});

test('parseRuntime accepts the record setup:stt writes and keeps what the plugin needs', () => {
  assert.deepEqual(parseRuntime(RECORD, RT), INFO);
});

test('parseRuntime survives a round trip through JSON text', () => {
  assert.deepEqual(parseRuntime(JSON.parse(JSON.stringify(RECORD, null, 2)), RT), INFO);
});

test('parseRuntime rejects a record with a missing or unusable field', () => {
  for (const key of ['node', 'model', 'modelDir', 'chunkMs'] as const) {
    const record: Record<string, unknown> = { ...RECORD };
    delete record[key];
    assert.equal(parseRuntime(record, RT), null, `without ${key}`);
  }
  assert.equal(parseRuntime({ ...RECORD, node: '' }, RT), null, 'empty node');
  assert.equal(parseRuntime({ ...RECORD, node: '   ' }, RT), null, 'blank node');
  // The installer writes the absolute path its self-test ran with; a relative one was edited in by hand.
  assert.equal(parseRuntime({ ...RECORD, node: 'node' }, RT), null, 'relative node');
  assert.equal(parseRuntime({ ...RECORD, node: 'bin/node' }, RT), null, 'relative node');
  assert.equal(parseRuntime({ ...RECORD, node: '~/bin/node' }, RT), null, 'a ~ is not expanded here either');
  assert.equal(parseRuntime({ ...RECORD, modelDir: 42 }, RT), null, 'modelDir of the wrong type');
  assert.equal(parseRuntime({ ...RECORD, model: null }, RT), null, 'null model');
  assert.equal(parseRuntime({ ...RECORD, chunkMs: '560' }, RT), null, 'chunkMs as text');
  assert.equal(parseRuntime({ ...RECORD, chunkMs: 0 }, RT), null, 'chunkMs of zero');
  assert.equal(parseRuntime({ ...RECORD, chunkMs: Number.NaN }, RT), null, 'chunkMs NaN');
});

test('parseRuntime rejects anything that is not an object', () => {
  for (const value of [null, undefined, 'text', 12, true, [], [RECORD]]) {
    assert.equal(parseRuntime(value, RT), null, JSON.stringify(value) ?? 'undefined');
  }
});

test('parseRuntime resolves a relative modelDir against the runtime directory', () => {
  assert.equal(parseRuntime({ ...RECORD, modelDir: `models/${MODEL}` }, RT)?.modelDir, `${RT}/models/${MODEL}`);
  assert.equal(parseRuntime({ ...RECORD, modelDir: `./models/${MODEL}` }, RT)?.modelDir, `${RT}/models/${MODEL}`);
  assert.equal(parseRuntime({ ...RECORD, modelDir: `models/${MODEL}` }, `${RT}/`)?.modelDir, `${RT}/models/${MODEL}`);
});

test('parseRuntime does not need the record to name its own directory', () => {
  const record: Record<string, unknown> = { ...RECORD };
  delete record.runtimeDir;
  assert.deepEqual(parseRuntime(record, RT), INFO);
});

test('parseRuntime keeps the plugin version the setup came from, and has none for a record without one', () => {
  assert.equal(parseRuntime(RECORD, RT)?.workerVersion, '0.1.4');
  const record: Record<string, unknown> = { ...RECORD };
  delete record.workerVersion;
  assert.deepEqual(parseRuntime(record, RT), { ...INFO, workerVersion: null }, 'a runtime set up before versions were recorded');
  assert.equal(parseRuntime({ ...RECORD, workerVersion: null }, RT)?.workerVersion, null, 'a setup run from a checkout');
  assert.equal(parseRuntime({ ...RECORD, workerVersion: 14 }, RT)?.workerVersion, null, 'not a string');
  assert.equal(parseRuntime({ ...RECORD, workerVersion: '' }, RT)?.workerVersion, '', 'a string is kept as written');
});

test('workerOutdated compares the major.minor of the setup with the plugin’s, and counts no version as outdated', () => {
  assert.equal(workerOutdated('0.1.5', '0.1.9'), false, 'a patch apart');
  assert.equal(workerOutdated('0.1.5', '0.1.5'), false);
  assert.equal(workerOutdated('0.1.9', '0.1.5'), false, 'a newer patch is the same worker');
  assert.equal(workerOutdated('0.1.5', '0.2.0'), true);
  assert.equal(workerOutdated('0.2.0', '0.1.5'), true, 'a worker from a later minor is not this plugin’s either');
  assert.equal(workerOutdated('0.1.5', '1.1.5'), true);
  assert.equal(workerOutdated('0.10.0', '0.1.0'), true, 'read as numbers, not as text');
  assert.equal(workerOutdated('0.01.0', '0.1.0'), false);
  assert.equal(workerOutdated(null, '0.1.5'), true);
  assert.equal(workerOutdated('', '0.1.5'), true);
  assert.equal(workerOutdated('yesterday', '0.1.5'), true);
  assert.equal(workerOutdated('0.1.5', 'dev'), false, 'a plugin whose version cannot be read asks for nothing');
  assert.equal(workerOutdated(null, 'dev'), true, 'but a runtime without a version is still from before');
});

test('parseRuntime trusts the directory the file was found in over the one it records', () => {
  const moved = '/Volumes/Fast/hamster';
  const info = parseRuntime(RECORD, moved);
  assert.equal(info?.runtimeDir, moved);
  // The model was inside the directory, so it moved with it.
  assert.equal(info?.modelDir, `${moved}/models/${MODEL}`);
});

test('parseRuntime leaves a model that was installed outside the runtime directory where it is', () => {
  const elsewhere = '/Volumes/Models/nemotron';
  assert.equal(parseRuntime({ ...RECORD, modelDir: elsewhere }, '/Volumes/Fast/hamster')?.modelDir, elsewhere);
  // A sibling whose name merely starts the same is not inside.
  const sibling = `${RT}-old/models/${MODEL}`;
  assert.equal(parseRuntime({ ...RECORD, modelDir: sibling }, '/Volumes/Fast/hamster')?.modelDir, sibling);
});

test('readRuntime returns null for a directory without a usable runtime', () => {
  const dir = tempDir();
  assert.equal(readRuntime(join(dir, 'missing')), null, 'no directory');
  assert.equal(readRuntime(dir), null, 'no runtime.json');

  writeFileSync(join(dir, 'runtime.json'), '{ "node": ');
  assert.equal(readRuntime(dir), null, 'runtime.json cut short');

  writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ ...RECORD, chunkMs: 'fast' }));
  writeFileSync(join(dir, 'worker.cjs'), '');
  assert.equal(readRuntime(dir), null, 'a record that does not validate');
});

test('readRuntime wants the worker script beside the record', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ ...RECORD, runtimeDir: dir, modelDir: 'models/m' }));
  assert.equal(readRuntime(dir), null, 'a record alone is a half-removed runtime');

  writeFileSync(join(dir, 'worker.cjs'), '');
  assert.deepEqual(readRuntime(dir), {
    node: RECORD.node,
    runtimeDir: dir,
    modelDir: join(dir, 'models', 'm'),
    model: MODEL,
    chunkMs: 560,
    workerVersion: '0.1.4',
  });
});

test('workerCommand builds the command line of protocol/segments.md', () => {
  const command = workerCommand(INFO, { nodePath: '/usr/local/bin/node', language: 'fr-CA', baseEnv: {} });
  assert.equal(command.command, '/usr/local/bin/node');
  assert.deepEqual(command.args, [`${RT}/worker.cjs`, '--model', `${RT}/models/${MODEL}`, '--lang', 'fr-CA']);
  assert.equal(command.cwd, RT);
  assert.deepEqual(command.env, { DYLD_LIBRARY_PATH: `${RT}/node_modules/sherpa-onnx-darwin-arm64` });
});

test('workerCommand falls back to the Node the installer recorded', () => {
  assert.equal(workerCommand(INFO, { nodePath: '', language: 'auto', baseEnv: {} }).command, '/opt/homebrew/bin/node');
  assert.equal(workerCommand(INFO, { nodePath: '  ', language: 'auto', baseEnv: {} }).command, '/opt/homebrew/bin/node');
});

test('workerCommand passes automatic detection explicitly', () => {
  assert.deepEqual(workerCommand(INFO, { nodePath: '', language: 'auto', baseEnv: {} }).args.slice(-2), ['--lang', 'auto']);
  assert.deepEqual(workerCommand(INFO, { nodePath: '', language: '', baseEnv: {} }).args.slice(-2), ['--lang', 'auto']);
});

test('workerCommand keeps the environment, minus what only Electron should see', () => {
  const baseEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/someone',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    NODE_OPTIONS: '--require /tmp/hook.js',
    NODE_PATH: '/tmp/modules',
    UNSET: undefined,
  };
  const snapshot = { ...baseEnv };
  const { env } = workerCommand(INFO, { nodePath: '', language: 'auto', baseEnv });
  assert.deepEqual(env, {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/someone',
    DYLD_LIBRARY_PATH: `${RT}/node_modules/sherpa-onnx-darwin-arm64`,
  });
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS', 'NODE_PATH', 'UNSET']) {
    assert.ok(!(key in env), key);
  }
  assert.deepEqual(baseEnv, snapshot, 'the caller’s environment is not touched');
});

test('workerCommand puts the addon directory in front of an existing DYLD_LIBRARY_PATH', () => {
  const addon = `${RT}/node_modules/sherpa-onnx-darwin-arm64`;
  const env = (existing: string) =>
    workerCommand(INFO, { nodePath: '', language: 'auto', baseEnv: { DYLD_LIBRARY_PATH: existing } }).env;
  assert.equal(env('/opt/lib:/usr/local/lib').DYLD_LIBRARY_PATH, `${addon}:/opt/lib:/usr/local/lib`);
  assert.equal(env('').DYLD_LIBRARY_PATH, addon);
  assert.equal(env(`/opt/lib:${addon}`).DYLD_LIBRARY_PATH, `${addon}:/opt/lib`, 'not listed twice');
});

interface Block {
  pcm: ArrayBuffer;
  peak: number;
}

interface Processor {
  process(inputs: Float32Array[][]): boolean;
}

/** Evaluates pcm-worklet.js with the three globals an AudioWorkletGlobalScope gives it. */
function loadWorklet(sampleRate: number, source: string = WORKLET_SOURCE, onPost?: (block: Block) => void) {
  const posts: Array<{ block: Block; transfer: unknown[] }> = [];
  const registered: Array<{ name: string; ctor: new () => Processor }> = [];
  class AudioWorkletProcessor {
    port = {
      postMessage(block: Block, transfer: unknown[]): void {
        posts.push({ block, transfer });
        onPost?.(block);
      },
    };
  }
  const registerProcessor = (name: string, ctor: new () => Processor): void => {
    registered.push({ name, ctor });
  };
  // Strict, as module code is: sloppy code would turn an undeclared name into a global and carry on.
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', `'use strict';\n${source}`)(
    AudioWorkletProcessor,
    registerProcessor,
    sampleRate,
  );
  assert.equal(registered.length, 1);
  const processor = new registered[0].ctor();
  return {
    name: registered[0].name,
    processor,
    posts,
    blocks: () => posts.map((post) => new Int16Array(post.block.pcm)),
    /** Feeds the samples the way the audio thread does: one 128-frame quantum at a time. */
    feed(samples: Float32Array): void {
      for (let offset = 0; offset < samples.length; offset += 128) {
        assert.equal(processor.process([[samples.subarray(offset, offset + 128)]]), true);
      }
    },
  };
}

function constant(value: number, frames: number): Float32Array {
  return new Float32Array(frames).fill(value);
}

test('the worklet stands alone and registers as hamster-pcm', () => {
  // Evaluated as a function body: an import or export statement would not even parse.
  assert.equal(loadWorklet(16000).name, 'hamster-pcm');
  assert.doesNotMatch(WORKLET_SOURCE, /\b(require|import)\(/, 'it is loaded from a Blob URL: nothing to load from');
});

test('the worklet posts 100 ms blocks whatever the quantum boundaries', () => {
  const w = loadWorklet(16000);
  // 1600 frames are 12.5 quanta: the block ends in the middle of the 13th.
  w.feed(constant(0.25, 12 * 128));
  assert.equal(w.posts.length, 0);
  w.feed(constant(0.25, 128));
  assert.equal(w.posts.length, 1);
  assert.equal(w.blocks()[0].length, 1600);

  // The 64 frames left over open the next block.
  w.feed(constant(0.25, 1536 - 128));
  assert.equal(w.posts.length, 1);
  w.feed(constant(0.25, 128));
  assert.equal(w.posts.length, 2);
  assert.equal(w.blocks()[1].length, 1600);
});

test('the worklet sizes its block from the real sample rate', () => {
  const w = loadWorklet(48000);
  w.feed(constant(0, 4800 - 64));
  assert.equal(w.posts.length, 0);
  w.feed(constant(0, 128));
  assert.equal(w.blocks()[0].length, 4800);
  assert.equal(loadWorklet(44100).processor.process([[constant(0, 128)]]), true);
});

test('the worklet keeps the samples in order across blocks', () => {
  const w = loadWorklet(16000);
  const ramp = new Float32Array(3200);
  for (let i = 0; i < ramp.length; i++) ramp[i] = i / 32767;
  w.feed(ramp);
  const [first, second] = w.blocks();
  assert.deepEqual(Array.from(first.subarray(0, 4)), [0, 1, 2, 3]);
  assert.equal(first[1599], 1599);
  assert.deepEqual(Array.from(second.subarray(0, 3)), [1600, 1601, 1602]);
  assert.equal(second[1599], 3199);
});

test('the worklet converts like floatToInt16, clamping and silencing NaN', () => {
  const values = [0, 1e-9, 0.5, -0.5, 0.999999, -0.999999, 1, -1, 1.7, -3, Infinity, -Infinity, Number.NaN, 0.1, -0.1];
  const input = new Float32Array(1600);
  input.set(values);
  const w = loadWorklet(16000);
  w.feed(input);
  const block = w.blocks()[0];
  assert.deepEqual(Array.from(block), Array.from(floatToInt16(input)));
  assert.deepEqual(Array.from(block.subarray(6, 13)), [32767, -32768, 32767, -32768, 32767, -32768, 0]);
});

test('the worklet reports each block’s peak, between 0 and 1', () => {
  const w = loadWorklet(16000);
  const quiet = constant(0, 1600);
  quiet[700] = -0.5;
  quiet[900] = 0.25;
  w.feed(quiet);
  w.feed(constant(0, 1600));
  const loud = constant(0.1, 1600);
  loud[3] = -4;
  loud[4] = Number.NaN;
  w.feed(loud);
  assert.deepEqual(
    w.posts.map((post) => post.block.peak),
    [0.5, 0, 1],
  );
});

test('the worklet hands each block over instead of copying it', () => {
  const w = loadWorklet(16000);
  w.feed(constant(0.5, 3200));
  assert.equal(w.posts.length, 2);
  for (const post of w.posts) assert.deepEqual(post.transfer, [post.block.pcm]);
  assert.notEqual(w.posts[0].block.pcm, w.posts[1].block.pcm, 'a transferred buffer cannot be written again');
});

test('the worklet counts a quantum without input as silence', () => {
  const w = loadWorklet(16000);
  w.feed(constant(0.5, 128));
  for (let i = 0; i < 6; i++) assert.equal(w.processor.process([[]]), true);
  for (let i = 0; i < 6; i++) assert.equal(w.processor.process([]), true);
  assert.equal(w.posts.length, 1, '13 quanta make a block, with or without a signal');
  const block = w.blocks()[0];
  assert.equal(block[127], 16384);
  assert.equal(block[128], 0);
  assert.equal(block[1599], 0);
});

class FakeAudioNode {
  readonly kind: string;
  readonly links: FakeAudioNode[] = [];
  disconnects = 0;
  constructor(kind: string) {
    this.kind = kind;
  }
  connect(to: FakeAudioNode): FakeAudioNode {
    this.links.push(to);
    return to;
  }
  disconnect(): void {
    this.disconnects += 1;
  }
}

class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live';
  stops = 0;
  stop(): void {
    this.stops += 1;
    this.readyState = 'ended';
  }
  unplug(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  getAudioTracks(): FakeTrack[] {
    return [this.track];
  }
  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

function domError(name: string, message = ''): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const globals = globalThis as Record<string, unknown>;
/** What Node itself has under these names, taken once: a test may install several fakes in a row. */
const realDom = {
  AudioContext: globals.AudioContext,
  AudioWorkletNode: globals.AudioWorkletNode,
  mediaDevices: Object.getOwnPropertyDescriptor(navigator, 'mediaDevices'),
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
};

function restoreDom(): void {
  globals.AudioContext = realDom.AudioContext;
  globals.AudioWorkletNode = realDom.AudioWorkletNode;
  if (realDom.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', realDom.mediaDevices);
  else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  if (realDom.window) Object.defineProperty(globalThis, 'window', realDom.window);
  else delete globals.window;
}

interface DomScript {
  /** Decides each getUserMedia call. Default: a stream every time. */
  getUserMedia?(constraints: MediaStreamConstraints, call: number): FakeStream;
  /** The rate the context really runs at. Default: the one asked for. */
  realRate?: number;
  /** Makes the constructor refuse an explicit sample rate. */
  refuseRate?: boolean;
  /** Makes addModule reject. */
  addModule?: Error;
  /** A context whose resume() never settles. */
  neverResumes?: boolean;
  /** A context whose close() never settles. */
  neverCloses?: boolean;
}

/** Replaces the WebAudio, media-device and window globals micCapture.ts uses, for one test. */
function installDom(t: TestContext, script: DomScript = {}) {
  const dom = {
    requests: [] as MediaStreamConstraints[],
    streams: [] as FakeStream[],
    contexts: [] as FakeContext[],
    worklets: [] as FakeWorkletNode[],
    moduleTexts: [] as string[],
  };

  class FakeWorkletNode extends FakeAudioNode {
    readonly name: string;
    readonly options: AudioWorkletNodeOptions;
    port: { onmessage: ((event: { data: Block }) => void) | null } = { onmessage: null };
    onprocessorerror: (() => void) | null = null;
    constructor(_ctx: FakeContext, name: string, options: AudioWorkletNodeOptions) {
      super('worklet');
      this.name = name;
      this.options = options;
      dom.worklets.push(this);
    }
    /** What the processor's port delivers. */
    post(samples: Int16Array, peak: number): void {
      this.port.onmessage?.({ data: { pcm: Int16Array.from(samples).buffer, peak } });
    }
  }

  class FakeContext {
    readonly options: AudioContextOptions;
    readonly sampleRate: number;
    readonly destination = new FakeAudioNode('destination');
    state: 'suspended' | 'running' | 'closed' = 'suspended';
    onstatechange: (() => void) | null = null;
    resumes = 0;
    source: FakeAudioNode | null = null;
    gain: (FakeAudioNode & { gain: { value: number } }) | null = null;
    readonly audioWorklet = {
      addModule: async (url: string): Promise<void> => {
        const blob = resolveObjectURL(url);
        dom.moduleTexts.push(blob ? await blob.text() : '');
        if (script.addModule) throw script.addModule;
      },
    };
    constructor(options: AudioContextOptions = {}) {
      if (script.refuseRate && options.sampleRate !== undefined) throw domError('NotSupportedError', 'rate');
      this.options = options;
      this.sampleRate = script.realRate ?? options.sampleRate ?? 48000;
      dom.contexts.push(this);
    }
    resume(): Promise<void> {
      this.resumes += 1;
      if (script.neverResumes) return new Promise<void>(() => {});
      this.state = 'running';
      this.onstatechange?.();
      return Promise.resolve();
    }
    close(): Promise<void> {
      this.state = 'closed';
      this.onstatechange?.();
      return script.neverCloses ? new Promise<void>(() => {}) : Promise.resolve();
    }
    /** The system suspends the context (sleep, a change of output device), which it says through `statechange`. */
    suspend(): void {
      this.state = 'suspended';
      this.onstatechange?.();
    }
    createMediaStreamSource(stream: FakeStream): FakeAudioNode {
      assert.ok(dom.streams.includes(stream));
      this.source = new FakeAudioNode('source');
      return this.source;
    }
    createGain(): FakeAudioNode & { gain: { value: number } } {
      this.gain = Object.assign(new FakeAudioNode('gain'), { gain: { value: 1 } });
      return this.gain;
    }
  }

  const mediaDevices = {
    async getUserMedia(constraints: MediaStreamConstraints): Promise<FakeStream> {
      dom.requests.push(constraints);
      const stream = script.getUserMedia ? script.getUserMedia(constraints, dom.requests.length) : new FakeStream();
      dom.streams.push(stream);
      return stream;
    },
  };

  globals.AudioContext = FakeContext;
  globals.AudioWorkletNode = FakeWorkletNode;
  Object.defineProperty(navigator, 'mediaDevices', { value: mediaDevices, configurable: true });
  // A renderer's window is its global object: the timers it is asked for are the ones a test mocks.
  globals.window = globalThis;
  t.after(restoreDom);
  return dom;
}

/** A capture with its callbacks recorded. */
function captureLog() {
  const blocks: number[][] = [];
  const errors: string[] = [];
  return {
    blocks,
    errors,
    opts(deviceId = ''): MicCaptureOptions {
      return {
        deviceId,
        onPcm: (samples) => blocks.push(Array.from(samples)),
        onError: (error) => errors.push(error.message),
      };
    },
  };
}

const DENIED = 'Microphone access was denied. Allow Obsidian in System Settings, Privacy & Security, Microphone.';
const SUSPENDED = 'Audio capture was suspended by the system. Stop the recording and start it again.';

test('capture asks for the chosen device, mono, with no processing', async (t) => {
  const dom = installDom(t);
  const mic = await startMicCapture(captureLog().opts('usb-mic'));
  assert.deepEqual(dom.requests, [
    {
      audio: {
        deviceId: { exact: 'usb-mic' },
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    },
  ]);
  await mic.stop();
});

test('capture leaves the device open to the system when none is chosen', async (t) => {
  const dom = installDom(t);
  const mic = await startMicCapture(captureLog().opts(''));
  assert.equal((dom.requests[0].audio as MediaTrackConstraints).deviceId, undefined);
  await mic.stop();
});

test('capture builds source → worklet → muted gain → destination at 16 kHz', async (t) => {
  const dom = installDom(t);
  const revoke = t.mock.method(URL, 'revokeObjectURL');
  const mic = await startMicCapture(captureLog().opts());

  assert.equal(dom.contexts.length, 1);
  const ctx = dom.contexts[0];
  assert.deepEqual(ctx.options, { sampleRate: 16000, latencyHint: 'interactive' });
  assert.equal(ctx.state, 'running');
  assert.equal(mic.sampleRate, 16000);

  assert.deepEqual(dom.moduleTexts, [WORKLET_SOURCE], 'the worklet is loaded from the file’s own text');
  assert.equal(revoke.mock.callCount(), 1, 'the Blob URL is released');
  assert.match(String(revoke.mock.calls[0].arguments[0]), /^blob:/);

  const worklet = dom.worklets[0];
  assert.equal(worklet.name, 'hamster-pcm');
  assert.deepEqual(worklet.options, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
  });
  assert.deepEqual(ctx.source?.links, [worklet]);
  assert.deepEqual(worklet.links, [ctx.gain]);
  assert.deepEqual(ctx.gain?.links, [ctx.destination]);
  assert.equal(ctx.gain?.gain.value, 0, 'the microphone is never played back');
  await mic.stop();
});

test('capture reports the rate the context really runs at', async (t) => {
  installDom(t, { realRate: 44100 });
  const mic = await startMicCapture(captureLog().opts());
  assert.equal(mic.sampleRate, 44100);
  await mic.stop();
});

test('capture takes whatever rate it gets when 16 kHz is refused', async (t) => {
  const dom = installDom(t, { refuseRate: true });
  const mic = await startMicCapture(captureLog().opts());
  assert.deepEqual(dom.contexts[0].options, { latencyHint: 'interactive' });
  assert.equal(mic.sampleRate, 48000);
  await mic.stop();
});

test('capture delivers the worklet’s blocks and their level', async (t) => {
  const dom = installDom(t);
  const log = captureLog();
  const mic = await startMicCapture(log.opts());
  assert.equal(mic.level(), 0);
  dom.worklets[0].post(Int16Array.from([1, -2, 3]), 0.4);
  assert.deepEqual(log.blocks, [[1, -2, 3]]);
  assert.equal(mic.level(), 0.4);
  dom.worklets[0].post(Int16Array.from([0, 0]), 0);
  assert.equal(mic.level(), 0);
  assert.equal(log.blocks.length, 2);
  await mic.stop();
});

test('capture falls back to the default device when the chosen one is gone', async (t) => {
  for (const name of ['OverconstrainedError', 'NotFoundError']) {
    const dom = installDom(t, {
      getUserMedia(_constraints, call) {
        if (call === 1) throw domError(name);
        return new FakeStream();
      },
    });
    const mic = await startMicCapture(captureLog().opts('unplugged'));
    assert.equal(dom.requests.length, 2, name);
    assert.deepEqual((dom.requests[0].audio as MediaTrackConstraints).deviceId, { exact: 'unplugged' });
    assert.equal((dom.requests[1].audio as MediaTrackConstraints).deviceId, undefined);
    await mic.stop();
  }
});

test('capture retries once only, and not for a refusal', async (t) => {
  const never = installDom(t, {
    getUserMedia() {
      throw domError('NotFoundError', 'Requested device not found');
    },
  });
  await assert.rejects(startMicCapture(captureLog().opts('unplugged')), { message: 'No microphone was found.' });
  assert.equal(never.requests.length, 2);

  const refused = installDom(t, {
    getUserMedia() {
      throw domError('NotAllowedError', 'Permission denied');
    },
  });
  await assert.rejects(startMicCapture(captureLog().opts('usb-mic')), { message: DENIED });
  assert.equal(refused.requests.length, 1);

  const noDefault = installDom(t, {
    getUserMedia() {
      throw domError('NotFoundError');
    },
  });
  await assert.rejects(startMicCapture(captureLog().opts('')), { message: 'No microphone was found.' });
  assert.equal(noDefault.requests.length, 1, 'there is no other device to try');
});

test('capture words its failures for the user', async (t) => {
  const failing = (error: unknown) =>
    installDom(t, {
      getUserMedia() {
        throw error;
      },
    });
  failing(domError('NotAllowedError', 'Permission denied by system'));
  await assert.rejects(startMicCapture(captureLog().opts()), { message: DENIED });

  failing(domError('NotReadableError', 'Could not start audio source'));
  await assert.rejects(startMicCapture(captureLog().opts()), {
    message: 'The microphone could not be started: Could not start audio source',
  });

  // Chromium's OverconstrainedError is a plain object with a name, not an Error.
  failing({ name: 'OverconstrainedError', message: '', constraint: 'deviceId' });
  await assert.rejects(startMicCapture(captureLog().opts()), { message: 'No microphone was found.' });

  failing(domError('AbortError'));
  await assert.rejects(startMicCapture(captureLog().opts()), { message: 'The microphone could not be started: AbortError' });
});

test('capture says so when there is no media-device API', async (t) => {
  installDom(t);
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  await assert.rejects(startMicCapture(captureLog().opts()), { message: 'The microphone is not available here.' });
});

test('capture releases the microphone when the audio graph cannot be built', async (t) => {
  const dom = installDom(t, { addModule: domError('AbortError', 'Unable to load a worklet’s module.') });
  const revoke = t.mock.method(URL, 'revokeObjectURL');
  await assert.rejects(startMicCapture(captureLog().opts()), {
    message: 'The microphone could not be started: Unable to load a worklet’s module.',
  });
  assert.equal(dom.streams[0].track.stops, 1, 'the system’s microphone indicator goes off');
  assert.equal(dom.contexts[0].state, 'closed');
  assert.equal(revoke.mock.callCount(), 1);
});

test('capture gives up on a context that never starts', async (t) => {
  const dom = installDom(t, { neverResumes: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const starting = startMicCapture(captureLog().opts());
  const outcome = assert.rejects(starting, { message: 'Audio capture did not start in time.' });
  await settle();
  assert.equal(dom.contexts.length, 1);
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(dom.streams[0].track.stops, 0, 'still waiting');
  t.mock.timers.tick(1);
  await outcome;
  assert.equal(dom.streams[0].track.stops, 1);
  assert.equal(dom.contexts[0].state, 'closed');
});

test('capture fails the start even when the context will not finish closing', async (t) => {
  const dom = installDom(t, { addModule: domError('AbortError', 'no module'), neverCloses: true });
  await assert.rejects(startMicCapture(captureLog().opts()), { message: 'The microphone could not be started: no module' });
  assert.equal(dom.streams[0].track.stops, 1);
});

test('capture notices a device unplugged while the graph was being built', async (t) => {
  const dom = installDom(t, {
    getUserMedia() {
      // It ended before anything listened for `ended`: only readyState tells.
      const stream = new FakeStream();
      stream.track.readyState = 'ended';
      return stream;
    },
  });
  const log = captureLog();
  await assert.rejects(startMicCapture(log.opts()), { message: 'The microphone was disconnected.' });
  assert.equal(dom.contexts[0].state, 'closed');
  assert.equal(dom.streams[0].track.stops, 1);
  assert.deepEqual(log.errors, [], 'a failed start rejects; it does not also call onError');
});

test('capture reports an unplugged device once and goes quiet', async (t) => {
  const dom = installDom(t);
  const log = captureLog();
  const mic = await startMicCapture(log.opts());
  dom.worklets[0].post(Int16Array.from([5]), 0.7);
  dom.streams[0].track.unplug();
  assert.deepEqual(log.errors, ['The microphone was disconnected.']);
  assert.equal(mic.level(), 0);

  // The dead source still renders silence; none of it is delivered.
  dom.worklets[0].post(Int16Array.from([0]), 0);
  dom.worklets[0].onprocessorerror?.();
  dom.streams[0].track.unplug();
  assert.deepEqual(log.blocks, [[5]]);
  assert.equal(log.errors.length, 1);

  await mic.stop();
  assert.equal(dom.contexts[0].state, 'closed');
});

test('capture reports a worklet that broke', async (t) => {
  const dom = installDom(t);
  const log = captureLog();
  const mic = await startMicCapture(log.opts());
  dom.worklets[0].onprocessorerror?.();
  assert.deepEqual(log.errors, ['Audio capture stopped unexpectedly.']);
  await mic.stop();
});

test('capture resumes a context the system suspended, once, and gives up the second time', async (t) => {
  const dom = installDom(t);
  const log = captureLog();
  const mic = await startMicCapture(log.opts());
  const ctx = dom.contexts[0];
  assert.equal(ctx.resumes, 1);
  dom.worklets[0].post(Int16Array.from([1]), 0.3);

  // Sleep, or a change of output device: the graph stops without a word.
  ctx.suspend();
  await settle();
  assert.equal(ctx.resumes, 2);
  assert.equal(ctx.state, 'running');
  assert.deepEqual(log.errors, []);
  dom.worklets[0].post(Int16Array.from([2]), 0.5);
  assert.deepEqual(log.blocks, [[1], [2]]);
  assert.equal(mic.level(), 0.5);

  ctx.suspend();
  assert.equal(ctx.resumes, 2, 'not tried a second time');
  assert.deepEqual(log.errors, [SUSPENDED]);
  assert.equal(mic.level(), 0, 'the meter does not freeze on the last peak');
  dom.worklets[0].post(Int16Array.from([3]), 0.7);
  assert.deepEqual(log.blocks, [[1], [2]], 'nothing more is delivered');

  await mic.stop();
  assert.equal(ctx.onstatechange, null);
  assert.equal(ctx.state, 'closed');
  assert.equal(log.errors.length, 1, 'closing it is not a suspension');
});

test('capture gives up on a context the system closed, or that will not resume', async (t) => {
  const closing = installDom(t);
  const closedLog = captureLog();
  const closed = await startMicCapture(closedLog.opts());
  closing.contexts[0].state = 'closed';
  closing.contexts[0].onstatechange?.();
  assert.deepEqual(closedLog.errors, [SUSPENDED]);
  await closed.stop();

  const dom = installDom(t);
  type Ctx = (typeof dom.contexts)[number];
  const Real = globals.AudioContext as new (options?: AudioContextOptions) => Ctx;
  globals.AudioContext = class extends Real {
    resume(): Promise<void> {
      // The first resume is the start's; the one after the suspension is refused.
      if (this.resumes > 0) {
        this.resumes += 1;
        return Promise.reject(domError('InvalidStateError', 'Cannot resume a closed AudioContext.'));
      }
      return super.resume();
    }
  };
  const log = captureLog();
  const mic = await startMicCapture(log.opts());
  dom.contexts[0].suspend();
  await settle();
  assert.equal(dom.contexts[0].resumes, 2);
  assert.deepEqual(log.errors, [SUSPENDED]);
  assert.equal(mic.level(), 0);
  await mic.stop();
  assert.equal(log.errors.length, 1);
});

test('capture stop releases everything, once, and silences the callbacks', async (t) => {
  const dom = installDom(t);
  const log = captureLog();
  const mic = await startMicCapture(log.opts());
  const worklet = dom.worklets[0];
  const ctx = dom.contexts[0];
  const { onmessage } = worklet.port;
  dom.worklets[0].post(Int16Array.from([9]), 0.9);

  const first = mic.stop();
  assert.equal(first, mic.stop(), 'the same promise');
  // A block already on its way when the stop began.
  onmessage?.({ data: { pcm: new Int16Array(2).buffer, peak: 1 } });
  await first;

  assert.deepEqual(log.blocks, [[9]]);
  assert.equal(mic.level(), 0);
  assert.equal(dom.streams[0].track.stops, 1);
  assert.equal(ctx.state, 'closed');
  assert.equal(ctx.source?.disconnects, 1);
  assert.equal(worklet.disconnects, 1);
  assert.equal(ctx.gain?.disconnects, 1);
  assert.equal(worklet.port.onmessage, null);

  // Stopping a track by hand fires no `ended`; a real unplug after the stop is nobody's business.
  dom.streams[0].track.unplug();
  assert.deepEqual(log.errors, []);
});

test('capture stop survives parts that throw', async (t) => {
  const dom = installDom(t);
  const mic = await startMicCapture(captureLog().opts());
  const boom = (): never => {
    throw new Error('boom');
  };
  dom.contexts[0].source!.disconnect = boom;
  dom.streams[0].track.stop = boom;
  dom.contexts[0].close = boom;
  await mic.stop();
  assert.equal(dom.worklets[0].disconnects, 1, 'the rest was still released');
});

interface ManualClock extends Clock {
  advance(ms: number): void;
  pending(): number;
}

function manualClock(): ManualClock {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      timers.set(nextId, { at: now + ms, fn, every: null });
      return nextId++;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    setInterval(fn, ms) {
      timers.set(nextId, { at: now + ms, fn, every: ms });
      return nextId++;
    },
    clearInterval(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let dueId = -1;
        let dueAt = Infinity;
        for (const [id, timer] of timers) {
          if (timer.at <= end && timer.at < dueAt) {
            dueId = id;
            dueAt = timer.at;
          }
        }
        if (dueId < 0) break;
        const timer = timers.get(dueId)!;
        now = Math.max(now, timer.at);
        if (timer.every === null) timers.delete(dueId);
        else timer.at += timer.every;
        timer.fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

interface SentFrame {
  source: number;
  payload: Uint8Array;
}

function decodeFrames(chunks: Uint8Array[]): SentFrame[] {
  const sent: SentFrame[] = [];
  const parser = frames.createFrameParser({
    onFrame: (source, payload) => sent.push({ source, payload: Uint8Array.from(payload) }),
    onError: (error) => {
      throw error;
    },
  });
  for (const chunk of chunks) parser.push(chunk);
  return sent;
}

function controlOf(frame: SentFrame): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>;
}

class FakeChild implements WorkerChild {
  written: Uint8Array[] = [];
  stdinEnded = false;
  kills: string[] = [];
  /** When true, kill() ends the child at once, as SIGKILL does. */
  diesWhenKilled = false;

  private readonly log: string[];
  private stdoutListeners: Array<(chunk: Uint8Array | string) => void> = [];
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private errorListeners: Array<(err: Error & { code?: string }) => void> = [];
  private closeListeners: Array<() => void> = [];

  constructor(log: string[]) {
    this.log = log;
  }

  stdin = {
    write: (chunk: Uint8Array): boolean => {
      this.written.push(chunk);
      // The supervisor writes whole frames, one per call.
      for (const frame of decodeFrames([chunk])) {
        this.log.push(frame.source === 255 ? String(controlOf(frame).type) : 'pcm');
      }
      return true;
    },
    end: (): void => {
      this.stdinEnded = true;
    },
  };

  stdout = {
    on: (_event: 'data', cb: (chunk: Uint8Array | string) => void): void => {
      this.stdoutListeners.push(cb);
    },
  };

  stderr = {
    on: (_event: 'data', _cb: (chunk: Uint8Array | string) => void): void => {},
  };

  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', cb: (err: Error & { code?: string }) => void): unknown;
  on(event: 'exit' | 'error', cb: (...args: never[]) => void): unknown {
    if (event === 'exit') this.exitListeners.push(cb as (code: number | null, signal: string | null) => void);
    else this.errorListeners.push(cb as (err: Error & { code?: string }) => void);
    return this;
  }

  once(_event: 'close', cb: () => void): unknown {
    this.closeListeners.push(cb);
    return this;
  }

  kill(signal?: string): boolean {
    this.kills.push(signal ?? 'SIGTERM');
    if (this.diesWhenKilled) this.exit(null, signal ?? 'SIGTERM');
    return true;
  }

  emit(event: Record<string, unknown>): void {
    for (const cb of this.stdoutListeners) cb(`${JSON.stringify(event)}\n`);
  }

  /** The process ends. Its pipes close with it unless the test wants to place that itself. */
  exit(code: number | null, signal: string | null = null, closePipes = true): void {
    for (const cb of this.exitListeners) cb(code, signal);
    if (closePipes) this.close();
  }

  close(): void {
    for (const cb of this.closeListeners.splice(0)) cb();
  }

  /** A spawn that failed: Node reports `error`, then `close`, and no `exit`. */
  fail(code: string): void {
    const error: Error & { code?: string } = new Error(`spawn node ${code}`);
    error.code = code;
    for (const cb of this.errorListeners) cb(error);
    this.close();
  }

  controls(): Array<Record<string, unknown>> {
    return decodeFrames(this.written)
      .filter((frame) => frame.source === 255)
      .map(controlOf);
  }

  audio(): SentFrame[] {
    return decodeFrames(this.written).filter((frame) => frame.source !== 255);
  }
}

/** A microphone the test opens, refuses and unplugs by hand. */
function fakeMicrophone(log: string[]) {
  const requests: MicCaptureOptions[] = [];
  const waiting: Array<{ resolve(mic: MicCapture): void; reject(error: Error): void }> = [];
  const state = { stops: 0, level: 0.25, stuck: false, throws: false };
  return {
    requests,
    state,
    start(opts: MicCaptureOptions): Promise<MicCapture> {
      requests.push(opts);
      return new Promise<MicCapture>((resolve, reject) => waiting.push({ resolve, reject }));
    },
    open(sampleRate = 16000): void {
      waiting.shift()!.resolve({
        sampleRate,
        level: () => state.level,
        stop() {
          state.stops += 1;
          log.push('mic.stop');
          // `throws`: a capture that breaks its promise never to throw.
          if (state.throws) throw new Error('stop threw');
          // `stuck`: a context whose close() never settles.
          return state.stuck ? new Promise<void>(() => {}) : Promise.resolve();
        },
      });
    },
    refuse(error: Error): void {
      waiting.shift()!.reject(error);
    },
  };
}

const READY = { type: 'ready', model: 'fake', chunkMs: 560 };
const BLOCK = Int16Array.from([1, -2, 258]);
const NOT_SET_UP =
  'Speech recognition is not set up. Run the setup command shown in Settings, Magical Hamster, Speech, once, in Terminal.';

interface HarnessOptions {
  runtime?: RuntimeInfo | null;
  local?: Partial<LocalSettings>;
  language?: SttLanguage;
  /** The plugin's version, for the check against the runtime's. Absent, as main.ts without a manifest: no check. */
  pluginVersion?: string;
  exists?(path: string): boolean;
  /** Makes every spawn throw instead of returning a child. */
  spawnError?: Error;
}

function harness(options: HarnessOptions = {}) {
  const clock = manualClock();
  const log: string[] = [];
  const children: FakeChild[] = [];
  const commands: WorkerCommand[] = [];
  const runtimeDirs: string[] = [];
  const mic = fakeMicrophone(log);
  const source = createTranscriptSourceWith({
    clock,
    local: () => ({ ...DEFAULT_LOCAL, runtimeDir: RT, micDeviceId: 'usb-mic', ...options.local }),
    language: () => options.language ?? 'fr-CA',
    pluginVersion: options.pluginVersion,
    readRuntime(dir) {
      runtimeDirs.push(dir);
      return options.runtime === undefined ? INFO : options.runtime;
    },
    baseEnv: () => ({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' }),
    spawn(command) {
      commands.push(command);
      if (options.spawnError) throw options.spawnError;
      const child = new FakeChild(log);
      children.push(child);
      return child;
    },
    exists: options.exists ?? (() => true),
    startMic: mic.start,
  });
  const events: SttEvent[] = [];
  const states: Array<[SttState, string | undefined]> = [];
  source.onEvent((event) => events.push(event));
  source.onState((state, message) => states.push([state, message]));
  const child = () => children[children.length - 1];
  return {
    clock,
    log,
    children,
    commands,
    runtimeDirs,
    mic,
    source,
    events,
    states,
    child,
    stateNames: () => states.map(([state]) => state),
    lastMessage: () => states[states.length - 1]?.[1],
    /** Sends a block as the microphone would. */
    pcm(samples = BLOCK): void {
      mic.requests[mic.requests.length - 1].onPcm(samples);
    },
  };
}

/** A source that is recording: worker ready, microphone open, hello sent. */
async function recording(options: HarnessOptions = {}, sampleRate = 16000) {
  const t = harness(options);
  const started = t.source.start();
  t.child().emit(READY);
  await settle();
  t.mic.open(sampleRate);
  await started;
  return t;
}

test('source: without a runtime it says how to install one and starts nothing', async () => {
  const t = harness({ runtime: null });
  assert.equal(t.source.state(), 'idle');
  await assert.rejects(t.source.start(), { message: NOT_SET_UP });
  assert.equal(t.source.state(), 'not-installed');
  assert.deepEqual(t.states, [['not-installed', NOT_SET_UP]]);
  assert.equal(t.children.length, 0);
  assert.equal(t.mic.requests.length, 0);
  assert.deepEqual(t.runtimeDirs, [RT]);

  await t.source.stop();
  assert.equal(t.source.state(), 'not-installed', 'the reason outlives the stop');
  assert.equal(t.clock.pending(), 0);
});

test('source: looks in the default directory when none is set', async () => {
  const t = harness({ runtime: null, local: { runtimeDir: '  ' } });
  await assert.rejects(t.source.start());
  assert.deepEqual(t.runtimeDirs, [defaultRuntimeDir()]);
});

test('a runtime folder that starts with ~ is one place for the runtime, the stats and the speech source', async () => {
  // A home directory of this test's own, with the runtime installed in it.
  const home = tempDir();
  const installed = join(home, 'hamster');
  mkdirSync(installed);
  writeFileSync(join(installed, 'runtime.json'), JSON.stringify({ ...RECORD, runtimeDir: installed, modelDir: 'models/m' }));
  writeFileSync(join(installed, 'worker.cjs'), '');

  // What main.ts builds: one function for the folder, and a `local()` that hands it to the source.
  const stored: LocalSettings = { ...DEFAULT_LOCAL, runtimeDir: '~/hamster' };
  const runtimeDir = (): string => resolveRuntimeDir(stored.runtimeDir, home);
  const local = (): LocalSettings => ({ ...stored, runtimeDir: runtimeDir() });

  assert.equal(readRuntime(stored.runtimeDir), null, 'taken as written, the folder is not where the runtime is');
  assert.equal(readRuntime(runtimeDir())?.runtimeDir, installed);

  const stats = { input: 1, output: 2, cached: 0, weekly: {}, meetings: 1, assists: 0 };
  await createStatsIO(runtimeDir).save(stats);
  assert.deepEqual(JSON.parse(readFileSync(join(installed, 'stats.json'), 'utf8')), stats);

  const asked: string[] = [];
  const source = createTranscriptSourceWith({
    clock: manualClock(),
    local,
    language: () => 'auto',
    readRuntime(dir) {
      asked.push(dir);
      return null;
    },
    baseEnv: () => ({}),
    spawn: () => {
      throw new Error('nothing is installed: nothing to run');
    },
    exists: () => true,
    startMic: () => Promise.reject(new Error('no microphone is opened without a runtime')),
  });
  await assert.rejects(source.start());
  assert.deepEqual(asked, [installed]);
  assert.equal(stored.runtimeDir, '~/hamster', 'the setting itself stays as typed');
  assert.equal(existsSync(join(process.cwd(), '~')), false, 'and no folder named ~ was made here');
});

test('source: starts the worker, then the microphone, then announces it', async () => {
  const t = harness({ local: { nodePath: '/usr/local/bin/node' } });
  const started = t.source.start();
  assert.equal(t.source.state(), 'spawning');
  assert.equal(t.children.length, 1);
  assert.deepEqual(t.commands[0], {
    command: '/usr/local/bin/node',
    args: [`${RT}/worker.cjs`, '--model', INFO.modelDir, '--lang', 'fr-CA'],
    env: { PATH: '/usr/bin', DYLD_LIBRARY_PATH: `${RT}/node_modules/sherpa-onnx-darwin-arm64` },
    cwd: RT,
  });
  await settle();
  assert.equal(t.mic.requests.length, 0, 'no microphone before the worker is ready');

  t.child().emit(READY);
  await settle();
  assert.equal(t.mic.requests.length, 1);
  assert.equal(t.mic.requests[0].deviceId, 'usb-mic');
  assert.equal(t.source.level(), 0, 'not capturing yet');

  // A block that comes before the hello has no sample rate to be read at.
  t.pcm();
  assert.deepEqual(t.child().written, []);

  t.mic.open(48000);
  await started;
  assert.equal(t.source.state(), 'ready');
  assert.deepEqual(t.child().controls(), [{ type: 'hello', source: 'mic', sampleRate: 48000 }]);
  assert.equal(t.source.level(), 0.25);

  t.pcm();
  assert.equal(t.source.state(), 'running');
  const audio = t.child().audio();
  assert.equal(audio.length, 1);
  assert.equal(audio[0].source, 0);
  assert.deepEqual(Array.from(audio[0].payload), [1, 0, 0xfe, 0xff, 2, 1], '16-bit little-endian');

  assert.deepEqual(t.events, [READY]);
  assert.deepEqual(t.stateNames(), ['spawning', 'ready', 'running']);
  assert.deepEqual(t.log, ['hello', 'pcm']);
});

test('source: a runtime set up by another plugin version is said once, before the worker starts, and still records', async () => {
  const t = harness({ runtime: { ...INFO, workerVersion: '0.1.4' }, pluginVersion: '0.2.0' });
  const started = t.source.start();
  const outdated = {
    type: 'error',
    code: 'worker_outdated',
    message:
      'The speech runtime was set up by plugin version 0.1.4; this is 0.2.0. Run the speech setup command again (Settings, Magical Hamster, Speech).',
  };
  assert.deepEqual(t.events, [outdated], 'heard before anything the worker says');
  assert.equal(t.children.length, 1, 'the worker there is still runs');

  t.child().emit(READY);
  await settle();
  t.mic.open();
  await started;
  assert.equal(t.source.state(), 'ready');
  assert.deepEqual(t.events, [outdated, READY]);
  assert.deepEqual(t.child().controls(), [{ type: 'hello', source: 'mic', sampleRate: 16000 }]);
});

test('source: a runtime that recorded no version is from before, and the words say so', async () => {
  const t = harness({ runtime: { ...INFO, workerVersion: null }, pluginVersion: '0.1.5' });
  void t.source.start().catch(() => undefined);
  assert.equal(t.events.length, 1);
  assert.match(
    (t.events[0] as { message?: string }).message ?? '',
    /^The speech runtime was set up by an earlier plugin version; this is 0\.1\.5\. Run the speech setup command again/,
  );
});

test('source: a runtime of the same major.minor, or a plugin without a version, says nothing about it', async () => {
  const same = harness({ runtime: { ...INFO, workerVersion: '0.1.9' }, pluginVersion: '0.1.5' });
  void same.source.start().catch(() => undefined);
  assert.deepEqual(same.events, []);

  const unknown = harness({ runtime: { ...INFO, workerVersion: null } });
  void unknown.source.start().catch(() => undefined);
  assert.deepEqual(unknown.events, [], 'nothing to compare with');
});

test('source: start is one-shot', async () => {
  const t = harness();
  const first = t.source.start();
  assert.equal(t.source.start(), first);
  t.child().emit(READY);
  await settle();
  t.mic.open();
  await first;
  assert.equal(t.source.start(), first);
  assert.equal(t.children.length, 1);
  assert.equal(t.mic.requests.length, 1);
});

test('source: passes on transcript events and states to every subscriber', async () => {
  const t = await recording();
  const seen: SttEvent[] = [];
  const seenStates: SttState[] = [];
  const offEvent = t.source.onEvent((event) => seen.push(event));
  const offState = t.source.onState((state) => seenStates.push(state));

  const partial = { type: 'segment', source: 'mic', t0: 0.5, t1: 1.2, text: 'on se revoit', isFinal: false, lang: 'fr', langSource: 'heuristic' };
  t.child().emit(partial);
  t.pcm();
  assert.deepEqual(seen, [partial]);
  assert.deepEqual(seenStates, ['running']);

  offEvent();
  offState();
  offEvent();
  t.child().emit({ type: 'stats', rtf: 0.1, backlogMs: 0 });
  assert.equal(seen.length, 1);
  assert.equal(t.events.length, 3, 'the other subscriber still hears everything');
});

test('source: each subscription stands on its own', async () => {
  const t = await recording();
  let calls = 0;
  const count = () => {
    calls += 1;
  };
  const offFirst = t.source.onEvent(count);
  t.source.onEvent(count);
  t.child().emit({ type: 'stats', rtf: 0.1, backlogMs: 0 });
  assert.equal(calls, 2);
  offFirst();
  offFirst();
  t.child().emit({ type: 'stats', rtf: 0.1, backlogMs: 0 });
  assert.equal(calls, 3, 'the second subscription is still there');
});

test('source: a listener that throws costs nobody else', async (context) => {
  const logged = context.mock.method(console, 'error', () => {});
  const t = harness();
  const heard: string[] = [];
  t.source.onEvent(() => {
    throw new Error('bad listener');
  });
  t.source.onEvent((event) => heard.push(event.type));
  t.source.onState(() => {
    throw new Error('bad listener');
  });
  const started = t.source.start();
  t.child().emit(READY);
  await settle();
  t.mic.open();
  await started;
  assert.deepEqual(heard, ['ready']);
  assert.equal(t.source.state(), 'ready');
  assert.ok(logged.mock.callCount() >= 2);
});

test('source: a worker that is not installed never opens the microphone', async () => {
  const t = harness();
  const started = t.source.start();
  t.child().emit({ type: 'error', code: 'model_missing', message: 'The speech model is missing or incomplete in /m' });
  t.child().exit(2);
  await assert.rejects(started, /^Error: The speech model is not installed\. Run the speech setup again/);
  assert.equal(t.source.state(), 'not-installed');
  assert.match(t.lastMessage() ?? '', /The speech model is missing or incomplete in \/m/);
  assert.equal(t.mic.requests.length, 0);
  assert.equal(t.children.length, 1, 'and it is not restarted');
  assert.equal(t.clock.pending(), 0);
});

test('source: a worker that fails to start never opens the microphone', async () => {
  const t = harness();
  const started = t.source.start();
  t.child().exit(1);
  await assert.rejects(started, /The speech worker stopped while starting \(exit code 1\)/);
  assert.equal(t.source.state(), 'failed');
  assert.equal(t.mic.requests.length, 0);
});

test('source: a missing Node is named by the path that was tried', async () => {
  const t = harness({ local: { nodePath: '/opt/homebrew/bin/node' }, exists: () => false });
  const started = t.source.start();
  t.child().fail('ENOENT');
  const message = 'Node was not found at /opt/homebrew/bin/node. Set the path to Node in the plugin settings.';
  await assert.rejects(started, { message });
  assert.deepEqual(t.states.at(-1), ['not-installed', message]);
  assert.equal(t.mic.requests.length, 0);
});

test('source: names the installer’s Node when the setting is empty', async () => {
  const t = harness({ local: { nodePath: '' }, runtime: { ...INFO, node: '/gone/node' }, exists: (path) => path !== '/gone/node' });
  const started = t.source.start();
  t.child().fail('ENOENT');
  await assert.rejects(started, /Node was not found at \/gone\/node\./);
});

test('source: with the settings as they come, the worker runs with the Node the setup recorded', async () => {
  assert.equal(DEFAULT_LOCAL.nodePath, '');
  const recorded = '/Users/someone/.local/node-24/bin/node';
  const t = harness({ runtime: { ...INFO, node: recorded }, exists: (path) => path !== recorded });
  const started = t.source.start();
  assert.equal(t.commands[0].command, recorded);
  // And when that Node is gone, it is the one the message names: no other path was tried.
  t.child().fail('ENOENT');
  await assert.rejects(started, { message: `Node was not found at ${recorded}. Set the path to Node in the plugin settings.` });
});

test('source: keeps the supervisor’s words when Node is there after all', async () => {
  // ENOENT is also what a vanished working directory looks like.
  const t = harness({ exists: () => true });
  const started = t.source.start();
  t.child().fail('ENOENT');
  await assert.rejects(started, { message: 'Node was not found. Set the path to Node in the plugin settings.' });
  assert.equal(t.source.state(), 'not-installed');
});

test('source: a microphone that fails takes the worker down with it', async () => {
  const t = harness();
  const started = t.source.start();
  t.child().emit(READY);
  await settle();
  t.mic.refuse(new Error(DENIED));
  await settle();

  assert.deepEqual(t.child().controls(), [{ type: 'bye' }], 'no hello, straight to bye');
  assert.equal(t.child().stdinEnded, true);
  assert.equal(t.source.state(), 'stopping');
  t.child().exit(0);

  await assert.rejects(started, { message: DENIED });
  assert.equal(t.source.state(), 'exited');
  assert.deepEqual(t.stateNames(), ['spawning', 'ready', 'stopping', 'exited']);
  assert.equal(t.source.level(), 0);
  assert.equal(t.clock.pending(), 0);
});

test('source: a worker that ignores the bye is killed, also on the failure path', async () => {
  const t = harness();
  const started = t.source.start();
  t.child().emit(READY);
  await settle();
  t.child().diesWhenKilled = true;
  t.mic.refuse(new Error('No microphone was found.'));
  await settle();
  assert.deepEqual(t.child().kills, []);
  t.clock.advance(2000);
  assert.deepEqual(t.child().kills, ['SIGKILL']);
  await assert.rejects(started, { message: 'No microphone was found.' });
  assert.equal(t.source.state(), 'exited');
});

test('source: stop closes the microphone first, then flushes and says bye', async () => {
  const t = await recording();
  t.pcm();
  t.log.length = 0;

  const stopped = t.source.stop();
  assert.equal(t.source.stop(), stopped, 'the same promise');
  assert.equal(t.source.level(), 0);
  // A block that was already on its way is not sent after the flush.
  t.pcm();
  await settle();
  assert.deepEqual(t.log, ['mic.stop', 'flush', 'bye']);
  assert.equal(t.child().stdinEnded, true);
  assert.equal(t.source.state(), 'stopping');

  t.child().exit(0);
  await stopped;
  assert.equal(t.source.state(), 'exited');
  assert.equal(t.mic.state.stops, 1);
  assert.deepEqual(t.stateNames(), ['spawning', 'ready', 'running', 'stopping', 'exited']);
  assert.equal(t.clock.pending(), 0);

  await t.source.stop();
  assert.equal(t.mic.state.stops, 1);
});

test('source: stop resolves only once the last finals have been read', async () => {
  const t = await recording();
  t.pcm();
  let resolved = false;
  const stopped = t.source.stop().then(() => {
    resolved = true;
  });
  await settle();

  // The process is gone, but its last line is still in the pipe.
  t.child().exit(0, null, false);
  await settle();
  assert.equal(resolved, false, 'exit alone is too early');

  const final = { type: 'segment', source: 'mic', t0: 1, t1: 2.5, text: 'à jeudi', isFinal: true };
  t.child().emit(final);
  t.child().close();
  await stopped;
  assert.deepEqual(t.events.at(-1), final);
  assert.equal(t.source.state(), 'exited');
});

test('source: pipes that never close do not hold the stop', async () => {
  const t = await recording();
  let resolved = false;
  const stopped = t.source.stop().then(() => {
    resolved = true;
  });
  await settle();
  t.child().exit(0, null, false);
  await settle();
  t.clock.advance(999);
  await settle();
  assert.equal(resolved, false);
  t.clock.advance(1);
  await stopped;
  assert.equal(t.clock.pending(), 0);
});

test('source: stop kills a worker that does not leave', async () => {
  const t = await recording();
  t.child().diesWhenKilled = true;
  const stopped = t.source.stop();
  await settle();
  t.clock.advance(1999);
  assert.deepEqual(t.child().kills, []);
  t.clock.advance(1);
  assert.deepEqual(t.child().kills, ['SIGKILL']);
  await stopped;
  assert.equal(t.source.state(), 'exited');
});

test('source: a microphone that will not finish closing does not keep the worker running', async () => {
  const t = await recording();
  t.pcm();
  t.log.length = 0;
  t.mic.state.stuck = true;
  let resolved = false;
  const stopped = t.source.stop().then(() => {
    resolved = true;
  });
  await settle();
  assert.deepEqual(t.log, ['mic.stop'], 'waiting for the microphone');
  t.clock.advance(1000);
  await settle();
  assert.deepEqual(t.log, ['mic.stop', 'flush', 'bye']);
  t.child().exit(0);
  await stopped;
  assert.equal(resolved, true);
  assert.equal(t.source.state(), 'exited');
  assert.equal(t.clock.pending(), 0);
});

test('source: stop before start leaves nothing to start', async () => {
  const t = harness();
  await t.source.stop();
  assert.equal(t.source.state(), 'exited');
  await assert.rejects(t.source.start(), { message: 'The recording was stopped before it started.' });
  assert.equal(t.children.length, 0);
  assert.equal(t.mic.requests.length, 0);
});

test('source: stop while the worker is starting', async () => {
  const t = harness();
  const started = t.source.start();
  const stopped = t.source.stop();
  await settle();
  assert.deepEqual(t.child().controls(), [{ type: 'bye' }]);
  t.child().exit(0);
  await stopped;
  await assert.rejects(started, /stopped before it was ready/);
  assert.equal(t.source.state(), 'exited');
  assert.equal(t.mic.requests.length, 0);
});

test('source: stop while the microphone is still opening closes it when it arrives', async () => {
  const t = harness();
  const started = t.source.start();
  t.child().emit(READY);
  await settle();
  assert.equal(t.mic.requests.length, 1);

  // The permission prompt is up: the stop must not wait for an answer.
  const stopped = t.source.stop();
  await settle();
  t.child().exit(0);
  await stopped;
  assert.equal(t.source.state(), 'exited');
  assert.equal(t.mic.state.stops, 0);

  t.mic.open();
  await assert.rejects(started, { message: 'The recording was stopped before it started.' });
  assert.equal(t.mic.state.stops, 1);
  assert.equal(t.source.level(), 0);
  assert.deepEqual(t.child().controls(), [{ type: 'flush' }, { type: 'bye' }], 'the worker never heard of this microphone');
});

test('source: a microphone lost mid-recording ends the transcript, says why, and keeps what was said', async () => {
  const t = await recording();
  t.pcm();
  t.log.length = 0;

  t.mic.requests[0].onError(new Error('The microphone was disconnected.'));
  const message = 'The microphone was disconnected. Stop the recording and start it again to continue the transcript.';
  // An error event would go unseen: `failed` is the state the sidebar explains while the recording goes on.
  assert.deepEqual(t.states.at(-1), ['failed', message]);
  assert.equal(t.source.level(), 0);
  await settle();
  assert.deepEqual(t.log, ['mic.stop', 'flush', 'bye'], 'the open utterance is closed and the worker sent home');
  assert.equal(t.child().stdinEnded, true);

  t.pcm();
  t.mic.requests[0].onError(new Error('again'));
  assert.deepEqual(t.log, ['mic.stop', 'flush', 'bye'], 'nothing more from a microphone that is gone');

  // The worker's last final still comes through; its own way out is not news.
  const final = { type: 'segment', source: 'mic', t0: 1, t1: 2.5, text: 'à jeudi', isFinal: true };
  t.child().emit(final);
  t.child().exit(0);
  await settle();
  assert.deepEqual(t.events.at(-1), final);
  assert.deepEqual(t.stateNames(), ['spawning', 'ready', 'running', 'failed']);
  assert.equal(t.clock.pending(), 0);

  await t.source.stop();
  assert.deepEqual(t.states.at(-1), ['failed', message], 'the reason outlives the stop');
  assert.equal(t.mic.state.stops, 1, 'closed once');
  assert.equal(t.children.length, 1, 'and nothing was restarted');
});

test('source: a worker that will not leave after the microphone is lost is killed', async () => {
  const t = await recording();
  t.pcm();
  t.child().diesWhenKilled = true;
  t.mic.requests[0].onError(new Error('The microphone was disconnected.'));
  await settle();
  assert.deepEqual(t.child().kills, []);
  t.clock.advance(2000);
  assert.deepEqual(t.child().kills, ['SIGKILL']);
  await settle();
  assert.equal(t.source.state(), 'failed');
  assert.equal(t.clock.pending(), 0);
});

test('source: a microphone lost while the worker restarts leaves no restart behind', async () => {
  const t = await recording();
  t.pcm();
  t.child().exit(1);
  assert.equal(t.source.state(), 'crashed');
  t.mic.requests[0].onError(new Error('The microphone was disconnected.'));
  await settle();
  assert.equal(t.source.state(), 'failed');
  t.clock.advance(60_000);
  assert.equal(t.children.length, 1);
  assert.equal(t.clock.pending(), 0);
  await t.source.stop();
  assert.equal(t.mic.state.stops, 1);
});

test('source: carries on through a worker restart with the same microphone', async () => {
  const t = await recording({}, 48000);
  t.pcm();
  t.child().exit(1);
  assert.equal(t.source.state(), 'crashed');
  assert.equal(t.source.level(), 0.25, 'still listening');
  t.pcm();

  t.clock.advance(1000);
  assert.equal(t.children.length, 2);
  assert.deepEqual(t.commands[1], t.commands[0]);
  t.child().emit(READY);
  assert.deepEqual(t.child().controls(), [{ type: 'hello', source: 'mic', sampleRate: 48000 }]);
  t.pcm();
  assert.equal(t.child().audio().length, 1);
  assert.equal(t.source.state(), 'running');
  assert.equal(t.mic.requests.length, 1);
  assert.equal(t.mic.state.stops, 0);

  const stopped = t.source.stop();
  await settle();
  t.child().exit(0);
  await stopped;
});

test('source: stops listening when the worker is lost for good', async () => {
  const t = await recording();
  for (const backoff of [1000, 2000, 4000]) {
    t.pcm();
    t.child().exit(1);
    assert.equal(t.source.state(), 'crashed');
    t.clock.advance(backoff);
    t.child().emit(READY);
  }
  assert.equal(t.children.length, 4);
  assert.equal(t.mic.state.stops, 0);

  t.pcm();
  t.child().exit(1);
  assert.equal(t.source.state(), 'failed');
  assert.equal(t.lastMessage(), 'Transcription stopped after repeated crashes.');
  assert.equal(t.mic.state.stops, 1, 'no reason to keep the microphone open');
  assert.equal(t.source.level(), 0);

  await t.source.stop();
  assert.equal(t.source.state(), 'failed');
  assert.equal(t.mic.state.stops, 1);
  assert.equal(t.clock.pending(), 0);
});

test('source: a worker lost while the microphone was opening fails the start', async () => {
  const t = harness();
  const started = t.source.start();
  t.child().emit(READY);
  await settle();
  // The permission prompt stays up while the worker crashes its way out.
  for (const backoff of [1000, 2000, 4000]) {
    t.child().exit(1);
    t.clock.advance(backoff);
    t.child().emit(READY);
  }
  t.child().exit(1);
  assert.equal(t.source.state(), 'failed');

  t.mic.open();
  await assert.rejects(started, { message: 'Transcription stopped after repeated crashes.' });
  assert.equal(t.mic.state.stops, 1);
  assert.equal(t.source.state(), 'failed');
});

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/** A runtime directory with the real worker scripts and a record, but no model and no speech library. */
function runtimeFixture(): string {
  const dir = tempDir();
  for (const name of readdirSync(join(REPO, 'stt'))) {
    if (name.endsWith('.cjs')) copyFileSync(join(REPO, 'stt', name), join(dir, name));
  }
  writeFileSync(
    join(dir, 'runtime.json'),
    JSON.stringify({ node: process.execPath, runtimeDir: dir, model: 'no-model', modelDir: 'models/no-model', chunkMs: 560 }),
  );
  return dir;
}

function tone(rate: number, seconds: number): Int16Array {
  const out = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3 * 32767);
  return out;
}

function gone(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Waits for the source to ask for the microphone; a start that fails first ends the wait with its error. */
async function microphoneRequested(mic: { requests: unknown[] }, started: Promise<void>): Promise<void> {
  let failure: unknown = null;
  started.catch((error: unknown) => {
    failure = error ?? new Error('start() rejected');
  });
  const deadline = Date.now() + 10_000;
  while (mic.requests.length === 0) {
    if (failure) throw failure;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the worker to be ready');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('source: records through the real worker, and the stop brings back the last final', async () => {
  const dir = runtimeFixture();
  const children: ChildProcess[] = [];
  const mic = fakeMicrophone([]);
  const source = createTranscriptSourceWith({
    clock: realClock,
    local: () => ({ ...DEFAULT_LOCAL, nodePath: process.execPath, runtimeDir: dir }),
    language: () => 'fr-CA',
    readRuntime,
    baseEnv: () => process.env,
    // The command the plugin builds, plus the worker's test recognizer in place of the model.
    spawn(command) {
      const child = spawn(command.command, [...command.args, '--fake'], {
        env: command.env,
        cwd: command.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.push(child);
      spawned.push(child);
      return child;
    },
    exists: existsSync,
    startMic: mic.start,
  });
  const events: SttEvent[] = [];
  source.onEvent((event) => events.push(event));

  const started = source.start();
  await microphoneRequested(mic, started);
  mic.open(16000);
  await started;
  assert.deepEqual(events, [{ type: 'ready', model: 'fake', chunkMs: 100 }]);

  // 0.3 s of silence, then half a second of voice that is still going when the stop comes.
  const audio = new Int16Array(4800 + 8000);
  audio.set(tone(16000, 0.5), 4800);
  for (let offset = 0; offset < audio.length; offset += 1600) mic.requests[0].onPcm(audio.subarray(offset, offset + 1600));
  assert.equal(source.state(), 'running');

  await source.stop();
  // No waiting here: whatever the worker said is in hand when stop() resolves.
  const finals = events.filter((event) => event.type === 'segment' && event.isFinal);
  assert.deepEqual(
    finals.map((event) => (event.type === 'segment' ? [event.source, event.text, event.t0] : null)),
    [['mic', 'speech 0.5s', 0.3]],
  );
  assert.equal(source.state(), 'exited');
  assert.equal(mic.state.stops, 1);
  assert.equal(children.length, 1);
  assert.equal(children[0].exitCode, 0, 'the worker left on its own');
});

test('source: a real worker is not left behind when the microphone fails', async () => {
  const dir = runtimeFixture();
  const children: ChildProcess[] = [];
  const mic = fakeMicrophone([]);
  const source = createTranscriptSourceWith({
    clock: realClock,
    local: () => ({ ...DEFAULT_LOCAL, nodePath: process.execPath, runtimeDir: dir }),
    language: () => 'auto',
    readRuntime,
    baseEnv: () => process.env,
    spawn(command) {
      const child = spawn(command.command, [...command.args, '--fake'], {
        env: command.env,
        cwd: command.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.push(child);
      spawned.push(child);
      return child;
    },
    exists: existsSync,
    startMic: mic.start,
  });
  const started = source.start();
  await microphoneRequested(mic, started);
  assert.equal(gone(children[0]), false);
  mic.refuse(new Error(DENIED));
  await assert.rejects(started, { message: DENIED });
  assert.equal(gone(children[0]), true);
  assert.equal(children[0].exitCode, 0);
  assert.equal(source.state(), 'exited');
});

test('plugin source: an installed runtime without its model reports not installed', async () => {
  const dir = runtimeFixture();
  const source = createNodeTranscriptSource({
    clock: realClock,
    local: () => ({ ...DEFAULT_LOCAL, nodePath: process.execPath, runtimeDir: dir }),
    language: () => 'fr-CA',
  });
  const states: Array<[SttState, string | undefined]> = [];
  source.onState((state, message) => states.push([state, message]));
  // Had the worker started, the next step would be a microphone this process does not have.
  await assert.rejects(source.start(), /^Error: The speech model is not installed\. Run the speech setup again: the command is in Settings, Magical Hamster, Speech\./);
  assert.equal(source.state(), 'not-installed');
  assert.match(states.at(-1)?.[1] ?? '', /models\/no-model/, 'the worker names the directory it looked in');
  await source.stop();
  assert.equal(source.state(), 'not-installed');
});

test('plugin source: a Node path that does not exist is named', async () => {
  const dir = runtimeFixture();
  const nodePath = join(dir, 'no-such-node');
  const source = createNodeTranscriptSource({
    clock: realClock,
    local: () => ({ ...DEFAULT_LOCAL, nodePath, runtimeDir: dir }),
    language: () => 'auto',
  });
  const message = `Node was not found at ${nodePath}. Set the path to Node in the plugin settings.`;
  await assert.rejects(source.start(), { message });
  assert.equal(source.state(), 'not-installed');
  await source.stop();
});

test('plugin source: an empty runtime directory is "not set up"', async () => {
  const dir = tempDir();
  const source = createNodeTranscriptSource({
    clock: realClock,
    local: () => ({ ...DEFAULT_LOCAL, runtimeDir: dir }),
    language: () => 'auto',
  });
  await assert.rejects(source.start(), { message: NOT_SET_UP });
  assert.equal(source.state(), 'not-installed');
  assert.equal(source.level(), 0);
  await source.stop();
});

/* Review additions. The pieces are checked against each other and against the
   scripts they must agree with (the worker's argument parser, the installer's
   record), real processes are counted after every way out, and a caller's
   mistakes (a re-entrant start, a microphone that throws) leave nothing open. */

const workerScript = require('../stt/worker.cjs') as {
  parseArgs(argv: string[]): { model: string; lang: string; selfTest: string[] | null; fake: boolean };
};

test('workerCommand: the worker reads the arguments as they were meant', () => {
  for (const language of ['auto', 'fr-CA', 'fr-FR', 'en-US']) {
    const command = workerCommand(INFO, { nodePath: '', language, baseEnv: {} });
    // Node takes the first argument as the script and hands it the rest.
    assert.equal(command.args[0], `${RT}/worker.cjs`);
    const parsed = workerScript.parseArgs(command.args.slice(1));
    assert.equal(parsed.model, INFO.modelDir);
    assert.equal(parsed.lang, language);
    assert.equal(parsed.fake, false);
    assert.equal(parsed.selfTest, null);
  }
});

test(
  'parseRuntime reads the record scripts/setup-stt.mjs writes, and workerCommand repeats its self-test',
  { skip: process.platform === 'darwin' && process.arch === 'arm64' ? false : 'setup:stt runs on Apple Silicon only' },
  () => {
    const dir = join(tempDir(), 'runtime');
    // A dry run prints the record it would write and touches neither the disk nor the network.
    const run = spawnSync(process.execPath, [join(REPO, 'scripts', 'setup-stt.mjs'), '--dry-run', '--runtime', dir], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(dir), false);

    const lines = run.stdout.split('\n').map((line) => line.trim());
    const from = lines.findIndex((line) => line.endsWith('runtime.json:'));
    const to = lines.indexOf('}', from);
    assert.ok(from >= 0 && to > from, run.stdout);
    const record = JSON.parse(lines.slice(from + 1, to + 1).join('\n')) as Record<string, unknown>;

    const info = parseRuntime(record, dir);
    assert.ok(info, 'the installer’s own record must be usable');
    assert.equal(info.runtimeDir, dir);
    assert.equal(info.node, record.node);
    assert.equal(info.model, record.model);
    assert.equal(info.modelDir, join(dir, 'models', info.model));
    assert.equal(info.chunkMs, 560);

    // "The same command line and environment the plugin uses", says the installer of its self-test.
    const selfTest = /DYLD_LIBRARY_PATH="([^"]+)" "([^"]+)" "([^"]+)" --model "([^"]+)"/.exec(run.stdout);
    assert.ok(selfTest, run.stdout);
    const command = workerCommand(info, { nodePath: '', language: 'auto', baseEnv: {} });
    assert.equal(command.env.DYLD_LIBRARY_PATH, selfTest[1]);
    assert.equal(command.command, selfTest[2]);
    assert.deepEqual(command.args.slice(0, 3), [selfTest[3], '--model', selfTest[4]]);
  },
);

test('the worklet evaluates as a module, the way addModule loads it', async () => {
  // Module code is strict and has no `this` at the top level; a function body, as in loadWorklet, is neither.
  const names = ['AudioWorkletProcessor', 'registerProcessor', 'sampleRate'];
  const before = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const registered: string[] = [];
  globals.AudioWorkletProcessor = class {};
  globals.registerProcessor = (name: string): void => {
    registered.push(name);
  };
  globals.sampleRate = 16000;
  try {
    await import(`data:text/javascript;base64,${Buffer.from(WORKLET_SOURCE).toString('base64')}`);
  } finally {
    names.forEach((name, i) => {
      const descriptor = before[i];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globals[name];
    });
  }
  assert.deepEqual(registered, ['hamster-pcm']);
});

test('source: a worker that ran is not reported as a missing Node', async () => {
  // `node` was found through the PATH: no file of that name exists, yet it started and spoke.
  const t = harness({ local: { nodePath: 'node' }, exists: () => false });
  const started = t.source.start();
  t.child().emit({ type: 'error', code: 'model_missing', message: 'The speech model is missing or incomplete in /m' });
  t.child().exit(2);
  await assert.rejects(started, /^Error: The speech model is not installed\./);
  assert.match(t.lastMessage() ?? '', /^The speech model is not installed\./);
  for (const [, message] of t.states) assert.doesNotMatch(message ?? '', /Node was not found/);

  // The same name, not found at all, is still named.
  const missing = harness({ local: { nodePath: 'node' }, exists: () => false });
  const failed = missing.source.start();
  missing.child().fail('ENOENT');
  await assert.rejects(failed, { message: 'Node was not found at node. Set the path to Node in the plugin settings.' });
});

test('source: a Node that disappears between two restarts is named', async () => {
  let there = true;
  const t = await recording({ exists: () => there });
  t.pcm();
  t.child().exit(1);
  there = false;
  t.clock.advance(1000);
  assert.equal(t.children.length, 2);
  t.child().fail('ENOENT');
  // No Node path is set: the one that disappeared is the one the setup recorded.
  assert.deepEqual(t.states.at(-1), [
    'not-installed',
    `Node was not found at ${INFO.node}. Set the path to Node in the plugin settings.`,
  ]);
  assert.equal(t.mic.state.stops, 1);
  await t.source.stop();
  assert.equal(t.clock.pending(), 0);
});

test('source: a spawn that throws fails the start with nothing opened', async () => {
  const t = harness({ spawnError: new Error('spawn EACCES') });
  await assert.rejects(t.source.start(), /The speech worker could not be started: spawn EACCES/);
  assert.equal(t.source.state(), 'failed');
  assert.equal(t.children.length, 0);
  assert.equal(t.mic.requests.length, 0);
  await t.source.stop();
  assert.equal(t.source.state(), 'failed');
  assert.equal(t.clock.pending(), 0);
});

test('source: start called again from a state listener does not start a second worker', async () => {
  const t = harness();
  const nested: Array<Promise<void>> = [];
  t.source.onState((state) => {
    if (state === 'spawning' && nested.length === 0) nested.push(t.source.start());
  });
  const started = t.source.start();
  assert.equal(nested.length, 1);
  assert.equal(nested[0], started, 'the one start');
  assert.equal(t.children.length, 1);

  t.child().emit(READY);
  await settle();
  assert.equal(t.mic.requests.length, 1, 'and one microphone');
  t.mic.open();
  await started;

  const stopped = t.source.stop();
  await settle();
  t.child().exit(0);
  await stopped;
  assert.equal(t.mic.state.stops, 1);
});

test('source: stop called from the first state listener leaves no worker', async () => {
  const t = harness();
  const stops: Array<Promise<void>> = [];
  t.source.onState((state) => {
    if (state === 'spawning') stops.push(t.source.stop());
  });
  const outcome = assert.rejects(t.source.start());
  await settle();
  // A child started before the stop took hold has been told to leave.
  for (const child of t.children) {
    assert.deepEqual(child.controls(), [{ type: 'bye' }]);
    child.exit(0);
  }
  await stops[0];
  await outcome;
  assert.equal(t.source.state(), 'exited');
  assert.equal(t.mic.requests.length, 0);
  assert.equal(t.clock.pending(), 0);
});

test('source: a microphone whose stop throws does not keep the worker alive', async (context) => {
  const logged = context.mock.method(console, 'error', () => {});
  const t = await recording();
  t.pcm();
  t.mic.state.throws = true;
  const stopped = t.source.stop();
  await settle();
  assert.deepEqual(t.child().controls().slice(-2), [{ type: 'flush' }, { type: 'bye' }]);
  t.child().exit(0);
  await stopped;
  assert.equal(t.source.state(), 'exited');
  assert.equal(t.clock.pending(), 0);
  assert.equal(logged.mock.callCount(), 1, 'said once, for whoever broke the capture');
});

test('source: a lost microphone whose stop throws is still reported, and the stop still works', async (context) => {
  context.mock.method(console, 'error', () => {});
  const t = await recording();
  t.mic.state.throws = true;
  t.mic.requests[0].onError(new Error('The microphone was disconnected.'));
  // An unhandled rejection here would fail the test.
  await settle();
  assert.equal(t.source.state(), 'failed');
  assert.equal(t.source.level(), 0);
  assert.deepEqual(t.child().controls().slice(-2), [{ type: 'flush' }, { type: 'bye' }]);
  const stopped = t.source.stop();
  await settle();
  t.child().exit(0);
  await stopped;
  assert.equal(t.mic.state.stops, 1);
});

/** Real time with every delay divided, so that the supervisor's backoff and grace periods pass in a fraction of them. */
function fastClock(divisor: number): Clock {
  return { ...realClock, setTimeout: (fn, ms) => setTimeout(fn, ms / divisor) };
}

/** A source over the real worker and its test recognizer, with a microphone the test plays. */
function realWorkerSource(options: { clock?: Clock; language?: SttLanguage; workerArgs?: string[] } = {}) {
  const dir = runtimeFixture();
  const children: ChildProcess[] = [];
  const mic = fakeMicrophone([]);
  const events: SttEvent[] = [];
  const states: SttState[] = [];
  const source = createTranscriptSourceWith({
    clock: options.clock ?? realClock,
    local: () => ({ ...DEFAULT_LOCAL, nodePath: process.execPath, runtimeDir: dir }),
    language: () => options.language ?? 'auto',
    readRuntime,
    baseEnv: () => process.env,
    spawn(command) {
      const child = spawn(command.command, [...command.args, '--fake', ...(options.workerArgs ?? [])], {
        env: command.env,
        cwd: command.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.push(child);
      spawned.push(child);
      return child;
    },
    exists: existsSync,
    startMic: mic.start,
  });
  source.onEvent((event) => events.push(event));
  source.onState((state) => states.push(state));
  return {
    source,
    children,
    mic,
    events,
    states,
    finals: () => events.filter((event) => event.type === 'segment' && event.isFinal),
    /** Sends audio as the capture does: 100 ms a block. */
    send(samples: Int16Array, rate: number): void {
      for (let offset = 0; offset < samples.length; offset += rate / 10) {
        mic.requests[0].onPcm(samples.subarray(offset, offset + rate / 10));
      }
    },
  };
}

async function until(what: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Silence, half a second of voice, silence. */
function utterance(rate: number, leadSeconds: number, tailSeconds: number): Int16Array {
  const out = new Int16Array(Math.round(rate * (leadSeconds + 0.5 + tailSeconds)));
  out.set(tone(rate, 0.5), Math.round(rate * leadSeconds));
  return out;
}

test('source: a real worker stopped while it starts is gone when the stop resolves', async () => {
  const t = realWorkerSource();
  const outcome = assert.rejects(t.source.start());
  await t.source.stop();
  await outcome;
  assert.equal(t.children.length, 1);
  assert.equal(gone(t.children[0]), true);
  assert.equal(t.source.state(), 'exited');
  assert.equal(t.mic.requests.length, 0);
});

test('source: a real worker stopped during the permission prompt is gone, and the late microphone is closed', async () => {
  const t = realWorkerSource();
  const started = t.source.start();
  await microphoneRequested(t.mic, started);
  const outcome = assert.rejects(started, { message: 'The recording was stopped before it started.' });
  await t.source.stop();
  assert.equal(gone(t.children[0]), true);
  assert.equal(t.children[0].exitCode, 0);
  assert.equal(t.source.state(), 'exited');

  t.mic.open();
  await outcome;
  assert.equal(t.mic.state.stops, 1);
  assert.equal(t.source.level(), 0);
  assert.equal(t.children.length, 1);
});

test('source: a microphone lost mid-sentence at 48 kHz still gets its final, and the real worker leaves', async () => {
  const t = realWorkerSource({ language: 'fr-CA' });
  const started = t.source.start();
  await microphoneRequested(t.mic, started);
  t.mic.open(48000);
  await started;

  // Still speaking when the microphone goes: nothing but the flush ends this utterance.
  t.send(utterance(48000, 0.3, 0), 48000);
  t.mic.requests[0].onError(new Error('The microphone was disconnected.'));
  assert.equal(t.source.state(), 'failed');
  assert.equal(t.mic.state.stops, 1);

  // Nobody has called stop(): the worker goes because there is nothing left for it to hear.
  await until('the worker to leave', () => gone(t.children[0]));
  assert.equal(t.children[0].exitCode, 0);

  await t.source.stop();
  const finals = t.finals();
  assert.equal(finals.length, 1, 'said once');
  const final = finals[0];
  assert.ok(final.type === 'segment');
  assert.equal(final.text, 'speech 0.5s');
  assert.ok(Math.abs(final.t0 - 0.3) <= 0.02, `t0 ${final.t0}`);
  assert.equal(t.source.state(), 'failed');
  assert.deepEqual(t.states, ['spawning', 'ready', 'running', 'failed']);
  assert.equal(t.mic.state.stops, 1);
  assert.equal(t.children.length, 1);
});

test('source: a real worker that is killed comes back, the times carry on, and none is left', async () => {
  // Backoff 100 ms, heartbeat 1.5 s; the worker's heartbeat is made as much faster.
  const t = realWorkerSource({ clock: fastClock(10), workerArgs: ['--stats-ms', '100'] });
  const started = t.source.start();
  await microphoneRequested(t.mic, started);
  t.mic.open(16000);
  await started;

  t.send(utterance(16000, 0.3, 0.7), 16000);
  await until('the first final', () => t.finals().length === 1);

  t.children[0].kill('SIGKILL');
  await until('the restart', () => t.children.length === 2 && t.source.state() === 'ready');
  assert.ok(t.states.includes('crashed'));
  assert.equal(t.mic.state.stops, 0, 'the microphone stayed open');

  t.send(utterance(16000, 0.2, 0.7), 16000);
  await until('the second final', () => t.finals().length === 2);
  assert.deepEqual(
    t.finals().map((event) => (event.type === 'segment' ? [event.text, event.t0] : null)),
    [
      ['speech 0.5s', 0.3],
      // The first worker heard 1.5 s; the second one's clock starts there.
      ['speech 0.5s', 1.7],
    ],
  );

  await t.source.stop();
  assert.equal(t.children.length, 2);
  assert.ok(t.children.every(gone));
  assert.equal(t.mic.state.stops, 1);
});

/** How many processes run the worker script of that runtime directory; null when that cannot be asked here. */
function workerProcesses(dir: string): number | null {
  const pattern = join(dir, 'worker.cjs').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const run = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  if (run.error || (run.status !== 0 && run.status !== 1)) return null;
  return run.stdout.split('\n').filter((line) => line.trim() !== '').length;
}

test('plugin source: render quanta in, a final out, and no process left', async (context) => {
  const dom = installDom(context);
  const dir = runtimeFixture();
  // The plugin's own source has no seam for the worker's test recognizer: the "Node" it is given adds the flag.
  const nodePath = join(dir, 'node-with-test-recognizer');
  writeFileSync(nodePath, `#!/bin/sh\nexec "${process.execPath}" "$@" --fake\n`, { mode: 0o755 });
  const source = createNodeTranscriptSource({
    clock: realClock,
    local: () => ({ ...DEFAULT_LOCAL, nodePath, runtimeDir: dir, micDeviceId: 'usb-mic' }),
    language: () => 'fr-CA',
  });
  const events: SttEvent[] = [];
  source.onEvent((event) => events.push(event));
  // Nothing here holds the child: a failed assertion must not leave it running.
  context.after(() => source.stop());

  await source.start();
  assert.equal(source.state(), 'ready');
  assert.deepEqual(events, [{ type: 'ready', model: 'fake', chunkMs: 100 }]);
  assert.equal(dom.requests.length, 1);

  // The audio thread's half: the text the capture loaded, posting to the node the capture made.
  const node = dom.worklets[0];
  const worklet = loadWorklet(dom.contexts[0].sampleRate, dom.moduleTexts[0], (block) => {
    node.port.onmessage?.({ data: block });
  });
  // 0.3 s of silence, then half a second of voice still going at the stop: 100 quanta, 8 blocks.
  const signal = new Float32Array(12800);
  for (let i = 4800; i < signal.length; i++) signal[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.3;
  worklet.feed(signal);
  assert.equal(worklet.posts.length, 8);
  assert.equal(source.state(), 'running');
  assert.ok(Math.abs(source.level() - 0.3) < 0.005, `level ${source.level()}`);

  const running = workerProcesses(dir);
  await source.stop();
  const finals = events.filter((event) => event.type === 'segment' && event.isFinal);
  assert.deepEqual(
    finals.map((event) => (event.type === 'segment' ? [event.source, event.text, event.t0] : null)),
    [['mic', 'speech 0.5s', 0.3]],
  );
  assert.equal(source.state(), 'exited');
  assert.equal(source.level(), 0);
  assert.equal(dom.streams[0].track.stops, 1);
  assert.equal(dom.contexts[0].state, 'closed');

  if (running === 1) assert.equal(workerProcesses(dir), 0, 'the worker is gone');
  else context.diagnostic(`pgrep saw ${running} worker(s) before the stop; the process count was not checked`);
});

/* Second review. The start is walked through its awkward moments (a capture
   that throws instead of rejecting, a worker that is between two lives when
   the microphone opens, a spawn that throws), and the capture through every
   step of building its graph. */

test('source: a capture that throws instead of rejecting still takes the worker down', async () => {
  const clock = manualClock();
  const children: FakeChild[] = [];
  const source = createTranscriptSourceWith({
    clock,
    local: () => ({ ...DEFAULT_LOCAL, runtimeDir: RT }),
    language: () => 'auto',
    readRuntime: () => INFO,
    baseEnv: () => ({}),
    spawn() {
      const child = new FakeChild([]);
      children.push(child);
      return child;
    },
    exists: () => true,
    startMic() {
      throw new Error('navigator is not defined');
    },
  });
  const started = source.start();
  const outcome = assert.rejects(started, { message: 'navigator is not defined' });
  children[0].emit(READY);
  await settle();
  assert.deepEqual(children[0].controls(), [{ type: 'bye' }]);
  assert.equal(children[0].stdinEnded, true);
  children[0].exit(0);
  await outcome;
  assert.equal(source.state(), 'exited');
  assert.equal(source.level(), 0);
  assert.equal(clock.pending(), 0);
});

test('source: a microphone that opens while the worker is between two lives is announced to the next one', async () => {
  const t = harness();
  const started = t.source.start();
  t.child().emit(READY);
  await settle();
  assert.equal(t.mic.requests.length, 1);

  // The permission prompt is up; the worker dies and is waiting to be restarted.
  t.child().exit(1);
  assert.equal(t.source.state(), 'crashed');
  t.mic.open(44100);
  await started;
  assert.equal(t.source.state(), 'crashed', 'the recording starts; the transcript follows');
  assert.equal(t.source.level(), 0.25);

  // A second of audio nobody is there to hear.
  for (let i = 0; i < 10; i++) t.pcm(new Int16Array(4410));
  assert.deepEqual(t.children[0].audio(), []);

  t.clock.advance(1000);
  assert.equal(t.children.length, 2);
  t.pcm(new Int16Array(4410));
  assert.deepEqual(t.child().written, [], 'nothing before the worker is ready');
  t.child().emit(READY);
  t.pcm(new Int16Array(4410));
  assert.deepEqual(t.log, ['hello', 'pcm'], 'the hello first, then audio');
  assert.deepEqual(t.child().controls(), [{ type: 'hello', source: 'mic', sampleRate: 44100 }]);

  // The new worker's clock starts where the lost audio ends: 1.1 s in.
  t.child().emit({ type: 'segment', source: 'mic', t0: 0.2, t1: 0.9, text: 'bonjour', isFinal: true });
  const final = t.events.at(-1);
  assert.ok(final?.type === 'segment');
  assert.deepEqual([final.t0, final.t1], [1.3, 2]);

  const stopped = t.source.stop();
  await settle();
  t.child().exit(0);
  await stopped;
  assert.equal(t.mic.state.stops, 1);
  assert.equal(t.clock.pending(), 0);
});

test('source: a spawn that throws ENOENT names the path too', async () => {
  const missing: Error & { code?: string } = new Error('spawn /nope/node ENOENT');
  missing.code = 'ENOENT';
  const t = harness({ local: { nodePath: '/nope/node' }, exists: () => false, spawnError: missing });
  const message = 'Node was not found at /nope/node. Set the path to Node in the plugin settings.';
  await assert.rejects(t.source.start(), { message });
  assert.deepEqual(t.states.at(-1), ['not-installed', message]);
  assert.equal(t.mic.requests.length, 0);
});

test('source: a worker found not installed after a restart lets go of the microphone and is not left running', async () => {
  const t = await recording();
  t.pcm();
  t.child().exit(1);
  t.clock.advance(1000);
  assert.equal(t.children.length, 2);
  // It says the model is gone and then lingers instead of exiting.
  t.child().emit({ type: 'error', code: 'model_missing', message: 'The speech model is missing or incomplete in /m' });
  assert.equal(t.source.state(), 'not-installed');
  assert.equal(t.mic.state.stops, 1);
  assert.equal(t.source.level(), 0);
  t.pcm();
  assert.deepEqual(t.child().audio(), []);

  t.child().diesWhenKilled = true;
  const stopped = t.source.stop();
  await settle();
  assert.equal(t.child().stdinEnded, true);
  t.clock.advance(2000);
  assert.deepEqual(t.child().kills, ['SIGKILL']);
  await stopped;
  assert.equal(t.source.state(), 'not-installed');
  assert.equal(t.mic.state.stops, 1);
  assert.equal(t.clock.pending(), 0);
});

test('source: stop resolves even when the worker can be neither told nor killed', async () => {
  const t = await recording();
  t.pcm();
  let resolved = false;
  const stopped = t.source.stop().then(() => {
    resolved = true;
  });
  await settle();
  // bye ignored, SIGKILL ignored, pipes never closed.
  t.clock.advance(2000);
  assert.deepEqual(t.child().kills, ['SIGKILL']);
  await settle();
  assert.equal(resolved, false);
  t.clock.advance(2000);
  await settle();
  t.clock.advance(1000);
  await stopped;
  assert.equal(t.source.state(), 'exited');
  assert.equal(t.clock.pending(), 0);
});

test('source: a listener that leaves while an event is being delivered does not cost the others theirs', async () => {
  const t = await recording();
  const heard: string[] = [];
  const off = t.source.onEvent(() => {
    heard.push('first');
    off();
  });
  t.source.onEvent(() => heard.push('second'));
  t.child().emit({ type: 'stats', rtf: 0.1, backlogMs: 0 });
  t.child().emit({ type: 'stats', rtf: 0.1, backlogMs: 0 });
  assert.deepEqual(heard, ['first', 'second', 'second']);
});

test('source: a 44.1 kHz microphone through the real worker: the rate is announced before the audio and nothing is refused', async () => {
  const t = realWorkerSource({ language: 'en-US' });
  const started = t.source.start();
  await microphoneRequested(t.mic, started);
  t.mic.open(44100);
  await started;
  t.send(utterance(44100, 0.4, 0.9), 44100);
  await until('the final', () => t.finals().length === 1);
  await t.source.stop();
  assert.deepEqual(
    t.events.filter((event) => event.type === 'error'),
    [],
    'no protocol error: the hello came first and its rate was accepted',
  );
  const final = t.finals()[0];
  assert.ok(final.type === 'segment');
  assert.equal(final.text, 'speech 0.5s');
  assert.ok(Math.abs(final.t0 - 0.4) <= 0.02, `t0 ${final.t0}`);
  assert.ok(t.children.every(gone));
  assert.equal(t.children[0].exitCode, 0);
});

test('capture: a stream without an audio track is refused before any context is made', async (t) => {
  const dom = installDom(t, {
    getUserMedia() {
      const stream = new FakeStream();
      stream.getAudioTracks = () => [];
      return stream;
    },
  });
  await assert.rejects(startMicCapture(captureLog().opts()), { message: 'No microphone was found.' });
  assert.equal(dom.contexts.length, 0);
  assert.equal(dom.streams[0].track.stops, 1, 'whatever the stream held is released');
});

test('capture: a context that cannot be made at any rate releases the microphone', async (t) => {
  const dom = installDom(t);
  globals.AudioContext = class {
    constructor() {
      throw domError('NotSupportedError', 'The number of hardware contexts provided (6) is the maximum.');
    }
  };
  await assert.rejects(startMicCapture(captureLog().opts()), {
    message: 'The microphone could not be started: The number of hardware contexts provided (6) is the maximum.',
  });
  assert.equal(dom.streams[0].track.stops, 1);
});

test('capture: a resume that is refused releases the microphone and closes the context', async (t) => {
  const dom = installDom(t);
  const Real = globals.AudioContext as new (options?: AudioContextOptions) => { resume(): Promise<void> };
  globals.AudioContext = class extends Real {
    resume(): Promise<void> {
      return Promise.reject(domError('InvalidStateError', 'Cannot resume a closed AudioContext.'));
    }
  };
  await assert.rejects(startMicCapture(captureLog().opts()), {
    message: 'The microphone could not be started: Cannot resume a closed AudioContext.',
  });
  assert.equal(dom.streams[0].track.stops, 1);
  assert.equal(dom.contexts[0].state, 'closed');
});

test('capture: a processor that cannot be instantiated releases everything already built', async (t) => {
  const dom = installDom(t);
  globals.AudioWorkletNode = class {
    constructor() {
      throw domError('InvalidStateError', "AudioWorkletNode cannot be created: The node name 'hamster-pcm' is not defined");
    }
  };
  await assert.rejects(startMicCapture(captureLog().opts()), /^Error: The microphone could not be started: AudioWorkletNode cannot be created/);
  assert.equal(dom.streams[0].track.stops, 1);
  assert.equal(dom.contexts[0].state, 'closed');
  assert.equal(dom.contexts[0].source?.disconnects, 1);
});

test('the worklet posts several blocks from one quantum when the rate is very low, and none is lost', () => {
  // 100 ms at 640 Hz is 64 frames: two blocks per quantum.
  const w = loadWorklet(640);
  const ramp = new Float32Array(256);
  for (let i = 0; i < ramp.length; i++) ramp[i] = i / 32767;
  w.feed(ramp);
  assert.equal(w.posts.length, 4);
  assert.deepEqual(
    w.blocks().map((block) => [block.length, block[0], block[63]]),
    [
      [64, 0, 63],
      [64, 64, 127],
      [64, 128, 191],
      [64, 192, 255],
    ],
  );
});
