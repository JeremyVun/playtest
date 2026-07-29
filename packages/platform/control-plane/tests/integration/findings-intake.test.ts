// Evidence-complete hosted intake and exact recurrence
// (docs/contracts/hosted.md, "Findings intake").
//
// The finding is the only defect entity: a machine-filed claim lands as a
// finding in state `new`, and the reviewer verbs on it are the ordinary finding
// transitions. Everything runs against a temporary SQLite data root: no
// PostgreSQL, no Docker, no model call. Exact recurrence in particular must be
// provably model-free — these tests never configure an LLM gateway.
import test from "node:test";
import assert from "node:assert/strict";
import { createTarget, withApp } from "./helpers.ts";
import { ulid } from "../../src/ulid.ts";
import { intakeFinding, recomputeFindingKeys } from "../../src/findings/intake.ts";
import { runRetentionCycle } from "../../src/retention/worker.ts";

const SYSTEM = { system: "test" };

// --- seeding -----------------------------------------------------------------

async function seedProject(app: HostedDynamic, api: HostedDynamic, key: HostedDynamic) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const { application, ring } = await createTarget(api, project, { ringKey: "staging", discoveryAllowed: true });
  const suite = (await api.post(`/projects/${key}/suites`, { slug: "s", name: "S" })).body;
  const snapshotId = ulid();
  await app.db.query(
    `INSERT INTO suite_snapshots (id, suite_id, seq, tree, created_by) VALUES ($1,$2,1,'{}',$3)`,
    [snapshotId, suite.id, app.ctx.devUserId],
  );
  const groupId = ulid();
  await app.db.query(
    `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, application_id, ring_id, trigger, selection, status)
       VALUES ($1,$2,$3,$4,$5,$6,'{}','{}','done')`,
    [groupId, project.id, suite.id, snapshotId, application.id, ring.id],
  );
  return { project, suite, application, ring, snapshotId, groupId };
}

async function seedRun(app: HostedDynamic, { groupId, caseId = "cart", storyId = "cart/remove", status = "explored", gate = null, totals = null }: HostedDynamic) {
  const id = ulid();
  await app.db.query(
    `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode, manifest, totals, gate, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,'explore',$7,$8,$9, now())`,
    [id, groupId, caseId, storyId, `${caseId}-${ulid().slice(-6)}`, status, JSON.stringify({ case: { id: caseId } }),
      totals ? JSON.stringify(totals) : null, gate ? JSON.stringify(gate) : null],
  );
  return { id, case_id: caseId, story_id: storyId };
}

/** A grounded HTTP-error claim on a given story/route. */
function httpClaim({ storyId, route, title, expected, observed, category = "http_error" }: HostedDynamic) {
  return {
    category,
    storyId,
    caseId: "cart",
    signalType: "http_error",
    locus: { route, step_locus: "role=button[name=Remove]", status_class: "5xx" },
    title,
    expected,
    observed,
    severity: "major",
    signals: ["http_5xx"],
  };
}

const intake = (app: HostedDynamic, args: HostedDynamic) => app.db.withTx((tx: HostedDynamic) => intakeFinding(tx, { actor: SYSTEM, source: "synthesis", ...args }));

/** The needs-review bucket: exactly the console's `state=new` filter. */
const needsReview = async (api: HostedDynamic, key: HostedDynamic) => (await api.get(`/projects/${key}/findings?state=new`)).body.items;

// --- tests -------------------------------------------------------------------

