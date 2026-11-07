import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Makes dist/setup-speech.mjs: scripts/setup-stt.mjs with the speech worker's files embedded, so
   that someone with the plugin and Node, but not this repository, can install speech
   recognition. Attached to every release; the plugin's settings show the command that runs it. */

// Another path as the first argument: the tests build it elsewhere.
const OUT = process.argv[2] || 'dist/setup-speech.mjs';
const WORKER_MARKER = 'const EMBEDDED_WORKER = null;';
const VERSION_MARKER = 'const SETUP_VERSION = null;';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let source = readFileSync(join(REPO, 'scripts', 'setup-stt.mjs'), 'utf8');
for (const marker of [WORKER_MARKER, VERSION_MARKER]) {
  if (source.split(marker).length !== 2) throw new Error(`scripts/setup-stt.mjs must hold "${marker}" exactly once`);
}

const files = {};
for (const name of readdirSync(join(REPO, 'stt')).filter((file) => file.endsWith('.cjs')).sort()) {
  files[name] = readFileSync(join(REPO, 'stt', name), 'utf8');
}
if (!files['worker.cjs']) throw new Error('stt/worker.cjs is missing');

// The version the plugin will compare with: the one this build is released as.
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('package.json has no version');

/* A function, not a string: String.replace reads `$&` and `$1` in a replacement
   string, and the worker's source is free to contain them. */
source = source.replace(WORKER_MARKER, () => `const EMBEDDED_WORKER = ${JSON.stringify(files)};`);
source = source.replace(VERSION_MARKER, () => `const SETUP_VERSION = ${JSON.stringify(pkg.version)};`);
writeFileSync(OUT, source);
console.log(`${OUT}: the speech setup ${pkg.version}, with ${Object.keys(files).join(', ')}`);
