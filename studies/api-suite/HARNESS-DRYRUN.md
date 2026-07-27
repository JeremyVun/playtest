# Harness dry run — the trial machinery, end to end, with no model

Run before the freeze, on the apparatus only: does the path from *assemble a
handout* to *a scored round* work, and does it work the way the preregistration
says it does? No model was called, no measured trial was run, and nothing here
is evidence about suite authoring. It is evidence about the instrument.

- **Date:** 2026-07-26
- **Checkout:** `40f7360` (dirty — three lanes were working in it; a measured
  round runs on a clean tree)
- **Re-run at the freeze, same day, on the freeze tree:** step 2 end to end
  against the corrected OpenAPI document, plus a credential probe. Both are
  recorded below, in place, rather than replacing the original numbers.
- **Stand-in for an authored suite:** `studies/api-suite/substrate-parity/suite`
  — the frozen P1 agent-authored arm, ported to the script contract. It is the
  only suite in the tree that was written by an agent against this API, so it
  is the closest available stand-in for a trial's output.
- **Stand-in for the statement set:** a throwaway 7-rule stub, written for this
  run and deleted after it, whose section titles derive the rule ids the ported
  P1 suite already speaks (`conservation`, `idempotency`, `lifecycle`,
  `pagination`, `errorshape`, `balance`, `contract`). The study's own
  `INVARIANTS.md` is authored in a separate lane; it parses cleanly with the
  same parser (13 rules, each with an applicability paragraph), but its
  vocabulary is not the ported suite's, so pairing them would have measured a
  vocabulary mismatch instead of the harness.
- **Scratch:** a temporary directory outside the checkout, removed afterwards,
  as a trial's scratch directory will be.

## What ran

```
make-handout.mjs  --dir <scratch>/t-dry --base-url http://127.0.0.1:4185 --invariants <stub>
<scratch>/t-dry/run.sh                                  # the trial's own command
replay-round.mjs  --recorder runner --arm dry --seed dryrun-1
                  --clean-repeats 1 --jitter-repeats 0 --variants terse-optionals
                  --faults f-fee-double-charged,f-close-pending-inbound
```

## Result

**1. Handout assembly.** 27 obligations derived — 4 policy, 16 operation,
7 rule — and written to `handout/obligations.json` beside the brief, the
contract, the statements and the served OpenAPI document. `run.sh` came out
executable, with the interpreter path, the wrapper path and the base URL baked
in and no credential in it. `handout-manifest.json` carries a sha256 per file.

**2. One execution through `./run.sh`, clean build.**

```
requests      285 of 360        (0.6 s)
checks        7 — 7 passing, 0 failing
obligations   27 covered, 0 skipped, 0 unsupported, 0 UNACCOUNTED (of 27)
gate          FAIL — 4 of 4 policies applicable      <- fixed at the freeze; see 3
defects       0
verdict       FAIL (sound)   exit 1                  <- now PASS / exit 0
```

- **Every obligation was accounted for**, including all sixteen spec
  operations: the ported suite touches the whole documented surface, so the
  operation row of the manifest is reachable rather than aspirational.
- 285 requests is the same figure P1 recorded for this arm under the same
  360-request wire budget, so the budget is not distorting the instrument.
- Both artifacts landed in `run-out/` (`script-report.json`, `har.json`), plus
  the wrapper's own `stdout.log`.

**3. The one failure — a real gap in the document, fixed at the freeze.** The
HAR column failed on `documented_status`:

```
GET /accounts/%zz answered 400, which the spec does not declare for
GET /accounts/{accountId} (declared: 200, 401, 403, 404, 410)
```

The suite deliberately probes a malformed identifier; the fixture answers `400
invalid_request`; the document did not list `400` for that operation. This is
**not** a preregistered false positive: §6.3 defines column-1 false positives
as *bench oracle* violations and column-2 as *failing checks*, and the bench
scored zero of each on every clean and conforming trace (below). It is the
script runner's own gate column, which the bench does not read.

