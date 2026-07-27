// `playtest findings …` — the local ledger CLI surface (BUILD_PLAN P5 item 4,
// contract: docs/contracts/interfaces.md#local-findings-ledger).
//
// Hermetic: every command runs offline against temp directories, with no model
// configured, so `consolidate` exercises exactly the deterministic path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI, REPO_ROOT as ROOT } from "./support.ts";

import { makeRun, makeSuite, snapshotTree } from "../../../tests/support/findings-fixtures.ts";

function runCli(args: LegacyTestValue, { cwd = ROOT } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.error, undefined, result.error?.message as string); // SAFETY: message is read only when spawn reports an Error
  return result;
}

const output = (r: LegacyTestValue) => `\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
const json = (r: LegacyTestValue) => JSON.parse(r.stdout);

function fixture(name: LegacyTestValue) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `playtest-cli-${name}-`));
  return { root, ...makeSuite(root) };
}

test("findings consolidate takes recorded candidates into the ledger and only proposes groupings", () => {
  const { root, suite, runs } = fixture("findings-consolidate");
  try {
    makeRun(runs, { runId: "2026-07-21T0900-aa11" });
    const before = snapshotTree(runs);

    const first = runCli(["findings", "consolidate", "--suite", suite, "--runs-root", runs, "--json"]);
    assert.equal(first.status, 0, output(first));
    const summary = json(first);
    assert.equal(summary.ledger, path.join(suite, ".playtest", "findings.db"));
    assert.equal(summary.intake.scanned, 1);
    assert.equal(summary.intake.actions.unassigned, 1);
    assert.equal(summary.model, null, "no model configured");
    assert.equal(summary.stats.model_calls, 0);
    assert.equal(summary.proposals, 1);
    assert.equal(summary.applied, null, "a plan is never applied without confirmation");
    assert.ok(fs.existsSync(summary.plan_file));

    // Nothing was grouped: the candidate is still awaiting a decision.
    const listed = runCli(["findings", "list", "--suite", suite, "--candidates", "--json"]);
    assert.equal(listed.status, 0, output(listed));
    assert.equal(json(listed).length, 1);
    assert.equal(runCli(["findings", "list", "--suite", suite, "--json"]).stdout.trim(), "[]");

    // Applying the written plan is an explicit second command.
    const applied = runCli(["findings", "consolidate", "--suite", suite, "--apply-plan", summary.plan_file, "--json"]);
    assert.equal(applied.status, 0, output(applied));
    assert.equal(json(applied).count, 1);
    assert.equal(json(runCli(["findings", "list", "--suite", suite, "--json"])).length, 1);

    assert.deepEqual([...snapshotTree(runs).entries()], [...before.entries()], "run artifacts must never be rewritten");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("two separate processes deduplicate one recurring defect into one local finding", () => {
  const { root, suite, runs } = fixture("findings-processes");
  try {
    makeRun(runs, { runId: "2026-07-21T0900-aa11" });
    const first = runCli(["findings", "consolidate", "--suite", suite, "--runs-root", runs, "--json"]);
    assert.equal(first.status, 0, output(first));
    const candidates = json(runCli(["findings", "list", "--suite", suite, "--candidates", "--json"]));
    assert.equal(candidates.length, 1);
    const accepted = runCli(["findings", "accept", candidates[0].id, "--suite", suite, "--json"]);
    assert.equal(accepted.status, 0, output(accepted));
    const findingId = json(accepted).finding.id;

    // A second Playtest process, a second run of the same defect surface.
    makeRun(runs, { runId: "2026-07-22T0900-bb22", startedAt: "2026-07-22T09:00:00.000Z" });
    const second = runCli(["findings", "consolidate", "--suite", suite, "--runs-root", runs, "--json"]);
    assert.equal(second.status, 0, output(second));
    assert.equal(json(second).intake.actions.appended, 1, "the recurrence appended, with no model call");

    const findings = json(runCli(["findings", "list", "--suite", suite, "--json"]));
    assert.equal(findings.length, 1, "two processes, two runs, ONE finding");
    assert.equal(findings[0].id, findingId);
    assert.equal(findings[0].evidence_count, 2);

    const shown = json(runCli(["findings", "show", findingId, "--suite", suite, "--json"]));
    assert.deepEqual(shown.evidence.map((e: LegacyTestValue) => e.run_id).sort(), ["2026-07-21T0900-aa11", "2026-07-22T0900-bb22"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("accept, reject, and resolve move the lifecycle and print machine-readable results", () => {
  const { root, suite, runs } = fixture("findings-lifecycle");
  try {
    makeRun(runs, { runId: "2026-07-21T0900-aa11" });
    makeRun(runs, { runId: "2026-07-21T1000-bb22", caseId: "cart/checkout", defect: "http_500_other_route" });
    runCli(["findings", "consolidate", "--suite", suite, "--runs-root", runs, "--json"]);
    const [a, b] = json(runCli(["findings", "list", "--suite", suite, "--candidates", "--json"]))
      .sort((x: LegacyTestValue, y: LegacyTestValue) => x.id.localeCompare(y.id));

    const accepted = runCli(["findings", "accept", a.id, "--suite", suite, "--json"]);
    assert.equal(accepted.status, 0, output(accepted));
    assert.equal(json(accepted).finding.state, "accepted");

    const resolved = runCli(["findings", "resolve", json(accepted).finding.id, "--suite", suite, "--json"]);
    assert.equal(resolved.status, 0, output(resolved));
    assert.equal(json(resolved).finding.state, "resolved");

    const rejected = runCli(["findings", "reject", b.id, "--suite", suite, "--reason", "not_a_bug", "--json"]);
    assert.equal(rejected.status, 0, output(rejected));
    assert.equal(json(rejected).candidate.status, "dismissed");
    assert.equal(json(rejected).suppressed, 2);

    // Human output stays readable and names the durable consequence.
    const human = runCli(["findings", "show", a.id, "--suite", suite]);
    assert.equal(human.status, 0, output(human));
    assert.match(human.stdout, /bug candidate .* \[assigned\]/);
    const list = runCli(["findings", "list", "--suite", suite]);
    assert.match(list.stdout, /^ID\s+STATE\s+SEVERITY\s+EVIDENCE\s+TITLE/m);
    assert.match(list.stdout, /resolved/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findings export writes portable JSON and never the database file", () => {
  const { root, suite, runs } = fixture("findings-export");
  try {
    makeRun(runs, { runId: "2026-07-21T0900-aa11" });
    runCli(["findings", "consolidate", "--suite", suite, "--runs-root", runs, "--json"]);
    const target = path.join(root, "out", "findings.json");
    const exported = runCli(["findings", "export", "--suite", suite, "--out", target, "--json"]);
    assert.equal(exported.status, 0, output(exported));
    assert.equal(json(exported).written, target);

    const doc = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(doc.format, "playtest.findings.export");
    assert.equal(doc.format_version, 1);
    assert.match(doc.key_scope.note, /NOT transferable/);
    assert.equal(doc.candidates.length, 1);
    assert.equal(doc.candidates[0].evidence[0].run_id, "2026-07-21T0900-aa11");

    // stdout form is the same document.
    const stdout = runCli(["findings", "export", "--suite", suite]);
    assert.equal(stdout.status, 0, output(stdout));
    assert.equal(JSON.parse(stdout.stdout).format, "playtest.findings.export");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("user-input failures exit 2 with an actionable message and no stack", () => {
  const { root, suite, runs } = fixture("findings-errors");
  try {
    // No ledger yet: reading commands say how one is created.
    const noLedger = runCli(["findings", "list", "--suite", suite, "--json"]);
    assert.equal(noLedger.status, 2, output(noLedger));
    assert.match(noLedger.stderr, /no findings ledger yet/);
    assert.match(noLedger.stderr, /playtest findings consolidate/);
    assert.doesNotMatch(noLedger.stderr, /at .*\.js:\d+|MODULE_NOT_FOUND/);

    // No suite at all.
    const noSuite = runCli(["findings", "list", "--suite", path.join(root, "nope"), "--json"]);
    assert.equal(noSuite.status, 2, output(noSuite));
    assert.match(noSuite.stderr, /--suite must be a directory/);

    makeRun(runs, { runId: "2026-07-21T0900-aa11" });
    runCli(["findings", "consolidate", "--suite", suite, "--runs-root", runs, "--json"]);

    const unknown = runCli(["findings", "show", "01NOSUCHID", "--suite", suite, "--json"]);
    assert.equal(unknown.status, 2, output(unknown));
    assert.match(unknown.stderr, /no finding or bug candidate 01NOSUCHID/);

    const badReason = runCli(["findings", "reject", "01NOSUCHID", "--suite", suite, "--reason", "nonsense"]);
    assert.equal(badReason.status, 2, output(badReason));

    const missingRuns = runCli(["findings", "consolidate", "--suite", suite, "--runs-root", path.join(root, "gone")]);
    assert.equal(missingRuns.status, 2, output(missingRuns));
    assert.match(missingRuns.stderr, /no runs directory at/);

    // A plan from a foreign workspace is refused rather than partially applied.
    const plan = path.join(root, "foreign-plan.json");
    fs.writeFileSync(plan, JSON.stringify({
      format: "playtest.findings.plan",
      format_version: 1,
      workspace_id: "someone-else",
      proposals: [],
    }));
    const foreign = runCli(["findings", "consolidate", "--suite", suite, "--apply-plan", plan]);
    assert.equal(foreign.status, 2, output(foreign));
    assert.match(foreign.stderr, /belongs to another workspace/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findings appears in help with its lifecycle subcommands", () => {
  const top = runCli(["--help"]);
  assert.match(top.stdout, /^ {2}findings(?: |$)/m);
  const help = runCli(["findings", "--help"]);
  assert.equal(help.status, 0, output(help));
  for (const command of ["list", "show", "consolidate", "accept", "reject", "resolve", "export"]) {
    assert.match(help.stdout, new RegExp(`^ {2}${command}(?: |$)`, "m"));
  }
  const consolidate = runCli(["findings", "consolidate", "--help"]);
  assert.match(consolidate.stdout, /--apply-plan/);
});
