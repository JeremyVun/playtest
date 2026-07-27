// The Phase 1 exit gate, as a test: import the test-owned todo suite via the API, edit a case
// (validation errors render the core messages), commit, export the snapshot, and run
// the exported tree with the local CLI — identical resolved cases (`playtest list
// --json`) to the git-managed original. Every mutation visible in the audit browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeTar, readTar } from "../../src/suites/tar.ts";
import { ulid } from "../../src/ulid.ts";
import { withApp, loadSuiteDir, REPO_ROOT } from "./helpers.ts";

const TODOS = path.join(REPO_ROOT, "tests/fixtures/todos");

function cliList(dir: HostedDynamic) {
  const out = execFileSync("node", [path.join(REPO_ROOT, "src/cli/cli.ts"), "list", dir, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out);
}

async function extractTar(buf: HostedDynamic) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ptexport-"));
  for (const [rel, data] of Object.entries(readTar(buf))) {
    const abs = path.join(dir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, data);
  }
  return dir;
}

test("exit gate: import → edit → commit → export → CLI parity", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    // --- import the test-owned todo suite via the API ---
    assert.equal((await api.post("/projects", { key: "todos-co", name: "Todos Co" })).status, 201);
    const suite = (await api.post("/projects/todos-co/suites", { slug: "todos", name: "Todos" })).body;
    const tar = writeTar(loadSuiteDir(TODOS));
    const imported = await api.postTar(`/suites/${suite.id}/import`, tar);
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.cases.length, 3);

    // --- resolved cases match the CLI ---
    const cases = (await api.get(`/suites/${suite.id}/cases`)).body.items;
    assert.deepEqual(cases.map((c: HostedDynamic) => c.id), ["add-todo", "clear-completed", "complete-todo"]);

    // --- the suite-by-slug include folds the same shapes onto the row, so the
    //     suite page's first paint is one request ---
    const folded = (await api.get(`/projects/todos-co/suites/todos?include=cases,defaults`)).body;
    assert.deepEqual(folded.cases, cases, "include=cases carries exactly the /cases items");
    const defaultsFile = (await api.get(`/suites/${suite.id}/files/playtest.yaml`)).body;
    assert.equal(folded.defaults.content, defaultsFile.content, "include=defaults carries the playtest.yaml row");
    const badInclude = await api.get(`/projects/todos-co/suites/todos?include=bogus`);
    assert.equal(badInclude.status, 400, "an unknown include is refused, not silently ignored");

    // --- edit a case: an invalid change renders the verbatim core message (422) ---
    const bad = await api.put(`/suites/${suite.id}/files/stories/add-todo.yaml`, {
      content: 'story: hi\nsuccess:\n  - element_exists: "[x]"\nbogus_key: 1\n',
    });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.code, "validation_failed");
    assert.match(bad.body.error.details[0].message, /unknown key "bogus_key"/);
    assert.equal(bad.body.error.details[0].path, "stories/add-todo.yaml");

    // --- a valid edit commits (a new snapshot) ---
    const original = (await api.get(`/suites/${suite.id}/files/stories/add-todo.yaml`)).body.content;
    const edited = original.replace("Add \"buy milk\"", "Add \"buy oat milk\"");
    const put = await api.put(`/suites/${suite.id}/files/stories/add-todo.yaml`, { content: edited, note: "tweak" });
    assert.equal(put.status, 200);
    assert.equal(put.body.snapshot.seq, 2); // import was #1

    // --- export the snapshot and run the exported tree with the local CLI ---
    const exp = await api.get(`/suites/${suite.id}/export`);
    assert.equal(exp.status, 200);
    const dir = await extractTar(exp.body);
    try {
      const fromExport = cliList(dir);
      const fromOriginal = cliList(TODOS);
      assert.deepEqual(
        fromExport.map((c: HostedDynamic) => ({ id: c.id, tags: c.tags, persona: c.persona, next_run: c.next_run })),
        fromOriginal.map((c: HostedDynamic) => ({ id: c.id, tags: c.tags, persona: c.persona, next_run: c.next_run })),
        "exported tree resolves identically to the git-managed original",
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }

    // --- every mutation is in the audit browser ---
    const audit = (await api.get(`/projects/todos-co/audit`)).body.items;
    const actions = audit.map((a: HostedDynamic) => a.action);
    assert.ok(actions.includes("project.created"));
    assert.ok(actions.includes("suite.imported"));
    assert.ok(actions.includes("file.saved"));
  });
});

