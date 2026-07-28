// Pins the 204-dispatch correlation contract: GitHub's
// workflow_dispatch API returns 204 with no run id, so `dispatches.workflow_run_id`
// starts NULL and is backfilled by one of two paths — the reconciler's run-name
// scan (`reconcileDispatches` / `findDispatchRun`) or the executor's OIDC exchange
// (`POST /runner/exchange` with `dispatch_id`, no `run_group_id`). This file drives
// both paths end to end: a successful run-name correlation, an uncorrelated
// dispatch dying at the deadline (with bounded re-dispatch then a final death), and
// an OIDC exchange backfill (positive + repository-mismatch negative).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { withApp, createTarget, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";
import { reconcileDispatches } from "../../src/dispatch/reconciler.ts";

async function launchGroup(api: HostedDynamic) {
  const project = (await api.post("/projects", { key: "corr", name: "Correlation" })).body;
  const { ring } = await createTarget(api, project, {
    key: "todos",
    name: "Todos",
    ringKey: "staging",
    baseUrl: "http://127.0.0.1:9",
    config: { secret_env: {} },
  });
  const suite = (await api.post("/projects/corr/suites", { slug: "todos", name: "Todos" })).body;
  const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`));
  assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);
  const launched = await api.post("/projects/corr/run-groups", {
    suite_id: suite.id,
    ring_id: ring.id,
    selection: { ids: ["add-todo"], mode: "auto" },
  });
  assert.equal(launched.status, 200, JSON.stringify(launched.body));
  return launched.body.run_group.id;
}

class MockGitHub204 {
  enabled = true;
  findDispatchRunCalls: HostedDynamic[] = [];
  declare _findDispatchRun: HostedDynamic;
  constructor({ findDispatchRun = null }: HostedDynamic = {}) {
    this._findDispatchRun = findDispatchRun;
  }
  async dispatchWorkflow() {
    return { workflow_run_id: null, workflow_run_url: null };
  }
  async findDispatchRun(dispatchId: HostedDynamic, opts: HostedDynamic) {
    this.findDispatchRunCalls.push({ dispatchId, opts });
    return this._findDispatchRun ? this._findDispatchRun(dispatchId, opts) : null;
  }
  async getRunStatus(id: HostedDynamic) {
    return { id, status: "queued", conclusion: null, url: `https://gha.invalid/run/${id}` };
  }
  async cancelRun() {
    return { ok: true };
  }
}

test("reconciler correlates a 204 dispatch by run name and reads status next cycle", async () => {
  const github = new MockGitHub204({
    findDispatchRun: () => ({ id: "555", status: "queued", conclusion: null, url: "https://gha.invalid/run/555" }),
  });
  await withApp(async ({ api, app }: HostedDynamic) => {
    const groupId = await launchGroup(api);

    const before = await api.get("/projects/corr/dispatches");
    assert.equal(before.body.items.length, 1);
    const dispatchRow = before.body.items[0];
    assert.equal(dispatchRow.workflow_run_id, null);
    assert.equal(dispatchRow.status, "scheduled");

    const results: HostedDynamic = await reconcileDispatches(app.ctx);
    assert.equal(results.length, 1);
    assert.equal(results[0].action, "correlated");
    assert.equal(results[0].workflow_run_id, "555");
    assert.equal(github.findDispatchRunCalls.length, 1);
    assert.equal(github.findDispatchRunCalls[0].dispatchId, dispatchRow.id);

    const after = await api.get("/projects/corr/dispatches");
    const row: HostedDynamic = after.body.items.find((d: HostedDynamic) => d.id === dispatchRow.id);
    assert.equal(row.workflow_run_id, "555");
    assert.equal(row.workflow_run_url, "https://gha.invalid/run/555");

    const again: HostedDynamic = await reconcileDispatches(app.ctx);
    assert.equal(again.length, 1);
    assert.equal(again[0].action, "queued");

    void groupId;
  }, {}, { github });
});

