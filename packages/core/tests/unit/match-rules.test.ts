// Match rules: the volatile-field vocabulary, and the invariant that no rule can
// mask a renamed, added, or removed field (docs/contracts/engine.md#match-rules).
import { test } from "node:test";
import assert from "node:assert/strict";

import { DummyConfigError } from "../../src/config.ts";
import { applyMatchRules, canonicalStatus, normalizeMatch, shapeOf, statusesEquivalent } from "../../src/match.ts";
import { normalizeApiSnapshot, projectApiSnapshot } from "../../src/drivers/api.ts";

const project = (body: LegacyTestValue, match: LegacyTestValue) => projectApiSnapshot(`API: http://x\n\nLast response: 200 application/json\n${JSON.stringify(body)}`, [], match);

test("exclude quiets a volatile value but keeps its key, so a rename still moves the projection", () => {
  const match = normalizeMatch({ exclude: ["$.balance", "$.notices"] }, "case.yaml");
  const before = project({ id: "acc_1", balance: 90, notices: [] }, match);
  const jitter = project({ id: "acc_2", balance: 12345, notices: [{ code: "n1" }, { code: "n2" }] }, match);
  assert.equal(before, jitter, "a different value AND a different list length are both quiet");
  assert.match(before, /"balance":"\[excluded\]"/, "the key survives; only the value is suppressed");

  // The same rule set, with the field renamed: still drift.
  const renamed = project({ id: "acc_1", available_balance: 90, notices: [] }, match);
  assert.notEqual(before, renamed, "an excluded field that is RENAMED must still read as drift");
  // ...and so are the two other real changes a rule must never absorb.
  assert.notEqual(before, project({ id: "acc_1", notices: [] }, match), "a removed field is drift");
  assert.notEqual(before, project({ id: "acc_1", balance: 90, notices: [], tier: "gold" }, match), "an added field is drift");
});

test("compare widens the projection to a value; a value enters only where a rule names it", () => {
  const match = normalizeMatch({ compare: ["$.status"] }, "case.yaml");
  const active = project({ id: "acc_1", status: "active", owner: "ada" }, match);
  assert.match(active, /"status":"active"/, "the compared field is committed by value");
  assert.match(active, /"owner":"string"/, "everything else stays shape-only");
  assert.notEqual(active, project({ id: "acc_1", status: "pending", owner: "ada" }, match), "a changed compared value is drift");
  assert.equal(active, project({ id: "acc_9", status: "active", owner: "bob" }, match), "an uncompared value is not");
});

test("redaction beats compare: a rule can never resurrect a value redaction suppressed", () => {
  const match = normalizeMatch({ compare: ["$"] }, "case.yaml");
  const text = `API: http://x\n\nLast response: 200 application/json\n${JSON.stringify({ owner: { email: "ada@example.com" } })}`;
  const out = projectApiSnapshot(text, ["$.owner.email"], match);
  assert.ok(!out.includes("ada@example.com"), "the redacted value never reaches the projection");
  assert.match(out, /\[redacted\]/);
});

test("normalize: sorted compares a list order-insensitively, length collapses it", () => {
  const sorted = normalizeMatch({ compare: ["$.tags"], normalize: [{ path: "$.tags", rule: "sorted" }] }, "c.yaml");
  assert.equal(project({ tags: ["b", "a"] }, sorted), project({ tags: ["a", "b"] }, sorted));
  assert.notEqual(project({ tags: ["a", "b"] }, sorted), project({ tags: ["a", "c"] }, sorted), "sorting is not blindness");

  const length = normalizeMatch({ normalize: [{ path: "$.items", rule: "length" }] }, "c.yaml");
  assert.match(project({ items: [{ a: 1 }, { b: 2 }] }, length), /"items":\{"length":2\}/);
  assert.notEqual(project({ items: [1] }, length), project({ items: [1, 2] }, length), "a changed length is still drift");
});

test("status equivalence is opt-in: exact by default, and a class only when declared", () => {
  assert.equal(statusesEquivalent(201, 201), true);
  assert.equal(statusesEquivalent(201, 202), false, "a within-class change is a contract change by default");
  assert.equal(statusesEquivalent(200, 204), false);

  const declared = normalizeMatch({ status_equivalent: [[202, 201]] }, "c.yaml");
  assert.equal(statusesEquivalent(201, 202, declared), true);
  assert.equal(statusesEquivalent(201, 203, declared), false, "only the declared members are interchangeable");
  // Canonicalization is authoring-order independent, so declaring an
  // equivalence AFTER a baseline was recorded still compares equal.
  assert.equal(canonicalStatus(202, declared), "201");
  assert.equal(canonicalStatus(201, declared), "201");

  const klass = normalizeMatch({ status_equivalent: ["2xx"] }, "c.yaml");
  assert.equal(statusesEquivalent(200, 204, klass), true);
  assert.equal(statusesEquivalent(200, 302, klass), false);
  assert.equal(canonicalStatus(204, klass), "2xx");
});

test("drift comparison collapses declared-equivalent statuses on both sides only", () => {
  const declared = normalizeMatch({ status_equivalent: [[201, 202]] }, "c.yaml");
  const at = (status: number) => `API: http://x\n\nLast response: ${status} application/json\n{"id":"string"}`;
  assert.equal(normalizeApiSnapshot(at(201), null, declared), normalizeApiSnapshot(at(202), null, declared));
  assert.notEqual(normalizeApiSnapshot(at(201), null), normalizeApiSnapshot(at(202), null), "with no rule the status line is untouched");
  assert.notEqual(normalizeApiSnapshot(at(201), null, declared), normalizeApiSnapshot(at(204), null, declared));
});

test("with no rules the projection is exactly what it was before match rules existed", () => {
  const body = { id: "acc_1", items: [{ n: 1 }], ok: true };
  assert.equal(project(body, null), project(body, undefined));
  assert.deepEqual(shapeOf(applyMatchRules(body, {})), { id: "string", items: [{ n: "number" }], ok: "boolean" });
});

test("a malformed match block is a config error naming the file and the fix", () => {
  const bad = (value: LegacyTestValue, re: RegExp) => assert.throws(() => normalizeMatch(value, "stories/x.yaml"), (e) => e instanceof DummyConfigError && re.test(e.message));
  bad(["$.a"], /must be a map with "exclude"/);
  bad({ nope: [] }, /unknown match key\(s\) nope/);
  bad({ exclude: [""] }, /entries are field paths/);
  bad({ exclude: ["$.a b"] }, /is not a field path/);
  bad({ normalize: [{ path: "$.a" }] }, /the vocabulary is sorted, length/);
  bad({ normalize: ["$.a"] }, /entries are \{ path/);
  bad({ status_equivalent: [201] }, /a class like "2xx" or a list of at least two statuses/);
  bad({ status_equivalent: [[201, "2xx"]] }, /not a three-digit status/);
  assert.equal(normalizeMatch({ exclude: [] }, "x.yaml"), null, "an empty block resolves to null, not an empty shell");
  assert.equal(normalizeMatch(undefined, "x.yaml"), null);
});