test("all cited evidence lands on the filed finding, and a strict recurrence appends to it", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId } = await seedProject(app, api, "in-a");
    const runA = await seedRun(app, { groupId });
    const runB = await seedRun(app, { groupId });

    const first: HostedDynamic = await intake(app, {
      projectId: project.id,
      claim: httpClaim({
        storyId: "cart/remove",
        route: "/api/cart/items/8842",
        title: "Removing a cart line returns a server error",
        expected: "the line is removed",
        observed: "the DELETE returned 500",
      }),
      evidence: [
        { run_id: runA.id, step: 2, excerpt: "DELETE /api/cart/items/8842 → 500" },
        { run_id: runB.id, step: 4, excerpt: "DELETE /api/cart/items/9137 → 500" },
      ],
    });
    assert.equal(first.action, "created");
    assert.equal(first.finding.state, "new", "machine-filed claims are unreviewed, never confirmed");
    assert.equal(first.evidence_added, 2);

    const finding: HostedDynamic = (await api.get(`/findings/${first.finding.id}`)).body;
    assert.equal(finding.evidence.length, 2, "every cited run/step became finding evidence");
    assert.equal(finding.evidence_count, 2);

    // Same defect, second run, entirely different model wording and ids.
    const runC = await seedRun(app, { groupId });
    const again = await intake(app, {
      projectId: project.id,
      claim: httpClaim({
        storyId: "cart/remove",
        route: "/api/cart/items/55010",
        category: "expectation_violation", // the model even picked another category
        title: "Cart line removal blows up",
        expected: "the selected line disappears",
        observed: "a 500 came back and the line stayed",
      }),
      evidence: [{ run_id: runC.id, step: 3, excerpt: "DELETE /api/cart/items/55010 → 500" }],
    });
    assert.equal(again.action, "appended", "strict key matches regardless of wording or category");
    assert.equal(again.finding.id, finding.id);
    assert.equal((await api.get(`/findings/${finding.id}`)).body.evidence_count, 3);
    // Exact recurrence is deterministic: the review queue never grew.
    assert.equal((await api.get(`/projects/${project.key}/findings?state=all`)).body.items.length, 1);
    assert.equal((await needsReview(api, project.key)).length, 1);
  });
});

test("a loose hit is a suggestion the reviewer merges; it never auto-appends", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId } = await seedProject(app, api, "in-b");
    const runA = await seedRun(app, { groupId, storyId: "search/basic" });
    const first: HostedDynamic = await intake(app, {
      projectId: project.id,
      claim: httpClaim({ storyId: "search/basic", route: "/api/search?q=fern", title: "Search 500s", expected: "results load", observed: "500" }),
      evidence: [{ run_id: runA.id, step: 2 }],
    });
    const finding: HostedDynamic = (await api.post(`/findings/${first.finding.id}/accept`, {})).body;

    // Same defect surface, different story ⇒ loose hit.
    const runB = await seedRun(app, { groupId, storyId: "search/filter" });
    const loose = await intake(app, {
      projectId: project.id,
      claim: httpClaim({ storyId: "search/filter", route: "/api/search?price=lt25", title: "Filtered search 500s", expected: "filtered results load", observed: "500" }),
      evidence: [{ run_id: runB.id, step: 2 }],
    });
    assert.equal(loose.action, "suggested");
    assert.equal(loose.finding.suggested_finding_id, finding.id);
    assert.equal(loose.finding.state, "new", "a suggestion is still an unreviewed finding");
    assert.equal((await api.get(`/findings/${finding.id}`)).body.evidence_count, 1,
      "a loose hit never auto-appends evidence");
    // The console renders the suggestion without a second request.
    const listed = (await needsReview(api, project.key)).find((f: HostedDynamic) => f.id === loose.finding.id);
    assert.equal(listed.suggested_finding_title, finding.title);

    const merged = (await api.post(`/findings/${loose.finding.id}/merge`, { into: finding.id })).body;
    assert.equal(merged.id, finding.id, "one click merges the report into the finding it duplicates");
    assert.equal(merged.evidence_count, 2, "the merge brings the report's evidence with it");
    assert.equal((await needsReview(api, project.key)).length, 0);
  });
});

