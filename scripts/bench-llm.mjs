import { parseArgs } from 'node:util';

/* Measures the local models Magical Hamster depends on, through Ollama, and
 * checks them against the budgets Live Enhance and retrieval are designed
 * around. Run it before trusting the debounce and the index estimates.
 *
 *   pnpm bench:llm
 *   node scripts/bench-llm.mjs --model gemma4:12b --alt gemma4:12b-mlx
 *
 * It never pulls a model: for a missing one it prints the command and moves
 * on. Every model it loads is unloaded again before it exits.
 */

const USAGE = `Usage: node scripts/bench-llm.mjs [--url http://localhost:11434] [--model gemma4:12b] [--alt gemma4:12b-mlx]
                                  [--embed embeddinggemma-2:270m] [--num-ctx 16384] [--index-tokens 1400000]

  --url            Ollama server
  --model          generation model
  --alt            second generation model to compare ("none" to skip)
  --embed          embedding model
  --num-ctx        context sent with every generation request
  --embed-num-ctx  context sent with every embedding request (default 2048)
  --index-tokens   size of the knowledge index, for the time estimate

Exit code: 0 when every check passed, 1 when a check failed, 2 when nothing could be measured.`;

const ENHANCE_LIMIT_S = 6;
const QUERY_LIMIT_MS = 200;
const DIMENSIONS = 768;
const PROMPT_TOKENS = 1000;
const DOC_TOKENS = 200;
const BATCH = 32;
/* Loaded between the calls of one model, so only the warm-up pays for the load. */
const KEEP_LOADED = '5m';
const REQUEST_TIMEOUT_MS = 600_000;
/* Mixed French and English prose, before a model has told us its own ratio. */
const DEFAULT_CHARS_PER_TOKEN = 3.6;

let args;
try {
  args = parseArgs({
    options: {
      url: { type: 'string', default: 'http://localhost:11434' },
      model: { type: 'string', default: 'gemma4:12b' },
      alt: { type: 'string', default: 'gemma4:12b-mlx' },
      embed: { type: 'string', default: 'embeddinggemma-2:270m' },
      'num-ctx': { type: 'string', default: '16384' },
      'embed-num-ctx': { type: 'string', default: '2048' },
      'index-tokens': { type: 'string', default: '1400000' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }).values;
} catch (error) {
  console.error(`${error.message}\n\n${USAGE}`);
  process.exit(1);
}

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

function positiveInt(name) {
  const value = Number(args[name]);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`--${name} must be a positive whole number, got "${args[name]}".\n\n${USAGE}`);
    process.exit(1);
  }
  return value;
}

const baseUrl = args.url.trim().replace(/\/+$/, '');
const numCtx = positiveInt('num-ctx');
const embedNumCtx = positiveInt('embed-num-ctx');
const indexTokens = positiveInt('index-tokens');

/* Invented meeting content in the two languages the plugin has to handle.
   It only has to have the shape and the token weight of a real meeting. */

const SHORTHAND = [
  'budget T3 - gel embauches, revoir en nov',
  'vendor shortlist -> 2 finalists, demo next wk',
  'migration courriel: pilote 40 usagers, go/no-go le 15',
  'security audit - 3 high findings, owner = infra',
  'tableau de bord KPI, version beta vendredi',
  'training plan: 2 sessions, FR + EN',
  'risque: dépendance fournisseur unique',
  'next steering: move to Thursday',
];

const EXTRA_SHORTHAND = 'accueil des nouveaux - jumelage, début le 3 nov';

