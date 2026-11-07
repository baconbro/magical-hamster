import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { describe, it } from 'node:test';
import { EditorState, Transaction } from '@codemirror/state';
import type { Extension, StateField, TransactionSpec } from '@codemirror/state';

import type { SectionOptions } from '../src/editor/sectionAt.ts';
import { beginMarker, endMarker, readRegion, renderCompanion } from '../src/notes/companion.ts';
import { DEFAULT_SETTINGS, EDIT_ORIGIN } from '../src/settings.ts';
import type { HamsterSettings, Patch } from '../src/types.ts';

/* Module I, the write router and what stands on it. The real thing runs
   inside Obsidian; here `obsidian` is replaced by the few classes these
   modules touch at run time, and the App by an in-memory vault and workspace.
   The CodeMirror transactions are real ones. */

const OBSIDIAN_STUB = `
import { StateField } from '@codemirror/state';
export const editorInfoField = StateField.define({ create: () => null, update: (value) => value });
export class MarkdownView {
  constructor(file, editor, mode = 'source') { this.file = file; this.editor = editor; this.mode = mode; }
  getMode() { return this.mode; }
  getViewType() { return 'markdown'; }
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
  MarkdownView: new (file: FakeFile | null, editor: FakeEditor, mode?: 'source' | 'preview') => FakeView;
  editorInfoField: StateField<unknown>;
};
const { TextTarget, bufferFileField, cooldownRemaining, diffSpan, insertAfterLine } = await import(
  '../src/notes/textTarget.ts'
);
const { CompanionStore, companionKeyOf, dayOf, setFrontmatterValue } = await import(
  '../src/notes/companionStore.ts'
);
const { insertDailyLink, sectionLinksTo } = await import('../src/editor/dailyLink.ts');
const { findSection } = await import('../src/editor/sectionAt.ts');

type App = ConstructorParameters<typeof TextTarget>[0];

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeFile {
  path: string;
  stat: { ctime: number; mtime: number; size: number };

  constructor(path: string, ctime = 0, size = 0) {
    this.path = path;
    this.stat = { ctime, mtime: ctime, size };
  }

  get name(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }

  get extension(): string {
    const dot = this.name.lastIndexOf('.');
    return dot < 0 ? '' : this.name.slice(dot + 1);
  }

  get basename(): string {
    const dot = this.name.lastIndexOf('.');
    return dot < 0 ? this.name : this.name.slice(0, dot);
  }
}

class FakeFolder {
  path: string;

  constructor(path: string) {
    this.path = path;
  }
}

class FakeVault {
  configDir = '.obsidian';
  readonly files = new Map<string, { file: FakeFile; data: string }>();
  readonly folders = new Map<string, FakeFolder>();
  /** Paths written through `process`, in order. An unchanged result is not a write. */
  readonly writes: string[] = [];
  readonly created: string[] = [];
  readonly createdFolders: string[] = [];
  /** Runs while `process` is reading, before its callback: the window in which a user can start typing. */
  duringRead: (() => void) | null = null;
  private clock = 1;

  add(path: string, data: string): FakeFile {
    const file = new FakeFile(path, this.clock++, Buffer.byteLength(data));
    this.files.set(path, { file, data });
    return file;
  }

  text(path: string): string {
    const entry = this.files.get(path);
    assert.ok(entry, `${path} is not in the fake vault`);
    return entry.data;
  }

  getFileByPath(path: string): FakeFile | null {
    return this.files.get(path)?.file ?? null;
  }

  getFolderByPath(path: string): FakeFolder | null {
    return this.folders.get(path) ?? null;
  }

  getAbstractFileByPath(path: string): FakeFile | FakeFolder | null {
    return this.getFileByPath(path) ?? this.getFolderByPath(path);
  }

  getMarkdownFiles(): FakeFile[] {
    return [...this.files.values()].map((entry) => entry.file).filter((file) => file.extension === 'md');
  }

  async read(file: FakeFile): Promise<string> {
    await settle();
    const entry = this.files.get(file.path);
    if (!entry) throw new Error('ENOENT');
    return entry.data;
  }

  async process(file: FakeFile, fn: (data: string) => string): Promise<string> {
    // As Obsidian does: the call returns at once and the file is read a moment later. A TFile
    // follows a rename, so a note renamed meanwhile is read, and written, under its new path.
    await settle();
    this.duringRead?.();
    const path = file.path;
    const entry = this.files.get(path);
    if (!entry) throw new Error('ENOENT');
    const next = fn(entry.data);
    // As Obsidian does: the same text back means nothing is written.
    if (next !== entry.data) {
      entry.data = next;
      entry.file.stat.mtime = this.clock++;
      entry.file.stat.size = Buffer.byteLength(next);
      this.writes.push(path);
    }
    return next;
  }

  async create(path: string, data: string): Promise<FakeFile> {
    await settle();
    if (this.getAbstractFileByPath(path)) throw new Error('File already exists.');
    const slash = path.lastIndexOf('/');
    if (slash >= 0 && !this.folders.has(path.slice(0, slash))) throw new Error('ENOENT: no such directory');
    this.created.push(path);
    return this.add(path, data);
  }

  async createFolder(path: string): Promise<FakeFolder> {
    await settle();
    if (this.getAbstractFileByPath(path)) throw new Error('Folder already exists.');
    const slash = path.lastIndexOf('/');
    if (slash >= 0 && !this.folders.has(path.slice(0, slash))) throw new Error('ENOENT: no such directory');
    const folder = new FakeFolder(path);
    this.folders.set(path, folder);
    this.createdFolders.push(path);
    return folder;
  }
}

interface Pos {
  line: number;
  ch: number;
}

/** What a Markdown view is to these modules: the note it shows, which changes before its editor's text does. */
interface FakeView {
  file: FakeFile | null;
  mode?: 'source' | 'preview';
  save?(): Promise<void>;
}

/** A stand-in for Obsidian's Editor over a real CodeMirror state. */
class FakeEditor {
  /** The CodeMirror view, as Obsidian exposes it at run time. Deleted to test the fallback. */
  cm?: { state: EditorState; dispatch(spec: TransactionSpec): void };
  readonly transactions: Transaction[] = [];
  readonly replaceCalls: Array<{ text: string; from: Pos; to: Pos | undefined; origin: string | undefined }> = [];
  private state: EditorState;
  /** As in Obsidian with the plugin on: every state knows its view and carries the plugin's field. */
  private extensions: Extension = [];

  constructor(text: string, withCm = true) {
    this.state = EditorState.create({ doc: text });
    if (withCm) {
      const editor = this;
      this.cm = {
        get state() {
          return editor.state;
        },
        dispatch: (spec) => this.apply(spec),
      };
    }
  }

  private apply(spec: TransactionSpec): void {
    const tr = this.state.update(spec);
    this.state = tr.state;
    this.transactions.push(tr);
  }

  getValue(): string {
    return this.state.doc.toString();
  }

  getLine(line: number): string {
    return line >= this.state.doc.lines ? '' : this.state.doc.line(line + 1).text;
  }

  lastLine(): number {
    return this.state.doc.lines - 1;
  }

  lineCount(): number {
    return this.state.doc.lines;
  }

  select(anchor: number, head = anchor): void {
    this.state = this.state.update({ selection: { anchor, head } }).state;
  }

  selection(): { from: number; to: number } {
    const { from, to } = this.state.selection.main;
    return { from, to };
  }

  /** What Obsidian does when it has read the file: the whole buffer is replaced, in a new state. */
  load(text: string): void {
    this.state = EditorState.create({ doc: text, extensions: this.extensions });
  }

  /** Ties the editor to its view. The text it holds now was loaded for the note the view shows now. */
  attach(view: FakeView): void {
    this.extensions = [obsidian.editorInfoField.init(() => view), bufferFileField];
    this.load(this.getValue());
  }

  posToOffset(pos: Pos): number {
    return this.state.doc.line(pos.line + 1).from + pos.ch;
  }

  getCursor(side: 'from' | 'to' | 'head' | 'anchor' = 'head'): Pos {
    return this.offsetToPos(this.state.selection.main[side]);
  }

  offsetToPos(offset: number): Pos {
    const line = this.state.doc.lineAt(offset);
    return { line: line.number - 1, ch: offset - line.from };
  }

  replaceRange(text: string, from: Pos, to?: Pos, origin?: string): void {
    this.replaceCalls.push({ text, from, to, origin });
    const start = this.posToOffset(from);
    this.apply({
      changes: { from: start, to: to ? this.posToOffset(to) : start, insert: text },
      scrollIntoView: true,
      userEvent: origin,
    });
  }
}

interface Leaf {
  isDeferred: boolean;
  view: object;
}

class FakeWorkspace {
  leaves: Leaf[] = [];
  recent: Leaf | null = null;

  getLeavesOfType(type: string): Leaf[] {
    return type === 'markdown' ? this.leaves : [];
  }

  getMostRecentLeaf(): Leaf | null {
    return this.recent;
  }
}

class Harness {
  readonly vault = new FakeVault();
  readonly workspace = new FakeWorkspace();
  readonly frontmatter = new Map<string, unknown>();
  readonly touches = new Map<string, number>();
  readonly sleeps: number[] = [];
  time = 100_000;
  settings: HamsterSettings = { ...DEFAULT_SETTINGS };
  /** Runs at each pause of the target, after the clock moved. */
  onSleep: (() => void) | null = null;
  /** Paths the views saved by themselves, in order. */
  readonly saves: string[] = [];
  /** What a view's save does instead of writing the file, to test a save that fails or never lands. */
  saveInstead: (() => void) | null = null;
  /** Notes the metadata cache has not read yet: a link to one of them resolves to nothing. */
  readonly unindexed = new Set<string>();
  /** Every link the metadata cache was asked to resolve, and from which note. */
  readonly resolutions: Array<{ linkpath: string; from: string }> = [];

  readonly app = {
    vault: this.vault,
    workspace: this.workspace,
    metadataCache: {
      getFileCache: (file: FakeFile) =>
        this.frontmatter.has(file.path) ? { frontmatter: this.frontmatter.get(file.path) } : null,
      /* Obsidian's rules, as far as these tests go: an empty link is the note
         it is in; a name finds a file in any folder, whatever the letter case,
         and a note also without its `.md`; a path finds the file at that path. */
      getFirstLinkpathDest: (linkpath: string, from: string): FakeFile | null => {
        this.resolutions.push({ linkpath, from });
        if (linkpath === '') return this.vault.getFileByPath(from);
        const wanted = linkpath.toLowerCase();
        for (const { file } of this.vault.files.values()) {
          if (this.unindexed.has(file.path)) continue;
          for (const known of [file.name.toLowerCase(), file.path.toLowerCase()]) {
            if (known === wanted || known === `${wanted}.md`) return file;
          }
        }
        return null;
      },
    },
  } as unknown as App;

  readonly target = new TextTarget(this.app, {
    lastTouch: (path) => this.touches.get(path),
    now: () => this.time,
    sleep: async (ms) => {
      this.sleeps.push(ms);
      this.time += ms;
      this.onSleep?.();
      await settle();
    },
  });

  readonly companions = new CompanionStore(this.app, () => this.settings, this.target);

  /**
   * Opens `path` in a pane. Returns the editor behind it. `loading` leaves its
   * buffer empty, as in a new view before the file is read. `showing` is the
   * note the pane showed until now: the view already points at `path`, and its
   * editor still holds the text of `showing`, until `load` is called.
   */
  open(
    path: string,
    opts: { mode?: 'source' | 'preview'; deferred?: boolean; cm?: boolean; loading?: boolean; showing?: string } = {},
  ): FakeEditor {
    const file = this.vault.getFileByPath(path);
    assert.ok(file, `${path} is not in the fake vault`);
    const before = opts.showing === undefined ? null : this.vault.getFileByPath(opts.showing);
    assert.ok(opts.showing === undefined || before, `${opts.showing} is not in the fake vault`);
    const editor = new FakeEditor(opts.loading ? '' : this.vault.text(before ? before.path : path), opts.cm ?? true);
    // A new view has no note yet when its first, empty state is made.
    const view = new obsidian.MarkdownView(opts.loading ? null : (before ?? file), editor, opts.mode ?? 'source');
    editor.attach(view);
    view.file = file;
    this.attachSave(view, editor);
    this.workspace.leaves.push({ isDeferred: opts.deferred ?? false, view: opts.deferred ? {} : view });
    return editor;
  }

  /**
   * Obsidian's TextFileView.save, step for step: the text is taken when the
   * save starts, one save runs at a time, and a call that comes meanwhile
   * returns at once and makes the view save again afterwards.
   */
  private attachSave(view: FakeView, editor: FakeEditor): void {
    let lastSaved = editor.getValue();
    let saving = false;
    let again = false;
    const save = async (): Promise<void> => {
      const file = view.file;
      if (!file) return;
      if (saving) {
        again = true;
        return;
      }
      again = false;
      const text = editor.getValue();
      if (text === lastSaved) return;
      lastSaved = text;
      saving = true;
      this.saves.push(file.path);
      try {
        // The adapter's queue, then the write.
        await settle();
        await settle();
        if (this.saveInstead) {
          this.saveInstead();
        } else {
          const entry = this.vault.files.get(file.path);
          if (entry) {
            entry.data = text;
            entry.file.stat.size = Buffer.byteLength(text);
          }
        }
      } finally {
        saving = false;
        if (again) void save();
      }
    };
    view.save = save;
  }
}

const KEY_SOURCE = '1:1 Jane Example#0';
const DATE = '2026-10-09';
const COMPANION_PATH = '00 Inbox/Mtg-2026-10-09 — 1-1 Jane Example.md';

function companionText(): string {
  return renderCompanion({
    title: '1:1 Jane Example',
    date: DATE,
    attendees: ['Jane Example'],
    projects: [],
    dailyBasename: DATE,
    source: KEY_SOURCE,
  });
}

function apply(before: string, span: { from: number; to: number; insert: string }): string {
  return before.slice(0, span.from) + span.insert + before.slice(span.to);
}

describe('diffSpan', () => {
  it('is null for equal texts', () => {
    assert.equal(diffSpan('', ''), null);
    assert.equal(diffSpan('same text', 'same text'), null);
  });

  it('finds an insertion in the middle', () => {
    assert.deepEqual(diffSpan('one three', 'one 2 three'), { from: 4, to: 4, insert: '2 ' });
  });

  it('finds a deletion in the middle', () => {
    assert.deepEqual(diffSpan('one 2 three', 'one three'), { from: 4, to: 6, insert: '' });
  });

  it('settles an ambiguous insertion on the longest shared start', () => {
    // "two " or "wo t": both turn one text into the other; the second starts later.
    assert.deepEqual(diffSpan('one three', 'one two three'), { from: 5, to: 5, insert: 'wo t' });
  });

  it('finds a replacement', () => {
    assert.deepEqual(diffSpan('the old line\n', 'the new line\n'), { from: 4, to: 7, insert: 'new' });
  });

  it('handles a change at the very start', () => {
    assert.deepEqual(diffSpan('body', '> body'), { from: 0, to: 0, insert: '> ' });
    assert.deepEqual(diffSpan('> body', 'body'), { from: 0, to: 2, insert: '' });
    assert.deepEqual(diffSpan('Xbody', 'Ybody'), { from: 0, to: 1, insert: 'Y' });
  });

  it('handles a change at the very end', () => {
    assert.deepEqual(diffSpan('body', 'body!'), { from: 4, to: 4, insert: '!' });
    assert.deepEqual(diffSpan('body!', 'body'), { from: 4, to: 5, insert: '' });
    assert.deepEqual(diffSpan('bodyX', 'bodyY'), { from: 4, to: 5, insert: 'Y' });
  });

  it('handles an empty side', () => {
    assert.deepEqual(diffSpan('', 'new'), { from: 0, to: 0, insert: 'new' });
    assert.deepEqual(diffSpan('old', ''), { from: 0, to: 3, insert: '' });
  });

  it('never lets the prefix and the suffix overlap around repeated characters', () => {
    const cases: Array<[string, string]> = [
      ['aaa', 'aaaa'],
      ['aaaa', 'aaa'],
      ['abab', 'ababab'],
      ['ababab', 'abab'],
      ['xaax', 'xaaax'],
      ['aXa', 'aa'],
      ['aa', 'aXa'],
      ['line\nline\n', 'line\nline\nline\n'],
      ['- a\n- a\n- a\n', '- a\n- a\n'],
    ];
    for (const [before, after] of cases) {
      const span = diffSpan(before, after);
      assert.ok(span, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      assert.ok(span.from <= span.to, 'the span runs forwards');
      assert.ok(span.to <= before.length, 'the span stays inside the text');
      assert.equal(apply(before, span), after);
    }
    assert.deepEqual(diffSpan('aaa', 'aaaa'), { from: 3, to: 3, insert: 'a' });
  });

  it('replaces only the region that changed in a companion', () => {
    const before = companionText();
    const after = before.replace(
      `${beginMarker('summary')}\n`,
      `${beginMarker('summary')}\nA short summary.\n`,
    );
    const span = diffSpan(before, after);
    assert.ok(span);
    assert.equal(span.insert, 'A short summary.\n');
    assert.equal(span.from, span.to);
    assert.equal(apply(before, span), after);
  });

  it('does not cut a surrogate pair in two', () => {
    const before = 'note 😀 end';
    const after = 'note 😁 end';
    const span = diffSpan(before, after);
    assert.ok(span);
    assert.equal(span.insert, '😁');
    assert.equal(before.slice(span.from, span.to), '😀');
    assert.equal(apply(before, span), after);
  });

  it('turns any text into any other (random pairs over a small alphabet)', () => {
    let seed = 20261009;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const word = (): string => {
      let out = '';
      const length = Math.floor(random() * 9);
      for (let i = 0; i < length; i++) out += 'ab\n'[Math.floor(random() * 3)];
      return out;
    };
    for (let i = 0; i < 3000; i++) {
      const before = word();
      const after = word();
      const span = diffSpan(before, after);
      if (before === after) {
        assert.equal(span, null);
        continue;
      }
      assert.ok(span);
      assert.equal(apply(before, span), after);
      // Minimal: what is replaced and what replaces it share neither their first nor their last character.
      const removed = before.slice(span.from, span.to);
      if (removed !== '' && span.insert !== '') {
        assert.notEqual(removed[0], span.insert[0]);
        assert.notEqual(removed[removed.length - 1], span.insert[span.insert.length - 1]);
      }
    }
  });
});

describe('cooldownRemaining', () => {
  it('is 0 for a note no editor has touched', () => {
    assert.equal(cooldownRemaining(5000, undefined, 2500), 0);
  });

  it('counts down from the last touch', () => {
    assert.equal(cooldownRemaining(1000, 1000, 2500), 2500);
    assert.equal(cooldownRemaining(1001, 1000, 2500), 2499);
    assert.equal(cooldownRemaining(3499, 1000, 2500), 1);
  });

  it('is 0 once the cooldown has passed, boundary included', () => {
    assert.equal(cooldownRemaining(3500, 1000, 2500), 0);
    assert.equal(cooldownRemaining(99_999, 1000, 2500), 0);
  });

  it('never exceeds one cooldown when the clock was set back', () => {
    assert.equal(cooldownRemaining(1000, 60_000, 2500), 2500);
  });

  it('is 0 without a cooldown or with unusable numbers', () => {
    assert.equal(cooldownRemaining(1000, 1000, 0), 0);
    assert.equal(cooldownRemaining(1000, 1000, -5), 0);
    assert.equal(cooldownRemaining(Number.NaN, 1000, 2500), 0);
    assert.equal(cooldownRemaining(1000, Number.NaN, 2500), 0);
  });
});

describe('insertAfterLine', () => {
  it('inserts after a line in the middle', () => {
    assert.equal(insertAfterLine('a\nb\nc\n', 1, 'X'), 'a\nb\nX\nc\n');
  });

  it('inserts after the first line', () => {
    assert.equal(insertAfterLine('a\nb\n', 0, 'X'), 'a\nX\nb\n');
  });

  it('inserts after a last line that has no line ending', () => {
    assert.equal(insertAfterLine('a\nb', 1, 'X'), 'a\nb\nX');
    assert.equal(insertAfterLine('only', 0, 'X'), 'only\nX');
  });

  it('inserts after the empty line that follows a final line ending', () => {
    assert.equal(insertAfterLine('a\n', 1, 'X'), 'a\n\nX');
  });

  it('keeps Windows line endings', () => {
    assert.equal(insertAfterLine('a\r\nb\r\nc\r\n', 1, 'X'), 'a\r\nb\r\nX\r\nc\r\n');
    assert.equal(insertAfterLine('a\r\nb', 1, 'X'), 'a\r\nb\r\nX');
    assert.equal(insertAfterLine('a\r\n\r\nc', 1, 'X'), 'a\r\n\r\nX\r\nc');
  });

  it('writes a two-line insertion in the file\'s own line endings', () => {
    assert.equal(insertAfterLine('- a\n- b\n', 1, '\n↳ link'), '- a\n- b\n\n↳ link\n');
    assert.equal(insertAfterLine('- a\r\n- b\r\n', 1, '\n↳ link'), '- a\r\n- b\r\n\r\n↳ link\r\n');
  });

  it('is null when the text has no such line', () => {
    assert.equal(insertAfterLine('a\nb', 2, 'X'), null);
    assert.equal(insertAfterLine('', 1, 'X'), null);
    assert.equal(insertAfterLine('a', -1, 'X'), null);
    assert.equal(insertAfterLine('a', 0.5, 'X'), null);
  });

  it('inserts into an empty text', () => {
    assert.equal(insertAfterLine('', 0, 'X'), '\nX');
  });
});

describe('bufferFileField', () => {
  const fileA = new FakeFile('a.md');
  const fileB = new FakeFile('b.md');

  it('records the note its state was created for, whatever the order of the extensions', () => {
    const view: FakeView = { file: fileA };
    const info = obsidian.editorInfoField.init(() => view);
    for (const extensions of [[info, bufferFileField], [bufferFileField, info]]) {
      const state = EditorState.create({ doc: 'text of a', extensions });
      assert.equal(state.field(bufferFileField), fileA);
    }
  });

  it('keeps that note through every change, even after the view is pointed at another', () => {
    const view: FakeView = { file: fileA };
    let state = EditorState.create({
      doc: 'text of a',
      extensions: [obsidian.editorInfoField.init(() => view), bufferFileField],
    });
    view.file = fileB;
    state = state.update({ changes: { from: 0, insert: 'typed ' } }).state;
    state = state.update({ selection: { anchor: 2 } }).state;
    assert.equal(state.field(bufferFileField), fileA);

    // The state Obsidian makes once it has read the other note.
    const next = EditorState.create({
      doc: 'text of b',
      extensions: [obsidian.editorInfoField.init(() => view), bufferFileField],
    });
    assert.equal(next.field(bufferFileField), fileB);
  });

  it('is null for an editor without a note, and absent where the plugin is not installed', () => {
    const empty: FakeView = { file: null };
    const withoutFile = EditorState.create({
      extensions: [obsidian.editorInfoField.init(() => empty), bufferFileField],
    });
    assert.equal(withoutFile.field(bufferFileField), null);
    assert.equal(EditorState.create({ extensions: [bufferFileField] }).field(bufferFileField), null);
    assert.equal(EditorState.create({}).field(bufferFileField, false), undefined);
  });
});

describe('TextTarget.openEditor and read', () => {
  it('reads the file when the note is not open, and null when it does not exist', async () => {
    const h = new Harness();
    h.vault.add('a.md', 'on disk');
    assert.equal(h.target.openEditor('a.md'), null);
    assert.equal(await h.target.read('a.md'), 'on disk');
    assert.equal(await h.target.read('missing.md'), null);
    assert.equal(h.target.openEditor('missing.md'), null);
  });

  it('reads the editor buffer when the note is open in source mode', async () => {
    const h = new Harness();
    h.vault.add('a.md', 'on disk');
    const editor = h.open('a.md');
    editor.replaceRange('typed, not saved yet: ', { line: 0, ch: 0 });
    assert.equal(h.target.openEditor('a.md')?.editor, editor);
    assert.equal(await h.target.read('a.md'), 'typed, not saved yet: on disk');
  });

  it('ignores a Reading view: its editor is a stale buffer', async () => {
    const h = new Harness();
    h.vault.add('a.md', 'on disk');
    h.open('a.md', { mode: 'preview' });
    assert.equal(h.target.openEditor('a.md'), null);
    assert.equal(await h.target.read('a.md'), 'on disk');
  });

  it('ignores a deferred leaf and a leaf showing another note', () => {
    const h = new Harness();
    h.vault.add('a.md', 'a');
    h.vault.add('b.md', 'b');
    h.open('a.md', { deferred: true });
    h.open('b.md');
    assert.equal(h.target.openEditor('a.md'), null);
  });

  it('prefers the source-mode pane over a Reading pane of the same note', () => {
    const h = new Harness();
    h.vault.add('a.md', 'a');
    h.open('a.md', { mode: 'preview' });
    const editor = h.open('a.md');
    assert.equal(h.target.openEditor('a.md')?.editor, editor);
  });

  it('prefers the pane used last when the note is open in several', () => {
    const h = new Harness();
    h.vault.add('a.md', 'a');
    const first = h.open('a.md');
    const second = h.open('a.md');
    assert.equal(h.target.openEditor('a.md')?.editor, first);
    h.workspace.recent = h.workspace.leaves[1];
    assert.equal(h.target.openEditor('a.md')?.editor, second);
  });

  it('gives the cursor of the pane used last, as an offset in the text', () => {
    const h = new Harness();
    h.vault.add('a.md', 'first\nsecond\nthird');
    assert.equal(h.target.cursor('a.md'), null, 'not open');

    const first = h.open('a.md');
    const second = h.open('a.md');
    first.select(8);
    second.select(2, 15);
    assert.equal(h.target.cursor('a.md'), 8);
    h.workspace.recent = h.workspace.leaves[1];
    assert.equal(h.target.cursor('a.md'), 15, 'the head of a selection');
    assert.equal(h.target.cursor('missing.md'), null);
  });

  it('gives no cursor for a note in Reading view', () => {
    const h = new Harness();
    h.vault.add('a.md', 'text');
    h.open('a.md', { mode: 'preview' }).select(3);
    assert.equal(h.target.cursor('a.md'), null);
  });

  it('does not take the empty buffer of a view that is still reading the file for the note', async () => {
    const h = new Harness();
    h.vault.add('a.md', 'on disk');
    const editor = h.open('a.md', { loading: true });
    assert.equal(h.target.openEditor('a.md'), null);
    assert.equal(await h.target.read('a.md'), 'on disk');

    editor.load('on disk');
    assert.equal(h.target.openEditor('a.md')?.editor, editor);
  });

  it('does not take the text a view still holds from the note it showed before', async () => {
    const h = new Harness();
    h.vault.add('yesterday.md', 'yesterday, on disk');
    h.vault.add('today.md', 'today, on disk');
    // The pane showed yesterday's note and was just pointed at today's: Obsidian is still reading it.
    const editor = h.open('today.md', { showing: 'yesterday.md' });
    assert.equal(editor.getValue(), 'yesterday, on disk');
    assert.equal(h.target.openEditor('today.md'), null);
    assert.equal(await h.target.read('today.md'), 'today, on disk');
    assert.equal(h.target.openEditor('yesterday.md'), null, 'nor is the view on the old note any more');

    editor.load('today, on disk');
    assert.equal(h.target.openEditor('today.md')?.editor, editor);
    assert.equal(await h.target.read('today.md'), 'today, on disk');
  });

  it('still knows an open note after it is renamed', async () => {
    const h = new Harness();
    const file = h.vault.add('a.md', 'text');
    const editor = h.open('a.md');
    // Obsidian keeps the file object and gives it its new path.
    const entry = h.vault.files.get('a.md');
    assert.ok(entry);
    h.vault.files.delete('a.md');
    file.path = '30 Archive/b.md';
    h.vault.files.set(file.path, entry);

    assert.equal(h.target.openEditor('30 Archive/b.md')?.editor, editor);
    assert.equal(h.target.openEditor('a.md'), null);
  });

  it('still knows an open note whose file was replaced under the same path', () => {
    const h = new Harness();
    h.vault.add('a.md', 'text');
    const editor = h.open('a.md');
    // Deleted and created again by a sync: another file object, the same note to the user.
    h.vault.add('a.md', 'text');
    assert.equal(h.target.openEditor('a.md')?.editor, editor);
  });

  it('has no opinion about an editor that does not carry the plugin\'s field', () => {
    const h = new Harness();
    const file = h.vault.add('a.md', 'text');
    const editor = new FakeEditor('text');
    h.workspace.leaves.push({ isDeferred: false, view: new obsidian.MarkdownView(file, editor) });
    assert.equal(h.target.openEditor('a.md')?.editor, editor);
  });

  it('takes an empty buffer for the note when the file is empty too', async () => {
    const h = new Harness();
    h.vault.add('new.md', '');
    const editor = h.open('new.md');
    assert.equal(h.target.openEditor('new.md')?.editor, editor);
    assert.equal(await h.target.read('new.md'), '');
  });

  it('finds a note whose path was built without Obsidian\'s normalization', async () => {
    const h = new Harness();
    h.vault.add('00 Inbox/a.md', 'text');
    assert.equal(await h.target.read('/00 Inbox//a.md'), 'text');
  });
});

describe('TextTarget.writeRegions', () => {
  const summary: Patch = { region: 'summary', content: 'A short summary.' };
  const transcript: Patch = { region: 'transcript', append: '> **[00:01] Fred:** bonjour' };

  it('answers missing when there is no such file', async () => {
    const h = new Harness();
    assert.deepEqual(await h.target.writeRegions('nope.md', [summary]), { status: 'missing' });
  });

  it('writes through the editor when the note is open in source mode', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    const editor = h.open(COMPANION_PATH);

    assert.deepEqual(await h.target.writeRegions(COMPANION_PATH, [summary]), { status: 'ok' });

    assert.equal(readRegion(editor.getValue(), 'summary'), 'A short summary.\n');
    assert.deepEqual(h.vault.writes, [], 'no Vault write while an editor holds the note');
    assert.equal(h.vault.text(COMPANION_PATH), companionText(), 'the file is left to the editor to save');
  });

  it('dispatches one transaction that is neither undoable nor scrolling, stamped with the plugin origin', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    const editor = h.open(COMPANION_PATH);

    await h.target.writeRegions(COMPANION_PATH, [summary, transcript]);

    assert.equal(editor.transactions.length, 1, 'two patches, one transaction');
    assert.equal(editor.replaceCalls.length, 0, 'replaceRange scrolls and lands in the history');
    const tr = editor.transactions[0];
    assert.equal(tr.annotation(Transaction.addToHistory), false);
    assert.equal(tr.annotation(Transaction.userEvent), EDIT_ORIGIN);
    assert.equal(tr.isUserEvent(EDIT_ORIGIN), true);
    assert.equal(tr.isUserEvent('input'), false);
    assert.equal(tr.scrollIntoView, false);
    assert.equal(tr.selection, undefined, 'the cursor is only mapped, never set');

    // One small change per region: what lies between the two regions is not replaced.
    const before = companionText();
    const ranges: Array<[number, number, string]> = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      ranges.push([fromA, toA, inserted.toString()]);
    });
    assert.deepEqual(ranges, [
      [before.indexOf(endMarker('summary')), before.indexOf(endMarker('summary')), 'A short summary.\n'],
      [
        before.indexOf(endMarker('transcript')),
        before.indexOf(endMarker('transcript')),
        '> **[00:01] Fred:** bonjour\n',
      ],
    ]);
    assert.equal(readRegion(editor.getValue(), 'summary'), 'A short summary.\n');
    assert.match(readRegion(editor.getValue(), 'transcript') ?? '', /bonjour\n$/);
  });

  it('leaves a cursor between two regions exactly where the user has it', async () => {
    const h = new Harness();
    const text = companionText().replace('## Q&A insights', 'My own remark.\n\n## Q&A insights');
    h.vault.add(COMPANION_PATH, text);
    const editor = h.open(COMPANION_PATH);
    // The user is typing in their own line, between the summary and the Q&A regions.
    const at = text.indexOf('remark.');
    editor.select(at, at + 6);

    await h.target.writeRegions(COMPANION_PATH, [
      { region: 'enhanced', content: '* **Budget:** approved for the fourth quarter.' },
      summary,
      { region: 'qa', content: '**Q:** who owns it\n\n**A:** Jane.' },
      transcript,
    ]);

    const selection = editor.selection();
    assert.equal(editor.getValue().slice(selection.from, selection.to), 'remark');
    assert.equal(editor.transactions.at(-1)?.changes.touchesRange(at, at + 6), false);
    assert.ok(editor.getValue().includes('My own remark.\n\n## Q&A insights'));
  });

  it('makes the same text as the Vault path does, whatever the patches', async () => {
    const batches: Patch[][] = [
      [summary],
      [transcript, { region: 'transcript', append: '> **[00:09] Fred:** deuxième tour' }],
      [{ region: 'enhanced', content: 'line one\r\nline two' }, summary, transcript],
      [{ region: 'summary', content: '' }, { region: 'qa', content: '\n\nkept\n\n' }],
      [summary, { region: 'summary', content: 'A newer summary.' }],
    ];
    for (const batch of batches) {
      const viaEditor = new Harness();
      viaEditor.vault.add(COMPANION_PATH, companionText());
      const editor = viaEditor.open(COMPANION_PATH);
      const viaVault = new Harness();
      viaVault.vault.add(COMPANION_PATH, companionText());

      const a = await viaEditor.target.writeRegions(COMPANION_PATH, batch);
      const b = await viaVault.target.writeRegions(COMPANION_PATH, batch);

      assert.deepEqual(a, b);
      // The editor keeps one kind of line break; the file keeps what the patch carried.
      assert.equal(editor.getValue(), viaVault.vault.text(COMPANION_PATH).replace(/\r\n/g, '\n'));
    }
  });

  it('leaves the text outside the regions byte for byte as the user has it', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    const editor = h.open(COMPANION_PATH);
    const last = editor.lastLine();
    editor.replaceRange('\nMy own remark.', { line: last, ch: 0 });
    const typed = editor.getValue();

    await h.target.writeRegions(COMPANION_PATH, [summary]);

    const now = editor.getValue();
    assert.ok(now.endsWith('\nMy own remark.'));
    assert.equal(now.replace('A short summary.\n', ''), typed);
  });

  it('falls back to replaceRange when the CodeMirror view is not exposed', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    const editor = h.open(COMPANION_PATH, { cm: false });

    assert.deepEqual(await h.target.writeRegions(COMPANION_PATH, [summary, transcript]), { status: 'ok' });

    assert.equal(editor.replaceCalls.length, 2, 'one small replacement per region');
    assert.ok(editor.replaceCalls.every((call) => call.origin === EDIT_ORIGIN));
    assert.equal(editor.replaceCalls[0].text, 'A short summary.\n');
    assert.equal(readRegion(editor.getValue(), 'summary'), 'A short summary.\n');
    assert.match(readRegion(editor.getValue(), 'transcript') ?? '', /bonjour\n$/);
  });

  it('does not dispatch when the regions already hold that content', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    const editor = h.open(COMPANION_PATH);
    await h.target.writeRegions(COMPANION_PATH, [summary]);
    assert.deepEqual(await h.target.writeRegions(COMPANION_PATH, [summary]), { status: 'ok' });
    assert.equal(editor.transactions.length, 1);
  });

  it('writes through the Vault when the note is in Reading view, leaving its editor alone', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    const editor = h.open(COMPANION_PATH, { mode: 'preview' });

    assert.deepEqual(await h.target.writeRegions(COMPANION_PATH, [summary]), { status: 'ok' });

    assert.deepEqual(h.vault.writes, [COMPANION_PATH]);
    assert.equal(readRegion(h.vault.text(COMPANION_PATH), 'summary'), 'A short summary.\n');
    assert.equal(editor.transactions.length, 0);
  });

  it('writes through the Vault when the note is not open', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    assert.deepEqual(await h.target.writeRegions(COMPANION_PATH, [summary, transcript]), { status: 'ok' });
    const text = h.vault.text(COMPANION_PATH);
    assert.equal(readRegion(text, 'summary'), 'A short summary.\n');
    assert.match(readRegion(text, 'transcript') ?? '', /bonjour\n$/);
  });

  it('refuses a Vault write inside the cooldown and says how long to wait', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    h.touches.set(COMPANION_PATH, h.time - 1000);

    assert.deepEqual(await h.target.writeRegions(COMPANION_PATH, [summary]), { status: 'retry', afterMs: 1500 });
    assert.deepEqual(h.vault.writes, []);

    h.time += 1500;
    assert.deepEqual(await h.target.writeRegions(COMPANION_PATH, [summary]), { status: 'ok' });
    assert.deepEqual(h.vault.writes, [COMPANION_PATH]);
  });

  it('merges into the text Obsidian hands over, not into text read earlier', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    // Another device's edit lands while the write is being prepared.
    h.vault.duringRead = () => {
      const entry = h.vault.files.get(COMPANION_PATH);
      assert.ok(entry);
      entry.data = entry.data.replace('# 1:1 Jane Example', '# 1:1 Jane Example (renamed elsewhere)');
    };

    await h.target.writeRegions(COMPANION_PATH, [summary]);

    const text = h.vault.text(COMPANION_PATH);
    assert.ok(text.includes('(renamed elsewhere)'));
    assert.equal(readRegion(text, 'summary'), 'A short summary.\n');
  });

  it('backs off when typing starts while the file is being read', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    h.vault.duringRead = () => h.touches.set(COMPANION_PATH, h.time);

    assert.deepEqual(await h.target.writeRegions(COMPANION_PATH, [summary]), { status: 'retry', afterMs: 2500 });
    assert.deepEqual(h.vault.writes, []);
    assert.equal(h.vault.text(COMPANION_PATH), companionText());
  });

  it('backs off when the note is opened in an editor while the file is being read', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    h.vault.duringRead = () => {
      h.vault.duringRead = null;
      h.open(COMPANION_PATH);
    };

    const outcome = await h.target.writeRegions(COMPANION_PATH, [summary]);
    assert.equal(outcome.status, 'retry');
    assert.deepEqual(h.vault.writes, []);

    // The retry goes through the editor that is now open.
    assert.deepEqual(await h.target.writeRegions(COMPANION_PATH, [summary]), { status: 'ok' });
    assert.deepEqual(h.vault.writes, []);
  });

  it('does not call the regions damaged because a view has not read the file yet', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    const editor = h.open(COMPANION_PATH, { loading: true });

    // Nothing is pending in that view, so the file itself can be written.
    assert.deepEqual(await h.target.writeRegions(COMPANION_PATH, [summary]), { status: 'ok' });
    assert.equal(editor.transactions.length, 0);
    assert.equal(readRegion(h.vault.text(COMPANION_PATH), 'summary'), 'A short summary.\n');

    // Once it shows the note, writes go through it again.
    editor.load(h.vault.text(COMPANION_PATH));
    await h.target.writeRegions(COMPANION_PATH, [transcript]);
    assert.equal(editor.transactions.length, 1);
    assert.deepEqual(h.vault.writes, [COMPANION_PATH]);
  });

  it('does not write into the text of the note the view showed before', async () => {
    const h = new Harness();
    // Another companion: its markers would take the patches without complaint.
    h.vault.add('00 Inbox/Mtg-other.md', companionText());
    h.vault.add(COMPANION_PATH, companionText());
    const editor = h.open(COMPANION_PATH, { showing: '00 Inbox/Mtg-other.md' });

    assert.deepEqual(await h.target.writeRegions(COMPANION_PATH, [summary, transcript]), { status: 'ok' });
    assert.equal(editor.transactions.length, 0, 'the buffer that is still the other note is left alone');
    assert.deepEqual(h.vault.writes, [COMPANION_PATH]);
    assert.equal(readRegion(h.vault.text(COMPANION_PATH), 'summary'), 'A short summary.\n');
    assert.equal(readRegion(h.vault.text('00 Inbox/Mtg-other.md'), 'summary'), '');

    // Once the view has read the companion, writes go through its editor.
    editor.load(h.vault.text(COMPANION_PATH));
    await h.target.writeRegions(COMPANION_PATH, [{ region: 'summary', content: 'Another summary.' }]);
    assert.equal(editor.transactions.length, 1);
    assert.equal(readRegion(editor.getValue(), 'summary'), 'Another summary.\n');
    assert.deepEqual(h.vault.writes, [COMPANION_PATH]);
  });

  it('reports the regions of a note the user emptied, once that is saved', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    const editor = h.open(COMPANION_PATH);
    editor.load('');
    h.touches.set(COMPANION_PATH, h.time);

    // Just emptied: the editor's save is pending, so the file is left alone.
    assert.equal((await h.target.writeRegions(COMPANION_PATH, [summary])).status, 'retry');
    assert.deepEqual(h.vault.writes, []);

    // Saved: the empty text is the note.
    const entry = h.vault.files.get(COMPANION_PATH);
    assert.ok(entry);
    entry.data = '';
    entry.file.stat.size = 0;
    h.time += 3000;
    assert.deepEqual(await h.target.writeRegions(COMPANION_PATH, [summary]), {
      status: 'detached',
      regions: ['summary'],
    });
  });

  it('does not write when nothing changes', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    await h.target.writeRegions(COMPANION_PATH, [summary]);
    assert.deepEqual(await h.target.writeRegions(COMPANION_PATH, [summary]), { status: 'ok' });
    assert.deepEqual(h.vault.writes, [COMPANION_PATH], 'one write for two identical calls');
  });

  it('reports every damaged region and still writes the others (Vault)', async () => {
    const h = new Harness();
    const damaged = companionText()
      .replace(`${endMarker('summary')}\n`, '')
      .replace(beginMarker('qa'), '<!-- hamster:begin  qa -->');
    h.vault.add(COMPANION_PATH, damaged);

    const outcome = await h.target.writeRegions(COMPANION_PATH, [
      summary,
      { region: 'qa', content: 'kept answer' },
      { region: 'enhanced', content: '* **Topic:** text' },
    ]);

    assert.deepEqual(outcome, { status: 'detached', regions: ['summary', 'qa'] });
    const text = h.vault.text(COMPANION_PATH);
    assert.equal(readRegion(text, 'enhanced'), '* **Topic:** text\n');
    assert.ok(!text.includes('A short summary.'));
    assert.ok(!text.includes('kept answer'));
  });

  it('reports a damaged region and still writes the others (editor)', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText().replace(`${beginMarker('summary')}\n`, ''));
    const editor = h.open(COMPANION_PATH);

    const outcome = await h.target.writeRegions(COMPANION_PATH, [summary, transcript]);

    assert.deepEqual(outcome, { status: 'detached', regions: ['summary'] });
    assert.match(readRegion(editor.getValue(), 'transcript') ?? '', /bonjour\n$/);
    assert.ok(!editor.getValue().includes('A short summary.'));
  });

  it('reports a damaged region even when there is nothing else to write', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText().replace(`${beginMarker('summary')}\n`, ''));
    assert.deepEqual(await h.target.writeRegions(COMPANION_PATH, [summary]), {
      status: 'detached',
      regions: ['summary'],
    });
    assert.deepEqual(h.vault.writes, []);
  });

  it('answers missing when the file is deleted while the write is being prepared', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    h.vault.duringRead = () => h.vault.files.delete(COMPANION_PATH);
    assert.deepEqual(await h.target.writeRegions(COMPANION_PATH, [summary]), { status: 'missing' });
  });
});

describe('TextTarget.insertLine', () => {
  it('inserts through the editor with replaceRange, so the user can undo it', async () => {
    const h = new Harness();
    h.vault.add('daily.md', 'first\nsecond\nthird');
    const editor = h.open('daily.md');

    const via = await h.target.insertLine('daily.md', (text) => {
      assert.equal(text, 'first\nsecond\nthird');
      return { afterLine: 1, text: 'added' };
    });

    assert.equal(via, 'editor');
    assert.equal(editor.getValue(), 'first\nsecond\nadded\nthird');
    assert.deepEqual(editor.replaceCalls, [
      { text: '\nadded', from: { line: 1, ch: 6 }, to: undefined, origin: EDIT_ORIGIN },
    ]);
    const tr = editor.transactions[0];
    assert.notEqual(tr.annotation(Transaction.addToHistory), false, 'the line stays in the undo history');
    assert.deepEqual(h.vault.writes, []);
  });

  it('hands the editor the text as it is at write time, not as the file has it', async () => {
    const h = new Harness();
    h.vault.add('daily.md', 'first');
    const editor = h.open('daily.md');
    editor.replaceRange('\ntyped just now', { line: 0, ch: 5 });

    let seen = '';
    await h.target.insertLine('daily.md', (text) => {
      seen = text;
      return { afterLine: 1, text: 'added' };
    });

    assert.equal(seen, 'first\ntyped just now');
    assert.equal(editor.getValue(), 'first\ntyped just now\nadded');
  });

  it('never hands compute the text of the note the view showed before', async () => {
    const h = new Harness();
    h.vault.add('2026-10-08.md', '### 1:1 Jane Example\n- from yesterday');
    h.vault.add('daily.md', '### 1:1 Jane Example\n- from today');
    const editor = h.open('daily.md', { showing: '2026-10-08.md' });

    let seen = '';
    const via = await h.target.insertLine('daily.md', (text) => {
      seen = text;
      return { afterLine: 1, text: 'added' };
    });

    assert.equal(seen, '### 1:1 Jane Example\n- from today');
    assert.equal(via, 'vault');
    assert.equal(editor.transactions.length, 0);
    assert.equal(h.vault.text('daily.md'), '### 1:1 Jane Example\n- from today\nadded');
    assert.equal(h.vault.text('2026-10-08.md'), '### 1:1 Jane Example\n- from yesterday');
  });

  it('does nothing when compute returns null', async () => {
    const h = new Harness();
    h.vault.add('daily.md', 'first');
    const editor = h.open('daily.md');
    assert.equal(await h.target.insertLine('daily.md', () => null), 'skipped');
    assert.equal(editor.transactions.length, 0);

    const closed = new Harness();
    closed.vault.add('daily.md', 'first');
    assert.equal(await closed.target.insertLine('daily.md', () => null), 'skipped');
    assert.deepEqual(closed.vault.writes, []);
  });

  it('refuses a line number the text does not have', async () => {
    const h = new Harness();
    h.vault.add('daily.md', 'first\nsecond');
    const editor = h.open('daily.md');
    assert.equal(await h.target.insertLine('daily.md', () => ({ afterLine: 2, text: 'x' })), 'skipped');
    assert.equal(editor.transactions.length, 0);
  });

  it('inserts through the Vault when the note is not open, keeping its line endings', async () => {
    const h = new Harness();
    h.vault.add('daily.md', 'first\r\nsecond\r\nthird\r\n');

    const via = await h.target.insertLine('daily.md', () => ({ afterLine: 1, text: '\nadded' }));

    assert.equal(via, 'vault');
    assert.equal(h.vault.text('daily.md'), 'first\r\nsecond\r\n\r\nadded\r\nthird\r\n');
  });

  it('inserts through the Vault when the note is in Reading view', async () => {
    const h = new Harness();
    h.vault.add('daily.md', 'first\nsecond');
    const editor = h.open('daily.md', { mode: 'preview' });
    assert.equal(await h.target.insertLine('daily.md', () => ({ afterLine: 0, text: 'added' })), 'vault');
    assert.equal(h.vault.text('daily.md'), 'first\nadded\nsecond');
    assert.equal(editor.transactions.length, 0);
  });

  it('waits out the cooldown before a Vault write', async () => {
    const h = new Harness();
    h.vault.add('daily.md', 'first');
    h.touches.set('daily.md', h.time - 2000);
    const started = h.time;

    assert.equal(await h.target.insertLine('daily.md', () => ({ afterLine: 0, text: 'added' })), 'vault');

    assert.ok(h.time - started >= 500, 'the remaining half second was waited');
    assert.ok(h.sleeps.every((ms) => ms > 0 && ms <= 250), 'polled in short steps');
    assert.equal(h.vault.text('daily.md'), 'first\nadded');
  });

  it('gives up without writing when the note stays busy', async () => {
    const h = new Harness();
    h.vault.add('daily.md', 'first');
    // Something keeps changing the note in an editor that is not in source mode.
    h.touches.set('daily.md', h.time);
    h.onSleep = () => h.touches.set('daily.md', h.time);
    const started = h.time;
    let computed = 0;

    const via = await h.target.insertLine('daily.md', () => {
      computed += 1;
      return { afterLine: 0, text: 'added' };
    });

    assert.equal(via, 'skipped');
    assert.equal(computed, 0);
    assert.deepEqual(h.vault.writes, []);
    assert.equal(h.vault.text('daily.md'), 'first');
    assert.ok(h.time - started >= 6000 && h.time - started < 7000, 'gave up after about six seconds');
  });

  it('switches to the editor when the note is opened while it waits', async () => {
    const h = new Harness();
    h.vault.add('daily.md', 'first');
    h.touches.set('daily.md', h.time);
    let editor: FakeEditor | null = null;
    h.onSleep = () => {
      editor ??= h.open('daily.md');
    };

    assert.equal(await h.target.insertLine('daily.md', () => ({ afterLine: 0, text: 'added' })), 'editor');
    assert.ok(editor);
    assert.equal((editor as FakeEditor).getValue(), 'first\nadded');
    assert.deepEqual(h.vault.writes, []);
  });

  it('does not write when typing starts while the file is being read, and tries again', async () => {
    const h = new Harness();
    h.vault.add('daily.md', 'first');
    h.vault.duringRead = () => {
      h.vault.duringRead = null;
      h.touches.set('daily.md', h.time);
    };

    assert.equal(await h.target.insertLine('daily.md', () => ({ afterLine: 0, text: 'added' })), 'vault');
    assert.deepEqual(h.vault.writes, ['daily.md'], 'exactly one write, after the cooldown');
    assert.ok(h.sleeps.length > 0);
  });

  it('answers missing when there is no such file', async () => {
    const h = new Harness();
    assert.equal(await h.target.insertLine('daily.md', () => ({ afterLine: 0, text: 'x' })), 'missing');
  });
});

describe('TextTarget.edit', () => {
  const NOTE = '---\ntype: note\n---\nbody\n';
  const addDate = (text: string): string => text.replace('type: note\n', 'type: note\ndate: 2026-10-09\n');

  it('edits through the editor with one replaceRange over the span that differs, so the user can undo it', async () => {
    const h = new Harness();
    h.vault.add('note.md', NOTE);
    const editor = h.open('note.md');
    // The cursor on the "o" of "body".
    editor.select(NOTE.indexOf('body') + 1);

    const via = await h.target.edit('note.md', (text) => {
      assert.equal(text, NOTE);
      return addDate(text);
    });

    assert.equal(via, 'editor');
    assert.equal(editor.getValue(), addDate(NOTE));
    assert.deepEqual(editor.replaceCalls, [
      { text: 'date: 2026-10-09\n', from: { line: 2, ch: 0 }, to: { line: 2, ch: 0 }, origin: EDIT_ORIGIN },
    ]);
    const tr = editor.transactions[0];
    assert.notEqual(tr.annotation(Transaction.addToHistory), false, 'the change stays in the undo history');
    assert.equal(editor.getValue().slice(editor.selection().from), 'ody\n', 'the cursor stays on its text');
    assert.deepEqual(h.vault.writes, []);
  });

  it('hands fn the text as it is at write time, and reads a result in Windows line endings as the editor would', async () => {
    const h = new Harness();
    h.vault.add('note.md', 'first');
    const editor = h.open('note.md');
    editor.replaceRange('\ntyped just now', { line: 0, ch: 5 });

    let seen = '';
    const via = await h.target.edit('note.md', (text) => {
      seen = text;
      return `${text}\r\nadded\r\n`;
    });

    assert.equal(seen, 'first\ntyped just now');
    assert.equal(via, 'editor');
    assert.equal(editor.getValue(), 'first\ntyped just now\nadded\n');
    assert.equal(editor.replaceCalls.length, 2, 'the typing, then one change');
  });

  it('answers unchanged, and touches nothing, when fn returns null or the same text', async () => {
    const h = new Harness();
    h.vault.add('note.md', NOTE);
    const editor = h.open('note.md');
    assert.equal(await h.target.edit('note.md', () => null), 'unchanged');
    assert.equal(await h.target.edit('note.md', (text) => text), 'unchanged');
    assert.equal(editor.transactions.length, 0);

    const closed = new Harness();
    closed.vault.add('note.md', NOTE);
    assert.equal(await closed.target.edit('note.md', () => null), 'unchanged');
    assert.equal(await closed.target.edit('note.md', (text) => text), 'unchanged');
    assert.deepEqual(closed.vault.writes, []);
  });

  it('writes through the Vault when the note is not open, or is in Reading view', async () => {
    const h = new Harness();
    h.vault.add('note.md', NOTE);
    assert.equal(await h.target.edit('note.md', addDate), 'vault');
    assert.equal(h.vault.text('note.md'), addDate(NOTE));

    const reading = new Harness();
    reading.vault.add('note.md', NOTE);
    const editor = reading.open('note.md', { mode: 'preview' });
    assert.equal(await reading.target.edit('note.md', addDate), 'vault');
    assert.equal(reading.vault.text('note.md'), addDate(NOTE));
    assert.equal(editor.transactions.length, 0);
  });

  it('waits out the cooldown before a Vault write', async () => {
    const h = new Harness();
    h.vault.add('note.md', NOTE);
    h.touches.set('note.md', h.time - 2000);
    const started = h.time;

    assert.equal(await h.target.edit('note.md', addDate), 'vault');

    assert.ok(h.time - started >= 500, 'the remaining half second was waited');
    assert.ok(h.sleeps.every((ms) => ms > 0 && ms <= 250), 'polled in short steps');
    assert.equal(h.vault.text('note.md'), addDate(NOTE));
  });

  it('gives up without writing when the note stays busy', async () => {
    const h = new Harness();
    h.vault.add('note.md', NOTE);
    h.touches.set('note.md', h.time);
    h.onSleep = () => h.touches.set('note.md', h.time);
    const started = h.time;
    let computed = 0;

    const via = await h.target.edit('note.md', (text) => {
      computed += 1;
      return addDate(text);
    });

    assert.equal(via, 'busy');
    assert.equal(computed, 0);
    assert.deepEqual(h.vault.writes, []);
    assert.equal(h.vault.text('note.md'), NOTE);
    assert.ok(h.time - started >= 6000 && h.time - started < 7000, 'gave up after about six seconds');
  });

  it('switches to the editor when the note is opened while it waits', async () => {
    const h = new Harness();
    h.vault.add('note.md', NOTE);
    h.touches.set('note.md', h.time);
    let editor: FakeEditor | null = null;
    h.onSleep = () => {
      editor ??= h.open('note.md');
    };

    assert.equal(await h.target.edit('note.md', addDate), 'editor');
    assert.ok(editor);
    assert.equal((editor as FakeEditor).getValue(), addDate(NOTE));
    assert.deepEqual(h.vault.writes, []);
  });

  it('does not write when typing starts while the file is being read, and tries again', async () => {
    const h = new Harness();
    h.vault.add('note.md', NOTE);
    h.vault.duringRead = () => {
      h.vault.duringRead = null;
      h.touches.set('note.md', h.time);
    };

    assert.equal(await h.target.edit('note.md', addDate), 'vault');
    assert.deepEqual(h.vault.writes, ['note.md'], 'exactly one write, after the cooldown');
    assert.ok(h.sleeps.length > 0);
  });

  it('answers missing when there is no such file', async () => {
    const h = new Harness();
    assert.equal(await h.target.edit('note.md', addDate), 'missing');
  });
});

describe('insertDailyLink', () => {
  const opts: SectionOptions = { softMarker: /^(1:1|Ad ?Hoc|Prep|Steering|Rencontre)\b/i, linkPrefix: 'Mtg-' };
  const basename = 'Mtg-2026-10-09 — 1-1 Jane Example';
  const line = `↳ [[${basename}|Meeting notes]]`;
  const args = {
    section: { title: '1:1 Jane Example', ordinal: 0 },
    companionBasename: basename,
    line,
    placement: 'section-end' as const,
  };
  const daily = [
    '### 🗄️Work',
    '',
    '### 1:1 [[Jane Example]]',
    'budget ok for q4',
    'hiring freeze until january',
    '',
    '### Steering',
    'not started',
    '',
  ].join('\n');

  it('adds exactly one line at the end of the section, through the editor', async () => {
    const h = new Harness();
    h.vault.add('2026-10-09.md', daily);
    const editor = h.open('2026-10-09.md');

    const result = await insertDailyLink(h.target, '2026-10-09.md', args, opts);

    assert.deepEqual(result, { status: 'inserted', via: 'editor' });
    const before = daily.split('\n');
    const after = editor.getValue().split('\n');
    assert.equal(after.length, before.length + 1);
    assert.equal(after[5], line);
    after.splice(5, 1);
    assert.deepEqual(after, before, 'nothing else in the daily changed');
    assert.equal(editor.replaceCalls[0].origin, EDIT_ORIGIN);
  });

  it('adds the line through the Vault when the daily is not open', async () => {
    const h = new Harness();
    h.vault.add('2026-10-09.md', daily);
    const result = await insertDailyLink(h.target, '2026-10-09.md', args, opts);
    assert.deepEqual(result, { status: 'inserted', via: 'vault' });
    assert.equal(h.vault.text('2026-10-09.md').split('\n')[5], line);
  });

  it('is idempotent: a second call finds the link and changes nothing', async () => {
    const h = new Harness();
    h.vault.add('2026-10-09.md', daily);
    const editor = h.open('2026-10-09.md');
    await insertDailyLink(h.target, '2026-10-09.md', args, opts);
    const once = editor.getValue();

    assert.deepEqual(await insertDailyLink(h.target, '2026-10-09.md', args, opts), { status: 'exists' });
    assert.equal(editor.getValue(), once);
  });

  it('puts a blank line first when the section ends with a list item', async () => {
    const h = new Harness();
    h.vault.add('2026-10-09.md', '### 1:1 [[Jane Example]]\n- budget ok\n- hiring freeze\n\n### Steering\n');
    await insertDailyLink(h.target, '2026-10-09.md', args, opts);
    assert.equal(
      h.vault.text('2026-10-09.md'),
      `### 1:1 [[Jane Example]]\n- budget ok\n- hiring freeze\n\n${line}\n\n### Steering\n`,
    );
  });

  it('goes directly under the heading with that placement', async () => {
    const h = new Harness();
    h.vault.add('2026-10-09.md', daily);
    await insertDailyLink(h.target, '2026-10-09.md', { ...args, placement: 'heading' }, opts);
    assert.equal(h.vault.text('2026-10-09.md').split('\n')[3], line);
  });

  it('resolves the section from the text at write time', async () => {
    const h = new Harness();
    h.vault.add('2026-10-09.md', daily);
    const editor = h.open('2026-10-09.md');
    // Typed since the sidebar last looked: two more lines above and inside the section.
    editor.replaceRange('morning notes\n', { line: 1, ch: 0 });
    editor.replaceRange('\none more thing', { line: 5, ch: 'hiring freeze until january'.length });

    await insertDailyLink(h.target, '2026-10-09.md', args, opts);

    const lines = editor.getValue().split('\n');
    assert.equal(lines[6], 'one more thing');
    assert.equal(lines[7], line);
  });

  it('answers no-section when the daily has no such section', async () => {
    const h = new Harness();
    h.vault.add('2026-10-09.md', '### Something else\ntext\n');
    assert.deepEqual(await insertDailyLink(h.target, '2026-10-09.md', args, opts), { status: 'no-section' });
    assert.deepEqual(h.vault.writes, []);
  });

  it('answers no-daily when the daily does not exist', async () => {
    const h = new Harness();
    assert.deepEqual(await insertDailyLink(h.target, '2026-10-09.md', args, opts), { status: 'no-daily' });
  });

  it('does not take the link of a nested section for its own', async () => {
    const h = new Harness();
    const other = 'Mtg-2026-10-09 — Budget';
    const nested = [
      '## 1:1 [[Jane Example]]',
      'intro',
      '### Budget',
      `↳ [[${other}|Meeting notes]]`,
      '',
    ].join('\n');
    h.vault.add('2026-10-09.md', nested);

    const section = findSection(nested, args.section, opts, basename);
    assert.ok(section);
    assert.notEqual(section.linkLine, null, 'the parser sees the child link line inside the body');
    assert.equal(sectionLinksTo(nested, section, basename, 'Mtg-'), false);
    assert.equal(sectionLinksTo(nested, section, other, 'Mtg-'), true);

    const result = await insertDailyLink(h.target, '2026-10-09.md', args, opts);
    assert.equal(result.status, 'inserted');
    assert.ok(h.vault.text('2026-10-09.md').includes(line));
  });

  it('recognises its link by target: an alias, a folder or a .md suffix do not matter', () => {
    const body = (link: string): string => `### 1:1 [[Jane Example]]\nnotes\n${link}\n`;
    const linked = (link: string): boolean => {
      const text = body(link);
      const section = findSection(text, args.section, opts);
      assert.ok(section);
      return sectionLinksTo(text, section, basename, 'Mtg-');
    };
    assert.equal(linked(`↳ [[${basename}]]`), true);
    assert.equal(linked(`↳ [[${basename}|Notes de réunion]]`), true);
    assert.equal(linked(`  ↳ [[${basename}.md|Meeting notes]]`), true);
    assert.equal(linked(`↳ [[${basename} (2)|Meeting notes]]`), false);
    assert.equal(linked(`see [[${basename}]]`), false, 'a mention in a sentence is not the link line');
  });

  it('reports a daily that stayed busy as not reachable, and writes nothing', async () => {
    const h = new Harness();
    h.vault.add('2026-10-09.md', daily);
    h.touches.set('2026-10-09.md', h.time);
    h.onSleep = () => h.touches.set('2026-10-09.md', h.time);
    assert.deepEqual(await insertDailyLink(h.target, '2026-10-09.md', args, opts), { status: 'no-daily' });
    assert.equal(h.vault.text('2026-10-09.md'), daily);
  });
});

