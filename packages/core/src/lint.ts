// Static, offline quality lint for resolved cases — advisory only (warnings,
// never failures; the command exits 0). Schema validity, unknown keys, and
// wrong-driver success kinds are already enforced by config.ts at load time and
// surface as DummyConfigError (exit 2); lint adds only the content-quality
// signals the schema cannot express: a journey whose gate checks nothing, an
// empty or duplicated assert, or an assert that should have been a deterministic
// kind (a bare selector / URL). Deliberately conservative — better to miss than
// to cry wolf. See docs/contracts/interfaces.md#listing-linting-and-scaffolding.

// An assert value that is really a CSS selector (#id, .class, [attr=...], tag[..])
// or a URL / bare path — the author reached for assert where a deterministic
// kind fits. Kept tight: only flag values with no spaces that look structural.
// Anchored both ends (like LOOKS_LIKE_URL) so a natural-language assert that
// merely starts with a bracket — e.g. "[the banner] shows the total" — isn't
// mistaken for a selector: a real selector is one contiguous, space-free token.
const LOOKS_LIKE_SELECTOR = /^(?:[#.\[]|[a-zA-Z][\w-]*[#.\[])\S*$/;
const LOOKS_LIKE_URL = /^(https?:\/\/|\/)\S*$/;

interface LintableCase {
  mode: string;
  success: Array<Record<string, unknown>>;
}

export interface LintWarning {
  level: "warn";
  message: string;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ");

/**
 * Quality warnings for one resolved case. Pure: no I/O.
 * @param {{ mode: string, success: Array<Record<string,unknown>> }} resolvedCase
 * @returns {Array<{ level: "warn", message: string }>}
 */
export function lintCase(resolvedCase: LintableCase): LintWarning[] {
  const warnings: LintWarning[] = [];
  const warn = (message: string) => warnings.push({ level: "warn", message });
  const success = resolvedCase.success ?? [];

  // A journey with no gate can never fail — it asserts nothing about the app.
  // (Discovery cases legitimately have no success list, so scope this to journeys.)
  if (resolvedCase.mode !== "discovery" && success.length === 0) {
    warn(`journey has no success criteria — the gate checks nothing, so this case can never fail (add an assert or a deterministic check)`);
  }

  const seen = new Map(); // normalized assert text → first 0-based position
  success.forEach((criterion, i) => {
    // The schema allows at most one check kind per entry (optionally plus a
    // cosmetic label); only assert carries the free-form text the deterministic
    // kinds don't. Key off `"assert" in criterion`, not a key count.
    if (!("assert" in criterion)) return;
    const raw = criterion.assert;
    const where = `success[${i}]`;

    if (typeof raw !== "string" || !raw.trim()) {
      warn(`${where}: assert is empty — it has no claim to check`);
      return;
    }
    const value = norm(raw);

    if (LOOKS_LIKE_SELECTOR.test(value)) {
      warn(`${where}: assert looks like a CSS selector ("${value}") — use element_exists for a deterministic, model-free check`);
    } else if (LOOKS_LIKE_URL.test(value)) {
      warn(`${where}: assert looks like a URL/path ("${value}") — use url_matches for a deterministic, model-free check`);
    }

    const first = seen.get(value);
    if (first !== undefined) {
      warn(`${where}: assert duplicates success[${first}] — the same claim is checked (and billed) twice`);
    } else {
      seen.set(value, i);
    }
  });

  return warnings;
}
