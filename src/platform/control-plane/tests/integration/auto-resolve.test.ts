// The auto-resolve sweep end to end (docs/contracts/hosted.md, "Findings"):
// fail → finding → passing rerun → resolved with provenance; recurrence
// destinations by confirmation; per-(suite, environment, case) stamping that
// refuses to close over a triple whose evidence is newer; the deterministic
// "looks fixed" suggestion on judgment calls; and the retention grace pin.
// Real database, real object store, real sealed bundles for the signal tier.
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withApp } from "./helpers.ts";
import { ulid } from "../../src/ulid.ts";
import { writeBundle } from "../../../../core/public/artifacts.ts";
import { extractFindingFromReport } from "../../src/findings/extractor.ts";
import { intakeFinding } from "../../src/findings/intake.ts";
import {
  autoResolveEnabledFor, autoResolveTimers, runAutoResolve, scheduleAutoResolve,
} from "../../src/findings/auto-resolve.ts";
import { runRetentionCycle } from "../../src/retention/worker.ts";

const MIN = 60_000;

async function seedProject(app: HostedDynamic, api: HostedDynamic, key: HostedDynamic) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const suite = (await api.post(`/projects/${key}/suites`, { slug: "s", name: "S" })).body;
  const snapshotId = ulid();
  await app.db.query(
    `INSERT INTO suite_snapshots (id, suite_id, seq, tree, created_by) VALUES ($1,$2,1,'{}',$3)`,
    [snapshotId, suite.id, app.ctx.devUserId],
  );
  return { project, suite, snapshotId };
}

async function seedEnv(app: HostedDynamic, api: HostedDynamic, projectKey: HostedDynamic, name: HostedDynamic) {
  return (await api.post(`/projects/${projectKey}/environments`, { name })).body;
}

async function seedGroup(app: HostedDynamic, { project, suite, snapshotId, envId }: HostedDynamic) {
  const id = ulid();
  await app.db.query(
    `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, environment_id, trigger, selection, status)
       VALUES ($1,$2,$3,$4,$5,'{}','{}','done')`,
    [id, project.id, suite.id, snapshotId, envId],
  );
  return id;
}

async function seedRun(app: HostedDynamic, { groupId, caseId = "checkout", storyId = "checkout", status, finishedAt, gate = null, manifest = null }: HostedDynamic) {
  const id = ulid();
  await app.db.query(
    `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode, gate, manifest, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,'record',$7,$8,$9)`,
    [id, groupId, caseId, storyId, `${caseId}-${ulid().slice(-6)}`, status, gate, manifest, finishedAt],
  );
  return { id, case_id: caseId, story_id: storyId };
}

/**
 * Seal and register a minimal bundle for a run. The keyless tier reads
 * bundles: grade.json presence is what lets a pass suggest without a
 * verifier, and the a11y files are what the verifier reads.
 */
