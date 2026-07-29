// Reviewer-triggered retrieve-then-verify consolidation over unreviewed
// findings (docs/contracts/hosted.md, "Consolidation").
//
// Everything runs against a temporary SQLite data root: no PostgreSQL, no
// Docker, and no real gateway. The model is a FAKE injected into
// `planConsolidation`, which is the only way a model result can enter this
// system at all — and these tests prove that a fake that lies, invents ids, or
// reaches into another project cannot mutate a single row.
import test from "node:test";
import assert from "node:assert/strict";
import { withApp, createTarget } from "./helpers.ts";
import { ulid } from "../../src/ulid.ts";
import { intakeFinding } from "../../src/findings/intake.ts";
import {
  applyConsolidationPlan,
  discardConsolidationPlan,
  planConsolidation,
  previewConsolidation,
} from "../../src/findings/consolidation.ts";

const SYSTEM = { system: "test" };

// --- seeding -----------------------------------------------------------------

async function seedProject(app: HostedDynamic, api: HostedDynamic, key: HostedDynamic) {
  const project = (await api.post("/projects", { key, name: key })).body;
  // The application and its discovery-allowed ring come first: a suite binds to
  // an application at creation, and a run group records both.
  const { application, ring } = await createTarget(api, project, { ringKey: "staging" });
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
  return { project, groupId };
}

async function seedRun(app: HostedDynamic, { groupId, caseId = "checkout", storyId = "checkout/apply-coupon" }: HostedDynamic) {
  const id = ulid();
  await app.db.query(
    `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode, manifest, finished_at)
       VALUES ($1,$2,$3,$4,$5,'explored','explore',$6, now())`,
    [id, groupId, caseId, storyId, `${caseId}-${ulid().slice(-6)}`, JSON.stringify({ case: { id: caseId } })],
  );
  return { id, case_id: caseId, story_id: storyId };
}

/** An ungrounded claim (no deterministic signal ⇒ no exact keys ⇒ consolidation's job). */
function claim({ category, title, expected, observed, storyId = "checkout/apply-coupon" }: HostedDynamic) {
  return {
    category,
    storyId,
    caseId: "checkout",
    signalType: null,
    locus: null,
    title,
    expected,
    observed,
    severity: "major",
    signals: [],
  };
}

const intake = (app: HostedDynamic, args: HostedDynamic) =>
  app.db.withTx((tx: HostedDynamic) => intakeFinding(tx, { actor: SYSTEM, source: "synthesis", ...args }));

/** A fake gateway. Records every call; returns whatever the test scripted. */
function fakeModel(reply: HostedDynamic) {
  const calls: HostedDynamic[] = [];
  const fn = async (args: HostedDynamic) => {
    calls.push(args);
    const out = typeof reply === "function" ? reply(args, calls.length) : reply;
    return { args: out, tokens: { in: 800, out: 90, cache_read: 0 } };
  };
  fn.calls = calls;
  return fn;
}

/** The two reworded personas of one stale-total defect (corpus fixture F2). */
async function seedRewordedPair(app: HostedDynamic, api: HostedDynamic, key: HostedDynamic) {
  const { project, groupId } = await seedProject(app, api, key);
  const runA = await seedRun(app, { groupId });
  const runB = await seedRun(app, { groupId });
  const a = await intake(app, {
    projectId: project.id,
    claim: claim({
      category: "data_mismatch",
      title: "Coupon applied but order total unchanged",
      expected: "the order total decreases after the coupon discount is applied",
      observed: "the coupon applied banner appeared but the order total remained unchanged",
    }),
    evidence: [{ run_id: runA.id, step: 2, excerpt: "banner said applied; total stayed $148.00" }],
  });
  const b = await intake(app, {
    projectId: project.id,
    claim: claim({
      category: "expectation_violation",
      title: "Coupon discount does not update the order total",
      expected: "the order total drops once the coupon discount is applied",
      observed: "the coupon registered but the order total did not update",
    }),
    evidence: [{ run_id: runB.id, step: 2, excerpt: "amount due unchanged after the discount" }],
  });
  return { project, groupId, runA, runB, a: a.finding, b: b.finding };
}

