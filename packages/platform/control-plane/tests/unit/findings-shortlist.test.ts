// The runtime consolidation retrieval must reproduce the P0 reference spec, and
// its measured behavior on the P0 corpus is recorded here as the baseline
// (docs/contracts/hosted.md, "Candidate consolidation").
//
// P0 froze match text, the rare-word-weighted shortlist, score routing, and
// connected-component clustering as pure functions under
// `tests/support/findings/spec.ts`, exercised against the twelve-case fixture
// corpus. P3 implements them for real in
// `packages/platform/control-plane/src/findings/shortlist.ts`. This test pins the two
// together, so a change to the runtime that diverges from the frozen spec fails
// here rather than silently re-partitioning findings.
//
// Hermetic: pure functions only — no database, no model, no I/O. The cluster
// measurements at the bottom are the P0 cost baseline referenced by the P3 exit
// gate; they are asserted, not merely printed, so a regression in cluster size
// or prompt volume fails the gate.
import { test } from "node:test";
import assert from "node:assert/strict";

import * as spec from "../../../../../tests/support/findings/spec.ts";
import { FIXTURES, allCandidates } from "../../../../../tests/support/findings/corpus.ts";
import { matchText } from "../../src/findings/keys.ts";
import {
  DEFAULT_RETRIEVAL,
  capClusters,
  clusters,
  estimateTokens,
  idfTable,
  retrievalItem,
  route,
  shortlist,
  similarity,
  tokenize,
} from "../../src/findings/shortlist.ts";

const CORPUS: HostedDynamic = allCandidates();

/** A corpus fixture item as the runtime sees it: an id, a role, a stored match text. */
function runtimeItem(c: HostedDynamic) {
  return retrievalItem({
    id: c.id,
    role: c.role ?? "candidate",
    text: matchText({
      category: c.kind,
      locus: c.locus,
      claim: { expected: c.expected, observed: c.observed, title: c.title },
    }),
  });
}

const ITEMS: HostedDynamic = CORPUS.map(runtimeItem);
const IDF: HostedDynamic = idfTable(ITEMS);
const SPEC_IDF: HostedDynamic = spec.idfTable(CORPUS.map((c: HostedDynamic) => ({ ...c, role: c.role ?? "candidate" })));
const byId: HostedDynamic = new Map(ITEMS.map((i: HostedDynamic) => [i.id, i]));
const fixtureById: HostedDynamic = new Map(CORPUS.map((c: HostedDynamic) => [c.id, c]));

/**
 * Candidates whose exact keys already matched at intake (D4) never reach
 * consolidation: they appended or became a one-click suggestion with no model
 * call. Retrieval only ever sees what is left.
 */
const EXACT_RESOLVED: HostedDynamic = new Set(
  FIXTURES.map((f: HostedDynamic) => f.expected.exact_key)
    .filter((e: HostedDynamic) => e && (e.strict || e.loose))
    .map((e: HostedDynamic) => e.incoming),
);

/** The candidates retrieval routes into clusters, i.e. the ambiguous middle. */
function clusteredItems() {
  return ITEMS.filter(
    (i: HostedDynamic) => i.role === "candidate" && !EXACT_RESOLVED.has(i.id) && route(shortlist(i, ITEMS, IDF)) === "cluster",
  );
}

/** Candidate-to-candidate edges above the floor among a clustered set. */
function edgesAmong(items: HostedDynamic) {
  const edges: HostedDynamic[] = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (similarity(items[i], items[j], IDF) >= DEFAULT_RETRIEVAL.floor) {
        edges.push({ a: items[i].id, b: items[j].id });
      }
    }
  }
  return edges;
}

test("runtime tokenization reproduces the frozen spec over the whole corpus", () => {
  for (const c of CORPUS) {
    assert.deepEqual(
      [...tokenize(runtimeItem(c).tokens ? [...runtimeItem(c).tokens].join(" ") : "")].sort(),
      [...runtimeItem(c).tokens].sort(),
      "tokenize is idempotent over its own output",
    );
    assert.deepEqual([...runtimeItem(c).tokens].sort(), [...spec.tokenize(c)].sort(), `tokens(${c.id})`);
  }
});

test("runtime similarity is byte-identical to the frozen spec for every pair", () => {
  for (let i = 0; i < CORPUS.length; i += 1) {
    for (let j = 0; j < CORPUS.length; j += 1) {
      if (i === j) continue;
      const runtime = similarity(byId.get(CORPUS[i].id), byId.get(CORPUS[j].id), IDF);
      const frozen = spec.similarity(CORPUS[i], CORPUS[j], SPEC_IDF);
      assert.equal(runtime, frozen, `similarity(${CORPUS[i].id}, ${CORPUS[j].id})`);
    }
  }
});

