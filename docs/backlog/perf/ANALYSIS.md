# Actor and grader recording performance audit

Date: 2026-07-27  
Scope: core actor/grader recording paths for web and mobile. No implementation
changes were made.

## Executive summary

The clearest low-risk win is mobile: the final Appium page source read and
parsed by settle is discarded, then fetched and parsed again immediately for
the next actor snapshot. Reusing that settled source should remove one of the
heaviest Appium round-trips, plus one full XML parse, after nearly every action.

Web capture has avoidable artifact work, but it is not the main wall-clock
bottleneck on a small page. A current-source microbenchmark measured a median
27.4 ms for the whole web snapshot capture, of which 22.3 ms was the screenshot.
Existing vision recordings spend a median 25.0 s between one step result and
the next step start, and grading takes a median 42.8 s. Those intervals include
model latency and show that actor/grader model calls dominate end-to-end time.

The recommended order is:

1. Add timing spans that separate snapshot, actor model, action/settle/axe,
   grader turns, teardown, and artifact generation.
2. Reuse mobile's settled page source and skip effect-token reads for action
   types that cannot use them.
3. Stop generating debug-heavy artifacts by default, especially the Playwright
   trace and native accessibility trees.
4. Parallelize independent web capture work and remove synchronous artifact
   writes from the hot path.
5. Pipeline grading with independent teardown/artifact work and, for parallel
   suites, use separate actor and grader concurrency permits.
6. Treat smaller or on-demand vision images as a measured quality experiment,
   not an unconditional optimization.

## Evidence and limits

### Existing run telemetry

The repository contains 332 completed web exploration recordings with vision
enabled. They use older prompt/snapshot pins, so the numbers are directional,
not a current benchmark:

| Measure | p50 | p90 | Population |
|---|---:|---:|---:|
| Steps per run | 9 | 25 | 332 runs |
| Previous step result to next `step_start` | 25.0 s | 72.2 s | 3,700 turns |
| `step_start` to `step_result` | 593 ms | 668 ms | 3,698 actions |
| `grading` to `case_end` | 42.8 s | 181.5 s | 265 graded runs |
| `trace.zip` | 3.7 MB | 18.9 MB | 332 runs |
| All step PNGs | 665 KB | 1.62 MB | 332 runs |
| All step MHTML | 173 KB | 489 KB | 332 runs |
| All native AX text | 20 KB | 48 KB | 332 runs |

The pre-step interval combines snapshot capture and the actor call because
`step_start` is emitted only after the actor returns
(`src/core/runner.js:1035-1111`). This is why explicit spans are needed.

Across the recorded web trajectories, 553 of 3,579 non-terminal actions
(15.5%) were scroll, select, wait, back, or navigate actions. The runner
currently computes a pre-action effect token for all of them even though the
confusion detector can only consume it for click, tap, and type.

There are no retained mobile run events suitable for timing. Mobile findings
below come from the exact call graph, not measured device latency.

### Current-source microbenchmarks

On the hermetic todo fixture, seven warmed Chromium captures produced these
median timings:

| Operation | Median |
|---|---:|
| Whole `captureSnapshot()` | 27.4 ms |
| Screenshot | 22.3 ms |
| Screenshot dHash/image processing | 1.6 ms |
| Custom accessibility snapshot | 1.6 ms |
| MHTML capture | 0.8 ms |
| Full native AX tree fetch | 0.6 ms |
| Full-page axe run | 7.0 ms |

A ten-frame slideshow build took 152 ms on this machine. Rich production pages,
full-page screenshots, high device scale factors, slow disks, and parallel
cases will cost more. These measurements mainly show that eliminating web
capture work alone will not materially reduce a 25-second actor turn.

## Prioritized opportunities

### P0 — Reuse the mobile source that settle already fetched

Current flow:

1. Every mobile action ends in `#settle()`
   (`src/core/drivers/mobile.js:408-427`).
2. Settle repeatedly calls `getPageSource()`, parses each changed raw tree, and
   finishes with a stable `lastRaw` and digest
   (`src/core/drivers/mobile.js:441-480`).
3. The runner immediately begins its next turn with `captureSnapshot()`.
4. `captureSnapshot()` calls `getPageSource()` again and reparses the same
   screen (`src/core/drivers/mobile.js:201-220`).

