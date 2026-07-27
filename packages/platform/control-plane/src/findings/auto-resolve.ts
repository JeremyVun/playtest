// Automatic resolution of findings a later run disproves ("auto-resolve",
// docs/contracts/hosted.md, "Findings").
//
// A failing run raises findings; until now a later run that demonstrated the
// fix did nothing to them, so every surface kept ringing until a person walked
// the queue. The system already knows: after reports land, a debounced
// per-project sweep re-tests each open finding against the newest verdict
// runs and closes the loop. Gate and signal tiers are deterministic;
// judgment-call findings get an affirmative re-check of their own claim
// (verify-fix.ts) rather than an inference from a pass verdict.
//
// Resolution is per (suite, environment, case). One finding's evidence
// legitimately spans suites and environments, and one story fans out into one
// case per persona, so the affected set is DERIVED from evidence — the
// distinct (run_groups.suite_id, run_groups.environment_id, runs.case_id)
// triples reached through finding_evidence — never hand-maintained. Each
// triple gets a resolution stamp when a newer run on it disproves the finding
// under the finding's tier; the finding resolves only when EVERY triple
// carries a stamp newer than that triple's latest evidence. Stamps are never
// deleted: new evidence makes a stamp stale by timestamp comparison, so
// intake stays uncoupled from this sweep. (This is deliberately the same key
// as run-attention retirement, api/runs.js.)
//
// Three tiers, by what grounds the finding:
//
//   * gate-failure findings (`gate_*` signal type) — stamped when the same
//     gate check passes in a newer run on the triple. A failed run still
//     counts: a run that failed at step 8 can retire a finding from step 3.
//   * signal-keyed findings (a strict key derived from recorded anomalies) —
//     stamped when a newer run's recomputed anomalies would NOT strict-hit
//     the finding, guarded by locus coverage: absence only counts if the run
//     passed outright or actually reached the finding's route. An aborted or
//     divergent run that never visited the page proves nothing.
//   * key-less findings (judgment calls) — a pass verdict never proved the
//     claim: the grader grades fresh (it is not shown the findings ledger)
//     and checked act-mode runs are not graded at all, so absence from a
//     later grade means "nobody looked". The sweep looks: a targeted
//     verification call (verify-fix.ts) re-checks the claim against the
//     newer run's recorded page content. "Fixed" stamps `verified_absent`;
//     what that stamp may DO is the project's auto-resolve MODE — "semi"
//     writes the "looks fixed by run X — confirm" suggestion, "full"
//     resolves outright. Not-fixed/indeterminate write the checked memo.
//     Without a gateway only a GRADED outright pass still suggests — an
//     ungraded checked run proves nothing about a judgment call. Findings
//     with a live external ref only ever suggest, whatever the mode: a live
//     ticket is never contradicted silently.
//
// The sweep mirrors auto-dedupe's skeleton — debounce per project, lease
// single-flight, fire-and-forget with logged failure — but owns its own timer
// map AND its own lease name: `withLease` refuses an overlapping claim rather
// than queueing it, and a dropped resolve sweep after a group's final report
// has no later retrigger. Interleaving with a dedupe sweep is safe by
// construction — every apply statement here re-asserts state and last_seen
// and refuses to follow merge tombstones.
import { withLease } from "../leases.ts";
import { audit } from "../audit.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import { extractAnomalies } from "@playtest/core/analysis";
import { loadRunBundle } from "../run-storage.ts";
import { assistantConfigured } from "../authoring/assistant.ts";
import { publicFinding } from "./extractor.ts";
import { coarseSignalType, exactKeys, normalizeText } from "./keys.ts";
import { verifyExcerpts, verifyFindingFixed, verifyModelFor } from "./verify-fix.ts";

export const AUTO_RESOLVE_ACTOR: HostedDynamic = { system: "auto_resolve" };

// Same rationale as auto-dedupe's map, and deliberately not the same map: a
// pending resolve timer must never cancel a pending dedupe timer or vice
// versa. Keyed by the shared Db instance so timers debounce across requests
// and are visible to shutdown/tests.
const TIMERS_BY_DB = new WeakMap();

