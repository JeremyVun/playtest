import { pathnameOf } from "./drivers/har.ts";
import { parseOperationSelector, selectorSpec } from "./openapi.ts";
import { statusMatchesPattern } from "./match.ts";
import { evaluateInvariant, parseInvariantPolicy, policySpec } from "./invariants.ts";

type DynamicValue = any; // SAFETY: gate context combines driver-specific envelopes, HAR, OpenAPI, and custom assertion evidence

// Soft checks still fail the run (status "fail", exit 1) but do NOT block
// baseline acceptance: an agent that genuinely completed the journey while the
// app logged a console error or breached a latency budget shouldn't force a
// re-record. console_errors and the perf thresholds are advisory by nature
// (the app's correctness/latency, not whether the user reached the goal), so
// they default to soft; every other kind is a hard correctness gate. There is
// no per-criterion override — the kind decides
// (see docs/contracts/engine.md#gates-and-custom-assertions).
// severityOf only ever sees SUCCESS kinds; perf is a separate top-level case key
// whose own loop hardcodes soft, so it isn't listed here.
const SOFT_KINDS: Set<string | undefined> = new Set(["console_errors"]);
const severityOf = (kind: string | undefined) => (SOFT_KINDS.has(kind) ? "soft" : "hard");

// Inheritable kinds: a check whose verdict is fixed by the (unchanged) trajectory
// but is expensive and/or non-deterministic to recompute, so a clean act replay
// (no per-step drift; docs/contracts/engine.md#act-and-heal) reuses the verdict
// saved on the baseline instead of
// re-running it. `assert` is the canonical one — an LLM judging a frozen snapshot
// can flip its answer run to run. Deterministic built-ins (url_matches, api_called,
// …) are NEVER inheritable: they're cheap and they ARE the regression catch.
// FUTURE: a vision pixel-diff kind goes here too — this set is the single seam, so
// adding a kind (or a custom-assertion opt-in below) is the only change needed.
const INHERITABLE_BUILTIN_KINDS: Set<string | undefined> = new Set(["assert"]);
const REQUEST_DEDUP_SEPARATOR = "\0";

/**
 * Is this check kind eligible to reuse a saved baseline verdict on a clean replay?
 * Built-ins: only the kinds in INHERITABLE_BUILTIN_KINDS. Custom assertions: opt-in
 * via `inheritable` on the assertion module (default true — assertions.ts validates
 * the type). The gate is the single authority on inheritability so the runner and
 * future kinds can't drift from it.
 */
export function isInheritable(kind: string | undefined, routing: DynamicValue): boolean {
  if (INHERITABLE_BUILTIN_KINDS.has(kind)) return true;
  const owner = routing?.get(kind);
  if (owner) return owner.assertion.inheritable !== false;
  return false;
}

/**
 * Evaluate every success criterion, then every perf threshold, then every
 * advisory `observe:` policy. Never throws; a check that errors becomes a failed
 * check.
 * @param {object} resolvedCase
 * @param {{ driver: object, harEntries: object[], consoleErrorCount: number,
 *          trajectory: object[], finalUrl: string,
 *          checkAssertion: ((claim: string) => Promise<{pass: boolean, detail: string}>) | null,
 *          routing?: Map<string, {name: string, assertion: object}>,
 *          evidence?: Record<string, unknown>,
 *          spec?: object|null,
 *          observe?: ((req: {method: string, path: string}) => Promise<object>)|null,
 *          inherited?: Map<string, {pass: boolean, detail: string}> }} ctx
 * routing/evidence: custom assertions (a registered assertion success key
 * dispatches to its verdict() over the gathered evidence). evaluateGate reads
 * captured evidence and does no live I/O of its own — with one bounded
 * exception: an `invariant:` policy that declares `observe: true` may call
 * ctx.observe, the runner-supplied READ-ONLY request issuer
 * (docs/contracts/engine.md#invariant-policies). It issues GET/HEAD only, its
 * traffic is quarantined out of every other gate kind, and it can never mutate.
 * inherited: on a clean act replay only
 * (docs/contracts/engine.md#act-and-heal), the baseline's saved verdicts
 * keyed by spec ("kind: value"); an inheritable check (isInheritable) reuses its
 * prior verdict instead of re-running, marked { inherited: true }. Absent on
 * record/heal/legacy — every check runs live.
 * @returns {Promise<{ pass, hardPass, checks: {kind, severity, spec, label?, pass, applicable, detail, steps?, inherited?}[], advisory?: object[] }>}
 *   pass = all checks pass (drives status/exit). hardPass = all HARD checks pass
 *   (drives baseline acceptance — a soft-only failure still saves the baseline).
 *   advisory = the `observe:` policies' results, same check shape; they never
 *   contribute to pass/hardPass.
 *   steps = the step numbers whose actions produced the requests an invariant
 *   violation is about; absent when no step owns them or the check is not an
 *   invariant policy.
 */
