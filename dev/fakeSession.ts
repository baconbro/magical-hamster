import { initialState } from '../src/session/initialState.ts';
import { createHamsterStore } from '../src/session/store.ts';
import { DEFAULT_SETTINGS, softMarkerRegex } from '../src/settings.ts';
import type {
  ChatUsage,
  DailyInfo,
  EnhancedItem,
  EnhanceStyle,
  HamsterController,
  HamsterState,
  HamsterStore,
  MeetingListEntry,
  MeetingState,
  QaEntry,
  QuestionChip,
  Section,
  SectionItem,
  SectionKey,
  SourceDoc,
  Stats,
  SttSource,
  SummaryStyle,
  TabId,
  Turn,
  UiHost,
} from '../src/types.ts';
import { mondayOf, sectionKey } from '../src/ui/components/format.ts';
import { shortHash } from '../src/util/hash.ts';
import { detectLang } from '../src/util/lang.ts';
import { clock, isoDate } from '../src/util/text.ts';
import { renderMiniMarkdown } from '../src/ui/miniMarkdown.ts';
import { SAMPLE_DAILY } from './sampleDaily.ts';

/* --------------------------------------------------------------------------
 * A scripted stand-in for the session, for the browser harness only.
 *
 * It owns a real store and implements every controller method with timers and
 * canned text, so the sidebar can be driven and looked at without Obsidian, a
 * microphone or Ollama. Everything here is throwaway: the section parser below
 * is a rough copy of what `src/editor/sectionAt.ts` does properly, and the
 * whole file is replaced by the real session wired to fake hosts.
 *
 * All names, lines of dialogue and figures are made up.
 * ------------------------------------------------------------------------ */

export interface FakeSession {
  store: HamsterStore;
  controller: HamsterController;
  host: UiHost;
  scenarios: Record<string, () => void>;
}

/* ───────────────────────────── The daily note ───────────────────────── */

const HEADING = /^(#{1,3})\s+(.+?)\s*$/;
const TOPIC = /^#{4,6}\s+(.+?)\s*$/;
const LINK_LINE = /^↳ \[\[Mtg-/;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
const MEETING_WORD = /\b(1:1|ad ?hoc|meeting|sync|stand-?up|steering|review|rencontre|réunion|comité|kick-?off)\b/i;

interface ParsedSection extends Section {
  meetingLike: boolean;
}

function parseDaily(text: string, soft: RegExp): ParsedSection[] {
  const lines = text.split('\n');
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  const offsetOf = (line: number) => (line < lines.length ? offsets[line] : text.length);

  const anchors: Array<{ line: number; level: number; isHeading: boolean; rawTitle: string }> = [];
  lines.forEach((line, i) => {
    const heading = HEADING.exec(line);
    if (heading) {
      anchors.push({ line: i, level: heading[1].length, isHeading: true, rawTitle: heading[2] });
    } else if (soft.test(line)) {
      anchors.push({ line: i, level: 0, isHeading: false, rawTitle: line.trim() });
    }
  });

  const seen = new Map<string, number>();
  return anchors.map((anchor, index) => {
    let end = lines.length;
    for (let j = index + 1; j < anchors.length; j++) {
      const next = anchors[j];
      /* A heading runs to the next heading of its level or above; a soft marker also ends it, and ends at anything. */
      if (!anchor.isHeading || !next.isHeading || next.level <= anchor.level) {
        end = next.line;
        break;
      }
    }

    const links = [...anchor.rawTitle.matchAll(WIKILINK)].map((m) => m[1].trim());
    const title = anchor.rawTitle.replace(WIKILINK, (_all, target: string, alias?: string) => alias ?? target).trim();
    const ordinal = seen.get(title) ?? 0;
    seen.set(title, ordinal + 1);

    const items: SectionItem[] = [];
    const ids = new Map<string, number>();
    let linkLine: number | null = null;
    for (let i = anchor.line + 1; i < end; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (trimmed === '') continue;
      if (LINK_LINE.test(trimmed)) {
        linkLine ??= i;
        continue;
      }
      const topic = TOPIC.exec(trimmed);
      const base = shortHash(trimmed);
      const count = ids.get(base) ?? 0;
      ids.set(base, count + 1);
      items.push({
        id: count === 0 ? base : `${base}#${count}`,
        text: topic ? topic[1] : trimmed.replace(LIST_MARKER, ''),
        raw,
        line: i,
        kind: topic ? 'topic' : 'item',
      });
    }

    return {
      title,
      rawTitle: anchor.rawTitle,
      links,
      ordinal,
      isHeading: anchor.isHeading,
      level: anchor.level,
      anchorLine: anchor.line,
      bodyStartLine: anchor.line + 1,
      bodyEndLine: end,
      from: offsetOf(anchor.line + 1),
      to: offsetOf(end),
      items,
      linkLine,
      meetingLike: !anchor.isHeading || links.length > 0 || MEETING_WORD.test(title),
    };
  });
}

function keyOf(section: Section): SectionKey {
  return sectionKey(section.title, section.ordinal);
}

/** The innermost section whose anchor or body holds `line`. */
function sectionAtLine(sections: ParsedSection[], line: number): ParsedSection | null {
  let found: ParsedSection | null = null;
  for (const s of sections) {
    if (line >= s.anchorLine && line < s.bodyEndLine) found = s;
  }
  return found;
}

function sameItems(a: SectionItem[], b: SectionItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i]?.id && x.line === b[i]?.line && x.kind === b[i]?.kind);
}

function sameEntries(a: MeetingListEntry[], b: MeetingListEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      return (
        y !== undefined &&
        x.key === y.key &&
        x.rawTitle === y.rawTitle &&
        x.anchorLine === y.anchorLine &&
        x.group === y.group &&
        x.companionPath === y.companionPath &&
        x.current === y.current
      );
    })
  );
}

