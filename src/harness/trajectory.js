// Run directories, step envelopes, baselines, action track, diff. See docs/CONTRACTS.md §1, §3.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const HARNESS_VERSION = "0.1.0";
export const STEP_SCHEMA_VERSION = 6;
export const SNAPSHOT_FORMAT = "a11y-text-v5";
export const PROMPTS_VERSION = "prompts-v7";
export const SETTLE = { name: "settle-v1", dom_quiet_ms: 500, net_quiet_ms: 500, max_ms: 10000 };

// The FIRST settle of a session (initial page/screen load) waits longer: under
// heavy parallel load an SPA's shell can load and go DOM+net quiet before its
// delayed first fetch/render fires, so a per-step-length window would snapshot a
// blank page and diff. The initial window is app.settle.initial_quiet_ms if set,
// else 2× the driver's per-step quiet window floored at 500ms; callers still cap
// it at max_ms. Behavior only — NOT baked into SETTLE, so pins.settle is unchanged
// unless the user sets the knob explicitly (drivers/web.js, drivers/mobile.js).
export const INITIAL_SETTLE_FLOOR_MS = 500;
export function initialQuietMs(base, override) {
  return override !== null ? override : Math.max(2 * base, INITIAL_SETTLE_FLOOR_MS);
}

// Default Hamming-distance threshold (over a 64-bit dHash) above which a
// visual_regression step's screenshot reads as pixel drift. Tuning knob
// (visual_regression_drift); web-only. Single home — config.js + drivers/web.js import it.
export const VISION_DRIFT_DEFAULT = 10;

// Base of manifest.pins; runner adds actor_model, grader_model, gateway.
export const PINS_BASE = {
  harness_version: HARNESS_VERSION,
  prompts_version: PROMPTS_VERSION,
  step_schema_version: STEP_SCHEMA_VERSION,
  snapshot_format: SNAPSHOT_FORMAT,
  settle: SETTLE,
};

/**
 * Fingerprint of the ACTOR's inputs (story + persona) — the only case fields a
 * recorded action track depends on. Stored in the baseline meta so a preflight
 * check can detect a story change and force a re-record (runner.js §10). Editing
 * `success`/`report` deliberately does NOT change this hash: those only re-grade
 * the existing recording. Persona is normalized (scalar/list) before hashing.
 */
export function storyHash(story, persona) {
  return crypto.createHash("sha256").update(JSON.stringify([story ?? null, persona ?? null])).digest("hex").slice(0, 16);
}

