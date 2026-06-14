// Tests for opt-in prompt caching (src/harness/llm.js): applyCacheControl marks
// every message before the volatile final one with a cache_control block, and
// chat() applies it only when PLAYTEST_LLM_CACHE is truthy — so the default
// (offline/mock) wire bytes stay byte-identical. The integration test drives a
// real chat() against the in-process mock and inspects the captured request body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCacheControl, chat } from "../src/harness/llm.js";
import { start as startMock } from "../src/harness/testing/mock-llm.js";

const EPHEMERAL = { type: "ephemeral" };

test("marks every message except the volatile final one", () => {
  const out = applyCacheControl([
    { role: "system", content: "stable prefix" },
    { role: "user", content: "Steps so far: ..." },
    { role: "user", content: "Current page snapshot (step 2): ..." },
  ]);
  assert.deepEqual(out[0].content, [{ type: "text", text: "stable prefix", cache_control: EPHEMERAL }]);
  assert.deepEqual(out[1].content, [{ type: "text", text: "Steps so far: ...", cache_control: EPHEMERAL }]);
  // The final message (per-turn snapshot) is left fresh — no marker.
  assert.equal(out[2].content, "Current page snapshot (step 2): ...");
});

test("a two-message payload marks only the system prefix", () => {
  const out = applyCacheControl([
    { role: "system", content: "grader rubric" },
    { role: "user", content: "## Trajectory ..." },
  ]);
  assert.deepEqual(out[0].content, [{ type: "text", text: "grader rubric", cache_control: EPHEMERAL }]);
  assert.equal(out[1].content, "## Trajectory ...");
});

test("block content (a vision snapshot) is left untouched", () => {
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
  const out = applyCacheControl([
    { role: "system", content: "stable prefix" },
    { role: "user", content: "Steps so far: ..." },
    { role: "user", content: [{ type: "text", text: "snapshot" }, image] },
  ]);
  // Marked prefix...
  assert.equal(out[0].content[0].cache_control.type, "ephemeral");
  // ...volatile final message (already a block array) passed through verbatim.
  assert.deepEqual(out[2].content, [{ type: "text", text: "snapshot" }, image]);
});

test("short or non-array inputs are returned unchanged", () => {
  const one = [{ role: "user", content: "hi" }];
  assert.equal(applyCacheControl(one), one); // <2 messages: no stable prefix
  assert.equal(applyCacheControl(null), null);
});

test("the result is a new array (no mutation of the input)", () => {
  const messages = [
    { role: "system", content: "stable prefix" },
    { role: "user", content: "last" },
  ];
  const out = applyCacheControl(messages);
  assert.notEqual(out, messages);
  assert.equal(messages[0].content, "stable prefix"); // input unchanged
});

test("chat() sends cache_control only when PLAYTEST_LLM_CACHE is set", async () => {
  const mock = await startMock();
  const saved = { base: process.env.PLAYTEST_LLM_BASE_URL, key: process.env.PLAYTEST_LLM_API_KEY, cache: process.env.PLAYTEST_LLM_CACHE };
  process.env.PLAYTEST_LLM_BASE_URL = mock.url;
  delete process.env.PLAYTEST_LLM_API_KEY;

  const messages = [
    { role: "system", content: "You are a tester.\n## Your task\nadd \"buy milk\"" },
    { role: "user", content: "Steps so far: (none — this is your first step)" },
  ];

  try {
    // Default off: the body the gateway receives is byte-for-byte the legacy shape.
    delete process.env.PLAYTEST_LLM_CACHE;
    await chat({ model: "mock", messages });
    assert.equal(mock.requests().at(-1).body.messages[0].content, "You are a tester.\n## Your task\nadd \"buy milk\"");

    // Opt-in: the stable prefix (every message but the last) carries a cache_control block.
    process.env.PLAYTEST_LLM_CACHE = "1";
    await chat({ model: "mock", messages });
    const sent = mock.requests().at(-1).body.messages;
    assert.deepEqual(sent[0].content[0].cache_control, EPHEMERAL);
    assert.equal(sent[0].content[0].text, "You are a tester.\n## Your task\nadd \"buy milk\"");
    assert.equal(sent[1].content, "Steps so far: (none — this is your first step)"); // final message stays fresh
  } finally {
    saved.base == null ? delete process.env.PLAYTEST_LLM_BASE_URL : (process.env.PLAYTEST_LLM_BASE_URL = saved.base);
    saved.key == null ? delete process.env.PLAYTEST_LLM_API_KEY : (process.env.PLAYTEST_LLM_API_KEY = saved.key);
    saved.cache == null ? delete process.env.PLAYTEST_LLM_CACHE : (process.env.PLAYTEST_LLM_CACHE = saved.cache);
    await mock.close();
  }
});
