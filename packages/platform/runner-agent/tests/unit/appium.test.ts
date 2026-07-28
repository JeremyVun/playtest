// Appium backends, with a FAKED Appium throughout: a stub spawn for the managed
// mode and a loopback HTTP server standing in for an external one. Nothing here
// needs a real Appium, a real device, or a real driver — this tier must stay
// runnable on a Linux CI box that has never seen Xcode.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { AppiumBackends, credentialEnvFor, PLATFORM_DRIVER } from "../../src/appium.ts";
import type { AppiumBackend } from "../../src/runner-config.ts";

const managed = (over: Partial<AppiumBackend> = {}): AppiumBackend => ({
  name: "local-ios",
  platform: "ios",
  mode: "managed",
  url: null,
  credentialFile: null,
  credentialEnv: null,
  ...over,
});

const external = (url: string, over: Partial<AppiumBackend> = {}): AppiumBackend =>
  ({ ...managed({ name: "grid", mode: "external", url }), ...over });

/**
 * A stub Appium process: an EventEmitter with the two streams and the one method
 * the manager touches. `exit()` is how a test kills it mid-group.
 */
function fakeServer() {
  const child: LegacyTestValue = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (signal: string) => {
    child.killed = signal;
    child.emit("exit", null, signal);
    return true;
  };
  child.exit = (code: number, stderr = "") => {
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("exit", code, null);
  };
  return child;
}

const CMD = { command: "/usr/bin/node", args: ["/tmp/appium/index.js"], label: "/tmp/appium/index.js" };

/** Deps that make a managed backend start instantly and successfully. */
function healthyDeps(child: LegacyTestValue, over: LegacyTestValue = {}) {
  const spawned: LegacyTestValue[] = [];
  return {
    spawned,
    deps: {
      spawn: ((command: string, args: string[], options: LegacyTestValue) => {
        spawned.push({ command, args, options });
        return child;
      }) as LegacyTestValue,
      findAppium: () => CMD,
      installedDrivers: async () => ["xcuitest"],
      statusOk: async () => true,
      freePort: async () => 4999,
      // A real macrotask yield: a promise that resolves synchronously would
      // starve the timers and events these tests drive the fake server with.
      sleep: () => new Promise<void>((r) => setImmediate(r)),
      log: () => {},
      env: {},
      ...over,
    },
  };
}

test("appium: a managed backend spawns on a free loopback port, health-checks, and is torn down with the group", async () => {
  const child = fakeServer();
  const { spawned, deps } = healthyDeps(child);
  const backends = new AppiumBackends(deps);
  const handle = await backends.open(managed());

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "/usr/bin/node");
  // Loopback ONLY: a managed Appium drives a device and must never be reachable
  // from anywhere but this machine.
  assert.ok(spawned[0].args.includes("--address"));
  assert.equal(spawned[0].args[spawned[0].args.indexOf("--address") + 1], "127.0.0.1");
  assert.equal(spawned[0].args[spawned[0].args.indexOf("--port") + 1], "4999");
  assert.equal(handle.url, "http://127.0.0.1:4999");
  assert.deepEqual(handle.credentialEnv, {}, "a managed backend has no credential to deliver");
  assert.equal(handle.died(), null);

  // Its own process group: an Appium roots a subtree (platform driver,
  // WebDriverAgent, simulator plumbing) that only a group signal actually ends.
  assert.equal(spawned[0].options.detached, true, "the server is its own process-group leader");

  await handle.close();
  assert.equal(child.killed, "SIGTERM", "the server does not outlive the group it was started for");
});

test("appium: teardown signals the server's process GROUP, so nothing it started is left behind", async () => {
  const child = fakeServer();
  child.pid = 4242;
  const signalled: Array<[number, string]> = [];
  const { deps } = healthyDeps(child);
  const backends = new AppiumBackends(deps);
  const handle = await backends.open(managed());

  const realKill = process.kill;
  // A negative pid is a process GROUP in POSIX terms. Intercepted rather than
  // really sent: 4242 is somebody else's process on this machine.
  (process as LegacyTestValue).kill = (pid: number, signal: string) => {
    signalled.push([pid, signal]);
    if (pid === -4242) child.emit("exit", 0, null);
    return true;
  };
  try {
    await handle.close();
  } finally {
    process.kill = realKill;
  }
  assert.deepEqual(signalled, [[-4242, "SIGTERM"]], "the group, not the one process");
  assert.equal(child.killed, false, "and never the bare process when a group is nameable");
});

test("appium: a missing platform driver is refused with the install command, and nothing is installed", async () => {
  const child = fakeServer();
  const { spawned, deps } = healthyDeps(child, { installedDrivers: async () => ["uiautomator2"] });
  const backends = new AppiumBackends(deps);

  assert.equal(await backends.startable(managed()), `the Appium "xcuitest" driver is not installed on this runner — run: appium driver install xcuitest`);
  await assert.rejects(() => backends.open(managed()), /appium driver install xcuitest/);
  assert.equal(spawned.length, 0, "a backend that cannot work is never started");
  assert.equal(PLATFORM_DRIVER.android, "uiautomator2");
});

