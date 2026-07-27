import fs from "node:fs";
import { createRequire } from "node:module";
import type { Page } from "playwright";

interface AxeNode {
  target?: unknown[];
  html?: unknown;
}

interface AxeViolation {
  id: string;
  impact?: string | null;
  tags?: string[];
  help?: string;
  helpUrl?: string;
  nodes: AxeNode[];
}

interface AxeRuntime {
  run(document: Document, options: Record<string, unknown>): Promise<{ violations: AxeViolation[] }>;
}

declare global {
  interface Window {
    axe: AxeRuntime;
  }
}

export interface AxeCapture {
  violations: Array<{
    id: string;
    impact: string | null;
    wcag_tags: string[];
    help: string | null;
    help_url: string | null;
    nodes: Array<{ target: string[]; html: string }>;
  }>;
  counts: { total: number };
}

const require = createRequire(import.meta.url);

// WCAG 2.0 A/AA + 2.1 AA — the compliance baseline (EAA/WCAG). Excludes
// best-practice / wcag22aa noise. Future-extensible by widening this list.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21aa"];

// Caps so a pathologically broken page can't bloat a baseline.
const MAX_VIOLATIONS = 25;
const MAX_HTML_CHARS = 200;
const MAX_HELP_CHARS = 300;

let _source: string | null = null;
/** The axe.min.js source (string), read once and cached. */
export function axeSource(): string {
  if (_source === null) _source = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  return _source;
}

/**
 * Run axe-core against the freshly-settled page and return the step's a11y
 * capture — one full-page `axe.run` over the whole document, counting every
 * WCAG violation on the page. Best-effort — the caller swallows any throw so
 * axe never breaks a run.
 */
export async function runAxeInPage(page: Page): Promise<AxeCapture> {
  const hasAxe = await page.evaluate(() => !!window.axe);
  const source = hasAxe ? null : axeSource();
  return page.evaluate<AxeCapture, [string | null, string[], number, number, number]>(
    ([axeSrc, tags, maxV, maxH, maxHelp]: [string | null, string[], number, number, number]) => {
      // Inline the page-side runner (page.evaluate can't reference module fns).
      return (async () => {
        if (!window.axe) {
          if (!axeSrc) throw new Error("axe-core was not available in the page");
          new Function(axeSrc)();
        }
        const opts = { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] };
        const full = await window.axe.run(document, opts);
        const violations = full.violations.slice(0, maxV).map((v) => ({
          id: v.id,
          impact: v.impact ?? null,
          wcag_tags: (v.tags || []).filter((t) => /^wcag/.test(t)),
          // How to fix + the canonical Deque docs link — axe carries both. Both
          // are optional (older captures omit them); the viewer falls back to a
          // version-pinned constructed URL when help_url is absent.
          help: v.help ? String(v.help).slice(0, maxHelp) : null,
          help_url: v.helpUrl ? String(v.helpUrl) : null,
          nodes: v.nodes.map((n) => ({
            target: (n.target || []).map(String),
            html: String(n.html || "").slice(0, maxH),
          })),
        }));
        // `total` is a NODE count (sum of nodes across all violations), not a RULE
        // count — matching the grader's a11ySummary, which counts nodes (CONTRACTS
        // docs/contracts/engine.md#gates-and-custom-assertions).
        // violations.length would undercount a single rule that fires on
        // many elements (e.g. image-alt on 5 images).
        const total = violations.reduce((sum, v) => sum + v.nodes.length, 0);
        return { violations, counts: { total } };
      })();
    },
    [source, WCAG_TAGS, MAX_VIOLATIONS, MAX_HTML_CHARS, MAX_HELP_CHARS],
  );
}

// The page-side body is inlined in runAxeInPage because page.evaluate cannot
// close over module-scope functions; these are exported for tests/reference.
export { WCAG_TAGS, MAX_VIOLATIONS, MAX_HTML_CHARS, MAX_HELP_CHARS };
