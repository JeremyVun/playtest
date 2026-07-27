// The script-save leak scan (docs/contracts/scripts.md#leak-scan): the P2
// baseline machinery applied to script text. Findings BLOCK, so the cases that
// matter most are the ones that must stay quiet.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { describeLeakFindings, scanScriptText } from "../../src/public/api-suite-scripts.ts";
import { registerSecretValue, resetSecrets } from "../../src/secrets.ts";

afterEach(() => {
  resetSecrets();
  delete process.env.PLAYTEST_SECRET_LEDGER_TOKEN;
});

const CLEAN = `export default async function ({ client, check }) {
  const res = await client.get("/whoami", { headers: { authorization: client.secret("LEDGER_TOKEN") } });
  check({ id: "auth", obligation: "rule:auth", pass: res.ok, evidence: { requests: [res.ref] } });
}
`;

test("a script that injects its credential by reference is clean", () => {
  registerSecretValue("Bearer sk-live-9aZ81mQpVvTt42Kx", "LEDGER_TOKEN");
  const { findings, fingerprint } = scanScriptText(CLEAN);
  assert.deepEqual(findings, []);
  assert.match(fingerprint, /^[0-9a-f]{64}$/, "the scan returns the fingerprint an approval covers");
  assert.notEqual(scanScriptText(`${CLEAN} `).fingerprint, fingerprint, "one byte changes the fingerprint");
});

test("a pasted credential is a blocking finding that names the reference to use instead", () => {
  registerSecretValue("Bearer sk-live-9aZ81mQpVvTt42Kx", "LEDGER_TOKEN");
  const { findings } = scanScriptText(
    `export default async function ({ client }) {\n` +
      `  await client.get("/whoami", { headers: { authorization: "Bearer sk-live-9aZ81mQpVvTt42Kx" } });\n` +
      `}\n`,
  );
  const secret = findings.find((finding: LegacyTestValue) => finding.rule === "secret");
  assert.ok(secret, `the value is found: ${JSON.stringify(findings)}`);
  assert.equal(secret.line, 2, "the finding points at the line");
  assert.match(secret.detail, /client\.secret\("LEDGER_TOKEN"\)/);
  assert.match(describeLeakFindings(findings)[0], /^ {2}secret: line 2:/);
});

test("the bare credential half of a scheme-prefixed value is caught too", () => {
  registerSecretValue("Bearer sk-live-9aZ81mQpVvTt42Kx", "LEDGER_TOKEN");
  const { findings } = scanScriptText(`const token = "sk-live-9aZ81mQpVvTt42Kx";\nexport default async function () {}\n`);
  assert.ok(findings.some((finding: LegacyTestValue) => finding.rule === "secret"), JSON.stringify(findings));
});

test("a redaction-listed value is reported under the rule it contradicts", () => {
  process.env.PLAYTEST_SECRET_LEDGER_TOKEN = "Bearer sk-live-9aZ81mQpVvTt42Kx";
  const { findings } = scanScriptText(`const t = "Bearer sk-live-9aZ81mQpVvTt42Kx";\n`, {
    redact: { request: [{ path: "headers.authorization", secret: "LEDGER_TOKEN" }] },
  });
  assert.equal(findings[0].rule, "redaction", JSON.stringify(findings));
});

test("a credential-shaped literal is a finding even when no secret is registered", () => {
  const { findings } = scanScriptText(`const key = "AKIAJ7Xk9QmZ2pLdW3fN8sTvB4cH";\nexport default async function () {}\n`);
  assert.deepEqual(findings.map((finding: LegacyTestValue) => finding.rule), ["entropy"]);
  assert.match(findings[0].detail, /inject it as a secret reference/);
});

test("an email address in script text is application data, and is reported", () => {
  const { findings } = scanScriptText(`const owner = "ada@example.test";\nexport default async function () {}\n`);
  assert.deepEqual(findings.map((finding: LegacyTestValue) => finding.rule), ["data"]);
});

test("ordinary script vocabulary does not trip the scan", () => {
  const quiet = `import { setTimeout as sleep } from "node:timers/promises";
export default async function ({ client, check, params }) {
  const created = await client.post("/accounts", { body: { owner: "ada", currency: "USD" } });
  await sleep(5);
  const idempotencyKey = \`run-\${params.run}-transfer-1\`;
  const replay = await client.post("/transfers", { headers: { "idempotency-key": idempotencyKey }, body: { amount: 100 } });
  check({ id: "idempotent-replay", obligation: "rule:idempotency", pass: replay.ok, evidence: { requests: [replay.ref] } });
}
`;
  assert.deepEqual(scanScriptText(quiet).findings, []);
});
