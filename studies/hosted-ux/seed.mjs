#!/usr/bin/env node
// Re-runnable seed for a THROWAWAY hosted-Playtest project used by a UX discovery
// study of the control-plane web app. Populates every screen (Home tiles, Runs,
// Review queue + badge, Findings, Settings) with realistic content.
//
//   node studies/hosted-ux/seed.mjs           # reset + seed
//   PLAYTEST_HOSTED_BASE=http://127.0.0.1:4177 node studies/hosted-ux/seed.mjs
//
// Prereqs: the control-plane server running with PLAYTEST_AUTH=dev (a fixed dev
// admin — no cookies/keys needed, requests "just work"), reachable at
// PLAYTEST_HOSTED_BASE, and its data root (PLAYTEST_DATA_DIR, default
// <repo>/.playtest-data) readable from here — one SQLite file and the object
// store beside it.
//
// Design: everything is driven through the PUBLIC /api/v1 surface as the dev
// admin, including the runs. Placement is pull-based now — a launch posts to the
// claim board and a self-hosted runner claims it — so POST
// /projects/:p/run-groups needs nothing configured, and this seed simply plays
// the runner: register, poll the board, claim, exchange, then start ->
// uploadBundle -> report -> complete exactly as a laptop or a CI job would. The
// server computes candidate diffs, extracts findings, emits events and stores
// bundles through its own code; nothing about results is hand-forged.
//
// One detail keeps that honest next to `npm run hosted`, which supervises a peer
// runner of its own: every seeded launch PINS the placement label SEED_LABEL,
// which only this script's runner advertises. The peer runner therefore never
// races the seed for a fabricated group, while the rings themselves carry no
// labels — so a launch a study participant makes from the console still lands on
// the peer runner and really executes.
//
// Two things still have no public path, and they are the only direct-DB seam:
// backdating a group so the Home tiles and trends span days, and the explored
// discovery group (no discovery executor runs here). Both are isolated below.
//
// Bundles reuse GENUINE committed trajectories from
// studies/viewer-self-test/fixtures/ (run bundles have pinned schemas — never
// invent bytes), packed with core writeBundle.
//
// Zero new deps: fetch is a Node global; the SQLite handle is the control
// plane's own `connect()`; tar/bundle/ulid/newRunId are imported by path.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { newRunId, writeBundle } from "@playtest/core/artifacts";
import { writeTar } from "../../packages/platform/control-plane/src/suites/tar.ts";
import { ulid } from "../../packages/platform/control-plane/src/ulid.ts";
import { connect } from "../../packages/platform/control-plane/src/db.ts";

function REPO() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

const BASE = (process.env.PLAYTEST_HOSTED_BASE || "http://127.0.0.1:4177").replace(/\/$/, "");
// The data root is the single storage knob, and it is where the server this
// seed talks to keeps its one SQLite file and its object store.
const DATA_DIR = path.resolve(process.env.PLAYTEST_DATA_DIR || path.join(REPO(), ".playtest-data"));
const DB_FILE = path.resolve(process.env.PLAYTEST_DB_FILE || path.join(DATA_DIR, "playtest.sqlite"));
const PROJECT_KEY = "todos";
const PROJECT_NAME = "Todo App";
const APPLICATION_KEY = "todo-web";
// The label every seeded launch pins, and the only label this script's runner
// advertises: it is what keeps the peer runner beside `npm run hosted` out of
// history that is meant to be fabricated.
const SEED_LABEL = "study-seed";
const DAY = 24 * 60 * 60 * 1000;

const conn = await connect({ databaseFile: DB_FILE });
const db = (text, params) => conn.query(text, params);

