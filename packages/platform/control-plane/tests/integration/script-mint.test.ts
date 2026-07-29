// Pins the `script` auth-provider single-flight mint broker: the winning
// claimer gets the resolved secrets and code (a mint grant),
// everyone else gets a wait ticket on the same claim id, and fulfill (success
// or failure) resolves the grant so the next claimer either inherits the
// session or takes over the mint.
import test from "node:test";
import assert from "node:assert/strict";
import { withApp, createTarget, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";
import { claimAndExchange, claimer, registerRunner } from "./exec-helpers.ts";

/** The ring's routing labels: a provider bound to it mints on those runners. */
const RING_LABELS = ["staging-box"];

async function setupFixture(api: HostedDynamic, { projectKey = "scriptmint" } = {}) {
  const project = (await api.post("/projects", { key: projectKey, name: "Script Mint" })).body;
  // The application and its ring come first: a suite binds to an application at
  // creation, and the ring owns both the URL and the logical auth overlay.
  const { ring, application } = await createTarget(api, project, {
    key: "todos",
    name: "Todos",
    ringKey: "staging",
    baseUrl: "http://127.0.0.1:9",
    runnerLabels: RING_LABELS,
    config: {
      auth: { default: "member", identities: { member: { $session: "sso/member" } } },
      secret_env: {},
    },
  });
  const suite = (await api.post(`/projects/${projectKey}/suites`, { slug: "todos", name: "Todos" })).body;
  const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`));
  assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);
  assert.equal(
    (await api.post(`/projects/${projectKey}/secrets`, { name: "sso-pass", value: "hunter2-super-secret" })).status,
    201,
  );
  const provider = (await api.post(`/projects/${projectKey}/auth-providers`, {
    name: "sso",
    kind: "script",
    code: `console.log(JSON.stringify({cookies:[],origins:[]}))`,
    config: { secret_env: { SSO_PASSWORD: "sso-pass" } },
    identities: { member: { username: "qa-member" } },
    ttl_minutes: 45,
    // Bound to the ring whose `auth.identities` name it: the ring's credentials
    // are reachable from that ring and nowhere else.
    ring_id: ring.id,
  })).body;
  return { project, projectKey, suite, ring, application, provider };
}

async function launchGroup(api: HostedDynamic, projectKey: HostedDynamic, { suiteId, ringId }: HostedDynamic) {
  const launched = await api.post(`/projects/${projectKey}/run-groups`, {
    suite_id: suiteId,
    ring_id: ringId,
    selection: { ids: ["add-todo"], mode: "auto" },
  });
  assert.equal(launched.status, 200, JSON.stringify(launched.body));
  return launched.body.run_group.id;
}

/**
 * Two CONCURRENTLY LIVE executors in one project — two run groups, two runners,
 * two dispatches — which is what the single-flight session broker actually
 * arbitrates between.
 *
 * It used to be two exchanges against ONE dispatch, but an attempt has exactly
 * one current executor now: a re-exchange fences the bearer before it, so the
 * two halves of these races could never both act (docs/contracts/hosted.md,
 * "Current executor fencing").
 */
async function twoExecutors(
  api: HostedDynamic,
  base: HostedDynamic,
  projectKey: HostedDynamic,
  groupId: HostedDynamic,
  { suiteId, ringId }: HostedDynamic,
): Promise<[HostedDynamic, HostedDynamic]> {
  const project = { key: projectKey };
  const first = await claimAndExchange(api, base, { project, groupId, labels: RING_LABELS });
  const secondGroup = await launchGroup(api, projectKey, { suiteId, ringId });
  const second = await claimAndExchange(api, base, { project, groupId: secondGroup, labels: RING_LABELS });
  return [
    { token: first.token, executor_id: first.executorId },
    { token: second.token, executor_id: second.executorId },
  ];
}

function runnerHeaders(token: HostedDynamic) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function claim(base: HostedDynamic, token: HostedDynamic, refs: HostedDynamic, wait?: HostedDynamic) {
  const res = await fetch(`${base}/api/v1/runner/sessions/claim`, {
    method: "POST",
    headers: runnerHeaders(token),
    body: JSON.stringify(wait != null ? { sessions: refs, wait } : { sessions: refs }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function fulfill(base: HostedDynamic, token: HostedDynamic, claimId: HostedDynamic, payload: HostedDynamic) {
  const res = await fetch(`${base}/api/v1/runner/sessions/${claimId}/fulfill`, {
    method: "POST",
    headers: runnerHeaders(token),
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  return { status: res.status, body };
}

test("script claim hands one mint grant and fulfill caches the session", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const { projectKey, provider, suite, ring } = await setupFixture(api);
    const groupId = await launchGroup(api, projectKey, { suiteId: suite.id, ringId: ring.id });

    // Two executors on one group, each claiming through the bearer it just
    // exchanged for — the order a real pair of jobs takes.
    const [exA, exB] = await twoExecutors(api, base, projectKey, groupId, { suiteId: suite.id, ringId: ring.id });
    const claimedA = await claim(base, exA.token, ["sso/member"]);

    assert.equal(claimedA.status, 200, JSON.stringify(claimedA.body));
    const refA = claimedA.body.sessions["sso/member"];
    assert.equal(refA.pending, true);
    assert.ok(refA.mint, "first claimer gets a mint grant");
    assert.ok(refA.mint.claim_id);
    assert.match(refA.mint.code, /console\.log/);
    assert.equal(refA.mint.env.SSO_PASSWORD, "hunter2-super-secret");
    assert.equal(refA.mint.identity_config.username, "qa-member");

    const claimedB = await claim(base, exB.token, ["sso/member"]);
    assert.equal(claimedB.status, 200);
    const refB = claimedB.body.sessions["sso/member"];
    assert.equal(refB.pending, true);
    assert.ok(refB.wait, "second claimer waits on the existing grant");
    assert.equal(refB.wait.claim_id, refA.mint.claim_id);

    const fulfilled = await fulfill(base, exA.token, refA.mint.claim_id, {
      storage_state: { cookies: [{ name: "sid", value: "s3cr3t-cookie" }], origins: [] },
    });
    assert.equal(fulfilled.status, 200, JSON.stringify(fulfilled.body));
    assert.equal(fulfilled.body.session.storage_state.cookies[0].value, "s3cr3t-cookie");
    assert.ok(fulfilled.body.session.expires_at);

    const reclaimedB = await claim(base, exB.token, ["sso/member"]);
    assert.equal(reclaimedB.status, 200);
    const refB2 = reclaimedB.body.sessions["sso/member"];
    assert.ok(!refB2.pending, "B now gets the cached session, not a pending ticket");
    assert.equal(refB2.storage_state.cookies[0].value, "s3cr3t-cookie");

    const sessions = await api.get(`/auth-providers/${provider.id}/sessions`);
    assert.equal(sessions.body.items.length, 1);
    assert.equal(sessions.body.items[0].identity, "member");
    assert.equal(sessions.body.items[0].minted_by_job, exA.executor_id);
    assert.equal(sessions.body.items[0].storage_state, undefined, "listing never carries session bytes");

    const audit = await api.get(`/projects/${projectKey}/audit`);
    const actions = audit.body.items.map((a: HostedDynamic) => a.action);
    assert.ok(actions.includes("session.mint_granted"));
    assert.ok(actions.includes("session.minted"));
    assert.ok(actions.includes("session.delivered"));
  });
});

test("failed mint deletes the claim so the next claimer takes over", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const { projectKey, suite, ring } = await setupFixture(api, { projectKey: "scriptmintfail" });
    const groupId = await launchGroup(api, projectKey, { suiteId: suite.id, ringId: ring.id });

    const [exA, exB] = await twoExecutors(api, base, projectKey, groupId, { suiteId: suite.id, ringId: ring.id });
    const claimedA = await claim(base, exA.token, ["sso/member"]);
    const grantA = claimedA.body.sessions["sso/member"].mint;
    assert.ok(grantA);

    const failed = await fulfill(base, exA.token, grantA.claim_id, { error: "idp exploded" });
    assert.equal(failed.status, 200, JSON.stringify(failed.body));

    const audit = await api.get(`/projects/${projectKey}/audit`);
    const mintFailed = audit.body.items.find((a: HostedDynamic) => a.action === "session.mint_failed");
    assert.ok(mintFailed, "audit records the failed mint");
    assert.match(mintFailed.detail.error, /idp exploded/);

    const claimedB = await claim(base, exB.token, ["sso/member"]);
    const grantB = claimedB.body.sessions["sso/member"].mint;
    assert.ok(grantB, "B gets a fresh mint grant after A's failure");
    assert.notEqual(grantB.claim_id, grantA.claim_id);

    const staleFulfill = await fulfill(base, exA.token, grantA.claim_id, {
      storage_state: { cookies: [], origins: [] },
    });
    assert.ok(
      [404, 409].includes(staleFulfill.status),
      `expected 404 or 409 for a deleted claim, got ${staleFulfill.status}`,
    );
    assert.ok(staleFulfill.body.error?.code, "envelope carries an error code");
    assert.equal(staleFulfill.body.error.code, "not_found");
  });
});

test("fulfill is executor-scoped, and a retry redelivers rather than re-fulfilling", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const { projectKey, suite, ring } = await setupFixture(api, { projectKey: "scriptmintscope" });
    const groupId = await launchGroup(api, projectKey, { suiteId: suite.id, ringId: ring.id });

    const [exA, exB] = await twoExecutors(api, base, projectKey, groupId, { suiteId: suite.id, ringId: ring.id });
    const claimedA = await claim(base, exA.token, ["sso/member"]);
    const grantA = claimedA.body.sessions["sso/member"].mint;
    assert.ok(grantA);

    const wrongExecutor = await fulfill(base, exB.token, grantA.claim_id, {
      storage_state: { cookies: [], origins: [] },
    });
    assert.equal(wrongExecutor.status, 403);
    assert.equal(wrongExecutor.body.error.code, "forbidden");

    const ok = await fulfill(base, exA.token, grantA.claim_id, {
      storage_state: { cookies: [{ name: "sid", value: "once" }], origins: [] },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    // A fulfillment whose RESPONSE was lost is retried by the executor that
    // produced it, and the mint script has already run: answering `conflict`
    // would push a runner into reporting a failure it did not have, or into
    // minting again. So the retry REDELIVERS the stored session — the grant is
    // still fulfilled exactly once, and a second set of bytes never overwrites
    // the winner's artifact (B4, docs/contracts/hosted.md).
    const again = await fulfill(base, exA.token, grantA.claim_id, {
      storage_state: { cookies: [{ name: "sid", value: "a-second-mint-that-never-happened" }], origins: [] },
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.redelivered, true);
    assert.equal(again.body.session.storage_state.cookies[0].value, "once", "the stored result, not the retry's bytes");

    // Anyone else retrying it is still refused outright.
    const notMine = await fulfill(base, exB.token, grantA.claim_id, {
      storage_state: { cookies: [], origins: [] },
    });
    assert.equal(notMine.status, 409);
    assert.equal(notMine.body.error.code, "conflict");
  });
});

test("claim wait-hold returns as soon as the winner fulfills", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const { suite, ring, projectKey } = await setupFixture(api, { projectKey: "scriptmintwait" });
    const groupId = await launchGroup(api, projectKey, { suiteId: suite.id, ringId: ring.id });

    const [exA, exB] = await twoExecutors(api, base, projectKey, groupId, { suiteId: suite.id, ringId: ring.id });
    const claimedA = await claim(base, exA.token, ["sso/member"]);
    const grantA = claimedA.body.sessions["sso/member"].mint;
    assert.ok(grantA);

    const started = Date.now();
    const waitPromise = claim(base, exB.token, ["sso/member"], 15);

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const fulfilled = await fulfill(base, exA.token, grantA.claim_id, {
      storage_state: { cookies: [{ name: "sid", value: "delivered-late" }], origins: [] },
    });
    assert.equal(fulfilled.status, 200, JSON.stringify(fulfilled.body));

    const waited = await waitPromise;
    const elapsed = Date.now() - started;
    assert.equal(waited.status, 200);
    const refB = waited.body.sessions["sso/member"];
    assert.ok(!refB.pending, "wait-hold returns the session once fulfilled");
    assert.equal(refB.storage_state.cookies[0].value, "delivered-late");
    assert.ok(elapsed < 10_000, `expected the wait to return promptly, took ${elapsed}ms`);
  });
});

test("codeless script provider degrades to a per-ref claim error", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const projectKey = "scriptmintcodeless";
    const project = (await api.post("/projects", { key: projectKey, name: "Codeless" })).body;
    const { ring } = await createTarget(api, project, {
      key: "todos",
      name: "Todos",
      ringKey: "staging",
      baseUrl: "http://127.0.0.1:9",
      config: {
        auth: { default: "member", identities: { member: { $session: "sso/member" } } },
        secret_env: {},
      },
    });
    const suite = (await api.post(`/projects/${projectKey}/suites`, { slug: "todos", name: "Todos" })).body;
    const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`));
    assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);
    await api.post(`/projects/${projectKey}/auth-providers`, {
      name: "sso",
      kind: "script",
      code: null,
      config: {},
      identities: { member: { username: "qa-member" } },
      ttl_minutes: 45,
      ring_id: ring.id,
    });
    const groupId = await launchGroup(api, projectKey, { suiteId: suite.id, ringId: ring.id });
    const [ex] = await twoExecutors(api, base, projectKey, groupId, { suiteId: suite.id, ringId: ring.id });
    const claimed = await claim(base, ex.token, ["sso/member"]);
    // Degrades per-ref (§3a): the claim answers 200 and the broken provider's
    // friendly message rides `{error}` on its ref — a 4xx/5xx here killed the
    // executor before any case started.
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    const ref = claimed.body.sessions["sso/member"];
    assert.ok(ref?.error, JSON.stringify(claimed.body));
    assert.match(ref.error, /sso/);
    assert.match(ref.error, /no mint script code/);
  });
});

