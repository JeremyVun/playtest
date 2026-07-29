// Pins the launch preview and discovery_allowed gate
// (dispatcher.js previewRunGroup/requireDiscoveryAllowed, api/runs.js previewGroup):
// preview fans out personas (a journey + a 2-persona discovery study = 3 planned
// runs), reports honest cost estimates (null with no history, real once seeded),
// surfaces discovery.allowed per ring, and — the enforced half — launching
// discovery cases against a non-discovery_allowed ring is a 400 that
// creates NOTHING (no run_groups/runs/dispatches row), while a discovery_allowed
// ring lets the same selection through with mode "explore".
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp, createTarget } from "./helpers.ts";

const DISCOVERY_CASE = [
  "description: Where do users look for export?",
  "mode: discovery",
  "persona: [tester, exploratory]",
  "story: |",
  "  You want to export your list. Do it however seems natural.",
  "report:",
  "  - Where did they look first?",
  "",
].join("\n");

const JOURNEY_CASE = [
  "description: Add a todo.",
  "story: |",
  '  Add "milk" to the list.',
  "success:",
  "  - assert: ok",
  "",
].join("\n");

/** One web application with one ring, plus the fan-out suite bound to it. The
 * ring is what carries `discovery_allowed`, so every test here names the ring
 * shape it wants. */
async function seedSuiteWithFanOut(
  api: HostedDynamic,
  { project: projectKey = "p", ringKey = "prod", discoveryAllowed = false } = {},
) {
  const project = (await api.post("/projects", { key: projectKey, name: projectKey.toUpperCase() })).body;
  const { application, ring } = await createTarget(api, project, { ringKey, discoveryAllowed });
  const suite = (await api.post(`/projects/${projectKey}/suites`, { slug: "s", name: "S" })).body;
  const seed = await api.post(`/suites/${suite.id}/commit`, {
    changes: [
      { path: "playtest.yaml", content: "app:\n  base_url: http://x\n" },
      { path: "stories/add-todo.yaml", content: JOURNEY_CASE },
      { path: "export-study.yaml", content: DISCOVERY_CASE },
    ],
    note: "seed",
  });
  assert.equal(seed.status, 200, JSON.stringify(seed.body));
  return { project, application, ring, suite };
}

/** A second ring on the same application — every application may hold its own
 * `local`, `staging` and `prod`. */
async function addRing(api: HostedDynamic, application: HostedDynamic, over: HostedDynamic) {
  const res = await api.post(`/applications/${application.id}/rings`, {
    base_url: "http://127.0.0.1:4173",
    ...over,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test("launch preview: fans out a journey + a 2-persona discovery study; discovery.allowed reflects the ring; no history -> null estimate", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const { application, ring: ringOff, suite } = await seedSuiteWithFanOut(api);
    const ringOn = await addRing(api, application, { key: "staging", name: "staging", discovery_allowed: true });

    const previewOff = await api.post("/projects/p/run-groups/preview", {
      suite_id: suite.id,
      ring_id: ringOff.id,
      selection: {},
    });
    assert.equal(previewOff.status, 200, JSON.stringify(previewOff.body));
    assert.equal(previewOff.body.total_runs, 3);
    const idsOff = previewOff.body.cases.map((c: HostedDynamic) => c.id).sort();
    assert.deepEqual(idsOff, ["add-todo", "export-study@exploratory", "export-study@tester"]);
    const modes = Object.fromEntries(previewOff.body.cases.map((c: HostedDynamic) => [c.id, c.mode]));
    assert.equal(modes["add-todo"], "record");
    assert.equal(modes["export-study@tester"], "explore");
    assert.equal(modes["export-study@exploratory"], "explore");
    const limits = Object.fromEntries(previewOff.body.cases.map((c: HostedDynamic) => [c.id, c.limits]));
    assert.deepEqual(limits["add-todo"], { max_steps: 50, timeout_ms: 240_000 });
    assert.deepEqual(limits["export-study@tester"], { max_steps: 300, timeout_ms: 1_800_000 });
    assert.equal(previewOff.body.discovery.runs, 2);
    assert.equal(previewOff.body.discovery.allowed, false);
    assert.equal(previewOff.body.estimate.est_total_usd, null, "no run history yet -> an honest null, never a fabricated number");
    assert.equal(previewOff.body.estimate.known_runs, 0);
    for (const c of previewOff.body.cases) {
      assert.equal(c.est_cost_usd, null);
      assert.equal(c.est_duration_ms, null);
    }

    const previewOn = await api.post("/projects/p/run-groups/preview", {
      suite_id: suite.id,
      ring_id: ringOn.id,
      selection: {},
    });
    assert.equal(previewOn.status, 200, JSON.stringify(previewOn.body));
    assert.equal(previewOn.body.discovery.allowed, true);
    assert.equal(previewOn.body.total_runs, 3);

    const overridden = await api.post("/projects/p/run-groups/preview", {
      suite_id: suite.id,
      ring_id: ringOn.id,
      selection: { max_steps: 80, timeout_ms: 360_000 },
    });
    assert.equal(overridden.status, 200, JSON.stringify(overridden.body));
    assert.ok(overridden.body.cases.every((c: HostedDynamic) =>
      c.limits.max_steps === 80 && c.limits.timeout_ms === 360_000));
  });
});

