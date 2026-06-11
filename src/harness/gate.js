// Deterministic pass/fail gate. See docs/CONTRACTS.md §7.

/**
 * Evaluate every success criterion, then every perf threshold. Never throws;
 * a check that errors becomes a failed check.
 * @param {object} resolvedCase
 * @param {{ session: object, harEntries: object[], consoleErrorCount: number,
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
      const found = await ctx.session.finalPageCheck(value);
      return { pass: Boolean(found), detail: found ? "element present" : `no element matches ${value}` };
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

    case "assert": {
      if (typeof ctx.checkAssertion !== "function") {
        return { pass: false, detail: "assert requires a model; no LLM configured" };
      }
      const { pass, detail } = await ctx.checkAssertion(value);
      return { pass: Boolean(pass), detail: detail ?? "" };
    }

    default:
      return { pass: false, detail: `unknown success criterion "${kind}"` };
  }
}

function checkPerf(key, threshold, ctx) {
  try {
    if (key === "console_errors") {
      const count = ctx.consoleErrorCount ?? 0;
      return {
        kind: "perf",
        spec: `perf.console_errors <= ${threshold}`,
        pass: count <= Number(threshold),
        detail: `${count} console error(s)`,
      };
    }

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

function pathnameOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
