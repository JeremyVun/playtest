// What the executor is allowed to say. Two boundaries, both of them text this
// runner did NOT write:
//
//   * a mobile session that would not start — wdio/Appium quote the build path,
//     the device and the endpoint they were given, core records that verbatim
//     as the run's infra cause (report error AND manifest result.error), and
//     the executor uploads all of it. Design gate 9 says no platform-managed
//     record carries a runner-resolved physical fact, so it is masked with
//     placeholders on the way out — of the report, and of the sealed bundle.
//   * a provider mint script that failed — its first line of stderr is the
//     customer's own code talking, and it was handed the grant's resolved
//     secrets. It travels as the claim's (or the dispatch's) error.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { claimGroupSessions, scrubManifestError, uploadBundle } from "../../src/exec-group.ts";
import { execMint } from "../../src/exec-mint.ts";
import { mobilePhysicalMasks } from "../../src/mobile.ts";
import { makeMasker, redactDeep, secretMasks } from "../../src/redact.ts";
import { BundleProvider } from "@playtest/core/artifacts";

/** The three facts a runner resolves for itself and the platform never sees. */
const APP = "/Users/ada/builds/gate9/TodoFixture.app";
const DEVICE = "iPhone Runner-Local 99";
const APPIUM = "http://127.0.0.1:4723";
const SECRET = "hunter2-super-secret";

const binding = { applicationKey: "todo-ios", ringKey: "local", platform: "ios", app: APP, device: DEVICE, backend: null };
const handle = { name: "bench-ios", url: APPIUM, credentialEnv: {}, died: () => null, close: async () => {} };

/** The redactor exec-group composes for a mobile group. */
const mobileRedactor = () =>
  makeMasker([...secretMasks([SECRET]), ...mobilePhysicalMasks(binding as never, handle as never)]);

/** A real wdio session-boundary failure, in the shape it arrives in. */
const WDIO_ERROR =
  `WebDriverError: Failed to create session. Bad app: ${APP}. ` +
  `Cannot launch "${DEVICE}": connect ECONNREFUSED 127.0.0.1:4723 (${APPIUM}/session)`;