async function seedRunBundle(app: HostedDynamic, { projectKey, runId, files }: HostedDynamic) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-ar-bundle-"));
  try {
    const runDir = path.join(tmpDir, "run");
    await fsp.mkdir(path.join(runDir, "steps"), { recursive: true });
    await fsp.writeFile(path.join(runDir, "manifest.json"), JSON.stringify({ case: { id: "checkout" } }));
    for (const [name, text] of Object.entries(files as Record<string, string>)) {
      await fsp.writeFile(path.join(runDir, name), text);
    }
    const outPath = path.join(tmpDir, "run.ptrun");
    writeBundle(runDir, outPath);
    const bytes = await fsp.readFile(outPath);
    const stored = await app.store.put(`runs/${projectKey}/${runId}.ptrun`, bytes);
    await app.db.query(
      `INSERT INTO artifacts (id, run_id, kind, key, sha256, size, tier, verified_at)
         VALUES ($1,$2,'bundle',$3,$4,$5,'full', now())`,
      [ulid(), runId, `runs/${projectKey}/${runId}.ptrun`, stored.sha256, stored.size],
    );
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

const GRADED = { "grade.json": JSON.stringify({ findings: [] }) };

const CHECK = { spec: "assert: the order total updates", kind: "assert", pass: false, detail: "total stayed $148.00" };
const FAIL_MANIFEST = { result: { gate: { checks: [CHECK] } }, totals: { steps: 5 } };

async function fileGateFinding(app: HostedDynamic, { project, groupId, run }: HostedDynamic) {
  return await app.db.withTx((tx: HostedDynamic) =>
    extractFindingFromReport(tx, {
      projectId: project.id, group: { id: groupId }, run, status: "fail", manifest: FAIL_MANIFEST,
    }));
}

const findingRow = async (app: HostedDynamic, id: HostedDynamic) =>
  (await app.db.query(`SELECT * FROM findings WHERE id = $1`, [id])).rows[0];
const stampsFor = async (app: HostedDynamic, id: HostedDynamic) =>
  (await app.db.query(`SELECT * FROM finding_resolution_stamps WHERE finding_id = $1`, [id])).rows;
const auditRows = async (app: HostedDynamic, id: HostedDynamic, action: HostedDynamic) =>
  (await app.db.query(`SELECT * FROM audit_log WHERE entity_id = $1 AND action = $2`, [id, action])).rows;

test("gate tier: fail → accept → passing rerun resolves with provenance; recurrence reopens a confirmed finding", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, suite, snapshotId } = await seedProject(app, api, "ar1");
    const env = await seedEnv(app, api, "ar1", "staging");
    const groupA = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
    const runA = await seedRun(app, { groupId: groupA, status: "fail", finishedAt: Date.now() - MIN });
    const { finding } = await fileGateFinding(app, { project, groupId: groupA, run: runA });
    assert.equal(finding.state, "new");
    assert.equal(finding.signal_type, "gate_assert");

    // A person confirms it — recurrence must later land in `reopened`.
    const accepted = (await api.post(`/findings/${finding.id}/accept`, {})).body;
    assert.equal(accepted.state, "accepted");

    // A newer run FAILED at a later step, but this check passed: still retires.
    const groupB = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
    const runB = await seedRun(app, {
      groupId: groupB, status: "fail", finishedAt: Date.now() + MIN,
      gate: { checks: [{ ...CHECK, pass: true }, { spec: "assert: receipt renders", pass: false }] },
    });
    const swept = await runAutoResolve(app.ctx, { project });
    assert.equal(swept.resolved, 1);

    const after = await findingRow(app, finding.id);
    assert.equal(after.state, "resolved");
    assert.equal(after.resolved_by_run_id, runB.id);
    assert.ok(after.auto_resolved_at, "auto provenance is stamped");
    assert.match(after.summary.auto_resolve.reason, /exact check that failed/,
      "the sweep states a human-legible reason for the close");
    const stamps = await stampsFor(app, finding.id);
    assert.equal(stamps.length, 1);
    assert.equal(stamps[0].method, "gate_pass");
    assert.equal(stamps[0].environment_id, env.id);
    assert.equal((await auditRows(app, finding.id, "finding.auto_resolved")).length, 1);

    // The run page's chip data: the resolving run lists the finding.
    const runView = (await api.get(`/runs/${runB.id}`)).body;
    assert.deepEqual(runView.resolved_findings.map((f: HostedDynamic) => f.id), [finding.id]);
    // And the findings list can query by resolver.
    const byRun = (await api.get(`/projects/ar1/findings?state=resolved&resolved_by_run=${runB.id}`)).body;
    assert.deepEqual(byRun.items.map((f: HostedDynamic) => f.id), [finding.id]);

    // Recurrence of a CONFIRMED finding is the alarm state, and the stamp
    // survives as history while going stale.
    const groupC = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
    const runC = await seedRun(app, { groupId: groupC, status: "fail", finishedAt: Date.now() + 2 * MIN });
    const rec = await fileGateFinding(app, { project, groupId: groupC, run: runC });
    assert.equal(rec.action, "reopened");
    // Runs above are seeded with future finished_at values; in production the
    // evidence row and its run share one report instant, so keep that
    // invariant for the staleness comparison below.
    await app.db.query(
      `UPDATE finding_evidence SET created_at = $2 WHERE run_id = $1`,
      [runC.id, Date.now() + 2 * MIN],
    );
    const reopened = await findingRow(app, finding.id);
    assert.equal(reopened.state, "reopened");
    assert.equal(reopened.resolved_by_run_id, null, "leaving resolved clears the provenance");
    assert.equal(reopened.auto_resolved_at, null);
    assert.equal((await stampsFor(app, finding.id)).length, 1, "stamps are history, never deleted");

    // The stale stamp must not close it again without a NEWER pass.
    const again = await runAutoResolve(app.ctx, { project });
    assert.equal(again.resolved, 0, "a stale stamp cannot re-close a reopened finding");
    assert.equal((await findingRow(app, finding.id)).state, "reopened");
  });
});

