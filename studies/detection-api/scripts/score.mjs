// Headline metrics from one round's ledger.json (SCORING.md rules, single
// round, arms P/C/F). Duplicate chains resolve to their primary's verdict;
// each claim credits its own arm; one fault credits once per arm.
//
//   node score.mjs --ledger <ledger.json> --catalog <fault-cards.json>

import fs from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: { ledger: { type: "string" }, catalog: { type: "string" } },
});
if (!args.ledger || !args.catalog) {
  console.error("need --ledger and --catalog");
  process.exit(2);
}
const ledger = JSON.parse(fs.readFileSync(args.ledger, "utf8"));
const faults = (JSON.parse(fs.readFileSync(args.catalog, "utf8")).faults ?? []).map((f) => f.id);

const byId = new Map(ledger.claims.map((c) => [c.claim_id, c]));
const resolve = (c) => {
  let cur = c;
  const seen = new Set();
  while (cur.duplicate_of && !seen.has(cur.claim_id)) {
    seen.add(cur.claim_id);
    cur = byId.get(cur.duplicate_of) ?? cur;
  }
  return cur;
};

const arms = {};
for (const c of ledger.claims) {
  const arm = c.arm;
  arms[arm] ??= { claims: 0, dup_claims: 0, seeded: new Set(), latent: new Set(), invalid: 0, invalid_sublabels: {}, seeded_claims: 0, latent_claims: 0 };
  const a = arms[arm];
  a.claims++;
  const r = resolve(c);
  const isDup = Boolean(c.duplicate_of);
  if (isDup) a.dup_claims++;
  if (r.verdict === "seeded" && r.fault_id) {
    a.seeded.add(r.fault_id);
    a.seeded_claims++;
  } else if (r.verdict === "latent") {
    a.latent.add(r.claim_id); // distinct underlying issue = the primary claim
    a.latent_claims++;
  } else if (!isDup) {
    a.invalid++;
    a.invalid_sublabels[c.sublabel ?? "?"] = (a.invalid_sublabels[c.sublabel ?? "?"] ?? 0) + 1;
  }
}

const out = { faults_total: faults.length, arms: {} };
for (const [arm, a] of Object.entries(arms)) {
  out.arms[arm] = {
    claims: a.claims,
    duplicate_claims: a.dup_claims,
    seeded_found: a.seeded.size,
    seeded_fault_ids: [...a.seeded].sort(),
    seeded_missed: faults.filter((f) => !a.seeded.has(f)),
    latent_found: a.latent.size,
    invalid_nondup_claims: a.invalid,
    invalid_sublabels: a.invalid_sublabels,
    noise_ratio: a.claims - a.dup_claims > 0 ? +(a.invalid / (a.claims - a.dup_claims)).toFixed(3) : 0,
  };
}
console.log(JSON.stringify(out, null, 2));
