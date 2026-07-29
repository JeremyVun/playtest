// Unit coverage: the configuration that opens ephemeral CI registration (and
// the half-configured states that must never boot), expiry as a first-class
// refusal beside revocation, shared label validation, which labels place a
// group when a launch pins them, and the authorization/mutation boundary of the
// claim itself. Hermetic: node:sqlite on a temp file, no network, no runner, no
// GitHub.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig, ServerConfigError } from "../../src/config.ts";
import { connect } from "../../src/db.ts";
import { migrate } from "../../src/migrate.ts";
import { groupDispatchLabels } from "../../src/dispatch/dispatcher.ts";
import { claimDispatch } from "../../src/api/pool.ts";
import {
  isExpired,
  newRunnerCredential,
  normalizeLabels,
  runnerForCredential,
} from "../../src/auth/runner-credentials.ts";
import { ulid } from "../../src/ulid.ts";

const base = { PLAYTEST_DATA_DIR: "/tmp/playtest-pool-oidc-config-test", PLAYTEST_AUTH: "dev" };
const pool = { ...base };
const roots: string[] = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ config

test("config: ephemeral CI registration is off until a repository is pinned", () => {
  const cfg: HostedDynamic = loadConfig({ ...pool });
  // The pins default to GitHub's real issuer and audience, but `repository` is
  // null, which is what keeps the route shut:
  // an unpinned repository check would accept a token from anyone on GitHub.
  assert.equal(cfg.dispatch.pool.oidc.repository, null);
  assert.equal(cfg.dispatch.pool.oidc.oidcIssuer, "https://token.actions.githubusercontent.com");
  assert.equal(cfg.dispatch.pool.oidc.oidcAudience, "playtest");
  assert.equal(cfg.dispatch.pool.oidc.ttlMs, 3_600_000);

  const pinned: HostedDynamic = loadConfig({
    ...pool,
    PLAYTEST_POOL_OIDC_REPOSITORY: "acme/storefront",
    PLAYTEST_POOL_OIDC_WORKFLOW: "playtest.yml",
    PLAYTEST_POOL_OIDC_REF: "main",
    PLAYTEST_POOL_OIDC_AUDIENCE: "playtest-ci",
    PLAYTEST_POOL_OIDC_TTL_S: "900",
  });
  assert.deepEqual(
    {
      repository: pinned.dispatch.pool.oidc.repository,
      workflowId: pinned.dispatch.pool.oidc.workflowId,
      ref: pinned.dispatch.pool.oidc.ref,
      oidcAudience: pinned.dispatch.pool.oidc.oidcAudience,
      ttlMs: pinned.dispatch.pool.oidc.ttlMs,
    },
    {
      repository: "acme/storefront",
      workflowId: "playtest.yml",
      ref: "main",
      oidcAudience: "playtest-ci",
      ttlMs: 900_000,
    },
  );
});

test("config: a workflow or ref pin without a repository pin is a boot error", () => {
  for (const half of [{ PLAYTEST_POOL_OIDC_WORKFLOW: "playtest.yml" }, { PLAYTEST_POOL_OIDC_REF: "main" }]) {
    assert.throws(
      () => loadConfig({ ...pool, ...half }),
      (e: HostedDynamic) =>
        e instanceof ServerConfigError &&
        /PLAYTEST_POOL_OIDC_REPOSITORY/.test(e.message) &&
        /any repository/.test(e.message),
      `${JSON.stringify(half)} must not boot`,
    );
  }
});

test("config: the ephemeral credential's lifetime is bounded by GitHub's own job ceiling", () => {
  assert.equal(loadConfig({ ...pool, PLAYTEST_POOL_OIDC_TTL_S: "21600" }).dispatch.pool.oidc.ttlMs, 21_600_000);
  for (const ttl of ["30", "21601", "nonsense"]) {
    assert.throws(
      () => loadConfig({ ...pool, PLAYTEST_POOL_OIDC_TTL_S: ttl }),
      (e: HostedDynamic) => e instanceof ServerConfigError && /PLAYTEST_POOL_OIDC_TTL_S/.test(e.message),
      `TTL ${ttl} must not boot`,
    );
  }
});

// ------------------------------------------------------------------ labels

