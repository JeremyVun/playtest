// The always-on system status bar's vocabulary (src/platform/web/lib/ops-status.ts).
// The module is DOM-free on purpose — like nav.js and vocab.js — so this
// offline gate can assert what the footer says about a deployment's health
// without a browser. The rule it exists to protect: every unhealthy state is
// legible as WORDS, because the bar carries tone as colour and colour is never
// allowed to be the only carrier of meaning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { opsItems, reconcilerHealth, feedIndicator, fmtWait } from "../../../web/lib/ops-status.js";

const ops = ({ active = 0, cap = 4, oldest = null, queue = {}, reconciler = {}, spend = {} }: HostedDynamic = {}) => ({
  dispatches: { active: { requested: 0, scheduled: 0, running: active, total: active }, cap, oldest_active_s: oldest },
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

test("status bar: reconciler liveness — off is a choice, silence is a fault", () => {
  const off = reconcilerHealth({ configured: false, interval_s: 30 });
  assert.equal(off.value, "off");
  assert.equal(off.tone, "neutral", "a deployment without GitHub dispatch is not unhealthy");
  assert.match(off.note, /not configured/);

  const never = reconcilerHealth({ configured: true, interval_s: 30, lag_s: null });
  assert.equal(never.tone, "infra");
  assert.match(never.value, /no heartbeat/, "the fault must be readable without colour");

  // Late once it has missed three of its own intervals; one slow GitHub call is
  // not an outage.
  assert.equal(reconcilerHealth({ configured: true, interval_s: 30, lag_s: 89 }).tone, "pass");
  const stale = reconcilerHealth({ configured: true, interval_s: 30, lag_s: 91 });
  assert.equal(stale.tone, "infra");
  assert.match(stale.value, /stale/, "the fault must be readable without colour");
  assert.match(stale.note, /runs every 30s/);

  const live = reconcilerHealth({ configured: true, interval_s: 30, lag_s: 8 });
  assert.equal(live.tone, "pass");
  assert.equal(live.value, "8s ago");
});

test("status bar: four items, left to right, in the order a slow run is diagnosed", () => {
  assert.deepEqual(opsItems(ops()).map((i: HostedDynamic) => i.key), ["dispatches", "queue", "reconciler", "spend"]);
  assert.deepEqual(opsItems(null), [], "no payload yet ⇒ no numbers, never zeros we cannot vouch for");
});

test("status bar: depth is quiet when idle, accent in flight, amber at the cap", () => {
  const [idle] = opsItems(ops({ active: 0, cap: 4 }));
  assert.equal(idle.value, "0/4");
  assert.equal(idle.tone, "neutral");
  assert.match(idle.note, /nothing in flight/);

  const [busy] = opsItems(ops({ active: 2, cap: 4, oldest: 200 }));
  assert.equal(busy.value, "2/4");
  assert.equal(busy.tone, "accent");
  assert.match(busy.note, /oldest 3m/);

  // At the cap nothing is broken, but the next launch waits — say that, in words.
  const [full] = opsItems(ops({ active: 4, cap: 4 }));
  assert.equal(full.tone, "infra");
  assert.match(full.note, /at the cap, so the next launch waits/);
});

test("status bar: queue wait is an honest dash until a dispatch has been picked up", () => {
  const [, empty] = opsItems(ops());
  assert.equal(empty.value, "—");
  assert.match(empty.note, /no dispatches have been picked up yet/);

  const [, seen] = opsItems(ops({ queue: { sample: 12, p50_s: 40, p95_s: 300 } }));
  assert.equal(seen.value, "40s p50");
  assert.match(seen.note, /p95 5m over the last 12/);
});

test("status bar: spend names its window and what is inside it", () => {
  const items = opsItems(ops({ spend: { window_days: 30, runs_usd: 12.4, total_usd: 12.4 } }));
  const spend = items.at(-1);
  assert.equal(spend.label, "Spend 30d");
  assert.equal(spend.value, "$12.40");
  assert.match(spend.note, /run agents \$12\.40 in the last 30 days/);
});

test("status bar: the feed indicator says what a dropped connection means", () => {
  assert.equal(feedIndicator("live").value, "Live");
  assert.equal(feedIndicator("live").tone, "pass");
  const down = feedIndicator("reconnecting");
  assert.equal(down.value, "Reconnecting…");
  assert.equal(down.tone, "infra");
  assert.match(down.note, /resumes from its cursor/, "a dropped feed loses nothing — say so");
});
