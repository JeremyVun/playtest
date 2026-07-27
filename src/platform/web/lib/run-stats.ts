// What a person reads ABOUT a run: its per-story counts, how far it has got,
// the one word for its outcome, and its human name. The Runs index, the run
// dashboard and the replay page all say these things, and they must say them
// identically — a run that reads "1 failed" in the list and "done" on its own
// page is the failure-hiding this console forbids.
//
// Kept DOM-free so the hermetic gate can assert the words and the arithmetic
// without a browser (sibling of vocab.ts / nav.ts / finding-buckets.ts).

import { stamp } from "./labels.js";

const TERMINAL: WebDynamic = ["pass", "fail", "infra", "explored", "canceled", "lost"];
const NEVER_RAN: WebDynamic = ["infra", "canceled", "lost"];
const IN_FLIGHT: WebDynamic = ["running", "uploading"];

/** A story that reached an end, whatever that end was. */
export const isFinishedStatus = (s: WebDynamic) => TERMINAL.includes(s);
/** A story that produced no verdict — the amber family, never a product failure. */
export const neverRanStatus = (s: WebDynamic) => NEVER_RAN.includes(s);
export const inFlightStatus = (s: WebDynamic) => IN_FLIGHT.includes(s);

const ZERO: WebDynamic = {
  total: 0, queued: 0, running: 0, done: 0,
  pass: 0, fail: 0, infra: 0, explored: 0, canceled: 0, lost: 0, changed: 0,
  cost_usd: 0, duration_ms: null, started_at: null, finished_at: null,
};

/**
 * A run's per-story numbers, from whichever of the three shapes the caller has.
 *
 * `stats` is the server's grouped projection (the Runs index). A group fetched
 * on its own carries `runs`, the full story rows. An older payload carries only
 * `exit_summary.cases`. Preferring in that order means no surface renders blank
 * and none of them disagrees with another.
 */
export function runStats(group: WebDynamic) {
  if (!group) return { ...ZERO, source: "none" };
  if (group.stats && typeof group.stats === "object") {
    return { ...ZERO, ...group.stats, source: "stats" };
  }
  if (Array.isArray(group.runs)) return { ...fromRows(group.runs), source: "runs" };
  const cases = group.exit_summary?.cases;
  if (Array.isArray(cases)) return { ...fromRows(cases), source: "exit_summary" };
  return { ...ZERO, source: "none" };
}

/** Counts (and cost, and wall clock) from story rows of either shape. */
function fromRows(rows: WebDynamic) {
  const out: WebDynamic = { ...ZERO, total: rows.length };
  let started: WebDynamic = null, finished = null, unfinished = false, work = 0;
  for (const r of rows) {
    if (r.status === "queued") out.queued++;
    else if (inFlightStatus(r.status)) out.running++;
    else if (isFinishedStatus(r.status)) {
      out.done++;
      out[r.status]++;
    }
    if (r.changed || (r.healed && r.status === "pass")) out.changed++;
    // Group-view rows carry the manifest's `totals`; index rows carry the one
    // number off it that a list needs.
    out.cost_usd += Number(r.totals?.cost_usd ?? r.cost_usd ?? 0) || 0;
    work += Number(r.duration_ms) || 0;
    const s = r.started_at ? new Date(r.started_at).getTime() : null;
    const f = r.finished_at ? new Date(r.finished_at).getTime() : null;
    if (s != null && (started == null || s < started)) started = s;
    if (f != null && (finished == null || f > finished)) finished = f;
    if (!isFinishedStatus(r.status)) unfinished = true;
  }
  out.started_at = started == null ? null : new Date(started);
  // A duration only once nothing is still moving: while stories are in flight
  // the last one that HAPPENED to finish is not the run's duration.
  if (!unfinished && started != null) {
    if (finished != null) out.finished_at = new Date(finished);
    // The span the run occupied, or the work its stories did when the span is
    // shorter than that — row timestamps can be coarser than the work they
    // bound, and "0ms" for a run that did real work is a lie (mirrors the
    // server's own `stats.duration_ms`).
    const span = finished == null ? 0 : Math.max(0, finished - started);
    out.duration_ms = Math.max(span, work);
  }
  return out;
}

// Every status a story can end in, as the thing that happened to it. "infra"
// and "lost" are one fact to a person: no verdict came back.
const OUTCOME_WORD: WebDynamic = {
  fail: "failed",
  infra: "didn't run",
  lost: "didn't run",
  changed: "changed",
  pass: "passed",
  explored: "explored",
  canceled: "canceled",
};
// Failure first: it is the reason anybody opened this screen.
const OUTCOME_ORDER: WebDynamic = ["fail", "infra", "lost", "changed", "pass", "explored", "canceled"];

/**
 * The outcomes a run actually produced, in reading order — one entry per
 * non-zero count, carrying the chip tone, the number and the word. The caller
 * renders `✗1`; the word is what it puts beside it for anyone who cannot see
 * the glyph or its colour.
 *
 * `changed` re-describes passes that took a new path, so it is stated INSTEAD
 * of those passes, never in addition to them: "2 passed · 1 changed" on a
 * three-story run must not add up to four.
 */
export function outcomeParts(stats: WebDynamic) {
  const s: WebDynamic = { ...ZERO, ...stats };
  const counts: WebDynamic = { ...s, pass: Math.max(0, s.pass - s.changed) };
  return OUTCOME_ORDER
    .filter((k: WebDynamic) => counts[k] > 0)
    .map((k: WebDynamic) => ({ tone: k === "lost" ? "infra" : k, key: k, n: counts[k], word: OUTCOME_WORD[k] }));
}

