// Heal triage and heal acceptance (docs/contracts/engine.md#act-and-heal).
//
// On an acted-step failure the harness classifies BEFORE it patches. The
// classification is computed here, from recorded evidence only — statuses, the
// response projection either side of the failure, and the baseline's own binding
// graph. No model is consulted, so nothing in this file is a model verdict
// (DESIGN D2): the model's whole role is proposing the rebind the heal loop
// explores and writing the drift report's narrative.
//
// Three classes (DESIGN §5.3):
//
//   regression      the workflow goal is no longer achievable — a 5xx, a refusal
//                   the API stopped making, or a resource this journey created
//                   that has vanished. Red, loudly.
//   contract drift  the goal is still achievable through a changed surface — a
//                   renamed field, a new required parameter. Rebind, emit the
//                   drift report, hold the changed journey for review.
//   baseline drift  the environment moved: the journey's own provisioning steps
//                   fail against a target that is no longer clean.
//
// The classification can only make a run REDDER, never greener: `acceptHeal`
// treats it as one necessary condition among several, and the deterministic gate
// still has to pass on its own. That is what keeps D2 sharp — a mislabelled
// contract drift cannot turn a failing gate green, and no confidence score has
// authority over the exit code.
//
// Two rules in `acceptHeal` are the reason this module exists at all. Before
// them, every non-`error` ending counted as reaching the goal (so a heal that
// ended `stuck` could be recorded as a passing changed journey) and an empty
// `success` list passed trivially (so a heal could go green having proven
// nothing). Both are now impossible on the api driver:
//
//   * the ending is an ALLOWLIST — only the actor's own `done` is accepted, so
//     `give_up`, `max_steps`, `stuck`, `timeout`, and any future end reason are
//     rejected by construction rather than by enumeration;
//   * the gate must be NON-VACUOUS — at least one applicable hard deterministic
//     postcondition must actually have evaluated on the healed trajectory.
import type { StepEnvelope } from "./trajectory.ts";

type DynamicValue = any; // TODO(ts): projected response bodies are arbitrary JSON shapes

export type HealClassification = "baseline_drift" | "contract_drift" | "regression";

export interface HealSignal {
  kind: string;
  detail: string;
}

interface HealEnvelope extends StepEnvelope {
  bindings?: Array<{ from_step?: number; into?: unknown[] }>;
  expect?: { status?: number };
}

interface HealEvidence {
  baselineStep?: HealEnvelope | null;
  baselineEnvelopes?: HealEnvelope[];
  kind?: "drift" | "action_failed" | null;
  reason?: string | null;
  observedStatus?: number | null;
  transportError?: string | null;
  baselineProjection?: string | null;
  freshProjection?: string | null;
}

export interface HealTriage {
  classification: HealClassification;
  signals: HealSignal[];
  provisioning: boolean;
  expected_status: number | null;
  observed_status: number | null;
}

export interface GateCheckLike {
  spec?: string;
  severity?: string;
  kind?: string;
  pass?: boolean;
  applicable?: boolean;
  inherited?: boolean;
  detail?: string;
}

export interface GateLike {
  pass?: boolean;
  checks?: GateCheckLike[];
}

/** The only end reasons an API heal may be accepted from. An allowlist on purpose. */
export const HEAL_ACCEPTED_ENDINGS = ["done"];

/** The triage vocabulary, in escalating order of "how red is this". */
export const HEAL_CLASSIFICATIONS = ["baseline_drift", "contract_drift", "regression"];

/** Statuses that read as "the target was not clean" rather than "the API changed". */
const ENVIRONMENT_STATUSES = [409, 412, 423];
/** Statuses that read as "this resource is gone". */
const GONE_STATUSES = [404, 410];

const is2xx = (s: unknown) => Number(s) >= 200 && Number(s) < 300;
const is4xx = (s: unknown) => Number(s) >= 400 && Number(s) < 500;
const is5xx = (s: unknown) => Number(s) >= 500;

/**
 * Step numbers the journey's own later steps depend on: any baseline step cited
 * as a binding's `from_step`. These are the workflow's PROVISIONING steps — the
 * writes it performs to build the state it goes on to read. A failure here
 * against a supposedly clean target is the deterministic baseline-drift signal
 * (DESIGN §5.3), not a model call. Pure; exported for test.
 */
export function provisioningSteps(baselineEnvelopes: HealEnvelope[] = []): Set<number> {
  const out = new Set<number>();
  for (const env of baselineEnvelopes ?? []) {
    for (const b of env.bindings ?? []) {
      if (typeof b?.from_step === "number") out.add(b.from_step);
    }
  }
  return out;
}

