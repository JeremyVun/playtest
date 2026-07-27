import fs from "node:fs";
import path from "node:path";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

interface ActionSpec {
  thought: string;
  action: {
    type: string;
    ref?: string;
    text?: string;
    submit?: boolean;
    summary?: string;
  };
  expectation: string;
  locator: string | null;
}

interface RunOptions {
  runId: string;
  caseId: string;
  caseFile: string;
  mode: string;
  status: string;
  startedAt: string;
  healed?: boolean;
  baseline?: { run_id: string } | null;
  changedAction?: boolean;
}

const actions: ActionSpec[] = [
  {
    thought: "Enter buy milk in the todo field.",
    action: { type: "type", ref: "e1", text: "buy milk", submit: false },
    expectation: "The field contains buy milk.",
    locator: "#todo-input",
  },
  {
    thought: "Use the primary action to add the todo.",
    action: { type: "click", ref: "e2" },
    expectation: "Buy milk appears in the list.",
    locator: "#add-button",
  },
  {
    thought: "The requested todo is visible, so the journey is complete.",
    action: { type: "done", summary: "Added buy milk." },
    expectation: "The run ends successfully.",
    locator: null,
  },
];

function envelope(step: number, spec: ActionSpec, mode = "agent") {
  return {
    step,
    schema_version: 7,
    ts: Date.parse("2026-06-10T03:04:11Z") + step * 1000,
    mode,
    agent: {
      thought: spec.thought,
      action: spec.action,
      expectation: spec.expectation,
    },
    snapshot_text: `[e1] textbox "What needs doing?"\n[e2] button "Add"`,
    resolution: spec.locator
      ? { ref: spec.action.ref, locator: spec.locator, bbox: { x: 10 + step * 5, y: 20, w: 90, h: 30 } }
      : undefined,
    result: { ok: true, error: null, settle_ms: 10, url: "http://127.0.0.1:1/" },
    perf: { input_to_paint_ms: 10, long_tasks_ms: 0, requests: 0, js_errors: 0, nav: null },
    network: { requests: [] },
    artifacts: {
      screenshot: `steps/${String(step).padStart(3, "0")}.png`,
      a11y: `steps/${String(step).padStart(3, "0")}.a11y.txt`,
    },
  };
}

function manifest({ runId, caseId, caseFile, mode, status, startedAt, healed = false, baseline = null }: RunOptions) {
  return {
    schema_version: 1,
    run_id: runId,
    case: {
      id: caseId,
      file: caseFile,
      story: 'Add "buy milk" to the list.',
      description: mode === "record" ? "Buy-milk smoke journey." : null,
      mode: mode === "explore" ? "discovery" : "journey",
      persona: null,
      tags: ["smoke"],
      success: [],
      perf: [],
      report: mode === "explore" ? ["Where did the user look first?"] : [],
      vision: false,
      limits: { max_steps: 10 },
    },
    mode,
    started_at: startedAt,
    finished_at: new Date(Date.parse(startedAt) + 3000).toISOString(),
    duration_ms: 3000,
    pins: { harness_version: "0.1.0", driver: "web", prompts_version: "prompts-v8" },
    env: { base_url: "http://127.0.0.1:1", managed: false, driver: "web" },
    result: {
      status,
      end_reason: "done",
      error: null,
      // A journey gate with one ordinary passing check and one ADVISORY invariant
      // policy that found a violation. The advisory row is what carries `steps`:
      // the step-linked evidence a cross-layer API violation renders with
      // (docs/contracts/engine.md#invariant-policies). Advisory never gates, so
      // the run's own pass status is unaffected.
      gate:
        status === "explored"
          ? null
          : {
              pass: true,
              checks: [
                {
                  kind: "element_exists",
                  severity: "hard",
                  spec: "element_exists: [data-testid=todo-item]",
                  pass: true,
                  applicable: true,
                  detail: "element present",
                },
              ],
              advisory: [
                {
                  kind: "invariant",
                  severity: "advisory",
                  spec: "invariant: documented_status",
                  label: "every API response carried a status the spec declares",
                  pass: false,
                  applicable: true,
                  detail: "POST /api/todos answered 200, which the spec does not declare for POST /api/todos (declared: 201, 400)",
                  steps: [2],
                },
              ],
            },
    },
    totals: {
      steps: 3,
      executed_steps: 2,
      tokens: { in: 10, out: 5, cache_read: 0 },
      cost_usd: 0,
      console_errors: 0,
      lcp_ms: 100,
    },
    healed,
    baseline,
    artifacts: {
      trajectory: "trajectory.jsonl",
      har: "har.json",
      video: null,
      trace: null,
      grade: "grade.json",
      context: null,
      baseline_copy: baseline ? "baseline.jsonl" : null,
    },
  };
}

