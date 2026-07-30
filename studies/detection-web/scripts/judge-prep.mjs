// Judge preparation: take both arms' raw round deliverables, render every
// reported issue into one uniform arm-free shape, shuffle deterministically
// (seed = trial*1000 + round), and emit:
//   normalize-input.json — what the normalization judge sees (arm-blind)
//   blind-map.json       — item id → arm/provenance (NEVER shown to a judge)
//
// Usage:
//   node judge-prep.mjs --trial 1 --round 1 \
//     --arm-p <deliverable.json> --arm-c <report.json> --out <dir>

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    trial: { type: "string" },
    round: { type: "string" },
    "arm-p": { type: "string" },
    "arm-c": { type: "string" },
    out: { type: "string" },
  },
});
for (const k of ["trial", "round", "arm-p", "arm-c", "out"]) {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}

// Deterministic PRNG (mulberry32) + Fisher-Yates.
function shuffled(arr, seed) {
  let a = seed >>> 0;
  const rand = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const clip = (s, n = 1200) => {
  const t = String(s ?? "").trim();
  return t.length > n ? t.slice(0, n) + " …[truncated]" : t;
};

const items = [];

// Arm P: hosted findings (only the ones new/re-evidenced this round).
const pDeliverable = JSON.parse(fs.readFileSync(args["arm-p"], "utf8"));
const thisRound = new Set(pDeliverable.findings_this_round ?? []);
for (const f of pDeliverable.findings_all ?? []) {
  if (thisRound.size && !thisRound.has(f.id)) continue;
  const evidence = (f.evidence ?? [])
    .slice(0, 4)
    .map((e) => clip(e.claim ?? e.summary ?? e.text ?? "", 400))
    .filter(Boolean);
  items.push({
    provenance: { arm: "P", finding_id: f.id, state: f.state },
    title: clip(f.title, 200),
    body: [
      f.category ? `Category: ${f.category}` : "",
      f.severity ? `Severity: ${f.severity}` : "",
      f.expected ? `Expected: ${clip(f.expected)}` : "",
      f.observed ? `Observed: ${clip(f.observed)}` : "",
      f.summary?.text ? `Summary: ${clip(f.summary.text)}` : "",
      evidence.length ? `Evidence excerpts:\n${evidence.map((e) => `  - ${e}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

// Arm C: structured bug report.
const cReport = JSON.parse(fs.readFileSync(args["arm-c"], "utf8"));
for (const b of cReport.bugs ?? []) {
  items.push({
    provenance: { arm: "C", bug_n: b.n },
    title: clip(b.title, 200),
    body: [
      b.severity ? `Severity: ${b.severity}` : "",
      b.steps ? `Steps:\n${clip(b.steps)}` : "",
      b.expected ? `Expected: ${clip(b.expected)}` : "",
      b.observed ? `Observed: ${clip(b.observed)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

const seed = Number(args.trial) * 1000 + Number(args.round);
const order = shuffled(items, seed);
const blindMap = {};
const publicItems = order.map((it, i) => {
  const id = `I${String(i + 1).padStart(3, "0")}`;
  blindMap[id] = it.provenance;
  return { item_id: id, title: it.title, body: it.body };
});

fs.mkdirSync(args.out, { recursive: true });
fs.writeFileSync(
  path.join(args.out, "normalize-input.json"),
  JSON.stringify({ trial: Number(args.trial), round: Number(args.round), shuffle_seed: seed, items: publicItems }, null, 2),
);
fs.writeFileSync(path.join(args.out, "blind-map.json"), JSON.stringify(blindMap, null, 2));
console.log(JSON.stringify({ items: publicItems.length, seed, out: args.out }));
