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
import { loadConfig } from "../../src/config.ts";
import { connectTestDb } from "./helpers.ts";
import { migrate } from "../../src/migrate.ts";
import { claimDispatch } from "../../src/api/pool.ts";
import {
  isExpired,
  newRunnerCredential,
  runnerForCredential,
} from "../../src/auth/runner-credentials.ts";
import { ulid } from "../../src/ulid.ts";

const base = { PLAYTEST_DATA_DIR: "/tmp/playtest-pool-oidc-config-test", PLAYTEST_AUTH: "dev" };
const roots: string[] = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ config

test("an expired ephemeral registration is refused exactly like a revoked one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-ephemeral-"));
  roots.push(dir);
  const db: HostedDynamic = await connectTestDb();
  await migrate(db);
  const projectId = ulid();
  await db.query(`INSERT INTO projects (id, key, name) VALUES ($1, 'ci', 'CI')`, [projectId]);

  const mint = async (expiresAt: Date | null) => {
    const { plaintext, hash } = newRunnerCredential();
    const id = ulid();
    await db.query(
      `INSERT INTO runners (id, project_id, name, labels, credential_hash, ephemeral, expires_at)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
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
  const config: HostedDynamic = loadConfig({ DATABASE_URL: "postgres://test:test@127.0.0.1/playtest_test", ...base, PLAYTEST_DATA_DIR: dir });
  const db: HostedDynamic = await connectTestDb();
  await migrate(db);
  const projectId = ulid();
  await db.query(`INSERT INTO projects (id, key, name) VALUES ($1, 'gap', 'Gap')`, [projectId]);

  const register = async ({ expiresAt = null, ephemeral = true }: HostedDynamic = {}) => {
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

