// The runner registry and the claim board, driven end to end by a SCRIPTED
// claimer. Every request below is the claimer dialling out, because the control
// plane never connects to a runner.
//
// Covered here: register → poll → a claim race two runners enter and one wins →
// exchange → the existing executor protocol → report → complete; a revoked
// credential refused at poll, claim and exchange; label subset matching; the
// bounded offer page and its `skip` list (starvation past the page cap, an
// all-incompatible page holding the long-poll, and skip expiry); a `mint` claim
// on the same board; the unclaimed timeout failing a group with an actionable
// message; a heartbeat-stale claim reconciling to infra failure with bounded
// re-dispatch; and cancellation observed at the heartbeat.
//
// Standalone mint recovery lives here too, because it is a claim-board story:
// a runner that crashes between exchange and completion RESUMES its own
// dispatch (the previous bearer becoming stale by identity), a claim nobody can
// ever fulfill is terminated through the one cleanup path, and a live claim
// whose attempt ended is re-posted rather than left pending with nothing to
// execute it.
import test from "node:test";
import assert from "node:assert/strict";
import { withApp, createTarget, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { claimer } from "./exec-helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";
import { reconcileDispatches } from "../../src/dispatch/reconciler.ts";
import { killDispatch } from "../../src/dispatch/state.ts";

/** A project with the todos suite committed and one labelled ring. */
async function setUp(api: HostedDynamic, { key, labels = ["macos"] }: HostedDynamic) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const { application, ring } = await createTarget(api, project, {
    key: "todos",
    ringKey: "laptop",
    baseUrl: "http://127.0.0.1:9",
    runnerLabels: labels,
  });
  const suite = (await api.post(`/projects/${key}/suites`, { slug: "todos", name: "Todos" })).body;
  const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`));
  assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);
  return { project, suite, application, ring };
}

const launch = (api: HostedDynamic, { project, suite, ring, ids = ["add-todo"] }: HostedDynamic) =>
  api.post(`/projects/${project.key}/run-groups`, {
    suite_id: suite.id,
    ring_id: ring.id,
    selection: { ids },
  });

async function register(api: HostedDynamic, project: HostedDynamic, body: HostedDynamic) {
  const res = await api.post(`/projects/${project.key}/runners`, body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test("pool: register, poll, race one winner, exchange, execute, report, complete", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project, suite, ring } = await setUp(api, { key: "pool1", labels: ["macos"] });
    const runner = await register(api, project, { name: "adas-laptop", labels: ["macos", "ios-sim"] });
    assert.ok(runner.credential.startsWith("ptr_"), "the credential is minted once at registration");
    const second = await register(api, project, { name: "spare-mini", labels: ["macos"] });
    // The plaintext is never readable again.
    const listed = await api.get(`/projects/${project.key}/runners`);
    assert.equal(listed.status, 200);
    // Under dev auth the deployment also has the site-scoped `local` peer
    // runner, which every project's list carries read-only; this project's OWN
    // fleet is the two just registered.
    const own = listed.body.items.filter((r: HostedDynamic) => r.scope === "project");
    assert.equal(own.length, 2);
    assert.equal("credential" in own[0], false);
    assert.deepEqual(own.map((r: HostedDynamic) => r.name).sort(), ["adas-laptop", "spare-mini"]);
    // A duplicate name is a friendly conflict, never a raw constraint error.
    const dup = await api.post(`/projects/${project.key}/runners`, { name: "adas-laptop" });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error.message, /already registered/);

    const one = claimer(base, runner.credential);
    const two = claimer(base, second.credential);

    // Nothing on the board yet: a held read returns an empty offer, promptly.
    const idle = await one.poll("?wait=1");
    assert.equal(idle.status, 200);
    assert.deepEqual(idle.body.offers, []);

    const launched = await launch(api, { project, suite, ring });
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    const groupId = launched.body.run_group.id;
    // Placement started nothing: the requested dispatch row IS the board entry.
    const board = await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1`, [groupId]);
    assert.equal(board.rows[0].status, "requested");
    assert.deepEqual(board.rows[0].labels, ["macos"]);
    assert.equal((await api.get(`/run-groups/${groupId}`)).body.status, "queued");

    const offered = await one.poll("?wait=true");
    assert.equal(offered.body.offers.length, 1);
    const [entry] = offered.body.offers;
    assert.equal(entry.kind, "group");
    assert.equal(entry.run_group_id, groupId);
    assert.deepEqual(entry.labels, ["macos"]);
    // Every offer names its project on the envelope and carries the attempt's
    // non-secret target block — the contractual shape (gate 9).
    assert.equal(entry.project_id, project.id);
    assert.equal(entry.project_key, project.key);
    assert.deepEqual(Object.keys(entry.target).sort(), [
      "application_id", "application_key", "base_url", "driver", "platform", "ring_id", "ring_key",
    ]);
    assert.equal(entry.target.application_key, "todos");
    assert.equal(entry.target.ring_key, "laptop");
    assert.equal(entry.target.driver, "web");
    assert.equal(entry.target.platform, null);
    assert.equal(entry.target.base_url, "http://127.0.0.1:9");
    const dispatchId = entry.dispatch_id;
    // Both runners are eligible and both see the same offer.
    assert.equal((await two.poll()).body.offers[0].dispatch_id, dispatchId);

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
    // provisioning on the feed.
    const claimed = await app.db.query(`SELECT * FROM dispatches WHERE id = $1`, [dispatchId]);
    assert.equal(claimed.rows[0].status, "scheduled");
    assert.ok(claimed.rows[0].claimed_at);
    const feed = await api.get(`/projects/${project.key}/events/feed?after=00000000000000000000000000&types=run.status`);
    assert.ok(
      feed.body.items.some((e: HostedDynamic) => e.payload.status === "provisioning" && e.entity.run_group_id === groupId),
      "the claim emits the provisioning event",
    );
    // The loser goes back to polling and finds nothing left to take.
    assert.deepEqual((await loser.poll()).body.offers, []);

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
    assert.deepEqual(spec.ring.runner_labels, ["macos"]);
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
  });
});

