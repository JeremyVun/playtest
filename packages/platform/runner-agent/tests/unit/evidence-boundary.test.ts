// The PLATFORM EVIDENCE BOUNDARY: every textual byte this runner sends to the
// control plane, on both routes that carry run bytes — the sealed `.ptrun`
// bundle and the live staging stream.
//
// The needles are seeded into a real run directory the way a real run would
// leave them: an infra cause in the manifest, engine events, trajectory
// envelopes, a11y text, a grade, a HAR. Two of the entries are binary and carry
// the same bytes, because "sanitize the text" must not mean "rewrite a
// screenshot".
//
// Three properties are asserted together, because any one of them alone is a
// leak or a divergence:
//
//   1. no seeded physical fact or secret leaf value appears in ANY textual
//      entry the platform receives;
//   2. the local raw run directory is byte-for-byte unchanged — the runner's
//      own disk stays the answer to "what did it actually dial";
//   3. the live-staged trajectory lines are byte-identical to the sealed
//      bundle's, because the platform verifies one against the other.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ApiClient } from "../../src/api-client.ts";
import { platformEvidence } from "../../src/evidence.ts";
import { uploadBundle } from "../../src/exec-group.ts";
import { liveUploader } from "../../src/live-uploader.ts";
import { mobilePhysicalMasks } from "../../src/mobile.ts";
import { collectSecretValues, makeMasker, makeRedactor, secretMasks } from "../../src/redact.ts";
import { BundleProvider } from "@playtest/core/artifacts";

// ---------- what must never cross ----------

/** The three facts a mobile runner resolves for itself (design gate 9). */
const APP = "/Users/ada/builds/gate9/TodoFixture.app";
const DEVICE = "iPhone Runner-Local 99";
const APPIUM = "http://127.0.0.1:4723";

/** A ring's resolved secret: the ordinary case. */
const RING_SECRET = "hunter2-super-secret";
/** A session cookie value shorter than any "useful needle" heuristic. */
const SHORT_SECRET = "s3c";
/** A session cookie value that only ever appears JSON-escaped in a document. */
const QUOTED_SECRET = 'quo"te\\slash';
/** A token nested two levels down inside the storage state's origins. */
const NESTED_SECRET = "nested-origin-token-9";

const binding = { applicationKey: "todo-ios", ringKey: "local", platform: "ios", app: APP, device: DEVICE, backend: null };
const handle = { name: "bench-ios", url: APPIUM, credentialEnv: {}, died: () => null, close: async () => {} };

/** The group spec and session claims the executor composes its needles from. */
const spec = { ring: { key: "local", resolved_secrets: { API_KEY: RING_SECRET } } };
const sessions = {
  "sso/member": {
    storage_state: {
      cookies: [
        { name: "sid", value: SHORT_SECRET, domain: "app.example.com", path: "/", httpOnly: true },
        { name: "csrf", value: QUOTED_SECRET, domain: "app.example.com", path: "/" },
      ],
      origins: [
        {
          origin: "https://app.example.com",
          localStorage: [{ name: "access_token", value: NESTED_SECRET }],
        },
      ],
    },
  },
};

/** Exactly the redactor `execGroup` composes for a mobile group with sessions. */
const executorRedactor = () =>
  makeMasker([
    ...secretMasks(collectSecretValues(spec, sessions)),
    ...mobilePhysicalMasks(binding as never, handle as never),
  ]);

/**
 * Every needle, named. A failure names the ENTRY and the KIND of value it
 * carried; repeating the secret in an assertion message would put it in CI logs,
 * which is the same boundary this file exists to defend.
 */
const NEEDLES: Array<{ label: string; value: string }> = [
  { label: "the mobile build path", value: APP },
  { label: "the build directory", value: path.dirname(APP) },
  { label: "the build filename", value: path.basename(APP) },
  { label: "the device name", value: DEVICE },
  { label: "the Appium endpoint", value: APPIUM },
  { label: "the Appium host:port", value: "127.0.0.1:4723" },
  { label: "a ring resolved secret", value: RING_SECRET },
  { label: "a short session cookie value", value: SHORT_SECRET },
  { label: "a quoted session cookie value", value: QUOTED_SECRET },
  { label: "a nested session token", value: NESTED_SECRET },
];

function assertNoLeak(where: string, text: string): void {
  for (const { label, value } of NEEDLES) {
    assert.equal(text.includes(value), false, `${where} carries ${label}`);
    // The same value as it appears inside a JSON document.
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) assert.equal(text.includes(escaped), false, `${where} carries ${label}, JSON-escaped`);
  }
}

