// App state: the signed-in principal (/me), the project list, and role helpers so
// the UI can progressively disclose developer/admin surfaces (UX: "behind role
// checks, not mixed in"). Roles from /me are keyed by project id.
import { api } from "./api.js";

export type Role = "viewer" | "editor" | "reviewer" | "developer" | "admin";

export interface Project {
  id: string;
  key: string;
  name: string;
  parallel?: { total: number; record: number };
  models?: Record<string, string | null>;
  auto_dedupe?: boolean | null;
  auto_resolve?: boolean | null;
  auto_resolve_mode?: string | null;
  [key: string]: WebDynamic;
}

interface Principal {
  kind?: string;
  user_id?: string;
  name?: string;
  email?: string;
  roles: Record<string, Role>;
  is_dev_admin: boolean;
  capabilities: Record<string, WebDynamic>;
  [key: string]: WebDynamic;
}

interface AppState {
  me: Principal | null;
  projects: Project[];
  projectByKey: Map<string, Project>;
}

const ROLES: Role[] = ["viewer", "editor", "reviewer", "developer", "admin"];
const rank = (role: Role) => ROLES.indexOf(role);
const isRecord = (value: unknown): value is Record<string, WebDynamic> =>
  typeof value === "object" && value !== null;

export const state: AppState = {
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
  const raw = await api.get<unknown>("/me");
  if (!isRecord(raw)) throw new Error("The server returned an invalid principal.");
  state.me = {
    ...raw,
    roles: isRecord(raw.roles) ? raw.roles as Record<string, Role> : {},
    capabilities: isRecord(raw.capabilities) ? raw.capabilities : {},
    is_dev_admin: raw.is_dev_admin === true,
  };
  return state.me;
}

export async function loadProjects() {
  const raw = await api.get<unknown>("/projects");
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new Error("The server returned an invalid project list.");
  }
  const items: Project[] = raw.items.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.key !== "string") {
      throw new Error("The server returned an invalid project.");
    }
    return { ...item, id: item.id, key: item.key, name: typeof item.name === "string" ? item.name : item.key };
  });
  state.projects = items;
  state.projectByKey = new Map(items.map((project) => [project.key, project]));
  return items;
}

/** The principal's role in a project id (dev admin ⇒ admin everywhere). */
export function roleIn(projectId: string): Role | null {
  if (!state.me) return null;
  if (state.me.is_dev_admin) return "admin";
  return state.me.roles?.[projectId] || null;
}

export function hasRole(projectId: string | undefined, minRole: Role) {
  if (!projectId) return false;
  const role = roleIn(projectId);
  return role != null && rank(role) >= rank(minRole);
}

export const displayName = () => state.me?.name || state.me?.email || "You";
