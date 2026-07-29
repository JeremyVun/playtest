import test from "node:test";
import assert from "node:assert/strict";
import { createTarget, withApp } from "./helpers.ts";
import { ulid } from "../../src/ulid.ts";
import { extractFindingFromReport } from "../../src/findings/extractor.ts";

test("finding counts and health projections follow lifecycle and the latest story run", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "finding-projections", name: "Finding projections" })).body;
    const { suite, application, ring, snapshot } = await seedSuite(app, api, project);

    const run1 = await seedRun(app, { project, suite, application, ring, snapshot, status: "fail", score: 40, detail: "button 123 not visible" });
    await extract(app, project, run1.group, run1.run, "button 456 not visible");
    const finding = (await api.get(`/projects/${project.key}/findings?state=all`)).body.items[0];
    assert.deepEqual(
      (await api.get(`/projects/${project.key}/findings/counts`)).body.counts,
      { new: 1, reopened: 0, accepted: 0, rejected: 0, resolved: 0 },
    );

    const accepted = await api.post(`/findings/${finding.id}/accept`, { title: "Save button hidden", severity: "major" });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(
      (await api.get(`/projects/${project.key}/findings/counts`)).body.counts,
      { new: 0, reopened: 0, accepted: 1, rejected: 0, resolved: 0 },
      "accepting moves the finding from review to open work",
    );

    const health = (await api.get(`/projects/${project.key}/health`)).body;
    assert.deepEqual(
      health.major_findings.map((f: HostedDynamic) => ({ id: f.id, title: f.title, state: f.state, evidence_count: f.evidence_count })),
      [{ id: finding.id, title: "Save button hidden", state: "accepted", evidence_count: 1 }],
      "an accepted major surfaces on health.major_findings");

    await api.post(`/findings/${finding.id}/resolve`, {});
    const run2 = await seedRun(app, { project, suite, application, ring, snapshot, status: "fail", score: 38, detail: "button 42 not visible" });
    await extract(app, project, run2.group, run2.run, "button 43 not visible");
    const reopened = (await api.get(`/findings/${finding.id}`)).body;
    assert.equal(reopened.state, "reopened");
    assert.equal(reopened.story_health?.status, "fail");
    assert.ok(reopened.story_health.run_db_id && reopened.story_health.run_group_id);
    const listed = (await api.get(`/projects/${project.key}/findings?state=all`)).body.items.find((x: HostedDynamic) => x.id === finding.id);
    assert.equal(listed.story_health?.status, "fail", "list rows carry story health");

    await seedRun(app, { project, suite, application, ring, snapshot, status: "pass", score: 88, startedOffsetMs: 10_000 });
    const greenNow = (await api.get(`/findings/${finding.id}`)).body;
    assert.equal(greenNow.story_health?.status, "pass", "a newer green run reconciles the finding as passing");
    assert.ok(new Date(greenNow.story_health.finished_at) >= new Date(greenNow.last_seen));
  });
});

// Reversibility, the other half of the auto-dedupe bargain the contract states
// ("evidence split and reopen exist"): a reviewer carves one occurrence out of
// a finding into its own `new` finding, and the source's counters recalc. The
// endpoint is API-only today — no console affordance — so this test is what
// keeps it working.
test("evidence split carves one occurrence into its own finding", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "finding-split", name: "Finding split" })).body;
    const { suite, application, ring, snapshot } = await seedSuite(app, api, project);
    const run1 = await seedRun(app, { project, suite, application, ring, snapshot, status: "fail", score: 40, detail: "button 123 not visible" });
    await extract(app, project, run1.group, run1.run, "button 456 not visible");
    const run2 = await seedRun(app, { project, suite, application, ring, snapshot, status: "fail", score: 41, detail: "button 999 not visible" });
    await extract(app, project, run2.group, run2.run, "button 1000 not visible");
    const source = (await api.get(`/projects/${project.key}/findings?state=all`)).body.items[0];
    assert.equal(source.evidence_count, 2);

    const evidence = (await api.get(`/findings/${source.id}`)).body.evidence;
    const split = await api.post(`/finding-evidence/${evidence[0].id}/split`, { title: "Actually a different bug" });
    assert.equal(split.status, 200, JSON.stringify(split.body));
    assert.equal(split.body.state, "new", "a split-out finding starts unreviewed");
    assert.equal(split.body.title, "Actually a different bug");
    assert.equal(split.body.evidence_count, 1);
    assert.equal(split.body.evidence[0].id, evidence[0].id, "the split carries exactly its evidence row");
    assert.notEqual(split.body.fingerprint, source.fingerprint, "the split has its own identity");

    const after = (await api.get(`/findings/${source.id}`)).body;
    assert.equal(after.evidence_count, 1, "the source finding's counter recalcs");
    const counts = (await api.get(`/projects/${project.key}/findings/counts`)).body.counts;
    assert.deepEqual(counts, { new: 2, reopened: 0, accepted: 0, rejected: 0, resolved: 0 });
  });
});

