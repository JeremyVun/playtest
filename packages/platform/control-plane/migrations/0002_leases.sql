-- Background-cycle leases (docs/contracts/hosted.md, "Background cycles and
-- leases"). One row per named cycle, claimed with a conditional UPDATE inside a
-- BEGIN IMMEDIATE transaction, which is what replaces the PostgreSQL advisory
-- lock: an in-process flag cannot survive a crash, and this row can.
--
-- `expires_at` is the whole recovery story. A holder renews while it works; a
-- process that dies mid-cycle leaves a row nobody renews, and the next cycle
-- claims it once the clock passes `expires_at`.

CREATE TABLE leases (
  name        TEXT PRIMARY KEY,
  owner       TEXT NOT NULL,
  acquired_at INT_TS NOT NULL,
  renewed_at  INT_TS NOT NULL,
  expires_at  INT_TS NOT NULL
);
