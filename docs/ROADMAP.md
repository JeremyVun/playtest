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

### Self-hosted runners and app artifacts

Design: [`docs/backlog/self-hosted-runners/DESIGN.md`](backlog/self-hosted-runners/DESIGN.md).
Plan: [`docs/backlog/self-hosted-runners/BUILD_PLAN.md`](backlog/self-hosted-runners/BUILD_PLAN.md).

- [x] **R0–R1 — Pull-based runner pool:** runner registry, credentialed
      claim board behind `PLAYTEST_DISPATCH=pool`, and the runner-agent pool
      mode, so a runner on a developer machine executes hosted runs against
      local targets with outbound HTTP only. Landed: the control plane's
      registry, board, pool adapter, claim-bound exchange and reconciler loss
      shapes (R0), then `runner-agent pool`, the minimal Settings → Runners
      console slice, and the laptop walkthrough
      ([`docs/hosted-runners.md`](hosted-runners.md)) (R1).
- [ ] **R2 — Ephemeral CI runners:** OIDC-badged registration, per-launch
      label pinning, and the reference PR-gating workflow.
- [ ] **R3 — Environment app artifacts:** content-addressed APK/.app upload
      on environments, launch pinning, and runner materialization of `app:`.
- [ ] **R4 — Console surfaces:** runners settings, artifact upload, and
      placement said out loud at launch.

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
- [ ] Reduce web and mobile driver settle time and per-step overhead. Audited
      in [`docs/backlog/perf/ANALYSIS.md`](backlog/perf/ANALYSIS.md); phased
      plan in [`docs/backlog/perf/BUILD_PLAN.md`](backlog/perf/BUILD_PLAN.md).
- [ ] Simplify run artifacts by folding or retiring redundant per-step files;
      update [`docs/contracts/artifacts.md`](contracts/artifacts.md). Covered
      by Phase 3 of the perf BUILD_PLAN above.
- [ ] Improve Playwright export with opt-in idiomatic locators, API-driver
      export to `node --test`, and a viewer-reachable hosted download action.
- [ ] Add an opt-in semantic LLM pass to `playtest lint`.
- [ ] Scope and complete the Lumen migration when its external dependency
      lands.