/**
 * Classify an acted-step failure from recorded evidence.
 *
 * @param {{ baselineStep: object|null, baselineEnvelopes: object[],
 *          kind: "drift"|"action_failed"|null, reason: string|null,
 *          observedStatus: number|null, transportError: string|null,
 *          baselineProjection: string|null, freshProjection: string|null }} evidence
 * @returns {{ classification: string, signals: {kind: string, detail: string}[],
 *            provisioning: boolean, expected_status: number|null, observed_status: number|null }}
 */
export function classifyHealFailure(evidence: HealEvidence = {}): HealTriage {
  const {
    baselineStep = null,
    baselineEnvelopes = [],
    kind = null,
    reason = null,
    observedStatus = null,
    transportError = null,
    baselineProjection = null,
    freshProjection = null,
  } = evidence;

  const expected = baselineStep?.expect?.status ?? null;
  const provisioning = baselineStep?.step != null && provisioningSteps(baselineEnvelopes).has(baselineStep.step);
  const signals: HealSignal[] = [];
  const surface = diffProjections(baselineProjection, freshProjection);
  signals.push(...surface);

  // 1. A server error is never a surface change: the goal is not achievable.
  if (observedStatus != null && is5xx(observedStatus)) {
    signals.unshift({ kind: "server_error", detail: `the acted step answered ${observedStatus}` });
    return verdict("regression", signals, { provisioning, expected, observedStatus });
  }
  // 2. The API stopped refusing what it used to refuse. This is the shape of a
  //    seeded semantic fault (a closed account that keeps transacting): the
  //    baseline recorded a refusal and the same call now succeeds.
  if (expected != null && observedStatus != null && is4xx(expected) && is2xx(observedStatus)) {
    signals.unshift({
      kind: "refusal_lost",
      detail: `the baseline recorded a refusal (${expected}) and the same call now answers ${observedStatus} — the API accepted what it used to reject`,
    });
    return verdict("regression", signals, { provisioning, expected, observedStatus });
  }
  // 3. A resource this journey itself created has vanished. A 404 on a path the
  //    journey BOUND (an id an earlier step produced) is a disappearing record;
  //    a 404 on a static path is a moved endpoint, which is contract drift.
  if (expected != null && observedStatus != null && is2xx(expected) && GONE_STATUSES.includes(Number(observedStatus)) && bindsAnId(baselineStep)) {
    signals.unshift({
      kind: "resource_vanished",
      detail: `${observedStatus} on a path bound to a resource this journey created (baseline recorded ${expected})`,
    });
    return verdict("regression", signals, { provisioning, expected, observedStatus });
  }
  // 4. Baseline drift: the journey's own provisioning failed against a target
  //    that should have been clean — a conflict, a precondition, or no response
  //    at all. An environment signal, not an API change.
  if (provisioning && (transportError || (observedStatus != null && ENVIRONMENT_STATUSES.includes(Number(observedStatus))))) {
    signals.unshift({
      kind: "provisioning_failed",
      detail: transportError
        ? `the provisioning step could not complete: ${transportError}`
        : `the provisioning step answered ${observedStatus}, which reads as a target that was not clean`,
    });
    return verdict("baseline_drift", signals, { provisioning, expected, observedStatus });
  }
  // 5. Everything else is a changed surface the goal may still be reachable
  //    through. It is the CHEAPEST class to be wrong about, because a
  //    contract-drift heal still has to pass the whole deterministic gate before
  //    it is accepted (acceptHeal), so a misfiled regression fails there instead.
  if (!signals.length) {
    signals.push({ kind: kind === "action_failed" ? "action_failed" : "surface_changed", detail: reason ?? "the recorded step no longer replays" });
  }
  return verdict("contract_drift", signals, { provisioning, expected, observedStatus });
}

function verdict(
  classification: HealClassification,
  signals: HealSignal[],
  {
    provisioning,
    expected,
    observedStatus
  }: { provisioning: boolean; expected: number | null; observedStatus: number | null }
): HealTriage {
  return { classification, signals, provisioning, expected_status: expected ?? null, observed_status: observedStatus ?? null };
}

/** Does this baseline step address a resource through a `{{name}}` substitution? */
function bindsAnId(baselineStep: HealEnvelope | null) {
  return (baselineStep?.bindings ?? []).some((b) => (b?.into ?? []).some((site: unknown) => String(site).startsWith("path")));
}

/**
 * What moved between the baseline's response projection and the fresh one:
 * renamed, added, and removed fields, and a changed status line. This is the
 * "what changed" half of the drift report, computed deterministically so the
 * model never has to be trusted for it. Pure; exported for test.
 * @returns {{ kind: string, detail: string }[]}
 */