test("pool: a re-exchange fences the earlier bearer and serves only the new one", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project, suite, ring } = await setUp(api, { key: "pool6" });
    const runner = await register(api, project, { name: "adas-laptop", labels: ["macos"] });
    const one = claimer(base, runner.credential);
    const launched = await launch(api, { project, suite, ring });
    const groupId = launched.body.run_group.id;
    const dispatchId = (await one.poll()).body.offers[0].dispatch_id;
    assert.equal((await one.claim(dispatchId)).status, 200);

    // A crash-resumed runner exchanges again for the claim it already holds.
    // The exchange installs a NEW current executor, so the first bearer is stale
    // from that instant: two executors for one attempt would be two processes
    // reading the same inputs and reporting the same cases.
    const first = await one.exchange({ dispatch_id: dispatchId, isolation: "process" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await one.exchange({ dispatch_id: dispatchId, isolation: "process" });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.notEqual(second.body.executor_id, first.body.executor_id);

    const stale = await fetch(`${base}/api/v1/runner/groups/${groupId}`, {
      headers: { authorization: `Bearer ${first.body.token}` },
    });
    assert.equal(stale.status, 409, "the pre-exchange bearer is fenced");
    const staleBody = await stale.json();
    assert.equal(staleBody.error.code, "executor_conflict");
    assert.equal(staleBody.error.details.reason, "executor_replaced");

    const spec = await fetch(`${base}/api/v1/runner/groups/${groupId}`, {
      headers: { authorization: `Bearer ${second.body.token}` },
    });
    assert.equal(spec.status, 200, "the current bearer serves the group spec");
    assert.equal((await spec.json()).ring.key, ring.key, "the spec carries the attempt's ring snapshot");

    // Both executors exist as history; only one is the dispatch's current one,
    // and each one records the attempt it belongs to immutably.
    const rows = (await app.db.query(`SELECT id, dispatch_id FROM executors ORDER BY id`)).rows;
    assert.equal(rows.length, 2);
    for (const row of rows) assert.equal(row.dispatch_id, dispatchId);
    const ledger = (await app.db.query(`SELECT executor_id FROM dispatches WHERE id = $1`, [dispatchId])).rows[0];
    assert.equal(ledger.executor_id, second.body.executor_id);
  });
});

test("pool: a revoked credential is refused at poll, claim, and exchange", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const { project, suite, ring } = await setUp(api, { key: "pool2" });
    const runner = await register(api, project, { name: "adas-laptop", labels: ["macos"] });
    const live = await register(api, project, { name: "keeper", labels: ["macos"] });
    const revoked = claimer(base, runner.credential);
    const keeper = claimer(base, live.credential);

    const groupId = (await launch(api, { project, suite, ring })).body.run_group.id;
    const dispatchId = (await keeper.poll()).body.offers[0].dispatch_id;

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
  });
});

