import path from 'node:path';
import {
  isDirectRun,
  parseArgs,
  readJson,
  requireArgs,
  runCli,
  walkFiles,
  writeJson,
  writeText
} from './lib/io.mjs';
import {
  LEVELS,
  cleanDefinitionForArm,
  countAdjudicationLabels,
  validateFaultCatalog,
  validateLedgerEntry
} from './lib/contracts.mjs';

const USAGE = `Usage: node studies/hillclimb/bench/matrix.mjs --ledger-dir <dir> --faults <faults.json> --out <matrix.json> [--md <matrix.md>]

Computes detection, recall, precision, convergence, cost, and accounting tables from ledger rounds.

Clean-round definition is arm-aware (DESIGN.md §6 / BUILD_PLAN P3):
  v1 arms (shakedown|baseline|naive|policy): TP + new-real-issue only (legacy; not retro-rewritten)
  v2+ arms: also requires zero emergent

Accounting summary separates detected · fixed-without-detection · residual ·
spec-gap / soft-ux / subject-quirk / harness-artifact (and other §3.2 labels).`;

function emptyLevelMap() {
  return Object.fromEntries(LEVELS.map((level) => [level, {
    reachable_found: 0,
    reachable_total: 0,
    reachable_rate: null,
    total_found: 0,
    total: 0,
    total_rate: null
  }]));
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function parseRoundFile(file) {
  const match = path.basename(file).match(/^round-(\d+)\.json$/);
  return match ? Number(match[1]) : null;
}

export function loadLedgerEntries(ledgerDir) {
  return walkFiles(ledgerDir)
    .filter((file) => parseRoundFile(file) !== null)
    .map((file) => ({ file, entry: readJson(file) }))
    .sort((a, b) => (
      a.entry.arm.localeCompare(b.entry.arm) ||
      a.entry.round - b.entry.round ||
      a.file.localeCompare(b.file)
    ));
}

function runForFinding(ledger, findingId) {
  return (ledger.runs ?? []).find((run) => findingId.startsWith(`${run.run_id}/${run.case_id}#`)) ?? null;
}

function findingForId(ledger, findingId) {
  return (ledger.findings ?? []).find((finding) => finding.finding_id === findingId) ?? null;
}

function sortedObjectFromMap(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))));
}

function validateAcceptedFixes(ledgers, faultsById) {
  const errors = [];
  for (const ledger of ledgers) {
    for (const [index, fix] of (ledger.fixes ?? []).entries()) {
      if (!String(fix.description ?? '').startsWith('ACCEPTED:')) continue;
      const fault = faultsById.get(fix.fault_id);
      if (!fault) {
        errors.push(`${ledger.arm} round ${ledger.round} fixes[${index}]: ACCEPTED fix references unknown fault ${fix.fault_id}`);
        continue;
      }
      if (fault.level !== 'L1' || !['info', 'minor'].includes(fault.severity)) {
        errors.push(`${ledger.arm} round ${ledger.round} fixes[${index}]: ACCEPTED is only valid for L1 info/minor faults`);
      }
    }
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
}

function recallForGroup(faults, cumulativeFound, reachableFaultIds, groupKey) {
  const groups = groupKey === 'level'
    ? new Map(LEVELS.map((level) => [level, []]))
    : new Map();

  for (const fault of faults) {
    const key = fault[groupKey];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fault);
  }

  const out = groupKey === 'level' ? emptyLevelMap() : {};
  for (const [group, groupFaults] of groups.entries()) {
    const reachable = groupFaults.filter((fault) => reachableFaultIds.has(fault.id));
    const totalFound = groupFaults.filter((fault) => cumulativeFound.has(fault.id)).length;
    const reachableFound = reachable.filter((fault) => cumulativeFound.has(fault.id)).length;
    out[group] = {
      reachable_found: reachableFound,
      reachable_total: reachable.length,
      reachable_rate: rate(reachableFound, reachable.length),
      total_found: totalFound,
      total: groupFaults.length,
      total_rate: rate(totalFound, groupFaults.length)
    };
  }

  return out;
}

