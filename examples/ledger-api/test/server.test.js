// The documented start command actually starts the fixture.
//
// Everything else in the suite drives the app in-process; this suite spawns the
// real entry point the README tells people to run, on an ephemeral port.

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");

/** Spawn the entry point and resolve once it prints its listening URL. */
function boot(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: "0", HOST: "127.0.0.1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not start in time: ${stdout}${stderr}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /listening on (http:\/\/\S+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve({
          child,
          url: match[1],
          get stdout() {
            return stdout;
          },
          stop: () =>
            new Promise((done) => {
              child.once("exit", done);
              child.kill("SIGTERM");
            }),
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}: ${stderr || stdout}`));
    });
  });
}

/** Run the entry point expecting it to refuse to start. */
function bootExpectingFailure(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

test("node examples/ledger-api/server.js boots and serves its spec", async () => {
  const server = await boot({ LEDGER_SEED: "boot-seed" });
  try {
    const health = await fetch(`${server.url}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const spec = await fetch(`${server.url}/openapi.json`);
    assert.equal(spec.status, 200);
    assert.equal((await spec.json()).openapi, "3.1.0");

    const unauthorized = await fetch(`${server.url}/accounts`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${server.url}/accounts`, {
      headers: { authorization: "Bearer admin-token-dev" },
    });
    assert.equal(authorized.status, 200, "the documented default admin token works");

    assert.match(server.stdout, /seed:\s+boot-seed/);
    assert.match(server.stdout, /faults:\s+\(none — clean build\)/);
  } finally {
    await server.stop();
  }
});

test("the credential and fault environment variables take effect", async () => {
  const server = await boot({
    LEDGER_ADMIN_TOKEN: "admin-xyz",
    LEDGER_CUSTOMER_TOKEN: "customer-xyz",
    LEDGER_FAULTS: "f-close-ghost,f-pagination-dup",
  });
  try {
    const withDefault = await fetch(`${server.url}/accounts`, {
      headers: { authorization: "Bearer admin-token-dev" },
    });
    assert.equal(withDefault.status, 401);

    const withCustom = await fetch(`${server.url}/accounts`, { headers: { authorization: "Bearer admin-xyz" } });
    assert.equal(withCustom.status, 200);

    const customerOnAdmin = await fetch(`${server.url}/admin/tick`, {
      method: "POST",
      headers: { authorization: "Bearer customer-xyz", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(customerOnAdmin.status, 403);

    // The operator's terminal names the enabled faults; the wire never does.
    assert.match(server.stdout, /faults:\s+f-close-ghost, f-pagination-dup/);
    const health = await (await fetch(`${server.url}/health`)).text();
    assert.equal(health.includes("f-close-ghost"), false);
  } finally {
    await server.stop();
  }
});

test("an unknown fault id or a bad port refuses to start with an actionable message", async () => {
  const badFault = await bootExpectingFailure({ LEDGER_FAULTS: "f-typo" });
  assert.equal(badFault.code, 1);
  assert.match(badFault.stderr, /unknown LEDGER_FAULTS id\(s\): f-typo/);
  assert.match(badFault.stderr, /known ids: f-error-200/);

  const badPort = await bootExpectingFailure({ PORT: "not-a-port" });
  assert.equal(badPort.code, 1);
  assert.match(badPort.stderr, /PORT must be an integer/);
});
