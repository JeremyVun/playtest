# Playtest — module contracts

Authoritative interface spec for the implementation. `docs/playtest-design.md` says *what*
and *why*; this file says *exactly how the modules fit*. If an implementation needs to
deviate, it must say so loudly in its summary so the contract gets updated — silent
drift is the one unforgivable sin here.

Stack: **Node >= 20, ESM JavaScript** (`"type": "module"`), no build step anywhere.
Dependencies available (already installed, do not add more without flagging it):
`playwright`, `yaml`, `ajv`, `commander`. The viewer and the todo app use **zero**
dependencies. Reference code style: plain modern JS, JSDoc typedefs for shared shapes.

Repo layout:

```
package.json                  # name @jeremyvun/playtest, bin: playtest -> src/harness/cli.js
docs/playtest-design.md       # the design (read it first)
docs/CONTRACTS.md             # this file
src/
  schemas/step.schema.json    # actor step contract, schema_version 2 (exists)
  schemas/grade.schema.json   # grader output contract (exists)
  harness/
    cli.js                    # commander wiring, shebang #!/usr/bin/env node
    config.js                 # discovery, playtest.yaml inheritance (dummy.yaml legacy), personas
    new.js                    # `playtest new` scaffolding: suites, cases, personas
    runs-root.js              # shared runs-root discovery, latest-run + history scans
    prompt.js                 # end-of-run interactive changed-journey prompt (injected I/O)
    trajectory.js             # run dirs, envelopes, manifest, baselines, action track, diff
    browser.js                # Playwright session: snapshot, execute, settle, telemetry, artifacts
    snapshot-injected.js      # the injected DOM script (exports a JS source string)
    gate.js                   # deterministic pass/fail gate
    llm.js                    # OpenAI chat-completions client over fetch
    actor.js                  # actor loop's brain: context assembly, step extraction, validation
    grader.js                 # grader agent + natural-language `assert` checker
    runner.js                 # per-case orchestration: record / act / heal, progress events
    env.js                    # managed (compose) / external env, health probe, init scripts
    report.js                 # plain console reporter + mode labels + JUnit XML
    live.js                   # live TTY reporter (status region) for interactive runs
    view-server.js            # serves viewer + run dir for `playtest view`
    prompts/
      actor-system.md         # pinned actor system prompt
      persona-tester.md       # built-in persona
      persona-exploratory.md  # built-in persona
      grader-system.md        # pinned grader prompt
    testing/
      mock-llm.js             # OpenAI-compatible rule-based mock server (self-test fixture)
  viewer/                     # standalone static app: index.html, app.js, style.css
  todo-app/
    server.js                 # zero-dep test subject app
    Dockerfile
tests/                        # example suite targeting the todo app
  playtest.yaml
  todos/*.yaml
  seed/reset.sh
personas/
  curious-newcomer.yaml       # example custom persona
docker-compose.test.yml       # managed-mode demo for the todo app
runs/                         # output, gitignored
```

Harness version constant: `HARNESS_VERSION = "0.1.0"`, snapshot format `"a11y-text-v1"`,
settle heuristic `"settle-v1"`, prompts version `"prompts-v1"`. Exported from `trajectory.js`
as `PINS_BASE` (see Manifest).

---

## 1. Shared data shapes

### ResolvedCase (produced by config.js, consumed everywhere)

```js
{
  id: "todos/add-todo",            // path relative to the *suite root the user named*, no extension
  file: "/abs/path/tests/todos/add-todo.yaml",
  name: "add-todo",
  story: "...",                    // required
  persona: "tester",               // name; resolution happens in actor.js
  tags: ["smoke"],
  success: [                       // array of one-key objects, order preserved
    { url_matches: "/done/*" },
    { element_exists: "[data-testid=x]" },
    { api_called: "POST /api/todos" },
    { assert: "natural language claim about the final page" }
  ],
  perf: { lcp_ms: "< 2500", console_errors: 0 },   // optional; keys: lcp_ms, console_errors, input_to_paint_ms
  limits: { max_steps: 50, timeout_ms: 240000 },
  actor_model: "claude-haiku-4-5",
  grader_model: "claude-sonnet-4-6",
  runs_per_case: 1,
  env: {
    base_url: "http://localhost:4173",   // required (CLI --base-url overrides)
    compose: "/abs/path/docker-compose.test.yml" | null,  // managed mode if set
    init: "/abs/path/seed/reset.sh" | null,
    storage_state: "/abs/path/anon.json" | null
  }
}
```

Suite-defaults inheritance: collect defaults files from the repo root (dir containing
`.git`; when no `.git` ancestor exists, every ancestor directory of the case contributes)
down to the case's directory. The defaults filename is `playtest.yaml`; the deprecated old
name `dummy.yaml` is still read as a fallback — each directory contributes `playtest.yaml`,
else `dummy.yaml`, never both, and the first `dummy.yaml` read prints a once-per-process
stderr note (`note: <relpath> is deprecated; rename it to playtest.yaml`). Deep-merge top-down
(nearest file wins per key; `env` merges per-key, `success`/`tags` are NOT inherited —
they are case-only). Relative paths inside any YAML (`compose`, `init`, `storage_state`)
resolve relative to the file that declared them. Durations accept `"5m"`, `"90s"`, `"250ms"`,
or a number (ms). Defaults when nothing specifies them: `actor_model: "claude-haiku-4-5"`,
`grader_model: "claude-sonnet-4-6"`, `max_steps: 50`, `timeout: "4m"`, `runs_per_case: 1`,
`persona: "tester"`.

### Step envelope (one line of trajectory.jsonl)

