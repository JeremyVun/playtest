// Pins the launch preview (dispatcher.js previewRunGroup, api/runs.js
// previewGroup): preview fans out personas (a journey + a 2-persona discovery
// study = 3 planned runs), reports honest cost estimates (null with no history,
// real once seeded), and counts the runs that will explore rather than follow a
// story.
//
// It also pins what USED to be a gate. `rings.discovery_allowed` refused a
// selection holding discovery stories unless a developer had opened the ring
// for it; the flag is gone (migration 0002) and both story modes launch
// anywhere. The distinction never held: a journey run and an exploring run
// drive the same browser against the same deployment, so permitting one and
// refusing the other drew a line where there wasn't one. What replaced it is
// information — `discovery.runs` in the preview, and the console's production
// warning — not a refusal.
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

/** One web application with one environment, plus the fan-out suite bound to it. */
async function seedSuiteWithFanOut(
  api: HostedDynamic,
  { project: projectKey = "p", ringKey = "prod" } = {},
) {
  const project = (await api.post("/projects", { key: projectKey, name: projectKey.toUpperCase() })).body;
  const { application, ring } = await createTarget(api, project, { ringKey });
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

/** A second environment on the same application — every application may hold
 * its own `local`, `staging` and `prod`. */
async function addRing(api: HostedDynamic, application: HostedDynamic, over: HostedDynamic) {
  const res = await api.post(`/applications/${application.id}/rings`, {
    base_url: "http://127.0.0.1:4173",
    ...over,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test("launch preview: fans out a journey + a 2-persona discovery study; no history -> null estimate", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const { application, ring: ringOff, suite } = await seedSuiteWithFanOut(api);
    const ringOn = await addRing(api, application, { key: "staging", name: "staging" });

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
    assert.deepEqual(limits["add-todo"], { max_steps: 50, timeout_ms: 600_000 });
    assert.deepEqual(limits["export-study@tester"], { max_steps: 300, timeout_ms: 1_800_000 });
    assert.equal(previewOff.body.discovery.runs, 2);
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
    assert.equal(previewOn.body.discovery.runs, 2, "the same selection, counted the same way, on any environment");
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
    const { ring, suite } = await seedSuiteWithFanOut(api, { ringKey: "staging" });
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

test("story modes: discovery launches on any environment, planning mode 'explore'", async () => {
  await withApp(
    async ({ api }: HostedDynamic) => {
      // `prod` deliberately: this is the exact selection and the exact
      // environment the retired gate refused with a 400.
      const { ring, suite } = await seedSuiteWithFanOut(api, { ringKey: "prod" });

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

test("story modes: a mixed selection (journey + discovery) launches as one group", async () => {
  await withApp(
    async ({ api, app }: HostedDynamic) => {
      const { ring, suite } = await seedSuiteWithFanOut(api, { ringKey: "prod" });

      const launch = await api.post("/projects/p/run-groups", {
        suite_id: suite.id,
        ring_id: ring.id,
        selection: {}, // everything: the journey AND both discovery personas
      });
      assert.equal(launch.status, 200, JSON.stringify(launch.body));
      assert.equal(launch.body.runs.length, 3);
      assert.deepEqual(
        Object.fromEntries(launch.body.runs.map((r: HostedDynamic) => [r.case_id, r.mode])),
        { "add-todo": "record", "export-study@tester": "explore", "export-study@exploratory": "explore" },
      );
      // One group, one dispatch: the modes travel together rather than one of
      // them being filtered out on the way.
      const groups = await app.db.query(`SELECT COUNT(*) AS n FROM run_groups`);
      assert.equal(groups.rows[0].n, 1);
    },
    {},
  );
});

test("story modes: no request can re-create the retired permission", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "p", name: "P" })).body;
    const { application, ring } = await createTarget(api, project, {});
    // `discovery_allowed` is not a field any more. Sending it is ignored rather
    // than stored, and nothing reads it back — a stale client cannot resurrect
    // a gate by asking for one.
    const created = await api.post(`/applications/${application.id}/rings`, {
      key: "staging",
      base_url: "https://staging.example.com",
      discovery_allowed: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.discovery_allowed, undefined);
    const updated = await api.put(`/rings/${ring.id}`, { discovery_allowed: true });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.discovery_allowed, undefined);
  });
});
