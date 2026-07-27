// OFFLINE, MODEL-FREE EVALUATOR for the P0 findings corpus.
//
// Runs the frozen spec functions (./spec.ts) over the fixture corpus
// (./corpus.ts) and its recorded expected data, and reports the P0 baseline
// measures recorded in tests/core/findings/README.md:
//
//   - candidate recall on seeded defects
//   - precision after human review
//   - exact-match rate
//   - shortlist recall (true duplicates present in top-k neighbors)
//   - cluster model calls / input tokens / candidates per call
//   - evidence rows retained after promotion
//
// It makes ZERO model calls. `checkExpectations()` returns the list of
// mismatches between computed behavior and the recorded expected outcomes; an
// empty list is the P0 green condition. Run directly to print the report:
//
//   node tests/core/findings/evaluator.ts
import {
  RETRIEVAL,
  keyMatch,
  strictKey,
  looseKey,
  hasExactKeys,
  idfTable,
  shortlist,
  similarity,
  route,
  clusters,
  estimateTokens,
} from "./spec.ts";
import { FIXTURES, allCandidates } from "./corpus.ts";
import type { CorpusCandidate, CorpusFixture } from "./corpus.ts";

const REJECT = (label: unknown) => typeof label === "string" && label.startsWith("reject");

function pool() {
  return allCandidates().map((c) => ({ ...c, role: c.role ?? "candidate" }));
}

function findingsInProject(projectId: string) {
  return pool().filter((c) => c.role === "finding" && c.project_id === projectId);
}

/** Compute strict/loose hits for an incoming candidate against prior findings. */
function exactHits(candidate: CorpusCandidate) {
  if (!hasExactKeys(candidate)) return { strict: false, loose: false };
  const sk = strictKey(candidate);
  const lk = looseKey(candidate);
  let strict = false;
  let loose = false;
  for (const f of findingsInProject(candidate.project_id)) {
    if (!hasExactKeys(f)) continue;
    if (strictKey(f) === sk) strict = true;
    if (looseKey(f) === lk) loose = true;
  }
  return { strict, loose };
}

/** Neighbors of a candidate across the whole project pool. */
function neighborsOf(candidate: CorpusCandidate, idf: Map<string, number>) {
  const others = pool().filter((c) => c.project_id === candidate.project_id);
  return shortlist(candidate, others, idf);
}

function computedRoute(candidate: CorpusCandidate, idf: Map<string, number>) {
  const { strict, loose } = exactHits(candidate);
  const neighbors = neighborsOf(candidate, idf);
  return route(candidate, { strictHit: strict, looseHit: loose && !strict, neighbors });
}

