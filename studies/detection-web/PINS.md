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
| G2′ | Suite config amendment: init.sh → init.mjs (hosted exec-bit; stories untouched) | `8aa7d4f` | 2026-07-30 |
| G3 | Fault catalog `catalog/` — 20 faults, injector, manifestation checks, telemetry | `cb6692b` | 2026-07-30 |
| G4 | Gate recalibration `d2bf39e`; prompts, driver fixes, QUIRKS.md, SCORING.md frozen at the commit recording this row | (this commit) | 2026-07-30 |

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

## G3 notes

- Catalog author (fresh opus-5) saw clean subject + SPEC + PREREG quotas;
  never the story suite. Quotas verified on all three axes; masking chains:
  `f-cancel-confirm-noop` ← `f-cancel-button-missing`,
  `f-extend-limit-off-by-one` ← `f-extension-block-missing` (both 1 deep);
  18/20 reachable in round 1.
- Lead audit: independent `verify-catalog.mjs` run green (20/20 live,
  three-direction checks), subject tree byte-untouched, boundary grep clean,
  four client-visible faults eyeballed in a real browser on the
  full-injection build (`build_id 3cc3a0a5ba33`).
- `/__build` on injected builds returns only the opaque build id; the
  active/withdrawn mapping lives in unserved `build-meta.json`; trigger
  telemetry appends to unserved `telemetry.jsonl` (diagnostic only).

## G4 notes (shakedown 2026-07-30; all fixes pre-measurement)

- **Environment pin added:** hosted boot requires absolute `PLAYTEST_DATA_DIR`
  and `PLAYTEST_SYNTHESIS_MODEL=gpt5_5` (the synthesis default tier is not
  servable by the codex gateway; consolidation/auto-resolve default
  `gpt5_6_terra` is servable and is left as the product default).
- **Harness fixes:** suite `init.sh`→`init.mjs` (`8aa7d4f`, exec-bit);
  journey-gate recalibration to the instrument's captured snapshot
  (`d2bf39e` — capture omits header/nav, bare-number table cells, below-fold
  content; app↔SPEC agreement confirmed, zero gate changes to stories);
  `arm-p-round.mjs` `--group` resume, synthesis 5xx retry, per-run `totals`
  metrics; `judge-merge.mjs` per-arm `--withdrawn-p/-c` overrides.
- **Clean-round results (harness green):** arm P 13 pass / 0 fail /
  2 explored, $9.79, 64 min, unattended end-to-end (det-sd3). Arm C finished
  by itself: 98 messages, 25 min, ~$10.8 priced-equivalent, 3 bugs (all
  clean-app quirks). Judge dry-run: 36 claims, 13 duplicates, **0 seeded**,
  4 latent, 19 invalid; ledger validates; no cross-arm merges.
- **Adjudication:** accepted quirks recorded in `QUIRKS.md` (3 latent
  new-loan validation defects; no subject rework). Scoring interpretation
  frozen in `SCORING.md` before any measured data.
- **Prompt/text SHAs (sha256/12):** `arm-c-brief.md 6b5a80929775`,
  `judge-classify.md 7fb4d19acf81`, `judge-normalize.md 9e782e9e021a`,
  rendered arm C stories doc `aecfb00665c7` (regenerated per trial by
  `render-stories.mjs` from the frozen suite; must hash identically).
- Synthesis is not idempotent: exactly one `synthesize-findings` per round,
  only via `arm-p-round.mjs`.
- Judge route smoke reconfirmed in the dry run (Fable subagents, both
  passes). Clean reference for classification runs on :4622.

## G5 product-bug log (PREREG environment-pin clause)

- **2026-07-30, trial 1 round 3 (arm P):** 6 of 13 journeys crashed `infra`
  at `gate.ts` `isInheritable` during clean-replay verdict inheritance — the
  hosted runner's per-case child receives the resolved case as JSON, which
  flattens the `_assertions.routing` Map to a plain object. First manifested
  in round 3 because it requires a *clean* act replay (rounds 1–2 replays all
  drifted/healed or recorded). Fix commit `916bacf` (runner-agent child
  revives the Map; typecheck + runner tests green) landed **before** the
  round was re-measured. The crashed group `01KYSKJD9Y8EXEG99EMVWQTNEX` is
  excluded from measurement; arm P round 3 was re-run in full against the
  same round-3 build (`ba6e2d843d1d`) in the same project. Arm C round 3 was
  already in flight against its own build when the re-run happened, so the
  strict "arm P round completes first" ordering was violated for round 3;
  the ordering exists only to derive arm C's 2×-wall cap, which was set from
  the crashed group's 33.5 min (67-min cap) — reported alongside the valid
  re-run wall time.
