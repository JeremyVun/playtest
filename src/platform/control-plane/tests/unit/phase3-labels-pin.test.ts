// Pins src/platform/web/lib/labels.js as a byte-true mirror of core src/core/report.ts's
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

import { chipStatus } from "../../../web/lib/labels.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const LABELS_JS = path.join(REPO_ROOT, "src/platform/web/lib/labels.js");
const REPORT_JS = path.join(REPO_ROOT, "src/core/report.ts");

/** Pull `const NAME[: Type] = { ... };` out of JS/TS source text and eval the
 * object literal (own-repo source, not user input — safe enough for a pin test). */
function extractConst(source: HostedDynamic, name: HostedDynamic) {
  const re = new RegExp(`const ${name}(?:\\s*:[^=]+)?\\s*= (\\{[^;]*?\\});`, "s");
  const m = re.exec(source);
  assert.ok(m, `expected "const ${name}[: Type] = {...};" in the source`);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${m[1]});`)();
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

test("chipStatus: a healed pass reads as 'changed', never plain 'pass'", () => {
  assert.equal(chipStatus({ healed: true, status: "pass" }), "changed");
  assert.equal(chipStatus({ healed: false, status: "pass" }), "pass");
  assert.equal(chipStatus({ healed: true, status: "fail" }), "fail", "a healed FAIL is not a changed journey");
  assert.equal(chipStatus({ healed: false, status: "running" }), "running");
  assert.equal(chipStatus({ healed: false, status: "queued" }), "running");
  assert.equal(chipStatus({ healed: false, status: "uploading" }), "running");
  assert.equal(chipStatus({ healed: false, status: "canceled" }), "infra");
  assert.equal(chipStatus({ healed: false, status: "lost" }), "infra");
});
