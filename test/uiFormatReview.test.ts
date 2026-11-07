import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageOr, pickBanners, STT_FAILED_FALLBACK, STT_NOT_INSTALLED_FALLBACK, type BannerInputs } from '../src/ui/components/banner.ts';
import { bulletMarkdown, compact, coveredByAncestor, enhancedToMarkdown, minimalFolders, mondayOf, topicText, transcriptToText, weeklySeries } from '../src/ui/components/format.ts';

const quiet: BannerInputs = { ollamaStatus: 'ok', missingModels: [], remoteHost: null, stt: 'idle', sttMessage: null, tab: 'notes', recording: 'idle', hasTurns: false, recordingError: null, detachedRegions: [], editedOutside: [], cursorOutside: false };

test('compact never prints a four-digit number of thousands', () => {
  assert.equal(compact(999_499), '999k');
  assert.equal(compact(999_500), '1M');
  assert.equal(compact(999_999), '1M');
  assert.equal(compact(1_049_999), '1M');
  assert.equal(compact(1_050_000), '1.1M');
  assert.equal(compact(9_949), '9.9k');
  assert.equal(compact(9_999), '10k');
  assert.equal(compact(0), '0');
  for (let n = 0; n < 2_000_000; n += 137) assert.ok(!/^\d{4,}k$/.test(compact(n)), `${n} -> ${compact(n)}`);
});

test('a blank message from the session falls back instead of drawing an empty banner', () => {
  assert.equal(messageOr('', 'x'), 'x');
  assert.equal(messageOr('  \n', 'x'), 'x');
  assert.equal(messageOr(null, 'x'), 'x');
  assert.equal(messageOr('Arrêté.', 'x'), 'Arrêté.');
  assert.deepEqual(pickBanners({ ...quiet, stt: 'failed', sttMessage: '' }), [{ kind: 'stt-failed', message: STT_FAILED_FALLBACK }]);
  assert.deepEqual(pickBanners({ ...quiet, stt: 'not-installed', sttMessage: ' ', recording: 'recording' }), [{ kind: 'stt-not-installed', message: STT_NOT_INSTALLED_FALLBACK }]);
  assert.deepEqual(pickBanners({ ...quiet, recordingError: '   ' }), []);
  assert.deepEqual(pickBanners({ ...quiet, recordingError: '   ', cursorOutside: true }), [{ kind: 'cursor-outside' }]);
});

test('weeks: Sunday belongs to the week before, year and leap-day boundaries hold', () => {
  assert.equal(mondayOf('2026-10-11'), '2026-10-05');
  assert.equal(mondayOf('2026-10-12'), '2026-10-12');
  assert.equal(mondayOf('2027-01-03'), '2026-12-28');
  assert.equal(mondayOf('2028-03-01'), '2028-02-28');
  const s = weeklySeries({ '2027-12-27': { input: 1, output: 2 } }, '2028-01-02');
  assert.equal(s.length, 8);
  assert.deepEqual([s[7]?.key, s[7]?.total, s[7]?.day, s[7]?.month], ['2027-12-27', 3, '27', 'Dec']);
  for (let i = 1; i < s.length; i++) assert.equal(Date.parse(s[i]!.key) - Date.parse(s[i - 1]!.key), 7 * 86_400_000);
});

test('copy text: CRLF bullets, accents and an empty transcript', () => {
  assert.equal(bulletMarkdown('**Équipe :** a\r\nb'), '- **Équipe :** a\r\n  b');
  assert.equal(topicText('#### Sujet Éé # 2'), 'Sujet Éé # 2');
  assert.equal(transcriptToText([], 'Fred'), '');
  assert.equal(transcriptToText([{ id: 't', source: 'system', t0: 3599.9, t1: 3600, text: 'Ça va ?' }], 'Fred'), '[59:59] Others: Ça va ?');
  assert.equal(enhancedToMarkdown([{ id: 'a', kind: 'item', source: 's', bullet: '   ', stale: false, streaming: true, excerptIds: [] }]), '');
});

test('folders: a name that only starts like a selected one is not its child', () => {
  assert.equal(coveredByAncestor('10 Work-old/Notes', new Set(['10 Work'])), false);
  assert.equal(coveredByAncestor('10 Work/Notes/Deep', new Set(['10 Work'])), true);
  assert.deepEqual(minimalFolders(new Set(['10 Work', '10 Work/Meetings', '10 Work-old']), ['10 Work', '10 Work/Meetings', '10 Work-old']), ['10 Work', '10 Work-old']);
});
