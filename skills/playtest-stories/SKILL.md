---
name: playtest-stories
description: Interview a PM as a constructive but adversarial thought partner to refine user stories for an existing user flow, then author them directly as runnable Playtest case YAMLs (discovery studies or journey regression cases).
---

# Playtest stories: interview, refine, author

Help a PM turn a fuzzy interest in an existing user flow into a small set of
user stories worth running, then author those stories as runnable Playtest
case files. Your value is as a thought partner who pushes back, not a
transcriber: draw out the maximum from the PM collaboratively.

## 1. Identify the flow — the answer picks the case mode

Establish two things first: which flow of the platform, and what the PM wants
from running stories against it. The second answer decides the case mode:

- **Friction insight** — "where do users get stuck", "where should capability
  X live", "will users find this" → **discovery** cases: personas plus
  `report` questions. Findings have answers, not pass/fail.
- **Regression protection** — "this flow must keep working" → **journey**
  cases: deterministic `success` gates; the first run records a baseline that
  later runs check.

State this fork to the PM explicitly and confirm the choice before authoring.
A mixed wish ("protect checkout AND learn why trials abandon it") is two
story sets in two suites.

## 2. The interview — be helpfully adversarial

Concrete moves, not vibes:

- **Refuse vague goals.** "Make export better" is not runnable. Ask: which
  user, on which screen, trying to accomplish what, and what evidence exists
  that they struggle today?
- **Hunt missing user types.** PMs default to the user they know best. Ask
  who the newest user is, who the most impatient, who is evaluating with a
  reason to walk away, who holds a deprecated mental model from the old UI.
  Each distinct answer is a persona candidate.
- **Challenge assumptions with a reason attached.** "You assume users look in
  Settings for export — what makes you think they go there rather than the
  report screen they're already on?" Steelman the PM's view first, then probe
  it.
- **Propose friction hypotheses the PM has not raised** — naming collisions,
  affordances hidden below the fold, flows that detour through unrelated
  features — and let the PM accept or kill them.
- **Apply the decision test.** For each candidate story ask what the PM would
  do differently depending on the outcome. If no outcome changes anything,
  cut the story.
- **Converge** on a small set worth the run: typically a few stories times a
  few personas, each story exactly one goal.

Stories state goals, never click-paths: "Get this month's timesheet data
into a spreadsheet for your finance team", not "Click Reports, then Export".
Second person, motivated, 2-4 lines. If the PM insists on a click-path, that
is a journey gate in disguise — ask whether they actually want regression
protection.

## 3. Author runnable YAMLs directly

No intermediate stories document — write case files straight into a suite
directory. Before writing any YAML, read the installed package's
`src/schemas/case.schema.json` and `src/schemas/defaults.schema.json`: they
are the single source of truth for every key, with a description per
property. Do not trust memorized key names.

**Discovery cases — hand-author them.** (`playtest new <case>` scaffolds a
journey-flavored template with a `success:` block, which is a config error in
discovery.) A study is a directory:

- `studies/<name>/playtest.yaml` — `mode: discovery`, model choices, and the
  staging `app.base_url` (the **playtest-discovery** skill enforces the
  never-production guardrail before any run).
- One `<story>.yaml` per story — `story` + `personas` + `report` questions.
  Report questions are what the grader must answer from each trajectory:
  questions, never assertions.

**Journey cases** — `playtest new <name> <dir>` scaffolds a usable template:
`story` + `success` criteria (`url_matches` / `element_exists` /
`api_called` / `assert`). Tell the PM the first run records a baseline that
later runs check.

**Personas** — either:

- `playtest new persona <name>` — run it **from the study or repo root**: it
  writes `./personas/` relative to your cwd, while resolution walks upward
  from the case file, so a persona created from the wrong cwd is silently
  unfindable.
- Hand-author the two-key YAML (`name`, `description`), mirroring the voice
  of the shipped `src/harness/prompts/persona-exploratory.md`: second person,
  behavioral, honest about when and why this user gives up.

Confirm every persona name a case references resolves: `playtest personas` — run
it from the study directory, not the repo root (it lists personas visible from
your cwd upward, so a study-local `personas/` dir is invisible from above).

## 4. Validate

```
playtest list <dir> --json
```

Inspect the returned JSON array — the command exits 0 even on zero matches,
so the exit code proves nothing. Check: every story is present; each
discovery case fanned out into one id per persona, `<case-id>@<persona>`;
`next_run` is `explore` for discovery cases. An empty array means a wrong
directory or no case files; a config error (exit 2) names the file and key.

## 5. Hand off

To run a discovery study, use the **playtest-discovery** skill — it owns
preflight, the staging guardrail, cost expectations, the run itself, and the
mandatory synthesis. Journey suites are run directly (`playtest <dir>`). Do
not drive a browser from this skill.
