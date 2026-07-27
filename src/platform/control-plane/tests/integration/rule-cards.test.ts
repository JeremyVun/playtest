// Rule cards end to end over the real control plane (docs/contracts/hosted.md,
// "Rule cards"; DESIGN N6).
//
// The load-bearing test here is `GOVERNANCE`: a card the model proposed and a
// card a person denied must have no path into `approvedRuleCards` — the one
// function an authoring handout is built from. It is asserted against the real
// table through the real endpoints, not against a mock, because a governance
// rule that only holds in a unit test is a governance rule that does not hold.
//
// The model is a scripted OpenAI-compatible stub; no real gateway, no
// credentials, and the hermetic bootstrap blocks non-loopback fetch anyway.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { withApp } from "./helpers.ts";
import { approvedRuleCards } from "../../src/authoring/rule-cards.ts";

let server: HostedDynamic;
let baseUrl: HostedDynamic;
const queue: HostedDynamic[] = [];
const prompts: HostedDynamic[] = [];

const reply = (content: HostedDynamic) => ({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 20 } });

const cardsReply = (cards: HostedDynamic, notes = "I read the widget lifecycle.") =>
  reply(`${notes}\n\n\`\`\`json\n${JSON.stringify({ cards }, null, 2)}\n\`\`\``);

