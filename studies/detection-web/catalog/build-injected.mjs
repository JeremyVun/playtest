#!/usr/bin/env node
// Build an injected copy of the Loanpoint subject.
//
//   node build-injected.mjs --out <dir> [--withdraw f-a,f-b,...]
//
// Copies the clean subject into <dir>, applies every catalogued fault patch
// that has not been withdrawn, rewrites GET /__build to advertise an opaque
// build id, records the active/withdrawn split in <dir>/build-meta.json, and
// wires server-side trigger telemetry into <dir>/telemetry.jsonl.
//
// Nothing the build adds is reachable over HTTP: build-meta.json and
// telemetry.jsonl sit outside public/, no route serves them, no response
// mentions them, and no browser module imports them.

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBJECT = resolve(HERE, "..", "subject");
const FAULTS_DIR = join(HERE, "faults");

/** Fixed salt so a build id never discloses the active fault ids. */
const BUILD_ID_SALT = "loanpoint-detection-web-catalog-v1";

class BuildError extends Error {}

function parseArgs(argv) {
  const args = { out: null, withdraw: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--out") {
      args.out = argv[i + 1];
      i += 1;
    } else if (token === "--withdraw") {
      const value = argv[i + 1] || "";
      i += 1;
      args.withdraw = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    } else if (token.startsWith("--out=")) {
      args.out = token.slice("--out=".length);
    } else if (token.startsWith("--withdraw=")) {
      args.withdraw = token
        .slice("--withdraw=".length)
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    } else {
      throw new BuildError(`Unknown argument: ${token}`);
    }
  }
  if (!args.out) throw new BuildError("Pass --out <dir>.");
  return args;
}

export async function loadFaults() {
  const files = (await readdir(FAULTS_DIR)).filter((name) => name.endsWith(".mjs")).sort();
  const faults = [];
  for (const file of files) {
    const module = await import(new URL(`faults/${file}`, import.meta.url).href);
    const fault = module.default || module;
    if (!fault.id || !Array.isArray(fault.patches)) {
      throw new BuildError(`faults/${file} does not export { id, patches }.`);
    }
    if (`${fault.id}.mjs` !== file) {
      throw new BuildError(`faults/${file} declares id ${fault.id}; the file name must match.`);
    }
    faults.push(fault);
  }
  return faults;
}

export function buildIdFor(activeIds) {
  const digest = createHash("sha256")
    .update(`${BUILD_ID_SALT}:${[...activeIds].sort().join(",")}`)
    .digest("hex");
  return digest.slice(0, 12);
}

function applyPatch(source, patch, faultId) {
  const occurrences = source.split(patch.find).length - 1;
  if (occurrences === 0) {
    throw new BuildError(
      `${faultId}: patch target not found in ${patch.file}.\n--- expected ---\n${patch.find}\n----------------`,
    );
  }
  if (occurrences > 1) {
    throw new BuildError(
      `${faultId}: patch target appears ${occurrences} times in ${patch.file}; it must be unique.`,
    );
  }
  return source.replace(patch.find, () => patch.replace);
}

