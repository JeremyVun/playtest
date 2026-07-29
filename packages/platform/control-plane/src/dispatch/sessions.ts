import { ulid } from "../ulid.ts";
import { AppError, badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { encryptSecret, decryptSecret } from "../crypto/secrets.ts";
import { audit } from "../audit.ts";
import { targetSnapshot } from "./dispatcher.ts";
import { concludeMintDispatchesFor } from "./state.ts";

// A script mint grant expires after this long; past it the claim is abandoned
// and the next claimer takes over the mint (single-flight with takeover, §3a).
// TTLs are milliseconds and are bound as parameters — never interpolated into SQL.
const SCRIPT_CLAIM_TTL_MS = 5 * 60 * 1000;
const SCRIPT_MINT_TIMEOUT_S = 120;
// A standalone (forced-refresh) mint claim must survive a GHA cold start, so it
// lives as long as the reconciler's correlate deadline, not the in-group TTL.
const STANDALONE_CLAIM_TTL_MS = 15 * 60 * 1000;

export function parseSessionRef(ref: HostedDynamic) {
  const m = /^([^/]+)\/([^/]+)$/.exec(String(ref || ""));
  if (!m) throw badRequest(`session reference "${ref}" must be "<provider>/<identity>"`);
  return { providerName: m[1], identity: m[2] };
}

export async function claimSessions(ctx: HostedDynamic, { projectId, ringId = null, refs, actor, mintedByJob }: HostedDynamic) {
  const out: HostedDynamic = {};
  for (const ref of refs) {
    const { providerName, identity } = parseSessionRef(ref);
    try {
      out[ref] = await claimOne(ctx, { projectId, ringId, providerName, identity, actor, mintedByJob });
    } catch (e) {
      // A mint failure (unreachable token endpoint, missing secret, disabled
      // provider) degrades per-identity (§3a): the claim response stays 200 and
      // carries `{error}` for this ref, so the executor fails only the cases
      // that resolve to this identity — never the whole group. Anything that
      // isn't a domain error is a programming error and must still throw.
      if (!(e instanceof AppError)) throw e;
      out[ref] = { error: e.message };
    }
  }
  return out;
}

async function claimOne(ctx: HostedDynamic, { projectId, ringId = null, providerName, identity, actor, mintedByJob }: HostedDynamic) {
  // Two transactions, because minting a `token_endpoint` session is an HTTP call
  // to the customer's app and the write transaction owns the single database
  // connection for its whole duration. The first transaction is read-only on the
  // mint path (it writes only when it can answer from an existing artifact or
  // hand out a script claim), so nothing is lost by committing before the mint:
  // the artifact write below is an upsert on (provider_id, identity), so two
  // racing minters converge on one row rather than corrupting it.
  const decided = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const provider = await getProvider(tx, projectId, providerName, ringId);
    if (!provider.enabled) throw badRequest(`auth provider "${providerName}" is disabled`);
    if (!provider.identities || !(identity in provider.identities)) {
      throw badRequest(`auth provider "${providerName}" has no identity "${identity}"`);
    }
    const current = await tx.query(
      `SELECT * FROM session_artifacts
        WHERE provider_id = $1 AND identity = $2 AND expires_at > now()
        ORDER BY expires_at DESC LIMIT 1`,
      [provider.id, identity],
    );
    if (current.rows[0]) {
      await audit(tx, {
        actor,
        action: "session.delivered",
        entityType: "session_artifact",
        entityId: current.rows[0].id,
        projectId,
        detail: { provider: provider.name, identity, minted: false },
      });
      return { session: sessionView(ctx, current.rows[0]) };
    }

    // `script` providers mint runner-side: hand out a single-flight mint grant
    // (root secrets resolved here, delivered only in this response) or tell the
    // caller another executor is already minting (§3a claim broker).
    if (provider.kind === "script") {
      return { session: await scriptClaim(ctx, tx, { provider, identity, actor, mintedByJob, projectId }) };
    }
    return { provider };
  });
  if (decided.session) return decided.session;

  const provider = decided.provider;
  const storageState = await mintStorageState(ctx, provider, identity);
  return await ctx.db.withTx(async (tx: HostedDynamic) => {
    const expiresAt = new Date(Date.now() + Number(provider.ttl_minutes || 60) * 60 * 1000);
    const id = ulid();
    const ciphertext = encryptSecret(ctx.config.kmsKey, JSON.stringify(storageState));
    const { rows } = await tx.query(
      `INSERT INTO session_artifacts (id, provider_id, identity, ciphertext, expires_at, minted_by_job)
         VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider_id, identity)
         DO UPDATE SET ciphertext = EXCLUDED.ciphertext, minted_at = now(),
                       expires_at = EXCLUDED.expires_at, minted_by_job = EXCLUDED.minted_by_job
       RETURNING *`,
      [id, provider.id, identity, ciphertext, expiresAt, mintedByJob ?? null],
    );
    await audit(tx, {
      actor,
      action: "session.minted",
      entityType: "session_artifact",
      entityId: rows[0].id,
      projectId,
      detail: { provider: provider.name, identity, kind: provider.kind },
    });
    await audit(tx, {
      actor,
      action: "session.delivered",
      entityType: "session_artifact",
      entityId: rows[0].id,
      projectId,
      detail: { provider: provider.name, identity, minted: true },
    });
    return sessionView(ctx, rows[0]);
  });
}

