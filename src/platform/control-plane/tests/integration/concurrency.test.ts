// One-winner invariants under concurrency (storage S1).
//
// Postgres held these with `SELECT … FOR UPDATE`. SQLite has no row lock, so
// each site now runs inside `BEGIN IMMEDIATE` AND re-asserts its precondition in
// the mutating statement's WHERE clause, treating `rowCount === 0` as "I lost".
// These tests fire both callers together and assert exactly one wins with the
// documented conflict for the loser — the behavior the row lock used to give.
import test from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./helpers.ts";
import { ulid } from "../../src/ulid.ts";
import { extractFindingFromReport } from "../../src/findings/extractor.ts";

/** Fire both operations at once and sort the outcomes into winner/loser. */
async function race(a: HostedDynamic, b: HostedDynamic) {
  const [x, y] = await Promise.all([a, b]);
  const ok = [x, y].filter((r) => r.status >= 200 && r.status < 300);
  const refused = [x, y].filter((r) => r.status >= 400);
  return { ok, refused, all: [x, y] };
}

test("concurrent candidate resolutions produce exactly one winner", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "conc1", name: "Conc" })).body;
    const { suite, env, snapshot } = await seedSuite(app, api, project);
    const { run } = await seedRun(app, { project, suite, env, snapshot });
    const candidate = await seedCandidate(app, { project, suite, run });

    // Two reviewers resolve the same candidate at the same moment. Accept and
    // reject share one conditional update (`WHERE id = $1 AND status = 'pending'`),
    // so racing two rejects exercises it without needing a real sealed bundle.
    const { ok, refused } = await race(
      api.post(`/candidates/${candidate}/reject`, {}),
      api.post(`/candidates/${candidate}/reject`, {}),
    );
    assert.equal(ok.length, 1, `exactly one resolution may win: ${JSON.stringify([...ok, ...refused].map((r) => r.status))}`);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].status, 409, JSON.stringify(refused[0].body));
    assert.equal(refused[0].body.error.code, "conflict");
    assert.match(refused[0].body.error.message, /already/, "the loser is told the winner's decision");

    // The row reflects one decision, and a third attempt still loses.
    const { rows } = await app.db.query("SELECT status, resolved_at FROM candidates WHERE id = $1", [candidate]);
    assert.equal(rows[0].status, "rejected");
    assert.ok(rows[0].resolved_at instanceof Date, "the winner stamped resolved_at");
    const late = await api.post(`/candidates/${candidate}/reject`, {});
    assert.equal(late.status, 409);
  });
});

test("concurrent finding transitions produce exactly one winner", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "conc2", name: "Conc 2" })).body;
    const { suite, env, snapshot } = await seedSuite(app, api, project);
    const a = await seedFinding(app, project, { suite, env, snapshot }, "widget 1 vanished");
    const b = await seedFinding(app, project, { suite, env, snapshot }, "sidebar 1 collapsed", "sidebar");

    // Merging `a` into `b` while a reviewer accepts `a`: a merged finding is a
    // tombstone, so both cannot commit.
    const { ok, refused } = await race(
      api.post(`/findings/${a}/merge`, { into: b }),
      api.post(`/findings/${a}/accept`, { title: "Widget vanishes", severity: "major" }),
    );
    assert.equal(ok.length + refused.length, 2);

    const after = (await app.db.query("SELECT state, merged_into FROM findings WHERE id = $1", [a])).rows[0];
    if (after.merged_into) {
      // The merge won; every later transition on the tombstone must be refused.
      for (const route of ["accept", "reject", "resolve", "reopen"]) {
        const late = await api.post(`/findings/${a}/${route}`, { title: "T", severity: "major", reason: "not_a_bug" });
        assert.equal(late.status, 409, `${route} on a merged finding must conflict`);
        assert.match(late.body.error.message, /merged/);
      }
    } else {
      assert.equal(ok.length, 1, "if the merge lost, the accept won alone");
    }

    // The partial unique index still guarantees one active row per fingerprint.
    const dupes = await app.db.query(`
      SELECT project_id, fingerprint, COUNT(*) AS n FROM findings
       WHERE merged_into IS NULL GROUP BY project_id, fingerprint HAVING COUNT(*) > 1`);
    assert.deepEqual(dupes.rows, []);
  });
});

test("concurrent evidence reports keep one finding and one evidence row per report", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "conc3", name: "Conc 3" })).body;
    const { suite, env, snapshot } = await seedSuite(app, api, project);
    const runs: HostedDynamic[] = [];
    for (let i = 0; i < 4; i += 1) runs.push((await seedRun(app, { project, suite, env, snapshot })).run);

    // Four executors report the same normalized failure simultaneously. The
    // dedupe path is read-decide-write: it must converge on ONE finding.
    await Promise.all(
      runs.map((run) =>
        app.db.withTx((tx: HostedDynamic) =>
          extractFindingFromReport(tx, {
            projectId: project.id,
            group: { id: run.run_group_id },
            run,
            status: "fail",
            manifest: manifestFor(run, `save button ${run.id.slice(-4)} not visible`),
            body: { score: 40 },
          }),
        ),
      ),
    );

    const findings = (await app.db.query("SELECT id, evidence_count FROM findings WHERE project_id = $1", [project.id])).rows;
    assert.equal(findings.length, 1, "four concurrent reports of one failure make one finding");
    assert.equal(findings[0].evidence_count, 4, "and evidence_count counts every report exactly once");
    const evidence = await app.db.query("SELECT COUNT(*) AS n FROM finding_evidence WHERE finding_id = $1", [findings[0].id]);
    assert.equal(evidence.rows[0].n, 4);
  });
});

