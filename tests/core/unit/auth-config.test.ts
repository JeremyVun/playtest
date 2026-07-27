// app.auth/app.auth_states identity resolution
// (docs/contracts/engine.md#web-identity).
// A story declares WHO it runs as with an abstract label ("member", "admin",
// "none"); the environment (or suite) supplies the label → storage-state map.
// Pure config resolution — no LLM, no browser.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverCases, DummyConfigError } from "../../../src/core/config.ts";

let tmpRoot: LegacyTestValue;
before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-auth-config-"));
});
after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let suiteSeq = 0;
function writeSuite(files: Record<string, string>) {
  const dir = path.join(tmpRoot, `suite-${++suiteSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

async function expectConfigError(dir: string, opts: LegacyTestValue, ...patterns: RegExp[]) {
  await assert.rejects(discoverCases([dir], opts), (e: LegacyTestValue) => {
    assert.ok(e instanceof DummyConfigError, `expected DummyConfigError, got: ${e?.stack ?? e}`);
    for (const p of patterns) assert.match(e.message, p);
    return true;
  });
}

const CASE = "story: do the thing\nsuccess:\n  - assert: it worked\n";

test("app.auth resolves through app.auth_states to storage_state; story override wins", async () => {
  const dir = writeSuite({
    "playtest.yaml":
      "app:\n  base_url: http://localhost:9\n  auth: member\n" +
      "  auth_states:\n    member: ./.auth/member.json\n    admin: ./.auth/admin.json\n",
    "member.yaml": CASE,
    "admin.yaml": "app:\n  auth: admin\n" + CASE,
  });
  const byName: LegacyTestValue = Object.fromEntries((await discoverCases([dir])).map((c) => [c.name, c]));
  assert.equal(byName.member.env.auth, "member");
  assert.equal(byName.member.env.storage_state, path.join(dir, ".auth", "member.json"));
  assert.equal(byName.admin.env.auth, "admin");
  assert.equal(byName.admin.env.storage_state, path.join(dir, ".auth", "admin.json"));
  // auth_states is a resolution input, never carried on the ResolvedCase env
  assert.ok(!("auth_states" in byName.member.env));
});

test('app.auth "none" explicitly clears an inherited storage_state', async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n  storage_state: ./.auth/default.json\n",
    "signup.yaml": "app:\n  auth: none\n" + CASE,
    "browse.yaml": CASE,
  });
  const byName: LegacyTestValue = Object.fromEntries((await discoverCases([dir])).map((c) => [c.name, c]));
  assert.equal(byName.signup.env.auth, "none");
  assert.equal(byName.signup.env.storage_state, null, "signup starts signed out");
  assert.equal(byName.browse.env.auth, null, "absent auth keeps today's behavior");
  assert.equal(byName.browse.env.storage_state, path.join(dir, ".auth", "default.json"));
});

test("an env overlay supplies auth_states (+ default auth); labels stay environment-agnostic", async () => {
  const dir = writeSuite({
    "playtest.yaml":
      "app:\n  base_url: http://localhost:9\n  auth: member\n" +
      "  envs:\n    staging:\n      base_url: http://staging:9\n" +
      "      auth_states:\n        member: ./sessions/stg-member.json\n        admin: ./sessions/stg-admin.json\n",
    "stories/admin-refund.yaml": "app:\n  auth: admin\n" + CASE,
  });
  const [rc]: LegacyTestValue = await discoverCases([dir], { env: "staging" });
  assert.equal(rc.env.auth, "admin");
  assert.equal(rc.env.storage_state, path.join(dir, "sessions", "stg-admin.json"),
    "the overlay's map resolves the story's abstract label");
  // Without --env there is no map anywhere: discovery/list/validate still
  // succeed (the suite files are env-agnostic — the map normally arrives with
  // an env overlay), but resolution is marked deferred and the RUN fails
  // before it could silently start signed-in-as-nobody (prepareEnv → infra).
  const [envless]: LegacyTestValue = await discoverCases([dir]);
  assert.equal(envless.env.auth, "admin");
  assert.equal(envless.env.auth_unresolved, true, "resolution deferred, never silent");
  const { prepareEnv, InfraError } = await import("../../../src/core/env.ts");
  await assert.rejects(prepareEnv(envless, "run-x"), (e: LegacyTestValue) => {
    assert.ok(e instanceof InfraError, `expected InfraError, got: ${e?.stack ?? e}`);
    assert.match(e.message, /app\.auth "admin"/);
    assert.match(e.message, /auth_states/);
    return true;
  });
});

test("a declared-but-empty auth_states map is still an immediate config error", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n  auth: member\n  auth_states: {}\n",
    "home.yaml": CASE,
  });
  await expectConfigError(dir, {}, /app\.auth "member"/, /map is empty/);
});

test("a label missing from auth_states is a config error naming the file, label and available labels", async () => {
  const dir = writeSuite({
    "playtest.yaml":
      "app:\n  base_url: http://localhost:9\n  auth_states:\n    member: ./m.json\n    admin: ./a.json\n",
    "typo.yaml": "app:\n  auth: memberr\n" + CASE,
  });
  await expectConfigError(dir, {}, /typo\.yaml/, /app\.auth "memberr"/, /available: admin, member/);
});

test("auth is web-only (v1): an api case declaring it is a driver-scope config error", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n  driver: api\n",
    "signup.yaml": "app:\n  auth: none\n" + CASE,
  });
  await expectConfigError(dir, {}, /app\.auth is not valid for the api driver/, /valid: web/);
});

test("auth_states paths resolve against the file that declared them", async () => {
  const dir = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n",
    "stories/playtest.yaml": "app:\n  auth_states:\n    member: ../.auth/member.json\n",
    "stories/checkout.yaml": "app:\n  auth: member\n" + CASE,
  });
  const [rc]: LegacyTestValue = await discoverCases([dir]);
  assert.equal(rc.env.storage_state, path.join(dir, ".auth", "member.json"),
    "relative to stories/playtest.yaml, not the case file or cwd");
});
