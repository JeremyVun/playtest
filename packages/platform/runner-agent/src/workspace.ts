import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { materializeAppArtifact } from "./app-artifact.ts";

export async function materializeWorkspace({ api, spec, sessions, failedSessions = {}, workDir }: RunnerDynamic): Promise<RunnerDynamic> {
  const root = path.resolve(workDir, spec.run_group_id);
  const suiteDir = path.join(root, "suite");
  const runsRoot = path.join(root, "runs");
  const envDir = path.join(suiteDir, ".playtest-env");
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(envDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(runsRoot, { recursive: true });

  const { tree } = await api.json("GET", `/runner/snapshots/${spec.snapshot_id}/tree`);
  for (const [rel, sha] of Object.entries(tree)) {
    const buf = await api.bytes(`/runner/blobs/${sha}`);
    const abs = safeJoin(suiteDir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buf);
  }

  // Current baselines land in results/ exactly where core baselinePaths looks
  // (results/<story>.baseline.{jsonl,json}), so acted stories replay instead of
  // re-recording. The trajectory is read out of the sealed baseline bundle by
  // the control plane; meta is the core .baseline.json shape verbatim (§1).
  for (const b of spec.baselines || []) {
    const traj = await api.bytes(`/runner/baselines/${b.id}/trajectory`);
    const base = safeJoin(suiteDir, path.join("results", b.story_id));
    await fsp.mkdir(path.dirname(base), { recursive: true });
    await fsp.writeFile(`${base}.baseline.jsonl`, traj);
    await fsp.writeFile(`${base}.baseline.json`, JSON.stringify(b.meta, null, 2) + "\n");
  }

  const materialized = await buildEnvironmentOverlay({ spec, sessions, failedSessions, envDir });
  // The environment's pinned app artifact becomes a real file on this disk, and
  // its absolute path becomes the overlay's `app:` — so core keeps receiving
  // exactly what the engine contract promises and never learns the provenance.
  //
  // Read the suite's own file FIRST: a suite that declares `app.envs.<name>.app`
  // has said something more specific than the environment did and wins the
  // merge below anyway, so downloading a build it would discard is pure waste
  // (and these are hundreds of megabytes).
  const suiteDoc = await readSuiteDefaults(suiteDir);
  const suiteEnvApp = suiteDoc.app?.envs?.[spec.environment?.name]?.app;
  if (spec.environment?.app_artifact?.sha256 && typeof suiteEnvApp !== "string") {
    materialized.appOverlay.app = await materializeAppArtifact({
      api,
      artifact: spec.environment.app_artifact,
      root,
    });
  }
  await mergeOverlay(suiteDir, suiteDoc, spec.environment.name, materialized.appOverlay, materialized.authDefault, spec.project?.models);

  return {
    root,
    suiteDir,
    runsRoot,
    env: materialized.env,
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

async function buildEnvironmentOverlay({ spec, sessions, failedSessions = {}, envDir }: RunnerDynamic): Promise<RunnerDynamic> {
  const cfg: { app?: RunnerDynamic; auth?: RunnerDynamic; secret_env?: Record<string, RunnerDynamic> } = spec.environment?.config || {};
  const resolvedSecrets = spec.environment?.resolved_secrets || {};
  const appOverlay = resolveRefs(cfg.app || {}, { envDir, resolvedSecrets, sessions });
  const authStates: Record<string, RunnerDynamic> = {};
  const identities = cfg.auth?.identities || {};
  for (const [label, ref] of Object.entries(identities)) {
    const resolved = await materializeAuthRef(label, ref, { envDir, resolvedSecrets, sessions, failedSessions });
    if (resolved) authStates[label] = resolved;
  }
  if (Object.keys(authStates).length) appOverlay.auth_states = authStates;

  const env: Record<string, string> = {};
  for (const [name, ref] of Object.entries(cfg.secret_env || {})) {
    if (typeof ref === "string") {
      env[name] = resolvedSecrets[ref] ?? ref;
    } else if (ref?.$session) {
      const session = sessions[ref.$session];
      env[name] = session ? JSON.stringify(session.storage_state) : "";
    } else if (ref?.$secret_file) {
      env[name] = await writeSecretFile(envDir, ref.$secret_file, resolvedSecrets[ref.$secret_file] ?? "");
    }
  }
  return { appOverlay, env, authDefault: cfg.auth?.default ?? null };
}

async function materializeAuthRef(label: string, ref: RunnerDynamic, { envDir, resolvedSecrets, sessions, failedSessions = {} }: RunnerDynamic): Promise<string | null> {
  if (typeof ref === "string") return ref;
  if (!ref || typeof ref !== "object") return null;
  if (ref.$session) {
    const session = sessions[ref.$session];
    if (!session) {
      // A known-failed mint keeps its auth_states mapping (pointing at a file
      // that is never written) so core config resolution still succeeds for the
      // *other* stories; exec-group reports the affected cases infra before any
      // of them would read this path. An unexpectedly-missing session is a bug.
      if (failedSessions[ref.$session] !== undefined) {
        return path.join(".playtest-env", `session-${safeName(label)}.json`);
      }
      throw new Error(`missing claimed session ${ref.$session} for auth identity ${label}`);
    }
    const file = path.join(".playtest-env", `session-${safeName(label)}.json`);
    await writePrivate(path.join(envDir, path.basename(file)), JSON.stringify(session.storage_state, null, 2) + "\n");
    return file;
  }
  if (ref.$secret_file) {
    return await writeSecretFile(envDir, ref.$secret_file, resolvedSecrets[ref.$secret_file] ?? "");
  }
  return null;
}

function resolveRefs(value: RunnerDynamic, ctx: RunnerDynamic): RunnerDynamic {
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, ctx));
  if (!value || typeof value !== "object") return value;
  if (value.$secret_file) return writeSecretFileSync(ctx.envDir, value.$secret_file, ctx.resolvedSecrets[value.$secret_file] ?? "");
  if (value.$session) {
    const label = safeName(value.$session);
    const session = ctx.sessions[value.$session];
    if (!session) throw new Error(`missing claimed session ${value.$session}`);
    const file = path.join(ctx.envDir, `session-${label}.json`);
    fs.writeFileSync(file, JSON.stringify(session.storage_state, null, 2) + "\n", { mode: 0o600 });
    return path.join(".playtest-env", `session-${label}.json`);
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, ctx)]));
}