test("a different defect in the same category stays its own unreviewed finding", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId } = await seedProject(app, api, "in-c");
    const runA = await seedRun(app, { groupId, storyId: "account/gift-card" });
    const runB = await seedRun(app, { groupId, storyId: "account/reset-password" });
    await intake(app, {
      projectId: project.id,
      claim: httpClaim({ storyId: "account/gift-card", route: "/api/giftcards/redeem", title: "Gift card redemption 500s", expected: "balance credited", observed: "500" }),
      evidence: [{ run_id: runA.id, step: 2 }],
    });
    const b = await intake(app, {
      projectId: project.id,
      claim: httpClaim({ storyId: "account/reset-password", route: "/api/password/reset", title: "Password reset 500s", expected: "reset email sent", observed: "500" }),
      evidence: [{ run_id: runB.id, step: 2 }],
    });
    assert.equal(b.action, "created", "same category, different surface ⇒ no match at all");
    assert.equal(b.finding.suggested_finding_id, null);
    assert.equal((await needsReview(api, project.key)).length, 2);
  });
});

test("a rejected finding absorbs its exact recurrence, counts it, and never re-enters review", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId } = await seedProject(app, api, "in-d");
    const runA = await seedRun(app, { groupId, storyId: "nav/deadlink" });
    const c = httpClaim({ storyId: "nav/deadlink", route: "/this-page-does-not-exist", title: "Unknown route 404s", expected: "n/a", observed: "404" });
    const first: HostedDynamic = await intake(app, { projectId: project.id, claim: c, evidence: [{ run_id: runA.id, step: 1 }] });

    await api.post(`/findings/${first.finding.id}/reject`, { reason: "not_a_bug" });
    assert.equal((await needsReview(api, project.key)).length, 0);

    const runB = await seedRun(app, { groupId, storyId: "nav/deadlink" });
    const again = await intake(app, {
      projectId: project.id,
      claim: { ...c, title: "Deep link to a missing page returns 404" },
      evidence: [{ run_id: runB.id, step: 7 }],
    });
    assert.equal(again.action, "absorbed", "a standing rejection IS the suppression ledger");
    assert.equal(again.finding.id, first.finding.id, "the recurrence folds into the rejected finding");
    assert.equal(again.finding.recurrence_count, 1, "a counter, not a queue entry");
    assert.equal((await needsReview(api, project.key)).length, 0);
    assert.equal((await api.get(`/projects/${project.key}/findings?state=all`)).body.items.length, 1);

    const detail = (await api.get(`/findings/${first.finding.id}`)).body;
    assert.equal(detail.evidence_count, 2, "the recurrence's evidence is still recorded");
    assert.equal(detail.state, "rejected");

    // The reject vocabulary gained `duplicate`: "same bug, already filed".
    const other = await intake(app, {
      projectId: project.id,
      claim: httpClaim({ storyId: "nav/other", route: "/gone", title: "Another 404", expected: "n/a", observed: "404" }),
      evidence: [{ run_id: runB.id, step: 8 }],
    });
    const dup = await api.post(`/findings/${other.finding.id}/reject`, { reason: "duplicate" });
    assert.equal(dup.status, 200, JSON.stringify(dup.body));
    assert.equal(dup.body.reject_reason, "duplicate");
  });
});

test("finding lifecycle survives intake: rejected absorbs silently, resolved reopens", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId } = await seedProject(app, api, "in-e");
    const runA = await seedRun(app, { groupId, storyId: "checkout/place-order" });
    const c = httpClaim({ storyId: "checkout/place-order", route: "/api/orders", title: "Order submit 500s", expected: "order placed", observed: "500" });
    const first: HostedDynamic = await intake(app, { projectId: project.id, claim: c, evidence: [{ run_id: runA.id, step: 2 }] });
    const finding: HostedDynamic = (await api.post(`/findings/${first.finding.id}/accept`, {})).body;

    // Rejected: matching evidence is absorbed, the finding stays out of the
    // active queue and no feed event announces it.
    await api.post(`/findings/${finding.id}/reject`, { reason: "not_a_bug" });
    const before = (await app.db.query(`SELECT COUNT(*) AS n FROM platform_events WHERE project_id = $1`, [project.id])).rows[0].n;
    const runB = await seedRun(app, { groupId, storyId: "checkout/place-order" });
    const absorbed = await intake(app, { projectId: project.id, claim: c, evidence: [{ run_id: runB.id, step: 3 }] });
    assert.equal(absorbed.action, "absorbed");
    assert.equal(
      (await app.db.query(`SELECT COUNT(*) AS n FROM platform_events WHERE project_id = $1`, [project.id])).rows[0].n,
      before,
      "a rejected finding absorbs matching evidence silently",
    );
    const rejected = (await api.get(`/findings/${finding.id}`)).body;
    assert.equal(rejected.state, "rejected");
    assert.equal(rejected.evidence_count, 2);
    const active = (await api.get(`/projects/${project.key}/findings?state=new,reopened`)).body.items;
    assert.equal(active.some((f: HostedDynamic) => f.id === finding.id), false, "a rejected recurrence stays out of the active queue");

    // Resolved: the same recurrence reopens it.
    await api.post(`/findings/${finding.id}/resolve`, {});
    const runC = await seedRun(app, { groupId, storyId: "checkout/place-order" });
    const reopened = await intake(app, { projectId: project.id, claim: c, evidence: [{ run_id: runC.id, step: 4 }] });
    assert.equal(reopened.action, "appended");
    assert.equal((await api.get(`/findings/${finding.id}`)).body.state, "reopened");
  });
});

