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
   stream is telemetry-grade: best-effort, coalesced, silently droppable. A
   failed live upload never fails, delays, or re-orders a case; verdicts,
   retention, and export never read live state. The final `.ptrun` PUT and
   case report are byte-for-byte what they are today.
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
   (reconciler declares it lost); its staged live artifacts are garbage
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
  disk"). Uploading in the same order transfers the guarantee to the remote
  reader unchanged: the viewer can never fetch a step it can't render.
- A valid placeholder manifest exists from the first instant of the case
  (written for Ctrl-C orphan visibility), so "openable by the viewer" is a
  property the run dir has from birth.
- The control plane already serves runs per entry, not per blob
  (`runEntry` resolves one bundle entry at a time, with a sibling-artifact
  override layer that already takes precedence over sealed entries). A
  staging fallback is a third rung on an existing ladder, not a new ladder.
- The runner-agent already folds engine events into a coalesced reporter;
  the live uploader is a second consumer of the same `onEvent` stream.

## The open-run lifecycle

### Opening

When a claimed case starts, the runner-agent POSTs
`/runner/groups/:g/cases/:run_id/open` carrying the placeholder manifest.
The control plane stores that manifest on the run row (the same column the
final report writes today, which is what makes a run appear in the picker
and gives the viewer its `manifest.json`), marks the run live, and creates
nothing else — staging is lazy.

Opening is idempotent and best-effort like every live call: if it never
arrives, the run simply stays invisible until seal, which is today's
behavior.

### Streaming

The uploader ships increments coalesced on the same ~2 s cadence as the
progress reporter, strictly in run-dir order:

- **Step artifacts** (`steps/NNN.png` and profile-dependent siblings) as
  individual staged objects: `PUT /runner/runs/:r/live/<entry-path>`.
- **Trajectory lines** batched with a monotonic sequence:
  `POST /runner/runs/:r/live/trajectory` with `{ after_seq, lines }`. The
  object store has no append primitive, so the control plane stores each
  batch as a segment object (`live/trajectory.<seq>.jsonl`) and the serving
  path concatenates segments in order. Segments are small and few (one per
  coalescing tick that had new lines, not one per step).
- **Manifest snapshots** on the same tick whenever the runner rewrote it
  (it is small and rewritten whole today; the live copy is too).

Within one tick the uploader orders artifacts before the trajectory batch
that references them, preserving the on-disk invariant. Every call is
fire-and-forget with the same swallow-failures posture as progress: a 4xx/5xx
or timeout drops that increment, and the next tick carries the delta. Gaps
are legal; the viewer renders what the platform has.

Staged bytes count against a per-run live budget (the existing bundle limit
serves as the ceiling); the control plane silently refuses over-budget
increments. Live routes authenticate with the existing group-scoped runner
token — the same guard as the bundle PUT, no new credential.

### Serving

The viewer adapter's entry route gains one fallback rung:
sealed bundle entry → sibling artifact → staged live object. `runs.json`
lists open runs because their manifest column is populated at open. The
viewer needs no host-specific knowledge; the same relative fetches work
against staging as against a sealed bundle.

### The live endpoint

Both hosts expose, beside the run's entry routes:

```
GET <run base>/live?after=<cursor>&wait=<seconds>
→ { open, cursor, lines, manifest_generation }
```

Held up to `wait` seconds (capped like the feed) when nothing is new. `lines`
is the trajectory delta after `cursor` — returned inline so the common tick
costs one round trip. `manifest_generation` bumps when a newer manifest
snapshot exists, telling the viewer to refetch it. `open: false` is the
terminal answer, returned once the run is sealed (hosted: final report
landed; local: the manifest reached a terminal status) — the viewer then
does one full reload through the normal path, which picks up the terminal
envelope rewrite, `grade.json`, video, and the sealed artifact set, and
stops polling.

Hosted, the endpoint is woken by live ingest through the same waker
mechanism as the feed. Locally, the `playtest view` server answers from
disk (stat/append detection on `trajectory.jsonl`); its provider already
reads fresh bytes per request and its file streaming already tolerates
mid-write truncation.

### Sealing and cleanup

