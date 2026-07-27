# Engine contracts

This file is authoritative for suite resolution, drivers, actor and grader
model calls, run state transitions, gates, hooks, and concurrency. Persisted
formats are defined in [Artifact contracts](artifacts.md); supported imports
and user-facing commands are defined in
[Interface contracts](interfaces.md).

## Resolved cases

`discoverCases()` produces normalized cases consumed by the runner:

```js
{
  id: "todos/add-todo",
  file: "/abs/path/examples/todos/stories/add-todo.yaml",
  name: "add-todo",
  story: "...",
  description: "..." | null,
  mode: "journey" | "discovery",
  persona: "tester",
  tags: ["smoke"],
  success: [
    { url_matches: "/done/*" },
    { element_exists: "[data-testid=x]" },
    { api_called: "POST /api/todos" },
    { console_errors: 0 },
    { accessibility_violations: 0 },
    { assert: "the final page confirms the purchase" },
    { invariant: { policy: "no_server_error" } }
  ],
  // advisory invariant policies; always an array, empty when none are declared
  observe: [{ invariant: { policy: "error_shape", require: ["$.error.code"] } }],
  perf: { lcp_ms: "< 2500" },
  report: ["Where did the user look first?"],
  redact: { request: [{ path, secret }], projection: ["$.a"] } | null,
  // match rule lists appear only when declared; null when nothing is
  match: { exclude, compare, normalize, status_equivalent } | null,
  bind: ["$.data.reference"] | null,
  vision: false,
  visual_regression: true,
  visual_regression_drift: 10,
  parallel: null,
  limits: { max_steps: 50, timeout_ms: 240000 },
  actor_model: "gpt5_4_mini",
  grader_model: "gpt5_5",
  env: {
    driver: "web" | "mobile" | "api",
    env_name: "stg" | null,
    base_url: "http://localhost:4173" | null,
    compose: "/abs/path/docker-compose.yml" | null,
    init: "/abs/path/seed/reset.sh" | null,

    // web
    storage_state: "/abs/path/member.json" | null,
    auth: "member" | "none" | null,
    auth_unresolved: true | undefined,
    settle: {} | null,
    viewport: { width: 1280, height: 720 | null } | null,
    device_scale_factor: 2 | null,
    cookies: { bvt: "true" } | null,

    // mobile
    platform: "ios" | null,
    app: "/abs/path/MyApp.app" | null,
    device: "iPhone 15" | null,
    appium_url: "http://..." | null,
    preserve_session: true | null,

    // API
    openapi: "/abs/path/openapi.yaml" | null,
    allowed_origins: ["https://api.example"] | null
  }
}
```

The final `persona` is always scalar. Discovery cases with a persona list fan
out to one case per persona with ID `<id>@<persona>`. Journey cases use the
first persona and warn about ignored entries.

Defaults with no authored override are:

```yaml
mode: journey
persona: tester
actor_model: gpt5_4_mini
grader_model: gpt5_5
limits:
  max_steps: 50
  timeout: 4m
visual_regression: true
visual_regression_drift: 10
```

`vision` defaults to true for discovery and false for journey. A journey cannot
enable vision because measured runs must never send screenshots to a model.
The shown limits are journey defaults; discovery defaults to 300 steps and 30
minutes. Explicit case or suite values win.

## Discovery and configuration

```js
discoverCases(paths, {
  tags = [],
  ids = [],
  baseUrl = null,
  env = null
})
```

Directory discovery treats directories containing `playtest.yaml` as suite
roots and finds cases in their `stories/` subtrees. It continues through other
subdirectories only to find nested suites or `stories/`; loose case-shaped YAML
is warned about rather than run. A directly named YAML file is always treated
as a case except `playtest.yaml`, which is rejected as a direct case argument.
Discovery skips `personas/`, `results/`, baseline files, and healed candidates.
Returned cases are sorted by ID.

Case IDs are relative to the suite root named by the user, omit the extension,
and remove only the leftmost structural `stories/` segment.

### Defaults and overlays

Collect `playtest.yaml` files from the repository root down to the case
directory. Without a `.git` ancestor, every ancestor may contribute. Deep
merge from farthest to nearest; the case is last. `app` merges per key.

`success`, `tags`, `report`, `story`, and `description` are case-only. A persona
list is case-only; a scalar persona may be a default. Declaring a case-only key
in defaults is a configuration error.

Every YAML document is validated at load against `case.schema.json` or
`defaults.schema.json`. Unknown keys, missing required fields, invalid enums,
duplicate/minimum violations, and malformed YAML are `DummyConfigError`s that
name the file and actionable field. A bare key parsed as `null` is treated as
absent. A top-level `env` key is rejected with the migration to `app`.

Relative paths resolve against the YAML file that declared them. This applies
to `app.compose`, `app.init`, `app.storage_state`, each `app.auth_states` value,
`app.app`, and `app.openapi`, and to the path-bearing keys of an environment
overlay (`init`, `storage_state`, `app`, `auth_states`). Durations accept a
millisecond number or strings using `ms`, `s`, or `m`.

`app.envs.<name>` is a named partial overlay containing only environment keys:
`base_url`, cookies, storage state, init, auth/auth states, and the mobile
device target (`platform`, `app`, `device`, `appium_url`). It
shallow-overrides the merged top-level `app` after the defaults chain. The
mobile device target is per-environment because the app binary, the device and
the Appium endpoint all belong to the machine the device is attached to — a
suite stays portable while each environment names its own build. The overlay
cannot contain driver selection, compose, API configuration, or a nested
`envs`. Naming an unknown environment reports the available names.
`--base-url` wins over the selected environment and forces external mode.

### Web identity

`app.auth` declares an abstract identity label or `"none"`.
`app.auth_states` maps labels to storage-state paths and is normally supplied
by the selected environment. Resolution happens after defaults, case, and
environment overlays:

- A mapped label replaces inherited `storage_state`.
- `"none"` clears inherited storage state.
- A missing label in a declared map is a configuration error listing available
  labels.
- If no map is declared, discovery and validation defer the error by setting
  `auth_unresolved: true`; environment preparation refuses to run and names
  the required `--env`.

`auth_states` is a resolution input and never appears in the final case or
manifest. The label may appear as informational `env.auth`. Both keys are
web-only.

### Secrets and redaction

A secret reference is the object `{ $secret: "NAME" }`. `NAME` is an identifier
(`[A-Za-z_][A-Za-z0-9_]*`) because it also names an environment variable. A
reference substitutes a whole value, never part of one, so the secret is the
complete header value — typically `Bearer <token>`.

References are accepted wherever a literal is, in:

- `app.headers` (API only): a map of header name to a literal string or a
  reference, sent with every request and merged **under** the actor's own action
  headers, case-insensitively, so an explicit per-request header still wins.
- `redact.request[].secret`: the name a redaction-listed request field is
  resolved from at act time.

Resolution is provider-based with explicit precedence:

1. an explicitly registered provider (`setSecretProvider`), the seam a host uses
   to supply values from its own secret store, then
2. the process environment variable `PLAYTEST_SECRET_<NAME>`.

A provider that returns nothing for a name falls through to the environment.
Nothing reads a `.env` file. A missing or empty value is a `DummyConfigError`
naming the secret and the exact variable to set — never an empty string, never a
silent skip. `app.headers` resolves at driver launch, so a missing credential
stops the run before the actor spends a token, and the resolved value never
reaches the resolved case or the manifest. Hosted runs resolve the same way: the
runner-agent's environment overlay writes `PLAYTEST_SECRET_<NAME>` for the run,
or a host embedding core registers a provider.

