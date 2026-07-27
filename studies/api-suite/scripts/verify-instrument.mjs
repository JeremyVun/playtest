#!/usr/bin/env node
// Pre-round instrument gate for S0.
//
// Run this immediately before every measured round, and paste its output into
// the preregistration's substrate section. It answers four questions and nothing
// else:
//
//   1. Does the bench still match its recorded pins? (a scoring file changed
//      without anyone re-recording it means the round is not the round that was
//      preregistered)
//   2. Is every vendored copy of the shared oracle still byte-identical to the
//      bench's? (P1 lost a clean run to a missed re-sync — PREREGISTRATION.md
//      tuning log, `oracle-fix-1`)
//   3. Does the sealed set still hash to its committed sha256, and does it still
//      apply? (never printing a byte of its content)
//   4. What exactly is the instrument, as a paste-ready block?
//
//   node studies/api-suite/scripts/verify-instrument.mjs \
//     [--vendor <dir>] [--sealed <patch> --sha256 <expected>]
//
// Environment (the fixture is never named in this file: `studies/**` may not
// mention the standalone examples tree — tests/repository/boundaries.test.js):
//
//   LEDGER_FIXTURE_DIR   required; the fixture package root
//   VENDOR_ORACLE_DIR    optional; a directory holding vendored oracles.js/trace.js
//   SEALED_PATCH         optional; path to the sealed fault patch
//   SEALED_SHA256        optional; its committed digest
//
// Exit 0 when every applicable check passes, 1 when one fails, 2 on a usage or
// configuration error.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
};

const die = (message, code = 2) => {
  process.stderr.write(`verify-instrument: ${message}\n`);
  process.exit(code);
};

const fixtureDir = process.env.LEDGER_FIXTURE_DIR;
if (!fixtureDir) {
  die(
    "LEDGER_FIXTURE_DIR is not set. It must point at the ledger fixture package root:\n" +
      '  export LEDGER_FIXTURE_DIR="$PWD/<the fixture directory named in studies/api-suite/README.md>"',
);
}
const FIXTURE = path.resolve(fixtureDir);
if (!fs.existsSync(path.join(FIXTURE, "bench", "pins.js"))) {
  die(`${FIXTURE} does not look like the fixture: bench/pins.js is missing`);
}

const SHARED_ORACLE_FILES = ["oracles.js", "trace.js"];
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const short = (digest) => `${digest.slice(0, 8)}…${digest.slice(-4)}`;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
};

// ---- 1. the bench's own pins ------------------------------------------------

try {
  const output = execFileSync(process.execPath, [path.join(FIXTURE, "bench", "pins.js")], { encoding: "utf8" });
  record("bench pins match the working tree", true, output.trim());
} catch (error) {
  record("bench pins match the working tree", false, (error.stdout ?? "") + (error.stderr ?? "").trim());
}

const pins = JSON.parse(fs.readFileSync(path.join(FIXTURE, "bench", "oracle-pins.json"), "utf8"));

// ---- 2. vendored copies of the shared oracle --------------------------------

const vendorDir = arg("vendor", process.env.VENDOR_ORACLE_DIR);
if (vendorDir) {
  const mismatches = [];
  for (const name of SHARED_ORACLE_FILES) {
    const vendored = path.join(vendorDir, name);
    if (!fs.existsSync(vendored)) {
      mismatches.push(`${name} missing from ${vendorDir}`);
      continue;
    }
    const theirs = sha256(vendored);
    const ours = sha256(path.join(FIXTURE, "bench", "lib", name));
    if (theirs !== ours) mismatches.push(`${name}: vendored ${short(theirs)} ≠ bench ${short(ours)}`);
  }
  record(
    `vendored oracle copies in ${vendorDir} are in sync`,
    mismatches.length === 0,
    mismatches.join("; ") || "byte-identical",
  );
} else {
  process.stdout.write(
    "skip  vendored oracle copies — pass --vendor <dir> (or set VENDOR_ORACLE_DIR) to check the probe arm's copies\n",
  );
}

for (const copy of pins.vendored_copies ?? []) {
  const drifted = SHARED_ORACLE_FILES.filter(
    (name) => copy.sha256?.[`lib/${name}`] !== pins.shared_oracle[`lib/${name}`],
  );
  record(
    `recorded vendored copy "${copy.instrument}" is ${copy.status}`,
    copy.status === "in-sync" ? drifted.length === 0 : drifted.length > 0,
    drifted.length ? `differs on ${drifted.join(", ")}` : "matches the bench pins",
  );
}

// ---- 3. the sealed set ------------------------------------------------------

const sealed = arg("sealed", process.env.SEALED_PATCH);
const expected = arg("sha256", process.env.SEALED_SHA256);
if (sealed) {
  if (!fs.existsSync(sealed)) {
    record("sealed set present", false, `no such file: ${sealed}`);
  } else {
    const digest = sha256(sealed);
    const bytes = fs.statSync(sealed).size;
    if (!expected) {
      // First run: this is how the commitment is obtained without reading the
      // patch. Print the digest, put it in the preregistration, never open it.
      record("sealed set digest computed", true, `sha256 ${digest} (${bytes} bytes) — record this as the commitment`);
    } else {
      record(
        "sealed set matches its committed digest",
        digest === expected,
        digest === expected ? `sha256 ${short(digest)}, ${bytes} bytes` : `computed ${digest}, committed ${expected}`,
      );
    }
    try {
      execFileSync("git", ["apply", "--check", "-p1", sealed], { cwd: process.cwd(), stdio: "pipe" });
      record("sealed set still applies to this tree", true);
    } catch (error) {
      record("sealed set still applies to this tree", false, String(error.stderr ?? error.message).trim());
    }
  }
} else {
  process.stdout.write("skip  sealed set — pass --sealed <patch> (and --sha256 <digest> once committed)\n");
}

// ---- 4. the paste-ready block ----------------------------------------------

const gitSha = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "(not a git checkout)";
  }
})();
const dirty = (() => {
  try {
    return execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
})();

process.stdout.write("\n--- paste into PREREGISTRATION.md §3 ---\n");
process.stdout.write(`checkout:        ${gitSha}${dirty ? " (DIRTY — a measured round must run on a clean tree)" : ""}\n`);
process.stdout.write(`verified at:     ${new Date().toISOString()}\n`);
for (const [file, digest] of Object.entries(pins.shared_oracle)) {
  process.stdout.write(`shared_oracle:   ${file} ${digest}\n`);
}
for (const [file, digest] of Object.entries(pins.bench_scoring)) {
  process.stdout.write(`bench_scoring:   ${file} ${digest}\n`);
}
process.stdout.write(`ledger seed:     ${process.env.LEDGER_SEED ?? "ledger-dev-seed (default)"}\n`);
process.stdout.write(`replay order:    ${process.env.REPLAY_ORDER_SEED ?? "(unset — generate and record it)"}\n`);
process.stdout.write("----------------------------------------\n");

const failed = results.filter((result) => !result.ok);
if (failed.length) {
  process.stderr.write(`\n${failed.length} check(s) failed. The round must not run.\n`);
  process.exit(1);
}
process.stdout.write("\nInstrument verified.\n");
