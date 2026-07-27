#!/usr/bin/env node
// Instrument pins for the bench: a sha256 of every file that can change a
// measured verdict.
//
// Why this exists. In P1 the probe's vendored copy of the oracles drifted from
// the fixture's copy and the round recorded a false positive before anyone
// noticed (`studies/api-probe/PREREGISTRATION.md`, tuning log `oracle-fix-1`).
// A preregistered study needs the opposite property: the instrument cannot
// change without someone saying so, in a commit, on purpose.
//
//   node bench/pins.js            # verify (exit 1 on drift)
//   node bench/pins.js --write    # re-record, after an intentional change
//
// `oracle-pins.json` separates two things:
//
//   shared_oracle    the files a measured instrument *vendors a copy of*.
//                    Changing one of these invalidates every already-scored
//                    round and obliges every vendored copy to be re-synced.
//   bench_scoring    the rest of the scoring substrate. Changing one of these
//                    changes what the bench reports, so the preregistration
//                    fingerprints them too, but no other repository holds a copy.
//
// `vendored_copies` records what each frozen instrument was pinned at. An entry
// is `in-sync` (its hashes must equal `shared_oracle`) or explicitly `diverged`
// with a note saying what that costs — a frozen study cannot be re-synced, so
// divergence has to be declared rather than discovered.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PINS_FILE = path.join(HERE, "oracle-pins.json");

/** Files a measured instrument vendors a copy of. Do not extend casually. */
export const SHARED_ORACLE_FILES = Object.freeze(["lib/oracles.js", "lib/trace.js"]);

/** The rest of the scoring substrate the preregistration fingerprints. */
export const BENCH_SCORING_FILES = Object.freeze([
  "bench.js",
  "lib/funnel.js",
  "lib/report.js",
  "lib/score.js",
  "lib/sources.js",
  "lib/suite-report.js",
  "lib/witnesses.js",
  "../src/faults.js",
]);

export const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const digestsOf = (files) => Object.fromEntries(files.map((file) => [file, sha256(path.join(HERE, file))]));

/** The pins the working tree actually has right now. */
export function currentPins() {
  return {
    algorithm: "sha256",
    shared_oracle: digestsOf(SHARED_ORACLE_FILES),
    bench_scoring: digestsOf(BENCH_SCORING_FILES),
  };
}

export const readPins = (file = PINS_FILE) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Compare the recorded pins against the working tree. */
export function verifyPins(recorded = readPins(), current = currentPins()) {
  const problems = [];
  for (const group of ["shared_oracle", "bench_scoring"]) {
    const left = recorded[group] ?? {};
    const right = current[group] ?? {};
    for (const file of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (left[file] === right[file]) continue;
      problems.push(
        left[file] === undefined
          ? `${group}/${file} is not pinned`
          : right[file] === undefined
            ? `${group}/${file} is pinned but missing from the bench`
            : `${group}/${file} changed: pinned ${left[file].slice(0, 12)}…, now ${right[file].slice(0, 12)}…`,
      );
    }
  }
  for (const copy of recorded.vendored_copies ?? []) {
    for (const [file, digest] of Object.entries(copy.sha256 ?? {})) {
      const shared = current.shared_oracle[file];
      if (copy.status === "in-sync" && digest !== shared) {
        problems.push(
          `vendored copy "${copy.instrument}" is recorded in-sync but its ${file} pin ` +
            `${digest.slice(0, 12)}… no longer equals the bench's ${String(shared).slice(0, 12)}…`,
        );
      }
      if (copy.status === "diverged" && digest === shared) {
        problems.push(`vendored copy "${copy.instrument}" is recorded diverged but its ${file} pin now matches`);
      }
    }
    if (copy.status === "diverged" && !copy.note) {
      problems.push(`vendored copy "${copy.instrument}" is diverged with no note explaining what that costs`);
    }
  }
  return problems;
}

export function writePins(file = PINS_FILE) {
  const previous = fs.existsSync(file) ? readPins(file) : {};
  const document = {
    note:
      "sha256 of every file that can change a measured verdict. Verified by test/pins.test.js; " +
      "re-record deliberately with `npm run bench:pins -- --write` and say why in the commit.",
    ...currentPins(),
    vendored_copies: previous.vendored_copies ?? [],
  };
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  return document;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  if (process.argv.includes("--write")) {
    const document = writePins();
    process.stdout.write(`pins re-recorded in ${path.relative(process.cwd(), PINS_FILE)}\n`);
    for (const [file, digest] of Object.entries(document.shared_oracle)) {
      process.stdout.write(`  shared_oracle ${file} ${digest}\n`);
    }
  } else {
    const problems = verifyPins();
    if (problems.length) {
      process.stderr.write(`bench pins are out of date:\n${problems.map((line) => `  - ${line}`).join("\n")}\n`);
      process.stderr.write("\nIf the change was intended: npm run bench:pins -- --write\n");
      process.exit(1);
    }
    process.stdout.write("bench pins match the working tree\n");
  }
}