export async function evaluateGate(resolvedCase: DynamicValue, ctx: DynamicValue): Promise<DynamicValue> {
  const checks: DynamicValue[] = [];
  // The recorded request trace, built once: every request the run made, paired
  // with its HAR twin for bodies. Observation traffic is already excluded (the
  // runner filters tagged entries out of harEntries), so no gate kind can see it.
  const gctx = { ...ctx, trace: selectableRequests(ctx), match: resolvedCase.match ?? null };

  for (const criterion of resolvedCase.success ?? []) {
    // The check kind is the first key that isn't the optional cosmetic `label`
    // (config.ts guarantees exactly one such key). `label` rides along on the
    // check for presentation (the clip summary card) — it never touches the verdict.
    const [kind, value]: DynamicValue = Object.entries(criterion).find(([k]) => k !== "label") ?? [];
    const { label } = criterion;
    const spec = specKeyFor(kind, value);
    const base = { kind, severity: severityOf(kind), spec, ...(label ? { label } : {}) };
    // Clean act replay (docs/contracts/engine.md#act-and-heal): the trajectory
    // is provably unchanged, so reuse the
    // verdict the baseline saved for an inheritable check (assert / opted-in custom
    // assertion) instead of re-running it. ctx.inherited is a Map<spec,{pass,detail}>
    // passed ONLY on a clean replay; absent ⇒ everything runs live (record/heal, or
    // a legacy baseline with no saved verdict — it self-heals on the next accept).
    const prior = ctx.inherited?.get(spec);
    if (prior && isInheritable(kind, ctx.routing)) {
      checks.push({ ...base, pass: Boolean(prior.pass), applicable: true, detail: prior.detail ?? "", inherited: true });
      continue;
    }
    try {
      const result = await checkSuccess(kind, value, gctx);
      // Applicability is a first-class outcome
      // (docs/contracts/engine.md#invariant-policies): a policy declared under
      // `success:` that found no qualifying trace has NOT held, so it fails with
      // the policy's own actionable detail rather than passing vacuously. Kinds
      // that cannot be inapplicable report applicable: true.
      const applicable = result.applicable !== false;
      checks.push({ ...base, ...result, applicable, pass: applicable && result.pass });
    } catch (e: DynamicValue) {
      checks.push({ ...base, pass: false, applicable: true, detail: `check error: ${e.message}` });
    }
  }

  for (const [key, threshold] of Object.entries(resolvedCase.perf ?? {})) {
    checks.push({ severity: "soft", applicable: true, ...checkPerf(key, threshold, ctx) });
  }

  // Advisory policies (docs/contracts/engine.md#invariant-policies): the sibling
  // `observe:` list takes the same policy shapes, persists as its own array in
  // the manifest's gate block, renders in the viewer, and NEVER gates. A
  // not-applicable advisory reports as such instead of failing — it is a report,
  // not a declared invariant.
  const advisory: DynamicValue[] = [];
  for (const criterion of resolvedCase.observe ?? []) {
    const [kind, value]: DynamicValue = Object.entries(criterion).find(([k]) => k !== "label") ?? [];
    const { label } = criterion;
    const base = { kind, severity: "advisory", spec: specKeyFor(kind, value), ...(label ? { label } : {}) };
    try {
      const result = await checkSuccess(kind, value, gctx);
      advisory.push({
        ...base,
        applicable: result.applicable !== false,
        pass: Boolean(result.pass),
        detail: result.detail ?? "",
        ...(result.steps?.length ? { steps: result.steps } : {}),
      });
    } catch (e: DynamicValue) {
      advisory.push({ ...base, applicable: true, pass: false, detail: `check error: ${e.message}` });
    }
  }

  return {
    pass: checks.every((c) => c.pass),
    hardPass: checks.every((c) => c.pass || c.severity === "soft"),
    checks,
    ...(advisory.length ? { advisory } : {}),
  };
}

