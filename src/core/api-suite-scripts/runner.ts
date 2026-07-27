import type { DynamicValue } from "./types.ts";

// The script runner (docs/contracts/scripts.md#runner-semantics).
//
// One execution = one subprocess, one timeout, and exactly three outputs:
//
//   har.json            the recorded traffic, run-local, sensitive, untracked
//   script-report.json  per-check verdicts with evidence keyed into the HAR, the
//                       script-defect channel, the obligation accounting, and
//                       the two-column verdict
//   exit status         0 pass · 1 a sound suite with a failing column · 2 unsound
//
// Everything the verdict depends on is computed HERE, in the parent: the HAR is
// recorded by the proxy, the gate column by the shipped invariant policies, the
// obligation accounting by ./obligations.js. The script's contribution is its
// records, and even those are cross-checked — cited HAR entries must resolve, and
// the final report must not contradict what was streamed during execution.
//
// Configuration and user-input failures are DummyConfigError, with the actionable
// message the CLI prints and never a stack.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DummyConfigError, normalizeAllowedOrigins } from "../config.ts";
import { redactSecrets } from "../secrets.ts";
import { createHarRecorder } from "./har.ts";
import { GUARD_CODES, READ_ONLY_METHODS, REQUEST_TIMEOUT_MS, startScriptProxy } from "./proxy.ts";
import { defaultScriptPolicies, evaluateScriptGate, parseScriptPolicies, traceFromHar } from "./gate.ts";
import { accountObligations, deriveObligations, normalizeObligations, OBLIGATION_MANIFEST_VERSION } from "./obligations.ts";
import { profileScript } from "./profile.ts";
import { scanScriptText } from "./leak-scan.ts";
import { accountCleanup, accountTestData, resolveCleanupPolicy, runNamespace } from "./testdata.ts";

/** The entry-contract version a script is written against. */
export const SCRIPT_CONTRACT_VERSION = 1;
/** The persisted report shape version. */
export const SCRIPT_REPORT_VERSION = 1;
/** Default request budget when a run declares none. */
export const DEFAULT_BUDGET = 400;
/** Default wall-clock ceiling for one execution. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** The two artifact filenames. */
export const HAR_FILENAME = "har.json";
export const REPORT_FILENAME = "script-report.json";
/** Exit statuses. */
export const EXIT: DynamicValue = Object.freeze({ pass: 0, fail: 1, unsound: 2 });

const CHILD = fileURLToPath(new URL("./child.ts", import.meta.url));

/** Defect kinds, stable for consumers. */
export const DEFECT_KINDS: DynamicValue = Object.freeze([
  "script_reported", // check.defect(): the script could not build the state it needed
  "threw", // the entry function rejected
  "unhandled_rejection",
  "uncaught_exception",
  "load_failed", // the module would not import (a sandbox refusal lands here)
  "contract_violation", // no default-exported function
  "timeout",
  "budget_exhausted",
  "guard_refusal", // the client asked for something the proxy refuses
  "evidence_unresolvable", // a check cited a HAR entry that does not exist
  "unknown_obligation", // a record traced to an obligation the manifest lacks
  "duplicate_check_id", // two checks claim the same id, so evidence is ambiguous
  "report_contradiction", // the final report disagrees with the streamed records
  "no_report", // the process died without reporting
  "harness", // the bootstrap itself failed
]);

function requireFile(value: DynamicValue, where: DynamicValue) {
  if (typeof value !== "string" || !value.trim()) {
    throw new DummyConfigError(`${where}: a script path is required`);
  }
  const resolved = path.resolve(value);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new DummyConfigError(`${where}: no script at ${resolved}`);
  }
  if (!stat.isFile()) throw new DummyConfigError(`${where}: ${resolved} is not a file`);
  return fs.realpathSync(resolved);
}