const acceptAll = (plan: HostedDynamic) => plan.plan.items.map((i: HostedDynamic) => ({ item_id: i.id, action: "accept" }));

// --- tests -------------------------------------------------------------------

test("two differently worded reports consolidate into one finding with both evidence rows", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, a, b } = await seedRewordedPair(app, api, "p3a");

    // Retrieval finds them; the model is asked once and groups them.
    const model = fakeModel((args: HostedDynamic) => {
      const ids = [...String(args.messages[1].content).matchAll(/candidate_id (\S+)/g)].map((m) => m[1]);
      return {
        assignments: [{
          candidate_ids: ids,
          proposed_title: "Order total ignores an applied coupon",
          confidence: "high",
          reason: "both personas describe one stale total after a coupon",
        }],
        unresolved: [],
      };
    });
    const plan: HostedDynamic = await planConsolidation(app.ctx, { project, actor: SYSTEM, callModel: model });
    assert.equal(model.calls.length, 1, "one call for the one cluster");
    assert.equal(plan.status, "proposed");
    assert.deepEqual(plan.plan.items[0].candidate_ids.sort(), [a.id, b.id].sort());

    // NOTHING has changed yet: a proposed plan is a proposal.
    for (const id of [a.id, b.id]) {
      const f = (await app.db.query(`SELECT * FROM findings WHERE id = $1`, [id])).rows[0];
      assert.equal(f.state, "new");
      assert.equal(f.merged_into, null);
      assert.equal(f.title, id === a.id ? a.title : b.title, "titles are untouched until a reviewer applies");
    }

    await app.db.withTx((tx: HostedDynamic) => applyConsolidationPlan(tx, { planRow: plan, decisions: acceptAll(plan), actor: SYSTEM }));

    const findings = (await app.db.query(
      `SELECT * FROM findings WHERE project_id = $1 AND merged_into IS NULL`, [project.id])).rows;
    assert.equal(findings.length, 1, "one defect, one finding");
    assert.equal(findings[0].title, "Order total ignores an applied coupon");
    assert.equal(findings[0].state, "new", "a consolidated group still awaits ordinary review");
    const evidence = (await app.db.query(
      `SELECT * FROM finding_evidence WHERE finding_id = $1 ORDER BY created_at`, [findings[0].id])).rows;
    assert.equal(evidence.length, 2, "both personas' evidence rows travelled with their findings");
    assert.equal(findings[0].evidence_count, 2);
    for (const id of [a.id, b.id]) {
      if (id === findings[0].id) continue;
      const f = (await app.db.query(`SELECT * FROM findings WHERE id = $1`, [id])).rows[0];
      assert.equal(f.merged_into, findings[0].id, "the other member is a merge tombstone");
    }

    // Retrieval provenance rides on the finding.
    assert.equal(findings[0].summary.shortlist_version, "shortlist-v1");
    assert.equal(findings[0].summary.consolidation_plan_id, plan.id);
  });
});

