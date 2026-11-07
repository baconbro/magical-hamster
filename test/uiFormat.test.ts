import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderCompanion } from '../src/notes/companion.ts';
import {
  CHECK_AND_SAVE_ACTION,
  CHECK_NOTE_ACTION,
  SAVE_AGAIN_ACTION,
  detachedMessage,
  editedMessage,
  ollamaDownMessage,
  pickBanners,
  remoteMessage,
  type BannerInputs,
} from '../src/ui/components/banner.ts';
import {
  bulletMarkdown,
  compact,
  coveredByAncestor,
  dollars,
  enhancedToMarkdown,
  folderLabel,
  folderRows,
  int,
  levelBars,
  longDate,
  minimalFolders,
  mondayOf,
  savedDollars,
  sectionKey,
  sourceLabel,
  timer,
  topicText,
  transcriptToText,
  usageFigures,
  weeklySeries,
} from '../src/ui/components/format.ts';
import type { EnhancedItem, Region } from '../src/types.ts';

const quiet: BannerInputs = {
  ollamaStatus: 'ok',
  missingModels: [],
  remoteHost: null,
  stt: 'idle',
  sttMessage: null,
  tab: 'notes',
  recording: 'idle',
  hasTurns: false,
  recordingError: null,
  detachedRegions: [],
  editedOutside: [],
  cursorOutside: false,
};

test('banner: nothing to say', () => {
  assert.deepEqual(pickBanners(quiet), []);
  assert.deepEqual(pickBanners({ ...quiet, ollamaStatus: 'unknown' }), []);
});

const DETACHED_ENHANCED = {
  kind: 'detached',
  message: 'The markers of Enhanced notes were edited in the companion note. Nothing more is saved to that section.',
  action: 'Check the note again',
} as const;

test('banner: priority order within the setup, the recording and the notes', () => {
  const all: BannerInputs = {
    ...quiet,
    ollamaStatus: 'unreachable',
    missingModels: ['gemma4:12b'],
    stt: 'failed',
    sttMessage: 'stopped',
    recordingError: 'mic gone',
    detachedRegions: ['enhanced'],
    cursorOutside: true,
  };
  const kinds = (s: BannerInputs): string[] => pickBanners(s).map((banner) => banner.kind);

  /* One line each, top to bottom: setup, recording, notes. */
  assert.deepEqual(pickBanners(all), [{ kind: 'ollama-down' }, { kind: 'stt-failed', message: 'stopped' }, DETACHED_ENHANCED]);

  /* Setup: Ollama being down comes before a model it could not have listed. */
  assert.deepEqual(pickBanners({ ...all, ollamaStatus: 'ok' })[0], { kind: 'models-missing', models: ['gemma4:12b'] });
  assert.deepEqual(kinds({ ...all, ollamaStatus: 'ok', missingModels: [] }), ['stt-failed', 'detached']);

  /* Recording: a transcription that gave up comes before the error of an earlier start. */
  assert.deepEqual(pickBanners({ ...all, stt: 'running' })[1], { kind: 'recording-error', message: 'mic gone' });
  assert.deepEqual(kinds({ ...all, stt: 'running', recordingError: null }), ['ollama-down', 'detached']);

  /* Notes: damaged markers come before the hint about the cursor. */
  assert.deepEqual(kinds({ ...all, detachedRegions: [] }), ['ollama-down', 'stt-failed', 'cursor-outside']);
  assert.deepEqual(kinds({ ...all, detachedRegions: [], cursorOutside: false }), ['ollama-down', 'stt-failed']);
});

