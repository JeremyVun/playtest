// Binding inference is deliberately timid: an over-eager binding corrupts a
// replay silently, which is worse than a brittle replay failing loudly. These
// tests pin exactly what does and does not bind
// (docs/contracts/engine.md#bindings).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { applyBindings, indexProducers, inferBindings, normalizeBindPaths, requestLiterals, resolveBindings } from "../../../src/core/bindings.ts";
import { registerSecretValue, resetSecrets } from "../../../src/core/secrets.ts";
import { remapBindings } from "../../../src/core/runner.ts";

/** Index one response, then parameterize one consumer action against it. */
function parameterize(response: LegacyTestValue, action: LegacyTestValue, { step = 1, sent = [], names = new Map(), byName = new Map(), declared = null }: LegacyTestValue = {}): LegacyTestValue {
  const producers = indexProducers(new Map(), { step, body: response, sent: new Set(sent), declared });
  return inferBindings(action, { producers, names, byName });
}

test("an id echoed into a later path, body, header, and query all bind to one variable", () => {
  const produced = { id: "acc_9f2c", status: "pending" };
  const { action, bindings } = parameterize(produced, {
    type: "request",
    method: "POST",
    path: "/accounts/acc_9f2c/entries?ledger=acc_9f2c",
    headers: { "X-Account-Id": "acc_9f2c", "Idempotency-Key": "post-entry-1" },
    body: { account_id: "acc_9f2c", amount: 250, memo: "rent" },
  });
  assert.equal(action.path, "/accounts/{{id_1}}/entries?ledger={{id_1}}");
  assert.equal(action.headers["X-Account-Id"], "{{id_1}}");
  assert.equal(action.headers["Idempotency-Key"], "post-entry-1", "a client-authored header is untouched");
  assert.equal(action.body.account_id, "{{id_1}}");
  assert.equal(action.body.memo, "rent");
  assert.deepEqual(bindings, [
    { name: "id_1", from_step: 1, from: "$.id", into: ["path", "query.ledger", "headers.X-Account-Id", "body.account_id"] },
  ]);
});

test("nothing ambiguous binds: echoes, non-identifier keys, numbers, and short values keep their literal", () => {
  const consumer = () => ({
    type: "request",
    method: "POST",
    path: "/orders",
    body: { owner: "ada", state: "pending", quantity: 3, code: "ab", ref: "OK" },
  });

  // 1. a value the CLIENT sent, which the server merely echoed back
  const echoed = parameterize({ id: "ord_1", owner: "ada" }, consumer(), { sent: ["ada"] });
  assert.equal(echoed.action.body.owner, "ada");
  // 2. a server value under a key that is not identifier-shaped
  const enumLike = parameterize({ state: "pending" }, consumer());
  assert.equal(enumLike.action.body.state, "pending");
  // 3. a number — "3" is as likely a page size as an id
  const numeric = parameterize({ id: 3 }, consumer());
  assert.equal(numeric.action.body.quantity, 3);
  // 4. a short value, which would match unrelated content everywhere
  const short = parameterize({ ref: "OK" }, consumer());
  assert.equal(short.action.body.ref, "OK");
  for (const result of [echoed, enumLike, numeric, short]) {
    assert.deepEqual(result.bindings, [], "an ambiguous literal creates NO binding");
    assert.equal(result.action.type, "request");
  }
  // ...and an action nothing binds into is returned unchanged by identity, so an
  // unaffected step is byte-identical to one recorded before bindings existed.
  const same = consumer();
  assert.equal(parameterize({ state: "pending" }, same).action, same);
});

test("an opaque identifier binds on shape alone, whatever its key is called", () => {
  const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const { action, bindings } = parameterize({ handle: uuid }, { type: "request", method: "GET", path: `/things/${uuid}` });
  assert.equal(action.path, "/things/{{handle_1}}");
  assert.equal(bindings[0].from, "$.handle");
});

test("a resolved secret value never becomes a binding", () => {
  resetSecrets();
  const stripeLikeToken = ["sk", "live", "4kQ9zVn2XbR7tLpW8mHc3JdY"].join("_");
  registerSecretValue(stripeLikeToken, "LEDGER_TOKEN");
  const { action, bindings } = parameterize(
    { token: stripeLikeToken },
    { type: "request", method: "GET", path: "/me", headers: { Authorization: stripeLikeToken } },
  );
  assert.equal(action.headers.Authorization, stripeLikeToken, "secrets are handled by redaction, not binding");
  assert.deepEqual(bindings, []);
  resetSecrets();
});

