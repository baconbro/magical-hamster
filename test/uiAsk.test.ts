import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSession } from '../src/session/meetingSession.ts';
import {
  ANSWER_SOURCES_TEXT,
  confirmWriteText,
  coveredByAncestor,
  createCompanionHint,
  foldersToBuild,
  INDEX_FOLDERS_PENDING_TEXT,
  INDEX_NEEDS_FOLDER_TEXT,
  INDEX_NO_FOLDERS_TEXT,
  INDEX_SCOPE_TEXT,
  indexBuildBlocked,
  indexBuildLabel,
  indexFoldersNote,
  indexProblem,
  indexSummary,
  openPicker,
  pickerOutdated,
  toggleFolder,
  type PickerState,
} from '../src/ui/components/format.ts';
import type { HamsterSession, VaultIndexStatus } from '../src/types.ts';
import { makeWorld, type FakeWorld } from './helpers/fakes.ts';

const ready: VaultIndexStatus = {
  status: 'ready',
  files: 700,
  chunks: 6412,
  done: 700,
  total: 700,
  folders: ['10 Work'],
  error: null,
};

test('index: the summary line of each status', () => {
  assert.equal(indexSummary({ ...ready, status: 'none', files: 0, chunks: 0, done: 0, total: 0 }), 'Not indexed yet');
  assert.equal(indexSummary({ ...ready, status: 'building', done: 1200, total: 2400 }), 'Indexing 1,200 of 2,400 notes');
  assert.equal(indexSummary(ready), 'Indexed 700 notes, 6,412 passages');
  assert.equal(indexSummary({ ...ready, status: 'error', error: 'Ollama is not running.' }), 'Ollama is not running.');
  assert.equal(indexSummary({ ...ready, status: 'error', error: null }), 'The index could not be built.');
});

test('index: a build paused by a recording says so, and offers no button that could only be refused', () => {
  /* The index is paused only between the start and the end of a recording, and for exactly that
     stretch the session refuses a build: "Stop the recording before building the index." */
  const paused: VaultIndexStatus = { ...ready, status: 'paused', files: 0, chunks: 0, done: 12, total: 80 };
  assert.equal(
    indexSummary(paused),
    'Paused during the recording at 12 of 80 notes. It continues when the recording stops.',
  );
  assert.equal(indexBuildLabel('paused'), null);
  /* A running build has Cancel instead. */
  assert.equal(indexBuildLabel('building'), null);
  assert.equal(indexBuildLabel('ready'), 'Rebuild index');
  assert.equal(indexBuildLabel('none'), 'Build index');
  assert.equal(indexBuildLabel('error'), 'Build index');
  for (const status of ['none', 'building', 'ready', 'paused', 'error'] as const) {
    assert.doesNotMatch(indexBuildLabel(status) ?? '', /resume/i, status);
  }
});

test('index: a problem reported by an index that is still usable is shown', () => {
  /* One note could not be embedded: the build ends `ready`, with the note left out. */
  const skipped: VaultIndexStatus = { ...ready, files: 1, chunks: 1, done: 2, total: 2, error: '10 Work/Offsite.md: HTTP 500 from Ollama' };
  assert.equal(indexSummary(skipped), 'Indexed 1 notes, 1 passages');
  assert.equal(indexProblem(skipped), '10 Work/Offsite.md: HTTP 500 from Ollama');
  /* The index could not be written: everything is embedded again at the next start. */
  assert.equal(
    indexProblem({ ...ready, error: 'Could not save the index: ENOSPC: no space left on device' }),
    'Could not save the index: ENOSPC: no space left on device',
  );
  /* While building, and before any index exists. */
  assert.equal(indexProblem({ ...ready, status: 'building', error: 'A.md: timeout' }), 'A.md: timeout');
  assert.equal(indexProblem({ ...ready, status: 'none', error: 'A.md: timeout' }), 'A.md: timeout');
  /* Nothing to say. */
  assert.equal(indexProblem(ready), null);
  assert.equal(indexProblem({ ...ready, error: '  ' }), null);
  /* A build that failed outright: the summary line is the error, once. */
  assert.equal(indexProblem({ ...ready, status: 'error', error: 'Ollama is not running.' }), null);
});