test('banner: an Ollama banner does not hide a failed start or a dead transcription', () => {
  /* Obsidian started before Ollama, then macOS denied the microphone. Nothing else on screen says why Start came back. */
  assert.deepEqual(
    pickBanners({ ...quiet, ollamaStatus: 'unreachable', stt: 'exited', recordingError: 'Microphone access was denied.' }),
    [{ kind: 'ollama-down' }, { kind: 'recording-error', message: 'Microphone access was denied.' }],
  );
  /* The embedding model was never pulled, and the worker gave up mid-recording. */
  assert.deepEqual(
    pickBanners({
      ...quiet,
      missingModels: ['embeddinggemma-2:270m'],
      recording: 'recording',
      hasTurns: true,
      stt: 'failed',
      sttMessage: 'Transcription stopped after repeated crashes.',
    }),
    [
      { kind: 'models-missing', models: ['embeddinggemma-2:270m'] },
      { kind: 'stt-failed', message: 'Transcription stopped after repeated crashes.' },
    ],
  );
  /* Speech recognition that is not installed is said next to the Ollama banner too. */
  assert.deepEqual(
    pickBanners({ ...quiet, ollamaStatus: 'unreachable', stt: 'not-installed', sttMessage: 'install it', recording: 'recording' }),
    [{ kind: 'ollama-down' }, { kind: 'stt-not-installed', message: 'install it' }],
  );
});

test('banner: the error of an earlier start does not hide damaged markers and their button', () => {
  /* recordingError is cleared only by a start that works or by another meeting. */
  assert.deepEqual(pickBanners({ ...quiet, recordingError: 'Microphone access was denied.', detachedRegions: ['enhanced'] }), [
    { kind: 'recording-error', message: 'Microphone access was denied.' },
    DETACHED_ENHANCED,
  ]);
  assert.deepEqual(
    pickBanners({ ...quiet, stt: 'failed', sttMessage: 'stopped', cursorOutside: true }).map((banner) => banner.kind),
    ['stt-failed', 'cursor-outside'],
  );
});

test('banner: damaged markers are named by the sections of the note they belong to', () => {
  assert.equal(
    detachedMessage(['enhanced', 'transcript']),
    'The markers of Enhanced notes and Transcript were edited in the companion note. Nothing more is saved to those sections.',
  );
  assert.equal(
    detachedMessage(['summary']),
    'The markers of AI summary were edited in the companion note. Nothing more is saved to that section.',
  );
  assert.equal(
    detachedMessage(['qa']),
    'The markers of Q&A insights were edited in the companion note. Nothing more is saved to that section.',
  );
  /* In the order of the note, whatever order the session found them in, and each one once. */
  assert.equal(
    detachedMessage(['transcript', 'qa', 'enhanced', 'qa']),
    'The markers of Enhanced notes, Q&A insights and Transcript were edited in the companion note. Nothing more is saved to those sections.',
  );
  assert.equal(
    detachedMessage(['transcript', 'qa', 'summary', 'enhanced']),
    'The markers of Enhanced notes, AI summary, Q&A insights and Transcript were edited in the companion note. Nothing more is saved to those sections.',
  );
  /* Never an empty list of names, whatever reaches the banner. */
  assert.match(detachedMessage(['future' as Region]), /^Markers were edited in the companion note\./);
  assert.deepEqual(
    pickBanners({ ...quiet, detachedRegions: ['summary', 'enhanced'] }).map((banner) => banner.kind),
    ['detached'],
  );
});

test('banner: the names of the sections are the headings the companion gives them', () => {
  const note = renderCompanion({
    title: 'Sync',
    date: '2026-10-09',
    attendees: [],
    projects: [],
    dailyBasename: '2026-10-09',
    source: 'Sync#0',
  });
  for (const region of ['enhanced', 'summary', 'qa', 'transcript'] as const) {
    const heading = new RegExp(`^## (.+)\\n<!-- hamster:begin ${region} -->$`, 'm').exec(note)?.[1];
    assert.ok(heading, region);
    assert.equal(
      detachedMessage([region]),
      `The markers of ${heading} were edited in the companion note. Nothing more is saved to that section.`,
    );
  }
});

