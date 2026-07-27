// The transport seam (docs/contracts/engine.md#driver-contract):
// createDriver dispatch, the
// per-driver actor overlay + forced-tool schema filtering, and the `driver`
// comparability pin. Offline — no browser, no API key. Deterministic browser
// execution is covered separately under tests/core/browser/.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

import { createDriver } from "../../../src/core/driver.ts";
import { DummyConfigError } from "../../../src/core/config.ts";
import { runAxeInPage } from "../../../src/core/axe-source.ts";
import { createHarFlusher } from "../../../src/core/drivers/har.ts";
import { overlayFor, toolParamsFor, stepSchemaFor, normalizeDriver, DRIVER_VERBS, __testing } from "../../../src/core/drivers/overlay.ts";
import { processScreenshotImage } from "../../../src/core/drivers/web.ts";
import { comparablePins } from "../../../src/core/shared/movement.ts";
import { SNAPSHOT_FORMAT as MOBILE_SNAPSHOT_FORMAT } from "../../../src/core/drivers/mobile-snapshot.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stepSchema: LegacyTestValue = JSON.parse(read("src/core/schemas/step.schema.json"));
const WEB_VERBS = ["click", "type", "select", "scroll", "navigate", "back", "wait", "done", "give_up"];
const API_VERBS = ["request", "wait", "done", "give_up"];
// @ts-expect-error -- Ajv's NodeNext declaration exposes the runtime default constructor incompatibly
const ajv = new Ajv({ allErrors: true });
const WEB_FIELDS = ["direction", "ref", "reason", "seconds", "submit", "summary", "text", "url", "value"];

// ---------- createDriver dispatch ----------

test("createDriver rejects an unknown driver with a DummyConfigError naming it", async () => {
  const rc: LegacyTestValue = { env: { driver: "carrier-pigeon", storage_state: null } };
  await assert.rejects(
    () => createDriver(rc, { baseUrl: "http://x" } as LegacyTestValue, { runDir: "/tmp/x" }), // TODO(ts): incomplete environment reaches unknown-driver validation
    (e) => e instanceof DummyConfigError && /carrier-pigeon/.test(e.message) && /web \| mobile \| api/.test(e.message),
  );
});

// ---------- the canonical schema is flat (schema_version 7, no oneOf) ----------

test("overlayFor('web') is actor-system.md verbatim", () => {
  assert.equal(overlayFor("web").prompt, read("src/core/prompts/actor-system.md").trim());
});

test("the canonical step schema is a flat action object, not a oneOf union", () => {
  const action = stepSchema.properties.action;
  assert.equal(action.oneOf, undefined, "no discriminated union");
  assert.equal(action.type, "object");
  assert.ok(Array.isArray(action.allOf), "per-verb requireds via allOf");
  // type enum is the full union across drivers.
  assert.deepEqual(
    [...action.properties.type.enum].sort(),
    [...new Set([...WEB_VERBS, "tap", "swipe", "request"])].sort(),
  );
  assert.ok(stepSchema.description.includes("schema_version 7"));
  assert.ok(stepSchema.properties.raises, "raises sticky-note array");
  assert.deepEqual(stepSchema.properties.raises.items.properties.kind.enum, ["confusion", "finding"]);
});

// ---------- toolParamsFor: the stripped, model-facing (SHIPPED) schema ----------

