import type { Turn } from '../types.ts';
import { clock, collapseWhitespace } from '../util/text.ts';

export interface SpeakerLabels {
  mic: string;
  system: string;
}

/* Speech (or a label) must never be able to forge a region marker. Without
   its `!` the text is no longer an HTML comment; one line keeps it inside the callout. */
function oneSafeLine(text: string): string {
  return collapseWhitespace(text).replace(/<!--/g, '<--');
}

function stamp(turn: Turn, labels: SpeakerLabels): string {
  return `[${clock(turn.t0)}] ${oneSafeLine(labels[turn.source])}:`;
}

/** `> **[01:23] Fred:** text`, or an empty string for a turn with no text. */
export function turnLine(turn: Turn, labels: SpeakerLabels): string {
  const text = oneSafeLine(turn.text);
  return text === '' ? '' : `> **${stamp(turn, labels)}** ${text}`;
}

/** Callout lines for the transcript region, joined by `\n`. Empty turns are skipped. */
export function turnsToAppend(turns: Turn[], labels: SpeakerLabels): string {
  return turns
    .map((turn) => turnLine(turn, labels))
    .filter((line) => line !== '')
    .join('\n');
}

/** `[01:23] Fred: text` lines, for prompts and copy. Empty turns are skipped. */
export function transcriptPlain(turns: Turn[], labels: SpeakerLabels): string {
  const lines: string[] = [];
  for (const turn of turns) {
    const text = oneSafeLine(turn.text);
    if (text !== '') lines.push(`${stamp(turn, labels)} ${text}`);
  }
  return lines.join('\n');
}
