// The Runs index projection: GET /projects/:p/run-groups.
//
// The console's triage surface reads a run's outcome counts, wall clock, cost
// and progress off the row, and expands to its stories without another request.
// All of that is this one endpoint, so these are the assertions that keep the
// index honest: counts that match the runs, a duration only once nothing is
// moving, story rows under `include=runs`, and `outcome=attention` selecting
// exactly the runs a person has to look at.
import test from "node:test";
import assert from "node:assert/strict";
import { withApp, createTarget, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";

class MockGitHub {
  enabled = true;
  dispatches: HostedDynamic[] = [];
  async dispatchWorkflow(req: HostedDynamic) {
    this.dispatches.push(req);
    return { workflow_run_id: `wr-${this.dispatches.length}`, workflow_run_url: `https://gha.invalid/${this.dispatches.length}` };
  }
  async getRunStatus(id: HostedDynamic) {
    return { id, status: "completed", conclusion: "success", url: `https://gha.invalid/${id}` };
  }
  async cancelRun() {
    return { ok: true };
  }
}

test("runs index: per-run stats, story rows, and the needs-attention filter", async () => {
  const github = new MockGitHub();
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "runsidx", name: "Runs index" })).body;
    const { application, ring } = await createTarget(api, project, {
      key: "todos",
      name: "Todos",
      ringKey: "staging",
      baseUrl: "http://127.0.0.1:9",
      runnerLabels: ["self-hosted", "playtest"],
      config: { secret_env: {} },
    });
    const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "todos", name: "Todos" })).body;
    const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`));
    assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);

    /** Launch every story in the suite and report the outcome each name maps to. */
    async function runGroup(outcomes: HostedDynamic, note: HostedDynamic, against: HostedDynamic = ring) {
      const launched = await api.post(`/projects/${project.key}/run-groups`, {
        suite_id: suite.id,
        ring_id: against.id,
        selection: { mode: "auto" },
        note,
      });
      assert.equal(launched.status, 200, JSON.stringify(launched.body));
      const groupId = launched.body.run_group.id;
      const exchanged = await fetch(`${base}/api/v1/runner/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ github_oidc_token: "mock", run_group_id: groupId, isolation: "process" }),
      }).then((r) => r.json());
      const headers = { authorization: `Bearer ${exchanged.token}`, "content-type": "application/json" };
      const spec = await fetch(`${base}/api/v1/runner/groups/${groupId}`, { headers }).then((r) => r.json());
      assert.equal(spec.cases.length, 3, "the fixture suite has three stories");
      for (const c of spec.cases) {
        const outcome = outcomes[c.case_id];
        assert.ok(outcome, `no outcome declared for "${c.case_id}"`);
        assert.equal((await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${c.run_id}/start`, {
          method: "POST", headers, body: "{}",
        })).status, 200);
        let bundle: HostedDynamic = null;
        if (outcome.status !== "infra") {
          bundle = (await fetch(`${base}/api/v1/runner/runs/${c.db_id}/bundle`, {
            method: "PUT",
            headers: { authorization: `Bearer ${exchanged.token}`, "content-type": "application/vnd.playtest.run-bundle" },
            body: Buffer.from(`bundle for ${c.case_id}`),
          }).then((r) => r.json())).artifact;
        }
        const reported = await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${c.run_id}/report`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            status: outcome.status,
            ...(bundle ? { bundle } : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
            score: outcome.score,
            manifest: {
              run_id: c.run_id,
              case: { id: c.case_id },
              status: outcome.status,
              duration_ms: outcome.duration_ms ?? 2100,
              totals: { steps: outcome.steps ?? 3, cost_usd: outcome.cost_usd ?? 0 },
            },
          }),
        });
        assert.equal(reported.status, 200, await reported.text());
      }
      assert.equal((await fetch(`${base}/api/v1/runner/groups/${groupId}/complete`, {
        method: "POST", headers, body: JSON.stringify({ summary: {} }),
      })).status, 200);
      return groupId;
    }

    const mixed = await runGroup({
      "add-todo": { status: "pass", score: 92, steps: 3, cost_usd: 0.01 },
      "complete-todo": { status: "fail", score: 40, steps: 3, cost_usd: 0.02 },
      "clear-completed": { status: "infra", error: "connect ECONNREFUSED 127.0.0.1:4173" },
    }, "nightly regression");
    const clean = await runGroup({
      "add-todo": { status: "pass", score: 95, cost_usd: 0.01 },
      "complete-todo": { status: "pass", score: 90, cost_usd: 0.01 },
      "clear-completed": { status: "pass", score: 88, cost_usd: 0.01 },
    }, "after the counter fix");

    // --- stats on every row, newest run first ---
    const list = await api.get(`/projects/${project.key}/run-groups?limit=25`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((g: HostedDynamic) => g.id), [clean, mixed], "newest run first");
    const mixedRow = list.body.items.find((g: HostedDynamic) => g.id === mixed);
    assert.equal(mixedRow.stats.total, 3);
    assert.equal(mixedRow.stats.done, 3);
    assert.equal(mixedRow.stats.pass, 1);
    assert.equal(mixedRow.stats.fail, 1);
    assert.equal(mixedRow.stats.infra, 1);
    assert.equal(mixedRow.stats.queued, 0);
    assert.equal(mixedRow.stats.running, 0);
    // Cost is the sum of what the stories actually reported — the row states it
    // without the console fetching a single run.
    assert.ok(Math.abs(mixedRow.stats.cost_usd - 0.03) < 1e-9, `cost was ${mixedRow.stats.cost_usd}`);
    // How long it took, reported once nothing is still moving. These three
    // stories each reported 2.1s of work inside a span of milliseconds, so the
    // row states the work rather than a "0ms" that would read as broken.
    assert.ok(mixedRow.stats.started_at, "a settled run reports when it started");
    assert.ok(mixedRow.stats.finished_at, "a settled run reports when it ended");
    // @ts-expect-error Date subtraction is intentional and yields elapsed milliseconds.
    const span = new Date(mixedRow.stats.finished_at) - new Date(mixedRow.stats.started_at);
    assert.equal(mixedRow.stats.duration_ms, Math.max(span, 3 * 2100),
      "the duration is the larger of the run's span and the work its stories did");

    // --- include=runs: the story rows the index expands to ---
    const plain = await api.get(`/projects/${project.key}/run-groups?limit=25`);
    assert.equal(plain.body.items[0].runs, undefined, "story rows are opt-in");
    const withRuns = await api.get(`/projects/${project.key}/run-groups?limit=25&include=runs`);
    const expanded = withRuns.body.items.find((g: HostedDynamic) => g.id === mixed);
    assert.deepEqual(expanded.runs.map((r: HostedDynamic) => r.case_id), ["add-todo", "clear-completed", "complete-todo"],
      "story rows arrive in the same order the run's own page lists them");
    const failed = expanded.runs.find((r: HostedDynamic) => r.case_id === "complete-todo");
    assert.equal(failed.status, "fail");
    assert.equal(failed.score, 40);
    assert.equal(failed.steps, 3);
    assert.equal(failed.duration_ms, 2100);
    assert.ok(Math.abs(failed.cost_usd - 0.02) < 1e-9);
    // Every row carries what a line in the list needs, including the id it links
    // to and the reason a story that never ran gives.
    assert.ok(failed.id, "a story row carries the run id its replay link needs");
    const neverRan = expanded.runs.find((r: HostedDynamic) => r.case_id === "clear-completed");
    assert.equal(neverRan.status, "infra");
    assert.match(neverRan.error, /ECONNREFUSED/);

    // --- outcome=attention: a failed check or no verdict, not yet superseded ---
    // `clean` reran every one of `mixed`'s failing stories and passed, so
    // `mixed` is retired: a green rerun is how a person resolves a red run.
    const retired = await api.get(`/projects/${project.key}/run-groups?outcome=attention`);
    assert.deepEqual(retired.body.items, [],
      "a failure whose story has since passed on the same suite and ring is not attention");
    const healthyOverview = await api.get(`/projects/${project.key}/health`);
    assert.deepEqual(healthyOverview.body.attention, [],
      "the suites overview also retires a failure after that story passes");
    // A story failing again after the fix is live attention — nothing newer
    // has passed it.
    const regressed = await runGroup({
      "add-todo": { status: "pass", score: 93, cost_usd: 0.01 },
      "complete-todo": { status: "fail", score: 35, cost_usd: 0.02 },
      "clear-completed": { status: "pass", score: 90, cost_usd: 0.01 },
    }, "the counter regressed again");
    const attention = await api.get(`/projects/${project.key}/run-groups?outcome=attention`);
    assert.deepEqual(attention.body.items.map((g: HostedDynamic) => g.id), [regressed],
      "only the run whose failure is still the story's latest verdict needs a look");
    assert.equal(attention.body.items[0].stats.fail, 1, "the filter still carries the full stats");
    const regressedOverview = await api.get(`/projects/${project.key}/health`);
    assert.deepEqual(
      regressedOverview.body.attention.map((item: HostedDynamic) => [item.kind, item.case_id]),
      [["fail", "complete-todo"]],
      "the suites overview raises attention again when the story's latest verdict is red",
    );

    // Retirement is keyed on (suite, RING), not on the suite alone: the same
    // story passing against a DIFFERENT deployment target says nothing about
    // this one, so it must not clear the red run off anybody's desk.
    const prod = (await api.post(`/applications/${application.id}/rings`, {
      key: "prod",
      name: "Prod",
      base_url: "http://127.0.0.1:9",
      runner_labels: ["self-hosted", "playtest"],
    })).body;
    await runGroup({
      "add-todo": { status: "pass", score: 94, cost_usd: 0.01 },
      "complete-todo": { status: "pass", score: 91, cost_usd: 0.01 },
      "clear-completed": { status: "pass", score: 89, cost_usd: 0.01 },
    }, "prod smoke", prod);
    const acrossRings = await api.get(`/projects/${project.key}/run-groups?outcome=attention`);
    assert.deepEqual(acrossRings.body.items.map((g: HostedDynamic) => g.id), [regressed],
      "a green run on another ring never retires a failure on this one");

    // A run group can have several bounded dispatch attempts. The Suites
    // overview alerts on the run, not on each placement attempt: one broken run
    // must not repeat the same row for every retry the reconciler made.
    const requestedAt = new Date();
    for (const [attempt, url, age] of [
      [8, "https://gha.invalid/dead-old", 1000],
      [9, "https://gha.invalid/dead-new", 0],
    ] as const) {
      await app.db.query(
        `INSERT INTO dispatches
           (id, project_id, kind, ref_id, attempt, workflow_run_id, workflow_run_url,
            status, requested_at, concluded_at, error)
         VALUES ($1, $2, 'group', $3, $4, $5, $6, 'reconciled_dead', $7, $7, 'runner stopped')`,
        [
          `dead-attempt-${attempt}`,
          project.id,
          mixed,
          attempt,
          `dead-workflow-${attempt}`,
          url,
          new Date(requestedAt.getTime() - age),
        ],
      );
    }
    const deadOverview = await api.get(`/projects/${project.key}/health`);
    const infraAttention = deadOverview.body.attention.filter((item: HostedDynamic) => item.kind === "infra");
    assert.equal(infraAttention.length, 1, "one run group produces one infrastructure attention row");
    assert.equal(infraAttention[0].run_group_id, mixed);
    assert.equal(infraAttention[0].workflow_run_url, "https://gha.invalid/dead-new",
      "the row keeps the newest dispatch attempt");
    assert.equal(infraAttention[0].note, "runner stopped before the run finished");

    // --- a canceled run is never attention, even holding a failed story ---
    // Cancellation is a decision the person already made; a story that failed
    // before they pulled the plug doesn't put the run back on their desk.
    const launched = await api.post(`/projects/${project.key}/run-groups`, {
      suite_id: suite.id, ring_id: ring.id, selection: { mode: "auto" }, note: "abandoned",
    });
    const abandonedId = launched.body.run_group.id;
    const exchanged = await fetch(`${base}/api/v1/runner/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ github_oidc_token: "mock", run_group_id: abandonedId, isolation: "process" }),
    }).then((r) => r.json());
    const headers = { authorization: `Bearer ${exchanged.token}`, "content-type": "application/json" };
    const spec = await fetch(`${base}/api/v1/runner/groups/${abandonedId}`, { headers }).then((r) => r.json());
    const first: HostedDynamic = spec.cases[0];
    assert.equal((await fetch(`${base}/api/v1/runner/groups/${abandonedId}/cases/${first.run_id}/start`, {
      method: "POST", headers, body: "{}",
    })).status, 200);
    const abandonedBundle = (await fetch(`${base}/api/v1/runner/runs/${first.db_id}/bundle`, {
      method: "PUT",
      headers: { authorization: `Bearer ${exchanged.token}`, "content-type": "application/vnd.playtest.run-bundle" },
      body: Buffer.from(`bundle for ${first.case_id}`),
    }).then((r) => r.json())).artifact;
    const reported = await fetch(`${base}/api/v1/runner/groups/${abandonedId}/cases/${first.run_id}/report`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        status: "fail", score: 20, bundle: abandonedBundle,
        manifest: {
          run_id: first.run_id,
          case: { id: first.case_id },
          status: "fail",
          duration_ms: 2100,
          totals: { steps: 3, cost_usd: 0.02 },
        },
      }),
    });
    assert.equal(reported.status, 200, await reported.text());
    assert.equal((await api.post(`/run-groups/${abandonedId}/cancel`, {})).status, 200);
    const afterCancel = await api.get(`/projects/${project.key}/run-groups?outcome=attention`);
    assert.deepEqual(afterCancel.body.items.map((g: HostedDynamic) => g.id), [regressed],
      "a canceled run stays off the attention list even when a story failed before the cancel");

    // --- filters compose, and a suite with no runs is an honest empty page ---
    const bySuite = await api.get(`/projects/${project.key}/run-groups?suite=${suite.id}&outcome=attention`);
    assert.deepEqual(bySuite.body.items.map((g: HostedDynamic) => g.id), [regressed]);
    const otherSuite = (await api.post(`/projects/${project.key}/suites`, { slug: "empty", name: "Empty" })).body;
    const none = await api.get(`/projects/${project.key}/run-groups?suite=${otherSuite.id}&include=runs`);
    assert.deepEqual(none.body.items, []);
  }, {}, { github });
});

test("runs index: a run in flight reports progress, not a duration", async () => {
  const github = new MockGitHub();
  await withApp(async ({ api, base }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "runsflight", name: "In flight" })).body;
    const { ring } = await createTarget(api, project, {
      key: "todos",
      name: "Todos",
      ringKey: "staging",
      baseUrl: "http://127.0.0.1:9",
      runnerLabels: ["self-hosted", "playtest"],
      config: { secret_env: {} },
    });
    const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "todos", name: "Todos" })).body;
    const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`));
    assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);
    const groupId = (await api.post(`/projects/${project.key}/run-groups`, {
      suite_id: suite.id, ring_id: ring.id, selection: { mode: "auto" },
    })).body.run_group.id;

    // Dispatched, nothing started: three stories, nothing done, no clock to show.
    const queued = (await api.get(`/projects/${project.key}/run-groups`)).body.items[0];
    assert.ok(["queued", "running"].includes(queued.status), `dispatched run was "${queued.status}"`);
    assert.equal(queued.stats.total, 3);
    assert.equal(queued.stats.queued, 3);
    assert.equal(queued.stats.done, 0);
    assert.equal(queued.stats.duration_ms, null);
    assert.equal(queued.stats.started_at, null);

    const exchanged = await fetch(`${base}/api/v1/runner/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ github_oidc_token: "mock", run_group_id: groupId, isolation: "process" }),
    }).then((r) => r.json());
    const headers = { authorization: `Bearer ${exchanged.token}`, "content-type": "application/json" };
    const spec = await fetch(`${base}/api/v1/runner/groups/${groupId}`, { headers }).then((r) => r.json());
    const [first, second] = spec.cases;
    for (const c of [first, second]) {
      await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${c.run_id}/start`, { method: "POST", headers, body: "{}" });
    }
    const bundle = (await fetch(`${base}/api/v1/runner/runs/${first.db_id}/bundle`, {
      method: "PUT",
      headers: { authorization: `Bearer ${exchanged.token}`, "content-type": "application/vnd.playtest.run-bundle" },
      body: Buffer.from("bundle"),
    }).then((r) => r.json())).artifact;
    await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${first.run_id}/report`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        status: "pass",
        bundle,
        manifest: { run_id: first.run_id, case: { id: first.case_id }, status: "pass", duration_ms: 900, totals: { steps: 2, cost_usd: 0.01 } },
      }),
    });

    const live = (await api.get(`/projects/${project.key}/run-groups?include=runs`)).body.items[0];
    assert.equal(live.stats.total, 3, "the run still knows how many stories it has");
    assert.equal(live.stats.done, 1);
    assert.equal(live.stats.running, 1, "one story started and has not reported");
    assert.equal(live.stats.queued, 1);
    // The one story that HAPPENED to finish is not the run's duration: reporting
    // it would make an in-flight run's clock jump backwards as others finish.
    assert.equal(live.stats.duration_ms, null, "an unsettled run reports no wall clock");
    assert.equal(live.stats.finished_at, null);
    assert.ok(live.stats.started_at, "but it does say when the work began");
    assert.equal(live.runs.filter((r: HostedDynamic) => r.status === "running").length, 1);

    // --- live progress: the runner's throttled snapshot rides the projection ---
    const posted = await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${second.run_id}/progress`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        step: 4, max_steps: 20, doing: "recording", action: 'clicked "Add"',
        cost_usd: 0.02, tokens: { ctx: 3400, in: 17700, out: 1300 },
        model: "claude-sonnet-5", junk: "dropped", nested: { junk: true },
      }),
    });
    assert.equal(posted.status, 200, await posted.text());
    const streaming = (await api.get(`/projects/${project.key}/run-groups?include=runs`)).body.items[0];
    const moving = streaming.runs.find((r: HostedDynamic) => r.status === "running");
    assert.equal(moving.progress.step, 4);
    assert.equal(moving.progress.max_steps, 20);
    assert.equal(moving.progress.doing, "recording");
    assert.equal(moving.progress.action, 'clicked "Add"');
    assert.ok(Math.abs(moving.progress.cost_usd - 0.02) < 1e-9);
    assert.deepEqual(moving.progress.tokens, { ctx: 3400, in: 17700, out: 1300 });
    assert.equal(moving.progress.junk, undefined, "the wire body is whitelisted, never stored verbatim");
    const settled = streaming.runs.find((r: HostedDynamic) => r.case_id === first.case_id);
    assert.equal(settled.progress, null, "a finished story never carries live progress");

    // A late tick for a story that already reported lands nowhere: the report
    // is the truth, and a stale snapshot must not repaint a finished row as live.
    const late = await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${first.run_id}/progress`, {
      method: "POST", headers, body: JSON.stringify({ step: 9, doing: "recording" }),
    });
    assert.equal(late.status, 200, "telemetry is best-effort — a late tick is not an error");
    const afterLate = (await api.get(`/projects/${project.key}/run-groups?include=runs`)).body.items[0];
    assert.equal(afterLate.runs.find((r: HostedDynamic) => r.case_id === first.case_id).progress, null);

    // Progress reaches the console over the feed as a run.event, so the live
    // page repaints from an event, never a poll.
    const feed = (await api.get(`/projects/${project.key}/events/feed?after=00000000000000000000000000&wait=0&types=run.event`)).body;
    assert.ok(feed.events.some((e: HostedDynamic) => e.payload?.type === "progress" && e.payload.step === 4),
      "a progress tick is announced on the project feed");

    // The report clears the snapshot — the manifest is the finished truth.
    const bundle2 = (await fetch(`${base}/api/v1/runner/runs/${second.db_id}/bundle`, {
      method: "PUT",
      headers: { authorization: `Bearer ${exchanged.token}`, "content-type": "application/vnd.playtest.run-bundle" },
      body: Buffer.from("bundle 2"),
    }).then((r) => r.json())).artifact;
    await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${second.run_id}/report`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        status: "pass",
        bundle: bundle2,
        manifest: { run_id: second.run_id, case: { id: second.case_id }, status: "pass", duration_ms: 1100, totals: { steps: 4, cost_usd: 0.03 } },
      }),
    });
    const reported = (await api.get(`/projects/${project.key}/run-groups?include=runs`)).body.items[0];
    assert.equal(reported.runs.find((r: HostedDynamic) => r.case_id === second.case_id).progress, null,
      "the case report clears the live snapshot");
  }, {}, { github });
});