test("distinct defects in the same category stay separate and cost no model call", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId } = await seedProject(app, api, "p3b");
    const run: HostedDynamic = await seedRun(app, { groupId });
    for (const c of [
      claim({
        category: "http_error", storyId: "account/redeem-gift-card",
        title: "Gift-card redemption returns a server error",
        expected: "the gift-card balance is credited to the account",
        observed: "the giftcard redeem endpoint returned a 500",
      }),
      claim({
        category: "http_error", storyId: "account/reset-password",
        title: "Password reset request returns a server error",
        expected: "a password reset email link is sent",
        observed: "the password reset endpoint returned a 500",
      }),
    ]) {
      await intake(app, { projectId: project.id, claim: c, evidence: [{ run_id: run.id, step: 2, excerpt: c.observed }] });
    }

    const preview = await previewConsolidation(app.ctx, { project });
    assert.equal(preview.scope.clusters, 0, "two unrelated http_error claims never share a cluster");
    assert.equal(preview.requires_model, false);
    assert.equal(preview.scope.proposed_new, 2);

    const model = fakeModel({ assignments: [] });
    const plan: HostedDynamic = await planConsolidation(app.ctx, { project, actor: SYSTEM, callModel: model });
    assert.equal(model.calls.length, 0, "score routing alone: no gateway call");
    assert.equal(plan.usage.calls, 0);
    assert.equal(plan.prompt_version, null, "the legacy column is retained but no longer written");

    await app.db.withTx((tx: HostedDynamic) => applyConsolidationPlan(tx, { planRow: plan, decisions: acceptAll(plan), actor: SYSTEM }));
    const findings = (await app.db.query(`SELECT * FROM findings WHERE project_id = $1`, [project.id])).rows;
    assert.equal(findings.length, 2, "two defects, two findings");
    assert.deepEqual(findings.map((f: HostedDynamic) => f.title).sort(), [
      "Gift-card redemption returns a server error",
      "Password reset request returns a server error",
    ]);
  });
});

test("a report scoring above the auto-suggest threshold merges without a model call", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, a, b } = await seedRewordedPair(app, api, "p3c");
    // Promote one candidate so the other's only strong neighbor is a FINDING.
    const first: HostedDynamic = await planConsolidation(app.ctx, {
      project, actor: SYSTEM,
      callModel: fakeModel((args: HostedDynamic) => ({
        assignments: [...String(args.messages[1].content).matchAll(/candidate_id (\S+)/g)]
          .map((m) => m[1])
          .filter((id) => id === a.id)
          .map((id) => ({ candidate_ids: [id], proposed_title: "Order total ignores an applied coupon", confidence: "high", reason: "r" })),
        unresolved: [{ candidate_id: b.id, reason: "wait for more evidence" }],
      })),
    });
    await app.db.withTx((tx: HostedDynamic) => applyConsolidationPlan(tx, {
      planRow: first,
      decisions: first.plan.items.map((i: HostedDynamic) => ({ item_id: i.id, action: "accept" })),
      actor: SYSTEM,
    }));
    // Confirming it makes it a REVIEWED neighbor: consolidation's subjects are
    // the unreviewed findings, and its targets are the ones a person has touched.
    await api.post(`/findings/${a.id}/accept`, {});

    // Now the remaining report is scored against that finding. At the default
    // auto-suggest threshold this pair is not strong enough to bypass
    // verification, so it clusters — lower the threshold and the same pair is
    // routed with no call at all. Both branches are the routing contract.
    const clustering = await previewConsolidation(app.ctx, { project });
    assert.equal(clustering.scope.clusters, 1);

    app.ctx.config.consolidation = { ...app.ctx.config.consolidation, autoSuggest: 0.26 };
    const preview = await previewConsolidation(app.ctx, { project });
    assert.equal(preview.scope.suggestions, 1, "a single strong finding neighbor becomes a suggestion");
    assert.equal(preview.scope.clusters, 0);
    assert.equal(preview.requires_model, false);

    const model = fakeModel({ assignments: [] });
    const plan: HostedDynamic = await planConsolidation(app.ctx, { project, actor: SYSTEM, callModel: model });
    assert.equal(model.calls.length, 0, "an auto-suggested candidate never reaches the gateway");
    assert.equal(plan.plan.items.length, 1);
    assert.equal(plan.plan.items[0].origin, "shortlist_suggestion");
    assert.ok(plan.plan.items[0].score >= 0.26);

    await app.db.withTx((tx: HostedDynamic) => applyConsolidationPlan(tx, { planRow: plan, decisions: acceptAll(plan), actor: SYSTEM }));
    const findings = (await app.db.query(
      `SELECT * FROM findings WHERE project_id = $1 AND merged_into IS NULL`, [project.id])).rows;
    assert.equal(findings.length, 1, "the suggestion merged into the existing finding");
    assert.equal(findings[0].evidence_count, 2);
  });
});