test("the shortlist is deterministic: same inputs, same neighbors, in the same order", () => {
  for (const item of ITEMS) {
    const a = shortlist(item, ITEMS, IDF);
    const b = shortlist(item, [...ITEMS].reverse(), idfTable([...ITEMS].reverse()));
    assert.deepEqual(a, b, `shortlist(${item.id}) must not depend on row order`);
    assert.deepEqual(a, shortlist(item, ITEMS, IDF), `shortlist(${item.id}) must be pure`);
  }
});

test("shortlist recall: every recorded duplicate appears in its neighbor's top-k", () => {
  let pairs = 0;
  for (const f of FIXTURES) {
    for (const s of f.expected.shortlist || []) {
      const neighbors = shortlist(byId.get(s.of), ITEMS, IDF).map((n) => n.id);
      for (const need of s.must_include || []) {
        pairs += 1;
        assert.ok(neighbors.includes(need), `[${f.id}] shortlist of ${s.of} must include ${need}, got [${neighbors}]`);
      }
      for (const banned of s.must_exclude || []) {
        assert.ok(!neighbors.includes(banned), `[${f.id}] shortlist of ${s.of} must exclude ${banned}`);
      }
    }
  }
  assert.ok(pairs >= 3, "the corpus must still exercise duplicate recall");
});

test("the reworded-personas duplicate and the cross-category duplicate both retrieve", () => {
  // F2: one stale-total defect, two personas, no deterministic signal, different
  // categories — word overlap alone has to find it.
  const reworded: HostedDynamic = shortlist(byId.get("f2-adversarial"), ITEMS, IDF);
  assert.equal(reworded[0].id, "f2-careful");
  assert.ok(reworded[0].score >= DEFAULT_RETRIEVAL.floor);
  assert.notEqual(fixtureById.get("f2-adversarial").kind, fixtureById.get("f2-careful").kind);

  // F3: one shipping-estimate defect labeled data_mismatch on one run and
  // expectation_violation on the other. A shared category raises the score but
  // never gates comparison, so a differing category must still retrieve.
  const crossCategory: HostedDynamic = shortlist(byId.get("f3-incoming"), ITEMS, IDF);
  assert.equal(crossCategory[0].id, "f3-existing");
  assert.equal(crossCategory[0].role, "finding");
  assert.notEqual(fixtureById.get("f3-incoming").kind, fixtureById.get("f3-existing").kind);
});

test("distinct defects in one category never become neighbors", () => {
  // F5: two http_error candidates on unrelated endpoints.
  for (const [a, b] of [["f5-giftcard", "f5-password"], ["f5-password", "f5-giftcard"]] as HostedDynamic) {
    const neighbors = shortlist(byId.get(a), ITEMS, IDF).map((n) => n.id);
    assert.ok(!neighbors.includes(b), `${a} must not retrieve ${b}`);
    assert.equal(fixtureById.get(a).kind, fixtureById.get(b).kind, "the fixture pair must share a category");
  }
});

test("score routing decides before any model call, and matches the frozen spec", () => {
  for (const f of FIXTURES) {
    for (const [id, want] of Object.entries(f.expected.routing || {})) {
      const fixture = fixtureById.get(id);
      // Exact-key routing (append/suggestion) is intake's job and is decided
      // before retrieval runs; retrieval routes only what reaches it.
      const exact = f.expected.exact_key;
      const hitsExact = exact && exact.incoming === id && (exact.strict || exact.loose);
      if (hitsExact) continue;
      const neighbors = shortlist(byId.get(id), ITEMS, IDF);
      const got = route(neighbors);
      assert.equal(got, want, `[${f.id}] routing of ${id}`);
      assert.equal(got, spec.route(fixture, { neighbors }), `[${f.id}] routing parity for ${id}`);
      if (got !== "cluster") {
        assert.ok(["new", "suggestion"].includes(got), "a non-cluster route never reaches the gateway");
      }
    }
  }
});