test('banner: Ollama on another computer has a line of its own, whatever else is up', () => {
  const REMOTE = {
    kind: 'ollama-remote',
    message: 'Ollama runs on 192.168.1.50, not on this computer. Transcripts, notes and questions are sent there.',
  } as const;
  assert.equal(remoteMessage('192.168.1.50'), REMOTE.message);
  /* Nothing is wrong, and it is still said: it is not a fault that goes away. */
  assert.deepEqual(pickBanners({ ...quiet, remoteHost: '192.168.1.50' }), [REMOTE]);
  assert.deepEqual(pickBanners({ ...quiet, remoteHost: '192.168.1.50', ollamaStatus: 'unknown' }), [REMOTE]);
  /* On every tab, recording or not. */
  for (const tab of ['meetings', 'notes', 'summary', 'transcript', 'ask', 'stats'] as const) {
    for (const recording of ['idle', 'starting', 'recording', 'stopping'] as const) {
      assert.deepEqual(pickBanners({ ...quiet, remoteHost: '192.168.1.50', tab, recording }), [REMOTE], `${tab} ${recording}`);
    }
  }
  /* Next to the setup line, not instead of it, and hiding none of the others. */
  assert.deepEqual(
    pickBanners({
      ...quiet,
      remoteHost: '192.168.1.50',
      ollamaStatus: 'unreachable',
      stt: 'failed',
      sttMessage: 'stopped',
      detachedRegions: ['enhanced'],
      editedOutside: ['summary'],
      cursorOutside: true,
    }).map((banner) => banner.kind),
    ['ollama-down', 'ollama-remote', 'stt-failed', 'detached', 'edited-outside'],
  );
  assert.deepEqual(
    pickBanners({ ...quiet, remoteHost: 'ollama.lab.example', missingModels: ['gemma4:12b'], cursorOutside: true }),
    [
      { kind: 'models-missing', models: ['gemma4:12b'] },
      { kind: 'ollama-remote', message: remoteMessage('ollama.lab.example') },
      { kind: 'cursor-outside' },
    ],
  );
  /* This computer: no line. A host that is blank is no host. */
  assert.deepEqual(pickBanners({ ...quiet, remoteHost: null }), []);
  assert.deepEqual(pickBanners({ ...quiet, remoteHost: '  ' }), []);
});

test('banner: an Ollama that does not answer is to be started where it runs', () => {
  assert.equal(ollamaDownMessage(null), 'Ollama is not running. Start it, then retry.');
  assert.equal(ollamaDownMessage(''), 'Ollama is not running. Start it, then retry.');
  /* Next to "Ollama runs on 192.168.1.50", "Start it" alone would point at this computer. */
  assert.equal(ollamaDownMessage('192.168.1.50'), 'Ollama does not answer on 192.168.1.50. Start it there, then retry.');
});

test('banner: a section edited by hand is named, with what the session does about it', () => {
  /* The session stops writing to the region, so the edit stays; `createCompanion` reads the note
     again and saves what the sidebar shows to it (test/meetingSession.test.ts, "a companion
     edited by hand while its meeting is open"). */
  assert.equal(
    editedMessage(['summary']),
    'The text of AI summary was edited by hand in the companion note, so nothing more is saved to that section. Saving there again replaces your edit with what the sidebar shows.',
  );
  assert.equal(
    editedMessage(['enhanced']),
    'The text of Enhanced notes was edited by hand in the companion note, so nothing more is saved to that section. Saving there again replaces your edit with what the sidebar shows.',
  );
  /* In the order of the note, each once, as for damaged markers. */
  assert.equal(
    editedMessage(['summary', 'enhanced', 'summary']),
    'The text of Enhanced notes and AI summary was edited by hand in the companion note, so nothing more is saved to those sections. Saving there again replaces your edits with what the sidebar shows.',
  );
  assert.equal(
    editedMessage(['qa', 'summary', 'enhanced']),
    'The text of Enhanced notes, AI summary and Q&A insights was edited by hand in the companion note, so nothing more is saved to those sections. Saving there again replaces your edits with what the sidebar shows.',
  );
  /* Never an empty list of names. */
  assert.match(editedMessage(['future' as Region]), /^Text was edited by hand in the companion note, so nothing more is saved to its section\./);

  assert.deepEqual(pickBanners({ ...quiet, editedOutside: ['summary'] }), [
    { kind: 'edited-outside', message: editedMessage(['summary']), action: 'Save there again' },
  ]);
  /* An empty list is none, as the session leaves it after the note was taken back. */
  assert.deepEqual(pickBanners({ ...quiet, editedOutside: [] }), []);
});