export function diffProjections(before: unknown, after: unknown): HealSignal[] {
  const a = projectionBody(before);
  const b = projectionBody(after);
  const signals: HealSignal[] = [];
  const beforeStatus = projectionStatus(before);
  const afterStatus = projectionStatus(after);
  if (beforeStatus && afterStatus && beforeStatus !== afterStatus) {
    signals.push({ kind: "status_changed", detail: `the response status moved from ${beforeStatus} to ${afterStatus}` });
  }
  if (a === undefined || b === undefined) return signals;
  const was = new Set(shapePaths(a));
  const now = new Set(shapePaths(b));
  const removed = [...was].filter((p) => !now.has(p));
  const added = [...now].filter((p) => !was.has(p));
  // A removal paired with an addition at the same depth reads as a RENAME, which
  // is the single most common contract drift and the one worth naming exactly.
  const renamed: Array<{ from: string; to: string }> = [];
  for (const gone of removed.slice()) {
    const parent = gone.slice(0, gone.lastIndexOf("."));
    const twin = added.find((p) => p.slice(0, p.lastIndexOf(".")) === parent && !renamed.some((r) => r.to === p));
    if (twin) renamed.push({ from: gone, to: twin });
  }
  for (const { from, to } of renamed) {
    signals.push({ kind: "field_renamed", detail: `${from} was renamed to ${to}` });
  }
  for (const p of removed.filter((x) => !renamed.some((r) => r.from === x))) {
    signals.push({ kind: "field_removed", detail: `${p} is no longer in the response` });
  }
  for (const p of added.filter((x) => !renamed.some((r) => r.to === x))) {
    signals.push({ kind: "field_added", detail: `${p} is new in the response` });
  }
  return signals;
}

/** The status a persisted api projection recorded, as a string, or null. */
function projectionStatus(text: unknown): string | null {
  const m: DynamicValue = String(text ?? "").match(/^Last response: (\d{3})/m);
  return m ? m[1] : null;
}

/** The projected body of a persisted api snapshot, parsed, or undefined. */
function projectionBody(text: unknown): unknown {
  const s = String(text ?? "");
  const idx = s.lastIndexOf("\n");
  if (idx === -1) return undefined;
  try {
    return JSON.parse(s.slice(idx + 1).trim());
  } catch {
    return undefined;
  }
}

/** Every dotted key path in a projected body shape (arrays collapse to `[]`). */
function shapePaths(node: DynamicValue, prefix = "$", out: string[] = []): string[] {
  if (Array.isArray(node)) {
    // A shape array is per-element; one representative keeps the path set stable
    // when only the LENGTH changed (that is drift the snapshot oracle catches).
    if (node.length) shapePaths(node[0], `${prefix}[]`, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      out.push(`${prefix}.${k}`);
      shapePaths(node[k], `${prefix}.${k}`, out);
    }
  }
  return out;
}

// ---- heal acceptance ----

/**
 * Deterministic checks a hard gate check must clear to count as a real
 * postcondition on the healed trajectory: it must be HARD (a soft console/perf
 * budget is not a goal postcondition), DETERMINISTIC (a model `assert` is not —
 * it can flip run to run, so a heal must not rest on it alone), APPLICABLE (a
 * declared invariant that was never exercised has not held), and freshly
 * evaluated (an inherited verdict was decided against a different trajectory).
 * Pure; exported for test.
 */
export function evaluatedPostconditions(gate: GateLike | null): GateCheckLike[] {
  return (gate?.checks ?? []).filter(
    (c) => c.severity === "hard" && c.kind !== "assert" && c.kind !== "perf" && c.applicable !== false && !c.inherited,
  );
}

/**
 * May this heal be accepted as a changed journey (`status: "pass"` plus
 * `healed: true`)? Scoped to the api driver: web and mobile healing is unchanged
 * (their suites and legacy baselines keep acting exactly as before).
 *
 * @param {{ driver: string, mode: string, endReason: string,
 *          gate: object|null, classification: string|null }} input
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function acceptHeal({
  driver,
  mode,
  endReason,
  gate,
  classification = null
}: {
  driver: string;
  mode: string;
  endReason: string;
  gate: GateLike | null;
  classification?: string | null;
}): { ok: boolean; reason: string | null } {
  if (mode !== "heal" || driver !== "api") return { ok: true, reason: null };
  if (!HEAL_ACCEPTED_ENDINGS.includes(endReason)) {
    return {
      ok: false,
      reason:
        `the heal ended "${endReason}", not "done" — an API heal is accepted only from the actor's own done` +
        ` (accepted endings: ${HEAL_ACCEPTED_ENDINGS.join(", ")}), so reaching the step or time budget never counts as reaching the goal`,
    };
  }
  if (classification === "regression") {
    return {
      ok: false,
      reason: "heal triage classified this failure as a regression — the workflow goal is no longer achievable, so there is no valid rebind to accept",
    };
  }
  const evaluated = evaluatedPostconditions(gate);
  if (!evaluated.length) {
    return {
      ok: false,
      reason:
        "no applicable hard deterministic postcondition evaluated on the healed trajectory — an empty or non-applicable gate proves nothing," +
        " so declare at least one success criterion (api_called, response_status, response_matches, or an invariant policy) before a heal can be accepted",
    };
  }
  return { ok: true, reason: null };
}