test("toolParamsFor('web') ships only web verbs+fields, advisory keywords stripped", () => {
  const params: LegacyTestValue = toolParamsFor("web");
  assert.equal(params.$id, undefined, "no $id shipped");
  assert.equal(params.$schema, undefined);
  assert.equal(params.$comment, undefined);
  assert.equal(params.additionalProperties, undefined, "shipped schema is documentation, not strict");
  const action = params.properties.action;
  assert.equal(action.oneOf, undefined, "flat, not a union");
  assert.equal(action.allOf, undefined, "no allOf shipped");
  assert.equal(action.additionalProperties, undefined);
  assert.deepEqual(action.properties.type.enum, WEB_VERBS);
  // Only web fields — never the api/mobile params.
  const fields = Object.keys(action.properties).filter((k) => k !== "type");
  assert.deepEqual(fields.sort(), [...WEB_FIELDS].sort());
  for (const foreign of ["method", "path", "body", "headers"]) {
    assert.equal(action.properties[foreign], undefined, `web must not ship ${foreign}`);
  }
  // direction enum scoped to web (no left/right); advisory min/max dropped.
  assert.deepEqual(action.properties.direction.enum, ["up", "down"]);
  assert.equal(action.properties.seconds.minimum, undefined);
  assert.equal(action.properties.seconds.maximum, undefined);
});

test("toolParamsFor('api') ships only api verbs+fields (never ref)", () => {
  const action: LegacyTestValue = toolParamsFor("api").properties.action;
  assert.deepEqual(action.properties.type.enum, API_VERBS);
  const fields = Object.keys(action.properties).filter((k) => k !== "type");
  assert.deepEqual(fields.sort(), ["body", "headers", "method", "path", "reason", "seconds", "summary"].sort());
  assert.equal(action.properties.ref, undefined, "api never sees ref");
});

// ---------- stepSchemaFor: the strict VALIDATOR ----------

test("stepSchemaFor('web') keeps the teeth, scopes the enums, strips $id", () => {
  const v: LegacyTestValue = stepSchemaFor("web");
  assert.equal(v.$id, undefined, "$id stripped so drivers compile in one Ajv");
  assert.equal(v.additionalProperties, false);
  const action = v.properties.action;
  assert.equal(action.additionalProperties, false);
  assert.ok(Array.isArray(action.allOf), "per-verb requireds enforced");
  assert.deepEqual(action.properties.type.enum, WEB_VERBS, "type scoped to web verbs");
  assert.deepEqual(action.properties.direction.enum, ["up", "down"], "direction scoped to web");
  assert.equal(action.properties.seconds.minimum, 0.1, "wait bounds kept");
  assert.equal(action.properties.seconds.maximum, 10);
});

test("the web validator enforces per-verb requireds and rejects foreign verbs", () => {
  const validate = ajv.compile(stepSchemaFor("web"));
  const ok = (action: LegacyTestValue) => validate({ thought: "t", action, expectation: "e" });
  assert.ok(ok({ type: "click", ref: "e3" }));
  assert.ok(ok({ type: "type", ref: "e2", text: "milk", submit: true }));
  assert.ok(ok({ type: "select", ref: "e2", value: "High" }));
  assert.ok(ok({ type: "scroll", direction: "down" }));
  assert.ok(ok({ type: "back" }), "back needs no extra fields");
  assert.ok(ok({ type: "done", summary: "added the todo" }));
  // missing the verb's required field -> rejected (the new allOf is the gate)
  assert.ok(!ok({ type: "click" }), "click without ref");
  assert.ok(!ok({ type: "type", ref: "e2" }), "type without text");
  assert.ok(!ok({ type: "select", ref: "e2" }), "select without value");
  assert.ok(!ok({ type: "navigate" }), "navigate without url");
  // a verb this driver doesn't have -> rejected by the scoped type enum
  assert.ok(!ok({ type: "request", method: "GET", path: "/x" }), "web has no request verb");
  assert.ok(!ok({ type: "swipe", direction: "left" }), "web has no swipe verb");
  // a direction value foreign to web -> rejected by the scoped direction enum
  assert.ok(!ok({ type: "scroll", direction: "left" }), "web scroll has no left/right");
});

