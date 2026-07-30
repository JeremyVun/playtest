# PINS — artifact SHAs frozen as gates close

Companion to [`PREREG.md`](./PREREG.md) (G0 commit `e60bf78`, parent
`d928b74`). Each row is recorded when its gate closes and never edited after
measured data exists.

| Gate | Artifact | Frozen at commit | Date |
|---|---|---|---|
| G0 | PREREG.md + protocol (design doc as of that commit) | `e60bf78` | 2026-07-30 |
| — | Harness scripts + prompts (pre-freeze drafts; prompt SHAs freeze at G4) | `07e35dd` | 2026-07-30 |
| G1 | Subject app `subject/` (Loanpoint) — app, SPEC.md, tests, README | `7f45ff3` | 2026-07-30 |

## G1 notes

- Subject authored by a fresh-context opus-5 subagent (contamination matrix
  respected); lead audit: 112/112 tests green offline, `examples/`-boundary
  grep clean, server boot on :4620, all 7 routes + validation + `__reset` +
  `__build` probed, browser-layer ARIA click-through green.
- Test invocation pin: `node --test "studies/detection-web/subject/tests/*.test.js"`
  (bare-directory form is broken on Node v25.8.2 — upstream Node issue, both
  forms documented in the subject README).
- Clean build fingerprint: `GET /__build` → `{"app":"Loanpoint","variant":"clean","now":"2026-03-16T09:00:00Z"}`.
