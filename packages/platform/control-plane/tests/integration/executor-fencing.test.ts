// Current-executor fencing at the HTTP boundary (docs/contracts/hosted.md,
// "Current executor fencing").
//
// These are the B0 regressions for bug 2 — "a runner bearer remains valid after
// retry, so an old executor and its replacement can both start and report the
// same case; the last writer wins" — plus the two exchange interleavings from
// bug 1 driven through the real routes.
//
// Nothing here sleeps to "probably" produce a race. Where an interleaving is
// needed, `interleave()` runs the competing operation at the exact instant the
// route under test crosses from its eligibility read into its write transaction.
import test from "node:test";
import assert from "node:assert/strict";
import { withApp, createTarget, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { claimAndExchange, claimer, registerRunner } from "./exec-helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";

const LABELS = ["macos"];

async function setUp(api: HostedDynamic, key: string) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const { ring } = await createTarget(api, project, { key: "todos", ringKey: "local", runnerLabels: LABELS });
  const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "todos", name: "Todos" })).body;
  assert.equal(
    (await api.postTar(`/suites/${suite.id}/import`, writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`)))).status,
    200,
  );
  return { project, suite, ring };
}

async function launch(api: HostedDynamic, { project, suite, ring }: HostedDynamic, ids = ["add-todo", "complete-todo"]) {
  const res = await api.post(`/projects/${project.key}/run-groups`, {
    suite_id: suite.id,
    ring_id: ring.id,
    selection: { ids },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.run_group.id;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

/**
 * The interleaving seam. Every write path under test reads its eligibility
 * outside its transaction and then commits inside one; `hook` runs exactly once,
 * in that gap, on the same database. Deterministic, repeatable, no sleeps.
 *
 * It replaces `app.ctx.db` for the length of one call — the request context is
 * spread from `app.ctx` per request (`src/server.ts`), so the swap is visible to
 * the very next request and to nothing that came before it.
 */
async function interleave(app: HostedDynamic, hook: () => Promise<void>, body: () => Promise<HostedDynamic>) {
  const real = app.ctx.db;
  let fired = false;
  app.ctx.db = new Proxy(real, {
    get(target: HostedDynamic, prop: string | symbol) {
      if (prop === "withTx") {
        return async (fn: HostedDynamic) => {
          if (!fired) {
            fired = true;
            await hook();
          }
          return await target.withTx(fn);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    const out = await body();
    assert.equal(fired, true, "the interleaving hook never ran — the seam missed its window");
    return out;
  } finally {
    app.ctx.db = real;
  }
}

/** Every executor-facing mutation and read, addressed by one bearer. */
function protocol(base: string, token: string, groupId: string) {
  const headers = bearer(token);
  const call = async (method: string, path: string, body?: HostedDynamic) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return {
    spec: () => call("GET", `/runner/groups/${groupId}`),
    sessions: () => call("POST", `/runner/sessions/claim`, { sessions: [] }),
    start: (runId: string) => call("POST", `/runner/groups/${groupId}/cases/${runId}/start`, {}),
    progress: (runId: string) => call("POST", `/runner/groups/${groupId}/cases/${runId}/progress`, { step: 3 }),
    open: (runId: string, manifest: HostedDynamic) =>
      call("POST", `/runner/groups/${groupId}/cases/${runId}/open`, { manifest }),
    trajectory: (dbId: string) => call("POST", `/runner/runs/${dbId}/live/trajectory`, { from_line: 0, lines: ["{}"] }),
    report: (runId: string, status = "pass") =>
      call("POST", `/runner/groups/${groupId}/cases/${runId}/report`, {
        status,
        manifest: { run_id: runId, case: { id: "add-todo" }, status, duration_ms: 1, totals: { steps: 1 } },
      }),
    complete: () => call("POST", `/runner/groups/${groupId}/complete`, { summary: {} }),
    snapshot: (id: string) => call("GET", `/runner/snapshots/${id}/tree`),
    bundle: async (dbId: string) => {
      const res = await fetch(`${base}/api/v1/runner/runs/${dbId}/bundle`, {
        method: "PUT",
        headers: { authorization: headers.authorization, "content-type": "application/vnd.playtest.run-bundle" },
        body: Buffer.from("bundle bytes"),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    entry: async (dbId: string, name: string) => {
      const res = await fetch(`${base}/api/v1/runner/runs/${dbId}/live/${name}`, {
        method: "PUT",
        headers: { authorization: headers.authorization, "content-type": "application/octet-stream" },
        body: Buffer.from("staged step artifact"),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
  };
}

function assertStale(what: string, res: HostedDynamic, reason: string) {
  assert.equal(res.status, 409, `${what}: expected the stale-owner conflict, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error.code, "executor_conflict", what);
  assert.equal(res.body.error.details.reason, reason, `${what}: ${JSON.stringify(res.body.error.details)}`);
}

test("fencing: executor A cannot read or mutate anything once B becomes current", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const fixture = await setUp(api, "fenceab");
    const groupId = await launch(api, fixture);
    const runner = await registerRunner(api, fixture.project, { labels: LABELS });
    const agent = claimer(base, runner.credential);
    const dispatchId = (await agent.poll("?wait=5")).body.offers[0].dispatch_id;
    assert.equal((await agent.claim(dispatchId)).status, 200);

    // A exchanges and starts the first case; it is the current executor.
    const a = (await agent.exchange({ dispatch_id: dispatchId, isolation: "process" })).body;
    const A = protocol(base, a.token, groupId);
    const spec = (await A.spec()).body;
    const first = spec.cases[0];
    const second = spec.cases[1];
    assert.equal((await A.start(first.run_id)).status, 200);
    assert.equal((await A.progress(first.run_id)).status, 200);

    // Then the same claim is exchanged again — a crash-resumed runner, or a
    // replacement process. B is current from this instant.
    const b = (await agent.exchange({ dispatch_id: dispatchId, isolation: "process" })).body;
    assert.notEqual(b.executor_id, a.executor_id);
    const B = protocol(base, b.token, groupId);

    // EVERY executor-facing route refuses A, with one code and one reason.
    assertStale("group spec", await A.spec(), "executor_replaced");
    assertStale("snapshot tree", await A.snapshot(spec.snapshot_id), "executor_replaced");
    assertStale("session claim", await A.sessions(), "executor_replaced");
    assertStale("case start", await A.start(second.run_id), "executor_replaced");
    assertStale("case progress", await A.progress(first.run_id), "executor_replaced");
    assertStale("live open", await A.open(first.run_id, { run_id: first.run_id }), "executor_replaced");
    assertStale("live trajectory", await A.trajectory(first.db_id), "executor_replaced");
    assertStale("bundle upload", await A.bundle(first.db_id), "executor_replaced");
    assertStale("case report", await A.report(first.run_id), "executor_replaced");
    assertStale("group complete", await A.complete(), "executor_replaced");

    // …and B's state is exactly what B left it as: A's stale report wrote
    // nothing, and no artifact row was created by its refused upload.
    const runs = (await api.get(`/run-groups/${groupId}`)).body.runs;
    const firstRow = runs.find((r: HostedDynamic) => r.run_id === first.run_id);
    assert.equal(firstRow.status, "running", "the stale report did not finish the story");
    assert.equal(firstRow.artifact, null, "the stale upload sealed nothing");
    assert.equal((await api.get(`/run-groups/${groupId}`)).body.status, "running");

    // B is offered only what is still QUEUED — the story A had in flight is not
    // silently handed over, because a run that is `running` under a stale owner
    // is dead work for the reconciler or the group's completion to resolve, not
    // work a second process picks up mid-flight.
    const bSpec = (await B.spec()).body;
    assert.deepEqual(
      bSpec.cases.map((c: HostedDynamic) => c.run_id),
      [second.run_id],
      "the resumed executor is offered the queued remainder only",
    );
    const takeover = await B.start(first.run_id);
    assertStale("takeover of an in-flight story", takeover, "run_not_owned");

    // …and B owns and finishes what it was offered.
    assert.equal((await B.start(second.run_id)).status, 200);
    assert.equal((await B.report(second.run_id)).status, 200);
    const owned = (await app.db.query(`SELECT executor_id, status FROM runs WHERE run_id = $1`, [second.run_id])).rows[0];
    assert.equal(owned.executor_id, b.executor_id, "the run records exactly one owner");
    assert.equal(owned.status, "pass");
  });
});

