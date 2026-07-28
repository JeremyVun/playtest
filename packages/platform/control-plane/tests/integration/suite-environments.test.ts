// Suite-owned test targets (migration 0006). An environment is a deployment
// ring; `suite_id` decides who owns it: null means project-wide (every suite can
// launch against it), set means one suite's own target — in that suite's picker
// only, and deleted with it. The rules worth pinning are the ones a caller can't
// discover by reading a row: names collide across scopes, ownership never moves,
// a target from another suite is unreachable at launch, and history outranks a
// delete. Everything here is the API's contract, not the column's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./helpers.ts";

const JOURNEY_CASE = [
  "description: Add a todo.",
  "story: |",
  '  Add "milk" to the list.',
  "success:",
  "  - assert: ok",
  "",
].join("\n");

/** A committed suite with one runnable journey — enough for a launch to plan. */
async function seedSuite(api: HostedDynamic, project: HostedDynamic, slug: HostedDynamic) {
  const suite = (await api.post(`/projects/${project}/suites`, { slug, name: slug.toUpperCase() })).body;
  const seed = await api.post(`/suites/${suite.id}/commit`, {
    changes: [
      { path: "playtest.yaml", content: `app:\n  base_url: http://${slug}.example\n` },
      { path: "stories/add-todo.yaml", content: JOURNEY_CASE },
    ],
    note: "seed",
  });
  assert.equal(seed.status, 200, JSON.stringify(seed.body));
  return suite;
}

// A stubbed GitHub so a launch can actually create a run group; the dispatch
// itself is somebody else's test.
const GITHUB_STUB = { enabled: true, dispatchWorkflow: async () => ({}), cancelRun: async () => {} };

test("environments: a new project is born with one URL-less `default` target, owned by the project", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });

    const { body } = await api.get("/projects/p/environments");
    assert.equal(body.items.length, 1, JSON.stringify(body.items));
    const [def] = body.items;
    assert.equal(def.name, "default");
    assert.equal(def.driver, "web");
    // It deliberately carries no base_url: a launch against it resolves to
    // whichever suite is running, so a first suite is runnable before anyone
    // visits Settings. A URL here would silently override every suite's own.
    assert.equal(def.config?.app?.base_url, undefined);
    assert.deepEqual(def.config, {});
    assert.equal(def.suite_id, null); // project-owned — every suite may launch it
    assert.equal(def.suite, null);
    assert.equal(def.discovery_allowed, false);
    assert.deepEqual(def.runner_labels, []);
  });
});

test("environments: driver is explicit, validated, and cannot hide an uploaded mobile build", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });

    const bad = await api.post("/projects/p/environments", { name: "bad", driver: "desktop" });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.match(bad.body.error.message, /web.*api.*mobile/);

    const polluted = await api.post("/projects/p/environments", {
      name: "polluted",
      driver: "web",
      config: { app: { base_url: "https://example.test", platform: "ios" } },
    });
    assert.equal(polluted.status, 400, JSON.stringify(polluted.body));
    assert.match(polluted.body.error.message, /mobile device configuration/);

    const mobile = (await api.post("/projects/p/environments", { name: "sim", driver: "mobile" })).body;
    assert.equal(mobile.driver, "mobile");
    await api.putRaw(`/environments/${mobile.id}/app-artifact?filename=fixture.apk`, Buffer.from("apk"));

    const hidden = await api.put(`/environments/${mobile.id}`, { driver: "web" });
    assert.equal(hidden.status, 400, JSON.stringify(hidden.body));
    assert.match(hidden.body.error.message, /remove it before changing/);

    await api.del(`/environments/${mobile.id}/app-artifact`);
    const repaired = await api.put(`/environments/${mobile.id}`, {
      driver: "web",
      config: { app: { base_url: "https://example.test" } },
    });
    assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
    assert.equal(repaired.body.driver, "web");
    assert.equal(repaired.body.app_artifact, null);

    const uploadToWeb = await api.putRaw(
      `/environments/${mobile.id}/app-artifact?filename=fixture.apk`,
      Buffer.from("apk"),
    );
    assert.equal(uploadToWeb.status, 400, JSON.stringify(uploadToWeb.body));
    assert.match(uploadToWeb.body.error.message, /web environment/);
  });
});

test("environments: a suite-owned target reports its owner, and the list puts project-owned targets first", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const suite = (await api.post("/projects/p/suites", { slug: "checkout", name: "Checkout" })).body;

    const created = await api.post("/projects/p/environments", {
      name: "sandbox",
      suite_id: suite.id,
      config: { app: { base_url: "https://sandbox.example.com" } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.suite_id, suite.id);
    // The create response names the owner in full, not just by id: the console
    // puts this straight into its list, and a row that labels itself with a raw
    // ULID until the next refetch is its own small bug.
    assert.deepEqual(created.body.suite, { id: suite.id, slug: "checkout", name: "Checkout" });

    await api.post("/projects/p/environments", { name: "staging" });

    // Project-owned rings first, each group by name: the shared rings are what a
    // reader scans for, and a suite's private target is a footnote to them.
    const items = (await api.get("/projects/p/environments")).body.items;
    assert.deepEqual(items.map((e: HostedDynamic) => e.name), ["default", "staging", "sandbox"]);
    assert.deepEqual(items.map((e: HostedDynamic) => e.suite_id), [null, null, suite.id]);
    assert.deepEqual(items[2].suite, { id: suite.id, slug: "checkout", name: "Checkout" });
  });
});

