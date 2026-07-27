// R1 benchmark path 2, mechanized: a MOBILE suite dispatched through the claim
// board and executed by the REAL runner agent (`runner-agent pool`) against a
// real iOS Simulator on this machine.
//
// The thing being proved is the thing a hosted mobile product cannot fake: the
// app under test is a plain local path on the RUNNER's own disk — a .app the
// fixture's build.sh produced seconds earlier — so nothing uploads a binary and
// nothing about the control plane needs to be able to reach a device. The
// control plane only ever answers requests the agent dialled out to make. The
// device target rides the ENVIRONMENT (app.envs.<name>.{platform,app,device,
// appium_url}), which is where a per-machine build path belongs; the committed
// suite stays portable.
//
// Opt-in tier, never part of `npm test`: the root gate runs `npm run test
// --workspaces`, which picks up each workspace's `test` script only, so this
// suite's separate `test:mobile` script is invisible to it.
//   APPIUM_HOME="$HOME/.appium" npm run test:mobile --workspace=@playtest/control-plane
//
// Like packages/core/tests/mobile, it is deliberately NOT loaded with
// tests/support/hermetic.ts: that bootstrap exports its --import through
// NODE_OPTIONS into every child node process, which here would include the
// Appium server we spawn. The hermetic properties this suite still needs — no
// model credentials, a loopback scripted gateway — are set explicitly on the
// spawned agent's environment instead (childEnv).
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
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { withApp, loadSuiteDir, REPO_ROOT } from "../integration/helpers.ts";
import { bundleFor, childEnv, EXEC_GROUP_CLI, sleep } from "../integration/exec-helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";
import { startScriptedModel } from "../../../../../tests/support/scripted-model.ts";

const FIXTURE_DIR = path.join(REPO_ROOT, "tests/fixtures/todo-app-swiftui");
const SUITE_DIR = path.join(REPO_ROOT, "packages/platform/control-plane/tests/fixtures/pool-mobile");
// Off Appium's default 4723 (a server someone left running is never mistaken for
// ours) and off 4823, which packages/core/tests/mobile owns — so the two device
// suites can run side by side without inheriting each other's simulator.
const PORT = 4923;
const APPIUM_URL = `http://127.0.0.1:${PORT}`;
// Where the xcuitest driver lives. Appium otherwise treats a project-local
// `appium` dependency as its home and installs drivers INTO this repo; the
// suite pins the shared per-user home, exactly as the core mobile suite does.
const APPIUM_HOME = process.env.APPIUM_HOME || path.join(os.homedir(), ".appium");
const DEVICE = process.env.PLAYTEST_MOBILE_DEVICE || "iPhone 16";
const POOL = { PLAYTEST_DISPATCH: "pool" };
const LABELS = ["ios-sim"];
// The device work happens inside this: installing the build and creating an
// XCUITest session dwarfs everything else in the group.
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

let server: ChildProcess | null = null;
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
function preflight(): string {
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
  // driver lazy-imports inside the agent's child process. Resolve it the way
  // that process will — from core — so a missing install reads as this suite's
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

  return appiumEntry;
}

