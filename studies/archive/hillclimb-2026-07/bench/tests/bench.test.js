import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLedgerEntry } from '../adjudicate.mjs';
import { collectRuns } from '../collect.mjs';
import { lintEvidence } from '../lint-evidence.mjs';
import { buildMatrix } from '../matrix.mjs';
import { checkFaultSet, parseModelsFromYaml, runPreflight, scanUsageLimitLog } from '../preflight.mjs';
import { buildSite } from '../site.mjs';
import {
  cleanDefinitionForArm,
  computeCleanRound,
  countAdjudicationLabels,
  loadLedgerSchema,
  parseAdjudicationLabel,
  validateLedgerEntry
} from '../lib/contracts.mjs';
import { hashDir } from '../lib/hash.mjs';
import { readJson, writeJson } from '../lib/io.mjs';
import { validateSchema } from '../lib/schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const runsRoot = path.join(fixtures, 'run-artifacts');
const faults = readJson(path.join(fixtures, 'faults.json'));

function tmpdir() {
  return mkdtempSync(path.join(os.tmpdir(), 'hillclimb-bench-'));
}

function fingerprint() {
  return {
    captured_at: '2026-07-10T00:00:00.000Z',
    repo_head: 'abc123',
    repo_dirty: false,
    app_dir: 'studies/hillclimb/arms/naive',
    fault_set: { ids: ['f-dead-add-cart'], app_hash: 'hash' },
    gateway: { base_url: 'http://127.0.0.1:8900', healthz_ok: true, usage_limit_hits: 0 },
    models: { actor_model: 'gpt5_4_mini', grader_model: 'gpt5_5' }
  };
}

function instrument() {
  return {
    suite: 'studies/hillclimb',
    stories: ['stories/buy-gift.yaml'],
    personas: ['gift-rusher', 'careful-buyer'],
    repeats: 2
  };
}

function collectedFixture() {
  return collectRuns({ runsRoot, runIds: ['run-a', 'run-b'] }).data;
}

function roundOneLedger(overrides = {}) {
  const collected = collectedFixture();
  const judgments = [
    {
      finding_id: 'run-a/shop/buy-gift@gift-rusher#f0',
      verdict: 'true-positive',
      fault_id: 'f-dead-add-cart',
      rationale: 'The control did not update the cart.'
    },
    {
      finding_id: 'run-a/shop/buy-gift@gift-rusher#f1',
      verdict: 'false-positive',
      rationale: 'The copy is confusing but still accurate.'
    },
    {
      finding_id: 'run-a/shop/buy-gift@gift-rusher#q0',
      verdict: 'duplicate-of',
      duplicate_of: 'run-a/shop/buy-gift@gift-rusher#f0',
      rationale: 'The report answer repeats the cart failure.'
    },
    {
      finding_id: 'run-b/checkout@careful-buyer#f0',
      verdict: 'false-positive',
      rationale: 'The confirmation copy is acceptable.'
    }
  ];

  return buildLedgerEntry({
    arm: 'naive',
    round: 1,
    collected,
    fingerprint: fingerprint(),
    judgments,
    judgmentsProvided: true,
    fixes: [
      {
        commit: 'commit-add-cart',
        finding_ids: ['run-a/shop/buy-gift@gift-rusher#f0'],
        fault_id: 'f-dead-add-cart',
        description: 'Reconnect add-to-cart handler.',
        regression_story: 'stories/regression/r-cart.yaml'
      }
    ],
    verification: { regression_green: false, regression_run_ids: [] },
    instrument: instrument(),
    ...overrides
  });
}