export async function forceMintSession(ctx: HostedDynamic, { providerId, identity, actor }: HostedDynamic) {
  // As in claimOne: the mint itself is network I/O and must not run inside the
  // write transaction. The first transaction only decides what to do.
  const outcome = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const provider = await getProviderById(tx, providerId);
    if (!provider.enabled) throw badRequest(`auth provider "${provider.name}" is disabled`);
    const chosen = identity || Object.keys(provider.identities || {})[0];
    if (!chosen) throw badRequest(`auth provider "${provider.name}" has no identities`);
    if (!(chosen in provider.identities)) throw badRequest(`auth provider "${provider.name}" has no identity "${chosen}"`);
    // `script` providers mint runner-side (§3a): a forced refresh becomes a
    // standalone `mint` workflow dispatch, not a control-plane mint. The
    // workflow_dispatch POST happens after this tx commits (below).
    if (provider.kind === "script") {
      return { mintDispatch: await grantStandaloneMint(ctx, tx, { provider, identity: chosen, actor }) };
    }
    return { provider, chosen };
  });
  if (outcome.mintDispatch) return await sendStandaloneMint(ctx, outcome.mintDispatch);

  const { provider, chosen } = outcome;
  const storageState = await mintStorageState(ctx, provider, chosen);
  return await ctx.db.withTx(async (tx: HostedDynamic) => {
    const expiresAt = new Date(Date.now() + Number(provider.ttl_minutes || 60) * 60 * 1000);
    const id = ulid();
    const { rows } = await tx.query(
      `INSERT INTO session_artifacts (id, provider_id, identity, ciphertext, expires_at, minted_by_job)
         VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider_id, identity)
         DO UPDATE SET ciphertext = EXCLUDED.ciphertext, minted_at = now(),
                       expires_at = EXCLUDED.expires_at, minted_by_job = EXCLUDED.minted_by_job
       RETURNING *`,
      [id, provider.id, chosen, encryptSecret(ctx.config.kmsKey, JSON.stringify(storageState)), expiresAt, "forced"],
    );
    await audit(tx, {
      actor,
      action: "session.minted",
      entityType: "session_artifact",
      entityId: rows[0].id,
      projectId: provider.project_id,
      detail: { provider: provider.name, identity: chosen, forced: true },
    });
    return sessionMeta(rows[0]);
  });
}

/**
 * In-tx half of a standalone script mint (§3a forced refresh): single-flight
 * claim + `mint` dispatch ledger row. Returns what sendStandaloneMint needs;
 * if a mint for this identity is already in flight, returns that one instead
 * of double-dispatching (the button is safe to mash).
 */