test('banner: the note has one button, and its label says everything the one call does', () => {
  /* `createCompanion` on a note that exists looks at the markers again and writes over the
     sections edited by hand. A "Check the note again" next to an edit it would replace without
     a word would not be true: with both lines up, the one button says both. */
  assert.equal(CHECK_NOTE_ACTION, 'Check the note again');
  assert.equal(SAVE_AGAIN_ACTION, 'Save there again');
  assert.equal(CHECK_AND_SAVE_ACTION, 'Check and save there again');

  assert.deepEqual(pickBanners({ ...quiet, detachedRegions: ['enhanced'] }), [DETACHED_ENHANCED]);
  const both = pickBanners({ ...quiet, detachedRegions: ['transcript'], editedOutside: ['enhanced', 'summary'] });
  assert.deepEqual(both, [
    { kind: 'detached', message: detachedMessage(['transcript']), action: null },
    { kind: 'edited-outside', message: editedMessage(['enhanced', 'summary']), action: 'Check and save there again' },
  ]);
  assert.equal(both.filter((banner) => 'action' in banner && banner.action !== null).length, 1);
  /* A label has to fit a button of the narrowest sidebar (280 px): about thirty characters. */
  for (const label of [CHECK_NOTE_ACTION, SAVE_AGAIN_ACTION, CHECK_AND_SAVE_ACTION]) assert.ok(label.length <= 28, label);
});

test('banner: the hint about the cursor gives way to damaged markers, not to an edit by hand', () => {
  const kinds = (s: BannerInputs): string[] => pickBanners(s).map((banner) => banner.kind);
  assert.deepEqual(kinds({ ...quiet, detachedRegions: ['enhanced'], cursorOutside: true }), ['detached']);
  /* The edit can be kept for the rest of the meeting: the hint must not be lost for that long. */
  assert.deepEqual(kinds({ ...quiet, editedOutside: ['summary'], cursorOutside: true }), ['edited-outside', 'cursor-outside']);
  assert.deepEqual(
    kinds({ ...quiet, detachedRegions: ['qa'], editedOutside: ['summary'], cursorOutside: true }),
    ['detached', 'edited-outside'],
  );
});

test('banner: stt not installed speaks only where a transcript is expected', () => {
  const base: BannerInputs = { ...quiet, stt: 'not-installed', sttMessage: 'install it' };
  /* Idle on another tab: a permanent condition is not nagged about. */
  assert.deepEqual(pickBanners(base), []);
  /* Recording on another tab. */
  assert.deepEqual(pickBanners({ ...base, recording: 'recording' }), [{ kind: 'stt-not-installed', message: 'install it' }]);
  assert.deepEqual(pickBanners({ ...base, recording: 'starting' }), [{ kind: 'stt-not-installed', message: 'install it' }]);
  /* The empty Transcript tab shows the same message itself. */
  assert.deepEqual(pickBanners({ ...base, tab: 'transcript' }), []);
  assert.deepEqual(pickBanners({ ...base, tab: 'transcript', recording: 'recording' }), []);
  /* With turns on screen the tab no longer says it, so the banner does. */
  assert.deepEqual(pickBanners({ ...base, tab: 'transcript', hasTurns: true }), [
    { kind: 'stt-not-installed', message: 'install it' },
  ]);
  /* While it stays quiet, the error of a start is still said. */
  assert.deepEqual(pickBanners({ ...base, recordingError: 'mic gone' }), [{ kind: 'recording-error', message: 'mic gone' }]);
  assert.deepEqual(pickBanners({ ...base, cursorOutside: true }), [{ kind: 'cursor-outside' }]);
  /* Fallback text when the session gave none. */
  const [b] = pickBanners({ ...base, sttMessage: null, recording: 'recording' });
  assert.equal(b?.kind, 'stt-not-installed');
  assert.ok(b && 'message' in b && b.message.length > 10);
});