/** The pending sweep timers for this app — exported for shutdown and tests. */
export function autoResolveTimers(ctx: HostedDynamic) {
  let m = TIMERS_BY_DB.get(ctx.db);
  if (!m) {
    m = new Map();
    TIMERS_BY_DB.set(ctx.db, m);
  }
  return m;
}

/**
 * Is the sweep on for this project? The project's tri-state pin wins
 * (`projects.auto_resolve`), null inherits the deployment default. The sweep
 * runs with or without a gateway — the deterministic tiers never need one,
 * and the keyless tier degrades to its graded-pass fallback.
 */
export function autoResolveEnabledFor(ctx: HostedDynamic, project: HostedDynamic) {
  return project?.auto_resolve ?? ctx.config.autoResolve.enabled;
}

/**
 * What a VERIFIED fix of a judgment-call finding may do here: "semi" keeps it
 * a suggestion a person confirms, "full" resolves it outright. The project's
 * tri-state pin wins (`projects.auto_resolve_mode`), null inherits the
 * deployment default (PLAYTEST_AUTO_RESOLVE_MODE). Deterministic gate and
 * signal resolutions ignore the mode.
 */
export function autoResolveModeFor(ctx: HostedDynamic, project: HostedDynamic) {
  return project?.auto_resolve_mode ?? ctx.config.autoResolve.mode;
}

/**
 * Debounced, lease-guarded sweep trigger. Call after any commit that recorded
 * a pass/fail verdict; repeated calls while a run group reports collapse into
 * one sweep. The per-project policy is read fresh when the timer fires.
 * Fire-and-forget: a sweep failure is logged, never surfaced to the report
 * that scheduled it — the next report re-triggers and the sweep re-derives
 * everything from durable state.
 */
export function scheduleAutoResolve(ctx: HostedDynamic, projectId: HostedDynamic) {
  const timers = autoResolveTimers(ctx);
  clearTimeout(timers.get(projectId));
  const timer = setTimeout(() => {
    timers.delete(projectId);
    withLease(ctx.db, `auto-resolve:${projectId}`, { log: ctx.log }, async () => {
      const project = (await ctx.db.query(`SELECT * FROM projects WHERE id = $1`, [projectId])).rows[0];
      if (project && autoResolveEnabledFor(ctx, project)) await runAutoResolve(ctx, { project });
    }).catch((err) => {
      ctx.log?.warn?.({ msg: "auto-resolve sweep failed", projectId, err: String(err?.stack || err) });
    });
  }, ctx.config.autoResolve.debounceMs);
  timer.unref?.();
  timers.set(projectId, timer);
  return true;
}

// ---------------------------------------------------------------------------
// The pure decision function
// ---------------------------------------------------------------------------

/**
 * Which tier re-tests this finding? A `gate_*` signal type is a recorded gate
 * check and can never match an anomaly recomputation — it must not be routed
 * through the signal test.
 */
export function tierOf(finding: HostedDynamic) {
  if (!finding.strict_key) return "keyless";
  return String(finding.signal_type || "").startsWith("gate_") ? "gate" : "signal";
}