/**
 * The stable per-criterion key. A structured operation selector or an invariant
 * policy is an object; `${value}` would render it "[object Object]" and collide
 * with every other entry on the same kind, so each object form flattens to its
 * own readable one-liner instead.
 */
function specKeyFor(kind: DynamicValue, value: DynamicValue): string {
  if (!value || typeof value !== "object") return `${kind}: ${value}`;
  return kind === "invariant" ? policySpec(value) : selectorSpec(kind, value);
}

async function checkSuccess(kind: DynamicValue, value: DynamicValue, ctx: DynamicValue): Promise<DynamicValue> {
  switch (kind) {
    case "url_matches": {
      const re = globToRegExp(value);
      const url = ctx.finalUrl ?? "";
      let pathname = null;
      try {
        pathname = new URL(url).pathname;
      } catch {}
      const pass = re.test(url) || (pathname !== null && re.test(pathname));
      return { pass, detail: pass ? `final url ${url}` : `final url ${url} does not match ${value}` };
    }

    case "element_exists":
      // screen_shows is the mobile analog of element_exists: an accessibility id /
      // predicate resolves on the final screen. Same Driver.finalPageCheck seam, the
      // mobile driver's query language (config.ts scopes screen_shows to mobile) —
      // so they share one branch, differing only in the report noun.
    case "screen_shows": {
      const noun = kind === "screen_shows" ? "screen element" : "element";
      const found = await ctx.driver.finalPageCheck(value);
      return { pass: Boolean(found), detail: found ? `${noun} present` : `no ${noun} matches ${value}` };
    }

    case "api_called": {
      const [method, ...rest]: DynamicValue = String(value).trim().split(/\s+/);
      // A bare method with no path glob would compile to an empty regex that only
      // matches an empty path — silently never hitting. Name the mistake instead.
      if (rest.length === 0) {
        return { pass: false, detail: `api_called "${method}" is missing a path glob — write e.g. "POST /api/todos"` };
      }
      const re = globToRegExp(rest.join(" "));
      // Embedded per-envelope network data is the primary source; the HAR sidecar
      // supplies (a) whole runs from before network data was embedded and (b) tail
      // requests fired after the final settle, which land in har.json but in no
      // envelope's network window (docs/contracts/artifacts.md#step-envelope).
      // Union both, de-duped by method+path, so
      // a post-settle request is still matchable without double-counting embedded
      // ones on a modern run.
      // An observation request is quarantined out of BOTH sources: an
      // observation GET must never satisfy a success criterion
      // (docs/contracts/engine.md#invariant-policies).
      const trajectory = ctx.trajectory ?? [];
      const embedded = trajectory.flatMap((e: DynamicValue) => e.network?.requests ?? []).filter((r: DynamicValue) => !r._observation);
      const harReqs = harOf(ctx).map((e: DynamicValue) => ({
        method: e.request?.method ?? "",
        url: e.request?.url ?? "",
        path: pathnameOf(e.request?.url ?? ""),
      }));
    const seen = new Set(embedded.map((r: DynamicValue) => `${r.method}${REQUEST_DEDUP_SEPARATOR}${r.path ?? pathnameOf(r.url)}`));
    const requests = embedded.concat(harReqs.filter((r: DynamicValue) => !seen.has(`${r.method}${REQUEST_DEDUP_SEPARATOR}${r.path ?? pathnameOf(r.url)}`)));
    const hits = requests.filter(
      (r: DynamicValue) =>
        r.method?.toUpperCase() === method.toUpperCase() &&
        re.test(r.path ?? pathnameOf(r.url)),
    );
    // Common authoring slip: a glob without a leading "/" (e.g. "POST api/todos")
    // anchors to ^api/todos$ and never matches the always-leading-slash request
    // paths. When nothing matched and that's the shape, point at the fix.
    const glob = rest.join(" ");
    const slashHint =
      hits.length === 0 && !glob.startsWith("/") && requests.some((r: DynamicValue) => (r.path ?? pathnameOf(r.url)).startsWith("/"))
        ? `(did you mean "/${glob}"? request paths start with "/")`
        : "";
    return {
      pass: hits.length > 0,
      detail:
        hits.length > 0
          ? `${hits.length} matching request(s), e.g. ${hits[0].method} ${hits[0].url}`
          : `no matching request among ${requests.length} request(s)${slashHint}`,
    };
  }

  case "response_status": {
    const selector = parseOperationSelector(kind, value);
    if (selector) return checkSelectedStatus(selector, ctx);
    // api, bare-string form: a response with this status — exact ("201") or a
    // class ("2xx"). Matches ANY request in the run (design "last or any"), so a
    // verification read-back after a mutation (POST 201 then GET 200) doesn't
    // flip the gate. Kept verbatim so existing suites are untouched.
    const reqs = (ctx.trajectory ?? []).flatMap((e: DynamicValue) => e.network?.requests ?? []).filter((r: DynamicValue) => !r._observation);
    const hits = reqs.filter((r: DynamicValue) => statusMatchesPattern(value, String(r.status)));
    return {
      pass: hits.length > 0,
      detail:
        hits.length > 0
          ? `${hits.length} response(s) with status ${value}, e.g. ${hits[0].method} ${hits[0].path} → ${hits[0].status}`
          : reqs.length
            ? `no response matched ${value} among ${reqs.length} request(s) (last: ${reqs[reqs.length - 1].status})`
            : "no request recorded in the run",
    };
  }

  case "response_matches": {
    const selector = parseOperationSelector(kind, value);
    if (selector) return checkSelectedBody(selector, ctx);
    // api, bare-string form: a JSON-path/value over the LAST response body (from
    // har.json, never the committed trajectory — bodies stay out of baselines).
      const body = lastResponseBody(ctx);
      if (body == null) return { pass: false, detail: "the last response had no body to match" };
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        return { pass: false, detail: "the last response body is not JSON" };
      }
      return matchJsonPath(value, json);
    }

    case "invariant": {
      // Tier-1/2 invariant policies (docs/contracts/engine.md#invariant-policies).
      // Deterministic evaluation over the recorded trace plus, at most, the
      // policy's own read-only observation. config.ts already parsed the value
      // at discovery, so a malformed policy never reaches here; re-parsing keeps
      // the gate usable standalone (and the throw becomes a failed check).
      //
      // The trace is transport-independent: on the api driver it is the story's
      // own request program, on the web driver it is what the PAGE asked for,
      // recorded in har.json. Same policies, same applicability rules — a web
      // run is never exempt (docs/contracts/engine.md#invariant-policies).
      const config = parseInvariantPolicy(value);
      const { requests, ...verdict } = await evaluateInvariant(config, {
        trace: ctx.trace ?? selectableRequests(ctx),
        spec: ctx.spec ?? null,
        match: ctx.match ?? null,
        observe: typeof ctx.observe === "function" ? ctx.observe : null,
      });
      // Step citation: the offending requests, resolved back to the steps whose
      // actions produced them. `requests` itself carries bodies and never leaves
      // the gate — only the step numbers persist.
      const steps = stepsOf(requests);
      return steps.length ? { ...verdict, steps } : verdict;
    }

    case "assert": {
      if (typeof ctx.checkAssertion !== "function") {
        return { pass: false, detail: "assert requires a model; no LLM configured" };
      }
      const { pass, detail } = await ctx.checkAssertion(value);
      return { pass: Boolean(pass), detail: detail ?? "" };
    }

    case "console_errors": {
      // web only (config.ts scopes it): a deterministic correctness gate, not a
      // perf budget — the run must finish with no more than `value` console errors.
      const count = ctx.consoleErrorCount ?? 0;
      const pass = count <= Number(value);
      // Carry the captured messages ({type,text}[]) whenever any were seen — even
      // on a PASS (a nonzero budget like `console_errors: 2` passes with 2 errors,
      // and the user still wants to see them). Only attached when non-empty, so a
      // clean check's shape (and a legacy run's) is unchanged. detail stays the
      // count string (the CLI prints it).
      const errors = ctx.consoleErrorLog ?? [];
      return { pass, detail: `${count} console error(s)`, ...(errors.length ? { errors } : {}) };
    }

    case "accessibility_violations": {
      // web only (config.ts scopes it): always-on axe-core captures WCAG
      // violations per step (envelope.axe); the gate caps the TOTAL violation
      // node count summed across the run — every WCAG violation on each step's
      // page, not just the element the agent touched. Deterministic, HARD (not in
      // SOFT_KINDS). Same envelope-summing pattern as api_called; no new ctx
      // field. Envelopes without `axe` (non-web, failed-axe, state-drift)
      // contribute 0.
      const trajectory = ctx.trajectory ?? [];
      const total = trajectory.reduce((sum: number, e: DynamicValue) => sum + (e.axe?.counts?.total ?? 0), 0);
      return {
        pass: total <= Number(value),
        detail: `${total} WCAG violation(s)`,
      };
    }

    default: {
      // A suite custom-assertion key (config.ts registered it and validated it
      // into the schema): dispatch to the owning assertion's verdict(), judging the
      // evidence gather() captured during the observing phase. The value string
      // is opaque to core — the assertion owns its grammar. verdict throwing is
      // caught by evaluateGate (a failed check); a non-{pass} return is a failed
      // check with a clear assertion-named detail. Severity is hard (severityOf:
      // assertion keys aren't in SOFT_KINDS).
      // See docs/contracts/engine.md#gates-and-custom-assertions.
      const owner = ctx.routing?.get(kind);
      if (owner) {
        const verdict = owner.assertion.verdict({ key: kind, value, evidence: ctx.evidence?.[owner.name] });
        if (!verdict || typeof verdict !== "object" || typeof verdict.pass !== "boolean") {
          return { pass: false, detail: `assertion "${owner.name}" returned ${JSON.stringify(verdict)} (expected { pass, detail })` };
        }
        return { pass: verdict.pass, detail: verdict.detail ?? "" };
      }
      return { pass: false, detail: `unknown success criterion "${kind}"` };
    }
  }
}

