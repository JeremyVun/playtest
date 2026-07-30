// Evidence linter: re-derive every headline number in data/study.json from the
// committed per-round ledgers and fail loudly on any mismatch or dangling
// reference. Run: node studies/detection-web/report/lint-evidence.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const J = (p) => JSON.parse(fs.readFileSync(path.join(HERE, p), "utf8"));
const study = J("data/study.json");
const catalog = new Set(J("../catalog/catalog.json").faults.map((f) => f.id));
const problems = [];

for (const t of ["t1", "t2"]) {
  const cum = { P: new Set(), C: new Set() };
  for (const rd of study.trials[t].rounds) {
    const ledger = J(`data/ledgers/${t}-r${rd.round}.json`);
    const audit = J(`data/ledgers/${t}-r${rd.round}-audit.json`);
    if (audit.trial !== Number(t[1]) || audit.round !== rd.round) problems.push(`${t}-r${rd.round}: audit file mismatch`);
    const by = new Map(ledger.claims.map((c) => [c.claim_id, c]));
    const resolve = (c) => {
      const seen = new Set();
      while (c.duplicate_of && !seen.has(c.claim_id)) {
        seen.add(c.claim_id);
        c = by.get(c.duplicate_of);
      }
      return c;
    };
    const derived = { P: { seeded: new Set(), latent: 0, invalid: 0, nondup: 0 }, C: { seeded: new Set(), latent: 0, invalid: 0, nondup: 0 } };
    for (const c of ledger.claims) {
      if (!["P", "C"].includes(c.arm)) problems.push(`${t}-r${rd.round}/${c.claim_id}: bad arm ${c.arm}`);
      if (!c.rationale) problems.push(`${t}-r${rd.round}/${c.claim_id}: missing rationale`);
      const r = resolve(c);
      const d = derived[c.arm];
      if (c.duplicate_of || c.sublabel === "duplicate") {
        if (r.verdict === "seeded") d.seeded.add(r.fault_id);
        continue;
      }
      d.nondup++;
      if (c.verdict === "seeded") {
        if (!catalog.has(c.fault_id)) problems.push(`${t}-r${rd.round}/${c.claim_id}: unknown fault ${c.fault_id}`);
        d.seeded.add(c.fault_id);
      } else if (c.verdict === "latent") d.latent++;
      else d.invalid++;
    }
    for (const a of ["P", "C"]) {
      const j = rd.judge[a] ?? { seeded: [], latent: 0, invalid: 0, nondup: 0 };
      const ds = [...derived[a].seeded].sort().join();
      if (ds !== (j.seeded ?? []).slice().sort().join()) problems.push(`${t}-r${rd.round} arm ${a}: seeded mismatch (${ds} vs ${j.seeded})`);
      if (derived[a].latent !== j.latent) problems.push(`${t}-r${rd.round} arm ${a}: latent ${derived[a].latent} != ${j.latent}`);
      if (derived[a].invalid !== j.invalid) problems.push(`${t}-r${rd.round} arm ${a}: invalid ${derived[a].invalid} != ${j.invalid}`);
      const news = [...derived[a].seeded].filter((f) => !cum[a].has(f)).sort().join();
      if (news !== rd[`new_seeded_${a}`].slice().sort().join()) problems.push(`${t}-r${rd.round} arm ${a}: new-seeded mismatch`);
      for (const f of derived[a].seeded) cum[a].add(f);
      if (cum[a].size !== rd[`cum_seeded_${a}`]) problems.push(`${t}-r${rd.round} arm ${a}: cumulative ${cum[a].size} != ${rd[`cum_seeded_${a}`]}`);
    }
  }
  for (const a of ["P", "C"]) {
    if ([...cum[a]].sort().join() !== study.trials[t][`seeded_${a}`].slice().sort().join())
      problems.push(`${t} arm ${a}: trial seeded set mismatch`);
  }
}
for (const f of Object.keys(study.miss_analysis)) {
  if (!catalog.has(f)) problems.push(`miss_analysis unknown fault ${f}`);
  if (study.found_union.includes(f)) problems.push(`miss_analysis contains found fault ${f}`);
}

if (problems.length) {
  console.error("EVIDENCE LINT FAILED:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log("evidence lint: OK — every headline number re-derives from the ledgers");