function roundTwoLedger(overrides = {}) {
  const collected = {
    runs: [
      {
        run_id: 'run-c',
        case_id: 'checkout@careful-buyer',
        persona: 'careful-buyer',
        status: 'explored',
        end_reason: 'done',
        steps: 2,
        tokens: { in: 1, out: 1, cache_read: 0 },
        cost_usd: 0.2,
        grade_score: 70
      }
    ],
    findings: [
      {
        finding_id: 'run-c/checkout@careful-buyer#f0',
        source: 'finding',
        severity: 'major',
        note: 'Checkout sends the user to the wrong page.',
        step: 2,
        evidence: '?run=run-c/checkout@careful-buyer&step=2'
      }
    ]
  };
  return buildLedgerEntry({
    arm: 'naive',
    round: 2,
    collected,
    fingerprint: fingerprint(),
    judgments: [
      {
        finding_id: 'run-c/checkout@careful-buyer#f0',
        verdict: 'true-positive',
        fault_id: 'f-checkout-route',
        rationale: 'The checkout route redirects incorrectly.'
      }
    ],
    judgmentsProvided: true,
    fixes: [],
    verification: { regression_green: false, regression_run_ids: [] },
    instrument: instrument(),
    ...overrides
  });
}

test('collect normalizes fixture runs exactly', () => {
  assert.deepEqual(collectedFixture(), {
    runs: [
      {
        run_id: 'run-a',
        case_id: 'shop/buy-gift@gift-rusher',
        persona: 'gift-rusher',
        status: 'explored',
        end_reason: 'done',
        steps: 3,
        tokens: { in: 10, out: 20, cache_read: 3 },
        cost_usd: 0.12,
        grade_score: 62
      },
      {
        run_id: 'run-b',
        case_id: 'checkout@careful-buyer',
        persona: 'careful-buyer',
        status: 'pass',
        end_reason: 'done',
        steps: 2,
        tokens: { in: 5, out: 7, cache_read: 1 },
        cost_usd: 0.08,
        grade_score: 88
      }
    ],
    findings: [
      {
        finding_id: 'run-a/shop/buy-gift@gift-rusher#f0',
        source: 'finding',
        severity: 'major',
        note: 'Add to cart did not change the cart.',
        step: 2,
        evidence: '?run=run-a/shop/buy-gift@gift-rusher&step=2'
      },
      {
        finding_id: 'run-a/shop/buy-gift@gift-rusher#f1',
        source: 'finding',
        severity: 'minor',
        note: 'The help text was confusing.'
      },
      {
        finding_id: 'run-a/shop/buy-gift@gift-rusher#q0',
        source: 'report',
        question: 'Could the user reach checkout?',
        answer: 'No, the cart never updated.',
        evidence_steps: [1, 3]
      },
      {
        finding_id: 'run-b/checkout@careful-buyer#f0',
        source: 'finding',
        severity: 'minor',
        note: 'The order confirmation copy was vague.',
        step: 1,
        evidence: '?run=run-b/checkout@careful-buyer&step=1'
      }
    ]
  });
});

test('adjudicate builds valid entries and computes clean_round', () => {
  const dirty = roundOneLedger();
  assert.equal(validateLedgerEntry(dirty).ok, true);
  assert.equal(dirty.clean_round, false);

  const clean = buildLedgerEntry({
    arm: 'naive',
    round: 2,
    collected: collectedFixture(),
    fingerprint: fingerprint(),
    judgments: collectedFixture().findings.map((finding) => ({
      finding_id: finding.finding_id,
      verdict: 'false-positive',
      rationale: 'Adjudicated noise.'
    })),
    judgmentsProvided: true,
    fixes: [],
    verification: { regression_green: true, regression_run_ids: ['reg-1'] },
    instrument: instrument()
  });
  assert.equal(clean.clean_round, true);
});

