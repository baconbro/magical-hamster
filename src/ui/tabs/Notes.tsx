import clsx from 'clsx';
import { Check, CircleAlert, ExternalLink, FilePlus2, Link2, Sparkles } from 'lucide-react';
import { memo, useEffect, useRef } from 'react';
import type { EnhancedItem, EnhanceStatus, SectionItem } from '../../types.ts';
import { bulletMarkdown, createCompanionHint, enhancedToMarkdown, sectionKey, topicText } from '../components/format.ts';
import { fire } from '../components/fire.ts';
import { Button, CopyButton, PaneTitle, Spinner, Tag } from '../components/ui.tsx';
import { usePending } from '../components/usePending.ts';
import { useController, useHamster } from '../context.tsx';
import { Markdown } from '../Markdown.tsx';
import { NoteChoice } from '../components/NoteChoice.tsx';
import { taskMark } from '../../util/tasks.ts';

/* The actions on top, then two panes, each scrolling on its own: what was typed
   and what the model made of it. The shorthand takes the height it needs, up to
   about a third of the tab once there are enhanced notes to show next to it.
   The actions are at the top, not pinned underneath: the bottom of the right
   sidebar is where Obsidian's status bar floats. */
export function NotesTab() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <NotesActions />
      <ShorthandPane />
      <EnhancedPane />
    </div>
  );
}

