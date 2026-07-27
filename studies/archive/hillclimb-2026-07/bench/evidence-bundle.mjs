import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDirectRun, parseArgs, requireArgs, runCli, writeText } from './lib/io.mjs';

const DOCUMENTS = [
  ['full-report', 'Study report', 'Study sources', 'source', 'report/REPORT.md', 'markdown'],
  ['primary-analysis', 'Primary analysis', 'Study sources', 'source', 'report/WRITEUP.md', 'markdown'],
  ['independent-read', 'Independent second read', 'Study sources', 'source', 'report/writeup-gpt56sol.md', 'markdown'],
  ['blindness-analysis', 'Blindness analysis', 'Study sources', 'source', 'report/blindness-analysis-gpt56sol.md', 'markdown'],
  ['spec', 'Clean app specification', 'Study sources', 'source', 'subject/SPEC.md', 'markdown'],
  ['fault-catalog', '26-fault catalog', 'Study sources', 'source', 'faults.json', 'json'],
  ['manifestation-tests', 'Manifestation tests', 'Study sources', 'source', 'tests/manifestation.test.js', 'javascript'],
  ['shakedown-01', 'Shakedown · round 1', 'Run ledgers', 'ledger', 'ledger/shakedown/round-01.json', 'json'],
  ['shakedown-02', 'Shakedown · round 2', 'Run ledgers', 'ledger', 'ledger/shakedown/round-02.json', 'json'],
  ['baseline-01', 'Baseline · round 1', 'Run ledgers', 'ledger', 'ledger/baseline/round-01.json', 'json'],
  ['baseline-02', 'Baseline · round 2', 'Run ledgers', 'ledger', 'ledger/baseline/round-02.json', 'json'],
  ['naive-01', 'Naive · round 1', 'Run ledgers', 'ledger', 'ledger/naive/round-01.json', 'json'],
  ['naive-02', 'Naive · round 2', 'Run ledgers', 'ledger', 'ledger/naive/round-02.json', 'json'],
  ['naive-03', 'Naive · round 3', 'Run ledgers', 'ledger', 'ledger/naive/round-03.json', 'json'],
  ['policy-01', 'Policy · round 1', 'Run ledgers', 'ledger', 'ledger/policy/round-01.json', 'json'],
  ['policy-02', 'Policy · round 2', 'Run ledgers', 'ledger', 'ledger/policy/round-02.json', 'json'],
  ['policy-03', 'Policy · round 3', 'Run ledgers', 'ledger', 'ledger/policy/round-03.json', 'json'],
  ['accepted-fixes', 'Accepted policy fixes', 'Repairs and stories', 'source', 'arms/policy-workspace/fixes-r1.json', 'json'],
  ['policy-plan', 'Policy verification plan', 'Repairs and stories', 'source', 'arms/policy-workspace/PLAN-r1.md', 'markdown'],
  ['regression-suite', 'Pinned regression suite', 'Repairs and stories', 'source', 'arms/policy-regression/playtest.yaml', 'yaml'],
  ['empty-cart-story', 'Empty cart and back link', 'Repairs and stories', 'source', 'arms/policy-regression/stories/empty-cart-and-back-link.yaml', 'yaml'],
  ['warm-empty-states', 'Warm empty states', 'Repairs and stories', 'source', 'arms/policy-regression/stories/empty-states-are-warm.yaml', 'yaml'],
  ['checkout-story', 'Baseline checkout hiccup', 'Repairs and stories', 'source', 'suite/checkout-hiccup.yaml', 'yaml'],
  ['checkout-recovery', 'Checkout recovery regression', 'Repairs and stories', 'source', 'arms/policy-regression/stories/checkout-recovery.yaml', 'yaml']
];

export function buildEvidenceBundle({ studyDir, outFile }) {
  const documents = Object.fromEntries(DOCUMENTS.map(([id, title, group, kind, relativePath, language]) => {
    const raw = readFileSync(path.join(studyDir, relativePath), 'utf8');
    return [id, {
      id,
      title,
      group,
      kind,
      language,
      source: `studies/hillclimb/${relativePath}`,
      content: kind === 'ledger' ? JSON.parse(raw) : raw
    }];
  }));

  writeText(outFile, `window.HILLCLIMB_EVIDENCE = ${JSON.stringify({ documents })};\n`);
  return { ok: true, documents: DOCUMENTS.length, outFile };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  requireArgs(args, ['study-dir', 'out']);
  const result = buildEvidenceBundle({ studyDir: args['study-dir'], outFile: args.out });
  console.log(`${result.outFile}: ${result.documents} evidence documents`);
  return result;
}

if (isDirectRun(import.meta.url)) {
  runCli(main);
}