```js
{
  step: 7,                          // 1-based
  schema_version: 2,
  ts: 1760000000000,                // epoch ms at action dispatch
  mode: "agent" | "act",            // who decided this step
  agent: {                          // absent on acted steps (they carry `acted_from`)
    thought: "...", action: { type: "click", ref: "e42" }, expectation: "..."
  },
  acted_from: 7,                    // acted steps: the baseline step number this re-executes
  resolution: {                     // absent if validation failed before resolution
    ref: "e42",
    locator: "role=button[name=\"Checkout\"]",   // durable Playwright selector string
    bbox: { x: 612, y: 480, w: 120, h: 36 }      // viewport px at execution time
  },
  result: { ok: true, error: null, settle_ms: 480,
            url: "http://localhost:4173/" },   // page URL after the action settled; null if unknown
  perf: {
    input_to_paint_ms: 120,         // null when unmeasurable
    long_tasks_ms: 90,
    requests: 3,
    js_errors: 0,
    nav: { lcp_ms: 1100, cls: 0.01, ttfb_ms: 80 }   // only on steps that navigated
  },
  artifacts: {                      // paths relative to the run dir
    screenshot: "steps/007.png",
    mhtml: "steps/007.mhtml",
    a11y: "steps/007.a11y.txt",     // the exact snapshot text the agent saw
    har_entries: [12, 13, 14]       // indices into har.json log.entries (kept for compat)
  },
  network: {                        // compact embedded request list — the trajectory is
    requests: [{                    // auditable without har.json (api_called reads this)
      method: "POST",
      url: "http://localhost:4173/api/todos",
      path: "/api/todos",           // pathname only; raw string when the URL won't parse
      status: 201,
      mime_type: "application/json",
      failed: false
    }]
  },
  tokens: { in: 2100, out: 95, cache_read: 1840 },  // absent on acted steps
  confusion: { type: "action_failed" | "repeated_action" | "no_effect", note: "..." }  // optional
}
```

`network.requests` carries exactly those six stable fields by contract — no timings or
sizes (accepting a run copies its trajectory into the committed baseline, and fields that
differ between behaviorally identical runs would fill every baseline diff with jitter);
har.json keeps the rich detail. Known freeze: a request still pending at settle embeds
`status: 0` even if it completes later — har.json shows the real status.
`artifacts.har_entries` is retained for backward compatibility.

`done` / `give_up` steps still get an envelope (no resolution, `result.ok: true`,
artifacts from the final state, `network: { requests: [] }`).

### Run directory

```
runs/<run-id>/<case-id>/          # run-id: UTC "2026-06-10T0300-ab12" (timestamp + 4 hex)
  manifest.json
  trajectory.jsonl
  har.json                        # {"log":{"entries":[HarEntry...]}} — see §4
  video.webm                      # CDP/Playwright screencast of the run
  trace.zip                       # native Playwright trace
  baseline.jsonl                  # copy of the baseline acted from (act/heal runs only)
  grade.json                      # grader output (when graded)
  steps/NNN.{png,mhtml,a11y.txt}  # NNN zero-padded to 3
```

### Manifest (manifest.json — the viewer's entry point)

```js
{
  schema_version: 1,
  run_id, case: { id, file, story, persona, tags, success, perf, limits },
  mode: "record" | "act" | "heal",      // heal = act that escalated
  started_at, finished_at,              // ISO strings
  duration_ms,
  video_started_at,                     // epoch ms; maps envelope ts -> video time
  pins: { harness_version, actor_model, grader_model, prompts_version,
          step_schema_version: 2, snapshot_format, settle: { name: "settle-v1",
          dom_quiet_ms: 500, net_quiet_ms: 500, max_ms: 10000 }, gateway: <llm base URL> },
  env: { base_url, managed: false },
  result: {
    status: "pass" | "fail" | "infra",
    end_reason: "done" | "give_up" | "max_steps" | "timeout" | "error",
    error: "first line of the run error" | null,
    gate: { pass: true, checks: [ { kind: "url_matches"|"element_exists"|"api_called"|"assert"|"perf", spec: "<human string>", pass: true, detail: "..." } ] }
  },
  totals: { steps, executed_steps, tokens: {in, out, cache_read}, cost_usd, console_errors, confusion_events },
  healed: false,
  baseline: { run_id: "...", accepted_at: "..." } | null,   // what was acted from
  artifacts: { trajectory: "trajectory.jsonl", har: "har.json", video: "video.webm",
               trace: "trace.zip", grade: "grade.json" | null, baseline_copy: "baseline.jsonl" | null }
}
```

### Baseline files (live next to the case file, committable)

- `<case>.baseline.jsonl` — the accepted trajectory, verbatim copy.
- `<case>.baseline.json` — `{ accepted_at, run_id, run_dir, healed_from_run_id|null, pins }`
- Heal candidates: `<case>.healed.jsonl` + `<case>.healed.json` (same shape + `candidate: true`)
  — the pending "changed journey" awaiting review. `playtest accept` promotes candidate →
  baseline (removing the candidate files); `playtest reject` removes the candidate files
  without touching the run artifacts.

---

## 2. config.js

```js
export async function discoverCases(paths, { tags = [], baseUrl = null } = {})
  // paths: array of dirs and/or .yaml case files. Walks dirs for *.yaml (skipping
  // playtest.yaml/dummy.yaml, personas/ dirs, *.baseline.*, *.healed.*). Applies the
  // defaults chain + CLI overrides. Defaults files are rejected as direct case arguments.
  // tags: AND-of-ORs not needed — a case matches if it has ANY of the given tags.
  // Returns ResolvedCase[] sorted by id. Throws DummyConfigError (message lists the file) on bad YAML.
export function parseDuration(v)        // "5m"|"90s"|"250ms"|number -> ms
export class DummyConfigError extends Error {}
```

## 3. trajectory.js

