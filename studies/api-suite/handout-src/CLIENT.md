# The script contract

Everything you may use, and nothing else. This document is complete: there is
no other reference, no repository to read, and no package to install.

A **script suite** is one plain Node ESM module. It runs in its own process
against one authorized target, every request it makes is recorded, and it
produces a report that a human reviewer and an automated gate both read.

---

## 1. The entry

Write `suite.mjs` in your scratch directory, default-exporting one async
function:

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

- The function receives that object and nothing else.
- The return value is ignored. **A rejection is a script defect, not a check
  failure** — it says your suite broke, not that the API did.
- A module with no default-exported function fails the run as a
  `contract_violation` defect.
- `params` is a frozen JSON object from run configuration. It never carries a
  credential.
- You may split the suite across sibling modules inside your scratch directory
  and import them with relative specifiers. Nothing else resolves — see §9.

## 2. The client

`client` is bound to the target's base URL. Every method returns a **frozen
response record**. A transport failure is a record with `transportError` set
and `status: 0`, not a throw: "the API did not answer" is an observation you
may want to check.

```
client.request(method, path, options)
client.get(path, options)     client.head(path, options)
client.post(path, options)    client.put(path, options)
client.patch(path, options)   client.delete(path, options)

options   { body, rawBody, headers, contentType }
          body       any JSON-serializable value; serialized for you
          rawBody    a string sent verbatim (for malformed-input probes)
          headers    { name: value } — a value may be a secret reference (§3)
          contentType default "application/json" when a body is present

client.baseUrl      the resolved target base URL
client.mode         "read-only" | "read-write" — set by run configuration
client.budget       { limit, used, remaining }
client.secretNames  the NAMES this run declared; values are unavailable
client.secret(NAME) → { $secret: NAME }, a header value the wire substitutes
```

Response record:

```
{ ref, method, url, path, status, statusText, headers, text, json,
  parseError, ok, timeMs, transportError }
```

- `ref` is the **HAR entry index** and the only evidence handle you ever hold
  (§5).
- `json` is the parsed body, or `null`; `parseError` is `true` when the body
  was non-empty and did not parse.
- `ok` is `status >= 200 && status < 300`.
- `headers` is a lowercased `{ name: value }` object.

**A path is a path.** A specifier with an explicit scheme (`https://…`) is an
absolute URL and faces the origin guard. Anything else is *appended* to the
base URL rather than resolved against it, so `//elsewhere/x` is a
double-slashed path on the target, not a jump to another host. Probing hostile
paths still probes the target you were pointed at.

## 3. Guards, and what they mean for you

Four guards refuse a request. Each **throws** `ScriptClientRefused` inside your
process, and each is enforced again on the wire, which is the authority. A
refused request performs **no network I/O, produces no HAR entry, and is
recorded as a defect** — so a guard refusal makes your run unsound. Do not
write a suite that expects to be refused.

| Guard | Rule |
|---|---|
| **origin** | the resolved origin must be the target's own origin. This run allows no other origin: a different port or a different scheme is a different origin, and a non-http(s) specifier has no admissible origin at all. |
| **mode** | in `read-only`, only `GET` and `HEAD` are forwarded. Everything else is refused. |
| **budget** | past `budget.limit` nothing is forwarded and nothing is recorded. Exhaustion throws `BudgetExhausted` and is a defect: **the recorded trace is the budget**. |
| **secrets** | `{ $secret: NAME }` resolves only for a NAME this run declared, and only on a request to the target's own origin. |

`client.mode` comes from the run's recorded **target authorization** — the
answer to "safe to write test data to this environment?" — not from your code.
Nothing a script does can widen it.

**Secrets.** Credentials exist only as references. `client.secret(NAME)`
returns `{ $secret: NAME }`, legal as a **header value only**. The wire
substitutes the real credential, sends it upstream, and records the
placeholder `[secret:NAME]`. Known credential values are additionally scrubbed
out of every response *before it reaches your process*, so a target that echoes
its own `Authorization` header discloses nothing.

You can cause an authenticated request. **You can never read the credential
value**, and a literal credential in your source blocks the run outright.
`client.secretNames` tells you which names exist. This run declares three:

| Reference | Who it authenticates |
|---|---|
| `LEDGER_ADMIN_TOKEN` | the administrator principal; the only one the `/admin/*` routes accept |
| `LEDGER_CUSTOMER_TOKEN` | one customer principal |
| `LEDGER_CUSTOMER_B_TOKEN` | a second, **different** customer principal |

Each resolves to a complete `Authorization` header value, so it is used whole:

```js
const mine = await client.get("/accounts", {
  headers: { authorization: client.secret("LEDGER_CUSTOMER_TOKEN") },
});
const theirs = await client.get("/accounts", {
  headers: { authorization: client.secret("LEDGER_CUSTOMER_B_TOKEN") },
});
```

A reference substitutes a value, never part of one: you cannot build
`` `Bearer ${…}` `` yourself, and you do not need to.

**Which principal is which is not written down anywhere.** The names above say
that two of the references are different customers of the same service; they do
not say what either one is called, what it already owns, or how the service
decides what it may reach. That is learnable only by acting — create a resource
under one reference and read it back under the other, and compare what each is
shown. Two customer credentials exist precisely so that "acting as the wrong
principal" is something you can *do* rather than something you have to imagine.

## 4. The check API

`check` is synchronous and records five kinds of entry. The separation is
load-bearing: soundness depends on telling a broken API apart from a broken
suite.

```js
check({ id, obligation, title, pass, expected, observed, note, evidence, exercised })
check.skip({ obligation, reason })
check.unsupported({ obligation, reason })
check.defect({ message, detail, evidence })
check.advisory({ title, detail, evidence })
```

| Call | Meaning |
|---|---|
| `check(…)` | a verdict about the API. `id`, `obligation`, and a boolean `pass` are required; `title` defaults to the id. |
| `check.skip(…)` | this obligation was deliberately not covered. It counts only when `reason` matches one of that obligation's `approved_skip_reasons` — see §6. |
| `check.unsupported(…)` | this obligation cannot be expressed on this substrate. Same approved-reason rule. |
| `check.defect(…)` | **your suite** could not do its job: it could not build the state a check needed. Never a statement about the API. Any defect makes the run unsound. |
| `check.advisory(…)` | an observation that gates nothing. |

Rules the channel enforces:

- A malformed call **throws** — a missing `id`, a non-boolean `pass`, an
  evidence entry that is not a response ref. It surfaces as a script defect
  rather than being silently dropped.
- A check `id` identifies exactly one verdict and must be **unique** in the
  report. A second check under the same id is a `duplicate_check_id` defect.
- `exercised` defaults to `true`. A check reported with `exercised: false`
  proves nothing, does not cover its obligation, and makes the run unsound —
  so report the obligation as skipped or unsupported instead of authoring a
  check you never ran.
- Records are streamed to the parent as you go and again in full at the end.
  The final report must **extend** what was streamed; a differing record is a
  `report_contradiction` defect. You may narrate more, never re-narrate.

## 5. Evidence

```js
evidence: { requests: [response.ref, other.ref], subject: { anything: "json" } }
```

`requests` entries are response refs (you may pass the whole response record;
its `.ref` is taken). They land in the report as `evidence.har_entries`:
integer indices into the run's `har.json`.

**Every citation is verified.** A ref that does not resolve in the recorded HAR
is dropped from the check and raised as an `evidence_unresolvable` defect.

A failing check that cites nothing is worth nothing to a reader: cite the exact
exchanges that prove the claim, including the ones that *built* the state when
the failure is only legible in sequence.

## 6. The obligation manifest

Your run is judged against a manifest **derived mechanically** from the
handout — no model, no judgement, and nothing you can author. Three sources:

| Source | Obligation id | Derived from |
|---|---|---|
| `policy` | `policy:<spec>` | each default invariant policy of this run |
| `operation` | `operation:<METHOD> <path>` | each operation in `handout/openapi.json` |
| `rule` | `rule:<id>` | each invariant statement in `handout/INVARIANTS.md` |

**The resolved manifest is in `handout/obligations.json`** — every id, its
source, its statement, and any `approved_skip_reasons` it carries. Read it
first. Every `obligation` you name in a record must be an id from that file; a
record naming anything else is an `unknown_obligation` defect.

Every obligation ends in exactly one status:

| Status | How it is reached |
|---|---|
| `covered` | a `rule` obligation with at least one **exercised** check tracing to it; an `operation` obligation with at least one matching request in the recorded HAR; a `policy` obligation the gate found **applicable** |
| `skipped` | `check.skip` citing one of that obligation's approved reasons |
| `unsupported` | `check.unsupported` citing an approved reason |
| `unaccounted` | anything else — including a skip whose reason is not approved |

**An unaccounted obligation fails soundness regardless of how many checks
ran.** This is the termination condition: not green checks, but "every
obligation accounted for, no defects, every check exercised".

Note what falls out of the operation row: an operation obligation is covered by
*traffic*, so exercising an endpoint at all covers it. A policy obligation is
covered by the policy being **applicable** — a declared policy that matched no
recorded request fails and leaves its obligation unaccounted.

## 7. The report and the artifacts

One execution writes exactly two files, both into `run-out/`:

