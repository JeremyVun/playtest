// PORTED (S1 substrate parity): the P1 agent-authored invariant suite, entered
// through the script contract (docs/contracts/scripts.md#the-entry-contract).
//
// This is `studies/api-probe/comparators/agent-suite/run.mjs` with its process
// concerns removed and nothing else changed. The scenarios, the domain helpers,
// the ledger arithmetic and the assertion helpers are byte-for-byte the frozen
// P1 arm; only the transport (the injected client), the credentials (secret
// references), the report sink (the check channel), and the budget/deadline
// knobs (params) come from the substrate.
//
// What that buys: if the bench scores this run's HAR the way it scored P1's, the
// substrate did not distort the instrument.
//
// params:
//   seed          reset seed (default ledger-dev-seed)
//   maxRequests   the arm's own ceiling; the run's budget is enforced at the wire
//   deadlineMs    stop starting new scenarios after this
import { createClient, ScenarioAbort, BudgetExhausted } from './lib/client.mjs';
import { makeApi } from './lib/api.mjs';
import { createReport, RULES } from './lib/report.mjs';
import { snapshot, checkBalanceAgreement, checkConservation } from './lib/ledger.mjs';

import * as settlement from './scenarios/settlement.mjs';
import * as idempotency from './scenarios/idempotency.mjs';
import * as lifecycle from './scenarios/lifecycle.mjs';
import * as pagination from './scenarios/pagination.mjs';
import * as errors from './scenarios/errors.mjs';

const SCENARIOS = [settlement, idempotency, lifecycle, pagination, errors];

export default async function run({ client: injected, check, params }) {
  const started = Date.now();
  const SEED = params.seed ?? 'ledger-dev-seed';
  const MAX_REQUESTS = params.maxRequests ?? 350;
  const DEADLINE_MS = params.deadlineMs ?? 300000;

  const report = createReport();
  const client = createClient({ injected, report, maxRequests: MAX_REQUESTS });
  const api = makeApi(client, report);
  const scenarioLog = [];

  console.log(`minibank invariant suite -> ${injected.baseUrl} (seed "${SEED}")`);

  // ---- preflight: known state ---------------------------------------------
  report.enterScenario('preflight');
  let baselineTotal = 0;
  try {
    const health = await api.health();
    if (health.entry.transportError || health.entry.status !== 200 || health.body?.ok !== true) {
      report.setupFailure(
        'preflight',
        `GET /health did not answer {"ok":true}: ${health.entry.transportError ?? `${health.entry.status} ${health.entry.responseText.slice(0, 200)}`}`,
        [health.entry],
      );
    }
    await api.reset(SEED);
    const world = await api.listAccounts({ includeClosed: true });
    baselineTotal = world.items.reduce((acc, a) => acc + (Number.isInteger(a.balance) ? a.balance : 0), 0);
    const customers = world.items.filter((a) => a.kind !== 'system');
    if (baselineTotal !== 0 || customers.length) {
      report.warn(
        'reset did not produce an empty world',
        `after POST /admin/reset there are ${world.items.length} accounts (${customers.length} non-system) holding ${baselineTotal} in total; the suite accounts for this baseline`,
      );
    }
  } catch (err) {
    fatalSetup(report, 'preflight', err);
    return finish({ report, client, check, started, scenarioLog });
  }

  // ---- scenarios ------------------------------------------------------------
  let budgetGone = false;
  for (const scenario of SCENARIOS) {
    // Keep a reserve so the whole-world audit at the end always gets to run.
    if (budgetGone || client.count > MAX_REQUESTS - 40) {
      report.setupFailure(
        scenario.name,
        `skipped: ${client.count} of the ${MAX_REQUESTS}-request budget was already spent (a healthy run of the whole suite costs about 270)`,
        [],
      );
      scenarioLog.push({ name: scenario.name, ok: false });
      continue;
    }
    if (Date.now() - started > DEADLINE_MS) {
      report.setupFailure(scenario.name, `skipped: the suite passed its ${DEADLINE_MS}ms deadline`, []);
      scenarioLog.push({ name: scenario.name, ok: false });
      continue;
    }
    report.enterScenario(scenario.name);
    const before = client.count;
    const violationsBefore = report.violations.length + report.setupFailures.length;
    try {
      await scenario.run({ api, client, report, baselineTotal });
    } catch (err) {
      if (err instanceof BudgetExhausted) budgetGone = true;
      fatalSetup(report, scenario.name, err);
    }
    const failed = report.violations.length + report.setupFailures.length > violationsBefore;
    scenarioLog.push({ name: scenario.name, ok: !failed });
    console.log(`  ${scenario.name} … ${failed ? 'FAILED' : 'ok'} (${client.count - before} requests)`);
  }

  // ---- final whole-world arithmetic -----------------------------------------
  report.enterScenario('final-audit');
  const before = client.count;
  const violationsBefore = report.violations.length + report.setupFailures.length;
  try {
    const snap = await snapshot(api, report, 'end of run');
    checkBalanceAgreement(snap, report);
    const depositTotal = client.depositTotal(baselineTotal);
    if (depositTotal === undefined) {
      report.warn(
        'whole-world sum skipped',
        'a request went unanswered or a deposit was acknowledged with an unreadable body, so the suite cannot say how much money entered the ledger; per-account and per-transfer checks still ran',
      );
    }
    checkConservation(snap, report, { depositTotal, deposits: client.acceptedDeposits });
  } catch (err) {
    fatalSetup(report, 'final-audit', err);
  }
  const failed = report.violations.length + report.setupFailures.length > violationsBefore;
  scenarioLog.push({ name: 'final-audit', ok: !failed });
  console.log(`  final-audit … ${failed ? 'FAILED' : 'ok'} (${client.count - before} requests)`);

  return finish({ report, client, check, started, scenarioLog });
}

function fatalSetup(report, scenarioName, err) {
  if (err instanceof ScenarioAbort) {
    report.setupFailure(scenarioName, err.message, err.requests ?? []);
  } else {
    report.setupFailure(scenarioName, `the suite hit an unexpected error: ${err?.stack ?? err}`, []);
  }
}

function finish({ report, client, check, started, scenarioLog }) {
  report.finalize(check, { exercised: Object.keys(RULES) });
  console.log(
    `scenarios: ${scenarioLog.map((s) => `${s.name}${s.ok ? '' : ' (FAILED)'}`).join(', ')}\n` +
      `http requests: ${client.count}\nwall time: ${((Date.now() - started) / 1000).toFixed(2)}s\n` +
      `result: ${report.failed ? `FAIL — ${report.violations.length} violation(s), ${report.setupFailures.length} setup failure(s)` : 'PASS'}`,
  );
}
