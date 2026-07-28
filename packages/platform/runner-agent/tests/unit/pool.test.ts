// The long-lived self-hosted runner's loop, argument handling, and the two
// things a person only ever notices when they are wrong — the startup banner
// and the message a refused credential produces.
//
// The board is a loopback stub here (the real claim board has its own
// control-plane suite, and the two meet for real in the control plane's
// pool-agent integration test); the executor is injected, so these tests pin
// what the LOOP does: pick a claimable offer off the page, skip the ones it
// cannot take, resume, cancel, back off, refuse.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { runPool, parsePoolArgs, backoffDelayMs, startupLines, resolveCredential, defaultCompatibility } from "../../src/pool.ts";

const CREDENTIAL = "ptr_test-credential";

/** A stub claim board: `answers` are served in order to successive polls. */
async function board(answers: LegacyTestValue[], { claimStatus = 200, heartbeat = () => ({ ok: true, canceled: false }) }: LegacyTestValue = {}) {
  const requests: LegacyTestValue[] = [];
  let polls = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://127.0.0.1");
      requests.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization });
      const reply = (status: LegacyTestValue, body: LegacyTestValue) => {
        const data = JSON.stringify(body);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
        res.end(data);
      };
      if (url.pathname.endsWith("/heartbeat")) return reply(200, heartbeat());
      if (url.pathname === "/api/v1/runner/pool/claims") {
        const answer = answers[Math.min(polls++, answers.length - 1)];
        if (answer.status) return reply(answer.status, answer.body);
        return reply(200, { runner: { id: "rn1", name: "adas-laptop", labels: ["macos"], project_key: "acme" }, offers: [], current: null, ...answer });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/v1/runner/pool/claims/")) {
        if (claimStatus !== 200) return reply(claimStatus, { error: { code: "conflict", message: "already claimed by another runner" } });
        return reply(200, { claimed: true, heartbeat_interval_s: 1 });
      }
      reply(404, { error: { message: `no route ${req.method} ${url.pathname}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as import("node:net").AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

const options = (server: string, extra: LegacyTestValue = {}) => ({
  server,
  labels: ["macos"],
  isolation: "process",
  workDir: path.join(os.tmpdir(), "pool-test"),
  credential: CREDENTIAL,
  pollWaitS: 1,
  ...extra,
});

/** One web-application group offer, the shape the board serves. */
const offer = (over: LegacyTestValue = {}) => ({
  dispatch_id: "d1",
  kind: "group",
  ref_id: "g1",
  run_group_id: "g1",
  mint_claim_id: null,
  labels: ["macos"],
  project_id: "p1",
  project_key: "acme",
  target: { application_id: "a1", application_key: "todo-web", ring_id: "r1", ring_key: "local", driver: "web", platform: null, base_url: "http://127.0.0.1:4173" },
  ...over,
});

const groupOffer = { offers: [offer()] };

test("pool: an offered group is claimed, executed through the group executor, and the loop goes back to the board", async () => {
  const stub = await board([groupOffer]);
  const calls: LegacyTestValue[] = [];
  const lines: string[] = [];
  try {
    const result = await runPool(options(stub.url), {
      execGroupImpl: async (opts: LegacyTestValue) => { calls.push(opts); return { exitCode: 0 }; },
      log: (line) => lines.push(line),
      maxIterations: 1,
    });
    assert.equal(result.executed, 1);
  } finally {
    await stub.close();
  }
  // The executor is entered exactly as a dispatched job would be — plus the
  // credential, which is what the exchange presents for a claimed dispatch.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].group, "g1");
  assert.equal(calls[0].dispatchId, "d1");
  assert.equal(calls[0].credential, CREDENTIAL);
  assert.equal(calls[0].isolation, "process", "the runner reports its real isolation");
  assert.ok(calls[0].signal, "the group is given a cancel channel the heartbeat can pull");

  // Every request is this process dialling out, carrying the credential.
  assert.ok(stub.requests.every((r: LegacyTestValue) => r.auth === `Bearer ${CREDENTIAL}`));
  const claimed = stub.requests.find((r: LegacyTestValue) => r.method === "POST" && r.path === "/api/v1/runner/pool/claims/d1");
  assert.ok(claimed, `the offer was claimed: ${JSON.stringify(stub.requests)}`);
  assert.match(stub.requests[0].query, /labels=macos/, "the check-in advertises what this runner runs");

  const output = lines.join("\n");
  assert.match(output, /Playtest runner "adas-laptop" — project acme/);
  assert.match(output, /claimed run group g1/);
  assert.match(output, /waiting for work/);
});

test("pool: a runner restarted mid-group resumes the claim it still holds instead of taking new work", async () => {
  const stub = await board([{ current: offer({ dispatch_id: "d9", ref_id: "g9", run_group_id: "g9", labels: [] }) }]);
  const calls: LegacyTestValue[] = [];
  const lines: string[] = [];
  try {
    await runPool(options(stub.url), {
      execGroupImpl: async (opts: LegacyTestValue) => { calls.push(opts); return { exitCode: 0 }; },
      log: (line) => lines.push(line),
      maxIterations: 1,
    });
  } finally {
    await stub.close();
  }
  assert.equal(calls[0].group, "g9");
  assert.equal(stub.requests.some((r: LegacyTestValue) => r.method === "POST" && r.path.startsWith("/api/v1/runner/pool/claims/")), false,
    "a claim it already holds is resumed, not re-claimed");
  assert.match(lines.join("\n"), /resuming run group g9/);
});

test("pool: a mint claim runs the mint path on the same board", async () => {
  const stub = await board([{ offers: [offer({ dispatch_id: "d2", kind: "mint", ref_id: "m1", run_group_id: null, mint_claim_id: "m1", labels: [], target: null })] }]);
  const mints: LegacyTestValue[] = [];
  try {
    await runPool(options(stub.url), {
      execGroupImpl: async () => assert.fail("a mint claim must not run the group executor"),
      execMintImpl: async (opts: LegacyTestValue) => { mints.push(opts); return { exitCode: 0 }; },
      log: () => {},
      maxIterations: 1,
    });
  } finally {
    await stub.close();
  }
  assert.equal(mints[0].claim, "m1");
  assert.equal(mints[0].credential, CREDENTIAL);
});

test("pool: the first offer this runner can execute is claimed, the rest of the page is left alone", async () => {
  const mobile = offer({ dispatch_id: "d-ios", ref_id: "g-ios", run_group_id: "g-ios", target: { application_id: "a2", application_key: "todo-ios", ring_id: "r2", ring_key: "local", driver: "mobile", platform: "ios", base_url: null } });
  const stub = await board([{ offers: [mobile, offer()] }]);
  const calls: LegacyTestValue[] = [];
  const lines: string[] = [];
  try {
    await runPool(options(stub.url), {
      execGroupImpl: async (opts: LegacyTestValue) => { calls.push(opts); return { exitCode: 0 }; },
      log: (line) => lines.push(line),
      maxIterations: 1,
    });
  } finally {
    await stub.close();
  }
  // Head-of-line blocking is what the page exists to prevent: an offer this
  // machine has no binding for must not starve the newer one behind it.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].group, "g1");
  const claimed = stub.requests.filter((r: LegacyTestValue) => r.method === "POST" && r.path.startsWith("/api/v1/runner/pool/claims/"));
  assert.deepEqual(claimed.map((r: LegacyTestValue) => r.path), ["/api/v1/runner/pool/claims/d1"],
    "the incompatible offer is never claimed and never reported");
  assert.match(lines.join("\n"), /skipping run group g-ios: this runner has no configuration binding for the mobile target "todo-ios\/local"/);
});

test("pool: an all-incompatible page is skipped by id on the next poll, and the reason is said once", async () => {
  const mobile = { ...offer().target, application_key: "ios-a", driver: "mobile", platform: "ios", base_url: null };
  const a = offer({ dispatch_id: "d-a", ref_id: "g-a", run_group_id: "g-a", target: mobile });
  const b = offer({ dispatch_id: "d-b", ref_id: "g-b", run_group_id: "g-b", target: mobile });
  // Two polls see the same unclaimable pair; the third comes back empty, which
  // is what the server's hold produces once the skips exclude everything.
  const stub = await board([{ offers: [a, b] }, { offers: [a, b] }, { offers: [] }]);
  const lines: string[] = [];
  try {
    await runPool(options(stub.url), {
      execGroupImpl: async () => assert.fail("nothing on this board is executable here"),
      log: (line) => lines.push(line),
      sleep: async () => {},
      maxPolls: 4,
    });
  } finally {
    await stub.close();
  }
  const polls = stub.requests.filter((r: LegacyTestValue) => r.path === "/api/v1/runner/pool/claims");
  assert.equal(polls.length, 4);
  assert.equal(polls[0].query.includes("skip="), false, "the first poll skips nothing");
  assert.match(polls[1].query, /skip=d-a(%2C|,)d-b/, `the incompatible page is named on the next poll: ${polls[1].query}`);
  assert.match(polls[2].query, /skip=d-a(%2C|,)d-b/, "and stays named while the board still holds them");
  assert.equal(polls[3].query.includes("skip="), false,
    "an empty long-poll answer expires the skips, so a transient incompatibility is reconsidered");
  // One deduplicated reason: two offers sharing it over two polls, said once.
  const skipped = lines.filter((l) => /^skipping /.test(l));
  assert.equal(skipped.length, 1, `one reason, said once: ${JSON.stringify(skipped)}`);
  assert.equal(stub.requests.some((r: LegacyTestValue) => r.method === "POST"), false,
    "an incompatible offer is never claimed, and no reason is ever sent to the control plane");
});

test("pool: past the skip cap the runner backs off explicitly instead of looping", async () => {
  // Every page is a fresh batch of offers this runner cannot execute, so the
  // skip list fills; past the cap it must wait rather than re-poll immediately.
  let n = 0;
  const page = () =>
    Array.from({ length: 8 }, () => {
      n += 1;
      return offer({ dispatch_id: `d-${n}`, ref_id: `g-${n}`, run_group_id: `g-${n}`, target: { ...offer().target, driver: "mobile", platform: "ios", base_url: null } });
    });
  const answers = Array.from({ length: 12 }, () => ({ offers: page() }));
  const stub = await board(answers);
  const slept: number[] = [];
  const lines: string[] = [];
  try {
    await runPool(options(stub.url), {
      execGroupImpl: async () => assert.fail("nothing here is executable"),
      log: (line) => lines.push(line),
      sleep: async (ms) => { slept.push(ms); },
      random: () => 0.5,
      maxPolls: 12,
    });
  } finally {
    await stub.close();
  }
  assert.ok(slept.length >= 3, `the cap is reached and the loop backs off: ${JSON.stringify(slept)}`);
  assert.ok(slept[0]! >= 750, "the first backoff is about a second");
  assert.ok(slept.at(-1)! > slept[0]!, "and it grows rather than staying tight");
  const complaints = lines.filter((l) => /backing off/.test(l));
  assert.equal(complaints.length, 1, "said once, not once per poll");
});

test("pool: mint compatibility is labels only, and an unknown driver is refused by name", () => {
  const opts = options("http://127.0.0.1:1") as LegacyTestValue;
  assert.equal(defaultCompatibility(offer(), opts), null);
  assert.equal(defaultCompatibility(offer({ target: { ...offer().target, driver: "api" } }), opts), null);
  // A mint carries no target when its provider is project-wide, and needs none.
  assert.equal(defaultCompatibility(offer({ kind: "mint", target: null }), opts), null);
  assert.match(
    defaultCompatibility(offer({ target: { ...offer().target, driver: "mobile", application_key: "todo-ios", ring_key: "local" } }), opts)!,
    /no configuration binding for the mobile target "todo-ios\/local"/,
  );
  assert.match(defaultCompatibility(offer({ target: { ...offer().target, driver: "desktop" } }), opts)!, /cannot execute the "desktop" driver/);
});

test("pool: a lost claim race is not an error — the loser goes straight back to the board", async () => {
  const stub = await board([groupOffer], { claimStatus: 409 });
  const slept: number[] = [];
  const lines: string[] = [];
  try {
    const result = await runPool(options(stub.url), {
      execGroupImpl: async () => assert.fail("the loser of a race executes nothing"),
      log: (line) => lines.push(line),
      sleep: async (ms) => { slept.push(ms); },
      maxPolls: 3,
    });
    assert.equal(result.executed, 0);
  } finally {
    await stub.close();
  }
  assert.deepEqual(slept, [], "a documented conflict is not backed off");
  assert.equal(lines.some((l) => /error|retrying/i.test(l)), false, `losing a race is not an error: ${lines.join("|")}`);
  assert.equal(stub.requests.filter((r: LegacyTestValue) => r.method === "POST").length, 3, "it kept coming back for the next entry");
});

test("pool: a control plane that is down is retried with backoff and jitter, and says so once", async () => {
  const stub = await board([{ status: 503, body: { error: { message: "server is restarting" } } }, groupOffer]);
  const slept: number[] = [];
  const lines: string[] = [];
  try {
    await runPool(options(stub.url), {
      execGroupImpl: async () => ({ exitCode: 0 }),
      log: (line) => lines.push(line),
      sleep: async (ms) => { slept.push(ms); },
      random: () => 0.5,
      maxIterations: 1,
    });
  } finally {
    await stub.close();
  }
  assert.equal(slept.length, 1, `one backoff before the retry succeeded: ${JSON.stringify(slept)}`);
  assert.ok(slept[0]! >= 750 && slept[0]! <= 1250, `the first retry waits about a second: ${slept[0]}`);
  const complaints = lines.filter((l) => /not answering/.test(l));
  assert.equal(complaints.length, 1, "an outage is reported once, not once per retry");
  assert.match(complaints[0]!, /is not answering/);
  assert.ok(lines.some((l) => /reconnected/.test(l)), "and recovery is reported too");
});

test("pool: a revoked or unknown credential stops the runner with the remedy, never a retry loop", async () => {
  const stub = await board([
    { status: 403, body: { error: { code: "forbidden", message: 'runner "adas-laptop" was revoked and can no longer take work — register it again under Settings → Runners' } } },
  ]);
  try {
    await assert.rejects(
      () => runPool(options(stub.url), { execGroupImpl: async () => ({ exitCode: 0 }), log: () => {}, sleep: async () => {} }),
      /was revoked/,
    );
  } finally {
    await stub.close();
  }
});

test("pool: a cancel observed on the heartbeat tears the group down through the same path SIGTERM uses", async () => {
  const stub = await board([groupOffer], { heartbeat: () => ({ ok: true, canceled: true, status: "scheduled" }) });
  const lines: string[] = [];
  let sawAbort = false;
  try {
    await runPool(options(stub.url), {
      // Stands in for exec-group, which listens on the same signal its SIGTERM
      // handler listens on and then reports and completes.
      execGroupImpl: async (opts: LegacyTestValue) => {
        await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => { sawAbort = true; resolve(); }));
        return { exitCode: 0 };
      },
      log: (line) => lines.push(line),
      maxIterations: 1,
    });
  } finally {
    await stub.close();
  }
  assert.equal(sawAbort, true, "the heartbeat's cancel reached the running group");
  assert.match(lines.join("\n"), /canceled this run — tearing down run group g1/);
});

test("pool: a group that throws is reported and the runner stays in the pool", async () => {
  const stub = await board([groupOffer]);
  const lines: string[] = [];
  try {
    const result = await runPool(options(stub.url), {
      execGroupImpl: async () => { throw new Error("snapshot materialization failed\n  at somewhere:1:1"); },
      log: (line) => lines.push(line),
      maxIterations: 1,
    });
    assert.equal(result.executed, 1);
  } finally {
    await stub.close();
  }
  const output = lines.join("\n");
  assert.match(output, /run group g1 ended with an error: snapshot materialization failed/);
  assert.equal(/at somewhere/.test(output), false, "one actionable line, never a stack");
  assert.match(output, /waiting for work/, "and the runner is back on the board");
});

// ---------- arguments and credentials ----------

test("pool: the credential comes from the environment or a file, never from an argument", () => {
  const env = { PLAYTEST_RUNNER_CREDENTIAL: CREDENTIAL };
  const opts = parsePoolArgs(["--server", "https://playtest.example.com", "--labels", "macos, ios-sim ,macos"], env);
  assert.equal(opts.server, "https://playtest.example.com");
  assert.deepEqual(opts.labels, ["macos", "ios-sim"], "labels are trimmed and de-duplicated");
  assert.equal(opts.isolation, "process");
  assert.equal(opts.credential, CREDENTIAL);

  // Offering it on argv is refused with the remedy, not silently accepted.
  assert.throws(() => parsePoolArgs(["--credential", CREDENTIAL], env), /never passed on the command line/);
  assert.throws(() => parsePoolArgs(["--server"], env), /--server needs a value/);
  assert.throws(() => parsePoolArgs(["--isolation", "vm"], env), /--isolation must be process or container/);
  assert.throws(() => parsePoolArgs(["--nope"], env), /unknown argument: --nope/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-cred-"));
  try {
    const file = path.join(dir, "credential");
    fs.writeFileSync(file, `${CREDENTIAL}\n`);
    assert.equal(parsePoolArgs(["--credential-file", file], {}).credential, CREDENTIAL);
    assert.equal(parsePoolArgs([], { PLAYTEST_RUNNER_CREDENTIAL_FILE: file }).credential, CREDENTIAL);
    assert.throws(() => resolveCredential({}, path.join(dir, "missing")), /cannot read the runner credential/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pool: a missing or wrong-shaped credential names what to do about it", () => {
  assert.throws(() => resolveCredential({}, null), /Settings → Runners/);
  assert.throws(() => resolveCredential({}, null), /never accepted on the command line/);
  assert.throws(() => resolveCredential({ PLAYTEST_RUNNER_CREDENTIAL: "pt_project-api-token" }, null), /cannot claim work/);
});

test("pool: backoff grows, is capped, and is jittered so a fleet never retries in lockstep", () => {
  assert.equal(backoffDelayMs(1, { random: () => 0.5 }), 1000);
  assert.equal(backoffDelayMs(2, { random: () => 0.5 }), 2000);
  assert.equal(backoffDelayMs(10, { random: () => 0.5 }), 30_000, "capped");
  assert.equal(backoffDelayMs(3, { random: () => 0 }), 3000, "-25%");
  assert.equal(backoffDelayMs(3, { random: () => 1 }), 5000, "+25%");
});

test("pool: the startup banner states server, project, labels, isolation and that it is waiting", () => {
  const lines = startupLines(options("https://playtest.example.com") as LegacyTestValue, { id: "rn1", name: "adas-laptop", labels: ["macos"], project_key: "acme" });
  const output = lines.join("\n");
  assert.match(output, /Playtest runner "adas-laptop" — project acme/);
  assert.match(output, /server\s+https:\/\/playtest\.example\.com/);
  assert.match(output, /labels\s+macos/);
  assert.match(output, /isolation\s+process — cases run directly on this machine/);
  assert.match(output, /waiting for work/);
  // A runner advertising nothing takes anything in its project — say so rather
  // than rendering an empty field a person has to interpret.
  const bare = startupLines(options("http://127.0.0.1:4177", { labels: [] }) as LegacyTestValue, null);
  assert.match(bare.join("\n"), /labels\s+none — takes any job in this project/);
});