test("a strict hit follows merge tombstones to the surviving finding", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId } = await seedProject(app, api, "in-f");
    void project;
    const runA = await seedRun(app, { groupId, storyId: "cart/remove" });
    const runB = await seedRun(app, { groupId, storyId: "cart/add" });
    const a = await intake(app, {
      projectId: project.id,
      claim: httpClaim({ storyId: "cart/remove", route: "/api/cart/items/1", title: "Remove 500s", expected: "removed", observed: "500" }),
      evidence: [{ run_id: runA.id, step: 2 }],
    });
    const b = await intake(app, {
      projectId: project.id,
      claim: httpClaim({ storyId: "cart/add", route: "/api/cart/add", title: "Add 500s", expected: "added", observed: "500" }),
      evidence: [{ run_id: runB.id, step: 2 }],
    });
    await api.post(`/findings/${a.finding.id}/merge`, { into: b.finding.id });

    const runC = await seedRun(app, { groupId, storyId: "cart/remove" });
    const recurrence = await intake(app, {
      projectId: project.id,
      claim: httpClaim({ storyId: "cart/remove", route: "/api/cart/items/2", title: "Remove still 500s", expected: "removed", observed: "500" }),
      evidence: [{ run_id: runC.id, step: 5 }],
    });
    assert.equal(recurrence.action, "appended");
    assert.equal(recurrence.finding.id, b.finding.id, "the tombstone redirects the append to the surviving finding");
  });
});

test("an idempotent retry adds no duplicate evidence and files nothing twice", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId } = await seedProject(app, api, "in-g");
    const run: HostedDynamic = await seedRun(app, { groupId });
    const args = {
      projectId: project.id,
      claim: httpClaim({ storyId: "cart/remove", route: "/api/cart/items/1", title: "Remove 500s", expected: "removed", observed: "500" }),
      evidence: [{ run_id: run.id, step: 2 }, { run_id: run.id, step: 3 }],
      intakeKey: "study:g1:claim-1",
    };
    const first: HostedDynamic = await intake(app, args);
    const retry = await intake(app, args);
    assert.equal(retry.action, "idempotent");
    assert.equal(retry.finding.id, first.finding.id);
    assert.equal((await api.get(`/findings/${first.finding.id}`)).body.evidence_count, 2,
      "the retry appended nothing");
    assert.equal((await needsReview(api, project.key)).length, 1);
    assert.equal(
      (await app.db.query(`SELECT COUNT(*) AS n FROM finding_intake_keys WHERE project_id = $1`, [project.id])).rows[0].n,
      1,
      "one key, one finding",
    );

    // The same evidence re-cited without the idempotency key is still deduped by
    // the append-only natural key.
    await intake(app, { ...args, intakeKey: null });
    assert.equal((await api.get(`/findings/${first.finding.id}`)).body.evidence_count, 2);
  });
});

