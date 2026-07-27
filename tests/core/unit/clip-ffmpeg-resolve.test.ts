// resolveFfmpeg picks the first candidate that runs and (for --burn) carries
// the subtitles/drawtext filters, falling back past a slim PATH build to the
// conventional ffmpeg-full locations. Hermetic: candidates are fake local
// scripts; nothing depends on a system ffmpeg.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveFfmpeg } from "../../../src/core/clip.ts";
import { DummyConfigError } from "../../../src/core/config.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-ffmpeg-resolve-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

/** A fake ffmpeg that answers `-filters` with the given filter rows. */
function fakeFfmpeg(name: string, filters: string[]) {
  const file = path.join(dir, name);
  const rows = filters.map((f: string) => ` T.. ${f}              V->V       fake`).join("\\n");
  fs.writeFileSync(file, `#!/bin/sh\nprintf 'Filters:\\n${rows}\\n'\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

const full = fakeFfmpeg("full", ["subtitles", "drawtext", "scale"]);
const slim = fakeFfmpeg("slim", ["scale"]);
const missing = path.join(dir, "does-not-exist");

test("a slim first candidate falls back to a burn-capable one for burn-in", () => {
  assert.equal(resolveFfmpeg({ burnFilters: true, candidates: [slim, full] }), full);
});

test("without burn-in the slim build is good enough and wins by order", () => {
  assert.equal(resolveFfmpeg({ burnFilters: false, candidates: [slim, full] }), slim);
});

test("a missing candidate is skipped, not fatal", () => {
  assert.equal(resolveFfmpeg({ burnFilters: true, candidates: [missing, full] }), full);
});

test("all candidates slim: the error names the slim build and the fix", () => {
  assert.throws(
    () => resolveFfmpeg({ burnFilters: true, candidates: [missing, slim] }),
    (err) => {
      assert.ok(err instanceof DummyConfigError);
      assert.match(err.message, /slim build without the subtitles\/drawtext/);
      assert.match(err.message, /ffmpeg-full/);
      return true;
    },
  );
});

test("no candidate runs at all: the error asks for an install", () => {
  assert.throws(
    () => resolveFfmpeg({ burnFilters: false, candidates: [missing] }),
    (err) => {
      assert.ok(err instanceof DummyConfigError);
      assert.match(err.message, /needs ffmpeg/);
      return true;
    },
  );
});
