import type { DynamicValue } from "./types.ts";

// The script artifact's approval lifecycle (DESIGN N9,
// docs/contracts/scripts.md#approval-lifecycle).
//
// Not a permission framework — the platform's third instance of one pattern it
// already runs twice (healed baselines held for review, findings review): a
// content fingerprint, a state, and a record of who decided. Everything here is
// pure: a version is a row of data, and the only questions it answers are "is
// this exact content licensed to run?" and "what changed since the last thing
// somebody said yes to?".
//
// The load-bearing rule is that approval covers *content*, never a version
// number. An edit — typed into the script page, applied by the assistant, or
// arriving as a proposed revision — produces new bytes, and new bytes have no
// approval. That is why `approve` refuses a fingerprint that is not the one on
// screen: a reviewer approves what they read.
import crypto from "node:crypto";

import { DummyConfigError } from "../config.ts";

/** The lifecycle's own shape version, carried in persisted approval records. */
export const SCRIPT_LIFECYCLE_VERSION = 1;

/** The three states a script version is ever in. */
export const SCRIPT_VERSION_STATES: DynamicValue = Object.freeze(["pending", "approved", "rejected"]);

/** Why a version became pending. `edit` covers both a person and the assistant. */
export const SCRIPT_VERSION_ORIGINS: DynamicValue = Object.freeze(["authored", "edit", "revision"]);

/** sha256 of exactly these bytes — the fingerprint an approval covers. */
export const scriptFingerprint = (text: DynamicValue) => crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");

const shortFingerprint = (value: DynamicValue) => String(value ?? "").slice(0, 12);

/**
 * Build a version record from script text.
 *
 * A version is always born `pending`: authoring produces content for review,
 * and so does every edit. Nothing in this module can mint an approved version —
 * `approveScriptVersion` is the only door, and it needs a human's name.
 *
 * @param {{ source: string, number?: number, origin?: string, authored_by?: string,
 *           created_at?: string, note?: string, parent?: number|null }} input
 */
export function scriptVersion({ source, number = 1, origin = "authored", authored_by = null, created_at = null, note = null, parent = null }: DynamicValue = {}) {
  const text = String(source ?? "");
  if (!SCRIPT_VERSION_ORIGINS.includes(origin)) {
    throw new DummyConfigError(`script version: origin ${JSON.stringify(origin)} is not one of ${SCRIPT_VERSION_ORIGINS.join(", ")}`);
  }
  return {
    lifecycle_version: SCRIPT_LIFECYCLE_VERSION,
    number,
    parent,
    origin,
    state: "pending",
    fingerprint: scriptFingerprint(text),
    bytes: Buffer.byteLength(text, "utf8"),
    created_at: created_at ?? new Date().toISOString(),
    authored_by,
    note,
    approval: null,
  };
}

/**
 * Approve one version, against the fingerprint the reviewer had in front of them.
 *
 * @param {object} version the version record
 * @param {{ fingerprint: string, approver: string, review?: string|null, at?: string }} decision
 *   `fingerprint` is what the reviewer's page rendered. A mismatch means the
 *   content moved under them, and the approval is refused rather than retargeted.
 * @returns {object} a new version record — the input is not mutated
 */
export function approveScriptVersion(version: DynamicValue, { fingerprint, approver, review = null, at = null }: DynamicValue = {}) {
  return decideScriptVersion(version, { state: "approved", fingerprint, approver, review, at });
}

/** Reject one version. Same fingerprint discipline: a rejection is also a judgement of content. */
export function rejectScriptVersion(version: DynamicValue, { fingerprint, approver, review = null, at = null, reason = null }: DynamicValue = {}) {
  return decideScriptVersion(version, { state: "rejected", fingerprint, approver, review, at, reason });
}

function decideScriptVersion(version: DynamicValue, { state, fingerprint, approver, review, at, reason = null }: DynamicValue) {
  if (!version || typeof version !== "object") throw new DummyConfigError("script review: no version to decide on");
  const name = typeof approver === "string" ? approver.trim() : "";
  if (!name) throw new DummyConfigError("script review: an approval records who gave it — approver is required");
  if (typeof fingerprint !== "string" || !fingerprint) {
    throw new DummyConfigError(
      `script review: this decision carries no fingerprint. Approval covers exact content, so the review has to name the` +
        ` sha256 it read (${shortFingerprint(version.fingerprint)}…).`,
    );
  }
  if (fingerprint !== version.fingerprint) {
    throw new DummyConfigError(
      `script review: this version is now ${shortFingerprint(version.fingerprint)}… and the decision was made against` +
        ` ${shortFingerprint(fingerprint)}… — the script changed while it was being reviewed.\n` +
        "  Re-read the current source and decide again; an approval covers the exact bytes somebody read.",
    );
  }
  return {
    ...version,
    state,
    approval: {
      lifecycle_version: SCRIPT_LIFECYCLE_VERSION,
      state,
      fingerprint: version.fingerprint,
      approver: name,
      at: at ?? new Date().toISOString(),
      review: review ? String(review) : null,
      ...(reason ? { reason: String(reason) } : {}),
    },
  };
}

