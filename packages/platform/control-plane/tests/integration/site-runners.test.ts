// Site-scoped runners and the dev peer runner (design "The local peer runner",
// gates 6, 11 and 15).
//
// A site-scoped runner is one row with no project: a machine a site operator
// deliberately trusted with every project's suites and secrets. Everything about
// it that could go quietly wrong is asserted here rather than assumed:
//
//   * scope really is a boundary — a project runner cannot see, claim, or
//     exchange another project's work;
//   * scope is not authority — a site runner's exchanged bearer is scoped to the
//     ONE dispatch it claimed, and one claim is one claim globally;
//   * revocation kills a credential every project trusts, without killing the
//     group already running under its issued bearer (gate 15);
//   * the projection is tenant-shaped: project B sees the machine come and go
//     and sees that it is busy, and never learns a dispatch or run id belonging
//     to project A (gate 15);
//   * the dev peer runner is idempotent and its credential file is `0600`;
//   * a launch with nobody polling starts nothing (gate 6), and the same peer
//     runner serves `kind: mint` across projects with zero ceremony (gate 11).
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { withApp, createTarget, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { claimer, registerRunner, startPoolAgent, untilAgent as until } from "./exec-helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";
import { reconcileDispatches } from "../../src/dispatch/reconciler.ts";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/app.ts";
import { localRunnerCredentialPath, LOCAL_RUNNER_NAME } from "../../src/dev-runner.ts";

/** A project with the todos suite committed and one unlabelled ring. */
async function setUp(api: HostedDynamic, key: string, { labels = [] as string[] } = {}) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const { ring } = await createTarget(api, project, {
    key: "todos",
    ringKey: "laptop",
    baseUrl: "http://127.0.0.1:9",
    runnerLabels: labels,
  });
  const suite = (await api.post(`/projects/${key}/suites`, { slug: "todos", name: "Todos" })).body;
  const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`));
  assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);
  return { project, suite, ring };
}

const launch = async (api: HostedDynamic, { project, suite, ring }: HostedDynamic) => {
  const res = await api.post(`/projects/${project.key}/run-groups`, {
    suite_id: suite.id,
    ring_id: ring.id,
    selection: { ids: ["add-todo"] },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.run_group.id as string;
};

/** Register a site-scoped runner through the lifecycle API. */
async function registerSiteRunner(api: HostedDynamic, body: HostedDynamic = {}) {
  const res = await api.post("/site/runners", { name: `site-${Math.random().toString(36).slice(2, 8)}`, ...body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

/** The dispatch row backing a launched group. */
async function dispatchOf(app: HostedDynamic, groupId: string) {
  const { rows } = await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1 ORDER BY attempt DESC`, [groupId]);
  assert.ok(rows[0], `no dispatch for group ${groupId}`);
  return rows[0];
}

// --------------------------------------------------------------------------
// The lifecycle API
// --------------------------------------------------------------------------

test("site runners: register, list and revoke are gated to the site admin and audited", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const { project } = await setUp(api, "sitelc");

    const registered = await registerSiteRunner(api, { name: "build-box", labels: ["macos"] });
    assert.ok(registered.credential.startsWith("ptr_"), "the credential is minted once, here and nowhere else");
    assert.equal(registered.scope, "site");
    assert.equal(registered.project_id, null);

    // The same name twice is a friendly conflict, not a raw constraint error —
    // the partial unique index over `project_id IS NULL` is what enforces it,
    // because SQLite treats every NULL project as distinct.
    const dup = await api.post("/site/runners", { name: "build-box" });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error.message, /already registered/);

    // A project may legitimately name a runner `build-box` too: the namespaces
    // are separate, and only site names collide with site names.
    assert.equal((await api.post(`/projects/${project.key}/runners`, { name: "build-box" })).status, 201);

    const listed = await api.get("/site/runners");
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.body.items.map((r: HostedDynamic) => r.name).sort(),
      [LOCAL_RUNNER_NAME, "build-box"].sort(),
      "the dev peer runner is a site runner like any other",
    );
    assert.equal("credential" in listed.body.items[0], false);

    // Every grant and every retraction is on the audit trail, with no project.
    const audited = await api.get(`/projects/${project.key}/audit`);
    assert.equal(
      audited.body.items.some((a: HostedDynamic) => a.action === "runner.registered" && a.detail?.scope === "site"),
      false,
      "a site runner's audit rows belong to the site, not to any one project",
    );

    assert.equal((await api.del(`/site/runners/${registered.id}`)).status, 204);
    // Revoking twice is a no-op, not an error.
    assert.equal((await api.del(`/site/runners/${registered.id}`)).status, 204);
    const after = await api.get("/site/runners");
    assert.ok(after.body.items.find((r: HostedDynamic) => r.id === registered.id).revoked_at);
  });
});

