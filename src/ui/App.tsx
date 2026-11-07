import { useEffect, useId, type JSX } from 'react';
import type { TabId } from '../types.ts';
import { Banner } from './components/Banner.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { Header } from './components/Header.tsx';
import { TabBar } from './components/TabBar.tsx';
import { panelDomId, TABS, tabDomId } from './components/tabList.ts';
import { useController, useDebugOn, useHamster } from './context.tsx';
import { AskTab } from './tabs/Ask.tsx';
import { DebugTab } from './tabs/Debug.tsx';
import { MeetingsTab } from './tabs/Meetings.tsx';
import { NotesTab } from './tabs/Notes.tsx';
import { StatsTab } from './tabs/Stats.tsx';
import { SummaryTab } from './tabs/Summary.tsx';
import { TranscriptTab } from './tabs/Transcript.tsx';

const PANELS: Record<TabId, () => JSX.Element> = {
  meetings: MeetingsTab,
  notes: NotesTab,
  summary: SummaryTab,
  transcript: TranscriptTab,
  ask: AskTab,
  stats: StatsTab,
  debug: DebugTab,
};

/**
 * The sidebar: a fixed header, an optional banner, the tabs, and one body that
 * scrolls. `@container` lets the pieces adapt to the leaf's width (280 to
 * 460 px), which the window's width says nothing about.
 */
export function App() {
  const controller = useController();
  const chosen = useHamster((s) => s.tab);
  const debugOn = useDebugOn();
  // The Debug tab switched off while on screen: back to the notes.
  const tab = chosen === 'debug' && !debugOn ? 'notes' : chosen;
  useEffect(() => {
    if (chosen === 'debug' && !debugOn) controller.setTab('notes');
  }, [chosen, debugOn, controller]);
  const idPrefix = useId();
  const Panel = PANELS[tab];
  const name = TABS.find((t) => t.id === tab)?.label ?? tab;

  return (
    /* `relative`: the screen-reader-only texts are absolutely positioned, and
       without a positioned box of ours around them they are laid out against
       the host page and can make it scroll. For the same reason every scrolling
       list that holds such a text is `relative` itself, so the text scrolls and
       is clipped with its row. */
    /* The bottom padding keeps clear of Obsidian's status bar, which floats over the bottom of
       the right sidebar (`--mh-bottom-inset`, see inset.ts). */
    <div className="@container relative flex h-full min-w-0 flex-col overflow-hidden bg-surface pb-[var(--mh-bottom-inset,0px)] text-ink">
      <Header />
      <Banner />
      <TabBar idPrefix={idPrefix} />
      {/* Each tab fits itself to this box and scrolls inside. The box scrolls
          too, as a last resort: in a short leaf the pinned parts of a tab (an
          input, a row of buttons) can be taller than what is left, and without
          this they would be cut off with no way to reach them. Keyed by tab so
          that one tab's scroll offset is not handed to the next, and so that a
          tab that threw is drawn afresh when it is chosen again. */}
      <div
        key={tab}
        role="tabpanel"
        id={panelDomId(idPrefix, tab)}
        aria-labelledby={tabDomId(idPrefix, tab)}
        className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
      >
        {/* A tab that throws is said to, here, under a tab bar that still works: the others stay
            reachable, and the session is not touched. */}
        <ErrorBoundary label={`The ${name} tab`}>
          <Panel />
        </ErrorBoundary>
      </div>
    </div>
  );
}
