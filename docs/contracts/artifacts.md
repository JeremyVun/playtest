# Artifact contracts

This file is authoritative for Playtest's persisted local formats, compatibility
pins, baseline files, and storage-provider behavior. Runtime production and
consumption of these formats are defined in [Engine contracts](engine.md);
commands and viewer routes are defined in
[Interface contracts](interfaces.md).

## Versions and comparability

The current constants are exported from `packages/core/src/trajectory.ts`:

```js
HARNESS_VERSION = "0.1.0"
STEP_SCHEMA_VERSION = 8
SNAPSHOT_FORMAT = "a11y-text-v6" // web default
SETTLE = {
  name: "settle-v1",
  dom_quiet_ms: 500,
  net_quiet_ms: 500,
  max_ms: 10000
}
```

`manifest.pins` records the behavior that determines whether two runs are
comparable. `packages/core/src/shared/movement.ts` is the executable source of truth for
the pin set:

```js
[
  "harness_version",
  "step_schema_version",
  "snapshot_format",
  "driver",
  "settle",
  "viewport",
  "actor_model",
  "grader_model",
  "headed",
  "vision"
]
```

All present pins must match. A pin missing from either manifest is a wildcard so
legacy runs remain comparable. `gateway` is recorded for diagnosis but excluded
because it may contain an ephemeral port. Rendering-only inputs such as
`device_scale_factor`, session inputs such as cookies or authentication labels,
mobile `preserve_session`, and the [artifact profile](#artifact-profiles) are
not comparability pins.

Prompt text is not versioned and does not determine run comparability. Every
incompatible step or envelope change bumps `STEP_SCHEMA_VERSION`. Every change
to what a snapshot serializer emits — which roles receive refs, ref numbering,
or line shape — bumps that driver's snapshot format pin: the pin is what lets
a replay distinguish "the app changed" from "we changed how we read the app"
(a stale-format baseline would otherwise drift on every page). A driver's
snapshot and settle descriptors are driver-owned pins:

| Driver | Snapshot format | Settle descriptor |
|---|---|---|
| `web` | `a11y-text-v6` | `settle-v1` |
| `mobile` | `ax-tree-v7` | `settle-mobile-v1` |
| `api` | `api-text-v4` | `settle-api-v1` |

## Step envelope

`trajectory.jsonl` contains one JSON object per line. Envelopes use this stable
shape; fields described as absent must be omitted rather than written as an
invented value.

```js
{
  step: 7,                          // 1-based
  schema_version: 8,
  ts: 1760000000000,                // epoch ms at action dispatch
  mode: "agent" | "act" | "error",

  agent: {                          // agent steps only
    thought: "...",
    action: { type: "click", ref: "e42" },
    expectation: "...",
    visual: "...",                  // optional; vision discovery runs
    raises: [
      {
        kind: "finding" | "confusion",
        note: "...",
        severity?: "info" | "minor" | "major"
      }
    ],
    confused: true,                 // legacy sugar for one confusion raise
    confused_reason: "..."
  },
  raises: [                         // normalized actor raises; omit when empty
    {
      kind: "finding" | "confusion",
      note: "...",
      severity?: "info" | "minor" | "major"
    }
  ],

  acted_from: 7,                    // acted steps only
  action: { type: "click", ref: "e42" },
  snapshot_text: "...",             // state-drift oracle for agent steps
  screenshot_hash: "...",           // web dHash when visual regression is on

  bindings: [{                      // API steps whose action carries {{name}}
    name: "id_1",
    from_step: 1,                   // the producer step, in this trajectory
    from: "$.id",                   // JSON path re-read on the fresh response
    into: ["path", "body.account_id"]
  }],
  expect: { status: 201 },          // API steps: the exact status observed

  resolution: {
    ref: "e42",
    locator: "role=button[name=\"Checkout\"]",
    bbox: { x: 612, y: 480, w: 120, h: 36 }
  },
  result: {
    ok: true,
    error: null,
    settle_ms: 480,
    url: "http://localhost:4173/"
  },
  perf: {
    input_to_paint_ms: 120,
    long_tasks_ms: 90,
    requests: 3,
    js_errors: 0,
    nav: { lcp_ms: 1100, cls: 0.01, ttfb_ms: 80 }
  },
  artifacts: {
    screenshot: "steps/007.png",
    mhtml: "steps/007.mhtml",        // web, debug profile only
    a11y: "steps/007.a11y.txt",
    pw_a11y: "steps/007.pw-a11y.txt", // web + mobile, debug profile only
    har_entries: [12, 13, 14]
  },
  network: {
    requests: [{
      method: "POST",
      url: "http://localhost:4173/api/todos",
      path: "/api/todos",
      status: 201,
      mime_type: "application/json",
      failed: false
    }]
  },
  axe: {
    violations: [{
      id,
      impact,
      help,
      help_url,
      wcag_tags,
      nodes: [{ target, html }]
    }],
    counts: { total: 3 }
  },
  console_errors: [{
    type: "console" | "pageerror",
    text: "..."
  }],
  observed: { "<assertion>": {} },  // final envelope only
  tokens: { in: 2100, out: 95, cache_read: 1840 },
  llm_retries: ["<validation error>"],  // only when the actor call retried
  confusion: {
    type: "action_failed" | "repeated_action" | "no_effect" |
          "self_reported" | "state_drift",
    note: "..."
  }
}
```

### Custom assertion evidence

When a custom assertion gathers, the runner adds its returned evidence to the
real final envelope as `observed.<assertion-directory-name>` and attempts to
rewrite that envelope's existing `trajectory.jsonl` line. It does not append a
synthetic step. An accepted baseline copies the persisted envelope unchanged.

Evidence intended to persist must be small and JSON-serializable. The gate
always receives the in-memory value; serialization or final-line rewrite
failure does not change the gate result and may leave the persisted envelope
without `observed`. Runs that inherit every custom verdict gather no evidence
and add no new `observed` value.

`resolution.locator` is an opaque durable string: a Playwright locator, an
Appium accessibility locator or predicate, or `"METHOD /path"` for an API
operation. The trajectory layer does not interpret it. Successful non-element
actions normally persist a resolution with `locator: null` and `bbox: null` so
they remain replayable. Terminal, error, and failed-execution envelopes may
omit `resolution`.

`result.url` retains its historical name across drivers. It contains a URL for
web, a screen or route identifier for mobile, and a path for API.

`perf` may be `null` on drivers that cannot measure it. `axe` is best-effort and
web-only; it contains at most 25 violations and its `counts.total` is the total
violation-node count. For an executed step it is captured after the following
snapshot, during the following model turn when model-driven; act replay joins
the scan before its next dispatch. Terminal `done`/`give_up` capture is inline.
Dynamic page timers can therefore change the scanned state within that measured
deferral window. Missing or rejected capture produces no `axe` field.

`console_errors` contains the messages captured in that step's window. The web
driver retains at most 50 structured messages for diagnosis while
`consoleErrors()` continues to count every observed error exactly.

`network.requests` contains exactly the six fields shown above. Timing, sizes,
headers, and bodies are excluded because accepted trajectories are committed as
baselines. A request pending at settle has `status: 0` even if the richer HAR
entry completes later. `artifacts.har_entries` remains for older consumers and
for slicing the HAR waterfall.

`snapshot_text` holds what the driver chooses to *persist*, which is not always
what it captured. Web and mobile persist the captured snapshot. The API driver
persists a **normalized response projection**: the head and operation lines
verbatim, the `Last response:` status line, and then

```text
Body shape (api-projection-v1):
{"id":"string","items":[{"name":"string"}],"paid":"boolean"}
```

Key structure and types, never values. Arrays keep their length, because a
missing list entry is behavioral drift. Object keys survive because they are
structure — which is why the acceptance leak scan reads projections, and why a
`redact.projection` path replaces its node with `"[redacted]"`. A non-JSON or
truncated body records only `(non-json body: N chars)`; an absent one records
`(no body)`. The marker line makes a projection self-identifying and projection
idempotent.

The case's match rules ([Engine contracts](engine.md#match-rules)) shape this
block and nothing else about the field. A `match.exclude` path replaces its node
with `"[excluded]"`, a `match.normalize` path replaces it with the rule's form
(`{"length":3}` for `length`, a sorted list for `sorted`), and a `match.compare`
path is the only way a literal value is committed here. Every one of them keeps
its key, so a renamed, added, or removed field always moves the projection. With
no rules declared the block is byte-identical to one produced before match rules
existed.

The raw response still reaches the actor, `steps/NNN.a11y.txt`, and `har.json`.
It is scrubbed of known secret values on the way
([Engine contracts](engine.md#secrets-and-redaction)).

`bindings` and `expect` are additive API-only fields introduced with step schema
8. `bindings` records the producer step and JSON path behind each `{{name}}` the
step's action carries, so every substitution cites its provenance; the field is
absent on steps that bind nothing. `expect.status` is the exact status the
request answered, the oracle for the step-scoped expectation
([Engine contracts](engine.md#act-and-heal)). Readers must tolerate the absence
of both: a baseline recorded before schema 8 carries neither and replays
unchanged. When a replay becomes the next baseline, `from_step` is rewritten to
the acting run's numbering, so a binding always cites a step in its own
trajectory.

`tokens` sums usage across every model call the step made. When the actor's
tool call failed schema validation and was retried, the optional `llm_retries`
array carries the validation error behind each extra call — so a step whose
input tokens are roughly a multiple of its prompt size is explained by the
envelope itself. A clean step has no `llm_retries` key (older baselines are
byte-identical).

`done` and `give_up` receive normal envelopes with no resolution, `result.ok:
true`, final-state artifacts, and an empty request list.

If the actor cannot produce a valid step, the final envelope has `mode:
"error"`, a top-level `error` string, `result.ok: false` with the same message,
and artifacts from the rejected snapshot. It has no `agent`, `resolution`, or
`tokens`. The run ends with `end_reason: "error"` and cannot pass or become a
baseline.

## Diagnostic and progress logs

`context.jsonl` exists only when actor turns occur. Its first line hoists the
stable system prompt and tool declaration:

```js
{ type: "header", ts, model, system, tools }
```

Each following line is:

```js
{ step, ts, model, messages }
```

`messages` contains the remaining model input for that turn and is written
before the request. Together with the header it reconstructs the wire context.
Inline base64 screenshots are replaced with
`"<inline screenshot elided — see steps/*.png>"`. The harness never reads this
file back and it does not affect comparability.

`events.jsonl` persists the guarded `runCase` progress stream:

```js
{ ts, type, caseId, ...payload }
```

A failed write or throwing event listener cannot fail the case. Event payloads
are defined under [Engine progress events](engine.md#progress-events).

## Artifact profiles

A case's `artifacts` key selects how much a run writes to disk. It is a
case-level key, inheritable from `playtest.yaml`, and it takes exactly two
values:

| Profile | What a run writes |
|---|---|
| `core` (default) | Everything the actor, the gate, the grader, and the viewer read: accessibility text (`steps/NNN.a11y.txt`, `final.a11y.txt`), step screenshots, the video and its captions, `har.json`, `trajectory.jsonl`, `manifest.json`, `events.jsonl`, `context.jsonl`, and the baseline/grade/drift files. |
| `debug` | `core` plus the browser-forensics extras: the Playwright trace (`trace.zip`), per-step and final MHTML, and the driver's native accessibility tree (`steps/NNN.pw-a11y.txt`). |

Every artifact only `debug` writes is one **nothing in the product reads back**:
the harness, the gate, the grader, and the viewer never open a trace or an
MHTML file, and the native tree feeds one optional side-by-side diff the viewer
hides when the artifact is absent. They exist for a human debugging a specific
run, and they dominate what a run costs — on a representative web run
`trace.zip` alone is about 70% of the bytes and its close-time flush is about
90% of `driver.close()`.

The profile is enforced at capture, not at cleanup: under `core` the tracing
session is never started and the MHTML and native-tree round-trips are never
issued. Consequences that are part of this contract:

- **Evidence is identical across profiles.** The snapshot text, refs, snapshot
  format pin, actions, resolutions, screenshots, perceptual hashes, HAR, gate
  results, and grade are byte-for-byte what they would have been. The profile
  changes what is written *beside* the evidence, never the evidence, so it is
  not a comparability pin and a `core` run and a `debug` run of the same case
  compare normally.
- **No envelope or manifest names a file that was not written.** A step
  envelope's `artifacts.mhtml` and `artifacts.pw_a11y` are omitted under `core`,
  and `manifest.artifacts.trace` is `null` for every run that recorded no trace
  — which now also covers the `api` and `mobile` drivers, neither of which ever
  had one.
- **`manifest.case.artifacts`** records the profile the run used, so a reader
  can distinguish "recorded under `core`" from "the trace was pruned later".

This is orthogonal to a bundle's retention `tier`
([Storage providers and run bundles](#storage-providers-and-run-bundles)):
a profile decides what a run records, a tier prunes a bundle that already
exists. The `core` *tier* is strictly smaller than the `core` *profile* — it
also drops screenshots, video, and HAR.

## Run directory

```text
runs/<run-id>/<case-id>/
  manifest.json
  trajectory.jsonl
  har.json
  trace.zip            # web, debug profile only
  grade.json
  drift-report.json
  baseline.jsonl
  context.jsonl
  events.jsonl
  video.mp4
  video.vtt
  clip.mp4
  clip.vtt
  final.a11y.txt
  final.mhtml          # web, debug profile only
  grade.error.json
  steps/
    NNN.png
    NNN.mhtml          # web, debug profile only
    NNN.a11y.txt
    NNN.pw-a11y.txt    # web + mobile, debug profile only
```

Run IDs use UTC `YYYY-MM-DDTHHmm-xxxx`, where `xxxx` is four hexadecimal
characters. Step filenames use three-digit, 1-based numbers.

`trajectory.jsonl` and `manifest.json` are the core portable record.
`baseline.jsonl` is a copy of the path acted from and exists only for act/heal
runs. `grade.json` exists only after grading. `drift-report.json` exists only
after an API heal ([Drift report](#drift-report)). `grade.error.json` exists only
when forced grade-tool validation fails and raw attempts are available. Driver
capabilities and the run's [artifact profile](#artifact-profiles) together
determine which step artifacts exist; a reader must treat every entry marked
above as conditional and degrade rather than fail when one is absent. Web step
artifacts capture what the actor saw before each action. `final.a11y.txt`
captures the DOM after the last action and is the authoritative terminal-state
evidence used by gates and grading; `final.mhtml` is its debug-profile forensic
companion and is read by nothing.

### Grade artifact

`packages/core/src/schemas/grade.schema.json` owns the exact model-authored shape.
`grade.json` contains its validated `score`, `completion`, `efficiency`,
`findings`, and `summary`, plus optional report answers. Each current grader
finding is:

```js
{
  severity: "info" | "minor" | "major",
  note: "...",
  step?: 7
}
```

These are run-local UX/quality observations, not durable cross-run finding
identities. `report` answers preserve each authored question and may cite
`evidence_steps`. After model validation the harness adds `model`, `graded_at`,
aggregate `tokens`, and, when web captures exist, the exact harness-computed
`a11y` summary.

Discovery grades may also carry an optional `bug_candidates` array — grounded,
typed claims that the application malfunctioned, kept separate from the UX/quality
`findings`. Each candidate is:

```js
{
  kind: "http_error" | "console_exception" | "expectation_violation" |
        "data_mismatch" | "no_effect" | "perf_regression" | "broken_navigation",
  severity: "info" | "minor" | "major",
  title: "...",
  expected: "...",           // behavior the story or contract implies
  observed: "...",           // what the recorded evidence showed
  evidence_steps: [8, 9],    // ≥1 cited step; every candidate cites recorded steps
  signals?: ["http_5xx"]     // deterministic anomaly types it rests on; may be []
}
```

The field is optional and backward-compatible: it is absent on journey grades,
on any discovery grade that found no malfunction, and on every `grade.json`
written before it existed. `kind` is a broad comparison label, not identity — the
same defect may be labeled differently across runs. The grader assigns no durable
id and no exact key: the deterministic `signal_type` and normalized locus that
key cross-run recurrence (DESIGN D4) are derived later, server-side, from trusted
recorded context, never from this model-authored output. Promotion of a candidate
to a durable platform finding is a hosted concern in a later phase; a candidate in
`grade.json` is a potential defect for review, not a platform finding.

Readers must tolerate optional fields being absent. Adding a new persisted
grader output requires a compatible schema and reader change; model-generated
ids or prose are never implicitly durable platform identity.

`har.json` is:

```js
{
  log: {
    entries: [{
      startedDateTime,
      time,
      request: { method, url, headers, body },
      response: { status, bodySize, mimeType, headers, body },
      _failed: false
    }]
  }
}
```

Response bodies are captured for non-HTML `text/*`, JSON, XML, JavaScript, and
form-urlencoded content types, capped at 64 KB, and not read when
`content-length` exceeds 1 MB. Request bodies are capped. The HAR is the source
for response-body assertions and deep diagnosis. It may not exist when the run
recorded no requests. Before custom assertions gather, the runner forces the
driver to write every HAR entry recorded so far; asynchronous response-body
capture that completes later lands in a subsequent flush.
Known secret values are scrubbed from `har.json` at write time. The file is
nevertheless sensitive and untracked: it still contains session cookies,
server-issued tokens core cannot recognize, and application data.

A committed baseline carries neither raw response bodies nor injected
credentials, but — for the API driver — it does carry request headers and
bodies, as the redacted request program described under
[Baseline files](#baseline-files). The older blanket rule ("baselines never
include headers or bodies") could not be honored by a driver whose action *is* a
request: stripping the payload would destroy creates, idempotency keys, and
conditional headers, and acting the baseline would stop working. Web and mobile
envelopes still carry no headers or bodies, because their actions do not have
any.

New runs do not record a live screencast. The runner always attempts to write
`video.vtt`; when ffmpeg is available it builds a paced slideshow from step
stills as `video.mp4`. `manifest.artifacts.video` remains `null` when the build
cannot run. A non-null `manifest.video_started_at` identifies a legacy
wall-clock `video.webm`, which consumers must continue to support.

## Manifest

`manifest.json` is the viewer entry point:

```js
{
  schema_version: 1,
  run_id,
  case: {
    id,
    file,
    story,
    description,
    mode: "journey" | "discovery",
    persona,
    persona_description?,
    tags,
    success,
    observe?,
    perf,
    report,
    redact?,
    secrets?: ["NAME"],
    vision,
    visual_regression,
    visual_regression_drift,
    artifacts: "core" | "debug",
    limits
  },
  mode: "record" | "act" | "heal" | "explore",
  started_at,
  finished_at,
  duration_ms,
  video_started_at,
  pins: {
    harness_version,
    actor_model,
    grader_model,
    step_schema_version: 7,
    snapshot_format,
    driver: "web" | "mobile" | "api",
    settle,
    viewport,
    gateway,
    headed,
    vision
  },
  env: {
    base_url,
    managed: false,
    driver: "web" | "mobile" | "api",
    env_name?,
    cookies?,
    auth?
  },
  result: {
    status: "pass" | "fail" | "infra" | "explored" | "interrupted",
    end_reason: "done" | "give_up" | "max_steps" | "timeout" |
                "stuck" | "error",
    error: "first line" | null,
    gate: {
      pass: true,
      hardPass?: boolean,
      checks: [{
        kind,
        severity: "hard" | "soft",
        spec,
        label?,
        pass,
        applicable: boolean,
        detail,
        steps?: [number],
        inherited?: true,
        errors?: [{ type: "console" | "pageerror", text }]
      }],
      advisory?: [{
        kind: "invariant",
        severity: "advisory",
        spec,
        label?,
        pass,
        applicable: boolean,
        detail,
        steps?: [number]
      }]
    } | null
  },
  heal: {
    from_step,
    kind: "drift" | "action_failed",
    reason,
    segments: [{ from, to: number | null }],
    agent_steps,
    classification?: "regression" | "contract_drift" | "baseline_drift",
    signals?: [{ kind, detail }],
    accepted?: boolean,
    rejected_reason?: string
  },
  totals: {
    steps,
    executed_steps,
    tokens: { in, out, cache_read },
    cost_usd,
    console_errors,
    confusion_events,
    finding_events,
    bug_candidates,
    lcp_ms
  },
  setup: {
    ran: true,
    returned_context: false,
    duration_ms
  },
  healed: false,
  baseline_scan: {
    blocked: true,
    findings: [{ rule, step, field, detail }]
  },
  baseline: {
    run_id,
    accepted_at
  } | null,
  artifacts: {
    trajectory: "trajectory.jsonl",
    har: "har.json",
    video: "video.mp4" | "video.webm" | null,
    trace: "trace.zip" | null,
    grade: "grade.json" | null,
    context: "context.jsonl" | null,
    baseline_copy: "baseline.jsonl" | null,
    drift_report: "drift-report.json" | null
  }
}
```

`case.mode` describes the authored case kind. `mode` describes the execution
strategy. Discovery uses `case.mode: "discovery"` and execution mode
`"explore"`.

`case.artifacts` records the [artifact profile](#artifact-profiles) the run used.
`artifacts.trace` names `trace.zip` only when a `web` run recorded under the
`debug` profile, and is `null` otherwise — including for every `api` and
`mobile` run, which never produce one.

`case.redact` and `case.secrets` appear only when the case declares them, and
carry redaction paths and secret *names* — never a resolved value. They let a
later `playtest baseline accept`, in a different process, scan the run by the
same rules the run itself used. `baseline_scan` appears only when the leak scan
refused an automatic acceptance.

`result.gate` is `null` for discovery. `result.status: "explored"` means a
discovery ended through `done`, `give_up`, `max_steps`, `timeout`, or `stuck`;
an actor or infrastructure error remains `infra`.

`totals.bug_candidates` is a projection of the count of typed bug candidates the
discovery grader emitted (see the grade artifact). It is present only after a
discovery grade with at least one candidate; readers treat its absence as zero.

The runner writes an `interrupted` placeholder manifest as soon as the run
directory exists and refreshes it during `SIGINT` handling. A completed final
manifest replaces it. Interrupted placeholders and infrastructure results may
have an empty failing gate without `hardPass`; this keeps partial runs visible
without inventing a hard-gate verdict.

`env_name`, cookies, and auth are recorded only when declared. They are
informational session inputs, not comparability pins.

`setup` exists only when a `before_each` hook ran. `heal` exists only after an
act replay escalated to healing. `baseline` identifies the accepted path used
for act mode.

`case.observe` and `gate.advisory` appear only when the case declares advisory
invariant policies. Every gate check carries `applicable`; it is false only for
an invariant policy the recorded trace never exercised, and a check from before
the field existed is read as applicable. `steps` appears only on an invariant
violation and cites the steps whose actions produced the offending requests,
resolved through `artifacts.har_entries`; it is absent when the check passes or
when no step owns the request. `heal.classification`, `heal.signals`,
`heal.accepted`, and `heal.rejected_reason` appear once heal triage has run
(API heals). `heal.from_step`, `heal.kind`, and `heal.reason` describe the
first divergence; `heal.segments` records every heal segment as `{ from, to }`
— `from` the baseline step that escalated, `to` the baseline step where
deterministic replay re-anchored (`null` when that segment ran to the end;
[Act and heal](engine.md#act-and-heal)) — and `heal.agent_steps` counts
agent-mode envelopes across segments. An api heal is always a single
`{ from, to: null }` segment.

## Drift report

An API heal writes `drift-report.json` beside the run and points
`artifacts.drift_report` at it. It is the artifact a reviewer reads before
accepting or rejecting a changed journey.

```js
{
  schema_version: 1,
  run_id,
  case_id,
  mode: "heal",
  classification: "regression" | "contract_drift" | "baseline_drift",
  signals: [{ kind, detail }],
  failed_step: {
    baseline_step,
    action,
    kind: "drift" | "action_failed",
    reason,
    expected_status,
    observed_status,
    provisioning: boolean
  },
  healed_run: {
    end_reason,
    gate: { pass, checks: [{ spec, severity, pass, applicable, detail }] } | null,
    accepted: boolean,
    rejected_reason: string | null
  },
  narrative: { what_changed, why_valid, consumer_impact } | null,
  narrated_by: "<grader model>" | null
}
```

Everything except `narrative` is computed by the harness from recorded evidence.
The narrative is the only model-authored part, is written by the grader model
when one is configured, and is read back by nothing: it cannot change the
classification, the gate, the run's status, or the exit code
([Act and heal](engine.md#act-and-heal)). A run with no model configured produces
the same report with `narrative: null`.

The report is written whether or not the heal was accepted — a refused heal is
exactly when a human most needs to see why. It rides in the `core` bundle tier.

## Script artifact bundle

A script suite's trajectory is a new artifact family, not a step-envelope
retrofit: the authored program, its execution HAR, and its structured report.
[Script contracts](scripts.md) own the shapes; this section owns the persisted
layout and how the pieces relate.

```text
<script-run-dir>/
  har.json             HAR 1.2, sensitive, untracked
  script-report.json   packages/core/src/schemas/script-report.schema.json
```

One execution writes exactly those two files plus an exit status; nothing else.
The script itself is a plain ESM file owned by the suite (locally a file in the
repository, hosted a versioned blob), and its sha256 — the same fingerprint the
leak scan returns — is recorded in the report as `script.sha256`. That
fingerprint is what an approval covers, so any edit invalidates it.

`har.json` here is **HAR 1.2** (`log.version`, `log.creator`, `headers` as
name/value pairs, `postData.text`, `response.content.text`), not the reduced
shape the web and API drivers write to a run directory's `har.json`. It is a
script's evidence column and is consumed by offline oracles and ordinary HAR
tooling. Readers that accept both shapes keep working; a reader that assumes the
reduced shape must not be pointed at a script HAR.

An **authored** suite ships those two files inside a versioned bundle, together
with the program, the authoring transcript, and the handout it was authored from
— the four things N1 calls the API trajectory, plus what makes them
reproducible:

```text
<bundle>/
  bundle.json               authoring_bundle_version, a sha256 per file, verdict, findings
  suite.mjs                 the authored module
  authoring-transcript.json every turn, revision, objection, and what was spent
  har.json                  the final execution's traffic
  script-report.json        the final execution's report
  handout/                  BRIEF.md · CLIENT.md · INVARIANTS.md · obligations.json ·
                            openapi.json · handout-manifest.json
```

Replay reads the spec and the obligation manifest out of the bundle's own
handout, and refuses a bundle whose files no longer hash to its manifest
([Script contracts: the authoring bundle](scripts.md#the-authoring-bundle)).

Report-to-HAR linkage is by **entry index**: `checks[].evidence.har_entries` and
`gate.checks[].har_entries` are indices into `log.entries` of the sibling
`har.json`. The runner drops a citation that does not resolve and raises it as a
defect, so a persisted report never carries a dangling index at write time.

Retention treats the HAR as a sensitive payload and the report as durable
evidence. After the HAR expires or is deleted, the report still carries each
check's obligation trace, its expected/observed strings, and the cited entry
metadata; raw request and response bodies are gone, and evidence citations
render as unresolvable rather than as if the payload were still present
([Script contracts: HAR lifecycle](scripts.md#har-lifecycle)).

### Script versions and approval records

The bundle is content; a **version** is that content's place in a lifecycle
(`DESIGN` N9, [Script contracts: approval
lifecycle](scripts.md#approval-lifecycle)). Every version is one immutable
record of bytes:

```js
{
  lifecycle_version: 1,
  number, parent,                      // 1, 2, 3 … and what it was edited from
  origin: "authored" | "edit" | "revision",
  state: "pending" | "approved" | "rejected",
  fingerprint,                         // sha256 of exactly the script's bytes
  bytes, created_at, authored_by, note,
  approval: {
    state, fingerprint,                // the sha256 the reviewer had on screen
    approver, at, review, reason?      // review = the reference the decision cites
  } | null
}
```

`fingerprint` is the same value three other places already carry: the leak
scan's return, the report's `script.sha256`, and the bundle manifest's
`script.sha256`. It is what an approval covers, which is why any edit produces a
new pending version rather than mutating one — a version number never changes
meaning, and `approval.fingerprint !== fingerprint` is the persisted shape of
"this was approved and has since moved".

A **pending revision** is an ordinary version with `origin: "revision"`, carrying
its drift report as the evidence for the change it proposes. It is never
executed against the target on the strength of being proposed
([Hosted: Drift as a revision](hosted.md#drift-as-a-revision)).

### Script drift report

A red replay writes `drift-report.json` beside its `har.json` and
`script-report.json`. It is the same artifact family as the heal drift report
above and the same discipline — everything except `narrative` is computed from
recorded evidence — with a different `mode` and a script's evidence instead of a
journey's:

```js
{
  schema_version: 1,
  mode: "script_replay",
  run_id, suite, script, version,
  classification: "regression" | "contract_drift",
  signals: [{ kind, detail }],
  spec_diff: {                          // what moved in the OpenAPI surface
    changed, operations_added, operations_removed,
    operations_changed: [{ operation, statuses_added, statuses_removed,
                           fields_renamed: [{ from, to }],
                           fields_removed, fields_added }],
    touched
  },
  failing: { checks, gate, explained, unexplained },
  replay: { … } | null,
  revision: { proposed, reason },
  narrative: { what_changed, why_valid, consumer_impact } | null,
  narrated_by
}
```

`revision.proposed` is `false` for every regression, with the reason stated in
the artifact rather than left to a reader: revising a suite that caught a real
break would delete the evidence. The narrative is advisory and is read back by
nothing — not the classification, not the gate, not the verdict, not whether a
revision is offered.

## Baseline files

The suite root is the nearest ancestor containing `playtest.yaml`. Baselines
mirror the case path under `<suite>/results/`, removing only the leftmost
structural `stories/` segment. A deeper directory named `stories` remains part
of the path, avoiding collisions:

```text
<suite>/stories/foo.yaml
<suite>/results/foo.baseline.jsonl
<suite>/results/foo.baseline.json
```

The JSONL file is a verbatim accepted trajectory. Its metadata is:

```js
{
  accepted_at,
  run_id,
  run_dir,
  healed_from_run_id: string | null,
  pins,
  story_hash,
  base_url: string | null,
  verdicts: [{ spec, pass, detail }],
  candidate: true,                              // pending candidates only
  scan: { findings: [{ rule, step, field, detail }] },
  scan_approved: { fingerprint, at, findings }
}
```

`story_hash` fingerprints the actor inputs—story and persona—and forces a
record when either changes. `pins.snapshot_format` fingerprints the serializer:
when it differs from the running driver's format the baseline is unreadable
(every page would drift) and the case re-records; a baseline with no recorded
format is a wildcard and replays. `base_url` lets drift comparison normalize
origins.
`verdicts` lets a clean act replay reuse gate kinds declared inheritable by the
engine. Missing fields retain legacy wildcard or live-evaluation behavior.

`scan` states why a candidate is pending rather than accepted. `scan_approved`
records an explicit human approval and the SHA-256 of exactly the trajectory
bytes approved; a later trajectory that hashes differently is gated again.
Neither field appears when the acceptance leak scan found nothing.

Healing writes `<case>.healed.jsonl` and `<case>.healed.json` with the same
shape plus `candidate: true`. A recording the leak scan flagged writes the same
pair, so both kinds of pending work are reviewed and accepted the same way.
Accepting promotes the candidate atomically to the baseline names. Rejecting
removes only the candidate; run artifacts remain. `run_dir` is the authoritative
candidate identity. `run_id` is a fallback for legacy metadata without `run_dir`.

### Redacted request programs

An accepted API trajectory is a request program that must still run on a fresh
clone, so its recorded actions keep their headers and bodies — as templates:

- Non-secret values stay literal, so creates, idempotency keys, and conditional
  headers replay exactly as recorded.
- A value core injected from a secret reference persists as that reference,
  `{ $secret: "NAME" }`, and is resolved again at act time.
- A field named by `redact.request` persists as the `{ $secret: … }` placeholder
  its entry declares, and is resolved the same way.
- A value an earlier response in the same run produced persists as the
  substitution token `{{name}}`, with the envelope's `bindings` recording the
  producer step and path it is re-read from
  ([Engine contracts](engine.md#bindings)). This is what makes the program run
  against a *fresh* instance whose identifiers differ.

Standing `app.headers` never enter a recorded action at all; they are
configuration, re-applied on every request. Acting therefore needs only the
committed case files, the baseline pair, and the secret values in the
environment — never the original run directory.

Legacy baselines predating this format carry raw values and no templates; they
replay unchanged.

The accepted baseline pair is also the sole input to the one-way Playwright
export ([Interface contracts](interfaces.md#playwright-export)), which reads
`<case>.baseline.jsonl` for the action track and `<case>.baseline.json` for the
run id, acceptance timestamp, `story_hash`, and pins printed in the generated
header. The export is unversioned and derived: nothing reads it back, so it
never constrains this format — but a change to the baseline pair must keep the
generator building.

## Trajectory projections

`actionTrack(envelopes)` is computed rather than stored. It includes envelopes
with a resolution and successful result, excluding `done` and `give_up`.

`diffTracks(a, b)` computes an LCS over:

```text
action.type | resolution.locator-or-action.url |
action.text-or-action.value | action.direction
```

It returns:

```js
{
  ops: [{ op: "same" | "del" | "add", a: envelope | null, b: envelope | null }],
  summary: { same, del, add }
}
```

The hosted review summary and browser viewer must use the same signature.

## Storage providers and run bundles

Run consumers use the `StorageProvider` seam:

```js
{
  listDir(rel),
  readText(rel),
  stat(rel),
  createReadStream(rel, opts)
}
```

`LocalFsProvider` reads directories. `BundleProvider` reads `.ptrun` bundles.
Viewer JSON routes and `/run/*` file reads must go through the selected
provider rather than reaching directly into the filesystem.

### `.ptrun` format

A `.ptrun` is a deterministic ZIP serialization of one run directory. It is
seekable without extraction, content-addressed, and rewritable from the `full`
artifact tier to the smaller `core` tier.

Entry names are the run-relative paths defined under [Run
directory](#run-directory). They use forward slashes, have no leading `./`, and
contain no directory entries or symlinks. An entry cannot be absolute, contain
an empty or `.` segment, escape through `..`, or use the reserved name
`ptrun.json`.

`ptrun.json` is always the first entry and is stored without compression:

```js
{
  ptrun_version: 1,
  run_id: "string" | null,
  case_id: "string" | null,
  created_at: "ISO-8601",
  tier: "full" | "core",
  entries: [{
    path: "manifest.json",
    size: 123,
    crc32: "hex",
    sha256: "hex"
  }],
  totals: { count: 1, bytes: 123 },
  source: { harness_version: "string" }
}
```

`entries` describes every member except `ptrun.json`. `source` is
caller-supplied provenance; the default records `manifest.pins.harness_version`
when present. Rewrites preserve both retained entry bytes and source metadata.

Compression is determined by path, never chosen ad hoc:

| Entry | ZIP method |
|---|---|
| `ptrun.json`, video, clips, PNG screenshots, `trace.zip` | STORE |
| JSON, JSONL, text, VTT, MHTML | DEFLATE |
| Other entries | STORE |

Media remains STORE-compressed so HTTP Range requests can map directly to ZIP
byte ranges. Deflate uses a stable compression level. Writers sort entries by
path and zero ZIP timestamps; the same input tree produces the same bundle
bytes and SHA-256.

### Index sidecar

Writers create `<bundle>.idx.json`:

```js
{
  ptrun_version: 1,
  bundle_sha256: "hex",
  bundle_size: 123,
  entries: {
    "video.mp4": {
      method: 0,
      offset: 123,
      csize: 456,
      usize: 456,
      crc32: "hex"
    }
  }
}
```

The sidecar is a rebuildable cache, not a source of truth. A reader uses it only
when its version, size, and bundle hash match. Otherwise the reader rebuilds it
from the ZIP central directory. Readers reject encrypted entries and
compression methods other than STORE and DEFLATE.

`BundleProvider` lists and reads entries through byte ranges. Range reads on
STORE entries map to the underlying bundle range; DEFLATE entries are inflated
before serving. `playtest view <bundle>.ptrun` must provide the same single-run
viewer behavior as an unpacked run directory, including media Range requests.

### Writing and retention rewrites

The writer runs only after core finishes all post-execution work and closes
artifact writers. Hosted runners upload the bundle and sidecar, report their
size and SHA-256, and treat local copies as disposable.

Hosted metadata stores an artifact key, byte size, SHA-256, tier, and
verification time. The `.ptrun` bytes remain in the configured object store;
they are not database BLOBs. The bundle is therefore recoverable and verifiable
independently of metadata projections, and object-store range access remains
available to `BundleProvider`.

Bundles are sealed. Clips and other post-hoc outputs are sibling artifacts
rather than in-place mutations.

A retention rewrite copies only selected entries into a new deterministic
bundle. The `core` **tier** here is a retention filter over a finished bundle
and is unrelated to — and strictly smaller than — the `core`
[artifact profile](#artifact-profiles) a run records under. It retains at
least:

```text
manifest.json
trajectory.jsonl
grade.json
video.vtt
steps/*.a11y.txt
```

Optional absent entries remain absent. A rewrite produces a new hash and
sidecar; consumers never treat it as the same immutable object.

Bundle parsing and writing are buffered and guarded by safe-integer and upload
limits. ZIP64 metadata may be read where supported, but the format does not
promise arbitrarily large streaming writes.

## Local findings export

The local findings ledger (`<suite>/.playtest/findings.db`,
interfaces.md#local-findings-ledger) is **not** a portable artifact. It is local
state: gitignored, machine-specific, and scoped to an opaque workspace id. It is
not part of a suite, a run directory, or a `.ptrun` bundle, and no tool reads
another machine's ledger file.

The portable form is the document written by `playtest findings export`:

```js
{
  format: "playtest.findings.export",
  format_version: 1,
  exported_at: "2026-07-25T06:38:19.731Z",
  workspace: { id: "<opaque ulid>", suite_root: "/abs/path" },
  algorithms: {
    key_algo_version: "key-v1",
    locus_norm_version: "locus-norm-v1",
    match_text_version: "match-text-v1"
  },
  key_scope: { note: "..." },
  findings: [{
    id, source_id, title, summary, severity, state, reject_reason, merged_into,
    first_seen, last_seen, evidence_count,
    evidence: [{ run_id, run_dir, case_id, step_from, step_to, excerpt, source }],
    transitions: [{ from_state, to_state, reason, note, actor, created_at }]
  }],
  candidates: [{
    id, source_id, category, claim, status, signal_type, locus, normalized_locus,
    strict_key, loose_key, key_algo_version, locus_norm_version, match_text,
    match_text_version, finding_id, suggested_finding_id, dismiss_reason,
    recurrence_count, evidence: [...]
  }],
  merges: [{ from_finding_id, into_finding_id, actor, created_at }],
  suppressions: [{ scope, key, key_algo_version, candidate_id, reason, absorbed_count }]
}
```

Rules a consumer, including a future hosted importer, must obey:

- Evidence is references only — run id, run directory, case id, and step
  numbers. No artifact bytes, `grade.json` copies, screenshots, or HAR content
  cross this boundary; run bundles remain the evidence.
- `strict_key` and `loose_key` are scoped to `workspace.id` and are **not**
  transferable. An importer recomputes them under its own project scope from
  `signal_type`, `locus`, and `story_id`, using the stated algorithm versions.
- Records correlate by opaque provenance (`workspace.id` plus `source_id`),
  never by mutable `title`. Two records are the same defect only when their
  recomputed keys or an explicit human decision say so.
- Readers tolerate absent optional fields. `format_version` is bumped for any
  incompatible change; a reader that does not recognize the version refuses the
  document rather than guessing.

Import is deliberately not implemented: this contract exists so hosted
interoperability is built against a frozen format rather than a live database.

## Compatibility rules

- Readers degrade when optional artifacts are absent.
- Legacy manifests with missing pins use wildcard comparison.
- `artifacts.har_entries` remains readable even though envelopes embed a stable
  request subset.
- Legacy `video.webm` uses `video_started_at` wall-clock mapping; slideshow
  `video.mp4` uses the shared frame timeline.
- Candidate identity falls back from `run_dir` to `run_id` only for old
  metadata.
- Driver-specific fields stay absent outside their owning driver.
- Additive envelope fields are optional: a baseline without `bindings` or
  `expect` replays exactly as it did before step schema 8, with no substitution
  and no step-scoped status comparison.
- `.ptrun` sidecars may be missing or stale and must be rebuildable from the
  bundle.
- A `full` or `core` bundle is a faithful serialization of its retained run
  paths; unpacking it yields files the viewer can consume directly.
- Changing any persisted field or compatibility rule requires updating this
  file, the relevant schema when one exists, and its readers in the same
  change.
