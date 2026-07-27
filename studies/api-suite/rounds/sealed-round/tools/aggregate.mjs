#!/usr/bin/env node
// S0 sealed round — offline aggregation of the bench output into the study's
// preregistered tables (PREREGISTRATION.md §6.1, §6.2, §6.3, §6.4).
//
//   node aggregate.mjs <roundDir> <benchJson>
//
// Writes <roundDir>/RESULTS.json and <roundDir>/RESULTS.md.

import fs from "node:fs";
import path from "node:path";

const roundDir = process.argv[2];
const benchFile = process.argv[3];
const fixtureDir = process.env.LEDGER_FIXTURE_DIR;

const { SEALED_FAULT_IDS, FAULT_CATEGORIES, FAULT_TIERS } = await import(
  path.join(fixtureDir, "src", "faults.js")
);
const { columnOneCovers } = await import(path.join(fixtureDir, "bench", "lib", "score.js"));

const bench = JSON.parse(fs.readFileSync(benchFile, "utf8"));
const manifest = fs
  .readFileSync(path.join(roundDir, "manifest.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const ARMS = ["t1", "t2", "t3", "proposal"];
const ARM_LABEL = { t1: "statements-trial 1", t2: "statements-trial 2", t3: "statements-trial 3", proposal: "proposal trial" };
const CATEGORIES = [
  "state-machine",
  "cross-resource-invariant",
  "conditional-branch",
  "pagination",
  "idempotency",
  "temporal-boundary",
  "authorization",
  "error-semantics",
];

const traces = bench.traces;
const byArmFault = {};
const byArmClean = {};
for (const row of traces) {
  const arm = row.arm;
  if (row.label_kind === "faulty") ((byArmFault[arm] ??= {})[row.fault] = row);
  else if (row.label_kind === "clean") (byArmClean[arm] ??= []).push(row);
}

// ---- per-arm per-fault -----------------------------------------------------

const perArm = {};
for (const arm of ARMS) {
  const faults = {};
  for (const id of SEALED_FAULT_IDS) {
    const row = byArmFault[arm]?.[id];
    if (!row) {
      faults[id] = { missing: true };
      continue;
    }
    faults[id] = {
      category: FAULT_CATEGORIES[id],
      tier: FAULT_TIERS[id],
      column_one_covered: row.column_one_covered,
      column_one: row.columns.oracle_confirmed,
      column_two: row.columns.reported_with_evidence,
      column_two_strict: row.columns.reported_with_evidence_strict,
      reported_without_evidence: row.columns.reported_without_evidence,
      funnel: row.funnel?.stages ?? null,
      diagnosis: row.funnel?.diagnosis ?? null,
      first_false: row.funnel?.first_false ?? null,
      witness: row.witness
        ? { known: row.witness.known, reached: row.witness.reached, manifestations: row.witness.manifestations }
        : null,
      attributed_checks: (row.attributions ?? []).filter((a) => a.attributed).map((a) => ({
        check_id: a.check?.id ?? a.check_id ?? null,
        rule: a.check?.rule ?? a.rule ?? null,
        evidence_correct: a.evidence_correct,
        evidence_strict: a.evidence_strict,
      })),
      requests: row.requests,
      off_target_violations: row.off_target_violations,
      report: row.report ? { checks: row.report.checks, failing: row.report.failing, defects: row.report.defects, unaccounted: row.report.obligations_unaccounted } : null,
    };
  }

  // per category
  const categories = {};
  for (const category of CATEGORIES) {
    const ids = SEALED_FAULT_IDS.filter((id) => FAULT_CATEGORIES[id] === category);
    const covered = ids.filter((id) => columnOneCovers(id));
    categories[category] = {
      faults: ids.length,
      fault_ids: ids,
      column_one_covered: covered.length,
      column_one_detected: covered.filter((id) => faults[id].column_one === true).length,
      column_two_detected: ids.filter((id) => faults[id].column_two === true).length,
      semantic: ids.filter((id) => FAULT_TIERS[id] === "semantic").length,
      semantic_column_two: ids.filter((id) => FAULT_TIERS[id] === "semantic" && faults[id].column_two === true).length,
      missed_ids: ids.filter((id) => faults[id].column_two !== true),
    };
  }

  const semantic = SEALED_FAULT_IDS.filter((id) => FAULT_TIERS[id] === "semantic");
  const coveredIds = SEALED_FAULT_IDS.filter((id) => columnOneCovers(id));

  // false positives on the 16 conforming builds
  const cleanRows = byArmClean[arm] ?? [];
  const fpByLabel = {};
  for (const row of cleanRows) {
    const bucket = (fpByLabel[row.label] ??= { traces: 0, oracle: 0, reported: 0, checks: [] });
    bucket.traces += 1;
    bucket.oracle += row.false_positives;
    bucket.reported += row.reported_false_positives;
    for (const check of row.reported_false_positive_checks ?? []) bucket.checks.push({ build: row.id, ...check });
  }

  const fpByCheck = {};
  for (const row of cleanRows) {
    for (const check of row.reported_false_positive_checks ?? []) {
      const bucket = (fpByCheck[check.check_id] ??= {
        check_id: check.check_id,
        rule: check.rule,
        title: check.title,
        builds: 0,
        labels: {},
        observed_sample: check.observed ?? null,
      });
      bucket.builds += 1;
      bucket.labels[row.label] = (bucket.labels[row.label] ?? 0) + 1;
    }
  }

  // jitter repeats: CI-flake estimate
  const jitter = cleanRows.filter((row) => row.label === "clean.jitter");
  const canonical = cleanRows.filter((row) => row.label === "clean");
  const signature = (row) =>
    JSON.stringify({
      failing: (row.reported_false_positive_checks ?? []).map((c) => c.check_id).sort(),
      oracle: row.violations.map((v) => `${v.oracle}/${v.code}`).sort(),
      requests: row.requests,
    });
  const jitterSignatures = [...new Set(jitter.map(signature))];
  const canonicalSignatures = [...new Set(canonical.map(signature))];

  perArm[arm] = {
    arm,
    label: ARM_LABEL[arm],
    faults,
    categories,
    totals: {
      sealed: SEALED_FAULT_IDS.length,
      semantic: semantic.length,
      column_one_covered: coveredIds.length,
      column_one_detected: coveredIds.filter((id) => faults[id].column_one === true).length,
      column_one_not_covered: SEALED_FAULT_IDS.length - coveredIds.length,
      column_two_detected: SEALED_FAULT_IDS.filter((id) => faults[id].column_two === true).length,
      column_two_detected_semantic: semantic.filter((id) => faults[id].column_two === true).length,
      column_two_strict_semantic: semantic.filter((id) => faults[id].column_two_strict === true).length,
      reported_without_evidence: SEALED_FAULT_IDS.filter((id) => faults[id].reported_without_evidence === true).length,
    },
    diagnoses: SEALED_FAULT_IDS.reduce((total, id) => {
      const d = faults[id].diagnosis ?? "unknown";
      total[d] = (total[d] ?? 0) + 1;
      return total;
    }, {}),
    misses: SEALED_FAULT_IDS.filter((id) => faults[id].column_two !== true).map((id) => ({
      fault: id,
      category: FAULT_CATEGORIES[id],
      tier: FAULT_TIERS[id],
      diagnosis: faults[id].diagnosis,
      first_false: faults[id].first_false,
      funnel: faults[id].funnel,
      witness: faults[id].witness,
      column_one: faults[id].column_one,
      column_one_covered: faults[id].column_one_covered,
    })),
    false_positives: {
      conforming_builds: cleanRows.length,
      oracle: cleanRows.reduce((a, r) => a + r.false_positives, 0),
      reported: cleanRows.reduce((a, r) => a + r.reported_false_positives, 0),
      by_label: fpByLabel,
      by_check: fpByCheck,
      distinct_checks: Object.keys(fpByCheck).length,
      // The operator ruling in ROUND-LOG.md classifies D2 — the fixture
      // answering 422 where statement §11 requires 400 — as a verified
      // clean-build defect, so a check failing on it is a true positive under
      // §6.3, not a false positive. Both counts are reported; neither is
      // interpreted here.
      reported_excluding_D2: cleanRows.reduce(
        (a, r) =>
          a + (r.reported_false_positive_checks ?? []).filter((c) => c.check_id !== "status-400-for-a-wrongly-typed-field").length,
        0,
      ),
    },
    flake: {
      jitter_repeats: jitter.length,
      distinct_outcome_signatures: jitterSignatures.length,
      canonical_repeats: canonical.length,
      canonical_distinct_signatures: canonicalSignatures.length,
      jitter_matches_canonical:
        jitterSignatures.length === 1 && canonicalSignatures.length === 1 && jitterSignatures[0] === canonicalSignatures[0],
      flake_rate: jitter.length ? (jitterSignatures.length - 1) / jitter.length : null,
    },
  };
}

// ---- cross-trial variance --------------------------------------------------

const statTrials = ["t1", "t2", "t3"];
const col2 = statTrials.map((a) => perArm[a].totals.column_two_detected_semantic);
const mean = col2.reduce((a, b) => a + b, 0) / col2.length;
const variance = {
  column_two_semantic_per_trial: Object.fromEntries(statTrials.map((a, i) => [a, col2[i]])),
  min: Math.min(...col2),
  max: Math.max(...col2),
  range: Math.max(...col2) - Math.min(...col2),
  mean: Number(mean.toFixed(3)),
  sd: Number(Math.sqrt(col2.reduce((a, b) => a + (b - mean) ** 2, 0) / col2.length).toFixed(3)),
  unanimous_detected: SEALED_FAULT_IDS.filter((id) => statTrials.every((a) => perArm[a].faults[id].column_two === true)),
  unanimous_missed: SEALED_FAULT_IDS.filter((id) => statTrials.every((a) => perArm[a].faults[id].column_two !== true)),
  split: SEALED_FAULT_IDS.filter((id) => {
    const hits = statTrials.filter((a) => perArm[a].faults[id].column_two === true).length;
    return hits > 0 && hits < 3;
  }).map((id) => ({
    fault: id,
    detected_by: statTrials.filter((a) => perArm[a].faults[id].column_two === true),
  })),
};

// ---- economics -------------------------------------------------------------

const economics = { per_arm: {}, per_build_kind: {}, round: {} };
for (const arm of ARMS) {
  const rows = manifest.filter((r) => r.arm === arm && r.status === "ok");
  economics.per_arm[arm] = {
    builds: rows.length,
    requests_total: rows.reduce((a, r) => a + (r.requests ?? 0), 0),
    requests_per_build_min: Math.min(...rows.map((r) => r.requests ?? 0)),
    requests_per_build_max: Math.max(...rows.map((r) => r.requests ?? 0)),
    wall_ms_total: rows.reduce((a, r) => a + (r.wall_ms ?? 0), 0),
    wall_ms_per_build_mean: Math.round(rows.reduce((a, r) => a + (r.wall_ms ?? 0), 0) / rows.length),
    wall_ms_canonical_clean_mean: Math.round(
      rows.filter((r) => r.label === "clean").reduce((a, r) => a + r.wall_ms, 0) /
        Math.max(1, rows.filter((r) => r.label === "clean").length),
    ),
    wall_ms_jitter_mean: Math.round(
      rows.filter((r) => r.label === "clean.jitter").reduce((a, r) => a + r.wall_ms, 0) /
        Math.max(1, rows.filter((r) => r.label === "clean.jitter").length),
    ),
    model_calls: 0,
    cost_usd: 0,
    per_build: Object.fromEntries(rows.map((r) => [r.id, { requests: r.requests, wall_ms: r.wall_ms, exit: r.exit }])),
  };
}
economics.round = {
  builds: manifest.filter((r) => r.status === "ok").length,
  infrastructure_failures: manifest.filter((r) => r.status !== "ok").length,
  requests_total: manifest.filter((r) => r.status === "ok").reduce((a, r) => a + (r.requests ?? 0), 0),
  wall_ms_total: manifest.filter((r) => r.status === "ok").reduce((a, r) => a + (r.wall_ms ?? 0), 0),
  model_calls: 0,
  cost_usd: 0,
};

const results = {
  round: "s0-sealed-1",
  generated_at: new Date().toISOString(),
  seed: "4adf038b88f9421c",
  sealed_set: {
    tarball_sha256: "842a4689d3486db1031841fe28ba4ee675a726564c13570a23e8da9d0eaa1daf",
    patch_sha256: "2d7a0d2875b448bd1d9543071b2852f0d3b59a4d3eb77750c9cb238227beb406",
    faults: SEALED_FAULT_IDS.length,
    semantic: SEALED_FAULT_IDS.filter((id) => FAULT_TIERS[id] === "semantic").length,
    column_one_covered: SEALED_FAULT_IDS.filter((id) => columnOneCovers(id)).length,
  },
  faults: Object.fromEntries(
    SEALED_FAULT_IDS.map((id) => [
      id,
      { category: FAULT_CATEGORIES[id], tier: FAULT_TIERS[id], column_one_covered: columnOneCovers(id) },
    ]),
  ),
  arms: perArm,
  cross_trial_variance: variance,
  economics,
};

fs.writeFileSync(path.join(roundDir, "RESULTS.json"), `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(`wrote ${path.join(roundDir, "RESULTS.json")}\n`);

// ---- console summary -------------------------------------------------------

const c1 = (f) => (f.column_one_covered === false ? "n/c" : f.column_one === true ? "YES" : "no");
const c2 = (f) => (f.column_two === true ? "YES" : f.column_two === false ? "no" : "—");
process.stdout.write("\nper-fault, column1 / column2\n");
process.stdout.write("fault".padEnd(36) + ARMS.map((a) => a.padEnd(12)).join("") + "\n");
for (const id of SEALED_FAULT_IDS) {
  process.stdout.write(
    id.padEnd(36) + ARMS.map((a) => `${c1(perArm[a].faults[id])}/${c2(perArm[a].faults[id])}`.padEnd(12)).join("") + "\n",
  );
}
process.stdout.write("\ntotals\n");
for (const a of ARMS) {
  const t = perArm[a].totals;
  process.stdout.write(
    `${a.padEnd(10)} col1 ${t.column_one_detected}/${t.column_one_covered} covered (${t.column_one_not_covered} not covered)  ` +
      `col2 ${t.column_two_detected}/14, semantic ${t.column_two_detected_semantic}/13, strict ${t.column_two_strict_semantic}/13  ` +
      `FP oracle ${perArm[a].false_positives.oracle} reported ${perArm[a].false_positives.reported} over ${perArm[a].false_positives.conforming_builds} conforming builds\n`,
  );
}
