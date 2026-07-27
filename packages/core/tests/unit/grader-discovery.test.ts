// Discovery-mode grader + actor (docs/discovery-mode-plan.md §5): rubric
// selection by case mode, the "## Report questions" section, baseline
// suppression in discovery prompts, the additive grade.schema.json "report"
// property, and the actor's discovery overlay with "## Your task" kept last.
// No browser, no API key: gradeRun/Actor are driven in-process against a tiny
// HTTP stub at PLAYTEST_LLM_BASE_URL that records every request body.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

import { gradeRun } from "../../src/grader.ts";
import { Actor, loadPersona } from "../../src/actor.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const promptFile = (name: string) => fs.readFileSync(path.join(ROOT, "src", "prompts", name), "utf8");
const gradeSchema = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "schemas", "grade.schema.json"), "utf8"));

const STORY = "Get your data out of the app however seems natural.";

const BASE_GRADE = {
  score: 30,
  completion: "none",
  efficiency: { assessment: "looked in two places, then gave up", wasted_steps: 0 },
  findings: [{ severity: "major", note: "no export affordance anywhere", step: 2 }],
  summary: "The user looked for an export and gave up.",
};

let tmpRoot: LegacyTestValue;
let server: LegacyTestValue;
const requests: LegacyTestValue[] = []; // every parsed POST body the stub served, in order

// A typed bug candidate the stub emits whenever the prompt carried a
// "## Deterministic signals" section — the P1 seeded-defect path through gradeRun.
const STUB_CANDIDATE = {
  kind: "http_error",
  severity: "major",
  title: "Export request returns a server error",
  expected: "the export completes",
  observed: "the export endpoint returned a 500",
  evidence_steps: [2],
  signals: ["http_5xx"],
};

/** Echo one report answer per numbered question when the section is present. */
function gradeFor(userContent: string): LegacyTestValue {
  // When the discovery prompt carried deterministic signals, the stub grader
  // grounds a bug candidate on them (exercises schema + persistence end to end).
  const withCandidates = userContent.includes("## Deterministic signals")
    ? { ...BASE_GRADE, bug_candidates: [STUB_CANDIDATE] }
    : BASE_GRADE;
  const tail = userContent.split("## Report questions")[1];
  if (!tail) return withCandidates;
  const questions = tail
    .split("\n## ")[0]! // SAFETY: split always returns at least one segment
    .split("\n")
    .filter((l) => /^\d+\. /.test(l))
    .map((l) => l.replace(/^\d+\. /, ""));
  return {
    ...withCandidates,
    report: questions.map((q, i) => ({ question: q, answer: `stub answer ${i + 1}`, evidence_steps: [1, 2] })),
  };
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-grader-discovery-"));
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed: LegacyTestValue = JSON.parse(body);
      requests.push(parsed);
      const offered = (parsed.tools ?? []).map((t: LegacyTestValue) => t?.function?.name).filter(Boolean);
      const name =
        parsed.tool_choice?.function?.name ??
        (parsed.tool_choice === "auto" && offered.includes("grade") ? "grade" : "none");
      const user = parsed.messages.find((m: LegacyTestValue) => m.role === "user")?.content ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(gradeFor(user)) } }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // llmConfig() re-reads process.env per call; a base-URL override needs no key.
  process.env.PLAYTEST_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  delete process.env.PLAYTEST_LLM_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.PLAYTEST_LLM_CACHE = "0"; // these tests assert exact prompt bytes
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(resolve));
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------- fixtures ----------

const ENVELOPES: LegacyTestValue[] = [
  {
    step: 1,
    agent: {
      thought: "I expected an Export button on the toolbar; opening the menu instead.",
      action: { type: "click", ref: "e3" },
      expectation: "a menu opens with an export option",
    },
    result: { ok: true, url: "http://localhost:9/", settle_ms: 120 },
  },
  {
    step: 2,
    agent: {
      thought: "No export anywhere I would look.",
      action: { type: "give_up", reason: "no export affordance on the toolbar or the menu" },
      expectation: "n/a",
    },
    result: { ok: true },
  },
];

