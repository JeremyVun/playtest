// A tiny pattern router — the same hand-rolled scale as view-server.js, but with
// `:param` and `*wildcard` segments so the §2 route table reads declaratively.
// `:name` matches one path segment (decoded); `*name` (only as the last segment)
// captures the decoded remainder including slashes (the `*path` file routes).
// match() distinguishes "no route" (→ 404) from "route, wrong method" (→ 405).
import type { RequestContext } from "./types.ts";

export type RouteHandler = (ctx: RequestContext) => unknown | Promise<unknown>;
interface CompiledRoute {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const parts = pattern.split("/").filter(Boolean);
  const keys: string[] = [];
  const regexParts = parts.map((seg, i) => {
    if (seg.startsWith("*")) {
      if (i !== parts.length - 1) throw new Error(`wildcard must be last: ${pattern}`);
      keys.push(seg.slice(1));
      return "(.+)"; // remainder, slashes included
    }
    if (seg.startsWith(":")) {
      keys.push(seg.slice(1));
      return "([^/]+)";
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { regex: new RegExp(`^/${regexParts.join("/")}/?$`), keys };
}

export class Router {
  declare readonly routes: CompiledRoute[];

  constructor() {
    this.routes = []; // { method, regex, keys, handler }
  }

  add(method: string, pattern: string, handler: RouteHandler): this {
    const { regex, keys } = compile(pattern);
    this.routes.push({ method, regex, keys, handler });
    return this;
  }

  get(p: string, h: RouteHandler) { return this.add("GET", p, h); }
  post(p: string, h: RouteHandler) { return this.add("POST", p, h); }
  put(p: string, h: RouteHandler) { return this.add("PUT", p, h); }
  patch(p: string, h: RouteHandler) { return this.add("PATCH", p, h); }
  del(p: string, h: RouteHandler) { return this.add("DELETE", p, h); }

  /**
   * @returns {{ handler, params } | { methodNotAllowed: true, allow: string[] } | null}
   *   null when no pattern matches (404); methodNotAllowed when a pattern matches
   *   the path but not the method (405 with an Allow header).
   */
  match(method: string, pathname: string):
    | { handler: RouteHandler; params: Record<string, string> }
    | { methodNotAllowed: true; allow: string[] }
    | null {
    const pathMatches: string[] = [];
    for (const r of this.routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      pathMatches.push(r.method);
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(m[i + 1] as string);
        } catch {
          params[k] = m[i + 1] as string;
        }
      });
      return { handler: r.handler, params };
    }
    if (pathMatches.length) return { methodNotAllowed: true, allow: [...new Set(pathMatches)] };
    return null;
  }
}
