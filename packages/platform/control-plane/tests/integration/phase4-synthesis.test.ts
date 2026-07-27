// Discovery study synthesis emits typed, cited claims into the one hosted
// intake path. There is no Insight row or report object: a claim becomes ONE
// finding in state `new` carrying every cited run/step, and a person confirms
// or dismisses it from the ordinary Findings surface.
//
// This exercises the ingest half (everything after the grounded model call)
// against a real database on a temporary SQLite data root.
import test from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./helpers.ts";
import { ulid } from "../../src/ulid.ts";
import { ingestSynthesisFindings, deriveSignal } from "../../src/findings/synthesis.ts";

async function seedExploredGroup(app: HostedDynamic, api: HostedDynamic, project: HostedDynamic) {
  const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "s", name: "S" })).body;
  const snapshotId = ulid();
  await app.db.query(
    `INSERT INTO suite_snapshots (id, suite_id, seq, tree, created_by) VALUES ($1, $2, 1, '{}', $3)`,
    [snapshotId, suite.id, app.ctx.devUserId],
  );
  const env = (await api.post(`/projects/${project.key}/environments`, { name: "staging", discovery_allowed: true })).body;
  const groupId = ulid();
  await app.db.query(
    `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, environment_id, trigger, selection, status)
       VALUES ($1,$2,$3,$4,$5,'{}','{}','done')`,
    [groupId, project.id, suite.id, snapshotId, env.id],
  );
  const runs: HostedDynamic[] = [];
  for (const persona of ["tester", "exploratory"]) {
    const dbId = ulid();
    const token = `export-${persona}-${ulid().slice(-6)}`;
    await app.db.query(
      `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode, manifest)
         VALUES ($1,$2,$3,$4,$5,'explored','explore',$6)`,
      [dbId, groupId, `export-study@${persona}`, "export-study", token, JSON.stringify({ case: { persona } })],
    );
    runs.push({
      ref: token,
      db_id: dbId,
      case_id: `export-study@${persona}`,
      story_id: "export-study",
      // The trusted half: deterministic signals recomputed from the run's
      // recorded envelopes. Identity comes from here, never from model prose.
      signals: [
        {
          type: "http_5xx",
          step: persona === "tester" ? 3 : 5,
          detail: "POST /api/export → 500",
          locus: { route: "/api/export", status_class: "5xx" },
        },
      ],
    });
  }
  return { groupId, runs };
}

