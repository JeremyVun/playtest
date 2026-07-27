// OIDC Authorization Code flow with PKCE.
// The dev bypass (PLAYTEST_AUTH=dev) is the tested path; this is the production one.
// Kept dependency-free: discovery/exchange/userinfo are plain `fetch` calls, and the
// transient login state (verifier, nonce, returnTo) rides a short-lived HMAC-signed
// cookie keyed on the client secret — stable across replicas, unforgeable, no store.
import { createHash, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import type { ControlPlaneConfig } from "../config.ts";
import type { DynamicJson } from "../types.ts";

type OidcConfig = NonNullable<ControlPlaneConfig["auth"]["oidc"]>;
interface OidcEndpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

/** PKCE S256 pair. */
export function generatePkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export const generateState = () => b64url(randomBytes(16));
export const generateNonce = () => b64url(randomBytes(16));

const discoveryCache = new Map<string, OidcEndpoints>(); // issuer -> endpoints

/** Fetch (and cache) the issuer's OIDC discovery document. */
export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<OidcEndpoints> {
  if (discoveryCache.has(issuer)) return discoveryCache.get(issuer)!; // SAFETY: The preceding cache membership check proves the endpoint exists.
  const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed for ${issuer}: HTTP ${res.status}`);
  const doc: DynamicJson = await res.json();
  const endpoints = {
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    userinfo_endpoint: doc.userinfo_endpoint,
  };
  discoveryCache.set(issuer, endpoints);
  return endpoints;
}

/** Build the authorization redirect URL. Pure. */
export function authorizeUrl(
  oidc: OidcConfig,
  endpoints: OidcEndpoints,
  { state, nonce, codeChallenge }: { state: string; nonce: string; codeChallenge: string }
): string {
  const u = new URL(endpoints.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", oidc.clientId);
  u.searchParams.set("redirect_uri", oidc.redirectUri);
  u.searchParams.set("scope", oidc.scope);
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/** Exchange an authorization code for tokens (server-to-server, client_secret). */
export async function exchangeCode(
  oidc: OidcConfig,
  endpoints: OidcEndpoints,
  { code, codeVerifier }: { code: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: oidc.redirectUri,
    client_id: oidc.clientId,
    client_secret: oidc.clientSecret,
    code_verifier: codeVerifier,
  });
  const res = await fetchImpl(endpoints.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`OIDC token exchange failed: HTTP ${res.status}`);
  return res.json();
}

/** The userinfo claims for an access token (sub/email/name — authoritative). */
export async function fetchUserInfo(
  endpoints: OidcEndpoints,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const res = await fetchImpl(endpoints.userinfo_endpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`OIDC userinfo failed: HTTP ${res.status}`);
  return res.json();
}

// --- transient login-state cookie (HMAC-signed, ~10 min) ---

const signingKey = (oidc: OidcConfig) => createHash("sha256").update(`pt-oidc:${oidc.clientSecret}`).digest();

export function signLoginState(oidc: OidcConfig, payload: DynamicJson): string {
  const body = b64url(Buffer.from(JSON.stringify({ ...payload, t: Date.now() })));
  const mac = b64url(createHmac("sha256", signingKey(oidc)).update(body).digest());
  return `${body}.${mac}`;
}

export function verifyLoginState(
  oidc: OidcConfig,
  cookie: unknown,
  { maxAgeMs = 10 * 60 * 1000 }: { maxAgeMs?: number } = {}
): DynamicJson | null {
  if (typeof cookie !== "string" || !cookie.includes(".")) return null;
  const [body, mac] = cookie.split(".");
  const expected = b64url(createHmac("sha256", signingKey(oidc)).update(body!).digest()); // SAFETY: The delimiter guard proves both split components exist.
  const a = Buffer.from(mac!); // SAFETY: The delimiter guard proves both split components exist.
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")); // SAFETY: The delimiter guard proves both split components exist.
  } catch {
    return null;
  }
  if (!payload.t || Date.now() - payload.t > maxAgeMs) return null;
  return payload;
}
