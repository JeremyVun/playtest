// P0 evaluation + terminology freeze for findings intake and semantic
// consolidation (see tests/core/findings/README.md).
//
// Vocabulary frozen here and used throughout: ACTOR RAISE (a step's raises[]),
// GRADER FINDING (a grade.json findings[] entry), BUG CANDIDATE (a typed cited
// claim the app malfunctioned, D3), PLATFORM FINDING (a durable cross-run
// defect). These tests exercise the offline evaluator and the frozen spec
// functions against the fixture corpus — no browser, no model, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

import {
  normalizeText,
  normalizeLocus,
  strictKey,
  looseKey,
  keyMatch,
  matchText,
  idfTable,
  shortlist,
  similarity,
  route,
  clusters,
  RETRIEVAL,
  VERSIONS,
} from "../../core/findings/spec.ts";
import { FIXTURES, allCandidates, candidateById, PROJECT } from "../../core/findings/corpus.ts";
import { runEvaluation, checkExpectations } from "../../core/findings/evaluator.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const gradeSchema = JSON.parse(fs.readFileSync(path.join(ROOT, "src/core/schemas/grade.schema.json"), "utf8"));
const stepSchema = JSON.parse(fs.readFileSync(path.join(ROOT, "src/core/schemas/step.schema.json"), "utf8"));

// The seven-term category vocabulary is fixed by docs/contracts/hosted.md.
const D3_CATEGORIES = new Set([
  "http_error", "console_exception", "expectation_violation", "data_mismatch",
  "no_effect", "perf_regression", "broken_navigation",
]);

const byId = (id: string): LegacyTestValue => FIXTURES.find((f) => f.id === id);

// ---------------------------------------------------------------------------
// The headline P0 gate: computed behavior matches every recorded expectation.
// ---------------------------------------------------------------------------

test("evaluator: no discrepancies between computed behavior and recorded expectations", () => {
  const discrepancies = checkExpectations();
  assert.deepEqual(discrepancies, [], discrepancies.join("\n"));
});

