import { CircleAlert, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SummaryStyle } from '../../types.ts';
import { fire } from '../components/fire.ts';
import { Button, CopyButton, PaneTitle, Segmented, Spinner } from '../components/ui.tsx';
import { useController, useHamster } from '../context.tsx';
import { Markdown } from '../Markdown.tsx';

const STYLES: ReadonlyArray<{ value: SummaryStyle; label: string; title: string; hint: string }> = [
  {
    value: 'executive',
    label: 'Executive',
    title: 'Executive summary',
    hint: 'The decisions, the risks and what happens next, in a few lines.',
  },
  {
    value: 'recap',
    label: 'Recap',
    title: 'Recap',
    hint: 'What was discussed, topic by topic, in the order it came up.',
  },
  {
    value: 'actions',
    label: 'Action items',
    title: 'Action items',
    hint: 'Who does what, with dates when they were mentioned.',
  },
];

function styleOf(value: SummaryStyle) {
  return STYLES.find((s) => s.value === value) ?? STYLES[0];
}

export function SummaryTab() {
  const controller = useController();
  const summary = useHamster((s) => s.summary);
  const hasMaterial = useHamster((s) => s.turns.length > 0 || s.shorthand.length > 0);

  /* The state only records the style of the last summary; which one to ask
     for next is the user's pick here, until a summary is produced elsewhere. */
  const [style, setStyle] = useState<SummaryStyle>(summary.style);
  useEffect(() => setStyle(summary.style), [summary.style]);

  const running = summary.status === 'running';
  const hasText = summary.markdown.trim() !== '';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-line px-3 py-2.5">
        <Segmented label="Summary style" value={style} options={STYLES} onChange={setStyle} disabled={running} />
        <div className="flex items-center gap-2">
          {running ? (
            <Button icon={X} onClick={() => controller.cancelSummary()}>
              Cancel
            </Button>
          ) : (
            <Button variant="primary" icon={Sparkles} onClick={() => fire(controller.summarize(style))}>
              Summarize
            </Button>
          )}
          <p aria-live="polite" className="flex min-w-0 items-center gap-1 text-[11px] text-muted">
            {running && (
              <>
                <Spinner small />
                <span className="truncate">Summarizing…</span>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        {summary.status === 'error' && (
          <p role="alert" className="mb-2 flex items-start gap-1.5 text-xs text-danger">
            <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{summary.error ?? 'The summary could not be written.'}</span>
          </p>
        )}

        {/* Text is shown whenever there is some and no error replaced it: a
            run that was cancelled may leave what it wrote so far with the
            status back at idle, and a blank tab would hide it. */}
        {hasText && summary.status !== 'error' && (
          <>
            <div className="mb-1.5 flex items-center gap-2">
              <PaneTitle className="min-w-0 flex-1 truncate">{styleOf(summary.style).title}</PaneTitle>
              {!running && <CopyButton iconOnly label="Copy the summary" getText={() => summary.markdown} />}
            </div>
            <Markdown source={summary.markdown} />
          </>
        )}

        {!hasText && !running && summary.status !== 'error' && (
          <p className="py-2 text-xs leading-relaxed text-muted">
            {hasMaterial ? styleOf(style).hint : 'Record or take notes first.'}
          </p>
        )}
      </div>
    </div>
  );
}
