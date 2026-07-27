// The automatic post-run dedupe sweep (docs/contracts/hosted.md,
// "Consolidation"): the same retrieve-then-verify pipeline as the manual flow,
// with a non-reviewer apply policy — high-confidence model groups merge,
// weaker matches become pre-attached suggestions, everything else stays for a
// person. The model is a fake injected through the same `callModel` seam the
// manual-flow tests use.
import test from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./helpers.ts";
import { ulid } from "../../src/ulid.ts";
import { intakeFinding } from "../../src/findings/intake.ts";
import { AUTO_DEDUPE_ACTOR, autoDecisions, autoDedupeEnabledFor, autoDedupeTimers, runAutoDedupe, scheduleAutoDedupe } from "../../src/findings/auto-dedupe.ts";

const SYSTEM = { system: "test" };

async function seedProject(app: HostedDynamic, api: HostedDynamic, key: HostedDynamic) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const suite = (await api.post(`/projects/${key}/suites`, { slug: "s", name: "S" })).body;
  const snapshotId = ulid();
  await app.db.query(
    `INSERT INTO suite_snapshots (id, suite_id, seq, tree, created_by) VALUES ($1,$2,1,'{}',$3)`,
    [snapshotId, suite.id, app.ctx.devUserId],
  );
  const env = (await api.post(`/projects/${key}/environments`, { name: "staging", discovery_allowed: true })).body;
  const groupId = ulid();
  await app.db.query(
    `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, environment_id, trigger, selection, status)
       VALUES ($1,$2,$3,$4,$5,'{}','{}','done')`,
    [groupId, project.id, suite.id, snapshotId, env.id],
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

/** An ungrounded claim (no deterministic signal ⇒ no exact keys ⇒ the sweep's job). */
function claim({ category, title, expected, observed, storyId = "checkout/apply-coupon" }: HostedDynamic) {
  return {
    category, storyId, caseId: "checkout", signalType: null, locus: null,
    title, expected, observed, severity: "major", signals: [],
  };
}

const intake = (app: HostedDynamic, args: HostedDynamic) =>
  app.db.withTx((tx: HostedDynamic) => intakeFinding(tx, { actor: SYSTEM, source: "synthesis", ...args }));

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

test("auto-dedupe merges a high-confidence reworded pair without a reviewer", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId } = await seedProject(app, api, "adh");
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

    const result = await runAutoDedupe(app.ctx, { project, callModel: model });
    assert.equal(result.applied, 1);
    assert.equal(result.suggestions_attached, 0);

    const live = (await app.db.query(
      `SELECT * FROM findings WHERE project_id = $1 AND merged_into IS NULL`, [project.id])).rows;
    assert.equal(live.length, 1, "one defect, one finding — no reviewer in the loop");
    assert.equal(live[0].title, "Order total ignores an applied coupon");
    assert.equal(live[0].state, "new", "the merged group still awaits ordinary human review");
    assert.equal(live[0].evidence_count, 2, "both personas' evidence travelled");
    const tombstone = [a.finding.id, b.finding.id].find((id) => id !== live[0].id);
    const merged = (await app.db.query(`SELECT merged_into FROM findings WHERE id = $1`, [tombstone])).rows[0];
    assert.equal(merged.merged_into, live[0].id);

    // The plan is durable and attributed to the sweep, and the labels record a
    // system confirmation — not a human one.
    const plan: HostedDynamic = (await app.db.query(
      `SELECT * FROM consolidation_plans WHERE id = $1`, [result.plan_id])).rows[0];
    assert.equal(plan.status, "applied");
    assert.deepEqual(plan.applied_by, AUTO_DEDUPE_ACTOR);
    const labels = (await app.db.query(
      `SELECT * FROM consolidation_labels WHERE plan_id = $1`, [result.plan_id])).rows;
    assert.equal(labels.length, 2);
    for (const l of labels) {
      assert.equal(l.decision, "confirmed");
      assert.deepEqual(l.actor, AUTO_DEDUPE_ACTOR);
    }
    const events = (await app.db.query(
      `SELECT * FROM platform_events WHERE project_id = $1 AND type = 'consolidation.auto_applied'`,
      [project.id])).rows;
    assert.equal(events.length, 1, "the sweep announces itself so live lists repaint");
  });
});