function checkPerf(key: string, threshold: DynamicValue, ctx: DynamicValue): DynamicValue {
  try {
    if (key === "lcp_ms" || key === "input_to_paint_ms") {
      const { op, limit } = parseThreshold(threshold);
      const spec = `perf.${key} ${op} ${limit}`;
      const values = (ctx.trajectory ?? [])
        .map((e: DynamicValue) => (key === "lcp_ms" ? e.perf?.nav?.lcp_ms : e.perf?.input_to_paint_ms))
        .filter((v: DynamicValue) => typeof v === "number");
      if (values.length === 0) {
        return { kind: "perf", spec, pass: false, detail: `no ${key} measurements in trajectory` };
      }
      const worst = Math.max(...values);
      return { kind: "perf", spec, pass: compare(worst, op, limit), detail: `worst ${key} = ${worst}` };
    }

    return { kind: "perf", spec: `perf.${key}`, pass: false, detail: `unknown perf key "${key}"` };
  } catch (e: DynamicValue) {
    return { kind: "perf", spec: `perf.${key} ${threshold}`, pass: false, detail: `check error: ${e.message}` };
  }
}

/** "< 2500" / "<= 2500" / ">= 10" / "> 10"; a bare number means "<= n". */
function parseThreshold(threshold: DynamicValue): { op: string; limit: number } {
  if (typeof threshold === "number") return { op: "<=", limit: threshold };
  const m: DynamicValue = String(threshold).trim().match(/^(<=|>=|<|>)\s*(\d+(?:\.\d+)?)$/);
  if (!m) throw new Error(`invalid threshold ${JSON.stringify(threshold)} (expected e.g. "< 2500")`);
  return { op: m[1], limit: Number(m[2]) };
}

