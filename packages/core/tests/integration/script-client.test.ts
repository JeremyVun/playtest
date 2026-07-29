// The injected client's guards, proven against a real execution
// (docs/contracts/scripts.md#the-client): the egress lock, the read-only
// default, the wire-enforced budget, and secret injection. Every assertion is
// about a script that actually ran in its own process against a loopback
// fixture. Offline, no browser, no model.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runScript } from "../../src/public/api-suite-scripts.ts";
import { DummyConfigError } from "../../src/config.ts";
import { resetSecrets } from "../../src/secrets.ts";
import { startScriptApi } from "../../../../tests/fixtures/script-api/server.ts";

const SUITES = fileURLToPath(new URL("../../../../tests/fixtures/script-suites/", import.meta.url));
// Approved rule statements, per docs/contracts/scripts.md#run-configuration.
// Each test declares exactly the rules its script covers, because an
// unaccounted obligation is (deliberately) unsound.
const RULES: LegacyTestValue = {
  health: { id: "health", statement: "GET /health answers { ok: true }" },
  items: { id: "items", statement: "GET /items answers an items array", approved_skip_reasons: ["no listing was reachable"] },
  auth: { id: "auth", statement: "an unauthenticated caller is refused" },
  mutation: { id: "mutation", statement: "a created item reads back unchanged" },
};
const rulesFor = (...ids: LegacyTestValue[]) => ids.map((id) => RULES[id]);

let api: LegacyTestValue;
let outDir: LegacyTestValue;
let fetchCalls: LegacyTestValue;

beforeEach(async () => {
  api = await startScriptApi();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "script-client-"));
  fetchCalls = [];
});

afterEach(async () => {
  await api.close();
  fs.rmSync(outDir, { recursive: true, force: true });
  delete process.env.PLAYTEST_SECRET_API_TOKEN;
  resetSecrets();
});

/** Instrumented egress: every URL the proxy actually fetched. */
const instrumented = (...args: LegacyTestValue[]) => {
  fetchCalls.push(String(args[0]));
  return globalThis.fetch(...args as [LegacyTestValue, LegacyTestValue]); // SAFETY: instrumented fetch forwards the legacy variadic signature
};

const run = (script: LegacyTestValue, options: LegacyTestValue = {}) =>
  runScript({
    script: path.join(SUITES, script),
    target: { base_url: api.url, ...(options.target ?? {}) },
    rules: options.rules ?? rulesFor("health", "items"),
    out_dir: outDir,
    budget: options.budget ?? 40,
    params: options.params ?? {},
    secrets: options.secrets ?? [],
    fetchImpl: instrumented,
    ...options.extra,
  });

test("a cross-origin request is refused with no network I/O and no HAR entry", async () => {
  const result = await run("off-origin.mjs", { params: { origin: "https://evil.example" } });

  assert.equal(result.exitCode, 2, "the run is unsound: the script asked for something it may not do");
  const refusal = result.report.defects.find((defect: LegacyTestValue) => defect.code === "off_origin");
  assert.ok(refusal, `an off_origin guard defect is reported: ${JSON.stringify(result.report.defects)}`);
  assert.match(refusal.message, /evil\.example/, "the refusal names the refused origin");
  assert.match(refusal.message, /allowed_origins/, "the refusal names the recovery knob");
  assert.deepEqual(
    fetchCalls.filter((url: LegacyTestValue) => !url.startsWith(api.url)),
    [],
    "nothing left the process for the refused origin",
  );
  const har = JSON.parse(fs.readFileSync(path.join(outDir, "har.json"), "utf8"));
  assert.deepEqual(
    har.log.entries.filter((entry: LegacyTestValue) => !entry.request.url.startsWith(api.url)),
    [],
    "a refused request produces no HAR entry",
  );
  assert.equal(result.profile.out_of_origin_attempts.length, 1, "the risk profile flags the attempt");
});

