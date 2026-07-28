import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { withApp, createTarget } from "./helpers.ts";
import { writeBundle } from "@playtest/core/artifacts";
import { runRetentionCycle, RETENTION_LEASE } from "../../src/retention/worker.ts";
import { claimLease, readLease } from "../../src/leases.ts";
import { ulid } from "../../src/ulid.ts";

const NOW = new Date("2026-07-06T00:00:00.000Z");

test("phase5 retention lifecycle and on-demand clips", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-phase5-"));
  try {
    await withApp(async ({ base, api, app }: HostedDynamic) => {
      const { project, suite, application, ring, snapshotId } = await seedProject(api, app);
      const groupId = ulid();
      await app.db.query(
        `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, application_id, ring_id, trigger, selection, status)
           VALUES ($1, $2, $3, $4, $5, $6, '{}', '{}', 'done')`,
        [groupId, project.id, suite.id, snapshotId, application.id, ring.id],
      );

      // coreRun is past core_days but a current baseline keeps it at core (never meta).
      const coreRun = await seedRun(app, tmp, { groupId, caseId: "baseline-case", daysOld: 25 });
      const metaRun = await seedRun(app, tmp, { groupId, caseId: "expired-case", daysOld: 35, initialTier: "core", prunedDaysOld: 25 });
      // pendingRun is past core_days but a pending candidate keeps its evidence at core.
      const pendingRun = await seedRun(app, tmp, { groupId, caseId: "pending-case", daysOld: 35, initialTier: "core" });
      const clipRun = await seedRun(app, tmp, { groupId, caseId: "clip-case", daysOld: 1 });

      await app.db.query(
        `INSERT INTO baselines (id, project_id, suite_id, story_id, version, trajectory_key, meta, accepted_from_run_id)
           VALUES ($1, $2, $3, $4, 1, $5, '{}', $6)`,
        [ulid(), project.id, suite.id, coreRun.caseId, `${coreRun.bundleKey}#trajectory.jsonl`, coreRun.id],
      );
      await app.db.query(
        `INSERT INTO candidates (id, project_id, suite_id, story_id, run_id, trajectory_key, meta, status)
           VALUES ($1, $2, $3, $4, $5, $6, '{}', 'pending')`,
        [ulid(), project.id, suite.id, pendingRun.caseId, pendingRun.id, `${pendingRun.bundleKey}#trajectory.jsonl`],
      );
      await app.db.query(
        `INSERT INTO run_events (run_id, seq, ts, type, payload)
           VALUES ($1, 1, $2, 'old_event', '{}')`,
        [coreRun.id, new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000)],
      );
      await app.store.put("runs/orphan.ptrun", Buffer.from("orphan"));

      // Retention is deployment-wide now (no per-project policy API): the cycle
      // takes the resolved config directly.
      const summary: HostedDynamic = await runRetentionCycle(app.ctx, {
        now: NOW,
        integritySample: 0,
        retention: { events_days: 1, full_days: 7, core_days: 20 },
      });
      assert.equal(summary.skipped, false);
      assert.equal(summary.events_pruned, 1);
      assert.equal(summary.tiered_to_core, 1);
      assert.equal(summary.tiered_to_meta, 1);
      assert.ok(summary.orphan_objects_deleted >= 3, JSON.stringify(summary));

      const core = (await api.get(`/runs/${coreRun.id}`)).body;
      assert.equal(core.artifact_tier, "core");
      assert.equal(core.artifact.tier, "core");
      assert.equal(await app.store.has(coreRun.bundleKey), false, "old full bundle deleted after core rewrite");
      assert.equal((await viewFetch(base, project.key, coreRun, "trajectory.jsonl")).status, 200);
      assert.equal((await viewFetch(base, project.key, coreRun, "steps/001.png")).status, 404);
      const baseline = await app.db.query(`SELECT trajectory_key FROM baselines WHERE accepted_from_run_id = $1`, [coreRun.id]);
      assert.match(baseline.rows[0].trajectory_key, /\.core\.ptrun#trajectory\.jsonl$/, "baseline trajectory ref retargeted to core bundle");

      const meta = (await api.get(`/runs/${metaRun.id}`)).body;
      assert.equal(meta.artifact_tier, "meta");
      assert.equal(meta.artifact, null);
      assert.equal((await api.get(`/runs/${metaRun.id}/download`)).status, 404);
      assert.equal((await viewFetch(base, project.key, metaRun, "manifest.json")).status, 404);

      // A pending baseline candidate protects its run's evidence from deletion to meta.
      const pending = (await api.get(`/runs/${pendingRun.id}`)).body;
      assert.equal(pending.artifact_tier, "core");
      assert.equal(pending.artifact.tier, "core");
      assert.equal((await viewFetch(base, project.key, pendingRun, "trajectory.jsonl")).status, 200);

      const audits = await app.db.query(`SELECT action, detail FROM audit_log WHERE project_id = $1 ORDER BY ts`, [project.id]);
      assert.equal(audits.rows.filter((r: HostedDynamic) => r.action === "retention.pruned").length, 2);
      assert.ok(audits.rows.some((r: HostedDynamic) => r.action === "retention.pruned" && r.detail.to_sha256));

      // Export clip: first POST starts one generation; repeated clicks while it is
      // in flight are idempotent — the server never starts a second generation.
      const clipStart = await api.post(`/runs/${clipRun.id}/clip`, { captions: "action", burn: true });
      assert.equal(clipStart.status, 202, JSON.stringify(clipStart.body));
      // The retry either joins the in-flight generation (202) or finds it already
      // done (200 ready) — never starts a second one.
      const retry = await api.post(`/runs/${clipRun.id}/clip`, { captions: "action", burn: true });
      assert.ok([200, 202].includes(retry.status), JSON.stringify(retry.body));
      const clipped = await waitForClip(api, clipRun.id);
      assert.equal(clipped.clip.tier, "full");
      const mediaDispatches = await app.db.query(
        `SELECT COUNT(*) AS n FROM dispatches WHERE kind = 'media' AND ref_id = $1`,
        [clipRun.id],
      );
      assert.equal(mediaDispatches.rows[0].n, 1, "repeated Export-clip clicks start exactly one generation");
      // An existing clip downloads in one GET, with no regeneration.
      const clip = await api.get(`/runs/${clipRun.id}/clip`);
      assert.equal(clip.status, 200);
      assert.equal(clip.body.subarray(4, 8).toString("ascii"), "ftyp", "generated clip is an MP4");
    });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

async function seedProject(api: HostedDynamic, app: HostedDynamic) {
  const project = (await api.post("/projects", { key: "phase5", name: "Phase 5" })).body;
  // The application and its ring come first: a suite binds to an application at
  // creation, and a run group records both. Nothing here is ever dialed.
  const { application, ring } = await createTarget(api, project, { ringKey: "staging", baseUrl: "http://127.0.0.1:1" });
  const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "s", name: "Suite" })).body;
  const commit = await api.post(`/suites/${suite.id}/commit`, {
    changes: [{ path: "playtest.yaml", content: "app:\n  base_url: http://127.0.0.1:1\n" }],
    note: "seed",
  });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  const snap = await app.db.query(`SELECT id FROM suite_snapshots WHERE suite_id = $1 ORDER BY seq DESC LIMIT 1`, [suite.id]);
  return { project, suite, application, ring, snapshotId: snap.rows[0].id };
}