test("launch limits reject non-positive and non-integer overrides", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const { ring, suite } = await seedSuiteWithFanOut(api, { ringKey: "staging", discoveryAllowed: true });
    for (const selection of [{ max_steps: 0 }, { max_steps: 1.5 }, { timeout_ms: -1 }]) {
      const res = await api.post("/projects/p/run-groups/preview", {
        suite_id: suite.id,
        ring_id: ring.id,
        selection,
      });
      assert.equal(res.status, 400, JSON.stringify({ selection, body: res.body }));
    }
  });
});

test("launch preview: a selection narrows the fan-out; cost estimate becomes non-null once history is seeded", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const { project, application, ring, suite } = await seedSuiteWithFanOut(api, { ringKey: "staging" });

    const narrowed = await api.post("/projects/p/run-groups/preview", {
      suite_id: suite.id,
      ring_id: ring.id,
      selection: { ids: ["add-todo"] },
    });
    assert.equal(narrowed.status, 200, JSON.stringify(narrowed.body));
    assert.equal(narrowed.body.total_runs, 1);
    assert.equal(narrowed.body.cases[0].id, "add-todo");
    assert.equal(narrowed.body.estimate.est_total_usd, null);

    // Seed a finished "record" run of add-todo with a known cost — the estimate
    // averages the suite's own finished runs per (story, mode).
    const snapshot = (
      await app.db.query(`SELECT id FROM suite_snapshots WHERE suite_id = $1 ORDER BY seq DESC LIMIT 1`, [suite.id])
    ).rows[0];
    const groupId = "g_hist";
    await app.db.query(
      `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, application_id, ring_id, trigger, selection, status)
         VALUES ($1,$2,$3,$4,$5,$6,'{}','{}','done')`,
      [groupId, project.id, suite.id, snapshot.id, application.id, ring.id],
    );
    await app.db.query(
      `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode, totals)
         VALUES ('run_hist',$1,'add-todo','add-todo','r_hist','pass','record',$2)`,
      [groupId, JSON.stringify({ cost_usd: 0.05 })],
    );

    const withHistory = await api.post("/projects/p/run-groups/preview", {
      suite_id: suite.id,
      ring_id: ring.id,
      selection: { ids: ["add-todo"] },
    });
    assert.equal(withHistory.status, 200, JSON.stringify(withHistory.body));
    assert.equal(withHistory.body.cases[0].est_cost_usd, 0.05);
    assert.equal(withHistory.body.estimate.est_total_usd, 0.05);
    assert.equal(withHistory.body.estimate.known_runs, 1);
  });
});

