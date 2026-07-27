-- Live case progress (docs/contracts/hosted.md "Runner protocol").
--
-- The runner streams a throttled, redacted snapshot of the engine's progress
-- events while a case is in flight (step, mode word, last action, cost so
-- far). It lands here so the runs index can render a live row without
-- replaying event history; the case report clears it — a finished run's truth
-- is its manifest, never a stale tick.

ALTER TABLE runs ADD COLUMN progress TEXT_JSON;
