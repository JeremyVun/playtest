# Live runs: open runs streaming into the viewer

**Status:** proposed. Implementation phases and gates live in
[`BUILD_PLAN.md`](./BUILD_PLAN.md). Until those phases land,
[`docs/contracts/hosted.md`](../../contracts/hosted.md) and
[`docs/contracts/interfaces.md`](../../contracts/interfaces.md) remain
authoritative: a hosted run becomes viewable only when its sealed `.ptrun`
bundle and final case report have landed, and the viewer loads a run exactly
once per navigation.

## Problem

A hosted run is invisible while it executes. The runner-agent posts a coarse
progress snapshot (step counter, a redacted action string) every ~2 s, and
the console patches that into the runs list — but the actual evidence, the
thing Playtest exists to produce, arrives only as one `.ptrun` PUT after the
case *and its grading* have finished. The run-detail page already embeds the
viewer iframe for a running run today; it 404s into "No run found here" until
the seal lands. For a twenty-step web journey that is minutes of staring at a
step counter when the screenshots, the trajectory, and the story of the run
already exist on the runner's disk, step by step.

The local CLI has the same gap in a milder form: `playtest view` pointed at a
recording run dir happens to serve whatever is on disk (the storage provider
reads fresh bytes per request, and the runner writes a valid placeholder
manifest before the first step), but the viewer fetches everything once and
never looks again, so watching a run means hammering the reload key.

## Decision

Introduce an **open run**: a run whose artifacts stream into the platform
while it executes and which the viewer renders in real time, appending steps
as they land, then transitions in place to the sealed, graded run.

Three commitments shape everything below:

1. **The sealed bundle stays the sole authoritative artifact.** The live
   stream is telemetry-grade: best-effort, coalesced, droppable. A failed
   live upload never fails, delays, or re-orders a case; verdicts,
   retention decisions, and export never read live state. The final
   `.ptrun` PUT and case report are byte-for-byte what they are today.
2. **The live stream ships the same bytes the bundle would.** Redaction
   happens at write time in the core engine; a trajectory line or step PNG is
   no more sensitive mid-run than it is sealed. No new data class, no new
   redaction pass.
3. **One live protocol, two hosts.** The local `playtest view` server and the
   hosted viewer adapter implement the same small long-poll endpoint, and the
   viewer's live mode is host-agnostic. The feature is therefore hermetically
   testable end to end (viewer against local host against a real recording
   run) without the control plane, and local users get streaming for free.

Long-poll, not SSE or WebSocket: the platform already has exactly this
pattern (`events/feed` with `FeedWaker` holding requests up to 25 s), it
traverses proxies without ceremony, and one in-flight request per viewer tab
is the correct concurrency. The viewer is the only consumer; there is no
fan-out problem to solve.

## The benchmark

The design is done when this demo works on a laptop:

1. `npm run hosted`, launch a twenty-step web suite, and open the run page
   while the case is executing. Steps, screenshots, and actions appear in the
   embedded viewer within a few seconds of happening, with no manual reload.
2. When the case finishes, the same view transitions in place to the sealed
   run: grade panel, findings, video — identical to opening it fresh.
3. `kill -9` the runner-agent mid-case. The run degrades exactly as today
   (the reconciler marks the dispatch dead and fails in-flight cases as
   `infra`); its staged live artifacts survive a grace window — the only
   evidence of what the run saw before dying — and are then garbage
   collected; nothing dangles in the picker or the object store.
4. Locally, `playtest view` pointed at a run directory that another terminal
   is recording streams the same way, hermetically, with no platform.

## Why this fits

The run directory was already built for this; the invariants a live reader
needs exist for crash-safety reasons:

- `trajectory.jsonl` is append-only during a run. The single exception,
  `rewriteLast()`, mutates only the terminal envelope — covered by the final
  reload at seal.
