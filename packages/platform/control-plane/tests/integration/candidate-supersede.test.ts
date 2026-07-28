// A clean pass supersedes the story's pending heal candidates
// (docs/contracts/hosted.md#bundles-viewer-and-review): the run just proved the
// current baseline still replays, so the pending "changed — passed after
// healing" decision no longer exists. Needs-attention and the review queue must
// stop showing it, and candidate.superseded must fire so badges re-count.
import test from "node:test";
import assert from "node:assert/strict";
import { withApp, createTarget } from "./helpers.ts";
import { ulid } from "../../src/ulid.ts";
import { claimAndExchange } from "./exec-helpers.ts";

test("a clean pass supersedes the story's pending candidates, and only that story's", async () => {
  await withApp(async ({ app, api, base }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "supersede", name: "Supersede" })).body;
    const { application, ring } = await createTarget(api, project, {
      ringKey: "staging",
      baseUrl: "http://127.0.0.1:9",
      runnerLabels: ["self-hosted", "playtest"],
    });
    const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "s", name: "S" })).body;
    await api.post(`/suites/${suite.id}/commit`, {
      changes: [
        { path: "playtest.yaml", content: "app:\n  base_url: http://127.0.0.1:9\n" },
        { path: "stories/save.yaml", content: "story: A user saves their work and sees it persist.\n" },
      ],
      note: "seed",
    });

    const launched = await api.post(`/projects/${project.key}/run-groups`, {
      suite_id: suite.id,
      ring_id: ring.id,
      selection: { ids: ["save"], mode: "auto" },
    });
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    const groupId = launched.body.run_group.id;
    const runRow = (await app.db.query(`SELECT id, story_id FROM runs WHERE run_group_id = $1`, [groupId])).rows[0];

    // Two pending heal candidates from earlier healed runs: one for this story,
    // one for an unrelated story that must stay pending (supersede is scoped).
    const snapshot = (await api.get(`/suites/${suite.id}/snapshots`)).body.items[0];
    const seed = { project, suite, application, ring, snapshot };
    const stale = await seedCandidate(app, { ...seed, storyId: runRow.story_id });
    const other = await seedCandidate(app, { ...seed, storyId: "other-story" });
    let health = await api.get(`/projects/${project.key}/health`);
    assert.equal(health.body.attention.filter((a: HostedDynamic) => a.kind === "changed").length, 2);

    const { headers: runnerHeaders } = await claimAndExchange(api, base, {
      project,
      groupId,
      labels: ["self-hosted", "playtest"],
    });
    const spec = await fetch(`${base}/api/v1/runner/groups/${groupId}`, { headers: runnerHeaders }).then((r) => r.json());
    const run: HostedDynamic = spec.cases[0];
    await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${run.run_id}/start`, {
      method: "POST", headers: runnerHeaders, body: "{}",
    });
    const upload = await fetch(`${base}/api/v1/runner/runs/${run.db_id}/bundle`, {
      method: "PUT",
      headers: { authorization: runnerHeaders.authorization, "content-type": "application/vnd.playtest.run-bundle" },
      body: Buffer.from("fake bundle"),
    }).then((r) => r.json());
    // A clean pass: no heal, no change, no baseline or candidate written.
    const reported = await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${run.run_id}/report`, {
      method: "POST",
      headers: runnerHeaders,
      body: JSON.stringify({
        status: "pass",
        bundle: upload.artifact,
        manifest: {
          run_id: run.run_id,
          case: { id: "save" },
          result: { status: "pass", end_reason: "done" },
          status: "pass",
          duration_ms: 123,
          totals: { in: 0, out: 0 },
        },
      }),
    });
    assert.equal(reported.status, 200);

    const statuses = new Map(
      (await app.db.query(`SELECT id, status FROM candidates WHERE project_id = $1`, [project.id]))
        .rows.map((r: HostedDynamic) => [r.id, r.status]),
    );
    assert.equal(statuses.get(stale), "superseded", "the clean pass retires the story's pending candidate");
    assert.equal(statuses.get(other), "pending", "an unrelated story's candidate is untouched");

    health = await api.get(`/projects/${project.key}/health`);
    const changed = health.body.attention.filter((a: HostedDynamic) => a.kind === "changed");
    assert.equal(changed.length, 1, "needs-attention keeps only the still-live changed row");
    assert.equal(changed[0].candidate_id, other);

    const feed = await api.get(
      `/projects/${project.key}/events/feed?after=00000000000000000000000000&types=candidate.superseded`,
    );
    const event = feed.body.items.find((e: HostedDynamic) => e.type === "candidate.superseded");
    assert.ok(event, "candidate.superseded fired so review badges re-count");
    assert.deepEqual(event.payload.candidate_ids, [stale]);
  });
});

async function seedCandidate(app: HostedDynamic, { project, suite, application, ring, snapshot, storyId }: HostedDynamic) {
  const id = ulid();
  const groupId = ulid();
  const runId = ulid();
  await app.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(
      `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, application_id, ring_id, trigger, selection, status)
         VALUES ($1, $2, $3, $4, $5, $6, '{}', '{}', 'done')`,
      [groupId, project.id, suite.id, snapshot.id, application.id, ring.id],
    );
    await tx.query(
      `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode, healed, changed, finished_at)
         VALUES ($1, $2, $3, $4, $5, 'pass', 'heal', 1, 1, $6)`,
      [runId, groupId, storyId, storyId, `${storyId}-${ulid().slice(-8)}`, new Date(Date.now() - 60_000)],
    );
    await tx.query(
      `INSERT INTO candidates (id, project_id, suite_id, story_id, run_id, trajectory_key, meta, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [id, project.id, suite.id, storyId, runId, `baselines/${suite.id}/${storyId}/v1.jsonl`, { steps: 3 }],
    );
  });
  return id;
}

