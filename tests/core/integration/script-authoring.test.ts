// The bounded authoring loop (docs/contracts/scripts.md#the-authoring-loop),
// end to end: handout → model turn → S1 runner → soundness → bundle.
//
// Everything is real except the model: a real loopback API, the real spec
// provisioning, the real handout, the real runner in a real subprocess, the real
// obligation accounting and gate column. The model is a scripted gateway serving
// a fixed list of drafts, which is what makes the loop's own semantics — what it
// accepts, what it rejects, when it stops — testable at all.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_AUTHORING_BUDGET,
  evaluateRevisionDiscipline,
  parseAuthoringReply,
  prepareAuthoringJob,
  replayScriptBundle,
  runAuthoringJob,
} from "../../../src/core/public/api-suite-scripts.ts";
import { DummyConfigError } from "../../../src/core/config.ts";
import { AUTHORING_RULES, startAuthoringApi } from "../../fixtures/authoring-api/server.ts";
import { startScriptedAuthoringModel } from "../../support/scripted-model.ts";

const DRAFTS = fileURLToPath(new URL("../../fixtures/authoring-api/drafts/", import.meta.url));
const draft = (name: LegacyTestValue) => fs.readFileSync(path.join(DRAFTS, `${name}.mjs`), "utf8");

const CITATION = "spec: GET /widgets/{id} declares 404 with the Error envelope; it declares no 400";

/** The three turns a well-behaved author takes against this fixture. */
const RECON = { script: draft("draft-recon"), notes: "Recon pass: learn the vocabulary before asserting anything." };
const COMPLETE = { script: draft("draft-complete"), notes: "Cover every obligation. Two checks fail; one looks like a real violation." };
const REVISED = {
  script: draft("draft-revised"),
  notes: "Correct the guessed 400 to the documented 404 and cite its evidence. The republish violation stays.",
  revisions: [{ check: "unknown-widget-read-is-400", change: "replaced by unknown-widget-read-is-404, now citing evidence", citation: CITATION }],
};

let api: LegacyTestValue;
let model: LegacyTestValue;
let outDir: LegacyTestValue;
let previousBaseUrl: LegacyTestValue;

const authorization = (origin: LegacyTestValue) => ({ origin, approved_by: "the widget team", approved_at: "2026-07-26", record: "tests/fixtures/authoring-api", write: true });

const job = (overrides = {}) => ({
  target: { base_url: api.url, authorization: authorization(api.origin) },
  rules: AUTHORING_RULES,
  out_dir: outDir,
  budget: { iterations: 5, requests: 400, execution_budget: 80, wall_clock_ms: 120_000, execution_timeout_ms: 30_000 },
  ...overrides,
});

beforeEach(async () => {
  api = await startAuthoringApi({ spec: "path", faults: { republishSucceeds: true } });
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "script-authoring-"));
  previousBaseUrl = process.env.PLAYTEST_LLM_BASE_URL;
});

afterEach(async () => {
  await api.close();
  if (model) await model.close();
  model = null;
  if (previousBaseUrl === undefined) delete process.env.PLAYTEST_LLM_BASE_URL;
  else process.env.PLAYTEST_LLM_BASE_URL = previousBaseUrl;
  fs.rmSync(outDir, { recursive: true, force: true });
});

const useModel = async (turns: LegacyTestValue) => {
  model = await startScriptedAuthoringModel(turns);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;
  return model;
};

