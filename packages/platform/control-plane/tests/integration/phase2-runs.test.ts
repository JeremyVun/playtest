import test from "node:test";
import assert from "node:assert/strict";
import { withApp, createTarget, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";
import { claimAndExchange } from "./exec-helpers.ts";

test("phase2: launch, claim, exchange, and the runner protocol with an auth broker", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "phase2", name: "Phase 2" })).body;
    const { ring } = await createTarget(api, project, {
      key: "todos",
      name: "Todos",
      ringKey: "staging",
      baseUrl: "http://127.0.0.1:9",
      runnerLabels: ["self-hosted", "playtest"],
      config: {
        auth: { default: "member", identities: { member: { $session: "sso/member" } } },
        secret_env: {},
      },
    });
    const suite = (await api.post("/projects/phase2/suites", { slug: "todos", name: "Todos" })).body;
    const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`));
    assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);
    assert.equal((await api.post("/projects/phase2/secrets", {
      name: "member-state",
      value: JSON.stringify({ cookies: [{ name: "sid", value: "member" }], origins: [] }),
    })).status, 201);
    const provider = (await api.post("/projects/phase2/auth-providers", {
      name: "sso",
      kind: "storage_state_secret",
      identities: { member: "member-state" },
      config: {},
      ttl_minutes: 60,
    })).body;

    const launched = await api.post("/projects/phase2/run-groups", {
      suite_id: suite.id,
      ring_id: ring.id,
      selection: { ids: ["add-todo"], mode: "auto", max_steps: 77, timeout_ms: 360_000 },
    });
    assert.equal(launched.status, 200);
    const groupId = launched.body.run_group.id;

    // The one arrival: a registered runner takes the offer off the board,
    // claims it, and exchanges its credential for the group-scoped bearer.
    const { headers: runnerHeaders } = await claimAndExchange(api, base, {
      project,
      groupId,
      labels: ["self-hosted", "playtest"],
    });
    const spec = await fetch(`${base}/api/v1/runner/groups/${groupId}`, { headers: runnerHeaders }).then((r) => r.json());
    assert.deepEqual(spec.sessions.needed, ["sso/member"]);
    assert.equal(spec.cases.length, 1);
    assert.deepEqual(spec.cases[0].options.limits, { max_steps: 77, timeout_ms: 360_000 },
      "one-run limit overrides reach the executor protocol");

    await Promise.all([
      fetch(`${base}/api/v1/runner/sessions/claim`, { method: "POST", headers: runnerHeaders, body: JSON.stringify({ sessions: ["sso/member"] }) }).then((r) => r.json()),
      fetch(`${base}/api/v1/runner/sessions/claim`, { method: "POST", headers: runnerHeaders, body: JSON.stringify({ sessions: ["sso/member"] }) }).then((r) => r.json()),
    ]);
    const sessions = await api.get(`/auth-providers/${provider.id}/sessions`);
    assert.equal(sessions.body.items.length, 1, "single-flight claim leaves one cached artifact");

    const run: HostedDynamic = spec.cases[0];
    assert.equal((await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${run.run_id}/start`, {
      method: "POST", headers: runnerHeaders, body: "{}",
    })).status, 200);
    const upload = await fetch(`${base}/api/v1/runner/runs/${run.db_id}/bundle`, {
      method: "PUT",
      headers: { authorization: runnerHeaders.authorization, "content-type": "application/vnd.playtest.run-bundle" },
      body: Buffer.from("fake bundle"),
    }).then((r) => r.json());
    assert.equal(upload.artifact.size, 11);
    assert.equal((await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${run.run_id}/report`, {
      method: "POST",
      headers: runnerHeaders,
      body: JSON.stringify({
        status: "pass",
        bundle: upload.artifact,
        manifest: {
          run_id: run.run_id,
          case: { id: "add-todo", limits: { max_steps: 77, timeout_ms: 360_000 } },
          result: { status: "pass", end_reason: "done" },
          status: "pass",
          duration_ms: 123,
          totals: { in: 0, out: 0 },
        },
      }),
    })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/runner/groups/${groupId}/complete`, {
      method: "POST", headers: runnerHeaders, body: JSON.stringify({ summary: {} }),
    })).status, 200);

    const final = await api.get(`/run-groups/${groupId}`);
    assert.equal(final.body.status, "done");
    assert.equal(final.body.runs[0].status, "pass");
    assert.equal(final.body.runs[0].end_reason, "done");
    assert.deepEqual(final.body.runs[0].limits, { max_steps: 77, timeout_ms: 360_000 });
    assert.equal(final.body.runs[0].artifact.size, 11);
    const health = await api.get("/projects/phase2/health");
    assert.equal(health.body.pass_rate_7d, 100);
    assert.equal(health.body.pass_count_7d, 1);
    assert.equal(health.body.graded_count_7d, 1);
    const feed = await api.get("/projects/phase2/events/feed?after=00000000000000000000000000&types=run.status");
    assert.ok(feed.body.items.some((e: HostedDynamic) => e.entity.run_group_id === groupId));
  });
});