export function runEvaluation() {
  const idf = idfTable(pool());
  const discrepancies: string[] = [];
  const note = (fixture: CorpusFixture["id"], msg: string) => discrepancies.push(`[${fixture}] ${msg}`);

  // ---- exact keys (D4) ----
  let exactChecked = 0;
  let exactStrict = 0;
  for (const f of FIXTURES) {
    const spec = f.expected.exact_key;
    if (!spec) continue;
    exactChecked += 1;
    const inc = f.candidates.find((c) => c.id === spec.incoming)!; // SAFETY: exact-key fixture ids name candidates in the same fixture
    const ex = f.candidates.find((c) => c.id === spec.existing)!; // SAFETY: exact-key fixture ids name candidates in the same fixture
    const got = keyMatch(inc, ex);
    if (got.strict !== spec.strict) note(f.id, `strict key: expected ${spec.strict}, got ${got.strict}`);
    if (got.loose !== spec.loose) note(f.id, `loose key: expected ${spec.loose}, got ${got.loose}`);
    if (spec.strict) exactStrict += 1;
  }

  // ---- shortlist recall (D5) ----
  let shortlistPairs = 0;
  let shortlistHits = 0;
  for (const f of FIXTURES) {
    for (const s of f.expected.shortlist || []) {
      const target = f.candidates.find((c) => c.id === s.of)!; // SAFETY: shortlist fixture ids name candidates in the same fixture
      const neighborIds = neighborsOf(target, idf).map((n) => n.id);
      for (const need of s.must_include || []) {
        shortlistPairs += 1;
        if (neighborIds.includes(need)) shortlistHits += 1;
        else note(f.id, `shortlist of ${s.of} should include ${need}; got [${neighborIds.join(", ")}]`);
      }
      for (const banned of s.must_exclude || []) {
        if (neighborIds.includes(banned)) note(f.id, `shortlist of ${s.of} should exclude ${banned}; got [${neighborIds.join(", ")}]`);
      }
    }
  }

  // ---- routing (D5 step 3) ----
  for (const f of FIXTURES) {
    for (const [id, want] of Object.entries(f.expected.routing || {})) {
      const cand = f.candidates.find((c) => c.id === id)!; // SAFETY: routing fixture ids name candidates in the same fixture
      const got = computedRoute(cand, idf);
      if (got !== want) note(f.id, `routing of ${id}: expected ${want}, got ${got}`);
    }
  }

  // ---- clustering + cost measures (D5) ----
  const clustered: CorpusCandidate[] = [];
  for (const f of FIXTURES) {
    for (const c of f.candidates) {
      if (computedRoute(c, idf) === "cluster") clustered.push(c);
    }
  }
  const clusteredIds = clustered.map((c) => c.id);
  const edges: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < clustered.length; i += 1) {
    for (let j = i + 1; j < clustered.length; j += 1) {
      if (similarity(clustered[i]!, clustered[j]!, idf) >= RETRIEVAL.floor) { // SAFETY: loop bounds prove both clustered candidates exist
        edges.push({ a: clustered[i]!.id, b: clustered[j]!.id }); // SAFETY: loop bounds prove both clustered candidates exist
      }
    }
  }
  const components = clusters(clusteredIds, edges);
  const compactClaim = (c: CorpusCandidate) => [c.title, c.expected, c.observed, c.story_id, c.locus?.route].filter(Boolean).join(" ");
  const clusterReport = components.map((ids) => ({
    candidate_ids: ids,
    size: ids.length,
    input_tokens: ids.reduce((sum, id) => sum + estimateTokens(compactClaim(allCandidates().find((c) => c.id === id)!)), 0), // SAFETY: cluster ids originate from the candidate corpus
  }));
  const modelCalls = clusterReport.length;
  const candidatesPerCall = clusterReport.map((c) => c.size);
  const totalClusterTokens = clusterReport.reduce((s, c) => s + c.input_tokens, 0);

  // ---- evidence preservation ----
  for (const f of FIXTURES) {
    const want = f.expected.evidence_rows;
    if (want == null) continue;
    // Evidence rows retained after promotion = one row per cited (run, step)
    // across the grouped candidates for this fixture.
    const groupedIds = new Set((f.expected.grouping || []).flat());
    const rows = f.candidates
      .filter((c) => groupedIds.has(c.id))
      .reduce((sum, c) => sum + (c.evidence_steps?.length || 0), 0);
    if (rows !== want) note(f.id, `evidence rows: expected ${want}, computed ${rows}`);
  }

  // ---- candidate recall + precision (over recorded classifications) ----
  const seeded = FIXTURES.filter((f) => f.seeded);
  const seededWithCandidate = seeded.filter((f) =>
    Object.values(f.expected.per_candidate || {}).some((v) => v.classification === "bug_candidate"),
  );
  const candidateRecall = seeded.length ? seededWithCandidate.length / seeded.length : 1;
  if (candidateRecall < 1) {
    for (const f of seeded) {
      if (!Object.values(f.expected.per_candidate || {}).some((v) => v.classification === "bug_candidate")) {
        note(f.id, "seeded defect emitted no bug candidate");
      }
    }
  }

  // Reviewable queue = every candidate the grader emitted with a reviewer label.
  const labeled = FIXTURES.flatMap((f) => Object.values(f.expected.per_candidate || {}));
  const accepted = labeled.filter((v) => v.reviewer_label === "accept").length;
  const rejected = labeled.filter((v) => REJECT(v.reviewer_label)).length;
  const unresolved = labeled.filter((v) => v.reviewer_label === "unresolved").length;
  const precision = accepted + rejected ? accepted / (accepted + rejected) : 1;

  const metrics = {
    candidate_recall: candidateRecall,
    seeded_defects: seeded.length,
    precision_after_review: precision,
    accepted,
    rejected,
    unresolved,
    exact_match_rate: exactChecked ? exactStrict / exactChecked : 0,
    exact_recurrence_pairs: exactChecked,
    shortlist_recall: shortlistPairs ? shortlistHits / shortlistPairs : 1,
    shortlist_pairs: shortlistPairs,
    evidence_rows_retained: FIXTURES.reduce(
      (sum, f) => sum + (f.expected.evidence_rows || 0),
      0,
    ),
  };

  const cluster = {
    model_calls: modelCalls,
    candidates_per_call: candidatesPerCall,
    avg_candidates_per_call: candidatesPerCall.length
      ? candidatesPerCall.reduce((a, b) => a + b, 0) / candidatesPerCall.length
      : 0,
    input_tokens: totalClusterTokens,
    clusters: clusterReport,
    // For contrast: per-candidate classification would call the model once per
    // candidate; consolidation calls it once per cluster.
    per_candidate_calls_avoided: clustered.length - modelCalls,
  };

  return {
    thresholds: RETRIEVAL,
    metrics,
    cluster,
    discrepancies,
  };
}

