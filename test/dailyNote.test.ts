import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { StateField, Transaction, TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';

import { normalizeStats as normalize } from '../src/llm/tokens.ts';
import { DEFAULT_LOCAL, DEFAULT_SETTINGS, softMarkerRegex, softMarkerUnsupported } from '../src/settings.ts';
import type { DailyUpdate, HamsterSettings, Stats } from '../src/types.ts';

/* Module I, the daily-note locator and the host adapters around it. Inside
   Obsidian these read its config, its vault and the disk; here `obsidian` is
   a stub (with the real Moment.js, which is what Obsidian hands out), the App
   is in memory, and the files that live outside the vault go to a temporary
   directory. */

// Moment is a dependency of the `obsidian` package, not of this repository.
const obsidianPackage = createRequire(import.meta.url).resolve('obsidian/package.json');

const OBSIDIAN_STUB = `
import { createRequire } from 'node:module';
import { StateField } from '@codemirror/state';
export const moment = createRequire(${JSON.stringify(obsidianPackage)})('moment');
export const editorInfoField = StateField.define({ create: () => null, update: (value) => value });
export const notices = [];
export class Notice {
  constructor(message, ms) { notices.push({ message, ms }); }
}
export class MarkdownView {
  constructor(file, editor, mode = 'source') { this.file = file; this.editor = editor; this.mode = mode; }
  getMode() { return this.mode; }
  getViewType() { return 'markdown'; }
}
export class Modal { constructor(app) { this.app = app; } }
export class ButtonComponent {}
// A text field, toggle, dropdown or button of a settings row: it keeps what it was given.
class Control {
  constructor() {
    this.value = undefined;
    this.placeholder = undefined;
    this.options = {};
    const listeners = {};
    this.inputEl = {
      addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
    };
    // As when the field loses the focus or a key is pressed in it.
    this.fire = (type, event = {}) => { for (const listener of listeners[type] ?? []) listener(event); };
    // Not in a document: the tab then leaves the list of microphones alone.
    this.selectEl = { isConnected: false };
    this.changed = () => undefined;
  }
  setValue(value) { this.value = value; return this; }
  setPlaceholder(placeholder) { this.placeholder = placeholder; return this; }
  onChange(callback) { this.changed = callback; return this; }
  addOption(value, label) { this.options[value] = label; return this; }
  addOptions(options) { Object.assign(this.options, options); return this; }
  setButtonText() { return this; }
  onClick() { return this; }
  // As when the user edits the field: the new value, then the callback.
  type(value) { this.value = value; this.changed(value); }
}
export class Setting {
  constructor(containerEl) {
    this.name = '';
    this.desc = '';
    this.error = null;
    this.controls = [];
    const classes = new Set();
    this.descEl = {
      classes,
      toggleClass(name, on) { if (on) classes.add(name); else classes.delete(name); },
    };
    containerEl.rows.push(this);
  }
  setName(name) { this.name = name; return this; }
  setDesc(desc) { this.desc = desc; return this; }
  setHeading() { return this; }
  setErrorMessage(message) { this.error = message; return this; }
  // Obsidian builds the control and hands it to the callback before returning.
  add(callback) { const control = new Control(); this.controls.push(control); callback(control); return this; }
  addText(callback) { return this.add(callback); }
  addTextArea(callback) { return this.add(callback); }
  addToggle(callback) { return this.add(callback); }
  addDropdown(callback) { return this.add(callback); }
  addButton(callback) { return this.add(callback); }
}
export class PluginSettingTab {
  constructor(app) {
    this.app = app;
    this.containerEl = { rows: [], empty() { this.rows.length = 0; } };
  }
  hide() {}
  // Obsidian redraws the open tab from the definitions after update(); the tests' drawTab does the same.
  update() {}
}
export class FileSystemAdapter {
  constructor(basePath) { this.basePath = basePath; }
  getBasePath() { return this.basePath; }
}
export function normalizePath(path) {
  const clean = path.replace(/[\\\\/]+/g, '/').replace(/^\\/+|\\/+$/g, '').replace(/[\\u00a0\\u202f]/g, ' ').normalize('NFC');
  return clean === '' ? '/' : clean;
}
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'obsidian') return { url: 'hamster-test:obsidian', shortCircuit: true };
    // The stub has no place on disk: what it imports is looked up from here.
    if (context.parentURL === 'hamster-test:obsidian') {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'hamster-test:obsidian') return { format: 'module', source: OBSIDIAN_STUB, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const obsidian = (await import('obsidian')) as unknown as {
  notices: Array<{ message: string; ms: number | undefined }>;
  FileSystemAdapter: new (basePath: string) => object;
  MarkdownView: new (file: { path: string } | null, editor: object) => object;
  editorInfoField: StateField<unknown>;
  Setting: new (containerEl: object) => { setName(name: string): { setHeading(): unknown } };
};
const { liveCaptureExtension } = await import('../src/editor/liveCapture.ts');
const { DEFAULT_DAILY_FORMAT, DailyNoteLocator, coreDailyEnabled, dailyPathFor, pickDailyConfig } = await import(
  '../src/editor/dailyNote.ts'
);
const { LOCAL_KEY, loadLocal, parseLocal, saveLocal } = await import('../src/host/localSettings.ts');
const { createStatsIO, mergeStats } = await import('../src/host/statsIO.ts');
const { createVaultIndexIO, inFolders, indexDirName } = await import('../src/host/vaultIndexIO.ts');
const { createNotesHost, linkedNoteText, pickerFolders, stripLinkedMentions } = await import(
  '../src/host/notesHost.ts'
);
const { TextTarget } = await import('../src/notes/textTarget.ts');
const { CompanionStore } = await import('../src/notes/companionStore.ts');
const { renderCompanion } = await import('../src/notes/companion.ts');
const {
  HamsterSettingTab,
  checkPrefix,
  checkSoftMarkerPattern,
  describeOllamaAddress,
  nodePathPlaceholder,
  parseFolderList,
  parseNumber,
  probeHeads,
} = await import('../src/settings-tab.ts');

/**
 * Draws a settings tab the way Obsidian 1.13 does: update(), then a heading row per group of
 * getSettingDefinitions() and each item rendered into a row of its own, in the stub's container.
 */
function drawTab(tab: InstanceType<typeof HamsterSettingTab>): void {
  tab.update();
  const containerEl = tab.containerEl as unknown as { empty(): void };
  containerEl.empty();
  for (const { heading, items } of tab.getSettingDefinitions()) {
    new obsidian.Setting(containerEl).setName(heading).setHeading();
    for (const item of items) item.render(new obsidian.Setting(containerEl) as never);
  }
}
const { resolveRuntimeDir } = await import('../src/host/runtime.ts');

type App = ConstructorParameters<typeof DailyNoteLocator>[0];

const scratch = mkdtempSync(join(tmpdir(), 'hamster-host-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let scratchCount = 0;
function scratchDir(): string {
  scratchCount += 1;
  return join(scratch, `case-${scratchCount}`);
}

interface FakeFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
  stat: { ctime: number; mtime: number; size: number };
}

class FakeApp {
  /** Vault notes and attachments. */
  readonly files = new Map<string, { file: FakeFile; data: string }>();
  readonly folders: string[] = [];
  /** Files only the adapter sees: Obsidian's own configuration. */
  readonly config = new Map<string, string>();
  /** Link text -> path, as the metadata cache would resolve it. */
  readonly links = new Map<string, string>();
  readonly local = new Map<string, string>();
  /** Every link the metadata cache was asked to resolve, and from which note. */
  readonly resolutions: Array<{ link: string; from: string }> = [];
  cachedReads = 0;
  private tick = 1;

  readonly vault = {
    configDir: '.obsidian',
    adapter: {
      exists: async (path: string): Promise<boolean> => this.config.has(path),
      read: async (path: string): Promise<string> => {
        const text = this.config.get(path);
        if (text === undefined) throw new Error('ENOENT');
        return text;
      },
    } as object,
    getName: (): string => 'Test Vault',
    getFileByPath: (path: string): FakeFile | null => this.files.get(path)?.file ?? null,
    getFolderByPath: (path: string): { path: string } | null =>
      this.folders.includes(path) ? { path } : null,
    getAbstractFileByPath: (path: string): object | null =>
      this.files.get(path)?.file ?? (this.folders.includes(path) ? { path } : null),
    getMarkdownFiles: (): FakeFile[] =>
      [...this.files.values()].map((entry) => entry.file).filter((file) => file.extension === 'md'),
    getAllFolders: (includeRoot = false): Array<{ path: string }> =>
      [...(includeRoot ? ['/'] : []), ...this.folders].map((path) => ({ path })),
    read: async (file: FakeFile): Promise<string> => this.files.get(file.path)?.data ?? '',
    cachedRead: async (file: FakeFile): Promise<string> => {
      this.cachedReads += 1;
      const entry = this.files.get(file.path);
      if (!entry) throw new Error('ENOENT');
      return entry.data;
    },
    process: async (file: FakeFile, fn: (data: string) => string): Promise<string> => {
      const entry = this.files.get(file.path);
      if (!entry) throw new Error('ENOENT');
      const next = fn(entry.data);
      if (next !== entry.data) this.edit(file.path, next);
      return next;
    },
    create: async (path: string, data: string): Promise<FakeFile> => this.add(path, data),
    createFolder: async (path: string): Promise<void> => {
      this.folders.push(path);
    },
  };

  /** Obsidian's "Default location for new notes", as a folder path; '/' is the vault root. */
  newNoteFolder = '/';

  readonly fileManager = {
    getNewFileParent: (): { path: string } => ({ path: this.newNoteFolder }),
  };

  readonly workspace = {
    getLeavesOfType: (): object[] => [],
    getMostRecentLeaf: (): null => null,
  };

  readonly metadataCache = {
    getFileCache: (): null => null,
    getFirstLinkpathDest: (link: string, from: string): FakeFile | null => {
      this.resolutions.push({ link, from });
      const path = this.links.get(link);
      return path === undefined ? null : (this.files.get(path)?.file ?? null);
    },
  };

  loadLocalStorage = (key: string): unknown => {
    const text = this.local.get(key);
    return text === undefined ? null : (JSON.parse(text) as unknown);
  };

  saveLocalStorage = (key: string, value: unknown): void => {
    this.local.set(key, JSON.stringify(value));
  };

  add(path: string, data: string): FakeFile {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    const stamp = this.tick++;
    const file: FakeFile = {
      path,
      name,
      basename: dot < 0 ? name : name.slice(0, dot),
      extension: dot < 0 ? '' : name.slice(dot + 1),
      stat: { ctime: stamp, mtime: stamp, size: data.length },
    };
    this.files.set(path, { file, data });
    return file;
  }

  edit(path: string, data: string): void {
    const entry = this.files.get(path);
    assert.ok(entry);
    entry.data = data;
    entry.file.stat.mtime = this.tick++;
  }

  get app(): App {
    return this as unknown as App;
  }
}

const AFTERNOON = new Date(2026, 9, 9, 15, 30);

describe('dailyPathFor', () => {
  it('puts the note at the vault root for an empty folder', () => {
    assert.deepEqual(dailyPathFor('', '2026-10-09'), { path: '2026-10-09.md', basename: '2026-10-09' });
    assert.deepEqual(dailyPathFor('/', '2026-10-09'), { path: '2026-10-09.md', basename: '2026-10-09' });
    assert.deepEqual(dailyPathFor('   ', '2026-10-09'), { path: '2026-10-09.md', basename: '2026-10-09' });
  });

  it('joins the folder and the name', () => {
    assert.deepEqual(dailyPathFor('00 Inbox', '2026-10-09'), {
      path: '00 Inbox/2026-10-09.md',
      basename: '2026-10-09',
    });
  });

  it('ignores a trailing or a leading slash on the folder', () => {
    const expected = { path: '00 Inbox/2026-10-09.md', basename: '2026-10-09' };
    assert.deepEqual(dailyPathFor('00 Inbox/', '2026-10-09'), expected);
    assert.deepEqual(dailyPathFor('/00 Inbox', '2026-10-09'), expected);
    assert.deepEqual(dailyPathFor('/00 Inbox//', '2026-10-09'), expected);
    assert.deepEqual(dailyPathFor('  00 Inbox  ', '2026-10-09'), expected);
  });

  it('keeps the folders of a nested format and takes the last segment as the basename', () => {
    assert.deepEqual(dailyPathFor('Journal', '2026/10/2026-10-09'), {
      path: 'Journal/2026/10/2026-10-09.md',
      basename: '2026-10-09',
    });
    assert.deepEqual(dailyPathFor('', '2026/10/2026-10-09'), {
      path: '2026/10/2026-10-09.md',
      basename: '2026-10-09',
    });
    assert.deepEqual(dailyPathFor('', '/2026/10/09/'), { path: '2026/10/09.md', basename: '09' });
  });

  it('accepts a nested folder, written with either slash', () => {
    assert.deepEqual(dailyPathFor('Journal/Daily', '2026-10-09'), {
      path: 'Journal/Daily/2026-10-09.md',
      basename: '2026-10-09',
    });
    assert.deepEqual(dailyPathFor('Journal\\Daily', '2026-10-09').path, 'Journal/Daily/2026-10-09.md');
  });

  it('keeps a name with spaces and dots as it is', () => {
    assert.deepEqual(dailyPathFor('Daily', 'Friday, October 9th 2026'), {
      path: 'Daily/Friday, October 9th 2026.md',
      basename: 'Friday, October 9th 2026',
    });
    assert.deepEqual(dailyPathFor('', '09.10.2026').path, '09.10.2026.md');
  });
});

describe('pickDailyConfig', () => {
  /** The core plugin with nothing set: no folder of its own, so the daily goes where new notes go. */
  const coreDefaults = { folder: '', format: 'YYYY-MM-DD', newNoteLocation: true };

  it('uses the core plugin when its config exists', () => {
    assert.deepEqual(pickDailyConfig({ folder: '00 Inbox', format: 'YYYY/MM/YYYY-MM-DD' }, null), {
      folder: '00 Inbox',
      format: 'YYYY/MM/YYYY-MM-DD',
      newNoteLocation: true,
    });
  });

  it('fills in what the core config leaves out', () => {
    assert.deepEqual(pickDailyConfig({ folder: '00 Inbox' }, null), {
      folder: '00 Inbox',
      format: DEFAULT_DAILY_FORMAT,
      newNoteLocation: true,
    });
    assert.deepEqual(pickDailyConfig({ format: '  ' }, null), coreDefaults);
    assert.deepEqual(pickDailyConfig({}, null), coreDefaults);
    assert.deepEqual(pickDailyConfig({ folder: 7, format: ['x'] }, null), coreDefaults);
  });

  it('prefers the core plugin over Periodic Notes', () => {
    const periodic = { daily: { enabled: true, folder: 'Periodic', format: 'DD-MM-YYYY' } };
    assert.deepEqual(pickDailyConfig({ folder: 'Core' }, periodic), {
      folder: 'Core',
      format: 'YYYY-MM-DD',
      newNoteLocation: true,
    });
  });

  it('falls back to Periodic Notes when the core plugin has no config', () => {
    const periodic = { daily: { enabled: true, folder: 'Periodic/', format: 'DD-MM-YYYY' } };
    assert.deepEqual(pickDailyConfig(null, periodic), {
      folder: 'Periodic/',
      format: 'DD-MM-YYYY',
      newNoteLocation: false,
    });
    assert.deepEqual(pickDailyConfig(null, { daily: { folder: 'P' } }), {
      folder: 'P',
      format: 'YYYY-MM-DD',
      newNoteLocation: false,
    });
  });

  it('knows that an empty folder is the vault root for Periodic Notes only', () => {
    assert.equal(pickDailyConfig({ format: 'YYYY-MM-DD' }, null).newNoteLocation, true);
    assert.equal(pickDailyConfig(null, null).newNoteLocation, true);
    assert.deepEqual(pickDailyConfig(null, { daily: { enabled: true } }), {
      folder: '',
      format: 'YYYY-MM-DD',
      newNoteLocation: false,
    });
  });

  it('ignores Periodic Notes when its daily notes are switched off or absent', () => {
    assert.deepEqual(pickDailyConfig(null, { daily: { enabled: false, folder: 'Periodic' } }), coreDefaults);
    assert.deepEqual(pickDailyConfig(null, { weekly: { enabled: true, folder: 'W' } }), coreDefaults);
    assert.deepEqual(pickDailyConfig(null, null), coreDefaults);
  });

  it('treats anything that is not an object as missing', () => {
    assert.deepEqual(pickDailyConfig('text', 12), coreDefaults);
    assert.deepEqual(pickDailyConfig([], []), coreDefaults);
    assert.deepEqual(pickDailyConfig(undefined, undefined), coreDefaults);
  });

  it('hands out a config of its own each time', () => {
    const first = pickDailyConfig(null, null);
    first.folder = 'changed';
    assert.deepEqual(pickDailyConfig(null, null), coreDefaults);
  });

  it('asks Periodic Notes first when the core plugin is switched off', () => {
    const leftover = { folder: 'Daily' };
    const periodic = { daily: { enabled: true, folder: 'Journal/2026', format: 'YYYY-MM-DD dddd' } };
    assert.deepEqual(pickDailyConfig(leftover, periodic, false), {
      folder: 'Journal/2026',
      format: 'YYYY-MM-DD dddd',
      newNoteLocation: false,
    });
    // Switched on, the core plugin still comes first.
    assert.equal(pickDailyConfig(leftover, periodic, true).folder, 'Daily');
    assert.equal(pickDailyConfig(leftover, periodic).folder, 'Daily');
  });

  it('keeps to the file the core plugin left behind when nothing else says where the notes are', () => {
    const leftover = { folder: 'Daily', format: 'DD-MM-YYYY' };
    const kept = { folder: 'Daily', format: 'DD-MM-YYYY', newNoteLocation: true };
    assert.deepEqual(pickDailyConfig(leftover, null, false), kept);
    assert.deepEqual(pickDailyConfig(leftover, { daily: { enabled: false, folder: 'P' } }, false), kept);
    assert.deepEqual(pickDailyConfig(leftover, { weekly: { enabled: true } }, false), kept);
    assert.deepEqual(pickDailyConfig(null, null, false), coreDefaults);
  });
});

describe('coreDailyEnabled', () => {
  it('reads the map of core plugins Obsidian writes', () => {
    assert.equal(coreDailyEnabled({ 'file-explorer': true, 'daily-notes': false }), false);
    assert.equal(coreDailyEnabled({ 'file-explorer': true, 'daily-notes': true }), true);
  });

  it('reads the list of enabled plugins older vaults have', () => {
    assert.equal(coreDailyEnabled(['file-explorer', 'daily-notes']), true);
    assert.equal(coreDailyEnabled(['file-explorer', 'templates']), false);
    assert.equal(coreDailyEnabled([]), false);
  });

  it('counts the plugin as on when the file does not say: it is on until switched off', () => {
    assert.equal(coreDailyEnabled(null), true);
    assert.equal(coreDailyEnabled(undefined), true);
    assert.equal(coreDailyEnabled('daily-notes'), true);
    assert.equal(coreDailyEnabled({ 'file-explorer': true }), true, 'no entry for it');
    assert.equal(coreDailyEnabled({ 'daily-notes': 'no' }), true, 'only a plain false switches it off');
  });
});

describe('DailyNoteLocator', () => {
  it('uses Obsidian\'s defaults before any config is read', () => {
    const fake = new FakeApp();
    const locator = new DailyNoteLocator(fake.app);
    assert.deepEqual(locator.today(AFTERNOON), {
      path: '2026-10-09.md',
      basename: '2026-10-09',
      date: '2026-10-09',
      exists: false,
    });
  });

  it('reads the core daily-notes config', async () => {
    const fake = new FakeApp();
    fake.config.set('.obsidian/daily-notes.json', JSON.stringify({ folder: '00 Inbox', autorun: true }));
    const locator = new DailyNoteLocator(fake.app);
    await locator.load();

    assert.deepEqual(locator.today(AFTERNOON), {
      path: '00 Inbox/2026-10-09.md',
      basename: '2026-10-09',
      date: '2026-10-09',
      exists: false,
    });
    fake.add('00 Inbox/2026-10-09.md', '### 1:1 Jane Example\n');
    assert.equal(locator.today(AFTERNOON).exists, true);
  });

  it('follows a format with folders: the basename is the last segment, the date stays ISO', async () => {
    const fake = new FakeApp();
    fake.config.set(
      '.obsidian/daily-notes.json',
      JSON.stringify({ folder: 'Journal', format: 'YYYY/MM/YYYY-MM-DD' }),
    );
    const locator = new DailyNoteLocator(fake.app);
    await locator.load();
    assert.deepEqual(locator.today(AFTERNOON), {
      path: 'Journal/2026/10/2026-10-09.md',
      basename: '2026-10-09',
      date: '2026-10-09',
      exists: false,
    });
  });

  it('looks where Obsidian puts new notes when the core plugin has no folder of its own', async () => {
    const fake = new FakeApp();
    fake.newNoteFolder = '00 Inbox';
    const locator = new DailyNoteLocator(fake.app);
    assert.equal(locator.today(AFTERNOON).path, '00 Inbox/2026-10-09.md', 'before any config is read');

    fake.config.set('.obsidian/daily-notes.json', JSON.stringify({ format: 'YYYY/YYYY-MM-DD' }));
    await locator.load();
    assert.equal(locator.today(AFTERNOON).path, '00 Inbox/2026/2026-10-09.md');

    // The setting is read each time: nothing announces a change to it.
    fake.newNoteFolder = '/';
    assert.equal(locator.today(AFTERNOON).path, '2026/2026-10-09.md');
    fake.newNoteFolder = 'Notes/New';
    assert.equal(locator.today(AFTERNOON).path, 'Notes/New/2026/2026-10-09.md');
  });

  it('keeps to the folder the core plugin names, wherever new notes go', async () => {
    const fake = new FakeApp();
    fake.newNoteFolder = '00 Inbox';
    fake.config.set('.obsidian/daily-notes.json', JSON.stringify({ folder: 'Journal' }));
    const locator = new DailyNoteLocator(fake.app);
    await locator.load();
    assert.equal(locator.today(AFTERNOON).path, 'Journal/2026-10-09.md');

    fake.config.set('.obsidian/daily-notes.json', JSON.stringify({ folder: '/' }));
    await locator.load();
    assert.equal(locator.today(AFTERNOON).path, '2026-10-09.md', 'the root, when the root is what was chosen');
  });

  it('uses the vault root for Periodic Notes without a folder, wherever new notes go', async () => {
    const fake = new FakeApp();
    fake.newNoteFolder = '00 Inbox';
    fake.config.set(
      '.obsidian/plugins/periodic-notes/data.json',
      JSON.stringify({ daily: { enabled: true, format: 'DD-MM-YYYY' } }),
    );
    const locator = new DailyNoteLocator(fake.app);
    await locator.load();
    assert.equal(locator.today(AFTERNOON).path, '09-10-2026.md');
  });

  it('falls back to the vault root when Obsidian cannot say where new notes go', () => {
    const fake = new FakeApp();
    fake.fileManager.getNewFileParent = () => {
      throw new Error('not ready');
    };
    assert.equal(new DailyNoteLocator(fake.app).today(AFTERNOON).path, '2026-10-09.md');
  });

  it('keeps the date ISO whatever the note is called', async () => {
    const fake = new FakeApp();
    fake.config.set('.obsidian/daily-notes.json', JSON.stringify({ format: 'dddd, MMMM Do YYYY' }));
    const locator = new DailyNoteLocator(fake.app);
    await locator.load();
    const today = locator.today(AFTERNOON);
    assert.equal(today.path, 'Friday, October 9th 2026.md');
    assert.equal(today.basename, 'Friday, October 9th 2026');
    assert.equal(today.date, '2026-10-09');
  });

  it('uses the local calendar day, up to the last minute of it', () => {
    const fake = new FakeApp();
    const locator = new DailyNoteLocator(fake.app);
    assert.equal(locator.today(new Date(2026, 9, 9, 23, 59, 59)).date, '2026-10-09');
    assert.equal(locator.today(new Date(2026, 9, 10, 0, 0, 0)).date, '2026-10-10');
    assert.equal(locator.today(new Date(2026, 0, 1, 0, 0, 1)).path, '2026-01-01.md');
  });

  it('falls back to Periodic Notes when the core plugin has no config file', async () => {
    const fake = new FakeApp();
    fake.config.set(
      '.obsidian/plugins/periodic-notes/data.json',
      JSON.stringify({ daily: { enabled: true, folder: 'Periodic', format: 'DD-MM-YYYY' } }),
    );
    const locator = new DailyNoteLocator(fake.app);
    await locator.load();
    assert.equal(locator.today(AFTERNOON).path, 'Periodic/09-10-2026.md');
    assert.equal(locator.today(AFTERNOON).date, '2026-10-09');
  });

  it('treats a config file that is not valid JSON as missing', async () => {
    const fake = new FakeApp();
    fake.config.set('.obsidian/daily-notes.json', '{ "folder": "00 Inb');
    fake.config.set(
      '.obsidian/plugins/periodic-notes/data.json',
      JSON.stringify({ daily: { folder: 'Periodic' } }),
    );
    const locator = new DailyNoteLocator(fake.app);
    await locator.load();
    assert.equal(locator.today(AFTERNOON).path, 'Periodic/2026-10-09.md');
  });

  it('picks up a changed config on the next load', async () => {
    const fake = new FakeApp();
    fake.config.set('.obsidian/daily-notes.json', JSON.stringify({ folder: '00 Inbox' }));
    const locator = new DailyNoteLocator(fake.app);
    await locator.load();
    fake.config.set('.obsidian/daily-notes.json', JSON.stringify({ folder: 'Journal' }));
    assert.equal(locator.today(AFTERNOON).path, '00 Inbox/2026-10-09.md');
    await locator.load();
    assert.equal(locator.today(AFTERNOON).path, 'Journal/2026-10-09.md');
    fake.config.delete('.obsidian/daily-notes.json');
    await locator.load();
    assert.equal(locator.today(AFTERNOON).path, '2026-10-09.md');
  });

  it('names the three config files to watch, under the vault\'s own config folder', () => {
    const fake = new FakeApp();
    fake.vault.configDir = '.config';
    assert.deepEqual(new DailyNoteLocator(fake.app).configPaths(), [
      '.config/daily-notes.json',
      '.config/plugins/periodic-notes/data.json',
      '.config/core-plugins.json',
    ]);
  });

  it('follows Periodic Notes when the core plugin was switched off and left its config behind', async () => {
    const fake = new FakeApp();
    fake.newNoteFolder = '00 Inbox';
    fake.config.set('.obsidian/core-plugins.json', JSON.stringify({ 'file-explorer': true, 'daily-notes': false }));
    fake.config.set('.obsidian/daily-notes.json', JSON.stringify({ folder: 'Daily' }));
    fake.config.set(
      '.obsidian/plugins/periodic-notes/data.json',
      JSON.stringify({ daily: { enabled: true, folder: 'Journal/2026', format: 'YYYY-MM-DD dddd' } }),
    );
    fake.add('Journal/2026/2026-10-09 Friday.md', '### 1:1 Jane Example\n');
    const locator = new DailyNoteLocator(fake.app);
    await locator.load();
    assert.deepEqual(locator.today(AFTERNOON), {
      path: 'Journal/2026/2026-10-09 Friday.md',
      basename: '2026-10-09 Friday',
      date: '2026-10-09',
      exists: true,
    });

    // The older form of the file: the list of the core plugins that are on.
    fake.config.set('.obsidian/core-plugins.json', JSON.stringify(['file-explorer', 'templates']));
    await locator.load();
    assert.equal(locator.today(AFTERNOON).path, 'Journal/2026/2026-10-09 Friday.md');

    // Without a folder, Periodic Notes means the vault root, not where new notes go.
    fake.config.set(
      '.obsidian/plugins/periodic-notes/data.json',
      JSON.stringify({ daily: { enabled: true } }),
    );
    await locator.load();
    assert.equal(locator.today(AFTERNOON).path, '2026-10-09.md');
  });

  it('keeps to the core plugin when it is on, whatever Periodic Notes holds', async () => {
    const fake = new FakeApp();
    fake.config.set('.obsidian/daily-notes.json', JSON.stringify({ folder: 'Daily' }));
    fake.config.set(
      '.obsidian/plugins/periodic-notes/data.json',
      JSON.stringify({ daily: { enabled: true, folder: 'Journal' } }),
    );
    const locator = new DailyNoteLocator(fake.app);
    for (const corePlugins of [null, '{ "daily-notes": tr', { 'daily-notes': true }, ['daily-notes'], { 'file-explorer': true }]) {
      if (corePlugins === null) fake.config.delete('.obsidian/core-plugins.json');
      else {
        fake.config.set(
          '.obsidian/core-plugins.json',
          typeof corePlugins === 'string' ? corePlugins : JSON.stringify(corePlugins),
        );
      }
      await locator.load();
      assert.equal(locator.today(AFTERNOON).path, 'Daily/2026-10-09.md', JSON.stringify(corePlugins));
    }
  });

  it('still uses what the switched-off core plugin left behind when Periodic Notes says nothing', async () => {
    const fake = new FakeApp();
    fake.config.set('.obsidian/core-plugins.json', JSON.stringify({ 'daily-notes': false }));
    fake.config.set('.obsidian/daily-notes.json', JSON.stringify({ folder: 'Daily' }));
    const locator = new DailyNoteLocator(fake.app);
    await locator.load();
    assert.equal(locator.today(AFTERNOON).path, 'Daily/2026-10-09.md', 'no Periodic Notes at all');

    fake.config.set(
      '.obsidian/plugins/periodic-notes/data.json',
      JSON.stringify({ daily: { enabled: false, folder: 'Journal' } }),
    );
    await locator.load();
    assert.equal(locator.today(AFTERNOON).path, 'Daily/2026-10-09.md', 'its daily notes switched off');
  });

  it('falls back to the plain date when the format produces no name', async () => {
    const fake = new FakeApp();
    fake.config.set('.obsidian/daily-notes.json', JSON.stringify({ format: '[/]' }));
    const locator = new DailyNoteLocator(fake.app);
    await locator.load();
    assert.equal(locator.today(AFTERNOON).path, '2026-10-09.md');
  });
});

describe('liveCaptureExtension', () => {
  const DAILY = '00 Inbox/2026-10-09.md';
  const globals = globalThis as { window?: unknown };
  let savedWindow: unknown;
  /** Callbacks waiting for the next animation frame, and for the fallback timer. */
  let frames: Array<(() => void) | null> = [];
  let timers: Array<(() => void) | null> = [];

  beforeEach(() => {
    savedWindow = globals.window;
    frames = [];
    timers = [];
    globals.window = {
      requestAnimationFrame: (fn: () => void): number => frames.push(fn) - 1,
      cancelAnimationFrame: (id: number): void => {
        frames[id] = null;
      },
      setTimeout: (fn: () => void): number => timers.push(fn) - 1,
      clearTimeout: (id: number): void => {
        timers[id] = null;
      },
    };
  });
  afterEach(() => {
    globals.window = savedWindow;
  });

  function nextFrame(): void {
    const due = frames;
    frames = [];
    for (const fn of due) fn?.();
  }

  /** One editor: a real CodeMirror state with Obsidian's file info, driven by real transactions. */
  class Pane {
    readonly view: object;
    readonly listener: (update: ViewUpdate) => void;
    state: EditorState;

    /**
     * `noteView` is given for an editor nested in a note: the view of the note's own editor.
     * `embed` makes the editor's owner something other than a Markdown view, as in a Canvas card.
     */
    constructor(
      extension: ReturnType<typeof liveCaptureExtension>,
      path: string | null,
      text: string,
      noteView?: object,
      embed = false,
    ) {
      this.view = { dispatch: () => undefined };
      const file = path === null ? null : { path };
      // `cm` is what Obsidian's Editor exposes at run time: the note's own CodeMirror view.
      const editor = { cm: noteView ?? this.view };
      const info = embed ? { file, editor } : new obsidian.MarkdownView(file, editor);
      this.state = EditorState.create({
        doc: text,
        extensions: [obsidian.editorInfoField.init(() => info), extension],
      });
      const listeners = this.state.facet(EditorView.updateListener);
      assert.equal(listeners.length, 1, 'the extension is one update listener');
      this.listener = listeners[0];
    }

    send(spec: TransactionSpec): Transaction {
      const tr = this.state.update(spec);
      this.state = tr.state;
      this.listener({
        view: this.view,
        state: tr.state,
        transactions: [tr],
        docChanged: tr.docChanged,
        selectionSet: tr.selection !== undefined,
      } as unknown as ViewUpdate);
      return tr;
    }

    type(text: string): void {
      const at = this.state.doc.length;
      this.send({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: 'input.type' });
    }
  }

  function setup(): { extension: ReturnType<typeof liveCaptureExtension>; touched: string[]; updates: DailyUpdate[] } {
    const touched: string[] = [];
    const updates: DailyUpdate[] = [];
    const extension = liveCaptureExtension({
      isDaily: (path) => path === DAILY,
      onTouch: (path) => touched.push(path),
      onDaily: (update) => updates.push(update),
    });
    return { extension, touched, updates };
  }

  it('reports typing in the daily once per frame, with the latest text and cursor', () => {
    const { extension, touched, updates } = setup();
    const pane = new Pane(extension, DAILY, '### 1:1 Jane Example\n');

    pane.type('b');
    pane.type('u');
    pane.type('d');
    assert.deepEqual([...updates], [], 'nothing before the frame');
    assert.deepEqual([...touched], [DAILY, DAILY, DAILY], 'every change is stamped at once');

    nextFrame();
    assert.deepEqual([...updates], [
      { path: DAILY, text: '### 1:1 Jane Example\nbud', cursor: 24, userTyped: true },
    ]);

    pane.type('g');
    nextFrame();
    assert.equal(updates.length, 2);
    assert.equal(updates[1].text, '### 1:1 Jane Example\nbudg');
  });

  it('stamps changes in any note, and reports only the daily', () => {
    const { extension, touched, updates } = setup();
    const other = new Pane(extension, '10 Projects/Alpha.md', 'alpha');
    other.type('!');
    nextFrame();
    assert.deepEqual([...touched], ['10 Projects/Alpha.md']);
    assert.deepEqual([...updates], []);
    assert.equal(frames.length + timers.length, 0, 'no frame is asked for another note');
  });

  it('reports a cursor move without stamping the note', () => {
    const { extension, touched, updates } = setup();
    const pane = new Pane(extension, DAILY, 'first\nsecond');
    pane.send({ selection: EditorSelection.cursor(8) });
    nextFrame();
    assert.deepEqual([...touched], []);
    assert.deepEqual([...updates], [{ path: DAILY, text: 'first\nsecond', cursor: 8, userTyped: false }]);
  });

  it('tells the user\'s typing and deleting from programmatic changes', () => {
    const { extension, updates } = setup();
    const pane = new Pane(extension, DAILY, 'text');

    pane.send({ changes: { from: 4, insert: '\n↳ [[Mtg-x|Meeting notes]]' }, userEvent: 'hamster' });
    nextFrame();
    pane.send({ changes: { from: 0, to: 1 }, userEvent: 'delete.backward' });
    nextFrame();
    pane.send({ changes: { from: 0, insert: 'pasted ' }, userEvent: 'input.paste' });
    nextFrame();
    pane.send({ changes: { from: 0, insert: 'synced ' } });
    nextFrame();
    pane.send({ changes: { from: 0, to: 7 }, userEvent: 'undo' });
    nextFrame();

    assert.deepEqual(
      updates.map((update) => update.userTyped),
      [false, true, true, false, false],
    );
    assert.ok(updates[0].text.endsWith('↳ [[Mtg-x|Meeting notes]]'), 'the plugin\'s own line is reported like any change');
  });

  it('keeps a keystroke that a later update in the same frame would hide', () => {
    const { extension, updates } = setup();
    const pane = new Pane(extension, DAILY, 'text');
    pane.type('!');
    pane.send({ selection: EditorSelection.cursor(0) });
    nextFrame();
    assert.deepEqual([...updates], [{ path: DAILY, text: 'text!', cursor: 0, userTyped: true }]);

    pane.send({ selection: EditorSelection.cursor(2) });
    nextFrame();
    assert.equal(updates[1].userTyped, false, 'and does not carry it into the next frame');
  });

  it('ignores an editor without a file', () => {
    const { extension, touched, updates } = setup();
    const pane = new Pane(extension, null, 'canvas card');
    pane.type('x');
    nextFrame();
    assert.deepEqual([...touched], []);
    assert.deepEqual([...updates], []);
  });

  it('does not take the text of a table cell for the text of the note', () => {
    const { extension, touched, updates } = setup();
    const note = new Pane(extension, DAILY, '| a | b |\n| - | - |\n| 1 | 2 |');
    // The cell editor carries the same file info, and its document is the cell alone.
    const cell = new Pane(extension, DAILY, '1', note.view);

    cell.type('0');
    assert.deepEqual([...touched], []);
    nextFrame();
    assert.deepEqual([...updates], [], 'the cell alone is never reported');

    // Obsidian then applies the cell's change to the note, without a user event.
    cell.type('0');
    note.send({ changes: { from: 23, insert: '00' } });
    nextFrame();
    assert.deepEqual([...touched], [DAILY]);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].text, '| a | b |\n| - | - |\n| 100 | 2 |');
    assert.equal(updates[0].userTyped, true, 'typing in a cell is typing in the note');
  });

  it('keeps the user event Obsidian passes on from a table cell', () => {
    const { extension, updates } = setup();
    const note = new Pane(extension, DAILY, '| a | b |\n| - | - |\n| 1 | 2 |');
    const cell = new Pane(extension, DAILY, '1', note.view);

    cell.send({ changes: { from: 1, to: 1, insert: '0' }, userEvent: 'input.type' });
    note.send({ changes: { from: 23, insert: '0' }, userEvent: 'input.type' });
    nextFrame();
    assert.deepEqual(updates.map((update) => update.userTyped), [true]);
    assert.equal(updates[0].text, '| a | b |\n| - | - |\n| 10 | 2 |');
  });

  it('does not take the text of an embed for the text of the note', () => {
    const { extension, touched, updates } = setup();
    // A Canvas card narrowed to one heading of the daily: the same file, a part of its text.
    const card = new Pane(extension, DAILY, '### 1:1 Jane Example\n- budget', undefined, true);

    card.type('s');
    card.send({ selection: EditorSelection.cursor(0) });
    nextFrame();
    assert.deepEqual([...touched], [DAILY], 'the edit still counts as one: the embed saves it like any editor');
    assert.deepEqual([...updates], []);
    assert.equal(frames.length + timers.length, 0, 'no frame is asked for it');
  });

  it('flushes on a timer when no animation frame comes (a hidden window)', () => {
    const { extension, updates } = setup();
    const pane = new Pane(extension, DAILY, 'text');
    pane.type('!');
    assert.equal(timers.length, 1);
    timers[0]?.();
    assert.equal(updates.length, 1);
    // The frame that was asked for is cancelled, so the update is not delivered twice.
    nextFrame();
    assert.equal(updates.length, 1);
  });

  it('never throws into the editor, whatever the callbacks do', () => {
    const extension = liveCaptureExtension({
      isDaily: () => true,
      onTouch: () => {
        throw new Error('touch failed');
      },
      onDaily: () => {
        throw new Error('daily failed');
      },
    });
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const pane = new Pane(extension, DAILY, 'text');
      pane.type('!');
      pane.send({ selection: EditorSelection.cursor(0) });
      nextFrame();
    } finally {
      console.error = original;
    }
    assert.ok(errors.length >= 2, 'the failures are logged');
  });
});

describe('local settings', () => {
  it('fills in the defaults when nothing is stored', () => {
    assert.deepEqual(parseLocal(null), DEFAULT_LOCAL);
    assert.deepEqual(parseLocal(undefined), DEFAULT_LOCAL);
    assert.deepEqual(parseLocal('not json'), DEFAULT_LOCAL);
    assert.deepEqual(parseLocal([1, 2]), DEFAULT_LOCAL);
  });

  it('keeps stored values and replaces the ones of the wrong type', () => {
    assert.deepEqual(
      parseLocal({ nodePath: '/usr/local/bin/node', runtimeDir: 5, micDeviceId: 'abc', firstWriteConfirmed: 'yes', debugTab: 1, extra: 1 }),
      { nodePath: '/usr/local/bin/node', runtimeDir: '', micDeviceId: 'abc', firstWriteConfirmed: false, debugTab: false },
    );
    assert.equal(parseLocal({ firstWriteConfirmed: true }).firstWriteConfirmed, true);
    assert.equal(parseLocal({ debugTab: true }).debugTab, true);
    assert.equal(parseLocal({ nodePath: '' }).nodePath, '', 'an emptied field stays empty');
  });

  it('leaves the Node path empty by default: the worker then runs with the Node the setup recorded', () => {
    assert.equal(DEFAULT_LOCAL.nodePath, '');
    assert.equal(parseLocal(null).nodePath, '');
    assert.equal(parseLocal({ runtimeDir: '/tmp/runtime' }).nodePath, '', 'also beside values that were stored');
    assert.equal(parseLocal({ nodePath: 7 }).nodePath, '');
  });

  it('accepts a value stored as a JSON string', () => {
    assert.equal(parseLocal(JSON.stringify({ micDeviceId: 'usb' })).micDeviceId, 'usb');
  });

  it('round-trips through Obsidian\'s vault-scoped storage, under its own key', () => {
    const fake = new FakeApp();
    assert.deepEqual(loadLocal(fake.app), DEFAULT_LOCAL);
    const value = { ...DEFAULT_LOCAL, runtimeDir: '/tmp/runtime', firstWriteConfirmed: true };
    saveLocal(fake.app, value);
    assert.deepEqual([...fake.local.keys()], [LOCAL_KEY]);
    assert.equal(LOCAL_KEY, 'magical-hamster:local');
    assert.deepEqual(loadLocal(fake.app), value);
  });
});

describe('stats file', () => {
  const stats: Stats = {
    input: 1200,
    output: 340,
    cached: 100,
    weekly: { '2026-10-05': { input: 1200, output: 340 } },
    meetings: 2,
    assists: 5,
  };

  it('loads null when there is no file or no directory', async () => {
    const io = createStatsIO(() => scratchDir());
    assert.equal(await io.load(), null);
  });

  it('saves and loads, creating the runtime directory', async () => {
    const dir = join(scratchDir(), 'deeper', 'runtime');
    const io = createStatsIO(() => dir);
    await io.save(stats);
    assert.deepEqual(await io.load(), stats);
    assert.deepEqual(readdirSync(dir), ['stats.json'], 'no temporary file is left behind');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8')), stats);
  });

  it('loads null for a corrupt file or one that is not an object', async () => {
    const dir = scratchDir();
    const io = createStatsIO(() => dir);
    await io.save(stats);
    writeFileSync(join(dir, 'stats.json'), '{ "input": 12');
    assert.equal(await io.load(), null);
    writeFileSync(join(dir, 'stats.json'), '[1, 2, 3]');
    assert.equal(await io.load(), null);
    writeFileSync(join(dir, 'stats.json'), 'null');
    assert.equal(await io.load(), null);
  });

  it('keeps the last of several saves started together', async () => {
    const dir = scratchDir();
    const io = createStatsIO(() => dir);
    await Promise.all([1, 2, 3, 4, 5].map((n) => io.save({ ...stats, assists: n })));
    assert.equal((await io.load())?.assists, 5);
    assert.deepEqual(readdirSync(dir), ['stats.json']);
  });

  it('follows a runtime directory that changes', async () => {
    const first = scratchDir();
    const second = scratchDir();
    let dir = first;
    const io = createStatsIO(() => dir);
    await io.save(stats);
    dir = second;
    assert.equal(await io.load(), null);
    await io.save({ ...stats, meetings: 9 });
    assert.equal((await io.load())?.meetings, 9);
    dir = first;
    assert.equal((await io.load())?.meetings, 2);
  });

  it('rejects when the directory cannot be made, and saves again afterwards', async () => {
    const dir = scratchDir();
    const blocker = join(dir, 'file');
    let target = join(blocker, 'runtime');
    const io = createStatsIO(() => target);
    await createStatsIO(() => dir).save(stats);
    writeFileSync(blocker, 'a file where a folder should be');
    await assert.rejects(io.save(stats));
    target = dir;
    await io.save({ ...stats, meetings: 3 });
    assert.equal((await io.load())?.meetings, 3);
  });
});

describe('stats file shared by several vault windows', () => {
  const week = '2026-10-05';
  const onDisk: Stats = {
    input: 1000,
    output: 300,
    cached: 50,
    weekly: { '2026-09-28': { input: 400, output: 100 }, [week]: { input: 600, output: 200 } },
    meetings: 4,
    assists: 9,
  };
  /** `from` after one more generation of `input` and `output` tokens in the current week. */
  function used(from: Stats, input: number, output: number): Stats {
    const before = from.weekly[week] ?? { input: 0, output: 0 };
    return {
      ...from,
      input: from.input + input,
      output: from.output + output,
      weekly: { ...from.weekly, [week]: { input: before.input + input, output: before.output + output } },
      assists: from.assists + 1,
    };
  }

  it('mergeStats adds what this session counted since its baseline to what the file holds now', () => {
    const baseline = onDisk;
    const current = { ...used(baseline, 797, 14), cached: 60, meetings: 5 };
    // Meanwhile another window added a week of its own and more of the current one.
    const disk: Stats = {
      input: 1777,
      output: 320,
      cached: 50,
      weekly: {
        '2026-09-28': { input: 400, output: 100 },
        [week]: { input: 1300, output: 215 },
        '2026-10-12': { input: 77, output: 5 },
      },
      meetings: 6,
      assists: 10,
    };
    assert.deepEqual(mergeStats(disk, baseline, current), {
      input: 2574,
      output: 334,
      cached: 60,
      weekly: {
        '2026-09-28': { input: 400, output: 100 },
        [week]: { input: 2097, output: 229 },
        '2026-10-12': { input: 77, output: 5 },
      },
      meetings: 7,
      assists: 11,
    });
  });

  it('mergeStats writes the session\'s own figures when nobody else touched the file', () => {
    const current = used(used(onDisk, 10, 2), 5, 1);
    assert.deepEqual(mergeStats(onDisk, onDisk, current), current);
    assert.deepEqual(mergeStats(onDisk, onDisk, onDisk), onDisk);
  });

  it('mergeStats starts a week the file does not have, and only when something was counted in it', () => {
    const empty: Stats = { input: 0, output: 0, cached: 0, weekly: {}, meetings: 0, assists: 0 };
    assert.deepEqual(mergeStats(empty, onDisk, used(onDisk, 30, 4)), {
      input: 30,
      output: 4,
      cached: 0,
      weekly: { [week]: { input: 30, output: 4 } },
      meetings: 0,
      assists: 1,
    });
  });

  it('mergeStats never takes anything away from the file', () => {
    const lower: Stats = { ...onDisk, input: 10, weekly: { [week]: { input: 1, output: 1 } }, meetings: 0 };
    assert.deepEqual(mergeStats(onDisk, onDisk, lower), onDisk);
  });

  it('mergeStats leaves its arguments as they were', () => {
    const disk = structuredClone(onDisk);
    const baseline = structuredClone(onDisk);
    const current = used(onDisk, 5, 5);
    const frozen = structuredClone(current);
    mergeStats(disk, baseline, current).weekly[week].input = -1;
    assert.deepEqual([disk, baseline, current], [onDisk, onDisk, frozen]);
  });

  it('keeps the tokens of two windows that share the folder', async () => {
    const dir = scratchDir();
    await createStatsIO(() => dir).save(onDisk);
    // Two vault windows are two plugins: each has a session and a stats file handle of its own.
    const first = createStatsIO(() => dir);
    const second = createStatsIO(() => dir);
    const inFirst = (await first.load()) as Stats;
    const inSecond = (await second.load()) as Stats;
    assert.deepEqual([inFirst, inSecond], [onDisk, onDisk]);

    await first.save(used(inFirst, 797, 14));
    await second.save(used(inSecond, 777, 9));

    const file = JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8')) as Stats;
    assert.equal(file.input, 1000 + 797 + 777);
    assert.equal(file.output, 300 + 14 + 9);
    assert.equal(file.assists, 9 + 2);
    assert.deepEqual(file.weekly[week], { input: 600 + 797 + 777, output: 200 + 14 + 9 });
    assert.deepEqual(file.weekly['2026-09-28'], { input: 400, output: 100 }, 'the history is kept');
  });

  it('counts each token once over many saves from both windows', async () => {
    const dir = scratchDir();
    const first = createStatsIO(() => dir);
    const second = createStatsIO(() => dir);
    let inFirst = normalize(await first.load());
    let inSecond = normalize(await second.load());
    for (let round = 0; round < 4; round++) {
      inFirst = used(inFirst, 100, 10);
      await first.save(inFirst);
      // The same figures saved again (a flush with nothing new) add nothing.
      await first.save(inFirst);
      inSecond = used(used(inSecond, 7, 1), 3, 1);
      await second.save(inSecond);
    }
    const file = JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8')) as Stats;
    assert.deepEqual(file, {
      input: 4 * 110,
      output: 4 * 12,
      cached: 0,
      weekly: { [week]: { input: 4 * 110, output: 4 * 12 } },
      meetings: 0,
      assists: 4 * 3,
    });
  });

  it('counts again what a failed save did not write', async () => {
    const dir = scratchDir();
    await createStatsIO(() => dir).save(onDisk);
    const blocker = join(dir, 'file');
    writeFileSync(blocker, 'a file where a folder should be');
    let target = dir;
    const io = createStatsIO(() => target);
    const loaded = (await io.load()) as Stats;

    target = join(blocker, 'runtime');
    await assert.rejects(io.save(used(loaded, 40, 4)));
    target = dir;
    await io.save(used(used(loaded, 40, 4), 2, 1));

    const file = JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8')) as Stats;
    assert.equal(file.input, 1042);
    assert.equal(file.assists, 11);
  });

  it('adds to a file that appeared after the session started, and never replaces it', async () => {
    const dir = scratchDir();
    const io = createStatsIO(() => dir);
    assert.equal(await io.load(), null);
    // Another window, or a runtime folder moved into place, wrote its history meanwhile.
    await createStatsIO(() => dir).save(onDisk);

    await io.save(used(normalize(null), 797, 14));

    const file = JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8')) as Stats;
    assert.equal(file.input, 1797);
    assert.equal(file.meetings, 4);
    assert.deepEqual(Object.keys(file.weekly).sort(), ['2026-09-28', week]);
  });

  it('writes the figures it holds when the file is gone or unreadable: nobody else\'s are there to keep', async () => {
    const dir = scratchDir();
    await createStatsIO(() => dir).save(onDisk);
    const io = createStatsIO(() => dir);
    const loaded = (await io.load()) as Stats;

    writeFileSync(join(dir, 'stats.json'), '{ "input": 12');
    const once = used(loaded, 5, 1);
    await io.save(once);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8')), once);

    rmSync(join(dir, 'stats.json'));
    const twice = used(once, 5, 1);
    await io.save(twice);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8')), twice);
  });
});

describe('index directory name', () => {
  it('is the vault name as a slug plus a hash of its location', () => {
    const name = indexDirName('My Vault 2026', '/Users/someone/Vaults/2026');
    assert.match(name, /^my-vault-2026-[0-9a-z]{8}$/);
    assert.equal(name, indexDirName('My Vault 2026', '/Users/someone/Vaults/2026'), 'stable');
  });

  it('differs for two vaults with the same name', () => {
    assert.notEqual(indexDirName('Notes', '/Users/a/Notes'), indexDirName('Notes', '/Users/b/Notes'));
  });

  it('is safe as a directory name', () => {
    assert.match(indexDirName('Coffre-fort Été / 2026: "work"', '/x'), /^coffre-fort-ete-2026-work-[0-9a-z]{8}$/);
    assert.match(indexDirName('', '/x'), /^vault-[0-9a-z]{8}$/);
    assert.match(indexDirName('日本語', '/x'), /^vault-[0-9a-z]{8}$/);
    const long = indexDirName('a'.repeat(200), '/x');
    assert.ok(long.length <= 49);
    assert.match(indexDirName('..', '/x'), /^vault-/);
  });
});

describe('inFolders', () => {
  it('selects everything for an empty folder or a slash', () => {
    assert.equal(inFolders('00 Inbox/a.md', [''], '.obsidian'), true);
    assert.equal(inFolders('a.md', ['/'], '.obsidian'), true);
  });

  it('selects nothing without folders', () => {
    assert.equal(inFolders('a.md', [], '.obsidian'), false);
  });

  it('matches whole folder names only', () => {
    assert.equal(inFolders('10 Projects/a.md', ['10 Projects'], '.obsidian'), true);
    assert.equal(inFolders('10 Projects/deep/er/a.md', ['10 Projects/'], '.obsidian'), true);
    assert.equal(inFolders('10 Projects 2/a.md', ['10 Projects'], '.obsidian'), false);
    assert.equal(inFolders('10 Projects.md', ['10 Projects'], '.obsidian'), false);
    assert.equal(inFolders('20 Areas/a.md', ['10 Projects', '/20 Areas/'], '.obsidian'), true);
  });

  it('never selects the config folder', () => {
    assert.equal(inFolders('.obsidian/plugins/x/readme.md', [''], '.obsidian'), false);
    assert.equal(inFolders('.config/readme.md', ['/'], '.config'), false);
    assert.equal(inFolders('.obsidian-notes/a.md', [''], '.obsidian'), true);
  });
});

describe('vault index files', () => {
  function vaultWithAdapter(basePath: string): FakeApp {
    const fake = new FakeApp();
    fake.vault.adapter = new obsidian.FileSystemAdapter(basePath);
    return fake;
  }

  it('lists the notes of the chosen folders with their modification time', async () => {
    const fake = vaultWithAdapter('/vaults/a');
    const inbox = fake.add('00 Inbox/a.md', 'a');
    fake.add('10 Projects/b.md', 'b');
    fake.add('10 Projects/diagram.png', '');
    fake.add('.obsidian/plugins/x/readme.md', 'config');
    const io = createVaultIndexIO(fake.app, () => scratchDir());

    assert.deepEqual(await io.listMarkdown(['00 Inbox']), [{ path: '00 Inbox/a.md', mtime: inbox.stat.mtime }]);
    assert.deepEqual(
      (await io.listMarkdown([''])).map((entry) => entry.path),
      ['00 Inbox/a.md', '10 Projects/b.md'],
    );
    assert.deepEqual(await io.listMarkdown([]), []);
  });

  it('reads a note, and rejects for one that is not in the vault', async () => {
    const fake = vaultWithAdapter('/vaults/a');
    fake.add('a.md', 'text of a');
    const io = createVaultIndexIO(fake.app, () => scratchDir());
    assert.equal(await io.read('a.md'), 'text of a');
    await assert.rejects(io.read('gone.md'), /not in the vault/);
  });

  it('loads null before anything was saved', async () => {
    const io = createVaultIndexIO(vaultWithAdapter('/vaults/a').app, () => scratchDir());
    assert.equal(await io.load(), null);
  });

  it('saves and loads the index and its vectors, byte for byte', async () => {
    const runtime = scratchDir();
    const fake = vaultWithAdapter('/vaults/a');
    const io = createVaultIndexIO(fake.app, () => runtime);
    const vectors = new Uint8Array(new Float32Array([0.25, -1.5, 3, 1e-9]).buffer);
    const index = JSON.stringify({ v: 1, note: 'été — 日本' });

    await io.save(index, vectors);
    const loaded = await io.load();

    assert.ok(loaded);
    assert.equal(loaded.index, index);
    assert.deepEqual([...loaded.vectors], [...vectors]);
    const dir = join(runtime, 'index', indexDirName('Test Vault', '/vaults/a'));
    assert.deepEqual(readdirSync(dir).sort(), ['index.json', 'vectors.bin'], 'no temporary file is left behind');
  });

  it('keeps one index per vault', async () => {
    const runtime = scratchDir();
    const a = createVaultIndexIO(vaultWithAdapter('/vaults/a').app, () => runtime);
    const b = createVaultIndexIO(vaultWithAdapter('/vaults/b').app, () => runtime);
    await a.save('{"vault":"a"}', new Uint8Array([1]));
    assert.equal(await b.load(), null);
    await b.save('{"vault":"b"}', new Uint8Array([2, 2]));
    assert.equal((await a.load())?.index, '{"vault":"a"}');
    assert.equal((await b.load())?.vectors.byteLength, 2);
  });

  it('replaces an earlier index, and keeps the last of several saves', async () => {
    const io = createVaultIndexIO(vaultWithAdapter('/vaults/a').app, () => scratchDirOnce());
    await Promise.all([
      io.save('{"n":1}', new Uint8Array([1])),
      io.save('{"n":2}', new Uint8Array([2, 2])),
      io.save('{"n":3}', new Uint8Array([3, 3, 3])),
    ]);
    const loaded = await io.load();
    assert.equal(loaded?.index, '{"n":3}');
    assert.deepEqual([...(loaded?.vectors ?? [])], [3, 3, 3]);
  });

  it('loads null when half of the index is missing', async () => {
    const runtime = scratchDir();
    const io = createVaultIndexIO(vaultWithAdapter('/vaults/a').app, () => runtime);
    await io.save('{}', new Uint8Array([1]));
    rmSync(join(runtime, 'index', indexDirName('Test Vault', '/vaults/a'), 'vectors.bin'));
    assert.equal(await io.load(), null);
  });

  it('works without a file-system adapter', async () => {
    const fake = new FakeApp();
    const runtime = scratchDir();
    const io = createVaultIndexIO(fake.app, () => runtime);
    await io.save('{}', new Uint8Array([7]));
    assert.deepEqual(readdirSync(join(runtime, 'index')), [indexDirName('Test Vault', 'Test Vault')]);
  });
});

let onceDir: string | null = null;
function scratchDirOnce(): string {
  onceDir ??= scratchDir();
  return onceDir;
}

describe('stripLinkedMentions', () => {
  it('removes the section up to the next heading of the same or a higher level', () => {
    const note = [
      '# Jane Example',
      'Director of things.',
      '',
      '## Linked mentions',
      '```dataviewjs',
      'dv.pages().forEach(() => {});',
      '```',
      '### An excerpt heading',
      'excerpt text',
      '## Role',
      'Owns the budget.',
    ].join('\n');
    assert.equal(
      stripLinkedMentions(note),
      ['# Jane Example', 'Director of things.', '', '## Role', 'Owns the budget.'].join('\n'),
    );
  });

  it('removes it to the end of the note when nothing follows', () => {
    assert.equal(stripLinkedMentions('intro\n## Linked mentions:\nquery\nmore'), 'intro');
    assert.equal(stripLinkedMentions('intro\n## **Linked Mentions**\nquery'), 'intro');
  });

  it('leaves a note without that section untouched', () => {
    const note = '# Title\r\ntext\r\n## Mentions\r\nkept\r\n';
    assert.equal(stripLinkedMentions(note), note);
  });

  it('does not read a heading inside a code block as the end of the section, nor as its start', () => {
    const inside = 'a\n## Linked mentions\n```\n## Not a heading\n```\nstill skipped\n## Next\nkept';
    assert.equal(stripLinkedMentions(inside), 'a\n## Next\nkept');
    const code = 'a\n```md\n## Linked mentions\n```\nkept';
    assert.equal(stripLinkedMentions(code), code);
  });

  it('does not take a sentence that mentions the words for the heading', () => {
    const note = '## Linked mentions and other things\nkept';
    assert.equal(stripLinkedMentions(note), note);
  });
});

