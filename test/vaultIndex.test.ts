import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize } from '../src/rag/embed.ts';
import { VECTORS_HEADER_BYTES, VECTORS_MAGIC, VaultIndex } from '../src/rag/vaultIndex.ts';
import type { VaultIndexDeps } from '../src/rag/vaultIndex.ts';
import { VectorStore } from '../src/rag/vectorStore.ts';
import type { Clock, Embedder, VaultChunk, VaultIndexIO, VaultIndexStatus } from '../src/types.ts';
import { hash53, shortHash } from '../src/util/hash.ts';

const DIM = 256;
const MODEL = 'embeddinggemma-2:270m@256';

/** Hashed bag of words: texts that share words score higher. */
function vectorOf(text: string, dim = DIM): Float32Array {
  const v = new Float32Array(dim);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) v[hash53(word) % dim] += 1;
  return normalize(v);
}

interface Doc {
  title?: string;
  text: string;
}

function fakeEmbedder(dim = DIM) {
  const calls: Doc[][] = [];
  const queries: string[] = [];
  const hooks: {
    /** Runs at the start of every document request; may throw or wait. */
    before: ((docs: Doc[], call: number) => void | Promise<void>) | null;
  } = { before: null };

  const embedder: Embedder = {
    dim,
    async embedQuery(text) {
      queries.push(text);
      return vectorOf(text, dim);
    },
    async embedDocuments(docs, signal) {
      calls.push(docs);
      await hooks.before?.(docs, calls.length);
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { kind: 'aborted' });
      return docs.map((d) => vectorOf(d.text, dim));
    },
  };
  return {
    embedder,
    calls,
    queries,
    hooks,
    texts: (): string[] => calls.flat().map((d) => d.text),
    reset(): void {
      calls.length = 0;
      queries.length = 0;
    },
  };
}

function memoryVault(initial: Record<string, string> = {}) {
  const files = new Map<string, { text: string; mtime: number }>();
  let tick = 1_000;
  const log = { reads: [] as string[], lists: [] as string[][], saves: 0, loads: 0 };
  const state: { saved: { index: string; vectors: Uint8Array } | null; failSave: Error | null; failRead: Set<string> } = {
    saved: null,
    failSave: null,
    failRead: new Set(),
  };

  const io: VaultIndexIO = {
    async listMarkdown(folders) {
      log.lists.push(folders);
      const prefixes = folders.map((f) => f.replace(/^\/+|\/+$/g, '')).map((f) => (f ? `${f}/` : ''));
      return [...files.entries()]
        .filter(([path]) => path.endsWith('.md') && prefixes.some((p) => path.startsWith(p)))
        .map(([path, f]) => ({ path, mtime: f.mtime }));
    },
    async read(path) {
      log.reads.push(path);
      const file = files.get(path);
      if (!file || state.failRead.has(path)) throw new Error(`Cannot read ${path}`);
      return file.text;
    },
    async load() {
      log.loads += 1;
      return state.saved;
    },
    async save(index, vectors) {
      if (state.failSave) throw state.failSave;
      log.saves += 1;
      state.saved = { index, vectors: vectors.slice() };
    },
  };

  const vault = {
    io,
    log,
    state,
    write(path: string, text: string): void {
      tick += 1;
      files.set(path, { text, mtime: tick });
    },
    remove(path: string): void {
      files.delete(path);
    },
    rename(from: string, to: string): void {
      const file = files.get(from);
      if (!file) throw new Error(`No ${from}`);
      files.delete(from);
      files.set(to, file);
    },
    /** What a fresh process would read back. */
    persisted(): { model: string; folders: string[]; files: Record<string, { mtime: number; chunkIds: string[] }>; store: VectorStore<VaultChunk> } {
      assert.ok(state.saved, 'an index was saved');
      const parsed = JSON.parse(state.saved.index);
      return {
        model: parsed.model,
        folders: parsed.folders,
        files: parsed.files,
        // The store's own bytes follow the header that pairs the file with index.json.
        store: VectorStore.deserialize<VaultChunk>(JSON.stringify(parsed.store), state.saved.vectors.subarray(VECTORS_HEADER_BYTES)),
      };
    },
  };
  for (const [path, text] of Object.entries(initial)) vault.write(path, text);
  return vault;
}

function manualClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    setInterval() {
      throw new Error('not used');
    },
    clearInterval() {},
  };
  return {
    clock,
    pending: (): number => timers.size,
    advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

/** Lets queued promise work run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/* Synthetic notes in the shape of a PARA vault. Every section is its own chunk. */
const PHOENIX = [
  '---',
  'status: active',
  '---',
  '# Project Phoenix',
  'Phoenix replaces the legacy billing engine with a streaming ledger service.',
  '',
  '## Risks',
  'The vendor contract for the ledger expires before the cutover weekend.',
  '',
  '## Budget',
  'Finance approved four hundred thousand dollars for the migration work.',
].join('\n');

const ATLAS = [
  '# Atlas',
  'Atlas is the internal map of data owners across every business unit.',
  '',
  '## Decisions',
  'Stewards review their catalog entries on the first Monday of each month.',
].join('\n');

const STEERING = [
  'Le comité directeur se réunit chaque trimestre pour arbitrer les priorités.',
  '',
  '## Participants',
  'La directrice des opérations préside et le contrôleur présente les chiffres.',
].join('\n');

const OLD = '# Old plan\nAn archived plan about office furniture and parking spaces from last year.';

function sampleVault() {
  return memoryVault({
    'Projects/Phoenix.md': PHOENIX,
    'Projects/Atlas.md': ATLAS,
    'Areas/Governance/Steering.md': STEERING,
    'Archive/Old plan.md': OLD,
  });
}

function setup(vault = sampleVault(), extra: Partial<VaultIndexDeps> = {}) {
  const fake = fakeEmbedder();
  const timers = manualClock();
  const statuses: VaultIndexStatus[] = [];
  const deps: VaultIndexDeps = {
    io: vault.io,
    embedder: fake.embedder,
    clock: timers.clock,
    modelId: () => MODEL,
    onStatus: (s) => statuses.push(s),
    ...extra,
  };
  return { vault, fake, timers, statuses, deps, index: new VaultIndex(deps) };
}

function savedIds(vault: ReturnType<typeof memoryVault>): string[] {
  return vault
    .persisted()
    .store.entries()
    .map((e) => e.id)
    .sort();
}

test('the first build indexes every note of the chosen folders', async () => {
  const { index, vault, fake, statuses } = setup();
  assert.deepEqual(index.status(), { status: 'none', files: 0, chunks: 0, done: 0, total: 0, folders: [], error: null });

  await index.build(['Projects']);

  assert.deepEqual(index.status(), {
    status: 'ready',
    files: 2,
    chunks: 5,
    done: 2,
    total: 2,
    folders: ['Projects'],
    error: null,
  });
  assert.deepEqual(vault.log.lists, [['Projects']]);
  assert.deepEqual(vault.log.reads, ['Projects/Atlas.md', 'Projects/Phoenix.md'], 'files are taken in path order');
  assert.equal(vault.log.saves, 1, 'saved once, at the end');

  const saved = vault.persisted();
  assert.equal(saved.model, MODEL);
  assert.deepEqual(saved.folders, ['Projects']);
  assert.deepEqual(Object.keys(saved.files).sort(), ['Projects/Atlas.md', 'Projects/Phoenix.md']);
  assert.deepEqual(saved.files['Projects/Phoenix.md'].chunkIds, [
    'Projects/Phoenix.md#0',
    'Projects/Phoenix.md#1',
    'Projects/Phoenix.md#2',
  ]);

  const risks = saved.store.get('Projects/Phoenix.md#1');
  assert.ok(risks);
  const text = 'The vendor contract for the ledger expires before the cutover weekend.';
  assert.deepEqual(risks.meta, {
    id: 'Projects/Phoenix.md#1',
    path: 'Projects/Phoenix.md',
    title: 'Phoenix',
    heading: 'Project Phoenix › Risks',
    text,
    hash: shortHash(text),
  });
  assert.deepEqual([...risks.vector], [...vectorOf(text)]);

  const seen = statuses.map((s) => `${s.status} ${s.done}/${s.total}`);
  assert.equal(seen[0], 'building 0/0');
  assert.ok(seen.includes('building 0/2'));
  assert.ok(seen.includes('building 1/2'));
  assert.equal(seen[seen.length - 1], 'ready 2/2');
  assert.ok(!fake.texts().some((t) => t.includes('status: active')), 'frontmatter is not embedded');
});

test('chunks are embedded under the note name and heading path', async () => {
  const { index, fake } = setup();
  await index.build(['Projects', 'Areas']);
  const titles = new Map(fake.calls.flat().map((d) => [d.text.slice(0, 12), d.title]));

  assert.equal(titles.get('Phoenix repl'), 'Phoenix › Project Phoenix');
  assert.equal(titles.get('The vendor c'), 'Phoenix › Project Phoenix › Risks');
  assert.equal(titles.get('Atlas is the'), 'Atlas', 'a heading that repeats the note name is not said twice');
  assert.equal(titles.get('Stewards rev'), 'Atlas › Decisions');
  assert.equal(titles.get('Le comité di'), 'Steering', 'text before the first heading has the note name only');
  assert.equal(titles.get('La directric'), 'Steering › Participants');
});

test('a second build with one changed file embeds only the changed chunks', async () => {
  const { index, vault, fake } = setup();
  await index.build(['Projects']);
  assert.equal(fake.texts().length, 5);
  fake.reset();
  vault.log.reads.length = 0;

  const changed = 'Finance approved five hundred thousand dollars after the scope review.';
  vault.write('Projects/Phoenix.md', PHOENIX.replace(/Finance approved.*$/, changed));
  await index.build(['Projects']);

  assert.deepEqual(vault.log.reads, ['Projects/Phoenix.md'], 'the unchanged note is not even read');
  assert.deepEqual(fake.calls, [[{ title: 'Phoenix › Project Phoenix › Budget', text: changed }]]);
  assert.equal(index.status().chunks, 5);
  const saved = vault.persisted();
  assert.equal(saved.store.get('Projects/Phoenix.md#2')?.meta.text, changed);
  assert.deepEqual([...(saved.store.get('Projects/Phoenix.md#2')?.vector ?? [])], [...vectorOf(changed)]);
  assert.deepEqual(
    [...(saved.store.get('Projects/Phoenix.md#1')?.vector ?? [])],
    [...vectorOf('The vendor contract for the ledger expires before the cutover weekend.')],
    'the kept chunk still has its vector',
  );

  fake.reset();
  vault.log.reads.length = 0;
  const saves = vault.log.saves;
  await index.build(['Projects']);
  assert.deepEqual(vault.log.reads, [], 'nothing changed: nothing is read');
  assert.equal(fake.calls.length, 0);
  assert.equal(vault.log.saves, saves, 'and nothing is saved');
  assert.equal(index.status().status, 'ready');
});

test('a touched file with the same content is read but not embedded again', async () => {
  const { index, vault, fake } = setup();
  await index.build(['Projects']);
  fake.reset();
  vault.write('Projects/Atlas.md', ATLAS);
  await index.build(['Projects']);
  assert.equal(fake.calls.length, 0);

  vault.log.reads.length = 0;
  await index.build(['Projects']);
  assert.deepEqual(vault.log.reads, [], 'the new mtime was recorded');
});

test('chunks keep their vectors when a section is inserted above them', async () => {
  const { index, vault, fake } = setup();
  await index.build(['Projects']);
  fake.reset();

  const added = 'A new scope section explains which invoices move first.';
  vault.write('Projects/Phoenix.md', PHOENIX.replace('## Risks', `## Scope\n${added}\n\n## Risks`));
  await index.build(['Projects']);

  assert.deepEqual(fake.texts(), [added], 'only the new chunk is embedded, though the ids of the others shifted');
  const saved = vault.persisted();
  assert.deepEqual(
    saved.files['Projects/Phoenix.md'].chunkIds.map((id) => saved.store.get(id)?.meta.heading),
    ['Project Phoenix', 'Project Phoenix › Scope', 'Project Phoenix › Risks', 'Project Phoenix › Budget'],
  );
  assert.equal(index.status().chunks, 6);
});

test('a deleted file is removed by the next build', async () => {
  const { index, vault, fake } = setup();
  await index.build(['Projects']);
  fake.reset();
  vault.remove('Projects/Atlas.md');
  await index.build(['Projects']);

  assert.equal(index.status().files, 1);
  assert.equal(index.status().chunks, 3);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(savedIds(vault), ['Projects/Phoenix.md#0', 'Projects/Phoenix.md#1', 'Projects/Phoenix.md#2']);
  const hits = await index.search('data owners business unit', 5, { minScore: -1 });
  assert.equal(hits.length, 3);
  assert.ok(hits.every((c) => c.path === 'Projects/Phoenix.md'));
});

test('folders select what is indexed', async () => {
  const whole = setup();
  await whole.index.build(['']);
  assert.equal(whole.index.status().files, 4, "'' is the whole vault");

  const slash = setup();
  await slash.index.build(['/']);
  assert.equal(slash.index.status().files, 4, "'/' is the whole vault");
  assert.deepEqual(slash.index.status().folders, ['/'], 'folders are reported as given');

  const nested = setup();
  await nested.index.build(['Areas/Governance/', 'Archive']);
  assert.deepEqual(Object.keys(nested.vault.persisted().files).sort(), ['Archive/Old plan.md', 'Areas/Governance/Steering.md']);

  const prefix = setup(memoryVault({ 'Projects/A.md': ATLAS, 'Projects Old/B.md': OLD, 'Projects.md': OLD }));
  await prefix.index.build(['Projects']);
  assert.deepEqual(Object.keys(prefix.vault.persisted().files), ['Projects/A.md'], 'a folder is not a name prefix');
});

test('exclusions, hidden folders and non-Markdown files are left out', async () => {
  const vault = memoryVault({
    'Projects/Phoenix.md': PHOENIX,
    'Projects/Private/Salary.md': OLD,
    'Projects/.trash/Gone.md': OLD,
    '.obsidian/notes.md': OLD,
    'Projects/diagram.canvas': 'not markdown',
  });
  // A careless host that lists more than it was asked for.
  const listMarkdown = vault.io.listMarkdown.bind(vault.io);
  vault.io.listMarkdown = async (folders) => [
    ...(await listMarkdown(folders)),
    { path: 'Projects/diagram.canvas', mtime: 1 },
    { path: 'Elsewhere/Stray.md', mtime: 1 },
  ];
  const { index } = setup(vault, { exclude: (path) => path.includes('/Private/') });
  await index.build(['Projects']);
  assert.deepEqual(Object.keys(vault.persisted().files), ['Projects/Phoenix.md']);
  assert.equal(index.status().total, 1);
});

test('narrowing the folders drops what is now outside', async () => {
  const { index, vault, fake } = setup();
  await index.build(['Projects', 'Archive']);
  assert.equal(index.status().files, 3);
  fake.reset();

  await index.build(['Archive']);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(Object.keys(vault.persisted().files), ['Archive/Old plan.md']);
  assert.deepEqual(vault.persisted().folders, ['Archive']);
  assert.deepEqual(index.status().folders, ['Archive']);
  assert.equal(index.status().chunks, 1);
});

test('an empty folder list indexes nothing and the status stays none', async () => {
  const { index, vault, fake, statuses } = setup();
  await index.build([]);
  assert.equal(index.status().status, 'none');
  assert.deepEqual(vault.log.lists, [], 'the vault is not even listed');
  assert.equal(vault.log.saves, 0);
  assert.equal(fake.calls.length, 0);
  assert.ok(statuses.every((s) => s.status === 'none'));
  assert.deepEqual(await index.search('ledger', 5), []);
});

test('an empty folder list clears an existing index, on disk too', async () => {
  const { index, vault } = setup();
  await index.build(['Projects']);
  await index.build([]);
  assert.deepEqual(index.status(), { status: 'none', files: 0, chunks: 0, done: 0, total: 0, folders: [], error: null });
  assert.equal(vault.persisted().store.size, 0);
  assert.deepEqual(vault.persisted().folders, []);

  const again = setup(vault);
  await again.index.load();
  assert.equal(again.index.status().status, 'none');
});

test('search returns the best chunks with their scores', async () => {
  const { index, fake } = setup();
  await index.build(['']);
  fake.reset();

  const hits = await index.search('when does the vendor contract for the ledger expire', 3);
  assert.equal(hits[0].id, 'Projects/Phoenix.md#1');
  assert.equal(hits[0].title, 'Phoenix');
  assert.equal(hits[0].heading, 'Project Phoenix › Risks');
  assert.ok(hits[0].score > 0.5);
  assert.ok(hits.length <= 3);
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
  assert.deepEqual(fake.queries, ['when does the vendor contract for the ledger expire']);
  assert.equal(fake.calls.length, 0, 'a search embeds no document');

  const french = await index.search('qui préside le comité directeur', 2);
  assert.equal(french[0].path, 'Areas/Governance/Steering.md');
});

test('search honours minScore, its default, k and excludePaths', async () => {
  const { index } = setup();
  await index.build(['']);
  const query = 'vendor contract ledger cutover';

  assert.deepEqual(await index.search('zebra umbrella xylophone', 5), [], 'nothing reaches the default floor of 0.25');
  assert.equal((await index.search('zebra umbrella xylophone', 50, { minScore: -1 })).length, 8, 'every chunk without a floor');
  assert.equal((await index.search(query, 1)).length, 1);
  assert.deepEqual(await index.search(query, 0), []);
  assert.deepEqual(await index.search(query, 5, { minScore: 0.999 }), []);

  const open = await index.search(query, 8, { minScore: 0 });
  assert.equal(open[0].path, 'Projects/Phoenix.md');
  const filtered = await index.search(query, 8, { minScore: 0, excludePaths: ['Projects/Phoenix.md'] });
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((c) => c.path !== 'Projects/Phoenix.md'));
  assert.equal(filtered.length, open.length - open.filter((c) => c.path === 'Projects/Phoenix.md').length);
});

