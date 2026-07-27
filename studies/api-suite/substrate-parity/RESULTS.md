# Substrate parity — the S1 runner does not distort the P1 instrument

**Question (BUILD_PLAN S1 exit gate):** the P1 agent-suite scenarios, ported to
the script contract and executed through the new runner — does the bench score
the resulting HAR the way it scored P1's?

**Answer: yes, on every comparable measure.** 285 requests per build (P1: 285),
the same detection in the same oracle for every held-out fault, zero false
positives on the clean build, and the two P1 misses still missed. Run manually
on 2026-07-26; re-runnable with the command below.

**Re-run at the S0 freeze**, after the OpenAPI document was corrected to declare
the `400` it really answers (`PREREGISTRATION.md` tuning log, `spec-400`):
identical result — `parity: MATCH`, 5 of 5 labelled builds, 0 mismatches, 285
requests per build, and the clean build sound with 0 failing checks at
**exit 0**. The spec change is invisible here by construction: this run passes
no spec to the runner, so its gate column is `no_server_error` alone. The
spec-driven gate is exercised instead by the S0 trial harness, where the same
ported suite on the clean build now reports `gate pass — 4 of 4 policies
applicable`, exit 0 (`../HARNESS-DRYRUN.md` §3).

## Result

| Build | Requests | Oracle detected | Evidence correct | FP | Oracle | vs P1 |
|---|---|---|---|---|---|---|
| `clean` | 285 | — | — | 0 | — | (P1 recorded no clean comparator trace) |
| `f-cursor-error-bare` | 285 | yes | yes | 0 | `error_shape` | **match** |
| `f-close-pending-inbound` | 285 | yes | yes | 0 | `lifecycle` | **match** |
| `f-settle-failed-debit` | 285 | no | no | 0 | — | **match** |
| `f-idempotency-day-expiry` | 285 | no | no | 0 | — | **match** |
| `f-fee-double-charged` | 285 | yes | yes | 0 | `conservation` | **match** |

Compared field by field (`detected`, `evidence_correct`, `false_positives`,
`off_target_violations`, and the set of firing oracles) against the frozen
`studies/api-probe/rounds/heldout-1/scores-comparators.json` agent-suite rows.
`parity: MATCH`, 5 of 5 labelled builds, 0 mismatches.

Because the bench now reads a second column, this run also reproduces the P1
report §3 observation directly instead of by reading a log:

| Column | Detections |
|---|---|
| oracle-confirmed in traffic | **3 / 5** |
| reported with correct evidence | **4 / 5** |
| reported without resolvable evidence | 0 |
| false positives (either column, clean build) | **0** |

`f-settle-failed-debit` is the difference, exactly as in P1: the suite names the
offending ledger row and cites the requests that prove it; the shared oracle's
applicability window never opens. This is the whole reason verdicts are
two-column (DESIGN N10) — and the S1 report is what makes the second column
machine-readable rather than a paragraph in a report.

## What was ported, and what deliberately was not

`suite/` is the P1 arm (`studies/api-probe/comparators/agent-suite/`, frozen) at
the script contract. **Byte-for-byte unchanged:** `lib/api.mjs`,
`lib/expect.mjs`, `lib/ledger.mjs`, and all five `scenarios/*.mjs` — the code
that decides what traffic to send and what counts as a violation. **Adapted:**

| File | Change |
|---|---|
| `lib/client.mjs` | `fetch` → the injected client; hard-coded bearer tokens → `client.secret(NAME)`; the entry keeps the harness's HAR `ref` beside its own index. The rule-5 response audit is unchanged. |
| `lib/report.mjs` | the arm's collection and dedupe are unchanged; `finalize()` emits it into the check channel — one failing check per distinct violation with its HAR citations, one passing check per rule that held, setup failures into the script-defect channel, warnings into advisories. |
| `index.mjs` | `run.mjs` without its process concerns: no `process.exit`, no printed report, budget and seed from `params`. |

Three substrate differences are worth recording because they are *behaviour
changes the parity result had to survive*:

1. **Path resolution.** P1 concatenated `base + path`; the first draft of the
   proxy used `new URL(path, base)`, which turned the suite's hostile
   `GET //accounts` probe into a protocol-relative jump to `http://accounts`
   (refused by the egress guard, 271 requests instead of 285, one guard defect).
   Fixed in the substrate, not in the port: a specifier without a scheme is a
   **path**, appended to the base URL. That is both faithful and safer — a
   protocol-relative path can no longer address another host at all.
2. **Credentials are references.** The `authorization` header is
   `[secret:LEDGER_CUSTOMER_TOKEN]` in the HAR rather than the literal dev
   token. No oracle reads request headers, so scoring is unaffected; the profile
   gains "which secret this suite used", and the token is absent from every
   artifact.
3. **Check ids must be unique.** The port initially collapsed two violations of
   one rule with different dedupe subjects into one id. The substrate now reports
   a `duplicate_check_id` defect and the port includes the arm's dedupe key in
   the id.

Not ported: the arm's terminal printing (`printReport`), which the report
channels replace, and its own `MAX_REQUESTS` enforcement, which now *also* runs
at the wire (350 in the suite, 360 at the proxy — the P1 configuration exactly).

## Reproducing

```sh
export LEDGER_FIXTURE="$LEDGER_FIXTURE_DIR/server.js"     # the ledger fixture
export LEDGER_BENCH="$LEDGER_FIXTURE_DIR/bench/bench.js"
node studies/api-suite/substrate-parity/run-parity.mjs
```

`LEDGER_FIXTURE_DIR` is the fixture directory named in `studies/api-suite/README.md`
(a study source file may not contain that path — `tests/repository/boundaries.test.js`).
Artifacts land in `out/` and are **not committed**: the HAR is sensitive by
policy and the run is reproducible from the committed suite.

Pins for this recording:

| Pin | Value |
|---|---|
| substrate | `script_report_version: 1`, `contract_version: 1`, this repo at `5ec0194` + the S1 commits |
| budget | 360 at the wire, 350 in the suite |
| seed | `ledger-dev-seed`, out-of-band reset before each build (as P1 did) |
| bench oracles | `oracles.js` sha256 `04a3c69f…`, `trace.js` sha256 `8d822ce6…` — the frozen P1 copies |

## One interop note for the S0 prereg — resolved

The bench's suite-report reader counted obligations from a top-level
`obligations` array, while the S1 report carries `obligations.summary` +
`obligations.entries` (the schema is `src/core/schemas/script-report.schema.json`),
so the bench's `report.obligations` count read `0` for these runs. Detection and
the funnel were never affected. **Fixed in `480b85e`**, before the S0 freeze: the
reader understands the nested manifest, and the freeze re-run reports
`obligations: 8, unaccounted: 0` per build (one policy obligation — this run
passes no spec — plus the seven ported rules).
