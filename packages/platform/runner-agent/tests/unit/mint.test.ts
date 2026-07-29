// Two subjects, one boundary (B4):
//
//   * `runMintScript` — clean-room execution of a `script` auth provider's mint
//     grant with isolation "process". Only the grant's resolved env reaches the
//     script, stdout must parse as a storage-state JSON object (tolerating noisy
//     stdout via last-line fallback), nonzero exit surfaces stderr's first line,
//     a runaway script is killed at timeout_s, and the per-claim temp dir is
//     always cleaned up.
//   * `executeMint` — the caller that decides what a failure MEANS. "The mint
//     script failed" and "the completion request failed" used to share one
//     catch, so a transport failure after a successful mint was posted on the
//     claim as if the customer's login code were broken. They are now separate:
//     the script runs exactly once and only its delivery is retried.
//
// The control-plane half of the same contract — a crash between exchange and
// completion resumed by the same runner, the pre-crash bearer fenced, and a
// completion that is idempotent for the current executor — is proven through the
// real routes in `tests/integration/pool-claim-board.test.ts`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMintScript } from "../../src/mint.ts";
import { executeMint } from "../../src/exec-mint.ts";
import { RunnerApiError } from "../../src/api-client.ts";

function freshWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pt-mint-test-"));
}

function mintDir(workDir: string, claimId: string) {
  return path.join(workDir, "mints", claimId);
}