describe('linkedNoteText', () => {
  it('drops the frontmatter and the linked mentions', () => {
    const note = '---\ntype: person\n---\n# Jane Example\nOwns the budget.\n\n## Linked mentions\nquery\n';
    assert.equal(linkedNoteText(note, 1000), '# Jane Example\nOwns the budget.');
  });

  it('never returns more than maxChars characters', () => {
    const note = `# Title\n${'word '.repeat(400)}`;
    for (const max of [1, 2, 10, 57, 200]) {
      const text = linkedNoteText(note, max);
      assert.ok(text.length <= max, `${text.length} > ${max}`);
      assert.ok(text.length > 0);
    }
    assert.equal(linkedNoteText(note, 0), '');
    assert.equal(linkedNoteText('short', 5), 'short');
  });
});

describe('pickerFolders', () => {
  it('keeps the first two levels, sorted, without the config folder', () => {
    assert.deepEqual(
      pickerFolders(
        ['20 Areas', '10 Projects/Alpha/Notes', '10 Projects', '.obsidian', '.obsidian/plugins', '10 Projects/Alpha', '/', '00 Inbox'],
        '.obsidian',
      ),
      ['00 Inbox', '10 Projects', '10 Projects/Alpha', '20 Areas'],
    );
    assert.deepEqual(pickerFolders([], '.obsidian'), []);
  });
});

