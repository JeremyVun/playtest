---
name: playtest-discovery
description: Run a Playtest discovery study — persona agents attempt goal-level stories against a staging app and the trajectories are mined for product insight (where users get stuck, where a capability should live). Also runs defect-detection / risk (bug-hunt) suites authored by playtest-bughunt — same explore harness, defect-focused synthesis.
---

# Playtest discovery studies

Help the human get user-testing-grade insight on a long-lived platform without
recruiting testers: LLM personas attempt goal-level stories against a staging
deployment, and you synthesize the trajectories into answers. A `give_up`
trajectory is primary data — here is where a competent, motivated user ran out
of road — not a failure.

## 1. Preflight — bootstrap and guardrails first

Most failed studies die here, not in the YAML. Check in order:

1. **Tool present, discovery supported.** `playtest --version` only proves it's
   installed, not that it does discovery. Resolve the actual `playtest`
   executable on `PATH` (including symlinks), locate its package root, and
   confirm that its `packages/core/src/schemas/case.schema.json` mentions `"mode"`. Do
   not infer the installed version from the current project's `npm root` or
   dependency tree; linked and nonstandard installs may live elsewhere. If the
   resolved executable lacks the capability, stop and have the human upgrade.
2. **LLM access.** `PLAYTEST_LLM_BASE_URL` must point at an OpenAI-compatible
   gateway — there is no default endpoint, so an API key alone does nothing.
   Normally an API key is also set (`PLAYTEST_LLM_API_KEY`, or the
   `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` fallbacks); a base URL with no key
   still counts as configured (some gateways carry auth themselves). Check only
   whether these variables are present and non-empty; never print or otherwise
   expose their values.
3. **HARD GUARDRAIL — staging only.** Discovery agents genuinely click buy,
   delete, and submit on whatever URL they're given. Require an explicit
   staging/test URL, and refuse anything that looks like production
   (customer-facing domain, real accounts, live payment rails) even if asked
   to proceed.

Set one expectation early: the agent navigates by the accessibility tree, so
semantically empty markup (div soup, no labels) is a hard limit — it surfaces
as an accessibility finding, not a functional one.

## 2. Interview and author

Authoring is **not** this skill:

- **UX insight / “where do users get stuck?”** → **playtest-stories**
  (natural-path discovery + personas).
- **Find bugs / stress edges / forced-risk / adversarial thoroughness** →
  **playtest-bughunt** (forced-risk discovery cases + `persona: adversarial`).
  Same `mode: discovery` harness; different story shape.

If the suite is not written yet, hand off to the right author skill, then return
here to run.

## 3. Run — with cost honesty first

Tell the human what the study costs **before** launching. Total runs = stories
× personas, and every run is a fresh agentic pass — minutes of wall clock each
(discovery cases default to generous limits: up to 300 steps / 30 minutes,
though most runs end far sooner). The harness reports the actual `cost_usd` per
run — built-in pricing covers the stock claude and gpt5 model tiers; any other
model reports $0, so say so rather than quoting a number. Get a nod, then:

```
playtest studies/<name>/            # the study is just a suite
playtest studies/<name>/ --headed   # first demo: let the human watch
```

Expectations: every completed run ends with terminal status `explored` —
including give_up runs, which are informative data — and the command exits 0.
`infra` (exit 2) means the environment broke (unreachable base_url and the
like), not that the study found anything.

## 4. Synthesize — mandatory

Without this step the human gets N trajectories and zero answers. Never stop at
"the runs finished". Each case-persona instance lands its own directory under
`runs/<run-id>/`; read per run:

- `grade.json` — the `report` array (one `{question, answer, evidence_steps}`
  entry per report question) and `findings`.
- `trajectory.jsonl` — skim the thoughts and the give_up reason for where the
  persona looked first, backtracked, or expected the capability to be.

Write `study-report.md` in the study directory.

**UX / insight studies** (natural-path stories, exploratory-style personas):

- Lead with the report questions answered across personas, not per run.
- **Convergent evidence is the headline**: three personas opening the same
  wrong menu is a finding; one persona wandering is noise. Divergence matters
  too — a power user succeeding where a newcomer gives up means the capability
  exists but users will not find it.

**Bug-hunt / risk studies** (`tags: [risk]`, `persona: adversarial`, or authored
via playtest-bughunt) — **lead with defects**, not discoverability:

- Broken, silent, misleading, or contradictory behaviors with run-dir/step evidence.
- Group by risk class (empty guard, validation wipe, label↔control, recovery loop, …).
- Separate soft UX/taste from correctness failures.
- Note checklist gaps: risk classes that never got a cell.
- Do not credit “detection” for issues found only by reading source.

Always:

- Cite every claim with run-dir/step references (e.g.
  `runs/<run-id>/<case-dir>/steps/014.png`) so it is checkable.
- Point the human at `playtest view` for film-strip evidence of any cited run.

## 5. Iterate or promote

Refine stories, personas, or report questions and re-run; compare reports
across study runs. When a journey is validated — the capability exists and
users find it — offer to promote it into a gated regression case in the team's
`tests/` tree, via the playtest-stories skill in journey mode.
