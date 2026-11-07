import clsx from 'clsx';
import { ChevronDown, Mic, Plus, Square } from 'lucide-react';
import type { EnhanceStyle } from '../../types.ts';
import { useController, useHamster } from '../context.tsx';
import { levelBars, timer } from './format.ts';
import { fire, firstClick } from './fire.ts';
import { Button, Spinner, Switch } from './ui.tsx';

/* Each moving part reads its own slice of state: the timer ticks every second
   and the meter several times a second, and neither should repaint the rest. */

export function Header() {
  return (
    <header className="shrink-0 px-3 pt-2.5 pb-2">
      {/* Wraps only when the title refuses to shrink, which it does only when
          there is no meeting: then the buttons drop under it in a very narrow
          pane instead of cutting the one sentence that says what to do. */}
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1.5">
        <RecordStatus />
        <Title />
        <RecordActions />
      </div>
      <div className="mt-1.5 flex min-h-6 items-center gap-3">
        <LevelMeter />
        <div className="ml-auto flex min-w-0 items-center gap-3">
          <LiveEnhanceSwitch />
          <StyleMenu />
        </div>
      </div>
    </header>
  );
}

function RecordStatus() {
  const hasMeeting = useHamster((s) => s.meeting !== null);
  const recording = useHamster((s) => s.recording);
  const everRan = useHamster((s) => s.elapsedMs > 0);
  if (!hasMeeting) return null;

  const live = recording === 'recording';
  const showTimer = recording !== 'idle' || everRan;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span
        aria-hidden="true"
        className={clsx('size-2 rounded-full', live ? 'mh-pulse bg-danger' : 'bg-faint')}
      />
      <span className="sr-only" aria-live="polite">
        {live ? 'Recording' : recording === 'starting' ? 'Starting the recording' : ''}
      </span>
      {showTimer && <Timer />}
    </div>
  );
}

function Timer() {
  const elapsedMs = useHamster((s) => s.elapsedMs);
  return (
    <span role="timer" aria-label="Recording time" className="tnum text-xs text-muted">
      {timer(elapsedMs)}
    </span>
  );
}

function Title() {
  const title = useHamster((s) => s.meeting?.title ?? null);
  return (
    <h2
      title={title ?? undefined}
      className={clsx(
        'flex-1 leading-tight font-semibold',
        title === null ? 'min-w-max text-muted' : 'line-clamp-2 min-w-0 text-sm break-words',
      )}
    >
      {title ?? 'No meeting selected'}
    </h2>
  );
}

function RecordActions() {
  const controller = useController();
  const hasMeeting = useHamster((s) => s.meeting !== null);
  const recording = useHamster((s) => s.recording);

  if (!hasMeeting) {
    return (
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {/* Takes the place of End under the pointer once a meeting has ended: the second click of
            a double click on End lands here, and must not start a meeting nobody asked for. */}
        <Button variant="primary" onClick={firstClick(() => controller.newMeeting())}>
          <Plus className="hidden size-3.5 shrink-0 @[340px]:block" aria-hidden="true" />
          New meeting
        </Button>
        <Button
          variant="secondary"
          icon={Mic}
          disabled
          aria-label="Start recording"
          title="Select or start a meeting first"
          compact
        >
          <span className="hidden @[400px]:inline">Start</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {/* Pressed a second time, End discards a recorded meeting that is not saved: a double click
          is one press, not two. */}
      {recording === 'idle' && (
        <Button
          variant="ghost"
          aria-label="End meeting"
          title="End this meeting and clear the panel"
          onClick={firstClick(() => fire(controller.endMeeting()))}
          compact
        >
          End
        </Button>
      )}
      {recording === 'idle' && (
        <Button
          variant="primary"
          icon={Mic}
          aria-label="Start recording"
          title="Start recording"
          onClick={() => fire(controller.startRecording())}
        >
          <span>
            Start<span className="hidden @[400px]:inline"> recording</span>
          </span>
        </Button>
      )}
      {/* Loading the speech model takes seconds, and waiting for a microphone prompt can take
          for ever: the start can be called off. The spinner says that it is still under way.
          This button takes the place of Start under the pointer: the second click of a double
          click on Start lands here, and must not call off what the first one began. */}
      {recording === 'starting' && (
        <Button
          variant="primary"
          aria-label="Cancel the recording start"
          title="Cancel the recording start"
          onClick={firstClick(() => fire(controller.stopRecording()))}
        >
          <Spinner />
          Cancel
        </Button>
      )}
      {recording === 'recording' && (
        <Button
          variant="danger"
          icon={Square}
          aria-label="Stop recording"
          title="Stop recording"
          onClick={() => fire(controller.stopRecording())}
        >
          Stop
        </Button>
      )}
      {recording === 'stopping' && (
        <Button variant="danger" disabled>
          <Spinner />
          Stopping…
        </Button>
      )}
    </div>
  );
}

/* The bars rise left to right. Whole class names, so that the stylesheet builder finds them. */
const BAR_HEIGHTS = ['h-[40%]', 'h-[55%]', 'h-[70%]', 'h-[85%]', 'h-full'];

function LevelMeter() {
  const recording = useHamster((s) => s.recording === 'recording');
  if (!recording) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <LevelBars />
      {/* At the narrowest sidebar the row has no room for the word; the bars carry their own label. */}
      <span aria-hidden="true" className="hidden text-[11px] text-muted @[300px]:inline">
        mic
      </span>
    </div>
  );
}

function LevelBars() {
  const level = useHamster((s) => s.micLevel);
  const clamped = Math.min(1, Math.max(0, level));
  const lit = levelBars(clamped);
  return (
    <div
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className="flex h-3.5 items-end gap-0.5"
    >
      {BAR_HEIGHTS.map((height, i) => (
        <span
          key={height}
          className={clsx('w-[3px] rounded-full transition-colors duration-100', height, i < lit ? 'bg-ok' : 'bg-line')}
        />
      ))}
    </div>
  );
}

function LiveEnhanceSwitch() {
  const controller = useController();
  const on = useHamster((s) => s.liveEnhance);
  return (
    <Switch
      checked={on}
      onChange={(next) => controller.setLiveEnhance(next)}
      label="Live enhance"
      title="Enhance your notes as you type"
    />
  );
}

function StyleMenu() {
  const controller = useController();
  const style = useHamster((s) => s.enhanceStyle);
  return (
    <span className="relative inline-flex shrink-0 items-center">
      <select
        aria-label="Enhance style"
        title="Enhance style"
        value={style}
        onChange={(event) => controller.setEnhanceStyle(event.target.value as EnhanceStyle)}
        className="h-6 cursor-pointer appearance-none rounded-md border border-line bg-surface pr-6 pl-2 text-xs text-ink hover:bg-hover focus:shadow-none"
      >
        <option value="standard">Standard</option>
        <option value="concise">Concise</option>
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 size-3.5 text-muted" aria-hidden="true" />
    </span>
  );
}
