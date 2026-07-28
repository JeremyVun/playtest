// Environment app artifacts (BUILD_PLAN R3): the app binary as a property of
// the ENVIRONMENT rather than of the suite tree, pinned by a launch, fetched by
// the runner over the ordinary scoped-bearer protocol, and reclaimed by the
// blob GC when nothing names it any more.
//
// What the runner then DOES with the bytes — unpack a zipped `.app`, refuse a
// hash that does not match, write the absolute path into the overlay's `app:` —
// lives with the runner: packages/platform/runner-agent/tests/unit/app-artifact.test.ts.
// The split follows the workspace boundary, not convenience.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { withApp } from "./helpers.ts";
import { runRetentionCycle } from "../../src/retention/worker.ts";

const GITHUB_STUB = { enabled: true, dispatchWorkflow: async () => ({}), cancelRun: async () => {} };

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const build = (marker: string, size = 64) => Buffer.concat([Buffer.from(marker), Buffer.alloc(size)]);

const STORY = [
  "description: Open the app.",
  "story: |",
  "  Look at the launch screen and finish.",
  "success:",
  "  - assert: ok",
  "",
].join("\n");

/**
 * A mobile suite. Its top-level `app:` is the placeholder every hosted mobile
 * suite needs — the control plane resolves cases with NO environment selected,
 * and core requires `app.app` for the mobile driver at that stage — so these
 * tests exercise precedence against a suite that really does declare one.
 */
async function seedMobileSuite(
  api: HostedDynamic,
  project: string,
  { slug = "todos", appLine = "  app: ./placeholder.app", extra = "", files = {} }: HostedDynamic = {},
) {
  const suite = (await api.post(`/projects/${project}/suites`, { slug, name: slug })).body;
  const commit = await api.post(`/suites/${suite.id}/commit`, {
    changes: [
      {
        path: "playtest.yaml",
        content: ["app:", "  driver: mobile", "  platform: ios", appLine, extra].filter(Boolean).join("\n") + "\n",
      },
      { path: "stories/open-app.yaml", content: STORY },
      ...Object.entries(files).map(([p, content]) => ({ path: p, content })),
    ],
    note: "seed",
  });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  return suite;
}