async function grantStandaloneMint(ctx: HostedDynamic, tx: HostedDynamic, { provider, identity, actor }: HostedDynamic) {
  if (!provider.code || !String(provider.code).trim()) {
    throw badRequest(`script auth provider "${provider.name}" has no mint script code`);
  }
  const open = await tx.query(
    `SELECT * FROM session_claims
      WHERE provider_id = $1 AND identity = $2 AND status = 'pending' AND expires_at > now()
      ORDER BY created_at LIMIT 1`,
    [provider.id, identity],
  );
  if (open.rows[0]) {
    const existing = await tx.query(
      `SELECT id FROM dispatches
        WHERE kind = 'mint' AND ref_id = $1 AND status IN ('requested','scheduled','running')
        ORDER BY attempt DESC LIMIT 1`,
      [open.rows[0].id],
    );
    return { alreadyPending: true, claimId: open.rows[0].id, dispatchId: existing.rows[0]?.id ?? null };
  }
  // Takeover of abandoned grants, exactly as the in-group claim path does.
  await tx.query(
    `DELETE FROM session_claims WHERE provider_id = $1 AND identity = $2 AND status = 'pending'`,
    [provider.id, identity],
  );
  const claimId = ulid();
  await tx.query(
    `INSERT INTO session_claims (id, provider_id, identity, expires_at)
       VALUES ($1, $2, $3, $4)`,
    [claimId, provider.id, identity, new Date(Date.now() + STANDALONE_CLAIM_TTL_MS)],
  );
  const dispatchId = ulid();
  const attempt = await tx.query(
    `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM dispatches WHERE kind = 'mint' AND ref_id = $1`,
    [claimId],
  );
  // A ring-bound provider mints on the ring's own runners and carries that
  // ring's target snapshot, exactly as a run group's offer does; a project-wide
  // one (null `ring_id`) keeps the empty-label mint any runner in the project
  // takes, with a null target — its project is still named on the envelope.
  let labels: HostedDynamic[] = [];
  let target: HostedDynamic = null;
  if (provider.ring_id) {
    const bound = await tx.query(
      `SELECT r.*, a.key AS application_key, a.driver AS application_driver,
              a.platform AS application_platform
         FROM rings r JOIN applications a ON a.id = r.application_id
        WHERE r.id = $1`,
      [provider.ring_id],
    );
    const ring = bound.rows[0];
    if (ring) {
      labels = ring.runner_labels || [];
      target = targetSnapshot(
        {
          id: ring.application_id,
          key: ring.application_key,
          driver: ring.application_driver,
          platform: ring.application_platform ?? null,
        },
        ring,
        labels,
      );
    }
  }
  // The labels and target snapshots are written WITH the ledger row: this row
  // IS the claim-board entry, and a mint is served on the same board as a run
  // group.
  await tx.query(
    `INSERT INTO dispatches (id, project_id, kind, ref_id, attempt, status, labels, target)
       VALUES ($1, $2, 'mint', $3, $4, 'requested', $5, $6)`,
    [dispatchId, provider.project_id, claimId, attempt.rows[0].attempt, labels, target],
  );
  await audit(tx, {
    actor,
    action: "session.mint_dispatched",
    entityType: "session_claim",
    entityId: claimId,
    projectId: provider.project_id,
    detail: { provider: provider.name, identity, dispatch_id: dispatchId },
  });
  return { claimId, dispatchId, projectId: provider.project_id, attempt: attempt.rows[0].attempt, labels };
}

/** Post-tx half: post the mint to the claim board (dispatch/pool.ts). Nothing
 * is started — the row stays `requested` until a runner claims it. */
async function sendStandaloneMint(ctx: HostedDynamic, mint: HostedDynamic) {
  if (mint.alreadyPending) {
    return { pending: true, claim_id: mint.claimId, dispatch_id: mint.dispatchId };
  }
  await ctx.board.postDispatch({
    dispatchId: mint.dispatchId,
    kind: "mint",
    refId: mint.claimId,
    labels: mint.labels,
  });
  return { pending: true, claim_id: mint.claimId, dispatch_id: mint.dispatchId };
}

/**
 * The grant a standalone mint executor fetches (GET /runner/mints/:claim):
 * the same payload shape the in-group claim path delivers, root secrets
 * resolved at read time and returned only in this response.
 */