test("site runners: a project admin is not a site admin — the grant is above every project", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const { project } = await setUp(api, "siteauthz");
    // An admin token for the project — the strongest authority the product
    // hands out — and it is still refused, because a site-scoped runner would
    // receive OTHER projects' secrets.
    const token = (await api.post(`/projects/${project.key}/tokens`, { role: "admin", name: "ci" })).body.token;
    const scoped = api.withToken(token);

    const refused = await scoped.post("/site/runners", { name: "sneaky" });
    assert.equal(refused.status, 403);
    assert.match(refused.body.error.message, /site administrator/);
    assert.match(refused.body.error.message, /PLAYTEST_AUTH=dev/);
    assert.equal((await scoped.get("/site/runners")).status, 403);
    assert.equal((await scoped.del("/site/runners/whatever")).status, 403);
  });
});

// --------------------------------------------------------------------------
// Scope is a boundary
// --------------------------------------------------------------------------

test("scope: a project runner can neither see, claim, nor exchange another project's work", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const a = await setUp(api, "scopea");
    const b = await setUp(api, "scopeb");
    const groupA = await launch(api, a);
    const groupB = await launch(api, b);
    const dispatchB = await dispatchOf(app, groupB);

    const runnerA = await registerRunner(api, a.project, { name: "a-laptop" });
    const agent = claimer(base, runnerA.credential);

    const offered = await agent.poll();
    assert.equal(offered.status, 200);
    assert.deepEqual(
      offered.body.offers.map((o: HostedDynamic) => o.run_group_id),
      [groupA],
      "the board a project runner sees is its own project's",
    );
    assert.equal(offered.body.runner.scope, "project");

    // Naming another project's dispatch outright does not widen it.
    const claimed = await agent.claim(dispatchB.id);
    assert.equal(claimed.status, 404, JSON.stringify(claimed.body));
    const exchanged = await agent.exchange({ dispatch_id: dispatchB.id });
    assert.equal(exchanged.status, 403, JSON.stringify(exchanged.body));
    assert.equal((await agent.heartbeat(dispatchB.id)).status, 404);
  });
});

test("scope: a site runner claims across projects, one claim globally, bearer scoped to the claim", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const a = await setUp(api, "sitea");
    const b = await setUp(api, "siteb");
    const groupA = await launch(api, a);
    const groupB = await launch(api, b);
    const dispatchA = await dispatchOf(app, groupA);
    const dispatchB = await dispatchOf(app, groupB);

    const site = await registerSiteRunner(api, { name: "shared-box" });
    const agent = claimer(base, site.credential);

    const offered = await agent.poll();
    assert.equal(offered.status, 200);
    assert.equal(offered.body.runner.scope, "site");
    assert.equal(offered.body.runner.project_key, null);
    // One board across every project, and every offer names its own project on
    // the envelope — the only way a site runner can tell them apart.
    assert.deepEqual(
      offered.body.offers.map((o: HostedDynamic) => o.project_key).sort(),
      ["sitea", "siteb"],
    );
    for (const offer of offered.body.offers) assert.ok(offer.project_id, "every offer names its project");

    assert.equal((await agent.claim(dispatchA.id)).status, 200);
    // One claim GLOBALLY: holding project A's group is what stops it taking
    // project B's, exactly as it stops it taking a second group in one project.
    const second = await agent.claim(dispatchB.id);
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.match(second.body.error.message, /one group at a time/);

    // …and the board says so: offered nothing, handed back what it holds.
    const busy = await agent.poll();
    assert.deepEqual(busy.body.offers, []);
    assert.equal(busy.body.current.run_group_id, groupA);
    assert.equal(busy.body.current.project_key, "sitea");

    // Claiming assigns; exchanging authorizes — and it authorizes exactly ONE
    // dispatch. A site runner's bearer is project-scoped after the claim in the
    // only sense that matters: it opens project A's group and nothing else.
    const exchanged = await agent.exchange({ dispatch_id: dispatchA.id });
    assert.equal(exchanged.status, 200);
    const bearer = { authorization: `Bearer ${exchanged.body.token}` };
    assert.equal((await fetch(`${base}/api/v1/runner/groups/${groupA}`, { headers: bearer })).status, 200);
    assert.equal(
      (await fetch(`${base}/api/v1/runner/groups/${groupB}`, { headers: bearer })).status,
      403,
      "the bearer cannot reach the other project's group",
    );
  });
});