/**
 * Decide what one finding's triples justify. Pure: same inputs, same actions.
 *
 * @param {object} finding the findings row (state, strict_key, signal_type,
 *   external_ref, summary, last_seen)
 * @param {Array<{
 *   suiteId: string, environmentId: string, caseId: string,
 *   lastEvidenceAt: number,             // ms — newest evidence in this triple
 *   stamp: {run_id: string|null, stamped_at: number, method: string}|null,
 *   candidate: {                        // newest pass/fail run on the triple, or null
 *     runId: string, finishedAt: number, status: "pass"|"fail",
 *     gateChecks: Array<object>|null,   // decoded gate checks, if any
 *     isEvidence: boolean,              // run already evidences THIS finding
 *     checked: boolean,                 // a prior sweep already read it and proved nothing
 *     signalKeys: Set<string>|null,     // strict keys recomputed from its bundle; null = bundle unavailable
 *     routes: Set<string>|null,         // normalized route templates it touched; null = bundle unavailable
 *     graded: boolean|null,             // bundle carries grade.json; null = bundle unavailable
 *     verdict: "fixed"|"not_fixed"|"indeterminate"|null, // verify-fix.js answer; null = not verified
 *     verdictEvidence: string|null,     // the verifier's verbatim quote behind the verdict
 *   }|null,
 * }>} triples
 * @param {{mode?: "semi"|"full"}} [opts] what a verified fix may do (autoResolveModeFor)
 * @returns {{stamps: Array<{suiteId, environmentId, caseId, runId, method, stampedAt, note}>,
 *   action: "resolve"|"suggest"|"clear_suggestion"|"none",
 *   resolveRunId: string|null, checked: Array<{suiteId, environmentId, caseId, runId}>,
 *   verified: {note: string|null}|null}}  // every covering stamp is a verified absence
 */
export function resolveDecisions(finding: HostedDynamic, triples: HostedDynamic, { mode = "semi" } = {}) {
  const tier = tierOf(finding);
  const stamps: HostedDynamic[] = [];
  const checked: HostedDynamic[] = [];
  const freshStamps: HostedDynamic[] = []; // the stamp currently covering each triple
  let freshest: HostedDynamic = null; // the newest fresh stamp → resolution provenance

  for (const t of triples) {
    let stamp = t.stamp;
    const c = t.candidate;
    const candidateIsNew = c
      && !c.isEvidence
      && c.finishedAt > t.lastEvidenceAt          // strict: a finding filed by run R carries R's own instant
      && c.runId !== stamp?.run_id                // already judged by this exact run
      && !c.checked;                              // a prior sweep read it and it proved nothing
    if (candidateIsNew) {
      const verdict = testCandidate(tier, finding, c);
      if (verdict.stamp) {
        stamp = { run_id: c.runId, stamped_at: c.finishedAt, method: verdict.method, note: verdict.note ?? null };
        stamps.push({
          suiteId: t.suiteId, environmentId: t.environmentId, caseId: t.caseId,
          runId: c.runId, method: verdict.method, stampedAt: c.finishedAt, note: verdict.note ?? null,
        });
      } else if (verdict.checked) {
        // The bundle was read and the defect is still there (or coverage never
        // reached it) — remember, so a green-elsewhere nightly does not re-pay
        // the read for the same run forever. Never evidence: citing a passing
        // run as defect evidence would corrupt last_seen and reopen from a pass.
        checked.push({ suiteId: t.suiteId, environmentId: t.environmentId, caseId: t.caseId, runId: c.runId });
      }
    }
    const fresh = stamp && stamp.stamped_at > t.lastEvidenceAt;
    if (!fresh) {
      // One stale triple blocks the close; a previously written suggestion is
      // now claiming something the ledger no longer supports.
      return {
        stamps, checked,
        action: finding.summary?.auto_resolve?.suggested ? "clear_suggestion" : "none",
        resolveRunId: null,
      };
    }
    freshStamps.push(stamp);
    if (!freshest || stamp.stamped_at > freshest.stamped_at) freshest = stamp;
  }

  if (!freshest) return { stamps, checked, action: "none", resolveRunId: null, verified: null };

  // "Verified" is a property of the stamps COVERING the triples right now —
  // a stamp persisted by an earlier sweep counts the same as one written
  // here (its note, the verifier's quote, only exists on fresh writes).
  const verified = freshStamps.every((s) => s.method === "verified_absent")
    ? { note: [...freshStamps].sort((a, b) => b.stamped_at - a.stamped_at).find((s) => s.note)?.note ?? null }
    : null;

  // Every triple is freshly stamped. Keyed findings resolve. Judgment calls
  // resolve only in full mode and only when every covering stamp is a
  // VERIFIED absence — a person's "not fixed" on this exact run outranks any
  // mode. Everything else (semi mode, unverified case_pass stamps, a live
  // external ref) gets the suggestion — unless this exact run's suggestion
  // was already written or dismissed.
  const ar = finding.summary?.auto_resolve || {};
  const none: HostedDynamic = { stamps, checked, action: "none", resolveRunId: null, verified };
  const suggest = () => {
    if (ar.dismissed?.run_id === freshest.run_id) return none;
    if (ar.suggested?.run_id === freshest.run_id) return none;
    return { stamps, checked, action: "suggest", resolveRunId: freshest.run_id, verified };
  };
  if (finding.external_ref) return suggest();
  if (tier === "keyless") {
    if (ar.dismissed?.run_id === freshest.run_id) return none;
    if (mode === "full" && verified) {
      return { stamps, checked, action: "resolve", resolveRunId: freshest.run_id, verified };
    }
    return suggest();
  }
  return { stamps, checked, action: "resolve", resolveRunId: freshest.run_id, verified };
}

