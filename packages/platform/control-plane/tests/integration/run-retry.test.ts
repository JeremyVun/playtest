import test from "node:test";
import assert from "node:assert/strict";
import { withApp, createTarget, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";

test("retry resets never-started stories inside one run group and double-clicks conflict", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "retry", name: "Retry" })).body;
    const { ring } = await createTarget(api, project, {
      key: "todos",
      name: "Todos",
      ringKey: "staging",
      baseUrl: "http://127.0.0.1:9",
      runnerLabels: ["local"],
      config: { secret_env: {} },
    });
    const suite = (await api.post(`/projects/${project.key}/suites`, {
      slug: "todos",
      name: "Todos",
    })).body;
    const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`));
    assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);

    const launched = await api.post(`/projects/${project.key}/run-groups`, {
      suite_id: suite.id,
      ring_id: ring.id,
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
    // The retry posts a new board entry; the group is queued again until a
    // runner claims it, exactly as the first attempt was.
    assert.equal(retried.body.run_group.status, "queued");
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
    // The retry posts exactly one new board entry, and it stays `requested`
    // until a runner claims it — placement starts nothing.
    assert.deepEqual(attempts.rows.map((r: HostedDynamic) => [r.attempt, r.status]), [
      [1, "reconciled_dead"],
      [2, "requested"],
    ]);
  });
});