test("scope: a polling site runner counts as presence for the project it can serve", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const a = await setUp(api, "presence");

    // Nothing is polling yet — and the ensured `local` peer runner has never
    // checked in, so presence is honest about that.
    const cold = await api.post(`/projects/${a.project.key}/run-groups/preview`, {
      suite_id: a.suite.id,
      ring_id: a.ring.id,
      selection: { ids: ["add-todo"] },
    });
    assert.equal(cold.status, 200, JSON.stringify(cold.body));
    assert.equal(cold.body.placement.runner_online, false);

    const site = await registerSiteRunner(api, { name: "shared-box" });
    assert.equal((await claimer(base, site.credential).poll()).status, 200);

    // A launch preview that ignored site runners would say "nothing here can
    // take this" about the very machine `npm run hosted` has polling.
    const warm = await api.post(`/projects/${a.project.key}/run-groups/preview`, {
      suite_id: a.suite.id,
      ring_id: a.ring.id,
      selection: { ids: ["add-todo"] },
    });
    assert.equal(warm.body.placement.runner_online, true);

    // …and the unclaimed diagnostic names it rather than claiming the project
    // has no runner at all.
    const groupId = await launch(api, a);
    const dispatch = await dispatchOf(app, groupId);
    await app.db.query(`UPDATE dispatches SET requested_at = $2 WHERE id = $1`, [dispatch.id, new Date(Date.now() - 3_600_000)]);
    const results = await reconcileDispatches(app.ctx);
    assert.equal(results.find((r: HostedDynamic) => r.dispatch_id === dispatch.id)?.action, "dead", JSON.stringify(results));
    const failed = await api.get(`/run-groups/${groupId}`);
    assert.match(failed.body.runs[0].error, /shared-box/);
  }, { PLAYTEST_POOL_CLAIM_TIMEOUT_S: "60" });
});

// --------------------------------------------------------------------------
// Gate 15
// --------------------------------------------------------------------------

test("revoking a site runner blocks poll, claim and exchange while its group finishes", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const a = await setUp(api, "revokea");
    const b = await setUp(api, "revokeb");
    const groupA = await launch(api, a);
    const groupB = await launch(api, b);
    const dispatchA = await dispatchOf(app, groupA);
    const dispatchB = await dispatchOf(app, groupB);

    const site = await registerSiteRunner(api, { name: "doomed" });
    const agent = claimer(base, site.credential);
    assert.equal((await agent.claim(dispatchA.id)).status, 200);
    const exchanged = await agent.exchange({ dispatch_id: dispatchA.id });
    assert.equal(exchanged.status, 200);
    const bearer = { authorization: `Bearer ${exchanged.body.token}`, "content-type": "application/json" };

    assert.equal((await api.del(`/site/runners/${site.id}`)).status, 204);

    // No new work, in any project, and no new authority.
    const polled = await agent.poll();
    assert.equal(polled.status, 403);
    assert.match(polled.body.error.message, /revoked/);
    assert.equal((await agent.claim(dispatchB.id)).status, 403);
    assert.equal((await agent.exchange({ dispatch_id: dispatchB.id })).status, 403);

    // The group already exchanged finishes under the bearer it was issued —
    // including its liveness channel, without which the reconciler would fail
    // it as a dead executor mid-run.
    const beat = await agent.heartbeat(dispatchA.id);
    assert.equal(beat.status, 200, JSON.stringify(beat.body));
    assert.equal(beat.body.canceled, false);
    const spec = await fetch(`${base}/api/v1/runner/groups/${groupA}`, { headers: bearer });
    assert.equal(spec.status, 200);
    const run = (await spec.json()).cases[0];
    assert.equal(
      (await fetch(`${base}/api/v1/runner/groups/${groupA}/cases/${run.run_id}/start`, { method: "POST", headers: bearer, body: "{}" })).status,
      200,
      "work in flight keeps running",
    );
  });
});

