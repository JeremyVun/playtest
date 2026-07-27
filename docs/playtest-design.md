# Playtest

**AI-driven user-journey regression testing for web apps, mobile apps, and
HTTP APIs.** An actor agent role-plays a user and attempts a plain-language
story against a real surface — a browser, a mobile device, or an API. The
recorded trajectory is judged by deterministic gates and an LLM grader. Think
of it as an AI mystery shopper that files a report after every visit.

> We no longer have dedicated testers. Developers are responsible for testing,
> and selector-based E2E suites rot faster than anyone maintains them. Playtest
> exists so that "did the core user journeys break?" gets answered
> automatically, every night and on every release candidate — without anyone
> hand-maintaining brittle scripts.

Playtest ships in two forms that share one engine:

- the **local CLI** (`playtest`) with a standalone trajectory viewer, and
- the **hosted platform** — a control plane, isolated runner agents, and a web
  console for teams: suite snapshots, dispatched runs, changed-journey review,
  and a durable findings ledger.

Docs map: `README.md` owns usage and configuration reference;
`docs/CONTRACTS.md` indexes the authoritative behavior contracts;
`docs/ROADMAP.md` owns what's next. This document owns the concepts and the
reasoning behind them.

---

## 1. The idea in one diagram

```
 case (YAML)                        ┌────────────────────────────┐
 "buy shoes as a guest"       ┌────►│ Surface under test         │
        │                     │     │ web · mobile · HTTP API    │
        ▼                     │     │ (compose-managed or any    │
 ┌──────────────┐   acts via  │     │  deployed target)          │
 │ Actor agent  │─────────────┘     └─────────────┬──────────────┘
 │ (persona ×   │                                 │ snapshot,
 │  story)      │◄────────────────────────────────┘ telemetry
 └─────┬────────┘
       │  every thought + action + measurement recorded by the harness
       ▼
 trajectory ──► deterministic gate (assertions + invariants → pass/fail)
            ──► grader agent → quality score + findings
            ──► viewer, trends, findings ledger, CI exit code
```

Four principles run through everything:

1. **Comparability is guarded by pins.** Every run stamps its material runtime
   and artifact pins — harness version, step schema version, snapshot format,
   settle heuristic, and actor and grader models — and the harness refuses to
   compare runs or trends across those boundaries. Prompt text evolves with the
   code and is not independently versioned.
2. **The harness does all the accounting.** The agent only ever sees a
   snapshot and decides one next action. Recording, token budgets, retries,
   timeouts, artifact capture, validation, redaction — all harness
   responsibilities. The agent is deliberately kept stateless and dumb.
3. **The step schema is the real interface.** The actor writes into it, the
   telemetry annotates it, replay executes straight out of it, and the grader
   and viewer read it. Everything else is implementation.
4. **One engine everywhere.** The hosted runner executes cases through the
   same public core API (`packages/core/src/public/`) the CLI uses. Hosted adds
   coordination — snapshots, dispatch, review, retention — never a second
   test semantics.

---

## 2. Core concepts

### Cases and suites

A case is a YAML file containing a **user story in natural language** plus
machine-checkable **success criteria**. No selectors, no step-by-step script —
the agent figures out *how*; the criteria define *done*.

```yaml
# checkout/stories/guest-checkout.yaml
tags: [smoke]
story: |
  You want to buy a pair of running shoes without creating an account.
  Find a pair, add it to the cart, and complete checkout as a guest
  using the provided test credit card.
persona: tester                    # tester · exploratory · adversarial · custom
success:                           # deterministic gate — all must hold
  - url_matches: "/order/confirmation/*"
  - element_exists: "[data-testid=order-number]"
  - api_called: "POST /api/orders"
  - assert: "the order total shown matches the cart total before checkout"
```

Because the story is natural language, a UI refactor (renamed buttons, moved
nav, redesigned checkout) does **not** break the test — the agent re-finds its
way. The test only fails when the *task* can no longer be completed or the
success criteria no longer hold. That is the core advantage over
selector-based E2E suites.

