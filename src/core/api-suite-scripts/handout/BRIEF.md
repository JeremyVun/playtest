# Brief: author a script suite for this API

You are testing an HTTP API you have never seen the source of. Your job is to
write one script suite that tries to prove the stated rules wrong — and that
accounts for every obligation the rules and the API surface create.

Where this brief is silent, `CLIENT.md` is the authority on the script contract.

## What you are given, and nothing else

- `openapi.json` — the service's OpenAPI document, resolved for this run.
- `INVARIANTS.md` — the approved rule statements: the rule, where it applies,
  its declared exceptions, and any note the API's owner attached to it.
- `CLIENT.md` — the script contract: the entry shape, the injected `client`, the
  `check` API, the report, and the obligation manifest.
- `obligations.json` — **every obligation id this run is judged against**. Read
  it first. An `obligation` you name that is not in that file is a defect.
- A live instance to develop against, at `{{target}}`, in `{{mode}}` mode.
- Credentials exist only as secret references (`CLIENT.md` §3). You can cause an
  authenticated request; you can never read a credential value, and a literal
  credential in your source blocks the run outright.

{{reset}}

## How this works

This is a batch loop, not a conversation and not a shell. Each turn:

1. You return **one complete `suite.mjs`** — the whole file, every time, never a
   patch and never a fragment.
2. The loop executes it against the target and computes the report.
3. You get the report's digest back and return the whole file again.

You cannot run commands, read files, or fetch anything. The only thing that
happens between your turns is one execution of exactly what you returned.

### What to return, exactly

Two fenced blocks, in this order and nothing else outside them:

````
```json
{
  "notes": "what you changed this turn and why, in a sentence or three",
  "revisions": [
    { "check": "check-id", "change": "what changed about it",
      "citation": "rule:lifecycle — a settled transfer is terminal" }
  ]
}
```

```js
…the complete suite.mjs…
```
````

`revisions` is where the loop's one hard governance rule lives, below. On the
first turn it is empty.

## Hard rules

1. All traffic goes through the injected `client`. Ambient `fetch`, `node:http`,
   and friends do not exist in your process and any attempt is recorded as a
   defect.
2. Plain Node 20+ ESM, zero dependencies, one file, default-exporting the
   contract entry (`CLIENT.md` §1).
3. Start every execution from a known state, and make the suite order
   deterministic. No check may depend on another beyond that initial state.
4. Robustness is on you: a 500, a malformed body, a missing field, or a hang
   must produce a clear check **failure**, never an unhandled crash. A crash is
   a defect and makes the whole run unbelievable.

## Soundness is the termination condition, not green checks

The loop stops when the run is **sound**, whatever the checks say. Sound means:

- no script defects,
- every check actually exercised,
- **every obligation in `obligations.json` accounted for** — covered by an
  exercised check, skipped with a reason that obligation approves, or marked
  unsupported,
- and every *failing* check citing at least one HAR entry that resolves.

An unaccounted obligation makes the run unsound no matter how many checks
passed. A suite of six perfect checks against thirty obligations is a failure
of this exercise.

## A failing check is a finding, not a bug in your suite

When a check fails, read its evidence in the report digest. Then decide, and the
decision is governed:

- **The API is wrong** → leave the check failing, with its evidence. Say so in
  `notes`. This is a supported, expected, valuable outcome: the loop terminates
  sound with your finding intact, and a human judges it.
- **Your expectation was wrong** → you may revise the check, and you must record
  it in `revisions` with a `citation` that begins `spec:` or `rule:` and quotes
  the fragment that justifies the new expectation. A revision without a citing
  justification is **rejected**: the loop keeps your previous draft and asks
  again, and the turn is spent.
- **Your suite was broken** (it built the wrong state, passed a header wrong,
  miscounted) → fix it and record it in `revisions` with a plain explanation.
  No `spec:`/`rule:` citation is required to fix your own bug, but the entry is.

### When a rule and the document disagree

**The approved rule statement wins.** `INVARIANTS.md` is what the API's owner
declared their system must do; `openapi.json` is what someone wrote down about
it, and it can be as wrong as the implementation. If the document's text would
excuse behaviour a rule forbids, that conflict *is the finding* — report the
failing check, and note the conflict. Do not resolve it silently in the
document's favour. (In the study this protocol comes from, two of four authors
lost a real defect exactly here.)

## What makes a suite worth running

- **Spend your first execution looking, not asserting.** A recon pass that
  makes real calls and records advisories costs one turn and buys you the
  service's actual vocabulary — its status codes, its error envelope, its
  identifiers, which principal is which. Every author who ran this protocol did
  this, and the ones who skipped straight to assertions burned a turn on
  guessed status codes instead.
- **Reach real state.** Create, transition, and compose. Prefer a check that
  drives a resource through its lifecycle over a check that inspects the shape
  of one response. The suite runs unattended against builds you have never
  seen, some deliberately defective: write it so a failure is informative and a
  pass means something.
- **Enumerate the space, do not sample it.** Both currencies, both principals,
  empty and populated pages, the boundary and one either side. Enumeration is
  the whole reason this approach beats a live explorer.
- **Never write a check that cannot fail.** "The list of violations is empty" on
  an empty list is a pass that proves nothing. Assert that the population you
  scanned was non-empty in the same check, or in a sibling check that guards it.
- **Put destructive and privileged probes last.** Reset, delete, and admin
  probes go after everything whose state they could destroy — including on a
  build where they behave differently than you expect.
- **Cite evidence on every check.** A failing check that cites nothing is worth
  nothing to a reviewer, and the loop will not terminate on one. Cite the
  exchanges that *built* the state too, when the failure is only legible in
  sequence.

## Budgets

| Budget | Limit |
|---|---|
| Requests in one execution | **{{execution_budget}}**, enforced on the wire |
| Wall clock for one execution | {{execution_timeout}} |
| Turns (executions) for the whole job | **{{iterations}}** |
| Requests for the whole job | **{{requests}}** |
| Wall clock for the whole job | **{{wall_clock}}** |

Past an execution's request budget nothing is forwarded and the run is unsound,
so the recorded trace *is* the budget. Spend requests on reaching real state;
do not spend them re-reading a response shape you have already seen.

## Done means

One execution that is sound — every obligation accounted for, no defects, every
failing check backed by resolvable evidence — with your genuine findings, if
any, left failing.
