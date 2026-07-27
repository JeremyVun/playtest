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

/**
 * Every type annotation the generator is allowed to emit. Asserting the closed
 * set keeps the annotation-stripping fallback below honest: a new annotation
 * form must be added here deliberately, not slip through under-checked.
 */
const ANNOTATIONS = [
  ["const requests: { method: string; path: string }[] = [];", "const requests = [];"],
  ["let pathname: string | null = null;", "let pathname = null;"],
  ["function globToRegExp(glob: string): RegExp {", "function globToRegExp(glob) {"],
];

/** The emitted spec as plain JS, so `node --check` can parse it anywhere. */
function toPlainJs(code: LegacyTestValue) {
  // Node >= 22.13 can do this properly; older Nodes fall back to the closed
  // annotation set above (asserted against the real output by the test below).
  if (typeof module.stripTypeScriptTypes === "function") {
    return module.stripTypeScriptTypes(code, { mode: "strip" });
  }
  let out = code;
  for (const [ts, js] of ANNOTATIONS) out = out.split(ts).join(js);
  return out;
}

function render() {
  return exportSpec({ caseCfg: CASE, envelopes: ENVELOPES as LegacyTestValue, meta: META, sourcePath: "stories/checkout.yaml" }); // SAFETY: frozen generator fixture predates the current envelope contract
}

test("the exported spec matches the committed golden byte for byte", () => {
  const { code, filename } = render();
  assert.equal(filename, "checkout.spec.ts");
  const expected = fs.readFileSync(GOLDEN, "utf8");
  assert.equal(code, expected, "export output drifted from the golden — review the diff, then update the golden deliberately");
});

test("the generator emits only the known type-annotation forms", () => {
  const { code } = render();
  // A type annotation sits directly after a declared name (`const x: T`) or in a
  // function signature (`function f(a: T): R`). Anything matching that shape and
  // NOT on the allowlist would mean the strip fallback under-checks the parse
  // test below. A `:` inside a string (a URL) is deliberately not a match.
  const annotated = /^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:|^function\s+[A-Za-z_$][\w$]*\s*\([^)]*:|\)\s*:\s*[A-Za-z_$]/;
  const declared = code
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("//") && !l.startsWith("*") && annotated.test(l));
  for (const line of declared) {
    assert.ok(
      ANNOTATIONS.some(([ts]) => ts === line),
      `unlisted type annotation in generated output: ${line}\nadd it to ANNOTATIONS in this test`,
    );
  }
});

test("the emitted spec parses as an ES module (escaping is structurally sound)", () => {
  const { code } = render();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-export-"));
  try {
    const file = path.join(dir, "spec.mjs");
    fs.writeFileSync(file, toPlainJs(code));
    // Throws (non-zero exit) on any syntax error — a broken string literal from
    // an unescaped quote, newline or backslash shows up here.
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-export-"));
  try {
    const file = path.join(dir, "nasty.mjs");
    fs.writeFileSync(file, toPlainJs(code));
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // ...and the locators survive the round trip unchanged.
  for (const locator of nasty) assert.ok(code.includes(JSON.stringify(locator)), `locator lost: ${locator}`);
});

test("export is deterministic — same inputs, same bytes", () => {
  assert.equal(render().code, render().code);
});