describe('setFrontmatterValue', () => {
  it('replaces the value of a top-level key and nothing else', () => {
    const before = companionText();
    const after = setFrontmatterValue(before, 'updated', '2026-10-12');
    assert.equal(after, before.replace('updated: 2026-10-09', 'updated: 2026-10-12'));
    assert.ok(after.includes('created: 2026-10-09'), 'the other dates stay');
  });

  it('returns the same text when the value is already there', () => {
    const text = companionText();
    assert.equal(setFrontmatterValue(text, 'updated', DATE), text);
  });

  it('keeps Windows line endings and a byte order mark', () => {
    const text = '﻿---\r\ntype: meeting\r\nupdated: 2026-10-09\r\n---\r\nbody\r\n';
    assert.equal(
      setFrontmatterValue(text, 'updated', '2026-10-12'),
      '﻿---\r\ntype: meeting\r\nupdated: 2026-10-12\r\n---\r\nbody\r\n',
    );
  });

  it('rewrites a quoted value', () => {
    assert.equal(
      setFrontmatterValue('---\nupdated: "2026-10-09"\n---\n', 'updated', '2026-10-12'),
      '---\nupdated: 2026-10-12\n---\n',
    );
  });

  it('adds nothing when the key is missing', () => {
    const text = '---\ntype: meeting\n---\nupdated: in the body\n';
    assert.equal(setFrontmatterValue(text, 'updated', '2026-10-12'), text);
  });

  it('leaves a note without frontmatter alone, even when a line looks like the key', () => {
    const plain = 'updated: 2026-10-09\ntext\n';
    assert.equal(setFrontmatterValue(plain, 'updated', '2026-10-12'), plain);
    const rule = '---\nupdated: 2026-10-09\nnever closed\n';
    assert.equal(setFrontmatterValue(rule, 'updated', '2026-10-12'), rule);
    assert.equal(setFrontmatterValue('', 'updated', '2026-10-12'), '');
  });

  it('does not touch a nested key, a longer key or a value that spans lines', () => {
    const nested = '---\nmeta:\n  updated: 2026-10-09\nupdated_by: someone\n---\n';
    assert.equal(setFrontmatterValue(nested, 'updated', '2026-10-12'), nested);
    const list = '---\nupdated:\n  - 2026-10-09\n---\n';
    assert.equal(setFrontmatterValue(list, 'updated', '2026-10-12'), list);
    const folded = '---\nupdated: >\n  2026-10-09\n---\n';
    assert.equal(setFrontmatterValue(folded, 'updated', '2026-10-12'), folded);
  });
});

