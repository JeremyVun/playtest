// The scenario that motivated the runner refactor, end to end on real hardware:
// a MOBILE suite launched from the hosted API, claimed off the board by the real
// runner agent, and executed against a real iOS Simulator on that agent's own
// machine.
//
// What is being proved is the boundary. The platform holds an application
// (`todo-ios`, driver mobile, platform ios) and a ring (`local`) — a key, a
// name, routing labels, and nothing else. The build, the device and the Appium
// server exist only in ONE place: a `runner.yaml` on the runner's disk, bound to
// the pair `(todo-ios, local)`. A launch names `(suite, ring)`; the runner
// recognizes the pair, starts its OWN Appium (managed mode — nobody hand-starts
// anything), installs a `.app` this machine built seconds earlier, and gets a
// verdict. Afterwards, none of those three facts is anywhere in the control
// plane's database (gate 9), and the run's evidence still says which
// application, which ring, and which runner produced it.
//
// Gates: 4 (a bound runner claims the mobile offer), 7 (managed Appium — no
// hand-started server), 8 (hosted physical fields via the core runtime target,
// with the suite authoring none), 9 (no physical fact in any platform record),
// 10's happy side (preflight passes and exactly one Appium session is created).
//
// Opt-in tier, never part of `npm test`: the root gate runs each workspace's
// `test` script only, so this file's separate `test:mobile` script is invisible
// to it.
//   APPIUM_HOME="$HOME/.appium" npm run test:mobile --workspace=@playtest/control-plane
//
// Like packages/core/tests/mobile, it is deliberately NOT loaded with
// tests/support/hermetic.ts: that bootstrap exports its --import through
// NODE_OPTIONS into every child node process, which here would include the
// Appium server the AGENT spawns. The hermetic properties this suite still
// needs — no model credentials, a loopback scripted gateway — are set explicitly
// on the spawned agent's environment instead (childEnv).
//
// One-time setup on a new machine (Xcode + an iOS Simulator runtime required):
//   npm install
//   APPIUM_HOME="$HOME/.appium" npx appium driver install xcuitest
//
// Timing note: the first XCUITest session ever created on a machine also builds
// WebDriverAgent (~1.5 min here). If that very first run times out, rerun — the
// build is cached from then on.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { withApp, createTarget, loadSuiteDir, REPO_ROOT } from "../integration/helpers.ts";
import { assertNoPhysicalFacts, bundleFor, startPoolAgent, untilAgent as until } from "../integration/exec-helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";
import { startScriptedModel } from "../../../../../tests/support/scripted-model.ts";

const FIXTURE_DIR = path.join(REPO_ROOT, "tests/fixtures/todo-app-swiftui");
const SUITE_DIR = path.join(REPO_ROOT, "packages/platform/control-plane/tests/fixtures/pool-mobile");
// Where the xcuitest driver lives. Appium otherwise treats a project-local
// `appium` dependency as its home and installs drivers INTO this repo; the
// suite pins the shared per-user home, exactly as the core mobile suite does,
// and hands it to the agent so the Appium the AGENT spawns inherits it.
const APPIUM_HOME = process.env.APPIUM_HOME || path.join(os.homedir(), ".appium");
const DEVICE = process.env.PLAYTEST_MOBILE_DEVICE || "iPhone 16";
const LABELS = ["ios-sim"];
// The device work happens inside this: booting the simulator, installing the
// build and creating an XCUITest session dwarf everything else in the group.
const GROUP_TIMEOUT_MS = 600_000;

/**
 * The whole journey: the actor looks at the launch screen and finishes. Nothing
 * here guesses an element ref, so the run cannot flake on the model's reading of
 * the screen — the verdict rests entirely on the case's screen_shows gates,
 * which the mobile driver answers through finalPageCheck against the device.
 */
const JOURNEY = [
  {
    thought: "the app opened on the seeded todo list, which is all the story asks for",
    action: { type: "done", summary: "the todo app opened on its seeded list" },
    expectation: "the list screen is on display",
  },
];

let appPath = "";
let preexistingSims = new Set<string>();

function bootedSimulators(): Set<string> {
  try {
    const out = execFileSync("xcrun", ["simctl", "list", "devices", "booted"], { encoding: "utf8" });
    return new Set([...out.matchAll(/\(([0-9A-F-]{36})\) \(Booted\)/g)].map((m) => m[1]!));
  } catch {
    return new Set();
  }
}

/**
 * Fail fast with ONE actionable message. This tier is an explicit opt-in, so a
 * missing prerequisite is an error, never a silent skip.
 */
