# Live runs build plan

Date: 2026-07-28
Source: [`DESIGN.md`](./DESIGN.md). Revised same day after an independent
static review against HEAD; every fact below was re-verified against source
at revision time. Re-verify anchors before each phase — line numbers rot,
invariants shouldn't.

Verified facts the phases lean on (including the sharp edges):

- `RunWriter.appendEnvelope` appends `trajectory.jsonl` synchronously; the
  sole in-place mutation is `rewriteLast()` on the terminal envelope
  (`packages/core/src/trajectory.ts`). Step artifacts hit disk behind an
  awaited barrier *before* the envelope naming them is appended
  (`packages/core/src/drivers/web.ts`, `captureSnapshot`).
- The placeholder manifest is written with **terminal-looking status
  `interrupted`** (that is its crash-evidence job), *after* the
  `case_start` event is emitted; the "final" manifest write precedes the
  tail's grade-totals and video rewrites (`packages/core/src/runner.ts`).
  Manifest status therefore indicates neither liveness nor sealedness —
  hence the explicit open marker (DESIGN.md, "What open and sealed mean").
- Snapshot capture **mutates the DOM**: it strips every `data-dummy-ref`
  attribute and assigns fresh ones per call
  (`packages/core/src/snapshot-injected.ts`). Nothing may scan the page
  concurrently with a capture.
- The local viewer host reads fresh bytes per request and already tolerates
  mid-write files (`packages/run-viewer/src/node/index.ts`); the viewer
  itself loads a run exactly once (`packages/run-viewer/src/web/app.ts`,
  `loadRun`) with no refresh path.
- Hosted serving: `runEntry` precedence is **sibling artifact first**, then
  bundle, then a hard 404 ("no bundle yet"); `runs.json` takes status from
  `manifest.result.status` and lists any run with a non-null manifest;
  `history.json` includes every non-null manifest
  (`packages/platform/control-plane/src/api/viewer-adapter.ts`).
- The retention sweep treats **any `runs/`-prefixed object without an
  `artifacts.key` row as an orphan and deletes it in the same cycle**
  (`packages/platform/control-plane/src/retention/worker.ts`,
  `orphanRunObjects`). Staging must be ledger-owned from its first byte.
- A failed bundle upload makes the runner report terminal `infra` with no
  bundle (`packages/platform/runner-agent/src/exec-group.ts`, the
  try/catch around `uploadBundle`); the reconciler marks a dead runner's
  in-flight runs `infra` (not "lost";
  `packages/platform/control-plane/src/dispatch/reconciler.ts`).
- In container mode, **streamed engine events carry container paths**
  (`/ws/...`); only the final result is translated back to host paths
  (`packages/platform/runner-agent/src/case-runner.ts`, `translatePaths`
  on `result` only).
- The runner-agent coalesces engine events at ~2 s (`exec-group.ts`,
  `progressReporter`); `ObjectStore` has `put/get/getRange/has/delete/list`
  and **no append**; the feed long-poll holds requests via `FeedWaker`
  woken post-commit.
- Axe: awaited inline in the web driver's `#run()` after settle; consumers
  are end-of-run only; `docs/contracts/artifacts.md` already declares the
  field best-effort/possibly-absent, with no comparability pin.

Rules for every phase:

- The sealed `.ptrun` and final case report are byte-for-byte unchanged.
  Live anything is best-effort *at the case boundary*: no live failure may
  change a run's status, ordering, timing semantics, or sealed artifacts.
  Within the live path itself, calls are acknowledged and ordered — the
  queue is reliable; only the run's indifference to it is "best-effort".
- `npm test` stays offline, Node-only, zero-skip. Control-plane phases get
  hermetic integration tests against a temp SQLite data root, as today.
- Each phase lands as its own reviewable change with its tests. Contract
  edits land in the same change as the behavior they describe.
- New modules are strict TypeScript; follow the owning package's
  conventions; browser code keeps `.js` relative specifiers.
- Trajectory ordering is sacred: every consumer must observe envelope
  append order identical to today, in every phase.

## Phase A0 — Async axe capture