test("commit: content-addressed snapshots, monotonic seq, resolved cases returned", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    const c1 = await api.post(`/suites/${suite.id}/commit`, {
      changes: [
        { path: "playtest.yaml", content: "app:\n  base_url: http://x\n" },
        { path: "stories/a.yaml", content: "story: a\nsuccess:\n  - assert: ok\n" },
      ],
      note: "one",
    });
    assert.equal(c1.body.snapshot.seq, 1);
    assert.equal(c1.body.cases.length, 1);
    const c2 = await api.post(`/suites/${suite.id}/commit`, { changes: [{ path: "stories/b.yaml", content: "story: b\nsuccess:\n  - assert: ok\n" }], note: "two" });
    assert.equal(c2.body.snapshot.seq, 2);
    assert.equal((await api.get(`/suites/${suite.id}/cases`)).body.items.length, 2);
    // The story editor's delete is a versioned file mutation with a factual
    // Versions note and the same optimistic-concurrency guard as Save.
    const del = await api.del(`/suites/${suite.id}/files/stories/b.yaml`, {
      note: "deleted story b",
      base_seq: 2,
    });
    assert.equal(del.body.snapshot.seq, 3);
    assert.equal(del.body.snapshot.note, "deleted story b");
    assert.deepEqual(del.body.cases.map((c: HostedDynamic) => c.id), ["a"]);
    const remaining = readTar((await api.get(`/suites/${suite.id}/export`)).body);
    assert.equal(Object.keys(remaining).length, 2);
    const audit = (await api.get("/projects/p/audit?action=file.deleted")).body.items;
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].detail.changes, [{ path: "stories/b.yaml", deleted: true }]);
  });
});

// The console's Versions page promises "you can restore this from Versions"
// after an import. Restore is exactly this pair — export ONE snapshot, import
// it back — so the promise is only true if the pair round-trips. Restoring
// lands as a NEW version rather than rewriting history, which is what lets a
// person undo the undo.
test("versions: restore = export one snapshot → import, as a new version", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    const v1 = await api.post(`/suites/${suite.id}/commit`, {
      changes: [
        { path: "playtest.yaml", content: "app:\n  base_url: http://x\n" },
        { path: "stories/a.yaml", content: "story: original\nsuccess:\n  - assert: ok\n" },
      ],
      note: "one",
    });
    await api.post(`/suites/${suite.id}/commit`, {
      changes: [
        { path: "stories/a.yaml", content: "story: rewritten\nsuccess:\n  - assert: ok\n" },
        { path: "stories/b.yaml", content: "story: b\nsuccess:\n  - assert: ok\n" },
      ],
      note: "two",
    });

    const snaps = (await api.get(`/suites/${suite.id}/snapshots?limit=10`)).body.items;
    const old = snaps.find((s: HostedDynamic) => s.seq === v1.body.snapshot.seq);
    assert.ok(old, "the first version is still listed");

    const tar = await api.get(`/suites/${suite.id}/export?snapshot=${old.id}`);
    assert.equal(tar.status, 200);
    const restored = await api.postTar(`/suites/${suite.id}/import`, tar.body);
    assert.equal(restored.status, 200);

    // The tree is back at v1: the rewrite is undone and the added file is gone.
    const files = Object.keys(readTar((await api.get(`/suites/${suite.id}/export`)).body));
    assert.deepEqual(files.sort(), ["playtest.yaml", "stories/a.yaml"]);
    const content = (await api.get(`/suites/${suite.id}/files/stories/a.yaml`)).body.content;
    assert.match(content, /story: original/);

    // Nothing was erased — the restore is version 3, so v2 is still reachable.
    const after = (await api.get(`/suites/${suite.id}/snapshots?limit=10`)).body.items;
    assert.equal(after[0].seq, 3, "restoring appends a version rather than rewriting history");
    assert.ok(after.some((s: HostedDynamic) => s.seq === 2), "the version being undone survives");
  });
});