test("concurrent suite commits serialize into distinct, monotonic snapshot seqs", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "conc4", name: "Conc 4" })).body;
    const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "s", name: "S" })).body;
    await api.post(`/suites/${suite.id}/commit`, {
      changes: [{ path: "playtest.yaml", content: "app:\n  base_url: http://127.0.0.1\n" }],
      note: "base",
    });

    const commits = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        api.post(`/suites/${suite.id}/commit`, {
          changes: [{ path: `stories/s${n}.yaml`, content: `story: Story number ${n} happens.\n` }],
          note: `commit ${n}`,
        }),
      ),
    );
    const accepted = commits.filter((c) => c.status < 300);
    assert.ok(accepted.length >= 1, JSON.stringify(commits.map((c) => c.body)));
    for (const rejected of commits.filter((c) => c.status >= 400)) {
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    }

    const snapshots = (await api.get(`/suites/${suite.id}/snapshots`)).body.items;
    const seqs = snapshots.map((s: HostedDynamic) => s.seq);
    assert.equal(new Set(seqs).size, seqs.length, "UNIQUE (suite_id, seq) held: no two snapshots share a seq");
    assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: seqs.length }, (_, i) => i + 1));
  });
});

// ------------------------------------------------------------------ seeding

async function seedSuite(app: HostedDynamic, api: HostedDynamic, project: HostedDynamic) {
  const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "s", name: "S" })).body;
  await api.post(`/suites/${suite.id}/commit`, {
    changes: [
      { path: "playtest.yaml", content: "app:\n  base_url: http://127.0.0.1\n" },
      { path: "stories/save.yaml", content: "story: A user saves their work and sees it persist.\n" },
    ],
    note: "seed",
  });
  const snapshot = (await api.get(`/suites/${suite.id}/snapshots`)).body.items[0];
  const env = (
    await api.post(`/projects/${project.key}/environments`, {
      name: "staging",
      config: { app: { base_url: "http://127.0.0.1" } },
    })
  ).body;
  return { suite, snapshot, env };
}

async function seedRun(app: HostedDynamic, { project, suite, env, snapshot, status = "fail", caseId = "save", storyId = "save" }: HostedDynamic) {
  const groupId = ulid();
  const run: HostedDynamic = { id: ulid(), run_group_id: groupId, case_id: caseId, story_id: storyId, run_id: `${caseId}-${ulid().slice(-8)}` };
  const started = new Date(Date.now() - 2000);
  const finished = new Date(Date.now() - 1000);
  await app.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(
      `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, environment_id, trigger, selection, status)
         VALUES ($1, $2, $3, $4, $5, '{}', '{}', 'done')`,
      [groupId, project.id, suite.id, snapshot.id, env.id],
    );
    await tx.query(
      `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode, manifest, totals, score,
                         duration_ms, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'act', $7, $8, 40, 1000, $9, $10)`,
      [run.id, groupId, caseId, storyId, run.run_id, status, manifestFor(run, "seed detail"), { cost_usd: 0.01 }, started, finished],
    );
  });
  return { run, groupId };
}

async function seedCandidate(app: HostedDynamic, { project, suite, run }: HostedDynamic) {
  const id = ulid();
  await app.db.query(
    `INSERT INTO candidates (id, project_id, suite_id, story_id, run_id, trajectory_key, meta, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
    [id, project.id, suite.id, run.story_id, run.id, `baselines/${suite.id}/${run.story_id}/v1.jsonl`, { steps: 3 }],
  );
  return id;
}

async function seedFinding(app: HostedDynamic, project: HostedDynamic, seed: HostedDynamic, detail: HostedDynamic, caseId = "save") {
  const { run } = await seedRun(app, { ...seed, project, caseId, storyId: caseId });
  await app.db.withTx((tx: HostedDynamic) =>
    extractFindingFromReport(tx, {
      projectId: project.id,
      group: { id: run.run_group_id },
      run,
      status: "fail",
      manifest: manifestFor(run, detail),
      body: { score: 40 },
    }),
  );
  const { rows } = await app.db.query(
    "SELECT id FROM findings WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
    [project.id],
  );
  return rows[0].id;
}

function manifestFor(run: HostedDynamic, detail: HostedDynamic) {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    run_id: run.run_id,
    case: { id: run.case_id, story: run.story_id },
    mode: "act",
    started_at: now,
    finished_at: now,
    duration_ms: 1000,
    pins: { driver: "web", actor_model: "mock", grader_model: "mock" },
    result: {
      status: "fail",
      end_reason: "gate_failed",
      error: null,
      gate: { ok: false, checks: [{ id: "gate-1", ok: false, detail }] },
    },
    totals: { cost_usd: 0.01 },
  };
}