There is no suite manifest. A **suite is a directory** with a `playtest.yaml`
of shared defaults (driver, target, models, limits); every case YAML below it
belongs to it, discovered automatically. Nearest `playtest.yaml` wins, like
`.gitignore`. Selection is by path (`playtest checkout/`) and by tag
(`playtest . --tag smoke`); tag membership lives in the case file itself,
visible in code review. Adding a test is dropping a file in the tree.
Case files are schema-validated as they load — an unknown key is a config
error naming the file and the key, never a silent default.

### Drivers: one loop, three surfaces

`app.driver` selects the surface. The actor loop, gate, grader, artifacts,
and viewer are shared; each driver supplies its own snapshot, action verbs,
and capture.

| | **web** (Playwright) | **mobile** (Appium) | **api** (HTTP) |
|---|---|---|---|
| Snapshot the actor sees | Pruned accessibility tree | Native accessibility tree | Base URL + OpenAPI operations + last response |
| Actions | click, type, select, scroll, navigate, back, wait | tap, type, swipe, scroll, back, wait | request (method, path, headers, body) |
| Also captured | Screenshots, MHTML, HAR, console, perf, axe | Screen captures | Full request/response trace (HAR) |
| Replay & heal | Yes, with mid-heal re-anchoring | Yes, with mid-heal re-anchoring | Yes, with evidence-based heal triage |

Web and mobile end every action with a durable resolved locator (role, label,
test id — never a snapshot-instance ref), which is what makes recorded paths
replayable weeks later. The API driver is different in kind, not just in
transport:

- **A recorded API journey is a program, not bytes.** Where a request reuses
  an id an earlier response invented, the baseline records the *edge*
  (`POST /accounts/{{id_1}}/activate`, bound to step 1's `$.id`), so the same
  path replays against a fresh instance whose ids all differ.
- **Drift is judged on response *shape*, not values** — fresh ids and
  timestamps never trigger a heal, while a renamed, added, or removed field
  always moves the comparison.
- **Secrets never touch YAML, prompts, or baselines.** Credentials are
  `$secret:` references resolved from the environment, scrubbed from every
  artifact; an acceptance **leak scan** blocks any baseline that carries
  credential-shaped tokens or undeclared application data.
- An **egress guard** confines requests to allowed origins.

### Personas

A persona is a system-prompt overlay on the actor. Three are built in:
**tester** (competent, goal-directed, low variance — the stable regression
instrument), **exploratory** (a plausible real user: impatient, skims, gives
up sooner — produces findings rather than pass/fail), and **adversarial**
(completes the mission but stresses forms, boundaries, and recovery paths —
forced-risk discovery, not a security red-team). Custom personas are
zero-code: a small YAML file describing who the user is.

The delta between personas is itself a signal: if the tester completes a flow
the exploratory user can't, the feature works but users won't find it.

### Discovery studies

Everything above treats the agent as a regression instrument. A **discovery
study** turns the same machinery toward a different question — not "does this
journey still work?" but "where do users expect a capability to live, and
where do they get stuck today?" A study is a suite with `mode: discovery`:
goal-level stories fan out across personas, every run is a fresh exploration
(no baseline, no gate, status `explored`, excluded from trends), and the
grader answers the case's `report:` questions with step numbers as evidence.
A `give_up` trajectory is the primary data product — *here is where a
competent, motivated user ran out of road*.

Packaged skills wrap the workflow: `playtest-stories` interviews a PM and
authors cases; `playtest-bughunt` authors forced-risk defect-detection
studies; `playtest-discovery` runs a study end to end. Playtest's
responsibility ends at grounded evidence; the repair workflow for a
downstream builder is described in
[`guidance/finding-repair-policy.md`](guidance/finding-repair-policy.md).

### The actor loop

Each turn the harness:

1. Captures the driver's **snapshot** — for web, visible and interactable
   elements only, each with a stable reference id, typically 1–4K tokens.
2. Sends the agent its context: story, persona, a compacted append-only log
   of everything so far, and the latest snapshot.
3. Receives exactly one **structured step**: a free-text `thought`, one
   `action` from the driver's small fixed vocabulary, and an `expectation` of
   what should happen next.
4. **Validates and executes** the action inside a measurement window, then
   waits for the surface to settle. Failures come back as structured errors,
   never crashes; repeated failures and outcomes contradicting the stated
   expectation are recorded as **confusion events**.
5. Appends the step envelope to the trajectory and loops, until `done`,
   `give_up`, `max_steps`, or `timeout`.

Context is engineered for prompt-cache efficiency: stable prefix first,
append-only log, only the current snapshot varies at the tail. Long scenarios
stay cheap; 40+ steps without context bloat.

### The step contract

The actor's whole turn is one schema-validated object
(`packages/core/src/schemas/step.schema.json`, currently version 8), with per-driver
verbs overlaid onto one canonical schema. `thought` and `expectation` are
deliberately free-form — over-structuring reasoning degrades it. The harness
wraps each step in an **envelope**: one line of `trajectory.jsonl` carrying
the agent's output, the resolution (durable locator or request actually
issued), the result, per-step telemetry, artifact pointers, and token
accounting. The envelope is the index against everything too heavy for the
agent's context — screenshots, full DOM, network entries live on disk and are
referenced by pointer. Newer fields are additive (`bindings`, `expect`,
`raises`); old tooling skips what it doesn't know.

