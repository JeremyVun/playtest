// The baseline-acceptance leak scan
// (docs/contracts/interfaces.md#baseline-review-and-grading).
//
// A committed baseline is source code: it lives in the repository forever and is
// read by everyone who clones it. Before a run becomes one, its trajectory is
// scanned for values that must not be committed. A CLEAN scan auto-accepts
// exactly as before (a passing first record included). A scan WITH FINDINGS
// blocks automatic acceptance and leaves a pending candidate that only an
// explicit `playtest baseline accept <runDir>` approves; that approval records a
// content-hash fingerprint of what was scanned, so any later change to the
// trajectory invalidates it and the next acceptance is gated again.
//
// Rules:
//
//   secret     a value core injected from a secret reference appears literally.
//              Every driver — this is the backstop behind write-time redaction.
//   redaction  a declared redact.request/redact.projection field still carries a
//              literal instead of its placeholder. Every driver.
//   entropy    a credential-shaped token (long, mixed-case, digits, or JWT-shaped).
//   data       an email address — application data, not a registered secret.
//
// The entropy and data rules are scoped to API request templates and response
// projections. Web and mobile trajectories are full of hashes, locators, and
// user-visible text; a general rule there would start blocking acceptance across
// suites that have nothing to do with this feature.
import { sha256Hex } from "./hash.ts";
import fs from "node:fs";
import path from "node:path";

import { isSecretRef, knownSecretValues, registerSecretsFromEnv } from "./secrets.ts";
import { actionOf, baselinePaths, readTrajectory, API_PROJECTION_MARKER } from "./trajectory.ts";
import type { StepEnvelope } from "./trajectory.ts";
import type { ResolvedRedact } from "./types.ts";

interface LocatedString {
  at: string;
  value: string;
}

export interface ScanFinding {
  rule: string;
  step: number | null;
  field: string;
  detail: string;
}

interface ScanOptions {
  redact?: ResolvedRedact | null;
  driver?: string;
}

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Candidate credential shape: long enough to be a token, in the character set
// tokens use. UUIDs (lowercase + digits) and ULIDs (uppercase + digits) do not
// clear the mixed-case + digit test below, so ordinary resource ids stay quiet.
export const TOKEN_RE = /[A-Za-z0-9_\-.=+/]{24,}/g;
const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$/;
const MIN_TOKEN_ENTROPY = 3.5;

/** Shannon entropy in bits per character. Pure; exported for test. */
export function entropyBitsPerChar(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Is this string credential-shaped? Pure; exported for test. */
export function looksLikeCredential(s: unknown): boolean {
  if (typeof s !== "string" || s.length < 24) return false;
  if (JWT_RE.test(s)) return true;
  const mixed = /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
  return mixed && entropyBitsPerChar(s) >= MIN_TOKEN_ENTROPY;
}

/** Every string reachable in a value, with a dotted field path. */
function strings(value: unknown, at: string, out: LocatedString[] = []): LocatedString[] {
  if (typeof value === "string") out.push({ at, value });
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${i}]`, out));
  else if (value && typeof value === "object" && !isSecretRef(value)) {
    for (const [k, v] of Object.entries(value)) strings(v, at ? `${at}.${k}` : k, out);
  }
  return out;
}

/** Object KEYS reachable in a value, with a dotted field path (a map keyed by
 *  email leaks through a values-free projection). */
function keys(value: unknown, at: string, out: LocatedString[] = []): LocatedString[] {
  if (Array.isArray(value)) value.forEach((v, i) => keys(v, `${at}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push({ at: at ? `${at}.${k}` : k, value: k });
      keys(v, at ? `${at}.${k}` : k, out);
    }
  }
  return out;
}

/** The shape block of a projected api snapshot, parsed, or null. */
export function projectionShape(snapshotText: unknown): unknown {
  if (typeof snapshotText !== "string") return null;
  const i = snapshotText.indexOf(API_PROJECTION_MARKER);
  if (i === -1) return null;
  const block = snapshotText.slice(i + API_PROJECTION_MARKER.length).trim();
  try {
    return JSON.parse(block);
  } catch {
    return null; // "(no body)" / "(non-json body: N chars)" carry no structure
  }
}

function pathHead(p: string): "headers" | "body" {
  return /^headers\b/.test(String(p)) ? "headers" : "body";
}

/**
 * Does the value at a redact path still hold a literal? Walks the same `a.b[*].c`
 * syntax the driver templates with; a path the request does not carry is inert.
 */