test("recurrence of an UNCONFIRMED auto-resolved finding returns to `new`, not the alarm state", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, suite, snapshotId } = await seedProject(app, api, "ar2");
    const env = await seedEnv(app, api, "ar2", "staging");
    const groupA = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
    const runA = await seedRun(app, { groupId: groupA, status: "fail", finishedAt: Date.now() - MIN });
    const { finding } = await fileGateFinding(app, { project, groupId: groupA, run: runA });
    assert.equal(finding.state, "new", "no person has acted");

    const groupB = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
    await seedRun(app, {
      groupId: groupB, status: "pass", finishedAt: Date.now() + MIN,
      gate: { checks: [{ ...CHECK, pass: true }] },
    });
    const swept = await runAutoResolve(app.ctx, { project });
    assert.equal(swept.resolved, 1, "`new` findings are eligible — a fixed claim must not sit in review going stale");

    const groupC = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
    const runC = await seedRun(app, { groupId: groupC, status: "fail", finishedAt: Date.now() + 2 * MIN });
    const rec = await fileGateFinding(app, { project, groupId: groupC, run: runC });
    assert.equal(rec.action, "recurred", "back to quiet triage, never to reopened");
    const after = await findingRow(app, finding.id);
    assert.equal(after.state, "new");
    assert.equal((await auditRows(app, finding.id, "finding.recurred")).length, 1);
  });
});

test("multi-triple: a pass on one environment stamps but cannot resolve while the other environment's evidence is newer", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, suite, snapshotId } = await seedProject(app, api, "ar3");
    const staging = await seedEnv(app, api, "ar3", "staging");
    const prod = await seedEnv(app, api, "ar3", "prod");
    const gStaging = await seedGroup(app, { project, suite, snapshotId, envId: staging.id });
    const gProd = await seedGroup(app, { project, suite, snapshotId, envId: prod.id });
    const runS = await seedRun(app, { groupId: gStaging, status: "fail", finishedAt: Date.now() - MIN });
    const { finding } = await fileGateFinding(app, { project, groupId: gStaging, run: runS });
    // Prod evidence appends onto the same finding (same fingerprint via the
    // extractor path).
    const runP = await seedRun(app, { groupId: gProd, status: "fail", finishedAt: Date.now() - MIN / 2 });
    const rec = await fileGateFinding(app, { project, groupId: gProd, run: runP });
    assert.equal(rec.finding.id, finding.id, "one finding, two environments");

    // Staging passes; prod has not re-run.
    const gStaging2 = await seedGroup(app, { project, suite, snapshotId, envId: staging.id });
    await seedRun(app, {
      groupId: gStaging2, status: "pass", finishedAt: Date.now() + MIN,
      gate: { checks: [{ ...CHECK, pass: true }] },
    });
    let swept = await runAutoResolve(app.ctx, { project });
    assert.equal(swept.resolved, 0, "the casual environment passing cannot stamp out the other's evidence");
    assert.equal(swept.stamped, 1, "…but its own triple is stamped");
    assert.equal((await findingRow(app, finding.id)).state, "new");

    // Prod passes too — every triple fresh, the finding closes.
    const gProd2 = await seedGroup(app, { project, suite, snapshotId, envId: prod.id });
    await seedRun(app, {
      groupId: gProd2, status: "pass", finishedAt: Date.now() + 2 * MIN,
      gate: { checks: [{ ...CHECK, pass: true }] },
    });
    swept = await runAutoResolve(app.ctx, { project });
    assert.equal(swept.resolved, 1);
    assert.equal((await findingRow(app, finding.id)).state, "resolved");
    assert.equal((await stampsFor(app, finding.id)).length, 2);
  });
});

