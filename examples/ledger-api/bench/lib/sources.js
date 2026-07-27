// Input adapters: everything the bench can score, reduced to the common trace
// form of `trace.js`.
//
//   1. A Playtest run directory      — `manifest.json` + `har.json`
//   2. A plain HAR file              — HAR 1.2 from any client
//   3. A Schemathesis HAR cassette   — `--cassette-path out.har --cassette-format har`
//
// A directory that is not itself a run directory is walked for nested run
// directories, so `bench.js runs/2026-07-25T0900-ab12` scores a whole suite.
//
// A trace may also carry the **structured suite report** its arm produced, which
// is the bench's second scoring column (DESIGN N10). It is picked up
// automatically from `suite-report.json` / `report.json` inside a run directory
// or `<name>.report.json` beside a HAR file, so an arm that writes one is scored
// on both columns and an arm that does not (the live probe) is scored on one.

import fs from "node:fs";
import path from "node:path";
import { traceFromHarEntries, wallMsFromExchanges } from "./trace.js";
import { findSuiteReport } from "./suite-report.js";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/**
 * Per-entry ids, where the recorder stamped them, so a report may cite an entry
 * by id instead of by wire position. Absent ids are null and citations fall back
 * to the index — HAR has no standard entry id, so this is a convention, not a
 * requirement.
 */
function entryIdsOf(entries) {
  const ids = entries.map(
    (entry) => entry?._playtest?.entry_id ?? entry?._entry_id ?? entry?._id ?? entry?.comment ?? null,
  );
  return ids.some((id) => typeof id === "string" && id) ? ids.map((id) => (typeof id === "string" ? id : null)) : null;
}

/** `label=path` or plain `path`. */
export function parseInputSpec(spec) {
  const match = /^([A-Za-z0-9._-]+)=(.+)$/.exec(spec);
  if (match) return { label: match[1], target: match[2] };
  return { label: null, target: spec };
}

function harEntriesOf(document, file) {
  const entries = document?.log?.entries;
  if (!Array.isArray(entries)) {
    if (Array.isArray(document?.interactions)) {
      throw new Error(
        `${file} looks like a VCR cassette. Re-run Schemathesis with --cassette-format har (the bench reads HAR cassettes).`,
      );
    }
    throw new Error(`${file} is not a HAR document: expected log.entries to be an array`);
  }
  return entries;
}

/** True when the HAR was produced by Schemathesis. */
export function isSchemathesisHar(document) {
  const creator = `${document?.log?.creator?.name ?? ""} ${document?.log?.creator?.comment ?? ""}`;
  return /schemathesis/i.test(creator);
}

/** Load a Playtest run directory. */
export function loadPlaytestRun(runDir, { label = null } = {}) {
  const harFile = path.join(runDir, "har.json");
  if (!fs.existsSync(harFile)) throw new Error(`${runDir} has no har.json`);
  const entries = harEntriesOf(readJson(harFile), harFile);

  let manifest = null;
  const manifestFile = path.join(runDir, "manifest.json");
  if (fs.existsSync(manifestFile)) manifest = readJson(manifestFile);

  const sidecar = path.join(runDir, "bench-meta.json");
  const meta = fs.existsSync(sidecar) ? readJson(sidecar) : {};

  const trace = traceFromHarEntries(entries, {
    // The run directory's own name: Playtest names it `<case>@<persona>`, and
    // it stays unique when a whole runs/ tree is scored at once.
    id: meta.id ?? path.basename(runDir),
    source: "playtest-run",
    label: label ?? meta.label ?? null,
    meta: {
      run_id: manifest?.run_id ?? null,
      case_id: manifest?.case?.id ?? null,
      arm: meta.arm ?? "playtest",
      steps: manifest?.totals?.executed_steps ?? manifest?.totals?.steps ?? meta.steps ?? null,
      wall_ms: manifest?.duration_ms ?? meta.wall_ms ?? null,
      cost_usd: manifest?.totals?.cost_usd ?? meta.cost_usd ?? null,
      entry_ids: entryIdsOf(entries),
      path: runDir,
    },
  });
  if (trace.meta.wall_ms === null) trace.meta.wall_ms = wallMsFromExchanges(trace.exchanges);
  trace.report = findSuiteReport(runDir);
  return trace;
}

/** Load a HAR file (plain or Schemathesis cassette). */
export function loadHarFile(file, { label = null, source = null } = {}) {
  const document = readJson(file);
  const entries = harEntriesOf(document, file);
  const sidecar = `${file.replace(/\.[^.]+$/, "")}.meta.json`;
  const meta = fs.existsSync(sidecar) ? readJson(sidecar) : {};
  const detected = source ?? (isSchemathesisHar(document) ? "schemathesis" : "har");

  const trace = traceFromHarEntries(entries, {
    id: meta.id ?? path.basename(file),
    source: detected,
    label: label ?? meta.label ?? null,
    meta: {
      arm: meta.arm ?? detected,
      steps: meta.steps ?? null,
      wall_ms: meta.wall_ms ?? null,
      cost_usd: meta.cost_usd ?? null,
      creator: document?.log?.creator?.name ?? null,
      entry_ids: entryIdsOf(entries),
      path: file,
    },
  });
  if (trace.meta.wall_ms === null) trace.meta.wall_ms = wallMsFromExchanges(trace.exchanges);
  trace.report = findSuiteReport(file);
  return trace;
}

/**
 * Load a Schemathesis HAR cassette explicitly. Identical to `loadHarFile`
 * except that the source tag is forced, for `schemathesis=<path>` inputs whose
 * creator block a future Schemathesis release might rename.
 */
export function loadSchemathesisCassette(file, options = {}) {
  return loadHarFile(file, { ...options, source: "schemathesis" });
}

const isRunDir = (dir) => fs.existsSync(path.join(dir, "har.json"));

/** Resolve one CLI input into zero or more traces. */
export function loadTraces(spec) {
  const { label, target } = parseInputSpec(spec);
  if (!fs.existsSync(target)) throw new Error(`no such path: ${target}`);
  const stat = fs.statSync(target);

  if (stat.isFile()) return [loadHarFile(target, { label })];

  if (isRunDir(target)) return [loadPlaytestRun(target, { label })];

  const traces = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isRunDir(child)) traces.push(loadPlaytestRun(child, { label }));
        else visit(child);
      } else if (entry.isFile() && /\.har$/.test(entry.name)) {
        traces.push(loadHarFile(child, { label }));
      }
    }
  };
  visit(target);
  if (traces.length === 0) throw new Error(`no run directories or .har files under ${target}`);
  return traces;
}
