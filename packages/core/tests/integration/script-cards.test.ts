// Rule cards end to end in the engine: Level 0, the observation pass, and the
// route an approved card's sentence and note take into a real authoring job
// (S3 scope items 1, 2, and the handout half of 3).
//
// Level 0 is the claim that a user who answers nothing still gets a real suite.
// It is not provable by reading a policy list, so this file authors a suite
// with ZERO approved rule cards against the real fixture, through the real
// loop and the real runner, and checks that the four shipped policies were
// evaluated against real traffic and that every obligation was accounted for.
//
// The second test is the optional half of the Level 1 input: a mechanical
// read-only pass through the shipped client, which is what S0's proposal trial
// spent 42 of its 60 requests on.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEVEL_0_POLICIES,
  approvedCardRules,
  buildProposalPrompt,
  observeApi,
  runAuthoringJob,
} from "../../src/public/api-suite-scripts.ts";
import { loadOpenApi } from "../../src/openapi.ts";
import { startAuthoringApi } from "../../../../tests/fixtures/authoring-api/server.ts";
import { startScriptedAuthoringModel } from "../../../../tests/support/scripted-model.ts";

const DRAFTS = fileURLToPath(new URL("../../../../tests/fixtures/authoring-api/drafts/", import.meta.url));
const SPEC = loadOpenApi(fileURLToPath(new URL("../../../../tests/fixtures/authoring-api/openapi.json", import.meta.url)));
const draft = (name: LegacyTestValue) => fs.readFileSync(path.join(DRAFTS, `${name}.mjs`), "utf8");

let api: LegacyTestValue;
let model: LegacyTestValue;
let outDir: LegacyTestValue;
let previousBaseUrl: LegacyTestValue;

beforeEach(async () => {
  // The seeded semantic fault is LIVE for the Level 0 run: the point of the
  // test is that a Level 0 suite is real, not that it is sufficient.
  api = await startAuthoringApi({ spec: "path", faults: { republishSucceeds: true } });
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "script-level0-"));
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

test("with zero approved cards the loop still authors a Level 0 suite whose policies are exercised against the fixture", async () => {
  model = await startScriptedAuthoringModel([{ script: draft("draft-level0"), notes: "No approved rules: cover every operation and let the default policies judge the traffic." }]);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;

  const result = await runAuthoringJob({
    target: { base_url: api.url, authorization: { origin: api.origin, approved_by: "the widget team", approved_at: "2026-07-26", record: "tests/fixtures/authoring-api", write: true } },
    rules: [],
    out_dir: outDir,
    budget: { iterations: 3, requests: 200, execution_budget: 60, wall_clock_ms: 120_000, execution_timeout_ms: 30_000 },
  });

  assert.equal(result.terminated, "sound", result.detail);
  assert.equal(result.sound, true);

  // The handout carries no rules and says so in plain words.
  const invariants: LegacyTestValue = result.handout.files.find((file) => file.path === "INVARIANTS.md")!.contents; // SAFETY: the generated handout always contains INVARIANTS.md
  assert.equal(result.handout.rules.length, 0);
  assert.match(invariants, /No rule statements were approved for this suite/);
  assert.ok(!result.handout.obligations.some((obligation: LegacyTestValue) => obligation.source === "rule"));

  // …and every Level 0 policy is an obligation, evaluated against real traffic.
  const policyObligations = result.handout.obligations.filter((obligation: LegacyTestValue) => obligation.source === "policy").map((obligation: LegacyTestValue) => obligation.id);
  assert.deepEqual(policyObligations.sort(), LEVEL_0_POLICIES.map((policy: LegacyTestValue) => `policy:${policy}`).sort());

  const gate = result.report.gate;
  assert.deepEqual(gate.checks.map((check: LegacyTestValue) => check.policy).sort(), [...LEVEL_0_POLICIES].sort());
  for (const check of gate.checks) {
    assert.equal(check.applicable, true, `${check.policy} matched no traffic`);
    assert.equal(check.pass, true, `${check.policy}: ${check.detail}`);
  }
  assert.equal(gate.pass, true);

  // Soundness includes sufficiency: nothing may be left unaccounted.
  assert.equal(result.report.obligations.summary.unaccounted, 0, JSON.stringify(result.report.obligations.entries.filter((entry: LegacyTestValue) => entry.status === "unaccounted")));
  assert.equal(result.report.obligations.summary.total, LEVEL_0_POLICIES.length + SPEC.operations.length);
  assert.equal(result.report.obligations.summary.covered, result.report.obligations.summary.total);

  // The honest limit, asserted rather than asserted-about: the seeded semantic
  // fault is live and a Level 0 suite does not see it.
  assert.equal(result.findings.length, 0);
  assert.equal(api.faults.republishSucceeds, true);
});

