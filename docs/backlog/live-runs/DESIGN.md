# Live runs: open runs streaming into the viewer

**Status:** proposed. Implementation phases and gates live in
[`BUILD_PLAN.md`](./BUILD_PLAN.md). Until those phases land,
[`docs/contracts/hosted.md`](../../contracts/hosted.md) and
[`docs/contracts/interfaces.md`](../../contracts/interfaces.md) remain
authoritative: a hosted run becomes viewable only when its sealed `.ptrun`
bundle and final case report have landed, and the viewer loads a run exactly
once per navigation.

The async-axe work that once rode along here is its own backlog item:
[`docs/backlog/async-axe.md`](../async-axe.md).

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

And wherever a signal already exists, reuse it rather than minting a new
one: liveness derives from the event stream the engine already persists,
"what is the run doing" derives from the progress fold the runner already
computes, and the two hosts share those derivations as code, not as
parallel implementations.

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
- Every engine event is synchronously persisted to the run dir's
  `events.jsonl`, and `case_end` is emitted at the true end of the
  finishing tail — after grading, video, and every manifest rewrite. The
  run dir therefore already carries a durable open/sealed bracket and a
  durable activity record; no new artifact is needed.
- A valid placeholder manifest exists from the first instant of the case
  (written for Ctrl-C orphan visibility), so the viewer's first fetch has an
  answer from birth. Its status field says `interrupted` — the placeholder
  *is* the crash evidence — so nothing infers liveness from manifest
  contents, ever.
- The control plane already serves runs per entry, not per blob
  (`runEntry` resolves sibling artifacts first, then bundle entries). A
  staging rung and two virtual entries extend an existing ladder rather
  than building a new one.
- The runner-agent already folds engine events into a coalesced progress
  snapshot; the live uploader is a second consumer of the same `onEvent`
  stream, and the fold itself becomes shared code both hosts reuse.

## What "open" and "sealed" mean

Liveness is explicit state, never an inference from manifest contents:

- **Hosted**, a run is open from the `open` call until its final case report
  lands (`live_opened_at` set, status non-terminal). The reconciler failing
  the run terminates openness the same way a report does.
- **Locally**, liveness reads the event stream the engine already writes:
  `case_start` present with no terminal `case_end` means open; a terminal
  event means sealed; no `events.jsonl` at all means a legacy (sealed) run.
  `case_end` is written after the finishing tail completes — grading,
  video, and every manifest rewrite included — so "sealed" genuinely means
  the run dir has stopped changing.

Local liveness is itself **best-effort, because event writes are**: the
engine deliberately swallows event-write failures (events are telemetry,
never load-bearing), and that stays true. The degradations are defined,
not accidental: a missing `case_start` reads as sealed/non-live; a
missing `case_end` reads as open-but-inactive; neither condition ever
changes a run's status, artifacts, or exit code. Event writes are never
made fatal for live viewing's sake.

Ctrl-C is phase-aware, riding the existing synchronous SIGINT flusher
(which stays synchronous, re-raises, and preserves exit code 130):

- **Before the final manifest**: the flusher writes the interrupted
  placeholder as today, then appends an *interrupted* terminal event —
  the run seals as interrupted.
- **During the finishing tail** (final manifest written, grade/video in
  flight): the flusher already refuses to clobber the final manifest; it
  appends an interrupted terminal event, sealing honestly — grade and
  video may be absent, and no fully graded seal is implied.
- **After the tail**: the normal `case_end` is already on disk; the
  flusher appends nothing.
- `kill -9` at any point leaves no terminal event: open-but-inactive,
  which is the truth.

This replaces any manifest-status inference, which is wrong twice over: the
placeholder carries a terminal-looking status by design, and the "final"
manifest write precedes the tail's grade and video rewrites.

**Both hosts' pickers project openness the same way, additively.** An
open run's picker entry keeps the existing status vocabulary —
`"status": null` (no verdict yet) — and adds `"open": true`; it never
shows the placeholder's `interrupted`, and no new status enum value is
minted, so scripts consuming `playtest view --json` (a supported machine
contract that prints exactly these entries) keep working. The single-run
`view <dir> --json` path, which today reads the manifest directly, goes
through the same projection helper. Open runs are excluded from history
and movement/changed projections **until sealed** — the exclusion is
scoped to open runs in viewer projections; completed-run history is
untouched. A half-recorded run is not history.

## The open-run lifecycle

### Opening

When a claimed case starts, the runner-agent waits for the placeholder
manifest to exist (the `case_start` event precedes the placeholder write;
the event carries the run dir, so readiness is one watched stat) and POSTs
`/runner/groups/:g/cases/:run_id/open` carrying it. The control plane
stores the manifest on the run row and sets `live_opened_at`. Opening is
idempotent and best-effort: if it never arrives, the run stays invisible
until seal, which is today's behavior.