function roundPrecision(ledger) {
  const adjudicated = (ledger.adjudication ?? []).filter((entry) => entry.verdict !== 'duplicate-of');
  const truePositives = adjudicated.filter((entry) => entry.verdict === 'true-positive');
  return {
    true_positives: truePositives.length,
    adjudicated_non_duplicates: adjudicated.length,
    rate: rate(truePositives.length, adjudicated.length)
  };
}

function twoCleanRound(rounds) {
  let streak = 0;
  for (const round of rounds) {
    streak = round.clean_round ? streak + 1 : 0;
    if (streak >= 2) return round.round;
  }
  return null;
}

function armAccounting(armRounds, faults, roundsToClean) {
  const foundByFault = new Map();
  const fixesByFault = new Map();

  for (const ledger of armRounds) {
    for (const judgment of ledger.adjudication ?? []) {
      if (judgment.verdict !== 'true-positive') continue;
      if (!foundByFault.has(judgment.fault_id)) foundByFault.set(judgment.fault_id, []);
      foundByFault.get(judgment.fault_id).push({ round: ledger.round, finding_id: judgment.finding_id });
    }
    for (const fix of ledger.fixes ?? []) {
      if (!fix.fault_id) continue;
      if (!fixesByFault.has(fix.fault_id)) fixesByFault.set(fix.fault_id, []);
      fixesByFault.get(fix.fault_id).push({
        round: ledger.round,
        commit: fix.commit,
        finding_ids: fix.finding_ids,
        accepted: String(fix.description).startsWith('ACCEPTED:')
      });
    }
  }

  return faults.map((fault) => {
    const findings = foundByFault.get(fault.id) ?? [];
    const fixes = fixesByFault.get(fault.id) ?? [];
    const accepted = fixes.some((fix) => fix.accepted);
    const normalFix = fixes.some((fix) => !fix.accepted);
    let status = 'not-yet';
    if (normalFix && findings.length === 0) status = 'fixed-without-detection';
    else if (normalFix) status = 'found-and-fixed';
    else if (accepted) status = 'found-and-accepted';
    else if (findings.length === 0 && roundsToClean !== null) status = 'missed';
    else if (findings.length > 0) status = 'detected';

    return {
      fault_id: fault.id,
      status,
      findings,
      fixes
    };
  });
}

/** Roll up per-fault rows + round label counts into the P3 split summary. */
function armAccountingSummary(rows, armRounds) {
  const label_counts = countAdjudicationLabels(
    armRounds.flatMap((ledger) => ledger.adjudication ?? [])
  );
  let detected = 0;
  let fixed_without_detection = 0;
  let residual = 0;
  let found_and_fixed = 0;
  let found_and_accepted = 0;
  for (const row of rows) {
    // detected = ever a catalog TP in this arm (may or may not be fixed yet)
    if (row.status === 'detected' || row.status === 'found-and-fixed' || row.status === 'found-and-accepted') {
      detected += 1;
    }
    if (row.status === 'found-and-fixed') found_and_fixed += 1;
    if (row.status === 'found-and-accepted') found_and_accepted += 1;
    if (row.status === 'fixed-without-detection') fixed_without_detection += 1;
    // residual live = not removed by fix or ACCEPTED (includes detected-but-unfixed)
    if (
      row.status === 'missed' ||
      row.status === 'not-yet' ||
      row.status === 'detected'
    ) {
      residual += 1;
    }
  }
  return {
    detected,
    found_and_fixed,
    found_and_accepted,
    fixed_without_detection,
    residual,
    emergent: label_counts.emergent,
    label_counts
  };
}

