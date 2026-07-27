import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeTar, readTar } from "../../src/suites/tar.ts";

test("tar: round-trips a suite tree", () => {
  const files = {
    "playtest.yaml": "app:\n  base_url: http://x\n",
    "stories/add-todo.yaml": 'story: hi\nsuccess:\n  - assert: ok\n',
    "assertions/link-check/assertion.js": "export default {};\n",
  };
  const back: HostedDynamic = readTar(writeTar(files));
  for (const [k, v] of Object.entries(files)) assert.equal(back[k].toString("utf8"), v);
  assert.equal(Object.keys(back).length, 3);
});

test("tar: deterministic output for equal input", () => {
  const files = { b: "2", a: "1", c: "3" };
  assert.deepEqual(writeTar(files), writeTar({ ...files }));
});

test("tar: extractable by the system tar (CLI round-trip)", () => {
  const files = { "playtest.yaml": "a: 1\n", "stories/x.yaml": "story: y\n" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tartest-"));
  fs.writeFileSync(path.join(dir, "s.tar"), writeTar(files));
  execFileSync("tar", ["xf", "s.tar"], { cwd: dir });
  assert.equal(fs.readFileSync(path.join(dir, "stories/x.yaml"), "utf8"), "story: y\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tar: corrupt header is rejected", () => {
  const buf: HostedDynamic = writeTar({ "a.yaml": "x: 1\n" });
  buf[150] = buf[150] ^ 0xff; // clobber a checksum byte
  assert.throws(() => readTar(buf), /checksum/);
});

test("tar: handles binary content", () => {
  const bin = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
  const back = readTar(writeTar({ "blob.bin": bin }));
  assert.deepEqual(back["blob.bin"], bin);
});