> **Resolved at the freeze** (`PREREGISTRATION.md` tuning log, `spec-400`).
> Seven operations were found — by exercising every operation's malformed-input
> paths against a running clean fixture — to answer `400` without declaring it:
> `GET /accounts/{accountId}`, `POST /accounts/{accountId}/activate`,
> `POST /accounts/{accountId}/close`, `GET /deposits/{depositId}`,
> `GET /transfers/{transferId}`, `POST /transfers/{transferId}/cancel`,
> `POST /admin/reset`. Each now declares `400` through the document's existing
> `BadRequest` component. **The gate was not weakened** — all four Level 0
> policies stand as shipped. Re-running this dry run's step 2 end to end on the
> fixed document, with the same stand-in suite and the same stub statement set:
>
> ```
> requests      285 of 360        (0.6 s)
> checks        7 — 7 passing, 0 failing
> obligations   27 covered, 0 skipped, 0 unsupported, 0 UNACCOUNTED (of 27)
> gate          pass — 4 of 4 policies applicable
> defects       0
> secrets       LEDGER_ADMIN_TOKEN, LEDGER_CUSTOMER_B_TOKEN, LEDGER_CUSTOMER_TOKEN
> verdict       PASS   exit 0
> ```
>
> Everything else is unchanged from the numbers above; the only differences are
> the gate column, the exit code, and the third credential (below).

**4. A scored round.** Four builds — `clean`, `clean.terse-optionals`, and two
fault builds — in seeded random order recorded before the first build ran,
each on its own fixture instance with a seeded reset immediately before the
suite, torn down after.

```
trace                    label                    req  oracle  reported  strict  funnel     diagnosis
clean                    clean                    285  –       –         –       –          –
clean.terse-optionals    clean.terse-optionals    285  –       –         –       –          –
f-close-pending-inbound  f-close-pending-inbound  285  y       y         y       y y y y y  none
f-fee-double-charged     f-fee-double-charged     285  y       y         y       y y y y y  none

faults detected: 2/2
false positives — oracle: 0 across 2 conforming traces; reported: 0 failing checks
```

Both columns and all five funnel stages came out of the S1 `script-report.json`
and the runner-written `har.json` with no adapter and no flag: the bench finds
`script-report.json` in a run directory on its own. Citation checking worked
as specified — of the six checks attributed to `f-fee-double-charged`, three
are marked *on target* and three *resolve but NOT on target* (whole-world
arithmetic citing the enumeration rather than the offending transfer), which is
exactly the distinction the strict column exists to draw.

**5. Read-only mode refuses a mutation at the wire.** A two-request probe run
through `./run.sh --read-only`:

```
requests      1 of 60
guard         read_only: POST /accounts
defects       1 (guard_refusal)
har.json      1 entry — GET /health only
```

