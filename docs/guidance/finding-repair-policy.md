# Finding repair policy

This is a guidance doc for playtest consumers, not a playtest specification or design doc

Playtest finds and preserves evidence. A downstream builder fixes the product.
This guide connects those responsibilities without making autonomous repair part
of Playtest's engine contract.

The workflow comes from the hill-climb study's disciplined-policy arm. In that
single comparison, the policy arm removed 20 of 26 seeded faults and introduced
no fix-induced regressions; the naive "fix every report" arm removed 16 and
produced 11 regression observations. The policy did not materially improve
detection, round count, or cost. Treat it as evidence-backed repair guidance,
not proof that every element independently caused the result.

## Responsibility boundary

| Concern | Owner |
|---|---|
| Record trajectories and deterministic signals | Playtest |
| Emit cited UX findings and bug candidates | Playtest grader |
| Consolidate repeated evidence into durable findings | Findings system + reviewer |
| Decide whether ambiguous evidence warrants another run | Workflow orchestrator |
| Diagnose code, implement the repair, and inspect related code | Builder |
| Add and run regression coverage | Builder, using Playtest or deterministic tests |
| Accept, reject, or defer a finding | Human reviewer |

A clean findings queue is not proof that the product is correct. Release
confidence also requires required journeys and deterministic contracts to be
green.

## Workflow

### 1. Consolidate observations into issue classes

Do not hand every raw grader sentence to a builder as a separate task. Group
reports that appear to describe the same underlying problem, while preserving
all cited runs and steps. Record:

- the suspected issue;
- evidence for and against it;
- confidence;
- affected journeys or surfaces;
- current decision: investigate, fix, reject, or defer.

This is the disciplined policy's **belief table**. The findings intake and
semantic-consolidation system is the product implementation of this part.

### 2. Probe ambiguous findings

Do not change code merely because a plausible report exists. If the evidence
does not distinguish a product defect from intended behavior, user confusion,
environment failure, or a harness artifact, request a narrow probe that forces
the relevant state and action.

The probe should answer one decision-changing question. It is not another broad
discovery run.

### 3. Repair the supported issue

Give the builder the consolidated finding, its evidence, and relevant product
context. The builder should fix the supported behavior, not blindly implement
the reporter's suggested solution.

Inspect adjacent code for the same defect class when the evidence suggests a
shared cause. Record any related repairs as **fixed without detection** rather
than overstating Playtest's detection recall.

### 4. Pin the regression

Every accepted repair must add or strengthen a regression check that would have
failed before the fix. It must force:

1. the precondition that exposes the defect;
2. the action under test;
3. an observable postcondition.

A story that only asks about a risk in its report questions is not regression
coverage. Use a deterministic assertion when correctness is exact; use a
Playtest journey when the contract is best expressed as user-visible behavior.

### 5. Verify the repair and check collateral

Run the narrow regression first, then the relevant surrounding suite. Treat a
fix-induced issue as a new blocking finding, not as noise from the previous
report.

The builder should stop and return the finding for investigation when the
repair cannot be verified, evidence conflicts, scope expands materially, or a
high-risk result remains unknown.

### 6. Promote proven paths

Keep the regression after the immediate repair. A discovery path that found a
real defect becomes part of the paved road only when its important
preconditions and outcomes are encoded in lasting coverage.

The orchestrator may also redirect later discovery toward poorly covered risks
or use a stronger actor/grader for a genuinely ambiguous judgment. Those are
testing-budget decisions, not builder permissions.

## Minimal builder handoff

A builder should receive:

```text
Finding: one consolidated defect claim
Evidence: cited runs and trajectory steps
Expected behavior: story, product contract, or deterministic oracle
Observed behavior: what the evidence shows
Scope: affected surface and known related instances
Required verification: regression that fails before and passes after
```

The builder should return:

```text
Decision: fixed, rejected, or needs more evidence
Cause: concise technical diagnosis
Changes: affected behavior and any related class repair
Regression: new or strengthened coverage
Verification: narrow and surrounding checks run
Residual risk: unknowns, deferred cases, or emergent issues
```

## Source evidence

- Pre-registered policy:
  [archived hill-climb pre-registration](../../studies/archive/hillclimb-2026-07/PREREGISTRATION.md)
- Synthesized result:
  [archived hill-climb report](../../studies/archive/hillclimb-2026-07/report/REPORT.md)
- Findings intake and consolidation:
  [`contracts/hosted.md`](../contracts/hosted.md)
