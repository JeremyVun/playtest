# Playtest

**Automated user-journey regression harness** for
- Web (Playwright)
- Mobile (Appium)
- REST APIs

> [!IMPORTANT]
> Playtest can pave and maintain the golden roads you define in your story yaml files. But it cannot declare an untraversed road safe.

An `actor` agent role-plays a user persona and attempts to complete a plain-language story
against a real surface (browser, mobile device, HTTP API). The resulting trajectory is
evaluated by programmatic gates and an LLM `grader` to form a regression history.

```
 playtest case (YAML)              ┌─────────────────────┐
 "do task x as a tester"     ┌────►│ App under test      │
        │                    │     │ (docker-compose     │
        ▼                    │     │  or deployed URL)   │
 ┌───────────────┐    act    │     └──────────────┬──────┘
 │ Actor agent   │───────────┘                    │ a11y, screenshots,
 │ (actor_model) │◄───────────────────────────────┘ telemetry
 └─────┬─────────┘
       │  trajectory: thoughts + actions + state + metrics
       ├──────────────────────────────────┐
       ▼                                  ▼
 ┌─────────────────┐         ┌──────────────────────┐
 │ Gate            │         │ Grader               │
 │ assertions →    │         │ (grader_model) →     │
 │ pass / fail     │         │ score + findings     │
 └────────┬────────┘         └──────────┬───────────┘
          │            result           │
          └──────────────┬──────────────┘
                         ▼
             ┌────────────────────────┐
             │ Trajectory viewer      │
             │ playback + trends      │
             └────────────────────────┘
```

