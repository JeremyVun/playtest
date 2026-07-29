import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";
import { materializeWorkspace } from "../../src/workspace.ts";
import { makeRedactor } from "../../src/redact.ts";

test("materializeWorkspace writes the ring overlay, sessions, secret files, and env vars", async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-agent-test-"));
  const files = {
    "playtest.yaml": "app:\n  base_url: http://base.invalid\n",
    "stories/a.yaml": "story: do a\nsuccess:\n  - url_matches: /a\n",
  };
  const blobs: LegacyTestValue = new Map(Object.entries(files).map(([p, content]) => [sha(content), { p, content }]));
  const api = {
    json: async (method: string, url: string) => {
      assert.equal(method, "GET");
      assert.equal(url, "/runner/snapshots/snap_1/tree");
      return { tree: Object.fromEntries([...blobs.values()].map((v) => [v.p, sha(v.content)])) };
    },
    bytes: async (url: string) => {
      const s = url.split("/").pop();
      return Buffer.from(blobs.get(s).content);
    },
  };
  const spec = {
    run_group_id: "grp_1",
    snapshot_id: "snap_1",
    ring: {
      key: "staging",
      // The URL is the ring's own field and reaches core as a runtime target
      // (exec-group.ts), never through this overlay.
      base_url: "http://staging.invalid",
      resolved_secrets: { cert: "CERTDATA", seed: "SEEDTOKEN" },
      config: {
        app: { storage_state: { $session: "sso/member" }, client_cert: { $secret_file: "cert" } },
        auth: { default: "member", identities: { member: { $session: "sso/member" } } },
        secret_env: { PLAYTEST_SEED_TOKEN: "seed" },
      },
    },
  };
  const sessions = { "sso/member": { storage_state: { cookies: [{ name: "sid", value: "abc" }], origins: [] } } };
  try {
    const ws = await materializeWorkspace({ api, spec, sessions, workDir });
    const doc = YAML.parse(await fsp.readFile(path.join(ws.suiteDir, "playtest.yaml"), "utf8"));
    assert.equal(doc.app.envs.staging.base_url, undefined, "the physical target is never written into the overlay");
    // auth.default is a SUITE-level default (top-level app.auth) — an overlay
    // `auth` would beat every story's own app.auth after the case merge (§3a).
    assert.equal(doc.app.auth, "member");
    assert.equal(doc.app.envs.staging.auth, undefined, "the overlay must not carry auth");
    assert.equal(doc.app.envs.staging.auth_states.member, ".playtest-env/session-member.json");
    assert.equal(doc.app.envs.staging.storage_state, ".playtest-env/session-sso_member.json");
    assert.equal(doc.app.envs.staging.client_cert, ".playtest-env/cert");
    assert.equal(await fsp.readFile(path.join(ws.suiteDir, ".playtest-env", "cert"), "utf8"), "CERTDATA");
    assert.equal(ws.env.PLAYTEST_SEED_TOKEN, "SEEDTOKEN");
    await ws.cleanup();
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});

test("suite-declared app.envs.<ring key> LOGICAL keys override the ring; auth_states stay ring-owned", async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-agent-test-"));
  const files = {
    // The suite carries its own idea of "staging". Its LOGICAL keys survive the
    // overlay (ring = defaults, suite = specific); a committed auth_states can
    // never shadow the minted sessions; and its authored base_url survives here
    // only to be replaced by the runtime target at resolution (gate 8).
    "playtest.yaml": [
      "app:",
      "  base_url: http://base.invalid",
      "  envs:",
      "    staging:",
      "      base_url: http://suite-staging.invalid",
      "      timeout_ms: 9000",
      "      auth_states:",
      "        member: stolen.json",
      "",
    ].join("\n"),
    "stories/a.yaml": "story: do a\nsuccess:\n  - url_matches: /a\n",
  };
  const blobs: LegacyTestValue = new Map(Object.entries(files).map(([p, content]) => [sha(content), { p, content }]));
  const api = {
    json: async () => ({ tree: Object.fromEntries([...blobs.values()].map((v) => [v.p, sha(v.content)])) }),
    bytes: async (url: string) => Buffer.from(blobs.get(url.split("/").pop()).content),
  };
  const spec = {
    run_group_id: "grp_2",
    snapshot_id: "snap_2",
    ring: {
      key: "staging",
      base_url: "http://ring-staging.invalid",
      resolved_secrets: {},
      config: {
        app: { viewport: "desktop" },
        auth: { identities: { member: { $session: "sso/member" } } },
      },
    },
  };
  const sessions = { "sso/member": { storage_state: { cookies: [], origins: [] } } };
  try {
    const ws = await materializeWorkspace({ api, spec, sessions, workDir });
    const doc = YAML.parse(await fsp.readFile(path.join(ws.suiteDir, "playtest.yaml"), "utf8"));
    assert.equal(doc.app.envs.staging.timeout_ms, 9000, "suite-only logical keys survive");
    assert.equal(doc.app.envs.staging.viewport, "desktop", "ring-only logical keys still apply");
    // The workspace no longer arbitrates the physical target at all: the suite's
    // authored base_url is written through untouched, and core's runtime target
    // replaces it after the complete authored merge.
    assert.equal(doc.app.envs.staging.base_url, "http://suite-staging.invalid",
      "the ring's URL is not merged here — it arrives as the runtime target");
    assert.equal(doc.app.envs.staging.auth_states.member, ".playtest-env/session-member.json",
      "credentials are operator-owned — a committed auth_states never shadows minted sessions");
    await ws.cleanup();
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});

