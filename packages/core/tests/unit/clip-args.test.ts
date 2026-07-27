// The ffmpeg command `playtest clip` (and hosted Export clip) builds for the
// paced-stills slideshow. Hermetic: slideshowArgs is pure — it writes the concat
// list file and returns argv, without ever spawning ffmpeg. Running the real
// binary belongs to the control plane's clip integration test.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { slideshowArgs } from "../../src/clip.ts";

/** A run dir with `count` step screenshots and their trajectory envelopes. */
function runDirWithSteps(count: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-clip-args-"));
  fs.mkdirSync(path.join(dir, "steps"));
  const envelopes = [];
  for (let i = 1; i <= count; i++) {
    const rel = `steps/${String(i).padStart(3, "0")}.png`;
    fs.writeFileSync(path.join(dir, rel), Buffer.from("not-a-real-png"));
    envelopes.push({ step: i, ts: i * 1000, artifacts: { screenshot: rel } });
  }
  return { dir, envelopes };
}

test("slideshowArgs: the concat list is passed as the INPUT, not just written", (t) => {
  const { dir, envelopes } = runDirWithSteps(3);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { args, listFile } = slideshowArgs(dir, envelopes, path.join(dir, "out.mp4"));
  t.after(() => fs.rmSync(listFile, { force: true }));

  // The regression: the list file was written and then never referenced, so
  // ffmpeg received filters and an output with no source and died with "Output
  // file does not contain any stream" — every clip, on every platform, with any
  // ffmpeg build. An arg vector that merely *mentions* the path is not enough;
  // it has to be the concat demuxer's `-i`.
  const i = args.indexOf("-i");
  assert.notEqual(i, -1, "argv must carry an input flag");
  assert.equal(args[i + 1], listFile, "-i must point at the generated concat list");
  // The demuxer and its safety flag, both ahead of the input they configure.
  // Absolute run-directory paths in the list require -safe 0.
  assert.deepEqual(args.slice(0, i), ["-f", "concat", "-safe", "0"]);
  // Input selection must precede the filter/codec/output tail.
  assert.ok(i < args.indexOf("-vf"), "input comes before -vf");
  assert.equal(args.at(-1), path.join(dir, "out.mp4"), "output path is last");
});

test("slideshowArgs: the list file paces every screenshotted step and repeats the last frame", (t) => {
  const { dir, envelopes } = runDirWithSteps(2);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { listFile, frames } = slideshowArgs(dir, envelopes, path.join(dir, "out.mp4"));
  t.after(() => fs.rmSync(listFile, { force: true }));
  const list = fs.readFileSync(listFile, "utf8");

  assert.equal(frames.length, 2);
  // Two frames plus the trailing repeat the concat demuxer needs for the final
  // duration to be honored at all.
  assert.equal(list.match(/^file /gm)!.length, 3); // SAFETY: the fixture always contains file rows
  assert.equal(list.match(/^duration /gm)!.length, 2); // SAFETY: the fixture always contains duration rows
  assert.ok(list.includes(path.join(dir, "steps/001.png")));
});

test("slideshowArgs: a run with no step screenshots refuses instead of building an empty clip", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-clip-args-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(
    () => slideshowArgs(dir, [{ step: 1, ts: 1000, artifacts: {} }], path.join(dir, "out.mp4")),
    /no step screenshots/,
  );
});
