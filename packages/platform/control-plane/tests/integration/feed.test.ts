// §4a long-poll wakeups: a held feed request returns as soon as an event lands
// (the post-commit in-process signal, not the full wait), and the waker itself
// resolves on that signal.
import test from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./helpers.ts";
import { emitPlatformEvent } from "../../src/events/outbox.ts";

test("feed waker resolves on a wake signal well before its timeout", async () => {
  await withApp(async ({ app }: HostedDynamic) => {
    assert.equal(app.ctx.feedWaker.connected, true, "the waker is live");
    const t0 = Date.now();
    const held = app.ctx.feedWaker.wait("some-project", 8000);
    setTimeout(() => app.ctx.feedWaker.notify("some-project"), 100);
    await held;
    assert.ok(Date.now() - t0 < 4000, `woke in ${Date.now() - t0}ms, expected a signal wake, not the timeout`);
  });
});

test("a rolled-back transaction wakes nobody", async () => {
  await withApp(async ({ app }: HostedDynamic) => {
    const project = (await app.db.query("INSERT INTO projects (id, key, name) VALUES ($1, 'rb', 'RB') RETURNING id",
      [(await import("../../src/ulid.ts")).ulid()])).rows[0];
    let woke = false;
    const held = app.ctx.feedWaker.wait(project.id, 700).then(() => { woke = true; });
    await app.db.withTx(async (tx: HostedDynamic) => {
      await emitPlatformEvent(tx, { projectId: project.id, type: "run.status", entity: {}, payload: {} });
      throw new Error("rollback");
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(woke, false, "no signal is delivered for an event that never committed");
    assert.equal((await app.db.query("SELECT COUNT(*) AS c FROM platform_events")).rows[0].c, 0);
    await held;
  });
});

test("held /events/feed request is woken by an event insert", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "feedwake", name: "Feed Wake" })).body;
    const tail = (await api.get("/projects/feedwake/events/feed")).body;

    const t0 = Date.now();
    const held = api.get(`/projects/feedwake/events/feed?after=${tail.cursor}&wait=20`);
    setTimeout(() => {
      emitPlatformEvent(app.db, {
        projectId: project.id,
        type: "run.status",
        entity: { run_group_id: "g-test" },
        payload: { status: "queued" },
      }).catch(() => {});
    }, 200);

    const res = await held;
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 200);
    assert.equal(res.body.events.length, 1);
    assert.equal(res.body.events[0].type, "run.status");
    assert.ok(res.body.cursor > tail.cursor, "cursor advanced past the tail");
    assert.ok(elapsed < 10_000, `request held ${elapsed}ms; a 20s wait must be cut short by the event`);
  });
});