test('P3 clean definition: v2 blocks emergent; v1 arms do not (legacy frozen)', () => {
  assert.equal(cleanDefinitionForArm('naive'), 'v1');
  assert.equal(cleanDefinitionForArm('v2-baseline'), 'v2');
  assert.equal(cleanDefinitionForArm('v2-policy'), 'v2');

  const adjudication = [
    { finding_id: 'a#f0', verdict: 'emergent', rationale: '[emergent] Fix broke cart toast.' },
    { finding_id: 'a#f1', verdict: 'false-positive', rationale: '[soft-ux] Below fold.' }
  ];
  const verification = { regression_green: true, regression_run_ids: ['reg-1'] };

  assert.equal(computeCleanRound(adjudication, verification, { definition: 'v1' }), true);
  assert.equal(computeCleanRound(adjudication, verification, { definition: 'v2' }), false);
  assert.equal(computeCleanRound(adjudication, verification, { arm: 'naive' }), true);
  assert.equal(computeCleanRound(adjudication, verification, { arm: 'v2-baseline' }), false);

  const collected = {
    runs: [{
      run_id: 'run-e',
      case_id: 'shop@gift-rusher',
      persona: 'gift-rusher',
      status: 'explored',
      end_reason: 'done',
      steps: 1,
      tokens: { in: 1, out: 1, cache_read: 0 },
      cost_usd: 0.01,
      grade_score: 50
    }],
    findings: [
      {
        finding_id: 'run-e/shop@gift-rusher#f0',
        source: 'finding',
        severity: 'major',
        note: 'Toast target vanished.'
      },
      {
        finding_id: 'run-e/shop@gift-rusher#f1',
        source: 'finding',
        severity: 'minor',
        note: 'CTA low on page.'
      }
    ]
  };
  const judgments = [
    {
      finding_id: 'run-e/shop@gift-rusher#f0',
      verdict: 'emergent',
      rationale: '[emergent] Fix-induced toast miss.'
    },
    {
      finding_id: 'run-e/shop@gift-rusher#f1',
      verdict: 'false-positive',
      rationale: '[soft-ux] Prominence only.'
    }
  ];

  const legacy = buildLedgerEntry({
    arm: 'naive',
    round: 9,
    collected,
    fingerprint: fingerprint(),
    judgments,
    judgmentsProvided: true,
    fixes: [],
    verification,
    instrument: instrument()
  });
  assert.equal(legacy.clean_round, true);
  assert.equal(validateLedgerEntry(legacy).ok, true);

  const v2 = buildLedgerEntry({
    arm: 'v2-baseline',
    round: 9,
    collected,
    fingerprint: fingerprint(),
    judgments,
    judgmentsProvided: true,
    fixes: [],
    verification,
    instrument: instrument()
  });
  assert.equal(v2.clean_round, false);
  assert.equal(validateLedgerEntry(v2).ok, true);

  const labels = countAdjudicationLabels(judgments);
  assert.equal(labels.emergent, 1);
  assert.equal(labels['soft-ux'], 1);
  assert.equal(parseAdjudicationLabel(judgments[0]), 'emergent');
  assert.equal(parseAdjudicationLabel({ verdict: 'true-positive', fault_id: 'f-x', rationale: 'x' }), 'seeded-tp');
});

test('adjudicate rejects missing judgments and invalid duplicate judgments', () => {
  const collected = collectedFixture();
  assert.throws(() => buildLedgerEntry({
    arm: 'naive',
    round: 1,
    collected,
    fingerprint: fingerprint(),
    judgments: [],
    judgmentsProvided: true,
    fixes: [],
    verification: { regression_green: false, regression_run_ids: [] },
    instrument: instrument()
  }), /missing judgment/);

  assert.throws(() => buildLedgerEntry({
    arm: 'naive',
    round: 1,
    collected,
    fingerprint: fingerprint(),
    judgments: collected.findings.map((finding, index) => ({
      finding_id: finding.finding_id,
      verdict: index === 0 ? 'duplicate-of' : 'false-positive',
      rationale: 'Needs a rationale.'
    })),
    judgmentsProvided: true,
    fixes: [],
    verification: { regression_green: false, regression_run_ids: [] },
    instrument: instrument()
  }), /duplicate_of/);
});