test('ask: no sentence promises that only the chosen folders are read', () => {
  /* A question also sends the notes wikilinked in the meeting's section of the daily, in its
     heading and in any line under it, from anywhere in the vault. */
  for (const text of [ANSWER_SOURCES_TEXT, INDEX_SCOPE_TEXT]) {
    assert.match(text, /notes linked in its section/);
    /* Not the heading alone: a link in a line of the section is read too. */
    assert.doesNotMatch(text, /heading/);
    assert.doesNotMatch(text, /^Answers only use the folders you choose/);
  }
  assert.equal(
    ANSWER_SOURCES_TEXT,
    'Ask a question below. Answers come from this meeting, the notes linked in its section, and the notes you indexed.',
  );
  assert.equal(
    INDEX_SCOPE_TEXT,
    'Besides this meeting and the notes linked in its section, answers only use the folders you choose. The index stays on this computer.',
  );
});

test('index: an emptied list of folders says that nothing indexed is used, and has nothing to build', () => {
  /* The session publishes this when "Indexed folders" was emptied in the settings while an index
     over other folders exists: the index is still there, and answers use none of its notes. */
  const emptied: VaultIndexStatus = { ...ready, folders: [], foldersPending: true };
  const note = indexFoldersNote(emptied);
  assert.equal(note, INDEX_NO_FOLDERS_TEXT);
  assert.equal(note, 'No folder is chosen. Answers use no indexed notes until you choose folders and rebuild the index.');
  /* Not the line for a changed list: "Rebuild the index to apply" would point at a disabled button. */
  assert.notEqual(note, INDEX_FOLDERS_PENDING_TEXT);
  assert.equal(indexFoldersNote({ ...ready, folders: ['20 Other'], foldersPending: true }), INDEX_FOLDERS_PENDING_TEXT);
  /* An index that failed can be built too; while a build runs or is paused there is no button. */
  assert.equal(indexFoldersNote({ ...emptied, status: 'error', error: 'Ollama is not running.' }), INDEX_NO_FOLDERS_TEXT);
  for (const status of ['building', 'paused'] as const) assert.equal(indexFoldersNote({ ...emptied, status }), null, status);
  /* Nothing said without the session's flag: before any index exists there is no folder either. */
  assert.equal(indexFoldersNote({ ...emptied, foldersPending: false }), null);
  assert.equal(indexFoldersNote({ ...ready, status: 'none', files: 0, chunks: 0, done: 0, total: 0, folders: [] }), null);

  /* The button is there, and disabled: with the picker closed it would build the empty list. */
  assert.equal(indexBuildLabel(emptied.status), 'Rebuild index');
  assert.deepEqual(foldersToBuild(null, emptied.folders), []);
  assert.equal(indexBuildBlocked(foldersToBuild(null, emptied.folders)), INDEX_NEEDS_FOLDER_TEXT);
  assert.equal(INDEX_NEEDS_FOLDER_TEXT, 'Choose at least one folder first');

  /* The picker opens with nothing ticked, and the button stays disabled until a folder is. */
  let picker = openPicker(['10 Work', '10 Work/Meetings', '20 Other'], emptied.folders);
  assert.deepEqual(picker.rows.map((row) => row.path), ['10 Work', '10 Work/Meetings', '20 Other']);
  assert.equal(picker.selected.size, 0);
  assert.equal(indexBuildBlocked(foldersToBuild(picker, emptied.folders)), INDEX_NEEDS_FOLDER_TEXT);
  picker = toggleFolder(picker, '20 Other');
  assert.deepEqual(foldersToBuild(picker, emptied.folders), ['20 Other']);
  assert.equal(indexBuildBlocked(foldersToBuild(picker, emptied.folders)), null);
  /* Unticked again: disabled again. */
  picker = toggleFolder(picker, '20 Other');
  assert.equal(indexBuildBlocked(foldersToBuild(picker, emptied.folders)), INDEX_NEEDS_FOLDER_TEXT);
  /* The list is still the empty one it was opened from: the picker stays open while folders are ticked. */
  assert.equal(pickerOutdated(picker, emptied.folders), false);
  assert.equal(pickerOutdated(picker, []), false);
});

