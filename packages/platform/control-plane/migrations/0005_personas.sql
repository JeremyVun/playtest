-- Project-scoped personas (docs/contracts/hosted.md, "Personas"). A persona is
-- editable prose ({name, description}) a project keeps around so its stories
-- can reference it by slug without every suite carrying its own
-- `personas/<slug>.yaml`. The rendered YAML lives content-addressed in the
-- object store, same as every other suite-tree blob; `blob_sha256` points at it.
--
-- slug is immutable once created (stories reference personas by slug, same as
-- a suite-committed `personas/<slug>.yaml` file) and is unique per project,
-- matching how the three built-in personas (tester/exploratory/adversarial)
-- are named.

CREATE TABLE personas (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  blob_sha256   TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id),
  created_at    INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at    INT_TS NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (project_id, slug)
);