test("pool: revoking mid-group refuses new work and lets the group already exchanged finish", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project, suite, ring } = await setUp(api, { key: "pool2b" });
    const registered = await register(api, project, { name: "adas-laptop", labels: ["macos"] });
    const runner = claimer(base, registered.credential);

    const groupId = (await launch(api, { project, suite, ring })).body.run_group.id;
    const dispatchId = (await runner.poll()).body.offers[0].dispatch_id;
    assert.equal((await runner.claim(dispatchId)).status, 200);
    const exchanged = await runner.exchange({ dispatch_id: dispatchId, isolation: "process" });
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));

    // Someone revokes the machine while it is executing.
    assert.equal((await api.del(`/projects/${project.key}/runners/${registered.id}`)).status, 204);

    // No new work: the board and the exchange both close immediately.
    for (const [what, res] of [
      ["poll", await runner.poll()],
      ["exchange", await runner.exchange({ dispatch_id: dispatchId, isolation: "process" })],
    ] as HostedDynamic[]) {
      assert.equal(res.status, 403, `${what} refuses a revoked credential`);
      assert.match(res.body.error.message, /was revoked/, `${what} says why`);
    }

    // But the claim it already holds keeps its liveness channel. Without this
    // the agent reads the refusal as "this claim is not mine" and tears the run
    // down, and `heartbeat_at` goes stale until the reconciler kills the group.
    const beat = await runner.heartbeat(dispatchId);
    assert.equal(beat.status, 200, JSON.stringify(beat.body));
    assert.equal(beat.body.canceled, false);
    const beaten = await app.db.query(`SELECT heartbeat_at FROM dispatches WHERE id = $1`, [dispatchId]);
    assert.ok(beaten.rows[0].heartbeat_at, "the heartbeat is recorded, so the reconciler still sees a live executor");
    // A revoked runner still cannot heartbeat someone else's claim.
    const other = claimer(base, (await register(api, project, { name: "keeper", labels: ["macos"] })).credential);
    assert.equal((await other.heartbeat(dispatchId)).status, 403);

    // And the group finishes under the bearer it was already issued.
    const runnerHeaders = { authorization: `Bearer ${exchanged.body.token}`, "content-type": "application/json" };
    const spec = await fetch(`${base}/api/v1/runner/groups/${groupId}`, { headers: runnerHeaders }).then((r) => r.json());
    const run = spec.cases[0];
    assert.equal(
      (await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${run.run_id}/start`, { method: "POST", headers: runnerHeaders, body: "{}" })).status,
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
    assert.equal(final.body.status, "done", "the contract's promise: a group already exchanged finishes");
    assert.equal(final.body.runs[0].status, "pass");
  });
});

test("pool: a revoked runner's name is free again, and two live runners may not share one", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const { project } = await setUp(api, { key: "pool2c" });
    const first = await register(api, project, { name: "adas-laptop", labels: ["macos"] });

    // Two standing runners may not answer to the same name.
    const clash = await api.post(`/projects/${project.key}/runners`, { name: "adas-laptop" });
    assert.equal(clash.status, 409);
    assert.match(clash.body.error.message, /already registered and live/);
    assert.match(clash.body.error.message, /revoke that one first/);

    // Revoking is what frees it — which is exactly the console's own remedy for
    // a credential nobody wrote down.
    assert.equal((await api.del(`/projects/${project.key}/runners/${first.id}`)).status, 204);
    const again = await register(api, project, { name: "adas-laptop", labels: ["macos"] });
    assert.notEqual(again.id, first.id);
    assert.notEqual(again.credential, first.credential);
    // History keeps both, so a run placed on the old row still reads.
    const listed = await api.get(`/projects/${project.key}/runners`);
    const own = listed.body.items.filter((r: HostedDynamic) => r.scope === "project");
    assert.deepEqual(own.map((r: HostedDynamic) => r.name), ["adas-laptop", "adas-laptop"]);
    assert.equal(own.filter((r: HostedDynamic) => r.revoked_at).length, 1);
  });
});

test("pool: a label outside the safe charset is refused where it is written", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const { project } = await setUp(api, { key: "pool2d" });
    // A comma would silently become two labels on the agent's `--labels`, and a
    // quote or a space would break the start command the console hands over.
    for (const bad of ["build,test", "ios sim", "pool:checkout", "$(whoami)"]) {
      const res = await api.post(`/projects/${project.key}/runners`, { name: `r-${bad}`, labels: [bad] });
      assert.equal(res.status, 400, `"${bad}" is refused: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error.message, /may use only letters, digits/);
    }
    // The ring side is the same validator, so a target cannot ask for a label
    // no runner is allowed to advertise.
    const app = (await api.post(`/projects/${project.key}/applications`, { key: "labels", name: "Labels", driver: "web" })).body;
    const ring = await api.post(`/applications/${app.id}/rings`, {
      key: "bad-labels",
      base_url: "http://127.0.0.1:9",
      runner_labels: ["ios sim"],
    });
    assert.equal(ring.status, 400);
    assert.match(ring.body.error.message, /may use only letters, digits/);
    // Re-advertisement at check-in is the same validator, so a runner cannot
    // smuggle in a label the console would have refused to store.
    const good = await register(api, project, { name: "adas-laptop", labels: ["ios-sim", "macos.14", "ci_1"] });
    const runner = claimer(base, good.credential);
    assert.deepEqual((await runner.poll()).body.runner.labels, ["ios-sim", "macos.14", "ci_1"]);
    const smuggled = await runner.poll("?labels=ios%20sim");
    assert.equal(smuggled.status, 400, JSON.stringify(smuggled.body));
    assert.match(smuggled.body.error.message, /may use only letters, digits/);
  });
});

