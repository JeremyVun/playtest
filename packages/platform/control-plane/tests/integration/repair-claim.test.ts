// The repair-claim protocol over HTTP: codes, bodies, roles, events, and the
// queue an external repairer polls (docs/contracts/hosted-findings.md,
// "Repair claims").
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./helpers.ts";
import { ulid } from "../../src/ulid.ts";

/** A `new` finding, inserted directly: repair cares about the row, not the run. */
async function seedFinding(app: HostedDynamic, projectId: string, over: HostedDynamic = {}) {
  const id = ulid();
  await app.db.query(
    `INSERT INTO findings (id, project_id, fingerprint, title, severity, state)
       VALUES ($1, $2, $3, $4, 'major', $5)`,
    [id, projectId, `fp-${id}`, over.title ?? "the board never loads", over.state ?? "new"],
  );
  return id;
}

async function eventsOf(app: HostedDynamic, type: string) {
  const { rows } = await app.db.query(
    `SELECT type, entity, payload FROM platform_events WHERE type = $1 ORDER BY id`,
    [type],
  );
  return rows;
}

const claimBody = { owner: "hillclimb@mini", ttl_s: 600 };

test("a repair claim is exclusive, renewable by its holder, and expires into the queue", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "rp", name: "Repair" })).body;
    const finding = await seedFinding(app, project.id);

    const claim = await api.post(`/findings/${finding}/repair-claim`, claimBody);
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    assert.equal(claim.body.finding_id, finding);
    assert.equal(claim.body.owner, "hillclimb@mini");
    assert.equal(claim.body.generation, 1);
    assert.equal(claim.body.heartbeat_interval_s, 60);
    assert.ok(Date.parse(claim.body.expires_at) > Date.now());

    const rival = await api.post(`/findings/${finding}/repair-claim`, { owner: "someone@else", ttl_s: 600 });
    assert.equal(rival.status, 409, JSON.stringify(rival.body));
    assert.equal(rival.body.error.code, "conflict");
    assert.equal(rival.body.error.details.reason, "claimed");
    assert.equal(rival.body.error.details.owner, "hillclimb@mini");
    assert.equal(new Date(rival.body.error.details.expires_at).toISOString(), new Date(claim.body.expires_at).toISOString());

    const stale = await api.post(`/findings/${finding}/repair-claim/heartbeat`, { owner: "hillclimb@mini", generation: 99, ttl_s: 600 });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    const wrongOwner = await api.post(`/findings/${finding}/repair-claim/heartbeat`, { owner: "someone@else", generation: 1, ttl_s: 600 });
    assert.equal(wrongOwner.status, 409);

    const beat = await api.post(`/findings/${finding}/repair-claim/heartbeat`, { owner: "hillclimb@mini", generation: 1, ttl_s: 600 });
    assert.equal(beat.status, 200, JSON.stringify(beat.body));
    assert.equal(beat.body.generation, 1);

    // The daemon died: the lease runs out and the finding is anyone's again.
    await app.db.query(`UPDATE findings SET repair_expires_at = now() - interval '1 second' WHERE id = $1`, [finding]);
    const late = await api.post(`/findings/${finding}/repair-claim/release`, { owner: "hillclimb@mini", generation: 1, outcome: "not_fixed" });
    assert.equal(late.status, 409, JSON.stringify(late.body));

    const successor = await api.post(`/findings/${finding}/repair-claim`, { owner: "someone@else", ttl_s: 600 });
    assert.equal(successor.status, 200, JSON.stringify(successor.body));
    assert.equal(successor.body.generation, 2);
  });
});

test("ttl_s is clamped, and the heartbeat cadence follows the lease it granted", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "rp", name: "Repair" })).body;
    const short = await api.post(`/findings/${await seedFinding(app, project.id)}/repair-claim`, { owner: "d", ttl_s: 1 });
    assert.equal(short.body.heartbeat_interval_s, 5);
    const long = await api.post(`/findings/${await seedFinding(app, project.id)}/repair-claim`, { owner: "d", ttl_s: 100_000 });
    assert.equal(long.body.heartbeat_interval_s, 360);
    const missing = await api.post(`/findings/${await seedFinding(app, project.id)}/repair-claim`, { owner: "d" });
    assert.equal(missing.body.heartbeat_interval_s, 5);
    const anonymous = await api.post(`/findings/${await seedFinding(app, project.id)}/repair-claim`, { ttl_s: 600 });
    assert.equal(anonymous.status, 400);
  });
});

