// Unit coverage for the claim board — the one placement model: its timeouts,
// the credential format, label subset semantics, and the loss shapes
// `dispatchStatus` reports to the reconciler. Hermetic: node:sqlite on a temp
// file, no network, no runner.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig, ServerConfigError } from "../../src/config.ts";
import { connect } from "../../src/db.ts";
import { migrate } from "../../src/migrate.ts";
import { ClaimBoard } from "../../src/dispatch/pool.ts";
import { newRunnerCredential, labelsMatch, RUNNER_CREDENTIAL_PREFIX } from "../../src/auth/runner-credentials.ts";
import { hashToken } from "../../src/auth/tokens.ts";
import { ulid } from "../../src/ulid.ts";

const base = { PLAYTEST_DATA_DIR: "/tmp/playtest-pool-config-test", PLAYTEST_AUTH: "dev" };
const roots: string[] = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ config

test("config: board timeouts are seconds with documented defaults", () => {
  const cfg: HostedDynamic = loadConfig({ ...base });
  assert.equal(cfg.dispatch.pool.claimTimeoutMs, 600_000);
  assert.equal(cfg.dispatch.pool.heartbeatTimeoutMs, 120_000);
  const tuned: HostedDynamic = loadConfig({
    ...base,
    PLAYTEST_POOL_CLAIM_TIMEOUT_S: "30",
    PLAYTEST_POOL_HEARTBEAT_TIMEOUT_S: "15",
  });
  assert.equal(tuned.dispatch.pool.claimTimeoutMs, 30_000);
  assert.equal(tuned.dispatch.pool.heartbeatTimeoutMs, 15_000);
  assert.throws(
    () => loadConfig({ ...base, PLAYTEST_POOL_CLAIM_TIMEOUT_S: "-5" }),
    (e: HostedDynamic) => e instanceof ServerConfigError && /PLAYTEST_POOL_CLAIM_TIMEOUT_S/.test(e.message),
  );
});

// ------------------------------------------------------------- credentials

test("runner credentials are shown once, stored as a SHA-256 hash, and prefixed apart", () => {
  const { plaintext, hash } = newRunnerCredential();
  assert.ok(plaintext.startsWith(RUNNER_CREDENTIAL_PREFIX));
  assert.equal(hash, hashToken(plaintext));
  assert.equal(hash.length, 64);
  assert.notEqual(newRunnerCredential().plaintext, plaintext);
  // Deliberately neither an API token (`pt_`) nor a scoped runner bearer
  // (`pr_`): a credential presented to the wrong surface is refused outright.
  assert.equal(plaintext.startsWith("pt_"), false);
  assert.equal(plaintext.startsWith("pr_"), false);
});

test("label matching is subset semantics, and no labels matches anything", () => {
  assert.equal(labelsMatch([], ["macos"]), true);
  assert.equal(labelsMatch([], []), true);
  assert.equal(labelsMatch(null, null), true);
  assert.equal(labelsMatch(["macos"], ["macos", "ios-sim"]), true);
  assert.equal(labelsMatch(["macos", "ios-sim"], ["macos"]), false);
  assert.equal(labelsMatch(["macos"], []), false);
});

// ------------------------------------------------------- the status source