test("signal tier: a rerun whose recomputed anomalies lack the signal resolves; the bundle read happens once", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-ar-signal-"));
  try {
    await withApp(async ({ app, api }: HostedDynamic) => {
      const { project, suite, snapshotId } = await seedProject(app, api, "ar4");
      const env = await seedEnv(app, api, "ar4", "staging");
      const groupA = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
      const runA = await seedRun(app, { groupId: groupA, status: "fail", finishedAt: Date.now() - MIN });

      // A signal-keyed finding, exactly as run_grade intake derives identity:
      // recorded http_5xx signal at the cited step.
      const locus = { route: "/api/export", step_locus: "POST /api/export → 500", status_class: "5xx" };
      let finding: HostedDynamic;
      await app.db.withTx(async (tx: HostedDynamic) => {
        ({ finding } = await intakeFinding(tx, {
          projectId: project.id, source: "run_grade", actor: { system: "findings" },
          claim: {
            category: "http_error", storyId: "checkout", caseId: "checkout",
            signalType: "http_error", locus,
            title: "Export endpoint returns 500", expected: "the export downloads",
            observed: "POST /api/export answered 500", severity: "major", signals: ["http_5xx"],
          },
          evidence: [{ run_id: runA.id, step: 3, excerpt: "POST /api/export → 500" }],
        }));
      });
      assert.ok(finding.strict_key, "a recorded signal grounds exact keys");

      // The rerun passes; its sealed bundle's trajectory reaches the route and
      // the 500 is gone.
      const groupB = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
      const runB = await seedRun(app, { groupId: groupB, status: "pass", storyId: "checkout", finishedAt: Date.now() + MIN });
      const runDir = path.join(tmpDir, "runB");
      await fsp.mkdir(runDir, { recursive: true });
      await fsp.writeFile(path.join(runDir, "manifest.json"), JSON.stringify({ case: { id: "checkout" } }));
      await fsp.writeFile(path.join(runDir, "trajectory.jsonl"),
        JSON.stringify({ step: 3, network: { requests: [{ method: "POST", path: "/api/export", status: 200 }] } }) + "\n");
      const outPath = path.join(tmpDir, "runB.ptrun");
      writeBundle(runDir, outPath);
      const bytes = await fsp.readFile(outPath);
      const stored = await app.store.put(`runs/ar4/${runB.id}.ptrun`, bytes);
      await app.db.query(
        `INSERT INTO artifacts (id, run_id, kind, key, sha256, size, tier, verified_at)
           VALUES ($1,$2,'bundle',$3,$4,$5,'full', now())`,
        [ulid(), runB.id, `runs/ar4/${runB.id}.ptrun`, stored.sha256, stored.size],
      );

      const swept = await runAutoResolve(app.ctx, { project });
      assert.equal(swept.resolved, 1);
      const after = await findingRow(app, finding.id);
      assert.equal(after.state, "resolved");
      assert.equal(after.resolved_by_run_id, runB.id);
      assert.deepEqual((await stampsFor(app, finding.id)).map((s: HostedDynamic) => s.method), ["signal_absent"]);
      assert.match(after.summary.auto_resolve.reason, /failure signal did not recur/);
    });
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test("key-less findings get the deterministic suggestion, one-click verbs, and 'not fixed' sticks per run", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, suite, snapshotId } = await seedProject(app, api, "ar5");
    const env = await seedEnv(app, api, "ar5", "staging");
    const groupA = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
    const runA = await seedRun(app, { groupId: groupA, status: "fail", finishedAt: Date.now() - MIN });
    let finding: HostedDynamic;
    await app.db.withTx(async (tx: HostedDynamic) => {
      ({ finding } = await intakeFinding(tx, {
        projectId: project.id, source: "run_grade", actor: { system: "findings" },
        claim: {
          category: "expectation_violation", storyId: "checkout", caseId: "checkout",
          signalType: null, locus: null,
          title: "The empty-cart copy is misleading", expected: null,
          observed: "the page says 'error' for an empty cart", severity: "minor", signals: [],
        },
        evidence: [{ run_id: runA.id, step: 2 }],
      }));
    });
    assert.equal(finding.strict_key, null, "a judgment call carries no exact keys");

    // A GRADED pass (grade.json in the sealed bundle) is what may suggest
    // without a verifier; an ungraded checked run would prove nothing.
    const groupB = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
    const runB = await seedRun(app, { groupId: groupB, status: "pass", finishedAt: Date.now() + MIN });
    await seedRunBundle(app, { projectKey: "ar5", runId: runB.id, files: GRADED });
    let swept = await runAutoResolve(app.ctx, { project });
    assert.equal(swept.resolved, 0, "a machine may suggest, never judge, a judgment call");
    assert.equal(swept.suggested, 1);
    let row = await findingRow(app, finding.id);
    assert.equal(row.state, "new", "no state change without the click");
    assert.equal(row.summary.auto_resolve.suggested.run_id, runB.id);
    assert.match(row.summary.auto_resolve.suggested.reason, /judgment call/,
      "the suggestion carries the sweep's stated reason");
    // The console's looks-fixed queue rides the list filter…
    const flagged = (await api.get(`/projects/ar5/findings?state=all&fix_suggested=1`)).body;
    assert.deepEqual(flagged.items.map((i: HostedDynamic) => i.id), [finding.id]);
    // …but the review-work tally counts only confirmed/reopened findings — a
    // `new` finding already sits in the review bucket by state.
    assert.equal((await api.get(`/projects/ar5/findings/counts`)).body.fix_suggested, 0);
    // The detail projection carries the linkable run for the banner.
    const detail = (await api.get(`/findings/${finding.id}`)).body;
    assert.equal(detail.suggested_fix_run.id, runB.id);

    // "Not fixed": the suggestion is withdrawn and THAT run never re-suggests…
    const nf = (await api.post(`/findings/${finding.id}/not-fixed`, {})).body;
    assert.equal(nf.summary.auto_resolve.suggested, undefined);
    assert.equal(nf.summary.auto_resolve.dismissed.run_id, runB.id);
    swept = await runAutoResolve(app.ctx, { project });
    assert.equal(swept.suggested, 0, "repeated green runs do not re-nag a dismissed suggestion");

    // …but a newer pass may — though an UNGRADED one (no bundle at all, the
    // checked-run shape) proves nothing about a judgment call first.
    const groupC = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
    const runC = await seedRun(app, { groupId: groupC, status: "pass", finishedAt: Date.now() + 2 * MIN });
    swept = await runAutoResolve(app.ctx, { project });
    assert.equal(swept.suggested, 0, "an ungraded pass never testifies about a judgment call");
    await seedRunBundle(app, { projectKey: "ar5", runId: runC.id, files: GRADED });
    swept = await runAutoResolve(app.ctx, { project });
    assert.equal(swept.suggested, 1);
    row = await findingRow(app, finding.id);
    assert.equal(row.summary.auto_resolve.suggested.run_id, runC.id);

    // Confirming the finding moves its pending suggestion into the review
    // tally: an accepted finding with a "looks fixed" claim is review work.
    await api.post(`/findings/${finding.id}/accept`, {});
    assert.equal((await api.get(`/projects/ar5/findings/counts`)).body.fix_suggested, 1);
    const queue = (await api.get(`/projects/ar5/findings?state=reopened,accepted&fix_suggested=1`)).body;
    assert.deepEqual(queue.items.map((i: HostedDynamic) => i.id), [finding.id]);

    // Accepting the suggestion is the ordinary human resolve — no auto badge.
    const resolved = (await api.post(`/findings/${finding.id}/resolve`, {})).body;
    assert.equal(resolved.state, "resolved");
    assert.equal(resolved.auto_resolved_at, null, "a person resolved it; the system only suggested");
  });
});

