// Resolve the request principal, in precedence order:
//   1. Authorization: Bearer <api_token>  → token principal
//   2. session cookie                       → user principal (+ memberships)
//   3. PLAYTEST_AUTH=dev                     → the fixed dev admin (admin everywhere)
//   4. otherwise                            → anonymous (null)
// A user principal carries a `roles` Map (projectId → role); a dev principal sets
// isDevAdmin so effectiveRole() returns admin for every project.
import { principalForToken } from "./tokens.ts";
import { userForSession, parseCookies, COOKIE_NAME } from "./sessions.ts";
import { loadMemberships } from "./users.ts";

export async function resolvePrincipal(ctx: HostedDynamic, req: HostedDynamic) {
  const auth = req.headers["authorization"];
  if (auth && /^Bearer\s+/i.test(auth)) {
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    const principal = await principalForToken(ctx.db, token);
    return principal; // null when the token is unknown/expired → treated as anonymous
  }

  const cookies = parseCookies(req.headers["cookie"]);
  const sessionId = cookies[COOKIE_NAME];
  if (sessionId) {
    const user = await userForSession(ctx.db, sessionId);
    if (user) {
      return {
        kind: "user",
        userId: user.id,
        subject: user.subject,
        email: user.email,
        name: user.name,
        sessionId: user.session_id,
        roles: await loadMemberships(ctx.db, user.id),
      };
    }
  }

  if (ctx.config.auth.mode === "dev") {
    return {
      kind: "user",
      userId: ctx.devUserId,
      subject: ctx.config.auth.devUser.subject,
      email: ctx.config.auth.devUser.email,
      name: ctx.config.auth.devUser.name,
      isDevAdmin: true,
      roles: new Map(),
    };
  }

  return null;
}
