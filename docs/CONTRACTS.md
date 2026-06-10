# Dummy — module contracts

Authoritative interface spec for the implementation. `docs/dummy-design.md` says *what*
and *why*; this file says *exactly how the modules fit*. If an implementation needs to
deviate, it must say so loudly in its summary so the contract gets updated — silent
drift is the one unforgivable sin here.

Stack: **Node >= 20, ESM JavaScript** (`"type": "module"`), no build step anywhere.
Dependencies available (already installed, do not add more without flagging it):
`playwright`, `yaml`, `ajv`, `commander`. The viewer and the todo app use **zero**
dependencies. Reference code style: plain modern JS, JSDoc typedefs for shared shapes.

Repo layout:

```
package.json                  # bin: dummy -> src/harness/cli.js
docs/dummy-design.md          # the design (read it first)
docs/CONTRACTS.md             # this file
src/
  schemas/step.schema.json    # actor step contract, schema_version 2 (exists)
  schemas/grade.schema.json   # grader output contract (exists)
  harness/
    cli.js                    # commander wiring, shebang #!/usr/bin/env node
    config.js                 # discovery, dummy.yaml inheritance, personas
    trajectory.js             # run dirs, envelopes, manifest, baselines, action track, diff
    browser.js                # Playwright session: snapshot, execute, settle, telemetry, artifacts
    snapshot-injected.js      # the injected DOM script (exports a JS source string)
    gate.js                   # deterministic pass/fail gate
    llm.js                    # OpenAI chat-completions client over fetch
    actor.js                  # actor loop's brain: context assembly, step extraction, validation
    grader.js                 # grader agent + natural-language `assert` checker
    runner.js                 # per-case orchestration: record / act / heal
    env.js                    # managed (compose) / external env, health probe, init scripts
    report.js                 # console reporter + JUnit XML
    view-server.js            # serves viewer + run dir for `dummy view`
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
  dummy.yaml
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
  limits: { max_steps: 30, timeout_ms: 240000 },
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

`dummy.yaml` inheritance: collect `dummy.yaml` files from the repo root (dir containing
`.git`, or the named root if none) down to the case's directory; deep-merge top-down
(nearest file wins per key; `env` merges per-key, `success`/`tags` are NOT inherited —
they are case-only). Relative paths inside any YAML (`compose`, `init`, `storage_state`)
resolve relative to the file that declared them. Durations accept `"5m"`, `"90s"`, `"250ms"`,
or a number (ms). Defaults when nothing specifies them: `actor_model: "claude-haiku-4-5"`,
`grader_model: "claude-sonnet-4-6"`, `max_steps: 30`, `timeout: "4m"`, `runs_per_case: 1`,
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
  result: { ok: true, error: null, settle_ms: 480 },
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
    har_entries: [12, 13, 14]       // indices into har.json log.entries
  },
  tokens: { in: 2100, out: 95, cache_read: 1840 },  // absent on acted steps
  confusion: { type: "action_failed" | "repeated_action" | "no_effect", note: "..." }  // optional
}
```

`done` / `give_up` steps still get an envelope (no resolution, `result.ok: true`,
artifacts from the final state).

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
          dom_quiet_ms: 500, net_quiet_ms: 500, max_ms: 10000 }, gateway: <base_url or "mock"> },
  env: { base_url, managed: false },
  result: {
    status: "pass" | "fail" | "infra",
    end_reason: "done" | "give_up" | "max_steps" | "timeout" | "error",
    gate: { pass: true, checks: [ { kind: "url_matches"|"element_exists"|"api_called"|"assert"|"perf", spec: "<human string>", pass: true, detail: "..." } ] }
  },
  totals: { steps, executed_steps, tokens: {in, out, cache_read}, cost_usd, console_errors, confusion_events },
  healed: false,
  baseline: { run_id: "...", blessed_at: "..." } | null,   // what was acted from
  artifacts: { trajectory: "trajectory.jsonl", har: "har.json", video: "video.webm",
               trace: "trace.zip", grade: "grade.json" | null, baseline_copy: "baseline.jsonl" | null }
}
```

### Baseline files (live next to the case file, committable)

- `<case>.baseline.jsonl` — the blessed trajectory, verbatim copy.
- `<case>.baseline.json` — `{ blessed_at, run_id, run_dir, healed_from_run_id|null, pins }`
- Heal candidates: `<case>.healed.jsonl` + `<case>.healed.json` (same shape + `candidate: true`).
  `dummy bless` promotes candidate → baseline (and removes the candidate files).

---

## 2. config.js

```js
export async function discoverCases(paths, { tags = [], baseUrl = null } = {})
  // paths: array of dirs and/or .yaml case files. Walks dirs for *.yaml (skipping
  // dummy.yaml, *.baseline.*, *.healed.*). Applies dummy.yaml chain + CLI overrides.
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
  stepPaths(n)               // -> { screenshot, mhtml, a11y } absolute paths for step n
  appendEnvelope(envelope)   // sync append one JSONL line
  writeManifest(manifest); writeGrade(grade); copyBaseline(srcJsonlPath)
}
export function readTrajectory(jsonlPath)                   // -> envelope[]
export function actionTrack(envelopes)
  // The actable projection: envelopes where resolution exists && result.ok,
  // excluding done/give_up. Computed, never stored.