describe('dayOf and companionKeyOf', () => {
  it('reads the day from the forms YAML can produce', () => {
    assert.equal(dayOf('2026-10-09'), '2026-10-09');
    assert.equal(dayOf('2026-10-09T14:30:00'), '2026-10-09');
    assert.equal(dayOf(new Date(Date.UTC(2026, 9, 9))), '2026-10-09');
    assert.equal(dayOf(20261009), '20261009');
    assert.equal(dayOf(null), null);
    assert.equal(dayOf(undefined), null);
    assert.equal(dayOf(''), null);
    assert.equal(dayOf(new Date(Number.NaN)), null);
    assert.equal(dayOf({ date: '2026-10-09' }), null);
  });

  it('needs both a date and a source', () => {
    assert.deepEqual(companionKeyOf({ date: '2026-10-09', hamster_source: 'Steering#1' }), {
      date: '2026-10-09',
      source: 'Steering#1',
    });
    assert.equal(companionKeyOf({ date: '2026-10-09' }), null);
    assert.equal(companionKeyOf({ hamster_source: 'Steering#1' }), null);
    assert.equal(companionKeyOf({ date: '2026-10-09', hamster_source: 3 }), null);
    assert.equal(companionKeyOf(null), null);
    assert.equal(companionKeyOf(undefined), null);
  });
});

