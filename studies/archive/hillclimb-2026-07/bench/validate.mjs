import path from 'node:path';
import { isDirectRun, parseArgs, readJson, runCli } from './lib/io.mjs';
import {
  loadLedgerSchema,
  validateFaultCatalog,
  validateLedgerEntry
} from './lib/contracts.mjs';
import { validateSchema } from './lib/schema.mjs';

const USAGE = `Usage: node studies/hillclimb/bench/validate.mjs <ledger-file|faults-file>...

Validates ledger round entries and faults.json files.`;

export function detectSchemaKind(file, value) {
  if (path.basename(file) === 'faults.json' || Array.isArray(value?.faults)) return 'faults';
  return 'ledger';
}

export function validateFile(file, ledgerSchema = loadLedgerSchema()) {
  const value = readJson(file);
  const kind = detectSchemaKind(file, value);
  if (kind === 'faults') return { kind, ...validateFaultCatalog(value) };
  const structural = validateSchema(ledgerSchema, value);
  const ledger = validateLedgerEntry(value, ledgerSchema);
  return { kind, ok: structural.ok && ledger.ok, errors: [...structural.errors, ...ledger.errors] };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return { ok: true };
  }
  if (args._.length === 0) throw new Error('at least one file is required');

  const ledgerSchema = loadLedgerSchema();
  let ok = true;
  for (const file of args._) {
    const result = validateFile(file, ledgerSchema);
    if (result.ok) {
      console.log(`${file}: OK (${result.kind})`);
    } else {
      ok = false;
      console.error(`${file}: ERROR (${result.kind})`);
      for (const error of result.errors) console.error(`  ${error}`);
    }
  }

  if (!ok) process.exitCode = 1;
  return { ok };
}

if (isDirectRun(import.meta.url)) {
  runCli(main);
}