test("pool: label matching is subset semantics, oldest first, project-scoped", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const { project, suite, application, ring } = await setUp(api, { key: "pool3", labels: ["macos", "ios-sim"] });
    // A second ring on the same application with no labels at all: any runner
    // in the project.
    const anyRing = (
      await api.post(`/applications/${application.id}/rings`, {
        key: "anywhere",
        base_url: "http://127.0.0.1:9",
        runner_labels: [],
      })
    ).body;
    // Another project's runner must never see this project's board.
    const other = await setUp(api, { key: "pool3other", labels: [] });
    const outsider = claimer(base, (await register(api, other.project, { name: "outsider" })).credential);

    const partial = claimer(base, (await register(api, project, { name: "linux-box", labels: ["macos"] })).credential);
    const full = claimer(base, (await register(api, project, { name: "adas-laptop", labels: ["macos", "ios-sim", "spare"] })).credential);

    const labelled = (await launch(api, { project, suite, ring })).body.run_group.id;
    // The partial runner advertises a subset of what the job needs: no offer.
    assert.deepEqual((await partial.poll()).body.offers, []);
    assert.deepEqual((await outsider.poll()).body.offers, []);
    const offer = await full.poll();
    assert.equal(offer.body.offers[0].run_group_id, labelled);

    // An unlabelled job matches any runner in the project, and the board is
    // served oldest first — the labelled group was launched first.
    const unlabelled = (await launch(api, { project, suite, ring: anyRing })).body.run_group.id;
    assert.equal((await partial.poll()).body.offers[0].run_group_id, unlabelled);
    assert.equal((await full.poll()).body.offers[0].run_group_id, labelled, "oldest eligible entry first");

    // Labels are advertised at check-in and confer no authority: re-advertising
    // moves which jobs a runner matches, never which project it can reach.
    const readvertised = await partial.poll("?labels=macos,ios-sim");
    assert.equal(readvertised.body.offers[0].run_group_id, labelled);
    assert.deepEqual(readvertised.body.runner.labels, ["macos", "ios-sim"]);
    assert.deepEqual((await outsider.poll("?labels=macos,ios-sim")).body.offers, []);

    // One runner takes one group at a time: while it holds a claim the board
    // offers it nothing and hands back what it is already executing, which is
    // also how an agent restarted mid-group finds its work again.
    const labelledDispatch = readvertised.body.offers[0].dispatch_id;
    assert.equal((await full.claim(labelledDispatch)).status, 200);
    const busy = await full.poll();
    assert.deepEqual(busy.body.offers, []);
    assert.equal(busy.body.current.run_group_id, labelled);
    const greedy = await full.claim((await partial.poll()).body.offers[0].dispatch_id);
    assert.equal(greedy.status, 409);
    assert.match(greedy.body.error.message, /one group at a time/);
    // Re-claiming what it already holds is idempotent, not a lost race.
    assert.equal((await full.claim(labelledDispatch)).status, 200);
  });
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
    const entry = offer.body.offers[0];
    assert.equal(entry.kind, "mint", "session minting places through the same board");
    assert.equal(entry.mint_claim_id, minted.body.mint.claim_id);
    assert.equal(entry.run_group_id, null);
    // A project-wide provider mints with empty labels and a null target — and
    // its project is still named on the envelope.
    assert.deepEqual(entry.labels, []);
    assert.equal(entry.target, null);
    assert.equal(entry.project_key, project.key);

    const dispatchId = entry.dispatch_id;
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
  });
});

test("pool: a job nothing claims fails the group with the labels named, and is not re-posted", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const { project, suite, ring } = await setUp(api, { key: "pool5", labels: ["jeremys-mac"] });
    await register(api, project, { name: "linux-box", labels: ["linux"] });
    const groupId = (await launch(api, { project, suite, ring })).body.run_group.id;

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
  }, { PLAYTEST_POOL_CLAIM_TIMEOUT_S: "0" });
});

