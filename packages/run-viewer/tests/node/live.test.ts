// The live protocol on the local viewer host
// (docs/contracts/interfaces.md#viewer-server): liveness from the event stream,
// the line-cursor endpoint with its caps and reset answering, held polls waking
// on all three signals, and the additive picker projection.
//
// Everything here runs against real run directories written line by line, the
// way a recording run writes them — including the torn trailing line a reader
// can always catch mid-append.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { serveRun, isOpenRun } from "../../src/node/index.ts";
import { LocalFsProvider, writeBundle, BundleProvider } from "@playtest/core/artifacts";

type LegacyTestValue = any; // SAFETY: run artifacts and JSON responses are dynamic

let tmpRoot: string;
let runsRoot: string;
let server: LegacyTestValue;
let base: string;

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-live-"));
  runsRoot = path.join(tmpRoot, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  server = await serveRun(runsRoot, { port: 0, open: false });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let seq = 0;

/** A run dir mid-recording: placeholder manifest plus a `case_start` event. */
function openRun(
  label: string,
  { status = "interrupted", healed = false, caseId = `todos/${label}`, caseStart = true }: LegacyTestValue = {},
) {
  const runId = `2026-07-28T09${String(seq++).padStart(2, "0")}-ab${String(seq).padStart(2, "0")}`;
  const dir = path.join(runsRoot, runId, ...caseId.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        schema_version: 1,
        run_id: runId,
        case: { id: caseId, file: path.join(tmpRoot, "suite", `${label}.yaml`), story: "Do the thing.", description: null, tags: [] },
        mode: "record",
        started_at: `2026-07-28T09:${String(seq).padStart(2, "0")}:00.000Z`,
        duration_ms: null,
        healed,
        pins: {},
        totals: { steps: 0 },
        result: { status, end_reason: null, error: null, gate: { pass: false, checks: [] } },
        artifacts: {},
      },
      null,
      2,
    ) + "\n",
  );
  if (caseStart) {
    event(dir, { type: "case_start", caseId, mode: "record", maxSteps: 20, actorModel: "gpt5_4_mini", graderModel: "gpt5_5", runDir: dir });
  }
  return { dir, rel: [runId, ...caseId.split("/")].join("/"), runId, caseId };
}

function event(dir: string, payload: Record<string, unknown>) {
  fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
}

function envelope(dir: string, step: number, extra: Record<string, unknown> = {}) {
  fs.appendFileSync(path.join(dir, "trajectory.jsonl"), JSON.stringify({ step, schema_version: 8, mode: "agent", ...extra }) + "\n");
}

async function live(rel: string, query = "") {
  const r = await fetch(`${base}/run/${rel}/live${query}`);
  assert.equal(r.status, 200, `live route answers 200 (${rel})`);
  return r.json() as LegacyTestValue;
}

const getJson = async (url: string) => {
  const r = await fetch(url);
  assert.equal(r.status, 200, `${url} should be 200`);
  return r.json() as LegacyTestValue;
};

// ---------- liveness from the event stream ----------

test("liveness: case_start with no terminal event is open; case_end seals it", () => {
  const run = openRun("bracket");
  const provider = new LocalFsProvider(runsRoot);
  assert.equal(isOpenRun(provider, run.rel), true, "recording");
  event(run.dir, { type: "step_start", step: 1, summary: "click Add" });
  assert.equal(isOpenRun(provider, run.rel), true, "still recording");
  event(run.dir, { type: "case_end", caseId: run.caseId, status: "pass" });
  assert.equal(isOpenRun(provider, run.rel), false, "sealed by the terminal event");
});