The actor model call happens after capture, so there is no model-sized delay
between settle's final source and this duplicate fetch.

Recommended change:

- Have `#settle()` retain its final raw source and parsed snapshot.
- Let the immediately following `captureSnapshot()` consume that value once,
  while still fetching the alert state and screenshot concurrently.
- Invalidate the cached source on every device operation and after one
  consumption. A sequence number is safer than a time-only cache.
- Seed the first settle with the source already fetched by `start()`
  (`src/core/drivers/mobile.js:139-153`) to remove the startup duplicate too.

Expected result: one fewer `getPageSource()` round-trip and one fewer custom XML
parse per executed action, plus one fewer initial read. This should be the
largest safe driver-side improvement because Appium source dumps can take
hundreds of milliseconds or seconds on real trees.

Guardrail: alert probing must remain live. A system alert is not in the app
source, so source reuse must not reuse an old alert result.

### P0 — Do not compute effect tokens that cannot be used

`recordLoop()` calls `driver.effectToken()` before every non-terminal action
(`src/core/runner.js:1142`). `detectConfusion()` only compares that token for
click, tap, and type actions with zero requests
(`src/core/runner.js:1591-1605`).

Compute the pre-action token only for those three action types. This preserves
the current confusion semantics exactly.

The web saving is one page evaluation for 15.5% of actions in the retained
corpus. The mobile saving is more valuable because every token read performs a
live Appium alert probe (`src/core/drivers/mobile.js:169-183`), and swipe/back/
scroll actions are common mobile navigation primitives.

### P1 — Make debug artifacts opt-in or failure-retained

Every web snapshot currently produces:

- a PNG;
- MHTML;
- the custom accessibility text;
- a full native Chromium AX tree;
- dHash/image processing;
- Playwright trace screenshots and snapshots in parallel with all of the above.

Every mobile snapshot produces a PNG, custom accessibility text, and a full
native-tree text artifact. The native AX artifacts are explicitly described as
debug-only in both drivers (`src/core/drivers/web.js:729-738`,
`src/core/drivers/mobile.js:227-235`).

Tracing is always enabled with `screenshots: true, snapshots: true`
(`src/core/drivers/web.js:440`) and flushed at close
(`src/core/drivers/web.js:945-949`). In retained web runs, `trace.zip` is the
largest artifact by a wide margin: 3.7 MB median and 18.9 MB p90, versus about
0.86 MB median for all step PNG, MHTML, and native-AX files combined. This
increases browser bookkeeping, close time, disk writes, bundle size, upload
time, and memory pressure during parallel recordings.

The extreme
`2026-07-10T1417-24be/change-your-mind@cautious-first-timer` trace makes the
failure mode clear. The 57-minute run gave up after 31 actor decisions, but its
trace contains 4,887 JPEG screencast frames. Playwright throttles trace
screencasting to one frame every 200 ms; after the actor focused a quantity
input, the blinking caret kept the browser producing frames during multi-minute
actor waits and a model retry. Consecutive sampled frames arrived about 216 ms
apart and differed only in the caret's 5-by-14-pixel region (23 materially
changed pixels). Only 173 of the 4,887 JPEG payloads are byte-distinct: 4,714
(96.5%) are exact duplicates. Because every frame gets a timestamped resource
name and JPEG data does not compress much further inside ZIP, these duplicates
account for 118.5 MB of the 125.5 MB archive. These are not intentional
per-step screenshots or meaningful state changes.

Recommended artifact profiles:

- `core`: accessibility text and the PNGs needed by actor vision/viewer/video;
  no native AX tree, no MHTML, and no Playwright trace snapshots/screenshots.
- `debug`: current full artifact set.
- Optionally retain a rolling trace chunk and write it only for infra/failing
  runs if Playwright's chunking semantics prove reliable.

This changes the artifact contract and viewer fallbacks, so it is not a tiny
patch. It is still low-hanging performance work because the removed data is not
used by actor or grader decisions. The existing roadmap already calls out
retiring redundant per-step artifacts.

### P1 — Parse the mobile XML once, including the debug projection

Even within one `captureSnapshot()`, the mobile source is parsed twice:

1. `parsePageSource(xml)` tokenizes tags and attributes into a tree
   (`src/core/drivers/mobile-snapshot.js:201-381`).