test("fencing: a queued case has one owner, and a second executor cannot advance or finish it", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const fixture = await setUp(api, "fenceown");
    const groupId = await launch(api, fixture);
    const runner = await registerRunner(api, fixture.project, { labels: LABELS });
    const agent = claimer(base, runner.credential);
    const dispatchId = (await agent.poll("?wait=5")).body.offers[0].dispatch_id;
    assert.equal((await agent.claim(dispatchId)).status, 200);
    const a = (await agent.exchange({ dispatch_id: dispatchId, isolation: "process" })).body;
    const A = protocol(base, a.token, groupId);
    const first = (await A.spec()).body.cases[0];

    // The claim is a compare-and-set, so the owner's own repeat is idempotent…
    assert.equal((await A.start(first.run_id)).status, 200);
    assert.equal((await A.start(first.run_id)).status, 200, "case start is retry-safe for its owner");
    const claimed = (await app.db.query(`SELECT executor_id, started_at FROM runs WHERE run_id = $1`, [first.run_id])).rows[0];
    assert.equal(claimed.executor_id, a.executor_id);

    // …and a terminal story is never flipped back to running by a late start.
    assert.equal((await A.report(first.run_id, "fail")).status, 200);
    assert.equal((await A.start(first.run_id)).status, 200, "a late start is accepted but changes nothing");
    const after = (await app.db.query(`SELECT status FROM runs WHERE run_id = $1`, [first.run_id])).rows[0];
    assert.equal(after.status, "fail", "a finished story stays finished");
  });
});