function literalAt(node: unknown, segments: string[]): string | null {
  if (!segments.length) {
    if (isSecretRef(node)) return null;
    if (node === undefined || node === null) return null;
    return typeof node === "object" ? JSON.stringify(node) : String(node);
  }
  const [head = "", ...tail] = segments;
  if (head === "[*]") {
    if (!Array.isArray(node)) return null;
    for (const v of node) {
      const hit = literalAt(v, tail);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  if (!Object.prototype.hasOwnProperty.call(node, head)) return null;
  return literalAt((node as Record<string, unknown>)[head], tail);
}

function segmentsOf(p: unknown, strip: string): string[] {
  let s = String(p ?? "").trim();
  if (s.startsWith("$")) s = s.slice(1);
  if (s.startsWith(".")) s = s.slice(1);
  if (strip && (s === strip || s.startsWith(`${strip}.`) || s.startsWith(`${strip}[`))) s = s.slice(strip.length).replace(/^\./, "");
  const out: string[] = [];
  for (const raw of s.split(".")) {
    if (!raw) continue;
    const m = raw.match(/^([^[\]]*)((?:\[\*\])*)$/);
    if (!m) {
      out.push(raw);
      continue;
    }
    const [, name = "", wildcards = ""] = m;
    if (name) out.push(name);
    for (const _ of wildcards.match(/\[\*\]/g) ?? []) out.push("[*]");
  }
  return out;
}

const truncate = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Scan accepted-trajectory envelopes for values that must not be committed.
 * @param {object[]} envelopes
 * @param {{ redact?: object|null, driver?: string }} opts
 * @returns {{ rule: string, step: number|null, field: string, detail: string }[]}
 */
export function scanEnvelopes(envelopes: StepEnvelope[], { redact = null, driver = "web" }: ScanOptions = {}): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const add = (rule: string, step: number | null | undefined, field: string, detail: string) =>
    findings.push({ rule, step: step ?? null, field, detail });
  const secrets = knownSecretValues();
  const api = driver === "api";

  for (const envelope of envelopes ?? []) {
    const step = envelope?.step ?? null;

    // 1. Known secret values, anywhere in the envelope. Every driver.
    if (secrets.length) {
      const line = JSON.stringify(envelope);
      for (const [value, name] of secrets) {
        if (line.includes(value) || line.includes(JSON.stringify(value).slice(1, -1))) {
          add("secret", step, "(envelope)", `the value of secret "${name}" appears literally — it must persist as { $secret: ${name} }`);
        }
      }
    }

    const action = actionOf(envelope);
    const isRequest = action?.type === "request";

    // 2. Redaction-list fields still carrying literals. Every driver.
    for (const entry of redact?.request ?? []) {
      if (!isRequest) continue;
      const root = pathHead(entry.path);
      const node = action[root];
      if (node === undefined || node === null) continue;
      const segs = segmentsOf(entry.path, root);
      if (typeof node === "string" && segs.length) continue; // opaque string body
      const literal = literalAt(node, segs);
      if (literal !== null) {
        add("redaction", step, entry.path, `declared redacted but committed as the literal ${JSON.stringify(truncate(literal))}`);
      }
    }
    for (const entry of redact?.projection ?? []) {
      const shape = projectionShape(envelope?.snapshot_text);
      if (!shape) continue;
      const literal = literalAt(shape, segmentsOf(entry, ""));
      if (literal !== null && literal !== '"[redacted]"' && literal !== "[redacted]") {
        add("redaction", step, entry, "declared redacted but still present in the response projection");
      }
    }

    if (!api) continue;

    // 3 + 4. Credential-shaped tokens and application data, in the api request
    // template and the response projection only.
    const surfaces: LocatedString[] = [];
    if (isRequest) {
      surfaces.push(...strings(action.headers, "headers"), ...strings(action.body, "body"));
    }
    const shape = projectionShape(envelope?.snapshot_text);
    if (shape !== null) surfaces.push(...keys(shape, "projection"));

    for (const { at, value } of surfaces) {
      for (const token of value.match(TOKEN_RE) ?? []) {
        if (looksLikeCredential(token)) {
          add("entropy", step, at, `credential-shaped token ${JSON.stringify(truncate(token, 12))} — inject it as a secret reference instead`);
          break;
        }
      }
      for (const email of value.match(EMAIL_RE) ?? []) {
        add("data", step, at, `email address ${JSON.stringify(email)} — application data in a committed artifact`);
        break;
      }
    }
  }
  return findings;
}

/** sha256 of exactly the bytes that were scanned. */
export function fingerprint(text: string): string {
  return sha256Hex(text);
}

/**
 * Scan a run directory's trajectory ahead of acceptance. `secretNames` lets a
 * process that did not run the case (a later `playtest baseline accept`) rebuild
 * the known-secret registry from its own environment, best effort.
 * @returns {{ findings: object[], fingerprint: string }}
 */
export function scanRun(
  runDir: string,
  {
    redact = null,
    driver = "web",
    secretNames = null
  }: ScanOptions & { secretNames?: string[] | null } = {}
): { findings: ScanFinding[]; fingerprint: string } {
  if (secretNames?.length) registerSecretsFromEnv(secretNames);
  const file = path.join(path.resolve(runDir), "trajectory.jsonl");
  const text = fs.readFileSync(file, "utf8");
  return { findings: scanEnvelopes(readTrajectory(file), { redact, driver }), fingerprint: fingerprint(text) };
}

/**
 * The fingerprint a human already approved for this case, or null. An approval
 * covers exactly the bytes it was given: a re-record that changes the trajectory
 * produces a different fingerprint and is gated again.
 */
export function approvedFingerprint(caseFile: string): string | null {
  for (const metaPath of [baselinePaths(caseFile).meta, baselinePaths(caseFile).healedMeta]) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (typeof meta?.scan_approved?.fingerprint === "string") return meta.scan_approved.fingerprint;
    } catch {}
  }
  return null;
}

/** One human-readable line per finding, for the CLI and the run warning. */
export function describeFindings(findings: ScanFinding[] | null | undefined): string[] {
  return (findings ?? []).map((f) => `  ${f.rule}: step ${f.step ?? "?"} ${f.field} — ${f.detail}`);
}
