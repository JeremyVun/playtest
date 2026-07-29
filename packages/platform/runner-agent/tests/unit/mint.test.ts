// OWED BY B4 (standalone mint resume and idempotency), and deliberately not
// written yet:
//
// "Simulate a successful mint script followed by a transient completion request
// failure. Prove the script is not rerun and the result is retried
// idempotently."
//
// `runMintScript` — this file's subject — already separates cleanly: it either
// returns a storage state or throws. What conflates the two is its CALLERS, and
// both of them: `exec-mint.ts` and the in-group path in `exec-group.ts`
// (`claimGroupSessions`) each wrap the script AND the completion POST in one
// catch, so a transport failure after a successful mint is reported on the
// claim as if the customer's script had failed. There is no seam to test today
// because there is no boundary between the two outcomes.
//
// B4 must split them and then satisfy:
//
//   1. a completion request that fails transiently is RETRIED, and the mint
//      script runs exactly once (assert an invocation counter, not a timing);
//   2. the claim never carries a script error that the script did not produce;
//   3. mint completion is idempotent for the CURRENT executor, with enough
//      result state stored to redeliver without re-minting;
//   4. a runner that crashes between mint exchange and completion can resume:
//      the same authorized runner re-exchanges, a new current executor is
//      installed and the pending claim rebound, and the pre-crash bearer then
//      fails the identity check with `executor_conflict` — the fence B2 already
//      built, which is why B4 needs no revocation list. Today the opposite is
//      true and is pinned as the current behavior in the control plane's
//      pool-claim-board suite ("a mint exchange that can never be won concludes
//      the dispatch instead of being re-offered"); that test encodes what B4
//      replaces and should be rewritten with the change.
//
// Pins runMintScript: clean-room execution of a
// `script` auth provider's mint grant with isolation "process" — only the
// grant's resolved env reaches the script, stdout must parse as a
// storage-state JSON object (tolerating noisy stdout via last-line fallback),
// nonzero exit surfaces stderr's first line, a runaway script is killed at
// timeout_s, and the per-claim temp dir is always cleaned up.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMintScript } from "../../src/mint.ts";

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
