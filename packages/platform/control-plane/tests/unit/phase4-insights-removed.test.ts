// P4 (platform simplification) — Insights are gone; findings own cross-run
// synthesis. Asserted hermetically from the executable route table: no insight
// list/get/report/create endpoint is routable, and the contextual
// synthesize-findings endpoint is. buildRouter imports every handler module but
// touches no database, so this stays in the offline gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRouter } from "../../src/routes.ts";

const r: HostedDynamic = buildRouter();
const has = (method: HostedDynamic, path: HostedDynamic) => r.match(method, path) != null && !r.match(method, path).methodNotAllowed;

test("routes: no insight endpoints remain", () => {
  for (const [method, path] of [
    ["POST", "/api/v1/projects/acme/insights"],
    ["GET", "/api/v1/projects/acme/insights"],
    ["GET", "/api/v1/insights/i1"],
    ["GET", "/api/v1/insights/i1/report"],
  ]) {
    assert.ok(!has(method, path), `${method} ${path} must not be routed`);
  }
});

test("routes: discovery synthesis reaches findings through a run-group endpoint", () => {
  assert.ok(has("POST", "/api/v1/run-groups/g1/synthesize-findings"), "synthesize-findings survives");
  // Findings remain the durable claim surface.
  assert.ok(has("GET", "/api/v1/projects/acme/findings"), "findings list survives");
  assert.ok(has("POST", "/api/v1/findings/f1/accept"), "confirm (accept) survives");
});