test("only WHOLE values bind — never a substring of a longer one", () => {
  const { action, bindings } = parameterize(
    { id: "acc_9f2c" },
    { type: "request", method: "POST", path: "/notes", body: { text: "please review acc_9f2c today" } },
  );
  assert.equal(action.body.text, "please review acc_9f2c today");
  assert.deepEqual(bindings, []);
});

test("a value that would reshape the URL is not templated into it", () => {
  // A producer whose value carries a slash is a fine body binding and a terrible
  // path one: substituting it at act time would silently address a different
  // resource.
  const { action, bindings } = parameterize(
    { href: "/accounts/acc_1" },
    { type: "request", method: "GET", path: "//accounts/acc_1", body: { link: "/accounts/acc_1" } },
  );
  assert.equal(action.path, "//accounts/acc_1", "the URL keeps its literal");
  assert.equal(action.body.link, "{{href_1}}", "the body still binds");
  assert.deepEqual(bindings[0].into, ["body.link"]);
});

test("a declared bind path widens which fields produce, never the safety rules", () => {
  const declared = normalizeBindPaths(["$.data.reference", "items[*].handle"], "playtest.yaml");
  assert.deepEqual(declared, ["$.data.reference", "$.items[*].handle"], "paths normalize to $-rooted, index-wildcarded form");

  const response = { data: { reference: "ZQ-40192" }, items: [{ handle: "widget-blue" }] };
  const consumer = { type: "request", method: "POST", path: "/orders/ZQ-40192", body: { sku: "widget-blue" } };
  assert.deepEqual(parameterize(response, consumer).bindings, [], "neither key is identifier-shaped, so nothing binds by default");

  const { action, bindings } = parameterize(response, consumer, { declared });
  assert.equal(action.path, "/orders/{{reference_1}}");
  assert.equal(action.body.sku, "{{handle_1}}");
  assert.deepEqual(bindings.map((b: LegacyTestValue) => b.from).sort(), ["$.data.reference", "$.items[0].handle"]);

  // The value rules still hold for a declared path: an echo of the client's own
  // input, and anything too short, stay literal.
  const echoed = parameterize({ data: { reference: "ZQ-40192" } }, consumer, { declared, sent: ["ZQ-40192"] });
  assert.deepEqual(echoed.bindings, []);
  const short = parameterize({ data: { reference: "ZQ" } }, { type: "request", method: "GET", path: "/orders/ZQ" }, { declared });
  assert.deepEqual(short.bindings, []);

  assert.equal(normalizeBindPaths(undefined, "x.yaml"), null);
  assert.throws(() => normalizeBindPaths([""], "x.yaml"), /bind entries are response field paths/);
  assert.throws(() => normalizeBindPaths(["a b"], "x.yaml"), /is not a field path/);
});

test("a token the actor reused from its own history binds like any other substitution", () => {
  // The actor reads its own action history, so it can copy a `{{name}}` it made
  // earlier. That must record a real binding, not a token nothing resolves.
  const names = new Map();
  const byName = new Map();
  const first = parameterize({ id: "acc_9f2c" }, { type: "request", method: "GET", path: "/accounts/acc_9f2c" }, { names, byName });
  assert.equal(first.action.path, "/accounts/{{id_1}}");

  const reused = parameterize(
    { unrelated_id: "zzz_1111" },
    { type: "request", method: "POST", path: "/accounts/{{id_1}}/close" },
    { step: 2, names, byName },
  );
  assert.equal(reused.action.path, "/accounts/{{id_1}}/close");
  assert.deepEqual(reused.bindings, [{ name: "id_1", from_step: 1, from: "$.id", into: ["path"] }]);

  // A token naming nothing stays literal, so the request fails loudly rather
  // than being sent with a half-substituted path.
  const unknown = parameterize({}, { type: "request", method: "GET", path: "/accounts/{{nope}}" }, { names, byName });
  assert.deepEqual(unknown.bindings, []);
});

test("the earliest producer wins, so provenance is stable when a value repeats", () => {
  const producers = new Map();
  indexProducers(producers, { step: 2, body: { id: "acc_1" }, sent: new Set() });
  indexProducers(producers, { step: 5, body: { account_id: "acc_1" }, sent: new Set() });
  const { bindings } = inferBindings({ type: "request", method: "GET", path: "/accounts/acc_1" }, { producers, names: new Map() });
  assert.deepEqual(bindings, [{ name: "id_2", from_step: 2, from: "$.id", into: ["path"] }]);
});

