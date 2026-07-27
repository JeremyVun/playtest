// Suite-file path helpers. The `kind` of a suite file
// is derived from its suite-root-relative path — the same layout the CLI walks
// (docs/contracts/engine.md#discovery-and-configuration): defaults at the root,
// cases anywhere (stories/ honored), personas/,
// hooks/, assertions/<name>/assertion.js. Kept in one place so validation, the
// editor's role-gating, and snapshotting agree.

const DEFAULTS_FILE = "playtest.yaml";

/** Infer the suite_files.kind for a suite-root-relative path. */
export function kindForPath(rel: string): string {
  const p = normalizePath(rel);
  if (p === DEFAULTS_FILE) return "defaults";
  const seg = p.split("/");
  if (seg[0] === "personas" && p.endsWith(".yaml")) return "persona";
  if (seg[0] === "hooks" && p.endsWith(".js")) return "hook";
  if (seg[0] === "assertions" && p.endsWith(".js")) return "assertion";
  // Core treats only `.yaml` as a case file (config.js isCaseFile); a `.yml`
  // (e.g. docker-compose.yml) is a suite asset, never a story.
  if (p.endsWith(".yaml")) return "case";
  return "asset";
}

/** Files whose bytes are code (hooks/assertions) — developer-role, code-only UI. */
export function isCodeKind(kind: string): boolean {
  return kind === "hook" || kind === "assertion";
}

/**
 * Normalize a client-supplied path to a safe, suite-root-relative POSIX path.
 * Rejects absolute paths, `..` traversal, and leading slashes — a suite file can
 * only live inside the suite. Throws on violation (callers surface bad_request).
 */
export function normalizePath(rel: string): string {
  if (typeof rel !== "string" || !rel.trim()) throw new Error("path is required");
  let p = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  p = p.replace(/^\/+/, "");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new Error(`path escapes the suite: ${rel}`);
    parts.push(seg);
  }
  if (!parts.length) throw new Error(`empty path: ${rel}`);
  return parts.join("/");
}