export async function standaloneMintGrant(ctx: HostedDynamic, { claimId, executorId }: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT c.*, p.name AS provider_name, p.code, p.identities, p.config, p.project_id, p.kind
       FROM session_claims c JOIN auth_providers p ON p.id = c.provider_id
      WHERE c.id = $1`,
    [claimId],
  );
  const claim = rows[0];
  if (!claim) throw notFound(`no session claim "${claimId}"`);
  if (claim.status !== "pending") throw conflict(`session claim "${claimId}" was already fulfilled`);
  if (new Date(claim.expires_at) < new Date()) throw conflict(`session claim "${claimId}" has expired`);
  if (claim.executor_id && executorId && claim.executor_id !== executorId) {
    throw forbidden(`session claim "${claimId}" belongs to another executor`);
  }
  const provider: HostedDynamic = { name: claim.provider_name, code: claim.code, identities: claim.identities, config: claim.config };
  return {
    claim_id: claim.id,
    provider: claim.provider_name,
    identity: claim.identity,
    code: claim.code,
    identity_config: claim.identities?.[claim.identity] ?? {},
    env: await resolveScriptEnv(ctx, ctx.db, provider, claim.project_id),
    timeout_s: SCRIPT_MINT_TIMEOUT_S,
  };
}

/** Conclude the `mint` dispatch ledger row once its claim is fulfilled/failed. */
export async function concludeMintDispatch(ctx: HostedDynamic, claimId: HostedDynamic, error = null) {
  await concludeMintDispatchesFor(ctx.db, claimId, { error: error ? String(error).slice(0, 500) : null });
}

export async function listProviderSessions(ctx: HostedDynamic, providerId: HostedDynamic) {
  const provider = await getProviderById(ctx.db, providerId);
  const { rows } = await ctx.db.query(
    `SELECT id, identity, minted_at, expires_at, minted_by_job
       FROM session_artifacts WHERE provider_id = $1 ORDER BY identity`,
    [provider.id],
  );
  return rows.map(sessionMeta);
}

/**
 * Single-flight claim for a `script` provider (the enclosing BEGIN IMMEDIATE
 * holds the database write lock, so claim decisions serialize). Returns either a `wait`
 * ticket (someone else is minting) or a `mint` grant carrying the provider code
 * and its resolved root secrets — delivered only in this response, never
 * persisted. The winner runs the script clean-room and POSTs …/fulfill.
 */
async function scriptClaim(ctx: HostedDynamic, tx: HostedDynamic, { provider, identity, actor, mintedByJob, projectId }: HostedDynamic) {
  if (!provider.code || !String(provider.code).trim()) {
    throw badRequest(`script auth provider "${provider.name}" has no mint script code`);
  }
  const open = await tx.query(
    `SELECT * FROM session_claims
      WHERE provider_id = $1 AND identity = $2 AND status = 'pending' AND expires_at > now()
      ORDER BY created_at LIMIT 1`,
    [provider.id, identity],
  );
  if (open.rows[0]) {
    return { pending: true, wait: { claim_id: open.rows[0].id, retry_in_s: 2 } };
  }
  // Abandoned (expired) claims lose their grant here: takeover, not deadlock.
  await tx.query(
    `DELETE FROM session_claims WHERE provider_id = $1 AND identity = $2 AND status = 'pending'`,
    [provider.id, identity],
  );
  const id = ulid();
  await tx.query(
    `INSERT INTO session_claims (id, provider_id, identity, executor_id, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
    [id, provider.id, identity, mintedByJob ?? null, new Date(Date.now() + SCRIPT_CLAIM_TTL_MS)],
  );
  await audit(tx, {
    actor,
    action: "session.mint_granted",
    entityType: "session_claim",
    entityId: id,
    projectId,
    detail: { provider: provider.name, identity },
  });
  return {
    pending: true,
    mint: {
      claim_id: id,
      provider: provider.name,
      identity,
      code: provider.code,
      identity_config: provider.identities?.[identity] ?? {},
      env: await resolveScriptEnv(ctx, tx, provider, projectId),
      timeout_s: SCRIPT_MINT_TIMEOUT_S,
    },
  };
}

/** Resolve a script provider's config.secret_env {VAR: secretName} to plaintext. */
async function resolveScriptEnv(ctx: HostedDynamic, tx: HostedDynamic, provider: HostedDynamic, projectId: HostedDynamic) {
  const out: HostedDynamic = {};
  for (const [name, secretName] of Object.entries(provider.config?.secret_env || {})) {
    if (typeof secretName !== "string") {
      throw badRequest(`script auth provider "${provider.name}" config.secret_env.${name} must be a secret name`);
    }
    out[name] = await loadSecret({ ...ctx, db: tx }, projectId, secretName);
  }
  return out;
}

/**
 * Complete (or abandon) a script mint grant. Success encrypts the storage state
 * into session_artifacts and returns the session so the winner needs no
 * re-claim; failure deletes the claim so the next claimer takes over the mint.
 */
