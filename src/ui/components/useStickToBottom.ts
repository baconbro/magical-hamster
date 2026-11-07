import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/* How close to the end still counts as "at the bottom". A row is taller than
   this, so one wheel tick upwards always lets go. */
const NEAR_PX = 24;

interface StickToBottom<S extends HTMLElement, C extends HTMLElement> {
  /** Put on the element that scrolls. */
  scrollerRef: RefObject<S | null>;
  /** Put on the single child that holds the growing content. */
  contentRef: RefObject<C | null>;
  /** Give this to the scroller's `onScroll`. */
  onScroll: () => void;
  /** True while the user has scrolled away from the end. */
  away: boolean;
  jumpToLatest: () => void;
}

/**
 * Keeps a scrolling list pinned to its end while content is added, until the
 * user scrolls up. It watches the content's size instead of the data, so a
 * growing last row (a live partial) is followed without its parent rendering.
 */
export function useStickToBottom<
  S extends HTMLElement = HTMLDivElement,
  C extends HTMLElement = HTMLDivElement,
>(): StickToBottom<S, C> {
  const scrollerRef = useRef<S>(null);
  const contentRef = useRef<C>(null);
  const stuck = useRef(true);
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);

  const toEnd = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, []);

  useLayoutEffect(toEnd, [toEnd]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stuck.current) toEnd();
    });
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [toEnd]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const movedUp = top < lastTop.current - 1;
    lastTop.current = top;
    const near = el.scrollHeight - top - el.clientHeight <= NEAR_PX;
    /* Only a move upwards lets go. The scroll event for our own jump to the end
       is delivered a frame later, and by then a new row may already have made
       the list longer: being short of the end is not, by itself, the user's doing. */
    if (near) stuck.current = true;
    else if (movedUp) stuck.current = false;
    setAway(!stuck.current);
  }, []);

  const jumpToLatest = useCallback(() => {
    stuck.current = true;
    setAway(false);
    toEnd();
  }, [toEnd]);

  return { scrollerRef, contentRef, onScroll, away, jumpToLatest };
}
