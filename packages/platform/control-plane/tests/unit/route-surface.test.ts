import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRouter } from "../../src/routes.ts";

const router: HostedDynamic = buildRouter();
const has = (method: string, path: string) => {
  const match = router.match(method, path);
  return match != null && !match.methodNotAllowed;
};

test("removed hosted surfaces stay out of the route table", () => {
  const removed = [
    ["POST", "/api/v1/runs/run1/grade"],
    ["POST", "/api/v1/runs/run1/legal-hold"],
    ["DELETE", "/api/v1/runs/run1/legal-hold"],
    ["GET", "/api/v1/projects/acme/retention"],
    ["PUT", "/api/v1/projects/acme/retention"],
    ["GET", "/api/v1/projects/acme/storage"],
    ["POST", "/api/v1/projects/acme/insights"],
    ["GET", "/api/v1/projects/acme/insights"],
    ["GET", "/api/v1/insights/i1"],
    ["GET", "/api/v1/insights/i1/report"],
    ["GET", "/api/v1/projects/acme/plugins"],
    ["POST", "/api/v1/projects/acme/plugins"],
    ["PUT", "/api/v1/plugins/p1"],
    ["GET", "/api/v1/plugins/p1/deliveries"],
    ["POST", "/api/v1/plugins/p1/test"],
    ["GET", "/api/v1/projects/acme/integrations"],
    ["POST", "/api/v1/projects/acme/integrations"],
    ["PUT", "/api/v1/integrations/i1"],
  ] as const;

  for (const [method, path] of removed) {
    assert.equal(has(method, path), false, `${method} ${path} must not be routed`);
  }
});

test("the supported replacements remain routed", () => {
  for (const [method, path] of [
    ["GET", "/api/v1/runs/run1/clip"],
    ["POST", "/api/v1/runs/run1/clip"],
    ["GET", "/api/v1/runs/run1/download"],
    ["POST", "/api/v1/run-groups/g1/synthesize-findings"],
    ["GET", "/api/v1/projects/acme/findings"],
    ["POST", "/api/v1/findings/f1/accept"],
  ] as const) {
    assert.equal(has(method, path), true, `${method} ${path} must be routed`);
  }
});
