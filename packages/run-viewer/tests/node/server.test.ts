// Offline contract test for the view-server's JSON routes and file serving
// (contract half; the browser tier is the UI half). Uses deterministic run
// artifacts, then freezes the shapes of
// /runs.json, /changed.json, /history.json?case= and /run/<path> — presence
// and types of the load-bearing fields, the same discipline the harness
// self-test applies to --json. This is the contract a standalone viewer or a
// future backend data source must keep
// (docs/contracts/interfaces.md#viewer-server).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { serveRun } from "../../src/node/index.ts";
import { writeBundle } from "@playtest/core/artifacts";
import { makeRunsFixture } from "../../../../tests/support/run-fixtures.ts";

let tmpRoot: LegacyTestValue;
let runsRoot: LegacyTestValue;
let healRunDir: LegacyTestValue;
let server: LegacyTestValue; // runs-root server, lives for the whole file
let base: LegacyTestValue; // http://127.0.0.1:<port>

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-viewsrv-"));
  const fixture = makeRunsFixture(tmpRoot);
  runsRoot = fixture.runsRoot;
  healRunDir = path.relative(runsRoot, fixture.healDir).split(path.sep).join("/");

  server = await serveRun(runsRoot, { port: 0, open: false });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const isNumberOrNull = (v: LegacyTestValue) => v === null || typeof v === "number";

async function getJson(url: LegacyTestValue) {
  const r = await fetch(url);
  assert.equal(r.status, 200, `${url} should be 200`);
  assert.match(r.headers.get("content-type") ?? "", /application\/json/);
  return r.json();
}

async function assertSameResponse(localBase: LegacyTestValue, bundleBase: LegacyTestValue, route: LegacyTestValue, opts = {}) {
  const [local, bundled] = await Promise.all([fetch(`${localBase}${route}`, opts), fetch(`${bundleBase}${route}`, opts)]);
  assert.equal(bundled.status, local.status, `${route} status`);
  for (const h of ["content-type", "content-range", "content-length", "accept-ranges"]) {
    assert.equal(bundled.headers.get(h), local.headers.get(h), `${route} ${h}`);
  }
  assert.deepEqual(
    Buffer.from(await bundled.arrayBuffer()),
    Buffer.from(await local.arrayBuffer()),
    `${route} body`,
  );
}

// ---------- /runs.json ----------

test("/runs.json: entry shape, all three run kinds, newest first", async () => {
  const runs = await getJson(`${base}/runs.json`);
  assert.ok(Array.isArray(runs) && runs.length === 3, `expected 3 runs, got ${runs.length}`);
  for (const r of runs) {
    assert.equal(typeof r.run_id, "string", "run_id");
    assert.equal(typeof r.case_id, "string", "case_id");
    assert.equal(typeof r.path, "string", "path");
    assert.ok(["pass", "fail", "infra", "explored"].includes(r.status), `status: ${r.status}`);
    assert.ok(["record", "act", "heal", "explore"].includes(r.mode), `mode: ${r.mode}`);
    assert.equal(typeof r.healed, "boolean", "healed");
    assert.equal(typeof r.started_at, "string", "started_at");
    assert.ok(isNumberOrNull(r.duration_ms), "duration_ms");
    // picker context: the case's story prose (null for pre-story manifests),
    // optional one-line description, and tags
    assert.match(r.story, /buy milk/, "story carries the case prose");
    assert.ok(r.description === null || typeof r.description === "string", "description");
    assert.ok(Array.isArray(r.tags), "tags is an array");
  }
  const byMode = Object.fromEntries(runs.map((r) => [r.mode, r]));
  assert.equal(byMode.record.description, "Buy-milk smoke journey.", "description round-trips");
  assert.equal(byMode.explore.description, null, "study case has no description");
  assert.deepEqual(runs.map((r) => r.mode).sort(), ["explore", "heal", "record"]);
  const starts = runs.map((r) => r.started_at);
  assert.deepEqual(starts, [...starts].sort().reverse(), "newest first by started_at");
  // every advertised path must serve its manifest
  for (const r of runs) {
    const m = await getJson(`${base}/run/${r.path}/manifest.json`);
    assert.equal(m.run_id, r.run_id, `path ${r.path} serves its own manifest`);
  }
});