function compare(value: number, op: string, limit: number): boolean {
  switch (op) {
    case "<": return value < limit;
    case "<=": return value <= limit;
    case ">": return value > limit;
    case ">=": return value >= limit;
    default: return false;
  }
}

/** Glob with * (any run) and ? (one char), anchored. */
function globToRegExp(glob: DynamicValue): RegExp {
  const re = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}

// ---- structured operation selectors (docs/contracts/engine.md#gates-and-custom-assertions) ----

/**
 * The run's requests as `{ index, step, method, path, status, mime, body,
 * requestBody, requestHeaders }`, in order. Embedded envelope network data is
 * the primary source (it is what a bare `response_status` reads); HAR entries
 * supply the request/response bodies and any tail request that fired after the
 * final settle, de-duped the way `api_called` does it.
 *
 * `step` is the step number whose ACTION produced the request, or null when no
 * step owns it (the harness's initial page load, a tail request that fired after
 * the last settle). It is what makes a violation reviewable on the web driver,
 * where the trace is a by-product of the page rather than the story's own
 * program: a policy names the offending request, and the step citation says
 * which click caused it. The attribution seam is the step envelope's
 * `artifacts.har_entries` (docs/contracts/artifacts.md#step-envelope) — the
 * per-step slice of har.json, which every driver that records network traffic
 * already writes.
 *
 * Observation traffic is NOT here: an entry an invariant policy's read-only
 * observation produced carries `_observation: true` and is filtered out, so an
 * observation GET can never satisfy `api_called`, shift the response another
 * check inspects, or enter a Tier-1/2 policy's view of the story
 * (docs/contracts/engine.md#invariant-policies). The runner also strips them
 * before the gate ever sees `harEntries`; this is the second, local guard.
 * Because observations are appended after the last acted step, stripping them
 * never shifts the HAR indices the envelopes recorded.
 */