test("synthesis ingest: one claim becomes one finding carrying every cited run/step", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "synth", name: "Synth" })).body;
    const { groupId, runs } = await seedExploredGroup(app, api, project);
    const group = { id: groupId, project_id: project.id };
    const knownRefs = new Map(runs.map((r) => [r.ref, r]));
    const actor = { user_id: app.ctx.devUserId };

    // One model-synthesized claim cited across BOTH personas' runs.
    let summary: HostedDynamic;
    await app.db.withTx(async (tx: HostedDynamic) => {
      summary = await ingestSynthesisFindings(tx, {
        projectId: project.id,
        group,
        findings: [
          {
            severity: "major",
            kind: "http_error",
            note: "Export fails with a server error after 12 attempts",
            expected: "the export downloads",
            observed: "the export endpoint returned 500",
            evidence: [
              { run_ref: runs[0].ref, step: 3 },
              { run_ref: runs[1].ref, step: 5 },
            ],
          },
        ],
        knownRefs,
        actor,
      });
    });
    assert.equal(summary.created, 1, "one finding filed");
    assert.equal(summary.suggested, 0);

    // It is unreviewed: machine output awaiting judgment, never confirmed.
    const queue = (await api.get(`/projects/${project.key}/findings?state=new`)).body.items;
    assert.equal(queue.length, 1);
    const detail = (await api.get(`/findings/${queue[0].id}`)).body;
    assert.equal(detail.state, "new");
    assert.equal(detail.evidence_count, 2, "every cited run/step is preserved, not only the first");
    assert.deepEqual(detail.evidence.map((e: HostedDynamic) => e.step_from).sort(), [3, 5]);
    const runDbIds = new Set(detail.evidence.map((e: HostedDynamic) => e.run_db_id));
    assert.ok(runDbIds.has(runs[0].db_id) && runDbIds.has(runs[1].db_id));
    assert.equal(detail.signal_type, "http_error", "identity comes from the recorded signal, not the model");
    assert.ok(detail.strict_key && detail.loose_key, "a grounded claim carries both exact keys");
    assert.equal(detail.source, "synthesis");
    assert.equal(detail.claim.expected, "the export downloads");

    // Confirming it is a person's act, and the evidence stays whole.
    const confirmed = (await api.post(`/findings/${detail.id}/accept`, {})).body;
    assert.equal(confirmed.state, "accepted");
    assert.equal(confirmed.evidence.length, 2, "the confirmed finding holds every cited run/step");

    // A reworded restatement of the same claim (different numbers, different
    // words) strict-matches through the recorded signal and appends its
    // evidence to the SAME finding — no second finding, no model call.
    await app.db.withTx(async (tx: HostedDynamic) => {
      const again = await ingestSynthesisFindings(tx, {
        projectId: project.id,
        group,
        findings: [
          {
            severity: "major",
            kind: "expectation_violation",
            note: "Downloading the export blew up after 3 tries",
            expected: "the export arrives",
            observed: "a server error came back instead",
            evidence: [{ run_ref: runs[0].ref, step: 3 }, { run_ref: runs[1].ref, step: 5 }],
          },
        ],
        knownRefs,
        actor,
      });
      assert.equal(again.appended, 1, "the reworded claim appends to the existing finding");
      assert.equal(again.created, 0);
    });
    assert.equal((await api.get(`/projects/${project.key}/findings?state=all`)).body.items.length, 1,
      "still exactly one finding after the reworded restatement");
  });
});

test("synthesis ingest: an ungrounded claim carries no exact keys and waits for review", async () => {
  await withApp(async ({ app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "synth2", name: "Synth2" })).body;
    const { groupId, runs } = await seedExploredGroup(app, api, project);
    // Strip the recorded signals: nothing deterministic grounds these claims.
    const knownRefs = new Map(runs.map((r) => [r.ref, { ...r, signals: [] }]));
    await app.db.withTx(async (tx: HostedDynamic) => {
      const summary: HostedDynamic = await ingestSynthesisFindings(tx, {
        projectId: project.id,
        group: { id: groupId, project_id: project.id },
        findings: [
          { severity: "minor", note: "Users could not find the export affordance", evidence: [{ run_ref: runs[0].ref, step: 3 }] },
        ],
        knownRefs,
        actor: { user_id: app.ctx.devUserId },
      });
      assert.equal(summary.created, 1);
    });
    const c = (await api.get(`/projects/${project.key}/findings?state=new`)).body.items[0];
    assert.equal(c.signal_type, null);
    assert.equal(c.strict_key, null, "no deterministic signal ⇒ no exact keys (D4)");
    assert.equal(c.loose_key, null);
  });
});

test("deriveSignal: the recorded signal at a cited step grounds the claim; category only breaks ties", () => {
  const knownRefs = new Map([
    ["r1", {
      signals: [
        { type: "console_exception", step: 2, detail: "TypeError: x is not a function" },
        { type: "http_5xx", step: 2, detail: "GET /api/cart → 500", locus: { route: "/api/cart", status_class: "5xx" } },
      ],
    }],
  ]);
  const http = deriveSignal([{ run_ref: "r1", step: 2 }], knownRefs, "http_error");
  assert.equal(http.signalType, "http_error", "a signal matching the claim's category wins");
  assert.equal(http.locus.route, "/api/cart");

  const other = deriveSignal([{ run_ref: "r1", step: 2 }], knownRefs, "data_mismatch");
  assert.equal(other.signalType, "console_exception", "otherwise the first recorded signal at a cited step");

  const none = deriveSignal([{ run_ref: "r1", step: 9 }], knownRefs, "data_mismatch");
  assert.equal(none.signalType, null, "no signal at the cited step ⇒ no exact keys");
  assert.equal(none.locus, null);
});
