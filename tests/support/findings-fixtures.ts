// Fixtures for the local findings ledger (BUILD_PLAN P5): a throwaway suite plus
// run directories whose grade.json carries recorded bug candidates.
//
// The runs are faithful but minimal: one step envelope carrying the recorded
// evidence the deterministic anomaly extractor reads (an HTTP failure, a console
// exception), so identity is derived exactly as it is in a real run.
import fs from "node:fs";
import path from "node:path";

type Defect = "http_500" | "http_500_other_route" | "console";

interface Candidate {
  kind: string;
  severity: string;
  title: string;
  expected: string;
  observed: string;
  evidence_steps: number[];
  signals: string[];
}

interface MakeRunOptions {
  runId: string;
  caseId?: string;
  defect?: Defect;
  startedAt?: string;
  candidates?: Candidate[] | null;
}

/** A suite root with a playtest.yaml, plus an empty runs root beside it. */
export function makeSuite(root: string) {
  const suite = path.join(root, "suite");
  fs.mkdirSync(path.join(suite, "stories"), { recursive: true });
  fs.writeFileSync(path.join(suite, "playtest.yaml"), "app:\n  driver: web\n  base_url: http://127.0.0.1:4173\n");
  fs.writeFileSync(path.join(suite, "stories", "remove-item.yaml"), "mode: discovery\nstory: Remove an item from the cart.\n");
  const runs = path.join(root, "runs");
  fs.mkdirSync(runs, { recursive: true });
  return { suite, runs };
}

/**
 * One recorded run whose grade carries `bug_candidates`.
 *
 * `candidates` overrides the recorded candidates.
 */
export function makeRun(runsRoot: string, {
  runId,
  caseId = "cart/remove-item",
  defect = "http_500",
  startedAt = "2026-07-21T09:00:00.000Z",
  candidates = null,
}: MakeRunOptions): string {
  const dir = path.join(runsRoot, runId, ...caseId.split("/"));
  fs.mkdirSync(dir, { recursive: true });

  const requestId = Math.floor(Math.random() * 100000);
  const envelope: {
    step: number;
    schema_version: number;
    mode: string;
    agent: { thought: string; action: { type: string; ref: string }; expectation: string };
    resolution: { ref: string; locator: string; bbox: object };
    result: { ok: boolean; error: null; url: string };
    network: { requests: Array<{ method: string; url: string; path: string; status: number }> };
    console_errors?: Array<{ type: string; text: string }>;
  } = {
    step: 1,
    schema_version: 7,
    mode: "agent",
    agent: { thought: "Remove the item.", action: { type: "click", ref: "e1" }, expectation: "the row disappears" },
    resolution: { ref: "e1", locator: '[data-testid="remove"]', bbox: {} },
    result: { ok: true, error: null, url: "http://shop.local/cart" },
    network: { requests: [] },
  };
  if (defect === "http_500") {
    envelope.network.requests = [{
      method: "DELETE",
      url: `http://shop.local/api/cart/items/${requestId}`,
      path: `/api/cart/items/${requestId}`,
      status: 500,
    }];
  } else if (defect === "http_500_other_route") {
    envelope.network.requests = [{
      method: "POST",
      url: "http://shop.local/api/checkout/submit",
      path: "/api/checkout/submit",
      status: 500,
    }];
  } else if (defect === "console") {
    envelope.console_errors = [{ type: "pageerror", text: `TypeError: total of undefined (trace ${requestId})` }];
  }

  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    `${JSON.stringify({
      schema_version: 1,
      run_id: runId,
      started_at: startedAt,
      mode: "explore",
      case: { id: caseId, file: `suite/stories/${caseId.split("/").pop()}.yaml`, story: "Remove an item." },
      artifacts: { grade: "grade.json", trajectory: "trajectory.jsonl" },
      result: { status: "explored" },
    }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, "trajectory.jsonl"), `${JSON.stringify(envelope)}\n`);
  fs.writeFileSync(
    path.join(dir, "grade.json"),
    `${JSON.stringify({
      score: 40,
      completion: "partial",
      efficiency: { assessment: "fine" },
      findings: [],
      summary: "The remove action failed.",
      bug_candidates: candidates ?? [defaultCandidate(defect)],
    }, null, 2)}\n`,
  );
  return dir;
}

function defaultCandidate(defect: Defect): Candidate {
  if (defect === "console") {
    return {
      kind: "console_exception",
      severity: "major",
      title: "Cart totals throw on render",
      expected: "the cart renders its total",
      observed: "a TypeError is thrown while rendering the total",
      evidence_steps: [1],
      signals: ["console_exception"],
    };
  }
  if (defect === "http_500_other_route") {
    return {
      kind: "http_error",
      severity: "major",
      title: "Checkout submission fails",
      expected: "the order is submitted",
      observed: "the checkout endpoint returns a server error",
      evidence_steps: [1],
      signals: ["http_5xx"],
    };
  }
  return {
    kind: "http_error",
    severity: "major",
    title: "Removing a cart item fails",
    expected: "the item is removed from the cart",
    observed: "the delete request comes back as a server error",
    evidence_steps: [1],
    signals: ["http_5xx"],
  };
}

/** A stable snapshot of every file under a directory: path → sha-free content length + mtime-free bytes. */
export function snapshotTree(root: string) {
  const out = new Map<string, string>();
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else out.set(path.relative(root, file), fs.readFileSync(file, "utf8"));
    }
  };
  visit(root);
  return out;
}
