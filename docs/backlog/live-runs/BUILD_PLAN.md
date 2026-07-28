# Live runs build plan

Date: 2026-07-28
Source: [`DESIGN.md`](./DESIGN.md). Code-level claims below were verified
against source at authoring time (post perf-plan, `350e661`); re-verify
anchors before each phase — line numbers rot, invariants shouldn't.

Verified facts the phases lean on:

- `RunWriter.appendEnvelope` appends `trajectory.jsonl` synchronously; the
  sole in-place mutation is `rewriteLast()` on the terminal envelope
  (`packages/core/src/trajectory.ts`). Step artifacts hit disk behind an
  awaited barrier *before* the envelope naming them is appended
  (`packages/core/src/drivers/web.ts`, `captureSnapshot`).
- A valid `interrupted` placeholder manifest is written before step one and
  re-flushed on SIGINT (`packages/core/src/runner.ts`).
- The local viewer host reads fresh bytes per request and already tolerates
  mid-write files (`packages/run-viewer/src/node/index.ts`); the viewer
  itself loads a run exactly once (`packages/run-viewer/src/web/app.ts`,
  `loadRun`) with no refresh path.
- The hosted picker lists a run only when `runs.manifest` is non-null,
  written today only by the final case report (`executor-api.ts`,
  `caseReport`); `runEntry` (`viewer-adapter.ts`) already resolves
  bundle-entry → sibling-artifact in order.
- The runner-agent coalesces engine events at ~2 s (`exec-group.ts`,
  `progressReporter`); `ObjectStore` has `put/get/getRange/has/delete/list`
  and **no append**; the feed long-poll holds requests via `FeedWaker`
  woken post-commit.
- Axe: awaited inline in the web driver's `#run()` after settle; consumers
  are end-of-run only; `docs/contracts/artifacts.md` already declares the
  field best-effort/possibly-absent.

Rules for every phase:

- The sealed `.ptrun` and final case report are byte-for-byte unchanged.
  Live anything is best-effort: no live failure may change a run's status,
  ordering, timing semantics, or sealed artifacts.
- `npm test` stays offline, Node-only, zero-skip. Control-plane phases get
  hermetic integration tests against a temp SQLite data root, as today.
- Each phase lands as its own reviewable change with its tests. Contract
  edits land in the same change as the behavior they describe.
- New modules are strict TypeScript; follow the owning package's
  conventions; browser code keeps `.js` relative specifiers.
- Trajectory ordering is sacred: every consumer must observe envelope
  append order identical to today, in every phase.

## Phase A0 — Async axe capture

Independent of the live-run phases; lands first because it is small and
touches the step-loop seam L2 later observes.

- Web driver: `#run()` starts the axe scan after settle and returns the
  `ExecResult` without awaiting it; the pending scan travels alongside (not
  inside) the result. `captureAxe()` for terminal steps is unchanged.
- Runner: step N's envelope append latches on the scan settling (result or
  swallowed failure — absent field on failure, as today); step N+1's
  snapshot capture and actor request proceed meanwhile. A dispatch barrier
  guarantees no action executes while a scan is in flight.
- Envelope appends stay strictly step-ordered: N's append happens-before
  N+1's append regardless of scan latency.
- The `axe` perf span keeps measuring scan duration; add a `blocked_ms`
  meta recording how long the dispatch barrier actually waited (expected
  ~0; this is the acceptance evidence).
- Contract: one-line timing clarification in
  `docs/contracts/engine.md` (still "after settled actions, best-effort").
  No schema, envelope, or pin changes.

Tests: hermetic runner test asserting envelope order and `axe` presence
identical to before on a fixed fixture; a test where the scan resolves
slower than the actor turn, asserting the dispatch barrier holds and the
envelope still carries the result; a test where the scan rejects, asserting
the field is absent and the run unaffected. Browser suite green unchanged.

Acceptance: `axe` span p50 unchanged but removed from the blocking path —
step-loop wall time on the browser fixture drops by roughly the axe p50;
`blocked_ms` ~0 on fixtures; zero trajectory diffs.

## Phase L0 — Viewer live mode against the local host

The viewer contract first, hermetically, with no platform involvement.
This phase defines the live protocol both hosts implement.

