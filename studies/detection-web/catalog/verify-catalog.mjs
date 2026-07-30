#!/usr/bin/env node
// Prove every catalogued fault is mechanically live.
//
//   node verify-catalog.mjs [--only f-a,f-b]
//
// For each fault the runner shows three directions:
//
//   clean     its manifestation check PASSES on a build with no fault active;
//   injected  the same check FAILS on a build with only that fault active
//             (a masked fault is exposed because its masker is withdrawn);
//   withdrawn the same check PASSES again on the full-injection build with
//             that one fault withdrawn.
//
// Exit code 0 only when all three directions hold for all catalogued faults.
// A JSON summary is written to stdout.

import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildInjected, loadFaults } from "./build-injected.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(HERE, ".verify");
const CHECKS_DIR = join(HERE, "manifestation");

/** The frozen quotas from the study's pre-registration. */
const QUOTAS = {
  scope: { "surface/copy": 5, interaction: 5, "multi-step flow": 6, "missing capability": 4 },
  trigger: {
    "natural path": 6,
    "invalid/boundary": 4,
    "empty state": 3,
    recovery: 3,
    "async/failure": 4,
  },
  recognition: {
    "obvious breakage": 6,
    "silent no-op": 5,
    contradiction: 5,
    "plausible-but-wrong value": 4,
  },
};

/** Scratch ports only: 4620-4622 belong to the study's own subject runs. */
const FIRST_PORT = 4630;
const LAST_PORT = 4899;
let nextPort = FIRST_PORT;

const BORROWER = {
  name: "Ivy Cole",
  email: "ivy.cole@fairmont.edu",
  department: "Design",
  purpose: "Degree show promotional films.",
};

class CheckFailure extends Error {}

function takePort() {
  const port = nextPort;
  nextPort = port >= LAST_PORT ? FIRST_PORT : port + 1;
  return port;
}

async function loadChecks() {
  const files = (await readdir(CHECKS_DIR)).filter((name) => name.endsWith(".test.mjs")).sort();
  const checks = new Map();
  for (const file of files) {
    const module = await import(new URL(`manifestation/${file}`, import.meta.url).href);
    if (!module.id || typeof module.check !== "function") {
      throw new Error(`manifestation/${file} must export { id, check }.`);
    }
    if (`${module.id}.test.mjs` !== file) {
      throw new Error(`manifestation/${file} declares id ${module.id}; the file name must match.`);
    }
    checks.set(module.id, module);
  }
  return checks;
}

async function loadCards() {
  const raw = JSON.parse(await readFile(join(HERE, "catalog.json"), "utf8"));
  return raw.faults;
}

/** Every fault that must be withdrawn before `id` can manifest. */
function maskerChain(cards, id) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const chain = [];
  let cursor = byId.get(id)?.masked_by || null;
  while (cursor) {
    if (chain.includes(cursor)) throw new Error(`Masking cycle at ${cursor}.`);
    chain.push(cursor);
    if (chain.length > 2) throw new Error(`Masking chain for ${id} is more than 2 deep.`);
    cursor = byId.get(cursor)?.masked_by || null;
  }
  return chain;
}

function auditCards(cards, faultIds) {
  const problems = [];
  const cardIds = cards.map((card) => card.id);
  for (const id of faultIds) if (!cardIds.includes(id)) problems.push(`catalog.json has no card for ${id}`);
  for (const id of cardIds) if (!faultIds.includes(id)) problems.push(`card ${id} has no fault module`);
  for (const [axis, quota] of Object.entries(QUOTAS)) {
    const counts = {};
    for (const card of cards) counts[card[axis]] = (counts[card[axis]] || 0) + 1;
    for (const [label, expected] of Object.entries(quota)) {
      const actual = counts[label] || 0;
      if (actual !== expected) problems.push(`${axis} "${label}": ${actual}, quota ${expected}`);
    }
    for (const label of Object.keys(counts)) {
      if (!(label in quota)) problems.push(`${axis} "${label}" is not a catalogued label`);
    }
  }
  const masked = cards.filter((card) => card.masked_by);
  if (masked.length > 6) problems.push(`${masked.length} faults are masked; at most 6 may be`);
  for (const card of masked) maskerChain(cards, card.id);
  return { problems, maskedCount: masked.length, reachable: cards.length - masked.length };
}

async function freePort() {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const port = takePort();
    try {
      await fetch(`http://127.0.0.1:${port}/__build`, { signal: AbortSignal.timeout(500) });
    } catch {
      return port; // nothing is listening there
    }
  }
  throw new Error("no free scratch port in 4630-4899");
}

