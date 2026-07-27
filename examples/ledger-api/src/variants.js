// The conforming-variant catalog (docs/backlog/api-testing/DESIGN.md §7,
// BUILD_PLAN.md S0).
//
// A variant is NOT a fault. Enabling one must never produce a violation of
// any declared invariant (`x-ledger-invariants`) or of the OpenAPI document
// itself — it is a different, equally legal implementation choice sitting
// inside the same contract. The study needs these to tell apart a test suite
// that encodes the *contract* from one that has merely snapshotted the
// canonical implementation: a suite that fails against a conforming variant
// has done the latter, which is a false positive on the suite's part, not a
// bug in the variant.
//
// Variants are OFF unless explicitly enabled, individually toggleable, and
// orthogonal to the fault catalog: a variant build with no fault enabled must
// still satisfy every oracle and every documented schema, and the canonical
// build (no variant enabled) is byte-identical to the fixture's behaviour
// before variants existed.

/** The three conforming variants. */
export const VARIANT_IDS = Object.freeze(["terse-optionals", "trailing-page", "wide-ids"]);

/** One-line description per variant, for `--help` style output. */
export const VARIANT_DESCRIPTIONS = Object.freeze({
  "terse-optionals":
    "optional, nullable response properties are omitted entirely when null instead of emitted as null",
  "trailing-page":
    "a full page always carries a next_cursor, so an enumeration ends on one empty trailing page instead of on the last full one",
  "wide-ids":
    "identifiers are drawn as 26-character tokens instead of 10; the fixed system fee-account ids are unchanged",
});

/**
 * Parse a `LEDGER_VARIANT` style specification: a comma (or whitespace)
 * separated list of variant ids. Returns `{ ids, unknown }`; the caller
 * decides whether an unknown id is fatal (the server treats it as a startup
 * error so a typo never silently measures the canonical build).
 */
export function parseVariants(spec) {
  const parts = String(spec ?? "")
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const ids = [];
  const unknown = [];
  for (const part of parts) {
    if (VARIANT_IDS.includes(part)) {
      if (!ids.includes(part)) ids.push(part);
    } else if (!unknown.includes(part)) {
      unknown.push(part);
    }
  }
  return { ids, unknown };
}

/** An immutable, order-independent set of enabled variants. */
export class VariantSet {
  #ids;

  constructor(ids = []) {
    const list = Array.isArray(ids) ? ids : parseVariants(ids).ids;
    const unknown = list.filter((id) => !VARIANT_IDS.includes(id));
    if (unknown.length) {
      throw new Error(`unknown variant id(s): ${unknown.join(", ")}. Known ids: ${VARIANT_IDS.join(", ")}`);
    }
    this.#ids = new Set(list);
  }

  has(id) {
    return this.#ids.has(id);
  }

  get size() {
    return this.#ids.size;
  }

  list() {
    return VARIANT_IDS.filter((id) => this.#ids.has(id));
  }
}