test("verified tier: the sweep re-checks the claim against page content — semi suggests, full resolves, not-fixed memoizes", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, suite, snapshotId } = await seedProject(app, api, "ar8");
    const env = await seedEnv(app, api, "ar8", "staging");
    const groupA = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
    const runA = await seedRun(app, { groupId: groupA, status: "fail", finishedAt: Date.now() - MIN });
    const intake = (claim: HostedDynamic) => app.db.withTx(async (tx: HostedDynamic) => (await intakeFinding(tx, {
      projectId: project.id, source: "run_grade", actor: { system: "findings" },
      claim: {
        category: "expectation_violation", storyId: "checkout", caseId: "checkout",
        signalType: null, locus: null, expected: null, severity: "minor", signals: [],
        ...claim,
      },
      evidence: [{ run_id: runA.id, step: 2 }],
    })).finding);
    const grammar = await intake({
      title: "Grammatical error in the final summary",
      observed: "the summary says \"You're an not an Australian citizen\"",
    });
    const copy = await intake({
      title: "The empty-cart copy is misleading",
      observed: "the page says 'error' for an empty cart",
    });

    // The newer graded pass carries the page content the verifier reads.
    const groupB = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
    const runB = await seedRun(app, { groupId: groupB, status: "pass", finishedAt: Date.now() + MIN });
    await seedRunBundle(app, {
      projectKey: "ar8", runId: runB.id,
      files: {
        ...GRADED,
        "steps/002.a11y.txt": "You're not an Australian citizen or permanent resident.",
        "final.a11y.txt": "Results — You're not an Australian citizen or permanent resident.",
      },
    });
    // The injected model answers per claim: the grammar error is gone from
    // the provided content, the copy problem is still there.
    let calls = 0;
    const callModel = async ({ messages, tool }: HostedDynamic) => {
      calls += 1;
      assert.equal(tool.function.name, "report_verification");
      const prompt = messages[1].content;
      assert.match(prompt, /permanent resident/, "the run's page content is in the prompt");
      return prompt.includes("Grammatical error")
        ? { args: { verdict: "fixed", evidence: "You're not an Australian citizen or permanent resident." }, tokens: {} }
        : { args: { verdict: "not_fixed", evidence: "the page says 'error'" }, tokens: {} };
    };

    // Semi (the default): verified fixes still wait for a person.
    let swept = await runAutoResolve(app.ctx, { project, callModel });
    assert.equal(calls, 2, "one verification call per finding");
    assert.equal(swept.resolved, 0);
    assert.equal(swept.suggested, 1);
    let row = await findingRow(app, grammar.id);
    assert.equal(row.state, "new");
    assert.equal(row.summary.auto_resolve.suggested.run_id, runB.id);
    assert.match(row.summary.auto_resolve.suggested.reason, /re-checked against the newest run's page content/);
    assert.match(row.summary.auto_resolve.suggested.reason, /You're not an Australian citizen/,
      "the suggestion quotes what the page says now");
    assert.deepEqual((await stampsFor(app, grammar.id)).map((s: HostedDynamic) => s.method), ["verified_absent"]);
    // Not-fixed never stamps, never suggests, and memoizes the read.
    row = await findingRow(app, copy.id);
    assert.equal(row.summary.auto_resolve?.suggested, undefined);
    assert.deepEqual(await stampsFor(app, copy.id), []);
    swept = await runAutoResolve(app.ctx, { project, callModel });
    assert.equal(calls, 2, "the checked memo keeps a judged run from being re-verified");

    // Full mode: the standing verified stamp is enough to close.
    const updated = (await api.put(`/projects/ar8/auto-resolve`, { mode: "full" })).body;
    assert.equal(updated.auto_resolve_mode, "full");
    const projectRow = (await app.db.query(`SELECT * FROM projects WHERE id = $1`, [project.id])).rows[0];
    swept = await runAutoResolve(app.ctx, { project: projectRow, callModel });
    assert.equal(swept.resolved, 1, "full mode resolves the verified fix");
    row = await findingRow(app, grammar.id);
    assert.equal(row.state, "resolved");
    assert.equal(row.resolved_by_run_id, runB.id);
    assert.ok(row.auto_resolved_at);
    assert.match(row.summary.auto_resolve.reason, /re-checked against the newest run's page content/);
    assert.equal((await auditRows(app, grammar.id, "finding.auto_resolved")).length, 1);
    // The not-fixed finding stays exactly where it was, in any mode.
    assert.equal((await findingRow(app, copy.id)).state, "new");
  });
});

