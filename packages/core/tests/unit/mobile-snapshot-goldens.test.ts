// Golden-file pin for the mobile page-source projections.
//
// `parsePageSource` (the agent-facing `[eN]` text + element list) and
// `nativePageSourceTree` (the debug tree the viewer diffs against it) used to run
// one regex walk EACH over the same XML; they now share one `walkPageSource()`.
// That refactor is only safe if both projections stay byte-identical, and the
// text is a pinned format (`ax-tree-v7`, mirrored in trajectory.ts) plus the
// drift-comparison surface — so this compares whole files, not shapes.
//
// The goldens under tests/fixtures/mobile-page-source/goldens were generated from
// the PRE-refactor implementation (`git show HEAD:…/mobile-snapshot.ts`) against
// this corpus, so a diff here means the refactor changed observable output.
//
// Regenerating a golden is a FORMAT CHANGE: it moves `SNAPSHOT_FORMAT` in
// mobile-snapshot.ts and the mirrored literal in trajectory.ts, and invalidates
// every committed mobile baseline. Do it deliberately, never to make a test pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { parsePageSource, nativePageSourceTree, walkPageSource } from "../../src/drivers/mobile-snapshot.ts";

const DIR = path.join(import.meta.dirname, "../fixtures/mobile-page-source");
const IPHONE = { w: 390, h: 844 };

// Each case pins one source + screen size. Between them the corpus exercises
// wrapper cells, run collapse, the element cap, the invisible-but-on-screen
// rescue, scrolled-out rows, disabled controls, entity decoding, duplicate and
// quote-carrying accessibility ids, the name cap, adjacent-text dedupe on the
// native side, and a truncated/mismatched document.
const CORPUS: Array<{ name: string; file: string; screen: { w: number; h: number } | null }> = [
  { name: "ios-todos", file: "ios-todos.xml", screen: IPHONE },
  { name: "ios-virtualized-list", file: "ios-virtualized-list.xml", screen: IPHONE },
  { name: "ios-virtualized-list.no-screen", file: "ios-virtualized-list.xml", screen: null },
  { name: "ios-truncated-list", file: "ios-truncated-list.xml", screen: IPHONE },
  { name: "ios-edge-cases", file: "ios-edge-cases.xml", screen: IPHONE },
  { name: "android-uiautomator2", file: "android-uiautomator2.xml", screen: { w: 1080, h: 2400 } },
  { name: "malformed", file: "malformed.xml", screen: null },
];

const golden = (name: string, kind: string): string => fs.readFileSync(path.join(DIR, "goldens", `${name}.${kind}`), "utf8");

for (const { name, file, screen } of CORPUS) {
  test(`mobile page source golden: ${name}`, () => {
    const xml = fs.readFileSync(path.join(DIR, file), "utf8");
    const snap = parsePageSource(xml, { screen });
    assert.equal(snap.text + "\n", golden(name, "agent.txt"), `agent-facing snapshot text drifted for ${file}`);
    assert.equal(JSON.stringify(snap.elements, null, 2) + "\n", golden(name, "elements.json"), `element list (refs/locators/bboxes) drifted for ${file}`);
    assert.equal((nativePageSourceTree(xml) ?? "<null>") + "\n", golden(name, "native.txt"), `debug native tree drifted for ${file}`);
  });

  // The point of the refactor: one walk, two projections, same bytes as two walks.
  test(`mobile page source shared walk is identical to walking twice: ${name}`, () => {
    const xml = fs.readFileSync(path.join(DIR, file), "utf8");
    const walk = walkPageSource(xml);
    assert.equal(parsePageSource("", { screen, walk }).text + "\n", golden(name, "agent.txt"));
    assert.equal((nativePageSourceTree("", walk) ?? "<null>") + "\n", golden(name, "native.txt"));
    // The walk is not consumed by either projection: order is irrelevant and a
    // reused walk (settle → capture) renders the same twice.
    assert.equal(parsePageSource("", { screen, walk }).text + "\n", golden(name, "agent.txt"));
    assert.equal((nativePageSourceTree("", walk) ?? "<null>") + "\n", golden(name, "native.txt"));
  });
}