test("liveness degradations: no events.jsonl is a legacy sealed run, a missing case_start is non-live", () => {
  const provider = new LocalFsProvider(runsRoot);
  const legacy = openRun("legacy", { status: "pass", caseStart: false });
  assert.equal(fs.existsSync(path.join(legacy.dir, "events.jsonl")), false, "precondition: no event stream");
  assert.equal(isOpenRun(provider, legacy.rel), false, "a run recorded before events.jsonl existed is sealed");

  // Event writes are swallowed by design, so a lost case_start is possible; it
  // degrades to non-live rather than to a run that never seals.
  const headless = openRun("no-case-start", { caseStart: false });
  event(headless.dir, { type: "step_start", step: 1, summary: "click Add" });
  assert.equal(isOpenRun(provider, headless.rel), false, "no case_start: not live");
});

test("liveness: a torn trailing line falls back to the last whole one", () => {
  const provider = new LocalFsProvider(runsRoot);
  const run = openRun("torn");
  event(run.dir, { type: "case_end", caseId: run.caseId, status: "pass" });
  fs.appendFileSync(path.join(run.dir, "events.jsonl"), '{"ts":"2026-07-28T09:00:00.000Z","type":"wa');
  assert.equal(isOpenRun(provider, run.rel), false, "the half-written line is skipped, the seal still counts");
});

test("liveness: a .ptrun-backed provider is sealed by construction (no scan)", async () => {
  const run = openRun("bundled");
  envelope(run.dir, 1);
  const bundlePath = path.join(tmpRoot, "bundled.ptrun");
  await writeBundle(run.dir, bundlePath);
  const provider = BundleProvider.fromFile(bundlePath);
  assert.equal(typeof (provider as LegacyTestValue).readTail, "undefined", "a bundle serves no tail read");
  assert.equal(isOpenRun(provider as LegacyTestValue), false);

  const srv: LegacyTestValue = await serveRun(bundlePath, { port: 0, open: false });
  try {
    const body = await getJson(`http://127.0.0.1:${srv.address().port}/run/live`);
    assert.equal(body.open, false, "a bundle's live endpoint answers open: false");
    assert.deepEqual(body.lines, []);
  } finally {
    srv.close();
  }
});

// ---------- the live endpoint ----------

test("live: whole lines only, a cursor that pages, and the terminal transition", async () => {
  const run = openRun("stream");
  envelope(run.dir, 1);
  envelope(run.dir, 2);

  const first = await live(run.rel);
  assert.equal(first.open, true);
  assert.equal(first.reset, false);
  assert.equal(first.has_more, false);
  assert.equal(first.next, 2);
  assert.deepEqual(first.lines.map((l: string) => JSON.parse(l).step), [1, 2]);
  assert.equal(typeof first.manifest_generation, "number");
  assert.equal(typeof first.inactive_ms, "number");

  // A partial trailing line is held back until its newline lands.
  fs.appendFileSync(path.join(run.dir, "trajectory.jsonl"), '{"step":3,"mode":"ag');
  const partial = await live(run.rel, `?after=${first.next}`);
  assert.deepEqual(partial.lines, [], "no half line is ever delivered");
  assert.equal(partial.next, 2, "the cursor does not move over a partial line");

  fs.appendFileSync(path.join(run.dir, "trajectory.jsonl"), 'ent"}\n');
  const completed = await live(run.rel, `?after=${partial.next}`);
  assert.deepEqual(completed.lines.map((l: string) => JSON.parse(l).step), [3]);
  assert.equal(completed.open, true);

  event(run.dir, { type: "case_end", caseId: run.caseId, status: "pass" });
  const sealed = await live(run.rel, `?after=${completed.next}`);
  assert.equal(sealed.open, false, "the terminal event ends the conversation");
});

test("live: progress comes from the shared fold, inactivity from the last event append", async () => {
  const run = openRun("progress");
  event(run.dir, { type: "step_start", step: 3, summary: "click the Add button" });
  event(run.dir, { type: "step_result", step: 3, costSoFar: 0.42, tokens: { in: 10, out: 5 } });
  const body = await live(run.rel);
  assert.deepEqual(body.progress, {
    doing: "recording",
    max_steps: 20,
    model: "gpt5_4_mini",
    step: 3,
    action: "click the Add button",
    cost_usd: 0.42,
    tokens: { in: 10, out: 5 },
  });
  assert.ok(body.inactive_ms < 5000, "a run that just wrote an event is not inactive");

  // inactive_ms is a fact, not a diagnosis: it is the age of the last event.
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(path.join(run.dir, "events.jsonl"), old, old);
  const quiet = await live(run.rel);
  assert.ok(quiet.inactive_ms >= 110_000, `two minutes of silence is reported (${quiet.inactive_ms})`);
  assert.equal(quiet.open, true, "inactivity is never an abandonment claim");
});

