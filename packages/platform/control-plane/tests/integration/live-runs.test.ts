// Control-plane open runs — ingest, staging, serving, seal and GC
// (docs/contracts/hosted.md "Live runs").
//
// Each test boots a whole control plane against its own temporary SQLite data
// root and drives the runner protocol over real HTTP, exactly as a runner-agent
// would. No runner-agent, no browser, no model: L1 is the platform side, proven
// before any real traffic exists to send at it (L2 writes the uploader).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeBundle } from "@playtest/core/artifacts";
import { writeTar } from "../../src/suites/tar.ts";
import { runRetentionCycle } from "../../src/retention/worker.ts";
import { ulid } from "../../src/ulid.ts";
import { REPO_ROOT, createTarget, loadSuiteDir, withApp } from "./helpers.ts";
import { claimAndExchange } from "./exec-helpers.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A placeholder manifest shaped like the one the engine writes at case start:
 *  terminal-looking status from the first instant, by design. */
const placeholder = (runId: string, caseId: string, extra: HostedDynamic = {}) => ({
  run_id: runId,
  mode: "record",
  started_at: "2026-07-28T10:00:00.000Z",
  case: { id: caseId, story: "add a todo", description: "", tags: [] },
  result: { status: "interrupted" },
  ...extra,
});

const envelope = (step: number) => JSON.stringify({ type: "step", step, action: `click ${step}` });

/** Launch every story in the fixture suite and exchange a runner token for it. */
async function launch(api: HostedDynamic, base: HostedDynamic, key: string) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const { application, ring } = await createTarget(api, project, {
    key: "todos",
    name: "Todos",
    ringKey: "staging",
    baseUrl: "http://127.0.0.1:9",
    runnerLabels: ["self-hosted", "playtest"],
    config: { secret_env: {} },
  });
  const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "todos", name: "Todos" })).body;
  const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`));
  assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);
  const launched = await api.post(`/projects/${project.key}/run-groups`, {
    suite_id: suite.id,
    ring_id: ring.id,
    selection: { mode: "auto" },
  });
  assert.equal(launched.status, 200, JSON.stringify(launched.body));
  const groupId = launched.body.run_group.id;
  const { token } = await claimAndExchange(api, base, { project, groupId, labels: ["self-hosted", "playtest"] });
  const runner = liveClient(base, token, groupId);
  const spec = await fetch(`${base}/api/v1/runner/groups/${groupId}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  return { project, suite, application, ring, groupId, token, runner, spec };
}