### The upload queue

One serialized, single-flight queue per case — not scattered fire-and-forget
requests. Order is the run-dir order; nothing is in flight concurrently, so
nothing can complete out of order:

- **Step artifacts** (`steps/NNN.png` and profile-dependent siblings) as
  staged objects: `PUT /runner/runs/:r/live/<entry-path>`. `(run, entry
  path)` is unique and immutable: a retry with identical bytes returns the
  original acknowledgement without charging budget twice; different bytes
  for an existing path are refused.
- **Trajectory lines** batched: `POST /runner/runs/:r/live/trajectory` with
  `{ from_line, lines }`. The server holds the authoritative line count
  and answers with it. An overlapping resend is verified — the resent
  prefix must match the stored lines (hash comparison) before being
  dropped, so a divergent retry is refused, never silently merged — and
  the new suffix appended; a batch that would leave a gap is refused and
  the answered count tells the uploader where to rewind. Idempotent,
  self-healing, order-preserving. Batches are sized by **bytes** under an
  explicit route body cap set comfortably above the practical envelope
  maximum (envelopes are bounded in practice — axe is capped at 25
  violations with capped HTML). The pathological single line that still
  exceeds the cap makes the uploader stop streaming that run — no
  truncation, no skip markers polluting the virtual trajectory; the seal
  carries everything regardless.
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
as ceiling). Live routes authenticate with the existing group-scoped runner
token — the same guard as the bundle PUT.

### Staging storage: two shapes, chosen by transactionality

The metadata store (SQLite) and the object store cannot share a
transaction, so staged state is split by what each side is good at:

- **Trajectory batches and the manifest copy live in SQLite** — ledger
  rows holding the line text itself. They are transient, KB-scale,
  budget-capped, and deleted at seal; storing them beside the
  authoritative line count makes accept-batch = one transaction (count,
  budget, bytes, text move together), makes the live read one indexed
  query, and removes any object-ownership race for the highest-frequency
  write path entirely.
- **Step artifacts live in the object store** (they are the real bytes),
  owned through a **two-phase ledger row**: reserve `pending` (budget
  charged) in SQLite → write the object → mark `ready` with size and
  hash. Readers serve only `ready` rows; retention treats both states as
  owned and reaps stale `pending` rows (a crashed upload's reservation)
  on the same grace schedule. The existing orphan sweep — which deletes
  any unowned `runs/`-prefixed object in the same cycle — never sees a
  window where a live object is unowned.

### Serving

Entry precedence becomes: **sibling artifact → sealed bundle entry → staged
live object** — extending today's order (siblings already override sealed
entries so generated clips win; that must survive) with staging as the
final rung. Two entries are virtual for open runs, because their sources
are rows, not objects: `manifest.json` from the run row (seeded by `open`,
replaced by snapshots — the viewer's first fetch works the moment the run
opens) and `trajectory.jsonl` as the ordered concatenation of the ledger's
line batches.

### The live endpoint

Both hosts expose, beside the run's entry routes:

```
GET <run base>/live?after=<line>&wait=<seconds>
```

```jsonc
{
  "open": true,                 // false is the terminal answer
  "reset": false,               // true: client state is invalid; reload fully
  "next": 41,                   // line cursor to echo as `after`
  "has_more": false,            // true: drain immediately, do not long-poll
  "lines": ["…"],               // whole trajectory lines, capped count/bytes
  "manifest_generation": 3,     // monotonic per host; inequality means refetch
  "progress": {                 // the shared progress fold (may be null)
    "step": 7, "max_steps": 20, "doing": "recording", "action": "…"
  },
  "inactive_ms": 0              // time since the run last showed activity
}
```

- The cursor is a plain line number on both hosts (hosted counts ledger
  lines; the local host keeps a private line→byte index for efficient
  reads). A cursor the host cannot honor answers `reset: true` — no
  guessing.
- Responses are capped (bytes and line count); `has_more` pages a late
  joiner through the backlog in bounded responses. The request is held up
  to `wait` seconds (capped like the feed) only when the caller is caught
  up. Hosted, ingest wakes holders through the feed-waker mechanism;
  locally the held request watches **all three signals** — trajectory
  growth, `events.jsonl` growth (progress and, critically, `case_end`),
  and manifest change — so a finished run transitions on the next wake,
  not after a full hold with no new trajectory line.
- Runs opened from a `.ptrun` bundle are sealed by construction and
  always answer `open: false`; `view --latest` intentionally picks the
  newest run including an open one, and streams it.
- `progress` comes from one shared, pure event-folding function extracted
  from the runner-agent's progress reporter into core: the hosted side
  serves the stored snapshot it already has; the local side folds
  `events.jsonl`. Same code, same vocabulary, no drift — and no new
  "phase" field to plumb through the progress whitelist.