export async function fulfillSessionClaim(ctx: HostedDynamic, { claimId, executorId = null, storageState, error, actor }: HostedDynamic) {
  return await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(
      `SELECT c.*, p.name AS provider_name, p.ttl_minutes, p.project_id
         FROM session_claims c JOIN auth_providers p ON p.id = c.provider_id
        WHERE c.id = $1`,
      [claimId],
    );
    const claim = rows[0];
    if (!claim) throw notFound(`no session claim "${claimId}"`);
    if (claim.status !== "pending") throw conflict(`session claim "${claimId}" was already fulfilled`);
    // The claim must be bound to the calling executor (Phase 7 security review):
    // in-group claims bind at creation, standalone mint claims bind at exchange.
    // A runner token holder who merely learns a pending claim id must not be able
    // to poison it before its owning executor fulfills. `executorId` is always
    // present (both fulfill routes derive it from the runner token).
    if (executorId && claim.executor_id !== executorId) {
      throw forbidden(`session claim "${claimId}" belongs to another executor`);
    }
    if (new Date(claim.expires_at) < new Date()) {
      await tx.query(`DELETE FROM session_claims WHERE id = $1`, [claimId]);
      throw conflict(`session claim "${claimId}" expired before it was fulfilled`);
    }

    if (error != null) {
      await tx.query(`DELETE FROM session_claims WHERE id = $1`, [claimId]);
      await audit(tx, {
        actor,
        action: "session.mint_failed",
        entityType: "session_claim",
        entityId: claimId,
        projectId: claim.project_id,
        detail: { provider: claim.provider_name, identity: claim.identity, error: String(error).slice(0, 500) },
      });
      return { ok: true, failed: true };
    }

    const storage = parseStorageState(storageState, `mint for "${claim.provider_name}/${claim.identity}"`);
    // One winner per grant. The read above decided on this claim; this update
    // re-asserts that decision as the write's own precondition (replacing the
    // row lock the Postgres version took), so a second fulfil of the same grant
    // loses here instead of overwriting the winner's session artifact.
    const won = await tx.query(
      `UPDATE session_claims SET status = 'fulfilled'
        WHERE id = $1 AND status = 'pending' AND expires_at > $2`,
      [claimId, new Date()],
    );
    if (won.rowCount === 0) throw conflict(`session claim "${claimId}" was already fulfilled`);
    const expiresAt = new Date(Date.now() + Number(claim.ttl_minutes || 60) * 60 * 1000);
    const { rows: artifact } = await tx.query(
      `INSERT INTO session_artifacts (id, provider_id, identity, ciphertext, expires_at, minted_by_job)
         VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider_id, identity)
         DO UPDATE SET ciphertext = EXCLUDED.ciphertext, minted_at = now(),
                       expires_at = EXCLUDED.expires_at, minted_by_job = EXCLUDED.minted_by_job
       RETURNING *`,
      [
        ulid(),
        claim.provider_id,
        claim.identity,
        encryptSecret(ctx.config.kmsKey, JSON.stringify(storage)),
        expiresAt,
        executorId ?? claim.executor_id ?? null,
      ],
    );
    for (const action of ["session.minted", "session.delivered"]) {
      await audit(tx, {
        actor,
        action,
        entityType: "session_artifact",
        entityId: artifact[0].id,
        projectId: claim.project_id,
        detail: { provider: claim.provider_name, identity: claim.identity, kind: "script", claim_id: claimId },
      });
    }
    return { session: sessionView(ctx, artifact[0]) };
  });
}

async function mintStorageState(ctx: HostedDynamic, provider: HostedDynamic, identity: HostedDynamic) {
  const identityCfg = provider.identities?.[identity] ?? {};
  if (provider.kind === "storage_state_secret") {
    const secretName = typeof identityCfg === "string" ? identityCfg : identityCfg.secret;
    if (!secretName) throw badRequest(`identity "${identity}" on provider "${provider.name}" needs a secret name`);
    const secret = await loadSecret(ctx, provider.project_id, secretName);
    return parseStorageState(secret, `secret "${secretName}"`);
  }
  if (provider.kind === "token_endpoint") {
    return await mintTokenEndpoint(provider, identity, identityCfg);
  }
  if (provider.kind === "script") {
    // Script providers never mint control-plane-side: in-group mints go through
    // the claim broker, forced refreshes through the standalone mint dispatch
    // (grantStandaloneMint above). Reaching here is a programming error.
    throw new AppError("internal", `script provider "${provider.name}" cannot mint on the control plane`);
  }
  throw badRequest(`unsupported auth provider kind "${provider.kind}"`);
}

