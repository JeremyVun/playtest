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
// PLAYTEST_HOSTED_BASE, backed by the Postgres at PLAYTEST_HOSTED_DB.
//
// Design (see the module comments): everything that has a public API is driven
// through /api/v1 as the dev admin. The ONE thing with no public path is
// *creating runs*: POST /projects/:p/run-groups hard-refuses unless GitHub
// dispatch is configured (src/platform/control-plane/src/dispatch/dispatcher.ts:12-16), and this
// dev server has no GitHub App. So run history is created by (a) inserting the
// run_group + runs + dispatch rows a launch would have made — the sole
// direct-DB seam, isolated in seedRunGroupRows() — and then (b) driving the
// REAL public runner protocol (exchange -> start -> uploadBundle -> report ->
// complete) exactly as a GitHub Actions executor would. That path is reachable
// because config.dispatch.allowInsecureRunnerExchange is ON in dev
// (src/platform/control-plane/src/config.ts:92), so the server computes candidate diffs,
// extracts findings, emits events, and stores bundles through its own code —
// nothing about results is hand-forged in the DB. Bundles reuse GENUINE
// committed trajectories from studies/viewer-self-test/fixtures/ (run bundles have pinned
// schemas — never invent bytes), packed with core writeBundle.
//
// Zero new deps: fetch is a Node 20 global; `pg` is reused from src/platform/control-plane's
// node_modules; tar/bundle/ulid/newRunId are imported from the repo by path.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { writeBundle } from "../../src/core/bundle.js";
import { newRunId } from "../../src/core/trajectory.js";
import { writeTar } from "../../src/platform/control-plane/src/suites/tar.ts";
import { ulid } from "../../src/platform/control-plane/src/ulid.ts";

const require = createRequire(path.join(REPO(), "src/platform/control-plane/"));
const { Pool } = require("pg");

function REPO() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

const BASE = (process.env.PLAYTEST_HOSTED_BASE || "http://127.0.0.1:4177").replace(/\/$/, "");
const DB_URL = process.env.PLAYTEST_HOSTED_DB || "postgres://playtest@127.0.0.1:54329/playtest";
const PROJECT_KEY = "todos";
const PROJECT_NAME = "Todo App";
const DAY = 24 * 60 * 60 * 1000;

