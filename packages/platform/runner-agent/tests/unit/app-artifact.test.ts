// The runner half of environment app artifacts: download, prove, unpack, and
// hand core an absolute local path (docs/contracts/hosted.md, "Environments,
// secrets, and target authentication"; docs/contracts/engine.md, app paths).
//
// The control-plane half — who may fetch which artifact, and what a pruned one
// says — is covered over real HTTP in
// packages/platform/control-plane/tests/integration/app-artifacts.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { materializeWorkspace } from "../../src/workspace.ts";
import { materializeAppArtifact } from "../../src/app-artifact.ts";
import { writeZip } from "../../../../../tests/support/zip.ts";

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

/** A zipped iOS-style `.app` bundle: an executable, a plist, and a symlink. */
function appZip(): Buffer {
  return writeZip([
    { name: "TodoFixture.app/", dir: true },
    { name: "TodoFixture.app/TodoFixture", content: "MACH-O", mode: 0o755 },
    { name: "TodoFixture.app/Info.plist", content: "<plist/>", mode: 0o644, deflate: true },
    { name: "TodoFixture.app/Current", symlink: "Info.plist" },
    // macOS `ditto` sequesters resource forks here; they are not part of the bundle.
    { name: "__MACOSX/._TodoFixture.app", content: "resource fork" },
  ]);
}

/** A fake runner API serving one snapshot tree and one artifact. */
function fakeApi(files: Record<string, string>, artifact: { sha256: string; bytes: Buffer } | null = null) {
  const blobs = new Map(Object.entries(files).map(([p, c]) => [sha(c), c]));
  let artifactFetches = 0;
  return {
    artifactFetches: () => artifactFetches,
    json: async () => ({ tree: Object.fromEntries(Object.entries(files).map(([p, c]) => [p, sha(c)])) }),
    bytes: async (url: string) => {
      if (url.startsWith("/runner/artifacts/")) {
        artifactFetches += 1;
        assert.equal(url, `/runner/artifacts/${artifact!.sha256}`, "the runner asks for the hash its group pinned");
        return artifact!.bytes;
      }
      return Buffer.from(blobs.get(url.split("/").pop()!)!);
    },
  };
}

async function withWorkDir(fn: (dir: string) => Promise<void>) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-artifact-"));
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test("a zipped .app materializes unpacked, with its executable bit and symlinks intact", async () => {
  await withWorkDir(async (workDir) => {
    const bytes = appZip();
    const root = path.join(workDir, "grp");
    const app = await materializeAppArtifact({
      api: fakeApi({}, { sha256: sha(bytes), bytes }),
      artifact: { sha256: sha(bytes), size: bytes.length, filename: "TodoFixture.app.zip" },
      root,
    });

    assert.equal(path.isAbsolute(app), true, "core is handed an absolute path");
    assert.equal(path.basename(app), "TodoFixture.app", "the bundle directory itself, not the archive around it");
    assert.equal(fs.statSync(app).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(app, "TodoFixture"), "utf8"), "MACH-O");
    assert.equal(fs.readFileSync(path.join(app, "Info.plist"), "utf8"), "<plist/>", "a deflated entry inflates");
    assert.equal(
      fs.statSync(path.join(app, "TodoFixture")).mode & 0o111,
      0o111,
      "the executable bit survives — without it simctl installs a bundle with no runnable binary",
    );
    assert.equal(fs.readlinkSync(path.join(app, "Current")), "Info.plist", "symlinks are recreated, not flattened");
    assert.equal(fs.existsSync(path.join(path.dirname(app), "__MACOSX")), false, "resource-fork noise is dropped");
  });
});

test("a plain .apk materializes as a file under its own name", async () => {
  await withWorkDir(async (workDir) => {
    const bytes = Buffer.from("APK-BYTES");
    const root = path.join(workDir, "grp");
    const app = await materializeAppArtifact({
      api: fakeApi({}, { sha256: sha(bytes), bytes }),
      artifact: { sha256: sha(bytes), size: bytes.length, filename: "todo-release.apk" },
      root,
    });
    assert.equal(path.basename(app), "todo-release.apk");
    assert.equal(fs.readFileSync(app, "utf8"), "APK-BYTES");
  });
});

test("bytes that do not match the pinned hash are refused, with the remedy", async () => {
  await withWorkDir(async (workDir) => {
    const pinned = sha(Buffer.from("the build this run chose"));
    await assert.rejects(
      () =>
        materializeAppArtifact({
          api: fakeApi({}, { sha256: pinned, bytes: Buffer.from("something else entirely") }),
          artifact: { sha256: pinned, size: 24, filename: "todo-release.apk" },
          root: path.join(workDir, "grp"),
        }),
      (e: Error) => {
        assert.match(e.message, /does not match the hash this run pinned/);
        assert.match(e.message, /upload the build to the environment again/);
        return true;
      },
    );
  });
});