function requireBaseUrl(value: DynamicValue, where: DynamicValue) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new DummyConfigError(`${where}: target.base_url ${JSON.stringify(value ?? null)} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DummyConfigError(`${where}: target.base_url must be http(s) (got ${url.protocol.replace(":", "")})`);
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * Read the write grant. The mode is a property of the TARGET AUTHORIZATION, so
 * it is resolved here, from run configuration, and handed to the proxy — the
 * script is told what mode it is in and can change nothing about it.
 */
function resolveMode(grant: DynamicValue, baseOrigin: DynamicValue, where: DynamicValue) {
  if (grant === null || grant === undefined || grant === false) return { mode: "read-only", grant: null };
  if (typeof grant !== "object" || Array.isArray(grant)) {
    throw new DummyConfigError(
      `${where}: target.write_grant is the recorded authorization object { origin, approved_by, approved_at }` +
        ` — the answer to "safe to write test data to this environment?"`,
    );
  }
  let origin;
  try {
    origin = new URL(String(grant.origin)).origin;
  } catch {
    throw new DummyConfigError(`${where}: target.write_grant.origin ${JSON.stringify(grant.origin ?? null)} is not an origin`);
  }
  if (origin !== baseOrigin) {
    throw new DummyConfigError(
      `${where}: target.write_grant authorizes ${origin} but this run targets ${baseOrigin}` +
        ` — an authorization covers exactly the origin it was given for`,
    );
  }
  if (typeof grant.approved_by !== "string" || !grant.approved_by.trim()) {
    throw new DummyConfigError(`${where}: target.write_grant needs approved_by — an authorization records who gave it`);
  }
  return {
    mode: "read-write",
    grant: { origin, approved_by: grant.approved_by.trim(), approved_at: grant.approved_at ?? null },
  };
}

function requireParams(params: DynamicValue, where: DynamicValue) {
  if (params === null || params === undefined) return {};
  if (typeof params !== "object" || Array.isArray(params)) throw new DummyConfigError(`${where}: params must be an object`);
  const json = JSON.stringify(params);
  if (json === undefined) throw new DummyConfigError(`${where}: params must be JSON-serializable`);
  if (/"\$secret"\s*:/.test(json)) {
    throw new DummyConfigError(
      `${where}: params must not carry a secret reference — a script receives NAMES through the client, never values` +
        " (use the run's secrets list and client.secret(NAME))",
    );
  }
  return JSON.parse(json);
}

function positiveInteger(value: DynamicValue, fallback: DynamicValue, where: DynamicValue, key: DynamicValue) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new DummyConfigError(`${where}: ${key} must be a positive integer (got ${JSON.stringify(value)})`);
  return parsed;
}

/**
 * Resolve one script run's configuration. Exported so the CLI and the hosted
 * dispatcher can validate before spending anything.
 */
export function resolveScriptRun(options: DynamicValue = {}) {
  const where = options.where ?? "script run";
  const scriptPath = requireFile(options.script, where);
  const target = options.target ?? {};
  const baseUrl = requireBaseUrl(target.base_url, where);
  const baseOrigin = new URL(baseUrl).origin;
  const allowedOrigins = normalizeAllowedOrigins(target.allowed_origins ?? null, where);
  const { mode, grant } = resolveMode(target.write_grant ?? null, baseOrigin, where);
  const secretNames = [...new Set(options.secrets ?? [])].map((name) => {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new DummyConfigError(`${where}: secrets entries name PLAYTEST_SECRET_<NAME> variables (got ${JSON.stringify(name)})`);
    }
    return name;
  });
  const spec = options.spec ?? null;
  const policyDeclarations = options.policies ?? defaultScriptPolicies({ spec });
  const policies = parseScriptPolicies(policyDeclarations, { where: `${where}: policies`, spec });
  const declared = normalizeObligations(options.obligations ?? null, { where: `${where}: obligations` });
  const derived = deriveObligations({ policies: policyDeclarations, spec, rules: options.rules ?? [] });
  const obligations = normalizeObligations(
    [...declared, ...derived.filter((entry: DynamicValue) => !declared.some((one: DynamicValue) => one.id === entry.id))],
    { where: `${where}: obligations` },
  );
  if (!obligations.length) {
    throw new DummyConfigError(
      `${where}: the coverage-obligation manifest is empty — a suite with nothing to account for cannot be judged sound` +
        " (declare policies, a spec, or approved rules)",
    );
  }
  const namespace = typeof options.namespace === "string" && options.namespace ? options.namespace : runNamespace();
  return {
    where,
    scriptPath,
    scriptRoot: path.dirname(scriptPath),
    baseUrl,
    allowedOrigins,
    mode,
    writeGrant: grant,
    namespace,
    cleanup: resolveCleanupPolicy(target.cleanup ?? null, { where, write: mode === "read-write" }),
    secretNames,
    spec,
    match: options.match ?? null,
    policies,
    obligations,
    params: requireParams(options.params, where),
    budget: positiveInteger(options.budget, DEFAULT_BUDGET, where, "budget"),
    timeoutMs: positiveInteger(options.timeout_ms, DEFAULT_TIMEOUT_MS, where, "timeout_ms"),
    requestTimeoutMs: positiveInteger(options.request_timeout_ms, REQUEST_TIMEOUT_MS, where, "request_timeout_ms"),
    outDir: options.out_dir ? path.resolve(options.out_dir) : null,
  };
}

/**
 * Execute one script.
 * @returns {Promise<{ exitCode: number, report: object, profile: object,
 *                     harPath: string|null, reportPath: string|null,
 *                     harEntries: object[], stdout: string, stderr: string }>}
 */
export async function runScript(options: DynamicValue = {}) {
  const config = resolveScriptRun(options);
  const source = fs.readFileSync(config.scriptPath, "utf8");

  // Layer 4 of the safety model, enforced before execution: a script carrying a
  // literal credential never runs. The full scan (entropy, application data) is
  // the SAVE gate; the two rules that name a value core can prove is a secret are
  // enforced here too, because the alternative is writing it into the HAR.
  const scan = scanScriptText(source, { secretNames: config.secretNames });
  const blocking = scan.findings.filter((finding: DynamicValue) => finding.rule === "secret" || finding.rule === "redaction");
  if (blocking.length) {
    throw new DummyConfigError(
      `${config.where}: ${path.basename(config.scriptPath)} contains a credential literal and will not be executed —` +
        ` ${blocking[0].detail} (line ${blocking[0].line})`,
    );
  }

  const harPath = config.outDir ? path.join(config.outDir, HAR_FILENAME) : null;
  const reportPath = config.outDir ? path.join(config.outDir, REPORT_FILENAME) : null;
  if (config.outDir) fs.mkdirSync(config.outDir, { recursive: true });

  const recorder = createHarRecorder({ target: config.baseUrl, file: harPath, contractVersion: String(SCRIPT_CONTRACT_VERSION) });
  const proxy = await startScriptProxy({
    baseUrl: config.baseUrl,
    allowedOrigins: config.allowedOrigins,
    mode: config.mode,
    budget: config.budget,
    secretNames: config.secretNames,
    timeoutMs: config.requestTimeoutMs,
    recorder,
    fetchImpl: options.fetchImpl ?? null,
  });

  const startedAt = new Date();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let childExit: DynamicValue = null;
  let cleanupAttempt: DynamicValue = null;

  try {
    const child = spawn(process.execPath, [CHILD], {
      cwd: config.scriptRoot,
      // A deliberately empty environment: no PLAYTEST_SECRET_*, no model
      // credentials, nothing inherited. The child empties it again after boot.
      env: { PLAYTEST_SCRIPT_SANDBOX: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(
      JSON.stringify({
        contract_version: SCRIPT_CONTRACT_VERSION,
        scriptPath: config.scriptPath,
        scriptRoot: new URL(`${config.scriptRoot}/`, "file:").href,
        endpoint: proxy.endpoint,
        token: proxy.token,
        baseUrl: config.baseUrl,
        mode: config.mode,
        budget: config.budget,
        secretNames: config.secretNames,
        namespace: config.namespace,
        params: config.params,
      }),
    );

    childExit = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      }, config.timeoutMs);
      timer.unref?.();
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, signal: null, error: String(error?.message ?? error) });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, error: null });
      });
    });
  } finally {
    cleanupAttempt = await attemptCleanup(proxy, config);
    await proxy.close();
  }
  const finishedAt = new Date();
  recorder.flush({ force: true });

  const { report, records, cleanupReasons } = assembleReport({
    config,
    source,
    proxy,
    recorder,
    childExit,
    timedOut,
    startedAt,
    finishedAt,
    scan,
    cleanupAttempt,
  });
  const gate = await evaluateScriptGate({
    harEntries: recorder.entries,
    policies: config.policies,
    spec: config.spec,
    match: config.match,
  });
  finalizeReport(report, { gate, config, recorder, records, cleanupReasons });

  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");

  const profile = profileScript({
    source,
    harEntries: recorder.entries,
    guardEvents: proxy.guardEvents,
    secretNames: config.secretNames,
    budget: config.budget,
  });

  return {
    exitCode: report.verdict.exit_code,
    report,
    profile,
    harPath,
    reportPath,
    harEntries: recorder.entries,
    stdout: redactSecrets(stdout),
    stderr: redactSecrets(stderr),
  };
}

/**
 * Run the target's declared cleanup, through the same wire the script used.
 *
 * Never throws: a cleanup that could not run is a fact the report carries, not
 * an exception that loses the execution's evidence on the way out.
 */
async function attemptCleanup(proxy: DynamicValue, config: DynamicValue) {
  const reset = config.cleanup?.policy === "reset" ? config.cleanup.reset : null;
  if (!reset) return null;
  try {
    const outcome = await proxy.perform({ method: reset.method, path: reset.path, body: reset.body ?? undefined });
    if (outcome?.refused) return { ok: false, detail: outcome.refused.message };
    const status = outcome?.entry?.status ?? 0;
    if (outcome?.entry?.transportError) return { ok: false, detail: outcome.entry.transportError, status };
    if (status < 200 || status >= 300) return { ok: false, detail: `the target answered ${status}`, status };
    return { ok: true, detail: null, status };
  } catch (error: DynamicValue) {
    return { ok: false, detail: String(error?.message ?? error).split("\n")[0] };
  }
}

/** Build everything about the report that does not depend on the gate column. */
function assembleReport({ config, source, proxy, recorder, childExit, timedOut, startedAt, finishedAt, scan, cleanupAttempt = null }: DynamicValue) {
  const reported = proxy.finalReport;
  const records = Array.isArray(reported?.records) ? reported.records : proxy.streamedChecks;
  const defects: DynamicValue = [];
  const addDefect = (kind: DynamicValue, message: DynamicValue, extra: DynamicValue = {}) => defects.push({ kind, message: redactSecrets(String(message)), ...extra });

  // 1. Anti-fabrication: the final report must extend what was streamed during
  //    execution. A script cannot rewrite history it already narrated.
  const streamed = proxy.streamedChecks;
  for (let index = 0; index < streamed.length; index++) {
    const before = JSON.stringify(streamed[index]);
    const after = JSON.stringify(records[index]);
    if (before !== after) {
      addDefect(
        "report_contradiction",
        `the reported record #${index + 1} differs from the record streamed during execution — a report may extend the` +
          " execution's own account of itself, never replace it",
      );
      break;
    }
  }

  // 2. The script's own defect channel, kept apart from check failures.
  for (const record of records) {
    if (record?.kind === "defect") addDefect("script_reported", record.message, { detail: record.detail ?? null, evidence: record.evidence ?? { requests: [] } });
  }

  // 3. Process-level outcomes the script does not get to narrate.
  const outcome = reported?.outcome ?? null;
  if (timedOut) addDefect("timeout", `the script did not finish within ${config.timeoutMs}ms and was killed`);
  if (outcome && outcome.kind !== "completed") addDefect(outcome.kind, outcome.message ?? outcome.kind);
  if (!reported && !timedOut) {
    addDefect(
      "no_report",
      `the script process exited (${childExit?.signal ? `signal ${childExit.signal}` : `code ${childExit?.code}`})` +
        " without reporting — nothing it may have claimed is trusted",
    );
  }
  if (childExit?.error) addDefect("harness", `the script process could not be started: ${childExit.error}`);

  // 4. Guard refusals: asking for something the proxy refuses is a script defect,
  //    and an out-of-origin attempt is a review signal the profile also carries.
  for (const event of proxy.guardEvents) {
    addDefect(event.code === GUARD_CODES.budget ? "budget_exhausted" : "guard_refusal", event.detail, {
      code: event.code,
      request: `${event.method} ${event.path}`,
    });
  }

  // 5. Evidence must resolve into the HAR the PARENT recorded, and a check id
  //    must be unique — two checks under one id make an obligation trace
  //    ambiguous and a review screen wrong.
  const checks: DynamicValue = [];
  const advisories: DynamicValue = [];
  const seenIds: DynamicValue = new Set();
  for (const record of records) {
    if (record?.kind === "advisory") {
      advisories.push({ title: record.title, detail: record.detail ?? null, evidence: record.evidence ?? { requests: [] } });
      continue;
    }
    if (record?.kind !== "check") continue;
    if (seenIds.has(record.id)) {
      addDefect("duplicate_check_id", `two checks claim the id ${JSON.stringify(record.id)} — a check id identifies one verdict`);
    }
    seenIds.add(record.id);
    const missing = (record.evidence?.requests ?? []).filter((ref: DynamicValue) => !recorder.entries[ref]);
    if (missing.length) {
      addDefect(
        "evidence_unresolvable",
        `check "${record.id}" cites HAR entr${missing.length > 1 ? "ies" : "y"} ${missing.join(", ")}, which this execution never recorded`,
        { check: record.id },
      );
    }
    checks.push({
      id: record.id,
      obligation: record.obligation,
      title: record.title,
      pass: record.pass,
      exercised: record.exercised !== false,
      ...(record.expected === undefined ? {} : { expected: redactSecrets(record.expected) }),
      ...(record.observed === undefined ? {} : { observed: redactSecrets(record.observed) }),
      ...(record.note === undefined ? {} : { note: redactSecrets(record.note) }),
      evidence: {
        har_entries: (record.evidence?.requests ?? []).filter((ref: DynamicValue) => Boolean(recorder.entries[ref])),
        ...(record.evidence?.subject === undefined ? {} : { subject: record.evidence.subject }),
      },
    });
  }

  // 6. The test-data lifecycle (DESIGN §6). Computed by the parent from the
  //    recorded traffic, so a script cannot narrate its own tidiness.
  const testData = accountTestData({ harEntries: recorder.entries, namespace: config.namespace, policy: config.cleanup });
  const { cleanup, reasons: cleanupReasons } = accountCleanup({ policy: config.cleanup, attempt: cleanupAttempt, testData });

  const report: DynamicValue = {
    script_report_version: SCRIPT_REPORT_VERSION,
    contract_version: SCRIPT_CONTRACT_VERSION,
    script: {
      path: path.basename(config.scriptPath),
      sha256: scan.fingerprint,
      bytes: Buffer.byteLength(source),
    },
    run: {
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt - startedAt,
      base_url: config.baseUrl,
      allowed_origins: config.allowedOrigins ?? [],
      mode: config.mode,
      write_grant: config.writeGrant,
      budget: { limit: config.budget, used: proxy.requestCount, remaining: Math.max(0, config.budget - proxy.requestCount) },
      timeout_ms: config.timeoutMs,
      read_only_methods: READ_ONLY_METHODS,
      secrets_declared: config.secretNames,
      namespace: config.namespace,
      params: config.params,
      exit: childExit?.signal ? { signal: childExit.signal } : { code: childExit?.code ?? null },
    },
    test_data: testData,
    cleanup,
    checks,
    advisories,
    defects,
    hygiene: { leak_findings: scan.findings },
    guard: proxy.guardEvents.map((event: DynamicValue) => ({ code: event.code, request: `${event.method} ${event.path}`, at: event.at })),
    // filled by finalizeReport
    obligations: null,
    gate: null,
    soundness: null,
    verdict: null,
  };
  return { report, records, cleanupReasons };
}

