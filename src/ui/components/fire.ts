/** Runs a controller action that returns a promise. A rejection is logged, never left unhandled. */
export function fire(result: Promise<unknown>): void {
  result.catch((error: unknown) => console.error('[magical-hamster]', error));
}

/**
 * A click handler that leaves out the second click of a double click. `detail` counts the clicks
 * of one run: 1 for a click, 2 and up for the rest of a double click, 0 for a press of Enter or
 * Space. For a button whose request the session grants only once it is made again on purpose
 * (leaving a recorded meeting that is not saved), and for one that takes another's place under
 * the pointer: neither may take one double click for two requests.
 */
export function firstClick(action: () => void): (event: { detail: number }) => void {
  return (event) => {
    if (event.detail > 1) return;
    action();
  };
}
