import test from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./helpers.ts";
import { ulid } from "../../src/ulid.ts";

test("Findings search covers the whole bucket, matches literal text, and agrees with export", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "search", name: "Search" })).body;
    const other = (await api.post("/projects", { key: "other", name: "Other" })).body;
    const ids: string[] = [];
    for (let i = 0; i < 103; i++) {
      const id = ulid();
      ids.push(id);
      await app.db.query(
        `INSERT INTO findings (id, project_id, fingerprint, title, severity, state, last_seen, summary, external_ref)
         VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8)`,
        [id, project.id, i === 0 ? "Checkout loses 50%_ discount" : `Finding ${i}`,
          i < 2 ? "major" : "minor", i === 1 ? "accepted" : "new",
          new Date(1_700_000_000_000 + i * 1000),
          JSON.stringify(i === 0 ? { story_id: "checkout", claim: { expected: "Total retains discount", observed: "Invoice resets" } }
            : i === 1 ? { auto_resolve: { suggested: { reason: "Checkout passed" } } } : {}),
          i === 0 ? "SHOP-123" : null],
      );
    }
    await app.db.query(
      `INSERT INTO findings (id, project_id, fingerprint, title, severity, state) VALUES ($1, $2, $1, 'Checkout loses discount', 'major', 'new')`,
      [ulid(), other.id],
    );
    const get = async (query: string) => {
      const result = await api.get(`/projects/search/findings?${query}`);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    };
    const first = await get("state=new&limit=100");
    assert.equal(first.total, 102);
    assert.equal(first.items.length, 100);
    assert.ok(!first.items.some((f: HostedDynamic) => f.id === ids[0]));
    for (const q of ["CHECKOUT", "50%_", "invoice", "retains discount", "shop-123", ids[0]!]) {
      const found = await get(`state=new&severity=major&q=${encodeURIComponent(q)}`);
      assert.deepEqual(found.items.map((f: HostedDynamic) => f.id), [ids[0]], q);
      assert.equal(found.total, 1);
    }
    assert.equal((await get("state=new&q=does-not-exist")).total, 0);
    assert.equal((await get("state=new&severity=minor&q=checkout")).total, 0);
    const review = await get("state=new&include_fix_suggested=1&severity=major");
    assert.deepEqual(review.items.map((f: HostedDynamic) => f.id).sort(), ids.slice(0, 2).sort());
    const exported = await api.get("/projects/search/findings/export?state=new&include_fix_suggested=1&severity=major&format=json");
    assert.equal(exported.status, 200);
    assert.deepEqual(exported.body.findings.map((f: HostedDynamic) => f.id).sort(), ids.slice(0, 2).sort());
    const searchedExport = await api.get("/projects/search/findings/export?state=new&q=INVOICE&format=json");
    assert.deepEqual(searchedExport.body.findings.map((f: HostedDynamic) => f.id), [ids[0]]);
    assert.equal(searchedExport.body.scope.search, "INVOICE");
    assert.equal((await api.get(`/projects/search/findings?q=${"x".repeat(301)}`)).status, 400);
    assert.equal((await api.get("/projects/search/findings?state=,,")).status, 400);
    assert.equal((await api.get("/projects/search/findings?cursor=v1.invalid")).status, 400);

    // Recurrence changes last_seen independently of creation order.
    await app.db.query("UPDATE findings SET last_seen = $2 WHERE id = $1", [ids[0], new Date(1_800_000_000_000)]);
    const seen: string[] = [];
    let cursor = "";
    do {
      const result = await get(`state=new&limit=17${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...result.items.map((f: HostedDynamic) => f.id));
      cursor = result.next_cursor;
      if (seen.length === 17) {
        await app.db.query("UPDATE findings SET last_seen = $2 WHERE id = $1", [result.items.at(-1).id, new Date(1_900_000_000_000)]);
      }
    } while (cursor);
    assert.equal(seen[0], ids[0]);
    assert.equal(seen.length, 102);
    assert.equal(new Set(seen).size, 102);
    assert.deepEqual(new Set(seen), new Set(ids.filter((_, i) => i !== 1)));
  });
});