async function seedRun(app: HostedDynamic, tmp: HostedDynamic, { groupId, caseId, daysOld, initialTier = "full", prunedDaysOld = null }: HostedDynamic) {
  const id = ulid();
  const runId = `run-${caseId}`;
  const finishedAt = new Date(NOW.getTime() - daysOld * 24 * 60 * 60 * 1000);
  const prunedAt = prunedDaysOld == null ? null : new Date(NOW.getTime() - prunedDaysOld * 24 * 60 * 60 * 1000);
  const { bytes, manifest } = await buildBundle(tmp, { runId, caseId, startedAt: finishedAt });
  await app.db.query(
    `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode, manifest, totals,
                       score, duration_ms, started_at, finished_at, artifact_tier,
                       retention_pruned_at, retention_provenance, created_at, updated_at)
       VALUES ($1, $2, $3, $3, $4, 'pass', 'record', $5, $6, 90, 1000, $7, $7, $8, $9, $10, $7, $7)`,
    [
      id,
      groupId,
      caseId,
      runId,
      JSON.stringify(manifest),
      JSON.stringify({ cost_usd: 0.01 }),
      finishedAt,
      initialTier,
      prunedAt,
      JSON.stringify(prunedAt ? { from: "full", to: "core", policy_days: 7 } : {}),
    ],
  );
  const bundleKey = `runs/${groupId}/${id}.ptrun`;
  const stored = await app.store.put(bundleKey, bytes);
  await app.db.query(
    `INSERT INTO artifacts (id, run_id, kind, key, sha256, size, tier, verified_at)
       VALUES ($1, $2, 'bundle', $3, $4, $5, $6, $7)`,
    [ulid(), id, bundleKey, stored.sha256, stored.size, initialTier, finishedAt],
  );
  return { id, runId, caseId, bundleKey };
}

