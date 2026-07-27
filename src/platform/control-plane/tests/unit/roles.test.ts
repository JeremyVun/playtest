import { test } from "node:test";
import assert from "node:assert/strict";
import { roleSatisfies, effectiveRole, requireRole } from "../../src/auth/roles.ts";
import { AppError } from "../../src/errors.ts";
import { kindForPath, isCodeKind, normalizePath } from "../../src/suites/paths.ts";

test("roles: cumulative hierarchy", () => {
  assert.ok(roleSatisfies("admin", "viewer"));
  assert.ok(roleSatisfies("developer", "reviewer"));
  assert.ok(!roleSatisfies("editor", "developer"));
  assert.ok(!roleSatisfies(null, "viewer"));
});

test("roles: dev admin is admin everywhere; members use their map", () => {
  assert.equal(effectiveRole({ kind: "user", isDevAdmin: true }, "p1"), "admin");
  const user = { kind: "user", roles: new Map([["p1", "editor"]]) };
  assert.equal(effectiveRole(user, "p1"), "editor");
  assert.equal(effectiveRole(user, "p2"), null);
});

test("roles: token scope — site vs project", () => {
  const site = { kind: "token", projectId: null, role: "viewer" };
  const scoped = { kind: "token", projectId: "p1", role: "editor" };
  assert.equal(effectiveRole(site, "anything"), "viewer");
  assert.equal(effectiveRole(scoped, "p1"), "editor");
  assert.equal(effectiveRole(scoped, "p2"), null);
});

test("roles: requireRole throws forbidden below the bar", () => {
  const user = { kind: "user", roles: new Map([["p1", "viewer"]]) };
  assert.throws(() => requireRole(user, "p1", "editor"), (e) => e instanceof AppError && e.code === "forbidden");
  assert.equal(requireRole(user, "p1", "viewer"), "viewer");
});

test("paths: kindForPath maps the CLI layout", () => {
  assert.equal(kindForPath("playtest.yaml"), "defaults");
  assert.equal(kindForPath("stories/add-todo.yaml"), "case");
  assert.equal(kindForPath("personas/curious.yaml"), "persona");
  assert.equal(kindForPath("hooks/before_each.js"), "hook");
  assert.equal(kindForPath("assertions/link-check/assertion.js"), "assertion");
  assert.equal(kindForPath("docker-compose.yml"), "asset"); // .yml is not a case (core: .yaml only)
  assert.equal(kindForPath("fixtures/data.json"), "asset");
  assert.ok(isCodeKind("hook") && isCodeKind("assertion") && !isCodeKind("case"));
});

test("paths: normalizePath rejects traversal and absolutes", () => {
  assert.equal(normalizePath("./stories/x.yaml"), "stories/x.yaml");
  assert.equal(normalizePath("/a/b"), "a/b");
  assert.throws(() => normalizePath("../escape"), /escapes the suite/);
  assert.throws(() => normalizePath("a/../../b"), /escapes the suite/);
});