test("a deterministic score-only match becomes a suggestion, never a merge", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId } = await seedProject(app, api, "ads");
    const runA = await seedRun(app, { groupId });
    const runB = await seedRun(app, { groupId, caseId: "checkout2", storyId: "checkout/apply-coupon-mobile" });
    const words = {
      category: "data_mismatch",
      title: "Coupon applied but order total unchanged",
      expected: "the order total decreases after the coupon discount is applied",
      observed: "the coupon applied banner appeared but the order total remained unchanged",
    };
    const confirmed = await intake(app, {
      projectId: project.id,
      claim: claim(words),
      evidence: [{ run_id: runA.id, step: 2, excerpt: "total stayed" }],
      confirm: { actor: SYSTEM },
    });
    const fresh = await intake(app, {
      projectId: project.id,
      claim: claim({ ...words, storyId: "checkout/apply-coupon-mobile" }),
      evidence: [{ run_id: runB.id, step: 3, excerpt: "total stayed on mobile" }],
    });

    // Near-identical text against one reviewed finding routes by score alone —
    // no cluster, so the fake model must never be consulted.
    const model = fakeModel(() => { throw new Error("score-routed paths must not reach the gateway"); });
    const result = await runAutoDedupe(app.ctx, { project, callModel: model });
    assert.equal(model.calls.length, 0);
    assert.equal(result.applied, 0, "a lexical score alone never merges");
    assert.equal(result.suggestions_attached, 1);

    const row: HostedDynamic = (await app.db.query(`SELECT * FROM findings WHERE id = $1`, [fresh.finding.id])).rows[0];
    assert.equal(row.merged_into, null);
    assert.equal(row.state, "new");
    assert.equal(row.suggested_finding_id, confirmed.finding.id, "the match arrives as a pre-attached suggestion");
    assert.equal(row.summary.auto_dedupe.origin, "shortlist_suggestion");
    assert.equal(row.summary.auto_dedupe.plan_id, result.plan_id);
    const labels = (await app.db.query(
      `SELECT decision FROM consolidation_labels WHERE plan_id = $1`, [result.plan_id])).rows;
    assert.deepEqual(labels.map((l: HostedDynamic) => l.decision), ["unresolved"],
      "deferring to a person is not a rejection signal");
  });
});

test("the sweep skips cleanly when there is nothing to do or no gateway", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const { project, groupId } = await seedProject(app, api, "adn");
    assert.deepEqual(await runAutoDedupe(app.ctx, { project }), { skipped: "no_unreviewed_findings" });

    // Two ambiguous findings need a verify call; without a gateway the sweep
    // steps aside instead of erroring (deterministic intake dedupe still ran).
    const runA = await seedRun(app, { groupId });
    const runB = await seedRun(app, { groupId });
    for (const [run, title] of [[runA, "Coupon applied but total unchanged"], [runB, "Coupon total not updating after apply"]] as HostedDynamic) {
      await intake(app, {
        projectId: project.id,
        claim: claim({ category: "data_mismatch", title, expected: "total drops", observed: title }),
        evidence: [{ run_id: run.id, step: 2, excerpt: title }],
      });
    }
    delete process.env.PLAYTEST_LLM_BASE_URL;
    assert.deepEqual(await runAutoDedupe(app.ctx, { project }), { skipped: "not_configured" });
  });
});

