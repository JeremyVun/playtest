// Mobile placement through runner bindings, at the board level — no simulator.
//
// Covered here, by acceptance gate:
//   4  a mobile launch is claimable only by a runner whose config binds the
//      offered (application, ring): an unbound runner skips it LOCALLY and a
//      bound one claims the same offer
//   10 a post-claim mobile preflight failure produces ONE actionable infra
//      error, not a mid-case driver stack
//   9  no platform-managed record or response — application, ring, offer,
//      dispatch target snapshot, group, run, executor, audit row, evidence
//      projection, platform event — carries a mobile build path, a device id
//      or an Appium endpoint. Verbatim authored suite source is the one stated
//      exception, and it is proved to BE one here rather than assumed.
//
// Nothing below needs a device. The physical facts are real on the runner's
// side — a `.app` on this disk, a device name, an Appium endpoint that really
// answers `/status` — and the whole point is that none of the three ever cross
// to the control plane. Real-simulator execution is the explicit `test:mobile`
// tier (`tests/mobile/pool-mobile.test.ts`).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { withApp, createTarget } from "./helpers.ts";
import { assertNoPhysicalFacts, bundleFor, claimAndExchange, registerRunner, startPoolAgent, untilAgent as until } from "./exec-helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";

/**
 * The three machine-local facts this file is about. They are deliberately
 * distinctive strings: every assertion below is "this text is nowhere in what
 * the platform stored or served", so a substring that could occur by accident
 * would make the sweep meaningless.
 */
const DEVICE = "iPhone Runner-Local 99";