test("uncorrelated dispatch dies at the deadline and the remainder re-dispatches", async () => {
  const github = new MockGitHub204({ findDispatchRun: () => null });
  await withApp(async ({ api, app }: HostedDynamic) => {
    const groupId = await launchGroup(api);

    const first: HostedDynamic = await reconcileDispatches(app.ctx);
    assert.equal(first.length, 1);
    assert.equal(first[0].action, "awaiting_correlation");

    await app.db.query(`UPDATE dispatches SET requested_at = $1`, [new Date(Date.now() - 30 * 60_000)]);
    const second: HostedDynamic = await reconcileDispatches(app.ctx);
    assert.equal(second.length, 1);
    assert.equal(second[0].action, "redispatched");

    const dispatches = (await api.get("/projects/corr/dispatches")).body.items;
    assert.equal(dispatches.length, 2, "original attempt + redispatch attempt");
    const original = dispatches.find((d: HostedDynamic) => d.attempt === 1);
    const retry = dispatches.find((d: HostedDynamic) => d.attempt === 2);
    assert.equal(original.status, "reconciled_dead");
    assert.match(original.error, /correlation deadline/);
    assert.ok(["requested", "scheduled", "running"].includes(retry.status), `unexpected retry status ${retry.status}`);

    const runGroupAfterRetry = await api.get(`/run-groups/${groupId}`);
    assert.equal(runGroupAfterRetry.body.runs[0].status, "queued");

    const audit1 = await api.get("/projects/corr/audit");
    assert.ok(audit1.body.items.some((a: HostedDynamic) => a.action === "dispatch.dead"));

    await app.db.query(`UPDATE dispatches SET requested_at = $1`, [new Date(Date.now() - 30 * 60_000)]);
    const third: HostedDynamic = await reconcileDispatches(app.ctx);
    assert.equal(third.length, 1);
    assert.equal(third[0].action, "dead");

    const finalRunGroup = await api.get(`/run-groups/${groupId}`);
    assert.equal(finalRunGroup.body.status, "done");
    assert.equal(finalRunGroup.body.runs[0].status, "infra");
    assert.equal(finalRunGroup.body.runs[0].error, "runner died before case started");

    const auditAfter = await api.get("/projects/corr/audit");
    assert.equal(auditAfter.body.items.filter((a: HostedDynamic) => a.action === "dispatch.dead").length, 2);
  }, { PLAYTEST_DISPATCH_CORRELATE_DEADLINE_S: "60" }, { github });
});

test("OIDC exchange backfills workflow_run_id via dispatch_id", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" });
  const jwks = { keys: [{ ...publicJwk, kid: "k1", alg: "RS256", use: "sig" }] };

  const jwksServer: HostedDynamic = http.createServer((req: HostedDynamic, res: HostedDynamic) => {
    if (req.url === "/.well-known/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jwks));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  const jwksPort = jwksServer.address().port;
  const issuerUrl = `http://127.0.0.1:${jwksPort}`;

  const signToken = (claims: HostedDynamic) => {
    const header = { alg: "RS256", typ: "JWT", kid: "k1" };
    const h = Buffer.from(JSON.stringify(header)).toString("base64url");
    const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = crypto.createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey);
    return `${h}.${p}.${sig.toString("base64url")}`;
  };

  try {
    const github = new MockGitHub204({ findDispatchRun: () => null });
    await withApp(async ({ api, base }: HostedDynamic) => {
      const groupId = await launchGroup(api);
      const dispatchRow = (await api.get("/projects/corr/dispatches")).body.items[0];
      assert.equal(dispatchRow.workflow_run_id, null);

      const now = Math.floor(Date.now() / 1000);
      const goodToken = signToken({
        iss: issuerUrl,
        aud: "playtest",
        run_id: "987654",
        repository: "acme/rig",
        exp: now + 600,
      });

      const exchanged = await fetch(`${base}/api/v1/runner/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ github_oidc_token: goodToken, dispatch_id: dispatchRow.id }),
      });
      const exchangedBody: HostedDynamic = await exchanged.json();
      assert.equal(exchanged.status, 200, JSON.stringify(exchangedBody));
      assert.ok(exchangedBody.token);
      assert.ok(exchangedBody.executor_id);

      const afterGood = (await api.get("/projects/corr/dispatches")).body.items.find((d: HostedDynamic) => d.id === dispatchRow.id);
      assert.equal(afterGood.workflow_run_id, "987654");
      assert.equal(afterGood.status, "running");
      assert.equal(afterGood.workflow_run_url, "https://github.com/acme/rig/actions/runs/987654");

      const evilToken = signToken({
        iss: issuerUrl,
        aud: "playtest",
        run_id: "987654",
        repository: "evil/other",
        exp: now + 600,
      });
      const rejected = await fetch(`${base}/api/v1/runner/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ github_oidc_token: evilToken, dispatch_id: dispatchRow.id }),
      });
      const rejectedBody = await rejected.json();
      assert.equal(rejected.status, 401);
      assert.equal(rejectedBody.error.code, "unauthenticated");

      const unchanged = (await api.get("/projects/corr/dispatches")).body.items.find((d: HostedDynamic) => d.id === dispatchRow.id);
      assert.equal(unchanged.workflow_run_id, "987654");
      assert.equal(unchanged.status, "running");

      void groupId;
    }, { GITHUB_OIDC_ISSUER: issuerUrl, GITHUB_REPOSITORY: "acme/rig" }, { github });
  } finally {
    await new Promise((resolve) => jwksServer.close(resolve));
  }
});