/**
 * A short, human-legible sentence for WHAT the sweep verified — stamped into
 * `summary.auto_resolve.reason` on an auto-resolution and into
 * `summary.auto_resolve.suggested.reason` on a suggestion, so the finding can
 * say why it closed, not just that it did. Pure: same finding, triples, and
 * decision, same sentence. The verified keyless wording quotes the
 * verifier's evidence when it gave one — the confirm click (or the full-mode
 * close) should show WHAT the page says now.
 */
export function autoResolveReason(finding: HostedDynamic, triples: HostedDynamic, decision: HostedDynamic = null) {
  const tier = tierOf(finding);
  const n = triples.length;
  const scope = n > 1 ? `, everywhere it was seen (${n} suite/environment combinations)` : "";
  if (tier === "gate") {
    const spec = finding.summary?.gate?.spec;
    return spec
      ? `The exact check that failed (“${clip(spec, 120)}”) passed in a newer run${scope}.`
      : `A newer run passed every check this finding failed${scope}.`;
  }
  if (tier === "signal") {
    return `A newer run covered the same part of the app and the recorded failure signal did not recur${scope}.`;
  }
  const verified = decision?.verified ?? null;
  if (verified) {
    const quote = verified.note ? ` — the page now reads “${clip(verified.note, 140)}”` : "";
    return finding.external_ref
      ? `The recorded issue was re-checked against the newest run's page content and is no longer present${scope}${quote}. It is linked to ${finding.external_ref}, so closing it stays with you.`
      : `The recorded issue was re-checked against the newest run's page content and is no longer present${scope}${quote}.`;
  }
  return finding.external_ref
    ? `A newer run passed this story end to end${scope}. It is linked to ${finding.external_ref}, so closing it stays with you.`
    : `A newer run passed this story end to end${scope}. The claim itself is a judgment call, so closing it stays with you.`;
}

const clip = (s: HostedDynamic, n: HostedDynamic) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** One candidate run against one finding, under the finding's tier. */
function testCandidate(tier: HostedDynamic, finding: HostedDynamic, c: HostedDynamic) {
  if (tier === "gate") {
    const spec = finding.summary?.gate?.spec ?? null;
    if (spec) {
      const check = (c.gateChecks || []).find((k: HostedDynamic) => k && k.spec === spec);
      return check?.pass === true ? { stamp: true, method: "gate_pass" } : { stamp: false, checked: false };
    }
    // A gate finding with no recorded spec (kind only): the one thing that
    // re-tests "every check" is an outright pass.
    return c.status === "pass" ? { stamp: true, method: "gate_pass" } : { stamp: false, checked: false };
  }
  if (tier === "signal") {
    if (!c.signalKeys) return { stamp: false, checked: false }; // bundle pruned/lost — proves nothing, retry-able
    if (c.signalKeys.has(finding.strict_key)) return { stamp: false, checked: true }; // still present
    const covered = c.status === "pass" || routeCovered(finding, c.routes);
    return covered ? { stamp: true, method: "signal_absent" } : { stamp: false, checked: true };
  }
  // keyless: an affirmative verification of the claim itself is the real
  // test. Not-fixed AND indeterminate both memo as checked — re-asking the
  // same run yields the same answer; only a newer run changes anything.
  if (c.verdict === "fixed") return { stamp: true, method: "verified_absent", note: c.verdictEvidence || null };
  if (c.verdict === "not_fixed" || c.verdict === "indeterminate") return { stamp: false, checked: true };
  // No verdict (gateway unconfigured, call failed, bundle lost): an outright
  // pass still suggests, but only when the run was actually GRADED end to end
  // — an ungraded checked run's pass proves nothing about a judgment call.
  return c.status === "pass" && c.graded === true
    ? { stamp: true, method: "case_pass" }
    : { stamp: false, checked: false };
}

