import { FileInput, FileText } from 'lucide-react';
import { Button } from './ui.tsx';
import { usePending } from './usePending.ts';
import { useController, useHamster } from '../context.tsx';

/**
 * The note open in the main area, offered for the meeting when it is not the daily: type the
 * meeting there with the companion beside it, or write the whole meeting into that note.
 * Nothing when the note in front is the daily, or already holds the current meeting.
 */
export function NoteChoice({ className }: { className?: string }) {
  const controller = useController();
  const focused = useHamster((s) => s.focusedNote);
  const notePath = useHamster((s) => s.meeting?.notePath ?? null);
  const recording = useHamster((s) => s.recording !== 'idle');
  const manual = useHamster((s) => s.meeting?.manual ?? false);
  const hasMeeting = useHamster((s) => s.meeting !== null);
  /* Each waits for its action before it can be pressed again: the second
     click of a double click would open a second confirmation, since the
     write first reads the note. */
  const [using, useNote] = usePending(() => controller.useActiveNote());
  const [writing, writeInto] = usePending(() => controller.writeIntoActiveNote());
  if (!focused || focused.daily || focused.path === notePath) return null;
  // A meeting of the daily that records stays where it is: it can only move once stopped.
  const movable = !hasMeeting || manual || !recording;
  const busy = using || writing;

  return (
    <div className={className}>
      <p className="text-xs leading-snug text-muted">
        Open in front: <span className="break-all text-ink">{focused.basename}</span>
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <Button
          icon={FileText}
          disabled={!movable || busy}
          title="Your notes for this meeting are that note, or its section at the cursor. The companion note sits beside it, linked from it."
          onClick={useNote}
        >
          Use this note
        </Button>
        <Button
          variant="ghost"
          icon={FileInput}
          disabled={!movable || busy}
          title="One file: the enhanced notes, summary, answers and transcript are written into that note, below your text."
          onClick={writeInto}
        >
          Write the meeting into it
        </Button>
      </div>
    </div>
  );
}