const pool = new Pool({ connectionString: DB_URL });
const db = (text, params) => pool.query(text, params);

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
// RESET — direct-DB wipe for fixture reload (also available as DELETE
// /api/v1/projects/:p). run_groups is deleted first because it references
// suites/snapshots ON DELETE RESTRICT; then the project cascades the rest.
// ---------------------------------------------------------------------------
async function reset() {
  for (const key of [PROJECT_KEY, "probe"]) {
    const { rows } = await db(`SELECT id FROM projects WHERE key = $1`, [key]);
    if (!rows[0]) continue;
    const pid = rows[0].id;
    await db(`DELETE FROM run_groups WHERE project_id = $1`, [pid]); // cascades runs -> events/artifacts/candidates/evidence
    await db(`DELETE FROM findings WHERE project_id = $1`, [pid]); // cascades remaining evidence
    await db(`DELETE FROM baselines WHERE project_id = $1`, [pid]);
    await db(`DELETE FROM dispatches WHERE project_id = $1`, [pid]);
    await db(`DELETE FROM executors WHERE run_group_id IS NULL AND kind = 'group'`).catch(() => {});
    await db(`DELETE FROM projects WHERE id = $1`, [pid]); // cascades the rest
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

async function buildBundle({ fixtureDir, manifest, baselineFrom = null }) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-seed-bundle-"));
  const caseDir = path.join(tmp, "case");
  await fsp.cp(fixtureDir, caseDir, { recursive: true });
  await fsp.writeFile(path.join(caseDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (baselineFrom) {
    await fsp.copyFile(path.join(baselineFrom, "trajectory.jsonl"), path.join(caseDir, "baseline.jsonl"));
  }
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
// Run-group creation. seedRunGroupRows() is the SOLE direct-DB seam (the missing
// launch API); everything after runs through the public runner protocol.
// ---------------------------------------------------------------------------
async function latestSnapshotId(suiteId) {
  const { rows } = await db(`SELECT id FROM suite_snapshots WHERE suite_id = $1 ORDER BY seq DESC LIMIT 1`, [suiteId]);
  if (!rows[0]) throw new Error(`suite ${suiteId} has no snapshot`);
  return rows[0].id;
}

/** DB-INSERT ONLY: the run_group + runs(queued) + dispatch(requested) rows that
 *  createRunGroup() would produce — but that endpoint refuses without GitHub
 *  dispatch configured (dispatcher.js:12-16), so there is no public path here. */
async function seedRunGroupRows({ projectId, suiteId, envId, snapshotId, note, cases }) {
  const groupId = ulid();
  const dispatchId = ulid();
  const runs = cases.map((c, i) => ({
    id: ulid(),
    run_id: `${newRunId()}-${i}`,
    case_id: c.caseId,
    story_id: c.storyId,
    mode: c.mode,
  }));
  await db(
    `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, environment_id, trigger, selection, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued')`,
    [groupId, projectId, suiteId, snapshotId, envId, JSON.stringify({ kind: "manual", note }), JSON.stringify({ ids: cases.map((c) => c.caseId), mode: "auto" })],
  );
  for (const r of runs) {
    await db(
      `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode)
         VALUES ($1,$2,$3,$4,$5,'queued',$6)`,
      [r.id, groupId, r.case_id, r.story_id, r.run_id, r.mode],
    );
  }
  await db(
    `INSERT INTO dispatches (id, project_id, kind, ref_id, attempt, status)
       VALUES ($1,$2,'group',$3,1,'requested')`,
    [dispatchId, projectId, groupId],
  );
  return { groupId, runs };
}

/** Drive the public runner protocol for one group: exchange -> per-case
 *  start/upload/report -> complete. Real server logic creates baselines,
 *  candidates, findings, events, and the exit summary. */
async function runGroupViaProtocol({ projectKey, groupId, runs, plan }) {
  const { token } = await api("POST", "/runner/exchange", { run_group_id: groupId, isolation: "process" }, { expect: 200 });
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const p = plan[i];
    await api("POST", `/runner/groups/${groupId}/cases/${run.run_id}/start`, {}, { token, expect: 200 });
    const { artifact } = await api("PUT", `/runner/runs/${run.id}/bundle`, undefined, {
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
// now(); this is cosmetic time-travel over the projections, part of the seam).
async function backdateGroup(groupId, when) {
  const ts = new Date(when).toISOString();
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
    `UPDATE findings f SET first_seen = LEAST(f.first_seen, $2::timestamptz), last_seen = GREATEST(f.last_seen, $2::timestamptz), created_at = LEAST(f.created_at, $2::timestamptz)
       WHERE f.id IN (SELECT finding_id FROM finding_evidence WHERE run_id IN (SELECT id FROM runs WHERE run_group_id = $1))`,
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
// The seed plan.
// ---------------------------------------------------------------------------
async function main() {
  log(`Seeding hosted UX study project into ${BASE}`);
  await reset();

  // 1. Project + suite (the study-owned todo fixture imported via the tar endpoint).
  const project = await api("POST", "/projects", { key: PROJECT_KEY, name: PROJECT_NAME }, { expect: [200, 201] });
  const projectId = project.id;
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

  // 2. Environments, secret, auth provider, token (Settings screens).
  const staging = await api("POST", `/projects/${PROJECT_KEY}/environments`, {
    name: "staging",
    discovery_allowed: true,
    runner_labels: ["self-hosted", "playtest", "pool:checkout"],
    config: {
      // Real local target so Launch (PLAYTEST_DISPATCH=local) actually runs:
      // start it with the study-local todo app before launching.
      app: { base_url: "http://127.0.0.1:4173" },
      // No auth identities: the todo fixture app has no login, and $session
      // identities would make a real local launch mint against the fake sso
      // endpoint and die. Production (below) keeps the sso showcase config.
      secret_env: { PLAYTEST_SEED_TOKEN: "staging-seed-token" },
    },
  }, { expect: [200, 201] });
  const prod = await api("POST", `/projects/${PROJECT_KEY}/environments`, {
    name: "production",
    discovery_allowed: false,
    runner_labels: ["self-hosted", "playtest"],
    config: { app: { base_url: "https://todos.example.com" }, auth: { default: "member", identities: { member: { $session: "sso/member" } } }, secret_env: {} },
  }, { expect: [200, 201] });
  await api("POST", `/projects/${PROJECT_KEY}/secrets`, { name: "staging-seed-token", value: "seed-" + crypto.randomBytes(8).toString("hex") }, { expect: 201 });
  await api("POST", `/projects/${PROJECT_KEY}/auth-providers`, {
    name: "sso",
    kind: "token_endpoint",
    config: { url: "https://sso.example.com/mint", method: "POST", body: { identity: "{{identity}}", username: "{{username}}" } },
    identities: { member: { username: "qa-member" }, admin: { username: "qa-admin" } },
    ttl_minutes: 45,
  }, { expect: [200, 201] });
  await api("POST", `/projects/${PROJECT_KEY}/tokens`, { role: "editor", name: "ci-pipeline" }, { expect: [200, 201] }).catch((e) => log("  (tokens:", e.message + ")"));
  log("created 2 environments, 1 secret, 1 auth provider, 1 token");

  // 3. Run history. Fixtures for bundles (real trajectories).
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

  const created = [];
  for (const g of groups) {
    const { groupId, runs } = await seedRunGroupRows({ projectId, suiteId: suite.id, envId: staging.id, snapshotId, note: g.note, cases: g.cases });
    const plan = [];
    for (const c of g.cases) {
      const runId = runs[g.cases.indexOf(c)].run_id;
      const manifest = makeManifest(c.healed ? fxAlt : fx, {
        runId, caseId: c.caseId, storyId: c.storyId, status: c.status, healed: !!c.healed, changed: !!c.changed, gateChecks: c.gate || passGate,
      });
      const bundle = await buildBundle({ fixtureDir: c.healed ? fxAlt : fx, manifest, baselineFrom: c.candidate ? fx : null });
      const meta = { accepted_at: new Date(g.when).toISOString(), run_id: runId, pins: manifest.pins, verdicts: [] };
      plan.push({
        status: c.status, manifest, bundle, score: c.score, healed: c.healed, changed: c.changed,
        baselineWritten: c.baseline ? meta : null,
        candidateWritten: c.candidate ? meta : null,
      });
    }
    await runGroupViaProtocol({ projectKey: PROJECT_KEY, groupId, runs, plan });
    await backdateGroup(groupId, g.when);
    created.push({ groupId, note: g.note });
    log(`  ran group "${g.note}" (${runs.length} cases) -> ${groupId}`);
  }

  // A discovery/explored group (DB projection — no discovery executor available
  // here) so the Runs filter + discovery views show explored runs. Graded via a
  // sibling report artifact, the synthesis no-bundle evidence path
  // (mirrors phase4-synthesis.test.js seedExploredGroup).
  let exploredGroupId = null;
  try {
    exploredGroupId = ulid();
    await db(
      `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, environment_id, trigger, selection, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'done',$8,$8)`,
      [exploredGroupId, projectId, suite.id, snapshotId, staging.id, JSON.stringify({ kind: "manual", note: "export discovery study" }), JSON.stringify({ ids: ["export-study"], mode: "auto" }), new Date(now - 3 * DAY).toISOString()],
    );
    for (const persona of ["curious-newcomer", "power-user"]) {
      const runDbId = ulid();
      const runIdTok = `${newRunId()}-${persona}`;
      await db(
        `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode, manifest, created_at, updated_at, started_at, finished_at)
           VALUES ($1,$2,$3,$4,$5,'explored','explore',$6,$7,$7,$7,$7)`,
        [runDbId, exploredGroupId, `export-study@${persona}`, "export-study", runIdTok,
          JSON.stringify({ case: { id: `export-study@${persona}`, persona, story: "export-study" }, result: { end_reason: "done" } }),
          new Date(now - 3 * DAY).toISOString()],
      );
      const grade = { score: 70, summary: "The persona hunted for an export affordance and reported back.", report: [{ question: "Where did they look first?", answer: "Top-right menu, then a long-press on the list.", evidence_steps: [1] }], findings: [{ severity: "minor", note: "No visible export/share entry point; users expected one in the header.", step: 1 }] };
      const gradeKey = `runs/${exploredGroupId}/${runDbId}.grade.json`;
      const gradeBuf = Buffer.from(JSON.stringify(grade));
      // Write the grade via the object store is not public; place the sibling
      // report artifact bytes on disk through the fs store layout used by the
      // server, then register the artifact row. (No public grade-upload API.)
      await putStoreObject(gradeKey, gradeBuf);
      await db(
        `INSERT INTO artifacts (id, run_id, kind, key, sha256, size, tier, verified_at)
           VALUES ($1,$2,'report',$3,$4,$5,'core',now())`,
        [ulid(), runDbId, gradeKey, sha256(gradeBuf), gradeBuf.length],
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

  await printSummaryAndVerify({ projectId, suiteId: suite.id, groups: created });
}

// The fs object store lives at <cwd-of-server>/.playtest-data/objects by default
// (config.js). The server runs from src/platform/control-plane, and OBJECT_STORE_URL is unset.
function storeRoot() {
  const raw = process.env.PLAYTEST_HOSTED_STORE || path.join(REPO(), "src/platform/control-plane/.playtest-data/objects");
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
async function printSummaryAndVerify({ projectId, suiteId, groups }) {
  log("\n=== SEED COMPLETE ===");
  log(`Project:  ${PROJECT_NAME} (key=${PROJECT_KEY}, id=${projectId})`);
  log("\nVisit (dev auth — the browser just works, no login):");
  log(`  Home / project:  ${BASE}/p/${PROJECT_KEY}`);
  log(`  Runs:            ${BASE}/p/${PROJECT_KEY}/runs`);
  log(`  Review queue:    ${BASE}/p/${PROJECT_KEY}/review`);
  log(`  Findings:        ${BASE}/p/${PROJECT_KEY}/findings`);
  log(`  Suite / cases:   ${BASE}/p/${PROJECT_KEY}/suites/${suiteId}`);
  log(`  Settings:        ${BASE}/p/${PROJECT_KEY}/settings`);
  log(`  API root:        ${BASE}/api/v1`);

  log("\n=== VERIFY ===");
  const checks = [];
  const suites = await api("GET", `/projects/${PROJECT_KEY}/suites`);
  checks.push(["suites non-empty", (suites.items || suites).length >= 1]);
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
    await pool.end().catch(() => {});
  });