export function diffTracks(baselineTrack, newTrack)
  // LCS on signature: action.type + "|" + (resolution.locator ?? action.url ?? "") + "|" + (action.text ?? "")
  // -> { ops: [{ op: "same"|"del"|"add", a: env|null, b: env|null }], summary: { same, del, add } }
export function baselinePaths(caseFile)   // -> { traj, meta, healedTraj, healedMeta }
export function readBaseline(caseFile)    // -> { envelopes, meta } | null
export function blessBaseline(caseFile, runDir, { healed = false } = {})
  // copy runDir/trajectory.jsonl + write meta; healed:true writes the .healed.* candidate instead
export function promoteHealed(caseFile)   // healed candidate -> baseline; throws if none
```

## 4. browser.js (+ snapshot-injected.js)

```js
export class Session {
  static async launch({ baseUrl, runDir, storageState = null, headed = false, settle = SETTLE })
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
  async execute(action, stepNum)        // agent-mode: validate ref exists/visible/enabled first
  async executeLocator(actedStep, stepNum)  // act-mode: drive from envelope.resolution.locator
  // Both -> ExecResult:
  // { ok, error: string|null, resolution: {ref?, locator, bbox}|null,
  //   settle_ms, perf: {input_to_paint_ms, long_tasks_ms, requests, js_errors, nav|null},
  //   har_entries: [int], timed_out: false }
  // Validation failures (unknown ref, hidden, disabled) -> { ok:false, error:"...", resolution:null }
  // and NO browser action happens. Action execution errors are caught -> ok:false. Never throws
  // for per-action problems; throws only for catastrophes (browser died).
  consoleErrors()                       // -> total count so far (for gate console_errors)
  harEntryCount()
  async finalPageCheck(selector)        // element_exists gate support: locator.count() > 0
  async close()                         // stop tracing, finalize video.webm + har.json
}
```

Action execution semantics: `click` → locator.click; `type` → fill, then optional Enter;
`select` → selectOption by label, falling back to value; `scroll` → mouse.wheel ±600px
(or element.scrollBy via evaluate when ref given); `navigate` → goto; `wait` → bounded sleep
(still measured). After every action: **settle** = wait until (no in-flight tracked requests
for `net_quiet_ms`) AND (no DOM mutations for `dom_quiet_ms`), capped at `max_ms`
(cap reached → `timed_out: true`, still ok). MutationObserver + rAF-paint hooks are installed
via an init script on every document.

Durable locator computed at execution time, preference order:
1. `[data-testid="x"]` on the element or a unique ancestor
2. `role=button[name="Add"]` (Playwright role engine, exact name) when role+name is unique
3. `text="exact text"` when unique
4. css path fallback (`#id`, else nth-of-type chain)

Perf window: opens at input dispatch, closes at settle. `input_to_paint_ms` from a
PerformanceObserver paint/rAF hook; `long_tasks_ms` summed from a `longtask` observer;
`requests`/`js_errors` counted within the window; `nav` (LCP, CLS, TTFB) collected on
navigation steps via buffered observers.

HAR entries (har.json, written incrementally, finalized on close):
`{ startedDateTime, time, request: {method, url}, response: {status, bodySize, mimeType}, _failed: bool }`.

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
  // { baseUrl, apiKey, available: bool } from env: DUMMY_LLM_BASE_URL (default
  // "https://api.anthropic.com/v1" — Anthropic's OpenAI-compat endpoint), DUMMY_LLM_API_KEY
  // (fallback ANTHROPIC_API_KEY, then OPENAI_API_KEY). available=false when no key AND no
  // explicit base URL override (mock servers need no key: any DUMMY_LLM_BASE_URL counts as available).