test("live: responses are capped by line count and by bytes, and has_more pages the backlog", async () => {
  const run = openRun("caps");
  for (let i = 1; i <= 501; i++) envelope(run.dir, i);
  const first = await live(run.rel);
  assert.equal(first.lines.length, 500, "line cap");
  assert.equal(first.has_more, true, "the caller drains instead of long-polling");
  assert.equal(first.next, 500);
  const second = await live(run.rel, `?after=${first.next}`);
  assert.equal(second.lines.length, 1);
  assert.equal(second.has_more, false);
  assert.deepEqual(
    [...first.lines, ...second.lines].map((l: string) => JSON.parse(l).step),
    Array.from({ length: 501 }, (_, i) => i + 1),
    "every envelope arrives exactly once, in append order",
  );

  const big = openRun("caps-bytes");
  for (let i = 1; i <= 3; i++) envelope(big.dir, i, { pad: "x".repeat(300 * 1024) });
  const page = await live(big.rel);
  assert.equal(page.lines.length, 1, "byte cap");
  assert.equal(page.has_more, true);
});

test("live: an unhonorable cursor answers reset, and an absent run answers open: false", async () => {
  const run = openRun("reset");
  envelope(run.dir, 1);
  await live(run.rel);
  const body = await live(run.rel, "?after=99");
  assert.equal(body.reset, true, "a cursor past the host's truth is refused, never guessed");
  assert.equal(body.next, 0);
  assert.deepEqual(body.lines, []);

  const absent = await live("2020-01-01T0000-zzzz/nope");
  assert.equal(absent.open, false);
  assert.deepEqual(absent.lines, []);
});

test("live: the manifest generation bumps when the manifest is rewritten", async () => {
  const run = openRun("generation");
  const before = await live(run.rel);
  const same = await live(run.rel);
  assert.equal(same.manifest_generation, before.manifest_generation, "an unchanged manifest holds its generation");
  const manifest = path.join(run.dir, "manifest.json");
  fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace('"steps": 0', '"steps": 4'));
  const bumped = await live(run.rel);
  assert.notEqual(bumped.manifest_generation, before.manifest_generation, "clients compare inequality only");
});

test("live: a held poll wakes on a trajectory append", async () => {
  const run = openRun("wake-trajectory");
  const pending = live(run.rel, "?wait=5");
  setTimeout(() => envelope(run.dir, 1), 150);
  const started = Date.now();
  const body = await pending;
  assert.equal(body.lines.length, 1, "the appended envelope arrives on the same held request");
  assert.ok(Date.now() - started < 5000, "the hold ended on the signal, not on the timeout");
});

test("live: a held poll wakes on case_end with no new trajectory line", async () => {
  // The transition that would otherwise cost a full 25 s hold: the run finished,
  // and nothing new was appended to the trajectory.
  const run = openRun("wake-event");
  envelope(run.dir, 1);
  const caught = await live(run.rel);
  assert.equal(caught.next, 1);
  const pending = live(run.rel, `?after=${caught.next}&wait=5`);
  const started = Date.now();
  setTimeout(() => event(run.dir, { type: "case_end", caseId: run.caseId, status: "pass" }), 150);
  const body = await pending;
  assert.equal(body.open, false, "the seal is observed promptly");
  assert.ok(Date.now() - started < 5000, "…on the event signal, not the hold timeout");
});

