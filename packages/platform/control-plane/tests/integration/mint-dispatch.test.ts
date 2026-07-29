// Standalone `script`-provider minting, end to end through the claim board
// `POST /auth-providers/:a/mint` posts a `mint` entry to the
// board; the REAL `runner-agent pool` process — the same one a person starts on
// their own machine — polls, claims it, exchanges its registration credential,
// fetches the grant (root secrets resolved server-side), runs the mint script
// clean-room, and fulfills the claim. Also pins: mash-safe pending reuse,
// reconciler takeover of a mint nothing ever claimed, and the failing-script
// path.
import test from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./helpers.ts";
import { registerRunner, startPoolAgent, untilAgent } from "./exec-helpers.ts";
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

test("a forced mint rides the board: the real agent claims it and fulfills the session", async () => {
  let agent: HostedDynamic = null;
  try {
    await withApp(
      async ({ base, app, api }: HostedDynamic) => {
        const { project, provider } = await setup(api, { key: "mint7", code: MINT_SCRIPT });
        // The one arrival there is: a registered runner polling the board.
        const registered = await registerRunner(api, project, { name: "adas-laptop" });
        agent = startPoolAgent(base, registered.credential);

        const res = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
        assert.equal(res.status, 202, JSON.stringify(res.body));
        assert.equal(res.body.mint.pending, true);
        assert.ok(res.body.mint.claim_id);
        assert.ok(res.body.mint.dispatch_id);

        await untilAgent(
          async () =>
            (await app.db.query(`SELECT status FROM dispatches WHERE id = $1`, [res.body.mint.dispatch_id])).rows[0]
              ?.status === "concluded",
          "the agent to claim and fulfill the mint",
          agent,
        );

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
        assert.ok(actions.includes("runner.claimed"), actions.join(","));
        assert.match(agent.out.stdout, /claimed session mint/);

        // Stop the agent before the control plane: its long-poll is a live
        // request, and closing the server under it would just wait out the hold.
        await agent.stop();
      },
    );
  } finally {
    if (agent) await agent.stop();
  }
});

test("a pending mint is reused, and one nothing ever claims is reconciled into takeover", async () => {
  // No agent is started here: the board entry sits unclaimed, which is the
  // shape the reconciler has to resolve.
  await withApp(
      async ({ app, api }: HostedDynamic) => {
        const { project, provider } = await setup(api, { key: "mint7b", code: MINT_SCRIPT });

        const first: HostedDynamic = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
        assert.equal(first.status, 202);
        // Mashing the button reuses the in-flight claim — no second dispatch.
        const second = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
        assert.equal(second.status, 202);
        assert.equal(second.body.mint.claim_id, first.body.mint.claim_id);
        assert.equal(second.body.mint.dispatch_id, first.body.mint.dispatch_id);
        const posted = await app.db.query(`SELECT COUNT(*) AS n FROM dispatches WHERE kind = 'mint'`);
        assert.equal(posted.rows[0].n, 1, "mashing the button posts one board entry, not two");

        // Nothing claimed it inside the claim window: the reconciler abandons
        // the claim and marks the dispatch dead.
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
      { PLAYTEST_POOL_CLAIM_TIMEOUT_S: "0" },
  );
});

test("a failing mint script abandons the claim and concludes the dispatch with the error", async () => {
  let agent: HostedDynamic = null;
  try {
    await withApp(
      async ({ base, app, api }: HostedDynamic) => {
        const { project, provider } = await setup(api, { key: "mint7c", code: FAILING_SCRIPT, name: "flaky" });
        const registered = await registerRunner(api, project, { name: "adas-laptop" });
        agent = startPoolAgent(base, registered.credential);

        const res = await api.post(`/auth-providers/${provider.id}/mint`, { identity: "admin" });
        assert.equal(res.status, 202);

        await untilAgent(
          async () => {
            const d = await api.get(`/projects/${project.key}/dispatches`);
            return d.body.items.find((x: HostedDynamic) => x.kind === "mint")?.status === "concluded";
          },
          "the agent to report the failed mint",
          agent,
        );
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
        await agent.stop();
      },
    );
  } finally {
    if (agent) await agent.stop();
  }
});
