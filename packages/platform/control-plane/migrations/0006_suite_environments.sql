-- Suite-owned test targets, and a home for a suite's own base URL
-- (docs/contracts/hosted.md, "Environments, secrets, and target authentication").
--
-- An environment is a deployment ring: credentials, runner pool, discovery
-- permission. Until now every ring was project-wide, so a project that had none
-- could not launch at all, and a suite that needed a target nobody else shares
-- had to have an operator add it project-wide. `suite_id` makes a ring
-- suite-owned: visible and launchable from that suite only, deleted with it.
--
-- Names stay unique per project (the UNIQUE (project_id, name) table constraint
-- is unchanged, and cannot be scoped without rebuilding the table, which
-- run_groups' ON DELETE RESTRICT forbids). That is also the honest rule to
-- explain: a target name means one thing inside a project, whoever owns it.
-- The name is the overlay key (`app.envs.<name>` in the runner workspace), so
-- uniqueness here is what keeps that key unambiguous.
ALTER TABLE environments ADD COLUMN suite_id TEXT REFERENCES suites(id) ON DELETE CASCADE;

CREATE INDEX environments_suite_idx ON environments(suite_id);

-- Every project gets a `default` ring if it has none. It carries no URL of its
-- own, so a launch against it resolves to each suite's own `app.base_url` —
-- which is how a suite's base URL becomes selectable at launch instead of being
-- a fourth thing to reason about. Projects that already configured a ring are
-- left alone.
--
-- ULIDs are minted in the application; here the id only has to be unique and
-- alphabet-legal, so it is hex (a subset of Crockford base32) padded to the same
-- 26 characters. The leading zeros sort it before every real ULID.
INSERT INTO environments (id, project_id, name, config, discovery_allowed, runner_labels)
SELECT '00' || substr(hex(randomblob(16)), 1, 24), p.id, 'default', '{}', 0, '[]'
  FROM projects p
 WHERE NOT EXISTS (SELECT 1 FROM environments e WHERE e.project_id = p.id);
