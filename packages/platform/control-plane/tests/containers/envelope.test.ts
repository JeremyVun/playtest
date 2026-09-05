import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { writeBundle } from "@playtest/core/artifacts";
import { makeClient, createTarget, loadSuiteDir, REPO_ROOT } from "../integration/helpers.ts";
import { claimAndExchange } from "../integration/exec-helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";

const base = process.env.PLAYTEST_TEST_COMPOSE_URL;
if (!base || new URL(base).hostname !== "127.0.0.1") throw new Error("PLAYTEST_TEST_COMPOSE_URL must name the disposable local Compose UI");
const api = makeClient(base);
const docker = promisify(execFile);

test("real Compose: near-512-MiB upload, concurrent view/retry/clip and bounded memory", { timeout: 180000 }, async () => {
  const work = process.env.PLAYTEST_TEST_RUNNER_WORKDIR;
  if (!work || !path.isAbsolute(work)) throw new Error("PLAYTEST_TEST_RUNNER_WORKDIR must name the local Compose runner workspace");
  const tmp = await fs.mkdtemp(path.join(work, ".envelope-"));
  let project: HostedDynamic;
  const uploadRss: number[] = [];
  const cpu = (container: string) => Number(execFileSync("docker", ["exec", container, "cat", "/sys/fs/cgroup/cpu.stat"], { encoding: "utf8" }).match(/^usage_usec (\d+)/m)![1]);
  const cpuBefore = cpu("playtest-local-control-plane-1");
  let scratchPeak = 0, sampling = false;
  const sample = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void docker("docker", ["exec", "playtest-local-control-plane-1", "du", "-sk", "/tmp"]).then(r => { scratchPeak = Math.max(scratchPeak, Number(r.stdout.split(/\s+/)[0]) * 1024); }).catch(() => {}).finally(() => { sampling = false; });
  }, 1000);
  try {
    project = (await api.post("/projects", { key: `envelope-${Date.now()}`, name: "Compose resource verification" })).body;
    const { ring } = await createTarget(api, project, { runnerLabels: ["envelope-test"], baseUrl: "http://test-target:4173" });
    const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "s", name: "Resource verification" })).body;
    assert.equal((await api.postTar(`/suites/${suite.id}/import`, writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`)))).status, 200);
    const launched = await api.post(`/projects/${project.key}/run-groups`, { suite_id: suite.id, ring_id: ring.id, selection: { ids: ["add-todo"] } });
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    const group = launched.body.run_group.id;
    const { headers } = await claimAndExchange(api, base, { project, groupId: group, labels: ["envelope-test"] });
    const spec = await (await fetch(`${base}/api/v1/runner/groups/${group}`, { headers })).json();
    const run = spec.cases[0];
    assert.equal((await fetch(`${base}/api/v1/runner/groups/${group}/cases/${run.run_id}/start`, { method: "POST", headers, body: "{}" })).status, 200);
    const dir = path.join(tmp, "run"); await fs.mkdir(dir);
    const manifest = { run_id: run.run_id, mode: "record", healed: false, started_at: new Date().toISOString(), duration_ms: 1000, video_started_at: null, case: { id: run.case_id, story: "Resource fixture", app: { base_url: "http://test-target:4173" } }, result: { status: "pass" }, artifacts: { trajectory: "trajectory.jsonl", grade: "grade.json" }, totals: { cost_usd: 0 }, pins: { grader_model: "sonnet" } };
    await fs.mkdir(path.join(dir, "steps"));
    await fs.writeFile(path.join(dir, "steps/001.png"), png());
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    await fs.writeFile(path.join(dir, "trajectory.jsonl"), JSON.stringify({ step: 1, ts: Date.now(), mode: "record", agent: { action: { type: "done" }, thought: "resource fixture" }, artifacts: { screenshot: "steps/001.png" } }) + "\n");
    await fs.writeFile(path.join(dir, "grade.json"), JSON.stringify({ score: 90, summary: "resource fixture" }));
    const large = await fs.open(path.join(dir, "trace.zip"), "w");
    try { const block = Buffer.alloc(1024 * 1024, 7); for (let n = 0; n < 510; n++) await large.write(block); } finally { await large.close(); }
    const bundle = path.join(tmp, "large.ptrun"); writeBundle(dir, bundle);
    const size = (await fs.stat(bundle)).size;
    assert.ok(size > 510 * 1024 * 1024 && size <= 512 * 1024 * 1024);
    const auth = path.join(tmp, "upload.json");
    await fs.writeFile(auth, JSON.stringify({ token: headers.authorization.replace(/^Bearer /, ""), route: `/runner/runs/${run.db_id}/bundle` }), { mode: 0o600 });
    const upload = async () => {
      const code = `import fs from 'node:fs/promises'; const { ApiClient } = await import(${JSON.stringify('file:///opt/playtest/packages/platform/runner-agent/src/api-client.ts')}); const auth = JSON.parse(await fs.readFile(${JSON.stringify(auth)}, 'utf8')); const api = new ApiClient('http://control-plane:4177', auth.token); const value = await api.putBytes(auth.route, await fs.readFile(${JSON.stringify(bundle)})); console.log(JSON.stringify({value,rss:process.resourceUsage().maxRSS*1024}));`;
      const result = await docker("docker", ["exec", "playtest-local-runner-1", "node", "--input-type=module", "-e", code], { timeout: 120000 });
      const probe = JSON.parse(result.stdout.trim());
      uploadRss.push(probe.rss);
      return probe.value;
    };
    const accepted = await upload();
    const report = await fetch(`${base}/api/v1/runner/groups/${group}/cases/${run.run_id}/report`, { method: "POST", headers, body: JSON.stringify({ status: "pass", manifest, score: 90, duration_ms: 1000, bundle: accepted.artifact }) });
    assert.equal(report.status, 200, await report.text());
    const download = async () => {
      const result = await fetch(`${base}/api/v1/runs/${run.db_id}/download`);
      assert.equal(result.status, 200);
      let count = 0; for await (const chunk of result.body!) count += chunk.length;
      assert.equal(count, size);
    };
    const started = Date.now();
    const [retry, , clip] = await Promise.all([upload(), download(), api.post(`/runs/${run.db_id}/clip`, { captions: "action", burn: true })]);
    assert.equal(retry.artifact.id, accepted.artifact.id);
    assert.equal(clip.status, 202, JSON.stringify(clip.body));
    const deadline = Date.now() + 60000;
    let clipped = false;
    while (Date.now() < deadline) {
      const detail = (await api.get(`/runs/${run.db_id}`)).body;
      if (detail.clip) { clipped = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(clipped, true, "clip completes beside a near-limit bundle");
    const peak = Number(execFileSync("docker", ["exec", "playtest-local-control-plane-1", "cat", "/sys/fs/cgroup/memory.peak"], { encoding: "utf8" }).trim());
    const runnerPeak = Number(execFileSync("docker", ["exec", "playtest-local-runner-1", "cat", "/sys/fs/cgroup/memory.peak"], { encoding: "utf8" }).trim());
    assert.ok(peak < 4 * 1024 ** 3, `peak memory ${peak}`);
    assert.ok(runnerPeak <= 1024 ** 3, `runner peak memory ${runnerPeak}`);
    const events = execFileSync("docker", ["exec", "playtest-local-runner-1", "cat", "/sys/fs/cgroup/memory.events"], { encoding: "utf8" });
    assert.match(events, /^oom 0$/m);
    assert.match(events, /^oom_kill 0$/m);
    console.log(JSON.stringify({ bundle_bytes: size, upload_process_peak_rss_bytes: Math.max(...uploadRss), runner_oom_events: 0, control_plane_peak_bytes: peak, runner_peak_bytes: runnerPeak, control_plane_cpu_seconds: (cpu("playtest-local-control-plane-1") - cpuBefore) / 1e6, control_plane_scratch_peak_bytes: scratchPeak, fixture_workspace_bytes: size + 510 * 1024 * 1024, overlap_elapsed_ms: Date.now() - started, configured_control_plane_limit_bytes: 4 * 1024 ** 3, configured_runner_limit_bytes: 1024 ** 3 }));
  } finally {
    clearInterval(sample);
    if (project?.id) await api.del(`/projects/${project.key}`, {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([name, data])) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    const sum = Buffer.alloc(4); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, name, data, sum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(Buffer.from([0,255,255,255,40,120,220,0,40,120,220,255,255,255]))), chunk("IEND", Buffer.alloc(0))]);
}
