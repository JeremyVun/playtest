// Heal triage and heal acceptance (docs/contracts/engine.md#act-and-heal).
//
// The two acceptance rules are the point of P4, so they are tested one at a
// time: each case below holds everything else green and moves exactly one input,
// which means deleting either guard turns one of these red.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HEAL_ACCEPTED_ENDINGS,
  acceptHeal,
  classifyHealFailure,
  diffProjections,
  evaluatedPostconditions,
  provisioningSteps,
} from "../../../src/core/heal.ts";

const hardCheck = (over: LegacyTestValue = {}): LegacyTestValue => ({ kind: "api_called", severity: "hard", spec: "api_called: POST /accounts", pass: true, applicable: true, ...over });
const greenGate = (checks: LegacyTestValue[] = [hardCheck()]): LegacyTestValue => ({ pass: checks.every((c: LegacyTestValue) => c.pass), hardPass: true, checks });
const heal = (over: LegacyTestValue = {}): LegacyTestValue => acceptHeal({ driver: "api", mode: "heal", endReason: "done", gate: greenGate(), ...over });

// ---- rule 1: the ending is an allowlist ----

test("an API heal is accepted only from the actor's own done", () => {
  assert.deepEqual(HEAL_ACCEPTED_ENDINGS, ["done"], "the allowlist is exactly done — widening it is a contract change");
  assert.equal(heal().ok, true, "a heal that reached done with a real postcondition is acceptable");

  // Every other ending, including ones that do not exist yet. `stuck` is the one
  // the design calls out: today it is a non-error ending, so before this guard it
  // counted as reaching the goal and could be recorded as a passing changed journey.
  for (const ending of ["stuck", "give_up", "max_steps", "timeout", "error", "something_new"]) {
    const verdict = heal({ endReason: ending });
    assert.equal(verdict.ok, false, `a heal ending "${ending}" must never be accepted`);
    assert.match(verdict.reason, /not "done"/);
  }
});

// ---- rule 2: the gate must be non-vacuous ----

test("an API heal is accepted only when an applicable hard deterministic postcondition evaluated", () => {
  // An empty success list. gate.pass is vacuously true — which is exactly the
  // hole: before this guard, a heal with no criteria at all went green.
  const empty = heal({ gate: { pass: true, hardPass: true, checks: [] } });
  assert.equal(empty.ok, false, "an empty gate proves nothing, so it can never accept a heal");
  assert.match(empty.reason, /no applicable hard deterministic postcondition/);

  // Soft checks are budgets, not goal postconditions.
  const softOnly = heal({ gate: greenGate([{ kind: "console_errors", severity: "soft", spec: "console_errors: 0", pass: true, applicable: true }]) });
  assert.equal(softOnly.ok, false, "a soft-only gate is still vacuous as a goal postcondition");

  // A model assert can flip run to run; a heal must not rest on it alone.
  const assertOnly = heal({ gate: greenGate([{ kind: "assert", severity: "hard", spec: "assert: it worked", pass: true, applicable: true }]) });
  assert.equal(assertOnly.ok, false, "a model judgement is not a DETERMINISTIC postcondition");

  // A declared invariant the story never exercised has not held.
  const notExercised = heal({
    gate: greenGate([{ kind: "invariant", severity: "hard", spec: "invariant: idempotency op=POST /entries", pass: false, applicable: false }]),
  });
  assert.equal(notExercised.ok, false, "a not-applicable policy is not an evaluated postcondition");

  // An inherited verdict was decided against a DIFFERENT trajectory.
  const inheritedOnly = heal({ gate: greenGate([hardCheck({ inherited: true })]) });
  assert.equal(inheritedOnly.ok, false, "a verdict inherited from the baseline did not evaluate on the healed trajectory");

  // One real check is enough — and it is what evaluatedPostconditions reports.
  const mixed = greenGate([
    { kind: "console_errors", severity: "soft", spec: "console_errors: 0", pass: true, applicable: true },
    hardCheck({ kind: "response_status", spec: "response_status: POST /accounts 201 (all)" }),
  ]);
  assert.equal(heal({ gate: mixed }).ok, true);
  assert.deepEqual(evaluatedPostconditions(mixed).map((c) => c.kind), ["response_status"]);
});

test("the acceptance guard is api-scoped and heal-scoped: web, mobile, and non-heal runs are untouched", () => {
  const vacuous = { endReason: "stuck", gate: { pass: true, hardPass: true, checks: [] } };
  assert.equal(acceptHeal({ driver: "web", mode: "heal", ...vacuous }).ok, true, "web healing is unchanged");
  assert.equal(acceptHeal({ driver: "mobile", mode: "heal", ...vacuous }).ok, true, "mobile healing is unchanged");
  assert.equal(acceptHeal({ driver: "api", mode: "act", ...vacuous }).ok, true, "a clean act replay is not a heal");
  assert.equal(acceptHeal({ driver: "api", mode: "record", ...vacuous }).ok, true, "a first record is not a heal");
});

