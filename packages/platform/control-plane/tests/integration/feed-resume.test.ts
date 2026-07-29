// Cursor-feed resume semantics — the properties a real
// dashboard client leans on when its connection to GET /events/feed dies and it
// has to reconnect with whatever cursor it last durably observed. Complements the
// shallow wake-up coverage in feed.test.ts (do not duplicate it): this file pins
// gap-free/duplicate-free pagination across a killed request, cursor durability
// across a server process restart, fresh-subscriber seeding, the types-filter/
// cursor interplay, and the short-hold-returns-promptly bound.
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withApp, makeClient } from "./helpers.ts";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/app.ts";
import { emitPlatformEvent } from "../../src/events/outbox.ts";

/** GET the feed with an explicit query string, bypassing the plain api client so
 * we can attach an AbortSignal for the "killed mid-flight" scenario. */
function feedUrl(base: HostedDynamic, projectKey: HostedDynamic, { after = "", wait = 0, types = [] } = {}) {
  const q = new URLSearchParams();
  if (after) q.set("after", after);
  if (wait) q.set("wait", String(wait));
  if (types.length) q.set("types", types.join(","));
  return `${base}/api/v1/projects/${projectKey}/events/feed?${q.toString()}`;
}

async function feedGet(api: HostedDynamic, projectKey: HostedDynamic, opts: HostedDynamic) {
  const q = new URLSearchParams();
  if (opts?.after) q.set("after", opts.after);
  if (opts?.wait) q.set("wait", String(opts.wait));
  if (opts?.types?.length) q.set("types", opts.types.join(","));
  const r = await api.get(`/projects/${projectKey}/events/feed?${q.toString()}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

function ids(events: HostedDynamic) {
  return events.map((e: HostedDynamic) => e.id);
}

function assertStrictlyIncreasing(idList: HostedDynamic) {
  for (let i = 1; i < idList.length; i++) {
    assert.ok(idList[i] > idList[i - 1], `ids must be strictly increasing, got ${idList[i - 1]} then ${idList[i]}`);
  }
}

test("gap-free pagination across a killed long-poll: reconnect with the last processed cursor loses nothing, duplicates nothing", async () => {
  await withApp(async ({ base, app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "resume1", name: "Resume One" })).body;

    // Fresh subscriber: seeds a cursor at the (empty) tail.
    const seed = await feedGet(api, "resume1", {});
    assert.equal(seed.events.length, 0);

    // Emit 10 events up front.
    const emitted: HostedDynamic[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await emitPlatformEvent(app.db, {
        projectId: project.id,
        type: "run.status",
        entity: { run_group_id: `g-${i}` },
        payload: { i },
      });
      emitted.push(id);
    }
    assertStrictlyIncreasing(emitted);

    // Simulate a client that only durably processed the first 3 of a batch (e.g.
    // it rendered them and persisted its cursor, then died) before requerying.
    let page = await feedGet(api, "resume1", { after: seed.cursor });
    assert.equal(page.events.length, 10, "all 10 land in one page (well under the 200 LIMIT)");
    assertStrictlyIncreasing(ids(page.events));
    const processedCursor = page.events[2].id; // pretend only the first 3 were durably applied

    // Requerying from that earlier cursor must replay the remaining 7 exactly,
    // no gap and no duplicate of the first 3.
    const replay = await feedGet(api, "resume1", { after: processedCursor });
    assert.deepEqual(ids(replay.events), emitted.slice(3), "replay from an earlier cursor is gap-free and dup-free");

    const lastCursor = replay.cursor;
    assert.equal(lastCursor, emitted.at(-1));

    // Now the "kill mid-flight" scenario: a long-poll is in flight (wait=10s) when
    // the tab/gateway dies. The client never received a response, so it still only
    // holds `lastCursor` — the cursor from *before* the held request, not anything
    // newer. Two events land while the poll is (from the server's point of view)
    // still open; we abort the client side of the request to simulate the kill,
    // then reconnect from `lastCursor` and must see exactly those two events once.
    const controller = new AbortController();
    const held = fetch(feedUrl(base, "resume1", { after: lastCursor, wait: 10 }), {
      signal: controller.signal,
    }).catch((e) => e);
    controller.abort();
    const abortedResult = await held;
    assert.ok(
      abortedResult instanceof Error && abortedResult.name === "AbortError",
      `expected the held request to be aborted client-side, got ${abortedResult}`,
    );

    const duringOutage: HostedDynamic[] = [];
    for (let i = 0; i < 2; i++) {
      duringOutage.push(
        await emitPlatformEvent(app.db, {
          projectId: project.id,
          type: "run.status",
          entity: { run_group_id: `outage-${i}` },
          payload: { i },
        }),
      );
    }

    const resumed = await feedGet(api, "resume1", { after: lastCursor, wait: 5 });
    assert.deepEqual(ids(resumed.events), duringOutage, "reconnect from the pre-kill cursor sees the outage events exactly once");
    assertStrictlyIncreasing([lastCursor, ...ids(resumed.events)]);
  });
});

test("consumer restart: every event committed while the consumer was dead is recovered from its cursor, in order, exactly once", async () => {
  // The restart-safety claim in full. A control-plane process is stopped and a
  // brand-new one is booted on the same data root; the consumer that reconnects
  // holds nothing but the cursor it last durably processed, and every wake signal
  // from the old process died with it. Only committed rows + cursor can bridge
  // the gap, which is exactly the contract (hosted.md, "Events and long polling").
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ptdata-resume-"));
  const envBase = {
    PLAYTEST_DATA_DIR: dataRoot,
    PLAYTEST_AUTH: "dev",
    OBJECT_STORE_URL: path.join(dataRoot, "objects"),
    PLAYTEST_KMS_KEY: Buffer.alloc(32, 3).toString("base64"),
    LOG_LEVEL: "error",
    PLAYTEST_RATE_LIMIT_WRITES_PER_MIN: "0",
    PLAYTEST_RECONCILE_INTERVAL_S: "0",
  };
  const boot = async () => {
    const app = await createApp(loadConfig(envBase));
    const addr: HostedDynamic = await app.listen(0, "127.0.0.1");
    return { app, api: makeClient(`http://127.0.0.1:${addr.port}`) };
  };

  let live: HostedDynamic = null;
  try {
    // --- Process #1: the consumer subscribes and processes part of the stream.
    live = await boot();
    const project = (await live.api.post("/projects", { key: "resume2", name: "Resume Two" })).body;

    const preRestart: HostedDynamic[] = [];
    for (let i = 0; i < 6; i++) {
      preRestart.push(
        await emitPlatformEvent(live.app.db, {
          projectId: project.id,
          type: "run.status",
          entity: { run_group_id: `pre-${i}` },
          payload: { i },
        }),
      );
    }
    const firstBatch = await feedGet(live.api, "resume2", { after: "" });
    assert.equal(firstBatch.events.length, 0, "a fresh subscriber seeds at the tail");

    // The consumer durably processes only the first three, then dies.
    const seen: HostedDynamic[] = [];
    const page = await feedGet(live.api, "resume2", { after: preRestart[0] });
    assert.deepEqual(ids(page.events), preRestart.slice(1));
    seen.push(preRestart[0], ...ids(page.events).slice(0, 2));
    const capturedCursor = seen.at(-1); // = preRestart[2]
    assert.equal(capturedCursor, preRestart[2]);

    // --- Kill the process. Every in-memory waiter and every pending wake signal
    // goes with it; nothing about the stream survives except the SQLite rows.
    await live.app.close();
    live = null;

    // --- Process #2, same data root: a fresh boot, e.g. after a deploy.
    live = await boot();
    assert.equal(live.app.ctx.feedWaker.connected, true);

    const postRestart: HostedDynamic[] = [];
    for (let i = 0; i < 4; i++) {
      postRestart.push(
        await emitPlatformEvent(live.app.db, {
          projectId: project.id,
          type: "run.status",
          entity: { run_group_id: `post-${i}` },
          payload: { i },
        }),
      );
    }

    // The consumer reconnects with its pre-restart cursor and drains the feed the
    // way the real client loop does — repeatedly, until a poll comes back empty.
    const recovered: HostedDynamic[] = [];
    let cursor = capturedCursor;
    for (let guard = 0; guard < 10; guard++) {
      const batch = await feedGet(live.api, "resume2", { after: cursor });
      if (!batch.events.length) break;
      recovered.push(...ids(batch.events));
      cursor = batch.cursor;
    }

    const expected = [...preRestart.slice(3), ...postRestart];
    assert.deepEqual(recovered, expected, "every event committed while the consumer was gone is recovered, in order");
    assert.equal(new Set(recovered).size, recovered.length, "and exactly once");
    assertStrictlyIncreasing([capturedCursor, ...recovered]);
    assert.equal(new Set([...seen, ...recovered]).size, preRestart.length + postRestart.length,
      "the union of pre-death and post-restart delivery is the whole committed stream, with no overlap");
  } finally {
    if (live) await live.app.close();
    await fsp.rm(dataRoot, { recursive: true, force: true });
  }
});