test("a reviewer edit retargets an item, and a skipped item leaves its findings unreviewed", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId, a, b } = await seedRewordedPair(app, api, "p3d");
    const run: HostedDynamic = await seedRun(app, { groupId, caseId: "search", storyId: "search/basic-query" });
    const extra = (await intake(app, {
      projectId: project.id,
      claim: claim({
        category: "broken_navigation", storyId: "search/basic-query",
        title: "Search results never render",
        expected: "the search results list appears",
        observed: "the search results list stayed blank",
      }),
      evidence: [{ run_id: run.id, step: 3, excerpt: "blank results" }],
    })).finding;

    // An existing finding the reviewer will retarget the group onto.
    const existingId = ulid();
    await app.db.query(
      `INSERT INTO findings (id, project_id, fingerprint, title, summary, severity, state, first_seen, last_seen, evidence_count)
         VALUES ($1,$2,$3,'Order total ignores an applied coupon','{}','major','accepted', now(), now(), 0)`,
      [existingId, project.id, `fp-${existingId}`],
    );

    const plan: HostedDynamic = await planConsolidation(app.ctx, {
      project, actor: SYSTEM,
      callModel: fakeModel({
        assignments: [{
          candidate_ids: [a.id, b.id],
          proposed_title: "Coupon total bug",
          confidence: "medium",
          reason: "same stale total",
        }],
        unresolved: [],
      }),
    });
    const group = plan.plan.items.find((i: HostedDynamic) => i.candidate_ids.length === 2);
    const lone = plan.plan.items.find((i: HostedDynamic) => i.candidate_ids[0] === extra.id);
    assert.equal(lone.origin, "shortlist_new");

    await app.db.withTx((tx: HostedDynamic) => applyConsolidationPlan(tx, {
      planRow: plan,
      decisions: [
        { item_id: group.id, action: "accept", finding_id: existingId },  // reviewer edit
        { item_id: lone.id, action: "skip" },                              // left unresolved
      ],
      actor: SYSTEM,
    }));

    const target = (await app.db.query(`SELECT * FROM findings WHERE id = $1`, [existingId])).rows[0];
    assert.equal(target.evidence_count, 2, "the edited target absorbed both members' evidence");
    assert.equal(
      (await app.db.query(
        `SELECT COUNT(*) AS n FROM findings WHERE project_id = $1 AND merged_into IS NULL`, [project.id])).rows[0].n,
      2,
      "the reviewer's edit created no new finding: the target plus the skipped report",
    );
    const skipped = (await app.db.query(`SELECT * FROM findings WHERE id = $1`, [extra.id])).rows[0];
    assert.equal(skipped.state, "new", "a skipped item leaves its finding unreviewed");
    assert.equal(skipped.merged_into, null);

    // Labeled pairs: two confirmations recorded as edits, one rejection.
    const labels = (await app.db.query(
      `SELECT * FROM consolidation_labels WHERE plan_id = $1 ORDER BY subject_finding_id`, [plan.id])).rows;
    assert.equal(labels.length, 3);
    assert.deepEqual(labels.filter((l: HostedDynamic) => l.decision === "edited").map((l: HostedDynamic) => l.subject_finding_id).sort(), [a.id, b.id].sort());
    assert.deepEqual(labels.filter((l: HostedDynamic) => l.decision === "rejected").map((l: HostedDynamic) => l.subject_finding_id), [extra.id]);
    assert.equal(labels.find((l: HostedDynamic) => l.decision === "rejected").origin, "shortlist_new");
  });
});

