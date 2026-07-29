// The hosted script-execution boundary, as an adversarial battery
// (docs/contracts/hosted.md#script-execution-boundary, DESIGN N8).
//
// The boundary is a contract, not an assumption: credentials live in the
// secret-bearing proxy process (this test process, standing in for the
// runner-agent job) and the script runs in a child that holds none. Every case
// below is a hostile script that tries to break out — ambient fetch,
// node:http/node:net, alternate origins and DNS names, process.env, filesystem
// escape, child_process, direct report fabrication, and credential exfiltration
// through URLs, bodies, logs, and thrown exceptions.
//
// The bar each case must clear: **blocked, or provably credential-free.**
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runScript } from "@playtest/core/api-suite-scripts";
import { resetSecrets } from "@playtest/core/testing";
import { startScriptApi } from "../../../../../tests/fixtures/script-api/server.ts";

const ATTACKS = fileURLToPath(new URL("../fixtures/script-attacks/", import.meta.url));
const RULES = [{ id: "boundary", statement: "the script sandbox holds" }];

let api: Awaited<ReturnType<typeof startScriptApi>>;
let outDir: string;
let fetchCalls: string[];

beforeEach(async () => {
  api = await startScriptApi();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "script-boundary-"));
  fetchCalls = [];
  process.env.PLAYTEST_SECRET_API_TOKEN = `Bearer ${api.token}`;
});

afterEach(async () => {
  await api.close();
  fs.rmSync(outDir, { recursive: true, force: true });
  delete process.env.PLAYTEST_SECRET_API_TOKEN;
  resetSecrets();
});

const run = (attack: string, options: LegacyTestValue = {}) =>
  runScript({
    script: path.join(ATTACKS, attack),
    target: { base_url: api.url, ...(options.target ?? {}) },
    rules: RULES,
    secrets: ["API_TOKEN"],
    out_dir: outDir,
    budget: 30,
    params: options.params ?? {},
    fetchImpl: (...args: Parameters<typeof fetch>) => {
      fetchCalls.push(String(args[0]));
      return globalThis.fetch(...args);
    },
    ...options.extra,
  });

/** The `ATTEMPTS {...}` line each attack prints. */
const attempts = (stdout: string): LegacyTestValue => {
  const line = stdout.split("\n").find((one) => one.startsWith("ATTEMPTS "));
  assert.ok(line, `the attack reported its attempts: ${JSON.stringify(stdout)}`);
  return JSON.parse(line.slice("ATTEMPTS ".length));
};

const assertAllBlocked = (map: LegacyTestValue, keys: string[]) => {
  for (const key of keys) {
    assert.ok(key in map, `the attack tried "${key}"`);
    assert.match(map[key], /^blocked/, `"${key}" must be blocked, got: ${map[key]}`);
  }
};

test("ambient fetch, node:http, node:net, and every other socket route are blocked", async () => {
  const result = await run("ambient-network.mjs");
  const tried = attempts(result.stdout);

  assertAllBlocked(tried, [
    "globalThis.fetch",
    "bare fetch",
    "Function-constructed fetch",
    "WebSocket",
    "import node:http",
    "import http",
    "import node:net",
    "import node:https",
    "import node:dns",
    "import node:tls",
    "import node:dgram",
    "getBuiltinModule net",
    "data: module",
    "https: module",
  ]);
  assert.equal(result.report.checks[0]!.pass, true, `the script found no way out: ${result.report.checks[0]!.observed}`);
  assert.equal(result.exitCode, 0, `and the run is otherwise sound: ${JSON.stringify(result.report.soundness)}`);
  assert.deepEqual(
    fetchCalls.filter((url: string) => !url.startsWith(api.url)),
    [],
    "the proxy never forwarded anything off-target",
  );
});

test("process.env is empty, and child_process, fs, module, vm, and dependencies are unavailable", async () => {
  const result = await run("process-surface.mjs");
  const tried = attempts(result.stdout);

  assert.equal(tried["process.env keys"], "REACHED: []", "the environment is empty, so there is nothing to read");
  assert.equal(tried["process.env.PLAYTEST_SECRET_API_TOKEN"], "undefined");
  assert.equal(tried["process.binding"], "undefined");
  assert.equal(tried["process.dlopen"], "undefined");
  assertAllBlocked(tried, [
    "import node:child_process",
    "import node:worker_threads",
    "import node:module",
    "import node:vm",
    "import node:process",
    "import node:fs",
    "import node:fs/promises",
    "import outside the root",
    "import an absolute path",
    "import a dependency",
  ]);
  assert.equal(result.report.checks[0]!.pass, true);
});

