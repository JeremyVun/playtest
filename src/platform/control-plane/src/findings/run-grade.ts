// Per-run grade intake: the "run_grade" source the intake path reserved
// (docs/contracts/hosted.md, "Findings intake").
//
// When a run's report lands, the grader's structured issues stop being
// run-scoped observations and enter the ONE hosted intake path as findings,
// automatically:
//
//   * `grade.json` `bug_candidates` — typed malfunction claims (discovery
//     grades). Their `kind` is already the fixed category vocabulary.
//   * `grade.json` `findings` with severity `minor` or `major` — free-form
//     quality issues, filed under the same `expectation_violation` fallback
//     synthesis uses. `info` observations stay run-scoped: they are color, not
//     work, and would bury the queue.
//
// Nothing here confirms anything: an issue lands as a finding in state `new`,
// unreviewed and off every alarm surface. A strict-key recurrence of a live
// finding auto-appends evidence instead (the trust boundary: model prose never
// reaches a confirmed state on its own). Deterministic gate-failure findings
// (extractor.ts) keep their own fingerprint scheme but now store exact keys, so
// a grader restating the failed assertion lands as a loose-match suggestion on
// that finding rather than duplicating it.
//
// Identity is server-derived, like synthesis: the signal type and locus behind
// a finding's exact keys come from the run's RECORDED anomaly signals at the
// cited steps (core extractAnomalies), never from the grader's wording.
import crypto from "node:crypto";
import { extractAnomalies } from "../../../../core/public/analysis.ts";
import { loadRunBundle } from "../api/viewer-adapter.ts";
import { intakeFinding } from "./intake.ts";
import { CATEGORIES } from "./keys.ts";
import { deriveSignal } from "./synthesis.ts";

const MAX_EXCERPT = 1200;
const SEVERITIES = new Set(["info", "minor", "major"]);

/**
 * The bundle half, run OUTSIDE the report transaction (object-store reads must
 * never hold row locks — same rule as diffSummaryForRun): the run's grade.json
 * plus its recomputed anomaly signals. Null when the run has no bundle, no
 * grade, or nothing worth filing — the report proceeds untouched.
 */
export async function collectRunGradeIssues(ctx: HostedDynamic, runDbId: HostedDynamic, manifest: HostedDynamic = null) {
  try {
    const bundle = await loadRunBundle(ctx, runDbId);
    if (!bundle || bundle.provider.stat("grade.json") === null) return null;
    const grade = JSON.parse(bundle.provider.readText("grade.json"));
    const issues = gradeIssues(grade);
    if (!issues.length) return null;
    let signals: HostedDynamic[] = [];
    const trajText = bundle.provider.stat("trajectory.jsonl") !== null
      ? bundle.provider.readText("trajectory.jsonl")
      : null;
    if (trajText) {
      const envelopes = trajText
        .split("\n")
        .filter((l: HostedDynamic) => l.trim())
        .map((l: HostedDynamic) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      signals = extractAnomalies(envelopes, { perf: manifest?.case?.perf ?? null });
    }
    return { issues, signals };
  } catch {
    return null; // a lost/pruned/corrupt bundle degrades intake, never the report
  }
}

/**
 * Normalize the grade's two issue shapes into one:
 * `{ category, severity, title, expected, observed, steps, modelSignals }`.
 * Malformed entries are skipped, not thrown — grader output is model output,
 * and a bad entry must not fail report ingest.
 */
export function gradeIssues(grade: HostedDynamic) {
  const out: HostedDynamic[] = [];
  for (const c of Array.isArray(grade?.bug_candidates) ? grade.bug_candidates : []) {
    const title = firstLine(c?.title);
    if (!title || !CATEGORIES.includes(c?.kind)) continue;
    out.push({
      category: c.kind,
      severity: SEVERITIES.has(c.severity) ? c.severity : "minor",
      title,
      expected: typeof c.expected === "string" ? c.expected : null,
      observed: typeof c.observed === "string" ? c.observed : title,
      steps: steps(c.evidence_steps),
      modelSignals: Array.isArray(c.signals) ? c.signals.filter((s: HostedDynamic) => typeof s === "string") : [],
    });
  }
  for (const f of Array.isArray(grade?.findings) ? grade.findings : []) {
    const note = firstLine(f?.note);
    if (!note || (f?.severity !== "minor" && f?.severity !== "major")) continue;
    out.push({
      category: "expectation_violation",
      severity: f.severity,
      title: note,
      expected: null,
      observed: note,
      steps: steps([f.step]),
      modelSignals: [],
    });
  }
  return out;
}

/**
 * Take one run's grade issues through intake, inside the report transaction.
 * Idempotent under runner retries: each issue's intake key is stable in the
 * run and the claim, so a re-reported run re-lands on the same findings.
 */
export async function ingestRunGradeFindings(tx: HostedDynamic, { projectId, run, collected }: HostedDynamic) {
  if (!collected) return { findings: 0 };
  // deriveSignal reads citations shaped like synthesis's — one self-referential
  // run carrying the recorded signals.
  const selfRef: HostedDynamic = { db_id: run.id, case_id: run.case_id, signals: collected.signals };
  const refs = new Map([["self", selfRef]]);
  let findings = 0;
  for (const issue of collected.issues) {
    const citations = (issue.steps.length ? issue.steps : [null]).map((step: HostedDynamic) => ({ run_ref: "self", step }));
    const derived = deriveSignal(citations, refs, issue.category);
    await intakeFinding(tx, {
      projectId,
      source: "run_grade",
      actor: { system: "findings" },
      claim: {
        category: issue.category,
        storyId: run.story_id ?? null,
        caseId: run.case_id ?? null,
        signalType: derived.signalType,
        locus: derived.locus,
        title: issue.title,
        expected: issue.expected,
        observed: issue.observed,
        severity: issue.severity,
        signals: derived.signals.length ? derived.signals : issue.modelSignals,
      },
      evidence: (issue.steps.length ? issue.steps : [null]).map((step: HostedDynamic) => ({
        run_id: run.id,
        case_id: run.case_id,
        step,
        excerpt: issue.observed?.slice(0, MAX_EXCERPT) ?? null,
      })),
      intakeKey: `grade:${run.id}:${issueKey(issue)}`,
    });
    findings++;
  }
  return { findings };
}

/** Stable per-issue idempotency key: category + normalized title + cited steps. */
function issueKey(issue: HostedDynamic) {
  const norm = issue.title.toLowerCase().replace(/\s+/g, " ").trim();
  return crypto
    .createHash("sha256")
    .update([issue.category, norm, ...issue.steps].join("\u001f"))
    .digest("hex")
    .slice(0, 32);
}

function steps(xs: HostedDynamic) {
  return [...new Set((Array.isArray(xs) ? xs : []).filter((n) => Number.isInteger(n) && n > 0))];
}

function firstLine(s: HostedDynamic) {
  return String(s || "").split("\n").find((l) => l.trim())?.trim().slice(0, 180) || "";
}
