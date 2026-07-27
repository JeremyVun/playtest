// The long-lived secret a self-hosted runner keeps on its own machine. It proves
// identity and nothing else: claiming assigns work, exchanging authorizes it, so
// a credential alone can never fetch a snapshot or post a report.
//
// Stored exactly like an API token (auth/tokens.ts): the plaintext is shown once
// at registration and only a SHA-256 hash is persisted, because the credential is
// high-entropy random rather than a user password. Format `ptr_<random>` — a
// prefix that is deliberately neither `pt_` (API tokens, resolved to a principal
// by auth/middleware.ts) nor `pr_` (the short-lived scoped runner bearer), so a
// credential presented to the wrong surface is refused rather than half-accepted.
import { randomBytes } from "node:crypto";
import { hashToken, tokenHashMatches } from "./tokens.ts";
import { forbidden, unauthenticated } from "../errors.ts";
import type { Db, DbRow } from "../db.ts";
import type { RequestContext } from "../types.ts";

export const RUNNER_CREDENTIAL_PREFIX = "ptr_";

/** A new credential plus the hash to store. The plaintext is never persisted. */
export function newRunnerCredential(): { plaintext: string; hash: string } {
  const plaintext = `${RUNNER_CREDENTIAL_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { plaintext, hash: hashToken(plaintext) };
}

/** The bearer credential on this request, or null when none was presented. */
export function presentedRunnerCredential(req: { headers: Record<string, unknown> }): string | null {
  const auth = String(req.headers["authorization"] || "");
  if (!/^Bearer\s+/i.test(auth)) return null;
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  return token.startsWith(RUNNER_CREDENTIAL_PREFIX) ? token : null;
}

/**
 * Resolve a presented credential to its runner row. Unknown credentials are
 * `401`; a revoked one is `403` and says so, because "your runner was revoked"
 * is a different action from "your credential is wrong".
 */
export async function runnerForCredential(db: Db, plaintext: unknown): Promise<DbRow> {
  if (typeof plaintext !== "string" || !plaintext.startsWith(RUNNER_CREDENTIAL_PREFIX)) {
    throw unauthenticated(
      "this route needs a runner credential — present the one-time value from " +
        "`POST /api/v1/projects/:project/runners` as `Authorization: Bearer ptr_…`",
    );
  }
  const { rows } = await db.query(
    `SELECT r.*, p.key AS project_key FROM runners r
       JOIN projects p ON p.id = r.project_id
      WHERE r.credential_hash = $1`,
    [hashToken(plaintext)],
  );
  const runner = rows[0];
  // The hash lookup is exact; the constant-time compare guards the (already
  // narrow) window where two rows collide in the index but differ in fact.
  if (!runner || !tokenHashMatches(plaintext, runner.credential_hash)) {
    throw unauthenticated("this runner credential is not registered — register the runner again to get a new one");
  }
  if (runner.revoked_at) {
    throw forbidden(
      `runner "${runner.name}" was revoked and can no longer take work — ` +
        `register it again under Settings → Runners to get a new credential`,
    );
  }
  return runner;
}

/** The runner behind this request, refusing anything but a live credential. */
export async function requireRunnerCredential(ctx: RequestContext): Promise<DbRow> {
  return await runnerForCredential(ctx.db, presentedRunnerCredential(ctx.req as never));
}

/** Job labels ⊆ runner labels. An empty job label set matches any runner. */
export function labelsMatch(jobLabels: readonly string[] | null, runnerLabels: readonly string[] | null): boolean {
  const advertised = new Set(runnerLabels || []);
  return (jobLabels || []).every((l) => advertised.has(l));
}
