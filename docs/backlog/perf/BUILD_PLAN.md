# Recording performance build plan

Date: 2026-07-27
Source: `docs/backlog/perf/ANALYSIS.md`. Every code-level claim in that
analysis was re-verified against the current source before this plan was
written; all findings survived. Three verification results shape the plan:

- `context.jsonl` is appended per turn (`fs.appendFileSync`), not rewritten;
  the genuinely quadratic-cost write is the HAR checkpoint, which
  restringifies the entire accumulated HAR every fifth step. The HAR journal
  therefore outranks the context.jsonl delta format.
- The mobile snapshot format pin `ax-tree-v7` exists twice: as
  `SNAPSHOT_FORMAT` in `src/core/drivers/mobile-snapshot.js:18` and as a
  hardcoded literal in `SNAPSHOT_FORMATS.mobile` in
  `src/core/trajectory.js:23`. Phase 1/2 mobile work must not change the
  snapshot text or format; if it ever does, both pins move together.
- The slideshow `spawnSync` (`src/core/clip.js:255-300`) blocks the whole
  Node event loop, so in parallel suites it stalls every in-flight case, not
  just its own. This raises the value of Phase 4 beyond one case's latency.

Rules for every phase:

- Preserve action/grade schemas, envelope shapes, snapshot text, and prompt
  pins unless the phase explicitly changes a contract (only Phase 3 does).
- `npm test` stays offline, Node-only, zero-skip.
- Each phase lands as its own reviewable change with its tests, and later
  phases must not depend on unlanded earlier phases except where stated.
- Per repo direction, new modules are strict TypeScript; edits inside
  existing `.js` files stay `.js` unless the module is being migrated as a
  coherent slice. Do not mix a perf change with a TS migration of the same
  hot file in one commit.

## Phase 0 — Timing instrumentation (prerequisite for acceptance)

Everything later is accepted against numbers this phase produces. The
retained-run telemetry in the analysis cannot separate snapshot capture from
the actor model call because `step_start` is emitted only after the actor
returns (`src/core/runner.js:1109`).

### T0.1 Performance sidecar

- Add a per-run `perf.jsonl` sidecar written by `RunWriter`
  (`src/core/trajectory.js`), one JSON object per span:
  `{ t, step, span, ms, meta? }`. Do not add spans to `trajectory.jsonl` —
  that file is pinned by baselines.
- Spans, at minimum:
  - `snapshot` with `meta` sub-splits: source/custom tree, screenshot,
    image processing, MHTML, native AX, artifact writes;
  - `actor_request` with tokens, cache-read tokens, retries, validation
    attempts (available from `src/core/llm.js` / `src/core/actor.js`);
  - `action_resolve`, `action_dispatch`, `settle`, `axe`, `effect_token`,
    `har_flush`;
  - `grader_request` (count, fetches, tokens, retries) and `grade_total`;
  - `driver_close`, `env_teardown`, `slideshow`, `vtt`, `case_total`;
  - mobile: Appium command count and duration by command name (wrap the
    WebDriver client calls in `src/core/drivers/mobile.js` once, centrally).
- Gate the sidecar behind an env flag defaulting on
  (`PLAYTEST_PERF_SIDECAR=0` disables); it is diagnostic, not part of the
  artifact contract, so keep it out of `docs/contracts/artifacts.md` and out
  of manifests/envelopes.
- Timing source: `performance.now()`; keep the helper allocation-free on the
  hot path (no per-span closures over big objects).

### T0.2 Baseline capture

- Script (under `tools/` or `studies/`, not shipped) that runs a short and a
  long hermetic recording at suite concurrency 1, 2, and 4 and reports
  p50/p95 per span plus peak RSS and artifact bytes by type.
- Record the baseline numbers into `docs/backlog/perf/BASELINE.md` before
  Phase 1 starts.

Tests: unit test that spans appear with plausible ordering and that the flag
disables the sidecar; assert `trajectory.jsonl` is byte-identical with the
sidecar on and off.

## Phase 1 — P0 hot-path waste (no contract changes)

### T1.1 Reuse the mobile source that settle already fetched