/**
 * Locus coverage for a failed run: it can still prove a signal absent, but
 * only where it actually went. The comparison is route template against route
 * template, both through the frozen text normalization — the stored
 * `normalized_locus` mixes in step locus and status class and would never
 * match a visited-route set.
 */
function routeCovered(finding: HostedDynamic, routes: HostedDynamic) {
  const route = normalizeRoute(finding.locus?.route);
  return Boolean(route) && Boolean(routes?.has(route));
}

export function normalizeRoute(route: HostedDynamic) {
  if (!route) return null;
  return normalizeText(String(route).split("?")[0]) || null;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * One sweep over a project's open findings. Reads (bundle reads for the
 * signal tier, bundle reads plus verification calls for the keyless tier)
 * happen outside any transaction; the apply is one short transaction per
 * finding whose statements re-assert what the read decided. `callModel` is
 * injected by tests; production verifies through the gateway when one is
 * configured and otherwise falls back to the graded-pass suggestion.
 */
export async function runAutoResolve(ctx: HostedDynamic, { project, callModel = null }: HostedDynamic) {
  const { rows: findings } = await ctx.db.query(
    `SELECT * FROM findings
      WHERE project_id = $1 AND merged_into IS NULL
        AND state IN ('new','accepted','reopened')
      ORDER BY last_seen DESC`,
    [project.id],
  );
  if (!findings.length) return { skipped: "no_open_findings" };

  const mode = autoResolveModeFor(ctx, project);
  const io: HostedDynamic = {
    bundles: new Map(),    // run id → {signals, routes}|null, shared across findings
    rawBundles: new Map(), // run id → open bundle|null, for keyless verification reads
    verify: {
      enabled: Boolean(callModel) || assistantConfigured(),
      model: verifyModelFor(ctx, project),
      callModel,
    },
    log: ctx.log,
  };
  let resolved = 0;
  let suggested = 0;
  let stamped = 0;
  for (const finding of findings) {
    const triples = await triplesOf(ctx, finding, io);
    if (!triples.length) continue;
    const decision = resolveDecisions(finding, triples, { mode });
    stamped += decision.stamps.length;
    const applied = await applyDecision(ctx, { project, finding, decision, reason: autoResolveReason(finding, triples, decision) });
    if (applied === "resolved") resolved += 1;
    if (applied === "suggested") suggested += 1;
  }
  return { findings: findings.length, stamped, resolved, suggested };
}

