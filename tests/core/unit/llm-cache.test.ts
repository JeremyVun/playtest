// Tests for prompt caching (src/core/llm.ts): applyCacheControl marks one
// stable breakpoint message with a cache_control block, and chat() applies it
// by default unless PLAYTEST_LLM_CACHE explicitly opts out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCacheControl, chat } from "../../../src/core/llm.ts";
import { startJsonServer, textCompletion } from "../../support/json-server.ts";

const EPHEMERAL = { type: "ephemeral" };

test("marks only the default breakpoint message", () => {
  const out: LegacyTestValue = applyCacheControl([
    { role: "system", content: "stable prefix" },
    { role: "user", content: "Steps so far: ..." },
    { role: "user", content: "Current page snapshot (step 2): ..." },
  ]);
  assert.equal(out[0].content, "stable prefix");
  assert.deepEqual(out[1].content, [{ type: "text", text: "Steps so far: ...", cache_control: EPHEMERAL }]);
  assert.equal(out[2].content, "Current page snapshot (step 2): ...");
});

test("custom breakpoint marks the actor's last stable message", () => {
  const out: LegacyTestValue = applyCacheControl([
    { role: "system", content: "actor rubric" },
    { role: "user", content: "Setup state" },
    { role: "user", content: "Steps so far: ..." },
    { role: "user", content: "Current page snapshot (step 2): ..." },
  ], 2);
  assert.equal(out[0].content, "actor rubric");
  assert.equal(out[1].content, "Setup state");
  assert.deepEqual(out[2].content, [{ type: "text", text: "Steps so far: ...", cache_control: EPHEMERAL }]);
  assert.equal(out[3].content, "Current page snapshot (step 2): ...");
});

test("block content at the breakpoint is left untouched", () => {
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
  const messages = [
    { role: "system", content: "stable prefix" },
    { role: "user", content: "Steps so far: ..." },
    { role: "user", content: [{ type: "text", text: "snapshot" }, image] },
  ];
  const out: LegacyTestValue = applyCacheControl(messages, 2);
  assert.equal(out, messages);
});

test("short or non-array inputs are returned unchanged", () => {
  const one = [{ role: "user", content: "hi" }];
  assert.equal(applyCacheControl(one), one); // <2 messages: no stable prefix
  assert.equal(applyCacheControl(null as LegacyTestValue), null); // TODO(ts): deliberately invalid input pins runtime tolerance
  const invalidBreakpoint = [
    { role: "system", content: "stable prefix" },
    { role: "user", content: "last" },
  ];
  assert.equal(applyCacheControl(invalidBreakpoint, 0), invalidBreakpoint);
  assert.equal(applyCacheControl(invalidBreakpoint, 2), invalidBreakpoint);
});

test("the result is a new array (no mutation of the input)", () => {
  const messages = [
    { role: "system", content: "stable prefix" },
    { role: "user", content: "last" },
  ];
  const out: LegacyTestValue = applyCacheControl(messages);
  assert.notEqual(out, messages);
  assert.equal(messages[0]!.content, "stable prefix"); // TODO(ts): the local fixture has two messages; input remains unchanged
});

test("chat() sends cache_control by default and omits it when PLAYTEST_LLM_CACHE=0", async () => {
  const server = await startJsonServer(() => textCompletion());
  const saved = { base: process.env.PLAYTEST_LLM_BASE_URL, key: process.env.PLAYTEST_LLM_API_KEY, cache: process.env.PLAYTEST_LLM_CACHE };
  process.env.PLAYTEST_LLM_BASE_URL = server.url;
  delete process.env.PLAYTEST_LLM_API_KEY;

  const messages = [
    { role: "system", content: "You are a tester.\n## Your task\nadd \"buy milk\"" },
    { role: "user", content: "Steps so far: (none — this is your first step)" },
  ];

  try {
    delete process.env.PLAYTEST_LLM_CACHE;
    await chat({ model: "mock", messages });
    let sent: LegacyTestValue = server.requests().at(-1)!.body.messages; // TODO(ts): the awaited request is present
    assert.equal(sent[0].content, "You are a tester.\n## Your task\nadd \"buy milk\"");
    assert.deepEqual(sent[1].content[0].cache_control, EPHEMERAL);
    assert.equal(sent[1].content[0].text, "Steps so far: (none — this is your first step)");

    process.env.PLAYTEST_LLM_CACHE = "0";
    await chat({ model: "mock", messages });
    sent = server.requests().at(-1)!.body.messages; // TODO(ts): the awaited request is present
    assert.equal(sent[0].content, "You are a tester.\n## Your task\nadd \"buy milk\"");
    assert.equal(sent[1].content, "Steps so far: (none — this is your first step)");
  } finally {
    saved.base == null ? delete process.env.PLAYTEST_LLM_BASE_URL : (process.env.PLAYTEST_LLM_BASE_URL = saved.base);
    saved.key == null ? delete process.env.PLAYTEST_LLM_API_KEY : (process.env.PLAYTEST_LLM_API_KEY = saved.key);
    saved.cache == null ? delete process.env.PLAYTEST_LLM_CACHE : (process.env.PLAYTEST_LLM_CACHE = saved.cache);
    await server.close();
  }
});
