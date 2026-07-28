// The pure auto-resolve decision function (findings/auto-resolve.ts): tier
// routing, per-triple stamping, the strict-newer/same-run guards, and the
// close predicate — no database, no clock, no I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDecisions, tierOf, signalKeysOf, normalizeRoute, autoResolveReason,
} from "../../src/findings/auto-resolve.ts";
import { exactKeys } from "../../src/findings/keys.ts";

const T0 = 1_000_000; // an arbitrary evidence instant

function finding(over = {}) {
  return {
    id: "f1",
    project_id: "p1",
    state: "accepted",
    strict_key: null,
    signal_type: null,
    external_ref: null,
    locus: null,
    summary: {},
    last_seen: new Date(T0),
    ...over,
  };
}

function triple(over = {}) {
  return {
    suiteId: "s1", ringId: "e1", caseId: "c1",
    lastEvidenceAt: T0,
    stamp: null,
    candidate: null,
    ...over,
  };
}

function candidate(over = {}) {
  return {
    runId: "rB", finishedAt: T0 + 10, status: "pass",
    gateChecks: null, isEvidence: false, checked: false,
    signalKeys: null, routes: null,
    graded: true, verdict: null, verdictEvidence: null, // a graded pass, unverified
    ...over,
  };
}

test("tierOf: gate_* strict keys never route through the signal test", () => {
  assert.equal(tierOf({ strict_key: "k", signal_type: "gate_assert" }), "gate");
  assert.equal(tierOf({ strict_key: "k", signal_type: "http_error" }), "signal");
  assert.equal(tierOf({ strict_key: null, signal_type: null }), "keyless");
});

test("gate tier: the same gate check passing stamps and resolves — even on a failed run", () => {
  const f = finding({
    strict_key: "k", signal_type: "gate_assert",
    summary: { gate: { spec: "assert: total updates" }, confirmed_at: "2026-01-01" },
  });
  const d = resolveDecisions(f, [triple({
    candidate: candidate({
      status: "fail", // failed at a later step; this check still passed
      gateChecks: [{ spec: "assert: total updates", pass: true }, { spec: "assert: receipt shows", pass: false }],
    }),
  })]);
  assert.equal(d.action, "resolve");
  assert.equal(d.resolveRunId, "rB");
  assert.deepEqual(d.stamps.map((s: HostedDynamic) => s.method), ["gate_pass"]);
});

test("gate tier: the same check failing again stamps nothing", () => {
  const f = finding({ strict_key: "k", signal_type: "gate_assert", summary: { gate: { spec: "assert: x" } } });
  const d = resolveDecisions(f, [triple({
    candidate: candidate({ gateChecks: [{ spec: "assert: x", pass: false }] }),
  })]);
  assert.equal(d.action, "none");
  assert.equal(d.stamps.length, 0);
});

test("strict >: a run at the evidence instant never stamps (a finding filed by run R carries R's own timestamp)", () => {
  const f = finding({ strict_key: "k", signal_type: "gate_assert", summary: { gate: { spec: "assert: x" } } });
  const d = resolveDecisions(f, [triple({
    candidate: candidate({ finishedAt: T0, gateChecks: [{ spec: "assert: x", pass: true }] }),
  })]);
  assert.equal(d.action, "none");
  assert.equal(d.stamps.length, 0);
});

test("a run never resolves a finding it evidenced", () => {
  const f = finding({ strict_key: "k", signal_type: "gate_assert", summary: { gate: { spec: "assert: x" } } });
  const d = resolveDecisions(f, [triple({
    candidate: candidate({ isEvidence: true, gateChecks: [{ spec: "assert: x", pass: true }] }),
  })]);
  assert.equal(d.action, "none");
});

