// P4 (platform simplification) — discovery study synthesis now lives with
// findings and emits cited findings, not an Insight. These are the pure parts:
// the forced tool shape and the grounding validator that rejects any citation
// not naming a real run. Ingest (which writes findings/evidence rows) is covered
// by the findings-synthesis integration test. No DB, no LLM here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STUDY_REPORT_TOOL, validateReportArgs } from "../../src/findings/synthesis.ts";

test("STUDY_REPORT_TOOL: the forced tool shape the synthesis grounding validator depends on", () => {
  assert.equal(STUDY_REPORT_TOOL.type, "function");
  assert.equal(STUDY_REPORT_TOOL.function.name, "study_report");
  assert.deepEqual(STUDY_REPORT_TOOL.function.parameters.required, ["title", "headline", "answers", "findings"]);
  const props = STUDY_REPORT_TOOL.function.parameters.properties;
  assert.deepEqual(props.answers.items.required, ["question", "answer", "evidence"]);
  assert.deepEqual(props.findings.items.required, ["severity", "note", "evidence"]);
  assert.deepEqual(props.findings.items.properties.evidence.items.required, ["run_ref", "step"]);
});

test("validateReportArgs: a grounded report passes; every finding must cite a real run and step", () => {
  const known = new Map([["r-alpha", {}], ["r-beta", {}]]);
  const good = {
    title: "Export is undiscoverable",
    headline: "Two personas never found export.",
    answers: [{ question: "Where did they look?", answer: "The toolbar.", evidence: [{ run_ref: "r-alpha", step: 3 }] }],
    findings: [
      { severity: "major", note: "No export affordance in the toolbar", evidence: [{ run_ref: "r-alpha", step: 3 }, { run_ref: "r-beta", step: 5 }] },
    ],
  };
  assert.equal(validateReportArgs(good, known), null);

  // Hallucinated run_ref is rejected.
  assert.match(
    validateReportArgs({ ...good, findings: [{ severity: "minor", note: "x", evidence: [{ run_ref: "nope", step: 1 }] }] }, known),
    /unknown run_ref/,
  );
  // A finding with no evidence is rejected — every claim must be cited.
  assert.match(
    validateReportArgs({ ...good, findings: [{ severity: "minor", note: "x", evidence: [] }] }, known),
    /no evidence/,
  );
  // A non-positive step is rejected.
  assert.match(
    validateReportArgs({ ...good, findings: [{ severity: "minor", note: "x", evidence: [{ run_ref: "r-alpha", step: 0 }] }] }, known),
    /positive integer/,
  );
});
