#!/usr/bin/env node
// Round runner for the P1 probe arm (PREREGISTRATION.md "Procedure").
// One invocation = one build (clean or a fault id): boots a dedicated fixture
// on PORT, runs the probe stories sequentially with --fresh --no-grade, and
// appends {build, story, runDir, steps, wallMs, status} rows to the round
// manifest. Exclusivity: refuses to start while another playtest run process
// is alive (one run at a time, ever).
//
// Usage:
//   node studies/api-probe/scripts/run-round.mjs --build clean \
//     --round studies/api-probe/rounds/dev-1 [--stories a,b,c] [--max-steps 60]
//   node studies/api-probe/scripts/run-round.mjs --build f-error-200 --round …
//
// Env it sets for the child runs (gateway plumbing per PREREGISTRATION.md):
//   PLAYTEST_LLM_BASE_URL=http://127.0.0.1:8900  PLAYTEST_LLM_API_KEY=subscription
//   PLAYTEST_GPT5_5_MODEL=gpt-5.5  PLAYTEST_LLM_TIMEOUT_MS=305000
import { execFileSync, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SUITE = path.join(ROOT, "studies/api-probe");
const PORT = 4180;
const ALL_STORIES = ["conservation", "idempotency", "lifecycle-legality", "pagination-identity", "error-shape", "balance-agreement"];

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const build = arg("build");
const roundDir = arg("round");
const stories = (arg("stories") || ALL_STORIES.join(",")).split(",").filter(Boolean);
// The target service's entry script. Passed in rather than hardcoded: a study
// may not name the standalone examples tree (tests/repository/boundaries.test.js
// — "product, tests, and studies do not depend on standalone examples"). See
// this suite's README for the concrete command.
const fixtureArg = arg("fixture") || process.env.LEDGER_FIXTURE || null;
if (!build || !roundDir || !fixtureArg) {
  console.error(
    "usage: run-round.mjs --build <clean|f-…> --round <dir> --fixture <server.js> [--stories a,b]\n" +
      "       (--fixture may also come from LEDGER_FIXTURE; see studies/api-probe/README.md)",
  );
  process.exit(2);
}
const FIXTURE = path.resolve(ROOT, fixtureArg);
if (!fs.existsSync(FIXTURE)) {
  console.error(`no such fixture entry script: ${FIXTURE}`);
  process.exit(2);
}

// One playtest run at a time, ever.
try {
  const out = execFileSync("pgrep", ["-f", "cli.js run"], { encoding: "utf8" }).trim();
  if (out) {
    console.error(`another playtest run is alive (pids: ${out.replace(/\n/g, ", ")}); refusing to start`);
    process.exit(1);
  }
} catch {
  // pgrep exit 1 = no match = clear to run
}

fs.mkdirSync(roundDir, { recursive: true });
const manifestPath = path.join(roundDir, "manifest.jsonl");

const fixtureEnv = { ...process.env, PORT: String(PORT) };
if (build !== "clean") fixtureEnv.LEDGER_FAULTS = build;

const runEnv = {
  ...process.env,
  PLAYTEST_LLM_BASE_URL: "http://127.0.0.1:8900",
  PLAYTEST_LLM_API_KEY: "subscription",
  PLAYTEST_GPT5_5_MODEL: "gpt-5.5",
  PLAYTEST_LLM_TIMEOUT_MS: "305000",
};

const waitHealthy = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

const killFixture = () => {
  try {
    execFileSync("pkill", ["-f", FIXTURE]);
  } catch {}
};

const newestRunDir = () => {
  const runs = path.join(ROOT, "runs");
  const dirs = fs
    .readdirSync(runs)
    .map((d) => path.join(runs, d))
    .filter((d) => {
      // Broken symlinks (e.g. run dirs pointing into a cleaned /tmp) stat-throw.
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs[0] ?? null;
};

killFixture();
await new Promise((r) => setTimeout(r, 500));
const fixture = spawn("node", [FIXTURE], { env: fixtureEnv, stdio: ["ignore", "pipe", "pipe"], detached: false });
const fixtureLog = fs.createWriteStream(path.join(roundDir, `fixture-${build}.log`), { flags: "a" });
fixture.stdout.pipe(fixtureLog);
fixture.stderr.pipe(fixtureLog);

if (!(await waitHealthy())) {
  console.error("fixture did not become healthy");
  fixture.kill();
  process.exit(1);
}
console.log(`fixture up on :${PORT} (build: ${build})`);

let failures = 0;
for (const story of stories) {
  const started = Date.now();
  console.log(`\n=== ${build} / ${story} — ${new Date().toISOString()}`);
  const code = await new Promise((resolve) => {
    const child = execFile(
      "node",
      [path.join(ROOT, "packages/cli/src/cli.ts"), "run", SUITE, "--id", story, "--fresh", "--no-grade"],
      { env: runEnv, cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        process.stdout.write(stdout.split("\n").slice(-8).join("\n") + "\n");
        if (stderr.trim()) process.stdout.write("STDERR tail: " + stderr.split("\n").slice(-3).join(" | ") + "\n");
        resolve(err ? (err.code ?? 1) : 0);
      },
    );
  });
  const runDir = newestRunDir();
  const row = { build, story, runDir: runDir ? path.relative(ROOT, runDir) : null, exit: code, wallMs: Date.now() - started, at: new Date().toISOString() };
  fs.appendFileSync(manifestPath, JSON.stringify(row) + "\n");
  if (code !== 0 && code !== 1) failures++; // exit 1 = gate fail (expected on faults); >1 = infra
}

fixture.kill();
console.log(`\nround rows appended to ${manifestPath}; infra failures: ${failures}`);
process.exit(failures ? 1 : 0);