Independent scope: lands first, ships alone, and no live-run phase depends
on it.

- Web driver: `#run()` returns the `ExecResult` without a scan; a
  `startAxeScan()` seam exposes the deferred scan to the runner. Terminal
  `captureAxe()` is unchanged.
- Runner ordering (the DOM-safety-correct sequence): step N executes and
  settles → step N+1's snapshot capture completes (the capture mutates
  `data-dummy-ref` attributes, so the scan must not overlap it) → the scan
  starts, concurrent only with the actor request — no other page operation
  exists in that window by construction. A dispatch barrier guarantees the
  scan settles before action N+1 performs.
- Step N's envelope append latches on the scan settling (result or
  swallowed failure — absent field, as today); appends stay strictly
  step-ordered (N before N+1, always).
- The final recorded step's scan resolves against the terminal
  `captureAxe()` path unchanged; act/heal loops mirror the same seam.
- The `axe` perf span keeps measuring scan duration; add `blocked_ms`
  meta recording how long the dispatch barrier waited (expected ~0; this
  is acceptance evidence).
- Contract: timing clarification in `docs/contracts/engine.md` — still
  "after settled actions, best-effort", now overlapped with the actor
  request; note that violation HTML snippets may carry the successor
  snapshot's ref attributes. No schema or pin changes.