test("fresh subscriber with empty `after` sees no history but its cursor observes subsequent events", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "resume3", name: "Resume Three" })).body;

    // Seed some history before the "fresh subscriber" ever connects.
    for (let i = 0; i < 3; i++) {
      await emitPlatformEvent(app.db, {
        projectId: project.id,
        type: "run.status",
        entity: { run_group_id: `hist-${i}` },
        payload: { i },
      });
    }

    const fresh = await feedGet(api, "resume3", {});
    assert.equal(fresh.events.length, 0, "a fresh subscriber (empty after) never sees pre-existing history");
    assert.ok(fresh.cursor, "fresh subscriber still gets a usable cursor (seeded at the tail)");

    const next = await emitPlatformEvent(app.db, {
      projectId: project.id,
      type: "run.status",
      entity: { run_group_id: "new-1" },
      payload: {},
    });

    const after = await feedGet(api, "resume3", { after: fresh.cursor });
    assert.deepEqual(ids(after.events), [next], "events emitted after the fresh subscriber's seeded cursor are visible");
  });
});

test("types filter + cursor interplay: a filtered read's cursor can silently skip unfiltered event types for a later broadened read (pinned §4a behavior)", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "resume4", name: "Resume Four" })).body;

    const seed = await feedGet(api, "resume4", {});

    const a1 = await emitPlatformEvent(app.db, { projectId: project.id, type: "run.status", entity: {}, payload: {} });
    const b1 = await emitPlatformEvent(app.db, { projectId: project.id, type: "candidate.created", entity: {}, payload: {} });
    const a2 = await emitPlatformEvent(app.db, { projectId: project.id, type: "run.status", entity: {}, payload: {} });

    const filtered = await feedGet(api, "resume4", { after: seed.cursor, types: ["run.status"] });
    assert.deepEqual(ids(filtered.events), [a1, a2], "filtered read returns only the matching type");
    // Pinned behavior: `cursor` is computed from `rows.at(-1)` of the *filtered*
    // result set (runs.js feed(): `const cursor = rows.at(-1)?.id ?? after`), so it
    // lands on a2 — the last matching row — even though b1 (an unfiltered-only
    // event) sits between a1 and a2 in id order and was never returned. A client
    // that later broadens its type filter and resumes from this cursor will NOT
    // get b1 replayed — it is permanently skipped for that client's history. This
    // is a real gap for any client that changes its type filter mid-lifetime of a
    // single cursor; see the feed-resume contract for detail.
    assert.equal(filtered.cursor, a2, "cursor lands on the last row visible to the filtered query, not the true tail");

    const broadened = await feedGet(api, "resume4", { after: filtered.cursor });
    assert.deepEqual(ids(broadened.events), [], "b1 (between a1 and a2) is never replayed once a filtered cursor has passed it");

    // Whereas an unfiltered read from the original seed cursor sees all three, in order.
    const everything = await feedGet(api, "resume4", { after: seed.cursor });
    assert.deepEqual(ids(everything.events), [a1, b1, a2]);
  });
});

test("a short hold with no events returns promptly with an empty batch and an unchanged cursor", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "resume5", name: "Resume Five" });
    const seed = await feedGet(api, "resume5", {});

    const t0 = Date.now();
    const held = await feedGet(api, "resume5", { after: seed.cursor, wait: 2 });
    const elapsed = Date.now() - t0;

    assert.equal(held.events.length, 0);
    assert.equal(held.cursor, seed.cursor, "no events landed, so the cursor does not move");
    assert.ok(elapsed >= 1500 && elapsed <= 10_000, `expected ~2s hold, got ${elapsed}ms`);
  });
});
