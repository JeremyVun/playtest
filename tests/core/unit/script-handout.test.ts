// The authoring handout (docs/contracts/scripts.md#the-handout).
//
// Two properties matter and neither is decorative: the handout is DERIVED — the
// same inputs write the same bytes, with no model anywhere near it — and it ships
// the resolved obligation manifest, because an author who has to guess an
// obligation id spends a whole turn of a small budget finding out (the S0 harness
// finding this productizes).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildHandout, handoutPrompt, normalizeRules, parseInvariantRules, renderInvariants, writeHandout } from "../../../src/core/public/api-suite-scripts.ts";
import { defaultScriptPolicies, deriveObligations } from "../../../src/core/public/api-suite-scripts.ts";
import { loadOpenApi } from "../../../src/core/openapi.ts";
import { DummyConfigError } from "../../../src/core/config.ts";

const SPEC: LegacyTestValue = loadOpenApi(fileURLToPath(new URL("../../fixtures/authoring-api/openapi.json", import.meta.url)));
const BUDGET = { iterations: 8, requests: 1500, wall_clock_ms: 45 * 60_000, execution_budget: 400, execution_timeout_ms: 300_000, request_timeout_ms: 15_000, max_output_tokens: 64_000 };

const RULES = [
  { id: "lifecycle", title: "Publication is one-way", statement: "Publishing an already-published widget is refused with 409.", notes: ["Bulk import is exempt."] },
];

const handout = (overrides: LegacyTestValue = {}): LegacyTestValue =>
  buildHandout({
    spec: SPEC,
    rules: RULES,
    target: { base_url: "http://127.0.0.1:4180", mode: "read-write", allowed_origins: [] },
    secrets: [{ name: "WIDGET_ADMIN_TOKEN", role: "the administrator" }],
    budget: BUDGET,
    policies: defaultScriptPolicies({ spec: SPEC }),
    ...overrides,
  });

test("the same inputs produce byte-identical handouts", () => {
  const first = handout();
  const second = handout();
  assert.deepEqual(first.files, second.files);
  assert.equal(first.manifest.sha256, second.manifest.sha256);
  assert.deepEqual(
    first.manifest.files.map((file: LegacyTestValue) => file.path),
    ["BRIEF.md", "CLIENT.md", "INVARIANTS.md", "obligations.json", "openapi.json"],
  );
});

test("the resolved obligation manifest ships with the handout, and matches what a run derives", () => {
  const built = handout();
  const derived = deriveObligations({ policies: defaultScriptPolicies({ spec: SPEC }), spec: SPEC, rules: normalizeRules(RULES) });
  assert.deepEqual(built.obligations, derived);

  const document = JSON.parse(built.files.find((file: LegacyTestValue) => file.path === "obligations.json").contents);
  assert.equal(document.total, derived.length);
  assert.deepEqual(document.obligations.map((entry: LegacyTestValue) => entry.id), derived.map((entry: LegacyTestValue) => entry.id));
  assert.ok(document.note.includes("must be one of these ids"));
});

test("every placeholder is filled, and a template with an unknown one is a bug rather than a blank", () => {
  const built = handout();
  for (const file of built.files) assert.doesNotMatch(file.contents, /\{\{[a-z_]+\}\}/, `${file.path} still carries a placeholder`);
  const brief = built.files.find((file: LegacyTestValue) => file.path === "BRIEF.md").contents;
  assert.match(brief, /http:\/\/127\.0\.0\.1:4180/);
  assert.match(brief, /\*\*8\*\*/);
  assert.match(brief, /45 minutes/);
  const client = built.files.find((file: LegacyTestValue) => file.path === "CLIENT.md").contents;
  assert.match(client, /`WIDGET_ADMIN_TOKEN` \| the administrator/);
});

test("the brief carries the two protocol corrections the S0 transcripts earned", () => {
  const brief = handout().files.find((file: LegacyTestValue) => file.path === "BRIEF.md").contents;
  // Two trials lost a real defect by resolving a rule-vs-document conflict in
  // the document's favour; three won a turn by looking before asserting.
  assert.match(brief, /The approved rule statement wins/);
  assert.match(brief, /Spend your first execution looking, not asserting/);
});