2. `nativePageSourceTree(xml)` scans the same XML and reparses every attribute
   to produce debug text (`src/core/drivers/mobile-snapshot.js:485-523`).

If the native tree remains enabled, produce it from the node/attribute
representation already built by `parsePageSource()`. This removes a full regex
scan, duplicate attribute objects, and duplicate normalized strings per step.
If debug artifacts become opt-in, skip this work entirely in `core` mode.

### P1 — Parallelize independent web capture and use asynchronous writes

After the custom snapshot assigns refs, title lookup, screenshot capture, MHTML
capture, and native AX capture are independent but awaited serially
(`src/core/drivers/web.js:694-739`). Their file writes use synchronous APIs.
The same Node process schedules all parallel cases, so large synchronous PNG,
MHTML, HAR, context, event, and trace writes block unrelated recordings.

Recommended change:

- Capture title, screenshot, MHTML, and native AX concurrently after the custom
  snapshot.
- Use `fs.promises` for non-crash-critical step artifacts and await one
  per-snapshot persistence barrier before advertising artifact paths.
- Keep only the small trajectory/manifest crash boundary synchronous if needed.
- Avoid starting model work before the screenshot needed by a vision prompt is
  ready, but allow debug artifacts to finish during the model call.

The small-fixture ceiling is only tens of milliseconds per step. This becomes
more useful on full-page/high-DPI captures and when several cases share the
Node event loop.

Guardrail: snapshot artifacts should describe one logical state. Parallel
capture does not make the current consistency guarantee weaker—the current
serial operations already observe slightly different instants—but tests should
cover a page that mutates continuously.

### P1 — Pipeline grading with independent finishing work

The runner does not start `gradeRun()` until it has:

1. closed the driver and flushed the trace;
2. torn down the environment;
3. written the VTT;
4. synchronously built the slideshow with ffmpeg.

See `src/core/runner.js:899-941`. Grading only reads the already-written
trajectory, manifest, and snapshots. It does not need the browser, application,
trace, or video.

Start the grader as soon as the gate and initial manifest are complete, then
overlap it with driver close and environment teardown. To overlap video
generation too, change the slideshow wrapper from `spawnSync` to an awaited
asynchronous child process; a synchronous ffmpeg call blocks the event loop and
would also block the grader's HTTP socket.

The retained external runs spent only 365 ms p50 between `finishing` and
`grading`, and the local slideshow took 152 ms, so this is not a major
single-case win there. It can hide seconds for managed environment teardown and
larger traces/videos.

### P1 — Separate actor and grader concurrency permits

The scheduler's `record` permit covers the entire `runCase()` promise
(`src/core/runner.js:1827-1880`). A case keeps that permit through gate,
teardown, video, and a 40-second grader call. When `parallel.record` is the
limiting resource, the next actor recording cannot start even though the
previous case no longer uses the actor model or browser.

Use separate bounded stages or permits:

- actor/driver recording;
- grader calls;
- CPU-heavy artifact generation.

This allows the next actor to run while the prior case grades, without
increasing actor concurrency. Keep a total case cap and independent grader cap
to avoid replacing idle time with gateway 429s or memory pressure.

This improves suite throughput, not a single case. It also has no effect while
the external-environment safety rule keeps `parallel.total` at one.

### P2 — Batch multiple natural-language gate assertions

`evaluateGate()` evaluates success criteria sequentially
(`src/core/gate.js:86-117`). Every `assert` calls `checkAssertion()`, which
rebuilds and resends the full trajectory digest and final snapshot and can run
its own six-turn fetch loop (`src/core/grader.js:511-576`).

A shared assertion session could accept all claims, fetch intermediate evidence
once, and return ordered verdicts. This would reduce N serial model sessions to
one and avoid repeating the same large prompt.

This is conditional rather than immediate: the repository currently has 14
YAML cases with `assert`, and none declares more than one. Do not prioritize it
until real suites show multi-assert cases. Running existing assertions in
parallel is an easier interim change, but it preserves duplicate cost and is
more likely to trigger rate limits.

### P2 experiment — Reduce unconditional vision payloads

