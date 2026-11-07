import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Wraps an action that returns a promise: `pending` is true until it settles,
 * so its button can be disabled meanwhile. For actions that must not be fired
 * twice by a double click (creating the companion note writes to the vault).
 */
export function usePending(action: () => Promise<unknown>): [pending: boolean, run: () => void] {
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  const latest = useRef(action);

  useEffect(() => {
    latest.current = action;
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    latest
      .current()
      .catch((error: unknown) => console.error('[magical-hamster]', error))
      .finally(() => {
        busy.current = false;
        if (alive.current) setPending(false);
      });
  }, []);

  return [pending, run];
}
