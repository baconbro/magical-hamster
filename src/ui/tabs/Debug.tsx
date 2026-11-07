import clsx from 'clsx';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { memo } from 'react';
import { entryJson, type LogEntry } from '../../llm/callLog.ts';
import { Button, CopyButton, EmptyState } from '../components/ui.tsx';
import { useCallEntries, useKept, useUiHost } from '../context.tsx';

/* Every exchange with the model, newest first: what was sent and what came back, as plain text.
   Never drawn as Markdown: an answer is shown exactly as the model wrote it. */
export function DebugTab() {
  const entries = useCallEntries();
  const log = useUiHost().callLog;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-surface-alt px-3 py-2">
        <span className="text-[11px] text-muted">{entries.length === 1 ? '1 exchange' : `${entries.length} exchanges`}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <CopyButton
            label="Copy all"
            disabled={entries.length === 0}
            getText={() => `[\n${entries.map(entryJson).join(',\n')}\n]`}
          />
          <Button icon={Trash2} disabled={entries.length === 0} onClick={() => log?.clear()}>
            Clear
          </Button>
        </div>
      </div>
      <p className="shrink-0 px-3 pt-2 text-[11px] leading-snug text-muted">
        The exchanges hold your notes and transcript. They are kept in memory only, for the last 100 calls, and are
        gone when Obsidian closes. Nothing here is written to your vault.
      </p>
      <div className="relative min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {entries.length === 0 ? (
          <EmptyState>No exchange yet. Press Enhance, ask a question or summarize to see one.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {entries.map((entry) => (
              <Row key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const PURPOSE: Record<string, string> = {
  enhance: 'Enhance',
  live: 'Live Enhance',
  'summary-window': 'Summary, one window',
  summary: 'Summary',
  actions: 'Action items',
  qa: 'Question',
};

function title(entry: LogEntry): string {
  if (entry.kind === 'embed') return 'Embedding';
  if (entry.kind === 'tags') return 'Installed models';
  return entry.purpose ? (PURPOSE[entry.purpose] ?? entry.purpose) : 'Chat';
}

function seconds(ms: number | undefined): string {
  return ms === undefined ? '' : `${(ms / 1000).toFixed(1)} s`;
}

function figures(entry: LogEntry): string {
  const parts: string[] = [];
  if (entry.usage) parts.push(`${entry.usage.promptTokens} in`, `${entry.usage.outputTokens} out`);
  if (entry.kind === 'embed') parts.push(`${entry.inputCount ?? 0} texts`, `${entry.promptTokens ?? 0} tokens`);
  if (entry.totalMs !== undefined) parts.push(seconds(entry.totalMs));
  return parts.join(' · ');
}

const STATUS_TONE: Record<LogEntry['status'], string> = {
  running: 'text-brand',
  done: 'text-ok',
  error: 'text-danger',
  cancelled: 'text-muted',
};

const Row = memo(function Row({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useKept<boolean>(`debug-open-${entry.id}`, false);
  const time = new Date(entry.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <li className="rounded-md border border-line bg-surface-alt">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
      >
        <Chevron className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
        <span className="shrink-0 font-mono text-[11px] text-muted">{time}</span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title(entry)}</span>
        <span className={clsx('shrink-0 text-[11px]', STATUS_TONE[entry.status])}>{entry.status}</span>
      </button>
      <div className="flex flex-wrap gap-x-2 px-2 pb-1.5 text-[11px] text-muted">
        {entry.model && <span className="truncate">{entry.model}</span>}
        <span>{figures(entry)}</span>
        {entry.doneReason && entry.doneReason !== 'stop' && <span className="text-warn">stopped: {entry.doneReason}</span>}
      </div>
      {open && <Details entry={entry} />}
    </li>
  );
});

function Block({ label, text, cut }: { label: string; text: string; cut?: number }) {
  return (
    <div className="mt-1.5">
      <div className="text-[10px] font-semibold tracking-wide text-muted uppercase">{label}</div>
      <pre className="mt-0.5 max-h-72 overflow-auto rounded border border-line bg-surface p-1.5 font-mono text-[11px] leading-snug break-words whitespace-pre-wrap">
        {text}
      </pre>
      {cut !== undefined && cut > 0 && (
        <p className="text-[10px] text-muted">{cut} more characters not kept in the log.</p>
      )}
    </div>
  );
}

function Details({ entry }: { entry: LogEntry }) {
  return (
    <div className="border-t border-line px-2 pb-2">
      {entry.error && <Block label="Error" text={entry.error} />}
      {entry.messages?.map((m, i) => <Block key={i} label={m.role} text={m.content} cut={m.cut} />)}
      {entry.inputs && <Block label={`First of ${entry.inputCount ?? 0} texts`} text={entry.inputs.join('\n\n')} />}
      {entry.answer !== undefined && (
        <Block label={entry.kind === 'tags' ? 'Models' : 'Answer'} text={entry.answer} cut={entry.answerCut} />
      )}
      {entry.options && <Block label="Options" text={JSON.stringify(entry.options, null, 2)} />}
      {entry.usage && <Block label="Ollama's figures" text={JSON.stringify(entry.usage, null, 2)} />}
      <div className="mt-1.5 flex justify-end">
        <CopyButton label="Copy" getText={() => entryJson(entry)} />
      </div>
    </div>
  );
}