### Model access

All model calls go through a single fetch-based client speaking the OpenAI
chat-completions contract. `PLAYTEST_LLM_BASE_URL` is required — there is no
default endpoint — and points at any compatible gateway; the key falls back
through `PLAYTEST_LLM_API_KEY` → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY`.
Model names are **aliases** resolved through `packages/core/src/models.json`
(overridable per alias via environment), and every case can set `actor_model`
and `grader_model` independently. Several distinct roles ride the same
client: actor, grader, discovery synthesis, findings consolidation, script
authoring.

Step extraction is a **forced tool call** — the step schema is registered as
a function and `tool_choice` pins it, so every actor turn arrives structured;
the harness still validates against the schema and retries once with the
error attached. Prompt caching on the stable prefix is on by default and is
part of the cost model; the gateway base URL is stamped into every run
alongside the model pins, because retries, fallbacks, and translation
behavior all change actor behavior.

### Execution modes: record → act → heal

Selector suites rot because humans maintain the scripts. Playtest has no
script artifact at all: the agent's own recorded run is the executable path,
and the agent re-records it when the surface changes. The mode is chosen
automatically per case:

```
first run, or a refresh
       │
       ▼
record ─▶ the agent improvises; a passing run is saved as the baseline
       │                                          (the "saved path")
       │   every later run re-executes that path, step for step,
       │   with no actor model calls — seconds, ~free:
       ▼
act    ─▶ all steps pass ──────────────▶ checked            ✓ green
       │
       │   a step fails — an element is gone, the surface changed
       ▼
heal   ─▶ the agent wakes at the failure point and finishes the task
       │
       ├─ finishes green ─▶ changed ─▶ human reviews the diff:
       │                     accept → healed run becomes the new baseline
       │                     reject → discarded, baseline unchanged
       └─ still fails ────▶ tried to heal                    ✗ broke
