// Arm P round driver: launch the frozen suite, wait for the group to settle,
// trigger discovery synthesis (product feature), wait for the debounced
// finding sweeps, then export the round's deliverable — the deduplicated
// findings list — plus run metrics. No finding state is ever mutated here.
//
// Usage:
//   node arm-p-round.mjs --setup <setup.json> --round <n> --out <dir>

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { api, waitForGroup, waitForFindingsSettle } from "./lib/api.mjs";

const { values: args } = parseArgs({
  options: {
    setup: { type: "string" },
    round: { type: "string" },
    out: { type: "string" },
    // Resume/export an already-launched group instead of launching a new one
    // (crash recovery; the launch itself is idempotent-hostile, exports are not).
    group: { type: "string" },
  },
});
for (const k of ["setup", "round", "out"]) {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}

const setup = JSON.parse(fs.readFileSync(args.setup, "utf8"));
const outDir = args.out;
fs.mkdirSync(outDir, { recursive: true });

const startedAt = new Date();

let groupId = args.group;
if (!groupId) {
  const launch = await api.post(`/projects/${setup.project_key}/run-groups`, {
    suite_id: setup.suite_id,
    ring_id: setup.ring_id,
    selection: {},
    note: `detection-web round ${args.round}`,
  });
  groupId = launch.run_group?.id ?? launch.id;
  console.log(`launched run group ${groupId}`);
}

await waitForGroup(groupId);
const group = await api.get(`/run-groups/${groupId}?include=runs`);
// The detail route carries no stats projection; the project list route does.
const groupList = await api.get(`/projects/${setup.project_key}/run-groups?limit=50`);
const stats = (groupList.items ?? []).find((g) => g.id === groupId)?.stats ?? {};
console.log(`group done: ${JSON.stringify(stats)}`);

// Discovery synthesis is part of the product surface a customer automation
// would drive; it 400s when the group has no explored runs — tolerated.
// Transient gateway 5xx get a bounded retry.
let synthesis = null;
for (let attempt = 1; ; attempt++) {
  try {
    synthesis = await api.post(`/run-groups/${groupId}/synthesize-findings`, {});
    console.log(`synthesis: ${JSON.stringify(synthesis).slice(0, 400)}`);
    break;
  } catch (err) {
    if (err.status === 400) {
      synthesis = { skipped: "no explored runs" };
      break;
    }
    if (err.status >= 500 && attempt < 3) {
      console.error(`synthesis attempt ${attempt} failed (${err.status}); retrying in 20s`);
      await new Promise((r) => setTimeout(r, 20_000));
      continue;
    }
    throw err;
  }
}

const settledFindings = await waitForFindingsSettle(setup.project_key);

// Full detail per finding (evidence links, claims) for the deliverable.
const findings = [];
for (const f of settledFindings.items ?? []) {
  const detail = await api.get(`/findings/${f.id}`);
  findings.push(detail.finding ?? detail);
}

const finishedAt = new Date();
const roundStartIso = startedAt.toISOString();
const isNewThisRound = (f) => {
  const created = f.created_at ?? f.first_seen ?? null;
  const lastSeen = f.last_seen ?? created;
  return (created && created >= roundStartIso) || (lastSeen && lastSeen >= roundStartIso);
};

const deliverable = {
  arm: "P",
  round: Number(args.round),
  project_key: setup.project_key,
  run_group_id: groupId,
  round_started_at: roundStartIso,
  round_finished_at: finishedAt.toISOString(),
  findings_all: findings,
  findings_this_round: findings.filter(isNewThisRound).map((f) => f.id),
  synthesis,
};
fs.writeFileSync(path.join(outDir, "deliverable.json"), JSON.stringify(deliverable, null, 2));

// Per-run steps/cost/tokens live only on the run detail's `totals`.
const runsBrief = group.runs ?? group.run_group?.runs ?? [];
const runs = [];
for (const r of runsBrief) {
  const detail = await api.get(`/runs/${r.id}`);
  const run = detail.run ?? detail;
  const t = run.totals ?? {};
  runs.push({
    id: run.id,
    case_id: run.case_id,
    status: run.status,
    mode: run.mode,
    steps: t.steps ?? null,
    cost_usd: t.cost_usd ?? null,
    tokens: t.tokens ?? null,
    duration_ms: run.duration_ms ?? null,
    finding_ids: (run.findings ?? []).map((f) => f.id),
  });
}
const metrics = {
  arm: "P",
  round: Number(args.round),
  wall_ms: finishedAt - startedAt,
  group_wall_ms: stats.duration_ms ?? null,
  group_stats: stats,
  cost_usd: stats.cost_usd ?? null,
  synthesis_cost_usd: synthesis?.usage?.cost_usd ?? 0,
  actor_steps: runs.reduce((n, r) => n + (r.steps ?? 0), 0),
  runs,
};
fs.writeFileSync(path.join(outDir, "metrics.json"), JSON.stringify(metrics, null, 2));
console.log(JSON.stringify({ group: groupId, findings_total: findings.length, new_this_round: deliverable.findings_this_round.length, wall_ms: metrics.wall_ms, cost_usd: metrics.cost_usd, steps: metrics.actor_steps }));