test("pool: a claim that stops heartbeating is a dead executor, with one bounded re-dispatch", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project, suite, ring } = await setUp(api, { key: "pool6", labels: ["macos"] });
    const runner = claimer(base, (await register(api, project, { name: "adas-laptop", labels: ["macos"] })).credential);
    const groupId = (await launch(api, { project, suite, ring })).body.run_group.id;
    const first = (await runner.poll()).body.offers[0].dispatch_id;
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
    assert.equal((await runner.poll()).body.offers[0].dispatch_id, dispatches.rows[1].id);

    // Bounded: a second death fails the group instead of looping forever.
    assert.equal((await runner.claim(dispatches.rows[1].id)).status, 200);
    const second = await reconcileDispatches(app.ctx);
    assert.equal(second.find((r: HostedDynamic) => r.dispatch_id === dispatches.rows[1].id).action, "dead");
    const group = await api.get(`/run-groups/${groupId}`);
    assert.equal(group.body.status, "done");
    assert.equal(group.body.runs[0].status, "infra");
  }, { PLAYTEST_POOL_HEARTBEAT_TIMEOUT_S: "0" });
});

test("pool: an executor that comes back after being reconciled dead leaves exactly one live attempt", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project, suite, ring } = await setUp(api, { key: "pool6b", labels: ["macos"] });
    const runner = claimer(base, (await register(api, project, { name: "adas-laptop", labels: ["macos"] })).credential);
    const groupId = (await launch(api, { project, suite, ring })).body.run_group.id;
    const first = (await runner.poll()).body.offers[0].dispatch_id;
    assert.equal((await runner.claim(first)).status, 200);
    const exchanged = await runner.exchange({ dispatch_id: first, isolation: "process" });
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));

    // The laptop slept: the heartbeat window lapses, the reconciler declares the
    // executor gone and re-posts the queued remainder.
    const results = await reconcileDispatches(app.ctx);
    assert.equal(results.find((r: HostedDynamic) => r.dispatch_id === first).action, "redispatched");

    // Then the lid opens and the executor everyone gave up on posts its own
    // partial completion. The reconciler already decided this attempt's outcome
    // and re-posted its remainder, so the late completion is refused outright —
    // it must not conclude a SECOND attempt into existence, and two `requested`
    // rows for one group are two runners running the same cases.
    const completed = await fetch(`${base}/api/v1/runner/groups/${groupId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${exchanged.body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ partial: true, summary: {} }),
    });
    assert.equal(completed.status, 409);
    const refusal = await completed.json();
    assert.equal(refusal.error.code, "executor_conflict");
    assert.equal(refusal.error.details.reason, "dispatch_not_active");
    assert.equal(refusal.error.details.state, "reconciled_dead");

    const rows = (await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1 ORDER BY attempt`, [groupId])).rows;
    assert.equal(rows.length, 2, `no third attempt: ${JSON.stringify(rows.map((r: HostedDynamic) => [r.attempt, r.status]))}`);
    // The reconciled row keeps what the reconciler wrote — a late `complete`
    // restates its own precondition, so it never re-flips a concluded ledger row.
    assert.equal(rows[0].status, "reconciled_dead");
    assert.match(rows[0].error, /adas-laptop/);
    const live = rows.filter((r: HostedDynamic) => ["requested", "scheduled", "running"].includes(r.status));
    assert.equal(live.length, 1, "exactly one live dispatch for the group");
    assert.equal(live[0].id, rows[1].id);

    // The group is still going, its case is still queued, and the board offers
    // that one attempt to the fleet — once.
    const group = await api.get(`/run-groups/${groupId}`);
    assert.equal(group.body.status, "running");
    assert.equal(group.body.runs[0].status, "queued");
    const board = await runner.poll();
    assert.equal(board.body.current, null);
    assert.deepEqual(board.body.offers.map((o: HostedDynamic) => o.dispatch_id), [rows[1].id]);
  }, { PLAYTEST_POOL_HEARTBEAT_TIMEOUT_S: "0" });
});

/** A project-wide `script` provider with one identity, plus a registered runner. */
async function mintFixture(api: HostedDynamic, base: HostedDynamic, key: string) {
  const { project } = await setUp(api, { key });
  const provider = (
    await api.post(`/projects/${project.key}/auth-providers`, {
      name: "portal",
      kind: "script",
      code: "console.log(JSON.stringify({cookies: [], origins: []}));",
      identities: { admin: { username: "root" } },
      ttl_minutes: 45,
    })
  ).body;
  const registered = await register(api, project, { name: "adas-laptop" });
  return { project, provider, runner: claimer(base, registered.credential) };
}