```

The **baseline** is a pointer to a trajectory — committed beside the suite as
`results/<case>.baseline.jsonl` — and acting it means walking its **action
track**: every step that actually executed, re-run through the same
validation and measurement path, using the durable locator captured at
execution time. A healed run's trajectory is already complete (acted prefix
plus improvised recovery), so promotion is moving a pointer, not splicing a
file. Healed and leak-flagged runs become **pending candidates**, never
auto-promoted; review is an explicit `baseline accept`/`reject`.

Two refinements keep healing honest and cheap:

- **Re-anchoring** (web and mobile): mid-heal, after each agentic step, the
  harness checks the fresh snapshot against the remaining baseline window and
  resumes deterministic replay as soon as the path re-converges — the agent
  heals the gap, not the rest of the run.
- **Heal triage** (api): before any model is involved, the failure is
  classified from recorded evidence alone. A `regression` (5xx, vanished
  resource, a refusal the API used to make) stays red loudly — there is no
  valid rebind to accept. Only `contract drift` (the surface moved but the
  goal is reachable) can become a changed journey, and only if the actor's
  own `done` was reached, at least one hard deterministic check actually
  evaluated, and the full gate passed. Triage can turn a pass red, never
  rescue a failure.

A healed run that ends green means: *the app changed, but the user journey
survived*. This collapses the classic flaky-E2E problem — selector rot
triggers a heal, not a red build. The vocabulary stays theatrical: act mode
is a fresh performance following the baseline recording; "replay" is reserved
for re-watching in the viewer.

### The oracle: who decides pass/fail

Two layers, deliberately separated:

1. **Deterministic gate** (decides the exit code): the `success:` assertions,
   perf thresholds, and **invariant policies** — machine-checked facts about
   the recorded run. The one exception is `assert:`, a natural-language claim
   judged by the grader against the final state; it is the only model
   involvement in the gate, and it is per-criterion and narrow. CI trusts
   only this layer.
2. **Grader** (advisory): reads the trajectory, final state, and telemetry
   and produces a structured report — completion quality, efficiency versus
   baseline, confusion events, free-form findings ("the error message after
   an invalid card is blank"). Scores trend over time; a regression against
   the rolling baseline warns, never fails the build.

**Invariants** deserve their own sentence. An `invariant:` criterion declares
a *property* over the run's recorded network trace rather than a single
expectation: Tier 1 policies come free with an OpenAPI spec (no 5xx, every
status documented, bodies match schema); Tier 2 policies are opt-in
metamorphic checks (round-trip, idempotency, lifecycle-after-delete,
pagination, error envelope shape). A declared policy the story never
exercised **fails** — an invariant that never ran has not held. Because a web
run records its page's network traffic in the same HAR shape, the same
policies gate web journeys passively: *the UI looked fine, but did the API
underneath behave?*

### Telemetry: the action is the unit of measurement

Every executed web action — improvised or acted — opens a measurement window
at input dispatch and closes at settle. Everything inside is attributed to
that step: an INP-style responsiveness number, console errors, failed or slow
requests, long main-thread tasks, time-to-settle, and Web Vitals per
navigation. Invisible to the agent, free on every run, and it catches what an
agent cheerfully clicks past — the page that "works" while throwing 14
console errors, the checkout that got 800ms slower. Perf assertions gate on
these; the reporter trends them.

One honest engineering note: the **settle heuristic** (when is an SPA
"done"?) is the hard problem here and doubly load-bearing — it closes each
perf window *and* gates replay progression. It is pinned with the harness
version; changing it requires a refresh, because it shifts every timing
trend.

### Artifacts and the trajectory

Every run writes a self-contained, self-describing directory:

```
runs/<run-id>/<case-id>/
  manifest.json        # pins, verdicts, per-step artifact index
  trajectory.jsonl     # one step envelope per line — the spine
  har.json             # full network log; envelopes reference entries by index
  grade.json           # grader output
  drift-report.json    # api heals: classification, signals, narrative
  video.mp4 + .vtt     # slideshow stitched from per-step stills
  trace.zip            # native Playwright trace — known-good fallback viewer
  steps/               # per step: .png screenshot, .mhtml page, .a11y.txt snapshot
```

The MHTML snapshots mean any step can be reopened in a browser later, exactly
as the agent saw it — no app needed, so triage is offline and post-hoc
questions ("was the banner present at step 9 last Tuesday?") stay answerable.

Storage sits behind a provider seam: a run is either a plain directory or a
sealed **`.ptrun` bundle** — a deterministic, content-addressed zip with
per-entry hashes and retention tiers — and the viewer consumes both
identically. Bundles are what runners upload to the hosted platform and what
CI archives as build artifacts.

### The trajectory viewer

The viewer (`playtest view`) is a standalone static app that consumes a run
directory or bundle — it works from a CI artifact download, offline, with no
backend. The primary surfaces: a film strip with ghost cursor and thought
captions (watching the AI use the app is the product demo); a "what the agent
saw" toggle between screenshot and accessibility snapshot; expectation-vs-
outcome badges making confusion visible; the **heal diff** — old baseline and
healed run diffed on their action tracks, screenshots at the divergence
point, with the exact `baseline accept` command; per-step network waterfalls;
inline telemetry and cost; cross-run sparklines. The same viewer is embedded
in the hosted web console.

Failure triage is always one of four verdicts, designed to be callable in
under a minute:

| Verdict | Looks like | Response |
|---|---|---|
| App bug | Task genuinely impossible, assertion fails, errors thrown | File it. This is the product working. |
| App changed | A heal succeeded, or the agent succeeded a new way | Review the heal diff, accept the changed journey. |
| Agent flake | Agent confused on an unchanged, working page | Re-run; if persistent, tune the story. |
| Environment flake | Container/seed/network/health-probe failure | Distinct exit code; never a test failure. |

---

## 3. Script suites: API testing as code

Journeys are persona-shaped and story-paced; some API testing wants neither.
A **script suite** is the second execution family: a plain Node module,
written by an autonomous authoring loop and reviewed like code, that
exercises one authorized API target directly.

```
authoring job                     replay
┌─────────────────────────┐       ┌──────────────────────────┐
│ model writes suite.mjs  │       │ sandboxed child process  │
│  ↓ runner executes it   │  ──►  │  injected client (origin │
│  ↓ loop until sound     │       │  /budget/secret guards)  │
│ human approves version  │       │  check() verdicts        │
└─────────────────────────┘       └───────────┬──────────────┘
                                              ▼
                              har.json · script-report.json · exit status
