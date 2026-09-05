const SCROLLBAR_HIDE_DELAY_MS = 850;

/**
 * Marks the element that is currently scrolling so CSS can reveal only that
 * scrollbar. The scrollbar track itself keeps a fixed width at all times; only
 * the thumb colour changes, which avoids reflow when it appears or disappears.
 */
export function installScrollActivityTracking(): () => void {
  const hideTimers = new WeakMap<HTMLElement, number>();
  const activeElements = new Set<HTMLElement>();
  const activeTimers = new Set<number>();

  const onScroll = (event: Event) => {
    const element =
      event.target instanceof HTMLElement
        ? event.target
        : event.target instanceof Document
          ? (document.scrollingElement as HTMLElement | null)
          : null;
    if (!element) return;

    if (element.dataset.nomiScrolling !== "true") {
      element.dataset.nomiScrolling = "true";
    }
    activeElements.add(element);

    const previousTimer = hideTimers.get(element);
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
      activeTimers.delete(previousTimer);
    }

    const timer = window.setTimeout(() => {
      delete element.dataset.nomiScrolling;
      hideTimers.delete(element);
      activeElements.delete(element);
      activeTimers.delete(timer);
    }, SCROLLBAR_HIDE_DELAY_MS);
    hideTimers.set(element, timer);
    activeTimers.add(timer);
  };

  // Scroll does not bubble, but it can be observed during capture. One listener
  // therefore covers native divs, react-native-web ScrollViews and editors.
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });

  return () => {
    document.removeEventListener("scroll", onScroll, true);
    activeTimers.forEach((timer) => window.clearTimeout(timer));
    activeElements.forEach((element) => delete element.dataset.nomiScrolling);
    activeTimers.clear();
    activeElements.clear();
  };
}