/** A runner bearer scoped to one group, through the ordinary exchange. */
async function runnerToken(api: HostedDynamic, groupId: string) {
  const res = await api.post("/runner/exchange", { run_group_id: groupId, isolation: "process" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return api.withToken(res.body.token);
}

test("app artifact: upload is content-addressed, replace supersedes, delete clears, and re-uploading the same bytes is a no-op", async () => {
  await withApp(async ({ api, storeRoot }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const env = (await api.post("/projects/p/environments", { name: "sim", driver: "mobile" })).body;
    assert.equal(env.app_artifact, null, "an environment ships no binary until someone uploads one");

    const v1 = build("BUILD-1");
    const put = await api.putRaw(`/environments/${env.id}/app-artifact?filename=todo-release.apk`, v1);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.app_artifact.sha256, sha(v1));
    assert.equal(put.body.app_artifact.size, v1.length);
    assert.equal(put.body.app_artifact.filename, "todo-release.apk");
    assert.ok(put.body.app_artifact.uploaded_at, "the reference says when");
    assert.ok(put.body.app_artifact.uploaded_by, "the reference says who");
    // The bytes live in the content-addressed blob store — the same namespace
    // suite files use, which is what makes dedupe and GC one mechanism.
    assert.equal(fs.readFileSync(path.join(storeRoot, "blobs", sha(v1))).equals(v1), true);

    // The same bytes again: same key, same reference, one object. Dedupe is a
    // property of the store, not a check anybody had to remember to write.
    const again = await api.putRaw(`/environments/${env.id}/app-artifact?filename=todo-release.apk`, v1);
    assert.equal(again.status, 200);
    assert.equal(again.body.app_artifact.sha256, sha(v1));
    assert.deepEqual(fs.readdirSync(path.join(storeRoot, "blobs")), [sha(v1)]);

    const v2 = build("BUILD-2");
    const replaced = await api.putRaw(`/environments/${env.id}/app-artifact?filename=todo-release.apk`, v2);
    assert.equal(replaced.body.app_artifact.sha256, sha(v2));
    assert.equal((await api.get("/projects/p/environments")).body.items.find((e: HostedDynamic) => e.name === "sim").app_artifact.sha256, sha(v2));

    // An unrelated edit must not wipe the binary: the environment form PUTs the
    // whole row and says nothing about the artifact.
    const edited = await api.put(`/environments/${env.id}`, { discovery_allowed: true });
    assert.equal(edited.body.app_artifact.sha256, sha(v2));

    assert.equal((await api.del(`/environments/${env.id}/app-artifact`)).status, 204);
    assert.equal((await api.get("/projects/p/environments")).body.items.find((e: HostedDynamic) => e.name === "sim").app_artifact, null);
    // Idempotent: clearing what is already clear is not an error.
    assert.equal((await api.del(`/environments/${env.id}/app-artifact`)).status, 204);

    const actions = (await api.get("/projects/p/audit")).body.items.map((a: HostedDynamic) => a.action);
    assert.ok(actions.includes("environment.app_artifact_set"), JSON.stringify(actions));
    assert.ok(actions.includes("environment.app_artifact_cleared"), JSON.stringify(actions));
  });
});

test("app artifact: a build over the deployment cap is refused with the cap named, not truncated", async () => {
  await withApp(
    async ({ api, storeRoot }: HostedDynamic) => {
      await api.post("/projects", { key: "p", name: "P" });
      const env = (await api.post("/projects/p/environments", { name: "sim", driver: "mobile" })).body;

      const tooBig = Buffer.alloc(2 * 1024 * 1024, 7);
      const res = await api.putRaw(`/environments/${env.id}/app-artifact?filename=todo-release.apk`, tooBig);
      assert.equal(res.status, 413, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "payload_too_large");
      assert.match(res.body.error.message, /cap of 1 MiB/);
      assert.match(res.body.error.message, /PLAYTEST_APP_ARTIFACT_MAX_MB/);
      // …and it names the way out that does not need a bigger cap.
      assert.match(res.body.error.message, /absolute path/);
      assert.equal((await api.get("/projects/p/environments")).body.items[1].app_artifact, null);
      assert.equal(fs.existsSync(path.join(storeRoot, "blobs")), false, "nothing partial was stored");

      // The cap is the separate, much larger, binary cap — not the 4 MiB suite
      // file limit — so a small build under it still uploads here.
      const ok = await api.putRaw(`/environments/${env.id}/app-artifact?filename=todo-release.apk`, build("SMALL", 1024));
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
    },
    { PLAYTEST_APP_ARTIFACT_MAX_MB: "1" },
  );
});

test("app artifact: the upload names its file, and only kinds the runner can materialize", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const env = (await api.post("/projects/p/environments", { name: "sim", driver: "mobile" })).body;
    const bytes = build("BUILD");

    const unnamed = await api.putRaw(`/environments/${env.id}/app-artifact`, bytes);
    assert.equal(unnamed.status, 400);
    assert.match(unnamed.body.error.message, /"filename" is required/);

    const traversal = await api.putRaw(`/environments/${env.id}/app-artifact?filename=${encodeURIComponent("../../etc/passwd.apk")}`, bytes);
    assert.equal(traversal.status, 400);
    assert.match(traversal.body.error.message, /plain file name/);

    const wrongKind = await api.putRaw(`/environments/${env.id}/app-artifact?filename=notes.txt`, bytes);
    assert.equal(wrongKind.status, 400);
    assert.match(wrongKind.body.error.message, /\.apk, \.aab, \.ipa, \.zip/);
    // The .app-is-a-directory fact belongs in the refusal, where someone hits it.
    assert.match(wrongKind.body.error.message, /upload it zipped/);

    const empty = await api.putRaw(`/environments/${env.id}/app-artifact?filename=todo.apk`, Buffer.alloc(0));
    assert.equal(empty.status, 400);
    assert.match(empty.body.error.message, /body was empty/);

    // A zipped iOS bundle is exactly what this route exists to accept.
    assert.equal((await api.putRaw(`/environments/${env.id}/app-artifact?filename=TodoFixture.app.zip`, bytes)).status, 200);
  });
});

