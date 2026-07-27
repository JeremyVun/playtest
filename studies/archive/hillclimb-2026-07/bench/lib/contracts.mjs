import { readFileSync } from 'node:fs';
import { validateSchema } from './schema.mjs';

export const ARMS = ['shakedown', 'baseline', 'naive', 'policy', 'v2-baseline', 'v2-policy'];
export const VERDICTS = ['true-positive', 'false-positive', 'new-real-issue', 'duplicate-of', 'emergent'];
export const LEVELS = ['L1', 'L2', 'L3', 'L4'];

/** DESIGN.md §3.2 adjudication labels (often written as `[label]` in rationale). */
export const ADJUDICATION_LABELS = [
  'seeded-tp',
  'emergent',
  'subject-quirk',
  'spec-gap',
  'soft-ux',
  'harness-artifact',
  'false'
];

/**
 * v1 arms (first study) used clean = zero TP/new-real-issue + regression green,
 * without counting emergent. Those ledger clean_round flags are frozen — not
 * retro-rewritten. Instrument v2+ arms use the P3 / DESIGN §6 definition.
 */
export const CLEAN_DEFINITION_V1_ARMS = new Set(['shakedown', 'baseline', 'naive', 'policy']);

export function cleanDefinitionForArm(arm) {
  return CLEAN_DEFINITION_V1_ARMS.has(arm) ? 'v1' : 'v2';
}

export const faultCatalogSchema = {
  type: 'object',
  required: ['schema_version', 'faults'],
  additionalProperties: false,
  properties: {
    schema_version: { type: 'integer', enum: [1] },
    notes: { type: 'object' },
    faults: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'level', 'class', 'severity', 'surface', 'oracle', 'injection', 'masked_by'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^f-[a-z0-9][a-z0-9-]*$' },
          level: { type: 'string', enum: LEVELS },
          class: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
          severity: { type: 'string', enum: ['info', 'minor', 'major'] },
          surface: { type: 'string' },
          oracle: { type: 'string' },
          injection: {
            type: 'object',
            required: ['kind', 'edits'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string' },
              note: { type: 'string' },
              edits: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['file', 'find', 'replace'],
                  additionalProperties: false,
                  properties: {
                    file: { type: 'string' },
                    find: { type: 'string' },
                    replace: { type: 'string' }
                  }
                }
              }
            }
          },
          masked_by: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
};

export function loadLedgerSchema() {
  return JSON.parse(readFileSync(new URL('../ledger.schema.json', import.meta.url), 'utf8'));
}

export function padRound(round) {
  return String(Number(round)).padStart(2, '0');
}

export function normalizeJudgments(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.adjudication)) return input.adjudication;
  if (Array.isArray(input.judgments)) return input.judgments;
  throw new Error('judgments file must be an array or contain adjudication/judgments array');
}

export function normalizeArrayPiece(input, key) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (Array.isArray(input[key])) return input[key];
  throw new Error(`${key} file must be an array or contain ${key} array`);
}

/**
 * Clean-round gate.
 *
 * - **v2** (default for instrument-v2 arms): zero `true-positive`, zero
 *   `new-real-issue`, zero `emergent`, and pinned regressions green.
 * - **v1** (legacy arms only): zero `true-positive` / `new-real-issue` and
 *   regressions green — does **not** count emergent (study-bug left frozen).
 *
 * @param {object[]} adjudication
 * @param {{ regression_green?: boolean } | null | undefined} verification
 * @param {{ definition?: 'v1' | 'v2', arm?: string }} [options]
 */
export function computeCleanRound(adjudication, verification, options = {}) {
  if (!Array.isArray(adjudication) || adjudication.length === 0) return false;
  const definition = options.definition
    ?? (options.arm != null ? cleanDefinitionForArm(options.arm) : 'v2');
  const hasBlockingFinding = adjudication.some((entry) => {
    if (entry.verdict === 'true-positive' || entry.verdict === 'new-real-issue') return true;
    if (definition === 'v2' && entry.verdict === 'emergent') return true;
    return false;
  });
  return !hasBlockingFinding && verification?.regression_green === true;
}

/**
 * Map a judgment to a DESIGN.md §3.2 taxonomy label.
 * Verdict wins for true-positive / emergent; otherwise first `[label]` in rationale.
 */
export function parseAdjudicationLabel(judgment) {
  if (!judgment || typeof judgment !== 'object') return null;
  if (judgment.verdict === 'true-positive') return 'seeded-tp';
  if (judgment.verdict === 'emergent') return 'emergent';
  if (judgment.verdict === 'duplicate-of') return null;
  const rationale = String(judgment.rationale ?? '');
  const match = rationale.match(/\[(seeded-tp|emergent|subject-quirk|spec-gap|soft-ux|harness-artifact|false)\]/i);
  if (match) return match[1].toLowerCase();
  if (judgment.verdict === 'false-positive') return 'false';
  if (judgment.verdict === 'new-real-issue') return 'emergent';
  return null;
}

