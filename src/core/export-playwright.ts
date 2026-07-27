// One-way Playwright export: render an accepted baseline's action track as a
// standalone @playwright/test spec. See docs/contracts/interfaces.md#playwright-export.
//
// This is an ESCAPE HATCH and an INSPECTION TOOL, never an execution mode.
// Playtest writes the file and forgets it: it is never read back, never run, and
// never healed. Regenerating after a baseline change overwrites it.
//
// The generator is pure — text in, text out, no I/O and no Playwright import —
// so it is equally callable from the CLI and from the hosted control plane.
import { actionOf, actionTrack } from "./trajectory.ts";
import type { StepAction, StepEnvelope } from "./trajectory.ts";
import type { PerfConfig } from "./types.ts";

type DynamicValue = any; // TODO(ts): generator accepts legacy envelope and manifest fields while rendering strings only

interface ExportCase {
  id: string;
  file?: string;
  story?: string;
  success?: Array<Record<string, unknown>>;
  perf?: PerfConfig;
  env?: {
    base_url?: string | null;
    cookies?: unknown;
  };
  _assertions?: {
    routing?: Map<string, { name: string }>;
  };
}

interface BaselineMeta {
  pins?: Record<string, unknown>;
  run_id?: string;
  accepted_at?: string;
  story_hash?: string;
}

interface ExportResult {
  filename: string;
  code: string;
  notes: string[];
}

type SuccessCriterion = Record<string, unknown>;
type AssertionRouting = Map<string | undefined, { name: string }> | null;

/** Emitted spec dialect. Bumped when the generated shape changes materially. */
export const EXPORT_FORMAT = "playwright-spec-v1";

/** Max characters of an actor thought carried into a step comment. */
const THOUGHT_MAX = 100;

/** The scroll delta the web driver applies per scroll step (drivers/web.ts #perform). */
const SCROLL_DELTA = 600;

/**
 * Success-criterion kinds that reach a runtime assertion in the emitted spec.
 * Everything else is emitted as a visible comment plus a note — a silently
 * thinner gate would make the export a trust liability instead of a trust
 * feature (docs/contracts/interfaces.md#playwright-export).
 */
const ASSERTED_KINDS: Set<string | undefined> = new Set(["url_matches", "element_exists", "api_called", "console_errors"]);

/** JS/TS string literal for an arbitrary value. JSON.stringify escapes quotes,
 *  backslashes and control characters — the whole escaping story lives here. */
