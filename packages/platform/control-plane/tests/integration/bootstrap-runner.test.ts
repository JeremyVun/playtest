import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./helpers.ts";
import { ensureConfiguredRunner } from "../../src/bootstrap-runner.ts";
import { newRunnerCredential } from "../../src/auth/runner-credentials.ts";

test("configured site runner is created once; mismatch and revocation never rotate or resurrect it", async () => {
  const credential = newRunnerCredential().plaintext;
  await withApp(async ({ app }: HostedDynamic) => {
    const before = (await app.db.query("SELECT * FROM runners WHERE name = 'compose'")).rows[0];
    await ensureConfiguredRunner(app.ctx);
    assert.deepEqual((await app.db.query("SELECT * FROM runners WHERE name = 'compose'")).rows, [before]);
    app.config.siteRunner.credential = newRunnerCredential().plaintext;
    await assert.rejects(ensureConfiguredRunner(app.ctx), /different credential/);
    app.config.siteRunner.credential = credential;
    await app.db.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [before.id]);
    await assert.rejects(ensureConfiguredRunner(app.ctx), /revoked/);
    assert.equal((await app.db.query("SELECT COUNT(*) AS n FROM runners WHERE name = 'compose'")).rows[0].n, 1);
  }, { PLAYTEST_SITE_RUNNER_NAME: "compose", PLAYTEST_SITE_RUNNER_CREDENTIAL: credential });
});
