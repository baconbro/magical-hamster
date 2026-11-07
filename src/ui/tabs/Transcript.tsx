import clsx from 'clsx';
import { ArrowDown, AudioLines, Mic, Volume2 } from 'lucide-react';
import { memo } from 'react';
import type { SttSource, Turn } from '../../types.ts';
import { clock } from '../../util/text.ts';
import { STT_NOT_INSTALLED_FALLBACK, messageOr } from '../components/banner.ts';
import { int, transcriptToText } from '../components/format.ts';
import { CopyButton, EmptyState } from '../components/ui.tsx';
import { useStickToBottom } from '../components/useStickToBottom.ts';
import { useHamster } from '../context.tsx';
import { SPEECH_SETUP_COMMAND } from '../../project.ts';


/* A long meeting is thousands of turns. They are rendered in blocks so that a
   new turn reconciles one block instead of every row. */
const BLOCK = 100;

export function TranscriptTab() {
  const hasTurns = useHamster((s) => s.turns.length > 0);
  const hasPartial = useHamster((s) => s.partial !== null);
  const notInstalled = useHamster((s) => s.stt === 'not-installed');

  if (!hasTurns && !hasPartial && notInstalled) return <NotInstalled />;
  if (!hasTurns && !hasPartial) return <Waiting />;
  return <TurnsView />;
}

function NotInstalled() {
  const message = useHamster((s) => s.sttMessage);
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <EmptyState icon={AudioLines}>
        <p>{messageOr(message, STT_NOT_INSTALLED_FALLBACK)}</p>
        <div className="flex max-w-full items-center gap-1 rounded-md border border-line bg-surface-alt py-0.5 pr-0.5 pl-2">
          <code className="min-w-0 truncate text-ink select-text">{SPEECH_SETUP_COMMAND}</code>
          <CopyButton iconOnly label="Copy the setup command, to paste into Terminal" getText={() => SPEECH_SETUP_COMMAND} />
        </div>
      </EmptyState>
    </div>
  );
}

function Waiting() {
  const recording = useHamster((s) => s.recording === 'recording' || s.recording === 'starting');
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <EmptyState icon={AudioLines}>
        <p aria-live="polite">{recording ? 'Listening…' : 'Start recording to see the transcript.'}</p>
      </EmptyState>
    </div>
  );
}

function TurnsView() {
  const { scrollerRef, contentRef, onScroll, away, jumpToLatest } = useStickToBottom();
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Toolbar />
      {/* `relative`, so each row's screen-reader label is positioned inside the
          list: otherwise two thousand of them stack up outside it (see App). */}
      <div ref={scrollerRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        <div ref={contentRef}>
          <TurnList />
          <PartialRow />
        </div>
      </div>
      {away && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="mh-fade absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-surface-alt py-1 pr-2.5 pl-2 text-xs font-medium whitespace-nowrap text-ink hover:bg-hover"
        >
          <ArrowDown className="size-3.5" aria-hidden="true" />
          Jump to latest
        </button>
      )}
    </div>
  );
}

function Toolbar() {
  const turns = useHamster((s) => s.turns);
  const micLabel = useHamster((s) => s.micLabel);
  const count = turns.length;
  return (
    <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
      <p className="tnum min-w-0 flex-1 truncate text-[11px] text-muted">
        {int(count)} {count === 1 ? 'turn' : 'turns'}
      </p>
      <CopyButton label="Copy all" disabled={count === 0} getText={() => transcriptToText(turns, micLabel)} />
    </div>
  );
}

function TurnList() {
  const turns = useHamster((s) => s.turns);
  const micLabel = useHamster((s) => s.micLabel);
  const blocks: number[] = [];
  for (let start = 0; start < turns.length; start += BLOCK) blocks.push(start);
  return (
    <ol aria-label="Transcript">
      {blocks.map((start) => (
        <TurnBlock key={start} turns={turns} start={start} micLabel={micLabel} />
      ))}
    </ol>
  );
}

interface TurnBlockProps {
  turns: Turn[];
  start: number;
  micLabel: string;
}

/* The whole array is passed down, so the comparison looks only at this
   block's own stretch of it: a finished block never renders again. */
const TurnBlock = memo(
  function TurnBlock({ turns, start, micLabel }: TurnBlockProps) {
    const end = Math.min(turns.length, start + BLOCK);
    const rows = [];
    for (let i = start; i < end; i++) {
      const turn = turns[i];
      rows.push(<TurnRow key={turn.id} turn={turn} micLabel={micLabel} />);
    }
    return <>{rows}</>;
  },
  (prev, next) => {
    if (prev.start !== next.start || prev.micLabel !== next.micLabel) return false;
    if (prev.turns === next.turns) return true;
    const end = Math.min(next.turns.length, next.start + BLOCK);
    if (Math.min(prev.turns.length, prev.start + BLOCK) !== end) return false;
    for (let i = next.start; i < end; i++) {
      if (prev.turns[i] !== next.turns[i]) return false;
    }
    return true;
  },
);

const TurnRow = memo(function TurnRow({ turn, micLabel }: { turn: Turn; micLabel: string }) {
  return (
    <li className="flex items-baseline gap-2 py-1">
      <Channel source={turn.source} micLabel={micLabel} />
      <span className="tnum min-w-[2.1rem] shrink-0 text-[11px] text-muted">{clock(turn.t0)}</span>
      <p lang={turn.lang} className="min-w-0 flex-1 break-words select-text">
        {turn.text}
      </p>
    </li>
  );
});

function Channel({ source, micLabel, muted }: { source: SttSource; micLabel: string; muted?: boolean }) {
  const Icon = source === 'mic' ? Mic : Volume2;
  const label = source === 'mic' ? micLabel : 'Others';
  return (
    <span title={label} className={clsx('mt-[3px] shrink-0 self-start', muted ? 'text-faint' : source === 'mic' ? 'text-ink' : 'text-muted')}>
      <Icon className="size-3.5" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** What is being said right now. It changes several times a second and is the only thing that renders when it does. */
function PartialRow() {
  const partial = useHamster((s) => s.partial);
  const micLabel = useHamster((s) => s.micLabel);
  /* The time column is as wide as the times above it ("12:34", then "1:02:34"
     past the hour): an unseen copy of the latest one keeps the text aligned. */
  const lastStart = useHamster((s) => s.turns[s.turns.length - 1]?.t0 ?? 0);
  if (!partial) return null;
  return (
    <div className="flex items-baseline gap-2 py-1">
      <Channel source={partial.source} micLabel={micLabel} muted />
      <span aria-hidden="true" className="tnum relative min-w-[2.1rem] shrink-0 text-[11px] text-faint">
        <span className="invisible">{clock(lastStart)}</span>
        <span className="mh-pulse absolute inset-0">…</span>
      </span>
      <p className="min-w-0 flex-1 break-words text-muted italic">{partial.text}</p>
    </div>
  );
}
