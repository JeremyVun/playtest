// Phase 7: standalone `script`-provider mint dispatch (§3a forced refresh).
// POST /auth-providers/:a/mint on a script provider dispatches a `mint`
// workflow; a REAL runner-agent child process exchanges, fetches the grant
// (root secrets resolved server-side), runs the mint script clean-room, and
// fulfills the claim. Also pins: mash-safe pending reuse, reconciler takeover
// of a dead mint workflow, and the failing-script path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./helpers.ts";
import { SpawningGitHub, sleep } from "./exec-helpers.ts";
import { reconcileDispatches } from "../../src/dispatch/reconciler.ts";
import { decryptSecret } from "../../src/crypto/secrets.ts";

const MINT_SCRIPT = `
const state = {
  cookies: [{
    name: "sid",
    value: process.env.PLAYTEST_IDENTITY + ":" + process.env.ROOT_PW,
    domain: "localhost",
    path: "/",
  }],
  origins: [],
};
console.log(JSON.stringify(state));
`;

const FAILING_SCRIPT = `
console.error("login portal returned 503");
process.exit(1);
`;

async function setup(api: HostedDynamic, { key, code, name = "portal" }: HostedDynamic) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const secret = await api.post(`/projects/${project.key}/secrets`, { name: "root-pw", value: "hunter2" });
  assert.ok(secret.status < 300, JSON.stringify(secret.body));
  const provider = (
    await api.post(`/projects/${project.key}/auth-providers`, {
      name,
      kind: "script",
      code,
      config: { secret_env: { ROOT_PW: "root-pw" } },
      identities: { admin: { username: "root" } },
      ttl_minutes: 45,
    })
  ).body;
  return { project, provider };
}

test("forced mint on a script provider dispatches a runner that fulfills the session", async () => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pt-mint-"));
  const github = new SpawningGitHub({ llmUrl: "http://127.0.0.1:1", workRoot });
  try {
    await withApp(
      async ({ base, app, api }: HostedDynamic) => {
        github.serverBase = base;
        const { project, provider } = await setup(api, { key: "mint7", code: MINT_SCRIPT });

        const res = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
        assert.equal(res.status, 202, JSON.stringify(res.body));
        assert.equal(res.body.mint.pending, true);
        assert.ok(res.body.mint.claim_id);
        assert.ok(res.body.mint.dispatch_id);
        assert.equal(github.dispatches.at(-1).kind, "mint");

        const exec = await github.execs.at(-1).promise;
        assert.equal(exec.code, 0, `mint executor failed:\n${exec.stdout}\n${exec.stderr}`);

        // The session artifact exists, carries the identity, and its decrypted
        // storage state proves config.secret_env was resolved into the script.
        const sessions = await api.get(`/auth-providers/${provider.id}/sessions`);
        assert.equal(sessions.body.items.length, 1);
        assert.equal(sessions.body.items[0].identity, "admin");
        const { rows } = await app.db.query(`SELECT * FROM session_artifacts WHERE provider_id = $1`, [provider.id]);
        const state = JSON.parse(decryptSecret(app.ctx.config.kmsKey, rows[0].ciphertext));
        assert.equal(state.cookies[0].value, "admin:hunter2");

        // Ledger: the mint dispatch concluded, its executor is kind 'mint'.
        const dispatches = await api.get(`/projects/${project.key}/dispatches`);
        const mintRow = dispatches.body.items.find((d: HostedDynamic) => d.kind === "mint");
        assert.equal(mintRow.status, "concluded", JSON.stringify(mintRow));
        assert.equal(mintRow.error, null);
        const execs = await app.db.query(`SELECT * FROM executors WHERE id = $1`, [mintRow.executor_id]);
        assert.equal(execs.rows[0].kind, "mint");
        assert.ok(execs.rows[0].concluded_at);

        // The audit trail names the dispatch and the fulfillment.
        const audit = await api.get(`/projects/${project.key}/audit?limit=50`);
        const actions = audit.body.items.map((a: HostedDynamic) => a.action);
        assert.ok(actions.includes("session.mint_dispatched"), actions.join(","));
        assert.ok(actions.includes("session.minted"), actions.join(","));
      },
      {},
      { github },
    );
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
});

