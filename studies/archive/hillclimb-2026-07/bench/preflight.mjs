import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  isDirectRun,
  parseArgs,
  readJson,
  requireArgs,
  runCli,
  writeJson
} from './lib/io.mjs';
import { gitDirty, gitHead, hashDir } from './lib/hash.mjs';

const USAGE = `Usage: node studies/hillclimb/bench/preflight.mjs --arm <arm> --round <N> --app-dir <dir> --base-url <url> [--suite studies/hillclimb/suite] [--gateway <url>] [--gateway-log <file>] [--reset-path /api/reset] --out <fp.json>

Captures a round fingerprint after checking app reset, fault hash, gateway health, quota log, repo state, and model pins.`;

export function scanUsageLimitLog(file) {
  if (!file || !existsSync(file)) return 0;
  const text = readFileSync(file, 'utf8');
  return text.match(/usage limit/gi)?.length ?? 0;
}

export function parseModelsFromYaml(text) {
  const models = { actor_model: null, grader_model: null };
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(actor_model|grader_model)\s*:\s*["']?([^#"']+)/);
    if (match) models[match[1]] = match[2].trim().replace(/["']$/, '');
  }
  return models;
}

export function readModelsFromPlaytestYaml(file) {
  if (!existsSync(file)) return { actor_model: null, grader_model: null };
  return parseModelsFromYaml(readFileSync(file, 'utf8'));
}

export function liveRunProcesses(execFile = execFileSync) {
  let out = '';
  try {
    out = execFile('pgrep', ['-f', 'src/cli/cli.js'], { encoding: 'utf8' });
  } catch (error) {
    // pgrep exits 1 on no match — that is the pass case.
    if (error.status === 1) return [];
    throw error;
  }
  return out.trim().split(/\s+/).filter(Boolean);
}

function resolveUrl(base, suffix) {
  return new URL(suffix, base.endsWith('/') ? base : `${base}/`).href;
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkHttp(fetchImpl, url, options = {}) {
  const response = await fetchWithTimeout(fetchImpl, url, options);
  return response;
}

export function checkFaultSet(appDir) {
  const faultSetFile = path.join(appDir, '.fault-set.json');
  if (!existsSync(faultSetFile)) return { ok: true, fault_set: null, error: null };
  const faultSet = readJson(faultSetFile);
  const actualHash = hashDir(appDir);
  if (faultSet.app_hash !== actualHash) {
    return {
      ok: false,
      fault_set: { ids: [...(faultSet.ids ?? [])].sort((a, b) => a.localeCompare(b)), app_hash: actualHash },
      error: `fault-set hash mismatch: expected ${faultSet.app_hash}, got ${actualHash}`
    };
  }
  return {
    ok: true,
    fault_set: { ids: [...(faultSet.ids ?? [])].sort((a, b) => a.localeCompare(b)), app_hash: actualHash },
    error: null
  };
}

export async function runPreflight(options, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const cwd = deps.cwd ?? process.cwd();
  const execFile = deps.execFileSync ?? execFileSync;
  const now = deps.now ?? (() => new Date());
  const checks = [];
  const errors = [];

  function record(name, ok, message = '') {
    checks.push({ name, ok, message });
    if (!ok) errors.push(`${name}: ${message}`);
  }

  if (!fetchImpl) throw new Error('global fetch is unavailable');

  const appDir = options.appDir;
  if (!existsSync(appDir)) {
    record('app-dir', false, `not found: ${appDir}`);
  } else {
    record('app-dir', true);
  }

  try {
    const response = await checkHttp(fetchImpl, options.baseUrl, { method: 'GET' });
    record('base-url', response.status === 200, `expected HTTP 200, got ${response.status}`);
  } catch (error) {
    record('base-url', false, error.message);
  }

  try {
    const response = await checkHttp(fetchImpl, resolveUrl(options.baseUrl, options.resetPath), { method: 'POST' });
    record('reset', response.status >= 200 && response.status < 300, `expected HTTP 2xx, got ${response.status}`);
  } catch (error) {
    record('reset', false, error.message);
  }

  let faultSet = null;
  if (existsSync(appDir)) {
    try {
      const result = checkFaultSet(appDir);
      faultSet = result.fault_set;
      record('fault-set', result.ok, result.error ?? '');
    } catch (error) {
      record('fault-set', false, error.message);
    }
  }

  let healthzOk = false;
  const gatewayUrl = options.gateway ?? 'http://127.0.0.1:8900';
  try {
    const response = await checkHttp(fetchImpl, resolveUrl(gatewayUrl, '/healthz'), { method: 'GET' });
    const body = await response.json();
    healthzOk = response.status >= 200 && response.status < 300 && body?.ok === true;
    record('gateway-healthz', healthzOk, `expected {"ok":true}, got status ${response.status}`);
  } catch (error) {
    record('gateway-healthz', false, error.message);
  }

  const usageLimitHits = scanUsageLimitLog(options.gatewayLog);
  record('gateway-log', true, `${usageLimitHits} usage limit hits`);

  // Single-writer guard: the subject app is an external server with one global
  // in-memory state; any concurrently live playtest run corrupts every case of
  // every overlapping run (proven 2026-07-10 — three overlapping runs cross-
  // contaminated baseline round 1). Rounds run serially: preflight fails if any
  // harness run process is alive when a round is about to start.
  try {
    const out = liveRunProcesses(execFile);
    record('exclusive-run', out.length === 0,
      out.length ? `live playtest run process(es): ${out.join(', ')} — wait or kill (and verify) before this round` : '');
  } catch (error) {
    record('exclusive-run', false, error.message);
  }

  let repoHead = null;
  let repoDirty = false;
  try {
    repoHead = gitHead(cwd, execFile);
    repoDirty = gitDirty(cwd, appDir, execFile);
    record('git', true);
  } catch (error) {
    record('git', false, error.message);
  }

  const suiteDir = options.suite ?? 'studies/hillclimb/suite';
  const models = readModelsFromPlaytestYaml(path.join(cwd, suiteDir, 'playtest.yaml'));
  const fingerprint = {
    captured_at: now().toISOString(),
    repo_head: repoHead,
    repo_dirty: repoDirty,
    app_dir: appDir,
    fault_set: faultSet,
    gateway: {
      base_url: gatewayUrl,
      healthz_ok: healthzOk,
      usage_limit_hits: usageLimitHits
    },
    models,
    checks
  };

  return { ok: errors.length === 0, errors, fingerprint };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return { ok: true };
  }
  requireArgs(args, ['arm', 'round', 'app-dir', 'base-url', 'out']);

  const result = await runPreflight({
    arm: args.arm,
    round: Number(args.round),
    appDir: args['app-dir'],
    baseUrl: args['base-url'],
    gateway: args.gateway,
    gatewayLog: args['gateway-log'],
    resetPath: args['reset-path'] ?? '/api/reset',
    suite: args.suite
  }, deps);
  writeJson(args.out, result.fingerprint);

  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`${args.out}: OK`);
  }
  return result;
}

if (isDirectRun(import.meta.url)) {
  runCli(main);
}