// A forced mint on a script provider posts a standalone `mint` entry to the
// claim board (202 + pending claim). The full runner round-trip is pinned by
// phase7-mint-dispatch.test.ts; this pins the API shape, the ledger row, and
// the routing and target a mint inherits from the provider's binding.
test("force-mint on a script provider posts a mint to the board, routed and targeted by its ring", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const { project, projectKey, provider, ring, application } = await setupFixture(api, { projectKey: "scriptmintforce" });
    const res = await api.post(`/auth-providers/${provider.id}/mint`, {});
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.mint.pending, true);
    assert.ok(res.body.mint.claim_id);
    const dispatches = await api.get(`/projects/${projectKey}/dispatches`);
    const row: HostedDynamic = dispatches.body.items.find((d: HostedDynamic) => d.id === res.body.mint.dispatch_id);
    // Placement started nothing: the requested row IS the board entry.
    assert.equal(row.status, "requested", JSON.stringify(row));

    // A ring-bound provider mints on the ring's own runners: the mint's board
    // entry carries the ring's labels, so credentials only ever land on a
    // machine that ring already trusts with them.
    const bound = await app.db.query(`SELECT labels, target FROM dispatches WHERE id = $1`, [res.body.mint.dispatch_id]);
    assert.deepEqual(bound.rows[0].labels, RING_LABELS);
    assert.equal(bound.rows[0].target.ring_key, ring.key);
    assert.equal(bound.rows[0].target.application_key, application.key);

    // And the offer a runner reads names the project on the envelope and
    // carries that ring as its target block.
    const runner = claimer(base, (await registerRunner(api, project, { labels: RING_LABELS })).credential);
    const offered = await runner.poll();
    const offer = offered.body.offers.find((o: HostedDynamic) => o.mint_claim_id === res.body.mint.claim_id);
    assert.ok(offer, JSON.stringify(offered.body));
    assert.equal(offer.project_key, projectKey);
    assert.deepEqual(offer.target, {
      application_id: application.id,
      application_key: application.key,
      ring_id: ring.id,
      ring_key: ring.key,
      driver: "web",
      platform: null,
      base_url: "http://127.0.0.1:9",
    });

    // A project-wide provider (null `ring_id`) has no ring to inherit from and
    // keeps the empty-label, null-target mint any runner in the project takes —
    // with its project still named on the envelope.
    const anywhere = (await api.post(`/projects/${projectKey}/auth-providers`, {
      name: "sso-anywhere",
      kind: "script",
      code: `console.log(JSON.stringify({cookies:[],origins:[]}))`,
      config: {},
      identities: { member: { username: "qa-member" } },
      ttl_minutes: 45,
    })).body;
    assert.equal(anywhere.ring_id, null);
    const wide = await api.post(`/auth-providers/${anywhere.id}/mint`, {});
    assert.equal(wide.status, 202, JSON.stringify(wide.body));
    const wideRow = await app.db.query(`SELECT labels, target FROM dispatches WHERE id = $1`, [wide.body.mint.dispatch_id]);
    assert.deepEqual(wideRow.rows[0].labels, []);
    assert.equal(wideRow.rows[0].target, null);
    const wideOffer = (await runner.poll()).body.offers.find((o: HostedDynamic) => o.mint_claim_id === wide.body.mint.claim_id);
    assert.ok(wideOffer, "an unlabelled mint is offered to any runner in the project");
    assert.equal(wideOffer.project_key, projectKey);
    assert.equal(wideOffer.target, null);
  });
});
