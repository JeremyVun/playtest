// Fill a lab control plane with content that exercises every hosted screen and
// every state a screen can be in: a rich project and an empty one, a suite with
// stories and a suite with none, passing / failing / changed / infra / explored
// runs, a pending baseline decision, findings in several states, an unassigned
// bug-candidate queue, and a run group still in flight.
//
// Everything that has a public API goes through /api/v1 as the dev admin. Two
// seams have no public path and are marked SEAM below:
//
//   1. Backdating rows so trends and "x days ago" read like a real week.
//   2. The explored (discovery) group and its grade artifact — producing those
//      for real needs a browser and a model.
//   3. Bug-candidate intake, which normally arrives from model synthesis.
//
// Run bundles are GENUINE committed trajectories from
// studies/viewer-self-test/fixtures — bundle bytes have pinned schemas, so only
// the small manifest.json is patched per run.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { REPO_ROOT } from "./plane.mjs";
import { newRunId, writeBundle } from "@playtest/core/artifacts";
import { writeTar } from "../../packages/platform/control-plane/src/suites/tar.ts";
import { ulid } from "../../packages/platform/control-plane/src/ulid.ts";
import { intakeFinding } from "../../packages/platform/control-plane/src/findings/intake.ts";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const say = (...a) => console.log("  ", ...a);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Suite source tree → { path: contents } (the shape the tar importer wants). */
function loadSuiteDir(dir) {
  const files = {};
  const walk = (d, rel = "") => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "results" || e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else files[r] = fs.readFileSync(path.join(d, e.name), "utf8");
    }
  };
  walk(dir);
  return files;
}

/** Committed run-case directories that can be packed into a bundle. */
function fixtureCaseDirs() {
  const root = path.join(REPO_ROOT, "studies/viewer-self-test/fixtures/runs");
  const dirs = [];
  for (const run of fs.readdirSync(root)) {
    const caseDir = path.join(root, run, "add-todo");
    if (fs.existsSync(path.join(caseDir, "manifest.json")) && fs.existsSync(path.join(caseDir, "trajectory.jsonl"))) {
      dirs.push(caseDir);
    }
  }
  if (!dirs.length) throw new Error("no packable fixture run dirs under studies/viewer-self-test/fixtures/runs");
  return dirs.sort();
}

