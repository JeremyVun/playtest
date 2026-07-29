// GET /suites/:s/playwright-export?story= — the hosted half of the one-way
// Playwright export (docs/contracts/interfaces.md#playwright-export). The
// generator itself is covered by the core tests; this pins the HTTP contract:
// the right baseline is chosen, the download headers are right, and every
// refusal is a friendly message rather than a stack.
import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withApp, createTarget } from "./helpers.ts";
import { writeBundle } from "@playtest/core/artifacts";
import { ulid } from "../../src/ulid.ts";

/** A suite that authors its own target, the way a CLI-first tree does. */
const SUITE_FILES = [
  { path: "playtest.yaml", content: "app:\n  driver: web\n  base_url: http://shop.test\n" },
  {
    path: "stories/checkout.yaml",
    content: [
      "story: Buy one thing and land on the receipt.",
      "success:",
      "  - url_matches: /order/receipt*",
      '  - element_exists: \'[data-testid="receipt-total"]\'',
      "  - assert: the receipt names the item",
      "",
    ].join("\n"),
  },
  {
    path: "stories/over-http.yaml",
    content: "app:\n  driver: api\n  base_url: http://shop.test\nstory: Call the orders API.\n",
  },
];

/** A sealed run bundle whose trajectory.jsonl is a two-step web baseline. */
async function seedBundle(app: HostedDynamic, tmp: HostedDynamic, storyId: HostedDynamic) {
  const runDir = path.join(tmp, `bundle-${storyId.replace(/\W/g, "-")}`);
  await fsp.mkdir(runDir, { recursive: true });
  const envelopes = [
    {
      step: 1,
      schema_version: 7,
      mode: "agent",
      agent: { thought: "Name the order first.", action: { type: "type", ref: "e1", text: 'Ada "Lovelace"' }, expectation: "filled" },
      resolution: { ref: "e1", locator: '[data-testid="name"]', bbox: {} },
      result: { ok: true, error: null, url: "http://shop.test/cart" },
    },
    {
      step: 2,
      schema_version: 7,
      mode: "agent",
      agent: { thought: "Place the order.", action: { type: "click", ref: "e2" }, expectation: "receipt" },
      resolution: { ref: "e2", locator: 'role=button[name="Place order"]', bbox: {} },
      result: { ok: true, error: null, url: "http://shop.test/order/receipt" },
    },
  ];
  await fsp.writeFile(runDir + "/trajectory.jsonl", envelopes.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await fsp.writeFile(
    runDir + "/manifest.json",
    JSON.stringify({ run_id: "2026-06-10T0300-ab12", mode: "record", case: { id: storyId }, result: { status: "pass" } }),
  );
  const bundlePath = path.join(tmp, `${storyId.replace(/\W/g, "-")}.ptrun`);
  await writeBundle(runDir, bundlePath);
  const key = `runs/${ulid()}.ptrun`;
  await app.store.put(key, await fsp.readFile(bundlePath));
  return `${key}#trajectory.jsonl`;
}

/** The same suite with no authored target at all — the hosted-native shape, where
 * the ring supplies the URL at launch and hosted reads resolve structurally. */
const TARGET_FREE_SUITE_FILES = SUITE_FILES.map((f) =>
  f.path === "playtest.yaml" ? { path: f.path, content: "app:\n  driver: web\n" } : f,
);

async function seed(api: HostedDynamic, files = SUITE_FILES) {
  const project = (await api.post("/projects", { key: "pwx", name: "Playwright export" })).body;
  // The suite binds to an application, and the ring is what holds the URL a
  // hosted run points at, so the target pair is created before the suite.
  await createTarget(api, project, { key: "shop", name: "Shop", baseUrl: "http://shop.test" });
  const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "shop", name: "Shop" })).body;
  const commit = await api.post(`/suites/${suite.id}/commit`, { changes: files, note: "seed" });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  return { project, suite };
}

