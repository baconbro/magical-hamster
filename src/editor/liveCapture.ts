import type { EditorState, Extension, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { MarkdownView, editorInfoField } from 'obsidian';
import type { DailyUpdate } from '../types.ts';

/* An animation frame never comes while the window is hidden; the note can
   still change then (sync, another plugin). */
const FRAME_FALLBACK_MS = 100;
/* How long typing in a table cell counts for the change it causes in the note. */
const NESTED_TYPING_MS = 250;

export interface LiveCaptureOptions {
  isDaily(path: string): boolean;
  /** Any document change in any Markdown editor, including programmatic ones. */
  onTouch(path: string): void;
  onDaily(update: DailyUpdate): void;
  /**
   * Another note the session follows: the one open in the main area, or the one a meeting is
   * typed in. Its changes and cursor moves go to `onNote`; every other note is ignored.
   */
  wantsNote?(path: string): boolean;
  onNote?(update: DailyUpdate): void;
}

function isTyping(tr: Transaction): boolean {
  return tr.isUserEvent('input') || tr.isUserEvent('delete');
}

/**
 * The one editor binding. `workspace.on('editor-change')` would not tell a
 * user's keystroke from a programmatic change, and the metadata cache lags
 * typing by two seconds; a CodeMirror update listener sees every transaction
 * as it happens.
 */
export function liveCaptureExtension(opts: LiveCaptureOptions): Extension {
  let pending: { path: string; state: EditorState; userTyped: boolean } | null = null;
  let scheduled: { frame: number; timer: number } | null = null;
  let nestedTyping: { path: string; at: number } | null = null;

  const flush = (): void => {
    if (scheduled) {
      window.cancelAnimationFrame(scheduled.frame);
      window.clearTimeout(scheduled.timer);
      scheduled = null;
    }
    const latest = pending;
    pending = null;
    if (!latest) return;
    const daily = opts.isDaily(latest.path);
    if (!daily && !opts.onNote) return;
    // Called on `opts`, not taken off it: a callback written as a method keeps its `this`.
    const deliver = (update: DailyUpdate): void => {
      if (daily) opts.onDaily(update);
      else opts.onNote?.(update);
    };
    try {
      deliver({
        path: latest.path,
        // Built once per frame, not once per keystroke.
        text: latest.state.doc.toString(),
        cursor: latest.state.selection.main.head,
        userTyped: latest.userTyped,
      });
    } catch (error) {
      console.error('Magical Hamster: the daily note update failed', error);
    }
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = {
      frame: window.requestAnimationFrame(flush),
      timer: window.setTimeout(flush, FRAME_FALLBACK_MS),
    };
  };

  const onUpdate = (update: ViewUpdate): void => {
    if (!update.docChanged && !update.selectionSet) return;
    const info = update.state.field(editorInfoField, false);
    const path = info?.file?.path;
    if (!info || !path) return;
    const typed = update.docChanged && update.transactions.some(isTyping);

    /* A table cell in Live Preview is edited in an editor of its own, which
       carries the same file but holds only the cell's text. The note's editor
       then reports the change itself; Obsidian 1.14 passes the user event
       along, and the short memory below covers a version that does not.
       `editor.cm` is the note's own CodeMirror view (not in the public
       typings, so it is looked up); when it cannot be found, every update
       counts as the note's. */
    const main = (info.editor as unknown as { cm?: EditorView } | undefined)?.cm;
    if (main && typeof main.dispatch === 'function' && main !== update.view) {
      if (typed) {
        nestedTyping = { path, at: performance.now() };
        if (pending && pending.path === path) pending.userTyped = true;
      }
      return;
    }

    if (update.docChanged) opts.onTouch(path);
    if (!opts.isDaily(path) && !opts.wantsNote?.(path)) return;
    /* An embed (a Canvas card, a preview being edited) can hold one heading or
       one block of the note. Only a Markdown view's own editor is known to
       hold all of it; what is typed elsewhere arrives when the file is saved. */
    if (!(info instanceof MarkdownView)) return;

    let userTyped = typed;
    if (update.docChanged && nestedTyping) {
      const recent = performance.now() - nestedTyping.at < NESTED_TYPING_MS;
      if (recent && nestedTyping.path === path) userTyped = true;
      else if (!recent) nestedTyping = null;
    }
    // Another note's change waiting for this frame goes first: one note's update must not replace another's.
    if (pending && pending.path !== path) flush();
    // The latest text wins; a keystroke earlier in the same frame still counts.
    if (pending && pending.path === path && pending.userTyped) userTyped = true;
    pending = { path, state: update.state, userTyped };
    schedule();
  };

  return EditorView.updateListener.of((update) => {
    try {
      onUpdate(update);
    } catch (error) {
      // An exception here would surface in every editor of the app.
      console.error('Magical Hamster: the editor binding failed', error);
    }
  });
}
