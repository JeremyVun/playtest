# Talk collateral — slide-ready answers (VERSION_1.1 item 4)

The five questions this audience will ask, each answered with a number or
contract that is reproducible from a command or file in this repo. Companion
files: `mock-pr-comment.md` (the CI story as a slide), `demo-path-audit.md`
(the viewer walk), `clips/` (the backup recordings — never present without
them).

## 1. What does it cost?

**Zero in the steady state.** A checking (act) run replays the saved path
with no actor and no grader: the self-test freezes that contract — zero
`step` calls, zero `grade` calls, exactly one cheap `verdict` call per
`- assert:` success criterion (`test/harness.test.js`, "pass 2" — the
assert-gate check is the only model touch an acted run may make). The demo
suite carries no asserts, so its act pass is *literally* zero:
`playtest demo` prints the measured line — "Second run followed the saved
paths: **0 model calls**, 3 cases in 9.5s."

**Cents per heal — estimate.** A real local heal pass (demo suite recorded,
then run against the variant-b UI; offline against the mock LLM) healed all
three journeys for, per `totals.cost_usd` in each run's manifest:

| Journey | tokens in / out / cache-read | cost (claude-haiku-4-5) |
|---|---|---|
| todos/add-todo | 2,021 / 93 / 1,724 | $0.0009 |
| todos/clear-completed | 8,792 / 345 / 6,936 | $0.0043 |
| todos/complete-todo | 5,391 / 232 / 4,360 | $0.0026 |

*Labeled estimate:* the token counts are synthesized by the offline mock
(`chars/4` heuristic, `src/harness/testing/mock-llm.js`); the dollar figures
apply the real Haiku pricing table (`src/harness/llm.js` — $1/$5 per Mtok
in/out, $0.10 cache-read). Order of magnitude: **a heal costs a tenth of a
cent to half a cent.** Reproduce: `playtest demo --keep`, then read
`totals.cost_usd` in the act-three run manifests under the printed temp dir.
To replace the estimate with measured usage once an API key is available:
`PLAYTEST_LLM_API_KEY=… playtest tests/ --json` after a UI change — each
case's `cost_usd` is then real metered usage, same field.

Recording (grading included) ran $0.002–$0.0037 per case in the same
session — recording is the expensive day; checking is free forever after.

## 2. Is it safe to point an agent at my app?

Hermetic environments only. The agent genuinely clicks buy, delete, and
submit — that is the point. The demo is the model: it runs on a temp copy of
the suite against an in-process app on an ephemeral port; nothing in the
repo or your cwd is touched (`src/harness/demo.js`). For real apps: staging
with test rails, never production — the discovery skill encodes this as a
hard guardrail and refuses production-looking URLs (`skills/
playtest-discovery/SKILL.md`). Every manifest records what it ran against
(`env: { base_url, managed }`).

## 3. Does it fit our LLM gateway?

Yes — one env var. `PLAYTEST_LLM_BASE_URL` points the harness at any
OpenAI-compatible endpoint (LiteLLM, Portkey, a corp proxy): no new vendor
relationship. Key resolution: `PLAYTEST_LLM_API_KEY` →
`ANTHROPIC_API_KEY` → `OPENAI_API_KEY`; an explicit base URL counts as
available with no key at all (`src/harness/llm.js`) — which is exactly how
the entire test suite runs offline against the bundled mock.

## 4. How do I triage a red journey?

Four verdicts, made obvious in the viewer in under a minute
(`docs/playtest-design.md`):

| Verdict | Looks like | Response |
|---|---|---|
| App bug | Task genuinely impossible / assertion fails / errors thrown | File it. This is the product working. |
| App changed | A heal succeeded, or the agent succeeded a new way | Review the heal diff, accept the changed journey. |
| Agent flake | Agent confused on an unchanged, working page | Re-run; if persistent, tune the case story. |
| Environment flake | Container/seed/network/health-probe failure | Distinct exit code; never counted as a test failure. |

The `playtest` agent skill (`playtest install-skill`) automates the loop —
and is hard-ruled to never accept/reject a baseline itself.

## 5. How does CI gate on this?

The exit code is the contract: **0** pass (explored counts as pass), **1**
gate failure, **2** infra/config — infra never masquerades as a test
failure (`src/harness/cli.js`, frozen by `test/harness.test.js`).
`--fail-on-changed` is the gating knob: unreviewed changed journeys promote
exit 0 → 1 (never downgrade a 2), and `--json` puts one machine-readable
object on stdout — the exact ingestion payload the PR bot
(`CI_INTEGRATION.md` §6) posts as a sticky comment. See
`mock-pr-comment.md` for that comment rendered from a real local run.