test("the api validator requires method+path and accepts a string-or-JSON body", () => {
  const validate = ajv.compile(stepSchemaFor("api"));
  const ok = (action: LegacyTestValue) => validate({ thought: "t", action, expectation: "e" });
  assert.ok(ok({ type: "request", method: "GET", path: "/api/todos" }));
  assert.ok(ok({ type: "request", method: "POST", path: "/api/todos", body: { title: "x" } }), "body may be an object");
  assert.ok(ok({ type: "request", method: "POST", path: "/api/todos", body: "raw" }), "or a string");
  assert.ok(!ok({ type: "request", method: "GET" }), "request without path");
  assert.ok(!ok({ type: "click", ref: "e3" }), "api has no click verb");
});

test("flat validator accepts a cross-verb stray field — deliberate relaxation (engine contract)", () => {
  // A click carrying a stray `seconds` now VALIDATES: the flat action can't
  // reject a field valid for another web verb. Drivers ignore unread fields
  // (#perform switches on type). Pinned so the relaxation stays deliberate.
  const validate = ajv.compile(stepSchemaFor("web"));
  assert.ok(validate({ thought: "t", action: { type: "click", ref: "e3", seconds: 5 }, expectation: "e" }));
});

test("VERB_FIELDS covers every canonical allOf required field (shipped subset can't drop an enforced field)", () => {
  const { VERB_FIELDS } = __testing;
  const props = stepSchema.properties.action.properties;
  for (const [verb, fields] of Object.entries(VERB_FIELDS)) {
    for (const f of fields) assert.ok(props[f], `VERB_FIELDS[${verb}] references unknown field ${f}`);
  }
  for (const branch of stepSchema.properties.action.allOf) {
    const t = branch.if.properties.type;
    const verbs = t.const ? [t.const] : t.enum;
    for (const verb of verbs) {
      for (const req of branch.then.required) {
        assert.ok(VERB_FIELDS[verb as keyof typeof VERB_FIELDS].includes(req), `${verb} requires ${req} but VERB_FIELDS omits it`); // TODO(ts): assertion validates schema-derived verb
      }
    }
  }
});

test("normalizeDriver defaults anything unknown (and absent) to web", () => {
  assert.equal(normalizeDriver("web"), "web");
  assert.equal(normalizeDriver(undefined), "web");
  assert.equal(normalizeDriver("nope"), "web");
  // The map is the single source of truth for verb subsets; web gained `back`.
  assert.deepEqual(Object.keys(DRIVER_VERBS).sort(), ["api", "mobile", "web"]);
  assert.ok(DRIVER_VERBS.web.includes("back"), "web has the browser back verb");
});

// ---------- the driver pin keys comparability (R3) ----------

test("driver is a comparability pin: web and mobile runs never compare", () => {
  const base = {
    harness_version: "0.1.0", prompts_version: "prompts-v1", step_schema_version: 3,
    snapshot_format: "a11y-text-v1", settle: { name: "settle-v1" },
    actor_model: "claude-haiku-4-5", grader_model: "claude-sonnet-4-6", headed: false, vision: false,
  };
  assert.equal(comparablePins({ ...base, driver: "web" }, { ...base, driver: "web" }), true);
  assert.equal(comparablePins({ ...base, driver: "web" }, { ...base, driver: "mobile" }), false);
  // A legacy manifest with no driver pin stays wildcard-comparable to a new run.
  assert.equal(comparablePins({ ...base, driver: "web" }, base), true);
});