test('format: numbers and time', () => {
  assert.equal(timer(0), '00:00');
  assert.equal(timer(754_000), '12:34');
  assert.equal(timer(6_401_000), '1:46:41');
  assert.equal(int(6412), '6,412');
  assert.equal(int(1527400.4), '1,527,400');
  assert.equal(compact(812), '812');
  assert.equal(compact(1000), '1k');
  assert.equal(compact(1234), '1.2k');
  assert.equal(compact(45210), '45k');
  assert.equal(compact(290100), '290k');
  assert.equal(compact(1_000_000), '1M');
  assert.equal(compact(1_527_400), '1.5M');
  assert.equal(dollars(3.0548), '$3.05');
  assert.equal(dollars(0), '$0.00');
  assert.equal(savedDollars({ input: 1_328_200, output: 199_200 }, 0.002).toFixed(4), '3.0548');
});

test('format: dates', () => {
  assert.equal(longDate('2026-10-09'), 'Friday, October 9');
  assert.equal(longDate('2026-10-10'), 'Saturday, October 10');
  assert.equal(longDate('not a date'), 'not a date');
  assert.equal(mondayOf('2026-10-09'), '2026-10-05');
  assert.equal(mondayOf('2026-10-05'), '2026-10-05');
  /* Sunday belongs to the week that started the Monday before. */
  assert.equal(mondayOf('2026-10-11'), '2026-10-05');
  assert.equal(mondayOf('2026-01-01'), '2025-12-29');
  assert.equal(mondayOf('garbage'), null);
});

