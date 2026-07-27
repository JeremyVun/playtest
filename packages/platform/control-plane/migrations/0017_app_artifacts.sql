-- Environment app artifacts (docs/contracts/hosted.md, "Environments, secrets,
-- and target authentication" and "Runner pool").
--
-- The app binary is the mobile analogue of base_url: it IS the target, and it
-- churns per build — the wrong cadence for suite commits, which would drag a
-- snapshot per CI build through suite history. So it belongs to the
-- environment, whose job is already "what am I testing against".
--
-- The bytes live in the existing content-addressed object store under
-- blobs/<sha256>, exactly where suite-file blobs live, so re-uploading identical
-- bytes is a no-op by construction and the existing blob GC already knows how to
-- reclaim one. What these two columns carry is the REFERENCE:
--   { sha256, size, filename, uploaded_at, uploaded_by }
-- NULL means "this environment ships no binary", which is every environment
-- before this migration and every co-located runner that keeps using a plain
-- local path.
ALTER TABLE environments ADD COLUMN app_artifact TEXT_JSON;

-- The launch-time pin. A run group records the artifact reference it resolved
-- at launch, so a re-upload can never change what an in-flight or historical
-- group tested — the same immutability rule suite snapshots already follow. It
-- is also what keeps the blob alive: GC deletes a blob only once no environment
-- and no run group names it.
--
-- NULL means the launch resolved its binary from somewhere else (the suite tree,
-- a runner-local path, or nothing at all), which is every group launched before
-- this migration.
ALTER TABLE run_groups ADD COLUMN app_artifact TEXT_JSON;
