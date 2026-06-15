# Discovery mode — design + implementation handoff

Status: IMPLEMENTED 2026-06-12 (multi-agent workflow, phases 0-4; suite green at 39
tests). As-built deviations from this document: `report:` is allowed on journey cases
too (the grader answers it in either mode — softening of §2); the mergeDoc skip-list
addition in §3 was replaced by hard schema errors; npm test is `node --test
test/*.test.js` (§9's `node --test test/` does not work on Node >= 23); a second
skill, skills/playtest-stories (interview/authoring as an adversarial thought
partner, case YAMLs as direct output), was added beyond §7 and the discovery skill's
steps 2-3 defer to it; llm.js PRICING gained opus-4-8; the viewer renders grade
report answers with step deep-links; `runs_per_case` was removed entirely (2026-06-12,
post-implementation decision: same-invocation repeats were excluded from trend/streak,
so the field never served its anti-flake purpose — re-running the suite gives the same
samples and does feed trend). Original design follows unchanged.

Repo: this repository (`@jeremyvun/playtest`). Plain JS ESM, Node >= 20, no TypeScript.
Run `npm test` (currently `node --test test/harness.test.js`). User errors go through
`DummyConfigError` (src/harness/config.js) with friendly, actionable messages.

---

## 1. Motivation

Playtest today is a regression instrument: pinned cheap actor (Haiku), natural-language
stories with deterministic success gates, record → act → heal. See
`docs/playtest-design.md`.

The new use case is **discovery studies** on brownfield platforms:

> Team A needs to add a capability for goal A onto long-lived platform X. Where does it
> belong? Where in the flow do users expect it? Where do they get stuck today? Does the
> attempt disturb other flows? Instead of expensive human user testing, run goal-level
> stories through user personas and mine the trajectories for product insight.

Key reframe: this is **not** pass/fail testing. A `give_up` trajectory is the primary
data product — *here is where a competent, motivated user ran out of road*. Multiple
personas attempting the same goal give convergent evidence on where a capability is
expected to live.

Design constraints carried over from the existing tool:

- **Do not contaminate the regression instrument.** Principle #1 of the design doc
  (agent pinned, app is the variable) stays intact for journey cases. Discovery cases
  opt out explicitly and never touch CI exit-code semantics, baselines, trends, or the
  changed-journey review flow.
- **No new top-level commands.** A study is just a suite: a directory whose
  `playtest.yaml` sets `mode: discovery`. `playtest studies/foo/` just works. Existing
  config inheritance (nearest-wins, see config.js) already carries the model overrides.
- Per the project's standing preference: take every simplification that preserves
  functionality; no speculative abstraction.

---

## 2. New YAML surface (the whole config change)

### `mode: journey | discovery`

- Default `journey` (today's behavior, name chosen for the existing vocabulary).
- Inheritable like other scalar defaults: settable in `playtest.yaml` or a case file.
  `mergeDoc` in config.js already copies unknown top-level keys, so this is validation
  plus resolution, not new merge machinery.
- Lands on `ResolvedCase` as `mode`.
- Note the naming collision with the CLI `--mode auto|agent` flag: they are different
  axes (run strategy vs case kind). Discovery cases ignore `--mode` entirely.

### `personas: [name, ...]` (case file only, discovery only)

- Non-empty array of persona names (built-in or `personas/*.yaml`, resolved by
  actor.js `loadPersona` as today).
- Fan-out: a case with `personas: [a, b]` expands into one `ResolvedCase` instance per
  persona, id `<id>@<persona>`, `persona` set accordingly (singular `persona` is
  overridden). Expansion happens in `discoverCases` so everything downstream just sees
  more cases. `runs_per_case` stays orthogonal (multiplies as it does today).
- Config error if used in a defaults file or in a journey-mode case.

### `report: [question, ...]` (case file only, discovery only)

- Free-text questions the grader must answer from the trajectory, e.g.
  "At which screen would this user have expected an export affordance?".
- Lands on `ResolvedCase` as `report` (default `[]`). Answers land in `grade.json`
  (see §5) with step references so the viewer can deep-link evidence.
- These are deliberately questions, not assertions — discoverability findings have
  *answers*, not pass/fail.

### Cross-field rules

- Discovery cases must **not** declare `success` (config error naming the file).
- `perf` is silently irrelevant in discovery (the gate never runs). Do not error — it
  may be inherited from a shared root `playtest.yaml`.

### Example study

```yaml
# studies/timesheet-export/playtest.yaml
mode: discovery
actor_model: claude-sonnet-4-6
grader_model: claude-opus-4-8
max_steps: 60
app:
  base_url: https://staging.platform-x.example.com
```

```yaml
# studies/timesheet-export/export-as-csv.yaml
story: |
  You need this month's timesheet data in a spreadsheet for your
  finance team. Get it out of the platform however seems natural.
persona: [first-time-admin, power-user, skeptical-evaluator]
report:
  - Where did the user look first, and what did they try before giving up?
  - At which screen would this user have expected an export affordance?
  - Did the attempt disturb or detour through any other flow?
```

---

## 3. JSON Schemas for the YAML files (new, and load-bearing)

Two new schemas next to the existing ones in `src/schemas/` (already shipped in the
npm package `files` list):

- `case.schema.json` — story required; tags/persona/personas/success/perf/report/
  max_steps/timeout (and the nested `limits` spelling config.js normalizes)/
  actor_model/grader_model/runs_per_case/mode/app.
- `defaults.schema.json` — for `playtest.yaml`: same surface minus
  story/success/tags/report/personas (config.js `mergeDoc` already skips
  success/tags from defaults; add report/personas to that skip list and forbid them in
  the schema; `story` in a defaults file is almost certainly a bug today — forbid it).

Both `additionalProperties: false` (typo-catching matters double when an LLM authors
the files), every property carrying a `description` — **these schemas are the single
source of truth an authoring agent reads**, which is what makes the skill (§7) thin
and drift-proof.

config.js validates every loaded YAML doc with Ajv (already a dependency) against the
right schema before merging, mapping Ajv errors to `DummyConfigError` messages that
name the file and offending key. Existing semantic checks that schemas can't express
stay (success-kind shape, duration parsing, the §2 cross-field rules).

Compatibility check: `tests/playtest.yaml` and the demo suite under `src/demo/` must
still validate.

---

## 4. Discovery run semantics (runner + status plumbing)

In `mode: discovery`:

- **Always a fresh agentic recording.** Never read a baseline, never act, never heal,
  never write baseline/healed-candidate files. `playtest refresh` runs them but never
  accepts them as saved paths. Discovery never produces changed journeys.
- **The deterministic gate is skipped entirely.** A run ending in `done`, `give_up`,
  `max_steps`, or `timeout` gets terminal status **`explored`** (give_up is a valid,
  informative outcome). Env failures stay `infra`. Exit code: explored contributes 0.
- **Grading always runs** (unless `--no-grade`), with the discovery rubric (§5).

`explored` must be handled everywhere `pass`/`fail`/`infra` appear, following the
tense-matched display vocabulary in the design doc: finished form `explored`, live
in-progress form `exploring`, `playtest list` NEXT-RUN form `explore` (regardless of
stray baseline files). Touch points: report.js (`caseLine`, `summary`), live.js,
cli.js (`jsonSummary`, list command, JUnit — explored counts as a passing testcase),
view-server.js, src/viewer/app.js.

---

## 5. Actor and grader changes

### Actor (actor.js + prompts/)

New `prompts/actor-discovery.md`, appended to the Actor system prompt when the case
mode is discovery: articulate in `thought` what you are looking for and *where you
expected to find it* before trying alternatives; `give_up` deliberately with a
detailed reason when the app lacks the affordance.

Constraint: the `## Your task` marker must remain present and **last** in the system
prompt — mock-llm extracts the story by it (see the Actor constructor comment).

Note: discovery prompts are explicitly *not* part of the pinned regression instrument
and may iterate freely; the journey actor prompt remains pinned.

### Grader (grader.js + prompts/ + grade schema)

- New `prompts/grader-discovery.md`: discoverability rubric — where the user got stuck
  or backtracked, affordances sought but not found, on which screen they expected the
  capability, whether the attempt detoured through or disturbed other flows. Mirror
  the voice of `grader-system.md`.
- `gradeRun` selects the rubric by case mode; when `case.report` is non-empty it
  appends a `## Report questions` section and the grade must answer each.
- `src/schemas/grade.schema.json` gains an **optional, additive** `report` property:
  array of `{ question: string, answer: string, evidence_steps: int[] }`
  (required: question, answer).

---

## 6. Deliberately deferred (do not build now)

- **Built-in cross-run synthesis** (one study-report.md per study run, aggregating
  personas). The skill covers this conversationally for now: the PM's agent reads the
  run dirs' `grade.json` files and writes the report. Promote to a harness feature
  once the report shape stabilizes.
- **A `generate` command.** Generation lives outside the harness: the case format is
  the API, the schemas are the reference, the skill does the authoring. Revisit as
  `playtest new study <name> --brief brief.md` only after the skill's prompt
  stabilizes. (Rejected: lazy materialization of scenarios at run time — generated
  stories must be reviewable files in the tree, not run-time state.)
- New actor action types for "missing affordance". The free-form `thought` /
  `expectation` fields plus confusion events already carry the signal; the grader
  mines them.
- `playtest new` discovery scaffolding templates.

---

## 7. Distribution: the `playtest-discovery` skill

`skills/playtest-discovery/SKILL.md` (new directory in this repo, so it versions with
the tool). Audience: a PM using Claude Code/opencode against a long-lived internal
platform. YAML frontmatter (`name: playtest-discovery`, one-line trigger
`description`), body in imperative voice addressed to the executing agent. Flow:

1. **Preflight** — `playtest --version` and feature detection (the installed package's
   `src/schemas/case.schema.json` mentions `mode`); LLM key / `PLAYTEST_LLM_BASE_URL`
   configured. **Hard guardrail:** discovery agents really click buy/delete/submit —
   refuse anything that looks like production; require an explicit staging/test URL.
2. **Interview** the PM (goal, users, platform area, what counts as friction) →
   `brief.md` in a new study directory.
3. **Author** personas (`playtest new persona` or `personas/*.yaml`) and the study
   suite (§2 example shape). The agent must read the shipped schemas rather than trust
   memorized keys, and validate with `playtest list <study-dir> --json`.
4. **Run** — `playtest <study-dir>`, expectations set (minutes per persona,
   single-digit dollars per study; `--headed` for a first demo).
5. **Synthesize** — read each run's `grade.json` (report answers + findings) and
   trajectory digest; write `study-report.md` with convergent evidence across personas
   and run-dir/step references; point at `playtest view` for film-strip evidence.
6. **Iterate / promote** — refine and re-run; when a journey is validated, offer to
   turn it into a gated regression case (success criteria, tester persona, default
   models) in the team's `tests/` tree.

Keep the skill thin: defer key references to the schemas and `playtest --help`; don't
duplicate the design doc.

### Honest risks (adversarial review of the skill idea — keep these in mind)

- **The skill's real job is bootstrap + guardrails, not prose.** The likely failure
  mode is not bad YAML; it's a PM with no repo checkout, no staging URL, no API key —
  or worse, a production URL. Preflight and the staging guardrail are the product.
- **Version coupling.** The skill must feature-detect (step 1) rather than assume; a
  PM with last month's playtest gets confusing schema errors otherwise.
- **Drift.** Anything the skill states twice will rot. Hence: schemas as the single
  source of truth, skill shipped in this repo so it updates with the tool.
- **Who reads the output.** Without the synthesis step the PM gets N trajectories and
  zero answers; step 5 is mandatory, not optional polish.
- **Cost honesty.** Sonnet actor × personas × runs is real money and wall-clock;
  the skill should say so before running, not after.

---

## 8. Codebase findings (gathered 2026-06-12 — verify before relying)

Facts below were confirmed by direct reads of the working tree (which is **dirty** —
many modified + untracked files, no commit pin), so the picking-up agent should spot-
check line numbers before editing. Files marked *not yet read* are exactly what
Phase 0 of the plan maps.

### config.js (read in full)

- `DEFAULTS` (~line 11): `actor_model: claude-haiku-4-5`, `grader_model:
  claude-sonnet-4-6`, `max_steps: 50`, `timeout: "4m"`, `runs_per_case: 1`,
  `persona: tester`. `SUCCESS_KINDS = url_matches | element_exists | api_called |
  assert` (~line 20).
- `mergeDoc` (~line 216) copies **every** top-level key from every file, skipping only
  `success`/`tags` when the source is a defaults file, and merging `app:` per-key into
  an internal `env` accumulator. Consequence: `mode` inherits with **zero merge
  changes**; `report`/`personas` must be added to the defaults-file skip list. Also a
  pre-existing quirk: a defaults file can currently supply `story` — the new defaults
  schema should forbid it.
- `loadYaml` (~line 185): rejects a legacy `env:` key with a rename message; hoists
  `limits.max_steps`/`limits.timeout` to top level (schemas must allow both
  spellings); resolves `app.compose|init|storage_state` relative to the declaring
  file.
- `resolveCase` (~line 91) returns ResolvedCase with exactly: `id, file, name, story,
  persona, tags, success, perf, limits{max_steps, timeout_ms}, actor_model,
  grader_model, runs_per_case, env{base_url, compose, init, storage_state}`. `id` is
  the case path relative to the user-named root, `/`-joined — **ids already contain
  `/`**, so run-dir naming must already cope with separators; check how before picking
  `@` for fan-out ids.
- `discoverCases`/`walkCases` (~lines 41–89): cases come only from suite roots
  and `stories/` subtrees (a loose case-shaped yaml elsewhere is warned about, not
  run); skips dotdirs, `node_modules`, `personas/`, `results/`, `playtest.yaml`, and
  `*.baseline.*`/`*.healed.*`; tag filter and id sort happen here — the natural
  place for persona fan-out.

### cli.js (read in full)

- Exit-code contract enforced here: `die()` exits 2; run command maps gate results,
  `--fail-on-changed` promotes to 1 but never downgrades 2 (~line 331).
- `--mode` validated to `auto|agent` (~line 300). Status strings switched on in:
  `pendingChanged`/`isPendingChanged` (~185), `computeTrend` (non-infra filtering,
  ~108), `printNextActions` (~170), `jsonSummary` (~195), `viewJson` `--failed`
  filter (~396).
- `playtest list` NEXT-RUN = `readBaseline(c.file) ? "check" : "record"` (~lines
  487/499) — discovery must show `explore` here regardless of stray baseline files.
- `accept` refuses any run whose `manifest.result.status !== "pass"` (~line 523), so
  `explored` runs are naturally un-acceptable with no extra work — keep that property.
- Hidden commands `run/accept/reject/grade` exist; `grade` re-grades using
  `manifest.pins.grader_model` (~line 596).

### actor.js (read in full)

- `BUILTIN_PERSONAS = ["tester", "exploratory"]`; custom personas come from
  `personas/` dirs walked upward to the `.git` root (`personaDirs`, ~line 20);
  `loadPersona` throws a single-line error (runner truncates with firstLine).
- Actor system prompt (~lines 145–150) is exactly: `actor-system.md` + `## Persona` +
  `## Your task` — the constructor comment says the `## Your task` marker is
  **load-bearing for mock-llm story extraction**; the discovery overlay must keep it
  present and last.
- Turn shape (~line 158): system + `renderLog(history)` + current snapshot, extracted
  via `forcedToolCall` against `src/schemas/step.schema.json`. Action vocabulary
  (see `describeAction`): click, type, select, scroll, navigate, wait, done(summary),
  give_up(reason).

### grader.js (read in full)

- `gradeRun` (~line 45) builds sections `## Story / ## Trajectory (digest) /
  ## Gate result / ## Totals / [## Baseline] / ## Final page snapshot`, calls
  `forcedToolCall` with `grade.schema.json` (maxTokens 2048), writes `grade.json`.
  Rubric is the single `prompts/grader-system.md` — mode selection and the
  `## Report questions` section slot in here.
- `checkAssertion` (~line 105) is the separate natural-language `assert:` verdict
  path — untouched by this change.

### Layout / packaging

- `src/harness/prompts/`: `actor-system.md`, `grader-system.md`,
  `persona-tester.md`, `persona-exploratory.md`. `src/schemas/`: `step.schema.json`,
  `grade.schema.json` only. `test/`: single `harness.test.js`; npm test script is
  `node --test test/harness.test.js` (plan changes it to `node --test test/`).
- package.json: bin `playtest` → `src/harness/cli.js`; `files` already ships
  `src/schemas` and both docs; deps: ajv ^8, commander ^13, playwright ^1.53,
  yaml ^2.7; Node >= 20.
- `new.js`: `newCase`/`newPersona` scaffolding with slugify + suite detection;
  reserved case name `playtest`; templates are the documentation. Not in scope, but
  the skill leans on `playtest new persona`.
- docs/CONTRACTS.md section map (by heading line): §1 shared shapes L71 (ResolvedCase
  L73, step envelope L116, run dir L173, manifest L187, baselines L215), §2 config
  L226, §3 trajectory L239, §4 browser L269, §5 llm L360, §6 actor L385, §7 gate
  L426, §8 grader L449, §9 env L462, §10 runner L489, §11 report+live L541, §12 cli
  L570, §13 view-server L721, §14 mock-llm L787, §15 todo-app L809.

### Not yet read — Phase 0 must map these before implementation

`runner.js` (582 lines — the largest unknown: status/end_reason determination,
baseline read/write, healed-candidate writes, runs_per_case fan-out and run-dir
naming, grader call site, refresh acceptance), `gate.js`, `trajectory.js`,
`report.js`, `live.js`, `view-server.js`, `src/viewer/app.js`,
`testing/mock-llm.js`, `test/harness.test.js` contents, and the body of
CONTRACTS.md (only headings + ResolvedCase shape were verified).

---

## 9. Implementation plan (run as a multi-agent workflow)

Designed for parallel subagents with **strict file ownership** (the partition below has
no overlaps; do not relax it — two agents editing one file is how this fails). No agent
commits to git. Match existing code style: sparse comments stating constraints only.

**Tests:** the foundation step changes the package.json test script to
`node --test test/`. Each implementing agent adds coverage in its **own new file**
under `test/` following `test/harness.test.js` conventions, and self-checks with
`node --test test/<its-file>` plus `node --test test/harness.test.js`.

### Phase 0 — Map (parallel, read-only)

Produce file:line maps to hand to implementers:

1. **Runner map** — runner.js/gate.js/trajectory.js: where record/act/heal is decided,
   baselines read/written, healed candidates written, the gate runs, final status +
   `end_reason` determined and stored in the manifest, `runs_per_case` fan-out and
   run-dir naming (what characters are safe in a case id used as a dir name — fan-out
   ids contain `@`), grader call site, refresh acceptance.
2. **Status surfaces** — every place `pass`/`fail`/`infra` or `record`/`act`/`heal` is
   switched on or displayed: report.js, live.js, cli.js (jsonSummary, list, JUnit
   generation), view-server.js, src/viewer/. Output: a touch-point checklist for
   adding `explored`/`exploring`/`explore`.
3. **Test conventions** — test/harness.test.js + src/harness/testing/mock-llm.js: how
   fixtures/temp dirs work, how the mock LLM derives steps from the story via the
   `## Your task` marker, how an end-to-end run is exercised.
4. **Contracts digest** — docs/CONTRACTS.md §1 (ResolvedCase + manifest, quote the
   field list verbatim), §2, §6, §7, §8, §10, §11, §12, plus the doc's formatting
   conventions.

### Phase 1 — Foundation (single agent; everything later depends on its field names)

Owns: **new** `src/schemas/case.schema.json` + `src/schemas/defaults.schema.json`;
`src/harness/config.js` (Ajv validation per §3, `mode` resolution, §2 cross-field
rules, personas fan-out, `mode`/`report` on ResolvedCase); `package.json` (test
script); **new** `test/config-discovery.test.js` (schema rejects unknown keys;
defaults file rejects story/success/personas; mode inheritance; fan-out ids; report
resolution; success-in-discovery error; personas-in-journey error). Must verify
existing suites (`tests/`, `src/demo/`) still resolve identically.

### Phase 2 — Implement (three agents in parallel)

- **Runner + statuses.** Owns runner.js (gate.js/trajectory.js only if strictly
  needed), report.js, live.js, cli.js, view-server.js, src/viewer/app.js,
  testing/mock-llm.js (if needed to script a discovery run), **new**
  `test/runner-discovery.test.js` (end-to-end-ish discovery run via the mock LLM:
  status `explored`, exit 0, no baseline/healed files written, gate skipped; a
  `give_up` run still lands `explored`). Implements §4.
- **Grader + actor.** Owns **new** prompts/actor-discovery.md +
  prompts/grader-discovery.md, actor.js, grader.js, src/schemas/grade.schema.json,
  **new** `test/grader-discovery.test.js` (rubric selection; report-questions section;
  grade schema accepts a report array; actor system prompt has the discovery section
  with `## Your task` still last). Must **not** edit mock-llm.js (runner agent owns
  it) — stub at the llm seam instead. Implements §5.
- **Skill.** Owns **new** `skills/playtest-discovery/SKILL.md` only. Implements §7,
  including one complete worked-example study (playtest.yaml + story yaml + persona
  yaml as fenced blocks consistent with §2).

### Phase 3 — Verify (single agent, may touch anything to reconcile)

`npm test` green; then cross-slice seams tests may miss: fan-out ids vs run-dir
naming; `## Your task` last; grade.schema.json `report` block vs grader prompt;
viewer/view-server tolerate `explored` and don't crash on **old** runs; `playtest
list` / `--help` still run against `tests/` and the demo suite (no API key needed).
Confirm journey behavior unchanged. Re-run until green.

### Phase 4 — Document + adversarial review (parallel)

- **Docs.** Owns docs/CONTRACTS.md (extend §1/§2/§6/§8/§10/§11/§12 in the existing
  voice, additive), docs/playtest-design.md (new "Discovery studies" section, glossary
  + CLI examples, pointer to the skill), README.md if it lists features.
- **Review (read-only).** Hunt real, verified problems in the full diff, ranked:
  missed status plumbing, baseline files still written in discovery, exit-code
  regressions, schemas rejecting previously-valid suites, contract drift, prompt-
  marker breakage, skill instructions contradicting the implemented surface.

### Acceptance checklist

- [ ] `npm test` green (`node --test test/`)
- [ ] `playtest list studies/<example>` shows fan-out ids with NEXT-RUN `explore`
- [ ] A mock-LLM discovery run ends `explored`, exit 0, writes no baseline files
- [ ] `grade.json` carries `report` answers when the case declares `report:`
- [ ] `tests/` and `src/demo/` suites resolve exactly as before
- [ ] CONTRACTS.md matches the code; skill matches the schemas
