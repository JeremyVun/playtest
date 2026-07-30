# Detection-web fault catalog

Twenty seeded faults for the Loanpoint subject (`../subject`), the machinery to
build injected copies of it, and a runner that proves every fault is
mechanically live.

Nothing here modifies the subject: builds are written to a `--out` directory
and the clean tree stays untouched.

```text
catalog.json              the 20 fault cards (the judge reads `manifestation`)
faults/<id>.mjs           one patch module per fault: { id, patches[] }
build-injected.mjs        copy the subject, apply patches, wire build id + telemetry
manifestation/<id>.test.mjs   one manifestation check per fault
verify-catalog.mjs        proves clean-passes / injected-fails / withdrawn-passes
.verify/                  disposable scratch builds (gitignored)
```

## Build a variant

```sh
node build-injected.mjs --out /tmp/loanpoint-r1
node build-injected.mjs --out /tmp/loanpoint-r2 --withdraw f-out-filter-drops-overdue,f-cancel-button-missing
SUBJECT_PORT=4640 node /tmp/loanpoint-r1/server.js
```

The build

- copies the clean subject and applies every fault that is not withdrawn,
  checking that each patch target appears **exactly once** and aborting loudly
  otherwise;
- rewrites `GET /__build` to
  `{"app":"Loanpoint","variant":"injected","build_id":"<12 hex>","now":…}`.
  The build id is a salted digest of the sorted active fault ids — it is stable
  for a given fault set and discloses nothing about which faults are in it;
- writes `<dir>/build-meta.json` with the active list, the withdrawn list and
  the build id. It sits outside `public/`, so no route serves it;
- installs server-side trigger telemetry.

Everything the build adds is invisible over HTTP. `build-meta.json`,
`telemetry.mjs` and `telemetry.jsonl` all 404, no response header or body
mentions them, and no module under `public/` refers to them.

## Read the telemetry

Each active fault carries one probe: a predicate over the API request that was
just served (method, path, query, status, response body, and the desk state
after the handler ran). When the probe matches, one line lands in
`<dir>/telemetry.jsonl`:

```json
{"ts":"2026-07-30T07:54:43.803Z","fault_id":"f-late-fee-day-count","probe":"GET /api/overview"}
```

`ts` is wall-clock time (the desk clock stays frozen), `fault_id` is the fault
whose trigger path was exercised, and `probe` is the request that exercised it.
A fault with no line was never triggered; lines without a matching finding mean
the tester walked the path and did not notice. Purely client-side faults are
probed on the nearest server-observable signal — usually the page render or the
action request behind the interaction — and each card's `probe_note` says which.

```sh
node build-injected.mjs --out /tmp/loanpoint-r1
SUBJECT_PORT=4640 node /tmp/loanpoint-r1/server.js &
# …drive the tester…
sort -u /tmp/loanpoint-r1/telemetry.jsonl | cut -d'"' -f8 | sort | uniq -c
```

## Verify the catalog

```sh
node verify-catalog.mjs                       # all 20, JSON summary on stdout
node verify-catalog.mjs --only f-saturday-roll-short
```

For every fault the runner builds three variants on scratch ports from 4630
upwards (never 4620–4622) and shows three directions:

| Direction | Build | Expected |
|---|---|---|
| clean | every fault withdrawn | the check **passes** |
| injected | only this fault active (so any masker is withdrawn) | the check **fails** |
| withdrawn | full injection minus this fault and its masker chain | the check **passes** |

It also audits `catalog.json` against the frozen quotas and the masking rules.
The exit code is 0 only when all 20 faults are live on all three directions and
the audit is clean. Last run:

```json
{ "catalog": "detection-web", "faults": 20, "live": 20, "failing": [],
  "quota_problems": [], "masked": 2, "reachable_round_1": 18, "ok": true }
```

Faults whose wrongness is client-side rendering are checked as close to the
user as HTTP allows: the check drives the real path (so the probe fires and the
state is proven), then asserts the served module still contains the behaviour
the spec requires. Those cards carry a `check_note` naming the residual gap.

