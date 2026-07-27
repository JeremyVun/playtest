// P3 (platform simplification) — the reduced run action surface, asserted
// hermetically from the executable route table. Re-grade, legal holds, and
// project retention policies are gone; Export clip (GET/POST clip) and Bundle
// download survive. buildRouter imports every handler module but touches no
// database, so this stays in the offline gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRouter } from "../../src/routes.ts";

const r: HostedDynamic = buildRouter();
const has = (method: HostedDynamic, path: HostedDynamic) => r.match(method, path) != null && !r.match(method, path).methodNotAllowed;

test("routes: re-grade, legal holds, project retention policies, and the storage route are absent", () => {
  for (const [method, path] of [
    ["POST", "/api/v1/runs/run1/grade"],
    ["POST", "/api/v1/runs/run1/legal-hold"],
    ["DELETE", "/api/v1/runs/run1/legal-hold"],
    ["GET", "/api/v1/projects/acme/retention"],
    ["PUT", "/api/v1/projects/acme/retention"],
    // Storage usage is now internal-only (projects.js health, retention worker);
    // there is no longer a dedicated route.
    ["GET", "/api/v1/projects/acme/storage"],
  ]) {
    assert.ok(!has(method, path), `${method} ${path} must not be routed`);
  }
});

test("routes: clip export and bundle download survive for non-UI clients too", () => {
  assert.ok(has("GET", "/api/v1/runs/run1/clip"), "GET clip (download) survives");
  assert.ok(has("POST", "/api/v1/runs/run1/clip"), "POST clip (generate) survives");
  assert.ok(has("GET", "/api/v1/runs/run1/download"), "bundle download survives");
});
