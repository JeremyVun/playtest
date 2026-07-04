import { pathnameOf } from "./drivers/har.js";

// Soft checks still fail the run (status "fail", exit 1) but do NOT block
// baseline acceptance: an agent that genuinely completed the journey while the
// app logged a console error or breached a latency budget shouldn't force a
// re-record. console_errors and the perf thresholds are advisory by nature
// (the app's correctness/latency, not whether the user reached the goal), so
// they default to soft; every other kind is a hard correctness gate. There is
// no per-criterion override — the kind decides (see docs/CONTRACTS.md §7).
// severityOf only ever sees SUCCESS kinds; perf is a separate top-level case key
// whose own loop hardcodes soft, so it isn't listed here.
const SOFT_KINDS = new Set(["console_errors"]);
const severityOf = (kind) => (SOFT_KINDS.has(kind) ? "soft" : "hard");

// Inheritable kinds: a check whose verdict is fixed by the (unchanged) trajectory
// but is expensive and/or non-deterministic to recompute, so a clean act replay
// (no per-step drift, §10) reuses the verdict saved on the baseline instead of
// re-running it. `assert` is the canonical one — an LLM judging a frozen snapshot
// can flip its answer run to run. Deterministic built-ins (url_matches, api_called,
// …) are NEVER inheritable: they're cheap and they ARE the regression catch.
// FUTURE: a vision pixel-diff kind goes here too — this set is the single seam, so
// adding a kind (or a custom-assertion opt-in below) is the only change needed.
const INHERITABLE_BUILTIN_KINDS = new Set(["assert"]);
const REQUEST_DEDUP_SEPARATOR = "\0";

/**
 * Is this check kind eligible to reuse a saved baseline verdict on a clean replay?
 * Built-ins: only the kinds in INHERITABLE_BUILTIN_KINDS. Custom assertions: opt-in
 * via `inheritable` on the assertion module (default true — assertions.js validates
 * the type). The gate is the single authority on inheritability so the runner and
 * future kinds can't drift from it.
 */
export function isInheritable(kind, routing) {
  if (INHERITABLE_BUILTIN_KINDS.has(kind)) return true;
  const owner = routing?.get(kind);
  if (owner) return owner.assertion.inheritable !== false;
  return false;
}

/**
 * Evaluate every success criterion, then every perf threshold. Never throws;
 * a check that errors becomes a failed check.
 * @param {object} resolvedCase
 * @param {{ driver: object, harEntries: object[], consoleErrorCount: number,
 *          trajectory: object[], finalUrl: string,
 *          checkAssertion: ((claim: string) => Promise<{pass: boolean, detail: string}>) | null,
 *          routing?: Map<string, {name: string, assertion: object}>,
 *          evidence?: Record<string, unknown>,
 *          inherited?: Map<string, {pass: boolean, detail: string}> }} ctx
 * routing/evidence: custom assertions (a registered assertion success key
 * dispatches to its verdict() over the gathered evidence). evaluateGate stays
 * pure — it reads captured evidence, never does live I/O.
 * inherited: on a CLEAN ACT REPLAY only (§10), the baseline's saved verdicts
 * keyed by spec ("kind: value"); an inheritable check (isInheritable) reuses its
 * prior verdict instead of re-running, marked { inherited: true }. Absent on
 * record/heal/legacy — every check runs live.
 * @returns {Promise<{ pass: boolean, hardPass: boolean, checks: {kind, severity, spec, label?, pass, detail, inherited?}[] }>}
 *   pass = all checks pass (drives status/exit). hardPass = all HARD checks pass
 *   (drives baseline acceptance — a soft-only failure still saves the baseline).
 */