test("environments: a name is unique across scopes, and the conflict names the suite holding it", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const suite = (await api.post("/projects/p/suites", { slug: "checkout", name: "Checkout" })).body;
    assert.equal((await api.post("/projects/p/environments", { name: "sandbox", suite_id: suite.id })).status, 201);

    // The name is the `app.envs.<name>` overlay key, so one name means one target
    // per project whoever owns it. The holder is invisible from the project's own
    // target list, so the message has to say where the name went.
    const clash = await api.post("/projects/p/environments", { name: "sandbox" });
    assert.equal(clash.status, 409, JSON.stringify(clash.body));
    assert.equal(clash.body.error.code, "conflict");
    assert.match(clash.body.error.message, /Checkout/);
    assert.match(clash.body.error.message, /sandbox/);

    // And the same rule the other way: a suite can't claim a project ring's name.
    const other = (await api.post("/projects/p/suites", { slug: "billing", name: "Billing" })).body;
    const reverse = await api.post("/projects/p/environments", { name: "sandbox", suite_id: other.id });
    assert.equal(reverse.status, 409, JSON.stringify(reverse.body));
    assert.match(reverse.body.error.message, /Checkout/);

    // A near-clash is still allowed: uniqueness is per name, not per suite.
    assert.equal((await api.post("/projects/p/environments", { name: "sandbox-2", suite_id: other.id })).status, 201);
  });
});

test("environments: a suite-owned target launches from its own suite only — another suite's launch and preview are both 400s", async () => {
  await withApp(
    async ({ api, app }: HostedDynamic) => {
      await api.post("/projects", { key: "p", name: "P" });
      const suiteA = await seedSuite(api, "p", "alpha");
      const suiteB = await seedSuite(api, "p", "beta");
      const env = (await api.post("/projects/p/environments", {
        name: "alpha-sandbox",
        suite_id: suiteA.id,
        config: { app: { base_url: "https://alpha.example.com" } },
      })).body;

      // Suite B never lists this target, so reaching it means a stale id or a
      // hand-written call — worth naming rather than silently running B's stories
      // against A's host.
      const crossLaunch = await api.post("/projects/p/run-groups", {
        suite_id: suiteB.id,
        environment_id: env.id,
        selection: {},
      });
      assert.equal(crossLaunch.status, 400, JSON.stringify(crossLaunch.body));
      assert.equal(crossLaunch.body.error.code, "bad_request");
      assert.match(crossLaunch.body.error.message, /another suite/);
      assert.match(crossLaunch.body.error.message, /alpha-sandbox/);

      // The read-only preview shares the check, so the dialog refuses before the
      // user commits rather than after.
      const crossPreview = await api.post("/projects/p/run-groups/preview", {
        suite_id: suiteB.id,
        environment_id: env.id,
        selection: {},
      });
      assert.equal(crossPreview.status, 400, JSON.stringify(crossPreview.body));
      assert.match(crossPreview.body.error.message, /another suite/);

      const blocked = await app.db.query(`SELECT COUNT(*) AS n FROM run_groups`);
      assert.equal(blocked.rows[0].n, 0, "a refused launch must create no run_groups row");

      // Its own suite is unaffected — the rule is scoping, not a lock.
      const ownPreview = await api.post("/projects/p/run-groups/preview", {
        suite_id: suiteA.id,
        environment_id: env.id,
        selection: {},
      });
      assert.equal(ownPreview.status, 200, JSON.stringify(ownPreview.body));
      assert.equal(ownPreview.body.total_runs, 1);

      const ownLaunch = await api.post("/projects/p/run-groups", {
        suite_id: suiteA.id,
        environment_id: env.id,
        selection: {},
      });
      assert.equal(ownLaunch.status, 200, JSON.stringify(ownLaunch.body));
      assert.equal(ownLaunch.body.runs.length, 1);

      // A project-owned ring stays launchable from every suite, which is the
      // behaviour suite ownership had to leave alone.
      const shared = (await api.post("/projects/p/environments", { name: "staging" })).body;
      for (const suite of [suiteA, suiteB]) {
        const res = await api.post("/projects/p/run-groups/preview", {
          suite_id: suite.id,
          environment_id: shared.id,
          selection: {},
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
      }
    },
    {},
    { github: GITHUB_STUB },
  );
});

test("environments: ownership is fixed — suite_id can be neither added to nor removed from an existing target", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const suite = (await api.post("/projects/p/suites", { slug: "checkout", name: "Checkout" })).body;
    const shared = (await api.post("/projects/p/environments", { name: "staging" })).body;
    const owned = (await api.post("/projects/p/environments", { name: "sandbox", suite_id: suite.id })).body;

    // Run history pins a target, and the launch-time visibility rule reads its
    // owner: moving one would retroactively change what a recorded run meant.
    const adopt = await api.put(`/environments/${shared.id}`, { suite_id: suite.id });
    assert.equal(adopt.status, 400, JSON.stringify(adopt.body));
    assert.match(adopt.body.error.message, /can't be moved/);

    const release = await api.put(`/environments/${owned.id}`, { suite_id: null });
    assert.equal(release.status, 400, JSON.stringify(release.body));
    assert.match(release.body.error.message, /can't be moved/);

    // Re-sending the unchanged owner is fine — the web form always posts the
    // whole row, so an idempotent PUT must not be an error.
    const echo = await api.put(`/environments/${owned.id}`, { suite_id: suite.id, discovery_allowed: true });
    assert.equal(echo.status, 200, JSON.stringify(echo.body));
    assert.equal(echo.body.discovery_allowed, true);
    assert.equal(echo.body.suite_id, suite.id);
    assert.equal(echo.body.suite.id, suite.id); // ownership survives an unrelated edit
  });
});

test("environments: a suite_id from another project is a 404, not a cross-project target", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    await api.post("/projects", { key: "q", name: "Q" });
    const foreign = (await api.post("/projects/q/suites", { slug: "other", name: "Other" })).body;

    // The suite id is a real row, so the only thing standing between a caller and
    // hanging a target off someone else's suite is this check.
    const res = await api.post("/projects/p/environments", { name: "sandbox", suite_id: foreign.id });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "not_found");

    assert.deepEqual((await api.get("/projects/p/environments")).body.items.map((e: HostedDynamic) => e.name), ["default"]);
  });
});

