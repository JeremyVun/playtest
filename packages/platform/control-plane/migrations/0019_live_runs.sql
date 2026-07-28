-- Live runs: open-run staging (docs/contracts/hosted.md "Live runs").
--
-- A run becomes viewable while it executes. Its evidence streams in ahead of the
-- sealed bundle and lives in two shapes, split by transactionality — SQLite and
-- the object store cannot share a transaction, so each side holds what it is
-- good at:
--
--   * Trajectory batches and the manifest snapshot live in SQLite. They are
--     transient, KB-scale and budget-capped, so accepting a batch is one
--     transaction (count, budget, bytes and text move together), reading is one
--     indexed query, and cleanup is a DELETE. No object-ownership race exists
--     for the highest-frequency write path.
--   * Step artifacts live in the object store behind a TWO-PHASE ledger row:
--     reserve `pending` (budget charged, key and hash recorded) -> put the
--     object -> mark `ready`. Readers serve `ready` only; retention treats both
--     states as owned, so the orphan sweep never sees an unowned live object.
--
-- The status machine is untouched: `live_opened_at` records openness, and a run
-- is open exactly while it is set and the status is still non-terminal.

ALTER TABLE runs ADD COLUMN live_opened_at INT_TS;
-- The placeholder (or latest) manifest snapshot the runner posted. Deliberately
-- NOT the `manifest` column: that one is the sealed report's manifest and every
-- existing projection keys off its presence.
ALTER TABLE runs ADD COLUMN live_manifest TEXT_JSON;
-- Host-minted, monotonic per run; clients compare it for inequality only.
ALTER TABLE runs ADD COLUMN live_manifest_generation INTEGER NOT NULL DEFAULT 0;
-- Last live ingest or progress arrival: the source of `inactive_ms`.
ALTER TABLE runs ADD COLUMN live_activity_at INT_TS;

CREATE INDEX runs_live_open_idx ON runs(live_opened_at) WHERE live_opened_at IS NOT NULL;

CREATE TABLE live_trajectory (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- 0-based index of this batch's first line. Batches are contiguous by
  -- construction, so MAX(from_line + line_count) is the authoritative count.
  from_line  INTEGER NOT NULL,
  line_count INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  -- `line_count` whole trajectory.jsonl lines, each newline-terminated.
  text       TEXT NOT NULL,
  created_at INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX live_trajectory_run_from_idx ON live_trajectory(run_id, from_line);

CREATE TABLE live_artifacts (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- The bundle-relative entry path (steps/NNN.png and its profile siblings).
  entry      TEXT NOT NULL,
  key        TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('pending','ready')),
  -- Charged against the run's live budget from the reservation onward.
  size       INTEGER NOT NULL,
  -- Recorded at reservation: an identical-bytes retry is answered from the row
  -- without charging budget twice, and different bytes for the same entry are
  -- refused.
  sha256     TEXT NOT NULL,
  created_at INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX live_artifacts_run_entry_idx ON live_artifacts(run_id, entry);
CREATE INDEX live_artifacts_state_idx ON live_artifacts(state, created_at);
