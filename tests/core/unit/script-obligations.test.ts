// The coverage-obligation manifest: mechanical derivation and accounting
// (docs/contracts/scripts.md#coverage-obligation-manifest). Pure functions, so
// these are the fast unit-level proofs of the soundness rule the integration
// tests then exercise end to end.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  accountObligations,
  deriveObligations,
  normalizeObligations,
  operationObligationId,
  policyObligationId,
  ruleObligationId,
} from "../../../src/core/public/api-suite-scripts.ts";
import { DummyConfigError } from "../../../src/core/config.ts";

const SPEC = {
  operations: [
    { method: "GET", path: "/items" },
    { method: "POST", path: "/items" },
    { method: "GET", path: "/items/{itemId}" },
  ],
};

test("derivation is mechanical: policies, operations, and approved rules, deduped and stable", () => {
  const first = deriveObligations({
    policies: [{ policy: "no_server_error" }, { policy: "no_server_error", scope: "GET /items" }],
    spec: SPEC,
    rules: [{ id: "conservation", statement: "entries of a settled transfer sum to zero" }],
  });
  const second = deriveObligations({
    policies: [{ policy: "no_server_error" }, { policy: "no_server_error", scope: "GET /items" }],
    spec: SPEC,
    rules: [{ id: "conservation", statement: "entries of a settled transfer sum to zero" }],
  });

  assert.deepEqual(first, second, "the same inputs derive the same manifest");
  assert.deepEqual(first.map((entry: LegacyTestValue) => entry.id), [
    "policy:no_server_error",
    "policy:no_server_error scope=GET /items",
    "operation:GET /items",
    "operation:POST /items",
    "operation:GET /items/{itemId}",
    "rule:conservation",
  ]);
  assert.deepEqual(
    [...new Set(first.map((entry: LegacyTestValue) => entry.source))].sort(),
    ["operation", "policy", "rule"],
  );
  assert.equal(policyObligationId({ policy: "no_server_error" }), "policy:no_server_error");
  assert.equal(operationObligationId("get", "/items"), "operation:GET /items");
  assert.equal(ruleObligationId("conservation"), "rule:conservation");
});

test("a duplicate id, an unknown source, and a malformed entry are config errors", () => {
  assert.throws(() => normalizeObligations([{ id: "rule:a" }, { id: "rule:a" }]), DummyConfigError);
  assert.throws(() => normalizeObligations([{ id: "guess:a" }]), DummyConfigError);
  assert.throws(() => normalizeObligations([{ statement: "no id" }]), DummyConfigError);
  assert.throws(() => normalizeObligations([{ id: "rule:a", approved_skip_reasons: "nope" }]), DummyConfigError);
  assert.deepEqual(normalizeObligations(null), []);
});

test("an obligation with no check, no skip, and no traffic is unaccounted — checks do not substitute", () => {
  const accounting = accountObligations({
    obligations: normalizeObligations([
      { id: "rule:a", source: "rule", statement: "a" },
      { id: "rule:b", source: "rule", statement: "b" },
    ]),
    // Twenty passing checks, all on the same obligation.
    records: Array.from({ length: 20 }, (_, index) => ({ kind: "check", id: `a-${index}`, obligation: "rule:a", pass: true })),
  });

  assert.equal(accounting.sound, false, "quantity of checks cannot cover a second obligation");
  assert.equal(accounting.summary.covered, 1);
  assert.equal(accounting.summary.unaccounted, 1);
  assert.match(accounting.reasons.join("\n"), /obligation rule:b is unaccounted/);
  assert.equal(accounting.entries.find((entry) => entry.id === "rule:a").checks.length, 20);
});

test("a skip or unsupported record counts only against an approved reason", () => {
  const obligations = normalizeObligations([
    { id: "rule:a", source: "rule", statement: "a", approved_skip_reasons: ["the endpoint is destructive and unauthorized"] },
    { id: "rule:b", source: "rule", statement: "b" },
  ]);

  const approved = accountObligations({
    obligations,
    records: [
      { kind: "skip", obligation: "rule:a", reason: "The endpoint is destructive and unauthorized" },
      { kind: "check", id: "b", obligation: "rule:b", pass: true },
    ],
  });
  assert.equal(approved.sound, true, "an approved reason (case-insensitive) accounts for the obligation");
  assert.equal(approved.entries.find((entry) => entry.id === "rule:a").status, "skipped");

  const invented = accountObligations({
    obligations,
    records: [
      { kind: "skip", obligation: "rule:a", reason: "seemed hard" },
      { kind: "unsupported", obligation: "rule:b", reason: "no clock affordance" },
    ],
  });
  assert.equal(invented.sound, false);
  assert.equal(invented.summary.unaccounted, 2);
  assert.match(invented.entries.find((entry) => entry.id === "rule:b").reason, /approves no skip reason/);
});

test("a manifest entry declared unsupported is accounted without any record", () => {
  const accounting = accountObligations({
    obligations: normalizeObligations([{ id: "rule:temporal", source: "rule", statement: "a retry across a day boundary", unsupported: true }]),
    records: [],
  });
  assert.equal(accounting.sound, true);
  assert.equal(accounting.entries[0].status, "unsupported");
  assert.match(accounting.entries[0].reason, /declared unsupported/);
});

test("a record naming an obligation outside the manifest is reported, never silently accepted", () => {
  const accounting = accountObligations({
    obligations: normalizeObligations([{ id: "rule:a", source: "rule", statement: "a" }]),
    records: [
      { kind: "check", id: "invented", obligation: "rule:ghost", pass: true },
      { kind: "check", id: "real", obligation: "rule:a", pass: true },
    ],
  });
  assert.equal(accounting.sound, false);
  assert.deepEqual(accounting.unknown, [{ obligation: "rule:ghost", from: 'check "invented"' }]);
  assert.match(accounting.reasons.join("\n"), /not in the manifest/);
});

test("an unexercised check does not cover its obligation", () => {
  const accounting = accountObligations({
    obligations: normalizeObligations([{ id: "rule:a", source: "rule", statement: "a" }]),
    records: [{ kind: "check", id: "a", obligation: "rule:a", pass: true, exercised: false }],
  });
  assert.equal(accounting.entries[0].status, "unaccounted");
  assert.equal(accounting.sound, false);
});

test("policy obligations are covered by gate applicability; operation obligations by traffic", () => {
  const obligations = deriveObligations({ policies: [{ policy: "no_server_error" }], spec: SPEC });
  const accounting = accountObligations({
    obligations,
    records: [],
    gateChecks: [{ obligation: "policy:no_server_error", applicable: true, detail: "3 response(s), none 5xx" }],
    trace: [
      { method: "GET", path: "/items" },
      { method: "POST", path: "/items" },
      { method: "GET", path: "/items/it_1" },
    ],
  });

  assert.equal(accounting.sound, true, "every operation was exercised and the policy applied");
  assert.equal(accounting.summary.covered, 4);

  const inapplicable = accountObligations({
    obligations,
    records: [],
    gateChecks: [{ obligation: "policy:no_server_error", applicable: false, detail: "no request matched" }],
    trace: [{ method: "GET", path: "/items" }],
  });
  assert.equal(inapplicable.sound, false);
  assert.equal(inapplicable.entries.find((entry) => entry.source === "policy").status, "unaccounted");
  assert.deepEqual(
    inapplicable.entries.filter((entry) => entry.status === "unaccounted").map((entry) => entry.id),
    ["policy:no_server_error", "operation:POST /items", "operation:GET /items/{itemId}"],
    "the two never-touched operations are unaccounted too",
  );
});