const mintCall = (base: string, token: string, path: string, body?: HostedDynamic) =>
  fetch(`${base}/api/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

test("pool: a runner that crashes mid-mint resumes it, fencing the bearer it held before", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project, provider, runner } = await mintFixture(api, base, "pool8");
    const minted = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
    assert.equal(minted.status, 202, JSON.stringify(minted.body));
    const claimId = minted.body.mint.claim_id;

    const entry = (await runner.poll("?wait=true")).body.offers[0];
    assert.equal(entry.kind, "mint");
    assert.equal((await runner.claim(entry.dispatch_id)).status, 200);
    const first = await runner.exchange({ dispatch_id: entry.dispatch_id, isolation: "process" });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    // The agent is killed between the exchange and the completion. It comes
    // back, and the board hands back the claim it still holds.
    const held = await runner.poll();
    assert.equal(held.body.current.dispatch_id, entry.dispatch_id, "the board hands back the claim it holds");

    // THE RESUME. A second exchange for the same dispatch by the same
    // authorized runner installs a new current executor and rebinds the pending
    // claim to it — the dispatch is not declared dead merely because a previous
    // executor existed.
    const second = await runner.exchange({ dispatch_id: entry.dispatch_id, isolation: "process" });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.notEqual(second.body.executor_id, first.body.executor_id, "a NEW current executor, not the old one");

    const row = (await app.db.query(`SELECT * FROM dispatches WHERE id = $1`, [entry.dispatch_id])).rows[0];
    assert.equal(row.status, "running", "an otherwise-live dispatch stays live");
    assert.equal(row.executor_id, second.body.executor_id, "the current-executor pointer advanced");
    const claimRow = (await app.db.query(`SELECT * FROM session_claims WHERE id = $1`, [claimId])).rows[0];
    assert.equal(claimRow.status, "pending");
    assert.equal(claimRow.executor_id, second.body.executor_id, "the pending claim was rebound");

    // The pre-crash bearer is stale by identity, with no revocation list: it can
    // neither read the grant nor complete anything.
    const staleGrant = await mintCall(base, first.body.token, `/runner/mints/${claimId}`);
    assert.equal(staleGrant.status, 409, JSON.stringify(staleGrant.body));
    assert.equal(staleGrant.body.error.code, "executor_conflict");
    assert.equal(staleGrant.body.error.details.reason, "executor_replaced");
    const staleComplete = await mintCall(base, first.body.token, `/runner/mints/${claimId}/complete`, {
      storage_state: { cookies: [{ name: "sid", value: "from-the-ghost" }], origins: [] },
    });
    assert.equal(staleComplete.status, 409, JSON.stringify(staleComplete.body));
    assert.equal(staleComplete.body.error.details.reason, "executor_replaced");

    // The resumed executor mints and completes, once.
    assert.equal((await mintCall(base, second.body.token, `/runner/mints/${claimId}`)).status, 200);
    const completed = await mintCall(base, second.body.token, `/runner/mints/${claimId}/complete`, {
      storage_state: { cookies: [{ name: "sid", value: "minted-after-the-crash" }], origins: [] },
    });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.session.storage_state.cookies[0].value, "minted-after-the-crash");

    // And a delivery whose RESPONSE was lost is retried on the same bearer: the
    // completion is idempotent for the current executor, answered from stored
    // state, and never a second accepted fulfillment.
    const retried = await mintCall(base, second.body.token, `/runner/mints/${claimId}/complete`, {
      storage_state: { cookies: [{ name: "sid", value: "a-second-mint-that-never-happened" }], origins: [] },
    });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.session.storage_state.cookies[0].value, "minted-after-the-crash", "redelivered, not re-fulfilled");
    assert.equal(retried.body.redelivered, true);

    const artifacts = await app.db.query(`SELECT * FROM session_artifacts WHERE provider_id = $1`, [provider.id]);
    assert.equal(artifacts.rows.length, 1, "one session for one identity, however many completions arrived");
    const finished = (await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1`, [claimId])).rows;
    assert.equal(finished.length, 1, "a resume is the same attempt, not a second one");
    assert.equal(finished[0].status, "concluded");
    assert.equal(finished[0].error, null, "a resumed mint concludes clean");

    // Nothing is left on the board for this runner.
    const after = await runner.poll();
    assert.equal(after.body.current, null);
    assert.deepEqual(after.body.offers, []);
    // The project's ledger says the mint succeeded, not that a runner died.
    const audits = (await api.get(`/projects/${project.key}/audit?limit=50`)).body.items.map((a: HostedDynamic) => a.action);
    assert.equal(audits.includes("dispatch.dead"), false, "no death was recorded for a mint that worked");
  });
});

