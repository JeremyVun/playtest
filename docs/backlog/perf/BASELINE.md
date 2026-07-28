# Recording performance baseline

Date: 2026-07-28
Produced by: `tools/perf/baseline.mjs` (BUILD_PLAN T0.2), reading the
`perf.jsonl` sidecar added by T0.1 (`packages/core/src/perf.ts`).

Every later phase of `docs/backlog/perf/BUILD_PLAN.md` is accepted against these
numbers. Rerun the harness after each phase and compare span-for-span:

```sh
node tools/perf/baseline.mjs --driver=api            # no browser needed
node tools/perf/baseline.mjs --driver=web            # real Chromium, local fixture
node tools/perf/baseline.mjs --driver=web --json out.json
```

Both workloads are hermetic: local fixture servers (`tests/fixtures/todo-app`,
`tests/fixtures/invariant-api`) and a loopback step-addressed gateway standing in
for the model. No credentials, no network, no Docker.

Environment: node v25.8.2 · Apple M4 Pro · 12 threads · macOS 25.5. Each cell is
4 cases at the stated suite concurrency; spans aggregate every case in the cell.

## What these numbers are and are not

- **They measure harness work** — capture, settle, dispatch, artifact writes,
  HAR, teardown, video, grading round-trips, scheduling. That is precisely what
  phases 1–5 change.
- **They do not measure model latency.** The scripted gateway answers in about a
  millisecond; a real actor turn is 25.0 s p50 / 72.2 s p90 and a real grade is
  42.8 s p50 (ANALYSIS.md). `actor_request`, `grader_request`, and `grade_total`
  below are therefore the harness's own per-turn overhead, and `case_total` is
  the run's wall clock **minus** all model time. On a real vision run the model
  dominates end-to-end latency; everything here is what is left when it does not.
- **Mobile is not covered.** The mobile spans (`appium` by command, `settle`,
  `snapshot_source`) need a simulator, so Phase 1's acceptance uses the exact
  `getPageSource()` call counts asserted in its unit tests plus an observed
  simulator run, not this harness.
- `settle` is a deliberate correctness barrier (500 ms dom+net quiet, 2× on the
  first settle). It is the floor under every web number here and is **not** a
  target for any phase.

## Headline: `case_total`

`case_total` wraps one whole `runCase`, model time included.

| workload | length | concurrency | p50 | p95 |
|---|---|---:|---:|---:|
| web | short (5 steps) | 1 | 4 604 ms | 4 675 ms |
| web | short | 2 | 4 618 ms | 4 673 ms |
| web | short | 4 | 4 655 ms | 4 659 ms |
| web | long (20 steps) | 1 | 14 727 ms | 14 784 ms |
| web | long | 2 | 14 978 ms | 15 001 ms |
| web | long | 4 | 15 315 ms | 15 542 ms |
| api | short | 1 | 41.8 ms | 69.9 ms |
| api | short | 4 | 39.6 ms | 42.6 ms |
| api | long | 1 | 56.4 ms | 59.7 ms |
| api | long | 4 | 50.9 ms | 57.4 ms |

A web case costs roughly `700 ms × steps + 1.4 s` of harness time. Per-case
latency is essentially flat from concurrency 1 to 4 (+4% on the long web cell),
so the pool is not yet contended at 4 on 12 threads.

Suite wall clock, with `schedulePool`'s fixed `(concurrency − 1) × 500 ms` worker
stagger subtracted:

| workload | length | c1 | c2 | c4 |
|---|---|---:|---:|---:|
| web | short | 18.5 s | 9.3 s | 4.7 s |
| web | long | 58.8 s | 30.0 s | 15.6 s |

Near-linear, which is the point of comparison for Phase 4: with model time added
back, the record permit currently also covers grading, so those slopes should
flatten on a real gateway long before they do here.

## Web workload — spans (concurrency 1, long cell)

