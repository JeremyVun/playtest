import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, ServerConfigError } from "../../src/config.ts";
import { groupDispatchLabels } from "../../src/dispatch/dispatcher.ts";
import { normalizeLabels } from "../../src/auth/runner-credentials.ts";
const pool = { PLAYTEST_DATA_DIR: "/tmp/playtest-pool-oidc-config-test", PLAYTEST_AUTH: "dev" };

test("config: ephemeral CI registration is off until a repository is pinned", () => {
  const cfg: HostedDynamic = loadConfig({ DATABASE_URL: "postgres://test:test@127.0.0.1/playtest_test", ...pool });
  // The pins default to GitHub's real issuer and audience, but `repository` is
  // null, which is what keeps the route shut:
  // an unpinned repository check would accept a token from anyone on GitHub.
  assert.equal(cfg.dispatch.pool.oidc.repository, null);
  assert.equal(cfg.dispatch.pool.oidc.oidcIssuer, "https://token.actions.githubusercontent.com");
  assert.equal(cfg.dispatch.pool.oidc.oidcAudience, "playtest");
  assert.equal(cfg.dispatch.pool.oidc.ttlMs, 3_600_000);

  const pinned: HostedDynamic = loadConfig({ DATABASE_URL: "postgres://test:test@127.0.0.1/playtest_test",
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
      () => loadConfig({ DATABASE_URL: "postgres://test:test@127.0.0.1/playtest_test", ...pool, ...half }),
      (e: HostedDynamic) =>
        e instanceof ServerConfigError &&
        /PLAYTEST_POOL_OIDC_REPOSITORY/.test(e.message) &&
        /any repository/.test(e.message),
      `${JSON.stringify(half)} must not boot`,
    );
  }
});

test("config: the ephemeral credential's lifetime is bounded by GitHub's own job ceiling", () => {
  assert.equal(loadConfig({ DATABASE_URL: "postgres://test:test@127.0.0.1/playtest_test", ...pool, PLAYTEST_POOL_OIDC_TTL_S: "21600" }).dispatch.pool.oidc.ttlMs, 21_600_000);
  for (const ttl of ["30", "21601", "nonsense"]) {
    assert.throws(
      () => loadConfig({ DATABASE_URL: "postgres://test:test@127.0.0.1/playtest_test", ...pool, PLAYTEST_POOL_OIDC_TTL_S: ttl }),
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

test("a pinned launch places every attempt, however the environment changes", () => {
  const env = { runner_labels: ["staging-box"] };
  assert.deepEqual(groupDispatchLabels({ runner_labels: null }, env), ["staging-box"]);
  assert.deepEqual(groupDispatchLabels({ runner_labels: ["ci-run-77"] }, env), ["ci-run-77"]);
  // An explicit empty pin is a decision, not an absent one: "any runner in the
  // project", even when the environment asks for a label.
  assert.deepEqual(groupDispatchLabels({ runner_labels: [] }, env), []);
  assert.deepEqual(groupDispatchLabels({ runner_labels: null }, {}), []);
});
