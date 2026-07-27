-- Self-hosted runner pool (docs/contracts/hosted.md, "Runner pool").
--
-- A pull-based placement adapter: the control plane never starts or contacts an
-- executor. A registered runner authenticates outbound with its credential,
-- advertises labels, and claims work off a board. The board is not a new table —
-- a `requested` dispatch row plus its labels snapshot IS the board entry — so
-- run-group lifecycle, the dispatch ledger, and the reconciler are unchanged.

-- One row per registered runner. `credential_hash` is a plain SHA-256 of the
-- one-time plaintext, exactly like api_tokens: the credential is high-entropy
-- random, so no salt/KDF is needed. Revocation is a timestamp, not a delete, so
-- audit rows and a claimed dispatch keep pointing at a real runner.
CREATE TABLE runners (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  labels          TEXT_JSON NOT NULL DEFAULT '[]',
  credential_hash TEXT NOT NULL,
  -- An ephemeral runner is registered by a CI job for one pipeline run (R2) and
  -- is never listed as a standing runner. Always 0 until that phase lands.
  ephemeral       INT_BOOL NOT NULL DEFAULT 0 CHECK (ephemeral IN (0,1)),
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  last_seen_at    INT_TS,
  revoked_at      INT_TS,
  UNIQUE (project_id, name)
);
CREATE INDEX runners_project_idx ON runners(project_id);
CREATE UNIQUE INDEX runners_credential_idx ON runners(credential_hash);

-- Claim columns on the dispatch ledger. All nullable and never written by the
-- GitHub or local adapters, which keep placing work by starting an executor.
--   labels       the routing snapshot taken when the row was written — a job's
--                labels must be a SUBSET of a runner's for that runner to claim
--                it, and an empty snapshot matches any runner in the project.
--   runner_id    the single winner of the claim race.
--   claimed_at   when it won; the row moves `requested` -> `scheduled` with it.
--   heartbeat_at coarse group-level liveness between claim and completion, so
--                the reconciler can tell "slow" from "gone" before the first
--                case starts and after the last one ends.
--   canceled_at  cancelRun's mark; the runner observes it at its next heartbeat.
ALTER TABLE dispatches ADD COLUMN labels TEXT_JSON;
ALTER TABLE dispatches ADD COLUMN runner_id TEXT REFERENCES runners(id) ON DELETE SET NULL;
ALTER TABLE dispatches ADD COLUMN claimed_at INT_TS;
ALTER TABLE dispatches ADD COLUMN heartbeat_at INT_TS;
ALTER TABLE dispatches ADD COLUMN canceled_at INT_TS;

-- The board read: oldest unclaimed entry per project, then label matching.
CREATE INDEX dispatches_board_idx ON dispatches(project_id, status, requested_at)
  WHERE claimed_at IS NULL;
CREATE INDEX dispatches_runner_idx ON dispatches(runner_id) WHERE runner_id IS NOT NULL;
