// The words and tones of the always-on system status bar: one pure function
// from the GET /projects/:p/ops payload to the short items the footer shows.
// DOM-free on purpose (sibling of nav.ts / vocab.ts) so the offline gate can
// assert the vocabulary — colour is never the only carrier of a state, so every
// unhealthy item says what is wrong in words too.
import { fmtCost } from "./labels.js";

/** A wait, in the coarsest unit that still means something. */
export const fmtWait = (s: WebDynamic) =>
  s == null ? "—" : s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;

// A heartbeat is late once it has missed three of its own intervals — one
// missed beat is a slow GitHub call, three is a loop that stopped.
const STALE_FACTOR = 3;

/**
 * Dispatch-reconciler liveness. "off" is a deployment choice (no GitHub
 * dispatch), not a fault, so it stays neutral; a configured loop that has gone
 * quiet is amber and says so.
 * @returns {{ value: string, tone: "neutral"|"pass"|"infra", note: string }}
 */
export function reconcilerHealth(rec: WebDynamic = {}): WebDynamic {
  if (!rec.configured) return { value: "off", tone: "neutral", note: "GitHub dispatch is not configured" };
  const every = `runs every ${rec.interval_s}s`;
  if (rec.lag_s == null) return { value: "no heartbeat", tone: "infra", note: `${every} — it has never reported` };
  if (rec.lag_s > STALE_FACTOR * Math.max(rec.interval_s, 1)) {
    return { value: `stale ${fmtWait(rec.lag_s)}`, tone: "infra", note: `${every}, last beat ${fmtWait(rec.lag_s)} ago` };
  }
  return { value: `${fmtWait(rec.lag_s)} ago`, tone: "pass", note: every };
}

/**
 * The status-bar items, left to right. Each is a label, a value a person can
 * read at a glance, a tone, and the sentence behind it (the bar's tooltip and
 * the drawer's detail line).
 * @returns {{ key: string, label: string, value: string, tone: string, note: string }[]}
 */
export function opsItems(ops: WebDynamic): WebDynamic {
  if (!ops) return [];
  const depth = ops.dispatches ?? {};
  const active = depth.active?.total ?? 0;
  const cap = depth.cap ?? 0;
  const qw = ops.queue_wait ?? {};
  const spend = ops.llm_spend ?? {};
  const rec = reconcilerHealth(ops.reconciler ?? {});
  return [
    {
      key: "dispatches",
      label: "In flight",
      value: `${active}/${cap}`,
      // At the cap nothing is broken, but the next launch waits — that is worth
      // a colour, and the note says why.
      tone: cap && active >= cap ? "infra" : active ? "accent" : "neutral",
      note: !active
        ? `nothing in flight — the cap is ${cap} at once`
        : `${active} of ${cap} allowed at once`
          + (depth.oldest_active_s != null ? ` · oldest ${fmtWait(depth.oldest_active_s)}` : "")
          + (cap && active >= cap ? " · at the cap, so the next launch waits" : ""),
    },
    {
      key: "queue",
      label: "Queue",
      value: qw.sample ? `${fmtWait(qw.p50_s)} p50` : "—",
      tone: "neutral",
      note: qw.sample
        ? `time from dispatch to executor: p50 ${fmtWait(qw.p50_s)} · p95 ${fmtWait(qw.p95_s)} over the last ${qw.sample}`
        : "no dispatches have been picked up yet",
    },
    { key: "reconciler", label: "Reconciler", value: rec.value, tone: rec.tone, note: rec.note },
    {
      key: "spend",
      label: `Spend ${spend.window_days ?? 30}d`,
      value: fmtCost(spend.total_usd),
      tone: "neutral",
      note: `run agents ${fmtCost(spend.runs_usd)} in the last ${spend.window_days ?? 30} days`,
    },
  ];
}

/** The feed indicator: the one line that says whether this console is live. */
export function feedIndicator(state: WebDynamic): WebDynamic {
  return state === "reconnecting"
    ? { value: "Reconnecting…", tone: "infra", note: "the event feed dropped — it resumes from its cursor, nothing is lost" }
    : { value: "Live", tone: "pass", note: "connected to the event feed — this page updates itself" };
}
