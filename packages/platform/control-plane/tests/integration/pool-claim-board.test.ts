// R0: the runner registry and the claim board, driven end to end by a SCRIPTED
// claimer — the real runner agent grows its pool mode in R1, and none of this
// needs it. Every request below is the claimer dialling out, because the control
// plane never connects to a runner.
//
// Covered here: register → poll → a claim race two runners enter and one wins →
// exchange → the existing executor protocol → report → complete; a revoked
// credential refused at poll, claim and exchange; label subset matching; a
// `mint` claim on the same board; the unclaimed timeout failing a group with an
// actionable message; a heartbeat-stale claim reconciling to infra failure with
// bounded re-dispatch; and cancellation observed at the heartbeat.
import test from "node:test";
import assert from "node:assert/strict";
import { withApp, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";
import { reconcileDispatches } from "../../src/dispatch/reconciler.ts";

const POOL = { PLAYTEST_DISPATCH: "pool" };

/** A scripted self-hosted runner: nothing but its credential and fetch. */
function claimer(base: HostedDynamic, credential: HostedDynamic) {
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
    claim: (dispatchId: HostedDynamic) => call("POST", `/runner/pool/claims/${dispatchId}`, {}),
    heartbeat: (dispatchId: HostedDynamic) => call("POST", `/runner/pool/claims/${dispatchId}/heartbeat`, {}),
    exchange: (body: HostedDynamic) => call("POST", `/runner/exchange`, body),
  };
}