test("pool: a mint exchange nobody can win is terminal, and cleans the claim up", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { provider, runner } = await mintFixture(api, base, "pool8b");
    const minted = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
    assert.equal(minted.status, 202, JSON.stringify(minted.body));
    const claimId = minted.body.mint.claim_id;

    const entry = (await runner.poll("?wait=true")).body.offers[0];
    assert.equal((await runner.claim(entry.dispatch_id)).status, 200);

    // The grant expired while this runner was starting up: nothing it does can
    // produce a session for this claim any more.
    await app.db.query(`UPDATE session_claims SET expires_at = $2 WHERE id = $1`, [claimId, new Date(Date.now() - 1000)]);

    const refused = await runner.exchange({ dispatch_id: entry.dispatch_id, isolation: "process" });
    assert.equal(refused.status, 401, JSON.stringify(refused.body));
    assert.match(refused.body.error.message, /no longer pending/);

    // The ONE terminal cleanup: the dispatch dies with its reason and the
    // abandoned grant is deleted, so the next forced refresh mints afresh
    // instead of inheriting a claim nothing can fulfill.
    const row = (await app.db.query(`SELECT * FROM dispatches WHERE id = $1`, [entry.dispatch_id])).rows[0];
    assert.equal(row.status, "reconciled_dead", "the refusal ended the ledger row in the same transaction");
    assert.match(row.error, /no longer pending/);
    assert.equal((await app.db.query(`SELECT * FROM session_claims WHERE id = $1`, [claimId])).rows.length, 0);

    // The termination, stated as the runner experiences it: nothing is handed
    // back, so the loop holds on the board instead of poll → 4xx → poll.
    const after = await runner.poll();
    assert.equal(after.body.current, null);
    assert.deepEqual(after.body.offers, []);
    const again = await runner.exchange({ dispatch_id: entry.dispatch_id, isolation: "process" });
    assert.equal(again.status, 403);
    assert.match(again.body.error.message, /does not hold an active claim/);

    // And a fresh forced refresh gets a new claim AND a new board entry.
    const refreshed = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
    assert.equal(refreshed.status, 202, JSON.stringify(refreshed.body));
    assert.notEqual(refreshed.body.mint.claim_id, claimId);
    assert.ok(refreshed.body.mint.dispatch_id, "a forced mint always has something to execute it");
    assert.equal((await runner.poll()).body.offers[0].dispatch_id, refreshed.body.mint.dispatch_id);
  });
});