describe('CompanionStore', () => {
  const key = { date: DATE, source: KEY_SOURCE };
  /** The same identity as the metadata cache reports it. */
  const frontmatter = { date: DATE, hamster_source: KEY_SOURCE };

  it('creates the note in one write, with its folders', async () => {
    const h = new Harness();
    await h.companions.create('Work/Meetings/Mtg-a.md', companionText(), key);

    assert.deepEqual(h.vault.createdFolders, ['Work', 'Work/Meetings']);
    assert.deepEqual(h.vault.created, ['Work/Meetings/Mtg-a.md']);
    assert.deepEqual(h.vault.writes, [], 'no second write after the creation');
    assert.equal(h.vault.text('Work/Meetings/Mtg-a.md'), companionText());
  });

  it('does not create a folder that exists', async () => {
    const h = new Harness();
    h.vault.folders.set('00 Inbox', new FakeFolder('00 Inbox'));
    await h.companions.create(COMPANION_PATH, companionText(), key);
    assert.deepEqual(h.vault.createdFolders, []);
    assert.equal(h.companions.exists(COMPANION_PATH), true);
  });

  it('creates at the vault root', async () => {
    const h = new Harness();
    await h.companions.create('Mtg-a.md', companionText(), key);
    assert.deepEqual(h.vault.created, ['Mtg-a.md']);
  });

  it('rejects when the path is taken, and when a file sits where a folder should be', async () => {
    const h = new Harness();
    h.vault.add('Mtg-a.md', 'someone else');
    await assert.rejects(h.companions.create('Mtg-a.md', companionText(), key), /already exists/);
    assert.equal(h.vault.text('Mtg-a.md'), 'someone else');

    h.vault.add('Work', 'a file without extension');
    await assert.rejects(h.companions.create('Work/Mtg-b.md', companionText(), key), /not a folder/);
  });

  it('finds a new companion at once, before the metadata cache has read it', async () => {
    const h = new Harness();
    assert.equal(h.companions.find(DATE, KEY_SOURCE), null);
    await h.companions.create(COMPANION_PATH.replace('00 Inbox/', ''), companionText(), key);
    assert.equal(h.companions.find(DATE, KEY_SOURCE), 'Mtg-2026-10-09 — 1-1 Jane Example.md');
    assert.equal(h.companions.find(DATE, 'Steering#0'), null);
    assert.equal(h.companions.find('2026-10-10', KEY_SOURCE), null);
  });

  it('finds companions anywhere in the vault through their frontmatter', () => {
    const h = new Harness();
    h.vault.add('30 Archive/2026/Mtg-old.md', '');
    h.frontmatter.set('30 Archive/2026/Mtg-old.md', { date: '2026-09-01', hamster_source: 'Steering#0' });
    h.vault.add('00 Inbox/Mtg-today.md', '');
    h.frontmatter.set('00 Inbox/Mtg-today.md', { date: new Date(Date.UTC(2026, 9, 9)), hamster_source: KEY_SOURCE });
    // Same keys, but not a companion by name.
    h.vault.add('00 Inbox/Copy of meeting.md', '');
    h.frontmatter.set('00 Inbox/Copy of meeting.md', { date: '2026-09-01', hamster_source: 'Steering#0' });
    // A companion by name with no frontmatter yet.
    h.vault.add('00 Inbox/Mtg-bare.md', '');

    assert.equal(h.companions.find('2026-09-01', 'Steering#0'), '30 Archive/2026/Mtg-old.md');
    assert.equal(h.companions.find(DATE, KEY_SOURCE), '00 Inbox/Mtg-today.md');
    assert.equal(h.companions.find(DATE, 'Steering#0'), null);
  });

  it('prefers the older of two notes that claim the same meeting', () => {
    const h = new Harness();
    h.vault.add('Mtg-z original.md', '');
    h.vault.add('Mtg-a copy.md', '');
    h.frontmatter.set('Mtg-z original.md', frontmatter);
    h.frontmatter.set('Mtg-a copy.md', frontmatter);
    assert.equal(h.companions.find(DATE, KEY_SOURCE), 'Mtg-z original.md');
  });

  it('forgets a deleted companion', async () => {
    const h = new Harness();
    await h.companions.create('Mtg-a.md', companionText(), key);
    h.vault.files.delete('Mtg-a.md');
    h.companions.forget('Mtg-a.md');
    assert.equal(h.companions.find(DATE, KEY_SOURCE), null);
  });

  it('does not answer with a file that is gone, even when nobody said so', async () => {
    const h = new Harness();
    await h.companions.create('Mtg-a.md', companionText(), key);
    h.vault.files.delete('Mtg-a.md');
    assert.equal(h.companions.find(DATE, KEY_SOURCE), null);
  });

  it('follows a companion that is moved', async () => {
    const h = new Harness();
    await h.companions.create('Mtg-a.md', companionText(), key);
    const entry = h.vault.files.get('Mtg-a.md');
    assert.ok(entry);
    h.vault.files.delete('Mtg-a.md');
    entry.file.path = '30 Archive/Mtg-a.md';
    h.vault.files.set('30 Archive/Mtg-a.md', entry);
    h.companions.renamed('Mtg-a.md', '30 Archive/Mtg-a.md');
    assert.equal(h.companions.find(DATE, KEY_SOURCE), '30 Archive/Mtg-a.md');
  });

  it('sees a companion that appears later, once told that metadata changed', () => {
    const h = new Harness();
    assert.equal(h.companions.find(DATE, KEY_SOURCE), null);
    h.vault.add('Mtg-synced.md', '');
    h.frontmatter.set('Mtg-synced.md', frontmatter);
    h.companions.refresh('Mtg-synced.md');
    assert.equal(h.companions.find(DATE, KEY_SOURCE), 'Mtg-synced.md');
  });

  it('drops a companion whose frontmatter no longer names the meeting', async () => {
    const h = new Harness();
    await h.companions.create('Mtg-a.md', companionText(), key);
    // The cache has not read the new file yet: that says nothing.
    h.companions.refresh('Mtg-a.md');
    assert.equal(h.companions.find(DATE, KEY_SOURCE), 'Mtg-a.md');

    h.frontmatter.set('Mtg-a.md', { date: DATE, hamster_source: 'Steering#0' });
    h.companions.refresh('Mtg-a.md');
    assert.equal(h.companions.find(DATE, KEY_SOURCE), null);
    assert.equal(h.companions.find(DATE, 'Steering#0'), 'Mtg-a.md');

    h.frontmatter.set('Mtg-a.md', { type: 'note' });
    h.companions.refresh('Mtg-a.md');
    assert.equal(h.companions.find(DATE, 'Steering#0'), null);
  });

  it('keeps its index through a save that leaves the companion\'s keys as they were', async () => {
    const h = new Harness();
    const files = h.vault.getMarkdownFiles.bind(h.vault);
    let walks = 0;
    h.vault.getMarkdownFiles = () => {
      walks += 1;
      return files();
    };
    await h.companions.create('Mtg-a.md', companionText(), key);
    h.frontmatter.set('Mtg-a.md', frontmatter);
    // A meeting it does not know: the one answer that needs the vault walked.
    assert.equal(h.companions.find(DATE, 'Other#0'), null);
    assert.equal(walks, 1);

    // The companion was written to, as it is every few seconds during a meeting: its keys did not move.
    h.companions.refresh('Mtg-a.md');
    assert.equal(h.companions.find(DATE, 'Other#0'), null);
    assert.equal(walks, 1, 'no new walk');
    assert.equal(h.companions.find(DATE, KEY_SOURCE), 'Mtg-a.md');

    // Its keys were changed by hand: the index is built again, and the new key answers.
    h.frontmatter.set('Mtg-a.md', { date: DATE, hamster_source: 'Steering#0' });
    h.companions.refresh('Mtg-a.md');
    assert.equal(h.companions.find(DATE, KEY_SOURCE), null);
    assert.equal(walks, 2);
    assert.equal(h.companions.find(DATE, 'Steering#0'), 'Mtg-a.md');
  });

  it('follows a change of the companion prefix', () => {
    const h = new Harness();
    h.vault.add('Meeting-a.md', '');
    h.frontmatter.set('Meeting-a.md', frontmatter);
    assert.equal(h.companions.find(DATE, KEY_SOURCE), null);
    h.settings = { ...h.settings, companionPrefix: 'Meeting-' };
    assert.equal(h.companions.find(DATE, KEY_SOURCE), 'Meeting-a.md');
  });

  it('exists is true for files and folders, false otherwise', () => {
    const h = new Harness();
    h.vault.add('a.md', '');
    h.vault.folders.set('Work', new FakeFolder('Work'));
    assert.equal(h.companions.exists('a.md'), true);
    assert.equal(h.companions.exists('Work'), true);
    assert.equal(h.companions.exists('b.md'), false);
  });

  it('reads through the editor when the companion is open', async () => {
    const h = new Harness();
    h.vault.add('Mtg-a.md', 'on disk');
    const editor = h.open('Mtg-a.md');
    editor.replaceRange('typed ', { line: 0, ch: 0 });
    assert.equal(await h.companions.read('Mtg-a.md'), 'typed on disk');
    assert.equal(await h.companions.read('nope.md'), null);
  });

  it('touch sets updated through the Vault', async () => {
    const h = new Harness();
    h.vault.add('Mtg-a.md', companionText());
    await h.companions.touch('Mtg-a.md', '2026-10-12');
    assert.equal(h.vault.text('Mtg-a.md'), companionText().replace('updated: 2026-10-09', 'updated: 2026-10-12'));
  });

  it('touch skips a note that is open in an editor', async () => {
    const h = new Harness();
    h.vault.add('Mtg-a.md', companionText());
    const editor = h.open('Mtg-a.md');
    await h.companions.touch('Mtg-a.md', '2026-10-12');
    assert.equal(editor.transactions.length, 0);
    assert.deepEqual(h.vault.writes, []);
    assert.deepEqual(h.sleeps, [], 'and does not wait for it');
  });

  it('touch waits once for a note that was just edited, then writes', async () => {
    const h = new Harness();
    h.vault.add('Mtg-a.md', companionText());
    h.touches.set('Mtg-a.md', h.time - 100);
    await h.companions.touch('Mtg-a.md', '2026-10-12');
    assert.deepEqual(h.sleeps, [3000]);
    assert.deepEqual(h.vault.writes, ['Mtg-a.md']);
  });

  it('touch gives up quietly when the note is still busy after the retry', async () => {
    const h = new Harness();
    h.vault.add('Mtg-a.md', companionText());
    h.touches.set('Mtg-a.md', h.time);
    h.onSleep = () => h.touches.set('Mtg-a.md', h.time);
    await h.companions.touch('Mtg-a.md', '2026-10-12');
    assert.deepEqual(h.sleeps, [3000]);
    assert.deepEqual(h.vault.writes, []);
  });

  it('touch ignores a missing note and a date that is not one', async () => {
    const h = new Harness();
    await h.companions.touch('nope.md', '2026-10-12');
    h.vault.add('Mtg-a.md', companionText());
    await h.companions.touch('Mtg-a.md', 'today');
    assert.deepEqual(h.vault.writes, []);
  });
});

