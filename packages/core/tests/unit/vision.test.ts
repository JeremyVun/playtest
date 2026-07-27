import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Actor } from "../../src/actor.ts";
import { discoverCases, DummyConfigError } from "../../src/config.ts";
import { pngDimensions } from "../../src/drivers/web.ts";
import { startJsonServer, toolCompletion } from "../../../../tests/support/json-server.ts";

const PERSONA: LegacyTestValue = { description: "A deterministic test persona." };
const SNAPSHOT = 'Page: Todos — http://127.0.0.1/\n[e1] textbox "What needs doing?" value=""\n[e2] button "Add"';

let server: LegacyTestValue;
let tmpRoot: LegacyTestValue;

before(async () => {
  server = await startJsonServer((body: LegacyTestValue) => {
    const hasImage = body.messages.some((message: LegacyTestValue) =>
      Array.isArray(message.content) && message.content.some((part: LegacyTestValue) => part.type === "image_url"));
    return toolCompletion("step", {
      thought: "The current state is clear.",
      action: { type: "done", summary: "Finished." },
      expectation: "the run ends",
      ...(hasImage ? { visual: "The screenshot shows the todo interface." } : {}),
    });
  });
  process.env.PLAYTEST_LLM_BASE_URL = server.url;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-vision-unit-"));
});

after(async () => {
  delete process.env.PLAYTEST_LLM_BASE_URL;
  await server?.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function resolvedCase({ vision, mode = "discovery" }: LegacyTestValue): LegacyTestValue {
  return {
    id: "add-milk",
    story: 'Add "buy milk" to the list.',
    actor_model: "test-model",
    mode,
    vision,
    env: { driver: "web" },
  };
}

test("vision adds exactly one image block and preserves the model's visual observation", async () => {
  const actor = new Actor(resolvedCase({ vision: true }), PERSONA);
  let sent: LegacyTestValue;
  const screenshot = Buffer.from("fixture screenshot bytes");
  const { agentStep } = await actor.nextStep({
    history: [],
    snapshotText: SNAPSHOT,
    stepNum: 1,
    screenshot,
    onContext: (messages) => (sent = messages),
  });

  const arrays = sent.filter((m: LegacyTestValue) => Array.isArray(m.content));
  assert.equal(arrays.length, 1);
  assert.deepEqual(arrays[0].content.map((p: LegacyTestValue) => p.type), ["text", "image_url"]);
  assert.equal(arrays[0].content[1].image_url.url, `data:image/png;base64,${screenshot.toString("base64")}`);
  assert.match(sent[0].content, /screenshot of the current viewport/);
  assert.equal(typeof agentStep.visual, "string");
});

test("journey and vision-off turns remain text-only", async () => {
  for (const rc of [
    resolvedCase({ vision: false }),
    resolvedCase({ vision: false, mode: "journey" }),
  ]) {
    const actor = new Actor(rc, PERSONA);
    let sent: LegacyTestValue;
    const { agentStep } = await actor.nextStep({
      history: [],
      snapshotText: SNAPSHOT,
      stepNum: 1,
      screenshot: Buffer.from("ignored"),
      onContext: (messages) => (sent = messages),
    });
    assert.ok(sent.every((m: LegacyTestValue) => typeof m.content === "string"));
    assert.ok(!sent[0].content.includes("screenshot of the current viewport"));
    assert.equal(agentStep.visual, undefined);
  }
});

test("vision resolution and discovery-only validation are enforced without a browser", async () => {
  const discovery = writeSuite({
    "playtest.yaml": "mode: discovery\napp:\n  base_url: http://127.0.0.1:9\n",
    "default-on.yaml": "story: Explore.\n",
    "explicit-off.yaml": "story: Explore.\nvision: false\n",
  });
  const byId: LegacyTestValue = Object.fromEntries((await discoverCases([discovery])).map((c) => [c.id, c]));
  assert.equal(byId["default-on"].vision, true);
  assert.equal(byId["explicit-off"].vision, false);

  const journey = writeSuite({
    "playtest.yaml": "app:\n  base_url: http://127.0.0.1:9\n",
    "bad.yaml": "story: Placeholder journey.\nvision: true\n",
  });
  await assert.rejects(
    () => discoverCases([journey]),
    (e) => e instanceof DummyConfigError && /bad\.yaml/.test(e.message) && /discovery-only/.test(e.message),
  );
});

test("pngDimensions parses IHDR without launching Playwright", () => {
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12);
  png.writeUInt32BE(2560, 16);
  png.writeUInt32BE(800, 20);
  assert.deepEqual(pngDimensions(png), { width: 2560, height: 800 });
  assert.equal(pngDimensions(Buffer.from("not a png")), null);
});

let seq = 0;
function writeSuite(files: Record<string, string>) {
  const dir = path.join(tmpRoot, `suite-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
