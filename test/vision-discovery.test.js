// Vision for discovery mode (VERSION_1.1 item 7): a vision-on discovery run
// sends exactly one viewport screenshot per actor step as an image_url content
// part (asserted against the request bodies the mock LLM captured), the actor's
// `visual` observations land in the envelopes and the grader digest, and the
// vision flag rides the manifest pins + case block. Journey runs and
// `vision: false` discovery runs stay image-free with byte-identical prompts;
// `vision: true` on a journey case is a config error (exit 2). Mirrors the
// test/runner-discovery.test.js conventions: bundled todo app + rule-based mock
// LLM in-process on ephemeral ports, the real CLI driven as a child process.
// Nothing outside this file's temp dir is touched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { start as startApp } from "../src/todo-app/server.js";
import { start as startMock } from "../src/harness/testing/mock-llm.js";
import { discoverCases, DummyConfigError } from "../src/harness/config.js";
import { pngDimensions } from "../src/harness/browser.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "harness", "cli.js");
const CHILD_TIMEOUT_MS = 90_000;

// Distinctive phrase from prompts/actor-vision.md: present in vision-on system
// prompts, absent everywhere else.
const VISION_MARKER = "screenshot of the current viewport";

let mock; // mock LLM, lives for the whole file
let app; // bundled todo app
let tmpRoot;
let runsRoot;
let visionDir; // discovery suite, vision defaulted on
let visionOffDir; // discovery suite with vision: false
let journeyDir; // plain journey suite

const children = new Set();