async function buildBundle(tmp: HostedDynamic, { runId, caseId, startedAt }: HostedDynamic) {
  const runDir = path.join(tmp, `${runId}-${caseId}`);
  await fsp.mkdir(path.join(runDir, "steps"), { recursive: true });
  const manifest = {
    run_id: runId,
    mode: "record",
    healed: false,
    started_at: startedAt.toISOString(),
    duration_ms: 1000,
    video_started_at: null,
    case: { id: caseId, story: `Story for ${caseId}`, app: { base_url: "http://example.test" } },
    result: { status: "pass" },
    artifacts: { trajectory: "trajectory.jsonl", grade: "grade.json" },
    totals: { cost_usd: 0.01 },
    pins: { grader_model: "sonnet" },
  };
  const env = {
    step: 1,
    ts: startedAt.getTime(),
    mode: "record",
    artifacts: { screenshot: "steps/001.png", a11y: "steps/001.a11y.txt" },
    agent: { action: { type: "click", ref: "e1" }, thought: "click the primary control" },
    resolution: { locator: 'text="Save"' },
  };
  await fsp.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await fsp.writeFile(path.join(runDir, "trajectory.jsonl"), JSON.stringify(env) + "\n");
  await fsp.writeFile(path.join(runDir, "grade.json"), JSON.stringify({ score: 90, summary: "ok" }));
  await fsp.writeFile(path.join(runDir, "video.vtt"), "WEBVTT\n\n");
  await fsp.writeFile(path.join(runDir, "context.jsonl"), JSON.stringify({ url: "http://example.test" }) + "\n");
  await fsp.writeFile(path.join(runDir, "steps/001.a11y.txt"), '[e1] button "Save"\n');
  await fsp.writeFile(path.join(runDir, "steps/001.png"), png2x2());
  await fsp.writeFile(path.join(runDir, "trace.zip"), Buffer.from("trace"));
  const out = path.join(tmp, `${runId}-${caseId}.ptrun`);
  writeBundle(runDir, out);
  return { bytes: await fsp.readFile(out), manifest };
}

async function waitForClip(api: HostedDynamic, runId: HostedDynamic, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await api.get(`/runs/${runId}`);
    if (last.body.clip) return last.body;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`clip was not generated: ${JSON.stringify(last?.body)}`);
}

function viewFetch(base: HostedDynamic, projectKey: HostedDynamic, run: HostedDynamic, entry: HostedDynamic) {
  return fetch(`${base}/api/v1/projects/${projectKey}/view/run/${run.runId}/${run.caseId}/${entry}`);
}

function png2x2() {
  const sig = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from([
    0, 255, 255, 255, 40, 120, 220,
    0, 40, 120, 220, 255, 255, 255,
  ]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type: HostedDynamic, data: HostedDynamic) {
  const name = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([len, name, data, crc]);
}

function crc32(buf: HostedDynamic) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

// --- S2: the retention cycle is lease-protected, not flag-protected ----------

test("retention cycles do not overlap and a lease left by a dead process is recovered", async () => {
  await withApp(async ({ app }: HostedDynamic) => {
    // Two cycles started together: one runs, one reports skipped. (The bodies are
    // no-ops here — an empty deployment — so this pins the coordination, while
    // the lifecycle test above pins the work.)
    const [a, b] = await Promise.all([runRetentionCycle(app.ctx), runRetentionCycle(app.ctx)]);
    assert.equal([a.skipped, b.skipped].filter((s) => s === true).length, 1, "exactly one cycle is skipped");
    assert.equal([a.skipped, b.skipped].filter((s) => s === false).length, 1, "and exactly one actually ran");
    assert.equal(await readLease(app.db, RETENTION_LEASE), null, "a finished cycle releases its lease");

    // Simulate process death mid-cycle: a lease row owned by a process that is
    // gone and is renewing nothing. While it is live the next cycle stands down…
    const now = Date.now();
    await claimLease(app.db, RETENTION_LEASE, { owner: "dead-host:999999", ttlMs: 2_000, now });
    assert.equal((await runRetentionCycle(app.ctx)).skipped, true, "a live lease blocks the next cycle");

    // …and once it expires (the dead process renews nothing), the next cycle
    // reclaims it without operator action.
    await app.db.query(`UPDATE leases SET expires_at = $2 WHERE name = $1`, [RETENTION_LEASE, now - 1]);
    const recovered = await runRetentionCycle(app.ctx);
    assert.equal(recovered.skipped, false, "an expired lease is reclaimed by the next cycle");
    assert.equal(await readLease(app.db, RETENTION_LEASE), null);
  });
});
