-- Runner names are unique among LIVE runners, not for all time
-- (docs/contracts/hosted.md, "Runner pool").
--
-- 0015's table-level `UNIQUE (project_id, name)` counted revoked rows, so the
-- console's own remedy for a lost credential — "register it again under
-- Settings → Runners" — failed with a name conflict on the only name the person
-- wanted. Revocation is a timestamp rather than a delete precisely so history
-- keeps reading, and history is not a reason to retire a machine's name.
--
-- SQLite cannot drop a table-level constraint, so `runners` is rebuilt and the
-- rule comes back as a PARTIAL unique index. Dropping the table fires
-- `dispatches.runner_id`'s ON DELETE SET NULL — foreign keys stay enforced here,
-- because `PRAGMA foreign_keys` is a no-op inside the transaction the migration
-- runner opens — so the claim attribution of any in-flight group is parked in a
-- scratch table and put back afterwards. Without that, upgrading while a runner
-- was mid-group would orphan its claim.
CREATE TABLE runners_claim_backup AS
  SELECT id AS dispatch_id, runner_id FROM dispatches WHERE runner_id IS NOT NULL;

CREATE TABLE runners_new (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  labels          TEXT_JSON NOT NULL DEFAULT '[]',
  credential_hash TEXT NOT NULL,
  ephemeral       INT_BOOL NOT NULL DEFAULT 0 CHECK (ephemeral IN (0,1)),
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  last_seen_at    INT_TS,
  revoked_at      INT_TS,
  expires_at      INT_TS,
  source          TEXT_JSON
);
INSERT INTO runners_new
  SELECT id, project_id, name, labels, credential_hash, ephemeral, created_by,
         created_at, last_seen_at, revoked_at, expires_at, source
    FROM runners;
DROP TABLE runners;
ALTER TABLE runners_new RENAME TO runners;

-- Every index 0015 and 0016 created, plus the rule that replaces the constraint:
-- two live runners in one project may not share a name; a revoked one holds
-- nothing.
CREATE INDEX runners_project_idx ON runners(project_id);
CREATE UNIQUE INDEX runners_credential_idx ON runners(credential_hash);
CREATE INDEX runners_ephemeral_idx ON runners(project_id, expires_at) WHERE ephemeral = 1;
CREATE UNIQUE INDEX runners_live_name_idx ON runners(project_id, name) WHERE revoked_at IS NULL;

UPDATE dispatches
   SET runner_id = (SELECT b.runner_id FROM runners_claim_backup b WHERE b.dispatch_id = dispatches.id)
 WHERE id IN (SELECT dispatch_id FROM runners_claim_backup);
DROP TABLE runners_claim_backup;