Every resolved value is recorded in a known-secret registry, and everything the
harness persists or shows is scrubbed of it: API snapshots (so the actor never
sees a credential either), step snapshot files, `har.json` at write time, and —
as a backstop — the acceptance leak scan. The placeholder is `[secret:NAME]`.
A value of the form `<auth-scheme> <credential>` also registers its credential
half, because a server echoing the token back echoes it without the scheme.
Values shorter than four characters are not scrubbed from free text: the needle
would match unrelated content.

`redact` is an inheritable case/defaults key declaring which fields carry
application-sensitive data:

```yaml
redact:
  request:
    - path: body.owner_email     # headers.<Name> | body[.field][*]
      secret: OWNER_EMAIL
  projection:
    - $.balances_by_email
```

A request entry commits to the baseline as its `{ $secret: … }` placeholder and
is resolved again at act time, so acting still works from the committed form;
`secret` is therefore required — a request template with no value source could
never be acted. A projection entry is omitted or shape-normalized and is
**never** resolved: a projection is an observation. Paths accept `$.a.b`, `a.b`,
and `a[*].b`; a path a request or response does not carry is inert. A string
request body is opaque to field paths — only a whole-`body` entry applies.

### Cross-field validation

A discovery case cannot declare `success`. Driver-specific fields, success
kinds, and performance keys are validated according to the driver matrix.
`base_url` is required for web and API. Mobile requires `app.app`.

`visual_regression` and its drift threshold are accepted for every case but
are inert when the driver produces no screenshot hash. `parallel` is resolved
on each case from its defaults chain. Without a CLI override, the first
non-null value in case-ID order becomes the run-wide setting.

## Driver contract

`createDriver(resolvedCase, env, { runDir, headed })` selects the driver from
`resolvedCase.env.driver`, defaulting to `web`. Mobile and API are dynamically
imported so web runs do not load their module graphs.

Every driver implements:

```js
{
  readonly id
  readonly settle
  readonly overlay
  readonly snapshotFormat
  readonly viewport?

  start()
  captureSnapshot(stepNum)
  execute(action, ctx?)
  executeLocator(actedStep, ctx?)
  finalPageCheck(query)
  location()
  effectToken()
  consoleErrors()
  consoleErrorLog?()
  captureAxe?()
  normalizeSnapshot(text, base?)
  snapshotProjection?(text)
  redactAction?(action)
  parameterizeAction?(action)
  stopRecording?()
  close()
}
```

This shape is also expressed by the exported `Driver` TypeScript interface in `packages/core/src/driver.ts`.

`start()` opens the entry state and returns an `ExecResult` whose performance
and network data seed the gate. `captureSnapshot()` returns text, optional
screenshot, and artifact references. `execute()` uses an agent action;
`executeLocator()` replays the opaque durable locator stored in an acted
envelope. `location()` provides the value stored in `result.url`.
`effectToken()` supplies the transport-specific no-effect fingerprint.
`normalizeSnapshot()` removes transport-specific volatile noise before replay
drift comparison. `consoleErrorLog()` optionally returns bounded structured
messages behind the exact `consoleErrors()` count.

