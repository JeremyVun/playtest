// Run directories, step envelopes, baselines, action track, and diff.
// See docs/contracts/artifacts.md.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { DriverId, JsonValue, PersonaReference } from "./types.ts";

export interface StepAction {
  type?: string;
  ref?: string;
  url?: string;
  text?: string;
  value?: string;
  direction?: string;
  submit?: boolean;
  seconds?: number;
  summary?: string;
  reason?: string;
  method?: string;
  path?: string;
  [key: string]: unknown;
}

export interface StepEnvelope {
  step?: number;
  mode?: string;
  agent?: {
    action?: StepAction;
    thought?: string;
    visual?: string;
    [key: string]: unknown;
  };
  action?: StepAction;
  resolution?: { locator?: string; [key: string]: unknown };
  result?: {
    ok?: boolean;
    error?: unknown;
    url?: string;
    settle_ms?: number;
    [key: string]: unknown;
  };
  confusion?: {
    type?: string;
    note?: string;
    [key: string]: unknown;
  };
  raises?: Array<{
    kind?: string;
    note?: string;
    severity?: string;
    [key: string]: unknown;
  }>;
  network?: {
    requests?: Array<{
      status?: number;
      method?: string;
      path?: string;
      url?: string;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  console_errors?: Array<{
    type?: string;
    text?: string;
    [key: string]: unknown;
  }>;
  perf?: {
    nav?: { lcp_ms?: number; [key: string]: unknown };
    input_to_paint_ms?: number;
    [key: string]: unknown;
  };
  artifacts?: {
    a11y?: string;
    screenshot?: string;
    [key: string]: unknown;
  };
  axe?: {
    violations?: Array<{
      id: string;
      impact: string | null;
      nodes?: unknown[];
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface BaselinePaths {
  traj: string;
  meta: string;
  healedTraj: string;
  healedMeta: string;
}

interface LeakScan {
  findings: Array<Record<string, unknown>>;
  fingerprint: string;
}

interface BaselineManifest {
  run_id?: string;
  healed?: boolean;
  baseline?: { run_id?: string };
  pins?: Record<string, unknown>;
  case?: { story?: string; persona?: PersonaReference };
  env?: { base_url?: string | null };
  result?: {
    gate?: {
      checks?: Array<{ spec: string; pass: boolean; detail?: string }>;
    };
  };
}

type IndexedArray<T> = T[] & Record<number, T>;

export const HARNESS_VERSION = "0.1.0";
// 8: API steps may carry `bindings` (the producer step + JSON path each
// `{{name}}` substitution re-reads) and `expect` (the exact response status the
// step observed). Both are additive and optional — a baseline without them acts
// exactly as it did (docs/contracts/artifacts.md#compatibility-rules).
export const STEP_SCHEMA_VERSION = 8;
// v6: landmark roles (banner, main, navigation, complementary, contentinfo,
// search, form) are containers — no ref, prose only. Their v5 ref lines scooped
// up child labels (banner "… Close") and shifted every ref after them.
export const SNAPSHOT_FORMAT = "a11y-text-v6";
// Per-driver snapshot format pins, mirrored here so the record/act decision can
// run before any driver exists (the driver getters stay the live source at run
// time). A baseline records the format it was serialized under
// (meta.pins.snapshot_format); replaying it under a different format would
// drift on every page — the serializer changed, not the app — so it re-records
// instead (docs/contracts/artifacts.md#baseline-files).
export const SNAPSHOT_FORMATS = { web: SNAPSHOT_FORMAT, mobile: "ax-tree-v7", api: "api-text-v4" };
export function snapshotFormatFor(driver?: DriverId): string | null {
  return SNAPSHOT_FORMATS[driver ?? "web"] ?? null;
}
// The marker line that makes a persisted api response projection
// self-identifying (docs/contracts/artifacts.md#step-envelope). It lives here
// with the other artifact-format constants so a reader can recognize a
// projection without loading the api driver's module graph.
export const API_PROJECTION_MARKER = "Body shape (api-projection-v1):";
export const SETTLE = { name: "settle-v1", dom_quiet_ms: 500, net_quiet_ms: 500, max_ms: 10000 };

// The FIRST settle of a session (initial page/screen load) waits longer: under
// heavy parallel load an SPA's shell can load and go DOM+net quiet before its
// delayed first fetch/render fires, so a per-step-length window would snapshot a
// blank page and diff. The initial window is app.settle.initial_quiet_ms if set,
// else 2× the driver's per-step quiet window floored at 500ms; callers still cap
// it at max_ms. Behavior only — NOT baked into SETTLE, so pins.settle is unchanged
// unless the user sets the knob explicitly (drivers/web.ts, drivers/mobile.ts).
export const INITIAL_SETTLE_FLOOR_MS = 500;
export function initialQuietMs(base: number, override?: number | null): number {
  // Loose != so an absent knob (undefined — the default settle policies don't
  // carry initial_quiet_ms) falls through to the derived window; a strict !==
  // would return undefined and NaN the caller's Math.min, spinning the first
  // settle to max_ms on every session.
  return override != null ? override : Math.max(2 * base, INITIAL_SETTLE_FLOOR_MS);
}

// Default Hamming-distance threshold (over a 64-bit dHash) above which a
// visual_regression step's screenshot reads as pixel drift. Tuning knob
// (visual_regression_drift); web-only. Single home — config.ts + drivers/web.ts import it.
export const VISION_DRIFT_DEFAULT = 10;

// Base of manifest.pins; runner adds actor_model, grader_model, gateway.
export const PINS_BASE = {
  harness_version: HARNESS_VERSION,
  step_schema_version: STEP_SCHEMA_VERSION,
  snapshot_format: SNAPSHOT_FORMAT,
  settle: SETTLE,
};

/**
 * Fingerprint of the ACTOR's inputs (story + persona) — the only case fields a
 * recorded action track depends on. Stored in the baseline meta so a preflight
 * check can detect a story change and force a re-record
 * (docs/contracts/artifacts.md#baseline-files). Editing
 * `success`/`report` deliberately does NOT change this hash: those only re-grade
 * the existing recording. Persona is normalized (scalar/list) before hashing.
 */
export function storyHash(
  story: string | null | undefined,
  persona: PersonaReference | null | undefined
): string {
  return crypto.createHash("sha256").update(JSON.stringify([story ?? null, persona ?? null])).digest("hex").slice(0, 16);
}

/** UTC "2026-06-10T0300-ab12". */
export function newRunId(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const ts =
    `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  return `${ts}-${crypto.randomBytes(2).toString("hex")}`;
}

/**
 * A run id whose top-level dir doesn't already exist under `runsRoot`. The suffix
 * is only 4 hex (16 bits; docs/contracts/artifacts.md#run-directory), so two runs started in the same
 * UTC minute could collide — and RunWriter's mkdirSync(recursive)+appendFileSync
 * would then APPEND both runs into one trajectory.jsonl. Reroll until the dir is
 * free (no I/O in the common no-collision case; the suffix width is untouched).
 */
export function freshRunId(runsRoot: string, now = new Date()): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = newRunId(now);
    if (!fs.existsSync(path.join(runsRoot, id))) return id;
  }
  // Astronomically unlikely (100 collisions in one minute): fall back to a raw id
  // rather than loop forever.
  return newRunId(now);
}

export class RunWriter {
  constructor(runsRoot: string, runId: string, caseId: string) {
    this.#dir = path.resolve(runsRoot, runId, caseId);
    fs.mkdirSync(path.join(this.#dir, "steps"), { recursive: true });
  }
  #dir: string;

  get dir() {
    return this.#dir;
  }

  appendEnvelope(envelope: StepEnvelope): void {
    fs.appendFileSync(path.join(this.#dir, "trajectory.jsonl"), JSON.stringify(envelope) + "\n");
  }

  /** One line per actor turn: the exact message window sent to the model, for
   *  diagnostics (docs/contracts/artifacts.md#diagnostic-and-progress-logs).
   *  Images are elided to a reference by the caller. */
  appendContext(entry: JsonValue): void {
    fs.appendFileSync(path.join(this.#dir, "context.jsonl"), JSON.stringify(entry) + "\n");
  }

  /** One line per runCase progress event ({ ts, type, caseId, ... }) — the same
   *  stream `onEvent` sees (docs/contracts/artifacts.md#diagnostic-and-progress-logs),
   *  persisted so a finished run carries its own progress record. */
  appendEvent(event: Record<string, unknown>): void {
    fs.appendFileSync(path.join(this.#dir, "events.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
  }

  writeManifest(manifest: Record<string, unknown>): void {
    fs.writeFileSync(path.join(this.#dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  }

  copyBaseline(srcJsonlPath: string): void {
    fs.copyFileSync(srcJsonlPath, path.join(this.#dir, "baseline.jsonl"));
  }

  /**
   * Replace the final non-empty line of trajectory.jsonl with `envelope`. Used
   * to annotate the already-written terminal envelope (e.g. with custom-assertion
   * outcome evidence) without appending a synthetic step — the rewritten line
   * rides into the committed baseline like any other (acceptBaseline copies the
   * whole file). Caller passes the same envelope object it mutated in memory.
   */
  rewriteLast(envelope: StepEnvelope): void {
    const file = path.join(this.#dir, "trajectory.jsonl");
    const lines: IndexedArray<string> = fs.readFileSync(file, "utf8").split("\n");
    let last = lines.length - 1;
    while (last >= 0 && !lines[last]!.trim()) last--; // SAFETY: last >= 0 and last starts at length - 1 prove the indexed line exists
    if (last < 0) return; // nothing written yet
    lines[last] = JSON.stringify(envelope);
    // Re-add the trailing newline appendEnvelope writes after every line, so the
    // rewritten file is byte-shaped exactly like an append-only one.
    fs.writeFileSync(file, lines.slice(0, last + 1).join("\n") + "\n");
  }
}

/** @returns {object[]} envelopes */
export function readTrajectory(jsonlPath: string): StepEnvelope[] {
  return fs
    .readFileSync(jsonlPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** The step's action, whether agent-decided (`agent.action`) or acted (`action`). */
export function actionOf<T extends StepAction = StepAction>(envelope: StepEnvelope): T | null {
  return (envelope.agent?.action ?? envelope.action ?? null) as T | null; // SAFETY: callers may refine a validated driver action
}

/** First line of an error's message — the shared error-formatting helper. */
export function firstLine(e: unknown): string {
  const value = e !== null && typeof e === "object" && "message" in e
    ? e.message
    : e;
  const [line = ""] = String(value).split("\n");
  return line;
}

/** The actable projection: executed steps with resolved locators. Computed, never stored. */
export function actionTrack(envelopes: StepEnvelope[]): StepEnvelope[] {
  return envelopes.filter((e) => {
    const type = actionOf(e)?.type;
    if (type === "done" || type === "give_up") return false;
    return Boolean(e.resolution) && Boolean(e.result?.ok);
  });
}

/**
 * The action-track step signature diffTracks compares on: type, locator/url, the
 * typed text or selected value, and the scroll/swipe direction — so a changed
 * option or direction diffs as a changed step instead of collapsing to "same".
 * The viewer keeps a byte-equivalent inline copy (src/run-viewer/web/app.js signature());
 * the two must not drift
 * (docs/contracts/artifacts.md#trajectory-projections).
 */
function stepSignature(env: StepEnvelope): string {
  const a = actionOf(env);
  return (a?.type ?? "?") + "|" + (env.resolution?.locator ?? a?.url ?? "") + "|" + (a?.text ?? a?.value ?? "") + "|" + (a?.direction ?? "");
}

/**
 * LCS diff of two action tracks (see actionTrack) on stepSignature. Consumed by
 * the hosted review queue's diff summary; the viewer renders its own equivalent
 * diff client-side. See docs/contracts/artifacts.md#trajectory-projections.
 * @returns {{ ops: {op: "same"|"del"|"add", a: object|null, b: object|null}[],
 *             summary: { same: number, del: number, add: number } }}
 */
export function diffTracks(
  baselineTrack: StepEnvelope[],
  newTrack: StepEnvelope[]
): {
  ops: Array<{
    op: "same" | "del" | "add";
    a: StepEnvelope | null;
    b: StepEnvelope | null
  }>;
  summary: { same: number; del: number; add: number };
} {
  const A: IndexedArray<StepEnvelope> = baselineTrack as IndexedArray<StepEnvelope>, B: IndexedArray<StepEnvelope> = newTrack as IndexedArray<StepEnvelope>; // SAFETY: the indexed view records bounds guaranteed by the LCS loops
  const sigA: IndexedArray<string> = A.map(stepSignature), sigB: IndexedArray<string> = B.map(stepSignature);
  const n = A.length, m = B.length;
  const L: IndexedArray<IndexedArray<number>> = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0)) as IndexedArray<IndexedArray<number>>; // SAFETY: the matrix dimensions cover every index used by the bounded LCS loops
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i]![j] = sigA[i] === sigB[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!); // SAFETY: the matrix and signature indices are bounded by n and m
  const ops: Array<{
    op: "same" | "del" | "add";
    a: StepEnvelope | null;
    b: StepEnvelope | null
  }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (sigA[i] === sigB[j]) ops.push({ op: "same", a: A[i++]!, b: B[j++]! }); // SAFETY: the loop condition bounds both track indices
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) ops.push({ op: "del", a: A[i++]!, b: null }); // SAFETY: the loop condition and matrix dimensions bound these indices
    else ops.push({ op: "add", a: null, b: B[j++]! }); // SAFETY: the loop condition bounds the new-track index
  }
  while (i < n) ops.push({ op: "del", a: A[i++]!, b: null }); // SAFETY: i < n proves the baseline-track element exists
  while (j < m) ops.push({ op: "add", a: null, b: B[j++]! }); // SAFETY: j < m proves the new-track element exists
  const summary = { same: 0, del: 0, add: 0 };
  for (const o of ops) summary[o.op]++;
  return { ops, summary };
}

/**
 * Is this baseline replayable in act mode? True when it either carries at least
 * one actable step OR ends in a terminal done/give_up — i.e. a COMPLETE recorded
 * journey. A journey the actor finished in a single done()/give_up() has an EMPTY
 * action track (actionTrack excludes terminal steps), yet it IS a real baseline:
 * actLoop's track-done tail re-acts the terminal step and re-runs the gate, so it
 * must replay rather than re-record every run. Only a truly empty file, or one
 * holding just non-terminal non-actable markers (e.g. an unhealed drift marker),
 * is unreplayable → re-record. See docs/contracts/engine.md#act-and-heal.
 */
export function isReplayableBaseline(envelopes: StepEnvelope[]): boolean {
  if (actionTrack(envelopes).length > 0) return true;
  return envelopes.some((e) => {
    const type = actionOf(e)?.type;
    return type === "done" || type === "give_up";
  });
}


/**
 * Suite root for a case file: the nearest ancestor holding a playtest.yaml
 * (stopping at the repo root), else the case's own directory. Mirrors the
 * defaults walk in config.ts/env.js so baselines anchor to the same dir the
 * suite's defaults do. Shared with env.js (defaultsFileFor) and assertion
 * discovery (assertions.ts) — the one canonical suite-root walk.
 */
export function suiteRootFor(caseFile: string): string {
  const start = path.dirname(path.resolve(caseFile));
  for (let dir = start; ; ) {
    if (fs.existsSync(path.join(dir, "playtest.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (fs.existsSync(path.join(dir, ".git")) || parent === dir) return start;
    dir = parent;
  }
}

/**
 * Where a case's committed baseline/healed artifacts live: under the suite's
 * `results/` directory, mirroring the case's path within the suite. A `stories/`
 * grouping directory is structural (see config.ts id derivation) and is dropped,
 * so `<suite>/stories/foo.yaml` → `<suite>/results/foo.baseline.jsonl`. Only the
 * first (leftmost) `stories/` is dropped — matching the id derivation — so a
 * deeper `stories/stories/` keeps its inner segment and doesn't collide.
 */
export function baselinePaths(caseFile: string): BaselinePaths {
  const suiteRoot = suiteRootFor(caseFile);
  const rel = path.relative(suiteRoot, path.resolve(caseFile)).replace(/\.yaml$/, "");
  const segs = rel.split(path.sep);
  const first = segs.indexOf("stories");
  const parts = first === -1 ? segs : segs.slice(0, first).concat(segs.slice(first + 1));
  const base = path.join(suiteRoot, "results", ...parts);
  return {
    traj: `${base}.baseline.jsonl`,
    meta: `${base}.baseline.json`,
    healedTraj: `${base}.healed.jsonl`,
    healedMeta: `${base}.healed.json`,
  };
}

/** @returns {{ envelopes: object[], meta: object|null } | null} */
export function readBaseline(
  caseFile: string
): { envelopes: StepEnvelope[]; meta: Record<string, unknown> | null } | null {
  const p = baselinePaths(caseFile);
  if (!fs.existsSync(p.traj)) return null;
  const meta = fs.existsSync(p.meta) ? JSON.parse(fs.readFileSync(p.meta, "utf8")) : null;
  return { envelopes: readTrajectory(p.traj), meta };
}

/**
 * Copy the run's trajectory into the suite's results/ dir; healed runs — and
 * runs the acceptance leak scan flagged — become pending review candidates
 * (docs/contracts/interfaces.md#baseline-review-and-grading).
 * @param {{ healed?: boolean, scan?: { findings: object[], fingerprint: string }|null, approved?: boolean }} opts
 *   `scan` records what the leak scan saw; `approved` marks an explicit human
 *   acceptance, which stores the fingerprint of exactly the bytes approved.
 */
export function acceptBaseline(
  caseFile: string,
  runDir: string,
  {
    healed = false,
    scan = null,
    approved = false
  }: { healed?: boolean; scan?: LeakScan | null; approved?: boolean } = {}
): Record<string, unknown> {
  const manifest: BaselineManifest = JSON.parse(
    fs.readFileSync(path.join(runDir, "manifest.json"), "utf8")
  );
  const meta = {
    accepted_at: new Date().toISOString(),
    run_id: manifest.run_id,
    run_dir: path.resolve(runDir),
    // Provenance survives `playtest baseline accept <healRunDir>` too: a heal run's
    // manifest records which baseline it healed from even when accepted directly.
    healed_from_run_id: healed || manifest.healed ? (manifest.baseline?.run_id ?? null) : null,
    pins: manifest.pins,
    // Fingerprint the actor inputs so the next run can detect a changed story
    // and re-record instead of silently replaying a stale action track.
    story_hash: storyHash(manifest.case?.story, manifest.case?.persona),
    // Recording-time base_url, so the next run's base-aware drift check
    // (docs/contracts/engine.md#act-and-heal) can
    // subtract THIS baseline's OWN base before comparing — a deployment path
    // prefix difference (e.g. running the same journey under t2's
    // `/retail/netbank`) then reads as env, not drift. Absent on a legacy
    // baseline => that run falls back to origin-only stripping. Null for drivers
    // with no base_url (mobile).
    base_url: manifest.env?.base_url ?? null,
    // Verdicts of the gate checks, keyed by spec ("kind: value"), so a CLEAN ACT
    // A clean act replay (docs/contracts/engine.md#act-and-heal) can reuse an
    // inheritable check's prior verdict (assert / opted-in
    // custom assertion) instead of re-running it — killing the LLM re-call and its
    // run-to-run nondeterminism (gate.js isInheritable decides which kinds reuse).
    // Only the verdict is stored (severity/kind are recomputed live each run). Kept
    // here so the .baseline.json/.jsonl pair stays a self-contained, transportable
    // unit. Absent => legacy baseline; the next clean replay runs live and re-saves.
    verdicts: (manifest.result?.gate?.checks ?? []).map((c) => ({ spec: c.spec, pass: c.pass, detail: c.detail })),
    // What the acceptance leak scan found, when it found anything. On a pending
    // candidate this is the reason it is pending; an explicit accept turns it
    // into scan_approved, fingerprinting exactly the bytes the human approved.
    ...(scan?.findings?.length && !approved ? { scan: { findings: scan.findings } } : {}),
    ...(approved && scan?.fingerprint && scan.findings?.length
      ? { scan_approved: { fingerprint: scan.fingerprint, at: new Date().toISOString(), findings: scan.findings.length } }
      : {}),
    ...(healed ? { candidate: true } : {}),
  };
  const p = baselinePaths(caseFile);
  fs.mkdirSync(path.dirname(p.traj), { recursive: true }); // <suite>/results/ may not exist yet
  fs.copyFileSync(path.join(runDir, "trajectory.jsonl"), healed ? p.healedTraj : p.traj);
  fs.writeFileSync(healed ? p.healedMeta : p.meta, JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

/** Dismiss a pending healed candidate; run artifacts are untouched. Throws if no candidate. */
export function rejectHealed(caseFile: string): void {
  const p = baselinePaths(caseFile);
  if (!fs.existsSync(p.healedTraj) && !fs.existsSync(p.healedMeta)) {
    throw new Error(`no healed candidate to reject for ${caseFile}`);
  }
  fs.rmSync(p.healedTraj, { force: true });
  fs.rmSync(p.healedMeta, { force: true });
}

/**
 * Pending candidate → baseline; removes the candidate files. Throws if none.
 * `scan` (from the explicit-accept path) turns the candidate's recorded leak-scan
 * findings into a fingerprinted approval covering exactly the promoted bytes.
 */
export function promoteHealed(
  caseFile: string,
  { scan = null }: { scan?: LeakScan | null } = {}
): Record<string, unknown> {
  const p = baselinePaths(caseFile);
  if (!fs.existsSync(p.healedTraj)) {
    throw new Error(`no healed candidate to promote for ${caseFile}`);
  }
  // Both sidecars are written together; a present .jsonl with a missing .json is a
  // partial/tampered candidate. Promoting an empty {} would silently drop the
  // baseline's story_hash/base_url/verdicts (forcing a full re-record next run), so
  // treat it as a broken candidate rather than promote provenance-less meta.
  if (!fs.existsSync(p.healedMeta)) {
    throw new Error(`healed candidate for ${caseFile} is missing its metadata sidecar — re-heal before accepting`);
  }
  const meta = JSON.parse(fs.readFileSync(p.healedMeta, "utf8"));
  delete meta.candidate;
  const findings = scan?.findings ?? meta.scan?.findings ?? [];
  delete meta.scan;
  if (scan?.fingerprint && findings.length) {
    meta.scan_approved = { fingerprint: scan.fingerprint, at: new Date().toISOString(), findings: findings.length };
  }
  fs.copyFileSync(p.healedTraj, p.traj);
  fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2) + "\n");
  fs.rmSync(p.healedTraj);
  fs.rmSync(p.healedMeta, { force: true });
  return meta;
}