test("project B sees the site runner and that it is busy — never project A's identifiers", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const a = await setUp(api, "tenanta");
    const b = await setUp(api, "tenantb");
    const groupA = await launch(api, a);
    const dispatchA = await dispatchOf(app, groupA);

    const site = await registerSiteRunner(api, { name: "shared-box" });
    const agent = claimer(base, site.credential);
    assert.equal((await agent.claim(dispatchA.id)).status, 200);

    // Project A owns this work and sees all of it.
    const seenByA = (await api.get(`/projects/${a.project.key}/runners`)).body.items.find(
      (r: HostedDynamic) => r.id === site.id,
    );
    assert.equal(seenByA.scope, "site");
    assert.equal(seenByA.managed_here, false, "read-only: a project developer cannot revoke a site runner");
    assert.equal(seenByA.claim.foreign, false);
    assert.equal(seenByA.claim.dispatch_id, dispatchA.id);
    assert.equal(seenByA.claim.run_group_id, groupA);

    // Project B sees the same machine, sees that it is busy, and learns nothing
    // else. The list view joins claim ids in, so this projection is the thing
    // standing between a tenant and another tenant's run history.
    const listB = await api.get(`/projects/${b.project.key}/runners`);
    const seenByB = listB.body.items.find((r: HostedDynamic) => r.id === site.id);
    assert.ok(seenByB, "an applicable site runner is listed in every project");
    assert.equal(seenByB.claim.foreign, true, "busy in another project");
    assert.equal(seenByB.claim.dispatch_id, null);
    assert.equal(seenByB.claim.kind, null);
    assert.equal(seenByB.claim.run_group_id, null);
    assert.equal(seenByB.claim.mint_claim_id, null);
    assert.ok(seenByB.claim.claimed_at, "busy since — presence, not identity");
    const serialized = JSON.stringify(listB.body);
    assert.equal(serialized.includes(dispatchA.id), false, "project B's runner list names no dispatch of project A's");
    assert.equal(serialized.includes(groupA), false, "…and no run group of project A's either");

    // A project developer is refused the revoke outright, with the remedy.
    const refused = await api.del(`/projects/${b.project.key}/runners/${site.id}`);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error.message, /site-scoped/);

    // The feeds say the same thing. Presence and registry edges fan out to
    // every project (a platform event row requires one); the CLAIM lands only
    // in the project whose work it is.
    const feedOf = async (key: string) =>
      (await api.get(`/projects/${key}/events/feed?after=00000000000000000000000000&types=runner.status`)).body.events;
    const feedA = await feedOf(a.project.key);
    const feedB = await feedOf(b.project.key);
    const states = (events: HostedDynamic[]) => events.map((e: HostedDynamic) => e.payload.state);
    assert.ok(states(feedA).includes("registered"), "project A saw the machine arrive");
    assert.ok(states(feedB).includes("registered"), "so did project B");
    assert.ok(states(feedA).includes("claimed"));
    assert.equal(states(feedB).includes("claimed"), false, "a claim is not project B's news");
    assert.equal(JSON.stringify(feedB).includes(dispatchA.id), false);
    assert.equal(JSON.stringify(feedB).includes(groupA), false);
    for (const event of [...feedA, ...feedB]) assert.equal(event.payload.scope, "site");
  });
});

// --------------------------------------------------------------------------
// The dev peer runner
// --------------------------------------------------------------------------