test("evaluator is deterministic (no model, stable output)", () => {
  const a = JSON.stringify(runEvaluation());
  const b = JSON.stringify(runEvaluation());
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// Corpus coverage: the twelve required cases and the five required classes.
// ---------------------------------------------------------------------------

test("corpus contains all twelve P0 cases", () => {
  const ids = FIXTURES.map((f) => f.id);
  assert.equal(ids.length, 12);
  assert.equal(new Set(ids).size, 12, "fixture ids are unique");
  for (const id of [
    "exact-recurrence-noisy-ids", "reworded-personas-duplicate", "cross-category-duplicate",
    "loose-key-two-stories", "same-category-distinct-defects", "expectation-vs-observed",
    "label-control-contradiction", "actor-claim-contradicted", "required-affordance-vs-ux-wish",
    "intended-404-not-a-bug", "ux-friction-stays-grader-finding", "insufficient-evidence-unresolved",
  ]) {
    assert.ok(ids.includes(id), `missing fixture ${id}`);
  }
});

test("corpus spans positive, duplicate, distinct, UX-only, and false-positive cases", () => {
  const cls = (f: LegacyTestValue) => Object.values(f.expected.per_candidate || {}).map((v: LegacyTestValue) => v.classification);
  // positive (seeded defect ⇒ bug candidate)
  assert.ok(byId("expectation-vs-observed").seeded && cls(byId("expectation-vs-observed")).includes("bug_candidate"));
  // duplicate (grouped into one finding)
  assert.deepEqual(byId("reworded-personas-duplicate").expected.grouping, [["f2-adversarial", "f2-careful"]]);
  // distinct (same category, separate findings)
  assert.equal(byId("same-category-distinct-defects").expected.grouping.length, 2);
  // UX-only (grader finding, no candidate)
  assert.equal(byId("ux-friction-stays-grader-finding").candidates.length, 0);
  assert.equal(byId("ux-friction-stays-grader-finding").expected.ux_only.classification, "grader_finding");
  // false-positive (intended behavior rejected on review)
  assert.equal(byId("intended-404-not-a-bug").expected.per_candidate["f10-404"].classification, "not_a_bug");
});

// ---------------------------------------------------------------------------
// Faithful artifact shapes: fixtures validate against the real schemas.
// ---------------------------------------------------------------------------

test("every fixture grade.json validates against the real grade.schema.json", () => {
  // @ts-expect-error -- Ajv's NodeNext declaration exposes the runtime default constructor incompatibly
  const validate = new Ajv({ allErrors: true }).compile(gradeSchema);
  for (const f of FIXTURES) {
    for (const run of f.runs) {
      // model/graded_at/tokens/a11y are harness-added AFTER validation
      // (docs/contracts/engine.md#grading); validate the model-authored subset.
      const { model, graded_at, tokens, a11y, ...authored } = run.grade;
      assert.ok(validate(authored), `${f.id}/${run.run_id}: ${JSON.stringify(validate.errors)}`);
    }
  }
});

test("every agent step validates against the real step.schema.json", () => {
  // @ts-expect-error -- Ajv's NodeNext declaration exposes the runtime default constructor incompatibly
  const validate = new Ajv({ allErrors: true }).compile(stepSchema);
  let steps = 0;
  for (const f of FIXTURES) {
    for (const run of f.runs) {
      run.envelopes.forEach((e, i) => {
        assert.equal(e.step, i + 1, `${f.id}: steps are 1-based and sequential`);
        assert.equal(e.schema_version, 7);
        if (e.agent) {
          assert.ok(validate(e.agent), `${f.id} step ${e.step}: ${JSON.stringify(validate.errors)}`);
          steps += 1;
        }
      });
    }
  }
  assert.ok(steps > 0);
});

test("fixtures carry run-specific ids/numbers/timestamps so normalization is exercised", () => {
  const f1 = byId("exact-recurrence-noisy-ids");
  // Two runs use different DELETE item ids and different timestamps.
  const [a, b] = f1.candidates;
  assert.notEqual(a.locus.route, b.locus.route, "raw loci differ by run-specific id");
  assert.notEqual(a.run_id, b.run_id);
  // Envelope timestamps are real epoch-ms and monotonic within a run.
  for (const run of f1.runs) {
    for (let i = 1; i < run.envelopes.length; i += 1) {
      assert.ok(run.envelopes[i].ts > run.envelopes[i - 1].ts);
    }
  }
});

// ---------------------------------------------------------------------------
// Category vocabulary + terminology.
// ---------------------------------------------------------------------------

test("every bug candidate uses a D3 category and cites recorded evidence steps", () => {
  for (const c of allCandidates()) {
    assert.ok(D3_CATEGORIES.has(c.kind), `${c.id} kind ${c.kind} not in D3 vocabulary`);
    assert.ok(Array.isArray(c.evidence_steps) && c.evidence_steps.length > 0, `${c.id} cites evidence`);
    assert.ok(c.expected && c.observed, `${c.id} states expected + observed behavior`);
  }
});

test("grader findings keep the run-local grade.json shape (not durable identity)", () => {
  for (const f of FIXTURES) {
    for (const run of f.runs) {
      for (const finding of run.grade.findings) {
        assert.ok(["info", "minor", "major"].includes(finding.severity));
        assert.equal(typeof finding.note, "string");
        assert.ok(!("id" in finding), "a grader finding never carries a durable id");
      }
    }
  }
});

// ---------------------------------------------------------------------------
// D4 — exact recurrence keys (deterministic).
// ---------------------------------------------------------------------------

test("D4: exact recurrence with noisy ids strict-matches after normalization", () => {
  const [existing, incoming] = byId("exact-recurrence-noisy-ids").candidates;
  assert.equal(normalizeLocus(existing.locus), normalizeLocus(incoming.locus));
  assert.equal(strictKey(existing), strictKey(incoming));
  assert.deepEqual(keyMatch(incoming, existing), { strict: true, loose: true });
});

test("D4: category never enters a key (cross-category duplicate still strict-matches)", () => {
  const [existing, incoming] = byId("cross-category-duplicate").candidates;
  assert.notEqual(existing.kind, incoming.kind, "the two runs label the defect differently");
  assert.equal(strictKey(existing), strictKey(incoming));
});

test("D4: same defect from a different story strict-misses but loose-matches", () => {
  const [existing, incoming] = byId("loose-key-two-stories").candidates;
  assert.notEqual(existing.story_id, incoming.story_id);
  assert.deepEqual(keyMatch(incoming, existing), { strict: false, loose: true });
});

test("D4: same category, different defect misses both keys", () => {
  const gift = candidateById("f5-giftcard");
  const pass = candidateById("f5-password");
  assert.deepEqual(keyMatch(pass, gift), { strict: false, loose: false });
});

test("D4: a candidate with no deterministic signal carries no exact keys", () => {
  const c = candidateById("f2-adversarial");
  assert.equal(c.signal_type, null);
  assert.equal(strictKey(c), null);
  assert.equal(looseKey(c), null);
});

// ---------------------------------------------------------------------------
// D5 — match text + rare-word shortlist + routing.
// ---------------------------------------------------------------------------

test("D5: match text strips run-specific ids, numbers, and timestamps", () => {
  const text = matchText(candidateById("f1-incoming"));
  assert.ok(!/\d/.test(text.replace(/<[a-z]+>/g, "")), `no bare digits remain: ${text}`);
  assert.equal(normalizeText("DELETE /api/cart/items/91307 500 at 2026-07-20T11:47Z").includes("91307"), false);
});

test("D5: reworded duplicate from two personas appears in each other's top-k", () => {
  const idf = idfTable(allCandidates());
  const pool = allCandidates().filter((c) => c.project_id === PROJECT);
  const adv = shortlist(candidateById("f2-adversarial"), pool, idf).map((n) => n.id);
  const car = shortlist(candidateById("f2-careful"), pool, idf).map((n) => n.id);
  assert.ok(adv.includes("f2-careful"), `got ${adv}`);
  assert.ok(car.includes("f2-adversarial"), `got ${car}`);
});

test("D5: distinct defects in the same category do not become neighbors", () => {
  const idf = idfTable(allCandidates());
  assert.ok(similarity(candidateById("f5-giftcard"), candidateById("f5-password"), idf) < RETRIEVAL.floor);
});

test("D5: routing sends strict hits to append, loose hits to suggestion, lonely candidates to new", () => {
  assert.equal(route(candidateById("f1-incoming"), { strictHit: true }), "append");
  assert.equal(route(candidateById("f4-incoming"), { looseHit: true }), "suggestion");
  assert.equal(route(candidateById("f5-giftcard"), { neighbors: [] }), "new");
  // Two connected unassigned candidates go to a cluster (one model call).
  const idf = idfTable(allCandidates());
  const pool = allCandidates().filter((c) => c.project_id === PROJECT);
  const neighbors = shortlist(candidateById("f2-adversarial"), pool, idf);
  assert.equal(route(candidateById("f2-adversarial"), { neighbors }), "cluster");
});

test("D5: a single strong existing-finding neighbor becomes a suggestion, not a cluster", () => {
  const strong = [{ id: "f_existing", role: "finding", score: 0.72 }];
  assert.equal(route(candidateById("f6-badge"), { neighbors: strong }), "suggestion");
});

test("D5: clusters are connected components — one defect cannot split across calls", () => {
  const comps = clusters(["a", "b", "c", "d"], [{ a: "a", b: "b" }, { a: "b", b: "c" }]);
  assert.equal(comps.length, 2);
  assert.deepEqual(comps.find((g) => g.includes("a")), ["a", "b", "c"]);
  assert.deepEqual(comps.find((g) => g.includes("d")), ["d"]);
});

// ---------------------------------------------------------------------------
// Actor claims are not evidence (docs/contracts/engine.md#grading).
// ---------------------------------------------------------------------------

test("an actor success claim contradicted by evidence is still a bug candidate", () => {
  const f = byId("actor-claim-contradicted");
  assert.equal(f.expected.actor_claim_is_evidence, false);
  assert.equal(f.expected.per_candidate["f8-nofire"].classification, "bug_candidate");
  const done = f.runs[0].envelopes.find((e: LegacyTestValue) => e.agent?.action.type === "done");
  assert.ok(done.agent.action.summary.includes("successfully"), "actor claimed success");
  assert.equal(done.confusion.type, "no_effect", "but the recorded evidence contradicts the claim");
});

// ---------------------------------------------------------------------------
// Baseline measures are defined and computed over the corpus.
// ---------------------------------------------------------------------------

test("baseline measures are computed with zero model calls and sane values", () => {
  const { metrics, cluster } = runEvaluation();
  assert.equal(metrics.candidate_recall, 1, "every seeded defect emits a candidate");
  assert.ok(metrics.precision_after_review < 1, "a false positive lowers precision below 1");
  assert.ok(metrics.exact_match_rate > 0 && metrics.exact_match_rate < 1);
  assert.equal(metrics.shortlist_recall, 1, "true duplicates present in top-k");
  assert.ok(metrics.evidence_rows_retained >= FIXTURES.length);
  // Consolidation clusters cost strictly fewer model calls than per-candidate.
  assert.ok(cluster.model_calls >= 1);
  assert.ok(cluster.per_candidate_calls_avoided >= 1);
  assert.ok(cluster.input_tokens > 0);
});

// ---------------------------------------------------------------------------
// Algorithm versions are recorded so a later bump can recompute keys (D4).
// ---------------------------------------------------------------------------

test("normalization and key algorithm versions are pinned", () => {
  for (const v of Object.values(VERSIONS)) assert.match(v, /-v\d+$/);
});