test("from spec and statements alone the loop reaches a sound suite that keeps the seeded fault as a finding", async () => {
  await useModel([RECON, COMPLETE, REVISED]);
  const result: LegacyTestValue = await runAuthoringJob(job());

  // 1. It terminated on SOUNDNESS, not on green checks: the verdict is exit 1.
  assert.equal(result.sound, true);
  assert.equal(result.terminated, "sound");
  assert.equal(result.exitCode, 1, "a sound suite with a failing check exits 1, and that is success for authoring");
  assert.equal(result.report.soundness.ok, true);

  // 2. Every obligation is accounted for — the sufficiency half of N5.
  assert.equal(result.report.obligations.summary.total, 13);
  assert.equal(result.report.obligations.summary.unaccounted, 0);
  assert.equal(result.report.obligations.summary.covered, 13);

  // 3. The seeded fault is a finding with resolvable evidence, not a defect.
  assert.equal(result.findings.length, 1);
  const [finding] = result.findings;
  assert.equal(finding.id, "republish-is-refused");
  assert.equal(finding.obligation, "rule:lifecycle");
  assert.equal(finding.source, "check");
  assert.equal(finding.evidence_verified, true);
  assert.ok(finding.evidence.exchanges.some((exchange: LegacyTestValue) => exchange.method === "POST" && /\/publish$/.test(exchange.url) && exchange.status === 200));
  assert.equal(result.report.defects.length, 0);

  // 4. The transcript records every revision, and the one revision cites the spec.
  const { transcript } = result;
  assert.equal(transcript.iterations.length, 3);
  assert.deepEqual(transcript.iterations.map((iteration: LegacyTestValue) => iteration.accepted), [true, true, true]);
  const revisions = transcript.iterations.flatMap((iteration: LegacyTestValue) => iteration.revisions ?? []);
  assert.equal(revisions.length, 1);
  assert.match(revisions[0].citation, /^spec:/);
  assert.equal(revisions[0].check, "unknown-widget-read-is-400");
  for (const revision of revisions) assert.ok(/^(spec|rule):/i.test(revision.citation), "every revision carries a citing justification");

  // 5. The handout the model was given is on disk, obligation manifest included.
  const handout = fs.readdirSync(result.handoutDir).sort();
  assert.deepEqual(handout, ["BRIEF.md", "CLIENT.md", "INVARIANTS.md", "handout-manifest.json", "obligations.json", "openapi.json"]);
  const obligations = JSON.parse(fs.readFileSync(path.join(result.handoutDir, "obligations.json"), "utf8"));
  assert.equal(obligations.total, 13);
  assert.ok(obligations.obligations.some((entry: LegacyTestValue) => entry.id === "rule:lifecycle"));

  // 6. The prompts carried the handout and the previous report, and nothing else drove the loop.
  assert.equal(model.calls.length, 3);
  assert.match(model.prompts[0], /obligations\.json/);
  assert.match(model.prompts[0], /rule:lifecycle/);
  assert.match(model.prompts[1], /THE LAST EXECUTION'S REPORT/);
  assert.match(model.prompts[2], /republish-is-refused/);
});

test("a genuine violation cannot be revised away without a citing justification", async () => {
  // The rename of the guessed-400 check is properly justified; the widening of
  // the republish check is not. Only the second one should be objected to.
  const softened = {
    script: draft("draft-softened"),
    notes: "Widen the republish check; the service seems to treat publish as idempotent.",
    revisions: [{ check: "unknown-widget-read-is-400", change: "replaced by unknown-widget-read-is-404", citation: CITATION }],
  };
  await useModel([RECON, COMPLETE, softened, REVISED]);
  const result: LegacyTestValue = await runAuthoringJob(job());

  assert.equal(result.sound, true);
  assert.equal(result.transcript.iterations.length, 4);
  assert.deepEqual(result.transcript.iterations.map((iteration: LegacyTestValue) => iteration.accepted), [true, true, false, true]);

  // The rejection names the check and says what would have made it acceptable.
  const rejected = result.transcript.iterations[2];
  assert.equal(rejected.objections.length, 1);
  assert.equal(rejected.objections[0].check, "republish-is-refused");
  assert.equal(rejected.objections[0].kind, "expectation changed");
  assert.match(rejected.objections[0].reason, /citation beginning "spec:" or "rule:"/);
  // It executed — the loop judges the draft's report, not its text — but the
  // draft did not become the accepted one.
  assert.equal(rejected.execution.exit_code, 0, "the softened draft passes its own weakened check, which is exactly the danger");

  // The objection was carried into the next turn, and the finding survived.
  assert.deepEqual(result.transcript.iterations[3].objections_carried, rejected.objections);
  assert.match(model.prompts[3], /REJECTED AND HAS BEEN REVERTED/);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].id, "republish-is-refused");
  assert.equal(result.exitCode, 1);
  const bundled: LegacyTestValue = JSON.parse(fs.readFileSync(path.join(result.bundleDir, "suite.mjs"), "utf8").includes("|| again.status === 200") ? "true" : "false");
  assert.equal(bundled, false, "the softened draft is not what got bundled");
});