function selectableRequests(ctx: DynamicValue): DynamicValue[] {
  const trajectory = ctx.trajectory ?? [];
  // har.json index -> owning step. First writer wins, so a HAR entry claimed by
  // two envelopes (it cannot be, but the data is external) attributes to the
  // earlier step rather than flip-flopping.
  const stepOfHarEntry = new Map<number, number>();
  for (const e of trajectory) {
    if (!Number.isInteger(e?.step)) continue;
    for (const i of e.artifacts?.har_entries ?? []) if (!stepOfHarEntry.has(i)) stepOfHarEntry.set(i, e.step);
  }
  const embedded: DynamicValue[] = [];
  for (const e of trajectory as DynamicValue[]) {
    const step = Number.isInteger(e?.step) ? e.step : null;
    for (const r of e?.network?.requests ?? []) {
      if (r._observation) continue;
      embedded.push({ request: r, step });
    }
  }
  const har: DynamicValue[] = [];
  (ctx.harEntries ?? []).forEach((e: DynamicValue, harIndex: number) => {
    if (e?._observation) return;
    har.push({
      method: (e.request?.method ?? "").toUpperCase(),
      path: pathnameOf(e.request?.url ?? ""),
      status: e.response?.status ?? 0,
      mime: e.response?.mimeType ?? "",
      body: e.response?.body ?? null,
      requestBody: e.request?.body ?? null,
      requestHeaders: e.request?.headers ?? {},
      step: stepOfHarEntry.has(harIndex) ? stepOfHarEntry.get(harIndex) : null,
    });
  });
  const out: DynamicValue[] = [];
  const remaining = har.slice();
  for (const { request: r, step } of embedded) {
    const method = (r.method ?? "").toUpperCase();
    const path = r.path ?? pathnameOf(r.url ?? "");
    // Pair each envelope request with its HAR twin (same method+path, in order)
    // so a selector can reach the body without double-counting the request.
    const i = remaining.findIndex((h) => h.method === method && h.path === path);
    const twin = i === -1 ? null : remaining.splice(i, 1)[0];
    out.push({
      method,
      path,
      status: r.status ?? twin?.status ?? 0,
      mime: r.mime_type ?? twin?.mime ?? "",
      body: twin?.body ?? null,
      requestBody: twin?.requestBody ?? null,
      requestHeaders: twin?.requestHeaders ?? {},
      step: step ?? twin?.step ?? null,
    });
  }
  return out.concat(remaining).map((r, index) => ({ ...r, index }));
}

