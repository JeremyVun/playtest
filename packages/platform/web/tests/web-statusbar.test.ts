// The always-on system status bar's vocabulary (packages/platform/web/src/lib/ops-status.ts).
// The module is DOM-free on purpose — like nav.js and vocab.js — so this
// offline gate can assert what the footer says about a deployment's health
// without a browser. The two rules it exists to protect:
//   1. Every unhealthy state is legible as WORDS, because the bar carries tone
//      as colour and colour is never allowed to be the only carrier of meaning.
//   2. The bar stays quiet. Healthy machinery raises no alert — a footer that is
//      on screen all day spends its space on what is happening and what is
//      wrong, and leaves the rest to the drawer.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activityLine, opsAlerts, opsDetails, opsSummary, reconcilerHealth, feedIndicator, fmtWait,
} from "../src/lib/ops-status.js";

const ops = ({ running = 0, requested = 0, scheduled = 0, cap = 4, oldest = null, queue = {}, reconciler = {}, spend = {} }: WebDynamic = {}) => ({
  dispatches: {
    active: { requested, scheduled, running, total: requested + scheduled + running },
    cap,
    oldest_active_s: oldest,
  },
  queue_wait: { sample: 0, p50_s: null, p95_s: null, max_s: null, ...queue },
  reconciler: { configured: true, interval_s: 30, lag_s: 5, detail: {}, ...reconciler },
  llm_spend: { window_days: 30, runs_usd: 1.5, total_usd: 1.5, ...spend },
});

test("status bar: waits read in the coarsest unit that still means something", () => {
  assert.equal(fmtWait(null), "—");
  assert.equal(fmtWait(0), "0s");
  assert.equal(fmtWait(89), "89s");
  assert.equal(fmtWait(90), "2m");
  assert.equal(fmtWait(5399), "90m");
  assert.equal(fmtWait(7200), "2h");
});

test("status bar: watchdog liveness — off is a choice, silence is a fault", () => {
  const off = reconcilerHealth({ configured: false, interval_s: 30 });
  assert.equal(off.value, "off");
  assert.equal(off.tone, "neutral", "a deployment that runs no watchdog sweep is not unhealthy");
  assert.equal(off.fault, null, "and it raises nothing in the bar");

  const never = reconcilerHealth({ configured: true, interval_s: 30, lag_s: null });
  assert.equal(never.tone, "infra");
  assert.match(never.value, /no heartbeat/, "the fault must be readable without colour");
  assert.equal(never.fault, "Watchdog silent");

  // Late once it has missed three of its own intervals; one slow sweep is not
  // an outage.
  const fine = reconcilerHealth({ configured: true, interval_s: 30, lag_s: 89 });
  assert.equal(fine.tone, "pass");
  assert.equal(fine.fault, null);
  const stale = reconcilerHealth({ configured: true, interval_s: 30, lag_s: 91 });
  assert.equal(stale.tone, "infra");
  assert.match(stale.value, /stale/, "the fault must be readable without colour");
  assert.equal(stale.fault, "Watchdog stalled 2m");
  assert.match(stale.note, /sweeps every 30s/);

  const live = reconcilerHealth({ configured: true, interval_s: 30, lag_s: 8 });
  assert.equal(live.tone, "pass");
  assert.equal(live.value, "8s ago");
});

test("status bar: activity is a sentence about work, not a ratio", () => {
  const idle = activityLine(ops());
  assert.equal(idle.value, "Idle");
  assert.equal(idle.tone, "neutral");
  assert.match(idle.note, /up to 4 at once/);

  assert.equal(activityLine(ops({ running: 2 })).value, "2 running");
  assert.equal(activityLine(ops({ running: 2, requested: 1 })).value, "2 running · 1 waiting");
  // Alone, "waiting" has to name what it is waiting on.
  assert.equal(activityLine(ops({ scheduled: 3 })).value, "3 waiting for a runner");

  const busy = activityLine(ops({ running: 2, oldest: 200 }));
  assert.equal(busy.tone, "accent");
  assert.match(busy.note, /2 of 4 in flight · the oldest for 3m/);
});

