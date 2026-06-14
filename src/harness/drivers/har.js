// Shared HAR helpers (docs/CONTRACTS.md §16). har.json captures request/response
// bodies + headers for debugging and as the data source the api-driver gate reads
// — text/JSON only, capped, and ONLY in har.json (never the embedded
// network.requests, so committed baselines stay jitter-free). Large or binary
// bodies are skipped; bodySize is kept. har.json lives under runs/ (gitignored)
// and may contain auth headers/cookies. Used by the web + api drivers (and
// pathnameOf by gate.js).
import fs from "node:fs";
import path from "node:path";

export const MAX_BODY_CHARS = 64 * 1024; // stored cap per body
export const MAX_BODY_READ = 1024 * 1024; // don't buffer responses larger than this

export const isTextualMime = (m) => /^text\//.test(m || "") || /(json|xml|javascript|x-www-form-urlencoded)/.test(m || "");
export const capBody = (s) => (s == null ? null : s.length > MAX_BODY_CHARS ? s.slice(0, MAX_BODY_CHARS) + "…[truncated]" : s);

export function pathnameOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Write the HAR entries to har.json under runDir (rewritten on every flush). */
export function flushHar(runDir, entries) {
  fs.writeFileSync(path.join(runDir, "har.json"), JSON.stringify({ log: { entries } }) + "\n");
}
