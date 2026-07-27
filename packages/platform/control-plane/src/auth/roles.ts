// Per-project roles, cumulative in one order
// (docs/contracts/hosted.md#http-conventions-and-authorization):
// admin ⊇ developer ⊇ reviewer ⊇ editor ⊇ viewer. A route declares a MINIMUM role;
// a principal satisfies it when its effective role in the project ranks at least
// that high. This is the whole authZ model.
import { forbidden } from "../errors.ts";
import type { Principal } from "../types.ts";

export const ROLES = ["viewer", "editor", "reviewer", "developer", "admin"] as const;
export type Role = (typeof ROLES)[number];
const RANK: Record<Role, number> = Object.fromEntries(ROLES.map((r, i) => [r, i])) as Record<Role, number>;

/** Does `role` meet-or-exceed `minRole`? */
export function roleSatisfies(role: string | null | undefined, minRole: string): boolean {
  if (role == null) return false;
  return (RANK[role as Role] ?? -1) >= (RANK[minRole as Role] ?? Infinity);
}

/**
 * The principal's effective role in a project, or null if none.
 * - a user: their membership role (dev-bypass users are 'admin' everywhere).
 * - a token: its role, but only for its scoped project (or any project when
 *   site-scoped, i.e. project_id null).
 */
export function effectiveRole(principal: Principal | null | undefined, projectId: string): string | null | undefined {
  if (!principal) return null;
  if (principal.kind === "token") {
    if (principal.projectId == null || principal.projectId === projectId) return principal.role;
    return null;
  }
  if (principal.isDevAdmin) return "admin";
  return principal.roles?.get(projectId) ?? null;
}

/** Throw `forbidden` unless the principal has at least `minRole` in the project. */
export function requireRole(
  principal: Principal | null | undefined,
  projectId: string,
  minRole: string
): string {
  const role = effectiveRole(principal, projectId);
  if (!roleSatisfies(role, minRole)) {
    throw forbidden(
      `this action needs the "${minRole}" role in this project` +
        (role ? ` (you have "${role}")` : " (you are not a member)"),
    );
  }
  return role as string;
}