test("fencing: an exchange that loses to a cancel resurrects neither the dispatch nor the group", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const fixture = await setUp(api, "fencecancel");
    const groupId = await launch(api, fixture);
    const runner = await registerRunner(api, fixture.project, { labels: LABELS });
    const agent = claimer(base, runner.credential);
    const dispatchId = (await agent.poll("?wait=5")).body.offers[0].dispatch_id;
    assert.equal((await agent.claim(dispatchId)).status, 200);

    // THE INTERLEAVING: the exchange has read its dispatch and found it
    // eligible. The cancel lands before its write transaction opens.
    const exchanged = await interleave(
      app,
      async () => {
        assert.equal((await api.post(`/run-groups/${groupId}/cancel`, {})).status, 200);
      },
      () => agent.exchange({ dispatch_id: dispatchId, isolation: "process" }),
    );

    assert.equal(exchanged.status, 409, JSON.stringify(exchanged.body));
    assert.match(exchanged.body.error.message, /can no longer be exchanged for/);
    assert.equal((await api.get(`/run-groups/${groupId}`)).body.status, "canceled", "the cancel is not undone");
    const ledger = (await app.db.query(`SELECT status, executor_id FROM dispatches WHERE id = $1`, [dispatchId])).rows[0];
    assert.equal(ledger.status, "concluded");
    assert.equal(ledger.executor_id, null, "a lost exchange installs no current executor");
    const executors = (await app.db.query(`SELECT COUNT(*) AS n FROM executors`)).rows[0];
    assert.equal(Number(executors.n), 0, "and leaves no orphan executor row behind");
  });
});

test("fencing: an exchange that loses to a reconcile does not flip the dead attempt back to running", async () => {
  await withApp(
    async ({ api, base, app }: HostedDynamic) => {
      const { reconcileDispatches } = await import("../../src/dispatch/reconciler.ts");
      const fixture = await setUp(api, "fencedead");
      const groupId = await launch(api, fixture);
      const runner = await registerRunner(api, fixture.project, { labels: LABELS });
      const agent = claimer(base, runner.credential);
      const dispatchId = (await agent.poll("?wait=5")).body.offers[0].dispatch_id;
      assert.equal((await agent.claim(dispatchId)).status, 200);

      // THE INTERLEAVING: the reconciler declares the claim dead (its heartbeat
      // window is zero here) between the exchange's read and its write.
      const exchanged = await interleave(
        app,
        async () => {
          const results = await reconcileDispatches(app.ctx);
          assert.ok(
            results.some((r: HostedDynamic) => r.dispatch_id === dispatchId),
            `the reconciler saw the claim: ${JSON.stringify(results)}`,
          );
        },
        () => agent.exchange({ dispatch_id: dispatchId, isolation: "process" }),
      );

      assert.equal(exchanged.status, 409, JSON.stringify(exchanged.body));
      const ledger = (await app.db.query(`SELECT status FROM dispatches WHERE id = $1`, [dispatchId])).rows[0];
      assert.equal(ledger.status, "reconciled_dead", "the reconciler's decision stands");
      assert.equal((await api.get(`/run-groups/${groupId}`)).body.status, "running");
    },
    { PLAYTEST_POOL_HEARTBEAT_TIMEOUT_S: "0" },
  );
});

