import type { Turn } from '../types.ts';
import { clock, collapseWhitespace } from '../util/text.ts';
import { inertMarkdown } from './safeMarkdown.ts';

export interface SpeakerLabels {
  mic: string;
  system: string;
}

/* Speech (or a label) must never be able to forge a region marker. Without
   its `!` the text is no longer an HTML comment; one line keeps it inside the callout. */
function oneSafeLine(text: string): string {
  return collapseWhitespace(text).replace(/<!--/g, '<--');
}

/* The note is rendered, so the transcript region is saved inert like every
   other region (rule 6 in DEVELOPMENT.md). Speech rarely holds a tag or an
   embed, but the recognizer writes what it hears and the label is a setting. */
function inertLine(text: string): string {
  return inertMarkdown(oneSafeLine(text));
}

function stamp(turn: Turn, label: string): string {
  return `[${clock(turn.t0)}] ${label}:`;
}

/** `> **[01:23] Fred:** text`, saved inert, or an empty string for a turn with no text. */
export function turnLine(turn: Turn, labels: SpeakerLabels): string {
  const text = inertLine(turn.text);
  return text === '' ? '' : `> **${stamp(turn, inertLine(labels[turn.source]))}** ${text}`;
}

/** Callout lines for the transcript region, joined by `\n`. Empty turns are skipped. */
export function turnsToAppend(turns: Turn[], labels: SpeakerLabels): string {
  return turns
    .map((turn) => turnLine(turn, labels))
    .filter((line) => line !== '')
    .join('\n');
}

/** `[01:23] Fred: text` lines, the words as heard, for prompts and copy. Empty turns are skipped. */
export function transcriptPlain(turns: Turn[], labels: SpeakerLabels): string {
  const lines: string[] = [];
  for (const turn of turns) {
    const text = oneSafeLine(turn.text);
    if (text !== '') lines.push(`${stamp(turn, oneSafeLine(labels[turn.source]))} ${text}`);
  }
  return lines.join('\n');
}
