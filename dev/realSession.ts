import { createCallLog, withCallLog } from '../src/llm/callLog.ts';
import { confirmWriteText } from '../src/ui/components/format.ts';
import { createOllamaClient } from '../src/llm/ollama.ts';
import { createSession } from '../src/session/meetingSession.ts';
import { DEFAULT_LOCAL, DEFAULT_SETTINGS } from '../src/settings.ts';
import type {
  Clock,
  FirstWritePreview,
  HamsterController,
  HamsterSession,
  HamsterSettings,
  HamsterStore,
  LocalSettings,
  OllamaClient,
  UiHost,
} from '../src/types.ts';
import { isoDate } from '../src/util/text.ts';
import {
  FakeNotesHost,
  FakeOllama,
  FakeTranscriptSource,
  memoryStatsIO,
  memoryVaultIndexIO,
} from '../test/helpers/fakes.ts';
import { renderMiniMarkdown } from '../src/ui/miniMarkdown.ts';
import { SAMPLE_DAILY } from './sampleDaily.ts';

/* --------------------------------------------------------------------------
 * The REAL session in the browser.
 *
 * Everything the plugin does in Obsidian runs here unchanged: the section
 * parser, the Enhance engine, the summaries, Q&A, retrieval, the write queue,
 * the companion merge. Only the outside is faked:
 *
 *   vault        an in-memory Map; the textarea is today's daily note
 *   microphone   a scripted bilingual conversation on a timer
 *   Ollama       scripted answers by default, the real server with ?llm=real
 *
 * The fake vault reports the plugin's own writes back to the session, as
 * Obsidian does with every change to a note.
 *
 * Query parameters:
 *   ?llm=real                      talk to Ollama instead of the scripted answers
 *   &url=http://localhost:11434    the Ollama address. One that is not this computer shows the
 *                                  sidebar's warning, with the scripted answers too
 *   &model=gemma4:12b              generation model (also the live model)
 *   &embed=embeddinggemma-2:270m   embedding model
 *   &ctx=8192                      context size sent with every call
 *   ?startMs=1500                  the microphone takes that long to start, as the speech model
 *                                  takes to load: time to see the Cancel button, and to use it
 *                                  (at most 60000)
 * ------------------------------------------------------------------------ */

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (handle) => window.clearInterval(handle as number),
};

const ENTITIES = `## Projects (active portfolio)

| canonical | wikilink | aliases | folder | area | active |
|---|---|---|---|---|---|
| Customer Portal Renewal | \`[[CPR]]\` | portal renewal, customer portal | \`10 Work/Projects/CPR.md\` | work | y |

## People

| canonical | wikilink | aliases | role | area | active |
|---|---|---|---|---|---|
| Jane Example | \`[[Jane Example]]\` | Jane | Manager | work | y |
| Sam Rivera | \`[[Sam Rivera]]\` | Sam | Coordinator | work | y |

## Governance bodies

| canonical | wikilink | aliases | cadence | area | active |
|---|---|---|---|---|---|
| Steering Board | \`[[Steering Board]]\` | SB, steering committee | weekly | work | y |
`;

const VAULT: Record<string, string> = {
  '40 Resources/_entities.md': ENTITIES,
  '10 Work/People/Jane Example.md': `---\ntype: person\narea: work\nstatus: active\n---\n\n# Jane Example\n\nManager. Prefers written updates before the 1:1.\n\n## Priorities this quarter\n\n- Budget for Q1: two options on the table, B keeps the current vendor.\n- Backfill for the coordinator role.\n`,
  '10 Work/Projects/CPR.md': `---\ntype: project\narea: work\nstatus: active\n---\n\n# Customer Portal Renewal\n\nKick-off depends on the vendor contract. Target go-live is the end of Q2.\n\n## Risks\n\n- Vendor contract not signed.\n- Single integration engineer.\n`,
  '10 Work/Governance/Steering Board.md': `---\ntype: area\narea: work\nstatus: active\n---\n\n# Steering Board\n\nWeekly. Decides on portfolio priorities and sponsors.\n\n## Decisions\n\n- Cloud landing zone approved in September.\n`,
};