describe('CompanionStore.findByBasename', () => {
  const key = { date: DATE, source: KEY_SOURCE };
  const DAILY = 'Daily/2026-10-09.md';
  const BASENAME = 'Mtg-2026-10-09 — 1-1 Jane Example';

  it('finds a companion made in this session before the metadata cache can resolve a link to it', async () => {
    const h = new Harness();
    await h.companions.create(COMPANION_PATH, companionText(), key);
    h.unindexed.add(COMPANION_PATH);

    assert.equal(h.companions.findByBasename(BASENAME, DAILY), COMPANION_PATH);
    assert.deepEqual(h.resolutions, [], 'answered without the metadata cache');
  });

  it('finds it whatever its frontmatter key says: the heading may have been renamed since', async () => {
    const h = new Harness();
    await h.companions.create(COMPANION_PATH, companionText(), key);
    h.unindexed.add(COMPANION_PATH);

    assert.equal(h.companions.find(DATE, '1:1 Jane Example (budget)#0'), null, 'the renamed section has no companion by key');
    assert.equal(h.companions.findByBasename(BASENAME, DAILY), COMPANION_PATH);
  });

  it('finds a companion it found earlier by its frontmatter, again without the metadata cache', () => {
    const h = new Harness();
    h.vault.add('30 Archive/Mtg-filed.md', '');
    h.frontmatter.set('30 Archive/Mtg-filed.md', { date: DATE, hamster_source: KEY_SOURCE });
    assert.equal(h.companions.find(DATE, KEY_SOURCE), '30 Archive/Mtg-filed.md');

    assert.equal(h.companions.findByBasename('Mtg-filed', DAILY), '30 Archive/Mtg-filed.md');
    assert.deepEqual(h.resolutions, []);
  });

  it('resolves a companion of an earlier session as Obsidian resolves the link, from the note that holds it', () => {
    const h = new Harness();
    h.vault.add('30 Archive/2026/Mtg-old.md', '');

    assert.equal(h.companions.findByBasename('Mtg-old', DAILY), '30 Archive/2026/Mtg-old.md');
    assert.deepEqual(h.resolutions, [{ linkpath: 'Mtg-old', from: DAILY }]);
  });

  it('needs no frontmatter and no prefix: the link line is what makes the note the companion', () => {
    const h = new Harness();
    h.vault.add('Notes/Steering renamed by hand.md', 'no frontmatter');
    assert.equal(h.companions.findByBasename('Steering renamed by hand', DAILY), 'Notes/Steering renamed by hand.md');
  });

  it('answers null for a link that leads nowhere', () => {
    const h = new Harness();
    h.vault.add('Mtg-a.md', '');
    assert.equal(h.companions.findByBasename('Mtg-b', DAILY), null);
  });

  it('answers null for a link to something that is not a note', () => {
    const h = new Harness();
    h.vault.add('files/Mtg-whiteboard.png', '');
    h.vault.add('files/Mtg-minutes.pdf', '');
    assert.equal(h.companions.findByBasename('Mtg-whiteboard.png', DAILY), null);
    assert.equal(h.companions.findByBasename('Mtg-minutes.pdf', DAILY), null);
    assert.equal(h.resolutions.length, 2, 'both were resolved, and refused for what they are');
  });

  it('answers null for an empty name without asking: to Obsidian an empty link is the daily itself', () => {
    const h = new Harness();
    h.vault.add(DAILY, '### 1:1 Jane Example\n');
    assert.equal(h.companions.findByBasename('', DAILY), null);
    assert.equal(h.companions.findByBasename('   ', DAILY), null);
    assert.equal(h.companions.findByBasename('.md', DAILY), null);
    assert.deepEqual(h.resolutions, []);
  });

  it('never answers with the note the link is in', () => {
    const h = new Harness();
    h.vault.add('Mtg-log.md', 'a daily that links to itself');
    assert.equal(h.companions.findByBasename('Mtg-log', 'Mtg-log.md'), null);
    assert.equal(h.companions.findByBasename('Mtg-log', DAILY), 'Mtg-log.md', 'from another note it is a note like any other');
  });

  it('takes the name with or without .md', async () => {
    const h = new Harness();
    await h.companions.create('Mtg-a.md', companionText(), key);
    h.unindexed.add('Mtg-a.md');
    h.vault.add('30 Archive/Mtg-old.md', '');

    assert.equal(h.companions.findByBasename('Mtg-a.md', DAILY), 'Mtg-a.md');
    assert.equal(h.companions.findByBasename(' Mtg-a ', DAILY), 'Mtg-a.md');
    assert.equal(h.companions.findByBasename('Mtg-old.md', DAILY), '30 Archive/Mtg-old.md');
  });

  it('finds a new companion whose name the link spells with separate accents', async () => {
    const h = new Harness();
    const composed = 'Mtg-2026-10-09 — Comité de sécurité';
    await h.companions.create(`${composed}.md`, companionText(), key);
    h.unindexed.add(`${composed}.md`);

    const decomposed = composed.normalize('NFD');
    assert.notEqual(decomposed, composed);
    assert.equal(h.companions.findByBasename(decomposed, DAILY), `${composed}.md`);
  });

  it('matches the whole name, not its beginning', async () => {
    const h = new Harness();
    await h.companions.create('Mtg-2026-10-09 — Steering (2).md', companionText(), key);
    h.unindexed.add('Mtg-2026-10-09 — Steering (2).md');

    assert.equal(h.companions.findByBasename('Mtg-2026-10-09 — Steering', DAILY), null);
    assert.equal(
      h.companions.findByBasename('Mtg-2026-10-09 — Steering (2)', DAILY),
      'Mtg-2026-10-09 — Steering (2).md',
    );
  });

  it('leaves a name that carries a folder to Obsidian', async () => {
    const h = new Harness();
    await h.companions.create('Mtg-a.md', companionText(), key);
    h.vault.add('30 Archive/Mtg-a.md', '');

    assert.equal(h.companions.findByBasename('30 Archive/Mtg-a', DAILY), '30 Archive/Mtg-a.md');
    assert.equal(h.companions.findByBasename('Elsewhere/Mtg-a', DAILY), null);
  });

  it('does not answer with a companion that is gone, told or not', async () => {
    const h = new Harness();
    await h.companions.create('Mtg-a.md', companionText(), key);
    h.vault.files.delete('Mtg-a.md');
    assert.equal(h.companions.findByBasename('Mtg-a', DAILY), null, 'nobody said it was deleted');

    await h.companions.create('Mtg-b.md', companionText(), key);
    h.vault.files.delete('Mtg-b.md');
    h.companions.forget('Mtg-b.md');
    assert.equal(h.companions.findByBasename('Mtg-b', DAILY), null);
  });

  it('follows a companion that is moved or renamed', async () => {
    const h = new Harness();
    await h.companions.create('Mtg-a.md', companionText(), key);
    const entry = h.vault.files.get('Mtg-a.md');
    assert.ok(entry);
    h.vault.files.delete('Mtg-a.md');
    entry.file.path = '30 Archive/Mtg-a final.md';
    h.vault.files.set(entry.file.path, entry);
    h.unindexed.add(entry.file.path);
    h.companions.renamed('Mtg-a.md', entry.file.path);

    // Obsidian rewrites the link in the daily when a note is renamed.
    assert.equal(h.companions.findByBasename('Mtg-a final', DAILY), '30 Archive/Mtg-a final.md');
    assert.equal(h.companions.findByBasename('Mtg-a', DAILY), null);
  });

  it('forgets a note of this session whose frontmatter stopped naming a meeting, and lets Obsidian answer', async () => {
    const h = new Harness();
    await h.companions.create('Mtg-a.md', companionText(), key);
    h.frontmatter.set('Mtg-a.md', { type: 'note' });
    h.companions.refresh('Mtg-a.md');

    assert.equal(h.companions.findByBasename('Mtg-a', DAILY), 'Mtg-a.md');
    assert.deepEqual(h.resolutions, [{ linkpath: 'Mtg-a', from: DAILY }], 'the link still leads to it');
  });
});