test("an item whose target was merged away follows the tombstone to the live finding", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, a, b } = await seedRewordedPair(app, api, "p3e");
    const oldId = ulid();
    const newId = ulid();
    for (const [id, title] of [[oldId, "Old coupon finding"], [newId, "Live coupon finding"]]) {
      await app.db.query(
        `INSERT INTO findings (id, project_id, fingerprint, title, summary, severity, state, first_seen, last_seen, evidence_count)
           VALUES ($1,$2,$3,$4,'{}','major','accepted', now(), now(), 0)`,
        [id, project.id, `fp-${id}`, title],
      );
    }
    const plan: HostedDynamic = await planConsolidation(app.ctx, {
      project, actor: SYSTEM,
      callModel: fakeModel({
        assignments: [{ candidate_ids: [a.id, b.id], proposed_title: "Coupon total", confidence: "high", reason: "r" }],
        unresolved: [],
      }),
    });
    // The chosen target is merged away between proposal and apply.
    await app.db.query(`UPDATE findings SET merged_into = $2 WHERE id = $1`, [oldId, newId]);

    await app.db.withTx((tx: HostedDynamic) => applyConsolidationPlan(tx, {
      planRow: plan,
      decisions: [{ item_id: plan.plan.items[0].id, action: "accept", finding_id: oldId }],
      actor: SYSTEM,
    }));
    const live = (await app.db.query(`SELECT * FROM findings WHERE id = $1`, [newId])).rows[0];
    assert.equal(live.evidence_count, 2, "evidence landed on the live head of the merge chain");
    assert.equal((await app.db.query(`SELECT evidence_count AS n FROM findings WHERE id = $1`, [oldId])).rows[0].n, 0);
  });
});

test("a stale plan fails cleanly and re-applying an applied plan is refused", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, a, b } = await seedRewordedPair(app, api, "p3f");
    const model = fakeModel({
      assignments: [{ candidate_ids: [a.id, b.id], proposed_title: "Coupon total", confidence: "high", reason: "r" }],
      unresolved: [],
    });
    const stale = await planConsolidation(app.ctx, { project, actor: SYSTEM, callModel: model });
    const fresh = await planConsolidation(app.ctx, { project, actor: SYSTEM, callModel: model });

    await app.db.withTx((tx: HostedDynamic) => applyConsolidationPlan(tx, { planRow: fresh, decisions: acceptAll(fresh), actor: SYSTEM }));

    // The first plan now describes candidates that moved.
    await assert.rejects(
      app.db.withTx((tx: HostedDynamic) => applyConsolidationPlan(tx, { planRow: stale, decisions: acceptAll(stale), actor: SYSTEM })),
      /is stale/,
    );
    // And an applied plan cannot be applied twice.
    await assert.rejects(
      app.db.withTx((tx: HostedDynamic) => applyConsolidationPlan(tx, { planRow: fresh, decisions: acceptAll(fresh), actor: SYSTEM })),
      /already applied/,
    );
    assert.equal(
      (await app.db.query(
        `SELECT COUNT(*) AS n FROM findings WHERE project_id = $1 AND merged_into IS NULL`, [project.id])).rows[0].n,
      1,
      "neither refusal created a second finding",
    );
  });
});

test("a model that invents an id, or reaches into another project, mutates nothing", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, a } = await seedRewordedPair(app, api, "p3g");
    const other = await seedProject(app, api, "p3g-other");
    const otherFindingId = ulid();
    await app.db.query(
      `INSERT INTO findings (id, project_id, fingerprint, title, summary, severity, state, first_seen, last_seen, evidence_count)
         VALUES ($1,$2,$3,'Another project finding','{}','major','new', now(), now(), 0)`,
      [otherFindingId, other.project.id, `fp-${otherFindingId}`],
    );

    for (const [label, reply] of [
      ["an invented candidate id", {
        assignments: [{ candidate_ids: ["c-does-not-exist"], proposed_title: "X", confidence: "high", reason: "r" }],
      }],
      ["another project's finding", {
        assignments: [{ candidate_ids: [a.id], finding_id: otherFindingId, confidence: "high", reason: "r" }],
      }],
      ["a finding from another project", {
        assignments: [{ candidate_ids: [a.id, "c-from-elsewhere"], proposed_title: "X", confidence: "high", reason: "r" }],
      }],
    ] as HostedDynamic) {
      await assert.rejects(
        planConsolidation(app.ctx, { project, actor: SYSTEM, callModel: fakeModel(reply) }),
        /invalid plan|was not in this cluster's input/,
        label,
      );
    }

    assert.equal(
      (await app.db.query(`SELECT COUNT(*) AS n FROM consolidation_plans WHERE project_id = $1`, [project.id])).rows[0].n,
      0,
      "a rejected model plan is never persisted",
    );
    const untouched = (await app.db.query(`SELECT * FROM findings WHERE id = $1`, [a.id])).rows[0];
    assert.equal(untouched.state, "new", "no partial mutation");
    assert.equal(untouched.merged_into, null);
    assert.equal(untouched.title, a.title);
  });
});

