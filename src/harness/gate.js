// Deterministic pass/fail gate. See docs/CONTRACTS.md §7.
import { pathnameOf } from "./drivers/har.js";

/**
 * Evaluate every success criterion, then every perf threshold. Never throws;
 * a check that errors becomes a failed check.
 * @param {object} resolvedCase
 * @param {{ driver: object, harEntries: object[], consoleErrorCount: number,
 *           trajectory: object[], finalUrl: string,
 *           checkAssertion: ((claim: string) => Promise<{pass: boolean, detail: string}>) | null }} ctx
 * @returns {Promise<{ pass: boolean, checks: {kind, spec, pass, detail}[] }>}
 */
export async function evaluateGate(resolvedCase, ctx) {
  const checks = [];

  for (const criterion of resolvedCase.success ?? []) {
    const [kind, value] = Object.entries(criterion)[0] ?? [];
    const spec = `${kind}: ${value}`;
    try {
      checks.push({ kind, spec, ...(await checkSuccess(kind, value, ctx)) });
    } catch (e) {
      checks.push({ kind, spec, pass: false, detail: `check error: ${e.message}` });
    }
  }

  for (const [key, threshold] of Object.entries(resolvedCase.perf ?? {})) {
    checks.push(checkPerf(key, threshold, ctx));
  }

  return { pass: checks.every((c) => c.pass), checks };
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

    case "element_exists": {
      const found = await ctx.driver.finalPageCheck(value);
      return { pass: Boolean(found), detail: found ? "element present" : `no element matches ${value}` };
    }

    case "screen_shows": {
      // The mobile analog of element_exists: an accessibility id / predicate
      // resolves on the final screen. Same Driver.finalPageCheck seam, the
      // mobile driver's query language. (config.js scopes this to mobile.)
      const found = await ctx.driver.finalPageCheck(value);
      return { pass: Boolean(found), detail: found ? "screen element present" : `no screen element matches ${value}` };
    }

    case "api_called": {
      const [method, ...rest] = String(value).trim().split(/\s+/);
      const re = globToRegExp(rest.join(" "));
      // Embedded per-envelope network data is the source of truth; the HAR
      // sidecar is the fallback only when no envelope carries a network field
      // at all (runs/baselines from before network data was embedded).
      const trajectory = ctx.trajectory ?? [];
      const requests = trajectory.some((e) => e.network)
        ? trajectory.flatMap((e) => e.network?.requests ?? [])
        : (ctx.harEntries ?? []).map((e) => ({
            method: e.request?.method ?? "",
            url: e.request?.url ?? "",
            path: pathnameOf(e.request?.url ?? ""),
          }));
      const hits = requests.filter(
        (r) =>
          r.method?.toUpperCase() === method.toUpperCase() &&
          re.test(r.path ?? pathnameOf(r.url)),
      );
      return {
        pass: hits.length > 0,
        detail:
          hits.length > 0
            ? `${hits.length} matching request(s), e.g. ${hits[0].method} ${hits[0].url}`
            : `no matching request among ${requests.length} request(s)`,
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
      return { pass: count <= Number(value), detail: `${count} console error(s)` };
    }

    default:
      return { pass: false, detail: `unknown success criterion "${kind}"` };
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
 *  Strictly the last entry — never scans back to an earlier (e.g. prime) body,
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

// Minimal JSON-path/value check: `<path> (==|!=|=) <literal>`. path is a dot/
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
  return {
    pass,
    detail: pass
      ? `${rawPath || "$"} = ${JSON.stringify(actual)}`
      : `${rawPath || "$"} = ${JSON.stringify(actual)}, expected ${op} ${JSON.stringify(expected)}`,
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
