# Live runs build plan

Date: 2026-07-28
Source: [`DESIGN.md`](./DESIGN.md). Revised twice same day after two
independent static reviews against HEAD; every fact below was re-verified
against source at second revision. The async-axe work moved to its own
item, [`docs/backlog/async-axe.md`](../async-axe.md). Re-verify anchors
before each phase — line numbers rot, invariants shouldn't.

Verified facts the phases lean on (including the sharp edges):

- `RunWriter.appendEnvelope` appends `trajectory.jsonl` synchronously; the
  sole in-place mutation is `rewriteLast()` on the terminal envelope
  (`packages/core/src/trajectory.ts`). Step artifacts hit disk behind an
  awaited barrier *before* the envelope naming them is appended
  (`packages/core/src/drivers/web.ts`, `captureSnapshot`).
- **Every engine event is persisted synchronously** to `events.jsonl`
  (`runner.ts` emit → `writer.appendEvent`, an `appendFileSync`), and
  `case_end` is emitted **after the finishing tail** — grading, video, and
  every manifest rewrite (`runner.ts:~1107`; the infra path emits its own
  `case_end`). One crash path bypasses the writer (`runAll`'s catch calls
  `onEvent` directly), leaving no terminal event — such a run reads as
  open-but-inactive, which is honest.
- The placeholder manifest is written with terminal-looking status
  `interrupted` *after* the `case_start` event; the "final" manifest write
  precedes the tail rewrites. Manifest contents indicate neither liveness
  nor sealedness.
- The local viewer host reads fresh bytes per request and tolerates
  mid-write files (`packages/run-viewer/src/node/index.ts`); its
  `listRuns`/`history` **read manifests verbatim**, so an open run
  currently projects `interrupted` and pollutes local history — L0 fixes
  both. The viewer itself loads a run exactly once (`app.ts`, `loadRun`).
- Hosted serving: `runEntry` precedence is **sibling artifact first**, then
  bundle, then a hard 404; `runs.json` takes status from
  `manifest.result.status`; `history.json` includes every non-null
  manifest (`viewer-adapter.ts`).
- `ObjectStore` (`put/get/getRange/has/delete/list`, no append) **cannot
  share a transaction with SQLite**; the retention sweep deletes any
  `runs/`-prefixed object without an `artifacts.key` row in the same cycle
  (`retention/worker.ts`, `orphanRunObjects`). Hence the two-phase
  artifact ledger and SQLite-resident trajectory staging.
- A failed bundle upload makes the runner report terminal `infra` with no
  bundle (`exec-group.ts`); the reconciler marks a dead runner's in-flight
  runs `infra` (`dispatch/reconciler.ts`).
- In container mode, **streamed engine events carry container paths**
  (`/ws/...`); only the final result is translated back to host paths
  (`case-runner.ts`, `translatePaths` on `result` only).
- The progress snapshot the runner POSTs carries `{step, max_steps, doing,
  action, cost_usd, model, tokens}` and the control plane **whitelists
  exactly those fields** (`executor-api.ts`, `progressView`) — a new field
  would be silently dropped, which is why the live endpoint reuses the
  progress fold instead of inventing a `phase` vocabulary.
- The runner-agent coalesces engine events at ~2 s (`exec-group.ts`,
  `progressReporter` — the fold to extract and share); the feed long-poll
  holds requests via `FeedWaker` woken post-commit.

Rules for every phase:

- The sealed `.ptrun` and final case report are byte-for-byte unchanged.
  Live anything is best-effort *at the case boundary*: no live failure may
  change a run's status, ordering, timing semantics, or sealed artifacts.
  Within the live path itself, calls are acknowledged, idempotent, and
  ordered — the queue is reliable; only the run's indifference to it is
  "best-effort".
- `npm test` stays offline, Node-only, zero-skip. Control-plane phases get
  hermetic integration tests against a temp SQLite data root, as today.
- Each phase lands as its own reviewable change with its tests. Contract
  edits land in the same change as the behavior they describe.
- New modules are strict TypeScript; follow the owning package's
  conventions; browser code keeps `.js` relative specifiers.