test("releasing as suggested needs the pull request, and announces it as a repair suggestion", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "rp", name: "Repair" })).body;
    const finding = await seedFinding(app, project.id);
    await api.post(`/findings/${finding}/repair-claim`, claimBody);

    const unlinked = await api.post(`/findings/${finding}/repair-claim/release`, { owner: "hillclimb@mini", generation: 1, outcome: "suggested" });
    assert.equal(unlinked.status, 400, JSON.stringify(unlinked.body));
    assert.match(unlinked.body.error.message, /external_ref/);

    const bogus = await api.post(`/findings/${finding}/repair-claim/release`, { owner: "hillclimb@mini", generation: 1, outcome: "shipped" });
    assert.equal(bogus.status, 400);

    const ref = "https://github.com/acme/app/pull/7";
    const done = await api.post(`/findings/${finding}/repair-claim/release`, {
      owner: "hillclimb@mini", generation: 1, outcome: "suggested", external_ref: ref, note: "one line changed",
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.finding.repair_outcome, "suggested");
    assert.equal(done.body.finding.repair_owner, null);
    assert.equal(done.body.finding.external_ref, ref);

    const [event] = await eventsOf(app, "finding.repair_suggested");
    assert.deepEqual(event.entity, { finding_id: finding });
    assert.deepEqual(event.payload, {
      finding_id: finding, owner: "hillclimb@mini", generation: 1, outcome: "suggested", source: "repair", external_ref: ref,
    });
    assert.equal((await eventsOf(app, "finding.repair_released")).length, 0);

    // The release's note rides along as a finding note.
    const detail = await api.get(`/findings/${finding}`);
    assert.equal(detail.body.notes.length, 1);
    assert.equal(detail.body.notes[0].source, "repair");
    assert.equal(detail.body.notes[0].text, "one line changed");

    const { rows } = await app.db.query(`SELECT action FROM audit_log WHERE action = 'finding.repair_released'`);
    assert.equal(rows.length, 1, "every release is audited, suggestion or not");
  });
});

test("releasing without a fix announces a plain release and takes the finding out of the queue", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "rp", name: "Repair" })).body;
    const finding = await seedFinding(app, project.id);
    await api.post(`/findings/${finding}/repair-claim`, claimBody);
    const done = await api.post(`/findings/${finding}/repair-claim/release`, { owner: "hillclimb@mini", generation: 1, outcome: "not_fixed" });
    assert.equal(done.status, 200, JSON.stringify(done.body));

    const [event] = await eventsOf(app, "finding.repair_released");
    assert.deepEqual(event.payload, {
      finding_id: finding, owner: "hillclimb@mini", generation: 1, outcome: "not_fixed", source: "repair",
    });
    assert.equal((await eventsOf(app, "finding.repair_suggested")).length, 0);

    const requeue = await api.post(`/findings/${finding}/repair-claim`, { owner: "hillclimb@mini", ttl_s: 600 });
    assert.equal(requeue.status, 409);
    assert.equal(requeue.body.error.details.reason, "outcome");

    const reset = await api.post(`/findings/${finding}/repair-outcome/reset`, {});
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.finding.repair_outcome, "none");
    const [resetEvent] = await eventsOf(app, "finding.repair_reset");
    assert.equal(resetEvent.payload.finding_id, finding);
    assert.equal(resetEvent.payload.from, "not_fixed");
    assert.equal((await api.post(`/findings/${finding}/repair-claim`, claimBody)).status, 200);
  });
});

test("reopening a finding hands it back to repair, claim and outcome cleared", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "rp", name: "Repair" })).body;
    const finding = await seedFinding(app, project.id, { state: "resolved" });
    await app.db.query(`UPDATE findings SET repair_owner = 'gone', repair_generation = 4,
      repair_expires_at = now() + interval '1 hour', repair_outcome = 'needs_owner' WHERE id = $1`, [finding]);

    const reopened = await api.post(`/findings/${finding}/reopen`, {});
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    assert.equal(reopened.body.state, "reopened");
    assert.equal(reopened.body.repair_outcome, "none");
    assert.equal(reopened.body.repair_owner, null);
    assert.equal(reopened.body.repair_expires_at, null);
    assert.equal(reopened.body.repair_generation, 4, "the generation only ever climbs, so old beats stay stale");

    const claim = await api.post(`/findings/${finding}/repair-claim`, claimBody);
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    assert.equal(claim.body.generation, 5);
  });
});