/** The list of mismatches between computed behavior and recorded expectations. */
export function checkExpectations() {
  return runEvaluation().discrepancies;
}

function formatReport(r: ReturnType<typeof runEvaluation>) {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    "P0 findings-consolidation baseline (offline, zero model calls)",
    "=".repeat(62),
    `thresholds: k=${r.thresholds.k} floor=${r.thresholds.floor} auto_suggest=${r.thresholds.auto_suggest}`,
    "",
    "Measures",
    `  candidate recall (seeded defects) : ${pct(r.metrics.candidate_recall)} over ${r.metrics.seeded_defects} seeded`,
    `  precision after human review      : ${pct(r.metrics.precision_after_review)} (${r.metrics.accepted} accept / ${r.metrics.rejected} reject / ${r.metrics.unresolved} unresolved)`,
    `  exact-match rate                  : ${pct(r.metrics.exact_match_rate)} over ${r.metrics.exact_recurrence_pairs} recurrence pairs`,
    `  shortlist recall (top-k)          : ${pct(r.metrics.shortlist_recall)} over ${r.metrics.shortlist_pairs} duplicate pairs`,
    `  evidence rows retained            : ${r.metrics.evidence_rows_retained}`,
    "",
    "Cluster cost",
    `  model calls                       : ${r.cluster.model_calls}`,
    `  candidates per call               : [${r.cluster.candidates_per_call.join(", ")}] (avg ${r.cluster.avg_candidates_per_call.toFixed(1)})`,
    `  input tokens (estimate)           : ${r.cluster.input_tokens}`,
    `  per-candidate calls avoided       : ${r.cluster.per_candidate_calls_avoided}`,
    "",
    r.discrepancies.length
      ? `DISCREPANCIES (${r.discrepancies.length}):\n  - ${r.discrepancies.join("\n  - ")}`
      : "No discrepancies: computed behavior matches every recorded expectation.",
  ];
  return lines.join("\n");
}

// Runnable as a small script under the tests tree.
if (import.meta.url === `file://${process.argv[1]}`) {
  const report = runEvaluation();
  process.stdout.write(formatReport(report) + "\n");
  process.exit(report.discrepancies.length ? 1 : 0);
}
