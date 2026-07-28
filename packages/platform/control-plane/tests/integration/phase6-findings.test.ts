import test from "node:test";
import assert from "node:assert/strict";
import { createTarget, withApp } from "./helpers.ts";
import { ulid } from "../../src/ulid.ts";
import { extractFindingFromReport } from "../../src/findings/extractor.ts";

test("phase6 findings dedupe, triage, and manual promotion", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "phase6", name: "Phase 6" })).body;
    const { suite, application, ring, snapshot } = await seedSuite(app, api, project);

    const run1 = await seedRun(app, { project, suite, application, ring, snapshot, status: "fail", score: 40, detail: "button 123 not visible" });
    await extract(app, project, run1.group, run1.run, "button 456 not visible");
    let queue = await api.get(`/projects/${project.key}/findings?state=all`);
    assert.equal(queue.body.items.length, 1);
    assert.equal(queue.body.items[0].evidence_count, 1);

    const run2 = await seedRun(app, { project, suite, application, ring, snapshot, status: "fail", score: 41, detail: "button 999 not visible" });
    await extract(app, project, run2.group, run2.run, "button 1000 not visible");
    queue = await api.get(`/projects/${project.key}/findings?state=all`);
    assert.equal(queue.body.items.length, 1, "same normalized failure dedupes");
    assert.equal(queue.body.items[0].evidence_count, 2);
    const findingId = queue.body.items[0].id;

    // Bucket tallies for the console tabs: per-state counts over live findings.
    // Accepting (confirming) moves the finding from `new` to `accepted` — the
    // needs-review tally goes down, the open tally goes up.
    const before = (await api.get(`/projects/${project.key}/findings/counts`)).body.counts;
    assert.deepEqual(before, { new: 1, reopened: 0, accepted: 0, rejected: 0, resolved: 0 });

    const accepted = await api.post(`/findings/${findingId}/accept`, { title: "Save button hidden", severity: "major" });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const after = (await api.get(`/projects/${project.key}/findings/counts`)).body.counts;
    assert.deepEqual(after, { new: 0, reopened: 0, accepted: 1, rejected: 0, resolved: 0 },
      "confirm moves one from the review tally to the open tally");

    const run3 = await seedRun(app, { project, suite, application, ring, snapshot, status: "fail", score: 39, detail: "button 777 not visible" });
    await extract(app, project, run3.group, run3.run, "button 778 not visible");
    const stillAccepted = (await api.get(`/findings/${findingId}`)).body;
    assert.equal(stillAccepted.state, "accepted", "accepted finding keeps absorbing matching evidence");
    assert.equal(stillAccepted.evidence_count, 3, "accepted finding still collects repeat evidence");

    // The dashboard's attention majors ride /health — same rows, no second
    // findings round trip from the console.
    const health = (await api.get(`/projects/${project.key}/health`)).body;
    assert.deepEqual(
      health.major_findings.map((f: HostedDynamic) => ({ id: f.id, title: f.title, state: f.state, evidence_count: f.evidence_count })),
      [{ id: findingId, title: "Save button hidden", state: "accepted", evidence_count: 3 }],
      "an accepted major surfaces on health.major_findings");

    await api.post(`/findings/${findingId}/resolve`, {});
    const run4 = await seedRun(app, { project, suite, application, ring, snapshot, status: "fail", score: 38, detail: "button 42 not visible" });
    await extract(app, project, run4.group, run4.run, "button 43 not visible");
    const reopened = (await api.get(`/findings/${findingId}`)).body;
    assert.equal(reopened.state, "reopened");

    // story_health decoration: the latest finished run of the story is a fail
    // → the finding is "still failing"; a green run flips it to pass.
    assert.equal(reopened.story_health?.status, "fail", "latest save run failed → story_health fail");
    assert.ok(reopened.story_health.run_db_id && reopened.story_health.run_group_id);
    const listed = (await api.get(`/projects/${project.key}/findings?state=all`)).body.items.find((x: HostedDynamic) => x.id === findingId);
    assert.equal(listed.story_health?.status, "fail", "list rows carry story_health too");
    await seedRun(app, { project, suite, application, ring, snapshot, status: "pass", score: 88 });
    const greenNow = (await api.get(`/findings/${findingId}`)).body;
    assert.equal(greenNow.story_health?.status, "pass", "a newer green run reconciles the finding as passing");
    assert.ok(new Date(greenNow.story_health.finished_at) >= new Date(greenNow.last_seen));

    const noisy = await seedRun(app, { project, suite, application, ring, snapshot, status: "fail", score: 20, caseId: "checkout", storyId: "checkout", detail: "checkout modal missing" });
    await extract(app, project, noisy.group, noisy.run, "checkout modal missing");
    const noisyFinding = (await api.get(`/projects/${project.key}/findings?state=new`)).body.items.find((f: HostedDynamic) => f.summary.case_id === "checkout");
    assert.ok(noisyFinding);
    await api.post(`/findings/${noisyFinding.id}/reject`, { reason: "not_a_bug" });
    const noisyRepeat = await seedRun(app, { project, suite, application, ring, snapshot, status: "fail", score: 22, caseId: "checkout", storyId: "checkout", detail: "checkout modal missing" });
    await extract(app, project, noisyRepeat.group, noisyRepeat.run, "checkout modal missing");
    const rejected = (await api.get(`/findings/${noisyFinding.id}`)).body;
    assert.equal(rejected.state, "rejected");
    assert.equal(rejected.evidence_count, 2);
    const active = (await api.get(`/projects/${project.key}/findings?state=new,reopened`)).body.items;
    assert.equal(active.some((f: HostedDynamic) => f.id === noisyFinding.id), false);

    // Manual promotion pins evidence to the run's final observed state (the
    // gate judges the end state) and the excerpt carries the failing check.
    const promo = await seedRun(app, { project, suite, application, ring, snapshot, status: "fail", score: 55, caseId: "promo", storyId: "promo", detail: "spinner hangs" });
    const promoted = (await api.post(`/runs/${promo.run.id}/promote-finding`, { title: "Spinner never resolves", severity: "minor", note: "saw it hang" })).body;
    assert.equal(promoted.evidence[0].step_from, 4, "promote pins step_from to the final state (totals.steps)");
    assert.match(promoted.evidence[0].viewer_url, /\?step=4$/);
    assert.match(promoted.evidence[0].excerpt, /saw it hang — assert: save button visible — spinner hangs/,
      "promote excerpt appends the failing gate text to the note");
    assert.equal(promoted.summary?.gate?.spec, "assert: save button visible", "promoted findings carry the gate criterion");
    assert.equal(promoted.story_health?.status, "fail");

    // Confirm-and-copy: accepting a finding is confirmation. It leaves a durable
    // confirmation (state) and provenance (confirmed_at/by in the summary) that
    // the "Copy for tracker" client step then hands off (P4).
    const confirmed = (await api.post(`/findings/${promoted.id}/accept`, {})).body;
    assert.equal(confirmed.state, "accepted", "confirmation is durable");
    assert.ok(confirmed.summary?.confirmed_at, "confirmation stamps a durable timestamp");
    assert.ok(confirmed.summary?.confirmed_by, "confirmation records the actor as provenance");
    // Reviewer promotion lands confirmed, so it counts as open work, not review.
    const finalCounts = (await api.get(`/projects/${project.key}/findings/counts`)).body.counts;
    assert.deepEqual(finalCounts, { new: 0, reopened: 1, accepted: 1, rejected: 1, resolved: 0 });
  });
});

// Reversibility, the other half of the auto-dedupe bargain the contract states
// ("evidence split and reopen exist"): a reviewer carves one occurrence out of
// a finding into its own `new` finding, and the source's counters recalc. The
// endpoint is API-only today — no console affordance — so this test is what
// keeps it working.
test("phase6 evidence split carves one occurrence into its own finding", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "phase6-split", name: "Phase 6 split" })).body;
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
