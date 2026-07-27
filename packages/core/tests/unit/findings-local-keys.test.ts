// The LOCAL findings identity and retrieval must reproduce the frozen P0 spec,
// byte for byte, over the whole fixture corpus (BUILD_PLAN P5 item 3).
//
// Core may not import the control plane, so `packages/core/src/findings/keys.ts` and
// `shortlist.ts` are deliberate duplicates of the same frozen algorithms the
// hosted ports implement. The spec (`tests/core/findings/spec.ts`) is the single
// source of truth: this test pins the LOCAL copy to it, exactly as the hosted
// suite pins the hosted copy. A divergence fails here rather than silently
// re-partitioning local findings — or, worse, making the same defect key
// differently on either side of a local→hosted import.
//
// Hermetic: pure functions only — no database, no model, no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as spec from "../../../../tests/support/findings/spec.ts";
import { FIXTURES, allCandidates } from "../../../../tests/support/findings/corpus.ts";
import {
  CATEGORIES,
  VERSIONS,
  deriveCandidateKeys,
  exactKeys,
  hasExactKeys,
  matchText,
  normalizeLocus,
  normalizeText,
} from "../../src/findings/keys.ts";
import {
  DEFAULT_RETRIEVAL,
  clusters,
  idfTable,
  retrievalItem,
  route,
  shortlist,
  similarity,
} from "../../src/findings/shortlist.ts";

const CORPUS = allCandidates();

const runtimeItem = (c: LegacyTestValue): LegacyTestValue =>
  retrievalItem({
    id: c.id,
    role: c.role ?? "candidate",
    text: matchText({
      category: c.kind,
      locus: c.locus,
      claim: { expected: c.expected, observed: c.observed, title: c.title },
    }),
  });

test("local keys and match text reproduce the frozen P0 spec over the whole corpus", () => {
  for (const item of CORPUS) {
    const identity: LegacyTestValue = {
      scopeId: item.project_id,
      storyId: item.story_id,
      signalType: item.signal_type,
      locus: item.locus,
    };
    assert.equal(hasExactKeys(identity), spec.hasExactKeys(item), `hasExactKeys(${item.id})`);
    const keys = exactKeys(identity);
    assert.equal(keys.strict, spec.strictKey(item), `strict key for ${item.id}`);
    assert.equal(keys.loose, spec.looseKey(item), `loose key for ${item.id}`);
    assert.equal(
      matchText({ category: item.kind, locus: item.locus as LegacyTestValue, claim: item }), // SAFETY: corpus fixtures include legacy scalar loci
      spec.matchText(item),
      `match text for ${item.id}`,
    );
    assert.equal(normalizeLocus(item.locus ?? {}), spec.normalizeLocus(item.locus ?? {}), `locus for ${item.id}`);
  }
});

test("local normalization strips run-specific ids, numbers, and timestamps like the spec", () => {
  for (const value of [
    "DELETE /api/cart/items/8842 → 500",
    "trace 3f2a9c1b8e7d44aa",
    "at 2026-07-24T10:12:33.120Z",
    "550e8400-e29b-41d4-a716-446655440000",
  ]) {
    assert.equal(normalizeText(value), spec.normalizeText(value), value);
  }
  assert.equal(
    normalizeLocus({ route: "/api/cart/items/8842", step_locus: "remove", status_class: "5xx" }),
    normalizeLocus({ route: "/api/cart/items/91307?t=1690101731", step_locus: "remove", status_class: "5xx" }),
  );
});

test("local shortlist scoring, routing, and clustering reproduce the spec", () => {
  const items = CORPUS.map(runtimeItem);
  const idf = idfTable(items);
  const specItems = CORPUS.map((c) => ({ ...c, role: c.role ?? "candidate" }));
  const specIdf = spec.idfTable(specItems);
  const byId = new Map(items.map((i) => [i.id, i]));
  const specById: LegacyTestValue = new Map(specItems.map((c) => [c.id, c]));

  for (const item of items) {
    const mine = shortlist(item, items, idf);
    const theirs = spec.shortlist(specById.get(item.id), specItems, specIdf);
    assert.deepEqual(
      mine.map((n) => [n.id, n.role, round(n.score)]),
      theirs.map((n) => [n.id, n.role, round(n.score)]),
      `shortlist for ${item.id}`,
    );
    // Routing without an exact-key hit: the local CLI routes the same way.
    assert.equal(route(mine), spec.route(specById.get(item.id), { neighbors: theirs }), `route for ${item.id}`);
  }

  // Similarity itself, pair by pair, so a scoring change cannot hide behind
  // top-k truncation.
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      assert.equal(
        round(similarity(items[i], items[j], idf)),
        round(spec.similarity(specById.get(items[i].id), specById.get(items[j].id), specIdf)),
        `similarity(${items[i].id}, ${items[j].id})`,
      );
    }
  }

  const ids = items.filter((i) => i.role === "candidate").map((i) => i.id);
  const edges = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (similarity(byId.get(ids[i]), byId.get(ids[j]), idf) >= DEFAULT_RETRIEVAL.floor) {
        edges.push({ a: ids[i], b: ids[j] });
      }
    }
  }
  assert.deepEqual(clusters(ids, edges), spec.clusters(ids, edges));
});

test("the frozen algorithm versions and the D3 vocabulary match the spec", () => {
  assert.equal(VERSIONS.key_algo, spec.VERSIONS.key_algo);
  assert.equal(VERSIONS.locus_norm, spec.VERSIONS.locus_norm);
  assert.equal(VERSIONS.match_text, spec.VERSIONS.match_text);
  assert.equal(DEFAULT_RETRIEVAL.k, spec.RETRIEVAL.k);
  assert.equal(DEFAULT_RETRIEVAL.floor, spec.RETRIEVAL.floor);
  assert.equal(DEFAULT_RETRIEVAL.autoSuggest, spec.RETRIEVAL.auto_suggest);
  assert.deepEqual([...CATEGORIES].sort(), [
    "broken_navigation", "console_exception", "data_mismatch", "expectation_violation",
    "http_error", "no_effect", "perf_regression",
  ]);
  assert.equal(FIXTURES.length, 12, "the P0 corpus is the frozen twelve");
});

test("model wording and the model-chosen category never enter a local key (DESIGN D4)", () => {
  const base = {
    scopeId: "ws_local",
    storyId: "cart/remove",
    signalType: "http_error",
    locus: { route: "/api/cart/items/1", step_locus: "remove", status_class: "5xx" },
  };
  const a = deriveCandidateKeys({ ...base, category: "http_error", claim: { title: "Remove 500s", expected: "x", observed: "y" } });
  const b = deriveCandidateKeys({ ...base, category: "data_mismatch", claim: { title: "Cart line will not go away", expected: "p", observed: "q" } });
  assert.equal(a.strict_key, b.strict_key);
  assert.equal(a.loose_key, b.loose_key);
  assert.notEqual(a.match_text, b.match_text, "match text is retrieval, not identity");

  // The scope id is the only difference between a local and a hosted key, which
  // is why an importer must recompute rather than trust exported keys (D8).
  const otherScope = deriveCandidateKeys({ ...base, scopeId: "proj_hosted", category: "http_error", claim: {} });
  assert.notEqual(otherScope.strict_key, a.strict_key);
});

const round = (n: number) => Math.round(n * 1e12) / 1e12;