```js
export const HARNESS_VERSION, STEP_SCHEMA_VERSION = 2, SNAPSHOT_FORMAT = "a11y-text-v1",
             PROMPTS_VERSION = "prompts-v1", SETTLE = { name:"settle-v1", dom_quiet_ms:500, net_quiet_ms:500, max_ms:10000 };
export function newRunId(now = new Date())                  // "2026-06-10T0300-ab12"
export class RunWriter {
  constructor(runsRoot, runId, caseId)   // creates runs/<runId>/<caseId>/steps/
  get dir()
  appendEnvelope(envelope)   // sync append one JSONL line
  writeManifest(manifest); copyBaseline(srcJsonlPath)
}
export function readTrajectory(jsonlPath)                   // -> envelope[]
export function actionOf(envelope)                          // agent.action ?? action ?? null
export function firstLine(e)                                // first line of an error's message (shared helper)
export function actionTrack(envelopes)
  // The actable projection: envelopes where resolution exists && result.ok,
  // excluding done/give_up. Computed, never stored.
export function diffTracks(baselineTrack, newTrack)
  // LCS on signature: action.type + "|" + (resolution.locator ?? action.url ?? "") + "|" + (action.text ?? "")
  // -> { ops: [{ op: "same"|"del"|"add", a: env|null, b: env|null }], summary: { same, del, add } }
export function baselinePaths(caseFile)   // -> { traj, meta, healedTraj, healedMeta }
export function readBaseline(caseFile)    // -> { envelopes, meta } | null
export function acceptBaseline(caseFile, runDir, { healed = false } = {})
  // copy runDir/trajectory.jsonl + write meta; healed:true writes the .healed.* candidate instead
export function promoteHealed(caseFile)   // healed candidate -> baseline; throws if none
export function rejectHealed(caseFile)    // remove the healed candidate files (run artifacts
                                          // untouched); throws if none
```

## 4. browser.js (+ snapshot-injected.js)

```js
export class Session {
  static async launch({ baseUrl, runDir, storageState = null, headed = false })  // settle-v1 is pinned, not a knob
  // Chromium. Context: viewport 1280x800, recordVideo into runDir (rename to video.webm on close),
  // tracing start (screenshots+snapshots) -> trace.zip on close.
  // Instruments from construction: console messages, pageerror, request/response/requestfailed
  // (builds har.json live, assigning entry indices in order of request start), CDP for MHTML.

  page                                  // the Playwright page
  async goto(urlOrPath)                 // resolves relative to baseUrl; returns ExecResult-like with nav perf
  async captureSnapshot(stepNum)
  // Injects snapshot-injected.js source; assigns data-dummy-ref="eN" attributes (fresh numbering
  // each call); writes steps/NNN.a11y.txt + steps/NNN.png + steps/NNN.mhtml.
  // -> { text, url, title, refCount, truncated }
  async execute(action)                 // agent-mode: validate ref exists/visible/enabled first
  async executeLocator(actedStep)       // act-mode: drive from envelope.resolution.locator
  // Both -> ExecResult:
  // { ok, error: string|null, resolution: {ref?, locator, bbox}|null,
  //   settle_ms, url: string|null /* page URL after settle */,
  //   perf: {input_to_paint_ms, long_tasks_ms, requests, js_errors, nav|null},
  //   har_entries: [int],
  //   network: { requests: [{method, url, path, status, mime_type, failed}] } }
  // network is the compact embedded form of the same HAR window as har_entries
  // (see §1 Step envelope for the field contract); failed executions return
  // network: { requests: [] }. goto() also carries it — the runner feeds the
  // initial load's perf + network into the gate.
  // Validation failures (unknown ref, hidden, disabled) -> { ok:false, error:"...", resolution:null }
  // and NO browser action happens. Action execution errors are caught -> ok:false. Never throws
  // for per-action problems; throws only for catastrophes (browser died).
  consoleErrors()                       // -> total count so far (for gate console_errors)
  async finalPageCheck(selector)        // element_exists gate support: locator.count() > 0
  async close()                         // stop tracing, finalize video.webm + har.json
}
```

Action execution semantics: `click` → locator.click; `type` → fill, then optional Enter;
`select` → selectOption by label, falling back to value; `scroll` → mouse.wheel ±600px
(or element.scrollBy via evaluate when ref given); `navigate` → goto; `wait` → bounded sleep
(still measured). After every action: **settle** = wait until (no in-flight tracked requests
for `net_quiet_ms`) AND (no DOM mutations for `dom_quiet_ms`), capped at `max_ms`
(cap reached → settled anyway, still ok). MutationObserver + rAF-paint hooks are installed
via an init script on every document.

Durable locator computed at execution time, preference order:
1. `[data-testid="x"]` on the element or a unique ancestor
2. `role=button[name="Add"]` (Playwright role engine, exact name) when role+name is unique
3. `text="exact text"` when unique
4. css path fallback (`#id`, else nth-of-type chain)

Perf window: opens at input dispatch, closes at settle. `input_to_paint_ms` from a
PerformanceObserver paint/rAF hook; `long_tasks_ms` summed from a `longtask` observer;
`requests`/`js_errors` counted within the window; `nav` (LCP, CLS, TTFB) collected on
navigation steps via buffered observers. The HAR/network window (`har_entries` +
`network.requests`) is contiguous across steps: it spans from the end of the previous
step's window to this step's settle, so requests landing between steps (agent think
time) attribute to the NEXT step; tail requests after the final step's settle appear
only in har.json. `perf.requests` is narrower than that window: it counts only requests
started at or after action dispatch, so think-time requests never mask the `no_effect`
confusion heuristic or skew perf data.

HAR entries (har.json, written incrementally, finalized on close):
`{ startedDateTime, time, request: {method, url}, response: {status, bodySize, mimeType}, _failed: bool }`.
har.json is the deep-debug artifact (timings, sizes, real status of requests that were
still pending at settle); the envelopes' embedded `network.requests` is the portable,
baseline-stable subset.

`snapshot-injected.js` exports `export const SNAPSHOT_SOURCE = String(raw js)` — a function
body string evaluated in the page. It walks the DOM; includes visible interactive elements
(a, button, input, select, textarea, [role], [onclick], [tabindex]), headings, labels,
significant text (truncated to ~120 chars); skips invisible (display/visibility/zero-box);
assigns refs; emits the text format:

