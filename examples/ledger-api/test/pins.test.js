// The instrument pins (bench/oracle-pins.json).
//
// A preregistered study's oracles must not be able to change quietly. In P1 a
// vendored copy of the oracles drifted from this bench's copy and the round
// recorded a false positive before anyone noticed. This test is the mechanical
// guard: any edit to a scoring file, and any divergence of a frozen instrument's
// vendored copy, fails here until someone re-records the pins on purpose.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BENCH_SCORING_FILES,
  PINS_FILE,
  SHARED_ORACLE_FILES,
  currentPins,
  readPins,
  sha256,
  verifyPins,
} from "../bench/pins.js";

const BENCH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bench");

test("the recorded pins match the working tree", () => {
  assert.deepEqual(
    verifyPins(),
    [],
    "the bench changed without re-recording its pins: run `npm run bench:pins -- --write` and say why in the commit",
  );
});

test("the pin file covers every scoring file and nothing that does not exist", () => {
  const recorded = readPins();
  assert.equal(recorded.algorithm, "sha256");
  assert.deepEqual(Object.keys(recorded.shared_oracle).sort(), [...SHARED_ORACLE_FILES].sort());
  assert.deepEqual(Object.keys(recorded.bench_scoring).sort(), [...BENCH_SCORING_FILES].sort());

  for (const file of [...SHARED_ORACLE_FILES, ...BENCH_SCORING_FILES]) {
    assert.ok(fs.existsSync(path.join(BENCH, file)), `${file} is pinned but missing`);
  }

  // Every JavaScript file under bench/ is either pinned or deliberately not part
  // of the measurement, so a new scoring module cannot arrive unpinned.
  const unpinned = fs
    .readdirSync(path.join(BENCH, "lib"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `lib/${name}`)
    .filter((file) => !SHARED_ORACLE_FILES.includes(file) && !BENCH_SCORING_FILES.includes(file));
  assert.deepEqual(unpinned, [], "a bench/lib module is not pinned");
});

test("a vendored copy of the shared oracle cannot diverge silently", () => {
  const recorded = readPins();
  assert.ok(recorded.vendored_copies.length >= 1, "at least the frozen P1 instrument is recorded");
  for (const copy of recorded.vendored_copies) {
    assert.ok(["in-sync", "diverged"].includes(copy.status), `${copy.instrument} has status "${copy.status}"`);
    assert.ok(copy.note, `${copy.instrument} must say what its status costs`);
    assert.deepEqual(Object.keys(copy.sha256).sort(), [...SHARED_ORACLE_FILES].sort());
  }

  // The guard itself: pretend the oracle changed and confirm an in-sync entry
  // fails, so this test cannot pass vacuously.
  const drifted = {
    ...currentPins(),
    shared_oracle: { ...currentPins().shared_oracle, "lib/oracles.js": "0".repeat(64) },
  };
  const problems = verifyPins(recorded, drifted);
  assert.ok(
    problems.some((problem) => problem.includes("recorded in-sync")),
    "a drifted shared oracle must fail the vendored-copy check",
  );
});

test("the pin digests are the digests of the files themselves", () => {
  const recorded = readPins();
  for (const [file, digest] of Object.entries({ ...recorded.shared_oracle, ...recorded.bench_scoring })) {
    assert.equal(sha256(path.join(BENCH, file)), digest, file);
  }
  assert.equal(PINS_FILE.endsWith(path.join("bench", "oracle-pins.json")), true);
});
