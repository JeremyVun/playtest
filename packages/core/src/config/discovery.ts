// Case discovery: which *.yaml files are cases, and the fan-out/collision rules
// that turn them into resolved cases.
// See docs/contracts/engine.md#discovery-and-configuration.
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadAssertions } from "../assertions.ts";
import { suiteRootFor } from "../trajectory.ts";
import { DummyConfigError } from "./errors.ts";
import { DEFAULTS_FILE, normalizeRuntimeTarget, resolveCase } from "./resolve.ts";
import type { ResolvedCaseDraft } from "./resolve.ts";
import type { AssertionRegistry, DiscoverCasesOptions, ResolvedCase } from "../types.ts";

const DISCOVERY_SKIP = new Set<string>(["node_modules", "personas", "results"]);
const skipDiscoveryEntry = (name: string): boolean => name.startsWith(".") || DISCOVERY_SKIP.has(name);

/**
 * Discover and resolve test cases.
 * @param {string[]} paths dirs and/or .yaml case files
 * @param {{ tags?: string[], ids?: string[], baseUrl?: string|null, env?: string|null,
 *           runtimeTarget?: object|null, resolution?: "executable"|"structural" }} [opts]
 *   env: the --env name selecting an app.envs.<name> overlay (null = top-level app.* only).
 *   runtimeTarget: the physical target a placing host owns, applied AFTER the
 *     complete authored merge (docs/contracts/engine.md#runtime-target).
 *   resolution: "structural" validates without requiring a complete physical
 *     target (docs/contracts/engine.md#resolution-modes).
 * @returns {Promise<object[]>} ResolvedCase[] sorted by id
 */
export async function discoverCases(
  paths: string[],
  { tags = [], ids = [], baseUrl = null, env = null, runtimeTarget = null, resolution = "executable" }: DiscoverCasesOptions = {}
): Promise<ResolvedCase[]> {
  if (resolution !== "executable" && resolution !== "structural") {
    throw new DummyConfigError(
      `unknown resolution mode ${JSON.stringify(resolution)} (use "executable" to run a case, "structural" to validate one)`,
    );
  }
  const target = normalizeRuntimeTarget(runtimeTarget);
  // --base-url is the one-field form of the same setting, so accepting both
  // would be a precedence puzzle rather than a configuration.
  if (target && baseUrl !== null && baseUrl !== undefined) {
    throw new DummyConfigError(
      "both a base URL and a runtime target were supplied — --base-url is the one-field form of runtimeTarget.base_url, so pass exactly one",
    );
  }
  const found = new Map<string, string>(); // abs case file → suite root the user named
  const strays = new Set<string>(); // case-shaped yamls outside any suite root / stories/ dir
  for (const p of paths) {
    const abs = path.resolve(p);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      throw new DummyConfigError(`no such path: ${p}`);
    }
    if (st.isDirectory()) {
      const walked = await walkCases(abs, abs);
      for (const f of walked.cases) if (!found.has(f)) found.set(f, abs);
      for (const s of walked.strays) strays.add(s);
    } else {
      // An explicitly named file is always a case, wherever it lives — naming it is intent.
      if (path.basename(abs) === DEFAULTS_FILE)
        throw new DummyConfigError(`${p} is a defaults file, not a test case`);
      if (!found.has(abs)) found.set(abs, path.dirname(abs));
    }
  }

  await warnStrays(strays, found);

  const registries = new Map<string, AssertionRegistry>();
  const registryFor = async (caseFile: string): Promise<AssertionRegistry> => {
    const root = suiteRootFor(caseFile);
    if (!registries.has(root)) registries.set(root, await loadAssertions(root));
    return registries.get(root)!; // SAFETY: the immediately preceding has() check proves this cache entry exists
  };

  const cases: ResolvedCaseDraft[] = [];
  for (const [file, root] of found) {
    const registry = await registryFor(file);
    const c = await resolveCase(file, root, { baseUrl, registry, env, runtimeTarget: target, resolution });
    if (tags.length === 0 || c.tags.some((t) => tags.includes(t))) cases.push(c);
  }

  // Two files can resolve to the SAME id — a `stories/` grouping dir is dropped
  // from the id (see resolveCase), so `stories/foo.yaml` and `foo.yaml` both id as
  // "foo". They would then share one baseline + run dir and silently clobber each
  // other. Catch it loudly, naming both files (uphold "loud, never silently
  // skipped"). Checked before fan-out; a study's per-persona ids stay distinct.
  const byId = new Map<string, ResolvedCaseDraft>();
  for (const c of cases) {
    const prior = byId.get(c.id);
    if (prior) {
      const rel = (f: string): string => path.relative(process.cwd(), f);
      throw new DummyConfigError(
        `two case files resolve to the same id "${c.id}": ${rel(prior.file)} and ${rel(c.file)} — ` +
        `a "stories/" grouping directory is dropped from the id, so stories/${c.id}.yaml and ${c.id}.yaml collide. ` +
        `Rename or move one so they get distinct ids (baselines and run dirs are keyed on the id).`,
      );
    }
    byId.set(c.id, c);
  }

  // Discovery personas fan-out: one instance per persona reference, id
  // <id>@<ref>, singular persona overridden.
  const expanded: ResolvedCaseDraft[] = [];
  for (const { personas, ...c } of cases) {
    if (personas) {
      for (const ref of personas) expanded.push({ ...c, id: `${c.id}@${ref}`, persona: ref });
    } else expanded.push(c);
  }
  // --id filter runs AFTER fan-out so a discovery study's `<id>@<persona>` ids
  // exist: `--id study` matches every persona (the `<id>@` prefix), `--id
  // study@novice` matches just one. Exact-id match otherwise. AND-of-ORs not
  // needed (mirrors tags) — a case matches if its id is in the requested set.
  const selected =
    ids.length === 0
      ? expanded
      : expanded.filter((c) => ids.some((want) => c.id === want || c.id.startsWith(`${want}@`)));
  return selected.sort((a, b) => a.id.localeCompare(b.id)) as unknown as ResolvedCase[]; // SAFETY: resolveCase validates and constructs the exported post-validation union
}