test("the observation pass is read-only at the wire, bounded, and digests into the proposal prompt", async () => {
  const observation = await observeApi({ target: { base_url: api.url }, spec: SPEC, budget: 6 });

  assert.ok(observation.requests > 0);
  assert.ok(observation.requests <= 6);
  // GET only: the pass never calls an operation the document does not
  // parameterize, and never a mutation.
  for (const entry of observation.harEntries) assert.equal(entry.request.method, "GET");
  assert.ok(observation.exchanges.some((exchange: LegacyTestValue) => exchange.operation === "GET /health"));
  assert.ok(observation.exchanges.some((exchange: LegacyTestValue) => exchange.path === "/widgets?limit=1"));

  // Nothing it did changed the fixture.
  const before = api.requests.length;
  assert.ok(before > 0);
  const listing = await fetch(new URL("/widgets", api.url));
  assert.equal((await listing.json()).widgets.length, 2);

  const prompt = buildProposalPrompt({ spec: SPEC, observation });
  assert.match(prompt.user, /A read-only observation of the running service/);
  assert.match(prompt.user, /`GET \/health`/);
  assert.match(prompt.user, /the client refused every non-GET\/HEAD method at the wire/);
});

test("the observation pass stops at its budget rather than running the document to the end", async () => {
  const observation = await observeApi({ target: { base_url: api.url }, spec: SPEC, budget: 1 });
  assert.equal(observation.requests, 1);
  assert.ok(observation.refused.some((refusal: LegacyTestValue) => /budget/.test(refusal)));
});

test("an approved card's sentence and note reach the handout and the authoring transcript; a denied one reaches neither", async () => {
  // Three cards in three states, exactly as the console would hold them.
  const cards = [
    {
      id: "lifecycle",
      title: "Publication is one-way and refuses repetition",
      statement: 'A widget is created in status "draft", publishing moves it to "published", and publishing an already-published widget is refused with 409.',
      applicability: "Every widget, however it was created.",
      exceptions: "None — there is no re-publish, not even for an administrator.",
      note: "Support leans on this: a second publish re-notifies every subscriber.",
      provenance: "POST /widgets/{id}/publish · 409 already_published",
      state: "approved",
      origin: "proposed",
    },
    { id: "deletion", title: "A deleted widget is gone", statement: "A deleted widget answers 404 on read and does not appear in the listing.", state: "approved", origin: "authored" },
    { id: "names-are-unique", statement: "Two widgets never share a name.", state: "candidate", origin: "proposed" },
    { id: "drafts-expire", statement: "A draft widget is deleted automatically after thirty days.", state: "denied", origin: "proposed" },
  ];

  model = await startScriptedAuthoringModel([{ script: draft("draft-revised"), notes: "Cover both approved rules." }]);
  process.env.PLAYTEST_LLM_BASE_URL = model.baseUrl;

  const result = await runAuthoringJob({
    target: { base_url: api.url, authorization: { origin: api.origin, approved_by: "the widget team", approved_at: "2026-07-26", write: true } },
    rules: approvedCardRules(cards),
    out_dir: outDir,
    budget: { iterations: 3, requests: 200, execution_budget: 80, wall_clock_ms: 120_000, execution_timeout_ms: 30_000 },
  });

  assert.equal(result.terminated, "sound", result.detail);

  // The handout carries the note beside the sentence it steers…
  const invariants: LegacyTestValue = result.handout.files.find((file) => file.path === "INVARIANTS.md")!.contents; // SAFETY: the generated handout always contains INVARIANTS.md
  assert.match(invariants, /\*\*Owner's note:\*\* Support leans on this: a second publish re-notifies every subscriber\./);
  assert.match(invariants, /\*\*Declared exception:\*\* None — there is no re-publish/);

  // …and the transcript shows what the author was actually given. Prompts are
  // recorded by hash, so without the statements block a reviewer could not see
  // the owner's steering at all.
  const transcript = JSON.parse(fs.readFileSync(result.transcriptPath, "utf8"));
  const lifecycle = transcript.handout.statements.find((statement: LegacyTestValue) => statement.id === "lifecycle");
  assert.deepEqual(lifecycle.notes, ["Support leans on this: a second publish re-notifies every subscriber."]);
  assert.deepEqual(transcript.handout.rules.ids.sort(), ["deletion", "lifecycle"]);

  // The candidate and the denied card exist nowhere in the artifact.
  const artifact = [invariants, JSON.stringify(transcript), result.handout.files.map((file) => file.contents).join("\n")].join("\n");
  assert.ok(!artifact.includes("Two widgets never share a name"));
  assert.ok(!artifact.includes("deleted automatically after thirty days"));
  assert.ok(!result.report.obligations.entries.some((entry: LegacyTestValue) => entry.id === "rule:drafts-expire" || entry.id === "rule:names-are-unique"));

  // And the seeded fault the approved lifecycle card describes IS caught —
  // which is the difference between Level 0 and a reviewed rule.
  assert.ok(result.findings.some((finding: LegacyTestValue) => finding.obligation === "rule:lifecycle" && finding.evidence_verified));
});