Docs map: this file (usage) · [`docs/playtest-design.md`](docs/playtest-design.md) (why) ·
[`docs/CONTRACTS.md`](docs/CONTRACTS.md) (contract index) · [`docs/ROADMAP.md`](docs/ROADMAP.md)
(what's next, and where every plan lives).

## Install

> **Local distribution.** Registry publishing is intentionally descoped. To use
> Playtest, use Node.js 24 LTS (24.18.0 or newer), clone the repository, and
> link it:

```sh
git clone <this repo> && cd playtest
npm install
npm link --workspace=@playtest/cli  # puts `playtest` on your PATH
playtest install-skill   # optional: teach your coding agent to drive it (run inside your project)
```

`npm install` also builds the self-contained trajectory viewer and hosted
console with Vite. Run `npm run build:web` after changing their TypeScript
sources if you are not entering through a test or server command that builds
them automatically.

To use the complete hosted web platform locally, run one command from the
repository root:

```sh
npm run hosted
# → http://127.0.0.1:4177
```

This builds both Vite applications, starts the control-plane API and web host,
and starts **one peer runner** beside them. There is a single placement model:
a launch posts to a claim board, and a runner polls, claims, and executes it.
Local development uses the same path CI and a fleet do — the control plane
starts nothing in response to a launch and never connects to a runner. The web
and runner workspaces are not separate services to start manually.

A remotely hosted control plane cannot reach an app on your `localhost`, a build
on your disk, or a device simulator. For those, run a **self-hosted runner** on
the machine that already has them: register it under Settings → Runners, start it
with the one command shown, and give a ring its labels —
[`docs/guidance/hosted-runners.md`](docs/guidance/hosted-runners.md) is the walkthrough.

## Quickstart

**1. Against your own app.** The CLI does **not** load `.env`; export both
variables — a key alone does nothing (see [Environment variables](#environment-variables)):

```sh
export PLAYTEST_LLM_BASE_URL="https://your-openai-compatible-gateway"   # bare origin, no /v1
export PLAYTEST_LLM_API_KEY="..."

playtest new add-to-cart ./suite   # scaffold a case + playtest.yaml (--driver web|mobile|api)
# edit ./suite/playtest.yaml (app.base_url) and the case's story/success criteria, then:
playtest ./suite                   # first run records the journey
playtest view                      # watch it in the trajectory viewer
```

**2. On the maintainer's Codex subscription (no API key).** The standalone sibling repository
`../codex-gateway` exposes the preserved OpenAI-compatible Playtest route backed by a
ChatGPT/Codex login — local interactive use only, never CI:

```sh
npm --prefix ../codex-gateway install
GATEWAY_DISABLE_GPT=1 npm --prefix ../codex-gateway start  # http://127.0.0.1:8787
# in another shell:
PLAYTEST_LLM_BASE_URL=http://127.0.0.1:8787 playtest examples/todos --fresh
```

`tools/codex-gateway/` is a compatibility launcher for old commands. Set
`CODEX_GATEWAY_ROOT` if the repositories are not siblings. See the standalone repository's
`README.md` and `docs/DESIGN.md` for configuration and the credential-firewall contract.

**With a coding agent.** After `playtest install-skill`, prompt your agent, e.g.:

> "Use Playtest to create a regression suite for my (web app | mobile app | api) at http://localhost:3000"

or, for discovery mode:

> "I have an idea for feature X but I'm not sure where it fits. Create playtest discovery
> stories for persona Y trying to do task Z, to find the pressure points in the current flow."

## Environment variables

A real run needs **both** of these — a bare key with no base URL fails preflight, because
there is no default endpoint:

| Variable | Meaning |
|---|---|
| `PLAYTEST_LLM_BASE_URL` | **Required.** An OpenAI-compatible gateway origin, e.g. `https://gateway.example.com` — the harness appends `/v1/chat/completions` itself, so don't include `/v1`. Any explicit value counts as "available" with no key — point it at a mock or a keyless gateway. |
| `PLAYTEST_LLM_API_KEY` | API key sent to that gateway; falls back to `ANTHROPIC_API_KEY`, then `OPENAI_API_KEY`. |

A run that needs a model fails preflight with a friendly message when the gateway is
unconfigured. Replaying a saved path with grading disabled does not need a model.

## Trajectory Viewer

`playtest view` starts a local read-only server and opens the viewer: a run picker plus,
per run, a film strip of step screenshots with the actor's thoughts and actions, the gate
verdicts, perf/telemetry per step, cross-run trend history, and — for healed runs — a diff
tab showing where the new path diverged from the baseline, with the exact
`playtest baseline accept <runDir>` command to approve it.

Useful entries: `playtest view --changed` (the review queue), `--failed`, `--latest`,
`--case <id>`. The viewer is a zero-dependency static app; it never mutates anything —
accepting/rejecting stays an explicit CLI action.

## Suites and Cases

A **suite** is a directory with a `playtest.yaml` of shared defaults. A **case** is one
YAML file inside it — its `story:` field is the task in plain language, which is why case
files conventionally live in a `stories/` subdir (the terms "case" and "story" get used
interchangeably; the glossary in `docs/playtest-design.md` is the referee).

```
checkout/                          # a suite
├── playtest.yaml                  # shared defaults: app.base_url, models, limits
├── stories/
│   ├── add-to-cart.yaml           # a case: a story + its success criteria
│   └── checkout.yaml
└── results/                       # saved paths, written when a case first records green
    ├── add-to-cart.baseline.json  #   run metadata
    ├── add-to-cart.baseline.jsonl #   the step-by-step path later runs replay
    ├── checkout.baseline.json
    └── checkout.baseline.jsonl
```

The standalone todo suite in `examples/` is a working reference for all of
this, including an example custom persona in `examples/personas/`. Product and
test code do not depend on the examples.

### Configuration

#### Suite

```yaml
# checkout/playtest.yaml
app:
  driver: web                      # web (default, Playwright) · mobile (Appium) · api (HTTP)
  base_url: http://localhost:3000  # where the app runs — required for web/api (or --base-url)
  compose: docker-compose.yml      # optional: harness boots & tears the app down per run
  init: ./seed.sh                  # optional: script run before each case to reset state
mode: journey                      # journey (regression) · discovery (open-ended exploration)
persona: tester                    # tester · exploratory · adversarial · or a personas/*.yaml slug
actor_model: gpt5_4_mini           # role-plays the user (this is the default; any name your gateway accepts)
grader_model: gpt5_5               # scores runs and checks `assert:` gates (default shown)
max_steps: 50                      # per-run limit on actor steps
timeout: 4m                        # per-run wall-clock limit
artifacts: core                    # core (default) · debug — how much each run keeps
```

`artifacts: core` keeps everything anything reads: the accessibility snapshots,
the step screenshots, the video, the HAR, and the trajectory. `artifacts: debug`
additionally keeps the browser forensics — the Playwright trace, MHTML copies of
each page, and the browser's own accessibility tree — which nothing in Playtest
reads back but which help when you are debugging one specific run by hand. They
are also most of what a run costs: on a typical web run the trace alone is about
70% of the bytes on disk and most of the time spent closing the browser. Set it
per case as well as per suite; the run records which profile it used, and the
viewer works the same either way.

#### Secrets (api)

An API suite needs credentials, and a credential must never end up in YAML, in a
prompt, or in a committed baseline. Reference it instead:

```yaml
# checkout-api/playtest.yaml
app:
  driver: api
  base_url: https://staging.example.com
  headers:                          # sent with every request; an action header still wins
    Authorization:
      $secret: LEDGER_TOKEN         # resolved from PLAYTEST_SECRET_LEDGER_TOKEN
    X-Api-Version: "2026-01-01"
redact:                             # fields carrying application data
  request:
    - path: body.owner_email        # commits as a placeholder, resolved again when replayed
      secret: OWNER_EMAIL
  projection:
    - $.balances_by_email           # dropped from the recorded response shape
```

```sh
export PLAYTEST_SECRET_LEDGER_TOKEN="Bearer sk_live_…"   # the whole header value
```

Playtest does not read `.env`. A missing value fails the run with the exact
variable to export. Every value it injects is scrubbed from snapshots, logs, and
`har.json`, and API baselines record request templates and a response *shape*
rather than raw bodies — so a baseline can still be replayed, credentials and
all, from what is committed. Before anything is saved as a baseline, an
acceptance leak scan reports credential-shaped tokens, emails, and undeclared
redaction fields; anything it finds waits for an explicit
`playtest baseline accept <runDir>`.

#### Replay and drift (api)

A recorded API journey is a **program**, not a recording of literal bytes. Where
a request re-uses an id an earlier response invented, Playtest records the edge
instead of the value — `POST /accounts/{{id_1}}/activate`, with the step
recording that `{{id_1}}` is step 1's `$.id`. Replay re-reads that field on the
fresh response, so the same baseline runs against a new instance whose ids are
all different. Inference is conservative on purpose: only server-generated,
identifier-shaped strings that match a whole path segment, query value, header,
or JSON field bind. Anything ambiguous keeps its literal, and if that breaks it
breaks loudly. When an id lives under a key the heuristic does not recognize,
name it: `bind: ["$.data.reference"]`.

Drift comparison sees a *shape* of each response rather than its values, so
fresh ids and timestamps never trigger a heal. `match:` handles what shape alone
cannot:

```yaml
# ledger/playtest.yaml
app:
  driver: api
  base_url: https://staging.example.com
  openapi: ./openapi.yaml           # resolved: parameters, schemas, statuses, links
match:
  exclude: ["$.debug"]              # volatile structure — the key stays, the value goes
  compare: ["$.status"]             # compare this field by value, not just by type
  normalize:
    - path: "$.items"
      rule: length                  # sorted | length
  status_equivalent:
    - [201, 202]                    # declare two statuses interchangeable
```

No rule can hide a real change: a renamed, added, or removed field always moves
the comparison, because every rule keeps its key. Statuses are compared exactly
per step — a 201 that becomes a 202 is drift attributed to the step that changed,
unless `status_equivalent` says otherwise.

`app.openapi` is resolved rather than skimmed: `$ref`s, parameters, request and
response schemas, links, and security schemes. Refs may point inside the document
or at files beside it; a network ref is refused, and any unresolvable ref is a
config error naming the file.

#### Case

Inherits config from the nearest parent `playtest.yaml`.

```yaml
# checkout/stories/add-to-cart.yaml
description: Add item to cart and see it in the basket  # one-line label in run lists
story: |    # the actor's goal in plain language
  You're buying a gift. Pick a product you like, add two of them to your
  cart, check that it shows up in your basket, then remove one and check
  if the price changed
tags: [smoke]                           # optional, for --tag filtering
persona: first-time-shopper             # the actor role; a list here fans out (discovery)
success:                                # journey gate — every criterion must pass
  - url_matches: "/cart*"               # the address bar
  - api_called: "POST /api/cart"        # assert that an api call was made
  - console_errors: 0                   # assert no js console errors
  - assert: the basket shows one item   # natural language, checked by the grader
report:     # natural-language questions answered by the grader
  - Did anything in the checkout flow confuse them?
  - Could the task have been done in fewer steps?
```

##### Success assertions

The `success:` block is the **journey gate**: every criterion must pass for the run to be green.
All are checked deterministically from the recorded run except `assert`, which states a claim in
natural language for the grader agent to judge.

| Key | Example | Drivers | Passes when |
|---|---|---|---|
| `url_matches` | `"/cart*"` | web, api | The final URL (full or pathname) matches the glob. |
| `element_exists` | `"[data-testid=basket-item]"` | web | A Playwright locator matches on the final page — CSS by default, or `xpath=` / `text=` / `role=`. |
| `screen_shows` | `"~basket-item"` | mobile | An Appium native selector matches on the final screen — accessibility id (`~`), XPath, or iOS/Android predicate. The mobile analog of `element_exists`. |
| `api_called` | `"POST /api/cart"` | web, api | Some request matched the `METHOD /path-glob`. |
| `response_status` | `"2xx"` | api | Some response had this status — an exact code or an `Nxx` class. |
| `response_matches` | `"$.items[0].qty == 2"` | api | A dot/bracket JSON path over the last response body compares true (`==`, `!=`). A minimal subset — no wildcards or filters. |
| `console_errors` | `0` | web | The run finished with at most N browser console errors. |
| `invariant` | `{ policy: no_server_error }` | api | A declared API invariant held over the recorded requests — see below. |
| `assert` | `the basket shows one item` | web, mobile, api | The grader judges the claim true against the final page / screen / response. One model call per `assert`, even on replayed runs. |

`response_status` and `response_matches` also take a structured selector, so a
check is about one operation rather than about whichever request happened to be
last:

```yaml
success:
  - response_status:
      op: "POST /accounts/{accountId}/close"   # method + OpenAPI-style path
      status: "204"
      occurrence: all                          # all | any | first | last
  - response_matches:
      op: "GET /accounts/{accountId}"
      match: "$.balance == 90"
```

A selector that matches no request **fails** — a declared expectation has to be
exercised to pass.

Suites can add deterministic success kinds under
`assertions/<name>/assertion.js` for external or domain-specific evidence the
built-ins cannot observe. The complete module and lifecycle contract is under
[custom assertion modules](docs/contracts/engine.md#custom-assertion-modules).

##### API invariants

`invariant:` (api only) declares a *property* rather than a single expectation.
Nine policies ship, in two tiers:

```yaml
success:
  # Tier 1 — driven by app.openapi. Free once a spec is configured.
  - invariant: { policy: no_server_error }      # no 5xx
  - invariant: { policy: documented_status }    # every status is in the spec
  - invariant: { policy: response_schema }      # bodies match the declared schema
  - invariant: { policy: content_type }         # media types match the spec

  # Tier 2 — opt-in metamorphic policies, each declaring where it applies.
  - invariant:
      policy: round_trip                        # client-owned fields survive a write
      create: "POST /accounts"
      read: "GET /accounts/{accountId}"
      fields: ["$.owner"]
  - invariant:
      policy: idempotency                       # a repeat reaches the same state
      op: "POST /entries"
      key_header: "Idempotency-Key"
      ignore: ["$.created_at"]                  # a refreshed timestamp is fine
  - invariant:
      policy: lifecycle                         # what a read answers after a delete
      delete: "DELETE /accounts/{accountId}"
      read: "GET /accounts/{accountId}"
      after: [200]                              # this API soft-deletes…
      state: '$.status == "deleted"'            # …and says so
  - invariant:
      policy: pagination                        # no repeats, cursor terminates
      op: "GET /entries"
      identity: "$.entries[*].id"
      cursor: "$.next_cursor"
      consistency: snapshot                     # or: eventual
  - invariant:
      policy: error_shape                       # 4xx bodies use the envelope
      require: ["$.error.code", "$.error.message"]
      exclude_status: [401, 403, 429]           # the default; auth differs legitimately
```

Three things are worth knowing before you write one.

**They read the recorded trace.** No model is involved, and the gate never issues
a mutating request. A policy that needs a read-back the story did not perform can
declare `observe: true` (with `read_from`, so the request is addressed explicitly
rather than guessed); the gate then issues that one GET. Observation traffic is
quarantined — it can never satisfy `api_called`, become the response another
check inspects, or enter a baseline.

**A policy that was never exercised FAILS.** If the story never repeats the call
an idempotency policy checks, the check is red with a detail saying so. A
declared invariant that never ran has not held. Write the story so it performs
the operations its policies need — or move the policy to `observe:`. What each
Tier-2 policy needs the story to do:

| Policy | The story must… |
|---|---|
| `round_trip` | perform the `create` with a JSON body, then read it back (or set `observe: true`) |
| `idempotency` | send the same call twice — same body, or the same `key_header` value |
| `lifecycle` | complete the `delete`, then read the same resource again |
| `pagination` | walk at least two pages, following the cursor |
| `error_shape` | provoke at least one 4xx outside `exclude_status` |

Say it in the story prose, not just in the YAML: the actor writes the trajectory,
so "post the same entry again with the same idempotency key" is what actually
makes the idempotency policy applicable.

**`observe:` is the advisory sibling of `success:`.** Same shapes, reported on the
run page and in the manifest, never affecting pass/fail. It is where a policy
lives while you tune it.

**They also work on a web journey.** A web run records every request the page
made into `har.json`, and the same policies read it — so a web case can gate on
the API underneath its UI: *the UI looked fine, but did the API underneath
behave?* Set `app.openapi` on the web suite (gate-only there; it never reaches
the actor) and declare the policies exactly as above.

```yaml
app: { driver: web, base_url: "http://localhost:4173", openapi: ./openapi.yaml }
success:
  - element_exists: "[data-testid=todo-item]"   # the user reached the goal
  - invariant: { policy: documented_status }    # …and the API kept its contract
```

A violation names the step whose click produced the offending request, and the
run page links straight to it. Two differences from an api suite: web evaluation
is strictly **passive** (no `observe: true` — a synthetic request would not carry
the page's session), and a web trace holds documents and assets as well as your
API, so use `scope:` when a policy should only see one operation. Everything else
is identical, including that an unexercised policy fails.

`tests/fixtures/api-example/` is a complete worked suite: a committed baseline, a
spec, five gating policies, and one advisory one.
`tests/fixtures/web-invariants/` is its web counterpart: an ordinary browser
journey whose gate holds the API underneath to its spec.

Each finished run carries a **status**:

| Status | Meaning |
|---|---|
| `recorded` | Fresh agentic run; a passing recording is saved as the journey's path. |
| `checked` | Re-executed the saved path step for step — no actor model calls (`assert:` gates still call the grader). |
| `tried to heal` | A checked step failed (UI changed), the agent tried to recover, and the healed run still failed. |
| `changed` | A healed run that passed: the app changed but the journey survived. Awaiting review. |
| `accepted` | A changed journey you approved — now the saved path. |
| `explored` | A finished discovery run: no pass/fail; the trajectory and graded report are the product. |

#### Baselines and Healing

A case's **baseline** — its *saved path* — is the trajectory the actor recorded the first
time the case passed (`results/<case>.baseline.jsonl`). There is no separate script:
later runs replay that path, and the agent re-records it when the UI moves. That's the
`record → act → heal` lifecycle behind the statuses above:

```
first run, or a refresh
       │
       ▼
record ─▶ saves the passing run as the baseline (the "saved path")
       │
       │   every later run re-executes that saved path, step for step:
       ▼
check  ─▶ all steps pass ─────────────▶ status: checked          ✓ green
       │
       │   a step fails — an element is gone, the UI changed
       ▼
heal   ─▶ the agent wakes at the failure point and finishes the task
       │
       ├─ finishes green ─▶ status: changed ─▶ review the heal diff:
       │                      accept → healed run becomes the new baseline
       │                      reject → discarded, baseline unchanged
       │
       └─ still fails ────▶ status: tried to heal                 ✗ broke
```

**API heals are triaged first.** On the api driver, before anything is patched,
the harness classifies the failure from the recorded evidence alone — no model:

| Classification | What it means |
|---|---|
| `regression` | The goal is gone: a 5xx, a refusal the API stopped making, or a resource the journey created that has vanished. **Red, loudly** — there is no valid rebind to accept. |
| `contract drift` | The surface moved (a renamed field, a new required parameter) but the goal is still reachable. The heal rebinds and the run becomes a changed journey for review. |
| `baseline drift` | The environment moved: the journey's own provisioning steps failed against a target that was not clean. |

An API heal becomes a `changed` journey only when **all** of these hold: the
healed run ended with the actor's own `done` (an allowlist — `stuck`, `give_up`,
`max_steps`, and timeout never count as reaching the goal); at least one
applicable hard deterministic check actually evaluated on the healed trajectory
(an empty `success:` list proves nothing and can never accept a heal); triage did
not say `regression`; and the whole deterministic gate passed. Web and mobile
healing is unchanged.

Every API heal also writes `drift-report.json` next to the run and renders it on
the run page: the classification, the signals behind it, the gate verdict on the
healed trajectory, and — when a model is configured — a short narrative of what
changed, why the rebind is valid, and which consumer expectations break. The
narrative is prose for a reviewer. It has no authority over the classification,
the gate, the status, or the exit code.

**Reviewing a changed journey.** An interactive run that heals ends at a review prompt.
Inspect the diff (old baseline vs. healed run) with `playtest view --changed`, then
`playtest baseline accept <runDir>` to promote it or
`playtest baseline reject <runDir>` to discard it.
Non-interactive runs (CI) don't prompt — they print those `accept` / `reject` lines so you
can resume later, and `--fail-on-changed` turns a `changed` result into a failed build.

**CLI note.** The human-facing surface is intentionally small. Agent commands
(`list`, `lint`, `personas`) and the repair command `grade` remain callable but
hidden from top-level help. `run` is the hidden default command. A subcommand name
wins over a path argument; use `playtest ./view` for a colliding path.

## Playtest CLI Commands

| Command | What it does |
|---|---|
| `playtest [paths...]` | Run cases (default `.`). Common options: `--tag`, `--env`, `--base-url`, `--fresh`, `--headed`, `--no-grade`, `--json`, `--junit` |
| `playtest new <name> [dir]` | Create a case (scaffolds `playtest.yaml` on first use). `--driver web\|mobile\|api`, `--force` |
| `playtest new persona <name>` | Create a custom persona in `./personas/` |
| `playtest view [run_or_root]` | Open the GUI: run picker, trajectory playback, changed-journey review. `--latest`, `--changed`, `--failed`, `--case <id>` |
| `playtest clip <run\|case-id>` | Cut a subtitled clip from one run. `--captions action\|thought`, `--burn`, `--out` |
| `playtest baseline accept <runDir>` | Accept one reviewed passing run as the case's saved path |
| `playtest baseline reject <runDir>` | Reject a pending changed path without deleting run artifacts |
| `playtest baseline refresh <paths...>` | Re-record journeys and replace their saved paths |
| `playtest findings consolidate` | Take bug candidates recorded in discovery grades into the local findings ledger and propose groupings (never applied unconfirmed). `--runs-root`, `--apply-plan` |
| `playtest findings list\|show\|accept\|reject\|resolve` | Triage durable, deduplicated bugs across runs. `--candidates`, `--json` |
| `playtest findings export` | Write the portable findings JSON (the ledger database itself never travels). `--out` |
| `playtest export [paths...]` | Render saved paths as standalone Playwright specs (one way). `--out`, `--tag`, `--base-url`, `--env` |
| `playtest install-skill` | Install packaged skills under `.agents/skills/` and link supported clients |

Exit codes:
- `0` pass/explored
- `1` gate failure
- `2` environment/infra error.

## Exporting to Playwright

`playtest export` renders a case's saved path as a standalone
`@playwright/test` spec:

```sh
playtest export tests/checkout            # -> playwright-export/<case-id>.spec.ts
playtest export tests/ --out ./e2e
```

In the hosted UI the same thing is one button: **Export Playwright** on a
story's page, for any web story that has an accepted saved path.

This exists for two reasons: an **escape hatch** (if you stop using Playtest you
keep runnable tests) and an **inspection tool** (see, in a language you already
trust, exactly what a green run executes).

It is deliberately **one way**. Playtest writes the file and never reads it
back — the exported spec is not an execution mode, and it will not heal when
your app changes. The living test is the YAML case plus its accepted baseline;
re-run `export` after the baseline changes and the file is overwritten in place.
The generated header says all of this.

What you get per case: the recorded steps as `page.locator(...)` calls, each
preceded by a comment carrying the step number and the actor's reasoning, then
the case's success criteria as assertions. `url_matches`, `element_exists`,
`api_called`, and `console_errors` become real assertions. An LLM-judged
`assert` cannot — it becomes a visible `UNCHECKED` comment plus a
`playtest-assert` annotation that shows up in the Playwright report, and the
same is true of `accessibility_violations`, `perf.*`, and custom assertions.
Every criterion your case declares reaches the file one way or the other; none
is dropped silently.

Web cases only. Mobile and API cases are skipped with a note, as are cases that
have never recorded a saved path.

## Development

`npm test` is the dependency-free Node-only gate: no browser, external network,
model credentials, database, or Docker. It runs the workspace unit/hermetic
suites and repository gates; control-plane integration remains an explicit tier.
those groups can also be run directly with `npm run test:core`, `test:cli`, `test:viewer`,
or `test:repository`. `npm run typecheck` checks every strict TypeScript project,
and `npm run build:web` runs both package-local Vite builds, then embeds the
completed viewer under the hosted console's `/viewer/` path. `npm run test:browser`
runs the explicit core, viewer, and hosted-console Playwright suites;
install its browser once with `npx playwright install chromium`. `npm run test:all` runs
both tiers. The example app runs with
`PORT=4173 node examples/ledger-api/server.js`. Hosted control plane (not in the published package):
`npm run hosted` starts the API, the static web platform, and one peer runner
polling the claim board, on http://127.0.0.1:4177 — no database service;
metadata is one SQLite file under `PLAYTEST_DATA_DIR` (default `.playtest-data`), and
`npm run hosted:migrate` applies migrations without starting the server. That
launcher, unlike the CLI, sources a gitignored repo-root `.env` so a local server
picks up the model gateway; it also reclaims its port from a stale server and
reports what is configured. Its default
test command runs unit tests;
`npm run test:integration --workspace=@playtest/control-plane`
boots the whole control plane against temporary SQLite data roots. Deterministic
test applications and suites live under `tests/fixtures/`; `examples/` remains
user-facing and independently deletable.