function ShorthandPane() {
  const controller = useController();
  const items = useHamster((s) => s.shorthand);
  const live = useHamster((s) => s.liveEnhance);
  const hasMeeting = useHamster((s) => s.meeting !== null);
  const active = useHamster((s) => s.activeSection);
  const alone = useHamster((s) => s.enhanced.length === 0);
  const manual = useHamster((s) => s.meeting?.manual ?? false);
  const offer = !hasMeeting && active !== null ? active : null;

  return (
    <section
      aria-label="Shorthand"
      className={clsx('flex min-h-0 shrink-0 flex-col border-b border-line', alone ? 'max-h-[60%]' : 'max-h-[36%]')}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2.5 pb-1">
        <PaneTitle className="shrink-0">Shorthand</PaneTitle>
        {live && (
          <Tag>
            <span aria-hidden="true" className="mh-pulse size-1.5 rounded-full bg-brand" />
            Live
          </Tag>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2.5">
        {offer && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-line bg-surface-alt py-1 pr-1 pl-2">
            <span className="min-w-0 flex-1 truncate text-xs" title={offer.title}>
              {offer.title}
            </span>
            <Button compact onClick={() => controller.selectSection(sectionKey(offer.title, offer.ordinal))}>
              Use this section
            </Button>
          </div>
        )}
        {items.length === 0 && manual ? (
          <div className="py-2">
            <p className="text-xs leading-relaxed text-muted">
              This meeting is not tied to your notes yet. Put the cursor in a section of your daily note and link it,
              or open the note you type in and use it.
            </p>
            <Button icon={Link2} className="mt-2" onClick={() => fire(controller.linkAtCursor())}>
              Link to the section at the cursor
            </Button>
            <NoteChoice className="mt-3" />
          </div>
        ) : items.length === 0 ? (
          <div className="py-2">
            <p className="text-xs leading-relaxed text-muted">
              Type in your daily note under the meeting heading, or in the note you use for it. Lines appear here.
            </p>
            <NoteChoice className="mt-2" />
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((item) => (
              <ShorthandLine key={item.id} item={item} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const ShorthandLine = memo(function ShorthandLine({ item }: { item: SectionItem }) {
  if (item.kind === 'topic') {
    return <li className="pt-1.5 text-xs font-semibold break-words text-muted first:pt-0">{topicText(item.text)}</li>;
  }
  return <li className="break-words select-text">{item.text}</li>;
});

function EnhancedPane() {
  const items = useHamster((s) => s.enhanced);
  return (
    /* A floor of a few lines: in a short leaf the tab scrolls (see App) rather
       than squeezing the pane the tab exists for down to nothing. */
    <section aria-label="Enhanced notes" className="flex min-h-28 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2.5 pb-1">
        <PaneTitle className="shrink-0">Enhanced notes</PaneTitle>
        <EnhanceStatusLine />
      </div>
      <div data-mh-scroll="" className="min-h-0 flex-1 overflow-y-auto px-3 pb-2.5">
        {items.length === 0 ? (
          <p className="py-2 text-xs leading-relaxed text-muted">
            Nothing enhanced yet. Press Enhance, or turn on live enhance to have it done as you type.
          </p>
        ) : (
          items.map((item) => <EnhancedRow key={item.id} item={item} />)
        )}
      </div>
    </section>
  );
}

/* One row per shorthand line. Memoized on the item object: while a bullet
   streams, the session replaces that one item and only its row renders. */
const EnhancedRow = memo(function EnhancedRow({ item }: { item: EnhancedItem }) {
  const ref = useRef<HTMLDivElement>(null);
  const wasStreaming = useRef(item.streaming);

  /* Bring the row being written into view when it starts and when it ends, and
     leave the scroll alone in between: the reader may be looking elsewhere.
     Not on mount, or opening the tab would jump to the last row. */
  useEffect(() => {
    if (wasStreaming.current === item.streaming) return;
    wasStreaming.current = item.streaming;
    if (ref.current) revealInScroller(ref.current);
  }, [item.streaming]);

  if (item.kind === 'topic') {
    return <h4 className="mt-3 mb-1 text-xs font-semibold break-words text-muted first:mt-0">{topicText(item.source)}</h4>;
  }

  if (item.bullet === null) {
    return (
      <div ref={ref} className="relative mb-1.5 pl-[1.25em]">
        <Rail streaming={item.streaming} dashed />
        <p className="break-words text-muted italic">{item.source}</p>
        <span className="sr-only">{item.streaming ? 'Being enhanced' : 'Not enhanced yet'}</span>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={clsx('relative', item.stale && 'opacity-55')}
      title={item.stale ? 'The shorthand changed since this was written' : undefined}
    >
      {item.streaming && <Rail streaming />}
      <Markdown source={bulletMarkdown(`${taskMark(item.task, false)}${item.bullet}`)} />
    </div>
  );
});

/* Scrolls the pane, and only the pane, just far enough to show `el`.
   `scrollIntoView` would also move any clipped ancestor it finds in the host. */
function revealInScroller(el: HTMLElement): void {
  const scroller = el.closest<HTMLElement>('[data-mh-scroll]');
  if (!scroller) return;
  const pane = scroller.getBoundingClientRect();
  const row = el.getBoundingClientRect();
  if (row.bottom > pane.bottom) scroller.scrollTop += row.bottom - pane.bottom + 6;
  else if (row.top < pane.top) scroller.scrollTop -= pane.top - row.top + 6;
}

/** The mark in the left margin of a row that is waiting for, or receiving, its text. */
function Rail({ streaming, dashed }: { streaming: boolean; dashed?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'absolute top-1 bottom-1 -left-1.5 w-0 border-l-2',
        streaming ? 'mh-pulse border-brand' : 'border-line',
        dashed && !streaming && 'border-dashed',
      )}
    />
  );
}

const STATUS_TEXT: Record<EnhanceStatus, string> = {
  idle: '',
  evaluating: 'Evaluating notes…',
  retrieving: 'Retrieving excerpts…',
  structuring: 'Structuring notes…',
  'up-to-date': 'Up to date',
  error: '',
};

function EnhanceStatusLine() {
  const status = useHamster((s) => s.enhanceStatus);
  const error = useHamster((s) => s.enhanceError);
  const working = status === 'evaluating' || status === 'retrieving' || status === 'structuring';
  const text = status === 'error' ? (error ?? 'Enhancing failed.') : STATUS_TEXT[status];

  return (
    <p
      aria-live="polite"
      className={clsx(
        'ml-auto flex min-w-0 items-center gap-1 text-[11px]',
        status === 'error' ? 'text-danger' : 'text-muted',
      )}
    >
      {working && <Spinner small />}
      {status === 'up-to-date' && <Check className="size-3 shrink-0 text-ok" aria-hidden="true" />}
      {status === 'error' && <CircleAlert className="size-3 shrink-0" aria-hidden="true" />}
      <span className={clsx('min-w-0', status === 'error' ? 'break-words' : 'truncate')}>{text}</span>
    </p>
  );
}

function NotesActions() {
  const controller = useController();
  const hasShorthand = useHamster((s) => s.shorthand.length > 0);
  const enhanced = useHamster((s) => s.enhanced);
  const hasMeeting = useHamster((s) => s.meeting !== null);
  const companionPath = useHamster((s) => s.meeting?.companionPath ?? null);
  const saving = useHamster((s) => s.pendingWrites > 0);
  const folder = useHamster((s) => s.companionFolder);
  const manual = useHamster((s) => s.meeting?.manual ?? false);
  const notePath = useHamster((s) => s.meeting?.notePath ?? null);
  const noteName = notePath ? notePath.slice(notePath.lastIndexOf('/') + 1).replace(/\.md$/, '') : null;
  const canCopy = enhanced.some((item) => item.bullet !== null);
  const [creating, create] = usePending(() => controller.createCompanion());

  return (
    <div className="shrink-0 border-b border-line bg-surface-alt px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button icon={Sparkles} disabled={!hasShorthand} onClick={() => fire(controller.enhanceNow())}>
          Enhance
        </Button>
        <CopyButton
          iconOnly
          label="Copy the enhanced notes"
          disabled={!canCopy}
          getText={() => enhancedToMarkdown(enhanced)}
        />
        {hasMeeting && companionPath !== null && (
          <>
            <span aria-live="polite" className="ml-auto text-[11px] text-muted">
              {saving ? 'Saving…' : ''}
            </span>
            <Button icon={ExternalLink} title={companionPath} onClick={() => controller.openCompanion()}>
              Open companion
            </Button>
          </>
        )}
        {hasMeeting && companionPath === null && (
          <Button variant="primary" icon={FilePlus2} className="ml-auto" disabled={creating} onClick={create}>
            Create companion note
          </Button>
        )}
      </div>
      {hasMeeting && companionPath === null && (
        <p className="mt-1.5 text-[11px] leading-snug text-muted">{createCompanionHint(folder, manual, noteName)}</p>
      )}
    </div>
  );
}