Current duplication (verified): `#settle()`
(`src/core/drivers/mobile.js:441-483`) polls `getPageSource()` and finishes
holding a stable raw XML and digest, but persists only
`#lastSourceDigest`. The immediately following `captureSnapshot()`
(`mobile.js:201-251`, called from `src/core/runner.js:1035`, `:1224`, and
the replay continuation at `:1350`) refetches and reparses the same screen.
`start()` (`mobile.js:139-155`) also fetches a source that its first
`#settle()` refetches.

Change:

- `#settle()` retains `{ seq, raw, parsed }` where `seq` is a driver-level
  monotonic operation counter incremented by every device command (tap,
  type, swipe, back, alert action, orientation, etc.).
- `captureSnapshot()` consumes the cached entry only when `seq` still
  matches (no device operation since settle) and clears it after one use.
  On consumption it skips only the `getPageSource()` + parse; the alert
  probe and screenshot in the existing `Promise.all`
  (`mobile.js:209-213`) stay live — alerts are OS-drawn and never appear in
  page source (`mobile.js:171-179`), so alert state must never be cached.
- Seed the first settle with the source `start()` already fetched so the
  startup duplicate disappears too.
- Do not change parsed output, `snap.text`, refs, or the `ax-tree-v7`
  format. No pin moves.

Tests (hermetic, using the existing fake/mock Appium client in
`tests/core/`):

- After a stable action, the next `captureSnapshot()` issues zero
  `getPageSource()` commands (count on the mock client).
- Any interleaved device command invalidates the cache and forces a fresh
  fetch.
- An alert appearing between settle and capture is still reported.
- Startup performs exactly one initial source fetch.
- Snapshot text for a fixed source is byte-identical before/after.

### T1.2 Compute effect tokens only where consumable

Verified: `recordLoop()` fetches `before = await driver.effectToken()` for
every non-terminal action (`src/core/runner.js:1142`), but
`detectConfusion()` (`runner.js:1591-1605`, gate at `:1599`) only compares
it for `click`/`tap`/`type` with `(exec.perf?.requests ?? 0) === 0` and a
non-null before-token.

Change:

- In `recordLoop()`, compute the pre-action token only when
  `action.type` is `click`, `tap`, or `type`; pass `null` otherwise.
  `detectConfusion()` already treats a null before-token as "no signal", so
  semantics are exactly preserved.
- Mirror the same guard in `actLoop()` if it computes a token (check before
  editing).
- Value is highest on mobile, where every `effectToken()` performs a live
  Appium alert probe (`mobile.js:169-186`) and swipe/back/scroll are common.

Tests: unit test that scroll/select/wait/back/navigate steps trigger no
`effectToken()` call (mock driver counter) and that click/tap/type confusion
detection behaves identically on a canned no-effect trajectory.

### Phase 1 acceptance

- Mobile: `getPageSource()` count per run drops by ~1 per executed action
  plus 1 at startup (assert exact counts in tests; observe span totals from
  Phase 0 on a simulator run when available).
- No change to `trajectory.jsonl`, envelopes, manifests, confusion or
  drift counts on the fixed fixtures.

## Phase 2 — Capture-path efficiency (no contract changes)

### T2.1 Single mobile XML parse for both projections

Verified: `captureSnapshot()` runs `parsePageSource(xml)`
(`src/core/drivers/mobile-snapshot.js:201`) and separately
`nativePageSourceTree(xml)` (`mobile-snapshot.js:485-524`), each driving its
own full `TAG_RE.exec` walk over the same XML.

Change: have `parsePageSource()` (or a shared internal walker) expose the
node/attribute tree it already builds, and derive the debug projection from
that structure. Byte-identical output for both the agent-facing text and the
debug text is required — golden-file test against a corpus of real page
sources (add fixtures if none exist). Do not touch `SNAPSHOT_FORMAT`.

If Phase 3 lands first and makes the native tree opt-in, this task shrinks
to "skip `nativePageSourceTree` entirely in core profile" — sequence the two
phases accordingly, but the shared-walk refactor is still worth it for
debug-profile runs.

### T2.2 Parallelize web capture and de-sync artifact writes

Verified: after the custom snapshot assigns refs, `page.title()`,
screenshot, MHTML, and native AX capture are awaited serially with
`fs.writeFileSync` writes (`src/core/drivers/web.js:694-739`).

