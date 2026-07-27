import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  isDirectRun,
  parseArgs,
  readJson,
  requireArgs,
  runCli
} from './lib/io.mjs';
import { loadLedgerEntries } from './matrix.mjs';

const USAGE = `Usage: node studies/hillclimb/bench/lint-evidence.mjs --ledger-dir <dir> --runs-root <dir> [--repo <dir>]

Checks that every ledger run, cited step artifact, fix commit, regression story, and fault_id resolves.`;

function stepName(step) {
  return `${String(step).padStart(3, '0')}.png`;
}

function runDir(runsRoot, run) {
  return path.join(runsRoot, run.run_id, run.case_id);
}

function findRunForFinding(ledger, findingId) {
  return (ledger.runs ?? []).find((run) => findingId.startsWith(`${run.run_id}/${run.case_id}#`)) ?? null;
}

function defaultGitExists(repo, sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function findFaultsFile(ledgerDir, repo) {
  const candidates = [
    path.join(repo, 'studies/hillclimb/faults.json'),
    path.join(path.dirname(ledgerDir), 'faults.json'),
    path.join(path.dirname(path.dirname(ledgerDir)), 'faults.json')
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function actualStepsForRun(runsRoot, run) {
  const manifest = path.join(runDir(runsRoot, run), 'manifest.json');
  if (!existsSync(manifest)) return run.steps;
  return Number(readJson(manifest).totals?.steps ?? run.steps);
}

function checkStep(errors, ledger, runsRoot, finding, step) {
  const run = findRunForFinding(ledger, finding.finding_id);
  if (!run) {
    errors.push(`${ledger.arm} round ${ledger.round} ${finding.finding_id}: no matching run record`);
    return;
  }
  const maxSteps = actualStepsForRun(runsRoot, run);
  if (step > maxSteps) {
    errors.push(`${ledger.arm} round ${ledger.round} ${finding.finding_id}: step ${step} exceeds totals.steps ${maxSteps}`);
  }
  const png = path.join(runDir(runsRoot, run), 'steps', stepName(step));
  if (!existsSync(png)) {
    errors.push(`${ledger.arm} round ${ledger.round} ${finding.finding_id}: missing ${png}`);
  }
}

export function lintEvidence(options, deps = {}) {
  const repo = options.repo ?? process.cwd();
  const gitExists = deps.gitExists ?? ((sha) => defaultGitExists(repo, sha));
  const errors = [];
  const ledgerEntries = options.ledgers
    ? options.ledgers.map((entry) => ({ file: '<memory>', entry }))
    : loadLedgerEntries(options.ledgerDir);

  const faultsFile = findFaultsFile(options.ledgerDir ?? '', repo);
  const faultIds = faultsFile ? new Set((readJson(faultsFile).faults ?? []).map((fault) => fault.id)) : null;

  for (const { entry: ledger } of ledgerEntries) {
    for (const run of ledger.runs ?? []) {
      const manifest = path.join(runDir(options.runsRoot, run), 'manifest.json');
      if (!existsSync(manifest)) {
        errors.push(`${ledger.arm} round ${ledger.round} ${run.run_id}/${run.case_id}: missing manifest.json`);
      }
    }

    for (const finding of ledger.findings ?? []) {
      if (Number.isInteger(finding.step)) checkStep(errors, ledger, options.runsRoot, finding, finding.step);
      for (const step of finding.evidence_steps ?? []) {
        checkStep(errors, ledger, options.runsRoot, finding, step);
      }
    }

    for (const fix of ledger.fixes ?? []) {
      if (!gitExists(fix.commit)) {
        errors.push(`${ledger.arm} round ${ledger.round} fix ${fix.commit}: commit not found`);
      }
      const story = path.isAbsolute(fix.regression_story)
        ? fix.regression_story
        : path.join(repo, fix.regression_story);
      if (!existsSync(story)) {
        errors.push(`${ledger.arm} round ${ledger.round} fix ${fix.commit}: missing regression story ${fix.regression_story}`);
      }
    }

    if (faultIds) {
      for (const judgment of ledger.adjudication ?? []) {
        if (judgment.fault_id && !faultIds.has(judgment.fault_id)) {
          errors.push(`${ledger.arm} round ${ledger.round} ${judgment.finding_id}: unknown fault_id ${judgment.fault_id}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return { ok: true };
  }
  requireArgs(args, ['ledger-dir', 'runs-root']);

  const result = lintEvidence({
    ledgerDir: args['ledger-dir'],
    runsRoot: args['runs-root'],
    repo: args.repo ?? process.cwd()
  }, deps);
  for (const error of result.errors) console.error(error);
  if (!result.ok) process.exitCode = 1;
  else console.log('lint-evidence: OK');
  return result;
}

if (isDirectRun(import.meta.url)) {
  runCli(main);
}