| File | What it is |
|---|---|
| `run-out/har.json` | the recorded traffic, in HAR 1.2. `log.entries[N]` is the entry your `ref` N cites. |
| `run-out/script-report.json` | the report below. |

Your script never writes an artifact itself. The HAR is recorded by the parent
as each exchange completes; the report is assembled by the parent from the
records you streamed plus the columns it computed.

```
script_report_version, contract_version
script      { path, sha256, bytes }
run         { started_at, finished_at, duration_ms, base_url, allowed_origins,
              mode, write_grant, budget: { limit, used, remaining }, timeout_ms,
              secrets_declared, params, exit }
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

Defect kinds you may see: `script_reported`, `threw`, `unhandled_rejection`,
`uncaught_exception`, `load_failed`, `contract_violation`, `timeout`,
`budget_exhausted`, `guard_refusal`, `evidence_unresolvable`,
`unknown_obligation`, `duplicate_check_id`, `report_contradiction`,
`no_report`, `harness`.

## 8. The verdict, and what "unsound" means

Two columns:

- **the HAR column** (`gate`) — this run's invariant policies evaluated over
  the recorded traffic. It is machinery you do not author and cannot influence
  except by what you exercise: it can fail on traffic *you chose to make*, for
  example when a request provokes a status the document does not declare for
  that operation. A failed policy is not a defect and does not make the run
  unsound; read `gate.checks` and decide whether it is a finding about the API.
- **the report column** (`checks`, `defects`) — no failing check and no defect.

```
verdict.pass = report_pass ∧ gate_pass ∧ soundness.ok
```

| Exit | Meaning |
|---|---|
| `0` | pass |
| `1` | **sound**, and a column failed — a failing check with evidence, or a policy the traffic violated |
| `2` | **unsound** — the run cannot be believed either way |

**Unsound** means at least one of: a defect of any kind, a check reported as
not exercised, or an obligation left unaccounted. `soundness.reasons` names
each one, in those words. An unsound run is not a verdict about the API; it is
a verdict about the suite.

**Exit 1 is a supported outcome.** A failing check on a sound suite is a
finding, not a bug in your suite: the API being broken is what this exercise is
for. Read the evidence in `har.json`, and revise a check only when the
*expectation* was wrong — never to make a genuine violation go away.

## 9. Your process

The suite runs as `node` in a locked-down child process. Before your module is
imported the process:

1. deletes `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest`, and friends —
   `client` is the only way out;
2. permits only these built-ins:
   `node:assert`, `node:assert/strict`, `node:buffer`, `node:crypto`,
   `node:events`, `node:path`, `node:path/posix`, `node:punycode`,
   `node:querystring`, `node:string_decoder`, `node:timers/promises`,
   `node:url`, `node:util`, `node:zlib`;
3. permits file specifiers only inside your scratch directory;
4. replaces `process.env` with a frozen empty object.

So `node:fs`, `node:net`, `node:http(s)`, `node:dns`, `node:tls`,
`node:child_process`, `node:worker_threads`, `node:module` and `node:vm` are
unavailable, as is every bare dependency specifier and every `data:` or
`https:` module URL. **There are no dependencies. Write plain Node 20+ ESM.**

`console.log` works and is captured; it is for your own debugging and gates
nothing. The report, not stdout, is the artifact.

## 10. Running it

```sh
./run.sh                 # execute suite.mjs; artifacts land in run-out/
./run.sh --read-only     # observation pass: GET/HEAD only, smaller budget
```

`run.sh` prints a summary — requests used, checks passed and failed, defects,
the obligation tally, the gate column, and the exit code — and leaves the two
artifacts for you to read. It is self-contained: you never need to look outside
your scratch directory to run it.

## 11. Budgets

| Budget | Limit |
|---|---|
| Requests in **one execution** | **360**, enforced on the wire. Past it nothing is forwarded and the run is unsound. |
| Wall clock for one execution | 10 minutes. The process is killed at the ceiling and reports a `timeout` defect; the HAR flushed so far survives. |
| One request | 15 seconds, then the request records a `transportError`. |
| **Executions** while authoring | **12** |
| **Wall clock** while authoring | **3 hours** |
| **Requests total** while authoring | **1 500** against the development instance |
| Read-only observation pass (proposal trial only) | **60** requests, 30 minutes, `GET`/`HEAD` only |

The observation pass is not scored for soundness: its obligations are expected
to be unaccounted, because it exists to look, not to prove.

A healthy full suite against this API costs on the order of 270–300 requests
per execution, so the 360 ceiling is a guard rail, not a target. Spend requests
on reaching real state; do not spend them enumerating a response shape you have
already seen.
