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
- [x] **R2 — Ephemeral CI runners:** a CI job registers itself with its GitHub
      OIDC token (`POST /runner/pool/register-oidc`, pinned repository/workflow/
      ref, credential expiring with the job, never listed as standing), a launch
      pins its own `runner_labels` over the environment's, and the reference
      PR-gating workflow lives in `examples/ci-github-actions/` with the recipe
      in [`docs/hosted-runners.md`](hosted-runners.md).
- [x] **R3 — Environment app artifacts:** `PUT`/`DELETE
      /api/v1/environments/:e/app-artifact` store an APK or a zipped `.app`
      content-addressed under a deployment cap
      (`PLAYTEST_APP_ARTIFACT_MAX_MB`, default 512); a launch pins the hash so a
      re-upload never changes an in-flight or historical group; the runner
      fetches it through `GET /runner/artifacts/:sha256`, verifies the hash,
      unpacks a zipped bundle, and writes the local path into the environment
      overlay's `app:` before core discovery. Precedence (suite-env > environment
      > suite) is stated in the launch preview's `target.app`, an unreachable
      suite-relative binary is refused at launch, and an unreferenced blob enters
      the existing GC.
- [x] **R4 — Console surfaces:** the front door for all of it. Settings →
      Runners shows presence and the run each runner is executing, repainted
      from a new `runner.status` feed edge rather than a poll and gated on
      `capabilities.pool_dispatch`; Test targets gains first-class mobile device
      fields and app-artifact upload/replace/clear with the cap stated up front;
      the New suite dialog asks identity only, with a skippable driver-aware
      "where does this app run?" card on the empty suite that picks or creates a
      ring; the launch dialog says placement out loud and warns when no matching
      runner is checked in; a run's provenance names the runner and isolation
      that produced it, and an unclaimed run gets the runner-setup remedy.
      `GET /run-groups/:id?wait=true` now actually holds, as the automation
      contract always said.

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
