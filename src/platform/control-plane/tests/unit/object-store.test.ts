import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsStore } from "../../src/store/fs-store.ts";
import { AppError } from "../../src/errors.ts";

function tmpStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
  return { store: new FsStore(root), root };
}

test("fs-store: put/get round-trip + sha256", async () => {
  const { store } = tmpStore();
  const { sha256, size } = await store.put("blobs/x", "hello");
  assert.equal(size, 5);
  assert.equal(sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal((await store.get("blobs/x")).toString(), "hello");
});

test("fs-store: has / delete are idempotent", async () => {
  const { store } = tmpStore();
  assert.equal(await store.has("k"), false);
  await store.put("k", "v");
  assert.equal(await store.has("k"), true);
  await store.delete("k");
  await store.delete("k"); // no throw
  assert.equal(await store.has("k"), false);
});

test("fs-store: getRange returns an inclusive slice", async () => {
  const { store } = tmpStore();
  await store.put("k", "0123456789");
  assert.equal((await store.getRange("k", 2, 4)).toString(), "234");
});

test("fs-store: get on missing key throws not_found AppError", async () => {
  const { store } = tmpStore();
  await assert.rejects(() => store.get("missing"), (e) => e instanceof AppError && e.code === "not_found");
});

test("fs-store: refuses keys escaping the root", async () => {
  const { store } = tmpStore();
  await assert.rejects(() => store.put("../evil", "x"), (e) => e instanceof AppError && e.code === "storage_error");
});

test("fs-store: list returns keys under a prefix, sorted", async () => {
  const { store } = tmpStore();
  await store.put("blobs/b", "1");
  await store.put("blobs/a", "1");
  await store.put("other/c", "1");
  assert.deepEqual(await store.list("blobs"), ["blobs/a", "blobs/b"]);
});
