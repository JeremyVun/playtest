// Phase L2: the live uploader, end to end
// (docs/backlog/live-runs/BUILD_PLAN.md "Phase L2").
//
// L1 proved the platform side against a hand-written runner; the unit tests
// beside the uploader prove its queue against a fake control plane. This is the
// join: a whole control plane on a temporary SQLite data root, the REAL
// runner-agent executing a real case as a child process over real HTTP, and a
// client following the hosted live endpoint the entire time — so what the viewer
// would see mid-run is asserted against what the sealed bundle finally carries.
//
// Offline like every integration test here: the target is a loopback fixture and
// the model is the scripted gateway. The gateway answers on a delay so the case
// takes long enough to actually be watched — a journey that finishes in
// milliseconds proves nothing about streaming.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { withApp, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { SpawningGitHub, sleep, waitForGroupDone } from "./exec-helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";
import { startInvariantApi } from "../../../../../tests/fixtures/invariant-api/server.ts";
import { startScriptedModel } from "../../../../../tests/support/scripted-model.ts";

/** The recorded journey the api-example suite's gates and policies describe. */
const journey = (prefix: string) => [
  { thought: "open the account", action: { type: "request", method: "POST", path: "/accounts", body: { owner: "ada" } }, expectation: "a 201 with the new account" },
  { thought: "post the seed entry", action: { type: "request", method: "POST", path: "/entries", headers: { "Idempotency-Key": "seed-1" }, body: { account_id: `acc_${prefix}_1`, amount: 250 } }, expectation: "a 201" },
  { thought: "replay it with the same key", action: { type: "request", method: "POST", path: "/entries", headers: { "Idempotency-Key": "seed-1" }, body: { account_id: `acc_${prefix}_1`, amount: 250 } }, expectation: "the same entry, not a second one" },
  { thought: "read the account back", action: { type: "request", method: "GET", path: `/accounts/acc_${prefix}_1` }, expectation: "a balance of 250" },
  { thought: "done", action: { type: "done", summary: "funded the account once and confirmed the balance" }, expectation: "the balance is 250" },
];