test("signal tier: absence stamps only under locus coverage; presence writes the checked memo, never evidence", () => {
  const keys = exactKeys({
    projectId: "p1", storyId: "checkout", signalType: "http_error",
    locus: { route: "/api/export", step_locus: "POST /api/export → 500", status_class: "5xx" },
  });
  const f = finding({
    strict_key: keys.strict, signal_type: "http_error",
    locus: { route: "/api/export", step_locus: "POST /api/export → 500", status_class: "5xx" },
    summary: { story_id: "checkout" },
  });
  // Bundle unavailable: proves nothing, no memo (retry-able).
  let d = resolveDecisions(f, [triple({ candidate: candidate({ signalKeys: null }) })]);
  assert.equal(d.action, "none");
  assert.equal(d.checked.length, 0);

  // Signal still present: no stamp, checked memo so the read isn't re-paid.
  d = resolveDecisions(f, [triple({ candidate: candidate({ signalKeys: new Set([f.strict_key]) }) })]);
  assert.equal(d.action, "none");
  assert.equal(d.stamps.length, 0);
  assert.deepEqual(d.checked.map((c: HostedDynamic) => c.runId), ["rB"]);

  // Absent + run passed outright: covered, stamped, resolved.
  d = resolveDecisions(f, [triple({ candidate: candidate({ status: "pass", signalKeys: new Set() }) })]);
  assert.equal(d.action, "resolve");
  assert.deepEqual(d.stamps.map((s: HostedDynamic) => s.method), ["signal_absent"]);

  // Absent on a FAILED run: only counts if the run reached the route.
  d = resolveDecisions(f, [triple({
    candidate: candidate({ status: "fail", signalKeys: new Set(), routes: new Set([normalizeRoute("/api/other")]) }),
  })]);
  assert.equal(d.action, "none", "a divergent run that never visited the page proves nothing");
  assert.deepEqual(d.checked.map((c: HostedDynamic) => c.runId), ["rB"], "not-covered is remembered like still-present");
  d = resolveDecisions(f, [triple({
    candidate: candidate({ status: "fail", signalKeys: new Set(), routes: new Set([normalizeRoute("/api/export")]) }),
  })]);
  assert.equal(d.action, "resolve");
});

test("multi-triple: one fresh stamp does not close while another triple's evidence is newer", () => {
  const f = finding({ strict_key: "k", signal_type: "gate_assert", summary: { gate: { spec: "assert: x" } } });
  const stampedTriple = triple({
    ringId: "e1",
    candidate: candidate({ gateChecks: [{ spec: "assert: x", pass: true }] }),
  });
  const staleTriple = triple({
    ringId: "e2",
    lastEvidenceAt: T0 + 50,
    stamp: { run_id: "old", stamped_at: T0 + 20, method: "gate_pass" }, // older than its evidence
    candidate: null,
  });
  const d = resolveDecisions(f, [stampedTriple, staleTriple]);
  assert.equal(d.action, "none", "every affected triple must carry a fresh stamp");
  assert.equal(d.stamps.length, 1, "the pass still stamps its own triple");
  // A newer pass on the second ring closes it, and provenance is the
  // newest stamp.
  const d2 = resolveDecisions(f, [
    { ...stampedTriple, stamp: { run_id: "rB", stamped_at: T0 + 10, method: "gate_pass" }, candidate: null },
    { ...staleTriple, candidate: candidate({ runId: "rC", finishedAt: T0 + 90, gateChecks: [{ spec: "assert: x", pass: true }] }) },
  ]);
  assert.equal(d2.action, "resolve");
  assert.equal(d2.resolveRunId, "rC");
});