Three optional hooks decide what a driver *persists*, as opposed to what it
captures. `snapshotProjection(text)` returns the value stored as the envelope's
`snapshot_text`; the raw capture still reaches the actor and the run-local step
artifacts. It must be idempotent, because replay projects both the live snapshot
and the baseline's before comparing — which is also what keeps a baseline
recorded before the hook existed replayable. `redactAction(action)` returns the
form of an action the trajectory persists; the runner then executes that same
form, so record and act send identical bytes. `parameterizeAction(action)` runs
after redaction and returns `{ action, bindings }`: the action with substitution
tokens in place of values earlier responses produced, plus the binding records
the envelope stores ([Bindings](#bindings)). It returns the same action object
by identity when nothing binds. A driver without these hooks persists exactly
what it captured and decided. Web exposes `viewport` and uses optional
`stopRecording()` to freeze the final DOM and write
`final.a11y.txt`/`final.mhtml` before gate evaluation. Its return value contains
the post-action final text; the runner replaces its gate/grader-facing
`lastSnapshot` with that value. Per-step artifacts remain pre-action evidence.

`execute()` and `executeLocator()` take an optional context —
`{ step, bindings }` — naming the run step the action belongs to and the
bindings its tokens resolve against. Drivers that do not parameterize actions
ignore it.

Per-action validation and execution failures return `ok: false`; they do not
throw. A driver throws only when the transport itself is unusable. `close()`
must attempt to finalize transport artifacts even after a failed step.

### Driver matrix

| Capability | Web | Mobile | API |
|---|---|---|---|
| Actions | `click`, `type`, `select`, `scroll`, `navigate`, `back`, `wait`, `done`, `give_up` | `tap`, `type`, `swipe`, `scroll`, `back`, `wait`, `done`, `give_up` | `request`, `wait`, `done`, `give_up` |
| Deterministic success | `url_matches`, `element_exists`, `api_called`, `console_errors`, `accessibility_violations`, `invariant` | `screen_shows` | `url_matches`, `api_called`, `response_status`, `response_matches`, `invariant` |
| Model success | `assert` | `assert` | `assert` |
| Advisory `observe:` | yes | no | yes |
| Performance keys | `lcp_ms`, `input_to_paint_ms` | none | none |
| Network capture | yes | no | yes |
| Gate observation phase | no | no | yes |
| `app.openapi` | gate only | no | actor + gate |
| Screenshot | yes | yes | no |

`invariant` and the advisory `observe:` list follow network capture, not the
transport: any driver that records a request trace can evaluate the Tier-1/2
policies over it ([Invariant policies](#invariant-policies)). On web that trace
is `har.json` — what the page asked for on the journey's behalf — so a web
journey can gate on the API underneath its UI. Mobile has no network capture, so
every policy would report not-exercised, which under `success:` is a failure;
the kind stays a configuration error there instead.

The gate's read-only observation phase is api only, and so is
`invariant.observe`. `app.openapi` is accepted on web, where it is read by the
gate alone: the spec never enters a web actor's prompt, snapshot, or pins.

Custom assertion keys may support any driver according to their module. They
read `har.json` through `ctx.runDir` and are driver-independent already; a web
run's HAR is the same file in the same format as an api run's.

For web and mobile, the first settle uses an explicit
`app.settle.initial_quiet_ms` when provided; otherwise its quiet window is
`max(2 × the driver quiet window, 500 ms)`, still capped by `max_ms`. An
explicit value is part of the settle comparability pin.

### Step validation

`packages/core/src/schemas/step.schema.json` is the strict canonical action schema.
Actions are flat: one `type` plus the fields used by that verb. Per-verb
required fields use `allOf` conditionals.

`drivers/overlay.ts` derives:

- `stepSchemaFor(driver)`: strict Ajv validation with driver-scoped verbs and
  directions.
- `toolParamsFor(driver)`: the smaller model-facing schema containing only the
  driver's verbs and fields, without validation-only keywords.

The OpenAI-compatible endpoint does not constrain decoding, so returned tool
arguments always pass through the strict validator. A field valid for a
different verb of the same driver may survive validation; execution switches
on `type` and ignores unrelated fields.

### Web driver

The web driver uses Chromium through Playwright. Its default context is
1280×720, tracing is enabled, and no live video is recorded. A configured
browser channel is used only through `PLAYTEST_BROWSER_CHANNEL`.

Snapshots assign fresh `data-dummy-ref="eN"` references and write PNG, MHTML,
and text artifacts. The model screenshot is downscaled only when its longest
edge exceeds 1568 px; the stored PNG stays full size. Snapshot capture failure
degrades to text-only. A numeric viewport height captures the visible viewport;
`height: null` stores full-page stills. Web also captures axe WCAG A/AA
violations after settled actions and on the terminal state, best-effort.

The snapshot contains visible interactive elements, headings, labels, and
significant text, capped at roughly 200 elements or 6,000 characters.
Accessible names prefer `aria-label`, `aria-labelledby`, associated or wrapping
labels, placeholder, alt, title, then trimmed text. Landmark roles (`banner`,
`main`, `navigation`, `complementary`, `contentinfo`, `search`, `form`) are
containers: they never receive refs — a landmark's accessible name is not
computed from contents, so a ref line there would scoop up child labels — and
their prose surfaces as text lines (`a11y-text-v6`).

Durable locators prefer, in order:

1. A unique `data-testid` on the element or ancestor.
2. A unique exact role and accessible name.
3. Unique exact text.
4. An ID or `nth-of-type` CSS path.

For a visually hidden radio or checkbox, the snapshot ref lives on its visible
label while the semantic locator resolves the associated input. Verification
treats that label/control association as one actionable target, so a unique
`role=radio[name="…"]` or `role=checkbox[name="…"]` is retained instead of
falling through to the label's structural CSS path. Replay honors the same
association: when a baseline locator resolves to a control that is not visible
(zero-size or hidden native inputs behind styled labels), a replayed *click*
acts on the control's visible label — the surface the recorder actually
clicked — and enabled-state is still checked on the control. A replayed
*scroll* proceeds on the hidden control as-is: the target is only an anchor
for the nearest scrollable ancestor, a chain the control shares with its
visible label. Any other action type still requires the control itself to be
visible.

After every action, settle waits for both network and DOM quiet windows, capped
by `settle.max_ms`. Reaching the cap still produces a successful settled
action. Performance is measured from dispatch through settle. The HAR window
also includes requests arriving after the prior step's settle and before
dispatch; `perf.requests` counts only requests from dispatch onward.

Web action semantics are stable: `type` fills and optionally presses Enter;
`select` on a real `<select>` tries option label before value, and on any other
element clicks the ref (the verb means "choose this option", so a radio or
option-card target is chosen the way a user would choose it);
`scroll` moves 600 px in the requested
direction — a supplied target anchors the scroll to its nearest scrollable
ancestor (target included), and an inert chain falls back to the page-level
scroller (a target on a label, heading, or option card must never swallow the
scroll); `navigate` resolves relative
URLs against the base URL; `back` is a benign no-op at history start; and
`wait` is bounded to 0.1–10 seconds.

After the actor loop, `stopRecording()` captures run-level final text and MHTML
and rehosts the final light DOM in a check page. `element_exists` and location
checks use that frozen state while final gating and grading continue.

### Mobile driver

The mobile driver uses Appium/W3C WebDriver through lazily imported
`webdriverio`, an optional dependency. Missing support is a driver-specific
preflight error. It renders the page-source accessibility tree as referenced
text, records a screen capture, and resolves refs to accessibility locators or
predicates. Settle requires the accessibility tree to remain stable for its
quiet window. Mobile v1 records neither network nor web-vital performance.
`preserve_session` maps to Appium `noReset`.

An element's rendered name is its human-readable text, not its identifier: iOS
`label` is preferred over `name`, which XCUITest reports as the accessibility
identifier whenever the app sets one; Android reads `content-desc` then `text`.
The identifier remains the locator surface, so an annotated app renders content
and still resolves to a durable `~identifier`. A non-empty accessibility value
renders for every role — typable controls as `value="…"`, all others
parenthesized (`button "Buy milk" (completed)`) — because a native control
commonly carries its state there rather than in its label.

### API driver

The API driver uses `fetch`. Its snapshot includes the base URL, OpenAPI
operations as referenced `METHOD /path` entries when a spec is configured, and
the last JSON response. It records no screenshot. A request's durable locator
is `"METHOD /path"`.

Full request and response bodies are written only to `har.json`; envelopes
retain the stable request subset. `start()` issues no synthetic request because
the environment was already health-probed and a prime request must not satisfy
a gate. Without an OpenAPI spec, the snapshot has no referenced operation list
and the actor may still request paths inferred from the story.

**Standing headers.** `app.headers` (API only) is sent with every request,
merged under the action's own headers case-insensitively. Its values may be
secret references ([Secrets and redaction](#secrets-and-redaction)); they
resolve at driver launch and never enter a recorded action, so a credential is
configuration rather than something the actor holds. A `{ $secret: … }`
placeholder inside a recorded action's headers or body is resolved at request
time — the mechanism that lets a committed baseline act. Act-time resolution
applies to request inputs only.

**Persisted form.** The API driver implements both persistence hooks: envelopes
carry the normalized response projection instead of the raw response body, and
the redacted request program instead of injected or redaction-listed values.
See [Artifact contracts](artifacts.md#baseline-files).

**Persisted form.** Envelopes also carry the parameterized request program
([Bindings](#bindings)) and the exact status each request answered
(`expect.status`, the step-scoped expectation of
[Act and heal](#act-and-heal)).

**Egress guard.** The driver refuses any request whose resolved origin is not
`base_url`'s origin or listed in `app.allowed_origins` (api-only key). The
refusal happens before any network I/O or HAR entry and surfaces as a failed
step returned to the actor — never a crash. `allowed_origins` entries must be
bare http(s) origins (`scheme://host[:port]`); a path, query, hash, or
credentials in an entry is a `DummyConfigError`, because an allowed origin
admits the whole origin and anything narrower would imply a scoping the guard
does not perform. Non-http(s) resolutions (`file:`, `data:`, …) have no
admissible origin and are always refused.

**Observation channel.** `driver.observe({ method, path })` issues the
read-only requests an invariant policy declares
([Invariant policies](#invariant-policies)). It accepts `GET` and `HEAD` only —
anything else throws before any I/O, so "the gate never issues a mutation" is a
property of the transport rather than a convention. It passes the same egress
guard, records a HAR entry tagged `_observation: true`, and touches neither the
last-response state (so it cannot move `location()` or the drift oracle) nor the
binding ledger (so it cannot alter a later replay). A transport failure throws
and the run finishes as infrastructure, never as a red verdict.

### Bindings

A recorded request that names the id the previous response invented only
replays against the instance that invented it. Acted API steps therefore
persist a **parameterized program**: a substitution token `{{name}}` stands in
for the value, and the step envelope records where the value comes from.

```js
bindings: [
  { name: "id_1", from_step: 1, from: "$.id", into: ["path", "body.account_id"] }
]
```

Every substitution cites its producer step, so provenance is readable straight
from the trajectory. At replay the driver re-reads `from` on the *fresh*
response of the step that produced it and substitutes that value, which is what
lets one baseline run against a new instance with new identifiers.

Inference is deterministic and conservative. A value binds only when all of the
following hold; anything else keeps its literal.

- It is a string of at least four characters. Numbers and booleans never bind.
- It is server-generated: it appears in a response and nowhere in the request
  that produced that response, so echoed client input never binds.
- It is identifier-shaped: its response key ends in an identifier word (`id`,
  `uuid`, `guid`, `key`, `token`, `slug`, `ref`, `href`, `url`, `location`,
  `cursor`, in `snake_case` or `camelCase`), or the value is a UUID or ULID.
- It is not a value core injected from a secret reference; those are
  [redaction](#secrets-and-redaction)'s job.
- The consumer's literal matches it whole: a whole path segment, a whole query
  value, a whole header value, or a whole JSON string leaf. Nothing is ever
  templated into the middle of a longer string, and a value that would need
  percent-encoding never binds into a URL.

When several responses carry the same value, the earliest producer wins, so the
recorded provenance is stable. A token the actor reuses from its own recorded
history binds like any other substitution, so a copied token never becomes an
action that fails on its own replay.

`bind` (api only, inheritable) is the declarative escape hatch for an id the
heuristic does not recognize:

```yaml
bind:
  - $.data.reference
  - $.items[*].handle
```

A declared path widens *which fields may produce* a binding. It never relaxes
the value rules above: the value must still be a server-generated string of at
least four characters that the consumer echoes whole. Paths normalize to
`$`-rooted form with list indices wildcarded, so one entry covers a list.

Replay fails the step, loudly, rather than sending a request it cannot fully
resolve: an unreadable producer, a field that no longer holds a value, an
unbound token, or a substituted value that would reshape the URL. The failure
starts heal like any other; it never degrades into sending a stale identifier.
Steps that bind nothing carry no `bindings` field, and a baseline recorded
before bindings existed replays unchanged.

### Match rules

`match` (api only, inheritable) is the vocabulary API drift comparison is
normalized through. Shape-only projection already absorbs fresh identifiers and
timestamps; these rules address volatile *structure* and the fields a suite
wants compared by value.

```yaml
match:
  exclude: ["$.debug"]                 # value -> "[excluded]"; the key stays
  compare: ["$.status"]                # the literal value enters the projection
  normalize:
    - path: "$.items"
      rule: length                     # sorted | length
  status_equivalent:
    - [201, 202]                       # or a class: "2xx"
```

Field paths accept `$.a.b`, `a.b`, `a[*].b`, and `a[n].b`; `$` selects the whole
body.

One invariant governs all of them: **key structure always survives**. An
excluded, normalized, or redacted node keeps its key and reports a marker, so a
renamed, added, or removed field still changes the projection and still triggers
drift. Redaction is applied before any match rule, so no rule can resurrect a
value redaction suppressed. A value enters the committed projection only where a
`compare` rule names it.

`status_equivalent` is the only way to widen a status comparison, for both the
step-scoped expectation and the snapshot status line. It is applied when
comparing, never when persisting, so a baseline always records the status that
actually happened and an equivalence declared after recording still works.
Malformed rules are `DummyConfigError`s naming the file; a `match` block that
declares nothing resolves to no rules at all.

### OpenAPI ingestion

When `app.openapi` is set, the driver resolves the document into an enriched
operation list: merged path- and operation-level parameters, request and
response schemas, declared status codes, response links, and security schemes.
On the api driver the result feeds the actor's snapshot — each `[eN]` line names
the operation's required parameters and body fields and the statuses it may
answer — and is passed to the gate as `ctx.spec`, the spec-driven material
invariant checks are built on.

`app.openapi` is also accepted on the **web** driver, where it is **gate-only**:
the document is resolved at launch with the same hermetic boundary and exposed
as `driver.spec`, but it never reaches the actor's prompt, the snapshot, or the
pins. A web journey is written in clicks, not operations; the spec is there so
the Tier-1 invariant policies have an oracle for the requests the page made
([Invariant policies](#invariant-policies)). Operation paths are matched against
recorded request paths verbatim — there is no server base-path rewriting — so a
page calling `/api/todos` needs a spec declaring `/api/todos`.

Resolution happens inside a run, so its boundary is hermetic:

- Internal pointers (`#/…`) always resolve.
- File refs resolve only within the spec file's own directory tree; a ref that
  escapes it is a config error.
- Network refs (`https://…`) are refused outright. Vendor the document into the
  suite and reference it by relative path.
- Documents are size-capped per file, and ref expansion is node-capped, so a
  self-multiplying `$ref` reports a config error instead of exhausting memory.
- A recursive schema resolves to `{ $ref_cycle: "<ref>" }` and is reported in
  the enriched document's `diagnostics`, rather than expanding forever.

Every failure — an unreadable, unparsable, oversized, or non-OpenAPI document, an
unresolvable pointer, a refused ref — is a `DummyConfigError` naming the file and
the ref. A declared spec that cannot be ingested stops the run rather than
silently downgrading the actor to an empty operation list.

## Model gateway and actor

### Gateway

`llmConfig()` resolves:

- Base URL only from `PLAYTEST_LLM_BASE_URL`; there is no implicit endpoint.
- API key from `PLAYTEST_LLM_API_KEY`, then `ANTHROPIC_API_KEY`, then
  `OPENAI_API_KEY`.
- Availability only when the explicit base URL exists. A keyless gateway is
  valid; a key without a gateway URL is not.
- Prompt caching on by default; `PLAYTEST_LLM_CACHE=0|false|off|no` disables it.

Configured model aliases resolve through `packages/core/src/models.json`;
`PLAYTEST_<ALIAS>_MODEL` overrides an alias, while an unknown value passes
through as an already qualified model name.

`chat()` posts the OpenAI chat-completions shape to
`<base>/v1/chat/completions`. GPT-5 names use `max_completion_tokens`; other
models use `max_tokens`. Network and 5xx failures receive at most three total
attempts. HTTP 429 receives at most seven, with full-jitter exponential backoff
and a capped `Retry-After`. Each attempt is capped at 60 seconds;
`PLAYTEST_LLM_TIMEOUT_MS` may raise the cap. The caller's abort signal cancels
the request and any backoff.

`forcedToolCall()` requires the named tool, coerces nested JSON strings in tool
arguments, validates the result, and retries once with the validation error.
Terminal failures are `LlmError`. Returned `tokens` sum usage across attempts —
a validation retry re-sends the full prompt, so a retried call reports roughly
double the input tokens — and `retries` lists the validation error behind each
extra attempt (empty when the first call validated).

When caching is enabled, one stable breakpoint message is converted to a text
block with ephemeral cache control. The marker remains in the OpenAI-compatible
request; endpoints without cache-control support may ignore it. Usage is
normalized as `{ in, out, cache_read }`.

### Personas and prompt

Built-in personas are `tester`, `exploratory`, and `adversarial`. Custom
personas are found in `personas/*.yaml` from the case directory upward to the
repository root, matching either their `name` or filename slug. A missing
persona error lists searched directories and suggests
`playtest new persona <name>`.

`listPersonas(fromDirOrCaseFile)` reports the visible names; `builtinPersonas()`
reports the three built-ins with the exact description text `loadPersona` would
inject, so a picker can show the prose without keeping a second copy of it.
Personas resolve at run time only — `discoverCases` does not resolve them, so an
unknown persona name validates and then fails the run.

The actor system prefix contains the role-play frame, driver overlay, persona,
and story. Discovery adds its exploration overlay. Vision discovery adds its
visual overlay. The final stable heading is `## Your task`.

Each turn then sends:

1. An append-only log of prior steps, including action, result, URL, error, and
   thought.
2. The current referenced snapshot.
3. Exactly one PNG data URL when vision is enabled and capture succeeded.

The log is never folded or rewritten because prompt-prefix stability is part
of the cache contract. `max_steps` bounds its growth.

The actor must return the forced `step` tool. Validation retries once.
Successful output is:

```js
{
  agentStep: {
    thought,
    action,
    expectation,
    visual?,
    raises?
  },
  tokens: { in, out, cache_read },
  retries: ["<validation error per extra attempt>"]
}
```

Prompts require role-play as the user, only visible refs, falsifiable
expectations, `done` only for a visibly achieved goal, and `give_up` after
honest attempts.

## Environment and setup

Managed web/API cases run:

```text
docker compose -f <file> -p playtest-<run-id>-<n> up -d --wait
```

If `base_url` names a compose service, environment preparation resolves its
published localhost port. The resulting URL has no trailing slash. Teardown
runs `down -v --rmi local`, removing the run's containers, volumes, and
locally built image while retaining pulled base images.

External cases use `base_url` unchanged. Web/API health probing accepts HTTP
status below 500 and attempts five times one second apart. A failed localhost
probe suggests starting the app or adding a nearby compose file; managed probe
errors retain the underlying cause.

An init script runs after a successful probe with its own directory as cwd and
with `BASE_URL` and `RUN_ID`. JavaScript extensions use the current Node
executable; other files execute directly. Boot, probe, init, and unresolved-auth
failures are `InfraError`.

Mobile does not HTTP-probe an application origin; Appium session creation is
the probe. Init receives the Appium endpoint as `BASE_URL`.

A trusted `<suiteRoot>/hooks/before_each.js` default export runs once after
driver creation and before the execution loop. It receives:

```js
{
  runId,
  runDir,
  startedAt,
  baseUrl,
  driver,
  env,
  suiteName,
  storyId,
  caseId
}
```

It may return at most 2 KB of UTF-8 context for the actor. A throw or invalid
return is infrastructure failure. Hook provenance is stored in
`manifest.setup`.

## Run lifecycle

`runCase(resolvedCase, opts)` never throws to its caller. It returns:

```js
{
  status: "pass" | "fail" | "infra" | "explored" | "interrupted",
  runDir,
  manifest,
  score: number | null,
  error?
}
```

`opts.driverFactory` is a test seam: it replaces the driver factory so the
hermetic engine tests can run record/act/heal against a scripted in-memory
driver. Production callers never pass it.

The execution strategy is:

| Case and state | Strategy |
|---|---|
| Discovery case | `explore`, always fresh |
| Journey with no baseline, an unreplayable path, a story-hash mismatch, or a snapshot-format mismatch | `record` |
| Journey with a usable matching baseline | `act` |
| Act replay with drift or action failure | `heal` |
| Explicit agent mode | `record` |

Discovery never reads a baseline, evaluates a gate, or writes baseline files.
It returns `explored` after a normal terminal reason and `infra` after an actor
or infrastructure error. An unreadable journey baseline produces `infra`;
a missing or legacy `story_hash`, or a hash mismatch, forces `record`. A
baseline whose `pins.snapshot_format` differs from the running driver's format
also forces `record` — the drift oracle presumes both sides were serialized
the same way, and a serializer change would otherwise read as app drift on
every page; a baseline with no recorded format is a wildcard and replays.

The run directory receives an `interrupted` placeholder manifest before setup.
`SIGINT` refreshes its partial totals before the process re-raises the signal
and exits 130. Any completed final manifest disables later placeholder writes.

### Record and explore

The agent loop repeatedly captures a snapshot, obtains an actor step, executes
it, and appends an envelope until `done`, `give_up`, `max_steps`, timeout,
stuck, or error.

Harness confusion detection records:

- `action_failed` when execution is not successful.
- `repeated_action` when the same action is chosen twice against the same
  driver-normalized pre-action snapshot.
- `no_effect` after a successful click, tap, or type with no requests,
  transport effect, or location change.
- `self_reported` from an actor confusion raise when no harness detection wins.

Four consecutive identical action failures end with `stuck`. Finding raises do
not imply confusion and increment `totals.finding_events`.

### Act and heal

Act mode uses the accepted `actionTrack`. Before executing each recorded
locator, it compares the fresh normalized snapshot to `snapshot_text`, with
base-URL normalization. Both sides pass through the driver's optional
`snapshotProjection()` first, so the comparison is always projection against
projection; because projection is idempotent, a baseline recorded in the raw
form is projected on the fly and keeps replaying. Web visual regression also
compares dHash distance to the configured threshold.

Drift writes a non-executed envelope with `state_drift`, then starts heal at
that step. An execution failure starts heal with `action_failed`. Heal carries
the story and acted-so-far digest into an actor loop using the remaining step
budget. `manifest.heal` records the transition.

**Step-scoped expectations.** A snapshot compares the state a step acted *on*,
so a changed response is only noticed by the step after it. An acted step that
records `expect.status` is therefore also compared directly: the status the
replayed request just answered against the status the baseline recorded for that
same step. A difference is drift attributed to *that* step — it writes the same
`state_drift` marker and starts heal there.

The comparison is exact. A within-class change (201 to 202, 200 to 204) is a
contract change, so a status class is never an implicit match; only
`match.status_equivalent` ([Match rules](#match-rules)) declares two statuses
interchangeable, and it applies to the snapshot status line as well so both
oracles agree. A baseline without `expect` — recorded before the field existed,
or by a transport that reports no status — skips the check and replays exactly
as it did.

Recorded actions may also carry `{{name}}` substitutions
([Bindings](#bindings)); those resolve against this run's responses before the
request is sent.

Without a configured model, an act failure cannot heal and becomes a failed run
with `end_reason: "error"`.

#### Heal re-anchor

A heal does not have to run to the end of the journey. On the web and mobile
drivers, after each agent step settles, the harness evaluates the freshly
captured snapshot — the one already taken for the actor's next turn — against
the remaining baseline window with the same drift oracle replay itself uses:
exact normalized-projection equality, plus the visual channel when
`visual_regression` is on. The window is the baseline's action-track steps
**strictly after** the heal point that carry `snapshot_text`; a step without
the recorded oracle is never a candidate, and the window never reaches behind
the heal point. The check arms only after the heal's first agent step: heal was
entered because the state did not replay, so the heal-entry snapshot has
nothing to match.

Exactly one passing candidate resumes deterministic replay at that step —
envelope modes read `act … act(fail) agent … agent act … done`. More than one
passing candidate (byte-identical wizard screens) anchors nothing at that
check; the actor keeps driving and the check re-arms after its next step. No
match anywhere degrades to today's heal-to-end behavior. Earliest-unique is
safe because normalized snapshots carry control state (`(checked)`, field
values, status lines): the pre-action state of a step the agent already
performed no longer occurs. A wrong anchor self-limits — replay's own per-step
drift and expectation checks run from the resumed step onward, and because the
window excludes the heal point, a later failure heals again from a strictly
later step, so a bad anchor cannot loop.

The heal actor never learns about re-anchoring: no prompt changes, no new
envelope fields. The api driver is excluded in v1 — its snapshot is a
projection of the last response, too weak a fingerprint of world state to
anchor on — so api heals, their triage, and their acceptance are unchanged.

`manifest.heal` gains `segments` — one `{ from, to }` per heal segment, where
`from` is the baseline step that escalated and `to` is the baseline step where
replay resumed (`null` when that segment ran to the end) — and `agent_steps`,
the total count of agent-mode envelopes across segments. A segment that armed
an anchor window but never resumed additionally carries
`nearest: { step, diff_lines }` — the candidate baseline step with the fewest
differing normalized snapshot lines against the final live snapshot — and
emits a `warn` progress event naming it, so a whole-run anchoring failure (a
systematic one-line difference on every screen points at the serializer, not
the app) is a one-line diagnosis rather than a silent stuck run. `from_step`,
`kind`, and `reason` keep describing the **first** divergence, so ledger lines
and the heal digest group exactly as before. Each resume emits a `heal_resume`
progress event. Re-anchoring changes who drives the middle of the run, never how the
end state is judged: the gate, grading, and heal acceptance are untouched.

#### Heal triage

Before any patching, the harness classifies the failure from recorded evidence:
the status the baseline recorded for that step against the status it just
answered, the two response projections either side of the divergence, and the
baseline's own binding graph. No model is consulted.

| Class | Deterministic signal |
|---|---|
| `regression` | `server_error` (5xx), `refusal_lost` (the baseline recorded a 4xx and the same call now answers 2xx), `resource_vanished` (2xx became 404/410 on a path bound to a resource this journey created) |
| `baseline_drift` | `provisioning_failed` — a step later steps bind from failed with a transport error or 409/412/423, so the target was not clean |
| `contract_drift` | everything else: `field_renamed`, `field_added`, `field_removed`, `status_changed`, `surface_changed`, `action_failed` |

A 404 on a path the journey *bound* is a disappearing record; a 404 on a static
path is a moved endpoint, so the two classify differently. The verdict, and the
signals behind it, ride on `manifest.heal` and on the drift report
([Artifact contracts](artifacts.md#drift-report)).

#### Heal acceptance

A heal is accepted — recorded as a changed journey, `status: "pass"` plus
`healed: true` — only when **all** of these hold. The first three apply to the
api driver; web and mobile healing is unchanged.

1. The healed run ended with the actor's own `done`. This is an **allowlist**,
   not a blacklist: `give_up`, `max_steps`, `stuck`, timeout, and any ending
   added later are refused by construction. Every non-`error` ending still counts
   as reaching the goal everywhere else; only heal acceptance is this strict.
2. At least one **applicable hard deterministic postcondition actually
   evaluated** on the healed trajectory. A check qualifies when it is hard (not a
   console or perf budget), deterministic (not a model `assert`), applicable (not
   an invariant policy the story never exercised), and freshly evaluated (not an
   inherited verdict, which was decided against a different trajectory). An empty
   `success` list passes the gate vacuously and can never accept a heal.
3. Triage did not classify the failure as a `regression`.
4. The full deterministic gate passed on the healed trajectory — every
   postcondition and every applicable invariant.

The acceptance decision only ever subtracts. It can turn a would-be pass into a
fail; it can never rescue a failing gate. When it refuses, the run is `fail`,
`manifest.heal.accepted` is false with a `rejected_reason`, no healed candidate
is written, and the reason is emitted as a warning.

The model's role stays bounded to proposing the rebind the heal loop explores and
writing the drift report's narrative. It has no authority over the
classification, the gate, the status, or the exit code, and no confidence score
exists that could acquire any.

`changed` remains a display and lifecycle term. There is no new result status and
no consumer migration.

### Post-execution phases

After the loop:

1. A clean act replay loads inheritable verdicts from baseline metadata.
2. The harness prepends the web driver's synthetic initial-load performance
   and network window to gate input, so initial LCP and bootstrap requests count.
3. Required custom assertions gather evidence and embed it in the final
   envelope.
4. Journey gates run against the live final driver state and complete
   trajectory.
5. Manifest, driver artifacts, teardown, captions, and optional slideshow are
   finalized.
6. Eligible record/heal/explore runs grade when requested and a model is
   available.
7. Eligible journeys update the baseline or healed candidate.

`baselineEligible` requires every hard gate to pass and the actor to reach the
goal. Soft-only failures may still create or update a baseline. A record writes
the baseline when none exists or refresh was requested. Refresh removes a
stale healed candidate. A successful heal writes a candidate, never the
accepted baseline directly.

Every automatic acceptance is gated by the leak scan
([Interface contracts](interfaces.md#baseline-review-and-grading)). A clean scan
accepts exactly as it always has. Findings write a pending candidate instead of
the baseline, record them in `manifest.baseline_scan`, and emit a `warn` naming
each one and the explicit accept that would approve it.

The wall-clock deadline covers environment setup, driver activity, model calls,
gate evaluation, and finalization.

## Gates and custom assertions

`evaluateGate()` evaluates every success criterion in authored order, followed
by performance thresholds. It never short-circuits or throws and returns:

```js
{
  pass,
  hardPass,
  checks: [{
    kind,
    severity: "hard" | "soft",
    spec,
    label?,
    pass,
    applicable,
    detail,
    steps?,
    inherited?
  }],
  advisory?: [{ kind, severity: "advisory", spec, label?, pass, applicable, detail, steps? }]
}
```

`applicable` is false only for an invariant policy the recorded trace never
exercised. Under `success:` that is a failure; under `observe:` it is a report.
Every other kind is always applicable, and a check without the field (a run from
before it existed) is read as applicable.

`steps` is present only on an invariant violation, and lists the step numbers
whose actions produced the offending requests, ascending. The attribution seam
is the step envelope's `artifacts.har_entries`
([step envelope](artifacts.md#step-envelope)), so it holds for every driver that
records network traffic. A request no step owns — the harness's initial page
load, a request that arrived after the last settle — contributes no citation
rather than a fabricated one, so the field is absent when nothing can be cited.
The viewer renders each citation as a deep link into the step timeline.

Built-in behavior:

- `url_matches`: glob against the full location or pathname.
- `element_exists` / `screen_shows`: `driver.finalPageCheck()`.
- `api_called`: match method and path against the union of embedded requests
  and HAR requests, deduplicated by method and path. The HAR covers legacy
  trajectories and requests arriving after the final settle.
- `response_status`: exact status or class such as `2xx` against any response.
- `response_matches`: minimal JSON path/value comparison over the last HAR
  response body, for example `$.title == "buy milk"`.

Both API response kinds also accept a **structured operation selector**, which
attributes the check to one operation instead of the whole run:

```yaml
success:
  - response_status:
      op: "POST /accounts/{accountId}/close"   # method + OpenAPI-style path template
      status: "204"                            # exact; a class like "2xx" is an explicit choice
      occurrence: all                          # all | any | first | last — default all
  - response_matches:
      op: "GET /accounts/{accountId}"
      match: "$.balance == 90"
      occurrence: last                         # default last for body matching
```

`{param}` matches exactly one path segment. `occurrence` disambiguates repeated
calls to the same operation: `all` requires every matching response, `any` at
least one, `first`/`last` the matching response at that end. A selector matching
**zero** requests fails the check — a declared expectation must be exercised to
pass, so `all` is never vacuously true. Each selector gets its own stable `spec`
key, so two checks on one kind never collide. When a spec is configured, a
failing selector's detail also reports what the document declares for that
operation. The bare-string forms keep today's any-request and last-body
semantics, so existing suites are untouched. A malformed selector is a
`DummyConfigError` naming the case file, raised at discovery rather than at the
end of a run.
- `console_errors`: total web console errors at or below the configured number.
- `accessibility_violations`: total axe WCAG violation-node count summed across
  web envelopes at or below the configured number.
- `assert`: model judgment over the final state and trajectory, with bounded
  intermediate-snapshot fetches; missing model is a failed check, not
  infrastructure failure.
- `lcp_ms` / `input_to_paint_ms`: comparison against the worst recorded value.

Performance thresholds accept `<`, `<=`, `>`, or `>=`; a bare number means
`<=`.

- `invariant`: a Tier-1/2 API invariant policy, below.

Console-error and performance checks are soft. Accessibility and every other
built-in kind are hard. The kind decides severity; cases cannot override it.

Only `assert` is inheritable among built-ins. Deterministic checks always rerun.
A custom assertion's `inheritable` field defaults to true. Inheritance occurs
only on a clean act replay with a saved verdict.

### Custom assertion modules

A suite may define a deterministic success kind in
`<suiteRoot>/assertions/<name>/assertion.js`. The suite root is the nearest
ancestor of the case file containing `playtest.yaml`, or the case's directory
when no such ancestor exists. Assertion directories are loaded in name-sorted
order; a directory without `assertion.js` is ignored. Modules are trusted code,
dynamic-imported at configuration time with the harness's privileges and no
sandbox.

```js
export default {
  keys() {
    return ["order_reached_warehouse"];
  },

  async gather(ctx) {
    return { rows: await queryWarehouse(ctx.env.WAREHOUSE_URL, ctx.runId) };
  },

  verdict({ key, value, evidence }) {
    const hit = evidence.rows.find((row) => row.status === "received");
    return hit
      ? { pass: true, detail: `order ${hit.id} received` }
      : { pass: false, detail: `no received order (${value})` };
  },

  inheritable: false,
};
```

The default export must be an object with `keys()`, `gather()`, and `verdict()`;
`inheritable` is optional and must be boolean. Import failures, missing
functions, invalid `inheritable`, and a throwing or malformed `keys()` are
`DummyConfigError`s, so no run starts. `keys()` returns a non-empty array of
non-empty strings. A key cannot shadow a built-in success kind or another
assertion's key. Registered keys extend a per-suite clone of the case schema;
their authored values may be a string, number, or boolean, and unknown keys
remain configuration errors.

`gather(ctx)` runs once per needed module, after the actor stops and before the
gate. Unused modules do not gather. Needed modules gather sequentially in
assertion-directory order, except that a module is skipped when every one of
its used criteria will inherit a saved verdict. The harness awaits a returned
Promise. `ctx` is:

```js
{
  runId,       // this run's id
  runDir,      // absolute run directory
  startedAt,   // Date: the run start
  baseUrl,     // resolved application URL when present
  driver,      // "web" | "mobile" | "api"
  env,         // process.env plus BASE_URL and RUN_ID
  trajectory  // completed step envelopes in order
}
```

`runDir` may already contain step artifacts, a placeholder `manifest.json`, and
`har.json`; the final manifest is written after the gate. Before gathering, the
driver is asked to flush its current HAR entries. A gather failure or timeout is
an infrastructure error: the gate does not run and the case exits through the
infrastructure boundary.

The gathered value is passed unchanged as `evidence` to every used key owned by
that module. Its persisted representation is specified under
[custom assertion evidence](artifacts.md#custom-assertion-evidence).

`verdict({ key, value, evidence })` is synchronous and returns
`{ pass: boolean, detail?: string }`. `key` is the registered criterion,
`value` is the authored scalar without interpretation by core, and `evidence`
is the module's gathered value. A returned Promise or any other malformed
result is a failed check naming the assertion; a throw is caught as
`check error: ...`. Verdicts should therefore be pure over their arguments,
with all I/O confined to `gather()`.

Every custom assertion is a hard check. Failure makes the run red and blocks
baseline acceptance; cases cannot override its severity. Gate evaluation still
does not short-circuit.

`inheritable` defaults to true. On a clean act replay with a saved verdict, the
gate reuses the saved `pass` and `detail`, marks the check `inherited: true`,
and skips `verdict()`. If every used key owned by a module inherits, `gather()`
is skipped too. Record, heal, legacy-baseline, and changed-trajectory runs
evaluate live. Assertions over live state, expiring evidence, or fresh
counterexample searches set `inheritable: false`.

## Invariant policies

The `invariant:` success kind declares one parameterized property of the API
under test. It is valid on the **api and web** drivers — every policy reads a
recorded request/response trace, and both record one. Two tiers ship:

| Policy | Tier | Checks |
|---|---|---|
| `no_server_error` | 1 | no 5xx in scope |
| `documented_status` | 1 | every response status is declared by the spec for that operation |
| `response_schema` | 1 | JSON response bodies validate against the spec's schema for that status |
| `content_type` | 1 | responses carry a media type the spec declares for that status |
| `round_trip` | 2 | declared client-owned fields survive a write and a read-back |
| `idempotency` | 2 | repeating an operation reaches an equivalent normalized state |
| `lifecycle` | 2 | reads after a delete answer a declared status, and a declared surviving state matches |
| `pagination` | 2 | no identity repeats across an enumeration, and its cursor progresses and terminates |
| `error_shape` | 2 | non-excluded 4xx bodies carry the declared error envelope |

Tier-1 policies other than `no_server_error` read the enriched document, so
declaring one without `app.openapi` is a `DummyConfigError` at discovery rather
than a mystery "not applicable" at the end of a run. Each policy's own keys are
validated the same way: an unknown or missing key names the case file.

Three rules govern every policy.

**Deterministic.** A policy reads the recorded trace. No model is consulted, so
a policy can never author CI truth from a guess.

**Passive, plus read-only observation.** A policy validates what the story
already did. It may declare read-only observation requests, executed in the
gate's observe phase through the driver's observation channel, and it never
issues a mutation. Sequences needing extra mutations — an idempotency repeat, a
second delete — are checked only when the story's own trace contains them.
Observation traffic is **quarantined**: recorded in its own tagged HAR section,
visible only to the policy that asked for it, and excluded from ordinary gate
kinds (`api_called`, `response_status`, `response_matches`), from the
replay/action track, from baselines, from drift comparison, and from run
metrics. An observation GET can never satisfy a success criterion or become the
response another check inspects. An observation transport failure is an
infrastructure error, not a red verdict.

**Applicability is an outcome.** A policy declared under `success:` requires
applicability: no qualifying trace is a gate **failure**, with a detail that
names both ways out ("the story never repeats `POST /entries` with the same
`Idempotency-Key` — repeat the call in the story, or move this policy under
`observe:`"). A declared invariant that was never exercised has not held, and a
heal that went green without exercising it would have proven nothing.

**Advisory policies** live under the sibling `observe:` case key, which takes the
same entry shapes. Their results persist as a separate `advisory` array in the
manifest's gate block, render in the viewer, and never affect pass/fail or the
exit code; a not-applicable advisory reports rather than fails. `observe:` is
case-only, journey-only, and valid wherever `invariant:` is.

**Evidence is step-linked.** A violating policy names the recorded requests the
verdict is about; the gate resolves them through the step envelope's
`artifacts.har_entries` into the check's `steps` field, and the viewer renders
each as a deep link. The raw entries carry bodies and never leave the gate.

### Passive cross-layer assertions

The same policies evaluate over a **web** run's recorded HAR — "the UI looked
fine, but did the API underneath behave?" There is no composite driver and no
new action verb: the journey is an ordinary web journey, and the trace the
policies read is `har.json`, every request the page made on its way through the
story.

```yaml
# playtest.yaml — gate-only on web; the spec never reaches the actor.
app: { driver: web, base_url: "http://127.0.0.1:4173", openapi: ./openapi.yaml }

# a story that clicks through the UI, plus:
success:
  - element_exists: "[data-testid=todo-item]"
  - invariant: { policy: documented_status }
```

Four rules govern the web side.

**Passive only.** A web run has no observation phase: `invariant.observe` is
api-only and is refused at discovery on any other driver. A browser page's
requests carry session state — cookies, headers, an in-page token — that a
synthetic request issued by the harness would not reproduce, so its answer would
describe a different caller. Anything a policy needs to see must be something
the story actually caused the page to do.

**No web exemption from applicability.** A policy declared under `success:` that
finds no qualifying traffic in the HAR fails, with the same actionable detail it
gives on the api driver. Passing vacuously would hide the failure on the driver
where the trace is hardest to reason about; the way out is to extend the story
or move the policy under `observe:`.

**Spec paths are matched verbatim.** `app.openapi` operation paths are compared
against recorded request paths as written, with no server base-path rewriting —
a page calling `/api/todos` needs a spec that declares `/api/todos`. Requests
matching no spec operation (the HTML document, static assets) are skipped by the
spec-driven policies rather than failing them.

**A web trace is wider than an api trace.** It holds documents, assets, and
third-party calls as well as the app's API. `no_server_error` over the whole
trace is usually what you want; the operation-shaped policies self-select
through their `create`/`read`/`delete`/`op` selectors, and `scope:` narrows the
rest to one operation. The Tier-2 metamorphic policies need *sequences*, and a
web story only produces the sequence its clicks produce — declaring one the
journey does not exercise is a failure, not a pass.

`tests/fixtures/web-invariants/` is a committed web suite exercising this shape
against the todo-app fixture's UI.

Declared exceptions are how a policy stays sound rather than universal: soft
delete declares `after:` and `state:`, an eventually-consistent enumeration
declares `consistency: eventual`, an idempotent replay that refreshes a
timestamp declares `ignore:`, an API whose auth responses are not enveloped
relies on `error_shape`'s default `exclude_status`, and `round_trip` compares
only the fields the case names — generated, defaulted, computed, redacted, and
write-only fields are excluded by declaration, never by inference.

`tests/fixtures/api-example/` is a committed suite exercising the shape.

## Grading

`gradeRun()` selects the journey or discovery rubric. Its prompt contains the
story, a compact trajectory digest, totals, and the true post-action
`final.a11y.txt` when present (falling back to the last step's pre-action
snapshot for legacy and non-web runs), plus:

- The gate and optional baseline step count for journeys.
- Per-step visual observations and authored report questions for discovery.

Discovery never reads a baseline. Report answers retain the verbatim question
and evidence step numbers. The grader gets at most six tool turns and may call
`fetch_snapshot` for any intermediate accessibility snapshot, plus its
screenshot when vision is enabled.

A journey grade whose run produced API evidence also receives an
`## API invariants and drift` section: the run's Tier-1/2 invariant verdicts,
its advisory policy results, and — on a healed API journey — the deterministic
half of the drift report. The same harness-computed facts are spread onto
`grade.api` *after* the model call, exactly as the accessibility counts are, so
the grader may cite them but can never author or soften them. The rubric
requires it to treat a violated invariant as objective evidence of a
malfunction, to read a not-exercised policy as a gap in the story rather than a
defect, and never to overturn a verdict or suggest relaxing a check. Runs with
neither invariants nor a drift report are unchanged.

A discovery grade also receives a `## Deterministic signals` section: a compact,
model-facing list produced by the pure anomaly extractor (`packages/core/src/anomalies.ts`,
`extractAnomalies`) over the run's recorded envelopes. Its input is recorded
fields only — `network.requests` status, `console_errors`, the harness-computed
`confusion` markers (`action_failed`, `no_effect`, `repeated_action`; `state_drift`
is excluded as a skipped step), and per-step perf metrics against the case's perf
budget. It emits factual signal types (`http_4xx`, `http_5xx`, `console_exception`,
`failed_action`, `no_effect`, `repeated_action`, `perf_budget`) and never a
verdict; the section is omitted when empty. The extractor is a pure function with
no classification logic — an intended 404 or a correctly disabled control still
emits its factual signal. Journey grades do not receive this section and their
prompt bytes are unchanged.

Classifying those signals is the grader's responsibility, in the context of the
story, trajectory, actor raises, and snapshots. The discovery rubric keeps
free-form UX/quality observations in `findings` and emits grounded claims that the
application malfunctioned as typed `bug_candidates` (artifacts.md). It must refute
intended behavior, user confusion, and environment failure before emitting a
candidate, treats actor conclusions as claims rather than evidence, and may leave
the candidate list empty. A missing affordance the story or product contract
requires may be a candidate; an unsupported affordance wish stays a UX finding.
The grader assigns no durable identity or exact keys. The common path is one automatic `grade`
tool call; at the turn cap, after no tool call, or after an invalid self-issued
grade, the harness forces `grade`. Forced extraction uses the gateway's
validation retry. If it still fails, available raw attempts are written to
`grade.error.json`.

The final arguments are validated against `grade.schema.json`; the harness
then adds its exact accessibility summary, model, timestamp, and aggregate
tokens before writing `grade.json`. Discovery uses a 4096-token cap; journey
uses 2048.

The trajectory digest includes normalized actor raises. The grader may promote,
refine, or discard those notes when producing its run-local `findings`.
Grader findings cover UX and quality observations and do not create durable
hosted findings or assign cross-run identity. Discovery study synthesis may
later group those observations, but grading remains one-run analysis.

### Cross-run finding identity and lifecycle

`@playtest/core/findings` exposes the durable identity layer that sits
above one run's `grade.json`. It is the local half of a model shared with the
hosted control plane (`docs/contracts/hosted.md`); the two are different
physical databases with the same semantics.

- Identity is opaque. Findings and bug candidates carry opaque ids. Exact keys
  are lookup keys only, derived from trusted recorded context — scope, story,
  the coarse deterministic signal type, and a normalized locus built from route
  template, step locus, and status class. Model-authored text and the
  model-chosen category never enter a key. A candidate with no deterministic
  signal has no exact keys.
- Algorithms are versioned and frozen: `key-v1`, `locus-norm-v1`,
  `match-text-v1`, retrieval `shortlist-v1`. The reference spec is
  `tests/support/findings/spec.ts`; the core and hosted implementations are
  independently pinned to it byte for byte, so the same defect keys identically
  on both sides. Every stored row carries its algorithm versions so a bump can
  recompute.
- The scope id differs by deployment: the hosted `project_id`, the local
  ledger's `workspace_id`. Keys therefore never transfer between them; a
  local→hosted import recomputes.
- The recurrence semantics are shared: a strict-key recurrence appends
  evidence with no review, a resolved finding returns to work, a rejected
  finding absorbs matching evidence silently and counts the recurrence, a
  loose-key hit is a suggestion and never auto-appends or auto-merges, and
  merges leave tombstones that lookups follow. The lifecycles diverge in
  shape (2026-07-26): the hosted control plane collapsed bug candidates into
  findings — a machine-filed claim is a finding in state `new` (needs
  review), and there is no candidate object. The local ledger still models the
  intake stage as a candidate (`unassigned`/`assigned`/`dismissed`) ahead of
  findings (`new`/`accepted`/`rejected`/`resolved`/`reopened`); mirroring the
  collapse locally is the listed follow-up. A dismissed local candidate's
  exact recurrence is absorbed and counted, matching the hosted rejected-`new`
  behavior.
- Auto-resolve is hosted-only (2026-07-26): the control plane retires a
  finding when a newer run on every affected (suite, environment, case)
  disproves it — same gate check passing, recomputed anomaly signal absent
  under locus coverage, or (for key-less findings) a suggestion on an
  outright pass — with recurrence destinations split by confirmation
  (confirmed → `reopened`, unconfirmed → `new`). The local ledger has no
  resolution stamps and its resolved findings always reopen on recurrence;
  mirroring auto-resolve locally joins the collapse-mirror follow-up above.
- Evidence is append-only references to runs and steps. The engine never copies
  artifact bytes into a findings database, and no findings operation modifies a
  run directory.
- Model output is always a proposal over supplied ids. Grouping is applied only
  after an explicit human confirmation.

`checkAssertion()` is a separate, at-most-six-turn verdict loop over the final
state and trajectory. It may fetch intermediate snapshots and returns
`{ pass, detail, tokens }`.

## Progress events

`runCase` emits guarded events:

```text
case_start   { mode, maxSteps, actorModel, graderModel, runDir }
env_ready    { base_url, managed }
phase        { phase: setup|observing|gate|finishing }
step_start   { step, summary }
step_result  { step, ok, error, settleMs, costSoFar, tokens }
heal_start   { failedStep, reason, kind, classification }
heal_resume  { resumedAtStep }
retry        { phase, step?, status, attempt, maxAttempts, waitMs }
grading      {}
gate_fail    { checks }
warn         { message }
case_end     { status, result }
```

`case_end` is emitted on every exit path, including infrastructure failure.

## Running multiple cases

`runAll()` uses one worker pool. External cases are serial by default; managed
cases default to `min(4, CPU count)`. `parallel` may be an integer, `true`, or:

```js
{ total, record }
```

`total` caps all workers. `record` separately caps cases currently driving an
actor, allowing baseline checks to use remaining slots. CLI overrides beat
suite defaults.

All output goes through a guarded reporter. `runAll` may write JUnit and
returns `{ exitCode, results }`. Gate failure produces exit 1. Infrastructure
produces exit 2 only when no gate failure occurred; exit 1 wins when both are
present. `explored` contributes success.

## Error boundary

- Authored configuration and user input failures are `DummyConfigError`.
- Runtime environment, hook, driver-startup, and assertion-gather failures
  become infrastructure results. Authored hook load, shape, and return
  validation may instead be `DummyConfigError`.
- Model transport or validation failures are `LlmError` and become the
  appropriate run failure at the runner boundary.
- User-visible errors use the first message line and never expose raw stacks,
  `MODULE_NOT_FOUND`, tokens, or credentials.
