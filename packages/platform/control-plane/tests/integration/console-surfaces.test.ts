// R4: what the console reads to stay honest without polling anything.
//
// Three server behaviours the hosted web UI depends on, none of which the
// browser can compensate for:
//
//   1. `/me` capabilities say whether this deployment places runs on a runner
//      pool at all, so the console offers runner setup only where it exists;
//   2. `runner.status` rides the event feed on the EDGES of presence — a runner
//      arriving, coming back, taking a claim, being revoked — and stays silent
//      while a fleet idles, which is what lets a Runners section repaint off
//      the feed instead of a timer;
//   3. `GET /run-groups/:id?wait=true` actually holds, as the automation
//      contract has claimed since it was written.
import test from "node:test";
import assert from "node:assert/strict";
import { withApp, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";

const POOL = { PLAYTEST_DISPATCH: "pool" };

/** A scripted self-hosted runner: nothing but its credential and fetch. */
function claimer(base: HostedDynamic, credential: HostedDynamic) {
  const call = async (method: HostedDynamic, path: HostedDynamic, body?: HostedDynamic) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${credential}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return {
    poll: (query = "") => call("GET", `/runner/pool/claims${query}`),
    claim: (dispatchId: HostedDynamic) => call("POST", `/runner/pool/claims/${dispatchId}`, {}),
  };
}

const feedSince = async (api: HostedDynamic, key: HostedDynamic, cursor: HostedDynamic, types = "runner.status") =>
  (await api.get(`/projects/${key}/events/feed?after=${cursor}&types=${types}`)).body;

const tail = async (api: HostedDynamic, key: HostedDynamic) => (await api.get(`/projects/${key}/events/feed`)).body.cursor;

test("me: capabilities say whether this deployment has a runner pool at all", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const me = (await api.get("/me")).body;
    assert.equal(me.capabilities.pool_dispatch, false,
      "the default deployment places runs itself — runner setup would be a dead end");
    // Stated whatever the adapter, because the console words its environment
    // upload cap and its presence dot from these numbers, not from its own guess.
    assert.equal(me.capabilities.app_artifact_max_mb, 512);
    assert.ok(me.capabilities.runner_check_in_window_s >= 75);
  });

  await withApp(async ({ api }: HostedDynamic) => {
    const me = (await api.get("/me")).body;
    assert.equal(me.capabilities.pool_dispatch, true);
    // The window the console calls a runner offline at is the server's own
    // patience, never a browser-side constant that can drift from it.
    assert.equal(me.capabilities.runner_check_in_window_s, 120);
  }, POOL);

  await withApp(async ({ api }: HostedDynamic) => {
    const caps = (await api.get("/me")).body.capabilities;
    assert.equal(caps.runner_check_in_window_s, 75,
      "a tight heartbeat never drops the floor: an IDLE runner still polls every 25s");
    assert.equal(caps.app_artifact_max_mb, 128, "the console states this deployment's cap, not a default");
  }, { ...POOL, PLAYTEST_POOL_HEARTBEAT_TIMEOUT_S: "30", PLAYTEST_APP_ARTIFACT_MAX_MB: "128" });
});

