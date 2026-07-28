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
import { badRequest, forbidden, unauthenticated } from "../errors.ts";
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
 * Resolve a presented credential to the runner row it identifies — identity
 * only, with no judgment about whether that runner may still take work. Unknown
 * credentials are `401`.
 */
export async function runnerIdentity(db: Db, plaintext: unknown): Promise<DbRow> {
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
  return runner;
}

/**
 * Resolve a presented credential to a runner that may still take work. Unknown
 * credentials are `401`; a revoked one is `403` and says so, because "your
 * runner was revoked" is a different action from "your credential is wrong".
 */
export async function runnerForCredential(db: Db, plaintext: unknown): Promise<DbRow> {
  const runner = await runnerIdentity(db, plaintext);
  if (runner.revoked_at) {
    throw forbidden(
      `runner "${runner.name}" was revoked and can no longer take work — ` +
        `register it again under Settings → Runners to get a new credential`,
    );
  }
  // An expired ephemeral registration is refused exactly like a revoked one, and
  // at the same three places (poll, claim, exchange), because "the CI job that
  // owns this credential is over" and "someone revoked this runner" have the
  // same consequence: no new work, and no new scoped bearer.
  if (isExpired(runner)) {
    throw forbidden(
      `runner "${runner.name}" registered for one CI job and that registration expired — ` +
        `register again with POST /api/v1/runner/pool/register-oidc from the job that needs it`,
    );
  }
  return runner;
}

/** Has this (ephemeral) registration passed its expiry? Standing runners never do. */
export function isExpired(runner: { expires_at?: Date | number | null }, now: number = Date.now()): boolean {
  if (!runner.expires_at) return false;
  return new Date(runner.expires_at).getTime() <= now;
}

/** The runner behind this request, refusing anything but a live credential. */
export async function requireRunnerCredential(ctx: RequestContext): Promise<DbRow> {
  return await runnerForCredential(ctx.db, presentedRunnerCredential(ctx.req as never));
}

/**
 * The runner behind this request, identified but not judged — for the ONE route
 * where a revoked or expired credential must still be answered: heartbeating a
 * claim it already holds.
 *
 * Revocation and expiry mean "no new work and no new scoped bearer", and the
 * contract is explicit that a group already exchanged finishes under the bearer
 * it was issued. Refusing its heartbeats would break exactly that promise twice
 * over — the agent reads a 4xx as "this claim is not mine any more" and tears
 * the run down, and `heartbeat_at` would go stale until the reconciler failed
 * the group as a dead executor. So the heartbeat's authorization is the claim
 * itself: the caller must hold the dispatch it is beating (checked by the
 * route), which no revoked credential can newly acquire.
 */
export async function requireRunnerIdentity(ctx: RequestContext): Promise<DbRow> {
  return await runnerIdentity(ctx.db, presentedRunnerCredential(ctx.req as never));
}

const MAX_LABELS = 32;
const MAX_LABEL_LENGTH = 64;

/**
 * The characters a label may be spelled with. Labels are pure routing tokens, so
 * the alphabet can be the narrow one that survives every carrier they travel on:
 * a comma-joined `--labels` argument (a comma inside a label would silently
 * become two labels), a `?labels=` query, and the start command a person pastes
 * into a shell straight out of the console.
 */
const LABEL_CHARSET = /^[A-Za-z0-9._-]+$/;
const LABEL_CHARSET_HELP = 'letters, digits, ".", "_" and "-"';

/**
 * Validate and de-duplicate a label list. One implementation for every surface
 * that accepts labels — runner registration, environment `runner_labels`, a
 * per-launch pin, ephemeral CI registration, and check-in re-advertisement — so
 * a label a runner may advertise is exactly a label a launch may ask for.
 */
export function normalizeLabels(value: unknown, field = "labels"): string[] {
  const labels = value ?? [];
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== "string" || !l.trim())) {
    throw badRequest(`"${field}" must be an array of non-empty strings`);
  }
  if (labels.length > MAX_LABELS) throw badRequest(`"${field}" may hold at most ${MAX_LABELS} labels`);
  if (labels.some((l: string) => l.length > MAX_LABEL_LENGTH)) {
    throw badRequest(`a label is at most ${MAX_LABEL_LENGTH} characters`);
  }
  const trimmed = labels.map((l: string) => l.trim());
  const bad = trimmed.find((l) => !LABEL_CHARSET.test(l));
  if (bad !== undefined) {
    throw badRequest(`"${bad}" is not a usable label — a label may use only ${LABEL_CHARSET_HELP} (for example "ios-sim" or "ci-run-1234567")`);
  }
  return [...new Set(trimmed)];
}

/** Job labels ⊆ runner labels. An empty job label set matches any runner. */
export function labelsMatch(jobLabels: readonly string[] | null, runnerLabels: readonly string[] | null): boolean {
  const advertised = new Set(runnerLabels || []);
  return (jobLabels || []).every((l) => advertised.has(l));
}