describe('createNotesHost', () => {
  function build(settings: Partial<HamsterSettings> = {}): { fake: FakeApp; host: ReturnType<typeof createNotesHost> } {
    const fake = new FakeApp();
    const current = { ...DEFAULT_SETTINGS, ...settings };
    const locator = new DailyNoteLocator(fake.app);
    const target = new TextTarget(fake.app, { lastTouch: () => undefined, now: () => 0 });
    const companions = new CompanionStore(fake.app, () => current, target);
    const host = createNotesHost(fake.app, { settings: () => current, locator, target, companions });
    return { fake, host };
  }

  const REGISTRY = [
    '## People',
    '| canonical | wikilink | aliases | active |',
    '| --- | --- | --- | --- |',
    '| Jane Example | [[Jane Example]] | Jane | yes |',
    '',
    '## Projects',
    '| canonical | wikilink | aliases | active |',
    '| --- | --- | --- | --- |',
    '| Alpha Programme | [[Alpha]] | | yes |',
  ].join('\n');

  it('returns no entities when the registry note is missing', async () => {
    const { host } = build();
    assert.deepEqual(await host.entities(), []);
  });

  it('parses the registry and reads it again only when the file changes', async () => {
    const { fake, host } = build();
    fake.add(DEFAULT_SETTINGS.entitiesPath, REGISTRY);

    const first = await host.entities();
    assert.deepEqual(first.map((entity) => [entity.name, entity.kind]), [
      ['Jane Example', 'person'],
      ['Alpha Programme', 'project'],
    ]);
    assert.equal(await host.entities(), first, 'the same list while the file is unchanged');
    assert.equal(fake.cachedReads, 1);

    fake.edit(DEFAULT_SETTINGS.entitiesPath, REGISTRY.replace('Jane Example | [[Jane Example]]', 'Joan Sample | [[Joan Sample]]'));
    assert.equal((await host.entities())[0].name, 'Joan Sample');
    assert.equal(fake.cachedReads, 2);
  });

  it('reads linked notes: resolved, Markdown only, each once, at most four', async () => {
    const { fake, host } = build();
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      fake.add(`People/${name}.md`, `---\ntype: person\n---\nNote about ${name}.\n\n## Linked mentions\nquery`);
      fake.links.set(name, `People/${name}.md`);
    }
    fake.add('files/photo.png', '');
    fake.links.set('photo.png', 'files/photo.png');
    fake.links.set('A again', 'People/A.md');

    const notes = await host.readLinkedNotes(['Nobody', 'photo.png', 'A', 'A again', 'B', 'C', 'D', 'E'], 500);

    assert.deepEqual(notes, [
      { title: 'A', path: 'People/A.md', text: 'Note about A.' },
      { title: 'B', path: 'People/B.md', text: 'Note about B.' },
      { title: 'C', path: 'People/C.md', text: 'Note about C.' },
      { title: 'D', path: 'People/D.md', text: 'Note about D.' },
    ]);
  });

  it('trims linked notes to maxChars and skips empty ones', async () => {
    const { fake, host } = build();
    fake.add('Long.md', 'word '.repeat(100));
    fake.links.set('Long', 'Long.md');
    fake.add('Empty.md', '---\ntype: person\n---\n\n## Linked mentions\nquery');
    fake.links.set('Empty', 'Empty.md');

    const notes = await host.readLinkedNotes(['Empty', 'Long'], 40);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, 'Long');
    assert.ok(notes[0].text.length <= 40);
  });

  it('lists folders for the index picker', () => {
    const { fake, host } = build();
    fake.folders.push('10 Projects', '00 Inbox', '10 Projects/Alpha', '10 Projects/Alpha/Deep', '.obsidian');
    assert.deepEqual(host.listFolders(), ['00 Inbox', '10 Projects', '10 Projects/Alpha']);
  });

  it('prefixes notices with the plugin name', () => {
    const { host } = build();
    obsidian.notices.length = 0;
    host.notice('Saved.', 4000);
    host.notice('No duration.');
    assert.deepEqual(obsidian.notices, [
      { message: 'Magical Hamster: Saved.', ms: 4000 },
      { message: 'Magical Hamster: No duration.', ms: undefined },
    ]);
  });

  it('says so when asked to open a note that is gone', () => {
    const { host } = build();
    obsidian.notices.length = 0;
    host.openNote('gone.md');
    assert.equal(obsidian.notices.length, 1);
    assert.match(obsidian.notices[0].message, /gone\.md is no longer in the vault/);
  });

  it('opens a note in a new tab and brings that tab to the front', async () => {
    const { fake, host } = build();
    const path = '00 Inbox/Mtg-2026-10-09 — Sync.md';
    fake.add(path, '# Sync\n');
    const asked: unknown[] = [];
    const opened: Array<{ path: string; state: unknown }> = [];
    const tab = {
      openFile: async (file: { path: string }, state?: unknown): Promise<void> => {
        opened.push({ path: file.path, state });
      },
    };
    Object.assign(fake.workspace, {
      getLeaf: (where: unknown) => {
        asked.push(where);
        return tab;
      },
    });

    host.openNote(path);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(asked, ['tab']);
    /* With "Always focus new tabs" off, Obsidian leaves a new tab behind the
       current one, and a file opened in a leaf that is not the active one stays
       there unless the leaf is asked to become active. */
    assert.deepEqual(opened, [{ path, state: { active: true } }]);
  });

  it('opens a note in the empty tab the user last used, and gives it the focus', async () => {
    const { fake, host } = build();
    const path = '00 Inbox/Mtg-2026-10-09 — Sync.md';
    fake.add(path, '# Sync\n');
    const opened: Array<{ path: string; state: unknown }> = [];
    const empty = {
      view: { getViewType: (): string => 'empty' },
      openFile: async (file: { path: string }, state?: unknown): Promise<void> => {
        opened.push({ path: file.path, state });
      },
    };
    Object.assign(fake.workspace, {
      getMostRecentLeaf: () => empty,
      getLeaf: () => assert.fail('an empty tab is reused'),
    });

    host.openNote(path);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(opened, [{ path, state: { active: true } }]);
  });

  it('reports today\'s daily and reads it', async () => {
    const { fake, host } = build();
    const today = host.today();
    assert.equal(today.exists, false);
    assert.equal(await host.readDaily(), null);
    fake.add(today.path, '### 1:1 Jane Example\n');
    assert.equal(host.today().exists, true);
    assert.equal(await host.readDaily(), '### 1:1 Jane Example\n');
    assert.equal(host.exists(today.path), true);
  });

  it('answers no-daily without touching anything when today\'s daily does not exist', async () => {
    const { host } = build();
    const result = await host.insertDailyLink({
      section: { title: '1:1 Jane Example', ordinal: 0 },
      companionBasename: 'Mtg-x',
      line: '↳ [[Mtg-x|Meeting notes]]',
      placement: 'section-end',
    });
    assert.deepEqual(result, { status: 'no-daily' });
  });

  it('adds the link to a heading-less meeting that only the entity registry makes a section', async () => {
    const { fake, host } = build();
    fake.add(DEFAULT_SETTINGS.entitiesPath, REGISTRY);
    const today = host.today();
    fake.add(today.path, 'Jane Example\nbudget ok\n\nlater thought\n');

    const result = await host.insertDailyLink({
      section: { title: 'Jane Example', ordinal: 0 },
      companionBasename: 'Mtg-x',
      line: '↳ [[Mtg-x|Meeting notes]]',
      placement: 'section-end',
    });

    assert.deepEqual(result, { status: 'inserted', via: 'vault' });
    assert.equal(
      fake.files.get(today.path)?.data,
      'Jane Example\nbudget ok\n\nlater thought\n↳ [[Mtg-x|Meeting notes]]\n',
    );
  });

  it('remembers a companion it created by the keys in its frontmatter', async () => {
    const { fake, host } = build();
    fake.folders.push('00 Inbox');
    const content = renderCompanion({
      title: '1:1 Jane Example',
      date: '2026-10-09',
      attendees: ['Jane Example'],
      projects: [],
      dailyBasename: '2026-10-09',
      source: '1:1 Jane Example#0',
    });
    const path = '00 Inbox/Mtg-2026-10-09 — 1-1 Jane Example.md';

    assert.equal(host.findCompanion('2026-10-09', '1:1 Jane Example#0'), null);
    await host.createCompanion(path, content);

    assert.equal(host.findCompanion('2026-10-09', '1:1 Jane Example#0'), path);
    assert.equal(host.exists(path), true);
    assert.equal(await host.readCompanion(path), content);
  });

  it('finds the note a link line points to, resolved as a link in today\'s daily', () => {
    const { fake, host } = build();
    fake.add('30 Archive/2026/Mtg-2026-10-02 — Steering.md', 'filed away last week');
    fake.links.set('Mtg-2026-10-02 — Steering', '30 Archive/2026/Mtg-2026-10-02 — Steering.md');

    assert.equal(
      host.findCompanionByBasename('Mtg-2026-10-02 — Steering'),
      '30 Archive/2026/Mtg-2026-10-02 — Steering.md',
    );
    assert.deepEqual(fake.resolutions, [{ link: 'Mtg-2026-10-02 — Steering', from: host.today().path }]);
  });

  it('finds a companion it just created by its basename, before Obsidian can resolve a link to it', async () => {
    const { fake, host } = build();
    fake.folders.push('00 Inbox');
    const basename = 'Mtg-2026-10-09 — 1-1 Jane Example';
    const path = `00 Inbox/${basename}.md`;
    await host.createCompanion(
      path,
      renderCompanion({
        title: '1:1 Jane Example',
        date: '2026-10-09',
        attendees: ['Jane Example'],
        projects: [],
        dailyBasename: '2026-10-09',
        source: '1:1 Jane Example#0',
      }),
    );

    // The heading was renamed since: the key in the frontmatter no longer names the section.
    assert.equal(host.findCompanion('2026-10-09', '1:1 Jane Example (budget)#0'), null);
    // `fake.links` is empty: the metadata cache resolves nothing yet.
    assert.equal(host.findCompanionByBasename(basename), path);
    assert.deepEqual(fake.resolutions, []);
  });

  it('finds no companion behind a link to nothing, to an attachment, or without a target', () => {
    const { fake, host } = build();
    const today = host.today();
    fake.add(today.path, '### 1:1 Jane Example\n');
    fake.add('files/Mtg-whiteboard.png', '');
    fake.links.set('Mtg-whiteboard.png', 'files/Mtg-whiteboard.png');
    // What Obsidian does with an empty link: it is the note the link is in.
    fake.links.set('', today.path);
    fake.links.set(today.basename, today.path);

    assert.equal(host.findCompanionByBasename('Mtg-never-made'), null);
    assert.equal(host.findCompanionByBasename('Mtg-whiteboard.png'), null);
    assert.equal(host.findCompanionByBasename(''), null);
    assert.equal(host.findCompanionByBasename(today.basename), null, 'the daily is not its own companion');
  });
});

