#!/usr/bin/env node
// Minibank ledger — invariant falsification suite.
//
//   BASE_URL=http://127.0.0.1:4181 node suite/run.mjs
//
// Exit 0: all six invariants held against every state the suite reached.
// Exit 1: an invariant broke, or the suite could not build the state it needed.
// Exit 2: the suite itself crashed (should not happen; reported as a defect).
//
// Environment:
//   BASE_URL     service under test (default http://127.0.0.1:4181)
//   SEED         reset seed (default ledger-dev-seed)
//   TIMEOUT_MS   per-request timeout (default 8000)
//   DEADLINE_MS  give up starting new scenarios after this (default 300000)
//   VERBOSE      1 to dump every request/response at the end

import { createClient, ScenarioAbort, BudgetExhausted } from './lib/client.mjs';
import { makeApi } from './lib/api.mjs';
import { createReport, printReport, renderRequest } from './lib/report.mjs';
import { snapshot, checkBalanceAgreement, checkConservation } from './lib/ledger.mjs';

import * as settlement from './scenarios/settlement.mjs';
import * as idempotency from './scenarios/idempotency.mjs';
import * as lifecycle from './scenarios/lifecycle.mjs';
import * as pagination from './scenarios/pagination.mjs';
import * as errors from './scenarios/errors.mjs';

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:4181').replace(/\/+$/, '');
const SEED = process.env.SEED || 'ledger-dev-seed';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 8000);
const DEADLINE_MS = Number(process.env.DEADLINE_MS || 300000);
const MAX_REQUESTS = Number(process.env.MAX_REQUESTS || 350); // hard ceiling; a healthy run uses ~266

const SCENARIOS = [settlement, idempotency, lifecycle, pagination, errors];

async function main() {
  const started = Date.now();
  const report = createReport();
  const client = createClient({ baseUrl: BASE_URL, report, timeoutMs: TIMEOUT_MS, maxRequests: MAX_REQUESTS });
  const api = makeApi(client, report);
  const scenarioLog = [];

  console.log(`minibank invariant suite -> ${BASE_URL} (seed "${SEED}")`);

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
    return finish({ report, client, started, scenarioLog });
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
    process.stdout.write(`  ${scenario.name} … `);
    try {
      await scenario.run({ api, client, report, baselineTotal });
    } catch (err) {
      if (err instanceof BudgetExhausted) budgetGone = true;
      fatalSetup(report, scenario.name, err);
    }
    const failed = report.violations.length + report.setupFailures.length > violationsBefore;
    scenarioLog.push({ name: scenario.name, ok: !failed });
    console.log(`${failed ? 'FAILED' : 'ok'} (${client.count - before} requests)`);
  }

  // ---- final whole-world arithmetic -----------------------------------------
  report.enterScenario('final-audit');
  process.stdout.write('  final-audit … ');
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
  console.log(`${failed ? 'FAILED' : 'ok'} (${client.count - before} requests)`);

  return finish({ report, client, started, scenarioLog });
}

function fatalSetup(report, scenarioName, err) {
  if (err instanceof ScenarioAbort) {
    report.setupFailure(scenarioName, err.message, err.requests ?? []);
  } else {
    report.setupFailure(scenarioName, `the suite hit an unexpected error: ${err?.stack ?? err}`, []);
  }
}

function finish({ report, client, started, scenarioLog }) {
  const elapsedMs = Date.now() - started;
  printReport(report, { requestCount: client.count, elapsedMs, baseUrl: BASE_URL, scenarioLog, log: client.log });
  if (process.env.VERBOSE === '1') {
    console.log('\n---------------- full request log ----------------');
    for (const entry of client.log) console.log(renderRequest(entry, { bodyMax: 200 }));
  }
  return report.failed ? 1 : 0;
}

process.on('unhandledRejection', (err) => {
  console.error('suite crashed (unhandled rejection):', err);
  process.exit(2);
});

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('suite crashed:', err?.stack ?? err);
    process.exit(2);
  });