// A runs root that doesn't exist must serve an empty picker, not crash: a fresh
// project with no runs yet, or a read-only mount whose runs dir is unpopulated
// (the compose self-test), still gets a working viewer. /runs.json -> [].
test("/runs.json: missing runs root serves an empty picker (no crash)", async () => {
  const missing = path.join(tmpRoot, "does-not-exist", "runs");
  assert.ok(!fs.existsSync(missing), "precondition: the runs root is absent");
  const srv = await serveRun(missing, { port: 0, open: false });
  try {
    const b = `http://127.0.0.1:${srv.address().port}`;
    assert.deepEqual(await getJson(`${b}/runs.json`), [], "empty runs list");
    const index = await fetch(`${b}/`);
    assert.equal(index.status, 200, "viewer index still served");
    assert.ok(!fs.existsSync(missing), "read-only: the viewer never created the dir");
  } finally {
    srv.close();
  }
});

// ---------- /changed.json ----------

test("/changed.json: the healed pass is listed as a pending changed journey", async () => {
  const entries = await getJson(`${base}/changed.json`);
  assert.ok(Array.isArray(entries) && entries.length === 1, `expected 1 changed entry, got ${entries.length}`);
  const e = entries[0];
  assert.equal(typeof e.case_id, "string", "case_id");
  assert.equal(typeof e.run_id, "string", "run_id");
  assert.equal(typeof e.started_at, "string", "started_at");
  assert.ok(isNumberOrNull(e.score), "score");
  assert.equal(e.path, healRunDir, "path is the healed run, root-relative");
  assert.equal(typeof e.run_dir_rel, "string", "run_dir_rel");
  assert.equal(e.pending, true, "un-accepted heal candidate is pending");
});

// ---------- /history.json ----------

test("/history.json?case=: per-case history shape, oldest first; [] without a case", async () => {
  const caseId = (await getJson(`${base}/changed.json`))[0].case_id;
  const hist = await getJson(`${base}/history.json?case=${encodeURIComponent(caseId)}`);
  assert.ok(Array.isArray(hist) && hist.length === 2, `record + heal for ${caseId}, got ${hist.length}`);
  for (const h of hist) {
    assert.equal(typeof h.run_id, "string", "run_id");
    assert.equal(typeof h.started_at, "string", "started_at");
    assert.ok(["pass", "fail", "infra", "explored"].includes(h.status), `status: ${h.status}`);
    assert.ok(["record", "act", "heal", "explore"].includes(h.mode), `mode: ${h.mode}`);
    assert.equal(typeof h.healed, "boolean", "healed");
    for (const k of ["duration_ms", "steps", "score", "lcp_ms", "cost_usd"]) {
      assert.ok(isNumberOrNull(h[k]), `${k} must be number|null, got ${JSON.stringify(h[k])}`);
    }
    assert.ok(h.pins === null || typeof h.pins === "object", "pins (the comparability key)");
    assert.equal(typeof h.path, "string", "path");
  }
  const starts = hist.map((h) => h.started_at);
  assert.deepEqual(starts, [...starts].sort(), "oldest first by started_at");

  assert.deepEqual(await getJson(`${base}/history.json`), [], "no case param -> []");
});

// ---------- /run/<path> file serving ----------

test("/run/<path>: MIME types, missing files, traversal, method guard", async () => {
  const png = await fetch(`${base}/run/${healRunDir}/steps/001.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");

  const traj = await fetch(`${base}/run/${healRunDir}/trajectory.jsonl`);
  assert.equal(traj.status, 200);

  assert.equal((await fetch(`${base}/run/${healRunDir}/nope.json`)).status, 404, "missing file");
  assert.equal((await fetch(`${base}/run/${encodeURIComponent("../")}suite/add-todo.yaml`)).status, 404, "traversal stays inside the root");
  assert.equal((await fetch(`${base}/runs.json`, { method: "POST" })).status, 405, "GET/HEAD only");
});

test("BundleProvider conformance: single-run routes byte-match filesystem provider", async () => {
  const runDir = path.join(runsRoot, healRunDir);
  const video = Buffer.from("bundle-video-0123456789");
  fs.writeFileSync(path.join(runDir, "video.webm"), video);
  const bundlePath = path.join(runsRoot, `${healRunDir}.ptrun`);
  writeBundle(runDir, bundlePath);

  const local = await serveRun(runDir, { port: 0, open: false });
  const bundled = await serveRun(bundlePath, { port: 0, open: false });
  try {
    const lbase = `http://127.0.0.1:${local.address().port}`;
    const bbase = `http://127.0.0.1:${bundled.address().port}`;
    await assertSameResponse(lbase, bbase, "/run/manifest.json");
    await assertSameResponse(lbase, bbase, "/run/trajectory.jsonl");
    await assertSameResponse(lbase, bbase, "/run/steps/001.png");
    await assertSameResponse(lbase, bbase, "/changed.json");
    const manifest = await (await fetch(`${lbase}/run/manifest.json`)).json();
    await assertSameResponse(lbase, bbase, `/history.json?case=${encodeURIComponent(manifest.case.id)}`);
    await assertSameResponse(lbase, bbase, "/run/video.webm", { headers: { range: "bytes=3-11" } });
  } finally {
    local.close();
    bundled.close();
  }
});

