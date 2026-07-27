import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { baselinePaths } from "../../src/core/trajectory.ts";
import { makeRunsFixture } from "../support/run-fixtures.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "src", "cli", "cli.ts");

function runCli(args: LegacyTestValue) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined, result.error?.message as string); // TODO(ts): message is read only when spawn reports an Error
  return result;
}

const output = (result: LegacyTestValue) => `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

test("help keeps the human surface focused and groups baseline lifecycle commands", () => {
  const top = runCli(["--help"]);
  assert.equal(top.status, 0, output(top));
  for (const command of ["new", "view", "install-skill", "clip", "baseline"]) {
    assert.match(top.stdout, new RegExp(`^  ${command}(?: |$)`, "m"));
  }
  for (const hidden of ["list", "lint", "personas", "accept", "reject", "refresh", "grade"]) {
    assert.doesNotMatch(top.stdout, new RegExp(`^  ${hidden}(?: |$)`, "m"));
  }

  const runHelp = runCli(["run", "--help"]);
  assert.match(runHelp.stdout, /--fresh/);
  assert.doesNotMatch(runHelp.stdout, /--parallel|--runs-root|--remote|--mode|--no-tui|--ci|--plain|--yes/);

  const baseline = runCli(["baseline", "--help"]);
  for (const command of ["refresh", "accept", "reject"]) {
    assert.match(baseline.stdout, new RegExp(`^  ${command}(?: |$)`, "m"));
  }

  for (const [flag, value] of [
    ["--mode", "agent"],
    ["--no-tui"],
    ["--ci"],
    ["--plain"],
    ["--yes"],
    ["--remote"],
    ["--project", "project"],
    ["--suite", "suite"],
    ["--no-wait"],
  ]) {
    const removed = runCli(["run", flag, ...(value ? [value] : [])]);
    assert.notEqual(removed.status, 0, `${flag} remains callable`);
    assert.match(removed.stderr, new RegExp(`unknown option '${flag}'`));
  }

  const clip = runCli(["clip", "--help"]);
  assert.doesNotMatch(clip.stdout, /parent dir|suite dir|case file|--runs-root|--tag|--id/);
  for (const [command, flag] of [["view", "--runs-root"], ["clip", "--runs-root"], ["clip", "--tag"], ["clip", "--id"]]) {
    const removed = runCli([command, flag, "value"]);
    assert.notEqual(removed.status, 0, `${command} ${flag} remains callable`);
    assert.match(removed.stderr, new RegExp(`unknown option '${flag}'`));
  }
});

test("list --json reports record before a baseline and check after one exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-cli-list-"));
  try {
    const fixture = makeRunsFixture(root);
    const before = runCli(["list", path.dirname(fixture.caseFile), "--json"]);
    assert.equal(before.status, 0, output(before));
    assert.deepEqual(JSON.parse(before.stdout).map((entry: LegacyTestValue) => entry.next_run), ["record"]);

    const paths = baselinePaths(fixture.caseFile);
    fs.copyFileSync(path.join(fixture.recordDir, "trajectory.jsonl"), paths.traj);
    const after = runCli(["list", path.dirname(fixture.caseFile), "--json"]);
    assert.equal(after.status, 0, output(after));
    assert.deepEqual(JSON.parse(after.stdout).map((entry: LegacyTestValue) => entry.next_run), ["check"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("new scaffolds stories at the suite root and rejects the reserved playtest name", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-cli-new-"));
  try {
    const suite = path.join(root, "suite");
    const created = runCli(["new", "checkout-flow", suite]);
    assert.equal(created.status, 0, output(created));
    assert.ok(fs.existsSync(path.join(suite, "stories", "checkout-flow.yaml")));
    assert.ok(fs.existsSync(path.join(suite, "playtest.yaml")));
    assert.ok(!fs.existsSync(path.join(suite, "checkout-flow.yaml")));

    const reserved = path.join(root, "reserved");
    const rejected = runCli(["new", "playtest", reserved]);
    assert.equal(rejected.status, 2, output(rejected));
    assert.match(rejected.stderr, /collides with the playtest\.yaml defaults file/);
    assert.ok(!fs.existsSync(reserved));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("baseline reject removes only the matching healed candidate and preserves its baseline", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-cli-reject-"));
  try {
    const fixture = makeRunsFixture(root);
    const paths = baselinePaths(fixture.caseFile);
    const sentinel = '{"baseline":"keep"}\n';
    fs.writeFileSync(paths.traj, sentinel);
    fs.writeFileSync(paths.meta, '{"run_id":"accepted"}\n');

    const rejected = runCli(["baseline", "reject", fixture.healDir]);
    assert.equal(rejected.status, 0, output(rejected));
    assert.ok(!fs.existsSync(paths.healedTraj));
    assert.ok(!fs.existsSync(paths.healedMeta));
    assert.equal(fs.readFileSync(paths.traj, "utf8"), sentinel);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("baseline accept promotes a passing run to the saved path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-cli-accept-"));
  try {
    const fixture = makeRunsFixture(root);
    const accepted = runCli(["baseline", "accept", fixture.recordDir]);
    assert.equal(accepted.status, 0, output(accepted));
    assert.match(accepted.stdout, /accepted todos\/add-todo/);

    const paths = baselinePaths(fixture.caseFile);
    assert.equal(
      fs.readFileSync(paths.traj, "utf8"),
      fs.readFileSync(path.join(fixture.recordDir, "trajectory.jsonl"), "utf8"),
    );
    assert.equal(JSON.parse(fs.readFileSync(paths.meta, "utf8")).run_id, "2026-06-10T0300-aa11");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- playtest export (one-way Playwright specs) ----

/** A suite with one web case (baseline present), one web case without a
 *  baseline, and one api case — the three outcomes export must distinguish. */
function makeExportFixture(root: LegacyTestValue) {
  const suite = path.join(root, "suite");
  fs.mkdirSync(path.join(suite, "results"), { recursive: true });
  fs.writeFileSync(path.join(suite, "playtest.yaml"), "app:\n  driver: web\n  base_url: http://127.0.0.1:4173\n");
  fs.writeFileSync(
    path.join(suite, "recorded.yaml"),
    'story: Add "buy milk".\nsuccess:\n  - element_exists: \'[data-testid="todo-item"]\'\n',
  );
  fs.writeFileSync(path.join(suite, "unrecorded.yaml"), "story: Never run yet.\n");
  fs.writeFileSync(
    path.join(suite, "over-http.yaml"),
    "app:\n  driver: api\n  base_url: http://127.0.0.1:1\nstory: Call the API.\n",
  );
  const envelope = {
    step: 1,
    schema_version: 7,
    mode: "agent",
    agent: { thought: "Type the todo.", action: { type: "type", ref: "e1", text: "buy milk" }, expectation: "it appears" },
    resolution: { ref: "e1", locator: '[data-testid="new-todo"]', bbox: {} },
    result: { ok: true, error: null, url: "http://127.0.0.1:4173/" },
  };
  fs.writeFileSync(path.join(suite, "results", "recorded.baseline.jsonl"), `${JSON.stringify(envelope)}\n`);
  fs.writeFileSync(
    path.join(suite, "results", "recorded.baseline.json"),
    JSON.stringify({ run_id: "2026-06-10T0300-ab12", accepted_at: "2026-06-10T03:04:05.000Z" }),
  );
  return suite;
}

test("export writes a spec per recorded web case and explains every skip", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-cli-export-"));
  try {
    const suite = makeExportFixture(root);
    const out = path.join(root, "specs");
    const result = runCli(["export", suite, "--out", out]);
    assert.equal(result.status, 0, output(result));

    const spec = path.join(out, "recorded.spec.ts");
    assert.ok(fs.existsSync(spec), `no spec written${output(result)}`);
    const code = fs.readFileSync(spec, "utf8");
    assert.match(code, /GENERATED by `playtest export`/);
    assert.match(code, /ONE-WAY snapshot/);
    assert.match(code, /await page\.locator\("\[data-testid=\\"new-todo\\"\]"\)\.fill\("buy milk"\);/);
    assert.match(code, /await expect\(page\.locator\("\[data-testid=\\"todo-item\\"\]"\)\)\.not\.toHaveCount\(0\);/);

    // A case that has never run, and a non-web case, are skipped with a reason —
    // never a silent omission and never a hard failure of the whole command.
    assert.match(result.stdout, /skipped unrecorded: no saved path yet/);
    assert.match(result.stdout, /skipped over-http: export supports web cases; this one uses driver "api"/);
    assert.ok(!fs.existsSync(path.join(out, "unrecorded.spec.ts")));
    assert.ok(!fs.existsSync(path.join(out, "over-http.spec.ts")));
    assert.match(result.stdout, /Playtest never reads them back and will not heal them/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("export re-runs overwrite in place, and warn when a changed journey is pending", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-cli-export-again-"));
  try {
    const suite = makeExportFixture(root);
    const out = path.join(root, "specs");
    runCli(["export", suite, "--out", out]);
    const first = fs.readFileSync(path.join(out, "recorded.spec.ts"), "utf8");

    // A pending candidate does NOT block the export (the accepted baseline is
    // still the truth) but must be called out.
    fs.writeFileSync(path.join(suite, "results", "recorded.healed.jsonl"), "{}\n");
    const second = runCli(["export", suite, "--out", out]);
    assert.equal(second.status, 0, output(second));
    assert.match(second.stdout, /a changed journey is pending review — this spec is the ACCEPTED path/);
    assert.equal(fs.readFileSync(path.join(out, "recorded.spec.ts"), "utf8"), first, "export is not stable across runs");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("export bakes --base-url into the generated spec", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-cli-export-baseurl-"));
  try {
    const suite = makeExportFixture(root);
    const out = path.join(root, "specs");
    const result = runCli(["export", suite, "--out", out, "--base-url", "https://staging.example.com"]);
    assert.equal(result.status, 0, output(result));
    assert.match(
      fs.readFileSync(path.join(out, "recorded.spec.ts"), "utf8"),
      /const BASE_URL = process\.env\.PLAYTEST_BASE_URL \?\? "https:\/\/staging\.example\.com";/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