describe('settings tab: the speech fields of this device', () => {
  interface Control {
    value: unknown;
    placeholder: string | undefined;
    type(value: string): void;
  }
  interface Row {
    name: string;
    desc: string;
    controls: Control[];
  }

  const HOME = '/Users/someone';
  const DEFAULT_DIR = `${HOME}/Library/Application Support/magical-hamster`;

  /** The tab, drawn, over runtimes installed in the given directories (directory -> the Node its setup recorded). */
  function open(installed: Record<string, string>, stored: Partial<typeof DEFAULT_LOCAL> = {}) {
    let local = { ...DEFAULT_LOCAL, ...stored };
    const asked: string[] = [];
    const tab = new HamsterSettingTab(new FakeApp().app, {} as ConstructorParameters<typeof HamsterSettingTab>[1], {
      settings: () => DEFAULT_SETTINGS,
      updateSettings: async () => undefined,
      local: () => local,
      setLocal: (patch) => {
        local = { ...local, ...patch };
      },
      defaultRuntimeDir: () => DEFAULT_DIR,
      // As in main.ts: one function resolves the folder, for the tab as for everything else.
      runtimeDir: () => resolveRuntimeDir(local.runtimeDir, HOME),
      readRuntime: (dir) => {
        asked.push(dir);
        return Object.hasOwn(installed, dir) ? { model: `model in ${dir}`, node: installed[dir] } : null;
      },
    });
    drawTab(tab);
    const rows = (tab.containerEl as unknown as { rows: Row[] }).rows;
    const row = (name: string): Row => {
      const found = rows.find((candidate) => candidate.name === name);
      assert.ok(found, `no setting named ${name}`);
      return found;
    };
    return {
      asked,
      local: () => local,
      node: () => row('Node path'),
      folder: () => row('Runtime folder'),
      status: () => row('Speech runtime').desc,
    };
  }

  it('shows the Node the speech setup recorded as what an empty Node path stands for', () => {
    const tab = open({ [DEFAULT_DIR]: '/Users/someone/.local/node-24/bin/node' });
    const [field] = tab.node().controls;

    assert.equal(field.value, '', 'nothing is filled in by default');
    assert.equal(field.placeholder, '/Users/someone/.local/node-24/bin/node');
    assert.match(tab.node().desc, /Leave empty to use the Node that the speech setup recorded\./);
    assert.equal(tab.status(), `Installed: model in ${DEFAULT_DIR}`);
    assert.deepEqual([...new Set(tab.asked)], [DEFAULT_DIR]);
  });

  it('shows an example path when no speech runtime is installed', () => {
    const tab = open({});
    assert.equal(tab.node().controls[0].placeholder, '/opt/homebrew/bin/node');
    assert.match(tab.status(), /^Not installed\. Set it up with the command below/);
  });

  it('saves the Node path as typed, and an emptied field as empty', () => {
    const tab = open({ [DEFAULT_DIR]: '/recorded/node' });
    const [field] = tab.node().controls;

    field.type('  /usr/local/bin/node ');
    assert.equal(tab.local().nodePath, '/usr/local/bin/node');
    field.type('');
    assert.equal(tab.local().nodePath, '', 'not the recorded path, and not the example');
    field.type('   ');
    assert.equal(tab.local().nodePath, '');
    assert.equal(field.placeholder, '/recorded/node', 'the placeholder still says what empty means');
  });

  it('shows a stored Node path as it is', () => {
    const tab = open({ [DEFAULT_DIR]: '/recorded/node' }, { nodePath: '/usr/local/bin/node' });
    assert.equal(tab.node().controls[0].value, '/usr/local/bin/node');
  });

  it('follows the runtime folder as it is typed: its status and the Node it recorded', () => {
    const tab = open({
      [DEFAULT_DIR]: '/recorded/default/node',
      '/Volumes/Fast/hamster': '/recorded/fast/node',
    });
    const [node] = tab.node().controls;
    const [folder] = tab.folder().controls;
    assert.equal(folder.placeholder, DEFAULT_DIR);

    folder.type('/Volumes/Fast/hamster');
    assert.equal(tab.local().runtimeDir, '/Volumes/Fast/hamster');
    assert.equal(node.placeholder, '/recorded/fast/node');
    assert.equal(tab.status(), 'Installed: model in /Volumes/Fast/hamster');

    folder.type('/Volumes/Fast/nothing-here');
    assert.equal(node.placeholder, '/opt/homebrew/bin/node');
    assert.match(tab.status(), /^Not installed\./);

    folder.type('');
    assert.equal(tab.local().runtimeDir, '');
    assert.equal(node.placeholder, '/recorded/default/node');
    assert.equal(tab.status(), `Installed: model in ${DEFAULT_DIR}`);
  });

  it('looks for the runtime where a folder that starts with ~ really is, and keeps the folder as typed', () => {
    const tab = open({ [`${HOME}/hamster`]: '/recorded/home/node' });
    const [folder] = tab.folder().controls;

    folder.type('~/hamster');

    assert.equal(tab.local().runtimeDir, '~/hamster', 'the setting keeps what was typed');
    assert.equal(tab.asked.at(-1), `${HOME}/hamster`);
    assert.equal(tab.status(), `Installed: model in ${HOME}/hamster`);
    assert.equal(tab.node().controls[0].placeholder, '/recorded/home/node');
  });

  it('treats a runtime that cannot be read as not installed', () => {
    let local = { ...DEFAULT_LOCAL };
    const tab = new HamsterSettingTab(new FakeApp().app, {} as ConstructorParameters<typeof HamsterSettingTab>[1], {
      settings: () => DEFAULT_SETTINGS,
      updateSettings: async () => undefined,
      local: () => local,
      setLocal: (patch) => {
        local = { ...local, ...patch };
      },
      defaultRuntimeDir: () => DEFAULT_DIR,
      runtimeDir: () => DEFAULT_DIR,
      readRuntime: () => {
        throw new Error('EACCES');
      },
    });
    drawTab(tab);
    const rows = (tab.containerEl as unknown as { rows: Row[] }).rows;
    assert.match(rows.find((row) => row.name === 'Speech runtime')?.desc ?? '', /^Not installed\./);
    assert.equal(rows.find((row) => row.name === 'Node path')?.controls[0].placeholder, '/opt/homebrew/bin/node');
  });
});

