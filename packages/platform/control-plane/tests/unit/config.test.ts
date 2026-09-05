import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ServerConfigError } from "../../src/config.ts";

const base = { DATABASE_URL: "postgres://test:test@127.0.0.1/playtest_test", PLAYTEST_DATA_DIR: "/tmp/playtest-config-test" };

test("config: proxy auth requires an ingress key and explicit HTTPS URLs, without OIDC", () => {
  const env = { ...base, PLAYTEST_AUTH: "proxy", PLAYTEST_PROXY_SECRET: "a".repeat(64), PUBLIC_URL: "https://playtest.example.test", PLAYTEST_AUTH_LOGOUT_URL: "https://auth.example.test/logout" };
  assert.equal(loadConfig(env).auth.mode, "proxy");
  assert.equal(loadConfig(env).auth.oidc, undefined);
  for (const patch of [{ PLAYTEST_PROXY_SECRET: "short" }, { PUBLIC_URL: "http://playtest.example.test" }, { PLAYTEST_AUTH_LOGOUT_URL: "" }, { PLAYTEST_AUTH: "typo" }]) {
    assert.throws(() => loadConfig({ ...env, ...patch }), ServerConfigError);
  }
});

test("config: dev auth needs no OIDC", () => {
  const cfg: HostedDynamic = loadConfig({ ...base, PLAYTEST_AUTH: "dev" });
  assert.equal(cfg.auth.mode, "dev");
  assert.equal(cfg.auth.devUser.subject, "dev-admin");
});

test("config: no upload ceiling for application bytes — the platform holds none", () => {
  // The platform never receives an app binary: a mobile build is a runner-local
  // fact read from the runner's own configuration file. So there is no artifact
  // cap to configure, and naming the retired variable changes nothing.
  const cfg: HostedDynamic = loadConfig({ ...base, PLAYTEST_AUTH: "dev", PLAYTEST_APP_ARTIFACT_MAX_MB: "1024" });
  assert.equal(cfg.uploads, undefined);
});

test("config: there is one placement model, and no variable selects it", () => {
  // The claim board is unconditional: every runner — local, CI, fleet — arrives
  // by polling it. There is no adapter to choose, so a retired PLAYTEST_DISPATCH
  // left in an old .env changes nothing rather than failing boot.
  const cfg: HostedDynamic = loadConfig({ ...base, PLAYTEST_AUTH: "dev", PLAYTEST_DISPATCH: "github" });
  assert.equal(cfg.dispatch.local, undefined);
  assert.equal(cfg.dispatch.github, undefined);
  assert.equal(cfg.dispatch.pool.claimTimeoutMs, 600_000);
  assert.equal(cfg.dispatch.pool.heartbeatTimeoutMs, 120_000);
});

test("config: the development insecure runner exchange does not exist", () => {
  // Deleted whole, including the dev-auth auto-enable: claiming assigns and
  // exchanging authorizes, and a runner credential is the only way in.
  const cfg: HostedDynamic = loadConfig({ ...base, PLAYTEST_AUTH: "dev", PLAYTEST_RUNNER_INSECURE_EXCHANGE: "1" });
  assert.equal(cfg.dispatch.allowInsecureRunnerExchange, undefined);
  assert.equal("allowInsecureRunnerExchange" in cfg.dispatch, false);
});

test("config: Postgres is required and old SQLite configuration is refused", () => {
  const cfg = loadConfig({ ...base, PLAYTEST_AUTH: "dev" });
  assert.equal(cfg.databaseUrl, "postgres://test:test@127.0.0.1/playtest_test");
  assert.throws(() => loadConfig({ ...base, DATABASE_URL: "", PLAYTEST_AUTH: "dev" }), /DATABASE_URL/);
  assert.throws(() => loadConfig({ DATABASE_URL: cfg.databaseUrl, PLAYTEST_AUTH: "dev", PLAYTEST_DB_FILE: "/old/data.sqlite" }), /PLAYTEST_DB_FILE is obsolete/);
});

test("config: OIDC mode requires issuer/client id/secret, named", () => {
  assert.throws(() => loadConfig(base), (e) => e instanceof ServerConfigError && /OIDC_ISSUER/.test(e.message));
  const cfg: HostedDynamic = loadConfig({ ...base, OIDC_ISSUER: "https://idp", OIDC_CLIENT_ID: "id", OIDC_CLIENT_SECRET: "sec", PUBLIC_URL: "https://app.example" });
  assert.equal(cfg.auth.mode, "oidc");
  assert.equal(cfg.auth.oidc.redirectUri, "https://app.example/auth/callback");
});

test("config: object store defaults to fs; s3 url selects s3", () => {
  assert.equal(loadConfig({ ...base, PLAYTEST_AUTH: "dev" }).objectStore.kind, "fs");
  assert.equal(loadConfig({ ...base, PLAYTEST_AUTH: "dev", OBJECT_STORE_URL: "https://s3.example.test", OBJECT_STORE_BUCKET: "bucket", OBJECT_STORE_PREFIX: "test", OBJECT_STORE_REGION: "us-east-1", OBJECT_STORE_ACCESS_KEY: "test", OBJECT_STORE_SECRET_KEY: "test" }).objectStore.kind, "s3");
  assert.equal(loadConfig({ ...base, PLAYTEST_AUTH: "dev", OBJECT_STORE_URL: "/data/objs" }).objectStore.kind, "fs");
});

test("config: KMS key must decode to 32 bytes", () => {
  assert.throws(() => loadConfig({ ...base, PLAYTEST_AUTH: "dev", PLAYTEST_KMS_KEY: "short" }), (e: HostedDynamic) => /32 bytes/.test(e.message));
  const cfg: HostedDynamic = loadConfig({ ...base, PLAYTEST_AUTH: "dev", PLAYTEST_KMS_KEY: Buffer.alloc(32, 1).toString("base64") });
  assert.equal(cfg.kmsKey.length, 32);
});

test("config: drafting and synthesis share the grader tier but pin independently", () => {
  const dev = { ...base, PLAYTEST_AUTH: "dev" };
  // Default: one tier, no per-job surprise.
  const plain = loadConfig(dev);
  assert.equal(plain.llm.authoringModel, "sonnet");
  assert.equal(plain.llm.synthesisModel, "sonnet");

  // The regression this pins: PLAYTEST_AUTHORING_MODEL once drove BOTH jobs, so
  // pinning drafting silently re-tiered discovery study synthesis under a
  // variable that never mentions it. Each override moves exactly one job.
  const authoring = loadConfig({ ...dev, PLAYTEST_AUTHORING_MODEL: "opus" });
  assert.equal(authoring.llm.authoringModel, "opus");
  assert.equal(authoring.llm.synthesisModel, "sonnet");

  const synthesis = loadConfig({ ...dev, PLAYTEST_SYNTHESIS_MODEL: "haiku" });
  assert.equal(synthesis.llm.authoringModel, "sonnet");
  assert.equal(synthesis.llm.synthesisModel, "haiku");
});
