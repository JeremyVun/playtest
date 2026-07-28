// The dev peer runner's half of `npm run hosted`.
//
// There is one placement model, so local development cannot have a private one:
// a launch posts to the claim board and a runner claims it, on a laptop exactly
// as on a build box. What local development is allowed is ZERO CEREMONY — no
// "register a runner, copy the credential, paste the start command" between
// installing the repository and seeing a verdict. So under `PLAYTEST_AUTH=dev`
// the control plane ensures, at boot, one site-scoped runner named `local` and
// writes its credential to a `0600` file under the data root, where
// `scripts/hosted-server.sh` starts `runner-agent pool` against it.
//
// Two properties matter and are tested:
//
//   1. **Idempotent.** A second boot reuses the same runner row and the same
//      credential file. Only a hash is stored, so a credential cannot be
//      re-derived: the file is the plaintext's only home, and boot re-mints
//      (rotating the stored hash) exactly when the file no longer matches the
//      row — deleted, truncated, or written by a data root that was reset.
//   2. **It never races the agent.** The file is written whole through a
//      temporary path and renamed, so the agent reading it concurrently sees
//      either nothing or a complete credential, never half of one.
//
// This is dev-auth only, by design. Site scope is a trust grant — a claiming
// runner receives every project's suite files and secrets — and granting one
// automatically is defensible precisely because the dev-auth admin bypass has
// already granted the same reader admin over every project.
import fs from "node:fs";
import path from "node:path";
import { hashToken } from "./auth/tokens.ts";
import { newRunnerCredential } from "./auth/runner-credentials.ts";
import { ensureSiteRunner } from "./api/site-runners.ts";
import type { AppContext } from "./types.ts";

/** The name the dev peer runner registers under. Singular by partial index. */
export const LOCAL_RUNNER_NAME = "local";

/** Where its credential lives, relative to the data root. */
export const LOCAL_RUNNER_CREDENTIAL_FILE = "local-runner.credential";

export function localRunnerCredentialPath(dataDir: string): string {
  return path.join(dataDir, LOCAL_RUNNER_CREDENTIAL_FILE);
}

/**
 * Ensure the dev peer runner exists and its credential file matches it.
 * A no-op on every boot after the first. Returns what happened, for the log
 * line and for the tests that assert idempotence.
 */
export async function ensureLocalPeerRunner(
  ctx: AppContext,
): Promise<{ id: string; name: string; credentialFile: string; created: boolean; rotated: boolean }> {
  const file = localRunnerCredentialPath(ctx.config.dataDir);
  const { rows } = await ctx.db.query(
    `SELECT * FROM runners WHERE project_id IS NULL AND name = $1 AND revoked_at IS NULL`,
    [LOCAL_RUNNER_NAME],
  );
  const existing = rows[0];

  if (existing) {
    // The row is here; is the credential the operator's disk holds still the one
    // it hashes to? If so there is nothing to do — this is the steady state.
    const onDisk = readCredential(file);
    if (onDisk && hashToken(onDisk) === existing.credential_hash) {
      return { id: existing.id as string, name: LOCAL_RUNNER_NAME, credentialFile: file, created: false, rotated: false };
    }
    // It is not. Only a hash is stored, so the plaintext cannot be recovered and
    // the honest repair is a new credential on the existing row: the runner keeps
    // its identity, its history and its claims, and the old value stops working.
    const { plaintext, hash } = newRunnerCredential();
    await ctx.db.query(`UPDATE runners SET credential_hash = $2 WHERE id = $1`, [existing.id, hash]);
    writeCredential(file, plaintext);
    return { id: existing.id as string, name: LOCAL_RUNNER_NAME, credentialFile: file, created: false, rotated: true };
  }

  const { plaintext, hash } = newRunnerCredential();
  const row = await ensureSiteRunner(ctx, {
    name: LOCAL_RUNNER_NAME,
    // No labels: it takes any job whose ring asks for none, which is what a
    // first web run on a laptop is. A ring that pins labels routes elsewhere.
    labels: [],
    hash,
    actor: { system: "dev_auth" },
  });
  if (!row) {
    // Lost a race with another boot against the same data root. The winner's
    // row is authoritative; recurse once and adopt (or rotate) it.
    return await ensureLocalPeerRunner(ctx);
  }
  writeCredential(file, plaintext);
  return { id: row.id as string, name: LOCAL_RUNNER_NAME, credentialFile: file, created: true, rotated: false };
}

function readCredential(file: string): string | null {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Write the credential the way a secret on a shared machine has to be written:
 * created `0600` from the start (never world-readable for even an instant, which
 * a write-then-chmod would allow), whole, and renamed into place so a reader
 * never sees a partial value.
 */
function writeCredential(file: string, plaintext: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${plaintext}\n`, { mode: 0o600 });
  // An existing file's mode survives a rename onto it, so state it on the
  // temporary file AND after the swap: neither alone covers both paths.
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