describe('settings tab: the Ollama address', () => {
  interface Control {
    value: unknown;
    type(value: string): void;
    fire(type: string, event?: object): void;
  }
  interface Row {
    name: string;
    desc: string;
    error: string | null;
    descEl: { classes: Set<string> };
    controls: Control[];
  }
  const globals = globalThis as { window?: unknown };

  /** The tab, drawn, over the given address. Timers it starts are counted, never run. */
  function open(ollamaUrl = DEFAULT_SETTINGS.ollamaUrl) {
    let settings: HamsterSettings = { ...DEFAULT_SETTINGS, ollamaUrl };
    const saved: Array<Partial<HamsterSettings>> = [];
    const timers: unknown[] = [];
    const savedWindow = globals.window;
    globals.window = {
      setTimeout: (fn: unknown): number => timers.push(fn),
      clearTimeout: (): void => undefined,
    };
    const tab = new HamsterSettingTab(new FakeApp().app, {} as ConstructorParameters<typeof HamsterSettingTab>[1], {
      settings: () => settings,
      updateSettings: async (patch) => {
        saved.push(patch);
        settings = { ...settings, ...patch };
      },
      local: () => DEFAULT_LOCAL,
      setLocal: () => undefined,
      defaultRuntimeDir: () => '/runtime',
      runtimeDir: () => '/runtime',
      readRuntime: () => null,
    });
    drawTab(tab);
    const rows = (tab.containerEl as unknown as { rows: Row[] }).rows;
    const row = rows.find((candidate) => candidate.name === 'Ollama address');
    assert.ok(row, 'no setting named Ollama address');
    return {
      tab,
      row,
      field: row.controls[0],
      saved,
      timers,
      close: (): void => {
        globals.window = savedWindow;
      },
    };
  }

  it('says where Ollama normally is, without a warning', () => {
    const t = open();
    try {
      assert.equal(t.field.value, 'http://localhost:11434');
      assert.equal(t.row.desc, 'Where Ollama listens on this computer.');
      assert.equal(t.row.descEl.classes.has('mod-warning'), false);
    } finally {
      t.close();
    }
  });

  it('does not put a half-typed address into effect, however long the typing pauses', () => {
    const t = open();
    try {
      for (const typed of ['http://19', 'http://192.168.1.5', 'http://192.168.1.50:11434']) t.field.type(typed);
      assert.deepEqual(t.saved, [], 'nothing is saved while the field has the focus');
      assert.deepEqual(t.timers, [], 'and nothing is waiting to save it after a pause');

      t.field.fire('blur');
      assert.deepEqual(t.saved, [{ ollamaUrl: 'http://192.168.1.50:11434' }], 'saved once, as it was when the field was left');
    } finally {
      t.close();
    }
  });

  it('puts an address being typed into effect when a sync redraws the tab', () => {
    const t = open();
    try {
      t.field.type('http://192.168.1.50:11434');
      assert.deepEqual(t.saved, []);
      // data.json changed on disk: Obsidian calls update(), then draws the rows again.
      t.tab.update();
      assert.deepEqual(t.saved, [{ ollamaUrl: 'http://192.168.1.50:11434' }], 'saved before the rows are drawn again');
      drawTab(t.tab);
      const rows = (t.tab.containerEl as unknown as { rows: Row[] }).rows;
      const redrawn = rows.find((candidate) => candidate.name === 'Ollama address');
      assert.equal(redrawn?.controls[0].value, 'http://192.168.1.50:11434', 'the field shows the address in effect');
    } finally {
      t.close();
    }
  });

  it('warns under the field as soon as the address is not this computer', () => {
    const t = open();
    try {
      t.field.type('http://192.168.1.50:11434');
      assert.match(t.row.desc, /^192\.168\.1\.50 is not this computer\./);
      assert.match(t.row.desc, /Transcripts, notes, passages from the vault and questions are sent to it, without encryption\./);
      assert.match(t.row.desc, /synced with the vault: every device/);
      assert.equal(t.row.descEl.classes.has('mod-warning'), true);
      assert.equal(t.row.error, null);

      t.field.type('  http://127.0.0.1:11434 ');
      assert.equal(t.row.desc, 'Where Ollama listens on this computer.');
      assert.equal(t.row.descEl.classes.has('mod-warning'), false);
      t.field.fire('blur');
      assert.deepEqual(t.saved, [{ ollamaUrl: 'http://127.0.0.1:11434' }]);
    } finally {
      t.close();
    }
  });

  it('warns when the tab opens on an address that is already somewhere else', () => {
    const t = open('https://ollama.example.com');
    try {
      assert.match(t.row.desc, /^ollama\.example\.com is not this computer\..* are sent to it\. The address is synced/);
      assert.equal(t.row.descEl.classes.has('mod-warning'), true);
    } finally {
      t.close();
    }
  });

  it('takes the address on Enter, but not on the Enter that ends a composition', () => {
    const t = open();
    try {
      t.field.type('http://gpu-box.local:11434');
      t.field.fire('keydown', { key: 'a' });
      t.field.fire('keydown', { key: 'Enter', isComposing: true });
      assert.deepEqual(t.saved, []);
      t.field.fire('keydown', { key: 'Enter' });
      assert.deepEqual(t.saved, [{ ollamaUrl: 'http://gpu-box.local:11434' }]);
      // Leaving the field afterwards has nothing left to save.
      t.field.fire('blur');
      assert.equal(t.saved.length, 1);
    } finally {
      t.close();
    }
  });

  it('takes the address when the settings close on a field that still has the focus', () => {
    const t = open();
    try {
      t.field.type('http://gpu-box.local:11434');
      t.tab.hide();
      assert.deepEqual(t.saved, [{ ollamaUrl: 'http://gpu-box.local:11434' }]);
    } finally {
      t.close();
    }
  });

  it('never saves what is not an address, and keeps describing the one in use', () => {
    const t = open('https://ollama.example.com');
    try {
      for (const typed of ['http://', 'localhost:11434', 'ftp://192.168.1.50', '']) {
        t.field.type('http://localhost:11434');
        t.field.type(typed);
        assert.equal(t.row.error, 'Enter an address such as http://localhost:11434', typed);
        assert.match(t.row.desc, /^ollama\.example\.com is not this computer/, 'the address still in use');
        t.field.fire('blur');
        t.field.fire('keydown', { key: 'Enter' });
      }
      t.tab.hide();
      assert.deepEqual(t.saved, []);
    } finally {
      t.close();
    }
  });

  it('saves nothing when the field is left as it was', () => {
    const t = open();
    try {
      t.field.type('http://localhost:1143');
      t.field.type('http://localhost:11434');
      t.field.fire('blur');
      assert.deepEqual(t.saved, []);
    } finally {
      t.close();
    }
  });

  it('describeOllamaAddress has no warning for text that is not an address', () => {
    assert.deepEqual(describeOllamaAddress('nonsense'), {
      text: 'Where Ollama listens on this computer.',
      warning: false,
    });
  });
});

