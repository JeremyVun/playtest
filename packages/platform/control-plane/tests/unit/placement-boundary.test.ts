// Design gate 6, pinned at the source: THE CONTROL PLANE STARTS NO PROCESS IN
// RESPONSE TO A LAUNCH.
//
// Every runner — a laptop, a CI job, a build box — arrives the same way: poll,
// claim, exchange. The behavioral half of this gate is in
// `tests/integration/site-runners.test.ts` (a launch with nobody polling stays
// on the board and registers no executor). This half is structural, and it is
// the one that survives refactoring: with no way to spawn anything, no future
// convenience can quietly reintroduce a local dispatch adapter.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && full.endsWith(".ts") ? [full] : [];
  });
}

test("the control plane cannot start a process: nothing imports child_process", () => {
  const offenders = sourceFiles(SRC).filter((file) => /child_process|\bexecFile\(|\bspawn\(/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(
    offenders.map((f) => path.relative(SRC, f)),
    [],
    "placement is the claim board and nothing else — a runner dials out, it is never spawned",
  );
});

test("no placement adapter survives: dispatch names no github, local, or PLAYTEST_DISPATCH selector", () => {
  const dispatchDir = path.join(SRC, "dispatch");
  const files = fs.readdirSync(dispatchDir).sort();
  assert.equal(files.includes("github.ts"), false, "GitHub dispatch is deleted");
  assert.equal(files.includes("local.ts"), false, "local dispatch is deleted");
  const all = sourceFiles(SRC)
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");
  assert.equal(/PLAYTEST_DISPATCH\b/.test(all), false, "there is no dispatch-adapter selector to set");
});
