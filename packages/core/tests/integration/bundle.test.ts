import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BundleProvider,
  coreBundleKeepPath,
  fileReadRange,
  rebuildIndex,
  rewriteBundle,
  writeBundle,
} from "../../src/bundle.ts";

test("writeBundle is deterministic and BundleProvider reads files and STORE ranges", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-bundle-"));
  try {
    const runDir = makeRunDir(tmp);
    const outA = path.join(tmp, "a.ptrun");
    const outB = path.join(tmp, "b.ptrun");
    const a = writeBundle(runDir, outA);
    const b = writeBundle(runDir, outB);

    assert.equal(a.sha256, b.sha256, "equal trees produce equal bundle hashes");
    assert.deepEqual(fs.readFileSync(outA), fs.readFileSync(outB), "equal trees produce equal bytes");
    assert.deepEqual(rebuildIndex(fileReadRange(outA)), a.index, "central directory rebuild matches the sidecar index");
    assert.ok(fs.existsSync(`${outA}.idx.json`), "writeBundle emits the index sidecar");

    const provider: LegacyTestValue = BundleProvider.fromFile(outA);
    assert.equal(provider.readText("manifest.json"), fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
    assert.deepEqual(
      provider.listDir("steps").map((e: LegacyTestValue) => [e.name, e.isFile, e.isDirectory]),
      [
        ["001.a11y.txt", true, false],
        ["001.mhtml", true, false],
        ["001.png", true, false],
      ],
    );

    const video = fs.readFileSync(path.join(runDir, "video.webm"));
    assert.deepEqual(await streamBytes(provider.createReadStream("video.webm", { start: 2, end: 7 })), video.subarray(2, 8));
    assert.equal(provider.stat("video.webm").size, video.length);

    const ptrun = JSON.parse(provider.readText("ptrun.json"));
    assert.equal(ptrun.created_at, "2026-06-10T03:04:22Z", "created_at is stable for deterministic output");
    assert.equal(ptrun.tier, "full");
    assert.equal(ptrun.entries.some((e: LegacyTestValue) => e.path === "ptrun.json"), false, "ptrun.json describes following entries only");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("rewriteBundle tiers down by copying kept compressed payloads", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-rewrite-"));
  try {
    const runDir = makeRunDir(tmp);
    const fullPath = path.join(tmp, "full.ptrun");
    const corePath = path.join(tmp, "core.ptrun");
    const full = writeBundle(runDir, fullPath);
    const core = rewriteBundle(fullPath, corePath, coreBundleKeepPath);
    const provider: LegacyTestValue = BundleProvider.fromFile(corePath);

    assert.equal(JSON.parse(provider.readText("ptrun.json")).tier, "core");
    assert.equal(provider.readText("manifest.json"), fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
    assert.equal(provider.readText("steps/001.a11y.txt"), fs.readFileSync(path.join(runDir, "steps", "001.a11y.txt"), "utf8"));
    assert.equal(provider.stat("video.webm"), null, "full-tier video is dropped");
    assert.equal(provider.stat("steps/001.png"), null, "full-tier screenshots are dropped");

    const fullRange = fileReadRange(fullPath);
    const coreRange = fileReadRange(corePath);
    const fullTraj: LegacyTestValue = full.index.entries["trajectory.jsonl"];
    const coreTraj: LegacyTestValue = core.index.entries["trajectory.jsonl"];
    assert.deepEqual(
      fullRange(fullTraj.offset, fullTraj.offset + fullTraj.csize - 1),
      coreRange(coreTraj.offset, coreTraj.offset + coreTraj.csize - 1),
      "kept DEFLATE payloads are raw-copied, not recompressed",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function makeRunDir(tmp: LegacyTestValue) {
  const runDir = path.join(tmp, "runs", "2026-06-10T0300-ab12", "todos", "add-todo");
  fs.mkdirSync(path.join(runDir, "steps"), { recursive: true });
  const manifest = {
    schema_version: 1,
    run_id: "2026-06-10T0300-ab12",
    case: {
      id: "todos/add-todo",
      file: path.join(tmp, "suite", "add-todo.yaml"),
      story: "Add a todo.",
      description: "Bundle fixture",
      mode: "journey",
      persona: null,
      tags: ["smoke"],
      success: [],
      perf: [],
      report: [],
      vision: false,
      limits: { max_steps: 3 },
    },
    mode: "record",
    started_at: "2026-06-10T03:04:11Z",
    finished_at: "2026-06-10T03:04:22Z",
    duration_ms: 11000,
    video_started_at: 0,
    pins: { harness_version: "0.1.0", driver: "web" },
    env: { base_url: "http://127.0.0.1:1", managed: false },
    result: { status: "pass", end_reason: "done", error: null, gate: { pass: true, checks: [] } },
    totals: { steps: 1, executed_steps: 1, tokens: { in: 0, out: 0, cache_read: 0 }, cost_usd: 0, console_errors: 0 },
    healed: false,
    baseline: null,
    artifacts: {
      trajectory: "trajectory.jsonl",
      har: "har.json",
      video: "video.webm",
      trace: "trace.zip",
      grade: "grade.json",
      context: "context.jsonl",
      baseline_copy: "baseline.jsonl",
    },
  };
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(
    path.join(runDir, "trajectory.jsonl"),
    JSON.stringify({
      step: 1,
      schema_version: 6,
      ts: 0,
      mode: "agent",
      agent: {
        thought: "Add the todo using the primary button.",
        action: { type: "click", ref: "e1" },
        expectation: "The todo appears.",
      },
      resolution: { locator: "#add", bbox: { x: 10, y: 10, w: 80, h: 30 } },
      result: { ok: true, error: null, settle_ms: 1, url: "http://127.0.0.1:1" },
      perf: null,
      network: { requests: [] },
      artifacts: { screenshot: "steps/001.png", a11y: "steps/001.a11y.txt" },
      snapshot_text: "[e1] button Add todo",
    }) + "\n",
  );
  fs.writeFileSync(path.join(runDir, "grade.json"), JSON.stringify({ score: 91 }) + "\n");
  fs.writeFileSync(path.join(runDir, "har.json"), JSON.stringify({ log: { entries: [] } }) + "\n");
  fs.writeFileSync(path.join(runDir, "context.jsonl"), JSON.stringify({ step: 1, messages: [] }) + "\n");
  fs.writeFileSync(path.join(runDir, "baseline.jsonl"), JSON.stringify({ step: 1, action: { type: "click" } }) + "\n");
  fs.writeFileSync(path.join(runDir, "video.webm"), Buffer.from("0123456789abcdef"));
  fs.writeFileSync(path.join(runDir, "video.vtt"), "WEBVTT\n\n");
  fs.writeFileSync(path.join(runDir, "trace.zip"), crypto.randomBytes(12));
  fs.writeFileSync(path.join(runDir, "steps", "001.png"), Buffer.from(PNG_1X1, "base64"));
  fs.writeFileSync(path.join(runDir, "steps", "001.a11y.txt"), "button Add todo\n");
  fs.writeFileSync(path.join(runDir, "steps", "001.mhtml"), "<html><body>Add todo</body></html>\n");
  return runDir;
}

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

async function streamBytes(stream: LegacyTestValue) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
