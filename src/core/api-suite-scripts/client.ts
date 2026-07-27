import type { DynamicValue } from "./types.ts";

// The injected client, as the SCRIPT sees it
// (docs/contracts/scripts.md#the-client). It runs inside the script process and
// owns no credential, no socket, and no authority: every guard it reports is
// also enforced on the wire by the proxy (./proxy.ts), so this module is
// ergonomics and early failure, never the boundary.
//
// A script obtains it as `client` on the entry contract's context object. It
// cannot construct one: the endpoint and its token are handed to the bootstrap
// on stdin and closed over here.

/** A guard refused the request. Thrown, because a refusal is a script bug. */
export class ScriptClientRefused extends Error {
  declare code: DynamicValue;

  constructor(code: DynamicValue, message: DynamicValue) {
    super(message);
    this.name = "ScriptClientRefused";
    this.code = code;
  }
}

/** The run's request budget is spent. Terminal: nothing further is recorded. */
export class BudgetExhausted extends ScriptClientRefused {
  constructor(message: DynamicValue) {
    super("budget_exhausted", message);
    this.name = "BudgetExhausted";
  }
}

/**
 * @param {{ endpoint: string, token: string, fetchImpl: Function, baseUrl: string,
 *           mode: string, budget: number, secretNames: string[],
 *           drainChecks?: () => object[] }} options
 */
export function createScriptClient({ endpoint, token, fetchImpl, baseUrl, mode, budget, secretNames = [], namespace = "", drainChecks = null }: DynamicValue) {
  const declared: DynamicValue = new Set(secretNames);
  let used = 0;
  let remaining = budget;

  async function call(route: DynamicValue, payload: DynamicValue) {
    const response = await fetchImpl(`${endpoint}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-playtest-script-token": token },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let body: DynamicValue = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`script control channel returned a non-JSON reply (${response.status})`);
    }
    if (!response.ok) throw new Error(body.error ?? `script control channel failed (${response.status})`);
    return body;
  }

  async function request(method: DynamicValue, path: DynamicValue, options: DynamicValue = {}) {
    const verb = String(method ?? "GET").toUpperCase();
    if (typeof path !== "string" || !path) {
      throw new ScriptClientRefused("invalid_path", `client.request needs a path string (got ${JSON.stringify(path ?? null)})`);
    }
    const reply = await call("/request", {
      checks: drainChecks?.() ?? [],
      request: {
        method: verb,
        path,
        headers: options.headers ?? null,
        body: options.body,
        rawBody: options.rawBody,
        contentType: options.contentType ?? null,
      },
    });
    if (reply.refused) {
      const { code, message } = reply.refused;
      throw code === "budget_exhausted" ? new BudgetExhausted(message) : new ScriptClientRefused(code, message);
    }
    used = reply.budget?.used ?? used + 1;
    remaining = reply.budget?.remaining ?? Math.max(0, budget - used);
    const entry = reply.entry;
    let json: DynamicValue = null;
    let parseError = false;
    if (typeof entry.text === "string" && entry.text !== "") {
      try {
        json = JSON.parse(entry.text);
      } catch {
        parseError = true;
      }
    }
    return Object.freeze({
      ...entry,
      json,
      parseError,
      ok: entry.status >= 200 && entry.status < 300,
    });
  }

  const client: DynamicValue = {
    request,
    get baseUrl() {
      return baseUrl;
    },
    /** "read-only" or "read-write". Set by run configuration; read-only here. */
    get mode() {
      return mode;
    },
    get budget() {
      return { limit: budget, used, remaining };
    },
    /**
     * This run's namespace. Put it in every name this suite creates: two replays
     * running at once against the same target must not be able to collide, and
     * the harness cannot label a resource the script invents for it.
     */
    get namespace() {
      return namespace;
    },
    /** `client.name("cart")` → `"cart-pt…"`. The ergonomic form of the rule above. */
    name(label: DynamicValue) {
      const base = String(label ?? "").trim();
      return namespace ? (base ? `${base}-${namespace}` : namespace) : base;
    },
    /** The secret NAMES this run declared. Values are unavailable by construction. */
    get secretNames() {
      return [...declared];
    },
    /**
     * A header value the proxy substitutes with the credential. The script can
     * cause an authenticated request; it can never read what was sent.
     */
    secret(name: DynamicValue) {
      if (!declared.has(name)) {
        throw new ScriptClientRefused(
          "undeclared_secret",
          `secret "${name}" is not declared for this run (declared: ${[...declared].join(", ") || "none"})`,
        );
      }
      return { $secret: name };
    },
    get: (path: DynamicValue, options: DynamicValue) => request("GET", path, options),
    head: (path: DynamicValue, options: DynamicValue) => request("HEAD", path, options),
    post: (path: DynamicValue, options: DynamicValue) => request("POST", path, options),
    put: (path: DynamicValue, options: DynamicValue) => request("PUT", path, options),
    patch: (path: DynamicValue, options: DynamicValue) => request("PATCH", path, options),
    delete: (path: DynamicValue, options: DynamicValue) => request("DELETE", path, options),
  };
  return client;
}
