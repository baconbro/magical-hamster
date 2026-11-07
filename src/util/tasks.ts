/* A task typed in the notes ("- [ ] send the budget") keeps being a task in the enhanced notes.
   The model never sees the checkbox: the line goes to it as plain text, and the mark is put back
   on its bullet when the notes are written. As a real checkbox only when the user has asked for
   checkboxes (the setting "Tasks as checkboxes"): a task tool would otherwise count the task twice,
   once in the user's note and once in the companion. Otherwise as a sign task tools ignore. */

const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])[ \t]+/;
/* Any single character is a task status: the Tasks plugin uses [/], [-], [>]. */
const CHECKBOX = /^\[([^\]])\](?:[ \t]+|$)/;
/** What a written bullet may start with to mark its task: a checkbox, or one of the two signs. */
const MARK = /^(?:\[[^\]]\]|[☐☑])[ \t]+/u;

/** The status character of a task line ("- [ ] x" gives " ", "- [x] x" gives "x"), or null when the line is no task. */
export function taskStatus(line: string): string | null {
  const marker = LIST_MARKER.exec(line.trim());
  if (!marker) return null;
  return CHECKBOX.exec(line.trim().slice(marker[0].length))?.[1] ?? null;
}

/** What goes before the bullet of a task line: "[x] " as a checkbox, "☑ " or "☐ " as a sign; "" for no task. */
export function taskMark(status: string | null | undefined, asCheckbox: boolean): string {
  if (status === null || status === undefined) return '';
  if (asCheckbox) return `[${status}] `;
  return status === 'x' || status === 'X' ? '☑ ' : '☐ ';
}

/** A written bullet without the task mark it starts with. */
export function withoutTaskMark(bullet: string): string {
  return bullet.replace(MARK, '');
}

/** The task mark a written bullet starts with, as written ("[x] ", "☐ "), or "". */
export function leadingTaskMark(bullet: string): string {
  return MARK.exec(bullet)?.[0] ?? '';
}
