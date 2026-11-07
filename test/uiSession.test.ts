import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readRegion } from '../src/notes/companion.ts';
import { createSession } from '../src/session/meetingSession.ts';
import {
  CHECK_AND_SAVE_ACTION,
  SAVE_AGAIN_ACTION,
  editedMessage,
  pickBanners,
  remoteMessage,
  type BannerInputs,
  type BannerModel,
} from '../src/ui/components/banner.ts';
import { firstClick } from '../src/ui/components/fire.ts';
import {
  INDEX_FOLDERS_PENDING_TEXT,
  indexBuildLabel,
  indexFoldersNote,
  isManualEntry,
  meetingsView,
} from '../src/ui/components/format.ts';
import type { HamsterSession, HamsterState, MeetingListEntry, Region, VaultIndexStatus } from '../src/types.ts';
import { makeWorld, type FakeWorld, type FakeWorldOptions } from './helpers/fakes.ts';

/* What the sidebar says about a state, checked against the session that produces the state: a
   sentence that promises something ("nothing more is saved there", "rebuild to apply") is run
   against the real thing, so it cannot drift from what the session does. */

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function pass(world: FakeWorld, ms: number, step = 250): Promise<void> {
  await settle();
  for (let left = ms; left > 0; left -= step) {
    world.clock.advance(step);
    await settle();
  }
}

async function until(world: FakeWorld, work: Promise<unknown>): Promise<void> {
  let done = false;
  void work.finally(() => {
    done = true;
  });
  await settle();
  for (let waited = 0; !done && waited < 20_000; waited += 100) {
    world.clock.advance(100);
    await settle();
  }
  assert.ok(done, 'the action settled');
}

/** The slices Banner.tsx reads, in the same way. */
function bannerInputs(s: HamsterState): BannerInputs {
  return {
    ollamaStatus: s.ollama.status,
    missingModels: s.ollama.missingModels,
    remoteHost: s.ollama.remoteHost,
    stt: s.stt,
    sttMessage: s.sttMessage,
    tab: s.tab,
    recording: s.recording,
    hasTurns: s.turns.length > 0,
    recordingError: s.recordingError,
    detachedRegions: s.meeting?.detachedRegions ?? [],
    editedOutside: s.meeting?.editedOutside ?? [],
    cursorOutside: s.meeting?.cursorOutside ?? false,
  };
}

const DAILY = '### 1:1 Sam\n- plan first\n- budget later\n';
const SAM = '1:1 Sam#0';
const SAM_NOTE = '00 Inbox/Mtg-2026-10-09 — 1-1 Sam.md';

interface Env {
  world: FakeWorld;
  session: HamsterSession;
  state(): HamsterState;
  banners(): BannerModel[];
}

async function boot(options: FakeWorldOptions = {}): Promise<Env> {
  const world = makeWorld({ daily: DAILY, local: { firstWriteConfirmed: true }, ...options });
  const session = createSession(world.deps);
  // As main.ts does: the vault reports the plugin's own writes too.
  world.notes.onWrite = (path) => session.handleVaultChange({ type: 'modify', path });
  await session.init();
  await settle();
  const state = (): HamsterState => session.store.getState();
  return { world, session, state, banners: () => pickBanners(bannerInputs(state())) };
}

function region(env: Env, name: Region): string {
  const text = env.world.notes.files.get(SAM_NOTE);
  assert.ok(text !== undefined, 'the companion exists');
  const content = readRegion(text, name);
  assert.ok(content !== null, `the ${name} region is intact`);
  return content;
}

/** The note changes on disk and the vault reports it, as after an edit in Obsidian. */
function editNote(env: Env, change: (text: string) => string): void {
  const text = env.world.notes.files.get(SAM_NOTE) ?? '';
  const next = change(text);
  assert.notEqual(next, text, 'the edit changes the note');
  env.world.notes.files.set(SAM_NOTE, next);
  env.session.handleVaultChange({ type: 'modify', path: SAM_NOTE });
}