test("a pending mint is reused, a dead mint workflow is reconciled into takeover", async () => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pt-mint-"));
  const github = new SpawningGitHub({ llmUrl: "http://127.0.0.1:1", workRoot });
  github.spawnNext = false; // dispatch rows only; no executor ever arrives
  try {
    await withApp(
      async ({ base, app, api }: HostedDynamic) => {
        github.serverBase = base;
        const { project, provider } = await setup(api, { key: "mint7b", code: MINT_SCRIPT });

        const first: HostedDynamic = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
        assert.equal(first.status, 202);
        // Mashing the button reuses the in-flight claim — no second dispatch.
        const second = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
        assert.equal(second.status, 202);
        assert.equal(second.body.mint.claim_id, first.body.mint.claim_id);
        assert.equal(second.body.mint.dispatch_id, first.body.mint.dispatch_id);
        assert.equal(github.dispatches.filter((d) => d.kind === "mint").length, 1);

        // The stub reports the workflow completed without fulfilling: the
        // reconciler abandons the claim and marks the dispatch dead.
        const results = await reconcileDispatches(app.ctx);
        const mintResult = results.find((r) => r.dispatch_id === first.body.mint.dispatch_id);
        assert.equal(mintResult.action, "dead");
        const claims = await app.db.query(`SELECT * FROM session_claims WHERE id = $1`, [first.body.mint.claim_id]);
        assert.equal(claims.rows.length, 0, "abandoned claim is deleted (takeover)");
        const dispatches = await api.get(`/projects/${project.key}/dispatches`);
        assert.equal(dispatches.body.items.find((d: HostedDynamic) => d.id === first.body.mint.dispatch_id).status, "reconciled_dead");

        // A new forced refresh starts clean.
        const third = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
        assert.equal(third.status, 202);
        assert.notEqual(third.body.mint.claim_id, first.body.mint.claim_id);
      },
      {},
      { github },
    );
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
});

test("a failing mint script abandons the claim and concludes the dispatch with the error", async () => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pt-mint-"));
  const github = new SpawningGitHub({ llmUrl: "http://127.0.0.1:1", workRoot });
  try {
    await withApp(
      async ({ base, app, api }: HostedDynamic) => {
        github.serverBase = base;
        const { project, provider } = await setup(api, { key: "mint7c", code: FAILING_SCRIPT, name: "flaky" });

        const res = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
        assert.equal(res.status, 202);
        const exec = await github.execs.at(-1).promise;
        assert.equal(exec.code, 1, `expected mint failure:\n${exec.stdout}\n${exec.stderr}`);

        // Give the executor's final complete call a beat to land.
        for (let i = 0; i < 20; i++) {
          const d = await api.get(`/projects/${project.key}/dispatches`);
          if (d.body.items.find((x: HostedDynamic) => x.kind === "mint")?.status === "concluded") break;
          await sleep(250);
        }
        const dispatches = await api.get(`/projects/${project.key}/dispatches`);
        const mintRow = dispatches.body.items.find((d: HostedDynamic) => d.kind === "mint");
        assert.equal(mintRow.status, "concluded");
        assert.match(mintRow.error, /503|exited/);

        const claims = await app.db.query(`SELECT * FROM session_claims WHERE id = $1`, [res.body.mint.claim_id]);
        assert.equal(claims.rows.length, 0, "failed claim deleted so the next mint takes over");
        const sessions = await api.get(`/auth-providers/${provider.id}/sessions`);
        assert.equal(sessions.body.items.length, 0);

        const audit = await api.get(`/projects/${project.key}/audit?limit=50`);
        assert.ok(audit.body.items.some((a: HostedDynamic) => a.action === "session.mint_failed"));
      },
      {},
      { github },
    );
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
});