const EXCERPTS = [
  "Camille: Pour le budget du troisième trimestre, on confirme que le gel des embauches reste en place jusqu'à nouvel ordre. Les deux postes d'analyste déjà affichés sont maintenus, mais rien de nouveau avant qu'on revoie les chiffres en novembre avec les finances.",
  'Jordan: On the vendor side, we went from six proposals down to two finalists. Both come in next week for a ninety-minute demo, and we agreed to score them on the same grid: integration effort, support model, and total cost over three years.',
  "Camille: Pour la migration du courriel, le pilote va toucher quarante usagers répartis dans trois équipes. On se donne jusqu'au quinze pour décider si on continue; si le taux de billets dépasse cinq pour cent, on arrête et on corrige avant d'élargir.",
  'Priya: The security audit came back with three high-severity findings, all on the legacy file servers. Infrastructure owns the remediation and committed to a plan by the end of the month, with the first server patched in the next maintenance window.',
  "Mathieu: Le tableau de bord des indicateurs avance bien. La version bêta sera disponible vendredi pour le comité, avec les quatre indicateurs de base; les données de satisfaction arriveront dans une deuxième phase parce que le sondage n'est pas terminé.",
  'Jordan: For training, the plan is two sessions, one in French and one in English, about an hour each. We will record both so people who cannot attend can catch up, and the quick reference guide goes out the same day.',
  "Mathieu: Le risque principal qu'on a soulevé, c'est la dépendance à un seul fournisseur pour l'hébergement. Si le contrat n'est pas renouvelé à temps, on n'a pas de solution de rechange; il faut documenter un plan B d'ici la prochaine rencontre.",
  'Priya: Last thing, the next steering meeting conflicts with the quarterly review, so we are moving it to Thursday at the same time. The agenda stays the same and the updated deck is due the day before.',
  "Camille: On a aussi parlé de l'accueil des nouveaux employés. L'idée est de jumeler chaque personne avec un collègue d'expérience pendant le premier mois, en commençant avec la cohorte du trois novembre.",
  'Jordan: Someone asked whether the pilot users keep their old mailbox during the test. The answer is yes, read-only, for thirty days, and then it is archived unless the team lead asks for an extension.',
  "Mathieu: Pour les coûts, l'estimation actuelle est de cent vingt mille dollars sur trois ans, incluant la formation. Ce montant ne comprend pas la migration des archives, qui sera chiffrée séparément le mois prochain.",
  'Priya: We also noted that the help desk needs a heads-up two weeks before go-live, with a short script for the most likely questions, so the call volume on the first day stays manageable.',
];

const ENHANCE_RULES =
  "You turn a meeting participant's shorthand notes into clear, complete bullets, using the transcript excerpts as evidence. " +
  'Write each bullet in the language of its shorthand line: French stays French, English stays English. ' +
  'One bullet per note, in the same order, formatted as "- **Topic:** one or two sentences". ' +
  'Use only facts found in the notes or the excerpts. No preamble and no closing remark.';

const QUERIES = [
  'gel des embauches et budget du troisième trimestre',
  'which vendors are finalists and when is the demo',
  'date de la décision pour le pilote de migration du courriel',
  'who owns the remediation of the security audit findings',
  'quand a lieu la prochaine rencontre du comité directeur',
];

const ACTIONS_SCHEMA = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { owner: { type: 'string' }, task: { type: 'string' } },
        required: ['owner', 'task'],
      },
    },
  },
  required: ['actions'],
};