before(async () => {
  server = http.createServer((req: HostedDynamic, res: HostedDynamic) => {
    if (!req.url.endsWith("/v1/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (chunk: HostedDynamic) => (raw += chunk));
    req.on("end", () => {
      // Content may be a string or a cache-control block array; both are only
      // ever read here as "did this text reach the model".
      prompts.push(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(queue.shift() || reply("(no scripted reply)")));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const script = (...responses: HostedDynamic[]) => {
  queue.length = 0;
  prompts.length = 0;
  queue.push(...responses);
};

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Widget registry", version: "1.0.0" },
  paths: {
    "/widgets": {
      get: { summary: "List widgets", responses: { 200: { description: "ok" } } },
      post: { summary: "Create a widget", responses: { 201: { description: "created" }, 422: { description: "invalid" } } },
    },
    "/widgets/{id}/publish": {
      post: {
        summary: "Publish a widget",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "ok" }, 409: { description: "already published" } },
      },
    },
  },
};

const PROPOSED = [
  {
    id: "publish-is-once",
    title: "A widget publishes once",
    statement: "Publishing a widget that is already published is refused; it never republishes.",
    applicability: "POST /widgets/{id}/publish, including a second call with an identical body.",
    exceptions: "None.",
    provenance: "POST /widgets/{id}/publish · 409 response",
  },
  { id: "names-are-unique", title: "Widget names are unique", statement: "Two widgets never share a name.", provenance: "POST /widgets · 422 invalid" },
  { id: "drafts-expire", title: "Drafts expire", statement: "A draft widget is deleted automatically after thirty days.", provenance: "GET /widgets · status field" },
];

async function seedSuite(api: HostedDynamic) {
  await api.post("/projects", { key: "p", name: "P" });
  const suite = (await api.post(`/projects/p/suites`, { slug: "s", name: "S" })).body;
  return suite;
}

test("rule cards: Level 0 is reported before a single card exists", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const suite = await seedSuite(api);
    const res = await api.get(`/suites/${suite.id}/rule-cards`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.level_0.map((entry: HostedDynamic) => entry.policy), ["no_server_error", "documented_status", "response_schema", "content_type"]);
    assert.deepEqual(res.body.cards, []);
    assert.deepEqual(res.body.counts, { candidate: 0, approved: 0, denied: 0 });

    const handout = await api.get(`/suites/${suite.id}/rule-cards/handout`);
    assert.deepEqual(handout.body.rules, []);
    assert.equal(handout.body.policies.length, 4);
  });
});

test("rule cards: a proposal lands candidates with provenance, and never an approved rule", async () => {
  process.env.PLAYTEST_LLM_BASE_URL = baseUrl;
  await withApp(async ({ api }: HostedDynamic) => {
    const suite = await seedSuite(api);
    // The model claims one of its cards is already approved. It is not.
    script(cardsReply([{ ...PROPOSED[0], state: "approved" }, PROPOSED[1]]));

    const res = await api.post(`/suites/${suite.id}/rule-cards/propose`, { spec: { document: SPEC } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.cards.length, 2);
    assert.equal(res.body.prompt_version, "rule-proposal-v1");
    for (const card of res.body.cards) {
      assert.equal(card.state, "candidate");
      assert.equal(card.origin, "proposed");
      assert.equal(card.edited, false);
    }
    assert.equal(res.body.cards[0].provenance, "POST /widgets/{id}/publish · 409 response");
    assert.equal(res.body.notes, "I read the widget lifecycle.");

    // The prompt named the Level 0 set as off-limits.
    assert.match(prompts[0], /do not propose these/);
    assert.match(prompts[0], /`no_server_error`/);

    // Candidates are not rules.
    assert.deepEqual((await api.get(`/suites/${suite.id}/rule-cards/handout`)).body.rules, []);
  });
});

test("rule cards: approve, deny, edit, note, and add-your-own", async () => {
  process.env.PLAYTEST_LLM_BASE_URL = baseUrl;
  await withApp(async ({ api }: HostedDynamic) => {
    const suite = await seedSuite(api);
    script(cardsReply(PROPOSED));
    const proposed = (await api.post(`/suites/${suite.id}/rule-cards/propose`, { spec: { document: SPEC } })).body.cards;
    const byRule = Object.fromEntries(proposed.map((card: HostedDynamic) => [card.rule_id, card]));

    // Approve with a note in the same action.
    const approved = await api.post(`/rule-cards/${byRule["publish-is-once"].id}/approve`, { note: "Support leans on this — a second publish re-notifies subscribers." });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.state, "approved");
    assert.match(approved.body.note, /re-notifies subscribers/);
    assert.ok(approved.body.decided_at);

    // Edit before approving: the sentence changes, the obligation slug does not.
    const edited = await api.patch(`/rule-cards/${byRule["names-are-unique"].id}`, {
      statement: "Two widgets never share a name within one workspace.",
      applicability: "POST /widgets, and rename.",
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.rule_id, "names-are-unique");
    assert.equal(edited.body.state, "candidate", "editing is not approving");
    assert.equal(edited.body.edited, true);
    assert.equal(edited.body.proposed_statement, "Two widgets never share a name.");
    (await api.post(`/rule-cards/${byRule["names-are-unique"].id}/approve`, {})).body;

    // Deny the wrong one, and it stays as memory.
    const denied = await api.post(`/rule-cards/${byRule["drafts-expire"].id}/deny`, { note: "We never delete drafts." });
    assert.equal(denied.body.state, "denied");

    // Add your own: a sentence a person wrote is a sentence a person approved.
    const mine = await api.post(`/suites/${suite.id}/rule-cards`, {
      statement: "A widget's slug never changes after creation.",
      title: "Slugs are permanent",
      note: "Our public URLs depend on it.",
    });
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    assert.equal(mine.body.state, "approved");
    assert.equal(mine.body.origin, "authored");
    assert.equal(mine.body.provenance, null);
    assert.equal(mine.body.rule_id, "slugs-are-permanent", "the slug comes from the title when one is given");

    const listed = await api.get(`/suites/${suite.id}/rule-cards`);
    assert.deepEqual(listed.body.counts, { candidate: 0, approved: 3, denied: 1 });

    // A proposed card is denied, not deleted — deleting it would forget.
    const refused = await api.del(`/rule-cards/${byRule["drafts-expire"].id}`);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error.message, /deny it instead of deleting it/);
    // A card you wrote yourself, you can remove.
    assert.equal((await api.del(`/rule-cards/${mine.body.id}`)).status, 200);
  });
});

test("GOVERNANCE: only approved sentences reach the handout, and a denial is never re-proposed", async () => {
  process.env.PLAYTEST_LLM_BASE_URL = baseUrl;
  await withApp(async ({ api, app }: HostedDynamic) => {
    const suite = await seedSuite(api);
    script(cardsReply(PROPOSED));
    const proposed = (await api.post(`/suites/${suite.id}/rule-cards/propose`, { spec: { document: SPEC } })).body.cards;
    const byRule = Object.fromEntries(proposed.map((card: HostedDynamic) => [card.rule_id, card]));

    await api.post(`/rule-cards/${byRule["publish-is-once"].id}/approve`, { note: "Yes — and it is the one that bites us." });
    await api.post(`/rule-cards/${byRule["drafts-expire"].id}/deny`, {});
    // `names-are-unique` is left a candidate: never decided at all.

    const handout = (await api.get(`/suites/${suite.id}/rule-cards/handout`)).body;
    assert.deepEqual(handout.rules.map((rule: HostedDynamic) => rule.id), ["publish-is-once"]);
    assert.deepEqual(handout.rules[0].notes, ["Yes — and it is the one that bites us."]);
    const serialized = JSON.stringify(handout);
    assert.ok(!serialized.includes("Two widgets never share a name"), "a candidate reached the handout");
    assert.ok(!serialized.includes("deleted automatically after thirty days"), "a denied card reached the handout");
    // Provenance is the model's reasoning, not the owner's rule.
    assert.ok(!serialized.includes("409 response"));

    // The same filter, called directly the way an authoring job will call it.
    const direct = await approvedRuleCards(app.db, suite.id);
    assert.deepEqual(direct.map((rule) => rule.id), ["publish-is-once"]);

    // A second proposal cannot put the denied rule back in front of the owner,
    // even when the model ignores the instruction and repeats it verbatim.
    script(cardsReply([PROPOSED[2], { id: "widgets-are-listed", statement: "Every created widget appears in GET /widgets." }]));
    const again = await api.post(`/suites/${suite.id}/rule-cards/propose`, { spec: { document: SPEC } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body.cards.map((card: HostedDynamic) => card.rule_id), ["widgets-are-listed"]);
    assert.ok(again.body.warnings.some((warning: HostedDynamic) => /already denied/.test(warning)));
    // …and the prompt told it so first.
    assert.match(prompts[0], /already DENIED[\s\S]*deleted automatically after thirty days/);

    assert.equal((await api.get(`/suites/${suite.id}/rule-cards`)).body.counts.denied, 1);
  });
});

test("rule cards: authorization, spec validation, and a deployment with no gateway", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const suite = await seedSuite(api);

    delete process.env.PLAYTEST_LLM_BASE_URL;
    const unconfigured = await api.post(`/suites/${suite.id}/rule-cards/propose`, { spec: { document: SPEC } });
    assert.equal(unconfigured.status, 503, JSON.stringify(unconfigured.body));
    assert.match(unconfigured.body.error.message, /You can still write\s+your own rules by hand/);
    assert.equal((await api.get(`/suites/${suite.id}/rule-cards`)).body.can_propose, false);

    process.env.PLAYTEST_LLM_BASE_URL = baseUrl;
    const noSpec = await api.post(`/suites/${suite.id}/rule-cards/propose`, {});
    assert.equal(noSpec.status, 400, JSON.stringify(noSpec.body));
    assert.match(noSpec.body.error.message, /paste or upload your OpenAPI document/);

    const urlSpec = await api.post(`/suites/${suite.id}/rule-cards/propose`, { spec: { url: "https://example.test/openapi.json" } });
    assert.equal(urlSpec.status, 400);
    assert.match(urlSpec.body.error.message, /does not fetch an OpenAPI document from a URL/);

    const emptySpec = await api.post(`/suites/${suite.id}/rule-cards/propose`, { spec: { document: { openapi: "3.0.3", info: { title: "x", version: "1" }, paths: {} } } });
    assert.equal(emptySpec.status, 400);
    assert.match(emptySpec.body.error.message, /declares no operations/);

    const viewer = api.withToken((await api.post("/projects/p/tokens", { role: "viewer", name: "v" })).body.token);
    assert.equal((await viewer.get(`/suites/${suite.id}/rule-cards`)).status, 200);
    assert.equal((await viewer.post(`/suites/${suite.id}/rule-cards`, { statement: "A rule." })).status, 403);

    const editor = api.withToken((await api.post("/projects/p/tokens", { role: "editor", name: "e" })).body.token);
    assert.equal((await editor.post(`/suites/${suite.id}/rule-cards`, { statement: "A rule." })).status, 403, "approving is a reviewer act");
    script(cardsReply([PROPOSED[0]]));
    assert.equal((await editor.post(`/suites/${suite.id}/rule-cards/propose`, { spec: { document: SPEC } })).status, 200, "proposing is a drafting act");
  });
});

test("rule cards: every card mutation writes an audit row and a feed event", async () => {
  process.env.PLAYTEST_LLM_BASE_URL = baseUrl;
  await withApp(async ({ api }: HostedDynamic) => {
    const suite = await seedSuite(api);
    script(cardsReply([PROPOSED[0]]));
    const card = (await api.post(`/suites/${suite.id}/rule-cards/propose`, { spec: { document: SPEC } })).body.cards[0];
    await api.post(`/rule-cards/${card.id}/approve`, { note: "yes" });

    const feed = await api.get(`/projects/p/events/feed?wait=0&after=00000000000000000000000000`);
    const types = feed.body.events.map((event: HostedDynamic) => event.type);
    assert.ok(types.includes("rule_card.proposed"), JSON.stringify(types));
    assert.ok(types.includes("rule_card.approved"), JSON.stringify(types));

    const log = await api.get(`/projects/p/audit`);
    const actions = log.body.items.map((entry: HostedDynamic) => entry.action);
    assert.ok(actions.includes("rule_card.approved"), JSON.stringify(actions));
  });
});
