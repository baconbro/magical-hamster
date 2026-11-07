import { ChangeSet, EditorState, StateField, Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { MarkdownView, editorInfoField, normalizePath } from 'obsidian';
import type { App, Editor, TFile } from 'obsidian';
import { EDIT_ORIGIN } from '../settings.ts';
import type { Patch, Region, WriteOutcome } from '../types.ts';
import { merge, mergeAll } from './companion.ts';

/* Obsidian saves an edited note 2 s after the last change and that save
   overwrites whatever the Vault API wrote in between. The margin covers a
   save that starts late. */
const DEFAULT_COOLDOWN_MS = 2500;
/* How long insertLine waits for a note to settle before it gives up. */
const INSERT_WAIT_MS = 6000;
const POLL_MS = 250;
/* An editor opened on the note while a Vault write was being prepared: the
   next attempt goes through that editor, so it can come soon. */
const EDITOR_OPENED_RETRY_MS = 250;
/* How long saveEditors waits for a note to reach its file. */
const SAVE_WAIT_MS = 2000;
const SAVE_POLL_MS = 50;

/**
 * The file an editor's text was loaded for. Obsidian points a view at the next
 * note before it has read it: until the read is done, `view.file` is the new
 * note while the buffer still holds the text of the one before. A view gets a
 * new CodeMirror state for every note it loads, so the file seen when a state
 * is created is the one its text belongs to. Null when the editor has no file.
 * The plugin registers this as an editor extension.
 */
export const bufferFileField: StateField<TFile | null> = StateField.define<TFile | null>({
  create: (state) => state.field(editorInfoField, false)?.file ?? null,
  update: (file) => file,
});

export interface LineInsertion {
  /** 0-based line after which the text goes. */
  afterLine: number;
  /** One or more lines, without a leading or trailing line break. */
  text: string;
}

/** The single replaced span that turns `before` into `after` (common prefix and suffix removed). Null when equal. */
export function diffSpan(
  before: string,
  after: string,
): { from: number; to: number; insert: string } | null {
  if (before === after) return null;
  const shortest = Math.min(before.length, after.length);

  let prefix = 0;
  while (prefix < shortest && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  // Never cut an emoji in two: the shared half goes into the replaced span.
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix -= 1;

  let suffix = 0;
  const room = shortest - prefix;
  while (
    suffix < room &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix -= 1;

  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** How long a Vault write must still wait after the last editor change; 0 when it may go now. */
export function cooldownRemaining(
  now: number,
  lastTouch: number | undefined,
  cooldownMs: number,
): number {
  if (lastTouch === undefined || !(cooldownMs > 0)) return 0;
  const left = lastTouch + cooldownMs - now;
  if (!(left > 0)) return 0;
  // A clock set back must not hold a write for longer than one cooldown.
  return Math.min(left, cooldownMs);
}

/**
 * `text` with `insert` added after 0-based line `afterLine`, in the line
 * endings the file already uses. Null when the text has no such line.
 */
export function insertAfterLine(text: string, afterLine: number, insert: string): string | null {
  if (!Number.isInteger(afterLine) || afterLine < 0) return null;
  let start = 0;
  for (let line = 0; line < afterLine; line++) {
    const newline = text.indexOf('\n', start);
    if (newline < 0) return null;
    start = newline + 1;
  }
  const newline = text.indexOf('\n', start);
  let end = newline < 0 ? text.length : newline;
  const carriage = end > start && text.charCodeAt(end - 1) === 13;
  if (carriage) end -= 1;

  let eol = '\n';
  if (carriage) {
    eol = '\r\n';
  } else if (newline < 0) {
    // The last line has no ending of its own: follow the rest of the file.
    const first = text.indexOf('\n');
    if (first > 0 && text.charCodeAt(first - 1) === 13) eol = '\r\n';
  }
  return text.slice(0, end) + eol + insert.split(/\r?\n/).join(eol) + text.slice(end);
}

function outcomeOf(detached: Region[]): WriteOutcome {
  return detached.length > 0 ? { status: 'detached', regions: detached } : { status: 'ok' };
}

/* `Editor.cm` is the CodeMirror view behind an Obsidian editor. It exists at
   run time but not in the public typings, so it is looked up, never assumed. */
function codeMirrorOf(editor: Editor): EditorView | null {
  const cm = (editor as unknown as { cm?: EditorView }).cm;
  if (!cm || typeof cm.dispatch !== 'function') return null;
  return cm.state?.doc && typeof cm.state.facet === 'function' ? cm : null;
}

function isBlank(editor: Editor): boolean {
  return editor.lineCount() === 1 && editor.getLine(0) === '';
}

/** True when the buffer is known to be the text of a note other than `file`. */
function holdsAnotherNote(editor: Editor, file: TFile): boolean {
  const loaded = codeMirrorOf(editor)?.state.field(bufferFileField, false);
  // A renamed note keeps its TFile; one that was replaced on disk keeps its path.
  return loaded != null && loaded !== file && loaded.path !== file.path;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export interface TextTargetOptions {
  /** When an editor last changed the note at `path` (any change, by anyone). */
  lastTouch(path: string): number | undefined;
  now(): number;
  cooldownMs?: number;
  /** Replaceable so the waiting in `insertLine` can be tested. Default: a `window` timer. */
  sleep?(ms: number): Promise<void>;
}

/**
 * Routes every write to a note: through the editor when the note is open in
 * source mode, through the Vault otherwise, and never through the Vault while
 * an editor's pending save could overwrite it.
 */
export class TextTarget {
  private readonly app: App;
  private readonly lastTouch: (path: string) => number | undefined;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /* Notes changed through an editor. Their text is in a buffer until Obsidian saves it. */
  private readonly unsaved = new Set<TFile>();

  constructor(app: App, opts: TextTargetOptions) {
    this.app = app;
    this.lastTouch = (path) => opts.lastTouch(path);
    this.now = () => opts.now();
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.sleep = opts.sleep ? (ms) => opts.sleep!(ms) : defaultSleep;
  }

  /** The file at `path`. Obsidian stores paths normalized, so a path built by hand is tried both ways. */
  file(path: string): TFile | null {
    const { vault } = this.app;
    return vault.getFileByPath(path) ?? vault.getFileByPath(normalizePath(path));
  }

  /** The loaded Markdown view showing `path` in source mode, if any. */
  openEditor(path: string): { view: MarkdownView; editor: Editor } | null {
    const file = this.file(path);
    return file ? this.editorOf(file) : null;
  }

  /**
   * Where the user's cursor is in the note, as an offset in its text. With the
   * note in several panes this is the pane `openEditor` picks, the one last
   * used. Null when the note is not open in source mode.
   */
  cursor(path: string): number | null {
    const open = this.openEditor(path);
    return open ? open.editor.posToOffset(open.editor.getCursor('head')) : null;
  }

  /** Current text: the editor buffer when open in source mode, else the file. Null when the file does not exist. */
  async read(path: string): Promise<string | null> {
    const file = this.file(path);
    if (!file) return null;
    const open = this.editorOf(file);
    if (open) return open.editor.getValue();
    try {
      return await this.app.vault.read(file);
    } catch (error) {
      if (!this.file(path)) return null;
      throw error;
    }
  }

  /** How long a Vault write to `path` must still wait for an editor's pending save; 0 when it may go now. */
  cooldown(path: string): number {
    const file = this.file(path);
    return cooldownRemaining(this.now(), this.lastTouch(file ? file.path : path), this.cooldownMs);
  }

  /** A pause on this target's timer, so that callers that wait can be tested with it. */
  wait(ms: number): Promise<void> {
    return this.sleep(ms);
  }

  /** Region patches for a companion. */
  async writeRegions(path: string, patches: Patch[]): Promise<WriteOutcome> {
    const file = this.file(path);
    if (!file) return { status: 'missing' };

    const open = this.editorOf(file);
    if (open) {
      this.unsaved.add(file);
      // Synchronous from reading the buffer to changing it: the buffer cannot move in between.
      return outcomeOf(patchEditor(open.editor, patches));
    }

    const wait = this.cooldown(file.path);
    if (wait > 0) return { status: 'retry', afterMs: wait };

    let outcome: WriteOutcome = { status: 'ok' };
    try {
      await this.app.vault.process(file, (data) => {
        // Reading the file took a moment: someone may have started typing in it since.
        const late = this.holdFor(file);
        if (late > 0) {
          outcome = { status: 'retry', afterMs: late };
          return data;
        }
        // Merged into what Obsidian hands over, never into text read earlier.
        const merged = mergeAll(data, patches);
        outcome = outcomeOf(merged.detached);
        return merged.text;
      });
    } catch (error) {
      if (!this.file(path)) return { status: 'missing' };
      throw error;
    }
    return outcome;
  }

  /**
   * Inserts lines into a note. `compute` receives the text current AT WRITE
   * TIME and returns where they go, or null to do nothing. `skipped` means
   * nothing was written: `compute` said so, or the note stayed busy.
   */
  async insertLine(
    path: string,
    compute: (text: string) => LineInsertion | null,
  ): Promise<'editor' | 'vault' | 'skipped' | 'missing'> {
    const deadline = this.now() + INSERT_WAIT_MS;
    for (;;) {
      const file = this.file(path);
      if (!file) return 'missing';

      const open = this.editorOf(file);
      if (open) {
        this.unsaved.add(file);
        return insertInEditor(open.editor, compute);
      }

      const wait = this.cooldown(file.path);
      if (wait <= 0) {
        const result = await this.insertInFile(file, compute);
        if (result !== 'busy') return result;
      }
      if (this.now() >= deadline) return 'skipped';
      await this.sleep(Math.min(Math.max(wait, 50), POLL_MS));
    }
  }

  /**
   * Rewrites a note through the Vault, with the text current at write time.
   * `busy` when an editor owns the note or changed it too recently.
   */
  async rewrite(path: string, fn: (data: string) => string): Promise<'done' | 'busy' | 'missing'> {
    const file = this.file(path);
    if (!file) return 'missing';
    if (this.holdFor(file) > 0) return 'busy';
    let result: 'done' | 'busy' = 'done';
    try {
      await this.app.vault.process(file, (data) => {
        if (this.holdFor(file) > 0) {
          result = 'busy';
          return data;
        }
        return fn(data);
      });
    } catch (error) {
      if (!this.file(path)) return 'missing';
      throw error;
    }
    return result;
  }

  /**
   * Saves the notes this target changed through an editor and waits until
   * their files hold that text. Obsidian saves an editor two seconds after a
   * change. When the window is closing those two seconds never come, and the
   * save Obsidian does on quit runs before a plugin gets to write its last
   * lines. Never rejects; gives up after `capMs`.
   */
  async saveEditors(capMs: number = SAVE_WAIT_MS): Promise<void> {
    const files = [...this.unsaved];
    this.unsaved.clear();
    const deadline = this.now() + capMs;
    await Promise.all(files.map((file) => this.saveEditor(file, deadline)));
  }

  private async saveEditor(file: TFile, deadline: number): Promise<void> {
    try {
      for (;;) {
        // Closed or put in Reading view since: Obsidian saved the note on the way.
        const open = this.editorOf(file);
        if (!open) return;
        await open.view.save();
        /* `save` returns at once while an earlier save of that view is still
           running, and runs again by itself afterwards. Only the file tells
           when the text has arrived. */
        if ((await this.app.vault.read(file)) === open.editor.getValue()) return;
        if (this.now() >= deadline) return;
        await this.sleep(SAVE_POLL_MS);
      }
    } catch (error) {
      console.error('Magical Hamster: could not save the note', error);
    }
  }

  private editorOf(file: TFile): { view: MarkdownView; editor: Editor } | null {
    const { workspace } = this.app;
    const recent = workspace.getMostRecentLeaf();
    let found: { view: MarkdownView; editor: Editor } | null = null;
    // Not getActiveViewOfType: it is null while the sidebar has the focus.
    for (const leaf of workspace.getLeavesOfType('markdown')) {
      // A deferred leaf has no Markdown view yet: the note is not open.
      if (leaf.isDeferred) continue;
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file?.path !== file.path) continue;
      // In Reading view the editor is a stale buffer: writing to it is a silent lost write.
      if (view.getMode() !== 'source') continue;
      /* A view that was just pointed at the note has not read it yet. Until it
         has, its buffer is the previous note's text, or empty in a new view.
         Neither is this note's text: not open yet. */
      if (holdsAnotherNote(view.editor, file)) continue;
      if (file.stat.size > 0 && isBlank(view.editor)) continue;
      const hit = { view, editor: view.editor };
      // With the note in several panes, the one last used holds the cursor that matters.
      if (leaf === recent) return hit;
      found ??= hit;
    }
    return found;
  }

  /** Why a Vault write to this file may not go ahead right now, as a delay; 0 when it may. */
  private holdFor(file: TFile): number {
    if (this.editorOf(file)) return EDITOR_OPENED_RETRY_MS;
    return cooldownRemaining(this.now(), this.lastTouch(file.path), this.cooldownMs);
  }

  private async insertInFile(
    file: TFile,
    compute: (text: string) => LineInsertion | null,
  ): Promise<'vault' | 'skipped' | 'busy' | 'missing'> {
    let result: 'vault' | 'skipped' | 'busy' = 'skipped';
    // Obsidian reads the path the file has now; a rename meanwhile changes `file.path` under us.
    const path = file.path;
    try {
      await this.app.vault.process(file, (data) => {
        if (this.holdFor(file) > 0) {
          result = 'busy';
          return data;
        }
        const at = compute(data);
        const next = at ? insertAfterLine(data, at.afterLine, at.text) : null;
        if (next === null) {
          result = 'skipped';
          return data;
        }
        result = 'vault';
        return next;
      });
    } catch (error) {
      if (!this.app.vault.getFileByPath(path)) return 'missing';
      throw error;
    }
    return result;
  }
}

/* An editor's text holds no carriage return: CodeMirror turns each one it is
   given into a line break of its own. A patch that kept them (text read from a
   file with Windows line endings) would never equal what the editor holds, and
   every write would dispatch again and push blank lines into the note. */
function lineFeedsOnly(patch: Patch): Patch {
  return patch.region === 'transcript'
    ? { region: patch.region, append: patch.append.replace(/\r\n?/g, '\n') }
    : { region: patch.region, content: patch.content.replace(/\r\n?/g, '\n') };
}

/**
 * Applies region patches to an open editor and returns the regions whose
 * markers are damaged. Each patch becomes the smallest change that makes it,
 * and all of them go in as one transaction: text between two regions is never
 * replaced, so a cursor or a selection there stays where it is.
 *
 * A region refresh is not something the user did. It must not land in the undo
 * history (Cmd-Z would remove generated text) and must not scroll the note,
 * which `Editor.replaceRange` always does: hence the dispatch on CodeMirror
 * itself, with `replaceRange` only as the fallback.
 */
function patchEditor(editor: Editor, incoming: Patch[]): Region[] {
  const detached: Region[] = [];
  const skip = (region: Region): void => {
    if (!detached.includes(region)) detached.push(region);
  };
  const patches = incoming.map(lineFeedsOnly);

  const cm = codeMirrorOf(editor);
  if (!cm) {
    for (const patch of patches) {
      const text = editor.getValue();
      const result = merge(text, patch);
      if (!result.ok) {
        skip(result.region);
        continue;
      }
      const span = result.changed ? diffSpan(text, result.text) : null;
      if (!span) continue;
      editor.replaceRange(
        span.insert,
        editor.offsetToPos(span.from),
        editor.offsetToPos(span.to),
        EDIT_ORIGIN,
      );
    }
    return detached;
  }

  const lineSeparator = cm.state.facet(EditorState.lineSeparator);
  let doc = cm.state.doc;
  let changes: ChangeSet | null = null;
  for (const patch of patches) {
    // Read back from the document: CodeMirror normalizes the line breaks of what it inserts.
    const text = doc.toString();
    const result = merge(text, patch);
    if (!result.ok) {
      skip(result.region);
      continue;
    }
    const span = result.changed ? diffSpan(text, result.text) : null;
    if (!span) continue;
    const step = ChangeSet.of(span, doc.length, lineSeparator);
    changes = changes ? changes.compose(step) : step;
    doc = step.apply(doc);
  }
  if (changes && !changes.empty) {
    cm.dispatch({
      changes,
      annotations: [Transaction.userEvent.of(EDIT_ORIGIN), Transaction.addToHistory.of(false)],
    });
  }
  return detached;
}

/* `replaceRange` on purpose: this is the one line added to the user's own
   note, so it belongs in the undo history and may scroll into view. */
function insertInEditor(
  editor: Editor,
  compute: (text: string) => LineInsertion | null,
): 'editor' | 'skipped' {
  const at = compute(editor.getValue());
  if (!at) return 'skipped';
  if (!Number.isInteger(at.afterLine) || at.afterLine < 0 || at.afterLine > editor.lastLine()) {
    return 'skipped';
  }
  editor.replaceRange(
    `\n${at.text}`,
    { line: at.afterLine, ch: editor.getLine(at.afterLine).length },
    undefined,
    EDIT_ORIGIN,
  );
  return 'editor';
}
