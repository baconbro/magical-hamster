import {
  AudioLines,
  Bug,
  CalendarDays,
  ChartNoAxesColumn,
  FileText,
  MessageCircleQuestionMark,
  NotebookPen,
  type LucideIcon,
} from 'lucide-react';
import type { TabId } from '../../types.ts';

/* Kept apart from the components that draw them: a module that exports only
   components can be hot-swapped by the dev server, a mixed one cannot. */

export const TABS: ReadonlyArray<{ id: TabId; label: string; icon: LucideIcon }> = [
  { id: 'meetings', label: 'Meetings', icon: CalendarDays },
  { id: 'notes', label: 'Notes', icon: NotebookPen },
  { id: 'summary', label: 'Summary', icon: FileText },
  { id: 'transcript', label: 'Transcript', icon: AudioLines },
  { id: 'ask', label: 'Ask', icon: MessageCircleQuestionMark },
  { id: 'stats', label: 'Stats', icon: ChartNoAxesColumn },
  { id: 'debug', label: 'Debug', icon: Bug },
];

/** The tabs shown: the Debug tab only while it is switched on. */
export function visibleTabs(debug: boolean): ReadonlyArray<(typeof TABS)[number]> {
  return debug ? TABS : TABS.filter((t) => t.id !== 'debug');
}

export function tabDomId(prefix: string, tab: TabId): string {
  return `${prefix}tab-${tab}`;
}

export function panelDomId(prefix: string, tab: TabId): string {
  return `${prefix}panel-${tab}`;
}