test("the per-project toggle decides; scheduling is gated only by the gateway", async () => {
  await withApp(async ({ app }: HostedDynamic) => {
    const before = process.env.PLAYTEST_LLM_BASE_URL;
    try {
      delete process.env.PLAYTEST_LLM_BASE_URL;
      assert.equal(scheduleAutoDedupe(app.ctx, "p1"), false, "no gateway, no sweep");
      assert.equal(autoDedupeEnabledFor(app.ctx, { auto_dedupe: true }), false,
        "a project pin cannot conjure a gateway the deployment lacks");

      process.env.PLAYTEST_LLM_BASE_URL = "http://127.0.0.1:9";
      // The tri-state: the project pin wins, null inherits the deployment default.
      app.ctx.config.autoDedupe.enabled = true;
      assert.equal(autoDedupeEnabledFor(app.ctx, { auto_dedupe: null }), true);
      assert.equal(autoDedupeEnabledFor(app.ctx, { auto_dedupe: false }), false);
      app.ctx.config.autoDedupe.enabled = false;
      assert.equal(autoDedupeEnabledFor(app.ctx, { auto_dedupe: null }), false);
      assert.equal(autoDedupeEnabledFor(app.ctx, { auto_dedupe: true }), true,
        "a pinned-on project sweeps even when the deployment default is off");

      // Scheduling therefore cannot early-return on the deployment default —
      // the policy is read fresh (per project) when the timer fires.
      assert.equal(scheduleAutoDedupe(app.ctx, "p1"), true);
      assert.equal(scheduleAutoDedupe(app.ctx, "p1"), true, "a repeat report re-debounces the same timer");
      assert.equal(autoDedupeTimers(app.ctx).size, 1);
    } finally {
      clearTimeout(autoDedupeTimers(app.ctx).get("p1"));
      if (before == null) delete process.env.PLAYTEST_LLM_BASE_URL;
      else process.env.PLAYTEST_LLM_BASE_URL = before;
    }
  });
});

test("PUT /projects/:p/auto-dedupe pins the sweep and fires a catch-up pass on enable", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const before = process.env.PLAYTEST_LLM_BASE_URL;
    try {
      process.env.PLAYTEST_LLM_BASE_URL = "http://127.0.0.1:9";
      const project = (await api.post("/projects", { key: "adt", name: "ADT" })).body;
      assert.equal(project.auto_dedupe, null, "a new project inherits the deployment default");

      const bad = await api.put("/projects/adt/auto-dedupe", { enabled: "yes" });
      assert.equal(bad.status, 400);

      const off = (await api.put("/projects/adt/auto-dedupe", { enabled: false })).body;
      assert.equal(off.auto_dedupe, false);
      assert.ok(!autoDedupeTimers(app.ctx).has(project.id), "turning it off schedules nothing");

      const on = (await api.put("/projects/adt/auto-dedupe", { enabled: true })).body;
      assert.equal(on.auto_dedupe, true);
      assert.ok(autoDedupeTimers(app.ctx).has(project.id),
        "turning it on schedules the catch-up sweep — the button-less design depends on it");

      const inherit = (await api.put("/projects/adt/auto-dedupe", { enabled: null })).body;
      assert.equal(inherit.auto_dedupe, null);
    } finally {
      clearTimeout(autoDedupeTimers(app.ctx).get("adt"));
      for (const t of autoDedupeTimers(app.ctx).values() ?? []) clearTimeout(t);
      if (before == null) delete process.env.PLAYTEST_LLM_BASE_URL;
      else process.env.PLAYTEST_LLM_BASE_URL = before;
    }
  });
});

test("autoDecisions: only high-confidence model groups merge; targeted weaker matches suggest", () => {
  const plan: HostedDynamic = {
    items: [
      { id: "i1", origin: "model_cluster", confidence: "high", candidate_ids: ["a", "b"], finding_id: null },
      { id: "i2", origin: "model_cluster", confidence: "medium", candidate_ids: ["c"], finding_id: "F1" },
      { id: "i3", origin: "model_cluster", confidence: "medium", candidate_ids: ["d", "e"], finding_id: null },
      { id: "i4", origin: "shortlist_suggestion", candidate_ids: ["f"], finding_id: "F2", score: 0.91 },
      { id: "i5", origin: "shortlist_new", candidate_ids: ["g"], finding_id: null },
    ],
  };
  const { decisions, suggestions } = autoDecisions(plan);
  assert.deepEqual(decisions, [{ item_id: "i1", action: "accept" }]);
  assert.deepEqual(suggestions.map((s) => [s.candidate_id, s.finding_id]), [["c", "F1"], ["f", "F2"]]);
});