/** A runner-side scratch directory holding a build the platform never sees. */
function runnerDisk(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `runner-disk-${name}-`));
  const app = path.join(dir, "RunnerLocalFixture.app");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "RunnerLocalFixture"), "not a real binary\n");
  return { dir, app, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * An Appium that answers `/status` and nothing else. That is exactly the surface
 * the runner's pre-claim `startable()` probe and its post-claim preflight ask
 * about, so an external backend is fully exercisable with no device anywhere.
 */
function startAppiumStub(): Promise<HostedDynamic> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req: HostedDynamic, res: HostedDynamic) => {
      if (req.method === "GET" && req.url === "/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ value: { ready: true, message: "stub" } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: { error: "unknown command", message: `no route ${req.method} ${req.url}` } }));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as HostedDynamic;
      resolve({ port, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/**
 * A runner's own `runner.yaml`: the file that holds what no platform record may.
 * Written on the runner's disk, passed with `--config`, and never uploaded.
 */
function writeRunnerConfig(dir: string, { labels, app, appiumUrl }: HostedDynamic) {
  const file = path.join(dir, "runner.yaml");
  fs.writeFileSync(
    file,
    [
      "version: 1",
      `labels: [${labels.join(", ")}]`,
      "targets:",
      "  todo-ios:",
      "    local:",
      "      platform: ios",
      `      app: ${app}`,
      "      backend: bench-ios",
      `      device: ${DEVICE}`,
      "mobile:",
      "  backends:",
      "    bench-ios:",
      "      platform: ios",
      "      appium:",
      "        mode: external",
      `        url: ${appiumUrl}`,
      "",
    ].join("\n"),
  );
  return file;
}

/** The mobile suite a hosted project holds: one story, no physical target. */
const MOBILE_SUITE = {
  "playtest.yaml": "app:\n  driver: mobile\n  platform: ios\n",
  "stories/open-app.yaml":
    "story: open the app and read the list\nsuccess:\n  - screen_shows: \"~app-title\"\nlimits:\n  max_steps: 3\n",
};

/**
 * The same suite, authoring physical fields. Gate 9's ONE stated exception:
 * suite files are stored and exported verbatim for CLI use and may contain
 * these, and hosted execution provably ignores them (gate 8). The values are
 * deliberately different from the runner's real ones, so a sweep can tell
 * "authored, inert" from "runner-resolved, leaked" apart.
 */
const AUTHORED_APP = "/authored/only/NeverInstalled.app";
const AUTHORED_DEVICE = "iPad Authored Only";
const AUTHORED_APPIUM = "http://authored-only.invalid:4723";
const AUTHORED_SUITE = {
  "playtest.yaml":
    `app:\n  driver: mobile\n  platform: ios\n  app: ${AUTHORED_APP}\n` +
    `  device: ${AUTHORED_DEVICE}\n  appium_url: ${AUTHORED_APPIUM}\n`,
  "stories/open-app.yaml": MOBILE_SUITE["stories/open-app.yaml"],
};

async function setUpMobileProject(
  api: HostedDynamic,
  key: string,
  { labels, files = MOBILE_SUITE, config = { app: { settle: 250 } } }: HostedDynamic,
) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const { application, ring } = await createTarget(api, project, {
    key: "todo-ios",
    name: "Todo iOS",
    driver: "mobile",
    platform: "ios",
    ringKey: "local",
    ringName: "Local",
    runnerLabels: labels,
    config,
  });
  const suite = (await api.post(`/projects/${key}/suites`, { slug: "todos", name: "Todos" })).body;
  assert.equal((await api.postTar(`/suites/${suite.id}/import`, writeTar(files))).status, 200);
  return { project, suite, application, ring };
}

// ------------------------------------------------------------------- gate 4

test("gate 4: an unbound runner skips a mobile offer locally, and a bound one claims the same offer", async () => {
  const disk = runnerDisk("gate4");
  const appium = await startAppiumStub();
  let unbound: HostedDynamic = null;
  let bound: HostedDynamic = null;
  try {
    await withApp(async ({ api, base, app }: HostedDynamic) => {
      const labels = ["ios-bench"];
      const { project, suite, ring } = await setUpMobileProject(api, "gate4mobile", { labels });

      // The unbound runner is a perfectly good runner: same labels, same
      // isolation, checked in and waiting. What it does not have is a line in a
      // config file binding "todo-ios/local" — which is the ONLY thing that
      // decides whether a mobile offer is for it.
      const unboundRunner = await registerRunner(api, project, { name: "unbound-mac", labels });
      unbound = startPoolAgent(base, unboundRunner.credential, { labels: labels.join(",") });
      await until(
        async () => (await app.db.query(`SELECT last_seen_at FROM runners WHERE id = $1`, [unboundRunner.id])).rows[0]?.last_seen_at,
        "the unbound runner to check in",
        unbound,
      );

      const launched = await api.post(`/projects/${project.key}/run-groups`, {
        suite_id: suite.id,
        ring_id: ring.id,
        selection: { ids: ["open-app"] },
      });
      assert.equal(launched.status, 200, JSON.stringify(launched.body));
      const groupId = launched.body.run_group.id;

      // It says so once, locally, in its own words — and sends nothing.
      await until(
        async () => /skipping run group .*: this runner has no configuration binding for the mobile target "todo-ios\/local"/.test(unbound.out.stdout),
        "the unbound runner to skip the mobile offer",
        unbound,
        60_000,
      );
      // Nothing about the refusal reached the control plane: the advertisement
      // is untouched and the ledger row is still exactly where the launch left
      // it. A capable runner claims it unaffected.
      const before = (await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1`, [groupId])).rows[0];
      assert.equal(before.status, "requested");
      assert.equal(before.runner_id, null);
      assert.equal(before.error, null, "a local skip is never reported as a dispatch error");

      // Now a runner that binds the pair, with an external Appium backend that
      // really answers. It takes the SAME dispatch the unbound one left alone.
      const configFile = writeRunnerConfig(disk.dir, { labels, app: disk.app, appiumUrl: appium.url });
      const boundRunner = await registerRunner(api, project, { name: "bound-mac", labels });
      // No --labels: this runner's labels come from its config file, which is
      // the one source per invocation.
      bound = startPoolAgent(base, boundRunner.credential, { config: configFile });
      // The banner states what this machine binds, by key: never the build path
      // or the device behind it.
      await until(
        async () => /targets\s+todo-ios\/local — ios via backend "bench-ios"/.test(bound.out.stdout),
        "the bound runner's banner to state its targets",
        bound,
      );
      assert.equal(bound.out.stdout.includes(disk.app), false, "the banner names keys, not paths");
      assert.equal(bound.out.stdout.includes(DEVICE), false, "the banner names keys, not devices");

      const claimed = await until(
        async () => {
          const row = (await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1`, [groupId])).rows[0];
          return row?.runner_id ? row : null;
        },
        "the bound runner to claim the mobile offer",
        bound,
      );
      assert.equal(claimed.id, before.id, "the same offer — nothing was re-posted for the runner that could take it");
      assert.equal(claimed.runner_id, boundRunner.id);
      // …and the unbound runner never claimed anything, then or since.
      assert.equal(
        (await app.db.query(`SELECT COUNT(*) AS n FROM dispatches WHERE runner_id = $1`, [unboundRunner.id])).rows[0].n,
        0,
      );

      await bound.stop();
      await unbound.stop();
    });
  } finally {
    if (bound) await bound.stop();
    if (unbound) await unbound.stop();
    await appium.close();
    disk.remove();
  }
});

