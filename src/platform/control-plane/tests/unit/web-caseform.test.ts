// The web story form's YAML round-trip (src/platform/web/lib/caseform.ts). Lives in the
// server's unit tier because the emitted browser ESM also runs under Node — this
// is the only offline gate that covers the web app's form model.
// UX principle 3: the YAML toggle shows the identical bytes a CLI user would commit;
// a form edit may only re-emit the fields it changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYaml, toModel, applyModelToText } from "../../../web/lib/caseform.js";

const COMMENTED = `# checkout smoke — owned by the payments pod
story: |
  You have a cart with one item. Apply the coupon
  SAVE10 and confirm the total drops by 10%.
description: Coupon reduces the total
tags: [payments, smoke]   # keep in the smoke set
app:
  base_url: https://staging.example.com  # do not point at prod
success:
  - element_exists: "[data-testid=total]"
  - assert: the total shows a 10% discount
`;

test("caseform: an untouched model returns the input bytes verbatim", () => {
  const model = toModel(parseYaml(COMMENTED));
  assert.equal(applyModelToText(COMMENTED, model), COMMENTED);
});

test("caseform: editing one field preserves comments, block style and unknown keys", () => {
  const model = toModel(parseYaml(COMMENTED));
  model.description = "Coupon SAVE10 reduces the total by 10%";
  const out = applyModelToText(COMMENTED, model);

  assert.match(out, /# checkout smoke — owned by the payments pod/);
  assert.match(out, /# do not point at prod/);
  assert.match(out, /story: \|/); // block literal survives
  // an untouched flow collection keeps its style + inline comment (no [ smoke ] padding drift)
  assert.match(out, /tags: \[payments, smoke\] +# keep in the smoke set/);
  assert.match(out, /description: Coupon SAVE10 reduces the total by 10%/);
  // Only description changed in the parsed value.
  const before = parseYaml(COMMENTED);
  const after = parseYaml(out);
  assert.deepEqual({ ...after, description: before.description }, before);
});

test("caseform: response_status is emitted as a string (schema types it \"200\"/\"2xx\")", () => {
  const model = toModel({});
  model.story = "Hit the health endpoint.";
  model.success = [{ kind: "response_status", value: "200", label: "" }];
  const obj = parseYaml(applyModelToText("", model));
  assert.equal(typeof obj.success[0].response_status, "string");
  assert.equal(obj.success[0].response_status, "200");
});

test("caseform: console_errors / accessibility_violations stay numeric", () => {
  const model = toModel({});
  model.story = "Browse without console noise.";
  model.success = [
    { kind: "console_errors", value: "0", label: "" },
    { kind: "accessibility_violations", value: "0", label: "" },
  ];
  const obj = parseYaml(applyModelToText("", model));
  assert.equal(obj.success[0].console_errors, 0);
  assert.equal(obj.success[1].accessibility_violations, 0);
});

test("caseform: a new key lands in readable KEY_ORDER position, not appended", () => {
  const src = "story: do the thing\nsuccess:\n  - assert: it worked\n";
  const model = toModel(parseYaml(src));
  model.description = "one-liner";
  const out = applyModelToText(src, model);
  const keys = Object.keys(parseYaml(out));
  assert.deepEqual(keys, ["story", "description", "success"]);
});

test("caseform: switching mode to journey drops the key (default), discovery writes it", () => {
  const src = "story: explore\nmode: discovery\n";
  const model = toModel(parseYaml(src));
  model.mode = "journey";
  assert.equal("mode" in parseYaml(applyModelToText(src, model)), false);

  const model2 = toModel(parseYaml("story: explore\n"));
  model2.mode = "discovery";
  assert.equal(parseYaml(applyModelToText("story: explore\n", model2)).mode, "discovery");
});

test("caseform: multi-line story edits emit a block literal", () => {
  const model = toModel({});
  model.story = "First line.\nSecond line.";
  const out = applyModelToText("tags: [a]\n", model);
  assert.match(out, /story: \|/);
  assert.equal(parseYaml(out).story.replace(/\n$/, ""), "First line.\nSecond line.");
});

// P2 inline drafting: "Apply draft" drops the model's YAML into the unsaved
// editor state (story.js applyDraft sets st.raw = draft.yaml) — the same bytes
// the YAML view shows and the form parses. This pins that a returned draft's
// YAML rides losslessly through the form/YAML adapter into populated fields,
// with no save. Applying is pure client state; the server never sees it until
// the ordinary Save commits.
test("caseform: an assistant draft's YAML populates the form fields losslessly", () => {
  const draftYaml =
    "story: |\n  A new user signs up and lands on their dashboard.\n" +
    "description: Signup happy path\ntags: [smoke, signup]\n" +
    "success:\n  - assert: the dashboard is shown\n  - element_exists: \"[data-testid=welcome]\"\n";
  const model = toModel(parseYaml(draftYaml));
  assert.match(model.story, /signs up and lands on their dashboard/);
  assert.equal(model.description, "Signup happy path");
  assert.equal(model.tags, "smoke, signup");
  assert.deepEqual(model.success.map((r: HostedDynamic) => r.kind), ["assert", "element_exists"]);
  // The YAML view shows the identical bytes an untouched applied draft carries.
  assert.equal(applyModelToText(draftYaml, model), draftYaml);
});

// P4: an api story may carry a STRUCTURED criterion — an operation selector or
// an invariant policy. The form has one text input per row, so a naive
// String(value) rendered those as "[object Object]" and any edit elsewhere in
// the success list wrote that string back over the real policy. They now
// round-trip through their compact flow form.
test("caseform: structured selectors and invariant policies survive a form edit", () => {
  const yaml = [
    "story: check the ledger",
    "success:",
    "  - api_called: POST /accounts",
    "  - response_status:",
    '      op: "POST /accounts"',
    '      status: "201"',
    "  - invariant:",
    "      policy: pagination",
    '      op: "GET /entries"',
    '      identity: "$.entries[*].id"',
    "",
  ].join("\n");

  const model = toModel(parseYaml(yaml));
  assert.deepEqual(model.success.map((r: HostedDynamic) => r.kind), ["api_called", "response_status", "invariant"]);
  assert.equal(model.success.every((r: HostedDynamic) => !String(r.value).includes("[object Object]")), true);

  // Edit an unrelated row: the whole list is re-emitted, so this is exactly the
  // path that used to destroy the two structured criteria.
  model.success[0].value = "POST /entries";
  const out = applyModelToText(yaml, model);
  const parsed = parseYaml(out);
  assert.equal(parsed.success[0].api_called, "POST /entries");
  assert.deepEqual(parsed.success[1].response_status, { op: "POST /accounts", status: "201" });
  assert.deepEqual(parsed.success[2].invariant, { policy: "pagination", op: "GET /entries", identity: "$.entries[*].id" });
});