test("labels validate the same way wherever they are accepted", () => {
  assert.deepEqual(normalizeLabels(["macos", " ios-sim ", "macos"]), ["macos", "ios-sim"]);
  assert.deepEqual(normalizeLabels(undefined), []);
  assert.deepEqual(normalizeLabels(null), []);
  for (const bad of [["", "macos"], [7], "macos", {}]) {
    assert.throws(() => normalizeLabels(bad, "runner_labels"), /"runner_labels" must be an array/);
  }
  assert.throws(() => normalizeLabels(Array.from({ length: 33 }, (_, i) => `l${i}`)), /at most 32 labels/);
  assert.throws(() => normalizeLabels(["x".repeat(65)]), /at most 64 characters/);
});

test("a label is spelled in the one alphabet every carrier survives", () => {
  // Everything the product actually generates or documents fits.
  assert.deepEqual(
    normalizeLabels(["macos", "ios-sim", "ci-run-1234567", "node_20", "macos.14", "SELF-HOSTED"]),
    ["macos", "ios-sim", "ci-run-1234567", "node_20", "macos.14", "SELF-HOSTED"],
  );
  // A comma would become two labels on the agent's `--labels`; a space, a quote
  // or a shell metacharacter would break the command the console hands over.
  for (const bad of ["build,test", "ios sim", "pool:checkout", "$(whoami)", "it's", "a/b", "läbel"]) {
    assert.throws(
      () => normalizeLabels([bad]),
      (e: HostedDynamic) =>
        /may use only letters, digits/.test(e.message) && e.message.includes(bad),
      `${bad} must be refused, by name`,
    );
  }
});

// -------------------------------------------------------------- expiry

test("an expired ephemeral registration is refused exactly like a revoked one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-ephemeral-"));
  roots.push(dir);
  const db: HostedDynamic = await connect({ databaseFile: path.join(dir, "playtest.sqlite") });
  await migrate(db);
  const projectId = ulid();
  await db.query(`INSERT INTO projects (id, key, name) VALUES ($1, 'ci', 'CI')`, [projectId]);

  const mint = async (expiresAt: Date | null) => {
    const { plaintext, hash } = newRunnerCredential();
    const id = ulid();
    await db.query(
      `INSERT INTO runners (id, project_id, name, labels, credential_hash, ephemeral, expires_at)
         VALUES ($1, $2, $3, $4, $5, 1, $6)`,
      [id, projectId, `ci-${id}`, ["ci-run-1"], hash, expiresAt],
    );
    return plaintext;
  };

  const live = await mint(new Date(Date.now() + 60_000));
  assert.equal((await runnerForCredential(db, live)).project_id, projectId);

  const dead = await mint(new Date(Date.now() - 1));
  await assert.rejects(
    () => runnerForCredential(db, dead),
    (e: HostedDynamic) => e.code === "forbidden" && /registration expired/.test(e.message),
  );

  // Standing runners have no clock on them: they stop when someone revokes them.
  assert.equal(isExpired({ expires_at: null }), false);
  assert.equal(isExpired({ expires_at: new Date(Date.now() + 1000) }), false);
  assert.equal(isExpired({ expires_at: new Date(Date.now() - 1000) }), true);
});

// ------------------------------- the authorization/mutation boundary

/**
 * A board with one dispatch, one runner, and a deliberate SEAM between the two
 * moments a claim is made of: the credential is authorized, and then — in its
 * own `BEGIN IMMEDIATE` transaction — the row moves.
 *
 * `between` runs inside that gap. It is an explicit ordering rather than a
 * sleep: the interleaving this proves is not "probably" produced, it is the
 * only one the fixture can produce, and it is identical on every run.
 */
