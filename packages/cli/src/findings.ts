// `playtest findings …` — the local, suite-scoped findings ledger surface
// (BUILD_PLAN P5 item 4; contract: docs/contracts/interfaces.md#local-findings-ledger).
//
// Trust boundary, enforced here rather than trusted to a prompt: exact-key work
// is deterministic and applies itself, while every semantic grouping is written
// to a PLAN FILE and applied only after an explicit human confirmation — an
// interactive "Apply …?" answer, or a later `--apply-plan <file>`. A model never
// mutates the ledger.
import fs from "node:fs";
import path from "node:path";
import {
  applyPlan,
  acceptItem,
  buildPlan,
  callClusterModel,
  exportLedger,
  intakeRunCandidates,
  ledgerPath,
  listCandidates,
  listFindings,
  openLedger,
  rejectItem,
  resolveItem,
  resolveSuiteRoot,
  showItem,
} from "@playtest/core/findings";
import { findRunsRoot } from "@playtest/core/artifacts";
import { forcedToolCall, llmConfig } from "@playtest/core/llm";
import { DummyConfigError } from "@playtest/core/suite";
import { promptConfirm } from "./prompt.ts";
import type { Ledger } from "@playtest/core/findings";

type DynamicValue = any; // SAFETY: Commander options and findings results remain dynamic at this CLI formatting boundary

const PLAN_FILENAME = "consolidation-plan.json";
const out = (opts: DynamicValue, value: DynamicValue, human: () => void) => {
  if (opts.json) console.log(JSON.stringify(value));
  else human();
};

async function withLedger<T>(opts: DynamicValue, fn: (ledger: Ledger) => T | Promise<T>, { create = true }: { create?: boolean } = {}): Promise<T> {
  const ledger = await openLedger({ suite: opts.suite ?? null, create });
  try {
    return await fn(ledger);
  } finally {
    ledger.close();
  }
}

/** `playtest findings list` — findings by default, candidates with --candidates. */
export async function findingsList(opts: DynamicValue) {
  return withLedger(opts, (ledger) => {
    if (opts.candidates) {
      const rows = listCandidates(ledger, { status: opts.status ?? "unassigned" });
      return out(opts, rows, () => printCandidates(rows));
    }
    const rows = listFindings(ledger, { state: opts.state ?? null });
    return out(opts, rows, () => printFindings(rows, ledger));
  }, { create: false });
}

/** `playtest findings show <id>` — one finding or candidate with all its evidence. */
export async function findingsShow(id: string, opts: DynamicValue) {
  return withLedger(opts, (ledger) => {
    const item = showItem(ledger, id);
    return out(opts, item, () => printItem(item));
  }, { create: false });
}

/** `playtest findings accept <id>` */
export async function findingsAccept(id: string, opts: DynamicValue) {
  return withLedger(opts, (ledger) => {
    const result = acceptItem(ledger, { id, title: opts.title ?? null, note: opts.note ?? null });
    return out(opts, publicResult(result), () =>
      console.log(
        result.kind === "candidate"
          ? `accepted bug candidate ${id} → finding ${result.finding.id} (${result.evidence_added} evidence reference(s))`
          : `accepted finding ${id} (was ${result.from_state})`,
      ),
    );
  }, { create: false });
}

/** `playtest findings reject <id>` */
export async function findingsReject(id: string, opts: DynamicValue) {
  return withLedger(opts, (ledger) => {
    const result = rejectItem(ledger, { id, reason: opts.reason ?? "not_a_bug", note: opts.note ?? null });
    return out(opts, publicResult(result), () =>
      console.log(
        result.kind === "candidate"
          ? `rejected bug candidate ${id} (${result.suppressed} key(s) suppressed — exact recurrences are absorbed, run artifacts kept)`
          : `rejected finding ${id} (was ${result.from_state}) — exact recurrences are absorbed silently`,
      ),
    );
  }, { create: false });
}

/** `playtest findings resolve <id>` */
export async function findingsResolve(id: string, opts: DynamicValue) {
  return withLedger(opts, (ledger) => {
    const result = resolveItem(ledger, { id, note: opts.note ?? null });
    return out(opts, publicResult(result), () =>
      console.log(`resolved finding ${id} (was ${result.from_state}) — an exact recurrence will reopen it`),
    );
  }, { create: false });
}