before(async () => {
  mock = await startMock();
  app = await startApp();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-vision-"));
  runsRoot = path.join(tmpRoot, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });

  // Quoted directive: the mock actor types, clicks, then declares done — at
  // least three actor steps, each of which must carry exactly one image.
  visionDir = path.join(tmpRoot, "vision");
  fs.mkdirSync(visionDir, { recursive: true });
  fs.writeFileSync(path.join(visionDir, "playtest.yaml"), `mode: discovery\napp:\n  base_url: ${app.url}\n`);
  fs.writeFileSync(path.join(visionDir, "add-milk.yaml"), 'story: |\n  Add "buy milk" to the list.\n');

  visionOffDir = path.join(tmpRoot, "vision-off");
  fs.mkdirSync(visionOffDir, { recursive: true });
  fs.writeFileSync(
    path.join(visionOffDir, "playtest.yaml"),
    `mode: discovery\nvision: false\napp:\n  base_url: ${app.url}\n`,
  );
  fs.writeFileSync(path.join(visionOffDir, "add-bread.yaml"), 'story: |\n  Add "buy bread" to the list.\n');

  journeyDir = path.join(tmpRoot, "journey");
  fs.mkdirSync(journeyDir, { recursive: true });
  fs.writeFileSync(path.join(journeyDir, "playtest.yaml"), `app:\n  base_url: ${app.url}\n`);
  fs.writeFileSync(path.join(journeyDir, "sanity.yaml"), 'story: |\n  Add "sanity item" to the list.\n');
});

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  for (const server of [app, mock]) {
    if (server) await server.close().catch(() => {});
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------- helpers (copied from test/runner-discovery.test.js; not shared on
// purpose: test files run as separate concurrent processes) ----------

function childEnv() {
  const env = { ...process.env };
  delete env.PLAYTEST_LLM_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.PLAYTEST_LLM_CACHE; // opt-in caching off for offline tests — keeps the wire bytes golden
  delete env.PLAYTEST_BROWSER_CHANNEL; // measured runs must use pinned chromium
  delete env.TODO_APP_VARIANT;
  env.PLAYTEST_LLM_BASE_URL = mock.url;
  return env;
}

/** Spawn `node src/harness/cli.js <args>`; resolves with { code, stdout, stderr }. */
function runCli(args, { timeoutMs = CHILD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      children.delete(child);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      if (timedOut) {
        reject(new Error(`playtest ${args.join(" ")} hung past ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

const dump = (res) => `\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`;

/** The one JSON object --json prints on stdout. */
function parseRunJson(res) {
  const line = res.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  assert.ok(line, `expected a JSON object on stdout${dump(res)}`);
  return JSON.parse(line);
}

/** Run the CLI and return only the mock requests this run produced. */
async function runCapturing(args) {
  const before = mock.requests().length;
  const res = await runCli(args);
  return { res, reqs: mock.requests().slice(before) };
}

const imagePartsOf = (body) =>
  body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p?.type === "image_url") : []));

const systemTextOf = (body) => {
  const c = body.messages.find((m) => m.role === "system")?.content ?? "";
  return typeof c === "string" ? c : JSON.stringify(c);
};

const readManifest = (runDir) => JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
const readTrajectory = (runDir) =>
  fs.readFileSync(path.join(runDir, "trajectory.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

async function expectConfigError(dir, ...patterns) {
  await assert.rejects(discoverCases([dir]), (e) => {
    assert.ok(e instanceof DummyConfigError, `expected DummyConfigError, got: ${e?.stack ?? e}`);
    for (const p of patterns) assert.match(e.message, p);
    return true;
  });
}

let suiteSeq = 0;

/** Write an inline suite from { "name.yaml": "content", ... }; returns its dir. */
function writeSuite(files) {
  const dir = path.join(tmpRoot, `suite-${++suiteSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

// ---------- the e2e runs ----------

test("a vision-on discovery run sends exactly one image per actor step; envelopes carry visual; the vision flag is pinned", async () => {
  const { res, reqs } = await runCapturing(["run", visionDir, "--json", "--plain", "--runs-root", runsRoot]);
  assert.equal(res.code, 0, dump(res));
  const out = parseRunJson(res);
  assert.equal(out.exit_code, 0);
  const c = out.cases[0];
  assert.equal(c.status, "explored", dump(res));

  const stepReqs = reqs.filter((r) => r.tool === "step");
  assert.ok(stepReqs.length >= 3, `type + click + done is at least 3 actor steps, got ${stepReqs.length}`);
  for (const r of stepReqs) {
    const imgs = imagePartsOf(r.body);
    assert.equal(imgs.length, 1, "exactly one image block per actor step request");
    assert.match(imgs[0].image_url.url, /^data:image\/png;base64,/);
    // the image is real PNG bytes, capped at 1568 on the longest edge
    const dim = pngDimensions(Buffer.from(imgs[0].image_url.url.split(",")[1], "base64"));
    assert.ok(dim, "the image part decodes to a PNG");
    assert.ok(Math.max(dim.width, dim.height) <= 1568, `longest edge capped, got ${JSON.stringify(dim)}`);
    // the image rides the snapshot message, after its text part
    const arrays = r.body.messages.filter((m) => Array.isArray(m.content));
    assert.equal(arrays.length, 1, "only the snapshot message becomes a content array");
    assert.equal(arrays[0].content.length, 2);
    assert.equal(arrays[0].content[0].type, "text");
    assert.match(arrays[0].content[0].text, /^Current page snapshot \(step \d+\):\n/);
    assert.equal(arrays[0].content[1].type, "image_url");
    assert.ok(systemTextOf(r.body).includes(VISION_MARKER), "the system prompt instructs the richer looking");
  }
  for (const r of reqs.filter((r) => r.tool !== "step")) {
    assert.equal(imagePartsOf(r.body).length, 0, `non-step (${r.tool}) requests carry no images`);
  }

  // the grader digest carries the visual observations (one "  visual:" line per agent step)
  const gradeReq = reqs.find((r) => r.tool === "grade");
  assert.ok(gradeReq, "the explore run graded");
  const gradeUser = gradeReq.body.messages.find((m) => m.role === "user").content;
  assert.ok(gradeUser.includes("\n  visual: "), "the trajectory digest mines visual into the grader prompt");

  // envelopes carry the visual observation verbatim; the run still grades
  const agentSteps = readTrajectory(c.run_dir).filter((e) => e.mode === "agent");
  assert.ok(agentSteps.length >= 3);
  for (const e of agentSteps) {
    assert.equal(typeof e.agent.visual, "string", `step ${e.step} must carry agent.visual`);
    assert.ok(e.agent.visual.length > 0);
  }
  assert.ok(fs.existsSync(path.join(c.run_dir, "grade.json")), "discovery runs still grade");

  const m = readManifest(c.run_dir);
  assert.equal(m.pins.vision, true, "the vision flag is a pin");
  assert.equal(m.case.vision, true, "manifest.case carries vision for re-grading");
});

test("a journey run sends no image blocks and its prompts are unchanged", async () => {
  const { res, reqs } = await runCapturing(["run", journeyDir, "--json", "--plain", "--runs-root", runsRoot]);
  assert.equal(res.code, 0, dump(res));
  const c = parseRunJson(res).cases[0];
  assert.equal(c.status, "pass", dump(res));

  assert.ok(reqs.some((r) => r.tool === "step"), "the record run made actor calls");
  for (const r of reqs) {
    assert.equal(imagePartsOf(r.body).length, 0, "no image_url anywhere in a journey run");
    for (const msg of r.body.messages) {
      assert.equal(typeof msg.content, "string", "journey message content stays a plain string");
    }
    assert.ok(!systemTextOf(r.body).includes(VISION_MARKER), "no vision instructions in journey prompts");
  }

  const m = readManifest(c.run_dir);
  assert.equal(m.pins.vision, false);
  assert.equal(m.case.vision, false);
  for (const e of readTrajectory(c.run_dir)) assert.equal(e.agent?.visual, undefined);
});

test("discovery with vision: false sends no images and keeps today's discovery prompts", async () => {
  const { res, reqs } = await runCapturing(["run", visionOffDir, "--json", "--plain", "--runs-root", runsRoot]);
  assert.equal(res.code, 0, dump(res));
  const c = parseRunJson(res).cases[0];
  assert.equal(c.status, "explored", dump(res));

  for (const r of reqs) {
    assert.equal(imagePartsOf(r.body).length, 0, "no image_url anywhere with vision: false");
    for (const msg of r.body.messages) {
      assert.equal(typeof msg.content, "string", "vision-off message content stays a plain string");
    }
  }
  for (const r of reqs.filter((r) => r.tool === "step")) {
    const sys = systemTextOf(r.body);
    assert.ok(sys.includes("## Discovery study"), "the discovery overlay is still present");
    assert.ok(!sys.includes(VISION_MARKER), "the vision overlay is absent");
  }

  const m = readManifest(c.run_dir);
  assert.equal(m.pins.vision, false);
  assert.equal(m.case.vision, false);
  for (const e of readTrajectory(c.run_dir)) assert.equal(e.agent?.visual, undefined);
});

// ---------- config: the validation rule is the policy ----------

test('"vision: true" on a journey case is a config error; the CLI exits 2', async () => {
  const dir = writeSuite({
    "playtest.yaml": `app:\n  base_url: ${app.url}\n`,
    "bad.yaml": "story: |\n  Placeholder journey.\nvision: true\n",
  });
  await expectConfigError(dir, /bad\.yaml/, /"vision: true" is discovery-only/);

  const res = await runCli(["run", dir, "--runs-root", runsRoot]);
  assert.equal(res.code, 2, `config errors must exit 2${dump(res)}`);
  assert.match(res.stderr, /bad\.yaml/);
  assert.match(res.stderr, /vision/);
});

test('"vision: true" in a journey suite\'s playtest.yaml is equally a config error', async () => {
  const dir = writeSuite({
    "playtest.yaml": `vision: true\napp:\n  base_url: ${app.url}\n`,
    "ok.yaml": "story: |\n  Placeholder journey.\n",
  });
  await expectConfigError(dir, /ok\.yaml/, /"vision: true" is discovery-only/);
});

test("vision resolution: discovery defaults true, explicit false wins, journey defaults false (and may say so)", async () => {
  const dir = writeSuite({
    "playtest.yaml": "mode: discovery\napp:\n  base_url: http://localhost:9\n",
    "default-on.yaml": "story: |\n  Explore.\n",
    "explicit-off.yaml": "story: |\n  Explore.\nvision: false\n",
  });
  const byId = Object.fromEntries((await discoverCases([dir])).map((c) => [c.id, c]));
  assert.equal(byId["default-on"].vision, true);
  assert.equal(byId["explicit-off"].vision, false);

  const journey = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://localhost:9\n",
    "plain.yaml": "story: |\n  Placeholder journey.\n",
    "explicit.yaml": "story: |\n  Placeholder journey.\nvision: false\n",
  });
  const jById = Object.fromEntries((await discoverCases([journey])).map((c) => [c.id, c]));
  assert.equal(jById["plain"].vision, false);
  assert.equal(jById["explicit"].vision, false, "vision: false is always allowed");
});

// ---------- units ----------

test("pngDimensions parses the IHDR and rejects non-PNG bytes", () => {
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.writeUInt32BE(13, 8); // IHDR chunk length
  png.write("IHDR", 12);
  png.writeUInt32BE(2560, 16);
  png.writeUInt32BE(800, 20);
  assert.deepEqual(pngDimensions(png), { width: 2560, height: 800 });

  assert.equal(pngDimensions(Buffer.from("definitely not a png, just text")), null);
  assert.equal(pngDimensions(Buffer.alloc(10)), null, "too short to carry an IHDR");
  assert.equal(pngDimensions(null), null);
});

test("mock-llm flattens content arrays and emits visual only when an image part is present", async () => {
  const snapshot = 'Page: Todos — http://x/\n[e1] textbox "What needs doing?" value=""\n[e2] button "Add"';
  const ask = async (snapContent) => {
    const resp = await fetch(`${mock.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock",
        tool_choice: { type: "function", function: { name: "step" } },
        messages: [
          { role: "system", content: '## Your task\n\nAdd "buy milk" to the list.' },
          { role: "user", content: "Steps so far: (none — this is your first step)" },
          { role: "user", content: snapContent },
        ],
      }),
    });
    const body = await resp.json();
    return JSON.parse(body.choices[0].message.tool_calls[0].function.arguments);
  };

  const withImage = await ask([
    { type: "text", text: `Current page snapshot (step 1):\n${snapshot}` },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ]);
  // the snapshot text still parsed through the array form
  assert.deepEqual(withImage.action, { type: "type", ref: "e1", text: "buy milk", submit: false });
  assert.equal(typeof withImage.visual, "string", "image present -> visual emitted");

  const plain = await ask(`Current page snapshot (step 1):\n${snapshot}`);
  assert.deepEqual(plain.action, { type: "type", ref: "e1", text: "buy milk", submit: false });
  assert.equal(plain.visual, undefined, "no image -> no visual");
});