function stamp(index) {
  const seconds = 75 + index * 140;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/* The nonce comes first so no earlier run can have left a matching prefix in
   Ollama's cache: the first enhance call must pay for the whole prompt. */
function enhanceMessages(nonce, charsPerToken) {
  const system = `Session ${nonce}. ${ENHANCE_RULES}`;
  const head = `Shorthand notes:\n${SHORTHAND.map((line, i) => `${i + 1}. ${line}`).join('\n')}\n\nTranscript excerpts:\n`;
  const tail = `\n\nWrite the bullet for each of the ${SHORTHAND.length} notes, in order.`;
  const excerpts = [];
  const tokens = () => (system.length + head.length + excerpts.join('\n').length + tail.length) / charsPerToken;
  for (let i = 0; tokens() < PROMPT_TOKENS && i < 400; i += 1) {
    excerpts.push(`[E${i + 1} ${stamp(i)}] ${EXCERPTS[i % EXCERPTS.length]}`);
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${head}${excerpts.join('\n')}${tail}` },
  ];
}

/* Only adds text at the very end, the way Live Enhance grows its prompt. */
function appended(messages) {
  const last = messages[messages.length - 1];
  const extra = `\n\nOne more note was just typed; add its bullet after the others:\n${SHORTHAND.length + 1}. ${EXTRA_SHORTHAND}`;
  return [...messages.slice(0, -1), { ...last, content: last.content + extra }];
}

function documents(charsPerToken) {
  const size = Math.round(DOC_TOKENS * charsPerToken);
  const docs = [];
  for (let i = 0; i < BATCH; i += 1) {
    let text = '';
    for (let j = 0; text.length < size; j += 1) text += `${EXCERPTS[(i + j) % EXCERPTS.length]} `;
    const cut = text.slice(0, size);
    const body = cut.slice(0, Math.max(cut.lastIndexOf(' '), 1));
    docs.push(`title: Rencontre de suivi ${i + 1} | text: ${body}`);
  }
  return docs;
}

class Unreachable extends Error {}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error(`no answer from ${path} within ${REQUEST_TIMEOUT_MS / 1000} s`);
    throw new Unreachable(`Ollama is not reachable at ${baseUrl}`);
  }
  if (!res.ok) {
    const text = (await res.text()).trim().slice(0, 300);
    throw new Error(`HTTP ${res.status} from ${path}${text ? `: ${text}` : ''}`);
  }
  return res;
}

async function getJson(path) {
  return (await request('GET', path)).json();
}

/* Ollama stores an untagged name as name:latest. */
function canonical(name) {
  const text = name.trim().toLowerCase();
  return text.lastIndexOf(':') > text.lastIndexOf('/') ? text : `${text}:latest`;
}

const sameModel = (a, b) => canonical(a) === canonical(b);

async function loadedEntry(model) {
  const data = await getJson('/api/ps');
  return (data.models ?? []).find((entry) => sameModel(entry.name ?? entry.model ?? '', model)) ?? null;
}

async function chat(model, messages, { numPredict, temperature = 0.2, format } = {}) {
  const body = {
    model,
    messages,
    stream: true,
    think: false,
    keep_alive: KEEP_LOADED,
    options: { num_ctx: numCtx, temperature, seed: 7, num_predict: numPredict },
  };
  if (format) body.format = format;

  const started = performance.now();
  const res = await request('POST', '/api/chat', body);
  const decoder = new TextDecoder();
  let pending = '';
  let text = '';
  let final = null;
  let firstTokenMs = null;

  const take = (line) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line);
    if (chunk.error) throw new Error(String(chunk.error));
    const delta = chunk.message?.content ?? '';
    if (delta) {
      firstTokenMs ??= performance.now() - started;
      text += delta;
    }
    if (chunk.done) final = chunk;
  };

  for await (const bytes of res.body) {
    pending += decoder.decode(bytes, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop();
    lines.forEach(take);
  }
  take(pending + decoder.decode());
  if (!final) throw new Error('the stream ended without its final chunk');

  const wallMs = performance.now() - started;
  const promptTokens = final.prompt_eval_count ?? 0;
  /* Null when this Ollama does not report it; the prompt count includes the cached part. */
  const cachedTokens = final.prompt_eval_cached_count ?? null;
  const outputTokens = final.eval_count ?? 0;
  const promptS = (final.prompt_eval_duration ?? 0) / 1e9;
  const evalS = (final.eval_duration ?? 0) / 1e9;
  const evaluated = promptTokens - (cachedTokens ?? 0);
  return {
    text,
    wallMs,
    firstTokenMs,
    promptTokens,
    cachedTokens,
    outputTokens,
    prefill: promptS > 0 && evaluated > 0 ? evaluated / promptS : null,
    decode: evalS > 0 && outputTokens > 0 ? outputTokens / evalS : null,
    loadMs: (final.load_duration ?? 0) / 1e6,
    doneReason: final.done_reason ?? '',
  };
}

async function embed(model, input) {
  const started = performance.now();
  const res = await request('POST', '/api/embed', {
    model,
    input,
    truncate: true,
    dimensions: DIMENSIONS,
    keep_alive: KEEP_LOADED,
    options: { num_ctx: embedNumCtx },
  });
  const data = await res.json();
  const wallMs = performance.now() - started;
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== input.length) {
    throw new Error(`expected ${input.length} embeddings, got ${data.embeddings?.length ?? 'none'}`);
  }
  return { vectors: data.embeddings, tokens: data.prompt_eval_count ?? 0, wallMs };
}

async function unload(model, isEmbedding) {
  const viaGenerate = () => request('POST', '/api/generate', { model, keep_alive: 0, stream: false });
  /* Fallback for a server that refuses /api/generate on an embedding model. */
  const viaEmbed = () =>
    request('POST', '/api/embed', { model, input: ['.'], keep_alive: 0, options: { num_ctx: embedNumCtx } });

  try {
    await (await viaGenerate()).text();
  } catch {
    if (isEmbedding) await viaEmbed().then((res) => res.text(), () => {});
  }
  /* The runner goes away a moment after the request returns. */
  for (let i = 0; i < 10; i += 1) {
    try {
      if (!(await loadedEntry(model))) return true;
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

const whole = (n) => Math.round(n).toLocaleString('en-US');
const rate = (n) => (n === null ? '-' : n >= 100 ? whole(n) : n.toFixed(1));
const secs = (ms) => (ms === null ? '-' : `${(ms / 1000).toFixed(2)} s`);
const millis = (ms) => `${Math.round(ms)} ms`;

function duration(seconds) {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

const GEN_COLUMNS = [
  ['step', -18],
  ['prompt', 7],
  ['cached', 7],
  ['output', 7],
  ['prefill tok/s', 14],
  ['decode tok/s', 13],
  ['first token', 12],
  ['wall', 9],
];

function line(cells) {
  return `  ${cells.map((cell, i) => (GEN_COLUMNS[i][1] < 0 ? cell.padEnd(-GEN_COLUMNS[i][1]) : cell.padStart(GEN_COLUMNS[i][1]))).join(' ')}`;
}

function genRow(step, r, note = '') {
  const cells = [
    step,
    whole(r.promptTokens),
    r.cachedTokens === null ? 'n/a' : whole(r.cachedTokens),
    whole(r.outputTokens),
    rate(r.prefill),
    rate(r.decode),
    secs(r.firstTokenMs),
    secs(r.wallMs),
  ];
  console.log(`${line(cells)}${note ? `   ${note}` : ''}`);
}

const fact = (label, value) => console.log(`  ${label.padEnd(18)} ${value}`);

const checks = [];
function check(ok, model, text) {
  checks.push({ ok, model, text });
}

function charsPerToken(chars, tokens, overhead) {
  const ratio = chars / (tokens - overhead);
  return Number.isFinite(ratio) && ratio >= 2 && ratio <= 6 ? ratio : DEFAULT_CHARS_PER_TOKEN;
}

async function benchGeneration(model, nonce) {
  console.log(`\n${model}`);
  console.log(line(GEN_COLUMNS.map(([title]) => title)));

  /* Loads the model, and tells us how this tokenizer weighs the synthetic
     text so the enhance prompt can be sized to about 1,000 tokens. */
  const sample = `Warm-up ${nonce}. ${EXCERPTS[0]} ${EXCERPTS[1]} ${EXCERPTS[2]} ${EXCERPTS[3]}\nReply with the single word OK.`;
  const warm = await chat(model, [{ role: 'user', content: sample }], { numPredict: 1, temperature: 0 });
  genRow('warm-up', warm, `load ${secs(warm.loadMs)}`);
  const ratio = charsPerToken(sample.length, warm.promptTokens, 10);

  const messages = enhanceMessages(nonce, ratio);
  const first = await chat(model, messages, { numPredict: 100 });
  genRow('enhance', first, first.outputTokens < 100 ? `stopped after ${first.outputTokens} tokens` : '');
  check(
    first.wallMs <= ENHANCE_LIMIT_S * 1000,
    model,
    `enhance wall time ${secs(first.wallMs)} for ${whole(first.promptTokens)} prompt and ${first.outputTokens} output tokens (limit ${ENHANCE_LIMIT_S} s)`,
  );

  const second = await chat(model, appended(messages), { numPredict: 100 });
  const reuse =
    second.cachedTokens === null
      ? 'prompt_eval_cached_count not reported'
      : `${Math.round((100 * second.cachedTokens) / Math.max(1, second.promptTokens))}% of the prompt from cache`;
  // Without the cached count there is no telling how much of the prompt was evaluated.
  genRow('enhance + 1 line', second.cachedTokens === null ? { ...second, prefill: null } : second, reuse);

  const json = await chat(
    model,
    [
      {
        role: 'system',
        content: `Extraction ${nonce}. Extract the action items from the meeting excerpts. Keep each task in the language it was said in. Return JSON only.`,
      },
      { role: 'user', content: [EXCERPTS[2], EXCERPTS[3], EXCERPTS[6]].join('\n') },
    ],
    { numPredict: 400, temperature: 0, format: ACTIONS_SCHEMA },
  );
  let parsed = null;
  try {
    parsed = JSON.parse(json.text);
  } catch {
    // Reported below.
  }
  const valid =
    Array.isArray(parsed?.actions) &&
    parsed.actions.every((a) => typeof a?.owner === 'string' && typeof a?.task === 'string');
  const cut = json.doneReason === 'length' ? ' (cut at num_predict)' : '';
  genRow('JSON schema', json, valid ? `parses, ${parsed.actions.length} actions` : `does not match the schema${cut}`);
  check(valid, model, valid ? 'JSON-schema output parses' : `JSON-schema output does not parse${cut}`);

  const entry = await loadedEntry(model);
  const context = entry?.context_length ?? null;
  fact('loaded context', context === null ? 'not listed by /api/ps' : `${context} (asked for ${numCtx})`);
  check(context === numCtx, model, `context_length ${context ?? 'unknown'} (asked for ${numCtx})`);
}

async function benchEmbedding(model) {
  console.log(`\n${model}`);

  const sample = `${EXCERPTS[0]} ${EXCERPTS[1]} ${EXCERPTS[2]} ${EXCERPTS[3]}`;
  const warm = await embed(model, [sample]);
  fact('warm-up', secs(warm.wallMs));
  const ratio = charsPerToken(sample.length, warm.tokens, 2);

  const times = [];
  for (const query of QUERIES) {
    times.push((await embed(model, [`task: search result | query: ${query}`])).wallMs);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  fact('query', `${millis(median)} (median of ${times.length}; ${millis(times[0])} to ${millis(times[times.length - 1])})`);
  check(median <= QUERY_LIMIT_MS, model, `query embed ${millis(median)} (limit ${QUERY_LIMIT_MS} ms)`);

  const docs = documents(ratio);
  const batch = await embed(model, docs);
  const reported = batch.tokens > 0;
  const tokens = reported ? batch.tokens : docs.join('').length / ratio;
  const speed = tokens / (batch.wallMs / 1000);
  fact(
    `batch of ${BATCH}`,
    `${whole(tokens)} tokens${reported ? '' : ' (estimated)'} in ${secs(batch.wallMs)} = ${whole(speed)} tok/s, ${whole(tokens / BATCH)} tokens per document`,
  );

  const length = batch.vectors[0]?.length ?? 0;
  fact('vector length', `${length} (asked for ${DIMENSIONS})`);
  check(length === DIMENSIONS, model, `vector length ${length} with dimensions ${DIMENSIONS}`);

  fact(`index ${whole(indexTokens)}`, `about ${duration(indexTokens / speed)} at this speed`);

  const entry = await loadedEntry(model);
  const context = entry?.context_length ?? null;
  fact('loaded context', context === null ? 'not listed by /api/ps' : `${context} (asked for ${embedNumCtx})`);
  check(context === embedNumCtx, model, `context_length ${context ?? 'unknown'} (asked for ${embedNumCtx})`);
}

console.log('Magical Hamster LLM bench');

let installed;
try {
  const version = await getJson('/api/version').then((v) => v.version, () => null);
  installed = ((await getJson('/api/tags')).models ?? []).map((m) => m.name ?? m.model).filter(Boolean);
  console.log(`  server     ${baseUrl}${version ? ` (Ollama ${version})` : ''}`);
} catch (error) {
  console.error(`\n${error.message}. Start Ollama and run the bench again.`);
  process.exit(2);
}
console.log(`  num_ctx    ${numCtx} for generation, ${embedNumCtx} for embedding`);
console.log(`  installed  ${installed.length ? installed.join(', ') : 'no models'}`);

const wanted = [{ name: args.model.trim(), role: 'generation' }];
const alt = args.alt.trim();
if (alt && alt.toLowerCase() !== 'none' && !sameModel(alt, wanted[0].name)) {
  wanted.push({ name: alt, role: 'generation, optional alternative' });
}
wanted.push({ name: args.embed.trim(), role: 'embedding' });

const runnable = [];
for (const target of wanted) {
  if (installed.some((name) => sameModel(name, target.name))) {
    runnable.push(target);
    continue;
  }
  console.log(`\nMISSING  ${target.name} (${target.role}) is not installed. To install it:`);
  console.log(`    ollama pull ${target.name}`);
}

/* Ctrl-C must not leave a model in memory. */
let current = null;
process.on('SIGINT', () => {
  const stop = current ? unload(current.name, current.role === 'embedding') : Promise.resolve();
  stop.finally(() => process.exit(130));
});

const nonce = Date.now().toString(36);
let measured = 0;
let serverGone = false;

for (const target of runnable) {
  const isEmbedding = target.role === 'embedding';
  current = target;
  try {
    if (isEmbedding) await benchEmbedding(target.name);
    else await benchGeneration(target.name, nonce);
    measured += 1;
  } catch (error) {
    console.log(`  ERROR    ${error.message}`);
    check(false, target.name, `bench stopped: ${error.message}`);
    serverGone = error instanceof Unreachable;
  } finally {
    if (!serverGone) {
      const gone = await unload(target.name, isEmbedding);
      fact('unloaded', gone ? 'yes' : `could not confirm; run: ollama stop ${target.name}`);
    }
    current = null;
  }
  if (serverGone) break;
}

if (checks.length) {
  console.log('\nChecks');
  for (const { ok, model, text } of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${model}: ${text}`);
}

if (measured === 0) {
  console.log('\nNothing could be measured.');
  process.exitCode = 2;
} else if (checks.some((c) => !c.ok)) {
  process.exitCode = 1;
}