/** True when no half of a surrogate pair stands alone in `text`. */
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

describe('review: carriage returns in generated text', () => {
  const crlf: Patch = { region: 'enhanced', content: 'line one\r\nline two\r\nline three' };

  for (const cm of [true, false]) {
    it(`writes text that carries Windows line breaks once, and then leaves it alone (${cm ? 'CodeMirror' : 'replaceRange'})`, async () => {
      const h = new Harness();
      h.vault.add(COMPANION_PATH, companionText());
      const editor = h.open(COMPANION_PATH, { cm });

      await h.target.writeRegions(COMPANION_PATH, [crlf]);
      assert.equal(readRegion(editor.getValue(), 'enhanced'), 'line one\nline two\nline three\n');
      const first = editor.transactions.length;

      // The same content again, as the write queue sends it after every Enhance run.
      for (let i = 0; i < 3; i++) await h.target.writeRegions(COMPANION_PATH, [crlf]);

      assert.equal(readRegion(editor.getValue(), 'enhanced'), 'line one\nline two\nline three\n');
      assert.equal(editor.transactions.length, first, 'nothing changes, so nothing is dispatched');
    });
  }

  it('does not take a lone carriage return for something to keep', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    const editor = h.open(COMPANION_PATH);
    const patch: Patch = { region: 'summary', content: 'one\rtwo' };
    await h.target.writeRegions(COMPANION_PATH, [patch]);
    await h.target.writeRegions(COMPANION_PATH, [patch]);
    assert.equal(readRegion(editor.getValue(), 'summary'), 'one\ntwo\n');
    assert.equal(editor.transactions.length, 1);
  });
});