- `inactive_ms` is a fact, not a diagnosis: time since the last persisted
  event (hosted: last progress/ingest). A long model call, a retry
  backoff, and a dead runner all look inactive; the viewer says "no
  activity for 3m" and claims nothing more. No heartbeat machinery in v1.
- `open: false` ends the conversation: the viewer does one full reload
  through the normal path — picking up the terminal envelope rewrite,
  `grade.json`, video, and the sealed artifact set — and stops polling.

### Sealing and cleanup

Nothing about sealing changes: the runner builds and PUTs the `.ptrun`,
then POSTs the case report, exactly as today. Staging is deleted **only
when a verified sealed bundle exists for the run** — on the report that
follows a successful bundle upload (ledger rows in the report transaction;
staged objects after it commits). A terminal report *without* a bundle —
the runner reports `infra` when the bundle upload itself fails, and the
reconciler fails runs whose runner died — leaves staging in place through
the retention grace window, because staging is then the only evidence the
run ever produced; the retention worker collects it afterward, ledger and
objects together.

## Viewer live mode

The viewer detects liveness by probing the live endpoint once at load (404
or `open: false` means today's behavior, unchanged). In live mode:

- New trajectory lines append to the loaded run in place; the step rail and
  screenshot filmstrip grow as evidence arrives.
- **Follow mode** is on by default: the view tracks the newest step, the way
  a log tail does. Any user selection of an earlier step disengages it;
  a "Live" affordance re-engages. Repaints never steal focus or collapse
  what the user opened — the platform's established live-update rule.
- The pending row renders from `progress` — "recording step 7 of 20",
  "grading" — and disappears for stages past recording, so an early `done`
  or a grading tail never shows a phantom in-flight step.
- A run header badge distinguishes ● live from sealed; sustained
  `inactive_ms` renders as neutral inactivity ("no activity for 3m"),
  never as a claim the run died. On `open: false` the badge flips and the
  full reload lands the grade panel in place.
- Degradation is boring by design: a missed poll retries with backoff; a
  `reset` answer triggers one full reload; a screenshot the platform never
  received renders the existing "not captured" placeholder; a viewer
  opened long after seal never knows the run was ever live.

The console's run page needs almost nothing: the iframe it already renders
for running runs starts working instead of 404ing. The runs list gains a
"watch" affordance on live rows next to the progress it already patches.

## Security notes

- Live routes ride the existing runner token: group-scoped, short-lived,
  verified per request against the run's group — identical posture to the
  bundle PUT. No new principal, no new exchange.
- Viewer live/entry routes sit behind the same console session auth as every
  other viewer-adapter route. The local server keeps its loopback, read-only
  posture.
- Staged state is ledger-owned from reservation onward, budget-accounted,
  deleted on verified seal or by retention GC; it never outlives the run
  row.
- The stream carries only bytes the sealed bundle would carry (commitment 2).
  The 32 KiB whitelisted progress channel is unchanged and remains the only
  place a run's data crosses into platform *events*.

## Contract changes

Deferred to landing, per contract rules; the touched surfaces are:

- [`docs/contracts/hosted.md`](../../contracts/hosted.md): the runner
  protocol gains `open` and `live/*` routes (ack and idempotency
  semantics, budget, auth); the staging ledger and its lifecycle; live
  picker projection and history exclusion; the statement that a run may
  be viewer-visible before its bundle exists.
- [`docs/contracts/interfaces.md`](../../contracts/interfaces.md): the
  viewer's `live` HTTP route on both hosts — response shape, line
  cursors, paging, `reset` — its degradation (absence must leave the
  viewer exactly as today), and the additive `"open": true` /
  `"status": null` projection in picker entries, which is also the
  `playtest view --json` wire shape (both listing and single-run forms).
- [`docs/contracts/engine.md`](../../contracts/engine.md): documents what
  is already true and now load-bearing — `case_end` as the durable seal
  record written after the finishing tail — plus the SIGINT terminal
  event.
- [`docs/contracts/artifacts.md`](../../contracts/artifacts.md):
  explicitly **not** changed. Staged live state is transient serving
  state, not a persisted format; no new run-dir artifact exists; the
  `.ptrun` contract is untouched.

## Non-goals (v1)

- No live control surface: cancel/stop flows are unchanged and live
  elsewhere.
- No resumable or chunked *bundle* upload; the seal remains one PUT. (If
  bundle sizes ever demand it, that is a separate transport concern.)
- No live HAR, video, or grading state: end-of-run artifacts stay
  end-of-run; the viewer's live mode shows recording evidence only.
- No SSE, WebSocket, or multi-viewer fan-out machinery; long-poll per tab.
- No heartbeat or abandonment detection; `inactive_ms` reports, the user
  concludes.
- No CLI `--follow` reporter changes; the terminal live reporter is already
  good, and this design leaves it alone.
