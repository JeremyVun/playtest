import test from "node:test";
import assert from "node:assert/strict";
import {
  GENERATED_FINDING_TITLE_MAX,
  normalizeFindingTitle,
} from "../../src/public/findings.ts";

test("finding titles stay on one line and shorten at a word boundary", () => {
  const title = normalizeFindingTitle(
    "Checkout confirmation repeats the full delivery address and payment explanation after the order has already completed successfully",
    { maxLength: GENERATED_FINDING_TITLE_MAX },
  );
  assert.ok([...title].length <= GENERATED_FINDING_TITLE_MAX);
  assert.equal(title.endsWith("successfully"), false);
  assert.match(title, /…$/);
  assert.doesNotMatch(title, /explan…$/);
  assert.equal(normalizeFindingTitle("  Cart total stays stale  \nextra evidence"), "Cart total stays stale");
});

test("finding title fallback and unbroken Unicode input are safe", () => {
  assert.equal(normalizeFindingTitle(null, { fallback: "Run failure" }), "Run failure");
  const title = normalizeFindingTitle("🧪".repeat(150), { maxLength: GENERATED_FINDING_TITLE_MAX });
  assert.equal([...title].length, GENERATED_FINDING_TITLE_MAX);
  assert.match(title, /…$/);
});