test("app artifact: uploading takes the environment role, and a viewer token cannot", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const env = (await api.post("/projects/p/environments", { name: "sim", driver: "mobile" })).body;
    const viewer = (await api.post("/projects/p/tokens", { name: "read-only", role: "viewer" })).body;
    const asViewer = api.withToken(viewer.token);

    const refused = await asViewer.putRaw(`/environments/${env.id}/app-artifact?filename=todo.apk`, build("X"));
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal((await asViewer.del(`/environments/${env.id}/app-artifact`)).status, 403);
  });
});

test("app artifact: a launch pins the hash, and a re-upload mid-flight never changes what the group runs", async () => {
  await withApp(
    async ({ api, app }: HostedDynamic) => {
      await api.post("/projects", { key: "p", name: "P" });
      const suite = await seedMobileSuite(api, "p");
      const env = (await api.post("/projects/p/environments", { name: "sim", driver: "mobile" })).body;
      const v1 = build("BUILD-1");
      await api.putRaw(`/environments/${env.id}/app-artifact?filename=todo-release.apk`, v1);

      const launch = await api.post("/projects/p/run-groups", { suite_id: suite.id, environment_id: env.id, selection: {} });
      assert.equal(launch.status, 200, JSON.stringify(launch.body));
      const groupId = launch.body.run_group.id;

      // The build changes underneath the running group — the CI case exactly.
      const v2 = build("BUILD-2");
      await api.putRaw(`/environments/${env.id}/app-artifact?filename=todo-release.apk`, v2);

      const runner = await runnerToken(api, groupId);
      const spec = await runner.get(`/runner/groups/${groupId}`);
      assert.equal(spec.status, 200, JSON.stringify(spec.body));
      assert.equal(
        spec.body.environment.app_artifact.sha256,
        sha(v1),
        "the group spec serves the artifact this launch pinned, not the environment's current one",
      );
      const pinned = (await app.db.query(`SELECT app_artifact FROM run_groups WHERE id = $1`, [groupId])).rows[0].app_artifact;
      assert.equal(pinned.sha256, sha(v1));
      assert.equal(pinned.filename, "todo-release.apk");

      // The NEXT launch takes the new build — pinning freezes a group, not the ring.
      const later = await api.post("/projects/p/run-groups", { suite_id: suite.id, environment_id: env.id, selection: {} });
      const laterSpec = await (await runnerToken(api, later.body.run_group.id)).get(`/runner/groups/${later.body.run_group.id}`);
      assert.equal(laterSpec.body.environment.app_artifact.sha256, sha(v2));
    },
    {},
    { github: GITHUB_STUB },
  );
});

