import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  REAL_DEPS,
  SELF_RELOAD_MARK,
  SETTLE_MS,
  reloadBlocker,
  startSelfReload,
  type SelfReloadDeps,
} from '../src/host/selfReload.ts';
import { initialState } from '../src/session/initialState.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import type { HamsterState, MeetingState, QaEntry, Turn } from '../src/types.ts';

/* A development build loads the next one by itself, but never at a moment that would cost a
   meeting: the decision, then the watcher with a fake folder and fake timers, then once with a
   real folder. */

const DAILY = { path: '00 Inbox/2026-10-14.md', basename: '2026-10-14', date: '2026-10-14', exists: true };
const idle = (): HamsterState => initialState(DEFAULT_SETTINGS, DAILY);
const TURN = { id: 't1', source: 'mic', t0: 0, t1: 1, text: 'bonjour' } as unknown as Turn;
const meeting = (companionPath: string | null, detached: string[] = []): MeetingState =>
  ({ key: 'manual:1', title: 'Meeting', companionPath, detachedRegions: detached }) as unknown as MeetingState;

const build = (n: number): string => `magical-hamster-build:${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

describe('reloadBlocker', () => {
  test('nothing in the way when the sidebar is idle', () => {
    assert.equal(reloadBlocker(idle()), null);
  });

  test('a recording, or any meeting with speech, holds the reload until the meeting is over', () => {
    const meetingOpen = /stop the recording, then press End or open another meeting/;
    assert.match(reloadBlocker({ ...idle(), recording: 'starting' }) ?? '', meetingOpen);
    assert.match(reloadBlocker({ ...idle(), recording: 'recording' }) ?? '', meetingOpen);
    assert.match(reloadBlocker({ ...idle(), recording: 'stopping' }) ?? '', meetingOpen);
    assert.match(reloadBlocker({ ...idle(), meeting: meeting(null), turns: [TURN] }) ?? '', meetingOpen);
    // Saved, but its speech is this visit's: the next visit would have less to write from.
    assert.match(reloadBlocker({ ...idle(), meeting: meeting('00 Inbox/Mtg.md'), turns: [TURN] }) ?? '', meetingOpen);
    // Markers damaged in the note: the speech is nowhere but in memory.
    assert.match(
      reloadBlocker({ ...idle(), meeting: meeting('00 Inbox/Mtg.md', ['transcript']), turns: [TURN] }) ?? '',
      meetingOpen,
    );
  });

  test('the model at work, or writes on their way, hold it for a moment', () => {
    assert.match(reloadBlocker({ ...idle(), enhanceStatus: 'structuring' }) ?? '', /model/);
    const summary = { ...idle().summary, status: 'running' as const };
    assert.match(reloadBlocker({ ...idle(), summary }) ?? '', /model/);
    const qa = { entries: [{ status: 'running' } as unknown as QaEntry], chips: [] };
    assert.match(reloadBlocker({ ...idle(), qa }) ?? '', /model/);
    assert.match(reloadBlocker({ ...idle(), pendingWrites: 2 }) ?? '', /notes are saved/);
  });

  test('a meeting without speech, or a finished Enhance, does not', () => {
    assert.equal(reloadBlocker({ ...idle(), meeting: meeting(null), turns: [] }), null);
    assert.equal(reloadBlocker({ ...idle(), meeting: meeting('00 Inbox/Mtg.md'), turns: [] }), null);
    assert.equal(reloadBlocker({ ...idle(), enhanceStatus: 'up-to-date' }), null);
    assert.equal(reloadBlocker({ ...idle(), enhanceStatus: 'error' }), null);
  });
});

/** A plugin folder in memory, with timers run by hand. `files['main.js']` is the build it names. */
function fakeFolder(files: Record<string, string>) {
  let onEvent: ((file: string | null) => void) | null = null;
  let watching = false;
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const name = (file: string): string => file.split(/[\\/]/).pop() ?? '';
  const deps: SelfReloadDeps = {
    watch(_dir, listener) {
      onEvent = listener;
      watching = true;
      return () => {
        watching = false;
      };
    },
    readBuildId: (file) => files[name(file)] ?? null,
    exists: (file) => name(file) in files,
    setTimeout(run) {
      const id = nextTimer++;
      timers.set(id, run);
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  return {
    deps,
    files,
    watching: () => watching,
    change(file: string | null, content?: string) {
      if (file && content !== undefined) files[file] = content;
      onEvent?.(file);
    },
    /** Runs the timers due: the settle delay is the only one. */
    settle() {
      const due = [...timers.values()];
      timers.clear();
      for (const run of due) run();
    },
    timerIds: () => [...timers.keys()],
  };
}

function harness(files: Record<string, string>, blocked: { reason: string | null } = { reason: null }) {
  const folder = fakeFolder(files);
  const notices: string[] = [];
  const listeners = new Set<() => void>();
  let reloads = 0;
  const watcher = startSelfReload({
    dir: '/vault/.obsidian/plugins/magical-hamster',
    buildId: build(1),
    deps: folder.deps,
    blocker: () => blocked.reason,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: (message) => notices.push(message),
    reload: async () => {
      reloads += 1;
    },
  });
  return {
    folder,
    watcher,
    notices,
    listeners,
    reloads: () => reloads,
    stateChanged: () => [...listeners].forEach((listener) => listener()),
  };
}

describe('startSelfReload', () => {
  test('watches nothing without .selfreload: a release never reloads itself', () => {
    const t = harness({ 'main.js': build(1) });
    assert.equal(t.watcher, null);
    assert.equal(t.folder.watching(), false);
    // The marker of the Hot Reload plugin is not ours.
    assert.equal(harness({ '.hotreload': '', 'main.js': build(1) }).watcher, null);
  });

  test('the build it started with, still on disk, is no reason to reload', () => {
    const t = harness({ '.selfreload': '', 'main.js': build(1) });
    assert.ok(t.watcher);
    t.folder.settle();
    assert.equal(t.reloads(), 0);
  });

  test('a new build loads once the install has settled, once', () => {
    const t = harness({ '.selfreload': '', 'main.js': build(1) });
    t.folder.settle();
    t.folder.change('main.js', build(2));
    t.folder.change('manifest.json');
    t.folder.change('styles.css');
    assert.equal(t.reloads(), 0, 'not while files are still being copied');
    assert.equal(t.folder.timerIds().length, 1, 'one timer, pushed back by each file');
    t.folder.settle();
    assert.equal(t.reloads(), 1);
    t.folder.change('main.js', build(3));
    t.folder.settle();
    assert.equal(t.reloads(), 1, 'the reload under way is the one that loads it');
  });

  test('a build installed while this one was starting is found without an event', () => {
    const t = harness({ '.selfreload': '', 'main.js': build(2) });
    t.folder.settle();
    assert.equal(t.reloads(), 1);
  });

  test('data.json written by the plugin, or a main.js naming no build, is no reason to reload', () => {
    const t = harness({ '.selfreload': '', 'main.js': build(1) });
    t.folder.settle();
    t.folder.change('data.json', '{}');
    assert.equal(t.folder.timerIds().length, 0);
    delete t.folder.files['main.js'];
    t.folder.change('main.js');
    t.folder.settle();
    t.folder.change(null);
    t.folder.settle();
    assert.equal(t.reloads(), 0, 'half written: waits for the next change');
    t.folder.change('main.js', build(2));
    t.folder.settle();
    assert.equal(t.reloads(), 1);
  });

  test('while a meeting would be lost it waits, says so, and loads when that is over', () => {
    const blocked = { reason: 'this meeting is over: stop the recording, then press End or open another meeting' as string | null };
    const t = harness({ '.selfreload': '', 'main.js': build(1) }, blocked);
    t.folder.settle();
    t.folder.change('main.js', build(2));
    t.folder.settle();
    assert.equal(t.reloads(), 0);
    assert.deepEqual(t.notices, [
      'A new build of Magical Hamster is installed. It loads once this meeting is over: stop the recording, then press End or open another meeting.',
    ]);

    t.folder.change('main.js', build(3));
    t.folder.settle();
    t.stateChanged();
    assert.equal(t.notices.length, 1, 'said once');
    assert.equal(t.folder.timerIds().length, 0, 'nothing scheduled while still blocked');

    blocked.reason = null;
    t.stateChanged();
    assert.equal(t.reloads(), 0, 'after the settle delay, not in the middle of a state change');
    t.folder.settle();
    assert.equal(t.reloads(), 1);
    assert.equal(t.listeners.size, 0, 'it stops listening to the state');
  });

  test('a short wait that turns into a meeting says so again', () => {
    const blocked = { reason: 'the model has answered' as string | null };
    const t = harness({ '.selfreload': '', 'main.js': build(2) }, blocked);
    t.folder.settle();
    blocked.reason = 'this meeting is over: stop the recording, then press End or open another meeting';
    t.folder.change('main.js', build(3));
    t.folder.settle();
    assert.equal(t.notices.length, 2);
    assert.match(t.notices[1], /press End/);
  });

  test('state changes once the way is clear do not put the reload off', () => {
    const blocked = { reason: 'the notes are saved' as string | null };
    const t = harness({ '.selfreload': '', 'main.js': build(2) }, blocked);
    t.folder.settle();
    blocked.reason = null;
    t.stateChanged();
    const [first] = t.folder.timerIds();
    for (let i = 0; i < 5; i++) t.stateChanged();
    assert.deepEqual(t.folder.timerIds(), [first], 'the same timer: an index build ticking away cannot hold it back');
    t.folder.settle();
    assert.equal(t.reloads(), 1);
  });

  test('dispose stops the watcher, the timer and the state listener', () => {
    const blocked = { reason: 'the model has answered' as string | null };
    const t = harness({ '.selfreload': '', 'main.js': build(1) }, blocked);
    t.folder.settle();
    t.folder.change('main.js', build(2));
    t.folder.settle();
    assert.equal(t.listeners.size, 1);
    t.folder.change('main.js', build(3));
    t.watcher?.dispose();
    assert.equal(t.folder.watching(), false);
    assert.equal(t.folder.timerIds().length, 0);
    assert.equal(t.listeners.size, 0);
    blocked.reason = null;
    t.folder.settle();
    assert.equal(t.reloads(), 0);
  });
});

describe('startSelfReload on a real folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hamster-reload-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('copying a new build into the folder reloads the plugin; data.json does not', async () => {
    writeFileSync(join(dir, 'main.js'), `var b = "${build(1)}";`);
    writeFileSync(join(dir, '.selfreload'), '');
    let reloads = 0;
    let resolveReload: () => void = () => undefined;
    const reloaded = new Promise<void>((resolve) => {
      resolveReload = resolve;
    });
    const watcher = startSelfReload({
      dir,
      buildId: build(1),
      deps: { ...REAL_DEPS, setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
      blocker: () => null,
      subscribe: () => () => undefined,
      notify: () => undefined,
      reload: async () => {
        reloads += 1;
        resolveReload();
      },
    });
    assert.ok(watcher);
    try {
      writeFileSync(join(dir, 'data.json'), '{}');
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 300));
      assert.equal(reloads, 0, 'the plugin writing its settings is not a new build');
      writeFileSync(join(dir, 'main.js'), `var b = "${build(2)}";`);
      const timeout = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('no reload within 5 s')), SETTLE_MS + 5000).unref();
      });
      await Promise.race([reloaded, timeout]);
      assert.equal(reloads, 1);
    } finally {
      watcher.dispose();
    }
  });
});

test('install-plugin looks for the same mark the bundle carries, and the build names itself', () => {
  const script = readFileSync(new URL('../scripts/install-plugin.mjs', import.meta.url), 'utf8');
  assert.ok(script.includes(`'${SELF_RELOAD_MARK}'`));
  const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  assert.match(config, /HAMSTER_DEV_BUILD === '1' \? JSON\.stringify\(`magical-hamster-build:\$\{randomUUID\(\)\}`\) : 'null'/);
});
