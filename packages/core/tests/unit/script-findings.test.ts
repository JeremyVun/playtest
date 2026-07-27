// Candidate findings from a script report (docs/contracts/scripts.md#findings).
//
// A failing check on a sound suite is a claim about the API that a human will
// judge, so the two things this module must get right are: which checks become
// findings (failing ones, never defects), and whether the evidence behind each
// one actually resolves into recorded traffic.
import { test } from "node:test";
import assert from "node:assert/strict";

import { formatScriptFindings, scriptFindings, summarizeFindings } from "../../src/public/api-suite-scripts.ts";

const harEntries = [
  { request: { method: "POST", url: "http://api.test/widgets" }, response: { status: 201 }, time: 12.4 },
  { request: { method: "POST", url: "http://api.test/widgets/w_1/publish" }, response: { status: 200 }, time: 8 },
];

const report = {
  checks: [
    { id: "created-is-draft", obligation: "rule:lifecycle", title: "a new widget is a draft", pass: true, evidence: { har_entries: [0] } },
    {
      id: "republish-is-refused",
      obligation: "rule:lifecycle",
      title: "a second publish is refused",
      pass: false,
      expected: "409",
      observed: "200",
      evidence: { har_entries: [1], subject: { widget: "w_1" } },
    },
    { id: "unevidenced", obligation: "rule:lifecycle", title: "something is wrong", pass: false, expected: "x", observed: "y", evidence: { har_entries: [] } },
  ],
  defects: [{ kind: "threw", message: "not a finding" }],
  obligations: { entries: [{ id: "rule:lifecycle", statement: "Publishing twice is refused with 409." }] },
  gate: {
    pass: false,
    checks: [
      { policy: "no_server_error", tier: 1, spec: "no_server_error", obligation: "policy:no_server_error", applicable: true, pass: false, detail: "GET /boom answered 500", har_entries: [0] },
      { policy: "content_type", tier: 1, spec: "content_type", obligation: "policy:content_type", applicable: false, pass: false, detail: "never exercised", har_entries: [] },
    ],
  },
};

test("failing checks become findings, passing checks and defects do not", () => {
  const findings = scriptFindings(report, { harEntries });
  const checkFindings = findings.filter((finding: LegacyTestValue) => finding.source === "check");
  assert.deepEqual(checkFindings.map((finding: LegacyTestValue) => finding.id), ["republish-is-refused", "unevidenced"]);
  assert.equal(checkFindings[0].statement, "Publishing twice is refused with 409.");
  assert.equal(checkFindings[0].expected, "409");
  assert.deepEqual(checkFindings[0].evidence.subject, { widget: "w_1" });
});

test("evidence is re-verified against the recorded HAR, not taken on trust", () => {
  const [republish, unevidenced] = scriptFindings(report, { harEntries });
  assert.equal(republish.evidence_verified, true);
  assert.deepEqual(republish.evidence.exchanges, [{ har_entry: 1, method: "POST", url: "http://api.test/widgets/w_1/publish", status: 200, time_ms: 8 }]);
  assert.equal(unevidenced.evidence_verified, false);
  assert.deepEqual(unevidenced.evidence.exchanges, []);

  // With the HAR gone (retention), the citation is present but unresolved.
  const withoutHar = scriptFindings(report, { harEntries: [] });
  assert.equal(withoutHar[0].evidence_verified, false);
  assert.deepEqual(withoutHar[0].evidence.har_entries, [1]);
});

test("an applicable failing policy is a finding from the HAR column; an inapplicable one is not", () => {
  const policies = scriptFindings(report, { harEntries }).filter((finding: LegacyTestValue) => finding.source === "policy");
  assert.equal(policies.length, 1);
  assert.equal(policies[0].id, "policy:no_server_error");
  assert.match(policies[0].observed, /GET \/boom answered 500/);
});

test("findings render for a terminal, unevidenced ones marked as such", () => {
  const text = formatScriptFindings(scriptFindings(report, { harEntries }));
  assert.match(text, /3 candidate findings/);
  assert.match(text, /\[1\] POST http:\/\/api\.test\/widgets\/w_1\/publish → 200/);
  assert.match(text, /none that resolves/);
  assert.match(text, /\(HAR column\)/);
  assert.equal(formatScriptFindings([]), "No findings: every check passed and the HAR column held.");
  assert.equal(summarizeFindings([]), "no findings");
  assert.match(summarizeFindings(scriptFindings(report, { harEntries })), /^3 findings: republish-is-refused/);
});
