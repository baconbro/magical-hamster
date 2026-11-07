import type { HamsterController, HamsterStore, TabId, UiHost } from '../src/types.ts';
import type { AppProps } from '../src/ui/context.tsx';
import { watchBottomInset } from '../src/ui/inset.ts';
import { mountHamster, syncAllThemes } from '../src/ui/mount.tsx';
import { createFakeSession } from './fakeSession.ts';
import { createRealSession } from './realSession.ts';

/* The browser harness: the sidebar mounted in a page that imitates Obsidian's
   chrome and CSS variables (see index.html).

   Two modes.
     default            the REAL session on fake hosts (see realSession.ts):
                        type in the daily, record the scripted conversation,
                        enhance, create the companion and watch it fill.
     ?mode=fake         a scripted store with named states, for looking at one
     or ?scenario=...   screen at a time (empty, modelMissing, longTranscript...):
                        each has a button in the harness bar.

   Query parameters, in both modes:
     ?tab=transcript    open a tab: meetings, notes, summary, transcript, ask, stats
     ?theme=t-sepia     pick a theme of the harness: t-dark, t-light, t-amoled,
                        t-sepia, t-contrast
     ?w=300             width of the right pane in px, from 200 to 900 (the
                        sidebar is 280 to 460)
     ?bar=0             hide the harness bar (it covers the pane in a small window)

   Real session only (read in realSession.ts):
     ?llm=real          talk to Ollama instead of the scripted answers
     ?url=...           the Ollama address (default http://localhost:11434)
     ?model=...         generation model
     ?embed=...         embedding model
     ?ctx=8192          context size
     ?startMs=1500      how long the scripted microphone takes to start */

const leaf = document.getElementById('mh-leaf');
const textarea = document.getElementById('daily');
if (!leaf || !(textarea instanceof HTMLTextAreaElement)) {
  throw new Error('The harness page is missing #mh-leaf or #daily');
}

const params = new URLSearchParams(window.location.search);
const bar = document.getElementById('harness-bar');

/* A read-only pane under the daily: whatever note the plugin "opens", kept fresh
   so the companion can be watched while its regions are written. */
function createViewer() {
  let path: string | null = null;
  const pane = createDiv({ attr: { id: 'note-view' } });
  const head = pane.createDiv({ cls: 'host-tabbar' });
  const name = head.createSpan({ attr: { id: 'note-view-name' } });
  const close = head.createEl('button', { text: '×' });
  close.addEventListener('click', () => {
    path = null;
    pane.classList.remove('open');
  });
  const body = pane.createEl('pre', { attr: { id: 'note-view-text' } });
  document.querySelector('.host-main')?.append(pane);
  return {
    show(next: string, text: string | null) {
      path = next;
      name.textContent = next;
      const shown = text ?? '(this note does not exist)';
      if (body.textContent !== shown) body.textContent = shown;
      pane.classList.add('open');
    },
    current: () => path,
  };
}

function toast(message: string): void {
  const el = document.body.createDiv({ cls: 'harness-toast', text: message });
  window.setTimeout(() => el.remove(), 6000);
}

let store: HamsterStore;
let controller: HamsterController;
let host: UiHost;
let scenarios: Record<string, () => void> = {};
let debug: Record<string, unknown> = {};

if (params.get('mode') === 'fake' || params.has('scenario')) {
  const fake = createFakeSession({ dailyTextarea: textarea, toast });
  ({ store, controller, host, scenarios } = fake);
} else {
  const real = await createRealSession({ dailyTextarea: textarea, params, viewer: createViewer(), toast });
  ({ store, controller, host } = real);
  debug = {
    session: real.session,
    notes: real.notes,
    say: (text: string) => real.say(text),
    settings: () => real.settings(),
    callLog: real.callLog,
  };
}

const props: AppProps = { store, controller, host };
mountHamster(leaf, props);
watchBottomInset(leaf);

const name = document.getElementById('daily-name');
const showDailyName = () => {
  if (name) name.textContent = store.getState().daily.path;
};
showDailyName();
store.subscribe((state, prev) => {
  if (state.daily !== prev.daily) showDailyName();
});

window.addEventListener('hamster-harness-theme', () => syncAllThemes());

if (bar) {
  const keys = Object.keys(scenarios);
  bar.createSpan({ text: keys.length > 0 ? 'State' : 'Real session on fake hosts' });
  for (const key of keys) {
    const button = bar.createEl('button', { text: key, attr: { type: 'button', 'data-scenario': key } });
    button.addEventListener('click', () => scenarios[key]?.());
  }
  if (keys.length === 0) bar.createEl('a', { text: 'scripted states', attr: { href: '?mode=fake' } });
}

const TAB_IDS: readonly TabId[] = ['meetings', 'notes', 'summary', 'transcript', 'ask', 'stats', 'debug'];

const width = Number(params.get('w'));
if (Number.isFinite(width) && width >= 200 && width <= 900) {
  const pane = document.querySelector<HTMLElement>('.host-right');
  if (pane) pane.style.width = `${width}px`;
}

if (params.get('bar') === '0' && bar) bar.classList.add('harness-hidden');

const theme = params.get('theme');
const themeSelect = document.getElementById('theme');
if (theme && themeSelect instanceof HTMLSelectElement && [...themeSelect.options].some((o) => o.value === theme)) {
  themeSelect.value = theme;
  themeSelect.dispatchEvent(new Event('change'));
}

const scenario = params.get('scenario');
if (scenario) scenarios[scenario]?.();

const tab = params.get('tab');
if (tab && (TAB_IDS as readonly string[]).includes(tab)) controller.setTab(tab as TabId);

/* For poking at the state from the console. With the real session, an edit
   by hand of a note is two calls, as it is two events in Obsidian:
     hamster.notes.files.set(path, text)
     hamster.session.handleVaultChange({ type: 'modify', path }) */
Object.assign(window, { hamster: { store, controller, scenarios, ...debug } });