test('search can be kept to some of the indexed folders, without losing hits to the others', async () => {
  const { index } = setup();
  await index.build(['']);
  const query = 'vendor contract ledger cutover';
  const open = await index.search(query, 8, { minScore: 0 });
  assert.ok(open.some((c) => c.path.startsWith('Projects/')) && open.some((c) => !c.path.startsWith('Projects/')));

  const areas = await index.search(query, 8, { minScore: 0, folders: ['Areas'] });
  assert.ok(areas.length > 0);
  assert.ok(areas.every((c) => c.path.startsWith('Areas/')));
  assert.equal(areas.length, open.filter((c) => c.path.startsWith('Areas/')).length);
  // As many hits as asked for when the folder has them: the others do not take their places.
  const one = await index.search(query, 1, { minScore: 0, folders: ['/Areas/'] });
  assert.equal(one.length, 1);
  assert.ok(one[0].path.startsWith('Areas/'));

  // The whole vault, and a folder whose name another one starts with.
  assert.equal((await index.search(query, 8, { minScore: 0, folders: ['/'] })).length, open.length);
  assert.deepEqual(await index.search(query, 8, { minScore: 0, folders: ['Area'] }), []);
  assert.deepEqual(await index.search(query, 8, { minScore: 0, folders: [] }), []);
});

test('a search on an empty index does not call the embedder', async () => {
  const { index, fake } = setup();
  assert.deepEqual(await index.search('ledger', 5), []);
  await index.load();
  assert.deepEqual(await index.search('ledger', 5), []);
  await index.build(['Nowhere']);
  assert.equal(index.status().status, 'ready');
  assert.equal(index.status().files, 0);
  assert.deepEqual(await index.search('ledger', 5), []);
  await index.build(['Projects']);
  assert.deepEqual(await index.search('   ', 5), []);
  assert.equal(fake.queries.length, 0);
});

test('a persisted index reloads without embedding anything', async () => {
  const vault = sampleVault();
  const first = setup(vault);
  await first.index.build(['Projects']);
  const expected = await first.index.search('budget approved by finance', 3);

  const second = setup(vault);
  await second.index.load();
  assert.deepEqual(second.index.status(), {
    status: 'ready',
    files: 2,
    chunks: 5,
    done: 2,
    total: 2,
    folders: ['Projects'],
    error: null,
  });
  assert.deepEqual(await second.index.search('budget approved by finance', 3), expected);
  assert.equal(second.fake.calls.length, 0);

  vault.log.reads.length = 0;
  await second.index.build(['Projects']);
  assert.deepEqual(vault.log.reads, [], 'mtimes survived the reload');
  assert.equal(second.fake.calls.length, 0);
});

test('load reads vectors that do not start on a 4-byte boundary', async () => {
  const vault = sampleVault();
  await setup(vault).index.build(['Projects']);
  assert.ok(vault.state.saved);
  const bytes = vault.state.saved.vectors;
  const padded = new Uint8Array(bytes.byteLength + 3);
  padded.set(bytes, 3);
  vault.state.saved = { index: vault.state.saved.index, vectors: padded.subarray(3) };

  const { index } = setup(vault);
  await index.load();
  assert.equal(index.status().status, 'ready');
  assert.equal((await index.search('vendor contract ledger', 1))[0].id, 'Projects/Phoenix.md#1');
});

test('with no saved index, load leaves the status at none', async () => {
  const { index, statuses } = setup();
  await index.load();
  assert.equal(index.status().status, 'none');
  assert.equal(statuses[statuses.length - 1].status, 'none');
});

test('a change of embedding model invalidates the stored index', async () => {
  const vault = sampleVault();
  await setup(vault).index.build(['Projects']);

  let model = 'another-embedder@256';
  const { index, fake } = setup(vault, { modelId: () => model });
  await index.load();
  assert.deepEqual(index.status(), { status: 'none', files: 0, chunks: 0, done: 0, total: 0, folders: [], error: null });
  assert.deepEqual(await index.search('vendor contract ledger', 3), []);
  assert.equal(fake.queries.length, 0);

  await index.build(['Projects']);
  assert.equal(fake.texts().length, 5, 'everything is embedded again');
  assert.equal(vault.persisted().model, 'another-embedder@256');

  // The model changes while the index is in memory: old vectors are not searched or mixed in.
  fake.reset();
  model = 'third-embedder@256';
  assert.deepEqual(await index.search('vendor contract ledger', 3), []);
  vault.write('Projects/Atlas.md', `${ATLAS}\n\nAn extra paragraph that would need an embedding.`);
  await index.updateFile('Projects/Atlas.md');
  assert.equal(fake.calls.length, 0, 'no update into an index of another model');
  await index.build(['Projects']);
  assert.equal(fake.texts().length, 5, 'the next build starts over');
  assert.ok(fake.texts().some((t) => t.endsWith('An extra paragraph that would need an embedding.')));
  assert.equal((await index.search('vendor contract ledger', 1)).length, 1);
});

test('the status says when the index in memory was built with another model or dimension, until the next build', async () => {
  let model = MODEL;
  const { index, fake, statuses } = setup(sampleVault(), { modelId: () => model });
  await index.build(['Projects']);
  assert.equal(index.status().modelPending, undefined);
  assert.ok(statuses.every((s) => !('modelPending' in s)), 'absent, not false');

  model = 'another-embedder@256';
  assert.equal(index.status().modelPending, true);
  assert.equal(index.status().status, 'ready', 'the counts shown are those of the old index');
  assert.equal(index.status().chunks, 5);
  assert.deepEqual(await index.search('vendor contract ledger', 3), [], 'which answers nothing');

  await index.build(['Projects']);
  assert.equal(index.status().modelPending, undefined);
  assert.equal(statuses[statuses.length - 1].modelPending, undefined);
  assert.equal(fake.texts().length, 10, 'everything was embedded again');
  assert.equal((await index.search('vendor contract ledger', 1)).length, 1);

  // The same model asked for another dimension is another space too.
  (fake.embedder as { dim: number }).dim = 128;
  assert.equal(index.status().modelPending, true);
});

test('a corrupt stored index is ignored', async () => {
  const vault = sampleVault();
  await setup(vault).index.build(['Projects']);
  assert.ok(vault.state.saved);
  const good = vault.state.saved;

  const broken: Array<{ index: string; vectors: Uint8Array }> = [
    { index: good.index, vectors: good.vectors.subarray(0, good.vectors.byteLength - 4) },
    { index: '{"v":1,', vectors: good.vectors },
    { index: 'null', vectors: good.vectors },
    { index: good.index.replace('"v":2', '"v":3'), vectors: good.vectors },
    { index: good.index.replace('"saveId":"', '"saveId":"0'), vectors: good.vectors },
    { index: good.index, vectors: good.vectors.subarray(VECTORS_HEADER_BYTES) },
    { index: good.index.replace('Projects/Atlas.md#1', 'Projects/Atlas.md#9'), vectors: good.vectors },
    { index: good.index.replace('"folders":["Projects"]', '"folders":"Projects"'), vectors: good.vectors },
  ];
  for (const saved of broken) {
    vault.state.saved = saved;
    const { index, statuses } = setup(vault);
    await index.load();
    assert.equal(index.status().status, 'none');
    assert.equal(index.status().chunks, 0);
    assert.equal(statuses[statuses.length - 1].error, null);
    assert.deepEqual(await index.search('vendor contract ledger', 3), []);
  }

  vault.state.saved = good;
  vault.io.load = async () => {
    throw new Error('disk error');
  };
  const { index } = setup(vault);
  await index.load();
  assert.equal(index.status().status, 'none');
});

