---
name: playtest-stories
description: Interview the human — PM, engineer, designer, anyone — as a constructive but adversarial thought partner to refine user stories for an existing user flow, then author them directly as runnable Playtest case YAMLs (discovery studies or journey regression cases).
---

# Playtest stories: interview, refine, author

Help the human turn a fuzzy interest in an existing user flow into a small
set of user stories worth running, then author those stories as runnable
Playtest case files. Your value is as a thought partner who pushes back, not a
transcriber: draw out the maximum from the human collaboratively.

## 1. Identify the flow — the answer picks the case mode

Establish two things first: which flow of the platform, and what the human wants
from running stories against it. The second answer decides the case mode:

- **Friction insight** — "where do users get stuck", "where should capability
  X live", "will users find this" → **discovery** cases: personas plus
  `report` questions. Findings have answers, not pass/fail.
- **Regression protection** — "this flow must keep working" → **journey**
  cases: deterministic `success` gates; the first run records a baseline that
  later runs check.

State this fork to the human explicitly and confirm the choice before authoring.
A mixed wish ("protect checkout AND learn why trials abandon it") is two
story sets in two suites.

## 2. The interview — be helpfully adversarial

Concrete moves, not vibes:

- **Refuse vague goals.** "Make export better" is not runnable. Ask: which
  user, on which screen, trying to accomplish what, and what evidence exists
  that they struggle today?
- **Hunt missing user types.** People default to the user they know best. Ask
  who the newest user is, who the most impatient, who is evaluating with a
  reason to walk away, who holds a deprecated mental model from the old UI.
  Each distinct answer is a persona candidate.
- **Challenge assumptions with a reason attached.** "You assume users look in
  Settings for export — what makes you think they go there rather than the
  report screen they're already on?" Steelman the human's view first, then probe
  it.
- **Propose friction hypotheses the human has not raised** — naming collisions,
  affordances hidden below the fold, flows that detour through unrelated
  features — and let the human accept or kill them.
- **Apply the decision test.** For each candidate story ask what the human would
  do differently depending on the outcome. If no outcome changes anything,
  cut the story.
- **Converge** on a small set worth the run: typically a few stories times a
  few personas, each story exactly one goal.

Stories state goals, never click-paths: "Get this month's timesheet data
into a spreadsheet for your finance team", not "Click Reports, then Export".
Second person, motivated, 2-4 lines. If the human insists on a click-path, that
is a journey gate in disguise — ask whether they actually want regression
protection.

## 3. Author runnable YAMLs directly

No intermediate stories document — write case files straight into a suite.
Cases are only discovered in the suite root or a `stories/` subdir (a case-shaped
yaml anywhere else is warned about and skipped, never run). Journey suites group
their cases under `stories/` — the harness drops that segment from case ids
(`stories/foo/bar.yaml` → `foo/bar`) and writes saved paths to a sibling
`results/` dir, so the suite root stays browsable as baselines accumulate;
`playtest new <name>` scaffolds into `stories/` automatically. Discovery studies
have no saved paths, so their handful of cases can sit at the study root next to
`personas/`. Before writing any YAML, read the installed package's
`src/schemas/case.schema.json` and `src/schemas/defaults.schema.json`: they
are the single source of truth for every key, with a description per
property. Do not trust memorized key names. A complete worked example of a
discovery study sits at the end of this skill.

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
`api_called` / `assert`). Tell the human the first run records a baseline that
later runs check.

**Always set `description`** (both case kinds): a one-line human-facing
summary ("Add a todo and see it in the list") shown in run lists such as the
viewer's picker, where the full story would be noise. It never reaches the
actor, so its wording cannot change agent behavior — but keep it faithful to
the story it summarizes; distill it from the interview, don't invent scope.

**Gate hygiene.** A gate is an end-state check; path determinism comes from
the recorded baseline, not from the gate — so a few meaningful criteria beat
many brittle ones. Gate on the surface a user could point at:

- Prefer `url_matches` (the address bar) and `api_called` (requests the app
  makes) — both implementation-resistant. Skip criteria that fire on every
  page load regardless of what the user did: they prove nothing.
- `assert` states the outcome in natural language and survives any refactor
  that keeps the UX intact, at the cost of one grader call per run — even on
  acted runs. Quote the load-bearing strings (`"playtest accept"`), since
  checkers key on them.
- Reserve `element_exists` for stable contracts: `data-testid` attributes or
  ARIA landmarks. Never gate on styling classes — a CSS rename then reddens
  the suite with no user-visible regression. If the app exposes no test-id
  contract, tell the human (adding one is a small product fix worth
  proposing) and gate with assert/url/api meanwhile.

Reading the app's code while authoring is for **test-bench plumbing** — how
to boot it, freeze fixture data, reset state deterministically — not for
harvesting selectors. Mining the DOM for class names couples the suite to
internals the stories were deliberately written to ignore.

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

## Worked example

A complete discovery study — the three file shapes §3 describes (verify key
names against the schemas before reuse).

`studies/timesheet-export/playtest.yaml`:

```yaml
# A study is just a suite: a directory whose playtest.yaml sets mode: discovery.
mode: discovery
actor_model: claude-sonnet-4-6
grader_model: claude-opus-4-8
max_steps: 60
app:
  base_url: https://staging.platform-x.example.com
```

`studies/timesheet-export/export-as-csv.yaml`:

```yaml
description: Get timesheet data out as a spreadsheet, unprompted.
story: |
  You need this month's timesheet data in a spreadsheet for your
  finance team. Get it out of the platform however seems natural.
personas: [first-time-admin, power-user, skeptical-evaluator]
report:
  - Where did the user look first, and what did they try before giving up?
  - At which screen would this user have expected an export affordance?
  - Did the attempt disturb or detour through any other flow?
```

`studies/timesheet-export/personas/first-time-admin.yaml` (the other two
personas follow the same two-key shape):

```yaml
name: first-time-admin
description: |
  You are an office manager evaluating this platform on a trial. You are
  comfortable with computers but have never seen this app before. You read
  labels before clicking, hesitate at anything destructive-sounding, and
  expect an undo to exist. When the thing you need is not where you expected
  it, you give up and say exactly where you looked and where you expected
  to find it.
```