test("the loop refuses to start without a recorded target authorization", async () => {
  await useModel([RECON]);
  await assert.rejects(
    () => runAuthoringJob({ ...job(), target: { base_url: api.url } }),
    (error) => {
      assert.ok(error instanceof DummyConfigError);
      assert.match(error.message, /no recorded authorization/);
      assert.match(error.message, /safe to write test data/);
      return true;
    },
  );
  assert.equal(model.calls.length, 0, "no model call is made before the license is checked");
  assert.equal(api.requests.length, 0, "nothing at all reaches the target");
  assert.equal(fs.existsSync(path.join(outDir, "executions")), false);
});

test("an authorization for a different origin does not transfer to this one", async () => {
  await useModel([RECON]);
  const elsewhere = await startAuthoringApi({ spec: "path" });
  try {
    await assert.rejects(
      () => runAuthoringJob({ ...job(), target: { base_url: api.url, authorization: authorization(elsewhere.origin) } }),
      (error) => {
        assert.ok(error instanceof DummyConfigError);
        assert.match(error.message, /covers http:\/\/127\.0\.0\.1:\d+, but this job resolves http:\/\/127\.0\.0\.1:\d+/);
        assert.match(error.message, /an origin change invalidates it/);
        return true;
      },
    );
    assert.equal(model.calls.length, 0);
    assert.equal(api.requests.length, 0);
    assert.equal(elsewhere.requests.length, 0);
  } finally {
    await elsewhere.close();
  }
});

test("the bundle replays through the S1 runner on a fresh instance with identical verdicts", async () => {
  await useModel([RECON, COMPLETE, REVISED]);
  const authored: LegacyTestValue = await runAuthoringJob(job());
  assert.equal(authored.sound, true);

  const bundled: LegacyTestValue = fs.readdirSync(authored.bundleDir).sort();
  assert.deepEqual(bundled, ["authoring-transcript.json", "bundle.json", "handout", "har.json", "script-report.json", "suite.mjs"]);
  const manifest: LegacyTestValue = JSON.parse(fs.readFileSync(path.join(authored.bundleDir, "bundle.json"), "utf8"));
  assert.equal(manifest.authoring_bundle_version, 1);
  assert.equal(manifest.script.sha256, authored.report.script.sha256);
  assert.equal(manifest.findings.length, 1);

  // A fresh process, a fresh instance of the same build, a fresh port — and the
  // bundle carries everything the verdict depends on.
  const fresh: LegacyTestValue = await startAuthoringApi({ spec: "path", faults: { republishSucceeds: true } });
  const replayDir = path.join(outDir, "replay");
  try {
    const replay: LegacyTestValue = await replayScriptBundle({
      bundle_dir: authored.bundleDir,
      target: { base_url: fresh.url, authorization: authorization(fresh.origin) },
      out_dir: replayDir,
    });
    assert.notEqual(fresh.origin, api.origin);
    assert.equal(replay.exitCode, authored.exitCode);
    assert.deepEqual(replay.report.verdict.failing_checks, authored.report.verdict.failing_checks);
    assert.deepEqual(replay.report.verdict.pass, authored.report.verdict.pass);
    assert.deepEqual(replay.report.obligations.summary, authored.report.obligations.summary);
    assert.deepEqual(
      replay.report.checks.map((check: LegacyTestValue) => [check.id, check.pass]),
      authored.report.checks.map((check: LegacyTestValue) => [check.id, check.pass]),
    );
    assert.deepEqual(replay.report.gate.checks.map((check: LegacyTestValue) => [check.policy, check.applicable, check.pass]), authored.report.gate.checks.map((check: LegacyTestValue) => [check.policy, check.applicable, check.pass]));
    assert.equal(replay.report.script.sha256, authored.report.script.sha256);
  } finally {
    await fresh.close();
  }

  // A modified bundle is not replayed: the fingerprint is what an approval covers.
  fs.appendFileSync(path.join(authored.bundleDir, "suite.mjs"), "\n// tampered\n");
  await assert.rejects(
    () => replayScriptBundle({ bundle_dir: authored.bundleDir, target: { base_url: api.url, authorization: authorization(api.origin) } }),
    (error) => error instanceof DummyConfigError && /no longer match the bundle manifest/.test(error.message),
  );
});

