// Run directories, step envelopes, baselines, action track, diff. See docs/CONTRACTS.md §1, §3.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const HARNESS_VERSION = "0.1.0";
export const STEP_SCHEMA_VERSION = 3;
export const SNAPSHOT_FORMAT = "a11y-text-v1";
export const PROMPTS_VERSION = "prompts-v2";
export const SETTLE = { name: "settle-v1", dom_quiet_ms: 500, net_quiet_ms: 500, max_ms: 10000 };

// Base of manifest.pins; runner adds actor_model, grader_model, gateway.
export const PINS_BASE = {
  harness_version: HARNESS_VERSION,
  prompts_version: PROMPTS_VERSION,
  step_schema_version: STEP_SCHEMA_VERSION,
  snapshot_format: SNAPSHOT_FORMAT,
  settle: SETTLE,
};

/** UTC "2026-06-10T0300-ab12". */
export function newRunId(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const ts =
    `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  return `${ts}-${crypto.randomBytes(2).toString("hex")}`;
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

  writeManifest(manifest) {
    fs.writeFileSync(path.join(this.#dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  }

  copyBaseline(srcJsonlPath) {
    fs.copyFileSync(srcJsonlPath, path.join(this.#dir, "baseline.jsonl"));
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

function stepSignature(envelope) {
  const a = actionOf(envelope) ?? {};
  return `${a.type}|${envelope.resolution?.locator ?? a.url ?? ""}|${a.text ?? ""}`;
}

/**
 * LCS diff of two action tracks.
 * @returns {{ ops: {op: "same"|"del"|"add", a: object|null, b: object|null}[],
 *             summary: { same: number, del: number, add: number } }}
 */
export function diffTracks(baselineTrack, newTrack) {
  const A = baselineTrack.map(stepSignature);
  const B = newTrack.map(stepSignature);
  const n = A.length;
  const m = B.length;
  // lcs[i][j] = LCS length of A[i..] and B[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) ops.push({ op: "same", a: baselineTrack[i++], b: newTrack[j++] });
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ op: "del", a: baselineTrack[i++], b: null });
    else ops.push({ op: "add", a: null, b: newTrack[j++] });
  }
  while (i < n) ops.push({ op: "del", a: baselineTrack[i++], b: null });
  while (j < m) ops.push({ op: "add", a: null, b: newTrack[j++] });

  const summary = { same: 0, del: 0, add: 0 };
  for (const o of ops) summary[o.op]++;
  return { ops, summary };
}

/**
 * Suite root for a case file: the nearest ancestor holding a playtest.yaml
 * (stopping at the repo root), else the case's own directory. Mirrors the
 * defaults walk in config.js/env.js so baselines anchor to the same dir the
 * suite's defaults do.
 */
function suiteRootFor(caseFile) {
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
 * so `<suite>/stories/foo.yaml` -> `<suite>/results/foo.baseline.jsonl`. Only the
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

/** Healed candidate -> baseline; removes the candidate files. Throws if no candidate. */
export function promoteHealed(caseFile) {
  const p = baselinePaths(caseFile);
  if (!fs.existsSync(p.healedTraj)) {
    throw new Error(`no healed candidate to promote for ${caseFile}`);
  }
  const meta = fs.existsSync(p.healedMeta) ? JSON.parse(fs.readFileSync(p.healedMeta, "utf8")) : {};
  delete meta.candidate;
  fs.copyFileSync(p.healedTraj, p.traj);
  fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2) + "\n");
  fs.rmSync(p.healedTraj);
  fs.rmSync(p.healedMeta, { force: true });
  return meta;
}
