import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { withApp } from "./helpers.ts";
import { createSession } from "../../src/auth/sessions.ts";
import { newToken } from "../../src/auth/tokens.ts";

const secret = "a".repeat(64);
const publicUrl = "https://playtest.example.test";
const env = {
  PLAYTEST_AUTH: "proxy", PLAYTEST_PROXY_SECRET: secret,
  PUBLIC_URL: publicUrl, PLAYTEST_AUTH_LOGOUT_URL: "https://auth.example.test/logout",
};
const identity = { "x-playtest-proxy-key": secret, "remote-user": "alice", "remote-email": "alice@example.test", "remote-name": "Alice" };

test("proxy auth: admitted users administer every project and retain individual audit identities", async () => {
  await withApp(async ({ base, app }: HostedDynamic) => {
    const me = await fetch(`${base}/api/v1/me`, { headers: identity }).then((r) => r.json());
    assert.equal(me.is_site_admin, true);
    assert.equal(me.is_dev_admin, false);
    assert.equal(me.subject, "proxy:alice");
    const created = await fetch(`${base}/api/v1/projects`, {
      method: "POST", headers: { ...identity, origin: publicUrl, "content-type": "application/json" },
      body: JSON.stringify({ key: "shared", name: "Shared" }),
    });
    assert.equal(created.status, 201);
    const project = await created.json();
    const bob = { ...identity, "remote-user": "bob", "remote-name": "Bob", "remote-email": "bob@example.test" };
    const projects = await fetch(`${base}/api/v1/projects`, { headers: bob }).then((r) => r.json());
    assert.equal(projects.items[0].id, project.id);
    assert.equal((await fetch(`${base}/api/v1/site/runners`, { headers: bob })).status, 200);
    const bobMe = await fetch(`${base}/api/v1/me`, { headers: bob }).then((r) => r.json());
    assert.equal(bobMe.roles[project.id], "admin");
    assert.notEqual(bobMe.user_id, me.user_id);
    const audit = (await app.db.query("SELECT actor FROM audit_log WHERE action = 'project.created'")).rows[0];
    assert.equal(audit.actor.user_id, me.user_id);
  }, env);
});

test("proxy auth: direct headers, stale sessions, disabled users and duplicate identity are refused", async () => {
  await withApp(async ({ base, app }: HostedDynamic) => {
    for (const headers of [{ "remote-user": "alice" }, { ...identity, "x-playtest-proxy-key": "wrong" }, { ...identity, "remote-user": "alice, bob" }]) {
      assert.equal((await fetch(`${base}/api/v1/me`, { headers })).status, 401);
    }
    const me = await fetch(`${base}/api/v1/me`, { headers: identity }).then((r) => r.json());
    const session = await createSession(app.db, me.user_id);
    assert.equal((await fetch(`${base}/api/v1/me`, { headers: { cookie: `pt_session=${session.id}` } })).status, 401);
    const duplicateStatus = await new Promise((resolve, reject) => {
      const req = http.get(`${base}/api/v1/me`, { headers: { ...identity, "remote-user": ["alice", "bob"] } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
    });
    assert.equal(duplicateStatus, 401);
    await app.db.query("UPDATE users SET disabled = $1 WHERE id = $2", [true, me.user_id]);
    assert.equal((await fetch(`${base}/api/v1/me`, { headers: identity })).status, 401);
    assert.equal((await app.db.query("SELECT disabled FROM users WHERE id = $1", [me.user_id])).rows[0].disabled, true);
  }, env);
});

test("proxy auth: writes require the public origin and logout uses browser navigation", async () => {
  await withApp(async ({ base }: HostedDynamic) => {
    for (const origin of [undefined, "null", "https://evil.example.test"]) {
      const res = await fetch(`${base}/auth/logout`, {
        method: "POST", redirect: "manual", headers: { ...identity, ...(origin ? { origin } : {}) },
      });
      assert.equal(res.status, 403);
    }
    const logout = await fetch(`${base}/auth/logout`, { method: "POST", redirect: "manual", headers: { ...identity, origin: publicUrl } });
    assert.equal(logout.status, 302);
    assert.equal(logout.headers.get("location"), env.PLAYTEST_AUTH_LOGOUT_URL);
    assert.match(logout.headers.get("set-cookie") || "", /pt_session=;/);
    for (const [returnTo, expected] of [["/p/shared/findings", "/p/shared/findings"], ["//evil.example.test", "/"], ["/\\evil.example.test", "/"]]) {
      const res = await fetch(`${base}/auth/login?returnTo=${encodeURIComponent(returnTo!)}`, { headers: identity, redirect: "manual" });
      assert.equal(res.headers.get("location"), expected);
    }
    assert.equal((await fetch(`${base}/auth/callback`, { headers: identity })).status, 404);
  }, env);
});

test("proxy auth: a bearer keeps its own scope even alongside trusted administrator headers", async () => {
  await withApp(async ({ base, app }: HostedDynamic) => {
    await app.db.query("INSERT INTO projects (id, key, name) VALUES ('p1', 'one', 'One'), ('p2', 'two', 'Two')");
    const token = newToken({ projectId: "p1", role: "viewer", name: "Reader" });
    await app.db.query("INSERT INTO api_tokens (id, project_id, role, name, token_hash) VALUES ($1,$2,$3,$4,$5)", Object.values(token.row));
    const headers = { ...identity, authorization: `Bearer ${token.plaintext}` };
    const me = await fetch(`${base}/api/v1/me`, { headers }).then((r) => r.json());
    assert.equal(me.kind, "token");
    assert.equal(me.is_site_admin, undefined);
    assert.equal((await fetch(`${base}/api/v1/site/runners`, { headers })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/projects/two`, { headers })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/me`, { headers: { ...identity, authorization: "Bearer invalid" } })).status, 401);
  }, env);
});
