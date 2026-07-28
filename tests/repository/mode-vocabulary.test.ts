// Pins platform web's labels.ts as a byte-true mirror of core report.ts's
// mode vocabulary (UX principle 1: finished runs say recorded/checked/tried to
// heal/changed/explored; running rows say recording/checking/healing/exploring
// — see labels.js's own file header, "Duplicated here... per UX 'Visual tone'").
// Reads both files as TEXT and extracts the MODE_DOING/MODE_DID object literals
// so a change to either vocabulary that isn't mirrored in the other fails this
// test loudly, rather than drifting silently between the CLI and the web UI.
// No Postgres needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LABELS_JS = path.join(REPO_ROOT, "packages/platform/web/src/lib/labels.ts");
const REPORT_JS = path.join(REPO_ROOT, "packages/core/src/report.ts");
const VIEWER_APP = path.join(REPO_ROOT, "packages/run-viewer/src/web/app.ts");

/** Pull `const NAME[: Type] = { ... };` out of JS/TS source text and eval the
 * object literal (own-repo source, not user input — safe enough for a pin test). */
function extractConst(source: string, name: string): Record<string, string> {
  const re = new RegExp(`const ${name}(?:\\s*:[^=]+)?\\s*= (\\{[^;]*?\\});`, "s");
  const m = re.exec(source);
  assert.ok(m, `expected "const ${name}[: Type] = {...};" in the source`);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${m[1]});`)() as Record<string, string>;
}

test("MODE_DOING/MODE_DID: the web mirror is byte-true to core report.ts", () => {
  const labelsSrc = fs.readFileSync(LABELS_JS, "utf8");
  const reportSrc = fs.readFileSync(REPORT_JS, "utf8");

  const webDoing = extractConst(labelsSrc, "MODE_DOING");
  const coreDoing = extractConst(reportSrc, "MODE_DOING");
  assert.deepEqual(webDoing, coreDoing, "MODE_DOING must be identical between labels.js and report.ts");
  assert.deepEqual(Object.keys(webDoing).sort(), ["act", "explore", "heal", "record"]);

  const webDid = extractConst(labelsSrc, "MODE_DID");
  const coreDid = extractConst(reportSrc, "MODE_DID");
  assert.deepEqual(webDid, coreDid, "MODE_DID must be identical between labels.js and report.ts");
  assert.deepEqual(Object.keys(webDid).sort(), ["act", "explore", "heal", "record"]);
});

// The viewer's live pending row must know which stage words mean "the actor has
// stopped acting", so it never paints a phantom in-flight step during the gate
// or the grading tail. The viewer has no bundler, so it carries an inline copy
// of core's post-actor vocabulary — pinned here for the same reason as above.
test("PHASE_DOING: the viewer's live pending row mirrors core report.ts", () => {
  const corePhase = extractConst(fs.readFileSync(REPORT_JS, "utf8"), "PHASE_DOING");
  const appSrc = fs.readFileSync(VIEWER_APP, "utf8");
  const m = /const LIVE_PHASE_WORDS = new Set\((\[[^\]]*\])\)/.exec(appSrc);
  assert.ok(m, "expected LIVE_PHASE_WORDS = new Set([...]) in the viewer app");
  const viewerWords = new Function(`return (${m[1]});`)() as string[]; // SAFETY: own-repo source, not user input
  assert.deepEqual([...viewerWords].sort(), Object.values(corePhase).sort(),
    "LIVE_PHASE_WORDS must carry exactly core's post-actor stage words");
  assert.deepEqual(Object.keys(corePhase).sort(), ["finishing", "gate", "grading", "observing", "setup"]);
});
