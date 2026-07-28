# Roadmap

This file lists unfinished work only. Completed work belongs in contracts,
study reports, and git history.

Before starting an item, read `CLAUDE.md`, `docs/CONTRACTS.md`, and the linked
plan and contracts. Keep `npm test` green with zero skipped tests, preserve the
web journey path, and update the owning contract with any contract change.

## Active work

### Single-node durable storage

Plan: [`docs/backlog/storage/BUILD_PLAN.md`](backlog/storage/BUILD_PLAN.md).

- [ ] **S3 — Crash-safe object lifecycle:** make object writes atomic, recover
      orphans, and guarantee that SQLite never points at a partial `.ptrun`.
- [ ] **S4 — Migration, backup, restore, and cutover:** prove one-shot legacy
      migration where needed, restore metadata and referenced objects from a
      verified backup, and remove remaining PostgreSQL runtime, test,
      configuration, and deployment dependencies.

### API testing

Plan: [`docs/backlog/api-testing/BUILD_PLAN.md`](backlog/api-testing/BUILD_PLAN.md).

- [ ] **S4 — Hosted lifecycle and CLI parity:** finish hosted persistence,
      fingerprinted approval, script review, replay dispatch, drift revisions,
      test-data cleanup, and the `playtest script run` and `review` surfaces.
- [ ] **S5 — Stakeholder pilot:** run the frozen instrument against an
      authorized stakeholder API and publish the preregistered regression,
      authored-suite, and total-cost-of-ownership verdicts.

### Live runs: open runs streaming into the viewer

Design: [`docs/backlog/live-runs/DESIGN.md`](backlog/live-runs/DESIGN.md).
Plan: [`docs/backlog/live-runs/BUILD_PLAN.md`](backlog/live-runs/BUILD_PLAN.md).

- [x] **L0 — Viewer live mode:** liveness from the persisted event stream,
      the long-poll `live` route on the local viewer host, live picker and
      history projections, and the viewer's live mode (follow mode,
      progress-driven pending step, seal transition), hermetic against a
      locally recording run; interfaces.md gains the route contract.
- [x] **L1 — Control-plane open runs:** `open` + acked, idempotent
      `live/*` runner routes; trajectory staging in SQLite and two-phase
      ledger-owned step artifacts served through the `runEntry` fallback;
      the hosted live endpoint; verified-seal cleanup and retention GC;
      hosted.md gains the staging lifecycle.
- [x] **L2 — Runner-agent live uploader:** best-effort coalesced streaming
      beside the progress reporter, end to end on `npm run hosted`; sealed
      bundles byte-identical to non-live runs.
- [x] **L3 — Console polish:** the run page streams in the embedded viewer,
      the runs list gains a watch affordance, ux-lab covers the live page.

### Seeded-fault hill-climb rerun

Plan: [`docs/backlog/hillclimb-rerun.md`](backlog/hillclimb-rerun.md).
Prior evidence:
[`studies/archive/hillclimb-2026-07/`](../studies/archive/hillclimb-2026-07/).

- [ ] **P0 — Current-instrument audit and budget:** freeze the current prompts,
      schemas, model routes, findings workflow, questions, matrix, cost cap, and
      abort rules before building a new benchmark.
- [ ] **P1–P6 — Fresh blind holdout and repair climb:** build a non-Fern & Fog
      subject, freeze stories before a separately authored catalog, measure
      trigger coverage and conditional recognition, then run one
      evidence-gated repair arm and publish the result.

### Hosted UX evidence rerun

- [ ] Re-run `studies/hosted-ux` with the calibrated instrument and compare it
      with `studies/hosted-ux/study-report.md`. Commit a report with evidence
      links. Every core journey must complete without a confusion event, or the
      report must name the residual as an accepted trade-off.

## Polish backlog

- [ ] Improve vision-mode behavior on non-vision models and add viewer
      debugging aids.
- [ ] Sharpen the discovery report prompts and answers loop.
- [x] Reduce recording-path per-step and finishing overhead. Shipped a
      diagnostic `perf.jsonl` sidecar with the
      [`tools/perf/baseline.mjs`](../tools/perf/baseline.mjs) harness, mobile
      settled-source reuse, effect-token gating, one-pass mobile source
      projection, concurrent web capture, a HAR journal, an async ffmpeg
      slideshow with a memoized probe, grading overlapped with teardown, and
      worker release when recording ends. Settle windows remain intentional
      correctness barriers; the remaining measured web hot-path opportunity is
      tracked separately below.
- [x] Simplify run artifacts by folding or retiring redundant per-step files.
      Shipped as the `artifacts: core | debug` profiles: the default run no
      longer writes the Playwright trace, MHTML, or the
      driver's native accessibility tree, which nothing read back and which were
      73% of a web run's bytes. See
      [`docs/contracts/artifacts.md`](contracts/artifacts.md#artifact-profiles).
- [ ] Improve Playwright export with opt-in idiomatic locators, API-driver
      export to `node --test`, and a viewer-reachable hosted download action.
- [ ] Add an opt-in semantic LLM pass to `playtest lint`.
- [ ] Scope and complete the Lumen migration when its external dependency
      lands.