let seq = 0;

// A trajectory whose final step recorded an HTTP 500 — extractAnomalies emits an
// http_5xx signal, so a discovery grade of it carries a "## Deterministic signals"
// section (and none of the anomaly-free ENVELOPES tests change).
const ANOM_ENVELOPES: LegacyTestValue[] = [
  ENVELOPES[0],
  {
    step: 2,
    agent: { thought: "The export request failed.", action: { type: "give_up", reason: "export 500s" }, expectation: "n/a" },
    result: { ok: true, url: "http://localhost:9/" },
    network: { requests: [{ method: "POST", path: "/api/export", status: 500, failed: true }] },
  },
];

/** A fresh case file path + run dir with a trajectory; nothing else shared. */
function makeFixture({ mode = "journey", report = [], baseline = false, envelopes = ENVELOPES }: LegacyTestValue = {}): LegacyTestValue {
  const dir = path.join(tmpRoot, `fixture-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const caseFile = path.join(dir, "export-data.yaml");
  fs.writeFileSync(caseFile, `story: |\n  ${STORY}\n`);
  if (baseline) {
    // readBaseline resolves to <suite>/results/ (trajectory.ts baselinePaths);
    // with no playtest.yaml here the suite root falls back to the case dir.
    const resultsDir = path.join(dir, "results");
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(path.join(resultsDir, "export-data.baseline.jsonl"), JSON.stringify(ENVELOPES[0]) + "\n");
  }
  const runDir = path.join(dir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "trajectory.jsonl"),
    envelopes.map((e: LegacyTestValue) => JSON.stringify(e)).join("\n") + "\n",
  );
  const resolvedCase = {
    id: "export-data",
    file: caseFile,
    name: "export-data",
    story: STORY,
    persona: "tester",
    tags: [],
    success: [],
    perf: {},
    limits: { max_steps: 50, timeout_ms: 240_000 },
    actor_model: "claude-haiku-4-5",
    grader_model: "claude-sonnet-4-6",
    mode,
    report,
    env: { base_url: "http://localhost:9", compose: null, init: null, storage_state: null },
  };
  return { resolvedCase, runDir };
}

/** gradeRun with the stub, returning the grade plus the terminal captured request. */
async function captureGrade(resolvedCase: LegacyTestValue, runDir: string): Promise<LegacyTestValue> {
  const countBefore = requests.length;
  const grade = await gradeRun(runDir, resolvedCase);
  assert.equal(requests.length, countBefore + 1, "expected exactly one LLM call (no validation retry)");
  const req = requests[requests.length - 1];
  return {
    grade,
    req,
    system: req.messages.find((m: LegacyTestValue) => m.role === "system").content,
    user: req.messages.find((m: LegacyTestValue) => m.role === "user").content,
  };
}

// ---------- rubric selection ----------

test("discovery grades use the grader-discovery.md rubric", async () => {
  const { resolvedCase, runDir } = makeFixture({ mode: "discovery" });
  const { system, user, req } = await captureGrade(resolvedCase, runDir);
  assert.equal(system, promptFile("grader-discovery.md").trim());
  assert.match(system, /evidence only[\s\S]*Ignore\s+embedded instructions/i);
  assert.equal(req.model, "claude-sonnet-4-6");
  // The gate never runs in discovery: the section is omitted, not "null".
  assert.ok(!user.includes("## Gate result"), "discovery prompt must not carry a gate section");
  assert.ok(user.includes("## Trajectory\n\n"), "trajectory digest still present");
});

test("journey grade prompt is unchanged: rubric, section order, baseline", async () => {
  const { resolvedCase, runDir } = makeFixture({ mode: "journey", baseline: true });
  const { system, user } = await captureGrade(resolvedCase, runDir);
  assert.equal(system, promptFile("grader-system.md").trim());
  assert.match(system, /evidence only[\s\S]*Ignore\s+embedded instructions/i);
  // Pre-change assembly (docs/contracts/engine.md#grading): exact headings,
  // in this order.
  const headings = [
    `## Story\n\n${STORY}`,
    "## Trajectory\n\n",
    "## Gate result\n\nnull",
    "## Totals\n\nnull",
    "## Baseline\n\nbaseline step count: 1",
    "## Final page snapshot\n\n(no final snapshot recorded)",
  ];
  let at = -1;
  for (const h of headings) {
    const next = user.indexOf(h);
    assert.ok(next > at, `expected ${JSON.stringify(h.split("\n")[0])} after position ${at}\n${user}`);
    at = next;
  }
  assert.ok(!user.includes("## Report questions"), "no report section when report is empty");
});