test("keyless findings and live external refs suggest, never resolve; a dismissed run never re-suggests", () => {
  const keyless = finding({ strict_key: null });
  let d = resolveDecisions(keyless, [triple({ candidate: candidate() })]);
  assert.equal(d.action, "suggest");
  assert.deepEqual(d.stamps.map((s: HostedDynamic) => s.method), ["case_pass"]);

  // Only an outright pass says anything about a judgment call.
  d = resolveDecisions(finding({ strict_key: null }), [triple({ candidate: candidate({ status: "fail" }) })]);
  assert.equal(d.action, "none");

  // An UNGRADED pass (checked act-mode run, or a lost bundle) proves nothing
  // about a judgment call: no grader looked, no verifier looked.
  for (const graded of [false, null]) {
    d = resolveDecisions(finding({ strict_key: null }), [triple({ candidate: candidate({ graded }) })]);
    assert.equal(d.action, "none", `graded=${graded} must not suggest`);
    assert.equal(d.stamps.length, 0);
    assert.equal(d.checked.length, 0, "retryable — a later graded/verified run settles it");
  }

  const external = finding({
    strict_key: "k", signal_type: "gate_assert", external_ref: "JIRA-12",
    summary: { gate: { spec: "assert: x" } },
  });
  d = resolveDecisions(external, [triple({
    candidate: candidate({ gateChecks: [{ spec: "assert: x", pass: true }] }),
  })]);
  assert.equal(d.action, "suggest", "a live external ticket is never contradicted silently");

  const dismissed = finding({
    strict_key: null,
    summary: { auto_resolve: { dismissed: { run_id: "rB" } } },
  });
  d = resolveDecisions(dismissed, [triple({ stamp: { run_id: "rB", stamped_at: T0 + 10, method: "case_pass" } })]);
  assert.equal(d.action, "none", "'not fixed' is remembered for that run");
  d = resolveDecisions(dismissed, [triple({
    stamp: { run_id: "rB", stamped_at: T0 + 10, method: "case_pass" },
    candidate: candidate({ runId: "rC", finishedAt: T0 + 90 }),
  })]);
  assert.equal(d.action, "suggest", "a NEWER pass may suggest again");
});

test("verified tier: a fixed verdict stamps verified_absent; semi suggests, full resolves", () => {
  const f = finding({ strict_key: null });
  const fixed = candidate({ verdict: "fixed", verdictEvidence: "You're not an Australian citizen" });

  let d = resolveDecisions(f, [triple({ candidate: fixed })]);
  assert.equal(d.action, "suggest", "semi is the default: a person still confirms");
  assert.deepEqual(d.stamps.map((s: HostedDynamic) => s.method), ["verified_absent"]);

  d = resolveDecisions(f, [triple({ candidate: fixed })], { mode: "full" });
  assert.equal(d.action, "resolve");
  assert.equal(d.resolveRunId, "rB");
});

test("verified tier: not_fixed and indeterminate memo as checked and never stamp — whatever the verdict of the run", () => {
  for (const verdict of ["not_fixed", "indeterminate"]) {
    const d = resolveDecisions(finding({ strict_key: null }), [triple({
      candidate: candidate({ verdict, status: "pass" }),
    })]);
    assert.equal(d.action, "none", `${verdict}: a passing run must not fall back to case_pass`);
    assert.equal(d.stamps.length, 0);
    assert.deepEqual(d.checked.map((c: HostedDynamic) => c.runId), ["rB"], `${verdict} memos so the read is not re-paid`);
  }
});

test("full mode resolves only on ALL-verified stamps; case_pass and external refs still suggest", () => {
  const f = finding({ strict_key: null });
  // A graded pass without a verdict is inference, not verification — full
  // mode must not close on it.
  let d = resolveDecisions(f, [triple({ candidate: candidate() })], { mode: "full" });
  assert.equal(d.action, "suggest");

  // Mixed triples: one verified, one only case_pass — the weakest stamp decides.
  d = resolveDecisions(f, [
    triple({ candidate: candidate({ verdict: "fixed" }) }),
    triple({ ringId: "e2", stamp: { run_id: "rC", stamped_at: T0 + 20, method: "case_pass" } }),
  ], { mode: "full" });
  assert.equal(d.action, "suggest");

  // A live external ticket is never contradicted silently, even fully verified.
  d = resolveDecisions(finding({ strict_key: null, external_ref: "JIRA-12" }),
    [triple({ candidate: candidate({ verdict: "fixed" }) })], { mode: "full" });
  assert.equal(d.action, "suggest");

  // A person's "not fixed" on this exact run outranks any mode.
  d = resolveDecisions(finding({ strict_key: null, summary: { auto_resolve: { dismissed: { run_id: "rB" } } } }),
    [triple({ candidate: candidate({ verdict: "fixed" }) })], { mode: "full" });
  assert.equal(d.action, "none");
});