// ---------- the run directory a case leaves behind ----------

/** Entries the artifact vocabulary calls text; everything else is bytes. */
const TEXTUAL = /\.(json|jsonl|txt|vtt|mhtml)$/;

const WDIO_ERROR =
  `WebDriverError: Failed to create session. Bad app: ${APP}. ` +
  `Cannot launch "${DEVICE}": connect ECONNREFUSED 127.0.0.1:4723 (${APPIUM}/session)`;

/**
 * A run directory in the shape core leaves one, with a seeded needle in every
 * textual artifact and in the bytes of the binary ones.
 */
function seedRunDir(marker: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pt-evidence-${marker}-`));
  const runDir = path.join(root, "runs", "r-1");
  fs.mkdirSync(path.join(runDir, "steps"), { recursive: true });
  const write = (rel: string, data: string | Buffer) => fs.writeFileSync(path.join(runDir, rel), data);

  write(
    "manifest.json",
    JSON.stringify(
      {
        run_id: "2026-07-29T1200-ab12",
        pins: { driver: "mobile", settle: "settle-mobile-v1", snapshot_format: "ax-tree-v7" },
        env: { env_name: "local", base_url: null, driver: "mobile" },
        result: { status: "infra", end_reason: "infra", error: WDIO_ERROR, gate: { pass: false, checks: [] } },
        totals: { steps: 3 },
      },
      null,
      2,
    ) + "\n",
  );
  // Three envelopes: a raw secret, a JSON-escaped one, and a step naming the
  // artifacts that follow it.
  const lines = [
    { step: 1, action: { type: "fill", ref: "e1" }, detail: `Authorization: Bearer ${RING_SECRET}` },
    { step: 2, action: { type: "fill", ref: "e2" }, detail: `csrf=${QUOTED_SECRET} sid=${SHORT_SECRET}` },
    {
      step: 3,
      action: { type: "click", ref: "e3" },
      detail: `launched ${APP} on ${DEVICE}`,
      artifacts: { screenshot: "steps/003.png", a11y: "steps/003.a11y.txt" },
    },
  ];
  write("trajectory.jsonl", lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  write(
    "events.jsonl",
    [
      JSON.stringify({ type: "case_start", runDir: `${APP}/../runs`, env: { API_KEY: RING_SECRET } }),
      JSON.stringify({ type: "driver_error", message: WDIO_ERROR }),
      JSON.stringify({ type: "step_result", note: `sid=${SHORT_SECRET}` }),
    ].join("\n") + "\n",
  );
  write(
    "context.jsonl",
    JSON.stringify({ role: "user", content: `storage: ${JSON.stringify(sessions["sso/member"].storage_state)}` }) + "\n",
  );
  write(
    "grade.json",
    JSON.stringify({ score: 0, summary: `the app at ${APP} never started`, findings: [{ severity: "major", note: `token ${NESTED_SECRET} rejected` }] }, null, 2) + "\n",
  );
  write(
    "har.json",
    JSON.stringify({
      log: {
        entries: [
          {
            request: { url: "https://app.example.com/login", headers: [{ name: "authorization", value: `Bearer ${RING_SECRET}` }] },
            response: { status: 401, content: { text: `{"error":"bad ${QUOTED_SECRET}"}` } },
          },
        ],
      },
    }) + "\n",
  );
  write("final.a11y.txt", `dialog "could not reach ${APPIUM}"\ntoken ${NESTED_SECRET}\n`);
  write("video.vtt", `WEBVTT\n\n00:00.000 --> 00:01.000\n${DEVICE}\n`);
  write("steps/003.a11y.txt", `button "sign in" [${SHORT_SECRET}]\nhint ${NESTED_SECRET}\n`);
  // Binary: the same needle bytes, which must survive untouched.
  write("steps/003.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.from(RING_SECRET), Buffer.from([0x00, 0xff])]));
  write("video.mp4", Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from(DEVICE), Buffer.from([0x00])]));

  return { root, runDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Every file under a directory, by run-relative path. */
function snapshotDir(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string, prefix = "") => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
      else out.set(rel, fs.readFileSync(path.join(dir, ent.name)));
    }
  };
  walk(root);
  return out;
}

// ---------- a control plane that records what it was sent ----------

/** Accepts everything and keeps the bytes; the ack vocabulary lives next door. */
function startStaging() {
  const state = {
    manifests: [] as RunnerDynamic[],
    entries: new Map<string, Buffer>(),
    lines: [] as string[],
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const url = String(req.url);
      let ack: RunnerDynamic = { accepted: true };
      if (url.endsWith("/open")) {
        state.manifests.push(JSON.parse(raw.toString("utf8")).manifest);
        ack = { accepted: true, open: true, manifest_generation: state.manifests.length };
      } else if (url.endsWith("/live/trajectory")) {
        const body = JSON.parse(raw.toString("utf8"));
        state.lines.push(...body.lines.slice(state.lines.length - body.from_line));
        ack = { accepted: true, lines: state.lines.length };
      } else if (url.includes("/live/")) {
        const entry = url.slice(url.indexOf("/live/") + "/live/".length);
        state.entries.set(entry, raw);
        ack = { accepted: true, entry, size: raw.length };
      }
      const text = JSON.stringify(ack);
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    });
  });
  return new Promise<RunnerDynamic>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as import("node:net").AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        state,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

async function until(pred: () => boolean, what: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** The bundle the fake platform received, opened for reading. */
function openBundle(dir: string, bytes: Buffer): BundleProvider {
  const file = path.join(dir, "received.ptrun");
  fs.writeFileSync(file, bytes);
  return BundleProvider.fromFile(file);
}

/** One bundle entry's bytes, however it was compressed. */
async function entryBytes(bundle: BundleProvider, name: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of bundle.createReadStream(name)) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

// ---------- needles ----------

test("session storage state contributes its leaf VALUES, at any length or nesting", () => {
  const redact = makeRedactor(collectSecretValues(spec, sessions));

  for (const { label, value } of [
    { label: "the ring secret", value: RING_SECRET },
    { label: "a three-character cookie value", value: SHORT_SECRET },
    { label: "a cookie value holding a quote and a backslash", value: QUOTED_SECRET },
    { label: "a token nested inside origins[].localStorage[]", value: NESTED_SECRET },
  ]) {
    assert.equal(redact(`before ${value} after`).includes(value), false, `${label} is not masked`);
    assert.match(redact(`before ${value} after`), /before \[redacted\] after/, `${label} masked in place`);
  }

  // Repeated occurrences, and the whole document — the shape a mint script or a
  // context line actually carries.
  assert.equal(redact(`${RING_SECRET} ${RING_SECRET}`), "[redacted] [redacted]");
  const doc = JSON.stringify({ session: sessions["sso/member"].storage_state, again: NESTED_SECRET });
  assertNoLeak("the serialized storage state", redact(doc));
  // …and it is still a JSON document afterwards, with its structure intact.
  const parsed = JSON.parse(redact(doc));
  assert.equal(parsed.session.cookies[0].value, "[redacted]");
  assert.equal(parsed.session.cookies[1].value, "[redacted]");
  assert.equal(parsed.session.origins[0].localStorage[0].value, "[redacted]");

  // Redaction is not amnesia: what a value was FOR is not a secret, and masking
  // it would shred unrelated text.
  assert.equal(parsed.session.cookies[0].name, "sid");
  assert.equal(parsed.session.cookies[0].domain, "app.example.com");
  assert.equal(parsed.session.origins[0].origin, "https://app.example.com");
  assert.equal(parsed.session.origins[0].localStorage[0].name, "access_token");
});

test("classification is what an entry IS, and an unnamed one is decided by its own bytes", () => {
  const evidence = platformEvidence(executorRedactor());
  const text = Buffer.from(`hint ${NESTED_SECRET}\n`);
  const bytes = Buffer.concat([Buffer.from(NESTED_SECRET), Buffer.from([0x00, 0xff])]);

  // `steps/` holds both kinds; only the entry itself decides which.
  assert.equal(evidence.isTextual("steps/003.a11y.txt", text), true);
  assert.equal(evidence.isTextual("steps/003.png", bytes), false);
  assert.deepEqual(evidence.entry("steps/003.png", bytes), bytes, "a screenshot crosses byte-for-byte");

  // An entry the run vocabulary does not name: text is still sanitized, because
  // an unrecognized text artifact is exactly where a value would hide.
  assertNoLeak("an unnamed textual entry", evidence.entry("driver.log", text).toString("utf8"));
  assert.deepEqual(evidence.entry("driver.bin", bytes), bytes, "an unnamed payload is left alone");

  // Nothing to mask means the caller's own bytes, so an unaffected entry is
  // byte-identical and the seal is reproducible.
  const clean = Buffer.from("nothing to see here\n");
  assert.equal(evidence.entry("events.jsonl", clean), clean);
});

// ---------- the sealed bundle ----------

test("no seeded fact or secret reaches the sealed bundle, and the raw run dir is untouched", async () => {
  const dir = seedRunDir("bundle");
  try {
    const before = snapshotDir(dir.runDir);
    let uploaded: Buffer | null = null;
    const api = {
      putBytes: async (p: string, bytes: Buffer) => {
        assert.equal(p, "/runner/runs/db_1/bundle");
        uploaded = bytes;
        return { artifact: { key: "runs/r-1.ptrun", sha256: "x" } };
      },
    };
    await uploadBundle(api, "db_1", dir.runDir, executorRedactor());
    assert.ok(uploaded, "the bundle was uploaded");

    const bundle = openBundle(dir.root, uploaded!);
    const ptrun = JSON.parse(bundle.readText("ptrun.json")!);
    const names = Object.keys(bundle.entries).filter((n) => n !== "ptrun.json");
    assert.ok(names.includes("events.jsonl") && names.includes("steps/003.a11y.txt"), "the whole run dir is sealed");

    for (const name of names) {
      if (TEXTUAL.test(name)) {
        const text = bundle.readText(name);
        assert.ok(text != null, `${name} is readable`);
        assertNoLeak(`the sealed bundle's ${name}`, text!);
      } else {
        // Binary payloads are byte-identical: classification is what a run
        // artifact IS, not where it lives — `steps/` holds both.
        const raw = fs.readFileSync(path.join(dir.runDir, name));
        assert.deepEqual(await entryBytes(bundle, name), raw, `${name} was rewritten`);
      }
    }

    // The metadata describes the bytes actually sent, not the bytes on disk.
    for (const entry of ptrun.entries) {
      assert.equal(entry.size, bundle.stat(entry.path)!.size, `ptrun.json's size for ${entry.path} is stale`);
    }
    assert.equal(ptrun.totals.count, names.length);

    // Local raw diagnostics stay local, and stay exactly as core wrote them.
    const after = snapshotDir(dir.runDir);
    for (const [rel, bytes] of before) {
      assert.deepEqual(after.get(rel), bytes, `the runner's own ${rel} was mutated on the way out`);
    }
    assert.match(fs.readFileSync(path.join(dir.runDir, "manifest.json"), "utf8"), /TodoFixture\.app/);
  } finally {
    dir.cleanup();
  }
});

