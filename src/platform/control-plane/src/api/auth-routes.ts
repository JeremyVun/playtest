// Login/callback/logout. Two modes: OIDC code flow and PLAYTEST_AUTH=dev (a
// fixed single-user bypass for local hacking). In dev mode
// the middleware already resolves every request to the dev admin, so login just
// establishes a real session row for coherence and logout is a friendly no-op.
import {
  generatePkce,
  generateState,
  generateNonce,
  discover,
  authorizeUrl,
  exchangeCode,
  fetchUserInfo,
  signLoginState,
  verifyLoginState,
} from "../auth/oidc.ts";
import { ensureUser } from "../auth/users.ts";
import { createSession, destroySession, sessionCookie, clearedSessionCookie, parseCookies, COOKIE_NAME } from "../auth/sessions.ts";
import { redirect } from "../http.ts";
import { badRequest, AppError } from "../errors.ts";

const OIDC_STATE_COOKIE = "pt_oidc";

// Only same-origin absolute paths. Reject protocol-relative (`//host`) and
// backslash forms (`/\host`, which browsers normalize to `//host` per WHATWG URL),
// and any string carrying a C0 control or whitespace char — a tab/newline as the
// second byte (`/\t/host`) is stripped by the browser before parsing, again yielding
// `//host`, so it must be rejected before the same-origin check. Bare "/" is allowed.
const safeReturn = (raw: HostedDynamic) => {
  if (typeof raw !== "string" || /[\x00-\x20\x7f]/.test(raw)) return "/";
  return raw === "/" || /^\/[^/\\]/.test(raw) ? raw : "/";
};
const isSecure = (ctx: HostedDynamic) => ctx.config.publicUrl.startsWith("https://");

/** GET /auth/login?returnTo= */
export async function login(ctx: HostedDynamic) {
  const returnTo = safeReturn(ctx.query.get("returnTo"));
  if (ctx.config.auth.mode === "dev") {
    const user: HostedDynamic = await ensureUser(ctx.db, ctx.config.auth.devUser);
    const session = await createSession(ctx.db, user.id);
    return redirect(returnTo, [sessionCookie(session.id, { expiresAt: session.expiresAt, secure: isSecure(ctx) })]);
  }
  const oidc = ctx.config.auth.oidc;
  const endpoints = await discover(oidc.issuer);
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const nonce = generateNonce();
  const url = authorizeUrl(oidc, endpoints, { state, nonce, codeChallenge: challenge });
  const stateCookie = `${OIDC_STATE_COOKIE}=${signLoginState(oidc, { state, verifier, nonce, returnTo })}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${isSecure(ctx) ? "; Secure" : ""}`;
  return redirect(url, [stateCookie]);
}

/** GET /auth/callback?code=&state= */
export async function callback(ctx: HostedDynamic) {
  if (ctx.config.auth.mode === "dev") return redirect("/");
  const oidc = ctx.config.auth.oidc;
  const code = ctx.query.get("code");
  const state = ctx.query.get("state");
  if (!code || !state) throw badRequest("missing code/state on the OIDC callback");

  const cookies = parseCookies(ctx.req.headers["cookie"]);
  const login = verifyLoginState(oidc, cookies[OIDC_STATE_COOKIE]);
  if (!login || login.state !== state) {
    throw new AppError("bad_request", "the sign-in request expired or did not match — please try again");
  }

  const endpoints = await discover(oidc.issuer);
  const tokens: HostedDynamic = await exchangeCode(oidc, endpoints, { code, codeVerifier: login.verifier });
  const claims: HostedDynamic = await fetchUserInfo(endpoints, tokens.access_token);
  if (!claims.sub) throw new AppError("bad_request", "the identity provider returned no subject");

  const user: HostedDynamic = await ensureUser(ctx.db, {
    subject: claims.sub,
    email: claims.email || `${claims.sub}@unknown`,
    name: claims.name || claims.preferred_username || null,
  });
  const session = await createSession(ctx.db, user.id);
  return redirect(safeReturn(login.returnTo), [
    sessionCookie(session.id, { expiresAt: session.expiresAt, secure: isSecure(ctx) }),
    `${OIDC_STATE_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
  ]);
}

/** POST /auth/logout */
export async function logout(ctx: HostedDynamic) {
  const cookies = parseCookies(ctx.req.headers["cookie"]);
  if (cookies[COOKIE_NAME]) await destroySession(ctx.db, cookies[COOKIE_NAME]);
  return redirect("/", [clearedSessionCookie({ secure: isSecure(ctx) })]);
}