describe('settings tab: what the descriptions say', () => {
  /** The description under each setting of the tab, by the setting's name. */
  function descriptions(): Map<string, string> {
    const tab = new HamsterSettingTab(new FakeApp().app, {} as ConstructorParameters<typeof HamsterSettingTab>[1], {
      settings: () => DEFAULT_SETTINGS,
      updateSettings: async () => undefined,
      local: () => DEFAULT_LOCAL,
      setLocal: () => undefined,
      defaultRuntimeDir: () => '/runtime',
      runtimeDir: () => '/runtime',
      readRuntime: () => null,
    });
    drawTab(tab);
    const rows = (tab.containerEl as unknown as { rows: Array<{ name: string; desc: string }> }).rows;
    return new Map(rows.map((row) => [row.name, row.desc]));
  }

  it('says when a new runtime folder is used, and that nothing is copied into it', () => {
    // main.ts reads the stats and the index from the folder Obsidian started with; the speech source follows at once.
    const desc = descriptions().get('Runtime folder') ?? '';
    assert.match(desc, /used for speech at the next recording, and for the index and the stats the next time Obsidian starts\./);
    assert.match(desc, /Nothing is copied into it\.$/);
    assert.doesNotMatch(desc, /move/);
  });

  it('says how a changed list of indexed folders is applied', () => {
    assert.match(descriptions().get('Indexed folders') ?? '', /Press Rebuild index in the sidebar to apply\.$/);
  });

  it('says that the Enhance style applies at once', () => {
    const desc = descriptions().get('Enhance style') ?? '';
    assert.match(desc, /A change applies at once/);
    assert.doesNotMatch(desc, /for the current session/);
  });

  it('gives every setting a description that ends as a sentence', () => {
    for (const [name, desc] of descriptions()) {
      // A heading has none.
      if (desc === '') continue;
      assert.match(desc, /[.)]$/, name);
      assert.doesNotMatch(desc, /!/, name);
    }
  });
});