/** The distinct steps a set of offending requests belongs to, ascending. */
function stepsOf(requests: DynamicValue): number[] {
  const steps = new Set<number>();
  for (const r of requests ?? []) if (Number.isInteger(r?.step)) steps.add(r.step);
  return [...steps].sort((a, b) => a - b);
}

/** HAR entries the gate may see: never an observation policy's own traffic. */
function harOf(ctx: DynamicValue): DynamicValue[] {
  return (ctx.harEntries ?? []).filter((e: DynamicValue) => !e._observation);
}

/** Requests matching a selector's method + path template, filtered by occurrence. */
function selected(selector: DynamicValue, ctx: DynamicValue): DynamicValue {
  const all = (ctx.trace ?? selectableRequests(ctx)).filter((r: DynamicValue) => r.method === selector.method && selector.template.test(r.path));
  if (!all.length) return { all, chosen: [] };
  if (selector.occurrence === "first") return { all, chosen: [all[0]] };
  if (selector.occurrence === "last") return { all, chosen: [all[all.length - 1]] };
  return { all, chosen: all };
}

/**
 * What the enriched OpenAPI document says about the operation a selector names
 * (docs/contracts/engine.md#openapi-ingestion) — the spec-driven Tier-1
 * material the gate has access to, surfaced on failing checks so a wrong status
 * or a mistyped path reads against what the API actually declares. Empty when
 * no spec is configured, so nothing changes for suites without one.
 */
function specNote(selector: DynamicValue, ctx: DynamicValue): string {
  const operations = ctx.spec?.operations;
  if (!Array.isArray(operations)) return "";
  const op = operations.find((o: DynamicValue) => o.method === selector.method && o.path === selector.path);
  if (!op) return ` (the spec declares no ${selector.method} ${selector.path})`;
  return op.status_codes.length ? ` (the spec declares ${op.status_codes.join(", ")} for ${selector.method} ${selector.path})` : "";
}

/** The shared "matched nothing" verdict: a selector with no request always FAILS. */
function noMatch(selector: DynamicValue, ctx: DynamicValue): DynamicValue {
  const seen = ctx.trace ?? selectableRequests(ctx);
  return {
    pass: false,
    detail:
      `no request matched ${selector.method} ${selector.path} among ${seen.length} request(s)` +
      ` — a declared expectation must be exercised to pass, so "${selector.occurrence}" is never vacuously true` +
      specNote(selector, ctx),
  };
}

function checkSelectedStatus(selector: DynamicValue, ctx: DynamicValue): DynamicValue {
  const { chosen } = selected(selector, ctx);
  if (!chosen.length) return noMatch(selector, ctx);
  const hits = chosen.filter((r: DynamicValue) => statusMatchesPattern(selector.status, String(r.status)));
  const pass = selector.occurrence === "any" ? hits.length > 0 : hits.length === chosen.length;
  const misses: Array<{ status: unknown }> = chosen.filter((r: DynamicValue) => !hits.includes(r));
  return {
    pass,
    detail: pass
      ? `${hits.length}/${chosen.length} ${selector.method} ${selector.path} response(s) answered ${selector.status}`
      : `${selector.method} ${selector.path} answered ${misses.map((r) => r.status).join(", ")} where ${selector.status} was expected` +
        ` (${selector.occurrence} of ${chosen.length})` +
        specNote(selector, ctx),
  };
}

