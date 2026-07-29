// Write-route rate limiting end to end: 429 envelope, Retry-After, and reads
// remaining unaffected.
import test from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./helpers.ts";

test("write routes rate-limit per principal with a friendly 429", async () => {
  await withApp(
    async ({ api }: HostedDynamic) => {
      const first: HostedDynamic = await api.post("/projects", { key: "rl", name: "Rate Limit" });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal((await api.post("/projects", { key: "rl2", name: "Two" })).status, 201);
      assert.equal((await api.post("/projects", { key: "rl3", name: "Three" })).status, 201);

      const refused = await api.post("/projects", { key: "rl4", name: "Four" });
      assert.equal(refused.status, 429);
      assert.equal(refused.body.error.code, "rate_limited");
      assert.match(refused.body.error.message, /retry in \d+s/);
      assert.ok(Number(refused.headers.get("retry-after")) >= 1);

      for (let i = 0; i < 10; i++) {
        assert.equal((await api.get("/projects")).status, 200);
      }
    },
    { PLAYTEST_RATE_LIMIT_WRITES_PER_MIN: "60", PLAYTEST_RATE_LIMIT_WRITE_BURST: "3" },
  );
});