test('schema validator and ledger cross-rules return path-bearing errors', () => {
  const schema = loadLedgerSchema();
  const valid = roundOneLedger();
  assert.equal(validateSchema(schema, valid).ok, true);
  assert.equal(validateLedgerEntry(valid).ok, true);

  const unknown = { ...valid, extra: true };
  assert.match(validateSchema(schema, unknown).errors.join('\n'), /\$\.extra/);

  const missingRationale = structuredClone(valid);
  missingRationale.adjudication[0].rationale = '';
  assert.match(validateLedgerEntry(missingRationale).errors.join('\n'), /\$\.adjudication\[0\]\.rationale/);

  const missingAdjudication = structuredClone(valid);
  missingAdjudication.adjudication = missingAdjudication.adjudication.slice(1);
  assert.match(validateLedgerEntry(missingAdjudication).errors.join('\n'), /\$\.findings\[0\]\.finding_id/);

  const wrongClean = structuredClone(valid);
  wrongClean.clean_round = true;
  assert.match(validateLedgerEntry(wrongClean).errors.join('\n'), /\$\.clean_round/);
});

test('matrix computes masking-aware recall, precision, accounting, and accepted-fix validation', () => {
  const round1 = roundOneLedger();
  const round2 = roundTwoLedger();
  const matrix = buildMatrix({
    ledgers: [
      { file: 'round-01.json', entry: round1 },
      { file: 'round-02.json', entry: round2 }
    ],
    faults
  });

  assert.equal(matrix.by_arm.naive.rounds[0].recall_by_level.L3.reachable_total, 0);
  assert.equal(matrix.by_arm.naive.rounds[1].recall_by_level.L3.reachable_total, 1);
  assert.equal(matrix.by_arm.naive.rounds[1].recall_by_level.L3.reachable_found, 1);
  assert.equal(matrix.by_arm.naive.rounds[0].precision.true_positives, 1);
  assert.equal(matrix.by_arm.naive.rounds[0].precision.adjudicated_non_duplicates, 3);
  assert.equal(matrix.accounting.naive.find((row) => row.fault_id === 'f-dead-add-cart').status, 'found-and-fixed');
  assert.equal(matrix.detection_matrix['f-dead-add-cart']['gift-rusher'], 1);
  assert.equal(matrix.by_arm.naive.clean_definition, 'v1');
  assert.equal(matrix.by_arm.naive.accounting_summary.detected, 2);
  assert.equal(matrix.by_arm.naive.accounting_summary.found_and_fixed, 1);
  assert.equal(matrix.by_arm.naive.rounds[0].label_counts['seeded-tp'], 1);

  // Fix with no TP in-arm → fixed-without-detection (P3 accounting split).
  const inspectionOnly = buildLedgerEntry({
    arm: 'policy',
    round: 1,
    collected: {
      runs: [{
        run_id: 'run-p',
        case_id: 'probe@careful-buyer',
        persona: 'careful-buyer',
        status: 'explored',
        end_reason: 'done',
        steps: 1,
        tokens: { in: 1, out: 1, cache_read: 0 },
        cost_usd: 0.05,
        grade_score: 60
      }],
      findings: [{
        finding_id: 'run-p/probe@careful-buyer#f0',
        source: 'finding',
        severity: 'minor',
        note: 'Soft layout note.'
      }]
    },
    fingerprint: fingerprint(),
    judgments: [{
      finding_id: 'run-p/probe@careful-buyer#f0',
      verdict: 'false-positive',
      rationale: '[spec-gap] Real but out of SPEC.'
    }],
    judgmentsProvided: true,
    fixes: [{
      commit: 'commit-class-gen',
      finding_ids: [],
      fault_id: 'f-dead-add-cart',
      description: 'Class-generalized cart reconnect from neighboring code.',
      regression_story: 'stories/regression/r-cart.yaml'
    }],
    verification: { regression_green: true, regression_run_ids: ['reg-p'] },
    instrument: instrument()
  });
  const matrixInspection = buildMatrix({
    ledgers: [{ file: 'policy-01.json', entry: inspectionOnly }],
    faults
  });
  assert.equal(
    matrixInspection.accounting.policy.find((row) => row.fault_id === 'f-dead-add-cart').status,
    'fixed-without-detection'
  );
  assert.equal(matrixInspection.by_arm.policy.accounting_summary.fixed_without_detection, 1);
  assert.equal(matrixInspection.by_arm.policy.accounting_summary.detected, 0);
  assert.equal(matrixInspection.by_arm.policy.accounting_summary.label_counts['spec-gap'], 1);
  assert.equal(matrixInspection.by_arm.policy.clean_definition, 'v1');

  const invalidAccepted = roundTwoLedger({
    fixes: [
      {
        commit: 'commit-accepted-l3',
        finding_ids: ['run-c/checkout@careful-buyer#f0'],
        fault_id: 'f-checkout-route',
        description: 'ACCEPTED: leave this behavior as-is.',
        regression_story: 'stories/regression/r-checkout.yaml'
      }
    ]
  });
  assert.throws(() => buildMatrix({
    ledgers: [{ file: 'round-02.json', entry: invalidAccepted }],
    faults
  }), /ACCEPTED is only valid/);
});