| span | n | p50 ms | p95 ms | notes |
|---|---:|---:|---:|---|
| `action_dispatch` | 80 | 590.5 | 643.0 | whole `execute()`; contains resolve + perform + settle + axe |
| `settle` | 84 | 525.3 | 544.3 | the quiet-window barrier; **not** a target |
| `snapshot` | 84 | 50.3 | 55.3 | whole `captureSnapshot()` |
| `snapshot_screenshot` | 84 | 40.3 | 44.0 | 80% of the snapshot |
| `snapshot_image` | 84 | 4.8 | 6.0 | dHash + model-facing downscale |
| `snapshot_source` | 84 | 2.7 | 3.4 | custom a11y tree + title |
| `snapshot_native_ax` | 84 | 2.0 | 3.1 | debug-only artifact |
| `snapshot_mhtml` | 84 | 1.1 | 2.0 | debug-only artifact |
| `snapshot_write` | 168 | 0.14 | 0.20 | per artifact write |
| `axe` | 92 | 22.5 | 58.7 | full-page WCAG scan after each action |
| `action_resolve` | 16 | 16.7 | 23.8 | count → isVisible → isEnabled → durable locator → bbox |
| `action_perform` | 84 | 7.8 | 102.3 | the click/type/scroll/navigate itself |
| `effect_token` | 80 | 1.0 | 1.6 | one page evaluate |
| `har_flush` | 28 | 0.17 | 0.22 | only counts real writes (every 5th step + forced) |
| `driver_close` | 4 | 179.8 | 184.6 | dominated by the trace flush |
| `trace_stop` | 4 | 160.8 | 164.7 | 89% of `driver_close` |
| `slideshow` | 4 | 224.2 | 277.3 | `spawnSync` ffmpeg — blocks the whole event loop |
| `vtt` | 4 | 0.66 | 1.22 | |
| `env_teardown` | 4 | 0.0 | 0.0 | local fixture; a managed container is seconds |
| `grade_total` | 4 | 1.3 | 1.4 | harness overhead only (no model time) |

Short cell (5 steps, c1) for the same spans: `snapshot` 48.7 / 53.2,
`snapshot_screenshot` 39.3 / 43.7, `settle` 529.3 / 1008.0 (p95 catches the
longer first settle), `driver_close` 66.2, `trace_stop` 49.8, `slideshow` 108.1.

## Web workload — artifact bytes (4 runs of the long cell, c1)

| artifact | bytes | share |
|---|---:|---:|
| `trace.zip` | 14 361 KB | 71.5% |
| step PNGs | 4 473 KB | 22.3% |
| MHTML | 868 KB | 4.3% |
| `video.mp4` + `.vtt` | 479 KB | 2.4% |
| `context.jsonl` | 230 KB | 1.1% |
| `trajectory.jsonl` | 167 KB | 0.8% |
| native AX text | 162 KB | 0.8% |
| `perf.jsonl` (sidecar) | 115 KB | 0.6% |
| a11y text | 96 KB | 0.5% |
| `har.json` | 95 KB | 0.5% |
| `events.jsonl` | 37 KB | 0.2% |
| `manifest.json` | 11 KB | 0.1% |

The retained-corpus finding holds on the fixture: `trace.zip` is the artifact,
and it is bought entirely for debugging — the viewer has zero references to it.
Web artifact byte counts move a few percent run to run because the four cases
share one todo-app instance and later cases see a longer list; read them as
proportions, not as a fingerprint.

## API workload — spans (concurrency 1, long cell)

| span | n | p50 ms | p95 ms |
|---|---:|---:|---:|
| `slideshow` | 4 | 34.7 | 35.0 |
| `grade_total` | 4 | 0.93 | 1.23 |
| `grader_request` | 4 | 0.51 | 0.53 |
| `actor_request` | 84 | 0.34 | 0.52 |
| `action_dispatch` | 80 | 0.27 | 0.44 |
| `action_perform` | 80 | 0.22 | 0.37 |
| `har_flush` | 28 | 0.11 | 0.15 |
| `driver_close` | 4 | 0.10 | 0.12 |
| `snapshot` | 84 | 0.07 | 0.09 |
| `snapshot_write` | 84 | 0.07 | 0.09 |
| `effect_token` | 80 | 0.00 | 0.00 |

Artifact bytes, 4 runs of the long cell: `context.jsonl` 165 KB,
`trajectory.jsonl` 89 KB, `perf.jsonl` 58 KB, `har.json` 57 KB,
`events.jsonl` 38 KB, a11y text 36 KB, `manifest.json` 11 KB.

## What the baseline already decides

1. **`slideshow` is 62% of an api case's harness time** (34.7 ms of 56.4 ms) and
   it is almost entirely the `ffmpegPresent()` probe, since an api run has no
   stills to stitch. On web it is 224 ms. Both are `spawnSync`, so in a parallel
   suite the cost lands on every in-flight case, not just its own — Phase 4's
   T4.1 is worth doing for the event-loop block alone.
2. **`trace_stop` is 89% of `driver_close`** (160.8 ms of 179.8 ms) and
   `trace.zip` is 71.5% of the bundle. Phase 3's core profile should show
   `driver_close` collapsing to ~20 ms and the bundle shrinking by ~70%.