test("environments: a target with runs against it refuses deletion with a 409; an unused one deletes", async () => {
  await withApp(
    async ({ api }: HostedDynamic) => {
      await api.post("/projects", { key: "p", name: "P" });
      const suite = await seedSuite(api, "p", "alpha");
      const used = (await api.post("/projects/p/environments", { name: "staging", suite_id: suite.id })).body;
      const unused = (await api.post("/projects/p/environments", { name: "prod" })).body;

      const launch = await api.post("/projects/p/run-groups", {
        suite_id: suite.id,
        environment_id: used.id,
        selection: {},
      });
      assert.equal(launch.status, 200, JSON.stringify(launch.body));

      // run_groups.environment_id is ON DELETE RESTRICT: without this check the
      // FK surfaces as a 500. "Where did this run point?" is the whole reason the
      // row has to stay, so the refusal says so.
      const refused = await api.del(`/environments/${used.id}`);
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(refused.body.error.code, "conflict");
      assert.match(refused.body.error.message, /1 run/);
      assert.match(refused.body.error.message, /staging/);

      assert.equal((await api.del(`/environments/${unused.id}`)).status, 204);
      assert.deepEqual(
        (await api.get("/projects/p/environments")).body.items.map((e: HostedDynamic) => e.name),
        ["default", "staging"],
      );
    },
    {},
    { github: GITHUB_STUB },
  );
});

test("environments: deleting a suite takes its own targets with it and leaves project-owned ones standing", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const doomed = (await api.post("/projects/p/suites", { slug: "checkout", name: "Checkout" })).body;
    const kept = (await api.post("/projects/p/suites", { slug: "billing", name: "Billing" })).body;

    const doomedEnv = (await api.post("/projects/p/environments", { name: "checkout-sandbox", suite_id: doomed.id })).body;
    const keptEnv = (await api.post("/projects/p/environments", { name: "billing-sandbox", suite_id: kept.id })).body;
    const shared = (await api.post("/projects/p/environments", { name: "staging" })).body;

    assert.equal((await api.del(`/suites/${doomed.id}`)).status, 200);

    // The cascade is the whole promise of suite ownership: a private target must
    // not outlive its suite as an orphan row holding a name nobody can reuse.
    const orphan = await app.db.query(`SELECT COUNT(*) AS n FROM environments WHERE id = $1`, [doomedEnv.id]);
    assert.equal(orphan.rows[0].n, 0, "a suite-owned target must be deleted with its suite");

    const items = (await api.get("/projects/p/environments")).body.items;
    assert.deepEqual(items.map((e: HostedDynamic) => e.name), ["default", "staging", "billing-sandbox"]);
    assert.deepEqual(items.map((e: HostedDynamic) => e.id).sort(), [
      items.find((e: HostedDynamic) => e.name === "default").id, keptEnv.id, shared.id,
    ].sort());

    // The freed name is genuinely free again — proof the row went, not just that
    // the join stopped resolving it.
    assert.equal((await api.post("/projects/p/environments", { name: "checkout-sandbox" })).status, 201);
  });
});
