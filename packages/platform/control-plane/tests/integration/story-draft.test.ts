// Inline stateless story drafting (POST /suites/:s/story-draft). Authorization,
// request bounds, model-unavailable behavior, malformed tool output, the
// clarification round trip with a browser-held transcript, path preservation
// when improving, and — the load-bearing invariant — that the endpoint writes
// NOTHING durable (no authoring row, platform event, suite snapshot, or audit).
// The model is a scripted OpenAI-compatible stub (core llm.ts's supported
// transport), so no real gateway or credentials are needed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { withApp, createTarget } from "./helpers.ts";

// ---------- scripted OpenAI-compatible model stub ----------

function textReply(content: HostedDynamic) {
  return { choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 6 } };
}
function toolReply(name: HostedDynamic, args: HostedDynamic, content: HostedDynamic = null) {
  return {
    choices: [{
      message: { content, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 20, completion_tokens: 10 },
  };
}
function gatewayReply(status: number) {
  return { gateway_status: status };
}

let server: HostedDynamic;
let baseUrl: HostedDynamic;
const queue: HostedDynamic[] = []; // FIFO of response objects; each chat() call shifts one

before(async () => {
  server = http.createServer((req: HostedDynamic, res: HostedDynamic) => {
    if (!req.url.endsWith("/v1/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (c: HostedDynamic) => (raw += c));
    req.on("end", () => {
      const next = queue.shift() || textReply("(no scripted reply)");
      if (next.gateway_status) {
        res.writeHead(next.gateway_status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `scripted ${next.gateway_status}` } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(next));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

function script(...responses: HostedDynamic[]) {
  queue.length = 0;
  queue.push(...responses);
}

async function seedSuite(api: HostedDynamic, { project: projectKey = "p" } = {}) {
  const project = (await api.post("/projects", { key: projectKey, name: projectKey.toUpperCase() })).body;
  // A suite binds to an application at creation, so the target pair comes first.
  await createTarget(api, project);
  const suite = (await api.post(`/projects/${projectKey}/suites`, { slug: "s", name: "S" })).body;
  const seed = await api.post(`/suites/${suite.id}/commit`, {
    changes: [{ path: "playtest.yaml", content: "app:\n  base_url: http://x\n" }],
    note: "seed",
  });
  assert.equal(seed.status, 200, JSON.stringify(seed.body));
  return suite;
}

const VALID_STORY = "story: |\n  A user signs up and reaches their dashboard.\nsuccess:\n  - assert: the dashboard is shown\n";

test("story-draft: an editor gets a valid draft; a viewer is forbidden", async () => {
  process.env.PLAYTEST_LLM_BASE_URL = baseUrl;
  await withApp(async ({ api }: HostedDynamic) => {
    const suite = await seedSuite(api);

    script(toolReply("propose_draft", { path: "stories/signup.yaml", yaml: VALID_STORY, rationale: "checks signup" }, "Here you go."));
    const res = await api.post(`/suites/${suite.id}/story-draft`, { goal: "sign up and reach the dashboard" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.draft.path, "stories/signup.yaml");
    assert.equal(res.body.draft.validation.ok, true);
    assert.equal(res.body.reply, "Here you go.");
    assert.ok(res.body.usage.calls >= 1);

    const viewerToken = (await api.post("/projects/p/tokens", { role: "viewer", name: "v" })).body.token;
    const asViewer = await api.withToken(viewerToken).post(`/suites/${suite.id}/story-draft`, { goal: "x" });
    assert.equal(asViewer.status, 403, JSON.stringify(asViewer.body));
  });
});

test("story-draft: event-stream clients receive a truthful retry before the final result", async () => {
  process.env.PLAYTEST_LLM_BASE_URL = baseUrl;
  await withApp(async ({ api, base }: HostedDynamic) => {
    const suite = await seedSuite(api);
    script(
      gatewayReply(503),
      toolReply("propose_draft", { path: "stories/signup.yaml", yaml: VALID_STORY }),
    );

    const res = await fetch(`${base}/api/v1/suites/${suite.id}/story-draft`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ goal: "sign up" }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const body = await res.text();
    assert.match(body, /event: retry\ndata: \{"type":"retry","attempt":2,"max_attempts":3,/);
    assert.match(body, /event: result\ndata: .*"path":"stories\/signup\.yaml"/);
    assert.ok(body.indexOf("event: retry") < body.indexOf("event: result"));
  });
});

test("story-draft: request bounds — missing goal, bad transcript, oversize content answer 400", async () => {
  process.env.PLAYTEST_LLM_BASE_URL = baseUrl;
  await withApp(async ({ api }: HostedDynamic) => {
    const suite = await seedSuite(api);

    assert.equal((await api.post(`/suites/${suite.id}/story-draft`, {})).status, 400);
    assert.equal((await api.post(`/suites/${suite.id}/story-draft`, { goal: "g", transcript: "nope" })).status, 400);
    assert.equal(
      (await api.post(`/suites/${suite.id}/story-draft`, { goal: "g", transcript: [{ role: "system", content: "x" }] })).status,
      400,
    );
    assert.equal(
      (await api.post(`/suites/${suite.id}/story-draft`, { goal: "g", transcript: Array.from({ length: 50 }, () => ({ role: "user", content: "hi" })) })).status,
      400,
    );
    // No model call should have happened for any rejected request.
    assert.equal(queue.length, 0);
  });
});

test("story-draft: a configured-but-unreachable gateway fails loudly without a raw stack", async () => {
  const saved = process.env.PLAYTEST_LLM_BASE_URL;
  process.env.PLAYTEST_LLM_BASE_URL = "http://127.0.0.1:9"; // connection refused, fails fast
  try {
    await withApp(async ({ api }: HostedDynamic) => {
      const suite = await seedSuite(api);
      const res = await api.post(`/suites/${suite.id}/story-draft`, { goal: "sign up" });
      assert.equal(res.status, 502, JSON.stringify(res.body));
      assert.match(res.body.error.message, /model gateway did not respond/);
      assert.doesNotMatch(res.body.error.message, /MODULE_NOT_FOUND/);
    });
  } finally {
    process.env.PLAYTEST_LLM_BASE_URL = saved;
  }
});

test("story-draft: a malformed proposal (no YAML) returns an invalid draft, not a 500", async () => {
  process.env.PLAYTEST_LLM_BASE_URL = baseUrl;
  await withApp(async ({ api }: HostedDynamic) => {
    const suite = await seedSuite(api);
    script(toolReply("propose_draft", { path: "stories/x.yaml" })); // yaml omitted
    const res = await api.post(`/suites/${suite.id}/story-draft`, { goal: "do a thing" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.draft.validation.ok, false);
    assert.ok(res.body.draft.validation.errors.length >= 1);
  });
});

test("story-draft: clarification round trip carries the browser-held transcript", async () => {
  process.env.PLAYTEST_LLM_BASE_URL = baseUrl;
  await withApp(async ({ api }: HostedDynamic) => {
    const suite = await seedSuite(api);

    // Turn 1: the model asks a clarifying question (plain text = needs_input).
    script(textReply("Which page should they land on after signup?"));
    const first: HostedDynamic = await api.post(`/suites/${suite.id}/story-draft`, { goal: "test signup" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.needs_input, true);
    assert.match(first.body.reply, /Which page/);
    assert.ok(!first.body.draft);

    // Turn 2: the browser resends goal + the held transcript + the user's answer.
    script(toolReply("propose_draft", { path: "stories/signup.yaml", yaml: VALID_STORY }));
    const transcript = [
      { role: "assistant", content: first.body.reply },
      { role: "user", content: "the dashboard" },
    ];
    const second = await api.post(`/suites/${suite.id}/story-draft`, { goal: "test signup", transcript });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.draft.validation.ok, true);
    assert.equal(second.body.draft.path, "stories/signup.yaml");
  });
});

test("story-draft: a requested set accumulates propose_draft calls (more:true) into one drafts array", async () => {
  process.env.PLAYTEST_LLM_BASE_URL = baseUrl;
  await withApp(async ({ api }: HostedDynamic) => {
    const suite = await seedSuite(api);
    script(
      toolReply("propose_draft", { path: "stories/a.yaml", yaml: VALID_STORY, more: true }),
      toolReply("propose_draft", { path: "stories/b.yaml", yaml: VALID_STORY, more: true }),
      toolReply("propose_draft", { path: "stories/c.yaml", yaml: VALID_STORY }, "Three stories covering the flow."),
    );
    const res = await api.post(`/suites/${suite.id}/story-draft`, { goal: "draft the three signup scenarios from these requirements" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.drafts.map((d: HostedDynamic) => d.path), ["stories/a.yaml", "stories/b.yaml", "stories/c.yaml"]);
    for (const d of res.body.drafts) assert.equal(d.validation.ok, true);
    // `draft` stays the single-story field: the final entry of the set.
    assert.equal(res.body.draft.path, "stories/c.yaml");
    assert.equal(res.body.reply, "Three stories covering the flow.");
  });
});

test("story-draft: re-proposing a path mid-set replaces the rejected draft instead of duplicating it", async () => {
  process.env.PLAYTEST_LLM_BASE_URL = baseUrl;
  await withApp(async ({ api }: HostedDynamic) => {
    const suite = await seedSuite(api);
    script(
      toolReply("propose_draft", { path: "stories/a.yaml", yaml: "story: [broken\n", more: true }), // malformed YAML → invalid
      toolReply("propose_draft", { path: "stories/a.yaml", yaml: VALID_STORY, more: true }),
      toolReply("propose_draft", { path: "stories/b.yaml", yaml: VALID_STORY }),
    );
    const res = await api.post(`/suites/${suite.id}/story-draft`, { goal: "two stories" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.drafts.map((d: HostedDynamic) => d.path), ["stories/a.yaml", "stories/b.yaml"]);
    assert.equal(res.body.drafts[0].validation.ok, true);
  });
});

test("story-draft: improving an existing story pins the draft to its path", async () => {
  process.env.PLAYTEST_LLM_BASE_URL = baseUrl;
  await withApp(async ({ api }: HostedDynamic) => {
    const suite = await seedSuite(api);
    // The model proposes a DIFFERENT path; the server must keep the original.
    script(toolReply("propose_draft", { path: "stories/somewhere-else.yaml", yaml: VALID_STORY }));
    const res = await api.post(`/suites/${suite.id}/story-draft`, {
      goal: "make the signup check stronger",
      existing_path: "stories/keep-me.yaml",
      existing_yaml: "story: old\nsuccess:\n  - assert: old\n",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.draft.path, "stories/keep-me.yaml");
  });
});

test("story-draft: the endpoint writes nothing durable (no session, event, snapshot, or audit)", async () => {
  process.env.PLAYTEST_LLM_BASE_URL = baseUrl;
  await withApp(async ({ api, app }: HostedDynamic) => {
    const suite = await seedSuite(api);
    const before = {
      snapshots: Number((await app.db.query(`SELECT count(*) c FROM suite_snapshots WHERE suite_id = $1`, [suite.id])).rows[0].c),
      files: Number((await app.db.query(`SELECT count(*) c FROM suite_files WHERE suite_id = $1`, [suite.id])).rows[0].c),
    };

    script(toolReply("propose_draft", { path: "stories/signup.yaml", yaml: VALID_STORY }));
    const res = await api.post(`/suites/${suite.id}/story-draft`, { goal: "sign up" });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // The authoring_sessions table no longer exists (dropped in migration 0009);
    // statelessness is now structural. No authoring event or audit row is written.
    assert.equal(Number((await app.db.query(`SELECT count(*) c FROM platform_events WHERE type LIKE 'authoring%'`)).rows[0].c), 0);
    assert.equal(Number((await app.db.query(`SELECT count(*) c FROM audit_log WHERE action LIKE 'authoring%'`)).rows[0].c), 0);
    assert.equal(Number((await app.db.query(`SELECT count(*) c FROM suite_snapshots WHERE suite_id = $1`, [suite.id])).rows[0].c), before.snapshots);
    assert.equal(Number((await app.db.query(`SELECT count(*) c FROM suite_files WHERE suite_id = $1`, [suite.id])).rows[0].c), before.files);
  });
});
