// Temporary SPA compatibility redirects for surfaces removed in the platform
// simplification. Existing bookmarks resolve to their surviving home:
//   - suite index  → Suites (the project home is the only suite index)
//   - insights      → Findings (Insights removed; findings own durable claims)
//   - search        → Suites (global search removed until a measured need)
//   - assistant     → New story with Help me draft open (P2: the standalone
//                     authoring assistant is replaced by inline story drafting)
//   - files         → Suite settings (the raw file tree is gone from the web
//                     app; playtest.yaml is a form, the code tier is CLI/.tar)
// Suite-detail, run, finding, and viewer deep links are NOT redirected — they
// stay stable. The `/review` batch view also stays reachable (contextual, off
// the rail), so it is deliberately absent here.
// Kept DOM-free so the hermetic gate can assert the mapping without a browser.
const RULES: WebDynamic = [
  { rx: /^\/p\/([^/]+)\/suites\/?$/, to: (m: WebDynamic) => `/p/${m[1]}` },
  { rx: /^\/p\/([^/]+)\/suites\/([^/]+)\/assistant\/?$/, to: (m: WebDynamic) => `/p/${m[1]}/suites/${m[2]}/new?assist=1` },
  { rx: /^\/p\/([^/]+)\/suites\/([^/]+)\/files\/?$/, to: (m: WebDynamic) => `/p/${m[1]}/suites/${m[2]}/settings` },
  { rx: /^\/p\/([^/]+)\/insights(?:\/[^/]+)?\/?$/, to: (m: WebDynamic) => `/p/${m[1]}/findings` },
  // The bug-candidate queue collapsed into Findings (2026-07: candidates
  // became findings in state `new`, keeping their ids), so the queue resolves
  // to the needs-review filter and a candidate deep link to its finding.
  { rx: /^\/p\/([^/]+)\/candidates\/?$/, to: (m: WebDynamic) => `/p/${m[1]}/findings?filter=review` },
  { rx: /^\/p\/([^/]+)\/candidates\/([^/]+)\/?$/, to: (m: WebDynamic) => `/p/${m[1]}/findings/${m[2]}` },
  { rx: /^\/p\/([^/]+)\/search\/?$/, to: (m: WebDynamic) => `/p/${m[1]}` },
];

/**
 * The replacement path for a removed SPA route, or null when the path survives.
 * @param {string} pathname
 * @returns {string|null}
 */
export function redirectFor(pathname: WebDynamic) {
  for (const r of RULES) {
    const m = r.rx.exec(pathname);
    if (m) return r.to(m);
  }
  return null;
}