const TELEMETRY_MODULE = (buildId, activeIds) => `// Trigger telemetry for this injected build. Server-side only: nothing here is
// routed, echoed in a response, or imported by anything under public/.

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as store from "./src/store.js";
import { addDays, dayOfWeek, today } from "./src/time.js";

export const BUILD_ID = ${JSON.stringify(buildId)};

const ACTIVE = ${JSON.stringify(activeIds, null, 2)};

const LOG = fileURLToPath(new URL("./telemetry.jsonl", import.meta.url));

const idFromPath = (pathname, index) => (pathname.split("/")[index] || "");

function loanFor(event, index = 3) {
  return store.findLoan(decodeURIComponent(idFromPath(event.pathname, index)));
}

function draftFor(event) {
  return store.findDraft(decodeURIComponent(idFromPath(event.pathname, 3)));
}

const unitsOf = (lines) => (lines || []).reduce((sum, line) => sum + Number(line.quantity || 0), 0);

const isWeekend = (date) => dayOfWeek(date) === 6 || dayOfWeek(date) === 0;

const message = (event) => (event.body && event.body.error && event.body.error.message) || "";

const overdueToday = (loan) => loan.status === "out" && today() > loan.dueDate;

/**
 * One predicate per fault: true when this request exercised the path that
 * makes that fault visible to a black-box user.
 */
const PROBES = {
  "f-overview-units-total": (e) => e.method === "GET" && e.pathname === "/api/overview",
  "f-late-fee-day-count": (e) =>
    (e.method === "GET" && e.pathname === "/api/overview" && (e.body.overdue || []).length > 0) ||
    (e.method === "GET" && /^\\/api\\/loans\\/[^/]+$/.test(e.pathname) && Boolean(loanFor(e)) && overdueToday(loanFor(e))),
  "f-overdue-empty-state": (e) =>
    e.method === "GET" && e.pathname === "/api/overview" && (e.body.overdue || []).length === 0,
  "f-charges-late-fee": (e) =>
    e.method === "GET" &&
    e.pathname === "/api/overview" &&
    store
      .getState()
      .loans.some((loan) => loan.returnedAt && loan.returnedAt.slice(0, 10) === today() && (loan.lateFeeCents || 0) > 0),
  "f-equipment-empty-copy": (e) =>
    e.method === "GET" &&
    e.pathname === "/api/equipment" &&
    Boolean((e.query.q || "").trim()) &&
    e.body.shownCount === 0,
  "f-equipment-missing-message": (e) =>
    e.method === "GET" && /^\\/api\\/equipment\\/[^/]+$/.test(e.pathname) && e.status === 404,
  "f-available-filter-ignored": (e) =>
    e.method === "GET" && e.pathname === "/api/equipment" && e.query.availableOnly !== undefined,
  "f-out-filter-drops-overdue": (e) =>
    e.method === "GET" && e.pathname === "/api/loans" && e.query.status === "out",
  "f-cancel-button-missing": (e) =>
    e.method === "GET" &&
    /^\\/api\\/loans\\/[^/]+$/.test(e.pathname) &&
    ["pending_approval", "ready"].includes((loanFor(e) || {}).status),
  "f-cancel-confirm-noop": (e) =>
    e.method === "GET" &&
    /^\\/api\\/loans\\/[^/]+$/.test(e.pathname) &&
    ["pending_approval", "ready"].includes((loanFor(e) || {}).status),
  "f-extension-block-missing": (e) =>
    e.method === "GET" && /^\\/api\\/loans\\/[^/]+$/.test(e.pathname) && (loanFor(e) || {}).status === "out",
  "f-extend-limit-off-by-one": (e) =>
    e.method === "POST" &&
    /^\\/api\\/loans\\/[^/]+\\/extend$/.test(e.pathname) &&
    (((loanFor(e) || {}).extensionsUsed || 0) >= 2 ||
      message(e) === "This loan has already used its one extension."),
  "f-bundle-threshold-off-by-one": (e) =>
    (/^\\/api\\/loan-drafts\\/[^/]+$/.test(e.pathname) && unitsOf((draftFor(e) || {}).lines) === 3) ||
    (/^\\/api\\/loan-drafts\\/[^/]+\\/submit$/.test(e.pathname) &&
      e.status === 201 &&
      e.body.loan &&
      e.body.loan.unitCount === 3),
  "f-saturday-roll-short": (e) => {
    const draft = /^\\/api\\/loan-drafts\\/[^/]+/.test(e.pathname) ? draftFor(e) : null;
    if (draft && draft.pickupDate && draft.loanDays) {
      if (isWeekend(addDays(draft.pickupDate, draft.loanDays))) return true;
    }
    if (e.status === 201 && e.body.loan && e.body.loan.pickupDate) {
      if (isWeekend(addDays(e.body.loan.pickupDate, e.body.loan.loanDays))) return true;
    }
    if (/^\\/api\\/loans\\/[^/]+\\/extend$/.test(e.pathname)) {
      const loan = loanFor(e);
      if (loan && isWeekend(addDays(loan.dueDate, 7))) return true;
    }
    return false;
  },
  "f-booking-error-swallowed": (e) =>
    e.method === "POST" && /^\\/api\\/loan-drafts\\/[^/]+\\/submit$/.test(e.pathname) && e.status >= 400,
  "f-booking-no-redirect": (e) =>
    e.method === "POST" && /^\\/api\\/loan-drafts\\/[^/]+\\/submit$/.test(e.pathname) && e.status === 201,
  "f-step2-remove-missing": (e) =>
    ["GET", "PATCH"].includes(e.method) &&
    /^\\/api\\/loan-drafts\\/[^/]+$/.test(e.pathname) &&
    unitsOf((draftFor(e) || {}).lines) > 0,
  "f-approve-pending-label": (e) =>
    e.method === "POST" && /^\\/api\\/approvals\\/[^/]+\\/approve$/.test(e.pathname) && e.status === 200,
  "f-decline-status-line": (e) =>
    e.method === "POST" && /^\\/api\\/approvals\\/[^/]+\\/decline$/.test(e.pathname) && e.status === 200,
  "f-approvals-empty-action": (e) =>
    e.method === "GET" && e.pathname === "/api/approvals" && e.body.count === 0,
};

export function record(event) {
  if (!ACTIVE.length) return;
  const safe = { ...event, body: event.body || {}, query: event.query || {} };
  const lines = [];
  for (const faultId of ACTIVE) {
    const probe = PROBES[faultId];
    if (!probe) continue;
    let hit = false;
    try {
      hit = Boolean(probe(safe));
    } catch {
      hit = false;
    }
    if (!hit) continue;
    lines.push(
      \`\${JSON.stringify({
        ts: new Date().toISOString(),
        fault_id: faultId,
        probe: \`\${safe.method} \${safe.pathname}\`,
      })}\\n\`,
    );
  }
  if (!lines.length) return;
  try {
    appendFileSync(LOG, lines.join(""));
  } catch {
    // Telemetry must never affect the product surface.
  }
}
`;

