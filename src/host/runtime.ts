import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';

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
  /**
   * The plugin version the setup script was built from, which is the version
   * of the worker it wrote. Null when the record has none: a setup script run
   * from a checkout without one, or a runtime set up before this was recorded.
   */
  workerVersion: string | null;
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
/* Environment variables the worker must not inherit from Obsidian. With
   ELECTRON_RUN_AS_NODE an Electron binary acts as Node, and the other
   ELECTRON_* variables are Electron's own; NODE_OPTIONS and NODE_PATH would
   change how the user's real Node starts the worker and what it loads. */
const ELECTRON_PREFIX = 'ELECTRON_';
const DROPPED_ENV = new Set(['NODE_OPTIONS', 'NODE_PATH']);

/**
 * The directory `pnpm setup:stt` uses by default: `~/Library/Application
 * Support/magical-hamster` on a Mac, `%APPDATA%\magical-hamster` on Windows,
 * `$XDG_DATA_HOME/magical-hamster` (or `~/.local/share/magical-hamster`)
 * elsewhere. The plugin is desktop-only, not Mac-only: the stats and the index
 * are kept here on every platform, even where speech is not available.
 */
export function defaultRuntimeDir(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', RUNTIME_DIR_NAME);
  if (platform === 'win32') {
    // Windows paths, whichever platform asks (the tests do, from Linux).
    const appData = env.APPDATA?.trim() || win32.join(home, 'AppData', 'Roaming');
    return win32.join(appData, RUNTIME_DIR_NAME);
  }
  const dataHome = env.XDG_DATA_HOME?.trim() || posix.join(home, '.local', 'share');
  return posix.join(dataHome, RUNTIME_DIR_NAME);
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
 * empty, the home directory for a leading `~`, and a relative folder taken
 * from the home directory. Nothing below this expands a `~` (to Node it is a
 * folder of that name in the working directory), and a relative path would be
 * taken from Obsidian's working directory, which is `/` when it is started
 * from the Finder. So this is the one place that decides, and the speech
 * source, the stats file, the index and the settings tab are all handed its
 * answer.
 */
export function resolveRuntimeDir(
  setting: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  const typed = setting.trim();
  if (typed === '') return defaultRuntimeDir(home, platform, env);
  const expanded = expandHome(typed, home);
  return isAbsolute(expanded) ? expanded : join(home, expanded);
}

/**
 * The Node binary a `nodePath` setting names, with a leading `~` expanded as
 * for the runtime folder: spawned as typed, `~/.nvm/.../node` is a relative
 * path that exists nowhere. Empty stays empty, which means the Node the
 * setup recorded.
 */
export function resolveNodePath(setting: string, home: string = homedir()): string {
  const typed = setting.trim();
  return typed === '' ? '' : expandHome(typed, home);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Whether `path` is `dir` or inside it. Both absolute; neither is looked up on disk. */
export function isInside(path: string, dir: string): boolean {
  const inside = relative(dir, path);
  return !(inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside));
}

/** `path` moved along with `from` to `to`, or unchanged when it is not inside `from`. */
function rebase(path: string, from: string, to: string): string {
  if (from === to) return path;
  const inside = relative(from, path);
  if (inside === '' || !isInside(path, from)) return path;
  return join(to, inside);
}

/** Pure part, unit-tested: validates the parsed JSON and resolves paths. */
export function parseRuntime(json: unknown, runtimeDir: string): RuntimeInfo | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (!nonEmptyString(o.node) || !nonEmptyString(o.model) || !nonEmptyString(o.modelDir)) return null;
  // The installer records the absolute path of the Node its self-test ran with. A relative
  // one, typed in by hand, would be looked up in the worker's directory and fail obscurely.
  if (!isAbsolute(o.node)) return null;
  if (typeof o.chunkMs !== 'number' || !Number.isFinite(o.chunkMs) || o.chunkMs <= 0) return null;

  // The directory the file was found in is the one that holds the worker,
  // whatever the file says: it records absolute paths from the day it was
  // written, and the directory may have been moved or reached by another name
  // since. A model recorded inside the old location followed the move.
  const dir = resolve(runtimeDir);
  const recordedDir = nonEmptyString(o.runtimeDir) && isAbsolute(o.runtimeDir) ? resolve(o.runtimeDir) : dir;
  const modelDir = isAbsolute(o.modelDir) ? rebase(resolve(o.modelDir), recordedDir, dir) : resolve(dir, o.modelDir);
  const workerVersion = typeof o.workerVersion === 'string' ? o.workerVersion : null;

  return { node: o.node, runtimeDir: dir, modelDir, model: o.model, chunkMs: o.chunkMs, workerVersion };
}

/** `major.minor` of a version, or null when it does not start like one. */
function majorMinor(version: string | null): string | null {
  const found = /^\s*v?(\d+)\.(\d+)(?:\.|$|[^\d])/.exec(version ?? '');
  return found ? `${Number(found[1])}.${Number(found[2])}` : null;
}

/**
 * Whether a runtime set up by plugin version `worker` should be set up again
 * for plugin version `plugin`: the two differ in major.minor. The worker is
 * copied into the runtime only by the setup, so a plugin updated since runs a
 * worker written for another release. A record without a version (null) is
 * from before versions were recorded, or from a checkout, and counts as
 * outdated. A plugin whose own version cannot be read asks for nothing.
 */
export function workerOutdated(worker: string | null, plugin: string): boolean {
  const have = majorMinor(worker);
  if (have === null) return true;
  const want = majorMinor(plugin);
  return want !== null && have !== want;
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
    // Obsidian is Electron: what it sets for itself is not ours to pass on to the user's real Node.
    if (key.startsWith(ELECTRON_PREFIX) || DROPPED_ENV.has(key) || value === undefined) continue;
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