describe('settings tab: the definitions Obsidian searches and draws', () => {
  interface Row {
    name: string;
    desc: string;
    controls: Array<{ value: unknown; placeholder: string | undefined; type(value: string): void }>;
  }
  const plugin = {} as ConstructorParameters<typeof HamsterSettingTab>[1];

  it('lists every row the tab draws, under its heading, without reading or saving anything', () => {
    const used: string[] = [];
    const use = <T>(what: string, value: T): T => {
      used.push(what);
      return value;
    };
    const tab = new HamsterSettingTab(new FakeApp().app, plugin, {
      settings: () => use('settings', DEFAULT_SETTINGS),
      updateSettings: async () => use('updateSettings', undefined),
      local: () => use('local', DEFAULT_LOCAL),
      setLocal: () => use('setLocal', undefined),
      defaultRuntimeDir: () => use('defaultRuntimeDir', '/runtime'),
      runtimeDir: () => use('runtimeDir', '/runtime'),
      readRuntime: () => use('readRuntime', null),
    });
    const rows = (tab.containerEl as unknown as { rows: Row[] }).rows;

    // Obsidian asks for the list when the plugin loads, to index it for its search.
    const definitions = tab.getSettingDefinitions();
    assert.equal(used.join(', '), '', 'nothing is read, saved or asked of the runtime');
    assert.equal(rows.length, 0, 'and nothing is drawn');

    // Obsidian tells the groups apart by their headings, and the rows of a group by their names.
    const headings = definitions.map((group) => group.heading);
    assert.equal(new Set(headings).size, headings.length);
    for (const group of definitions) {
      assert.equal(group.type, 'group');
      assert.notEqual(group.heading.trim(), '');
      const names = group.items.map((item) => item.name);
      assert.equal(new Set(names).size, names.length, group.heading);
      for (const item of group.items) {
        assert.notEqual(item.name.trim(), '', group.heading);
        assert.notEqual(item.desc.trim(), '', item.name);
      }
    }

    drawTab(tab);
    assert.deepEqual(
      rows.map((row) => row.name),
      definitions.flatMap((group) => [group.heading, ...group.items.map((item) => item.name)]),
      'the tab draws these rows, each under its heading, and nothing else',
    );
    assert.ok(used.includes('readRuntime'), 'what a row shows is read when it is drawn');
  });

  it('draws the list it gave at load with what is true when the tab opens', () => {
    let settings: HamsterSettings = DEFAULT_SETTINGS;
    let local = { ...DEFAULT_LOCAL };
    const tab = new HamsterSettingTab(new FakeApp().app, plugin, {
      settings: () => settings,
      updateSettings: async () => undefined,
      local: () => local,
      setLocal: (patch) => {
        local = { ...local, ...patch };
      },
      defaultRuntimeDir: () => '/runtime',
      runtimeDir: () => local.runtimeDir || '/runtime',
      readRuntime: (dir) => (dir === '/fast' ? { model: 'fast model', node: '/fast/node' } : null),
    });
    // As Obsidian does: the list it is given when the plugin loads is the one it draws every time.
    const loaded = tab.getSettingDefinitions();
    tab.getSettingDefinitions = () => loaded;
    const rows = (tab.containerEl as unknown as { rows: Row[] }).rows;
    const row = (name: string): Row => {
      const found = rows.find((candidate) => candidate.name === name);
      assert.ok(found, `no setting named ${name}`);
      return found;
    };

    drawTab(tab);
    settings = { ...settings, llmModel: 'qwen3:8b' };
    tab.hide();
    drawTab(tab);
    assert.equal(row('Model').controls[0].value, 'qwen3:8b');

    // The runtime folder updates the rows drawn last, not the ones drawn the first time.
    row('Runtime folder').controls[0].type('/fast');
    assert.equal(row('Speech runtime').desc, 'Installed: fast model');
    assert.equal(row('Node path').controls[0].placeholder, '/fast/node');
  });
});

describe('nodePathPlaceholder', () => {
  it('is the recorded Node, or an example when there is none', () => {
    assert.equal(nodePathPlaceholder({ node: '/usr/local/bin/node' }), '/usr/local/bin/node');
    assert.equal(nodePathPlaceholder(null), '/opt/homebrew/bin/node');
    assert.equal(nodePathPlaceholder({ node: '  ' }), '/opt/homebrew/bin/node');
  });
});

describe('parseNumber', () => {
  const whole = { min: 1024, max: 1048576, integer: true };
  const price = { min: 0, max: 1000 };

  it('reads whole numbers and decimals', () => {
    assert.equal(parseNumber('16384', whole), 16384);
    assert.equal(parseNumber('  16384  ', whole), 16384);
    assert.equal(parseNumber('0.002', price), 0.002);
    assert.equal(parseNumber('0,002', price), 0.002);
    assert.equal(parseNumber('.5', price), 0.5);
    assert.equal(parseNumber('0', price), 0);
  });

  it('refuses what is not a number in range', () => {
    assert.equal(parseNumber('', whole), null);
    assert.equal(parseNumber('abc', whole), null);
    assert.equal(parseNumber('16k', whole), null);
    assert.equal(parseNumber('1e5', whole), null);
    assert.equal(parseNumber('100', whole), null);
    assert.equal(parseNumber('99999999', whole), null);
    assert.equal(parseNumber('-1', price), null);
    assert.equal(parseNumber('Infinity', price), null);
    assert.equal(parseNumber('1.2.3', price), null);
  });

  it('refuses a fraction where a whole number is asked for', () => {
    assert.equal(parseNumber('2048.5', whole), null);
    assert.equal(parseNumber('2048.0', whole), 2048);
  });
});

