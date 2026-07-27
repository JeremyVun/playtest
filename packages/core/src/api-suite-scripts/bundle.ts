import type { DynamicValue } from "./types.ts";

// The script artifact bundle (docs/contracts/artifacts.md#script-artifact-bundle,
// docs/contracts/scripts.md#the-authoring-bundle).
//
// N1: the API trajectory is a script artifact — the authored program, its
// execution HAR, its structured report, and the authoring transcript. S2 adds
// the fourth thing that makes the first three reproducible: the handout the
// suite was authored from, and the exact run configuration it was judged under.
//
// A bundle is self-sufficient. `replayScriptBundle` points it at a fresh
// instance of the same service and reproduces the verdict without the control
// plane, the model, or the job that produced it — which is what makes the
// approval fingerprint mean something.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DummyConfigError } from "../config.ts";
import { loadOpenApi } from "../openapi.ts";
import { resolveTargetAuthorization } from "./license.ts";
import { runScript, HAR_FILENAME, REPORT_FILENAME } from "./runner.ts";

/** Bundle layout version. */
export const AUTHORING_BUNDLE_VERSION = 1;
/** The bundle's own manifest. */
export const BUNDLE_MANIFEST = "bundle.json";
/** The authored module, always at the bundle root. */
export const BUNDLE_SCRIPT = "suite.mjs";
/** The persisted authoring transcript. */
export const BUNDLE_TRANSCRIPT = "authoring-transcript.json";

const sha256 = (buffer: DynamicValue) => crypto.createHash("sha256").update(buffer).digest("hex");

const copyInto = (from: DynamicValue, to: DynamicValue) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

/**
 * Write one authoring bundle.
 *
 * @param {string} dir the bundle directory (created)
 * @param {{ script: string, transcript: object, executionDir: string,
 *           handoutDir: string, findings: object[], report: object, replay: object }} input
 * @returns {{ dir: string, manifest: object }}
 */
export function writeAuthoringBundle(dir: DynamicValue, { script, transcript, executionDir, handoutDir, findings = [], report, replay }: DynamicValue) {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });

  fs.writeFileSync(path.join(root, BUNDLE_SCRIPT), script.endsWith("\n") ? script : `${script}\n`);
  fs.writeFileSync(path.join(root, BUNDLE_TRANSCRIPT), `${JSON.stringify(transcript, null, 2)}\n`);
  for (const name of [HAR_FILENAME, REPORT_FILENAME]) {
    const from = path.join(executionDir, name);
    if (fs.existsSync(from)) copyInto(from, path.join(root, name));
  }
  if (handoutDir && fs.existsSync(handoutDir)) {
    for (const entry of fs.readdirSync(handoutDir)) copyInto(path.join(handoutDir, entry), path.join(root, "handout", entry));
  }

  const files: DynamicValue = [];
  const walk = (relative: DynamicValue) => {
    const absolute = path.join(root, relative);
    for (const entry of fs.readdirSync(absolute).sort()) {
      const child = relative ? path.join(relative, entry) : entry;
      if (fs.statSync(path.join(root, child)).isDirectory()) walk(child);
      else files.push({ path: child, sha256: sha256(fs.readFileSync(path.join(root, child))), bytes: fs.statSync(path.join(root, child)).size });
    }
  };
  walk("");

  const manifest: DynamicValue = {
    authoring_bundle_version: AUTHORING_BUNDLE_VERSION,
    created_at: new Date().toISOString(),
    script: { path: BUNDLE_SCRIPT, sha256: report?.script?.sha256 ?? sha256(script), bytes: Buffer.byteLength(script) },
    authored: {
      model: transcript.model,
      iterations: transcript.iterations?.length ?? 0,
      executions: transcript.budget?.used?.executions ?? 0,
      requests: transcript.budget?.used?.requests ?? 0,
      duration_ms: transcript.duration_ms ?? 0,
      outcome: transcript.outcome ?? null,
      handout_sha256: transcript.handout?.sha256 ?? null,
    },
    verdict: report?.verdict ?? null,
    soundness: report?.soundness ?? null,
    obligations: report?.obligations?.summary ?? null,
    findings,
    // Everything replay needs that is not already a file in the bundle. The spec
    // and the obligation manifest ARE files (handout/), and replay reads them
    // from there so a bundle cannot drift from what it was judged against.
    replay: {
      spec: "handout/openapi.json",
      obligations: "handout/obligations.json",
      ...replay,
    },
    files: files.filter((file: DynamicValue) => file.path !== BUNDLE_MANIFEST),
  };
  fs.writeFileSync(path.join(root, BUNDLE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir: root, manifest };
}

