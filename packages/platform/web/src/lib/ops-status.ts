// The words of the always-on system status bar: pure functions from the
// GET /projects/:p/ops payload to what the footer says.
//
// The bar is read by someone waiting on a run, not by someone auditing a
// deployment, so it is quiet by default. It always answers "is anything
// happening?", it speaks up only when something is actually wrong, and it keeps
// the machinery — heartbeat intervals, queue percentiles, the cap — in the
// drawer, where a developer goes when the answer is "yes, something is wrong".
// Healthy machinery earns no space in a bar that is on screen all day.
//
// DOM-free on purpose (sibling of nav.ts / vocab.ts) so the offline gate can
// assert the vocabulary without a browser. The rule it protects: every
// unhealthy state is legible as WORDS, because colour is never allowed to be
// the only carrier of meaning.
import { fmtCost } from "./labels.js";

/** A wait, in the coarsest unit that still means something. */
export const fmtWait = (s: WebDynamic) =>
  s == null ? "—" : s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;

// A heartbeat is late once it has missed three of its own intervals — one
// missed beat is a slow sweep, three is a loop that stopped.
const STALE_FACTOR = 3;

/**
 * Dispatch-reconciler liveness, in the terms of what it does for a person: it
 * is the watchdog that notices a run whose executor vanished. "off" is a
 * deployment choice (the interval is zero), not a fault, so it stays neutral; a
 * loop that should be beating and has gone quiet is amber and says so.
 *
 * `fault` is the alert wording for the bar, and is null while all is well —
 * the threshold for "wrong" lives here and nowhere else.
 * @returns {{ value: string, tone: "neutral"|"pass"|"infra", note: string, fault: string|null }}
 */
export function reconcilerHealth(rec: WebDynamic = {}): WebDynamic {
  const job = `it sweeps every ${rec.interval_s}s and fails runs whose runner vanished`;
  if (!rec.configured) return { value: "off", tone: "neutral", note: "this deployment runs no watchdog sweep", fault: null };
  if (rec.lag_s == null) {
    return { value: "no heartbeat", tone: "infra", note: `${job} — it has never reported`, fault: "Watchdog silent" };
  }
  if (rec.lag_s > STALE_FACTOR * Math.max(rec.interval_s, 1)) {
    const ago = fmtWait(rec.lag_s);
    return {
      value: `stale ${ago}`,
      tone: "infra",
      note: `last swept ${ago} ago — ${job}, so a run that dies may sit unresolved`,
      fault: `Watchdog stalled ${ago}`,
    };
  }
  return { value: `${fmtWait(rec.lag_s)} ago`, tone: "pass", note: job, fault: null };
}

/** running / waiting / total / cap, read off the dispatch depth. */
function depthOf(ops: WebDynamic) {
  const d = ops?.dispatches ?? {};
  const a = d.active ?? {};
  const running = a.running ?? 0;
  const waiting = (a.requested ?? 0) + (a.scheduled ?? 0);
  return { running, waiting, total: a.total ?? running + waiting, cap: d.cap ?? 0, oldest: d.oldest_active_s ?? null };
}

/**
 * What is happening right now — the one thing the bar always says, in a
 * sentence rather than a ratio. "Waiting" is named for what it waits on when it
 * stands alone, and is unambiguous beside a running count.
 * @returns {{ value: string, tone: string, note: string }}
 */
export function activityLine(ops: WebDynamic): WebDynamic {
  const { running, waiting, total, cap, oldest } = depthOf(ops);
  if (!total) {
    return { value: "Idle", tone: "neutral", note: `nothing in flight — this project runs up to ${cap} at once` };
  }
  const value = running && waiting
    ? `${running} running · ${waiting} waiting`
    : running ? `${running} running` : `${waiting} waiting for a runner`;
  const note = `${total} of ${cap} in flight`
    + (oldest != null ? ` · the oldest for ${fmtWait(oldest)}` : "");
  return { value, tone: "accent", note };
}

/**
 * Only what is actually wrong, in the order it bites: the cap that is holding
 * the next launch, then the watchdog that is not watching. Healthy machinery
 * returns nothing at all, and an idle project shows an empty bar.
 * @returns {{ key: string, value: string, note: string }[]}
 */
export function opsAlerts(ops: WebDynamic): WebDynamic {
  if (!ops) return [];
  const alerts = [];
  const { total, cap } = depthOf(ops);
  if (cap && total >= cap) {
    alerts.push({
      key: "capacity",
      value: "At capacity",
      note: `${cap} runs in flight is the most this project runs at once — the next launch waits for one to finish`,
    });
  }
  const rec = reconcilerHealth(ops.reconciler ?? {});
  if (rec.fault) alerts.push({ key: "watchdog", value: rec.fault, note: rec.note });
  return alerts;
}

/** Model spend: quiet, trailing, and always naming its window. */
export function spendItem(ops: WebDynamic): WebDynamic {
  const spend = ops?.llm_spend ?? {};
  const days = spend.window_days ?? 30;
  return {
    label: `Spend ${days}d`,
    value: fmtCost(spend.total_usd),
    note: `run agents ${fmtCost(spend.runs_usd)} in the last ${days} days`,
  };
}

/**
 * The drawer's numbers: everything the bar deliberately does not say, in the
 * order a slow run is diagnosed — how much work there is, how long work waits
 * for a runner, whether the watchdog is beating, what it all cost.
 * @returns {{ key: string, label: string, value: string, tone: string, note: string }[]}
 */
export function opsDetails(ops: WebDynamic): WebDynamic {
  if (!ops) return [];
  const { running, waiting, total, cap, oldest } = depthOf(ops);
  const qw = ops.queue_wait ?? {};
  const rec = reconcilerHealth(ops.reconciler ?? {});
  const spend = spendItem(ops);
  return [
    {
      key: "dispatches",
      label: "In flight",
      value: total ? `${total} of ${cap}` : "None",
      tone: cap && total >= cap ? "infra" : total ? "accent" : "neutral",
      note: total
        ? `${running} running, ${waiting} waiting for a runner`
          + (oldest != null ? ` · the oldest for ${fmtWait(oldest)}` : "")
        : `no run is placed right now — the cap is ${cap} at once`,
    },
    {
      key: "queue",
      label: "Pickup",
      value: qw.sample ? `${fmtWait(qw.p50_s)} typical` : "—",
      tone: "neutral",
      note: qw.sample
        ? `how long a run waits for a runner to take it, over the last ${qw.sample}`
          + ` · typically ${fmtWait(qw.p50_s)} · 19 in 20 within ${fmtWait(qw.p95_s)}`
        : "no dispatch has been picked up by a runner yet",
    },
    { key: "reconciler", label: "Watchdog", value: rec.value, tone: rec.tone, note: rec.note },
    { key: "spend", label: spend.label, value: spend.value, tone: "neutral", note: spend.note },
  ];
}

/**
 * Everything the footer paints, from one payload. Null until the first `/ops`
 * lands: no payload means no numbers, never zeros we cannot vouch for.
 */
export function opsSummary(ops: WebDynamic): WebDynamic {
  if (!ops) return null;
  return { activity: activityLine(ops), alerts: opsAlerts(ops), spend: spendItem(ops), details: opsDetails(ops) };
}

/** The feed indicator: the one line that says whether this console is live. */
export function feedIndicator(state: WebDynamic): WebDynamic {
  return state === "reconnecting"
    ? { value: "Reconnecting…", tone: "infra", note: "the event feed dropped — it resumes from its cursor, nothing is lost" }
    : { value: "Live", tone: "pass", note: "connected to the event feed — this page updates itself" };
}