test("resolution re-reads the FRESH response, and every failure is loud", () => {
  const ledger = new Map([[2, { id: "acc_FRESH", nested: { list: [{ id: "ent_9" }] } }]]);
  const { vars, problems } = resolveBindings(
    [
      { name: "id_2", from_step: 2, from: "$.id" },
      { name: "ent", from_step: 2, from: "$.nested.list[0].id" },
    ] as LegacyTestValue, // SAFETY: resolution tests deliberately omit unused `into` fields
    ledger,
  );
  assert.deepEqual(problems, []);
  assert.deepEqual([...vars], [["id_2", "acc_FRESH"], ["ent", "ent_9"]]);

  const missingStep: LegacyTestValue = resolveBindings([{ name: "x", from_step: 7, from: "$.id" }] as LegacyTestValue, ledger); // SAFETY: resolution tests deliberately omit unused `into` fields
  assert.match(missingStep.problems[0], /cites step 7, which recorded no response body/);
  const movedField: LegacyTestValue = resolveBindings([{ name: "x", from_step: 2, from: "$.identifier" }] as LegacyTestValue, ledger); // SAFETY: resolution tests deliberately omit unused `into` fields
  assert.match(movedField.problems[0], /no longer carries a value there/);
  const notScalar: LegacyTestValue = resolveBindings([{ name: "x", from_step: 2, from: "$.nested" }] as LegacyTestValue, ledger); // SAFETY: resolution tests deliberately omit unused `into` fields
  assert.equal(notScalar.problems.length, 1, "an object is not a substitutable value");
});

test("substitution reports unbound tokens and unsafe values instead of sending them", () => {
  const action = { type: "request", method: "GET", path: "/accounts/{{id_1}}", headers: { "X-A": "{{gone}}" }, body: { a: ["{{id_1}}"] } };
  const ok = applyBindings(action, new Map([["id_1", "acc_2"], ["gone", "g1"]]));
  assert.equal(ok.path, "/accounts/acc_2");
  assert.deepEqual(ok.body, { a: ["acc_2"] });
  assert.deepEqual(ok.missing, []);

  const partial = applyBindings(action, new Map([["id_1", "acc_2"]]));
  assert.deepEqual(partial.missing, ["gone"], "an unresolved token is reported, never sent as a literal");

  const dangerous = applyBindings(action, new Map([["id_1", "../admin"], ["gone", "g"]]));
  assert.deepEqual(dangerous.unsafe, ["id_1=../admin"], "a value that would reshape the URL is refused");
});

test("replay translates a binding's producer step into the acting run's numbering", () => {
  const bindings = [{ name: "id_1", from_step: 1, from: "$.id", into: ["path"] }];
  assert.deepEqual(remapBindings(bindings, new Map([[1, 4]])), [{ name: "id_1", from_step: 4, from: "$.id", into: ["path"] }]);
  // A producer the replay has not reached keeps its recorded number, so the
  // driver reports an unresolvable binding rather than substituting something else.
  assert.deepEqual(remapBindings(bindings, new Map()), bindings);
  assert.deepEqual(remapBindings(undefined, new Map()), []);
});

test("requestLiterals sees every string a request carried, path segments included", () => {
  const literals = requestLiterals({ path: "/a/acc_1?q=zed", headers: { H: "hv" }, body: { deep: ["dv"] } });
  for (const value of ["a", "acc_1", "q", "zed", "hv", "dv"]) assert.ok(literals.has(value), `expected ${value}`);
});

// `bind` is inheritable and config.ts reads it off the MERGED config, so it has
// to be spelled in both schemas. It was declared only in defaults.schema.json,
// which meant a case-level `bind:` was rejected as an unknown key while its
// siblings `match:` and `redact:` were accepted — the same shape as the P0 bug
// where app.allowed_origins was honored by the code and refused by the schema.
test("a case file may declare bind, exactly like its inheritable siblings", () => {
  const caseSchema = JSON.parse(fs.readFileSync(new URL("../../../src/core/schemas/case.schema.json", import.meta.url), "utf8"));
  const defaultsSchema = JSON.parse(fs.readFileSync(new URL("../../../src/core/schemas/defaults.schema.json", import.meta.url), "utf8"));
  assert.equal(caseSchema.additionalProperties, false, "the case schema is closed, so an unlisted key is a hard error");
  for (const key of ["match", "bind", "redact"]) {
    assert.ok(caseSchema.properties[key], `case.schema.json must accept ${key}`);
  }
  assert.deepEqual(
    caseSchema.properties.bind,
    defaultsSchema.properties.bind,
    "the two schemas must describe bind identically or the two levels accept different YAML",
  );
});