async function startServer(dir, buildId) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    env: { ...process.env, SUBJECT_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server for ${dir} exited early (${child.exitCode})\n${stderr}`);
    }
    try {
      const response = await fetch(`${base}/__build`);
      if (response.ok) {
        // Never talk to somebody else's server: the build id must be this build's.
        const served = (await response.json()).build_id;
        if (served !== buildId) {
          child.kill("SIGKILL");
          throw new Error(`port ${port} is serving build ${served}, expected ${buildId}`);
        }
        break;
      }
    } catch (error) {
      if (String(error.message).startsWith("port ")) throw error;
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`server for ${dir} never came up\n${stderr}`);
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    base,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((r) => {
        child.once("exit", r);
        setTimeout(r, 2000);
      });
    },
  };
}

function clientFor(base) {
  const client = {
    base,
    assert(condition, message) {
      if (!condition) throw new CheckFailure(message);
    },
    async api(method, path, body) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async asset(path) {
      const response = await fetch(`${base}${path}`);
      if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
      return response.text();
    },
    async reset() {
      const response = await fetch(`${base}/__reset`, { method: "POST" });
      if (!response.ok) throw new Error(`reset returned ${response.status}`);
    },
    async draft(borrower = BORROWER) {
      const created = await client.api("POST", "/api/loan-drafts", borrower);
      if (created.status !== 201) {
        throw new Error(`creating a draft returned ${created.status}`);
      }
      return created.body.draft.id;
    },
  };
  return client;
}

async function runCheck(module, base) {
  try {
    await module.check(clientFor(base));
    return { passed: true, detail: null };
  } catch (error) {
    return {
      passed: false,
      detail: error.message,
      unexpected: error instanceof CheckFailure ? undefined : true,
    };
  }
}

async function withBuild(dir, options, work) {
  const meta = await buildInjected({ out: dir, ...options });
  const server = await startServer(dir, meta.build_id);
  try {
    return await work(server);
  } finally {
    await server.stop();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let only = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--only") only = (args[i + 1] || "").split(",").filter(Boolean);
    else if (args[i].startsWith("--only=")) only = args[i].slice(7).split(",").filter(Boolean);
  }

  const faults = await loadFaults();
  const checks = await loadChecks();
  const cards = await loadCards();
  const allIds = faults.map((fault) => fault.id);
  for (const id of allIds) {
    if (!checks.has(id)) throw new Error(`No manifestation check for ${id}.`);
  }
  for (const id of checks.keys()) {
    if (!allIds.includes(id)) throw new Error(`Manifestation check ${id} has no fault module.`);
  }
  const audit = auditCards(cards, allIds);
  const targets = only ? allIds.filter((id) => only.includes(id)) : allIds;

  const results = new Map(targets.map((id) => [id, { id, clean: null, injected: null, withdrawn: null }]));

  // Direction (a): every check passes against a build with nothing active.
  await withBuild(join(SCRATCH, "clean"), { withdraw: allIds }, async (server) => {
    for (const id of targets) {
      const outcome = await runCheck(checks.get(id), server.base);
      results.get(id).clean = outcome;
    }
  });

  // Directions (b) and (c), one build each.
  for (const id of targets) {
    await withBuild(
      join(SCRATCH, "injected"),
      { withdraw: allIds.filter((other) => other !== id) },
      async (server) => {
        results.get(id).injected = await runCheck(checks.get(id), server.base);
      },
    );
    // A masked fault only shows itself once its maskers are withdrawn too.
    const withdrawal = [id, ...maskerChain(cards, id)];
    await withBuild(join(SCRATCH, "withdrawn"), { withdraw: withdrawal }, async (server) => {
      results.get(id).withdrawn = await runCheck(checks.get(id), server.base);
      results.get(id).withdrawal = withdrawal;
    });
  }

  const rows = targets.map((id) => {
    const record = results.get(id);
    const ok =
      record.clean.passed === true &&
      record.injected.passed === false &&
      record.withdrawn.passed === true;
    return {
      id,
      title: checks.get(id).title,
      clean_passes: record.clean.passed,
      injected_fails: record.injected.passed === false,
      withdrawn_passes: record.withdrawn.passed,
      withdrawal: record.withdrawal,
      live: ok,
      injected_detail: record.injected.detail,
      clean_detail: record.clean.detail,
      withdrawn_detail: record.withdrawn.detail,
      unexpected_error: Boolean(record.injected.unexpected),
    };
  });

  const live = rows.filter((row) => row.live).length;
  const summary = {
    catalog: "detection-web",
    faults: rows.length,
    live,
    failing: rows.filter((row) => !row.live).map((row) => row.id),
    quota_problems: audit.problems,
    masked: audit.maskedCount,
    reachable_round_1: audit.reachable,
    ok: live === rows.length && audit.problems.length === 0,
    results: rows.map((row) => ({
      id: row.id,
      live: row.live,
      clean_passes: row.clean_passes,
      injected_fails: row.injected_fails,
      withdrawn_passes: row.withdrawn_passes,
      withdrawal: row.withdrawal,
      ...(row.live
        ? {}
        : {
            clean_detail: row.clean_detail,
            injected_detail: row.injected_detail,
            withdrawn_detail: row.withdrawn_detail,
          }),
    })),
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = summary.ok ? 0 : 1;
}

await main();