- Trajectory ordering is sacred: every consumer must observe envelope
  append order identical to today, in every phase.

## Phase L0 — Viewer live mode against the local host

The viewer contract first, hermetically, with no platform involvement.
This phase defines the live protocol both hosts implement.

### L0.1 Liveness from the event stream

- No new artifact. Local liveness reads `events.jsonl`: `case_start`
  present with no terminal `case_end` = open; terminal event = sealed;
  no `events.jsonl` = legacy sealed run.
- Core change (one small slice): the SIGINT flusher — which already
  durably writes the placeholder manifest — additionally appends a
  terminal event, so Ctrl-C seals. `kill -9` leaves an open-but-inactive
  run, by design.
- The shared progress fold: extract the pure event→snapshot folding from
  `exec-group.ts`'s `progressReporter` into core (the runner-agent
  re-imports it; behavior identical). The local host uses it over
  `events.jsonl`; L1's endpoint uses it over the stored snapshot.
- Contract: `docs/contracts/engine.md` documents `case_end`-after-tail as
  load-bearing plus the SIGINT terminal event. `artifacts.md` untouched.

### L0.2 Live endpoint and live projections on the local host

- `GET <run base>/live?after=<line>&wait=<s>` on
  `packages/run-viewer/src/node/index.ts`, answering exactly the
  DESIGN.md shape: `{ open, reset, next, has_more, lines,
  manifest_generation, progress, inactive_ms }`.
- Line-number cursor (host keeps a private line→byte index; whole lines
  only, partial trailing line held for the next poll). A cursor beyond
  the host's truth, or an index the host had to rebuild inconsistently,
  answers `reset: true`.
- Response caps (bytes and lines) with `has_more`; growth detected by
  stat poll while holding, bounded `wait` like the feed's 25 s cap.
  `manifest_generation`: host-minted monotonic counter bumped when the
  manifest's `(mtimeMs, size)` changes; clients compare inequality only.
  `progress` from the shared fold; `inactive_ms` from the last
  `events.jsonl` append.
- **Local live projections**: `listRuns` and `history` stop reading open
  runs' placeholder manifests verbatim — an open run projects a live
  status with no verdict in `runs.json` and is excluded from
  `history.json`/`changed.json` until sealed, mirroring L1's hosted
  projection rule.
- Absent or sealed runs answer `open: false` immediately. The route is
  additive; every existing route and its degradation is untouched.

### L0.3 Live mode in the viewer

- `packages/run-viewer/src/web/app.ts`: one probe at load; on `open: true`
  enter live mode — long-poll loop (single in-flight request, immediate
  drain while `has_more`, jittered backoff on error, full reload on
  `reset`), append parsed lines to run state, refetch `manifest.json` on
  generation bump.
- Follow mode on by default; disengaged by any explicit step selection;
  re-engaged by a "Live" control. Repaints preserve focus, selection, and
  open panels (house rule).
- Pending row rendered from `progress` ("recording step 7 of 20",
  "grading"; never step-budget arithmetic); ● live badge; sustained
  `inactive_ms` renders neutral inactivity copy, never an abandonment
  claim; seal transition via one full reload on `open: false` (lands
  `rewriteLast`, `grade.json`, video), then stop.