test("a key algorithm version bump recomputes stored keys; older findings keep matching", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId } = await seedProject(app, api, "in-h");
    const runA = await seedRun(app, { groupId, storyId: "cart/remove" });
    const c = httpClaim({ storyId: "cart/remove", route: "/api/cart/items/1", title: "Remove 500s", expected: "removed", observed: "500" });
    const first: HostedDynamic = await intake(app, { projectId: project.id, claim: c, evidence: [{ run_id: runA.id, step: 2 }] });
    const original = (await api.get(`/findings/${first.finding.id}`)).body;

    // Simulate a row written under an older algorithm: stale version, stale keys.
    await app.db.query(
      `UPDATE findings SET key_algo_version = 'key-v0', strict_key = 'stale-strict', loose_key = 'stale-loose',
              normalized_locus = 'stale', match_text_version = 'match-text-v0' WHERE id = $1`,
      [first.finding.id],
    );

    // A recurrence would MISS while the stored keys are stale…
    const runB = await seedRun(app, { groupId, storyId: "cart/remove" });
    const missed = await intake(app, { projectId: project.id, claim: c, evidence: [{ run_id: runB.id, step: 3 }] });
    assert.equal(missed.action, "created", "stale keys cannot match — this is what the recompute repairs");

    let summary: HostedDynamic;
    await app.db.withTx(async (tx: HostedDynamic) => { summary = await recomputeFindingKeys(tx, { projectId: project.id }); });
    assert.equal(summary.updated, 1);
    const recomputed = (await api.get(`/findings/${first.finding.id}`)).body;
    assert.equal(recomputed.strict_key, original.strict_key, "the recompute restores the current-version key");
    assert.equal(recomputed.loose_key, original.loose_key);
    assert.equal(recomputed.key_algo_version, original.key_algo_version);

    // …and matches again afterwards: an older finding never silently stops matching.
    const runC = await seedRun(app, { groupId, storyId: "cart/remove" });
    const matched = await intake(app, { projectId: project.id, claim: c, evidence: [{ run_id: runC.id, step: 4 }] });
    assert.equal(matched.action, "appended");
    assert.equal((await api.get(`/projects/${project.key}/findings?state=all`)).body.items.length, 2,
      "the recompute stopped the split; no third finding was filed");
  });
});

test("authorization: viewers read, only reviewers decide, and cross-project evidence is rejected", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId } = await seedProject(app, api, "in-i");
    const other = await seedProject(app, api, "in-i-other");
    const run: HostedDynamic = await seedRun(app, { groupId });
    const first: HostedDynamic = await intake(app, {
      projectId: project.id,
      claim: httpClaim({ storyId: "cart/remove", route: "/api/cart/items/1", title: "Remove 500s", expected: "removed", observed: "500" }),
      evidence: [{ run_id: run.id, step: 2 }],
    });

    // A finding may never cite another project's run.
    const foreignRun = await seedRun(app, { groupId: other.groupId });
    await assert.rejects(
      () => intake(app, {
        projectId: project.id,
        claim: httpClaim({ storyId: "cart/remove", route: "/api/cart/items/2", title: "x", expected: "y", observed: "z" }),
        evidence: [{ run_id: foreignRun.id, step: 1 }],
      }),
      /belongs to another project/,
    );

    // Nor may a merge cross a project boundary.
    const otherRun = await seedRun(app, { groupId: other.groupId });
    const otherFinding = await intake(app, {
      projectId: other.project.id,
      claim: httpClaim({ storyId: "cart/remove", route: "/api/cart/items/9", title: "Other", expected: "y", observed: "z" }),
      evidence: [{ run_id: otherRun.id, step: 1 }],
    });
    const crossed = await api.post(`/findings/${first.finding.id}/merge`, { into: otherFinding.finding.id });
    assert.equal(crossed.status, 404, JSON.stringify(crossed.body));

    // Role guards: viewer reads, reviewer decides.
    const viewerToken = (await api.post(`/projects/${project.key}/tokens`, { name: "v", role: "viewer" })).body.token;
    const viewer = api.withToken(viewerToken);
    assert.equal((await viewer.get(`/projects/${project.key}/findings?state=new`)).status, 200);
    assert.equal((await viewer.get(`/findings/${first.finding.id}`)).status, 200);
    assert.equal((await viewer.post(`/findings/${first.finding.id}/accept`, {})).status, 403);
    assert.equal((await viewer.post(`/findings/${first.finding.id}/reject`, { reason: "not_a_bug" })).status, 403);

    const reviewerToken = (await api.post(`/projects/${project.key}/tokens`, { name: "r", role: "reviewer" })).body.token;
    assert.equal((await api.withToken(reviewerToken).post(`/findings/${first.finding.id}/accept`, {})).status, 200);

    // A token scoped to another project cannot read this project's findings.
    const foreignToken = (await api.post(`/projects/${other.project.key}/tokens`, { name: "x", role: "admin" })).body.token;
    assert.equal((await api.withToken(foreignToken).get(`/projects/${project.key}/findings`)).status, 403);

    // The five bug-candidate routes are gone, not tombstoned.
    for (const [method, path] of [
      ["get", `/projects/${project.key}/bug-candidates`],
      ["get", `/bug-candidates/${first.finding.id}`],
      ["post", `/bug-candidates/${first.finding.id}/promote`],
      ["post", `/bug-candidates/${first.finding.id}/confirm-suggestion`],
      ["post", `/bug-candidates/${first.finding.id}/dismiss`],
    ] as HostedDynamic) {
      const res = method === "get" ? await api.get(path) : await api.post(path, {});
      assert.equal(res.status, 404, `${method.toUpperCase()} ${path}`);
    }
  });
});

