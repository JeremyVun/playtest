import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { jobArguments } from "../../src/container-profile.ts";
import { runCaseIsolated, stopActiveCases } from "../../src/case-runner.ts";

function fixture() {
  const image = process.env.PLAYTEST_TEST_JOB_IMAGE;
  const root = process.env.PLAYTEST_TEST_RUNNER_WORKDIR;
  if (!image || !root || !path.isAbsolute(root)) throw new Error("Set PLAYTEST_TEST_JOB_IMAGE and PLAYTEST_TEST_RUNNER_WORKDIR to the built local Compose image/workspace");
  return { image, root, env: { PLAYTEST_JOB_IMAGE: image, PLAYTEST_JOB_NETWORK: "playtest-local_targets", PLAYTEST_RUNNER_OWNER: "container-test", PLAYTEST_INSTALLATION: "playtest-local-test", PLAYTEST_JOB_UID: String(process.getuid!()), PLAYTEST_JOB_GID: String(process.getgid!()) } };
}

test("real job container: shared workspace, target network, non-root limits, Chromium, and absent platform credentials", async () => {
  const { image, root, env } = fixture();
  const dir = await fs.mkdtemp(path.join(root, ".container-test-"));
  try {
    await fs.writeFile(path.join(dir, "input"), "shared host workspace", { mode: 0o600 });
    const code = `
      import fs from 'node:fs';
      const { chromium } = await import(${JSON.stringify('playwright')});
      const forbidden = ['DATABASE_URL','OBJECT_STORE_ACCESS_KEY','OBJECT_STORE_SECRET_KEY','PLAYTEST_KMS_KEY','PLAYTEST_PROXY_SECRET','PLAYTEST_RUNNER_CREDENTIAL'];
      if (forbidden.some(k => process.env[k]) || fs.existsSync('/var/run/docker.sock')) throw new Error('platform capability reached a job');
      if (process.getuid() === 0) throw new Error('root job');
      fs.writeFileSync('/probe/output', fs.readFileSync('/probe/input'));
      const browser = await chromium.launch({headless:true});
      const page = await browser.newPage();
      await page.goto('http://test-target:4173');
      await page.screenshot({path:'/probe/target.png'});
      await browser.close();
      console.log(JSON.stringify({uid:process.getuid(),memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),pids:fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),cpu:fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim()}));
    `;
    const output = execFileSync("docker", ["run", "--rm", ...jobArguments("profile-test", env), "-v", `${dir}:/probe`, image, "node", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 60000 });
    const result = JSON.parse(output.trim());
    assert.equal(result.memory, "2147483648");
    assert.equal(result.pids, "512");
    const [quota, period] = result.cpu.split(" ").map(Number);
    assert.equal(quota / period, 2);
    assert.equal(await fs.readFile(path.join(dir, "output"), "utf8"), "shared host workspace");
    assert.ok((await fs.stat(path.join(dir, "target.png"))).size > 1000);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("real Docker cleanup: surviving work is removed only for its owning runner", async () => {
  const { image, env } = fixture();
  const ids: string[] = [];
  const start = (owner: string) => {
    const id = execFileSync("docker", ["run", "-d", ...jobArguments("abandoned", { ...env, PLAYTEST_RUNNER_OWNER: owner }), image, "node", "-e", "setInterval(()=>{},1000)"], { encoding: "utf8" }).trim();
    ids.push(id); return id;
  };
  const priorOwner = process.env.PLAYTEST_RUNNER_OWNER, priorInstallation = process.env.PLAYTEST_INSTALLATION;
  try {
    const a = start("runner-a"), b = start("runner-b");
    process.env.PLAYTEST_RUNNER_OWNER = "runner-a";
    process.env.PLAYTEST_INSTALLATION = "playtest-local-test";
    const { sweepDocker } = await import("../../src/janitor.ts");
    assert.deepEqual(sweepDocker(), []);
    assert.equal(sweepDocker({ includeRunning: true }).length, 1);
    assert.throws(() => execFileSync("docker", ["inspect", a], { stdio: "pipe" }));
    assert.equal(execFileSync("docker", ["inspect", b, "--format", "{{.State.Running}}"], { encoding: "utf8" }).trim(), "true");
  } finally {
    for (const id of ids) { try { execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" }); } catch {} }
    if (priorOwner === undefined) delete process.env.PLAYTEST_RUNNER_OWNER; else process.env.PLAYTEST_RUNNER_OWNER = priorOwner;
    if (priorInstallation === undefined) delete process.env.PLAYTEST_INSTALLATION; else process.env.PLAYTEST_INSTALLATION = priorInstallation;
  }
});

test("real case cancellation: a child ignoring SIGTERM is force-stopped within the grace period", { timeout: 20000 }, async () => {
  const { root, env } = fixture();
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const dir = await fs.mkdtemp(path.join(root, ".cancel-test-"));
  const runId = `cancel-${Date.now()}`, name = `playtest-case-${runId}`;
  try {
    const result = runCaseIsolated({}, {
      isolation: "container", workspaceRoot: dir, runsRoot: dir, runId,
      spawn: (command: string, args: string[], options: RunnerDynamic) => spawn(command, args[0] === "run"
        ? [...args.slice(0, -2), "node", "-e", "process.stdin.resume();process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]
        : args, options),
    }).then(() => null, (error: Error) => error);
    let running = false;
    for (let n = 0; n < 100; n++) {
      try { running = execFileSync("docker", ["inspect", name, "--format", "{{.State.Running}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true"; } catch {}
      if (running) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(running, true);
    await new Promise(r => setTimeout(r, 200));
    const started = Date.now();
    assert.equal(stopActiveCases(), 1);
    assert.match((await result)?.message || "", /canceled/);
    assert.ok(Date.now() - started < 10000);
    assert.throws(() => execFileSync("docker", ["inspect", name], { stdio: "pipe" }));
  } finally {
    stopActiveCases();
    try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }); } catch {}
    await fs.rm(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
