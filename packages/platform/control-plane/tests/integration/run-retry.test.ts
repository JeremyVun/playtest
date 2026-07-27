import test from "node:test";
import assert from "node:assert/strict";
import { withApp, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";

class MockDispatch {
  enabled = true;
  dispatches: HostedDynamic[] = [];

  async dispatchWorkflow(req: HostedDynamic) {
    this.dispatches.push(req);
    const n = this.dispatches.length;
    return {
      workflow_run_id: `wr-${n}`,
      workflow_run_url: `https://runner.invalid/${n}`,
    };
  }

  async cancelRun() {
    return { ok: true };
  }
}

test("retry resets never-started stories inside one run group and double-clicks conflict", async () => {
  const dispatch = new MockDispatch();
  await withApp(async ({ api, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "retry", name: "Retry" })).body;
    const suite = (await api.post(`/projects/${project.key}/suites`, {
      slug: "todos",
      name: "Todos",
    })).body;
    const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`));
    assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);
    const environment = (await api.post(`/projects/${project.key}/environments`, {
      name: "staging",
      runner_labels: ["local"],
      config: { app: { base_url: "http://127.0.0.1:9" }, secret_env: {} },
    })).body;

    const launched = await api.post(`/projects/${project.key}/run-groups`, {
      suite_id: suite.id,
      environment_id: environment.id,
      selection: { mode: "auto" },
    });
    assert.equal(launched.status, 200);
    const groupId = launched.body.run_group.id;
    const before = await app.db.query(
      `SELECT id, case_id FROM runs WHERE run_group_id = $1 ORDER BY case_id`,
      [groupId],
    );
    const [finished, ...neverStarted] = before.rows;
    const now = new Date();
    const neverStartedIds = neverStarted.map((r: HostedDynamic) => r.id);
    const finishedAtParam = neverStartedIds.length + 1;
    await app.db.withTx(async (tx: HostedDynamic) => {
      await tx.query(
        `UPDATE runs
            SET status = 'pass', started_at = $2, finished_at = $2, duration_ms = 10
          WHERE id = $1`,
        [finished.id, now],
      );
      await tx.query(
        `UPDATE runs
            SET status = 'infra', finished_at = $${finishedAtParam}, error = 'runner died before case started'
          WHERE id IN (${neverStartedIds.map((_: string, i: number) => `$${i + 1}`).join(",")})`,
        [...neverStartedIds, now],
      );
      await tx.query(
        `UPDATE run_groups SET status = 'done', exit_summary = '{}', updated_at = $2 WHERE id = $1`,
        [groupId, now],
      );
      await tx.query(
        `UPDATE dispatches
            SET status = 'reconciled_dead', concluded_at = $2, error = 'runner died'
          WHERE kind = 'group' AND ref_id = $1`,
        [groupId, now],
      );
    });

    const retried = await api.post(`/run-groups/${groupId}/retry`, {});
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.run_group.id, groupId, "retry keeps the original run group");
    assert.equal(retried.body.retried, neverStarted.length);
    assert.equal(retried.body.run_group.status, "running");
    assert.deepEqual(
      retried.body.run_group.runs.map((r: HostedDynamic) => [r.id, r.status]),
      before.rows.map((r: HostedDynamic) => [
        r.id,
        r.id === finished.id ? "pass" : "queued",
      ]),
      "finished verdicts stay put and only never-started stories return to the queue",
    );

    const duplicate = await api.post(`/run-groups/${groupId}/retry`, {});
    assert.equal(duplicate.status, 409, "a second click cannot create another active attempt");
    const groups = await app.db.query(`SELECT COUNT(*) AS n FROM run_groups WHERE project_id = $1`, [project.id]);
    assert.equal(groups.rows[0].n, 1, "retry creates no new run group");
    const attempts = await app.db.query(
      `SELECT attempt, status FROM dispatches WHERE kind = 'group' AND ref_id = $1 ORDER BY attempt`,
      [groupId],
    );
    assert.deepEqual(attempts.rows.map((r: HostedDynamic) => [r.attempt, r.status]), [
      [1, "reconciled_dead"],
      [2, "scheduled"],
    ]);
    assert.equal(dispatch.dispatches.length, 2, "the retry creates exactly one placement attempt");
  }, {}, { github: dispatch });
});
