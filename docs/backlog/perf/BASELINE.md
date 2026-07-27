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

## Sidecar cost

Measured on the api long cell — the fastest workload, ~130 spans written per
56 ms case: suite wall 229 ms with the sidecar on, 226 ms with
`PLAYTEST_PERF_SIDECAR=0`. Within run-to-run noise. `perf.jsonl` is 0.6% of a
long web run's bytes. The sidecar buffers spans and flushes in batches, so it
never puts a syscall on the per-span path.
