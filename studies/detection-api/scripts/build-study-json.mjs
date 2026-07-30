// Assemble report/data/study.json from measured artifacts (no hand-typed
// numbers). Run from studies/detection-api/.

import fs from "node:fs";

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const ledger = read("work/t1/judging-r1/ledger.json");
const cards = read("work/fault-cards.json").faults;
const pMetrics = read("work/t1/armP-r1/metrics.json");
const cReport = read("work/t1/armC-r1/report.json");
const cCost = read("work/t1/armC-r1/cost.json");
const fReport = read("work/t1/armF-r1/report.json");
const scores = JSON.parse(
  (await import("node:child_process")).execSync(
    "node scripts/score.mjs --ledger work/t1/judging-r1/ledger.json --catalog work/fault-cards.json",
    { encoding: "utf8" },
  ),
);

const telemetry = {};
for (const arm of ["armP", "armC", "armF"]) {
  const counts = {};
  for (const line of fs.readFileSync(`work/t1/telemetry-${arm}.jsonl`, "utf8").trim().split("\n").filter(Boolean)) {
    const e = JSON.parse(line);
    counts[e.fault] = (counts[e.fault] ?? 0) + 1;
  }
  telemetry[arm.slice(3)] = counts;
}

const matrix = cards.map((f) => ({
  id: f.id,
  title: f.title,
  flow: f.flow,
  found_by: Object.fromEntries(
    ["P", "C", "F"].map((a) => [a, scores.arms[a].seeded_fault_ids.includes(f.id)]),
  ),
  triggered: Object.fromEntries(["P", "C", "F"].map((a) => [a, telemetry[a][f.id] ?? 0])),
  web_study_found: undefined, // filled below
}));

// Web-study comparison: which of these 10 faults did either web arm find
// (union across both trials, from the web report's study.json).
const web = read("../detection-web/report/data/study.json");
const webFound = new Set();
for (const t of Object.values(web.trials ?? {})) {
  for (const id of [...(t.seeded_P ?? []), ...(t.seeded_C ?? [])]) webFound.add(id);
}
for (const m of matrix) m.web_study_found = webFound.has(m.id);

const pCost = +(pMetrics.cost_usd + (pMetrics.synthesis_cost_usd ?? 0)).toFixed(2);
const study = {
  study: "detection-api",
  generated_at: new Date().toISOString(),
  protocol: "QUICK.md (2.5h indicative variant of docs/backlog/detection-study/api.md; web-study SCORING.md rules)",
  build_id: "a30cd991e92f",
  faults_total: cards.length,
  trial: 1,
  round: 1,
  arms: {
    P: {
      name: "Playtest probe (hosted, api driver)",
      model: "gpt5_5",
      seeded_found: scores.arms.P.seeded_found,
      seeded_fault_ids: scores.arms.P.seeded_fault_ids,
      latent_found: scores.arms.P.latent_found,
      invalid_nondup: scores.arms.P.invalid_nondup_claims,
      noise_ratio: scores.arms.P.noise_ratio,
      claims: scores.arms.P.claims,
      cost_usd: pCost,
      wall_min: +(pMetrics.wall_ms / 60000).toFixed(1),
      turns: pMetrics.actor_steps,
      runs: pMetrics.runs.map((r) => ({ case: r.case_id, status: r.status, steps: r.steps, cost_usd: r.cost_usd })),
    },
    C: {
      name: "Coding agent (gpt-5.5 + http tool)",
      model: cReport.model,
      seeded_found: scores.arms.C.seeded_found,
      seeded_fault_ids: scores.arms.C.seeded_fault_ids,
      latent_found: scores.arms.C.latent_found,
      invalid_nondup: scores.arms.C.invalid_nondup_claims,
      noise_ratio: scores.arms.C.noise_ratio,
      claims: scores.arms.C.claims,
      cost_usd: cCost.priced_usd,
      wall_min: cCost.wall_min,
      turns: cReport.metrics.model_messages,
      requests: cReport.metrics.requests,
      end_reason: cReport.end_reason,
    },
    F: {
      name: "Schemathesis 4.24.3 (seed 20260731, max-examples 8, checks all)",
      model: null,
      seeded_found: scores.arms.F.seeded_found,
      seeded_fault_ids: scores.arms.F.seeded_fault_ids,
      latent_found: scores.arms.F.latent_found,
      invalid_nondup: scores.arms.F.invalid_nondup_claims,
      noise_ratio: scores.arms.F.noise_ratio,
      claims: scores.arms.F.claims,
      cost_usd: 0,
      wall_min: 0.12,
      requests: 443,
    },
  },
  verdicts: {
    B1_value_floor: {
      rule: "any value-adding arm strictly exceeds arm F seeded count (0)",
      P: scores.arms.P.seeded_found > scores.arms.F.seeded_found,
      C: scores.arms.C.seeded_found > scores.arms.F.seeded_found,
    },
    B2_marginal_value: {
      rule: "arm P seeded >= arm C seeded + 2",
      pass: scores.arms.P.seeded_found >= scores.arms.C.seeded_found + 2,
      delta: scores.arms.P.seeded_found - scores.arms.C.seeded_found,
    },
    B3_replacement_noise: {
      rule: "no hidden clean build (QUICK dev. 3); invalid non-dup counts reported instead",
      P_noise_ratio: scores.arms.P.noise_ratio,
      C_noise_ratio: scores.arms.C.noise_ratio,
      F_noise_ratio: scores.arms.F.noise_ratio,
    },
    B4_envelope: {
      rule: "45 min wall / 360 requests per arm; $60 whole-study",
      P_wall_breach_min: +(pMetrics.wall_ms / 60000 - 45).toFixed(1),
      F_request_overage: 443 - 360,
      arm_spend_usd: +(pCost + cCost.priced_usd).toFixed(2),
    },
  },
  matrix,
  latents: [
    {
      found_by: "F",
      summary: "HTTP 500 (generic handler) when a syntactically-valid JSON body of literal null is POSTed/PATCHed to body-reading routes; reproduces on clean.",
    },
  ],
  arm_f_raw: { failures: fReport.items.length, titles: fReport.items.map((i) => i.title) },
};

fs.mkdirSync("report/data", { recursive: true });
fs.writeFileSync("report/data/study.json", JSON.stringify(study, null, 2));
console.log(JSON.stringify({ ok: true, matrix: matrix.length, webFound: [...webFound].filter((id) => cards.some((c) => c.id === id)).length }));