test('picker: it is outdated once the published list is another one, whatever was ticked meanwhile', () => {
  const folders = ['10 Work', '20 Other'];
  let picker = openPicker(['10 Work', '20 Other', '30 Deep'], folders);
  assert.deepEqual(picker.from, folders);
  assert.deepEqual([...picker.selected], folders);
  assert.equal(pickerOutdated(picker, folders), false);
  /* Ticks are the picker's own: they do not make it outdated, and the list it started from is kept. */
  picker = toggleFolder(picker, '30 Deep');
  picker = toggleFolder(picker, '10 Work');
  assert.deepEqual(foldersToBuild(picker, folders), ['20 Other', '30 Deep']);
  assert.deepEqual(picker.from, folders);
  assert.equal(pickerOutdated(picker, folders), false);
  /* The same list in another array is the same list: only a change closes the picker. */
  assert.equal(pickerOutdated(picker, [...folders]), false);
  /* A folder added, removed, replaced, the list emptied, or put in another order. */
  for (const changed of [['10 Work', '20 Other', '30 Deep'], ['10 Work'], ['10 Work', '30 Deep'], [], ['20 Other', '10 Work']]) {
    assert.equal(pickerOutdated(picker, changed), true, JSON.stringify(changed));
  }
  /* The list it was opened from is a copy: a list changed in place is seen too. */
  const live = ['10 Work'];
  const opened = openPicker(['10 Work', '20 Other'], live);
  live.push('20 Other');
  assert.equal(pickerOutdated(opened, live), true);
  /* The whole vault spelled with an empty name is ticked on its `/` row. */
  assert.deepEqual([...openPicker([], ['']).selected], ['/']);
  /* With no picker the button builds the published list as it is. */
  assert.equal(foldersToBuild(null, folders), folders);
});

test('notes: the hint under Create companion note promises a link line only to a meeting tied to a section', () => {
  assert.equal(
    createCompanionHint('00 Inbox', false),
    'Creates one note in 00 Inbox and adds one link line to your daily note. Nothing is written before this.',
  );
  /* Started with New meeting: the note is created and the daily is left as it is. */
  const manual = createCompanionHint('00 Inbox', true);
  assert.equal(
    manual,
    'Creates one note in 00 Inbox. This meeting is not tied to your notes yet, so no line is added anywhere. Nothing is written before this.',
  );
  /* Typed in a note of its own: the line goes there, not into the daily. */
  assert.equal(
    createCompanionHint('00 Inbox', false, 'Budget review'),
    'Creates one note in 00 Inbox and adds one link line to “Budget review”. Nothing is written before this.',
  );
  assert.doesNotMatch(manual, /adds one link line/);
  assert.match(createCompanionHint('', false), /^Creates one note in the vault root and adds/);
  assert.match(createCompanionHint('', true), /^Creates one note in the vault root\. /);
});

/* ─────────── The folder picker against the real session and index ─────────── */