test("runner.status: presence rides the feed on its edges, and idles silently", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "presence", name: "Presence" })).body;
    let cursor = await tail(api, project.key);

    // Registering is an edge: another person's console learns about the new
    // runner without asking again.
    const runner = (await api.post(`/projects/${project.key}/runners`, { name: "adas-laptop", labels: ["macos"] })).body;
    let events = await feedSince(api, project.key, cursor);
    assert.deepEqual(events.events.map((e: HostedDynamic) => e.payload.state), ["registered"]);
    assert.equal(events.events[0].entity.runner_id, runner.id);
    assert.equal(events.events[0].payload.name, "adas-laptop");
    cursor = events.cursor;

    const agent = claimer(base, runner.credential);
    // First check-in: the runner was registered but had never been heard from,
    // so this is the arrival a console repaints on.
    assert.equal((await agent.poll("?labels=macos")).status, 200);
    events = await feedSince(api, project.key, cursor);
    assert.deepEqual(events.events.map((e: HostedDynamic) => e.payload.state), ["online"]);
    cursor = events.cursor;

    // The steady state is SILENCE. A runner polls every 25 seconds forever; an
    // event per poll would be a timer wearing the feed's clothes, and every
    // console watching would repaint for a fact that did not change.
    for (let i = 0; i < 3; i++) assert.equal((await agent.poll("?labels=macos")).status, 200);
    assert.deepEqual((await feedSince(api, project.key, cursor)).events, []);
    // …but the check-in still lands, so presence is fresh for whoever asks.
    const listed = (await api.get(`/projects/${project.key}/runners`)).body.items[0];
    assert.ok(listed.last_seen_at, "every check-in updates last_seen_at, event or not");

    // Re-advertising is an edge too: which jobs this machine can take changed.
    assert.equal((await agent.poll("?labels=macos,ios-sim")).status, 200);
    events = await feedSince(api, project.key, cursor);
    assert.deepEqual(events.events.map((e: HostedDynamic) => e.payload.state), ["online"]);
    assert.deepEqual(events.events[0].payload.labels, ["macos", "ios-sim"]);
    cursor = events.cursor;

    // Revoking is the last edge.
    assert.equal((await api.del(`/projects/${project.key}/runners/${runner.id}`)).status, 204);
    events = await feedSince(api, project.key, cursor);
    assert.deepEqual(events.events.map((e: HostedDynamic) => e.payload.state), ["revoked"]);
  }, POOL);
});

test("runner.status: a claim says which run group the runner is executing", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "claimev", name: "Claim" })).body;
    const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "todos", name: "Todos" })).body;
    await api.postTar(`/suites/${suite.id}/import`, writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`)));
    const env = (await api.post(`/projects/${project.key}/environments`, {
      name: "laptop", runner_labels: ["macos"], config: { app: { base_url: "http://127.0.0.1:9" } },
    })).body;
    const runner = (await api.post(`/projects/${project.key}/runners`, { name: "mac", labels: ["macos"] })).body;
    const group = (await api.post(`/projects/${project.key}/run-groups`, {
      suite_id: suite.id, environment_id: env.id, selection: { ids: ["add-todo"] },
    })).body.run_group;

    const agent = claimer(base, runner.credential);
    const cursor = await tail(api, project.key);
    const offer = (await agent.poll("?labels=macos")).body.claim;
    assert.equal((await agent.claim(offer.dispatch_id)).status, 200);

    const events = (await feedSince(api, project.key, cursor)).events;
    const claimed = events.find((e: HostedDynamic) => e.payload.state === "claimed");
    assert.ok(claimed, "the console links a busy runner to the run it is executing");
    assert.equal(claimed.payload.run_group_id, group.id);
    // And the same fact is readable without the feed, for a console arriving late.
    const listed = (await api.get(`/projects/${project.key}/runners`)).body.items[0];
    assert.equal(listed.claim.run_group_id, group.id);
  }, POOL);
});

test("run groups: ?wait=true holds for a verdict instead of answering at once", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "waiting", name: "Waiting" })).body;
    const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "todos", name: "Todos" })).body;
    await api.postTar(`/suites/${suite.id}/import`, writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`)));
    const env = (await api.post(`/projects/${project.key}/environments`, {
      name: "laptop", runner_labels: ["nobody"], config: { app: { base_url: "http://127.0.0.1:9" } },
    })).body;
    const group = (await api.post(`/projects/${project.key}/run-groups`, {
      suite_id: suite.id, environment_id: env.id, selection: { ids: ["add-todo"] },
    })).body.run_group;

    // Nothing will claim this — the automation client is meant to be held, not
    // handed a "queued" it would have to poll around.
    const started = Date.now();
    const held = api.get(`/run-groups/${group.id}?wait=3`);
    const answer = await held;
    assert.equal(answer.status, 200);
    assert.ok(Date.now() - started >= 2_500, `held ${Date.now() - started}ms — wait=3 must actually hold`);
    assert.equal(answer.body.status, "queued", "an unsettled group is still answered at the deadline");

    // Cancelling settles it; the next held read returns as soon as it can see that.
    await api.post(`/run-groups/${group.id}/cancel`, {});
    const after = Date.now();
    const settled = await api.get(`/run-groups/${group.id}?wait=20`);
    assert.equal(settled.body.status, "canceled");
    assert.ok(Date.now() - after < 2_000, "a settled group answers immediately, hold or no hold");
    assert.ok(Array.isArray(settled.body.runs), "the held answer is the same run-group projection");
  }, POOL);
});