test("a decision naming an unknown item, a repeated finding, or an untitled group is refused whole", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, a, b } = await seedRewordedPair(app, api, "p3h");
    const plan: HostedDynamic = await planConsolidation(app.ctx, {
      project, actor: SYSTEM,
      callModel: fakeModel({
        assignments: [
          { candidate_ids: [a.id], proposed_title: "A", confidence: "high", reason: "r" },
          { candidate_ids: [b.id], proposed_title: "B", confidence: "high", reason: "r" },
        ],
        unresolved: [],
      }),
    });
    const [i1, i2] = plan.plan.items;

    for (const [decisions, pattern] of [
      [[{ item_id: "it_nope", action: "accept" }], /not part of this plan/],
      [[{ item_id: i1.id, action: "accept" }, { item_id: i1.id, action: "accept" }], /decided twice/],
      [[{ item_id: i1.id, action: "accept", proposed_title: "  " }], /needs a non-empty title/],
      [[{ item_id: i1.id, action: "accept", finding_id: "f-nope" }], /no target finding/],
      [[{ item_id: i2.id, action: "sideways" }], /must be accept or skip/],
    ] as HostedDynamic) {
      await assert.rejects(
        app.db.withTx((tx: HostedDynamic) => applyConsolidationPlan(tx, { planRow: plan, decisions, actor: SYSTEM })),
        pattern,
      );
    }
    for (const f of [a, b]) {
      const row: HostedDynamic = (await app.db.query(`SELECT * FROM findings WHERE id = $1`, [f.id])).rows[0];
      assert.equal(row.title, f.title, "every refusal rolled back whole");
      assert.equal(row.merged_into, null);
    }
    const reread = (await app.db.query(`SELECT * FROM consolidation_plans WHERE id = $1`, [plan.id])).rows[0];
    assert.equal(reread.status, "proposed", "a refused apply leaves the plan reviewable");
  });
});

