#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Installs the speech runtime outside the vault: the sherpa-onnx-node addon,
 * the Nemotron 3.5 streaming model and the worker scripts.
 *
 * Two forms of one script. In the repository, `pnpm setup:stt` copies the
 * worker from stt/. In a release, scripts/build-setup.mjs makes it into
 * setup-speech.mjs, with the worker's files embedded, for users who have only
 * the plugin: `node setup-speech.mjs`, with the same options.
 *
 *   pnpm setup:stt
 *   pnpm setup:stt --dry-run
 *   pnpm setup:stt --chunk-ms 1120 --runtime /some/dir --node /path/to/node
 *   pnpm setup:stt --model-url file:///Users/me/Downloads/<model>.tar.bz2
 *
 * Every step is skipped when its result is already there, so the script can
 * be run again after a failure or an update. --dry-run touches neither the
 * disk nor the network. --model-url takes the model archive from that URL
 * (a mirror, or a file already downloaded) instead of asking GitHub.
 */

// The worker's files by name, in the release build (scripts/build-setup.mjs); null in the repository.
const EMBEDDED_WORKER = null;
const COMMAND = EMBEDDED_WORKER ? 'node setup-speech.mjs' : 'pnpm setup:stt';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RUNTIME = join(homedir(), 'Library', 'Application Support', 'magical-hamster');
const SHERPA_PACKAGE = 'sherpa-onnx-node';
const SHERPA_MIN = [1, 13, 8];
const SHERPA_SPEC = `${SHERPA_PACKAGE}@^${SHERPA_MIN.join('.')}`;
const ADDON_PACKAGE = 'sherpa-onnx-darwin-arm64';
const RELEASE_API = 'https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/asr-models';
const DOWNLOAD_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
const MODEL_PREFIX = 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b';
// The date in the asset names at the time of writing; only used when GitHub's API cannot be asked.
const MODEL_DATE = '2026-06-11';
const CHUNKS = [80, 160, 320, 560, 1120];
const FALLBACK_CHUNK = 1120;
const MODEL_FILES = [
  ['encoder.int8.onnx', 'encoder.onnx'],
  ['decoder.int8.onnx', 'decoder.onnx'],
  ['joiner.int8.onnx', 'joiner.onnx'],
  ['tokens.txt'],
];
const STEPS = 7;

function fail(message) {
  console.error(`\nThe speech setup stopped: ${message}`);
  process.exit(1);
}

function archiveName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const opts = { dryRun: false, chunkMs: 560, chunkGiven: false, runtime: DEFAULT_RUNTIME, node: '', modelUrl: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--chunk-ms') {
      opts.chunkMs = Number(value());
      opts.chunkGiven = true;
    } else if (arg === '--runtime') opts.runtime = resolve(value());
    else if (arg === '--node') opts.node = resolve(value());
    else if (arg === '--model-url') opts.modelUrl = value();
    else if (arg === '--help' || arg === '-h') {
      console.log(
        `Usage: ${COMMAND} [--dry-run] [--chunk-ms 560|1120|320] [--runtime <dir>] [--node <path>] [--model-url <url>]`,
      );
      process.exit(0);
    } else fail(`Unknown argument ${arg}`);
  }
  if (!CHUNKS.includes(opts.chunkMs)) fail(`--chunk-ms must be one of ${CHUNKS.join(', ')}`);
  if (opts.modelUrl) {
    // The archive's own name says which build it is.
    const name = archiveName(opts.modelUrl);
    /* The name becomes part of paths inside the runtime directory. Decoded
       from the URL, it can hold a slash (%2F) or dots that lead out of it. */
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      fail('--model-url must end in a plain <model>.tar.bz2 file name');
    }
    const named = /-(\d+)ms-int8/.exec(name);
    if (!name.endsWith('.tar.bz2') || !named) {
      fail(`--model-url must point at a ${MODEL_PREFIX}-<chunk>ms-int8-<date>.tar.bz2 archive`);
    }
    if (opts.chunkGiven && Number(named[1]) !== opts.chunkMs) {
      fail(`--model-url is a ${named[1]} ms build but --chunk-ms says ${opts.chunkMs}`);
    }
    opts.chunkMs = Number(named[1]);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const { dryRun, runtime } = opts;
