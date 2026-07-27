#!/usr/bin/env node
// Entry point for the ledger fixture.
//
//   node examples/ledger-api/server.js
//
// Environment (all optional):
//   PORT                   listen port           (default 4180)
//   HOST                   listen address        (default 127.0.0.1)
//   LEDGER_SEED            PRNG seed             (default "ledger-dev-seed")
//   LEDGER_FAULTS          comma-separated fault ids from DESIGN §6.3
//   LEDGER_VARIANT         comma-separated conforming-variant ids (DESIGN §7)
//   LEDGER_JITTER_MS       max response-write jitter in ms  (default 0)
//   LEDGER_JITTER_SEED     PRNG seed for jitter  (default "<LEDGER_SEED>:jitter")
//   LEDGER_ADMIN_TOKEN       throwaway admin bearer token
//   LEDGER_CUSTOMER_TOKEN    throwaway bearer token for principal customer_a
//   LEDGER_CUSTOMER_B_TOKEN  throwaway bearer token for principal customer_b
//
// This file never reads a `.env`. The credentials are disposable fixture
// credentials with printed defaults on purpose: the fixture is a target for
// adversarial exploration, not a place to keep a secret.

import { parseFaults, FAULT_IDS } from "./src/faults.js";
import { parseVariants, VARIANT_IDS } from "./src/variants.js";
import { startServer, readOpenApiDocument } from "./src/http.js";

const fail = (message) => {
  process.stderr.write(`ledger-api: ${message}\n`);
  process.exit(1);
};

const port = Number(process.env.PORT ?? 4180);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
  fail(`PORT must be an integer between 0 and 65535 (got "${process.env.PORT}")`);
}

const { ids: faults, unknown } = parseFaults(process.env.LEDGER_FAULTS);
if (unknown.length) {
  // A typo must never silently measure the clean build.
  fail(`unknown LEDGER_FAULTS id(s): ${unknown.join(", ")}\n  known ids: ${FAULT_IDS.join(", ")}`);
}

const { ids: variants, unknown: unknownVariants } = parseVariants(process.env.LEDGER_VARIANT);
if (unknownVariants.length) {
  // Same rule as faults: a typo must never silently measure the canonical build.
  fail(`unknown LEDGER_VARIANT id(s): ${unknownVariants.join(", ")}\n  known ids: ${VARIANT_IDS.join(", ")}`);
}

let jitterMs = 0;
if (process.env.LEDGER_JITTER_MS !== undefined) {
  const parsed = Number(process.env.LEDGER_JITTER_MS);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(`LEDGER_JITTER_MS must be a non-negative integer (got "${process.env.LEDGER_JITTER_MS}")`);
  }
  jitterMs = parsed;
}

let openapi;
try {
  openapi = readOpenApiDocument();
} catch (error) {
  fail(error.message);
}

const started = await startServer({
  port,
  host: process.env.HOST ?? "127.0.0.1",
  seed: process.env.LEDGER_SEED ?? "ledger-dev-seed",
  faults,
  variants,
  jitterMs,
  jitterSeed: process.env.LEDGER_JITTER_SEED,
  tokens: {
    admin: process.env.LEDGER_ADMIN_TOKEN ?? "admin-token-dev",
    customer: process.env.LEDGER_CUSTOMER_TOKEN ?? "customer-token-dev",
    customerB: process.env.LEDGER_CUSTOMER_B_TOKEN ?? "customer-b-token-dev",
  },
  openapi,
});

process.stdout.write(`ledger-api listening on ${started.url}\n`);
process.stdout.write(`  openapi: ${started.url}/openapi.json\n`);
process.stdout.write(`  seed:    ${started.ledger.seed}\n`);
// The enabled faults and variants are printed to the operator's terminal
// only, never over HTTP: a run under measurement must not be able to read
// the answer key.
process.stdout.write(`  faults:  ${faults.length ? faults.join(", ") : "(none — clean build)"}\n`);
process.stdout.write(`  variants: ${variants.length ? variants.join(", ") : "(none — canonical build)"}\n`);
process.stdout.write(`  jitter:  ${jitterMs > 0 ? `up to ${jitterMs}ms per response` : "(none)"}\n`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    started.close().then(() => process.exit(0));
  });
}
