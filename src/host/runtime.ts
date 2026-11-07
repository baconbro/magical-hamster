import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';

/* The speech runtime: where `pnpm setup:stt` installed it, what it recorded
   there, and the command that starts its worker. The layout and the worker's
   arguments are specified in protocol/segments.md. */

export interface RuntimeInfo {
  /** The Node binary the installer's self-test ran with. */
  node: string;
  /** The directory runtime.json was read from. */
  runtimeDir: string;
  modelDir: string;
  model: string;
  chunkMs: number;
}

export interface WorkerCommand {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd: string;
}

// Not PLUGIN_ID: an installed runtime must stay where it is if the plugin id ever changes.
const RUNTIME_DIR_NAME = 'magical-hamster';
const RUNTIME_FILE = 'runtime.json';
const WORKER_SCRIPT = 'worker.cjs';
const ADDON_PACKAGE = 'sherpa-onnx-darwin-arm64';

/** `~/Library/Application Support/magical-hamster`, the directory `pnpm setup:stt` uses by default. */
export function defaultRuntimeDir(home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', RUNTIME_DIR_NAME);
}

/**
 * `path` with a leading `~` replaced by `home`. Only the two forms that mean
 * the user's own home, `~` and `~/…`: `~name/…` is somebody else's and is left
 * as typed, like every other path. Pure, unit-tested.
 */
export function expandHome(path: string, home: string): string {
  // Without a home there is nothing to put in its place.
  if (home === '') return path;
  if (path === '~') return home;
  return path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

/**
 * The directory a `runtimeDir` setting stands for: the default when it is
 * empty, the home directory for a leading `~`. Nothing below this expands a
 * `~` (to Node it is a folder of that name in the working directory), so this
 * is the one place that decides, and the speech source, the stats file, the
 * index and the settings tab are all handed its answer.
 */
export function resolveRuntimeDir(setting: string, home: string = homedir()): string {
  const typed = setting.trim();
  return typed === '' ? defaultRuntimeDir(home) : expandHome(typed, home);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** `path` moved along with `from` to `to`, or unchanged when it is not inside `from`. */
function rebase(path: string, from: string, to: string): string {
  if (from === to) return path;
  const inside = relative(from, path);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return path;
  return join(to, inside);
}

/** Pure part, unit-tested: validates the parsed JSON and resolves paths. */
export function parseRuntime(json: unknown, runtimeDir: string): RuntimeInfo | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (!nonEmptyString(o.node) || !nonEmptyString(o.model) || !nonEmptyString(o.modelDir)) return null;
  if (typeof o.chunkMs !== 'number' || !Number.isFinite(o.chunkMs) || o.chunkMs <= 0) return null;

  // The directory the file was found in is the one that holds the worker,
  // whatever the file says: it records absolute paths from the day it was
  // written, and the directory may have been moved or reached by another name
  // since. A model recorded inside the old location followed the move.
  const dir = resolve(runtimeDir);
  const recordedDir = nonEmptyString(o.runtimeDir) && isAbsolute(o.runtimeDir) ? resolve(o.runtimeDir) : dir;
  const modelDir = isAbsolute(o.modelDir) ? rebase(resolve(o.modelDir), recordedDir, dir) : resolve(dir, o.modelDir);

  return { node: o.node, runtimeDir: dir, modelDir, model: o.model, chunkMs: o.chunkMs };
}

/** Reads <runtimeDir>/runtime.json written by `pnpm setup:stt`. Null when it is missing or unusable. */
export function readRuntime(runtimeDir: string): RuntimeInfo | null {
  const dir = runtimeDir.trim() || defaultRuntimeDir();
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(dir, RUNTIME_FILE), 'utf8'));
  } catch {
    return null;
  }
  const info = parseRuntime(json, dir);
  if (!info) return null;
  // A record without the script it describes is a half-removed runtime. Node
  // would only say "Cannot find module"; "not set up" names the remedy. The
  // model is left to the worker, which reports exactly which file is missing.
  return existsSync(join(info.runtimeDir, WORKER_SCRIPT)) ? info : null;
}

/** The environment and arguments for spawning the worker. Pure, unit-tested. */
export function workerCommand(
  info: RuntimeInfo,
  opts: { nodePath: string; language: string; baseEnv: Record<string, string | undefined> },
): WorkerCommand {
  const addonDir = join(info.runtimeDir, 'node_modules', ADDON_PACKAGE);

  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(opts.baseEnv)) {
    // Obsidian is Electron. With this variable an Electron binary acts as
    // Node; it is not ours to pass on to the user's real Node.
    if (key === 'ELECTRON_RUN_AS_NODE' || value === undefined) continue;
    env[key] = value;
  }
  // The speech library is a native addon that finds its dylibs through this.
  const inherited = (opts.baseEnv.DYLD_LIBRARY_PATH ?? '').split(delimiter).filter((p) => p !== '' && p !== addonDir);
  env.DYLD_LIBRARY_PATH = [addonDir, ...inherited].join(delimiter);

  return {
    command: opts.nodePath.trim() || info.node,
    args: [join(info.runtimeDir, WORKER_SCRIPT), '--model', info.modelDir, '--lang', opts.language.trim() || 'auto'],
    env,
    cwd: info.runtimeDir,
  };
}