Change:

- Run title, screenshot (+dHash/image processing), MHTML, and native AX
  concurrently after the custom snapshot resolves.
- Convert step-artifact writes (PNG, MHTML, native AX text) to
  `fs.promises`, with one awaited persistence barrier before
  `captureSnapshot()` returns paths — envelopes must never advertise a file
  that is not yet on disk. Keep trajectory/manifest crash-boundary writes
  synchronous.
- The screenshot needed by a vision prompt must be complete before the
  return; only debug artifacts may still be flushing when the model call
  starts, and the barrier design must still guarantee they exist before the
  envelope is written.

Tests: existing browser suite (`npm run test:browser`) must pass unchanged;
add a browser test against a continuously mutating page asserting all
per-step artifacts exist and the snapshot text corresponds to one coherent
capture (the current serial code already tolerates instant skew, so assert
non-regression, not perfect atomicity).

### T2.3 Group web locator validation round-trips

Verified serial round-trips at `src/core/drivers/web.js:762-769`:
`count` → `isVisible` → `isEnabled` → durable-locator → `bbox`.

Measure first with the Phase 0 spans. Only if the span shows meaningful cost
on realistic pages, group `isVisible`/`isEnabled` and durable/bbox where
ordering is not load-bearing. Skip this task if the 500 ms settle floor
still dwarfs it — record the measurement either way in `BASELINE.md`.

### Phase 2 acceptance

Snapshot span p50 reduced on the browser fixture; zero diffs in snapshot
text, envelopes, or viewer rendering; `npm run test:all` green.

## Phase 3 — Artifact profiles (contract change)

The one phase that changes contracts. Verified facts it rests on: tracing is
unconditionally on with `screenshots: true, snapshots: true`
(`src/core/drivers/web.js:440`), flushed at close (`web.js:947-949`);
`trace.zip` is the dominant artifact (3.7 MB p50 / 18.9 MB p90, with a
125 MB pathological case that is 96.5% duplicate caret-blink frames); native
AX artifacts are debug-only in both drivers; the viewer has **zero**
references to `trace.zip`, hides the `pw_a11y` toggle when the artifact is
absent (`src/run-viewer/web/app.js:1338-1341`, `:2833-2834`), and serves
MHTML only as a static MIME mapping (`src/run-viewer/node.js:35`) with no UI
branch guarding its absence.

### T3.1 Introduce `artifacts: core | debug`

- Config surface: per-case/suite key (default `core`), validated in
  `src/core/config.js` with a `DummyConfigError` on bad values.
- `core`: agent-facing accessibility text, step PNGs (actor vision, viewer,
  video), HAR, trajectory/manifest/events. No Playwright trace, no MHTML,
  no native AX tree (web or mobile), and skip `nativePageSourceTree` work.
- `debug`: exactly today's full set.
- Driver changes: make `tracing.start` conditional (`web.js:440`) and its
  `close()` flush guarded; gate MHTML and native-AX capture in
  `web.js:694-739`; gate `pw_a11y` writes in `mobile.js:224-235`.
- Do not implement the rolling-trace-chunk idea in this phase; note it as a
  follow-up only if Playwright chunking proves reliable.

### T3.2 Contract and viewer updates (same change)

- Update `docs/contracts/artifacts.md` (per-step `mhtml` line ~135,
  `pw_a11y` ~137, top-level `trace.zip`/`final.mhtml` ~308-323, ~956) and
  `docs/contracts/engine.md:298` (`final.a11y.txt`/`final.mhtml`) to
  describe both profiles and which artifacts are conditional.
- Viewer: `pw_a11y` fallback already exists; verify the MHTML path degrades
  gracefully when absent (add the missing UI guard if any control exposes
  it), and add a viewer node test covering a core-profile run directory.
- Manifests/envelopes must list only artifacts that exist — audit every
  place that unconditionally records these paths.
- Check hosted components (`src/platform/control-plane`,
  `src/platform/runner-agent`) for assumptions that `trace.zip` or MHTML
  exists in a bundle, and update `docs/contracts/hosted.md` if the bundle
  shape statement changes.

### Phase 3 acceptance

