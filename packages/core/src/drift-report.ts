// The drift report artifact (docs/contracts/artifacts.md#drift-report).
//
// When an acted API journey escalates to heal, the run writes
// `drift-report.json`: what the harness deterministically observed about the
// failure, what the heal did about it, and — only when a model is configured —
// a narrative explaining the change to a human reviewer.
//
// The split is the whole point. Everything a reader could act on mechanically is
// computed here from recorded evidence: the classification, the signals behind
// it, the failed step, the gate verdict on the healed trajectory, and whether
// the heal was accepted. The model contributes exactly three prose fields —
// what changed, why the rebind is valid, which consumer expectations break — and
// nothing it writes is read back by the harness. It cannot change the
// classification, the gate, the status, or the exit code (DESIGN D2); a run with
// no model configured produces the same report minus the prose.
import fs from "node:fs";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { forcedToolCall } from "./llm.ts";
import { describeAction } from "./actor.ts";
import { actionOf } from "./trajectory.ts";
import type { RetryCallback, TokenUsage, ToolDefinition } from "./llm.ts";
import type { GateLike, HealTriage } from "./heal.ts";
import type { StepEnvelope } from "./trajectory.ts";

const here = dirname(fileURLToPath(import.meta.url));
const driftPrompt = fs.readFileSync(join(here, "prompts", "drift-report.md"), "utf8").trim();

export const DRIFT_REPORT_FILE = "drift-report.json";
export const DRIFT_REPORT_SCHEMA_VERSION = 1;

// The narrative is three short paragraphs; a bigger budget only buys padding.
const NARRATIVE_MAX_TOKENS = 700;

const NARRATIVE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "drift_report",
    description: "Explain, for a human reviewer, the surface change this healed journey ran into.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["what_changed", "why_valid", "consumer_impact"],
      properties: {
        what_changed: {
          type: "string",
          description: "The change in the API's surface, in concrete terms: which operation, which field or status, from what to what.",
        },
        why_valid: {
          type: "string",
          description:
            "Why the rebind the heal found is a faithful way to reach the same goal — or, if it is not, say so plainly. You are describing evidence, not deciding the verdict.",
        },
        consumer_impact: {
          type: "string",
          description: "Which consumer expectations this change breaks: who was reading the old field or relying on the old status, and what they will see now.",
        },
      },
    },
  },
};

interface HealAcceptance {
  ok: boolean;
  reason: string | null;
}

interface BuildDriftOptions {
  runId: string;
  caseId: string;
  triage: HealTriage | null;
  evidence: { baselineStep?: StepEnvelope | null } | null;
  healKind: string | null;
  healReason: string | null;
  healedFromStep: number | null;
  gate: GateLike | null;
  accepted: HealAcceptance | null;
  endReason: string | null;
  mode: string;
}

interface NarrativeFields extends Record<string, unknown> {
  what_changed: string;
  why_valid: string;
  consumer_impact: string;
}

export interface DriftReport {
  schema_version: number;
  run_id: string;
  case_id: string;
  mode: string;
  classification: string | null;
  signals: HealTriage["signals"];
  failed_step: Record<string, unknown>;
  healed_run: Record<string, unknown>;
  narrative: NarrativeFields | null;
  narrated_by: string | null;
}

interface NarrateOptions {
  story: string;
  model: string;
  signal?: AbortSignal | null;
  onRetry?: RetryCallback | null;
  onTokens?: ((tokens: TokenUsage) => void) | null;
}

interface WriteDriftOptions extends BuildDriftOptions, NarrateOptions {
  narrate?: boolean;
}

/**
 * The deterministic half of the report. Pure; exported for test.
 * @returns {object}
 */
export function buildDriftReport({ runId, caseId, triage, evidence, healKind, healReason, healedFromStep, gate, accepted, endReason, mode }: BuildDriftOptions): DriftReport {
  const baselineStep = evidence?.baselineStep ?? null;
  const action = baselineStep ? actionOf(baselineStep) : null;
  return {
    schema_version: DRIFT_REPORT_SCHEMA_VERSION,
    run_id: runId,
    case_id: caseId,
    mode,
    // The deterministic triage verdict. A model never authors this field.
    classification: triage?.classification ?? null,
    signals: triage?.signals ?? [],
    failed_step: {
      baseline_step: healedFromStep ?? baselineStep?.step ?? null,
      action: action ? describeAction(action) : null,
      kind: healKind ?? null,
      reason: healReason ?? null,
      expected_status: triage?.expected_status ?? null,
      observed_status: triage?.observed_status ?? null,
      // Did the journey's own provisioning fail? The baseline-drift signal.
      provisioning: Boolean(triage?.provisioning),
    },
    healed_run: {
      end_reason: endReason ?? null,
      // The gate as it stood on the HEALED trajectory: this, not the narrative,
      // is what decides whether the changed journey is reviewable.
      gate: gate
        ? {
            pass: Boolean(gate.pass),
            checks: (gate.checks ?? []).map((c) => ({ spec: c.spec, severity: c.severity, pass: c.pass, applicable: c.applicable !== false, detail: c.detail })),
          }
        : null,
      accepted: Boolean(accepted?.ok),
      rejected_reason: accepted?.ok ? null : (accepted?.reason ?? null),
    },
    narrative: null,
    narrated_by: null,
  };
}

/**
 * Ask the model for the report's narrative. Returns null on any failure — a
 * report without prose is strictly better than a failed run, because nothing
 * downstream reads these fields.
 */
export async function narrateDrift(
  report: DriftReport,
  { story, model, signal = null, onRetry = null, onTokens = null }: NarrateOptions
): Promise<NarrativeFields | null> {
  const facts = [
    `## Story\n\n${String(story ?? "").trim()}`,
    `## What the harness observed\n\n${JSON.stringify(
      {
        classification: report.classification,
        signals: report.signals,
        failed_step: report.failed_step,
        healed_run: report.healed_run,
      },
      null,
      2,
    )}`,
  ];
  try {
    const { args, tokens } = await forcedToolCall<NarrativeFields>({
      model,
      messages: [
        { role: "system", content: driftPrompt },
        { role: "user", content: facts.join("\n\n") },
      ],
      tool: NARRATIVE_TOOL,
      maxTokens: NARRATIVE_MAX_TOKENS,
      signal,
      onRetry,
    });
    onTokens?.(tokens);
    return {
      what_changed: String(args?.what_changed ?? "").trim(),
      why_valid: String(args?.why_valid ?? "").trim(),
      consumer_impact: String(args?.consumer_impact ?? "").trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Build the report, optionally narrate it, and write it next to the run.
 * Best-effort on the write: a filesystem hiccup must not fail an otherwise
 * complete run.
 * @returns {Promise<object|null>} the written report, or null when none applies
 */
export async function writeDriftReport(runDir: string, options: WriteDriftOptions): Promise<DriftReport | null> {
  const report = buildDriftReport(options);
  if (options.narrate) {
    const narrative = await narrateDrift(report, options);
    if (narrative) {
      report.narrative = narrative;
      report.narrated_by = options.model ?? null;
    }
  }
  try {
    fs.writeFileSync(path.join(runDir, DRIFT_REPORT_FILE), JSON.stringify(report, null, 2) + "\n");
  } catch {
    return report;
  }
  return report;
}
