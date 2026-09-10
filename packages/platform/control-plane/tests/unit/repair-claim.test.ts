// The pure half of the repair claim (findings/repair.ts): TTL clamping, the
// heartbeat cadence it implies, the "someone else holds it" predicate, and the
// eligibility SQL the queue and the claim must agree on. No database, no clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REPAIRABLE_STATES,
  REPAIR_OUTCOMES,
  clampTtlSeconds,
  heartbeatIntervalSeconds,
  heldByAnother,
  repairableSql,
} from "../../src/findings/repair.ts";
import { buildRouter } from "../../src/routes.ts";

test("ttl_s is clamped to a lease that is worth taking and short enough to reclaim", () => {
  assert.equal(clampTtlSeconds(600), 600);
  assert.equal(clampTtlSeconds(1), 30);
  assert.equal(clampTtlSeconds(0), 30);
  assert.equal(clampTtlSeconds(-90), 30);
  assert.equal(clampTtlSeconds(99_999), 3600);
  assert.equal(clampTtlSeconds(600.9), 600);
  assert.equal(clampTtlSeconds(undefined), 30);
  assert.equal(clampTtlSeconds("nonsense"), 30);
});

test("the heartbeat interval leaves ten beats inside a lease, and never spins", () => {
  assert.equal(heartbeatIntervalSeconds(600), 60);
  assert.equal(heartbeatIntervalSeconds(3600), 360);
  assert.equal(heartbeatIntervalSeconds(30), 5);
  assert.equal(heartbeatIntervalSeconds(49), 5);
});

test("a claim is another owner's only while it is unexpired", () => {
  const now = 1_000_000;
  const live = { repair_owner: "a", repair_expires_at: new Date(now + 1000) };
  assert.equal(heldByAnother(live, "b", now), true);
  assert.equal(heldByAnother(live, "a", now), false, "the holder may re-claim its own lease");
  assert.equal(heldByAnother({ repair_owner: "a", repair_expires_at: new Date(now - 1) }, "b", now), false);
  assert.equal(heldByAnother({ repair_owner: null, repair_expires_at: null }, "b", now), false);
  assert.equal(heldByAnother({ repair_owner: "a", repair_expires_at: null }, "b", now), false);
});

test("the queue's eligibility rule is the claim's precondition, clause for clause", () => {
  const sql = repairableSql("f");
  assert.match(sql, /f\.merged_into IS NULL/);
  assert.match(sql, /f\.state IN \('new','reopened'\)/);
  assert.match(sql, /f\.repair_outcome = 'none'/);
  assert.match(sql, /f\.repair_expires_at IS NULL OR f\.repair_expires_at < now\(\)/);
  assert.deepEqual([...REPAIRABLE_STATES], ["new", "reopened"]);
  assert.deepEqual([...REPAIR_OUTCOMES], ["suggested", "not_fixed", "needs_owner"]);
});

test("the repair routes are mounted, and nothing else answers under them", () => {
  const router: HostedDynamic = buildRouter();
  const routed = (method: string, path: string) => {
    const match = router.match(method, path);
    return match != null && !match.methodNotAllowed;
  };
  for (const path of [
    "/api/v1/findings/f1/repair-claim",
    "/api/v1/findings/f1/repair-claim/heartbeat",
    "/api/v1/findings/f1/repair-claim/release",
    "/api/v1/findings/f1/repair-outcome/reset",
    "/api/v1/findings/f1/notes",
  ]) {
    assert.equal(routed("POST", path), true, `POST ${path} must be routed`);
    assert.equal(routed("GET", path), false, `GET ${path} must not be routed`);
  }
});
