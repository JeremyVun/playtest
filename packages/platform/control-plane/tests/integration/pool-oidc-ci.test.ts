// R2: the CI half of the runner pool, driven exactly as a GitHub Actions job
// drives it — a signed OIDC token in, an ephemeral runner out, a launch pinned
// to that runner's own label, a verdict.
//
// Covered here: registration accepted and immediately usable on the board;
// refused for the wrong audience, repository, workflow and ref; refused before
// the deployment pins a repository at all; ephemeral runners never listed as
// standing; expiry refused at poll, claim AND exchange; the registration flagged
// in audit with its verified provenance; and per-launch label pinning —
// authorization, precedence over the ring, the record on the group, and
// the concurrency trap it exists to prevent (two pipelines must not claim each
// other's builds).
//
// The JWKS server is a loopback fixture, like `correlation.test.ts`: GitHub's
// signature check is real, GitHub is not.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { withApp, createTarget, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";

/** A loopback issuer that signs tokens the way GitHub's does. */
async function issuer() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] };
  const server: HostedDynamic = http.createServer((req: HostedDynamic, res: HostedDynamic) => {
    if (req.url === "/.well-known/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jwks));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const sign = (claims: HostedDynamic) => {
    const h = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" })).toString("base64url");
    const p = Buffer.from(JSON.stringify({ iss: url, exp: Math.floor(Date.now() / 1000) + 600, ...claims })).toString(
      "base64url",
    );
    const sig = crypto.createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey);
    return `${h}.${p}.${sig.toString("base64url")}`;
  };
  return { url, sign, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** What a job in the reference workflow presents: its own run's badge. */
const ciToken = (
  sign: HostedDynamic,
  { runId = "900100", runAttempt = "1", ...over }: HostedDynamic = {},
) =>
  sign({
    aud: "playtest",
    repository: "acme/storefront",
    job_workflow_ref: "acme/storefront/.github/workflows/playtest.yml@refs/heads/main",
    ref: "refs/heads/main",
    sha: "b7f2c1d9e0a4",
    run_id: runId,
    run_attempt: runAttempt,
    ...over,
  });

/** The deployment side of the CI recipe: pool placement with the repository pinned. */
const ciEnv = (issuerUrl: string, over: HostedDynamic = {}) => ({
  PLAYTEST_POOL_OIDC_ISSUER: issuerUrl,
  PLAYTEST_POOL_OIDC_REPOSITORY: "acme/storefront",
  ...over,
});

/** A project with the todos suite committed and one labelled ring. */
async function setUp(api: HostedDynamic, { key, labels = [] }: HostedDynamic) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const { application, ring } = await createTarget(api, project, {
    key: "todos",
    ringKey: "ci",
    baseUrl: "http://127.0.0.1:9",
    runnerLabels: labels,
  });
  const suite = (await api.post(`/projects/${key}/suites`, { slug: "todos", name: "Todos" })).body;
  const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`));
  assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);
  return { project, suite, application, ring };
}

/** A scripted runner: nothing but its credential and fetch, dialling out. */
function runner(base: HostedDynamic, credential: HostedDynamic) {
  const call = async (method: HostedDynamic, path: HostedDynamic, body?: HostedDynamic) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${credential}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return {
    poll: (query = "") => call("GET", `/runner/pool/claims${query}`),
    claim: (dispatch: HostedDynamic) => call("POST", `/runner/pool/claims/${dispatch}`, {}),
    heartbeat: (dispatch: HostedDynamic) => call("POST", `/runner/pool/claims/${dispatch}/heartbeat`, {}),
    exchange: (body: HostedDynamic) => call("POST", `/runner/exchange`, body),
  };
}

const registerOidc = async (base: HostedDynamic, body: HostedDynamic) => {
  const res = await fetch(`${base}/api/v1/runner/pool/register-oidc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test("ci: an OIDC token registers an ephemeral runner that can take work at once", async () => {
  const gh = await issuer();
  try {
    await withApp(async ({ api, base, app }: HostedDynamic) => {
      const { project, suite, ring } = await setUp(api, { key: "ci1" });
      const label = "ci-run-900100";

      const registered = await registerOidc(base, {
        github_oidc_token: ciToken(gh.sign),
        project: project.key,
        labels: [label],
      });
      assert.equal(registered.status, 201, JSON.stringify(registered.body));
      assert.ok(registered.body.credential.startsWith("ptr_"), "the credential is minted once, here");
      assert.equal(registered.body.ephemeral, true);
      assert.deepEqual(registered.body.labels, [label]);
      // Named from the VERIFIED token, never from the request: a CI job cannot
      // register under a standing runner's name.
      assert.match(registered.body.name, /^ci-900100\.1-[0-9a-f]{6}$/);
      const expiresAt = new Date(registered.body.expires_at).getTime();
      const ttl = expiresAt - Date.now();
      assert.ok(ttl > 0 && ttl <= 3_600_000, `expires within the default hour, got ${ttl}ms`);

      // Pipeline scaffolding is not fleet: Settings → Runners never shows it.
      const listed = await api.get(`/projects/${project.key}/runners`);
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.body.items, []);

      // The registration is flagged in audit with its verified provenance, so a
      // reviewer can see which build asked for a runner.
      const entry = (await api.get(`/projects/${project.key}/audit`)).body.items.find(
        (a: HostedDynamic) => a.action === "runner.registered",
      );
      assert.equal(entry.detail.ephemeral, true);
      assert.deepEqual(entry.actor, { system: "github_oidc" });
      assert.equal(entry.detail.source.repository, "acme/storefront");
      assert.equal(entry.detail.source.run_id, "900100");

      // And it is a real runner: it claims and exchanges like any other.
      const ci = runner(base, registered.body.credential);
      const launched = await api.post(`/projects/${project.key}/run-groups`, {
        suite_id: suite.id,
        ring_id: ring.id,
        selection: { ids: ["add-todo"] },
        runner_labels: [label],
      });
      assert.equal(launched.status, 200, JSON.stringify(launched.body));
      const offer = await ci.poll();
      assert.equal(offer.body.offers[0].labels[0], label);
      const claimed = await ci.claim(offer.body.offers[0].dispatch_id);
      assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
      const exchanged = await ci.exchange({ dispatch_id: offer.body.offers[0].dispatch_id, isolation: "process" });
      assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
      assert.ok(exchanged.body.token.startsWith("pr_"));

      void app;
    }, ciEnv(gh.url));
  } finally {
    await gh.close();
  }
});

test("ci: a token from the wrong audience, repository, workflow or ref registers nothing", async () => {
  const gh = await issuer();
  try {
    await withApp(async ({ api, base }: HostedDynamic) => {
      const { project } = await setUp(api, { key: "ci2" });
      const attempt = (claims: HostedDynamic) =>
        registerOidc(base, { github_oidc_token: ciToken(gh.sign, claims), project: project.key, labels: ["x"] });

      for (const [what, claims] of [
        ["audience", { aud: "some-other-service" }],
        ["repository", { repository: "evil/other" }],
        ["workflow", { job_workflow_ref: "acme/storefront/.github/workflows/release.yml@refs/heads/main" }],
        ["ref", { job_workflow_ref: "acme/storefront/.github/workflows/playtest.yml@refs/heads/attacker" }],
        ["expiry", { exp: Math.floor(Date.now() / 1000) - 10 }],
      ] as Array<[string, HostedDynamic]>) {
        const res = await attempt(claims);
        assert.equal(res.status, 401, `${what}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.error.code, "unauthenticated");
      }

      // A token nobody signed is not a token.
      const forged = await registerOidc(base, {
        github_oidc_token: "not.a.jwt",
        project: project.key,
        labels: ["x"],
      });
      assert.equal(forged.status, 401);

      // Nothing above created a runner, ephemeral or otherwise.
      assert.deepEqual((await api.get(`/projects/${project.key}/runners`)).body.items, []);
    }, ciEnv(gh.url, { PLAYTEST_POOL_OIDC_WORKFLOW: "playtest.yml", PLAYTEST_POOL_OIDC_REF: "main" }));
  } finally {
    await gh.close();
  }
});

test("ci: registration stays closed until the deployment names the repository", async () => {
  const gh = await issuer();
  try {
    // No repository pin: an unpinned check would accept a token from any
    // repository on GitHub, so the route refuses to serve.
    await withApp(async ({ api, base }: HostedDynamic) => {
      const { project } = await setUp(api, { key: "ci3" });
      const res = await registerOidc(base, {
        github_oidc_token: ciToken(gh.sign),
        project: project.key,
        labels: ["x"],
      });
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, "not_configured");
      assert.match(res.body.error.message, /PLAYTEST_POOL_OIDC_REPOSITORY/);
    }, { PLAYTEST_POOL_OIDC_ISSUER: gh.url });
  } finally {
    await gh.close();
  }
});

test("ci: an expired ephemeral credential is refused at poll, claim and exchange", async () => {
  const gh = await issuer();
  try {
    await withApp(async ({ api, base, app }: HostedDynamic) => {
      const { project, suite, ring } = await setUp(api, { key: "ci5" });
      const label = "ci-run-900200";
      const registered = await registerOidc(base, {
        github_oidc_token: ciToken(gh.sign, { runId: "900200" }),
        project: project.key,
        labels: [label],
      });
      assert.equal(registered.status, 201);
      const ci = runner(base, registered.body.credential);

      const launched = await api.post(`/projects/${project.key}/run-groups`, {
        suite_id: suite.id,
        ring_id: ring.id,
        selection: { ids: ["add-todo"] },
        runner_labels: [label],
      });
      const dispatchId = (await ci.poll()).body.offers[0].dispatch_id;
      assert.ok(dispatchId);

      // The job it registered for is over.
      await app.db.query(`UPDATE runners SET expires_at = $1 WHERE id = $2`, [
        new Date(Date.now() - 1000),
        registered.body.id,
      ]);

      for (const [what, res] of [
        ["poll", await ci.poll()],
        ["claim", await ci.claim(dispatchId)],
        ["exchange", await ci.exchange({ dispatch_id: dispatchId, isolation: "process" })],
      ] as Array<[string, HostedDynamic]>) {
        assert.equal(res.status, 403, `${what}: ${JSON.stringify(res.body)}`);
        assert.match(res.body.error.message, /registration expired/, what);
      }
      // Nothing was placed, so the group is still on the board for a live runner.
      const group = await api.get(`/run-groups/${launched.body.run_group.id}`);
      assert.equal(group.body.placement.runner, null);
    }, ciEnv(gh.url));
  } finally {
    await gh.close();
  }
});

test("ci: a registration that expires mid-group does not interrupt the group it is running", async () => {
  const gh = await issuer();
  try {
    await withApp(async ({ api, base, app }: HostedDynamic) => {
      const { project, suite, ring } = await setUp(api, { key: "ci6" });
      const label = "ci-run-900300";
      const registered = await registerOidc(base, {
        github_oidc_token: ciToken(gh.sign, { runId: "900300" }),
        project: project.key,
        labels: [label],
      });
      assert.equal(registered.status, 201);
      const ci = runner(base, registered.body.credential);

      const launched = await api.post(`/projects/${project.key}/run-groups`, {
        suite_id: suite.id,
        ring_id: ring.id,
        selection: { ids: ["add-todo"] },
        runner_labels: [label],
      });
      const groupId = launched.body.run_group.id;
      const dispatchId = (await ci.poll()).body.offers[0].dispatch_id;
      assert.equal((await ci.claim(dispatchId)).status, 200);
      const exchanged = await ci.exchange({ dispatch_id: dispatchId, isolation: "process" });
      assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));

      // A long suite outlives PLAYTEST_POOL_OIDC_TTL_S. The registration is over;
      // the group it is halfway through is not.
      await app.db.query(`UPDATE runners SET expires_at = $1 WHERE id = $2`, [
        new Date(Date.now() - 1000),
        registered.body.id,
      ]);
      assert.equal((await ci.poll()).status, 403, "no new work");
      const beat = await ci.heartbeat(dispatchId);
      assert.equal(beat.status, 200, JSON.stringify(beat.body));
      assert.equal(beat.body.canceled, false);

      // The scoped bearer it already holds carries the group to the end.
      const headers = { authorization: `Bearer ${exchanged.body.token}`, "content-type": "application/json" };
      const spec = await fetch(`${base}/api/v1/runner/groups/${groupId}`, { headers }).then((r) => r.json());
      const run = spec.cases[0];
      assert.equal(
        (await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${run.run_id}/start`, { method: "POST", headers, body: "{}" })).status,
        200,
      );
      const upload = await fetch(`${base}/api/v1/runner/runs/${run.db_id}/bundle`, {
        method: "PUT",
        headers: { authorization: `Bearer ${exchanged.body.token}`, "content-type": "application/vnd.playtest.run-bundle" },
        body: Buffer.from("fake bundle"),
      }).then((r) => r.json());
      assert.equal(
        (await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${run.run_id}/report`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            status: "pass",
            bundle: upload.artifact,
            manifest: { run_id: run.run_id, case: { id: "add-todo" }, result: { status: "pass", end_reason: "done" }, status: "pass", duration_ms: 42, totals: { in: 0, out: 0 } },
          }),
        })).status,
        200,
      );
      assert.equal(
        (await fetch(`${base}/api/v1/runner/groups/${groupId}/complete`, { method: "POST", headers, body: JSON.stringify({ summary: {} }) })).status,
        200,
      );
      assert.equal((await api.get(`/run-groups/${groupId}`)).body.status, "done");
    }, ciEnv(gh.url));
  } finally {
    await gh.close();
  }
});

test("ci: one workflow run cannot fill the table with registrations", async () => {
  const gh = await issuer();
  try {
    await withApp(async ({ api, base }: HostedDynamic) => {
      const { project } = await setUp(api, { key: "ci6" });
      for (let i = 0; i < 8; i++) {
        const res = await registerOidc(base, {
          github_oidc_token: ciToken(gh.sign, { runId: "900300" }),
          project: project.key,
          labels: ["ci-run-900300"],
        });
        assert.equal(res.status, 201, `registration ${i}: ${JSON.stringify(res.body)}`);
      }
      const capped = await registerOidc(base, {
        github_oidc_token: ciToken(gh.sign, { runId: "900300" }),
        project: project.key,
        labels: ["ci-run-900300"],
      });
      assert.equal(capped.status, 409);
      assert.match(capped.body.error.message, /already has 8 live ephemeral runners/);
      // A different workflow run is unaffected — the cap is per run, not per project.
      const other = await registerOidc(base, {
        github_oidc_token: ciToken(gh.sign, { runId: "900301" }),
        project: project.key,
        labels: ["ci-run-900301"],
      });
      assert.equal(other.status, 201);
    }, ciEnv(gh.url));
  } finally {
    await gh.close();
  }
});

test("launch: pinned labels override the ring's, are recorded, and survive a retry", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project, suite, ring } = await setUp(api, { key: "pin1", labels: ["staging-box"] });

    // The preview says placement out loud before anyone commits to it.
    const preview = await api.post(`/projects/${project.key}/run-groups/preview`, {
      suite_id: suite.id,
      ring_id: ring.id,
      selection: { ids: ["add-todo"] },
      runner_labels: ["ci-run-42"],
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.placement, {
      runner_labels: ["ci-run-42"],
      labels_source: "launch",
      runner_online: false,
    });
    const unpinned = await api.post(`/projects/${project.key}/run-groups/preview`, {
      suite_id: suite.id,
      ring_id: ring.id,
      selection: { ids: ["add-todo"] },
    });
    assert.deepEqual(unpinned.body.placement, {
      runner_labels: ["staging-box"],
      labels_source: "ring",
      runner_online: false,
    });

    const launched = await api.post(`/projects/${project.key}/run-groups`, {
      suite_id: suite.id,
      ring_id: ring.id,
      selection: { ids: ["add-todo"] },
      runner_labels: ["ci-run-42"],
    });
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    const groupId = launched.body.run_group.id;

    // The pin rides the group, and the board entry carries it instead of the
    // ring's label.
    const group = await api.get(`/run-groups/${groupId}`);
    assert.deepEqual(group.body.runner_labels, ["ci-run-42"]);
    assert.deepEqual(group.body.placement.labels, ["ci-run-42"]);
    assert.equal(group.body.placement.labels_source, "launch");

    // The concurrency trap this exists to prevent: the staging runner this
    // ring normally uses must NOT be able to take this build's job.
    const standing = (await api.post(`/projects/${project.key}/runners`, {
      name: "staging-box",
      labels: ["staging-box"],
    })).body;
    const wrong = runner(base, standing.credential);
    assert.deepEqual((await wrong.poll()).body.offers, [], "a job pinned elsewhere is not even offered");
    const dispatchId = group.body.placement.dispatch_id;
    const refused = await wrong.claim(dispatchId);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /ci-run-42/);

    // The pipeline's own runner takes it.
    const ci = (await api.post(`/projects/${project.key}/runners`, {
      name: "ci-42",
      labels: ["ci-run-42"],
    })).body;
    const mine = runner(base, ci.credential);
    assert.equal((await mine.poll()).body.offers[0].dispatch_id, dispatchId);

    // A retry of a pinned group is placed the same way, even after the ring's
    // own labels move on.
    assert.equal((await api.put(`/rings/${ring.id}`, { runner_labels: ["somewhere-else"] })).status, 200);
    await app.db.query(`UPDATE run_groups SET status = 'done' WHERE id = $1`, [groupId]);
    await app.db.query(
      `UPDATE runs SET status = 'infra', started_at = NULL WHERE run_group_id = $1`,
      [groupId],
    );
    await app.db.query(`UPDATE dispatches SET status = 'concluded', concluded_at = now() WHERE ref_id = $1`, [groupId]);
    const retried = await api.post(`/run-groups/${groupId}/retry`, {});
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.deepEqual(retried.body.run_group.placement.labels, ["ci-run-42"]);
  });
});

test("launch: pinning is a launch decision — a viewer cannot make it, and nonsense is refused", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const { project, suite, ring } = await setUp(api, { key: "pin2", labels: ["staging-box"] });

    // Same role that can launch, no more and no less: labels route work, they
    // confer no authority, and a runner only ever reaches its own project.
    const viewer = (await api.post(`/projects/${project.key}/tokens`, { role: "viewer", name: "ci-read" })).body.token;
    const denied = await api.withToken(viewer).post(`/projects/${project.key}/run-groups`, {
      suite_id: suite.id,
      ring_id: ring.id,
      selection: { ids: ["add-todo"] },
      runner_labels: ["ci-run-42"],
    });
    assert.equal(denied.status, 403);

    const editor = (await api.post(`/projects/${project.key}/tokens`, { role: "editor", name: "ci-write" })).body.token;
    const allowed = await api.withToken(editor).post(`/projects/${project.key}/run-groups`, {
      suite_id: suite.id,
      ring_id: ring.id,
      selection: { ids: ["add-todo"] },
      runner_labels: ["ci-run-42"],
    });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));

    const bad = await api.post(`/projects/${project.key}/run-groups`, {
      suite_id: suite.id,
      ring_id: ring.id,
      selection: { ids: ["add-todo"] },
      runner_labels: ["", "ok"],
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /"runner_labels" must be an array/);

    // An explicit empty pin is a decision — "any runner in this project" — and
    // is not the same as leaving it out.
    const anywhere = await api.post(`/projects/${project.key}/run-groups`, {
      suite_id: suite.id,
      ring_id: ring.id,
      selection: { ids: ["add-todo"] },
      runner_labels: [],
    });
    assert.equal(anywhere.status, 200, JSON.stringify(anywhere.body));
    const group = await api.get(`/run-groups/${anywhere.body.run_group.id}`);
    assert.deepEqual(group.body.placement.labels, []);
    assert.equal(group.body.placement.labels_source, "launch");
  });
});