## The catalog

| # | id | flow | scope | trigger | recognition |
|---|---|---|---|---|---|
| 1 | `f-overview-units-total` | A Overview | surface/copy | natural path | plausible-but-wrong value |
| 2 | `f-late-fee-day-count` | A Overview | surface/copy | natural path | plausible-but-wrong value |
| 3 | `f-overdue-empty-state` | A Overview | surface/copy | empty state | obvious breakage |
| 4 | `f-charges-late-fee` | A Overview | multi-step flow | natural path | silent no-op |
| 5 | `f-equipment-empty-copy` | B Equipment | surface/copy | empty state | contradiction |
| 6 | `f-equipment-missing-message` | B Equipment | surface/copy | invalid/boundary | contradiction |
| 7 | `f-available-filter-ignored` | B Equipment | interaction | natural path | silent no-op |
| 8 | `f-out-filter-drops-overdue` | C Loans | interaction | natural path | contradiction |
| 9 | `f-cancel-button-missing` | C Loans | missing capability | recovery | obvious breakage |
| 10 | `f-cancel-confirm-noop` | C Loans | interaction | recovery | silent no-op |
| 11 | `f-extension-block-missing` | C Loans | missing capability | natural path | obvious breakage |
| 12 | `f-extend-limit-off-by-one` | C Loans | multi-step flow | invalid/boundary | contradiction |
| 13 | `f-bundle-threshold-off-by-one` | D New loan | multi-step flow | invalid/boundary | plausible-but-wrong value |
| 14 | `f-saturday-roll-short` | D New loan | multi-step flow | invalid/boundary | plausible-but-wrong value |
| 15 | `f-booking-error-swallowed` | D New loan | multi-step flow | async/failure | silent no-op |
| 16 | `f-booking-no-redirect` | D New loan | multi-step flow | async/failure | obvious breakage |
| 17 | `f-step2-remove-missing` | D New loan | missing capability | recovery | obvious breakage |
| 18 | `f-approve-pending-label` | E Approvals | interaction | async/failure | contradiction |
| 19 | `f-decline-status-line` | E Approvals | interaction | async/failure | silent no-op |
| 20 | `f-approvals-empty-action` | E Approvals | missing capability | empty state | obvious breakage |

### Quotas

| Scope | n | Trigger | n | Recognition | n |
|---|---|---|---|---|---|
| surface/copy | 5 | natural path | 6 | obvious breakage | 6 |
| interaction | 5 | invalid/boundary | 4 | silent no-op | 5 |
| multi-step flow | 6 | empty state | 3 | contradiction | 5 |
| missing capability | 4 | recovery | 3 | plausible-but-wrong value | 4 |
| | | async/failure | 4 | | |
| **total** | **20** | **total** | **20** | **total** | **20** |

By flow: overview 4, equipment 3, loans 5, new loan 5, approvals 3.
`verify-catalog.mjs` re-derives all three columns from `catalog.json` on every
run and fails if any of them drifts.

### Masking

Two faults cannot manifest in the round-1 full-injection build. Both chains are
one dependency deep; the cap is two.

| Masked fault | Masked by | Why |
|---|---|---|
| `f-cancel-confirm-noop` | `f-cancel-button-missing` | with no Cancel loan button there is no confirmation block to press |
| `f-extend-limit-off-by-one` | `f-extension-block-missing` | with no Extension block there is no way to spend the first extension, let alone a second |

**Round-1 reachable: 18 of 20** (the cap is at most 6 masked, so at least 14).
Withdrawing the two maskers exposes the other two for round 2.

### Independence

Every fault is exactly one minimal patch in one file — ten on the desk server
(`src/rules.js` ×5, `src/api.js` ×3, `src/present.js`, `src/time.js`) and ten in
the browser application (`public/views/*.js`). No two patches touch overlapping
text, so any subset composes: the build applies them in id order and every
`find` must still match exactly once, or the build aborts. No patch adds a
comment, marker, fault id or any other tell to code the browser can see; the
only difference a client can observe is the defect itself.