```

The trust discipline is the point:

- **Two-column verdict.** `report_pass` (the script's own checks) and
  `gate_pass` (invariant policies over the recorded HAR) are judged
  independently, on top of a soundness bar. A failing check on a sound suite
  is a candidate finding about the API; an unsound suite indicts the script,
  not the API.
- **Coverage obligations are mechanical.** The obligation manifest is derived
  from the OpenAPI spec, the declared policies, and approved rule cards —
  never authored by the model or the script. Every obligation must land as
  covered, skipped, or unsupported; anything unaccounted fails soundness no
  matter how many checks passed. Sufficiency is auditable, not asserted.
- **Approval lifecycle.** Every script version is born pending; only a human
  approver promotes it; any edit invalidates back to pending; only approved
  content dispatches. A red replay is triaged without a model — a regression
  stays red; contract drift yields a *proposed* new pending version, mirroring
  journey heal triage.

Contract: [`contracts/scripts.md`](contracts/scripts.md).

---

## 4. Findings: from one run's observation to a durable defect

A grader observation lives and dies with its run. A **finding** is the
durable object: a typed, cited claim that the app malfunctioned, grounded in
recorded evidence, with identity that survives across runs.

Locally, `playtest findings consolidate` sweeps discovery grades into a
per-suite SQLite ledger and proposes groupings (never applied unconfirmed);
`findings list/accept/reject/resolve` triages them; `findings export` writes
a portable JSON document. On the hosted platform findings are first-class:
machine-filed claims from run grading and study synthesis land directly as
findings in state `new` (there is no separate "bug candidate" queue anymore),
deterministic fingerprints catch exact recurrence, a retrieve-then-verify
consolidation pass proposes semantic merges, and an **auto-resolve** sweep
stamps findings resolved when newer runs deterministically disprove them.
Judgment-call findings that can't be re-tested deterministically get a
narrow model-assisted fix-verification that only ever produces a
*suggestion* for the reviewer — resolution stays a human verb.

Playtest's responsibility ends at grounded, deduplicated evidence.
Investigation and repair belong to the downstream builder;
[`guidance/finding-repair-policy.md`](guidance/finding-repair-policy.md) is
the evidence-backed policy for that handoff (consolidate, probe, repair only
the supported issue, pin a regression, verify collateral).

---

## 5. The hosted platform

The hosted product is the same engine with team coordination around it:

```
┌───────────────┐   HTTP + event feed   ┌─────────────────────────────┐
│ Web console   │◄─────────────────────►│ Control plane               │
│ (static app,  │                       │ auth · suites · snapshots   │
│  embeds the   │                       │ dispatch · review · findings│
│  run viewer)  │                       │ retention · /api/v1         │
└───────────────┘                       └───────┬───────────▲─────────┘
                                        dispatch│           │runner protocol
                                                ▼           │(scoped tokens)
                              ┌─────────────────────────┐   │
                              │ Runner agent (isolated) │───┘
                              │ materialize snapshot →  │
                              │ run via core public API │
                              │ → upload .ptrun bundle  │
                              └─────────────────────────┘

        storage: one SQLite file + content-addressed object store,
        both under PLAYTEST_DATA_DIR — one volume, one writer