test("runMintScript resolves the storage state a script prints, with grant env and identity config reaching it", async () => {
  const workDir = freshWorkDir();
  try {
    const grant = {
      claim_id: "claim-success",
      provider: "sso",
      identity: "member",
      code: `
        const identity = process.env.PLAYTEST_IDENTITY;
        const secret = process.env.MY_SECRET;
        const cfg = JSON.parse(process.env.PLAYTEST_IDENTITY_CONFIG);
        process.stdout.write(JSON.stringify({
          cookies: [{ name: "u", value: identity }, { name: "secret", value: secret }, { name: "cfg", value: cfg.username }],
          origins: [],
        }));
      `,
      identity_config: { username: "qa-member" },
      env: { MY_SECRET: "hunter2-super-secret" },
      timeout_s: 10,
    };
    const result = await runMintScript(grant, { isolation: "process", workDir });
    assert.equal(result.cookies[0].value, "member");
    assert.equal(result.cookies[1].value, "hunter2-super-secret");
    assert.equal(result.cookies[2].value, "qa-member");
    assert.equal(fs.existsSync(mintDir(workDir, grant.claim_id)), false, "temp dir is cleaned up after success");
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});

test("runMintScript tolerates stdout noise, taking the last line as the storage state", async () => {
  const workDir = freshWorkDir();
  try {
    const grant = {
      claim_id: "claim-noisy",
      provider: "sso",
      identity: "member",
      code: `
        console.log("starting…");
        console.log("doing stuff");
        console.log(JSON.stringify({ cookies: [{ name: "sid", value: "noisy-ok" }], origins: [] }));
      `,
      identity_config: {},
      env: {},
      timeout_s: 10,
    };
    const result = await runMintScript(grant, { isolation: "process", workDir });
    assert.equal(result.cookies[0].value, "noisy-ok");
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});

test("runMintScript rejects with stderr's first line on nonzero exit, and cleans up", async () => {
  const workDir = freshWorkDir();
  try {
    const grant = {
      claim_id: "claim-failure",
      provider: "sso",
      identity: "member",
      code: `console.error("boom: bad creds"); process.exit(3);`,
      identity_config: {},
      env: {},
      timeout_s: 10,
    };
    await assert.rejects(runMintScript(grant, { isolation: "process", workDir }), /boom: bad creds/);
    assert.equal(fs.existsSync(mintDir(workDir, grant.claim_id)), false, "temp dir is cleaned up after failure");
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});

test("runMintScript rejects garbage stdout naming the provider, identity, and storage-state", async () => {
  const workDir = freshWorkDir();
  try {
    const grant = {
      claim_id: "claim-garbage",
      provider: "sso",
      identity: "member",
      code: `console.log("not json");`,
      identity_config: {},
      env: {},
      timeout_s: 10,
    };
    await assert.rejects(
      runMintScript(grant, { isolation: "process", workDir }),
      /sso\/member.*storage-state|storage-state.*sso\/member/s,
    );
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});

test("runMintScript always removes the per-claim mints/<claim_id> temp dir", async () => {
  const workDir = freshWorkDir();
  try {
    const okGrant = {
      claim_id: "claim-cleanup-ok",
      provider: "sso",
      identity: "member",
      code: `process.stdout.write(JSON.stringify({ cookies: [], origins: [] }))`,
      identity_config: {},
      env: {},
      timeout_s: 10,
    };
    await runMintScript(okGrant, { isolation: "process", workDir });
    assert.equal(fs.existsSync(mintDir(workDir, okGrant.claim_id)), false, "success path cleans up");

    const badGrant = {
      claim_id: "claim-cleanup-fail",
      provider: "sso",
      identity: "member",
      code: `process.exit(1);`,
      identity_config: {},
      env: {},
      timeout_s: 10,
    };
    await assert.rejects(runMintScript(badGrant, { isolation: "process", workDir }));
    assert.equal(fs.existsSync(mintDir(workDir, badGrant.claim_id)), false, "failure path cleans up");
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});

test("runMintScript does not leak the executor's environment into the script", async () => {
  const workDir = freshWorkDir();
  process.env.PLAYTEST_EXECUTOR_LEAK_CANARY = "leaked-group-secret";
  try {
    const grant = {
      claim_id: "claim-clean-env",
      provider: "sso",
      identity: "member",
      // The clean-room contract: the script sees the grant's env, not the
      // executor's (which holds the whole group's secret_env).
      code: `process.stdout.write(JSON.stringify({
        cookies: [{ name: "canary", value: String(process.env.PLAYTEST_EXECUTOR_LEAK_CANARY) }],
        origins: [],
      }));`,
      identity_config: {},
      env: {},
      timeout_s: 10,
    };
    const result = await runMintScript(grant, { isolation: "process", workDir });
    assert.equal(result.cookies[0].value, "undefined");
  } finally {
    delete process.env.PLAYTEST_EXECUTOR_LEAK_CANARY;
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});

test("runMintScript kills a runaway script at timeout_s", async () => {
  const workDir = freshWorkDir();
  try {
    const grant = {
      claim_id: "claim-timeout",
      provider: "sso",
      identity: "member",
      code: `setInterval(() => {}, 1000);`,
      identity_config: {},
      env: {},
      timeout_s: 1,
    };
    const started = Date.now();
    await assert.rejects(runMintScript(grant, { isolation: "process", workDir }), /timed out/);
    assert.ok(Date.now() - started < 5000, "timeout fires promptly");
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});

// ------------------------------------------- script failure vs transport failure

/** A grant whose script records every invocation and prints a session. */
function countingGrant(workDir: string, claimId: string) {
  const counter = path.join(workDir, `${claimId}.invocations`);
  return {
    counter,
    grant: {
      claim_id: claimId,
      provider: "sso",
      identity: "member",
      code: `
        import { appendFileSync } from "node:fs";
        appendFileSync(process.env.COUNTER_FILE, "x");
        process.stdout.write(JSON.stringify({ cookies: [{ name: "sid", value: "minted-once" }], origins: [] }));
      `,
      identity_config: {},
      env: { COUNTER_FILE: counter },
      timeout_s: 10,
    },
  };
}

function invocations(counter: string): number {
  return fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").length : 0;
}

const transient = () =>
  new RunnerApiError(503, { error: { code: "storage_error", message: "the control plane is restarting" } });

test("a mint completion that fails transiently is retried, and the script runs exactly once", async () => {
  const workDir = freshWorkDir();
  try {
    const { grant, counter } = countingGrant(workDir, "claim-retry");
    const posts: LegacyTestValue[] = [];
    let failures = 2;
    const api = {
      json: async (method: string, route: string, body: LegacyTestValue) => {
        posts.push({ method, route, body });
        if (failures-- > 0) throw transient();
        return { session: { id: "sess-1" } };
      },
    };

    const out = await executeMint(api, { grant, claim: grant.claim_id, isolation: "process", workDir, sleep: async () => {} });

    assert.equal(out.exitCode, 0);
    assert.equal(out.minted, true);
    // The invocation counter, not a timing: the customer's login script ran
    // once, however many times its RESULT had to be delivered.
    assert.equal(invocations(counter), 1, "the mint script ran exactly once");
    assert.equal(posts.length, 3, "only the completion request was retried");
    for (const p of posts) {
      assert.equal(p.route, `/runner/mints/${grant.claim_id}/complete`);
      assert.equal(p.body.storage_state.cookies[0].value, "minted-once");
      assert.equal(p.body.error, undefined, "the claim never carries a script error the script did not produce");
    }
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});

test("a completion that keeps failing never reports the customer's script as broken", async () => {
  const workDir = freshWorkDir();
  try {
    const { grant, counter } = countingGrant(workDir, "claim-undeliverable");
    const posts: LegacyTestValue[] = [];
    const api = {
      json: async (method: string, route: string, body: LegacyTestValue) => {
        posts.push({ route, body });
        throw transient();
      },
    };

    const out = await executeMint(api, {
      grant,
      claim: grant.claim_id,
      isolation: "process",
      workDir,
      sleep: async () => {},
    });

    assert.equal(out.exitCode, 1);
    assert.equal(out.minted, true, "the mint itself succeeded and says so");
    assert.match(out.error, /could not be delivered/);
    assert.equal(invocations(counter), 1, "an undeliverable result never reruns the script");
    // Nothing was posted as a failure: the grant simply expires and the next
    // claimer takes it over, rather than being abandoned with a lie on it.
    assert.equal(posts.every((p) => p.body.error === undefined), true, "no script error was posted");
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});

test("a mint script that really fails is posted on the claim, scrubbed of the grant's secrets", async () => {
  const workDir = freshWorkDir();
  try {
    const grant = {
      claim_id: "claim-script-failed",
      provider: "sso",
      identity: "member",
      // The customer's script printing what it was handed: the exact shape the
      // redaction exists for.
      code: `console.error("login failed with ROOT_PW=" + process.env.ROOT_PW); process.exit(1);`,
      identity_config: {},
      env: { ROOT_PW: "hunter2-super-secret" },
      timeout_s: 10,
    };
    const posts: LegacyTestValue[] = [];
    const api = {
      json: async (method: string, route: string, body: LegacyTestValue) => {
        posts.push({ route, body });
        return {};
      },
    };

    const out = await executeMint(api, { grant, claim: grant.claim_id, isolation: "process", workDir, sleep: async () => {} });

    assert.equal(out.exitCode, 1);
    assert.equal(out.minted, undefined, "nothing was minted");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].route, `/runner/mints/${grant.claim_id}/complete`);
    assert.match(posts[0].body.error, /login failed/);
    assert.equal(posts[0].body.error.includes("hunter2-super-secret"), false, "the grant's secret is scrubbed");
    assert.equal(posts[0].body.storage_state, undefined);
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});

test("a refusal is final: a mint completion the platform refuses is never retried", async () => {
  const workDir = freshWorkDir();
  try {
    const { grant, counter } = countingGrant(workDir, "claim-fenced");
    let calls = 0;
    const api = {
      json: async () => {
        calls += 1;
        throw new RunnerApiError(409, {
          error: { code: "executor_conflict", message: "a newer executor owns this work", details: { reason: "executor_replaced" } },
        });
      },
    };
    await assert.rejects(
      executeMint(api, { grant, claim: grant.claim_id, isolation: "process", workDir, sleep: async () => {} }),
      /newer executor/,
    );
    assert.equal(calls, 1, "a 4xx is the same answer every time; it is not retried");
    assert.equal(invocations(counter), 1);
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});