```
Page: <title> — <url>
[e1] heading "Todos" (level 1)
[e2] textbox "What needs doing?" value=""
[e3] button "Add"
[e4] checkbox "buy milk" (unchecked)
[e5] link "Active"
text: "1 item left"
(page continues below the fold — scroll down to see more)
```

Accessible-name algorithm (simplified, in this order): aria-label, aria-labelledby,
`<label for>`/wrapping label, placeholder, alt, title, trimmed innerText (≤80 chars).
Cap snapshot at ~200 elements / ~6000 chars; set `truncated: true` beyond.

## 5. llm.js

```js
export function llmConfig()
  // { baseUrl, apiKey, available: bool } from env: PLAYTEST_LLM_BASE_URL (deprecated fallback
  // DUMMY_LLM_BASE_URL; default "https://api.anthropic.com/v1" — Anthropic's OpenAI-compat
  // endpoint), PLAYTEST_LLM_API_KEY (fallbacks DUMMY_LLM_API_KEY, ANTHROPIC_API_KEY, then
  // OPENAI_API_KEY). available=false when no key AND no explicit base URL override (mock
  // servers need no key: any base-url override counts as available). Error messages name
  // the PLAYTEST_* variables.
export async function chat({ model, messages, tools = null, toolChoice = null, maxTokens = 1024 })
  // POST {baseUrl}/chat/completions, OpenAI contract. Forced tool call when toolChoice given.
  // -> { text, toolCall: { name, args /* parsed object; JSON parse errors -> throws LlmError */ } | null,
  //      usage: { in, out, cache_read } }   // cache_read from usage.prompt_tokens_details.cached_tokens
  //                                         // or anthropic-style fields if present; else 0.
  // Retries: 2x on 429/5xx/network with backoff. Throws LlmError on terminal failure.
export async function forcedToolCall({ model, messages, tool, validate = () => null, maxTokens = 1024, signal = null })
  // chat() with the tool forced; `validate(args)` returns an error string or null. On a wrong/invalid
  // tool call, retries ONCE with the validation error appended as a user message. -> { args, tokens }.
  // Throws LlmError after the retry fails. The actor's step and the grader's grade both go through this.
export function estimateCost(model, usage)  // -> USD float; pricing table for haiku-4-5 ($1/$5 per MTok,
                                            // cache read $0.10), sonnet-4-6 ($3/$15, $0.30); unknown -> 0.
export class LlmError extends Error {}
```

## 6. actor.js

```js
export function loadPersona(name, caseFile)
  // built-ins "tester"/"exploratory" from prompts/; otherwise searches personas/*.yaml in the
  // case file's dir, then ancestor dirs up to repo root, matching the persona's `name` field
  // or its filename slug. -> { name, description }. The not-found error is single-line
  // (runner truncates with firstLine), lists the personas/ dirs actually searched, and
  // suggests `playtest new persona <name>`.
export function listPersonas(fromDirOrCaseFile)
  // built-ins ({ name, file: null }) + every custom persona visible from there ({ name, file }).
  // Powers `playtest personas`.
export function describeAction(action)
  // human one-liner for an action ('type "x" into e2'); shared by the grader digest and the
  // runner's step_start progress events.
export class Actor {
  constructor(resolvedCase, persona)
  async nextStep({ history, snapshotText, stepNum, signal })
  // history: prior envelopes (this run). Builds messages cache-efficiently:
  //   system: actor-system.md + persona overlay + the story under a "## Your task" heading
  //     (stable prefix, never changes mid-run; the marker is load-bearing — mock-llm
  //     extracts the story by it)
  //   then one user message: "Steps so far:" + an append-only verbatim log of prior steps —
  //     "step N: <action human-readable> -> ok|error <error> | url now <u>" plus the agent's
  //     thought, one line each. NO folding or compaction: the log is never rewritten, so the
  //     prefix stays byte-stable between turns for prompt caching; max_steps (default 50)
  //     bounds it to a few thousand tokens, dwarfed by the per-turn snapshot
  //   then final user message: "Current page snapshot (step N):\n" + snapshotText
  // Calls chat() with the step tool (schema = step.schema.json, name "step", forced via toolChoice).
  // Ajv-validates returned args; on failure retries ONCE with the validation error appended.
  // -> { agentStep: {thought, action, expectation}, tokens: {in, out, cache_read} }
  // Throws LlmError after the retry fails. `signal` cancels the in-flight call (hard timeout).
}
```

