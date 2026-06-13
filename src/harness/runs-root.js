// Shared runs-root discovery and latest-run selection. Used by `playtest
// view`; future commands that take an optional run path should resolve
// through here too.
import fs from "node:fs";
import path from "node:path";
import { DummyConfigError } from "./config.js";
import { findManifests } from "./view-server.js";

// Bound on the ancestor walk so a bare `playtest view` in /tmp never scans
// huge parent trees; the .git root also ends the walk (checked, then stop).
const MAX_WALK = 10;

/**
 * Resolution order: explicit arg > ./runs > nearest ancestor with a runs/ dir.
 * @param {string|null} [explicit] flag/positional value; validated, never walked
 * @returns {string} absolute runs root (or run dir, when explicit names one)
 */
export function findRunsRoot(explicit = null, from = process.cwd()) {
  if (explicit) {
    const abs = path.resolve(explicit);
    // A missing path is tolerated — `playtest view` serves it as an empty picker
    // rather than crashing (a runs root that doesn't exist yet just has no runs;
    // and the compose self-test mounts the repo read-only, so it can't be created).
    // A path that exists but is a *file* is still a real error.
    if (fs.existsSync(abs) && !isDir(abs)) throw new DummyConfigError(`not a directory: ${explicit}`);
    return abs;
  }
  for (let dir = from, depth = 0; depth < MAX_WALK; depth++) {
    const candidate = path.join(dir, "runs");
    if (isDir(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (fs.existsSync(path.join(dir, ".git")) || parent === dir) break;
    dir = parent;
  }
  throw new DummyConfigError(
    "no runs directory found here. Run some tests first (playtest [paths...]), or name a run or runs root:\n" +
      "  playtest view runs/\n" +
      "  playtest view runs/2026-06-10T1325-cd37/todos/add-todo\n" +
      "  playtest view --runs-root <dir>",
  );
}

/**
 * Pre-run trend scan: every run under the
 * root, grouped by case id, sorted by manifest.started_at ascending. One scan
 * serves a whole runAll — there is no persistent index; runs/ is the history.
 * Score comes from the sibling grade.json (null when ungraded). Unparseable
 * manifests and ones without case id / started_at are skipped.
 * @returns {Map<string, {run_id: string|null, started_at: string, status: string|null,
 *   mode: string|null, healed: boolean, duration_ms: number|null, steps: number|null,
 *   score: number|null, pins: object|null}[]>}
 */
export function scanHistory(root) {
  const byCase = new Map();
  for (const dir of findManifests(path.resolve(root))) {
    const m = readJson(path.join(dir, "manifest.json"));
    if (typeof m?.case?.id !== "string" || typeof m.started_at !== "string") continue;
    if (!byCase.has(m.case.id)) byCase.set(m.case.id, []);
    byCase.get(m.case.id).push({
      run_id: m.run_id ?? null,
      started_at: m.started_at,
      status: m.result?.status ?? null,
      mode: m.mode ?? null,
      healed: m.healed ?? false,
      duration_ms: m.duration_ms ?? null,
      steps: m.totals?.steps ?? null,
      score: readJson(path.join(dir, "grade.json"))?.score ?? null,
      pins: m.pins ?? null, // the comparability key (shared/movement.js)
    });
  }
  for (const list of byCase.values()) list.sort((a, b) => a.started_at.localeCompare(b.started_at));
  return byCase;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Newest run under a root by manifest.started_at — directory-name order alone
 * lies across machines. Manifests without started_at are ignored.
 * @returns {{ dir: string, manifest: object }|null}
 */
export function latestRun(root, caseId = null) {
  let best = null;
  for (const dir of findManifests(root)) {
    const manifest = readJson(path.join(dir, "manifest.json"));
    if (typeof manifest?.started_at !== "string") continue;
    if (caseId && manifest.case?.id !== caseId) continue;
    if (!best || manifest.started_at > best.manifest.started_at) best = { dir, manifest };
  }
  return best;
}

function isDir(abs) {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}