test("the loop stops on its iteration budget and says so, rather than looping or claiming success", async () => {
  await useModel([RECON, RECON, RECON]);
  const result: LegacyTestValue = await runAuthoringJob(job({ budget: { iterations: 2, requests: 400, execution_budget: 60, wall_clock_ms: 60_000, execution_timeout_ms: 30_000 } }));

  assert.equal(result.sound, false);
  assert.equal(result.terminated, "iterations");
  assert.match(result.detail, /used all 2 turns/);
  assert.equal(model.calls.length, 2);
  assert.equal(result.transcript.budget.used.executions, 2);
  assert.ok(result.transcript.outcome.reasons.some((reason: LegacyTestValue) => /unaccounted/.test(reason)));
  // Even an unsound job leaves its evidence behind.
  assert.ok(fs.existsSync(result.transcriptPath));
  assert.ok(fs.existsSync(path.join(result.bundleDir, "suite.mjs")));
});

test("a reply the loop cannot use costs a turn and is objected to, never crashed on", async () => {
  await useModel(["I would rather discuss the weather.", RECON, COMPLETE, REVISED]);
  const result: LegacyTestValue = await runAuthoringJob(job());

  assert.equal(result.sound, true);
  assert.equal(result.transcript.iterations[0].objections[0].kind, "unparseable");
  assert.equal(result.transcript.iterations[0].execution, undefined, "nothing was executed for an unusable reply");
  assert.match(model.prompts[1], /no fenced ```js block/);
});

test("preparing a job writes the handout without spending a model call", async () => {
  await useModel([]);
  const prepared: LegacyTestValue = await prepareAuthoringJob(job());
  assert.equal(model.calls.length, 0);
  assert.equal(prepared.obligations.length, 13);
  assert.equal(prepared.license.write, true);
  assert.equal(prepared.specSource.kind, "discovered");

  const brief = fs.readFileSync(path.join(prepared.handoutDir, "BRIEF.md"), "utf8");
  assert.match(brief, new RegExp(api.url.replace(/[.[\]/]/g, "\\$&")));
  assert.match(brief, /Turns \(executions\) for the whole job \| \*\*5\*\*/);
  assert.doesNotMatch(brief, /\{\{/, "no template placeholder survives into a handout");
  const client = fs.readFileSync(path.join(prepared.handoutDir, "CLIENT.md"), "utf8");
  assert.doesNotMatch(client, /\{\{/);
  assert.match(client, /no credential references/);
  const invariants: LegacyTestValue = fs.readFileSync(path.join(prepared.handoutDir, "INVARIANTS.md"), "utf8");
  assert.match(invariants, /`rule:lifecycle`/);
  assert.match(invariants, /the rule wins/);
});

test("card notes reach the handout, and the rule statement is what the obligation carries", async () => {
  await useModel([]);
  const prepared: LegacyTestValue = await prepareAuthoringJob(
    job({
      rules: [{ ...AUTHORING_RULES[0], notes: ["Bulk imports publish twice on purpose; that path is out of scope."] }],
    }),
  );
  const invariants: LegacyTestValue = fs.readFileSync(path.join(prepared.handoutDir, "INVARIANTS.md"), "utf8");
  assert.match(invariants, /\*\*Owner's note:\*\* Bulk imports publish twice on purpose/);
  const lifecycle = prepared.obligations.find((entry: LegacyTestValue) => entry.id === "rule:lifecycle");
  assert.match(lifecycle.statement, /publishing an already-published widget is refused with 409/);
});

test("budget defaults are the S0 numbers, and one execution cannot cost more than the whole job", () => {
  assert.deepEqual({ ...DEFAULT_AUTHORING_BUDGET }, {
    iterations: 8,
    requests: 1500,
    wall_clock_ms: 45 * 60_000,
    execution_budget: 400,
    execution_timeout_ms: 5 * 60_000,
    request_timeout_ms: 15_000,
    max_output_tokens: 64_000,
  });
});

test("revision discipline is mechanical: it fires on removal, on a changed expectation, and on a silent pass", () => {
  const previous = { checks: [{ id: "a", pass: false, expected: "409" }, { id: "b", pass: true, expected: "200" }] };
  const removed = evaluateRevisionDiscipline({ previous, current: { checks: [] }, revisions: [] });
  assert.equal(removed.length, 1);
  assert.equal(removed[0].kind, "removed");

  const widened = evaluateRevisionDiscipline({ previous, current: { checks: [{ id: "a", pass: true, expected: "409 or 200" }] }, revisions: [] });
  assert.equal(widened[0].kind, "expectation changed");

  const uncited = evaluateRevisionDiscipline({
    previous,
    current: { checks: [{ id: "a", pass: true, expected: "409 or 200" }] },
    revisions: [{ check: "a", change: "the service is idempotent here" }],
  });
  assert.equal(uncited.length, 1, "a justification without a spec/rule citation is not enough to revise a failing check");

  const cited = evaluateRevisionDiscipline({
    previous,
    current: { checks: [{ id: "a", pass: true, expected: "409 or 200" }] },
    revisions: [{ check: "a", change: "widened", citation: "rule:lifecycle — the rule's declared exception covers this" }],
  });
  assert.deepEqual(cited, []);

  // Repairing the suite's own bug — same expectation, now passing — needs the
  // record but not a contract citation.
  const repaired = evaluateRevisionDiscipline({
    previous,
    current: { checks: [{ id: "a", pass: true, expected: "409" }] },
    revisions: [{ check: "a", change: "I was posting to the wrong path" }],
  });
  assert.deepEqual(repaired, []);
  assert.equal(evaluateRevisionDiscipline({ previous: null, current: { checks: [] }, revisions: [] }).length, 0);
});

test("a reply is parsed tolerantly, and an unlabelled or missing suite is reported rather than guessed at", () => {
  const good = parseAuthoringReply('```json\n{"notes":"n","revisions":[{"check":"a"}]}\n```\n\n```js\nexport default async function () {}\n```');
  assert.match(good.script, /export default/);
  assert.equal(good.notes, "n");
  assert.equal(good.revisions.length, 1);
  assert.deepEqual(good.problems, []);

  const unlabelled = parseAuthoringReply("```\nexport default async function () {}\n```");
  assert.match(unlabelled.script, /export default/);
  assert.match(unlabelled.problems[0], /label it/);

  assert.equal(parseAuthoringReply("no code here").script, null);
  assert.equal(parseAuthoringReply("```js\nconst x = 1;\n```").problems[0], "the returned module has no `export default` — the entry contract needs a default-exported async function");
});