test("fencing: a mint bearer and a group bearer cannot cross into each other's routes", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const fixture = await setUp(api, "fencescope");
    const groupId = await launch(api, fixture);
    const { token } = await claimAndExchange(api, base, { project: fixture.project, groupId, labels: LABELS });

    // A group bearer on a mint route: the audience check refuses it before the
    // guard even resolves a row.
    const mint = await fetch(`${base}/api/v1/runner/mints/some-claim`, { headers: bearer(token) });
    assert.equal(mint.status, 403);

    // A forced refresh on a script provider posts a standalone mint dispatch;
    // its bearer must not reach any group route.
    const provider = (
      await api.post(`/projects/${fixture.project.key}/auth-providers`, {
        name: "portal",
        kind: "script",
        code: "console.log(JSON.stringify({cookies: [], origins: []}));",
        identities: { admin: { username: "root" } },
        ttl_minutes: 45,
      })
    ).body;
    const forced = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
    assert.equal(forced.status, 202, JSON.stringify(forced.body));
    const minter = await claimAndExchange(api, base, {
      project: fixture.project,
      mintClaimId: forced.body.mint.claim_id,
    });
    const crossed = await fetch(`${base}/api/v1/runner/groups/${groupId}`, { headers: bearer(minter.token) });
    assert.equal(crossed.status, 403, "a mint bearer never serves a group spec");
  });
});

// ---------------------------------------------------------------------------
// Guard-to-write interleavings: on every executor write route, the replacement
// lands in the exact gap between the route guard's reads and the write
// transaction (`reassertCurrentExecutor` is the fence under test). The write
// must be refused with `executor_replaced` and must leave no trace.
// ---------------------------------------------------------------------------

async function arrange(api: HostedDynamic, base: HostedDynamic, key: string) {
  const fixture = await setUp(api, key);
  const groupId = await launch(api, fixture);
  const runner = await registerRunner(api, fixture.project, { labels: LABELS });
  const agent = claimer(base, runner.credential);
  const dispatchId = (await agent.poll("?wait=5")).body.offers[0].dispatch_id;
  assert.equal((await agent.claim(dispatchId)).status, 200);
  const a = (await agent.exchange({ dispatch_id: dispatchId, isolation: "process" })).body;
  const A = protocol(base, a.token, groupId);
  const spec = (await A.spec()).body;
  return { fixture, groupId, agent, dispatchId, a, A, first: spec.cases[0] };
}

/** The interleaving hook: exchange the same dispatch again, installing B. */
function replacement(agent: HostedDynamic, dispatchId: string, a: HostedDynamic) {
  const holder: HostedDynamic = { b: null };
  holder.hook = async () => {
    const exchanged = await agent.exchange({ dispatch_id: dispatchId, isolation: "process" });
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
    assert.notEqual(exchanged.body.executor_id, a.executor_id, "the replacement exchange installed B");
    holder.b = exchanged.body;
  };
  return holder;
}

test("fencing race: a replacement between caseStart's guard and its write leaves the case unclaimed", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { agent, dispatchId, a, A, first } = await arrange(api, base, "racestart");
    const swap = replacement(agent, dispatchId, a);
    const res = await interleave(app, swap.hook, () => A.start(first.run_id));
    assertStale("raced case start", res, "executor_replaced");
    const row = (await app.db.query(`SELECT executor_id, status FROM runs WHERE run_id = $1`, [first.run_id])).rows[0];
    assert.equal(row.executor_id, null, "the stale claim stamped no owner");
    assert.equal(row.status, "queued", "the case is still B's to start");
  });
});

test("fencing race: a replacement between caseProgress's guard and its write drops the stale tick", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { agent, dispatchId, a, A, first } = await arrange(api, base, "raceprog");
    assert.equal((await A.start(first.run_id)).status, 200);
    const swap = replacement(agent, dispatchId, a);
    const res = await interleave(app, swap.hook, () => A.progress(first.run_id));
    assertStale("raced case progress", res, "executor_replaced");
    const row = (await app.db.query(`SELECT progress FROM runs WHERE run_id = $1`, [first.run_id])).rows[0];
    assert.equal(row.progress, null, "the stale tick stored nothing");
  });
});

test("fencing race: a replacement between caseReport's guard and its write leaves the story unfinished", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { agent, dispatchId, a, A, first } = await arrange(api, base, "racereport");
    assert.equal((await A.start(first.run_id)).status, 200);
    const swap = replacement(agent, dispatchId, a);
    const res = await interleave(app, swap.hook, () => A.report(first.run_id));
    assertStale("raced case report", res, "executor_replaced");
    const row = (await app.db.query(`SELECT status, manifest, finished_at FROM runs WHERE run_id = $1`, [first.run_id])).rows[0];
    assert.equal(row.status, "running", "the stale report finished nothing");
    assert.equal(row.manifest, null);
    assert.equal(row.finished_at, null);
  });
});