async function claimBoardFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-claim-gap-"));
  roots.push(dir);
  const config: HostedDynamic = loadConfig({ ...base, PLAYTEST_DATA_DIR: dir });
  const db: HostedDynamic = await connect(config);
  await migrate(db);
  const projectId = ulid();
  await db.query(`INSERT INTO projects (id, key, name) VALUES ($1, 'gap', 'Gap')`, [projectId]);

  const register = async ({ expiresAt = null, ephemeral = 1 }: HostedDynamic = {}) => {
    const { plaintext, hash } = newRunnerCredential();
    const id = ulid();
    await db.query(
      `INSERT INTO runners (id, project_id, name, labels, credential_hash, ephemeral, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, projectId, `runner-${id}`, [], hash, ephemeral, expiresAt],
    );
    return { id, credential: plaintext };
  };
  const post = async () => {
    const id = ulid();
    await db.query(
      `INSERT INTO dispatches (id, project_id, kind, ref_id, attempt, status, labels)
         VALUES ($1, $2, 'group', $3, 1, 'requested', '[]')`,
      [id, projectId, ulid()],
    );
    return id;
  };
  /** `claimDispatch` with the gap between authorization and mutation held open. */
  const claim = async (credential: string, dispatchId: string, between: () => Promise<void>) => {
    const seam: HostedDynamic = {
      query: (text: string, params?: unknown[]) => db.query(text, params),
      afterCommit: (fn: () => void) => db.afterCommit(fn),
      withTx: async (fn: HostedDynamic) => {
        await between();
        return await db.withTx(fn);
      },
    };
    return await claimDispatch({
      db: seam,
      config,
      params: { dispatch: dispatchId },
      query: new URLSearchParams(),
      req: { headers: { authorization: `Bearer ${credential}` } },
    } as HostedDynamic);
  };
  const dispatch = async (id: string) => (await db.query(`SELECT * FROM dispatches WHERE id = $1`, [id])).rows[0];
  return { db, projectId, register, post, claim, dispatch };
}

test("a credential that expires between authorization and the claim update wins nothing", async () => {
  const { db, register, post, claim, dispatch } = await claimBoardFixture();
  const runner = await register({ expiresAt: new Date(Date.now() + 60_000) });
  const id = await post();

  // Authorization sees a live credential; the CI job it belongs to ends before
  // the row moves. A claim it can never exchange is worse than no claim: the
  // dispatch would sit `scheduled` under a runner that cannot come back for it.
  await assert.rejects(
    () =>
      claim(runner.credential, id, async () => {
        await db.query(`UPDATE runners SET expires_at = $2 WHERE id = $1`, [runner.id, new Date(Date.now() - 1)]);
      }),
    (e: HostedDynamic) => e.code === "conflict" && e.message.includes(id),
    "an expired credential must lose the claim, with the stable conflict the loser already receives",
  );

  const row = await dispatch(id);
  assert.equal(row.status, "requested", "the board entry is untouched, so a live runner still takes it");
  assert.equal(row.claimed_at, null);
  assert.equal(row.runner_id, null);
  await db.end();
});

test("a credential revoked in the same gap wins nothing either", async () => {
  const { db, register, post, claim, dispatch } = await claimBoardFixture();
  const runner = await register({ ephemeral: 0 });
  const id = await post();

  await assert.rejects(
    () =>
      claim(runner.credential, id, async () => {
        await db.query(`UPDATE runners SET revoked_at = now() WHERE id = $1`, [runner.id]);
      }),
    (e: HostedDynamic) => e.code === "conflict" && e.message.includes(id),
  );
  assert.equal((await dispatch(id)).status, "requested");
  await db.end();
});

test("a live credential still wins the same claim through the same seam", async () => {
  const { db, register, post, claim, dispatch } = await claimBoardFixture();
  const runner = await register({ expiresAt: new Date(Date.now() + 60_000) });
  const id = await post();

  const claimed = await claim(runner.credential, id, async () => {});
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.dispatch_id, id);
  const row = await dispatch(id);
  assert.equal(row.status, "scheduled", "the ordinary path is unchanged by the expiry condition");
  assert.equal(row.runner_id, runner.id);
  assert.ok(row.claimed_at);
  await db.end();
});

// ------------------------------------------------------------- placement

test("a pinned launch places every attempt, however the environment changes", () => {
  const env = { runner_labels: ["staging-box"] };
  assert.deepEqual(groupDispatchLabels({ runner_labels: null }, env), ["staging-box"]);
  assert.deepEqual(groupDispatchLabels({ runner_labels: ["ci-run-77"] }, env), ["ci-run-77"]);
  // An explicit empty pin is a decision, not an absent one: "any runner in the
  // project", even when the environment asks for a label.
  assert.deepEqual(groupDispatchLabels({ runner_labels: [] }, env), []);
  assert.deepEqual(groupDispatchLabels({ runner_labels: null }, {}), []);
});