The actor system prompt (prompts/actor-system.md) must: set the role-play frame ("you are
this user, not a test runner"), explain the snapshot format and refs, list the action
vocabulary and when to use done/give_up (done ONLY when the story's goal is genuinely
achieved as far as the user can see; give_up when stuck after honest attempts), require
expectation to be falsifiable ("the cart badge should show 1"), forbid invented refs.

## 7. gate.js

```js
export async function evaluateGate(resolvedCase, ctx)
  // ctx: { session (live, final page), harEntries, consoleErrorCount, trajectory (envelopes), finalUrl,
  //        checkAssertion: async (claim) => ({pass, detail}) }   // injected by runner; uses grader model
  // Checks, in order: every success criterion, then every perf threshold.
  // url_matches: glob (*, ?) against finalUrl — matches full URL or pathname.
  // element_exists: ctx.session.finalPageCheck(selector).
  // api_called: "METHOD /path/glob". Source of truth is the trajectory's embedded network
  //   data: when ANY trajectory element carries a `network` field, search
  //   trajectory.flatMap(e => e.network?.requests ?? []); otherwise fall back to mapping
  //   ctx.harEntries into the same compact shape (runs/baselines recorded before network
  //   embedding). Match = method case-insensitive AND glob against the request's `path`
  //   (else the pathname of `url`). Detail: pass "N matching request(s), e.g. METHOD url",
  //   fail "no matching request among N request(s)".
  // assert: ctx.checkAssertion(claim) — model-checked; if LLM unavailable -> check fails with
  //         detail "assert requires a model; no LLM configured" (gate fail, not infra).
  // perf.lcp_ms / input_to_paint_ms: "< 2500" style (ops: < <= > >=) against the WORST nav lcp /
  //         action input_to_paint in the trajectory. perf.console_errors: max allowed count (number).
  // -> { pass, checks: [{kind, spec, pass, detail}] }  — never throws; always evaluates ALL checks.
```

## 8. grader.js

```js
export async function gradeRun(runDir, resolvedCase)
  // Reads trajectory + manifest + final step's a11y text. Prompt = grader-system.md + case story +
  // compact trajectory digest (per step: action, ok, settle_ms, url, confusion, thought) + gate result +
  // totals + (if baseline exists) baseline step count. Forced tool call "grade" with
  // grade.schema.json. Ajv-validate, retry once. Writes grade.json (adds {model, graded_at, tokens}).
  // -> grade object.
export async function checkAssertion(claim, { snapshotText, finalUrl, model })
  // Single forced-tool-call yes/no: {pass: bool, detail: string}. Used by the gate for `assert:`.
```

## 9. env.js

```js
export async function prepareEnv(resolvedCase, runId)
  // Managed (env.compose set): `docker compose -f <file> -p playtest-<runId>-<n> up -d --wait`;
  //   resolve base_url: if its hostname matches a compose service, rewrite to
  //   http://localhost:<published port> via `docker compose port`. Teardown: `down -v`.
  // External: base_url used as-is.
  // Then health-probe: GET base_url, ok if status < 500; 5 attempts, 1s apart.
  //   An external-mode probe failure against localhost/127.0.0.1 throws the onboarding hint
  //   ("Could not reach <url>." / "Start the app yourself, or add env.compose to
  //   playtest.yaml so Playtest can manage it."), and when a docker-compose*.yml(/yaml)
  //   sits next to the case file or in cwd, appends "Found <rel>; add to
  //   <defaults rel>:" with the env:/compose: YAML snippet — the named file is the
  //   nearest existing playtest.yaml/dummy.yaml ancestor of the case file (else the
  //   playtest.yaml the user would create in the case file's dir), and the suggested
  //   compose path is relative to that file's dir, because config.js resolves
  //   env.compose against the declaring file. Managed-mode probe failures keep the raw
  //   "health probe failed for <url>: <reason>" — compose is already configured there.
  // Then run init script (if any): cwd = script's dir, env: BASE_URL, RUN_ID, PATH etc.
  // -> { baseUrl, managed, teardown: async () => void }
  // Probe/boot/init failure -> throw InfraError (exit code 2 territory).
export class InfraError extends Error {}
```

## 10. runner.js

```js
export async function runCase(resolvedCase, opts)
  // opts: { mode: "auto"|"agent", runsRoot, runId, grade: bool, headed: bool,
  //         refresh: bool, runIndex: int, onEvent: (event) => void }
  // auto: baseline exists -> act (heal on failure); else record.
  // The persona is resolved up front (loadPersona, before env boot / browser launch) and
  //   passed into the loops: an unknown persona is an infra/config failure (status "infra",
  //   exit 2) with loadPersona's hint as the visible error — deliberately also on act-mode
  //   runs, which would only need the persona to heal: config errors are loud.
  // Progress events ({ type, caseId, runIndex, ...payload }), emission guarded so a throwing
  //   listener never breaks the case: case_start {mode, maxSteps, runDir},
  //   env_ready {base_url, managed}, step_start {step, summary (describeAction)},
  //   step_result {step, ok, error, settleMs, costSoFar}, heal_start {failedStep}, grading,
  //   gate_fail {checks: failed only}, warn {message}, and case_end {status, result} —
  //   emitted on EVERY exit path, infra included.
  // RECORD loop: goto base_url -> [captureSnapshot -> actor.nextStep -> execute -> envelope] until
  //   done/give_up/max_steps/timeout. Confusion detection (harness-side, written into envelopes):
  //   action_failed (result not ok); repeated_action (same type+ref/locator 3x consecutively);
  //   no_effect (ok click/type but 0 requests, 0 mutations observed, url unchanged).
  // ACT loop: for each step of actionTrack(baseline): executeLocator -> envelope (mode "act",
  //   acted_from set). On failure -> HEAL: copy context (story + acted-so-far digest), switch to
  //   agentic loop from the failure point (remaining budget = max_steps - steps so far).
  //   If LLM unavailable, the act failure is a gate failure (status fail, end_reason "error").
  // After the loop: evaluateGate (assert wired to grader.checkAssertion with grader_model —
  //   assert criteria call the model even on acted runs; the gate ctx trajectory is prefixed
  //   with a synthetic initial-load element { perf, network } from the first goto so
  //   perf.lcp_ms and api_called see the first page load), write manifest, close browser,
  //   teardown env, then grade (record/heal runs, when opts.grade and LLM available; never
  //   acted runs unless --grade forced; the grade's score rides on the returned result),
  //   then baseline bookkeeping:
  //   record+pass+(no baseline||refresh) -> acceptBaseline, and refresh also removes any
  //   stale <case>.healed.* candidate (it diffed against the baseline this accept replaced);
  //   heal+pass -> acceptBaseline({healed:true}) (the pending changed-journey candidate).
  // Timeout enforcement: wall-clock deadline checked each loop turn; also wraps the whole case.
  // -> { status: "pass"|"fail"|"infra", runDir, manifest, score: number|null, error? }
  //    score = the grade's score when this run graded, else null (always null on infra).
  // Catches InfraError -> status "infra". Never throws.
export async function runAll(resolvedCases, opts)
  // opts += { parallel: int|null, junit: path|null, refresh: bool,
  //           reporter: { onEvent(event), done(results) } }
  // Serial by default for external envs; managed cases run parallel (min(4, cores)) unless
  // --parallel n overrides. runs_per_case honored (suffix run dirs -2, -3...).
  // Never prints: all console output flows through opts.reporter (default no-op, every call
  // guarded) — the CLI picks plain lines (report.js), the live TTY region (live.js), or
  // silence (--json). reporter.done(results) replaces the summary print. Writes JUnit if asked.
  // -> { exitCode: 0|1|2, results }
  //                         // any infra -> 2 beats 1? NO: 2 only if infra occurred AND no gate
  //                         // failures; gate failure (1) wins over infra (2) when both present.
```

## 11. report.js (+ live.js)

```js
export function modeLabel(mode, { healed, status })
  // internal mode -> display word: record "recording", act "checking", heal "healing";
  // healed + status "pass" -> "changed". Internal identifiers never change; the viewer
  // keeps an inline copy of this map (no bundler).
export function caseLine(result, trend = null)
  // one-line colored status for the console (status label, case id, display mode, steps,
  // duration, score, cost; indented gate failures / infra reason). `trend`
  // ({ duration_delta_ms, score_delta, status_streak } | null) is the case's movement vs
  // prior runs (computed in cli.js from a pre-run runs-root scan): a signed duration delta
  // ("3.2s (-189ms)"), "score N (±M vs last graded run)" on graded runs, and a streak bit
  // ("first fail after 2 passes"). Zero deltas are suppressed.
export function summary(results)          // counts, duration, cost
export function junitXml(results)         // -> XML string (testsuite per directory, testcase per run)
```

`live.js` exports `class LiveReporter` (zero-dep), the TTY renderer with the same
`{ onEvent, done }` reporter shape: one updating line per active case (spinner, RUN,
case id, display mode, step k/max, action summary, elapsed, cost when > 0), redrawn at
~100ms; permanent lines — `caseLine` on case_end in completion order, "healing <case>
from step N" on heal_start, per-check lines on gate_fail, warn messages to stderr —
print above the live region, so scrollback reads exactly like the plain reporter.
`done()` erases the region and prints `summary`. Used only when stdout is a TTY and
none of `--plain`/`--no-tui`/`--ci`/`--json` apply.

## 12. cli.js (commander)

The bin is `playtest`. `run` is the (hidden) default command, so `playtest [paths...]`
runs cases with paths defaulting to `.`. Exact subcommand names win over path arguments —
`playtest view` is always the view command even when a `./view` directory exists; run a
conflicting path as `playtest ./view` or `playtest run view`.

The command grid (`run` is hidden from help; its flags apply to the bare default form too):

```
playtest [paths...]                  # = playtest run [paths...]
playtest run [paths...]    [--tag <t>...] [--mode auto|agent] [--base-url <url>]
                           [--parallel [n]] [--junit <path>] [--no-grade] [--headed]
                           [--runs-root <dir>=runs] [--yes] [--ci] [--plain|--no-tui]
                           [--json] [--fail-on-changed]
playtest new suite <name> [dir]       [--compose <file>] [--force]
playtest new case <name> [suite_dir]  [--suite <dir>] [--force]
playtest new persona <name>           [--force]
playtest view [run_or_root]  [--runs-root <dir>] [--latest] [--changed] [--failed]
                             [--case <id>] [--json] [--port 0] [--no-open]
playtest refresh <paths...>  [--tag <t>...] [--base-url <url>] [--parallel [n]] [--headed]
                             [--runs-root <dir>=runs] [--ci] [--plain|--no-tui]
playtest list [paths...]     [--tag <t>...] [--json]   # table: id, tags, persona, next-run
playtest personas                                      # built-in + custom personas
```

Hidden but stable commands: `run` (the explicit default-command spelling),
`accept <runDir>`, `reject <runDir>`, and `grade <runDir>`. The top-level help
epilogue teaches the six-line workflow and names the hidden commands.

Behavior contracts:

- Exit codes: 0 pass, 1 gate failure, 2 infra/config. `die()` prints `playtest: <msg>`
  and exits 2. `--base-url` forces external mode (ignores compose).
- Empty discovery: run prints exactly `No Playtest suites found. Create one with:
  playtest new suite <name>` on stderr and exits 2; `list` prints the same hint and exits
  0 (under `list --json`, stdout stays `[]` and the hint goes to stderr). When `--tag`
  filters were given, the onboarding hint would mislead — the message is instead
  `playtest: no cases matched --tag <tags>` (run: stderr, exit 2; list: exit 0, stderr
  under `--json`).
- run header: `run <id> — N case(s) → <runsRoot>/<id>`, plus
  `Environment: external <base_url>` / `Environment: managed compose <relpath>` when every
  selected case resolves to an identical env (nothing on mixed selections). Suppressed
  under `--json`. Reporter selection: LiveReporter when stdout is a TTY and none of
  `--plain`/`--no-tui`/`--ci`/`--json` apply; otherwise the plain reporter; `--json`
  silences everything except warn events (stderr).
- Trend context: the runs root is scanned once (runs-root.js `scanHistory`) before runAll;
  each finished case is compared against the most recent prior run of the same case id by
  manifest `started_at` (non-infra preferred, same-run_id siblings excluded). Score deltas
  compare only graded-to-graded; the streak counts over non-infra priors and prints only
  on a status change. Infra results and first-ever runs get no trend.
- After the run: a next-actions block (`View results: playtest view`; `Review changes:
  playtest view --changed` only when a passing healed run is among the results; `Open
  failed runs: playtest view --failed` only on failures; `CI artifacts: <runsRoot>/<runId>`).
  Then, when the run left pending changed journeys (passing healed results whose
  `<case>.healed.*` candidate still points at this run): interactive sessions
  (stdin+stdout TTY, no `--yes`/`--ci`/`--json`) prompt via prompt.js —
  `N changed journey(s) passed and need review.`, `Open review? [Y/n]` (default yes:
  serve the viewer on the runs root with `?filter=changed` and keep serving),
  else `Accept all? [y/N]` (default no: run the accept logic per pending run; an
  individual failure prints an error but never changes the run's exit code). In all cases
  with pending journeys — including non-TTY/CI, but NOT under `--json` (no resume lines;
  stdout stays a single JSON object) — the run ends with
  `Review later with:  playtest view --changed` and one
  `Accept later with:  playtest accept <runDir>` line per pending run. Run-dir arguments
  in every printed accept/reject command (CLI and viewer alike) are shell-quoted when
  they contain characters outside `[A-Za-z0-9@%+=:,./_-]` (single quotes, `'\''` escaping).
- `--fail-on-changed`: pending changed journeys promote the exit code to 1 (never
  downgrades a 2), listing the journeys and their accept commands (stderr under `--json`).
- `--json` (run): exactly one JSON object on stdout:
  `{ run_id, runs_root (absolute), exit_code, cases: [{ id, status, mode (internal
  record|act|heal), healed, changed (pending candidate from this run), run_dir,
  duration_ms, steps, cost_usd, score|null, duration_delta_ms|null, score_delta|null,
  status_streak|null, gate_failures: [{spec, detail}] }] }`.
- view: root resolution via runs-root.js `findRunsRoot` — explicit positional or
  `--runs-root` (validated, never walked) > `./runs` > nearest ancestor containing
  `runs/` (walk bounded by the `.git` root or 10 levels) > die with example commands.
  `--latest` opens the newest run by manifest `started_at` (never directory-name order;
  `--case <id>` narrows it; dies when nothing matches). `--changed`/`--failed` are
  mutually exclusive and reject `--latest`; picker filters become viewer query params
  (`?filter=changed|failed`, `&case=<id>`). `view --json`: no server — prints one JSON
  array on stdout and exits 0, reusing the view-server scanners so entries match
  `/runs.json` (default; `--failed` keeps status fail/infra, `--case` filters with picker
  semantics incl. `-N` repeat suffixes, `--latest` narrows to the single newest entry) or
  `/changed.json` (`--changed`). `--port`/`--no-open` are ignored under `--json`.
- list: NEXT-RUN column prints the user words `checking` (baseline exists) / `recording`.
  `playtest list personas` routes to the personas listing when a `./personas` dir exists.
  `--json` -> array of `{ id, tags, persona, next_run }`.
- new (new.js): names are slugified to `[a-z0-9._-]` (lowercase; whitespace and any
  other character run becomes `-`, leading/trailing `-` trimmed; an empty result dies
  with a clear message); path separators rejected first; existing files refuse without
  `--force`; all output paths are cwd-relative (`Created:` / `Next:` lines). Suite
  template: `name:` + `env.base_url http://localhost:3000`; with `--compose <file>`:
  `env.base_url http://app:3000` + `compose: <path rebased relative to the suite dir>`
  (config.js resolves env.compose against the declaring file's dir, so the cwd-relative
  flag value is rebased; a stderr warning prints when the resolved file does not exist,
  creation still succeeds). Case template: tags / story / success-assert /
  perf console_errors 0. Persona template: name + description placeholder in
  `./personas/`. Suite resolution for `new case`: `--suite`/positional (must contain a
  defaults file, else `<dir> is not a Playtest suite. Expected <dir>/playtest.yaml.`) >
  nearest ancestor suite from cwd > exactly one suite below cwd (multiple -> die listing
  relative paths, require `--suite`; zero -> suggest `playtest new suite <name>`).
- accept (acceptance safety — deliberately no `--force`, checked in order): manifest.json
  exists -> trajectory.jsonl exists -> `result.status === "pass"` (refusal names status and
  end_reason) -> `manifest.case.file` is a string that still exists on disk. When this run
  produced the pending candidate — matched by the candidate meta's `run_dir` resolving to
  the named run directory, falling back to run_id equality only for old metas lacking
  `run_dir` (run_id alone cannot tell runs_per_case siblings apart): `promoteHealed`.
  When a pending candidate from a DIFFERENT run dir exists: print a supersede note naming
  its run_dir, then `acceptBaseline` directly and remove the candidate files. accept
  deliberately has no `--latest`: it rewrites a versioned baseline, so it always names
  the exact run directory.
- reject: the pending candidate must match the named run directory (same dir-aware match
  as accept; else die naming the actual pending run's run_dir); `rejectHealed` removes
  only the candidate files — run artifacts kept.
- grade: needs a model (error mentions PLAYTEST_LLM_BASE_URL); re-grades the run dir and
  updates its manifest's `artifacts.grade`.

`accept`, `reject`, and `grade` find the case file via `manifest.case.file`. The standalone
`diff` command was removed — the viewer's action-track diff stage is the replacement.

## 13. view-server.js + viewer contract

```js
export async function serveRun(dir, { port = 0, open = true, query = "" } = {})
  // query (e.g. "?filter=changed") is appended to the URL printed and opened;
  // the viewer reads it. Startup line: "Playtest viewer: <url>".
export function findManifests(root, maxDepth = 6)
  // every run dir (contains manifest.json) under root — the one manifest walk,
  // shared with runs-root.js (scanHistory / latestRun).
export function listRuns(root)        // the /runs.json entries (also `view --json`)
export function changed(root, singleRun)  // the /changed.json entries (also `view --json --changed`)
```

GET/HEAD only (anything else → 405); strictly read-only — the viewer never writes
baselines. Serves: `/` → `src/viewer/` static files; `/run/*` → files under the run dir
(when `dir` is a single run). When `dir` is a **runs root**, `/runs.json` lists
`[{run_id, case_id, path, status, mode, healed, started_at, duration_ms}]` (read from
manifests, newest first) and `/run/<run_id>/<case_id>/*` serves each run; the viewer shows
a picker. `/changed.json` → healed passes across the runs root, newest first:
`[{case_id, run_id, started_at, score|null, path (root-relative), run_dir_rel
(cwd-relative, for copy-paste accept/reject commands), pending}]`, where `pending` means
the `<case>.healed.*` candidate files still exist AND the candidate meta's `run_dir`
resolves to that run's directory (run_id equality is only the fallback for old metas
lacking `run_dir` — runs_per_case siblings share run_id, so at most ONE sibling is
pending); in single-run mode the runs root is resolved from the run's run_id ancestor. Always also serves
`/history.json?case=<case_id>` → `[{run_id, started_at, status, mode, healed, duration_ms,
steps, score|null, lcp_ms|null, cost_usd, path}]` across sibling runs of the same case,
oldest first (empty array if unknown) — powers the sparkline and movement chips (`path`
only resolves when serving a runs root). MIME types must cover
.json/.jsonl/.png/.webm/.mhtml/.zip/.txt. No directory traversal.

**Viewer** (`src/viewer/` — vanilla JS, no build, must work from any static server that
provides the same URL shape): loads `/run/manifest.json` first (or `/runs.json` → picker).
Query params (set by `playtest view` flags): `?run=<path>` opens one run from a runs root;
`?filter=failed` filters the picker to fail/infra; `?case=<id>` filters the picker (also
matching `-N` repeat-run suffixes); `?filter=changed` renders the read-only changed-journey
review list (status, case, run, started, score) — pending rows show the exact
`playtest accept <runDir>` / `playtest reject <runDir>` commands (run dirs shell-quoted
when needed, like the CLI's printed commands), already-resolved healed passes are listed
dimmed without commands. Run modes display through an inline copy of
report.js `modeLabel` (recording/checking/healing/changed).
Surfaces, per the design: film strip of step screenshots with ghost cursor (animate a cursor
dot to each step's `resolution.bbox` center over the screenshot); thought + expectation
captions; screenshot ⇄ a11y-text toggle ("what the agent saw"); confusion/expectation badges
(`envelope.confusion`); per-step network panel — the `har.json` waterfall sliced by
`artifacts.har_entries` when har.json resolves, degrading to a compact list rendered from
the envelope's embedded `network.requests` (method, status with failed/pending markers,
path, mime type) so trajectory.jsonl alone still yields a useful panel; inline telemetry
(settle_ms, input_to_paint_ms, js_errors, nav vitals) + running token/cost strip; gate
panel (checks with pass/fail); grade panel (score, findings) when grade.json exists;
heal/act diff view when baseline.jsonl exists (LCS same as diffTracks, reimplemented
standalone) — its divergence panel shows the exact `playtest accept <runDir>` command for
a pending healed pass (this run's `/changed.json` entry, selected by root-relative path
matching `?run=` in root mode, by run_id+case_id in single-run mode, and only when that
entry is `pending`); a non-pending healed pass instead gets a note that it was superseded
or already resolved, with no command; video tab (video.webm, seek to step via ts -
video_started_at);
cross-run sparkline from /history.json when non-empty (graded-score series when 2+ graded
runs exist, else duration; dots link to `?run=<path>` when serving a runs root) plus
header movement chips — deltas vs the previous comparable run and vs the median of the
last 5 comparable runs (duration, steps; LCP/score only when both sides have them),
`pass → fail` / `pass → healed` status chips, and a regression/improved badge (product
thresholds: pass->fail, score ±5, duration ±30%; regression wins).
Keyboard: ←/→ steps, v toggles a11y view. Everything must degrade gracefully when an
artifact is missing (acted runs have no tokens; ungraded runs no grade.json).

## 14. testing/mock-llm.js (self-test fixture)

OpenAI-compatible server: `POST /chat/completions` (also at `/v1/chat/completions`).
`node src/harness/testing/mock-llm.js [--port 4175]`. No key required. Behavior:

- If the request forces tool `step`: parse the LAST user message's snapshot text. Rule-based
  actor sufficient to complete the example todo cases: extract quoted strings from the story
  (system message); if a textbox's value lacks the next pending quoted todo → `type` it
  (submit: false); then click the add button; story says "complete"/"mark ... done" → click the
  matching checkbox; "delete"/"remove" → click the matching delete button; "filter"/"Active"/
  "Completed" → click that link/button; when all story directives are satisfied (verified
  against the snapshot, e.g. todo text visible) → `done`. After 20 steps → `give_up`. Returns
  a proper tool_call with JSON args + plausible usage numbers.
- If it forces tool `grade`: return a deterministic grade (score 90, completion full, one
  info finding) matching grade.schema.json.
- If it forces an assertion-check tool: naive textual containment of quoted words from the
  claim against the snapshot text in the prompt → pass/fail. (grader.checkAssertion's tool is
  named "verdict" with {pass, detail} — keep that name.)

This file is also the contract test: if the real prompts drift from what the mock expects
(snapshot format, message layout), the offline e2e breaks — by design.

## 15. todo-app (the test subject)

Zero-dep Node http server, `PORT` env (default 4173). In-memory store. Endpoints:
`GET /` (the app, single accessible HTML page with inline CSS/JS),
`GET /api/todos`, `POST /api/todos {title}`, `PATCH /api/todos/:id {completed}`,
`DELETE /api/todos/:id`, `DELETE /api/todos?completed=true` (clear completed),
`POST /api/reset` (empty the store — used by tests/seed/reset.sh).
UI requirements: real `<label>` for the new-todo input; `data-testid` on: `todo-input`,
`add-button`, `todo-list`, `todo-item`, `todo-count`, `clear-completed`; checkbox per item
with accessible name = the todo title; delete button per item named "Delete <title>";
filter links All/Active/Completed; live counter "N items left" (aria-live). Must work
without errors in console. Keep it genuinely simple — it's a fixture, not a product.

Example suite (`tests/`): `playtest.yaml` (models, max_steps 25, timeout 3m,
env.base_url http://localhost:4173, init ./seed/reset.sh), three cases under `todos/`:
`add-todo.yaml` (tags [smoke]; story: add "buy milk"; success: element_exists
`[data-testid=todo-item]`, api_called `POST /api/todos`, assert "the list shows a todo
called buy milk"; perf: console_errors 0), `complete-todo.yaml` (add two, complete one,
expect counter "1 item left"), `clear-completed.yaml` (tags [smoke]; add, complete, clear,
expect empty list + api_called DELETE). `tests/seed/reset.sh`: `curl -fsS -X POST
"$BASE_URL/api/reset"` (chmod +x). `docker-compose.test.yml` at repo root builds
`src/todo-app/Dockerfile`, publishes 4173.