test("app artifact: the runner route serves this group's pinned bytes and nothing else", async () => {
  await withApp(
    async ({ api, storeRoot }: HostedDynamic) => {
      await api.post("/projects", { key: "p", name: "P" });
      const suite = await seedMobileSuite(api, "p");
      const env = (await api.post("/projects/p/environments", { name: "sim", driver: "mobile" })).body;
      const bytes = build("BUILD-1");
      await api.putRaw(`/environments/${env.id}/app-artifact?filename=TodoFixture.app.zip`, bytes);

      const launch = await api.post("/projects/p/run-groups", { suite_id: suite.id, environment_id: env.id, selection: {} });
      const groupId = launch.body.run_group.id;
      const runner = await runnerToken(api, groupId);

      const got = await runner.get(`/runner/artifacts/${sha(bytes)}`);
      assert.equal(got.status, 200);
      assert.equal(Buffer.from(got.body).equals(bytes), true, "byte-for-byte, so the runner's own hash check means something");

      // A scoped bearer reaches ONE artifact: its own group's. Guessing hashes
      // does not walk the object store.
      const other = build("SOMEONE-ELSES");
      await api.putRaw(`/environments/${env.id}/app-artifact?filename=other.apk`, other);
      const foreign = await runner.get(`/runner/artifacts/${sha(other)}`);
      assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
      assert.match(foreign.body.error.message, /pinned a different app artifact/);
      assert.equal((await runner.get(`/runner/artifacts/${"0".repeat(64)}`)).status, 403);
      assert.equal((await runner.get("/runner/artifacts/not-a-hash")).status, 400);
      assert.equal((await api.get(`/runner/artifacts/${sha(bytes)}`)).status, 401, "and it takes a runner token at all");

      // A tampered object comes back exactly as stored: the control plane is not
      // the integrity authority here — the runner is, and it compares against
      // the hash its group pinned (runner-agent app-artifact tests).
      fs.writeFileSync(path.join(storeRoot, "blobs", sha(bytes)), Buffer.from("TAMPERED"));
      const corrupt = await runner.get(`/runner/artifacts/${sha(bytes)}`);
      assert.equal(corrupt.status, 200);
      assert.notEqual(sha(Buffer.from(corrupt.body)), sha(bytes));

      // Gone entirely — the pruned-artifact case. It degrades like a pruned
      // bundle: an actionable 404, never a 500 and never a runner-side crash.
      fs.rmSync(path.join(storeRoot, "blobs", sha(bytes)));
      const pruned = await runner.get(`/runner/artifacts/${sha(bytes)}`);
      assert.equal(pruned.status, 404, JSON.stringify(pruned.body));
      assert.equal(pruned.body.error.code, "not_found");
      assert.match(pruned.body.error.message, /no longer in the object store/);
      assert.match(pruned.body.error.message, /Upload the build to the environment again/);
    },
    {},
    { github: GITHUB_STUB },
  );
});

test("app artifact: a group with no pinned artifact says so rather than serving one", async () => {
  await withApp(
    async ({ api }: HostedDynamic) => {
      await api.post("/projects", { key: "p", name: "P" });
      const suite = await seedMobileSuite(api, "p");
      const env = (
        await api.post("/projects/p/environments", { name: "sim", driver: "mobile", config: { app: { app: "/Users/dev/build/Todo.app" } } })
      ).body;
      const launch = await api.post("/projects/p/run-groups", { suite_id: suite.id, environment_id: env.id, selection: {} });
      const runner = await runnerToken(api, launch.body.run_group.id);

      const spec = await runner.get(`/runner/groups/${launch.body.run_group.id}`);
      assert.equal(spec.body.environment.app_artifact, null);
      const res = await runner.get(`/runner/artifacts/${"a".repeat(64)}`);
      assert.equal(res.status, 403);
      assert.match(res.body.error.message, /pinned no app artifact/);
    },
    {},
    { github: GITHUB_STUB },
  );
});