test("every intake and transition is attributable in the audit log", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId } = await seedProject(app, api, "in-j");
    const run: HostedDynamic = await seedRun(app, { groupId });
    const first: HostedDynamic = await intake(app, {
      projectId: project.id,
      claim: httpClaim({ storyId: "cart/remove", route: "/api/cart/items/1", title: "Remove 500s", expected: "removed", observed: "500" }),
      evidence: [{ run_id: run.id, step: 2 }],
    });
    await api.post(`/findings/${first.finding.id}/accept`, {});
    const run2 = await seedRun(app, { groupId, storyId: "cart/other" });
    const second = await intake(app, {
      projectId: project.id,
      claim: httpClaim({ storyId: "cart/other", route: "/api/other", title: "Other 500s", expected: "ok", observed: "500" }),
      evidence: [{ run_id: run2.id, step: 2 }],
    });
    await api.post(`/findings/${second.finding.id}/reject`, { reason: "wont_fix" });
    const run3 = await seedRun(app, { groupId, storyId: "cart/remove" });
    await intake(app, {
      projectId: project.id,
      claim: httpClaim({ storyId: "cart/remove", route: "/api/cart/items/7", title: "Remove 500s again", expected: "removed", observed: "500" }),
      evidence: [{ run_id: run3.id, step: 9 }],
    });

    const { rows } = await app.db.query(
      `SELECT action, actor, detail FROM audit_log WHERE project_id = $1 AND entity_type = 'finding' ORDER BY id`,
      [project.id],
    );
    const actions = rows.map((r: HostedDynamic) => r.action);
    assert.ok(actions.includes("finding.created"));
    assert.ok(actions.includes("finding.accepted"));
    assert.ok(actions.includes("finding.rejected"));
    assert.ok(actions.includes("finding.evidence_added"));
    assert.equal(rows.find((r: HostedDynamic) => r.action === "finding.created").detail.source, "synthesis",
      "intake audit names the source that filed it");
    for (const r of rows) {
      assert.ok(r.actor && (r.actor.user_id || r.actor.token_id || r.actor.system), `actor recorded for ${r.action}`);
    }
    // No bug_candidate.* event ever reaches the feed again.
    const types = (await app.db.query(`SELECT DISTINCT type FROM platform_events WHERE project_id = $1`, [project.id])).rows;
    assert.equal(types.some((t: HostedDynamic) => t.type.startsWith("bug_candidate.")), false);
  });
});