test("non-http(s) and unparsable targets are refused before any I/O", async () => {
  for (const origin of ["file:///etc", "data:text/plain,x"]) {
    const result = await run("off-origin.mjs", { params: { origin } });
    assert.equal(result.exitCode, 2, `${origin} is refused`);
    assert.ok(
      result.report.defects.some((defect: LegacyTestValue) => defect.code === "off_origin" || defect.code === "invalid_path"),
      `${origin} is a guard refusal: ${JSON.stringify(result.report.defects)}`,
    );
  }
  assert.deepEqual(fetchCalls.filter((url: LegacyTestValue) => !url.startsWith(api.url)), [], "fetch was never entered for either");
});

test("an allow-listed origin passes while its neighbours still refuse", async () => {
  const second = await startScriptApi({ prefix: "second" });
  try {
    const allowed = await run("off-origin.mjs", {
      params: { origin: second.origin },
      target: { allowed_origins: [second.origin] },
    });
    assert.ok(
      !allowed.report.defects.some((defect: LegacyTestValue) => defect.code === "off_origin"),
      `the allow-listed origin is admitted: ${JSON.stringify(allowed.report.defects)}`,
    );
    assert.ok(fetchCalls.some((url: LegacyTestValue) => url.startsWith(second.origin)), "the admitted request reached the wire");

    // Same host, different port: a different origin, still refused.
    const taken = new Set([new URL(api.origin).port, new URL(second.origin).port]);
    let port = Number(new URL(second.origin).port) + 1;
    while (taken.has(String(port))) port += 1;
    const neighbour = `http://127.0.0.1:${port}`;
    const refused = await run("off-origin.mjs", { params: { origin: neighbour }, target: { allowed_origins: [second.origin] } });
    assert.ok(
      refused.report.defects.some((defect: LegacyTestValue) => defect.code === "off_origin"),
      "a neighbouring port is a different origin and is refused",
    );
    assert.deepEqual(fetchCalls.filter((url: LegacyTestValue) => url.startsWith(neighbour)), [], "the neighbour never reached the wire");
  } finally {
    await second.close();
  }
});

test("read-only is the default: a POST is refused at the client and never sent", async () => {
  const result = await run("mutates.mjs");

  assert.equal(result.report.run.mode, "read-only", "no write grant means read-only");
  const refusal = result.report.defects.find((defect: LegacyTestValue) => defect.code === "read_only");
  assert.ok(refusal, `the mutation is refused: ${JSON.stringify(result.report.defects)}`);
  assert.match(refusal.message, /write grant/, "the refusal names what is missing");
  assert.match(refusal.message, /never be enabled from script code/, "and says the script cannot grant it");
  assert.deepEqual(
    api.requests.filter((request: LegacyTestValue) => request.method === "POST"),
    [],
    "the fixture never saw a POST",
  );
  assert.equal(result.exitCode, 2);
});

test("the write grant flows from run configuration only, and must name this origin", async () => {
  const granted = await run("mutates.mjs", {
    rules: rulesFor("health", "items", "mutation"),
    target: { write_grant: { origin: api.origin, approved_by: "owner@example.test", approved_at: "2026-07-26T00:00:00Z" } },
  });
  assert.equal(granted.report.run.mode, "read-write");
  assert.equal(granted.exitCode, 0, `a granted mutation passes: ${JSON.stringify(granted.report.soundness)}`);
  assert.equal(granted.report.run.write_grant.approved_by, "owner@example.test");
  assert.equal(granted.profile.mutation.classification, "writes");
  assert.equal(granted.profile.data_created.count, 1, "the profile counts the created resource");

  // A grant for another origin does not license this run.
  await assert.rejects(
    () => run("mutates.mjs", { target: { write_grant: { origin: "https://other.example", approved_by: "owner" } } }),
    (error) => error instanceof DummyConfigError && /authorizes https:\/\/other\.example/.test(error.message),
  );
  // And a grant with no approver is not an authorization at all.
  await assert.rejects(
    () => run("mutates.mjs", { target: { write_grant: { origin: api.origin } } }),
    (error) => error instanceof DummyConfigError && /approved_by/.test(error.message),
  );
});

