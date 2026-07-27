// Custom-assertion registry: discover a suite's assertions/, register their owned
// success keys, route a key to its assertion's verdict().
// See docs/contracts/engine.md#gates-and-custom-assertions. An assertion is
// trusted code authored by the suite
// owner — no sandbox; it runs with the harness's privileges, by design.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DummyConfigError, BUILTIN_SUCCESS_KINDS } from "./config.ts";
import { firstLine } from "./trajectory.ts";
import type {
  AssertionModule,
  AssertionOwner,
  AssertionRegistry,
  RegisteredAssertion,
} from "./types.ts";

// BUILTIN_SUCCESS_KINDS (the kinds an assertion key may not shadow) is derived in
// config.ts straight from case.schema.json — one source of truth, no hand-kept
// duplicate to drift from SUCCESS_KIND_DRIVERS.

// One registry per suite root (a multi-case suite scans its assertions/ once).
const cache = new Map<string, AssertionRegistry>(); // suiteRoot → { routing, assertions }

/**
 * Discover and register the suite's custom assertions.
 * Scans <suiteRoot>/assertions/*\/assertion.js in directory-scan order, dynamic-imports
 * each, calls keys(), and builds the key → assertion routing table with a hard
 * collision check (vs a built-in kind OR an earlier assertion). Cached by suiteRoot.
 * Every failure is a DummyConfigError (friendly, named — never a raw stack).
 * @param {string} suiteRoot
 * @returns {Promise<{ routing: Map<string, {name: string, assertion: object}>,
 *                     assertions: {name: string, assertion: object, keys: string[]}[] }>}
 */
export async function loadAssertions(suiteRoot: string): Promise<AssertionRegistry> {
  if (cache.has(suiteRoot)) return cache.get(suiteRoot) as AssertionRegistry;

  const routing = new Map<string, AssertionOwner>();
  const assertions: RegisteredAssertion[] = [];
  const assertionsDir = path.join(suiteRoot, "assertions");

  let entries;
  try {
    entries = fs.readdirSync(assertionsDir, { withFileTypes: true });
  } catch {
    // No assertions/ dir is the common case — an empty registry, not an error.
    const empty = { routing, assertions };
    cache.set(suiteRoot, empty);
    return empty;
  }

  // Dir-scan order, but sorted so the load order (and any collision message
  // naming "earlier" assertion) is deterministic across filesystems.
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const name of dirs) {
    const file = path.join(assertionsDir, name, "assertion.js");
    if (!fs.existsSync(file)) continue; // an assertions/ subdir without assertion.js isn't an assertion

    let mod: { default?: unknown };
    try {
      mod = await import(pathToFileURL(file).href);
    } catch (e) {
      throw new DummyConfigError(
        `assertion "${name}" failed to load (assertions/${name}/assertion.js): ${firstLine(e)}`,
      );
    }
    const assertion = mod.default as AssertionModule; // TODO(ts): runtime checks below validate the user-authored module shape
    if (!assertion || typeof assertion !== "object") {
      throw new DummyConfigError(
        `assertion "${name}" (assertions/${name}/assertion.js) must default-export an object with keys()/gather()/verdict()`,
      );
    }
    for (const fn of ["keys", "gather", "verdict"] as const) {
      if (typeof assertion[fn] !== "function") {
        throw new DummyConfigError(
          `assertion "${name}" (assertions/${name}/assertion.js) is missing the ${fn}() function`,
        );
      }
    }
    // Optional `inheritable` (default true): on a clean act replay the gate reuses
    // this assertion's saved verdict instead of re-running gather/verdict
    // (docs/contracts/engine.md#gates-and-custom-assertions).
    // An assertion whose verdict depends on live state the trajectory doesn't pin
    // (e.g. a TTL'd row) sets `inheritable: false` to force a fresh observe+verdict.
    if ("inheritable" in assertion && typeof assertion.inheritable !== "boolean") {
      throw new DummyConfigError(
        `assertion "${name}" (assertions/${name}/assertion.js): inheritable must be a boolean (default true)`,
      );
    }

    let keys;
    try {
      keys = assertion.keys();
    } catch (e) {
      throw new DummyConfigError(`assertion "${name}": keys() threw: ${firstLine(e)}`);
    }
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new DummyConfigError(
        `assertion "${name}": keys() must return a non-empty array of success-key strings`,
      );
    }
    for (const key of keys) {
      if (typeof key !== "string" || !key.trim()) {
        throw new DummyConfigError(`assertion "${name}": keys() must return only non-empty strings`);
      }
      // Collision: never let an assertion shadow a built-in or another assertion — the
      // run never starts (config error naming the key and BOTH owners). One
      // clashing key fails this whole assertion's registration.
      if (BUILTIN_SUCCESS_KINDS.has(key)) {
        throw new DummyConfigError(
          `assertion "${name}": success key "${key}" collides with the built-in "${key}" check — rename the assertion key`,
        );
      }
      const owner = routing.get(key);
      if (owner) {
        throw new DummyConfigError(
          `assertion "${name}": success key "${key}" is already registered by assertion "${owner.name}" — two assertions cannot own the same key`,
        );
      }
      routing.set(key, { name, assertion });
    }
    assertions.push({ name, assertion, keys });
  }

  const registry = { routing, assertions };
  cache.set(suiteRoot, registry);
  return registry;
}

/** The registered assertion keys, for per-suite schema injection (config.ts). */
export function assertionSchemaKeys(routing: AssertionRegistry["routing"]): string[] {
  return [...routing.keys()];
}

/** Test-only: clear the per-suite cache so a fixture re-scan re-imports. */
export function _clearAssertionCache() {
  cache.clear();
}