The `POST` produced **no HAR entry and no network I/O**; the script saw
`ScriptClientRefused/read_only`; the budget was the observation pass's 60, not
360. The proposal trial's phase-1 handout defaults to this mode: `make-handout
--proposal` bakes `S0_MODE=read-only` into `run.sh`, and re-issuing with
`--proposal --statements` after adjudication regenerates it without the flag
and adds `handout/INVARIANTS.md`.

## How `run.sh` keeps a trial out of the repository

The trial agent's whole world is its scratch directory. `run.sh` contains an
absolute interpreter path, an absolute path to `trial-run.mjs`, and the target
base URL — so executing it needs no repository read, and reading it discloses
nothing but two paths. Everything the runner needs at execution time it takes
from the scratch directory itself: `suite.mjs`, `handout/openapi.json`,
`handout/INVARIANTS.md`. Credentials never appear in `run.sh`: it carries at
most the *path* of a secrets file, which `trial-run.mjs` reads in the parent
process, outside the script sandbox, and injects by name.

`handout/obligations.json` is what removes the last reason to look outside:
without it a trial would have to guess the obligation-id strings a check must
name, and would burn executions discovering them.

## Items for the freeze

*All five were dispositioned in the freeze commit; each is marked below.*

1. **§7.2 has no per-execution timeout.** The runner needs one. The harness
   uses **600 000 ms** (`STUDY.timeoutMs`), which is ~1 000× the observed
   execution time. Record it in §7.2 or override it deliberately.
   → **Recorded in §7.2 as 600 000 ms.**
2. **§3 must pin the gate's policy set.** This harness passes the resolved
   OpenAPI document to the runner, so Level 0 for a measured run is
   `no_server_error` + `documented_status` + `response_schema` +
   `content_type`, exactly as `docs/contracts/scripts.md` specifies for a run
   with a spec. Consequence, evidenced above: **a clean build can exit 1** for
   a suite that provokes an undocumented status. That is not a preregistered
   false positive and not a soundness failure, and both `BRIEF.md` ("exits
   sound") and `CLIENT.md` §8 already state the termination condition as
   soundness rather than exit 0 — but the round manifest will show `exit: 1`
   on clean builds and a reader must not misread it. The alternatives are to
   pin the four policies as they are (recommended: it is the shipped default,
   and changing it makes S0 measure something S1 does not ship) or to pin
   `no_server_error` only. Either way, §3 says which, and the choice is a
   tuning-log row.
   → **The four are pinned as shipped**, and the document was fixed rather than
   the gate weakened, so a *conforming* build no longer exits 1 at all
   (tuning-log rows `spec-400` and, for the pin, §3).
3. **§3 must pin the statement-set → rule-obligation derivation.** Rule ids
   come from `INVARIANTS.md` section headings via
   `scripts/lib/handout.mjs` → `parseInvariantRules` (heading slug, or an
   explicit `{#id}` / `` `rule:id` `` in the heading, or an
   `INVARIANTS.rules.json` sidecar that overrides the prose). The study's
   `INVARIANTS.md` currently derives thirteen ids, none of which carries
   `approved_skip_reasons` — so **no skip is approvable** and every obligation
   must be covered outright. If the freeze wants approvable skips, they go in
   the sidecar before it.
   → **Pinned in §3 with the thirteen ids listed. No sidecar exists and none
   may be added, so no skip is approvable.** A statements-trial handout resolves
   to 33 obligations: 4 policy, 16 operation, 13 rule.
4. **Bench pins are out of date on this tree.** `verify-instrument.mjs` fails
   on `lib/suite-report.js`, `lib/witnesses.js` and `src/faults.js`; the
   fixture lane was mid-change during this dry run. `npm run bench:pins --
   --write` in the fixture package, then a green `verify-instrument.mjs`, is a
   freeze precondition (§10 step 3).
   → **Re-recorded (`5e2ff0e`); `verify-instrument.mjs` green at the freeze.**
   `shared_oracle` unchanged, still byte-identical to P1's.
5. **Model id, decoding configuration and retry policy** remain the only §3
   rows no tool can fill. `scripts/fingerprints.mjs` prints them as
   PLACEHOLDER rows and fills everything else, including a single
   `substrate digest` over all pinned files.
   → **Filled at the freeze:** `claude-opus-5`, run as a fresh Claude Code sub
   agent per trial; **platform-default decoding** (no override is available to
   the operator at this seam, and §3 records that as a limitation rather than
   claiming a setting); **no automatic retries** anywhere in the measured path.
   The pinned set is 54 files, not 55: `PREREGISTRATION.md` was removed from it,
   because a file cannot be inside the digest set it records.

## Credentials: both customer principals inject and authenticate

Added at the freeze, on the same machinery and still with no model
(tuning-log row `creds-2`). A two-account probe through a generated handout's
`./run.sh`:

```
names: LEDGER_ADMIN_TOKEN,LEDGER_CUSTOMER_B_TOKEN,LEDGER_CUSTOMER_TOKEN
POST /admin/reset       admin      -> 200
GET  /accounts          (none)     -> 401 unauthorized
POST /accounts          customer   -> 201 owner_principal = "customer_a"
POST /accounts          customerB  -> 201 owner_principal = "customer_b"
GET  A's account        customer   -> 200
GET  A's account        customerB  -> 403 forbidden
GET  B's account        customer   -> 403 forbidden
GET  B's account        admin      -> 200
```

Two distinct principals, each reachable, each refused on the other's resource,
and the admin unrestricted — which is what makes the `authorization` taxonomy
category measurable (`PREREGISTRATION.md` §4.3). No literal token appears in
`har.json`: the three references are recorded as `[secret:…]` placeholders.

## Cleanup

The scratch directories, the stub statement set and every fixture instance were
removed. Nothing generated by these runs is committed.