describe('review: diffSpan on text with surrogate pairs', () => {
  const HIGH = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
  const LOW = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
  /** True when `at` falls between the two halves of a pair in `text`. */
  const splits = (text: string, at: number): boolean =>
    at > 0 && at < text.length && HIGH(text.charCodeAt(at - 1)) && LOW(text.charCodeAt(at));

  // Pairs that share a first half, pairs that share a second half, and plain text around them.
  const ALPHABET = ['a', 'b', '\n', '😀', '😁', '🤔', '\u{1FA00}', '\u{1F900}', 'é'];

  function randomText(random: () => number, max: number): string {
    let out = '';
    const length = Math.floor(random() * max);
    for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
    return out;
  }

  function generator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  it('never puts either end of the span, or of what it inserts, inside a pair', () => {
    const random = generator(4242);
    let checked = 0;
    for (let i = 0; i < 20_000; i++) {
      const before = randomText(random, 7);
      const after = randomText(random, 7);
      const span = diffSpan(before, after);
      if (before === after) {
        assert.equal(span, null);
        continue;
      }
      assert.ok(span);
      checked += 1;
      const context = `${JSON.stringify(before)} -> ${JSON.stringify(after)}`;
      assert.equal(apply(before, span), after, context);
      assert.ok(span.from >= 0 && span.from <= span.to && span.to <= before.length, context);
      assert.equal(splits(before, span.from), false, `start inside a pair: ${context}`);
      assert.equal(splits(before, span.to), false, `end inside a pair: ${context}`);
      assert.equal(wellFormed(span.insert), true, `half a pair inserted: ${context}`);
      assert.equal(wellFormed(before.slice(span.from, span.to)), true, `half a pair removed: ${context}`);
    }
    assert.ok(checked > 15_000);
  });

  it('handles the pairs that differ in one half only', () => {
    // Same first half (U+D83D), different second half.
    assert.deepEqual(diffSpan('😀', '😁'), { from: 0, to: 2, insert: '😁' });
    assert.deepEqual(diffSpan('x😀y', 'x😁y'), { from: 1, to: 3, insert: '😁' });
    // Different first half, same second half (U+DE00).
    assert.deepEqual(diffSpan('x😀y', 'x\u{1FA00}y'), { from: 1, to: 3, insert: '\u{1FA00}' });
    // One emoji repeated: the span is a whole emoji, whichever one.
    for (const [before, after] of [['😀😀', '😀'], ['😀', '😀😀'], ['😀😀😀', '😀😀']]) {
      const span = diffSpan(before, after);
      assert.ok(span);
      assert.equal(apply(before, span), after);
      assert.equal((span.to - span.from + span.insert.length) % 2, 0);
      assert.equal(span.from % 2, 0);
    }
    // An emoji inserted next to one that shares its first half.
    const span = diffSpan('a😀', 'a😁😀');
    assert.ok(span);
    assert.equal(apply('a😀', span), 'a😁😀');
    assert.equal(wellFormed(span.insert), true);
  });

  it('still turns one text into the other when a text holds half a pair', () => {
    const halves = ['\ud83d', '\ude00', 'a', '😀'];
    const random = generator(99);
    const text = (): string => {
      let out = '';
      const length = Math.floor(random() * 6);
      for (let i = 0; i < length; i++) out += halves[Math.floor(random() * halves.length)];
      return out;
    };
    for (let i = 0; i < 5000; i++) {
      const before = text();
      const after = text();
      const span = diffSpan(before, after);
      if (before === after) assert.equal(span, null);
      else {
        assert.ok(span);
        assert.ok(span.from <= span.to && span.to <= before.length);
        assert.equal(apply(before, span), after);
      }
    }
  });

  it('keeps emoji whole in what it dispatches to the editor', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    const editor = h.open(COMPANION_PATH);
    await h.target.writeRegions(COMPANION_PATH, [{ region: 'summary', content: 'Mood 😀 today' }]);
    await h.target.writeRegions(COMPANION_PATH, [{ region: 'summary', content: 'Mood 😁 today' }]);

    assert.equal(readRegion(editor.getValue(), 'summary'), 'Mood 😁 today\n');
    const tr = editor.transactions.at(-1);
    assert.ok(tr);
    const before = tr.startState.doc.toString();
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      assert.equal(before.slice(fromA, toA), '😀');
      assert.equal(inserted.toString(), '😁');
    });
  });
});