/** Count non-duplicate judgments by §3.2 label. */
export function countAdjudicationLabels(adjudication) {
  const counts = Object.fromEntries(ADJUDICATION_LABELS.map((label) => [label, 0]));
  for (const judgment of adjudication ?? []) {
    if (judgment?.verdict === 'duplicate-of') continue;
    const label = parseAdjudicationLabel(judgment);
    if (label && Object.prototype.hasOwnProperty.call(counts, label)) counts[label] += 1;
  }
  return counts;
}

export function validateFaultCatalog(catalog) {
  const result = validateSchema(faultCatalogSchema, catalog);
  const errors = [...result.errors];
  const ids = new Set();

  for (const [index, fault] of (catalog?.faults ?? []).entries()) {
    if (!fault || typeof fault !== 'object') continue;
    if (ids.has(fault.id)) errors.push(`$.faults[${index}].id: duplicate fault id ${fault.id}`);
    ids.add(fault.id);
  }

  for (const [index, fault] of (catalog?.faults ?? []).entries()) {
    for (const maskedBy of fault.masked_by ?? []) {
      if (!ids.has(maskedBy)) errors.push(`$.faults[${index}].masked_by: unknown fault id ${maskedBy}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateLedgerEntry(entry, schema = loadLedgerSchema()) {
  const result = validateSchema(schema, entry);
  const errors = [...result.errors];

  if (entry?.arm && !ARMS.includes(entry.arm)) errors.push('$.arm: unknown arm');

  const findings = Array.isArray(entry?.findings) ? entry.findings : [];
  const adjudication = Array.isArray(entry?.adjudication) ? entry.adjudication : [];
  const findingIds = new Set();
  for (const [index, finding] of findings.entries()) {
    if (!finding?.finding_id) continue;
    if (findingIds.has(finding.finding_id)) errors.push(`$.findings[${index}].finding_id: duplicate finding id`);
    findingIds.add(finding.finding_id);
  }

  const adjudicationIds = new Set();
  for (const [index, judgment] of adjudication.entries()) {
    const where = `$.adjudication[${index}]`;
    if (!judgment?.finding_id) continue;
    if (adjudicationIds.has(judgment.finding_id)) errors.push(`${where}.finding_id: duplicate adjudication`);
    adjudicationIds.add(judgment.finding_id);
    if (!findingIds.has(judgment.finding_id)) errors.push(`${where}.finding_id: unknown finding_id`);
    if (!VERDICTS.includes(judgment.verdict)) errors.push(`${where}.verdict: unknown verdict`);
    if (typeof judgment.rationale !== 'string' || judgment.rationale.trim() === '') {
      errors.push(`${where}.rationale: must be non-empty`);
    }

    if (judgment.verdict === 'true-positive') {
      if (typeof judgment.fault_id !== 'string' || judgment.fault_id.trim() === '') {
        errors.push(`${where}.fault_id: required for true-positive`);
      }
      if (Object.prototype.hasOwnProperty.call(judgment, 'duplicate_of')) {
        errors.push(`${where}.duplicate_of: forbidden unless verdict is duplicate-of`);
      }
    } else if (Object.prototype.hasOwnProperty.call(judgment, 'fault_id')) {
      errors.push(`${where}.fault_id: forbidden unless verdict is true-positive`);
    }

    if (judgment.verdict === 'duplicate-of') {
      if (typeof judgment.duplicate_of !== 'string' || judgment.duplicate_of.trim() === '') {
        errors.push(`${where}.duplicate_of: required for duplicate-of`);
      }
    } else if (Object.prototype.hasOwnProperty.call(judgment, 'duplicate_of')) {
      errors.push(`${where}.duplicate_of: forbidden unless verdict is duplicate-of`);
    }
  }

  if (adjudication.length > 0) {
    for (const [index, finding] of findings.entries()) {
      if (!adjudicationIds.has(finding.finding_id)) {
        errors.push(`$.findings[${index}].finding_id: missing adjudication`);
      }
    }
  }

  const expectedClean = computeCleanRound(adjudication, entry?.verification, { arm: entry?.arm });
  if (entry?.clean_round !== expectedClean) {
    errors.push(
      `$.clean_round: expected ${expectedClean} (clean definition ${cleanDefinitionForArm(entry?.arm)})`
    );
  }

  return { ok: errors.length === 0, errors };
}
