import { existsSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { App } from 'obsidian';
import type { HamsterState } from '../types.ts';

/* A development build reloads itself when a new one is installed beside it. Obsidian reads a
   plugin's main.js once, when the plugin is turned on, and never looks at it again: without this,
   `pnpm install:plugin` changes nothing until the plugin is turned off and on by hand.

   Only where `.selfreload` sits next to main.js: `pnpm install:plugin` puts it there, a release
   does not ship it. And never at a moment that would cost the user something. A reload starts the
   plugin afresh, so the open meeting's speech, held in memory for this visit, would be gone, even
   when its companion note was saved: the next visit has less to write from. So while a recording
   runs or a meeting with speech is open, while the model is answering, or while writes are on
   their way to a note, the new build waits, with a notice, and loads once that is over. */

/** Written into the bundle so that `install-plugin` can tell a build that reloads itself. */
export const SELF_RELOAD_MARK = 'magical-hamster:self-reload';
export const SELF_RELOAD_FILE = '.selfreload';
/** How a build names itself in its main.js (see vite.config.ts). */
const BUILD_ID = /magical-hamster-build:[0-9a-f-]{36}/;
/** The files an install writes; data.json, written by the plugin itself, is not one of them. */
const BUILD_FILES = new Set(['main.js', 'styles.css', 'manifest.json']);
/** An install copies three files one after the other: the reload waits for the last. */
export const SETTLE_MS = 750;

const MEETING_OPEN = 'this meeting is over: stop the recording, then press End or open another meeting';

/** Why the new build cannot load now, or null when nothing would be lost. Pure. */
export function reloadBlocker(state: HamsterState): string | null {
  if (state.recording !== 'idle' || (state.meeting !== null && state.turns.length > 0)) return MEETING_OPEN;
  const enhancing = state.enhanceStatus !== 'idle' && state.enhanceStatus !== 'up-to-date' && state.enhanceStatus !== 'error';
  const answering = state.qa.entries.some((entry) => entry.status === 'running');
  if (enhancing || state.summary.status === 'running' || answering) return 'the model has answered';
  if (state.pendingWrites > 0) return 'the notes are saved';
  return null;
}

export interface SelfReloadDeps {
  /** Calls `onEvent` with the name of a file that changed in `dir` (null when the system does not say). */
  watch(dir: string, onEvent: (file: string | null) => void): () => void;
  /** The build named in that main.js, or null when it names none (half written, or not a build of ours). */
  readBuildId(file: string): string | null;
  exists(file: string): boolean;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SelfReloadOptions {
  /** The plugin's folder, absolute. */
  dir: string;
  /** The build running now, as vite.config.ts named it. */
  buildId: string;
  deps?: SelfReloadDeps;
  /** Why it cannot reload now, or null. */
  blocker(): string | null;
  /** Called whenever what `blocker` depends on may have changed. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  notify(message: string): void;
  /** Turns the plugin off and on. Called at most once. */
  reload(): Promise<void>;
}

export const REAL_DEPS: SelfReloadDeps = {
  watch(dir, onEvent) {
    const watcher = watch(dir, (_event, file) => onEvent(typeof file === 'string' ? file : null));
    // A folder removed under the watcher (the plugin uninstalled) is not an error worth a crash.
    watcher.on('error', () => watcher.close());
    return () => watcher.close();
  },
  readBuildId(file) {
    try {
      return BUILD_ID.exec(readFileSync(file, 'utf8'))?.[0] ?? null;
    } catch {
      return null;
    }
  },
  exists: existsSync,
  setTimeout: (run, ms) => window.setTimeout(run, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

/**
 * Watches the plugin's folder and reloads the plugin when the main.js there is another build than
 * the one running. Returns null, and watches nothing, when the folder has no `.selfreload`.
 * `dispose` stops watching; a reload already under way goes on, since it is what disposes this.
 */
export function startSelfReload(opts: SelfReloadOptions): { mark: string; dispose(): void } | null {
  const deps = opts.deps ?? REAL_DEPS;
  if (!deps.exists(join(opts.dir, SELF_RELOAD_FILE))) return null;
  const mainJs = join(opts.dir, 'main.js');
  let timer: unknown = null;
  let waitingFor: string | null = null;
  let reloading = false;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;

  const tryReload = (): void => {
    if (disposed || reloading) return;
    const onDisk = deps.readBuildId(mainJs);
    // The same build, or one still being written.
    if (onDisk === null || onDisk === opts.buildId) return;
    const reason = opts.blocker();
    if (reason !== null) {
      // Said once, and again if it comes to wait for the meeting: the reason that lasts.
      if (waitingFor === null || (reason === MEETING_OPEN && waitingFor !== MEETING_OPEN)) {
        opts.notify(`A new build of Magical Hamster is installed. It loads once ${reason}.`);
      }
      waitingFor = reason;
      unsubscribe ??= opts.subscribe(() => {
        // Started by the first state change that clears the way, and not put off by the next ones.
        if (waitingFor !== null && timer === null && opts.blocker() === null) schedule();
      });
      return;
    }
    reloading = true;
    unsubscribe?.();
    unsubscribe = null;
    void opts.reload();
  };

  const schedule = (): void => {
    if (disposed || reloading) return;
    if (timer !== null) deps.clearTimeout(timer);
    timer = deps.setTimeout(() => {
      timer = null;
      tryReload();
    }, SETTLE_MS);
  };

  const stopWatching = deps.watch(opts.dir, (file) => {
    if (file === null || BUILD_FILES.has(file)) schedule();
  });
  // A build installed while this one was starting has already landed: no event will announce it.
  schedule();

  return {
    // Kept in the bundle for `install-plugin`, which looks for it in the build it replaces.
    mark: SELF_RELOAD_MARK,
    dispose() {
      disposed = true;
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
      stopWatching();
    },
  };
}

/** Obsidian's plugin manager: not in its published API, but what its own settings use. */
interface PluginManager {
  disablePlugin(id: string): Promise<unknown>;
  enablePlugin(id: string): Promise<unknown>;
}

export interface ReloadHost {
  app: App;
  id: string;
  /** The sidebar's view type: reopened if it was open and Obsidian did not bring it back. */
  viewType: string;
  notify(message: string): void;
  closeSession(): Promise<void>;
}

/**
 * Turns the plugin off and on, through Obsidian's own plugin manager, so the new main.js is read.
 * Kept here, with the watcher, so that a release build, which has neither, carries no use of an
 * API Obsidian does not publish.
 */
export async function reloadPlugin(host: ReloadHost): Promise<void> {
  const { app, id, viewType } = host;
  const plugins = (app as unknown as { plugins?: PluginManager }).plugins;
  if (typeof plugins?.disablePlugin !== 'function' || typeof plugins.enablePlugin !== 'function') {
    host.notify('a new build is installed. Turn the plugin off and on in Settings, Community plugins.');
    return;
  }
  const sidebarOpen = app.workspace.getLeavesOfType(viewType).length > 0;
  host.notify('loading the new build.');
  try {
    await host.closeSession();
    // This code belongs to the build being unloaded: it keeps running to the end of this function.
    await plugins.disablePlugin(id);
    await plugins.enablePlugin(id);
    if (sidebarOpen && app.workspace.getLeavesOfType(viewType).length === 0) {
      await app.workspace.ensureSideLeaf(viewType, 'right', { reveal: false });
    }
  } catch (error) {
    console.error('Magical Hamster: the new build could not be loaded', error);
    host.notify('the new build could not be loaded. Turn the plugin off and on in Settings, Community plugins; the console says why.');
  }
}