/** The materialized suite's root `playtest.yaml`, parsed; `{}` when it has none. */
async function readSuiteDefaults(suiteDir: string): Promise<RunnerDynamic> {
  try {
    return YAML.parse(await fsp.readFile(path.join(suiteDir, "playtest.yaml"), "utf8")) || {};
  } catch (e: RunnerDynamic) {
    if (e.code !== "ENOENT") throw e;
    return {};
  }
}

async function mergeOverlay(suiteDir: string, data: RunnerDynamic, envName: string, appOverlay: RunnerDynamic, authDefault: RunnerDynamic = null, projectModels: RunnerDynamic = null): Promise<void> {
  const file = path.join(suiteDir, "playtest.yaml");
  // The project's actor/grader defaults fill only UNSET top-level keys, so the
  // whole per-key precedence chain stays intact around them: a case file or a
  // deeper playtest.yaml still wins (nearest wins), the suite's own root value
  // is never overwritten, and only a suite that says nothing at all inherits
  // the project's choice instead of the engine default.
  for (const key of ["actor_model", "grader_model"]) {
    if (typeof projectModels?.[key] === "string" && projectModels[key] && data[key] == null) {
      data[key] = projectModels[key];
    }
  }
  data.app = data.app && typeof data.app === "object" ? data.app : {};
  // The environment's auth.default is a SUITE-level default identity: written
  // to the top-level app.auth (replacing any suite default), NEVER into the
  // env overlay — overlay keys apply after the case-file merge and would
  // silently override every story's own app.auth (§3a: stories must win).
  if (authDefault != null) data.app.auth = authDefault;
  data.app.envs = data.app.envs && typeof data.app.envs === "object" ? data.app.envs : {};
  // The environment record is the PROJECT-level source of app.envs.<name>
  // defaults; a suite that declares its own app.envs.<name> keys keeps them
  // (suite isolation — specific over general). The
  // carve-out: credentials are operator-owned, so minted auth_states always
  // come from the environment and can never be shadowed by a committed file.
  data.app.envs[envName] = mergeEnvConfig(appOverlay, data.app.envs[envName]);
  await fsp.writeFile(file, YAML.stringify(data));
}

function mergeEnvConfig(envOverlay: RunnerDynamic, suiteDeclared: RunnerDynamic): RunnerDynamic {
  if (!isPlainObject(suiteDeclared)) return envOverlay;
  const merged = deepMerge(envOverlay, suiteDeclared);
  if (envOverlay.auth_states !== undefined) merged.auth_states = envOverlay.auth_states;
  return merged;
}

/** Suite keys win on conflicts; objects merge recursively, everything else replaces. */
function deepMerge(base: RunnerDynamic, over: RunnerDynamic): RunnerDynamic {
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

function isPlainObject(v: unknown): v is Record<string, RunnerDynamic> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

async function writeSecretFile(envDir: string, name: string, value: unknown): Promise<string> {
  return writeSecretFileSync(envDir, name, value);
}

function writeSecretFileSync(envDir: string, name: string, value: unknown): string {
  const fileName = safeName(name);
  const abs = path.join(envDir, fileName);
  fs.writeFileSync(abs, String(value), { mode: 0o600 });
  return path.join(".playtest-env", fileName);
}

async function writePrivate(abs: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
  await fsp.writeFile(abs, content, { mode: 0o600 });
}

function safeJoin(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`unsafe snapshot path: ${rel}`);
  return abs;
}

function safeName(s: unknown): string {
  return String(s).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "secret";
}