Tests: hermetic runner test asserting envelope order and axe *semantics*
(rules, targets, counts) identical on a fixed fixture; a slow-scan test
asserting the dispatch barrier holds and the envelope still carries the
result; a rejecting-scan test asserting the field is absent and the run
unaffected; a browser-suite assertion that no page operation overlaps a
scan (instrument the driver's operation log in test). Browser suite
otherwise green unchanged; `test:mobile` green (runner loop touched).

Acceptance: axe removed from the blocking path — step-loop wall time on
the browser fixture drops by roughly the axe p50; `blocked_ms` ~0 on
fixtures; envelope append order byte-identical; axe fields semantically
identical (snippet attribute bytes exempt).

## Phase L0 — Viewer live mode against the local host

The viewer contract first, hermetically, with no platform involvement.
This phase defines the live protocol both hosts implement.

### L0.1 The local open signal

- `RunWriter` creates an open marker file in the run dir at birth; the
  runner removes it at the true end of the finishing tail — after the
  grade-totals and video manifest rewrites, i.e. after both tail jobs
  join — and in the SIGINT flusher path. Manifest status is never
  consulted for liveness (it cannot be: the placeholder says
  `interrupted` and the final write precedes tail rewrites).
- Contract: marker name and lifecycle in `docs/contracts/artifacts.md`
  (run-dir lifecycle) and `docs/contracts/engine.md`. The marker is
  excluded from bundles.

### L0.2 Live endpoint on the local viewer host

- `GET <run base>/live?after=<cursor>&wait=<s>` on
  `packages/run-viewer/src/node/index.ts`, per the DESIGN.md response
  shape: `{ open, stale?, cursor, has_more, lines, manifest_generation,
  phase }`.
- `open` from the marker; `stale: true` when the marker exists but the
  trajectory has not grown past a threshold (abandoned run). `phase` from
  the run dir's event stream (`events.jsonl`), falling back to "recording"
  when unavailable.
- Opaque cursor (byte-offset-derived); unrecognizable/out-of-range cursors
  answer a full-resync indication. Whole appended lines only (partial
  trailing line held for the next poll). Response caps (bytes and lines)
  with `has_more`; the host detects growth by stat poll while holding,
  bounded `wait` like the feed's 25 s cap.
- Absent or sealed runs answer `open: false` immediately. The route is
  additive; every existing route and its degradation is untouched.

### L0.3 Live mode in the viewer

- `packages/run-viewer/src/web/app.ts`: one probe at load; on `open: true`
  enter live mode — long-poll loop (single in-flight request, immediate
  drain while `has_more`, jittered backoff on error, full reload on a
  resync answer), append parsed lines to run state, refetch
  `manifest.json` on generation bump.
- Follow mode on by default; disengaged by any explicit step selection;
  re-engaged by a "Live" control. Repaints preserve focus, selection, and
  open panels (house rule).
- Pending row rendered from `phase` (never from step-budget arithmetic);
  ● live badge, "stalled" for `stale`, seal transition via one full reload
  on `open: false` (lands `rewriteLast`, `grade.json`, video), then stop.
- No behavior change for sealed runs or hosts without the route (probe
  404 → today's exact behavior).

Tests: node-host unit tests (marker liveness, staleness, append detection,
held poll waking, partial-line handling, caps + `has_more` paging, cursor
resync, terminal answer); a hermetic integration test driving a real
recording run in one process while a fetch-based client follows the live
endpoint and asserts it observes every envelope in order through paging,
then the terminal transition; marker-removal ordering test (marker gone ⇒
grade/video rewrites already on disk). Browser viewer test: live-mode
append, follow-mode engage/disengage, pending-row phase behavior, seal
transition.

Acceptance (the local benchmark): `playtest view` against a run dir being
recorded by another process streams steps without reload and transitions
to the sealed view — grade panel included — at completion; a SIGKILLed
recording shows stalled, not live. `npm test` and `npm run test:viewer`
green.

### L0 contract

`docs/contracts/interfaces.md`: the `live` viewer route, its long-poll,
paging, and resync semantics, and required degradation when absent — in
this phase, so L1 implements against a written contract.

## Phase L1 — Control-plane open runs: ingest, staging, serving

The platform side, end to end against hermetic integration tests, before
any runner sends real traffic.

### L1.1 Staging ledger and ingest routes

- **Staging ledger**: per-run staged-object rows (key, size, seq/generation
  state, timestamps) written in the same transaction as each accepted
  increment. This is load-bearing three ways: the retention sweep's
  orphan detection deletes any unowned `runs/` object same-cycle, so
  ownership must exist from the first byte; budgets need byte accounting;
  and the trajectory's authoritative line count lives here.
- `POST /runner/groups/:g/cases/:run_id/open` — body: the placeholder
  manifest (size-capped ~1 MiB). Stores it on the run row, sets
  `live_opened_at` (new nullable column; the status machine is
  untouched). Idempotent.
- `PUT /runner/runs/:r/live/<entry-path>` — staged object at
  `runs/<group>/<run>/live/<entry>`; entry paths validated against the
  step-artifact shape (no traversal); per-entry and per-run budget
  (bundle limit as ceiling). **Every answer is an explicit JSON ack**:
  accepted, or refused-with-reason (budget, terminal, shape). Refusal is
  a normal answer the uploader acts on, never a silent success.
- `POST /runner/runs/:r/live/trajectory` — `{ from_line, lines }` against
  the ledger's authoritative count: overlap-tolerant (duplicate prefix
  dropped, new suffix appended), gap-refusing (answer carries the count
  so the uploader rewinds). Stored as segment objects; manifest snapshots
  ride a sibling shape and replace the row copy, bumping a generation.
- All routes behind `requireRunner` with the run-group check, like the
  bundle PUT; all answer refused/no-op once the run is terminal.

### L1.2 Serving, virtual entries, and the hosted live endpoint

- `runEntry` precedence: **sibling → sealed bundle → staged live object**
  (staging is a new last rung; the existing sibling-over-bundle order for
  generated clips is preserved exactly).
- Two virtual entries for open runs: `manifest.json` from the run row
  (works from `open` onward, independent of staged uploads) and
  `trajectory.jsonl` as the ordered concatenation of staged segments.
- Picker projection from DB state: an open run (`live_opened_at` set,
  status non-terminal) reports a live status and no verdict — never the
  placeholder's `interrupted`. Open runs are excluded from `history.json`
  and `changed.json` until sealed.
- Hosted `live` endpoint on the viewer adapter implementing the L0
  contract: lines from the ledger/segments (opaque line-derived cursor,
  caps + `has_more`, resync), `phase` from the latest progress snapshot,
  holders woken by live ingest through the feed-waker mechanism (or a
  sibling waker keyed by run).

### L1.3 Seal, cleanup, and GC

- Staging is deleted **only when a verified sealed bundle exists**: on the
  case report following a successful bundle upsert (delete after the row
  update commits). A terminal report without a bundle — failed upload
  (`infra`), reconciler-failed run — leaves staging in place: it is the
  only evidence the run produced.
- Retention worker: GC staging (ledger rows + objects together) for
  terminal runs without a bundle after a grace window (default ~24 h);
  ledger-owned objects are invisible to the orphan sweep by construction,
  and deleting a ledger row re-exposes its object to that sweep as the
  backstop.
- Startup/orphan parity with the storage plan: a ledger row whose run row
  is gone is itself orphaned and collected.

Tests: hermetic control-plane integration — open → acked staged ingest
(including overlap resend, gap refusal, budget refusal answers) → virtual
manifest/trajectory + PNGs served pre-bundle → live endpoint pages a
polling client through a backlog then streams → seal with bundle → staging
gone, sealed serving byte-identical to a never-live run → seal *without*
bundle (infra) → staging survives, GC collects after grace; picker shows
live status and excludes the open run from history/changed; terminal
no-op ingest; auth failures; retention sweep never touches ledger-owned
staging. `npm run hosted:test` and the integration suite green.

### L1 contract

`docs/contracts/hosted.md`: runner-protocol additions with ack semantics,
the staging ledger lifecycle, budgets, live projections and history
exclusion, and the viewability-before-bundle statement — in this phase.

## Phase L2 — Runner-agent live uploader (end to end)

- A live uploader beside `progressReporter` in
  `packages/platform/runner-agent/src/exec-group.ts`: **one serialized,
  single-flight queue per case**, ticking at the same ~2 s cadence,
  shipping in run-dir order: (1) new step artifacts, (2) the trajectory
  delta referencing only acked artifacts, (3) a manifest snapshot if
  rewritten. The seal path is untouched.
- **Opening waits for manifest readiness**, not `case_start`: the event
  precedes the placeholder write, so the uploader stats the run dir from
  the event's `runDir` and opens when the placeholder exists.
- **Container mode translates paths**: streamed events carry container
  paths (`/ws/...`); the uploader maps them to host paths the same way
  the final result is translated, and reads artifacts from the translated
  locations. (Isolated-child mode needs no translation.)
- Acks drive the queue: refused artifact ⇒ its lines stay queued; gap
  refusal ⇒ rewind to the answered count; transport failure ⇒ pause,
  retry next tick from the same position. Bounded memory (byte offsets,
  never buffered run dirs); if the queue falls hopelessly behind or the
  run's budget is exhausted, the uploader stops itself — the case never
  notices, the seal carries everything.
- Works identically under local dispatch and pool mode (same exec path).

Tests: runner unit tests with a fake acked API server — in-order
single-flight shipping, artifact-before-line enforcement under refusals,
overlap/rewind recovery after lost acks, budget-refusal shutdown, container
path translation (fake `/ws/` events), zero interference with the final
bundle/report under upload chaos, and manifest-readiness gating (no `open`
before the placeholder exists). Hermetic end-to-end: local dispatch run
observed live through the hosted live endpoint while executing, then
sealed byte-identical.

Acceptance (the hosted benchmark, parts 1–3): `npm run hosted`, watch a
live run stream in the embedded viewer, seal transitions in place; killing
the runner mid-case leaves an `infra` run whose staging survives the grace
window and is then collected. `npm run runner:test` and all hosted suites
green.

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
  pending row, stalled state, watch affordance).

Tests: hosted web build green; ux-lab scenario recorded; feed handling
regression tests for the seal transition.

## Sequencing and independence

```
A0 ──────────────────────────────   (independent; ships alone)
L0 ── L1 ── L2 ── L3                (strict chain)
      └── contract-first: L0 writes interfaces.md, L1 writes hosted.md
```

A0 touches core (driver + runner step loop). L0 touches core's run writer
(the marker) and the viewer package. L1 only the control plane. L2 only
the runner-agent. L3 only the hosted web app. Phases can be reverted
alone; L2 without L1 sends traffic that gets refused acks and stops itself
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
  `runner:test`, and `test:mobile` for the A0 and L0 runner-loop/writer
  changes.
