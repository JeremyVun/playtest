// Secret references: resolution precedence, actionable failures, redaction, and
// the config surface that has to accept them (docs/contracts/engine.md#secrets-and-redaction).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverCases, DummyConfigError } from "../../../src/core/config.ts";
import {
  SECRET_ENV_PREFIX,
  collectSecretRefNames,
  isSecretRef,
  normalizeRedact,
  normalizeSecretHeaders,
  redactSecrets,
  registerSecretsFromEnv,
  resetSecrets,
  resolveSecret,
  resolveSecretRefs,
  secretNameForValue,
  setSecretProvider,
} from "../../../src/core/secrets.ts";

const VAR = `${SECRET_ENV_PREFIX}TOKEN`;

beforeEach(() => resetSecrets());
afterEach(() => {
  resetSecrets();
  delete process.env[VAR];
});

test("a reference resolves from the provider first, then the environment", () => {
  process.env[VAR] = "from-environment";
  assert.equal(resolveSecret("TOKEN"), "from-environment");

  resetSecrets();
  setSecretProvider((name) => (name === "TOKEN" ? "from-provider" : null));
  assert.equal(resolveSecret("TOKEN"), "from-provider", "an explicitly registered provider wins");
  // A provider that does not know this secret falls through to the environment
  // rather than failing: the hosted runner supplies some names, not all.
  assert.equal(resolveSecret("TOKEN", {}), "from-provider");
  setSecretProvider((name) => (name === "OTHER" ? "x" : null));
  assert.equal(resolveSecret("TOKEN"), "from-environment");
});

test("a missing secret is a DummyConfigError naming the secret and the variable to set", () => {
  delete process.env[VAR];
  assert.throws(
    () => resolveSecret("TOKEN", { where: "suite/playtest.yaml" }),
    (e) => {
      assert.ok(e instanceof DummyConfigError, "config failures are DummyConfigError");
      assert.match(e.message, /suite\/playtest\.yaml/);
      assert.match(e.message, /"TOKEN"/);
      assert.match(e.message, new RegExp(VAR));
      assert.match(e.message, /never reads \.env/);
      return true;
    },
  );
  // An empty variable is missing, not an empty secret.
  process.env[VAR] = "";
  assert.throws(() => resolveSecret("TOKEN"), DummyConfigError);
  assert.throws(() => resolveSecret("not a name" as LegacyTestValue), DummyConfigError); // SAFETY: deliberately invalid secret name pins validation
});

test("resolution registers the value, so redaction covers it everywhere", () => {
  process.env[VAR] = "s3cret-value-longer";
  const resolved = resolveSecretRefs({ Authorization: { $secret: "TOKEN" }, "X-Tenant": "acme" });
  assert.deepEqual(resolved, { Authorization: "s3cret-value-longer", "X-Tenant": "acme" });
  assert.equal(redactSecrets("sent s3cret-value-longer twice: s3cret-value-longer"), "sent [secret:TOKEN] twice: [secret:TOKEN]");
  assert.equal(secretNameForValue("s3cret-value-longer"), "TOKEN");
  assert.equal(secretNameForValue("acme"), null);
});

test("redaction covers the JSON-escaped form and the bare credential behind an auth scheme", () => {
  process.env[VAR] = 'Bearer tok"en\\value';
  resolveSecret("TOKEN");
  const serialized = JSON.stringify({ h: 'Bearer tok"en\\value' });
  assert.ok(!redactSecrets(serialized).includes('tok\\"en'), "a value inside a JSON document is scrubbed in its escaped form");

  resetSecrets();
  process.env[VAR] = "Bearer abcd1234efgh5678";
  resolveSecret("TOKEN");
  assert.equal(redactSecrets("echoed abcd1234efgh5678 back"), "echoed [secret:TOKEN] back", "a server echoing the bare token is still scrubbed");
  assert.equal(secretNameForValue("abcd1234efgh5678"), null, "the derived half is never turned back into a reference");
});

