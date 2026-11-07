/* Obsidian's status bar floats over the bottom right corner of the window: over the bottom of
   the right sidebar, where this view lives. Whatever the view pins to its bottom edge (the Ask
   box, the Transcript's "Jump to latest") would sit under it. The view keeps that strip free:
   `--mh-bottom-inset` on its root is how much of it the bar covers. */

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** How many pixels at the bottom of `view` the status bar covers. 0 when it covers nothing. */
export function bottomInset(view: Box, bar: Box | null): number {
  if (!bar) return 0;
  if (bar.bottom <= bar.top || bar.right <= bar.left) return 0;
  // Side by side, or entirely above or below: no overlap.
  if (bar.right <= view.left || bar.left >= view.right) return 0;
  if (bar.top >= view.bottom || bar.bottom <= view.top) return 0;
  return Math.ceil(Math.min(view.bottom, bar.bottom) - Math.max(view.top, bar.top));
}

function shown(element: Element, win: Window): boolean {
  const style = win.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/**
 * Keeps `--mh-bottom-inset` on `root` up to date: measured now, and again whenever the view or
 * the status bar changes size or the window is resized. A theme that hides or moves the bar
 * gives 0. Returns the function that stops watching.
 */
export function watchBottomInset(root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => {};
  let frame = 0;
  let watched: Element | null = null;
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;

  function measure(): void {
    frame = 0;
    const bar = doc.querySelector('.status-bar');
    if (bar !== watched) {
      if (watched) observer?.unobserve(watched);
      if (bar) observer?.observe(bar);
      watched = bar;
    }
    const inset = bar && win && shown(bar, win) ? bottomInset(root.getBoundingClientRect(), bar.getBoundingClientRect()) : 0;
    root.style.setProperty('--mh-bottom-inset', `${inset}px`);
  }

  function schedule(): void {
    if (frame === 0 && win) frame = win.requestAnimationFrame(measure);
  }

  observer?.observe(root);
  win.addEventListener('resize', schedule);
  measure();
  return () => {
    if (frame !== 0) win.cancelAnimationFrame(frame);
    observer?.disconnect();
    win.removeEventListener('resize', schedule);
    root.style.removeProperty('--mh-bottom-inset');
  };
}
