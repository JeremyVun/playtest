// The runtime key algorithm must reproduce the P0 reference spec.
//
// P0 froze the identity and match-text algorithms as pure functions under
// `tests/core/findings/spec.ts`, exercised against the twelve-case fixture
// corpus. P2 implements them for real in
// `src/platform/control-plane/src/findings/keys.ts`. This test pins the two
// together: every corpus item must produce byte-identical keys and match text
// through both implementations, so a change to the runtime that diverges from
// the frozen spec fails here rather than silently re-partitioning findings.
//
// Hermetic: pure functions only — no database, no model, no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as spec from "../../../../../tests/core/findings/spec.ts";
import { allCandidates } from "../../../../../tests/core/findings/corpus.ts";
import {
  CATEGORIES,
  VERSIONS,
  coarseSignalType,
  deriveCandidateKeys,
  exactKeys,
  hasExactKeys,
  matchText,
  normalizeLocus,
  normalizeText,
} from "../../src/findings/keys.ts";

const CORPUS = allCandidates();

test("runtime keys reproduce the frozen P0 spec over the whole fixture corpus", () => {
  for (const item of CORPUS) {
    const identity = {
      projectId: item.project_id,
      storyId: item.story_id,
      signalType: item.signal_type,
      locus: item.locus,
    };
    assert.equal(hasExactKeys(identity), spec.hasExactKeys(item), `hasExactKeys(${item.id})`);
    const keys = exactKeys(identity);
    assert.equal(keys.strict, spec.strictKey(item), `strict key for ${item.id}`);
    assert.equal(keys.loose, spec.looseKey(item), `loose key for ${item.id}`);
    assert.equal(
      matchText({ category: item.kind, locus: item.locus, claim: item }),
      spec.matchText(item),
      `match text for ${item.id}`,
    );
    assert.equal(normalizeLocus(item.locus ?? {}), spec.normalizeLocus(item.locus ?? {}), `locus for ${item.id}`);
  }
});

test("normalization strips run-specific ids, numbers, and timestamps", () => {
  for (const value of [
    "DELETE /api/cart/items/8842 → 500",
    "trace 3f2a9c1b8e7d44aa",
    "at 2026-07-24T10:12:33.120Z",
    "550e8400-e29b-41d4-a716-446655440000",
  ]) {
    assert.equal(normalizeText(value), spec.normalizeText(value), value);
  }
  // Two runs of one defect differ only in volatile tokens ⇒ identical locus.
  assert.equal(
    normalizeLocus({ route: "/api/cart/items/8842", step_locus: "remove", status_class: "5xx" }),
    normalizeLocus({ route: "/api/cart/items/91307?t=1690101731", step_locus: "remove", status_class: "5xx" }),
  );
});

test("model text and the model-chosen category never enter a key (DESIGN D4)", () => {
  const base = {
    projectId: "p1",
    storyId: "cart/remove",
    signalType: "http_error",
    locus: { route: "/api/cart/items/1", step_locus: "remove", status_class: "5xx" },
  };
  const a = deriveCandidateKeys({ ...base, category: "http_error", claim: { title: "Remove 500s", expected: "x", observed: "y" } });
  const b = deriveCandidateKeys({ ...base, category: "data_mismatch", claim: { title: "Cart line will not go away", expected: "p", observed: "q" } });
  assert.equal(a.strict_key, b.strict_key, "different wording and category, same key");
  assert.equal(a.loose_key, b.loose_key);
  assert.notEqual(a.match_text, b.match_text, "match text does reflect the claim — it is retrieval, not identity");

  // Story is the only difference between strict and loose.
  const otherStory = deriveCandidateKeys({ ...base, storyId: "cart/add", category: "http_error", claim: {} });
  assert.notEqual(otherStory.strict_key, a.strict_key);
  assert.equal(otherStory.loose_key, a.loose_key);
});

test("no deterministic signal ⇒ no exact keys", () => {
  const derived = deriveCandidateKeys({
    projectId: "p1",
    storyId: "s",
    signalType: null,
    locus: null,
    category: "data_mismatch",
    claim: { title: "Total looks wrong" },
  });
  assert.equal(derived.strict_key, null);
  assert.equal(derived.loose_key, null);
  assert.equal(derived.normalized_locus, null);
  assert.ok(derived.match_text.length > 0, "match text is still computed for the P3 shortlist");
});

test("versions are stamped on every derived row and match the frozen spec's names", () => {
  const derived = deriveCandidateKeys({
    projectId: "p1", storyId: "s", signalType: "no_effect",
    locus: { step_locus: "submit" }, category: "no_effect", claim: {},
  });
  assert.equal(derived.key_algo_version, VERSIONS.key_algo);
  assert.equal(derived.locus_norm_version, VERSIONS.locus_norm);
  assert.equal(derived.match_text_version, VERSIONS.match_text);
  assert.equal(VERSIONS.key_algo, spec.VERSIONS.key_algo);
  assert.equal(VERSIONS.locus_norm, spec.VERSIONS.locus_norm);
  assert.equal(VERSIONS.match_text, spec.VERSIONS.match_text);
});

test("the D3 category vocabulary is the frozen seven", () => {
  assert.deepEqual([...CATEGORIES].sort(), [
    "broken_navigation", "console_exception", "data_mismatch", "expectation_violation",
    "http_error", "no_effect", "perf_regression",
  ]);
});

test("coarse signal types collapse the engine's fine anomaly vocabulary", () => {
  assert.equal(coarseSignalType("http_4xx"), "http_error");
  assert.equal(coarseSignalType("http_5xx"), "http_error");
  assert.equal(coarseSignalType("repeated_action"), "no_effect");
  assert.equal(coarseSignalType("console_exception"), "console_exception");
  assert.equal(coarseSignalType("some_future_signal"), "some_future_signal", "a new engine signal is usable at once");
  assert.equal(coarseSignalType(""), null);
});
