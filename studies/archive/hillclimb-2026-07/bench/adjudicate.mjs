import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  isDirectRun,
  parseArgs,
  readJson,
  readJsonIfExists,
  requireArgs,
  runCli,
  writeJson
} from './lib/io.mjs';
import {
  ARMS,
  computeCleanRound,
  normalizeArrayPiece,
  normalizeJudgments,
  padRound,
  validateLedgerEntry
} from './lib/contracts.mjs';

const USAGE = `Usage: node studies/hillclimb/bench/adjudicate.mjs --arm <arm> --round <N> --collected <collected.json> --fingerprint <fp.json> [--judgments <j.json>] [--fixes <fixes.json>] [--verification <v.json>] [--instrument <i.json>] [--exclusions <e.json>] [--prereg-sha <sha>] --ledger-dir <dir> [--amend <note>]

Creates or merge-updates ledger/<arm>/round-NN.json and validates the result.`;

function sortById(items, key) {
  return [...items].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
}

function defaultInstrument() {
  return { suite: 'studies/hillclimb', stories: [], personas: [], repeats: 0 };
}

function defaultVerification() {
  return { regression_green: false, regression_run_ids: [] };
}

function mergeAdjudication(existing, incoming, amendNote) {
  const byId = new Map((existing ?? []).map((entry) => [entry.finding_id, entry]));
  for (const judgment of incoming ?? []) {
    const prior = byId.get(judgment.finding_id);
    if (prior && prior.verdict !== judgment.verdict && !amendNote) {
      throw new Error(`refusing to overwrite ${judgment.finding_id} verdict ${prior.verdict} with ${judgment.verdict} without --amend`);
    }
    byId.set(judgment.finding_id, judgment);
  }
  return sortById([...byId.values()], 'finding_id');
}

function loadOptionalPiece(file, key, fallback) {
  if (!file) return fallback;
  const value = readJson(file);
  return key ? normalizeArrayPiece(value, key) : value;
}

export function buildLedgerEntry(options, deps = {}) {
  if (!ARMS.includes(options.arm)) throw new Error(`unknown arm: ${options.arm}`);
  const existing = options.existing ?? null;
  const collected = options.collected;
  const findings = sortById(collected.findings ?? [], 'finding_id');
  const findingIds = new Set(findings.map((finding) => finding.finding_id));
  const amendments = [...(existing?.amendments ?? [])];

  let adjudication = existing?.adjudication ?? [];
  if (options.judgmentsProvided) {
    for (const judgment of options.judgments) {
      if (!findingIds.has(judgment.finding_id)) {
        throw new Error(`judgment references unknown finding_id: ${judgment.finding_id}`);
      }
    }
    for (const finding of findings) {
      if (!options.judgments.some((judgment) => judgment.finding_id === finding.finding_id)) {
        throw new Error(`missing judgment for finding_id: ${finding.finding_id}`);
      }
    }
    adjudication = mergeAdjudication(adjudication, options.judgments, options.amendNote);
    if (options.amendNote) {
      amendments.push({ at: (deps.now ?? (() => new Date()))().toISOString(), note: options.amendNote });
    }
  }

  const verification = options.verification ?? existing?.verification ?? defaultVerification();
  const entry = {
    schema_version: 1,
    arm: options.arm,
    round: Number(options.round),
    preregistration_sha: options.preregistrationSha ?? existing?.preregistration_sha ?? null,
    fingerprint: options.fingerprint ?? existing?.fingerprint,
    instrument: options.instrument ?? existing?.instrument ?? defaultInstrument(),
    runs: sortById(collected.runs ?? [], 'run_id').sort((a, b) => a.run_id.localeCompare(b.run_id) || a.case_id.localeCompare(b.case_id)),
    findings,
    adjudication,
    fixes: sortById(options.fixes ?? existing?.fixes ?? [], 'commit'),
    verification,
    exclusions: sortById(options.exclusions ?? existing?.exclusions ?? [], 'run_id'),
    amendments,
    clean_round: computeCleanRound(adjudication, verification, { arm: options.arm })
  };

  const validation = validateLedgerEntry(entry);
  if (!validation.ok) throw new Error(`ledger validation failed: ${validation.errors.join('; ')}`);
  return entry;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return { ok: true };
  }
  requireArgs(args, ['arm', 'round', 'collected', 'fingerprint', 'ledger-dir']);

  const ledgerFile = path.join(args['ledger-dir'], args.arm, `round-${padRound(args.round)}.json`);
  const existing = readJsonIfExists(ledgerFile, null);
  const judgmentsProvided = Boolean(args.judgments);
  const entry = buildLedgerEntry({
    arm: args.arm,
    round: args.round,
    collected: readJson(args.collected),
    fingerprint: readJson(args.fingerprint),
    judgments: judgmentsProvided ? normalizeJudgments(readJson(args.judgments)) : [],
    judgmentsProvided,
    fixes: loadOptionalPiece(args.fixes, 'fixes', null),
    exclusions: loadOptionalPiece(args.exclusions, 'exclusions', null),
    verification: args.verification ? readJson(args.verification) : null,
    instrument: args.instrument ? readJson(args.instrument) : null,
    preregistrationSha: args['prereg-sha'] ?? null,
    existing,
    amendNote: args.amend
  }, deps);

  if (existing && !existsSync(path.dirname(ledgerFile))) throw new Error(`ledger directory missing: ${path.dirname(ledgerFile)}`);
  writeJson(ledgerFile, entry);
  console.log(`${ledgerFile}: OK`);
  return { ok: true, file: ledgerFile, entry };
}

if (isDirectRun(import.meta.url)) {
  runCli(main);
}