test("acknowledge quiets the badge and is refused on a finding nobody auto-resolved", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, suite, snapshotId } = await seedProject(app, api, "ar6");
    const env = await seedEnv(app, api, "ar6", "staging");
    const groupA = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
    const runA = await seedRun(app, { groupId: groupA, status: "fail", finishedAt: Date.now() - MIN });
    const { finding } = await fileGateFinding(app, { project, groupId: groupA, run: runA });
    const groupB = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
    await seedRun(app, {
      groupId: groupB, status: "pass", finishedAt: Date.now() + MIN,
      gate: { checks: [{ ...CHECK, pass: true }] },
    });
    await runAutoResolve(app.ctx, { project });

    const acked = (await api.post(`/findings/${finding.id}/acknowledge`, {})).body;
    assert.ok(acked.summary.auto_resolve.acknowledged_at);
    assert.equal((await auditRows(app, finding.id, "finding.acknowledged")).length, 1);

    // Not auto-resolved → nothing to acknowledge.
    const runC = await seedRun(app, { groupId: groupB, caseId: "other", storyId: "other", status: "fail", finishedAt: Date.now() });
    const other = await fileGateFinding(app, { project, groupId: groupB, run: runC });
    const refused = await api.post(`/findings/${other.finding.id}/acknowledge`, {});
    assert.equal(refused.status, 409);
  });
});