/** The derived triples for one finding, each with its newest candidate run. */
async function triplesOf(ctx: HostedDynamic, finding: HostedDynamic, io: HostedDynamic) {
  const { bundles } = io;
  const { rows: triples } = await ctx.db.query(
    `SELECT g.suite_id, g.environment_id, r.case_id,
            MAX(fe.created_at) AS last_evidence_at,
            json_group_array(DISTINCT fe.run_id) AS evidence_run_ids,
            json_group_array(DISTINCT fe.step_from) AS evidence_steps
       FROM finding_evidence fe
       JOIN runs r ON r.id = fe.run_id
       JOIN run_groups g ON g.id = r.run_group_id
      WHERE fe.finding_id = $1
      GROUP BY g.suite_id, g.environment_id, r.case_id`,
    [finding.id],
  );

  const stamps = await ctx.db.query(
    `SELECT * FROM finding_resolution_stamps WHERE finding_id = $1`,
    [finding.id],
  );
  const stampOf: HostedDynamic = new Map(stamps.rows.map((s: HostedDynamic) => [
    `${s.suite_id}${s.environment_id}${s.case_id}`,
    { run_id: s.run_id, stamped_at: ms(s.stamped_at), method: s.method },
  ]));
  const checkedMemo = finding.summary?.auto_resolve?.checked || {};

  const out: HostedDynamic[] = [];
  for (const t of triples) {
    const evidenceRunIds = new Set(JSON.parse(t.evidence_run_ids || "[]"));
    const key = `${t.suite_id}${t.environment_id}${t.case_id}`;
    const { rows: newest } = await ctx.db.query(
      `SELECT r.id, r.status, r.gate, r.story_id, r.manifest, r.finished_at
         FROM runs r
         JOIN run_groups g ON g.id = r.run_group_id
        WHERE g.suite_id = $1 AND g.environment_id = $2 AND r.case_id = $3
          AND r.status IN ('pass','fail') AND r.finished_at IS NOT NULL
        ORDER BY r.finished_at DESC, r.id DESC
        LIMIT 1`,
      [t.suite_id, t.environment_id, t.case_id],
    );
    const run = newest[0] || null;
    let candidate: HostedDynamic = null;
    if (run) {
      candidate = {
        runId: run.id,
        finishedAt: ms(run.finished_at),
        status: run.status,
        gateChecks: run.gate?.checks || null,
        isEvidence: evidenceRunIds.has(run.id),
        checked: checkedMemo[key] === run.id,
        signalKeys: null,
        routes: null,
        graded: null,
        verdict: null,
        verdictEvidence: null,
      };
      // Bundle reads are the sweep's only real cost — once per run per sweep,
      // and only when this finding actually needs them: the signal tier
      // recomputes anomalies, the keyless tier reads page content for the
      // verification call (and grade.json presence for its fallback).
      const worthReading = !candidate.isEvidence && !candidate.checked
        && candidate.finishedAt > ms(t.last_evidence_at)
        && candidate.runId !== stampOf.get(key)?.run_id;
      if (tierOf(finding) === "signal" && worthReading) {
        const read = await readRunSignals(ctx, run, bundles);
        if (read) {
          candidate.signalKeys = signalKeysOf(finding.project_id, run.story_id, read.signals);
          candidate.routes = read.routes;
        }
      }
      if (tierOf(finding) === "keyless" && worthReading) {
        const steps = JSON.parse(t.evidence_steps || "[]").filter((n: HostedDynamic) => Number.isInteger(n) && n > 0);
        await verifyCandidate(ctx, { finding, run, candidate, steps, io });
      }
    }
    out.push({
      suiteId: t.suite_id,
      environmentId: t.environment_id,
      caseId: t.case_id,
      lastEvidenceAt: ms(t.last_evidence_at),
      stamp: stampOf.get(key) || null,
      candidate,
      key,
    });
  }
  return out;
}

/**
 * Fill a keyless candidate's `graded` flag and — when verification is
 * available — its verdict, from the run's sealed bundle. A lost or unreadable
 * bundle, or a failed call, leaves everything null: proves nothing, retried
 * by a later sweep. Verdicts are NOT memoized here across findings — two
 * findings verified against the same run are two different claims.
 */
