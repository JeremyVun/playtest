// Settings information architecture (hosted IA). P1 collapsed the original
// surface to Test targets, Team, and Audit.
// Plugins, Integrations, and Retention are gone: the UI was removed in P1 and
// the plugin/integration runtime in P5. Models joined later: the project-wide
// actor/grader defaults are an admin cost/quality policy with nowhere honest
// to hide inside the other three. Runs holds the project-wide concurrency
// policy that suites inherit. Kept DOM-free so the hermetic gate can
// assert the section set and role disclosure without a browser.
export const SETTINGS_SECTIONS: WebDynamic = [
  // Test targets is visible to developers (environments/auth are developer
  // surfaces); the secret sub-panel inside is gated to admin at render time.
  { id: "test-targets", label: "Test targets", min: "developer" },
  // Runners is the other half of "where does a run happen": Test targets says
  // what a run points at, Runners says which machine executes it. Registering
  // and revoking are developer acts, like the environments they serve.
  { id: "runners", label: "Runners", min: "developer" },
  { id: "runs", label: "Runs", min: "admin" },
  { id: "models", label: "Models", min: "admin" },
  { id: "team", label: "Team", min: "admin" },
  { id: "audit", label: "Audit", min: "admin" },
];

/**
 * The sections a principal may see, given a role predicate `has(minRole)`.
 * @param {(minRole: string) => boolean} has
 */
export function visibleSections(has: WebDynamic) {
  return SETTINGS_SECTIONS.filter((s: WebDynamic) => has(s.min));
}