test("app artifact: the launch preview says which of the three sources supplies the binary", async () => {
  await withApp(
    async ({ api }: HostedDynamic) => {
      await api.post("/projects", { key: "p", name: "P" });
      const preview = async (suite: HostedDynamic, env: HostedDynamic) =>
        (await api.post("/projects/p/run-groups/preview", { suite_id: suite.id, environment_id: env.id, selection: {} })).body.target.app;

      // 3. The suite tree, bottom of the precedence: a committed file, which
      //    works for a fixture app and is what the caps make impractical for a
      //    real build.
      const committed = await seedMobileSuite(api, "p", {
        slug: "committed",
        appLine: "  app: builds/app.apk",
        files: { "builds/app.apk": "PRETEND-APK" },
      });
      const bare = (await api.post("/projects/p/environments", { name: "bare", driver: "mobile" })).body;
      const fromSuite = await preview(committed, bare);
      assert.equal(fromSuite.source, "suite");
      assert.equal(fromSuite.resolved, "builds/app.apk");
      assert.equal(fromSuite.artifact, null);

      // 2. The environment — a path on the runner's own disk beats the suite's.
      const local = (
        await api.post("/projects/p/environments", { name: "laptop", driver: "mobile", config: { app: { app: "/Users/dev/build/Todo.app" } } })
      ).body;
      const fromEnv = await preview(committed, local);
      assert.equal(fromEnv.source, "environment");
      assert.equal(fromEnv.resolved, "/Users/dev/build/Todo.app");
      assert.equal(fromEnv.suite_app, "builds/app.apk", "the losing values stay visible, the way base_url's do");

      // 2. …and an uploaded artifact is the environment's other form.
      const shipped = (await api.post("/projects/p/environments", { name: "shipped", driver: "mobile" })).body;
      const bytes = build("BUILD-1");
      await api.putRaw(`/environments/${shipped.id}/app-artifact?filename=TodoFixture.app.zip`, bytes);
      const fromArtifact = await preview(committed, shipped);
      assert.equal(fromArtifact.source, "environment-artifact");
      assert.equal(fromArtifact.resolved, "TodoFixture.app.zip", "an artifact's value is its name: the path only exists once a runner materializes it");
      assert.equal(fromArtifact.artifact.sha256, sha(bytes));
      assert.equal(fromArtifact.artifact.size, bytes.length);

      // 1. The suite's own app.envs.<name>.app is the most specific thing
      //    anybody said, so it beats the environment in both its forms.
      const opinionated = await seedMobileSuite(api, "p", {
        slug: "opinionated",
        appLine: "  app: builds/app.apk",
        extra: ["  envs:", "    shipped:", "      app: builds/env-specific.apk"].join("\n"),
        files: { "builds/app.apk": "PRETEND-APK", "builds/env-specific.apk": "PRETEND-APK-2" },
      });
      const fromSuiteEnv = await preview(opinionated, shipped);
      assert.equal(fromSuiteEnv.source, "suite-env");
      assert.equal(fromSuiteEnv.resolved, "builds/env-specific.apk");
      assert.equal(fromSuiteEnv.artifact, null, "nothing is pinned when the artifact does not win");

      // A web target still reports the URL resolution beside it, unchanged.
      const web = (await api.post("/projects/p/environments", { name: "staging", config: { app: { base_url: "https://staging.test" } } })).body;
      const mismatch = await api.post("/projects/p/run-groups/preview", {
        suite_id: committed.id,
        environment_id: web.id,
        selection: {},
      });
      assert.equal(mismatch.status, 400, JSON.stringify(mismatch.body));
      assert.match(mismatch.body.error.message, /environment "staging" is for "web" suites/);
    },
    {},
    { github: GITHUB_STUB },
  );
});