export async function evaluateGate(resolvedCase, ctx) {
  const checks = [];

  for (const criterion of resolvedCase.success ?? []) {
    // The check kind is the first key that isn't the optional cosmetic `label`
    // (config.js guarantees exactly one such key). `label` rides along on the
    // check for presentation (the clip summary card) — it never touches the verdict.
    const [kind, value] = Object.entries(criterion).find(([k]) => k !== "label") ?? [];
    const { label } = criterion;
    const spec = `${kind}: ${value}`;
    // Clean act replay (§10): the trajectory is provably unchanged, so reuse the
    // verdict the baseline saved for an inheritable check (assert / opted-in custom
    // assertion) instead of re-running it. ctx.inherited is a Map<spec,{pass,detail}>
    // passed ONLY on a clean replay; absent ⇒ everything runs live (record/heal, or
    // a legacy baseline with no saved verdict — it self-heals on the next accept).
    const prior = ctx.inherited?.get(spec);
    if (prior && isInheritable(kind, ctx.routing)) {
      checks.push({ kind, severity: severityOf(kind), spec, ...(label ? { label } : {}), pass: Boolean(prior.pass), detail: prior.detail ?? "", inherited: true });
      continue;
    }
    try {
      checks.push({ kind, severity: severityOf(kind), spec, ...(label ? { label } : {}), ...(await checkSuccess(kind, value, ctx)) });
    } catch (e) {
      checks.push({ kind, severity: severityOf(kind), spec, ...(label ? { label } : {}), pass: false, detail: `check error: ${e.message}` });
    }
  }

  for (const [key, threshold] of Object.entries(resolvedCase.perf ?? {})) {
    checks.push({ severity: "soft", ...checkPerf(key, threshold, ctx) });
  }

  return {
    pass: checks.every((c) => c.pass),
    hardPass: checks.every((c) => c.pass || c.severity === "soft"),
    checks,
  };
}