test("project model defaults fill only unset playtest.yaml keys — the suite wins", async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-agent-test-"));
  const files = {
    // The suite chose its own actor; it says nothing about the grader. The
    // project default must fill exactly the silent key and never the chosen one
    // (docs/contracts/hosted.md, "Model selection").
    "playtest.yaml": "actor_model: opus\napp:\n  base_url: http://base.invalid\n",
    "stories/a.yaml": "story: do a\nsuccess:\n  - url_matches: /a\n",
  };
  const blobs: LegacyTestValue = new Map(Object.entries(files).map(([p, content]) => [sha(content), { p, content }]));
  const api = {
    json: async () => ({ tree: Object.fromEntries([...blobs.values()].map((v) => [v.p, sha(v.content)])) }),
    bytes: async (url: string) => Buffer.from(blobs.get(url.split("/").pop()).content),
  };
  const spec = {
    run_group_id: "grp_3",
    snapshot_id: "snap_3",
    project: { id: "p1", key: "demo", name: "Demo", models: { actor_model: "sonnet", grader_model: "gpt5_5" } },
    ring: { key: "staging", base_url: "http://ring.invalid", resolved_secrets: {}, config: {} },
  };
  try {
    const ws = await materializeWorkspace({ api, spec, sessions: {}, workDir });
    const doc = YAML.parse(await fsp.readFile(path.join(ws.suiteDir, "playtest.yaml"), "utf8"));
    assert.equal(doc.actor_model, "opus", "the suite's own choice is never overwritten");
    assert.equal(doc.grader_model, "gpt5_5", "the project default fills the unset key");
    await ws.cleanup();
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});

test("a project with no model defaults leaves the suite file's model keys absent", async () => {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-agent-test-"));
  const files = {
    "playtest.yaml": "app:\n  base_url: http://base.invalid\n",
    "stories/a.yaml": "story: do a\nsuccess:\n  - url_matches: /a\n",
  };
  const blobs: LegacyTestValue = new Map(Object.entries(files).map(([p, content]) => [sha(content), { p, content }]));
  const api = {
    json: async () => ({ tree: Object.fromEntries([...blobs.values()].map((v) => [v.p, sha(v.content)])) }),
    bytes: async (url: string) => Buffer.from(blobs.get(url.split("/").pop()).content),
  };
  const spec = {
    run_group_id: "grp_4",
    snapshot_id: "snap_4",
    project: { id: "p1", key: "demo", name: "Demo", models: {} },
    ring: { key: "staging", base_url: "http://ring.invalid", resolved_secrets: {}, config: {} },
  };
  try {
    const ws = await materializeWorkspace({ api, spec, sessions: {}, workDir });
    const doc = YAML.parse(await fsp.readFile(path.join(ws.suiteDir, "playtest.yaml"), "utf8"));
    assert.ok(!("actor_model" in doc) && !("grader_model" in doc),
      "no project policy means the engine defaults decide, exactly as before");
    await ws.cleanup();
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});

test("redactor replaces configured secret values, however short", () => {
  const redact = makeRedactor(["secret-token", "abc"]);
  // A three-character secret is a poor secret, but declining to redact one an
  // operator configured is a leak, not tidiness: no non-empty value is dropped.
  assert.equal(redact("seed=secret-token cookie=abc"), "seed=[redacted] cookie=[redacted]");
  // An empty value is the one thing that is not a needle — it matches
  // everywhere and protects nothing.
  assert.equal(makeRedactor(["", null, 7])("nothing to mask"), "nothing to mask");
});

function sha(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}
