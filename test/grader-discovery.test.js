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

import { gradeRun } from "../src/harness/grader.js";
import { Actor, loadPersona } from "../src/harness/actor.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const promptFile = (name) => fs.readFileSync(path.join(ROOT, "src", "harness", "prompts", name), "utf8");
const gradeSchema = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "schemas", "grade.schema.json"), "utf8"));

const STORY = "Get your data out of the app however seems natural.";

const BASE_GRADE = {
  score: 30,
  completion: "none",
  efficiency: { assessment: "looked in two places, then gave up", wasted_steps: 0 },
  findings: [{ severity: "major", note: "no export affordance anywhere", step: 2 }],
  summary: "The user looked for an export and gave up.",
};

let tmpRoot;
let server;
const requests = []; // every parsed POST body the stub served, in order

/** Echo one report answer per numbered question when the section is present. */
function gradeFor(userContent) {
  const tail = userContent.split("## Report questions")[1];
  if (!tail) return BASE_GRADE;
  const questions = tail
    .split("\n## ")[0]
    .split("\n")
    .filter((l) => /^\d+\. /.test(l))
    .map((l) => l.replace(/^\d+\. /, ""));
  return {
    ...BASE_GRADE,
    report: questions.map((q, i) => ({ question: q, answer: `stub answer ${i + 1}`, evidence_steps: [1, 2] })),
  };
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-grader-discovery-"));
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const name = parsed.tool_choice?.function?.name ?? "none";
      const user = parsed.messages.find((m) => m.role === "user")?.content ?? "";
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // llmConfig() re-reads process.env per call; a base-URL override needs no key.
  process.env.PLAYTEST_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  delete process.env.PLAYTEST_LLM_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------- fixtures ----------

const ENVELOPES = [
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

/** A fresh case file path + run dir with a trajectory; nothing else shared. */
function makeFixture({ mode = "journey", report = [], baseline = false } = {}) {
  const dir = path.join(tmpRoot, `fixture-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const caseFile = path.join(dir, "export-data.yaml");
  fs.writeFileSync(caseFile, `story: |\n  ${STORY}\n`);
  if (baseline) {
    fs.writeFileSync(caseFile.replace(/\.yaml$/, ".baseline.jsonl"), JSON.stringify(ENVELOPES[0]) + "\n");
  }
  const runDir = path.join(dir, "run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "trajectory.jsonl"),
    ENVELOPES.map((e) => JSON.stringify(e)).join("\n") + "\n",
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

/** gradeRun with the stub, returning the grade plus the single captured request. */
async function captureGrade(resolvedCase, runDir) {
  const countBefore = requests.length;
  const grade = await gradeRun(runDir, resolvedCase);
  assert.equal(requests.length, countBefore + 1, "expected exactly one LLM call (no validation retry)");
  const req = requests[requests.length - 1];
  return {
    grade,
    req,
    system: req.messages.find((m) => m.role === "system").content,
    user: req.messages.find((m) => m.role === "user").content,
  };
}

// ---------- rubric selection ----------

test("discovery grades use the grader-discovery.md rubric", async () => {
  const { resolvedCase, runDir } = makeFixture({ mode: "discovery" });
  const { system, user, req } = await captureGrade(resolvedCase, runDir);
  assert.equal(system, promptFile("grader-discovery.md").trim());
  assert.equal(req.model, "claude-sonnet-4-6");
  // The gate never runs in discovery: the section is omitted, not "null".
  assert.ok(!user.includes("## Gate result"), "discovery prompt must not carry a gate section");
  assert.ok(user.includes("## Trajectory\n\n"), "trajectory digest still present");
});

test("journey grade prompt is unchanged: rubric, section order, baseline", async () => {
  const { resolvedCase, runDir } = makeFixture({ mode: "journey", baseline: true });
  const { system, user } = await captureGrade(resolvedCase, runDir);
  assert.equal(system, promptFile("grader-system.md").trim());
  // Pre-change assembly (CONTRACTS §8): exact headings, in this order.
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
  // The stub's report answers passed grader.js's compiled schema in one call,
  // and gradeRun persisted them.
  assert.deepEqual(grade.report.map((r) => r.question), QUESTIONS);
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

// ---------- actor system prompt ----------

test("discovery actor prompt has the overlay with ## Your task still last", () => {
  const { resolvedCase } = makeFixture({ mode: "discovery" });
  const overlay = promptFile("actor-discovery.md").trim();
  // The overlay itself must never contain the marker, or mock-llm's
  // last-occurrence split would extract the overlay instead of the story.
  assert.ok(!overlay.includes("## Your task"));
  const actor = new Actor(resolvedCase, loadPersona("tester"));
  assert.ok(actor.system.includes(overlay), "discovery overlay present");
  // Mirror mock-llm's extraction: everything after the LAST marker is the story.
  const afterMarker = actor.system.split("## Your task").pop();
  assert.equal(afterMarker.trim(), STORY);
  assert.ok(!/\n## /.test(afterMarker), "## Your task is the last heading");
  assert.ok(
    actor.system.indexOf(overlay) > actor.system.indexOf("## Persona"),
    "overlay comes after the persona section",
  );
});

test("journey actor prompt is byte-identical to the pre-change assembly", () => {
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