/** A manifest derived from a fixture, reshaped for this seeded run. */
function makeManifest(fixtureDir, { runId, caseId, storyId, status, healed = false, changed = false, gateChecks = [], score = null, mode = null, persona = null }) {
  const base = JSON.parse(fs.readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"));
  base.run_id = runId;
  base.case = { ...base.case, id: caseId, story: storyId, persona: persona ?? base.case.persona };
  base.mode = mode || (healed ? "act" : base.mode);
  base.healed = healed;
  base.changed = changed;
  base.score = score;
  base.result = {
    ...base.result,
    status,
    end_reason: status === "fail" ? "gate_failed" : "done",
    error: status === "fail" ? (gateChecks[0]?.detail ?? "assertion failed") : null,
    gate: { pass: status !== "fail", checks: gateChecks },
  };
  return base;
}

async function buildBundle({ fixtureDir, manifest, baselineFrom = null, grade = null }) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "uxlab-bundle-"));
  const caseDir = path.join(tmp, "case");
  await fsp.cp(fixtureDir, caseDir, { recursive: true });
  await fsp.writeFile(path.join(caseDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (grade) await fsp.writeFile(path.join(caseDir, "grade.json"), JSON.stringify(grade, null, 2));
  if (baselineFrom) await fsp.copyFile(path.join(baselineFrom, "trajectory.jsonl"), path.join(caseDir, "baseline.jsonl"));
  const out = path.join(tmp, "run.ptrun");
  writeBundle(caseDir, out);
  const buf = await fsp.readFile(out);
  await fsp.rm(tmp, { recursive: true, force: true });
  return buf;
}

const failCheck = (spec, detail) => ({ pass: false, kind: "assert", spec, label: spec, detail, severity: "hard" });

// ---------------------------------------------------------------------------
// Launch + runner protocol (the public path)
// ---------------------------------------------------------------------------

/** Launch a group through the public API; the stub dispatch accepts it. */
async function launch(api, { projectKey, suiteId, envId, ids, note }) {
  const res = await api.post(`/projects/${projectKey}/run-groups`, {
    suite_id: suiteId,
    environment_id: envId,
    selection: { ids, mode: "auto" },
    note,
  });
  return res.run_group?.id || res.id;
}

/** Exchange a runner token and read the group spec (run_id ↔ db_id pairs). */
async function attachRunner(api, groupId) {
  const { token } = await api.post("/runner/exchange", { run_group_id: groupId, isolation: "process" });
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const spec = await fetch(`${api.base}/api/v1/runner/groups/${groupId}`, auth).then((r) => r.json());
  return { token, cases: spec.cases || [] };
}

async function runnerCall(api, token, method, p, { body, raw, contentType } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  let payload = raw;
  if (raw !== undefined) headers["content-type"] = contentType;
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${api.base}/api/v1${p}`, { method, headers, body: payload });
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : null;
  if (!res.ok) throw new Error(`runner ${method} ${p} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

/**
 * Report a whole group as a real executor would. `plan[caseId]` describes the
 * verdict; anything the plan omits reports as a plain pass.
 */
async function reportGroup(api, groupId, plan, fixtures) {
  const { token, cases } = await attachRunner(api, groupId);
  for (const c of cases) {
    const p = plan[c.case_id] || plan["*"] || { status: "pass", score: 90 };
    await runnerCall(api, token, "POST", `/runner/groups/${groupId}/cases/${c.run_id}/start`, { body: {} });
    if (p.status === "infra") {
      // An infra failure has no bundle: the run never produced a trajectory.
      await runnerCall(api, token, "POST", `/runner/groups/${groupId}/cases/${c.run_id}/report`, {
        body: { status: "infra", error: p.error || "runner could not reach the target application" },
      });
      continue;
    }
    const fixtureDir = p.healed ? fixtures[1] || fixtures[0] : fixtures[0];
    const manifest = makeManifest(fixtureDir, {
      runId: c.run_id,
      caseId: c.case_id,
      storyId: c.story_id || c.case_id,
      status: p.status,
      healed: !!p.healed,
      changed: !!p.changed,
      gateChecks: p.gate || [],
      score: p.score ?? null,
      mode: p.mode || null,
      persona: c.persona || null,
    });
    const bundle = await buildBundle({
      fixtureDir,
      manifest,
      baselineFrom: p.candidate ? fixtures[0] : null,
      grade: p.grade || null,
    });
    const { artifact } = await runnerCall(api, token, "PUT", `/runner/runs/${c.db_id}/bundle`, {
      raw: bundle,
      contentType: "application/vnd.playtest.run-bundle",
    });
    const meta = { accepted_at: new Date().toISOString(), run_id: c.run_id, pins: manifest.pins, verdicts: [] };
    await runnerCall(api, token, "POST", `/runner/groups/${groupId}/cases/${c.run_id}/report`, {
      body: {
        status: p.status,
        bundle: artifact,
        manifest,
        score: p.score,
        healed: p.healed || undefined,
        changed: p.changed || undefined,
        error: p.status === "fail" ? manifest.result.error : undefined,
        baseline_written: p.baseline ? meta : undefined,
        candidate_written: p.candidate ? meta : undefined,
      },
    });
  }
  await runnerCall(api, token, "POST", `/runner/groups/${groupId}/complete`, { body: { summary: {} } });
}

/**
 * An OPEN run: started, streaming, not sealed (docs/contracts/hosted.md, live
 * runs). It goes through the same three live routes the runner-agent's uploader
 * uses, in the same order — artifacts first, then the lines that name them, then
 * a progress snapshot — so the console and the embedded viewer see exactly what
 * a real streaming run gives them: a placeholder manifest, part of a trajectory,
 * and the step images those lines point at.
 *
 * The returned handle can `seal()` the run mid-capture, which is how the seal
 * transition gets photographed rather than described.
 */
async function openLiveRun(api, { projectKey, suiteId, envId, ids, note, fixtures, staged = 2, progress = null }) {
  const groupId = await launch(api, { projectKey, suiteId, envId, ids, note });
  const { token, cases } = await attachRunner(api, groupId);
  const c = cases[0];
  const fixtureDir = fixtures[0];
  await runnerCall(api, token, "POST", `/runner/groups/${groupId}/cases/${c.run_id}/start`, { body: {} });
  // The placeholder the engine writes before the first step: terminal-looking
  // status by design (it IS the crash evidence), no verdict, no duration. The
  // picker and the viewer both refuse to read liveness out of it.
  const base = makeManifest(fixtureDir, {
    runId: c.run_id, caseId: c.case_id, storyId: c.story_id || c.case_id, status: "interrupted",
  });
  const placeholder = {
    ...base,
    score: null,
    duration_ms: null,
    totals: null,
    result: { status: "interrupted", end_reason: null, error: null, gate: null },
  };
  await runnerCall(api, token, "POST", `/runner/groups/${groupId}/cases/${c.run_id}/open`, { body: { manifest: placeholder } });

  const all = fs.readFileSync(path.join(fixtureDir, "trajectory.jsonl"), "utf8").split("\n").filter(Boolean);
  const lines = all.slice(0, staged);
  for (const line of lines) {
    const arts = JSON.parse(line).artifacts || {};
    for (const entry of [arts.screenshot, arts.a11y, arts.mhtml].filter(Boolean)) {
      const buf = fs.readFileSync(path.join(fixtureDir, entry));
      await runnerCall(api, token, "PUT", `/runner/runs/${c.db_id}/live/${entry}`, {
        raw: buf,
        contentType: "application/octet-stream",
      });
    }
  }
  await runnerCall(api, token, "POST", `/runner/runs/${c.db_id}/live/trajectory`, { body: { from_line: 0, lines } });
  await runnerCall(api, token, "POST", `/runner/groups/${groupId}/cases/${c.run_id}/progress`, {
    body: {
      step: lines.length + 1,
      max_steps: 40,
      doing: "recording",
      action: progress ?? 'typed "walk the dog" into the new-todo field',
      cost_usd: 0.08,
      tokens: { ctx: 4800, in: 19000, out: 1600 },
      model: "claude-sonnet-5",
    },
  });

  const seal = async () => {
    const manifest = makeManifest(fixtureDir, {
      runId: c.run_id, caseId: c.case_id, storyId: c.story_id || c.case_id, status: "pass", score: 92,
    });
    const bundle = await buildBundle({ fixtureDir, manifest });
    const { artifact } = await runnerCall(api, token, "PUT", `/runner/runs/${c.db_id}/bundle`, {
      raw: bundle,
      contentType: "application/vnd.playtest.run-bundle",
    });
    await runnerCall(api, token, "POST", `/runner/groups/${groupId}/cases/${c.run_id}/report`, {
      body: { status: "pass", bundle: artifact, manifest, score: 92 },
    });
    await runnerCall(api, token, "POST", `/runner/groups/${groupId}/complete`, { body: { summary: {} } });
  };
  return { groupId, runDbId: c.db_id, caseId: c.case_id, seal };
}

/** SEAM: cosmetic time travel so trends and relative dates read like a real week. */
async function backdate(db, groupId, when) {
  const ts = new Date(when);
  await db.query(`UPDATE run_groups SET created_at = $2, updated_at = $2 WHERE id = $1`, [groupId, ts]);
  await db.query(
    `UPDATE runs SET created_at = $2, updated_at = $2, started_at = $2, finished_at = $2 WHERE run_group_id = $1`,
    [groupId, ts],
  );
  await db.query(`UPDATE run_events SET ts = $2 WHERE run_id IN (SELECT id FROM runs WHERE run_group_id = $1)`, [groupId, ts]);
  await db
    .query(`UPDATE candidates SET created_at = $2, updated_at = $2 WHERE run_id IN (SELECT id FROM runs WHERE run_group_id = $1)`, [groupId, ts])
    .catch(() => {});
  await db
    .query(
      `UPDATE findings SET first_seen = MIN(first_seen, $2), last_seen = MAX(last_seen, $2), created_at = MIN(created_at, $2)
         WHERE id IN (SELECT finding_id FROM finding_evidence WHERE run_id IN (SELECT id FROM runs WHERE run_group_id = $1))`,
      [groupId, ts],
    )
    .catch(() => {});
  await db
    .query(`UPDATE finding_evidence SET created_at = $2 WHERE run_id IN (SELECT id FROM runs WHERE run_group_id = $1)`, [groupId, ts])
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// The seed plan
// ---------------------------------------------------------------------------

const DISCOVERY_STORY = `description: Where do people look to export their list?
mode: discovery
persona: [curious-newcomer, power-user]
story: |
  You want to get your todo list out of the app so you can share it with
  someone. Do it however seems natural, and narrate what you look for.
report:
  - Where did they look first for an export or share affordance?
  - What did they expect to happen?
`;

const PERSONAS = {
  "personas/curious-newcomer.yaml": `name: curious-newcomer
description: |
  Someone who just heard about this app from a friend and is trying it for the
  first time. Curious and happy to explore, but reads every label before
  clicking and double-checks that each action actually did something.
`,
  "personas/power-user.yaml": `name: power-user
description: |
  A daily user who lives in keyboard shortcuts and expects bulk actions
  everywhere. Scans the obvious spots once each and judges the app by how fast
  a capability can be found, not whether it exists.
`,
};

// Project-wide personas (the Personas page), as distinct from the two committed
// into the suite tree above. One short, one long, so the list is captured
// holding both.
const PROJECT_PERSONAS = [
  {
    name: "Warehouse picker",
    description:
      "You are on your feet in a warehouse, working one-handed on a phone with gloves on, and the screen is washed out by the light overhead. "
      + "You scan a barcode first and read the screen second. You tap the biggest thing that looks like it moves you forward and you do not read "
      + "help text, tooltips, or anything under a heading you have already passed. If a form asks you to type more than a few characters you look "
      + "for a scanner or a picker instead. When something goes wrong you retry it once, exactly as before, then put the phone in your pocket and "
      + "go and ask a supervisor — you never open a menu you have not used before to hunt for a fix.",
  },
  {
    name: "Franchise owner",
    description:
      "You run three stores and you only ever look at the roll-up. You compare today against last week before you read anything else, and you "
      + "distrust any number you cannot break down per store.",
  },
];

export async function seed({ api, db, store }) {
  const fixtures = fixtureCaseDirs();
  const now = Date.now();
  const out = { projectKey: "todo-app", emptyProjectKey: "acme-checkout" };

  // --- 1. Projects ---------------------------------------------------------
  const project = await api.post("/projects", { key: out.projectKey, name: "Todo App" }, { expect: [200, 201] });
  out.projectId = project.id;
  await api.post("/projects", { key: out.emptyProjectKey, name: "Acme Checkout" }, { expect: [200, 201] });
  say("projects: todo-app (rich) + acme-checkout (empty, first-run state)");

  // --- 2. Suites -----------------------------------------------------------
  const suite = await api.post(`/projects/${out.projectKey}/suites`, { slug: "todos", name: "Todo journeys" }, { expect: [200, 201] });
  out.suiteId = suite.id;
  out.suiteSlug = suite.slug;
  const tar = writeTar(loadSuiteDir(path.join(REPO_ROOT, "tests/fixtures/todos")));
  await api.raw("POST", `/suites/${suite.id}/import`, undefined, { raw: tar, contentType: "application/x-tar", expect: [200, 201] });
  await api.post(
    `/suites/${suite.id}/commit`,
    {
      changes: [{ path: "stories/export-study.yaml", content: DISCOVERY_STORY }, ...Object.entries(PERSONAS).map(([p, content]) => ({ path: p, content }))],
      note: "add the export discovery study",
    },
    { expect: [200, 201] },
  );
  // A second suite with no stories: the empty-suite state.
  const empty = await api.post(`/projects/${out.projectKey}/suites`, { slug: "onboarding", name: "Onboarding" }, { expect: [200, 201] });
  out.emptySuiteSlug = empty.slug;
  say("suites: todos (4 stories, 2 personas) + onboarding (empty)");

  // --- 3. Test targets: environments, secret, auth provider, API token -----
  const staging = await api.post(
    `/projects/${out.projectKey}/environments`,
    {
      name: "staging",
      discovery_allowed: true,
      runner_labels: ["self-hosted", "playtest"],
      config: { app: { base_url: "http://127.0.0.1:4173" }, secret_env: { SEED_TOKEN: "staging-seed-token" } },
    },
    { expect: [200, 201] },
  );
  out.envId = staging.id;
  await api.post(
    `/projects/${out.projectKey}/environments`,
    {
      name: "production",
      discovery_allowed: false,
      // Labels are letters, digits, ".", "_" and "-" only (the pool's own rule,
      // tightened when self-hosted runners landed); "pool:prod" is refused now.
      runner_labels: ["self-hosted", "playtest", "pool-prod"],
      config: {
        app: { base_url: "https://todos.example.com" },
        auth: { default: "member", identities: { member: { $session: "sso/member" } } },
        secret_env: {},
      },
    },
    { expect: [200, 201] },
  );
  await api.post(
    `/projects/${out.projectKey}/secrets`,
    { name: "staging-seed-token", value: "seed-" + crypto.randomBytes(8).toString("hex") },
    { expect: [200, 201] },
  );
  await api.post(
    `/projects/${out.projectKey}/auth-providers`,
    {
      name: "sso",
      kind: "token_endpoint",
      config: { url: "https://sso.example.com/mint", method: "POST", body: { identity: "{{identity}}", username: "{{username}}" } },
      identities: { member: { username: "qa-member" }, admin: { username: "qa-admin" } },
      ttl_minutes: 45,
    },
    { expect: [200, 201] },
  );
  await api.post(`/projects/${out.projectKey}/tokens`, { role: "editor", name: "ci-pipeline" }, { expect: [200, 201] }).catch(() => {});

  // A target only the todos suite can launch against — the shape Suite settings
  // adds: no credentials, a URL that lives in the suite's own playtest.yaml, and
  // invisible from every other suite's launch dialog.
  await api.post(
    `/projects/${out.projectKey}/environments`,
    { name: "preview", suite_id: suite.id, discovery_allowed: true },
    { expect: [200, 201] },
  );
  await api.post(
    `/suites/${suite.id}/commit`,
    {
      changes: [{
        path: "playtest.yaml",
        content: [
          "# Test-owned todo suite. Its compose file builds the sibling todo-app fixture;",
          "# reset.sh makes repeated external-mode runs deterministic.",
          "app:",
          "  compose: ./docker-compose.yml",
          "  base_url: http://app:4173",
          "  init: ./reset.sh",
          "  envs:",
          "    staging:",
          "      base_url: http://127.0.0.1:4173",
          "    preview:",
          "      base_url: https://todos-pr-482.preview.example.com",
          "",
        ].join("\n"),
      }],
      note: "point the suite at staging and its preview deploy",
    },
    { expect: [200, 201] },
  );
  say("test targets: 3 environments (one suite-owned), 1 secret, 1 auth provider, 1 API token");

  // --- 3b. Project personas ------------------------------------------------
  // Two of them, of very different lengths: the page has to hold a one-liner
  // and a paragraph in the same list without either looking broken. The empty
  // project keeps the built-ins-only state in the capture set.
  for (const p of PROJECT_PERSONAS) {
    await api.post(`/projects/${out.projectKey}/personas`, p, { expect: [200, 201] }).catch(() => {});
  }
  say(`personas: ${PROJECT_PERSONAS.length} project personas (+3 built-ins)`);

  // --- 4. Run history ------------------------------------------------------
  const groups = [
    {
      note: "first recording",
      when: now - 6 * DAY,
      ids: ["add-todo", "complete-todo"],
      plan: {
        "add-todo": { status: "pass", score: 90, baseline: true },
        "complete-todo": { status: "pass", score: 88, baseline: true },
      },
    },
    {
      note: "nightly regression",
      when: now - 4 * DAY,
      ids: ["add-todo", "complete-todo"],
      plan: { "add-todo": { status: "pass", score: 91 }, "complete-todo": { status: "pass", score: 87 } },
    },
    {
      note: "nightly regression",
      when: now - 2 * DAY,
      ids: ["add-todo", "complete-todo", "clear-completed"],
      plan: {
        "add-todo": { status: "pass", score: 93 },
        "complete-todo": { status: "pass", score: 89 },
        "clear-completed": { status: "pass", score: 85, baseline: true },
      },
    },
    {
      note: "nightly regression",
      when: now - 1 * DAY,
      ids: ["add-todo", "complete-todo", "clear-completed"],
      plan: {
        "add-todo": { status: "pass", score: 92 },
        "complete-todo": {
          status: "fail",
          score: 40,
          gate: [
            failCheck(
              'the counter shows "1 item left"',
              'expected the counter to read "1 item left" but it showed "2 items left" after marking a todo done',
            ),
          ],
        },
        "clear-completed": { status: "infra", error: "target application refused the connection (ECONNREFUSED 127.0.0.1:4173)" },
      },
    },
    {
      note: "after the counter fix",
      when: now - 3 * HOUR,
      ids: ["add-todo", "complete-todo"],
      plan: {
        "add-todo": { status: "pass", score: 90, healed: true, changed: true, candidate: true },
        "complete-todo": { status: "pass", score: 88 },
      },
    },
  ];

  out.groups = [];
  for (const g of groups) {
    const groupId = await launch(api, { projectKey: out.projectKey, suiteId: suite.id, envId: staging.id, ids: g.ids, note: g.note });
    await reportGroup(api, groupId, g.plan, fixtures);
    await backdate(db, groupId, g.when);
    out.groups.push({ id: groupId, note: g.note });
    say(`run group "${g.note}" (${g.ids.length} stories) → ${groupId}`);
  }
  out.lastGroupId = out.groups.at(-1).id;

  // A finished one-story launch nobody named: the index titles it by its story
  // id and tags it with just the start stamp — no trigger word, no "1 story".
  // Kept out of out.groups so the surfaces that index into that list keep
  // pointing at the runs they were written about.
  {
    const soloId = await launch(api, { projectKey: out.projectKey, suiteId: suite.id, envId: staging.id, ids: ["add-todo"] });
    await reportGroup(api, soloId, { "add-todo": { status: "pass", score: 91 } }, fixtures);
    await backdate(db, soloId, now - 1 * HOUR);
    say(`un-noted solo run (1 story) → ${soloId}`);
  }

  // A group still in flight: launched, one case started, nothing reported. This
  // is the "watching a run" state — progress, cancel, live event feed.
  try {
    const liveId = await launch(api, {
      projectKey: out.projectKey,
      suiteId: suite.id,
      envId: staging.id,
      // No note, deliberately: this group exercises the default title a launch
      // gets when nobody wrote one ("one-off run").
      ids: ["add-todo", "complete-todo", "clear-completed"],
    });
    const { token, cases } = await attachRunner(api, liveId);
    await runnerCall(api, token, "POST", `/runner/groups/${liveId}/cases/${cases[0].run_id}/start`, { body: {} });
    // A live-progress snapshot, as the executor would post it: the runs index
    // renders this as the story's CLI-style live line (chip word, step N/M,
    // cost, "↳ last action").
    await runnerCall(api, token, "POST", `/runner/groups/${liveId}/cases/${cases[0].run_id}/progress`, {
      body: {
        step: 7, max_steps: 40, doing: "recording",
        action: 'clicked "Add" after typing "buy oat milk" into the new-todo field',
        cost_usd: 0.14, tokens: { ctx: 5200, in: 21000, out: 1800 }, model: "claude-sonnet-5",
      },
    });
    out.liveGroupId = liveId;
    say(`in-flight run group → ${liveId}`);
  } catch (e) {
    say("(in-flight group skipped:", e.message + ")");
  }

  // --- 5. A discovery study (explored runs) --------------------------------
  // Launched through the same public path; the personas' grades ride inside the
  // bundles, which is where synthesis reads them from.
  try {
    const groupId = await launch(api, {
      projectKey: out.projectKey,
      suiteId: suite.id,
      envId: staging.id,
      // Discovery cases are one per persona; the selection takes the expanded ids.
      ids: ["export-study@curious-newcomer", "export-study@power-user"],
      note: "export discovery study",
    });
    await reportGroup(
      api,
      groupId,
      {
        "*": {
          status: "explored",
          mode: "explore",
          score: 70,
          grade: {
            score: 70,
            completion: "partial",
            summary: "The persona hunted for an export affordance, tried the header and a long-press, and gave up.",
            report: [
              { question: "Where did they look first for an export or share affordance?", answer: "The top-right menu, then a long-press on the list.", evidence_steps: [1] },
              { question: "What did they expect to happen?", answer: "A download or a share sheet with the list as text.", evidence_steps: [2] },
            ],
            findings: [{ severity: "minor", note: "No visible export or share entry point; people expected one in the header.", step: 1 }],
          },
        },
      },
      fixtures,
    );
    await backdate(db, groupId, now - 3 * DAY);
    out.exploredGroupId = groupId;
    say(`discovery study group (explored) → ${groupId}`);
  } catch (e) {
    say("(discovery study skipped:", e.message + ")");
  }

  // More groups in flight AT THE SAME TIME. One live run is the easy case and
  // the one every live surface was designed against; a console with four of
  // them at once is the ordinary state of a busy afternoon, and it is the case
  // that decides whether the runs index is scannable or a scroll.
  const BUSY = [
    {
      note: "nightly regression",
      ids: ["add-todo", "complete-todo", "clear-completed"],
      started: [
        { step: 31, max_steps: 40, doing: "checking", action: 'clicked "Clear completed"', cost_usd: 0.09 },
        { step: 4, max_steps: 40, doing: "recording", action: 'typed "milk" into the new-todo field', cost_usd: 0.02 },
      ],
    },
    {
      note: "pre-deploy smoke",
      ids: ["add-todo", "complete-todo"],
      started: [{ step: 12, max_steps: 60, doing: "healing", action: "re-anchored the todo list to its heading", cost_usd: 0.05 }],
    },
    {
      note: "export discovery study",
      ids: ["export-study@curious-newcomer", "export-study@power-user"],
      started: [
        { step: 22, max_steps: 80, doing: "exploring", action: "opened the header menu looking for an export entry", cost_usd: 0.18 },
        { step: 9, max_steps: 80, doing: "exploring", action: "long-pressed the first todo", cost_usd: 0.07 },
      ],
    },
  ];
  for (const b of BUSY) {
    try {
      const id = await launch(api, {
        projectKey: out.projectKey, suiteId: suite.id, envId: staging.id, ids: b.ids, note: b.note,
      });
      const { token, cases } = await attachRunner(api, id);
      for (const [i, p] of b.started.entries()) {
        await runnerCall(api, token, "POST", `/runner/groups/${id}/cases/${cases[i].run_id}/start`, { body: {} });
        await runnerCall(api, token, "POST", `/runner/groups/${id}/cases/${cases[i].run_id}/progress`, {
          body: { ...p, tokens: { ctx: 4100, in: 18000, out: 1400 }, model: "claude-sonnet-5" },
        });
      }
      say(`concurrent in-flight group "${b.note}" (${b.started.length} moving) → ${id}`);
    } catch (e) {
      say(`(concurrent in-flight group "${b.note}" skipped:`, e.message + ")");
    }
  }

  // --- 5b. Open runs: evidence arriving while the case is still going ------
  // The groups above are in flight but blind — progress numbers with nothing
  // behind them. These ones STREAM (hosted.md, live runs): a placeholder
  // manifest, part of a trajectory, and the step images those lines name, so
  // the run page's embedded viewer has something real to play and the console
  // chrome has a live run to wear its badge for.
  //
  // One stays open for the streaming surface. The rest are the seal transition:
  // the capture opens a run page, seals that run underneath it, and photographs
  // where the verdict lands — one per theme, since sealing is a one-way door.
  try {
    const streaming = await openLiveRun(api, {
      projectKey: out.projectKey, suiteId: suite.id, envId: staging.id,
      ids: ["add-todo"], note: "watching a live run", fixtures,
    });
    out.liveRun = { group: streaming.groupId, id: streaming.runDbId };
    const sealable = [];
    for (const n of [1, 2]) {
      sealable.push(await openLiveRun(api, {
        projectKey: out.projectKey, suiteId: suite.id, envId: staging.id,
        ids: ["add-todo"], note: `live run about to finish (${n})`, fixtures,
        progress: 'clicked "Add" after typing "walk the dog"',
      }));
    }
    // `path` hands out the next unsealed run; `act` seals the one it was given.
    // Both are called once per theme, in the same order, so they stay in step.
    let cursor = 0;
    out.nextSealRun = () => sealable[Math.min(cursor++, sealable.length - 1)];
    out.sealCurrentRun = () => sealable[Math.min(cursor - 1, sealable.length - 1)].seal();
    say(`open (streaming) run → ${streaming.groupId}, plus ${sealable.length} sealable`);
  } catch (e) {
    say("(open live runs skipped:", e.message + ")");
  }

  // --- 6. Findings triage --------------------------------------------------
  // The failing run already created one finding deterministically. Accept it,
  // and promote a second one by hand so the list holds more than one state.
  try {
    const { items } = await api.get(`/projects/${out.projectKey}/findings?state=all`);
    if (items[0]) {
      await api.post(`/findings/${items[0].id}/accept`, {
        title: "Counter miscounts after completing a todo",
        severity: "major",
        note: "Reproduced on staging: the remaining-items counter does not decrement.",
      });
      out.findingId = items[0].id;
    }
    const failRun = (
      await db.query(
        `SELECT id FROM runs WHERE status = 'fail' AND run_group_id IN (SELECT id FROM run_groups WHERE project_id = $1) LIMIT 1`,
        [out.projectId],
      )
    ).rows[0];
    if (failRun) {
      await api
        .post(`/runs/${failRun.id}/promote-finding`, {
          title: "Clearing completed todos leaves a stale empty-state message",
          severity: "minor",
          note: "Spotted while reviewing the failing run.",
        })
        .catch((e) => say("(promote-finding:", e.message + ")"));
    }
    say("findings: 1 accepted (major) + 1 promoted by hand (minor)");
  } catch (e) {
    say("(findings triage skipped:", e.message + ")");
  }

  // --- 7. SEAM: unreviewed findings (state `new`) --------------------------
  // These normally arrive from discovery synthesis (a model call). Since the
  // candidate collapse a machine-filed claim IS a finding, needing review.
  try {
    const runRows = (
      await db.query(
        `SELECT id, case_id FROM runs WHERE run_group_id IN (SELECT id FROM run_groups WHERE project_id = $1) ORDER BY created_at DESC LIMIT 4`,
        [out.projectId],
      )
    ).rows;
    const claims = [
      {
        category: "data_mismatch",
        storyId: "add-todo",
        signalType: "gate_failure",
        locus: { route: "/todos", step_locus: "todo-input", status_class: null },
        claim: {
          title: "Adding a todo with only spaces creates a blank row",
          expected: "A whitespace-only entry is rejected, or trimmed away.",
          observed: "The entry is accepted and rendered as an unlabelled row that cannot be edited or removed.",
          severity: "major",
        },
      },
      {
        category: "no_effect",
        storyId: "export-study",
        signalType: "persona_report",
        locus: { route: "/todos", step_locus: "list-header", status_class: null },
        claim: {
          title: "No visible way to export the list",
          expected: "An export or share affordance somewhere on the list screen.",
          observed: "Both personas hunted the header and a long-press menu and found neither.",
          severity: "minor",
        },
      },
    ];
    for (const [i, spec] of claims.entries()) {
      const run = runRows[i % runRows.length];
      await db.withTx((tx) =>
        intakeFinding(tx, {
          projectId: out.projectId,
          source: "synthesis",
          actor: { system: "ux-lab-seed" },
          claim: {
            category: spec.category,
            storyId: spec.storyId,
            caseId: run.case_id,
            signalType: spec.signalType,
            locus: spec.locus,
            title: spec.claim.title,
            expected: spec.claim.expected,
            observed: spec.claim.observed,
            severity: spec.claim.severity,
          },
          evidence: [{ run_id: run.id, case_id: run.case_id, excerpt: spec.claim.observed }],
          intakeKey: `ux-lab-${i}`,
        }),
      );
    }
    say(`unreviewed findings: ${claims.length} needing review`);
  } catch (e) {
    say("(unreviewed findings skipped:", e.message + ")");
  }

  // --- 8. Index: one representative run per verdict, for the capture list ---
  const { items: runs } = await api.get(`/runs?project=${out.projectId}&limit=200`);
  const pick = (fn) => {
    const r = runs.find(fn);
    return r ? { id: r.id, group: r.run_group_id, case: r.case_id } : null;
  };
  out.passRun = pick((r) => r.status === "pass" && !r.changed);
  out.failRun = pick((r) => r.status === "fail");
  out.infraRun = pick((r) => r.status === "infra");
  out.changedRun = pick((r) => r.changed || r.healed);
  out.exploredRun = pick((r) => r.status === "explored");
  out.candidateId = (await api.get(`/projects/${out.projectKey}/findings?state=new&limit=5`).catch(() => ({ items: [] }))).items?.[0]?.id || null;
  const missing = ["passRun", "failRun", "infraRun", "changedRun", "exploredRun"].filter((k) => !out[k]);
  if (missing.length) say(`(warning: no run seeded for ${missing.join(", ")})`);

  return out;
}