test("clusters are connected components: one defect is never split across two calls", () => {
  const clustered = clusteredItems();
  const ids = clustered.map((i: HostedDynamic) => i.id);
  const edges = edgesAmong(clustered);
  const components = clusters(ids, edges);
  assert.deepEqual(components, spec.clusters(ids, edges), "clustering parity with the frozen spec");

  // Every recorded semantic grouping that reached clustering lands whole in ONE
  // component — the property that makes one call per cluster sound.
  const componentOf = new Map();
  components.forEach((c, i) => c.forEach((id) => componentOf.set(id, i)));
  for (const f of FIXTURES) {
    for (const group of f.expected.grouping || []) {
      const inside = group.filter((id) => componentOf.has(id));
      if (inside.length < 2) continue;
      const homes = new Set(inside.map((id) => componentOf.get(id)));
      assert.equal(homes.size, 1, `[${f.id}] ${inside.join(" + ")} must share one cluster`);
    }
  }

  // A transitive chain a–b–c with no a–c edge is still one component.
  assert.deepEqual(
    clusters(["a", "b", "c", "d"], [{ a: "a", b: "b" }, { a: "b", b: "c" }]),
    [["a", "b", "c"], ["d"]],
  );
});

test("an over-large component is split by the item cap, never silently truncated", () => {
  const big: HostedDynamic = [Array.from({ length: 7 }, (_, i) => `c${i}`)];
  const capped: HostedDynamic = capClusters(big, { maxClusterItems: 3 });
  assert.deepEqual(capped.map((c: HostedDynamic) => c.ids.length), [3, 3, 1]);
  assert.ok(capped.every((c: HostedDynamic) => c.split));
  assert.deepEqual(capped.flatMap((c: HostedDynamic) => c.ids).sort(), big[0].sort(), "no candidate is dropped");
  assert.deepEqual(capClusters(big, { maxClusterItems: 15 }), [{ ids: big[0], split: false }]);
});

// ---------------------------------------------------------------------------
// P0 baseline measurements. The rationale for these values is recorded in
// tests/support/findings/README.md; these assertions keep them from drifting.
// ---------------------------------------------------------------------------

test("measured P0 baseline: separation, cluster calls, and per-call token volume", () => {
  // 1. Threshold separation. Every recorded duplicate pair scores above the
  //    floor and every unrelated pair scores below it — the measurement the
  //    floor of 0.25 was chosen from.
  const duplicatePairs = new Set(
    FIXTURES.flatMap((f) => (f.expected.grouping || []).filter((g) => g.length > 1).map((g) => [...g].sort().join("|"))),
  );
  let minDuplicate = 1;
  let maxUnrelated = 0;
  for (let i = 0; i < ITEMS.length; i += 1) {
    for (let j = i + 1; j < ITEMS.length; j += 1) {
      const s = similarity(ITEMS[i], ITEMS[j], IDF);
      const key = [ITEMS[i].id, ITEMS[j].id].sort().join("|");
      if (duplicatePairs.has(key)) minDuplicate = Math.min(minDuplicate, s);
      else maxUnrelated = Math.max(maxUnrelated, s);
    }
  }
  assert.ok(minDuplicate >= 0.31, `weakest duplicate pair scored ${minDuplicate.toFixed(3)}`);
  assert.ok(maxUnrelated <= 0.20, `strongest unrelated pair scored ${maxUnrelated.toFixed(3)}`);
  assert.ok(
    maxUnrelated < DEFAULT_RETRIEVAL.floor && DEFAULT_RETRIEVAL.floor < minDuplicate,
    `the floor ${DEFAULT_RETRIEVAL.floor} must sit inside the measured gap ` +
      `(${maxUnrelated.toFixed(3)}, ${minDuplicate.toFixed(3)})`,
  );
  // No corpus pair reaches the auto-suggest threshold: word overlap alone never
  // bypasses verification at these values.
  assert.ok(minDuplicate < DEFAULT_RETRIEVAL.autoSuggest);

  // 2. Cluster calls and volume. One call, two candidates, well inside the caps.
  const clustered = clusteredItems();
  const components = clusters(clustered.map((i: HostedDynamic) => i.id), edgesAmong(clustered));
  assert.equal(components.length, 1, "one cluster call for the whole P0 corpus");
  assert.deepEqual(components[0], ["f2-adversarial", "f2-careful"]);
  assert.equal(clustered.length - components.length, 1, "per-candidate classification would have cost one more call");

  const compact = (id: HostedDynamic) => {
    const c = fixtureById.get(id);
    return [c.title, c.expected, c.observed, c.story_id, c.locus?.route].filter(Boolean).join(" ");
  };
  const tokensPerCall = components.map((c) => c.reduce((sum, id) => sum + estimateTokens(compact(id)), 0));
  assert.deepEqual(tokensPerCall, [96], "P0 baseline: 96 estimated input tokens of claims in the one cluster call");
  for (const t of tokensPerCall) {
    assert.ok(t * 4 < DEFAULT_RETRIEVAL.maxPromptBytes, "a P0 cluster is far inside the prompt-byte cap");
  }
  for (const c of components) assert.ok(c.length <= DEFAULT_RETRIEVAL.maxClusterItems);
});