// Realistic per-driver pin sets: each transport pins its OWN driver +
// snapshot_format + settle (the values runner.js actually writes), so two runs
// on different transports can never share a history line — even if every other
// shared pin matches — while two runs on the same transport do.
test("comparablePins: cross-driver never compares, same-driver does (full per-driver pin sets)", () => {
  const common = {
    harness_version: "0.1.0", prompts_version: "prompts-v1", step_schema_version: 3,
    actor_model: "claude-haiku-4-5", grader_model: "claude-sonnet-4-6", headed: false, vision: false,
  };
  const web = { ...common, driver: "web", snapshot_format: "a11y-text-v1", settle: { name: "settle-v1" } };
  const api = { ...common, driver: "api", snapshot_format: "api-text-v1", settle: { name: "settle-api-v1" } };
  const mobileA = { ...common, driver: "mobile", snapshot_format: MOBILE_SNAPSHOT_FORMAT, settle: { name: "settle-mobile-v1" } };
  const mobileB = { ...common, driver: "mobile", snapshot_format: MOBILE_SNAPSHOT_FORMAT, settle: { name: "settle-mobile-v1" } };

  // web vs api: the driver pin alone fragments the history (false)…
  assert.equal(comparablePins(web, api), false);
  // …and so does snapshot_format, independently — drop the driver pin from both
  // and the formats still disagree, so they stay incomparable.
  const { driver: _wd, ...webNoDriver } = web;
  const { driver: _ad, ...apiNoDriver } = api;
  assert.notEqual(webNoDriver.snapshot_format, apiNoDriver.snapshot_format);
  assert.equal(comparablePins(webNoDriver, apiNoDriver), false);

  // two mobile runs share every pin, so they DO compare (true).
  assert.equal(comparablePins(mobileA, mobileB), true);
});

// ---------- P3 hot-path helpers ----------

function pngWithDimensions(width: number, height: number) {
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

test("runAxeInPage avoids resending axe-core source when window.axe is already present", async () => {
  const calls: LegacyTestValue[] = [];
  const page: LegacyTestValue = {
    async evaluate(_fn: LegacyTestValue, arg: LegacyTestValue) {
      calls.push(arg);
      if (calls.length === 1) return true;
      assert.equal(arg[0], null, "source string should not cross CDP when axe is installed");
      return { violations: [], counts: { total: 0 } };
    },
  };

  assert.deepEqual(await runAxeInPage(page), { violations: [], counts: { total: 0 } });
  assert.equal(calls.length, 2);
});

test("processScreenshotImage computes dHash and downscaled image in one page evaluate", async () => {
  const original = pngWithDimensions(2000, 1000);
  const downscaled = Buffer.from("downscaled-png");
  let evaluateCalls = 0;
  const page: LegacyTestValue = {
    async evaluate(_fn: LegacyTestValue, arg: LegacyTestValue) {
      evaluateCalls++;
      assert.equal(arg.downscale, true);
      assert.match(arg.src, /^data:image\/png;base64,/);
      return {
        dHash: "0123456789abcdef",
        downscaledDataUrl: `data:image/png;base64,${downscaled.toString("base64")}`,
      };
    },
  };

  const processed = await processScreenshotImage(page, original, 1000);
  assert.equal(evaluateCalls, 1);
  assert.equal(processed.screenshotHash, "0123456789abcdef");
  assert.deepEqual(processed.screenshot, downscaled);
});

test("createHarFlusher writes the first step, batches later steps, and force-flushes current entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-har-"));
  try {
    const entries: LegacyTestValue[] = [];
    const flush = createHarFlusher(dir, entries, { interval: 3 });
    const add = (n: number) => entries.push({ request: { method: "GET", url: `http://x/${n}` }, response: { status: 200 } });
    const diskCount = () => JSON.parse(fs.readFileSync(path.join(dir, "har.json"), "utf8")).log.entries.length;

    add(1);
    assert.equal(flush(), true, "first step is written for crash recovery");
    assert.equal(diskCount(), 1);

    add(2);
    assert.equal(flush(), false, "non-interval step skips the hot-path rewrite");
    assert.equal(diskCount(), 1, "disk stays at the last flushed snapshot");

    add(3);
    assert.equal(flush(), true, "interval step rewrites the HAR");
    assert.equal(diskCount(), 3);

    add(4);
    assert.equal(flush(), false);
    add(5);
    assert.equal(flush({ force: true }), true, "gate/close can force the latest entries");
    assert.equal(diskCount(), 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