test("fencing race: a replacement between live open's guard and its write opens nothing", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { agent, dispatchId, a, A, first } = await arrange(api, base, "raceopen");
    assert.equal((await A.start(first.run_id)).status, 200);
    const swap = replacement(agent, dispatchId, a);
    const res = await interleave(app, swap.hook, () => A.open(first.run_id, { run_id: first.run_id }));
    assertStale("raced live open", res, "executor_replaced");
    const row = (await app.db.query(`SELECT live_opened_at FROM runs WHERE run_id = $1`, [first.run_id])).rows[0];
    assert.equal(row.live_opened_at, null, "the stale open landed nowhere");
  });
});

test("fencing race: a replacement between live trajectory's guard and its write appends nothing", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { agent, dispatchId, a, A, first } = await arrange(api, base, "racetraj");
    assert.equal((await A.start(first.run_id)).status, 200);
    assert.equal((await A.open(first.run_id, { run_id: first.run_id })).status, 200);
    const swap = replacement(agent, dispatchId, a);
    const res = await interleave(app, swap.hook, () => A.trajectory(first.db_id));
    assertStale("raced live trajectory", res, "executor_replaced");
    const count = (
      await app.db.query(`SELECT COALESCE(MAX(from_line + line_count), 0) AS n FROM live_trajectory WHERE run_id = $1`, [
        first.db_id,
      ])
    ).rows[0];
    assert.equal(Number(count.n), 0, "the stale batch appended nothing");
  });
});

test("fencing race: a replacement between a live entry's reservation guard and its write stages nothing", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { agent, dispatchId, a, A, first } = await arrange(api, base, "raceentry");
    assert.equal((await A.start(first.run_id)).status, 200);
    assert.equal((await A.open(first.run_id, { run_id: first.run_id })).status, 200);
    const swap = replacement(agent, dispatchId, a);
    const res = await interleave(app, swap.hook, () => A.entry(first.db_id, "steps/001.json"));
    assertStale("raced live entry", res, "executor_replaced");
    const rows = (await app.db.query(`SELECT * FROM live_artifacts WHERE run_id = $1`, [first.db_id])).rows;
    assert.equal(rows.length, 0, "the stale entry reserved nothing");
  });
});

test("fencing race: a replacement during the bundle upload publishes neither bytes nor an artifact row", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { groupId, agent, dispatchId, a, A, first } = await arrange(api, base, "racebundle");
    assert.equal((await A.start(first.run_id)).status, 200);
    const swap = replacement(agent, dispatchId, a);
    // The seam fires at the fenced publish transaction — after the object store
    // already holds A's bytes, which is the widest window this route has.
    const res = await interleave(app, swap.hook, () => A.bundle(first.db_id));
    assertStale("raced bundle upload", res, "executor_replaced");
    const artifacts = (await app.db.query(`SELECT * FROM artifacts WHERE run_id = $1`, [first.db_id])).rows;
    assert.equal(artifacts.length, 0, "the stale upload published no artifact row");
    const row = (await app.db.query(`SELECT status FROM runs WHERE run_id = $1`, [first.run_id])).rows[0];
    assert.equal(row.status, "running", "the stale upload repainted nothing");
    await assert.rejects(
      app.store.get(`runs/${groupId}/${first.db_id}.${a.executor_id}.ptrun`),
      "the refused upload's staged bytes were deleted",
    );
  });
});

test("fencing race: a replacement between complete's guard and its write concludes nothing", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { groupId, agent, dispatchId, a, A } = await arrange(api, base, "racedone");
    const swap = replacement(agent, dispatchId, a);
    const res = await interleave(app, swap.hook, () => A.complete());
    assertStale("raced group complete", res, "executor_replaced");
    const dispatch = (await app.db.query(`SELECT status, executor_id FROM dispatches WHERE id = $1`, [dispatchId])).rows[0];
    assert.equal(dispatch.status, "running", "B's attempt was not concluded by the stale completion");
    assert.equal(dispatch.executor_id, swap.b.executor_id, "B is still the current executor");
    assert.equal((await api.get(`/run-groups/${groupId}`)).body.status, "running", "the group did not settle");
  });
});
