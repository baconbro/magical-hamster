import clsx from 'clsx';
import { memo, useEffect, useRef } from 'react';
import { useUiHost } from './context.tsx';

/* Streaming text changes many times a second and each render rebuilds the
   element's DOM, so paints are spaced out. The last value always gets painted. */
const MIN_PAINT_INTERVAL_MS = 250;

interface MarkdownProps {
  source: string;
  className?: string;
}

/** Markdown rendered by the host: the plugin's own inert renderer, in Obsidian and in the harness. */
export const Markdown = memo(function Markdown({ source, className }: MarkdownProps) {
  const host = useUiHost();
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(source);
  const painted = useRef<string | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  /* "Never": a plain 0 would read as "just painted" during the first 250 ms of the page's life. */
  const lastPaint = useRef(Number.NEGATIVE_INFINITY);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    latest.current = source;

    const paint = () => {
      timer.current = null;
      const el = ref.current;
      if (!el || painted.current === latest.current) return;
      cleanup.current?.();
      cleanup.current = host.renderMarkdown(latest.current, el);
      painted.current = latest.current;
      lastPaint.current = performance.now();
    };

    const wait = MIN_PAINT_INTERVAL_MS - (performance.now() - lastPaint.current);
    if (wait <= 0) paint();
    else if (timer.current === null) timer.current = window.setTimeout(paint, wait);
  }, [source, host]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      cleanup.current?.();
      cleanup.current = null;
      /* Forget the paint, so a remount (StrictMode does one in development) starts at once. */
      painted.current = null;
      lastPaint.current = Number.NEGATIVE_INFINITY;
    },
    [],
  );

  /* `mh-md` here as well as on whatever wrapper the host adds: the prose styles
     must apply even when a host renders straight into this element. */
  return <div ref={ref} className={clsx('mh-md min-w-0', className)} />;
});
