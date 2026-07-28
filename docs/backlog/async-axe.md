# Async axe capture

Date: 2026-07-28. Extracted from the live-runs design
([`live-runs/DESIGN.md`](live-runs/DESIGN.md)) as independent scope: it
shares no code path with the live-run phases and couples a UX feature's
acceptance to a runner pipeline change for no reason. Standalone,
measure-accepted, one phase.

## Why

The per-step axe scan is the perf plan's one un-picked always-on web cost
([`perf/BASELINE.md`](perf/BASELINE.md)): 22.5 ms p50 / 58.7 ms p95 per
step, degrading with page size and suite concurrency, awaited inline in
the web driver's `#run()` between settle and the `execute()` return.
Every consumer — the `accessibility_violations` gate, the grader's a11y
summary, the viewer — reads the result from the trajectory after the run;
the actor never sees it; `docs/contracts/artifacts.md` already declares
the field best-effort and possibly absent, with no comparability pin.

## Constraints (verified)

- **Snapshot capture mutates the DOM** — it strips and reassigns
  `data-dummy-ref` attributes on every call
  (`packages/core/src/snapshot-injected.ts`). The scan must never overlap
  a capture, a screenshot, or any other page operation. The only safe
  window is the actor's model wait, *after* the next snapshot completes.
- **Not every step has a successor.** The recording loop ends without a
  next snapshot on `max_steps` exhaustion, stuck detection, step timeout,
  and abort — as well as the ordinary `done`/`give_up` terminal steps
  that already use the separate inline `captureAxe()` path. Every one of
  these needs the pending scan resolved before gate evaluation, not just
  the happy path.

## Design

- Step N's `execute()` returns without a scan; a deferred-scan seam on
  the driver lets the runner start it once step N+1's snapshot capture
  has completed, concurrent only with the actor request — no other page
  operation exists in that window by construction.
- Step N's envelope append latches on the scan settling (result, or
  absent field on failure, as today). Appends stay strictly step-ordered:
  N before N+1, always.
- A dispatch barrier guarantees the scan has settled before action N+1
  performs. Expected wait ~0 (tens of milliseconds of scan against
  seconds of model latency); the barrier is correctness insurance.
- **Pending-scan flush**: every loop exit — terminal action, `max_steps`,
  stuck, timeout, abort, error — resolves or abandons the in-flight scan
  before the gate reads the trajectory. Terminal `done`/`give_up` keep
  today's inline `captureAxe()`. Act/heal loops mirror the same seam.
- The `axe` perf span keeps measuring scan duration; add `blocked_ms`
  (dispatch-barrier wait) and `deferred_ms` (settle-to-scan-start delay)
  meta as acceptance evidence.

## Honesty about results

The scan moves from "immediately after settle" to "after the next
snapshot capture", hundreds of milliseconds later on a slow page.
Application timers can change the page in that window — not just ref
attributes but real rules, targets, and counts. The contract already
permits this (best-effort, unpinned), but acceptance must not pretend
byte- or even semantic-equality on dynamic pages:

- On **static fixtures**: identical rules, targets, and counts; snippet
  ref-attribute bytes exempt.
- On **dynamic fixtures**: assert presence-and-shape, and record
  `deferred_ms` so the drift window is measured, not assumed.
- Contract wording in `docs/contracts/engine.md` updates to "captured
  best-effort during the following model turn" so the timing is stated,
  not implied.

## Tests and acceptance

Hermetic runner tests: envelope append order byte-identical; axe field
semantics on static fixtures; slow-scan test (barrier holds, result
lands); rejecting-scan test (field absent, run unaffected); a flush test
per loop exit (`max_steps`, stuck, timeout, abort) asserting the gate
sees a settled trajectory. A browser-suite assertion that no page
operation overlaps a scan (instrument the driver's operation log under
test). Suites: `npm test` zero-skip, `test:browser`, `test:mobile`
(runner loop touched).

Acceptance: axe removed from the blocking path — step-loop wall time on
the browser fixture drops by roughly the axe p50; `blocked_ms` ~0 on
fixtures; `accessibility_violations` gate behavior unchanged on static
fixtures.
