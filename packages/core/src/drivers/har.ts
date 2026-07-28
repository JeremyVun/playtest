// Shared HAR helpers (docs/contracts/artifacts.md#run-directory). har.json captures request/response
// bodies + headers for debugging and as the data source the api-driver gate reads
// — text/JSON only (text/html page documents are skipped — see isTextualMime),
// capped, and ONLY in har.json (never the embedded
// network.requests, so committed baselines stay jitter-free). Large or binary
// bodies are skipped; bodySize is kept. har.json lives under runs/ (gitignored)
// and may contain auth headers/cookies. Used by the web + api drivers (and
// pathnameOf by gate.ts).
import fs from "node:fs";
import path from "node:path";
import { hasKnownSecrets, redactSecrets } from "../secrets.ts";
import { PerfSidecar } from "../perf.ts";

export const MAX_BODY_CHARS = 64 * 1024; // stored cap per body
export const MAX_BODY_READ = 1024 * 1024; // don't buffer responses larger than this
export const HAR_FLUSH_INTERVAL_STEPS = 5;

/**
 * The append-only mid-run journal beside har.json. Transient and DIAGNOSTIC: it
 * is not in any manifest, envelope, or artifact contract, and it is deleted the
 * moment har.json catches up with it — so a run that ends normally never leaves
 * one behind. See createHarFlusher for what it buys.
 */
export const HAR_JOURNAL_FILE = "har.journal.jsonl";

// HTML page documents are textual but huge and never read by the gate
// (response_matches/assert work over JSON/text-data) — skip their bodies so
// har.json stays small. We still record their headers + bodySize.
export const isTextualMime = (m: string | null | undefined): boolean => !/^text\/html\b/.test(m || "") && (/^text\//.test(m || "") || /(json|xml|javascript|x-www-form-urlencoded)/.test(m || ""));
export const capBody = (s: string | null | undefined): string | null => (s == null ? null : s.length > MAX_BODY_CHARS ? s.slice(0, MAX_BODY_CHARS) + "…[truncated]" : s);

export function pathnameOf(url: string): string {
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
 * swap) collapses to the same relative form for drift comparison
 * (docs/contracts/engine.md#act-and-heal). `base`
 * null/unparseable ⇒ origin-only stripping (legacy baselines). Trailing slash on
 * the base path is tolerated so `/app` and `/app/` strip identically. Shared by
 * the web + api drivers' snapshot normalizers. Pure.
 */
export function relativizeUrls(s: string, base?: string | null): string {
  let prefix: string | null = null;
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
 * drivers (docs/contracts/engine.md#act-and-heal): strip the volatile `[eN]`
 * ref prefix (refs renumber every
 * snapshot — not behavioral) and collapse per-line whitespace, dropping blank
 * lines. Pure. The web driver relativizes URLs on top of this; mobile calls it
 * directly (its AX text shares the same `[eN]` role "name"` shape).
 */
export function stripRefLines(text: unknown): string {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*\[e\d+\]\s*/, "").replace(/\s+/g, " ").trim())
    .filter((line) => line)
    .join("\n");
}

/**
 * Write the HAR entries to har.json under runDir (rewritten on every flush).
 * Known secret values are scrubbed AT WRITE TIME
 * (docs/contracts/engine.md#secrets-and-redaction) — core knows every value it
 * injected from a secret reference, so no injected credential is ever on disk.
 * The file stays flagged sensitive and untracked regardless: a server can return
 * tokens core cannot recognize. The scrub runs over the serialized document (so
 * it catches a value wherever it landed) and is a no-op when nothing is
 * registered, keeping the web/mobile write path byte-identical.
 */
export function flushHar(runDir: string, entries: unknown[]): void {
  const json = JSON.stringify({ log: { entries } });
  fs.writeFileSync(path.join(runDir, "har.json"), (hasKnownSecrets() ? redactSecrets(json) : json) + "\n");
}

/** One journal line: the same at-write-time scrub flushHar applies, per entry. */
function journalLine(entry: unknown): string {
  const json = JSON.stringify(entry);
  return (hasKnownSecrets() ? redactSecrets(json) : json) + "\n";
}

/**
 * Step-counted HAR writer for hot paths. har.json is the artifact and is always
 * written in full — but rewriting the WHOLE accumulated HAR every Nth step is
 * quadratic in a long request-heavy run, so between full writes the new entries
 * are APPENDED to har.journal.jsonl instead:
 *
 * - the first completed step writes har.json, so an early crash still leaves a
 *   valid (if short) HAR and any mid-run reader finds the file where it expects;
 * - later interval steps append only the entries added since the last write —
 *   O(new) instead of O(all);
 * - a FORCED call (the pre-gather/pre-gate flush in runner.ts, and driver close)
 *   writes the complete har.json from memory, then deletes the journal, whose
 *   contents har.json now supersedes. So a run that finishes normally leaves the
 *   run directory exactly as it was before this change, byte for byte.
 *
 * har.json is always serialized from the live `entries` array, never rebuilt
 * from the journal: the web driver fills a response body into an entry AFTER
 * pushing it (#captureBody), so an already-journaled line can be a stale copy of
 * an entry memory has since completed. That makes the journal a crash-recovery
 * TAIL — `har.json ++ journal` reconstructs a crashed run's traffic — and never
 * an input to the finished artifact.
 */
export function createHarFlusher(
  runDir: string,
  entries: unknown[],
  {
    interval = HAR_FLUSH_INTERVAL_STEPS,
    perf = PerfSidecar.off()
  }: { interval?: number; perf?: PerfSidecar } = {}
): ({ force }?: { force?: boolean }) => boolean {
  const parsedInterval = Math.floor(Number(interval));
  const every = Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : HAR_FLUSH_INTERVAL_STEPS;
  const journalPath = path.join(runDir, HAR_JOURNAL_FILE);
  let completedSteps = 0;
  let wrote = false;
  let journaled = 0; // entries already on disk (in har.json, or appended past it)
  let hasJournal = false; // the journal holds entries har.json does not
  return ({ force = false } = {}) => {
    if (!force) completedSteps++;
    if (!force && wrote && completedSteps % every !== 0) return false;
    // Timed here rather than at the call sites: this is the one place a HAR
    // write actually happens, so the span counts real writes (the skipped
    // between-interval calls above cost nothing and record nothing).
    const started = perf.now();
    const full = force || !wrote; // forced, or the first-step crash-recovery write
    if (full) {
      flushHar(runDir, entries);
      if (hasJournal) {
        // har.json now contains everything the journal did.
        try {
          fs.rmSync(journalPath, { force: true });
        } catch {}
        hasJournal = false;
      }
    } else if (entries.length > journaled) {
      let lines = "";
      for (let i = journaled; i < entries.length; i++) lines += journalLine(entries[i]);
      try {
        fs.appendFileSync(journalPath, lines);
        hasJournal = true;
      } catch {
        // A journal failure is diagnostic-only: the next forced flush still
        // writes the complete har.json from memory.
      }
    }
    journaled = entries.length;
    perf.span("har_flush", started, null, { entries: entries.length, forced: force, mode: full ? "har" : "journal" });
    wrote = true;
    return true;
  };
}