// ------------------------------------------------------------------ gate 10

test("gate 10: a post-claim mobile preflight failure is one actionable infra error, not a driver stack", async () => {
  const disk = runnerDisk("gate10");
  const appium = await startAppiumStub();
  let agent: HostedDynamic = null;
  try {
    await withApp(async ({ api, base, app }: HostedDynamic) => {
      const labels = ["ios-bench"];
      const { project, suite, ring } = await setUpMobileProject(api, "gate10mobile", { labels });
      const configFile = writeRunnerConfig(disk.dir, { labels, app: disk.app, appiumUrl: appium.url });
      const runner = await registerRunner(api, project, { name: "preflight-mac", labels });
      agent = startPoolAgent(base, runner.credential, { config: configFile });
      await until(
        async () => (await app.db.query(`SELECT last_seen_at FROM runners WHERE id = $1`, [runner.id])).rows[0]?.last_seen_at,
        "the runner to check in",
        agent,
      );

      // The build goes away AFTER startup validation and BEFORE the launch: the
      // config was correct when the operator started the agent, and the machine
      // changed underneath it. That is precisely the failure the post-claim
      // preflight exists to diagnose — and the one that used to surface forty
      // minutes later as a driver error about a session that would not start.
      fs.rmSync(disk.app, { recursive: true, force: true });

      const launched = await api.post(`/projects/${project.key}/run-groups`, {
        suite_id: suite.id,
        ring_id: ring.id,
        selection: { ids: ["open-app"] },
      });
      assert.equal(launched.status, 200, JSON.stringify(launched.body));
      const groupId = launched.body.run_group.id;

      const done = await until(
        async () => {
          const res = await api.get(`/run-groups/${groupId}`);
          return res.body?.status === "done" ? res.body : null;
        },
        "the group to end on the preflight failure",
        agent,
      );

      assert.equal(done.runs.length, 1);
      const run = done.runs[0];
      assert.equal(run.status, "infra", `expected an infra failure, got ${run.status}: ${run.error}`);
      // ONE line. It names what is wrong, whose machine it is on, and the
      // config key to correct — and it fits in the run page's error row.
      assert.equal(run.error.includes("\n"), false, `an infra error is one line: ${JSON.stringify(run.error)}`);
      assert.match(run.error, /the app build this runner binds to "todo-ios\/local" is not on the runner's disk/);
      assert.match(run.error, /correct targets\.todo-ios\.local\.app in that runner's config file/);
      // Not a driver stack, and not a path: the file that is missing is named
      // only in the runner's OWN log, where it is the answer to the question.
      assert.equal(run.error.includes(disk.app), false, "no build path crosses to the platform");
      assert.equal(run.error.includes(DEVICE), false, "no device id crosses to the platform");
      assert.equal(run.error.includes(appium.url), false, "no Appium endpoint crosses to the platform");
      assert.doesNotMatch(run.error, /at .*\(.*:\d+:\d+\)|webdriver|Appium session|newSession/i);
      // The runner did say it to itself, with the path, where that is useful.
      assert.match(agent.out.stdout, /mobile preflight: targets\.todo-ios\.local\.app points at "[^"]+", which does not exist/);
      assert.equal(agent.out.stdout.includes(disk.app), true, "this machine's own log names the file it looked for");
      // Nothing started: the failure lands before a workspace, a session, or a
      // single model call.
      assert.equal(run.totals, null);
      assert.equal(run.artifact, null);
      assert.equal(done.placement.runner.name, "preflight-mac");

      await agent.stop();
    });
  } finally {
    if (agent) await agent.stop();
    await appium.close();
    disk.remove();
  }
});

// ------------------------------------------------------------------- gate 9

/**
 * The sweep. A mobile group is taken through its WHOLE lifecycle — launch,
 * offer, claim, exchange, group spec, case report, completion — by a registered
 * runner holding the three physical facts on its own disk, and then every table
 * in the database and every API response a person or a console can reach is
 * searched for them.
 *
 * The runner is scripted rather than the real agent for one reason: the sweep
 * has to read the group spec THE RUNNER WAS SERVED, which needs the bearer the
 * exchange issued. Everything else about it is real — a runner registered
 * through the public API, an offer it took off the board, a claim it won, and a
 * bearer it was issued for that dispatch.
 */
test("gate 9: no platform-managed record or response carries a mobile path, device id, or Appium endpoint", async () => {
  const disk = runnerDisk("gate9");
  const appium = await startAppiumStub();
  try {
    await withApp(async ({ api, base, app }: HostedDynamic) => {
      const labels = ["ios-sweep"];
      // The suite AUTHORS physical fields — the one stated exception — and they
      // are deliberately different values from the runner's real ones.
      const { project, suite, application, ring } = await setUpMobileProject(api, "gate9mobile", {
        labels,
        files: AUTHORED_SUITE,
      });
      // The runner's own config file: this is where the three facts live, and
      // this file is never uploaded.
      const configFile = writeRunnerConfig(disk.dir, { labels, app: disk.app, appiumUrl: appium.url });
      assert.equal(fs.readFileSync(configFile, "utf8").includes(disk.app), true, "the facts are real, on the runner");

      const launched = await api.post(`/projects/${project.key}/run-groups`, {
        suite_id: suite.id,
        ring_id: ring.id,
        selection: { ids: ["open-app"] },
      });
      assert.equal(launched.status, 200, JSON.stringify(launched.body));
      const groupId = launched.body.run_group.id;

      const claimed = await claimAndExchange(api, base, { project, groupId, labels });
      // The offer this runner took off the board: the target block and nothing
      // more. A mobile offer's `base_url` is null and its `platform` is set —
      // between them, all the runner needs to decide it can serve this.
      assert.equal(claimed.offer.target.driver, "mobile");
      assert.equal(claimed.offer.target.platform, "ios");
      assert.equal(claimed.offer.target.base_url, null);
      assert.deepEqual(
        Object.keys(claimed.offer.target).sort(),
        ["application_id", "application_key", "base_url", "driver", "platform", "ring_id", "ring_key"],
        "the offer's target block holds exactly the seven contractual fields",
      );

      // The group spec the exchange bought — the richest thing a runner is ever
      // served, and the one place a physical fact could plausibly hide.
      const spec = await fetch(`${base}/api/v1/runner/groups/${groupId}`, { headers: claimed.headers }).then((r) => r.json());
      assert.equal(spec.application.driver, "mobile");
      assert.equal(spec.application.platform, "ios");
      assert.equal(spec.ring.base_url, null, "a mobile ring has no URL to serve");
      assert.deepEqual(spec.ring.config, { app: { settle: 250 } }, "the ring's overlay is logical only");

      // The runner reports what it found, in the words it is allowed to use.
      const report = {
        status: "infra",
        error:
          `the Appium backend "bench-ios" this runner is configured with is not answering — check that backend in ` +
          `the runner's config file (mobile.backends.bench-ios)`,
      };
      const runDbId = spec.cases[0].db_id;
      const posted = await fetch(`${base}/api/v1/runner/groups/${groupId}/cases/${spec.cases[0].run_id}/report`, {
        method: "POST",
        headers: claimed.headers,
        body: JSON.stringify(report),
      });
      assert.equal(posted.status, 200, await posted.text());
      const completed = await fetch(`${base}/api/v1/runner/groups/${groupId}/complete`, {
        method: "POST",
        headers: claimed.headers,
        body: JSON.stringify({ summary: { cases: [{ status: "infra" }] } }),
      });
      assert.equal(completed.status, 200, await completed.text());

      // ---- the sweep ----------------------------------------------------
      //
      // Every runner-resolved physical fact, in every form it could travel in.
      const needles = [disk.app, disk.dir, path.basename(disk.app), DEVICE, appium.url, `127.0.0.1:${appium.port}`, configFile];

      // Every table in the database, whole, plus every response a person or a
      // console can reach for this group. `suite_files` is the ONE stated
      // exception, and it is asserted BELOW rather than excused: authored source
      // is stored verbatim.
      await assertNoPhysicalFacts(app, needles, {
        skipTables: ["suite_files"],
        responses: [
          ["applications", await api.get(`/projects/${project.key}/applications?include=rings`)],
          ["application", await api.get(`/applications/${application.id}`)],
          ["rings", await api.get(`/applications/${application.id}/rings`)],
          ["runs index", await api.get(`/projects/${project.key}/run-groups?include=runs`)],
          ["run group", await api.get(`/run-groups/${groupId}`)],
          ["run", await api.get(`/runs/${runDbId}`)],
          ["feed", await api.get(`/projects/${project.key}/events/feed`)],
          ["audit", await api.get(`/projects/${project.key}/audit`)],
          ["runners", await api.get(`/projects/${project.key}/runners`)],
          ["dispatches", await api.get(`/projects/${project.key}/dispatches`)],
          ["suite", await api.get(`/projects/${project.key}/suites/${suite.slug}?include=cases,defaults`)],
          ["cases", await api.get(`/suites/${suite.id}/cases`)],
        ],
      });

      // The evidence still says everything a reviewer needs: WHICH surface,
      //    WHICH ring, and WHICH runner produced it. Redaction is not amnesia.
      const group = (await api.get(`/run-groups/${groupId}`)).body;
      assert.equal(group.application.id, application.id);
      assert.equal(group.application.key, "todo-ios");
      assert.equal(group.application.platform, "ios");
      assert.equal(group.ring.id, ring.id);
      assert.equal(group.ring.key, "local");
      assert.equal(group.placement.runner.id, claimed.runner.id);
      assert.equal(group.placement.runner.name, claimed.runner.name);
      assert.equal(group.runs[0].status, "infra");
      assert.equal(group.runs[0].error, report.error);
      // …and one run, read on its own, says the same thing without a join.
      const run = (await api.get(`/runs/${runDbId}`)).body;
      assert.deepEqual(run.application, {
        id: application.id,
        key: "todo-ios",
        name: "Todo iOS",
        driver: "mobile",
        platform: "ios",
      });
      assert.deepEqual(run.ring, { id: ring.id, key: "local", name: "Local", base_url: null });

      // The stated exception, proved: the authored suite file keeps its
      //    physical fields byte for byte, in storage and on export…
      const stored = (await app.db.query(`SELECT content FROM suite_files WHERE suite_id = $1 AND path = 'playtest.yaml'`, [suite.id])).rows[0];
      assert.equal(stored.content, AUTHORED_SUITE["playtest.yaml"]);
      const file = await api.get(`/suites/${suite.id}/files/playtest.yaml`);
      assert.equal(file.body.content, AUTHORED_SUITE["playtest.yaml"], "suite source round-trips verbatim for CLI use");
      // …and yet nothing the PLATFORM decides ever picked them up: they are
      // inert, exactly as hosted execution treats them (gate 8).
      const authored = [AUTHORED_APP, AUTHORED_DEVICE, AUTHORED_APPIUM];
      for (const table of ["applications", "rings", "run_groups", "dispatches", "runs", "executors", "audit_log", "platform_events"]) {
        const serialized = JSON.stringify((await app.db.query(`SELECT * FROM "${table}"`)).rows);
        for (const value of authored) {
          assert.equal(serialized.includes(value), false, `"${table}" picked up an AUTHORED physical field (${value})`);
        }
      }
    });
  } finally {
    await appium.close();
    disk.remove();
  }
});

/**
 * The same sweep, driven by a REAL session failure instead of an already-clean
 * sentence — the case gate 9 could not previously catch.
 *
 * Preflight and a managed Appium's death diagnostic are the runner's own words,
 * written to carry no physical fact. The session boundary is not: wdio and
 * Appium quote the capabilities and the endpoint they were handed, core records
 * that verbatim as the run's infra cause (report error AND manifest
 * result.error), and the executor uploads it into the run record, the feed and
 * the sealed bundle. So here the real agent really tries to start a session
 * against an Appium stub that answers `/status` and nothing else, and the sweep
 * runs over what that produced.
 */
test("gate 9: a real session-boundary failure is scrubbed by the runner, not by the platform", async () => {
  const disk = runnerDisk("gate9session");
  const appium = await startAppiumStub();
  let agent: HostedDynamic = null;
  try {
    await withApp(async ({ api, base, app, storeRoot }: HostedDynamic) => {
      const labels = ["ios-session"];
      // No ring overlay here: this is the one test in the file whose case is
      // really EXECUTED, and `app.settle` is not a key core accepts under
      // `app.envs.<ring key>` — the placement tests above never run far enough
      // to find out.
      const { project, suite, ring } = await setUpMobileProject(api, "gate9session", { labels, config: {} });
      const configFile = writeRunnerConfig(disk.dir, { labels, app: disk.app, appiumUrl: appium.url });
      const runner = await registerRunner(api, project, { name: "session-mac", labels });
      agent = startPoolAgent(base, runner.credential, { config: configFile });
      await until(
        async () => (await app.db.query(`SELECT last_seen_at FROM runners WHERE id = $1`, [runner.id])).rows[0]?.last_seen_at,
        "the runner to check in",
        agent,
      );

      const launched = await api.post(`/projects/${project.key}/run-groups`, {
        suite_id: suite.id,
        ring_id: ring.id,
        selection: { ids: ["open-app"] },
      });
      assert.equal(launched.status, 200, JSON.stringify(launched.body));
      const groupId = launched.body.run_group.id;

      const done = await until(
        async () => {
          const res = await api.get(`/run-groups/${groupId}`);
          return res.body?.status === "done" ? res.body : null;
        },
        "the group to end on the session failure",
        agent,
      );
      // Stop the agent BEFORE the assertions: everything below reads what is
      // already stored, and an agent still long-polling the board would hold
      // this control plane open past a failing assertion — turning a diagnosis
      // into a hang.
      await agent.stop();

      assert.equal(done.runs.length, 1);
      const run = done.runs[0];
      assert.equal(run.status, "infra", `expected an infra failure, got ${run.status}: ${run.error}`);
      // The driver really did fail at the session boundary, and this is ITS
      // text — not a sentence the runner composed.
      assert.ok(run.error, "the run says why it failed");

      // ---- the sweep, over what a real failure wrote --------------------
      const needles = [disk.app, disk.dir, path.basename(disk.app), DEVICE, appium.url, `127.0.0.1:${appium.port}`, configFile];
      const runDbId = run.id;
      await assertNoPhysicalFacts(app, needles, {
        skipTables: ["suite_files"],
        responses: [
          ["runs index", await api.get(`/projects/${project.key}/run-groups?include=runs`)],
          ["run group", await api.get(`/run-groups/${groupId}`)],
          ["run", await api.get(`/runs/${runDbId}`)],
          ["feed", await api.get(`/projects/${project.key}/events/feed`)],
          ["audit", await api.get(`/projects/${project.key}/audit`)],
          ["dispatches", await api.get(`/projects/${project.key}/dispatches`)],
        ],
      });
      // The sealed evidence too: a bundle is stored beside the database and
      // served to a reviewer, so its manifest is held to the same rule.
      if (run.artifact?.key) {
        const manifest = bundleFor(storeRoot, run).readText("manifest.json");
        assert.ok(manifest, "the uploaded bundle carries a manifest");
        for (const needle of needles) {
          assert.equal(manifest.includes(needle), false, `the sealed bundle's manifest carries "${needle}"`);
        }
      }
      // The masking is what the sweep just proved, so the diagnosis says so:
      // a placeholder can only be there because a fact was.
      assert.match(run.error, /<endpoint>|<path>|<device>/);
      // The runner still knows what it dialled: the fact stayed on its machine.
      assert.equal(agent.out.stdout.includes(disk.app) || agent.out.stdout.includes(appium.url), true);
    });
  } finally {
    if (agent) await agent.stop();
    await appium.close();
    disk.remove();
  }
});