function freshDir(name: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pt-redaction-${name}-`));
}

function assertClean(where: string, text: string) {
  for (const needle of [APP, path.dirname(APP), path.basename(APP), DEVICE, APPIUM, "127.0.0.1:4723"]) {
    assert.equal(text.includes(needle), false, `${where} carries the runner-resolved "${needle}": ${text}`);
  }
}

test("a session-boundary failure reaches the platform with no path, device or endpoint", () => {
  const redactor = mobileRedactor();
  // The report the executor builds around a failed case: core's own error line,
  // the manifest it wrote (whose result.error carries the same words), and the
  // fields that must survive untouched.
  const report = {
    status: "infra",
    error: redactor(WDIO_ERROR),
    manifest: {
      run_id: "run_01",
      pins: { driver: "mobile", settle: "settle-mobile-v1", snapshot_format: "ax-tree-v7" },
      env: { base_url: null, driver: "mobile" },
      result: { status: "infra", end_reason: "infra", error: WDIO_ERROR, gate: { pass: false, checks: [] } },
      totals: { steps: 0 },
    },
    score: null,
    bundle: { key: "runs/run_01.ptrun", sha256: "abc" },
  };

  const posted = redactDeep(report, redactor);
  assertClean("the posted report", JSON.stringify(posted));
  // Redaction is not amnesia: the reader still learns WHAT kind of fact was
  // removed and everything the engine said about the failure.
  assert.match(posted.error, /Failed to create session\. Bad app: <path>\./);
  assert.match(posted.error, /Cannot launch "<device>": connect ECONNREFUSED <endpoint>/);
  assert.equal(posted.manifest.result.error, posted.error, "the manifest carries the same scrubbed cause");
  assert.equal(posted.manifest.result.status, "infra");
  assert.deepEqual(posted.manifest.pins, report.manifest.pins, "comparability pins are untouched");
  assert.equal(posted.bundle.key, "runs/run_01.ptrun");
  assert.equal(posted.status, "infra");

  // A ring secret in the same text keeps the secret mask, not a placeholder.
  assert.equal(redactor(`token=${SECRET} app=${APP}`), "token=[redacted] app=<path>");
});

test("the sealed bundle's manifest is scrubbed before the runner zips it", async () => {
  const runDir = freshDir("bundle");
  try {
    const manifest = {
      run_id: "run_01",
      pins: { driver: "mobile" },
      result: { status: "infra", end_reason: "infra", error: WDIO_ERROR, gate: { pass: false, checks: [] } },
    };
    fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    fs.writeFileSync(path.join(runDir, "trajectory.jsonl"), "");

    let uploaded: Buffer | null = null;
    const api = {
      putBytes: async (p: string, bytes: Buffer) => {
        assert.equal(p, "/runner/runs/db_1/bundle");
        uploaded = bytes;
        return { artifact: { key: "runs/run_01.ptrun" } };
      },
    };
    const res = await uploadBundle(api, "db_1", runDir, mobileRedactor());
    assert.equal(res.artifact.key, "runs/run_01.ptrun");

    // On this machine's disk first — the zip is sealed from it…
    const onDisk = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
    assertClean("the run directory's manifest.json", JSON.stringify(onDisk));
    assert.deepEqual(onDisk.pins, manifest.pins, "nothing but the infra cause is rewritten");

    // …and inside the bundle the platform actually stores and serves.
    const bundleFile = path.join(runDir, "uploaded.ptrun");
    fs.writeFileSync(bundleFile, uploaded!);
    const sealed = BundleProvider.fromFile(bundleFile).readText("manifest.json");
    assert.ok(sealed, "the bundle carries a manifest");
    assertClean("the sealed bundle's manifest.json", sealed!);
    assert.match(JSON.parse(sealed!).result.error, /Bad app: <path>\./);
  } finally {
    await fsp.rm(runDir, { recursive: true, force: true });
  }
});

test("scrubManifestError leaves a manifest with nothing to scrub byte-for-byte alone", () => {
  const runDir = freshDir("noop");
  try {
    const file = path.join(runDir, "manifest.json");
    const bytes = JSON.stringify({ result: { status: "pass", error: null } }, null, 2) + "\n";
    fs.writeFileSync(file, bytes);
    scrubManifestError(runDir, mobileRedactor());
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    // A run directory that never existed is not an error: a case can fail
    // before core writes anything.
    scrubManifestError(path.join(runDir, "missing"), mobileRedactor());
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------- mints

/** A provider script that fails the way scripts do: by printing what it was given. */
const LEAKY_SCRIPT = `process.stderr.write("login failed: POST /token rejected api_key=" + process.env.TOKEN + "\\n"); process.exit(1);`;

test("a failed mint's fulfill error carries no value the grant handed the script", async () => {
  const workDir = freshDir("mint");
  const posts: RunnerDynamic[] = [];
  try {
    const mint = {
      claim_id: "claim-leaky",
      provider: "sso",
      identity: "member",
      code: LEAKY_SCRIPT,
      env: { TOKEN: SECRET },
      timeout_s: 20,
    };
    const api = {
      json: async (method: string, p: string, body: RunnerDynamic) => {
        posts.push({ method, path: p, body });
        if (p === "/runner/sessions/claim") return { sessions: { "sso/member": { pending: true, mint } } };
        if (p === `/runner/sessions/${mint.claim_id}/fulfill`) return { session: null };
        throw new Error(`unexpected request ${method} ${p}`);
      },
    };
    const out = await claimGroupSessions(api, { sessions: { needed: ["sso/member"] } }, { isolation: "process", workDir });

    const fulfill = posts.find((p) => p.path.endsWith("/fulfill"));
    assert.ok(fulfill, "the claim is released with its error so another executor can take over");
    assert.equal(fulfill.body.error.includes(SECRET), false, `the mint error leaked a secret: ${fulfill.body.error}`);
    assert.match(fulfill.body.error, /login failed: POST \/token rejected api_key=\[redacted\]/);
    // The same words the case report gets, so a run page and a claim agree.
    assert.equal(out.failed["sso/member"], fulfill.body.error);
    assert.deepEqual(out.sessions, {});
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});

test("a standalone mint dispatch reports its failure with the grant's secrets masked", async () => {
  const workDir = freshDir("execmint");
  const completes: RunnerDynamic[] = [];
  const grant = {
    claim_id: "claim-standalone",
    provider: "sso",
    identity: "admin",
    code: LEAKY_SCRIPT,
    env: { TOKEN: SECRET },
    timeout_s: 20,
  };
  const server = http.createServer((req: RunnerDynamic, res: RunnerDynamic) => {
    let raw = "";
    req.on("data", (c: RunnerDynamic) => (raw += c));
    req.on("end", () => {
      const reply = (body: RunnerDynamic) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/api/v1/runner/exchange") return reply({ token: "group-token" });
      if (req.url === `/api/v1/runner/mints/${grant.claim_id}`) return reply(grant);
      if (req.url === `/api/v1/runner/mints/${grant.claim_id}/complete`) {
        completes.push(JSON.parse(raw || "{}"));
        return reply({});
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no route ${req.url}` } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as RunnerDynamic;
  try {
    const out = await execMint({
      server: `http://127.0.0.1:${port}`,
      credential: "ptr_test",
      dispatchId: "d1",
      claim: grant.claim_id,
      isolation: "process",
      workDir,
    });
    assert.equal(out.exitCode, 1);
    assert.equal(completes.length, 1);
    const error = completes[0].error;
    assert.equal(error.includes(SECRET), false, `the dispatch error leaked a secret: ${error}`);
    assert.match(error, /login failed: POST \/token rejected api_key=\[redacted\]/);
    assert.equal(out.error, error, "the runner says the same thing to itself");
  } finally {
    await new Promise((r) => server.close(r));
    await fsp.rm(workDir, { recursive: true, force: true });
  }
});