/** A project with the todos suite committed and one labelled environment. */
async function setUp(api: HostedDynamic, { key, labels = ["macos"] }: HostedDynamic) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const suite = (await api.post(`/projects/${key}/suites`, { slug: "todos", name: "Todos" })).body;
  const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`));
  assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);
  const env = (
    await api.post(`/projects/${key}/environments`, {
      name: "laptop",
      runner_labels: labels,
      config: { app: { base_url: "http://127.0.0.1:9" } },
    })
  ).body;
  return { project, suite, env };
}

const launch = (api: HostedDynamic, { project, suite, env, ids = ["add-todo"] }: HostedDynamic) =>
  api.post(`/projects/${project.key}/run-groups`, {
    suite_id: suite.id,
    environment_id: env.id,
    selection: { ids },
  });

async function register(api: HostedDynamic, project: HostedDynamic, body: HostedDynamic) {
  const res = await api.post(`/projects/${project.key}/runners`, body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test("pool: register, poll, race one winner, exchange, execute, report, complete", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project, suite, env } = await setUp(api, { key: "pool1", labels: ["macos"] });
    const runner = await register(api, project, { name: "adas-laptop", labels: ["macos", "ios-sim"] });
    assert.ok(runner.credential.startsWith("ptr_"), "the credential is minted once at registration");
    const second = await register(api, project, { name: "spare-mini", labels: ["macos"] });
    // The plaintext is never readable again.
    const listed = await api.get(`/projects/${project.key}/runners`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 2);
    assert.equal("credential" in listed.body.items[0], false);
    assert.deepEqual(listed.body.items.map((r: HostedDynamic) => r.name).sort(), ["adas-laptop", "spare-mini"]);
    // A duplicate name is a friendly conflict, never a raw constraint error.
    const dup = await api.post(`/projects/${project.key}/runners`, { name: "adas-laptop" });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error.message, /already registered/);

    const one = claimer(base, runner.credential);
    const two = claimer(base, second.credential);

    // Nothing on the board yet: a held read returns an empty offer, promptly.
    const idle = await one.poll("?wait=1");
    assert.equal(idle.status, 200);
    assert.equal(idle.body.claim, null);

    const launched = await launch(api, { project, suite, env });
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    const groupId = launched.body.run_group.id;
    // Placement started nothing: the requested dispatch row IS the board entry.
    const board = await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1`, [groupId]);
    assert.equal(board.rows[0].status, "requested");
    assert.deepEqual(board.rows[0].labels, ["macos"]);
    assert.equal((await api.get(`/run-groups/${groupId}`)).body.status, "queued");

    const offered = await one.poll("?wait=true");
    assert.equal(offered.body.claim.kind, "group");
    assert.equal(offered.body.claim.run_group_id, groupId);
    assert.deepEqual(offered.body.claim.labels, ["macos"]);
    const dispatchId = offered.body.claim.dispatch_id;
    // Both runners are eligible and both see the same offer.
    assert.equal((await two.poll()).body.claim.dispatch_id, dispatchId);

    const [a, b] = await Promise.all([one.claim(dispatchId), two.claim(dispatchId)]);
    const winners: HostedDynamic[] = [a, b].filter((r) => r.status === 200);
    const losers: HostedDynamic[] = [a, b].filter((r) => r.status !== 200);
    assert.equal(winners.length, 1, `exactly one winner: ${JSON.stringify([a, b])}`);
    assert.equal(losers[0].status, 409);
    assert.match(losers[0].body.error.message, /already claimed by another runner/);
    const winner = winners[0] === a ? one : two;
    const loser = winners[0] === a ? two : one;
    assert.equal(winners[0].body.claimed, true);
    assert.ok(winners[0].body.heartbeat_interval_s > 0);

    // The winning claim moved the dispatch to scheduled and announced
    // provisioning exactly as a GitHub dispatch does.
    const claimed = await app.db.query(`SELECT * FROM dispatches WHERE id = $1`, [dispatchId]);
    assert.equal(claimed.rows[0].status, "scheduled");
    assert.ok(claimed.rows[0].claimed_at);
    const feed = await api.get(`/projects/${project.key}/events/feed?after=00000000000000000000000000&types=run.status`);
    assert.ok(
      feed.body.items.some((e: HostedDynamic) => e.payload.status === "provisioning" && e.entity.run_group_id === groupId),
      "the claim emits the provisioning event",
    );
    // The loser goes back to polling and finds nothing left to take.
    assert.equal((await loser.poll()).body.claim, null);

    // Claiming assigns; it grants nothing. Only the exchange authorizes.
    const exchanged = await winner.exchange({ dispatch_id: dispatchId, isolation: "process" });
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
    assert.ok(exchanged.body.token);
    // A runner that did not claim this dispatch cannot exchange for it.
    const stolen = await loser.exchange({ dispatch_id: dispatchId, isolation: "process" });
    assert.equal(stolen.status, 403);
    assert.match(stolen.body.error.message, /does not hold an active claim/);

    // From here the EXISTING executor protocol runs unchanged.
    const runnerHeaders = { authorization: `Bearer ${exchanged.body.token}`, "content-type": "application/json" };
    const spec = await fetch(`${base}/api/v1/runner/groups/${groupId}`, { headers: runnerHeaders }).then((r) => r.json());
    assert.equal(spec.cases.length, 1);
    assert.deepEqual(spec.environment.runner_labels, ["macos"]);
    const run = spec.cases[0];
    assert.equal(
      (await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${run.run_id}/start`, { method: "POST", headers: runnerHeaders, body: "{}" })).status,
      200,
    );
    // Mid-group the console can see which runner is executing what.
    const busy = await api.get(`/projects/${project.key}/runners`);
    const busyRow = busy.body.items.find((r: HostedDynamic) => r.claim);
    assert.equal(busyRow.claim.run_group_id, groupId);
    assert.ok(busyRow.last_seen_at);

    const beat = await winner.heartbeat(dispatchId);
    assert.equal(beat.status, 200);
    assert.equal(beat.body.canceled, false);
    // Only the claim holder may heartbeat it.
    assert.equal((await loser.heartbeat(dispatchId)).status, 403);

    const upload = await fetch(`${base}/api/v1/runner/runs/${run.db_id}/bundle`, {
      method: "PUT",
      headers: { authorization: `Bearer ${exchanged.body.token}`, "content-type": "application/vnd.playtest.run-bundle" },
      body: Buffer.from("fake bundle"),
    }).then((r) => r.json());
    assert.equal(
      (await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${run.run_id}/report`, {
        method: "POST",
        headers: runnerHeaders,
        body: JSON.stringify({
          status: "pass",
          bundle: upload.artifact,
          manifest: { run_id: run.run_id, case: { id: "add-todo" }, result: { status: "pass", end_reason: "done" }, status: "pass", duration_ms: 42, totals: { in: 0, out: 0 } },
        }),
      })).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/api/v1/runner/groups/${groupId}/complete`, { method: "POST", headers: runnerHeaders, body: JSON.stringify({ summary: {} }) })).status,
      200,
    );

    const final = await api.get(`/run-groups/${groupId}`);
    assert.equal(final.body.status, "done");
    assert.equal(final.body.runs[0].status, "pass");
    const audit = await api.get(`/projects/${project.key}/audit?limit=50`);
    const actions = audit.body.items.map((a: HostedDynamic) => a.action);
    for (const expected of ["runner.registered", "runner.claimed", "run_group.completed"]) {
      assert.ok(actions.includes(expected), `${expected} is audited (${actions.join(",")})`);
    }
  }, POOL);
});

test("pool: a revoked credential is refused at poll, claim, and exchange", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const { project, suite, env } = await setUp(api, { key: "pool2" });
    const runner = await register(api, project, { name: "adas-laptop", labels: ["macos"] });
    const live = await register(api, project, { name: "keeper", labels: ["macos"] });
    const revoked = claimer(base, runner.credential);
    const keeper = claimer(base, live.credential);

    const groupId = (await launch(api, { project, suite, env })).body.run_group.id;
    const dispatchId = (await keeper.poll()).body.claim.dispatch_id;

    assert.equal((await api.del(`/projects/${project.key}/runners/${runner.id}`)).status, 204);
    // Revoking twice is a no-op, not an error.
    assert.equal((await api.del(`/projects/${project.key}/runners/${runner.id}`)).status, 204);

    for (const [what, res] of [
      ["poll", await revoked.poll()],
      ["claim", await revoked.claim(dispatchId)],
      ["exchange", await revoked.exchange({ dispatch_id: dispatchId })],
    ] as HostedDynamic[]) {
      assert.equal(res.status, 403, `${what} refuses a revoked credential`);
      assert.match(res.body.error.message, /was revoked/, `${what} says why`);
    }
    // An unregistered credential is unauthenticated, not forbidden.
    const stranger = claimer(base, "ptr_not-a-real-credential");
    assert.equal((await stranger.poll()).status, 401);
    assert.equal((await claimer(base, "").poll()).status, 401);

    // The live runner is unaffected and still takes the work.
    assert.equal((await keeper.claim(dispatchId)).status, 200);
    assert.equal((await keeper.exchange({ dispatch_id: dispatchId })).status, 200);
    assert.equal((await api.get(`/run-groups/${groupId}`)).body.status, "running");
    // A revoked runner stays listed with its revocation, so history reads.
    const listed = await api.get(`/projects/${project.key}/runners`);
    assert.ok(listed.body.items.find((r: HostedDynamic) => r.id === runner.id).revoked_at);
  }, POOL);
});

test("pool: label matching is subset semantics, oldest first, project-scoped", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const { project, suite, env } = await setUp(api, { key: "pool3", labels: ["macos", "ios-sim"] });
    // A second environment with no labels at all: any runner in the project.
    const anyEnv = (
      await api.post(`/projects/${project.key}/environments`, {
        name: "anywhere",
        runner_labels: [],
        config: { app: { base_url: "http://127.0.0.1:9" } },
      })
    ).body;
    // Another project's runner must never see this project's board.
    const other = await setUp(api, { key: "pool3other", labels: [] });
    const outsider = claimer(base, (await register(api, other.project, { name: "outsider" })).credential);

    const partial = claimer(base, (await register(api, project, { name: "linux-box", labels: ["macos"] })).credential);
    const full = claimer(base, (await register(api, project, { name: "adas-laptop", labels: ["macos", "ios-sim", "spare"] })).credential);

    const labelled = (await launch(api, { project, suite, env })).body.run_group.id;
    // The partial runner advertises a subset of what the job needs: no offer.
    assert.equal((await partial.poll()).body.claim, null);
    assert.equal((await outsider.poll()).body.claim, null);
    const offer = await full.poll();
    assert.equal(offer.body.claim.run_group_id, labelled);

    // An unlabelled job matches any runner in the project, and the board is
    // served oldest first — the labelled group was launched first.
    const unlabelled = (await launch(api, { project, suite, env: anyEnv })).body.run_group.id;
    assert.equal((await partial.poll()).body.claim.run_group_id, unlabelled);
    assert.equal((await full.poll()).body.claim.run_group_id, labelled, "oldest eligible entry first");

    // Labels are advertised at check-in and confer no authority: re-advertising
    // moves which jobs a runner matches, never which project it can reach.
    const readvertised = await partial.poll("?labels=macos,ios-sim");
    assert.equal(readvertised.body.claim.run_group_id, labelled);
    assert.deepEqual(readvertised.body.runner.labels, ["macos", "ios-sim"]);
    assert.equal((await outsider.poll("?labels=macos,ios-sim")).body.claim, null);

    // One runner takes one group at a time: while it holds a claim the board
    // offers it nothing and hands back what it is already executing, which is
    // also how an agent restarted mid-group finds its work again.
    const labelledDispatch = readvertised.body.claim.dispatch_id;
    assert.equal((await full.claim(labelledDispatch)).status, 200);
    const busy = await full.poll();
    assert.equal(busy.body.claim, null);
    assert.equal(busy.body.current.run_group_id, labelled);
    const greedy = await full.claim((await partial.poll()).body.claim.dispatch_id);
    assert.equal(greedy.status, 409);
    assert.match(greedy.body.error.message, /one group at a time/);
    // Re-claiming what it already holds is idempotent, not a lost race.
    assert.equal((await full.claim(labelledDispatch)).status, 200);
  }, POOL);
});

test("pool: a mint dispatch is served on the same board and exchanges to a mint token", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const { project } = await setUp(api, { key: "pool4" });
    assert.equal(
      (await api.post(`/projects/${project.key}/secrets`, { name: "root-pw", value: "hunter2" })).status,
      201,
    );
    const provider = (
      await api.post(`/projects/${project.key}/auth-providers`, {
        name: "portal",
        kind: "script",
        code: "console.log(JSON.stringify({cookies: [], origins: []}));",
        config: { secret_env: { ROOT_PW: "root-pw" } },
        identities: { admin: { username: "root" } },
        ttl_minutes: 45,
      })
    ).body;
    const runner = claimer(base, (await register(api, project, { name: "adas-laptop" })).credential);

    const minted = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
    assert.equal(minted.status, 202, JSON.stringify(minted.body));

    const offer = await runner.poll("?wait=true");
    assert.equal(offer.body.claim.kind, "mint", "session minting places through the same board");
    assert.equal(offer.body.claim.mint_claim_id, minted.body.mint.claim_id);
    assert.equal(offer.body.claim.run_group_id, null);

    const dispatchId = offer.body.claim.dispatch_id;
    assert.equal((await runner.claim(dispatchId)).status, 200);
    const exchanged = await runner.exchange({ dispatch_id: dispatchId, isolation: "process" });
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));

    // The bearer is scoped to this mint claim and nothing else.
    const grant = await fetch(`${base}/api/v1/runner/mints/${minted.body.mint.claim_id}`, {
      headers: { authorization: `Bearer ${exchanged.body.token}` },
    });
    assert.equal(grant.status, 200);
    const wrongScope = await fetch(`${base}/api/v1/runner/groups/${minted.body.mint.claim_id}`, {
      headers: { authorization: `Bearer ${exchanged.body.token}` },
    });
    assert.equal(wrongScope.status, 403, "a mint token is not a group token");
  }, POOL);
});

test("pool: a job nothing claims fails the group with the labels named, and is not re-posted", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const { project, suite, env } = await setUp(api, { key: "pool5", labels: ["jeremys-mac"] });
    await register(api, project, { name: "linux-box", labels: ["linux"] });
    const groupId = (await launch(api, { project, suite, env })).body.run_group.id;

    const results = await reconcileDispatches(app.ctx);
    assert.equal(results[0].action, "dead", JSON.stringify(results));

    const group = await api.get(`/run-groups/${groupId}`);
    assert.equal(group.body.status, "done");
    assert.equal(group.body.exit_summary.exit_code, 2, "an infrastructure failure, not a product verdict");
    assert.equal(group.body.runs[0].status, "infra");
    // The remedy is on the story a person opens, not only in a log line.
    assert.match(group.body.runs[0].error, /jeremys-mac/);
    assert.match(group.body.runs[0].error, /has checked in/);
    assert.match(group.body.runs[0].error, /linux-box/);
    // Re-posting to a board nothing is watching would fail identically.
    const dispatches = await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1`, [groupId]);
    assert.equal(dispatches.rows.length, 1, "no second attempt");
    assert.equal(dispatches.rows[0].status, "reconciled_dead");
    assert.match(dispatches.rows[0].error, /jeremys-mac/);
  }, { ...POOL, PLAYTEST_POOL_CLAIM_TIMEOUT_S: "0" });
});