let stepNumber = 0;

function step(title) {
  stepNumber += 1;
  console.log(`\n[${stepNumber}/${STEPS}] ${title}`);
}

function say(message) {
  console.log(`      ${message}`);
}

function would(message) {
  console.log(`      would ${message}`);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDir(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Homebrew's Node reports its Cellar path (/opt/homebrew/Cellar/node/23.6.0/bin/node),
 * which dies with the next upgrade. Prefer a path that leads to the same binary and survives.
 */
function stableNodePath() {
  let real;
  try {
    real = realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
  // The well-known locations first: a PATH entry can be a short-lived shim directory.
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH ?? '').split(delimiter)];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, 'node');
    try {
      if (realpathSync(candidate) === real) return candidate;
    } catch {
      // not there
    }
  }
  return process.execPath;
}

function inspectNode(nodePath) {
  let sameAsThis = false;
  try {
    sameAsThis = realpathSync(nodePath) === realpathSync(process.execPath);
  } catch {
    // inspected by running it, below
  }
  if (sameAsThis) return { platform: process.platform, arch: process.arch, version: process.versions.node };
  const probe = spawnSync(
    nodePath,
    ['-p', 'JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node})'],
    { encoding: 'utf8' },
  );
  if (probe.status !== 0) fail(`${nodePath} could not be run (${probe.error?.message ?? probe.stderr.trim()})`);
  return JSON.parse(probe.stdout);
}

function versionAtLeast(version, min) {
  const parts = String(version).split('.').map((p) => parseInt(p, 10));
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] ?? 0) > min[i]) return true;
    if ((parts[i] ?? 0) < min[i]) return false;
  }
  return true;
}

function installedSherpa() {
  const pkg = readJson(join(runtime, 'node_modules', SHERPA_PACKAGE, 'package.json'));
  const addon = isFile(join(runtime, 'node_modules', ADDON_PACKAGE, 'sherpa-onnx.node'));
  return { version: pkg?.version ?? null, addon };
}

function modelDirPattern(chunkMs) {
  return new RegExp(`^${MODEL_PREFIX.replaceAll('.', '\\.')}-${chunkMs}ms-int8(-[0-9-]+)?$`);
}

function modelComplete(dir) {
  return MODEL_FILES.every((names) => names.some((name) => isFile(join(dir, name))));
}

/** A complete model directory for that chunk size, if one is installed. */
function findInstalledModel(modelsDir, chunkMs) {
  if (!isDir(modelsDir)) return null;
  const pattern = modelDirPattern(chunkMs);
  const names = readdirSync(modelsDir)
    .filter((name) => pattern.test(name) && modelComplete(join(modelsDir, name)))
    .sort();
  return names.length ? names[names.length - 1] : null;
}

async function githubJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'magical-hamster-setup' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

