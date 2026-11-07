import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Makes dist/setup-speech.mjs: scripts/setup-stt.mjs with the speech worker's files embedded, so
   that someone with the plugin and Node, but not this repository, can install speech
   recognition. Attached to every release; the plugin's settings show the command that runs it. */

// Another path as the first argument: the tests build it elsewhere.
const OUT = process.argv[2] || 'dist/setup-speech.mjs';
const MARKER = 'const EMBEDDED_WORKER = null;';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(REPO, 'scripts', 'setup-stt.mjs'), 'utf8');
if (source.split(MARKER).length !== 2) throw new Error(`scripts/setup-stt.mjs must hold "${MARKER}" exactly once`);

const files = {};
for (const name of readdirSync(join(REPO, 'stt')).filter((file) => file.endsWith('.cjs')).sort()) {
  files[name] = readFileSync(join(REPO, 'stt', name), 'utf8');
}
if (!files['worker.cjs']) throw new Error('stt/worker.cjs is missing');

/* A function, not a string: String.replace reads `$&` and `$1` in a replacement
   string, and the worker's source is free to contain them. */
writeFileSync(OUT, source.replace(MARKER, () => `const EMBEDDED_WORKER = ${JSON.stringify(files)};`));
console.log(`${OUT}: the speech setup, with ${Object.keys(files).join(', ')}`);
