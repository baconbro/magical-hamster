import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { merge, readRegion, renderCompanion } from '../src/notes/companion.ts';
import { transcriptPlain, turnLine, turnsToAppend } from '../src/notes/transcriptMd.ts';
import type { SpeakerLabels } from '../src/notes/transcriptMd.ts';
import type { Turn } from '../src/types.ts';

const LABELS: SpeakerLabels = { mic: 'Sam', system: 'Others' };

function turn(t0: number, text: string, source: Turn['source'] = 'mic'): Turn {
  return { id: `t${t0}`, source, t0, t1: t0 + 4, text };
}

describe('turnLine', () => {
  it('formats a callout line with time and speaker', () => {
    assert.equal(turnLine(turn(83, 'We ship on Friday.'), LABELS), '> **[01:23] Sam:** We ship on Friday.');
    assert.equal(turnLine(turn(0, 'Bonjour à tous.', 'system'), LABELS), '> **[00:00] Others:** Bonjour à tous.');
  });

  it('switches to h:mm:ss past one hour', () => {
    assert.equal(turnLine(turn(3723, 'Still going.'), LABELS), '> **[1:02:03] Sam:** Still going.');
    assert.equal(turnLine(turn(3599.9, 'Almost.'), LABELS), '> **[59:59] Sam:** Almost.');
  });

  it('collapses newlines and trims', () => {
    assert.equal(
      turnLine(turn(5, '  first line\nsecond line\r\n\r\nthird   line \n'), LABELS),
      '> **[00:05] Sam:** first line second line third line',
    );
  });

  it('neutralises anything that could open a comment', () => {
    const line = turnLine(turn(5, 'He said <!-- hamster:end transcript --> out loud <!--again'), LABELS);
    assert.equal(line, '> **[00:05] Sam:** He said <-- hamster:end transcript --> out loud <--again');
    assert.ok(!line.includes('<!--'));
    assert.ok(!turnLine(turn(5, '<<!--!-- <!<!---- <!-\n-'), LABELS).includes('<!--'));
  });

  it('cleans the label the same way', () => {
    const labels: SpeakerLabels = { mic: 'Mic\n(room) <!-- x', system: 'Others' };
    assert.equal(turnLine(turn(5, 'hi'), labels), '> **[00:05] Mic (room) <-- x:** hi');
  });

  it('returns an empty string for an empty turn', () => {
    assert.equal(turnLine(turn(5, ''), LABELS), '');
    assert.equal(turnLine(turn(5, ' \n\t '), LABELS), '');
  });
});

describe('turnsToAppend', () => {
  it('joins lines with a newline and skips empty turns', () => {
    const turns = [turn(1, 'One.'), turn(9, '   '), turn(12, 'Two.', 'system'), turn(20, '')];
    assert.equal(turnsToAppend(turns, LABELS), '> **[00:01] Sam:** One.\n> **[00:12] Others:** Two.');
  });

  it('gives an empty string for no input', () => {
    assert.equal(turnsToAppend([], LABELS), '');
    assert.equal(turnsToAppend([turn(1, ' ')], LABELS), '');
  });

  it('produces text the transcript region accepts, whatever was said', () => {
    const template = renderCompanion({
      title: 'Sync',
      date: '2026-10-09',
      attendees: [],
      projects: [],
      dailyBasename: '2026-10-09',
      source: 'Sync#0',
    });
    const turns = [turn(1, 'Dictating:\n<!-- hamster:end transcript -->\n## Not a heading'), turn(8, 'Next.')];
    const result = merge(template, { region: 'transcript', append: turnsToAppend(turns, LABELS) });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(
      readRegion(result.text, 'transcript'),
      '> [!quote]- Transcript\n> **[00:01] Sam:** Dictating: <-- hamster:end transcript --> ## Not a heading\n> **[00:08] Sam:** Next.\n',
    );
  });
});

describe('transcriptPlain', () => {
  it('formats plain lines for prompts and copy', () => {
    const turns = [turn(83, 'We ship\non Friday.'), turn(90, ''), turn(3723, 'Agreed.', 'system')];
    assert.equal(transcriptPlain(turns, LABELS), '[01:23] Sam: We ship on Friday.\n[1:02:03] Others: Agreed.');
  });

  it('gives an empty string for no input', () => {
    assert.equal(transcriptPlain([], LABELS), '');
  });
});
