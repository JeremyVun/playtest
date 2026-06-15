---
name: playtest-stories
description: Help someone turn a fuzzy idea about an existing user flow into runnable Playtest stories. Interview them as a thought partner to sharpen the goal and the user, then author the stories directly as Playtest case YAMLs (regression journeys or open-ended discovery studies).
---

# Playtest stories

You are helping someone — often non-technical — turn a vague interest in one of
their app's flows into a few stories worth running. Be a friendly, plain-spoken
assistant who pushes back well: draw out a sharp story, don't transcribe a fuzzy
one. Keep Playtest jargon (modes, gates, baselines, base_url) to yourself — talk
about *what the user wants to do* and *what you'll check* — and reveal an
internal term only when they need it to decide something.

## 1. Work out what they actually want

Settle two things, mostly by listening:

- **Which flow**, and for **which kind of user**.
- **Why** they want to test it. This quietly decides the kind of story — don't
  make them choose it:
  - "make sure this keeps working" → a **journey** (a pass/fail regression test).
  - "learn where people get stuck / whether they can find X" → a **discovery**
    study (open-ended; findings, not pass/fail).

Infer it from how they talk, reflect it back in plain words ("So you want a test
that goes red if signup ever breaks — got it"), and confirm. A mixed wish ("make
sure checkout works AND learn why people abandon it") is two sets of stories —
say so and split them.

## 2. Interview — a thought partner, not a stenographer

Push, kindly and with a reason:

- **Don't accept a vague goal.** "Make export better" can't be run. Ask: which
  user, on which screen, doing what — and what makes them think it's a problem?
- **Find the users they're forgetting.** People picture the user they know best.
  Ask about the brand-new user, the impatient one, someone evaluating with a
  reason to walk away. Each distinct answer may be its own persona.
- **Question assumptions, gently.** "You expect people to look in Settings for
  export — what makes you think they go there, not the report they're already
  on?" Steelman their view first, then probe.
- **Offer friction ideas they haven't raised** — a confusing label, a button
  below the fold, a detour through an unrelated feature — and let them keep or
  drop each.
- **The decision test.** For each story, ask what they'd *do differently*
  depending on the result. If nothing changes, drop it.
- **Converge** on a small set — a few stories, each with exactly one goal.

Stories describe a goal, never a click-path: "Get this month's timesheet into a
spreadsheet for finance", not "Click Reports, then Export". Second person,
motivated, 2–4 lines. If they insist on exact clicks, that's really a regression
journey — check that's what they want.

## 3. Author the YAMLs

Write case files straight into a suite (no separate stories document).

**Always ask how much to research first** — whether they want you to *research
the app* or write a *pure black-box test* from the story alone:
- **Remote URL** (`https://app.example.com`): you can't see the source, so
  research means looking at the live site itself.
- **Local URL** (`http://localhost:3000`): the source is very likely your
  working directory, so research can also mean reading that code.
If you read code, use it only for setup plumbing (how to boot/reset the app) —
never to copy selectors, which the stories deliberately ignore.

**Read the schemas — the source of truth, not your memory:**
`src/schemas/case.schema.json` and `src/schemas/defaults.schema.json` describe
every key.

A suite is a folder with a `playtest.yaml` of shared settings — chiefly
`app.base_url` (point it at a test copy of the app, not the live one customers
use) plus model choices. Cases are discovered only in the suite root or a
`stories/` subdir: put journey cases under `stories/` (baselines collect in a
sibling `results/`; `playtest new <name>` scaffolds this), discovery cases at the
study root beside `personas/`.

**Always set `description`** — a one-line human summary shown in run lists (e.g.
"Add a todo and see it in the list"). It never reaches the actor, so it can't
change behavior; keep it faithful to the story.

### Journey cases (regression)

`story` + a `success` gate (every criterion must pass). The first run records a
baseline; later runs replay it and re-check the gate — tell the person that in
plain terms. The criteria, by driver (all deterministic except `assert`, which
the grader judges in natural language):

| Key | Example | Drivers | Passes when |
|---|---|---|---|
| `url_matches` | `"/cart*"` | web, api | The final URL (full or pathname) matches the glob. |
| `element_exists` | `"[data-testid=basket-item]"` | web | A Playwright locator matches on the final page — CSS by default, or `xpath=` / `text=` / `role=`. |
| `screen_shows` | `"~basket-item"` | mobile | An Appium native selector matches on the final screen — accessibility id (`~`), XPath, or predicate. The mobile analog of `element_exists`. |
| `api_called` | `"POST /api/cart"` | web, api | Some request matched the `METHOD /path-glob`. |
| `response_status` | `"2xx"` | api | Some response had this status — an exact code or an `Nxx` class. |
| `response_matches` | `"$.items[0].qty == 2"` | api | A dot/bracket JSON path over the last response body compares true (`==`, `!=`). |
| `console_errors` | `0` | web | The run finished with at most N browser console errors. |
| `assert` | `the basket shows one item` | web, mobile, api | The grader judges the claim true against the final page / screen / response. One model call per `assert`, even on replayed runs. |

**Choosing gates — a few durable checks beat many brittle ones**, on the surface
a user could point at:

- **Always start a web journey's `success` with `console_errors: 0`** —
  deterministic, free, and exactly what `playtest new` scaffolds.
- Prefer `url_matches` and `api_called` next — both survive refactors. Skip
  checks that fire on every page load regardless of what the user did.
- `assert` survives any redesign that keeps the UX intact, at one grader call
  per run. Quote load-bearing strings.
- `element_exists` only for stable hooks (`data-testid`, ARIA landmarks) — never
  CSS classes (a rename would redden the suite for no real regression). If the
  app has no such hook, say so — adding one is a small, worthwhile fix.

```yaml
description: Sign up with email and land on the dashboard.
story: |
  You just heard about this app and want an account. Sign up with your
  email and get to wherever new users land.
success:
  - console_errors: 0
  - url_matches: /dashboard*
  - assert: The page greets the new user and confirms the account was created.
```

### Discovery studies (insight)

Hand-author these (`playtest new` writes a journey template). The suite's
`playtest.yaml` sets `mode: discovery`; each case has a `story`, a `persona`
list (one run per persona), and `report` questions — questions the grader
answers from each run, never pass/fail assertions.

```yaml
description: Get timesheet data out as a spreadsheet, unprompted.
story: |
  You need this month's timesheet in a spreadsheet for finance. Get it out
  of the app however seems natural.
persona: [first-time-admin, power-user, skeptical-evaluator]
report:
  - Where did they look first, and what did they try before giving up?
  - At which screen did they expect an export button?
```

**Personas** — built-in `tester`/`exploratory`, or a `personas/<name>.yaml` with
two keys (`name`, `description`): second person, behavioral, honest about when
this user gives up. Mirror `src/harness/prompts/persona-exploratory.md`.
`playtest new persona <name>` scaffolds one into `./personas/` relative to cwd,
so run it from the suite root; confirm names resolve with `playtest personas`
from the suite dir.

## 4. Validate

```
playtest list <dir> --json
```

Read the JSON (exit is 0 even on zero matches): every story present; discovery
cases fanned out to `<case-id>@<persona>` with `next_run: explore`; journeys
show `next_run: record`. A config error exits 2 and names the file and key.

## 5. Hand off

- **Journey:** run it directly — `playtest <dir>`.
- **Discovery:** use the **playtest-discovery** skill (it owns the run, the
  test-environment check, and the synthesis).

Don't drive a browser from this skill.