// ---------- core-profile runs ----------

// A run recorded under `artifacts: core`
// (docs/contracts/artifacts.md#artifact-profiles) has no trace.zip, no MHTML,
// and no native a11y tree. The viewer has always had to tolerate absent optional
// artifacts — it hides the Custom|Playwright toggle when an envelope carries no
// pw_a11y, and it never references trace.zip at all — so this pins the contract
// that makes that safe: a core run serves every route the viewer actually reads,
// its envelopes name only files that exist, and probing for the absent ones is a
// clean 404 rather than an error page.
test("a core-profile run directory serves everything the viewer reads", async () => {
  const runDir = path.join(tmpRoot, "core-profile-run");
  fs.mkdirSync(path.join(runDir, "steps"), { recursive: true });
  const source = path.join(runsRoot, healRunDir);
  for (const name of ["manifest.json", "trajectory.jsonl", "har.json", "grade.json"]) {
    fs.copyFileSync(path.join(source, name), path.join(runDir, name));
  }
  for (const n of ["001", "002", "003"]) {
    for (const ext of ["png", "a11y.txt"]) {
      fs.copyFileSync(path.join(source, "steps", `${n}.${ext}`), path.join(runDir, "steps", `${n}.${ext}`));
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  manifest.case.artifacts = "core";
  manifest.artifacts.trace = null;
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const server = await serveRun(runDir, { port: 0, open: false });
  try {
    const b = `http://127.0.0.1:${server.address().port}`;
    const m = await getJson(`${b}/run/manifest.json`);
    assert.equal(m.case.artifacts, "core", "the profile is readable provenance");
    assert.equal(m.artifacts.trace, null, "a core manifest names no trace");

    // Every envelope artifact path resolves: the rule the profile has to keep is
    // that nothing is advertised which is not on disk.
    const traj = await fetch(`${b}/run/trajectory.jsonl`);
    assert.equal(traj.status, 200);
    const envelopes = (await traj.text()).trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(envelopes.length > 0);
    for (const env of envelopes) {
      assert.equal(env.artifacts?.pw_a11y, undefined, "no native-tree path, so the viewer's toggle stays hidden");
      assert.equal(env.artifacts?.mhtml, undefined, "no MHTML path is advertised");
      for (const rel of [env.artifacts?.screenshot, env.artifacts?.a11y].filter(Boolean)) {
        assert.equal((await fetch(`${b}/run/${rel}`)).status, 200, `${rel} must be served`);
      }
    }

    // The debug-only artifacts are simply absent, not broken.
    for (const rel of ["trace.zip", "final.mhtml", "steps/001.pw-a11y.txt", "steps/001.mhtml"]) {
      assert.equal((await fetch(`${b}/run/${rel}`)).status, 404, `${rel} is absent, not an error`);
    }
  } finally {
    server.close();
  }
});

// ---------- single-run mode ----------

test("single-run mode: /runs.json 404s, /changed.json still resolves the run", async () => {
  const single = await serveRun(path.join(runsRoot, healRunDir), { port: 0, open: false });
  try {
    const sbase = `http://127.0.0.1:${single.address().port}`;
    assert.equal((await fetch(`${sbase}/runs.json`)).status, 404, "no picker data in single-run mode");
    const entries = await getJson(`${sbase}/changed.json`);
    assert.ok(Array.isArray(entries) && entries.length === 1, "the healed run's changed entry");
    assert.equal(entries[0].pending, true);
    const m = await getJson(`${sbase}/run/manifest.json`);
    assert.equal(typeof m.run_id, "string", "single-run /run/ serves the run dir itself");
  } finally {
    single.close();
  }
});