test("pool: a claim that stops heartbeating is a dead executor, with one bounded re-dispatch", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project, suite, env } = await setUp(api, { key: "pool6", labels: ["macos"] });
    const runner = claimer(base, (await register(api, project, { name: "adas-laptop", labels: ["macos"] })).credential);
    const groupId = (await launch(api, { project, suite, env })).body.run_group.id;
    const first = (await runner.poll()).body.claim.dispatch_id;
    assert.equal((await runner.claim(first)).status, 200);

    // The heartbeat window is zero in this deployment, so the claim reads as
    // gone the moment the reconciler looks at it.
    const results = await reconcileDispatches(app.ctx);
    assert.equal(results.find((r: HostedDynamic) => r.dispatch_id === first).action, "redispatched");

    const dispatches = await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1 ORDER BY attempt`, [groupId]);
    assert.equal(dispatches.rows.length, 2, "the queued remainder is re-posted once");
    assert.equal(dispatches.rows[0].status, "reconciled_dead");
    assert.match(dispatches.rows[0].error, /adas-laptop/);
    assert.equal(dispatches.rows[1].status, "requested");
    assert.deepEqual(dispatches.rows[1].labels, ["macos"], "the re-posted entry carries the same routing");
    // The board offers the second attempt to the same fleet.
    assert.equal((await runner.poll()).body.claim.dispatch_id, dispatches.rows[1].id);

    // Bounded: a second death fails the group instead of looping forever.
    assert.equal((await runner.claim(dispatches.rows[1].id)).status, 200);
    const second = await reconcileDispatches(app.ctx);
    assert.equal(second.find((r: HostedDynamic) => r.dispatch_id === dispatches.rows[1].id).action, "dead");
    const group = await api.get(`/run-groups/${groupId}`);
    assert.equal(group.body.status, "done");
    assert.equal(group.body.runs[0].status, "infra");
  }, { ...POOL, PLAYTEST_POOL_HEARTBEAT_TIMEOUT_S: "0" });
});

test("pool: cancellation reaches the runner at its next heartbeat", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project, suite, env } = await setUp(api, { key: "pool7", labels: ["macos"] });
    const runner = claimer(base, (await register(api, project, { name: "adas-laptop", labels: ["macos"] })).credential);
    const groupId = (await launch(api, { project, suite, env })).body.run_group.id;
    const dispatchId = (await runner.poll()).body.claim.dispatch_id;
    assert.equal((await runner.claim(dispatchId)).status, 200);
    assert.equal((await runner.heartbeat(dispatchId)).body.canceled, false);

    const canceled = await api.post(`/run-groups/${groupId}/cancel`, {});
    assert.equal(canceled.status, 200);
    // No inbound connection exists, so the mark on the claim is the channel.
    const row = await app.db.query(`SELECT canceled_at FROM dispatches WHERE id = $1`, [dispatchId]);
    assert.ok(row.rows[0].canceled_at);
    const beat = await runner.heartbeat(dispatchId);
    assert.equal(beat.status, 200);
    assert.equal(beat.body.canceled, true, "the runner learns to tear down on its own next beat");
    assert.equal((await api.get(`/run-groups/${groupId}`)).body.status, "canceled");
  }, POOL);
});