test("app artifact: a launch whose binary is a suite path the snapshot does not hold is refused, naming all three sources", async () => {
  await withApp(
    async ({ api }: HostedDynamic) => {
      await api.post("/projects", { key: "p", name: "P" });
      // The placeholder every hosted mobile suite carries so it can be listed at
      // all: harmless until someone launches against a ring that supplies nothing.
      const suite = await seedMobileSuite(api, "p", { appLine: "  app: ./placeholder.app" });
      const bare = (await api.post("/projects/p/environments", { name: "bare", driver: "mobile" })).body;

      const refused = await api.post("/projects/p/run-groups", { suite_id: suite.id, environment_id: bare.id, selection: {} });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.match(refused.body.error.message, /placeholder\.app/);
      assert.match(refused.body.error.message, /pinned snapshot does not contain it/);
      assert.match(refused.body.error.message, /commit the file into the suite tree/);
      assert.match(refused.body.error.message, /app-artifact/);
      assert.match(refused.body.error.message, /ABSOLUTE path on the runner's own disk/);
      assert.equal((await api.get("/projects/p/run-groups")).body.items.length, 0, "nothing was created");

      // Each of the three answers unblocks it.
      await api.putRaw(`/environments/${bare.id}/app-artifact?filename=TodoFixture.app.zip`, build("BUILD"));
      assert.equal((await api.post("/projects/p/run-groups", { suite_id: suite.id, environment_id: bare.id, selection: {} })).status, 200);

      const laptop = (
        await api.post("/projects/p/environments", { name: "laptop", driver: "mobile", config: { app: { app: "/Users/dev/build/Todo.app" } } })
      ).body;
      assert.equal((await api.post("/projects/p/run-groups", { suite_id: suite.id, environment_id: laptop.id, selection: {} })).status, 200);

      const committed = await seedMobileSuite(api, "p", {
        slug: "committed",
        appLine: "  app: builds/app.apk",
        files: { "builds/app.apk": "PRETEND-APK" },
      });
      const bare2 = (await api.post("/projects/p/environments", { name: "bare2", driver: "mobile" })).body;
      assert.equal((await api.post("/projects/p/run-groups", { suite_id: committed.id, environment_id: bare2.id, selection: {} })).status, 200);
    },
    {},
    { github: GITHUB_STUB },
  );
});

test("app artifact: retention reclaims a blob nothing names, and keeps one a run group pinned", async () => {
  await withApp(
    async ({ api, app, storeRoot }: HostedDynamic) => {
      await api.post("/projects", { key: "p", name: "P" });
      const suite = await seedMobileSuite(api, "p");
      const env = (await api.post("/projects/p/environments", { name: "sim", driver: "mobile" })).body;
      const blobPath = (b: Buffer) => path.join(storeRoot, "blobs", sha(b));

      // An upload nobody launched against and then cleared: unreferenced.
      const orphan = build("NEVER-LAUNCHED");
      await api.putRaw(`/environments/${env.id}/app-artifact?filename=orphan.apk`, orphan);
      assert.equal(fs.existsSync(blobPath(orphan)), true);

      // A build a run group ran with, cleared from the environment afterwards.
      const pinnedBuild = build("RAN-WITH-THIS");
      await api.putRaw(`/environments/${env.id}/app-artifact?filename=todo-release.apk`, pinnedBuild);
      const launch = await api.post("/projects/p/run-groups", { suite_id: suite.id, environment_id: env.id, selection: {} });
      assert.equal(launch.status, 200, JSON.stringify(launch.body));

      // …and the one the environment still ships.
      const current = build("CURRENT");
      await api.putRaw(`/environments/${env.id}/app-artifact?filename=todo-release.apk`, current);

      const summary: HostedDynamic = await runRetentionCycle(app.ctx, { integritySample: 0 });
      assert.equal(summary.skipped, false);

      assert.equal(fs.existsSync(blobPath(orphan)), false, "an upload nothing references is reclaimed");
      assert.equal(fs.existsSync(blobPath(pinnedBuild)), true, "a run group's pin keeps its build alive after the environment moved on");
      assert.equal(fs.existsSync(blobPath(current)), true, "the environment's current build stays");
      assert.ok(summary.blob_objects_deleted >= 1);

      // The suite snapshot's own file blobs are untouched by all of this.
      const tree = (await app.db.query(`SELECT tree FROM suite_snapshots WHERE suite_id = $1`, [suite.id])).rows[0].tree;
      for (const shaHex of Object.values(tree)) {
        assert.equal(fs.existsSync(path.join(storeRoot, "blobs", String(shaHex))), true);
      }
    },
    {},
    { github: GITHUB_STUB },
  );
});