/**
 * Read a bundle and verify every file still hashes to what the manifest recorded.
 * @returns {{ dir, manifest, scriptPath, tampered: string[] }}
 */
export function readAuthoringBundle(dir: DynamicValue) {
  const root = path.resolve(dir);
  const manifestPath = path.join(root, BUNDLE_MANIFEST);
  if (!fs.existsSync(manifestPath)) throw new DummyConfigError(`script bundle: no ${BUNDLE_MANIFEST} in ${root}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.authoring_bundle_version !== AUTHORING_BUNDLE_VERSION) {
    throw new DummyConfigError(
      `script bundle: ${root} is version ${manifest.authoring_bundle_version}, and this build reads version ${AUTHORING_BUNDLE_VERSION}`,
    );
  }
  const tampered: DynamicValue = [];
  for (const file of manifest.files ?? []) {
    const absolute = path.join(root, file.path);
    if (!fs.existsSync(absolute) || sha256(fs.readFileSync(absolute)) !== file.sha256) tampered.push(file.path);
  }
  return { dir: root, manifest, scriptPath: path.join(root, BUNDLE_SCRIPT), tampered };
}

/**
 * Replay a bundle against a target. The verdict is reproduced from the bundle's
 * own spec, obligation manifest, rules, and run configuration — the only thing
 * the caller supplies is where to point it and where to write.
 *
 * @param {{ bundle_dir: string, target: object, out_dir?: string,
 *           budget?: number, timeout_ms?: number, where?: string, fetchImpl?: Function }} options
 * @returns {Promise<object>} the `runScript` result
 */
export async function replayScriptBundle(options: DynamicValue = {}) {
  const where = options.where ?? "script replay";
  const { dir, manifest, scriptPath, tampered } = readAuthoringBundle(options.bundle_dir);
  if (tampered.length) {
    throw new DummyConfigError(
      `${where}: ${tampered.length} file(s) in ${dir} no longer match the bundle manifest (${tampered.slice(0, 3).join(", ")}) —` +
        " a bundle's fingerprint is what an approval covers, so a modified bundle is not replayed",
    );
  }
  const replay = manifest.replay ?? {};
  const license = resolveTargetAuthorization(options.target ?? {}, { where, require: false });
  const specFile = path.join(dir, replay.spec ?? "handout/openapi.json");
  const spec = fs.existsSync(specFile) ? loadOpenApi(specFile, { where: `${where}: spec` }) : null;
  const obligationsFile = path.join(dir, replay.obligations ?? "handout/obligations.json");
  const obligations = replay.obligations && fs.existsSync(obligationsFile) ? JSON.parse(fs.readFileSync(obligationsFile, "utf8")).obligations : null;

  return runScript({
    script: scriptPath,
    target: {
      base_url: options.target?.base_url,
      allowed_origins: options.target?.allowed_origins ?? replay.allowed_origins ?? null,
      write_grant: license.write_grant,
    },
    secrets: options.secrets ?? replay.secrets ?? [],
    spec,
    rules: replay.rules ?? [],
    policies: replay.policies ?? undefined,
    obligations,
    params: options.params ?? replay.params ?? {},
    budget: options.budget ?? replay.budget,
    timeout_ms: options.timeout_ms ?? replay.timeout_ms,
    request_timeout_ms: options.request_timeout_ms ?? replay.request_timeout_ms,
    out_dir: options.out_dir ?? null,
    where,
    fetchImpl: options.fetchImpl ?? null,
  });
}