test('index.json and vectors.bin are read together only when they come from the same save', async () => {
  const vault = sampleVault();
  const first = setup(vault);
  await first.index.build(['Projects']);
  assert.ok(vault.state.saved);
  const a = vault.state.saved;
  // The chunks of Atlas move to the end of the vector order; their number does not change.
  vault.rename('Projects/Atlas.md', 'Projects/Atlas map.md');
  await first.index.renameFile('Projects/Atlas.md', 'Projects/Atlas map.md');
  await first.index.dispose();
  assert.ok(vault.state.saved);
  const b = vault.state.saved;
  assert.notEqual(b, a);
  assert.equal(b.vectors.byteLength, a.vectors.byteLength, 'the lengths alone cannot tell the two saves apart');

  // What the files carry: a header in front of the vectors, with the id of the head.
  assert.equal(String.fromCharCode(...a.vectors.subarray(0, 4)), VECTORS_MAGIC);
  const idOf = (saved: { index: string }): string => JSON.parse(saved.index).saveId;
  assert.match(idOf(a), /^[0-9a-f]{16}$/);
  assert.notEqual(idOf(a), idOf(b));
  assert.equal([...a.vectors.subarray(8, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join(''), idOf(a));

  // A save writes vectors.bin, then index.json: a quit or a crash between the two leaves this pair.
  vault.state.saved = { index: a.index, vectors: b.vectors };
  const mixed = setup(vault);
  await mixed.index.load();
  assert.equal(mixed.index.status().status, 'none');
  assert.equal(mixed.index.status().chunks, 0);
  assert.equal(mixed.statuses[mixed.statuses.length - 1].error, null, 'rebuilt, not complained about');
  assert.deepEqual(await mixed.index.search('map of data owners', 3), []);

  for (const pair of [a, b]) {
    vault.state.saved = pair;
    const whole = setup(vault);
    await whole.index.load();
    assert.equal(whole.index.status().status, 'ready');
    assert.equal(whole.index.status().chunks, 5);
  }
  assert.equal(vault.persisted().store.get('Projects/Atlas map.md#0')?.meta.title, 'Atlas map');

  // The index of 0.1.4: one version earlier, no save id, and the vectors as they are.
  const old = JSON.parse(a.index);
  delete old.saveId;
  old.v = 1;
  vault.state.saved = { index: JSON.stringify(old), vectors: a.vectors.subarray(VECTORS_HEADER_BYTES) };
  const upgraded = setup(vault);
  await upgraded.index.load();
  assert.equal(upgraded.index.status().status, 'none');
  assert.equal(upgraded.statuses[upgraded.statuses.length - 1].error, null);
});

test('the save id is the one given, and a save with an unusable one is not written', async () => {
  const ids = ['0123456789abcdef', 'not sixteen hex characters'];
  const { index, vault, statuses } = setup(sampleVault(), { saveId: () => ids.shift() ?? '' });
  await index.build(['Projects']);
  assert.ok(vault.state.saved);
  assert.equal(JSON.parse(vault.state.saved.index).saveId, '0123456789abcdef');
  assert.deepEqual([...vault.state.saved.vectors.subarray(8, 16)], [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);

  vault.write('Projects/Atlas.md', `${ATLAS}\n\nA paragraph that makes the index dirty.`);
  await index.updateFile('Projects/Atlas.md');
  await index.dispose();
  assert.equal(vault.log.saves, 1, 'the second save was refused before anything was written');
  assert.match(statuses[statuses.length - 1].error ?? '', /^Could not save the index: Invalid save id/);
});

test('renameFile re-keys the chunks without embedding', async () => {
  const { index, vault, fake } = setup();
  await index.build(['Projects']);
  const before = vault.persisted().store.get('Projects/Phoenix.md#1');
  assert.ok(before);
  fake.reset();
  vault.log.reads.length = 0;

  vault.rename('Projects/Phoenix.md', 'Projects/Billing/Ledger rewrite.md');
  await index.renameFile('Projects/Phoenix.md', 'Projects/Billing/Ledger rewrite.md');

  assert.equal(fake.calls.length, 0);
  assert.deepEqual(vault.log.reads, [], 'the file is not read either');
  assert.equal(index.status().files, 2);
  assert.equal(index.status().chunks, 5);

  const hits = await index.search('vendor contract ledger cutover', 1);
  assert.equal(hits[0].id, 'Projects/Billing/Ledger rewrite.md#1');
  assert.equal(hits[0].path, 'Projects/Billing/Ledger rewrite.md');
  assert.equal(hits[0].title, 'Ledger rewrite');
  assert.equal(hits[0].heading, 'Project Phoenix › Risks');

  await index.dispose();
  const saved = vault.persisted();
  assert.deepEqual(Object.keys(saved.files).sort(), ['Projects/Atlas.md', 'Projects/Billing/Ledger rewrite.md']);
  assert.deepEqual(
    [...(saved.store.get('Projects/Billing/Ledger rewrite.md#1')?.vector ?? [])],
    [...before.vector],
    'the vector moved with the chunk',
  );
  assert.ok(!saved.store.has('Projects/Phoenix.md#1'));
});

test('the build after a rename has nothing to embed', async () => {
  const { index, vault, fake } = setup();
  await index.build(['Projects']);
  vault.rename('Projects/Atlas.md', 'Projects/Atlas map.md');
  await index.renameFile('Projects/Atlas.md', 'Projects/Atlas map.md');
  fake.reset();
  vault.log.reads.length = 0;
  await index.build(['Projects']);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(vault.log.reads, [], 'the stored mtime moved with the file');
});

test('a rename out of the indexed folders removes, a rename into them indexes', async () => {
  const { index, vault, fake } = setup();
  await index.build(['Projects']);
  fake.reset();

  vault.rename('Projects/Atlas.md', 'Archive/Atlas.md');
  await index.renameFile('Projects/Atlas.md', 'Archive/Atlas.md');
  assert.equal(index.status().files, 1);
  assert.equal(fake.calls.length, 0);

  vault.rename('Archive/Old plan.md', 'Projects/Old plan.md');
  await index.renameFile('Archive/Old plan.md', 'Projects/Old plan.md');
  assert.equal(index.status().files, 2);
  assert.deepEqual(fake.texts(), ['An archived plan about office furniture and parking spaces from last year.']);
  assert.equal((await index.search('office furniture parking', 1))[0].path, 'Projects/Old plan.md');

  fake.reset();
  await index.renameFile('Archive/A.md', 'Archive/B.md');
  await index.renameFile('Projects/Phoenix.md', 'Projects/Phoenix.md');
  assert.equal(fake.calls.length, 0);
  assert.equal(index.status().files, 2);
});

test('updateFile embeds only the chunks that changed', async () => {
  const { index, vault, fake } = setup();
  await index.build(['Projects']);
  fake.reset();

  const changed = 'The vendor agreed to extend the ledger contract by six months.';
  vault.write('Projects/Phoenix.md', PHOENIX.replace(/The vendor contract.*$/m, changed));
  await index.updateFile('Projects/Phoenix.md');

  assert.deepEqual(fake.texts(), [changed]);
  assert.equal(index.status().chunks, 5);
  assert.equal(index.status().status, 'ready');
  assert.equal((await index.search('extend the ledger contract six months', 1))[0].text, changed);

  vault.write('Projects/New note.md', '# New note\nA brand new note about the quarterly planning offsite.');
  await index.updateFile('Projects/New note.md');
  assert.equal(index.status().files, 3);
  assert.equal(index.status().chunks, 6);
});

test('updateFile, removeFile and renameFile do nothing outside the index', async () => {
  const { index, vault, fake } = setup();
  await index.updateFile('Projects/Phoenix.md');
  await index.removeFile('Projects/Phoenix.md');
  await index.renameFile('Projects/Phoenix.md', 'Projects/Other.md');
  assert.equal(vault.log.reads.length, 0, 'before any index exists');
  assert.equal(index.status().status, 'none');

  await index.build(['Projects']);
  fake.reset();
  vault.log.reads.length = 0;
  await index.updateFile('Archive/Old plan.md');
  await index.updateFile('Projects/diagram.canvas');
  await index.removeFile('Archive/Old plan.md');
  await index.renameFile('Archive/Old plan.md', 'Archive/Older plan.md');
  assert.equal(vault.log.reads.length, 0, 'outside the indexed folders');
  assert.equal(fake.calls.length, 0);
  assert.equal(index.status().files, 2);
  assert.equal(index.status().error, null);
});

test('removeFile drops the chunks of a file', async () => {
  const { index, vault } = setup();
  await index.build(['Projects']);
  await index.removeFile('Projects/Phoenix.md');
  assert.equal(index.status().files, 1);
  assert.equal(index.status().chunks, 2);
  const hits = await index.search('vendor contract ledger', 5, { minScore: -1 });
  assert.ok(hits.every((c) => c.path === 'Projects/Atlas.md'));
  await index.dispose();
  assert.deepEqual(Object.keys(vault.persisted().files), ['Projects/Atlas.md']);
});

test('an updateFile that fails keeps the old chunks and reports the error', async () => {
  const { index, vault } = setup();
  await index.build(['Projects']);
  vault.state.failRead.add('Projects/Atlas.md');
  await index.updateFile('Projects/Atlas.md');
  assert.equal(index.status().status, 'ready');
  assert.equal(index.status().chunks, 5);
  assert.match(index.status().error ?? '', /^Projects\/Atlas\.md: Cannot read/);
});

test('incremental changes are saved after saveEveryMs, once', async () => {
  const { index, vault, timers } = setup(sampleVault(), { saveEveryMs: 30_000 });
  await index.build(['Projects']);
  assert.equal(vault.log.saves, 1);
  assert.equal(timers.pending(), 0);

  vault.write('Projects/Atlas.md', `${ATLAS}\n\nA new closing paragraph about ownership reviews.`);
  await index.updateFile('Projects/Atlas.md');
  await index.removeFile('Projects/Phoenix.md');
  assert.equal(vault.log.saves, 1, 'not saved on every change');
  assert.equal(timers.pending(), 1, 'one timer for both changes');

  timers.advance(29_000);
  await settle();
  assert.equal(vault.log.saves, 1);
  timers.advance(1_000);
  await settle();
  assert.equal(vault.log.saves, 2);
  assert.deepEqual(Object.keys(vault.persisted().files), ['Projects/Atlas.md']);
  assert.equal(vault.persisted().store.size, 2);
  assert.ok(vault.persisted().store.get('Projects/Atlas.md#1')?.meta.text.endsWith('ownership reviews.'));
  assert.equal(timers.pending(), 0);
});

test('dispose saves what changed, and only then', async () => {
  const { index, vault, timers } = setup();
  await index.build(['Projects']);
  await index.removeFile('Projects/Atlas.md');
  assert.equal(vault.log.saves, 1);
  await index.dispose();
  assert.equal(vault.log.saves, 2);
  assert.equal(timers.pending(), 0, 'the pending save timer is cancelled');
  assert.deepEqual(Object.keys(vault.persisted().files), ['Projects/Phoenix.md']);

  await index.dispose();
  assert.equal(vault.log.saves, 2);
  await index.updateFile('Projects/Phoenix.md');
  await index.build(['Projects']);
  assert.equal(vault.log.saves, 2, 'a disposed index does nothing');

  const clean = setup();
  await clean.index.build(['Projects']);
  await clean.index.dispose();
  assert.equal(clean.vault.log.saves, 1, 'nothing changed since the build saved');
});

test('a long build saves every saveEveryMs', async () => {
  const vault = memoryVault();
  for (let i = 0; i < 6; i++) vault.write(`Notes/Note ${i}.md`, `# Note ${i}\nThe body of note number ${i} is long enough to index.`);
  const { index, fake, timers } = setup(vault, { saveEveryMs: 30_000 });
  // Each file takes 20 seconds to embed.
  fake.hooks.before = () => timers.advance(20_000);
  const savedAt: number[] = [];
  const save = vault.io.save.bind(vault.io);
  vault.io.save = async (i, v) => {
    savedAt.push(index.status().done);
    await save(i, v);
  };
  await index.build(['Notes']);
  assert.deepEqual(savedAt, [2, 4, 6], 'after files 2 and 4, then at the end');
  assert.equal(vault.persisted().store.size, 6);
});

test('a build that starts paused waits for resume', async () => {
  const { index, fake } = setup();
  index.pause();
  const building = index.build(['Projects']);
  await until(() => index.status().status === 'paused', 'the paused status');
  await settle();
  assert.equal(fake.calls.length, 0);
  assert.equal(index.status().total, 2);

  index.resume();
  await building;
  assert.equal(index.status().status, 'ready');
  assert.equal(index.status().files, 2);
});

test('pause takes effect between files and resume continues', async () => {
  const { index, fake, statuses } = setup();
  fake.hooks.before = (_docs, call) => {
    if (call === 1) index.pause();
  };
  const building = index.build(['']);
  await until(() => index.status().status === 'paused', 'the paused status');
  await settle();

  assert.equal(fake.calls.length, 1, 'the file in progress finished, the next did not start');
  assert.equal(index.status().done, 1);
  assert.equal(index.status().total, 4);
  assert.equal(index.status().files, 1);
  assert.equal((await index.search('office furniture parking', 1)).length, 1, 'what is indexed is searchable');

  index.resume();
  await building;
  assert.equal(index.status().status, 'ready');
  assert.equal(index.status().done, 4);
  assert.equal(fake.calls.length, 4);
  const order = statuses.map((s) => s.status).filter((s, i, all) => s !== all[i - 1]);
  assert.deepEqual(order, ['building', 'paused', 'building', 'ready']);
});

test('a paused build resolves when it is cancelled', async () => {
  const { index, vault, fake } = setup();
  const controller = new AbortController();
  fake.hooks.before = (_docs, call) => {
    if (call === 1) index.pause();
  };
  const building = index.build([''], controller.signal);
  await until(() => index.status().status === 'paused', 'the paused status');
  controller.abort();
  await building;

  assert.equal(index.status().status, 'ready');
  assert.equal(index.status().files, 1);
  assert.equal(index.status().done, 1);
  assert.equal(fake.calls.length, 1);
  assert.equal(Object.keys(vault.persisted().files).length, 1);
});

test('file changes reported while paused are indexed on resume', async () => {
  const { index, vault, fake } = setup();
  await index.build(['Projects']);
  fake.reset();
  index.pause();

  const changed = 'The vendor agreed to extend the ledger contract by six months.';
  vault.write('Projects/Phoenix.md', PHOENIX.replace(/The vendor contract.*$/m, changed));
  await index.updateFile('Projects/Phoenix.md');
  await index.updateFile('Projects/Phoenix.md');
  vault.write('Projects/Draft.md', 'A draft that is renamed before the meeting ends, long enough to index.');
  await index.updateFile('Projects/Draft.md');
  vault.rename('Projects/Draft.md', 'Projects/Final.md');
  await index.renameFile('Projects/Draft.md', 'Projects/Final.md');
  vault.write('Projects/Gone.md', 'A note created and deleted during the meeting, long enough to index.');
  await index.updateFile('Projects/Gone.md');
  vault.remove('Projects/Gone.md');
  await index.removeFile('Projects/Gone.md');
  await settle();
  assert.equal(fake.calls.length, 0, 'nothing is embedded during the pause');

  index.resume();
  await settle();
  assert.deepEqual(fake.texts().sort(), ['A draft that is renamed before the meeting ends, long enough to index.', changed].sort());
  assert.equal(index.status().files, 3);
  assert.equal(index.status().error, null);
  assert.equal((await index.search('renamed before the meeting ends', 1))[0].path, 'Projects/Final.md');
});

test('an abort in the middle of a build leaves a consistent, saved index', async () => {
  const { index, vault, fake } = setup();
  const controller = new AbortController();
  fake.hooks.before = (_docs, call) => {
    if (call === 3) controller.abort();
  };
  await index.build([''], controller.signal);

  // Path order: Archive/Old plan, Areas/Governance/Steering, Projects/Atlas (aborted), Projects/Phoenix.
  assert.equal(index.status().status, 'ready');
  assert.equal(index.status().files, 2);
  assert.equal(index.status().done, 2);
  assert.equal(index.status().total, 4);
  assert.equal(index.status().error, null);
  assert.equal(fake.calls.length, 3);

  const saved = vault.persisted();
  assert.deepEqual(Object.keys(saved.files).sort(), ['Archive/Old plan.md', 'Areas/Governance/Steering.md']);
  const listed = Object.values(saved.files).flatMap((f) => f.chunkIds);
  assert.deepEqual(listed.sort(), saved.store.entries().map((e) => e.id).sort(), 'files and chunks agree');
  assert.equal(saved.store.size, index.status().chunks);

  const reloaded = setup(vault);
  await reloaded.index.load();
  assert.equal(reloaded.index.status().status, 'ready');
  assert.equal(reloaded.index.status().files, 2);

  // The next build picks up where this one stopped.
  fake.reset();
  await index.build(['']);
  assert.equal(index.status().files, 4);
  assert.equal(index.status().done, 4);
  assert.deepEqual(fake.calls.map((c) => c[0].title?.split(' › ')[0]), ['Atlas', 'Phoenix']);
});

test('a build whose signal is already aborted indexes nothing', async () => {
  const { index, vault, fake } = setup();
  const controller = new AbortController();
  controller.abort();
  await index.build(['Projects'], controller.signal);
  assert.equal(index.status().status, 'none');
  assert.equal(index.status().total, 2);
  assert.equal(fake.calls.length, 0);
  assert.equal(vault.log.reads.length, 0);
});

test('a global embedder error stops the build with status error', async () => {
  for (const kind of ['unreachable', 'model_missing']) {
    const { index, vault, fake } = setup();
    fake.hooks.before = (_docs, call) => {
      if (call === 2) throw Object.assign(new Error(`Ollama problem: ${kind}`), { kind });
    };
    await index.build(['']);

    assert.equal(index.status().status, 'error');
    assert.equal(index.status().error, `Ollama problem: ${kind}`);
    assert.equal(fake.calls.length, 2, 'the remaining files were not attempted');
    assert.equal(index.status().files, 1);
    assert.equal(index.status().done, 1);
    assert.equal(Object.keys(vault.persisted().files).length, 1, 'what was indexed is saved');
    assert.equal((await index.search('office furniture parking', 1)).length, 1, 'and stays searchable');

    fake.hooks.before = null;
    await index.build(['']);
    assert.equal(index.status().status, 'ready');
    assert.equal(index.status().error, null);
    assert.equal(index.status().files, 4);
  }
});

test('an error on one file is recorded and the build continues', async () => {
  const { index, vault, fake } = setup();
  vault.state.failRead.add('Areas/Governance/Steering.md');
  fake.hooks.before = (docs) => {
    if (docs[0].text.startsWith('Atlas')) throw new Error('500 from the embedder');
  };
  await index.build(['']);

  assert.equal(index.status().status, 'ready');
  assert.equal(index.status().files, 2);
  assert.equal(index.status().done, 4);
  assert.equal(index.status().error, 'Projects/Atlas.md: 500 from the embedder', 'the last error');
  assert.deepEqual(Object.keys(vault.persisted().files).sort(), ['Archive/Old plan.md', 'Projects/Phoenix.md']);

  vault.state.failRead.clear();
  fake.hooks.before = null;
  fake.reset();
  await index.build(['']);
  assert.equal(index.status().files, 4, 'the failed files are tried again');
  assert.equal(index.status().error, null);
  assert.equal(fake.calls.length, 2);
});

test('a listing failure ends the build with status error', async () => {
  const { index, vault } = setup();
  vault.io.listMarkdown = async () => {
    throw new Error('vault not ready');
  };
  await index.build(['Projects']);
  assert.equal(index.status().status, 'error');
  assert.equal(index.status().error, 'vault not ready');
});

test('a save failure is reported and retried by the next save', async () => {
  const { index, vault } = setup();
  vault.state.failSave = new Error('disk full');
  await index.build(['Projects']);
  assert.equal(index.status().status, 'ready');
  assert.equal(index.status().error, 'Could not save the index: disk full');
  assert.equal(vault.state.saved, null);

  vault.state.failSave = null;
  await index.dispose();
  assert.equal(Object.keys(vault.persisted().files).length, 2);
});

test('a second build call while one runs returns the same promise', async () => {
  const { index, fake } = setup();
  const first = index.build(['Projects']);
  const second = index.build(['Archive']);
  assert.equal(second, first);
  await first;
  assert.deepEqual(index.status().folders, ['Projects'], 'the second call was not a new build');
  assert.equal(fake.texts().length, 5);

  const third = index.build(['Archive']);
  assert.notEqual(third, first, 'a finished build does not linger');
  await third;
  assert.deepEqual(index.status().folders, ['Archive']);
});

test('an update reported during a build runs after it', async () => {
  const { index, vault, fake } = setup();
  let updating: Promise<void> | null = null;
  const changed = 'Stewards now review their catalog entries every second Friday.';
  fake.hooks.before = (_docs, call) => {
    // Atlas is indexed first; it changes while Phoenix is being embedded.
    if (call !== 2) return;
    vault.write('Projects/Atlas.md', ATLAS.replace(/Stewards review.*$/, changed));
    updating = index.updateFile('Projects/Atlas.md');
  };
  await index.build(['Projects']);
  assert.ok(updating);
  await updating;
  assert.deepEqual(fake.calls[2], [{ title: 'Atlas › Decisions', text: changed }]);
  assert.equal((await index.search('catalog entries every second Friday', 1))[0].text, changed);
});

test('dispose stops a running build and saves what it had', async () => {
  const { index, vault, fake } = setup();
  let disposing: Promise<void> | null = null;
  fake.hooks.before = (_docs, call) => {
    if (call === 2) disposing = index.dispose();
  };
  await index.build(['']);
  assert.ok(disposing);
  await disposing;
  assert.equal(fake.calls.length, 2);
  assert.equal(Object.keys(vault.persisted().files).length, 1);
});

test('a status listener that throws does not break the build', async () => {
  const { index } = setup(sampleVault(), {
    onStatus: () => {
      throw new Error('listener bug');
    },
  });
  await index.build(['Projects']);
  assert.equal(index.status().status, 'ready');
  assert.equal(index.status().files, 2);
});

test('status() hands out copies', async () => {
  const { index } = setup();
  await index.build(['Projects']);
  const status = index.status();
  status.folders.push('Hacked');
  status.files = 99;
  assert.deepEqual(index.status().folders, ['Projects']);
  assert.equal(index.status().files, 2);
});

/** Every stored vector is the one this file's embedder gives for the chunk's text. */
function assertOwnVectors(store: VectorStore<VaultChunk>): void {
  for (const { id, meta } of store.entries()) {
    assert.deepEqual([...(store.get(id)?.vector ?? [])], [...vectorOf(meta.text)], `vector of ${id}`);
  }
}

test('vectors of the wrong length leave the file as it was', async () => {
  const { index, vault, fake } = setup();
  await index.build(['Projects']);
  const changed = 'Finance approved five hundred thousand dollars after the scope review.';
  vault.write('Projects/Phoenix.md', PHOENIX.replace(/Finance approved.*$/, changed));
  const embedDocuments = fake.embedder.embedDocuments.bind(fake.embedder);
  fake.embedder.embedDocuments = async (docs) => docs.map(() => new Float32Array(DIM / 2).fill(1));
  await index.build(['Projects']);

  assert.equal(index.status().status, 'ready');
  assert.match(index.status().error ?? '', /^Projects\/Phoenix\.md: .*expected 256, got 128/);
  assert.equal(index.status().chunks, 5, 'no chunk of the file was lost half way');
  const [old] = await index.search('finance approved four hundred thousand dollars', 1);
  assert.equal(old.id, 'Projects/Phoenix.md#2', 'the previous text is still what is indexed');

  // Whatever is saved next has to pass its own integrity check on the way back in.
  await index.removeFile('Projects/Atlas.md');
  await index.dispose();
  const saved = vault.persisted();
  assert.deepEqual(
    Object.values(saved.files).flatMap((f) => f.chunkIds).sort(),
    saved.store.entries().map((e) => e.id).sort(),
    'files and chunks agree',
  );
  const reloaded = setup(vault);
  await reloaded.index.load();
  assert.equal(reloaded.index.status().status, 'ready');
  assert.equal(reloaded.index.status().chunks, 3);

  fake.embedder.embedDocuments = embedDocuments;
  await reloaded.index.build(['Projects']);
  assert.equal((await reloaded.index.search('five hundred thousand after the scope review', 1))[0].text, changed);
});

test('a change of embedding model during a build stops it and mixes nothing in', async () => {
  let model = MODEL;
  const { index, vault, fake } = setup(sampleVault(), { modelId: () => model });
  const embedDocuments = fake.embedder.embedDocuments.bind(fake.embedder);
  // The other model answers with unrelated vectors of the same size.
  fake.embedder.embedDocuments = async (docs, signal) => {
    const vectors = await embedDocuments(docs, signal);
    return model === MODEL ? vectors : vectors.map((v) => v.map((x) => -x));
  };
  fake.hooks.before = (_docs, call) => {
    if (call === 2) model = 'other-embedder@256';
  };
  await index.build(['']);

  assert.equal(index.status().status, 'error');
  assert.match(index.status().error ?? '', /model changed/);
  assert.equal(fake.calls.length, 2, 'the remaining files were not embedded with the other model');
  assert.equal(index.status().files, 1, 'the file embedded across the change was not stored');
  assert.deepEqual(await index.search('office furniture parking', 3), [], 'not searchable under the other model');

  // The setting goes back before anything was rebuilt: the index must hold the first model's vectors only.
  model = MODEL;
  fake.hooks.before = null;
  assert.equal((await index.search('office furniture parking', 1)).length, 1);
  assertOwnVectors(vault.persisted().store);
  await index.build(['']);
  assert.equal(index.status().status, 'ready');
  assert.equal(index.status().error, null);
  assert.equal(index.status().files, 4);
  assertOwnVectors(vault.persisted().store);
});

test('a model change during the last file still ends the build with status error', async () => {
  let model = MODEL;
  const { index, fake } = setup(sampleVault(), { modelId: () => model });
  fake.hooks.before = (_docs, call) => {
    if (call === 4) model = 'other-embedder@256';
  };
  await index.build(['']);
  assert.equal(index.status().status, 'error');
  assert.match(index.status().error ?? '', /model changed/);
  assert.equal(index.status().files, 3);
  assert.equal(index.status().done, 3);
});

test('a model change while a build is paused stops it before the next request', async () => {
  let model = MODEL;
  const { index, vault, fake } = setup(sampleVault(), { modelId: () => model });
  fake.hooks.before = (_docs, call) => {
    if (call === 1) index.pause();
  };
  const building = index.build(['']);
  await until(() => index.status().status === 'paused', 'the paused status');
  model = 'other-embedder@256';
  index.resume();
  await building;

  assert.equal(index.status().status, 'error');
  assert.match(index.status().error ?? '', /model changed/);
  assert.equal(fake.calls.length, 1, 'nothing was sent to the other model');
  assert.deepEqual(vault.log.reads, ['Archive/Old plan.md'], 'the next file was not even read');
  assert.equal(Object.keys(vault.persisted().files).length, 1, 'what was indexed is saved');
});

test('a change of embedding model during updateFile stores nothing', async () => {
  let model = MODEL;
  const { index, vault, fake } = setup(sampleVault(), { modelId: () => model });
  await index.build(['Projects']);
  const changed = 'Stewards now review their catalog entries every second Friday.';
  vault.write('Projects/Atlas.md', ATLAS.replace(/Stewards review.*$/, changed));
  fake.hooks.before = () => {
    model = 'other-embedder@256';
  };
  await index.updateFile('Projects/Atlas.md');
  assert.match(index.status().error ?? '', /^Projects\/Atlas\.md: .*model changed/);

  model = MODEL;
  const [hit] = await index.search('stewards review catalog entries first monday', 1);
  assert.equal(hit.text, 'Stewards review their catalog entries on the first Monday of each month.');
  assert.equal(index.status().chunks, 5);
});

test('a folder is matched as a path, not as a name prefix, whatever the host lists', async () => {
  const vault = memoryVault({ 'Projects/A.md': ATLAS, 'Projects Old/B.md': OLD, 'Projects.md': OLD });
  // A host that matches folders by name prefix.
  vault.io.listMarkdown = async () => [
    { path: 'Projects/A.md', mtime: 1 },
    { path: 'Projects Old/B.md', mtime: 1 },
    { path: 'Projects.md', mtime: 1 },
  ];
  const { index, fake } = setup(vault);
  await index.build(['Projects']);
  assert.deepEqual(Object.keys(vault.persisted().files), ['Projects/A.md']);

  fake.reset();
  vault.log.reads.length = 0;
  await index.updateFile('Projects Old/B.md');
  await index.updateFile('Projects.md');
  assert.deepEqual(vault.log.reads, []);
  assert.equal(index.status().files, 1);

  await index.renameFile('Projects/A.md', 'Projects Old/A.md');
  assert.equal(index.status().files, 0, 'moved out of the folder');
  assert.equal(fake.calls.length, 0);
});

test('the first periodic save comes saveEveryMs into the build, whatever the clock reads', async () => {
  const vault = memoryVault();
  for (let i = 0; i < 3; i++) vault.write(`Notes/Note ${i}.md`, `# Note ${i}\nThe body of note number ${i} is long enough to index.`);
  const { index, fake, timers } = setup(vault, { saveEveryMs: 30_000 });
  // A wall clock, not one that starts at zero.
  timers.advance(1_760_000_000_000);
  fake.hooks.before = () => timers.advance(20_000);
  const savedAt: number[] = [];
  const save = vault.io.save.bind(vault.io);
  vault.io.save = async (i, v) => {
    savedAt.push(index.status().done);
    await save(i, v);
  };
  await index.build(['Notes']);
  assert.deepEqual(savedAt, [2, 3], '40 seconds in, then at the end');
});

test('a stored index of another vector size is ignored, and a size change in memory forces a rebuild', async () => {
  const vault = sampleVault();
  await setup(vault).index.build(['Projects']);

  // Same model id, smaller vectors.
  const small = fakeEmbedder(64);
  const other = setup(vault, { embedder: small.embedder });
  await other.index.load();
  assert.equal(other.index.status().status, 'none');
  assert.equal(other.index.status().chunks, 0);

  const { index, fake } = setup(vault);
  await index.load();
  assert.equal(index.status().status, 'ready');
  let queries = 0;
  Object.assign(fake.embedder, {
    dim: 64,
    embedQuery: async (text: string) => {
      queries += 1;
      return vectorOf(text, 64);
    },
    embedDocuments: async (docs: Doc[]) => docs.map((d) => vectorOf(d.text, 64)),
  });
  assert.deepEqual(await index.search('vendor contract ledger', 3), []);
  assert.equal(queries, 0, 'the old vectors are not even queried');
  vault.log.reads.length = 0;
  await index.updateFile('Projects/Atlas.md');
  assert.deepEqual(vault.log.reads, [], 'and nothing is added to them');

  await index.build(['Projects']);
  assert.equal(index.status().status, 'ready');
  assert.equal(index.status().error, null);
  assert.equal(index.status().chunks, 5);
  assert.equal(vault.persisted().store.dim, 64);
  assert.equal((await index.search('vendor contract ledger', 1))[0].id, 'Projects/Phoenix.md#1');
});

test('a stored index with orphan chunks or files without folders is ignored', async () => {
  const vault = sampleVault();
  await setup(vault).index.build(['Projects']);
  assert.ok(vault.state.saved);
  const good = vault.state.saved;
  const parsed = JSON.parse(good.index);

  const orphan = structuredClone(parsed);
  orphan.store.ids.push('Projects/Ghost.md#0');
  orphan.store.metas.push({ id: 'Projects/Ghost.md#0', path: 'Projects/Ghost.md', title: 'Ghost', heading: '', text: 'x', hash: 'x' });
  const longer = new Uint8Array(good.vectors.byteLength + DIM * 4);
  longer.set(good.vectors);
  const textless = structuredClone(parsed);
  delete textless.store.metas[0].text;

  const broken: Array<{ index: string; vectors: Uint8Array }> = [
    { index: JSON.stringify(orphan), vectors: longer },
    { index: JSON.stringify({ ...parsed, folders: [] }), vectors: good.vectors },
    { index: JSON.stringify({ ...parsed, files: { ...parsed.files, 'Projects/Atlas.md': { ...parsed.files['Projects/Atlas.md'], mtime: '7' } } }), vectors: good.vectors },
    { index: JSON.stringify(textless), vectors: good.vectors },
  ];
  for (const saved of broken) {
    vault.state.saved = saved;
    const { index } = setup(vault);
    await index.load();
    assert.equal(index.status().status, 'none');
    assert.equal(index.status().chunks, 0);
    assert.equal(index.status().files, 0);
  }
});

test('a rename onto an indexed note replaces that note', async () => {
  const { index, vault, fake } = setup();
  await index.build(['Projects']);
  fake.reset();
  vault.rename('Projects/Atlas.md', 'Projects/Phoenix.md');
  await index.renameFile('Projects/Atlas.md', 'Projects/Phoenix.md');

  assert.equal(fake.calls.length, 0);
  assert.equal(index.status().files, 1);
  assert.equal(index.status().chunks, 2, 'the three chunks of the overwritten note are gone');
  const hits = await index.search('vendor contract ledger stewards catalog', 8, { minScore: -1 });
  assert.deepEqual(hits.map((h) => h.id).sort(), ['Projects/Phoenix.md#0', 'Projects/Phoenix.md#1']);
  assert.ok(hits.every((h) => h.title === 'Phoenix' && ATLAS.includes(h.text)));

  await index.dispose();
  const reloaded = setup(vault);
  await reloaded.index.load();
  assert.equal(reloaded.index.status().status, 'ready');
  assert.equal(reloaded.index.status().chunks, 2);
});

test('a chunk whose heading changed is embedded again, under its new title', async () => {
  const { index, vault, fake } = setup();
  await index.build(['Projects']);
  fake.reset();
  vault.write('Projects/Phoenix.md', PHOENIX.replace('## Risks', '## Open risks'));
  await index.build(['Projects']);
  assert.deepEqual(fake.calls, [
    [
      {
        title: 'Phoenix › Project Phoenix › Open risks',
        text: 'The vendor contract for the ledger expires before the cutover weekend.',
      },
    ],
  ]);
});

test('a search that was waiting while the index was rebuilt for another model returns nothing', async () => {
  let model = MODEL;
  const { index, fake } = setup(sampleVault(), { modelId: () => model });
  await index.build(['Projects']);

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const embedQuery = fake.embedder.embedQuery.bind(fake.embedder);
  fake.embedder.embedQuery = async (text, signal) => {
    await gate;
    return embedQuery(text, signal);
  };
  const pending = index.search('vendor contract ledger', 3);
  model = 'other-embedder@256';
  await index.build(['Projects']);
  assert.equal(index.status().chunks, 5, 'the new index is complete');

  release();
  assert.deepEqual(await pending, [], 'a vector of the old model is not compared with the new ones');
});

test('a change still queued when dispose is called is saved and leaves no timer behind', async () => {
  const { index, vault, timers } = setup();
  await index.build(['Projects']);
  const removing = index.removeFile('Projects/Atlas.md');
  const disposing = index.dispose();
  await Promise.all([removing, disposing]);

  assert.equal(timers.pending(), 0, 'no save timer outlives dispose');
  assert.deepEqual(Object.keys(vault.persisted().files), ['Projects/Phoenix.md']);
  timers.advance(120_000);
  await settle();
  assert.equal(vault.log.saves, 2, 'and nothing is written later');
});

test('a new folder list is saved even when no note moved in or out', async () => {
  const { index, vault, fake } = setup();
  await index.build(['Projects']);
  fake.reset();
  await index.build(['Projects', 'Nowhere']);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(vault.persisted().folders, ['Projects', 'Nowhere']);

  const reloaded = setup(vault);
  await reloaded.index.load();
  assert.deepEqual(reloaded.index.status().folders, ['Projects', 'Nowhere']);
});

/* The error in the status: said while it is true, taken back when it no longer is. */

test('an error about a note is taken back when that note is indexed after all', async () => {
  const { index, vault, statuses } = setup();
  await index.build(['Projects']);
  vault.state.failRead.add('Projects/Atlas.md');
  await index.updateFile('Projects/Atlas.md');
  assert.match(index.status().error ?? '', /^Projects\/Atlas\.md: Cannot read/);

  // Another note that is indexed says nothing about this one.
  vault.write('Projects/Phoenix.md', `${PHOENIX}\n\nA closing line about the cutover rehearsal.`);
  await index.updateFile('Projects/Phoenix.md');
  assert.match(index.status().error ?? '', /^Projects\/Atlas\.md: Cannot read/);

  // The note can be read again (it was being synced, say), and its next change is indexed.
  vault.state.failRead.clear();
  vault.write('Projects/Atlas.md', `${ATLAS}\n\nA new closing paragraph about ownership reviews.`);
  await index.updateFile('Projects/Atlas.md');
  assert.equal(index.status().error, null);
  assert.equal(index.status().status, 'ready');
  assert.equal(statuses[statuses.length - 1].error, null, 'and the listener is told');
  assert.ok((await index.search('ownership reviews closing paragraph', 1))[0].text.endsWith('ownership reviews.'));
});

test('an error a build left about one note is taken back by that note alone', async () => {
  const { index, vault, fake } = setup();
  vault.state.failRead.add('Projects/Atlas.md');
  await index.build(['Projects']);
  assert.equal(index.status().status, 'ready');
  assert.equal(index.status().files, 1);
  assert.equal(index.status().error, 'Projects/Atlas.md: Cannot read Projects/Atlas.md');

  vault.state.failRead.clear();
  fake.reset();
  await index.updateFile('Projects/Phoenix.md');
  assert.equal(index.status().error, 'Projects/Atlas.md: Cannot read Projects/Atlas.md');
  await index.updateFile('Projects/Atlas.md');
  assert.equal(index.status().error, null);
  assert.equal(index.status().files, 2);

  // It fails again later: said again.
  vault.state.failRead.add('Projects/Atlas.md');
  await index.updateFile('Projects/Atlas.md');
  assert.equal(index.status().error, 'Projects/Atlas.md: Cannot read Projects/Atlas.md');
});

test('an error about a note goes with the note when it is deleted or renamed', async () => {
  const deleted = setup();
  await deleted.index.build(['Projects']);
  deleted.vault.write('Projects/Draft.md', '# Draft\nA draft about the quarterly planning offsite agenda.');
  deleted.vault.state.failRead.add('Projects/Draft.md');
  await deleted.index.updateFile('Projects/Draft.md');
  assert.equal(deleted.index.status().error, 'Projects/Draft.md: Cannot read Projects/Draft.md');
  // Never indexed, so there is nothing to drop: the error is all that was left of it.
  deleted.vault.remove('Projects/Draft.md');
  await deleted.index.removeFile('Projects/Atlas.md');
  assert.equal(deleted.index.status().error, 'Projects/Draft.md: Cannot read Projects/Draft.md', 'not for another note');
  await deleted.index.removeFile('Projects/Draft.md');
  assert.equal(deleted.index.status().error, null);

  // Renamed: the change that could not be indexed is tried again under the new name.
  const renamed = setup();
  await renamed.index.build(['Projects']);
  renamed.vault.write('Projects/Atlas.md', `${ATLAS}\n\nA new closing paragraph about ownership reviews.`);
  renamed.vault.state.failRead.add('Projects/Atlas.md');
  await renamed.index.updateFile('Projects/Atlas.md');
  assert.match(renamed.index.status().error ?? '', /^Projects\/Atlas\.md: /);
  renamed.vault.rename('Projects/Atlas.md', 'Projects/Atlas 2026.md');
  renamed.fake.reset();
  await renamed.index.renameFile('Projects/Atlas.md', 'Projects/Atlas 2026.md');
  assert.equal(renamed.index.status().error, null);
  assert.equal(renamed.index.status().files, 2);
  assert.deepEqual(renamed.fake.texts(), [
    'Stewards review their catalog entries on the first Monday of each month.\n\nA new closing paragraph about ownership reviews.',
  ]);
  assert.equal((await renamed.index.search('ownership reviews closing paragraph', 1))[0].path, 'Projects/Atlas 2026.md');

  // A note that still cannot be indexed under its new name is complained about under that name,
  // whether the index holds an older version of it or nothing.
  for (const known of [true, false]) {
    const still = setup();
    await still.index.build(['Projects']);
    const from = known ? 'Projects/Atlas.md' : 'Projects/Draft.md';
    if (!known) still.vault.write(from, '# Draft\nA draft about the quarterly planning offsite agenda.');
    still.vault.state.failRead.add(from);
    await still.index.updateFile(from);
    assert.equal(still.index.status().error, `${from}: Cannot read ${from}`);
    still.vault.rename(from, 'Projects/Agenda.md');
    still.vault.state.failRead.add('Projects/Agenda.md');
    await still.index.renameFile(from, 'Projects/Agenda.md');
    assert.equal(still.index.status().error, 'Projects/Agenda.md: Cannot read Projects/Agenda.md');
    assert.equal(still.index.status().files, 2);
    assert.equal(still.vault.log.reads.filter((path) => path === 'Projects/Agenda.md').length, 1);
  }

  // Moved out of the indexed folders: nothing is left to index, and nothing to complain about.
  const out = setup();
  await out.index.build(['Projects']);
  out.vault.state.failRead.add('Projects/Atlas.md');
  await out.index.updateFile('Projects/Atlas.md');
  out.vault.rename('Projects/Atlas.md', 'Archive/Atlas.md');
  await out.index.renameFile('Projects/Atlas.md', 'Archive/Atlas.md');
  assert.equal(out.index.status().error, null);
  assert.equal(out.index.status().files, 1);

  // A note moved onto the one that was complained about replaces it, and the complaint.
  const onto = setup();
  await onto.index.build(['Projects']);
  onto.vault.state.failRead.add('Projects/Atlas.md');
  await onto.index.updateFile('Projects/Atlas.md');
  onto.vault.state.failRead.clear();
  onto.vault.rename('Projects/Phoenix.md', 'Projects/Atlas.md');
  onto.fake.reset();
  await onto.index.renameFile('Projects/Phoenix.md', 'Projects/Atlas.md');
  assert.equal(onto.index.status().error, null);
  assert.equal(onto.index.status().files, 1);
  assert.equal(onto.fake.calls.length, 0, 'a plain rename still embeds nothing');
});

test('the error of a failed save is taken back by the save that goes through', async () => {
  const { index, vault, timers, statuses } = setup(sampleVault(), { saveEveryMs: 30_000 });
  await index.build(['Projects']);
  assert.equal(index.status().error, null);

  vault.state.failSave = new Error('disk full');
  await index.removeFile('Projects/Atlas.md');
  timers.advance(30_000);
  await settle();
  assert.equal(index.status().error, 'Could not save the index: disk full');
  assert.equal(vault.log.saves, 1);

  // Room was made. The next change is saved, with what the failed save had not written.
  vault.state.failSave = null;
  vault.write('Projects/Phoenix.md', `${PHOENIX}\n\nA closing line about the cutover rehearsal.`);
  await index.updateFile('Projects/Phoenix.md');
  assert.equal(index.status().error, 'Could not save the index: disk full', 'not before it is saved');
  timers.advance(30_000);
  await settle();
  assert.equal(vault.log.saves, 2);
  assert.equal(index.status().error, null);
  assert.equal(statuses[statuses.length - 1].error, null);
  assert.deepEqual(Object.keys(vault.persisted().files), ['Projects/Phoenix.md']);
});

test('a save that failed during a build and went through at its end leaves no error', async () => {
  const vault = memoryVault();
  for (let i = 0; i < 4; i++) vault.write(`Notes/Note ${i}.md`, `# Note ${i}\nThe body of note number ${i} is long enough to index.`);
  const { index, fake, timers } = setup(vault, { saveEveryMs: 30_000 });
  // Each file takes 20 seconds to embed: a save is due after the second.
  fake.hooks.before = () => timers.advance(20_000);
  const seen: Array<string | null> = [];
  const save = vault.io.save.bind(vault.io);
  let attempts = 0;
  vault.io.save = async (i, v) => {
    attempts += 1;
    if (attempts === 1) throw new Error('disk busy');
    seen.push(index.status().error);
    await save(i, v);
  };
  await index.build(['Notes']);
  assert.ok(attempts >= 2);
  assert.equal(seen[0], 'Could not save the index: disk busy', 'it was said while it was true');
  assert.equal(index.status().status, 'ready');
  assert.equal(index.status().error, null);
  assert.equal(vault.persisted().store.size, 4);
});

test('a save and a note each take back their own error only', async () => {
  // A note failed; the save that follows goes through: the note is still not indexed.
  const note = setup(sampleVault(), { saveEveryMs: 30_000 });
  await note.index.build(['Projects']);
  await note.index.removeFile('Projects/Phoenix.md');
  note.vault.state.failRead.add('Projects/Atlas.md');
  await note.index.updateFile('Projects/Atlas.md');
  note.timers.advance(30_000);
  await settle();
  assert.equal(note.vault.log.saves, 2);
  assert.equal(note.index.status().error, 'Projects/Atlas.md: Cannot read Projects/Atlas.md');

  // The save failed; a note that is indexed afterwards does not make the index any more saved.
  const save = setup(sampleVault(), { saveEveryMs: 30_000 });
  await save.index.build(['Projects']);
  save.vault.state.failSave = new Error('disk full');
  await save.index.removeFile('Projects/Phoenix.md');
  save.timers.advance(30_000);
  await settle();
  assert.equal(save.index.status().error, 'Could not save the index: disk full');
  save.vault.write('Projects/Atlas.md', `${ATLAS}\n\nA new closing paragraph about ownership reviews.`);
  await save.index.updateFile('Projects/Atlas.md');
  assert.equal(save.index.status().error, 'Could not save the index: disk full');

  // Dispose saves what is left, and that is a save like any other.
  save.vault.state.failSave = null;
  await save.index.dispose();
  assert.equal(save.index.status().error, null);
  assert.deepEqual(Object.keys(save.vault.persisted().files), ['Projects/Atlas.md']);
});

test('an error that is about no one note and no save stands until the next build', async () => {
  const { index, vault, fake } = setup();
  fake.hooks.before = (_docs, call) => {
    if (call === 2) throw Object.assign(new Error('Ollama is not reachable.'), { kind: 'unreachable' });
  };
  await index.build(['']);
  assert.equal(index.status().status, 'error');
  assert.equal(index.status().error, 'Ollama is not reachable.');
  assert.equal(index.status().files, 1);

  // A note is indexed and the index saved: neither says that the build would now go through.
  fake.hooks.before = null;
  vault.write('Archive/Old plan.md', `${OLD}\n\nA closing line about the bicycle shed.`);
  await index.updateFile('Archive/Old plan.md');
  await index.updateFile('Projects/Atlas.md');
  assert.equal(index.status().status, 'error');
  assert.equal(index.status().error, 'Ollama is not reachable.');

  await index.build(['']);
  assert.equal(index.status().status, 'ready');
  assert.equal(index.status().error, null);
  assert.equal(index.status().files, 4);

  // A build also starts from a clean slate after an error about a note or a save.
  vault.state.failRead.add('Projects/Atlas.md');
  await index.updateFile('Projects/Atlas.md');
  assert.match(index.status().error ?? '', /^Projects\/Atlas\.md: /);
  vault.state.failRead.clear();
  vault.state.failSave = new Error('disk full');
  await index.removeFile('Projects/Phoenix.md');
  await index.build(['Projects']);
  assert.equal(index.status().error, 'Could not save the index: disk full');
  vault.state.failSave = null;
  await index.build(['Projects']);
  assert.equal(index.status().error, null);
});