/** All assets of the release. The release lists hundreds, so the paged endpoint is the complete source. */
async function listAssets() {
  const release = await githubJson(RELEASE_API);
  const embedded = Array.isArray(release.assets) ? release.assets : [];
  if (embedded.some((a) => String(a.name).startsWith(MODEL_PREFIX)) || !release.assets_url) return embedded;
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await githubJson(`${release.assets_url}?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}

function pickAsset(assets, chunkMs) {
  const dir = modelDirPattern(chunkMs);
  const matches = assets
    .filter((a) => typeof a.name === 'string' && a.name.endsWith('.tar.bz2') && dir.test(a.name.slice(0, -8)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const asset = matches[matches.length - 1];
  if (!asset) return null;
  const digest = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : null;
  return { name: asset.name, url: asset.browser_download_url, size: asset.size ?? null, sha256: digest, chunkMs };
}

function patternAsset(chunkMs) {
  const name = `${MODEL_PREFIX}-${chunkMs}ms-int8-${MODEL_DATE}.tar.bz2`;
  return { name, url: `${DOWNLOAD_BASE}/${name}`, size: null, sha256: null, chunkMs };
}

async function resolveAsset(chunkMs) {
  if (opts.modelUrl) {
    return { name: archiveName(opts.modelUrl), url: opts.modelUrl, size: null, sha256: null, chunkMs };
  }
  let assets;
  try {
    assets = await listAssets();
  } catch (err) {
    say(`GitHub's release API did not answer (${err.message}).`);
    say('Falling back to the file name the model had when this script was written.');
    return patternAsset(chunkMs);
  }
  const wanted = pickAsset(assets, chunkMs);
  if (wanted) return wanted;
  if (chunkMs !== FALLBACK_CHUNK) {
    const fallback = pickAsset(assets, FALLBACK_CHUNK);
    if (fallback) {
      say(`The release has no ${chunkMs} ms build of the model. Using the ${FALLBACK_CHUNK} ms build instead:`);
      say('same accuracy or better, but text appears about a second after speech.');
      return fallback;
    }
  }
  say('The release lists no Nemotron 3.5 streaming model. Trying its known file name directly.');
  return patternAsset(chunkMs);
}

function sha256Of(file) {
  return new Promise((done, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => done(hash.digest('hex')));
  });
}

function megabytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

async function downloadModel(modelsDir, asset) {
  const part = join(modelsDir, `.download-${asset.name}.part`);
  const staging = join(modelsDir, `.extract-${asset.name}`);
  const dirName = asset.name.slice(0, -'.tar.bz2'.length);
  rmSync(part, { force: true });
  /* Whatever an interrupted extraction left behind, under any name: up to a
     whole unpacked model each time, which nothing else would ever remove. */
  for (const name of readdirSync(modelsDir)) {
    if (name.startsWith('.extract-')) rmSync(join(modelsDir, name), { recursive: true, force: true });
  }

  say(`Downloading ${asset.name}${asset.size ? ` (${megabytes(asset.size)})` : ''}`);
  say(`from ${asset.url}`);
  const curl = spawnSync('curl', ['-L', '--fail', '--progress-bar', '-o', part, asset.url], { stdio: 'inherit' });
  if (curl.status !== 0) {
    rmSync(part, { force: true });
    fail(
      `the download failed (curl exit ${curl.status ?? curl.error?.message}). Check the connection and run the script again, ` +
        `or look for the model at https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models`,
    );
  }

  const sha256 = await sha256Of(part);
  say(`sha256 ${sha256}`);
  if (asset.sha256 && asset.sha256 !== sha256) {
    rmSync(part, { force: true });
    fail(`the download does not match the checksum GitHub publishes (${asset.sha256}). It was deleted; run the script again.`);
  }
  if (asset.sha256) say('The checksum matches the one GitHub publishes.');

  say('Extracting');
  mkdirSync(staging, { recursive: true });
  // Extracted aside and moved into place, so an interrupted run never leaves
  // something that looks like a complete model.
  const tar = spawnSync('tar', ['xjf', part, '-C', staging], { stdio: 'inherit' });
  if (tar.status !== 0) {
    rmSync(staging, { recursive: true, force: true });
    fail(`tar could not extract ${part}`);
  }
  // An archive that is not the model is of no use to the next run either.
  const discard = () => {
    rmSync(staging, { recursive: true, force: true });
    rmSync(part, { force: true });
  };
  let extracted = join(staging, dirName);
  if (!isDir(extracted)) {
    const dirs = readdirSync(staging).filter((name) => isDir(join(staging, name)));
    if (dirs.length !== 1) {
      discard();
      fail(`the archive did not contain the expected directory ${dirName}`);
    }
    extracted = join(staging, dirs[0]);
  }
  if (!modelComplete(extracted)) {
    discard();
    fail(`the archive is missing model files (expected ${MODEL_FILES.map((n) => n[0]).join(', ')})`);
  }
  const target = join(modelsDir, basename(extracted));
  rmSync(target, { recursive: true, force: true });
  renameSync(extracted, target);
  rmSync(staging, { recursive: true, force: true });
  rmSync(part, { force: true });
  // Kept beside the model so the hash survives a later run that skips the download.
  writeFileSync(`${target}.sha256`, `${sha256}  ${asset.name}\n`);
  return basename(target);
}

