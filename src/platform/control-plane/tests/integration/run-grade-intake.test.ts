// Per-run grade intake (findings/run-grade.ts): when a run reports, the
// grader's structured issues — typed bug_candidates plus minor/major findings —
// enter the one hosted intake path as findings in state `new`, source
// "run_grade". info-severity observations stay run-scoped, intake is idempotent
// under runner retries, and nothing here reaches a CONFIRMED state.
//
// Exercised against a real database and object store on a temporary SQLite
// data root: the grade is read from a real sealed bundle, exactly the read
// caseReport performs.
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withApp } from "./helpers.ts";
import { ulid } from "../../src/ulid.ts";
import { writeBundle } from "../../../../core/public/artifacts.ts";
import { collectRunGradeIssues, ingestRunGradeFindings, gradeIssues } from "../../src/findings/run-grade.ts";

const GRADE = {
  score: 38,
  completion: "none",
  efficiency: { assessment: "stalled" },
  summary: "The flow stopped before results.",
  findings: [
    { severity: "major", note: "The results page never showed the eligibility outcome", step: 19 },
    { severity: "info", note: "Button copy is inconsistent" }, // info stays run-scoped
  ],
  bug_candidates: [
    {
      kind: "http_error",
      severity: "major",
      title: "Export endpoint returns 500",
      expected: "the export downloads",
      observed: "POST /api/export answered 500",
      evidence_steps: [3],
      signals: ["http_5xx"],
    },
  ],
};

test("gradeIssues: maps typed candidates and minor/major findings, skips info and malformed", () => {
  const issues = gradeIssues(GRADE);
  assert.equal(issues.length, 2, "one typed candidate + one major finding; info dropped");
  assert.deepEqual(issues.map((i) => i.category), ["http_error", "expectation_violation"]);
  assert.deepEqual(issues.map((i) => i.severity), ["major", "major"]);
  assert.deepEqual(issues[0].steps, [3]);
  assert.deepEqual(issues[1].steps, [19]);
  // malformed entries are skipped, never thrown
  assert.deepEqual(gradeIssues({ findings: [{ severity: "major" }], bug_candidates: [{ kind: "nope", title: "x" }] }), []);
  assert.deepEqual(gradeIssues(null), []);
});

test("run_grade intake: grade issues from a sealed bundle become unreviewed findings, idempotently", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-run-grade-"));
  try {
    await withApp(async ({ app, api }: HostedDynamic) => {
      const project = (await api.post("/projects", { key: "rg", name: "RG" })).body;
      const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "s", name: "S" })).body;
      const snapshotId = ulid();
      await app.db.query(
        `INSERT INTO suite_snapshots (id, suite_id, seq, tree, created_by) VALUES ($1, $2, 1, '{}', $3)`,
        [snapshotId, suite.id, app.ctx.devUserId],
      );
      const env = (await api.post(`/projects/${project.key}/environments`, { name: "staging" })).body;
      const groupId = ulid();
      await app.db.query(
        `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, environment_id, trigger, selection, status)
           VALUES ($1,$2,$3,$4,$5,'{}','{}','done')`,
        [groupId, project.id, suite.id, snapshotId, env.id],
      );
      const runDbId = ulid();
      await app.db.query(
        `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode)
           VALUES ($1,$2,'hobart@tester','hobart',$3,'fail','record')`,
        [runDbId, groupId, `core-${ulid().slice(-6)}`],
      );

      // A real sealed bundle carrying the grade — the exact read caseReport does.
      const runDir = path.join(tmpDir, "run");
      await fsp.mkdir(runDir, { recursive: true });
      await fsp.writeFile(path.join(runDir, "manifest.json"), JSON.stringify({ case: { id: "hobart@tester" } }));
      await fsp.writeFile(path.join(runDir, "trajectory.jsonl"), JSON.stringify({ step: 1, mode: "agent" }) + "\n");
      await fsp.writeFile(path.join(runDir, "grade.json"), JSON.stringify(GRADE));
      const outPath = path.join(tmpDir, "run.ptrun");
      writeBundle(runDir, outPath);
      const bytes = await fsp.readFile(outPath);
      const stored = await app.store.put(`runs/rg/${runDbId}.ptrun`, bytes);
      await app.db.query(
        `INSERT INTO artifacts (id, run_id, kind, key, sha256, size, tier, verified_at)
           VALUES ($1, $2, 'bundle', $3, $4, $5, 'full', now())`,
        [ulid(), runDbId, `runs/rg/${runDbId}.ptrun`, stored.sha256, stored.size],
      );

      const collected = await collectRunGradeIssues(app, runDbId, null);
      assert.ok(collected, "the sealed bundle's grade must be readable");
      assert.equal(collected.issues.length, 2);

      const run: HostedDynamic = { id: runDbId, case_id: "hobart@tester", story_id: "hobart" };
      const ingest = () =>
        app.db.withTx((tx: HostedDynamic) => ingestRunGradeFindings(tx, { projectId: project.id, run, collected }));
      const first: HostedDynamic = await ingest();
      assert.equal(first.findings, 2, "both issues enter intake");

      const rows = (
        await app.db.query(
          `SELECT * FROM findings WHERE project_id = $1 ORDER BY created_at, id`,
          [project.id],
        )
      ).rows;
      assert.equal(rows.length, 2, "two findings filed");
      for (const row of rows) {
        assert.equal(row.source, "run_grade");
        assert.equal(row.state, "new", "no CONFIRMED state without a reviewer");
        assert.equal(row.first_run_id, runDbId);
        assert.equal(row.summary.story_id, "hobart");
      }
      assert.deepEqual(rows.map((r: HostedDynamic) => r.severity).sort(), ["major", "major"]);
      assert.ok(rows.some((r: HostedDynamic) => r.title === "Export endpoint returns 500"));
      assert.ok(rows.some((r: HostedDynamic) => r.title.includes("never showed the eligibility")));
      const evidence = (
        await app.db.query(`SELECT * FROM finding_evidence ORDER BY created_at, id`, [])
      ).rows;
      assert.equal(evidence.length, 2, "each issue cites its run/step once");

      // Runner retry: the same report re-lands on the same findings.
      const second = await ingest();
      assert.equal(second.findings, 2, "retry walks the same issues");
      const after = await app.db.query(`SELECT COUNT(*) AS n FROM findings WHERE project_id = $1`, [project.id]);
      assert.equal(Number(after.rows[0].n), 2, "idempotent: no duplicate findings");
      const keys = await app.db.query(`SELECT COUNT(*) AS n FROM finding_intake_keys WHERE project_id = $1`, [project.id]);
      assert.equal(Number(keys.rows[0].n), 2, "one durable intake key per issue");
    });
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});