test("the whole flow is reachable over HTTP, and reading a plan needs only viewer", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, a, b } = await seedRewordedPair(app, api, "p3i");

    const preview = await api.get(`/projects/p3i/consolidation/preview`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.scope.clusters, 1);
    assert.equal(preview.body.scope.unassigned_candidates, 2, "both unreviewed findings are in scope");
    assert.equal("prompt_version" in preview.body, false);
    // The preview alone must not have written anything.
    assert.equal(
      (await app.db.query(`SELECT COUNT(*) AS n FROM consolidation_plans`)).rows[0].n, 0);

    // Running it over HTTP needs the gateway; without one the error names the
    // fix — and says 503 not_configured, because an unconfigured optional
    // capability is a deployment choice, not a crash.
    const noGateway = await api.post(`/projects/p3i/consolidation`, {});
    assert.equal(noGateway.status, 503);
    assert.equal(noGateway.body.error.code, "not_configured");
    assert.match(noGateway.body.error.message, /PLAYTEST_LLM_BASE_URL/);

    // Build the plan through the module with a fake model, then drive review and
    // apply over HTTP exactly as the console does.
    const plan: HostedDynamic = await planConsolidation(app.ctx, {
      project, actor: SYSTEM,
      callModel: fakeModel({
        assignments: [{ candidate_ids: [a.id, b.id], proposed_title: "Order total ignores an applied coupon", confidence: "high", reason: "r" }],
        unresolved: [],
      }),
    });

    const detail = await api.get(`/consolidation-plans/${plan.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.items.length, 1);
    assert.equal(detail.body.items[0].candidates.length, 2);
    // The review screen carries every evidence link without a second request.
    for (const m of detail.body.items[0].candidates) {
      assert.equal(m.evidence.length, 1);
      assert.match(m.evidence[0].viewer_url, /^\/p\/p3i\/runs\//);
      assert.ok(m.claim.title);
    }

    const listed = await api.get(`/projects/p3i/consolidation-plans`);
    assert.equal(listed.body.items[0].id, plan.id);
    assert.equal(listed.body.items[0].item_count, 1);

    const applied = await api.post(`/consolidation-plans/${plan.id}/apply`, {
      decisions: [{ item_id: plan.plan.items[0].id, action: "accept" }],
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.status, "applied");
    const findings = await api.get(`/projects/p3i/findings`);
    assert.equal(findings.body.items.length, 1);
    assert.equal(findings.body.items[0].evidence_count, 2);

    // Audit: the planned proposal and the applied decisions are both attributable.
    const actions = (await app.db.query(
      `SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id`, [plan.id])).rows.map((r: HostedDynamic) => r.action);
    assert.deepEqual(actions, ["consolidation.planned", "consolidation.applied"]);
  });
});

test("a discarded plan changes nothing and cannot then be applied", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, a, b } = await seedRewordedPair(app, api, "p3j");
    const plan: HostedDynamic = await planConsolidation(app.ctx, {
      project, actor: SYSTEM,
      callModel: fakeModel({
        assignments: [{ candidate_ids: [a.id, b.id], proposed_title: "T", confidence: "high", reason: "r" }],
        unresolved: [],
      }),
    });
    await app.db.withTx((tx: HostedDynamic) => discardConsolidationPlan(tx, { planId: plan.id, actor: SYSTEM }));
    await assert.rejects(
      app.db.withTx((tx: HostedDynamic) => applyConsolidationPlan(tx, { planRow: plan, decisions: acceptAll(plan), actor: SYSTEM })),
      /already discarded/,
    );
    for (const f of [a, b]) {
      const row: HostedDynamic = (await app.db.query(`SELECT * FROM findings WHERE id = $1`, [f.id])).rows[0];
      assert.equal(row.state, "new");
      assert.equal(row.merged_into, null);
      assert.equal(row.title, f.title, "a discarded plan retitles nothing");
    }
  });
});

test("model-returned unresolved findings stay unreviewed and are labeled", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, a, b } = await seedRewordedPair(app, api, "p3k");
    const plan: HostedDynamic = await planConsolidation(app.ctx, {
      project, actor: SYSTEM,
      callModel: fakeModel({
        assignments: [{ candidate_ids: [a.id], proposed_title: "Only the first claim", confidence: "medium", reason: "r" }],
        unresolved: [{ candidate_id: b.id, reason: "insufficient evidence to say it is the same defect" }],
      }),
    });
    assert.equal(plan.plan.unresolved.length, 1);
    await app.db.withTx((tx: HostedDynamic) => applyConsolidationPlan(tx, { planRow: plan, decisions: acceptAll(plan), actor: SYSTEM }));

    const stillOpen = (await app.db.query(`SELECT * FROM findings WHERE id = $1`, [b.id])).rows[0];
    assert.equal(stillOpen.state, "new");
    assert.equal(stillOpen.merged_into, null);
    const label = (await app.db.query(
      `SELECT * FROM consolidation_labels WHERE subject_finding_id = $1`, [b.id])).rows[0];
    assert.equal(label.decision, "unresolved");
    assert.match(label.detail.reason, /insufficient evidence/);
  });
});