async function loadSecret(ctx: HostedDynamic, projectId: HostedDynamic, name: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT ciphertext FROM secrets WHERE project_id = $1 AND name = $2`, [
    projectId,
    name,
  ]);
  if (!rows[0]) throw notFound(`no secret "${name}"`);
  return decryptSecret(ctx.config.kmsKey, rows[0].ciphertext);
}

async function mintTokenEndpoint(provider: HostedDynamic, identity: HostedDynamic, identityCfg: HostedDynamic) {
  const cfg = provider.config || {};
  if (!cfg.url) throw badRequest(`token_endpoint provider "${provider.name}" needs config.url`);
  const method = cfg.method || "POST";
  const body = renderTemplates(cfg.body ?? identityCfg.body ?? identityCfg, { identity, ...identityCfg });
  const headers = renderTemplates(cfg.headers ?? {}, { identity, ...identityCfg });
  if (!headers["content-type"] && !headers["Content-Type"]) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(cfg.url, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body),
    });
  } catch (e: HostedDynamic) {
    throw new AppError("storage_error", `token endpoint for "${provider.name}/${identity}" failed: ${e.message}`, { cause: e });
  }
  if (!res.ok) {
    throw new AppError("storage_error", `token endpoint for "${provider.name}/${identity}" returned HTTP ${res.status}`);
  }
  const data = await res.json();
  return parseStorageState(data.storage_state ?? data.storageState ?? data, `token endpoint "${provider.name}/${identity}"`);
}

function parseStorageState(value: HostedDynamic, label: HostedDynamic) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (e: HostedDynamic) {
      throw badRequest(`${label} did not contain valid JSON storage state: ${e.message}`);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${label} must resolve to a Playwright storage_state object`);
  }
  if (!Array.isArray(value.cookies)) value.cookies = [];
  if (!Array.isArray(value.origins)) value.origins = [];
  return value;
}

function renderTemplates(value: HostedDynamic, vars: HostedDynamic): HostedDynamic {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, key) => String(vars[key] ?? ""));
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplates(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderTemplates(v, vars)]));
  }
  return value;
}

// The Postgres versions took FOR UPDATE on the provider row while a mint decided
// what to write. Under SQLite the enclosing withTx is BEGIN IMMEDIATE — one
// writer holds the whole database — and the session_artifacts upsert on
// (provider_id, identity) is what actually makes the mint write idempotent, so
// no per-row lock is needed or expressible.
//
// `ringId` is the ring whose session references are being resolved. A provider
// is reachable from it only when the provider is project-wide (`ring_id` null)
// or bound to that exact ring: a lookup by (project, name) alone would let one
// ring borrow another ring's provider — and with it another ring's credentials —
// simply by naming it in its own `auth.identities`.
async function getProvider(q: HostedDynamic, projectId: HostedDynamic, name: HostedDynamic, ringId: HostedDynamic = null) {
  const { rows } = await q.query(`SELECT * FROM auth_providers WHERE project_id = $1 AND name = $2`, [
    projectId,
    name,
  ]);
  if (!rows[0]) throw notFound(`no auth provider "${name}"`);
  const provider = rows[0];
  if (provider.ring_id && provider.ring_id !== ringId) {
    throw forbidden(
      `auth provider "${name}" is bound to another ring — a ring may use its own providers and the ` +
        `project-wide ones, never another ring's credentials`,
    );
  }
  return provider;
}

async function getProviderById(q: HostedDynamic, id: HostedDynamic) {
  const { rows } = await q.query(`SELECT * FROM auth_providers WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound(`no auth provider "${id}"`);
  return rows[0];
}

function sessionView(ctx: HostedDynamic, row: HostedDynamic) {
  return { ...sessionMeta(row), storage_state: JSON.parse(decryptSecret(ctx.config.kmsKey, row.ciphertext)) };
}

function sessionMeta(row: HostedDynamic) {
  return {
    id: row.id,
    identity: row.identity,
    minted_at: row.minted_at,
    expires_at: row.expires_at,
    minted_by_job: row.minted_by_job,
  };
}