/** "1 failed · 1 didn't run · 1 passed", or "" when nothing has an outcome. */
export function outcomeWords(stats: WebDynamic) {
  const parts = outcomeParts(stats);
  // Two statuses share the words "didn't run"; say the number once.
  const merged: WebDynamic = [];
  for (const p of parts) {
    const prior = merged.find((m: WebDynamic) => m.word === p.word);
    if (prior) prior.n += p.n;
    else merged.push({ ...p });
  }
  return merged.map((p: WebDynamic) => `${p.n} ${p.word}`).join(" · ");
}

/** How far a live run has got: "3 of 5 stories done". */
export function progressWords(stats: WebDynamic) {
  const s: WebDynamic = { ...ZERO, ...stats };
  if (!s.total) return "";
  if (s.done >= s.total) return "";
  return `${s.done} of ${s.total} ${s.total === 1 ? "story" : "stories"} done`;
}

/**
 * The single chip a whole run wears: its tone, and the words in it.
 *
 * A run still provisioning says so; a running one states its progress rather
 * than the bare word "running", which was the index's only report on a run in
 * flight; a finished one says what its stories did. A run holding a failure is
 * never a green "done".
 */
export function outcomeChip(group: WebDynamic, stats: WebDynamic = runStats(group)) {
  const status = group?.status;
  if (status === "queued") return { tone: "neutral", label: "provisioning" };
  if (status === "running") return { tone: "running", label: progressWords(stats) || "running" };
  if (status === "canceled") return { tone: "neutral", label: "canceled" };
  if (!stats.total) return { tone: "neutral", label: "done" };
  return { tone: outcomeTone(stats), label: outcomeWords(stats) || "done" };
}

/** The tone a finished run's worst outcome earns. */
export function outcomeTone(stats: WebDynamic) {
  const s: WebDynamic = { ...ZERO, ...stats };
  if (s.fail) return "fail";
  // lost = the runner never reported back. Infra-severity, never a green chip.
  if (s.infra || s.lost) return "infra";
  if (s.pass) return s.changed && s.changed >= s.pass ? "changed" : "pass";
  if (s.explored) return "explored";
  return "neutral";
}

/**
 * The one story a run consists of, when it has exactly one and that story has
 * finished. Such a run has no summary worth a screen of its own, so its name in
 * the index links straight to the replay instead of to a table with one row in
 * it. While the story is still moving the run's dashboard — narration, cancel —
 * is the useful destination, so this is null until it lands.
 */
export function soloStory(group: WebDynamic, stats: WebDynamic = runStats(group)) {
  const rows = group?.runs || [];
  if (stats.total !== 1 || rows.length !== 1) return null;
  return isFinishedStatus(rows[0].status) ? rows[0] : null;
}

/** True when a person has to look at this run: a failed check, or no verdict. */
export const needsAttention = (stats: WebDynamic) => {
  const s: WebDynamic = { ...ZERO, ...stats };
  return s.fail > 0 || s.infra > 0 || s.lost > 0;
};

/**
 * The tone of one pip in a suite's recent-runs trend. A run still in flight, or
 * cancelled, gets no tone — it is a gap in the trend, not a verdict in it.
 */
export function pipTone(group: WebDynamic, stats: WebDynamic = runStats(group)) {
  if (group?.status === "queued" || group?.status === "running" || group?.status === "canceled") return "";
  const tone = outcomeTone(stats);
  return ["pass", "fail", "infra", "explored", "changed"].includes(tone) ? tone : "";
}

// What started a run, in words. `manual` is a person in the console — worded
// "launched" rather than "manual" because in a testing product "manual run"
// reads as manual TESTING, which is the opposite of what happened. `api` is a
// project token; the other two arrive from automation.
const TRIGGER_WORD: WebDynamic = { manual: "launched run", schedule: "scheduled run", ci: "CI run", api: "API run" };
export const triggerWord = (kind: WebDynamic) => TRIGGER_WORD[kind] || kind || "run";

/**
 * A run's human name: the note whoever launched it wrote, else what kind of
 * trigger it was. Never its ULID — `short()` takes a ULID's leading characters,
 * which are the timestamp, so two runs minted in the same millisecond render
 * the same "id".
 */
export const runTitle = (group: WebDynamic) => group?.trigger?.note || triggerWord(group?.trigger?.kind);

/**
 * A run's name where it has one line and no tag beside it (the replay page's
 * "in <run>" breadcrumb). A written note wins, verbatim. Without one, the
 * trigger word alone names nothing — every launch wears the same word — so the
 * start stamp completes it: "launched · 10:31 pm", "scheduled · Thu 2:00 am".
 * The runs index says the same thing split across title and tag instead.
 */
export const runName = (group: WebDynamic) => group?.trigger?.note
  || (group?.created_at
    ? `${triggerWord(group?.trigger?.kind).replace(/ run$/, "")} · ${stamp(group.created_at)}`
    : triggerWord(group?.trigger?.kind));

/**
 * Which suites a page of runs belongs to, most recently run first, so the index
 * can section by suite. Sections are only worth drawing when there is more than
 * one; a project with a single suite gets a plain list.
 */
export function suiteOrder(groups: WebDynamic = []) {
  const seen: WebDynamic = [];
  for (const g of groups) if (!seen.includes(g.suite_id)) seen.push(g.suite_id);
  return seen;
}
