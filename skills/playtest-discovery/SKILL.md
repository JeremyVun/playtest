---
name: playtest-discovery
description: Run a Playtest discovery study — persona agents attempt goal-level stories against a staging app and the trajectories are mined for product insight (where users get stuck, where a capability should live).
---

# Playtest discovery studies

Help the human get user-testing-grade insight on a long-lived platform
without recruiting testers: LLM personas attempt goal-level stories against
a staging deployment, and you synthesize the trajectories into answers. A `give_up`
trajectory is primary data — here is where a competent, motivated user ran
out of road — not a failure.

## 1. Preflight — bootstrap and guardrails first

Most failed studies die here, not in the YAML. Check in order:

1. **Tool present, discovery supported.** `playtest --version` proves the
   tool is installed, but the version string signals nothing about discovery
   support — feature-detect instead: the installed `@jeremyvun/playtest`
   package must ship `src/schemas/case.schema.json` and that file must
   mention `"mode"`. (Locate the package via `npm ls @jeremyvun/playtest` or
   `npm root`, or resolve the `playtest` bin.) If the probe fails, stop and
   tell the human to upgrade playtest before anything else.
2. **LLM access.** One of `PLAYTEST_LLM_API_KEY`, `ANTHROPIC_API_KEY`, or
   `OPENAI_API_KEY` must be set — or `PLAYTEST_LLM_BASE_URL` must point at an
   explicit gateway (an explicit override counts as available with no key).
3. **HARD GUARDRAIL — staging only.** Discovery agents genuinely click buy,
   delete, and submit on whatever URL they are given; pointing a study at a
   deployed URL is pointing an autonomous user at it. Staging with test
   rails, never production. Require an explicit staging/test URL from the
   human, and refuse to run anything that looks like production (customer-facing
   domain, real accounts, live payment rails) even if asked to proceed.

Also set one expectation early: the agent navigates by accessibility tree,
so semantically empty markup (div soup, no labels) is a hard limit — it
surfaces as an accessibility finding, not a functional one.

## 2. Interview and author

Both belong to the **playtest-stories** skill: it interviews the human as an
adversarial thought partner (its interview decides discovery vs journey and
surfaces the personas and friction hypotheses worth testing), then authors
the study directory directly — runnable case YAMLs plus personas, validated
with `playtest list`. It also carries a complete worked example of a study.

## 3. Run — with cost honesty first

Tell the human what the study costs **before** launching. Total runs = stories
x personas, every one a fresh agentic pass: minutes of
wall clock per persona, and with a Sonnet-class actor a study lands at
single-digit dollars. The harness reports the actual `cost_usd` per run (its
pricing table covers claude-haiku-4-5, claude-sonnet-4-6 and claude-opus-4-8;
any other model reports a cost of $0). Get a nod, then:

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
"the runs finished". Each case-persona instance lands its own directory
under `runs/<run-id>/`; read per run:

- `grade.json` — the `report` array (one `{question, answer, evidence_steps}`
  entry per report question) and `findings`.
- `trajectory.jsonl` — skim the thoughts and the give_up reason for where the
  persona looked first, backtracked, or expected the capability to be.

Write `study-report.md` in the study directory:

- Lead with the report questions answered across personas, not per run.
- **Convergent evidence is the headline**: three personas opening the same
  wrong menu is a finding; one persona wandering is noise. Divergence
  matters too — a power user succeeding where a newcomer gives up means the
  capability exists but users will not find it.
- Cite every claim with run-dir/step references (e.g.
  `runs/<run-id>/<case-dir>/steps/014.png`) so it is checkable.
- Point the human at `playtest view` for film-strip evidence of any cited run.

## 5. Iterate or promote

Refine stories, personas, or report questions and re-run; compare reports
across study runs. When a journey is validated — the capability exists and
users find it — offer to promote it into a gated regression case in the
team's `tests/` tree, via the playtest-stories skill in journey mode.