test("reviewer filing lands confirmed, on deterministic identity rather than the run id", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId } = await seedProject(app, api, "in-k");
    const gate = { checks: [{ kind: "assert", severity: "hard", spec: "assert: save button visible", pass: false, detail: "button 123 not visible" }] };
    const runA = await seedRun(app, { groupId, caseId: "save", storyId: "save", status: "fail", gate, totals: { steps: 4 } });
    const runB = await seedRun(app, { groupId, caseId: "save", storyId: "save", status: "fail", gate, totals: { steps: 6 } });

    const one = (await api.post(`/runs/${runA.id}/promote-finding`, { title: "Save button hidden", severity: "major", note: "saw it" })).body;
    assert.equal(one.state, "accepted", "a person filing a bug IS its confirmation");
    assert.ok(one.summary.confirmed_at, "the confirmation is timestamped");
    assert.ok(one.summary.confirmed_by, "the reviewer is stamped as confirmer");
    assert.equal(one.evidence[0].step_from, 4, "evidence still pins the run's final observed state");
    assert.match(one.evidence[0].viewer_url, /\?step=4$/);
    assert.match(one.evidence[0].excerpt, /saw it — assert: save button visible — button 123 not visible/);
    assert.equal(one.summary.gate.spec, "assert: save button visible");
    assert.equal(one.summary.promoted_from_run_id, runA.id, "the run is provenance…");
    assert.equal(one.story_health?.status, "fail");

    // A second reviewer filing the same defect surface from a DIFFERENT run
    // lands on the same finding — under a run-scoped fingerprint this produced
    // two findings.
    const two = (await api.post(`/runs/${runB.id}/promote-finding`, { title: "The save button never appears", severity: "major" })).body;
    assert.equal(two.id, one.id, "…not identity");
    assert.equal(two.evidence_count, 2);
    assert.equal((await api.get(`/projects/${project.key}/findings?state=all`)).body.items.length, 1);
    assert.equal((await needsReview(api, project.key)).length, 0, "a filed bug is confirmed, not queued for review");
  });
});

test("retention pins every run referenced by an unreviewed finding", async () => {
  await withApp(async ({ app, api, storeRoot }: HostedDynamic) => {
    void storeRoot;
    const now = new Date("2026-07-06T00:00:00.000Z");
    const old = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
    const { project, groupId } = await seedProject(app, api, "in-l");

    const seedOld = async (caseId: HostedDynamic) => {
      const id = ulid();
      await app.db.query(
        `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode, artifact_tier, finished_at)
           VALUES ($1,$2,$3,$3,$4,'explored','explore','core',$5)`,
        [id, groupId, caseId, `${caseId}-run`, old],
      );
      const key = `runs/${groupId}/${id}.ptrun`;
      await app.store.put(key, Buffer.from("bundle"));
      await app.db.query(
        `INSERT INTO artifacts (id, run_id, kind, key, sha256, size, tier, verified_at)
           VALUES ($1,$2,'bundle',$3,'deadbeef',6,'core',$4)`,
        [ulid(), id, key, old],
      );
      return id;
    };
    const pinned = await seedOld("pinned");
    const prunable = await seedOld("prunable");

    await intake(app, {
      projectId: project.id,
      claim: httpClaim({ storyId: "pinned", route: "/api/pinned", title: "Pinned 500s", expected: "ok", observed: "500" }),
      evidence: [{ run_id: pinned, step: 1 }],
    });

    await runRetentionCycle(app.ctx, {
      now,
      integritySample: 0,
      retention: { events_days: 1, full_days: 7, core_days: 20 },
    });

    const tier = async (id: HostedDynamic) => (await app.db.query(`SELECT artifact_tier FROM runs WHERE id = $1`, [id])).rows[0].artifact_tier;
    assert.equal(await tier(prunable), "meta", "an unreferenced expired run tiers to meta");
    assert.equal(await tier(pinned), "core", "a run cited by an unreviewed finding is pinned");
  });
});
