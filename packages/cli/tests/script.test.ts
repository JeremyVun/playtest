// `playtest script author` — the local surface on the authoring loop
// (docs/contracts/scripts.md#the-authoring-loop).
//
// The loop itself is proven in tests/core/integration/script-authoring.test.ts;
// what matters here is the CLI contract: a job document is validated as user
// input, a missing target authorization refuses the job with an actionable
// message and no stack, and `--prepare` writes the handout without a model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI, REPO_ROOT as ROOT } from "./support.ts";

const SPEC = path.join(ROOT, "tests", "fixtures", "authoring-api", "openapi.json");

const runCli = (args: LegacyTestValue, cwd: LegacyTestValue) => {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env: process.env, encoding: "utf8", timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message as string); // SAFETY: message is read only when spawn reports an Error
  return result;
};
const output = (result: LegacyTestValue) => `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

function workspace(job: LegacyTestValue) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "script-cli-"));
  fs.writeFileSync(path.join(dir, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
  return dir;
}

const JOB = {
  target: {
    base_url: "http://127.0.0.1:4199",
    authorization: { origin: "http://127.0.0.1:4199", approved_by: "the widget team", approved_at: "2026-07-26", write: true },
  },
  spec: SPEC,
  rules: [{ id: "lifecycle", statement: "Publishing an already-published widget is refused with 409." }],
  out_dir: "authoring",
};

test("--prepare writes the handout, names its obligations, and never calls a model", () => {
  const dir = workspace(JOB);
  try {
    const result = runCli(["script", "author", "job.json", "--prepare"], dir);
    assert.equal(result.status, 0, output(result));
    assert.match(result.stdout, /handout written to/);
    assert.match(result.stdout, /obligations {2}12 \(4 policy, 7 operation, 1 rule\)/);
    assert.match(result.stdout, /authorized by the widget team/);
    const handout = fs.readdirSync(path.join(dir, "authoring", "handout")).sort();
    assert.deepEqual(handout, ["BRIEF.md", "CLIENT.md", "INVARIANTS.md", "handout-manifest.json", "obligations.json", "openapi.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a job with no recorded target authorization is refused, actionably and without a stack", () => {
  const dir = workspace({ ...JOB, target: { base_url: JOB.target.base_url } });
  try {
    const result = runCli(["script", "author", "job.json", "--prepare"], dir);
    assert.equal(result.status, 2, output(result));
    assert.match(result.stderr, /"authorization" is required/);
    assert.doesNotMatch(result.stderr, /at Object\.|node:internal|MODULE_NOT_FOUND/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an authorization for another origin does not license this target", () => {
  const dir = workspace({ ...JOB, target: { ...JOB.target, authorization: { ...JOB.target.authorization, origin: "http://127.0.0.1:4200" } } });
  try {
    const result = runCli(["script", "author", "job.json", "--prepare"], dir);
    assert.equal(result.status, 2, output(result));
    assert.match(result.stderr, /covers http:\/\/127\.0\.0\.1:4200, but this job resolves http:\/\/127\.0\.0\.1:4199/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown key in a job file names itself rather than being ignored", () => {
  const dir = workspace({ ...JOB, budget: { iterations: 3 }, sepc: "typo" });
  try {
    const result = runCli(["script", "author", "job.json", "--prepare"], dir);
    assert.equal(result.status, 2, output(result));
    assert.match(result.stderr, /unknown key "sepc"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