/** UTC "2026-06-10T0300-ab12". */
export function newRunId(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const ts =
    `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  return `${ts}-${crypto.randomBytes(2).toString("hex")}`;
}

/**
 * A run id whose top-level dir doesn't already exist under `runsRoot`. The suffix
 * is only 4 hex (16 bits, pinned by CONTRACTS §1), so two runs started in the same
 * UTC minute could collide — and RunWriter's mkdirSync(recursive)+appendFileSync
 * would then APPEND both runs into one trajectory.jsonl. Reroll until the dir is
 * free (no I/O in the common no-collision case; the suffix width is untouched).
 */
export function freshRunId(runsRoot, now = new Date()) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = newRunId(now);
    if (!fs.existsSync(path.join(runsRoot, id))) return id;
  }
  // Astronomically unlikely (100 collisions in one minute): fall back to a raw id
  // rather than loop forever.
  return newRunId(now);
}

export class RunWriter {
  constructor(runsRoot, runId, caseId) {
    this.#dir = path.resolve(runsRoot, runId, caseId);
    fs.mkdirSync(path.join(this.#dir, "steps"), { recursive: true });
  }
  #dir;

  get dir() {
    return this.#dir;
  }

  appendEnvelope(envelope) {
    fs.appendFileSync(path.join(this.#dir, "trajectory.jsonl"), JSON.stringify(envelope) + "\n");
  }

  /** One line per actor turn: the exact message window sent to the model, for
   *  diagnostics (CONTRACTS §3). Images are elided to a reference by the caller. */
  appendContext(entry) {
    fs.appendFileSync(path.join(this.#dir, "context.jsonl"), JSON.stringify(entry) + "\n");
  }

  writeManifest(manifest) {
    fs.writeFileSync(path.join(this.#dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  }

  copyBaseline(srcJsonlPath) {
    fs.copyFileSync(srcJsonlPath, path.join(this.#dir, "baseline.jsonl"));
  }

  /**
   * Replace the final non-empty line of trajectory.jsonl with `envelope`. Used
   * to annotate the already-written terminal envelope (e.g. with custom-assertion
   * outcome evidence) without appending a synthetic step — the rewritten line
   * rides into the committed baseline like any other (acceptBaseline copies the
   * whole file). Caller passes the same envelope object it mutated in memory.
   */
  rewriteLast(envelope) {
    const file = path.join(this.#dir, "trajectory.jsonl");
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let last = lines.length - 1;
    while (last >= 0 && !lines[last].trim()) last--;
    if (last < 0) return; // nothing written yet
    lines[last] = JSON.stringify(envelope);
    // Re-add the trailing newline appendEnvelope writes after every line, so the
    // rewritten file is byte-shaped exactly like an append-only one.
    fs.writeFileSync(file, lines.slice(0, last + 1).join("\n") + "\n");
  }
}

/** @returns {object[]} envelopes */
export function readTrajectory(jsonlPath) {
  return fs
    .readFileSync(jsonlPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** The step's action, whether agent-decided (`agent.action`) or acted (`action`). */
export function actionOf(envelope) {
  return envelope.agent?.action ?? envelope.action ?? null;
}

/** First line of an error's message — the shared error-formatting helper. */
export function firstLine(e) {
  return String(e?.message ?? e).split("\n")[0];
}

/** The actable projection: executed steps with resolved locators. Computed, never stored. */
export function actionTrack(envelopes) {
  return envelopes.filter((e) => {
    const type = actionOf(e)?.type;
    if (type === "done" || type === "give_up") return false;
    return Boolean(e.resolution) && Boolean(e.result?.ok);
  });
}

/**
 * Is this baseline replayable in act mode? True when it either carries at least
 * one actable step OR ends in a terminal done/give_up — i.e. a COMPLETE recorded
 * journey. A journey the actor finished in a single done()/give_up() has an EMPTY
 * action track (actionTrack excludes terminal steps), yet it IS a real baseline:
 * actLoop's track-done tail re-acts the terminal step and re-runs the gate, so it
 * must replay rather than re-record every run. Only a truly empty file, or one
 * holding just non-terminal non-actable markers (e.g. an unhealed drift marker),
 * is unreplayable → re-record. See docs/CONTRACTS.md §10.
 */
export function isReplayableBaseline(envelopes) {
  if (actionTrack(envelopes).length > 0) return true;
  return envelopes.some((e) => {
    const type = actionOf(e)?.type;
    return type === "done" || type === "give_up";
  });
}


/**
 * Suite root for a case file: the nearest ancestor holding a playtest.yaml
 * (stopping at the repo root), else the case's own directory. Mirrors the
 * defaults walk in config.js/env.js so baselines anchor to the same dir the
 * suite's defaults do. Shared with env.js (defaultsFileFor) and assertion
 * discovery (assertions.js) — the one canonical suite-root walk.
 */
export function suiteRootFor(caseFile) {
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
 * grouping directory is structural (see config.js id derivation) and is dropped,
 * so `<suite>/stories/foo.yaml` → `<suite>/results/foo.baseline.jsonl`. Only the
 * first (leftmost) `stories/` is dropped — matching the id derivation — so a
 * deeper `stories/stories/` keeps its inner segment and doesn't collide.
 */
export function baselinePaths(caseFile) {
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
export function readBaseline(caseFile) {
  const p = baselinePaths(caseFile);
  if (!fs.existsSync(p.traj)) return null;
  const meta = fs.existsSync(p.meta) ? JSON.parse(fs.readFileSync(p.meta, "utf8")) : null;
  return { envelopes: readTrajectory(p.traj), meta };
}

/** Copy the run's trajectory into the suite's results/ dir; healed runs become review candidates. */
export function acceptBaseline(caseFile, runDir, { healed = false } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  const meta = {
    accepted_at: new Date().toISOString(),
    run_id: manifest.run_id,
    run_dir: path.resolve(runDir),
    // Provenance survives `playtest accept <healRunDir>` too: a heal run's
    // manifest records which baseline it healed from even when accepted directly.
    healed_from_run_id: healed || manifest.healed ? (manifest.baseline?.run_id ?? null) : null,
    pins: manifest.pins,
    // Fingerprint the actor inputs so the next run can detect a changed story
    // and re-record instead of silently replaying a stale action track.
    story_hash: storyHash(manifest.case?.story, manifest.case?.persona),
    // Recording-time base_url, so the next run's base-aware drift check (§10) can
    // subtract THIS baseline's OWN base before comparing — a deployment path
    // prefix difference (e.g. running the same journey under t2's
    // `/retail/netbank`) then reads as env, not drift. Absent on a legacy
    // baseline => that run falls back to origin-only stripping. Null for drivers
    // with no base_url (mobile).
    base_url: manifest.env?.base_url ?? null,
    // Verdicts of the gate checks, keyed by spec ("kind: value"), so a CLEAN ACT
    // REPLAY (§10) can reuse an inheritable check's prior verdict (assert / opted-in
    // custom assertion) instead of re-running it — killing the LLM re-call and its
    // run-to-run nondeterminism (gate.js isInheritable decides which kinds reuse).
    // Only the verdict is stored (severity/kind are recomputed live each run). Kept
    // here so the .baseline.json/.jsonl pair stays a self-contained, transportable
    // unit. Absent => legacy baseline; the next clean replay runs live and re-saves.
    verdicts: (manifest.result?.gate?.checks ?? []).map((c) => ({ spec: c.spec, pass: c.pass, detail: c.detail })),
    ...(healed ? { candidate: true } : {}),
  };
  const p = baselinePaths(caseFile);
  fs.mkdirSync(path.dirname(p.traj), { recursive: true }); // <suite>/results/ may not exist yet
  fs.copyFileSync(path.join(runDir, "trajectory.jsonl"), healed ? p.healedTraj : p.traj);
  fs.writeFileSync(healed ? p.healedMeta : p.meta, JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

/** Dismiss a pending healed candidate; run artifacts are untouched. Throws if no candidate. */
export function rejectHealed(caseFile) {
  const p = baselinePaths(caseFile);
  if (!fs.existsSync(p.healedTraj) && !fs.existsSync(p.healedMeta)) {
    throw new Error(`no healed candidate to reject for ${caseFile}`);
  }
  fs.rmSync(p.healedTraj, { force: true });
  fs.rmSync(p.healedMeta, { force: true });
}

/** Healed candidate → baseline; removes the candidate files. Throws if no candidate. */
export function promoteHealed(caseFile) {
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
  fs.copyFileSync(p.healedTraj, p.traj);
  fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2) + "\n");
  fs.rmSync(p.healedTraj);
  fs.rmSync(p.healedMeta, { force: true });
  return meta;
}