async function waitForServer(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${APPIUM_URL}/status`);
      if (res.ok) return;
    } catch {}
    if (server?.exitCode != null) throw new Error(`the appium server exited (code ${server.exitCode}) before answering /status`);
    if (Date.now() > deadline) throw new Error(`the appium server did not answer ${APPIUM_URL}/status within ${timeoutMs}ms`);
    await sleep(250);
  }
}

/**
 * A project holding the mobile fixture suite, pointed at THIS machine's device.
 * `withApp: false` leaves the build out of the environment overlay, which is how
 * the artifact case (R3) declares its target: the ring names the device and the
 * Appium endpoint, and the binary arrives as an uploaded artifact instead.
 */
async function setUp(api: HostedDynamic, key: string, { withApp = true }: HostedDynamic = {}) {
  const project = (await api.post("/projects", { key, name: key })).body;
  const suite = (await api.post(`/projects/${key}/suites`, { slug: "todos", name: "Todos" })).body;
  const files = loadSuiteDir(SUITE_DIR);
  const imported = await api.postTar(`/suites/${suite.id}/import`, writeTar(files));
  assert.equal(imported.status, 200, JSON.stringify(imported.body));

  const env = (
    await api.post(`/projects/${key}/environments`, {
      name: "sim",
      runner_labels: LABELS,
      // The whole point: a device target that only exists on the runner's own
      // machine — a simulator, a locally spawned Appium server, and a build
      // sitting at an absolute path in this checkout. A remotely hosted control
      // plane could never reach any of the three, and never has to.
      config: {
        app: { platform: "ios", device: DEVICE, appium_url: APPIUM_URL, ...(withApp ? { app: appPath } : {}) },
      },
    })
  ).body;
  return { project, suite, env, files };
}

/**
 * Zip a built `.app` the way a person would before uploading it. Info-ZIP's
 * `zip -y` is deliberate: it records unix modes and stores symlinks as links,
 * which is what a `.app` needs to survive the round trip and still install.
 */
function zipApp(app: string): Buffer {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pool-mobile-zip-")), `${path.basename(app)}.zip`);
  execFileSync("zip", ["-q", "-r", "-y", out, path.basename(app)], { cwd: path.dirname(app), timeout: 300_000 });
  const bytes = fs.readFileSync(out);
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return bytes;
}

/** Start the real agent in pool mode. The credential rides the environment. */
function startAgent(base: string, credential: string, llmUrl: string) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-mobile-agent-"));
  const out = { stdout: "", stderr: "" };
  const child = spawn(
    process.execPath,
    [EXEC_GROUP_CLI, "pool", "--server", base, "--labels", LABELS.join(","), "--isolation", "process", "--work-dir", workDir],
    {
      // The credential is an environment variable, never an argument: it must
      // not be readable from this process's command line. childEnv also strips
      // every model credential and points the actor and grader at the scripted
      // loopback gateway — this suite's stand-in for hermetic.ts.
      env: { ...childEnv(llmUrl), PLAYTEST_RUNNER_CREDENTIAL: credential, APPIUM_HOME },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (d) => (out.stdout += d));
  child.stderr.on("data", (d) => (out.stderr += d));
  return {
    child,
    out,
    workDir,
    args: child.spawnargs,
    stop: async () => {
      if (child.exitCode == null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill("SIGTERM");
        await Promise.race([exited, sleep(5_000)]);
        if (child.exitCode == null) child.kill("SIGKILL");
      }
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}

/** Wait for `pred()`, failing with the agent's own output when it never happens. */
async function until(pred: () => Promise<HostedDynamic>, what: string, agent: HostedDynamic, timeoutMs = GROUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await pred();
    if (value) return value;
    if (agent.child.exitCode != null) {
      assert.fail(`the runner agent exited (code ${agent.child.exitCode}) before ${what}\nSTDOUT:\n${agent.out.stdout}\nSTDERR:\n${agent.out.stderr}`);
    }
    await sleep(500);
  }
  assert.fail(`timed out waiting for ${what}\nSTDOUT:\n${agent.out.stdout}\nSTDERR:\n${agent.out.stderr}`);
}

before(async () => {
  const appiumEntry = preflight();

  // The fixture prints the absolute path of the built .app as its last stdout
  // line. This path is the app under test: no upload, no artifact, no snapshot
  // entry — just a file on the runner's disk.
  const built = execFileSync(path.join(FIXTURE_DIR, "build.sh"), { encoding: "utf8", timeout: 600_000 });
  appPath = built.trim().split("\n").pop()!.trim(); // SAFETY: the fixture build prints the app path as its last line
  assert.ok(appPath && fs.existsSync(appPath), `the SwiftUI fixture build produced no .app:\n${built}`);

  preexistingSims = bootedSimulators();

  server = spawn(process.execPath, [appiumEntry, "--port", String(PORT), "--address", "127.0.0.1", "--log-level", "error"], {
    env: { ...process.env, APPIUM_HOME },
    stdio: ["ignore", "ignore", "inherit"],
  });
  server.once("error", (e) => {
    throw new Error(`could not spawn the appium server: ${e.message}`);
  });
  await waitForServer(120_000);
});

after(async () => {
  if (server && server.exitCode == null) {
    const exited = new Promise((r) => server!.once("exit", r));
    server.kill("SIGTERM");
    await Promise.race([exited, sleep(10_000)]);
    if (server.exitCode == null) server.kill("SIGKILL");
  }
  // Shut down only the simulators this run booted.
  for (const udid of bootedSimulators()) {
    if (preexistingSims.has(udid)) continue;
    try {
      execFileSync("xcrun", ["simctl", "shutdown", udid], { stdio: "ignore" });
    } catch {}
  }
});

test("pool: the real agent claims a launched group and runs a mobile suite against the simulator on its own machine", async () => {
  const model = await startScriptedModel(JOURNEY);
  let agent: HostedDynamic = null;
  try {
    await withApp(async ({ api, base, app, storeRoot }: HostedDynamic) => {
      const { project, suite, env, files } = await setUp(api, "poolmobile");
      const registered = await api.post(`/projects/${project.key}/runners`, { name: "adas-mac-mini", labels: LABELS });
      assert.equal(registered.status, 201, JSON.stringify(registered.body));

      agent = startAgent(base, registered.body.credential, model.baseUrl);
      // The one-line start command a person pastes carries no secret: the
      // credential is in the environment, so `ps` cannot read it.
      assert.equal(agent.args.some((a: string) => a.includes("ptr_")), false, `the credential must never reach argv: ${agent.args.join(" ")}`);

      // It checks in before there is anything to do, and says who it is.
      await until(
        async () => (await app.db.query(`SELECT last_seen_at FROM runners WHERE project_id = $1`, [project.id])).rows[0]?.last_seen_at,
        "the runner to check in",
        agent,
        120_000,
      );
      assert.match(agent.out.stdout, /Playtest runner "adas-mac-mini" — project poolmobile/);

      const launched = await api.post(`/projects/${project.key}/run-groups`, {
        suite_id: suite.id,
        environment_id: env.id,
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
      );

      assert.equal(done.runs.length, 1);
      assert.equal(
        done.runs[0].status,
        "pass",
        `the mobile journey passed: ${done.runs[0].error ?? "no error"}\n${agent.out.stdout}\n${agent.out.stderr}`,
      );
      assert.equal(done.exit_summary.exit_code, 0);
      // The evidence says what produced it: this runner, and the isolation it
      // reported at the exchange.
      assert.equal(done.placement.runner.name, "adas-mac-mini");
      assert.equal(done.placement.isolation, "process");
      assert.ok(done.runs[0].artifact?.key, "the bundle was uploaded through the ordinary runner protocol");

      // A REAL device session really happened: the recorded manifest pins the
      // mobile driver and its snapshot format, and names the environment overlay
      // that supplied the device target.
      const manifestJson = bundleFor(storeRoot, done.runs[0]).readText("manifest.json");
      assert.ok(manifestJson, "the uploaded bundle carries its run manifest");
      const manifest = JSON.parse(manifestJson);
      assert.equal(manifest.pins.driver, "mobile");
      assert.match(manifest.pins.settle.name, /^settle-mobile-/);
      assert.equal(manifest.env.env_name, "sim");

      // …and the app it installed was a plain local path, not something the
      // platform shipped. Nothing binary rode the suite snapshot (it is the two
      // authored YAML files and nothing else), the path is absolute, outside the
      // agent's work dir and outside the control plane's data root, and it is
      // still exactly where build.sh left it in this checkout.
      const group = (await app.db.query(`SELECT snapshot_id FROM run_groups WHERE id = $1`, [groupId])).rows[0];
      const snapshot = (await app.db.query(`SELECT tree FROM suite_snapshots WHERE id = $1`, [group.snapshot_id])).rows[0];
      const tree = typeof snapshot.tree === "string" ? JSON.parse(snapshot.tree) : snapshot.tree;
      assert.deepEqual(Object.keys(tree).sort(), Object.keys(files).sort());
      assert.deepEqual(Object.keys(tree).sort(), ["playtest.yaml", "stories/seed-todos.yaml"]);

      const configured = (await app.db.query(`SELECT config FROM environments WHERE id = $1`, [env.id])).rows[0].config;
      const envConfig = typeof configured === "string" ? JSON.parse(configured) : configured;
      assert.equal(envConfig.app.app, appPath);
      assert.equal(path.isAbsolute(appPath), true);
      assert.equal(appPath, path.join(FIXTURE_DIR, "build", "TodoFixture.app"));
      assert.equal(fs.existsSync(path.join(appPath, "TodoFixture")), true, "the build is still where build.sh left it");
      assert.equal(appPath.startsWith(agent.workDir + path.sep), false, "the binary was never materialized into the agent's work dir");
      assert.equal(appPath.startsWith(storeRoot + path.sep), false, "the binary was never stored as a platform object");

      // And the agent is back on the board, not exited: one process, many groups.
      await until(async () => /waiting for work[\s\S]*claimed run group[\s\S]*waiting for work/.test(agent.out.stdout), "the agent to return to the board", agent, 30_000);
      assert.equal(agent.child.exitCode, null, "a pool runner outlives the group it just ran");

      const dispatch = await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1`, [groupId]);
      assert.equal(dispatch.rows[0].status, "concluded");
      assert.ok(dispatch.rows[0].runner_id, "the ledger row records which runner took it");

      // Stop the agent before the control plane: its long-poll is a live
      // request, and closing the server under it would just wait out the hold.
      await agent.stop();
    }, POOL);
  } finally {
    if (agent) await agent.stop();
    await model.close();
  }
});

