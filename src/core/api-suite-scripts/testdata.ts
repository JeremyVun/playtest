import type { DynamicValue } from "./types.ts";

// The test-data lifecycle (DESIGN §6, docs/contracts/scripts.md#test-data-lifecycle).
//
// A mutating suite creates resources on every replay, forever. Two failure modes
// follow, and both are quiet until they are expensive: two concurrent replays
// collide on the same fixture name, and a year of nightly replays silts up the
// environment nobody is watching.
//
// So: every run gets a namespace no other run can produce, and every target
// declares what happens to what the run created. Neither is advisory. The
// namespace is on the client, so a script cannot forget to ask for one; the
// cleanup outcome is a parent-computed column of the report, so a failed cleanup
// cannot be swallowed by the script that caused it.
import crypto from "node:crypto";

import { DummyConfigError } from "../config.ts";

/** The cleanup policies a target may declare. */
export const CLEANUP_POLICIES: DynamicValue = Object.freeze(["reset", "teardown", "none"]);

/** Default ceiling on resources one run may leave behind under `teardown`. */
export const DEFAULT_ACCUMULATION_CAP = 50;

const NAMESPACE_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * A run namespace: collision-proof across concurrent runs on the same target.
 *
 * `pt` + 8 base-36 characters of monotonic clock + 8 of CSPRNG. The clock half
 * keeps namespaces sortable and legible in a target's own data; the random half
 * is what makes a collision between two runs starting in the same millisecond a
 * non-event (2^41 of entropy, drawn per run, never derived from a run id a
 * caller controls).
 */
export function runNamespace({ at = Date.now(), random = crypto.randomBytes }: DynamicValue = {}) {
  const time = at.toString(36).padStart(8, "0").slice(-8);
  const bytes = random(8);
  let tail = "";
  for (let index = 0; index < 8; index += 1) tail += NAMESPACE_ALPHABET[bytes[index] % NAMESPACE_ALPHABET.length];
  return `pt${time}${tail}`;
}

/** Is this a namespace this harness minted? Cheap, and enough to spot a hand-typed one. */
export const isRunNamespace = (value: DynamicValue) => typeof value === "string" && /^pt[0-9a-z]{16}$/.test(value);

/**
 * Resolve a target's declared cleanup policy.
 *
 * ```
 * cleanup: "teardown"
 * cleanup: { policy: "reset", reset: { method: "POST", path: "/admin/reset" } }
 * cleanup: { policy: "teardown", accumulation_cap: 20 }
 * ```
 *
 * `reset` is the harness-owned option and is only available where the target
 * authorization includes one — the owner declared an endpoint that returns the
 * environment to a known state, so nothing accumulates and the cap is moot.
 * `teardown` is best-effort: the suite deletes what it made, the harness counts
 * what survived, and the cap turns silting-up into a failed run.
 */
export function resolveCleanupPolicy(declaration: DynamicValue, { where = "script run", write = true }: DynamicValue = {}) {
  const raw = declaration ?? null;
  const object = typeof raw === "string" ? { policy: raw } : raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (raw !== null && raw !== undefined && !object) {
    throw new DummyConfigError(`${where}: target.cleanup is a policy name or { policy, reset, accumulation_cap }`);
  }
  // A read-only run creates nothing, so it has nothing to clean up; declaring a
  // policy for one is harmless but means nothing, and we say so by resolving to
  // `none` rather than by pretending a reset will run.
  const policy = !write ? "none" : (object?.policy ?? (object?.reset ? "reset" : "teardown"));
  if (!CLEANUP_POLICIES.includes(policy)) {
    throw new DummyConfigError(`${where}: target.cleanup.policy must be one of ${CLEANUP_POLICIES.join(", ")} (got ${JSON.stringify(policy)})`);
  }
  let reset: DynamicValue = null;
  if (object?.reset) {
    const method = String(object.reset.method ?? "POST").toUpperCase();
    const path = object.reset.path ?? object.reset;
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new DummyConfigError(`${where}: target.cleanup.reset.path must be a path on the target beginning with "/" (got ${JSON.stringify(path ?? null)})`);
    }
    reset = { method, path, body: object.reset.body ?? null };
  }
  if (policy === "reset" && !reset) {
    throw new DummyConfigError(
      `${where}: cleanup policy "reset" needs the reset affordance the authorization declared —` +
        ' target.cleanup = { policy: "reset", reset: { method, path } }',
    );
  }
  const cap = object?.accumulation_cap;
  if (cap !== undefined && cap !== null && (!Number.isInteger(Number(cap)) || Number(cap) < 0)) {
    throw new DummyConfigError(`${where}: target.cleanup.accumulation_cap must be a non-negative integer (got ${JSON.stringify(cap)})`);
  }
  return {
    policy,
    reset: policy === "reset" ? reset : null,
    accumulation_cap: policy === "teardown" ? Number(cap ?? DEFAULT_ACCUMULATION_CAP) : null,
  };
}