function js(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

/** A thought flattened to one comment-safe line. */
function comment(text: unknown): string {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  return flat.length > THOUGHT_MAX ? `${flat.slice(0, THOUGHT_MAX - 1)}…` : flat;
}

/** The one kind key of a success entry (`label` is cosmetic — config.ts guarantees one). */
function kindOf(criterion: SuccessCriterion): [string, unknown] | [] {
  return Object.entries(criterion).find(([k]) => k !== "label") ?? [];
}

/**
 * `<out>/<case-id>.spec.ts`. A nested case id keeps its path segments (stable
 * diffs, mirrors the suite tree); `@` from a discovery persona fan-out and any
 * other path-hostile character collapses to `-`.
 */
export function specFilename(caseId: string): string {
  const safe = String(caseId)
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .map((seg) => seg.replace(/[^A-Za-z0-9._-]/g, "-"))
    .join("/");
  return `${safe || "case"}.spec.ts`;
}

/**
 * Render one web case's accepted baseline as a Playwright spec.
 *
 * v1 emits every locator as the RAW saved string passed to `page.locator()` —
 * byte-identical to what act mode executes (drivers/web.ts executeLocator), at
 * the cost of Playwright's legacy selector-engine dialect rather than
 * `getByRole`. Translating to user-facing locators is a deliberate follow-up
 * (docs/ROADMAP.md), kept out of v1 to ship the provably-equivalent version
 * first — NOT because the translation is unsound. It is sound, with one catch
 * worth recording so it is not re-derived wrongly: the saved forms are exact
 * and case-sensitive while `getByRole`/`getByText` default to
 * case-insensitive substring, so an equivalent translation MUST pass
 * `exact: true` — `role=x[name="y"]` → `getByRole("x", { name: "y", exact:
 * true })`, `text="y"` → `getByText("y", { exact: true })`,
 * `[data-testid="y"]` → `getByTestId("y")`. Only the structural CSS fallback
 * has no idiomatic form and must stay a raw `page.locator()`.
 *
 * @param {object} args
 * @param {object} args.caseCfg  resolved case (config.ts resolveCase)
 * @param {object[]} args.envelopes  the accepted baseline's step envelopes
 * @param {object|null} [args.meta]  the baseline meta sidecar (.baseline.json)
 * @param {string|null} [args.sourcePath]  case path shown in the header + regenerate hint
 * @returns {{ filename: string, code: string, notes: string[] }}
 */
export function exportSpec({
  caseCfg,
  envelopes,
  meta = null,
  sourcePath = null
}: {
  caseCfg: ExportCase;
  envelopes: StepEnvelope[];
  meta?: BaselineMeta | null;
  sourcePath?: string | null;
}): ExportResult {
  const notes: string[] = [];
  const steps = actionTrack(envelopes ?? []);
  const success = caseCfg.success ?? [];
  const perf = caseCfg.perf ?? {};
  const routing = caseCfg._assertions?.routing ?? null;

  // Which collectors the gate actually needs. Emitting them unconditionally
  // would trip noUnusedLocals in a strict consumer tsconfig, and would clutter a
  // file whose whole job is to be read.
  const kinds = success.map((c) => kindOf(c)[0]);
  const needsRequests = kinds.includes("api_called");
  const needsConsole = kinds.includes("console_errors");
  const needsGlob = kinds.includes("url_matches") || needsRequests;
  const cookies = Array.isArray(caseCfg.env?.cookies) ? caseCfg.env.cookies : null;
  const needsContext = Boolean(cookies?.length);

  const out: string[] = [];
  out.push(...header({ caseCfg, meta, sourcePath, steps, success }));
  out.push(`import { test, expect } from "@playwright/test";`);
  out.push("");
  out.push(`const BASE_URL = process.env.PLAYTEST_BASE_URL ?? ${js(caseCfg.env?.base_url ?? "")};`);
  out.push("");
  if (needsGlob) {
    out.push(`/** Playtest gate globs: \`*\` matches any run, \`?\` one character, anchored. */`);
    out.push(`function globToRegExp(glob: string): RegExp {`);
    out.push(`  const re = String(glob)`);
    out.push(`    .replace(/[.+^\${}()|[\\]\\\\]/g, "\\\\$&")`);
    out.push(`    .replace(/\\*/g, ".*")`);
    out.push(`    .replace(/\\?/g, ".");`);
    out.push(`  return new RegExp(\`^\${re}$\`);`);
    out.push(`}`);
    out.push("");
  }

  const args = needsContext ? "{ page, context }" : "{ page }";
  out.push(`test(${js(caseCfg.id)}, async (${args}) => {`);
  out.push(...setup({ cookies, needsRequests, needsConsole }));
  out.push(...body(steps, notes));
  out.push(...gate({ success, perf, routing, notes }));
  out.push(`});`);
  out.push("");

  return { filename: specFilename(caseCfg.id), code: out.join("\n"), notes };
}

function header({
  caseCfg,
  meta,
  sourcePath,
  steps,
  success
}: {
  caseCfg: ExportCase;
  meta: BaselineMeta | null;
  sourcePath: string | null;
  steps: StepEnvelope[];
  success: SuccessCriterion[];
}): string[] {
  const pins = meta?.pins ?? {};
  const pinBits = [pins.prompts_version, pins.step_schema_version ? `step_schema ${pins.step_schema_version}` : null, pins.actor_model ? `actor ${pins.actor_model}` : null].filter(Boolean);
  const where = sourcePath ?? caseCfg.file ?? caseCfg.id;
  const lines = [
    `// GENERATED by \`playtest export\` — do not edit.`,
    `//`,
    `// Case:         ${caseCfg.id}${where && where !== caseCfg.id ? `  (${where})` : ""}`,
  ];
  const story = comment(caseCfg.story);
  if (story) lines.push(`// Story:        ${story}`);
  if (meta?.run_id) {
    lines.push(`// Baseline run: ${meta.run_id}${meta.accepted_at ? ` (accepted ${meta.accepted_at})` : ""}`);
  }
  if (meta?.story_hash) lines.push(`// Story hash:   ${meta.story_hash}`);
  if (pinBits.length) lines.push(`// Pins:         ${pinBits.join(" · ")}`);
  lines.push(
    `// Contents:     ${steps.length} recorded step(s), ${success.length} success criterion(a)`,
    `//`,
    `// Regenerate after any baseline change:`,
    `//   playtest export ${where}`,
    `//`,
    `// This file is a ONE-WAY snapshot of the saved path. Playtest never reads it`,
    `// back and it will NOT heal when the app changes — a broken selector here stays`,
    `// broken. The living test is the YAML case plus its accepted baseline; this`,
    `// spec is a frozen copy of what one green run executed.`,
    `//`,
    `// Every locator below is the exact string the harness replays, written in`,
    `// Playwright's selector-engine dialect, so this spec drives the app the same`,
    `// way \`playtest\` does.`,
    ``,
  );
  return lines;
}

function setup({
  cookies,
  needsRequests,
  needsConsole
}: {
  cookies: Array<{ name?: unknown; value?: unknown }> | null;
  needsRequests: boolean;
  needsConsole: boolean;
}): string[] {
  const out = [`  // ---- session setup (mirrors the Playtest web driver) ----`];
  if (needsRequests) {
    out.push(`  const requests: { method: string; path: string }[] = [];`);
    out.push(`  page.on("request", (r) => {`);
    out.push(`    let pathname = r.url();`);
    out.push(`    try {`);
    out.push(`      pathname = new URL(r.url()).pathname;`);
    out.push(`    } catch {}`);
    out.push(`    requests.push({ method: r.method(), path: pathname });`);
    out.push(`  });`);
  }
  if (needsConsole) {
    out.push(`  let consoleErrors = 0;`);
    out.push(`  page.on("console", (m) => {`);
    out.push(`    if (m.type() === "error") consoleErrors += 1;`);
    out.push(`  });`);
    out.push(`  page.on("pageerror", () => {`);
    out.push(`    consoleErrors += 1;`);
    out.push(`  });`);
  }
  if (cookies?.length) {
    out.push(`  await context.addCookies([`);
    for (const c of cookies) {
      out.push(`    { name: ${js(c.name)}, value: ${js(c.value)}, url: BASE_URL },`);
    }
    out.push(`  ]);`);
  }
  out.push(`  await page.goto(BASE_URL);`);
  out.push(``);
  return out;
}

function body(steps: StepEnvelope[], notes: string[]): string[] {
  const out = [`  // ---- the saved path ----`];
  if (!steps.length) {
    out.push(`  // (the actor finished this journey without acting on the page)`);
    out.push(``);
    return out;
  }
  for (const env of steps) {
    const action = actionOf(env) ?? {};
    const locator = env.resolution?.locator ?? null;
    const label = comment(env.agent?.thought);
    out.push(``);
    out.push(`  // step ${env.step ?? "?"} · ${action.type}${label ? ` — ${label}` : ""}`);
    out.push(...emitAction(action, locator, env, notes));
  }
  out.push(``);
  return out;
}

/** The verb translation table (drivers/web.ts #perform). */
function emitAction(action: StepAction, locator: string | null, env: StepEnvelope, notes: string[]): string[] {
  const L = locator === null ? null : `page.locator(${js(locator)})`;
  switch (action.type) {
    case "click":
      return [`  await ${L}.click();`];
    case "type": {
      const lines = [`  await ${L}.fill(${js(action.text)});`];
      if (action.submit) lines.push(`  await ${L}.press("Enter");`);
      return lines;
    }
    case "select":
      // The harness clicks non-<select> targets (radios, option cards), then
      // tries the option LABEL first and falls back to its VALUE.
      return [
        `  if (await ${L}.evaluate((el) => el.tagName) !== "SELECT") {`,
        `    await ${L}.click();`,
        `  } else {`,
        `    await ${L}`,
        `      .selectOption({ label: ${js(action.value)} })`,
        `      .catch(() => ${L}.selectOption(${js(action.value)}));`,
        `  }`,
      ];
    case "scroll": {
      const dy = action.direction === "up" ? -SCROLL_DELTA : SCROLL_DELTA;
      if (locator) {
        // Mirror the harness: the ref anchors the scroll to its nearest
        // scrollable ancestor; an inert chain falls back to a page wheel
        // (Element.scrollBy on a label/heading is a silent no-op).
        return [
          `  if (!(await ${L}.evaluate((el, d) => {`,
          `    for (let n = el; n; n = n.parentElement) {`,
          `      if (n === document.documentElement || n === document.body) break;`,
          `      const s = getComputedStyle(n);`,
          `      const room = d > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0;`,
          `      if (n.scrollHeight - n.clientHeight > 1 && /(auto|scroll|overlay)/.test(s.overflowY) && room) {`,
          `        n.scrollBy(0, d);`,
          `        return true;`,
          `      }`,
          `    }`,
          `    return false;`,
          `  }, ${dy}))) await page.mouse.wheel(0, ${dy});`,
        ];
      }
      notes.push(
        `step ${env.step ?? "?"}: an unanchored scroll is approximated as a page wheel — the harness first ` +
          `picks the topmost open dialog's scroller or the largest scrollable element (pickScrollTarget)`,
      );
      return [
        `  // APPROXIMATE: the harness scrolls the topmost dialog / largest scrollable`,
        `  // element first (pickScrollTarget) and only falls back to the wheel.`,
        `  await page.mouse.wheel(0, ${dy});`,
      ];
    }
    case "navigate":
      return [`  await page.goto(new URL(${js(action.url)}, BASE_URL).href);`];
    case "back":
      return [`  await page.goBack();`];
    case "wait": {
      const ms = Math.round(Math.min(10, Math.max(0.1, Number(action.seconds) || 1)) * 1000);
      return [`  await page.waitForTimeout(${ms});`];
    }
    default:
      // actionTrack only yields executed steps, so an unknown verb means the
      // baseline outran this exporter. Say so in the file rather than drop it.
      notes.push(`step ${env.step ?? "?"}: action "${action.type}" has no Playwright translation and was left as a comment`);
      return [`  // NOT EXPORTED: unsupported action ${js(action.type)} — ${js(JSON.stringify(action))}`];
  }
}

function gate({
  success,
  perf,
  routing,
  notes
}: {
  success: SuccessCriterion[];
  perf: PerfConfig;
  routing: AssertionRouting;
  notes: string[];
}): string[] {
  const out = [`  // ---- success criteria (the gate) ----`];
  if (!success.length && !Object.keys(perf).length) {
    out.push(`  // (this case declares no success criteria)`);
    return out;
  }
  // Per-prefix counters: the prefixes already keep the names distinct, and a
  // shared counter would read like a numbering bug (urlRe1 next to apiRe2).
  const seq = { url: 0, api: 0 };
  for (const criterion of success) {
    const [kind, value] = kindOf(criterion);
    // A structured value (an operation selector, an invariant policy) would
    // render as "[object Object]" in the comment that documents the criterion.
    // The export is a record of what Playtest checks, so show the real thing.
    const spec = `${kind}: ${value && typeof value === "object" ? JSON.stringify(value) : value}`;
    out.push(``);
    out.push(`  // ${spec}`);
    if (criterion.label) out.push(`  // (${criterion.label})`);

    if (!ASSERTED_KINDS.has(kind)) {
      out.push(...unexported(kind, value, routing, notes));
      continue;
    }

    switch (kind) {
      case "url_matches": {
        const name = `urlRe${++seq.url}`;
        out.push(`  const ${name} = globToRegExp(${js(value)});`);
        out.push(`  await expect`);
        out.push(`    .poll(() => {`);
        out.push(`      const url = page.url();`);
        out.push(`      let pathname: string | null = null;`);
        out.push(`      try {`);
        out.push(`        pathname = new URL(url).pathname;`);
        out.push(`      } catch {}`);
        out.push(`      return ${name}.test(url) || (pathname !== null && ${name}.test(pathname));`);
        out.push(`    })`);
        out.push(`    .toBe(true);`);
        break;
      }
      case "element_exists":
        // The gate is `count() > 0` on the settled page, NOT visibility.
        // not.toHaveCount(0) is the auto-retrying form of exactly that.
        out.push(`  await expect(page.locator(${js(value)})).not.toHaveCount(0);`);
        break;
      case "api_called": {
        const [method, ...rest]: DynamicValue = String(value).trim().split(/\s+/);
        if (!rest.length) {
          notes.push(`api_called "${method}" is missing a path glob (e.g. "POST /api/todos") — emitted as a comment`);
          out.push(`  // NOT EXPORTED: api_called is missing a path glob — this criterion fails in Playtest too.`);
          break;
        }
        const name = `apiRe${++seq.api}`;
        out.push(`  const ${name} = globToRegExp(${js(rest.join(" "))});`);
        out.push(`  await expect`);
        out.push(`    .poll(() => requests.some((r) => r.method.toUpperCase() === ${js(method.toUpperCase())} && ${name}.test(r.path)))`);
        out.push(`    .toBe(true);`);
        break;
      }
      case "console_errors":
        out.push(`  // Soft (advisory) in Playtest; HARD here — an exported spec has no soft tier.`);
        out.push(`  expect(consoleErrors).toBeLessThanOrEqual(${Number(value) || 0});`);
        break;
    }
  }

  for (const [key, threshold] of Object.entries(perf)) {
    out.push(``);
    out.push(`  // NOT EXPORTED — perf budget over Playtest's own telemetry: perf.${key} ${threshold}`);
    notes.push(`perf.${key} (${threshold}) has no Playwright equivalent — emitted as a comment`);
  }
  return out;
}

/** A criterion with no runtime equivalent: annotate it, never drop it. */
function unexported(kind: string | undefined, value: unknown, routing: AssertionRouting, notes: string[]): string[] {
  if (kind === "assert") {
    notes.push(`assert "${comment(value)}" is LLM-judged in Playtest — emitted as a test annotation, not an assertion`);
    return [
      `  // UNCHECKED — an LLM judges this in Playtest; there is no runtime equivalent.`,
      `  test.info().annotations.push({`,
      `    type: "playtest-assert",`,
      `    description: ${js(value)},`,
      `  });`,
    ];
  }
  if (kind === "accessibility_violations") {
    notes.push(`accessibility_violations (${value}) has no Playwright equivalent — emitted as a comment (see @axe-core/playwright)`);
    return [
      `  // NOT EXPORTED: Playtest counts WCAG violations per step with axe-core.`,
      `  // The closest Playwright equivalent is @axe-core/playwright, which you would`,
      `  // wire up yourself: expect((await new AxeBuilder({ page }).analyze()).violations)`,
      `  //   .toHaveLength(0);  // Playtest's budget: ${Number(value) || 0}`,
    ];
  }
  const owner = routing?.get?.(kind);
  if (owner) {
    notes.push(`custom assertion "${kind}" (module ${owner.name}) is not exportable — emitted as a comment`);
    return [`  // NOT EXPORTED: custom assertion ${js(kind)} — see assertions/${owner.name}/ in the suite.`];
  }
  notes.push(`success criterion "${kind}" is not exportable — emitted as a comment`);
  return [`  // NOT EXPORTED: ${kind} has no Playwright translation.`];
}
