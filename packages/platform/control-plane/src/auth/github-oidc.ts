// The GitHub Actions OIDC badge, verified in one place.
//
// Two surfaces present one of these tokens and both must be judged identically,
// so this module is the single verifier rather than a check per caller:
//
//   POST /runner/exchange              a GitHub-dispatched executor proving it is
//                                      the workflow run this dispatch placed
//   POST /runner/pool/register-oidc    a CI job asking for an ephemeral runner
//                                      registration on the claim board
//
// The token is a signed JWT from GitHub, so the checks are the usual ones plus
// the pins that make "a GitHub token" mean "a token from OUR pipeline": issuer,
// audience, repository, workflow file, and ref. A deployment configures those
// pins; an unpinned check is skipped, which is why every caller is responsible
// for refusing to run at all when the pins it needs are absent (the pool's
// registration route does exactly that).
import crypto from "node:crypto";
import { AppError, unauthenticated } from "../errors.ts";

/**
 * The pins a deployment applies to a GitHub OIDC token. `oidcIssuer` and
 * `oidcAudience` are always enforced; `repository`, `workflowId` and `ref` are
 * enforced when configured. The key names match `dispatch.github` so the same
 * object shape serves both callers.
 */
export interface GithubOidcPins {
  oidcIssuer: string;
  oidcAudience: string;
  repository?: string | null;
  workflowId?: string | null;
  ref?: string | null;
}

/** The claims of a token that passed every configured check. */
export async function verifyGithubOidc(cfg: GithubOidcPins, token: unknown): Promise<HostedDynamic> {
  const [h, p, s] = String(token || "").split(".");
  if (!h || !p || !s) throw unauthenticated("GitHub OIDC token is missing or invalid");
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    throw unauthenticated("GitHub OIDC token is missing or invalid");
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== cfg.oidcIssuer) throw unauthenticated("GitHub OIDC issuer is not trusted");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.oidcAudience)) throw unauthenticated("GitHub OIDC audience is not trusted");
  if (cfg.repository && claims.repository !== cfg.repository) {
    throw unauthenticated("GitHub OIDC token is not from the pinned repository");
  }
  // Bind to the pinned workflow file and ref, not just the repo (Phase 7
  // security review): a same-repo token from an unrelated workflow must not
  // exchange. GitHub's `job_workflow_ref` is
  // "<owner>/<repo>/.github/workflows/<file>@<ref>", and GitHub always sets it
  // — a real attacker's token carries THEIR workflow ref (mismatch caught),
  // and GitHub won't sign a token omitting the claim, so enforcing only when
  // present closes the attack without breaking tokens that legitimately lack it.
  const jwr = String(claims.job_workflow_ref || claims.workflow_ref || "");
  if (cfg.workflowId && jwr) {
    const [pathPart, refPart]: HostedDynamic = jwr.split("@");
    if (!pathPart.endsWith(`/${cfg.workflowId}`)) {
      throw unauthenticated("GitHub OIDC token is not from the pinned workflow");
    }
    if (cfg.ref && refPart && refPart !== `refs/heads/${cfg.ref}` && refPart !== cfg.ref) {
      throw unauthenticated("GitHub OIDC token is not from the pinned ref");
    }
  }
  if (claims.exp && claims.exp < now) throw unauthenticated("GitHub OIDC token expired");
  if (claims.nbf && claims.nbf > now) throw unauthenticated("GitHub OIDC token is not valid yet");
  if (header.alg !== "RS256" || !header.kid) throw unauthenticated("GitHub OIDC token header is not supported");
  const res = await fetch(`${cfg.oidcIssuer}/.well-known/jwks`);
  if (!res.ok) throw new AppError("storage_error", `could not fetch GitHub OIDC JWKS: HTTP ${res.status}`);
  const jwk = (await res.json()).keys?.find((k: HostedDynamic) => k.kid === header.kid);
  if (!jwk) throw unauthenticated("GitHub OIDC signing key was not found");
  const key = await crypto.webcrypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.webcrypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    Buffer.from(s, "base64url"),
    Buffer.from(`${h}.${p}`),
  );
  if (!ok) throw unauthenticated("GitHub OIDC signature did not verify");
  return claims;
}