describe('checkSoftMarkerPattern', () => {
  it('accepts the default pattern and ordinary ones', () => {
    assert.equal(checkSoftMarkerPattern(DEFAULT_SETTINGS.softMarkerPattern), null);
    assert.equal(checkSoftMarkerPattern('^(1:1|Stand-?up|Comité)\\b'), null);
    assert.equal(checkSoftMarkerPattern('^\\w+ \\d{1,2}:\\d{2}$'), null);
    assert.equal(checkSoftMarkerPattern('$^'), null);
    assert.equal(checkSoftMarkerPattern('^[A-Z][a-z]+( [A-Z][a-z]+)*$'), null);
  });

  it('refuses a pattern that does not compile, and says why', () => {
    const reason = checkSoftMarkerPattern('^(1:1|Prep');
    assert.ok(reason);
    assert.match(reason, /not a valid regular expression/);
    assert.ok(checkSoftMarkerPattern('[a-'));
    assert.ok(checkSoftMarkerPattern('(?<name'));
  });

  it('refuses an empty pattern, which would match every line', () => {
    assert.ok(checkSoftMarkerPattern(''));
    assert.ok(checkSoftMarkerPattern('   '));
  });

  it('refuses a pattern that backtracks without end, without hanging on it', () => {
    const started = performance.now();
    for (const slow of ['(a+)+$', '^1:1 (\\w+\\s?)+$', '(\\d+)*x', '([a-z]+)*\\d', '(.*)*=', '(x+x+)+y']) {
      const reason = checkSoftMarkerPattern(slow);
      assert.ok(reason, `${slow} should be refused`);
      assert.match(reason, /too slow/);
    }
    assert.ok(performance.now() - started < 5000, 'each refusal takes a fraction of a second');
  });

  it('measures twice before refusing: one slow run is not the pattern\'s fault', () => {
    // A clock on which only the very first measurement takes long.
    let calls = 0;
    const once = (): number => {
      calls += 1;
      return calls === 2 ? 1000 : calls > 2 ? 1000 : 0;
    };
    assert.equal(checkSoftMarkerPattern('^Prep\\b', once), null);

    // A clock on which every measurement takes long.
    let time = 0;
    const always = (): number => {
      time += 50;
      return time;
    };
    assert.match(checkSoftMarkerPattern('^Prep\\b', always) ?? '', /too slow/);
  });
});

describe('checkSoftMarkerPattern behind the words a pattern starts with', () => {
  it('reads the ways a line can start off the pattern', () => {
    const heads = probeHeads('^(Sync|Standup) (\\w+ ?)+$');
    for (const head of ['', '1:1 ', 'Sync', 'Sync ', 'Standup', 'Standup ', 'Sync Standup ', 'SyncStandup']) {
      assert.ok(heads.includes(head), JSON.stringify(head));
    }
    assert.ok(!heads.includes('w'), 'the w of \\w is not a word');

    const spaced = probeHeads('^Ad ?Hoc ([a-z]+)*$');
    assert.ok(spaced.includes('Ad Hoc ') && spaced.includes('AdHoc '));
    assert.ok(!spaced.includes('a') && !spaced.includes('z'), 'nor are the letters of a class');

    assert.ok(probeHeads('^Comité de direction (\\w+)+$').includes('Comité de direction '));
    assert.ok(probeHeads('^\\s*Comité de direction (\\w+)+$').includes('Comité de direction '));
    assert.ok(probeHeads('^1\\:1 (\\w+)+$').includes('1:1 '));
    assert.ok(probeHeads('^(?<kind>Prep)\\p{L}{2,3}\\u00e9(?:Bilan)').includes('Prep Bilan'));
    assert.deepEqual(probeHeads('^\\d+$'), ['1:1 ', '', ' ']);
  });

  it('reads the literal text a pattern begins with, signs and alternatives included', () => {
    const starts = (source: string, wanted: string[]): void => {
      const heads = probeHeads(source);
      for (const head of wanted) assert.ok(heads.includes(head), `${source} -> ${JSON.stringify(head)}`);
    };
    starts('^Point (hebdo|mensuel) : (\\w+ ?)+$', ['Point hebdo : ', 'Point mensuel : ']);
    starts('^Ad ?Hoc ([a-z]+)*$', ['AdHoc ', 'Ad Hoc ']);
    starts('^(?:Prep|Steering)\\b(\\S+)+$', ['Prep', 'Steering']);
    starts('^(?<kind>R\\.I\\.P|Q&A) - (\\w+)+$', ['R.I.P - ', 'Q&A - ']);
    starts('^((Team )?Sync|Standup): (\\w+ ?)+$', ['Team Sync: ', 'Sync: ', 'Standup: ']);
    starts('Sync #|^Stand-?up #(\\d+)+$', ['Sync #', 'Standup #', 'Stand-up #']);
    // Nothing literal in front, or syntax the reader does not follow: no start, and no failure.
    for (const source of ['(?=Sync)(\\w+)+$', '[Ss]ync (\\w+)+$', '(((', ')|(', 'a{2}b', '\\', '(?<n>']) {
      assert.ok(Array.isArray(probeHeads(source)), source);
    }
  });

  it('keeps the number of heads small, whatever the pattern lists', () => {
    const many = `^(${Array.from({ length: 40 }, (_, i) => `Word${i}`).join('|')})\\b`;
    assert.ok(probeHeads(many).length <= 64, String(probeHeads(many).length));
  });

  it('refuses a repetition inside a repetition behind any opening word, not only 1:1', () => {
    const slow = [
      '^Prep (\\w+)+$',
      '^(Sync|Standup) (\\w+ ?)+$',
      '^Rencontre (\\w+\\s?)+$',
      '^Ad ?Hoc ([a-z]+)*$',
      '^Comité de direction (\\w+)+$',
      '^(Prep|Steering)\\b(\\S+)+$',
      '^1\\:1 (\\w+)+$',
      '^Point (hebdo|mensuel) : (\\w+ ?)+$',
      '^((Team )?Sync|Standup): (\\w+ ?)+$',
      '^(?<kind>R\\.I\\.P|Q&A) - (\\w+)+$',
      '^\\s*Comité de direction (\\w+)+$',
    ];
    for (const pattern of slow) {
      const started = performance.now();
      const reason = checkSoftMarkerPattern(pattern);
      const took = performance.now() - started;
      assert.match(reason ?? '', /too slow/, pattern);
      assert.ok(took < 3000, `${pattern} took ${Math.round(took)} ms to refuse`);
    }
  });

  it('still accepts the same openings in front of a repetition that cannot be read two ways', () => {
    for (const pattern of [
      '^Prep \\w+( \\w+)*$',
      '^(Sync|Standup) [\\w ]+$',
      '^Rencontre\\b',
      '^Ad ?Hoc [a-z]*$',
      '^Comité de direction\\b',
      '^(Prep|Steering)\\b\\S*$',
      '^Point (hebdo|mensuel) : .+$',
    ]) {
      assert.equal(checkSoftMarkerPattern(pattern), null, pattern);
    }
  });

  it('refuses a pattern that is slow everywhere without one probe standing out', () => {
    // A clock on which every probe takes one millisecond: under the budget of a probe, far over the budget of them all.
    let time = 0;
    const steady = (): number => {
      time += 1;
      return time;
    };
    assert.match(checkSoftMarkerPattern('^Prep\\b', steady) ?? '', /too slow/);
    assert.ok(time < 2 * 2000, 'and stops as soon as the total is spent');
  });

  it('decides on an ordinary pattern quickly enough to run on every keystroke of the field', () => {
    checkSoftMarkerPattern(DEFAULT_SETTINGS.softMarkerPattern);
    const started = performance.now();
    for (let i = 0; i < 5; i++) assert.equal(checkSoftMarkerPattern(DEFAULT_SETTINGS.softMarkerPattern), null);
    assert.ok((performance.now() - started) / 5 < 250, `${Math.round((performance.now() - started) / 5)} ms each`);
  });
});

describe('checkPrefix', () => {
  it('accepts ordinary prefixes', () => {
    assert.equal(checkPrefix('Mtg-'), null);
    assert.equal(checkPrefix('Réunion '), null);
    assert.equal(checkPrefix('M_'), null);
  });

  it('refuses an empty prefix and characters a file name or a link cannot hold', () => {
    assert.ok(checkPrefix(''));
    assert.ok(checkPrefix('  '));
    for (const bad of ['Mtg/', 'Mtg:', 'Mtg|', 'Mtg#', '[Mtg]', 'Mtg^', 'Mtg\\', 'Mtg?', 'Mtg*', 'M"x', 'M<x', 'M>x', 'M\nx']) {
      assert.ok(checkPrefix(bad), `${JSON.stringify(bad)} should be refused`);
    }
    assert.ok(checkPrefix('.hidden'));
  });
});

describe('parseFolderList', () => {
  it('reads one folder per line, trimmed and without outer slashes', () => {
    assert.deepEqual(parseFolderList('10 Projects\n  20 Areas/  \n\n/30 Resources/People\n'), [
      '10 Projects',
      '20 Areas',
      '30 Resources/People',
    ]);
  });

  it('drops duplicates and keeps a lone slash as the whole vault', () => {
    assert.deepEqual(parseFolderList('a\na/\n/\n//\n'), ['a', '/']);
    assert.deepEqual(parseFolderList(''), []);
    assert.deepEqual(parseFolderList('\r\n a \r\n'), ['a']);
  });
});

describe('review: checkSoftMarkerPattern on hostile patterns', () => {
  it('refuses each of them without taking long to decide', () => {
    const hostile = [
      '(a+)+$',
      '(a*)*$',
      '(a|aa)+$',
      '^(\\w+\\s?)+$',
      '(.*)*x',
      '([a-z]+)*\\d',
      '(\\d+)+$',
      '(\\s+)+$',
      '(a|a|a|a|a|a)+$',
      '^1:1 (\\w+)+$',
      '(é+)+$',
      '(x+x+)+y',
      '^(([a-z])+.)+[A-Z]([a-z])+$',
    ];
    for (const pattern of hostile) {
      const started = performance.now();
      const reason = checkSoftMarkerPattern(pattern);
      const took = performance.now() - started;
      assert.match(reason ?? '', /too slow/, pattern);
      assert.ok(took < 3000, `${pattern} took ${Math.round(took)} ms to refuse`);
    }
  });

  it('accepts patterns that only look alarming', () => {
    for (const pattern of ['^(1:1|Ad ?Hoc|Prep|Steering|Rencontre)\\b', '^\\w+(\\s\\w+)*$', '^(?:[A-Z][a-z]+ ){1,3}sync$', 'a{1,30}$']) {
      const started = performance.now();
      assert.equal(checkSoftMarkerPattern(pattern), null, pattern);
      assert.ok(performance.now() - started < 3000, pattern);
    }
  });
});

describe('soft-marker patterns that could hide a blow-up from the timing check', () => {
  it('are refused by their shape, at once, without running them', () => {
    const gated = [
      '^(?=.{40})(a+)+$',
      '^(?=.{50})(\\w+ ?)+$',
      '^(?!x)(a+)+$',
      '(?<=a)(b+)+$',
      '(?<!a)(b+)+$',
      '^\\d{40}(a+)+$',
      '^\\d{9,}(a+)+$',
      '^\\d{8}\\d{8}\\d{8}(a+)+$',
      '^(a)\\1+$',
      '^(?<w>a)\\k<w>+$',
    ];
    for (const pattern of gated) {
      const started = performance.now();
      const reason = checkSoftMarkerPattern(pattern);
      assert.ok(reason, `${pattern} should be refused`);
      assert.match(reason, /not supported/, pattern);
      assert.ok(performance.now() - started < 200, `${pattern} must be refused without being run`);
    }
  });

  it('leave ordinary groups, classes and small counts alone', () => {
    for (const pattern of [
      DEFAULT_SETTINGS.softMarkerPattern,
      '^(?:Point|Sync)\\b',
      '^(?<kind>Prep) \\w+',
      '^\\w+ \\d{1,2}:\\d{2}$',
      '^[(?=)!{40}]+ ok$',
      '^1\\\\1',
      'a{1,30}$',
    ]) {
      assert.equal(softMarkerUnsupported(pattern), null, pattern);
    }
  });

  it('never reach the section parser: the matcher falls back to one that matches nothing', () => {
    const regex = softMarkerRegex({ ...DEFAULT_SETTINGS, softMarkerPattern: '^(?=.{40})(a+)+$' });
    assert.equal(regex.test(`${'a'.repeat(60)}!`), false);
    assert.equal(softMarkerRegex({ ...DEFAULT_SETTINGS, softMarkerPattern: '^Prep\\b' }).test('Prep the deck'), true);
  });
});