test("appium: no Appium at all is refused with the install command rather than a spawn failure", async () => {
  const backends = new AppiumBackends(healthyDeps(fakeServer(), { findAppium: () => null }).deps);
  assert.match((await backends.startable(managed()))!, /the Appium server is not installed on this runner/);
  await assert.rejects(() => backends.open(managed()), /npm i -g appium/);
});

test("appium: a server that dies before it is ready fails with a redacted diagnostic, never a path", async () => {
  const child = fakeServer();
  // The server answers nothing and then dies, exactly as a misconfigured one
  // does: the health poll is what notices.
  let polls = 0;
  const { deps } = healthyDeps(child, {
    statusOk: async () => {
      if (++polls === 2) child.exit(1, "Error: cannot open /Users/ada/build/Todo.app\n");
      return false;
    },
  });
  const backends = new AppiumBackends(deps);
  await assert.rejects(() => backends.open(managed()), (e: LegacyTestValue) => {
    assert.match(e.message, /Appium did not start on this runner for backend "local-ios" \(exit code 1\)/);
    assert.equal(e.message.includes("/Users/ada"), false, "a runner's filesystem layout never crosses to the platform");
    assert.match(e.message, /<path>/);
    return true;
  });
});

test("appium: a managed backend that dies mid-group reports it, once the group asks", async () => {
  const child = fakeServer();
  const backends = new AppiumBackends(healthyDeps(child).deps);
  const handle = await backends.open(managed());
  assert.equal(handle.died(), null);
  child.exit(9, "server terminated while /tmp/session-x was open\n");
  const died = handle.died()!;
  assert.match(died, /the Appium backend "local-ios" on this runner exited while the group was running \(exit code 9\)/);
  assert.equal(died.includes("/tmp/session-x"), false, "the diagnostic is redacted of paths");
  await handle.close();
  assert.equal(handle.died(), null, "a closed backend is not a dead one");
});

test("appium: an external backend is reachability-probed, dialled, and never spawned", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/status") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ value: { ready: true } }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as import("node:net").AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  try {
    const backends = new AppiumBackends({
      spawn: (() => assert.fail("an external backend starts nothing")) as LegacyTestValue,
      findAppium: () => assert.fail("an external backend needs no local Appium"),
      log: () => {},
      env: {},
    });
    assert.equal(await backends.startable(external(url)), null);
    const handle = await backends.open(external(url));
    assert.equal(handle.url, url);
    assert.equal(handle.died(), null);
    await handle.close();

    // Nothing answering is a skip reason before the claim and an actionable
    // failure after it — never a mid-case driver stack.
    const dead = external(`http://127.0.0.1:${port + 1}`);
    assert.match((await backends.startable(dead))!, /nothing is answering/);
    await assert.rejects(() => backends.open(dead), /is not answering/);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("appium: startable() is probed once per backend per session window", async () => {
  let probes = 0;
  const backends = new AppiumBackends({
    ...healthyDeps(fakeServer(), {
      statusOk: async () => {
        probes += 1;
        return true;
      },
    }).deps,
    now: () => 1_000,
  });
  const grid = external("http://127.0.0.1:9");
  assert.equal(await backends.startable(grid), null);
  assert.equal(await backends.startable(grid), null);
  assert.equal(await backends.startable(grid), null);
  assert.equal(probes, 1, "a claim-time check that costs a socket per offer is not a claim-time check");

  // A different backend is its own question.
  await backends.startable(external("http://127.0.0.1:10", { name: "other" }));
  assert.equal(probes, 2);
});

test("appium: the installed-driver list costs one subprocess per session, not one per offer", async () => {
  let listed = 0;
  const backends = new AppiumBackends(
    healthyDeps(fakeServer(), {
      installedDrivers: async () => {
        listed += 1;
        return ["xcuitest"];
      },
      now: () => 1_000,
    }).deps,
  );
  await backends.startable(managed());
  await backends.startable(managed({ name: "second" }));
  await backends.driverNames();
  assert.equal(listed, 1);
});

test("appium: an external credential reaches the case as a file path or a value, never inline", () => {
  assert.deepEqual(credentialEnvFor(external("http://x", { credentialFile: "/etc/grid.cred" }), {}), {
    PLAYTEST_APPIUM_CREDENTIAL_FILE: "/etc/grid.cred",
  });
  assert.deepEqual(credentialEnvFor(external("http://x", { credentialEnv: "GRID" }), { GRID: "alice:hunter2" }), {
    PLAYTEST_APPIUM_CREDENTIAL: "alice:hunter2",
  });
  assert.deepEqual(credentialEnvFor(external("http://x", { credentialEnv: "GRID" }), {}), {}, "an unset variable is no credential");
  assert.deepEqual(credentialEnvFor(managed(), {}), {});
});