### L0.1 Live endpoint on the local viewer host

- `GET <run base>/live?after=<cursor>&wait=<s>` on
  `packages/run-viewer/src/node/index.ts`: answers from disk, detecting
  `trajectory.jsonl` growth (size-based cursor; stat poll internally while
  holding, bounded `wait` like the feed's 25 s cap).
- Response `{ open, cursor, lines, manifest_generation }` per DESIGN.md.
  `open` derives from the manifest status (non-terminal placeholder =
  open); `lines` are whole appended trajectory lines after the cursor
  (partial trailing line held for the next poll); `manifest_generation`
  from manifest mtime/size.
- Absent run or sealed run answers `open: false` immediately. The route is
  additive; every existing route and its degradation is untouched.

### L0.2 Live mode in the viewer

- `packages/run-viewer/src/web/app.ts`: one probe at load; on `open: true`
  enter live mode — long-poll loop (single in-flight request, jittered
  backoff on error), append parsed lines to run state, refetch
  `manifest.json` on generation bump, render new steps/screenshots in
  place.
- Follow mode on by default; disengaged by any explicit step selection;
  re-engaged by a "Live" control. Repaints preserve focus, selection, and
  open panels (house rule).
- Pending-step row for the in-flight step; ● live badge in the run header.
- On `open: false`: stop polling, one full reload through the normal load
  path (lands `rewriteLast`, `grade.json`, video), badge flips to sealed.
- No behavior change whatsoever for sealed runs or hosts without the route
  (probe 404 → today's exact behavior).

Tests: node-host unit tests for the live endpoint (append detection, held
poll waking on append, partial-line handling, terminal answer); a hermetic
integration test driving a real recording run in one process while a
fetch-based client follows the live endpoint and asserts it observes every
envelope in order, then the terminal transition. Browser viewer test:
live-mode append, follow-mode engage/disengage, seal transition.

Acceptance (the local benchmark): `playtest view` against a run dir being
recorded by another process streams steps without reload and transitions to
the sealed view at completion; `npm test` and `npm run test:viewer` green.

### L0 contract

`docs/contracts/interfaces.md`: the `live` viewer route, its long-poll
semantics, and required degradation when absent — in this phase, so L1
implements against a written contract.

## Phase L1 — Control-plane open runs: ingest, staging, serving

The platform side, end to end against hermetic integration tests, before
any runner sends real traffic.

### L1.1 Open and live ingest routes

- `POST /runner/groups/:g/cases/:run_id/open` — body: the placeholder
  manifest (size-capped ~1 MiB). Stores it on the run row's manifest
  column, marks the run live (new nullable `live_opened_at` on `runs`
  rather than a status — the status machine is untouched). Idempotent.
- `PUT /runner/runs/:r/live/<entry-path>` — staged object at
  `runs/<group>/<run>/live/<entry>`; entry paths validated against the
  step-artifact shape (no traversal, no absolute paths); per-entry and
  per-run budget (bundle limit as ceiling), over-budget silently refused
  with a 2xx — best-effort means the runner never needs to care.
- `POST /runner/runs/:r/live/trajectory` — `{ after_seq, lines }`; stored
  as segment `live/trajectory.<seq>.jsonl`; stale/duplicate seq ignored
  idempotently. Manifest snapshots ride the same route shape
  (`live/manifest.json`, whole small rewrite).
- All three behind `requireRunner` with the run-group check, exactly like
  the bundle PUT. Every route no-ops (2xx) once the run is terminal.

### L1.2 Serving and the hosted live endpoint

- `runEntry` fallback rung: bundle → sibling → staged live object.
- `runs.json` naturally lists open runs (manifest column is populated);
  verify the picker row renders sanely for a run with no verdict.
- Hosted `live` endpoint on the viewer adapter implementing the L0
  contract: trajectory delta from concatenated segments (cursor = byte
  offset in concatenation), `open` from run status + `live_opened_at`,
  woken by live ingest through the feed waker mechanism (or a sibling
  waker keyed by run) instead of stat polling.

### L1.3 Seal, cleanup, and GC

- On `caseReport` (any terminal status): delete the run's staged objects
  after the row update commits. The bundle supersedes staging entry for
  entry.
- Retention worker: GC staged objects for terminal runs without a recent
  seal (grace window, default ~24 h) — covers lost/crashed runs; the
  reconciler itself is untouched.
- Startup sweep parity with the existing orphan-object story from the
  storage plan: staging under a run prefix whose row is gone is orphaned
  and collected.

Tests: hermetic control-plane integration — open → staged ingest → viewer
adapter serves manifest/trajectory/PNGs pre-bundle → live endpoint streams
to a polling client → seal → staging gone, sealed serving byte-identical to
a never-live run; budget refusal; terminal no-op ingest; auth failures;
GC of an unsealed dead run. `npm run hosted:test` and the integration
suite green.

### L1 contract

`docs/contracts/hosted.md`: runner-protocol additions, staging lifecycle,
budgets, and the viewability-before-bundle statement — in this phase.

## Phase L2 — Runner-agent live uploader (end to end)

- A live uploader beside `progressReporter` in
  `packages/platform/runner-agent/src/exec-group.ts`, consuming the same
  `onEvent` stream plus run-dir reads: on each ~2 s tick ship, in order,
  (1) new step artifacts, (2) the trajectory delta, (3) a manifest
  snapshot if rewritten. Open on `case_start`; stop at case end (the seal
  path is untouched).
- Fire-and-forget with the progress reporter's exact posture: failures
  swallowed, next tick carries the delta, an unreachable control plane
  costs nothing but the attempt. Bounded memory: the uploader tracks byte
  offsets, never buffers the run dir.
- Honor the artifact-before-line invariant within a tick; a PNG that fails
  to upload defers its trajectory lines to the next tick rather than
  advertising it (mirror of the on-disk barrier).
- Works identically under local dispatch and pool mode (it is the same
  exec path).

Tests: runner unit tests with a fake API server — ordering within ticks,
delta correctness across ticks, failure deferral, budget-refusal
indifference, zero interference with the final bundle/report on upload
chaos. Hermetic end-to-end: local dispatch run observed live through the
hosted live endpoint while executing, then sealed byte-identical.

Acceptance (the hosted benchmark, parts 1–3): `npm run hosted`, watch a
live run stream in the embedded viewer, seal transitions in place; killing
the runner mid-case leaves a lost run whose staging the GC collects.
`npm run runner:test` and all hosted suites green.

## Phase L3 — Console polish

- Run page: the already-rendered iframe now streams; ensure the page's own
  chrome (status header, verdict slot) updates on seal via the feed it
  already consumes; no double-polling (the iframe owns the live loop, the
  page owns the feed).
- Runs list: "watch" affordance on live rows beside the existing progress
  patching; ● live badge consistent with the viewer's.
- ux-lab: extend the existing scenario tooling to cover a live run page
  (screenshot of streaming state, seal transition), closing the visual
  gap the same way the runners console work did.
- Copy pass over every new user-facing string (badge, follow control,
  pending row, watch affordance).

Tests: hosted web build green; ux-lab scenario recorded; feed handling
regression tests for the seal transition.

## Sequencing and independence

```
A0 ──────────────────────────────┐  (independent, land first)
L0 ── L1 ── L2 ── L3             │  (strict chain)
      └── contract-first: L0 writes interfaces.md, L1 writes hosted.md
```

A0 touches only core (driver + runner step loop). L0 touches only the
viewer package. L1 only the control plane. L2 only the runner-agent. L3
only the hosted web app. No phase edits another phase's files, so any
phase can be reverted alone; L2 without L1 sends traffic nobody answers
(harmless by design), and L1 without L2 serves nothing new (also
harmless).

## Global acceptance

- The four-part benchmark in DESIGN.md passes on a laptop.
- A sealed run recorded with live streaming enabled is byte-identical to
  one recorded without (bundle hash equality on a fixture run).
- No increase in run wall time at suite concurrency 4 on the perf
  harness (`tools/perf/baseline.mjs`) — the uploader must be invisible
  to the recording it observes.
- Every suite green: `npm test` (zero skips), `test:viewer`,
  `test:browser`, `hosted:test`, control-plane integration,
  `runner:test`, and `test:mobile` for the A0 runner-loop change.