test("the repairable queue lists only what a claim would accept", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "rp", name: "Repair" })).body;
    const free = await seedFinding(app, project.id, { title: "free" });
    const reopened = await seedFinding(app, project.id, { title: "reopened", state: "reopened" });
    const accepted = await seedFinding(app, project.id, { title: "accepted", state: "accepted" });
    const claimed = await seedFinding(app, project.id, { title: "claimed" });
    const concluded = await seedFinding(app, project.id, { title: "concluded" });

    await api.post(`/findings/${claimed}/repair-claim`, claimBody);
    await api.post(`/findings/${concluded}/repair-claim`, claimBody);
    await api.post(`/findings/${concluded}/repair-claim/release`, { owner: "hillclimb@mini", generation: 1, outcome: "needs_owner" });

    const queue = await api.get(`/projects/rp/findings?repairable=1&state=all`);
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    const ids = queue.body.items.map((f: HostedDynamic) => f.id);
    assert.deepEqual(ids.slice().sort(), [free, reopened].sort());
    assert.equal(queue.body.total, 2);
    assert.ok(![accepted, claimed, concluded].some((id) => ids.includes(id)));

    // The lease runs out; the finding returns to the queue on its own.
    await app.db.query(`UPDATE findings SET repair_expires_at = now() - interval '1 second' WHERE id = $1`, [claimed]);
    const later = await api.get(`/projects/rp/findings?repairable=1&state=all`);
    assert.ok(later.body.items.map((f: HostedDynamic) => f.id).includes(claimed));

    // Every finding view carries the repair columns, so a daemon reads state once.
    const detail = await api.get(`/findings/${concluded}`);
    assert.equal(detail.body.repair_outcome, "needs_owner");
    assert.equal(detail.body.repair_generation, 1);
    assert.equal(detail.body.repair_owner, null);
  });
});

test("a note attaches a duplicate report to a finding without run evidence", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "rp", name: "Repair" })).body;
    const finding = await seedFinding(app, project.id);

    const added = await api.post(`/findings/${finding}/notes`, { text: "same report again from feedback 0192", source: "hillclimb-triage" });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.note.source, "hillclimb-triage");
    assert.equal(added.body.note.finding_id, finding);

    const [event] = await eventsOf(app, "finding.note_added");
    assert.equal(event.payload.note.text, "same report again from feedback 0192");

    const detail = await api.get(`/findings/${finding}`);
    assert.deepEqual(detail.body.notes.map((n: HostedDynamic) => n.text), ["same report again from feedback 0192"]);

    assert.equal((await api.post(`/findings/${finding}/notes`, { source: "x" })).status, 400);
    const long = await api.post(`/findings/${finding}/notes`, { text: "x".repeat(4097), source: "x" });
    assert.equal(long.status, 400, JSON.stringify(long.body));
  });
});

test("claim and release need developer; resetting an outcome needs reviewer; a note needs editor", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "rp", name: "Repair" })).body;
    const finding = await seedFinding(app, project.id);
    const asRole = async (role: string) =>
      api.withToken((await api.post(`/projects/rp/tokens`, { role, name: role })).body.token);
    const viewer = await asRole("viewer");
    const editor = await asRole("editor");
    const reviewer = await asRole("reviewer");
    const developer = await asRole("developer");

    assert.equal((await reviewer.post(`/findings/${finding}/repair-claim`, claimBody)).status, 403);
    assert.equal((await viewer.post(`/findings/${finding}/notes`, { text: "hi", source: "x" })).status, 403);
    assert.equal((await editor.post(`/findings/${finding}/notes`, { text: "hi", source: "x" })).status, 201);

    const claim = await developer.post(`/findings/${finding}/repair-claim`, claimBody);
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    assert.equal(
      (await developer.post(`/findings/${finding}/repair-claim/release`, { owner: claimBody.owner, generation: 1, outcome: "needs_owner" })).status,
      200,
    );
    assert.equal((await editor.post(`/findings/${finding}/repair-outcome/reset`, {})).status, 403);
    assert.equal((await reviewer.post(`/findings/${finding}/repair-outcome/reset`, {})).status, 200);
  });
});
