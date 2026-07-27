// Spec provisioning for script suites
// (docs/contracts/scripts.md#spec-provisioning; DESIGN §4 step 1).
//
// Four ways a document arrives — auto-discovery at a conventional path, a spec
// link header, a configured URL, an uploaded/pasted document — and one way it
// does not arrive: silently. Every path resolves through the shipped P3
// enrichment, and a missing document is an actionable DummyConfigError rather
// than a suite quietly authored against nothing. Offline, loopback only.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSpecSource, SPEC_DISCOVERY_PATHS, normalizeSpecDeclaration, specLinksFrom } from "../../src/public/api-suite-scripts.ts";
import { DummyConfigError } from "../../src/config.ts";
import { startAuthoringApi, LINKED_SPEC_PATH } from "../../../../tests/fixtures/authoring-api/server.ts";

const FIXTURE_SPEC = fileURLToPath(new URL("../../../../tests/fixtures/authoring-api/openapi.json", import.meta.url));

let workDir: LegacyTestValue;
let api: LegacyTestValue = null;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-source-"));
});

afterEach(async () => {
  if (api) await api.close();
  api = null;
  fs.rmSync(workDir, { recursive: true, force: true });
});

test("auto-discovery finds a spec served at the conventional path and enriches it", async () => {
  api = await startAuthoringApi({ spec: "path" });
  const { spec, source } = await resolveSpecSource(null, { baseUrl: api.url, workDir });

  assert.equal(source.kind, "discovered");
  assert.equal(source.detail, `${api.url}/openapi.json`);
  assert.equal(spec.title, "Widget Registry");
  // P3 enrichment, not a raw parse: operations are flat and $refs are resolved.
  assert.equal(spec.operations.length, 7);
  const publish: LegacyTestValue = spec.operations.find((operation) => operation.operation_id === "publishWidget");
  assert.deepEqual(publish.status_codes, ["200", "404", "409"]);
  assert.equal(publish.responses["409"].content["application/json"].schema.properties.error.type, "object");
  assert.ok(fs.existsSync(source.file), "the resolved document is materialized for the run");
});

test("an unexposed spec is discovered through a spec link header on the root", async () => {
  api = await startAuthoringApi({ spec: "link" });
  const { spec, source } = await resolveSpecSource({ discover: true }, { baseUrl: api.url, workDir });

  assert.equal(source.kind, "discovered");
  assert.equal(source.detail, `${api.url}${LINKED_SPEC_PATH}`);
  assert.equal(spec.operations.length, 7);
  // Every conventional path was tried first, and none of them answered.
  assert.deepEqual(source.attempted.slice(0, SPEC_DISCOVERY_PATHS.length), SPEC_DISCOVERY_PATHS.map((suffix: LegacyTestValue) => `${api.url}${suffix}`));
});

test("a target that exposes nothing falls back to a configured URL, an upload, or a file — and never to a degraded run", async () => {
  api = await startAuthoringApi({ spec: "none" });

  await assert.rejects(
    () => resolveSpecSource(null, { baseUrl: api.url, workDir }),
    (error: LegacyTestValue) => {
      assert.ok(error instanceof DummyConfigError, "a missing spec is user-actionable configuration, not a crash");
      assert.match(error.message, /exposes no OpenAPI document/);
      assert.match(error.message, /\/openapi\.json/);
      assert.match(error.message, /spec\.url/);
      assert.doesNotMatch(error.message, /MODULE_NOT_FOUND|at Object\./);
      return true;
    },
  );

  // The same target, told where the document is.
  const fromFile = await resolveSpecSource({ file: FIXTURE_SPEC }, { baseUrl: api.url, workDir });
  assert.equal(fromFile.source.kind, "file");
  assert.equal(fromFile.spec.operations.length, 7);

  const pasted = await resolveSpecSource(
    { document: JSON.parse(fs.readFileSync(FIXTURE_SPEC, "utf8")) },
    { baseUrl: api.url, workDir: path.join(workDir, "pasted") },
  );
  assert.equal(pasted.source.kind, "document");
  assert.equal(pasted.spec.operations.length, 7);

  const asText = await resolveSpecSource(
    { text: fs.readFileSync(FIXTURE_SPEC, "utf8") },
    { baseUrl: api.url, workDir: path.join(workDir, "text") },
  );
  assert.equal(asText.spec.title, "Widget Registry");
});

test("a configured URL is fetched, and a URL that does not serve a document is an actionable error", async () => {
  api = await startAuthoringApi({ spec: "path" });

  const resolved = await resolveSpecSource({ url: `${api.url}/openapi.json` }, { workDir });
  assert.equal(resolved.source.kind, "url");
  assert.equal(resolved.spec.operations.length, 7);

  await assert.rejects(
    () => resolveSpecSource({ url: `${api.url}/health` }, { workDir: path.join(workDir, "b") }),
    (error: LegacyTestValue) => {
      assert.ok(error instanceof DummyConfigError);
      assert.match(error.message, /has no "paths" object/);
      return true;
    },
  );
  await assert.rejects(
    () => resolveSpecSource({ url: `${api.url}/nope` }, { workDir: path.join(workDir, "c") }),
    (error: LegacyTestValue) => {
      assert.match(error.message, /answered 404/);
      return true;
    },
  );
});

test("declarations normalize to exactly one mode, and there is no way to declare no spec at all", () => {
  assert.deepEqual(normalizeSpecDeclaration(null).kind, "discovered");
  assert.deepEqual(normalizeSpecDeclaration("https://api.example.com/openapi.json"), { kind: "url", url: "https://api.example.com/openapi.json" });
  assert.deepEqual(normalizeSpecDeclaration("./openapi.yaml"), { kind: "file", file: "./openapi.yaml" });
  assert.throws(() => normalizeSpecDeclaration(false), (error) => error instanceof DummyConfigError && /needs an OpenAPI document/.test(error.message));
  assert.throws(
    () => normalizeSpecDeclaration({ url: "https://x/y", file: "./z" }),
    (error) => error instanceof DummyConfigError && /exactly one of/.test(error.message),
  );
  assert.throws(() => normalizeSpecDeclaration({ url: "ftp://x/y" }), (error) => error instanceof DummyConfigError && /http\(s\) URL/.test(error.message));
});

test("only the standard description relations are followed out of a link header", () => {
  assert.deepEqual(specLinksFrom('</schema.json>; rel="service-desc"', "http://x.test/"), ["http://x.test/schema.json"]);
  assert.deepEqual(specLinksFrom('</a>; rel="describedby", </b>; rel="next"', "http://x.test/"), ["http://x.test/a"]);
  assert.deepEqual(specLinksFrom('</evil>; rel="preload"', "http://x.test/"), []);
  assert.deepEqual(specLinksFrom(null, "http://x.test/"), []);
});