3. **`snapshot_screenshot` is 80% of `snapshot`** (40.3 ms of 50.3 ms). T2.2's
   parallelization can hide MHTML (1.1 ms), native AX (2.0 ms), and the writes
   (0.14 ms each) behind it, but cannot beat the screenshot itself: the floor for
   `snapshot` after T2.2 is about 41 ms, i.e. a ~19% cut. The bigger web win is
   Phase 3 skipping MHTML and native AX outright.
4. **T2.3 is answered: skip it.** The plan asked for the measurement either way.
   `action_resolve` is 16.7 ms p50 / 23.8 ms p95 against a 525 ms `settle` in the
   same dispatch — 2.8% of `action_dispatch`. Grouping those round-trips is not
   worth the ordering risk. Revisit only if the settle floor ever drops.
5. **`axe` is the second-largest per-step cost after the screenshot** (22.5 ms
   p50, 58.7 ms p95, and it degrades with page size and concurrency: 8 → 13 →
   15 ms p50 on the short cell at c1/c2/c4). It is always-on and not in the plan;
   if a later phase wants another web win, this is the one the plan missed.
6. **`har_flush` is invisible on these page counts** (0.17 ms p50, 28 real writes
   across 4 × 20 steps). T5.1's quadratic rewrite needs a request-heavy run to
   show up; do not spend on it from these numbers alone.
7. **Concurrency is not yet the constraint.** Per-case `case_total` rises only 4%
   from c1 to c4 and peak RSS goes 325 → 311 MB (flat). Phase 4's T4.2 has to be
   justified by model-time overlap, which this harness cannot show.

## Phase 2 result (T2.2), measured 2026-07-28

Same harness, same machine, after parallelizing web capture and de-syncing the
step-artifact writes. Web long cell, concurrency 1:

| span | before p50 / p95 | after p50 / p95 |
|---|---:|---:|
| `snapshot` | 50.3 / 55.3 | 47.3 / 51.7 |
| `snapshot_screenshot` | 40.3 / 44.0 | 40.6 / 44.3 |
| `snapshot_source` | 2.7 / 3.4 | 2.5 / 3.2 |
| `snapshot_mhtml` | 1.1 / 2.0 | 3.0 / 4.6 |
| `snapshot_native_ax` | 2.0 / 3.1 | 3.1 / 4.5 |
| `snapshot_write` | 0.14 / 0.20 | 0.37 / 0.73 |
| `case_total` | 14 727 / 14 784 | 14 596 / 14 688 |

Short cell `snapshot`: 48.7 → 45.5 p50.

**The win is ~6%, not the ~19% point 3 above projected.** That projection assumed
MHTML, native AX, and the writes would hide *completely* behind the screenshot.
They do not: the concurrent CDP work contends with the screenshot on the same
session, so the individual debug spans and the writes each read 2–3× longer than
they did serially while overlapping. `snapshot_screenshot` is unchanged, which
confirms it is still the floor. Two consequences for later phases:

- `snapshot_source` no longer includes `page.title()` — the title moved into the
  concurrent group. Compare it to pre-Phase-2 numbers with that in mind.
- Phase 3's core profile, which skips MHTML and native AX outright rather than
  hiding them, is now clearly the bigger web win: it removes the contention this
  phase could only overlap.

`har_flush` (T5.1) is unmoved at these page counts (0.14 ms p50, 28 real writes),
exactly as point 6 predicted: the journal removes a quadratic that this workload
never reaches. What changed is the *shape* — an interval flush now appends only
the new entries, and har.json is rewritten in full only on the forced flushes
(pre-gather, pre-gate, close).

## Phase 3 result (T3.1/T3.2), measured 2026-07-28