test("pool: a live mint claim whose attempt ended is re-posted, never left pending with no dispatch", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { provider, runner } = await mintFixture(api, base, "pool8c");
    const minted = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
    const claimId = minted.body.mint.claim_id;
    const firstDispatch = minted.body.mint.dispatch_id;

    // The attempt ends without the claim being abandoned — the shape a refused
    // exchange used to leave behind. The claim is still pending and still
    // fulfillable; there is simply nothing on the board to execute it.
    await killDispatch(app.db, firstDispatch, { error: "the runner went away" });
    assert.equal(
      (await app.db.query(`SELECT status FROM session_claims WHERE id = $1`, [claimId])).rows[0].status,
      "pending",
    );

    const again = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
    assert.equal(again.status, 202, JSON.stringify(again.body));
    assert.equal(again.body.mint.claim_id, claimId, "the live grant is reused, not duplicated");
    assert.notEqual(again.body.mint.dispatch_id, firstDispatch);
    assert.ok(again.body.mint.dispatch_id, "pending with a null dispatch is not an answer");

    const rows = (await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1 ORDER BY attempt`, [claimId])).rows;
    assert.deepEqual(rows.map((r: HostedDynamic) => r.attempt), [1, 2], "a new attempt, allocated with its row");
    assert.equal(rows[1].status, "requested");
    // And it is really on the board.
    assert.equal((await runner.poll("?wait=true")).body.offers[0].dispatch_id, again.body.mint.dispatch_id);
    assert.equal((await runner.claim(again.body.mint.dispatch_id)).status, 200);
    assert.equal((await runner.exchange({ dispatch_id: again.body.mint.dispatch_id, isolation: "process" })).status, 200);
  });
});

test("pool: cancellation reaches the runner at its next heartbeat", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project, suite, ring } = await setUp(api, { key: "pool7", labels: ["macos"] });
    const runner = claimer(base, (await register(api, project, { name: "adas-laptop", labels: ["macos"] })).credential);
    const groupId = (await launch(api, { project, suite, ring })).body.run_group.id;
    const dispatchId = (await runner.poll()).body.offers[0].dispatch_id;
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
  });
});

// ---------------------------------------------------------- the offer page

/**
 * Post `n` extra board entries directly, oldest first, so a page cap can be
 * exceeded without launching more suites than this fixture has. They are real
 * `requested` rows with real labels — the board reads nothing else.
 */
async function fillBoard(app: HostedDynamic, project: HostedDynamic, n: number, { labels = [] }: HostedDynamic = {}) {
  const ids: string[] = [];
  const base = Date.now() - 60_000;
  for (let i = 0; i < n; i++) {
    const id = `filler-${String(i).padStart(3, "0")}`;
    await app.db.query(
      `INSERT INTO dispatches (id, project_id, kind, ref_id, attempt, status, labels, requested_at)
         VALUES ($1, $2, 'mint', $3, 1, 'requested', $4, $5)`,
      [id, project.id, `claim-${i}`, labels, new Date(base + i)],
    );
    ids.push(id);
  }
  return ids;
}

test("pool: the poll answers a bounded page, oldest first", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project } = await setUp(api, { key: "page1", labels: [] });
    const filler = await fillBoard(app, project, 12);
    const runner = claimer(base, (await register(api, project, { name: "adas-laptop" })).credential);

    const page = (await runner.poll()).body.offers;
    // Small and fixed — the page exists to keep one unclaimable entry off the
    // head of the board, not to become pagination.
    assert.equal(page.length, 8, `a bounded page, not the whole board: ${page.length}`);
    assert.deepEqual(page.map((o: HostedDynamic) => o.dispatch_id), filler.slice(0, 8), "oldest first");
  });
});

test("pool: one unclaimable offer never starves a newer one, proven past the page cap", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project, suite, ring } = await setUp(api, { key: "page2", labels: ["macos"] });
    // More entries this runner will not take than one page can hold, all older
    // than the group it CAN take: without the skip list the newer work would
    // never appear on any page it is offered. (The launch goes first so the
    // fillers do not count against this project's active-dispatch ceiling.)
    const launched = await launch(api, { project, suite, ring });
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    const groupId = launched.body.run_group.id;
    const filler = await fillBoard(app, project, 12);
    const runner = claimer(base, (await register(api, project, { name: "adas-laptop", labels: ["macos"] })).credential);

    const first = (await runner.poll()).body.offers;
    assert.equal(first.length, 8);
    assert.equal(first.some((o: HostedDynamic) => o.run_group_id === groupId), false,
      "the newer compatible group is behind a full page of older entries");

    // The runner names what it cannot take; the board excludes them.
    let skip = first.map((o: HostedDynamic) => o.dispatch_id);
    const second = (await runner.poll(`?skip=${skip.join(",")}`)).body.offers;
    skip = [...skip, ...second.filter((o: HostedDynamic) => o.run_group_id !== groupId).map((o: HostedDynamic) => o.dispatch_id)];
    const reachable = second.some((o: HostedDynamic) => o.run_group_id === groupId)
      ? second
      : (await runner.poll(`?skip=${skip.join(",")}`)).body.offers;
    const wanted = reachable.find((o: HostedDynamic) => o.run_group_id === groupId);
    assert.ok(wanted, `the newer compatible offer is reachable past the page cap: ${JSON.stringify(reachable.map((o: HostedDynamic) => o.dispatch_id))}`);
    assert.equal((await runner.claim(wanted.dispatch_id)).status, 200);
    // And the skipped entries are untouched: another runner takes them.
    const other = claimer(base, (await register(api, project, { name: "spare-mini", labels: ["macos"] })).credential);
    assert.equal((await other.poll()).body.offers[0].dispatch_id, filler[0]);
  });
});

test("pool: an all-incompatible page HOLDS the long-poll instead of hot-looping", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project } = await setUp(api, { key: "page3", labels: [] });
    const filler = await fillBoard(app, project, 3);
    const runner = claimer(base, (await register(api, project, { name: "adas-laptop" })).credential);

    // Skipping everything on the board is not "nothing matched your labels" —
    // the query comes back empty, and the hold is what keeps the agent from
    // re-polling immediately in a tight loop against the database.
    const started = Date.now();
    const held = await runner.poll(`?wait=2&skip=${filler.join(",")}`);
    assert.equal(held.status, 200);
    assert.deepEqual(held.body.offers, []);
    assert.ok(Date.now() - started >= 1_800, `the poll was held, not answered at once (${Date.now() - started}ms)`);

    // The same poll without the skips answers immediately.
    const immediate = Date.now();
    assert.equal((await runner.poll("?wait=2")).body.offers.length, 3);
    assert.ok(Date.now() - immediate < 1_000, "an offerable page never waits");
  });
});

test("pool: a still-pending offer is claimed after skip expiry, and the skip list is bounded", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project } = await setUp(api, { key: "page4", labels: [] });
    const [pending] = await fillBoard(app, project, 1);
    const runner = claimer(base, (await register(api, project, { name: "adas-laptop" })).credential);

    // The agent skipped it once — an external backend was down, say. Skips are
    // session-local and expire when a long-poll comes back empty, so the very
    // next poll without them is offered the same still-pending entry, and it is
    // claimable: nothing about the advertisement was ever mutated.
    assert.deepEqual((await runner.poll(`?skip=${pending}`)).body.offers, []);
    assert.equal((await runner.poll()).body.offers[0].dispatch_id, pending);
    assert.equal((await runner.claim(pending)).status, 200);

    // The list is bounded: past the cap the agent is expected to back off, not
    // to keep naming more, and the server says so rather than doing the work.
    const tooMany = Array.from({ length: 65 }, (_, i) => `d-${i}`).join(",");
    const refused = await runner.poll(`?skip=${tooMany}`);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.message, /at most 64/);
  });
});