test("an archive that would unpack past the runner's limit is refused before anything is written", async () => {
  await withWorkDir(async (workDir) => {
    // The zip-bomb shape: two megabytes of nothing, deflated to almost nothing.
    // Only a project developer can upload one, so this is a reliability guard —
    // a runner that OOMs takes every other group on that machine with it.
    const bytes = writeZip([
      { name: "Big.app/", dir: true },
      { name: "Big.app/blob.bin", content: Buffer.alloc(2 * 1024 * 1024), deflate: true },
    ]);
    const root = path.join(workDir, "grp");
    const previous = process.env.PLAYTEST_RUNNER_MAX_UNPACKED_MB;
    process.env.PLAYTEST_RUNNER_MAX_UNPACKED_MB = "1";
    try {
      await assert.rejects(
        () =>
          materializeAppArtifact({
            api: fakeApi({}, { sha256: sha(bytes), bytes }),
            artifact: { sha256: sha(bytes), size: bytes.length, filename: "Big.app.zip" },
            root,
          }),
        (e: Error) => {
          assert.match(e.message, /unpacks to 2 MB, over this runner's 1 MB limit/);
          // A runner-facing failure carries its remedy.
          assert.match(e.message, /PLAYTEST_RUNNER_MAX_UNPACKED_MB/);
          return true;
        },
      );
      assert.equal(fs.existsSync(path.join(root, "app", "unpacked")), false, "nothing was written");
      // A nonsense cap is a configuration error with the default named, not a
      // silent fallback to something nobody chose.
      process.env.PLAYTEST_RUNNER_MAX_UNPACKED_MB = "lots";
      await assert.rejects(
        () =>
          materializeAppArtifact({
            api: fakeApi({}, { sha256: sha(bytes), bytes }),
            artifact: { sha256: sha(bytes), size: bytes.length, filename: "Big.app.zip" },
            root,
          }),
        /must be a positive number of megabytes/,
      );
    } finally {
      if (previous === undefined) delete process.env.PLAYTEST_RUNNER_MAX_UNPACKED_MB;
      else process.env.PLAYTEST_RUNNER_MAX_UNPACKED_MB = previous;
    }
  });
});

test("an archive entry that escapes its own directory is refused", async () => {
  await withWorkDir(async (workDir) => {
    const bytes = writeZip([{ name: "../escaped.txt", content: "nope" }]);
    await assert.rejects(
      () =>
        materializeAppArtifact({
          api: fakeApi({}, { sha256: sha(bytes), bytes }),
          artifact: { sha256: sha(bytes), size: bytes.length, filename: "evil.zip" },
          root: path.join(workDir, "grp"),
        }),
      /escapes its own directory/,
    );
    assert.equal(fs.existsSync(path.join(workDir, "escaped.txt")), false);
  });
});

test("the materialized path lands in the environment overlay's app: key", async () => {
  await withWorkDir(async (workDir) => {
    const bytes = appZip();
    const files = { "playtest.yaml": "app:\n  driver: mobile\n  platform: ios\n  app: ./placeholder.app\n" };
    const api = fakeApi(files, { sha256: sha(bytes), bytes });
    const ws = await materializeWorkspace({
      api,
      spec: {
        run_group_id: "grp_app",
        snapshot_id: "snap_app",
        environment: {
          name: "sim",
          resolved_secrets: {},
          config: { app: { platform: "ios", device: "iPhone 16", appium_url: "http://127.0.0.1:4923" } },
          app_artifact: { sha256: sha(bytes), size: bytes.length, filename: "TodoFixture.app.zip" },
        },
      },
      sessions: {},
      workDir,
    });
    const doc = YAML.parse(await fsp.readFile(path.join(ws.suiteDir, "playtest.yaml"), "utf8"));
    const app = doc.app.envs.sim.app;
    assert.equal(path.isAbsolute(app), true, "engine-visible value stays an absolute local path");
    assert.equal(path.basename(app), "TodoFixture.app");
    assert.equal(fs.existsSync(path.join(app, "TodoFixture")), true);
    assert.equal(doc.app.app, "./placeholder.app", "the suite's top-level app is untouched — the overlay beats it in core");
    assert.equal(api.artifactFetches(), 1);
    await ws.cleanup();
  });
});

test("a suite that declares its own app.envs.<name>.app wins, and no build is downloaded", async () => {
  await withWorkDir(async (workDir) => {
    const bytes = appZip();
    const files = {
      "playtest.yaml": [
        "app:",
        "  driver: mobile",
        "  platform: ios",
        "  app: ./placeholder.app",
        "  envs:",
        "    sim:",
        "      app: ./builds/committed.app",
        "",
      ].join("\n"),
    };
    const api = fakeApi(files, { sha256: sha(bytes), bytes });
    const ws = await materializeWorkspace({
      api,
      spec: {
        run_group_id: "grp_suite_wins",
        snapshot_id: "snap_suite_wins",
        environment: {
          name: "sim",
          resolved_secrets: {},
          config: {},
          app_artifact: { sha256: sha(bytes), size: bytes.length, filename: "TodoFixture.app.zip" },
        },
      },
      sessions: {},
      workDir,
    });
    const doc = YAML.parse(await fsp.readFile(path.join(ws.suiteDir, "playtest.yaml"), "utf8"));
    assert.equal(doc.app.envs.sim.app, "./builds/committed.app", "the suite said something more specific and keeps it");
    assert.equal(api.artifactFetches(), 0, "a build the merge would discard is never downloaded");
    await ws.cleanup();
  });
});