/**
 * R3, the other half of the same benchmark: the runner does NOT have the build.
 *
 * The binary is uploaded to the environment as a zipped `.app`, a launch pins
 * its hash, and the runner materializes it into its own workspace before core
 * discovery — which is the only way a hosted control plane can serve a runner
 * that is not the machine that produced the build (a cloud runner, a device
 * farm, a colleague's laptop).
 *
 * The proof is deliberately blunt: the build is moved out of the way before the
 * launch, so the ONE path that could install anything is the copy the runner
 * materialized. A pass here cannot be a co-located runner quietly finding the
 * file it already had.
 */
test("pool: a mobile suite runs against an environment app artifact the runner materializes into its workspace", async () => {
  const model = await startScriptedModel(JOURNEY);
  let agent: HostedDynamic = null;
  const stashed = `${appPath}.stashed`;
  try {
    const zipped = zipApp(appPath);
    await withApp(async ({ api, base, app }: HostedDynamic) => {
      const { project, suite, env } = await setUp(api, "poolartifact", { withApp: false });

      const uploaded = await api.putRaw(
        `/environments/${env.id}/app-artifact?filename=${path.basename(appPath)}.zip`,
        zipped,
      );
      assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
      const sha256 = uploaded.body.app_artifact.sha256;
      assert.equal(uploaded.body.app_artifact.size, zipped.length);

      const registered = await api.post(`/projects/${project.key}/runners`, { name: "artifact-runner", labels: LABELS });
      assert.equal(registered.status, 201, JSON.stringify(registered.body));
      agent = startAgent(base, registered.body.credential, model.baseUrl);
      await until(
        async () => (await app.db.query(`SELECT last_seen_at FROM runners WHERE project_id = $1`, [project.id])).rows[0]?.last_seen_at,
        "the runner to check in",
        agent,
        120_000,
      );

      // Nothing on this machine can install the build from its own path any
      // more. Whatever runs, runs from the artifact.
      fs.renameSync(appPath, stashed);

      const launched = await api.post(`/projects/${project.key}/run-groups`, {
        suite_id: suite.id,
        environment_id: env.id,
        selection: { ids: ["seed-todos"] },
      });
      assert.equal(launched.status, 200, JSON.stringify(launched.body));
      const groupId = launched.body.run_group.id;

      // The launch pinned the hash, so a re-upload could not change this group.
      const pinned = (await app.db.query(`SELECT app_artifact FROM run_groups WHERE id = $1`, [groupId])).rows[0].app_artifact;
      const pin = typeof pinned === "string" ? JSON.parse(pinned) : pinned;
      assert.equal(pin.sha256, sha256);

      const done = await until(
        async () => {
          const res = await api.get(`/run-groups/${groupId}?wait=true`);
          return res.body?.status === "done" ? res.body : null;
        },
        "the launched group to finish",
        agent,
      );

      assert.equal(done.runs.length, 1);
      assert.equal(
        done.runs[0].status,
        "pass",
        `the mobile journey passed against the materialized artifact: ${done.runs[0].error ?? "no error"}\n${agent.out.stdout}\n${agent.out.stderr}`,
      );
      assert.equal(done.exit_summary.exit_code, 0);
      assert.equal(done.placement.runner.name, "artifact-runner");

      // The suite snapshot still carries only the two authored YAML files: an
      // artifact is an environment's property, never a suite commit.
      const group = (await app.db.query(`SELECT snapshot_id FROM run_groups WHERE id = $1`, [groupId])).rows[0];
      const snapshot = (await app.db.query(`SELECT tree FROM suite_snapshots WHERE id = $1`, [group.snapshot_id])).rows[0];
      const tree = typeof snapshot.tree === "string" ? JSON.parse(snapshot.tree) : snapshot.tree;
      assert.deepEqual(Object.keys(tree).sort(), ["playtest.yaml", "stories/seed-todos.yaml"]);

      const configured = (await app.db.query(`SELECT config FROM environments WHERE id = $1`, [env.id])).rows[0].config;
      const envConfig = typeof configured === "string" ? JSON.parse(configured) : configured;
      assert.equal(envConfig.app.app, undefined, "the ring named the device, never a path — the binary came from the artifact");

      await agent.stop();
    }, POOL);
  } finally {
    if (agent) await agent.stop();
    if (fs.existsSync(stashed)) fs.renameSync(stashed, appPath);
    await model.close();
  }
});