- Step artifacts are durable on disk *strictly before* the trajectory line
  that names them ("no envelope may ever advertise a file that is not yet on
  disk"). The upload queue preserves this by construction — a line is sent
  only after its artifacts are acknowledged — so a *served* line's artifacts
  exist. (The viewer keeps its existing "not captured" placeholder anyway;
  degradation stays boring even if the platform violates the invariant.)
- A valid placeholder manifest exists from the first instant of the case
  (written for Ctrl-C orphan visibility), so the viewer's first fetch has an
  answer from birth. Its status field, however, says `interrupted` — the
  placeholder *is* the crash evidence — so liveness is never inferred from
  manifest status; both hosts carry an explicit open signal (below).
- The control plane already serves runs per entry, not per blob
  (`runEntry` resolves sibling artifacts first, then bundle entries). A
  staging rung and two virtual entries extend an existing ladder rather
  than building a new one.
- The runner-agent already folds engine events into a coalesced reporter;
  the live uploader is a second consumer of the same `onEvent` stream.

## What "open" and "sealed" mean

Liveness is explicit state, never an inference from artifact contents:

- **Hosted**, a run is open from the `open` call until its final case report
  lands (`live_opened_at` set, status non-terminal). The reconciler failing
  the run terminates openness the same way a report does.
- **Locally**, the run writer creates an `open` marker file beside the
  manifest when the run dir is born and removes it at the very end of the
  finishing tail — after grading, video, and every manifest rewrite — and in
  the SIGINT path. "Sealed" locally means the marker is gone; the manifest's
  status field plays no part. A crash that never removes the marker is an
  **abandoned** run: the local host reports it open-but-stale once the
  trajectory stops growing past a threshold, and the viewer shows a stalled
  state rather than a phantom live one.

This exists because the obvious inference is wrong twice over: the
placeholder manifest carries a terminal-looking status by design, and the
"final" manifest is written *before* the tail's grade and video rewrites —
terminal status is reached long before the run dir stops changing.

## The open-run lifecycle

### Opening

When a claimed case starts, the runner-agent waits for the placeholder
manifest to exist (the `case_start` event precedes the placeholder write;
the event carries the run dir, so readiness is one watched stat) and POSTs
`/runner/groups/:g/cases/:run_id/open` carrying it. The control plane
stores the manifest on the run row, sets `live_opened_at`, and creates a
staging ledger row (ownership and byte accounting; see cleanup). Opening is
idempotent and best-effort: if it never arrives, the run stays invisible
until seal, which is today's behavior.

### The upload queue

One serialized, single-flight queue per case — not scattered fire-and-forget
requests. Order is the run-dir order; nothing is in flight concurrently, so
nothing can complete out of order:

- **Step artifacts** (`steps/NNN.png` and profile-dependent siblings) as
  individual staged objects: `PUT /runner/runs/:r/live/<entry-path>`.
- **Trajectory lines** batched: `POST /runner/runs/:r/live/trajectory` with
  `{ from_line, lines }`, where `from_line` is the index of the first line
  in the batch. The server knows its authoritative line count and answers
  with it: an overlapping resend has its duplicate prefix dropped and its
  new suffix appended (so a lost response followed by a larger resend loses
  nothing); a batch that would leave a gap is refused and the answered
  count tells the uploader where to rewind. Idempotent, self-healing,
  order-preserving.
- **Manifest snapshots** whenever the runner rewrote it, replacing the
  row-stored copy (generation-bumped; small, rewritten whole today).

Every call is answered with an explicit JSON ack — including **budget
refusal as a distinct answer**, not a silent 2xx. The uploader reacts to
outcomes precisely because ordering depends on them: a line batch is sent
only after the artifacts it references are acked; a refused or failed
artifact keeps its referencing lines queued; a transport failure pauses the
queue and the next tick retries from the same position. "Best-effort" lives
at the case boundary: no ack, refusal, or unreachable control plane ever
affects the recording, and the queue drops itself (not the run) if it falls
hopelessly behind — the seal carries everything regardless.

Staged bytes count against a per-run live budget (the existing bundle limit
as ceiling), accounted in the staging ledger. Live routes authenticate with
the existing group-scoped runner token — the same guard as the bundle PUT.

### Serving

Entry precedence becomes: **sibling artifact → sealed bundle entry → staged
live object** — extending today's order (siblings already override sealed
entries so generated clips win; that must survive) with staging as the
final rung. Two entries are virtual for open runs rather than staged
objects, because their sources are not files on the platform:

- `manifest.json` is served from the run row (seeded by `open`, replaced by
  snapshots) — so the viewer's first fetch works the moment the run opens,
  independent of any staged upload landing.
- `trajectory.jsonl` is served as the in-order concatenation of the staged
  line batches.

The picker projects open runs from **database state, not manifest
contents**: an open run reports a live status (no verdict), never the
placeholder's `interrupted`. Open runs are excluded from `history.json`
and the movement/`changed` projections until sealed — a half-recorded run
is not history and must not pollute baselines-adjacent views.

### The live endpoint

Both hosts expose, beside the run's entry routes:

```
GET <run base>/live?after=<cursor>&wait=<seconds>
→ { open, stale?, cursor, has_more, lines, manifest_generation, phase }
```

- `cursor` is an opaque token minted by the host (line-count-derived on the
  hosted side, byte-offset-derived locally); viewers only echo it. An
  unrecognizable or out-of-range cursor answers with a full-resync
  indication rather than guessing.
- Responses are capped (bytes and line count); `has_more: true` tells the
  viewer to drain immediately instead of long-polling, so a late joiner
  pages through the backlog in bounded responses rather than receiving an
  entire trajectory inline.
- The request is held up to `wait` seconds (capped like the feed) only when
  the viewer is caught up. Hosted, ingest wakes holders through the same
  waker mechanism as the feed; locally the host detects trajectory growth.
- `phase` carries what the run is doing now (recording step N, healing,
  grading, finishing) — sourced from engine events hosted-side and from the
  run dir's event stream locally — so the viewer's pending row reflects
  reality instead of arithmetic on the step budget.
- `open: false` is the terminal answer; `stale: true` (local) flags an
  abandoned run. On `open: false` the viewer does one full reload through
  the normal path — picking up the terminal envelope rewrite, `grade.json`,
  video, and the sealed artifact set — and stops polling.

### Sealing and cleanup

Nothing about sealing changes: the runner builds and PUTs the `.ptrun`,
then POSTs the case report, exactly as today. Staging is deleted **only
when a verified sealed bundle exists for the run** — on the report that
follows a successful bundle upload. A terminal report *without* a bundle
(the runner reports `infra` when the bundle upload itself fails, and the
reconciler fails runs whose runner died) leaves staging in place through
the retention grace window, because staging is then the only evidence the
run ever produced; the retention worker collects it afterward.

Staged objects are owned by staging ledger rows from the moment they are
written — necessary not just for budgets and grace windows but because the
existing retention sweep treats any `runs/`-prefixed object without an
owning row as an orphan and deletes it in the same cycle. Unowned staging
would be collected while the run is still executing.

## Viewer live mode

