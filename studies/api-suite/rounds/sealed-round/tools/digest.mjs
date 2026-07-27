#!/usr/bin/env node
// Compact, committable digest of the round's run artifacts.
//
// The raw HARs are run-local and are not committed: this records their sha256
// alongside every counter the report cites, plus the fixture's own boot banner
// per build, so a reader can confirm each build really ran the configuration
// the order file says it did.
//
//   node digest.mjs <roundDir>   ->  <roundDir>/builds-digest.json

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const roundDir = process.argv[2];
const buildsDir = path.join(roundDir, "builds");
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const rows = [];
for (const name of fs.readdirSync(buildsDir).sort()) {
  const dir = path.join(buildsDir, name);
  if (!fs.statSync(dir).isDirectory()) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "bench-meta.json"), "utf8"));
  const harFile = path.join(dir, "har.json");
  const reportFile = path.join(dir, "script-report.json");
  const har = JSON.parse(fs.readFileSync(harFile, "utf8"));
  const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : null;
  const boot = fs.readFileSync(path.join(dir, "fixture.log"), "utf8");
  const line = (key) => (boot.match(new RegExp(`^\\s*${key}\\s*(.*)$`, "m")) ?? [, null])[1]?.trim() ?? null;

  rows.push({
    id: name,
    arm: meta.arm,
    label: meta.label,
    wall_ms: meta.wall_ms,
    requests: har.log?.entries?.length ?? null,
    har_sha256: sha(harFile),
    har_bytes: fs.statSync(harFile).size,
    script_report_sha256: report ? sha(reportFile) : null,
    fixture_boot: {
      listening: line("ledger-api listening on"),
      seed: line("seed:"),
      faults: line("faults:"),
      variants: line("variants:"),
      jitter: line("jitter:"),
      address_in_use: /EADDRINUSE/.test(boot),
    },
    verdict: report
      ? {
          script_report_version: report.script_report_version,
          checks: report.checks.length,
          failing: report.verdict.failing_checks.length,
          failing_ids: report.verdict.failing_checks,
          advisories: report.checks.filter((c) => c.status === "advisory").length,
          defects: report.defects.length,
          gate_pass: report.verdict.gate_pass,
          sound: report.soundness.ok,
          obligations: report.obligations.summary,
          budget: report.run.budget,
        }
      : null,
  });
}

fs.writeFileSync(path.join(roundDir, "builds-digest.json"), `${JSON.stringify({ builds: rows }, null, 2)}\n`);
process.stdout.write(`wrote builds-digest.json — ${rows.length} builds\n`);

// The isolation audit the harness could not do for itself: every build's own
// fixture must have booted with exactly the configuration its id names.
const expected = (row) => {
  const label = row.label;
  if (label === "clean") return { faults: "(none — clean build)", variants: "(none — canonical build)", jitter: "(none)" };
  if (label === "clean.jitter") return { faults: "(none — clean build)", variants: "(none — canonical build)", jitter: "up to 250ms per response" };
  if (label.startsWith("clean.")) return { faults: "(none — clean build)", variants: null, jitter: "(none)" };
  return { faults: label, variants: "(none — canonical build)", jitter: "(none)" };
};
let bad = 0;
for (const row of rows) {
  const want = expected(row);
  const boot = row.fixture_boot;
  const problems = [];
  if (boot.address_in_use) problems.push("EADDRINUSE");
  if (want.faults !== null && boot.faults !== want.faults) problems.push(`faults ${boot.faults} != ${want.faults}`);
  if (want.variants !== null && boot.variants !== want.variants) problems.push(`variants ${boot.variants} != ${want.variants}`);
  if (want.jitter !== null && boot.jitter !== want.jitter) problems.push(`jitter ${boot.jitter} != ${want.jitter}`);
  if (problems.length) {
    bad += 1;
    process.stdout.write(`  ISOLATION FAIL ${row.id}: ${problems.join("; ")}\n`);
  }
}
process.stdout.write(bad === 0 ? "isolation audit: all builds booted their own configured fixture\n" : `isolation audit: ${bad} build(s) failed\n`);