test("status bar: a healthy deployment raises no alerts at all", () => {
  assert.deepEqual(opsAlerts(ops({ running: 2 })), [], "quiet is the whole point of the bar");
  assert.deepEqual(opsAlerts(null), []);
  assert.deepEqual(opsAlerts(ops({ reconciler: { configured: false } })), [], "a watchdog nobody configured is not a fault");
});

test("status bar: alerts say what is wrong and what it costs the user", () => {
  const [full] = opsAlerts(ops({ running: 4, cap: 4 }));
  assert.equal(full.key, "capacity");
  assert.equal(full.value, "At capacity");
  assert.match(full.note, /the next launch waits for one to finish/);

  const [dead] = opsAlerts(ops({ reconciler: { lag_s: 400 } }));
  assert.equal(dead.key, "watchdog");
  assert.equal(dead.value, "Watchdog stalled 7m");
  assert.match(dead.note, /a run that dies may sit unresolved/);

  // Both at once, worst-first: the cap is what is holding the user's launch.
  assert.deepEqual(
    opsAlerts(ops({ running: 4, cap: 4, reconciler: { lag_s: 400 } })).map((a: WebDynamic) => a.key),
    ["capacity", "watchdog"],
  );
});

test("status bar: the drawer holds the machinery the bar leaves out", () => {
  assert.deepEqual(opsDetails(ops()).map((d: WebDynamic) => d.key), ["dispatches", "queue", "reconciler", "spend"]);
  assert.deepEqual(opsDetails(null), [], "no payload yet ⇒ no numbers, never zeros we cannot vouch for");

  const [idle] = opsDetails(ops());
  assert.equal(idle.value, "None");
  assert.match(idle.note, /the cap is 4 at once/);

  const [busy] = opsDetails(ops({ running: 1, requested: 1, oldest: 200 }));
  assert.equal(busy.value, "2 of 4");
  assert.equal(busy.tone, "accent");
  assert.match(busy.note, /1 running, 1 waiting for a runner · the oldest for 3m/);
  assert.equal(opsDetails(ops({ running: 4, cap: 4 }))[0].tone, "infra");
});

test("status bar: pickup time is an honest dash until a dispatch has been taken", () => {
  const [, empty] = opsDetails(ops());
  assert.equal(empty.value, "—");
  assert.match(empty.note, /no dispatch has been picked up by a runner yet/);

  const [, seen] = opsDetails(ops({ queue: { sample: 12, p50_s: 40, p95_s: 300 } }));
  assert.equal(seen.value, "40s typical");
  assert.match(seen.note, /over the last 12 · typically 40s · 19 in 20 within 5m/);
});

test("status bar: spend names its window and what is inside it", () => {
  const summary = opsSummary(ops({ spend: { window_days: 30, runs_usd: 12.4, total_usd: 12.4 } }));
  assert.equal(summary.spend.label, "Spend 30d");
  assert.equal(summary.spend.value, "$12.40");
  assert.match(summary.spend.note, /run agents \$12\.40 in the last 30 days/);
  assert.equal(summary.details.at(-1).value, "$12.40", "the drawer repeats the figure, not a different one");
});

test("status bar: one payload paints the whole footer, and nothing paints without one", () => {
  assert.equal(opsSummary(null), null);
  assert.deepEqual(Object.keys(opsSummary(ops())), ["activity", "alerts", "spend", "details"]);
});

test("status bar: the feed indicator says what a dropped connection means", () => {
  assert.equal(feedIndicator("live").value, "Live");
  assert.equal(feedIndicator("live").tone, "pass");
  const down = feedIndicator("reconnecting");
  assert.equal(down.value, "Reconnecting…");
  assert.equal(down.tone, "infra");
  assert.match(down.note, /resumes from its cursor/, "a dropped feed loses nothing — say so");
});