test("an alternate origin, a DNS name, and even an allow-listed neighbour get no credential", async () => {
  const attacker = await startScriptApi({ prefix: "attacker" });
  try {
    const result = await run("alternate-origin.mjs", {
      // The neighbour is deliberately ALLOW-LISTED: reachable, and still no
      // credential, because a secret is bound to the target origin.
      target: { allowed_origins: [attacker.origin] },
      params: {
        targets: {
          "unlisted ip": "http://127.0.0.1:9",
          "dns name": "http://alt.example",
          "allow-listed neighbour": attacker.origin,
        },
      },
    });
    const tried = attempts(result.stdout);

    assertAllBlocked(tried, ["unlisted ip", "dns name", "allow-listed neighbour"]);
    assert.match(tried["allow-listed neighbour"], /bound to the target origin/);
    assert.deepEqual(attacker.requests, [], "the neighbour was never called at all");
    assert.deepEqual(
      fetchCalls.filter((url: string) => !url.startsWith(api.url)),
      [],
      "no request for another origin ever reached the wire",
    );
    const har = JSON.parse(fs.readFileSync(path.join(outDir, "har.json"), "utf8"));
    assert.deepEqual(
      har.log.entries.filter((entry: LegacyTestValue) => !entry.request.url.startsWith(api.url)),
      [],
      "and none of it is in the HAR",
    );
    assert.equal(result.profile.out_of_origin_attempts.length, 2, "the risk profile shows the two egress attempts");
  } finally {
    await attacker.close();
  }
});

test("a script cannot write, overwrite, or fabricate its own verdict", async () => {
  const result = await run("fabricate-report.mjs");
  const tried = attempts(result.stdout);

  assertAllBlocked(tried, ["write har.json", "write script-report.json"]);

  // The artifacts on disk are the PARENT's, not the script's.
  const har = JSON.parse(fs.readFileSync(path.join(outDir, "har.json"), "utf8"));
  assert.equal(har.log.entries.length, 1, "the HAR is the traffic the proxy recorded");
  assert.equal(har.log.creator.name, "playtest-script-runner");
  const written = JSON.parse(fs.readFileSync(path.join(outDir, "script-report.json"), "utf8"));
  assert.equal(written.verdict.pass, false, "the fabricated verdict did not survive");

  // Both fabrications are detected by name.
  const kinds = written.defects.map((defect: LegacyTestValue) => defect.kind);
  assert.ok(kinds.includes("evidence_unresolvable"), `citations to traffic that never happened: ${JSON.stringify(written.defects)}`);
  assert.ok(kinds.includes("unknown_obligation"), `coverage claimed against an obligation nobody approved: ${JSON.stringify(kinds)}`);
  assert.deepEqual(
    written.checks.find((check: LegacyTestValue) => check.id === "boundary-audited").evidence.har_entries,
    [0],
    "the unresolvable citations are dropped; the real one stays",
  );
  assert.equal(result.exitCode, 2);
});

test("the credential cannot be exfiltrated through a URL, a body, a log, or a thrown exception", async () => {
  const result = await run("exfiltrate-credential.mjs", {
    target: { write_grant: { origin: api.origin, approved_by: "boundary-test", approved_at: "2026-07-26T00:00:00Z" } },
  });

  // The authorized request DID carry the real credential: the guard is not
  // passing by breaking authentication.
  assert.ok(
    api.requests.some((request: LegacyTestValue) => request.headers.authorization === `Bearer ${api.token}`),
    "the injected credential reached the authorized target",
  );

  // Every channel the script controls, plus everything persisted.
  const surfaces = {
    stdout: result.stdout,
    stderr: result.stderr,
    "har.json": fs.readFileSync(path.join(outDir, "har.json"), "utf8"),
    "script-report.json": fs.readFileSync(path.join(outDir, "script-report.json"), "utf8"),
    "the thrown-exception defect": JSON.stringify(result.report.defects),
    "what the target received": JSON.stringify(api.requests.filter((request: LegacyTestValue) => request.path !== "/whoami")),
  };
  for (const [where, text] of Object.entries(surfaces)) {
    assert.ok(!text.includes(api.token), `the credential value must not appear in ${where}`);
  }
  assert.match(result.stdout, /LEAK log .*\[secret:API_TOKEN\]/, "the log line carries the placeholder, not the value");
  const thrown = result.report.defects.find((defect: LegacyTestValue) => defect.kind === "threw");
  assert.match(thrown!.message, /LEAK throw \[secret:API_TOKEN\]/, "so does the thrown exception");
  assert.equal(result.exitCode, 2);
});
