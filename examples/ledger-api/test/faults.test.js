// The development-set fault catalog (DESIGN §6.3).
//
// Two things must hold, and both are tested exhaustively rather than by
// example: every fault manifests when it is enabled, and no fault changes any
// behaviour except its own.

import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./support/harness.js";
import { MANIFESTATIONS } from "./support/manifestations.js";
import {
  FAULT_IDS,
  DEVELOPMENT_FAULT_IDS,
  HELD_OUT_FAULT_IDS,
  SEALED_FAULT_IDS,
  FAULT_TIERS,
  FAULT_CATEGORIES,
  CATEGORY_IDS,
  FAULT_DESCRIPTIONS,
  FaultSet,
  parseFaults,
} from "../src/faults.js";

const tiered = (ids, tier) => ids.filter((id) => FAULT_TIERS[id] === tier).length;

async function probeWith(faults, manifestation) {
  const fixture = await startFixture({ faults });
  try {
    return await manifestation.probe(fixture.client);
  } finally {
    await fixture.close();
  }
}

test("the catalog is the development set plus the sealed held-out set, tiered and described", () => {
  assert.equal(DEVELOPMENT_FAULT_IDS.length, 8);
  assert.equal(tiered(DEVELOPMENT_FAULT_IDS, "schema-reachable"), 2);
  assert.equal(tiered(DEVELOPMENT_FAULT_IDS, "semantic"), 6);

  // DESIGN §6.3: at least four held-out faults, at least three semantic-tier.
  assert.ok(HELD_OUT_FAULT_IDS.length >= 4, `held-out set is ${HELD_OUT_FAULT_IDS.length} faults`);
  assert.ok(tiered(HELD_OUT_FAULT_IDS, "semantic") >= 3);
  assert.equal(
    tiered(HELD_OUT_FAULT_IDS, "semantic") + tiered(HELD_OUT_FAULT_IDS, "schema-reachable"),
    HELD_OUT_FAULT_IDS.length,
  );
  for (const id of HELD_OUT_FAULT_IDS) assert.equal(DEVELOPMENT_FAULT_IDS.includes(id), false, id);

  assert.deepEqual(FAULT_IDS, [...DEVELOPMENT_FAULT_IDS, ...HELD_OUT_FAULT_IDS, ...SEALED_FAULT_IDS]);
  assert.equal(new Set(FAULT_IDS).size, FAULT_IDS.length);
  for (const id of FAULT_IDS) {
    assert.equal(typeof FAULT_DESCRIPTIONS[id], "string");
    assert.ok(FAULT_DESCRIPTIONS[id].length > 10, id);
  }
});

test("the S0 sealed set meets the composition the preregistration committed to", () => {
  // studies/api-suite/PREREGISTRATION.md §4.2: at least eleven faults, at
  // least eight semantic-tier, at least two temporal-boundary, and at least
  // one in at least six of the eight taxonomy categories.
  assert.ok(SEALED_FAULT_IDS.length >= 11, `sealed set is ${SEALED_FAULT_IDS.length} faults`);
  assert.ok(tiered(SEALED_FAULT_IDS, "semantic") >= 8);
  assert.equal(
    tiered(SEALED_FAULT_IDS, "semantic") + tiered(SEALED_FAULT_IDS, "schema-reachable"),
    SEALED_FAULT_IDS.length,
  );

  const inCategory = (category) => SEALED_FAULT_IDS.filter((id) => FAULT_CATEGORIES[id] === category);
  assert.ok(inCategory("temporal-boundary").length >= 2);
  const covered = CATEGORY_IDS.filter((category) => inCategory(category).length > 0);
  assert.ok(covered.length >= 6, `sealed set covers ${covered.length} categories: ${covered.join(", ")}`);

  for (const id of SEALED_FAULT_IDS) {
    assert.equal(DEVELOPMENT_FAULT_IDS.includes(id), false, id);
    assert.equal(HELD_OUT_FAULT_IDS.includes(id), false, id);
  }
});

test("LEDGER_FAULTS parsing accepts a list and reports unknown ids", () => {
  assert.deepEqual(parseFaults("f-close-ghost, f-pagination-dup"), {
    ids: ["f-close-ghost", "f-pagination-dup"],
    unknown: [],
  });
  assert.deepEqual(parseFaults(""), { ids: [], unknown: [] });
  assert.deepEqual(parseFaults(undefined), { ids: [], unknown: [] });
  assert.deepEqual(parseFaults("f-close-ghost,f-close-ghost"), { ids: ["f-close-ghost"], unknown: [] });
  assert.deepEqual(parseFaults("f-typo,f-close-ghost"), { ids: ["f-close-ghost"], unknown: ["f-typo"] });
  assert.throws(() => new FaultSet(["f-typo"]), /unknown fault id/);
  assert.deepEqual(new FaultSet(["f-pagination-dup", "f-error-200"]).list(), ["f-error-200", "f-pagination-dup"]);
});

for (const manifestation of MANIFESTATIONS) {
  test(`${manifestation.fault} manifests when enabled, and the clean build ${manifestation.title}`, async () => {
    const faulty = await probeWith([manifestation.fault], manifestation);
    assert.equal(faulty.manifested, true, `fault did not fire: ${faulty.evidence}`);

    const clean = await probeWith([], manifestation);
    assert.equal(clean.manifested, false, `clean build exhibited the fault: ${clean.evidence}`);
    assert.equal(clean.clean, true, `clean build broke its own contract: ${clean.evidence}`);
  });
}

test("every fault toggles independently: the full on/off matrix", async () => {
  const configurations = [[], ...FAULT_IDS.map((id) => [id])];
  const failures = [];
  for (const configuration of configurations) {
    for (const manifestation of MANIFESTATIONS) {
      const result = await probeWith(configuration, manifestation);
      const shouldManifest = configuration.includes(manifestation.fault);
      if (result.manifested !== shouldManifest) {
        failures.push(
          `[${configuration.join(",") || "clean"}] ${manifestation.fault}: manifested=${result.manifested}, ` +
            `expected ${shouldManifest} — ${result.evidence}`,
        );
      }
      // With the fault off, the probed behaviour must be exactly the clean one:
      // an unrelated fault may not perturb it.
      if (!shouldManifest && result.clean !== true) {
        failures.push(
          `[${configuration.join(",") || "clean"}] ${manifestation.fault}: clean contract broken — ${result.evidence}`,
        );
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("faults compose: with every fault enabled, every fault still manifests", async () => {
  const failures = [];
  for (const manifestation of MANIFESTATIONS) {
    const result = await probeWith([...FAULT_IDS], manifestation);
    if (!result.manifested) failures.push(`${manifestation.fault}: ${result.evidence}`);
  }
  assert.deepEqual(failures, []);
});

test("the enabled faults are never disclosed over HTTP", async () => {
  const fixture = await startFixture({ faults: [...FAULT_IDS] });
  try {
    for (const path of ["/health", "/openapi.json", "/accounts", "/transfers"]) {
      const response = await fixture.client.get(path);
      for (const id of FAULT_IDS) assert.equal(response.raw.includes(id), false, `${path} leaked ${id}`);
      assert.equal(/f-[a-z-]*(ghost|drift|dup|stale|race|replay|200|500)/.test(response.raw), false, path);
      assert.equal(/LEDGER_FAULTS/i.test(response.raw), false, path);
    }
  } finally {
    await fixture.close();
  }
});