function checkSelectedBody(selector: DynamicValue, ctx: DynamicValue): DynamicValue {
  const { chosen } = selected(selector, ctx);
  if (!chosen.length) return noMatch(selector, ctx);
  const results = chosen.map((r: DynamicValue) => {
    if (r.body == null) return { pass: false, detail: `${r.method} ${r.path} → ${r.status} had no body to match` };
    let json;
    try {
      json = JSON.parse(r.body);
    } catch {
      return { pass: false, detail: `${r.method} ${r.path} → ${r.status} did not answer JSON` };
    }
    return matchJsonPath(selector.match, json);
  });
  const passes = results.filter((r: DynamicValue) => r.pass);
  const pass = selector.occurrence === "any" ? passes.length > 0 : passes.length === results.length;
  const failed = results.find((r: DynamicValue) => !r.pass);
  return {
    pass,
    detail: pass
      ? `${passes.length}/${results.length} ${selector.method} ${selector.path} response(s): ${results[0].detail}`
      : `${selector.method} ${selector.path}: ${failed.detail}`,
  };
}

// ---- api response helpers (response_status / response_matches) ----

/** The LAST request's response body (lives in har.json, not the trajectory).
 *  Strictly the last entry — never scans back to an earlier (e.g. prime) body;
 *  so a body-less final response (204) fails rather than matching the wrong one. */
function lastResponseBody(ctx: DynamicValue): DynamicValue {
  // harOf, not ctx.harEntries: an observation GET appended after the actor must
  // never become "the last response" this check inspects.
  const entries = harOf(ctx);
  return entries.length ? (entries[entries.length - 1]?.response?.body ?? null) : null;
}

// Minimal JSON-path/value check: `<path> (=|!=) <literal>`. path is a dot/
// bracket path with an optional leading $ (e.g. "$.title", "$[0].completed",
// "deleted"); literal is a quoted string, number, boolean, or null.
function matchJsonPath(expr: DynamicValue, json: DynamicValue): DynamicValue {
  const m = String(expr).match(/^\s*(\$?[\w.[\]'"-]*?)\s*(==|!=|=)\s*(.+?)\s*$/);
  if (!m) return { pass: false, detail: `cannot parse response_matches ${JSON.stringify(expr)} (expected: path == value)` };
  const [, rawPath, op, rawVal]: DynamicValue = m;
  const actual = resolveJsonPath(json, rawPath);
  const expected = parseLiteral(rawVal);
  // Strict, type-aware equality (no String()-coercion fallback: it made 1 == "1"
  // and true == "true" false-positive).
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  const pass = op === "!=" ? !eq : eq;
  // JSON.stringify(undefined) is the literal string "undefined" — show a readable
  // placeholder instead when the path resolved to nothing.
  const shown = actual === undefined ? "(no value at path)" : JSON.stringify(actual);
  return {
    pass,
    detail: pass
      ? `${rawPath || "$"} = ${shown}`
      : `${rawPath || "$"} = ${shown}, expected ${op} ${JSON.stringify(expected)}`,
  };
}

function resolveJsonPath(json: DynamicValue, path: string): DynamicValue {
  const p = String(path).replace(/^\$\.?/, "");
  if (p === "") return json;
  const segs: DynamicValue = [];
  const re = /\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]|\.?([\w-]+)/g;
  let m;
  while ((m = re.exec(p))) segs.push(m[1] != null ? Number(m[1]) : (m[2] ?? m[3] ?? m[4]));
  let cur = json;
  for (const s of segs) {
    if (cur == null) return undefined;
    cur = cur[s];
  }
  return cur;
}

function parseLiteral(raw: DynamicValue): DynamicValue {
  const t = String(raw).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return t;
}