const VAULT: Record<string, string> = {
  '10 Work/Budget.md': '# Budget\n\nThe training budget for this year is 40000 dollars.\n',
  '10 Work/Offsite.md': '# Offsite\n\nThe offsite takes place in the mountains in February.\n',
  '20 Other/Recipes.md': '# Recipes\n\nA recipe for bread with flour and water.\n',
  '30 Deep/A/B/Note.md': '# Note\n\nA note three levels down about gardening and tomatoes.\n',
  '30 Deep/A/Other.md': '# Other\n\nA note two levels down about the weather in spring.\n',
};

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function pass(world: FakeWorld, ms: number): Promise<void> {
  await settle();
  for (let left = ms; left > 0; left -= 250) {
    world.clock.advance(250);
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

/**
 * The folder picker as Ask.tsx runs it, through the same helpers: opened over the folders the
 * session publishes, kept while the tab is away, read again at every render against the folders
 * published then, and built by the one button.
 */
function sidebarPicker(session: HamsterSession) {
  const folders = (): string[] => session.store.getState().index.folders;
  let kept: PickerState = openPicker(session.controller.listFolders(), folders());
  /* What a render sees: the picker, or none once the published list is no longer its own. */
  const shown = (): PickerState | null => (pickerOutdated(kept, folders()) ? null : kept);
  const paths = kept.rows.map((row) => row.path);
  return {
    paths,
    open: (): boolean => shown() !== null,
    ticked: () => paths.filter((path) => kept.selected.has(path) || coveredByAncestor(path, kept.selected)),
    click(path: string): void {
      assert.ok(paths.includes(path), `${path} has a row`);
      assert.ok(!coveredByAncestor(path, kept.selected), `${path} is not greyed out`);
      kept = toggleFolder(kept, path);
    },
    chosen: (): string[] => foldersToBuild(shown(), folders()),
    build: () => session.controller.buildIndex(foldersToBuild(shown(), folders())),
  };
}

async function indexedVault(folders: string[]): Promise<{ world: FakeWorld; session: HamsterSession }> {
  const world = makeWorld({ daily: '### Sync\n- a\n', files: VAULT, index: true, settings: { indexedFolders: folders } });
  const session = createSession(world.deps);
  await session.init();
  await pass(world, 2000);
  assert.equal(session.store.getState().index.status, 'ready');
  return { world, session };
}

test('ask: the whole vault typed in the settings has a row, and unticking it takes it out of the build', async () => {
  const { world, session } = await indexedVault(['/']);
  const index = (): VaultIndexStatus => session.store.getState().index;
  assert.deepEqual(index().folders, ['/']);
  /* The five notes above and today's daily. */
  const everything = Object.keys(VAULT).length + 1;
  assert.equal(index().files, everything);

  /* As it opens: the row is there and every folder reads as included. */
  let picker = sidebarPicker(session);
  assert.equal(picker.paths[0], '/');
  assert.deepEqual(picker.ticked(), picker.paths);

  /* Built as it stands: the whole vault, once, and the same list goes to the settings. */
  await until(world, picker.build());
  await pass(world, 2000);
  assert.deepEqual(world.settings().indexedFolders, ['/']);
  assert.deepEqual(index().folders, ['/']);
  assert.equal(index().files, everything);

  /* Unticked, with one folder ticked instead: that folder alone is indexed and saved. */
  picker = sidebarPicker(session);
  picker.click('/');
  assert.deepEqual(picker.ticked(), []);
  picker.click('20 Other');
  await until(world, picker.build());
  await pass(world, 2000);
  assert.deepEqual(world.settings().indexedFolders, ['20 Other']);
  assert.deepEqual(index().folders, ['20 Other']);
  assert.equal(index().files, 1);
  await session.dispose();
});

test('ask: a folder three levels down and a folder that is gone can be unticked too', async () => {
  const { world, session } = await indexedVault(['30 Deep/A/B', '10 Work', 'Old name']);
  const index = (): VaultIndexStatus => session.store.getState().index;
  assert.equal(index().files, 3);

  const picker = sidebarPicker(session);
  assert.deepEqual(picker.paths, ['00 Inbox', '10 Work', '20 Other', '30 Deep', '30 Deep/A', '30 Deep/A/B', 'Old name']);
  assert.deepEqual(picker.ticked(), ['10 Work', '30 Deep/A/B', 'Old name']);
  picker.click('30 Deep/A/B');
  picker.click('Old name');
  await until(world, picker.build());
  await pass(world, 2000);
  assert.deepEqual(world.settings().indexedFolders, ['10 Work']);
  assert.deepEqual(index().folders, ['10 Work']);
  assert.equal(index().files, 2);
  await session.dispose();
});

test('ask: a picker left open closes when the list changes in the settings, and Rebuild applies the settings', async () => {
  const { world, session } = await indexedVault(['20 Other']);
  const index = (): VaultIndexStatus => session.store.getState().index;
  assert.equal(index().files, 1);

  /* The picker is opened to add a folder. The one wanted, three levels down, has no row: the
     host lists two levels. A folder is ticked meanwhile, and the picker is left open. */
  const picker = sidebarPicker(session);
  assert.ok(!picker.paths.includes('30 Deep/A/B'));
  picker.click('10 Work');
  assert.equal(picker.open(), true);
  assert.deepEqual(picker.chosen(), ['10 Work', '20 Other']);

  /* The index reporting again, and the same list saved again, publish the same folders: the
     picker stays open, with its ticks. */
  world.setSettings({ indexedFolders: ['20 Other'] });
  session.handleSettingsChange();
  await pass(world, 500);
  assert.equal(picker.open(), true);
  assert.deepEqual(picker.chosen(), ['10 Work', '20 Other']);

  /* So the folder is typed in Settings, Indexed folders. */
  world.setSettings({ indexedFolders: ['20 Other', '30 Deep/A/B'] });
  session.handleSettingsChange();
  await settle();
  assert.deepEqual(index().folders, ['20 Other', '30 Deep/A/B']);
  assert.equal(indexFoldersNote(index()), INDEX_FOLDERS_PENDING_TEXT);

  /* Back in the sidebar: the picker is closed, and the button under "Rebuild the index to apply"
     builds the list of the settings, not the ticks of the list that was replaced. */
  assert.equal(picker.open(), false);
  assert.deepEqual(picker.chosen(), ['20 Other', '30 Deep/A/B']);
  assert.equal(indexBuildBlocked(picker.chosen()), null);
  await until(world, picker.build());
  await pass(world, 2000);
  assert.deepEqual(world.settings().indexedFolders, ['20 Other', '30 Deep/A/B']);
  assert.deepEqual(index().folders, ['20 Other', '30 Deep/A/B']);
  assert.equal(index().files, 2);
  assert.equal(indexFoldersNote(index()), null);

  /* Opened again, it starts from the new list, the deep folder with a row of its own. */
  const again = sidebarPicker(session);
  assert.ok(again.paths.includes('30 Deep/A/B'));
  assert.deepEqual(again.ticked(), ['20 Other', '30 Deep/A/B']);
  assert.equal(again.open(), true);
  await session.dispose();
});

test('the first-write confirmation says which note gets the line, and what one-file mode adds', () => {
  const daily = confirmWriteText({ companionPath: 'A/Mtg.md', linkLine: '↳ [[Mtg|Meeting notes]]', where: 'end of the section' });
  assert.match(daily.intro, /one line to your daily note/);
  const note = confirmWriteText({ companionPath: 'A/Mtg.md', linkLine: '↳ [[Mtg|Meeting notes]]', where: 'end of the note', lineNote: 'Budget review' });
  assert.match(note.intro, /one line to “Budget review”/);
  assert.equal(note.rows[1].label, 'Line added to your note');
  const into = confirmWriteText({ companionPath: '10 Work/Budget review.md', linkLine: '', where: 'Below your text', intoNote: true });
  assert.equal(into.title, 'Write the meeting into this note?');
  assert.equal(into.button, 'Write into it');
  assert.doesNotMatch(into.intro, /create one note/);
});
