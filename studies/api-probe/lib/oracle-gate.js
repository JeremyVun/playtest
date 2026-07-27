// The bridge between Playtest's custom-assertion contract and the ledger
// fixture's deterministic oracles (docs/contracts/engine.md,
// docs/backlog/api-testing/DESIGN.md §4).
//
// Every `assertions/<name>/assertion.js` in this suite is three lines of
// declaration over `oracleAssertion()`. All the real work is here so that the
// six invariants are checked by ONE code path, and that path is the vendored
// bench oracle — not a second implementation that could drift from the scoring
// the study reports (see ../vendor/PROVENANCE.md).
//
// Shape of the work:
//   gather(ctx)  reads har.json from ctx.runDir, normalizes it into the bench's
//                trace form, and runs the whole oracle suite once per run
//                (memoized across the six assertion modules), then keeps only
//                the slice this assertion owns.
//   verdict()    turns that slice into { pass, detail }. No I/O, no model, no
//                clock — the same evidence always yields the same verdict.
//
// There is deliberately no network in gather(): the gate observes the run, it
// never adds traffic to it (DESIGN §5.2). Everything the invariants need must
// be in the trace the actor produced, which is exactly what the persona is
// asked to make sure of.
import fs from "node:fs";
import path from "node:path";
import { traceFromHarEntries } from "../vendor/trace.js";
import { scoreTrace } from "../vendor/oracles.js";

/** Keep the envelope small: evidence rides into trajectory.jsonl and baselines. */
const MAX_VIOLATIONS = 3;
const MAX_SUPPORTING = 3;
const MAX_MESSAGE = 300;

// One scoreTrace() per run directory, shared by the six assertion modules that
// import this file (the harness calls gather() once per used assertion). Keyed
// by runDir so a long-lived process — the hosted runner-agent runs many cases —
// never serves one run's evidence to another. Bounded, oldest-out.
const MAX_CACHE = 8;
const scored = new Map();

function readHarEntries(runDir) {
  const file = path.join(runDir, "har.json");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    // No har.json at all means the actor issued no request (the api driver
    // writes the file on its first one). That is a real, gradeable outcome —
    // "nothing was exercised" — not an infrastructure failure.
    if (e.code === "ENOENT") return [];
    throw e;
  }
  // A present-but-unreadable har.json IS infrastructure: the evidence is
  // untrustworthy, so the harness should fail the run rather than let a verdict
  // be computed from a fragment (a gather throw is an infra error, exit 2).
  const document = JSON.parse(text);
  const entries = document?.log?.entries;
  if (!Array.isArray(entries)) throw new Error(`${file} has no log.entries array`);
  return entries;
}

/**
 * How many requests the trajectory says were made, from the per-step
 * `artifacts.har_entries` indices the runner records.
 *
 * The runner now forces a HAR flush before the observing phase. This comparison
 * remains a defensive evidence-integrity check for synthetic, legacy, or
 * otherwise incomplete traces: it prevents an absent suffix from becoming a
 * false NOT_EXERCISED verdict.
 */
function recordedRequestCount(trajectory) {
  let highest = -1;
  for (const envelope of trajectory ?? []) {
    for (const index of envelope?.artifacts?.har_entries ?? []) {
      if (Number.isInteger(index) && index > highest) highest = index;
    }
  }
  return highest + 1;
}

function compact(violation) {
  return {
    code: violation.code,
    message: String(violation.message ?? "").slice(0, MAX_MESSAGE),
    at: violation.evidence?.request ?? null,
    supporting: (violation.evidence?.supporting ?? []).slice(0, MAX_SUPPORTING),
    subject: violation.evidence?.subject ?? {},
  };
}

/** Score the run once and cache it. Pure apart from the har.json read. */
function scoreRun(ctx) {
  const runDir = ctx.runDir;
  const hit = scored.get(runDir);
  if (hit) return hit;

  const entries = readHarEntries(runDir);
  const expected = recordedRequestCount(ctx.trajectory);
  const trace = traceFromHarEntries(entries, {
    id: path.basename(runDir),
    source: "playtest-run",
    meta: { run_id: ctx.runId ?? null },
  });
  const result = scoreTrace(trace);

  const value = {
    requests: entries.length,
    // `expected` can legitimately be 0 on a trajectory that recorded no HAR
    // indices at all; only a positive shortfall is a truncation.
    missing: Math.max(0, expected - entries.length),
    violations: result.violations,
    applicability: result.applicability,
  };
  if (scored.size >= MAX_CACHE) scored.delete(scored.keys().next().value);
  scored.set(runDir, value);
  return value;
}

