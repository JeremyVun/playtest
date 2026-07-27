-- Hosted concurrency policy.
--
-- Core already accepts `parallel: { total, record }`: `total` bounds all cases
-- in a run group, while `record` bounds the model-driven subset so baseline
-- checks can use the remaining workers. Hosted used to force both to one.
--
-- This project default is deliberately concrete and serial for existing
-- projects. A suite may replace it with the `parallel` value in its pinned
-- playtest.yaml; omitting that key inherits this object.
ALTER TABLE projects
  ADD COLUMN parallel TEXT_JSON NOT NULL DEFAULT '{"record":1,"total":1}';