function writeRun(
  root: string,
  { runId, caseId, caseFile, mode, status, startedAt, healed = false, baseline = null, changedAction = false }: RunOptions
) {
  const runDir = path.join(root, runId, ...caseId.split("/"));
  fs.mkdirSync(path.join(runDir, "steps"), { recursive: true });
  const specs = actions.map((a) => ({ ...a, action: { ...a.action } })) as [ActionSpec, ActionSpec, ActionSpec]; // TODO(ts): the fixed three-action fixture preserves tuple length through map
  if (changedAction) {
    specs[1].thought = "The UI changed; use the renamed Save action.";
    specs[1].locator = "#save-button";
  }
  const trajectory = specs.map((a, i) => envelope(i + 1, a));
  fs.writeFileSync(
    path.join(runDir, "manifest.json"),
    JSON.stringify(manifest({ runId, caseId, caseFile, mode, status, startedAt, healed, baseline }), null, 2) + "\n",
  );
  fs.writeFileSync(path.join(runDir, "trajectory.jsonl"), trajectory.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(path.join(runDir, "har.json"), JSON.stringify({ log: { entries: [] } }) + "\n");
  fs.writeFileSync(
    path.join(runDir, "grade.json"),
    JSON.stringify({
      score: mode === "explore" ? 88 : 91,
      summary: "Deterministic fixture grade.",
      findings: [],
      report: mode === "explore"
        ? [{ question: "Where did the user look first?", answer: "They started at the primary input.", evidence_steps: [1] }]
        : undefined,
      // A discovery run carries a typed bug candidate; a journey grade never does
      // (viewer must render both the present and the absent case unchanged).
      bug_candidates: mode === "explore"
        ? [{ kind: "http_error", severity: "major", title: "Save request returns a server error", expected: "the item saves", observed: "the save endpoint returned a 500", evidence_steps: [2], signals: ["http_5xx"] }]
        : undefined,
    }) + "\n",
  );
  for (let i = 1; i <= trajectory.length; i++) {
    const n = String(i).padStart(3, "0");
    fs.writeFileSync(path.join(runDir, "steps", `${n}.png`), Buffer.from(PNG_1X1, "base64"));
    fs.writeFileSync(path.join(runDir, "steps", `${n}.a11y.txt`), trajectory[i - 1]!.snapshot_text + "\n"); // TODO(ts): loop bounds prove the indexed trajectory step exists
  }
  if (baseline) {
    const baseTrack = actions.map((a, i) => envelope(i + 1, a));
    fs.writeFileSync(path.join(runDir, "baseline.jsonl"), baseTrack.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  return runDir;
}

/**
 * Build recorded, healed, and explored runs without launching a target app or
 * model. `healedSameTrack` adds a fourth run (mode "act") that healed but
 * re-took exactly the baseline actions — a transient replay failure where the
 * diff has zero changes. Opt-in: the server suite asserts exact run counts.
 */
export function makeRunsFixture(root: string, { healedSameTrack = false }: { healedSameTrack?: boolean } = {}) {
  const suiteDir = path.join(root, "suite");
  const resultsDir = path.join(suiteDir, "results");
  const runsRoot = path.join(root, "runs");
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(suiteDir, "playtest.yaml"),
    "app:\n  driver: api\n  base_url: http://127.0.0.1:1\n",
  );
  const caseFile = path.join(suiteDir, "add-todo.yaml");
  fs.writeFileSync(caseFile, 'story: |\n  Add "buy milk" to the list.\n');

  const recordDir = writeRun(runsRoot, {
    runId: "2026-06-10T0300-aa11",
    caseId: "todos/add-todo",
    caseFile,
    mode: "record",
    status: "pass",
    startedAt: "2026-06-10T03:00:00.000Z",
  });
  const healDir = writeRun(runsRoot, {
    runId: "2026-06-10T0310-bb22",
    caseId: "todos/add-todo",
    caseFile,
    mode: "heal",
    status: "pass",
    startedAt: "2026-06-10T03:10:00.000Z",
    healed: true,
    baseline: { run_id: "2026-06-10T0300-aa11" },
    changedAction: true,
  });
  if (healedSameTrack) {
    writeRun(runsRoot, {
      runId: "2026-06-10T0315-ee55",
      caseId: "todos/add-todo",
      caseFile,
      mode: "act",
      status: "pass",
      startedAt: "2026-06-10T03:15:00.000Z",
      healed: true,
      baseline: { run_id: "2026-06-10T0300-aa11" },
    });
  }
  const exploreDir = writeRun(runsRoot, {
    runId: "2026-06-10T0320-cc33",
    caseId: "studies/add-milk",
    caseFile: path.join(suiteDir, "add-milk.yaml"),
    mode: "explore",
    status: "explored",
    startedAt: "2026-06-10T03:20:00.000Z",
  });

  const healedBase = path.join(resultsDir, "add-todo.healed");
  fs.writeFileSync(`${healedBase}.jsonl`, fs.readFileSync(path.join(healDir, "trajectory.jsonl")));
  fs.writeFileSync(`${healedBase}.json`, JSON.stringify({
    run_id: "2026-06-10T0310-bb22",
    run_dir: healDir,
  }) + "\n");

  return { runsRoot, recordDir, healDir, exploreDir, caseFile };
}