async function poolFixture(env: HostedDynamic = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-pool-"));
  roots.push(dir);
  const config = loadConfig({ ...base, PLAYTEST_DATA_DIR: dir, ...env });
  const db: HostedDynamic = await connect(config);
  await migrate(db);
  const projectId = ulid();
  await db.query(`INSERT INTO projects (id, key, name) VALUES ($1, 'pool', 'Pool')`, [projectId]);
  const pool = new ClaimBoard(config, { db });
  const board = async ({ labels = [], requestedAt = new Date() }: HostedDynamic = {}) => {
    const id = ulid();
    await db.query(
      `INSERT INTO dispatches (id, project_id, kind, ref_id, attempt, status, labels, requested_at)
         VALUES ($1, $2, 'group', $3, 1, 'requested', $4, $5)`,
      [id, projectId, ulid(), labels, requestedAt],
    );
    await pool.postDispatch({ dispatchId: id, kind: "group", refId: "g", labels });
    return id;
  };
  const runner = async ({ name = "laptop", labels = [], expiresAt = null, ephemeral = 0 }: HostedDynamic = {}) => {
    const id = ulid();
    await db.query(
      `INSERT INTO runners (id, project_id, name, labels, credential_hash, ephemeral, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, projectId, name, labels, hashToken(`${name}-credential`), ephemeral, expiresAt],
    );
    return id;
  };
  return { db, pool, projectId, board, runner };
}

test("postDispatch makes no network call and leaves the row on the board", async () => {
  const { db, pool, board } = await poolFixture();
  const id = await board({ labels: ["macos"] });
  const { rows } = await db.query(`SELECT * FROM dispatches WHERE id = $1`, [id]);
  assert.equal(rows[0].status, "requested", "the requested row IS the board entry");
  assert.equal(rows[0].claimed_at, null);
  assert.deepEqual(rows[0].labels, ["macos"]);
  // Nothing is started and nothing is stamped: the winning claim is what moves
  // the row on.
  await pool.postDispatch({ dispatchId: id, kind: "group", refId: "g", labels: [] });
  const after = await db.query(`SELECT status FROM dispatches WHERE id = $1`, [id]);
  assert.equal(after.rows[0].status, "requested");
  assert.equal(await pool.dispatchStatus("no-such-dispatch"), null);
  await db.end();
});

test("dispatchStatus: unclaimed inside the window is queued, past it names the labels", async () => {
  const { db, pool, board, runner } = await poolFixture({ PLAYTEST_POOL_CLAIM_TIMEOUT_S: "600" });
  await runner({ name: "linux-box", labels: ["linux"] });
  const fresh = await board({ labels: ["macos"] });
  assert.equal((await pool.dispatchStatus(fresh))?.status, "queued");

  const stale = await board({ labels: ["macos"], requestedAt: new Date(Date.now() - 20 * 60_000) });
  const lost: HostedDynamic = await pool.dispatchStatus(stale);
  assert.equal(lost.status, "completed");
  assert.equal(lost.conclusion, "unclaimed");
  // Actionable, and never re-placed: the same empty board would fail again.
  assert.equal(lost.redispatch, false);
  assert.match(lost.reason, /"macos"/);
  assert.match(lost.reason, /has checked in/);
  assert.match(lost.reason, /linux-box/);
  await db.end();
});

test("dispatchStatus: a project with no runners at all says so, with the remedy", async () => {
  const { db, pool, board } = await poolFixture();
  const stale = await board({ labels: [], requestedAt: new Date(Date.now() - 20 * 60_000) });
  const lost: HostedDynamic = await pool.dispatchStatus(stale);
  assert.equal(lost.conclusion, "unclaimed");
  assert.match(lost.reason, /no runner has checked in/);
  assert.match(lost.reason, /Settings → Runners/);
  await db.end();
});

test("dispatchStatus: an expired ephemeral registration is not offered as the remedy", async () => {
  const { db, pool, board, runner } = await poolFixture();
  // The CI job that registered this one is long over: it is invisible in
  // Settings and cannot be restarted, so naming it would send a reader after a
  // machine that no longer exists.
  await runner({ name: "ci-900100.1-ab12", labels: ["macos"], ephemeral: 1, expiresAt: new Date(Date.now() - 60_000) });
  const stale = await board({ labels: ["macos"], requestedAt: new Date(Date.now() - 20 * 60_000) });
  const lost: HostedDynamic = await pool.dispatchStatus(stale);
  assert.equal(lost.conclusion, "unclaimed");
  assert.match(lost.reason, /no runner has checked in/, "an expired registration is not a registered runner");
  assert.equal(/ci-900100/.test(lost.reason), false, lost.reason);

  // A live ephemeral registration IS actionable and still reads.
  await runner({ name: "ci-900200.1-cd34", labels: ["linux"], ephemeral: 1, expiresAt: new Date(Date.now() + 600_000) });
  const second = await board({ labels: ["macos"], requestedAt: new Date(Date.now() - 20 * 60_000) });
  assert.match((await pool.dispatchStatus(second))!.reason!, /ci-900200/);
  await db.end();
});

test("dispatchStatus: a fresh heartbeat is in_progress, a stale one is a dead executor", async () => {
  const { db, pool, board, runner } = await poolFixture({ PLAYTEST_POOL_HEARTBEAT_TIMEOUT_S: "120" });
  const runnerId = await runner({ name: "adas-laptop", labels: ["macos"] });
  const id = await board({ labels: ["macos"] });
  await db.query(
    `UPDATE dispatches SET status = 'scheduled', runner_id = $2, claimed_at = $3, heartbeat_at = $3 WHERE id = $1`,
    [id, runnerId, new Date()],
  );
  assert.equal((await pool.dispatchStatus(id))?.status, "in_progress");

  await db.query(`UPDATE dispatches SET heartbeat_at = $2 WHERE id = $1`, [id, new Date(Date.now() - 10 * 60_000)]);
  const dead: HostedDynamic = await pool.dispatchStatus(id);
  assert.equal(dead.status, "completed");
  assert.equal(dead.conclusion, "runner_lost");
  // The existing dead-executor path applies unchanged, re-dispatch included.
  assert.equal(dead.redispatch, true);
  assert.match(dead.reason, /adas-laptop/);
  await db.end();
});

test("cancelDispatch marks the claim canceled, and the runner learns at its heartbeat", async () => {
  const { db, pool, board } = await poolFixture();
  const id = await board();
  assert.equal(await pool.cancelDispatch(""), null);
  assert.deepEqual(await pool.cancelDispatch(id), { ok: true });
  const { rows } = await db.query(`SELECT canceled_at FROM dispatches WHERE id = $1`, [id]);
  assert.ok(rows[0].canceled_at instanceof Date);
  const canceled: HostedDynamic = await pool.dispatchStatus(id);
  assert.equal(canceled.conclusion, "canceled");
  assert.equal(canceled.redispatch, false);
  await db.end();
});