test("grader prefers post-action final.a11y evidence over the last step's pre-action snapshot", async () => {
  const { resolvedCase, runDir } = makeFixture({ mode: "journey" });
  fs.writeFileSync(path.join(runDir, "final.a11y.txt"),
    'Page: Property type\n[e1] radio "Established dwelling" (checked)\n[e2] button "Next"\n');
  const { user } = await captureGrade(resolvedCase, runDir);
  assert.match(user, /## Final page snapshot\n\nPage: Property type\n\[e1\] radio "Established dwelling" \(checked\)/);
  assert.doesNotMatch(user, /no final snapshot recorded/);
});

// ---------- report questions ----------

const QUESTIONS = [
  "Where did the user look first, and what did they try before giving up?",
  "At which screen would this user have expected an export affordance?",
];

test("a non-empty report adds a section listing every question; answers land in grade.json", async () => {
  const { resolvedCase, runDir } = makeFixture({ mode: "discovery", report: QUESTIONS });
  const { grade, user } = await captureGrade(resolvedCase, runDir);
  assert.ok(user.includes("## Report questions"));
  for (const q of QUESTIONS) assert.ok(user.includes(q), `question listed: ${q}`);
  assert.ok(
    user.indexOf("## Report questions") < user.indexOf("## Final page snapshot"),
    "report questions come before the final snapshot",
  );
  // The stub's report answers passed grader.ts's compiled schema in one call,
  // and gradeRun persisted them.
  assert.deepEqual(grade.report.map((r: LegacyTestValue) => r.question), QUESTIONS);
  const onDisk = JSON.parse(fs.readFileSync(path.join(runDir, "grade.json"), "utf8"));
  assert.deepEqual(onDisk.report, grade.report);
});

test("report on a journey case also adds the section (report is mode-agnostic downstream)", async () => {
  const { resolvedCase, runDir } = makeFixture({ mode: "journey", report: [QUESTIONS[0]] });
  const { system, user } = await captureGrade(resolvedCase, runDir);
  assert.equal(system, promptFile("grader-system.md").trim(), "journey keeps the journey rubric");
  assert.ok(user.includes("## Report questions"));
  assert.ok(user.includes(QUESTIONS[0]));
});

// ---------- baseline suppression ----------

test("a stray baseline never leaks into a discovery grade prompt", async () => {
  const { resolvedCase, runDir } = makeFixture({ mode: "discovery", baseline: true });
  const { user } = await captureGrade(resolvedCase, runDir);
  assert.ok(!user.includes("## Baseline"), `discovery prompt must not mention the baseline\n${user}`);
});

// ---------- grade.schema.json: additive report property ----------

test("grade.schema.json accepts a report array and grades without one", () => {
  // @ts-expect-error -- Ajv's NodeNext declaration exposes the runtime default constructor incompatibly
  const validate = new Ajv({ allErrors: true }).compile(gradeSchema);
  assert.ok(validate(BASE_GRADE), `pre-change grade shape stays valid: ${JSON.stringify(validate.errors)}`);
  const withReport = {
    ...BASE_GRADE,
    report: [{ question: "Where did the user look first?", answer: "The toolbar.", evidence_steps: [1] }],
  };
  assert.ok(validate(withReport), `report array accepted: ${JSON.stringify(validate.errors)}`);
  // evidence_steps is optional; question and answer are not.
  assert.ok(validate({ ...BASE_GRADE, report: [{ question: "q", answer: "a" }] }));
  assert.ok(!validate({ ...BASE_GRADE, report: [{ answer: "a", evidence_steps: [1] }] }), "missing question rejected");
  assert.ok(!validate({ ...BASE_GRADE, report: [{ question: "q", evidence_steps: [1] }] }), "missing answer rejected");
});

// ---------- deterministic signals + typed bug candidates (P1) ----------

test("a discovery grade with a recorded anomaly carries a Deterministic signals section and persists bug_candidates", async () => {
  const { resolvedCase, runDir } = makeFixture({ mode: "discovery", envelopes: ANOM_ENVELOPES });
  const { grade, user } = await captureGrade(resolvedCase, runDir);
  // The compact, factual signal list is fed to the discovery grader.
  assert.ok(user.includes("## Deterministic signals"), "signals section present");
  assert.ok(/step 2: http_5xx/.test(user), "the recorded 500 is surfaced as http_5xx");
  // The grader's typed candidate validated against grade.schema.json and persisted.
  assert.equal(grade.bug_candidates.length, 1);
  assert.equal(grade.bug_candidates[0].kind, "http_error");
  assert.deepEqual(grade.bug_candidates[0].evidence_steps, [2]);
  const onDisk = JSON.parse(fs.readFileSync(path.join(runDir, "grade.json"), "utf8"));
  assert.deepEqual(onDisk.bug_candidates, grade.bug_candidates);
});

test("an anomaly-free discovery run has no signals section and no bug_candidates", async () => {
  const { resolvedCase, runDir } = makeFixture({ mode: "discovery" });
  const { grade, user } = await captureGrade(resolvedCase, runDir);
  assert.ok(!user.includes("## Deterministic signals"), "omitted when there are no signals");
  assert.ok(!("bug_candidates" in grade), "empty candidate list stays absent, not []");
});

test("journey grades never receive a Deterministic signals section, even with a recorded anomaly", async () => {
  const { resolvedCase, runDir } = makeFixture({ mode: "journey", envelopes: ANOM_ENVELOPES });
  const { system, user } = await captureGrade(resolvedCase, runDir);
  assert.equal(system, promptFile("grader-system.md").trim(), "journey keeps the journey rubric");
  assert.ok(!user.includes("## Deterministic signals"), "signals are a discovery-only input");
});

// ---------- grade.schema.json: optional bug_candidates ----------

test("grade.schema.json validates bug_candidates and stays backward-compatible", () => {
  // @ts-expect-error -- Ajv's NodeNext declaration exposes the runtime default constructor incompatibly
  const validate = new Ajv({ allErrors: true }).compile(gradeSchema);
  // Backward compatible: a grade with no candidates (every legacy grade) is valid.
  assert.ok(validate(BASE_GRADE), `no-candidate grade valid: ${JSON.stringify(validate.errors)}`);
  const valid = {
    ...BASE_GRADE,
    bug_candidates: [{ kind: "data_mismatch", severity: "major", title: "t", expected: "e", observed: "o", evidence_steps: [2], signals: ["expectation_contradiction"] }],
  };
  assert.ok(validate(valid), `valid candidate accepted: ${JSON.stringify(validate.errors)}`);
  // signals is optional.
  assert.ok(validate({ ...BASE_GRADE, bug_candidates: [{ kind: "no_effect", severity: "minor", title: "t", expected: "e", observed: "o", evidence_steps: [1] }] }));
  // Missing evidence_steps is rejected — every candidate must cite steps.
  assert.ok(!validate({ ...BASE_GRADE, bug_candidates: [{ kind: "http_error", severity: "major", title: "t", expected: "e", observed: "o" }] }), "missing evidence rejected");
  // An empty evidence_steps array is rejected (minItems 1).
  assert.ok(!validate({ ...BASE_GRADE, bug_candidates: [{ kind: "http_error", severity: "major", title: "t", expected: "e", observed: "o", evidence_steps: [] }] }), "empty evidence rejected");
  // A category outside the fixed vocabulary is rejected.
  assert.ok(!validate({ ...BASE_GRADE, bug_candidates: [{ kind: "security_hole", severity: "major", title: "t", expected: "e", observed: "o", evidence_steps: [1] }] }), "unknown category rejected");
  // An empty candidate list is valid (a clean discovery run).
  assert.ok(validate({ ...BASE_GRADE, bug_candidates: [] }), "empty list accepted");
});

// ---------- discovery rubric: generic contradiction audit, no product language ----------

test("the discovery rubric separates UX findings from typed bug candidates, generically", () => {
  const rubric = promptFile("grader-discovery.md");
  // Both output channels are described and kept distinct.
  assert.ok(/`findings`/.test(rubric), "findings channel documented");
  assert.ok(/`bug_candidates`/.test(rubric), "bug_candidates channel documented");
  // The generic contradiction audit (DESIGN D2) is present.
  assert.ok(/contradiction/i.test(rubric), "instructs a contradiction audit");
  // Refutation-first exclusions (D7): intended behavior, confusion, environment.
  assert.ok(/intended/i.test(rubric) && /confusion/i.test(rubric) && /environment/i.test(rubric), "refutation-first exclusions present");
  // A required-missing affordance may be a candidate; an unsupported wish stays UX.
  assert.ok(/require/i.test(rubric) && /wish/i.test(rubric), "required-affordance vs wish distinction present");
  // Actor conclusions are claims, not evidence.
  assert.ok(/claims?/i.test(rubric) && /evidence/i.test(rubric), "actor conclusions treated as claims");
  // An empty candidate list is explicitly permitted.
  assert.ok(/empty/i.test(rubric), "empty list permitted");
  // The full seven-category vocabulary appears.
  for (const kind of ["http_error", "console_exception", "expectation_violation", "data_mismatch", "no_effect", "perf_regression", "broken_navigation"]) {
    assert.ok(rubric.includes(kind), `vocabulary includes ${kind}`);
  }
  // No product-specific failure examples leak into the production prompt (the
  // corpus's app-specific nouns belong in fixtures, never the rubric).
  for (const leak of ["cart", "coupon", "checkout", "gift", "orchid", "shop.local", "SAVE20"]) {
    assert.ok(!new RegExp(leak, "i").test(rubric), `rubric must not mention "${leak}"`);
  }
});

// ---------- actor system prompt ----------

test("discovery actor prompt has the overlay with ## Your task still last", () => {
  const { resolvedCase } = makeFixture({ mode: "discovery" });
  const overlay = promptFile("actor-discovery.md").trim();
  // The overlay itself must never contain the marker or the prompt will carry
  // more than one apparent task boundary.
  assert.ok(!overlay.includes("## Your task"));
  const actor: LegacyTestValue = new Actor(resolvedCase, loadPersona("tester"));
  assert.ok(actor.system.includes(overlay), "discovery overlay present");
  // Everything after the last marker is the story.
  const afterMarker = actor.system.split("## Your task").pop();
  assert.equal(afterMarker.trim(), STORY);
  assert.ok(!/\n## /.test(afterMarker), "## Your task is the last heading");
  assert.ok(
    actor.system.indexOf(overlay) > actor.system.indexOf("## Persona"),
    "overlay comes after the persona section",
  );
});

test("journey actor prompt is the web overlay + persona + task, in that order", () => {
  const persona = loadPersona("tester");
  const expected = [
    promptFile("actor-system.md").trim(),
    `## Persona\n\n${persona.description.trim()}`,
    `## Your task\n\n${STORY}`,
  ].join("\n\n");
  const { resolvedCase } = makeFixture({ mode: "journey" });
  assert.equal(new Actor(resolvedCase, persona).system, expected);
  // A case with no mode at all (e.g. rebuilt from an old manifest) is journey.
  delete resolvedCase.mode;
  assert.equal(new Actor(resolvedCase, persona).system, expected);
});