```

The design choices worth knowing:

- **The control plane is the only writer.** All state changes go through it;
  runners speak a retry-safe HTTP protocol with short-lived tokens scoped to
  one run group and never touch the database. Dispatch (local child process
  in dev, GitHub Actions with OIDC in CI) is placement only, never the
  system of record.
- **Suites are files, snapshots are immutable.** A hosted suite is stored as
  the same files the CLI reads, validated by the same core code. Every
  committed edit creates a content-addressed snapshot; a run group pins one
  snapshot plus the then-current baselines, so in-flight and historical runs
  are immune to later edits.
- **Events are the push channel.** Every state change writes a platform
  event transactionally with its mutation; browser clients long-poll a
  durable cursor. That is how the console live-updates runs, findings, and
  review without polling loops.
- **Review is contextual and explicit.** A healed run surfaces as a pending
  candidate on its own run page; acceptance requires the reviewer role,
  matching baseline lineage, a passing source run, and verified bundle
  integrity — and a later clean pass auto-supersedes stale candidates.
  Confirmation and external handoff (copy for tracker) are human actions;
  Playtest never auto-files tickets.
- **No database service.** Metadata is one SQLite file (WAL, single node);
  artifacts live beside it in the object store. `PLAYTEST_DATA_DIR` is the
  single storage knob.

Contract: [`contracts/hosted.md`](contracts/hosted.md).

---

## 6. Using it

Usage, configuration, and the full command table live in `README.md`. The
shape of a day:

```
playtest checkout/                    # run a subtree: record, check, or heal as needed
playtest . --tag smoke                # PR gate, ideally against a preview deployment
playtest view --changed               # review changed journeys awaiting acceptance
playtest baseline accept <runDir>     # promote a reviewed heal to the saved path
playtest baseline refresh checkout/   # re-record saved paths after intentional change
playtest new <name> --driver api      # scaffold a case
playtest export checkout/             # render saved paths as standalone Playwright specs
```

`playtest export` is the deliberate escape hatch: one-way generation of real
`@playwright/test` specs from accepted web baselines, so leaving Playtest
still leaves you with runnable tests — and so a skeptic can read, in a
language they already trust, exactly what a green run executes.

Environments are either **managed** (`app.compose` — Playtest boots an
isolated stack per case, safe to parallelize) or **external** (`base_url`
points at staging or a PR preview; health-probed before each run, serial by
default against shared state). Isolation in external mode is the user's
responsibility: the agent genuinely clicks buy, delete, and submit.

CI integration: exit codes `0` pass/explored, `1` gate failure, `2`
environment/infra (never counted as a test failure); JUnit output; the run
directory or bundle uploads as a build artifact so the viewer is one click
from a failed build. Recommended shape: smoke tag on PRs (replay mode, fast),
full tree nightly, grader trends weekly.

**Lifecycle rule:** everything stamped in `manifest.pins` — models, prompts,
personas, snapshot format, step schema, settle heuristic, gateway URL — is
upgraded like a dependency: bump, `refresh`, review. The harness refuses to
compare scores or trends across pin boundaries.

---

## 7. Cost & speed expectations

- **Checked runs** (the steady state): no actor model calls — one cheap
  grader check per `assert:` criterion at the gate. Seconds per case plus app
  boot; zero boot in external mode.
- **Record/heal runs**: a 30-step scenario on a small actor model with prompt
  caching lands at low single-digit cents; one grading call adds roughly the
  same. A 100-case full record pass is a few dollars. This assumes prompt
  caching survives your gateway — verify `cache_read` tokens before trusting
  the economics.
- **Wall clock is the real budget**: minutes per agentic case. Managed-mode
  cases parallelize per compose project; external-mode cases default to
  serial.

---

## 8. What Playtest is not

- **Not a unit/integration test replacement.** It covers user journeys and
  API contracts, not logic branches.
- **Not exhaustive.** It tests the journeys someone wrote stories for — it
  paves and maintains golden roads, but cannot declare an untraversed road
  safe. Coverage is a human responsibility; maintenance is what Playtest
  removes.
- **Not a load-testing or security tool.**
- **Not safe against real third parties.** Environments must be hermetic:
  seeded data, mocked externals, test payment rails. The agent *will* press
  the buy button. Pointing Playtest at a deployed URL is pointing an
  autonomous user at it — staging with test rails, never production.
- **A11y caveat:** web and mobile actors navigate by accessibility tree. A
  semantically empty page (div soup, no labels) starves the agent — reported
  as an accessibility finding, distinct from a functional failure. Vision
  mode (screenshots to the actor, default-on for discovery) softens this,
  but very poor markup remains a real limit.

---

## 9. Glossary

User-facing terms (the words the CLI and docs lead with):

| Term | Meaning |
|---|---|
| Suite | A directory with `playtest.yaml` defaults; every case YAML below it belongs to it. |
| Case / story | A YAML user-journey file inside a suite: a story plus success criteria. |
| Driver | The surface a suite targets: `web`, `mobile`, or `api`. |
| Run | Execute the selected cases (`playtest [paths...]`): recording, checking, or healing as needed. |
| Saved path | The user-facing word for the baseline: the trajectory later runs re-execute. |
| Changed journey | A successful healed run awaiting review — the app changed, but the journey survived. |
| Accept / reject | Approve or dismiss a pending candidate as the case's new saved path (`playtest baseline accept|reject`). |
| Refresh | Re-record saved paths from scratch; also clears accumulated detours. |
| Discovery study | A suite with `mode: discovery`: goal-level stories run fresh through personas for product insight instead of pass/fail. Runs end `explored`. |
| Finding | A durable, deduplicated, evidence-cited defect claim that survives across runs — in the local ledger or the hosted platform. |
| Script suite | An authored, human-approved Node module exercising an API target directly; the non-journey execution family. |

Finished-run statuses read `recorded`, `checked`, `tried to heal`, `changed`,
`accepted`, `explored`; the live display uses `recording` / `checking` /
`healing` / `exploring`. Internally the code keeps `record`, `act`, `heal`,
and `explore`.

Mechanics and internal terms:

| Term | Meaning |
|---|---|
| Actor | The agent that performs the task (`actor_model`, an alias your gateway resolves). |
| Grader | The agent that scores a finished trajectory and judges `assert:` criteria (`grader_model`). |
| Step envelope | The versioned per-step record: agent output + resolution + result + perf + artifact pointers. One line of `trajectory.jsonl`. |
| Trajectory | The complete recording of one run: the sequence of step envelopes. Every run produces one. |
| Baseline | The saved trajectory a case replays — the current known-good path. Accepted heals and refreshes move it. |
| Candidate | A healed or leak-flagged run held for review before it can become the baseline. Never auto-promoted. |
| Action track | The actable projection of a trajectory: the steps that actually executed, with durable locators. Computed, never stored. |
| Act | To re-execute the baseline's action track step for step as a fresh run against the live target. |
| Heal | Agentic recovery from a failed acted step; re-anchoring resumes deterministic replay when the path re-converges. |
| Heal triage | The api driver's pre-model classification of a failed replay: `regression` (stays red), `contract drift` (reviewable), `baseline drift` (environment). |
| Binding | A recorded data edge in an API baseline (`{{id_1}}` ← step 1's `$.id`) that replay re-reads from fresh responses. |
| Invariant | A declared property checked over the run's recorded network trace (no 5xx, idempotency, pagination, …). Unexercised policies fail. |
| Leak scan | The acceptance-time sweep for credential-shaped or undeclared data in a would-be baseline; findings block automatic acceptance. |
| Gate | Deterministic assertions + invariants + perf thresholds; the only thing that fails CI. |
| Confusion event | Harness-detected floundering: failed/repeated actions, backtracking, expectation-vs-outcome mismatches. |
| Pins | The comparability stamp in `manifest.json`: harness, prompts, step schema, snapshot format, settle, models, gateway. No comparisons across pin boundaries. |
| `.ptrun` bundle | A sealed, content-addressed zip of a run directory; what runners upload and the viewer reads interchangeably with directories. |
| Snapshot (hosted) | An immutable content-addressed capture of a suite's files; run groups pin one. |
| Run group | One dispatched batch of hosted runs: pinned snapshot + baselines, scoped runner tokens, one ledger entry. |
| Rule card | A human-approved check pattern that feeds script-suite coverage obligations. |
| Replay | Reserved for the viewer: re-watching the recording of a past run. Never an execution mode. |
| Bless / rebaseline | Historical names for `baseline accept` / `baseline refresh`. |

---
