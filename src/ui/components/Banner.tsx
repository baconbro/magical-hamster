import clsx from 'clsx';
import { CircleAlert, Server, TextCursor, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import type { Region } from '../../types.ts';
import { useController, useHamster } from '../context.tsx';
import { ollamaDownMessage, pickBanners, type BannerModel } from './banner.ts';
import { fire } from './fire.ts';
import { Button, CopyButton } from './ui.tsx';
import { usePending } from './usePending.ts';

type Tone = 'warn' | 'danger' | 'quiet';

/* One array for "no meeting": a selector must hand back the same reference while nothing changed. */
const NO_REGIONS: readonly Region[] = [];

/**
 * The lines of trouble under the header: what is wrong with the setup, with the recording and
 * with the notes, and where the meeting is sent when Ollama is another computer, each on its
 * own line so that none hides another. Empty most of the time; announced when it changes.
 */
export function Banner() {
  const controller = useController();
  const ollamaStatus = useHamster((s) => s.ollama.status);
  const missingModels = useHamster((s) => s.ollama.missingModels);
  const remoteHost = useHamster((s) => s.ollama.remoteHost);
  const stt = useHamster((s) => s.stt);
  const sttMessage = useHamster((s) => s.sttMessage);
  const tab = useHamster((s) => s.tab);
  const recording = useHamster((s) => s.recording);
  const hasTurns = useHamster((s) => s.turns.length > 0);
  const recordingError = useHamster((s) => s.recordingError);
  const detachedRegions = useHamster((s) => s.meeting?.detachedRegions ?? NO_REGIONS);
  const editedOutside = useHamster((s) => s.meeting?.editedOutside ?? NO_REGIONS);
  const cursorOutside = useHamster((s) => s.meeting?.cursorOutside ?? false);
  const [creating, createCompanion] = usePending(() => controller.createCompanion());

  const banners = pickBanners({
    ollamaStatus,
    missingModels,
    remoteHost,
    stt,
    sttMessage,
    tab,
    recording,
    hasTurns,
    recordingError,
    detachedRegions,
    editedOutside,
    cursorOutside,
  });

  const line = (banner: BannerModel): ReactNode => {
    switch (banner.kind) {
      case 'ollama-down':
        return (
          <Frame tone="warn">
            <p className="min-w-0 flex-1 break-words">{ollamaDownMessage(remoteHost)}</p>
            <Button onClick={() => fire(controller.refreshOllama())}>Retry</Button>
          </Frame>
        );
      case 'models-missing':
        return (
          <Frame tone="warn">
            <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
              <ul className="flex w-full min-w-0 flex-col gap-1">
                {banner.models.map((model) => (
                  <li key={model} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 break-words">
                      Model not installed: <code className="font-medium">{model}</code>
                    </span>
                    <CopyButton
                      iconOnly
                      label={`Copy the command: ollama pull ${model}`}
                      getText={() => `ollama pull ${model}`}
                    />
                  </li>
                ))}
              </ul>
              {/* Nothing else looks again once the model is pulled: without this the banner
                  stays until a setting changes or Obsidian restarts. */}
              <Button title="Look again for the installed models" onClick={() => fire(controller.refreshOllama())}>
                Check again
              </Button>
            </div>
          </Frame>
        );
      case 'ollama-remote':
        /* Not a fault to fix but a fact to know, for as long as it is one: where the meeting goes. */
        return (
          <Frame tone="warn" icon={Server}>
            {banner.message}
          </Frame>
        );
      case 'stt-not-installed':
        return <Frame tone="warn">{banner.message}</Frame>;
      case 'stt-failed':
      case 'recording-error':
        return <Frame tone="danger">{banner.message}</Frame>;
      case 'detached':
      case 'edited-outside':
        return (
          <Frame tone="warn">
            <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
              <p className="break-words">{banner.message}</p>
              {/* Reads the note again: a region whose markers were put back is saved to from then
                  on, and so is one that was edited by hand. The label is the model's, which
                  knows what the one call is about to do. */}
              {banner.action !== null && (
                <Button disabled={creating} onClick={createCompanion}>
                  {banner.action}
                </Button>
              )}
            </div>
          </Frame>
        );
      case 'cursor-outside':
        return <Frame tone="quiet">Your cursor is outside this meeting's section.</Frame>;
    }
  };

  return (
    /* Several lines at the worst: in a short leaf they scroll here rather than push the tab out
       of the pane. `relative` because a line can hold screen-reader-only text. */
    <div aria-live="polite" className="relative max-h-[45%] shrink-0 overflow-y-auto">
      {banners.map((banner) => (
        <Fragment key={banner.kind}>{line(banner)}</Fragment>
      ))}
    </div>
  );
}

function Frame({ tone, icon, children }: { tone: Tone; icon?: LucideIcon; children: ReactNode }) {
  const Icon = icon ?? (tone === 'danger' ? CircleAlert : tone === 'warn' ? TriangleAlert : TextCursor);
  return (
    <div
      className={clsx(
        'mh-fade mx-3 mb-2 flex items-start gap-2 rounded-md text-xs leading-snug',
        tone === 'quiet' ? 'text-muted' : 'border px-2 py-1.5 text-ink',
        tone === 'warn' && 'border-warn/40 bg-warn/10',
        tone === 'danger' && 'border-danger/40 bg-danger/10',
      )}
    >
      <Icon
        aria-hidden="true"
        className={clsx(
          'mt-px size-3.5 shrink-0',
          tone === 'warn' && 'text-warn',
          tone === 'danger' && 'text-danger',
          tone === 'quiet' && 'text-faint',
        )}
      />
      {typeof children === 'string' ? <p className="min-w-0 flex-1 break-words">{children}</p> : children}
    </div>
  );
}