/** Test-only: drop the per-run cache so a fixture can re-score the same dir. */
export function _clearOracleCache() {
  scored.clear();
}

/**
 * Build one assertion module from a declaration of the oracles it owns.
 *
 * @param {{ key: string, oracle: string, invariant: string, needs: string }[]} owned
 *   key       the success key authored in a story's `success:` list
 *   oracle    the bench oracle id whose verdict that key reports
 *   invariant one line of the rule, for the detail text
 *   needs     what a trace must contain for the rule to be testable, quoted
 *             back to the author when the run never got there
 * @returns {{ keys: Function, gather: Function, verdict: Function, inheritable: false }}
 */
export function oracleAssertion(owned) {
  const byKey = new Map(owned.map((entry) => [entry.key, entry]));

  return {
    keys: () => owned.map((entry) => entry.key),

    // inheritable: false — every probe run is a fresh falsification attempt over
    // a fresh trajectory, so reusing a saved verdict would report the previous
    // run's search, not this one's (DESIGN §4).
    inheritable: false,

    gather(ctx) {
      const run = scoreRun(ctx);
      const slice = {};
      for (const { key, oracle } of owned) {
        slice[key] = {
          oracle,
          applicable: run.applicability[oracle] === true,
          violations: run.violations.filter((v) => v.oracle === oracle).slice(0, MAX_VIOLATIONS).map(compact),
          total_violations: run.violations.filter((v) => v.oracle === oracle).length,
        };
      }
      return { requests: run.requests, missing: run.missing, keys: slice };
    },

    verdict({ key, value, evidence }) {
      const owner = byKey.get(key);
      const scope = String(value ?? "").trim();
      const note = scope ? ` [${scope}]` : "";

      if (!evidence || !evidence.keys || !evidence.keys[key]) {
        return {
          pass: false,
          detail: `NO_EVIDENCE: ${key} was evaluated without gathered evidence${note} — the observing phase did not run for this assertion`,
        };
      }
      const found = evidence.keys[key];
      const truncated =
        evidence.missing > 0
          ? ` (har.json held ${evidence.requests} of ${evidence.requests + evidence.missing} recorded requests at gather time; the trailing ${evidence.missing} were not yet flushed)`
          : "";

      if (found.violations.length > 0) {
        const first = found.violations[0];
        const at = first.at
          ? `#${first.at.index} ${first.at.method} ${first.at.path} -> ${first.at.status}`
          : "an unlocated request";
        const more =
          found.total_violations > 1 ? ` (+${found.total_violations - 1} more of this kind)` : "";
        // A violation found in a truncated prefix is still a real violation: the
        // trace is a prefix of the run, so every exchange it contains has its
        // full history. Truncation can hide a counterexample, never invent one.
        return {
          pass: false,
          detail: `VIOLATED: ${owner.oracle}/${first.code} at ${at}: ${first.message}${more}${note}`,
        };
      }

      if (!found.applicable) {
        // A declared invariant that was never exercised has not held — it was
        // not tested (DESIGN §5.2: applicability is required, an unexercised
        // rule is never vacuously true). The one exception is a trace we know is
        // incomplete: failing there would blame the actor for a flush the
        // harness had not performed yet.
        if (evidence.missing > 0) {
          return {
            pass: true,
            detail: `INCONCLUSIVE: ${owner.oracle} was not exercised by the ${evidence.requests} requests visible to the gate${truncated} — re-score the finished run with the bench before trusting this${note}`,
          };
        }
        return {
          pass: false,
          detail: `NOT_EXERCISED: ${owner.oracle} — ${owner.invariant} The run's ${evidence.requests} requests never reached a state where it is testable. Needs: ${owner.needs}${note}`,
        };
      }

      return {
        pass: true,
        detail: `HELD: ${owner.oracle} — no counterexample in ${evidence.requests} requests${truncated}${note}`,
      };
    },
  };
}