/**
 * Case files under a named directory, split into { cases, strays }. A *.yaml is
 * a case only when it sits directly in a suite root (the named dir), or any
 * descendant holding a playtest.yaml, or anywhere under a stories/ directory.
 * Other directories are still traversed — to find nested suites and their
 * stories — but a case-shaped *.yaml found loose in one is a STRAY: reported by
 * warnStrays, never run. personas/ and results/ are skipped entirely.
 *
 * A loose *.yaml at a suite root is a case only when it is case-shaped (carries a
 * string `story`, the required case-only key). A non-case yaml sitting there — a
 * repo-root lockfile, a `_RepoMetadata.yaml` — is not ours and is skipped
 * silently, NEVER validated: naming a dir that merely CONTAINS a suite (or is a
 * repo root with a nested suite) must not choke on an unrelated sibling yaml.
 * Under an explicit `stories/` dir every *.yaml is still a case (a story-less one
 * there errors — its location is the author's intent).
 */
async function walkCases(
  dir: string,
  namedRoot: string
): Promise<{ cases: string[]; strays: string[] }> {
  const cases: string[] = [];
  const strays: string[] = [];
  // Naming a stories/ dir directly means "everything under here is a case".
  if (path.basename(dir) === "stories") await collectStories(dir, cases);
  else await collectFrom(dir, dir === namedRoot, cases, strays);
  return { cases, strays };
}

async function collectFrom(
  dir: string,
  collectRoot: boolean,
  cases: string[],
  strays: string[]
): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (skipDiscoveryEntry(name)) continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) {
      if (name === "stories") await collectStories(full, cases);
      else await collectFrom(full, existsSync(path.join(full, DEFAULTS_FILE)), cases, strays);
    } else if (isCaseFile(name) && (await isCaseShaped(full))) {
      // Case-shaped and at a suite root → a case; case-shaped but loose elsewhere
      // → a stray (warnStrays). A non-case yaml is neither: skipped above.
      (collectRoot ? cases : strays).push(full);
    }
  }
}

/** Every case file beneath a stories/ subtree, at any depth. */
async function collectStories(dir: string, cases: string[]): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (skipDiscoveryEntry(name)) continue;
    const full = path.join(dir, name);
    if (entry.isDirectory()) await collectStories(full, cases);
    else if (isCaseFile(name)) cases.push(full);
  }
}

function isCaseFile(name: string): boolean {
  return (
    name.endsWith(".yaml") &&
    name !== DEFAULTS_FILE &&
    !name.includes(".baseline.") &&
    !name.includes(".healed.")
  );
}

/**
 * Does this *.yaml carry a string `story` — the required, case-only key? That is
 * the discriminator for "is this ours": `story` is rejected in a playtest.yaml
 * (defaults.schema.json) and required in every case, so a yaml without one is not
 * a playtest case (a lockfile, a repo-metadata sidecar) and must not be validated
 * as one. A yaml that won't even parse is likewise "not recognisably ours" —
 * skipped, not thrown (a directly-named case file still errors loudly; naming it
 * is intent). Shared by collectFrom (what to collect) and warnStrays (what to warn).
 */
async function isCaseShaped(file: string): Promise<boolean> {
  let doc: any; // SAFETY: discovery probe reads untrusted YAML and narrows only the story discriminator
  try {
    doc = YAML.parse(await fs.readFile(file, "utf8"));
  } catch {
    return false;
  }
  return !!doc && typeof doc === "object" && typeof doc.story === "string";
}

/**
 * A misplaced case must be loud, never silently skipped: warn (don't throw) for
 * each case-shaped yaml that sits outside a suite root / stories/ dir. Files
 * that don't parse as a case (no string `story`) are left alone — they aren't ours.
 */
async function warnStrays(
  strays: Set<string>,
  found: Map<string, string>
): Promise<void> {
  // Every entry in `strays` was already confirmed case-shaped by collectFrom
  // (it only pushes files that pass isCaseShaped), so no re-check is needed here.
  for (const file of strays) {
    if (found.has(file)) continue;
    console.warn(
      `playtest: ${path.relative(process.cwd(), file)} looks like a case but is outside the suite root and stories/ — it will not run. Move it under <suite>/stories/ to include it.`,
    );
  }
}
