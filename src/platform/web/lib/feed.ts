// Event-feed client: cursor long-poll against
// GET /projects/:key/events/feed. The server holds the request up to `wait`
// seconds (LISTEN/NOTIFY-woken), so a healthy loop is one open request at a
// time — re-poll immediately on response, jittered backoff on error. Pages use
// this to update rows in place ("live regions, not spinners"); onState drives
// the quiet "reconnecting…" pill and recovery resumes from the cursor without
// losing rows.
import { api } from "./api.js";

/**
 * Subscribe to a project's platform events.
 * @param {string} projectKey
 * @param {{ types?: string[], onEvent: (e: {id,ts,type,entity,payload}) => void,
 *           onState?: (s: "live"|"reconnecting") => void }} opts
 * @returns {{ stop: () => void }}
 */
export function subscribeFeed(projectKey: WebDynamic, { types = [], onEvent, onState }: WebDynamic = {}) {
  let stopped = false;
  let cursor = ""; // empty first poll → the server answers with the tail cursor
  let backoffMs = 0;
  // The request in flight, so stopping can take its connection back. A browser
  // allows about six per origin and the server holds each poll for 25 seconds:
  // flagging a subscription as stopped without aborting it left every page you
  // navigated away from squatting on a connection, and the page you arrived at
  // queued behind them. Its "live" region then sat silent until its slow safety
  // refresh — live updates degrading to a poll for no reason a person could see.
  let inflight: WebDynamic = null;
  const seen: WebDynamic = new Set(); // event-id dedupe across reconnects (ids are ulids)
  const typesQ = types.length ? `&types=${encodeURIComponent(types.join(","))}` : "";

  async function loop() {
    while (!stopped) {
      try {
        inflight = new AbortController();
        const { events, cursor: next } = await api.get(
          `/projects/${projectKey}/events/feed?after=${encodeURIComponent(cursor)}&wait=25${typesQ}`,
          { signal: inflight.signal },
        );
        if (stopped) return;
        if (backoffMs) { backoffMs = 0; onState?.("live"); }
        cursor = next || cursor;
        for (const e of events) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          if (seen.size > 2000) seen.delete(seen.values().next().value);
          onEvent?.(e);
        }
      } catch {
        // Our own abort lands here too, and it is not a connection problem:
        // `stopped` is the discriminator, so it never shows "reconnecting…".
        if (stopped) return;
        if (!backoffMs) onState?.("reconnecting");
        backoffMs = Math.min(backoffMs ? backoffMs * 2 : 1000, 15000);
        await sleep(backoffMs + Math.random() * 400);
      }
    }
  }
  loop();
  return {
    stop: () => {
      stopped = true;
      inflight?.abort();
    },
  };
}

const sleep = (ms: WebDynamic) => new Promise((r) => setTimeout(r, ms));