test("the request budget stops execution at N requests, counted at the wire", async () => {
  const result = await run("over-budget.mjs", { budget: 7 });

  assert.equal(result.report.run.budget.limit, 7);
  assert.equal(result.report.run.budget.used, 7, "exactly the budget was spent");
  const har = JSON.parse(fs.readFileSync(path.join(outDir, "har.json"), "utf8"));
  assert.equal(har.log.entries.length, 7, "the recorded trace IS the budget");
  assert.equal(fetchCalls.length, 7, "nothing was forwarded past the cap");
  assert.ok(
    result.report.defects.some((defect: LegacyTestValue) => defect.kind === "budget_exhausted"),
    `exhaustion is a defect, not a check outcome: ${JSON.stringify(result.report.defects)}`,
  );
  assert.equal(result.exitCode, 2, "an out-of-budget suite is unsound");
});

test("a secret reference authenticates while the value stays out of everything", async () => {
  process.env.PLAYTEST_SECRET_API_TOKEN = `Bearer ${api.token}`;
  const result = await run("authenticated.mjs", { secrets: ["API_TOKEN"], rules: rulesFor("health", "auth") });

  assert.equal(result.exitCode, 0, `the suite passes: ${JSON.stringify(result.report.soundness)}`);
  const authenticated = result.report.checks.find((check: LegacyTestValue) => check.id === "injected-credential-authenticates");
  assert.equal(authenticated!.pass, true, "the injected credential authenticated the request");
  assert.ok(
    api.requests.some((request: LegacyTestValue) => request.headers.authorization === `Bearer ${api.token}`),
    "the real credential reached the target",
  );

  // Grep-proof, the P2 pattern: the value appears nowhere the script could read
  // and nowhere the harness persists.
  const surfaces = {
    "har.json": fs.readFileSync(path.join(outDir, "har.json"), "utf8"),
    "script-report.json": fs.readFileSync(path.join(outDir, "script-report.json"), "utf8"),
    stdout: result.stdout,
    stderr: result.stderr,
    "in-memory report": JSON.stringify(result.report),
    "in-memory profile": JSON.stringify(result.profile),
  };
  for (const [where, text] of Object.entries(surfaces)) {
    assert.ok(!text.includes(api.token), `the credential value must not appear in ${where}`);
  }
  assert.match(surfaces["har.json"], /\[secret:API_TOKEN\]/, "the HAR records the placeholder instead");
  // The fixture echoes its own Authorization header back; the proxy scrubs it on
  // the way in, so even the script never saw the value.
  assert.match(result.stdout, /script-visible: .*\[secret:API_TOKEN\]/);
  assert.equal(result.profile.secret_references.used[0], "API_TOKEN", "the profile reports WHICH secret was used");
});

test("an undeclared secret name is refused, and a declared one with no value is a config error", async () => {
  const undeclared = await run("authenticated.mjs", { secrets: [], rules: rulesFor("health", "auth") });
  assert.equal(undeclared.exitCode, 2);
  assert.ok(
    undeclared.report.defects.some((defect: LegacyTestValue) => /API_TOKEN/.test(defect.message) && /not declared/.test(defect.message)),
    `an undeclared reference is refused: ${JSON.stringify(undeclared.report.defects)}`,
  );

  const noValue = await run("authenticated.mjs", { secrets: ["API_TOKEN"], rules: rulesFor("health", "auth") });
  assert.ok(
    noValue.report.defects.some((defect: LegacyTestValue) => /PLAYTEST_SECRET_API_TOKEN/.test(defect.message)),
    `a missing value names the variable to export: ${JSON.stringify(noValue.report.defects)}`,
  );
});