async function verifyCandidate(ctx: HostedDynamic, { finding, run, candidate, steps, io }: HostedDynamic) {
  let bundle = io.rawBundles.get(run.id);
  if (bundle === undefined) {
    try {
      bundle = await loadRunBundle(ctx, run.id);
    } catch {
      bundle = null;
    }
    io.rawBundles.set(run.id, bundle);
  }
  if (!bundle) return;
  try {
    candidate.graded = bundle.provider.stat("grade.json") !== null;
    if (!io.verify.enabled) return;
    const excerpts = verifyExcerpts(bundle, steps);
    if (!excerpts.length) return; // no readable page text — proves nothing
    const res = await verifyFindingFixed({
      finding,
      excerpts,
      model: io.verify.model,
      callModel: io.verify.callModel,
    });
    if (res) {
      candidate.verdict = res.verdict;
      candidate.verdictEvidence = res.evidence;
    }
  } catch (err: HostedDynamic) {
    io.log?.warn?.({ msg: "auto-resolve verification failed", findingId: finding.id, runId: run.id, err: String(err?.stack || err) });
  }
}

/**
 * Recompute a run's anomaly signals and touched routes from its sealed bundle.
 * Outside any transaction (object-store reads never hold row locks). A lost,
 * pruned, or corrupt bundle returns null — it proves nothing and is retried
 * by a later sweep if the run is still the newest.
 */