function recordedSha256(modelsDir, model) {
  try {
    const hash = readFileSync(join(modelsDir, `${model}.sha256`), 'utf8').trim().split(/\s+/)[0];
    return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

function pickTestWav(modelDir) {
  const dir = join(modelDir, 'test_wavs');
  if (!isDir(dir)) return null;
  const wavs = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.wav'))
    .sort();
  if (wavs.length === 0) return null;
  const rank = (name) => {
    const lower = name.toLowerCase();
    if (lower.includes('fr')) return 0;
    if (lower.includes('en')) return 1;
    return 2;
  };
  wavs.sort((a, b) => rank(a) - rank(b));
  return join(dir, wavs[0]);
}

function runSelfTest(nodePath, modelDir, wav) {
  const addonDir = join(runtime, 'node_modules', ADDON_PACKAGE);
  // The same command line and environment the plugin uses.
  const run = spawnSync(nodePath, [join(runtime, 'worker.cjs'), '--model', modelDir, '--self-test', wav], {
    env: { ...process.env, DYLD_LIBRARY_PATH: addonDir },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000,
    // Not the default SIGTERM: the worker answers it with a clean exit, and a
    // recognizer stuck in native code never gets to answer it at all.
    killSignal: 'SIGKILL',
  });
  const events = [];
  for (const line of (run.stdout ?? '').split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object') events.push(event);
    } catch {
      // not an event line
    }
  }
  return { status: run.status, events, stderr: (run.stderr ?? '').trim(), error: run.error };
}

/** A second of silence as a 16 kHz, 16-bit, mono WAV: enough to make the worker load the library and the model. */
function silentWav() {
  const sampleRate = 16000;
  const dataBytes = sampleRate * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // one channel
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

function reportSelfTest(result) {
  for (const event of result.events) {
    if (event.type === 'segment') say(`heard: ${event.text}`);
    if (event.type === 'error') say(`worker error (${event.code}): ${event.message ?? ''}`);
  }
  const summary = result.events.find((event) => event.type === 'selftest');
  if (summary) {
    say(`${summary.finals} segment(s) from ${summary.seconds} s of audio, real-time factor ${summary.rtf}`);
  }
}

step('Runtime directory');
say(runtime);
if (isDir(runtime)) say('already there');
else if (dryRun) would('create it');
else mkdirSync(runtime, { recursive: true });

step('Node');
const nodePath = opts.node || stableNodePath();
const nodeInfo = inspectNode(nodePath);
say(`${nodePath}  (v${nodeInfo.version}, ${nodeInfo.platform} ${nodeInfo.arch})`);
if (nodeInfo.platform !== 'darwin' || nodeInfo.arch !== 'arm64') {
  fail(`the speech runtime is set up for Apple Silicon Macs (darwin arm64); this Node is ${nodeInfo.platform} ${nodeInfo.arch}.`);
}
if (!versionAtLeast(nodeInfo.version, [20])) {
  fail(`Node 20 or later is needed; this is ${nodeInfo.version}.`);
}

step(`${SHERPA_PACKAGE} (the speech library)`);
{
  const packageJson = join(runtime, 'package.json');
  if (!existsSync(packageJson)) {
    const manifest = {
      name: 'magical-hamster-runtime',
      private: true,
      description: `Speech runtime of the Magical Hamster Obsidian plugin. Managed by \`${COMMAND}\`.`,
    };
    if (dryRun) would(`write ${packageJson}`);
    else writeFileSync(packageJson, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const have = installedSherpa();
  if (have.version && have.addon && versionAtLeast(have.version, SHERPA_MIN)) {
    say(`${SHERPA_PACKAGE} ${have.version} is already installed`);
  } else {
    const besideNode = join(dirname(nodePath), 'npm');
    const npm = existsSync(besideNode) ? besideNode : 'npm';
    const args = ['install', SHERPA_SPEC, '--no-audit', '--no-fund'];
    if (dryRun) {
      would(`run in ${runtime}: ${npm} ${args.join(' ')}`);
    } else {
      say(`${npm} ${args.join(' ')}`);
      const install = spawnSync(npm, args, {
        cwd: runtime,
        stdio: 'inherit',
        // npm is a script that looks for `node` on the PATH.
        env: { ...process.env, PATH: `${dirname(nodePath)}${delimiter}${process.env.PATH ?? ''}` },
      });
      if (install.status !== 0) fail(`npm install failed (${install.error?.message ?? `exit ${install.status}`})`);
      const now = installedSherpa();
      if (!now.version) fail(`${SHERPA_PACKAGE} is not in ${join(runtime, 'node_modules')} after npm install`);
      if (!now.addon) {
        fail(`npm did not install ${ADDON_PACKAGE}, the prebuilt addon for this Mac. Check that npm is not run with --no-optional.`);
      }
      say(`installed ${SHERPA_PACKAGE} ${now.version}`);
    }
  }
}

step(`Speech model (Nemotron 3.5 ASR Streaming 0.6B, int8, ${opts.chunkMs} ms)`);
const modelsDir = join(runtime, 'models');
let model = findInstalledModel(modelsDir, opts.chunkMs);
if (model) {
  say(`${model} is already installed`);
} else if (dryRun) {
  if (opts.modelUrl) {
    would(`take the archive from ${opts.modelUrl}`);
    model = archiveName(opts.modelUrl).slice(0, -'.tar.bz2'.length);
  } else {
    would(`ask ${RELEASE_API}`);
    say(`for the asset ${MODEL_PREFIX}-${opts.chunkMs}ms-int8-<date>.tar.bz2,`);
    say(`falling back to the ${FALLBACK_CHUNK} ms build, then to ${patternAsset(opts.chunkMs).url}`);
    model = `${MODEL_PREFIX}-${opts.chunkMs}ms-int8-${MODEL_DATE}`;
  }
  would('download it with curl -L --fail --progress-bar (about 453 MB), check its sha256');
  would(`extract it with tar xjf into ${modelsDir}`);
} else {
  mkdirSync(modelsDir, { recursive: true });
  const asset = await resolveAsset(opts.chunkMs);
  // The 1120 ms fallback may already be installed.
  model = findInstalledModel(modelsDir, asset.chunkMs);
  if (model) say(`${model} is already installed`);
  else model = await downloadModel(modelsDir, asset);
}
const modelDir = join(modelsDir, model);
const chunkMs = Number(/-(\d+)ms-/.exec(model)?.[1] ?? opts.chunkMs);

step('Worker scripts');
if (EMBEDDED_WORKER) {
  const scripts = Object.keys(EMBEDDED_WORKER).sort();
  for (const name of scripts) {
    if (dryRun) would(`write ${join(runtime, name)}`);
    else writeFileSync(join(runtime, name), EMBEDDED_WORKER[name]);
  }
  if (!dryRun) say(`wrote ${scripts.join(', ')}`);
} else {
  const source = join(REPO, 'stt');
  const scripts = readdirSync(source).filter((name) => name.endsWith('.cjs'));
  if (scripts.length === 0) fail(`no worker scripts found in ${source}`);
  for (const name of scripts) {
    if (dryRun) would(`copy stt/${name} to ${join(runtime, name)}`);
    else copyFileSync(join(source, name), join(runtime, name));
  }
  if (!dryRun) say(`copied ${scripts.join(', ')}`);
}

step('Self-test');
let selfTestPassed = false;
{
  const manual = `DYLD_LIBRARY_PATH="${join(runtime, 'node_modules', ADDON_PACKAGE)}" "${nodePath}" "${join(runtime, 'worker.cjs')}" --model "${modelDir}" --self-test <file.wav>`;
  if (dryRun) {
    would('transcribe a WAV from the model\'s test_wavs/ (French or English first) with:');
    say(manual);
    would('load the model on a second of silence instead when it has no test_wavs/');
    if (!EMBEDDED_WORKER) would('run scripts/fix-sherpa-rpath.mjs and try once more if the library fails to load (exit code 3)');
  } else {
    const recording = pickTestWav(modelDir);
    /* Without a test recording nothing can be transcribed, but the library and
       the model still have to load before the runtime is recorded as usable:
       the worker is run on a second of silence instead. */
    const silence = join(runtime, '.self-test-silence.wav');
    const wav = recording ?? silence;
    if (recording) {
      say(`transcribing ${recording}`);
    } else {
      say('The model came without test recordings: loading it on a second of silence instead.');
      writeFileSync(silence, silentWav());
    }
    let result = runSelfTest(nodePath, modelDir, wav);
    // The repair script is the repository's; the release build has none to run.
    if (result.status === 3 && !EMBEDDED_WORKER) {
      say('The speech library did not load. Rewriting its library references and trying once more.');
      const fix = spawnSync(process.execPath, [join(REPO, 'scripts', 'fix-sherpa-rpath.mjs'), '--runtime', runtime], {
        stdio: 'inherit',
      });
      if (fix.status === 0) result = runSelfTest(nodePath, modelDir, wav);
    }
    rmSync(silence, { force: true });
    reportSelfTest(result);
    /* The worker ends its run with a summary line once the library and the
       model have loaded and the audio went through. On silence that is all
       there is to pass: it exits 1 for having heard nothing. */
    const loaded = !result.error && result.events.some((event) => event.type === 'selftest');
    if (recording ? result.status === 0 && !result.error : loaded) {
      selfTestPassed = true;
      if (!recording) {
        say('The speech library and the model loaded. Nothing was transcribed.');
        say('To test by hand, record a few seconds as 16-bit WAV and run:');
        say(manual);
      }
    } else {
      if (result.stderr) console.error(result.stderr);
      const why =
        result.error?.code === 'ETIMEDOUT'
          ? 'it did not finish within five minutes'
          : (result.error?.message ?? `exit code ${result.status}`);
      fail(
        recording
          ? `the self-test failed (${why}). Nothing was recorded in runtime.json. ` +
              `To repeat it by hand:\n  ${manual.replace('<file.wav>', `"${recording}"`)}`
          : `the speech library or the model did not load (${why}). Nothing was recorded in runtime.json. ` +
              `To repeat it by hand, record a few seconds as 16-bit WAV and run:\n  ${manual}`,
      );
    }
  }
}

step('runtime.json');
{
  const file = join(runtime, 'runtime.json');
  const record = {
    node: nodePath,
    runtimeDir: runtime,
    model,
    modelDir,
    chunkMs,
    sha256: dryRun ? null : recordedSha256(modelsDir, model),
    sherpaVersion: dryRun ? null : installedSherpa().version,
    installedAt: new Date().toISOString(),
  };
  if (dryRun) {
    would(`write ${file}:`);
    for (const line of JSON.stringify(record, null, 2).split('\n')) say(line);
  } else if (selfTestPassed) {
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    say(`wrote ${file}`);
  }
}

console.log(dryRun ? '\nDry run: nothing was changed.' : '\nThe speech runtime is ready.');
/* The plugin reads runtime.json: it runs the worker with the Node recorded
   there, and looks in the default folder by itself. Only a runtime installed
   somewhere else has to be named in its settings. */
const plugin = dryRun ? 'Once installed, the plugin' : 'The plugin';
console.log(`${plugin} runs the speech worker with the Node recorded in runtime.json: ${nodePath}`);
if (resolve(runtime) === resolve(DEFAULT_RUNTIME)) {
  console.log('It finds this folder by itself: there is nothing to set in Obsidian.');
} else {
  console.log(`It looks for the runtime in ${DEFAULT_RUNTIME}, not here. In Obsidian, open Settings, Magical Hamster, and set:`);
  console.log(`  Runtime folder  ${runtime}`);
}
