// P5 (platform simplification) — plugins and integrations are gone. Asserted
// hermetically: the executable route table registers no plugin/integration
// endpoint, and the loaded config carries no plugin worker interval. buildRouter
// imports every handler module but touches no database, and loadConfig is pure,
// so this stays in the offline gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRouter } from "../../src/routes.ts";
import { loadConfig } from "../../src/config.ts";

const r: HostedDynamic = buildRouter();
const has = (method: HostedDynamic, path: HostedDynamic) => r.match(method, path) != null && !r.match(method, path).methodNotAllowed;

test("routes: no plugin or integration endpoints remain", () => {
  for (const [method, path] of [
    ["GET", "/api/v1/projects/acme/plugins"],
    ["POST", "/api/v1/projects/acme/plugins"],
    ["PUT", "/api/v1/plugins/p1"],
    ["GET", "/api/v1/plugins/p1/deliveries"],
    ["POST", "/api/v1/plugins/p1/test"],
    ["GET", "/api/v1/projects/acme/integrations"],
    ["POST", "/api/v1/projects/acme/integrations"],
    ["PUT", "/api/v1/integrations/i1"],
  ]) {
    assert.ok(!has(method, path), `${method} ${path} must not be routed`);
  }
});

test("config: no plugin worker interval is configured", () => {
  const cfg: HostedDynamic = loadConfig({ PLAYTEST_AUTH: "dev" });
  assert.equal(cfg.plugins, undefined, "config must not expose a plugin worker section");
});
