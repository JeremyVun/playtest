// Phase L2: the runner-agent live uploader
// (docs/backlog/live-runs/BUILD_PLAN.md, docs/contracts/hosted.md "Live staging
// routes").
//
// Every test drives the real uploader against a fake control plane that speaks
// the real ack vocabulary over real HTTP on loopback — so single-flight
// ordering, aborts and retries are exercised as transport, not as mocks. The
// run directory is a real directory written the way the engine writes one:
// artifacts on disk strictly before the trajectory line that names them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ApiClient } from "../../src/api-client.ts";
import { apiPath, artifactRefs, liveUploader } from "../../src/live-uploader.ts";

const TICK = 10;

/** A fake control plane implementing the live routes' ack semantics. */
function startControlPlane({ hook = null }: LegacyTestValue = {}) {
  const calls: LegacyTestValue[] = [];
  const aborted: LegacyTestValue[] = [];
  const state: LegacyTestValue = { manifests: [], generation: 0, entries: new Map(), lines: [] as string[] };
  let concurrent = 0;
  let maxConcurrent = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const url = String(req.url);
      const call: LegacyTestValue = { method: req.method, url, raw, index: calls.length };
      if (url.endsWith("/open")) call.route = "open";
      else if (url.endsWith("/live/trajectory")) call.route = "trajectory";
      else if (url.includes("/live/")) {
        call.route = "entry";
        call.entry = url.slice(url.indexOf("/live/") + "/live/".length);
      } else call.route = "other";
      if (call.route !== "entry") {
        try {
          call.body = JSON.parse(raw.toString("utf8") || "{}");
        } catch {
          call.body = null;
        }
      }
      calls.push(call);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const done = (status: number, body: LegacyTestValue) => {
        concurrent -= 1;
        const text = JSON.stringify(body);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        res.end(text);
      };
      const directive = hook ? hook(call, state) : null;
      if (directive?.hold) {
        res.on("close", () => {
          concurrent -= 1;
          aborted.push(call);
        });
        return;
      }
      if (directive?.status) return done(directive.status, directive.body ?? {});
      if (directive?.ack) return done(200, directive.ack);
      const ack = apply(call, state);
      if (directive?.dropAfterApply) {
        concurrent -= 1;
        res.socket?.destroy();
        return;
      }
      done(200, ack);
    });
  });

  return new Promise<LegacyTestValue>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as import("node:net").AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        calls,
        aborted,
        state,
        routed: (route: string) => calls.filter((c: LegacyTestValue) => c.route === route),
        get maxConcurrent() {
          return maxConcurrent;
        },
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

/** The control plane's real accept rules, small enough to read in one sitting. */
function apply(call: LegacyTestValue, state: LegacyTestValue): LegacyTestValue {
  if (call.route === "open") {
    const text = JSON.stringify(call.body?.manifest ?? null);
    if (text !== state.manifests.at(-1)) {
      state.manifests.push(text);
      state.generation += 1;
    }
    return { accepted: true, open: true, manifest_generation: state.generation };
  }
  if (call.route === "entry") {
    const existing = state.entries.get(call.entry);
    if (existing && !existing.equals(call.raw)) {
      return { accepted: false, reason: "immutable", message: "already staged with different bytes" };
    }
    if (existing) return { accepted: true, duplicate: true, entry: call.entry, size: existing.length };
    state.entries.set(call.entry, call.raw);
    return { accepted: true, entry: call.entry, size: call.raw.length };
  }
  if (call.route === "trajectory") {
    const from = Number(call.body?.from_line);
    const lines: string[] = call.body?.lines ?? [];
    const count = state.lines.length;
    if (from > count) return { accepted: false, reason: "gap", message: "would leave a gap", lines: count };
    const overlap = count - from;
    const compare = Math.min(overlap, lines.length);
    for (let i = 0; i < compare; i++) {
      if (state.lines[from + i] !== lines[i]) {
        return { accepted: false, reason: "divergent", message: "resent lines do not match", lines: count };
      }
    }
    const suffix = lines.slice(overlap);
    state.lines.push(...suffix);
    return { accepted: true, lines: state.lines.length, appended: suffix.length };
  }
  return { accepted: false, reason: "shape", message: "unknown route" };
}

// ---------- run directories ----------

const envelope = (step: number, artifacts: LegacyTestValue = null) =>
  JSON.stringify({ step, action: { type: "click", ref: `e${step}` }, ...(artifacts ? { artifacts } : {}) });

