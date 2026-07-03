// Shared HAR helpers (docs/CONTRACTS.md §16). har.json captures request/response
// bodies + headers for debugging and as the data source the api-driver gate reads
// — text/JSON only (text/html page documents are skipped — see isTextualMime),
// capped, and ONLY in har.json (never the embedded
// network.requests, so committed baselines stay jitter-free). Large or binary
// bodies are skipped; bodySize is kept. har.json lives under runs/ (gitignored)
// and may contain auth headers/cookies. Used by the web + api drivers (and
// pathnameOf by gate.js).
import fs from "node:fs";
import path from "node:path";

export const MAX_BODY_CHARS = 64 * 1024; // stored cap per body
export const MAX_BODY_READ = 1024 * 1024; // don't buffer responses larger than this

// HTML page documents are textual but huge and never read by the gate
// (response_matches/assert work over JSON/text-data) — skip their bodies so
// har.json stays small. We still record their headers + bodySize.
export const isTextualMime = (m) => !/^text\/html\b/.test(m || "") && (/^text\//.test(m || "") || /(json|xml|javascript|x-www-form-urlencoded)/.test(m || ""));
export const capBody = (s) => (s == null ? null : s.length > MAX_BODY_CHARS ? s.slice(0, MAX_BODY_CHARS) + "…[truncated]" : s);

export function pathnameOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// Matches an absolute http(s) origin (scheme + host + optional port), the prefix
// up to — but not including — the path.
const ORIGIN_RE = /https?:\/\/[^/\s]+/g;

/**
 * Strip a base_url prefix (origin + its pathname) from every absolute url in the
 * text, then any bare origin still left — so the same surface served under two
 * environments (a `/retail/netbank` deployment prefix vs none, or a pure host
 * swap) collapses to the same relative form for drift comparison (§10). `base`
 * null/unparseable ⇒ origin-only stripping (legacy baselines). Trailing slash on
 * the base path is tolerated so `/app` and `/app/` strip identically. Shared by
 * the web + api drivers' snapshot normalizers. Pure.
 */
export function relativizeUrls(s, base) {
  let prefix = null;
  if (base) {
    try {
      const u = new URL(base);
      // origin + pathname without a trailing slash (so `/app` matches `/app/q1`)
      prefix = (u.origin + u.pathname).replace(/\/$/, "");
    } catch {}
  }
  if (prefix) s = s.split(prefix).join("");
  return s.replace(ORIGIN_RE, "");
}

/**
 * The `[eN]` role "name"` snapshot-text normalizer shared by the web + mobile
 * drivers (§10): strip the volatile `[eN]` ref prefix (refs renumber every
 * snapshot — not behavioral) and collapse per-line whitespace, dropping blank
 * lines. Pure. The web driver relativizes URLs on top of this; mobile calls it
 * directly (its AX text shares the same `[eN]` role "name"` shape).
 */
export function stripRefLines(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*\[e\d+\]\s*/, "").replace(/\s+/g, " ").trim())
    .filter((line) => line)
    .join("\n");
}

/** Write the HAR entries to har.json under runDir (rewritten on every flush). */
export function flushHar(runDir, entries) {
  fs.writeFileSync(path.join(runDir, "har.json"), JSON.stringify({ log: { entries } }) + "\n");
}