test("retention: an auto-resolved finding pins its evidence run inside the grace window", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-ar-pin-"));
  try {
    await withApp(async ({ app, api }: HostedDynamic) => {
      const { project, suite, snapshotId } = await seedProject(app, api, "ar7");
      const env = await seedEnv(app, api, "ar7", "staging");
      const groupA = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
      // Old enough for the core→meta cutoff (2 days with core_days: 1).
      const runA = await seedRun(app, { groupId: groupA, status: "fail", finishedAt: Date.now() - 2 * 86_400_000 });
      const { finding } = await fileGateFinding(app, { project, groupId: groupA, run: runA });

      const runDir = path.join(tmpDir, "runA");
      await fsp.mkdir(runDir, { recursive: true });
      await fsp.writeFile(path.join(runDir, "manifest.json"), JSON.stringify({ case: { id: "checkout" } }));
      const outPath = path.join(tmpDir, "runA.ptrun");
      writeBundle(runDir, outPath);
      const bytes = await fsp.readFile(outPath);
      const stored = await app.store.put(`runs/ar7/${runA.id}.ptrun`, bytes);
      await app.db.query(
        `INSERT INTO artifacts (id, run_id, kind, key, sha256, size, tier, verified_at)
           VALUES ($1,$2,'bundle',$3,$4,$5,'core', now())`,
        [ulid(), runA.id, `runs/ar7/${runA.id}.ptrun`, stored.sha256, stored.size],
      );
      await app.db.query(`UPDATE runs SET artifact_tier = 'core' WHERE id = $1`, [runA.id]);

      const groupB = await seedGroup(app, { project, suite, snapshotId, envId: env.id });
      await seedRun(app, {
        groupId: groupB, status: "pass", finishedAt: Date.now() + MIN,
        gate: { checks: [{ ...CHECK, pass: true }] },
      });
      await runAutoResolve(app.ctx, { project });
      assert.equal((await findingRow(app, finding.id)).state, "resolved");

      const retention = { events_days: 14, full_days: null, core_days: 1 };
      await runRetentionCycle(app.ctx, { retention });
      let artifacts = await app.db.query(`SELECT * FROM artifacts WHERE run_id = $1`, [runA.id]);
      assert.equal(artifacts.rows.length, 1,
        "inside the grace window the evidence stays — reopen restores state, not evidence");

      // Age the auto-resolution beyond the pin window: the normal schedule resumes.
      await app.db.query(
        `UPDATE findings SET auto_resolved_at = $2 WHERE id = $1`,
        [finding.id, Date.now() - 91 * 86_400_000],
      );
      await runRetentionCycle(app.ctx, { retention });
      artifacts = await app.db.query(`SELECT * FROM artifacts WHERE run_id = $1`, [runA.id]);
      assert.equal(artifacts.rows.length, 0, "outside the window the bundle ages out normally");
    });
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test("policy: tri-state pin over the deployment default; a report schedules the debounced sweep", async () => {
  await withApp(async ({ app }: HostedDynamic) => {
    assert.equal(autoResolveEnabledFor(app.ctx, { auto_resolve: null }), true, "on by default — no gateway involved");
    app.ctx.config.autoResolve.enabled = false;
    assert.equal(autoResolveEnabledFor(app.ctx, { auto_resolve: null }), false);
    assert.equal(autoResolveEnabledFor(app.ctx, { auto_resolve: true }), true, "a pinned-on project sweeps under an off default");
    app.ctx.config.autoResolve.enabled = true;
    assert.equal(autoResolveEnabledFor(app.ctx, { auto_resolve: false }), false);

    scheduleAutoResolve(app.ctx, "p1");
    assert.equal(autoResolveTimers(app.ctx).size, 1);
    scheduleAutoResolve(app.ctx, "p1");
    assert.equal(autoResolveTimers(app.ctx).size, 1, "repeated reports collapse into one sweep");
    clearTimeout(autoResolveTimers(app.ctx).get("p1"));
    autoResolveTimers(app.ctx).delete("p1");
  });
});