test("a standing suggestion is retracted when new evidence makes its stamps stale", () => {
  const f = finding({
    strict_key: null,
    summary: { auto_resolve: { suggested: { run_id: "rB", at: "2026-07-01" } } },
  });
  const d = resolveDecisions(f, [triple({
    lastEvidenceAt: T0 + 100, // recurrence landed after the stamp
    stamp: { run_id: "rB", stamped_at: T0 + 10, method: "case_pass" },
  })]);
  assert.equal(d.action, "clear_suggestion");
});

test("signalKeysOf reproduces intake's strict keys from recorded signals", () => {
  const signals = [
    { type: "http_5xx", step: 3, detail: "POST /api/export → 500", locus: { route: "/api/export", status_class: "5xx" } },
    { type: "console_exception", step: 4, detail: "TypeError: x" },
  ];
  const keys = signalKeysOf("p1", "checkout", signals);
  const expected = exactKeys({
    projectId: "p1", storyId: "checkout", signalType: "http_error",
    locus: { route: "/api/export", step_locus: "POST /api/export → 500", status_class: "5xx" },
  });
  assert.ok(keys.has(expected.strict), "the http signal keys identically to intake");
});

test("normalizeRoute strips query strings and volatile tokens", () => {
  assert.equal(normalizeRoute("/api/orders/123?page=2"), normalizeRoute("/api/orders/456"));
  assert.equal(normalizeRoute(null), null);
});

test("autoResolveReason: a short human sentence per tier, scoped when multi-triple", () => {
  const gate = finding({ strict_key: "k", signal_type: "gate_assert", summary: { gate: { spec: "assert: results show Tasmania" } } });
  assert.equal(
    autoResolveReason(gate, [triple()]),
    "The exact check that failed (“assert: results show Tasmania”) passed in a newer run.",
  );
  assert.match(
    autoResolveReason(gate, [triple(), triple({ ringId: "e2" })]),
    /everywhere it was seen \(2 suite\/ring combinations\)/,
  );
  // A very long gate spec is clipped — the reason stays one readable sentence.
  const long = finding({ strict_key: "k", signal_type: "gate_assert", summary: { gate: { spec: "x".repeat(300) } } });
  assert.ok(autoResolveReason(long, [triple()]).length < 200);

  const signal = finding({ strict_key: "k", signal_type: "http_error" });
  assert.equal(
    autoResolveReason(signal, [triple()]),
    "A newer run covered the same part of the app and the recorded failure signal did not recur.",
  );

  // Keyless and external-ref findings only ever get suggestions; the reason
  // says why the close still belongs to a person.
  assert.match(autoResolveReason(finding(), [triple()]), /judgment call, so closing it stays with you/);
  assert.match(autoResolveReason(finding({ external_ref: "JIRA-12" }), [triple()]), /linked to JIRA-12/);

  // A verified absence says what was checked and quotes what the page says now.
  const f = finding({ strict_key: null });
  const verified = resolveDecisions(f, [triple({
    candidate: candidate({ verdict: "fixed", verdictEvidence: "You're not an Australian citizen" }),
  })]);
  const reason = autoResolveReason(f, [triple()], verified);
  assert.match(reason, /re-checked against the newest run's page content/);
  assert.match(reason, /You're not an Australian citizen/);
});
