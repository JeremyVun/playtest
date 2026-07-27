// App state: the signed-in principal (/me), the project list, and role helpers so
// the UI can progressively disclose developer/admin surfaces (UX: "behind role
// checks, not mixed in"). Roles from /me are keyed by project id.
import { api } from "./api.js";

const ROLES: WebDynamic = ["viewer", "editor", "reviewer", "developer", "admin"];
const rank = (r: WebDynamic) => ROLES.indexOf(r);

export const state: WebDynamic = {
  me: null, // { kind, user_id, name, email, roles: {projectId: role}, is_dev_admin, capabilities }
  projects: [], // [{id, key, name}]
  projectByKey: new Map(),
};

/**
 * Can this DEPLOYMENT call the model? (`/me` capabilities.llm — the platform LLM
 * gateway behind story drafting, study synthesis and consolidation.) A console
 * that offers a button the server was never configured to answer turns a
 * deployment choice into what looks like a broken feature, so the affordances
 * ask first and explain instead. Nothing here is an authorization check: the
 * routes still enforce their own roles.
 */
export const hasLlm = () => state.me?.capabilities?.llm !== false;

/**
 * Is the automatic dedupe sweep on for THIS project? The project's tri-state
 * pin wins; null inherits the deployment default (`/me` capabilities). The
 * manual "Find duplicates" affordance follows this toggle: it exists exactly
 * when the sweep does not.
 */
export const autoDedupeOn = (project: WebDynamic) =>
  project?.auto_dedupe ?? (state.me?.capabilities?.auto_dedupe === true);

/**
 * Is the automatic resolve sweep on for THIS project? Same tri-state shape as
 * auto-dedupe; deterministic, so no gateway is involved.
 */
export const autoResolveOn = (project: WebDynamic) =>
  project?.auto_resolve ?? (state.me?.capabilities?.auto_resolve === true);

/** Why the model-backed affordances are off, in words a person can act on. */
export const LLM_UNAVAILABLE =
  "This Playtest deployment has no model gateway configured, so it can't draft stories. "
  + "An operator can switch it on by setting PLAYTEST_LLM_BASE_URL (and PLAYTEST_LLM_API_KEY) on the control plane.";

export async function loadMe() {
  state.me = await api.get("/me");
  return state.me;
}

export async function loadProjects() {
  const { items } = await api.get("/projects");
  state.projects = items;
  state.projectByKey = new Map(items.map((p: WebDynamic) => [p.key, p]));
  return items;
}

/** The principal's role in a project id (dev admin ⇒ admin everywhere). */
export function roleIn(projectId: WebDynamic) {
  if (!state.me) return null;
  if (state.me.is_dev_admin) return "admin";
  return state.me.roles?.[projectId] || null;
}

export function hasRole(projectId: WebDynamic, minRole: WebDynamic) {
  const r = roleIn(projectId);
  return r != null && rank(r) >= rank(minRole);
}

export const displayName = () => state.me?.name || state.me?.email || "You";