async function insertBaseline(app: HostedDynamic, { project, suite, storyId, trajectoryKey, version = 1, supersededBy = null }: HostedDynamic) {
  const id = ulid();
  await app.db.query(
    `INSERT INTO baselines (id, project_id, suite_id, story_id, version, trajectory_key, meta, superseded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      project.id,
      suite.id,
      storyId,
      version,
      trajectoryKey,
      JSON.stringify({ run_id: `2026-06-10T030${version}-ab12`, accepted_at: "2026-06-10T03:04:05.000Z", pins: {} }),
      supersededBy,
    ],
  );
  return id;
}

test("playwright export returns a downloadable spec for the accepted baseline", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-pwx-"));
  try {
    await withApp(async ({ api, app }: HostedDynamic) => {
      const { project, suite } = await seed(api);
      const key = await seedBundle(app, tmp, "checkout");
      await insertBaseline(app, { project, suite, storyId: "checkout", trajectoryKey: key });

      const res = await api.get(`/suites/${suite.id}/playwright-export?story=checkout`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.match(res.headers.get("content-type"), /text\/plain/);
      assert.equal(res.headers.get("content-disposition"), 'attachment; filename="checkout.spec.ts"');

      const code = res.body.toString("utf8");
      assert.match(code, /GENERATED by `playtest export`/);
      assert.match(code, /ONE-WAY snapshot/);
      assert.match(code, /import \{ test, expect \} from "@playwright\/test";/);
      assert.match(code, /const BASE_URL = process\.env\.PLAYTEST_BASE_URL \?\? "http:\/\/shop\.test";/);
      // Both recorded steps, with the saved locators verbatim.
      assert.match(code, /await page\.locator\("\[data-testid=\\"name\\"\]"\)\.fill\("Ada \\"Lovelace\\""\);/);
      assert.match(code, /await page\.locator\("role=button\[name=\\"Place order\\"\]"\)\.click\(\);/);
      // The gate: two asserted criteria and one annotated LLM claim.
      assert.match(code, /globToRegExp\("\/order\/receipt\*"\)/);
      assert.match(code, /not\.toHaveCount\(0\)/);
      assert.match(code, /type: "playtest-assert"/);

      // The notes header lets the UI report what could not be asserted.
      const notes = JSON.parse(Buffer.from(res.headers.get("x-playtest-export-notes"), "base64").toString("utf8"));
      assert.equal(notes.length, 1);
      assert.match(notes[0], /LLM-judged/);
    });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("playwright export of a target-free hosted suite bakes in no default URL", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-pwx-nourl-"));
  try {
    await withApp(async ({ api, app }: HostedDynamic) => {
      // A hosted suite legitimately authors no target: the ring supplies the URL
      // at launch, and the ring is NOT a suite file, so it cannot leak into an
      // export that is meant to stand alone.
      const { project, suite } = await seed(api, TARGET_FREE_SUITE_FILES);
      const key = await seedBundle(app, tmp, "checkout");
      await insertBaseline(app, { project, suite, storyId: "checkout", trajectoryKey: key });

      const res = await api.get(`/suites/${suite.id}/playwright-export?story=checkout`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const code = res.body.toString("utf8");
      // No invented default, and specifically not the ring's URL.
      assert.doesNotMatch(code, /http:\/\/127\.0\.0\.1:4173/);
      assert.doesNotMatch(code, /\?\? "/);
      // The environment variable is the only source, and the spec fails fast and
      // actionably rather than navigating to the empty string.
      assert.match(code, /const BASE_URL = requireBaseUrl\(\);/);
      assert.match(code, /PLAYTEST_BASE_URL is not set\./);

      const notes = JSON.parse(Buffer.from(res.headers.get("x-playtest-export-notes"), "base64").toString("utf8"));
      assert.ok(
        notes.some((n: HostedDynamic) => /no default target — set PLAYTEST_BASE_URL/.test(n)),
        JSON.stringify(notes),
      );
    });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("playwright export follows the live baseline, not a superseded one", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-pwx-v-"));
  try {
    await withApp(async ({ api, app }: HostedDynamic) => {
      const { project, suite } = await seed(api);
      const key = await seedBundle(app, tmp, "checkout");
      const v2 = ulid();
      await insertBaseline(app, { project, suite, storyId: "checkout", trajectoryKey: key, version: 1, supersededBy: v2 });
      await insertBaseline(app, { project, suite, storyId: "checkout", trajectoryKey: key, version: 2 });

      const res = await api.get(`/suites/${suite.id}/playwright-export?story=checkout`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      // v2's meta carries its own run id — proof the superseded v1 was skipped.
      assert.match(res.body.toString("utf8"), /Baseline run: 2026-06-10T0302-ab12/);
    });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("playwright export refuses missing, non-web and never-run stories with friendly messages", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-pwx-refuse-"));
  try {
    await withApp(async ({ api }: HostedDynamic) => {
      const { suite } = await seed(api);

      const noStory = await api.get(`/suites/${suite.id}/playwright-export`);
      assert.equal(noStory.status, 400);
      assert.match(noStory.body.error.message, /needs \?story=/);

      const unknown = await api.get(`/suites/${suite.id}/playwright-export?story=nope`);
      assert.equal(unknown.status, 404);
      assert.match(unknown.body.error.message, /no story "nope" in this suite/);

      // Resolves as a case, but the wrong transport — named, not a 500.
      const wrongDriver = await api.get(`/suites/${suite.id}/playwright-export?story=over-http`);
      assert.equal(wrongDriver.status, 400);
      assert.match(wrongDriver.body.error.message, /export supports web stories; this one uses driver "api"/);

      // A web story that has never produced an accepted baseline.
      const neverRun = await api.get(`/suites/${suite.id}/playwright-export?story=checkout`);
      assert.equal(neverRun.status, 404);
      assert.match(neverRun.body.error.message, /no accepted saved path for story "checkout" — run it first/);
    });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});