describe('review: the editor path and the Vault path agree', () => {
  const PIECES = ['alpha', 'beta', '- item', '', '😀', '😁', '**Q:** why', '> quoted', 'é', '   ', '\t'];
  /* No lone carriage return here: the merge does not read one as a line break, CodeMirror does,
     so the two paths may trim the blank end of such a text differently. */
  const BREAKS = ['\n', '\n', '\n\n', '\r\n'];

  function generator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  function randomContent(random: () => number): string {
    let out = '';
    const parts = Math.floor(random() * 5);
    for (let i = 0; i < parts; i++) {
      out += PIECES[Math.floor(random() * PIECES.length)];
      if (random() < 0.8) out += BREAKS[Math.floor(random() * BREAKS.length)];
    }
    return out;
  }

  function randomBatch(random: () => number): Patch[] {
    const regions = ['enhanced', 'summary', 'qa', 'transcript'] as const;
    const batch: Patch[] = [];
    const size = 1 + Math.floor(random() * 4);
    for (let i = 0; i < size; i++) {
      const region = regions[Math.floor(random() * regions.length)];
      batch.push(
        region === 'transcript'
          ? { region, append: randomContent(random) }
          : { region, content: randomContent(random) },
      );
    }
    return batch;
  }

  const unix = (text: string): string => text.replace(/\r\n?/g, '\n');

  it('makes the same note through an editor as through the file, batch after batch', async () => {
    const random = generator(20261011);
    for (let round = 0; round < 60; round++) {
      // The user's own text sits before, between and after the regions.
      const start = companionText()
        .replace('## AI summary', 'My own line, between two regions.\n\n## AI summary')
        .concat('\nMy last line 😀\n');
      const viaEditor = new Harness();
      viaEditor.vault.add(COMPANION_PATH, start);
      const editor = viaEditor.open(COMPANION_PATH);
      const viaVault = new Harness();
      viaVault.vault.add(COMPANION_PATH, start);

      for (let step = 0; step < 6; step++) {
        const batch = randomBatch(random);
        const context = `round ${round}, step ${step}: ${JSON.stringify(batch)}`;
        const sent = editor.transactions.length;

        const a = await viaEditor.target.writeRegions(COMPANION_PATH, batch);
        const b = await viaVault.target.writeRegions(COMPANION_PATH, batch);
        assert.deepEqual(a, b, context);
        assert.equal(editor.getValue(), unix(viaVault.vault.text(COMPANION_PATH)), context);
        assert.ok(editor.transactions.length - sent <= 1, `at most one transaction a batch: ${context}`);

        // What was dispatched keeps clear of the user's own lines and of every marker line.
        const tr = editor.transactions.length > sent ? editor.transactions.at(-1) : undefined;
        if (tr) {
          const before = tr.startState.doc.toString();
          assert.equal(tr.annotation(Transaction.addToHistory), false, context);
          assert.equal(tr.scrollIntoView, false, context);
          tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            const removed = before.slice(fromA, toA);
            assert.ok(!removed.includes('hamster:') && !removed.includes('My own'), context);
            assert.ok(!removed.includes('My last') && !removed.includes('## '), context);
            assert.equal(wellFormed(inserted.toString()) && wellFormed(removed), true, context);
          });
        }
        assert.ok(editor.getValue().includes('My own line, between two regions.\n\n## AI summary'), context);
        assert.ok(editor.getValue().endsWith('\nMy last line 😀\n'), context);

        // A region that is replaced whole: sending the same content again changes nothing.
        const replacing = batch.filter((patch) => patch.region !== 'transcript');
        if (a.status === 'ok' && replacing.length > 0) {
          const last = new Map(replacing.map((patch) => [patch.region, patch]));
          const again = editor.transactions.length;
          await viaEditor.target.writeRegions(COMPANION_PATH, [...last.values()]);
          assert.equal(editor.transactions.length, again, `not idempotent: ${context}`);
        }
      }
    }
  });
});

describe('review: insertAfterLine against a line-by-line reference', () => {
  /** Lines with their own endings kept: `['a\r\n', 'b\n', 'c']`. */
  function pieces(text: string): string[] {
    const out = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    return text === '' || text.endsWith('\n') ? [...out, ''] : out;
  }

  it('adds the lines after the right one and leaves every other character alone', () => {
    let seed = 777;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const eols = ['\n', '\r\n'];
    for (let i = 0; i < 4000; i++) {
      const eol = eols[Math.floor(random() * 2)];
      const count = Math.floor(random() * 5);
      let text = '';
      for (let line = 0; line < count; line++) text += ['', 'x', '- item', '😀'][Math.floor(random() * 4)] + eol;
      if (random() < 0.5) text += 'tail';
      const lines = pieces(text);
      const afterLine = Math.floor(random() * (lines.length + 1));
      const insert = random() < 0.5 ? 'L' : '\nL';
      const context = `${JSON.stringify(text)} after line ${afterLine}`;

      const result = insertAfterLine(text, afterLine, insert);
      if (afterLine >= lines.length) {
        assert.equal(result, null, context);
        continue;
      }
      assert.ok(result !== null, context);
      // Every original line is still there, in order, with its own ending or the file's.
      const added = insert === 'L' ? 1 : 2;
      const got = result.split(/\r?\n/);
      const want = text.split(/\r?\n/);
      want.splice(afterLine + 1, 0, ...(insert === 'L' ? ['L'] : ['', 'L']));
      assert.deepEqual(got, want, context);
      assert.equal(got.length, text.split(/\r?\n/).length + added, context);
      // No line ending of another kind than the file's own slips in.
      if (count > 0 && eol === '\r\n') assert.equal(/[^\r]\n/.test(result) || result.startsWith('\n'), false, context);
      if (eol === '\n') assert.equal(result.includes('\r'), false, context);
    }
  });
});

describe('review: saving what went into an editor (the quit hook)', () => {
  const summary: Patch = { region: 'summary', content: 'A short summary.' };
  const transcript: Patch = { region: 'transcript', append: '> **[00:01] Fred:** bonjour' };

  function viewOf(h: Harness, index = 0): FakeView {
    return h.workspace.leaves[index].view as FakeView;
  }

  it('leaves the file to the editor until asked, then saves it and waits for the text to be there', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    const editor = h.open(COMPANION_PATH);

    await h.target.writeRegions(COMPANION_PATH, [summary, transcript]);
    assert.equal(h.vault.text(COMPANION_PATH), companionText(), 'only the buffer holds it so far');

    await h.target.saveEditors();

    assert.equal(h.vault.text(COMPANION_PATH), editor.getValue());
    assert.match(readRegion(h.vault.text(COMPANION_PATH), 'transcript') ?? '', /bonjour\n$/);
    assert.deepEqual(h.saves, [COMPANION_PATH]);
    assert.deepEqual(h.vault.writes, [], 'through the view, never through the Vault under an open editor');
  });

  it('waits for the newest text when a save of that view was already running', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    const editor = h.open(COMPANION_PATH);
    // The user typed; on quit Obsidian starts saving that before the plugin's own hook runs.
    editor.replaceRange('My own remark.\n', { line: editor.lastLine(), ch: 0 });
    const obsidians = viewOf(h).save?.();
    // The session's last lines then go into the editor, behind that save.
    await h.target.writeRegions(COMPANION_PATH, [transcript]);

    await h.target.saveEditors();
    await obsidians;

    const onDisk = h.vault.text(COMPANION_PATH);
    assert.equal(onDisk, editor.getValue());
    assert.ok(onDisk.includes('My own remark.'));
    assert.match(readRegion(onDisk, 'transcript') ?? '', /bonjour\n$/, 'the last transcript lines are in the file');
    assert.ok(h.saves.length >= 2, 'the running save took the older text: a second one was needed');
  });

  it('saves the daily too after its one line went in through the editor', async () => {
    const h = new Harness();
    h.vault.add('daily.md', 'first\nsecond');
    h.open('daily.md');
    await h.target.insertLine('daily.md', () => ({ afterLine: 0, text: 'added' }));
    await h.target.saveEditors();
    assert.equal(h.vault.text('daily.md'), 'first\nadded\nsecond');
  });

  it('does nothing when nothing went through an editor', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    await h.target.writeRegions(COMPANION_PATH, [summary]);
    // Open, but written before it was: nothing of ours is pending in that buffer.
    h.open(COMPANION_PATH);
    await h.target.saveEditors();
    assert.deepEqual(h.saves, []);
    assert.deepEqual(h.sleeps, []);
  });

  it('asks each note once: a second call has nothing left to save', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    h.open(COMPANION_PATH);
    await h.target.writeRegions(COMPANION_PATH, [summary]);
    await h.target.saveEditors();
    await h.target.saveEditors();
    assert.deepEqual(h.saves, [COMPANION_PATH]);
  });

  it('leaves a note alone that was closed or put in Reading view since: Obsidian saved it on the way', async () => {
    const closed = new Harness();
    closed.vault.add(COMPANION_PATH, companionText());
    closed.open(COMPANION_PATH);
    await closed.target.writeRegions(COMPANION_PATH, [summary]);
    closed.workspace.leaves.length = 0;
    await closed.target.saveEditors();
    assert.deepEqual(closed.saves, []);

    const reading = new Harness();
    reading.vault.add(COMPANION_PATH, companionText());
    reading.open(COMPANION_PATH);
    await reading.target.writeRegions(COMPANION_PATH, [summary]);
    viewOf(reading).mode = 'preview';
    await reading.target.saveEditors();
    assert.deepEqual(reading.saves, []);
  });

  it('follows a note that was renamed after it was written to', async () => {
    const h = new Harness();
    const file = h.vault.add(COMPANION_PATH, companionText());
    const editor = h.open(COMPANION_PATH);
    await h.target.writeRegions(COMPANION_PATH, [summary]);
    const entry = h.vault.files.get(COMPANION_PATH);
    assert.ok(entry);
    h.vault.files.delete(COMPANION_PATH);
    file.path = '30 Archive/Mtg-moved.md';
    h.vault.files.set(file.path, entry);

    await h.target.saveEditors();
    assert.equal(h.vault.text('30 Archive/Mtg-moved.md'), editor.getValue());
  });

  it('never rejects: a save that fails is logged and the others still go', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    h.vault.add('daily.md', 'first');
    h.open(COMPANION_PATH);
    h.open('daily.md');
    await h.target.writeRegions(COMPANION_PATH, [summary]);
    await h.target.insertLine('daily.md', () => ({ afterLine: 0, text: 'added' }));
    // The companion's view cannot save; the daily's can.
    const working = viewOf(h, 0).save;
    viewOf(h, 0).save = () => Promise.reject(new Error('EIO'));

    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      await h.target.saveEditors();
    } finally {
      console.error = original;
      viewOf(h, 0).save = working;
    }
    assert.equal(errors.length, 1);
    assert.equal(h.vault.text('daily.md'), 'first\nadded');
    assert.equal(h.vault.text(COMPANION_PATH), companionText());
  });

  it('gives up after its cap when the text never reaches the file', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    h.open(COMPANION_PATH);
    await h.target.writeRegions(COMPANION_PATH, [summary]);
    h.saveInstead = () => undefined;
    const started = h.time;

    await h.target.saveEditors(1000);

    assert.ok(h.time - started >= 1000 && h.time - started < 1200, 'waited about a second, not for ever');
    assert.ok(h.sleeps.every((ms) => ms === 50));
    assert.equal(h.vault.text(COMPANION_PATH), companionText());
  });
});

describe('review: a note renamed between the decision and the write', () => {
  /*
   * The fake vault hands `process` the text of the note wherever it is by the time it reads, as
   * Obsidian does through the TFile. The text must then go nowhere: the caller decided about the
   * note at the old path, and the session, told of the rename, sends region patches again under
   * the new one. Landed here as well, each transcript line would be in the note twice.
   */

  /** Moves the note as Obsidian does: the same file object under a new path. */
  function rename(h: Harness, from: string, to: string): void {
    const entry = h.vault.files.get(from);
    assert.ok(entry);
    h.vault.files.delete(from);
    entry.file.path = to;
    h.vault.files.set(to, entry);
  }

  it('answers missing for region patches and writes them nowhere', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    h.vault.duringRead = () => rename(h, COMPANION_PATH, '30 Archive/Mtg-moved.md');

    const outcome = await h.target.writeRegions(COMPANION_PATH, [{ region: 'summary', content: 'A short summary.' }]);

    assert.deepEqual(outcome, { status: 'missing' });
    assert.deepEqual(h.vault.writes, []);
    assert.equal(h.vault.getFileByPath(COMPANION_PATH), null, 'nothing was created at the old path');
    assert.equal(h.vault.text('30 Archive/Mtg-moved.md'), companionText(), 'the renamed note is as it was');
  });

  it('answers missing for the link line instead of failing, and writes it nowhere', async () => {
    const h = new Harness();
    h.vault.add('daily.md', 'first\nsecond');
    h.vault.duringRead = () => rename(h, 'daily.md', 'yesterday.md');

    assert.equal(await h.target.insertLine('daily.md', () => ({ afterLine: 0, text: 'added' })), 'missing');
    assert.deepEqual(h.vault.writes, []);
    assert.equal(h.vault.getFileByPath('daily.md'), null);
    assert.equal(h.vault.text('yesterday.md'), 'first\nsecond');
  });

  it('answers missing for a frontmatter rewrite', async () => {
    const h = new Harness();
    h.vault.add('Mtg-a.md', companionText());
    h.vault.duringRead = () => rename(h, 'Mtg-a.md', 'Mtg-b.md');
    assert.equal(await h.target.rewrite('Mtg-a.md', (data) => `${data}x`), 'missing');
    assert.deepEqual(h.vault.writes, []);
    assert.equal(h.vault.getFileByPath('Mtg-a.md'), null);
    assert.equal(h.vault.text('Mtg-b.md'), companionText());
  });

  it('writes to the note under its new path when asked for it there', async () => {
    const h = new Harness();
    h.vault.add(COMPANION_PATH, companionText());
    rename(h, COMPANION_PATH, '30 Archive/Mtg-moved.md');
    const outcome = await h.target.writeRegions('30 Archive/Mtg-moved.md', [{ region: 'summary', content: 'A short summary.' }]);
    assert.deepEqual(outcome, { status: 'ok' });
    assert.deepEqual(h.vault.writes, ['30 Archive/Mtg-moved.md']);
    assert.equal(readRegion(h.vault.text('30 Archive/Mtg-moved.md'), 'summary'), 'A short summary.\n');
  });
});