test("live: a held poll wakes on a manifest rewrite", async () => {
  const run = openRun("wake-manifest");
  envelope(run.dir, 1);
  const caught = await live(run.rel);
  const pending = live(run.rel, `?after=${caught.next}&wait=5`);
  const started = Date.now();
  setTimeout(() => {
    const manifest = path.join(run.dir, "manifest.json");
    fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace('"steps": 0', '"steps": 9'));
  }, 150);
  const body = await pending;
  assert.notEqual(body.manifest_generation, caught.manifest_generation, "the generation bump is delivered");
  assert.ok(Date.now() - started < 5000, "…on the manifest signal");
});

test("live: a caught-up poll with no wait returns immediately", async () => {
  const run = openRun("no-wait");
  envelope(run.dir, 1);
  const caught = await live(run.rel);
  const started = Date.now();
  const body = await live(run.rel, `?after=${caught.next}`);
  assert.deepEqual(body.lines, []);
  assert.ok(Date.now() - started < 1000, "wait=0 never holds");
});

test("live: an in-place rewrite of the terminal envelope answers reset, never a fragment", async () => {
  // rewriteLast() annotates the already-written terminal envelope (custom
  // assertion evidence) while the run is still open. The file grows without
  // gaining a line, so the host must refuse the cursor rather than serve the
  // tail of a rewritten line as a new one.
  const run = openRun("rewrite");
  envelope(run.dir, 1);
  envelope(run.dir, 2);
  const caught = await live(run.rel);
  assert.equal(caught.next, 2);

  const file = path.join(run.dir, "trajectory.jsonl");
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  lines[lines.length - 1] = JSON.stringify({ ...JSON.parse(lines[lines.length - 1] as string), observed: { warehouse: { rows: 3 } } });
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const body = await live(run.rel, `?after=${caught.next}`);
  assert.equal(body.reset, true, "the client reloads instead of receiving a fragment");
  assert.deepEqual(body.lines, []);
  const reloaded = await live(run.rel);
  assert.equal(reloaded.reset, false, "a full reload is honored immediately");
  assert.deepEqual(reloaded.lines.map((l: string) => JSON.parse(l).step), [1, 2]);
  assert.equal(JSON.parse(reloaded.lines[1]).observed.warehouse.rows, 3, "…with the rewritten envelope");
});

// ---------- live projections ----------

test("/runs.json: an open run projects status null + open true; sealed entries are unchanged", async () => {
  const open = openRun("picker-open");
  const sealed = openRun("picker-sealed", { status: "pass" });
  event(sealed.dir, { type: "case_end", caseId: sealed.caseId, status: "pass" });

  const runs = await getJson(`${base}/runs.json`);
  const openEntry = runs.find((r: LegacyTestValue) => r.path === open.rel);
  assert.equal(openEntry.status, null, "no verdict yet — the existing vocabulary, no new enum value");
  assert.equal(openEntry.open, true);
  assert.equal(Object.keys(openEntry).indexOf("open"), Object.keys(openEntry).indexOf("status") + 1);

  const sealedEntry = runs.find((r: LegacyTestValue) => r.path === sealed.rel);
  assert.equal(sealedEntry.status, "pass");
  assert.equal("open" in sealedEntry, false, "a sealed entry gains no key at all");
});

test("/history.json and /changed.json exclude open runs until they seal", async () => {
  const run = openRun("history-open", { status: "pass", healed: true });
  const caseId = run.caseId;
  assert.deepEqual(await getJson(`${base}/history.json?case=${caseId}`), [], "a half-recorded run is not history");
  const changedWhileOpen = await getJson(`${base}/changed.json`);
  assert.equal(changedWhileOpen.some((e: LegacyTestValue) => e.run_id === run.runId), false, "…nor a review item");

  event(run.dir, { type: "case_end", caseId, status: "pass" });
  const history = await getJson(`${base}/history.json?case=${caseId}`);
  assert.equal(history.length, 1, "sealing publishes it");
  const changed = await getJson(`${base}/changed.json`);
  assert.equal(changed.some((e: LegacyTestValue) => e.run_id === run.runId), true);
});
