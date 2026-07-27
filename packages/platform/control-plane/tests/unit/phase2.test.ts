import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { issueRunnerToken, verifyRunnerToken } from "../../src/auth/runner-tokens.ts";
import { appJwt, GitHubDispatchClient } from "../../src/dispatch/github.ts";

test("runner tokens are signed and scoped", () => {
  const key = Buffer.alloc(32, 7);
  const token = issueRunnerToken(key, { executorId: "exe_1", runGroupId: "grp_1", ttlSeconds: 60 });
  assert.match(token, /^pr_/);
  assert.deepEqual(verifyRunnerToken(key, token), {
    executor_id: "exe_1",
    run_group_id: "grp_1",
    exp: verifyRunnerToken(key, token).exp,
  });
  assert.throws(() => verifyRunnerToken(Buffer.alloc(32, 8), token), /invalid/);
});

test("GitHub App JWT is RS256 signed", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = appJwt("12345", privateKey.export({ type: "pkcs1", format: "pem" }), 1_700_000_000);
  const [h, p, s]: HostedDynamic = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(h, "base64url").toString("utf8")).alg, "RS256");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  assert.equal(payload.iss, "12345");
  const ok = crypto
    .createVerify("RSA-SHA256")
    .update(`${h}.${p}`)
    .verify(publicKey.export({ type: "pkcs1", format: "pem" }), Buffer.from(s, "base64url"));
  assert.equal(ok, true);
});

test("findDispatchRun correlates a 204 dispatch by run-name scan", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config: HostedDynamic = {
    dispatch: {
      github: {
        enabled: true,
        apiUrl: "https://gh.invalid",
        appId: "1",
        privateKey: privateKey.export({ type: "pkcs1", format: "pem" }),
        installationId: "77",
        repository: "acme/rig",
        workflowId: "playtest-runner.yml",
        ref: "main",
      },
    },
  };
  const calls: HostedDynamic[] = [];
  const fetchImpl: HostedDynamic = async (url: HostedDynamic) => {
    calls.push(String(url));
    if (String(url).includes("/access_tokens")) {
      return { status: 201, json: async () => ({ token: "ghs_test" }) };
    }
    return {
      status: 200,
      json: async () => ({
        workflow_runs: [
          { id: 42, name: "playtest group g_other · dispatch d_other", status: "completed", html_url: "https://gh/42" },
          { id: 43, name: "playtest group g_1 · dispatch d_123", status: "in_progress", html_url: "https://gh/43" },
        ],
      }),
    };
  };
  const client = new GitHubDispatchClient(config, { fetchImpl });
  const hit = await client.findDispatchRun("d_123", { since: "2026-07-05T00:00:00Z" });
  assert.deepEqual(hit, { id: "43", status: "in_progress", conclusion: null, url: "https://gh/43" });
  const runsUrl = calls.find((u) => u.includes("/runs?"));
  assert.match(runsUrl, /event=workflow_dispatch/);
  assert.match(runsUrl, /created=%3E%3D2026-07-05/);
  assert.equal(await client.findDispatchRun("d_none", {}), null);
});
