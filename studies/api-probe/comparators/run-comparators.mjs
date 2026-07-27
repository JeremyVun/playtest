#!/usr/bin/env node
// Comparator-arm round runner (PREREGISTRATION.md "Arms" / "Budgets").
//
// One invocation = one build (clean or a fault id) through one or both
// comparator arms. It owns the fixture lifecycle exactly as the probe's
// run-round.mjs does — a dedicated instance per arm, seeded reset before the
// arm starts — so no arm inherits another's state.
//
//   node studies/api-probe/comparators/run-comparators.mjs \
//     --build clean --round studies/api-probe/rounds/<round> \
//     --fixture <path/to/server.js> [--arms schemathesis,agent-suite]
//
// Outputs, per arm, into <round>/comparators/:
//   <arm>-<build>.har         HAR 1.2 traffic, scored by the same bench oracles
//   <arm>-<build>.meta.json   { label, arm, wall_ms, ... } bench sidecar
//   <arm>-<build>.log         the arm's own stdout/stderr
//
// Neither arm has repository access or fault knowledge. Schemathesis reads the
// served OpenAPI document; the agent-authored suite was written from that
// document plus comparators/INVARIANTS.md and nothing else.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE_PORT = 4183;
const PROXY_PORT = 4193;
const BASE = `http://127.0.0.1:${FIXTURE_PORT}`;

// Budget, frozen: 360 requests per build per arm, enforced at the wire by the
// recording proxy both arms send their test traffic through. --max-examples is
// set high enough that the session always reaches the cap rather than stopping
// short of it, so every build gets the same spend.
const MAX_REQUESTS = process.env.COMPARATOR_MAX_REQUESTS ?? "360";
const MAX_EXAMPLES = process.env.SCHEMATHESIS_MAX_EXAMPLES ?? "12";
const SEED = process.env.SCHEMATHESIS_SEED ?? "1";
const ADMIN_TOKEN = process.env.LEDGER_ADMIN_TOKEN ?? "admin-token-dev";
const RESET_SEED = process.env.LEDGER_SEED ?? "ledger-dev-seed";

const arg = (name, dflt = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : dflt;
};
const build = arg("build");
const roundDir = arg("round");
const arms = (arg("arms") || "schemathesis,agent-suite").split(",").filter(Boolean);
const fixtureArg = arg("fixture") || process.env.LEDGER_FIXTURE || null;
if (!build || !roundDir || !fixtureArg) {
  console.error(
    "usage: run-comparators.mjs --build <clean|f-…> --round <dir> --fixture <server.js> [--arms schemathesis,agent-suite]",
  );
  process.exit(2);
}
const FIXTURE = path.resolve(ROOT, fixtureArg);
if (!fs.existsSync(FIXTURE)) {
  console.error(`no such fixture entry script: ${FIXTURE}`);
  process.exit(2);
}

const outDir = path.join(roundDir, "comparators");
fs.mkdirSync(outDir, { recursive: true });

const SCHEMATHESIS = path.resolve(ROOT, process.env.SCHEMATHESIS_BIN ?? ".venv-schemathesis/bin/schemathesis");
const AGENT_SUITE = path.join(ROOT, "studies/api-probe/comparators/agent-suite/run.mjs");
const HAR_PROXY = path.join(ROOT, "studies/api-probe/comparators/har-proxy.mjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitHealthy(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

async function reset() {
  const response = await fetch(`${BASE}/admin/reset`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ seed: RESET_SEED }),
  });
  if (!response.ok) throw new Error(`seeded reset failed: ${response.status}`);
}

// Deliberately no pkill of the fixture path: the probe arm's runner owns its
// own instance on another port, and a broad `pkill -f <server.js>` would reach
// across ports and kill it mid-round. This arm gets a private port and fails
// loudly if something already holds it.
function startFixture(logFile) {
  const env = { ...process.env, PORT: String(FIXTURE_PORT) };
  if (build !== "clean") env.LEDGER_FAULTS = build;
  const child = spawn("node", [FIXTURE], { env, stdio: ["ignore", "pipe", "pipe"] });
  const stream = fs.createWriteStream(logFile, { flags: "a" });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  return child;
}

const run = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, ...options });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ code, output }));
  });

const harEntryCount = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).log.entries.length;
  } catch {
    return null;
  }
};