/** Boot a control plane against `dataRoot` and close it again. */
async function boot(dataRoot: string, fn: (app: HostedDynamic) => Promise<void>) {
  const config = loadConfig({
    PLAYTEST_DATA_DIR: dataRoot,
    PLAYTEST_AUTH: "dev",
    OBJECT_STORE_URL: path.join(dataRoot, "objects"),
    PLAYTEST_KMS_KEY: Buffer.alloc(32, 3).toString("base64"),
    LOG_LEVEL: "error",
    PLAYTEST_RATE_LIMIT_WRITES_PER_MIN: "0",
    PLAYTEST_RECONCILE_INTERVAL_S: "0",
  });
  const app = await createApp(config);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test("dev peer runner: ensured once, reused on every later boot, credential file 0600", async () => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ptpeer-"));
  const file = localRunnerCredentialPath(dataRoot);
  try {
    let firstId = "";
    let firstCredential = "";
    await boot(dataRoot, async (app) => {
      const { rows } = await app.db.query(`SELECT * FROM runners WHERE project_id IS NULL`);
      assert.equal(rows.length, 1, "one site-scoped runner, ensured at boot");
      assert.equal(rows[0].name, LOCAL_RUNNER_NAME);
      assert.deepEqual(rows[0].labels, [], "no labels: it takes any job whose ring pins none");
      firstId = rows[0].id;
      firstCredential = fs.readFileSync(file, "utf8").trim();
      assert.ok(firstCredential.startsWith("ptr_"));
      // A long-lived secret on a machine someone else may share.
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    });

    // A second boot reuses the row AND the credential: the agent started
    // alongside it must not have the value pulled out from under it.
    await boot(dataRoot, async (app) => {
      const { rows } = await app.db.query(`SELECT * FROM runners WHERE project_id IS NULL`);
      assert.equal(rows.length, 1, "idempotent — no second row");
      assert.equal(rows[0].id, firstId);
      assert.equal(fs.readFileSync(file, "utf8").trim(), firstCredential);
    });

    // Only a hash is stored, so a credential file that no longer matches cannot
    // be recovered — it is re-issued on the SAME row, and the old value dies.
    fs.rmSync(file);
    await boot(dataRoot, async (app) => {
      const { rows } = await app.db.query(`SELECT * FROM runners WHERE project_id IS NULL`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, firstId, "the runner keeps its identity and its history");
      const reissued = fs.readFileSync(file, "utf8").trim();
      assert.ok(reissued.startsWith("ptr_"));
      assert.notEqual(reissued, firstCredential);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    });
  } finally {
    await fsp.rm(dataRoot, { recursive: true, force: true });
  }
});

test("nothing runs until a runner polls, then the dev peer runner serves the board", async () => {
  let agent: HostedDynamic = null;
  try {
    await withApp(async ({ api, base, app }: HostedDynamic) => {
      const { project } = await setUp(api, "peerrun");
      const secret = await api.post(`/projects/${project.key}/secrets`, { name: "root-pw", value: "hunter2" });
      assert.ok(secret.status < 300, JSON.stringify(secret.body));
      const provider = (
        await api.post(`/projects/${project.key}/auth-providers`, {
          name: "portal",
          kind: "script",
          code: `console.log(JSON.stringify({ cookies: [{ name: "sid", value: process.env.ROOT_PW, domain: "localhost", path: "/" }], origins: [] }));\n`,
          config: { secret_env: { ROOT_PW: "root-pw" } },
          identities: { admin: { username: "root" } },
          ttl_minutes: 45,
        })
      ).body;

      // Gate 6: the launch posts to the board and stops. No process is started,
      // no executor registered — the work simply waits for someone to dial in.
      const minted = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
      assert.equal(minted.status, 202, JSON.stringify(minted.body));
      const dispatchId = minted.body.mint.dispatch_id;
      await new Promise((r) => setTimeout(r, 300));
      const before = await app.db.query(`SELECT * FROM dispatches WHERE id = $1`, [dispatchId]);
      assert.equal(before.rows[0].status, "requested");
      assert.equal(before.rows[0].runner_id, null, "the control plane starts nothing in response to a launch");
      assert.equal((await app.db.query(`SELECT COUNT(*) AS n FROM executors`)).rows[0].n, 0);

      // Gate 11: the credential the control plane wrote for the dev peer runner
      // is all `npm run hosted` gives the agent — no per-project registration,
      // no console step. It claims this project's mint and fulfills it.
      const credential = fs.readFileSync(localRunnerCredentialPath(app.config.dataDir), "utf8").trim();
      agent = startPoolAgent(base, credential);
      await until(
        async () => /Playtest runner "local" — every project on this deployment/.test(agent.out.stdout),
        "the peer runner to say what it serves",
        agent,
        20_000,
      );

      const claim = await until(
        async () => {
          const { rows } = await app.db.query(`SELECT * FROM session_claims WHERE id = $1`, [minted.body.mint.claim_id]);
          return rows[0]?.status === "fulfilled" ? rows[0] : null;
        },
        "the peer runner to fulfill the mint",
        agent,
        60_000,
      );
      assert.equal(claim.status, "fulfilled");
      const after = await app.db.query(`SELECT * FROM dispatches WHERE id = $1`, [dispatchId]);
      assert.equal(after.rows[0].status, "concluded");
      const runner = await app.db.query(`SELECT * FROM runners WHERE id = $1`, [after.rows[0].runner_id]);
      assert.equal(runner.rows[0].project_id, null, "claimed by the site-scoped peer runner");

      await agent.stop();
    });
  } finally {
    if (agent) await agent.stop();
  }
});