test('lint-evidence passes fixtures and fails dangling step evidence', () => {
  const repo = tmpdir();
  const ledgerDir = path.join(repo, 'studies/hillclimb/ledger');
  mkdirSync(path.join(repo, 'studies/hillclimb'), { recursive: true });
  mkdirSync(path.join(repo, 'stories/regression'), { recursive: true });
  writeFileSync(path.join(repo, 'stories/regression/r-cart.yaml'), 'name: cart\n');
  writeJson(path.join(repo, 'studies/hillclimb/faults.json'), faults);

  const green = lintEvidence({
    ledgers: [roundOneLedger()],
    ledgerDir,
    runsRoot,
    repo
  }, {
    gitExists: (sha) => sha === 'commit-add-cart'
  });
  assert.deepEqual(green, { ok: true, errors: [] });

  const broken = structuredClone(roundOneLedger());
  broken.findings[0].step = 9;
  const red = lintEvidence({
    ledgers: [broken],
    ledgerDir,
    runsRoot,
    repo
  }, {
    gitExists: () => true
  });
  assert.equal(red.ok, false);
  assert.match(red.errors.join('\n'), /step 9 exceeds totals\.steps 3/);
});

test('site builds report files and copies only cited step screenshots', () => {
  const outDir = tmpdir();
  buildSite({
    ledgers: [roundOneLedger()],
    faults,
    runsRoot,
    outDir
  });

  assert.equal(existsSync(path.join(outDir, 'index.html')), true);
  assert.equal(existsSync(path.join(outDir, 'matrix.html')), true);
  assert.equal(existsSync(path.join(outDir, 'accounting.html')), true);
  assert.equal(existsSync(path.join(outDir, 'rounds/naive-01.html')), true);
  assert.match(readFileSync(path.join(outDir, 'index.html'), 'utf8'), /Study narrative stub/);
  assert.match(readFileSync(path.join(outDir, 'matrix.html'), 'utf8'), /Detection matrix/);
  assert.match(readFileSync(path.join(outDir, 'accounting.html'), 'utf8'), /fixed without detection/);
  assert.match(readFileSync(path.join(outDir, 'accounting.html'), 'utf8'), /clean definition v1/);

  const assets = readdirSync(path.join(outDir, 'assets')).sort();
  assert.deepEqual(assets, [
    'run-a-shop_buy-gift@gift-rusher-002.png',
    'run-b-checkout@careful-buyer-001.png'
  ]);
});

