import clsx from 'clsx';
import {
  ArrowUp,
  BookmarkCheck,
  BookmarkPlus,
  Check,
  CircleAlert,
  FolderTree,
  MessageCircleQuestionMark,
  TriangleAlert,
  X,
} from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useRef, useState, type SubmitEvent, type KeyboardEvent } from 'react';
import type { QaEntry, QuestionChip, SourceDoc } from '../../types.ts';
import { fire } from '../components/fire.ts';
import {
  ANSWER_SOURCES_TEXT,
  INDEX_SCOPE_TEXT,
  WHOLE_VAULT,
  coveredByAncestor,
  folderLabel,
  foldersToBuild,
  indexBuildBlocked,
  indexBuildLabel,
  indexFoldersNote,
  indexProblem,
  indexSummary,
  int,
  openPicker,
  pickerOutdated,
  sourceLabel,
  toggleFolder,
  type FolderRow,
  type PickerState,
} from '../components/format.ts';
import { Button, CopyButton, Disclosure, EmptyState, IconButton, Spinner } from '../components/ui.tsx';
import { useStickToBottom } from '../components/useStickToBottom.ts';
import { useController, useHamster, useKept } from '../context.tsx';
import { Markdown } from '../Markdown.tsx';

/* Top to bottom: the index (folded to one line once it exists), the answers
   (newest last, so they scroll like a conversation), the questions heard in
   the meeting, and the input. Only the answers scroll. */
export function AskTab() {
  const { scrollerRef, contentRef, onScroll, jumpToLatest } = useStickToBottom();
  const count = useHamster((s) => s.qa.entries.length);
  const shown = useRef(count);

  /* A question that was just asked has to be seen. Without this, asking while
     scrolled up to an older answer clears the input and shows nothing new. */
  useLayoutEffect(() => {
    if (count > shown.current) jumpToLatest();
    shown.current = count;
  }, [count, jumpToLatest]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <IndexBlock />
      {/* The floor keeps a few lines of the answers on screen when a short leaf
          and an open index block leave them nothing; the tab then scrolls. */}
      <div ref={scrollerRef} onScroll={onScroll} className="relative min-h-24 flex-1 overflow-y-auto">
        <div ref={contentRef} className="px-3 py-2.5">
          <Entries />
        </div>
      </div>
      <Chips />
      <Composer />
    </div>
  );
}

/* ───────────────────────── Detected questions ───────────────────────── */