- No behavior change for sealed runs or hosts without the route (probe
  404 → today's exact behavior).

Tests: node-host unit tests (event-stream liveness incl. legacy and
missing-terminal-event runs, SIGINT sealing, append detection, held poll
waking, partial-line handling, caps + `has_more` paging, `reset`
answering, generation bumps, inactivity reporting, live picker/history
projections); a hermetic integration test driving a real recording run in
one process while a fetch-based client follows the live endpoint and
asserts it observes every envelope in order through paging, then the
terminal transition; a shared-fold equivalence test (fold over
`events.jsonl` ≡ fold over the same events streamed). Browser viewer
test: live-mode append, follow-mode engage/disengage, pending-row
behavior, inactivity copy, seal transition.

Acceptance (the local benchmark): `playtest view` against a run dir being
recorded by another process streams steps without reload and transitions
to the sealed view — grade panel included — at completion; a SIGKILLed
recording shows open with growing inactivity, a Ctrl-C'd one seals.
`npm test`, `npm run test:viewer`, and `test:mobile` (the SIGINT-flusher
slice touches the runner) green.

### L0 contract

`docs/contracts/interfaces.md`: the `live` viewer route (shape, line
cursors, paging, `reset`), required degradation when absent, and the
local live projections — in this phase, so L1 implements against a
written contract.

## Phase L1 — Control-plane open runs: ingest, staging, serving

The platform side, end to end against hermetic integration tests, before
any runner sends real traffic.

### L1.1 Staging ledger and ingest routes

- **Two staging shapes, split by transactionality** (DESIGN.md):
  - *Trajectory batches and manifest snapshots in SQLite* — ledger rows
    holding the text, keyed and ordered by line range, carrying the
    authoritative line count and byte budget. Accepting a batch is one
    transaction; reading is one indexed query; cleanup is `DELETE`.
  - *Step artifacts in the object store* under a **two-phase ledger
    row**: reserve `pending` (budget charged, key recorded) → object
    `put` → mark `ready` (size, hash). Readers serve `ready` only.
    Retention treats both states as owned; stale `pending` rows (crashed
    uploads) are reaped on the grace schedule, their reservation
    refunded. The orphan sweep never sees an unowned live object.
- `POST /runner/groups/:g/cases/:run_id/open` — body: the placeholder
  manifest (size-capped ~1 MiB). Stores it on the run row, sets
  `live_opened_at` (new nullable column; the status machine is
  untouched). Idempotent.
- `PUT /runner/runs/:r/live/<entry-path>` — `(run, entry path)` unique
  and immutable: identical-bytes retry (hash match) returns the original
  ack without double-charging budget; different bytes for an existing
  path are refused. Entry paths validated against the step-artifact
  shape (no traversal); per-entry and per-run budget (bundle limit as
  ceiling). **Every answer is an explicit JSON ack**: accepted, or
  refused-with-reason (budget, terminal, shape, immutability). Refusal
  is a normal answer the uploader acts on, never a silent success.
- `POST /runner/runs/:r/live/trajectory` — `{ from_line, lines }` against
  the ledger's count: overlap resends are **verified** (stored-prefix
  hash must match) then deduplicated; a divergent resend is refused; a
  gap is refused with the count so the uploader rewinds.
- All routes behind `requireRunner` with the run-group check, like the
  bundle PUT; all answer refused/no-op once the run is terminal.

### L1.2 Serving, virtual entries, and the hosted live endpoint

- `runEntry` precedence: **sibling → sealed bundle → staged live
  artifact (`ready` rows only)** — the existing sibling-over-bundle
  order for generated clips is preserved exactly.
- Two virtual entries for open runs: `manifest.json` from the run row
  (works from `open` onward) and `trajectory.jsonl` concatenated from
  the SQLite ledger.
- Picker projection from DB state: an open run (`live_opened_at` set,
  status non-terminal) reports a live status and no verdict — never the
  placeholder's `interrupted`. Open runs are excluded from
  `history.json` and `changed.json` until sealed.
- Hosted `live` endpoint implementing the L0 contract exactly: line
  cursor over the ledger, caps + `has_more`, `reset` for unhonorable
  cursors, `manifest_generation` from the row's snapshot generation,
  `progress` = the stored progress snapshot passed through the shared
  fold's view shape, `inactive_ms` from last ingest/progress arrival.
  Holders woken by live ingest through the feed-waker mechanism (or a
  sibling waker keyed by run).

### L1.3 Seal, cleanup, and GC

- Staging is deleted **only when a verified sealed bundle exists**: on
  the case report following a successful bundle upsert — ledger rows in
  the report transaction, staged objects after it commits. A terminal
  report without a bundle (failed upload → `infra`; reconciler-failed
  runs) leaves staging through the retention grace window: it is the
  only evidence the run produced.
- Retention worker: GC staging (ledger rows and objects together, plus
  stale `pending` reservations) for terminal runs without a bundle after
  the grace window (default ~24 h). Deleting a ledger row re-exposes its
  object to the orphan sweep as the backstop.