// ---------------------------------------------------------------------------
// HTTP client (dev admin — no auth header needed; the server resolves the fixed
// dev principal when PLAYTEST_AUTH=dev and no cookie/bearer is present).
// ---------------------------------------------------------------------------
async function api(method, p, body, { raw, contentType, token, expect } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) {
    payload = raw;
    headers["content-type"] = contentType || "application/octet-stream";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${BASE}/api/v1${p}`, { method, headers, body: payload });
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  const okCodes = expect == null ? null : Array.isArray(expect) ? expect : [expect];
  if (okCodes && !okCodes.includes(res.status)) {
    throw new Error(`${method} ${p} -> ${res.status} (wanted ${okCodes.join("/")}): ${JSON.stringify(data)}`);
  }
  if (!okCodes && res.status >= 400) {
    throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// RESET — the public project delete, which unwinds run groups, applications,
// rings and suites in the order the schema's RESTRICTs require. Destructive
// within the throwaway study project and nowhere else.
// ---------------------------------------------------------------------------
async function reset() {
  for (const key of [PROJECT_KEY, "probe"]) {
    const res = await fetch(`${BASE}/api/v1/projects/${key}`, { method: "DELETE" });
    if (res.status === 404) continue;
    if (res.status >= 400) throw new Error(`DELETE /projects/${key} -> ${res.status}`);
    // The project's runners are its own and go with it (ON DELETE CASCADE), so
    // a re-seed never collides with the runner the last one registered.
    log(`reset: deleted project "${key}"`);
  }
}

// ---------------------------------------------------------------------------
// Suite tar from a directory tree (mirrors the exit-gate/import tests).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Bundle building — pack a GENUINE fixture run-case dir into a .ptrun, patching
// only the small manifest.json to match this seeded run. Optionally injects a
// baseline.jsonl (a different real trajectory) so the server computes a real
// candidate diff for healed runs.
// ---------------------------------------------------------------------------
function fixtureCaseDirs() {
  const root = path.join(REPO(), "studies/viewer-self-test/fixtures/runs");
  const dirs = [];
  for (const run of fs.readdirSync(root)) {
    const caseDir = path.join(root, run, "add-todo");
    if (fs.existsSync(path.join(caseDir, "manifest.json")) && fs.existsSync(path.join(caseDir, "trajectory.jsonl"))) {
      dirs.push(caseDir);
    }
  }
  if (dirs.length < 1) throw new Error("no packable add-todo fixture run dirs found");
  return dirs.sort();
}

const FIXTURES = fixtureCaseDirs();

async function buildBundle({ fixtureDir, manifest, baselineFrom = null, grade = null }) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-seed-bundle-"));
  const caseDir = path.join(tmp, "case");
  await fsp.cp(fixtureDir, caseDir, { recursive: true });
  await fsp.writeFile(path.join(caseDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (baselineFrom) {
    await fsp.copyFile(path.join(baselineFrom, "trajectory.jsonl"), path.join(caseDir, "baseline.jsonl"));
  }
  // A grade travels INSIDE the sealed bundle as grade.json — there is no
  // sibling report artifact, and findings synthesis reads it from here.
  if (grade) await fsp.writeFile(path.join(caseDir, "grade.json"), JSON.stringify(grade, null, 2));
  const out = path.join(tmp, "run.ptrun");
  writeBundle(caseDir, out);
  const buf = await fsp.readFile(out);
  await fsp.rm(tmp, { recursive: true, force: true });
  return buf;
}

// A patched manifest derived from a fixture, shaped for this seeded run.
function makeManifest(fixtureDir, { runId, caseId, storyId, status, healed = false, changed = false, gateChecks = [] }) {
  const base = JSON.parse(fs.readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"));
  base.run_id = runId;
  base.case = { ...base.case, id: caseId, story: storyId };
  base.mode = healed ? "act" : base.mode;
  base.healed = healed;
  base.changed = changed;
  base.result = {
    ...base.result,
    status,
    end_reason: status === "fail" ? "gate_failed" : "done",
    error: status === "fail" ? (gateChecks[0]?.detail ?? "assertion failed") : null,
    gate: { pass: status !== "fail", checks: gateChecks },
  };
  return base;
}

// ---------------------------------------------------------------------------
// Run-group creation — the public launch, then the public claim board, then the
// public executor protocol. No direct-DB seam here at all.
// ---------------------------------------------------------------------------
async function latestSnapshotId(suiteId) {
  const { items } = await api("GET", `/suites/${suiteId}/snapshots`, undefined, { expect: 200 });
  if (!items?.length) throw new Error(`suite ${suiteId} has no snapshot`);
  return items[0].id;
}

/** Launch one group the way the console does, pinning SEED_LABEL so only this
 *  script's runner can take it off the board. */
async function launchGroup({ suiteId, ringId, note, cases }) {
  const out = await api("POST", `/projects/${PROJECT_KEY}/run-groups`, {
    suite_id: suiteId,
    ring_id: ringId,
    note,
    runner_labels: [SEED_LABEL],
    selection: { ids: cases.map((c) => c.caseId), mode: "auto" },
  }, { expect: [200, 201] });
  return out.run_group.id;
}

/** The seed's own self-hosted runner: registered once, and the only thing on
 *  this deployment advertising SEED_LABEL. */
async function registerSeedRunner() {
  const runner = await api("POST", `/projects/${PROJECT_KEY}/runners`, {
    name: "study-seed-runner",
    labels: [SEED_LABEL],
  }, { expect: 201 });
  return runner.credential;
}

/** Take one group's offer off the board and exchange for its scoped bearer —
 *  the real arrival, exactly as a laptop or a CI job performs it. */
async function claimGroup({ credential, groupId }) {
  const { offers } = await api("GET", `/runner/pool/claims?labels=${SEED_LABEL}&wait=5`, undefined, {
    token: credential, expect: 200,
  });
  const offer = (offers || []).find((o) => o.run_group_id === groupId);
  if (!offer) throw new Error(`no board offer for group ${groupId}: ${JSON.stringify(offers)}`);
  await api("POST", `/runner/pool/claims/${offer.dispatch_id}`, {}, { token: credential, expect: 200 });
  const { token } = await api("POST", "/runner/exchange", { dispatch_id: offer.dispatch_id, isolation: "process" }, {
    token: credential, expect: 200,
  });
  return token;
}

/** Drive the executor protocol for one claimed group: read the spec the server
 *  wrote, then per-case start/upload/report, then complete. Real server logic
 *  creates baselines, candidates, findings, events, and the exit summary. */
async function runGroupViaProtocol({ groupId, token, planFor }) {
  const spec = await api("GET", `/runner/groups/${groupId}`, undefined, { token, expect: 200 });
  for (const run of spec.cases) {
    const p = await planFor(run);
    await api("POST", `/runner/groups/${groupId}/cases/${run.run_id}/start`, {}, { token, expect: 200 });
    const { artifact } = await api("PUT", `/runner/runs/${run.db_id}/bundle`, undefined, {
      token,
      raw: p.bundle,
      contentType: "application/vnd.playtest.run-bundle",
      expect: 200,
    });
    const report = {
      status: p.status,
      bundle: artifact,
      manifest: p.manifest,
      healed: p.healed || undefined,
      changed: p.changed || undefined,
      score: p.score,
      error: p.status === "fail" ? p.manifest.result.error : undefined,
      baseline_written: p.baselineWritten || undefined,
      candidate_written: p.candidateWritten || undefined,
    };
    await api("POST", `/runner/groups/${groupId}/cases/${run.run_id}/report`, report, { token, expect: 200 });
  }
  await api("POST", `/runner/groups/${groupId}/complete`, { summary: {} }, { token, expect: 200 });
}

// Backdate a group's rows so Home tiles / trends span recent days (report sets
// now(); this is cosmetic time-travel over the projections, and one of the two
// direct-DB seams). Timestamps are epoch milliseconds — the schema's INT_TS —
// and the query layer binds a Date as exactly that.
async function backdateGroup(groupId, when) {
  const ts = new Date(when);
  await db(`UPDATE run_groups SET created_at = $2, updated_at = $2 WHERE id = $1`, [groupId, ts]);
  await db(
    `UPDATE runs SET created_at = $2, updated_at = $2,
            started_at = $2, finished_at = $2
      WHERE run_group_id = $1`,
    [groupId, ts],
  );
  await db(`UPDATE run_events SET ts = $2 WHERE run_id IN (SELECT id FROM runs WHERE run_group_id = $1)`, [groupId, ts]);
  await db(
    `UPDATE candidates SET created_at = $2, updated_at = $2 WHERE run_id IN (SELECT id FROM runs WHERE run_group_id = $1)`,
    [groupId, ts],
  );
  await db(
    `UPDATE findings SET first_seen = MIN(first_seen, $2), last_seen = MAX(last_seen, $2), created_at = MIN(created_at, $2)
       WHERE id IN (SELECT finding_id FROM finding_evidence WHERE run_id IN (SELECT id FROM runs WHERE run_group_id = $1))`,
    [groupId, ts],
  );
  await db(
    `UPDATE finding_evidence SET created_at = $2 WHERE run_id IN (SELECT id FROM runs WHERE run_group_id = $1)`,
    [groupId, ts],
  );
}

// A gate check shape the findings extractor understands (result.gate.checks).
const failCheck = (spec, detail) => ({ pass: false, kind: "assert", spec, label: spec, detail, severity: "hard" });

// ---------------------------------------------------------------------------
// The application and its rings, plus the secret, auth provider and token they
// reference (the Applications screens, and Settings → Team).
//
// ONE application — the browser surface these stories drive — with two rings:
// `staging` points at the study-local todo app, `production` at a URL nothing is
// listening on, which is exactly the point (noticing which ring you are about to
// launch against is one of the things this study measures).
// ---------------------------------------------------------------------------
async function seedTargets() {
  await api("POST", `/projects/${PROJECT_KEY}/secrets`, { name: "staging-seed-token", value: "seed-" + crypto.randomBytes(8).toString("hex") }, { expect: 201 });
  const application = await api("POST", `/projects/${PROJECT_KEY}/applications`, {
    key: APPLICATION_KEY,
    name: "Todo Web",
    driver: "web",
  }, { expect: [200, 201] });
  const staging = await api("POST", `/applications/${application.id}/rings`, {
    key: "staging",
    name: "staging",
    // A ring's URL is read from the claiming runner's network position, and the
    // peer runner beside `npm run hosted` is on this machine — so start the
    // study todo app here before anyone launches.
    base_url: "http://127.0.0.1:4173",
    discovery_allowed: true,
    // No routing labels, deliberately: a launch a participant makes has to land
    // on that peer runner and really run. The seeded history pins SEED_LABEL at
    // launch instead, so the peer runner can never claim a fabricated group.
    runner_labels: [],
    config: {
      // No auth identities: the todo fixture app has no login, and a $session
      // identity would make a real launch mint against the fake sso endpoint and
      // die. Production (below) keeps the sso showcase config.
      secret_env: { PLAYTEST_SEED_TOKEN: { $secret: "staging-seed-token" } },
    },
  }, { expect: [200, 201] });
  const prod = await api("POST", `/applications/${application.id}/rings`, {
    key: "production",
    name: "production",
    base_url: "https://todos.example.com",
    discovery_allowed: false,
    runner_labels: [],
    config: { auth: { default: "member", identities: { member: { $session: "sso/member" } } } },
  }, { expect: [200, 201] });
  await api("POST", `/projects/${PROJECT_KEY}/auth-providers`, {
    name: "sso",
    kind: "token_endpoint",
    config: { url: "https://sso.example.com/mint", method: "POST", body: { identity: "{{identity}}", username: "{{username}}" } },
    identities: { member: { username: "qa-member" }, admin: { username: "qa-admin" } },
    ttl_minutes: 45,
  }, { expect: [200, 201] });
  await api("POST", `/projects/${PROJECT_KEY}/tokens`, { role: "editor", name: "ci-pipeline" }, { expect: [200, 201] }).catch((e) => log("  (tokens:", e.message + ")"));
  log(`created application ${APPLICATION_KEY} with rings ${staging.key} + ${prod.key}, 1 secret, 1 auth provider, 1 token`);
  return { application, staging, prod };
}

// ---------------------------------------------------------------------------
// The seed plan.
// ---------------------------------------------------------------------------
async function main() {
  log(`Seeding hosted UX study project into ${BASE}`);
  await reset();

  // 1. Project, application and suite (the study-owned todo fixture imported
  //    via the tar endpoint). The application comes FIRST: a suite binds to
  //    exactly one at creation, and that binding never changes.
  const project = await api("POST", "/projects", { key: PROJECT_KEY, name: PROJECT_NAME }, { expect: [200, 201] });
  const projectId = project.id;
  const { application, staging } = await seedTargets();
  const suite = await api("POST", `/projects/${PROJECT_KEY}/suites`, { slug: "todos", name: "Todos" }, { expect: [200, 201] });
  const files = loadSuiteDir(path.join(REPO(), "studies/hosted-ux/fixtures/todos"));
  const tar = writeTar(files);
  await api("POST", `/suites/${suite.id}/import`, undefined, { raw: tar, contentType: "application/x-tar", expect: [200, 201] });
  log(`created project ${projectId} + suite ${suite.id} (study fixture imported)`);

  // Add a discovery story so the Cases screen shows a discovery case (+ gives
  // study synthesis a target). Committed through the public suite API.
  await api("POST", `/suites/${suite.id}/commit`, {
    changes: [
      {
        path: "stories/export-study.yaml",
        content:
          "description: Where do users look to export their list?\n" +
          "mode: discovery\n" +
          "persona: [curious-newcomer, power-user]\n" +
          "story: |\n  You want to get your todo list out of the app to share it. Do it\n  however seems natural, and narrate what you look for.\n" +
          "report:\n  - Where did they look first for an export/share affordance?\n  - What did they expect to happen?\n",
      },
      // The personas the story names must live in the suite, or a real launch
      // of export-study dies at startup with "persona not found" infra rows —
      // exactly what both launch-and-follow study personas then flagged as
      // blocking release sign-off.
      {
        path: "personas/curious-newcomer.yaml",
        content:
          "name: curious-newcomer\n" +
          "description: |\n" +
          "  Someone who just heard about this app from a friend and is trying it\n" +
          "  for the first time. Curious and happy to explore, but reads every\n" +
          "  label before clicking, and double-checks that each action actually\n" +
          "  did something before moving on. Mildly suspicious of anything that\n" +
          "  sounds destructive.\n",
      },
      {
        path: "personas/power-user.yaml",
        content:
          "name: power-user\n" +
          "description: |\n" +
          "  A daily user who lives in keyboard shortcuts and expects bulk\n" +
          "  actions everywhere. Impatient with hunting: scans the obvious\n" +
          "  spots (toolbar, context menu, settings) once each, and judges the\n" +
          "  app by how fast a capability can be found, not whether it exists.\n",
      },
    ],
    note: "add discovery study",
  }, { expect: [200, 201] });

  const snapshotId = await latestSnapshotId(suite.id);

  // 2. Run history. Fixtures for bundles (real trajectories).
  const fx = FIXTURES[0];
  const fxAlt = FIXTURES[1] || FIXTURES[0];
  const now = Date.now();

  const passGate = [];
  const groups = [
    {
      note: "baseline recording", when: now - 6 * DAY,
      cases: [
        { caseId: "add-todo", storyId: "add-todo", mode: "record", status: "pass", score: 90, baseline: true },
        { caseId: "complete-todo", storyId: "complete-todo", mode: "record", status: "pass", score: 88, baseline: true },
      ],
    },
    {
      note: "nightly regression", when: now - 4 * DAY,
      cases: [
        { caseId: "add-todo", storyId: "add-todo", mode: "act", status: "pass", score: 91 },
        { caseId: "complete-todo", storyId: "complete-todo", mode: "act", status: "pass", score: 87 },
      ],
    },
    {
      note: "nightly regression", when: now - 2 * DAY,
      cases: [
        { caseId: "add-todo", storyId: "add-todo", mode: "act", status: "pass", score: 93 },
        { caseId: "clear-completed", storyId: "clear-completed", mode: "record", status: "pass", score: 85, baseline: true },
        { caseId: "complete-todo", storyId: "complete-todo", mode: "act", status: "pass", score: 89 },
      ],
    },
    {
      note: "regression (failure)", when: now - 1 * DAY + 3 * 60 * 60 * 1000,
      cases: [
        {
          caseId: "complete-todo", storyId: "complete-todo", mode: "act", status: "fail", score: 40,
          gate: [failCheck("the counter shows \"1 item left\"", 'expected the counter to read "1 item left" but it showed "2 items left" after marking a todo done')],
        },
        { caseId: "add-todo", storyId: "add-todo", mode: "act", status: "pass", score: 92 },
      ],
    },
    {
      note: "morning run (changed)", when: now - 2 * 60 * 60 * 1000,
      cases: [
        { caseId: "add-todo", storyId: "add-todo", mode: "act", status: "pass", score: 90, healed: true, changed: true, candidate: true },
        { caseId: "complete-todo", storyId: "complete-todo", mode: "act", status: "pass", score: 88 },
      ],
    },
  ];

  // The seed's own runner, and the only thing advertising SEED_LABEL.
  const credential = await registerSeedRunner();

  const created = [];
  for (const g of groups) {
    const groupId = await launchGroup({ suiteId: suite.id, ringId: staging.id, note: g.note, cases: g.cases });
    const token = await claimGroup({ credential, groupId });
    // The server decided the run ids and their order; the plan is looked up by
    // case, so a fabricated verdict always lands on the run it was written for.
    await runGroupViaProtocol({
      groupId,
      token,
      planFor: async (run) => {
        const c = g.cases.find((x) => x.caseId === run.case_id);
        if (!c) throw new Error(`group "${g.note}" has no plan for case ${run.case_id}`);
        const manifest = makeManifest(c.healed ? fxAlt : fx, {
          runId: run.run_id, caseId: c.caseId, storyId: c.storyId, status: c.status,
          healed: !!c.healed, changed: !!c.changed, gateChecks: c.gate || passGate,
        });
        const bundle = await buildBundle({ fixtureDir: c.healed ? fxAlt : fx, manifest, baselineFrom: c.candidate ? fx : null });
        const meta = { accepted_at: new Date(g.when).toISOString(), run_id: run.run_id, pins: manifest.pins, verdicts: [] };
        return {
          status: c.status, manifest, bundle, score: c.score, healed: c.healed, changed: c.changed,
          baselineWritten: c.baseline ? meta : null,
          candidateWritten: c.candidate ? meta : null,
        };
      },
    });
    await backdateGroup(groupId, g.when);
    created.push({ groupId, note: g.note });
    log(`  ran group "${g.note}" (${g.cases.length} cases) -> ${groupId}`);
  }

  // A discovery/explored group (DB projection — no discovery executor runs
  // here) so the Runs filter + discovery views show explored runs. Its grade
  // rides inside a sealed bundle as grade.json, which is where findings
  // synthesis reads one from. A group names both the application and the ring
  // it resolved: the pair is what ran, and the schema checks they agree.
  let exploredGroupId = null;
  try {
    exploredGroupId = ulid();
    const exploredAt = new Date(now - 3 * DAY);
    await db(
      `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, application_id, ring_id, trigger, selection, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'done',$9,$9)`,
      [exploredGroupId, projectId, suite.id, snapshotId, application.id, staging.id,
        { kind: "manual", note: "export discovery study" }, { ids: ["export-study"], mode: "auto" }, exploredAt],
    );
    for (const persona of ["curious-newcomer", "power-user"]) {
      const runDbId = ulid();
      const runIdTok = `${newRunId()}-${persona}`;
      await db(
        `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode, manifest, created_at, updated_at, started_at, finished_at)
           VALUES ($1,$2,$3,$4,$5,'explored','explore',$6,$7,$7,$7,$7)`,
        [runDbId, exploredGroupId, `export-study@${persona}`, "export-study", runIdTok,
          { case: { id: `export-study@${persona}`, persona, story: "export-study" }, result: { end_reason: "done" } },
          exploredAt],
      );
      const grade = { score: 70, summary: "The persona hunted for an export affordance and reported back.", report: [{ question: "Where did they look first?", answer: "Top-right menu, then a long-press on the list.", evidence_steps: [1] }], findings: [{ severity: "minor", note: "No visible export/share entry point; users expected one in the header.", step: 1 }] };
      const bundle = await buildBundle({
        fixtureDir: fx,
        manifest: makeManifest(fx, { runId: runIdTok, caseId: `export-study@${persona}`, storyId: "export-study", status: "pass" }),
        grade,
      });
      // There is no public grade upload and no runner token for a projected
      // group, so the sealed bytes are placed through the fs store layout the
      // server itself uses, then the artifact row is registered — the same key
      // shape uploadBundle writes.
      const bundleKey = `runs/${exploredGroupId}/${runDbId}.ptrun`;
      await putStoreObject(bundleKey, bundle);
      await db(
        `INSERT INTO artifacts (id, run_id, kind, key, sha256, size, tier, verified_at)
           VALUES ($1,$2,'bundle',$3,$4,$5,'full',now())`,
        [ulid(), runDbId, bundleKey, sha256(bundle), bundle.length],
      );
    }
    log(`  seeded explored discovery group -> ${exploredGroupId}`);
  } catch (e) {
    log("  (explored group skipped:", e.message + ")");
    exploredGroupId = null;
  }

  // 4. Findings funnel: the fail run already auto-created a "new" finding. Accept
  // one (amend-then-accept) and add a manual promoted finding for variety.
  try {
    const findings = await api("GET", `/projects/${PROJECT_KEY}/findings`, undefined, { expect: 200 });
    const first = findings.items?.[0];
    if (first) {
      await api("POST", `/findings/${first.id}/accept`, { title: first.title, severity: "major", note: "confirmed on staging" }, { expect: 200 });
      log(`  accepted finding ${first.id}`);
    }
    // Manual promotion off the failing run (a reviewer flags a second defect).
    const failRun = (await db(
      `SELECT id FROM runs WHERE status = 'fail' AND run_group_id IN (SELECT id FROM run_groups WHERE project_id = $1) LIMIT 1`,
      [projectId],
    )).rows[0];
    if (failRun) {
      await api("POST", `/runs/${failRun.id}/promote-finding`, { title: "Counter miscount after completing a todo", severity: "major", note: "manually promoted from the regression run" }, { expect: 200 })
        .catch((e) => log("  (promote-finding:", e.message + ")"));
    }
  } catch (e) {
    log("  (findings triage skipped:", e.message + ")");
  }

  // 5. Discovery study synthesis: mine the explored group's graded runs into
  // cited findings (P4 — findings own synthesis; there is no Insights page).
  // Needs the LLM gateway, so it is best-effort and skipped without one.
  try {
    if (exploredGroupId && process.env.PLAYTEST_LLM_BASE_URL) {
      const out = await api("POST", `/run-groups/${exploredGroupId}/synthesize-findings`, {}, { expect: 200 }).catch((e) => {
        log("  (study synthesis:", e.message + ")");
        return null;
      });
      if (out) log(`  synthesized discovery findings (${(out.created || 0) + (out.updated || 0)} into Findings)`);
    } else {
      log("  (study synthesis skipped: no LLM gateway configured)");
    }
  } catch (e) {
    log("  (study synthesis skipped:", e.message + ")");
  }

  await printSummaryAndVerify({ projectId, suiteSlug: suite.slug, groups: created });
}

// The fs object store sits beside the database under the data root (config.ts),
// unless OBJECT_STORE_URL points somewhere else.
function storeRoot() {
  const raw = process.env.PLAYTEST_HOSTED_STORE || path.join(DATA_DIR, "objects");
  return path.resolve(raw);
}
async function putStoreObject(key, buf) {
  const full = path.join(storeRoot(), key);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, buf);
}
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// Summary + verification.
// ---------------------------------------------------------------------------
async function printSummaryAndVerify({ projectId, suiteSlug, groups }) {
  log("\n=== SEED COMPLETE ===");
  log(`Project:  ${PROJECT_NAME} (key=${PROJECT_KEY}, id=${projectId})`);
  log("\nVisit (dev auth — the browser just works, no login):");
  log(`  Home / project:  ${BASE}/p/${PROJECT_KEY}`);
  log(`  Runs:            ${BASE}/p/${PROJECT_KEY}/runs`);
  log(`  Review queue:    ${BASE}/p/${PROJECT_KEY}/review`);
  log(`  Findings:        ${BASE}/p/${PROJECT_KEY}/findings`);
  log(`  Suite / stories: ${BASE}/p/${PROJECT_KEY}/suites/${suiteSlug}`);
  log(`  Applications:    ${BASE}/p/${PROJECT_KEY}/applications`);
  log(`  …this one:       ${BASE}/p/${PROJECT_KEY}/applications/${APPLICATION_KEY}`);
  log(`  Settings:        ${BASE}/p/${PROJECT_KEY}/settings`);
  log(`  API root:        ${BASE}/api/v1`);

  log("\n=== VERIFY ===");
  const checks = [];
  const suites = await api("GET", `/projects/${PROJECT_KEY}/suites`);
  checks.push(["suites non-empty", (suites.items || suites).length >= 1]);
  const apps = await api("GET", `/projects/${PROJECT_KEY}/applications?include=rings`);
  const app = (apps.items || []).find((a) => a.key === APPLICATION_KEY);
  checks.push(["application with two rings", (app?.rings || []).length === 2]);
  const runs = await api("GET", `/runs?project=${projectId}&limit=100`);
  const items = runs.items || [];
  checks.push(["runs: has pass", items.some((r) => r.status === "pass")]);
  checks.push(["runs: has fail", items.some((r) => r.status === "fail")]);
  checks.push(["runs: has changed", items.some((r) => r.changed === true || r.healed === true)]);
  const cands = await api("GET", `/projects/${PROJECT_KEY}/candidates?status=pending`);
  checks.push(["review queue >=1 pending", (cands.items || []).length >= 1]);
  const findings = await api("GET", `/projects/${PROJECT_KEY}/findings`);
  checks.push(["findings non-empty", (findings.items || []).length >= 1]);
  const health = await api("GET", `/projects/${PROJECT_KEY}/health`).catch(() => null);
  checks.push(["health tiles present", !!health && typeof health.pass_rate_7d !== "undefined"]);
  const spa = await fetch(`${BASE}/`).then((r) => r.text()).catch(() => "");
  checks.push(["web app serves SPA at /", /<!doctype html|<div id="?root|<script/i.test(spa)]);

  let ok = true;
  for (const [name, pass] of checks) {
    log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
    if (!pass) ok = false;
  }
  log(`\n${ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"} — runs=${items.length}, pending=${(cands.items || []).length}, findings=${(findings.items || []).length}`);
  if (!ok) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("\nSEED FAILED:", e.stack || e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await conn.end().catch(() => {});
  });
