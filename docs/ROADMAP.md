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

### Runner trust, administration, and target provisioning

Deferred follow-ups from the applications/rings + claim-board refactor
(shipped 2026-07-29; the contracts under `docs/contracts/` are the record).

- [ ] **Runner trust and administration:** console CRUD for site-scoped
      runners; production site-admin token provisioning (today only the
      dev-auth admin may manage them, so non-dev deployments have no site
      runners); per-project runner grants; hardened key-based enrolment; a
      multi-project long-poll waker replacing the accepted one-second
      cross-project rescan; and executor-bearer scope hardening — the
      snapshot-tree, blob, and baseline-trajectory routes accept any valid
      runner bearer today, guarded only by id unguessability; scope them to
      the claimed group's suite and refuse mint-scoped bearers.
- [ ] **Runner-side artifact providers:** pull mobile builds from an
      internal artifactory or registry by version behind the same
      application/ring binding (the stated v2 in
      `docs/guidance/hosted-runners.md`); immutable target pins, build and
      release registries, and revision verification ride the same seam.
- [ ] **Smaller deferrals:** key tombstones (delete-and-recreate silently
      rebinds a runner config still naming the old key — accepted and tested
      v1 behavior); device profiles or any platform-visible device
      selection; runner-config hot reload; multi-group concurrency per
      runner; board pagination beyond the bounded offer page; web/API ring
      URLs resolved from runner config (revisit only with a concrete need);
      manifest-recorded device/backend facts beyond application, ring, and
      runner identity.

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
- [ ] Validate ring `config` values by shape, not just key: the allowlist
      accepts `app.settle: 250` but core refuses that shape when the overlay
      materializes, so a bad value saves fine and fails at run time.
- [ ] Scope and complete the Lumen migration when its external dependency
      lands.
