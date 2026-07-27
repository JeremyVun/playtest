// Lifecycle-hook registry: discover a suite's hooks/before_each.js and run it as
// a pre-actor setup phase. See docs/contracts/engine.md#environment-and-setup.
// A hook is the
// pre-actor mirror of the custom-assertion observing phase: trusted, author-owned
// code, convention-discovered (no YAML, no schema), NOT sandboxed — it runs with
// the harness's privileges, by design. `before_each` runs once per run (record /
// act / heal — it does not matter; the world it sets up is the same), before the
// loop, and may hand a small string back into the actor's context (see runner.js
// + actor.ts setupContext).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DummyConfigError } from "./config.ts";
import { firstLine } from "./trajectory.ts";

// The setupContext cap (docs/contracts/engine.md#environment-and-setup): the
// string rides EVERY actor turn, so a runaway
// value inflates every call. 2 KB comfortably holds a handle + creds + a sentence
// of context; anything larger is almost certainly an accident (a dumped JSON
// blob). Over-cap is a DummyConfigError (fail fast — don't silently truncate a
// credential). Measured in UTF-8 bytes, the unit the prompt is billed in.
export const SETUP_CONTEXT_CAP_BYTES = 2048;

export interface HookRegistry {
  beforeEach: ((context: object) => unknown) | null;
}

// One registry per suite root (a multi-case suite imports its hook once).
const cache = new Map<string, HookRegistry>(); // suiteRoot → { beforeEach: fn|null }

/**
 * Discover the suite's before_each hook. Looks for
 * <suiteRoot>/hooks/before_each.js — absent is the common case (an empty
 * registry, NOT an error), present is dynamic-imported and validated to
 * default-export a function. Cached by suiteRoot. Every failure is a
 * DummyConfigError (friendly, named — never a raw stack / MODULE_NOT_FOUND).
 * @param {string} suiteRoot
 * @returns {Promise<{ beforeEach: ((ctx: object) => unknown)|null }>}
 */
export async function loadHooks(suiteRoot: string): Promise<HookRegistry> {
  if (cache.has(suiteRoot)) return cache.get(suiteRoot);

  const file = path.join(suiteRoot, "hooks", "before_each.js");
  if (!fs.existsSync(file)) {
    // No hooks/before_each.js is the common case — an empty registry, not an
    // error. A suite with no hook is completely unaffected (web golden control).
    const empty = { beforeEach: null };
    cache.set(suiteRoot, empty);
    return empty;
  }

  let mod: { default?: unknown };
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (e) {
    throw new DummyConfigError(
      `before_each hook failed to load (hooks/before_each.js): ${firstLine(e)}`,
    );
  }
  const beforeEach = mod.default;
  if (typeof beforeEach !== "function") {
    throw new DummyConfigError(
      `before_each hook (hooks/before_each.js) must default-export an async function`,
    );
  }

  const registry: HookRegistry = { beforeEach };
  cache.set(suiteRoot, registry);
  return registry;
}

/**
 * Validate a before_each return value
 * (docs/contracts/engine.md#environment-and-setup). A hook returns nothing (stays
 * invisible) or a string under the cap; anything else is a DummyConfigError
 * naming the file. Returns the value coerced to a string|null for the actor.
 * @param {unknown} value
 * @returns {string|null}
 */
export function validateSetupContext(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new DummyConfigError(
      `before_each hook (hooks/before_each.js) must return a string or nothing, got ${typeof value}`,
    );
  }
  // An empty/whitespace-only return is functionally "no context": the actor only
  // injects the setup message for a truthy string, so coerce to null here too —
  // otherwise manifest.setup.returned_context would claim context the actor never
  // saw.
  if (value.trim() === "") return null;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > SETUP_CONTEXT_CAP_BYTES) {
    throw new DummyConfigError(
      `before_each hook (hooks/before_each.js) returned ${bytes} bytes of setup context — the cap is ${SETUP_CONTEXT_CAP_BYTES} (it rides every actor turn; return only a handle + creds + a sentence)`,
    );
  }
  return value;
}

/** Test-only: clear the per-suite cache so a fixture re-scan re-imports. */
export function _clearHookCache() {
  cache.clear();
}