function preflight(): void {
  const need = (cond: unknown, what: string, fix: string) => {
    if (!cond) throw new Error(`mobile tests need ${what} — ${fix}`);
  };
  need(process.platform === "darwin", "macOS with Xcode (iOS Simulator)", `this host is ${process.platform}; run this suite on a Mac`);
  let simctlOk = true;
  try {
    execFileSync("xcrun", ["simctl", "list", "devices", "available"], { stdio: "ignore" });
  } catch {
    simctlOk = false;
  }
  need(simctlOk, "a working Xcode command-line toolchain", "install Xcode and run: xcode-select --install");

  const require_ = createRequire(import.meta.url);
  let appiumEntry = "";
  try {
    appiumEntry = path.join(path.dirname(require_.resolve("appium/package.json")), "index.js");
  } catch {}
  // The AGENT resolves this the same way (runner-agent/src/appium.ts
  // defaultFindAppium) when it starts its managed backend; checking it here
  // turns "the runner skipped the offer" into a setup error a person can act on.
  need(appiumEntry && fs.existsSync(appiumEntry), "the appium server (a devDependency of @playtest/core)", "run: npm install");

  let installed = "";
  try {
    installed = execFileSync(process.execPath, [appiumEntry, "driver", "list", "--installed", "--json"], {
      encoding: "utf8",
      env: { ...process.env, APPIUM_HOME },
      timeout: 120_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {}
  let hasXcuitest = false;
  try {
    hasXcuitest = Boolean(JSON.parse(installed).xcuitest);
  } catch {}
  need(
    hasXcuitest,
    `the appium xcuitest driver in APPIUM_HOME (${APPIUM_HOME})`,
    `run once: APPIUM_HOME="${APPIUM_HOME}" npx appium driver install xcuitest`,
  );

  // webdriverio is an optionalDependency of @playtest/core that the mobile
  // driver lazy-imports inside the agent's child process, and that the runner's
  // post-claim preflight probes through core's exported probe. Resolve it the
  // way those will — from core — so a missing install reads as this suite's
  // setup problem rather than a run failure mid-session. Deliberately resolved,
  // not imported: this workspace does not depend on webdriverio and must not
  // start declaring one for a test's sake.
  let wdioOk = true;
  try {
    createRequire(require_.resolve("@playtest/core/package.json")).resolve("webdriverio");
  } catch {
    wdioOk = false;
  }
  need(wdioOk, "the 'webdriverio' package (an optional dependency of @playtest/core)", "run: npm install");
}

/**
 * This machine's `runner.yaml`: the ONLY place the build path, the device and
 * the Appium backend exist. `mode: managed` is the whole of "hosted mobile stops
 * meaning remember to hand-start Appium" — the agent spawns its own server on a
 * free loopback port and tears it down with the group.
 */
function writeRunnerConfig(dir: string): string {
  const file = path.join(dir, "runner.yaml");
  fs.writeFileSync(
    file,
    [
      "version: 1",
      `labels: [${LABELS.join(", ")}]`,
      "targets:",
      "  todo-ios:",
      "    local:",
      "      platform: ios",
      `      app: ${appPath}`,
      "      backend: local-ios",
      `      device: ${DEVICE}`,
      "mobile:",
      "  backends:",
      "    local-ios:",
      "      platform: ios",
      "      appium:",
      "        mode: managed",
      "",
    ].join("\n"),
  );
  return file;
}

/**
 * The hosted side of the scenario, and all of it: a mobile application, one ring
 * with routing labels and no URL, and a suite bound to that application. No
 * build, no device, no Appium — there is nowhere to put them.
 */
async function setUp(api: HostedDynamic, key: string) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const { application, ring } = await createTarget(api, project, {
    key: "todo-ios",
    name: "Todo iOS",
    driver: "mobile",
    platform: "ios",
    ringKey: "local",
    ringName: "Local",
    runnerLabels: LABELS,
  });
  const suite = (await api.post(`/projects/${key}/suites`, { slug: "todos", name: "Todos" })).body;
  const files = loadSuiteDir(SUITE_DIR);
  const imported = await api.postTar(`/suites/${suite.id}/import`, writeTar(files));
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  return { project, suite, application, ring, files };
}

before(async () => {
  preflight();

  // The fixture prints the absolute path of the built .app as its last stdout
  // line. This path is the app under test: no upload, no artifact, no snapshot
  // entry — just a file on the runner's disk, named by the runner's own config.
  const built = execFileSync(path.join(FIXTURE_DIR, "build.sh"), { encoding: "utf8", timeout: 600_000 });
  appPath = built.trim().split("\n").pop()!.trim(); // SAFETY: the fixture build prints the app path as its last line
  assert.ok(appPath && fs.existsSync(appPath), `the SwiftUI fixture build produced no .app:\n${built}`);

  preexistingSims = bootedSimulators();
});

after(async () => {
  // Shut down only the simulators this run booted. The Appium server is the
  // AGENT's to stop, and the agent's own teardown is asserted below.
  for (const udid of bootedSimulators()) {
    if (preexistingSims.has(udid)) continue;
    try {
      execFileSync("xcrun", ["simctl", "shutdown", udid], { stdio: "ignore" });
    } catch {}
  }
});

test("hosted mobile: a runner bound to (todo-ios, local) claims the launch, starts its own Appium, and returns a verdict", async () => {
  const model = await startScriptedModel(JOURNEY);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-mobile-config-"));
  let agent: HostedDynamic = null;
  try {
    await withApp(async ({ api, base, app, storeRoot }: HostedDynamic) => {
      const { project, suite, application, ring, files } = await setUp(api, "poolmobile");

      // Nothing is hand-started: no Appium of ours, and the config asks for a
      // managed backend. If something were already listening on Appium's default
      // port it would be irrelevant — the agent binds a free port of its own.
      const configFile = writeRunnerConfig(configDir);
      const registered = await api.post(`/projects/${project.key}/runners`, { name: "adas-mac-mini", labels: LABELS });
      assert.equal(registered.status, 201, JSON.stringify(registered.body));

      agent = startPoolAgent(base, registered.body.credential, {
        llmUrl: model.baseUrl,
        config: configFile,
        // The managed Appium inherits this, which is where `appium driver
        // install xcuitest` put the driver.
        env: { APPIUM_HOME },
      });
      // The one-line start command a person pastes carries no secret: the
      // credential is in the environment, so `ps` cannot read it.
      assert.equal(agent.args.some((a: string) => a.includes("ptr_")), false, `the credential must never reach argv: ${agent.args.join(" ")}`);

      // It checks in before there is anything to do, and says who it is and
      // what it binds — by KEY. The build path and the device stay in the file.
      await until(
        async () => (await app.db.query(`SELECT last_seen_at FROM runners WHERE project_id = $1`, [project.id])).rows[0]?.last_seen_at,
        "the runner to check in",
        agent,
        120_000,
      );
      await until(
        async () => /targets\s+todo-ios\/local — ios via backend "local-ios"/.test(agent.out.stdout),
        "the runner banner to state its bindings",
        agent,
        30_000,
      );
      assert.match(agent.out.stdout, /Playtest runner "adas-mac-mini" — project poolmobile/);
      assert.match(agent.out.stdout, /backends\s+local-ios — ios, managed Appium \(started here\)/);
      assert.equal(agent.out.stdout.includes(appPath), false, "the banner names keys, never the build path");
      assert.equal(agent.out.stdout.includes(DEVICE), false, "the banner names keys, never the device");

      // The launch says nothing about a device: suite and ring, exactly as a
      // web launch does. The preview says who supplies the build.
      const preview = await api.post(`/projects/${project.key}/run-groups/preview`, { suite_id: suite.id, ring_id: ring.id });
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.equal(preview.body.target.resolved_base_url, null);
      assert.equal(preview.body.target.build_supplied_by_runner, true);
      assert.equal(preview.body.placement.runner_online, true, "the bound runner is checked in and advertising these labels");

      const launched = await api.post(`/projects/${project.key}/run-groups`, {
        suite_id: suite.id,
        ring_id: ring.id,
        selection: { ids: ["seed-todos"] },
      });
      assert.equal(launched.status, 200, JSON.stringify(launched.body));
      const groupId = launched.body.run_group.id;

      // The automation wait: exactly what CI does, and what the console's own
      // launch flow rides. The board holds it until the agent reports.
      const done = await until(
        async () => {
          const res = await api.get(`/run-groups/${groupId}?wait=true`);
          return res.body?.status === "done" ? res.body : null;
        },
        "the launched group to finish",
        agent,
        GROUP_TIMEOUT_MS,
      );

      assert.equal(done.runs.length, 1);
      assert.equal(
        done.runs[0].status,
        "pass",
        `the mobile journey passed: ${done.runs[0].error ?? "no error"}\n${agent.out.stdout}\n${agent.out.stderr}`,
      );
      assert.equal(done.exit_summary.exit_code, 0);
      // The evidence says what produced it: this runner, the isolation it
      // reported at the exchange, and the (application, ring) it ran against.
      assert.equal(done.placement.runner.name, "adas-mac-mini");
      assert.equal(done.placement.isolation, "process");
      assert.equal(done.application.key, "todo-ios");
      assert.equal(done.application.platform, "ios");
      assert.equal(done.ring.key, "local");
      assert.equal(done.ring.base_url, null);
      assert.ok(done.runs[0].artifact?.key, "the bundle was uploaded through the ordinary runner protocol");

      // Gate 7: the agent started its OWN Appium, on loopback, and tore it down
      // with the group. Nobody hand-started a server and nothing outlives it.
      const started = /appium: started a managed backend "local-ios" on (http:\/\/127\.0\.0\.1:\d+)/.exec(agent.out.stdout);
      assert.ok(started, `the runner started its own Appium:\n${agent.out.stdout}`);
      const appiumUrl = started[1]!;
      await until(
        async () => !(await fetch(`${appiumUrl}/status`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok).catch(() => false)),
        "the managed Appium to be torn down with the group",
        agent,
        30_000,
      );

      // A REAL device session really happened: the recorded manifest pins the
      // mobile driver and its snapshot format, and names the ring overlay the
      // case ran under.
      const manifestJson = bundleFor(storeRoot, done.runs[0]).readText("manifest.json");
      assert.ok(manifestJson, "the uploaded bundle carries its run manifest");
      const manifest = JSON.parse(manifestJson);
      assert.equal(manifest.pins.driver, "mobile");
      assert.match(manifest.pins.settle.name, /^settle-mobile-/);
      assert.equal(manifest.env.env_name, "local", "the ring key is the env overlay the runner materialized");
      // Exactly one Appium session for a one-case group: the first real
      // execution session IS the final preflight boundary, and no probe session
      // is created ahead of it.
      assert.equal(
        (agent.out.stdout.match(/appium: started a managed backend/g) || []).length,
        1,
        "one backend for the group, not one per case",
      );

      // The suite snapshot is the two authored YAML files and nothing else: no
      // binary rode the commit, and the suite authors no physical target at all.
      const group = (await app.db.query(`SELECT snapshot_id FROM run_groups WHERE id = $1`, [groupId])).rows[0];
      const snapshot = (await app.db.query(`SELECT tree FROM suite_snapshots WHERE id = $1`, [group.snapshot_id])).rows[0];
      const tree = typeof snapshot.tree === "string" ? JSON.parse(snapshot.tree) : snapshot.tree;
      assert.deepEqual(Object.keys(tree).sort(), Object.keys(files).sort());
      assert.deepEqual(Object.keys(tree).sort(), ["playtest.yaml", "stories/seed-todos.yaml"]);
      assert.equal(files["playtest.yaml"].includes("app:"), true);
      assert.equal(/^\s+app:/m.test(files["playtest.yaml"]), false, "the suite authors no build path");

      // Gate 9, against a run that really executed on a real device: the build
      // path, the device and the Appium endpoint are in NO table of the control
      // plane's database and in nothing the console reads back. The suite
      // authors no physical field here, so there is no exception to skip.
      await assertNoPhysicalFacts(app, [appPath, path.basename(appPath), DEVICE, appiumUrl, configFile, configDir], {
        responses: [
          ["run group", await api.get(`/run-groups/${groupId}`)],
          ["run", await api.get(`/runs/${done.runs[0].id}`)],
          ["applications", await api.get(`/projects/${project.key}/applications?include=rings`)],
          ["audit", await api.get(`/projects/${project.key}/audit`)],
          ["feed", await api.get(`/projects/${project.key}/events/feed`)],
          ["dispatches", await api.get(`/projects/${project.key}/dispatches`)],
        ],
      });

      // …and the build is still exactly where build.sh left it: nothing was
      // materialized into the agent's work dir and nothing was stored as a
      // platform object.
      assert.equal(path.isAbsolute(appPath), true);
      assert.equal(appPath, path.join(FIXTURE_DIR, "build", "TodoFixture.app"));
      assert.equal(fs.existsSync(path.join(appPath, "TodoFixture")), true, "the build is still where build.sh left it");
      assert.equal(appPath.startsWith(agent.workDir + path.sep), false, "the binary was never materialized into the agent's work dir");
      assert.equal(appPath.startsWith(storeRoot + path.sep), false, "the binary was never stored as a platform object");

      // And the agent is back on the board, not exited: one process, many groups.
      await until(
        async () => /waiting for work[\s\S]*claimed run group[\s\S]*waiting for work/.test(agent.out.stdout),
        "the agent to return to the board",
        agent,
        30_000,
      );
      assert.equal(agent.child.exitCode, null, "a pool runner outlives the group it just ran");

      const dispatch = await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1`, [groupId]);
      assert.equal(dispatch.rows[0].status, "concluded");
      assert.equal(dispatch.rows[0].runner_id, registered.body.id, "the ledger row records which runner took it");
      assert.equal(dispatch.rows[0].target.driver, "mobile");
      assert.equal(dispatch.rows[0].target.platform, "ios");
      assert.equal(dispatch.rows[0].target.base_url, null);

      // Stop the agent before the control plane: its long-poll is a live
      // request, and closing the server under it would just wait out the hold.
      await agent.stop();
    });
  } finally {
    if (agent) await agent.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
    await model.close();
  }
});