test('preflight pure helpers and injected fetch path are deterministic', async () => {
  const dir = tmpdir();
  const appDir = path.join(dir, 'app');
  mkdirSync(appDir);
  writeFileSync(path.join(appDir, 'a.txt'), 'a');
  const hashA = hashDir(appDir);
  writeJson(path.join(appDir, '.fault-set.json'), { ids: ['f-a'], app_hash: hashA });
  assert.deepEqual(checkFaultSet(appDir), {
    ok: true,
    fault_set: { ids: ['f-a'], app_hash: hashA },
    error: null
  });

  const log = path.join(dir, 'gateway.log');
  writeFileSync(log, 'usage limit\nok\nUsage Limit\n');
  assert.equal(scanUsageLimitLog(log), 2);
  assert.deepEqual(parseModelsFromYaml('actor_model: gpt5_4_mini\ngrader_model: "gpt5_5"\n'), {
    actor_model: 'gpt5_4_mini',
    grader_model: 'gpt5_5'
  });

  mkdirSync(path.join(dir, 'studies/hillclimb'), { recursive: true });
  mkdirSync(path.join(dir, 'studies/hillclimb/suite'), { recursive: true });
  writeFileSync(path.join(dir, 'studies/hillclimb/suite/playtest.yaml'), 'actor_model: gpt5_4_mini\ngrader_model: gpt5_5\n');
  const fakeFetch = async (url, options) => ({
    status: options.method === 'POST' ? 204 : 200,
    async json() {
      return url.endsWith('/healthz') ? { ok: true } : {};
    }
  });
  const result = await runPreflight({
    appDir,
    baseUrl: 'http://subject.test',
    gateway: 'http://gateway.test',
    gatewayLog: log,
    resetPath: '/api/reset'
  }, {
    fetch: fakeFetch,
    cwd: dir,
    now: () => new Date('2026-07-10T00:00:00.000Z'),
    execFileSync: (bin, args) => {
      if (bin === 'pgrep') { const e = new Error('no match'); e.status = 1; throw e; }
      if (args[0] === 'rev-parse') return 'abc123\n';
      if (args[0] === 'status') return '';
      throw new Error(`unexpected git args ${args.join(' ')}`);
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.fingerprint.gateway.usage_limit_hits, 2);
  assert.equal(result.fingerprint.models.actor_model, 'gpt5_4_mini');
  assert.equal(result.fingerprint.checks.find((c) => c.name === 'exclusive-run').ok, true);

  const busy = await runPreflight({
    arm: 'baseline',
    round: 1,
    appDir: path.join(dir, 'app'),
    baseUrl: 'http://127.0.0.1:9',
    gatewayLog: log
  }, {
    fetch: fakeFetch,
    cwd: dir,
    now: () => new Date('2026-07-10T00:00:00.000Z'),
    execFileSync: (bin, args) => {
      if (bin === 'pgrep') return '11111\n22222\n';
      if (args[0] === 'rev-parse') return 'abc123\n';
      if (args[0] === 'status') return '';
      throw new Error(`unexpected git args ${args.join(' ')}`);
    }
  });
  assert.equal(busy.ok, false);
  assert.match(busy.errors.join(' '), /live playtest run process/);
});

test('hashDir matches the injector hashTree on a real injection (caught live 2026-07-10)', async () => {
  const { inject, hashTree } = await import('../../inject-faults.mjs');
  const studyRoot = path.join(here, '..', '..');
  const outDir = path.join(tmpdir(), 'arm');
  const manifest = inject({
    subjectDir: path.join(studyRoot, 'subject'),
    faultsFile: path.join(studyRoot, 'faults.json'),
    outDir
  });
  assert.equal(hashDir(outDir), manifest.app_hash);
  assert.equal(hashDir(outDir), hashTree(outDir));
});

test.after(() => {
  for (const entry of readdirSync(os.tmpdir())) {
    if (entry.startsWith('hillclimb-bench-')) {
      rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
    }
  }
});