test("short values are not scrubbed from free text, and absent secrets are simply not known", () => {
  process.env[VAR] = "ab";
  resolveSecret("TOKEN");
  assert.equal(redactSecrets("a table of abbreviations"), "a table of abbreviations");
  resetSecrets();
  delete process.env[VAR];
  registerSecretsFromEnv(["TOKEN", "bad name"]); // best effort, never throws
  assert.equal(redactSecrets("nothing to do"), "nothing to do");
});

test("reference detection and name collection walk arbitrary config", () => {
  assert.ok(isSecretRef({ $secret: "A" }));
  assert.ok(!isSecretRef({ $secret: 1 }));
  assert.ok(!isSecretRef("A"));
  assert.deepEqual(collectSecretRefNames({ a: { $secret: "B" }, b: [{ $secret: "A" }, "x"] }), ["A", "B"]);
});

test("app.headers and redact are validated with actionable messages", () => {
  assert.deepEqual(normalizeSecretHeaders({ A: "1", B: { $secret: "T" } }, "f.yaml"), { A: "1", B: { $secret: "T" } });
  assert.equal(normalizeSecretHeaders(null, "f.yaml"), null);
  assert.throws(() => normalizeSecretHeaders(["a"], "f.yaml"), /f\.yaml: app\.headers must be a map/);
  assert.throws(() => normalizeSecretHeaders({ A: 12 }, "f.yaml"), /f\.yaml: app\.headers\.A must be a string or a secret reference/);
  assert.throws(() => normalizeSecretHeaders({ "Bad Name": "x" }, "f.yaml"), /valid HTTP header name/);

  assert.throws(
    () => normalizeRedact({ request: [{ path: "body.email" }] } as LegacyTestValue, "f.yaml"), // SAFETY: deliberately missing secret pins validation
    (e) => e instanceof DummyConfigError && /needs "secret: NAME"/.test(e.message),
  );
  assert.throws(() => normalizeRedact({ request: [{ path: "$.email", secret: "E" }] }, "f.yaml"), /must start with "headers\." or "body"/);
  assert.throws(() => normalizeRedact({ projections: [] } as LegacyTestValue, "f.yaml"), /unknown redact key/); // SAFETY: deliberately unknown key pins validation
  assert.equal(normalizeRedact({ request: [], projection: [] }, "f.yaml"), null);
});

test("the case and defaults schemas accept secret references and redaction lists from YAML", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-secret-schema-"));
  try {
    fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
    // The suite defaults carry the header reference; the case carries its own
    // redaction list. Both files go through their own schema.
    fs.writeFileSync(
      path.join(dir, "playtest.yaml"),
      [
        "app:",
        "  driver: api",
        "  base_url: http://127.0.0.1:1",
        "  headers:",
        "    Authorization:",
        "      $secret: LEDGER_TOKEN",
        '    X-Api-Version: "2026-01-01"',
        "redact:",
        "  projection:",
        "    - $.customer.email",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "stories", "s.yaml"),
      ["story: do a thing", "redact:", "  request:", "    - path: body.owner_email", "      secret: OWNER_EMAIL", ""].join("\n"),
    );
    const [rc]: LegacyTestValue = await discoverCases([dir]);
    assert.deepEqual(rc.env.headers, { Authorization: { $secret: "LEDGER_TOKEN" }, "X-Api-Version": "2026-01-01" });
    assert.deepEqual(rc.redact, { request: [{ path: "body.owner_email", secret: "OWNER_EMAIL" }], projection: [] });

    // A malformed reference is rejected by the schema, not silently ignored.
    fs.writeFileSync(path.join(dir, "stories", "s.yaml"), "story: do a thing\napp:\n  headers:\n    A:\n      $secret: 3\n");
    await assert.rejects(() => discoverCases([dir]), DummyConfigError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("app.headers is api-only and named as such on the wrong driver", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-secret-driver-"));
  try {
    fs.mkdirSync(path.join(dir, "stories"), { recursive: true });
    fs.writeFileSync(path.join(dir, "playtest.yaml"), "app:\n  base_url: http://127.0.0.1:1\n  headers:\n    A: b\n");
    fs.writeFileSync(path.join(dir, "stories", "s.yaml"), "story: do a thing\n");
    await assert.rejects(
      () => discoverCases([dir]),
      (e) => e instanceof DummyConfigError && /app\.headers is not valid for the web driver/.test(e.message),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