test("launch preview: a healed replay does not inflate the next clean replay estimate", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "p", name: "P" })).body;
    const { application, ring } = await createTarget(api, project, { ringKey: "staging" });
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    const seed = await api.post(`/suites/${suite.id}/commit`, {
      changes: [
        { path: "playtest.yaml", content: "app:\n  base_url: http://x\n" },
        { path: "stories/checked.yaml", content: JOURNEY_CASE },
        { path: "stories/to-record-a.yaml", content: JOURNEY_CASE },
        { path: "stories/to-record-b.yaml", content: JOURNEY_CASE },
      ],
      note: "seed",
    });
    assert.equal(seed.status, 200, JSON.stringify(seed.body));
    const snapshot = (
      await app.db.query(`SELECT id FROM suite_snapshots WHERE suite_id = $1 ORDER BY seq DESC LIMIT 1`, [suite.id])
    ).rows[0];

    await app.db.query(
      `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, application_id, ring_id, trigger, selection, status)
         VALUES ('g_hist',$1,$2,$3,$4,$5,'{}','{}','done')`,
      [project.id, suite.id, snapshot.id, application.id, ring.id],
    );
    const histories = [
      ["checked", "pass", "act", "heal", 0.4],
      ["to-record-a", "fail", "record", "record", 0.4],
      ["to-record-b", "fail", "record", "record", 0.4],
    ];
    for (const [storyId, status, plannedMode, actualMode, cost] of histories) {
      await app.db.query(
        `INSERT INTO runs
           (id, run_group_id, case_id, story_id, run_id, status, mode, manifest, totals)
         VALUES ($1,'g_hist',$2,$2,$3,$4,$5,$6,$7)`,
        [
          `row-${storyId}`,
          storyId,
          `artifact-${storyId}`,
          status,
          plannedMode,
          JSON.stringify({ mode: actualMode }),
          JSON.stringify({ cost_usd: cost }),
        ],
      );
    }
    await app.db.query(
      `INSERT INTO baselines
         (id, project_id, suite_id, story_id, version, trajectory_key, meta, accepted_from_run_id)
       VALUES ('baseline-checked',$1,$2,'checked',1,'runs/checked.ptrun#trajectory.jsonl','{}','row-checked')`,
      [project.id, suite.id],
    );

    const preview = await api.post("/projects/p/run-groups/preview", {
      suite_id: suite.id,
      ring_id: ring.id,
      selection: {},
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(
      Object.fromEntries(preview.body.cases.map((c: HostedDynamic) => [c.id, c.mode])),
      { checked: "act", "to-record-a": "record", "to-record-b": "record" },
    );
    assert.equal(preview.body.cases.find((c: HostedDynamic) => c.id === "checked").est_cost_usd, null);
    assert.equal(preview.body.estimate.est_total_usd, 0.8);
    assert.equal(preview.body.estimate.known_runs, 2);
  });
});

test("discovery gate: launching discovery cases against a non-discovery_allowed ring is a 400 naming it, and creates NOTHING", async () => {
  await withApp(
    async ({ api, app }: HostedDynamic) => {
      // discovery_allowed defaults false on the ring
      const { ring, suite } = await seedSuiteWithFanOut(api, { ringKey: "prod" });

      const launch = await api.post("/projects/p/run-groups", {
        suite_id: suite.id,
        ring_id: ring.id,
        selection: { ids: ["export-study@tester", "export-study@exploratory"] },
      });
      assert.equal(launch.status, 400, JSON.stringify(launch.body));
      // The refusal names the ring by its qualified application/ring key, which is
      // what a reader has to go and change.
      assert.match(launch.body.error.message, /app\/prod/);
      assert.match(launch.body.error.message, /discovery/i);

      const groups = await app.db.query(`SELECT COUNT(*) AS n FROM run_groups`);
      assert.equal(groups.rows[0].n, 0, "a blocked launch must create no run_groups row");
      const runs = await app.db.query(`SELECT COUNT(*) AS n FROM runs`);
      assert.equal(runs.rows[0].n, 0, "a blocked launch must create no runs rows");
      const dispatches = await app.db.query(`SELECT COUNT(*) AS n FROM dispatches`);
      assert.equal(dispatches.rows[0].n, 0, "a blocked launch must create no dispatches row");
    },
    {},
  );
});

test("discovery gate: a mixed selection (journey + discovery) is ALSO blocked when the ring disallows discovery", async () => {
  await withApp(
    async ({ api, app }: HostedDynamic) => {
      const { ring, suite } = await seedSuiteWithFanOut(api, { ringKey: "prod" });

      const launch = await api.post("/projects/p/run-groups", {
        suite_id: suite.id,
        ring_id: ring.id,
        selection: {}, // everything: the journey AND both discovery personas
      });
      assert.equal(launch.status, 400, JSON.stringify(launch.body));
      const groups = await app.db.query(`SELECT COUNT(*) AS n FROM run_groups`);
      assert.equal(groups.rows[0].n, 0);
    },
    {},
  );
});

test("discovery gate: a discovery_allowed ring lets the launch through, planning mode 'explore' for the discovery runs", async () => {
  await withApp(
    async ({ api }: HostedDynamic) => {
      const { ring, suite } = await seedSuiteWithFanOut(api, { ringKey: "staging", discoveryAllowed: true });

      const launch = await api.post("/projects/p/run-groups", {
        suite_id: suite.id,
        ring_id: ring.id,
        selection: { ids: ["export-study@tester", "export-study@exploratory"] },
      });
      assert.equal(launch.status, 200, JSON.stringify(launch.body));
      assert.equal(launch.body.runs.length, 2);
      assert.ok(launch.body.runs.every((r: HostedDynamic) => r.mode === "explore"), JSON.stringify(launch.body.runs));
      assert.deepEqual(
        launch.body.runs.map((r: HostedDynamic) => r.case_id).sort(),
        ["export-study@exploratory", "export-study@tester"],
      );
    },
    {},
  );
});