// ---------- live staging, and its agreement with the seal ----------

test("live staging sends the same sanitized bytes the seal will carry", async () => {
  const cp = await startStaging();
  const dir = seedRunDir("live");
  const api = new ApiClient(cp.base, "runner-token");
  const live = liveUploader(
    api,
    { groupId: "g1", runId: "r-1", runDbId: "db-1", live: null, redact: executorRedactor() },
    { intervalMs: 10 },
  );
  try {
    const before = snapshotDir(dir.runDir);
    live.onEvent({ type: "case_start", runDir: dir.runDir });
    await until(() => cp.state.lines.length === 3 && cp.state.entries.size === 2, "the whole case to stage");
    await live.stop();

    assertNoLeak("the staged manifest", JSON.stringify(cp.state.manifests));
    cp.state.lines.forEach((line: string, i: number) => assertNoLeak(`staged trajectory line ${i}`, line));
    for (const [entry, bytes] of cp.state.entries) {
      if (TEXTUAL.test(entry)) assertNoLeak(`the staged entry ${entry}`, bytes.toString("utf8"));
      else assert.deepEqual(bytes, fs.readFileSync(path.join(dir.runDir, entry)), `${entry} was rewritten in flight`);
    }

    // Nothing the uploader did touched the recording.
    const after = snapshotDir(dir.runDir);
    for (const [rel, bytes] of before) assert.deepEqual(after.get(rel), bytes, `live staging mutated ${rel}`);

    // The seal follows. The platform verifies staged lines against the bundle's,
    // so the two must be the same bytes — one sanitizer, deterministic masks.
    let uploaded: Buffer | null = null;
    await uploadBundle(
      { putBytes: async (_p: string, bytes: Buffer) => ((uploaded = bytes), { artifact: { key: "k" } }) },
      "db-1",
      dir.runDir,
      executorRedactor(),
    );
    const bundle = openBundle(dir.root, uploaded!);
    const sealed = bundle.readText("trajectory.jsonl")!.split("\n").filter(Boolean);
    assert.deepEqual(cp.state.lines, sealed, "the live-staged lines and the sealed trajectory diverge");
    assert.deepEqual(
      cp.state.entries.get("steps/003.a11y.txt")!.toString("utf8"),
      bundle.readText("steps/003.a11y.txt"),
      "a staged textual entry and its sealed twin diverge",
    );
  } finally {
    await live.stop();
    dir.cleanup();
    await cp.close();
  }
});