async function seedSuite(app: HostedDynamic, api: HostedDynamic, project: HostedDynamic) {
  const { application, ring } = await createTarget(api, project, {
    ringKey: "staging",
    baseUrl: "http://127.0.0.1",
  });
  const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "suite", name: "Suite" })).body;
  const snapshot = { id: ulid(), suite_id: suite.id, seq: 1, tree: {} };
  await app.db.query(
    `INSERT INTO suite_snapshots (id, suite_id, seq, tree, created_by) VALUES ($1, $2, 1, '{}', $3)`,
    [snapshot.id, suite.id, app.ctx.devUserId],
  );
  return { suite, snapshot, application, ring };
}

async function seedRun(app: HostedDynamic, { project, suite, application, ring, snapshot, status, score, caseId = "save", storyId = "save", detail, startedOffsetMs = 0 }: HostedDynamic) {
  const group = {
    id: ulid(),
    project_id: project.id,
    suite_id: suite.id,
    snapshot_id: snapshot.id,
    application_id: application.id,
    ring_id: ring.id,
  };
  const run: HostedDynamic = {
    id: ulid(),
    run_group_id: group.id,
    case_id: caseId,
    story_id: storyId,
    run_id: `${caseId}-${ulid().slice(-6)}`,
  };
  const started = new Date(Date.now() + startedOffsetMs);
  const finished = new Date(started.getTime() + 1000);
  const manifest = manifestFor({ run, status, score, detail, started, finished });
  await app.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(
      `INSERT INTO run_groups
         (id, project_id, suite_id, snapshot_id, application_id, ring_id, trigger, selection, status)
       VALUES ($1, $2, $3, $4, $5, $6, '{}', '{}', 'done')`,
      [group.id, project.id, suite.id, snapshot.id, application.id, ring.id],
    );
    await tx.query(
      `INSERT INTO runs
         (id, run_group_id, case_id, story_id, run_id, status, mode, manifest, totals, score, gate, pins, duration_ms, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'act', $7, $8, $9, $10, $11, 1000, $12, $13)`,
      [
        run.id,
        group.id,
        caseId,
        storyId,
        run.run_id,
        status,
        JSON.stringify(manifest),
        JSON.stringify(manifest.totals),
        score,
        JSON.stringify(manifest.result.gate),
        JSON.stringify(manifest.pins),
        started,
        finished,
      ],
    );
  });
  run.manifest = manifest;
  return { group, run };
}

async function extract(app: HostedDynamic, project: HostedDynamic, group: HostedDynamic, run: HostedDynamic, detail: HostedDynamic) {
  const manifest = manifestFor({ run, status: "fail", score: 40, detail, started: new Date(), finished: new Date() });
  await app.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(
      `UPDATE runs SET status = 'fail', manifest = $2, totals = $3, score = 40, gate = $4, finished_at = now() WHERE id = $1`,
      [run.id, JSON.stringify(manifest), JSON.stringify(manifest.totals), JSON.stringify(manifest.result.gate)],
    );
    await extractFindingFromReport(tx, { projectId: project.id, group, run, status: "fail", manifest, body: { score: 40 } });
  });
}

function manifestFor({ run, status, score, detail, started, finished }: HostedDynamic) {
  return {
    schema_version: 1,
    run_id: run.run_id,
    case: { id: run.case_id, story: run.story_id },
    mode: "act",
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    duration_ms: finished - started,
    pins: { driver: "web", actor_model: "mock", grader_model: "mock" },
    result: {
      status,
      end_reason: status === "fail" ? "gate_failed" : "done",
      error: null,
      gate: {
        pass: status !== "fail",
        hardPass: status !== "fail",
        checks: status === "fail"
          ? [{ kind: "assert", severity: "hard", spec: "assert: save button visible", pass: false, detail }]
          : [{ kind: "assert", severity: "hard", spec: "assert: save button visible", pass: true, detail: "ok" }],
      },
    },
    totals: { steps: 4, executed_steps: 3, confusion_events: 0, lcp_ms: 100, cost_usd: 0 },
    artifacts: { trajectory: "trajectory.jsonl", grade: "grade.json" },
    score,
  };
}
