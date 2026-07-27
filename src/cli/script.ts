// `playtest script author …` — the local surface on the authoring loop
// (docs/contracts/scripts.md#the-authoring-loop, DESIGN §8).
//
// The hosted product is the front door (N3); this exists because scripts are
// plain files, so the loop that writes one is useful from a terminal too — and
// because S2 owes findings a place to be printed before S4's approval screen
// exists. It runs one job from one document and prints what a reviewer needs:
// what it spent, whether the suite is sound, and every candidate finding with
// its evidence.
import path from "node:path";

import { formatScriptFindings, loadAuthoringJob, prepareAuthoringJob, runAuthoringJob } from "../core/public/api-suite-scripts.ts";

interface ScriptAuthorOptions {
  outDir?: string;
  prepare?: boolean;
}

interface PreparedAuthoringJob {
  handoutDir: string;
  specSource: { kind: string; detail: string };
  rules: unknown[];
  obligations: Array<{ source: string }>;
  baseUrl: string;
  license: { write: boolean; approved_by: string };
}

type AuthoringEvent =
  | { type: "turn"; iteration: number; of: number }
  | { type: "rejected"; objections: Array<{ check: string; reason: string }> }
  | { type: "iterated"; reasons: unknown[] }
  | { type: "sound"; exit_code: number };

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** `playtest script author <job>` */
export async function scriptAuthor(file: string, options: ScriptAuthorOptions = {}) {
  const job = loadAuthoringJob(file);
  if (options.outDir) job.out_dir = path.resolve(options.outDir);

  if (options.prepare) {
    const prepared = await prepareAuthoringJob(job) as PreparedAuthoringJob; // TODO(ts): authoring validates this result before returning it
    console.log(`handout written to ${prepared.handoutDir}`);
    console.log(`  spec         ${prepared.specSource.kind}: ${prepared.specSource.detail}`);
    console.log(`  rules        ${plural(prepared.rules.length, "approved statement")}`);
    console.log(`  obligations  ${prepared.obligations.length} (${["policy", "operation", "rule"].map((source) => `${prepared.obligations.filter((entry) => entry.source === source).length} ${source}`).join(", ")})`);
    console.log(`  target       ${prepared.baseUrl} · ${prepared.license.write ? "read-write" : "read-only"} · authorized by ${prepared.license.approved_by}`);
    return 0;
  }

  const result = await runAuthoringJob({
    ...job,
    onEvent: (event: AuthoringEvent) => {
      if (event.type === "turn") process.stderr.write(`· turn ${event.iteration}/${event.of}\n`);
      if (event.type === "rejected") for (const objection of event.objections) process.stderr.write(`  rejected — ${objection.check}: ${objection.reason}\n`);
      if (event.type === "iterated") process.stderr.write(`  not yet sound — ${plural(event.reasons.length, "reason")}\n`);
      if (event.type === "sound") process.stderr.write(`  sound (exit ${event.exit_code})\n`);
    },
  });

  const used = result.budget.used;
  console.log("");
  console.log(
    result.sound
      ? `Sound after ${plural(used.executions, "execution")} — ${plural(used.requests, "request")}, ${Math.round(used.wall_clock_ms / 1000)}s, $${used.cost_usd.toFixed(4)}.`
      : `Not sound: ${result.detail} (${plural(used.executions, "execution")}, ${plural(used.requests, "request")}, ${Math.round(used.wall_clock_ms / 1000)}s).`,
  );
  if (result.report) {
    const obligations = result.report.obligations.summary;
    console.log(
      `${plural(result.report.checks.length, "check")} covering ${obligations.covered} of ${obligations.total} obligations` +
        `${obligations.unaccounted ? ` — ${obligations.unaccounted} unaccounted` : ""}.`,
    );
  }
  console.log("");
  console.log(formatScriptFindings(result.findings));
  console.log("");
  if (result.bundleDir) console.log(`bundle     ${result.bundleDir}`);
  console.log(`transcript ${result.transcriptPath}`);
  return result.sound ? 0 : 2;
}