const MY_WORDS = 'My own words about this meeting.';
const rewriteSummary = (text: string): string =>
  text.replace(/(<!-- hamster:begin summary -->\n)[\s\S]*?(\n<!-- hamster:end summary -->)/, `$1${MY_WORDS}$2`);

/** The meeting with Sam, its companion, and a summary saved to it. */
async function summarized(): Promise<Env> {
  const env = await boot();
  env.session.controller.selectSection(SAM);
  await env.session.controller.createCompanion();
  await pass(env.world, 1000);
  assert.equal(env.state().meeting?.companionPath, SAM_NOTE);
  await env.session.controller.summarize('executive');
  await pass(env.world, 5500);
  assert.match(region(env, 'summary'), /^### Executive summary\n/);
  assert.deepEqual(env.banners(), []);
  return env;
}

test('banner and session: a summary edited by hand is left alone, as the line says, until asked', async () => {
  const env = await summarized();
  editNote(env, rewriteSummary);
  await pass(env.world, 2600, 200);

  /* The line, and the one action. */
  assert.deepEqual(env.banners(), [
    { kind: 'edited-outside', message: editedMessage(['summary']), action: SAVE_AGAIN_ACTION },
  ]);
  assert.match(editedMessage(['summary']), /^The text of AI summary was edited by hand in the companion note/);

  /* "Nothing more is saved to that section": a new summary is shown, and the note keeps the edit. */
  await env.session.controller.summarize('recap');
  await pass(env.world, 6000);
  assert.equal(env.state().summary.status, 'done');
  assert.equal(env.state().summary.style, 'recap');
  assert.equal(region(env, 'summary').trim(), MY_WORDS);
  assert.equal(env.banners().length, 1, 'the line stays up for as long as the edit is kept');

  /* "Saving there again replaces your edit with what the sidebar shows": the button's one call. */
  await env.session.controller.createCompanion();
  await pass(env.world, 6000);
  assert.match(region(env, 'summary'), /^### Recap\n/);
  assert.doesNotMatch(region(env, 'summary'), /My own words/);
  assert.deepEqual(env.banners(), []);
  await env.session.dispose();
});

test('banner and session: the same call checks the markers, so with both lines there is one button', async () => {
  const env = await summarized();
  /* The summary rewritten, and the transcript's closing marker deleted. */
  editNote(env, (text) => rewriteSummary(text).replace('<!-- hamster:end transcript -->', ''));
  await pass(env.world, 2600, 200);
  assert.deepEqual(env.state().meeting?.editedOutside, ['summary']);
  /* Damaged markers are found by a write, or when the note is read again on request. */
  assert.deepEqual(env.state().meeting?.detachedRegions, []);
  await env.session.controller.summarize('recap');
  await pass(env.world, 6000);
  await env.session.controller.createCompanion();
  await pass(env.world, 6000);

  /* Read again: the summary is taken back and replaced, the damaged transcript is set aside. */
  assert.deepEqual(env.state().meeting?.detachedRegions, ['transcript']);
  assert.match(region(env, 'summary'), /^### Recap\n/);

  /* Edited again while the markers are still damaged: both lines, one button that says both. */
  editNote(env, rewriteSummary);
  await pass(env.world, 2600, 200);
  const banners = env.banners();
  assert.deepEqual(
    banners.map((banner) => [banner.kind, 'action' in banner ? banner.action : undefined]),
    [
      ['detached', null],
      ['edited-outside', CHECK_AND_SAVE_ACTION],
    ],
  );
  await env.session.dispose();
});

test('banner and session: an Ollama address on another computer is said from the first state on', async () => {
  const env = await boot({ settings: { ollamaUrl: 'http://192.168.1.50:11434' } });
  assert.equal(env.state().ollama.remoteHost, '192.168.1.50');
  assert.deepEqual(env.banners(), [{ kind: 'ollama-remote', message: remoteMessage('192.168.1.50') }]);
  /* Back on this computer: the line goes. */
  env.world.setSettings({ ollamaUrl: 'http://localhost:11434' });
  env.session.handleSettingsChange();
  await settle();
  assert.equal(env.state().ollama.remoteHost, null);
  assert.deepEqual(env.banners(), []);
  await env.session.dispose();
});

/* ───────────────────────────── The index ───────────────────────────── */

const VAULT: Record<string, string> = {
  '10 Work/Budget.md': '# Budget\n\nThe training budget for this year is 40000 dollars.\n',
  '20 Other/Recipes.md': '# Recipes\n\nA recipe for bread with flour and water.\n',
};

const ready: VaultIndexStatus = { status: 'ready', files: 700, chunks: 6412, done: 700, total: 700, folders: ['10 Work'], error: null };

test('index: folders changed in the settings are said while a build can apply them', () => {
  assert.equal(INDEX_FOLDERS_PENDING_TEXT, 'Folders changed in settings. Rebuild the index to apply.');
  assert.equal(indexFoldersNote(ready), null);
  assert.equal(indexFoldersNote({ ...ready, foldersPending: false }), null);
  assert.equal(indexFoldersNote({ ...ready, foldersPending: true }), INDEX_FOLDERS_PENDING_TEXT);
  /* An index that failed can be built too. */
  assert.equal(indexFoldersNote({ ...ready, status: 'error', foldersPending: true }), INDEX_FOLDERS_PENDING_TEXT);
  /* No button to point at: a build is running, or a recording has paused one. */
  for (const status of ['building', 'paused'] as const) {
    assert.equal(indexBuildLabel(status), null);
    assert.equal(indexFoldersNote({ ...ready, status, foldersPending: true }), null, status);
  }
});

test('index and session: the line appears with a change in the settings and goes with the rebuild', async () => {
  const env = await boot({ files: VAULT, index: true, settings: { indexedFolders: ['10 Work'] } });
  await pass(env.world, 2000);
  const index = (): VaultIndexStatus => env.state().index;
  assert.equal(index().status, 'ready');
  assert.equal(indexFoldersNote(index()), null);

  env.world.setSettings({ indexedFolders: ['20 Other'] });
  env.session.handleSettingsChange();
  await settle();
  assert.equal(indexFoldersNote(index()), INDEX_FOLDERS_PENDING_TEXT);
  /* What the picker and the button start from is the new list; the index still holds the old one. */
  assert.deepEqual(index().folders, ['20 Other']);
  assert.equal(index().files, 1);

  /* "Rebuild the index to apply": the button builds over the folders shown. */
  await until(env.world, env.session.controller.buildIndex(index().folders));
  await pass(env.world, 2000);
  assert.equal(index().status, 'ready');
  assert.equal(indexFoldersNote(index()), null);
  await env.session.dispose();
});

/* ──────────────────────────── The meetings ─────────────────────────── */

function entry(patch: Partial<MeetingListEntry> & Pick<MeetingListEntry, 'key' | 'title'>): MeetingListEntry {
  return {
    rawTitle: patch.title,
    ordinal: 0,
    anchorLine: 0,
    isHeading: true,
    group: 'meeting',
    companionPath: null,
    current: false,
    ...patch,
  };
}

const SECTION = entry({ key: 'Sync#0', title: 'Sync', anchorLine: 4 });
const OTHER = entry({ key: 'Reading#0', title: 'Reading', anchorLine: 9, group: 'other' });
const MANUAL = entry({
  key: 'manual:1760000000000',
  title: 'Vendor call',
  anchorLine: -1,
  isHeading: false,
  companionPath: '00 Inbox/Mtg-2026-10-09 — Vendor call.md',
});

test('meetings: a meeting started on its own is told by the line it does not have', () => {
  assert.equal(isManualEntry(MANUAL), true);
  assert.equal(isManualEntry(SECTION), false);
  /* A heading may be titled like a manual key: it is still a section, on line 0 here. */
  assert.equal(isManualEntry(entry({ key: 'manual: of the new tool#0', title: 'manual: of the new tool', anchorLine: 0 })), false);
});

test('meetings: manual meetings are listed after the sections, and without a daily too', () => {
  /* The session's order is kept: the sections, then the meetings started on their own. */
  assert.deepEqual(meetingsView([SECTION, OTHER, MANUAL], true), { rows: [SECTION, MANUAL], others: [OTHER], empty: null });

  /* No daily: the sentence that says so, and still the way back to the meeting and its note. */
  assert.deepEqual(meetingsView([MANUAL], false), { rows: [MANUAL], others: [], empty: 'no-daily' });
  assert.deepEqual(meetingsView([], false), { rows: [], others: [], empty: 'no-daily' });
  /* Sections belong to a daily that exists: rows left over from one that is gone are not offered. */
  assert.deepEqual(meetingsView([SECTION, OTHER, MANUAL], false), { rows: [MANUAL], others: [], empty: 'no-daily' });

  /* A daily with no meeting in it: the hint about headings, unless there is a meeting to list. */
  assert.deepEqual(meetingsView([OTHER], true), { rows: [], others: [OTHER], empty: 'no-meetings' });
  assert.deepEqual(meetingsView([], true), { rows: [], others: [], empty: 'no-meetings' });
  assert.deepEqual(meetingsView([OTHER, MANUAL], true), { rows: [MANUAL], others: [OTHER], empty: null });
});

test('meetings and session: a meeting started on its own stays listed when the daily is gone', async () => {
  const env = await boot();
  const c = env.session.controller;
  c.newMeeting();
  await c.createCompanion();
  await pass(env.world, 1000);
  const note = env.state().meeting?.companionPath;
  assert.ok(note, 'the manual meeting has its note');
  await c.endMeeting();
  await settle();

  /* With the daily: after the section. */
  let view = meetingsView(env.state().sections, env.state().daily.exists);
  assert.deepEqual(view.rows.map((row) => [row.title, isManualEntry(row)]), [
    ['1:1 Sam', false],
    [env.state().sections.at(-1)?.title, true],
  ]);
  assert.equal(view.empty, null);
  const manual = view.rows[1] as MeetingListEntry;
  assert.match(manual.key, /^manual:/);
  assert.equal(manual.anchorLine, -1);
  assert.equal(manual.companionPath, note);

  /* The daily is deleted: the row is still there, under the sentence about the missing daily. */
  env.world.notes.setDaily(null);
  env.session.handleDailyAvailability();
  await settle();
  assert.equal(env.state().daily.exists, false);
  view = meetingsView(env.state().sections, env.state().daily.exists);
  assert.equal(view.empty, 'no-daily');
  assert.deepEqual(view.rows.map((row) => row.key), [manual.key]);

  /* And it is the way back: selecting it picks the meeting up again with its note. */
  c.selectSection(manual.key);
  await settle();
  assert.equal(env.state().meeting?.key, manual.key);
  assert.equal(env.state().meeting?.companionPath, note);
  await env.session.dispose();
});

/* ─────────────────────────── A double click ────────────────────────── */

test('clicks: the second click of a double click is left out, a click and a key press are not', () => {
  let presses = 0;
  const onClick = firstClick(() => {
    presses += 1;
  });
  /* `detail` is the count of clicks in one run: 1, then 2 for the second of a double click. */
  onClick({ detail: 1 });
  assert.equal(presses, 1);
  onClick({ detail: 2 });
  onClick({ detail: 3 });
  assert.equal(presses, 1);
  /* The next click on its own, and Enter or Space on the focused button (no click was counted). */
  onClick({ detail: 1 });
  onClick({ detail: 0 });
  assert.equal(presses, 3);
});

const TWO_MEETINGS = '### 1:1 Sam\n- plan first\n\n### Board\n- decision needed\n';
const BOARD = 'Board#0';

/** A meeting that was recorded and has no companion: its transcript is in memory only. */
async function recordedOnly(): Promise<Env> {
  const env = await boot({ daily: TWO_MEETINGS });
  const c = env.session.controller;
  c.selectSection(SAM);
  await c.startRecording();
  env.world.sources[0]?.say('We agreed on the plan.', 1, 3);
  await until(env.world, c.stopRecording());
  await settle();
  assert.equal(env.state().recording, 'idle');
  assert.equal(env.state().turns.length, 1);
  assert.equal(env.state().meeting?.companionPath, null);
  env.world.notes.notices.length = 0;
  return env;
}

test('clicks and session: a double click on a way out of an unsaved recording asks once and keeps it', async () => {
  /* The row of another meeting and "Use as meeting", "New meeting", and End: the handlers as
     Meetings.tsx and Header.tsx build them. The session takes the same request made again as
     "discard it", so the button must not make a double click two requests. */
  const ways: Array<[name: string, request: (env: Env) => void, left: (state: HamsterState) => boolean]> = [
    ['another meeting', (env) => env.session.controller.selectSection(BOARD), (state) => state.meeting?.key === BOARD],
    ['New meeting', (env) => env.session.controller.newMeeting(), (state) => state.meeting?.manual === true],
    ['End', (env) => void env.session.controller.endMeeting(), (state) => state.meeting === null],
  ];
  for (const [name, request, left] of ways) {
    const env = await recordedOnly();
    let requests = 0;
    const onClick = firstClick(() => {
      requests += 1;
      request(env);
    });

    onClick({ detail: 1 });
    onClick({ detail: 2 });
    await pass(env.world, 500, 100);
    assert.equal(requests, 1, `${name}: one request`);
    assert.equal(env.state().meeting?.key, SAM, `${name}: the meeting is still the current one`);
    assert.equal(env.state().turns.length, 1, `${name}: with what was said`);
    assert.equal(env.world.notes.notices.length, 1, `${name}: said once`);
    assert.match(env.world.notes.notices[0] ?? '', /^This meeting is not saved yet\./, name);

    /* Pressed again once the notice was read, it is the answer the notice asks for. */
    await pass(env.world, 2500, 100);
    onClick({ detail: 1 });
    await pass(env.world, 500, 100);
    assert.equal(requests, 2, `${name}: the second press is a request`);
    assert.ok(left(env.state()), `${name}: the meeting was left`);
    await env.session.dispose();
  }
});

test('clicks: every button that leaves the current meeting takes the first click only', () => {
  /* The components cannot be rendered here, so their sources are read: a click handler that asks
     for another meeting, a new one or the end of this one goes through `firstClick`. */
  const handlers = (file: string): string[] => {
    const source = readFileSync(new URL(`../src/ui/${file}`, import.meta.url), 'utf8');
    const found: string[] = [];
    for (let at = source.indexOf('onClick={'); at >= 0; at = source.indexOf('onClick={', at + 1)) {
      let end = at + 'onClick={'.length;
      for (let depth = 1; depth > 0 && end < source.length; end++) {
        if (source[end] === '{') depth += 1;
        else if (source[end] === '}') depth -= 1;
      }
      found.push(source.slice(at + 'onClick={'.length, end - 1));
    }
    return found;
  };
  const leaves = (handler: string): boolean => /\b(selectSection|onSelect|newMeeting|endMeeting)\(/.test(handler);
  const guarded: string[] = [];
  for (const file of ['tabs/Meetings.tsx', 'components/Header.tsx']) {
    for (const handler of handlers(file).filter(leaves)) {
      assert.match(handler, /^firstClick\(/, `${file}: ${handler}`);
      guarded.push(`${file}: ${handler}`);
    }
    /* Nothing reaches those requests by another road than a click handler read above. */
    const source = readFileSync(new URL(`../src/ui/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /on(DoubleClick|MouseDown|MouseUp|PointerDown|PointerUp|KeyDown)=/, file);
  }
  assert.deepEqual(guarded, [
    'tabs/Meetings.tsx: firstClick(() => controller.selectSection(entry.key))',
    'tabs/Meetings.tsx: firstClick(() => controller.newMeeting())',
    'tabs/Meetings.tsx: firstClick(() => onSelect(entry.key))',
    'components/Header.tsx: firstClick(() => controller.newMeeting())',
    'components/Header.tsx: firstClick(() => fire(controller.endMeeting()))',
  ]);
});
