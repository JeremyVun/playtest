# Script contracts

Owns the executable API test suite: the script entry contract, the injected
client, the check report, runner semantics, the coverage-obligation manifest,
the two-column verdict, the mechanical risk profile, the leak scan, the HAR
lifecycle, and the trust boundaries each guarantee rests on.

A script is a plain Node ESM module a human can read, edit, and export. It runs
in its own process against one authorized target, records everything it does,
and produces a report a reviewer and a gate both consume. The design rationale
lives in `docs/backlog/api-testing/DESIGN.md`; this file specifies the behavior
implementations and consumers may rely on.

## Versions

Six independent version numbers. The first three are carried in every report;
the last three belong to the authoring path and are carried in the handout
manifest, the transcript, and the bundle manifest.

| Version | Covers | Current |
|---|---|---|
| `contract_version` | the entry contract, the client API, and the check API | 1 |
| `script_report_version` | the persisted report shape (`src/core/schemas/script-report.schema.json`) | 1 |
| `manifest_version` | the coverage-obligation manifest shape | 1 |
| `handout_version` | the handout's file set, manifest, and maintained assets ([The handout](#the-handout)) | 2 |
| `authoring_transcript_version` | the persisted transcript ([The authoring loop](#the-authoring-loop)) | 1 |
| `authoring_bundle_version` | the bundle layout ([The authoring bundle](#the-authoring-bundle)) | 1 |
| `lifecycle_version` | the version and approval record ([Approval lifecycle](#approval-lifecycle)) | 1 |

A change that would make an existing script stop running, or make an existing
reader misread a report, bumps the owning version in the same change as the
behavior. Adding an optional field to the report, or a new record kind a reader
may ignore, does not.

## The entry contract

A script is one ESM module whose default export is an async function:

```js
export default async function ({ client, check, params }) {
  const created = await client.post("/accounts", { body: { owner: "ada" } });
  check({
    id: "new-account-is-pending",
    obligation: "rule:lifecycle",
    title: 'a new account is created in status "pending"',
    pass: created.json?.status === "pending",
    expected: 'status "pending"',
    observed: `status ${JSON.stringify(created.json?.status)}`,
    evidence: { requests: [created.ref] },
  });
}
```

- The module receives nothing else. There is no ambient network, no
  environment, no filesystem, and no dependency: `client` is the only way out
  of the process ([The script process](#the-script-process)).
- `params` is a frozen JSON object from run configuration. It never carries a
  secret reference; a run that puts one there is a configuration error.
- The return value is ignored. A rejection is a **script defect**, not a check
  failure ([The check channel](#the-check-channel)).
- A module with no default-exported function is a `contract_violation` defect —
  the run fails, and it fails as the script's fault, not the API's.
- A script may import sibling modules inside its own directory (the script
  root) and the permitted built-ins listed under
  [The script process](#the-script-process). Nothing else resolves.

## The client

`client` is base-URL-bound. Every method returns a frozen response record; a
transport failure is a record with `transportError` set and `status: 0`, not a
throw, because "the API did not answer" is an observation a check may want to
make.

```
client.request(method, path, options)   options: { body, rawBody, headers, contentType }
client.get|head|post|put|patch|delete(path, options)
client.secret(NAME)      → { $secret: NAME }, a header value the proxy substitutes
client.baseUrl           the resolved target base URL
client.mode              "read-only" | "read-write" — set by run configuration
client.budget            { limit, used, remaining }
client.secretNames       the NAMES this run declared; values are unavailable
client.namespace         this run's namespace ([Test-data lifecycle](#test-data-lifecycle))
client.name(label)       `label-<namespace>`
```

**A path is a path.** A specifier with an explicit scheme (`https://…`) is an
absolute URL and faces the origin guard. Anything else is appended to the base
URL rather than resolved against it, so `//elsewhere/x` is a double-slashed path
on the target — not a protocol-relative jump to another host — and a suite
probing hostile paths still probes the target it was pointed at.

Response record: `{ ref, method, url, path, status, statusText, headers, text,
json, parseError, ok, timeMs, transportError }`. **`ref` is the HAR entry index**
and the only evidence handle a script ever holds: a report cites
`evidence: { requests: [ref] }`, and the runner verifies every citation resolves.

Four guards refuse a request. Each throws `ScriptClientRefused` (a script asking
for something it may not do is a script bug), and each is enforced again on the
wire by the proxy, which is the authority:

| Guard | Rule |
|---|---|
| origin | the resolved origin must be `base_url`'s origin or an entry in the run's `allowed_origins`. The same P0 egress semantics as the API driver ([Engine: API driver](engine.md#api-driver)): entries are bare http(s) origins, a different port or scheme is a different origin, and non-http(s) resolutions have no admissible origin. |
| mode | in `read-only`, only `GET` and `HEAD` are forwarded. |
| budget | past `budget.limit` nothing is forwarded and nothing is recorded, so the recorded trace **is** the budget. Exhaustion throws `BudgetExhausted` and is a defect. |
| secrets | `{ $secret: NAME }` resolves only for a NAME the run declared, and only on a request to the target's own origin. A credential is bound to the target, not to the run, so an allow-listed auxiliary origin is reachable and receives no credential — the allowlist can never become an exfiltration channel. |

A refused request performs **no network I/O and produces no HAR entry**. It is
recorded as a guard event, which appears in the report's `guard` list, as a
`guard_refusal` (or `budget_exhausted`) defect, and in the risk profile as an
out-of-origin attempt or a refused mutation.

**Secret injection.** A secret reference is legal in a header value only. The
proxy resolves it against the shipped secret machinery
([Engine: Secrets and redaction](engine.md#secrets-and-redaction)) —
`PLAYTEST_SECRET_<NAME>` or the registered provider — sends the real value
upstream, and records the placeholder `[secret:NAME]` instead. Known secret
values are also scrubbed out of every response **before it crosses back into the
script process**, so a target that echoes its own `Authorization` header
discloses nothing to the script. The script can cause an authenticated request;
it can never read the credential.

**Mode is authorization, never code.** `client.mode` is derived from
`target.write_grant` in run configuration — the recorded answer to "safe to write
test data to this environment?" (`DESIGN.md` §4 step 2). Targets are read-only
until that grant exists, the grant must name the same origin the run resolves,
and nothing a script does can widen it.

## The check channel

`check` is synchronous and records five kinds of entry. The separation is
load-bearing: soundness depends on telling a broken API from a broken script.

| Call | Meaning |
|---|---|
| `check({ id, obligation, title, pass, expected, observed, note, evidence, exercised })` | a verdict about the API. `id`, `obligation`, and a boolean `pass` are required. |
| `check.skip({ obligation, reason })` | this obligation was deliberately not covered. Counts only when `reason` matches one of the obligation's `approved_skip_reasons`. |
| `check.unsupported({ obligation, reason })` | this obligation cannot be expressed on this substrate. Same approved-reason rule. |
| `check.defect({ message, detail, evidence })` | the **script** could not do its job — it could not build the state a check needed. Never a statement about the API. |
| `check.advisory({ title, detail, evidence })` | an observation that gates nothing. |

A malformed call throws (a missing `id`, a non-boolean `pass`, an evidence entry
that is not a response ref), which surfaces as a script defect rather than a
silently dropped check. A check `id` identifies one verdict and must be unique
within a report: a second check under the same id is a `duplicate_check_id`
defect, because an ambiguous id makes the obligation trace and the review screen
wrong.

Records are buffered and streamed to the parent piggybacked on the next request,
and in full when the script finishes. The parent requires the final report to
**extend** the streamed prefix: a differing record is a `report_contradiction`
defect. A script may narrate more, never re-narrate.

## Runner semantics

One execution is one subprocess with one timeout and **exactly three outputs**:

| Output | Notes |
|---|---|
| `har.json` | the recorded traffic. Run-local, sensitive, untracked ([HAR lifecycle](#har-lifecycle)). |
| `script-report.json` | the report ([Report schema](#report-schema)). |
| exit status | `0` pass · `1` a sound suite with a failing column · `2` unsound. |

Nothing else is written. The risk profile is derived on demand from the script
text and the HAR; it is returned by the runner API and not persisted by it.

- **Timeout.** The child is killed at `timeout_ms` (`SIGTERM`, then `SIGKILL`).
  A killed run keeps the HAR flushed so far and reports a `timeout` defect.
- **Configuration and user input** fail as `DummyConfigError`
  (`src/core/config.ts`) with an actionable message and no stack: a missing
  script, a non-http(s) `base_url`, a malformed `allowed_origins` entry, a write
  grant for a different origin, a secret name that is not a
  `PLAYTEST_SECRET_<NAME>` tail, a malformed policy declaration, a duplicate
  obligation id, an empty obligation manifest, params carrying a secret
  reference, or a script whose text contains a credential literal
  ([Leak scan](#leak-scan)).
- **The script process never writes an artifact.** The HAR is recorded by the
  parent as each exchange completes, and the report is assembled by the parent
  from records the script streamed plus columns the parent computed.

### Defect kinds

`script_reported`, `threw`, `unhandled_rejection`, `uncaught_exception`,
`load_failed`, `contract_violation`, `timeout`, `budget_exhausted`,
`guard_refusal`, `evidence_unresolvable`, `unknown_obligation`,
`report_contradiction`, `no_report`, `harness`. Any defect makes the execution
unsound, and no defect can be reported as a check outcome — the channels are
separate all the way to the report.

## Coverage-obligation manifest

Authoring terminates on soundness, and soundness includes sufficiency (`DESIGN`
N5). The manifest is the mechanism, and it is derived **mechanically** — no model
and no script input:

| Source | Obligation id | Derived from |
|---|---|---|
| `policy` | `policy:<policy spec>` | each declared Level 0 invariant policy |
| `operation` | `operation:<METHOD> <path>` | each operation in the resolved OpenAPI document |
| `rule` | `rule:<id>` | each approved rule statement × its applicability |

Every report record that names an obligation must name one in the manifest; a
record that does not is an `unknown_obligation` defect. Every obligation ends in
exactly one status:

| Status | How it is reached |
|---|---|
| `covered` | a `rule` obligation with at least one exercised check tracing to it; a `policy` obligation the gate found **applicable**; an `operation` obligation with at least one matching request in the HAR |
| `skipped` | `check.skip` citing one of the obligation's `approved_skip_reasons` |
| `unsupported` | `check.unsupported` citing an approved reason, or a manifest entry declared `unsupported: true` |
| `unaccounted` | anything else — including a skip whose reason is not approved, and a declared policy that matched no traffic |

**An unaccounted obligation fails soundness regardless of how many checks ran.**
This is what makes an approval screen honest: "23 checks covering 9 of 9
operations and 6 of 6 rules", not "23 checks".

## Verdict

Two columns (`DESIGN` N10), because P1 showed one column is biased in whichever
direction its applicability window points (`studies/api-probe/REPORT.md` §3):

- **the HAR column** — the shipped Tier-1/2 invariant policies
  ([Engine: Invariant policies](engine.md#invariant-policies)) evaluated over the
  recorded HAR: the [Level 0 set](#invariant-levels). Applicability is an
  outcome: a declared policy that matched no traffic fails and leaves its
  obligation unaccounted.
- **the report column** — no failing check and no defect.

```
verdict.pass = report_pass ∧ gate_pass ∧ soundness.ok
exit 0 = pass · exit 1 = sound, a column failed · exit 2 = unsound
```

A failing check on a sound suite is a **candidate finding**, not a defect: the
API being broken is a supported day-one outcome, and it exits 1 with evidence
rather than pretending the run was invalid.

## Report schema

`src/core/schemas/script-report.schema.json` is authoritative. Top level:

```
script_report_version, contract_version
script      { path, sha256, bytes }          sha256 = the approval fingerprint
run         { started_at, finished_at, duration_ms, base_url, allowed_origins,
              mode, write_grant, budget: { limit, used, remaining }, timeout_ms,
              secrets_declared, namespace, params, exit }
test_data   { namespace, created, namespaced, unnamespaced, deleted, outstanding,
              by_collection, accumulation_cap, over_cap }
cleanup     { policy, reset, attempted, ok, detail, outstanding, accumulation_cap }
checks      [ { id, obligation, title, pass, exercised, expected, observed,
                note, evidence: { har_entries: [int], subject } } ]
advisories  [ { title, detail } ]
defects     [ { kind, message, detail, code, check, request } ]
hygiene     { leak_findings: [...] }
guard       [ { code, request, at } ]
obligations { manifest_version, summary, entries: [ { id, source, statement,
              status, reason, checks } ] }
gate        { pass, checks: [ { policy, tier, spec, obligation, applicable,
              pass, detail, har_entries } ] }
soundness   { ok, reasons }
verdict     { pass, report_pass, gate_pass, sound, failing_checks, exit_code }
```

`evidence.har_entries` is the machine evidence: HAR entry indices that resolve in
the sibling `har.json`. A citation that does not resolve is dropped from the
check and raised as an `evidence_unresolvable` defect.

## Risk profile

Mechanical, from the static script text plus a recorded HAR, with **no model
call**. One module (`src/core/public/api-suite-scripts.ts` → `profileScript`) feeds both the
CLI and the hosted script page, so a reviewer sees the same numbers everywhere.

```
profile_version
requests            { total, budget, methods: { GET: n, POST: n, … } }
endpoints           [ { method, path (templated), count, statuses } ]
resources           [ { collection, reads, writes, deletes, created } ]
mutation            { classification: read-only | writes | deletes, reads, writes, deletes }
data_created        { count, by_collection, ids }
secret_references   { declared, in_source, used }
out_of_origin_attempts [ { method, path, detail } ]
refused             { off_origin, read_only, budget_exhausted, undeclared_secret, invalid_path, other }
static              { secret_references, imports, lines, bytes }
```

Path templating is mechanical: a segment equal to an id the API itself announced,
or matching a numeric / uuid / ulid / `prefix_handle` shape, collapses to `{id}`.

## Leak scan

The P2 baseline leak scan (`src/core/baseline-scan.ts`) applied to script text,
with the same rules and the same consequence — findings **block**:

| Rule | Finding |
|---|---|
| `secret` | a value core resolved from a secret reference appears literally |
| `redaction` | a redaction-list value appears literally |
| `entropy` | a credential-shaped token in a string literal |
| `data` | an email address in a string literal |

Two enforcement points: the **save** path blocks on any finding before the script
reaches review, and the **runner** refuses to execute a script with a `secret` or
`redaction` finding at all — the alternative is writing the credential into the
HAR. The scan also returns the sha256 fingerprint of exactly the bytes scanned,
which is the content fingerprint an approval covers (`DESIGN` N9).

**Scope, stated plainly.** Both the runner's pre-flight scan and
`script.sha256` cover the **entry module**. Hosted authoring emits a single
module, so there they cover the whole script. A multi-file script — permitted on
the CLI path, where a suite may import siblings under its own root — has its
siblings covered by the save path (which scans each file as it is saved) and by
the team's own code review, not by the entry module's fingerprint. Extending the
fingerprint over the statically imported sibling set is the obvious next step and
is deliberately not v1.

## HAR lifecycle

One precise policy, because the HAR is evidence, part of the artifact bundle, and
sensitive at the same time:

- **Known-secret scrub at write time.** Every value core resolved is replaced by
  `[secret:NAME]` in the serialized document before it reaches disk. Injected
  values are additionally never in the recorder's memory: the proxy records the
  placeholder and keeps the real value on the wire.
- **Body-size caps.** A response whose declared length exceeds
  `MAX_HAR_BODY_READ` (1 MiB) is never buffered; a stored body over
  `MAX_HAR_BODY_CHARS` (64 KiB) is truncated with a marker. Non-textual bodies
  are recorded by size alone. `content.size` keeps the declared size either way.
- **Flush per exchange.** A killed or timed-out script still leaves a scorable
  trace.
- **Sensitive and untracked.** `har.json` may still contain credentials a server
  invented and core cannot recognize. It lives with the run artifacts, is never
  committed, and is subject to the hosted retention window like any other
  sensitive payload ([Hosted: Retention](hosted.md#retention-and-deletion)).
- **What survives payload deletion.** When the HAR is deleted or expires, the
  report remains usable: each check keeps its obligation trace, its
  expected/observed strings, and the cited entry **metadata** the report already
  carries. Raw bodies go. A citation whose HAR is gone is displayed as
  unresolvable evidence — never silently rendered as if the payload were still
  there.

## Enforcement tiers

Where each guarantee actually lives. A reader deciding how much to trust a
guarantee should read this table and nothing else.

| Tier | Mechanism | Guarantees |
|---|---|---|
| **wire** | the secret-bearing proxy in the parent process | origin lock, read-only default, request budget, secret substitution, HAR recording. A script cannot weaken any of these, because it cannot reach the process that enforces them. |
| **process** | the script process's sandbox ([The script process](#the-script-process)) | no ambient network, no credential in the environment, no filesystem, no subprocess, no dependency, no unhooked loader. Defence in depth against accident. |
| **parent-computed** | the runner | the HAR, the gate column, evidence resolution, obligation accounting, the streamed-prefix cross-check. A script cannot forge these. |
| **review** | the leak scan, the risk profile, the approval fingerprint | what a human sees before licensing this exact content to run. |

## The script process

The child is spawned as `node child.ts` with its configuration on **stdin** —
never argv, so nothing about a run appears in a process listing — and an
environment containing only a marker: no `PLAYTEST_SECRET_*`, no model
credentials, nothing inherited. Before the script is imported the process:

1. captures the native `fetch` for the client's own transport, then deletes
   `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest`, and friends;
2. registers module-resolution hooks that permit only the built-ins
   `node:assert`, `node:assert/strict`, `node:buffer`, `node:crypto`,
   `node:events`, `node:path`, `node:path/posix`, `node:punycode`,
   `node:querystring`, `node:string_decoder`, `node:timers/promises`,
   `node:url`, `node:util`, `node:zlib` — and, for file specifiers, only paths
   inside the script root;
3. neutralizes `process.getBuiltinModule` and deletes `process.binding`,
   `process.dlopen`, and `process._linkedBinding`, the loader escapes that would
   bypass the hooks;
4. replaces `process.env` with a frozen empty object.

`node:fs`, `node:net`, `node:http(s)`, `node:dns`, `node:tls`,
`node:child_process`, `node:worker_threads`, `node:module`, and `node:vm` are
therefore unavailable, as is any bare dependency specifier, any `data:` or
`https:` module URL, and any file outside the script root.

## Trust model

**Locally the trust model is stated, not engineered.** The client guards
accident; review guards malice. A script is source code a team runs against its
own environment — exactly the trust a committed test suite already has — and the
substrate's job is to make that trust legible: read-only until authorized, a
mechanical risk profile before approval, a leak scan on save, and a recorded
trace of everything that happened. Interactive per-action permissioning and
OS-level sandbox research are explicitly not built (`DESIGN` N8).

**Hosted, the boundary is a contract with escape tests.** The credential-bearing
process and the script process are different processes:

- the **proxy process** (the runner-agent job) holds the resolved secrets, owns
  the only socket to the target, and enforces the wire tier;
- the **script process** holds no credential, has no ambient network, and reaches
  the target only through the proxy's loopback control channel, authenticated by a
  per-run token;
- **network isolation of the script process** — that it cannot bypass the proxy
  and open its own socket to the target or the internet — is the runner-agent
  sandbox's responsibility (its container network policy), not an in-process
  claim. What the substrate guarantees unconditionally is that such an escape
  yields **no credential**: there is none in the process to steal, and the
  proxy's guards are unaffected by anything happening inside the child.

The adversarial battery proving this lives with the package that owns the
boundary (`src/platform/runner-agent/tests/unit/script-boundary.test.ts`) and
covers: ambient `fetch`, `node:http`/`node:net`, alternate-origin and DNS
access, `process.env` reads, filesystem escape, `child_process`, direct report
fabrication, and credential exfiltration through URLs, bodies, logs, and thrown
exceptions. Each attempt must be blocked or provably credential-free
([Hosted: Script execution boundary](hosted.md#script-execution-boundary)).

## Run configuration

The runner API (`src/core/public/api-suite-scripts.ts` → `runScript` / `resolveScriptRun`):

```
script            path to the script module (required)
target            { base_url (required), allowed_origins, write_grant, cleanup }
namespace         this run's namespace; minted per run when omitted
secrets           [NAME] — the PLAYTEST_SECRET_<NAME> references this run permits
spec              a resolved OpenAPI document (enables the spec-driven policies
                  and the operation obligations)
rules             [ { id, statement, applicability, approved_skip_reasons,
                  unsupported } ] — approved rule statements only
policies          invariant policy declarations; defaults to Level 0
obligations       an explicit manifest, merged ahead of the derived one
params            JSON object handed to the script
budget            request ceiling (default 400)
timeout_ms        wall-clock ceiling for one execution (default 120000)
request_timeout_ms per-request abort (default 15000)
out_dir           where har.json and script-report.json are written
```

Only human-approved rule statements reach `rules`; the platform never turns an
observation into a rule (`DESIGN` N6). The CLI surface is
[Interfaces: script suites](interfaces.md#script-suites); the hosted lifecycle is
[Hosted: The script page](hosted.md#the-script-page).

## Test-data lifecycle

A mutating suite creates resources on every replay, forever (`DESIGN` §6). Two
failure modes follow, and both are quiet until they are expensive: two
concurrent replays collide on the same fixture name, and a year of nightly
replays silts up an environment nobody is watching. So neither half is
advisory — the namespace is on the client, and the accounting is computed by
the parent from the recorded traffic.

**The run namespace.** Every execution gets `client.namespace`: `pt` plus eight
base-36 characters of clock and eight of CSPRNG. The clock half keeps namespaces
sortable and legible inside a target's own data; the random half is what makes
two runs starting in the same millisecond a non-event. It is never derived from
a run id a caller controls. `client.name("cart")` is the ergonomic form, and the
handout tells an author to use it for every name the suite creates. The report
carries it as `run.namespace`.

The mechanically checkable half of the rule is counted, not enforced: a
creating request whose body, path, and response never mention the namespace is
reported as `test_data.unnamespaced`. Refusing it would be wrong — a
server-assigned identifier is the normal case — but a suite that labels nothing
as its own is a suite that will collide, and the number says so before it does.

**Cleanup, declared per target.**

```
target.cleanup = "teardown"
target.cleanup = { policy: "reset", reset: { method: "POST", path: "/admin/reset" } }
target.cleanup = { policy: "teardown", accumulation_cap: 20 }
```

| Policy | Behavior |
|---|---|
| `reset` | harness-owned, and available only where the target authorization declared a reset affordance. After the script finishes, the parent calls it **through the same proxy**, under every guard except the budget ceiling — a suite that spent its whole allowance must still be able to put the environment back. The request is recorded and counted like any other. |
| `teardown` | best-effort: the suite deletes what it created, and the harness counts what survived. Past `accumulation_cap` (default 50) the run fails. |
| `none` | resolved automatically for a read-only run, which creates nothing. |

**A failed cleanup is reported, never silent, and it is loud.** A reset that
answered 503, or a teardown past the cap, makes the execution **unsound** — exit
2, with the reason in `soundness.reasons` and the detail in `cleanup` — rather
than a pass with a footnote. The alternative is a green run and an environment
filling up, which is the outcome the policy exists to prevent.

Scoped authorization — method/path scope, tenant scope, write and request caps —
is a roadmap seam (`DESIGN` §10) and is deliberately not built. What v1 records
is origin-wide, plus an optional `expires_at` the hosted dispatcher checks, and
that is the whole of it.

## Approval lifecycle

`DESIGN` N9: approval is an **artifact lifecycle state**, the platform's third
instance of a pattern it already runs twice (healed baselines held for review,
findings review). It is not a permission framework, and nothing here is a role
system — `src/core/public/api-suite-scripts.ts` owns the shape and the one question
dispatch asks, and the hosted side owns storage and the surface
([Hosted: The script page](hosted.md#the-script-page)).

A **version** is one immutable content record:

```
lifecycle_version, number, parent, origin, state, fingerprint, bytes,
created_at, authored_by, note,
approval: { state, fingerprint, approver, at, review, reason? } | null
```

| Field | Rule |
|---|---|
| `fingerprint` | sha256 of exactly the script's bytes — the same value the leak scan returns and the report records as `script.sha256` |
| `state` | `pending` · `approved` · `rejected` |
| `origin` | `authored` (an authoring job) · `edit` (a person or the assistant) · `revision` (a drift proposal) |
| `approval` | `null` until a human decides. `approver` is required: an approval records a person, never a flag |

Four rules, and they are the whole lifecycle:

- **A version is born pending.** Authoring produces content for review; so does
  every edit. No function in the module can mint an approved version.
- **Approval covers content, not a version number.** `approveScriptVersion`
  takes the fingerprint the reviewer had on screen and refuses a mismatch: if
  the script moved while it was being read, the decision was about something
  else. Rejection follows the same discipline, because a rejection is also a
  judgement of content.
- **Any edit invalidates to pending** — typed into the page, applied by the
  assistant, or arriving as a proposed revision. There is no difference between
  the three, by construction: each produces new bytes, and new bytes have no
  approval.
- **Dispatch asks one question.** `scriptDispatchLicense(version)` answers from
  the version alone — no caller-supplied flag can make an unapproved script
  runnable — and `assertScriptDispatchable` raises the actionable
  `DummyConfigError` rather than returning a boolean, because the only correct
  response to an unapproved script is to stop. Its four refusals are
  `no_version`, `pending`, `rejected`, and `invalidated` (approved once, and the
  content has since moved).

`diffScriptText(before, after)` is the line diff the script page and the CLI
both render — plain LCS, `{ op, a, b, text }` triples grouped into hunks, the
same shape the existing review surfaces already draw.

## Replay and drift

An approved script's replay is `replayScriptBundle` ([The authoring
bundle](#the-authoring-bundle)) or an ordinary `runScript` against the same
configuration: the same two columns, the same obligation accounting, the same
artifacts. Replay is licensed by the approval of that exact content, so it does
not need a target authorization and runs read-only without one.

When a replay goes red, `triageScriptReplay` classifies it — from the two
reports, the two resolved OpenAPI documents, and the recorded traffic. **No
model participates**, and triage never makes a run greener: the verdict was
already red before it started, and all it decides is what to offer.

| Classification | Meaning | What is offered |
|---|---|---|
| `regression` | the API broke its own promise | **nothing**. Red, loudly. A revision here would delete the evidence |
| `contract_drift` | the document moved under a suite that was right when it was approved | a proposed revision + a drift report, as a **pending** version |

The rules, in priority order — redder wins, as in P4's heal triage
([Engine: Act and heal](engine.md#act-and-heal)):

1. a defect (the replay was unsound) → `regression`;
2. a failing `no_server_error` gate check → `regression`;
3. **any failing check on a `rule:` obligation → `regression`.** An approved
   rule is the owner's own sentence about their API; a document edit cannot
   license breaking it;
4. the OpenAPI surface did not change → `regression`. Nothing about the contract
   moved, so the API simply broke;
5. a failing check citing an operation the surface diff did **not** touch →
   `regression`. A suite may not borrow an unrelated drift as an excuse;
6. otherwise → `contract_drift`.

The **surface** compared is what a suite can be broken by: which operations
exist, which statuses each documents, and which response fields each declares. A
path parameter's *name* is not part of it (`{widgetId}` and `{id}` are the same
hole), and a removal plus an addition under one parent is read as a rename
rather than as two unrelated changes.

The drift report (`drift-report.json`, `schema_version: 1`, `mode:
"script_replay"`) sits beside the replay's HAR and report and mirrors the heal
report's discipline ([Artifacts: Drift report](artifacts.md#drift-report)):
everything except `narrative` is computed evidence, and the narrative is read
back by nothing.

**A proposed revision is one model call and no execution.**
`proposeScriptRevision` has no client, no target, and no runner: it is a prompt
(pinned at `script-revision-v1`) over the current script, the surface diff, and
the failing checks, and it returns source text. That is the whole answer to
"does a pending revision run before somebody says yes?" — it cannot, because the
function that writes it has nothing to run it with. Where the environment
declares a **disposable** target, the hosted side may then dispatch an ordinary
validation replay against that target and nothing else; otherwise the revision
is approved-then-run
([Hosted: Drift as a revision](hosted.md#drift-as-a-revision)).

## Target authorization

One recorded fact licenses execution against a target: the owner's answer to
*"safe to write test data to this environment?"* (`DESIGN` §4 step 2, N8). It is
the same record everywhere — run configuration's `target.write_grant`, an
authoring job's `target.authorization` — and it is resolved by one module
(`src/core/api-suite-scripts/license.ts`).

```
{ origin, approved_by, approved_at?, record?, write: true | false,
  expires_at?, disposable?, reset? }
```

| Rule | Consequence |
|---|---|
| it covers exactly the origin it names | a run whose `base_url` resolves to a different origin is a `DummyConfigError`; **an origin change invalidates it** |
| `approved_by` is required | an authorization records a person, never a flag |
| `write: false` | the run is `read-only`: only `GET`/`HEAD` are forwarded, at the wire |
| absent | **authoring refuses to start** — no handout is built, no model is called, and nothing reaches the target |
| `expires_at` in the past | the grant is not live: hosted dispatch refuses a mutating suite against it, naming when it lapsed |
| `disposable: true` | this target may be rebuilt at will, which is what lets a **pending** revision be validated before approval ([Replay and drift](#replay-and-drift)) |
| `reset` | the affordance a `cleanup: { policy: "reset" }` declaration names |

Replaying an already-approved script is licensed by the approval of that exact
content, so replay accepts a target with no authorization and runs it read-only.
Authoring has no approved content yet, which is exactly why it needs the
declaration instead.

`expires_at` is a single timestamp, not the beginning of a scope language. The
scoped authorization of `DESIGN` §10 — method and path scope, tenant scope,
write and request caps — stays a named seam.

## Spec provisioning

An authored suite needs the OpenAPI document — every `operation` obligation
comes from it, and three of the four Level 0 policies read it — so provisioning
has four inputs and no fifth "without one" mode (`DESIGN` §4 step 1):

| Declaration | Behavior |
|---|---|
| omitted, `true`, `{ discover: true }` | **auto-discovery** against the target |
| `{ url }` or an `http(s)` string | fetched from that address |
| `{ file }` or a path string | read from disk |
| `{ document }` / `{ text }` | the uploaded or pasted document (object, or JSON/YAML text) |
| `false` | refused — there is no way to declare that a job has no spec |

Auto-discovery probes, in order and stopping at the first document that parses
and has a `paths` object: `/openapi.json`, `/openapi.yaml`, `/swagger.json`,
`/v3/api-docs`, `/api-docs`, `/.well-known/openapi.json`, then any URL announced
by a `Link` header on the target's root with `rel` of `service-desc`,
`describedby`, or `openapi`. `spec.paths` overrides the conventional list.

However it arrives, the document is materialized into the run's work directory
and resolved through the shipped enrichment (`src/core/openapi.ts`) — so a
provisioned spec is the same enriched object the policies and the manifest
already read, under the same boundary rules: internal pointers resolve, file
refs resolve only inside the document's own directory tree, **a network `$ref`
is refused**, and the document is size- and node-capped. Fetching the root
document is an explicit instruction from configuration; nothing it contains
inherits the right to fetch more.

A document that cannot be resolved is a `DummyConfigError` naming every location
tried and the three ways to supply it. **There is no degraded mode**: a suite
authored without a spec would silently lose every operation obligation, which is
the vacuity the manifest exists to prevent.

## Invariant levels

What a suite is judged against comes from two levels, and the ladder is the
whole of `DESIGN` N6: **invariants are approved, never demanded.**

**Level 0** is the spec-derived policy set, on by default, zero user input:

| Policy | Needs a spec |
|---|---|
| `no_server_error` | no |
| `documented_status` | yes |
| `response_schema` | yes |
| `content_type` | yes |

`defaultScriptPolicies({ spec })` is the shipped list (`LEVEL_0_POLICIES`). Each
one carries a `policy:` obligation into the manifest like any rule, so a suite
with **zero approved rule cards is still a real suite**: it exercises every
operation, and its traffic is judged by four policies. Spec provisioning is a
configuration error rather than a degraded mode, so in practice all four are
always live. Nothing — no card, no prompt, no model output — switches one off.

Level 0's honest limit is the argument for Level 1: a semantic fault that
answers a documented status with a schema-valid body is invisible to it.

**Level 1** is rule cards. The platform proposes 5–8 plain-language candidate
rules; a human approves, edits, denies, or writes their own; only approved
sentences are enforced. The card lifecycle, its storage, and its surface belong
to [Hosted: Rule cards](hosted.md#rule-cards); the engine owns three things:

- the **card shape** — `{ id, title, statement, applicability, exceptions,
  provenance, note, state, origin }`, with `state` one of `candidate`,
  `approved`, `denied` and `origin` one of `proposed`, `authored`;
- the **proposal prompt**, built by `buildProposalPrompt` and returned through
  the schema-constrained `RULE_PROPOSAL_TOOL`. Runtime validation rejects fields
  outside the candidate-card shape, and `normalizeProposalToolArgs` pins every
  accepted card to **`candidate`** and **`proposed`**: a model cannot mint an
  approved rule;
- the **governance boundary** — `approvedCardRules(cards)` is the only function
  that turns cards into handout rules, and it filters on `state === "approved"`
  in its own body. A candidate or denied sentence therefore has no path to a
  handout, no `rule:` obligation id, and no column of a verdict. This is
  structural, not advisory.

Three prompt rules are S0 findings rather than taste
(`studies/api-suite/REPORT.md` §4):
one rule per card; an exception narrows a rule and never cancels it; the Level 0
set is passed in as the list not to re-propose.

An **observation pass** is the optional second input (`observeApi`): a
mechanical read-only sweep of the `GET` operations the document itself
parameterizes, plus one `limit=1` pagination probe per collection, through the
ordinary proxy in `read-only` mode. There is no model in it, the wire refuses
every mutation regardless of what it asks for, and it is bounded by the same
wire-enforced budget as any execution (default 40 requests). S0's proposal trial
spent 42 of 60 and one of its eight cards rested on an anomaly it saw live.

## The handout

What an authoring job is given, and the only thing it is given (`DESIGN` §5
item 2). Six files, all derived — the same inputs write the same bytes, with no
model anywhere in their construction:

```text
<out>/handout/
  BRIEF.md               the authoring protocol, from the maintained asset
  CLIENT.md              this contract, rendered for the author
  INVARIANTS.md          the approved rule statements, with the owner's notes
  obligations.json       the resolved coverage-obligation manifest
  openapi.json           the resolved, enriched OpenAPI document
  handout-manifest.json  what was assembled, with a sha256 per file
```

`BRIEF.md` and `CLIENT.md` are maintained assets under
`src/core/api-suite-scripts/handout/`, parameterized by target, mode, credential
references, and budgets. They are the productized S0 protocol text
(`studies/api-suite/BRIEF.md`), and two of their rules were earned by that
study's transcripts rather than designed: **an approved rule beats the OpenAPI
document** where the two disagree (two of four authors lost a real defect by
deciding the other way), and **the first execution is a recon pass** (three of
four did this unprompted and the fourth paid for skipping it). A change to
either asset changes what suites get authored, so it belongs in the same review
as the other model-facing authoring instructions.

`obligations.json` is not optional garnish. The manifest is derived
mechanically; an author who has to guess an obligation id spends a whole turn of
a small budget discovering the vocabulary, so the resolved ids ship with the
document that judges them.

Rule statements arrive as records (`{ id, statement, applicability, exceptions,
notes, approved_skip_reasons, unsupported }`) or as an `INVARIANTS.md` document
parsed into them — one `##` section per rule, first paragraph the statement, an
explicit id via `{#id}` or `` `rule:id` `` in the heading and a slug of the
title otherwise. Card notes render beside their rule as **Owner's note**, which
is how the owner's steering reaches authoring at all, and a card's
`exceptions` renders as **Declared exception**.

Two composition rules the handout enforces:

- **A declared exception narrows its rule; it never cancels it.** Where the two
  contradict each other the rule stands and the contradiction is a finding, and
  `INVARIANTS.md` says so in its preamble. S0's proposal trial lost a real
  detection to a card whose exceptions line overrode its own applicability line,
  which is why the two are separate fields rather than one paragraph.
- **A card's provenance does not travel.** Provenance is the model's account of
  why it proposed a sentence; the handout carries what a human approved and what
  they wrote beside it, and nothing else.

## The authoring loop

No agent SDK, no multi-tool harness, no interactive permissions (`DESIGN` N4).
One turn is:

```
prompt(handout + last report digest + current draft) → one complete script
  → the runner → repeat
```

The model sees a stable first message (the whole handout, byte-identical every
turn, so a caching gateway caches it) and a volatile second one: budget state,
any objections from the previous turn, a digest of the last accepted execution,
and the current draft in full. It returns two fenced blocks — a `json` block of
`{ notes, revisions }` and a `js` block containing the entire module. A reply
with no usable script costs a turn and produces an objection; it never crashes
the job.

**Termination is soundness, not success** (`DESIGN` N5). The loop stops when an
accepted execution is sound — no defects, every check exercised, every
obligation accounted for — **and** every failing check cites at least one HAR
entry that resolves. A sound suite with failing checks exits 1 and is the job's
success: the API being broken is a supported outcome, and the findings are what
a human judges at approval.

Otherwise the loop stops on a budget and says which one. Its outcome is one of
`sound`, `iterations`, `requests`, `wall_clock`, `model_error`; only the first
is success, and the transcript and bundle are written either way.

### Revision discipline

The one governance rule the loop enforces, mechanically, after execution
(`DESIGN` §11's default). For every check that was **failing** in the last
accepted execution:

| Change | What the model must record |
|---|---|
| the check is gone | a `revisions` entry with a `citation` beginning `spec:` or `rule:` |
| its `expected` differs | the same |
| it now passes, same `expected` | a `revisions` entry explaining the repair — no citation needed, because fixing the suite's own bug is not a claim about the contract |

A change without its record is **rejected**: the draft does not become the
accepted one, the loop reverts to the previous accepted draft, and the objection
is quoted back on the next turn — which costs a turn. Nothing here consults a
model, and the comparison is over the reports the parent computed, not over the
script text.

### The transcript

Persisted at `<out>/authoring-transcript.json` and carried into the bundle:
target and authorization, the handout's fingerprint and file list, **the
approved rule statements verbatim with their card notes** (`handout.statements`
— prompts are recorded by hash, so this is the only place a reviewer can see
what steering the owner's notes gave the author), budget limits
and what was spent (turns, executions, requests, wall clock, tokens, cost), then
one record per turn — the model's `notes` and `revisions`, the draft's sha256,
the execution's digest, the objections it drew, and whether it was accepted —
and the outcome with its findings. Prompts are recorded by size and hash, not
verbatim: they are reconstructible from the handout and the reports beside them.

## Authoring budgets

Three ceilings, all enforced, all overridable. The defaults are productized from
what the S0 trials **actually used**, not from the ceilings they were given
(`studies/api-suite/rounds/ROUND-LOG.md`; all four arms finished sound):

| Dimension | S0 ceiling | S0 usage across four arms | default |
|---|---|---|---|
| `iterations` (model turns) | 12 | 3, 4, 6, 3 | **8** — worst case + 2 |
| `requests` (whole job) | 1 500 | 640, 723, 841, 1 184 | **1 500** — worst case + 27% |
| `wall_clock_ms` | 3 h | 15, 20, 21, 21 min | **45 min** — worst case × 2 |
| `execution_budget` (one execution) | 360 | 214–246 per execution | **400** (the runner's own default) |
| `execution_timeout_ms` | 10 min | nothing came close | **5 min** |

`execution_budget` may not exceed `requests`. Each execution's wire budget is
the smaller of `execution_budget` and what the job has left, so the last
execution cannot overrun the job's total.

## Findings

A failing check on a sound suite is a **candidate finding**
(`src/core/api-suite-scripts/findings.ts`), and so is an applicable Level 0 policy the
traffic violated. A finding carries its obligation and the rule statement behind
it, its expected/observed strings, and its cited HAR entries **read back as
exchanges** — method, URL, status — which is the re-verification `DESIGN` N5
asks for. `evidence_verified` is false when no citation resolves; the authoring
loop will not terminate on such a check, and a reviewer sees the claim marked as
unbacked rather than dressed as evidence.

Findings are what the CLI prints at the end of a job and what S4's approval
screen renders. They are never a verdict: the human decides real bug, or wrong
rule.

## The authoring bundle

The script artifact of `DESIGN` N1, versioned and self-sufficient:

```text
<out>/bundle/
  bundle.json               manifest: version, fingerprints, verdict, findings, replay config
  suite.mjs                 the authored module
  authoring-transcript.json how it was authored
  har.json                  the final execution's recorded traffic
  script-report.json        the final execution's report
  handout/…                 the six handout files it was authored from
```

`bundle.json` records a sha256 per file, so `replayScriptBundle` refuses a
bundle whose contents no longer match its manifest — the fingerprint is what an
approval covers. Replay reads the spec and the obligation manifest **out of the
bundle's own handout**, so a replayed verdict cannot drift from what the suite
was judged against; the caller supplies only the target and where to write. A
bundle replayed against a fresh instance of the same build reproduces the same
verdict, the same failing checks, and the same obligation accounting.

## The authoring job file

`src/core/schemas/authoring-job.schema.json` is authoritative, and the same
shape backs the CLI and the hosted job:

```
target    { base_url, allowed_origins, authorization }   (required)
spec      a path, a URL, or { file | url | document | text | discover, paths }
rules     approved statements, or a path to an INVARIANTS.md
secrets   [ NAME | { name, role } ]
params    the frozen JSON object handed to the script
reset     the target's reset affordance, in one sentence, for the handout
model     defaults to the configured actor model
budget    the ceilings above
out_dir   where the handout, executions, transcript, and bundle land
```

`playtest script author <job>` runs one; `--prepare` writes the handout and
stops, with no model call and no execution, which is also the cheapest way to
see exactly what a job would ask for.