/** What the scripted microphone "hears": seconds from the start, then the sentence. */
const SCRIPT: Array<[number, string]> = [
  [2, "Ok on commence. Pour le budget du premier trimestre, on a deux options sur la table, la A et la B."],
  [9, "L'option B garde le fournisseur actuel mais coûte quarante mille de plus. Jane préfère la B parce que le contrat est déjà négocié."],
  [17, 'So for the hiring, the coordinator backfill, we need the posting out by Friday at the latest.'],
  [24, 'HR said the approval takes about two weeks, so realistically interviews start mid November.'],
  [31, "Le risque principal c'est le contrat du fournisseur qui n'est pas encore signé. Si ça glisse, le kick-off du portail glisse aussi."],
  [39, "Est-ce qu'on peut demander à Alex de préparer un plan B pour l'intégration d'ici mercredi ?"],
  [46, 'Yes, and I will send the capacity plan to Jane before our next one on one.'],
  [53, "Dernier point, la formation sur le nouvel outil de suivi, on vise la semaine du dix-sept."],
];

/** A microphone that plays the script: a partial, then the final, per sentence. */
class ScriptedSource extends FakeTranscriptSource {
  private handles: number[] = [];

  constructor(startMs = 0) {
    super();
    if (startMs > 0) {
      this.startGate = new Promise<void>((resolve) => {
        window.setTimeout(resolve, startMs);
      });
    }
  }

  override async start(): Promise<void> {
    await super.start();
    // Stopped while it was starting (the start was cancelled): nothing to play, no timer to leave running.
    if (this.state() !== 'running') return;
    for (const [at, text] of SCRIPT) {
      const words = text.split(' ');
      this.handles.push(window.setTimeout(() => this.partial(words.slice(0, 4).join(' ')), at * 1000));
      this.handles.push(window.setTimeout(() => this.partial(words.slice(0, 9).join(' ')), at * 1000 + 900));
      this.handles.push(window.setTimeout(() => this.say(text, at, at + 5), at * 1000 + 1800));
    }
    this.handles.push(
      window.setInterval(() => {
        this.micLevel = 0.15 + Math.random() * 0.6;
      }, 300),
    );
  }

  override stop(): Promise<void> {
    for (const h of this.handles) {
      window.clearTimeout(h);
      window.clearInterval(h);
    }
    this.handles = [];
    this.micLevel = 0;
    return super.stop();
  }
}

/** The first-write confirmation, as a small page dialog (a native confirm() would block automation). */
function confirmInPage(preview: FirstWritePreview): Promise<boolean> {
  return new Promise((resolve) => {
    const veil = document.createElement('div');
    veil.id = 'confirm-write';
    veil.style.cssText =
      'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText =
      'background:var(--background-primary);color:var(--text-normal);border:1px solid var(--background-modifier-border);border-radius:10px;padding:18px 20px;max-width:560px;font-size:14px';
    const text = confirmWriteText(preview);
    const title = document.createElement('h3');
    title.textContent = text.title;
    const body = document.createElement('p');
    body.textContent = text.intro;
    const detail = document.createElement('pre');
    detail.style.cssText = 'white-space:pre-wrap;font-size:12px;margin:8px 0';
    detail.textContent = text.rows.map((row) => `${row.label}: ${row.value}`).join('\n');
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const finish = (answer: boolean) => {
      veil.remove();
      resolve(answer);
    };
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => finish(false));
    const ok = document.createElement('button');
    ok.textContent = text.button;
    ok.dataset.action = 'confirm-create';
    ok.addEventListener('click', () => finish(true));
    row.append(cancel, ok);
    box.append(title, body, detail, row);
    veil.append(box);
    document.body.append(veil);
  });
}

/** The fake vault, with the page standing in for Obsidian's modal, notices and tabs. */
class HarnessNotes extends FakeNotesHost {
  onOpen: (path: string) => void = () => {};
  onNotice: (message: string) => void = () => {};

  override async confirmFirstWrite(preview: FirstWritePreview): Promise<boolean> {
    this.confirmations.push(preview);
    return confirmInPage(preview);
  }

  override openNote(path: string): void {
    super.openNote(path);
    this.onOpen(path);
  }

  override notice(message: string): void {
    super.notice(message);
    this.onNotice(message);
  }
}

export interface RealSession {
  callLog: import('../src/llm/callLog.ts').CallLog;
  store: HamsterStore;
  controller: HamsterController;
  host: UiHost;
  session: HamsterSession;
  notes: FakeNotesHost;
  settings(): HamsterSettings;
  /** Says one sentence into the current recording, as a final segment. */
  say(text: string): void;
}