/** Attach the gate column, the obligation accounting, and the verdict. */
function finalizeReport(report: DynamicValue, { gate, config, recorder, records, cleanupReasons = [] }: DynamicValue) {
  const accounting = accountObligations({
    obligations: config.obligations,
    records,
    trace: traceFromHar(recorder.entries),
    gateChecks: gate.checks,
  });
  for (const miss of accounting.unknown) {
    report.defects.push({
      kind: "unknown_obligation",
      message: `${miss.from} traces to obligation ${JSON.stringify(miss.obligation)}, which the manifest does not contain —` +
        " every report entry must trace to a derived obligation",
    });
  }
  report.obligations = {
    manifest_version: OBLIGATION_MANIFEST_VERSION,
    summary: accounting.summary,
    entries: accounting.entries,
  };
  report.gate = { pass: gate.pass, checks: gate.checks };

  const failing = report.checks.filter((check: DynamicValue) => !check.pass);
  const unexercised = report.checks.filter((check: DynamicValue) => !check.exercised);
  const soundnessReasons = [...accounting.reasons];
  for (const defect of report.defects) soundnessReasons.push(`script defect (${defect.kind}): ${defect.message}`);
  for (const check of unexercised) soundnessReasons.push(`check "${check.id}" was never exercised, so it proves nothing`);
  // A failed cleanup is loud (DESIGN §6): unsound, so the run is red and says why,
  // rather than green with a footnote about an environment quietly silting up.
  for (const reason of cleanupReasons) soundnessReasons.push(reason);
  report.soundness = { ok: soundnessReasons.length === 0, reasons: soundnessReasons };

  const reportPass = failing.length === 0 && report.defects.length === 0;
  const pass = reportPass && gate.pass && report.soundness.ok;
  report.verdict = {
    pass,
    report_pass: reportPass,
    gate_pass: gate.pass,
    sound: report.soundness.ok,
    failing_checks: failing.map((check: DynamicValue) => check.id),
    exit_code: pass ? EXIT.pass : report.soundness.ok ? EXIT.fail : EXIT.unsound,
  };
}
