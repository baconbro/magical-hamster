import clsx from 'clsx';
import { Check, ChevronRight, Copy, LoaderCircle, type LucideIcon } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useController } from '../context.tsx';

/* The small set of controls every tab is built from. They start from the
   scoped reset (buttons and inputs are bare under `.mh-root`), and take their
   colours from the semantic tokens only, so they follow the reader's theme.

   A `className` passed in is added, not merged: it may place the control
   (margins, flex, width) but must not restate what the control already sets
   (padding, colour, size), because which of two competing utilities wins is
   decided by the stylesheet's order, not by the order in the attribute. */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-brand text-on-brand hover:bg-brand-hover disabled:hover:bg-brand',
  secondary: 'border border-line bg-surface text-ink hover:bg-hover disabled:hover:bg-surface',
  ghost: 'text-muted hover:bg-hover hover:text-ink disabled:hover:bg-transparent disabled:hover:text-muted',
  danger: 'border border-danger/60 text-danger hover:bg-danger/10',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: LucideIcon;
  /** Stretch to the container's width. */
  block?: boolean;
  /** Tighter side padding, for short labels in a crowded row. */
  compact?: boolean;
}

export function Button({ variant = 'secondary', icon: Icon, block, compact, className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx(
        'inline-flex h-7 min-w-0 shrink-0 items-center justify-center gap-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-50',
        compact ? 'px-1.5' : 'px-2.5',
        VARIANT[variant],
        block && 'w-full',
        className,
      )}
    >
      {Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
      {children}
    </button>
  );
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title' | 'children'> {
  icon: LucideIcon;
  /** Read by screen readers and shown as the tooltip. */
  label: string;
}

export function IconButton({ icon: Icon, label, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted',
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
    </button>
  );
}

interface CopyButtonProps {
  /** Called on click, so the text is built only when it is wanted. */
  getText: () => string;
  label?: string;
  /** Show the icon alone; the label stays as the accessible name. */
  iconOnly?: boolean;
  disabled?: boolean;
  className?: string;
}

export function CopyButton({ getText, label = 'Copy', iconOnly = false, disabled, className }: CopyButtonProps) {
  const controller = useController();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const onClick = () => {
    const text = getText();
    if (!text) return;
    controller.copy(text);
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setCopied(false);
    }, 1600);
  };

  const Icon = copied ? Check : Copy;
  return (
    <>
      {iconOnly ? (
        <IconButton icon={Icon} label={copied ? 'Copied' : label} onClick={onClick} disabled={disabled} className={className} />
      ) : (
        <Button variant="secondary" icon={Icon} onClick={onClick} disabled={disabled} className={className}>
          {copied ? 'Copied' : label}
        </Button>
      )}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to the clipboard' : ''}
      </span>
    </>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  /* `mh-spin` (styles.css) rather than Tailwind's spin utility, whose `@keyframes spin` would be
     the whole app's. Naming that utility here, even in a comment, would make Tailwind generate it:
     it reads every word of every source file. `mh-spin` stops itself under prefers-reduced-motion. */
  return <LoaderCircle className={clsx('mh-spin shrink-0', small ? 'size-3' : 'size-3.5')} aria-hidden="true" />;
}

export function Tag({ children, tone = 'chip', className }: { children: ReactNode; tone?: 'chip' | 'plain'; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[11px] leading-4 whitespace-nowrap',
        tone === 'chip' ? 'bg-chip text-ink' : 'border border-line text-muted',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({ icon: Icon, children, className }: { icon?: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex flex-col items-center gap-2 px-4 py-6 text-center text-xs leading-relaxed text-muted', className)}>
      {Icon && <Icon className="size-5 text-faint" aria-hidden="true" />}
      {children}
    </div>
  );
}

/** The quiet label above a block: "Shorthand", "Last request". */
export function PaneTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={clsx('text-[11px] font-semibold tracking-wide text-muted uppercase', className)}>{children}</h3>;
}

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  title?: string;
}

export function Switch({ checked, onChange, label, title }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md py-0.5 text-xs text-muted hover:text-ink"
    >
      <span className="whitespace-nowrap">{label}</span>
      <span
        aria-hidden="true"
        className={clsx('relative h-4 w-7 shrink-0 rounded-full transition-colors', checked ? 'bg-brand' : 'bg-faint')}
      >
        <span
          className={clsx(
            'absolute top-0.5 left-0.5 size-3 rounded-full transition-transform',
            checked ? 'translate-x-3 bg-on-brand' : 'bg-surface',
          )}
        />
      </span>
    </button>
  );
}

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}

/** A radio group drawn as one bar. Arrow keys move the choice, as in a native radio group. */
export function Segmented<T extends string>({ label, value, options, onChange, disabled }: SegmentedProps<T>) {
  const ref = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0 || disabled) return;
    event.preventDefault();
    const index = options.findIndex((o) => o.value === value);
    const next = options[(index + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    ref.current?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
  };

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex rounded-md border border-line bg-surface-alt p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-value={option.value}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={clsx(
              'min-w-0 flex-1 truncate rounded border px-1.5 py-0.5 text-center text-xs transition-colors disabled:opacity-60',
              selected ? 'border-line bg-surface font-medium text-ink' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

interface DisclosureProps {
  label: ReactNode;
  /** Shown at the right of the header row, outside the toggle. */
  aside?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
  /** For the wrapper around the content, when the content has to take part in a flex layout. */
  bodyClassName?: string;
}

export function Disclosure({ label, aside, defaultOpen = false, children, className, bodyClassName }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <div className={className}>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 text-left text-xs font-medium text-muted hover:text-ink"
        >
          <ChevronRight className={clsx('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden="true" />
          <span className="min-w-0 truncate">{label}</span>
        </button>
        {aside}
      </div>
      <div id={id} hidden={!open} className={open ? bodyClassName : undefined}>
        {open && children}
      </div>
    </div>
  );
}
