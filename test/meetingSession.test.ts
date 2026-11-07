import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ChatRequest,
  ChatResult,
  HamsterController,
  HamsterSession,
  HamsterSettings,
  HamsterState,
  Region,
} from '../src/types.ts';
import { OllamaError } from '../src/llm/ollama.ts';
import { REGIONS, readCompanionKeys, readRegion } from '../src/notes/companion.ts';
import { describeError } from '../src/session/errors.ts';
import { createSession } from '../src/session/meetingSession.ts';
import { STT_FAILED_FALLBACK, STT_NOT_INSTALLED_FALLBACK } from '../src/ui/components/banner.ts';
import { INDEX_NO_FOLDERS_TEXT, indexFoldersNote } from '../src/ui/components/format.ts';
import { clock as clockText, estimateTokens } from '../src/util/text.ts';
import {
  FakeNotesHost,
  FakeOllama,
  ManualClock,
  makeDeps,
  makeWorld,
  missingModelError,
  promptItems,
  unreachableError,
} from './helpers/fakes.ts';
import type { FakeWorld, FakeWorldOptions } from './helpers/fakes.ts';

/* Synthetic notes: the shape of a real daily, none of its content. */

const DAILY = `1:1 Sam
- onboarding going well

needs access to the finance dashboard

### 1:1 [[Jane Example]]
- Q4 roadmap: identity migration first
- budget: 2 postes gelés jusqu'en janvier
#### Risks
- vendor contract renewal may slip to Nov

### [[Steering Board]]
- decision needed on the cloud landing zone

### Work
- [ ] review the expense report
- book travel for the offsite
`;

const ENTITIES = `## People
| canonical | wikilink | aliases | active |
|---|---|---|---|
| Jane Example | [[Jane Example]] | Jane | yes |
| Sam Sample | [[Sam Sample]] | Sam | yes |

## Projects
| canonical | wikilink | aliases | active |
|---|---|---|---|
| Identity & Access Management | [[IAM]] | identity migration | yes |

## Governance
| canonical | wikilink | aliases | active |
|---|---|---|---|
| Steering Board | [[Steering Board]] | | yes |
`;

const NOTES = {
  '40 Resources/People/Jane Example.md':
    '# Jane Example\n\nDirector of infrastructure. She owns the identity migration and the vendor contract.\n',
  '10 Work/Budget 2026.md': [
    '# Budget 2026',
    '',
    '## Formation',
    '',
    'The training budget for this year is 40000 dollars, and half of it is already committed.',
    '',
  ].join('\n'),
  '10 Work/Offsite.md': '# Offsite\n\nThe offsite takes place in the mountains in February.\n',
};

const DAILY_PATH = '00 Inbox/2026-10-09.md';
const JANE = '1:1 Jane Example#0';
const BOARD = 'Steering Board#0';
const JANE_NOTE = '00 Inbox/Mtg-2026-10-09 — 1-1 Jane Example.md';
const JANE_LINK = '↳ [[Mtg-2026-10-09 — 1-1 Jane Example|Meeting notes]]';
const BOARD_NOTE = '00 Inbox/Mtg-2026-10-09 — Steering Board.md';

/** Lets every promise chain that needs no timer run to its end. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Moves the clock forward in small steps, letting promises settle after each. */
async function pass(world: FakeWorld, ms: number, step = 250): Promise<void> {
  await settle();
  for (let left = ms; left > 0; left -= step) {
    world.clock.advance(Math.min(step, left));
    await settle();
  }
}

/** Awaits an action that may be waiting on the clock (a held or retried write). */
async function until(world: FakeWorld, work: Promise<unknown>, maxMs = 10_000): Promise<void> {
  let done = false;
  const mark = (): void => {
    done = true;
  };
  void work.then(mark, mark);
  await settle();
  for (let waited = 0; !done && waited < maxMs; waited += 100) {
    world.clock.advance(100);
    await settle();
  }
  assert.ok(done, 'the action settled');
  await work;
}

interface Env {
  world: FakeWorld;
  session: HamsterSession;
  c: HamsterController;
  state(): HamsterState;
}

async function boot(options: FakeWorldOptions = {}): Promise<Env> {
  const world = makeWorld({ daily: DAILY, entities: ENTITIES, files: NOTES, ...options });
  const session = createSession(world.deps);
  await session.init();
  return { world, session, c: session.controller, state: () => session.store.getState() };
}

/** The user edits the daily. `at` puts the cursor at the start of that text; null means no focused editor. */
function type(env: Env, text: string, at: string | null = null): void {
  env.world.notes.setDaily(text);
  let cursor: number | null = null;
  if (at !== null) {
    cursor = text.indexOf(at);
    assert.notEqual(cursor, -1, `"${at}" is in the daily`);
  }
  env.session.handleDailyUpdate({ path: env.world.notes.today().path, text, cursor, userTyped: true });
}

function region(env: Env, path: string, name: Region): string {
  const text = env.world.notes.files.get(path);
  assert.ok(text !== undefined, `${path} exists`);
  const content = readRegion(text, name);
  assert.ok(content !== null, `the ${name} region is intact`);
  return content;
}

function userMessage(req: ChatRequest): string {
  return req.messages[req.messages.length - 1].content;
}

function isQuestion(req: ChatRequest): boolean {
  return /^Question: /m.test(userMessage(req));
}

/** The model says two pieces in the same instant, then nothing until it is cancelled. */
function sayTwoPiecesAndWait(world: FakeWorld, first: string, second: string): void {
  world.llm.chatStream = (_req, onToken, signal) => {
    onToken?.(first, first);
    onToken?.(second, first + second);
    return new Promise<ChatResult>((_resolve, reject) => {
      const stop = (): void => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError', kind: 'aborted' }));
      if (signal?.aborted) stop();
      else signal?.addEventListener('abort', stop, { once: true });
    });
  };
}

function vaultSnapshot(world: FakeWorld): Array<[string, string]> {
  return [...world.notes.files.entries()];
}

/** A booted session with the Jane meeting selected and its companion created. */
async function withCompanion(options: FakeWorldOptions = {}): Promise<Env> {
  const env = await boot(options);
  env.c.selectSection(JANE);
  await env.c.createCompanion();
  await settle();
  assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
  // Past the hold that follows the creation of a note.
  await pass(env.world, 1000);
  return env;
}

/**
 * Obsidian restarted: a new session over the notes another one left. Nothing is remembered
 * but what the vault holds.
 */
async function restart(before: Env): Promise<Env> {
  const world = makeWorld({ entities: ENTITIES, local: { firstWriteConfirmed: true } });
  for (const [path, text] of before.world.notes.files) world.notes.files.set(path, text);
  const session = createSession(world.deps);
  await session.init();
  return { world, session, c: session.controller, state: () => session.store.getState() };
}

/**
 * Long enough to have read "This meeting is not saved yet…": the request that discards a recording
 * counts as an answer to that notice only from a second after it.
 */
async function readNotice(env: Env): Promise<void> {
  await pass(env.world, 1000);
}

function row(env: Env, key: string): HamsterState['sections'][number] | undefined {
  return env.state().sections.find((entry) => entry.key === key);
}

/** The kinds of the numbered sources a question request carried, read from its <sources> block. */
function sourcesSent(req: ChatRequest): string[] {
  const user = req.messages[req.messages.length - 1].content;
  const block = /<sources>\n([\s\S]*?)\n<\/sources>/.exec(user)?.[1] ?? '';
  return [...block.matchAll(/^\[\d+\] (.*)$/gm)].map((m) => (m[1].startsWith('Transcript') ? 'transcript' : 'note'));
}

describe('init', () => {
  it('reports Ollama as unreachable', async () => {
    const world = makeWorld({ daily: DAILY });
    world.llm.installed = unreachableError();
    const session = createSession(world.deps);
    assert.equal(session.store.getState().ollama.status, 'unknown');
    await session.init();
    assert.deepEqual(session.store.getState().ollama, { status: 'unreachable', missingModels: [], remoteHost: null });
  });

  it('lists each missing model once', async () => {
    const world = makeWorld({ daily: DAILY });
    world.llm.installed = ['gemma4:12b'];
    const session = createSession(world.deps);
    await session.init();
    assert.deepEqual(session.store.getState().ollama, {
      status: 'ok',
      missingModels: ['embeddinggemma-2:270m'],
      remoteHost: null,
    });

    // The live model is the same as the main one: it is named once.
    world.llm.installed = [];
    await session.controller.refreshOllama();
    assert.deepEqual(session.store.getState().ollama.missingModels, ['gemma4:12b', 'embeddinggemma-2:270m']);

    world.setSettings({ liveModel: 'gemma4:4b' });
    await session.controller.refreshOllama();
    assert.deepEqual(session.store.getState().ollama.missingModels, [
      'gemma4:12b',
      'gemma4:4b',
      'embeddinggemma-2:270m',
    ]);
  });

  it('keeps the newest answer when two checks overlap', async () => {
    const env = await boot();
    const checks: Array<{ resolve(tags: string[]): void; reject(error: Error): void }> = [];
    env.world.llm.tags = () =>
      new Promise<string[]>((resolve, reject) => {
        checks.push({ resolve, reject });
      });
    const first = env.c.refreshOllama();
    const second = env.c.refreshOllama();
    checks[1].resolve(['gemma4:12b']);
    await second;
    const newest = { status: 'ok', missingModels: ['embeddinggemma-2:270m'], remoteHost: null };
    assert.deepEqual(env.state().ollama, newest);

    checks[0].reject(unreachableError());
    await first;
    assert.deepEqual(env.state().ollama, newest);
  });

  it('finds every model, loads the stats and reads the daily', async () => {
    const stats = { input: 1200, output: 300, cached: 40, weekly: {}, meetings: 3, assists: 9 };
    const env = await boot({ stats });
    const state = env.state();
    assert.deepEqual(state.ollama, { status: 'ok', missingModels: [], remoteHost: null });
    assert.deepEqual(state.stats, stats);
    assert.deepEqual(state.daily, { path: DAILY_PATH, basename: '2026-10-09', date: '2026-10-09', exists: true });
    assert.equal(state.sections.length, 4);
    assert.equal(state.activeSection, null);
    assert.equal(state.meeting, null);
    assert.equal(state.tab, 'meetings');
    assert.equal(env.world.statsIO.saves, 0);
  });

  it('treats a model tagged :latest as installed', async () => {
    const world = makeWorld({ daily: DAILY, settings: { llmModel: 'gemma4', embedModel: 'embeddinggemma-2' } });
    world.llm.installed = ['gemma4:latest', 'embeddinggemma-2:latest'];
    const session = createSession(world.deps);
    await session.init();
    assert.deepEqual(session.store.getState().ollama, { status: 'ok', missingModels: [], remoteHost: null });
  });

  it('never rejects, whatever the hosts do', async () => {
    const world = makeWorld({ daily: DAILY, index: true });
    world.llm.installed = new Error('boom');
    world.statsIO.load = async () => {
      throw new Error('stats unreadable');
    };
    world.notes.entities = async () => {
      throw new Error('registry unreadable');
    };
    world.notes.readDaily = async () => {
      throw new Error('daily unreadable');
    };
    const session = createSession(world.deps);
    await session.init();
    const state = session.store.getState();
    assert.equal(state.ollama.status, 'unreachable');
    assert.deepEqual(state.sections, []);
    assert.deepEqual(state.stats, { input: 0, output: 0, cached: 0, weekly: {}, meetings: 0, assists: 0 });
  });

  it('works without a daily note', async () => {
    const env = await boot({ daily: null });
    assert.equal(env.state().daily.exists, false);
    assert.deepEqual(env.state().sections, []);
    env.c.selectSection(JANE);
    assert.equal(env.state().meeting, null);
    assert.equal(env.world.notes.notices.length, 1);
  });

  it('shows the daily without waiting for Ollama', async () => {
    const world = makeWorld({ daily: DAILY, entities: ENTITIES });
    let answer: (tags: string[]) => void = () => {};
    world.llm.tags = () =>
      new Promise<string[]>((resolve) => {
        answer = resolve;
      });
    const session = createSession(world.deps);
    let ready = false;
    const starting = session.init().then(() => {
      ready = true;
    });
    await settle();
    assert.equal(ready, false);
    assert.equal(session.store.getState().sections.length, 4);
    assert.equal(session.store.getState().ollama.status, 'unknown');

    answer(['gemma4:12b', 'embeddinggemma-2:270m']);
    await starting;
    assert.deepEqual(session.store.getState().ollama, { status: 'ok', missingModels: [], remoteHost: null });
  });

  it('builds the knowledge index at start-up when folders were chosen', async () => {
    const env = await boot({ index: true, settings: { indexedFolders: ['10 Work'] } });
    await settle();
    const index = env.state().index;
    assert.equal(index.status, 'ready');
    assert.equal(index.files, 2);
    assert.deepEqual(index.folders, ['10 Work']);
    assert.ok(env.state().stats.input > 0, 'embedding tokens are counted');
  });

  it('leaves the index alone at start-up when the embedding model is missing or Ollama is down', async () => {
    const missing = makeWorld({ daily: DAILY, files: NOTES, index: true, settings: { indexedFolders: ['10 Work'] } });
    missing.llm.installed = ['gemma4:12b'];
    const first = createSession(missing.deps);
    await first.init();
    await settle();
    assert.equal(first.store.getState().index.status, 'none');
    assert.equal(missing.llm.embeds.length, 0);
    // The picker still shows what was chosen in settings.
    assert.deepEqual(first.store.getState().index.folders, ['10 Work']);

    const down = makeWorld({ daily: DAILY, files: NOTES, index: true, settings: { indexedFolders: ['10 Work'] } });
    down.llm.installed = unreachableError();
    const second = createSession(down.deps);
    await second.init();
    await settle();
    assert.equal(second.store.getState().index.status, 'none');
    assert.equal(down.llm.embeds.length, 0);
  });
});

describe('the daily note', () => {
  it('lists the sections in their groups', async () => {
    const env = await boot();
    assert.deepEqual(
      env.state().sections.map((s) => [s.key, s.group, s.isHeading, s.current, s.companionPath]),
      [
        ['1:1 Sam#0', 'meeting', false, false, null],
        [JANE, 'meeting', true, false, null],
        [BOARD, 'meeting', true, false, null],
        ['Work#0', 'other', true, false, null],
      ],
    );
    assert.equal(env.state().sections[1].rawTitle, '1:1 [[Jane Example]]');
    assert.equal(env.state().sections[1].anchorLine, 5);
  });

  it('hides a heading that has no title yet', async () => {
    const env = await boot();
    type(env, `${DAILY}\n### \n`, null);
    assert.equal(env.state().sections.length, 4);
    type(env, `${DAILY}\n### Retro\n`, null);
    assert.deepEqual(
      env.state().sections.map((s) => s.key),
      ['1:1 Sam#0', JANE, BOARD, 'Work#0', 'Retro#0'],
    );
  });

  it('follows the cursor with the active section and its shorthand', async () => {
    const env = await boot();
    type(env, DAILY, '- budget');
    assert.equal(env.state().activeSection?.title, '1:1 Jane Example');
    assert.deepEqual(
      env.state().shorthand.map((item) => [item.kind, item.text]),
      [
        ['item', 'Q4 roadmap: identity migration first'],
        ['item', "budget: 2 postes gelés jusqu'en janvier"],
        ['topic', 'Risks'],
        ['item', 'vendor contract renewal may slip to Nov'],
      ],
    );

    type(env, DAILY, '- decision needed');
    assert.equal(env.state().activeSection?.title, 'Steering Board');
    assert.deepEqual(
      env.state().shorthand.map((item) => item.text),
      ['decision needed on the cloud landing zone'],
    );

    // The editor loses focus: the section that was active stays, with its current lines.
    type(env, DAILY.replace('- decision needed', '- a decision is needed'), null);
    assert.equal(env.state().activeSection?.title, 'Steering Board');
    assert.deepEqual(
      env.state().shorthand.map((item) => item.text),
      ['a decision is needed on the cloud landing zone'],
    );
  });

  it('keeps every slice that did not change', async () => {
    const env = await boot();
    type(env, DAILY, '- budget');
    const before = env.state();
    let wakeUps = 0;
    const off = env.session.store.subscribe(() => {
      wakeUps += 1;
    });

    // The same text, the cursor elsewhere in the same section.
    type(env, DAILY, '- Q4 roadmap');
    assert.equal(wakeUps, 0);
    assert.equal(env.state(), before);

    type(env, DAILY.replace('- Q4 roadmap', '- Q3 roadmap'), '- Q3 roadmap');
    off();
    const after = env.state();
    assert.equal(after.sections, before.sections, 'no anchor changed');
    assert.notEqual(after.shorthand, before.shorthand);
    assert.equal(after.shorthand[1], before.shorthand[1], 'an untouched line keeps its object');
    assert.notEqual(after.shorthand[0], before.shorthand[0]);
  });

  it('ignores an update for another note', async () => {
    const env = await boot();
    const before = env.state();
    env.session.handleDailyUpdate({
      path: '00 Inbox/2026-10-08.md',
      text: '### 1:1 [[Somebody Else]]\n- a line\n',
      cursor: 5,
      userTyped: true,
    });
    assert.equal(env.state(), before);
  });

  it('moves to the new daily when the date rolls over', async () => {
    const env = await boot();
    type(env, DAILY, '- budget');
    assert.ok(env.state().activeSection);

    env.world.notes.date = '2026-10-10';
    env.session.handleDailyAvailability();
    assert.equal(env.state().daily.date, '2026-10-10');
    assert.equal(env.state().daily.exists, false);
    assert.deepEqual(env.state().sections, []);
    assert.equal(env.state().activeSection, null);
    assert.deepEqual(env.state().shorthand, []);

    env.world.notes.setDaily('### 1:1 [[Sam Sample]]\n- first day back\n');
    env.session.handleDailyAvailability();
    await settle();
    assert.equal(env.state().daily.exists, true);
    assert.deepEqual(
      env.state().sections.map((s) => s.key),
      ['1:1 Sam Sample#0'],
    );
  });

  it('notices the new date on the first update of the day', async () => {
    const env = await boot();
    env.world.notes.date = '2026-10-10';
    type(env, '### Stand-up [[Jane Example]]\n- plans for the day\n', '- plans');
    await settle();
    assert.equal(env.state().daily.path, '00 Inbox/2026-10-10.md');
    assert.deepEqual(
      env.state().sections.map((s) => s.key),
      ['Stand-up Jane Example#0'],
    );
    assert.equal(env.state().activeSection?.title, 'Stand-up Jane Example');

    // Yesterday's note is no longer today's daily.
    const before = env.state();
    env.session.handleDailyUpdate({ path: DAILY_PATH, text: DAILY, cursor: 0, userTyped: true });
    assert.equal(env.state(), before);
  });

  it('waits for the end of a recording that runs past midnight', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    env.world.notes.date = '2026-10-10';
    env.world.notes.setDaily('### Stand-up\n- a new day\n');
    env.session.handleDailyAvailability();
    await settle();
    assert.equal(env.state().daily.date, '2026-10-10');
    assert.equal(env.state().sections.length, 4, 'the list is left alone while recording');
    assert.equal(env.state().shorthand.length, 4);

    await until(env.world, env.c.stopRecording());
    await settle();
    assert.deepEqual(
      env.state().sections.map((s) => s.key),
      ['Stand-up#0'],
    );
    assert.equal(env.state().meeting?.key, JANE);
    assert.equal(env.state().meeting?.date, '2026-10-09');
  });

  it("keeps a meeting left open overnight away from the next day's section of the same name", async () => {
    const env = await withCompanion();
    await env.c.enhanceNow();
    await pass(env.world, 5500);
    const saved = region(env, JANE_NOTE, 'enhanced');
    const lines = env.state().shorthand;
    const chats = env.world.llm.chats.length;

    env.world.notes.date = '2026-10-10';
    env.session.handleDailyAvailability();
    await settle();
    type(env, '### 1:1 [[Jane Example]]\n- a new day, another subject\n', '- a new day');

    let state = env.state();
    assert.equal(state.meeting?.date, '2026-10-09');
    assert.equal(state.meeting?.companionPath, JANE_NOTE);
    assert.equal(state.meeting?.cursorOutside, true);
    assert.equal(state.shorthand, lines, 'the meeting keeps the lines of its own day');
    assert.deepEqual(
      state.sections.map((s) => [s.key, s.current, s.companionPath]),
      [[JANE, false, null]],
    );

    // Nothing of today reaches yesterday's note.
    await env.c.enhanceNow();
    await pass(env.world, 6000);
    assert.equal(env.world.llm.chats.length, chats);
    assert.equal(region(env, JANE_NOTE, 'enhanced'), saved);

    // Today's section is another meeting, and can be selected as one.
    env.c.selectSection(JANE);
    state = env.state();
    assert.equal(state.meeting?.date, '2026-10-10');
    assert.equal(state.meeting?.companionPath, null);
    assert.deepEqual(
      state.shorthand.map((item) => item.text),
      ['a new day, another subject'],
    );
    assert.equal(state.sections[0].current, true);
  });

  it('clears the list when the daily is deleted', async () => {
    const env = await boot();
    env.world.notes.setDaily(null);
    env.session.handleDailyAvailability();
    await settle();
    assert.equal(env.state().daily.exists, false);
    assert.deepEqual(env.state().sections, []);
  });

  it('re-derives the sections when settings change', async () => {
    const env = await boot();
    env.world.setSettings({
      softMarkerPattern: '^(Sync)\\b',
      micLabel: 'Mic (room)',
      costPer1k: 0.01,
      companionFolder: '10 Work/Meetings',
    });
    env.session.handleSettingsChange();
    await settle();
    const state = env.state();
    assert.equal(state.micLabel, 'Mic (room)');
    assert.equal(state.costPer1k, 0.01);
    assert.equal(state.companionFolder, '10 Work/Meetings');
    assert.deepEqual(
      state.sections.map((s) => s.key),
      [JANE, BOARD, 'Work#0'],
    );

    // Another model may not be installed.
    env.world.setSettings({ llmModel: 'gemma4:27b' });
    env.session.handleSettingsChange();
    await settle();
    assert.deepEqual(env.state().ollama, { status: 'ok', missingModels: ['gemma4:27b'], remoteHost: null });
  });

  it('reads the entity registry again when it changes', async () => {
    const env = await boot();
    type(env, `${DAILY}\n### Platform Team\n- capacity\n`, null);
    assert.equal(env.state().sections.find((s) => s.key === 'Platform Team#0')?.group, 'other');

    env.world.notes.entitiesText = `${ENTITIES}| Platform Team | [[Platform Team]] | | yes |\n`;
    env.session.handleVaultChange({ type: 'modify', path: '40 Resources/_entities.md' });
    await settle();
    assert.equal(env.state().sections.find((s) => s.key === 'Platform Team#0')?.group, 'meeting');
  });
});

describe('meetings', () => {
  it('selects a section and shows its shorthand', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    const state = env.state();
    assert.deepEqual(state.meeting, {
      key: JANE,
      title: '1:1 Jane Example',
      date: '2026-10-09',
      manual: false,
      source: { title: '1:1 Jane Example', ordinal: 0 },
      companionPath: null,
      startedAt: null,
      endedAt: null,
      detachedRegions: [],
      cursorOutside: false,
    });
    assert.equal(state.tab, 'notes');
    assert.equal(state.shorthand.length, 4);
    assert.deepEqual(
      state.sections.map((s) => s.current),
      [false, true, false, false],
    );
    // Shorthand lines are mirrored at once, waiting to be enhanced.
    assert.deepEqual(
      state.enhanced.map((e) => [e.kind, e.source, e.bullet]),
      [
        ['item', 'Q4 roadmap: identity migration first', null],
        ['item', "budget: 2 postes gelés jusqu'en janvier", null],
        ['topic', 'Risks', null],
        ['item', 'vendor contract renewal may slip to Nov', null],
      ],
    );
  });

  it('follows the typing and tells when the cursor leaves the section', async () => {
    const env = await boot();
    env.c.selectSection(JANE);

    const more = DAILY.replace('#### Risks', '- backfill for the analyst role?\n#### Risks');
    type(env, more, '- backfill');
    assert.equal(env.state().shorthand.length, 5);
    assert.equal(env.state().shorthand[2].text, 'backfill for the analyst role?');
    assert.equal(env.state().meeting?.cursorOutside, false);

    type(env, more, '- decision needed');
    assert.equal(env.state().meeting?.cursorOutside, true);
    assert.equal(env.state().shorthand.length, 5, 'the meeting keeps its own section');
    assert.equal(env.state().activeSection?.title, 'Steering Board');

    // On the heading itself counts as inside.
    type(env, more, '### 1:1 [[Jane');
    assert.equal(env.state().meeting?.cursorOutside, false);

    // No focused editor: nothing to warn about.
    type(env, more, '- decision needed');
    type(env, more, null);
    assert.equal(env.state().meeting?.cursorOutside, false);
  });

  it('keeps the last shorthand when the section cannot be found', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    const before = env.state().shorthand;
    // Without a companion there is no link line to follow a rename with.
    type(env, DAILY.replace('### 1:1 [[Jane Example]]', '### Weekly [[Jane Example]]'), '### Weekly');
    assert.equal(env.state().shorthand, before);
    assert.equal(env.state().meeting?.cursorOutside, true);
    assert.equal(env.state().meeting?.key, JANE);
  });

  it('follows a renamed heading through the link line once the companion exists', async () => {
    const env = await withCompanion();
    const daily = env.world.notes.dailyText ?? '';
    assert.ok(daily.includes(JANE_LINK));

    const renamed = daily.replace('### 1:1 [[Jane Example]]', '### Weekly [[Jane Example]]');
    type(env, renamed, '### Weekly');
    const meeting = env.state().meeting;
    assert.equal(meeting?.title, 'Weekly Jane Example');
    assert.equal(meeting?.key, 'Weekly Jane Example#0');
    assert.deepEqual(meeting?.source, { title: 'Weekly Jane Example', ordinal: 0 });
    assert.equal(meeting?.companionPath, JANE_NOTE);
    assert.equal(meeting?.cursorOutside, false);
    assert.equal(env.state().shorthand.length, 4);

    const row = env.state().sections.find((s) => s.key === 'Weekly Jane Example#0');
    assert.equal(row?.current, true);
    assert.equal(row?.companionPath, JANE_NOTE);

    // A heading emptied on the way to a new name keeps the meeting's last title.
    type(env, daily.replace('### 1:1 [[Jane Example]]', '### '), '### ');
    assert.equal(env.state().meeting?.title, 'Weekly Jane Example');
    assert.equal(env.state().shorthand.length, 4);
  });

  it('keeps the note with its section after a rename, once the meeting is left', async () => {
    const env = await withCompanion();
    const daily = env.world.notes.dailyText ?? '';
    const renamed = daily.replace('### 1:1 [[Jane Example]]', '### Weekly [[Jane Example]]');
    type(env, renamed, '### Weekly');
    await env.c.endMeeting();

    // The note's frontmatter still names the old heading; the session remembers whose note it is.
    const weekly = 'Weekly Jane Example#0';
    assert.equal(env.state().sections.find((s) => s.key === weekly)?.companionPath, JANE_NOTE);
    env.c.selectSection(weekly);
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    const files = env.world.notes.files.size;
    await env.c.createCompanion();
    assert.equal(env.world.notes.files.size, files, 'no second note');
    assert.equal(env.world.notes.dailyText, renamed, 'no second link line');
    await env.c.endMeeting();

    // Filed away while no meeting holds it, then deleted.
    const moved = '10 Work/Meetings/Jane.md';
    env.world.notes.files.set(moved, env.world.notes.files.get(JANE_NOTE) ?? '');
    env.world.notes.files.delete(JANE_NOTE);
    env.session.handleVaultChange({ type: 'rename', path: moved, oldPath: JANE_NOTE });
    type(env, renamed, null);
    assert.equal(env.state().sections.find((s) => s.key === weekly)?.companionPath, moved);
    env.world.notes.files.delete(moved);
    type(env, renamed, '### Weekly');
    assert.equal(env.state().sections.find((s) => s.key === weekly)?.companionPath, null);
  });

  it('changes nothing when the current meeting is selected again', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.enhanceNow();
    env.c.setTab('transcript');
    const before = env.state();
    env.c.selectSection(JANE);
    const after = env.state();
    assert.equal(after.meeting, before.meeting);
    assert.equal(after.enhanced, before.enhanced);
    assert.equal(after.tab, 'notes');

    // The same section named without its ordinal is still the current meeting.
    env.c.selectSection('1:1 Jane Example');
    assert.equal(env.state().meeting, before.meeting);
    assert.equal(env.state().enhanced, before.enhanced);
    assert.equal(env.world.llm.chats.length, 1);
  });

  it('resets what belongs to the meeting when another one is selected', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.enhanceNow();
    await env.c.startRecording();
    env.world.sources[0].say('We will decide next week.', 1, 4);
    await until(env.world, env.c.stopRecording());
    await settle();
    await env.c.ask('What was decided?');
    assert.equal(env.state().turns.length, 1);
    assert.equal(env.state().summary.status, 'done');
    assert.equal(env.state().qa.entries.length, 1);
    assert.ok(env.state().elapsedMs >= 0);

    assert.equal(env.state().stt, 'exited');
    // It was recorded and is in no note: the first click says so, the second one leaves it.
    env.c.selectSection(BOARD);
    assert.equal(env.state().meeting?.key, JANE);
    await readNotice(env);
    env.c.selectSection(BOARD);
    const state = env.state();
    assert.equal(state.meeting?.key, BOARD);
    assert.equal(state.meeting?.startedAt, null);
    assert.equal(state.stt, 'idle');
    assert.deepEqual(state.turns, []);
    assert.equal(state.partial, null);
    assert.deepEqual(state.summary, { style: 'executive', status: 'idle', markdown: '', error: null });
    assert.deepEqual(state.qa, { entries: [], chips: [] });
    assert.equal(state.elapsedMs, 0);
    assert.deepEqual(
      state.enhanced.map((e) => e.bullet),
      [null],
    );
    assert.equal(state.enhanceStatus, 'idle');
    assert.deepEqual(
      state.shorthand.map((item) => item.text),
      ['decision needed on the cloud landing zone'],
    );

    // The clock and the turn numbers start again.
    await env.c.startRecording();
    env.world.sources[1].say('Welcome everyone.', 2, 3);
    assert.deepEqual(
      env.state().turns.map((t) => [t.id, t.t0]),
      [['T1', 2]],
    );
  });

  it('refuses to switch meetings while recording', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    env.c.selectSection(BOARD);
    assert.equal(env.state().meeting?.key, JANE);
    env.c.newMeeting();
    assert.equal(env.state().meeting?.key, JANE);
    assert.equal(env.world.notes.notices.length, 2);
    assert.equal(env.state().recording, 'recording');
  });

  it('refuses a section that is gone or has no title', async () => {
    const env = await boot();
    env.c.selectSection('Retro#0');
    // A heading with nothing after its hashes is in the note, but is not a meeting yet.
    type(env, `${DAILY}\n### \n- a line under it\n`, null);
    env.c.selectSection('#0');
    assert.equal(env.state().meeting, null);
    assert.equal(env.world.notes.notices.length, 2);
  });

  it('links only a meeting that has no section yet', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    type(env, DAILY, '- decision needed');
    const before = env.state().meeting;
    await env.c.linkAtCursor();
    assert.equal(env.state().meeting?.key, JANE);
    assert.deepEqual(env.state().meeting, before);
    assert.equal(env.state().shorthand.length, 4);
  });

  it('starts a manual meeting and links it to the section at the cursor', async () => {
    const env = await boot();
    type(env, DAILY, '- budget');
    env.c.setTab('stats');
    env.c.newMeeting();
    let meeting = env.state().meeting;
    assert.equal(meeting?.key, `manual:${env.world.clock.now()}`);
    assert.equal(meeting?.title, 'New meeting 14:05');
    assert.equal(meeting?.manual, true);
    assert.equal(meeting?.source, null);
    assert.equal(env.state().tab, 'notes');
    assert.deepEqual(env.state().shorthand, [], 'a manual meeting has no section yet');
    assert.equal(env.state().sections.some((s) => s.current), false);

    await env.c.startRecording();
    env.world.sources[0].say('Let us begin.', 0, 2);
    await until(env.world, env.c.stopRecording());
    await settle();

    // No editor has the focus any more, but the section that was active is still known.
    type(env, DAILY, '- decision needed');
    await env.c.linkAtCursor();
    meeting = env.state().meeting;
    assert.equal(meeting?.key, BOARD);
    assert.equal(meeting?.title, 'Steering Board');
    assert.equal(meeting?.manual, false);
    assert.deepEqual(meeting?.source, { title: 'Steering Board', ordinal: 0 });
    assert.equal(env.state().turns.length, 1, 'the transcript is kept');
    assert.equal(env.state().summary.status, 'done', 'so is the summary');
    assert.deepEqual(
      env.state().shorthand.map((item) => item.text),
      ['decision needed on the cloud landing zone'],
    );
    assert.equal(env.state().sections.find((s) => s.key === BOARD)?.current, true);
  });

  it('gives two manual meetings two keys', async () => {
    const env = await boot();
    env.c.newMeeting();
    const first = env.state().meeting?.key;
    env.c.newMeeting();
    assert.notEqual(env.state().meeting?.key, first);
  });

  it('says so when there is no section to link to', async () => {
    const env = await boot();
    env.c.newMeeting();
    await env.c.linkAtCursor();
    assert.equal(env.state().meeting?.manual, true);
    assert.equal(env.world.notes.notices.length, 1);
  });

  it('saves a manual meeting into the note its section already has', async () => {
    const env = await withCompanion();
    await env.c.endMeeting();

    env.c.newMeeting();
    await env.c.startRecording();
    env.world.sources[0].say('This was recorded before the link.', 0, 3);
    await until(env.world, env.c.stopRecording());
    assert.equal(env.world.notes.writes.length, 0);

    type(env, env.world.notes.dailyText ?? '', '- budget');
    await env.c.linkAtCursor();
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    await pass(env.world, 5000);
    assert.match(region(env, JANE_NOTE, 'transcript'), /\*\*\[00:00\] Fred:\*\* This was recorded before the link\./);
  });

  it('keeps the note of a manual meeting with the section it is linked to later', async () => {
    const env = await boot({ local: { firstWriteConfirmed: true } });
    env.c.newMeeting();
    await env.c.createCompanion();
    const path = '00 Inbox/Mtg-2026-10-09 — New meeting 14-05.md';
    assert.equal(env.state().meeting?.companionPath, path);

    type(env, DAILY, '- decision needed');
    await env.c.linkAtCursor();
    assert.equal(env.state().meeting?.key, BOARD);
    assert.equal(env.state().meeting?.companionPath, path);
    // The note now has a section, and the section gets the line that says so.
    assert.equal(
      env.world.notes.dailyText,
      DAILY.replace(
        '- decision needed on the cloud landing zone\n',
        '- decision needed on the cloud landing zone\n\n↳ [[Mtg-2026-10-09 — New meeting 14-05|Meeting notes]]\n',
      ),
    );
    // The line is not shorthand.
    assert.deepEqual(
      env.state().shorthand.map((item) => item.text),
      ['decision needed on the cloud landing zone'],
    );

    await env.c.endMeeting();
    assert.equal(env.state().sections.find((s) => s.key === BOARD)?.companionPath, path);
    env.c.selectSection(BOARD);
    assert.equal(env.state().meeting?.companionPath, path);
    assert.deepEqual(env.world.notes.notices, []);
  });

  it('adds no line when the meeting that is linked has no note', async () => {
    const env = await boot({ local: { firstWriteConfirmed: true } });
    const links: unknown[] = [];
    const insert = env.world.notes.insertDailyLink.bind(env.world.notes);
    env.world.notes.insertDailyLink = (args) => {
      links.push(args);
      return insert(args);
    };
    env.c.newMeeting();
    await env.c.startRecording();
    env.world.sources[0].say('Said before there was a section.', 0, 2);
    await until(env.world, env.c.stopRecording());
    await settle();

    type(env, DAILY, '- decision needed');
    await env.c.linkAtCursor();
    await settle();
    assert.equal(env.state().meeting?.key, BOARD);
    assert.equal(env.state().meeting?.companionPath, null);
    assert.equal(env.world.notes.dailyText, DAILY);
    assert.deepEqual(links, [], 'the daily was not even looked at');
    assert.deepEqual(env.world.notes.notices, []);
    assert.equal(env.world.notes.files.size, Object.keys(NOTES).length + 1, 'nothing but the daily');

    // Nor when its note was deleted behind the plugin's back: the line would link to nothing.
    const gone = await boot({ local: { firstWriteConfirmed: true } });
    gone.c.newMeeting();
    await gone.c.createCompanion();
    gone.world.notes.files.delete('00 Inbox/Mtg-2026-10-09 — New meeting 14-05.md');
    type(gone, DAILY, '- decision needed');
    await gone.c.linkAtCursor();
    assert.equal(gone.state().meeting?.key, BOARD);
    assert.equal(gone.world.notes.dailyText, DAILY);
  });

  it('ends the meeting: recording stopped, writes flushed, panel cleared', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('A last word.', 3, 5);
    await until(env.world, env.c.endMeeting());

    const state = env.state();
    assert.equal(state.meeting, null);
    assert.equal(state.recording, 'idle');
    assert.deepEqual(state.turns, []);
    assert.deepEqual(state.enhanced, []);
    assert.equal(state.elapsedMs, 0);
    assert.equal(state.summary.status, 'idle', 'no summary is started for a meeting that is being cleared');
    assert.equal(env.world.llm.chats.length, 0);
    assert.equal(state.tab, 'notes');
    assert.equal(source.stops, 1);
    assert.match(region(env, JANE_NOTE, 'transcript'), /A last word\./);
    assert.equal(state.sections.some((s) => s.current), false);
    assert.equal(state.sections.find((s) => s.key === JANE)?.companionPath, JANE_NOTE);
  });

  it('opens the daily and the companion', async () => {
    const env = await withCompanion();
    env.c.openDaily();
    env.c.openCompanion();
    assert.deepEqual(env.world.notes.opened, [DAILY_PATH, JANE_NOTE]);

    // A companion deleted behind the plugin's back is noticed on the way.
    env.world.notes.files.delete(JANE_NOTE);
    env.c.openCompanion();
    assert.equal(env.world.notes.opened.length, 2);
    assert.equal(env.state().meeting?.companionPath, null);

    // A daily that does not exist is not opened: the plugin never creates it.
    env.world.notes.setDaily(null);
    env.c.openDaily();
    assert.equal(env.world.notes.opened.length, 2);
    assert.equal(env.state().daily.exists, false);
  });
});

describe('before the companion exists', () => {
  it('writes nothing to the vault while recording, enhancing, summarizing and asking', async () => {
    const env = await boot({ index: true });
    await env.c.buildIndex(['10 Work']);
    const before = vaultSnapshot(env.world);

    env.c.selectSection(JANE);
    env.c.setLiveEnhance(true);
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.partial('thanks for');
    source.say('Thanks for making time. The identity migration has to go first.', 1, 12);
    source.say('What is the training budget this year?', 14, 46, 'system');
    await env.c.enhanceNow();
    type(env, DAILY.replace('#### Risks', '- backfill for the analyst role?\n#### Risks'), '- backfill');
    await pass(env.world, 9000);
    await until(env.world, env.c.stopRecording());
    await settle();
    await env.c.summarize('recap');
    await env.c.ask('What is the training budget?');
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await pass(env.world, 60_000);
    await env.session.flushAll();

    const state = env.state();
    assert.equal(state.turns.length, 2);
    assert.equal(state.enhanced.filter((e) => e.bullet !== null).length, 4);
    assert.equal(state.summary.status, 'done');
    assert.equal(state.qa.entries[0].status, 'done');
    assert.equal(state.qa.entries[0].kept, false);
    assert.equal(state.pendingWrites, 0);

    // The daily was typed in by the user above; everything else is as it was.
    const after = vaultSnapshot(env.world).map(([path, text]) => [path, path === DAILY_PATH ? DAILY : text]);
    assert.deepEqual(after, before);
    assert.equal(env.world.notes.writes.length, 0);
    assert.equal(env.world.notes.touched.length, 0);
    assert.equal(env.world.notes.confirmations.length, 0);
    assert.equal(env.world.local().firstWriteConfirmed, false);
  });
});

describe('before the companion exists, whatever else is done', () => {
  /** Counts every call that could change the vault. */
  function watchWrites(world: FakeWorld): { calls: string[] } {
    const seen = { calls: [] as string[] };
    const notes = world.notes;
    const { createCompanion, writeCompanion, touchCompanion, insertDailyLink, confirmFirstWrite } = notes;
    notes.createCompanion = (...args) => {
      seen.calls.push('createCompanion');
      return createCompanion.apply(notes, args);
    };
    notes.writeCompanion = (...args) => {
      seen.calls.push('writeCompanion');
      return writeCompanion.apply(notes, args);
    };
    notes.touchCompanion = (...args) => {
      seen.calls.push('touchCompanion');
      return touchCompanion.apply(notes, args);
    };
    notes.insertDailyLink = (...args) => {
      seen.calls.push('insertDailyLink');
      return insertDailyLink.apply(notes, args);
    };
    notes.confirmFirstWrite = (...args) => {
      seen.calls.push('confirmFirstWrite');
      return confirmFirstWrite.apply(notes, args);
    };
    return seen;
  }

  it('writes nothing for a meeting started on its own, linked, ended and picked up again', async () => {
    const env = await boot({ index: true });
    await env.c.buildIndex(['10 Work']);
    const seen = watchWrites(env.world);
    const before = vaultSnapshot(env.world);

    env.c.newMeeting();
    env.c.setLiveEnhance(true);
    await env.c.startRecording();
    env.world.sources[0].say('Who signs the vendor contract this year?', 1, 4, 'system');
    await until(env.world, env.c.stopRecording());
    await settle();
    type(env, DAILY, '- budget');
    await env.c.linkAtCursor();
    assert.equal(env.state().meeting?.key, JANE);
    await pass(env.world, 9000);
    // The lines came with the link, not from typing: Live Enhance waits, the button does not.
    await env.c.enhanceNow();
    await env.c.ask('Who signs?', env.state().qa.chips[0]?.id);
    await env.c.keepInsight(env.state().qa.entries[0].id);
    env.c.openCompanion();
    env.session.handleVaultChange({ type: 'modify', path: '10 Work/Offsite.md' });
    env.session.handleSettingsChange();
    // Ended twice: it was recorded and is in no note, so the first time only says so.
    await until(env.world, env.c.endMeeting());
    assert.equal(env.state().meeting?.key, JANE);
    await readNotice(env);
    await until(env.world, env.c.endMeeting());
    assert.equal(env.state().meeting, null);

    env.c.selectSection(BOARD);
    await env.c.startRecording();
    env.world.sources[1].say('The board meets again in March.', 1, 3);
    env.world.notes.date = '2026-10-10';
    env.session.handleDailyAvailability();
    await pass(env.world, 61_000, 1000);
    await env.session.flushAll();
    await until(env.world, env.session.dispose());

    assert.deepEqual(seen.calls, []);
    assert.deepEqual(vaultSnapshot(env.world), before);
    assert.equal(env.world.local().firstWriteConfirmed, false);
    assert.ok(env.world.llm.chats.length >= 3, 'the work was done, in memory');
  });

  it('writes nothing when the daily does not exist', async () => {
    const env = await boot({ daily: null });
    const seen = watchWrites(env.world);
    env.c.newMeeting();
    await env.c.startRecording();
    env.world.sources[0].say('A meeting without a daily note.', 1, 3);
    await until(env.world, env.c.stopRecording());
    await settle();
    env.c.openDaily();
    await env.c.linkAtCursor();
    await until(env.world, env.c.endMeeting());
    assert.deepEqual(seen.calls, []);
    assert.equal(env.world.notes.dailyText, null, 'the plugin never creates the daily');
    assert.deepEqual(env.world.notes.opened, []);
  });
});

describe('createCompanion', () => {
  it('writes nothing when the confirmation is declined', async () => {
    const env = await boot();
    env.world.notes.confirmAnswer = false;
    const before = vaultSnapshot(env.world);
    env.c.selectSection(JANE);
    await env.c.createCompanion();

    assert.deepEqual(vaultSnapshot(env.world), before);
    assert.equal(env.state().meeting?.companionPath, null);
    assert.equal(env.world.local().firstWriteConfirmed, false);
    assert.deepEqual(env.world.notes.notices, []);
    assert.deepEqual(env.world.notes.confirmations, [
      {
        companionPath: JANE_NOTE,
        linkLine: JANE_LINK,
        where: 'end of the section “1:1 Jane Example” in 00 Inbox/2026-10-09.md',
      },
    ]);
  });

  it('writes nothing when declined, whatever is already in memory', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.enhanceNow();
    await env.c.startRecording();
    env.world.sources[0].say('The cutover is planned for mid-November.', 2, 6);
    await until(env.world, env.c.stopRecording());
    await settle();
    await env.c.ask('When is the cutover?');
    assert.equal(env.state().summary.status, 'done');
    const before = vaultSnapshot(env.world);

    env.world.notes.confirmAnswer = false;
    await env.c.createCompanion();
    await pass(env.world, 40_000, 1000);
    await env.session.flushAll();
    assert.deepEqual(vaultSnapshot(env.world), before);
    assert.equal(env.world.notes.writes.length, 0);
    assert.equal(env.world.notes.touched.length, 0);
    assert.equal(env.state().pendingWrites, 0);
    assert.equal(env.state().meeting?.companionPath, null);

    // Asked again and accepted, the note receives what was waiting in memory.
    env.world.notes.confirmAnswer = true;
    await env.c.createCompanion();
    await pass(env.world, 6200);
    assert.equal(env.world.notes.confirmations.length, 2);
    assert.match(region(env, JANE_NOTE, 'transcript'), /The cutover is planned for mid-November\./);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /^- \*\*Note:\*\* Q4 roadmap/m);
  });

  it('creates the note and adds one line to the daily', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.createCompanion();
    await settle();

    const note = env.world.notes.files.get(JANE_NOTE);
    assert.ok(note);
    assert.match(note, /^attendees: \["Jane Example"\]$/m);
    assert.match(note, /^projects: \[\]$/m);
    assert.match(note, /^links: \["\[\[2026-10-09\]\]"\]$/m);
    assert.match(note, /^# 1:1 Jane Example$/m);
    assert.deepEqual(readCompanionKeys(note), { date: '2026-10-09', source: JANE });
    for (const name of REGIONS) assert.notEqual(readRegion(note, name), null);

    // One link line, after a blank line because the section ends with a list.
    const expected = DAILY.replace(
      '- vendor contract renewal may slip to Nov\n',
      `- vendor contract renewal may slip to Nov\n\n${JANE_LINK}\n`,
    );
    assert.equal(env.world.notes.dailyText, expected);

    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    assert.equal(env.state().sections.find((s) => s.key === JANE)?.companionPath, JANE_NOTE);
    assert.equal(env.world.local().firstWriteConfirmed, true);
    assert.deepEqual(env.world.notes.notices, []);
    // The link line is not a shorthand line.
    assert.equal(env.state().shorthand.length, 4);
  });

  it('files a governance body under projects', async () => {
    const env = await boot();
    env.c.selectSection(BOARD);
    await env.c.createCompanion();
    const note = env.world.notes.files.get('00 Inbox/Mtg-2026-10-09 — Steering Board.md');
    assert.ok(note);
    assert.match(note, /^attendees: \[\]$/m);
    assert.match(note, /^projects: \["Steering Board"\]$/m);
  });

  it('adopts the existing note on a second call', async () => {
    const env = await withCompanion();
    const before = vaultSnapshot(env.world);
    await env.c.createCompanion();
    await pass(env.world, 6000);
    assert.deepEqual(vaultSnapshot(env.world), before);
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    assert.equal(env.world.notes.confirmations.length, 1);
  });

  it('finds the note again in a later session', async () => {
    const first = await withCompanion();
    const world = makeWorld({
      daily: first.world.notes.dailyText,
      entities: ENTITIES,
      local: { firstWriteConfirmed: true },
    });
    world.notes.files.set(JANE_NOTE, first.world.notes.files.get(JANE_NOTE) ?? '');
    const session = createSession(world.deps);
    await session.init();
    assert.equal(session.store.getState().sections.find((s) => s.key === JANE)?.companionPath, JANE_NOTE);

    session.controller.selectSection(JANE);
    assert.equal(session.store.getState().meeting?.companionPath, JANE_NOTE);
    const files = world.notes.files.size;
    await session.controller.createCompanion();
    assert.equal(world.notes.files.size, files);
    assert.equal(world.notes.dailyText, first.world.notes.dailyText);
  });

  it('finds the note of a renamed heading again after a restart, through its link line', async () => {
    const first = await withCompanion();
    const renamed = (first.world.notes.dailyText ?? '').replace('### 1:1 [[Jane Example]]', '### Weekly [[Jane Example]]');
    type(first, renamed, '### Weekly');
    await first.c.endMeeting();

    const env = await restart(first);
    const weekly = 'Weekly Jane Example#0';
    // The note still names the old heading, which is all its frontmatter can be found by.
    assert.equal(readCompanionKeys(env.world.notes.files.get(JANE_NOTE) ?? '').source, JANE);
    assert.equal(env.world.notes.findCompanion('2026-10-09', weekly), null);
    assert.equal(row(env, weekly)?.companionPath, JANE_NOTE);
    assert.equal(row(env, BOARD)?.companionPath, null);

    env.c.selectSection(weekly);
    await settle();
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    assert.equal(env.state().shorthand.length, 4);
    assert.equal(env.world.notes.dailyText, renamed, 'selecting a section writes nothing');

    const files = [...env.world.notes.files.keys()];
    await env.c.createCompanion();
    await pass(env.world, 6000);
    assert.deepEqual([...env.world.notes.files.keys()], files, 'no second note');
    assert.equal(env.world.notes.dailyText, renamed, 'no second link line');
    assert.equal(env.world.notes.dailyText?.split('↳ [[').length, 2);
    assert.deepEqual(env.world.notes.confirmations, []);
    assert.deepEqual(env.world.notes.notices, []);

    // What is recorded now goes into the note the section had all along.
    await env.c.startRecording();
    env.world.sources[0].say('Said after the restart.', 1, 2);
    await until(env.world, env.c.stopRecording());
    assert.match(region(env, JANE_NOTE, 'transcript'), /Said after the restart\./);
    assert.deepEqual([...env.world.notes.files.keys()], files);
  });

  it('keeps a note with its section, after a restart, when one of the same title is added above', async () => {
    const first = await withCompanion();
    const shifted = (first.world.notes.dailyText ?? '').replace(
      '### 1:1 [[Jane Example]]',
      '### 1:1 [[Jane Example]]\n- a first talk, earlier in the day\n\n### 1:1 [[Jane Example]]',
    );
    type(first, shifted, '- Q4 roadmap');
    assert.equal(first.state().meeting?.key, '1:1 Jane Example#1', 'the meeting followed its link line');
    await first.c.endMeeting();

    const env = await restart(first);
    const below = '1:1 Jane Example#1';
    // The frontmatter names the key the section above has taken over.
    assert.equal(readCompanionKeys(env.world.notes.files.get(JANE_NOTE) ?? '').source, JANE);
    assert.equal(row(env, below)?.companionPath, JANE_NOTE);

    env.c.selectSection(below);
    await settle();
    assert.equal(env.state().meeting?.key, below);
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    assert.equal(env.state().shorthand.length, 4);

    const files = [...env.world.notes.files.keys()];
    await env.c.createCompanion();
    await pass(env.world, 6000);
    assert.deepEqual([...env.world.notes.files.keys()], files, 'no second note');
    assert.equal(env.world.notes.dailyText, shifted, 'no second link line');
    assert.deepEqual(env.world.notes.notices, []);
  });

  it('does not hand a note to the section that took over its key', async () => {
    const first = await withCompanion();
    const shifted = (first.world.notes.dailyText ?? '').replace(
      '### 1:1 [[Jane Example]]',
      '### 1:1 [[Jane Example]]\n- a first talk, earlier in the day\n\n### 1:1 [[Jane Example]]',
    );
    type(first, shifted, '- Q4 roadmap');
    // In the session that saw the section move, and in the next one.
    assert.equal(row(first, JANE)?.companionPath, null);
    await first.c.endMeeting();
    assert.equal(row(first, JANE)?.companionPath, null);
    assert.equal(row(first, '1:1 Jane Example#1')?.companionPath, JANE_NOTE);

    const env = await restart(first);
    assert.equal(env.world.notes.findCompanion('2026-10-09', JANE), JANE_NOTE, 'by its key alone, the note is the wrong section\'s');
    assert.equal(row(env, JANE)?.companionPath, null);

    // The section above is a meeting of its own: it stays selected, and gets its own note and line.
    env.c.selectSection(JANE);
    await settle();
    assert.equal(env.state().meeting?.key, JANE);
    assert.equal(env.state().meeting?.companionPath, null);
    assert.deepEqual(
      env.state().shorthand.map((item) => item.text),
      ['a first talk, earlier in the day'],
    );
    await env.c.createCompanion();
    await pass(env.world, 1000);
    const second = '00 Inbox/Mtg-2026-10-09 — 1-1 Jane Example (2).md';
    assert.equal(env.state().meeting?.key, JANE);
    assert.equal(env.state().meeting?.companionPath, second);
    assert.equal(row(env, JANE)?.companionPath, second);
    assert.equal(row(env, '1:1 Jane Example#1')?.companionPath, JANE_NOTE);
    assert.equal(env.world.notes.dailyText?.split('↳ [[').length, 3, 'one line per note');

    // Two notes now carry the same key: each row still shows the one its section links to.
    await env.c.endMeeting();
    assert.equal(row(env, JANE)?.companionPath, second);
    assert.equal(row(env, '1:1 Jane Example#1')?.companionPath, JANE_NOTE);
  });

  it('takes a link line for the section right above it, not for the one that section is nested in', async () => {
    const env = await boot({
      daily: [
        '## Meetings',
        '### 1:1 [[Jane Example]]',
        '- Q4 roadmap: identity migration first',
        '',
        JANE_LINK,
        '',
        '## Work',
        '- book travel for the offsite',
        '',
      ].join('\n'),
      // Its heading was called something else when the note was made.
      files: { ...NOTES, [JANE_NOTE]: '---\ndate: 2026-10-09\nhamster_source: "Catch-up Jane#0"\n---\n' },
    });
    assert.equal(row(env, JANE)?.companionPath, JANE_NOTE);
    assert.equal(row(env, 'Meetings#0')?.companionPath, null);
    assert.equal(row(env, 'Work#0')?.companionPath, null);
  });

  it('leaves a note with the section it was made for when its line ends up under a nested heading', async () => {
    const nested = [
      '## 1:1 [[Jane Example]]',
      '- Q4 roadmap: identity migration first',
      '### Budget',
      "- 2 postes gelés jusqu'en janvier",
      '',
      '## Work',
      '- book travel for the offsite',
      '',
    ].join('\n');
    const env = await boot({ daily: nested, local: { firstWriteConfirmed: true } });
    env.c.selectSection(JANE);
    await env.c.createCompanion();
    // At the end of the section: under the last of its sub-headings.
    assert.equal(
      env.world.notes.dailyText,
      nested.replace("- 2 postes gelés jusqu'en janvier\n", `- 2 postes gelés jusqu'en janvier\n\n${JANE_LINK}\n`),
    );
    assert.equal(row(env, JANE)?.companionPath, JANE_NOTE);
    assert.equal(row(env, 'Budget#0')?.companionPath, null);
    await env.c.endMeeting();

    for (const later of [env, await restart(env)]) {
      assert.equal(row(later, JANE)?.companionPath, JANE_NOTE);
      assert.equal(row(later, 'Budget#0')?.companionPath, null, 'the line is above it, the note is not its own');
      assert.equal(row(later, 'Work#0')?.companionPath, null);
      // A meeting on the sub-heading would otherwise write over the notes of the one around it.
      later.c.selectSection('Budget#0');
      assert.equal(later.state().meeting?.key, 'Budget#0');
      assert.equal(later.state().meeting?.companionPath, null);
      await later.c.endMeeting();
    }
  });

  it('reads no link in a line that is not the plugin\'s, is in a code block, or names another day\'s note', async () => {
    const other = '00 Inbox/Mtg-2026-10-08 — 1-1 Jane Example.md';
    const env = await boot({
      daily: [
        '### 1:1 [[Jane Example]]',
        '- carried over from yesterday, link and all',
        '↳ [[Mtg-2026-10-08 — 1-1 Jane Example|Meeting notes]]',
        '',
        '### [[Steering Board]]',
        '- how the plugin marks a section:',
        '```',
        JANE_LINK,
        '```',
        '',
        '### Work',
        `- see [[${JANE_NOTE.slice('00 Inbox/'.length, -3)}]] for the notes`,
        '',
      ].join('\n'),
      files: {
        ...NOTES,
        [other]: '---\ndate: 2026-10-08\nhamster_source: "1:1 Jane Example#0"\n---\n',
        [JANE_NOTE]: '---\ndate: 2026-10-09\nhamster_source: "Some other heading#0"\n---\n',
      },
    });
    assert.deepEqual(
      env.state().sections.map((entry) => entry.companionPath),
      [null, null, null],
    );
    // Yesterday's note is not written to from today's section.
    env.c.selectSection(JANE);
    assert.equal(env.state().meeting?.companionPath, null);
  });

  it('adds the line that is missing when asked for a note that exists, and only then', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    // The section is not in the file at the moment the line is to be added.
    env.world.notes.setDaily('### Something else\n');
    await env.c.createCompanion();
    assert.ok(env.world.notes.files.has(JANE_NOTE));
    assert.equal(env.world.notes.notices.length, 1);
    await env.c.endMeeting();

    // The section is back. Nothing but the explicit request touches the daily.
    type(env, DAILY, '- budget');
    assert.equal(row(env, JANE)?.companionPath, JANE_NOTE);
    env.c.newMeeting();
    await env.c.linkAtCursor();
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    assert.equal(env.world.notes.dailyText, DAILY, 'linking a meeting to a section adds no line');
    await env.c.endMeeting();
    env.c.selectSection(JANE);
    await settle();
    await pass(env.world, 6000);
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    assert.equal(env.world.notes.dailyText, DAILY, 'selecting a section adds no line');

    const files = env.world.notes.files.size;
    await env.c.createCompanion();
    const linked = DAILY.replace(
      '- vendor contract renewal may slip to Nov\n',
      `- vendor contract renewal may slip to Nov\n\n${JANE_LINK}\n`,
    );
    assert.equal(env.world.notes.dailyText, linked);
    assert.equal(env.world.notes.files.size, files);
    // The plugin's own edit is not reported by the editor: the session reads the note again.
    assert.equal(env.state().activeSection?.linkLine, linked.split('\n').indexOf(JANE_LINK));
    assert.equal(env.state().shorthand.length, 4);
    assert.equal(env.world.notes.notices.length, 1, 'added through the editor: nothing to announce');

    // Asked again, it finds the line there.
    await env.c.createCompanion();
    assert.equal(env.world.notes.dailyText, linked);
    assert.equal(env.world.notes.notices.length, 1);
    assert.equal(env.world.notes.confirmations.length, 1);
  });

  it('quotes the line it restores through the vault, and says so when it cannot restore it', async () => {
    const env = await withCompanion();
    const linked = env.world.notes.dailyText ?? '';
    // The user deleted the line by hand; the daily is not open in an editor.
    type(env, DAILY, null);
    env.world.notes.linkVia = 'vault';
    await env.c.createCompanion();
    assert.equal(env.world.notes.dailyText, linked);
    assert.deepEqual(env.world.notes.notices, [`Added to your daily note: ${JANE_LINK}`]);

    // The section is gone from the note: there is nowhere to put the line.
    env.world.notes.setDaily('### Something else\n');
    await env.c.createCompanion();
    assert.equal(env.world.notes.dailyText, '### Something else\n');
    assert.deepEqual(env.world.notes.notices.slice(1), [
      'The link to the companion note could not be added to your daily note.',
    ]);
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
  });

  it('gives the note of a manual meeting its line once the meeting has a section', async () => {
    const env = await boot({ local: { firstWriteConfirmed: true } });
    env.c.newMeeting();
    await env.c.createCompanion();
    const path = '00 Inbox/Mtg-2026-10-09 — New meeting 14-05.md';
    assert.equal(env.world.notes.dailyText, DAILY, 'a meeting without a section has nowhere to put a line');
    type(env, DAILY, '- decision needed');
    await env.c.linkAtCursor();
    const line = '↳ [[Mtg-2026-10-09 — New meeting 14-05|Meeting notes]]';
    const linkedDaily = DAILY.replace(
      '- decision needed on the cloud landing zone\n',
      `- decision needed on the cloud landing zone\n\n${line}\n`,
    );
    assert.equal(env.world.notes.dailyText, linkedDaily);
    assert.deepEqual(env.world.notes.notices, [], 'written through the editor: the user saw it land');

    // Once: asking for the note again finds the line where it is.
    await env.c.createCompanion();
    await env.c.linkAtCursor();
    assert.equal(env.world.notes.dailyText, linkedDaily);
    assert.equal(env.state().meeting?.companionPath, path);
    assert.equal(env.world.notes.files.size, Object.keys(NOTES).length + 2, 'the daily and one companion');

    // From here on the line says whose note it is, in any later session.
    await env.c.endMeeting();
    const later = await restart(env);
    assert.equal(row(later, BOARD)?.companionPath, path);

    // And in this one: the heading is renamed, and a new section takes its old name. What the
    // session remembers under that name gives way to the line.
    const linked = env.world.notes.dailyText ?? '';
    const again = `${linked.replace('### [[Steering Board]]', '### [[Steering Board]] in review')}\n### [[Steering Board]]\n- a second sitting\n`;
    type(env, again, null);
    assert.equal(row(env, 'Steering Board in review#0')?.companionPath, path);
    assert.equal(row(env, BOARD)?.companionPath, null);
  });

  it('says so when the line of a linked meeting is written behind a closed note, or cannot be written', async () => {
    const line = '↳ [[Mtg-2026-10-09 — New meeting 14-05|Meeting notes]]';
    const linked = async (prepare: (env: Env) => void): Promise<Env> => {
      const env = await boot({ local: { firstWriteConfirmed: true } });
      env.c.newMeeting();
      await env.c.createCompanion();
      type(env, DAILY, '- decision needed');
      prepare(env);
      await env.c.linkAtCursor();
      assert.equal(env.state().meeting?.key, BOARD, 'the meeting is linked either way');
      assert.equal(env.state().meeting?.companionPath, '00 Inbox/Mtg-2026-10-09 — New meeting 14-05.md');
      return env;
    };

    // The daily is not open in an editor: the user did not see the line land.
    const closed = await linked((env) => {
      env.world.notes.linkVia = 'vault';
    });
    assert.deepEqual(closed.world.notes.notices, [`Added to your daily note: ${line}`]);
    assert.equal(closed.world.notes.dailyText?.split(line).length, 2);

    // The host cannot write it.
    const failing = await linked((env) => {
      env.world.notes.insertDailyLink = async () => {
        throw new Error('The daily note is locked.');
      };
    });
    assert.deepEqual(failing.world.notes.notices, ['The link to the companion note could not be added to your daily note.']);
    assert.equal(failing.world.notes.dailyText, DAILY);
    // The session still knows whose note it is, and "Create companion note" is the way to try again.
    await failing.c.endMeeting();
    assert.equal(row(failing, BOARD)?.companionPath, '00 Inbox/Mtg-2026-10-09 — New meeting 14-05.md');
  });

  it('adds no line for a note that no longer bears the plugin\'s name, or for a meeting of another day', async () => {
    const env = await withCompanion();
    const renamed = '10 Work/Meetings/Jane.md';
    env.world.notes.files.set(renamed, env.world.notes.files.get(JANE_NOTE) ?? '');
    env.world.notes.files.delete(JANE_NOTE);
    env.session.handleVaultChange({ type: 'rename', path: renamed, oldPath: JANE_NOTE });
    const daily = env.world.notes.dailyText;
    await env.c.createCompanion();
    assert.equal(env.state().meeting?.companionPath, renamed);
    assert.equal(env.world.notes.dailyText, daily, 'a line the plugin would not know for its own is not written');

    const old = await withCompanion();
    type(old, DAILY, null);
    old.world.notes.date = '2026-10-10';
    old.session.handleDailyAvailability();
    await settle();
    type(old, '### 1:1 [[Jane Example]]\n- a new day\n', null);
    await old.c.createCompanion();
    assert.equal(old.state().meeting?.companionPath, JANE_NOTE);
    assert.equal(old.world.notes.dailyText, '### 1:1 [[Jane Example]]\n- a new day\n');
    assert.deepEqual(old.world.notes.notices, []);
  });

  it('creates one note when asked twice while the confirmation is open', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    const answers: Array<(accepted: boolean) => void> = [];
    env.world.notes.confirmFirstWrite = (preview) => {
      env.world.notes.confirmations.push(preview);
      return new Promise<boolean>((resolve) => {
        answers.push(resolve);
      });
    };
    const first = env.c.createCompanion();
    const second = env.c.createCompanion();
    await settle();
    for (const answer of answers) answer(true);
    await Promise.all([first, second]);

    assert.equal(env.world.notes.confirmations.length, 1);
    assert.deepEqual(env.world.notes.notices, []);
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    assert.equal(env.world.notes.dailyText?.split(JANE_LINK).length, 2);
  });

  it('asks for the confirmation once per device', async () => {
    const env = await withCompanion();
    env.c.selectSection(BOARD);
    await env.c.createCompanion();
    assert.equal(env.state().meeting?.companionPath, '00 Inbox/Mtg-2026-10-09 — Steering Board.md');
    assert.equal(env.world.notes.confirmations.length, 1);
  });

  it('leaves the state alone when the note cannot be created', async () => {
    const env = await boot({ local: { firstWriteConfirmed: true } });
    env.world.notes.createCompanion = async () => {
      throw new Error('The disk is full.');
    };
    env.c.selectSection(JANE);
    const before = env.state().meeting;
    await env.c.createCompanion();
    assert.equal(env.state().meeting, before);
    assert.equal(env.world.notes.dailyText, DAILY);
    assert.deepEqual(env.world.notes.notices, ['The companion note could not be created. The disk is full.']);
    assert.equal(env.state().pendingWrites, 0);
  });

  it('adds a number to a name that is taken, in the path and in the link', async () => {
    const env = await boot({ files: { ...NOTES, [JANE_NOTE]: 'An unrelated note that took the name.\n' } });
    env.c.selectSection(JANE);
    await env.c.createCompanion();
    const path = '00 Inbox/Mtg-2026-10-09 — 1-1 Jane Example (2).md';
    assert.equal(env.state().meeting?.companionPath, path);
    assert.ok(env.world.notes.dailyText?.includes('↳ [[Mtg-2026-10-09 — 1-1 Jane Example (2)|Meeting notes]]'));
    assert.equal(env.world.notes.files.get(JANE_NOTE), 'An unrelated note that took the name.\n');

    // The link, not the title, now says which section the note belongs to.
    type(env, env.world.notes.dailyText ?? '', '- budget');
    assert.equal(env.state().shorthand.length, 4);
  });

  it('adds no line to the daily for a manual meeting', async () => {
    const env = await boot();
    env.c.newMeeting();
    await env.c.createCompanion();
    const path = '00 Inbox/Mtg-2026-10-09 — New meeting 14-05.md';
    assert.equal(env.state().meeting?.companionPath, path);
    assert.equal(env.world.notes.dailyText, DAILY);
    assert.equal(env.world.notes.confirmations[0].where, 'no line is added to the daily note');
    assert.equal(env.world.notes.confirmations[0].linkLine, '');
    const note = env.world.notes.files.get(path) ?? '';
    assert.match(note, /^attendees: \[\]$/m);
    assert.equal(readCompanionKeys(note).source, env.state().meeting?.key);
  });

  it('adds no line to the daily of another day', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    env.world.notes.date = '2026-10-10';
    env.session.handleDailyAvailability();
    await settle();
    const today = '### 1:1 [[Jane Example]]\n- a new day\n';
    type(env, today, null);

    await env.c.createCompanion();
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    assert.equal(env.world.notes.dailyText, today);
    assert.equal(env.world.notes.confirmations[0].linkLine, '');
    assert.equal(env.world.notes.confirmations[0].where, 'no line is added to the daily note');
    assert.deepEqual(env.world.notes.notices, [
      'The companion note was created, but its link could not be added to your daily note.',
    ]);
    const note = env.world.notes.files.get(JANE_NOTE) ?? '';
    assert.match(note, /^links: \["\[\[2026-10-09\]\]"\]$/m);
    assert.deepEqual(readCompanionKeys(note), { date: '2026-10-09', source: JANE });
  });

  it('describes the heading placement, and quotes the line written through the vault', async () => {
    const env = await boot({ settings: { dailyLinkPlacement: 'heading' } });
    env.world.notes.linkVia = 'vault';
    env.c.selectSection(JANE);
    await env.c.createCompanion();
    assert.equal(
      env.world.notes.confirmations[0].where,
      'directly under the heading “1:1 Jane Example” in 00 Inbox/2026-10-09.md',
    );
    assert.ok(env.world.notes.dailyText?.includes(`### 1:1 [[Jane Example]]\n${JANE_LINK}\n- Q4 roadmap`));
    assert.deepEqual(env.world.notes.notices, [`Added to your daily note: ${JANE_LINK}`]);
  });

  it('says so when the note was created but the link could not be added', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    // The section disappears from the file while the sidebar still shows it.
    env.world.notes.setDaily('### Something else\n');
    await env.c.createCompanion();
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    assert.ok(env.world.notes.files.has(JANE_NOTE));
    assert.equal(env.world.notes.notices.length, 1);
    assert.match(env.world.notes.notices[0], /link could not be added/);
  });

  it('saves what is already in memory', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.enhanceNow();
    await env.c.startRecording();
    env.world.sources[0].say('The cutover is planned for mid-November.', 2, 6);
    env.world.sources[0].say('If the renewal slips we keep the platform.', 8, 13, 'system');
    await until(env.world, env.c.stopRecording());
    await settle();
    assert.equal(env.state().summary.status, 'done');
    assert.equal(env.world.notes.writes.length, 0);

    await env.c.createCompanion();
    assert.ok(env.state().pendingWrites > 0);
    // Nothing touches the new note in its first second: Templater rewrites it.
    await pass(env.world, 900);
    assert.equal(env.world.notes.writes.length, 0);
    await pass(env.world, 5000);

    assert.equal(env.state().pendingWrites, 0);
    assert.equal(
      region(env, JANE_NOTE, 'enhanced'),
      [
        '- **Note:** Q4 roadmap: identity migration first',
        "- **Note:** budget: 2 postes gelés jusqu'en janvier",
        '',
        '#### Risks',
        '- **Note:** vendor contract renewal may slip to Nov',
        '',
      ].join('\n'),
    );
    assert.equal(
      region(env, JANE_NOTE, 'transcript'),
      [
        '> [!quote]- Transcript',
        '> **[00:02] Fred:** The cutover is planned for mid-November.',
        '> **[00:08] Others:** If the renewal slips we keep the platform.',
        '',
      ].join('\n'),
    );
    assert.match(region(env, JANE_NOTE, 'summary'), /^### Executive summary\n\n#### Overview\n/);
    assert.equal(region(env, JANE_NOTE, 'qa'), '');
  });
});

describe('saving to the companion', () => {
  it('leaves a new note alone for a second, even when asked to flush', async () => {
    const env = await boot({ local: { firstWriteConfirmed: true } });
    env.c.selectSection(JANE);
    await env.c.enhanceNow();
    await env.c.createCompanion();
    assert.equal(env.state().pendingWrites, 1);

    let flushed = false;
    void env.session.flushAll().then(() => {
      flushed = true;
    });
    await pass(env.world, 900, 300);
    assert.equal(env.world.notes.writes.length, 0, 'Templater may still be rewriting it');
    assert.equal(flushed, false);
    await pass(env.world, 200, 100);
    assert.equal(env.world.notes.writes.length, 1);
    assert.equal(flushed, true);
    assert.equal(env.state().pendingWrites, 0);
  });

  it('writes the enhanced notes after the idle delay', async () => {
    const env = await withCompanion();
    await env.c.enhanceNow();
    assert.equal(env.state().pendingWrites, 1);
    await pass(env.world, 4500);
    assert.equal(region(env, JANE_NOTE, 'enhanced'), '');
    await pass(env.world, 600);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /^- \*\*Note:\*\* Q4 roadmap: identity migration first$/m);
    assert.equal(env.state().pendingWrites, 0);

    // The same notes are not written twice.
    const writes = env.world.notes.writes.length;
    type(env, env.world.notes.dailyText ?? '', '- budget');
    await pass(env.world, 6000);
    assert.equal(env.world.notes.writes.length, writes);
  });

  it('never replaces saved notes with an empty region', async () => {
    const env = await withCompanion();
    await env.c.enhanceNow();
    await pass(env.world, 5500);
    const saved = region(env, JANE_NOTE, 'enhanced');
    assert.notEqual(saved, '');

    // Another session, another day of typing: only a topic is left, nothing enhanced.
    await env.c.endMeeting();
    type(env, (env.world.notes.dailyText ?? '').replace(/- (Q4|budget|vendor)[^\n]*\n/g, ''), '#### Risks');
    env.c.selectSection(JANE);
    assert.deepEqual(
      env.state().shorthand.map((item) => item.kind),
      ['topic'],
    );
    await env.c.enhanceNow();
    await pass(env.world, 6000);
    assert.equal(region(env, JANE_NOTE, 'enhanced'), saved);
  });

  it('never replaces saved notes with bullets the sanitizer leaves empty', async () => {
    const env = await withCompanion();
    await env.c.enhanceNow();
    await pass(env.world, 5500);
    const saved = region(env, JANE_NOTE, 'enhanced');
    assert.match(saved, /^- \*\*Note:\*\* /m);

    // A later visit: for every line the model answers a marker and nothing else.
    await env.c.endMeeting();
    env.world.llm.answer = (req) =>
      promptItems(req)
        .map((item) => `${item.n}. <!-- hamster:end enhanced -->`)
        .join('\n');
    env.c.selectSection(JANE);
    await settle();
    // The notes the companion holds are the lines' own by now: only a change of style, followed
    // by Enhance, has them all written again.
    assert.equal(env.world.llm.chats.length, 1);
    env.c.setEnhanceStyle('concise');
    await settle();
    const before = env.state().enhanced.filter((e) => e.kind === 'item').map((e) => e.bullet);
    await env.c.enhanceNow();
    // A bullet that holds nothing of its line is not taken: asked twice, then the lines keep the notes they had.
    assert.equal(env.world.llm.chats.length, 3, 'every line was asked for again, twice');
    assert.deepEqual(
      env.state().enhanced.filter((e) => e.kind === 'item').map((e) => e.bullet),
      before,
      'the lines keep the notes they had',
    );
    await pass(env.world, 6000);
    assert.equal(region(env, JANE_NOTE, 'enhanced'), saved);
    assert.equal(env.state().pendingWrites, 0);
    assert.deepEqual(env.state().meeting?.detachedRegions, []);
    assert.deepEqual(env.world.notes.notices, [], 'nothing was held back that could have been written');
  });

  it('appends every final turn to the transcript', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('First things first.', 1, 3);
    source.say('Agreed.', 4, 5, 'system');
    await pass(env.world, 5200);
    assert.equal(
      region(env, JANE_NOTE, 'transcript'),
      '> [!quote]- Transcript\n> **[00:01] Fred:** First things first.\n> **[00:04] Others:** Agreed.\n',
    );

    source.say('A third thing <!-- hamster:end transcript --> said aloud.', 70, 75);
    await pass(env.world, 5200);
    const lines = region(env, JANE_NOTE, 'transcript').trimEnd().split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[3], /^> \*\*\[01:10\] Fred:\*\* A third thing <-- hamster:end transcript --> said aloud\.$/);
  });

  it('tries again when the note was edited a moment ago', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    env.world.notes.recentlyEdited = true;
    env.world.sources[0].say('This has to wait for the editor.', 1, 3);
    await pass(env.world, 5200);
    assert.deepEqual(env.world.notes.writes.at(-1)?.outcome, { status: 'retry', afterMs: 500 });
    assert.equal(env.state().pendingWrites, 1);
    assert.doesNotMatch(region(env, JANE_NOTE, 'transcript'), /wait for the editor/);

    env.world.notes.recentlyEdited = false;
    await pass(env.world, 600);
    assert.match(region(env, JANE_NOTE, 'transcript'), /This has to wait for the editor\./);
    assert.equal(env.state().pendingWrites, 0);
    assert.deepEqual(env.state().meeting?.detachedRegions, []);
  });

  it('reports a damaged region and keeps saving the others', async () => {
    const env = await withCompanion();
    const note = env.world.notes.files.get(JANE_NOTE) ?? '';
    env.world.notes.files.set(JANE_NOTE, note.replace('<!-- hamster:end enhanced -->\n', ''));

    await env.c.enhanceNow();
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('Still being saved.', 1, 2);
    await pass(env.world, 5200);
    assert.deepEqual(env.state().meeting?.detachedRegions, ['enhanced']);
    assert.match(region(env, JANE_NOTE, 'transcript'), /Still being saved\./);

    // Nothing more is sent to the damaged region.
    const sent = env.world.notes.writes.length;
    type(env, (env.world.notes.dailyText ?? '').replace('#### Risks', '- one more line\n#### Risks'), '- one more');
    await env.c.enhanceNow();
    source.say('And this too.', 3, 4);
    await pass(env.world, 5200);
    const later = env.world.notes.writes.slice(sent).flatMap((write) => write.patches.map((p) => p.region));
    assert.deepEqual(later, ['transcript']);
    assert.match(region(env, JANE_NOTE, 'transcript'), /And this too\./);
    assert.deepEqual(env.state().meeting?.detachedRegions, ['enhanced']);

    // Asking again while the markers are still damaged changes nothing, and says why.
    await env.c.createCompanion();
    assert.deepEqual(env.state().meeting?.detachedRegions, ['enhanced']);
    assert.deepEqual(env.world.notes.notices, [
      'The companion note is still damaged (enhanced). Restore its markers, or delete the note and create it again.',
    ]);

    // The markers are repaired by hand: adopting the note again gives the region another chance.
    env.world.notes.files.set(
      JANE_NOTE,
      (env.world.notes.files.get(JANE_NOTE) ?? '').replace(
        '<!-- hamster:begin enhanced -->\n',
        '<!-- hamster:begin enhanced -->\n<!-- hamster:end enhanced -->\n',
      ),
    );
    await env.c.createCompanion();
    assert.deepEqual(env.state().meeting?.detachedRegions, []);
    await pass(env.world, 5200);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /^- \*\*Note:\*\* one more line$/m);
    // The transcript only grows: what was appended is not appended again.
    assert.equal(region(env, JANE_NOTE, 'transcript').match(/Still being saved\./g)?.length, 1);
    assert.deepEqual(env.state().meeting?.detachedRegions, []);
  });

  it('saves a summary only once it is complete', async () => {
    const env = await boot({ local: { firstWriteConfirmed: true } });
    env.c.selectSection(JANE);
    const release = env.world.llm.hold();
    const running = env.c.summarize('recap');
    await settle();
    assert.notEqual(env.state().summary.markdown, '');

    await env.c.createCompanion();
    await pass(env.world, 6500);
    assert.equal(region(env, JANE_NOTE, 'summary'), '');

    release();
    await running;
    await pass(env.world, 5500);
    assert.match(region(env, JANE_NOTE, 'summary'), /^### Recap\n\n#### Overview\n/);
  });

  it('does not blame the current meeting for the damaged note of the one before', async () => {
    const env = await withCompanion();
    await env.c.enhanceNow();
    assert.equal(env.state().pendingWrites, 1);
    const note = env.world.notes.files.get(JANE_NOTE) ?? '';
    env.world.notes.files.set(JANE_NOTE, note.replace('<!-- hamster:end enhanced -->\n', ''));

    env.c.selectSection(BOARD);
    await env.c.createCompanion();
    await pass(env.world, 6500);
    assert.deepEqual(env.world.notes.writes.at(-1)?.outcome, { status: 'detached', regions: ['enhanced'] });
    assert.equal(env.state().meeting?.key, BOARD);
    assert.deepEqual(env.state().meeting?.detachedRegions, []);
  });

  it('reports every damaged region of a batch', async () => {
    const env = await withCompanion();
    const note = env.world.notes.files.get(JANE_NOTE) ?? '';
    env.world.notes.files.set(
      JANE_NOTE,
      note.replace('<!-- hamster:end enhanced -->\n', '').replace('<!-- hamster:begin summary -->\n', ''),
    );
    await env.c.enhanceNow();
    await env.c.summarize('recap');
    await env.c.startRecording();
    env.world.sources[0].say('Saved all the same.', 1, 2);
    await pass(env.world, 5200);

    assert.deepEqual(env.world.notes.writes.at(-1)?.outcome, { status: 'detached', regions: ['enhanced', 'summary'] });
    assert.deepEqual(env.state().meeting?.detachedRegions, ['enhanced', 'summary']);
    assert.match(region(env, JANE_NOTE, 'transcript'), /Saved all the same\./);
  });

  it('saves again to each region whose markers are found repaired, and to those only', async () => {
    const env = await withCompanion();
    const whole = env.world.notes.files.get(JANE_NOTE) ?? '';
    const noEnhanced = (note: string): string => note.replace('<!-- hamster:end enhanced -->\n', '');
    const noSummary = (note: string): string => note.replace('<!-- hamster:begin summary -->\n', '');
    env.world.notes.files.set(JANE_NOTE, noSummary(noEnhanced(whole)));

    await env.c.enhanceNow();
    await env.c.summarize('recap');
    await pass(env.world, 5200);
    assert.deepEqual(env.state().meeting?.detachedRegions, ['enhanced', 'summary']);

    // One pair of markers is put back by hand. Nothing changes until the note is looked at again.
    env.world.notes.files.set(JANE_NOTE, noSummary(whole));
    type(env, (env.world.notes.dailyText ?? '').replace('#### Risks', '- one more line\n#### Risks'), '- one more');
    await env.c.enhanceNow();
    await pass(env.world, 5200);
    assert.deepEqual(env.state().meeting?.detachedRegions, ['enhanced', 'summary']);
    assert.equal(region(env, JANE_NOTE, 'enhanced'), '');

    const sent = env.world.notes.writes.length;
    await env.c.createCompanion();
    assert.deepEqual(env.state().meeting?.detachedRegions, ['summary'], 'the repaired region is no longer set aside');
    assert.deepEqual(env.world.notes.notices, [
      'The companion note is still damaged (summary). Restore its markers, or delete the note and create it again.',
    ]);
    await pass(env.world, 5200);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /^- \*\*Note:\*\* one more line$/m);
    const regions = env.world.notes.writes.slice(sent).flatMap((write) => write.patches.map((patch) => patch.region));
    assert.deepEqual(regions, ['enhanced'], 'nothing is sent to the region that is still damaged');

    // The other pair is repaired too: everything is saved again, and there is nothing left to say.
    env.world.notes.files.set(JANE_NOTE, (env.world.notes.files.get(JANE_NOTE) ?? '').replace(
      '## AI summary\n',
      '## AI summary\n<!-- hamster:begin summary -->\n',
    ));
    await env.c.createCompanion();
    assert.deepEqual(env.state().meeting?.detachedRegions, []);
    await pass(env.world, 5200);
    assert.match(region(env, JANE_NOTE, 'summary'), /^### Recap\n\n#### Overview\n/);
    assert.equal(env.world.notes.notices.length, 1);
  });

  it('keeps a region set aside when the note cannot be read to check it', async () => {
    const env = await withCompanion();
    const whole = env.world.notes.files.get(JANE_NOTE) ?? '';
    env.world.notes.files.set(JANE_NOTE, whole.replace('<!-- hamster:end enhanced -->\n', ''));
    await env.c.enhanceNow();
    await pass(env.world, 5200);
    assert.deepEqual(env.state().meeting?.detachedRegions, ['enhanced']);

    const read = env.world.notes.readCompanion.bind(env.world.notes);
    env.world.notes.readCompanion = async () => {
      throw new Error('The file is locked.');
    };
    const before = env.state().meeting;
    await env.c.createCompanion();
    assert.equal(env.state().meeting, before, 'nothing was learned: nothing changes');
    assert.deepEqual(env.world.notes.notices, []);

    // Readable again, and still damaged: now it can be said.
    env.world.notes.readCompanion = read;
    await env.c.createCompanion();
    assert.deepEqual(env.state().meeting?.detachedRegions, ['enhanced']);
    assert.equal(env.world.notes.notices.length, 1);
  });

  it('forgets a companion as soon as the vault reports it deleted, in the index too', async () => {
    const env = await withCompanion({ index: true });
    await env.c.enhanceNow();
    await pass(env.world, 5500);
    await env.c.endMeeting();
    await env.c.buildIndex(['00 Inbox', '10 Work']);
    assert.equal(env.state().index.files, 4);
    env.c.selectSection(JANE);
    await settle();
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);

    env.world.notes.files.delete(JANE_NOTE);
    env.session.handleVaultChange({ type: 'delete', path: JANE_NOTE });
    await settle();
    assert.equal(env.state().meeting?.companionPath, null);
    assert.equal(env.state().sections.find((s) => s.key === JANE)?.companionPath, null);
    assert.deepEqual(env.world.notes.notices, [
      'The companion note is no longer there. Create it again to keep saving.',
    ]);
    assert.equal(env.state().index.files, 3);

    await env.c.endMeeting();
    await pass(env.world, 3000);
    assert.equal(env.state().index.files, 3);
    assert.equal(env.state().index.error, null);
  });

  it('takes a note that vanished without a word out of the index when the meeting is left', async () => {
    const env = await withCompanion({ index: true });
    await env.c.endMeeting();
    await env.c.buildIndex(['00 Inbox', '10 Work']);
    env.c.selectSection(JANE);
    await settle();
    const reads = env.world.indexIO?.reads.length;

    env.world.notes.files.delete(JANE_NOTE);
    await env.c.endMeeting();
    await pass(env.world, 3000);
    assert.equal(env.state().index.files, 3);
    assert.equal(env.state().index.error, null);
    assert.equal(env.world.indexIO?.reads.length, reads, 'a note that is gone is not read');
  });

  it('forgets a companion that was deleted, and says so once', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('Before the note went away.', 1, 2);
    await pass(env.world, 5200);

    env.world.notes.files.delete(JANE_NOTE);
    source.say('After it went away.', 3, 4);
    await pass(env.world, 5200);
    assert.equal(env.state().meeting?.companionPath, null);
    assert.deepEqual(env.state().meeting?.detachedRegions, []);
    assert.deepEqual(env.world.notes.notices, [
      'The companion note is no longer there. Create it again to keep saving.',
    ]);

    source.say('Nowhere to save this yet.', 5, 6);
    await pass(env.world, 5200);
    assert.equal(env.world.notes.notices.length, 1);
    assert.equal(env.state().pendingWrites, 0);

    // Created again, it receives the whole transcript.
    await env.c.createCompanion();
    await pass(env.world, 6200);
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    assert.equal(
      region(env, JANE_NOTE, 'transcript'),
      [
        '> [!quote]- Transcript',
        '> **[00:01] Fred:** Before the note went away.',
        '> **[00:03] Fred:** After it went away.',
        '> **[00:05] Fred:** Nowhere to save this yet.',
        '',
      ].join('\n'),
    );
    // The link line was already in the daily: it is not added a second time.
    assert.equal(env.world.notes.dailyText?.split(JANE_LINK).length, 2);
  });

  it('writes no line twice when a deleted note is created again before the queue found out', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('On disk before the note was deleted.', 1, 2);
    await pass(env.world, 5200);
    source.say('Still in the queue.', 3, 4);

    env.world.notes.files.delete(JANE_NOTE);
    env.c.openCompanion();
    assert.equal(env.state().meeting?.companionPath, null);
    await until(env.world, env.c.createCompanion());
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    await pass(env.world, 6200);
    assert.equal(
      region(env, JANE_NOTE, 'transcript'),
      [
        '> [!quote]- Transcript',
        '> **[00:01] Fred:** On disk before the note was deleted.',
        '> **[00:03] Fred:** Still in the queue.',
        '',
      ].join('\n'),
    );
    assert.equal(env.world.notes.notices.length, 1);
  });

  it('sends each turn once when a note moved behind its back is adopted again', async () => {
    const env = await withCompanion();
    const moved = '10 Work/Meetings/Jane.md';
    await env.c.ask('What was kept before the move?');
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('Written before the move.', 1, 2);
    await pass(env.world, 5200);
    assert.equal(region(env, JANE_NOTE, 'qa').match(/^### /gm)?.length, 1);

    // Moved outside Obsidian: no rename is reported, the note is just gone from its path.
    env.world.notes.files.set(moved, env.world.notes.files.get(JANE_NOTE) ?? '');
    env.world.notes.files.delete(JANE_NOTE);
    source.say('Lost with the batch that found no note.', 3, 4);
    await pass(env.world, 5200);
    assert.equal(env.state().meeting?.companionPath, null);
    source.say('Said while there was no note.', 5, 6);

    // The frontmatter still says whose note it is.
    await env.c.createCompanion();
    assert.equal(env.state().meeting?.companionPath, moved);
    await pass(env.world, 5200);
    assert.equal(
      region(env, moved, 'transcript'),
      [
        '> [!quote]- Transcript',
        '> **[00:01] Fred:** Written before the move.',
        '> **[00:03] Fred:** Lost with the batch that found no note.',
        '> **[00:05] Fred:** Said while there was no note.',
        '',
      ].join('\n'),
    );
    assert.equal(env.world.notes.files.has(JANE_NOTE), false);

    // The insight the note already holds is this session's own: it is not added a second time.
    await env.c.ask('And what is kept after it?');
    await env.c.keepInsight(env.state().qa.entries[1].id);
    await pass(env.world, 5200);
    assert.equal(region(env, moved, 'qa').match(/^### /gm)?.length, 2);
  });

  it('follows a companion that is renamed in the vault', async () => {
    const env = await withCompanion();
    const moved = '10 Work/Meetings/Mtg-2026-10-09 — 1-1 Jane Example.md';
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('Written before the move.', 1, 2);
    await pass(env.world, 5200);
    source.say('Still in the queue when the note moved.', 3, 4);

    env.world.notes.files.set(moved, env.world.notes.files.get(JANE_NOTE) ?? '');
    env.world.notes.files.delete(JANE_NOTE);
    env.session.handleVaultChange({ type: 'rename', path: moved, oldPath: JANE_NOTE });
    assert.equal(env.state().meeting?.companionPath, moved);
    assert.equal(env.state().sections.find((s) => s.key === JANE)?.companionPath, moved);

    await pass(env.world, 5200);
    source.say('Written after the move.', 5, 6);
    await pass(env.world, 5200);
    assert.equal(
      region(env, moved, 'transcript'),
      [
        '> [!quote]- Transcript',
        '> **[00:01] Fred:** Written before the move.',
        '> **[00:03] Fred:** Still in the queue when the note moved.',
        '> **[00:05] Fred:** Written after the move.',
        '',
      ].join('\n'),
    );
    assert.deepEqual(env.world.notes.notices, []);
    assert.equal(env.state().pendingWrites, 0);
    // The link in the daily still leads to it: the meeting keeps its section.
    assert.equal(env.state().shorthand.length, 4);
  });

  it('writes each line once when the note is renamed while a batch is being written', async () => {
    const env = await withCompanion();
    const moved = '10 Work/Meetings/Mtg-2026-10-09 — 1-1 Jane Example.md';
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('Written before the move.', 1, 2);
    await pass(env.world, 5200);

    /* The rename lands while the host is reading the note for the batch. Obsidian's TFile
       follows it, and the host answers `missing` rather than write into the renamed note
       (textTarget.ts): the session, told of the rename, sends the batch again under the new
       path, from the last line known to be in the note. */
    const write = env.world.notes.writeCompanion.bind(env.world.notes);
    let caught = 0;
    env.world.notes.writeCompanion = async (path, patches) => {
      if (path !== JANE_NOTE) return write(path, patches);
      caught += 1;
      env.world.notes.writeCompanion = write;
      env.world.notes.files.set(moved, env.world.notes.files.get(JANE_NOTE) ?? '');
      env.world.notes.files.delete(JANE_NOTE);
      env.session.handleVaultChange({ type: 'rename', path: moved, oldPath: JANE_NOTE });
      return { status: 'missing' };
    };
    source.say('In the batch the rename caught.', 3, 4);
    await pass(env.world, 5200);
    assert.equal(caught, 1, 'the batch was in flight when the note moved');
    assert.equal(env.state().meeting?.companionPath, moved);
    source.say('Written after the move.', 5, 6);
    await pass(env.world, 5200);
    assert.deepEqual(region(env, moved, 'transcript').trimEnd().split('\n').slice(1), [
      '> **[00:01] Fred:** Written before the move.',
      '> **[00:03] Fred:** In the batch the rename caught.',
      '> **[00:05] Fred:** Written after the move.',
    ]);
    assert.deepEqual(env.world.notes.notices, []);
    assert.equal(env.state().pendingWrites, 0);
    // Nothing is left to send a second time, at the stop or when the note is adopted again.
    await until(env.world, env.c.stopRecording());
    await env.c.createCompanion();
    await pass(env.world, 5200);
    assert.equal(region(env, moved, 'transcript').match(/the rename caught/g)?.length, 1);
  });

  it('sends again the transcript lines a damaged region refused', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('Written while the note was whole.', 1, 2);
    await pass(env.world, 5200);

    const written = env.world.notes.files.get(JANE_NOTE) ?? '';
    env.world.notes.files.set(JANE_NOTE, written.replace('<!-- hamster:end transcript -->\n', ''));
    source.say('Refused by the damaged region.', 3, 4);
    await pass(env.world, 5200);
    assert.deepEqual(env.state().meeting?.detachedRegions, ['transcript']);
    source.say('Not even sent.', 5, 6);
    await pass(env.world, 5200);
    assert.equal(env.world.notes.writes.at(-1)?.patches.length, 1);

    env.world.notes.files.set(JANE_NOTE, written);
    await env.c.createCompanion();
    await pass(env.world, 5200);
    assert.deepEqual(env.state().meeting?.detachedRegions, []);
    assert.equal(
      region(env, JANE_NOTE, 'transcript'),
      [
        '> [!quote]- Transcript',
        '> **[00:01] Fred:** Written while the note was whole.',
        '> **[00:03] Fred:** Refused by the damaged region.',
        '> **[00:05] Fred:** Not even sent.',
        '',
      ].join('\n'),
    );
  });

  it('tries a write that failed twice more, then says once that the note could not be saved', async () => {
    const env = await withCompanion();
    let attempts = 0;
    env.world.notes.writeCompanion = async () => {
      attempts += 1;
      throw new Error('The vault is read-only.');
    };
    await env.c.startRecording();
    env.world.sources[0].say('One.', 1, 2);
    // After the idle delay, then two seconds apart: nothing is said while there is a try left.
    await pass(env.world, 5000 + 2000 + 1900, 100);
    assert.equal(attempts, 2);
    assert.deepEqual(env.world.notes.notices, []);
    assert.equal(env.state().pendingWrites, 1);
    await pass(env.world, 200, 100);
    assert.equal(attempts, 3);
    assert.deepEqual(env.world.notes.notices, ['The companion note could not be saved. The vault is read-only.']);
    assert.equal(env.state().pendingWrites, 0);

    env.world.sources[0].say('Two.', 3, 4);
    await pass(env.world, 9200, 100);
    assert.equal(attempts, 6);
    assert.equal(env.world.notes.notices.length, 1);
  });

  it('writes each line once when a write fails and the next try goes through', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('Written before the trouble.', 1, 2);
    await pass(env.world, 5200);

    const write = env.world.notes.writeCompanion.bind(env.world.notes);
    let failures = 0;
    env.world.notes.writeCompanion = async (path, patches) => {
      if (failures === 0) {
        failures += 1;
        throw new Error('The file is locked.');
      }
      return write(path, patches);
    };
    source.say('In the write that failed.', 3, 4);
    await pass(env.world, 5200, 100);
    assert.equal(failures, 1);
    assert.doesNotMatch(region(env, JANE_NOTE, 'transcript'), /In the write that failed/);
    assert.equal(env.state().pendingWrites, 1, 'the queue still has it');

    // While the queue waits to try again, the note is adopted anew and more is said:
    // the session hands over the new line only.
    await env.c.createCompanion();
    source.say('Said while the queue waited.', 5, 6);
    await pass(env.world, 2000, 100);
    source.say('Written after it.', 7, 8);
    await pass(env.world, 5200);

    const spoken = (): string[] => region(env, JANE_NOTE, 'transcript').trimEnd().split('\n').slice(1);
    const whole = [
      '> **[00:01] Fred:** Written before the trouble.',
      '> **[00:03] Fred:** In the write that failed.',
      '> **[00:05] Fred:** Said while the queue waited.',
      '> **[00:07] Fred:** Written after it.',
    ];
    assert.equal(spoken().length, 4, 'four turns, four lines');
    assert.deepEqual(spoken(), whole);
    assert.deepEqual(env.world.notes.notices, [], 'a write that went through on its second try is not an error');

    // Neither adopting the note again nor the stop finds anything to send a second time.
    await env.c.createCompanion();
    await pass(env.world, 5200);
    assert.deepEqual(spoken(), whole);
    assert.equal(env.state().pendingWrites, 0);
    await until(env.world, env.c.stopRecording());
    assert.deepEqual(spoken(), whole);
  });

  it('sends the lines of a write that was given up again with the next ones, each once', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('Written before the trouble.', 1, 2);
    await pass(env.world, 5200);

    const write = env.world.notes.writeCompanion.bind(env.world.notes);
    env.world.notes.writeCompanion = async () => {
      throw new Error('The file is locked.');
    };
    source.say('Dropped with the write that failed.', 3, 4);
    // Three tries: the idle delay, then two seconds apart.
    await pass(env.world, 9200, 100);
    assert.deepEqual(env.world.notes.notices, ['The companion note could not be saved. The file is locked.']);
    assert.equal(env.state().pendingWrites, 0);

    env.world.notes.writeCompanion = write;
    source.say('Written after it.', 5, 6);
    await pass(env.world, 5200);
    const whole = [
      '> [!quote]- Transcript',
      '> **[00:01] Fred:** Written before the trouble.',
      '> **[00:03] Fred:** Dropped with the write that failed.',
      '> **[00:05] Fred:** Written after it.',
      '',
    ].join('\n');
    assert.equal(region(env, JANE_NOTE, 'transcript'), whole);

    // Adopting the note again finds nothing to send a second time.
    await env.c.createCompanion();
    await pass(env.world, 5200);
    assert.equal(region(env, JANE_NOTE, 'transcript'), whole);
    assert.equal(env.state().pendingWrites, 0);
  });

  it('waits at the stop for the next try of a write that failed', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    const write = env.world.notes.writeCompanion.bind(env.world.notes);
    env.world.notes.writeCompanion = async () => {
      throw new Error('The file is locked.');
    };
    env.world.sources[0].say('The last words of the meeting.', 1, 2);
    await pass(env.world, 5200);
    assert.doesNotMatch(region(env, JANE_NOTE, 'transcript'), /The last words/);

    env.world.notes.writeCompanion = write;
    await until(env.world, env.c.stopRecording());
    assert.equal(
      region(env, JANE_NOTE, 'transcript'),
      '> [!quote]- Transcript\n> **[00:01] Fred:** The last words of the meeting.\n',
    );
    assert.deepEqual(env.world.notes.notices, []);
  });

  it('tries once more at the stop for the last lines a write gave up', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    const write = env.world.notes.writeCompanion.bind(env.world.notes);
    env.world.notes.writeCompanion = async () => {
      throw new Error('The file is locked.');
    };
    env.world.sources[0].say('The last words of the meeting.', 1, 2);
    await pass(env.world, 9200, 100);
    assert.equal(env.world.notes.notices.length, 1, 'given up after three tries');
    assert.doesNotMatch(region(env, JANE_NOTE, 'transcript'), /The last words/);

    env.world.notes.writeCompanion = write;
    await until(env.world, env.c.stopRecording());
    assert.equal(
      region(env, JANE_NOTE, 'transcript'),
      '> [!quote]- Transcript\n> **[00:01] Fred:** The last words of the meeting.\n',
    );
  });

  it('tries once more for them when the meeting ends', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('Said while the note was whole.', 1, 2);
    await until(env.world, env.c.stopRecording());
    await settle();
    await env.c.startRecording();

    const write = env.world.notes.writeCompanion.bind(env.world.notes);
    env.world.notes.writeCompanion = async () => {
      throw new Error('The file is locked.');
    };
    env.world.sources[1].say('Said while the file was locked.', 1, 2);
    // The stop tries too, within its three seconds, and fails like the write before it.
    await until(env.world, env.c.stopRecording());
    await settle();
    env.c.cancelSummary();
    // The third try, which the stop did not wait for, gives the lines up.
    await pass(env.world, 1500, 100);
    assert.deepEqual(env.world.notes.notices, ['The companion note could not be saved. The file is locked.']);
    assert.doesNotMatch(region(env, JANE_NOTE, 'transcript'), /the file was locked/);

    env.world.notes.writeCompanion = write;
    await until(env.world, env.c.endMeeting());
    const lines = region(env, JANE_NOTE, 'transcript').trimEnd().split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[2], /^> \*\*— recording resumed at \d\d:\d\d —\*\*$/);
    assert.match(lines[3], /Said while the file was locked\.$/);
  });

  it('waits at the end of the meeting for the third try of a write that failed', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    const write = env.world.notes.writeCompanion.bind(env.world.notes);
    let failures = 0;
    env.world.notes.writeCompanion = async (path, patches) => {
      // Locked for the two tries the stop waits for, free for the third, which End waits for.
      if (failures < 2) {
        failures += 1;
        throw new Error('The file is locked.');
      }
      return write(path, patches);
    };
    env.world.sources[0].say('Said just before the meeting ended.', 1, 2);
    await until(env.world, env.c.endMeeting());
    assert.equal(env.state().meeting, null);
    assert.equal(failures, 2);
    assert.equal(
      region(env, JANE_NOTE, 'transcript'),
      '> [!quote]- Transcript\n> **[00:01] Fred:** Said just before the meeting ended.\n',
    );
    assert.deepEqual(env.world.notes.notices, []);
  });

  it('waits at the end of the meeting for a write to be given up, and says so', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    let attempts = 0;
    env.world.notes.writeCompanion = async () => {
      attempts += 1;
      throw new Error('The vault is read-only.');
    };
    env.world.sources[0].say('The last words of the meeting.', 1, 2);
    const asked = env.world.clock.now();
    await until(env.world, env.c.endMeeting());
    // The stop waited for two tries; End waited for the third, which gave the batch up and said so
    // while the meeting was still there to send it once more.
    assert.equal(attempts, 3);
    assert.ok(env.world.clock.now() - asked >= 4000);
    assert.equal(env.state().meeting, null);
    assert.deepEqual(env.world.notes.notices, ['The companion note could not be saved. The vault is read-only.']);

    // That last try comes after End, and is given up in its turn: its meeting is gone, so the
    // user at least hears which note to look at.
    await pass(env.world, 12_000, 100);
    assert.equal(attempts, 6);
    assert.deepEqual(env.world.notes.notices, [
      'The companion note could not be saved. The vault is read-only.',
      'The last lines could not be saved to Mtg-2026-10-09 — 1-1 Jane Example.',
    ]);
    // Once: nothing sends them again.
    await pass(env.world, 60_000, 1000);
    assert.equal(attempts, 6);
    assert.equal(env.world.notes.notices.length, 2);
  });

  it('names the note the last lines could not be saved to when another meeting was selected meanwhile', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    let attempts = 0;
    env.world.notes.writeCompanion = async () => {
      attempts += 1;
      throw new Error('The vault is read-only.');
    };
    env.world.sources[0].say('The last words of the meeting.', 1, 2);
    // The stop waits for two tries; the third comes once the user has moved on.
    await until(env.world, env.c.stopRecording());
    assert.equal(attempts, 2);
    env.c.selectSection(BOARD);
    assert.equal(env.state().meeting?.key, BOARD);
    assert.deepEqual(env.world.notes.notices, []);

    await pass(env.world, 2000, 100);
    assert.equal(attempts, 3);
    assert.deepEqual(env.world.notes.notices, ['The last lines could not be saved to Mtg-2026-10-09 — 1-1 Jane Example.']);
    await pass(env.world, 60_000, 1000);
    assert.equal(attempts, 3);
    assert.equal(env.world.notes.notices.length, 1);
  });

  it('uses the label of the microphone channel from settings', async () => {
    const env = await withCompanion({ settings: { micLabel: 'Mic (room)' } });
    await env.c.startRecording();
    env.world.sources[0].say('Everyone talks into this one.', 1, 2);
    await pass(env.world, 5200);
    assert.match(region(env, JANE_NOTE, 'transcript'), /\*\*\[00:01\] Mic \(room\):\*\*/);
  });
});

describe('generated text', () => {
  const NASTY_BULLETS = [
    '1. **Roadmap:** Q4 roadmap, see [[Identity Plan|the plan]] first',
    '<!-- hamster:end enhanced -->',
    "2. **Budget:** 2 postes gelés jusqu'en janvier, ask [[Jane Example]]",
    '3. **Vendor:** the renewal may slip to Nov',
  ].join('\n');
  const NASTY_SUMMARY = [
    '# Overview',
    'See [[Budget 2026]] for the figures.',
    '<!-- hamster:end enhanced -->',
    '- [ ] call the vendor',
    '- [x] book the room <!-- hamster:begin qa -->',
  ].join('\n');
  const NASTY_ANSWER = 'Ask [[Jane Example]]. <!-- hamster:end qa --> [1]\n\n# Next steps\nNone yet.';

  it('is sanitized before it is saved', async () => {
    const env = await withCompanion();
    env.world.llm.answer = (req) => {
      if (promptItems(req).length > 0) return NASTY_BULLETS;
      return isQuestion(req) ? NASTY_ANSWER : NASTY_SUMMARY;
    };

    await env.c.enhanceNow();
    await env.c.summarize('executive');
    await env.c.ask('Who knows about the budget?');
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await pass(env.world, 5500);

    const note = env.world.notes.files.get(JANE_NOTE) ?? '';
    assert.equal(note.match(/<!--\s*hamster:/g)?.length, 8, 'four intact marker pairs and nothing else');
    for (const name of REGIONS) {
      const content = region(env, JANE_NOTE, name);
      assert.doesNotMatch(content, /\[\[/, `no wikilink in ${name}`);
      assert.doesNotMatch(content, /- \[.\]/, `no checkbox in ${name}`);
      assert.doesNotMatch(content, /hamster:/, `no marker text in ${name}`);
      // The note's own sections are level 2: nothing generated may sit at their level or above.
      assert.doesNotMatch(content, /^#{1,2} /m, `no heading above level 3 in ${name}`);
    }
    assert.deepEqual(env.state().meeting?.detachedRegions, []);
    assert.match(region(env, JANE_NOTE, 'qa'), /^### Next steps$/m);

    assert.match(region(env, JANE_NOTE, 'enhanced'), /^- \*\*Roadmap:\*\* Q4 roadmap, see the plan first$/m);
    assert.equal(
      region(env, JANE_NOTE, 'summary'),
      '### Executive summary\n\n#### Overview\nSee Budget 2026 for the figures.\n- call the vendor\n- book the room\n',
    );
    assert.match(region(env, JANE_NOTE, 'qa'), /^### 14:05 — Who knows about the budget\?\n\nAsk Jane Example\./);
  });

  it('saves a summary one level under the heading of its style, and shows it as before', async () => {
    const env = await withCompanion();
    const written = ['# Title', 'Text.', '## Decisions', '- one', '### Risks', '- two', '#### Detail', '##### Deeper'].join('\n');
    env.world.llm.answer = () => written;
    await env.c.summarize('recap');
    await pass(env.world, 5500);
    // The sidebar shows the summary as before: its sections at level 3, with no heading above them.
    assert.equal(
      env.state().summary.markdown,
      ['### Title', 'Text.', '### Decisions', '- one', '### Risks', '- two', '#### Detail', '##### Deeper'].join('\n'),
    );
    assert.equal(
      region(env, JANE_NOTE, 'summary'),
      [
        '### Recap',
        '',
        '#### Title',
        'Text.',
        '#### Decisions',
        '- one',
        '#### Risks',
        '- two',
        '#### Detail',
        '##### Deeper',
        '',
      ].join('\n'),
    );
  });

  /* With Dataview's JavaScript queries on, a ```dataviewjs block and inline code that opens with
     `$=` run wherever Obsidian renders them: in the sidebar as the text streams in, and in the
     companion every time it is opened. */
  const SCRIPT_BLOCK = ['```dataviewjs', "dv.paragraph(require('child_process').execSync('id'))", '```'].join('\n');
  const scripted = (req: ChatRequest): string => {
    const items = promptItems(req);
    if (items.length > 0) return items.map((item) => `${item.n}. **Count:** ${item.text} \`$= dv.pages().length\` notes`).join('\n');
    return isQuestion(req) ? `It is so [1].\n\n${SCRIPT_BLOCK}` : `### Overview\nDone.\n\n${SCRIPT_BLOCK}`;
  };

  it('carries no code another plugin would run, in the sidebar or in the companion', async () => {
    const env = await withCompanion({ settings: { linkEntitiesInCompanion: true, actionItemsAsTasks: true } });
    env.world.llm.answer = scripted;
    await env.c.enhanceNow();
    await env.c.summarize('executive');
    await env.c.ask('Is it so?');
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await pass(env.world, 5500);

    const state = env.state();
    const shown = [
      state.summary.markdown,
      state.qa.entries[0].answer,
      ...state.enhanced.map((item) => item.bullet ?? ''),
    ];
    for (const text of shown) {
      assert.doesNotMatch(text, /dataviewjs/);
      assert.doesNotMatch(text, /`\s*\$=/);
    }
    assert.equal(state.summary.markdown, "### Overview\nDone.\n\n```\ndv.paragraph(require('child_process').execSync('id'))\n```");
    assert.equal(state.enhanced[0].bullet, '**Count:** Q4 roadmap: identity migration first `\\$= dv.pages().length` notes');
    assert.deepEqual(state.qa.entries[0].sources.map((source) => source.n), [1], 'the answer still cites its source');

    for (const name of ['enhanced', 'summary', 'qa'] as const) {
      const content = region(env, JANE_NOTE, name);
      assert.doesNotMatch(content, /dataviewjs/, name);
      assert.doesNotMatch(content, /`\s*\$=/, name);
      assert.match(content, /dv\./, `the text itself is kept in ${name}`);
    }
  });

  it('carries none while the text is still arriving', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    sayTwoPiecesAndWait(env.world, 'Here it is.\n\n```dataviewjs\n', 'dv.paragraph(1)\n');
    void env.c.summarize('executive');
    await pass(env.world, 300, 100);
    assert.equal(env.state().summary.markdown, 'Here it is.\n\n```\ndv.paragraph(1)');
    // Cancelled, it keeps the text that had arrived, as it was shown.
    env.c.cancelSummary();
    assert.equal(env.state().summary.markdown, 'Here it is.\n\n```\ndv.paragraph(1)');

    void env.c.ask('And then?');
    await pass(env.world, 300, 100);
    assert.equal(env.state().qa.entries[0].answer, 'Here it is.\n\n```\ndv.paragraph(1)');
    env.c.cancelAsk(env.state().qa.entries[0].id);
    assert.equal(env.state().qa.entries[0].answer, 'Here it is.\n\n```\ndv.paragraph(1)');
  });

  it('keeps wikilinks and tasks when the settings ask for them', async () => {
    const env = await withCompanion({ settings: { linkEntitiesInCompanion: true, actionItemsAsTasks: true } });
    env.world.llm.answer = () => NASTY_SUMMARY;
    await env.c.summarize('recap');
    await pass(env.world, 5500);
    const summary = region(env, JANE_NOTE, 'summary');
    assert.match(summary, /^### Recap\n\n#### Overview\nSee \[\[Budget 2026\]\] for the figures\.$/m);
    assert.match(summary, /^- \[ \] call the vendor$/m);
    assert.doesNotMatch(summary, /hamster:/);
  });
});

describe('recording', () => {
  it('goes back to idle with a message when the source cannot start', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    env.world.prepareSource = (source) => {
      source.startError = new Error('The microphone is not available.');
    };
    const before = env.state();
    await env.c.startRecording();
    const state = env.state();
    assert.equal(state.recording, 'idle');
    assert.equal(state.recordingError, 'The microphone is not available.');
    assert.equal(state.stt, 'failed');
    assert.equal(state.sttMessage, 'The microphone is not available.');
    assert.equal(state.meeting, before.meeting);
    assert.equal(state.stats, before.stats);
    assert.equal(state.elapsedMs, 0);
    assert.equal(env.world.sources[0].listeners(), 0);
    assert.equal(env.world.clock.pending(), 0);
    // Said as well as shown, and once: the source reported `failed` and then failed its start.
    assert.deepEqual(env.world.notes.notices, ['The microphone is not available.']);

    // The next try works, and clears the message.
    env.world.prepareSource = null;
    await env.c.startRecording();
    assert.equal(env.state().recording, 'recording');
    assert.equal(env.state().recordingError, null);
    assert.equal(env.state().stt, 'running');
    assert.equal(env.state().sttMessage, null);
    assert.equal(env.world.notes.notices.length, 1);
  });

  it('says a failed start in a notice, wherever it failed: the sidebar may not be in view', async () => {
    // No source at all.
    const none = await boot();
    none.c.selectSection(JANE);
    none.world.deps.createTranscriptSource = () => {
      throw new Error('Transcription cannot be started on this Mac.');
    };
    await none.c.startRecording();
    assert.equal(none.state().recording, 'idle');
    assert.equal(none.state().recordingError, 'Transcription cannot be started on this Mac.');
    assert.deepEqual(none.world.notes.notices, ['Transcription cannot be started on this Mac.']);
    assert.equal(none.world.clock.pending(), 0);

    // A source that fails without a word of its own: the notice says what the banner says.
    const mute = await boot();
    mute.c.selectSection(JANE);
    mute.world.prepareSource = (source) => {
      source.start = () => Promise.reject(new Error('  '));
    };
    await mute.c.startRecording();
    assert.equal(mute.state().recording, 'idle');
    assert.deepEqual(mute.world.notes.notices, [mute.state().recordingError]);
    assert.equal(mute.state().recordingError, 'Something went wrong.');

    // Each failed start is said: the second try may fail for another reason.
    const twice = await boot();
    twice.c.selectSection(JANE);
    twice.world.prepareSource = (source) => {
      source.startError = new Error('The microphone is not available.');
    };
    await twice.c.startRecording();
    twice.world.prepareSource = (source) => {
      source.startError = new Error('The microphone is in use by another application.');
    };
    await twice.c.startRecording();
    assert.deepEqual(twice.world.notes.notices, [
      'The microphone is not available.',
      'The microphone is in use by another application.',
    ]);
  });

  it('goes back to idle when the source cannot even be listened to', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    env.world.prepareSource = (source) => {
      source.onState = () => {
        throw new Error('The speech worker is not available.');
      };
    };
    await env.c.startRecording();
    assert.equal(env.state().recording, 'idle');
    assert.equal(env.state().recordingError, 'The speech worker is not available.');
    assert.equal(env.world.sources[0].starts, 0);
    assert.equal(env.world.sources[0].listeners(), 0);
    assert.equal(env.world.clock.pending(), 0);
    assert.deepEqual(env.world.notes.notices, ['The speech worker is not available.']);
  });

  it('tells when the speech runtime is not installed', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    env.world.prepareSource = (source) => {
      source.failState = 'not-installed';
      source.startError = new Error('Transcription is not installed on this Mac.');
    };
    await env.c.startRecording();
    assert.equal(env.state().recording, 'idle');
    assert.equal(env.state().stt, 'not-installed');
    assert.equal(env.state().recordingError, 'Transcription is not installed on this Mac.');
    assert.deepEqual(env.world.notes.notices, ['Transcription is not installed on this Mac.']);

    // Another meeting does not install it: the Transcript tab keeps saying how to.
    env.c.selectSection(BOARD);
    assert.equal(env.state().stt, 'not-installed');
    assert.equal(env.state().sttMessage, 'Transcription is not installed on this Mac.');
    assert.equal(env.state().recordingError, null);
    assert.equal(env.world.notes.notices.length, 1);
  });

  it('needs a meeting, and ignores a second start', async () => {
    const env = await boot();
    await env.c.startRecording();
    assert.equal(env.state().recording, 'idle');
    assert.equal(env.world.sources.length, 0);
    assert.equal(env.world.notes.notices.length, 1);

    env.c.selectSection(JANE);
    const first = env.c.startRecording();
    assert.equal(env.state().recording, 'starting');
    const second = env.c.startRecording();
    await Promise.all([first, second]);
    assert.equal(env.world.sources.length, 1);
    assert.equal(env.state().recording, 'recording');
  });

  it('cancels a start that is still under way, without a word', async () => {
    const env = await withCompanion();
    // The worker is loading its model, and never gets to the end of it.
    env.world.prepareSource = (source) => {
      source.startGate = new Promise<void>(() => {});
    };
    const timers = env.world.clock.pending();
    const before = env.state();
    const starting = env.c.startRecording();
    assert.equal(env.state().recording, 'starting');
    assert.equal(env.state().stt, 'spawning');

    const source = env.world.sources[0];
    source.lastWords = [{ type: 'segment', source: 'mic', t0: 0, t1: 1, text: 'Never recorded.', isFinal: true }];
    await env.c.stopRecording();
    // Its own promise settles, though the source never answered.
    await starting;
    await settle();

    const state = env.state();
    assert.equal(state.recording, 'idle');
    assert.equal(state.recordingError, null);
    assert.equal(state.stt, 'exited');
    assert.equal(state.sttMessage, null);
    assert.equal(state.meeting, before.meeting, 'the meeting never started');
    assert.equal(state.stats, before.stats, 'and is not counted');
    assert.equal(state.turns, before.turns);
    assert.equal(state.elapsedMs, 0);
    assert.equal(state.tab, 'notes');
    assert.equal(state.summary, before.summary, 'no summary of nothing');
    assert.equal(env.world.llm.chats.length, 0);
    assert.equal(source.stops, 1);
    assert.equal(source.listeners(), 0);
    assert.equal(env.world.clock.pending(), timers, 'no ticker left behind');
    assert.deepEqual(env.world.notes.notices, []);
    assert.deepEqual(env.world.notes.touched, []);
    assert.equal(env.world.notes.writes.length, 0);

    // The next start is a start like any other.
    env.world.prepareSource = null;
    await env.c.startRecording();
    assert.equal(env.state().recording, 'recording');
    assert.equal(env.world.sources.length, 2);
    assert.equal(env.state().stats.meetings, 1);
  });

  it('is not set recording by a source that answers just after the cancel', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    // The source has started already; the session has not heard of it yet.
    const starting = env.c.startRecording();
    assert.equal(env.world.sources[0].state(), 'running');
    assert.equal(env.state().recording, 'starting');
    const stopping = env.c.stopRecording();
    await Promise.all([starting, stopping]);
    await settle();

    const state = env.state();
    assert.equal(state.recording, 'idle');
    assert.equal(state.recordingError, null);
    assert.equal(state.meeting?.startedAt, null);
    assert.equal(state.stats.meetings, 0);
    assert.equal(env.world.sources[0].stops, 1);
    assert.equal(env.world.clock.pending(), 0);
    assert.equal(env.world.llm.chats.length, 0);

    env.world.sources[0].say('Said to nobody.', 1, 2);
    env.world.clock.advance(2000);
    assert.equal(env.state(), state);
  });

  it('takes the failure of a start it cancelled for what it is', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    let open = (): void => {};
    env.world.prepareSource = (source) => {
      source.startGate = new Promise<void>((resolve) => {
        open = resolve;
      });
    };
    const starting = env.c.startRecording();
    // A second click while the first is at work changes nothing.
    await Promise.all([env.c.stopRecording(), env.c.stopRecording()]);
    assert.equal(env.world.sources[0].stops, 1);
    // Only now does the source give its start up, as the real one does: by failing it.
    open();
    await starting;
    await settle();
    assert.equal(env.state().recording, 'idle');
    assert.equal(env.state().recordingError, null);
    assert.deepEqual(env.world.notes.notices, []);
  });

  it('shows no error for a start that had failed in the very moment it was cancelled', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    env.world.prepareSource = (source) => {
      source.start = () => Promise.reject(new Error('The microphone is not available.'));
    };
    const errors: string[] = [];
    env.session.store.subscribe((state) => {
      if (state.recordingError !== null) errors.push(state.recordingError);
    });
    const starting = env.c.startRecording();
    const stopping = env.c.stopRecording();
    await Promise.all([starting, stopping]);
    await settle();
    assert.equal(env.state().recording, 'idle');
    assert.deepEqual(errors, [], 'not even for a moment');
    assert.equal(env.world.sources[0].stops, 1);
    assert.deepEqual(env.world.notes.notices, [], 'and nothing is said of a start the user gave up');
  });

  it('cancels the start when the meeting is ended meanwhile', async () => {
    const env = await withCompanion();
    env.world.prepareSource = (source) => {
      source.startGate = new Promise<void>(() => {});
    };
    const starting = env.c.startRecording();
    assert.equal(env.state().recording, 'starting');
    await until(env.world, env.c.endMeeting());
    await starting;
    assert.equal(env.state().meeting, null);
    assert.equal(env.state().recording, 'idle');
    assert.equal(env.state().recordingError, null);
    assert.equal(env.world.sources[0].stops, 1);
    assert.equal(env.world.llm.chats.length, 0);
    assert.deepEqual(env.world.notes.notices, []);
  });

  it('says a speech warning once per recording, and only when it has words', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    const source = env.world.sources[0];
    const unsupported = 'The speech model does not support the selected language; using automatic detection.';

    source.emit({ type: 'error', code: 'lang_unsupported', message: unsupported });
    assert.deepEqual(env.world.notes.notices, [unsupported]);
    assert.equal(env.state().sttMessage, unsupported);
    assert.equal(env.state().recording, 'recording');
    source.emit({ type: 'error', code: 'lang_unsupported', message: unsupported });
    assert.equal(env.world.notes.notices.length, 1, 'once per code');

    source.emit({ type: 'error', code: 'protocol', message: ' A line from the worker could not be read. ' });
    source.emit({ type: 'error', code: 'protocol', message: 'Another line could not be read.' });
    assert.deepEqual(env.world.notes.notices.slice(1), ['A line from the worker could not be read.']);

    // Nothing to say is not said: the code alone means nothing to the user.
    source.emit({ type: 'error', code: 'overrun' });
    source.emit({ type: 'error', code: 'overrun', message: '  ' });
    assert.equal(env.world.notes.notices.length, 2);
    assert.equal(env.state().sttMessage, 'Transcription error: overrun');

    // The next recording is told again.
    await until(env.world, env.c.stopRecording());
    await env.c.startRecording();
    env.world.sources[1].emit({ type: 'error', code: 'lang_unsupported', message: unsupported });
    assert.deepEqual(env.world.notes.notices.slice(2), [unsupported]);
  });

  it('says once that the speech runtime was set up by another plugin version, and records on', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    const source = env.world.sources[0];
    // What the node source says before its worker starts (nodeSttSource.ts), as a warning, not a failure.
    const outdated =
      'The speech runtime was set up by plugin version 0.1.4; this is 0.2.0. Run the speech setup command again (Settings, Magical Hamster, Speech).';

    source.emit({ type: 'error', code: 'worker_outdated', message: outdated });
    source.emit({ type: 'error', code: 'worker_outdated', message: outdated });
    assert.deepEqual(env.world.notes.notices, [outdated]);
    assert.equal(env.state().recording, 'recording');
    assert.equal(env.state().recordingError, null);
    assert.notEqual(env.state().stt, 'failed', 'the worker there is still transcribes');
    assert.notEqual(env.state().stt, 'not-installed');
  });

  it('ignores a stop when nothing is being recorded', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    const before = env.state();
    await env.c.stopRecording();
    await settle();
    assert.equal(env.state(), before);
    assert.equal(env.world.llm.chats.length, 0);
  });

  it('starts the meeting clock and counts the meeting once', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    const startedAt = env.world.clock.now();
    assert.equal(env.state().meeting?.startedAt, startedAt);
    assert.equal(env.state().meeting?.endedAt, null);
    assert.equal(env.state().stats.meetings, 1);

    const source = env.world.sources[0];
    source.micLevel = 0.5;
    env.world.clock.advance(500);
    assert.equal(env.state().elapsedMs, 500);
    assert.equal(env.state().micLevel, 0.5);
    // A move the meter could not show does not wake it.
    source.micLevel = 0.51;
    env.world.clock.advance(500);
    assert.equal(env.state().elapsedMs, 1000);
    assert.equal(env.state().micLevel, 0.5);
    source.micLevel = 0.6;
    env.world.clock.advance(500);
    assert.equal(env.state().micLevel, 0.6);
    // Whatever the source reports, the meter gets a level between 0 and 1.
    source.micLevel = 7;
    env.world.clock.advance(500);
    assert.equal(env.state().micLevel, 1);
    source.micLevel = Number.NaN;
    env.world.clock.advance(500);
    assert.equal(env.state().micLevel, 0);
  });

  it('shows partials and turns finals into turns', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    const source = env.world.sources[0];

    source.partial('thanks for');
    assert.deepEqual(env.state().partial, { source: 'mic', text: 'thanks for' });
    source.partial('thanks for making', 'mic');
    assert.equal(env.state().partial?.text, 'thanks for making');
    // The same words again are not news.
    const shown = env.state().partial;
    source.partial('thanks for making', 'mic');
    assert.equal(env.state().partial, shown);

    source.emit({
      type: 'segment',
      source: 'mic',
      t0: 1.5,
      t1: 4,
      text: ' Thanks for making time. ',
      isFinal: true,
      lang: 'en',
    });
    assert.equal(env.state().partial, null);
    assert.deepEqual(env.state().turns, [
      { id: 'T1', source: 'mic', t0: 1.5, t1: 4, text: 'Thanks for making time.', lang: 'en' },
    ]);

    const first = env.state().turns[0];
    source.partial('on vise', 'system');
    source.say('On vise la mi-novembre.', 5, 8, 'system');
    assert.deepEqual(
      env.state().turns.map((t) => [t.id, t.source]),
      [
        ['T1', 'mic'],
        ['T2', 'system'],
      ],
    );
    assert.equal(env.state().turns[0], first, 'an earlier turn keeps its object');

    // Silence recognised as nothing is not a turn, and ends what was being recognised.
    source.partial('hm');
    source.say('   ', 9, 10);
    assert.equal(env.state().turns.length, 2);
    assert.equal(env.state().partial, null);
  });

  it('offers each question of a long final, and the one whose mark comes with the next final', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    const source = env.world.sources[0];
    const emit = (text: string, t0: number, t1: number, closes?: string) =>
      source.emit({ type: 'segment', source: 'mic', t0, t1, text, isFinal: true, ...(closes ? { closes } : {}) });

    emit("Merci d'être là. Maël, peux tu nous faire un résumé? Oui, on a terminé l'analyse.", 5, 25);
    emit('Moi, j’aimerais savoir qui va s’occuper de la formation des utilisateurs', 26, 30);
    emit("C'est une bonne question", 31, 32, '?');
    assert.deepEqual(
      env.state().qa.chips.map((chip) => [chip.text, chip.turnId]),
      [
        ['Maël, peux tu nous faire un résumé?', 'T1'],
        // Apostrophes come out straight, as everywhere chips are compared.
        ["Moi, j'aimerais savoir qui va s'occuper de la formation des utilisateurs?", 'T2'],
      ],
    );
    // The same question found twice in one turn, whole and in part, is one chip.
    emit("c'est un vrai risque est ce que quelqu'un peut le remplacer", 40, 44);
    emit('Je peux demander à Pria', 45, 47, '?');
    assert.equal(env.state().qa.chips.filter((chip) => /remplacer/.test(chip.text)).length, 1);
    // A new recording: its first final closes nothing of the last one.
    await env.c.stopRecording();
    await settle();
  });

  it('offers the questions it hears, each once, the newest twelve', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    const source = env.world.sources[0];

    source.say('Do you remember who approved the exception last year?', 61, 65, 'system');
    source.say('I am not sure.', 66, 67);
    source.say('do you remember who approved the exception last year?', 70, 74, 'system');
    assert.deepEqual(env.state().qa.chips, [
      { id: 'C1', text: 'Do you remember who approved the exception last year?', time: '01:01', turnId: 'T1' },
    ]);

    for (let i = 1; i <= 13; i++) source.say(`What is the plan for project number ${i}?`, 100 + i, 101 + i);
    const chips = env.state().qa.chips;
    assert.equal(chips.length, 12);
    assert.equal(chips[0].text, 'What is the plan for project number 2?');
    assert.equal(chips[11].text, 'What is the plan for project number 13?');
    assert.equal(new Set(chips.map((chip) => chip.id)).size, 12);

    env.c.dismissChip(chips[0].id);
    assert.equal(env.state().qa.chips.length, 11);
    assert.equal(env.state().qa.chips[0].text, 'What is the plan for project number 3?');
  });

  it('never gives two chips the same id, in one meeting or in two', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    env.world.sources[0].say('Who signs the vendor contract this year?', 1, 4, 'system');
    const first = env.state().qa.chips[0];
    assert.deepEqual([first.id, first.turnId], ['C1', 'T1']);
    await until(env.world, env.c.stopRecording());
    await settle();

    // Asked twice: the meeting that is left was recorded, and has no note.
    env.c.selectSection(BOARD);
    await readNotice(env);
    env.c.selectSection(BOARD);
    assert.deepEqual(env.state().qa.chips, []);
    await env.c.startRecording();
    env.world.sources[1].say('Who signs the vendor contract this year?', 1, 4, 'system');
    const second = env.state().qa.chips[0];
    // The turns are numbered per meeting, the chips for the whole session.
    assert.deepEqual([second.id, second.turnId], ['C2', 'T1']);
  });

  it('writes the numbers said in words as digits in the transcript', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    env.world.sources[0].say("Le taux d'adoption est à cinquante quatre pour cent, la cible est de soixante dix pour cent.", 1, 6);
    assert.equal(env.state().turns[0].text, "Le taux d'adoption est à 54 %, la cible est de 70 %.");
  });

  it('keeps the sentence the worker was hearing when it dies', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('First things first.', 1, 3);
    source.emit({ type: 'segment', source: 'mic', t0: 26.1, t1: 29.6, text: 'Honnêtement, on est un peu en retard', isFinal: false });
    source.setState('crashed', 'The speech worker stopped unexpectedly.');
    assert.deepEqual(
      env.state().turns.map((turn) => [turn.text, turn.t0]),
      [
        ['First things first.', 1],
        ['Honnêtement, on est un peu en retard', 26.1],
      ],
    );
    assert.equal(env.state().partial, null);
    // Once only: the restarted worker begins a new sentence.
    source.setState('crashed', 'Again.');
    assert.equal(env.state().turns.length, 2);
  });

  it('keeps the sentence the worker was still hearing at the stop, as a final of this meeting', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('First things first.', 1, 3);
    // Killed at the end of its grace, the worker sends no final for it.
    source.emit({ type: 'segment', source: 'mic', t0: 26.1, t1: 29.6, text: 'Honnêtement, on est un peu en retard', isFinal: false });
    await until(env.world, env.c.stopRecording());
    assert.deepEqual(
      env.state().turns.map((turn) => [turn.text, turn.t0]),
      [
        ['First things first.', 1],
        ['Honnêtement, on est un peu en retard', 26.1],
      ],
    );
    assert.equal(env.state().partial, null);
    assert.match(region(env, JANE_NOTE, 'transcript'), /on est un peu en retard\n$/);

    // Nothing of it lingers: in the next meeting, a worker that fails before its first word has
    // no partial of this one to keep.
    await until(env.world, env.c.endMeeting());
    env.c.newMeeting();
    assert.equal(env.state().meeting?.manual, true);
    env.world.prepareSource = (next) => {
      next.startError = new Error('The speech worker could not start.');
    };
    await env.c.startRecording();
    assert.equal(env.state().recording, 'idle');
    assert.deepEqual(env.state().turns, []);
    assert.equal(env.state().partial, null);
  });

  it('drops what the worker was hearing when the start is cancelled: nothing was recorded', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    let open = (): void => {};
    env.world.prepareSource = (source) => {
      source.startGate = new Promise<void>((resolve) => {
        open = resolve;
      });
    };
    const starting = env.c.startRecording();
    assert.equal(env.state().recording, 'starting');
    const source = env.world.sources[0];
    source.partial('is this thing on');
    assert.deepEqual(env.state().partial, { source: 'mic', text: 'is this thing on' });
    await env.c.stopRecording();
    open();
    await starting;
    assert.equal(env.state().recording, 'idle');
    assert.equal(env.state().partial, null);
    assert.deepEqual(env.state().turns, []);

    // Not in the next recording either, whose worker fails before its first word.
    env.world.prepareSource = (next) => {
      next.startError = new Error('The speech worker could not start.');
    };
    await env.c.startRecording();
    assert.deepEqual(env.state().turns, []);
  });

  it('says once per recording that transcription has fallen far behind', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    const source = env.world.sources[0];
    const behind = (): string[] => env.world.notes.notices.filter((notice) => notice.startsWith('Transcription is running'));
    source.emit({ type: 'stats', rtf: 0.9, backlogMs: 12_000 });
    assert.deepEqual(behind(), []);
    source.emit({ type: 'stats', rtf: 1.6, backlogMs: 31_400 });
    source.emit({ type: 'stats', rtf: 1.8, backlogMs: 58_000 });
    assert.deepEqual(behind(), [
      'Transcription is running 31 s behind: the computer is busy. It catches up by itself; stopping and starting the recording again drops the backlog.',
    ]);

    // The next recording starts with an empty queue, and warns again if it builds one.
    await until(env.world, env.c.stopRecording());
    await env.c.startRecording();
    env.world.sources[1].emit({ type: 'stats', rtf: 1.5, backlogMs: 30_000 });
    assert.equal(behind().length, 2);
    assert.match(behind()[1], /^Transcription is running 30 s behind/);
  });

  it('keeps recording when the transcript is lost', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    const source = env.world.sources[0];

    source.emit({ type: 'error', code: 'lang_unsupported', message: 'This language is not supported.' });
    assert.equal(env.state().sttMessage, 'This language is not supported.');
    source.emit({ type: 'error', code: 'overrun' });
    assert.equal(env.state().sttMessage, 'Transcription error: overrun');

    source.setState('crashed', 'The speech worker stopped. Restarting.');
    assert.equal(env.state().stt, 'crashed');
    source.setState('running');
    assert.equal(env.state().sttMessage, null);
    // A blank message is no message.
    source.setState('crashed', '  ');
    assert.equal(env.state().sttMessage, null);
    source.emit({ type: 'error', code: 'overrun', message: ' ' });
    assert.equal(env.state().sttMessage, 'Transcription error: overrun');

    // A worker that crashes is restarted: nothing to say yet.
    const said = env.world.notes.notices.length;
    assert.ok(env.world.notes.notices.every((notice) => !/speech worker/.test(notice)));

    source.setState('failed', 'Transcription stopped after three tries.');
    assert.equal(env.state().recording, 'recording');
    assert.equal(env.state().stt, 'failed');
    assert.equal(env.state().sttMessage, 'Transcription stopped after three tries.');
    assert.equal(env.state().recordingError, null);
    // Said as well as shown: the sidebar may be closed, and the user would talk on to nobody.
    assert.deepEqual(env.world.notes.notices.slice(said), ['Transcription stopped after three tries.']);

    // Once: the worker says it again on its way out.
    source.setState('failed', 'Transcription stopped after three tries. The worker exited with code 1.');
    assert.equal(env.state().sttMessage, 'Transcription stopped after three tries. The worker exited with code 1.');
    assert.equal(env.world.notes.notices.length, said + 1);
  });

  it('says in its own words that the transcript is lost when the source gives no reason, once per recording', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    env.world.sources[0].setState('failed');
    assert.equal(env.state().recording, 'recording');
    assert.equal(env.state().sttMessage, null);
    assert.deepEqual(env.world.notes.notices, ['Transcription stopped. The recording continues without a transcript.']);
    // The words of the banner that is up at the same time.
    assert.equal(env.world.notes.notices[0], STT_FAILED_FALLBACK);
    env.world.sources[0].setState('failed', '   ');
    assert.equal(env.world.notes.notices.length, 1);

    // The next recording loses its own.
    await until(env.world, env.c.stopRecording());
    await settle();
    const before = env.world.notes.notices.length;
    await env.c.startRecording();
    env.world.sources[1].setState('failed', ' The microphone was disconnected. ');
    assert.deepEqual(env.world.notes.notices.slice(before), ['The microphone was disconnected.']);
  });

  it('says so too when the source finds, in the middle of a recording, that transcription is not installed', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('We agreed on the plan.', 1, 3);
    // The runtime folder was moved away, the model deleted: the worker cannot be started again.
    source.setState('not-installed', ' Speech recognition is not set up. ');
    assert.equal(env.state().recording, 'recording', 'the meeting goes on');
    assert.equal(env.state().stt, 'not-installed');
    assert.equal(env.state().recordingError, null);
    // Said as well as shown, like a transcription that failed: the sidebar may be out of view.
    assert.deepEqual(env.world.notes.notices, ['Speech recognition is not set up.']);
    // Once per recording, whichever way the transcript was lost.
    source.setState('not-installed', 'Speech recognition is not set up.');
    source.setState('failed', 'The speech worker stopped.');
    assert.equal(env.world.notes.notices.length, 1);

    // In the words of the banner when the source gives none.
    await until(env.world, env.c.stopRecording());
    await settle();
    const before = env.world.notes.notices.length;
    await env.c.startRecording();
    env.world.sources[1].setState('not-installed');
    assert.deepEqual(env.world.notes.notices.slice(before), ['Transcription is not installed on this computer.']);
    assert.equal(env.world.notes.notices[before], STT_NOT_INSTALLED_FALLBACK);
  });

  it('does not say that the transcript is lost once the recording is being stopped', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    // The worker dies on its way out: there is no recording left to continue.
    env.world.prepareSource = (source) => {
      source.stop = async () => {
        source.setState('failed', 'The speech worker stopped.');
      };
    };
    await env.c.startRecording();
    await until(env.world, env.c.stopRecording());
    await settle();
    assert.equal(env.state().recording, 'idle');
    assert.equal(env.state().stt, 'failed');
    assert.deepEqual(env.world.notes.notices, []);
  });

  it('asks Ollama again when a recording starts, so that an old banner does not outlive the moment it matters', async () => {
    const world = makeWorld({ daily: DAILY, entities: ENTITIES });
    world.llm.installed = unreachableError();
    const session = createSession(world.deps);
    await session.init();
    assert.equal(session.store.getState().ollama.status, 'unreachable');

    // Ollama was started since, and nobody pressed Retry.
    world.llm.installed = ['gemma4:12b', 'embeddinggemma-2:270m'];
    session.controller.selectSection(JANE);
    await session.controller.startRecording();
    await settle();
    assert.equal(session.store.getState().recording, 'recording');
    assert.deepEqual(session.store.getState().ollama, { status: 'ok', missingModels: [], remoteHost: null });

    // The other way round too: it was quit during the break.
    await until(world, session.controller.stopRecording());
    await settle();
    world.llm.installed = unreachableError();
    await session.controller.startRecording();
    await settle();
    assert.equal(session.store.getState().ollama.status, 'unreachable');
  });

  it('does not make the recording wait for that answer, and asks even when the start then fails', async () => {
    const env = await boot();
    let asked = 0;
    // Something holds the port and never answers.
    env.world.llm.tags = () => {
      asked += 1;
      return new Promise<string[]>(() => {});
    };
    env.c.selectSection(JANE);
    await env.c.startRecording();
    assert.equal(env.state().recording, 'recording');
    assert.equal(asked, 1);
    assert.equal(env.state().ollama.status, 'ok', 'what was known stands until there is an answer');

    await until(env.world, env.c.stopRecording());
    env.world.prepareSource = (source) => {
      source.startError = new Error('The microphone is not available.');
    };
    await env.c.startRecording();
    assert.equal(env.state().recording, 'idle');
    assert.equal(asked, 2);
  });

  it('stops: flushes, touches the companion, saves the stats and starts a summary', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.micLevel = 0.4;
    env.world.clock.advance(30_000);
    source.say('We agreed on the plan.', 10, 14);
    source.partial('and one more');
    source.lastWords = [{ type: 'segment', source: 'mic', t0: 20, t1: 22, text: 'And one more thing.', isFinal: true }];
    const saves = env.world.statsIO.saves;

    const stopping = env.c.stopRecording();
    assert.equal(env.state().recording, 'stopping');
    await until(env.world, stopping);

    const state = env.state();
    assert.equal(state.recording, 'idle');
    assert.equal(state.partial, null);
    assert.equal(state.micLevel, 0);
    assert.equal(state.elapsedMs, 30_000);
    assert.equal(state.meeting?.endedAt, env.world.clock.now());
    assert.equal(state.stt, 'exited');
    assert.equal(source.stops, 1);
    assert.equal(source.listeners(), 0);
    assert.deepEqual(
      state.turns.map((t) => t.text),
      ['We agreed on the plan.', 'And one more thing.'],
    );
    // On disk at once, without waiting for the idle delay.
    assert.match(region(env, JANE_NOTE, 'transcript'), /And one more thing\.\n$/);
    assert.deepEqual(env.world.notes.touched, [{ path: JANE_NOTE, isoDate: '2026-10-09' }]);
    assert.equal(env.world.statsIO.saves, saves + 1);
    assert.equal(env.world.statsIO.stored?.meetings, 1);

    // The summary was started, not awaited.
    assert.equal(state.tab, 'summary');
    await settle();
    assert.equal(env.state().summary.status, 'done');
    assert.equal(env.state().summary.style, 'executive');
    await pass(env.world, 5200);
    assert.match(region(env, JANE_NOTE, 'summary'), /^### Executive summary\n\n#### Overview/);
    assert.equal(env.state().elapsedMs, 30_000, 'the clock stopped with the recording');
  });

  it('leaves the user on the tab they went to while the stop was saving: the summary waits in its own', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    env.world.sources[0].say('Something worth a summary.', 1, 3);
    // The note is busy in an editor: the stop waits for its flush.
    env.world.notes.recentlyEdited = true;
    assert.equal(env.state().tab, 'notes');
    const stopping = env.c.stopRecording();
    await settle();
    assert.equal(env.state().recording, 'idle');
    assert.equal(env.state().summary.status, 'idle', 'the summary has not started yet');

    // Meanwhile the user starts typing a question.
    env.c.setTab('ask');
    env.world.notes.recentlyEdited = false;
    await until(env.world, stopping);
    await settle();
    assert.equal(env.state().summary.status, 'done', 'the summary is written all the same');
    assert.equal(env.state().tab, 'ask', 'and does not take the tab away');
    await pass(env.world, 5200);
    assert.match(region(env, JANE_NOTE, 'summary'), /^### Executive summary\n\n#### Overview/);

    // A summary that is asked for is one the user wants to see.
    await env.c.summarize('recap');
    assert.equal(env.state().tab, 'summary');
  });

  it('opens the Summary tab after a stop for a user who is back where Stop was pressed', async () => {
    const env = await withCompanion();
    env.c.setTab('transcript');
    await env.c.startRecording();
    env.world.sources[0].say('Something worth a summary.', 1, 3);
    env.world.notes.recentlyEdited = true;
    const stopping = env.c.stopRecording();
    await settle();
    // A glance at the stats, and back.
    env.c.setTab('stats');
    env.c.setTab('transcript');
    env.world.notes.recentlyEdited = false;
    await until(env.world, stopping);
    await settle();
    assert.equal(env.state().summary.status, 'done');
    assert.equal(env.state().tab, 'summary');
  });

  it('starts no summary when the next recording began before the stop was over', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    env.world.sources[0].say('Something worth a summary.', 1, 3);
    // The note is busy in an editor: the stop waits for its flush.
    env.world.notes.recentlyEdited = true;
    const stopping = env.c.stopRecording();
    await settle();
    assert.equal(env.state().recording, 'idle');

    await env.c.startRecording();
    assert.equal(env.state().recording, 'recording');
    await until(env.world, stopping);
    await settle();
    assert.equal(env.state().summary.status, 'idle');
    assert.equal(env.world.llm.chats.length, 0);
    assert.equal(env.state().tab, 'notes');

    // What could not be written then is written once the editor lets go.
    env.world.notes.recentlyEdited = false;
    await pass(env.world, 6000);
    assert.match(region(env, JANE_NOTE, 'transcript'), /Something worth a summary\./);
  });

  it('starts no summary for another meeting, selected while the last lines were being saved', async () => {
    const env = await withCompanion();
    // The board has its note too, with the summary of an earlier session.
    env.c.selectSection(BOARD);
    await env.c.createCompanion();
    await pass(env.world, 1000);
    const earlier = '### Recap\n\nWritten from an hour of talk, in an earlier session.\n';
    env.world.notes.files.set(
      BOARD_NOTE,
      (env.world.notes.files.get(BOARD_NOTE) ?? '').replace(
        '<!-- hamster:begin summary -->\n',
        `<!-- hamster:begin summary -->\n${earlier}`,
      ),
    );

    env.c.selectSection(JANE);
    await settle();
    await env.c.startRecording();
    env.world.sources[0].say('Something worth a summary.', 1, 3);
    // The note is busy in an editor: the stop waits for its flush.
    env.world.notes.recentlyEdited = true;
    const stopping = env.c.stopRecording();
    await settle();
    assert.equal(env.state().recording, 'idle');

    env.c.selectSection(BOARD);
    env.world.notes.recentlyEdited = false;
    await until(env.world, stopping);
    await pass(env.world, 6000);
    assert.equal(env.state().meeting?.key, BOARD);
    assert.equal(env.world.llm.chats.length, 0, 'the board was not recorded: it gets no summary');
    assert.equal(env.state().summary.status, 'idle');
    assert.equal(env.state().tab, 'notes');
    assert.equal(region(env, BOARD_NOTE, 'summary'), earlier);
    // What was said still reached the note of the meeting that was recorded.
    assert.match(region(env, JANE_NOTE, 'transcript'), /Something worth a summary\./);
  });

  it('starts no summary when the meeting is ended while the stop is still saving', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    env.world.sources[0].say('Something worth a summary.', 1, 3);
    env.world.notes.recentlyEdited = true;
    const stopping = env.c.stopRecording();
    await settle();
    assert.equal(env.state().recording, 'idle');

    const ending = env.c.endMeeting();
    env.world.notes.recentlyEdited = false;
    await until(env.world, Promise.all([stopping, ending]));
    await pass(env.world, 1000);
    assert.equal(env.state().meeting, null);
    assert.equal(env.world.llm.chats.length, 0);
    assert.equal(env.state().tab, 'notes');
    assert.match(region(env, JANE_NOTE, 'transcript'), /Something worth a summary\./);
  });

  it('stops once when asked twice, and hears no more from a source it stopped', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('Said in time.', 1, 2);
    const first = env.c.stopRecording();
    const second = env.c.stopRecording();
    await until(env.world, Promise.all([first, second]));
    await settle();
    assert.equal(source.stops, 1);
    assert.equal(env.world.llm.chats.length, 1, 'one summary');

    const before = env.state();
    source.say('Said too late.', 3, 4);
    source.partial('much too late');
    source.setState('crashed', 'The speech worker stopped.');
    assert.equal(env.state(), before);
  });

  it('leaves a summary that is being written alone when the recording stops', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    env.world.sources[0].say('Something worth a summary.', 1, 3);
    const release = env.world.llm.hold();
    const running = env.c.summarize('recap');
    await settle();

    await until(env.world, env.c.stopRecording());
    await settle();
    assert.equal(env.world.llm.chats.length, 1);
    assert.equal(env.state().summary.style, 'recap');
    assert.equal(env.state().summary.status, 'running');

    release();
    await running;
    assert.equal(env.state().summary.status, 'done');
  });

  it('starts no summary when there is nothing to summarize', async () => {
    const env = await boot();
    env.c.newMeeting();
    await env.c.startRecording();
    await until(env.world, env.c.stopRecording());
    await settle();
    assert.equal(env.state().summary.status, 'idle');
    assert.equal(env.state().tab, 'notes');
    assert.equal(env.world.llm.chats.length, 0);
  });

  it('continues the clock in a second recording, after a separator', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    const startedAt = env.state().meeting?.startedAt;
    env.world.clock.advance(60_000);
    env.world.sources[0].say('Said in the first half.', 10, 20);
    await until(env.world, env.c.stopRecording());
    await settle();
    assert.equal(env.state().elapsedMs, 60_000);

    env.world.clock.advance(15 * 60_000);
    await settle();
    const resumedAt = new Date(env.world.clock.now());
    await env.c.startRecording();
    assert.equal(env.state().meeting?.endedAt, null);
    assert.equal(env.state().meeting?.startedAt, startedAt, 'the meeting started with its first recording');
    assert.equal(env.state().stats.meetings, 1, 'the same meeting is not counted twice');
    env.world.clock.advance(500);
    assert.equal(env.state().elapsedMs, 60_500);

    env.world.sources[1].say('Said after the break.', 5, 9);
    const turn = env.state().turns[1];
    assert.equal(turn.id, 'T2');
    assert.equal(turn.t0, 65);
    assert.equal(turn.t1, 69);
    assert.equal(clockText(turn.t0), '01:05');
    env.world.sources[1].say('And then some.', 10, 11);

    await until(env.world, env.c.stopRecording());
    const hh = String(resumedAt.getHours()).padStart(2, '0');
    const mm = String(resumedAt.getMinutes()).padStart(2, '0');
    assert.equal(
      region(env, JANE_NOTE, 'transcript'),
      [
        '> [!quote]- Transcript',
        '> **[00:10] Fred:** Said in the first half.',
        `> **— recording resumed at ${hh}:${mm} —**`,
        '> **[01:05] Fred:** Said after the break.',
        '> **[01:10] Fred:** And then some.',
        '',
      ].join('\n'),
    );
  });

  it('sets a recording apart from the transcript of an earlier visit to the meeting', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    env.world.sources[0].say('Said before Obsidian was restarted.', 4, 6);
    await until(env.world, env.c.stopRecording());
    await settle();

    // A new session over the same vault: nothing is left in memory.
    const world = makeWorld({ daily: env.world.notes.dailyText, entities: ENTITIES });
    world.notes.files.set(JANE_NOTE, env.world.notes.files.get(JANE_NOTE) ?? '');
    const session = createSession(world.deps);
    await session.init();
    session.controller.selectSection(JANE);
    await session.controller.startRecording();
    world.sources[0].say('Said after the restart.', 2, 3);
    world.sources[0].say('And once more.', 4, 5);
    await until(world, session.controller.stopRecording());

    const lines = (readRegion(world.notes.files.get(JANE_NOTE) ?? '', 'transcript') ?? '').trimEnd().split('\n');
    assert.equal(lines.length, 5);
    assert.equal(lines[1], '> **[00:04] Fred:** Said before Obsidian was restarted.');
    assert.match(lines[2], /^> \*\*— recording resumed at \d\d:\d\d —\*\*$/);
    assert.equal(lines[3], '> **[00:02] Fred:** Said after the restart.');
    assert.equal(lines[4], '> **[00:04] Fred:** And once more.');
  });

  it('writes the separator too when the companion is created after the second recording', async () => {
    const env = await boot({ local: { firstWriteConfirmed: true } });
    env.c.selectSection(JANE);
    await env.c.startRecording();
    env.world.sources[0].say('First half.', 1, 2);
    await until(env.world, env.c.stopRecording());
    await env.c.startRecording();
    env.world.sources[1].say('Second half.', 1, 2);
    await until(env.world, env.c.stopRecording());

    await env.c.createCompanion();
    await pass(env.world, 6200);
    const lines = region(env, JANE_NOTE, 'transcript').trimEnd().split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[2], /^> \*\*— recording resumed at \d\d:\d\d —\*\*$/);
  });
});

describe('summaries', () => {
  async function recorded(): Promise<Env> {
    const env = await boot();
    env.c.selectSection(JANE);
    env.c.setTab('transcript');
    return env;
  }

  it('streams, then completes', async () => {
    const env = await recorded();
    env.world.llm.answer = () => '### Overview\nThe migration goes first. The budget is frozen until January.';
    const release = env.world.llm.hold();
    const running = env.c.summarize('recap');
    assert.deepEqual(env.state().summary, { style: 'recap', status: 'running', markdown: '', error: null });
    assert.equal(env.state().tab, 'summary');

    await settle();
    const partial = env.state().summary;
    assert.equal(partial.status, 'running');
    assert.equal(partial.markdown, '### Overview\nThe');

    release();
    await running;
    assert.deepEqual(env.state().summary, {
      style: 'recap',
      status: 'done',
      markdown: '### Overview\nThe migration goes first. The budget is frozen until January.',
      error: null,
    });
    assert.equal(env.state().stats.assists, 1);
    assert.equal(env.state().lastUsage?.model, 'gemma4:12b');
    assert.equal(env.world.clock.pending(), 1, 'only the stats save is waiting');

    const request = env.world.llm.chats[0];
    assert.equal(request.model, 'gemma4:12b');
    assert.equal(request.numCtx, 16384);
    assert.match(userMessage(request), /<shorthand>\nQ4 roadmap: identity migration first\n/);
  });

  it('delivers at most one update per 100 ms, and always the last', async () => {
    const world = makeWorld({ daily: DAILY, ollama: { clock: undefined, pieces: 6 } });
    const session = createSession(world.deps);
    await session.init();
    session.controller.selectSection(JANE);
    world.llm.answer = () => 'one two three four five six';
    const seen: string[] = [];
    session.store.subscribe((state, prev) => {
      if (state.summary !== prev.summary && state.summary.status === 'running') seen.push(state.summary.markdown);
    });
    await session.controller.summarize('recap');
    // The clock did not move: the first piece goes through, the rest waits for the end.
    assert.deepEqual(seen, ['', 'one']);
    assert.equal(session.store.getState().summary.markdown, 'one two three four five six');
  });

  it('goes back to idle when cancelled, keeping the text that arrived', async () => {
    const env = await recorded();
    env.world.llm.answer = () => 'The first words of a summary that will not be finished.';
    env.world.llm.hold();
    const running = env.c.summarize('executive');
    await settle();
    assert.equal(env.state().summary.status, 'running');

    env.c.cancelSummary();
    assert.equal(env.state().summary.status, 'idle');
    assert.equal(env.state().summary.markdown, 'The first words');
    assert.equal(env.state().summary.error, null);
    await running;
    await settle();
    assert.equal(env.state().summary.status, 'idle');
    assert.equal(env.state().stats.assists, 0);
    assert.equal(env.world.clock.pending(), 0);
  });

  it('keeps, when cancelled, the words that were still waiting to be shown', async () => {
    const env = await recorded();
    sayTwoPiecesAndWait(env.world, 'The first words', ' and the next ones');
    const running = env.c.summarize('recap');
    await settle();
    // Two pieces in the same instant: the second waits for the next update of the pane.
    assert.equal(env.state().summary.markdown, 'The first words');

    env.c.cancelSummary();
    assert.deepEqual(env.state().summary, {
      style: 'recap',
      status: 'idle',
      markdown: 'The first words and the next ones',
      error: null,
    });
    await running;
    assert.equal(env.world.clock.pending(), 0);
  });

  it('leaves no progress note behind when a long summary is cancelled', async () => {
    const env = await recorded();
    await env.c.startRecording();
    // An hour of talk: too long for one pass, so it is read window by window.
    const sentence = 'We went through the migration plan and its risks once more, slowly. ';
    for (let i = 0; i < 120; i++) env.world.sources[0].say(sentence.repeat(5), i * 30, i * 30 + 28);
    env.world.llm.hold();
    const running = env.c.summarize('executive');
    await settle();
    assert.equal(env.state().summary.markdown, 'Reading minutes 0–10…');

    env.c.cancelSummary();
    assert.deepEqual(env.state().summary, { style: 'executive', status: 'idle', markdown: '', error: null });
    await running;
  });

  it('cancels the first run when asked a second time', async () => {
    const env = await recorded();
    const release = env.world.llm.hold();
    const first = env.c.summarize('executive');
    await settle();
    const second = env.c.summarize('recap');
    await settle();
    assert.equal(env.world.llm.chats.length, 2, 'the second run does not wait for the first to end');
    release();
    await Promise.all([first, second]);
    await settle();
    assert.equal(env.state().summary.style, 'recap');
    assert.equal(env.state().summary.status, 'done');
    assert.equal(env.state().stats.assists, 1);
    assert.equal(env.world.llm.chats.length, 2);
  });

  it('describes the meeting to the model as the settings say', async () => {
    const env = await boot({ settings: { summaryLanguage: 'fr', actionItemsAsTasks: true } });
    env.c.selectSection(JANE);
    await env.c.startRecording();
    env.world.sources[0].say('We agreed on the plan.', 1, 3);
    env.world.sources[0].say('Fine with me.', 4, 5, 'system');
    await env.c.summarize('actions');

    const request = env.world.llm.chats.at(-1) as ChatRequest;
    const prompt = userMessage(request);
    assert.match(prompt, /<meeting>1:1 Jane Example, 2026-10-09<\/meeting>/);
    assert.match(prompt, /<spellings>Jane Example; Sam Sample; IAM; Steering Board<\/spellings>/);
    assert.match(prompt, /\[00:01\] Fred: We agreed on the plan\.\n\[00:04\] Others: Fine with me\./);
    assert.match(request.messages[0].content, /Write in French/);
    assert.equal(env.state().summary.markdown, '- [ ] **Jane**: Send the plan (Friday)');
  });

  it('renders action items from the structured answer', async () => {
    const env = await recorded();
    await env.c.summarize('actions');
    assert.equal(env.state().summary.markdown, '- **Jane**: Send the plan (Friday)');
    assert.notEqual(env.world.llm.chats[0].format, undefined);
  });

  it('explains a missing model and a server that is down', async () => {
    const env = await recorded();
    env.world.llm.answer = () => missingModelError('gemma4:12b');
    await env.c.summarize('executive');
    assert.deepEqual(env.state().summary, {
      style: 'executive',
      status: 'error',
      markdown: '',
      error: 'Model gemma4:12b is not installed. Run: ollama pull gemma4:12b',
    });

    env.world.llm.answer = () => unreachableError();
    await env.c.summarize('executive');
    assert.equal(env.state().summary.error, 'Ollama is not running.');
    assert.equal(env.state().stats.assists, 0);
  });

  it('says so when there is nothing to summarize', async () => {
    const env = await boot();
    await env.c.summarize('recap');
    assert.equal(env.state().summary.status, 'error');
    assert.equal(env.state().summary.error, 'Nothing to summarize yet');
    assert.equal(env.world.llm.chats.length, 0);
  });
});

describe('questions', () => {
  const BUDGET_QUESTION = 'What is the training budget for this year?';

  /** The Jane meeting with an index over `10 Work` and one searchable stretch of transcript. */
  async function ready(): Promise<Env> {
    const env = await boot({ index: true });
    await env.c.buildIndex(['10 Work']);
    assert.equal(env.state().index.status, 'ready');
    env.c.selectSection(JANE);
    await env.c.startRecording();
    env.world.sources[0].say('The training budget was discussed with finance, the figure is not final.', 0, 40);
    await until(env.world, env.c.stopRecording());
    await settle();
    env.world.llm.answer = (req) => (isQuestion(req) ? 'It is 40000 dollars [2].' : '### Overview\nA summary.');
    return env;
  }

  it('answers from linked notes, the vault index and the transcript', async () => {
    const env = await ready();
    env.c.setTab('notes');
    await env.c.ask(`  ${BUDGET_QUESTION}  `);

    const request = env.world.llm.chats.at(-1) as ChatRequest;
    const prompt = userMessage(request);
    assert.match(prompt, /^<meeting>1:1 Jane Example, 2026-10-09<\/meeting>/);
    assert.match(prompt, /\[1\] Jane Example\n# Jane Example/);
    assert.match(prompt, /\[2\] Budget 2026 › Formation\nThe training budget for this year is 40000 dollars/);
    assert.match(prompt, /\[3\] Transcript 00:00\nThe training budget was discussed with finance/);
    assert.match(prompt, /<transcript>\n\[00:00\] Fred: The training budget was discussed/);
    assert.match(prompt, /<shorthand>\nQ4 roadmap/);
    assert.match(prompt, new RegExp(`Question: ${BUDGET_QUESTION.replace('?', '\\?')}$`));
    // Linked notes are cut short so that they cannot use up the whole source budget.
    assert.deepEqual(env.world.notes.linkedReads, [{ links: ['Jane Example'], maxChars: 2500 }]);

    const [entry] = env.state().qa.entries;
    assert.equal(entry.id, 'Q1');
    assert.equal(entry.question, BUDGET_QUESTION);
    assert.equal(entry.answer, 'It is 40000 dollars [2].');
    assert.equal(entry.status, 'done');
    assert.equal(entry.meetingTime, null);
    assert.equal(entry.askedAt, env.world.clock.now());
    // Only the source the answer cites is kept.
    assert.deepEqual(
      entry.sources.map((s) => [s.n, s.kind, s.title, s.heading, s.path]),
      [[2, 'note', 'Budget 2026', 'Formation', '10 Work/Budget 2026.md']],
    );
    assert.equal(env.state().tab, 'ask');
  });

  it('lists no source when the answer cites none and draws on none', async () => {
    const env = await ready();
    env.world.llm.answer = () => 'The notes do not say.';
    await env.c.ask(BUDGET_QUESTION);
    assert.deepEqual(env.state().qa.entries[0].sources, []);
  });

  it('leaves the daily and the companion out of the vault passages', async () => {
    const env = await boot({ index: true, local: { firstWriteConfirmed: true } });
    env.c.selectSection(JANE);
    await env.c.createCompanion();
    await env.c.enhanceNow();
    await pass(env.world, 6000);
    await env.c.buildIndex(['00 Inbox', '10 Work']);
    assert.equal(env.state().index.files, 4);

    // Close to the words of both notes: either would be a source if it were not left out.
    await env.c.ask('Is the identity migration first on the roadmap?');
    const sources = userMessage(env.world.llm.chats.at(-1) as ChatRequest);
    assert.doesNotMatch(sources, /\] 2026-10-09/);
    assert.doesNotMatch(sources, /\] Mtg-2026-10-09/);

    // Once the meeting is left, its note is a source like any other.
    await env.c.endMeeting();
    await settle();
    await env.c.ask('Is the identity migration first on the roadmap?');
    assert.match(userMessage(env.world.llm.chats.at(-1) as ChatRequest), /\] Mtg-2026-10-09 — 1-1 Jane Example/);
  });

  it('takes at most eight passages from the vault and four from the transcript', async () => {
    const plans: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      const text = `The cutover plan for region ${i} depends on the vendor contract.`;
      plans[`10 Work/Plan ${i}.md`] = `# Plan ${i}\n\n${text}\n`;
    }
    const env = await boot({ index: true, files: plans });
    await env.c.buildIndex(['10 Work']);
    assert.equal(env.state().index.files, 10);
    env.c.selectSection(BOARD);
    await env.c.startRecording();
    // Each stretch is long enough to be searchable on its own.
    for (let i = 0; i < 6; i++) {
      env.world.sources[0].say(`The cutover plan for region ${i} was discussed.`, i * 40, i * 40 + 35);
    }
    await settle();
    env.world.llm.answer = () => 'It depends.';
    await env.c.ask('What about the cutover plan?');

    // What the model was given: the answer cites nothing, so the entry lists no source.
    const kinds = sourcesSent(env.world.llm.chats.at(-1) as ChatRequest);
    assert.equal(kinds.filter((kind) => kind === 'note').length, 8);
    assert.equal(kinds.filter((kind) => kind === 'transcript').length, 4);
  });

  it('can search the last words once the recording has stopped', async () => {
    const env = await boot();
    env.c.selectSection(BOARD);
    await env.c.startRecording();
    // Too short to become searchable while the recording runs.
    env.world.sources[0].say('The steering committee moved the cutover to March.', 2, 6);
    await until(env.world, env.c.stopRecording());
    await settle();
    env.world.llm.answer = (req) => (isQuestion(req) ? 'In March [1].' : '### Overview\nA summary.');
    await env.c.ask('When is the cutover, according to the steering committee?');
    assert.deepEqual(
      env.state().qa.entries[0].sources.map((source) => [source.kind, source.time]),
      [['transcript', '00:02']],
    );
  });

  it('embeds the transcript again when the embedding model or its dimensions change during the meeting', async () => {
    const env = await boot();
    env.c.selectSection(BOARD);
    await env.c.startRecording();
    env.world.sources[0].say('The steering committee moved the cutover to March.', 0, 40);
    env.world.sources[0].say('The vendor contract runs until the cutover weekend.', 40, 80);
    await settle();
    assert.equal(env.world.llm.embeds.length, 2, 'one request per stretch');

    // Saved in the settings tab: vectors of 768 floats cannot answer a query of 256.
    env.world.setSettings({ embedDimensions: 256 });
    env.session.handleSettingsChange();
    await settle();
    assert.equal(env.world.llm.embeds.length, 4, 'both stretches are embedded again');
    assert.ok(env.world.llm.embeds.slice(2).every((req) => req.dimensions === 256), 'with the new dimension');

    env.world.llm.answer = (req) => (isQuestion(req) ? 'In March [1].' : '### Overview\nA summary.');
    await env.c.ask('When is the cutover, according to the steering committee?');
    assert.deepEqual(
      env.state().qa.entries[0].sources.map((source) => [source.kind, source.time]),
      [['transcript', '00:00']],
    );

    // A setting that leaves the embedding space alone embeds nothing.
    const embeds = env.world.llm.embeds.length;
    env.world.setSettings({ micLabel: 'Mic (room)' });
    env.session.handleSettingsChange();
    await settle();
    assert.equal(env.world.llm.embeds.length, embeds);
  });

  it('hands the model the last fifteen minutes of talk, the newest lines when they do not all fit', async () => {
    const env = await boot();
    env.c.selectSection(BOARD);
    await env.c.startRecording();
    const source = env.world.sources[0];
    env.world.llm.answer = () => 'Nothing was said about it.';
    const tail = (): string => {
      const prompt = userMessage(env.world.llm.chats.at(-1) as ChatRequest);
      return /<transcript>\n([\s\S]*?)\n<\/transcript>/.exec(prompt)?.[1] ?? '';
    };

    source.say('An early remark about the legacy system.', 10, 15);
    source.say('A late remark about the new platform.', 1020, 1025);
    await env.c.ask('What was said about the legacy system?');
    assert.equal(tail(), '[17:00] Fred: A late remark about the new platform.');

    const padding = 'and the migration plan with its risks, once more and slowly. '.repeat(7);
    for (let i = 0; i < 40; i++) source.say(`Remark ${i}, ${padding}`, 1040 + i * 20, 1055 + i * 20);
    await env.c.ask('What was said about the legacy system?');
    assert.match(tail(), /Fred: Remark 39,/);
    assert.doesNotMatch(tail(), /Fred: Remark 0,/);
    assert.ok(estimateTokens(tail()) <= 3000);
    assert.ok(estimateTokens(tail()) > 2500, 'as much as fits');
  });

  it('ignores an empty question, and marks the time when asked while recording', async () => {
    const env = await ready();
    await env.c.ask('   ');
    assert.equal(env.state().qa.entries.length, 0);

    await env.c.startRecording();
    env.world.clock.advance(5000);
    await env.c.ask(BUDGET_QUESTION);
    // 40 seconds were recorded before this recording started.
    assert.equal(env.state().qa.entries[0].meetingTime, '00:45');
  });

  it('removes the chip once its question is answered', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    env.world.sources[0].say(BUDGET_QUESTION, 1, 4, 'system');
    const chip = env.state().qa.chips[0];
    const release = env.world.llm.hold();
    const asking = env.c.ask(chip.text, chip.id);
    await settle();
    assert.equal(env.state().qa.chips.length, 1, 'still there while the answer is being written');
    release();
    await asking;
    assert.deepEqual(env.state().qa.chips, []);
  });

  it('streams into its own entry and leaves the others untouched', async () => {
    const env = await ready();
    const assists = env.state().stats.assists;
    await env.c.ask('Where is the offsite?');
    const first = env.state().qa.entries[0];

    env.world.llm.answer = () => 'The offsite takes place in the mountains in February [1].';
    const release = env.world.llm.hold();
    const asking = env.c.ask('And when is the offsite?');
    const again = env.c.ask('Who goes to the offsite?');
    await settle();
    let entries = env.state().qa.entries;
    assert.deepEqual(
      entries.map((e) => [e.id, e.status]),
      [
        ['Q1', 'done'],
        ['Q2', 'running'],
        ['Q3', 'running'],
      ],
    );
    assert.equal(entries[0], first, 'an untouched entry keeps its object');
    assert.equal(entries[1].answer, 'The offsite takes');
    assert.equal(entries[2].answer, '', 'the second question waits its turn at the model');

    release();
    await Promise.all([asking, again]);
    entries = env.state().qa.entries;
    assert.deepEqual(
      entries.map((e) => e.status),
      ['done', 'done', 'done'],
    );
    assert.equal(entries[0], first);
    assert.equal(env.state().stats.assists, assists + 3);
  });

  it('keeps the partial answer of a cancelled question, or drops the entry when there is none', async () => {
    const env = await ready();
    env.world.llm.answer = () => 'The budget is 40000 dollars [2], half of it committed.';
    env.world.llm.hold();
    const asking = env.c.ask(BUDGET_QUESTION);
    await settle();
    const id = env.state().qa.entries[0].id;
    env.c.cancelAsk(id);
    let [entry] = env.state().qa.entries;
    assert.equal(entry.status, 'done');
    assert.equal(entry.answer, 'The budget is');
    assert.equal(entry.error, null);
    await asking;
    await settle();
    assert.equal(env.state().qa.entries[0], entry);

    // Cancelled before a single word arrived.
    const quick = env.c.ask('Something else?');
    const second = env.state().qa.entries[1];
    assert.equal(second.status, 'running');
    env.c.cancelAsk(second.id);
    assert.equal(env.state().qa.entries.length, 1);
    await quick;
    await settle();
    [entry] = env.state().qa.entries;
    assert.equal(env.state().qa.entries.length, 1);
    assert.equal(entry.id, id);
    assert.equal(env.world.clock.pending(), 1, 'only the stats save is waiting');

    // An id is never used twice, whatever happened to the entries before.
    env.world.llm.hold()();
    await env.c.ask('A third question?');
    assert.equal(env.state().qa.entries[1].id, 'Q3');
  });

  it('keeps, when cancelled, the words of an answer that were still waiting to be shown', async () => {
    const env = await boot();
    sayTwoPiecesAndWait(env.world, 'In the', ' mountains');
    const asking = env.c.ask('Where is the offsite?');
    await settle();
    const [entry] = env.state().qa.entries;
    assert.equal(entry.answer, 'In the');
    env.c.cancelAsk(entry.id);
    assert.equal(env.state().qa.entries[0].answer, 'In the mountains');
    assert.equal(env.state().qa.entries[0].status, 'done');
    await asking;
  });

  it('shows why an answer failed', async () => {
    const env = await ready();
    env.world.llm.answer = () => unreachableError();
    await env.c.ask(BUDGET_QUESTION);
    const [entry] = env.state().qa.entries;
    assert.equal(entry.status, 'error');
    assert.equal(entry.error, 'Ollama is not running.');
    assert.equal(entry.answer, '');
  });

  it('still answers when a source of material fails', async () => {
    const env = await ready();
    env.world.notes.readLinkedNotes = async () => {
      throw new Error('unreadable');
    };
    env.world.llm.embedError = unreachableError();
    await env.c.ask(BUDGET_QUESTION);
    const [entry] = env.state().qa.entries;
    assert.equal(entry.status, 'done');
    assert.deepEqual(entry.sources, []);
    assert.doesNotMatch(userMessage(env.world.llm.chats.at(-1) as ChatRequest), /<sources>/);
  });

  it('answers from the vault alone when there is no meeting', async () => {
    const env = await boot({ index: true });
    await env.c.buildIndex(['10 Work']);
    type(env, DAILY, '- budget');
    env.world.llm.answer = () => 'In the mountains [1].';
    await env.c.ask('Where does the offsite take place?');

    const prompt = userMessage(env.world.llm.chats.at(-1) as ChatRequest);
    assert.match(prompt, /^<meeting>Untitled meeting, 2026-10-09<\/meeting>/);
    assert.match(prompt, /\[1\] Offsite\nThe offsite takes place in the mountains/);
    assert.doesNotMatch(prompt, /<transcript>|<shorthand>/);
    assert.deepEqual(env.world.notes.linkedReads, []);
    const [entry] = env.state().qa.entries;
    assert.equal(entry.status, 'done');
    assert.deepEqual(
      entry.sources.map((s) => s.title),
      ['Offsite'],
    );
    assert.equal(env.state().meeting, null);
  });

  it('refuses to keep an insight before the companion exists', async () => {
    const env = await ready();
    await env.c.ask(BUDGET_QUESTION);
    const id = env.state().qa.entries[0].id;
    await env.c.keepInsight(id);
    assert.equal(env.state().qa.entries[0].kept, false);
    assert.deepEqual(env.world.notes.notices, ['Create the companion note first.']);
    assert.equal(env.world.notes.writes.length, 0);
  });

  it('keeps only an answer that is complete', async () => {
    const env = await withCompanion();
    env.world.llm.answer = () => unreachableError();
    await env.c.ask('Where is the offsite?');
    await env.c.keepInsight(env.state().qa.entries[0].id);
    assert.equal(env.state().qa.entries[0].kept, false);

    env.world.llm.answer = () => 'In the mountains, in February.';
    const release = env.world.llm.hold();
    const asking = env.c.ask('And when is it?');
    await settle();
    assert.equal(env.state().qa.entries[1].status, 'running');
    await env.c.keepInsight(env.state().qa.entries[1].id);
    assert.equal(env.state().qa.entries[1].kept, false);
    assert.equal(env.state().pendingWrites, 0);
    release();
    await asking;
  });

  it('waits to know what the note already holds before it keeps an insight', async () => {
    const env = await withCompanion();
    const earlier = '### 09:00 — An earlier question\n\nAn earlier answer, kept in another session.';
    const note = env.world.notes.files.get(JANE_NOTE) ?? '';
    env.world.notes.files.set(
      JANE_NOTE,
      note.replace('<!-- hamster:begin qa -->\n', `<!-- hamster:begin qa -->\n${earlier}\n`),
    );
    await env.c.endMeeting();

    // The note is slow to read: an iCloud file that has to be downloaded first.
    const read = env.world.notes.readCompanion.bind(env.world.notes);
    let arrive: () => void = () => {};
    const downloaded = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    env.world.notes.readCompanion = async (path) => {
      await downloaded;
      return read(path);
    };
    env.c.selectSection(JANE);
    await env.c.ask('Where is the offsite?');
    const keeping = env.c.keepInsight(env.state().qa.entries[0].id);
    await settle();
    assert.equal(env.state().qa.entries[0].kept, false);
    assert.equal(env.state().pendingWrites, 0);

    arrive();
    await keeping;
    assert.equal(env.state().qa.entries[0].kept, true);
    await pass(env.world, 5200);
    const saved = region(env, JANE_NOTE, 'qa');
    assert.ok(saved.startsWith(`${earlier}\n\n### 14:05 — Where is the offsite?`));
  });

  it('keeps an insight once when asked twice in a row', async () => {
    const env = await withCompanion();
    await env.c.ask('Where is the offsite?');
    const id = env.state().qa.entries[0].id;
    let rebuilt = 0;
    env.session.store.subscribe((state, prev) => {
      if (state.qa !== prev.qa) rebuilt += 1;
    });
    await Promise.all([env.c.keepInsight(id), env.c.keepInsight(id)]);
    assert.equal(env.state().qa.entries[0].kept, true);
    assert.equal(rebuilt, 1, 'the second click leaves the entry as it is');
    await pass(env.world, 5200);
    assert.equal(region(env, JANE_NOTE, 'qa').match(/^### /gm)?.length, 1);
  });

  it('adds kept insights to what the qa region already holds', async () => {
    const env = await withCompanion({ index: true });
    const earlier = '### 09:00 — An earlier question\n\nAn earlier answer, kept in another session.';
    const note = env.world.notes.files.get(JANE_NOTE) ?? '';
    env.world.notes.files.set(
      JANE_NOTE,
      note.replace('<!-- hamster:begin qa -->\n', `<!-- hamster:begin qa -->\n${earlier}\n`),
    );
    // A new visit to the meeting reads the note once.
    await env.c.endMeeting();
    await env.c.buildIndex(['10 Work']);
    env.c.selectSection(JANE);
    await settle();
    env.world.llm.answer = () => 'It is 40000 dollars [2].';

    await env.c.ask(BUDGET_QUESTION);
    await env.c.ask('Where is the offsite?');
    const [first, second] = env.state().qa.entries;
    await env.c.keepInsight(first.id);
    assert.equal(env.state().qa.entries[0].kept, true);
    assert.equal(env.state().qa.entries[1], second);
    await pass(env.world, 5200);
    assert.equal(
      region(env, JANE_NOTE, 'qa'),
      [
        earlier,
        '',
        `### 14:05 — ${BUDGET_QUESTION}`,
        '',
        'It is 40000 dollars [2].',
        '',
        'Sources: Budget 2026 › Formation',
        '',
      ].join('\n'),
    );

    await env.c.keepInsight(second.id);
    // Kept twice is kept once.
    await env.c.keepInsight(second.id);
    await pass(env.world, 5200);
    const saved = region(env, JANE_NOTE, 'qa');
    assert.equal(saved.match(/An earlier question/g)?.length, 1);
    assert.equal(saved.match(/^### /gm)?.length, 3);
    assert.match(saved, /### 14:0\d — Where is the offsite\?\n\nIt is 40000 dollars \[2\]\./);
  });
});

describe('the insights of an earlier session', () => {
  const EARLIER = '### 09:00 — An earlier question\n\nAn earlier answer, kept in another session.';
  const OFFSITE = 'Where is the offsite?';

  /** The Jane meeting, left, with an insight of an earlier session in its note. Returns the note as it should stay. */
  async function left(): Promise<{ env: Env; whole: string }> {
    const env = await withCompanion();
    const whole = (env.world.notes.files.get(JANE_NOTE) ?? '').replace(
      '<!-- hamster:begin qa -->\n',
      `<!-- hamster:begin qa -->\n${EARLIER}\n`,
    );
    env.world.notes.files.set(JANE_NOTE, whole);
    await env.c.endMeeting();
    return { env, whole };
  }

  function qaWrites(env: Env): number {
    return env.world.notes.writes.filter((write) => write.patches.some((patch) => patch.region === 'qa')).length;
  }

  it('survive a keep when their region was damaged at first and repaired since', async () => {
    const { env, whole } = await left();
    // The end marker is missing when the meeting is selected: the region cannot be read.
    env.world.notes.files.set(JANE_NOTE, whole.replace('<!-- hamster:end qa -->\n', ''));
    env.c.selectSection(JANE);
    await settle();
    // Put back by hand, without a word to the plugin.
    env.world.notes.files.set(JANE_NOTE, whole);

    await env.c.ask(OFFSITE);
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await pass(env.world, 5200);
    const saved = region(env, JANE_NOTE, 'qa');
    assert.ok(saved.startsWith(`${EARLIER}\n\n### 14:05 — ${OFFSITE}`), saved);
    assert.deepEqual(env.state().meeting?.detachedRegions, []);
  });

  it('are left alone while their region is damaged, and added to once it is repaired', async () => {
    const { env, whole } = await left();
    env.world.notes.files.set(JANE_NOTE, whole.replace('<!-- hamster:end qa -->\n', ''));
    env.c.selectSection(JANE);
    await settle();
    await env.c.ask(OFFSITE);
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await pass(env.world, 5200);
    // Reported like any damaged region. Nothing was sent: a repair in the meantime would have let it through.
    assert.deepEqual(env.state().meeting?.detachedRegions, ['qa']);
    assert.equal(env.state().qa.entries[0].kept, true);
    assert.equal(qaWrites(env), 0);

    env.world.notes.files.set(JANE_NOTE, whole);
    await env.c.createCompanion();
    await pass(env.world, 5200);
    assert.deepEqual(env.state().meeting?.detachedRegions, []);
    const saved = region(env, JANE_NOTE, 'qa');
    assert.ok(saved.startsWith(`${EARLIER}\n\n### 14:05 — ${OFFSITE}`), saved);
    assert.equal(saved.match(/^### /gm)?.length, 2);
  });

  it('are kept with Unix line ends in a note that uses Windows ones', async () => {
    const { env, whole } = await left();
    // The note as a Windows editor, or a sync client, leaves it: every line ends in CR LF.
    const windows = whole.replace('\n\nAn earlier answer', '\n\nAn earlier answer\nover two lines').replace(/\n/g, '\r\n');
    env.world.notes.files.set(JANE_NOTE, windows);
    assert.equal(readRegion(windows, 'qa'), '### 09:00 — An earlier question\r\n\r\nAn earlier answer\r\nover two lines, kept in another session.\r\n');

    env.c.selectSection(JANE);
    await settle();
    await env.c.ask(OFFSITE);
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await pass(env.world, 5200);

    const sent = env.world.notes.writes.flatMap((write) => write.patches).find((patch) => patch.region === 'qa');
    assert.ok(sent && sent.region === 'qa');
    assert.doesNotMatch(sent.content, /\r/, 'one kind of line end in what is written');
    assert.ok(
      sent.content.startsWith(
        `### 09:00 — An earlier question\n\nAn earlier answer\nover two lines, kept in another session.\n\n### 14:05 — ${OFFSITE}`,
      ),
      sent.content,
    );

    // Adopted again, the note is this session's own: what it holds is not taken for another note's and doubled.
    await env.c.createCompanion();
    await env.c.ask('And the budget?');
    await env.c.keepInsight(env.state().qa.entries[1].id);
    await pass(env.world, 5200);
    const saved = region(env, JANE_NOTE, 'qa');
    assert.equal(saved.match(/^### /gm)?.length, 3);
    assert.equal(saved.match(/An earlier question/g)?.length, 1);
    assert.doesNotMatch(saved, /\r/);
  });

  it('are kept apart from the blank lines around them, old Mac line ends included', async () => {
    const { env, whole } = await left();
    env.world.notes.files.set(
      JANE_NOTE,
      whole.replace(`${EARLIER}\n`, `\r\n \r\n${EARLIER.replace(/\n/g, '\r')}\r\n\r\n`),
    );
    env.c.selectSection(JANE);
    await settle();
    await env.c.ask(OFFSITE);
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await pass(env.world, 5200);
    const saved = region(env, JANE_NOTE, 'qa');
    assert.ok(saved.startsWith(`${EARLIER}\n\n### 14:05 — ${OFFSITE}`), JSON.stringify(saved));
    assert.doesNotMatch(saved, /\r/);
  });

  it('survive a keep when the note could not be read at first', async () => {
    const { env } = await left();
    const read = env.world.notes.readCompanion.bind(env.world.notes);
    let failing = true;
    env.world.notes.readCompanion = async (path) => {
      if (failing) throw new Error('The file is not downloaded yet.');
      return read(path);
    };
    env.c.selectSection(JANE);
    await settle();
    await env.c.ask(OFFSITE);
    const id = env.state().qa.entries[0].id;

    // Still unreadable: nothing is kept, and nothing replaces what the note holds.
    await env.c.keepInsight(id);
    await pass(env.world, 5200);
    assert.equal(env.state().qa.entries[0].kept, false);
    assert.deepEqual(env.world.notes.notices, [
      'The companion note could not be read. Try keeping the insight again in a moment.',
    ]);
    assert.equal(qaWrites(env), 0);
    assert.equal(region(env, JANE_NOTE, 'qa'), `${EARLIER}\n`);

    failing = false;
    await env.c.keepInsight(id);
    await pass(env.world, 5200);
    assert.equal(env.state().qa.entries[0].kept, true);
    assert.ok(region(env, JANE_NOTE, 'qa').startsWith(`${EARLIER}\n\n### 14:05 — ${OFFSITE}`));
  });

  it('survive when the note that could not be read is adopted again', async () => {
    const { env } = await left();
    const read = env.world.notes.readCompanion.bind(env.world.notes);
    let failing = true;
    env.world.notes.readCompanion = async (path) => {
      if (failing) throw new Error('The file is not downloaded yet.');
      return read(path);
    };
    env.c.selectSection(JANE);
    await settle();
    await env.c.ask(OFFSITE);
    failing = false;
    await env.c.createCompanion();
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await pass(env.world, 5200);
    assert.ok(region(env, JANE_NOTE, 'qa').startsWith(`${EARLIER}\n\n### 14:05 — ${OFFSITE}`));
    assert.deepEqual(env.world.notes.notices, []);
  });

  it('are not replaced when the note cannot be read on adoption either', async () => {
    const { env, whole } = await left();
    env.world.notes.files.set(JANE_NOTE, whole.replace('<!-- hamster:end qa -->\n', ''));
    env.c.selectSection(JANE);
    await settle();
    await env.c.ask(OFFSITE);
    await env.c.keepInsight(env.state().qa.entries[0].id);
    assert.deepEqual(env.state().meeting?.detachedRegions, ['qa']);

    // Repaired, but the adoption that follows cannot read the note.
    env.world.notes.files.set(JANE_NOTE, whole);
    const read = env.world.notes.readCompanion.bind(env.world.notes);
    env.world.notes.readCompanion = async () => {
      throw new Error('The file is not downloaded yet.');
    };
    await env.c.createCompanion();
    await pass(env.world, 5200);
    assert.equal(qaWrites(env), 0);
    assert.equal(region(env, JANE_NOTE, 'qa'), `${EARLIER}\n`);

    env.world.notes.readCompanion = read;
    await env.c.createCompanion();
    await pass(env.world, 5200);
    assert.ok(region(env, JANE_NOTE, 'qa').startsWith(`${EARLIER}\n\n### 14:05 — ${OFFSITE}`));
  });

  it('are not brought back into a note that was deleted and created again', async () => {
    const { env } = await left();
    env.c.selectSection(JANE);
    await settle();
    env.world.notes.files.delete(JANE_NOTE);
    env.session.handleVaultChange({ type: 'delete', path: JANE_NOTE });
    assert.equal(env.state().meeting?.companionPath, null);

    await env.c.createCompanion();
    await env.c.ask(OFFSITE);
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await pass(env.world, 6200);
    const saved = region(env, JANE_NOTE, 'qa');
    assert.ok(saved.startsWith(`### 14:05 — ${OFFSITE}`), saved);
    assert.doesNotMatch(saved, /An earlier question/);
  });

  it('survive when the meeting ends up in their note after losing its own', async () => {
    const { env } = await left();
    // A meeting started on its own, with its own note, then linked to the section that has one already.
    env.c.newMeeting();
    await env.c.createCompanion();
    const own = env.state().meeting?.companionPath ?? '';
    assert.notEqual(own, JANE_NOTE);
    await env.c.ask(OFFSITE);
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await pass(env.world, 6200);
    assert.ok(region(env, own, 'qa').startsWith(`### 14:05 — ${OFFSITE}`));
    type(env, env.world.notes.dailyText ?? '', '- budget');
    await env.c.linkAtCursor();
    assert.equal(env.state().meeting?.key, JANE);
    assert.equal(env.state().meeting?.companionPath, own);

    // Its own note is deleted: the section's note is the one left for the meeting.
    env.world.notes.files.delete(own);
    env.session.handleVaultChange({ type: 'delete', path: own });
    await env.c.createCompanion();
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    await pass(env.world, 5200);
    const saved = region(env, JANE_NOTE, 'qa');
    assert.ok(saved.startsWith(`${EARLIER}\n\n### 14:05 — ${OFFSITE}`), saved);
    assert.equal(saved.match(/^### /gm)?.length, 2);
  });

  it('are not doubled when the same note is adopted again after an edit by hand', async () => {
    const { env } = await left();
    env.c.selectSection(JANE);
    await settle();
    await env.c.ask(OFFSITE);
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await pass(env.world, 5200);

    // What was changed by hand stays as it was left, and the insight is not added a second time.
    const note = env.world.notes.files.get(JANE_NOTE) ?? '';
    env.world.notes.files.set(JANE_NOTE, note.replace(`— ${OFFSITE}`, '— Where is the offsite, again?'));
    await env.c.createCompanion();
    await pass(env.world, 5200);
    const saved = region(env, JANE_NOTE, 'qa');
    assert.equal(saved.match(/^### /gm)?.length, 2);
    assert.ok(saved.startsWith(`${EARLIER}\n\n### 14:05 — Where is the offsite, again?`), saved);

    // Filed away in Obsidian, it is still the same note.
    const filed = '10 Work/Meetings/Jane.md';
    env.world.notes.files.set(filed, env.world.notes.files.get(JANE_NOTE) ?? '');
    env.world.notes.files.delete(JANE_NOTE);
    env.session.handleVaultChange({ type: 'rename', path: filed, oldPath: JANE_NOTE });
    await pass(env.world, 5200);
    const moved = env.world.notes.files.get(filed) ?? '';
    env.world.notes.files.set(filed, moved.replace(`— ${OFFSITE}`, '— Where is the offsite, once more?'));
    await env.c.createCompanion();
    await pass(env.world, 5200);
    assert.equal(region(env, filed, 'qa').match(/^### /gm)?.length, 2);
  });

  it('are not doubled either in a note created here, or read late', async () => {
    /** Keeps an insight, edits it by hand in the note, adopts the note again: how many insights does it hold? */
    async function insightsAfterAnEdit(env: Env): Promise<number> {
      await env.c.ask(OFFSITE);
      await env.c.keepInsight(env.state().qa.entries[0].id);
      await pass(env.world, 6200);
      const note = env.world.notes.files.get(JANE_NOTE) ?? '';
      assert.ok(note.includes(`— ${OFFSITE}`));
      env.world.notes.files.set(JANE_NOTE, note.replace(`— ${OFFSITE}`, '— Where is the offsite, again?'));
      await env.c.createCompanion();
      await pass(env.world, 5200);
      return region(env, JANE_NOTE, 'qa').match(/^### /gm)?.length ?? 0;
    }
    /** The meeting is selected before its note, written on another device, reaches this vault. */
    async function arrivedLate(readable: boolean): Promise<Env> {
      const { whole } = await left();
      const env = await boot({ local: { firstWriteConfirmed: true } });
      env.c.selectSection(JANE);
      env.world.notes.files.set(JANE_NOTE, whole);
      const read = env.world.notes.readCompanion.bind(env.world.notes);
      if (!readable) {
        env.world.notes.readCompanion = async () => {
          throw new Error('The file is not downloaded yet.');
        };
      }
      await env.c.createCompanion();
      assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
      env.world.notes.readCompanion = read;
      return env;
    }

    assert.equal(await insightsAfterAnEdit(await withCompanion()), 1, 'created in this session');
    assert.equal(await insightsAfterAnEdit(await arrivedLate(true)), 2, 'read when it was adopted');
    assert.equal(await insightsAfterAnEdit(await arrivedLate(false)), 2, 'read when the insight was kept');
  });

  it('do not travel to the note of the next meeting', async () => {
    const { env } = await left();
    env.c.selectSection(JANE);
    await settle();

    // The board's note arrives from another device after the board was selected.
    env.c.selectSection(BOARD);
    const elsewhere = makeWorld({ daily: DAILY, entities: ENTITIES, local: { firstWriteConfirmed: true } });
    const other = createSession(elsewhere.deps);
    await other.init();
    other.controller.selectSection(BOARD);
    await other.controller.createCompanion();
    env.world.notes.files.set(BOARD_NOTE, elsewhere.notes.files.get(BOARD_NOTE) ?? '');
    assert.equal(env.state().meeting?.companionPath, null);

    await env.c.createCompanion();
    assert.equal(env.state().meeting?.companionPath, BOARD_NOTE);
    await env.c.ask(OFFSITE);
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await pass(env.world, 5200);
    const saved = region(env, BOARD_NOTE, 'qa');
    assert.ok(saved.startsWith(`### 14:05 — ${OFFSITE}`), saved);
    assert.doesNotMatch(saved, /An earlier question/);
  });

  it('are found gone with their note, which is said once', async () => {
    const { env } = await left();
    const read = env.world.notes.readCompanion.bind(env.world.notes);
    env.world.notes.readCompanion = async () => {
      throw new Error('The file is not downloaded yet.');
    };
    env.c.selectSection(JANE);
    await settle();
    await env.c.ask(OFFSITE);
    env.world.notes.files.delete(JANE_NOTE);
    env.world.notes.readCompanion = read;
    await env.c.keepInsight(env.state().qa.entries[0].id);
    assert.equal(env.state().meeting?.companionPath, null);
    assert.deepEqual(env.world.notes.notices, [
      'The companion note is no longer there. Create it again to keep saving.',
    ]);
    assert.equal(qaWrites(env), 0);
  });
});

describe('enhance', () => {
  function styled(req: ChatRequest): string {
    const concise = req.messages[0].content.includes('at most 12 words');
    return promptItems(req)
      .map((item) => `${item.n}. **${concise ? 'Short' : 'Full'}:** ${item.text}`)
      .join('\n');
  }

  it('needs a meeting', async () => {
    const env = await boot();
    type(env, DAILY, '- budget');
    await env.c.enhanceNow();
    assert.equal(env.world.llm.chats.length, 0);
    assert.equal(env.world.notes.notices.length, 1);
    assert.deepEqual(env.state().enhanced, []);
  });

  it('writes one bullet per line, counts the usage and reports up to date', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.enhanceNow();
    const state = env.state();
    assert.deepEqual(
      state.enhanced.map((e) => [e.kind, e.bullet, e.stale, e.streaming]),
      [
        ['item', '**Note:** Q4 roadmap: identity migration first', false, false],
        ['item', "**Note:** budget: 2 postes gelés jusqu'en janvier", false, false],
        ['topic', null, false, false],
        ['item', '**Note:** vendor contract renewal may slip to Nov', false, false],
      ],
    );
    assert.equal(state.enhanceStatus, 'up-to-date');
    assert.equal(state.enhanceError, null);
    assert.equal(state.stats.assists, 1);
    assert.ok(state.stats.input > 0 && state.stats.output > 0);
    assert.equal(state.lastUsage?.model, 'gemma4:12b');

    const request = env.world.llm.chats[0];
    assert.equal(request.numCtx, 16384);
    assert.match(userMessage(request), /<meeting>1:1 Jane Example<\/meeting>/);
    assert.match(userMessage(request), /<notetaker>Fred<\/notetaker>/);
    // People by name, projects and bodies by the name of their note.
    assert.match(userMessage(request), /<spellings>Jane Example; Sam Sample; IAM; Steering Board<\/spellings>/);
  });

  it('hands the model at most sixty spellings', async () => {
    const rows = Array.from({ length: 70 }, (_, i) => `| Ann${i} | [[Ann${i}]] | | yes |`).join('\n');
    const head = '## People\n| canonical | wikilink | aliases | active |\n|---|---|---|---|';
    const env = await boot({ entities: `${head}\n${rows}\n` });
    env.c.selectSection(JANE);
    await env.c.enhanceNow();
    const spellings = /<spellings>(.*)<\/spellings>/.exec(userMessage(env.world.llm.chats[0]))?.[1].split('; ') ?? [];
    assert.equal(spellings.length, 60);
    assert.equal(spellings[0], 'Ann0');
    assert.equal(spellings[59], 'Ann59');
  });

  it('only sends the line that changed, and keeps the other rows as they are', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.enhanceNow();
    const before = env.state().enhanced;

    type(env, DAILY.replace('- Q4 roadmap: identity migration first', '- Q4 roadmap: network first'), '- Q4 roadmap');
    let now = env.state().enhanced;
    assert.equal(now[0].stale, true, 'the old bullet stays, dimmed, until the new one arrives');
    assert.equal(now[0].bullet, before[0].bullet);
    assert.equal(now[1], before[1]);
    assert.equal(now[2], before[2]);
    assert.equal(now[3], before[3]);

    await env.c.enhanceNow();
    now = env.state().enhanced;
    assert.equal(now[0].bullet, '**Note:** Q4 roadmap: network first');
    assert.equal(now[0].stale, false);
    assert.equal(now[1], before[1]);
    assert.equal(now[3], before[3]);
    assert.deepEqual(
      promptItems(env.world.llm.chats[1]).map((item) => item.text),
      ['Q4 roadmap: network first'],
    );
  });

  it('uses excerpts of the transcript once there is one', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    const statuses: string[] = [];
    env.session.store.subscribe((state, prev) => {
      if (state.enhanceStatus !== prev.enhanceStatus) statuses.push(state.enhanceStatus);
    });
    await env.c.enhanceNow();
    assert.doesNotMatch(userMessage(env.world.llm.chats[0]), /<excerpts>/);
    // Nothing to search yet: the pane does not claim to be retrieving.
    assert.deepEqual(statuses, ['evaluating', 'structuring', 'up-to-date']);

    await env.c.startRecording();
    env.world.sources[0].say('The vendor contract renewal may slip to November, said the vendor.', 0, 35);
    await settle();
    await env.c.enhanceNow();
    const request = userMessage(env.world.llm.chats[1]);
    assert.match(request, /<excerpts>\n\[E1 00:00\] The vendor contract renewal may slip to November/);
    assert.deepEqual(
      promptItems(env.world.llm.chats[1]).map((item) => item.text),
      ['vendor contract renewal may slip to Nov'],
    );
    assert.deepEqual(env.state().enhanced[3].excerptIds, ['E1']);
    assert.deepEqual(statuses.slice(3), ['evaluating', 'retrieving', 'structuring', 'up-to-date']);
  });

  it('gives a line its three best excerpts', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.enhanceNow();
    await env.c.startRecording();
    for (let i = 0; i < 5; i++) {
      env.world.sources[0].say(`The vendor contract renewal may slip, said speaker ${i}.`, i * 40, i * 40 + 35);
    }
    await settle();
    await env.c.enhanceNow();
    const request = userMessage(env.world.llm.chats[1]);
    assert.equal(request.match(/^\[E\d+ /gm)?.length, 3);
    assert.match(request, /<item n="1" excerpts="E1 E2 E3">vendor contract renewal may slip to Nov<\/item>/);
    assert.deepEqual(env.state().enhanced[3].excerptIds, ['E1', 'E2', 'E3']);
  });

  it('embeds a line once for as long as the transcript has nothing new to search', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    env.world.llm.answer = styled;
    const embeds = (): number => env.world.llm.embeds.length;
    /** The texts embedded since `from`, without the prefix the model wants in front of a query. */
    const queries = (from: number): string[] =>
      env.world.llm.embeds
        .slice(from)
        .flatMap((request) => request.input)
        .filter((input) => input.includes('| query: '))
        .map((input) => input.slice(input.indexOf('| query: ') + '| query: '.length));
    const lines = [
      'Q4 roadmap: identity migration first',
      "budget: 2 postes gelés jusqu'en janvier",
      'vendor contract renewal may slip to Nov',
    ];

    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('The vendor contract renewal may slip to November, said the vendor.', 0, 35);
    await settle();
    assert.equal(embeds(), 1, 'the chunk itself');

    // The first run asks for every line.
    await env.c.enhanceNow();
    assert.deepEqual(queries(1).sort(), [...lines].sort());
    assert.equal(embeds(), 4);

    // Two more runs over the same lines, with nothing new said: the answers are known.
    env.c.setEnhanceStyle('concise');
    await settle();
    env.c.setEnhanceStyle('standard');
    await settle();
    assert.equal(env.world.llm.chats.length, 3, 'three runs');
    assert.equal(embeds(), 4, 'and no line embedded a second time');
    assert.match(userMessage(env.world.llm.chats[2]), /<excerpts>\n\[E1 00:00\] The vendor contract renewal/);
    assert.deepEqual(env.state().enhanced[3].excerptIds, ['E1'], 'the remembered excerpts are used like fresh ones');

    // A line that was edited is a line never asked for.
    type(env, DAILY.replace('- Q4 roadmap: identity migration first', '- Q4 roadmap: network first'), '- Q4 roadmap');
    await env.c.enhanceNow();
    assert.deepEqual(queries(4), ['Q4 roadmap: network first']);
    assert.equal(embeds(), 5);

    // One more chunk can be searched: every line may have something new to find.
    source.say("Pour le budget, 2 postes restent gelés jusqu'en janvier.", 40, 75);
    await settle();
    assert.equal(embeds(), 6, 'the second chunk');
    await env.c.enhanceNow();
    assert.deepEqual(queries(6).sort(), ['Q4 roadmap: network first', lines[1], lines[2]].sort());
    assert.equal(embeds(), 9);
    assert.deepEqual(env.state().enhanced[1].excerptIds, ['E2']);

    // And again nothing until the next one.
    env.c.setEnhanceStyle('concise');
    await settle();
    assert.equal(embeds(), 9);
  });

  it('forgets the excerpts of a meeting when another one begins', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    env.world.sources[0].say('The vendor contract renewal may slip to November, said the vendor.', 0, 35);
    await settle();
    await env.c.enhanceNow();
    assert.match(userMessage(env.world.llm.chats[0]), /\[E1 00:00\] The vendor contract renewal may slip to November/);
    // Ended twice: the first time stops the recording and says that it is in no note.
    await until(env.world, env.c.endMeeting());
    await readNotice(env);
    await until(env.world, env.c.endMeeting());
    assert.equal(env.state().meeting, null);

    // The same section, the same lines, one chunk again: but another conversation.
    env.c.selectSection(JANE);
    await env.c.startRecording();
    env.world.sources[1].say('The vendor contract renewal is signed, there is no risk left.', 0, 35);
    await settle();
    const before = env.world.llm.embeds.length;
    const chats = env.world.llm.chats.length;
    await env.c.enhanceNow();
    assert.equal(env.world.llm.embeds.length, before + 3, 'every line is searched for afresh');
    const request = userMessage(env.world.llm.chats[chats]);
    assert.match(request, /\[E1 00:00\] The vendor contract renewal is signed/);
    assert.doesNotMatch(request, /may slip to November/);
  });

  it('remembers the excerpts of three hundred lines at most', async () => {
    const many = Array.from({ length: 301 }, (_, i) => `- point number ${i + 1} of the agenda`).join('\n');
    const env = await boot({ daily: `### 1:1 [[Jane Example]]\n${many}\n` });
    env.c.selectSection(JANE);
    env.world.llm.answer = styled;
    await env.c.startRecording();
    env.world.sources[0].say('We went through the agenda point by point.', 0, 35);
    await settle();
    await env.c.enhanceNow();
    assert.equal(env.world.llm.embeds.length, 1 + 301);

    // The line asked for first made room for the last: it alone is embedded again, and takes the place of the next.
    env.c.setEnhanceStyle('concise');
    await settle();
    assert.equal(env.world.llm.embeds.length, 1 + 301 + 1);
    assert.match(env.world.llm.embeds[302].input[0], /query: point number 1 of the agenda$/);
    env.c.setEnhanceStyle('standard');
    await settle();
    assert.equal(env.world.llm.embeds.length, 1 + 301 + 2);
    assert.match(env.world.llm.embeds[303].input[0], /query: point number 2 of the agenda$/);
  });

  it('shows an error and recovers', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    env.world.llm.answer = () => unreachableError();
    await env.c.enhanceNow();
    assert.equal(env.state().enhanceStatus, 'error');
    assert.equal(env.state().enhanceError, 'Ollama is not running');

    env.world.llm.answer = styled;
    await env.c.enhanceNow();
    assert.equal(env.state().enhanceStatus, 'up-to-date');
    assert.equal(env.state().enhanceError, null);
  });

  it('rewrites the bullets when the style changes', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    env.world.llm.answer = styled;
    await env.c.enhanceNow();
    assert.match(env.state().enhanced[0].bullet ?? '', /^\*\*Full:\*\*/);
    const topic = env.state().enhanced[2];

    env.c.setEnhanceStyle('concise');
    assert.equal(env.state().enhanceStyle, 'concise');
    await settle();
    assert.deepEqual(
      env.state().enhanced.filter((e) => e.kind === 'item').map((e) => e.bullet?.slice(0, 10)),
      ['**Short:**', '**Short:**', '**Short:**'],
    );
    assert.equal(env.state().enhanced[2], topic);
    assert.equal(env.state().enhanceStatus, 'up-to-date');
    assert.equal(env.world.llm.chats.length, 2);
    // Rewritten, not revised: the bullet of the other style is not handed back.
    assert.doesNotMatch(userMessage(env.world.llm.chats[1]), /<previous/);

    // The same style again is not a reason to run.
    env.c.setEnhanceStyle('concise');
    await settle();
    assert.equal(env.world.llm.chats.length, 2);
  });

  it('only records the style when there is nothing to rewrite', async () => {
    const env = await boot();
    env.c.setEnhanceStyle('concise');
    await settle();
    assert.equal(env.state().enhanceStyle, 'concise');
    assert.equal(env.world.llm.chats.length, 0);
    assert.equal(env.state().enhanceStatus, 'idle');
  });

  it('starts with Live Enhance on when the settings say so, and runs it for what is typed only', async () => {
    const env = await boot({ settings: { liveEnhanceDefault: true } });
    assert.equal(env.state().liveEnhance, true);
    // Selecting a meeting is not typing in it: its lines wait.
    env.c.selectSection(JANE);
    await pass(env.world, 20_000, 500);
    assert.equal(env.world.llm.chats.length, 0);
    assert.equal(env.state().enhanceStatus, 'idle');
    // Nor is a line that arrives by sync, or the daily read again from the file.
    const synced = DAILY.replace('#### Risks', '- added on another device\n#### Risks');
    env.world.notes.setDaily(synced);
    env.session.handleDailyUpdate({ path: DAILY_PATH, text: synced, cursor: null, userTyped: false });
    assert.equal(env.state().shorthand.length, 5);
    await pass(env.world, 20_000, 500);
    assert.equal(env.world.llm.chats.length, 0);

    // The first keystroke takes every waiting line along.
    type(env, synced.replace('- added on another device', '- added on another device, then edited'), '- added');
    await pass(env.world, 2400, 400);
    assert.equal(env.world.llm.chats.length, 0);
    await pass(env.world, 200, 100);
    assert.equal(env.world.llm.chats.length, 1);
    assert.equal(promptItems(env.world.llm.chats[0]).length, 4);
    assert.equal(env.state().enhanceStatus, 'up-to-date');
  });

  it('runs Live Enhance for lines that were waiting once it is switched on, or once there is speech to read', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    env.c.setLiveEnhance(true);
    await pass(env.world, 2600, 200);
    assert.equal(env.world.llm.chats.length, 1, 'switched on by hand: the lines are taken');

    const later = await boot({ settings: { liveEnhanceDefault: true } });
    later.c.selectSection(JANE);
    await later.c.startRecording();
    later.world.sources[0].say('The vendor contract renewal may slip to November, said the vendor.', 0, 35);
    await pass(later.world, 2600, 200);
    assert.equal(later.world.llm.chats.length, 1, 'a stretch of transcript arrived');
    assert.match(userMessage(later.world.llm.chats[0]), /<excerpts>/);
  });

  it('runs once after a burst of typing when live enhance is on', async () => {
    const env = await boot({ settings: { liveModel: 'gemma4:4b' } });
    env.world.llm.answer = styled;
    env.c.setLiveEnhance(true);
    assert.equal(env.state().liveEnhance, true);
    env.c.selectSection(JANE);

    let text = DAILY;
    for (const line of ['- one', '- one two', '- one two three']) {
      await pass(env.world, 500, 500);
      text = DAILY.replace('#### Risks', `${line}\n#### Risks`);
      type(env, text, line);
    }
    // 2.4 s after the last keystroke: still waiting.
    await pass(env.world, 2400, 400);
    assert.equal(env.world.llm.chats.length, 0);
    assert.equal(env.state().enhanced.every((e) => e.bullet === null), true);

    await pass(env.world, 200, 100);
    assert.equal(env.world.llm.chats.length, 1);
    assert.equal(env.world.llm.chats[0].model, 'gemma4:4b');
    assert.deepEqual(
      promptItems(env.world.llm.chats[0]).map((item) => item.text),
      [
        'Q4 roadmap: identity migration first',
        "budget: 2 postes gelés jusqu'en janvier",
        'one two three',
        'vendor contract renewal may slip to Nov',
      ],
    );
    assert.equal(env.state().enhanceStatus, 'up-to-date');

    // Cursor moves report the same lines: nothing more to do.
    type(env, text, '- budget');
    await pass(env.world, 10_000, 500);
    assert.equal(env.world.llm.chats.length, 1);

    // Switched off, typing no longer starts a run.
    env.c.setLiveEnhance(false);
    type(env, text.replace('- one two three', '- one two three four'), '- one two three four');
    await pass(env.world, 10_000, 500);
    assert.equal(env.world.llm.chats.length, 1);
    assert.equal(env.state().enhanced[2].stale, true);
  });
});

describe('the knowledge index', () => {
  it('builds over the chosen folders and remembers them', async () => {
    const env = await boot({ index: true });
    assert.equal(env.state().index.status, 'none');
    assert.deepEqual(env.c.listFolders(), ['00 Inbox', '10 Work', '40 Resources', '40 Resources/People']);

    const statuses: string[] = [];
    env.session.store.subscribe((state, prev) => {
      if (state.index.status !== prev.index.status) statuses.push(state.index.status);
    });
    await env.c.buildIndex(['10 Work']);
    assert.deepEqual(statuses, ['building', 'ready']);
    assert.deepEqual(env.world.settings().indexedFolders, ['10 Work']);
    const index = env.state().index;
    assert.equal(index.files, 2);
    assert.equal(index.done, 2);
    assert.equal(index.total, 2);
    assert.deepEqual(index.folders, ['10 Work']);
    assert.equal(index.error, null);
    assert.ok(env.world.indexIO?.saved, 'the index was persisted');

    // Embedded as the settings say, and marked with the model the vectors come from.
    const request = env.world.llm.embeds[0];
    assert.deepEqual(
      [request.model, request.numCtx, request.dimensions],
      ['embeddinggemma-2:270m', 2048, 768],
    );
    assert.equal(JSON.parse(env.world.indexIO?.saved?.index ?? '{}').model, 'embeddinggemma-2:270m@768');
  });

  it('stops showing an index error once what it was about has worked after all', async () => {
    const env = await boot({ index: true });
    const io = env.world.indexIO;
    assert.ok(io);
    // One note cannot be read during the build: it is still on its way from another device.
    const read = io.read.bind(io);
    let synced = false;
    io.read = async (path) => {
      if (!synced && path === '10 Work/Offsite.md') throw new Error('The note is not available yet.');
      return read(path);
    };
    await env.c.buildIndex(['10 Work']);
    assert.equal(env.state().index.status, 'ready');
    assert.equal(env.state().index.files, 1);
    assert.equal(env.state().index.error, '10 Work/Offsite.md: The note is not available yet.');

    // It arrives, and the vault says so: indexed, and nothing is wrong any more.
    synced = true;
    env.session.handleVaultChange({ type: 'modify', path: '10 Work/Offsite.md' });
    await pass(env.world, 2500);
    assert.equal(env.state().index.files, 2);
    assert.equal(env.state().index.error, null);

    // The same for a save that fails once.
    const save = io.save.bind(io);
    let full = true;
    io.save = async (index, vectors) => {
      if (full) throw new Error('The disk is full.');
      return save(index, vectors);
    };
    await pass(env.world, 30_000, 1000);
    assert.equal(env.state().index.error, 'Could not save the index: The disk is full.');
    full = false;
    env.world.notes.files.set('10 Work/Offsite.md', '# Offsite\n\nThe offsite moves to the lake in March.\n');
    env.session.handleVaultChange({ type: 'modify', path: '10 Work/Offsite.md' });
    await pass(env.world, 33_000, 1000);
    assert.equal(env.state().index.error, null);
    assert.equal(env.state().index.status, 'ready');
  });

  it('pauses a build during a recording, and answers from what is indexed by then', async () => {
    const env = await boot({
      index: true,
      files: { ...NOTES, '10 Work/Zoning.md': '# Zoning\n\nThe zoning request is with the city since May.\n' },
    });
    env.c.selectSection(BOARD);
    env.world.llm.answer = () => 'It is 40000 dollars.';
    const lastPrompt = (): string => userMessage(env.world.llm.chats.at(-1) as ChatRequest);

    // The second note of three stays at the embedder until it is let through.
    const embed = env.world.llm.embed.bind(env.world.llm);
    let release: () => void = () => {};
    let notes = 0;
    env.world.llm.embed = async (req, signal) => {
      if (req.input[0].startsWith('title: ')) {
        notes += 1;
        if (notes === 2) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      }
      return embed(req, signal);
    };

    const building = env.c.buildIndex(['10 Work']);
    await settle();
    assert.equal(env.state().index.status, 'building');
    assert.equal(env.state().index.done, 1);
    // Half an index is not searched: the answer would depend on how far the build got.
    await env.c.ask('What is the training budget for this year?');
    assert.doesNotMatch(lastPrompt(), /Budget 2026/);

    await env.c.startRecording();
    release();
    await settle();
    assert.equal(env.state().index.status, 'paused');
    assert.equal(env.state().index.done, 2);
    await env.c.ask('What is the training budget for this year?');
    assert.match(lastPrompt(), /\] Budget 2026 › Formation\n/);

    await until(env.world, env.c.stopRecording());
    await building;
    assert.equal(env.state().index.status, 'ready');
    assert.equal(env.state().index.files, 3);
  });

  it('is refused while recording, and unavailable without storage', async () => {
    const env = await boot({ index: true });
    env.c.selectSection(JANE);
    await env.c.startRecording();
    await env.c.buildIndex(['10 Work']);
    assert.equal(env.state().index.status, 'none');
    assert.deepEqual(env.world.settings().indexedFolders, []);
    assert.equal(env.world.notes.notices.length, 1);

    const bare = await boot();
    await bare.c.buildIndex(['10 Work']);
    assert.equal(bare.state().index.status, 'none');
    assert.equal(bare.world.notes.notices.length, 1);
  });

  it('can be cancelled', async () => {
    const env = await boot({ index: true });
    const building = env.c.buildIndex(['10 Work', '40 Resources']);
    env.c.cancelIndex();
    await building;
    assert.notEqual(env.state().index.status, 'building');
    assert.ok(env.state().index.files < 3);
  });

  it('starts over with the new folders when asked again mid-build', async () => {
    const env = await boot({ index: true });
    const first = env.c.buildIndex(['10 Work']);
    const second = env.c.buildIndex(['40 Resources']);
    await Promise.all([first, second]);
    assert.deepEqual(env.state().index.folders, ['40 Resources']);
    assert.equal(env.state().index.status, 'ready');
    assert.equal(env.state().index.files, 1);
    assert.deepEqual(env.world.indexIO?.reads, ['40 Resources/People/Jane Example.md'], 'the first build was dropped');
  });

  it('re-indexes a changed note once it settles, without leaving the ready state', async () => {
    const env = await boot({ index: true });
    await env.c.buildIndex(['10 Work']);
    const io = env.world.indexIO;
    assert.ok(io);
    const reads = io.reads.length;
    const statuses: string[] = [];
    env.session.store.subscribe((state, prev) => {
      if (state.index.status !== prev.index.status) statuses.push(state.index.status);
    });

    const path = '10 Work/Offsite.md';
    for (let i = 0; i < 3; i++) {
      env.world.notes.files.set(path, `# Offsite\n\nThe offsite moved to the seaside, draft ${i}.\n`);
      env.session.handleVaultChange({ type: 'modify', path });
      await pass(env.world, 500, 500);
    }
    await pass(env.world, 1400, 700);
    assert.equal(io.reads.length, reads, 'still inside the two seconds after the last change');
    await pass(env.world, 200, 100);
    assert.deepEqual(io.reads.slice(reads), [path]);
    assert.deepEqual(statuses, [], 'the folder controls must not flash');

    env.world.llm.answer = () => 'At the seaside [1].';
    await env.c.ask('Where did the offsite move to?');
    assert.match(userMessage(env.world.llm.chats.at(-1) as ChatRequest), /moved to the seaside, draft 2/);
  });

  it('follows deletes and renames', async () => {
    const env = await boot({ index: true });
    await env.c.buildIndex(['10 Work']);
    const files = env.world.notes.files;

    files.delete('10 Work/Offsite.md');
    env.session.handleVaultChange({ type: 'delete', path: '10 Work/Offsite.md' });
    await settle();
    assert.equal(env.state().index.files, 1);

    const text = files.get('10 Work/Budget 2026.md') ?? '';
    files.delete('10 Work/Budget 2026.md');
    files.set('10 Work/Budget.md', text);
    env.session.handleVaultChange({ type: 'rename', path: '10 Work/Budget.md', oldPath: '10 Work/Budget 2026.md' });
    await settle();
    assert.equal(env.state().index.files, 1);
    env.world.llm.answer = () => 'It is 40000 dollars [1].';
    await env.c.ask('What is the training budget?');
    assert.deepEqual(
      env.state().qa.entries[0].sources.map((s) => s.path),
      ['10 Work/Budget.md'],
    );

    // An edit still waiting to be indexed follows its note to the new name.
    files.set('10 Work/Budget.md', `${text}\nTravel costs were added in the autumn.\n`);
    env.session.handleVaultChange({ type: 'modify', path: '10 Work/Budget.md' });
    await pass(env.world, 1000, 500);
    files.set('10 Work/Costs.md', files.get('10 Work/Budget.md') ?? '');
    files.delete('10 Work/Budget.md');
    env.session.handleVaultChange({ type: 'rename', path: '10 Work/Costs.md', oldPath: '10 Work/Budget.md' });
    await pass(env.world, 2200, 200);
    assert.equal(env.world.indexIO?.reads.at(-1), '10 Work/Costs.md');
    assert.equal(env.state().index.files, 1);
    assert.equal(env.state().index.error, null);
  });

  it('holds changes during a recording and ignores the meeting companion', async () => {
    const env = await withCompanion({ index: true });
    await env.c.buildIndex(['00 Inbox', '10 Work']);
    const io = env.world.indexIO;
    assert.ok(io);
    const reads = io.reads.length;

    env.session.handleVaultChange({ type: 'modify', path: JANE_NOTE });
    await pass(env.world, 3000);
    assert.equal(io.reads.length, reads, 'the companion changes all through the meeting');

    await env.c.startRecording();
    env.world.notes.files.set('10 Work/Offsite.md', '# Offsite\n\nCancelled this year.\n');
    env.session.handleVaultChange({ type: 'modify', path: '10 Work/Offsite.md' });
    env.session.handleVaultChange({ type: 'modify', path: '10 Work/Offsite.md' });
    env.world.notes.files.delete('10 Work/Budget 2026.md');
    env.session.handleVaultChange({ type: 'delete', path: '10 Work/Budget 2026.md' });
    await pass(env.world, 6000);
    assert.equal(io.reads.length, reads);
    assert.equal(env.state().index.files, 4, 'a deleted note waits for the stop too');

    await until(env.world, env.c.stopRecording());
    await pass(env.world, 2500);
    assert.deepEqual(io.reads.slice(reads), ['10 Work/Offsite.md']);
    assert.equal(env.state().index.files, 3);

    // Once the meeting is left, its note is indexed like any other.
    await env.c.endMeeting();
    await settle();
    assert.ok(io.reads.slice(reads).includes(JANE_NOTE));
  });

  it('indexes what changed during a start that failed or was cancelled', async () => {
    const env = await boot({ index: true });
    await env.c.buildIndex(['10 Work']);
    const io = env.world.indexIO;
    assert.ok(io);
    env.c.selectSection(JANE);

    // Cancelled while the worker was loading.
    env.world.prepareSource = (source) => {
      source.startGate = new Promise<void>(() => {});
    };
    let reads = io.reads.length;
    void env.c.startRecording();
    env.world.notes.files.set('10 Work/Offsite.md', '# Offsite\n\nMoved to the seaside.\n');
    env.session.handleVaultChange({ type: 'modify', path: '10 Work/Offsite.md' });
    await pass(env.world, 3000);
    assert.equal(io.reads.length, reads, 'held while the recording may still begin');
    await env.c.stopRecording();
    await pass(env.world, 2500);
    assert.deepEqual(io.reads.slice(reads), ['10 Work/Offsite.md']);

    // Failed on its own.
    let fail = (_error: Error): void => {};
    env.world.prepareSource = (source) => {
      source.startGate = new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
    };
    reads = io.reads.length;
    const starting = env.c.startRecording();
    env.world.notes.files.set('10 Work/Offsite.md', '# Offsite\n\nCancelled this year.\n');
    env.session.handleVaultChange({ type: 'modify', path: '10 Work/Offsite.md' });
    fail(new Error('The microphone is not available.'));
    await starting;
    assert.equal(env.state().recordingError, 'The microphone is not available.');
    await pass(env.world, 2500);
    assert.deepEqual(io.reads.slice(reads), ['10 Work/Offsite.md']);
  });

  it('ignores vault changes until there is an index', async () => {
    const env = await boot({ index: true });
    env.session.handleVaultChange({ type: 'modify', path: '10 Work/Offsite.md' });
    assert.equal(env.world.clock.pending(), 0, 'nothing is even scheduled');
    await pass(env.world, 3000);
    assert.equal(env.world.indexIO?.reads.length, 0);
    assert.equal(env.world.clock.pending(), 0);
  });
});

describe('stats', () => {
  it('are saved at most once a minute while they change', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.enhanceNow();
    assert.equal(env.world.statsIO.saves, 0);
    await pass(env.world, 30_000, 5000);
    await env.c.summarize('recap');
    await pass(env.world, 29_000, 5000);
    assert.equal(env.world.statsIO.saves, 0);
    await pass(env.world, 1500, 500);
    assert.equal(env.world.statsIO.saves, 1);
    assert.equal(env.world.statsIO.stored?.assists, 2);
    assert.equal(env.world.clock.pending(), 0);

    // Nothing changed: nothing to save.
    await env.session.flushAll();
    assert.equal(env.world.statsIO.saves, 1);

    await env.c.ask('Anything about the budget?');
    await env.session.flushAll();
    assert.equal(env.world.statsIO.saves, 2);
    assert.equal(env.world.statsIO.stored?.assists, 3);
    assert.equal(env.world.clock.pending(), 0);
  });

  it('count the tokens under the week of the clock', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.enhanceNow();
    const { stats, lastUsage } = env.state();
    assert.equal(stats.input, lastUsage?.promptTokens);
    assert.equal(stats.output, lastUsage?.outputTokens);
    // 2026-10-09 is a Friday: its week starts on Monday the 5th.
    assert.deepEqual(stats.weekly, { '2026-10-05': { input: stats.input, output: stats.output } });
  });
});

describe('in mid-flight', () => {
  it('drops what the model says after the meeting changed, even a model deaf to the cancel', async () => {
    const env = await withCompanion();
    env.c.selectSection(BOARD);
    await env.c.createCompanion();
    await pass(env.world, 1000);
    env.c.selectSection(JANE);
    await settle();
    const writes = env.world.notes.writes.length;

    // Every call answers when the test says so, cancelled or not.
    const answers: Array<() => void> = [];
    env.world.llm.chatStream = (req, onToken) =>
      new Promise<ChatResult>((resolve) => {
        answers.push(() => {
          onToken?.('Late words', 'Late words');
          resolve({
            text: '1. **Late:** words [1].',
            usage: {
              model: req.model,
              promptTokens: 50,
              cachedTokens: 0,
              outputTokens: 5,
              totalMs: 10,
              loadMs: 0,
              promptMs: 5,
              evalMs: 5,
            },
          });
        });
      });
    const summarizing = env.c.summarize('recap');
    const asking = env.c.ask('What was decided with Jane?');
    const enhancing = env.c.enhanceNow();
    await settle();
    assert.equal(answers.length, 1, 'the model takes one call at a time');
    assert.equal(env.state().summary.status, 'running');
    assert.equal(env.state().qa.entries.length, 1);

    env.c.selectSection(BOARD);
    const board = env.state();
    assert.equal(board.meeting?.key, BOARD);
    assert.deepEqual(board.qa, { entries: [], chips: [] });
    // The slot is given back call by call: whatever was waiting behind gets its turn to be dropped.
    for (let round = 0; round < 4; round++) {
      for (const answer of answers.splice(0)) answer();
      await settle();
    }
    await Promise.all([summarizing, asking, enhancing]);
    await pass(env.world, 6000);

    const after = env.state();
    assert.equal(after.summary, board.summary);
    assert.equal(after.qa, board.qa);
    assert.equal(after.enhanced, board.enhanced);
    assert.equal(after.stats, board.stats);
    assert.equal(after.lastUsage, board.lastUsage);
    assert.equal(after.tab, 'notes');
    assert.equal(env.world.notes.writes.length, writes, 'nothing reached either note');
  });

  it('settles the summary and the answer that were running when it was disposed', async () => {
    const env = await withCompanion();
    const release = env.world.llm.hold();
    const summarizing = env.c.summarize('recap');
    const asking = env.c.ask('What is still running?');
    await settle();
    assert.equal(env.state().summary.status, 'running');
    assert.notEqual(env.state().summary.markdown, '');

    await until(env.world, env.session.dispose());
    const frozen = env.state();
    release();
    await Promise.all([summarizing, asking]);
    await pass(env.world, 10_000, 1000);
    assert.equal(env.state(), frozen);
    assert.equal(env.world.clock.pending(), 0);
    assert.equal(env.world.notes.writes.length, 0, 'half a summary is not saved on the way out');
    assert.equal(region(env, JANE_NOTE, 'summary'), '');
  });

  it('wakes nobody for actions that change nothing', async () => {
    const env = await withCompanion();
    await env.c.enhanceNow();
    await env.c.ask('Where is the offsite?');
    await pass(env.world, 6000);
    const text = env.world.notes.dailyText ?? '';
    const cursor = text.indexOf('- budget');
    env.session.handleDailyUpdate({ path: DAILY_PATH, text, cursor, userTyped: false });
    // Selecting the current meeting again goes back to its notes, and to nothing else.
    env.c.setTab('notes');

    const before = env.state();
    let wakeUps = 0;
    env.session.store.subscribe(() => {
      wakeUps += 1;
    });
    env.session.handleDailyUpdate({ path: DAILY_PATH, text, cursor, userTyped: false });
    env.session.handleDailyAvailability();
    env.session.handleSettingsChange();
    env.session.handleVaultChange({ type: 'modify', path: '10 Work/Offsite.md' });
    env.c.setTab(before.tab);
    env.c.setLiveEnhance(before.liveEnhance);
    env.c.setEnhanceStyle(before.enhanceStyle);
    env.c.selectSection(JANE);
    env.c.cancelSummary();
    env.c.cancelAsk('Q99');
    env.c.cancelAsk(before.qa.entries[0].id);
    env.c.dismissChip('C99');
    env.c.cancelIndex();
    await Promise.all([
      env.c.refreshOllama(),
      env.c.keepInsight('Q99'),
      env.c.stopRecording(),
      env.c.linkAtCursor(),
      env.session.flushAll(),
    ]);
    await pass(env.world, 3000);
    assert.equal(wakeUps, 0);
    assert.equal(env.state(), before);
  });
});

describe('flushAll and dispose', () => {
  it('flushes what is pending and resolves within its cap', async () => {
    const env = await withCompanion();
    await env.c.enhanceNow();
    assert.equal(env.state().pendingWrites, 1);
    await env.session.flushAll();
    assert.equal(env.state().pendingWrites, 0);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /Q4 roadmap/);

    // An editor that keeps the note busy cannot hold the quit hook for ever.
    env.world.notes.recentlyEdited = true;
    await env.c.summarize('recap');
    let flushed = false;
    void env.session.flushAll(1000).then(() => {
      flushed = true;
    });
    await pass(env.world, 900, 300);
    assert.equal(flushed, false);
    await pass(env.world, 200, 100);
    assert.equal(flushed, true);
    assert.equal(env.state().pendingWrites, 1, 'still to be written when the note is free');

    env.world.notes.recentlyEdited = false;
    await pass(env.world, 6000);
    assert.equal(env.state().pendingWrites, 0);
    assert.match(region(env, JANE_NOTE, 'summary'), /^### Recap/);
  });

  it('saves the last words, leaves no timer and turns every action into a no-op', async () => {
    const env = await withCompanion({ index: true });
    await env.c.buildIndex(['10 Work']);
    env.c.setLiveEnhance(true);
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('Said before the window closed.', 1, 3);
    source.lastWords = [{ type: 'segment', source: 'mic', t0: 4, t1: 6, text: 'Said while it closed.', isFinal: true }];
    type(env, (env.world.notes.dailyText ?? '').replace('#### Risks', '- a late line\n#### Risks'), '- a late');
    env.session.handleVaultChange({ type: 'modify', path: '10 Work/Offsite.md' });
    env.world.llm.hold();
    void env.c.summarize('recap');
    void env.c.ask('What is still running?');
    await settle();
    assert.ok(env.world.clock.pending() > 0);

    await until(env.world, env.session.dispose());

    assert.equal(env.world.clock.pending(), 0);
    assert.equal(source.stops, 1);
    assert.equal(source.listeners(), 0);
    assert.match(region(env, JANE_NOTE, 'transcript'), /Said before the window closed\.\n.*Said while it closed\.\n$/);
    assert.equal(env.world.statsIO.stored?.meetings, 1);

    const frozen = env.state();
    const chats = env.world.llm.chats.length;
    const notices = env.world.notes.notices.length;
    const vault = vaultSnapshot(env.world);
    env.c.setTab('stats');
    env.c.selectSection(BOARD);
    env.c.newMeeting();
    env.c.setLiveEnhance(false);
    env.c.setEnhanceStyle('concise');
    env.c.cancelSummary();
    env.c.cancelAsk('Q1');
    env.c.dismissChip('C1');
    env.c.openDaily();
    env.c.openCompanion();
    env.c.cancelIndex();
    env.c.copy('text');
    assert.deepEqual(env.c.listFolders(), []);
    await Promise.all([
      env.c.linkAtCursor(),
      env.c.endMeeting(),
      env.c.createCompanion(),
      env.c.startRecording(),
      env.c.stopRecording(),
      env.c.enhanceNow(),
      env.c.summarize('executive'),
      env.c.ask('Anyone there?'),
      env.c.keepInsight('Q1'),
      env.c.buildIndex(['10 Work']),
      env.c.refreshOllama(),
    ]);
    type(env, DAILY, '- budget');
    env.session.handleDailyAvailability();
    env.session.handleSettingsChange();
    env.session.handleVaultChange({ type: 'modify', path: '10 Work/Offsite.md' });
    await env.session.init();
    await env.session.flushAll();
    await env.session.dispose();
    await pass(env.world, 120_000, 10_000);

    assert.equal(env.state(), frozen);
    assert.equal(env.world.llm.chats.length, chats);
    assert.equal(env.world.notes.notices.length, notices);
    assert.equal(env.world.sources.length, 1);
    assert.deepEqual(env.world.clipboard, []);
    assert.deepEqual(
      vaultSnapshot(env.world).filter(([path]) => path !== DAILY_PATH),
      vault.filter(([path]) => path !== DAILY_PATH),
    );
    assert.equal(env.world.clock.pending(), 0);
  });

  it('says that an action pressed while it is shutting down (a reload of the plugin) was not done', async () => {
    const env = await boot();
    const before = env.world.notes.notices.length;
    const closing = env.session.dispose();
    env.c.newMeeting();
    await env.c.startRecording();
    assert.deepEqual(env.world.notes.notices.slice(before), [
      'Magical Hamster is restarting: that was not done. Try again in a moment.',
      'Magical Hamster is restarting: that was not done. Try again in a moment.',
    ]);
    assert.equal(env.state().meeting, null, 'nothing was started');
    await until(env.world, closing);
  });

  it('saves the index on the way out', async () => {
    const env = await boot({ index: true });
    await env.c.buildIndex(['10 Work']);
    env.world.notes.files.set('10 Work/Offsite.md', '# Offsite\n\nThe offsite moved to the seaside.\n');
    env.session.handleVaultChange({ type: 'modify', path: '10 Work/Offsite.md' });
    await pass(env.world, 2200, 200);
    assert.doesNotMatch(env.world.indexIO?.saved?.index ?? '', /seaside/, 'its own save is half a minute away');

    await until(env.world, env.session.dispose());
    assert.match(env.world.indexIO?.saved?.index ?? '', /seaside/);
    assert.equal(env.world.clock.pending(), 0);
  });

  it('does not wait for an index update that hangs', async () => {
    const env = await boot({ index: true });
    await env.c.buildIndex(['10 Work']);
    // Ollama took the request and never answers.
    env.world.llm.embed = () => new Promise(() => {});
    env.world.notes.files.set('10 Work/Offsite.md', '# Offsite\n\nThe offsite moved to the seaside.\n');
    env.session.handleVaultChange({ type: 'modify', path: '10 Work/Offsite.md' });
    await pass(env.world, 2200, 200);

    await until(env.world, env.session.dispose(), 5000);
    assert.equal(env.world.clock.pending(), 0);
    const frozen = env.state();
    env.c.setTab('stats');
    assert.equal(env.state(), frozen);
  });

  it('can be disposed while the recording is still starting', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    let open = (): void => {};
    env.world.prepareSource = (source) => {
      source.startGate = new Promise<void>((resolve) => {
        open = resolve;
      });
    };
    const starting = env.c.startRecording();
    assert.equal(env.state().recording, 'starting');
    const disposing = env.session.dispose();
    open();
    await Promise.all([starting, disposing]);
    assert.equal(env.world.sources[0].stops, 1);
    assert.equal(env.world.sources[0].listeners(), 0);
    assert.equal(env.world.clock.pending(), 0);
    assert.notEqual(env.state().recording, 'recording');
  });
});

describe('the controller', () => {
  it('never throws or rejects when a host does', async () => {
    const env = await boot({ local: { firstWriteConfirmed: true } });
    const boom = (): never => {
      throw new Error('The vault is not available.');
    };
    env.world.notes.openNote = boom;
    env.world.notes.exists = boom;
    env.world.notes.findCompanion = boom;
    env.world.notes.listFolders = boom;
    env.world.notes.insertDailyLink = async () => boom();
    env.world.deps.clipboard = boom;

    env.c.openDaily();
    env.c.copy('text');
    assert.deepEqual(env.c.listFolders(), []);
    env.c.selectSection(JANE);
    assert.equal(env.state().meeting?.key, JANE);
    env.c.openCompanion();
    await env.c.createCompanion();
    await env.c.linkAtCursor();
    assert.equal(env.state().meeting?.companionPath, null);
    assert.ok(env.world.notes.notices.length >= 3);
    assert.ok(env.world.notes.notices.every((message) => message.trim() !== ''));

    // The session is still usable.
    await env.c.enhanceNow();
    assert.equal(env.state().enhanceStatus, 'up-to-date');
  });

  it('copies through the host and switches tabs', async () => {
    const env = await boot();
    env.c.copy('- a bullet');
    env.c.setTab('stats');
    assert.deepEqual(env.world.clipboard, ['- a bullet']);
    assert.equal(env.state().tab, 'stats');
  });
});

describe('describeError', () => {
  it('speaks plainly about Ollama', () => {
    assert.equal(describeError(new OllamaError('unreachable', 'fetch failed')), 'Ollama is not running.');
    assert.equal(
      describeError(new OllamaError('model_missing', 'not found', { model: 'gemma4:12b' })),
      'Model gemma4:12b is not installed. Run: ollama pull gemma4:12b',
    );
    assert.equal(describeError(new OllamaError('busy', 'HTTP 503')), 'Ollama is busy. Try again in a moment.');
    assert.equal(describeError(new OllamaError('stalled', 'nothing for 60 s')), 'The model stopped responding.');
    assert.equal(describeError(new OllamaError('aborted', 'cancelled')), 'Cancelled.');
    assert.equal(
      describeError(new OllamaError('http', 'Ollama answered HTTP 500: oops')),
      'Ollama answered HTTP 500: oops',
    );
    assert.equal(describeError(new OllamaError('protocol', 'Unexpected response')), 'Unexpected response');
  });

  it('reads the kind of an error whoever raised it', () => {
    assert.equal(describeError(Object.assign(new Error('x'), { kind: 'unreachable' })), 'Ollama is not running.');
    assert.equal(describeError(Object.assign(new Error('x'), { name: 'AbortError' })), 'Cancelled.');
    assert.equal(
      describeError(Object.assign(new Error('The model is gone.'), { kind: 'model_missing' })),
      'The model is gone.',
    );
  });

  it('falls back on the message, then on a plain sentence', () => {
    assert.equal(describeError(new Error('The microphone is not available.')), 'The microphone is not available.');
    assert.equal(describeError(new Error('')), 'Something went wrong.');
    assert.equal(describeError('a string'), 'Something went wrong.');
    assert.equal(describeError(null), 'Something went wrong.');
    assert.equal(describeError(undefined), 'Something went wrong.');
    assert.equal(describeError({ message: 'not an error' }), 'Something went wrong.');
  });
});

describe('the fakes', () => {
  it('fire timers in order, including those armed on the way', () => {
    const clock = new ManualClock(0);
    const fired: string[] = [];
    clock.setTimeout(() => {
      fired.push(`a@${clock.now()}`);
      clock.setTimeout(() => fired.push(`c@${clock.now()}`), 10);
    }, 20);
    clock.setTimeout(() => fired.push(`b@${clock.now()}`), 25);
    const every = clock.setInterval(() => fired.push(`tick@${clock.now()}`), 40);
    const never = clock.setTimeout(() => fired.push('never'), 30);
    clock.clearTimeout(never);
    clock.advance(100);
    assert.deepEqual(fired, ['a@20', 'b@25', 'c@30', 'tick@40', 'tick@80']);
    assert.equal(clock.now(), 100);
    assert.equal(clock.pending(), 1);
    clock.clearInterval(every);
    assert.equal(clock.pending(), 0);
  });

  it('merge regions for real and answer retry, detached and missing', async () => {
    const env = await withCompanion();
    const notes = env.world.notes;
    assert.deepEqual(await notes.writeCompanion('nowhere.md', []), { status: 'missing' });
    notes.recentlyEdited = true;
    assert.deepEqual(await notes.writeCompanion(JANE_NOTE, [{ region: 'qa', content: 'x' }]), {
      status: 'retry',
      afterMs: 500,
    });
    notes.recentlyEdited = false;
    notes.files.set(JANE_NOTE, (notes.files.get(JANE_NOTE) ?? '').replace('<!-- hamster:begin summary -->\n', ''));
    assert.deepEqual(
      await notes.writeCompanion(JANE_NOTE, [
        { region: 'summary', content: 'lost' },
        { region: 'qa', content: 'kept' },
      ]),
      { status: 'detached', regions: ['summary'] },
    );
    assert.equal(readRegion(notes.files.get(JANE_NOTE) ?? '', 'qa'), 'kept\n');
    await assert.rejects(notes.createCompanion(JANE_NOTE, 'again'));
  });

  it('insert the link line once, where the real plugin would', async () => {
    const notes = new FakeNotesHost();
    notes.setDaily('### 1:1 [[Jane Example]]\nA paragraph, not a list.\n\n### Other\n');
    const args = {
      section: { title: '1:1 Jane Example', ordinal: 0 },
      companionBasename: 'Mtg-2026-10-09 — 1-1 Jane Example',
      line: JANE_LINK,
      placement: 'section-end' as const,
    };
    assert.deepEqual(await notes.insertDailyLink(args), { status: 'inserted', via: 'editor' });
    assert.equal(notes.dailyText, `### 1:1 [[Jane Example]]\nA paragraph, not a list.\n${JANE_LINK}\n\n### Other\n`);
    // Same target under another alias: still the same link.
    assert.deepEqual(await notes.insertDailyLink({ ...args, line: JANE_LINK.replace('Meeting notes', 'Notes') }), {
      status: 'exists',
    });
    // A section that is gone is still found through the link to its companion.
    assert.deepEqual(await notes.insertDailyLink({ ...args, section: { title: 'Renamed since', ordinal: 0 } }), {
      status: 'exists',
    });
    assert.deepEqual(
      await notes.insertDailyLink({ ...args, section: { title: 'Nope', ordinal: 0 }, companionBasename: 'Mtg-other' }),
      { status: 'no-section' },
    );
    // A second companion for the same section is another link.
    assert.deepEqual(
      await notes.insertDailyLink({ ...args, companionBasename: `${args.companionBasename} (2)`, line: '↳ [[x]]' }),
      { status: 'inserted', via: 'editor' },
    );
    notes.setDaily(null);
    assert.deepEqual(await notes.insertDailyLink(args), { status: 'no-daily' });
  });

  it('embed related texts closer than unrelated ones, and honour an abort', async () => {
    const llm = new FakeOllama();
    const { vectors } = await llm.embed({
      model: 'embeddinggemma-2:270m',
      numCtx: 2048,
      dimensions: 256,
      input: [
        'task: search result | query: training budget this year',
        'title: Budget 2026 | text: The training budget for this year is 40000 dollars.',
        'title: none | text: The offsite takes place in the mountains in February.',
      ],
    });
    const dot = (a: Float32Array, b: Float32Array): number => a.reduce((sum, x, i) => sum + x * b[i], 0);
    assert.equal(vectors[0].length, 256);
    assert.ok(dot(vectors[0], vectors[1]) > dot(vectors[0], vectors[2]));

    llm.hold();
    const abort = new AbortController();
    const tokens: string[] = [];
    const chat = llm.chatStream(
      { model: 'gemma4:12b', numCtx: 4096, messages: [{ role: 'user', content: 'Question: anything?' }] },
      (delta) => tokens.push(delta),
      abort.signal,
    );
    await settle();
    assert.equal(tokens.length, 1);
    abort.abort();
    await assert.rejects(chat, (e: unknown) => describeError(e) === 'Cancelled.');
    assert.equal(tokens.length, 1);
  });

  it('assemble a complete set of dependencies', async () => {
    const notes = new FakeNotesHost();
    notes.setDaily(DAILY);
    const deps = makeDeps({ notes });
    assert.equal(deps.settings().llmModel, 'gemma4:12b');
    await deps.updateSettings({ indexedFolders: ['10 Work'] });
    assert.deepEqual(deps.settings().indexedFolders, ['10 Work']);
    deps.setLocal({ firstWriteConfirmed: true });
    assert.equal(deps.local().firstWriteConfirmed, true);

    const session = createSession(deps);
    await session.init();
    assert.equal(session.store.getState().sections.length, 4);
    await session.dispose();
  });
});

describe('how long the model stays loaded', () => {
  it('is five minutes after a call made outside a recording and thirty during one, never for good', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.enhanceNow();
    await env.c.ask('What is the plan?');

    await env.c.startRecording();
    env.world.sources[0].say('We agreed on the plan.', 1, 3);
    type(env, DAILY.replace('- Q4 roadmap: identity migration first', '- Q4 roadmap: network first'), '- Q4 roadmap');
    await env.c.enhanceNow();
    await env.c.ask('And the budget?');

    // The stop writes the summary; a line fixed afterwards is the last request the model gets.
    await until(env.world, env.c.stopRecording());
    await settle();
    assert.equal(env.state().summary.status, 'done');
    type(env, DAILY.replace('- Q4 roadmap: identity migration first', '- Q4 roadmap: storage first'), '- Q4 roadmap');
    await env.c.enhanceNow();

    assert.deepEqual(
      env.world.llm.chats.map((req) => req.keepAlive),
      ['5m', '5m', '30m', '30m', '5m', '5m'],
    );
  });

  it('is the same for the model of Live Enhance', async () => {
    const env = await boot({ settings: { liveModel: 'gemma4:4b', liveEnhanceDefault: true } });
    env.c.selectSection(JANE);
    type(env, DAILY.replace('#### Risks', '- one more\n#### Risks'), '- one more');
    await pass(env.world, 3000);
    assert.deepEqual(
      env.world.llm.chats.map((req) => [req.model, req.keepAlive]),
      [['gemma4:4b', '5m']],
    );
  });
});

describe('the stop of a recording', () => {
  it('does not count the time the stop itself takes on the meeting clock', async () => {
    const env = await boot();
    // The worker takes two seconds to hand in its last words: the microphone is released by then.
    env.world.prepareSource = (source) => {
      const stop = source.stop.bind(source);
      source.stop = () =>
        new Promise<void>((resolve) => {
          env.world.clock.setTimeout(() => void stop().then(resolve), 2000);
        });
    };
    env.c.selectSection(JANE);
    await env.c.startRecording();
    await pass(env.world, 60_000, 1000);
    assert.equal(env.state().elapsedMs, 60_000);

    const asked = env.world.clock.now();
    await until(env.world, env.c.stopRecording());
    await settle();
    assert.ok(env.world.clock.now() - asked >= 2000, 'the stop took its time');
    assert.equal(env.state().elapsedMs, 60_000, 'and none of it was recorded');
    assert.equal(env.state().meeting?.endedAt, asked + 2000, 'the meeting ended when the stop was over');

    // The next recording of the meeting goes on from there.
    await until(env.world, env.c.startRecording());
    env.world.sources[1].say('Said one second in.', 1, 2);
    assert.equal(env.state().turns[0].t0, 61);
  });
});

describe('the knowledge index, while it is being built', () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 6; i++) files[`Notes/n${i}.md`] = `# Note ${i}\n\nCommittee ${i} decided on pineapple ${i}.\n`;

  /** Every note takes a second at the embedder: the build is still running when the vault changes. */
  function slowEmbedder(env: Env): void {
    const embed = env.world.llm.embed.bind(env.world.llm);
    env.world.llm.embed = async (req, signal) => {
      if (req.input[0].startsWith('title: ')) {
        await new Promise<void>((resolve) => {
          env.world.clock.setTimeout(resolve, 1000);
        });
      }
      return embed(req, signal);
    };
  }

  it('takes in a note that is edited and one that is deleted during the build', async () => {
    const env = await boot({ index: true, files });
    slowEmbedder(env);
    const io = env.world.indexIO;
    assert.ok(io);
    const building = env.c.buildIndex(['Notes']);
    await pass(env.world, 3000, 500);
    assert.equal(env.state().index.status, 'building');
    assert.ok(env.state().index.done >= 2, 'the first notes are in');

    env.world.notes.files.set('Notes/n0.md', '# Note 0\n\nCommittee 0 reversed itself and chose mango.\n');
    env.session.handleVaultChange({ type: 'modify', path: 'Notes/n0.md' });
    env.world.notes.files.delete('Notes/n1.md');
    env.session.handleVaultChange({ type: 'delete', path: 'Notes/n1.md' });

    await until(env.world, building, 60_000);
    // Past the two seconds a change waits to settle, and the half minute between two saves of the index.
    await pass(env.world, 40_000, 1000);
    assert.equal(env.state().index.status, 'ready');
    assert.equal(env.state().index.files, 5, 'the deleted note is gone from the index');
    assert.equal(io.reads.filter((path) => path === 'Notes/n0.md').length, 2, 'the edited note was read again');
    assert.match(io.saved?.index ?? '', /mango/);
    assert.doesNotMatch(io.saved?.index ?? '', /n1\.md/);
  });

  it('takes them in too when the build is paused for a meeting', async () => {
    const env = await boot({ index: true, files });
    slowEmbedder(env);
    const io = env.world.indexIO;
    assert.ok(io);
    const building = env.c.buildIndex(['Notes']);
    await pass(env.world, 3000, 500);
    env.c.selectSection(JANE);
    await until(env.world, env.c.startRecording());
    await pass(env.world, 3000, 500);
    assert.equal(env.state().index.status, 'paused');

    env.world.notes.files.set('Notes/n0.md', '# Note 0\n\nCommittee 0 reversed itself and chose mango.\n');
    env.session.handleVaultChange({ type: 'modify', path: 'Notes/n0.md' });
    env.world.notes.files.delete('Notes/n1.md');
    env.session.handleVaultChange({ type: 'delete', path: 'Notes/n1.md' });
    await pass(env.world, 5000, 500);

    await until(env.world, env.c.stopRecording(), 60_000);
    await until(env.world, building, 60_000);
    await pass(env.world, 40_000, 1000);
    assert.equal(env.state().index.status, 'ready');
    assert.equal(env.state().index.files, 5);
    assert.equal(io.reads.filter((path) => path === 'Notes/n0.md').length, 2);
    assert.match(io.saved?.index ?? '', /mango/);
    assert.doesNotMatch(io.saved?.index ?? '', /n1\.md/);
  });

  it('still ignores them after a build that failed, until the next one', async () => {
    const env = await boot({ index: true, files });
    env.world.llm.embedError = unreachableError();
    await env.c.buildIndex(['Notes']);
    assert.equal(env.state().index.status, 'error');
    const pending = env.world.clock.pending();
    env.session.handleVaultChange({ type: 'modify', path: 'Notes/n0.md' });
    assert.equal(env.world.clock.pending(), pending, 'nothing is scheduled against a server that just failed');
  });
});

describe('a companion created just before the meeting is left', () => {
  /** Recorded, enhanced and summarized before any note exists. */
  async function unsaved(): Promise<Env> {
    const env = await boot({ local: { firstWriteConfirmed: true } });
    // The daily is not open in an editor and was edited a moment ago: the host waits before it adds the line.
    const insert = env.world.notes.insertDailyLink.bind(env.world.notes);
    env.world.notes.insertDailyLink = async (args) => {
      await new Promise<void>((resolve) => {
        env.world.clock.setTimeout(resolve, 2000);
      });
      return insert(args);
    };
    env.c.selectSection(JANE);
    await env.c.startRecording();
    env.world.sources[0].say('We agreed to raise the budget by ten percent.', 1, 4);
    await until(env.world, env.c.stopRecording());
    await settle();
    await env.c.enhanceNow();
    assert.equal(env.state().summary.status, 'done');
    return env;
  }

  function saved(env: Env): [boolean, boolean, boolean] {
    return [
      /raise the budget/.test(region(env, JANE_NOTE, 'transcript')),
      /^- \*\*Note:\*\*/m.test(region(env, JANE_NOTE, 'enhanced')),
      /Executive summary/.test(region(env, JANE_NOTE, 'summary')),
    ];
  }

  it('holds everything that was in memory when another meeting is selected while the link is added', async () => {
    const env = await unsaved();
    const creating = env.c.createCompanion();
    await settle();
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    env.c.selectSection(BOARD);
    assert.equal(env.state().meeting?.key, BOARD);
    await until(env.world, creating);
    await pass(env.world, 8000);
    assert.deepEqual(saved(env), [true, true, true]);
  });

  it('holds it too when the meeting is ended meanwhile, and writes nothing twice', async () => {
    const env = await unsaved();
    const creating = env.c.createCompanion();
    await settle();
    const ending = env.c.endMeeting();
    await until(env.world, Promise.all([creating, ending]));
    await pass(env.world, 8000);
    assert.equal(env.state().meeting, null);
    assert.deepEqual(saved(env), [true, true, true]);
    assert.equal(region(env, JANE_NOTE, 'transcript').match(/raise the budget/g)?.length, 1);
  });

  it('writes each line once when nobody leaves', async () => {
    const env = await unsaved();
    await until(env.world, env.c.createCompanion());
    await pass(env.world, 8000);
    assert.deepEqual(saved(env), [true, true, true]);
    assert.equal(region(env, JANE_NOTE, 'transcript').match(/raise the budget/g)?.length, 1);
  });
});

describe('settings changed while the plugin runs', () => {
  it('takes the Enhance style from the settings tab at once, and keeps a choice made in the sidebar otherwise', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    env.world.setSettings({ enhanceStyle: 'concise' });
    env.session.handleSettingsChange();
    assert.equal(env.state().enhanceStyle, 'concise');
    await env.c.enhanceNow();
    assert.match(env.world.llm.chats[0].messages[0].content, /at most 12 words/);

    // Chosen in the sidebar for this session: another setting that changes does not undo it.
    env.c.setEnhanceStyle('standard');
    await settle();
    env.world.setSettings({ micLabel: 'Mic (room)' });
    env.session.handleSettingsChange();
    assert.equal(env.state().enhanceStyle, 'standard');
    assert.equal(env.state().micLabel, 'Mic (room)');
  });

  it('says that Ollama is on another computer the moment its address says so, answer or no answer', async () => {
    const env = await boot();
    const local = env.state().ollama;
    assert.deepEqual(local, { status: 'ok', missingModels: [], remoteHost: null });

    // Nothing answers at the new address, and nothing ever will.
    env.world.llm.tags = () => new Promise<string[]>(() => {});
    env.world.setSettings({ ollamaUrl: 'http://192.168.1.50:11434' });
    env.session.handleSettingsChange();
    assert.equal(env.state().ollama.remoteHost, '192.168.1.50', 'at once');
    await settle();
    assert.deepEqual(env.state().ollama, { status: 'ok', missingModels: [], remoteHost: '192.168.1.50' });

    // Another spelling of this computer is this computer.
    env.world.setSettings({ ollamaUrl: 'http://127.0.0.1:11434/' });
    env.session.handleSettingsChange();
    assert.equal(env.state().ollama.remoteHost, null);

    // A setting that has nothing to do with it leaves the object alone: the header is not redrawn.
    const before = env.state().ollama;
    env.world.setSettings({ micLabel: 'Mic (room)' });
    env.session.handleSettingsChange();
    assert.equal(env.state().ollama, before);
  });

  it('keeps the host of a remote Ollama through every check, up or down', async () => {
    const world = makeWorld({ daily: DAILY, settings: { ollamaUrl: 'https://ollama.example.com' } });
    world.llm.installed = unreachableError();
    const session = createSession(world.deps);
    assert.deepEqual(session.store.getState().ollama, {
      status: 'unknown',
      missingModels: [],
      remoteHost: 'ollama.example.com',
    });
    await session.init();
    assert.deepEqual(session.store.getState().ollama, {
      status: 'unreachable',
      missingModels: [],
      remoteHost: 'ollama.example.com',
    });

    world.llm.installed = ['gemma4:12b'];
    await session.controller.refreshOllama();
    assert.deepEqual(session.store.getState().ollama, {
      status: 'ok',
      missingModels: ['embeddinggemma-2:270m'],
      remoteHost: 'ollama.example.com',
    });

    // The address changes while a check is out: the answer is published with the host of now.
    let answer: (tags: string[]) => void = () => {};
    world.llm.tags = () =>
      new Promise<string[]>((resolve) => {
        answer = resolve;
      });
    const checking = session.controller.refreshOllama();
    world.setSettings({ ollamaUrl: 'http://localhost:11434' });
    answer(['gemma4:12b', 'embeddinggemma-2:270m']);
    await checking;
    assert.deepEqual(session.store.getState().ollama, { status: 'ok', missingModels: [], remoteHost: null });
  });

  it('follows the address when Ollama is down, and when the check that would tell is dropped for a newer one', async () => {
    const env = await boot();
    env.world.llm.installed = unreachableError();
    await env.c.refreshOllama();
    assert.equal(env.state().ollama.status, 'unreachable');

    env.world.setSettings({ ollamaUrl: 'http://10.0.0.7:11434' });
    env.session.handleSettingsChange();
    assert.deepEqual(env.state().ollama, { status: 'unreachable', missingModels: [], remoteHost: '10.0.0.7' });
    await settle();
    assert.deepEqual(env.state().ollama, { status: 'unreachable', missingModels: [], remoteHost: '10.0.0.7' });

    // Typed letter by letter: each change starts a check, and only the last one is heard.
    env.world.setSettings({ ollamaUrl: 'http://ollama.example.com:11434' });
    env.session.handleSettingsChange();
    env.world.setSettings({ ollamaUrl: 'not an address' });
    env.session.handleSettingsChange();
    assert.equal(env.state().ollama.remoteHost, null, 'nothing is sent anywhere');
    await settle();
    assert.equal(env.state().ollama.remoteHost, null);
  });

  it('says that the index was built with another embedding model, until it is rebuilt', async () => {
    const env = await boot({ index: true });
    await env.c.buildIndex(['10 Work']);
    assert.equal(env.state().index.status, 'ready');
    assert.equal(env.state().index.modelPending, undefined);

    env.world.llm.installed = ['gemma4:12b', 'other-embedder:1b'];
    env.world.setSettings({ embedModel: 'other-embedder:1b' });
    env.session.handleSettingsChange();
    await settle();
    assert.equal(env.state().index.modelPending, true, 'the sidebar can say so');
    assert.equal(env.state().index.status, 'ready');
    assert.equal(env.state().index.files, 2, 'the index itself waits for a rebuild');

    // Nothing of it is answered from meanwhile.
    env.world.llm.answer = () => 'The notes do not say.';
    await env.c.ask('What is the training budget for this year?');
    assert.deepEqual(env.state().qa.entries[0].sources, []);
    assert.doesNotMatch(userMessage(env.world.llm.chats.at(-1) as ChatRequest), /40000 dollars/);

    const embeds = env.world.llm.embeds.length;
    await env.c.buildIndex(env.state().index.folders);
    assert.equal(env.state().index.status, 'ready');
    assert.equal(env.state().index.modelPending, undefined);
    assert.ok(env.world.llm.embeds.slice(embeds).some((req) => req.model === 'other-embedder:1b'), 'built with the new model');

    // A setting that leaves the model alone does not redraw the block.
    const before = env.state().index;
    env.world.setSettings({ micLabel: 'Mic (room)' });
    env.session.handleSettingsChange();
    assert.equal(env.state().index, before);
  });
});

describe('the notes a question reads', () => {
  it('are those linked from the heading first, then those linked from the lines under it', async () => {
    const daily = [
      '### [[Steering Board]] with [[Jane Example]]',
      '- review [[Budget 2026]] and the [[Offsite|offsite]] plan',
      '- [[Jane Example]] presents; see [[10 Work/Budget 2026#Formation]]',
      '',
    ].join('\n');
    const env = await boot({ daily });
    env.c.selectSection('Steering Board with Jane Example#0');
    assert.ok(env.state().meeting, 'the section is a meeting');
    await env.c.ask('What is the training budget for this year?');
    assert.deepEqual(env.world.notes.linkedReads, [
      { links: ['Steering Board', 'Jane Example', 'Budget 2026', 'Offsite', '10 Work/Budget 2026'], maxChars: 2500 },
    ]);
    assert.match(userMessage(env.world.llm.chats[0]), /40000 dollars/);
  });
});

describe('the indexed folders, changed in the settings', () => {
  const HEALTH = { '60 Health/Checkup.md': '# Checkup\n\nThe yearly checkup found a mild allergy to hazelnuts.\n' };

  /** What the settings tab does when a field is saved. */
  function saveSetting(env: Env, folders: string[]): void {
    env.world.setSettings({ indexedFolders: folders });
    env.session.handleSettingsChange();
  }

  it('reach the sidebar before there is an index', async () => {
    const env = await boot({ index: true });
    assert.deepEqual(env.state().index.folders, []);
    saveSetting(env, ['10 Work']);
    assert.deepEqual(env.state().index, { status: 'none', files: 0, chunks: 0, done: 0, total: 0, folders: ['10 Work'], error: null });
    assert.equal(env.world.llm.embeds.length, 0, 'nothing is built by typing a folder name');

    // What "Build index" sends while the picker is closed.
    await env.c.buildIndex(env.state().index.folders);
    assert.equal(env.state().index.status, 'ready');
    assert.equal(env.state().index.files, 2);
  });

  it('reach the sidebar when a folder is added, and Rebuild applies the list instead of undoing it', async () => {
    const env = await boot({ index: true });
    await env.c.buildIndex(['10 Work']);
    assert.equal(env.state().index.foldersPending ?? false, false);

    saveSetting(env, ['10 Work', '40 Resources']);
    assert.deepEqual(env.state().index.folders, ['10 Work', '40 Resources']);
    assert.equal(env.state().index.status, 'ready');
    assert.equal(env.state().index.files, 2, 'the index itself waits for a rebuild');
    assert.equal(env.state().index.foldersPending, true, 'and the sidebar can say so');

    await env.c.buildIndex(env.state().index.folders);
    assert.equal(env.state().index.files, 3);
    assert.deepEqual(env.world.settings().indexedFolders, ['10 Work', '40 Resources']);
    assert.equal(env.state().index.foldersPending ?? false, false);
  });

  it('stop a removed folder from being cited at once, and Rebuild does not bring it back', async () => {
    const env = await boot({ index: true, files: { ...NOTES, ...HEALTH } });
    await env.c.buildIndex(['10 Work', '60 Health']);
    env.world.llm.answer = () => 'A mild allergy to hazelnuts [1].';
    await env.c.ask('What did the yearly checkup find?');
    assert.deepEqual(env.state().qa.entries[0].sources.map((source) => source.path), ['60 Health/Checkup.md']);

    saveSetting(env, ['10 Work']);
    assert.deepEqual(env.state().index.folders, ['10 Work']);
    assert.equal(env.state().index.foldersPending, true);
    await env.c.ask('What did the yearly checkup find?');
    assert.doesNotMatch(userMessage(env.world.llm.chats.at(-1) as ChatRequest), /hazelnuts/);
    assert.ok(env.state().qa.entries[1].sources.every((source) => !source.path?.startsWith('60 Health/')));
    // The other folder still answers.
    env.world.llm.answer = () => 'It is 40000 dollars [1].';
    await env.c.ask('What is the training budget for this year?');
    assert.deepEqual(env.state().qa.entries[2].sources.map((source) => source.path), ['10 Work/Budget 2026.md']);

    await env.c.buildIndex(env.state().index.folders);
    assert.deepEqual(env.world.settings().indexedFolders, ['10 Work']);
    assert.equal(env.state().index.files, 2);
    assert.doesNotMatch(env.world.indexIO?.saved?.index ?? '', /Checkup/);
  });

  it('take the same path when they arrive by sync, and are not shown over a build that is running', async () => {
    const env = await boot({ index: true });
    await env.c.buildIndex(['10 Work']);
    // Held at the embedder: the build over the new list is still running.
    const embed = env.world.llm.embed.bind(env.world.llm);
    let release: () => void = () => {};
    env.world.llm.embed = async (req, signal) => {
      if (req.input[0].startsWith('title: ')) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return embed(req, signal);
    };
    const building = env.c.buildIndex(['40 Resources']);
    await settle();
    assert.equal(env.state().index.status, 'building');
    saveSetting(env, ['10 Work', '40 Resources']);
    assert.deepEqual(env.state().index.folders, ['40 Resources'], 'the folders being built');
    release();
    await building;
    assert.deepEqual(env.state().index.folders, ['10 Work', '40 Resources'], 'then the list of the settings again');
    assert.equal(env.state().index.foldersPending, true);
  });

  it('mean no folder at all once the list is emptied: nothing of the index is searched, and Rebuild does not bring its folders back', async () => {
    const env = await boot({ index: true });
    await env.c.buildIndex(['10 Work']);
    env.world.llm.answer = () => 'It is 40000 dollars [1].';
    await env.c.ask('What is the training budget for this year?');
    assert.deepEqual(env.state().qa.entries[0].sources.map((source) => source.path), ['10 Work/Budget 2026.md']);

    saveSetting(env, []);
    assert.deepEqual(env.state().index.folders, [], 'the sidebar shows the choice, which is none');
    assert.equal(env.state().index.foldersPending, true, 'and that the index was built over something else');
    assert.equal(env.state().index.status, 'ready');
    assert.equal(env.state().index.files, 2, 'the index itself waits for a rebuild');
    assert.equal(indexFoldersNote(env.state().index), INDEX_NO_FOLDERS_TEXT);

    const embeds = env.world.llm.embeds.length;
    await env.c.ask('What is the training budget for this year?');
    assert.equal(env.world.llm.embeds.length, embeds, 'the index is not even asked');
    assert.doesNotMatch(userMessage(env.world.llm.chats.at(-1) as ChatRequest), /half of it is already committed/);
    assert.deepEqual(env.state().qa.entries[1].sources, []);

    // What "Rebuild index" sends while the picker is closed: the list shown, which is empty.
    await env.c.buildIndex(env.state().index.folders);
    assert.deepEqual(env.world.settings().indexedFolders, []);
    assert.equal(env.state().index.status, 'none');
    assert.equal(env.state().index.files, 0);
    assert.equal(env.state().index.foldersPending ?? false, false);
  });

  it('are still none, and nothing is pending, before the user ever chose and before any index exists', async () => {
    const env = await boot({ index: true });
    env.session.handleSettingsChange();
    assert.deepEqual(env.state().index, { status: 'none', files: 0, chunks: 0, done: 0, total: 0, folders: [], error: null });
    env.world.llm.answer = () => 'I do not know.';
    await env.c.ask('What is the training budget for this year?');
    assert.deepEqual(env.state().qa.entries[0].sources, []);
    assert.equal(env.world.llm.embeds.length, 0, 'nothing is indexed, nothing is built');
  });
});

describe('a recorded meeting that is in no note yet', () => {
  const NOT_SAVED = /^This meeting is not saved yet\./;

  /** Recorded and stopped, with its summary, before any companion was created. */
  async function recordedOnly(): Promise<Env> {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    env.world.sources[0].say('We agreed on the plan.', 1, 3);
    env.world.sources[0].say('And on the budget.', 4, 6);
    await until(env.world, env.c.stopRecording());
    await settle();
    assert.equal(env.state().summary.status, 'done');
    assert.equal(env.state().meeting?.companionPath, null);
    return env;
  }

  it('is not dropped by a click on another meeting: the first one says so, the same one again discards it', async () => {
    const env = await recordedOnly();
    env.c.selectSection(BOARD);
    assert.equal(env.state().meeting?.key, JANE, 'still the meeting that was recorded');
    assert.equal(env.state().turns.length, 2);
    assert.equal(env.state().summary.status, 'done');
    assert.equal(env.world.notes.notices.length, 1);
    assert.match(env.world.notes.notices[0], NOT_SAVED);
    assert.match(env.world.notes.notices[0], /Create the companion note to keep it, or select the other meeting again to discard it\./);

    // Another request is another question, asked once in its turn.
    env.c.newMeeting();
    assert.equal(env.state().meeting?.key, JANE);
    assert.equal(env.world.notes.notices.length, 2);
    assert.match(env.world.notes.notices[1], /or press New meeting again to discard it\./);
    env.c.selectSection(BOARD);
    assert.equal(env.state().meeting?.key, JANE);
    assert.equal(env.world.notes.notices.length, 3);

    await readNotice(env);
    env.c.selectSection(BOARD);
    assert.equal(env.state().meeting?.key, BOARD);
    assert.equal(env.state().turns.length, 0);
    assert.equal(env.world.notes.notices.length, 3);
    assert.deepEqual([...env.world.notes.files.keys()].filter((path) => path.includes('Mtg-')), []);
  });

  it('keeps its notice on screen for as long as the same request still discards', async () => {
    const env = await recordedOnly();
    env.c.selectSection(BOARD);
    assert.match(env.world.notes.notices.at(-1) ?? '', NOT_SAVED);
    assert.equal(env.world.notes.noticeMs.at(-1), 15_000, 'the fifteen seconds of the window');
    // Any other notice keeps Obsidian's own duration.
    await env.c.writeIntoActiveNote();
    assert.match(env.world.notes.notices.at(-1) ?? '', /Open the note to write the meeting into first/);
    assert.equal(env.world.notes.noticeMs.at(-1), undefined);
    assert.equal(env.world.notes.noticeMs.length, env.world.notes.notices.length);
  });

  it('is kept when the companion is created instead, and then left without a word', async () => {
    const env = await recordedOnly();
    env.c.selectSection(BOARD);
    assert.equal(env.world.notes.notices.length, 1);
    env.world.deps.setLocal({ firstWriteConfirmed: true });
    await until(env.world, env.c.createCompanion());
    env.c.selectSection(BOARD);
    assert.equal(env.state().meeting?.key, BOARD);
    assert.equal(env.world.notes.notices.length, 1);
    await pass(env.world, 6200);
    assert.match(region(env, JANE_NOTE, 'transcript'), /We agreed on the plan\.\n.*And on the budget\./);
    assert.match(region(env, JANE_NOTE, 'summary'), /Executive summary/);
  });

  it('is not dropped by New meeting or by End either, until they are asked for again', async () => {
    const fresh = await recordedOnly();
    fresh.c.newMeeting();
    assert.equal(fresh.state().meeting?.key, JANE);
    assert.equal(fresh.state().turns.length, 2);
    await readNotice(fresh);
    fresh.c.newMeeting();
    assert.equal(fresh.state().meeting?.manual, true);
    assert.equal(fresh.state().turns.length, 0);
    assert.equal(fresh.world.notes.notices.length, 1);

    const ended = await recordedOnly();
    await until(ended.world, ended.c.endMeeting());
    assert.equal(ended.state().meeting?.key, JANE);
    assert.equal(ended.state().turns.length, 2);
    assert.equal(ended.state().summary.status, 'done');
    assert.match(ended.world.notes.notices[0], /or press End again to discard it\./);
    await readNotice(ended);
    await until(ended.world, ended.c.endMeeting());
    assert.equal(ended.state().meeting, null);
    assert.equal(ended.state().turns.length, 0);
    assert.equal(ended.world.notes.notices.length, 1);
  });

  it('is stopped by End while it is being recorded, and kept until End is pressed again', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.startRecording();
    env.world.sources[0].say('We agreed on the plan.', 1, 3);
    await until(env.world, env.c.endMeeting());
    assert.equal(env.state().recording, 'idle');
    assert.equal(env.state().meeting?.key, JANE);
    assert.equal(env.state().turns.length, 1);
    assert.equal(env.world.notes.notices.length, 1);
    await readNotice(env);
    await until(env.world, env.c.endMeeting());
    assert.equal(env.state().meeting, null);
  });

  it('is not discarded by a double click: the same request in the same instant is refused like the first', async () => {
    const clicked = await recordedOnly();
    clicked.c.selectSection(BOARD);
    clicked.c.selectSection(BOARD);
    assert.equal(clicked.state().meeting?.key, JANE);
    assert.equal(clicked.state().turns.length, 2);
    assert.equal(clicked.world.notes.notices.filter((notice) => NOT_SAVED.test(notice)).length, 2, 'said again');
    // A third click, before the notice of the second could be read.
    await pass(clicked.world, 900, 100);
    clicked.c.selectSection(BOARD);
    assert.equal(clicked.state().meeting?.key, JANE);
    assert.equal(clicked.world.notes.notices.length, 3);
    // Read, and asked for again: that is the answer.
    await pass(clicked.world, 1000, 100);
    clicked.c.selectSection(BOARD);
    assert.equal(clicked.state().meeting?.key, BOARD);
    assert.equal(clicked.world.notes.notices.length, 3);

    const started = await recordedOnly();
    started.c.newMeeting();
    started.c.newMeeting();
    assert.equal(started.state().meeting?.key, JANE);
    assert.equal(started.state().turns.length, 2);
    assert.equal(started.world.notes.notices.length, 2);

    const ended = await recordedOnly();
    const first = ended.c.endMeeting();
    const second = ended.c.endMeeting();
    await until(ended.world, Promise.all([first, second]));
    assert.equal(ended.state().meeting?.key, JANE);
    assert.equal(ended.state().turns.length, 2);
    assert.equal(ended.state().summary.status, 'done');
    assert.equal(ended.world.notes.notices.filter((notice) => NOT_SAVED.test(notice)).length, 2);
  });

  it('is asked about again when the same request comes long after the notice has gone', async () => {
    const late = await recordedOnly();
    late.c.selectSection(BOARD);
    // An hour of other work in the same meeting: the notice is long forgotten.
    await pass(late.world, 3_600_000, 60_000);
    late.c.selectSection(BOARD);
    assert.equal(late.state().meeting?.key, JANE, 'one click, an hour later, is not consent');
    assert.equal(late.state().turns.length, 2);
    assert.equal(late.world.notes.notices.filter((notice) => NOT_SAVED.test(notice)).length, 2);

    // The window: from one second after the notice to fifteen.
    const atFifteen = await recordedOnly();
    atFifteen.c.newMeeting();
    atFifteen.world.clock.advance(15_000);
    atFifteen.c.newMeeting();
    assert.equal(atFifteen.state().meeting?.manual, true);

    const justAfter = await recordedOnly();
    justAfter.c.newMeeting();
    justAfter.world.clock.advance(15_001);
    justAfter.c.newMeeting();
    assert.equal(justAfter.state().meeting?.key, JANE);
    assert.equal(justAfter.state().turns.length, 2);
    assert.equal(justAfter.world.notes.notices.length, 2);
    // The notice that went up again is answered like the first.
    justAfter.world.clock.advance(1000);
    justAfter.c.newMeeting();
    assert.equal(justAfter.state().meeting?.manual, true);

    const justBefore = await recordedOnly();
    justBefore.c.newMeeting();
    justBefore.world.clock.advance(999);
    justBefore.c.newMeeting();
    assert.equal(justBefore.state().meeting?.key, JANE);
  });

  it('is asked about again once more was said after the first refusal', async () => {
    const env = await recordedOnly();
    env.c.selectSection(BOARD);
    await env.c.startRecording();
    env.world.sources[1].say('One more remark.', 1, 2);
    await until(env.world, env.c.stopRecording());
    await settle();
    env.c.selectSection(BOARD);
    assert.equal(env.state().meeting?.key, JANE, 'the remark was not part of what the first click asked about');
    assert.equal(env.world.notes.notices.filter((notice) => NOT_SAVED.test(notice)).length, 2);
  });

  it('leaves alone a meeting with nothing recorded, whatever else it holds', async () => {
    const env = await boot();
    env.c.selectSection(JANE);
    await env.c.enhanceNow();
    await env.c.summarize('recap');
    await env.c.ask('What is the plan?');
    env.c.selectSection(BOARD);
    assert.equal(env.state().meeting?.key, BOARD);
    env.c.newMeeting();
    assert.equal(env.state().meeting?.manual, true);
    await env.c.endMeeting();
    assert.equal(env.state().meeting, null);
    assert.deepEqual(env.world.notes.notices, []);
  });
});

describe('what a write that was given up carried', () => {
  it('is sent again at the end of the meeting: the enhanced notes and the summary, not the transcript alone', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    env.world.sources[0].say('We agreed on the plan.', 1, 3);
    await pass(env.world, 5200);
    assert.match(region(env, JANE_NOTE, 'transcript'), /We agreed on the plan/);

    // Locked by a sync client for a few seconds: three tries, two seconds apart.
    const write = env.world.notes.writeCompanion.bind(env.world.notes);
    env.world.notes.writeCompanion = async () => {
      throw new Error('EBUSY: the file is locked.');
    };
    await env.c.enhanceNow();
    env.world.sources[0].say('And on the budget.', 4, 6);
    await until(env.world, env.c.stopRecording());
    await settle();
    assert.equal(env.state().summary.status, 'done');
    await pass(env.world, 15_000, 100);
    assert.deepEqual(env.world.notes.notices, ['The companion note could not be saved. EBUSY: the file is locked.']);
    assert.equal(env.state().pendingWrites, 0, 'the queue holds nothing any more');

    // The lock clears. Nothing else changes; a minute later the user ends the meeting.
    env.world.notes.writeCompanion = write;
    await pass(env.world, 60_000, 1000);
    await until(env.world, env.c.endMeeting());
    assert.equal(env.state().meeting, null);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /^- \*\*Note:\*\* Q4 roadmap/);
    assert.match(region(env, JANE_NOTE, 'summary'), /^### Executive summary/);
    assert.equal(region(env, JANE_NOTE, 'transcript').match(/And on the budget\./g)?.length, 1);
    assert.equal(region(env, JANE_NOTE, 'transcript').match(/We agreed on the plan\./g)?.length, 1);
  });

  it('is sent again at the next stop too, with the insights that were kept', async () => {
    const env = await withCompanion();
    await env.c.ask('What is the plan?');
    const write = env.world.notes.writeCompanion.bind(env.world.notes);
    env.world.notes.writeCompanion = async () => {
      throw new Error('EBUSY: the file is locked.');
    };
    await env.c.enhanceNow();
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await pass(env.world, 15_000, 100);
    assert.equal(env.world.notes.notices.length, 1);
    assert.equal(region(env, JANE_NOTE, 'qa'), '');

    env.world.notes.writeCompanion = write;
    await env.c.startRecording();
    env.world.sources[0].say('A remark.', 1, 2);
    await until(env.world, env.c.stopRecording());
    assert.match(region(env, JANE_NOTE, 'enhanced'), /^- \*\*Note:\*\* Q4 roadmap/);
    assert.match(region(env, JANE_NOTE, 'qa'), /What is the plan\?/);
    assert.equal(region(env, JANE_NOTE, 'qa').match(/^### /gm)?.length, 1);
  });
});

describe('what a write that was given up carried, when no stop and no End follows', () => {
  const GIVEN_UP = 'The companion note could not be saved. EBUSY: the file is locked.';

  /**
   * One line on disk. Then the file is locked for a few seconds, as by a sync client: the enhanced
   * notes, the summary and the last line are in a batch the queue gives up. The lock has cleared.
   */
  async function givenUp(): Promise<Env> {
    const env = await withCompanion();
    await env.c.startRecording();
    env.world.sources[0].say('We agreed on the plan.', 1, 3);
    await pass(env.world, 5200);
    const write = env.world.notes.writeCompanion.bind(env.world.notes);
    env.world.notes.writeCompanion = async () => {
      throw new Error('EBUSY: the file is locked.');
    };
    await env.c.enhanceNow();
    env.world.sources[0].say('And on the budget.', 4, 6);
    await until(env.world, env.c.stopRecording());
    await settle();
    assert.equal(env.state().summary.status, 'done');
    await pass(env.world, 8000, 100);
    assert.deepEqual(env.world.notes.notices, [GIVEN_UP]);
    assert.equal(env.state().pendingWrites, 0, 'the queue holds nothing any more');
    env.world.notes.writeCompanion = write;
    return env;
  }

  function assertWhole(env: Env): void {
    assert.match(region(env, JANE_NOTE, 'enhanced'), /^- \*\*Note:\*\* Q4 roadmap/);
    assert.match(region(env, JANE_NOTE, 'summary'), /^### Executive summary/);
    assert.deepEqual(region(env, JANE_NOTE, 'transcript').trimEnd().split('\n').slice(1), [
      '> **[00:01] Fred:** We agreed on the plan.',
      '> **[00:04] Fred:** And on the budget.',
    ]);
  }

  it('is sent again when another meeting is selected', async () => {
    const env = await givenUp();
    env.c.selectSection(BOARD);
    assert.equal(env.state().meeting?.key, BOARD);
    await pass(env.world, 6000);
    assertWhole(env);
    assert.equal(env.world.notes.notices.length, 1);
  });

  it('is sent again when New meeting is pressed', async () => {
    const env = await givenUp();
    env.c.newMeeting();
    assert.equal(env.state().meeting?.manual, true);
    await pass(env.world, 6000);
    assertWhole(env);
  });

  it('is sent again when a meeting started on its own is picked up instead', async () => {
    const env = await withCompanion({ local: { firstWriteConfirmed: true } });
    await env.c.endMeeting();
    env.c.newMeeting();
    const manual = env.state().meeting?.key ?? '';
    await env.c.createCompanion();
    await pass(env.world, 1000);
    env.c.selectSection(JANE);
    await settle();
    const write = env.world.notes.writeCompanion.bind(env.world.notes);
    env.world.notes.writeCompanion = async () => {
      throw new Error('EBUSY: the file is locked.');
    };
    await env.c.enhanceNow();
    await pass(env.world, 10_000, 100);
    assert.deepEqual(env.world.notes.notices, [GIVEN_UP]);
    env.world.notes.writeCompanion = write;
    env.c.selectSection(manual);
    assert.equal(env.state().meeting?.key, manual);
    await pass(env.world, 6000);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /^- \*\*Note:\*\* Q4 roadmap/);
  });

  it('is sent with the flush Obsidian asks for when it quits', async () => {
    const flushed = await givenUp();
    await until(flushed.world, flushed.session.flushAll());
    assertWhole(flushed);

    const quit = await givenUp();
    await until(quit.world, quit.session.dispose());
    assertWhole(quit);
  });

  it('is sent again by itself half a minute later, once, when nothing else is done', async () => {
    const env = await givenUp();
    await pass(env.world, 20_000, 500);
    assert.equal(region(env, JANE_NOTE, 'enhanced'), '', 'not yet: the file is given time to come free');
    await pass(env.world, 16_000, 500);
    assertWhole(env);
    assert.equal(env.state().pendingWrites, 0);
    assert.equal(env.world.notes.notices.length, 1);
    // Once: nothing is written again however long the meeting stays open.
    const writes = env.world.notes.writes.length;
    await pass(env.world, 300_000, 5000);
    assert.equal(env.world.notes.writes.length, writes);
  });

  it('is tried by itself when the last stop was already behind as the batch was given up', async () => {
    const env = await withCompanion();
    await env.c.startRecording();
    env.world.sources[0].say('We agreed on the plan.', 1, 3);
    await pass(env.world, 6000);
    // Three tries fail, the last of them after the stop has given up waiting for the flush.
    const write = env.world.notes.writeCompanion.bind(env.world.notes);
    let failing = 3;
    env.world.notes.writeCompanion = async (path, patches) => {
      if (failing > 0) {
        failing -= 1;
        throw new Error('EBUSY: the file is locked.');
      }
      return write(path, patches);
    };
    env.world.sources[0].say('And on the budget.', 7, 8);
    await until(env.world, env.c.stopRecording());
    await pass(env.world, 10_000);
    assert.deepEqual(env.world.notes.notices, [GIVEN_UP]);
    assert.doesNotMatch(region(env, JANE_NOTE, 'transcript'), /And on the budget\./);
    await pass(env.world, 30_000, 500);
    assert.equal(region(env, JANE_NOTE, 'transcript').match(/And on the budget\./g)?.length, 1);
    assert.match(region(env, JANE_NOTE, 'summary'), /^### Executive summary/);
  });

  it('tries once more after each batch that is given up, for as long as the file stays locked, and says so once', async () => {
    const env = await withCompanion();
    const write = env.world.notes.writeCompanion.bind(env.world.notes);
    let attempts = 0;
    env.world.notes.writeCompanion = async () => {
      attempts += 1;
      throw new Error('EBUSY: the file is locked.');
    };
    await env.c.enhanceNow();
    await pass(env.world, 10_000, 100);
    assert.equal(attempts, 3, 'the queue gave the batch up');
    // The try that follows by itself fails as well, and is given up in its turn.
    await pass(env.world, 40_000, 500);
    assert.equal(attempts, 6);
    assert.equal(region(env, JANE_NOTE, 'enhanced'), '');
    env.world.notes.writeCompanion = write;
    await pass(env.world, 40_000, 500);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /^- \*\*Note:\*\* Q4 roadmap/);
    assert.deepEqual(env.world.notes.notices, [GIVEN_UP]);
  });

  it('is not tried for a note the meeting no longer has', async () => {
    const env = await givenUp();
    env.world.notes.files.delete(JANE_NOTE);
    env.session.handleVaultChange({ type: 'delete', path: JANE_NOTE });
    assert.equal(env.state().meeting?.companionPath, null);
    const writes = env.world.notes.writes.length;
    await pass(env.world, 60_000, 1000);
    assert.equal(env.world.notes.writes.length, writes);
    assert.deepEqual(env.world.notes.notices, [GIVEN_UP, 'The companion note is no longer there. Create it again to keep saving.']);
    // Created again, the note gets everything: what was dropped is still in memory.
    env.world.deps.setLocal({ firstWriteConfirmed: true });
    await until(env.world, env.c.createCompanion());
    await pass(env.world, 8000);
    assertWhole(env);
  });

  it('arms one such try at a time, and none once the meeting is left or the session is over', async () => {
    const env = await withCompanion();
    // The tries the session arms: the only timers of half a minute.
    const armed = new Set<unknown>();
    const setTimeout = env.world.clock.setTimeout.bind(env.world.clock);
    const clearTimeout = env.world.clock.clearTimeout.bind(env.world.clock);
    env.world.clock.setTimeout = (fn, ms) => {
      const handle = setTimeout(() => {
        armed.delete(handle);
        fn();
      }, ms);
      if (ms === 30_000) armed.add(handle);
      return handle;
    };
    env.world.clock.clearTimeout = (handle) => {
      armed.delete(handle);
      clearTimeout(handle);
    };
    env.world.notes.writeCompanion = async () => {
      throw new Error('EBUSY: the file is locked.');
    };
    await env.c.enhanceNow();
    await pass(env.world, 10_000, 100);
    assert.equal(env.world.notes.notices.length, 1);
    assert.equal(armed.size, 1);
    // A second batch is given up before the try is due.
    await env.c.summarize('recap');
    await pass(env.world, 10_000, 100);
    assert.equal(armed.size, 1);
    env.c.selectSection(BOARD);
    assert.equal(armed.size, 0, 'the meeting was left');

    env.c.selectSection(JANE);
    await settle();
    await env.c.summarize('recap');
    await pass(env.world, 10_000, 100);
    assert.equal(armed.size, 1);
    await until(env.world, env.session.dispose());
    assert.equal(armed.size, 0, 'the session is over');
  });

  it('fills the hole a batch left when it was given up with later lines queued behind it', async () => {
    const spoken = (env: Env): string[] =>
      region(env, JANE_NOTE, 'transcript')
        .trimEnd()
        .split('\n')
        .slice(1)
        .map((line) => line.replace(/^.*Fred:\*\* /, ''));

    /** 'L0.' on disk; 'L1.' in a batch that is given up while 'L2.' already waits behind it; then the lock clears. */
    async function holed(): Promise<Env> {
      const env = await withCompanion();
      await env.c.startRecording();
      const source = env.world.sources[0];
      source.say('L0.', 0, 1);
      await pass(env.world, 5200, 100);
      const write = env.world.notes.writeCompanion.bind(env.world.notes);
      // Each try takes a second and a half to fail.
      env.world.notes.writeCompanion = async () => {
        await new Promise<void>((resolve) => {
          env.world.clock.setTimeout(resolve, 1500);
        });
        throw new Error('EBUSY: the file is locked.');
      };
      source.say('L1.', 10, 11);
      await pass(env.world, 12_500, 100);
      // The third try is out.
      source.say('L2.', 20, 21);
      await pass(env.world, 2500, 100);
      assert.deepEqual(env.world.notes.notices, [GIVEN_UP]);
      env.world.notes.writeCompanion = write;
      await pass(env.world, 10_000, 100);
      assert.deepEqual(spoken(env), ['L0.', 'L2.'], 'the line that was given up is missing');
      return env;
    }
    // Every line is there; those after the hole twice, which is better than one that is missing.
    const whole = ['L0.', 'L2.', 'L1.', 'L2.'];

    const ended = await holed();
    await until(ended.world, ended.c.stopRecording());
    await until(ended.world, ended.c.endMeeting());
    assert.deepEqual(spoken(ended), whole);

    const left = await holed();
    await until(left.world, left.c.stopRecording());
    await pass(left.world, 3000);
    left.c.selectSection(BOARD);
    await pass(left.world, 6000);
    assert.deepEqual(spoken(left), whole);

    // By itself, while the recording goes on.
    const alone = await holed();
    await pass(alone.world, 30_000, 500);
    assert.deepEqual(spoken(alone), whole);
    alone.world.sources[0].say('L3.', 70, 71);
    await until(alone.world, alone.c.stopRecording());
    await until(alone.world, alone.c.endMeeting());
    assert.deepEqual(spoken(alone), [...whole, 'L3.']);

    // With a line still on its way to the note at the stop: nothing is lost then either.
    const talking = await holed();
    talking.world.sources[0].say('L3.', 40, 41);
    await until(talking.world, talking.c.stopRecording());
    await until(talking.world, talking.c.endMeeting());
    const lines = spoken(talking);
    for (const line of ['L0.', 'L1.', 'L2.', 'L3.']) assert.ok(lines.includes(line), `${line} is in the note`);
    assert.deepEqual(lines.slice(-3), ['L1.', 'L2.', 'L3.'], 'in order from the hole on');
  });
});

describe('a companion that goes away and comes back', () => {
  /** 'Alpha.' on disk, 'Bravo.' still in the queue, then the note is deleted and restored at the same path. */
  async function restored(backAfterMs: number): Promise<Env> {
    const env = await withCompanion();
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('Alpha.', 1, 2);
    await pass(env.world, 5200);
    source.say('Bravo.', 6, 7);
    await pass(env.world, 1000);

    const text = env.world.notes.files.get(JANE_NOTE) ?? '';
    env.world.notes.files.delete(JANE_NOTE);
    env.session.handleVaultChange({ type: 'delete', path: JANE_NOTE });
    assert.equal(env.state().meeting?.companionPath, null);
    await pass(env.world, backAfterMs, 100);
    // Back from the trash, or put back by a sync client.
    env.world.notes.files.set(JANE_NOTE, text);
    return env;
  }

  const spoken = (env: Env): string[] => region(env, JANE_NOTE, 'transcript').trimEnd().split('\n').slice(1);
  const whole = ['> **[00:01] Fred:** Alpha.', '> **[00:06] Fred:** Bravo.', '> **[00:14] Fred:** Charlie.'];

  it('gets the line that was queued for it once, when the queue writes it before the note is adopted again', async () => {
    const env = await restored(500);
    await pass(env.world, 6000);
    assert.deepEqual(spoken(env), whole.slice(0, 2), 'the queue wrote its line into the restored note');
    env.world.sources[0].say('Charlie.', 14, 15);
    await pass(env.world, 1000);
    await env.c.createCompanion();
    await pass(env.world, 8000);
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    assert.deepEqual(spoken(env), whole);
  });

  it('gets it once when the note is adopted again while the line is still queued', async () => {
    const env = await restored(500);
    await pass(env.world, 1000);
    env.world.sources[0].say('Charlie.', 14, 15);
    await env.c.createCompanion();
    await pass(env.world, 8000);
    assert.deepEqual(spoken(env), whole);
  });

  it('gets it once when the queue found the note missing in between', async () => {
    const env = await restored(8000);
    env.world.sources[0].say('Charlie.', 14, 15);
    await env.c.createCompanion();
    await pass(env.world, 8000);
    assert.deepEqual(spoken(env), whole);
  });

  it('gets every line when it is another note that came back at that path, with none of them in it', async () => {
    /** 'Alpha.' on disk, 'Bravo.' in the queue; the note is deleted, and an empty one of the same name appears (a sync, a template). */
    async function replaced(backAfterMs: number): Promise<Env> {
      const env = await withCompanion();
      const empty = env.world.notes.files.get(JANE_NOTE) ?? '';
      await env.c.startRecording();
      const source = env.world.sources[0];
      source.say('Alpha.', 1, 2);
      await pass(env.world, 5200);
      assert.deepEqual(spoken(env), whole.slice(0, 1));
      source.say('Bravo.', 6, 7);
      await pass(env.world, 1000);
      env.world.notes.files.delete(JANE_NOTE);
      env.session.handleVaultChange({ type: 'delete', path: JANE_NOTE });
      await pass(env.world, backAfterMs, 100);
      env.world.notes.files.set(JANE_NOTE, empty);
      source.say('Charlie.', 14, 15);
      await until(env.world, env.c.createCompanion());
      assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
      await until(env.world, env.c.stopRecording());
      await pass(env.world, 10_000);
      return env;
    }

    // The queue had found the note missing, and dropped its line: all three go, once each.
    assert.deepEqual(spoken(await replaced(8000)), whole);

    // The queue still held 'Bravo.' for that path. 'Alpha.' was only in the note that is gone: every
    // line is sent from the first, after the one the queue could not be asked to give back.
    const lines = spoken(await replaced(500));
    assert.ok(lines.includes(whole[0]), 'the line that was only in the deleted note is not lost');
    assert.deepEqual(lines.slice(-3), whole);
    assert.deepEqual(lines, [whole[1], ...whole]);
  });
});

describe('a note adopted after the one the transcript went to was lost', () => {
  it('receives the lines that were only in the lost note, after what it already holds', async () => {
    const env = await boot({ local: { firstWriteConfirmed: true } });
    // The section has its note, with a line from an earlier recording.
    env.c.selectSection(JANE);
    await env.c.createCompanion();
    await pass(env.world, 1000);
    await env.c.startRecording();
    env.world.sources[0].say('Said in the section, earlier.', 1, 2);
    await until(env.world, env.c.stopRecording());
    await settle();
    await until(env.world, env.c.endMeeting());

    // A meeting started on its own gets a note of its own, and two lines in it.
    env.c.newMeeting();
    await env.c.createCompanion();
    const own = env.state().meeting?.companionPath ?? '';
    assert.notEqual(own, JANE_NOTE);
    await pass(env.world, 1000);
    await env.c.startRecording();
    const source = env.world.sources[1];
    source.say('First.', 1, 2);
    source.say('Second.', 3, 4);
    await pass(env.world, 6000);
    assert.match(region(env, own, 'transcript'), /First\.\n.*Second\./);

    // Linked to the section, it keeps its own note; that note is then deleted, and the section's adopted.
    type(env, env.world.notes.dailyText ?? '', '- budget');
    await env.c.linkAtCursor();
    assert.equal(env.state().meeting?.companionPath, own);
    env.world.notes.files.delete(own);
    env.session.handleVaultChange({ type: 'delete', path: own });
    await env.c.createCompanion();
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    source.say('Third.', 5, 6);
    await until(env.world, env.c.stopRecording());
    await pass(env.world, 6000);

    const lines = region(env, JANE_NOTE, 'transcript').trimEnd().split('\n').slice(1);
    assert.equal(lines.length, 5);
    assert.equal(lines[0], '> **[00:01] Fred:** Said in the section, earlier.');
    assert.match(lines[1], /^> \*\*— recording resumed at \d\d:\d\d —\*\*$/);
    assert.deepEqual(lines.slice(2), [
      '> **[00:01] Fred:** First.',
      '> **[00:03] Fred:** Second.',
      '> **[00:05] Fred:** Third.',
    ]);
  });

  it('receives nothing twice when it is the same note, found again under another path', async () => {
    const env = await withCompanion();
    const moved = '10 Work/Meetings/Jane.md';
    await env.c.startRecording();
    const source = env.world.sources[0];
    source.say('First.', 1, 2);
    source.say('Second.', 3, 4);
    await pass(env.world, 5200);
    // Moved outside Obsidian: the note is gone from its path, and its lines went with it.
    env.world.notes.files.set(moved, env.world.notes.files.get(JANE_NOTE) ?? '');
    env.world.notes.files.delete(JANE_NOTE);
    env.session.handleVaultChange({ type: 'delete', path: JANE_NOTE });
    source.say('Third.', 5, 6);
    await env.c.createCompanion();
    assert.equal(env.state().meeting?.companionPath, moved);
    await pass(env.world, 5200);
    assert.deepEqual(region(env, moved, 'transcript').trimEnd().split('\n').slice(1), [
      '> **[00:01] Fred:** First.',
      '> **[00:03] Fred:** Second.',
      '> **[00:05] Fred:** Third.',
    ]);
  });
});

/* The transcript of a meeting is kept in memory for one visit only. Once the meeting is left
   (another one selected, Obsidian restarted), what was written from it cannot be written again:
   a later visit must not replace it on its own. */
describe('a meeting that is visited again', () => {
  /** Tells what a bullet was written from, and how many transcript lines a summary was given. */
  function telling(req: ChatRequest): string {
    const items = promptItems(req);
    const user = userMessage(req);
    if (items.length > 0) {
      const from = user.includes('<excerpts>') ? 'GROUNDED' : 'SHORTHAND ONLY';
      return items.map((item) => `${item.n}. **Note:** ${item.text} (${from})`).join('\n');
    }
    if (isQuestion(req)) return 'The notes say so [1].';
    return `### Overview\nTURNS:${(user.match(/^\[\d\d:\d\d\] /gm) ?? []).length}`;
  }

  const SPEECH = 'The vendor contract renewal may slip to November, said the vendor.';
  const enhanceCalls = (env: Env): number => env.world.llm.chats.filter((req) => promptItems(req).length > 0).length;
  const summaryCalls = (env: Env): number =>
    env.world.llm.chats.filter((req) => promptItems(req).length === 0 && !isQuestion(req)).length;

  /** Recorded, enhanced from the transcript and summarized, everything saved to the companion. */
  async function firstVisit(options: FakeWorldOptions = {}, turns = 1): Promise<Env> {
    const env = await withCompanion(options);
    env.world.llm.answer = telling;
    await env.c.startRecording();
    for (let i = 0; i < turns; i++) env.world.sources[0].say(SPEECH, i * 40, i * 40 + 35);
    await until(env.world, env.c.stopRecording());
    await settle();
    await env.c.enhanceNow();
    await pass(env.world, 6000);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /\(GROUNDED\)$/m);
    assert.doesNotMatch(region(env, JANE_NOTE, 'enhanced'), /SHORTHAND ONLY/);
    assert.match(region(env, JANE_NOTE, 'summary'), new RegExp(`TURNS:${turns}\\n$`));
    return env;
  }

  describe('keeps the enhanced notes of the earlier visit', () => {
    it('when it is only selected again with Live Enhance on', async () => {
      const env = await firstVisit({ settings: { liveEnhanceDefault: true } });
      const saved = region(env, JANE_NOTE, 'enhanced');
      env.c.selectSection(BOARD);
      env.c.selectSection(JANE);
      const calls = env.world.llm.chats.length;
      await pass(env.world, 30_000, 500);
      assert.equal(env.world.llm.chats.length, calls, 'nothing was typed: nothing is asked of the model');
      assert.equal(region(env, JANE_NOTE, 'enhanced'), saved);
      // The sidebar shows the notes the companion holds.
      assert.deepEqual(
        env.state().enhanced.filter((e) => e.kind === 'item').map((e) => `- ${e.bullet}`),
        saved.trimEnd().split('\n').filter((line) => line.startsWith('- ')),
      );
      assert.deepEqual(env.world.notes.notices, []);
    });

    it('after a restart, with Live Enhance on from the start', async () => {
      const before = await firstVisit();
      const saved = region(before, JANE_NOTE, 'enhanced');
      const env = await restart(before);
      env.world.setSettings({ liveEnhanceDefault: true });
      env.world.llm.answer = telling;
      env.c.setLiveEnhance(true);
      env.c.selectSection(JANE);
      await pass(env.world, 30_000, 500);
      assert.equal(env.world.llm.chats.length, 0);
      assert.equal(region(env, JANE_NOTE, 'enhanced'), saved);
      assert.equal(env.state().enhanced.filter((e) => e.bullet !== null).length, 3);
    });

    it('when Enhance is pressed on lines that did not change', async () => {
      const before = await firstVisit();
      const saved = region(before, JANE_NOTE, 'enhanced');
      const env = await restart(before);
      env.world.llm.answer = telling;
      env.c.selectSection(JANE);
      // Pressed at once: the note is read first, so its bullets are known for the lines' own.
      await env.c.enhanceNow();
      await pass(env.world, 6000);
      assert.equal(env.world.llm.chats.length, 0);
      assert.equal(region(env, JANE_NOTE, 'enhanced'), saved);
      assert.equal(env.world.notes.writes.length, 0);
    });

    it('and adds to them the line that is typed now, the only one sent to the model', async () => {
      const before = await firstVisit();
      const saved = region(before, JANE_NOTE, 'enhanced').trimEnd().split('\n');
      const env = await restart(before);
      env.world.llm.answer = telling;
      env.c.setLiveEnhance(true);
      env.c.selectSection(JANE);
      await settle();
      const text = (env.world.notes.dailyText ?? '').replace('#### Risks', '- hiring: two roles open\n#### Risks');
      type(env, text, '- hiring');
      await pass(env.world, 9000, 500);
      assert.equal(env.world.llm.chats.length, 1);
      assert.deepEqual(
        promptItems(env.world.llm.chats[0]).map((item) => item.text),
        ['hiring: two roles open'],
      );
      const now = region(env, JANE_NOTE, 'enhanced').trimEnd().split('\n');
      assert.deepEqual(now, [
        saved[0],
        saved[1],
        '- **Note:** hiring: two roles open (SHORTHAND ONLY)',
        ...saved.slice(2),
      ]);
    });

    it('when its lines are no longer one per saved bullet: what Live writes is shown, and saved only on Enhance', async () => {
      const before = await firstVisit();
      const saved = region(before, JANE_NOTE, 'enhanced');
      const env = await restart(before);
      env.world.llm.answer = telling;
      // A line was removed from the daily between the two visits.
      const text = (env.world.notes.dailyText ?? '').replace("- budget: 2 postes gelés jusqu'en janvier\n", '');
      env.world.notes.setDaily(text);
      env.session.handleDailyAvailability();
      await settle();
      env.c.setLiveEnhance(true);
      env.c.selectSection(JANE);
      await settle();
      type(env, text.replace('#### Risks', '- hiring: two roles open\n#### Risks'), '- hiring');
      await pass(env.world, 9000, 500);
      assert.equal(enhanceCalls(env), 1);
      assert.equal(env.state().enhanced.filter((e) => /SHORTHAND ONLY/.test(e.bullet ?? '')).length, 3);
      assert.equal(region(env, JANE_NOTE, 'enhanced'), saved, 'the note keeps what was written from the transcript');
      assert.deepEqual(env.world.notes.notices, [
        'The companion note keeps the enhanced notes of an earlier visit to this meeting. Press Enhance to replace them with the ones shown here.',
      ]);
      await pass(env.world, 30_000, 1000);
      assert.equal(region(env, JANE_NOTE, 'enhanced'), saved);
      assert.equal(env.world.notes.notices.length, 1, 'said once');

      // Asked for by name: the run has nothing left to write, and what is shown is saved.
      await env.c.enhanceNow();
      await pass(env.world, 6000);
      assert.equal(region(env, JANE_NOTE, 'enhanced').match(/SHORTHAND ONLY/g)?.length, 3);
    });

    it('when its lines changed places between the visits: no bullet is taken for the note of another line', async () => {
      const before = await firstVisit();
      const saved = region(before, JANE_NOTE, 'enhanced');
      const env = await restart(before);
      env.world.llm.answer = telling;
      const text = (env.world.notes.dailyText ?? '').replace(
        "- Q4 roadmap: identity migration first\n- budget: 2 postes gelés jusqu'en janvier\n",
        "- budget: 2 postes gelés jusqu'en janvier\n- Q4 roadmap: identity migration first\n",
      );
      assert.notEqual(text, env.world.notes.dailyText);
      env.world.notes.setDaily(text);
      env.session.handleDailyAvailability();
      await settle();
      env.c.selectSection(JANE);
      await settle();
      assert.deepEqual(
        env.state().enhanced.filter((e) => e.kind === 'item').map((e) => e.bullet),
        [null, null, null],
        'the budget line is not shown with the roadmap bullet',
      );

      // Enhance is no silent no-op: every line is written, shown, and saved when asked for again.
      await env.c.enhanceNow();
      await pass(env.world, 6000);
      assert.equal(enhanceCalls(env), 1);
      assert.deepEqual(
        env.state().enhanced.filter((e) => e.kind === 'item').map((e) => e.bullet),
        [
          "**Note:** budget: 2 postes gelés jusqu'en janvier (SHORTHAND ONLY)",
          '**Note:** Q4 roadmap: identity migration first (SHORTHAND ONLY)',
          '**Note:** vendor contract renewal may slip to Nov (SHORTHAND ONLY)',
        ],
      );
      assert.equal(region(env, JANE_NOTE, 'enhanced'), saved, 'the note keeps the earlier notes until asked');
      assert.equal(env.world.notes.notices.length, 1);
      assert.match(env.world.notes.notices[0], /Press Enhance to replace them with the ones shown here\.$/);
      await env.c.enhanceNow();
      await pass(env.world, 6000);
      assert.deepEqual(region(env, JANE_NOTE, 'enhanced').trimEnd().split('\n').slice(0, 2), [
        "- **Note:** budget: 2 postes gelés jusqu'en janvier (SHORTHAND ONLY)",
        '- **Note:** Q4 roadmap: identity migration first (SHORTHAND ONLY)',
      ]);
    });

    it('when a line was replaced by another between the visits: deleting a line later does not remove another one\'s bullet', async () => {
      const before = await firstVisit();
      const saved = region(before, JANE_NOTE, 'enhanced');
      const env = await restart(before);
      env.world.llm.answer = telling;
      // One line gone, one added: as many lines as the note has bullets.
      const text = (env.world.notes.dailyText ?? '')
        .replace('- Q4 roadmap: identity migration first\n', '')
        .replace('#### Risks', '- hiring: two roles open\n#### Risks');
      env.world.notes.setDaily(text);
      env.session.handleDailyAvailability();
      await settle();
      env.c.setLiveEnhance(true);
      env.c.selectSection(JANE);
      await settle();
      assert.ok(env.state().enhanced.every((e) => e.bullet === null));

      // The budget line is deleted in this visit, by hand.
      type(env, text.replace("- budget: 2 postes gelés jusqu'en janvier\n", ''), '- hiring');
      await pass(env.world, 12_000, 500);
      assert.equal(region(env, JANE_NOTE, 'enhanced'), saved, 'nothing was taken out of the note unasked');
      assert.deepEqual(
        env.state().enhanced.filter((e) => e.kind === 'item').map((e) => e.bullet),
        [
          '**Note:** hiring: two roles open (SHORTHAND ONLY)',
          '**Note:** vendor contract renewal may slip to Nov (SHORTHAND ONLY)',
        ],
      );
      await env.c.enhanceNow();
      await pass(env.world, 6000);
      assert.deepEqual(region(env, JANE_NOTE, 'enhanced').trimEnd().split('\n'), [
        '- **Note:** hiring: two roles open (SHORTHAND ONLY)',
        '',
        '#### Risks',
        '- **Note:** vendor contract renewal may slip to Nov (SHORTHAND ONLY)',
      ]);
    });

    it('whole, when the run that would replace them stops half-way', async () => {
      const lines = Array.from({ length: 12 }, (_, i) => `- point ${i + 1} of the vendor contract renewal`).join('\n');
      const before = await firstVisit({ daily: `### 1:1 [[Jane Example]]\n${lines}\n` });
      const saved = region(before, JANE_NOTE, 'enhanced');
      assert.equal(saved.match(/^- /gm)?.length, 12);
      const env = await restart(before);
      // One line more than the note has bullets for: every line is written again, eight at a time.
      const text = `${env.world.notes.dailyText ?? ''}- one more point\n`;
      env.world.notes.setDaily(text);
      env.session.handleDailyAvailability();
      await settle();
      let calls = 0;
      env.world.llm.answer = (req) => {
        calls += 1;
        return calls === 2 ? unreachableError() : telling(req);
      };
      env.c.selectSection(JANE);
      await env.c.enhanceNow();
      assert.equal(env.state().enhanceStatus, 'error');
      assert.equal(env.state().enhanced.filter((e) => e.bullet !== null).length, 8);
      await pass(env.world, 6000);
      assert.equal(region(env, JANE_NOTE, 'enhanced'), saved, 'twelve bullets, not eight');

      // The next press finishes the run, and only then is the region replaced.
      await env.c.enhanceNow();
      await pass(env.world, 6000);
      assert.equal(region(env, JANE_NOTE, 'enhanced').match(/^- /gm)?.length, 13);
    });

    it('when Enhance is pressed on lines that changed: the new notes are shown, and replace them when asked for again', async () => {
      const before = await firstVisit();
      const saved = region(before, JANE_NOTE, 'enhanced');
      const env = await restart(before);
      env.world.llm.answer = telling;
      const text = `${env.world.notes.dailyText ?? ''}`.replace('#### Risks', '- hiring: two roles open\n#### Risks');
      env.world.notes.setDaily(text);
      env.session.handleDailyAvailability();
      await settle();
      env.c.selectSection(JANE);
      // Pressed without a word of warning so far: nothing in the note is replaced by it.
      await env.c.enhanceNow();
      await pass(env.world, 6000);
      assert.equal(env.state().enhanced.filter((e) => /SHORTHAND ONLY/.test(e.bullet ?? '')).length, 4);
      assert.equal(region(env, JANE_NOTE, 'enhanced'), saved);
      assert.equal(env.world.notes.notices.length, 1);
      assert.match(env.world.notes.notices[0], /Press Enhance to replace them with the ones shown here\.$/);

      await env.c.enhanceNow();
      await pass(env.world, 6000);
      assert.equal(region(env, JANE_NOTE, 'enhanced').match(/SHORTHAND ONLY/g)?.length, 4);
      assert.equal(env.world.llm.chats.length, 1, 'the second press had nothing to write again');
    });

    it('when the style changes: the sidebar is rewritten, the note waits for Enhance', async () => {
      const before = await firstVisit();
      const saved = region(before, JANE_NOTE, 'enhanced');
      const env = await restart(before);
      env.world.llm.answer = telling;
      env.c.selectSection(JANE);
      await settle();
      // From the sidebar, or from the settings tab while this meeting happens to be selected.
      env.world.setSettings({ enhanceStyle: 'concise' });
      env.session.handleSettingsChange();
      await pass(env.world, 6000);
      assert.equal(enhanceCalls(env), 1);
      assert.match(env.state().enhanced[0].bullet ?? '', /SHORTHAND ONLY/);
      assert.equal(region(env, JANE_NOTE, 'enhanced'), saved);
      assert.equal(env.world.notes.notices.length, 1);

      await env.c.enhanceNow();
      await pass(env.world, 6000);
      assert.match(region(env, JANE_NOTE, 'enhanced'), /SHORTHAND ONLY/);
    });

    it('when the note cannot be read: nothing is replaced unseen', async () => {
      const before = await firstVisit();
      const saved = region(before, JANE_NOTE, 'enhanced');
      const env = await restart(before);
      env.world.llm.answer = telling;
      env.world.notes.readCompanion = async () => {
        throw new Error('The file is locked.');
      };
      env.c.setLiveEnhance(true);
      env.c.selectSection(JANE);
      await settle();
      type(env, (env.world.notes.dailyText ?? '').replace('#### Risks', '- hiring\n#### Risks'), '- hiring');
      await pass(env.world, 9000, 500);
      assert.equal(enhanceCalls(env), 1);
      assert.equal(region(env, JANE_NOTE, 'enhanced'), saved);
    });

    it('when a meeting started on its own is linked to the section they belong to', async () => {
      const before = await firstVisit();
      const saved = region(before, JANE_NOTE, 'enhanced');
      const env = await restart(before);
      env.world.llm.answer = telling;
      env.c.newMeeting();
      type(env, env.world.notes.dailyText ?? '', '- budget');
      await env.c.linkAtCursor();
      assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
      await pass(env.world, 6000);
      assert.equal(region(env, JANE_NOTE, 'enhanced'), saved);
      assert.equal(env.state().enhanced.filter((e) => e.bullet !== null).length, 3, 'and they are shown');
      assert.equal(env.world.llm.chats.length, 0);
    });
  });

  describe('keeps the summary of the earlier visit', () => {
    it('when one more remark is recorded and stopped: no summary is started over it', async () => {
      const env = await firstVisit({}, 30);
      env.c.selectSection(BOARD);
      env.c.selectSection(JANE);
      await settle();
      assert.equal(env.state().turns.length, 0);
      const summaries = summaryCalls(env);
      await env.c.startRecording();
      env.world.sources[1].say('One more remark.', 1, 2);
      await until(env.world, env.c.stopRecording());
      await pass(env.world, 6000);
      assert.equal(summaryCalls(env), summaries, 'the stop asked nothing of the model');
      assert.equal(env.state().summary.status, 'idle');
      assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:30\n$/);
      assert.match(region(env, JANE_NOTE, 'transcript'), /One more remark\./);
      assert.deepEqual(env.world.notes.notices, [
        'No summary was written for this recording: the companion note keeps the one of an earlier visit to this meeting. Press Summarize to see a new one.',
      ]);
      // Said once, however many recordings follow.
      await env.c.startRecording();
      await until(env.world, env.c.stopRecording());
      await pass(env.world, 6000);
      assert.equal(env.world.notes.notices.length, 1);
      assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:30\n$/);
    });

    it('when a recording is started and stopped by mistake after a restart', async () => {
      const before = await firstVisit({}, 30);
      const env = await restart(before);
      env.world.llm.answer = telling;
      env.c.selectSection(JANE);
      await env.c.startRecording();
      await until(env.world, env.c.stopRecording());
      await pass(env.world, 6000);
      assert.equal(env.world.llm.chats.length, 0);
      assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:30\n$/);
    });

    it('when Summarize is pressed: the new one is shown, and replaces it only when asked for again', async () => {
      const before = await firstVisit({}, 30);
      const env = await restart(before);
      env.world.llm.answer = telling;
      env.c.selectSection(JANE);
      await env.c.startRecording();
      env.world.sources[0].say('One more remark.', 1, 2);
      await until(env.world, env.c.stopRecording());
      await pass(env.world, 6000);
      assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:30\n$/);
      assert.equal(env.world.notes.notices.length, 1);

      // A look at the meeting, a click on Summarize: what it writes covers this visit only.
      await env.c.summarize('executive');
      await pass(env.world, 6000);
      assert.equal(env.state().summary.status, 'done');
      assert.match(env.state().summary.markdown, /TURNS:1$/);
      assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:30\n$/, 'the note keeps the summary of the whole meeting');
      assert.equal(
        env.world.notes.notices[1],
        'The companion note keeps the summary of an earlier visit to this meeting. Press Summarize again to replace it.',
      );

      await env.c.summarize('executive');
      await pass(env.world, 6000);
      assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:1\n$/);
      assert.equal(env.world.notes.notices.length, 2);
      // From then on the summary is this visit's: the next stop writes it again by itself.
      await env.c.startRecording();
      env.world.sources[1].say('And another.', 1, 2);
      await until(env.world, env.c.stopRecording());
      await pass(env.world, 6000);
      assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:2\n$/);
    });

    it('when the Summarize that was to replace it fails or is cancelled: nothing was replaced, and no stop replaces it either', async () => {
      /** A later visit: Summarize pressed once, the new summary shown, the user told that the note keeps the earlier one. */
      async function toldOnce(): Promise<Env> {
        const before = await firstVisit({}, 30);
        const env = await restart(before);
        env.world.llm.answer = telling;
        env.c.selectSection(JANE);
        await settle();
        await env.c.summarize('executive');
        await pass(env.world, 6000);
        assert.equal(env.state().summary.status, 'done');
        assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:30\n$/);
        assert.equal(env.world.notes.notices.length, 1);
        assert.match(env.world.notes.notices[0], /Press Summarize again to replace it\.$/);
        return env;
      }

      /** One remark, a stop: no summary is started by itself, and the one in the note stays. */
      async function stopKeepsIt(env: Env): Promise<void> {
        env.world.llm.answer = telling;
        const calls = summaryCalls(env);
        await env.c.startRecording();
        env.world.sources[0].say('One more remark.', 1, 2);
        await until(env.world, env.c.stopRecording());
        await pass(env.world, 10_000);
        assert.equal(summaryCalls(env), calls, 'the stop asked nothing of the model');
        assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:30\n$/);
        // Asked for once more, and written this time: it replaces the earlier one.
        await env.c.summarize('executive');
        await pass(env.world, 6000);
        assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:1\n$/);
      }

      // Ollama is down when Summarize is pressed the second time.
      const failed = await toldOnce();
      failed.world.llm.answer = () => unreachableError();
      await failed.c.summarize('executive');
      await pass(failed.world, 6000);
      assert.equal(failed.state().summary.status, 'error');
      assert.match(region(failed, JANE_NOTE, 'summary'), /TURNS:30\n$/);
      await stopKeepsIt(failed);

      // The second run is cancelled while it writes.
      const cancelled = await toldOnce();
      const open = cancelled.world.llm.hold();
      const running = cancelled.c.summarize('executive');
      await settle();
      assert.equal(cancelled.state().summary.status, 'running');
      cancelled.c.cancelSummary();
      open();
      await running;
      await pass(cancelled.world, 6000);
      assert.equal(cancelled.state().summary.status, 'idle');
      assert.match(region(cancelled, JANE_NOTE, 'summary'), /TURNS:30\n$/);
      await stopKeepsIt(cancelled);
    });

    it('when Summarize is pressed before the note has been read: it runs at once, and waits to know what the note holds', async () => {
      const before = await firstVisit({}, 30);
      const env = await restart(before);
      env.world.llm.answer = telling;
      env.c.selectSection(JANE);
      const running = env.c.summarize('recap');
      assert.equal(env.state().summary.status, 'running', 'in the same tick');
      await running;
      await pass(env.world, 6000);
      assert.equal(env.state().summary.status, 'done');
      assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:30\n$/);
      assert.equal(env.world.notes.notices.length, 1);

      // And when the note turns out to hold none, the summary that waited is saved.
      const empty = await withCompanion();
      empty.world.llm.answer = telling;
      await empty.c.endMeeting();
      empty.c.selectSection(JANE);
      await empty.c.summarize('recap');
      await pass(empty.world, 6000);
      assert.match(region(empty, JANE_NOTE, 'summary'), /^### Recap\n\n#### Overview\nTURNS:0\n$/);
      assert.deepEqual(empty.world.notes.notices, []);
    });

    it('when a meeting started on its own, recorded and summarized, is linked to the section it belongs to', async () => {
      const before = await firstVisit({}, 30);
      const env = await restart(before);
      env.world.llm.answer = telling;
      env.c.newMeeting();
      await env.c.startRecording();
      env.world.sources[0].say('Said in the corridor.', 1, 2);
      await until(env.world, env.c.stopRecording());
      await settle();
      assert.equal(env.state().summary.status, 'done');
      type(env, env.world.notes.dailyText ?? '', '- budget');
      await env.c.linkAtCursor();
      assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
      await pass(env.world, 6000);
      assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:30\n$/);
      assert.match(region(env, JANE_NOTE, 'transcript'), /Said in the corridor\./);
      assert.equal(env.world.notes.notices.filter((notice) => /keeps the summary of an earlier visit/.test(notice)).length, 1);

      await env.c.summarize('executive');
      await pass(env.world, 6000);
      assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:1\n$/);
    });

    it('and still writes the first summary of a note that has none', async () => {
      const env = await withCompanion();
      env.world.llm.answer = telling;
      await env.c.endMeeting();
      env.c.selectSection(JANE);
      await env.c.startRecording();
      env.world.sources[0].say('One remark.', 1, 2);
      await until(env.world, env.c.stopRecording());
      await pass(env.world, 6000);
      assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:1\n$/);
      assert.deepEqual(env.world.notes.notices, []);
    });
  });
});

/* "Save there again" promises to replace a region that was edited by hand with what the sidebar
   shows. On a later visit to the meeting that is also what the earlier visit's notes and summary
   wait for: the one ask is enough. */
describe('a region of an earlier visit, edited by hand and asked for again', () => {
  function telling(req: ChatRequest): string {
    const items = promptItems(req);
    const user = userMessage(req);
    if (items.length > 0) {
      const from = user.includes('<excerpts>') ? 'GROUNDED' : 'SHORTHAND ONLY';
      return items.map((item) => `${item.n}. **Note:** ${item.text} (${from})`).join('\n');
    }
    if (isQuestion(req)) return 'The notes say so [1].';
    return `### Overview\nTURNS:${(user.match(/^\[\d\d:\d\d\] /gm) ?? []).length}`;
  }
  const flagged = (env: Env): Region[] => env.state().meeting?.editedOutside ?? [];

  /** A later visit to a meeting whose note holds the notes and the summary of thirty turns; one line was added since. */
  async function laterVisit(): Promise<Env> {
    const before = await withCompanion();
    before.world.llm.answer = telling;
    await before.c.startRecording();
    for (let i = 0; i < 30; i++) {
      before.world.sources[0].say('The vendor contract renewal may slip to November, said the vendor.', i * 40, i * 40 + 35);
    }
    await until(before.world, before.c.stopRecording());
    await settle();
    await before.c.enhanceNow();
    await pass(before.world, 6000);
    assert.match(region(before, JANE_NOTE, 'summary'), /TURNS:30\n$/);

    const env = await restart(before);
    // As in Obsidian: the plugin's own writes come back as changes to the note.
    env.world.notes.onWrite = (path) => env.session.handleVaultChange({ type: 'modify', path });
    env.world.llm.answer = telling;
    const text = (env.world.notes.dailyText ?? '').replace('#### Risks', '- hiring: two roles open\n#### Risks');
    env.world.notes.setDaily(text);
    env.session.handleDailyAvailability();
    await settle();
    env.c.selectSection(JANE);
    await settle();
    return env;
  }

  /** A paragraph added by hand to the enhanced notes and to the summary, seen and set aside. */
  async function editBoth(env: Env): Promise<void> {
    const note = env.world.notes.files.get(JANE_NOTE) ?? '';
    env.world.notes.files.set(
      JANE_NOTE,
      note
        .replace('<!-- hamster:end enhanced -->', 'A paragraph of my own.\n<!-- hamster:end enhanced -->')
        .replace('<!-- hamster:end summary -->', 'My own closing remark.\n<!-- hamster:end summary -->'),
    );
    env.session.handleVaultChange({ type: 'modify', path: JANE_NOTE });
    await pass(env.world, 4000);
    assert.deepEqual(flagged(env), ['enhanced', 'summary']);
    assert.match(env.world.notes.notices.at(-1) ?? '', /^The enhanced notes and summary in the companion note were edited by hand/);
  }

  it('is replaced with what the sidebar shows, without another press of Enhance or Summarize', async () => {
    const env = await laterVisit();
    await env.c.enhanceNow();
    await pass(env.world, 6000);
    await env.c.summarize('executive');
    await pass(env.world, 6000);
    // Shown, not saved: the user has been told once of each.
    assert.equal(env.world.notes.notices.length, 2);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /GROUNDED/);
    assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:30\n$/);
    await editBoth(env);
    const said = env.world.notes.notices.length;

    await env.c.createCompanion();
    await pass(env.world, 8000);
    assert.deepEqual(flagged(env), []);
    const enhanced = region(env, JANE_NOTE, 'enhanced');
    assert.doesNotMatch(enhanced, /A paragraph of my own/);
    assert.doesNotMatch(enhanced, /GROUNDED/);
    assert.equal(enhanced.match(/\(SHORTHAND ONLY\)$/gm)?.length, 4);
    const summary = region(env, JANE_NOTE, 'summary');
    assert.doesNotMatch(summary, /My own closing remark/);
    assert.match(summary, /TURNS:0\n$/);
    assert.equal(env.world.notes.notices.length, said, 'nothing more to say: it was done');

    // From then on both are this visit's own: saved as they change.
    type(env, (env.world.notes.dailyText ?? '').replace('#### Risks', '- travel: none\n#### Risks'), '- travel');
    await env.c.enhanceNow();
    await pass(env.world, 8000);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /travel: none/);
    await env.c.startRecording();
    env.world.sources[0].say('One more remark.', 1, 2);
    await until(env.world, env.c.stopRecording());
    await pass(env.world, 10_000);
    assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:1\n$/);
    assert.equal(env.world.notes.notices.length, said);
  });

  it('keeps the guard of the earlier visit where the sidebar has nothing to put in its place', async () => {
    const env = await laterVisit();
    // Nothing was enhanced or summarized in this visit: the sidebar shows neither.
    await editBoth(env);
    const held = { enhanced: region(env, JANE_NOTE, 'enhanced'), summary: region(env, JANE_NOTE, 'summary') };
    await env.c.createCompanion();
    await pass(env.world, 8000);
    assert.deepEqual(flagged(env), []);
    assert.equal(region(env, JANE_NOTE, 'enhanced'), held.enhanced);
    assert.equal(region(env, JANE_NOTE, 'summary'), held.summary);

    // Later in the visit a stop still starts no summary over it, and a Live run is shown, not saved.
    const calls = env.world.llm.chats.length;
    await env.c.startRecording();
    env.world.sources[0].say('One more remark.', 1, 2);
    await until(env.world, env.c.stopRecording());
    await pass(env.world, 10_000);
    assert.equal(env.world.llm.chats.length, calls);
    assert.equal(region(env, JANE_NOTE, 'summary'), held.summary);
    env.c.setLiveEnhance(true);
    type(env, (env.world.notes.dailyText ?? '').replace('#### Risks', '- travel: none\n#### Risks'), '- travel');
    await pass(env.world, 12_000, 500);
    assert.ok(env.state().enhanced.some((e) => /travel: none/.test(e.bullet ?? '')));
    assert.equal(region(env, JANE_NOTE, 'enhanced'), held.enhanced);
  });
});

/* A meeting can lose its note (deleted by hand, as a duplicate) and be given another one that
   already exists: the note of its section, with the work of an earlier visit in it. What that
   note holds is no more this visit's to replace than if it had been met first. */
describe('another note, adopted after the meeting lost its own', () => {
  function telling(req: ChatRequest): string {
    const items = promptItems(req);
    const user = userMessage(req);
    if (items.length > 0) {
      const from = user.includes('<excerpts>') ? 'GROUNDED' : 'SHORTHAND ONLY';
      return items.map((item) => `${item.n}. **Note:** ${item.text} (${from})`).join('\n');
    }
    if (isQuestion(req)) return 'The notes say so [1].';
    return `### Overview\nTURNS:${(user.match(/^\[\d\d:\d\d\] /gm) ?? []).length}`;
  }
  const NO_LONGER_THERE = 'The companion note is no longer there. Create it again to keep saving.';

  /**
   * An earlier visit recorded Jane's meeting, enhanced and summarized it. After a restart, a
   * meeting started on its own has a note of its own and a line in it, and is linked to Jane's section.
   */
  async function linkedWithOwnNote(): Promise<{ env: Env; own: string; summary: string; enhanced: string }> {
    const before = await withCompanion({ local: { firstWriteConfirmed: true } });
    before.world.llm.answer = telling;
    await before.c.startRecording();
    for (let i = 0; i < 30; i++) {
      before.world.sources[0].say('The vendor contract renewal may slip to November, said the vendor.', i * 40, i * 40 + 35);
    }
    await until(before.world, before.c.stopRecording());
    await settle();
    await before.c.enhanceNow();
    await pass(before.world, 6000);
    const summary = region(before, JANE_NOTE, 'summary');
    const enhanced = region(before, JANE_NOTE, 'enhanced');
    assert.match(summary, /TURNS:30\n$/);
    assert.match(enhanced, /\(GROUNDED\)$/m);

    const env = await restart(before);
    env.world.llm.answer = telling;
    env.c.newMeeting();
    await env.c.createCompanion();
    const own = env.state().meeting?.companionPath ?? '';
    assert.notEqual(own, JANE_NOTE);
    await pass(env.world, 1000);
    await env.c.startRecording();
    env.world.sources[0].say('Said in the corridor.', 1, 2);
    await pass(env.world, 6000);
    type(env, env.world.notes.dailyText ?? '', '- budget');
    await env.c.linkAtCursor();
    assert.equal(env.state().meeting?.companionPath, own, 'linked, it keeps its own note');
    return { env, own, summary, enhanced };
  }

  function lose(env: Env, path: string): void {
    env.world.notes.files.delete(path);
    env.session.handleVaultChange({ type: 'delete', path });
  }

  it('keeps its summary at the next stop, and its enhanced notes, as a note met first would', async () => {
    const { env, own, summary, enhanced } = await linkedWithOwnNote();
    lose(env, own);
    await env.c.createCompanion();
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE, "the section's note is adopted");
    await until(env.world, env.c.stopRecording());
    await pass(env.world, 10_000);
    assert.equal(region(env, JANE_NOTE, 'summary'), summary, 'no summary of one remark over that of the whole meeting');
    assert.equal(env.state().summary.status, 'idle');
    assert.match(region(env, JANE_NOTE, 'transcript'), /Said in the corridor\./);
    assert.deepEqual(env.world.notes.notices, [
      NO_LONGER_THERE,
      'No summary was written for this recording: the companion note keeps the one of an earlier visit to this meeting. Press Summarize to see a new one.',
    ]);
    // Its bullets are one per line of the section: they are the lines' own, and stay.
    assert.equal(env.state().enhanced.filter((e) => /GROUNDED/.test(e.bullet ?? '')).length, 3);
    await env.c.enhanceNow();
    await pass(env.world, 10_000);
    assert.equal(region(env, JANE_NOTE, 'enhanced'), enhanced);

    // Asked for, and asked for again: the summary is replaced.
    await env.c.summarize('executive');
    await pass(env.world, 6000);
    assert.equal(region(env, JANE_NOTE, 'summary'), summary);
    assert.match(env.world.notes.notices[2], /keeps the summary of an earlier visit/);
    await env.c.summarize('executive');
    await pass(env.world, 6000);
    assert.match(region(env, JANE_NOTE, 'summary'), /TURNS:1\n$/);
  });

  it('keeps its enhanced notes when this visit has written its own: they are shown, and replace them on Enhance', async () => {
    const { env, own, enhanced } = await linkedWithOwnNote();
    await env.c.enhanceNow();
    await pass(env.world, 6000);
    assert.equal(region(env, own, 'enhanced').match(/^- /gm)?.length, 3, "this visit's notes, in its own note");
    const mine = region(env, own, 'enhanced');
    lose(env, own);
    await env.c.createCompanion();
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    await pass(env.world, 6000);
    assert.equal(region(env, JANE_NOTE, 'enhanced'), enhanced);
    assert.deepEqual(env.world.notes.notices, [
      NO_LONGER_THERE,
      'The companion note keeps the enhanced notes of an earlier visit to this meeting. Press Enhance to replace them with the ones shown here.',
    ]);
    await env.c.enhanceNow();
    await pass(env.world, 6000);
    assert.equal(region(env, JANE_NOTE, 'enhanced'), mine);
  });

  it('is not taken for another note when it is the meeting\'s own, found again: what this visit wrote there is replaced as before', async () => {
    // Nothing was recorded: the note holds the bullets and the summary of this visit, and no line of transcript.
    const env = await withCompanion();
    env.world.llm.answer = telling;
    await env.c.enhanceNow();
    await env.c.summarize('executive');
    await pass(env.world, 6000);
    assert.match(region(env, JANE_NOTE, 'summary'), /^### Executive summary/);
    // Moved outside Obsidian: gone from its path, found again by its key.
    const moved = '10 Work/Meetings/Jane.md';
    env.world.notes.files.set(moved, env.world.notes.files.get(JANE_NOTE) ?? '');
    lose(env, JANE_NOTE);
    await env.c.createCompanion();
    assert.equal(env.state().meeting?.companionPath, moved);
    await pass(env.world, 6000);

    await env.c.summarize('recap');
    await pass(env.world, 6000);
    assert.match(region(env, moved, 'summary'), /^### Recap/, 'at the first press: the summary it replaces is its own');
    type(env, (env.world.notes.dailyText ?? '').replace('#### Risks', '- hiring: two roles open\n#### Risks'), '- hiring');
    await env.c.enhanceNow();
    await pass(env.world, 6000);
    assert.match(region(env, moved, 'enhanced'), /hiring: two roles open/);
    await env.c.startRecording();
    env.world.sources[0].say('One remark.', 1, 2);
    await until(env.world, env.c.stopRecording());
    await pass(env.world, 6000);
    assert.match(region(env, moved, 'summary'), /TURNS:1\n$/, 'and the stop writes its summary by itself');
    assert.deepEqual(env.world.notes.notices, [NO_LONGER_THERE]);
  });
});

/* The companion is the user's note too. What they change between the plugin's markers while the
   meeting is still open must not be replaced, without a word, by the next thing the plugin saves there. */
describe('a companion edited by hand while its meeting is open', () => {
  const EDITED = 'Q4 roadmap: identity migration first (owner: Jeanne, not Jane)';

  /** Jane's meeting, its companion, three bullets saved. */
  async function saved(options: FakeWorldOptions = {}): Promise<Env> {
    const env = await withCompanion(options);
    await env.c.enhanceNow();
    await pass(env.world, 5500);
    assert.equal(region(env, JANE_NOTE, 'enhanced').match(/^- /gm)?.length, 3);
    return env;
  }

  /** The note changes on disk, and the vault reports it, as after an edit in Obsidian. */
  function edit(env: Env, change: (text: string) => string): void {
    const text = env.world.notes.files.get(JANE_NOTE) ?? '';
    const next = change(text);
    assert.notEqual(next, text, 'the edit changes the note');
    env.world.notes.files.set(JANE_NOTE, next);
    env.session.handleVaultChange({ type: 'modify', path: JANE_NOTE });
  }

  const flagged = (env: Env): Region[] => env.state().meeting?.editedOutside ?? [];
  const correct = (text: string): string => text.replace('Q4 roadmap: identity migration first', EDITED);
  const oneMoreLine = (env: Env): void =>
    type(env, (env.world.notes.dailyText ?? '').replace('#### Risks', '- hiring: two roles open\n#### Risks'), '- hiring');

  it('takes a corrected bullet into the sidebar, and the next save carries the correction', async () => {
    const env = await saved();
    edit(env, correct);
    await pass(env.world, 2400, 400);
    assert.equal(env.state().enhanced[0].bullet, '**Note:** Q4 roadmap: identity migration first');
    await pass(env.world, 200, 100);
    assert.equal(env.state().enhanced[0].bullet, `**Note:** ${EDITED}`);
    assert.deepEqual(flagged(env), []);
    assert.deepEqual(env.world.notes.notices, []);

    oneMoreLine(env);
    await env.c.enhanceNow();
    await pass(env.world, 5500);
    assert.deepEqual(
      promptItems(env.world.llm.chats.at(-1) as ChatRequest).map((item) => item.text),
      ['hiring: two roles open'],
    );
    assert.deepEqual(region(env, JANE_NOTE, 'enhanced').trimEnd().split('\n'), [
      `- **Note:** ${EDITED}`,
      "- **Note:** budget: 2 postes gelés jusqu'en janvier",
      '- **Note:** hiring: two roles open',
      '',
      '#### Risks',
      '- **Note:** vendor contract renewal may slip to Nov',
    ]);
  });

  it('keeps the correction when the next bullet reaches the note before it was looked at', async () => {
    const env = await saved();
    edit(env, correct);
    // At once: another line is enhanced, and its save is on its way before the two and a half seconds are over.
    oneMoreLine(env);
    await env.c.enhanceNow();
    await until(env.world, env.session.flushAll());
    await pass(env.world, 6000);
    const lines = region(env, JANE_NOTE, 'enhanced').trimEnd().split('\n');
    assert.equal(lines[0], `- **Note:** ${EDITED}`);
    assert.equal(lines[2], '- **Note:** hiring: two roles open');
    assert.equal(env.state().enhanced[0].bullet, `**Note:** ${EDITED}`);
    assert.deepEqual(flagged(env), []);
  });

  it('waits for the run that is writing the corrected line, then takes the correction', async () => {
    const env = await saved();
    await env.c.startRecording();
    // A stretch of transcript: the first run after it writes every bullet again.
    env.world.sources[0].say('The roadmap for Q4 puts the identity migration first, said Jane.', 0, 35);
    await settle();
    const release = env.world.llm.hold();
    const running = env.c.enhanceNow();
    await settle();
    assert.equal(env.state().enhanced[0].streaming, true);
    edit(env, correct);
    await pass(env.world, 2600, 200);
    assert.deepEqual(flagged(env), ['enhanced'], 'held back while it cannot be taken in');
    release();
    await running;
    await pass(env.world, 9000, 500);
    assert.deepEqual(flagged(env), []);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /owner: Jeanne, not Jane/);
    assert.match(env.state().enhanced[0].bullet ?? '', /owner: Jeanne, not Jane/);
  });

  it('flags the enhanced notes when what was changed is not a bullet, and no longer writes there', async () => {
    const env = await saved();
    edit(env, (text) =>
      text.replace('<!-- hamster:end enhanced -->', 'A paragraph of my own, under the bullets.\n<!-- hamster:end enhanced -->'),
    );
    await pass(env.world, 2600, 200);
    assert.deepEqual(flagged(env), ['enhanced']);
    assert.deepEqual(env.world.notes.notices, [
      'The enhanced notes in the companion note were edited by hand: they are no longer replaced. Run "Create companion note" again to replace them with what the sidebar shows.',
    ]);
    const held = region(env, JANE_NOTE, 'enhanced');

    oneMoreLine(env);
    await env.c.enhanceNow();
    await pass(env.world, 6000);
    assert.equal(region(env, JANE_NOTE, 'enhanced'), held, 'the paragraph and the bullets stay as they were left');
    assert.equal(env.state().pendingWrites, 0);
    assert.equal(env.world.notes.notices.length, 1);
    // The other regions are written as before.
    await env.c.startRecording();
    env.world.sources[0].say('Still written down.', 1, 2);
    await pass(env.world, 5500);
    assert.match(region(env, JANE_NOTE, 'transcript'), /Still written down\./);

    // Asked for by name: what the sidebar shows replaces it.
    await env.c.createCompanion();
    await pass(env.world, 6000);
    assert.deepEqual(flagged(env), []);
    assert.doesNotMatch(region(env, JANE_NOTE, 'enhanced'), /A paragraph of my own/);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /hiring: two roles open/);
  });

  it('does not write a queued replacement over an edit it had not seen', async () => {
    const env = await saved();
    oneMoreLine(env);
    await env.c.enhanceNow();
    assert.equal(env.state().pendingWrites, 1, 'the new notes wait in the queue');
    edit(env, (text) =>
      text.replace('<!-- hamster:end enhanced -->', 'A paragraph of my own, under the bullets.\n<!-- hamster:end enhanced -->'),
    );
    await until(env.world, env.session.flushAll());
    assert.match(region(env, JANE_NOTE, 'enhanced'), /A paragraph of my own/);
    assert.doesNotMatch(region(env, JANE_NOTE, 'enhanced'), /hiring/);
    assert.deepEqual(flagged(env), ['enhanced']);
    assert.equal(env.state().pendingWrites, 0);

    // Asked for by name, the very same notes are written after all.
    await env.c.createCompanion();
    await pass(env.world, 6000);
    assert.deepEqual(flagged(env), []);
    assert.doesNotMatch(region(env, JANE_NOTE, 'enhanced'), /A paragraph of my own/);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /hiring: two roles open/);
  });

  /**
   * The note changes in its own editor. Obsidian saves it two seconds after the last keystroke:
   * until then nothing tells the plugin, and what it reads and writes is that editor's text.
   */
  function typeInNote(env: Env, change: (text: string) => string): void {
    const text = env.world.notes.files.get(JANE_NOTE) ?? '';
    const next = change(text);
    assert.notEqual(next, text, 'the edit changes the note');
    env.world.notes.files.set(JANE_NOTE, next);
  }

  it('keeps a correction typed in the note that no change of the vault has reported yet', async () => {
    const env = await saved();
    typeInNote(env, correct);
    // Meanwhile another line is enhanced, and the queue writes the notes five seconds later.
    oneMoreLine(env);
    await env.c.enhanceNow();
    await pass(env.world, 6000);
    assert.equal(
      region(env, JANE_NOTE, 'enhanced').trimEnd().split('\n')[0],
      `- **Note:** ${EDITED}`,
      'the write did not put the old bullet back',
    );
    // Taken in, the correction goes out with the new line in the next write.
    await pass(env.world, 6000);
    const lines = region(env, JANE_NOTE, 'enhanced').trimEnd().split('\n');
    assert.equal(lines[0], `- **Note:** ${EDITED}`);
    assert.equal(lines[2], '- **Note:** hiring: two roles open');
    assert.equal(env.state().enhanced[0].bullet, `**Note:** ${EDITED}`);
    assert.deepEqual(flagged(env), []);
    assert.deepEqual(env.world.notes.notices, []);
    assert.equal(env.state().pendingWrites, 0);
    // Obsidian saves at last: nothing new to see.
    env.session.handleVaultChange({ type: 'modify', path: JANE_NOTE });
    await pass(env.world, 4000);
    assert.equal(region(env, JANE_NOTE, 'enhanced').trimEnd().split('\n')[0], `- **Note:** ${EDITED}`);
    assert.deepEqual(flagged(env), []);
  });

  it('keeps a paragraph typed in the note before any change is reported, and says that the notes are set aside', async () => {
    const env = await saved();
    typeInNote(env, (text) =>
      text.replace('<!-- hamster:end enhanced -->', 'A paragraph of my own, under the bullets.\n<!-- hamster:end enhanced -->'),
    );
    oneMoreLine(env);
    await env.c.enhanceNow();
    await pass(env.world, 6000);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /A paragraph of my own/);
    assert.doesNotMatch(region(env, JANE_NOTE, 'enhanced'), /hiring/);
    assert.deepEqual(flagged(env), ['enhanced']);
    assert.equal(env.world.notes.notices.length, 1);
    assert.match(env.world.notes.notices[0], /^The enhanced notes in the companion note were edited by hand/);
    assert.equal(env.state().pendingWrites, 0);
  });

  it('keeps a summary edited in the note before any change is reported, when another one is written', async () => {
    const env = await saved();
    await env.c.summarize('executive');
    await pass(env.world, 5500);
    typeInNote(env, (text) =>
      text.replace('The meeting covered the plan and the budget.', 'We covered the plan; the budget is for next week.'),
    );
    await env.c.summarize('recap');
    await pass(env.world, 6000);
    assert.match(region(env, JANE_NOTE, 'summary'), /^### Executive summary\n\n#### Overview\nWe covered the plan; the budget is for next week\./);
    assert.deepEqual(flagged(env), ['summary']);
    assert.match(env.world.notes.notices[0], /^The summary in the companion note was edited by hand/);
  });

  it('reads the note before it replaces a region, and not for lines of transcript alone', async () => {
    const env = await saved();
    let reads = 0;
    const read = env.world.notes.readCompanion.bind(env.world.notes);
    env.world.notes.readCompanion = (path) => {
      reads += 1;
      return read(path);
    };
    await env.c.startRecording();
    env.world.sources[0].say('Written down as it is said.', 1, 2);
    await pass(env.world, 5500);
    assert.match(region(env, JANE_NOTE, 'transcript'), /Written down as it is said\./);
    assert.equal(reads, 0, 'the transcript is only added to: nothing to look at');

    oneMoreLine(env);
    await env.c.enhanceNow();
    await pass(env.world, 5500);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /hiring: two roles open/);
    assert.equal(reads, 1, 'once, for the batch that replaced the enhanced notes');
  });

  it('flags an edited summary: a new one is shown, and replaces it only when asked for by name', async () => {
    const env = await saved();
    await env.c.summarize('executive');
    await pass(env.world, 5500);
    assert.match(region(env, JANE_NOTE, 'summary'), /The meeting covered the plan and the budget\./);
    edit(env, (text) => text.replace('The meeting covered the plan and the budget.', 'We covered the plan; the budget is for next week.'));
    await pass(env.world, 2600, 200);
    assert.deepEqual(flagged(env), ['summary']);
    assert.match(env.world.notes.notices[0], /^The summary in the companion note was edited by hand: it is no longer replaced\./);

    await env.c.summarize('recap');
    await pass(env.world, 6000);
    assert.equal(env.state().summary.status, 'done');
    assert.match(region(env, JANE_NOTE, 'summary'), /^### Executive summary\n\n#### Overview\nWe covered the plan; the budget is for next week\./);

    await env.c.createCompanion();
    await pass(env.world, 6000);
    assert.deepEqual(flagged(env), []);
    assert.match(region(env, JANE_NOTE, 'summary'), /^### Recap\n/);
  });

  it('keeps an insight that was edited, and adds the next one after it, each once', async () => {
    const env = await saved();
    await env.c.ask('What is the plan?');
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await pass(env.world, 5500);
    assert.match(region(env, JANE_NOTE, 'qa'), /The notes say so/);
    edit(env, (text) => text.replace('The notes say so', 'The notes say so, and so does Jane'));
    await pass(env.world, 2600, 200);
    assert.deepEqual(flagged(env), [], 'nothing is held back: the region only grows');

    env.world.llm.answer = () => 'In January [1].';
    await env.c.ask('And when?');
    await env.c.keepInsight(env.state().qa.entries[1].id);
    await pass(env.world, 5500);
    const qa = region(env, JANE_NOTE, 'qa');
    assert.match(qa, /The notes say so, and so does Jane/);
    assert.match(qa, /In January/);
    assert.equal(qa.match(/^### /gm)?.length, 2);
    assert.equal(qa.match(/What is the plan\?/g)?.length, 1);
  });

  it('does not write the old version after all when the write had to be tried again', async () => {
    const env = await saved();
    await env.c.ask('What is the plan?');
    await env.c.keepInsight(env.state().qa.entries[0].id);
    await pass(env.world, 5500);
    // Everything is queued once more, as it stands in memory.
    await env.c.createCompanion();
    assert.ok(env.state().pendingWrites > 0);
    edit(env, (text) => text.replace('The notes say so', 'The notes say so, and so does Jane'));
    // The note is still busy in its editor: the write is asked to come back, and comes back whole.
    env.world.notes.recentlyEdited = true;
    const flushing = env.session.flushAll();
    await pass(env.world, 400, 100);
    env.world.notes.recentlyEdited = false;
    await until(env.world, flushing);
    await pass(env.world, 6000);
    assert.equal(env.state().pendingWrites, 0);
    const qa = region(env, JANE_NOTE, 'qa');
    assert.match(qa, /The notes say so, and so does Jane/);
    assert.equal(qa.match(/^### /gm)?.length, 1);
  });

  it('says so once a correction that waited for a run cannot be taken in after all', async () => {
    const env = await saved();
    await env.c.startRecording();
    env.world.sources[0].say('The roadmap for Q4 puts the identity migration first, said Jane.', 0, 35);
    await settle();
    const release = env.world.llm.hold();
    const running = env.c.enhanceNow();
    await settle();
    edit(env, correct);
    await pass(env.world, 2600, 200);
    assert.deepEqual(flagged(env), ['enhanced']);
    assert.deepEqual(env.world.notes.notices, [], 'it may still be taken in');
    // Before the run is over the line itself is edited in the daily: its bullet has no line to go to.
    type(
      env,
      (env.world.notes.dailyText ?? '').replace('- Q4 roadmap: identity migration first', '- Q4 roadmap: network first'),
      '- Q4 roadmap',
    );
    release();
    await running;
    await pass(env.world, 9000, 500);
    assert.deepEqual(flagged(env), ['enhanced']);
    assert.equal(env.world.notes.notices.length, 1);
    assert.match(env.world.notes.notices[0], /^The enhanced notes in the companion note were edited by hand/);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /owner: Jeanne, not Jane/);
  });

  it('says nothing of its own writes, of the date it sets, or of an edit outside its markers', async () => {
    const env = await saved();
    env.session.handleVaultChange({ type: 'modify', path: JANE_NOTE });
    await env.c.startRecording();
    env.world.sources[0].say('We agreed on the plan.', 1, 3);
    await until(env.world, env.c.stopRecording());
    env.session.handleVaultChange({ type: 'modify', path: JANE_NOTE });
    await pass(env.world, 6000);
    edit(env, (text) => text.replace('# 1:1 Jane Example', '# 1:1 Jane Example\n\nA note of my own, above the sections.'));
    edit(env, (text) => text.replace('<!-- hamster:end transcript -->', '> A line I added to the transcript.\n<!-- hamster:end transcript -->'));
    await pass(env.world, 6000);
    oneMoreLine(env);
    await env.c.enhanceNow();
    env.session.handleVaultChange({ type: 'modify', path: JANE_NOTE });
    await pass(env.world, 6000);
    assert.deepEqual(flagged(env), []);
    assert.deepEqual(env.world.notes.notices, []);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /hiring: two roles open/);
    assert.match(env.world.notes.files.get(JANE_NOTE) ?? '', /A note of my own, above the sections\./);
    assert.match(region(env, JANE_NOTE, 'transcript'), /A line I added to the transcript\./);
  });

  it('takes a corrected bullet in for a note that was adopted, not created, in this visit', async () => {
    const before = await saved();
    const env = await restart(before);
    // A meeting started on its own, then linked to the section that has the note.
    env.c.newMeeting();
    type(env, env.world.notes.dailyText ?? '', '- budget');
    await env.c.linkAtCursor();
    assert.equal(env.state().meeting?.companionPath, JANE_NOTE);
    assert.equal(env.state().enhanced.filter((e) => e.bullet !== null).length, 3);
    // A trailing blank, a blank line more: neither is an edit worth a word.
    edit(env, (text) => correct(text).replace(`${EDITED}\n`, `${EDITED}  \n\n`));
    await pass(env.world, 2600, 200);
    assert.deepEqual(flagged(env), []);
    assert.equal(env.state().enhanced[0].bullet, `**Note:** ${EDITED}`);
    assert.deepEqual(env.world.notes.notices, []);
  });

  it('takes none of its own writes for an edit, through a whole meeting with the vault reporting each one', async () => {
    const env = await boot({ local: { firstWriteConfirmed: true } });
    // As in Obsidian: every change to the note comes back as a `modify` event, the plugin's own included.
    env.world.notes.onWrite = (path) => env.session.handleVaultChange({ type: 'modify', path });
    env.c.selectSection(JANE);
    await env.c.createCompanion();
    await pass(env.world, 1500);
    env.c.setLiveEnhance(true);
    await env.c.startRecording();
    const source = env.world.sources[0];
    for (let i = 0; i < 6; i++) {
      source.say(`The vendor contract renewal may slip to November, said speaker ${i}.`, i * 40, i * 40 + 35);
      if (i === 1) oneMoreLine(env);
      if (i === 3) {
        await env.c.ask('What is the plan?');
        await env.c.keepInsight(env.state().qa.entries[0].id);
      }
      await pass(env.world, 7000, 500);
    }
    await until(env.world, env.c.stopRecording());
    await pass(env.world, 12_000, 500);
    await env.c.summarize('recap');
    await env.c.ask('And when?');
    await env.c.keepInsight(env.state().qa.entries[1].id);
    await env.c.createCompanion();
    await pass(env.world, 12_000, 500);

    assert.deepEqual(flagged(env), []);
    assert.deepEqual(env.world.notes.notices, []);
    assert.equal(env.state().pendingWrites, 0);
    assert.equal(region(env, JANE_NOTE, 'enhanced').match(/^- /gm)?.length, 4);
    assert.match(region(env, JANE_NOTE, 'summary'), /^### Recap\n/);
    assert.equal(region(env, JANE_NOTE, 'qa').match(/^### /gm)?.length, 2);
    assert.equal(region(env, JANE_NOTE, 'transcript').match(/said speaker/g)?.length, 6);
    // The last look at the note starts no other: nothing is read once the vault is quiet.
    let reads = 0;
    const read = env.world.notes.readCompanion.bind(env.world.notes);
    env.world.notes.readCompanion = (path) => {
      reads += 1;
      return read(path);
    };
    await pass(env.world, 30_000, 1000);
    assert.equal(reads, 0);
  });

  it('sets the notes aside rather than write a correction back changed', async () => {
    const env = await saved();
    // A wikilink typed by hand: the plugin writes none, and would take this one out again.
    edit(env, (text) => text.replace('- **Note:** Q4 roadmap: identity migration first', '- **Note:** Q4 roadmap: see [[Identity Plan]] first'));
    await pass(env.world, 2600, 200);
    assert.deepEqual(flagged(env), ['enhanced']);
    oneMoreLine(env);
    await env.c.enhanceNow();
    await pass(env.world, 6000);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /see \[\[Identity Plan\]\] first/);
    assert.doesNotMatch(region(env, JANE_NOTE, 'enhanced'), /hiring/);

    // Met again in a later visit, such notes are not handed to the engine: nothing replaces them unasked.
    const later = await restart(env);
    later.c.setLiveEnhance(true);
    later.c.selectSection(JANE);
    await settle();
    assert.equal(later.state().enhanced.filter((e) => e.bullet !== null).length, 0);
    type(later, (later.world.notes.dailyText ?? '').replace('#### Risks', '- hiring: two roles open\n#### Risks'), '- hiring');
    await pass(later.world, 9000, 500);
    assert.match(region(later, JANE_NOTE, 'enhanced'), /see \[\[Identity Plan\]\] first/);
    assert.equal(later.world.notes.notices.length, 1);
    assert.match(later.world.notes.notices[0], /keeps the enhanced notes of an earlier visit/);
  });

  it('forgets the flags with the meeting', async () => {
    const env = await saved();
    edit(env, (text) => text.replace('<!-- hamster:end enhanced -->', 'Mine.\n<!-- hamster:end enhanced -->'));
    await pass(env.world, 2600, 200);
    assert.deepEqual(flagged(env), ['enhanced']);
    env.c.selectSection(BOARD);
    assert.deepEqual(flagged(env), []);
    // Met again, the note is what it is: its bullets are not one per line, and nothing replaces them unasked.
    env.c.selectSection(JANE);
    await pass(env.world, 6000);
    assert.deepEqual(flagged(env), []);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /Mine\./);
  });
});

describe('meetings started on their own, once they are left', () => {
  /** New meeting, one remark recorded, its note created. */
  async function manualWithNote(): Promise<{ env: Env; key: string; note: string }> {
    const env = await boot({ local: { firstWriteConfirmed: true } });
    env.c.newMeeting();
    await env.c.startRecording();
    env.world.sources[0].say('Said in the corridor.', 1, 2);
    await until(env.world, env.c.stopRecording());
    await settle();
    await env.c.createCompanion();
    await pass(env.world, 6200);
    const key = env.state().meeting?.key ?? '';
    const note = env.state().meeting?.companionPath ?? '';
    assert.match(key, /^manual:/);
    assert.match(region(env, note, 'transcript'), /Said in the corridor\./);
    return { env, key, note };
  }

  it('stay in the list of the day with their note, after the sections', async () => {
    const { env, key, note } = await manualWithNote();
    // While it is the current meeting the sidebar shows it on its own: no row for it.
    assert.equal(row(env, key), undefined);
    assert.equal(env.state().sections.length, 4);

    env.c.selectSection(BOARD);
    assert.deepEqual(
      env.state().sections.map((s) => s.key),
      ['1:1 Sam#0', JANE, BOARD, 'Work#0', key],
    );
    const title = row(env, key)?.title ?? '';
    assert.match(title, /^New meeting \d\d:\d\d$/);
    assert.deepEqual(row(env, key), {
      key,
      title,
      rawTitle: title,
      ordinal: 0,
      anchorLine: -1,
      isHeading: false,
      group: 'meeting',
      companionPath: note,
      current: false,
    });
    // The list is rebuilt from the daily at every keystroke: the row stays.
    type(env, `${DAILY}\n### Retro\n`, null);
    assert.equal(env.state().sections.at(-1)?.key, key);
  });

  it('can be picked up again: the same note, and a recording set apart from the first', async () => {
    const { env, key, note } = await manualWithNote();
    env.c.selectSection(BOARD);
    env.c.selectSection(key);
    const meeting = env.state().meeting;
    assert.equal(meeting?.key, key);
    assert.equal(meeting?.manual, true);
    assert.equal(meeting?.source, null);
    assert.equal(meeting?.companionPath, note);
    assert.equal(env.state().tab, 'notes');
    assert.equal(row(env, key), undefined, 'current again: shown on its own');
    assert.deepEqual(env.world.notes.notices, []);

    await env.c.startRecording();
    env.world.sources[1].say('And one more thing.', 1, 2);
    await until(env.world, env.c.stopRecording());
    await pass(env.world, 6200);
    const lines = region(env, note, 'transcript').trimEnd().split('\n');
    assert.equal(lines.length, 4);
    assert.equal(lines[1], '> **[00:01] Fred:** Said in the corridor.');
    assert.match(lines[2], /^> \*\*— recording resumed at \d\d:\d\d —\*\*$/);
    assert.equal(lines[3], '> **[00:01] Fred:** And one more thing.');
    assert.equal([...env.world.notes.files.keys()].filter((path) => path.includes('New meeting')).length, 1);
  });

  it('leave the list when they are linked to a section, when their note is gone, and with the day', async () => {
    const linked = await manualWithNote();
    type(linked.env, DAILY, '- budget');
    await linked.env.c.linkAtCursor();
    linked.env.c.selectSection(BOARD);
    assert.equal(row(linked.env, linked.key), undefined);
    assert.equal(row(linked.env, JANE)?.companionPath, linked.note, 'the section has the note now');

    const renamed = await manualWithNote();
    renamed.env.c.selectSection(BOARD);
    const moved = '10 Work/Meetings/Corridor.md';
    renamed.env.world.notes.files.set(moved, renamed.env.world.notes.files.get(renamed.note) ?? '');
    renamed.env.world.notes.files.delete(renamed.note);
    renamed.env.session.handleVaultChange({ type: 'rename', path: moved, oldPath: renamed.note });
    assert.equal(row(renamed.env, renamed.key)?.companionPath, moved, 'a note that moved is followed');
    renamed.env.world.notes.files.delete(moved);
    renamed.env.session.handleVaultChange({ type: 'delete', path: moved });
    assert.equal(row(renamed.env, renamed.key), undefined);
    renamed.env.c.selectSection(renamed.key);
    assert.equal(renamed.env.state().meeting?.key, BOARD, 'nothing left to pick up');

    const next = await manualWithNote();
    next.env.c.selectSection(BOARD);
    await until(next.env.world, next.env.c.endMeeting());
    next.env.world.notes.date = '2026-10-10';
    next.env.session.handleDailyAvailability();
    await settle();
    assert.deepEqual(next.env.state().sections, []);
  });

  it('are not listed without a note: there would be nothing to come back to', async () => {
    const env = await boot();
    env.c.newMeeting();
    const key = env.state().meeting?.key ?? '';
    env.c.selectSection(BOARD);
    assert.equal(row(env, key), undefined);
    assert.equal(env.state().sections.length, 4);
  });
});

describe('a copy of the link line, pasted into another section', () => {
  it('leaves the meeting, its shorthand and its note with the section that still holds its own line', async () => {
    const daily = [
      '### Agenda',
      '- prepare the offsite',
      '- call the vendor',
      '',
      '### 1:1 [[Jane Example]]',
      '- Q4 roadmap: identity migration first',
      "- budget: 2 postes gelés jusqu'en janvier",
      '',
    ].join('\n');
    const env = await boot({ daily, local: { firstWriteConfirmed: true } });
    env.c.selectSection(JANE);
    await env.c.createCompanion();
    await pass(env.world, 1000);
    await env.c.enhanceNow();
    await pass(env.world, 6000);
    const saved = region(env, JANE_NOTE, 'enhanced');

    // Pasted above the meeting, in an index of the day's notes.
    const text = env.world.notes.dailyText ?? '';
    type(env, text.replace('- call the vendor\n', `- call the vendor\n${JANE_LINK}\n`), '- Q4 roadmap');
    assert.equal(env.state().meeting?.key, JANE);
    assert.deepEqual(
      env.state().shorthand.map((item) => item.text),
      ['Q4 roadmap: identity migration first', "budget: 2 postes gelés jusqu'en janvier"],
    );
    assert.equal(row(env, 'Agenda#0')?.companionPath, null);
    assert.equal(row(env, JANE)?.companionPath, JANE_NOTE);

    await env.c.enhanceNow();
    await pass(env.world, 6000);
    assert.equal(region(env, JANE_NOTE, 'enhanced'), saved);
    await env.c.createCompanion();
    assert.deepEqual(
      [...env.world.notes.files.keys()].filter((path) => path.includes('Mtg-')),
      [JANE_NOTE],
      'no second note for the same meeting',
    );
  });
});

describe('a task typed in the notes', () => {
  const TASK = '- [ ] send the budget to Marie';
  const withTask = (box = ' '): string =>
    DAILY.replace('- Q4 roadmap: identity migration first', `- Q4 roadmap: identity migration first\n- [${box}] send the budget to Marie`);

  async function enhancedWithTask(settings: Partial<HamsterSettings> = {}): Promise<Env> {
    const env = await withCompanion({ settings });
    type(env, withTask(), TASK);
    await env.c.enhanceNow();
    await pass(env.world, 6000);
    return env;
  }

  it('stays a task in the enhanced notes: marked, not a checkbox, by default', async () => {
    const env = await enhancedWithTask();
    const item = env.state().enhanced.find((e) => e.source === 'send the budget to Marie');
    assert.equal(item?.task, ' ');
    assert.equal(item?.bullet, '**Note:** send the budget to Marie', 'the model never sees the checkbox');
    const saved = region(env, JANE_NOTE, 'enhanced');
    assert.match(saved, /^- ☐ \*\*Note:\*\* send the budget to Marie$/m);
    assert.doesNotMatch(saved, /- \[ \]/, 'no checkbox for task tools to count twice');
    assert.match(saved, /^- \*\*Note:\*\* Q4 roadmap/m, 'other lines carry no mark');
  });

  it('is a checkbox when the setting asks for checkboxes', async () => {
    const env = await enhancedWithTask({ actionItemsAsTasks: true });
    assert.match(region(env, JANE_NOTE, 'enhanced'), /^- \[ \] \*\*Note:\*\* send the budget to Marie$/m);
  });

  it('ticked in the note, its bullet is marked done, without asking the model again', async () => {
    const env = await enhancedWithTask();
    const chats = env.world.llm.chats.length;
    type(env, withTask('x'), 'send the budget');
    await pass(env.world, 6000);
    assert.equal(env.world.llm.chats.length, chats);
    assert.match(region(env, JANE_NOTE, 'enhanced'), /^- ☑ \*\*Note:\*\* send the budget to Marie$/m);
  });

  it('a later visit takes its bullet back from the note, and writes it as it was', async () => {
    const before = await enhancedWithTask();
    const saved = region(before, JANE_NOTE, 'enhanced');
    await before.session.dispose();
    const env = await restart(before);
    env.c.selectSection(JANE);
    type(env, withTask(), TASK);
    await pass(env.world, 6000);
    const item = env.state().enhanced.find((e) => e.source === 'send the budget to Marie');
    assert.equal(item?.bullet, '**Note:** send the budget to Marie', 'taken back without its mark');
    assert.equal(region(env, JANE_NOTE, 'enhanced'), saved);
  });

  it('a task bullet reworded in the companion is carried; one ticked there is not the note\'s to change', async () => {
    const editNote = (env: Env, from: string, to: string): void => {
      const text = env.world.notes.files.get(JANE_NOTE) ?? '';
      assert.ok(text.includes(from));
      env.world.notes.files.set(JANE_NOTE, text.replace(from, to));
      env.session.handleVaultChange({ type: 'modify', path: JANE_NOTE });
    };

    const env = await enhancedWithTask();
    editNote(env, '- ☐ **Note:** send the budget to Marie', '- ☐ **Note:** send the Q4 budget to Marie by Friday');
    await pass(env.world, 2600, 200);
    assert.deepEqual(env.state().meeting?.editedOutside ?? [], [], 'carried, not set aside');
    const item = env.state().enhanced.find((e) => e.source === 'send the budget to Marie');
    assert.equal(item?.bullet, '**Note:** send the Q4 budget to Marie by Friday', 'without its mark');
    assert.match(region(env, JANE_NOTE, 'enhanced'), /^- ☐ \*\*Note:\*\* send the Q4 budget to Marie by Friday$/m);

    // Ticked in the companion: the task is the user's line, which the plugin never changes.
    const ticked = await enhancedWithTask();
    editNote(ticked, '- ☐ **Note:** send the budget to Marie', '- ☑ **Note:** send the budget to Marie');
    await pass(ticked.world, 2600, 200);
    assert.deepEqual(ticked.state().meeting?.editedOutside, ['enhanced']);
  });
});

describe('a meeting typed in a note other than the daily', () => {
  const NOTE = '10 Work/Budget review.md';
  const NOTE_TEXT = 'Q4 envelope 52k vs 40k\n- Dana owns the rollback plan\n';

  async function inNote(options: FakeWorldOptions = {}): Promise<Env> {
    const env = await boot({ local: { firstWriteConfirmed: true }, ...options });
    env.world.notes.files.set(NOTE, NOTE_TEXT);
    env.session.handleFocus({ path: NOTE, text: NOTE_TEXT, cursor: 0 });
    return env;
  }

  it('uses the whole note when it has no heading, and links the companion from that note', async () => {
    const env = await inNote();
    const dailyBefore = env.world.notes.dailyText;
    await env.c.useActiveNote();
    const meeting = env.state().meeting;
    assert.equal(meeting?.notePath, NOTE);
    assert.equal(meeting?.noteSection, null);
    assert.equal(meeting?.title, 'Budget review');
    assert.equal(meeting?.key, `note:${NOTE}`);
    assert.deepEqual(
      env.state().shorthand.map((item) => item.text),
      ['Q4 envelope 52k vs 40k', 'Dana owns the rollback plan'],
    );

    await env.c.createCompanion();
    await settle();
    await pass(env.world, 1000);
    const companion = env.state().meeting?.companionPath ?? '';
    assert.match(companion, /Mtg-2026-10-09 — Budget review\.md$/);
    const note = env.world.notes.files.get(NOTE) ?? '';
    assert.match(note, /↳ \[\[Mtg-2026-10-09 — Budget review\|Meeting notes\]\]/);
    assert.equal(env.world.notes.dailyText, dailyBefore, 'the daily is not touched');
    assert.match(env.world.notes.files.get(companion) ?? '', /links: \[.*\[\[Budget review\]\]/);

    // Its own link line, read back, is not shorthand.
    env.session.handleNoteUpdate({ path: NOTE, text: note, cursor: 0, userTyped: false });
    assert.equal(env.state().shorthand.length, 2);
  });

  it('takes the section under the cursor when the note has headings', async () => {
    const env = await boot({ local: { firstWriteConfirmed: true } });
    const text = '# Notes\nintro\n## Sync with Dana\n- rollback plan by Friday\n## Other\n- nothing\n';
    env.world.notes.files.set(NOTE, text);
    env.session.handleFocus({ path: NOTE, text, cursor: text.indexOf('rollback') });
    await env.c.useActiveNote();
    assert.deepEqual(env.state().meeting?.noteSection, { title: 'Sync with Dana', ordinal: 0 });
    assert.deepEqual(
      env.state().shorthand.map((item) => item.text),
      ['rollback plan by Friday'],
    );
  });

  it('forgets the daily section under the cursor once another note is in front', async () => {
    const env = await boot();
    type(env, DAILY, '- Q4 roadmap');
    assert.ok(env.state().activeSection);
    env.session.handleFocus({ path: NOTE, text: NOTE_TEXT, cursor: 0 });
    assert.equal(env.state().activeSection, null);
    assert.deepEqual(env.state().focusedNote, { path: NOTE, basename: 'Budget review', daily: false });
  });

  it('moves a meeting started with New meeting into the note, while it records', async () => {
    const env = await inNote();
    env.c.newMeeting();
    await env.c.startRecording();
    env.world.sources[0].say('We agreed on option B.', 1, 3);
    await env.c.useActiveNote();
    const meeting = env.state().meeting;
    assert.equal(meeting?.notePath, NOTE);
    assert.equal(meeting?.manual, false);
    assert.equal(env.state().recording, 'recording');
    assert.equal(env.state().turns.length, 1);
  });

  it('links the note when the daily is not in front, instead of asking for a daily section', async () => {
    const env = await inNote();
    env.c.newMeeting();
    await env.c.linkAtCursor();
    assert.equal(env.state().meeting?.notePath, NOTE);
  });

  it('runs Live Enhance for what is typed in that note only', async () => {
    const env = await inNote();
    await env.c.useActiveNote();
    env.c.setLiveEnhance(true);
    await pass(env.world, 9000);
    const before = env.world.llm.chats.length;
    // Another note's keystrokes, seen because it was in front for a moment.
    env.session.handleNoteUpdate({ path: '10 Work/Other.md', text: 'unrelated', cursor: 3, userTyped: true });
    await pass(env.world, 9000);
    assert.equal(env.world.llm.chats.length, before);
    env.session.handleNoteUpdate({ path: NOTE, text: `${NOTE_TEXT}- budget approved by Dana\n`, cursor: 5, userTyped: true });
    await pass(env.world, 9000);
    assert.ok(env.world.llm.chats.length > before);
  });

  it('is found again after a restart', async () => {
    const env = await inNote();
    await env.c.useActiveNote();
    await env.c.createCompanion();
    await settle();
    await pass(env.world, 1000);
    const companion = env.state().meeting?.companionPath;
    const again = await restart(env);
    const text = again.world.notes.files.get(NOTE) ?? '';
    again.session.handleFocus({ path: NOTE, text, cursor: 0 });
    await again.c.useActiveNote();
    await settle();
    assert.equal(again.state().meeting?.companionPath, companion);
  });

  it('follows the note when it is renamed', async () => {
    const env = await inNote();
    await env.c.useActiveNote();
    env.session.handleVaultChange({ type: 'rename', path: '10 Work/Budget review 2026.md', oldPath: NOTE });
    assert.equal(env.state().meeting?.notePath, '10 Work/Budget review 2026.md');
  });

  it('writes the whole meeting into the note itself, below a text that does not change', async () => {
    const env = await inNote();
    await env.c.writeIntoActiveNote();
    await settle();
    assert.equal(env.state().meeting?.companionPath, NOTE);
    let text = env.world.notes.files.get(NOTE) ?? '';
    assert.ok(text.includes(NOTE_TEXT.trimEnd()), 'the text is there as it was');
    assert.match(text, /^hamster_source: /m);
    assert.match(text, /<!-- hamster:begin enhanced -->/);

    // What the plugin added is not read back as shorthand.
    env.session.handleNoteUpdate({ path: NOTE, text, cursor: 0, userTyped: false });
    assert.deepEqual(
      env.state().shorthand.map((item) => item.text),
      ['Q4 envelope 52k vs 40k', 'Dana owns the rollback plan'],
    );

    await env.c.enhanceNow();
    await pass(env.world, 6000);
    assert.match(region(env, NOTE, 'enhanced'), /^- \*\*/m);
    text = env.world.notes.files.get(NOTE) ?? '';
    assert.ok(text.includes(NOTE_TEXT.trimEnd()), 'still untouched after the plugin wrote');
  });

  it('does not write a meeting into the daily', async () => {
    const env = await boot();
    type(env, DAILY, '- Q4 roadmap');
    await env.c.writeIntoActiveNote();
    assert.match(env.world.notes.notices.at(-1) ?? '', /daily note cannot hold one/);
    assert.equal(env.world.notes.preparedNotes.length, 0);
  });
});