/** `playtest findings export` — the portable JSON document (never the .db file). */
export async function findingsExport(opts: DynamicValue) {
  return withLedger(opts, (ledger) => {
    const doc = exportLedger(ledger);
    if (opts.out) {
      const target = path.resolve(opts.out);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`);
      return out(opts, { written: target, findings: doc.findings.length, candidates: doc.candidates.length }, () =>
        console.log(`exported ${doc.findings.length} finding(s) and ${doc.candidates.length} candidate(s) → ${target}`),
      );
    }
    console.log(JSON.stringify(doc, null, opts.json ? 0 : 2));
    return undefined;
  }, { create: false });
}

/**
 * `playtest findings consolidate` — intake, then propose.
 *
 * Default: scan runs for recorded bug candidates, apply the deterministic
 * exact-key work, write a plan, and stop. Applying the plan needs an explicit
 * confirmation (interactive answer, or `--apply-plan <file>`).
 */
export async function findingsConsolidate(opts: DynamicValue) {
  if (opts.applyPlan) return applyPlanFile(opts);
  const suiteRoot = resolveSuiteRoot(opts.suite ?? null);
  const runsRoot = findRunsRoot(opts.runsRoot ?? null);
  return withLedger(opts, async (ledger) => {
    const intake = intakeRunCandidates(ledger, runsRoot);
    const useModel = opts.clusterModel !== false && llmConfig().available;
    const plan = await buildPlan(ledger, {
      model: useModel ? opts.model : null,
      callModel: useModel
        ? (cluster: DynamicValue) => callClusterModel(cluster, { forcedToolCall })
        : null,
    });
    const planFile = path.resolve(opts.plan ?? path.join(path.dirname(ledgerPath(suiteRoot)), PLAN_FILENAME));
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);

    const summary: DynamicValue = {
      runs_root: runsRoot,
      ledger: ledger.file,
      intake,
      plan_file: planFile,
      model: plan.model,
      proposals: plan.proposals.length,
      unresolved: plan.unresolved.length,
      applied: null,
      stats: plan.stats,
    };

    // Interactive confirmation is the ONLY way a plan applies inside this run.
    if (!opts.json && plan.proposals.length && process.stdout.isTTY && process.stdin.isTTY) {
      printPlan(plan, intake, planFile);
      let confirmed = false;
      try {
        confirmed = await promptConfirm(`Apply ${plan.proposals.length} proposal(s) to the ledger?`);
      } catch {} // stdin closed mid-prompt: treat as declined
      if (confirmed) {
        summary.applied = applyPlan(ledger, plan);
        console.log(`applied ${summary.applied.count} proposal(s)`);
        return undefined;
      }
      console.log(`nothing applied. Apply later with:\n  playtest findings consolidate --apply-plan ${planFile}`);
      return undefined;
    }

    return out(opts, summary, () => {
      printPlan(plan, intake, planFile);
      if (plan.proposals.length) {
        console.log(`\nNothing was grouped. Apply the plan with:\n  playtest findings consolidate --apply-plan ${planFile}`);
      }
    });
  });
}

async function applyPlanFile(opts: DynamicValue) {
  const file = path.resolve(opts.applyPlan);
  if (!fs.existsSync(file)) throw new DummyConfigError(`no consolidation plan at ${file}`);
  let plan: DynamicValue;
  try {
    plan = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e: any) { // SAFETY: JSON parse failures are Error-like values with a message
    throw new DummyConfigError(`${file} is not readable JSON: ${String(e.message).split("\n")[0]}`);
  }
  return withLedger(opts, (ledger) => {
    const result = applyPlan(ledger, plan, { only: opts.only?.length ? opts.only : null });
    return out(opts, { plan_file: file, ...result }, () => {
      for (const a of result.applied) {
        console.log(`${a.proposal}: ${a.candidates} candidate(s) → finding ${a.finding_id}${a.created ? " (new)" : ""}`);
      }
      console.log(`applied ${result.count} proposal(s)`);
    });
  }, { create: false });
}

// ---------------------------------------------------------------------------
// Human output
// ---------------------------------------------------------------------------

function printFindings(rows: DynamicValue[], ledger: Ledger) {
  if (!rows.length) {
    console.log(
      `no local findings yet (${ledger.file}).\n` +
        "  Record some discovery runs, then: playtest findings consolidate",
    );
    return;
  }
  const table = rows.map((f: DynamicValue) => [f.id, f.state, f.severity, String(f.evidence_count), f.title]);
  printTable(["ID", "STATE", "SEVERITY", "EVIDENCE", "TITLE"], table);
}

function printCandidates(rows: DynamicValue[]) {
  if (!rows.length) {
    console.log("no bug candidates in that state.");
    return;
  }
  printTable(
    ["ID", "STATUS", "CATEGORY", "EVIDENCE", "TITLE"],
    rows.map((c: DynamicValue) => [c.id, c.status, c.category, String(c.evidence_count), c.claim?.title ?? ""]),
  );
}

function printItem(item: DynamicValue) {
  if (item.kind === "finding") {
    console.log(`finding ${item.id}  [${item.state}${item.reject_reason ? `: ${item.reject_reason}` : ""}]  ${item.severity}`);
    console.log(item.title);
    if (item.summary?.expected) console.log(`  expected: ${item.summary.expected}`);
    if (item.summary?.observed) console.log(`  observed: ${item.summary.observed}`);
    if (item.merged_into) console.log(`  merged into: ${item.merged_into}`);
    console.log(`  evidence (${item.evidence.length}):`);
    for (const e of item.evidence) console.log(`    ${e.run_id}${e.step_from ? ` step ${e.step_from}` : ""}  ${e.run_dir ?? ""}`);
    console.log("  history:");
    for (const t of item.transitions) {
      console.log(`    ${t.created_at}  ${t.from_state ?? "—"} → ${t.to_state}${t.reason ? ` (${t.reason})` : ""}`);
    }
    return;
  }
  console.log(`bug candidate ${item.id}  [${item.status}]  ${item.category}`);
  console.log(item.claim?.title ?? "");
  if (item.claim?.expected) console.log(`  expected: ${item.claim.expected}`);
  if (item.claim?.observed) console.log(`  observed: ${item.claim.observed}`);
  console.log(`  signal: ${item.signal_type ?? "(none — no exact keys)"}  locus: ${item.normalized_locus ?? "—"}`);
  if (item.suggested_finding_id) console.log(`  suggested finding: ${item.suggested_finding_id} (${item.suggestion_kind})`);
  if (item.recurrence_count) console.log(`  absorbed recurrences: ${item.recurrence_count}`);
  console.log(`  evidence (${item.evidence?.length ?? 0}):`);
  for (const e of item.evidence ?? []) console.log(`    ${e.run_id}${e.step_from ? ` step ${e.step_from}` : ""}  ${e.run_dir ?? ""}`);
}

function printPlan(plan: DynamicValue, intake: DynamicValue, planFile: string) {
  console.log(`intake: ${intake.scanned} recorded candidate(s) — ${describeActions(intake.actions)}`);
  console.log(`plan:   ${plan.proposals.length} proposal(s), ${plan.unresolved.length} unresolved  → ${planFile}`);
  if (!plan.model) console.log("        no model configured: clusters are reported unresolved, nothing was guessed");
  for (const p of plan.proposals) {
    const target = p.finding_id ? `finding ${p.finding_id}` : `new finding "${p.proposed_title}"`;
    console.log(`  ${p.id}  ${p.candidate_ids.length} candidate(s) → ${target}  [${p.source}]  ${p.reason}`);
  }
  for (const u of plan.unresolved) console.log(`  unresolved: ${u.candidate_ids.join(", ")} — ${u.reason}`);
}

const describeActions = (actions: Record<string, number>) =>
  Object.entries(actions)
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ") || "nothing new";

function printTable(headers: string[], rows: string[][]) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length))); // SAFETY: every rendered row is built with the header's fixed column count
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  "); // SAFETY: widths is derived from the same cells
  console.log(line(headers));
  for (const r of rows) console.log(line(r));
}

function publicResult(result: DynamicValue) {
  return JSON.parse(JSON.stringify(result));
}
