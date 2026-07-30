// Judge output validation + ledger assembly for one round.
//
//   node judge-merge.mjs --dir <judging dir> --catalog <faults.json> [--allow-still-masked]
//
// Expects in --dir:
//   normalize-input.json   (from judge-prep)
//   normalize-output.json  (judge pass 1)
//   classify-output.json   (judge pass 2)
//   blind-map.json         (from judge-prep; used only AFTER validation)
// Writes ledger.json: unblinded, per-claim verdicts, ready for metrics.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    dir: { type: "string" },
    catalog: { type: "string" },
    "allow-still-masked": { type: "boolean", default: false },
    // Comma-separated fault ids already withdrawn per arm before this round.
    // A `seeded` verdict naming one is impossible for that arm (its
    // manifestation is gone) and is recorded as an override per SCORING.md
    // rule 2.
    "withdrawn-p": { type: "string", default: "" },
    "withdrawn-c": { type: "string", default: "" },
  },
});
if (!args.dir || !args.catalog) {
  console.error("need --dir and --catalog");
  process.exit(2);
}
const read = (f) => JSON.parse(fs.readFileSync(path.join(args.dir, f), "utf8"));

const input = read("normalize-input.json");
const norm = read("normalize-output.json");
const cls = read("classify-output.json");
const blind = read("blind-map.json");
const catalog = JSON.parse(fs.readFileSync(args.catalog, "utf8"));
const faultIds = new Set((catalog.faults ?? catalog).map((f) => f.id));

const problems = [];
const inputIds = new Set(input.items.map((i) => i.item_id));

// --- validate pass 1: every item covered exactly once; claims well-formed ---
const claims = norm.claims ?? [];
const covered = new Set();
for (const c of claims) {
  if (!c.claim_id) problems.push(`claim without claim_id`);
  if (!Array.isArray(c.source_items) || c.source_items.length === 0) {
    problems.push(`${c.claim_id}: no source_items`);
    continue;
  }
  for (const s of c.source_items) {
    if (!inputIds.has(s)) problems.push(`${c.claim_id}: unknown source item ${s}`);
    covered.add(s);
  }
  if (!c.text) problems.push(`${c.claim_id}: empty text`);
  if (c.duplicate_of && !claims.some((o) => o.claim_id === c.duplicate_of)) {
    problems.push(`${c.claim_id}: duplicate_of unknown claim ${c.duplicate_of}`);
  }
}
for (const id of inputIds) if (!covered.has(id)) problems.push(`input item ${id} not covered by any claim`);
const dupIds = claims.map((c) => c.claim_id).filter((id, i, a) => a.indexOf(id) !== i);
for (const d of dupIds) problems.push(`duplicate claim_id ${d}`);

// --- validate pass 2: every non-duplicate claim classified exactly once ---
const verdicts = cls.verdicts ?? [];
const byClaim = new Map();
for (const v of verdicts) {
  if (byClaim.has(v.claim_id)) problems.push(`double verdict for ${v.claim_id}`);
  byClaim.set(v.claim_id, v);
  if (!["seeded", "latent", "invalid"].includes(v.verdict)) problems.push(`${v.claim_id}: bad verdict ${v.verdict}`);
  if (v.verdict === "seeded") {
    if (!v.fault_id) problems.push(`${v.claim_id}: seeded without fault_id`);
    else if (!faultIds.has(v.fault_id)) problems.push(`${v.claim_id}: unknown fault_id ${v.fault_id}`);
  }
  if (v.verdict === "invalid" && !["duplicate", "soft-ux", "harness-artifact", "not-a-bug"].includes(v.sublabel ?? "")) {
    problems.push(`${v.claim_id}: invalid needs sublabel`);
  }
  if (!["high", "medium", "low"].includes(v.confidence ?? "")) problems.push(`${v.claim_id}: bad confidence`);
  if (!v.rationale) problems.push(`${v.claim_id}: missing rationale`);
}
for (const c of claims) {
  if (c.duplicate_of) continue;
  if (!byClaim.has(c.claim_id)) problems.push(`no verdict for ${c.claim_id}`);
}

if (problems.length) {
  console.error("VALIDATION FAILED:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

// --- unblind and assemble ---
const armOf = (c) => {
  const arms = new Set(c.source_items.map((s) => blind[s]?.arm).filter(Boolean));
  if (arms.size !== 1) return "MIXED"; // cross-arm merge would be a prep bug — surface it
  return [...arms][0];
};

const ledger = {
  trial: input.trial,
  round: input.round,
  shuffle_seed: input.shuffle_seed,
  judged_at: new Date().toISOString(),
  claims: claims.map((c) => {
    const v = byClaim.get(c.claim_id) ?? null;
    return {
      claim_id: c.claim_id,
      arm: armOf(c),
      source_items: c.source_items,
      provenance: c.source_items.map((s) => blind[s]),
      text: c.text,
      duplicate_of: c.duplicate_of ?? null,
      verdict: c.duplicate_of ? "invalid" : v?.verdict,
      sublabel: c.duplicate_of ? "duplicate" : (v?.sublabel ?? null),
      fault_id: v?.fault_id ?? null,
      confidence: v?.confidence ?? null,
      rationale: c.duplicate_of ? `duplicate of ${c.duplicate_of}` : v?.rationale,
      override: null, // human audit writes { by, from, to, reason } here
    };
  }),
};

const mixed = ledger.claims.filter((c) => c.arm === "MIXED");
if (mixed.length) {
  console.error(`FATAL: ${mixed.length} claims merge items across arms: ${mixed.map((c) => c.claim_id).join(", ")}`);
  process.exit(1);
}

// SCORING.md rule 2: an arm cannot be credited a fault already withdrawn for
// it. Applied after unblinding because withdrawal sets are per-arm.
const withdrawnFor = {
  P: new Set(args["withdrawn-p"].split(",").map((s) => s.trim()).filter(Boolean)),
  C: new Set(args["withdrawn-c"].split(",").map((s) => s.trim()).filter(Boolean)),
};
for (const c of ledger.claims) {
  if (c.verdict === "seeded" && withdrawnFor[c.arm]?.has(c.fault_id)) {
    c.override = {
      by: "judge-merge",
      from: `seeded:${c.fault_id}`,
      to: "invalid:not-a-bug",
      reason: "withdrawn-before-round",
    };
    c.verdict = "invalid";
    c.sublabel = "not-a-bug";
    c.fault_id = null;
  }
}

fs.writeFileSync(path.join(args.dir, "ledger.json"), JSON.stringify(ledger, null, 2));
const summary = {};
for (const c of ledger.claims) {
  const key = `${c.arm}:${c.verdict}${c.sublabel ? ":" + c.sublabel : ""}`;
  summary[key] = (summary[key] ?? 0) + 1;
}
console.log(JSON.stringify({ claims: ledger.claims.length, summary }, null, 2));
