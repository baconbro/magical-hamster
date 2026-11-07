import clsx from 'clsx';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useController, useDebugOn, useHamster } from '../context.tsx';
import { panelDomId, tabDomId, visibleTabs } from './tabList.ts';

/** The tab list. `idPrefix` ties each tab to its panel, and keeps two open sidebars apart. */
export function TabBar({ idPrefix }: { idPrefix: string }) {
  const controller = useController();
  const active = useHamster((s) => s.tab);
  const TABS = visibleTabs(useDebugOn());
  const listRef = useRef<HTMLDivElement>(null);

  /* When the bar is too narrow and scrolls, the selected tab must not sit off-screen. */
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((t) => t.id === active);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    const target = TABS[next];
    if (!target) return;
    controller.setTab(target.id);
    listRef.current?.ownerDocument.getElementById(tabDomId(idPrefix, target.id))?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Magical Hamster"
      onKeyDown={onKeyDown}
      className="no-scrollbar flex shrink-0 overflow-x-auto border-y border-line bg-surface-alt px-1"
    >
      {TABS.map(({ id, label, icon: Icon }) => {
        const selected = id === active;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={tabDomId(idPrefix, id)}
            aria-selected={selected}
            aria-controls={panelDomId(idPrefix, id)}
            aria-label={label}
            title={label}
            tabIndex={selected ? 0 : -1}
            onClick={() => controller.setTab(id)}
            className={clsx(
              '-outline-offset-2 flex min-w-9 flex-auto flex-col items-center gap-0.5 border-b-2 px-1 pt-1.5 pb-1 transition-colors',
              /* The fill as well as the underline: a pale accent on a pale theme is not enough of a mark. */
              selected ? 'border-brand bg-surface text-ink' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            <span className={clsx('hidden text-[11px] leading-tight @[340px]:block', selected && 'font-medium')}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
