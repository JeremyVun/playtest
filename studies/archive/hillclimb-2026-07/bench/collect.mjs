import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  isDirectRun,
  parseArgs,
  readJson,
  requireArgs,
  runCli,
  walkDirs,
  writeJson
} from './lib/io.mjs';

const USAGE = `Usage: node studies/hillclimb/bench/collect.mjs --runs-root <dir> --run <run-id> [--run <id>...] --out <collected.json>

Collects manifest.json and grade.json artifacts into normalized ledger-ready runs and findings.`;

function asTokens(tokens = {}) {
  return {
    in: Number(tokens.in ?? 0),
    out: Number(tokens.out ?? 0),
    cache_read: Number(tokens.cache_read ?? 0)
  };
}

function runRecordFromManifest(manifest) {
  return {
    run_id: String(manifest.run_id),
    case_id: String(manifest.case?.id ?? ''),
    persona: String(manifest.case?.persona ?? ''),
    status: String(manifest.result?.status ?? ''),
    end_reason: manifest.result?.end_reason ?? null,
    steps: Number(manifest.totals?.steps ?? 0),
    tokens: asTokens(manifest.totals?.tokens),
    cost_usd: Number(manifest.totals?.cost_usd ?? 0),
    grade_score: null
  };
}

function evidenceLink(runId, caseId, step) {
  return `?run=${runId}/${caseId}&step=${step}`;
}

function normalizeGradeFindings(run, grade) {
  const findings = [];

  for (const [index, finding] of (grade.findings ?? []).entries()) {
    const normalized = {
      finding_id: `${run.run_id}/${run.case_id}#f${index}`,
      source: 'finding',
      severity: finding.severity,
      note: finding.note
    };
    if (Number.isInteger(finding.step)) {
      normalized.step = finding.step;
      normalized.evidence = evidenceLink(run.run_id, run.case_id, finding.step);
    }
    findings.push(normalized);
  }

  for (const [index, report] of (grade.report ?? []).entries()) {
    const normalized = {
      finding_id: `${run.run_id}/${run.case_id}#q${index}`,
      source: 'report',
      question: report.question,
      answer: report.answer
    };
    if (Array.isArray(report.evidence_steps)) {
      normalized.evidence_steps = [...report.evidence_steps].sort((a, b) => a - b);
    }
    findings.push(normalized);
  }

  return findings;
}

function sortOutput(data) {
  data.runs.sort((a, b) => (
    a.run_id.localeCompare(b.run_id) ||
    a.case_id.localeCompare(b.case_id)
  ));
  data.findings.sort((a, b) => (
    a.finding_id.localeCompare(b.finding_id)
  ));
  return data;
}

export function collectRuns(options, deps = {}) {
  const warnings = [];
  const warn = deps.warn ?? ((message) => warnings.push(message));
  const data = { runs: [], findings: [] };

  for (const runId of options.runIds) {
    const runRoot = path.join(options.runsRoot, runId);
    if (!existsSync(runRoot)) throw new Error(`run directory not found: ${runRoot}`);
    const manifestDirs = walkDirs(runRoot).filter((dir) => existsSync(path.join(dir, 'manifest.json')));

    for (const dir of manifestDirs) {
      const manifest = readJson(path.join(dir, 'manifest.json'));
      const run = runRecordFromManifest(manifest);
      const gradeFile = path.join(dir, 'grade.json');
      if (existsSync(gradeFile)) {
        const grade = readJson(gradeFile);
        run.grade_score = typeof grade.score === 'number' ? grade.score : null;
        data.findings.push(...normalizeGradeFindings(run, grade));
      } else {
        warn(`missing grade.json for ${run.run_id}/${run.case_id}`);
      }
      data.runs.push(run);
    }
  }

  return { data: sortOutput(data), warnings };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv, { repeatable: ['run'] });
  if (args.help) {
    console.log(USAGE);
    return { ok: true };
  }
  requireArgs(args, ['runs-root', 'run', 'out']);

  const runIds = Array.isArray(args.run) ? args.run : [args.run];
  const result = collectRuns({ runsRoot: args['runs-root'], runIds }, deps);
  for (const warning of result.warnings) console.error(`warning: ${warning}`);
  writeJson(args.out, result.data);
  console.log(`${args.out}: wrote ${result.data.runs.length} runs and ${result.data.findings.length} findings`);
  return result;
}

if (isDirectRun(import.meta.url)) {
  runCli(main);
}