test('format: weekly series is 8 weeks, oldest first, zero-filled, across a DST change', () => {
  const weekly = {
    '2026-10-05': { input: 100, output: 20 },
    '2026-09-21': { input: 7, output: 3 },
    '2026-11-02': { input: 5, output: 5 },
    '2020-01-06': { input: 999, output: 999 },
  };
  const s = weeklySeries(weekly, '2026-10-10');
  assert.equal(s.length, 8);
  assert.deepEqual(s.map((w) => w.key), [
    '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05',
  ]);
  assert.deepEqual(s.map((w) => w.total), [0, 0, 0, 0, 0, 10, 0, 120]);
  assert.deepEqual([s[7]?.day, s[7]?.month, s[0]?.day, s[0]?.month], ['5', 'Oct', '17', 'Aug']);
  /* The clocks change on 2026-11-01 in North America; weeks must stay 7 days apart. */
  const nov = weeklySeries(weekly, '2026-11-20');
  assert.deepEqual(nov.map((w) => w.key).slice(-4), ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']);
  assert.equal(nov.find((w) => w.key === '2026-11-02')?.total, 10);
  assert.deepEqual(weeklySeries(weekly, 'nope'), []);
  assert.equal(weeklySeries({}, '2026-10-10', 3).length, 3);
});

function item(over: Partial<EnhancedItem>): EnhancedItem {
  return { id: 'x', kind: 'item', source: 's', bullet: null, stale: false, streaming: false, excerptIds: [], ...over };
}

test('format: enhanced notes as Markdown', () => {
  assert.equal(topicText('#### Risks'), 'Risks');
  assert.equal(topicText('Risks'), 'Risks');
  assert.equal(topicText('#tag stays'), '#tag stays');
  assert.equal(bulletMarkdown('**A:** one\ntwo'), '- **A:** one\n  two');
  const md = enhancedToMarkdown([
    item({ bullet: '**A:** one' }),
    item({ bullet: null, source: 'pending' }),
    item({ kind: 'topic', source: '#### Risks' }),
    item({ bullet: '**B:** two' }),
    item({ kind: 'topic', source: 'Empty topic' }),
    item({ bullet: '   ' }),
  ]);
  assert.equal(md, '- **A:** one\n\n#### Risks\n- **B:** two');
  assert.equal(enhancedToMarkdown([]), '');
  assert.equal(enhancedToMarkdown([item({ kind: 'topic', source: 'Only' })]), '');
});

test('format: transcript as text', () => {
  const text = transcriptToText(
    [
      { id: 't1', source: 'mic', t0: 5, t1: 8, text: 'Bonjour.' },
      { id: 't2', source: 'system', t0: 3725, t1: 3730, text: 'Hello.' },
    ],
    'Fred',
  );
  assert.equal(text, '[00:05] Fred: Bonjour.\n[1:02:05] Others: Hello.');
  assert.equal(transcriptToText([], 'Fred'), '');
});

test('format: sources, usage, keys', () => {
  assert.equal(sectionKey('1:1 Jane Example', 0), '1:1 Jane Example#0');
  assert.equal(sourceLabel({ n: 1, kind: 'transcript', title: 'Transcript', time: '00:14', text: '' }), 'Transcript 00:14');
  assert.equal(sourceLabel({ n: 2, kind: 'note', title: 'Plan', heading: 'Timeline', text: '' }), 'Plan > Timeline');
  assert.equal(sourceLabel({ n: 3, kind: 'linked', title: 'Jane Example', text: '' }), 'Jane Example');
  const u = usageFigures({ model: 'm', promptTokens: 3184, cachedTokens: 2610, outputTokens: 212, totalMs: 8140, loadMs: 38, promptMs: 1290, evalMs: 6810 });
  assert.equal(Math.round(u.cachedShare * 100), 82);
  assert.equal(u.tokensPerSecond?.toFixed(1), '31.1');
  assert.equal(u.seconds.toFixed(1), '8.1');
  const zero = usageFigures({ model: 'm', promptTokens: 0, cachedTokens: 0, outputTokens: 0, totalMs: 0, loadMs: 0, promptMs: 0, evalMs: 0 });
  assert.deepEqual(zero, { cachedShare: 0, tokensPerSecond: null, seconds: 0 });
});

test('format: folder selection', () => {
  const order = ['00 Inbox', '10 Work', '10 Work/Meetings', '10 Work/Projects', '40 Resources', '40 Resources/People'];
  const sel = new Set(['10 Work', '10 Work/Meetings', '40 Resources/People']);
  assert.equal(coveredByAncestor('10 Work/Meetings', sel), true);
  assert.equal(coveredByAncestor('10 Work', sel), false);
  assert.equal(coveredByAncestor('40 Resources/People', sel), false);
  /* A name that merely starts the same is not a parent. */
  assert.equal(coveredByAncestor('10 Workshop/Notes', sel), false);
  assert.equal(coveredByAncestor('10 Work/Projects/Deep/Er', sel), true);
  assert.deepEqual(minimalFolders(sel, order), ['10 Work', '40 Resources/People']);
  /* A folder indexed earlier that the picker no longer lists is kept, at the end. */
  assert.deepEqual(minimalFolders(new Set(['Gone', '00 Inbox']), order), ['00 Inbox', 'Gone']);
  assert.deepEqual(minimalFolders(new Set(), order), []);
});

test('format: folder selection, the whole vault contains every folder', () => {
  const order = ['00 Inbox', '10 Work', '10 Work/Meetings', '20 Other'];
  /* `/` is what the settings field writes for the whole vault; the index reads '' the same way. */
  for (const whole of ['/', '']) {
    const sel = new Set([whole, '20 Other']);
    assert.equal(coveredByAncestor('20 Other', sel), true, whole);
    assert.equal(coveredByAncestor('10 Work/Meetings', sel), true, whole);
    assert.equal(coveredByAncestor('00 Inbox', new Set([whole])), true, whole);
    /* The whole vault is inside nothing, itself included. */
    assert.equal(coveredByAncestor('/', sel), false, whole);
    assert.equal(coveredByAncestor('', sel), false, whole);
    /* Ticking a folder next to it changes nothing: the build still gets the whole vault, once. */
    assert.deepEqual(minimalFolders(sel, order), ['/'], whole);
    assert.deepEqual(minimalFolders(new Set([whole]), order), ['/'], whole);
    assert.deepEqual(minimalFolders(new Set([whole, '10 Work', 'Gone']), ['/', ...order]), ['/'], whole);
  }
  /* Unticked, the folders ticked next to it are what is left. */
  assert.deepEqual(minimalFolders(new Set(['20 Other']), ['/', ...order]), ['20 Other']);
});

test('format: the folder picker has a row for every indexed folder, listed by the vault or not', () => {
  const listed = ['00 Inbox', '10 Work', '30 Deep', '30 Deep/A', '40 Resources', '40 Resources/People'];
  const paths = (indexed: string[]): string[] => folderRows(listed, indexed).map((row) => row.path);

  /* Nothing indexed yet, or only folders the vault lists: the rows are the vault's, as before. */
  assert.deepEqual(folderRows(listed, []), [
    { path: '00 Inbox', label: '00 Inbox', depth: 0 },
    { path: '10 Work', label: '10 Work', depth: 0 },
    { path: '30 Deep', label: '30 Deep', depth: 0 },
    { path: '30 Deep/A', label: 'A', depth: 1 },
    { path: '40 Resources', label: '40 Resources', depth: 0 },
    { path: '40 Resources/People', label: 'People', depth: 1 },
  ]);
  assert.deepEqual(paths(['10 Work', '40 Resources/People']), listed);

  /* The whole vault, typed as `/` in the settings: a first row, named. */
  assert.deepEqual(folderRows(listed, ['/'])[0], { path: '/', label: 'Whole vault', depth: 0 });
  assert.deepEqual(paths(['/']), ['/', ...listed]);
  assert.deepEqual(paths(['']), ['/', ...listed]);
  assert.equal(folderLabel('/'), 'Whole vault');
  assert.equal(folderLabel('10 Work'), '10 Work');

  /* A folder deeper than the vault's list goes: under the row that contains it. */
  assert.deepEqual(paths(['30 Deep/A/B']), ['00 Inbox', '10 Work', '30 Deep', '30 Deep/A', '30 Deep/A/B', '40 Resources', '40 Resources/People']);
  assert.deepEqual(folderRows(listed, ['30 Deep/A/B'])[4], { path: '30 Deep/A/B', label: 'B', depth: 2 });
  /* Its own parent is not listed either: the row says the whole of what is missing. */
  assert.deepEqual(folderRows(listed, ['10 Work/Projects/Alpha'])[2], { path: '10 Work/Projects/Alpha', label: 'Projects/Alpha', depth: 1 });

  /* A folder the vault no longer has: at the end, under its full name. */
  assert.deepEqual(folderRows(listed, ['Old name/Sub']).at(-1), { path: 'Old name/Sub', label: 'Old name/Sub', depth: 0 });
  assert.deepEqual(paths(['Gone', '10 Work']), [...listed, 'Gone']);

  /* A vault without folders still shows what the settings chose. */
  assert.deepEqual(folderRows([], ['/']), [{ path: '/', label: 'Whole vault', depth: 0 }]);
  assert.deepEqual(folderRows([], []), []);

  /* Every row can be unticked, and then the build no longer gets it. */
  for (const indexed of [['/'], ['30 Deep/A/B', '10 Work'], ['Gone'], ['/', '20 Elsewhere', '30 Deep/A/B/C']]) {
    const order = paths(indexed);
    const selected = new Set(indexed);
    for (const folder of indexed) {
      assert.ok(order.includes(folder), `${folder} has a row`);
      selected.delete(folder);
    }
    assert.deepEqual(minimalFolders(selected, order), []);
  }
  const order = paths(['/']);
  assert.deepEqual(minimalFolders(new Set(['20 Other']), order), ['20 Other']);
});

test('levelBars reads the microphone in decibels: ordinary speech lights more than one bar', () => {
  assert.equal(levelBars(0), 0);
  assert.equal(levelBars(Number.NaN), 0);
  assert.equal(levelBars(0.001), 0, '-60 dBFS: silence');
  assert.equal(levelBars(0.003), 1, '-50 dBFS: a quiet room, or a whisper');
  assert.equal(levelBars(0.03), 3, '-30 dBFS: a laptop microphone across a table (one bar on the old scale)');
  assert.equal(levelBars(0.25), 5, '-12 dBFS: speech close to the microphone');
  assert.equal(levelBars(1.5), 5);
});
