// The local findings ledger: schema, dedupe, lifecycle, tombstones, durability,
// and failure behavior (BUILD_PLAN P5 exit gate).
//
// Hermetic: node:sqlite in a temp directory, no model, no network, no browser.
// node:sqlite is available because the test Node is the repo's dev/CI Node; the
// ledger itself refuses older runtimes at the door with an actionable error
// (`sqliteSupported`), which is asserted here as a pure function so the suite
// stays zero-skipped on every supported Node.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acceptItem,
  applyPlan,
  buildPlan,
  exportLedger,
  intakeRunCandidates,
  ledgerPath,
  listCandidates,
  listFindings,
  mergeFindings,
  openLedger,
  rejectItem,
  resolveItem,
  showItem,
  sqliteSupported,
  validateClusterPlan,
} from "../../../src/core/public/findings.ts";
import { DummyConfigError } from "../../../src/core/config.ts";
import { makeRun, makeSuite, snapshotTree } from "../../support/findings-fixtures.ts";

function tmp(name: LegacyTestValue) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `playtest-${name}-`));
}

async function withFixture(name: LegacyTestValue, fn: LegacyTestValue) {
  const root = tmp(name);
  try {
    return await fn(makeSuite(root), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const onlyCandidate = (ledger: LegacyTestValue) => listCandidates(ledger)[0];

test("a fresh ledger is created beside the suite, gitignored, and never inside runs/", async () => {
  await withFixture("ledger-create", async ({ suite, runs }: LegacyTestValue) => {
    makeRun(runs, { runId: "2026-07-21T0900-aa11" });
    const ledger = await openLedger({ suite });
    try {
      assert.equal(ledger.file, path.join(suite, ".playtest", "findings.db"));
      assert.equal(ledger.file, ledgerPath(suite));
      assert.ok(fs.existsSync(ledger.file));
      assert.match(fs.readFileSync(path.join(suite, ".playtest", ".gitignore"), "utf8"), /^\*$/m);
      assert.match(ledger.workspaceId, /^[0-9A-HJKMNP-TV-Z]{26}$/, "workspace id is an opaque ulid");
      // Identity only: no artifact bytes, and nothing written under runs/.
      assert.deepEqual(fs.readdirSync(runs), ["2026-07-21T0900-aa11"]);
      const tables = ledger.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
      assert.deepEqual(tables.filter((t) => !t.startsWith("sqlite_")), [
        "bug_candidate_evidence",
        "bug_candidate_suppressions",
        "bug_candidates",
        "finding_evidence",
        "finding_merges",
        "finding_transitions",
        "findings",
        "ledger_meta",
      ]);
    } finally {
      ledger.close();
    }

    // Reopening is a no-op migration and keeps the same workspace identity.
    const again = await openLedger({ suite });
    try {
      assert.equal(again.get("PRAGMA user_version").user_version, 1);
    } finally {
      again.close();
    }
  });
});

test("a corrupt or newer ledger fails with an actionable error and never touches run artifacts", async () => {
  await withFixture("ledger-corrupt", async ({ suite, runs }: LegacyTestValue) => {
    makeRun(runs, { runId: "2026-07-21T0900-aa11" });
    const before = snapshotTree(runs);

    const file = ledgerPath(suite);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "this is not a database, it is a text file\n".repeat(64));
    const corrupt = await openLedger({ suite }).then(() => null, (e) => e);
    assert.ok(corrupt instanceof DummyConfigError, `expected a DummyConfigError, got ${corrupt}`);
    assert.match(corrupt.message, /cannot open the local findings ledger/);
    assert.match(corrupt.message, /run artifacts are stored in runs\/ and are untouched/);
    assert.match(corrupt.message, new RegExp(`mv ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `));
    assert.doesNotMatch(corrupt.message, /at .*\.js:\d+/, "no raw stack");

    // A ledger from a newer Playtest is refused, not silently downgraded.
    fs.rmSync(file);
    const fresh = await openLedger({ suite });
    fresh.db.exec("PRAGMA user_version = 99");
    fresh.close();
    const newer = await openLedger({ suite }).then(() => null, (e) => e);
    assert.ok(newer instanceof DummyConfigError);
    assert.match(newer.message, /written by a newer Playtest/);

    assert.deepEqual([...snapshotTree(runs).entries()], [...before.entries()], "run artifacts were modified");
  });
});

test("two sequential ledger sessions deduplicate one recurring defect into one record", async () => {
  await withFixture("ledger-dedupe", async ({ suite, runs }: LegacyTestValue) => {
    // Two runs of the same story hitting the same endpoint, with different
    // run-specific ids in the URL — the normalization case.
    makeRun(runs, { runId: "2026-07-21T0900-aa11" });
    const first = await openLedger({ suite });
    const a = intakeRunCandidates(first, runs);
    assert.equal(a.actions.unassigned, 1);
    const candidateId = onlyCandidate(first).id;
    first.close();

    makeRun(runs, { runId: "2026-07-22T0900-bb22", startedAt: "2026-07-22T09:00:00.000Z" });
    const second = await openLedger({ suite });
    try {
      const b = intakeRunCandidates(second, runs);
      assert.equal(b.actions.deduped, 1, "the recurrence hit the strict key");
      assert.equal(b.actions.idempotent, 1, "re-scanning the first run added nothing");
      const rows = listCandidates(second);
      assert.equal(rows.length, 1, "one defect, one candidate");
      assert.equal(rows[0].id, candidateId, "the opaque id survived the restart");
      assert.equal(rows[0].evidence_count, 2, "both runs are cited");
      const shown = showItem(second, candidateId);
      assert.deepEqual(shown.evidence.map((e: LegacyTestValue) => e.run_id).sort(), [
        "2026-07-21T0900-aa11",
        "2026-07-22T0900-bb22",
      ]);
      // Evidence is a reference, never bytes.
      for (const e of shown.evidence) {
        assert.ok(fs.existsSync(path.join(e.run_dir, "grade.json")));
        assert.equal(e.excerpt.includes("500"), true);
      }
    } finally {
      second.close();
    }
  });
});

test("a distinct defect on another surface stays a separate candidate", async () => {
  await withFixture("ledger-distinct", async ({ suite, runs }: LegacyTestValue) => {
    makeRun(runs, { runId: "2026-07-21T0900-aa11" });
    makeRun(runs, { runId: "2026-07-21T1000-bb22", caseId: "cart/checkout", defect: "http_500_other_route" });
    const ledger = await openLedger({ suite });
    try {
      intakeRunCandidates(ledger, runs);
      assert.equal(listCandidates(ledger).length, 2, "same category, different surfaces");
    } finally {
      ledger.close();
    }
  });
});

test("lifecycle, transitions, and evidence survive a restart; a resolved finding reopens on recurrence", async () => {
  await withFixture("ledger-lifecycle", async ({ suite, runs }: LegacyTestValue) => {
    makeRun(runs, { runId: "2026-07-21T0900-aa11" });
    let ledger = await openLedger({ suite });
    intakeRunCandidates(ledger, runs);
    const candidateId = onlyCandidate(ledger).id;
    const accepted = acceptItem(ledger, { id: candidateId });
    const findingId = accepted.finding.id;
    assert.equal(accepted.finding.state, "accepted");
    assert.equal(accepted.evidence_added, 1);
    ledger.close();

    // Restart: state, evidence, and history are all still there.
    ledger = await openLedger({ suite });
    let shown = showItem(ledger, findingId);
    assert.equal(shown.state, "accepted");
    assert.equal(shown.evidence.length, 1);
    assert.deepEqual(shown.transitions.map((t: LegacyTestValue) => t.to_state), ["accepted"]);
    assert.deepEqual(shown.candidates, [candidateId]);

    resolveItem(ledger, { id: findingId, note: "fixed in the cart service" });
    assert.equal(showItem(ledger, findingId).state, "resolved");
    ledger.close();

    // A recurrence in a new run reopens the resolved finding, with no review.
    makeRun(runs, { runId: "2026-07-23T0900-cc33", startedAt: "2026-07-23T09:00:00.000Z" });
    ledger = await openLedger({ suite });
    try {
      const result = intakeRunCandidates(ledger, runs);
      assert.equal(result.actions.appended, 1);
      shown = showItem(ledger, findingId);
      assert.equal(shown.state, "reopened");
      assert.equal(shown.evidence.length, 2);
      assert.deepEqual(shown.transitions.map((t: LegacyTestValue) => t.to_state), ["accepted", "resolved", "reopened"]);
      assert.equal(shown.transitions.at(-1).reason, "recurrence");
    } finally {
      ledger.close();
    }
  });
});

test("rejecting a candidate suppresses its exact recurrences instead of re-queuing them", async () => {
  await withFixture("ledger-reject", async ({ suite, runs }: LegacyTestValue) => {
    makeRun(runs, { runId: "2026-07-21T0900-aa11" });
    let ledger = await openLedger({ suite });
    intakeRunCandidates(ledger, runs);
    const candidateId = onlyCandidate(ledger).id;
    const rejected = rejectItem(ledger, { id: candidateId, reason: "not_a_bug" });
    assert.equal(rejected.candidate.status, "dismissed");
    assert.equal(rejected.suppressed, 2, "strict and loose keys are both recorded");
    ledger.close();

    makeRun(runs, { runId: "2026-07-24T0900-dd44", startedAt: "2026-07-24T09:00:00.000Z" });
    ledger = await openLedger({ suite });
    try {
      const result = intakeRunCandidates(ledger, runs);
      assert.equal(result.actions.auto_dismissed, 1);
      assert.equal(listCandidates(ledger, { status: "unassigned" }).length, 0, "the queue stays clean");
      const dismissed = listCandidates(ledger, { status: "dismissed" });
      assert.equal(dismissed.length, 1);
      assert.equal(dismissed[0].recurrence_count, 1, "absorbed recurrences are counted, not hidden");
      assert.equal(dismissed[0].evidence_count, 2, "the evidence is still preserved");
    } finally {
      ledger.close();
    }
  });
});

test("a rejected finding absorbs matching evidence silently and stays out of the queue", async () => {
  await withFixture("ledger-rejected-finding", async ({ suite, runs }: LegacyTestValue) => {
    makeRun(runs, { runId: "2026-07-21T0900-aa11" });
    const ledger = await openLedger({ suite });
    try {
      intakeRunCandidates(ledger, runs);
      const { finding } = acceptItem(ledger, { id: onlyCandidate(ledger).id });
      rejectItem(ledger, { id: finding.id, reason: "wont_fix" });
      makeRun(runs, { runId: "2026-07-25T0900-ee55", startedAt: "2026-07-25T09:00:00.000Z" });
      intakeRunCandidates(ledger, runs);
      const shown = showItem(ledger, finding.id);
      assert.equal(shown.state, "rejected");
      assert.equal(shown.reject_reason, "wont_fix");
      assert.equal(shown.evidence.length, 2, "evidence is absorbed, not dropped");
      assert.equal(listFindings(ledger, { state: "new" }).length, 0);
    } finally {
      ledger.close();
    }
  });
});

test("merge tombstones redirect later evidence and survive a restart", async () => {
  await withFixture("ledger-merge", async ({ suite, runs }: LegacyTestValue) => {
    makeRun(runs, { runId: "2026-07-21T0900-aa11" });
    makeRun(runs, { runId: "2026-07-21T1000-bb22", caseId: "cart/checkout", defect: "http_500_other_route" });
    let ledger = await openLedger({ suite });
    intakeRunCandidates(ledger, runs);
    const [c1, c2] = listCandidates(ledger).sort((a, b) => a.id.localeCompare(b.id));
    const f1 = acceptItem(ledger, { id: c1.id }).finding.id;
    const f2 = acceptItem(ledger, { id: c2.id }).finding.id;
    const merged = mergeFindings(ledger, { fromId: f2, intoId: f1 });
    assert.equal(merged.from.merged_into, f1);
    assert.equal(merged.into.evidence_count, 2, "evidence follows the merge");
    ledger.close();

    ledger = await openLedger({ suite });
    try {
      const live = listFindings(ledger);
      assert.deepEqual(live.map((f) => f.id), [f1], "a merged finding leaves the active list");
      assert.deepEqual(showItem(ledger, f1).merged_from, [f2]);
      assert.equal(showItem(ledger, f2).merged_into, f1, "the tombstone is still readable");
      // Triaging the tombstone redirects instead of silently splitting state.
      const conflict = tryCatch(() => resolveItem(ledger, { id: f2 }));
      assert.ok(conflict instanceof DummyConfigError);
      assert.match(conflict.message, new RegExp(`was merged into ${f1}`));
    } finally {
      ledger.close();
    }
  });
});

test("consolidation with no model configured routes deterministically and mutates nothing unconfirmed", async () => {
  await withFixture("ledger-plan", async ({ suite, runs }: LegacyTestValue) => {
    makeRun(runs, { runId: "2026-07-21T0900-aa11" });
    makeRun(runs, { runId: "2026-07-21T1000-bb22", caseId: "cart/checkout", defect: "http_500_other_route" });
    const ledger = await openLedger({ suite });
    try {
      intakeRunCandidates(ledger, runs);
      const plan = await buildPlan(ledger); // no callModel: no model configured
      assert.equal(plan.model, null);
      assert.equal(plan.stats.model_calls, 0);
      assert.equal(plan.proposals.length, 2, "both unrelated candidates are proposed as new findings");
      assert.ok(plan.proposals.every((p: LegacyTestValue) => p.action === "new" && p.source === "score"));
      assert.equal(plan.algorithms.key_algo, "key-v1");

      // Building a plan writes nothing.
      assert.equal(listFindings(ledger).length, 0);
      assert.ok(listCandidates(ledger).every((c) => c.status === "unassigned"));

      // Applying is an explicit act, and it is transactional per proposal.
      const applied = applyPlan(ledger, plan, { only: [plan.proposals[0].id] });
      assert.equal(applied.count, 1);
      assert.equal(listFindings(ledger).length, 1);
      assert.equal(listCandidates(ledger, { status: "unassigned" }).length, 1);

      // The same plan is now stale for the applied proposal.
      const stale = tryCatch(() => applyPlan(ledger, plan));
      assert.ok(stale instanceof DummyConfigError);
      assert.match(stale.message, /is stale/);

      // A plan from another workspace never applies here.
      const foreign = tryCatch(() => applyPlan(ledger, { ...plan, workspace_id: "someone-else" }));
      assert.ok(foreign instanceof DummyConfigError);
      assert.match(foreign.message, /belongs to another workspace/);
    } finally {
      ledger.close();
    }
  });
});

test("the export is portable JSON of references, marks keys non-transferable, and never carries artifact bytes", async () => {
  await withFixture("ledger-export", async ({ suite, runs }: LegacyTestValue) => {
    makeRun(runs, { runId: "2026-07-21T0900-aa11" });
    const ledger = await openLedger({ suite });
    try {
      intakeRunCandidates(ledger, runs);
      acceptItem(ledger, { id: onlyCandidate(ledger).id });
      const doc = exportLedger(ledger);
      assert.equal(doc.format, "playtest.findings.export");
      assert.equal(doc.format_version, 1);
      assert.equal(doc.workspace.id, ledger.workspaceId);
      assert.deepEqual(doc.algorithms, {
        key_algo_version: "key-v1",
        locus_norm_version: "locus-norm-v1",
        match_text_version: "match-text-v1",
      });
      assert.match(doc.key_scope.note, /NOT transferable/);
      assert.match(doc.key_scope.note, /Never merge records by title/);
      assert.equal(doc.findings.length, 1);
      assert.equal(doc.findings[0].source_id, doc.findings[0].id, "opaque provenance travels with the record");
      assert.equal(doc.findings[0].evidence[0].run_id, "2026-07-21T0900-aa11");
      assert.equal(doc.candidates[0].signal_type, "http_error", "an importer recomputes keys from this");

      const serialized = JSON.stringify(doc);
      assert.ok(!serialized.includes("schema_version"), "no manifest/grade copies");
      assert.ok(!serialized.includes("\"trajectory\""), "no trajectory bytes");
      assert.ok(serialized.length < 20000, "an export is references, not artifacts");
    } finally {
      ledger.close();
    }
  });
});

test("model cluster output is validated against its own input before it can be proposed", () => {
  const ctx = { candidateIds: ["c1", "c2"], findingIds: ["f1"] };
  assert.equal(
    validateClusterPlan({ assignments: [{ candidate_ids: ["c1", "c2"], finding_id: "f1", confidence: "high", reason: "same defect" }] }, ctx),
    null,
  );
  const invalid: LegacyTestValue = [
    [{ assignments: [{ candidate_ids: ["c9"], finding_id: "f1", confidence: "high", reason: "x" }] }, /not in this cluster's input/],
    [{ assignments: [{ candidate_ids: ["c1"], finding_id: "f9", confidence: "high", reason: "x" }] }, /omit it to propose a new group/],
    [{ assignments: [{ candidate_ids: ["c1"], confidence: "high", reason: "x" }] }, /needs a non-empty "proposed_title"/],
    [{ assignments: [
      { candidate_ids: ["c1"], finding_id: "f1", confidence: "high", reason: "x" },
      { candidate_ids: ["c1"], finding_id: "f1", confidence: "high", reason: "y" },
    ] }, /more than one group/],
    [{ assignments: [{ candidate_ids: ["c1"], finding_id: "f1", confidence: "low", reason: "x" }] }, /must be high or medium/],
  ];
  for (const [args, pattern] of invalid) assert.match(validateClusterPlan(args, ctx) ?? "", pattern);
});

test("the Node floor for node:sqlite is enforced as a pure predicate", () => {
  assert.equal(sqliteSupported("20.11.0"), false);
  assert.equal(sqliteSupported("22.4.9"), false);
  assert.equal(sqliteSupported("22.5.0"), true);
  assert.equal(sqliteSupported("24.0.1"), true);
  assert.equal(sqliteSupported(process.versions.node), true, "the test runtime can run the ledger");
});

function tryCatch(fn: LegacyTestValue) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}