Nothing about sealing changes: the runner builds and PUTs the `.ptrun`, then
POSTs the case report, exactly as today. On report (any terminal status),
the control plane deletes the run's staged objects — the bundle supersedes
them entry for entry. For runs that die without a report, the reconciler
already declares the dispatch dead; staged objects for runs in a terminal
status without a bundle are garbage collected by the retention worker after
a short grace window (kept briefly because a lost run's staging is the only
evidence that exists — a debugging gift the current design throws away
entirely).

## Viewer live mode

The viewer detects liveness by probing the live endpoint once at load (404
or `open: false` means today's behavior, unchanged). In live mode:

- New trajectory lines append to the loaded run in place; the step rail and
  screenshot filmstrip grow as evidence arrives.
- **Follow mode** is on by default: the view tracks the newest step, the way
  a log tail does. Any user selection of an earlier step disengages it;
  a "Live" affordance re-engages. Repaints never steal focus or collapse
  what the user opened — the platform's established live-update rule.
- The in-flight step (known from the last line's ordinal versus the
  manifest's step budget) renders as a pending row, so the run visibly
  breathes rather than stuttering forward.
- A run header badge distinguishes ● live from sealed; on `open: false`
  the badge flips and the full reload lands the grade panel in place.
- Degradation is boring by design: a missed poll retries with backoff; a
  screenshot the platform never received renders the same "not captured"
  placeholder the viewer already has; a viewer opened long after seal never
  knows the run was ever live.

The console's run page needs almost nothing: the iframe it already renders
for running runs starts working instead of 404ing. The runs list gains a
"watch" affordance on live rows next to the progress it already patches.

## Async axe capture

Bundled into this effort because it was the perf plan's one un-picked
always-on cost (BASELINE.md: 22.5 ms p50, 58.7 ms p95 per web step, worse
under concurrency) and it touches the same step-loop seam the uploader
observes.

Today the web driver awaits the axe scan inline between settle and the
`execute()` return. Every consumer — the `accessibility_violations` gate,
the grader's a11y summary, the viewer — reads it from the trajectory after
the run; the actor never sees it; the contract already declares the field
best-effort and possibly absent. So the scan moves off the critical path:

- `execute()` starts the scan after settle and returns without awaiting it.
- The runner latches step N's envelope append on the scan settling (result
  or failure), while step N+1's snapshot and actor request proceed — the
  scan hides behind seconds of model latency.
- One barrier remains: the next action never dispatches while a scan is
  in flight, so axe never reads a mutating DOM. In practice the barrier
  never bites (tens of milliseconds versus seconds).
- Envelope append order stays strictly by step; the live uploader and every
  other trajectory consumer see the same ordering they see today.

Behavior, schema, and contract text are unchanged — `axe` remains a
best-effort per-step field. Only the wait moves.

## Security notes

- Live routes ride the existing runner token: group-scoped, short-lived,
  verified per request against the run's group — identical posture to the
  bundle PUT. No new principal, no new exchange.
- Viewer live/entry routes sit behind the same console session auth as every
  other viewer-adapter route. The local server keeps its loopback, read-only
  posture.
- Staged objects live under the run's own key prefix and are deleted on
  seal or by retention GC; they never outlive the run row.
- The stream carries only bytes the sealed bundle would carry (commitment 2).
  The 32 KiB whitelisted progress channel is unchanged and remains the only
  place a run's data crosses into platform *events*.

## Contract changes

Deferred to landing, per contract rules; the touched surfaces are:

- [`docs/contracts/hosted.md`](../../contracts/hosted.md): the runner
  protocol gains `open` and `live/*` routes (best-effort semantics,
  budget, auth); the staging lifecycle and its GC; the statement that a
  run may be viewer-visible before its bundle exists.
- [`docs/contracts/interfaces.md`](../../contracts/interfaces.md): the
  viewer's `live` HTTP route on both hosts, its long-poll semantics, and
  its degradation (absence of the route must leave the viewer exactly as
  it is today).
- [`docs/contracts/engine.md`](../../contracts/engine.md): a sentence on
  axe timing (still "after settled actions, best-effort"; no longer
  blocking the step return).
- [`docs/contracts/artifacts.md`](../../contracts/artifacts.md): explicitly
  **not** changed. Staged live objects are transient serving state, not a
  persisted format; the `.ptrun` contract is untouched.

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