/**
 * Apply an edit — typed, assistant-applied, or a proposed revision — to a version.
 * The result is always pending, whatever the input was (DESIGN N9).
 */
export function editScriptVersion(version: DynamicValue, { source, origin = "edit", authored_by = null, note = null, at = null }: DynamicValue = {}) {
  const next = scriptVersion({
    source,
    number: (version?.number ?? 0) + 1,
    parent: version?.number ?? null,
    origin,
    authored_by,
    created_at: at,
    note,
  });
  return next;
}

/**
 * Is this exact content licensed to run against a target?
 *
 * The one question dispatch asks. It is deliberately answered from the version
 * alone: a caller cannot pass a flag that makes an unapproved script runnable.
 *
 * @returns {{ ok: boolean, reason: string|null, detail: string|null }}
 */
export function scriptDispatchLicense(version: DynamicValue) {
  if (!version || typeof version !== "object") return { ok: false, reason: "no_version", detail: "this suite has no script yet" };
  if (version.state === "rejected") {
    return { ok: false, reason: "rejected", detail: `version ${version.number} was rejected${version.approval?.approver ? ` by ${version.approval.approver}` : ""}` };
  }
  if (version.state !== "approved" || !version.approval) {
    return { ok: false, reason: "pending", detail: `version ${version.number} is awaiting review` };
  }
  if (version.approval.fingerprint !== version.fingerprint) {
    return {
      ok: false,
      reason: "invalidated",
      detail:
        `version ${version.number} was approved as ${shortFingerprint(version.approval.fingerprint)}… and is now` +
        ` ${shortFingerprint(version.fingerprint)}…`,
    };
  }
  return { ok: true, reason: null, detail: null };
}

/**
 * The dispatch guard. Throws the actionable configuration error rather than
 * returning a boolean, because every caller's only correct response is to stop.
 */
export function assertScriptDispatchable(version: DynamicValue, { where = "script replay" }: DynamicValue = {}) {
  const license = scriptDispatchLicense(version);
  if (license.ok) return version.approval;
  throw new DummyConfigError(
    `${where}: this script is not approved to run — ${license.detail}.\n` +
      "  A script executes against a target only under a fingerprinted approval of that exact content.\n" +
      "  Open the script page, read the current source, and approve it there.",
  );
}

// ---- diff -------------------------------------------------------------------

const lines = (text: DynamicValue) => String(text ?? "").split("\n");

/**
 * A line diff, so the script page can show what changed since the last approval.
 * Plain LCS — no dependency, and the same shape the review surfaces already
 * render (`{ op, a, b }` triples grouped into hunks).
 *
 * @returns {{ added: number, removed: number, ops: {op: "same"|"add"|"del", a: number|null,
 *             b: number|null, text: string}[], hunks: object[][] }}
 */
export function diffScriptText(before: DynamicValue, after: DynamicValue, { context = 3 }: DynamicValue = {}) {
  const a = lines(before);
  const b = lines(after);
  // LCS table. Scripts are small (a few hundred lines); O(n·m) is honest here.
  const table: DynamicValue = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: DynamicValue = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) ops.push({ op: "same", a: i + 1, b: j + 1, text: a[i++] }), j++;
    else if (table[i + 1][j] >= table[i][j + 1]) ops.push({ op: "del", a: i + 1, b: null, text: a[i++] });
    else ops.push({ op: "add", a: null, b: j + 1, text: b[j++] });
  }
  while (i < a.length) ops.push({ op: "del", a: i + 1, b: null, text: a[i++] });
  while (j < b.length) ops.push({ op: "add", a: null, b: j + 1, text: b[j++] });

  const changed = ops.map((op: DynamicValue) => op.op !== "same");
  const keep = ops.map((_: DynamicValue, index: DynamicValue) => changed.slice(Math.max(0, index - context), index + context + 1).some(Boolean));
  const hunks: DynamicValue = [];
  let current: DynamicValue = null;
  for (let index = 0; index < ops.length; index += 1) {
    if (!keep[index]) {
      current = null;
      continue;
    }
    if (!current) hunks.push((current = []));
    current.push(ops[index]);
  }
  return {
    added: ops.filter((op: DynamicValue) => op.op === "add").length,
    removed: ops.filter((op: DynamicValue) => op.op === "del").length,
    ops,
    hunks,
  };
}

/** One line for a terminal or a page header: "3 added, 1 removed since v2". */
export function describeScriptDiff(diff: DynamicValue, { since = null }: DynamicValue = {}) {
  if (!diff || (!diff.added && !diff.removed)) return since ? `identical to ${since}` : "no change";
  const parts: DynamicValue = [];
  if (diff.added) parts.push(`${diff.added} line${diff.added === 1 ? "" : "s"} added`);
  if (diff.removed) parts.push(`${diff.removed} line${diff.removed === 1 ? "" : "s"} removed`);
  return `${parts.join(", ")}${since ? ` since ${since}` : ""}`;
}