test("a regression classification blocks acceptance, and the guard can only ever subtract", () => {
  assert.equal(heal({ classification: "regression" }).ok, false, "there is no valid rebind for a goal that is gone");
  assert.match(heal({ classification: "regression" }).reason, /regression/);
  assert.equal(heal({ classification: "contract_drift" }).ok, true);
  assert.equal(heal({ classification: "baseline_drift" }).ok, true);
  // The guard never rescues a failing gate: it returns ok, and the caller still
  // ANDs it with gate.pass. Proven here by the fact that a red gate with a happy
  // classification is still "ok" from this function's point of view — the
  // acceptance decision is a necessary condition, never a sufficient one.
  const redGate = { pass: false, hardPass: false, checks: [hardCheck({ pass: false })] };
  assert.equal(heal({ gate: redGate, classification: "contract_drift" }).ok, true);
});

// ---- triage ----

test("triage names a regression when a refusal disappears", () => {
  const verdict: LegacyTestValue = classifyHealFailure({
    baselineStep: { step: 4, expect: { status: 409 } },
    baselineEnvelopes: [],
    kind: "drift",
    reason: "the acted step answered 201 where the baseline recorded 409",
    observedStatus: 201,
  });
  assert.equal(verdict.classification, "regression");
  assert.equal(verdict.signals[0].kind, "refusal_lost");
  assert.match(verdict.signals[0].detail, /accepted what it used to reject/);
});

test("triage names a regression on a 5xx and on a vanished bound resource", () => {
  assert.equal(
    classifyHealFailure({ baselineStep: { step: 2, expect: { status: 200 } }, observedStatus: 503 }).classification,
    "regression",
  );
  const vanished: LegacyTestValue = classifyHealFailure({
    baselineStep: { step: 3, expect: { status: 200 }, bindings: [{ name: "id_1", from_step: 1, from: "$.id", into: ["path"] }] as LegacyTestValue }, // TODO(ts): legacy fixture binding predates the current binding contract
    observedStatus: 404,
  });
  assert.equal(vanished.classification, "regression");
  assert.equal(vanished.signals[0].kind, "resource_vanished");
  // The same 404 on a STATIC path is a moved endpoint, not a disappearing record.
  const moved = classifyHealFailure({ baselineStep: { step: 3, expect: { status: 200 } }, observedStatus: 404 });
  assert.equal(moved.classification, "contract_drift");
});

test("triage names baseline drift when the journey's own provisioning fails against a target that is not clean", () => {
  const baselineEnvelopes: LegacyTestValue[] = [
    { step: 1, agent: { action: { type: "request", method: "POST", path: "/accounts" } } },
    { step: 2, bindings: [{ name: "id_1", from_step: 1, from: "$.id", into: ["path"] }] },
  ];
  assert.deepEqual([...provisioningSteps(baselineEnvelopes)], [1], "a step later steps bind from is a provisioning step");

  const conflict: LegacyTestValue = classifyHealFailure({ baselineStep: { step: 1, expect: { status: 201 } }, baselineEnvelopes, observedStatus: 409 });
  assert.equal(conflict.classification, "baseline_drift");
  assert.equal(conflict.signals[0].kind, "provisioning_failed");

  // The same conflict on a step nothing depends on is not an environment signal.
  const late = classifyHealFailure({ baselineStep: { step: 2, expect: { status: 201 } }, baselineEnvelopes, observedStatus: 409 });
  assert.equal(late.classification, "contract_drift");
});

test("triage reads a renamed field straight out of the two response projections", () => {
  const before = 'API: /\nLast response: 200\nBody shape (api-projection-v1):\n{"balance":"number","id":"string"}';
  const after = 'API: /\nLast response: 200\nBody shape (api-projection-v1):\n{"available_balance":"number","id":"string"}';
  const verdict = classifyHealFailure({ baselineStep: { step: 5 }, kind: "drift", reason: "the page changed", baselineProjection: before, freshProjection: after });
  assert.equal(verdict.classification, "contract_drift");
  assert.deepEqual(verdict.signals, [{ kind: "field_renamed", detail: "$.balance was renamed to $.available_balance" }]);
});

test("projection diffing reports adds, removes, and status moves", () => {
  const shape = (status: number, body: LegacyTestValue) => `API: /\nLast response: ${status}\nBody shape (api-projection-v1):\n${JSON.stringify(body)}`;
  assert.deepEqual(
    diffProjections(shape(200, { id: "string" }), shape(200, { id: "string", owner: "string" })),
    [{ kind: "field_added", detail: "$.owner is new in the response" }],
  );
  assert.deepEqual(
    diffProjections(shape(200, { id: "string", note: "string" }), shape(200, { id: "string" })),
    [{ kind: "field_removed", detail: "$.note is no longer in the response" }],
  );
  const moved = diffProjections(shape(201, { id: "string" }), shape(202, { id: "string" }));
  assert.deepEqual(moved, [{ kind: "status_changed", detail: "the response status moved from 201 to 202" }]);
  assert.deepEqual(diffProjections(null, null), [], "no oracle, no signals");
});
