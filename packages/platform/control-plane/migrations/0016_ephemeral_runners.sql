-- Ephemeral CI runners and per-launch label pinning
-- (docs/contracts/hosted.md, "Runner pool").
--
-- A CI job registers a runner for the length of one pipeline run by presenting
-- its GitHub OIDC token instead of a long-lived credential. Two columns carry
-- what that registration is: when it stops being usable, and which verified
-- workflow run asked for it.
--   expires_at  after this instant the credential is refused at poll, claim and
--               exchange exactly like a revoked one. NULL for standing runners,
--               which expire only when someone revokes them.
--   source      the verified OIDC claims the registration was minted from
--               (repository, workflow ref, run id and attempt). It is evidence,
--               not authority: nothing routes on it, but a reviewer can see
--               which build produced a runner, and the per-run registration cap
--               counts rows by its run_id.
ALTER TABLE runners ADD COLUMN expires_at INT_TS;
ALTER TABLE runners ADD COLUMN source TEXT_JSON;

-- The live-ephemeral read: "what has this workflow run already registered".
CREATE INDEX runners_ephemeral_idx ON runners(project_id, expires_at) WHERE ephemeral = 1;

-- Per-launch label pinning. A launch may pin the labels its group is placed on,
-- overriding the environment's, so two concurrent CI pipelines each reach their
-- OWN build's runner. NULL means "follow the environment", which is every group
-- launched before this migration and every launch that does not ask.
--
-- It rides the GROUP, not just the first dispatch row, because a retry or a
-- continuation attempt has to be placed the same way the original was: the
-- environment's labels may have changed since, and re-reading them would move
-- an in-flight run onto a different machine.
ALTER TABLE run_groups ADD COLUMN runner_labels TEXT_JSON;