export function buildMatrix({ ledgers, faults }) {
  const faultValidation = validateFaultCatalog(faults);
  if (!faultValidation.ok) throw new Error(`fault catalog validation failed: ${faultValidation.errors.join('; ')}`);

  const ledgerErrors = [];
  for (const { file, entry } of ledgers) {
    const validation = validateLedgerEntry(entry);
    if (!validation.ok) ledgerErrors.push(`${file}: ${validation.errors.join('; ')}`);
  }
  if (ledgerErrors.length > 0) throw new Error(`ledger validation failed: ${ledgerErrors.join('; ')}`);

  const sortedFaults = [...faults.faults].sort((a, b) => a.id.localeCompare(b.id));
  const faultsById = new Map(sortedFaults.map((fault) => [fault.id, fault]));
  const entries = ledgers.map(({ entry }) => entry);
  validateAcceptedFixes(entries, faultsById);

  const personas = new Set();
  const detection = new Map(sortedFaults.map((fault) => [fault.id, new Map()]));
  const convergence = new Map(sortedFaults.map((fault) => [fault.id, { personas: new Set(), runs: new Set() }]));
  const personaClassSignal = new Map();

  for (const ledger of entries) {
    for (const judgment of ledger.adjudication ?? []) {
      if (judgment.verdict !== 'true-positive') continue;
      const fault = faultsById.get(judgment.fault_id);
      if (!fault) continue;
      const run = runForFinding(ledger, judgment.finding_id);
      const persona = run?.persona ?? 'unknown';
      personas.add(persona);
      detection.get(fault.id).set(persona, (detection.get(fault.id).get(persona) ?? 0) + 1);
      convergence.get(fault.id).personas.add(persona);
      if (run) convergence.get(fault.id).runs.add(run.run_id);
      if (!personaClassSignal.has(persona)) personaClassSignal.set(persona, new Map());
      const classMap = personaClassSignal.get(persona);
      classMap.set(fault.class, (classMap.get(fault.class) ?? 0) + 1);
    }
  }

  const arms = new Map();
  for (const ledger of entries) {
    if (!arms.has(ledger.arm)) arms.set(ledger.arm, []);
    arms.get(ledger.arm).push(ledger);
  }

  const byArm = {};
  const accounting = {};
  for (const [arm, armRoundsUnsorted] of [...arms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const armRounds = armRoundsUnsorted.sort((a, b) => a.round - b.round);
    const cumulativeFound = new Set();
    const fixedBefore = new Set();
    let totalCost = 0;
    const roundSummaries = [];

    for (const ledger of armRounds) {
      const roundTruePositiveFaults = new Set(
        (ledger.adjudication ?? [])
          .filter((entry) => entry.verdict === 'true-positive')
          .map((entry) => entry.fault_id)
      );
      const newlyFound = [...roundTruePositiveFaults].filter((faultId) => !cumulativeFound.has(faultId));
      for (const faultId of roundTruePositiveFaults) cumulativeFound.add(faultId);

      const reachableFaultIds = new Set(
        sortedFaults
          .filter((fault) => (fault.masked_by ?? []).every((masker) => fixedBefore.has(masker)))
          .map((fault) => fault.id)
      );
      const roundCost = (ledger.runs ?? []).reduce((sum, run) => sum + Number(run.cost_usd ?? 0), 0);
      totalCost += roundCost;

      roundSummaries.push({
        round: ledger.round,
        clean_round: ledger.clean_round,
        clean_definition: cleanDefinitionForArm(arm),
        precision: roundPrecision(ledger),
        label_counts: countAdjudicationLabels(ledger.adjudication),
        recall_by_level: recallForGroup(sortedFaults, cumulativeFound, reachableFaultIds, 'level'),
        recall_by_class: recallForGroup(sortedFaults, cumulativeFound, reachableFaultIds, 'class'),
        cost_usd: roundCost,
        distinct_faults_found: cumulativeFound.size,
        deltas: {
          new_faults_found: newlyFound.length,
          cost_usd: roundCost
        }
      });

      for (const fix of ledger.fixes ?? []) {
        if (fix.fault_id) fixedBefore.add(fix.fault_id);
      }
    }

    const cleanAt = twoCleanRound(armRounds);
    const faultRows = armAccounting(armRounds, sortedFaults, cleanAt);
    byArm[arm] = {
      rounds: roundSummaries,
      clean_definition: cleanDefinitionForArm(arm),
      cost_per_detected_fault: cumulativeFound.size === 0 ? null : totalCost / cumulativeFound.size,
      rounds_to_clean: cleanAt,
      accounting_summary: armAccountingSummary(faultRows, armRounds)
    };
    accounting[arm] = faultRows;
  }

  const personaList = [...personas].sort((a, b) => a.localeCompare(b));
  const detectionMatrix = {};
  for (const fault of sortedFaults) {
    detectionMatrix[fault.id] = {};
    for (const persona of personaList) detectionMatrix[fault.id][persona] = detection.get(fault.id).get(persona) ?? 0;
  }

  const convergenceOut = {};
  for (const fault of sortedFaults) {
    const value = convergence.get(fault.id);
    convergenceOut[fault.id] = {
      personas: [...value.personas].sort((a, b) => a.localeCompare(b)),
      runs: [...value.runs].sort((a, b) => a.localeCompare(b)),
      persona_count: value.personas.size,
      run_count: value.runs.size
    };
  }

  const signalOut = {};
  for (const [persona, classMap] of [...personaClassSignal.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    signalOut[persona] = sortedObjectFromMap(classMap);
  }

  return {
    schema_version: 1,
    faults: sortedFaults.map((fault) => fault.id),
    personas: personaList,
    detection_matrix: detectionMatrix,
    by_arm: byArm,
    convergence: convergenceOut,
    cost_per_detected_fault: Object.fromEntries(Object.entries(byArm).map(([arm, data]) => [arm, data.cost_per_detected_fault])),
    rounds_to_clean: Object.fromEntries(Object.entries(byArm).map(([arm, data]) => [arm, data.rounds_to_clean])),
    accounting,
    persona_class_signal: signalOut
  };
}

export function renderMarkdown(matrix) {
  const lines = ['# Hill-climb matrix', ''];
  lines.push('## Detection matrix', '');
  lines.push(`| fault | ${matrix.personas.join(' | ')} |`);
  lines.push(`| --- | ${matrix.personas.map(() => '---:').join(' | ')} |`);
  for (const faultId of matrix.faults) {
    lines.push(`| ${faultId} | ${matrix.personas.map((persona) => matrix.detection_matrix[faultId][persona] ?? 0).join(' | ')} |`);
  }
  lines.push('', '## Arms', '');
  lines.push('| arm | clean-def | rounds-to-clean | cost-per-detected-fault | detected | fixed-w/o-detect | residual | emergent | soft-ux | spec-gap | subject-quirk | harness-artifact |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [arm, value] of Object.entries(matrix.by_arm)) {
    const s = value.accounting_summary ?? {};
    const lc = s.label_counts ?? {};
    lines.push(
      `| ${arm} | ${value.clean_definition ?? ''} | ${value.rounds_to_clean ?? ''} | ${value.cost_per_detected_fault ?? ''} | ${s.detected ?? ''} | ${s.fixed_without_detection ?? ''} | ${s.residual ?? ''} | ${s.emergent ?? lc.emergent ?? ''} | ${lc['soft-ux'] ?? ''} | ${lc['spec-gap'] ?? ''} | ${lc['subject-quirk'] ?? ''} | ${lc['harness-artifact'] ?? ''} |`
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return { ok: true };
  }
  requireArgs(args, ['ledger-dir', 'faults', 'out']);

  const matrix = buildMatrix({
    ledgers: loadLedgerEntries(args['ledger-dir']),
    faults: readJson(args.faults)
  });
  writeJson(args.out, matrix);
  if (args.md) writeText(args.md, renderMarkdown(matrix));
  console.log(`${args.out}: OK`);
  return { ok: true, matrix };
}

if (isDirectRun(import.meta.url)) {
  runCli(main);
}
