-- Per-project auto-dedupe policy (docs/contracts/hosted.md, "Consolidation").
--
-- Tri-state on purpose: NULL inherits the deployment default
-- (PLAYTEST_AUTO_DEDUPE), 1/0 pin the automatic post-run dedupe sweep on or
-- off for this project regardless of that default. A project cannot conjure a
-- gateway the deployment lacks — with no PLAYTEST_LLM_BASE_URL the sweep
-- stays off everywhere.

ALTER TABLE projects ADD COLUMN auto_dedupe INT_BOOL CHECK (auto_dedupe IS NULL OR auto_dedupe IN (0, 1));
