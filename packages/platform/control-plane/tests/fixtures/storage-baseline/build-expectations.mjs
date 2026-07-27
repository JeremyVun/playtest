#!/usr/bin/env node
// Regenerate `expected-projections.json` from `fixture.ts` + `projections.ts`.
//
//   node packages/platform/control-plane/tests/fixtures/storage-baseline/build-expectations.mjs
//
// The JSON file is the frozen record; review its diff whenever the fixture
// changes. `tests/unit/storage-fixture.test.ts` fails if the two drift apart.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProjections } from "./projections.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "expected-projections.json");
fs.writeFileSync(out, JSON.stringify(buildProjections(), null, 2) + "\n");
process.stdout.write(`wrote ${path.relative(process.cwd(), out)}\n`);
