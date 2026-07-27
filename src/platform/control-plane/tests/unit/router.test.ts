import { test } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../../src/router.ts";

test("router: matches params and wildcard remainder", () => {
  const r: HostedDynamic = new Router();
  r.get("/api/v1/suites/:s/files/*path", () => "hit");
  const m: HostedDynamic = r.match("GET", "/api/v1/suites/abc/files/stories/add-todo.yaml");
  assert.equal(m.params.s, "abc");
  assert.equal(m.params.path, "stories/add-todo.yaml");
});

test("router: distinguishes 404 from 405", () => {
  const r = new Router();
  r.post("/projects", () => {});
  assert.equal(r.match("GET", "/nope"), null);
  const m: HostedDynamic = r.match("GET", "/projects");
  assert.ok(m.methodNotAllowed);
  assert.deepEqual(m.allow, ["POST"]);
});

test("router: decodes percent-encoded params", () => {
  const r: HostedDynamic = new Router();
  r.get("/p/:key", () => {});
  assert.equal(r.match("GET", "/p/a%2Fb").params.key, "a/b");
});

test("router: trailing slash tolerated", () => {
  const r = new Router();
  r.get("/projects/:p", () => {});
  assert.ok(r.match("GET", "/projects/x/"));
});

test("router: wildcard must be last segment", () => {
  const r = new Router();
  assert.throws(() => r.get("/a/*mid/b", () => {}), /wildcard must be last/);
});