Core-profile run: no trace/MHTML/native-AX files, viewer fully functional,
all suites green including hosted tests; debug profile byte-equivalent to
today. Measure close-time and bundle-size deltas via Phase 0 spans.

## Phase 4 — Pipeline shape (no contract changes)

### T4.1 Async slideshow and overlapped grading

Verified order in `src/core/runner.js`: manifest (~899) → `driver.close()`
(~908) → `env.teardown()` (~909) → VTT (~918) → `spawnSync` ffmpeg
slideshow → `gradeRun()` at `:937`. `gradeRun()` (`src/core/grader.js:202`)
reads only `trajectory.jsonl`, `manifest.json`, and the final a11y artifact.

Change:

- Convert the slideshow wrapper (`src/core/clip.js:255-300`) from
  `spawnSync` to an awaited async child process. This is valuable on its own
  because `spawnSync` blocks every parallel case's event loop.
- Start `gradeRun()` as soon as the gate result and initial manifest are
  written, and run driver close, teardown, VTT, and slideshow concurrently
  with it via `Promise.all`. Grading is already skipped for act replays and
  infra-status runs (`runner.js:897`) — preserve both gates.
- Error semantics: a teardown or slideshow failure must produce the same
  final status/exit behavior as today; decide join-order explicitly and
  test failure combinations (grade ok + teardown fails, grade fails +
  teardown ok).

### T4.2 Separate actor and grader concurrency permits

Verified: `schedulePool` (`runner.js:1826-1875`) holds the `record` permit
across all of `runCase()` including grading; external environments force the
pool to 1 (`runner.js:1904`), where this change is a no-op.

Change: release the record permit once the recording (driver work) is done,
and take a separate bounded grader permit for `gradeRun()` plus a CPU permit
for slideshow/artifact generation. Keep a total-cases cap and an independent
grader cap so freed actor slots don't translate into grader-gateway 429s or
RSS spikes. Configuration: extend the existing `parallel` config shape;
document defaults in README if the surface is user-visible.

Tests: scheduler unit tests with fake clocks/tasks asserting that a second
recording starts while the first case grades, that caps hold, and that
failure of a graded case doesn't leak permits. Suite-level throughput check
via the Phase 0 harness at concurrency 2 and 4.

## Phase 5 — Smaller wins (each optional, measure-first)

- **T5.1 HAR append journal.** `flushHar` (`src/core/drivers/har.js:84-104`)
  restringifies the entire HAR every fifth step — the real quadratic write
  on long runs. Write an append-only `har.journal.jsonl` during the run and
  finalize to `har.json` at close (and on crash-recovery read paths, if
  any). Keep `har.json`'s final shape identical.
- **T5.2 In-memory inputs for `writeVideoSidecar()`/`gradeRun()`.** Both
  reread trajectory/manifest the runner already holds
  (`clip.js:568`, `grader.js:202`). Pass immutable in-memory data with the
  file-read path kept as fallback for external callers. Small win; do only
  if touching those modules anyway in Phase 4.
- **T5.3 context.jsonl delta format.** Downgraded from the analysis: writes
  are already appends; only total bytes grow quadratically. Defer unless
  long API runs (1.1 MB p90 at 60 steps) become a practical problem.

## Explicitly deferred (not build work)

- **Batched multi-assert gate sessions** (`gate.js:86-117`,
  `grader.js:511-576`, `MAX_VERDICT_TURNS = 6`): no repository case declares
  more than one `assert`. Revisit when real suites do.
- **Vision payload reduction** (smaller model-facing edge, conditional
  vision, on-demand screenshot tool): quality experiment, not an
  optimization. Requires a fixed evaluation corpus comparing completion,
  finding recall, false positives, tokens, and wall time. Never ship from
  latency data alone.

## Global acceptance

After each phase, rerun the Phase 0 harness (short + long run, concurrency
1/2/4) and require:

- end-to-end p50/p95 not regressed, targeted spans improved;
- identical action/grade schemas and statuses; no increase in state-drift,
  confusion, or actor retries on the fixtures;
- no artifact advertised by an envelope or manifest that is missing on disk;
- for T1.1 specifically, the mock-client assertion that a post-action
  snapshot consumes settle's source with zero extra `getPageSource()` calls.