const manifestFor = (runId: string, extra: LegacyTestValue = {}) =>
  JSON.stringify({ run_id: runId, mode: "record", result: { status: "interrupted" }, ...extra });

/** A run directory in the state the engine leaves it: artifacts, then lines. */
function makeRunDir(marker: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `live-${marker}-`));
  const runDir = path.join(root, "runs", "r-1");
  fs.mkdirSync(path.join(runDir, "steps"), { recursive: true });
  return {
    root,
    runDir,
    writeManifest: (extra: LegacyTestValue = {}) => fs.writeFileSync(path.join(runDir, "manifest.json"), manifestFor(marker, extra)),
    /**
     * Write the step's artifacts first, then append its envelope — the engine's
     * order. `screenshot: false` names an artifact the run dir does not have;
     * `bare: true` is a step with no artifacts at all (an API-driver step).
     */
    step: (n: number, { screenshot = true, bare = false, text = null }: LegacyTestValue = {}) => {
      const name = `steps/${String(n).padStart(3, "0")}.png`;
      if (screenshot && !bare) fs.writeFileSync(path.join(runDir, name), Buffer.from(`PNG-${marker}-${n}`));
      const line = text ?? envelope(n, bare ? null : { screenshot: name, har_entries: [n] });
      fs.appendFileSync(path.join(runDir, "trajectory.jsonl"), `${line}\n`);
      return name;
    },
    lines: () =>
      fs
        .readFileSync(path.join(runDir, "trajectory.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function uploaderFor(cp: LegacyTestValue, opts: LegacyTestValue = {}) {
  const api = new ApiClient(cp.base, "runner-token");
  return liveUploader(
    api,
    { groupId: "g1", runId: "run-1", runDbId: "db-1", live: opts.live ?? null, ...opts.wiring },
    { intervalMs: opts.intervalMs ?? TICK },
  );
}

async function until(pred: () => boolean, what: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- tests ----------

test("ships artifacts before the lines that name them, one request at a time, in run-dir order", async () => {
  const cp = await startControlPlane();
  const dir = makeRunDir("order");
  const live = uploaderFor(cp);
  try {
    dir.writeManifest();
    for (const n of [1, 2, 3]) dir.step(n);
    live.onEvent({ type: "case_start", runDir: dir.runDir, mode: "record" });

    await until(() => cp.state.lines.length === 3, "the three lines to land");
    assert.equal(cp.maxConcurrent, 1, "the queue is single-flight: nothing is ever in flight concurrently");

    const order = cp.calls.map((c: LegacyTestValue) => c.route + (c.entry ? `:${c.entry}` : ""));
    assert.deepEqual(
      order.slice(0, 5),
      ["open", "entry:steps/001.png", "entry:steps/002.png", "entry:steps/003.png", "trajectory"],
      "open, then every artifact, then the lines that name them",
    );
    assert.deepEqual(cp.state.lines, dir.lines(), "the staged lines are the run dir's own bytes, in order");
    assert.deepEqual([...cp.state.entries.keys()], ["steps/001.png", "steps/002.png", "steps/003.png"]);
    assert.deepEqual(cp.state.entries.get("steps/002.png"), Buffer.from("PNG-order-2"));

    // A later step joins the same queue on the next tick, without resending.
    dir.step(4);
    await until(() => cp.state.lines.length === 4, "the fourth line to land");
    const batches = cp.routed("trajectory");
    assert.equal(batches.at(-1).body.from_line, 3, "the delta starts where the last ack left off");
    assert.deepEqual(batches.at(-1).body.lines, [dir.lines()[3]]);
    assert.equal(live.state().sentLines, 4);
  } finally {
    await live.stop();
    dir.cleanup();
    await cp.close();
  }
});

test("a line whose artifact is not staged stays queued while the lines before it ship", async () => {
  const cp = await startControlPlane();
  const dir = makeRunDir("hold");
  const live = uploaderFor(cp);
  try {
    dir.writeManifest();
    dir.step(1);
    // The engine's invariant says this cannot happen; the queue still refuses to
    // advertise a file the platform does not have.
    dir.step(2, { screenshot: false });
    dir.step(3);
    live.onEvent({ type: "case_start", runDir: dir.runDir });

    await until(() => cp.state.lines.length === 1, "the first line to ship alone");
    await sleep(TICK * 5);
    assert.equal(cp.state.lines.length, 1, "lines 2 and 3 stay queued behind the missing artifact");
    assert.deepEqual([...cp.state.entries.keys()], ["steps/001.png"]);

    fs.writeFileSync(path.join(dir.runDir, "steps/002.png"), Buffer.from("PNG-hold-2"));
    await until(() => cp.state.lines.length === 3, "the queue to drain once the artifact exists");
    assert.deepEqual(cp.state.lines, dir.lines(), "and it drains in order, with nothing skipped");
  } finally {
    await live.stop();
    dir.cleanup();
    await cp.close();
  }
});

test("a transport failure pauses the queue and the next tick retries from the same position", async () => {
  let fail = true;
  const cp = await startControlPlane({
    hook: (call: LegacyTestValue) => {
      if (call.route === "entry" && call.entry === "steps/002.png" && fail) {
        fail = false;
        return { status: 500, body: { error: { code: "internal", message: "boom" } } };
      }
      return null;
    },
  });
  const dir = makeRunDir("retry");
  const live = uploaderFor(cp);
  try {
    dir.writeManifest();
    for (const n of [1, 2, 3]) dir.step(n);
    live.onEvent({ type: "case_start", runDir: dir.runDir });

    await until(() => cp.state.lines.length === 3, "the retry to land everything");
    const firstBatch = cp.routed("trajectory")[0];
    assert.equal(firstBatch.body.from_line, 0, "the retry resumes from exactly where the failure left the cursor");
    assert.deepEqual(cp.state.lines, dir.lines());
    assert.equal(live.state().stopped, false, "a 5xx is a pause, never a shutdown");
  } finally {
    await live.stop();
    dir.cleanup();
    await cp.close();
  }
});

test("an ack lost in transit is recovered by an identical resend the route deduplicates", async () => {
  let drop = true;
  const cp = await startControlPlane({
    hook: (call: LegacyTestValue) => {
      if (call.route === "trajectory" && drop) {
        drop = false;
        return { dropAfterApply: true };
      }
      return null;
    },
  });
  const dir = makeRunDir("lostack");
  const live = uploaderFor(cp);
  try {
    dir.writeManifest();
    for (const n of [1, 2]) dir.step(n);
    live.onEvent({ type: "case_start", runDir: dir.runDir });

    await until(() => live.state().sentLines === 2, "the uploader to resynchronize");
    const batches = cp.routed("trajectory");
    assert.equal(batches.length, 2, "the lost ack cost exactly one resend");
    assert.deepEqual(batches[0].body, batches[1].body, "the resend is byte-identical, so the route can verify it");
    assert.deepEqual(cp.state.lines, dir.lines(), "and the overlap is deduplicated, never doubled");
  } finally {
    await live.stop();
    dir.cleanup();
    await cp.close();
  }
});

test("a gap refusal rewinds the queue to the answered authoritative count", async () => {
  const cp = await startControlPlane();
  const dir = makeRunDir("gap");
  const live = uploaderFor(cp);
  try {
    dir.writeManifest();
    for (const n of [1, 2, 3]) dir.step(n);
    live.onEvent({ type: "case_start", runDir: dir.runDir });
    await until(() => live.state().sentLines === 3, "the first three lines");

    // Staging loses everything after line 1 (a reset the uploader cannot see).
    cp.state.lines.length = 1;
    dir.step(4);
    await until(() => cp.state.lines.length === 4, "the rewind to refill the ledger");

    const refusal = cp.routed("trajectory").find((c: LegacyTestValue) => c.body.from_line === 3 && c.index > 0);
    assert.ok(refusal, "the uploader asked from its own position first");
    const rewound = cp.routed("trajectory").filter((c: LegacyTestValue) => c.body.from_line === 1);
    assert.ok(rewound.length, "then resent from the count the refusal answered with");
    assert.deepEqual(cp.state.lines, dir.lines(), "and the ledger ends up byte-identical to the run dir");
  } finally {
    await live.stop();
    dir.cleanup();
    await cp.close();
  }
});

test("divergence resynchronizes once and then stops the uploader rather than looping", async () => {
  const cp = await startControlPlane({
    hook: (call: LegacyTestValue) =>
      call.route === "trajectory"
        ? { ack: { accepted: false, reason: "divergent", message: "does not match what is stored", lines: 1 } }
        : null,
  });
  const dir = makeRunDir("divergent");
  const live = uploaderFor(cp);
  try {
    dir.writeManifest();
    for (const n of [1, 2]) dir.step(n);
    live.onEvent({ type: "case_start", runDir: dir.runDir });

    await until(() => live.state().stopped, "the uploader to stop itself");
    assert.equal(live.state().reason, "divergent");
    const attempts = cp.routed("trajectory");
    assert.equal(attempts.length, 2, "exactly one resync attempt, then no more");
    assert.equal(attempts[0].body.from_line, 0);
    assert.equal(attempts[1].body.from_line, 1, "the resync started at the answered count");

    const before = cp.calls.length;
    dir.step(3);
    await sleep(TICK * 6);
    assert.equal(cp.calls.length, before, "a stopped uploader never speaks again");
  } finally {
    await live.stop();
    dir.cleanup();
    await cp.close();
  }
});

test("a budget refusal stops the uploader, and the case never notices", async () => {
  const cp = await startControlPlane({
    hook: (call: LegacyTestValue) =>
      call.route === "entry"
        ? { ack: { accepted: false, reason: "budget", message: "does not fit", used_bytes: 10, budget_bytes: 10 } }
        : null,
  });
  const dir = makeRunDir("budget");
  const live = uploaderFor(cp);
  try {
    dir.writeManifest();
    for (const n of [1, 2]) dir.step(n);
    live.onEvent({ type: "case_start", runDir: dir.runDir });

    await until(() => live.state().stopped, "the uploader to stop itself");
    assert.equal(live.state().reason, "budget");
    assert.equal(cp.state.lines.length, 0, "no line was ever shipped naming an artifact staging refused");

    const before = cp.calls.length;
    await sleep(TICK * 6);
    assert.equal(cp.calls.length, before, "and the tick loop is gone, not merely idle");
  } finally {
    await live.stop();
    dir.cleanup();
    await cp.close();
  }
});

test("a single line over the route's line cap stops streaming, with nothing truncated", async () => {
  const cp = await startControlPlane();
  const dir = makeRunDir("toolarge");
  const live = uploaderFor(cp, { live: { max_line_bytes: 512, max_body_bytes: 4096, max_batch_lines: 50 } });
  try {
    dir.writeManifest();
    dir.step(1);
    live.onEvent({ type: "case_start", runDir: dir.runDir });
    await until(() => cp.state.lines.length === 1, "the ordinary first line to ship");

    dir.step(2, { bare: true, text: JSON.stringify({ step: 2, blob: "x".repeat(2000) }) });
    dir.step(3, { bare: true });
    await until(() => live.state().stopped, "the uploader to stop on the oversized line");
    assert.equal(live.state().reason, "line_too_large");
    assert.deepEqual(cp.state.lines, [dir.lines()[0]], "what shipped shipped whole; no skip marker was invented");
  } finally {
    await live.stop();
    dir.cleanup();
    await cp.close();
  }
});

test("batches are sized from the caps the group spec advertises, not from a compiled-in constant", async () => {
  const cp = await startControlPlane();
  const dir = makeRunDir("caps");
  const live = uploaderFor(cp, { live: { max_batch_lines: 2 } });
  try {
    dir.writeManifest();
    for (const n of [1, 2, 3, 4, 5]) dir.step(n, { bare: true });
    live.onEvent({ type: "case_start", runDir: dir.runDir });

    await until(() => cp.state.lines.length === 5, "all five lines to land");
    const sizes = cp.routed("trajectory").map((c: LegacyTestValue) => c.body.lines.length);
    assert.ok(
      sizes.every((n: number) => n <= 2),
      `no batch exceeds the advertised line cap (saw ${JSON.stringify(sizes)})`,
    );
    assert.deepEqual(cp.state.lines, dir.lines());
  } finally {
    await live.stop();
    dir.cleanup();
    await cp.close();
  }
});

test("opening waits for manifest readiness, and a rewritten manifest re-opens with the new snapshot", async () => {
  const cp = await startControlPlane();
  const dir = makeRunDir("gating");
  const live = uploaderFor(cp);
  try {
    // `case_start` precedes the placeholder write, so the event alone opens nothing.
    live.onEvent({ type: "case_start", runDir: dir.runDir });
    await sleep(TICK * 6);
    assert.equal(cp.calls.length, 0, "no open call before the placeholder manifest exists");
    assert.equal(live.state().opened, false);

    dir.writeManifest();
    await until(() => cp.routed("open").length === 1, "the open call once the placeholder is readable");
    assert.equal(cp.routed("open")[0].body.manifest.run_id, "gating");

    dir.step(1);
    await until(() => cp.state.lines.length === 1, "the first line");

    // The finishing tail rewrites the manifest; `open` doubles as that route.
    dir.writeManifest({ result: { status: "pass" }, duration_ms: 4200 });
    await until(() => cp.routed("open").length === 2, "the manifest snapshot to be re-posted");
    assert.equal(cp.routed("open")[1].body.manifest.result.status, "pass");
    assert.equal(cp.state.generation, 2, "a changed snapshot bumps the generation exactly once");

    await sleep(TICK * 5);
    assert.equal(cp.routed("open").length, 2, "an unchanged manifest is never re-posted");
  } finally {
    await live.stop();
    dir.cleanup();
    await cp.close();
  }
});

test("container mode reads the run dir through the same translation the final result gets", async () => {
  const cp = await startControlPlane();
  const dir = makeRunDir("container");
  const workspaceRoot = dir.root;
  const live = uploaderFor(cp, { wiring: { workspaceRoot, containerRoot: "/ws" } });
  try {
    dir.writeManifest();
    dir.step(1);
    // What the child actually streams out of the container.
    live.onEvent({ type: "case_start", runDir: "/ws/runs/r-1" });

    await until(() => cp.state.lines.length === 1, "the translated run dir to be read");
    assert.equal(live.state().runDir, path.join(workspaceRoot, "runs/r-1"));
    assert.deepEqual(cp.state.entries.get("steps/001.png"), Buffer.from("PNG-container-1"));
    assert.deepEqual(cp.state.lines, dir.lines());
  } finally {
    await live.stop();
    dir.cleanup();
    await cp.close();
  }
});

test("stop() aborts the request in flight, leaves no timer behind, and never delays the report", async () => {
  const cp = await startControlPlane({
    hook: (call: LegacyTestValue) => (call.route === "trajectory" ? { hold: true } : null),
  });
  const dir = makeRunDir("shutdown");
  const live = uploaderFor(cp);
  try {
    dir.writeManifest();
    dir.step(1);
    live.onEvent({ type: "case_start", runDir: dir.runDir });
    await until(() => cp.routed("trajectory").length === 1, "the held request to arrive");

    const started = Date.now();
    await live.stop();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `stop() returned promptly instead of waiting out the held request (${elapsed}ms)`);
    await until(() => cp.aborted.length === 1, "the server to observe the in-flight request being aborted");
    assert.equal(live.state().stopped, true);

    // No timer survives: new work on disk provokes nothing at all.
    const before = cp.calls.length;
    dir.step(2);
    live.onEvent({ type: "step_result", step: 2 });
    await sleep(TICK * 8);
    assert.equal(cp.calls.length, before, "a stopped uploader schedules no further tick");
    await live.stop();
  } finally {
    dir.cleanup();
    await cp.close();
  }
});

test("a control plane without the live routes stops the uploader instead of retrying all case long", async () => {
  const cp = await startControlPlane({
    hook: () => ({ status: 404, body: { error: { code: "not_found", message: "no route" } } }),
  });
  const dir = makeRunDir("noroutes");
  const live = uploaderFor(cp);
  try {
    dir.writeManifest();
    dir.step(1);
    live.onEvent({ type: "case_start", runDir: dir.runDir });

    await until(() => live.state().stopped, "the uploader to give up on a deployment that has no live routes");
    assert.equal(live.state().reason, "http_404");
    const before = cp.calls.length;
    await sleep(TICK * 6);
    assert.equal(cp.calls.length, before);
  } finally {
    await live.stop();
    dir.cleanup();
    await cp.close();
  }
});

test("artifactRefs names only step artifacts, and apiPath keeps the advertised path but not its origin", () => {
  assert.deepEqual(
    artifactRefs(envelope(7, { screenshot: "steps/007.png", a11y: "steps/007.a11y.txt", har_entries: [12, 13] })),
    ["steps/007.png", "steps/007.a11y.txt"],
  );
  assert.deepEqual(artifactRefs(JSON.stringify({ artifacts: { video: "video.mp4", evil: "steps/../../etc/passwd" } })), []);
  assert.deepEqual(artifactRefs("not json at all"), [], "a line that is not an envelope names nothing and still ships");

  // The template's origin is the deployment's publicUrl, which is not
  // necessarily the origin this runner was pointed at; only the path survives.
  assert.equal(
    apiPath("https://playtest.example/api/v1/runner/runs/{run_db_id}/live/{entry}", { run_db_id: "db1", entry: "steps/001.png" }, "/fallback"),
    "/runner/runs/db1/live/steps/001.png",
  );
  assert.equal(apiPath(undefined, {}, "/fallback"), "/fallback", "a spec predating uploads.live falls back");
  assert.equal(apiPath("https://x/other/{run_id}", { run_id: "r" }, "/fallback"), "/fallback", "so does an unrecognizable path");
  assert.equal(apiPath("https://x/api/v1/a/{missing}", {}, "/fallback"), "/fallback", "so does an unfilled variable");
});