const SERVER_PATCHES = [
  {
    find: 'import { nowIso } from "./src/time.js";',
    replace: 'import { nowIso } from "./src/time.js";\nimport { BUILD_ID, record } from "./telemetry.mjs";',
  },
  {
    find: '    sendJson(res, 200, { app: APP_NAME, variant: "clean", now: nowIso() });',
    replace:
      '    sendJson(res, 200, { app: APP_NAME, variant: "injected", build_id: BUILD_ID, now: nowIso() });',
  },
  {
    find:
      "      const result = await handler({ params, query, body });\n" +
      "      sendJson(res, result.status, result.body);",
    replace:
      "      const result = await handler({ params, query, body });\n" +
      "      record({ method, pathname, query, status: result.status, body: result.body });\n" +
      "      sendJson(res, result.status, result.body);",
  },
];

export async function buildInjected({ out, withdraw = [] }) {
  const faults = await loadFaults();
  const known = new Set(faults.map((fault) => fault.id));
  for (const id of withdraw) {
    if (!known.has(id)) throw new BuildError(`Unknown fault id in --withdraw: ${id}`);
  }
  const withdrawn = new Set(withdraw);
  const active = faults.filter((fault) => !withdrawn.has(fault.id));
  const activeIds = active.map((fault) => fault.id).sort();
  const outDir = resolve(out);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await cp(SUBJECT, outDir, { recursive: true });

  // Apply fault patches, one file at a time, verifying each find is unique.
  const sources = new Map();
  const readSource = async (file) => {
    if (!sources.has(file)) sources.set(file, await readFile(join(outDir, file), "utf8"));
    return sources.get(file);
  };
  for (const fault of active) {
    for (const patch of fault.patches) {
      const source = await readSource(patch.file);
      sources.set(patch.file, applyPatch(source, patch, fault.id));
    }
  }
  for (const [file, source] of sources) {
    await writeFile(join(outDir, file), source);
  }

  // Build hooks: opaque build id, and the telemetry probe wiring.
  const buildId = buildIdFor(activeIds);
  let server = await readFile(join(outDir, "server.js"), "utf8");
  for (const patch of SERVER_PATCHES) {
    server = applyPatch(server, { ...patch, file: "server.js" }, "build hook");
  }
  await writeFile(join(outDir, "server.js"), server);
  await writeFile(join(outDir, "telemetry.mjs"), TELEMETRY_MODULE(buildId, activeIds));

  const meta = {
    app: "Loanpoint",
    variant: "injected",
    build_id: buildId,
    built_at: new Date().toISOString(),
    active: activeIds,
    withdrawn: [...withdrawn].sort(),
    active_count: activeIds.length,
    withdrawn_count: withdrawn.size,
  };
  await writeFile(join(outDir, "build-meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

  return meta;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const meta = await buildInjected(args);
    process.stdout.write(
      `Built ${resolve(args.out)}\n  build_id ${meta.build_id}\n  active ${meta.active_count}, withdrawn ${meta.withdrawn_count}\n`,
    );
  } catch (error) {
    if (error instanceof BuildError) {
      process.stderr.write(`build-injected: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}
