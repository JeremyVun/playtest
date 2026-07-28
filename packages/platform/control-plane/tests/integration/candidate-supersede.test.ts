// A clean pass supersedes the story's pending heal candidates
// (docs/contracts/hosted.md#bundles-viewer-and-review): the run just proved the
// current baseline still replays, so the pending "changed — passed after
// healing" decision no longer exists. Needs-attention and the review queue must
// stop showing it, and candidate.superseded must fire so badges re-count.
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeBundle } from "@playtest/core/artifacts";
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

// ------------------------------------------------------- gate 14: reviews
//
// DESIGN.md gate 14: a TARGET-FREE suite — one that authors no `base_url`
// anywhere, because the ring supplies the URL at launch — must work across every
// hosted verb, reviews included. Reviews are the clause with teeth: accepting a
// candidate re-resolves the suite to check the story still exists
// (`requireStoryStillExists` → `resolveCases`, src/suites/resolve.ts), and that
// read is STRUCTURAL on purpose. A resolver that insisted on a complete physical
// target would turn every review of a hosted-native suite into a 409 "the suite
// no longer validates" — the story is there, only the URL the ring owns is not.
test("gate 14: a target-free suite's candidates read and accept — structural resolution, no physical target", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "gate14", name: "Gate 14" })).body;
    // The ring holds the URL. A ring is not a suite file, so the suite below
    // stays target-free no matter what the ring says.
    const { application, ring } = await createTarget(api, project, {
      ringKey: "staging",
      baseUrl: "http://127.0.0.1:9",
    });
    const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "s", name: "S" })).body;
    const files = [
      // Driver only — no `base_url`, in playtest.yaml or in the story.
      { path: "playtest.yaml", content: "app:\n  driver: web\n" },
      { path: "stories/save.yaml", content: "story: A user saves their work and sees it persist.\n" },
    ];
    const commit = await api.post(`/suites/${suite.id}/commit`, { changes: files, note: "seed" });
    assert.equal(commit.status, 200, JSON.stringify(commit.body));
    assert.ok(
      files.every((f) => !/base_url/.test(f.content)),
      "the fixture is only worth anything if the tree really authors no target",
    );

    // Structural resolution reaches the story at all: this is the case the
    // review path has to find again at accept time.
    const cases = (await api.get(`/suites/${suite.id}/cases`)).body.items;
    assert.equal(cases.length, 1, JSON.stringify(cases));
    const storyId = cases[0].story_id || cases[0].id;

    const snapshot = (await api.get(`/suites/${suite.id}/snapshots`)).body.items[0];
    const candidate = await seedCandidate(app, {
      project, suite, application, ring, snapshot, storyId,
      manifest: { case: { id: storyId }, result: { status: "pass", end_reason: "done" }, status: "pass" },
    });
    const runDbId = (
      await app.db.query(`SELECT run_id FROM candidates WHERE id = $1`, [candidate])
    ).rows[0].run_id;
    await attachRunBundle(app, runDbId, `runs/${project.key}/${runDbId}.ptrun`);

    // The queue reads it: a real candidate, not an error and not a hole where
    // the story should be.
    const got = await api.get(`/candidates/${candidate}`);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.story_id, storyId, "the review queue names the story the target-free suite resolves");
    assert.equal(got.body.status, "pending");

    // …and the review completes. This is the assertion gate 14 was missing: the
    // accept-time re-resolution of a target-free tree succeeds.
    const accepted = await api.post(`/candidates/${candidate}/accept`, {});
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.candidate_id, candidate);
    assert.equal(accepted.body.version, 1);
    const baseline = (
      await app.db.query(`SELECT * FROM baselines WHERE suite_id = $1 AND story_id = $2`, [suite.id, storyId])
    ).rows[0];
    assert.ok(baseline, "the promoted baseline exists");
    assert.equal(baseline.id, accepted.body.baseline_id);

    // The promotion carried no invented target: the suite still authors none,
    // and nothing back-filled the ring's URL into it on the way through.
    const tree = (await app.db.query(`SELECT path, content FROM suite_files WHERE suite_id = $1`, [suite.id])).rows;
    for (const f of tree) {
      assert.doesNotMatch(String(f.content), /base_url/, `${f.path} gained a physical target`);
    }
  });
});

async function seedCandidate(
  app: HostedDynamic,
  { project, suite, application, ring, snapshot, storyId, manifest = null }: HostedDynamic,
) {
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
      `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode, healed, changed, manifest, finished_at)
         VALUES ($1, $2, $3, $4, $5, 'pass', 'heal', 1, 1, $6, $7)`,
      [runId, groupId, storyId, storyId, `${storyId}-${ulid().slice(-8)}`, manifest, new Date(Date.now() - 60_000)],
    );
    await tx.query(
      `INSERT INTO candidates (id, project_id, suite_id, story_id, run_id, trajectory_key, meta, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [id, project.id, suite.id, storyId, runId, `baselines/${suite.id}/${storyId}/v1.jsonl`, { steps: 3 }],
    );
  });
  return id;
}

/**
 * A sealed bundle for a run, carrying the two entries accept checks for before
 * it will promote anything: `manifest.json` and `trajectory.jsonl`.
 */
async function attachRunBundle(app: HostedDynamic, runDbId: HostedDynamic, key: HostedDynamic) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-supersede-bundle-"));
  try {
    const runDir = path.join(tmp, "run");
    await fsp.mkdir(runDir, { recursive: true });
    await fsp.writeFile(path.join(runDir, "manifest.json"), JSON.stringify({ case: { id: "save" } }));
    await fsp.writeFile(path.join(runDir, "trajectory.jsonl"), `${JSON.stringify({ step: 1, mode: "act" })}\n`);
    const out = path.join(tmp, "run.ptrun");
    writeBundle(runDir, out);
    const stored = await app.store.put(key, await fsp.readFile(out));
    await app.db.query(
      `INSERT INTO artifacts (id, run_id, kind, key, sha256, size, tier, verified_at)
         VALUES ($1, $2, 'bundle', $3, $4, $5, 'full', now())`,
      [ulid(), runDbId, key, stored.sha256, stored.size],
    );
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