Discovery defaults to vision, and every actor turn sends one base64 PNG when
capture succeeds (`src/core/actor.js:259-267`). The image is downscaled only
above a 1568 px longest edge (`src/core/drivers/web.js:105-155`), so the default
1280×720 image is sent at full resolution. Mobile also takes and sends a device
screenshot on every vision turn.

Possible experiments:

- lower the model-facing longest edge while retaining the full stored PNG;
- send vision on the first step and after a perceptual/state change, relying on
  the actor's prior written visual observation for identical screens;
- offer the screenshot through an on-demand fetch tool, as the grader already
  does.

This could affect actor and grader latency far more than local capture
micro-optimizations, but it can also reduce visual bug discovery. Gate it on a
fixed evaluation corpus and compare task completion, finding recall, false
positives, input tokens, and wall time. Do not ship it from latency data alone.

## Smaller opportunities

- Web locator validation performs several browser round-trips serially:
  `count`, `isVisible`, `isEnabled`, durable-locator verification, then bbox
  (`src/core/drivers/web.js:758-770`). The visibility/enabled checks and
  durable-locator/bbox work can be grouped where ordering is not load-bearing.
  Measure before changing; the default 500 ms settle floor currently dwarfs
  these calls on the small fixture.
- `writeVideoSidecar()` and `gradeRun()` immediately reread trajectory and
  manifest data that the runner already holds. Passing immutable in-memory
  inputs avoids parsing and allocation, but the expected gain is small.
- Actor diagnostic `context.jsonl` appends a fresh copy of the condensed
  history every turn (`src/core/runner.js:1054-1065`); each write is an
  `appendFileSync`, but the appended payload grows with step count, so total
  bytes grow quadratically. Existing API recordings reached 1.1 MB p90 at 60 steps. An
  append-only delta format plus a reconstruction header would bound writes, but
  it changes a diagnostic artifact and is unlikely to affect normal short web
  runs.
- HAR checkpoints rewrite and stringify the entire accumulated HAR every fifth
  step (`src/core/drivers/har.js:84-104`). A temporary append-only journal
  finalized to `har.json` would avoid repeated whole-file writes on
  request-heavy, long web runs. This does not apply to mobile v1.

## Work already avoiding waste

These paths should not be “optimized” back into regressions:

- Mobile fetches page source, alert state, and screenshot concurrently
  (`src/core/drivers/mobile.js:201-213`).
- Mobile settle reparses only when raw XML changes and reuses its digest for
  effect detection (`src/core/drivers/mobile.js:461-479`).
- Actor tool schemas and Ajv validators are cached per driver
  (`src/core/actor.js:35-55`).
- Prompt caching is enabled by default and marks the stable prefix
  (`src/core/llm.js:79-84`, `src/core/llm.js:116-151`).
- HAR writes are already batched rather than performed every step.
- Clean act replay inherits expensive assertion verdicts and skips the final
  grade entirely (`src/core/runner.js:665-678`, `src/core/runner.js:893-897`).
- Web/mobile snapshot text is capped, so model context cannot grow from one
  unbounded DOM or AX tree.
- Settle quiet windows are intentional correctness barriers. Lowering them
  globally would be a quality tradeoff; fast applications can already override
  them through `app.settle`.

## Measurement required before and after changes

Add these durations and counters to events or a dedicated performance sidecar:

- `snapshot_ms`, split into source/custom tree, screenshot, image processing,
  MHTML, native AX, and writes;
- mobile Appium command counts and durations by command;
- `actor_request_ms`, input/image tokens, cache-read tokens, retries, and
  validation attempts;
- action resolution, action dispatch, settle, axe, effect-token, and HAR-write
  durations;
- grader request count, fetch count/resources, request durations, prompt/cache
  tokens, and validation retries;
- driver close/trace flush, environment teardown, slideshow, baseline scan, and
  total case wall time;
- peak RSS and artifact bytes by type at suite concurrency 1, 2, and 4.

Acceptance should be based on end-to-end p50/p95 for both a short and long
recording, plus behavior parity:

- identical action/grade schemas and status;
- no increase in state-drift, confusion, or actor retries;
- unchanged fixed-corpus completion and finding recall;
- no missing artifact advertised by an envelope or manifest.

For the mobile source-reuse change, also assert the number of
`getPageSource()` calls: after a stable action, the next actor snapshot should
consume settle's final source without another source command.
