// The script approval lifecycle (DESIGN N9,
// docs/contracts/scripts.md#approval-lifecycle).
//
// The whole of the guarantee is that approval covers CONTENT: a version number
// is bookkeeping, and a fingerprint is the license. These cases pin the three
// sentences the exit gate asks for — an unapproved script cannot be dispatched,
// a one-byte change invalidates, and re-approval requires the current
// fingerprint — plus the diff the script page renders from.
import { test } from "node:test";
import assert from "node:assert/strict";

import { DummyConfigError } from "../../src/config.ts";
import {
  approveScriptVersion,
  assertScriptDispatchable,
  describeScriptDiff,
  diffScriptText,
  editScriptVersion,
  rejectScriptVersion,
  scriptDispatchLicense,
  scriptFingerprint,
  scriptVersion,
} from "../../src/public/api-suite-scripts.ts";

const SUITE = 'export default async function ({ client, check }) {\n  await client.get("/widgets");\n}\n';

test("a version is born pending, and nothing in the module can mint an approved one", () => {
  const version = scriptVersion({ source: SUITE, authored_by: "authoring job" });
  assert.equal(version.state, "pending");
  assert.equal(version.approval, null);
  assert.equal(version.fingerprint, scriptFingerprint(SUITE));
  assert.equal(version.origin, "authored");

  // The only door to `approved` needs a human's name.
  assert.throws(() => approveScriptVersion(version, { fingerprint: version.fingerprint }), DummyConfigError);
  assert.throws(() => approveScriptVersion(version, { fingerprint: version.fingerprint, approver: "  " }), /approver is required/);
});

test("an unapproved script cannot be dispatched, and the refusal says what to do", () => {
  const pending = scriptVersion({ source: SUITE });
  assert.deepEqual(scriptDispatchLicense(pending), { ok: false, reason: "pending", detail: "version 1 is awaiting review" });

  let thrown = null;
  try {
    assertScriptDispatchable(pending, { where: "script replay" });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof DummyConfigError);
  assert.match(thrown.message, /not approved to run/);
  assert.match(thrown.message, /fingerprinted approval of that exact content/);
  assert.doesNotMatch(thrown.message, /at Object\.|node:internal/);

  assert.equal(scriptDispatchLicense(null).reason, "no_version");
  const rejected = rejectScriptVersion(pending, { fingerprint: pending.fingerprint, approver: "ada" });
  assert.equal(scriptDispatchLicense(rejected).reason, "rejected");
  assert.throws(() => assertScriptDispatchable(rejected), /rejected by ada/);
});

test("a one-byte change invalidates the approval", () => {
  const approved = approveScriptVersion(scriptVersion({ source: SUITE }), {
    fingerprint: scriptFingerprint(SUITE),
    approver: "ada",
    review: "https://example.test/review/7",
  });
  assert.equal(approved.state, "approved");
  assert.equal(approved.approval.approver, "ada");
  assert.equal(approved.approval.review, "https://example.test/review/7");
  assert.ok(scriptDispatchLicense(approved).ok);
  assert.equal(assertScriptDispatchable(approved).fingerprint, approved.fingerprint);

  // One byte: a trailing space inside a string literal.
  const nudged = SUITE.replace("/widgets", "/widgets ");
  assert.equal(Buffer.byteLength(nudged) - Buffer.byteLength(SUITE), 1);

  // The classic way to get this wrong: keep the row, change the content.
  const tampered = { ...approved, fingerprint: scriptFingerprint(nudged) };
  const license = scriptDispatchLicense(tampered);
  assert.equal(license.ok, false);
  assert.equal(license.reason, "invalidated");
  assert.throws(() => assertScriptDispatchable(tampered), /was approved as [0-9a-f]{12}… and is now [0-9a-f]{12}…/);

  // The supported way: an edit produces a new, pending version.
  const edited = editScriptVersion(approved, { source: nudged, authored_by: "ada" });
  assert.equal(edited.state, "pending");
  assert.equal(edited.approval, null);
  assert.equal(edited.number, 2);
  assert.equal(edited.parent, 1);
  assert.equal(edited.origin, "edit");
  assert.equal(scriptDispatchLicense(edited).reason, "pending");
});

test("an assistant-applied edit and a proposed revision invalidate exactly as a typed one does", () => {
  const approved = approveScriptVersion(scriptVersion({ source: SUITE }), { fingerprint: scriptFingerprint(SUITE), approver: "ada" });
  for (const origin of ["edit", "revision"]) {
    const next = editScriptVersion(approved, { source: `${SUITE}// ${origin}\n`, origin });
    assert.equal(next.state, "pending", origin);
    assert.equal(next.origin, origin);
    assert.equal(scriptDispatchLicense(next).ok, false, origin);
  }
});

test("re-approval requires the fingerprint the reviewer actually read", () => {
  const first = SUITE;
  const second = `${SUITE}// a change somebody made mid-review\n`;
  const version = scriptVersion({ source: second });

  // A reviewer who read the previous content approves the previous fingerprint.
  assert.throws(
    () => approveScriptVersion(version, { fingerprint: scriptFingerprint(first), approver: "ada" }),
    /the script changed while it was being reviewed/,
  );
  // With no fingerprint at all, the refusal names the current one.
  assert.throws(() => approveScriptVersion(version, { approver: "ada" }), /carries no fingerprint/);

  const ok = approveScriptVersion(version, { fingerprint: scriptFingerprint(second), approver: "ada" });
  assert.ok(scriptDispatchLicense(ok).ok);
  // A rejection is a judgement of content too.
  assert.throws(() => rejectScriptVersion(version, { fingerprint: scriptFingerprint(first), approver: "ada" }), /changed while it was being reviewed/);
});

test("the diff since the last approval is a line diff with hunks and a one-line summary", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
  const after = ["a", "b", "c", "D", "e", "f", "g", "h"].join("\n");
  const diff = diffScriptText(before, after, { context: 1 });
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.hunks.length, 1);
  assert.deepEqual(
    diff.hunks[0].map((op: LegacyTestValue) => `${op.op} ${op.text}`),
    ["same c", "del d", "add D", "same e"],
  );
  assert.equal(describeScriptDiff(diff, { since: "v1" }), "1 line added, 1 line removed since v1");
  assert.equal(describeScriptDiff(diffScriptText(before, before), { since: "v1" }), "identical to v1");
});
