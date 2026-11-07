import { NoteChoice } from '../components/NoteChoice.tsx';
import clsx from 'clsx';
import { Check, FileX, Link2, Plus } from 'lucide-react';
import type { MeetingListEntry } from '../../types.ts';
import { isManualEntry, longDate, meetingsView } from '../components/format.ts';
import { fire, firstClick } from '../components/fire.ts';
import { Button, Disclosure, EmptyState, Tag } from '../components/ui.tsx';
import { useController, useHamster } from '../context.tsx';

/* The rows, "Use as meeting" and "New meeting" all leave the current meeting. When that one was
   recorded and is not saved, the session only warns the first time and takes the same request
   made again as the answer: the second click of a double click is not that answer, so each of
   them takes the first click only (`firstClick`). */
export function MeetingsTab() {
  const controller = useController();
  const daily = useHamster((s) => s.daily);
  const sections = useHamster((s) => s.sections);
  const manualTitle = useHamster((s) => (s.meeting?.manual ? s.meeting.title : null));

  const { rows, others, empty } = meetingsView(sections, daily.exists);

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{longDate(daily.date)}</h3>
        <p className="text-xs break-all text-muted">{daily.path}</p>
      </div>

      {manualTitle !== null && (
        <div className="mb-3 rounded-md border border-line bg-surface-alt p-2">
          <div className="flex items-center gap-2">
            <CurrentDot current />
            <span className="min-w-0 flex-1 truncate font-medium" title={manualTitle}>
              {manualTitle}
            </span>
            <Tag tone="plain">Not linked</Tag>
          </div>
          <p className="mt-1.5 text-xs text-muted">
            This meeting is not tied to your notes yet: a section of your daily note, or a note of its own.
          </p>
          <Button icon={Link2} block className="mt-2" onClick={() => fire(controller.linkAtCursor())}>
            Link to the section at the cursor
          </Button>
        </div>
      )}

      <NoteChoice className="mb-3 rounded-md border border-line bg-surface-alt p-2" />

      {empty === 'no-daily' && (
        <EmptyState icon={FileX} className="rounded-md border border-dashed border-line">
          <p>Today's daily note does not exist yet. Create it in Obsidian; this plugin never creates it.</p>
        </EmptyState>
      )}
      {empty === 'no-meetings' && (
        <EmptyState className="rounded-md border border-dashed border-line">
          <p>
            No meetings in today's note yet. Add a heading such as <code>### 1:1 Name</code>, or start a new meeting.
          </p>
        </EmptyState>
      )}
      {/* Also under the sentence about a missing daily: a meeting started on its own lives in its
          note, and this list is the only way back to it. */}
      {rows.length > 0 && (
        <ul aria-label="Today's meetings" className={clsx('flex flex-col gap-0.5', empty !== null && 'mt-3')}>
          {rows.map((entry) => (
            <MeetingRow key={entry.key} entry={entry} onSelect={(key) => controller.selectSection(key)} />
          ))}
        </ul>
      )}

      {others.length > 0 && (
        <Disclosure label={`Other sections (${others.length})`} className="mt-3">
          <ul className="mt-0.5 flex flex-col gap-0.5">
            {others.map((entry) => (
              <li key={entry.key} className="flex items-center gap-2 rounded-md py-0.5 pr-0.5 pl-5">
                <span className="min-w-0 flex-1 truncate text-muted" title={entry.title}>
                  {entry.title}
                </span>
                <Button variant="ghost" compact onClick={firstClick(() => controller.selectSection(entry.key))}>
                  Use as meeting
                </Button>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}

      <Button icon={Plus} block className="mt-3" onClick={firstClick(() => controller.newMeeting())}>
        New meeting
      </Button>
    </div>
  );
}

function MeetingRow({ entry, onSelect }: { entry: MeetingListEntry; onSelect: (key: string) => void }) {
  const manual = isManualEntry(entry);
  return (
    <li>
      <button
        type="button"
        aria-current={entry.current ? 'true' : undefined}
        title={manual ? 'Started with New meeting: not tied to a section of your daily note' : undefined}
        onClick={firstClick(() => onSelect(entry.key))}
        className={clsx(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover',
          entry.current && 'bg-hover',
        )}
      >
        <CurrentDot current={entry.current} />
        <span className={clsx('min-w-0 flex-1 break-words', entry.current && 'font-medium')}>{entry.title}</span>
        {entry.current && <span className="sr-only">(current meeting)</span>}
        {/* Two tags side by side leave the title a few letters in a narrow leaf: there they
            stack. A column, not a wrapping row: a row that wraps keeps the width of both. */}
        {(manual || entry.companionPath !== null) && (
          <span className="flex shrink-0 flex-col items-end gap-0.5 @[380px]:flex-row @[380px]:items-center @[380px]:gap-1">
            {manual && <Tag tone="plain">Not linked</Tag>}
            {entry.companionPath !== null && (
              <Tag>
                <Check className="size-3" aria-hidden="true" />
                Notes saved
              </Tag>
            )}
          </span>
        )}
      </button>
    </li>
  );
}

function CurrentDot({ current }: { current: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={clsx('size-2 shrink-0 rounded-full', current ? 'bg-brand' : 'border border-faint')}
    />
  );
}