/** The live half of the runner protocol, as a runner would speak it. */
function liveClient(base: string, token: string | null, groupId: string) {
  const auth: HostedDynamic = token ? { authorization: `Bearer ${token}` } : {};
  const jsonHeaders = { ...auth, "content-type": "application/json" };
  const call = async (url: string, init: HostedDynamic) => {
    const res = await fetch(url, init);
    return { status: res.status, body: await res.json() };
  };
  return {
    start: (runId: string) =>
      fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${runId}/start`, {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      }),
    open: (runId: string, manifest: HostedDynamic) =>
      call(`${base}/api/v1/runner/groups/${groupId}/cases/${runId}/open`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ manifest }),
      }),
    entry: (dbId: string, entry: string, body: Buffer) =>
      call(`${base}/api/v1/runner/runs/${dbId}/live/${entry}`, {
        method: "PUT",
        headers: { ...auth, "content-type": "application/octet-stream" },
        body,
      }),
    trajectory: (dbId: string, from_line: number, lines: string[]) =>
      call(`${base}/api/v1/runner/runs/${dbId}/live/trajectory`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ from_line, lines }),
      }),
    bundle: (dbId: string, bytes: Buffer) =>
      call(`${base}/api/v1/runner/runs/${dbId}/bundle`, {
        method: "PUT",
        headers: { ...auth, "content-type": "application/vnd.playtest.run-bundle" },
        body: bytes,
      }),
    report: (runId: string, body: HostedDynamic) =>
      call(`${base}/api/v1/runner/groups/${groupId}/cases/${runId}/report`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
  };
}

/** A real .ptrun on disk, so sealed serving goes through the real provider. */
async function buildBundle(dir: string, marker: string, entries: Record<string, string>) {
  const runDir = path.join(dir, `run-${marker}`);
  await fsp.mkdir(path.join(runDir, "steps"), { recursive: true });
  for (const [name, content] of Object.entries(entries)) {
    await fsp.mkdir(path.dirname(path.join(runDir, name)), { recursive: true });
    await fsp.writeFile(path.join(runDir, name), content);
  }
  const out = path.join(dir, `${marker}.ptrun`);
  writeBundle(runDir, out);
  return fsp.readFile(out);
}

const viewUrl = (base: string, project: HostedDynamic, run: HostedDynamic, entry: string) =>
  `${base}/api/v1/projects/${project.key}/view/run/${run.run_id}/${run.case_id}/${entry}`;

async function stagingOf(app: HostedDynamic, dbId: string) {
  const arts = await app.db.query(`SELECT * FROM live_artifacts WHERE run_id = $1 ORDER BY entry`, [dbId]);
  const lines = await app.db.query(`SELECT * FROM live_trajectory WHERE run_id = $1 ORDER BY from_line`, [dbId]);
  return { artifacts: arts.rows, batches: lines.rows };
}

test("open → acked staged ingest → pre-bundle serving → live paging and streaming → seal", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-live-"));
  try {
    await withApp(async ({ api, base, app, storeRoot }: HostedDynamic) => {
      const { project, groupId, token, runner, spec } = await launch(api, base, "live-lifecycle");
      const target = spec.cases[0];
      const other = spec.cases[1];
      const run = { run_id: target.run_id, case_id: target.case_id };
      assert.equal((await runner.start(target.run_id)).status, 200);

      // ---------- open: idempotent, generation bumps only on real change ----------
      const first = await runner.open(target.run_id, placeholder(target.run_id, target.case_id));
      assert.equal(first.status, 200);
      assert.deepEqual(first.body, { accepted: true, open: true, manifest_generation: 1 });
      const again = await runner.open(target.run_id, placeholder(target.run_id, target.case_id));
      assert.equal(again.body.manifest_generation, 1, "an identical re-open does not churn a watching viewer");
      const rewritten = await runner.open(target.run_id, placeholder(target.run_id, target.case_id, { duration_ms: 4200 }));
      assert.equal(rewritten.body.manifest_generation, 2, "a rewritten manifest snapshot bumps the generation");

      // ---------- staged step artifacts: unique, immutable, single-charge ----------
      const png = Buffer.from("\x89PNG step one");
      const accepted = await runner.entry(target.db_id, "steps/001.png", png);
      assert.equal(accepted.body.accepted, true, JSON.stringify(accepted.body));
      assert.equal(accepted.body.size, png.length);
      const retried = await runner.entry(target.db_id, "steps/001.png", png);
      assert.equal(retried.body.accepted, true);
      assert.equal(retried.body.duplicate, true, "an identical-bytes retry replays the original ack");
      const charged = await app.db.query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM live_artifacts WHERE run_id = $1`,
        [target.db_id],
      );
      assert.equal(Number(charged.rows[0].n), 1, "the retry created no second row");
      assert.equal(Number(charged.rows[0].bytes), png.length, "and charged the budget exactly once");

      const divergentBytes = await runner.entry(target.db_id, "steps/001.png", Buffer.from("different pixels"));
      assert.equal(divergentBytes.body.accepted, false);
      assert.equal(divergentBytes.body.reason, "immutable");

      for (const bad of ["video.mp4", "steps%2F..%2F..%2Fetc%2Fpasswd", "manifest.json"]) {
        const refusal = await runner.entry(target.db_id, bad, Buffer.from("x"));
        assert.equal(refusal.body.accepted, false, bad);
        assert.equal(refusal.body.reason, "shape", bad);
      }

      // ---------- trajectory: append, verified overlap, divergence, gap ----------
      const [l1, l2, l3] = [envelope(1), envelope(2), envelope(3)];
      const lines: string[] = [l1, l2, l3];
      const appended = await runner.trajectory(target.db_id, 0, lines);
      assert.deepEqual(appended.body, { accepted: true, lines: 3, appended: 3 });

      const overlap = await runner.trajectory(target.db_id, 1, [l2, l3, envelope(4)]);
      assert.deepEqual(overlap.body, { accepted: true, lines: 4, appended: 1 }, "an overlap is verified then deduplicated");

      const wholeDuplicate = await runner.trajectory(target.db_id, 0, lines);
      assert.deepEqual(wholeDuplicate.body, { accepted: true, lines: 4, appended: 0 }, "a resend that stops short is not divergence");

      const divergent = await runner.trajectory(target.db_id, 1, [envelope(99), envelope(100)]);
      assert.equal(divergent.body.accepted, false);
      assert.equal(divergent.body.reason, "divergent");
      assert.equal(divergent.body.lines, 4, "a refusal still carries the authoritative count");

      const gap = await runner.trajectory(target.db_id, 9, [envelope(10)]);
      assert.equal(gap.body.accepted, false);
      assert.equal(gap.body.reason, "gap");
      assert.equal(gap.body.lines, 4, "the count tells the uploader exactly where to rewind");
      const rewound = await runner.trajectory(target.db_id, gap.body.lines, [envelope(5)]);
      assert.deepEqual(rewound.body, { accepted: true, lines: 5, appended: 1 });

      const newlineInLine = await runner.trajectory(target.db_id, 5, ["{}\n{}"]);
      assert.equal(newlineInLine.body.reason, "shape");

      // ---------- serving, before any bundle exists ----------
      const manifestRes = await fetch(viewUrl(base, project, run, "manifest.json"));
      assert.equal(manifestRes.status, 200, "the viewer's first fetch works from `open` onward");
      assert.equal((await manifestRes.json()).run_id, target.run_id);

      const trajectoryRes = await fetch(viewUrl(base, project, run, "trajectory.jsonl"));
      assert.equal(trajectoryRes.status, 200);
      const served = (await trajectoryRes.text()).split("\n").filter(Boolean);
      assert.deepEqual(served, [...lines, envelope(4), envelope(5)], "append order is preserved exactly");

      const pngRes = await fetch(viewUrl(base, project, run, "steps/001.png"));
      assert.equal(pngRes.status, 200);
      assert.deepEqual(Buffer.from(await pngRes.arrayBuffer()), png);

      // A `pending` reservation is a byte range that may not exist yet: owned by
      // the ledger, never served.
      await app.db.query(
        `INSERT INTO live_artifacts (id, run_id, entry, key, state, size, sha256)
           VALUES ($1, $2, 'steps/002.png', $3, 'pending', 12, 'deadbeef')`,
        [ulid(), target.db_id, `runs/${groupId}/live/${target.db_id}/steps/002.png`],
      );
      assert.equal((await fetch(viewUrl(base, project, run, "steps/002.png"))).status, 404, "readers serve `ready` only");

      // ---------- picker projections ----------
      const picker = await api.get(`/projects/${project.key}/view/runs.json`);
      const entry = picker.body.find((r: HostedDynamic) => r.path === `${run.run_id}/${run.case_id}`);
      assert.ok(entry, "an open run appears in the picker");
      assert.equal(entry.status, null, "an open run keeps the existing no-verdict vocabulary");
      assert.equal(entry.open, true, "and adds the additive open flag");
      assert.equal(entry.story, "add a todo", "the rest is the placeholder manifest, projected verbatim");
      const history = await api.get(`/projects/${project.key}/view/history.json?case=${run.case_id}`);
      assert.equal(history.body.length, 0, "a half-recorded run is not history");
      const changed = await api.get(`/projects/${project.key}/view/changed.json`);
      assert.equal(changed.body.length, 0, "nor a review item");

      // ---------- the live endpoint: backlog paging, then streaming ----------
      const backlog = Array.from({ length: 700 }, (_, i) => envelope(100 + i));
      assert.equal((await runner.trajectory(target.db_id, 5, backlog)).body.lines, 705);

      const page1 = await fetch(`${viewUrl(base, project, run, "live")}?after=0`).then((r) => r.json());
      assert.equal(page1.open, true);
      assert.equal(page1.reset, false);
      assert.equal(page1.lines.length, 500, "a late joiner is paged through the backlog in bounded responses");
      assert.equal(page1.next, 500);
      assert.equal(page1.has_more, true, "has_more says drain immediately, do not long-poll");
      assert.equal(page1.manifest_generation, 2);
      assert.equal(page1.lines[0], lines[0]);

      const page2 = await fetch(`${viewUrl(base, project, run, "live")}?after=500`).then((r) => r.json());
      assert.equal(page2.lines.length, 205);
      assert.equal(page2.next, 705);
      assert.equal(page2.has_more, false, "the client is caught up");
      assert.equal(page2.lines.at(-1), backlog.at(-1));

      const beyond = await fetch(`${viewUrl(base, project, run, "live")}?after=9000`).then((r) => r.json());
      assert.equal(beyond.reset, true, "a cursor the host cannot honor answers reset rather than guessing");
      assert.deepEqual(beyond.lines, []);

      // A caught-up caller is HELD, and live ingest wakes it.
      const held = fetch(`${viewUrl(base, project, run, "live")}?after=705&wait=20`).then((r) => r.json());
      const startedHolding = Date.now();
      await new Promise((r) => setTimeout(r, 250));
      assert.equal((await runner.trajectory(target.db_id, 705, [envelope(999)])).body.lines, 706);
      const streamed = await held;
      const holdMs = Date.now() - startedHolding;
      assert.ok(holdMs >= 250, `a caught-up caller is held, not answered empty (held ${holdMs}ms)`);
      assert.ok(holdMs < 15_000, `ingest wakes the holder rather than waiting the hold out (held ${holdMs}ms)`);
      assert.deepEqual(streamed.lines, [envelope(999)]);
      assert.equal(streamed.next, 706);
      assert.equal(streamed.open, true);

      // `progress` decorates the in-flight edge and comes from the snapshot the
      // runner already posts — no second vocabulary, no new whitelisted field.
      assert.equal(streamed.progress, null, "no snapshot has landed yet");
      await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${target.run_id}/progress`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ step: 7, max_steps: 20, doing: "recording", action: "click Add", cost_usd: 0.12 }),
      });
      const decorated = await fetch(`${viewUrl(base, project, run, "live")}?after=706`).then((r) => r.json());
      assert.equal(decorated.progress.step, 7);
      assert.equal(decorated.progress.doing, "recording");
      assert.equal(decorated.progress.action, "click Add");
      assert.ok(decorated.inactive_ms >= 0 && decorated.inactive_ms < 60_000, "inactive_ms reports, it does not diagnose");

      // ---------- seal: a verified bundle, and staging goes ----------
      const bundleEntries = {
        "manifest.json": JSON.stringify({ ...placeholder(target.run_id, target.case_id), result: { status: "pass" } }),
        "trajectory.jsonl": `${envelope(1)}\n`,
        "steps/001.png": "SEALED PIXELS",
      };
      const bytes = await buildBundle(tmp, "sealed", bundleEntries);
      const stagedKeys = (await stagingOf(app, target.db_id)).artifacts.map((a: HostedDynamic) => a.key);
      assert.ok(stagedKeys.length >= 2, "there is staged object state to clean up");
      // A viewer holding through the seal must learn about it on the next wake,
      // not at the end of a full hold with no new trajectory line.
      const holdingThroughSeal = fetch(`${viewUrl(base, project, run, "live")}?after=706&wait=20`).then((r) => r.json());
      await new Promise((r) => setTimeout(r, 250));
      const uploaded = await runner.bundle(target.db_id, bytes);
      assert.equal(uploaded.status, 200);
      const reported = await runner.report(target.run_id, {
        status: "pass",
        bundle: uploaded.body.artifact,
        score: 90,
        manifest: JSON.parse(bundleEntries["manifest.json"]),
      });
      assert.equal(reported.status, 200);
      assert.equal((await holdingThroughSeal).open, false, "the seal ends the held conversation");

      const afterSeal = await stagingOf(app, target.db_id);
      assert.deepEqual(afterSeal.artifacts, [], "ledger rows go in the report transaction");
      assert.deepEqual(afterSeal.batches, []);
      for (const key of stagedKeys) {
        assert.equal(fs.existsSync(path.join(storeRoot, key)), false, `staged object ${key} is gone after commit`);
      }
      const closed = await fetch(`${viewUrl(base, project, run, "live")}?after=706`).then((r) => r.json());
      assert.equal(closed.open, false, "open: false ends the conversation");

      // Sealed serving is byte-identical to a run that was never live.
      const neverLive = { run_id: other.run_id, case_id: other.case_id };
      const twin = await runner.bundle(other.db_id, bytes);
      await runner.report(other.run_id, {
        status: "pass",
        bundle: twin.body.artifact,
        score: 90,
        manifest: JSON.parse(bundleEntries["manifest.json"]),
      });
      for (const name of ["manifest.json", "trajectory.jsonl", "steps/001.png"]) {
        const wasLive = Buffer.from(await (await fetch(viewUrl(base, project, run, name))).arrayBuffer());
        const wasNot = Buffer.from(await (await fetch(viewUrl(base, project, neverLive, name))).arrayBuffer());
        assert.deepEqual(wasLive, wasNot, `${name} serves the sealed bytes either way`);
        assert.equal(wasLive.toString(), bundleEntries[name as keyof typeof bundleEntries]);
      }

      // ---------- terminal is a no-op refusal on every live route ----------
      const late = await runner.trajectory(target.db_id, 706, [envelope(1000)]);
      assert.equal(late.body.accepted, false);
      assert.equal(late.body.reason, "terminal");
      const lateEntry = await runner.entry(target.db_id, "steps/900.png", Buffer.from("late"));
      assert.equal(lateEntry.body.reason, "terminal");
      const lateOpen = await runner.open(target.run_id, placeholder(target.run_id, target.case_id));
      assert.equal(lateOpen.body.reason, "terminal");
      assert.deepEqual((await stagingOf(app, target.db_id)).batches, [], "a refused call stages nothing");

      // The sealed run is history again, and carries no `open` key.
      const sealedPicker = await api.get(`/projects/${project.key}/view/runs.json`);
      const sealedEntry = sealedPicker.body.find((r: HostedDynamic) => r.path === `${run.run_id}/${run.case_id}`);
      assert.equal(sealedEntry.status, "pass");
      assert.equal("open" in sealedEntry, false, "a sealed entry carries no open key at all");
      assert.equal((await api.get(`/projects/${project.key}/view/history.json?case=${run.case_id}`)).body.length, 1);
    });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("a terminal report without a bundle keeps staging; GC collects it after the grace window", async () => {
  await withApp(async ({ api, base, app, storeRoot }: HostedDynamic) => {
    const { project, runner, spec } = await launch(api, base, "live-infra");
    const target = spec.cases[0];
    const run = { run_id: target.run_id, case_id: target.case_id };
    await runner.start(target.run_id);
    await runner.open(target.run_id, placeholder(target.run_id, target.case_id));
    await runner.entry(target.db_id, "steps/001.png", Buffer.from("evidence"));
    await runner.trajectory(target.db_id, 0, [envelope(1), envelope(2)]);
    const key = (await stagingOf(app, target.db_id)).artifacts[0].key;

    // The bundle upload failed, so the runner reports infra with no bundle.
    assert.equal((await runner.report(target.run_id, { status: "infra", error: "bundle upload failed" })).status, 200);

    const kept = await stagingOf(app, target.db_id);
    assert.equal(kept.artifacts.length, 1, "staging is the only evidence this run produced");
    assert.equal(kept.batches.length, 1);
    assert.equal((await fetch(viewUrl(base, project, run, "trajectory.jsonl"))).status, 200, "and stays readable");
    assert.equal((await fetch(viewUrl(base, project, run, "steps/001.png"))).status, 200);
    assert.equal((await fetch(`${viewUrl(base, project, run, "live")}?after=0`).then((r) => r.json())).open, false);
    const picker = await api.get(`/projects/${project.key}/view/runs.json`);
    assert.equal(
      picker.body.some((r: HostedDynamic) => r.path === `${run.run_id}/${run.case_id}`),
      false,
      "a terminal run that reported no manifest stays out of the picker: the placeholder's status is not its verdict",
    );

    // Inside the grace window a cycle leaves it entirely alone.
    const now = new Date();
    const early: HostedDynamic = await runRetentionCycle(app.ctx, { now, integritySample: 0 });
    assert.equal(early.live_staging_collected, 0);
    assert.equal((await stagingOf(app, target.db_id)).artifacts.length, 1);
    assert.equal(fs.existsSync(path.join(storeRoot, key)), true, "the orphan sweep never touches owned staging");

    // After it, the ledger rows and their objects go together.
    const late: HostedDynamic = await runRetentionCycle(app.ctx, {
      now: new Date(now.getTime() + DAY_MS + 60_000),
      integritySample: 0,
    });
    assert.ok(late.live_staging_collected >= 2, JSON.stringify(late));
    const swept = await stagingOf(app, target.db_id);
    assert.deepEqual(swept.artifacts, []);
    assert.deepEqual(swept.batches, []);
    assert.equal(fs.existsSync(path.join(storeRoot, key)), false, "objects go with their rows");
    assert.equal((await fetch(viewUrl(base, project, run, "trajectory.jsonl"))).status, 404);
  });
});

test("stale pending reservations are reaped and refunded; an owned reservation survives the orphan sweep", async () => {
  await withApp(async ({ api, base, app, storeRoot }: HostedDynamic) => {
    const { project, groupId, runner, spec } = await launch(api, base, "live-pending");
    const target = spec.cases[0];
    await runner.start(target.run_id);
    await runner.open(target.run_id, placeholder(target.run_id, target.case_id));
    await runner.entry(target.db_id, "steps/001.png", Buffer.from("ready bytes"));

    // Two reservations whose upload crashed between reserving and marking ready:
    // one fresh (in flight right now), one older than the grace window.
    const reserve = async (entry: string, ageMs: number, size: number) => {
      const key = `runs/${groupId}/live/${target.db_id}/${entry}`;
      await app.store.put(key, Buffer.alloc(size, 7));
      await app.db.query(
        `INSERT INTO live_artifacts (id, run_id, entry, key, state, size, sha256, created_at)
           VALUES ($1, $2, $3, $4, 'pending', $5, 'abc', $6)`,
        [ulid(), target.db_id, entry, key, size, new Date(Date.now() - ageMs)],
      );
      return key;
    };
    const fresh = await reserve("steps/002.png", 1000, 40);
    const stale = await reserve("steps/003.png", DAY_MS + 60_000, 4000);

    // A sweep run mid-stream sees BOTH reservations as owned: the row is
    // committed before the object exists, so no unowned-live-object window ever
    // opens for the orphan sweep to find.
    const cycle: HostedDynamic = await runRetentionCycle(app.ctx, { integritySample: 0 });
    assert.equal(fs.existsSync(path.join(storeRoot, fresh)), true, "an in-flight reservation is untouched");
    assert.equal(cycle.live_staging_collected, 1, "only the stale reservation is reaped");
    assert.equal(fs.existsSync(path.join(storeRoot, stale)), false, "its object goes with it");

    const remaining = await stagingOf(app, target.db_id);
    assert.deepEqual(remaining.artifacts.map((a: HostedDynamic) => a.entry), ["steps/001.png", "steps/002.png"]);
    const charged = await app.db.query(`SELECT COALESCE(SUM(size), 0) AS bytes FROM live_artifacts WHERE run_id = $1`, [
      target.db_id,
    ]);
    assert.equal(Number(charged.rows[0].bytes), "ready bytes".length + 40, "the stale reservation's budget is refunded");

    // The run never stopped, and its `ready` evidence is untouched by any of it.
    const served = await fetch(viewUrl(base, project, { run_id: target.run_id, case_id: target.case_id }, "steps/001.png"));
    assert.equal(served.status, 200);
    assert.equal(await served.text(), "ready bytes");
  });
});

test("live ingest refuses budget exhaustion and oversized lines, and every route is behind the runner token", async () => {
  await withApp(
    async ({ api, base, app, storeRoot }: HostedDynamic) => {
      const { groupId, token, runner, spec } = await launch(api, base, "live-budget");
      const target = spec.cases[0];
      const stranger = spec.cases[1];
      await runner.start(target.run_id);
      await runner.open(target.run_id, placeholder(target.run_id, target.case_id));

      // ---------- auth ----------
      const anonymous = liveClient(base, null, groupId);
      const noToken = await fetch(`${base}/api/v1/runner/runs/${target.db_id}/live/steps/001.png`, {
        method: "PUT",
        body: Buffer.from("x"),
      });
      assert.equal(noToken.status, 401, "no runner token, no staging");
      assert.equal((await anonymous.trajectory(target.db_id, 0, [envelope(1)])).status, 401);

      const otherGroup = await launch(api, base, "live-budget-other");
      const crossGroup = liveClient(base, otherGroup.token, otherGroup.groupId);
      assert.equal(
        (await crossGroup.entry(target.db_id, "steps/001.png", Buffer.from("x"))).status,
        403,
        "a token scoped to another group cannot stage into this run",
      );
      assert.equal((await crossGroup.trajectory(target.db_id, 0, [envelope(1)])).status, 403);
      const wrongGroupOpen = await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${target.run_id}/open`, {
        method: "POST",
        headers: { authorization: `Bearer ${otherGroup.token}`, "content-type": "application/json" },
        body: JSON.stringify({ manifest: placeholder(target.run_id, target.case_id) }),
      });
      assert.equal(wrongGroupOpen.status, 403);

      // ---------- a run nobody opened stages nothing ----------
      const unopened = await runner.entry(stranger.db_id, "steps/001.png", Buffer.from("x"));
      assert.equal(unopened.body.accepted, false);
      assert.equal(unopened.body.reason, "not_open");

      // ---------- the per-run budget (1 MiB here) is an explicit refusal ----------
      const chunk = Buffer.alloc(400 * 1024, 1);
      for (const n of [1, 2]) {
        const ack = await runner.entry(target.db_id, `steps/00${n}.png`, chunk);
        assert.equal(ack.body.accepted, true, `entry ${n} fits`);
      }
      const overflow = await runner.entry(target.db_id, "steps/003.png", chunk);
      assert.equal(overflow.body.accepted, false);
      assert.equal(overflow.body.reason, "budget", JSON.stringify(overflow.body));
      assert.equal(overflow.body.budget_bytes, 1024 * 1024);
      assert.equal(
        fs.existsSync(path.join(storeRoot, `runs/${groupId}/live/${target.db_id}/steps/003.png`)),
        false,
        "a refused entry writes no object",
      );
      const refusedTrajectory = await runner.trajectory(target.db_id, 0, [`{"pad":"${"x".repeat(300 * 1024)}"}`]);
      assert.equal(refusedTrajectory.body.accepted, false);
      assert.equal(refusedTrajectory.body.reason, "budget");
      assert.equal(refusedTrajectory.body.lines, 0);

      // The staged bytes are exactly the two accepted entries: nothing leaked.
      const charged = await app.db.query(
        `SELECT COALESCE(SUM(size), 0) AS bytes FROM live_artifacts WHERE run_id = $1`,
        [target.db_id],
      );
      assert.equal(Number(charged.rows[0].bytes), 2 * chunk.length);
    },
    { PLAYTEST_LIVE_BUDGET_MB: "1" },
  );
});

test("a single line over the line cap is refused with its own reason, and stops nothing else", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const { runner, spec } = await launch(api, base, "live-bigline");
    const target = spec.cases[0];
    await runner.start(target.run_id);
    await runner.open(target.run_id, placeholder(target.run_id, target.case_id));
    const huge = `{"pad":"${"x".repeat(4 * 1024 * 1024 + 16)}"}`;
    const refused = await runner.trajectory(target.db_id, 0, [huge]);
    assert.equal(refused.body.accepted, false);
    assert.equal(refused.body.reason, "line_too_large");
    assert.equal(refused.body.max_line_bytes, 4 * 1024 * 1024);
    assert.equal(refused.body.lines, 0, "nothing was stored");
    assert.deepEqual((await runner.trajectory(target.db_id, 0, [envelope(1)])).body, {
      accepted: true,
      lines: 1,
      appended: 1,
    });
  });
});