test("no rules is a supported handout, and says so rather than pretending", () => {
  const built = handout({ rules: [] });
  const invariants = built.files.find((file: LegacyTestValue) => file.path === "INVARIANTS.md").contents;
  assert.match(invariants, /No rule statements were approved/);
  assert.equal(built.obligations.filter((entry: LegacyTestValue) => entry.source === "rule").length, 0);
  assert.ok(built.obligations.length > 0, "Level 0 policies and operation coverage still create obligations");
});

test("statement prose parses into rules mechanically, ids and all", () => {
  const rules = parseInvariantRules(
    [
      "# Invariants",
      "",
      "## 1. Conservation of value {#conservation}",
      "",
      "No transfer creates or destroys value.",
      "",
      "Applies to every settled transfer, in both currencies.",
      "",
      "## 2. Lifecycle legality",
      "",
      "A settled transfer is terminal.",
      "",
    ].join("\n"),
  );
  assert.deepEqual(rules.map((rule: LegacyTestValue) => rule.id), ["conservation", "lifecycle-legality"]);
  assert.equal(rules[0].statement, "No transfer creates or destroys value.");
  assert.equal(rules[0].applicability, "Applies to every settled transfer, in both currencies.");
  assert.equal(rules[1].statement, "A settled transfer is terminal.");
});

test("approved statements are validated, never invented", () => {
  assert.throws(() => normalizeRules([{ id: "a" }]), (error) => error instanceof DummyConfigError && /has no statement/.test(error.message));
  assert.throws(() => normalizeRules([{ id: "a b", statement: "x" }]), (error) => error instanceof DummyConfigError && /letters, digits/.test(error.message));
  assert.throws(
    () => normalizeRules([{ id: "a", statement: "x" }, { id: "a", statement: "y" }]),
    (error) => error instanceof DummyConfigError && /duplicate rule id/.test(error.message),
  );
  // A statement document is accepted in place of records, for the pre-S3 path.
  assert.equal(normalizeRules("## A rule\n\nIt holds.\n")[0].id, "a-rule");
});

test("rendered statements carry applicability, owner notes, and approved skip reasons", () => {
  const rendered = renderInvariants(
    normalizeRules([
      { id: "pagination", statement: "A walk visits every account exactly once.", applicability: "Any page size.", notes: ["Fee accounts are ours."], approved_skip_reasons: ["the collection is never paginated"] },
    ]),
  );
  assert.match(rendered, /\(`rule:pagination`\)/);
  assert.match(rendered, /\*\*Applies:\*\* Any page size\./);
  assert.match(rendered, /\*\*Owner's note:\*\* Fee accounts are ours\./);
  assert.match(rendered, /\*\*Approved skip reasons:\*\* "the collection is never paginated"/);
});

test("writeHandout lands the files and a manifest with a hash per file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handout-"));
  try {
    const built = handout();
    writeHandout(dir, built);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["BRIEF.md", "CLIENT.md", "INVARIANTS.md", "handout-manifest.json", "obligations.json", "openapi.json"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "handout-manifest.json"), "utf8"));
    assert.equal(manifest.handout_version, 2);
    assert.equal(manifest.obligations.total, built.obligations.length);
    assert.equal(manifest.rules.ids[0], "lifecycle");
    for (const file of manifest.files) assert.equal(fs.statSync(path.join(dir, file.path)).size, file.bytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the prompt form carries every handout file, in reading order", () => {
  const prompt = handoutPrompt(handout());
  const order = ["BRIEF.md", "CLIENT.md", "INVARIANTS.md", "obligations.json", "openapi.json"];
  let cursor = -1;
  for (const name of order) {
    const at = prompt.indexOf(`===== ${name} =====`);
    assert.ok(at > cursor, `${name} appears, after the one before it`);
    cursor = at;
  }
});
