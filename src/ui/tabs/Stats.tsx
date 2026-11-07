import clsx from 'clsx';
import { useState, type ReactNode } from 'react';
import type { ChatUsage } from '../../types.ts';
import {
  compact,
  dollars,
  int,
  savedDollars,
  usageFigures,
  weeklySeries,
  type WeekPoint,
} from '../components/format.ts';
import { PaneTitle } from '../components/ui.tsx';
import { useHamster } from '../context.tsx';

export function StatsTab() {
  const stats = useHamster((s) => s.stats);
  const costPer1k = useHamster((s) => s.costPer1k);
  const today = useHamster((s) => s.daily.date);
  const lastUsage = useHamster((s) => s.lastUsage);

  const total = stats.input + stats.output;
  const weeks = weeklySeries(stats.weekly, today, 8);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2">
          <Tile label="Tokens processed on this computer" value={int(total)} className="col-span-2">
            <span className="tnum">
              {int(stats.input)} in, {int(stats.output)} out
            </span>
          </Tile>
          <Tile
            label="Saved"
            value={dollars(savedDollars(stats, costPer1k))}
            title={`At $${costPer1k} per 1,000 tokens`}
          >
            compared with a cloud model
          </Tile>
          <Tile label="Meetings transcribed" value={int(stats.meetings)}>
            <span className="tnum">
              {int(stats.assists)} {stats.assists === 1 ? 'assist' : 'assists'}
            </span>
          </Tile>
        </div>

        <WeeklyChart weeks={weeks} />

        {lastUsage !== null && <LastRequest usage={lastUsage} />}
      </div>
    </div>
  );
}

interface TileProps {
  label: string;
  value: string;
  title?: string;
  className?: string;
  children?: ReactNode;
}

function Tile({ label, value, title, className, children }: TileProps) {
  return (
    <div title={title} className={clsx('min-w-0 rounded-md border border-line bg-surface-alt px-2.5 py-2', className)}>
      <p className="truncate text-[11px] text-muted" title={label}>
        {label}
      </p>
      <p className="tnum truncate text-lg leading-tight font-semibold">{value}</p>
      {children !== undefined && <p className="mt-0.5 text-[11px] leading-snug text-muted">{children}</p>}
    </div>
  );
}

/* One series, one hue: bars of total tokens per ISO week, oldest on the left.
   The numbers are in the list as text, so the picture is not the only way in. */
function WeeklyChart({ weeks }: { weeks: WeekPoint[] }) {
  const [focus, setFocus] = useState<string | null>(null);
  const max = Math.max(0, ...weeks.map((w) => w.total));
  const shown = weeks.find((w) => w.key === focus) ?? null;

  return (
    <section aria-label="Tokens per week, last 8 weeks">
      <div className="mb-1.5 flex items-baseline gap-2">
        <PaneTitle className="shrink-0">Last 8 weeks</PaneTitle>
        <p className="tnum ml-auto min-w-0 truncate text-[11px] text-muted" aria-live="polite">
          {shown
            ? `Week of ${shown.month} ${shown.day}: ${int(shown.input)} in, ${int(shown.output)} out`
            : max === 0
              ? 'No tokens yet'
              : 'Tokens per week'}
        </p>
      </div>
      <ol className="flex h-28 items-stretch" onMouseLeave={() => setFocus(null)}>
        {weeks.map((week, index) => {
          const share = max > 0 ? week.total / max : 0;
          const monthChanges = index === 0 || weeks[index - 1]?.month !== week.month;
          return (
            <li
              key={week.key}
              tabIndex={0}
              aria-label={`Week of ${week.month} ${week.day}: ${int(week.total)} tokens`}
              onMouseEnter={() => setFocus(week.key)}
              onFocus={() => setFocus(week.key)}
              onBlur={() => setFocus(null)}
              className="-outline-offset-1 flex min-w-0 flex-1 flex-col items-center rounded-sm"
            >
              <span aria-hidden="true" className="tnum h-4 text-[10px] leading-4 text-muted">
                {week.total > 0 ? compact(week.total) : ''}
              </span>
              <span aria-hidden="true" className="flex min-h-0 w-full flex-1 items-end justify-center border-b border-line">
                <span
                  style={{ height: week.total > 0 ? `max(2px, ${share * 100}%)` : '0' }}
                  className={clsx(
                    'w-full max-w-5 rounded-t-[4px] transition-[height] duration-200',
                    focus === week.key ? 'bg-brand-hover' : 'bg-brand',
                  )}
                />
              </span>
              <span aria-hidden="true" className="tnum mt-1 text-[10px] leading-3 text-ink">
                {week.day}
              </span>
              <span aria-hidden="true" className="h-3 text-[10px] leading-3 text-muted">
                {monthChanges ? week.month : ''}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function LastRequest({ usage }: { usage: ChatUsage }) {
  const figures = usageFigures(usage);
  const rows: Array<[string, string]> = [
    ['Model', usage.model],
    ['Prompt', `${int(usage.promptTokens)} tokens`],
    ['From cache', `${Math.round(figures.cachedShare * 100)}%`],
    ['Output', `${int(usage.outputTokens)} tokens`],
    ['Speed', figures.tokensPerSecond === null ? 'n/a' : `${figures.tokensPerSecond.toFixed(1)} tokens/s`],
    ['Total time', `${figures.seconds.toFixed(1)} s`],
  ];
  return (
    <section aria-label="Last request">
      <PaneTitle className="mb-1.5">Last request</PaneTitle>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {rows.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-muted">{name}</dt>
            <dd className="tnum min-w-0 text-right break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
