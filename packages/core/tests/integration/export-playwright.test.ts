// End-to-end shape of `playtest export`: a deterministic hand-built baseline
// renders to a byte-stable golden file, and the emitted TypeScript actually
// parses.
//
// The parse check is the structural guard against escaping bugs — the one
// correctness risk that unit assertions on substrings cannot catch. It needs no
// @playwright/test and no network: type annotations are stripped, then
// `node --check` parses the result as an ES module.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import module from "node:module";
import { fileURLToPath } from "node:url";

import { exportSpec } from "../../src/export-playwright.ts";
import { CASE, ENVELOPES, META } from "./fixtures/export-playwright/baseline.ts";

const GOLDEN = fileURLToPath(new URL("./fixtures/export-playwright/checkout.spec.ts.golden", import.meta.url));

/** The emitted spec as plain JS, so `node --check` can parse it anywhere. */
const toPlainJs = (code: string) => module.stripTypeScriptTypes(code, { mode: "strip" });

function render() {
  return exportSpec({ caseCfg: CASE, envelopes: ENVELOPES as LegacyTestValue, meta: META, sourcePath: "stories/checkout.yaml" }); // SAFETY: frozen generator fixture predates the current envelope contract
}

function assertParses(code: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-export-"));
  try {
    const file = path.join(dir, "spec.mjs");
    fs.writeFileSync(file, toPlainJs(code));
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the exported spec matches the committed golden byte for byte", () => {
  const { code, filename } = render();
  assert.equal(filename, "checkout.spec.ts");
  const expected = fs.readFileSync(GOLDEN, "utf8");
  assert.equal(code, expected, "export output drifted from the golden — review the diff, then update the golden deliberately");
});

test("the emitted spec parses as an ES module (escaping is structurally sound)", () => {
  assertParses(render().code);
});

test("a locator full of quotes and backslashes still parses", () => {
  // The fixture above is realistic; this is the adversarial case. If escaping is
  // wrong, --check fails rather than the test merely asserting on a substring.
  const nasty = [
    `text="he said \\"hi\\""`,
    `[data-testid="a'b\\\\c"] >> css=[title='x"y']`,
    "role=button[name=\"back\\\\slash\"]",
  ];
  const envelopes = nasty.map((locator, i) => ({
    step: i + 1,
    agent: {
      thought: 'a thought with "quotes", `backticks`, ${braces} and a\nnewline',
      action: { type: "type", ref: `e${i}`, text: 'text "with" \\ everything\n${x}`y`' },
    },
    resolution: { ref: `e${i}`, locator, bbox: {} },
    result: { ok: true },
  }));
  const { code } = exportSpec({
    caseCfg: { ...CASE, success: [{ assert: 'a claim with "quotes" and \\ backslash' }] },
    envelopes,
  });
  assertParses(code);
  // ...and the locators survive the round trip unchanged.
  for (const locator of nasty) assert.ok(code.includes(JSON.stringify(locator)), `locator lost: ${locator}`);
});