export async function createRealSession(opts: {
  dailyTextarea: HTMLTextAreaElement;
  params: URLSearchParams;
  viewer: { show(path: string, text: string | null): void; current(): string | null };
  toast(message: string): void;
}): Promise<RealSession> {
  const { dailyTextarea: textarea, params } = opts;
  const useRealLlm = params.get('llm') === 'real';

  let settings: HamsterSettings = {
    ...DEFAULT_SETTINGS,
    // In the settings, where the plugin has it: the session reads the address to say when it is not this computer.
    ollamaUrl: params.get('url') ?? DEFAULT_SETTINGS.ollamaUrl,
    llmModel: params.get('model') ?? DEFAULT_SETTINGS.llmModel,
    embedModel: params.get('embed') ?? DEFAULT_SETTINGS.embedModel,
    numCtx: Number(params.get('ctx')) || 8192,
    indexedFolders: [],
  };
  let local: LocalSettings = { ...DEFAULT_LOCAL };
  const startMs = Math.min(60_000, Math.max(0, Number(params.get('startMs')) || 0));

  const notes = new HarnessNotes({ settings: () => settings, date: isoDate(new Date()) });
  for (const [path, text] of Object.entries(VAULT)) notes.files.set(path, text);
  notes.entitiesText = ENTITIES;
  textarea.value = SAMPLE_DAILY;
  notes.setDaily(textarea.value);

  let llm: OllamaClient;
  if (useRealLlm) {
    llm = createOllamaClient({ baseUrl: () => settings.ollamaUrl, clock: realClock });
  } else {
    const fake = new FakeOllama({ clock: realClock, pieceDelayMs: 140, pieces: 10 });
    fake.installed = [settings.llmModel, settings.embedModel];
    llm = fake;
  }
  // The Debug tab: on with ?debug=1, or later from the console (hamster.callLog.setEnabled(true)).
  const callLog = createCallLog({ clock: realClock, enabled: opts.params.get('debug') === '1' });
  llm = withCallLog(llm, callLog);

  const sources: ScriptedSource[] = [];
  const session = createSession({
    settings: () => settings,
    async updateSettings(patch) {
      settings = { ...settings, ...patch };
      // As main.ts does once a change is saved: the session looks at what it changes.
      session.handleSettingsChange();
    },
    local: () => local,
    setLocal(patch) {
      local = { ...local, ...patch };
    },
    notes,
    llm,
    createTranscriptSource() {
      const source = new ScriptedSource(startMs);
      sources.push(source);
      return source;
    },
    vaultIndexIO: memoryVaultIndexIO(notes.files),
    statsIO: memoryStatsIO(),
    clock: realClock,
    clipboard(text) {
      void navigator.clipboard?.writeText(text).catch(() => {});
    },
  });

  /* Obsidian announces every change to a note, the plugin's own included, and
     main.ts hands each one to the session, which then has to tell its own
     write from an edit by hand. Without this the harness would never show
     that part of the session at work. */
  notes.onWrite = (path) => session.handleVaultChange({ type: 'modify', path });

  const dailyPath = (): string => notes.today().path;
  const push = (userTyped: boolean): void => {
    session.handleDailyUpdate({
      path: dailyPath(),
      text: textarea.value,
      cursor: document.activeElement === textarea ? textarea.selectionStart : null,
      userTyped,
    });
  };

  textarea.addEventListener('input', () => {
    notes.setDaily(textarea.value);
    push(true);
  });
  for (const event of ['keyup', 'click', 'focus'] as const) {
    textarea.addEventListener(event, () => push(false));
  }

  notes.onOpen = (path) => opts.viewer.show(path, notes.files.get(path) ?? null);
  notes.onNotice = (message) => opts.toast(message);

  /* The plugin's own writes: the link line appears in the "editor", and the
     note being viewed refreshes as its regions are written. */
  session.store.subscribe(() => {
    const disk = notes.dailyText;
    if (disk !== null && disk !== textarea.value) {
      const at = textarea.selectionStart;
      textarea.value = disk;
      textarea.setSelectionRange(at, at);
      push(false);
    }
    const viewing = opts.viewer.current();
    if (viewing) opts.viewer.show(viewing, notes.files.get(viewing) ?? null);
  });
  window.setInterval(() => {
    const viewing = opts.viewer.current();
    if (viewing) opts.viewer.show(viewing, notes.files.get(viewing) ?? null);
  }, 1000);

  await session.init();
  push(false);

  return {
    store: session.store,
    controller: session.controller,
    host: { renderMarkdown: renderMiniMarkdown, callLog },
    callLog,
    session,
    notes,
    settings: () => settings,
    say(text) {
      const source = sources[sources.length - 1];
      if (!source) return;
      const t = (session.store.getState().elapsedMs || 0) / 1000;
      source.say(text, t, t + 3);
    },
  };
}
