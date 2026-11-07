#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

/* Makes the sherpa-onnx addon find its own dylibs without DYLD_LIBRARY_PATH.
 *
 *   node scripts/fix-sherpa-rpath.mjs [--runtime <dir>] [--dir <package dir>] [--dry-run]
 *
 * The prebuilt addon refers to its sibling libraries by bare name or through
 * @rpath, which only resolves when DYLD_LIBRARY_PATH points at the package.
 * This rewrites those references to @loader_path/<name> in every Mach-O file
 * of the package, then re-signs each changed file: editing load commands
 * invalidates the signature, and Apple Silicon refuses to load unsigned code.
 *
 * `pnpm setup:stt` runs it only when the self-test cannot load the library.
 * Running it twice changes nothing the second time.
 */

const DEFAULT_RUNTIME = join(homedir(), 'Library', 'Application Support', 'magical-hamster');
const ADDON_PACKAGE = 'sherpa-onnx-darwin-arm64';

function fail(message) {
  console.error(`fix-sherpa-rpath: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { dryRun: false, runtime: DEFAULT_RUNTIME, dir: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--runtime') opts.runtime = resolve(value());
    else if (arg === '--dir') opts.dir = resolve(value());
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/fix-sherpa-rpath.mjs [--runtime <dir>] [--dir <package dir>] [--dry-run]');
      process.exit(0);
    } else fail(`Unknown argument ${arg}`);
  }
  return opts;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) fail(`${command} could not be run: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed:\n${result.stderr.trim()}`);
  return result.stdout;
}

/** Thin or universal Mach-O, by its first four bytes. */
function isMachO(file) {
  const head = Buffer.alloc(4);
  const fd = openSync(file, 'r');
  try {
    if (readSync(fd, head, 0, 4, 0) < 4) return false;
  } finally {
    closeSync(fd);
  }
  const magic = head.readUInt32BE(0);
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
}

/** Install names a file links against, without its own id. */
function dependencies(file) {
  // `otool -D` prints the file name, then the id when the file is a dylib.
  const id = run('otool', ['-D', file]).split('\n')[1]?.trim() ?? '';
  const deps = new Set();
  for (const line of run('otool', ['-L', file]).split('\n')) {
    const match = /^\s+(.+?) \(compatibility version /.exec(line);
    if (match && match[1] !== id) deps.add(match[1]);
  }
  return [...deps];
}

const opts = parseArgs(process.argv.slice(2));
const dir = opts.dir || join(opts.runtime, 'node_modules', ADDON_PACKAGE);

let names;
try {
  names = readdirSync(dir);
} catch {
  fail(`${dir} does not exist. Run \`pnpm setup:stt\` first.`);
}

const machO = names.filter((name) => {
  if (!name.endsWith('.node') && !name.endsWith('.dylib')) return false;
  const file = join(dir, name);
  // Symlinks (libfoo.dylib -> libfoo.1.dylib) lead to a file handled under its own name.
  return lstatSync(file).isFile() && isMachO(file);
});
if (machO.length === 0) fail(`no Mach-O files (*.node, *.dylib) in ${dir}`);

let changedFiles = 0;
for (const name of machO) {
  const file = join(dir, name);
  const changes = [];
  for (const dep of dependencies(file)) {
    const target = basename(dep);
    const wanted = `@loader_path/${target}`;
    if (dep === wanted) continue;
    const bare = !dep.includes('/');
    if (!bare && dep !== `@rpath/${target}`) continue;
    if (!existsSync(join(dir, target))) {
      console.log(`${name}: ${dep} has no sibling named ${target}; left as it is`);
      continue;
    }
    changes.push([dep, wanted]);
  }
  if (changes.length === 0) {
    console.log(`${name}: nothing to change`);
    continue;
  }
  changedFiles += 1;
  for (const [from, to] of changes) console.log(`${name}: ${from} -> ${to}`);
  if (opts.dryRun) continue;
  run('install_name_tool', [...changes.flatMap(([from, to]) => ['-change', from, to]), file]);
  run('codesign', ['-f', '-s', '-', file]);
  console.log(`${name}: re-signed`);
}

if (opts.dryRun) console.log(`Dry run: ${changedFiles} file(s) would be rewritten and re-signed.`);
else console.log(`${changedFiles} file(s) rewritten and re-signed in ${dir}`);
