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

### Runner refactor: applications, rings, one placement model

Design: [`docs/backlog/runner-refactor/DESIGN.md`](backlog/runner-refactor/DESIGN.md).
Plan: [`docs/backlog/runner-refactor/BUILD_PLAN.md`](backlog/runner-refactor/BUILD_PLAN.md).
Greenfield replacement — no migration.

- [ ] **R0 — Core seams:** checkpoint the tree, add the `runtimeTarget`
      override to core resolution, move the mobile preflight into a core
      export.
- [ ] **R1 — Applications and rings:** replace environments with
      project-owned applications and application-owned rings (web/API rings
      hold the base URL); bind suites to applications; delete app artifacts
      and binary-source precedence.
- [ ] **R2 — One placement model:** delete GitHub and local dispatch; the
      claim board (with a bounded offer page and offer target block) is the
      only placement; `npm run hosted` runs a peer local runner; insecure
      exchange removed.
- [ ] **R3 — Mobile via runner config:** runner config file v1 with mobile
      bindings, claim compatibility, managed/external Appium, post-claim
      preflight, and the runtime target override end to end.
- [ ] **R4 — Console and guides:** Applications-first product surfaces;
      operational runner setup lives only in
      `docs/guidance/hosted-runners.md`.
- [ ] **R5 — Contracts and sweep:** rewrite the owning contracts, prove the
      deletions, map every acceptance gate to a named test.

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
