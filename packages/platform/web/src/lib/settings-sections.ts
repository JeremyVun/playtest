// Settings information architecture (hosted IA). P1 collapsed the original
// surface to Test targets, Team, and Audit.
// Plugins, Integrations, and Retention are gone: the UI was removed in P1 and
// the plugin/integration runtime in P5. Models joined later: the project-wide
// actor/grader defaults are an admin cost/quality policy with nowhere honest
// to hide inside the other three. Runs holds the project-wide concurrency
// policy that suites inherit. Test targets left: what a project tests and
// where each surface is deployed is Applications, a first-class project
// section, not a tab under Settings. Kept DOM-free so the hermetic gate can
// assert the section set and role disclosure without a browser.
export const SETTINGS_SECTIONS: WebDynamic = [
  // Runners is the other half of "where does a run happen": a ring says what a
  // run points at, Runners says which machine executes it. Registering and
  // revoking are developer acts, like the rings they serve.
  //
  // `requires` is a DEPLOYMENT capability, not a role: under any placement
  // adapter but the pool nothing here can ever be used — the claim board is not
  // served and the runner would have nothing to claim — so the section is not
  // offered at all rather than offered and then explained away.
  { id: "runners", label: "Runners", min: "developer", requires: "pool_dispatch" },
  { id: "runs", label: "Runs", min: "admin" },
  { id: "models", label: "Models", min: "admin" },
  { id: "team", label: "Team", min: "admin" },
  { id: "audit", label: "Audit", min: "admin" },
];

/**
 * The sections a principal may see: their role, and what this DEPLOYMENT can
 * do (`/me` capabilities). A section naming a capability the server was never
 * configured for is not shown — offering it would turn an operator's choice
 * into what looks like a broken feature.
 * @param {(minRole: string) => boolean} has
 * @param {Record<string, unknown>} capabilities
 */
export function visibleSections(has: WebDynamic, capabilities: WebDynamic = {}) {
  return SETTINGS_SECTIONS.filter((s: WebDynamic) => has(s.min) && (!s.requires || capabilities[s.requires] === true));
}