/** The companion file name for a title, roughly as `src/notes/sanitize.ts` will make it. */
function fileTitle(title: string): string {
  return title
    .replace(/:/g, '-')
    .replace(/[[\]#^|/\\*?"<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/* ───────────────────────────── Canned material ──────────────────────── */

interface ScriptLine {
  source: SttSource;
  text: string;
  question?: boolean;
}

const SCRIPT: ScriptLine[] = [
  { source: 'mic', text: 'Thanks for making time. I would like to start with the Q4 roadmap and then the budget.' },
  { source: 'system', text: 'Sounds good. The identity migration has to go first, everything else depends on it.' },
  { source: 'mic', text: "D'accord. Est-ce qu'on a une date pour la bascule ?" },
  { source: 'system', text: 'On vise la mi-novembre, si le contrat du fournisseur est renouvelé à temps.' },
  { source: 'mic', text: 'And if the renewal slips, what is the fallback?', question: true },
  { source: 'system', text: 'We keep the current platform for one more quarter. It costs more, but nothing breaks.' },
  { source: 'mic', text: "Pour le budget, j'ai compris que deux postes restent gelés jusqu'en janvier." },
  { source: 'system', text: "Oui, c'est ça. Je vais demander une exception pour le poste d'analyste." },
  { source: 'system', text: 'Do you remember who approved the exception last year?', question: true },
  { source: 'mic', text: 'I am not sure, let me check my notes after the call.' },
  { source: 'system', text: "Il y a aussi la dépendance sur l'équipe réseau pour la fenêtre de maintenance." },
  { source: 'mic', text: 'Right. I will ask them to confirm a window within two weeks.' },
  { source: 'system', text: 'Quel est le budget prévu pour la formation cette année ?', question: true },
  { source: 'mic', text: 'Je te reviens là-dessus, je dois valider le chiffre avec les finances.' },
  { source: 'system', text: 'Perfect. Let us review the action items before we wrap up.' },
  { source: 'mic', text: 'Jane requests the exception, I confirm the maintenance window, and we meet again next Thursday.' },
];

const BULLETS: Record<string, { standard: string; concise: string }> = {
  'Q4 roadmap: identity migration first': {
    standard:
      '**Q4 roadmap:** The identity migration goes first, because the other Q4 items depend on it. The cutover is planned for mid-November.',
    concise: '**Q4 roadmap:** Identity migration first; cutover in mid-November.',
  },
  "budget: 2 postes gelés jusqu'en janvier": {
    standard:
      "**Budget :** Deux postes restent gelés jusqu'en janvier. Jane demandera une exception pour le poste d'analyste.",
    concise: "**Budget :** Deux postes gelés jusqu'en janvier; exception demandée pour l'analyste.",
  },
  'backfill for the analyst role?': {
    standard:
      '**Analyst backfill:** Still open. Jane will raise the exception request with finance this week and confirm by Friday.',
    concise: '**Analyst backfill:** Open; exception request goes to finance this week.',
  },
  'vendor contract renewal may slip to Nov': {
    standard:
      '**Vendor contract:** The renewal may slip to November, which would push the cutover. The fallback is to keep the current platform for one more quarter.',
    concise: '**Vendor contract:** Renewal may slip to November; fallback is one more quarter on the current platform.',
  },
  "dépendance sur l'équipe réseau pour la bascule": {
    standard:
      "**Équipe réseau :** La bascule dépend d'une fenêtre de maintenance de l'équipe réseau, à confirmer d'ici deux semaines.",
    concise: "**Équipe réseau :** Fenêtre de maintenance à confirmer d'ici deux semaines.",
  },
  'decision needed on the cloud landing zone': {
    standard:
      '**Cloud landing zone:** The board has to choose between the two designs at the next session. The architecture team will send a one-page comparison first.',
    concise: '**Cloud landing zone:** Decision at the next session; one-page comparison to come.',
  },
  'présenter le tableau de bord du portefeuille': {
    standard:
      '**Tableau de bord :** Le tableau de bord du portefeuille sera présenté au comité, avec les trois projets en rouge en premier.',
    concise: '**Tableau de bord :** Présentation au comité, projets en rouge en premier.',
  },
  '3 projects red, 2 need a new sponsor': {
    standard:
      '**Portfolio health:** Three projects are red, and two of them need a new sponsor before the end of the month.',
    concise: '**Portfolio health:** Three red projects; two need a sponsor this month.',
  },
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function bulletFor(source: string, style: EnhanceStyle): string {
  const canned = BULLETS[source];
  if (canned) return canned[style];
  const clean = source.replace(/[.?!:;,\s]+$/, '');
  const label = capitalize(clean.split(/\s+/).slice(0, 3).join(' ').replace(/[:,;]+$/, ''));
  if (detectLang(source) === 'fr') {
    return style === 'concise'
      ? `**${label} :** ${capitalize(clean)}.`
      : `**${label} :** ${capitalize(clean)}. Le point a été discuté et un suivi est prévu cette semaine.`;
  }
  return style === 'concise'
    ? `**${label}:** ${capitalize(clean)}.`
    : `**${label}:** ${capitalize(clean)}. This was discussed and a follow-up is planned this week.`;
}

const SUMMARIES: Record<SummaryStyle, string> = {
  executive: `### Outcome
The identity migration stays first in the Q4 roadmap, with the cutover planned for **mid-November**. Two positions remain frozen until January.

### Decisions
- Keep the current platform for one more quarter if the vendor renewal slips.
- Jane requests an exception for the analyst position.

### Risks
- The vendor contract renewal may slip to November.
- La bascule dépend d'une fenêtre de maintenance de l'équipe réseau.

### Next steps
1. Jane sends the exception request to finance this week.
2. Confirm the maintenance window within two weeks.
3. Meet again next Thursday.`,
  recap: `### Roadmap
The meeting opened with the Q4 roadmap. The identity migration goes first because the other items depend on it. The cutover is planned for mid-November, *if the vendor contract is renewed in time*.

### Budget
Deux postes restent gelés jusqu'en janvier. Jane demandera une exception pour le poste d'analyste; personne ne se souvenait de qui avait approuvé celle de l'an dernier.

### Dependencies
The network team has to provide a maintenance window for the cutover. It is not booked yet.

### Wrap-up
Action items were reviewed and the next meeting is set for Thursday.`,
  actions: `### Action items
- **Jane:** request the exception for the analyst position, this week.
- **Fred:** ask the network team to confirm a maintenance window, within two weeks.
- **Fred:** check the notes for who approved last year's exception.
- **Fred:** valider le budget de formation avec les finances.

### Open questions
- What is the fallback date if the vendor renewal slips past November?`,
};

interface CannedAnswer {
  match: RegExp;
  answer: string;
  sources: Array<Omit<SourceDoc, 'n' | 'text'>>;
}

const ANSWERS: CannedAnswer[] = [
  {
    match: /fallback|renewal|slips/i,
    answer:
      'If the vendor renewal slips, the plan is to **keep the current platform for one more quarter** [1]. It costs more, but nothing breaks. The migration plan lists the same fallback, with a decision point two weeks before the cutover [2].',
    sources: [
      { kind: 'transcript', title: 'Transcript', time: '00:14' },
      { kind: 'note', title: 'Identity migration plan', heading: 'Fallback', path: '10 Work/Projects/Identity migration plan.md' },
    ],
  },
  {
    match: /approved|exception/i,
    answer:
      "Your notes say last year's exception was approved by the **finance committee**, not by a single person [1]. The request went in through the quarterly staffing review [2].",
    sources: [
      { kind: 'note', title: 'Staffing review', heading: 'Exceptions', path: '10 Work/Staffing review.md' },
      { kind: 'linked', title: 'Jane Example', heading: 'Open requests', path: '40 Resources/People/Jane Example.md' },
    ],
  },
  {
    match: /formation|training/i,
    answer:
      "Le budget de formation prévu cette année est de **40 000 $**, dont environ la moitié est déjà engagée [1]. Le plan de formation doit être revu en novembre [2].",
    sources: [
      { kind: 'note', title: 'Budget 2026', heading: 'Formation', path: '10 Work/Budget 2026.md' },
      { kind: 'note', title: 'Plan de formation', path: '10 Work/Plan de formation.md' },
    ],
  },
  {
    match: /cutover|bascule|date|when/i,
    answer:
      'The cutover is planned for **mid-November**, provided the vendor contract is renewed in time [1]. The plan gives the weekend of the 14th as the target [2].',
    sources: [
      { kind: 'transcript', title: 'Transcript', time: '00:10' },
      { kind: 'note', title: 'Identity migration plan', heading: 'Timeline', path: '10 Work/Projects/Identity migration plan.md' },
    ],
  },
];

const DEFAULT_ANSWER: CannedAnswer = {
  match: /./,
  answer:
    'Here is what your notes and this meeting say about it:\n\n- The identity migration is first in the Q4 roadmap [1].\n- Two positions stay frozen until January [2].\n\nNothing else in the indexed folders matches the question closely.',
  sources: [
    { kind: 'transcript', title: 'Transcript', time: '00:05' },
    { kind: 'note', title: 'Budget 2026', heading: 'Staffing', path: '10 Work/Budget 2026.md' },
  ],
};

const FOLDERS = [
  '00 Inbox',
  '10 Work',
  '10 Work/Meetings',
  '10 Work/Projects',
  '20 Areas',
  '20 Areas/Health',
  '30 Projects',
  '40 Resources',
  '40 Resources/People',
  '90 Archive',
];

const NOTES_PER_FOLDER: Record<string, number> = {
  '00 Inbox': 64,
  '10 Work': 412,
  '10 Work/Meetings': 180,
  '10 Work/Projects': 150,
  '20 Areas': 96,
  '20 Areas/Health': 22,
  '30 Projects': 58,
  '40 Resources': 133,
  '40 Resources/People': 41,
  '90 Archive': 870,
};

const MODEL = DEFAULT_SETTINGS.llmModel;
const STT_MISSING_MESSAGE =
  'Transcription is not installed on this Mac. Run the setup command once, then start recording again.';

/* ───────────────────────────── The session ──────────────────────────── */

export function createFakeSession(opts: {
  dailyTextarea: HTMLTextAreaElement;
  /** Where the page shows what the real session would say in a notice. */
  toast: (message: string) => void;
}): FakeSession {
  const textarea = opts.dailyTextarea;
  const { toast } = opts;
  const soft = softMarkerRegex(DEFAULT_SETTINGS);
  const today = isoDate(new Date());
  const daily: DailyInfo = {
    path: `${DEFAULT_SETTINGS.companionFolder}/${today}.md`,
    basename: today,
    date: today,
    exists: true,
  };

  const base = (): HamsterState => ({
    ...initialState(DEFAULT_SETTINGS, daily),
    ollama: { status: 'ok', missingModels: [], remoteHost: null },
  });
  const store = createHamsterStore(base());
  const get = () => store.getState();
  const set = (patch: Partial<HamsterState>) => store.setState(patch);

  /* Everything scheduled is tracked, so a scenario can stop the world before it paints its own. */
  const timeouts = new Set<number>();
  const intervals = new Set<number>();
  let epoch = 0;

  const later = (fn: () => void, ms: number): number => {
    const id = window.setTimeout(() => {
      timeouts.delete(id);
      fn();
    }, ms);
    timeouts.add(id);
    return id;
  };
  const every = (fn: () => void, ms: number): number => {
    const id = window.setInterval(fn, ms);
    intervals.add(id);
    return id;
  };
  const stopEvery = (id: number | null) => {
    if (id === null) return;
    window.clearInterval(id);
    intervals.delete(id);
  };
  /* A scenario jump cancels every timer. A sleep is woken instead of dropped, so
     an action cut short still settles its promise: it wakes, sees the new epoch
     and returns. A promise left pending would keep its button disabled for good. */
  const sleepers = new Map<number, () => void>();
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const id = later(() => {
        sleepers.delete(id);
        resolve();
      }, ms);
      sleepers.set(id, resolve);
    });

  /* ── daily binding ── */

  const companions = new Map<SectionKey, string>();
  /** Meetings started on their own that have a note: listed after the sections, daily or no daily. */
  let manualRows: MeetingListEntry[] = [];
  let parsed: ParsedSection[] = [];
  /** Null plays "the daily has no focused editor". */
  let cursor: number | null = null;
  /** True once Enhance ran for this meeting: from then on new lines show up as pending. */
  let mirrorEnhanced = false;

  const lineOfOffset = (text: string, at: number) => {
    let line = 0;
    for (let i = 0; i < at && i < text.length; i++) if (text.charCodeAt(i) === 10) line += 1;
    return line;
  };

  function syncEnhanced(shorthand: SectionItem[]): void {
    const before = get().enhanced;
    if (!mirrorEnhanced) return;
    const byId = new Map(before.map((e) => [e.id, e]));
    const liveIds = new Set(shorthand.map((s) => s.id));
    const next: EnhancedItem[] = shorthand.map((item, index) => {
      const same = byId.get(item.id);
      if (same) return same;
      /* A line edited in place: same position, new text. Its bullet is kept and marked stale. */
      const old = before[index];
      if (old && !liveIds.has(old.id) && old.kind === item.kind && old.bullet !== null) {
        return { ...old, id: item.id, source: item.text, stale: true, streaming: false };
      }
      return { id: item.id, kind: item.kind, source: item.text, bullet: null, stale: false, streaming: false, excerptIds: [] };
    });
    const unchanged = next.length === before.length && next.every((e, i) => e === before[i]);
    if (unchanged) return;
    const settled = get().enhanceStatus === 'up-to-date';
    set(settled ? { enhanced: next, enhanceStatus: 'idle' } : { enhanced: next });
  }

  function syncDaily(): void {
    const state = get();
    /* As the real session does: the current meeting is left out, the sidebar shows it by itself. */
    const manual = manualRows.filter((row) => row.key !== state.meeting?.key);
    if (!state.daily.exists) {
      parsed = [];
      if (!sameEntries(state.sections, manual) || state.activeSection || state.shorthand.length > 0) {
        set({ sections: manual, activeSection: null, shorthand: [] });
      }
      return;
    }

    const text = textarea.value;
    parsed = parseDaily(text, soft);
    const under = cursor === null ? null : sectionAtLine(parsed, lineOfOffset(text, cursor));
    const meeting = state.meeting;
    const mine = meeting && !meeting.manual ? (parsed.find((s) => keyOf(s) === meeting.key) ?? null) : null;

    const sections: MeetingListEntry[] = parsed.map((s) => ({
      key: keyOf(s),
      title: s.title,
      rawTitle: s.rawTitle,
      ordinal: s.ordinal,
      anchorLine: s.anchorLine,
      isHeading: s.isHeading,
      group: s.meetingLike ? 'meeting' : 'other',
      companionPath: companions.get(keyOf(s)) ?? null,
      current: meeting !== null && meeting.key === keyOf(s),
    }));
    sections.push(...manual);

    const pinned = meeting !== null && !meeting.manual;
    const shorthand = pinned ? (mine?.items ?? []) : meeting ? [] : (under?.items ?? []);
    const activeSection: Section | null = pinned ? null : under;
    const cursorOutside = pinned && cursor !== null && mine !== null && under !== mine;

    const patch: Partial<HamsterState> = {};
    if (!sameEntries(state.sections, sections)) patch.sections = sections;
    if (!sameItems(state.shorthand, shorthand)) patch.shorthand = shorthand;
    const activeKey = (s: Section | null) => (s ? `${keyOf(s)}@${s.anchorLine}:${s.items.length}` : '');
    if (activeKey(state.activeSection) !== activeKey(activeSection)) patch.activeSection = activeSection;
    if (meeting && meeting.cursorOutside !== cursorOutside) patch.meeting = { ...meeting, cursorOutside };
    if (Object.keys(patch).length > 0) set(patch);

    syncEnhanced(patch.shorthand ?? state.shorthand);
  }

  let liveTimer: number | null = null;
  const readCursor = () => {
    cursor = document.activeElement === textarea ? textarea.selectionStart : cursor;
  };
  textarea.addEventListener('input', () => {
    readCursor();
    syncDaily();
    if (get().liveEnhance && get().shorthand.length > 0) {
      if (liveTimer !== null) window.clearTimeout(liveTimer);
      liveTimer = later(() => {
        liveTimer = null;
        void runEnhance();
      }, 1500);
    }
  });
  for (const type of ['keyup', 'click', 'focus', 'select'] as const) {
    textarea.addEventListener(type, () => {
      readCursor();
      syncDaily();
    });
  }

  /* ── usage and stats ── */

  function recordUsage(promptTokens: number, outputTokens: number, cachedShare: number, assist = true): void {
    const evalMs = Math.round((outputTokens / 31) * 1000);
    const promptMs = Math.round((promptTokens * (1 - cachedShare)) / 0.9);
    const usage: ChatUsage = {
      model: MODEL,
      promptTokens,
      cachedTokens: Math.round(promptTokens * cachedShare),
      outputTokens,
      totalMs: evalMs + promptMs + 40,
      loadMs: 40,
      promptMs,
      evalMs,
    };
    const stats = get().stats;
    const week = mondayOf(today) ?? today;
    const current = stats.weekly[week] ?? { input: 0, output: 0 };
    set({
      lastUsage: usage,
      stats: {
        ...stats,
        input: stats.input + promptTokens,
        output: stats.output + outputTokens,
        cached: stats.cached + usage.cachedTokens,
        weekly: { ...stats.weekly, [week]: { input: current.input + promptTokens, output: current.output + outputTokens } },
        assists: stats.assists + (assist ? 1 : 0),
      },
    });
  }

  /** Reveals `text` a few words at a time. Resolves false when `alive` turned false on the way. */
  async function stream(text: string, onText: (soFar: string) => void, alive: () => boolean, stepMs = 45): Promise<boolean> {
    const words = text.split(/(?<=\s)/);
    let soFar = '';
    for (let i = 0; i < words.length; i += 2) {
      soFar += words.slice(i, i + 2).join('');
      await sleep(stepMs);
      if (!alive()) return false;
      onText(soFar);
    }
    return true;
  }

  /* ── enhance ── */

  let enhanceRun = 0;

  function patchEnhanced(id: string, patch: Partial<EnhancedItem>): void {
    set({ enhanced: get().enhanced.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
  }

  async function runEnhance(): Promise<void> {
    const run = ++enhanceRun;
    const at = epoch;
    const alive = () => run === enhanceRun && at === epoch;

    mirrorEnhanced = true;
    syncEnhanced(get().shorthand);
    /* A run that was cut off leaves its row marked; nothing is streaming once a new run starts. */
    if (get().enhanced.some((e) => e.streaming)) {
      set({ enhanced: get().enhanced.map((e) => (e.streaming ? { ...e, streaming: false } : e)) });
    }

    if (get().ollama.status === 'unreachable') {
      set({ enhanceStatus: 'error', enhanceError: `Ollama is not reachable at ${DEFAULT_SETTINGS.ollamaUrl}.` });
      return;
    }

    const todo = get().enhanced.filter((e) => e.kind === 'item' && (e.bullet === null || e.stale));
    if (todo.length === 0) {
      set({ enhanceStatus: 'up-to-date', enhanceError: null });
      return;
    }

    set({ enhanceStatus: 'evaluating', enhanceError: null });
    await sleep(450);
    if (!alive()) return;
    if (get().turns.length > 0) {
      set({ enhanceStatus: 'retrieving' });
      await sleep(550);
      if (!alive()) return;
    }
    set({ enhanceStatus: 'structuring' });

    let outputTokens = 0;
    for (const item of todo) {
      if (!get().enhanced.some((e) => e.id === item.id)) continue;
      const bullet = bulletFor(item.source, get().enhanceStyle);
      patchEnhanced(item.id, { streaming: true });
      const done = await stream(bullet, (soFar) => patchEnhanced(item.id, { bullet: soFar, stale: false }), alive);
      if (!done) return;
      patchEnhanced(item.id, { bullet, stale: false, streaming: false, excerptIds: get().turns.length > 0 ? ['E1'] : [] });
      outputTokens += Math.ceil(bullet.length / 3.3);
    }
    set({ enhanceStatus: 'up-to-date' });
    recordUsage(620 + todo.length * 40 + get().turns.length * 12, outputTokens, 0.82);
  }

  /* ── recording ── */

  let recStartedAt = 0;
  let tickTimer: number | null = null;
  let levelTimer: number | null = null;
  let partialTimer: number | null = null;
  let scriptAt = 0;
  /* The ids of turns, and with them of the question chips, are React keys. The counter is never
     rewound, not even by a scenario: a line of the script still being spoken when one is chosen
     cannot come back under an id the new state already uses. */
  let turnSeq = 0;
  const nextTurnId = (): string => {
    turnSeq += 1;
    return `t${turnSeq}`;
  };
  /** Bumped by every start and by whatever ends one: a start that was cancelled does not begin. */
  let startRun = 0;
  let speaking: SttSource | null = null;
  let level = 0;
  let sttInstalled = true;

  const elapsedSeconds = () => (Date.now() - recStartedAt) / 1000;

  function speakNext(): void {
    const at = epoch;
    if (get().recording !== 'recording' || !sttInstalled) return;
    const line = SCRIPT[scriptAt % SCRIPT.length];
    scriptAt += 1;
    const words = line.text.split(' ');
    const t0 = elapsedSeconds();
    let said = 0;
    speaking = line.source;

    partialTimer = every(() => {
      if (at !== epoch || get().recording !== 'recording') {
        stopEvery(partialTimer);
        partialTimer = null;
        return;
      }
      said += 1 + (Math.random() < 0.45 ? 1 : 0);
      if (said < words.length) {
        set({ partial: { source: line.source, text: words.slice(0, said).join(' ') } });
        return;
      }

      stopEvery(partialTimer);
      partialTimer = null;
      speaking = null;
      const turn: Turn = {
        id: nextTurnId(),
        source: line.source,
        t0,
        t1: elapsedSeconds(),
        text: line.text,
        lang: detectLang(line.text),
      };
      const patch: Partial<HamsterState> = { turns: [...get().turns, turn], partial: null };
      const qa = get().qa;
      if (line.question && qa.chips.length < 3 && !qa.chips.some((c) => c.text === line.text)) {
        const chip: QuestionChip = { id: `chip-${turn.id}`, text: line.text, time: clock(t0), turnId: turn.id };
        patch.qa = { ...qa, chips: [...qa.chips, chip] };
      }
      set(patch);
      later(() => {
        if (at === epoch) speakNext();
      }, 500 + Math.random() * 700);
    }, 170);
  }

  function beginRecordingLoop(alreadyMs: number): void {
    recStartedAt = Date.now() - alreadyMs;
    tickTimer = every(() => set({ elapsedMs: Date.now() - recStartedAt }), 500);
    levelTimer = every(() => {
      const target = speaking === 'mic' ? 0.55 : speaking === 'system' ? 0.12 : 0.04;
      level = Math.min(1, Math.max(0, level + (target - level) * 0.5 + (Math.random() - 0.5) * 0.22));
      set({ micLevel: level });
    }, 120);
    later(speakNext, 600);
  }

  function endRecordingLoop(): void {
    stopEvery(tickTimer);
    stopEvery(levelTimer);
    stopEvery(partialTimer);
    tickTimer = levelTimer = partialTimer = null;
    speaking = null;
    level = 0;
  }

  /* ── summary, Q&A, index ── */

  let summaryRun = 0;
  const askRuns = new Map<string, boolean>();
  /* Never rewound either: the answers a scenario shows take their ids from it like any other. */
  let askSeq = 0;
  const nextAskId = (): string => {
    askSeq += 1;
    return `q${askSeq}`;
  };
  let indexTimer: number | null = null;

  function patchEntry(id: string, patch: Partial<QaEntry>): void {
    const qa = get().qa;
    set({ qa: { ...qa, entries: qa.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) } });
  }

  function newMeetingState(key: string, title: string, section: Section | null): MeetingState {
    return {
      key,
      title,
      date: today,
      manual: section === null,
      source: section ? { title: section.title, ordinal: section.ordinal } : null,
      companionPath: companions.get(key) ?? null,
      startedAt: null,
      endedAt: null,
      detachedRegions: [],
      cursorOutside: false,
    };
  }

  /** What belongs to one meeting and goes away with it. */
  function clearedMeeting(): Partial<HamsterState> {
    enhanceRun += 1;
    summaryRun += 1;
    askRuns.clear();
    mirrorEnhanced = false;
    return {
      recording: 'idle',
      recordingError: null,
      elapsedMs: 0,
      micLevel: 0,
      stt: sttInstalled ? 'idle' : 'not-installed',
      turns: [],
      partial: null,
      enhanceStatus: 'idle',
      enhanceError: null,
      enhanced: [],
      summary: { style: get().summary.style, status: 'idle', markdown: '', error: null },
      qa: { entries: [], chips: [] },
      pendingWrites: 0,
    };
  }

  const controller: HamsterController = {
    setTab(tab: TabId) {
      set({ tab });
    },

    selectSection(key: SectionKey) {
      /* A meeting started on its own is picked up again from its note: it has no section. */
      const manual = manualRows.find((row) => row.key === key);
      if (manual) {
        endRecordingLoop();
        set({
          ...clearedMeeting(),
          meeting: { ...newMeetingState(key, manual.title, null), companionPath: manual.companionPath },
          tab: 'notes',
        });
        syncDaily();
        return;
      }
      const section = parsed.find((s) => keyOf(s) === key);
      if (!section) return;
      if (get().meeting?.key === key) {
        set({ tab: 'notes' });
        return;
      }
      endRecordingLoop();
      set({ ...clearedMeeting(), meeting: newMeetingState(key, section.title, section), tab: 'notes' });
      syncDaily();
    },

    newMeeting() {
      endRecordingLoop();
      set({ ...clearedMeeting(), meeting: newMeetingState(`manual:${Date.now()}`, 'New meeting', null), tab: 'notes' });
      syncDaily();
    },

    async useActiveNote() {
      toast('"Use this note" needs the real session: open the page without ?mode=fake.');
    },
    async writeIntoActiveNote() {
      toast('"Write the meeting into this note" needs the real session: open the page without ?mode=fake.');
    },
    async linkAtCursor() {
      const meeting = get().meeting;
      const target = get().activeSection;
      if (!meeting?.manual) return;
      if (!target) {
        toast('Put the cursor in a section of the daily note first.');
        return;
      }
      const key = keyOf(target);
      set({
        meeting: {
          ...meeting,
          key,
          title: target.title,
          manual: false,
          source: { title: target.title, ordinal: target.ordinal },
          companionPath: companions.get(key) ?? null,
        },
      });
      syncDaily();
    },

    async endMeeting() {
      const at = epoch;
      if (get().recording !== 'idle') await controller.stopRecording();
      if (at !== epoch) return;
      endRecordingLoop();
      set({ ...clearedMeeting(), meeting: null });
      syncDaily();
    },

    async createCompanion() {
      const at = epoch;
      const meeting = get().meeting;
      if (!meeting) return;
      set({ pendingWrites: get().pendingWrites + 1 });
      await sleep(500);
      if (at !== epoch) return;

      /* A note that exists is read again, as the real session does ("Check the note again"):
         here its markers are always found repaired, and nothing stays set aside as edited by
         hand. The line in the daily is added only if missing. */
      const existing = meeting.companionPath ?? companions.get(meeting.key) ?? null;
      const basename =
        existing?.slice(existing.lastIndexOf('/') + 1).replace(/\.md$/, '') ??
        `${DEFAULT_SETTINGS.companionPrefix}${meeting.date} — ${fileTitle(meeting.title)}`;
      const path = existing ?? `${DEFAULT_SETTINGS.companionFolder}/${basename}.md`;
      companions.set(meeting.key, path);

      /* The one line the plugin adds to the daily: at the end of the section, once. */
      const section = parsed.find((s) => keyOf(s) === meeting.key);
      if (section) {
        const lines = textarea.value.split('\n');
        const line = `↳ [[${basename}|${DEFAULT_SETTINGS.dailyLinkAlias}]]`;
        if (section.linkLine !== null) {
          lines[section.linkLine] = line;
        } else {
          let last = section.bodyEndLine - 1;
          while (last > section.anchorLine && (lines[last] ?? '').trim() === '') last -= 1;
          lines.splice(last + 1, 0, line);
        }
        textarea.value = lines.join('\n');
      }

      const current = get().meeting;
      set({
        meeting:
          current && current.key === meeting.key
            ? { ...current, companionPath: path, detachedRegions: [], editedOutside: [] }
            : current,
        pendingWrites: Math.max(0, get().pendingWrites - 1),
      });
      syncDaily();
    },

    openCompanion() {
      toast(`The scripted session opens no note: this one is ${get().meeting?.companionPath ?? 'not written yet'}.`);
    },

    openDaily() {
      textarea.focus();
    },

    async startRecording() {
      const at = epoch;
      const meeting = get().meeting;
      if (!meeting || get().recording !== 'idle') return;
      startRun += 1;
      const run = startRun;
      set({ recording: 'starting', recordingError: null, stt: sttInstalled ? 'spawning' : 'not-installed' });
      await sleep(700);
      // Cancelled meanwhile, or cancelled and started again: only the latest start may begin.
      if (at !== epoch || run !== startRun || get().recording !== 'starting') return;
      set({
        recording: 'recording',
        stt: sttInstalled ? 'running' : 'not-installed',
        sttMessage: sttInstalled ? null : STT_MISSING_MESSAGE,
        meeting: { ...(get().meeting ?? meeting), startedAt: meeting.startedAt ?? Date.now(), endedAt: null },
      });
      beginRecordingLoop(get().elapsedMs);
    },

    async stopRecording() {
      const at = epoch;
      if (get().recording === 'starting') {
        // As the real session does: a start still under way is called off, with nothing to say about it.
        startRun += 1;
        set({ recording: 'idle', recordingError: null, stt: sttInstalled ? 'idle' : 'not-installed' });
        return;
      }
      if (get().recording !== 'recording') return;
      set({ recording: 'stopping', partial: null });
      endRecordingLoop();
      await sleep(500);
      if (at !== epoch || get().recording !== 'stopping') return;
      const meeting = get().meeting;
      const stats = get().stats;
      set({
        recording: 'idle',
        micLevel: 0,
        stt: sttInstalled ? 'idle' : 'not-installed',
        meeting: meeting ? { ...meeting, endedAt: Date.now() } : null,
        stats: get().turns.length > 0 ? { ...stats, meetings: stats.meetings + 1 } : stats,
      });
    },

    setLiveEnhance(on: boolean) {
      set({ liveEnhance: on });
      if (on && get().shorthand.length > 0) void runEnhance();
    },

    setEnhanceStyle(style: EnhanceStyle) {
      set({ enhanceStyle: style });
    },

    enhanceNow() {
      return runEnhance();
    },

    async summarize(style: SummaryStyle) {
      const run = ++summaryRun;
      const at = epoch;
      const alive = () => run === summaryRun && at === epoch;
      set({ summary: { style, status: 'running', markdown: '', error: null }, tab: 'summary' });
      await sleep(600);
      if (!alive()) return;
      if (get().ollama.status === 'unreachable') {
        set({ summary: { style, status: 'error', markdown: '', error: `Ollama is not reachable at ${DEFAULT_SETTINGS.ollamaUrl}.` } });
        return;
      }
      const text = SUMMARIES[style];
      const done = await stream(text, (soFar) => set({ summary: { style, status: 'running', markdown: soFar, error: null } }), alive, 40);
      if (!done) return;
      set({ summary: { style, status: 'done', markdown: text, error: null } });
      recordUsage(2400 + get().turns.length * 26, Math.ceil(text.length / 3.3), 0.35);
    },

    cancelSummary() {
      summaryRun += 1;
      set({ summary: { style: get().summary.style, status: 'idle', markdown: '', error: null } });
    },

    async ask(question: string, chipId?: string) {
      const at = epoch;
      const id = nextAskId();
      askRuns.set(id, true);
      const alive = () => askRuns.get(id) === true && at === epoch;

      const qa = get().qa;
      const entry: QaEntry = {
        id,
        askedAt: Date.now(),
        meetingTime: get().recording === 'recording' ? clock(get().elapsedMs / 1000) : null,
        question,
        answer: '',
        status: 'running',
        error: null,
        sources: [],
        kept: false,
      };
      set({
        qa: { entries: [...qa.entries, entry], chips: chipId ? qa.chips.filter((c) => c.id !== chipId) : qa.chips },
        tab: 'ask',
      });

      await sleep(900);
      if (!alive()) return;
      if (get().ollama.status === 'unreachable') {
        patchEntry(id, { status: 'error', error: `Ollama is not reachable at ${DEFAULT_SETTINGS.ollamaUrl}.` });
        return;
      }
      const canned = ANSWERS.find((a) => a.match.test(question)) ?? DEFAULT_ANSWER;
      const sources: SourceDoc[] = canned.sources.map((s, i) => ({ ...s, n: i + 1, text: '' }));
      patchEntry(id, { sources });
      const done = await stream(canned.answer, (soFar) => patchEntry(id, { answer: soFar }), alive, 40);
      if (!done) return;
      patchEntry(id, { answer: canned.answer, status: 'done' });
      askRuns.delete(id);
      recordUsage(1800 + sources.length * 420, Math.ceil(canned.answer.length / 3.3), 0.5);
    },

    cancelAsk(id: string) {
      if (!askRuns.has(id)) return;
      askRuns.delete(id);
      patchEntry(id, { status: 'error', error: 'Cancelled.' });
    },

    async keepInsight(id: string) {
      const at = epoch;
      if (!get().meeting?.companionPath) return;
      set({ pendingWrites: get().pendingWrites + 1 });
      await sleep(600);
      if (at !== epoch) return;
      patchEntry(id, { kept: true });
      set({ pendingWrites: Math.max(0, get().pendingWrites - 1) });
    },

    dismissChip(id: string) {
      const qa = get().qa;
      set({ qa: { ...qa, chips: qa.chips.filter((c) => c.id !== id) } });
    },

    listFolders() {
      return [...FOLDERS];
    },

    async buildIndex(folders: string[]) {
      const at = epoch;
      stopEvery(indexTimer);
      const total = folders.reduce((sum, f) => sum + (NOTES_PER_FOLDER[f] ?? 30), 0);
      set({ index: { status: 'building', files: 0, chunks: 0, done: 0, total, folders, error: null } });
      indexTimer = every(() => {
        if (at !== epoch) return;
        const index = get().index;
        const done = Math.min(index.total, index.done + Math.max(1, Math.round(index.total / 70)));
        if (done < index.total) {
          set({ index: { ...index, done } });
          return;
        }
        stopEvery(indexTimer);
        indexTimer = null;
        set({ index: { ...index, status: 'ready', done, files: index.total, chunks: Math.round(index.total * 9.16) } });
      }, 110);
    },

    cancelIndex() {
      stopEvery(indexTimer);
      indexTimer = null;
      const index = get().index;
      if (index.status !== 'building') return;
      /* As the real index does: a cancelled build keeps what it had embedded and can be started
         again. `paused` is something else, a build that a recording interrupts and that goes on
         by itself afterwards; the sidebar offers no button for it. */
      set({
        index:
          index.done > 0
            ? { ...index, status: 'ready', files: index.done, chunks: Math.round(index.done * 9.16) }
            : { ...index, status: 'none' },
      });
    },

    async refreshOllama() {
      const at = epoch;
      /* Looking again changes what was found, not where Ollama is. */
      const remoteHost = get().ollama.remoteHost;
      set({ ollama: { status: 'unknown', missingModels: [], remoteHost } });
      await sleep(700);
      if (at !== epoch) return;
      set({ ollama: { status: 'ok', missingModels: [], remoteHost } });
    },

    copy(text: string) {
      /* The clipboard needs a focused, secure page; when the harness is not, the text is shown instead. */
      const show = (): void => toast(text);
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(show);
      else show();
    },
  };

  /* ───────────────────────────── Scenarios ──────────────────────────── */

  const JANE: SectionKey = '1:1 Jane Example#0';
  const noteOf = (title: string): string =>
    `${DEFAULT_SETTINGS.companionFolder}/${DEFAULT_SETTINGS.companionPrefix}${today} — ${title}.md`;
  const JANE_NOTE = (): string => noteOf('1-1 Jane Example');

  /** Rows as the real session lists them for meetings that have no section: key `manual:`, no anchor line. */
  function manualSamples(): MeetingListEntry[] {
    return ['Vendor call', 'Hallway chat about the offsite budget and who signs it'].map((title, i) => ({
      key: `manual:${1_760_000_000_000 + i}`,
      title,
      rawTitle: title,
      ordinal: 0,
      anchorLine: -1,
      isHeading: false,
      group: 'meeting',
      companionPath: noteOf(title),
      current: false,
    }));
  }

  function reset(tab: TabId): void {
    epoch += 1;
    for (const id of timeouts) window.clearTimeout(id);
    for (const id of intervals) window.clearInterval(id);
    timeouts.clear();
    intervals.clear();
    const woken = [...sleepers.values()];
    sleepers.clear();
    for (const wake of woken) wake();
    tickTimer = levelTimer = partialTimer = indexTimer = liveTimer = null;
    speaking = null;
    level = 0;
    scriptAt = 0;
    startRun += 1;
    enhanceRun += 1;
    summaryRun += 1;
    askRuns.clear();
    companions.clear();
    manualRows = [];
    mirrorEnhanced = false;
    sttInstalled = true;
    cursor = null;
    textarea.disabled = false;
    textarea.placeholder = '';
    textarea.value = SAMPLE_DAILY;
    store.setState({ ...base(), tab }, true);
    syncDaily();
  }

  /** Scripted turns ending near `endSeconds`, as if the recording had been running all along. */
  function scriptedTurns(count: number, endSeconds: number): Turn[] {
    const turns: Turn[] = [];
    const step = endSeconds / (count + 1);
    for (let i = 0; i < count; i++) {
      const line = SCRIPT[i % SCRIPT.length];
      const t0 = step * (i + 0.2);
      turns.push({ id: nextTurnId(), source: line.source, t0, t1: t0 + step * 0.7, text: line.text, lang: detectLang(line.text) });
    }
    scriptAt = count;
    return turns;
  }

  function pinJane(extra: Partial<MeetingState> = {}): void {
    const section = parsed.find((s) => keyOf(s) === JANE);
    if (!section) return;
    set({ meeting: { ...newMeetingState(JANE, section.title, section), ...extra } });
    syncDaily();
  }

  function enhancedFromShorthand(decide: (item: SectionItem, index: number) => Partial<EnhancedItem>): void {
    mirrorEnhanced = true;
    set({
      enhanced: get().shorthand.map((item, index) => ({
        id: item.id,
        kind: item.kind,
        source: item.text,
        bullet: item.kind === 'topic' ? null : bulletFor(item.text, 'standard'),
        stale: false,
        streaming: false,
        excerptIds: [],
        ...decide(item, index),
      })),
    });
  }

  function sampleStats(): Stats {
    const weekly: Stats['weekly'] = {};
    const monday = Date.parse(`${mondayOf(today) ?? today}T00:00:00Z`);
    const figures: Array<[number, number]> = [
      [61_200, 9_400],
      [0, 0],
      [142_800, 21_300],
      [98_100, 15_700],
      [203_500, 30_900],
      [176_400, 24_100],
      [251_900, 38_200],
      [84_300, 12_600],
    ];
    figures.forEach(([input, output], i) => {
      if (input + output === 0) return;
      const key = new Date(monday - (figures.length - 1 - i) * 7 * 86_400_000).toISOString().slice(0, 10);
      weekly[key] = { input, output };
    });
    const input = figures.reduce((sum, f) => sum + f[0], 0) + 310_000;
    const output = figures.reduce((sum, f) => sum + f[1], 0) + 47_000;
    return { input, output, cached: 402_000, weekly, meetings: 23, assists: 187 };
  }

  const sampleUsage: ChatUsage = {
    model: MODEL,
    promptTokens: 3184,
    cachedTokens: 2610,
    outputTokens: 212,
    totalMs: 8140,
    loadMs: 38,
    promptMs: 1290,
    evalMs: 6810,
  };

  function answered(question: string, meetingTime: string | null, kept: boolean): QaEntry {
    const canned = ANSWERS.find((a) => a.match.test(question)) ?? DEFAULT_ANSWER;
    return {
      id: nextAskId(),
      askedAt: Date.now(),
      meetingTime,
      question,
      answer: canned.answer,
      status: 'done',
      error: null,
      sources: canned.sources.map((s, i) => ({ ...s, n: i + 1, text: '' })),
      kept,
    };
  }

  /** A meeting in full swing: a transcript, notes at every stage, answers, and the recording still running. */
  function midMeeting(tab: TabId, turnCount = 12, elapsedSeconds = 754): void {
    reset(tab);
    pinJane({ startedAt: Date.now() - elapsedSeconds * 1000 });
    const turns = scriptedTurns(turnCount, elapsedSeconds - 4);
    const lastQuestion = turns.filter((t) => t.text.endsWith('?')).slice(-2);
    enhancedFromShorthand((item, index) => {
      if (item.kind === 'topic') return {};
      if (index === 2) return { stale: true };
      if (index === 4) return { streaming: true, bullet: bulletFor(item.text, 'standard').split(' ').slice(0, 9).join(' ') };
      if (index === 5) return { bullet: null };
      return { excerptIds: ['E1'] };
    });
    set({
      recording: 'recording',
      stt: 'running',
      elapsedMs: elapsedSeconds * 1000,
      micLevel: 0.3,
      turns,
      liveEnhance: true,
      enhanceStatus: 'structuring',
      summary: { style: 'executive', status: 'done', markdown: SUMMARIES.executive, error: null },
      qa: {
        entries: [
          answered('When is the identity cutover planned?', '04:12', false),
          answered('What happens if the vendor renewal slips?', '09:40', false),
        ],
        chips: lastQuestion.map((t) => ({ id: `chip-${t.id}`, text: t.text, time: clock(t.t0), turnId: t.id })),
      },
      stats: sampleStats(),
      lastUsage: sampleUsage,
      index: { status: 'ready', files: 700, chunks: 6412, done: 700, total: 700, folders: ['10 Work', '40 Resources/People'], error: null },
    });
    beginRecordingLoop(elapsedSeconds * 1000);
  }

  const scenarios: Record<string, () => void> = {
    empty() {
      reset('meetings');
    },

    noDaily() {
      reset('meetings');
      textarea.value = '';
      textarea.disabled = true;
      textarea.placeholder = "Today's daily note does not exist.";
      set({ daily: { ...daily, exists: false } });
      syncDaily();
    },

    ollamaDown() {
      reset('notes');
      pinJane();
      set({ ollama: { status: 'unreachable', missingModels: [], remoteHost: null } });
    },

    modelMissing() {
      reset('notes');
      pinJane();
      set({ ollama: { status: 'ok', missingModels: [DEFAULT_SETTINGS.llmModel, DEFAULT_SETTINGS.embedModel], remoteHost: null } });
    },

    midMeeting() {
      midMeeting('notes');
    },

    /* The same meeting, with Ollama on another computer of the network: said on every tab. */
    remoteOllama() {
      midMeeting('notes');
      set({ ollama: { status: 'ok', missingModels: [], remoteHost: '192.168.1.50' } });
    },

    longTranscript() {
      midMeeting('transcript', 2000, 6400);
    },

    sttNotInstalled() {
      reset('transcript');
      sttInstalled = false;
      pinJane({ startedAt: Date.now() - 42_000 });
      set({ recording: 'recording', stt: 'not-installed', sttMessage: STT_MISSING_MESSAGE, elapsedMs: 42_000 });
      beginRecordingLoop(42_000);
    },

    detached() {
      reset('notes');
      companions.set(JANE, JANE_NOTE());
      pinJane({ detachedRegions: ['enhanced'] });
      enhancedFromShorthand(() => ({}));
      set({ enhanceStatus: 'up-to-date', turns: scriptedTurns(8, 300), elapsedMs: 300_000 });
    },

    /* The summary was rewritten by hand in the companion: the plugin no longer saves there. */
    editedOutside() {
      reset('summary');
      companions.set(JANE, JANE_NOTE());
      pinJane({ editedOutside: ['summary'] });
      enhancedFromShorthand(() => ({}));
      set({
        enhanceStatus: 'up-to-date',
        turns: scriptedTurns(8, 300),
        elapsedMs: 300_000,
        summary: { style: 'recap', status: 'done', markdown: SUMMARIES.recap, error: null },
      });
    },

    /* Two meetings started with New meeting earlier today, each with its note, after the sections. */
    manualMeetings() {
      reset('meetings');
      companions.set(JANE, JANE_NOTE());
      manualRows = manualSamples();
      syncDaily();
    },

    /* The same two, on a day whose daily note does not exist: they are still listed. */
    manualNoDaily() {
      reset('meetings');
      textarea.value = '';
      textarea.disabled = true;
      textarea.placeholder = "Today's daily note does not exist.";
      manualRows = manualSamples();
      set({ daily: { ...daily, exists: false } });
      syncDaily();
    },

    /* The folders were changed in the settings since the index was built. */
    indexFoldersPending() {
      reset('ask');
      pinJane();
      set({
        index: {
          status: 'ready',
          files: 700,
          chunks: 6412,
          done: 700,
          total: 700,
          folders: ['10 Work', '20 Areas', '40 Resources/People'],
          error: null,
          foldersPending: true,
        },
      });
    },

    indexBuilding() {
      reset('ask');
      pinJane();
      set({
        qa: { entries: [answered('When is the identity cutover planned?', null, false)], chips: [] },
        index: { status: 'building', files: 0, chunks: 0, done: 120, total: 700, folders: ['10 Work', '40 Resources/People'], error: null },
      });
      const at = epoch;
      indexTimer = every(() => {
        if (at !== epoch) return;
        const index = get().index;
        if (index.status !== 'building') return;
        const done = Math.min(index.total, index.done + 3);
        if (done < index.total) set({ index: { ...index, done } });
        else {
          stopEvery(indexTimer);
          indexTimer = null;
          set({ index: { ...index, status: 'ready', done, files: 700, chunks: 6412 } });
        }
      }, 400);
    },

    /* A build that was running when the recording started: paused, with nothing to click. */
    indexPaused() {
      midMeeting('ask');
      set({
        index: { status: 'paused', files: 0, chunks: 0, done: 120, total: 700, folders: ['10 Work', '40 Resources/People'], error: null },
      });
    },

    /* The index is usable and reported a problem: one note could not be embedded. */
    indexProblem() {
      reset('ask');
      pinJane();
      set({
        index: {
          status: 'ready',
          files: 700,
          chunks: 6412,
          done: 700,
          total: 700,
          folders: ['10 Work', '40 Resources/People'],
          error: '10 Work/Offsite.md: HTTP 500 from Ollama',
        },
      });
    },

    /* The whole vault and a folder three levels down, as the settings field accepts them. */
    indexWholeVault() {
      reset('ask');
      pinJane();
      set({
        index: { status: 'ready', files: 2026, chunks: 18558, done: 2026, total: 2026, folders: ['/', '10 Work/Projects/Alpha'], error: null },
      });
    },

    /* One line each for the setup, where Ollama runs, the recording, the damaged markers and the
       section edited by hand, all at once. */
    stackedBanners() {
      reset('notes');
      companions.set(JANE, JANE_NOTE());
      pinJane({ detachedRegions: ['transcript'], editedOutside: ['enhanced', 'summary'] });
      set({
        ollama: { status: 'ok', missingModels: [DEFAULT_SETTINGS.embedModel], remoteHost: 'ollama.lab.example' },
        recordingError: 'Microphone access was denied. Allow Obsidian in System Settings, Privacy & Security, Microphone.',
      });
    },

    withStats() {
      reset('stats');
      companions.set(JANE, JANE_NOTE());
      pinJane({ startedAt: Date.now() - 1_900_000, endedAt: Date.now() - 60_000 });
      enhancedFromShorthand(() => ({ excerptIds: ['E1'] }));
      set({
        enhanceStatus: 'up-to-date',
        turns: scriptedTurns(16, 1840),
        elapsedMs: 1_840_000,
        summary: { style: 'actions', status: 'done', markdown: SUMMARIES.actions, error: null },
        qa: { entries: [answered('Who approved the exception last year?', '12:05', true)], chips: [] },
        stats: sampleStats(),
        lastUsage: sampleUsage,
        index: { status: 'ready', files: 700, chunks: 6412, done: 700, total: 700, folders: ['10 Work', '40 Resources/People'], error: null },
      });
    },

    /* Not asked for by name, but every error surface deserves a look too. */
    errors() {
      reset('notes');
      pinJane();
      enhancedFromShorthand((item, index) => (item.kind === 'item' && index > 1 ? { bullet: null } : {}));
      const failed: QaEntry = {
        ...answered('When is the identity cutover planned?', '02:10', false),
        answer: 'The cutover is planned for',
        status: 'error',
        error: 'The model stopped answering after 60 seconds.',
      };
      set({
        stt: 'failed',
        sttMessage: 'Transcription stopped after three crashes. The recording continues without a transcript.',
        turns: scriptedTurns(4, 90),
        elapsedMs: 96_000,
        enhanceStatus: 'error',
        enhanceError: 'The model returned no text for 2 lines.',
        summary: { style: 'recap', status: 'error', markdown: '', error: 'The meeting is too long for one summary. Try Action items.' },
        qa: { entries: [failed], chips: [] },
        index: { status: 'error', files: 0, chunks: 0, done: 310, total: 700, folders: ['10 Work'], error: 'The index file could not be written: the disk is full.' },
      });
    },
  };

  textarea.value = SAMPLE_DAILY;
  syncDaily();

  return { store, controller, host: { renderMarkdown: renderMiniMarkdown }, scenarios };
}