test("suites projection: by-slug GET + story_count, no tree resolution", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    await api.post(`/suites/${suite.id}/commit`, {
      changes: [
        { path: "playtest.yaml", content: "app:\n  base_url: http://x\n" },
        { path: "stories/a.yaml", content: "story: a\nsuccess:\n  - assert: ok\n" },
        { path: "stories/b.yaml", content: "story: b\nsuccess:\n  - assert: ok\n" },
      ],
      note: "v1",
    });
    // story_count rides the list projection: story FILES, not resolved instances.
    const list = (await api.get(`/projects/p/suites`)).body.items;
    assert.equal(list[0].story_count, 2);
    // by-slug GET returns the same row (slug → id without list-then-filter)…
    const bySlug = await api.get(`/projects/p/suites/s`);
    assert.equal(bySlug.status, 200);
    assert.equal(bySlug.body.id, suite.id);
    assert.equal(bySlug.body.story_count, 2);
    // …and a miss is a friendly 404.
    assert.equal((await api.get(`/projects/p/suites/nope`)).status, 404);
  });
});

// A hosted snapshot tree has no results/ dir, so core's per-file baseline read can
// only ever say "record" — a story that has run and been accepted for months would
// still read "never recorded" in the console. Hosted, the baselines table decides,
// exactly as dispatch plans run modes.
test("cases: next_run comes from the baselines table, not the materialized tree", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    const seeded = await api.post(`/suites/${suite.id}/commit`, {
      changes: [
        { path: "playtest.yaml", content: "app:\n  base_url: http://x\n" },
        { path: "stories/add-todo.yaml", content: "story: add a todo\nsuccess:\n  - assert: ok\n" },
        { path: "stories/clear-completed.yaml", content: "story: clear completed\nsuccess:\n  - assert: ok\n" },
        { path: "export-study.yaml", content: "mode: discovery\npersona: [tester, exploratory]\nstory: find the export\n" },
      ],
      note: "seed",
    });
    assert.equal(seeded.status, 200, JSON.stringify(seeded.body));

    const nextRun = async () =>
      Object.fromEntries(
        (await api.get(`/suites/${suite.id}/cases`)).body.items.map((c: HostedDynamic) => [c.id, c.next_run]),
      );

    // No baselines yet: journeys record, discovery explores.
    assert.deepEqual(await nextRun(), {
      "add-todo": "record",
      "clear-completed": "record",
      "export-study@exploratory": "explore",
      "export-study@tester": "explore",
    });

    const { rows: [project] } = await app.db.query(`SELECT id FROM projects WHERE key = 'p'`);
    const baseline = (storyId: HostedDynamic, { version = 1, supersededBy = null }: HostedDynamic = {}) =>
      app.db.query(
        `INSERT INTO baselines (id, project_id, suite_id, story_id, version, trajectory_key, meta, superseded_by)
           VALUES ($1, $2, $3, $4, $5, 'runs/x.ptrun#trajectory.jsonl', '{}', $6)`,
        [ulid(), project.id, suite.id, storyId, version, supersededBy],
      );
    await baseline("add-todo"); // live → check
    await baseline("clear-completed", { supersededBy: "b_gone" }); // superseded → still record
    // Baselines key on the persona-INDEPENDENT story id; discovery still decides first.
    await baseline("export-study");

    assert.deepEqual(await nextRun(), {
      "add-todo": "check",
      "clear-completed": "record",
      "export-study@exploratory": "explore",
      "export-study@tester": "explore",
    });
  });
});

test("lifecycle: archive hides from the default list; delete is runless-only", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    // archive: gone from the live list, present under ?archived=1, still fetchable by slug
    assert.equal((await api.patch(`/suites/${suite.id}`, { archived: true })).body.archived, true);
    assert.equal((await api.get(`/projects/p/suites`)).body.items.length, 0);
    assert.deepEqual((await api.get(`/projects/p/suites?archived=1`)).body.items.map((s: HostedDynamic) => s.slug), ["s"]);
    assert.equal((await api.get(`/projects/p/suites/s`)).body.archived, true);
    // unarchive restores it
    assert.equal((await api.patch(`/suites/${suite.id}`, { archived: false })).body.archived, false);
    assert.equal((await api.get(`/projects/p/suites`)).body.items.length, 1);
    // a suite with run history refuses to die — archive is the retirement path
    await api.post(`/suites/${suite.id}/commit`, {
      changes: [{ path: "stories/a.yaml", content: "story: a\napp:\n  base_url: http://x\nsuccess:\n  - assert: ok\n" }],
      note: "v1",
    });
    const { rows: [proj] } = await app.db.query(`SELECT id FROM projects WHERE key = 'p'`);
    const { rows: [snap] } = await app.db.query(`SELECT id FROM suite_snapshots WHERE suite_id = $1`, [suite.id]);
    await app.db.query(
      `INSERT INTO environments (id, project_id, name) VALUES ('env1', $1, 'staging')`,
      [proj.id],
    );
    await app.db.query(
      `INSERT INTO run_groups (id, project_id, suite_id, snapshot_id, environment_id, trigger, selection, status)
        VALUES ('rg1', $1, $2, $3, 'env1', '{}', '{}', 'queued')`,
      [proj.id, suite.id, snap.id],
    );
    const blocked = await api.del(`/suites/${suite.id}`);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error.message, /run group.*[Aa]rchive/s);
    // a runless suite deletes cleanly (files/snapshots cascade)
    await app.db.query(`DELETE FROM run_groups WHERE id = 'rg1'`);
    assert.equal((await api.del(`/suites/${suite.id}`)).status, 200);
    assert.equal((await api.get(`/projects/p/suites/s`)).status, 404);
  });
});