function Chips() {
  const controller = useController();
  const chips = useHamster((s) => s.qa.chips);
  if (chips.length === 0) return null;
  return (
    <section
      aria-label="Questions heard in the meeting"
      className="max-h-[30%] shrink-0 overflow-y-auto border-t border-line px-3 pt-1.5 pb-2"
    >
      <p className="mb-1 text-[11px] text-muted">Heard in the meeting</p>
      <ul className="flex flex-col gap-1">
        {chips.map((chip) => (
          <ChipRow
            key={chip.id}
            chip={chip}
            onAsk={() => fire(controller.ask(chip.text, chip.id))}
            onDismiss={() => controller.dismissChip(chip.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function ChipRow({ chip, onAsk, onDismiss }: { chip: QuestionChip; onAsk: () => void; onDismiss: () => void }) {
  return (
    <li className="mh-fade flex items-stretch rounded-md bg-chip text-ink">
      <button
        type="button"
        onClick={onAsk}
        title="Ask this question"
        className="group flex min-w-0 flex-1 items-baseline gap-2 rounded-md py-1 pr-1 pl-2 text-left text-xs"
      >
        <span className="min-w-0 flex-1 break-words group-hover:underline">{chip.text}</span>
        <span className="tnum shrink-0 text-[11px] text-muted">{chip.time}</span>
      </button>
      <IconButton icon={X} label="Dismiss this question" onClick={onDismiss} className="m-0.5 self-center" />
    </li>
  );
}

/* ───────────────────────────── Answers ──────────────────────────────── */

function Entries() {
  const controller = useController();
  const entries = useHamster((s) => s.qa.entries);
  const hasCompanion = useHamster((s) => Boolean(s.meeting?.companionPath));

  if (entries.length === 0) {
    return (
      <EmptyState icon={MessageCircleQuestionMark}>
        <p>{ANSWER_SOURCES_TEXT}</p>
      </EmptyState>
    );
  }
  return (
    <ol aria-label="Questions and answers" className="flex flex-col gap-3">
      {entries.map((entry) => (
        <EntryCard
          key={entry.id}
          entry={entry}
          canKeep={hasCompanion}
          onCancel={(id) => controller.cancelAsk(id)}
          onKeep={(id) => fire(controller.keepInsight(id))}
        />
      ))}
    </ol>
  );
}

interface EntryCardProps {
  entry: QaEntry;
  canKeep: boolean;
  onCancel: (id: string) => void;
  onKeep: (id: string) => void;
}

/* Memoized on the entry object: a streaming answer replaces one entry, and the
   others keep their rendered Markdown. The callbacks are new functions on every
   render but always do the same thing (they close over the controller only),
   so the comparison leaves them out. */
const EntryCard = memo(
  function EntryCard({ entry, canKeep, onCancel, onKeep }: EntryCardProps) {
    const running = entry.status === 'running';
    return (
      <li className="rounded-md border border-line">
        <div className="flex items-start gap-2 border-b border-line bg-surface-alt px-2 py-1.5">
          <p className="min-w-0 flex-1 font-medium break-words select-text">{entry.question}</p>
          {entry.meetingTime !== null && (
            <span className="tnum mt-0.5 shrink-0 text-[11px] text-muted" title="Time in the meeting when this was asked">
              {entry.meetingTime}
            </span>
          )}
        </div>

        <div className="px-2 py-1.5">
          {entry.answer !== '' && <Markdown source={entry.answer} />}
          {running && entry.answer === '' && (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <Spinner small />
              Looking through your notes…
            </p>
          )}
          {entry.status === 'error' && (
            <p role="alert" className={clsx('flex items-start gap-1.5 text-xs text-danger', entry.answer !== '' && 'mt-1.5')}>
              <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">{entry.error ?? 'The answer could not be written.'}</span>
            </p>
          )}

          {entry.sources.length > 0 && <Sources sources={entry.sources} />}

          {running && (
            <div className="mt-2 flex items-center gap-1.5">
              <Button icon={X} onClick={() => onCancel(entry.id)}>
                Cancel
              </Button>
            </div>
          )}
          {entry.status === 'done' && (
            <div className="mt-2 flex items-center gap-1.5">
              <Button
                icon={entry.kept ? BookmarkCheck : BookmarkPlus}
                disabled={entry.kept || !canKeep}
                title={
                  entry.kept
                    ? 'Saved to the companion note'
                    : canKeep
                      ? 'Save this answer to the companion note'
                      : 'Create the companion note first'
                }
                onClick={() => onKeep(entry.id)}
              >
                {entry.kept ? 'Kept' : 'Keep'}
              </Button>
              <CopyButton iconOnly label="Copy the answer" getText={() => entry.answer} />
            </div>
          )}
          <span className="sr-only" aria-live="polite">
            {running ? 'Answering' : entry.status === 'done' ? 'Answer ready' : ''}
          </span>
        </div>
      </li>
    );
  },
  (prev, next) => prev.entry === next.entry && prev.canKeep === next.canKeep,
);

function Sources({ sources }: { sources: SourceDoc[] }) {
  return (
    <ul aria-label="Sources" className="mt-2 flex flex-wrap gap-1">
      {sources.map((src) => (
        <li
          key={src.n}
          title={src.path ?? sourceLabel(src)}
          className="inline-flex max-w-full items-baseline gap-1 rounded-full border border-line px-1.5 py-px text-[11px] leading-4 text-muted"
        >
          <span className="tnum shrink-0 font-semibold text-ink">{src.n}</span>
          <span className="min-w-0 truncate">{sourceLabel(src)}</span>
        </li>
      ))}
    </ul>
  );
}

/* ───────────────────────────── Composer ─────────────────────────────── */

function Composer() {
  const controller = useController();
  /* Kept above the tab: a question half typed is still there after a look at the transcript,
     and after the sidebar moved to the summary by itself. */
  const [text, setText] = useKept('ask.question', '');
  const empty = text.trim() === '';

  const send = () => {
    const question = text.trim();
    if (question === '') return;
    setText('');
    fire(controller.ask(question));
  };

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    /* Enter while an input method is composing confirms the composition; it is not a send. */
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  return (
    <form onSubmit={onSubmit} className="flex shrink-0 items-end gap-1.5 border-t border-line bg-surface-alt px-3 py-2">
      <textarea
        rows={1}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Question"
        placeholder="Ask about this meeting or your notes"
        className="max-h-28 min-h-7 min-w-0 flex-1 resize-none rounded-md border border-line bg-surface px-2 py-1 text-ink [field-sizing:content] focus:shadow-none"
      />
      <button
        type="submit"
        disabled={empty}
        aria-label="Send"
        title="Send"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-brand text-on-brand transition-colors hover:bg-brand-hover disabled:opacity-40 disabled:hover:bg-brand"
      >
        <ArrowUp className="size-4" aria-hidden="true" />
      </button>
    </form>
  );
}

/* ─────────────────────────── Knowledge index ────────────────────────── */

function IndexBlock() {
  const controller = useController();
  const index = useHamster((s) => s.index);
  /* Kept above the tab, like the question: folders ticked and not yet built are not lost to a
     look at another tab. */
  const [kept, setPicker] = useKept<PickerState | null>('ask.folders', null);
  /* A picker left open while the list is changed in the settings still holds the ticks of the
     list it was opened from, and the button under "Rebuild the index to apply" would build those
     and save them over the new list. Such a picker is closed, and counts as closed from the very
     render that sees the new list: the button then builds the list of the settings. */
  const outdated = kept !== null && pickerOutdated(kept, index.folders);
  const picker = outdated ? null : kept;
  useEffect(() => {
    if (outdated) setPicker(null);
  }, [outdated, setPicker]);
  const picking = picker !== null;
  const building = index.status === 'building';
  const progress = index.total > 0 ? Math.min(1, index.done / index.total) : 0;
  const problem = indexProblem(index);
  const foldersNote = indexFoldersNote(index);
  const buildLabel = indexBuildLabel(index.status);
  /* Decided once, when the tab opens: open while there is something to do or
     to read (no index yet, a failure, folders being chosen, folders changed in
     the settings and not built yet), and it does not fold away under the user
     when the build starts. */
  const [startOpen] = useState(index.status === 'none' || index.status === 'error' || picking || foldersNote !== null);

  const open = () => setPicker(openPicker(controller.listFolders(), index.folders));

  const toggle = (folder: string) => {
    if (picker) setPicker(toggleFolder(picker, folder));
  };

  const chosen = foldersToBuild(picker, index.folders);
  const blocked = indexBuildBlocked(chosen);

  const build = () => {
    setPicker(null);
    fire(controller.buildIndex(chosen));
  };

  return (
    <section
      aria-label="Knowledge index"
      className="flex max-h-[70%] shrink-0 flex-col overflow-y-auto border-b border-line px-3 py-1"
    >
      {/* A flex column all the way down, so that in a short pane the folder
          list gives up height before the buttons under it are pushed out. */}
      <Disclosure
        className="flex min-h-0 flex-col"
        bodyClassName="flex min-h-0 flex-col"
        defaultOpen={startOpen}
        label="Knowledge index"
        aside={
          <>
            {/* The index works, and something went wrong with it or waits to be done: seen
                without unfolding. */}
            {(problem !== null || foldersNote !== null) && (
              <TriangleAlert
                className="size-3.5 shrink-0 text-warn"
                aria-label={problem !== null ? 'The index reported a problem' : 'Folders changed in settings'}
              />
            )}
            {building ? (
              <span className="tnum shrink-0 text-[11px] text-muted">{Math.round(progress * 100)}%</span>
            ) : index.status === 'ready' ? (
              <span className="tnum shrink-0 text-[11px] text-muted">{int(index.files)} notes</span>
            ) : index.status === 'paused' ? (
              <span className="shrink-0 text-[11px] text-muted">paused</span>
            ) : index.status === 'error' ? (
              <CircleAlert className="size-3.5 shrink-0 text-danger" aria-label="Index error" />
            ) : null}
          </>
        }
      >
        <div className="flex min-h-0 flex-col gap-2 pt-1 pb-1.5">
          <div aria-live="polite" className="flex shrink-0 flex-col gap-1">
            {/* The counts of an index the settings have outgrown would say "ready" about notes
                that are no longer answered from. */}
            {index.modelPending === true ? (
              <p className="flex items-start gap-1.5 text-xs text-ink">
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" aria-hidden="true" />
                <span className="min-w-0 break-words">
                  Built with another embedding model. Rebuild the index to search with the current one.
                </span>
              </p>
            ) : (
              <p className={clsx('text-xs break-words', index.status === 'error' ? 'text-danger' : 'text-ink')}>
                {indexSummary(index)}
              </p>
            )}
            {/* A note that was skipped, an index that could not be saved: the build still ends
                "ready", and this line is the only place that says it. */}
            {problem !== null && (
              <p className="flex items-start gap-1.5 text-xs text-ink">
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" aria-hidden="true" />
                <span className="min-w-0 break-words">Last problem: {problem}</span>
              </p>
            )}
          </div>

          {building && (
            <div className="flex shrink-0 items-center gap-2">
              <div
                role="progressbar"
                aria-label="Indexing progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
                className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line"
              >
                <div className="h-full rounded-full bg-brand transition-[width] duration-200" style={{ width: `${progress * 100}%` }} />
              </div>
              <Button compact onClick={() => controller.cancelIndex()}>
                Cancel
              </Button>
            </div>
          )}

          {!picking && index.folders.length > 0 && (
            <p className="shrink-0 text-[11px] break-words text-muted">
              Folders: {index.folders.map(folderLabel).join(', ')}
            </p>
          )}

          {picker && <FolderPicker rows={picker.rows} selected={picker.selected} onToggle={toggle} />}

          {/* The index still answers from the folders of its last build: said right above the
              button that applies the new list, and only while that button is there. */}
          {foldersNote !== null && (
            <p className="flex shrink-0 items-start gap-1.5 text-xs text-ink">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" aria-hidden="true" />
              <span className="min-w-0 break-words">{foldersNote}</span>
            </p>
          )}

          {!building && (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <Button icon={FolderTree} aria-expanded={picking} onClick={picking ? () => setPicker(null) : open}>
                {picking ? 'Close folders' : 'Choose folders'}
              </Button>
              {/* Not while a recording has paused a build: the session would refuse, and it
                  takes the build up again by itself. */}
              {buildLabel !== null && (
                <Button variant="primary" disabled={blocked !== null} title={blocked ?? undefined} onClick={build}>
                  {buildLabel}
                </Button>
              )}
            </div>
          )}

          <p className="shrink-0 text-[11px] leading-snug text-muted">{INDEX_SCOPE_TEXT}</p>
        </div>
      </Disclosure>
    </section>
  );
}

interface FolderPickerProps {
  rows: FolderRow[];
  selected: ReadonlySet<string>;
  onToggle: (folder: string) => void;
}

function FolderPicker({ rows, selected, onToggle }: FolderPickerProps) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted">This vault has no folders.</p>;
  }
  const wholeVault = selected.has(WHOLE_VAULT);
  return (
    <ul
      aria-label="Folders to index"
      className="max-h-56 min-h-16 shrink overflow-y-auto rounded-md border border-line bg-surface-alt py-1"
    >
      {rows.map((row) => {
        const name = folderLabel(row.path);
        const inherited = coveredByAncestor(row.path, selected);
        const checked = inherited || selected.has(row.path);
        return (
          <li key={row.path}>
            {/* A button with the checkbox role, not an <input>: Obsidian restyles
                native checkboxes with rules the scoped reset cannot outrank. */}
            <button
              type="button"
              role="checkbox"
              aria-checked={checked}
              aria-label={name}
              disabled={inherited}
              title={
                inherited ? `${name} (included with ${wholeVault ? 'the whole vault' : 'its parent folder'})` : name
              }
              style={{ paddingLeft: `${0.5 + row.depth * 1.1}rem` }}
              onClick={() => onToggle(row.path)}
              className={clsx(
                '-outline-offset-2 flex w-full items-center gap-2 py-0.5 pr-2 text-left text-xs',
                inherited ? 'text-muted' : 'hover:bg-hover',
              )}
            >
              <span
                aria-hidden="true"
                className={clsx(
                  'flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border',
                  checked ? 'border-brand bg-brand text-on-brand' : 'border-faint bg-surface',
                  inherited && 'opacity-60',
                )}
              >
                {checked && <Check className="size-3" strokeWidth={3} />}
              </span>
              <span className="min-w-0 truncate">{row.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