async function setUp(api: HostedDynamic, { key, baseUrl }: HostedDynamic) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const suite = (await api.post(`/projects/${key}/suites`, { slug: "ledger", name: "Ledger" })).body;
  // loadSuiteDir skips `results/`, so the committed baseline stays behind and
  // this story records — the model in the loop is the scripted gateway.
  const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/api-example`));
  assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);
  const env = (
    await api.post(`/projects/${key}/environments`, {
      name: "laptop",
      runner_labels: ["self-hosted", "playtest"],
      config: { app: { base_url: baseUrl } },
    })
  ).body;
  return { project, suite, env };
}

/** Poll `pred` until it answers something truthy. */
async function until(pred: () => Promise<HostedDynamic>, what: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await pred();
    if (value) return value;
    await sleep(100);
  }
  assert.fail(`timed out waiting for ${what}`);
  return undefined;
}

/**
 * The viewer's live loop, as the viewer runs it: one in-flight long poll, a
 * line cursor echoed back, immediate drain while `has_more`, a full restart on
 * `reset`, and `open: false` ends the conversation.
 */
async function followLive(api: HostedDynamic, projectKey: string, runPath: string) {
  const observed: string[] = [];
  const generations = new Set<number>();
  let after = 0;
  let polls = 0;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const res = await api.get(`/projects/${projectKey}/view/run/${runPath}/live?after=${after}&wait=2`);
    if (res.status !== 200) return { observed, generations, polls, error: `${res.status} ${JSON.stringify(res.body)}` };
    polls += 1;
    const body = res.body;
    if (body.reset) {
      observed.length = 0;
      after = 0;
      continue;
    }
    observed.push(...(body.lines || []));
    after = body.next;
    if (typeof body.manifest_generation === "number") generations.add(body.manifest_generation);
    if (!body.open) return { observed, generations, polls, sealedAt: observed.length };
  }
  throw new Error("the live endpoint never answered open: false");
}

test("a hosted case streams into the live endpoint while it executes, then seals byte-identically", async () => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "live-e2e-"));
  const target = await startInvariantApi({ prefix: "L" });
  // ~1 s per model turn: six turns, so the case spans several uploader ticks
  // instead of finishing inside one.
  const model = await startScriptedModel(journey("L"), { delayMs: 1000 });
  const github = new SpawningGitHub({ llmUrl: model.baseUrl, workRoot });
  try {
    await withApp(
      async ({ api, base, app }: HostedDynamic) => {
        github.serverBase = base;
        const { project, suite, env } = await setUp(api, { key: "livee2e", baseUrl: target.url });
        const launched = await api.post(`/projects/${project.key}/run-groups`, {
          suite_id: suite.id,
          environment_id: env.id,
          selection: { ids: ["ledger-journey"] },
        });
        assert.equal(launched.status, 200, JSON.stringify(launched.body));
        const groupId = launched.body.run_group.id;

        // --- the run becomes viewable BEFORE its bundle exists ---
        const entry = await until(
          async () => {
            const picker = await api.get(`/projects/${project.key}/view/runs.json`);
            return (picker.body || []).find((r: HostedDynamic) => r.open === true) ?? null;
          },
          "the run to open for live viewing",
        );
        assert.equal(entry.status, null, "an open run keeps the no-verdict vocabulary, never the placeholder's interrupted");
        const runPath = entry.path;

        // The placeholder manifest is served from the row the `open` call filled.
        const liveManifest = await api.get(`/projects/${project.key}/view/run/${runPath}/manifest.json`);
        assert.equal(liveManifest.status, 200, "the viewer's first fetch works from `open` onward");

        // --- follow the run to its seal, then let the group finish ---
        const followed = await followLive(api, project.key, runPath);
        assert.equal(followed.error, undefined, `the live endpoint stayed available: ${followed.error}`);
        assert.ok(
          followed.observed.length >= 2,
          `the client saw the run's evidence while it executed (${followed.observed.length} lines over ${followed.polls} polls)`,
        );

        const done = await waitForGroupDone(api, groupId, { execs: github.execs });
        assert.equal(done.runs.length, 1);
        assert.equal(done.runs[0].status, "pass", `the journey passed: ${done.runs[0].error ?? "no error"}`);
        assert.ok(done.runs[0].artifact?.key, "and sealed through the ordinary bundle PUT");

        // --- the sealed run is the record, and the preview was a prefix of it ---
        const sealed = await api.get(`/projects/${project.key}/view/run/${runPath}/trajectory.jsonl`);
        assert.equal(sealed.status, 200);
        const sealedLines = String(sealed.body).split("\n").filter(Boolean);
        assert.ok(sealedLines.length >= followed.observed.length, "the seal carries at least everything the stream did");
        for (let i = 0; i < followed.observed.length; i++) {
          // The single in-place mutation a run dir permits is `rewriteLast()` on
          // the terminal envelope, which the viewer picks up in its reload at
          // seal; every other observed line must be byte-identical.
          if (i === sealedLines.length - 1) continue;
          assert.equal(followed.observed[i], sealedLines[i], `live line ${i} is byte-identical to the sealed line ${i}`);
        }

        const sealedManifest = await api.get(`/projects/${project.key}/view/run/${runPath}/manifest.json`);
        assert.equal(sealedManifest.body.result.status, "pass", "the sealed manifest replaces the placeholder snapshot");
        const picker = await api.get(`/projects/${project.key}/view/runs.json`);
        const sealedEntry = (picker.body || []).find((r: HostedDynamic) => r.path === runPath);
        assert.equal(sealedEntry.open, undefined, "a sealed entry carries no open key at all");
        assert.equal(sealedEntry.status, "pass");

        // --- staging is deleted once a verified bundle exists ---
        const row = (await app.db.query(`SELECT id, live_opened_at FROM runs WHERE run_group_id = $1`, [groupId])).rows[0];
        assert.ok(row.live_opened_at, "the run really was opened by the uploader, not merely reported");
        const staged = await app.db.query(
          `SELECT (SELECT COUNT(*) FROM live_trajectory WHERE run_id = $1) AS lines,
                  (SELECT COUNT(*) FROM live_artifacts WHERE run_id = $1) AS artifacts`,
          [row.id],
        );
        assert.equal(Number(staged.rows[0].lines), 0, "the trajectory ledger is dropped at the verified seal");
        assert.equal(Number(staged.rows[0].artifacts), 0);

        const afterSeal = await api.get(`/projects/${project.key}/view/run/${runPath}/live?after=0&wait=0`);
        assert.equal(afterSeal.body.open, false, "and the live endpoint answers the terminal shape from then on");
      },
      {},
      { github },
    );
  } finally {
    await Promise.all(github.execs.map((e: HostedDynamic) => e.promise));
    await target.close();
    await model.close();
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
});