async function checkSuccess(kind, value, ctx) {
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
      // mobile driver's query language (config.js scopes screen_shows to mobile) —
      // so they share one branch, differing only in the report noun.
    case "screen_shows": {
      const noun = kind === "screen_shows" ? "screen element" : "element";
      const found = await ctx.driver.finalPageCheck(value);
      return { pass: Boolean(found), detail: found ? `${noun} present` : `no ${noun} matches ${value}` };
    }

    case "api_called": {
      const [method, ...rest] = String(value).trim().split(/\s+/);
      // A bare method with no path glob would compile to an empty regex that only
      // matches an empty path — silently never hitting. Name the mistake instead.
      if (rest.length === 0) {
        return { pass: false, detail: `api_called "${method}" is missing a path glob — write e.g. "POST /api/todos"` };
      }
      const re = globToRegExp(rest.join(" "));
      // Embedded per-envelope network data is the primary source; the HAR sidecar
      // supplies (a) whole runs from before network data was embedded and (b) tail
      // requests fired after the final settle, which land in har.json but in no
      // envelope's network window (§4/§7). Union both, de-duped by method+path, so
      // a post-settle request is still matchable without double-counting embedded
      // ones on a modern run.
      const trajectory = ctx.trajectory ?? [];
      const embedded = trajectory.flatMap((e) => e.network?.requests ?? []);
      const harReqs = (ctx.harEntries ?? []).map((e) => ({
        method: e.request?.method ?? "",
        url: e.request?.url ?? "",
        path: pathnameOf(e.request?.url ?? ""),
      }));
    const seen = new Set(embedded.map((r) => `${r.method}${REQUEST_DEDUP_SEPARATOR}${r.path ?? pathnameOf(r.url)}`));
    const requests = embedded.concat(harReqs.filter((r) => !seen.has(`${r.method}${REQUEST_DEDUP_SEPARATOR}${r.path ?? pathnameOf(r.url)}`)));
    const hits = requests.filter(
      (r) =>
        r.method?.toUpperCase() === method.toUpperCase() &&
        re.test(r.path ?? pathnameOf(r.url)),
    );
    // Common authoring slip: a glob without a leading "/" (e.g. "POST api/todos")
    // anchors to ^api/todos$ and never matches the always-leading-slash request
    // paths. When nothing matched and that's the shape, point at the fix.
    const glob = rest.join(" ");
    const slashHint =
      hits.length === 0 && !glob.startsWith("/") && requests.some((r) => (r.path ?? pathnameOf(r.url)).startsWith("/"))
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
    // api: a response with this status — exact ("201") or a class ("2xx").
    // Matches ANY request in the run (design "last or any"), so a verification
    // read-back after a mutation (POST 201 then GET 200) doesn't flip the gate.
    const reqs = (ctx.trajectory ?? []).flatMap((e) => e.network?.requests ?? []);
    const hits = reqs.filter((r) => statusMatches(value, String(r.status)));
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
    // api: a JSON-path/value over the LAST response body (from har.json, never
    // the committed trajectory — bodies stay out of baselines). Deterministic.
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

    case "assert": {
      if (typeof ctx.checkAssertion !== "function") {
        return { pass: false, detail: "assert requires a model; no LLM configured" };
      }
      const { pass, detail } = await ctx.checkAssertion(value);
      return { pass: Boolean(pass), detail: detail ?? "" };
    }

    case "console_errors": {
      // web only (config.js scopes it): a deterministic correctness gate, not a
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
      // web only (config.js scopes it): always-on axe-core captures WCAG
      // violations per step (envelope.axe); the gate caps the TOTAL violation
      // node count summed across the run — every WCAG violation on each step's
      // page, not just the element the agent touched. Deterministic, HARD (not in
      // SOFT_KINDS). Same envelope-summing pattern as api_called; no new ctx
      // field. Envelopes without `axe` (non-web, failed-axe, state-drift)
      // contribute 0.
      const trajectory = ctx.trajectory ?? [];
      const total = trajectory.reduce((sum, e) => sum + (e.axe?.counts?.total ?? 0), 0);
      return {
        pass: total <= Number(value),
        detail: `${total} WCAG violation(s)`,
      };
    }

    default: {
      // A suite custom-assertion key (config.js registered it and validated it
      // into the schema): dispatch to the owning assertion's verdict(), judging the
      // evidence gather() captured during the observing phase. The value string
      // is opaque to core — the assertion owns its grammar. verdict throwing is
      // caught by evaluateGate (a failed check); a non-{pass} return is a failed
      // check with a clear assertion-named detail. Severity is hard (severityOf:
      // assertion keys aren't in SOFT_KINDS). See docs/CONTRACTS.md §7.
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

function checkPerf(key, threshold, ctx) {
  try {
    if (key === "lcp_ms" || key === "input_to_paint_ms") {
      const { op, limit } = parseThreshold(threshold);
      const spec = `perf.${key} ${op} ${limit}`;
      const values = (ctx.trajectory ?? [])
        .map((e) => (key === "lcp_ms" ? e.perf?.nav?.lcp_ms : e.perf?.input_to_paint_ms))
        .filter((v) => typeof v === "number");
      if (values.length === 0) {
        return { kind: "perf", spec, pass: false, detail: `no ${key} measurements in trajectory` };
      }
      const worst = Math.max(...values);
      return { kind: "perf", spec, pass: compare(worst, op, limit), detail: `worst ${key} = ${worst}` };
    }

    return { kind: "perf", spec: `perf.${key}`, pass: false, detail: `unknown perf key "${key}"` };
  } catch (e) {
    return { kind: "perf", spec: `perf.${key} ${threshold}`, pass: false, detail: `check error: ${e.message}` };
  }
}

/** "< 2500" / "<= 2500" / ">= 10" / "> 10"; a bare number means "<= n". */
function parseThreshold(threshold) {
  if (typeof threshold === "number") return { op: "<=", limit: threshold };
  const m = String(threshold).trim().match(/^(<=|>=|<|>)\s*(\d+(?:\.\d+)?)$/);
  if (!m) throw new Error(`invalid threshold ${JSON.stringify(threshold)} (expected e.g. "< 2500")`);
  return { op: m[1], limit: Number(m[2]) };
}

function compare(value, op, limit) {
  switch (op) {
    case "<": return value < limit;
    case "<=": return value <= limit;
    case ">": return value > limit;
    case ">=": return value >= limit;
    default: return false;
  }
}

/** Glob with * (any run) and ? (one char), anchored. */
function globToRegExp(glob) {
  const re = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}

// ---- api response helpers (response_status / response_matches) ----

/** The LAST request's response body (lives in har.json, not the trajectory).
 *  Strictly the last entry — never scans back to an earlier (e.g. prime) body;
 *  so a body-less final response (204) fails rather than matching the wrong one. */
function lastResponseBody(ctx) {
  const entries = ctx.harEntries ?? [];
  return entries.length ? (entries[entries.length - 1]?.response?.body ?? null) : null;
}

/** "201" exact, or "2xx" class (first digit then any two digits). */
function statusMatches(pattern, status) {
  const p = String(pattern).trim();
  if (/^[1-5]xx$/i.test(p)) return new RegExp(`^${p[0]}\\d\\d$`).test(status);
  return p === status;
}

// Minimal JSON-path/value check: `<path> (=|!=) <literal>`. path is a dot/
// bracket path with an optional leading $ (e.g. "$.title", "$[0].completed",
// "deleted"); literal is a quoted string, number, boolean, or null.
function matchJsonPath(expr, json) {
  const m = String(expr).match(/^\s*(\$?[\w.[\]'"-]*?)\s*(==|!=|=)\s*(.+?)\s*$/);
  if (!m) return { pass: false, detail: `cannot parse response_matches ${JSON.stringify(expr)} (expected: path == value)` };
  const [, rawPath, op, rawVal] = m;
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

function resolveJsonPath(json, path) {
  const p = String(path).replace(/^\$\.?/, "");
  if (p === "") return json;
  const segs = [];
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

function parseLiteral(raw) {
  const t = String(raw).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return t;
}
