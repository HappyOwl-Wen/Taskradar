// The bar that currently holds the clearance; a newer bar takes it over.
let holder = 0;

/**
 * Toasts keep clear of an action bar at the bottom of the screen while it is shown (the review queue's
 * decisions): the bar's height is published as `--toast-clearance`, which the toaster adds to its bottom
 * offset. Use it as the bar's ref callback; React runs the returned cleanup when the bar goes away.
 */
export function keepToastsClear(bar: HTMLElement | null): (() => void) | undefined {
  if (!bar) return undefined;
  const me = ++holder;
  const root = document.documentElement;
  const publish = () => root.style.setProperty("--toast-clearance", `${bar.offsetHeight}px`);
  publish();
  // The bar can wrap onto a second line (narrow screens, longer labels).
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(publish);
  observer?.observe(bar);
  return () => {
    observer?.disconnect();
    // When the queue moves on, the next task's bar follows within moments: the space is kept until then,
    // so a toast does not drop onto the place where the next decisions appear.
    window.setTimeout(() => {
      if (holder === me) root.style.removeProperty("--toast-clearance");
    }, 1000);
  };
}
