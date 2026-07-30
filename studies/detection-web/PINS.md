# PINS — artifact SHAs frozen as gates close

Companion to [`PREREG.md`](./PREREG.md) (G0 commit `e60bf78`, parent
`d928b74`). Each row is recorded when its gate closes and never edited after
measured data exists.

| Gate | Artifact | Frozen at commit | Date |
|---|---|---|---|
| G0 | PREREG.md + protocol (design doc as of that commit) | `e60bf78` | 2026-07-30 |
| — | Harness scripts + prompts (pre-freeze drafts; prompt SHAs freeze at G4) | `07e35dd` | 2026-07-30 |
| G1 | Subject app `subject/` (Loanpoint) — app, SPEC.md, tests, README | `7f45ff3` | 2026-07-30 |
| G2 | Story suite `suite/` — 13 journeys + 2 risk discovery cases + playtest.yaml + init.sh | `f7100b6` | 2026-07-30 |

## G1 notes

- Subject authored by a fresh-context opus-5 subagent (contamination matrix
  respected); lead audit: 112/112 tests green offline, `examples/`-boundary
  grep clean, server boot on :4620, all 7 routes + validation + `__reset` +
  `__build` probed, browser-layer ARIA click-through green.
- Test invocation pin: `node --test "studies/detection-web/subject/tests/*.test.js"`
  (bare-directory form is broken on Node v25.8.2 — upstream Node issue, both
  forms documented in the subject README).
- Clean build fingerprint: `GET /__build` → `{"app":"Loanpoint","variant":"clean","now":"2026-03-16T09:00:00Z"}`.

## G2 notes

- Story author (fresh opus-5) saw only `SPEC.md` + authoring skill docs/schemas;
  never subject source or harness. Suite frozen before any catalog work exists.
- Deliberate authoring decisions on record: no `api_called` gates (the SPEC
  documents no application API surface, and a guessed gate could red on clean);
  known coverage gaps left standing — §11 not-found surfaces, expired-draft
  recovery, the R11 refusal branch, and list empty states have no dedicated
  case. Coverage gaps are study signal, not defects to patch post-freeze.
- Both arms receive the identical story/persona text; the per-case `init.sh`
  reset is arm P suite config, and arm C gets one `POST /__reset` before each
  of its rounds (fresh-session symmetry, per protocol).
- Shakedown watch item: hosted runner must honor `app.init` (uploaded via
  suite commit — exec-bit/materialization verified at G4).