const WRITE_METHODS: DynamicValue = new Set(["POST", "PUT", "PATCH"]);

const bodyText = (entry: DynamicValue) => {
  const request = entry?.request ?? {};
  return typeof request.postData?.text === "string" ? request.postData.text : "";
};

const pathOf = (entry: DynamicValue) => {
  try {
    return new URL(entry?.request?.url ?? "", "http://x").pathname;
  } catch {
    return String(entry?.request?.url ?? "");
  }
};

/**
 * Account for what this run created, from the recorded traffic alone.
 *
 * The namespaced/unnamespaced split is the mechanically checkable half of the
 * rule: a creating request whose body never mentions the run's namespace made
 * something two concurrent runs can collide on. We report the count rather than
 * refusing the request, because a target may name a resource for the script
 * (server-assigned identifiers are the normal case) — what we can say without
 * guessing is how much of what this run created it labelled as its own.
 *
 * @param {{ harEntries: object[], namespace: string, policy: object }} input
 */
export function accountTestData({ harEntries = [], namespace = "", policy = null }: DynamicValue = {}) {
  let created = 0;
  let namespaced = 0;
  let deleted = 0;
  const collections: DynamicValue = new Map();
  for (const entry of harEntries) {
    const method = String(entry?.request?.method ?? "").toUpperCase();
    const status = Number(entry?.response?.status ?? 0);
    if (status < 200 || status >= 300) continue;
    const collection = `/${pathOf(entry).split("/").filter(Boolean)[0] ?? ""}`;
    if (method === "DELETE") {
      deleted += 1;
      collections.set(collection, (collections.get(collection) ?? 0) - 1);
      continue;
    }
    if (!WRITE_METHODS.has(method) || status !== 201) continue;
    created += 1;
    collections.set(collection, (collections.get(collection) ?? 0) + 1);
    const text = `${bodyText(entry)}\n${pathOf(entry)}\n${entry?.response?.content?.text ?? ""}`;
    if (namespace && text.includes(namespace)) namespaced += 1;
  }
  const outstanding = Math.max(0, created - deleted);
  return {
    namespace,
    created,
    namespaced,
    unnamespaced: created - namespaced,
    deleted,
    outstanding,
    by_collection: Object.fromEntries([...collections].filter(([, count]) => count !== 0).sort()),
    accumulation_cap: policy?.accumulation_cap ?? null,
    over_cap: policy?.accumulation_cap != null && outstanding > policy.accumulation_cap,
  };
}

/**
 * Everything the report says about cleanup, and the reasons a cleanup failure
 * contributes to soundness.
 *
 * A failed cleanup is loud on purpose (DESIGN §6): it is reported, it makes the
 * execution unsound, and it therefore exits 2 rather than reading as a pass with
 * a footnote nobody opens.
 *
 * @returns {{ cleanup: object, reasons: string[] }}
 */
export function accountCleanup({ policy, attempt = null, testData = null }: DynamicValue = {}) {
  const cleanup: DynamicValue = {
    policy: policy?.policy ?? "none",
    reset: policy?.reset ? `${policy.reset.method} ${policy.reset.path}` : null,
    attempted: Boolean(attempt),
    ok: attempt ? attempt.ok === true : policy?.policy !== "reset",
    detail: attempt?.detail ?? null,
    outstanding: testData?.outstanding ?? 0,
    accumulation_cap: policy?.accumulation_cap ?? null,
  };
  const reasons: DynamicValue = [];
  if (cleanup.attempted && !cleanup.ok) {
    reasons.push(`cleanup failed: the declared reset ${cleanup.reset} did not succeed — ${cleanup.detail ?? "no detail"}`);
  }
  if (testData?.over_cap) {
    reasons.push(
      `cleanup left ${testData.outstanding} resource(s) behind, past this target's accumulation cap of ${testData.accumulation_cap} —` +
        " best-effort teardown is not keeping up, and a run that quietly silts up an environment is worse than a red one",
    );
  }
  return { cleanup, reasons };
}
