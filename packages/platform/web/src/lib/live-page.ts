import { subscribeFeed } from "./feed.js";
import { onPageLeave } from "./router.js";

/** Repaint a live surface without moving an opted-in control or its cursor. */
export function preserveFocus(paint: WebDynamic) {
  const active = document.activeElement;
  const key = active?.getAttribute?.("data-fk") || null;
  const start = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    ? active.selectionStart
    : null;
  paint();
  if (!key) return;
  const next = document.querySelector(`[data-fk="${CSS.escape(key)}"]`);
  if (!(next instanceof HTMLElement)) return;
  next.focus();
  if (start != null && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) {
    try { next.setSelectionRange(start, start); } catch { /* not a text control */ }
  }
}

/**
 * Subscribe once, coalesce feed edges, ignore callbacks after teardown, and
 * stop the subscription and pending refresh on navigation.
 */
export function debouncedFeedRefresh(
  projectKey: WebDynamic,
  { types, refresh, accepts = () => true, delay = 250 }: WebDynamic,
) {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unregisterLeave = () => {};
  const sub = subscribeFeed(projectKey, {
    types,
    onEvent: (event: WebDynamic) => {
      if (!active || !accepts(event)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (active) void refresh();
      }, delay);
    },
  });
  const stop = () => {
    if (!active) return;
    active = false;
    sub.stop();
    if (timer) clearTimeout(timer);
    timer = null;
    unregisterLeave();
  };
  unregisterLeave = onPageLeave(stop);
  return {
    current: () => active,
    stop,
  };
}