The viewer detects liveness by probing the live endpoint once at load (404
or `open: false` means today's behavior, unchanged). In live mode:

- New trajectory lines append to the loaded run in place; the step rail and
  screenshot filmstrip grow as evidence arrives.
- **Follow mode** is on by default: the view tracks the newest step, the way
  a log tail does. Any user selection of an earlier step disengages it;
  a "Live" affordance re-engages. Repaints never steal focus or collapse
  what the user opened — the platform's established live-update rule.
- The pending row renders from the endpoint's `phase` — "recording step 7",
  "healing", "grading" — and disappears for phases past recording, so an
  early `done` or a grading tail never shows a phantom in-flight step.
- A run header badge distinguishes ● live from sealed (and "stalled" for an
  abandoned local run); on `open: false` the badge flips and the full
  reload lands the grade panel in place.
- Degradation is boring by design: a missed poll retries with backoff; a
  screenshot the platform never received renders the existing "not
  captured" placeholder; a viewer opened long after seal never knows the
  run was ever live.

The console's run page needs almost nothing: the iframe it already renders
for running runs starts working instead of 404ing. The runs list gains a
"watch" affordance on live rows next to the progress it already patches.

## Async axe capture

Bundled into this effort because it was the perf plan's one un-picked
always-on cost (BASELINE.md: 22.5 ms p50, 58.7 ms p95 per web step, worse
under concurrency). It is independent scope — phase A0 stands alone and can
ship regardless of the live-run phases.

Today the web driver awaits the axe scan inline between settle and the
`execute()` return. Every consumer — the `accessibility_violations` gate,
the grader's a11y summary, the viewer — reads it from the trajectory after
the run; the actor never sees it; the contract already declares the field
best-effort and possibly absent. So the wait can move off the critical
path. The one thing the scan may not overlap is **any other page
operation** — and that includes snapshot capture, which mutates the DOM
(it strips and reassigns `data-dummy-ref` attributes on every call).
The safe window is therefore the actor's model wait:

- Step N's `execute()` returns without a scan. The runner captures step
  N+1's snapshot exactly as today; once that capture completes, the scan
  starts and runs concurrently with the actor request — seconds of pure
  network wait against tens of milliseconds of scan.
- Step N's envelope append latches on the scan settling (result, or absent
  field on failure, as today); appends stay strictly step-ordered.
- A dispatch barrier guarantees the scan has settled before action N+1
  performs, and nothing else touches the page in that window by
  construction. In practice the barrier never bites.
- Terminal steps keep today's inline `captureAxe()`.

One honest consequence: the scan now observes the DOM after the *next*
snapshot's ref reassignment rather than before it, so the ref attributes
embedded in violation HTML snippets can differ from today's bytes. The
violations themselves — rules, targets, counts — are unchanged, and the
field is best-effort by contract with no comparability pin. Acceptance
compares semantics, not snippet bytes.

## Security notes

- Live routes ride the existing runner token: group-scoped, short-lived,
  verified per request against the run's group — identical posture to the
  bundle PUT. No new principal, no new exchange.
- Viewer live/entry routes sit behind the same console session auth as every
  other viewer-adapter route. The local server keeps its loopback, read-only
  posture.
- Staged objects are ledger-owned from creation, budget-accounted, deleted
  on verified seal or by retention GC; they never outlive the run row.
- The stream carries only bytes the sealed bundle would carry (commitment 2).
  The 32 KiB whitelisted progress channel is unchanged and remains the only
  place a run's data crosses into platform *events*.

## Contract changes

Deferred to landing, per contract rules; the touched surfaces are:

- [`docs/contracts/hosted.md`](../../contracts/hosted.md): the runner
  protocol gains `open` and `live/*` routes (ack semantics, budget,
  auth); the staging ledger and its lifecycle; live picker projection and
  history exclusion; the statement that a run may be viewer-visible before
  its bundle exists.
- [`docs/contracts/interfaces.md`](../../contracts/interfaces.md): the
  viewer's `live` HTTP route on both hosts, its long-poll and paging
  semantics, and its degradation (absence of the route must leave the
  viewer exactly as it is today).
- [`docs/contracts/engine.md`](../../contracts/engine.md): axe timing
  (still "after settled actions, best-effort"; no longer blocking the step
  return, snippet-byte caveat) and the local open marker in the run-dir
  lifecycle.
- [`docs/contracts/artifacts.md`](../../contracts/artifacts.md): the open
  marker's name and lifecycle (it lives in the run dir); staged live
  objects remain transient serving state, not a persisted format; the
  `.ptrun` contract is untouched.

## Non-goals (v1)

- No live control surface: cancel/stop flows are unchanged and live
  elsewhere.
- No resumable or chunked *bundle* upload; the seal remains one PUT. (If
  bundle sizes ever demand it, that is a separate transport concern.)
- No live HAR, video, or grading state: end-of-run artifacts stay
  end-of-run; the viewer's live mode shows recording evidence only.
- No SSE, WebSocket, or multi-viewer fan-out machinery; long-poll per tab.
- No CLI `--follow` reporter changes; the terminal live reporter is already
  good, and this design leaves it alone.
