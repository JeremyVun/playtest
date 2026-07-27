# Target authorization — S0 study fixture

The DESIGN §4 step 2 declaration for every target this study writes to. It is
the recorded answer to *"safe to write test data to this environment?"*, and it
is what licenses a script run to leave `read-only`
(`docs/contracts/scripts.md` — mode is authorization, never code).

The harness cites this record in the `write_grant` of every run it configures:
`studies/api-suite/scripts/lib/handout.mjs` → `TARGET_AUTHORIZATION`.

| Field | Value |
|---|---|
| **Declared** | 2026-07-26 |
| **Owner** | this study. The target is the purpose-built ledger fixture (`$LEDGER_FIXTURE_DIR`), which exists only to be tested and belongs to no one else. |
| **Origins covered** | loopback instances of that fixture only: `http://127.0.0.1:<port>`, one dedicated instance per build or per trial, started and stopped by the harness. |
| **Write grant** | **yes** — create accounts, deposit, transfer, settle, cancel, close, tick the clock, and reset. |
| **Reset affordance** | `POST /admin/reset` with `{"seed":"ledger-dev-seed"}` restores full seeded state. Every run starts from one. |
| **Data at risk** | none. The fixture is in-memory, seeded, deterministic, and disposable; killing the process destroys everything it held. |
| **Credentials** | three throwaway fixture bearer tokens with published defaults — `LEDGER_ADMIN_TOKEN` (the administrator) and `LEDGER_CUSTOMER_TOKEN` / `LEDGER_CUSTOMER_B_TOKEN` (two distinct customer principals) — injected by name as `PLAYTEST_SECRET_*` references by the harness (`scripts/lib/handout.mjs` → `STUDY_SECRETS`), never written into a scratch directory. They authorize nothing outside the fixture. |
| **Expiry** | this record covers the S0 study only, and ends when S0's report is committed. |

## What it does not authorize

- **Any origin other than the loopback fixture.** The runner refuses a grant
  whose origin differs from the one a run resolves, and this study configures
  no `allowed_origins`, so a request off the target origin is refused at the
  wire and recorded as a defect.
- **A shared or long-lived instance.** Isolation is the harness's job
  (`PREREGISTRATION.md` §8.2): one dedicated instance per build, a seeded reset
  immediately before the suite starts, teardown after. No run inherits another
  run's state.
- **Anything during the proposal trial's observation pass.** That pass carries
  no write grant at all: it runs `read-only`, and a mutation is refused on the
  wire and recorded (`PREREGISTRATION.md` §7.3).

## Why it can be this short

The safety model's expensive question — "whose data is this, and what breaks if
a test suite mutates it?" — has a trivial answer here, deliberately. DESIGN §6
made the fixture purpose-built and disposable precisely so that authorization
is a recorded fact rather than a negotiation, and so the study measures suite
authoring rather than a team's willingness to grant write access. A real user's
first target will not be this easy, which is why the grant is *recorded* rather
than assumed even when the answer is obvious.
