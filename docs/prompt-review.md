# Prompt review — remaining work

*Reviewed 2026-07-27 from two independent static passes over runtime prompts,
prompt assembly, tool schemas, CLI/runtime contracts, shipped skills, personas,
and bundled schemas. Updated after the first corrective pass. This document now
tracks unresolved work only; completed findings are summarized for context.*

## Current verdict

The prompt system is generally strong: roles are clear, deterministic verdicts
are kept outside model control, uncertainty paths are explicit, and the
intent-based skill routing is useful. Instruction/data boundaries, the assertion
rubric, skill inconsistencies, rule-card replies, and consolidation prompt drift
have been addressed. The remaining in-scope work is two grader contract gaps
and a small amount of duplicated actor/grader guidance.

This was a static review. Prompt rewrites that may affect behavior still need a
small fixed evaluation corpus; token reduction alone is not evidence of better
compliance.

## Completed since the review

- The four skill-bundled schemas now match `packages/core/src/schemas/`.
  `tests/repository/skill-resources.test.ts` enforces schema and persona parity.
- Bughunt no longer suggests invalid inherited tag defaults, and its worked
  example now keeps one risk per case.
- The assertions skill documents scalar `string | number | boolean` values.
- CI triage now distinguishes an application failure from “the product working”
  and reads an API heal's deterministic `drift-report.json` classification.
- Discovery preflight resolves the installed executable instead of assuming npm
  package layout and checks credential variables without printing their values.
- The four grader typos and the mobile loop fragment are fixed.
- Actor prompts no longer advertise legacy `confused` fields.
- `grader-discovery.md` was reduced from about 1,260 to about 730 words without
  removing its disprove-first, evidence-citation, or report-answer rules.
- Most internal evaluation jargon was removed from the bughunt skill.
- Story authoring now asks about research only when unresolved, permits source
  inspection for stable gate hooks without leaking selectors into stories, and
  documents the live API response-selector and invariant/advisory forms.
- Bughunt now routes only functional edge-state stress, uses portable coverage
  wording, and inherits the corrected research and stable-hook boundary.
- Assertion grading now applies a reasonable-person test: ordinary-language
  implication and broader statements can affirm a narrower claim, while every
  material condition still needs positive recorded support.
- The rule-card proposer now returns its note and cards through a forced,
  schema-constrained tool call instead of fenced free-text JSON.
- Local and hosted findings consolidation now import one shared system prompt
  and forced-tool schema.
- Concise, role-specific instruction/data boundaries now live in the system
  prompt for every affected actor, grader, authoring, drift, synthesis,
  consolidation, and verification call.
- Prompt versioning was removed from active pins, API responses, storage writes,
  comparability, and UI. Legacy nullable database columns remain readable but
  are no longer written.

## Deferred

### Correct hook secret guidance

`skills/playtest-hooks/SKILL.md` still returns a plaintext password in its worked
example and says returned setup context is never persisted. In reality the
returned string becomes a `## Run setup` model message and is recorded in
`context.jsonl`.

Required changes:

1. Replace the password example with a non-secret handle or state fact.
2. State that every returned byte is model input and persisted diagnostic
   context.
3. Forbid tokens, passwords, backend secrets, and other long-lived credentials
   in the return string.
4. Decide separately whether setup context should be redacted or omitted from
   `context.jsonl`. If implemented, add a persistence test before relaxing the
   skill warning.

This item is explicitly descoped for this session.

## Remaining actions

### P1 — Align remaining grader output contracts

The main graders also ask the model to “discard with reason” but expose no
structured place for that reason. Either add an actor-raise disposition field or
remove the unsupported instruction.

When a case supplies report questions, runtime validation must require exactly
one ordered answer per question. `grade.schema.json` cannot express this
case-dependent rule by itself; compare the returned grade with
`resolvedCase.report` before accepting it.

### P2 — Reduce remaining prompt drift

Sibling drift caused the defects already fixed. Reduce the remaining manual-copy
surface:

- single-source or parity-test the shared actor text;
- single-source or parity-test the graders' fetched-evidence guidance;

Refactors may preserve assembled bytes. Prove behavior with focused prompt
contract tests.

## Execution order

1. Tighten the remaining grader output validation.
2. Add the remaining shared-source/parity protections.

Test grounding, refusal behavior, and task success against fixed fixtures before
judging a rewrite by concision.