async function readRunSignals(ctx: HostedDynamic, run: HostedDynamic, bundles: HostedDynamic) {
  if (bundles.has(run.id)) return bundles.get(run.id);
  let out: HostedDynamic = null;
  try {
    const bundle = await loadRunBundle(ctx, run.id);
    if (bundle && bundle.provider.stat("trajectory.jsonl") !== null) {
      const envelopes = bundle.provider.readText("trajectory.jsonl")!
        .split("\n")
        .filter((l: HostedDynamic) => l.trim())
        .map((l: HostedDynamic) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      const signals = extractAnomalies(envelopes, { perf: run.manifest?.case?.perf ?? null });
      const routes = new Set();
      for (const env of envelopes) {
        for (const r of env?.network?.requests ?? []) {
          const route = normalizeRoute(r?.path ?? r?.url);
          if (route) routes.add(route);
        }
      }
      out = { signals, routes };
    }
  } catch {
    out = null;
  }
  bundles.set(run.id, out);
  return out;
}

/** The strict keys this run's recorded signals would produce at intake. */
export function signalKeysOf(projectId: HostedDynamic, storyId: HostedDynamic, signals: HostedDynamic) {
  const keys = new Set();
  for (const s of signals ?? []) {
    const signalType = coarseSignalType(s.type);
    if (!signalType) continue;
    const { strict } = exactKeys({
      projectId,
      storyId: storyId ?? null,
      signalType,
      locus: { route: s.locus?.route ?? null, step_locus: s.detail ?? null, status_class: s.locus?.status_class ?? null },
    });
    if (strict) keys.add(strict);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Apply — one short transaction per finding, preconditions re-asserted
// ---------------------------------------------------------------------------

async function applyDecision(ctx: HostedDynamic, { project, finding, decision, reason = null }: HostedDynamic) {
  const { stamps, checked, action, resolveRunId } = decision;
  if (!stamps.length && !checked.length && action === "none") return null;
  let applied: HostedDynamic = null;
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    for (const s of stamps) {
      await tx.query(
        `INSERT INTO finding_resolution_stamps
           (finding_id, suite_id, environment_id, case_id, run_id, method, stamped_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (finding_id, suite_id, environment_id, case_id)
         DO UPDATE SET run_id = excluded.run_id, method = excluded.method, stamped_at = excluded.stamped_at`,
        [finding.id, s.suiteId, s.environmentId, s.caseId, s.runId, s.method, s.stampedAt],
      );
    }
    if (checked.length) {
      // "Still present / not covered" memo — a note in the summary, NEVER an
      // evidence row (a passing run must not corrupt last_seen or reopen).
      const memo = Object.fromEntries(checked.map((c: HostedDynamic) => [`${c.suiteId}${c.environmentId}${c.caseId}`, c.runId]));
      await tx.query(
        `UPDATE findings
            SET summary = json_patch(summary, json_object('auto_resolve', json_object('checked', json($2)))),
                updated_at = now()
          WHERE id = $1 AND merged_into IS NULL`,
        [finding.id, JSON.stringify({ ...(finding.summary?.auto_resolve?.checked || {}), ...memo })],
      );
    }
    if (action === "resolve") {
      applied = await autoResolveFinding(tx, {
        projectId: project.id,
        finding,
        runId: resolveRunId,
        reason,
      }) ? "resolved" : null;
    } else if (action === "suggest") {
      const { rowCount } = await tx.query(
        `UPDATE findings
            SET summary = json_patch(summary, json_object('auto_resolve',
                  json_object('suggested', json_object('run_id', $2, 'at', $3, 'reason', $6)))),
                updated_at = now()
          WHERE id = $1 AND merged_into IS NULL AND state = $4 AND last_seen = $5`,
        [finding.id, resolveRunId, new Date().toISOString(), finding.state, finding.last_seen, reason],
      );
      if (rowCount) {
        applied = "suggested";
        await audit(tx, {
          actor: AUTO_RESOLVE_ACTOR,
          action: "finding.fix_suggested",
          entityType: "finding",
          entityId: finding.id,
          projectId: project.id,
          detail: { run_id: resolveRunId, external_ref: finding.external_ref ?? null },
        });
        await emitPlatformEvent(tx, {
          projectId: project.id,
          type: "finding.fix_suggested",
          entity: { finding_id: finding.id, run_id: resolveRunId },
          payload: { finding_id: finding.id, run_id: resolveRunId, actor: AUTO_RESOLVE_ACTOR },
        });
      }
    } else if (action === "clear_suggestion") {
      // The ledger no longer supports the claim (new evidence went stale) —
      // retract quietly; the audit trail of the original suggestion stands.
      await tx.query(
        `UPDATE findings
            SET summary = json_remove(summary, '$.auto_resolve.suggested'),
                updated_at = now()
          WHERE id = $1 AND merged_into IS NULL
            AND json_extract(summary, '$.auto_resolve.suggested') IS NOT NULL`,
        [finding.id],
      );
    }
  });
  return applied;
}

/**
 * The non-request-scoped resolve twin of the reviewer transition
 * (api/findings.js resolveFinding), for callers already inside a transaction.
 * Re-asserts state AND last_seen and does NOT follow merge tombstones —
 * auto-dedupe can merge concurrently, and resolving through liveFinding()
 * could close a different story's survivor. Zero rows back means this sweep
 * lost the race: abort quietly, the next sweep re-evaluates.
 *
 * @returns {Promise<boolean>} true when the finding was resolved
 */
export async function autoResolveFinding(tx: HostedDynamic, { projectId, finding, runId, reason = null }: HostedDynamic) {
  const { rows } = await tx.query(
    `UPDATE findings
        SET state = 'resolved',
            resolved_by_run_id = $2,
            auto_resolved_at = now(),
            summary = json_patch(json_remove(summary, '$.auto_resolve.suggested', '$.auto_resolve.dismissed'),
                        json_object('auto_resolve', json_object('reason', $5))),
            updated_at = now()
      WHERE id = $1 AND merged_into IS NULL AND state = $3 AND last_seen = $4
      RETURNING *`,
    [finding.id, runId, finding.state, finding.last_seen, reason],
  );
  const next = rows[0];
  if (!next) return false;
  await audit(tx, {
    actor: AUTO_RESOLVE_ACTOR,
    action: "finding.auto_resolved",
    entityType: "finding",
    entityId: finding.id,
    projectId,
    detail: { from: finding.state, to: "resolved", run_id: runId },
  });
  // The existing event type — feed subscriptions live-refresh unchanged.
  await emitPlatformEvent(tx, {
    projectId,
    type: "finding.resolved",
    entity: { finding_id: finding.id, run_id: runId },
    payload: { finding: publicFinding(next), actor: AUTO_RESOLVE_ACTOR },
  });
  return true;
}

const ms = (v: HostedDynamic) => (v instanceof Date ? v.getTime() : Number(v) || 0);
