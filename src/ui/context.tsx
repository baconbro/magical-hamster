import { createContext, useCallback, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { HamsterController, HamsterState, HamsterStore, UiHost } from '../types.ts';

export interface AppProps {
  store: HamsterStore;
  controller: HamsterController;
  host: UiHost;
}

const Ctx = createContext<AppProps | null>(null);

/* What a tab has half done: a question being typed, folders being ticked. Only the tab on
   screen is mounted, and the tab changes by a click or by the session itself (a summary that
   starts after Stop), so a tab's own state does not last. This does, for as long as the sidebar
   is open; each mounted sidebar has its own. */
const KeptCtx = createContext<Map<string, unknown> | null>(null);

export function HamsterProvider({ value, children }: { value: AppProps; children: ReactNode }) {
  const [kept] = useState(() => new Map<string, unknown>());
  return (
    <Ctx.Provider value={value}>
      <KeptCtx.Provider value={kept}>{children}</KeptCtx.Provider>
    </Ctx.Provider>
  );
}

function useApp(): AppProps {
  const app = useContext(Ctx);
  if (!app) throw new Error('HamsterProvider is missing');
  return app;
}

/**
 * Reads a slice of state and re-renders when it changes.
 * The selector must return a stable reference: a primitive, or an object that
 * already lives in the state. Building a new object in the selector loops.
 */
export function useHamster<T>(selector: (state: HamsterState) => T): T {
  const { store } = useApp();
  // Called through the store, and the same function from one render to the next: React subscribes again when it changes.
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  return useSyncExternalStore(
    subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

/**
 * `useState` for what must survive the tab being taken off screen. `key` names the value among
 * everything kept; `initial` is used the first time only.
 */
export function useKept<T>(key: string, initial: T): [value: T, set: (next: T) => void] {
  const kept = useContext(KeptCtx);
  if (!kept) throw new Error('HamsterProvider is missing');
  const [value, setValue] = useState<T>(() => (kept.has(key) ? (kept.get(key) as T) : initial));
  const set = useCallback(
    (next: T) => {
      kept.set(key, next);
      setValue(next);
    },
    [kept, key],
  );
  return [value, set];
}

export function useController(): HamsterController {
  return useApp().controller;
}

export function useUiHost(): UiHost {
  return useApp().host;
}

const NO_ENTRIES: readonly import('../llm/callLog.ts').LogEntry[] = [];
const noSubscribe = (): (() => void) => () => {};

/** The call log's subscribe, called through the log, and stable while the log is the same. */
function useLogSubscribe(log: UiHost['callLog']): (listener: () => void) => () => void {
  return useCallback((listener: () => void) => (log ? log.subscribe(listener) : noSubscribe()), [log]);
}

/** True while the Debug tab is switched on (per device, in the plugin's settings). */
export function useDebugOn(): boolean {
  const log = useApp().host.callLog;
  return useSyncExternalStore(
    useLogSubscribe(log),
    () => log?.enabled() ?? false,
    () => log?.enabled() ?? false,
  );
}

/** The exchanges with the model, newest first. */
export function useCallEntries(): readonly import('../llm/callLog.ts').LogEntry[] {
  const log = useApp().host.callLog;
  return useSyncExternalStore(
    useLogSubscribe(log),
    () => log?.entries() ?? NO_ENTRIES,
    () => log?.entries() ?? NO_ENTRIES,
  );
}