export async function chat({ model, messages, tools = null, toolChoice = null, maxTokens = 1024 })
  // POST {baseUrl}/chat/completions, OpenAI contract. Forced tool call when toolChoice given.
  // -> { text, toolCall: { name, args /* parsed object; JSON parse errors -> throws LlmError */ } | null,
  //      usage: { in, out, cache_read } }   // cache_read from usage.prompt_tokens_details.cached_tokens
  //                                         // or anthropic-style fields if present; else 0.
  // Retries: 2x on 429/5xx/network with backoff. Throws LlmError on terminal failure.
export function estimateCost(model, usage)  // -> USD float; pricing table for haiku-4-5 ($1/$5 per MTok,
                                            // cache read $0.10), sonnet-4-6 ($3/$15, $0.30); unknown -> 0.
export class LlmError extends Error {}
```

## 6. actor.js

```js
export function loadPersona(name, caseFile)
  // built-ins "tester"/"exploratory" from prompts/; otherwise searches personas/*.yaml in the
  // case file's dir, then ancestor dirs up to repo root. -> { name, description }. Throws if not found.
export class Actor {
  constructor(resolvedCase, persona)
  async nextStep({ history, snapshotText, stepNum })
  // history: prior envelopes (this run). Builds messages cache-efficiently:
  //   system: actor-system.md + persona overlay + the story  (stable prefix, never changes mid-run)
  //   then one user message: compact append-only log of prior steps
  //     "step N: <action human-readable> -> ok|error <error> | url now <u>" (+ the agent's thought,
  //     one line each), older steps beyond the last 15 folded to "steps 1-K: <one line each, thoughts dropped>"
  //   then final user message: "Current page snapshot (step N):\n" + snapshotText
  // Calls chat() with the step tool (schema = step.schema.json, name "step", forced via toolChoice).
  // Ajv-validates returned args; on failure retries ONCE with the validation error appended.
  // -> { agentStep: {thought, action, expectation}, tokens: {in, out, cache_read} }
  // Throws LlmError after the retry fails.
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
  // api_called: "METHOD /path/glob" matched against harEntries (method + URL pathname glob).
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
  // compact trajectory digest (per step: action, ok, settle_ms, confusion, thought) + gate result +
  // totals + (if baseline exists) baseline step count. Forced tool call "grade" with
  // grade.schema.json. Ajv-validate, retry once. Writes grade.json (adds {model, graded_at, tokens}).
  // -> grade object.
export async function checkAssertion(claim, { snapshotText, finalUrl, model })
  // Single forced-tool-call yes/no: {pass: bool, detail: string}. Used by the gate for `assert:`.
```

## 9. env.js

```js
export async function prepareEnv(resolvedCase, runId)
  // Managed (env.compose set): `docker compose -f <file> -p dummy-<runId>-<n> up -d --wait`;
  //   resolve base_url: if its hostname matches a compose service, rewrite to
  //   http://localhost:<published port> via `docker compose port`. Teardown: `down -v`.
  // External: base_url used as-is.
  // Then health-probe: GET base_url, ok if status < 500; 5 attempts, 1s apart.
  // Then run init script (if any): cwd = script's dir, env: BASE_URL, RUN_ID, PATH etc.
  // -> { baseUrl, managed, teardown: async () => void }
  // Probe/boot/init failure -> throw InfraError (exit code 2 territory).
export class InfraError extends Error {}
```

## 10. runner.js

```js
export async function runCase(resolvedCase, opts)
  // opts: { mode: "auto"|"agent", runsRoot, runId, grade: bool, headed: bool }
  // auto: baseline exists -> act (heal on failure); else record.
  // RECORD loop: goto base_url -> [captureSnapshot -> actor.nextStep -> execute -> envelope] until
  //   done/give_up/max_steps/timeout. Confusion detection (harness-side, written into envelopes):
  //   action_failed (result not ok); repeated_action (same type+ref/locator 3x consecutively);
  //   no_effect (ok click/type but 0 requests, 0 mutations observed, url unchanged).
  // ACT loop: for each step of actionTrack(baseline): executeLocator -> envelope (mode "act",
  //   acted_from set). On failure -> HEAL: copy context (story + acted-so-far digest), switch to
  //   agentic loop from the failure point (remaining budget = max_steps - steps so far).
  //   If LLM unavailable, the act failure is a gate failure (status fail, end_reason "error").
  // After the loop: evaluateGate (assert wired to grader.checkAssertion with grader_model),
  //   write manifest, close browser, teardown env, then grade (record/heal runs, when opts.grade
  //   and LLM available; never acted runs unless --grade forced), then baseline bookkeeping:
  //   record+pass+(no baseline||rebaseline) -> blessBaseline; heal+pass -> blessBaseline({healed:true}).
  // Timeout enforcement: wall-clock deadline checked each loop turn; also wraps the whole case.
  // -> { status: "pass"|"fail"|"infra", runDir, manifest }
  // Catches InfraError -> status "infra". Never throws.
export async function runAll(resolvedCases, opts)
  // opts += { parallel: int|null, junit: path|null, rebaseline: bool }
  // Serial by default for external envs; managed cases run parallel (min(4, cores)) unless
  // --parallel n overrides. runs_per_case honored (suffix run dirs -2, -3...).
  // Prints per-case lines + summary via report.js; writes JUnit if asked.
  // -> { exitCode: 0|1|2 }  // any infra -> 2 beats 1? NO: 2 only if infra occurred AND no gate
  //                         // failures; gate failure (1) wins over infra (2) when both present.
```

## 11. report.js

```js
export function caseLine(result)          // one-line colored status for the console
export function summary(results)          // counts, duration, cost
export function junitXml(results)         // -> XML string (testsuite per directory, testcase per run)
```

## 12. cli.js (commander)

```
dummy run <paths...>   [--tag <t>...] [--mode auto|agent] [--base-url <url>] [--parallel [n]]
                       [--junit <path>] [--no-grade] [--headed] [--runs-root <dir>=runs]
dummy list <paths...>  [--tag <t>...]            # table: id, tags, persona, baseline? (act/record)
dummy view <dir>       [--port 0] [--no-open]    # dir = run dir, or a runs root (case picker)
dummy diff <runDir>                              # action-track diff vs the case's current baseline
dummy bless <runDir>                             # bless this run's trajectory as its case's baseline
dummy rebaseline <paths...> [--tag...]           # force agent mode + bless on pass
dummy grade <runDir>                             # (re)grade an existing run
```

Exit codes: 0 pass, 1 gate failure, 2 infra. `--base-url` forces external mode (ignores compose).
`dummy diff` and `bless` find the case file via manifest.case.file.

## 13. view-server.js + viewer contract

```js
export async function serveRun(dir, { port = 0, open = true })
```

Serves: `/` → `src/viewer/` static files; `/run/*` → files under the run dir
(when `dir` is a single run). When `dir` is a **runs root**, `/runs.json` lists
`[{run_id, case_id, path, status, mode, started_at}]` (read from manifests) and `/run/<run_id>/<case_id>/*`
serves each run; the viewer shows a picker. Always also serves `/history.json?case=<case_id>` →
`[{run_id, started_at, status, mode, duration_ms, steps, score|null, lcp_ms|null, cost_usd}]`
across sibling runs of the same case (empty array if unknown) — powers the sparkline.
MIME types must cover .json/.jsonl/.png/.webm/.mhtml/.zip/.txt. No directory traversal.

**Viewer** (`src/viewer/` — vanilla JS, no build, must work from any static server that
provides the same URL shape): loads `/run/manifest.json` first (or `/runs.json` → picker).
Surfaces, per the design: film strip of step screenshots with ghost cursor (animate a cursor
dot to each step's `resolution.bbox` center over the screenshot); thought + expectation
captions; screenshot ⇄ a11y-text toggle ("what the agent saw"); confusion/expectation badges
(`envelope.confusion`); per-step network waterfall from `har.json` sliced by
`artifacts.har_entries`; inline telemetry (settle_ms, input_to_paint_ms, js_errors, nav
vitals) + running token/cost strip; gate panel (checks with pass/fail); grade panel
(score, findings) when grade.json exists; heal/act diff view when baseline.jsonl exists
(LCS same as diffTracks, reimplemented standalone); video tab (video.webm, seek to step via
ts - video_started_at); cross-run sparkline from /history.json when non-empty.
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

Example suite (`tests/`): `dummy.yaml` (models, max_steps 25, timeout 3m,
env.base_url http://localhost:4173, init ./seed/reset.sh), three cases under `todos/`:
`add-todo.yaml` (tags [smoke]; story: add "buy milk"; success: element_exists
`[data-testid=todo-item]`, api_called `POST /api/todos`, assert "the list shows a todo
called buy milk"; perf: console_errors 0), `complete-todo.yaml` (add two, complete one,
expect counter "1 item left"), `clear-completed.yaml` (tags [smoke]; add, complete, clear,
expect empty list + api_called DELETE). `tests/seed/reset.sh`: `curl -fsS -X POST
"$BASE_URL/api/reset"` (chmod +x). `docker-compose.test.yml` at repo root builds
`src/todo-app/Dockerfile`, publishes 4173.