async function armSchemathesis() {
  const har = path.join(outDir, `schemathesis-${build}.har`);
  const proxy = await startProxy(har);
  const argv = [
    "run",
    // The schema is fetched straight from the fixture, but every generated
    // request goes through the proxy: loading the document is setup, not part
    // of the arm's measured budget.
    `${BASE}/openapi.json`,
    "--url",
    `http://127.0.0.1:${PROXY_PORT}`,
    "--phases",
    "fuzzing,stateful",
    // /admin/reset is harness plumbing, not a business operation: generating
    // calls to it would wipe the arm's own state mid-session. Isolation is the
    // harness's job for every arm, so it is excluded here exactly as the probe's
    // reset is owned by app.init rather than by the actor.
    "--exclude-path",
    "/admin/reset",
    "-H",
    `Authorization: Bearer ${ADMIN_TOKEN}`,
    "-n",
    MAX_EXAMPLES,
    "--seed",
    SEED,
    // Schemathesis persists discovered examples to a generation database by
    // default, so a second session against a different build starts from what
    // the first one learned. That is cross-build contamination in a measured
    // comparison — every build must get the same arm. Disabled; `--seed` then
    // makes each session reproducible on its own.
    "--generation-database",
    "none",
    // Schemathesis generates values for declared security parameters by
    // default, which overrides the credentials this arm was handed: 136 of 360
    // requests in the first tuning session came back 401, i.e. more than a
    // third of the budget was spent proving the API rejects garbage tokens.
    // The arm is *given* working credentials, exactly as the probe's persona is;
    // generating its own would measure authentication, not the invariants.
    "--generation-with-security-parameters",
    "false",
    // ignored_auth and missing_required_header deliberately strip or corrupt
    // the credentials the arm was handed, to check that the API rejects them.
    // That is a real Schemathesis capability, but under a fixed request budget
    // it spent 136 of 360 requests re-proving the fixture's 401 path — traffic
    // that cannot reach any of the six invariants under test. Excluded so the
    // arm spends its budget where the comparison actually is.
    "--exclude-checks",
    "ignored_auth,missing_required_header",
    "--continue-on-failure",
    "--workers",
    "1",
    "--report",
    "har",
    "--report-dir",
    path.join(outDir, `schemathesis-report-${build}`),
    "--report-har-path",
    path.join(outDir, `schemathesis-native-${build}.har`),
    "--no-color",
  ];
  const started = Date.now();
  const { code, output } = await run(SCHEMATHESIS, argv);
  const wallMs = Date.now() - started;
  await stopProxy(proxy);
  fs.writeFileSync(path.join(outDir, `schemathesis-${build}.log`), `$ schemathesis ${argv.join(" ")}\n\n${output}`);
  fs.writeFileSync(
    path.join(outDir, `schemathesis-${build}.meta.json`),
    JSON.stringify({ label: build, arm: "schemathesis", wall_ms: wallMs, exit: code, requests: harEntryCount(har), cli: ["schemathesis", ...argv] }, null, 2),
  );
  return { arm: "schemathesis", har, requests: harEntryCount(har), wallMs, exit: code };
}

async function startProxy(har) {
  const proxy = spawn(
    "node",
    [HAR_PROXY, "--target", BASE, "--port", String(PROXY_PORT), "--out", har, "--label", build, "--max-requests", MAX_REQUESTS],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  proxy.stderr.pipe(fs.createWriteStream(path.join(outDir, `proxy-${build}.log`), { flags: "a" }));
  if (!(await waitHealthy(`http://127.0.0.1:${PROXY_PORT}/__proxy_health`))) {
    proxy.kill("SIGTERM");
    throw new Error("har proxy did not come up");
  }
  return proxy;
}

async function stopProxy(proxy) {
  proxy.kill("SIGTERM");
  await sleep(700);
}

async function armAgentSuite() {
  const har = path.join(outDir, `agent-suite-${build}.har`);
  const proxy = await startProxy(har);
  const started = Date.now();
  const { code, output } = await run("node", [AGENT_SUITE], {
    env: { ...process.env, BASE_URL: `http://127.0.0.1:${PROXY_PORT}` },
  });
  const wallMs = Date.now() - started;
  await stopProxy(proxy);
  fs.writeFileSync(path.join(outDir, `agent-suite-${build}.log`), output);
  fs.writeFileSync(
    path.join(outDir, `agent-suite-${build}.meta.json`),
    JSON.stringify({ label: build, arm: "agent-suite", wall_ms: wallMs, exit: code, requests: harEntryCount(har) }, null, 2),
  );
  return { arm: "agent-suite", har, requests: harEntryCount(har), wallMs, exit: code };
}

const results = [];
for (const arm of arms) {
  const fixture = startFixture(path.join(outDir, `fixture-${build}.log`));
  if (!(await waitHealthy(`${BASE}/health`))) {
    console.error("fixture did not become healthy");
    fixture.kill();
    process.exit(1);
  }
  await reset();
  console.log(`\n=== ${build} / ${arm} — ${new Date().toISOString()}`);
  const result = arm === "schemathesis" ? await armSchemathesis() : arm === "agent-suite" ? await armAgentSuite() : null;
  fixture.kill();
  await sleep(300);
  if (!result) {
    console.error(`unknown arm: ${arm}`);
    process.exit(2);
  }
  results.push(result);
  console.log(`${arm}: ${result.requests} requests, ${(result.wallMs / 1000).toFixed(1)}s, exit ${result.exit}`);
  fs.appendFileSync(path.join(roundDir, "comparator-manifest.jsonl"), JSON.stringify({ build, ...result, at: new Date().toISOString() }) + "\n");
}

console.log(`\ncomparator rows appended to ${path.join(roundDir, "comparator-manifest.jsonl")}`);