test("commit: base_seq conflict returns 409, never a silent overwrite", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    await api.post(`/suites/${suite.id}/commit`, {
      changes: [
        { path: "playtest.yaml", content: "app:\n  base_url: http://x\n" },
        { path: "stories/a.yaml", content: "story: a\nsuccess:\n  - assert: ok\n" },
      ],
      note: "v1",
    }); // → seq 1
    // Two editors both loaded at seq 1.
    await api.put(`/suites/${suite.id}/files/stories/a.yaml`, { content: "story: a2\nsuccess:\n  - assert: ok\n", base_seq: 1 }); // → seq 2
    const stale = await api.put(`/suites/${suite.id}/files/stories/a.yaml`, { content: "story: a3\nsuccess:\n  - assert: ok\n", base_seq: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "conflict");
    assert.equal(stale.body.error.details[0].path, "stories/a.yaml");
    // Deletion must not erase that newer edit either.
    const staleDelete = await api.del(`/suites/${suite.id}/files/stories/a.yaml`, { base_seq: 1 });
    assert.equal(staleDelete.status, 409);
    assert.match((await api.get(`/suites/${suite.id}/files/stories/a.yaml`)).body.content, /story: a2/);
  });
});

test("import: macOS AppleDouble/Finder junk is skipped, a real NUL-containing file is rejected friendly", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    const base = loadSuiteDir(TODOS);

    // Junk-plus-valid: AppleDouble (._*) and .DS_Store entries a macOS `tar c` sweeps
    // in unasked — their binary resource-fork bytes would otherwise trip the NUL
    // check below, so they must be dropped before it runs.
    const withJunk = writeTar({
      ...base,
      "._add-todo.yaml": Buffer.from([0, 1, 2, 0, 3]),
      "stories/._add-todo.yaml": Buffer.from([0, 1, 2]),
      ".DS_Store": Buffer.from([1, 2, 3, 0, 4]),
    });
    const ok = await api.postTar(`/suites/${suite.id}/import`, withJunk);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const files = Object.keys(readTar((await api.get(`/suites/${suite.id}/export`)).body));
    assert.ok(!files.some((p) => p.includes("._") || p.endsWith(".DS_Store")), "junk entries must not land as suite files");
    assert.ok(files.includes("stories/add-todo.yaml"));

    // A genuine binary/NUL file (not macOS junk) must reject with a friendly 400
    // naming the path, never a raw pg "invalid byte sequence for encoding UTF8: 0x00".
    const suite2 = (await api.post("/projects/p/suites", { slug: "s2", name: "S2" })).body;
    const withNul = writeTar({ ...base, "assets/bad.bin": Buffer.from([1, 2, 0, 3]) });
    const bad = await api.postTar(`/suites/${suite2.id}/import`, withNul);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "bad_request");
    assert.match(bad.body.error.message, /assets\/bad\.bin/);
    assert.match(bad.body.error.message, /COPYFILE_DISABLE/);
  });
});

test("export/import: tar round-trips a suite between hosted DB and disk", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    await api.postTar(`/suites/${suite.id}/import`, writeTar(loadSuiteDir(TODOS)));
    const exported = readTar((await api.get(`/suites/${suite.id}/export`)).body);
    assert.ok(exported["playtest.yaml"]);
    assert.ok(exported["stories/add-todo.yaml"]);
    assert.equal(Object.keys(exported).filter((p) => p.startsWith("stories/")).length, 3);
  });
});
