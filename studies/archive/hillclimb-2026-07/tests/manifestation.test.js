// Manifestation tests for the hill-climb fault catalog: every seeded fault
// must be LIVE in the fully-broken baseline and ABSENT from the clean
// reference, and the injector's byte accounting must hold. Offline and
// standalone:  node --test studies/hillclimb/tests/*.test.js
// (Deliberately NOT part of root npm test — see docs/backlog/hillclimb-evidence.md.)

import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CHECKS } from "./fault-checks.mjs";

const studyDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const subjectDir = path.join(studyDir, "subject");
const faultsFile = path.join(studyDir, "faults.json");
const catalog = JSON.parse(readFileSync(faultsFile, "utf8"));

const { inject, hashTree } = await import(pathToFileURL(path.join(studyDir, "inject-faults.mjs")).href);

const tmp = mkdtempSync(path.join(tmpdir(), "hillclimb-"));
const brokenDir = path.join(tmp, "broken");
const manifest = inject({ subjectDir, faultsFile, outDir: brokenDir });

const { start: startClean } = await import(pathToFileURL(path.join(subjectDir, "server.js")).href);
const { start: startBroken } = await import(pathToFileURL(path.join(brokenDir, "server.js")).href);
const clean = await startClean({ port: 0 });
const broken = await startBroken({ port: 0 });

test.after(async () => {
  await clean.close();
  await broken.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("catalog shape: every fault has a check, a class buddy, and known masks", () => {
  const ids = new Set(catalog.faults.map((f) => f.id));
  assert.equal(ids.size, catalog.faults.length, "fault ids unique");
  for (const fault of catalog.faults) {
    assert.ok(CHECKS[fault.id], `${fault.id}: has a manifestation check`);
    assert.ok(["L1", "L2", "L3", "L4"].includes(fault.level), `${fault.id}: valid level`);
    for (const masker of fault.masked_by) assert.ok(ids.has(masker), `${fault.id}: masked_by ${masker} exists`);
  }
  for (const id of Object.keys(CHECKS)) assert.ok(ids.has(id), `check ${id} maps to a catalog fault`);
  const byClass = new Map();
  for (const fault of catalog.faults) byClass.set(fault.class, (byClass.get(fault.class) ?? 0) + 1);
  for (const [cls, n] of byClass) assert.ok(n >= 2, `class ${cls} has >=2 instances (has ${n})`);
});

test("injector accounting: manifest lists all faults and the tree hash is stable", () => {
  assert.deepEqual(manifest.ids, catalog.faults.map((f) => f.id).sort());
  assert.equal(manifest.app_hash, hashTree(brokenDir));
  assert.notEqual(manifest.app_hash, manifest.clean_hash);
  assert.equal(manifest.clean_hash, hashTree(subjectDir), "clean hash matches the committed reference");
});

for (const fault of catalog.faults) {
  test(`${fault.id} (${fault.level} ${fault.class}): absent on clean, live on broken`, async () => {
    assert.equal(await CHECKS[fault.id](clean.url), false, `${fault.id} must NOT manifest on the clean reference`);
    assert.equal(await CHECKS[fault.id](broken.url), true, `${fault.id} must manifest on the fully-broken baseline`);
  });
}

test("single-fault injection (--only) applies exactly that fault", async () => {
  const soloDir = path.join(tmp, "solo");
  const solo = inject({ subjectDir, faultsFile, outDir: soloDir, only: ["f-sort-inert"] });
  assert.deepEqual(solo.ids, ["f-sort-inert"]);
  const { start } = await import(pathToFileURL(path.join(soloDir, "server.js")).href);
  const app = await start({ port: 0 });
  try {
    assert.equal(await CHECKS["f-sort-inert"](app.url), true);
    assert.equal(await CHECKS["f-search-removed"](app.url), false);
  } finally {
    await app.close();
  }
});