`artifacts: core | debug` (docs/contracts/artifacts.md#artifact-profiles). The
harness now pins the profile explicitly:

```sh
node tools/perf/baseline.mjs --driver=web --artifacts=debug
node tools/perf/baseline.mjs --driver=web --artifacts=core
```

Both cells below are the same machine, back to back. `debug` is today's
behavior; `core` is the new default.

### Bundle size — the headline

Long cell (4 runs × 20 steps, c1):

| artifact | debug | core |
|---|---:|---:|
| `trace.zip` | 14 321 KB | — |
| step PNGs | 4 473 KB | 4 473 KB |
| MHTML | 877 KB | — |
| `video.mp4` + `.vtt` | 479 KB | 479 KB |
| `context.jsonl` | 230 KB | 230 KB |
| `trajectory.jsonl` | 167 KB | 163 KB |
| native AX text | 162 KB | — |
| `perf.jsonl` (sidecar) | 127 KB | 98 KB |
| a11y text | 96 KB | 96 KB |
| `har.json` | 95 KB | 95 KB |
| `events.jsonl` | 37 KB | 37 KB |
| `manifest.json` | 11 KB | 11 KB |
| **total** | **21 077 KB** | **5 684 KB** |

**A core run is 73% smaller** (76% on the short cell). Point 2 of the original
baseline predicted ~70%; it lands slightly better because MHTML and the native
tree go with the trace. `trajectory.jsonl` shrinks 3% because envelopes no
longer carry the two absent artifact paths, and `perf.jsonl` shrinks because two
spans per step stop existing.

### Close time and the spans

Long cell, c1:

| span | debug p50 / p95 | core p50 / p95 |
|---|---:|---:|
| `driver_close` | 169.9 / 182.8 | **15.6 / 16.4** |
| `trace_stop` | 150.8 / 161.5 | — (never started) |
| `snapshot` | 47.2 / 52.4 | 43.8 / 48.4 |
| `snapshot_screenshot` | 40.7 / 44.3 | 39.2 / 43.3 |
| `snapshot_source` | 2.57 / 3.24 | 1.66 / 2.12 |
| `snapshot_mhtml` | 3.13 / 6.09 | — |
| `snapshot_native_ax` | 3.05 / 4.81 | — |
| `snapshot_write` | 0.37 / 0.79 (n=336) | 0.47 / 0.65 (n=168) |
| `action_resolve` | 16.2 / 22.0 | 12.1 / 16.5 |
| `effect_token` | 0.94 / 1.19 | 0.34 / 0.42 |
| `action_dispatch` | 590.1 / 642.9 | 572.7 / 630.1 |
| `settle` | 525.8 / 539.5 | 518.0 / 528.2 |
| `case_total` | 14 642 / 14 713 | 14 112 / 14 230 |
| peak RSS | 320 MB | 232 MB |

`driver_close` collapses to 15.6 ms, a **91% cut**, exactly the ~20 ms point 2
projected. Short cell: 72.1 → 14.7 ms.

Three things the plan did not predict:

1. **Tracing taxes every CDP round-trip, not just the flush.** With
   `snapshots: true` Playwright instruments each action, so turning tracing off
   also moves spans that have nothing to do with artifacts: `effect_token`
   0.94 → 0.34 ms (−64%), `action_resolve` 16.2 → 12.1 ms (−25%),
   `snapshot_source` 2.57 → 1.66 ms (−35%). None of these are artifact writes;
   they are page evaluates and locator round-trips that were paying a tracing
   surcharge.
2. **Peak RSS drops 28%** on the long cell (320 → 232 MB) and stops growing with
   concurrency (debug: 245/309/315 MB at c1/c2/c4 on the short cell; core: flat
   at 238/240/238). The trace buffer is held in memory until close, so it was a
   per-context memory cost as well as a per-run byte cost.
3. **`snapshot` only falls 7%** (47.2 → 43.8 ms). Phase 2 had already hidden
   MHTML and the native AX read behind the screenshot, so removing them outright
   recovers only the CDP contention, not their full serial cost. The screenshot
   remains the floor, as it has since the first baseline.

### End to end

Per-case harness time (model excluded) and suite wall, stagger subtracted:

| cell | `case_total` p50 debug → core | suite wall debug → core |
|---|---|---|
| short c1 | 4 631 → 4 523 ms | 18.9 → 18.1 s |
| short c4 | 4 612 → 4 484 ms | 4.7 → 4.5 s |
| long c1 | 14 643 → 14 112 ms | 58.5 → 56.5 s |
| long c4 | 15 178 → 14 491 ms | 15.4 → 14.6 s |

A 3–5% wall-clock cut, which is the right expectation: `settle` (500 ms per
step, deliberate) still dominates a web case, and the profile's real prize is
the 73% storage cut and the 91% close-time cut, both of which land on retention,
upload, and the tail of every run rather than on its middle.

### Not done

Rolling trace chunks are still not implemented, and this phase found no evidence
to revisit them: with the trace off by default, the pathological 125 MB
caret-blink case in ANALYSIS.md cannot occur on a default run at all, so chunking
would only bound a bundle a user explicitly asked for.

## Sidecar cost

Measured on the api long cell — the fastest workload, ~130 spans written per
56 ms case: suite wall 229 ms with the sidecar on, 226 ms with
`PLAYTEST_PERF_SIDECAR=0`. Within run-to-run noise. `perf.jsonl` is 0.6% of a
long web run's bytes. The sidecar buffers spans and flushes in batches, so it
never puts a syscall on the per-span path.