- Startup/orphan parity with the storage plan: a ledger row whose run
  row is gone is itself orphaned and collected.

Tests: hermetic control-plane integration — open → acked staged ingest
(identical-bytes retry single-charge, divergent-bytes refusal, overlap
verify-and-dedupe, divergent-resend refusal, gap refusal + rewind, budget
refusal) → virtual manifest/trajectory + `ready`-only PNGs served
pre-bundle → live endpoint pages a polling client through a backlog then
streams → seal with bundle → staging gone, sealed serving byte-identical
to a never-live run → seal *without* bundle (infra) → staging survives,
GC collects after grace, `pending` reservations reaped and refunded;
picker shows live status and excludes open runs from history/changed;
terminal no-op ingest; auth failures; the retention orphan sweep run
mid-stream never touches owned staging. `npm run hosted:test` and the
integration suite green.

### L1 contract

`docs/contracts/hosted.md`: runner-protocol additions with ack and
idempotency semantics, the two staging shapes and their lifecycle,
budgets, live projections and history exclusion, and the
viewability-before-bundle statement — in this phase.

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
  the final result is translated, and reads artifacts from the
  translated locations. (Isolated-child mode needs no translation.)
- Acks drive the queue: refused artifact ⇒ its lines stay queued;
  divergence or gap refusal ⇒ rewind/resync from the answered count;
  transport failure ⇒ pause, retry next tick from the same position.
  Bounded memory (byte offsets, never buffered run dirs); if the queue
  falls hopelessly behind or the budget is exhausted, the uploader stops
  itself — the case never notices.
- **Shutdown is explicit and owned by the case scheduler**: `stop()` in
  the same `finally` that stops the progress reporter — clears the tick
  timer, aborts any in-flight request (`AbortController`), and drops the
  queue — *before* the final report and before workspace cleanup, so no
  background read races the workspace teardown and no open handle keeps
  the runner alive. Cancellation (docker-stopped, SIGTERM drain) flows
  through the same path.
- Works identically under local dispatch and pool mode (same exec path).

Tests: runner unit tests with a fake acked API server — in-order
single-flight shipping, artifact-before-line enforcement under refusals,
identical-retry and divergence handling, overlap/rewind recovery after
lost acks, budget-refusal shutdown, container path translation (fake
`/ws/` events), manifest-readiness gating (no `open` before the
placeholder exists), and shutdown: case end with an in-flight request
aborts it, leaks no timer or handle, and never delays the report.
Hermetic end-to-end: local dispatch run observed live through the hosted
live endpoint while executing, then sealed byte-identical.

Acceptance (the hosted benchmark, parts 1–3): `npm run hosted`, watch a
live run stream in the embedded viewer, seal transitions in place;
killing the runner mid-case leaves an `infra` run whose staging survives
the grace window and is then collected. `npm run runner:test` and all
hosted suites green.

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
  pending row, inactivity copy, watch affordance).

Tests: hosted web build green; ux-lab scenario recorded; feed handling
regression tests for the seal transition.

## Sequencing and independence

```
L0 ── L1 ── L2 ── L3    (strict chain)
      └── contract-first: L0 writes interfaces.md, L1 writes hosted.md
```

L0 touches core (the SIGINT terminal event, the extracted progress fold)
and the viewer package. L1 only the control plane. L2 only the
runner-agent. L3 only the hosted web app. Phases can be reverted alone;
L2 without L1 sends traffic that gets refused acks and stops itself
(harmless by design), and L1 without L2 serves nothing new (also
harmless). The async-axe item ([`docs/backlog/async-axe.md`](../async-axe.md))
is fully independent of this chain.

## Global acceptance

- The four-part benchmark in DESIGN.md passes on a laptop.
- A sealed run recorded with live streaming enabled is byte-identical to
  one recorded without (bundle hash equality on a fixture run).
- No increase in run wall time at suite concurrency 4 on the perf
  harness (`tools/perf/baseline.mjs`) — the uploader must be invisible
  to the recording it observes.
- Every suite green: `npm test` (zero skips), `test:viewer`,
  `test:browser`, `hosted:test`, control-plane integration,
  `runner:test`, and `test:mobile` for the L0 runner slice.
