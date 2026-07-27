import { test } from "node:test";
import assert from "node:assert/strict";
import { chipStatus } from "../src/lib/labels.js";

test("chipStatus: a healed pass reads as changed, never plain pass", () => {
  assert.equal(chipStatus({ healed: true, status: "pass" }), "changed");
  assert.equal(chipStatus({ healed: false, status: "pass" }), "pass");
  assert.equal(chipStatus({ healed: true, status: "fail" }), "fail");
  assert.equal(chipStatus({ healed: false, status: "running" }), "running");
  assert.equal(chipStatus({ healed: false, status: "queued" }), "running");
  assert.equal(chipStatus({ healed: false, status: "uploading" }), "running");
  assert.equal(chipStatus({ healed: false, status: "canceled" }), "infra");
  assert.equal(chipStatus({ healed: false, status: "lost" }), "infra");
});
