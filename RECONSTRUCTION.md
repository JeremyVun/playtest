# RECONSTRUCTION.md — provenance & fidelity report

This branch (`reconstruct/alpha-0.4.0`) is a best-effort reconstruction of a
collaborator's in-progress `alpha-0.4.0` work, recovered from **a 20-minute phone
video of their screen** (`~/Desktop/codebase_vid.mp4`) plus this repo's own git
history. The collaborator couldn't push; the video was the only channel.

**Read this before trusting any file.** A phone recording cannot faithfully carry
thousands of changed lines, so this reconstruction is explicitly tiered by
confidence, and every file that contains inferred (non-transcribed) code says so
in a `NOTE (reconstruction)` comment near the top.

## Method

1. **git base** — `main` @ `412e63d` (265 files) is byte-exact and untouched.
2. **recovered stash** — a `git stash` on this machine held the collaborator's
   edits to 24 existing files (drivers, prompts, actor.js, demo yaml, and the
   commbank/talk deletions). Applied verbatim, then WIP typos fixed (see below).
3. **video OCR** — the 20-min video was cut to 3,574 frames, reduced to 450
   distinct, sharp frames, indexed by a fan-out of vision agents (file path from
   the nvim statusline + legibility + tree), then the genuinely-new files were
   transcribed by per-file agents that cross-referenced every frame (a line
   ghosted in one frame is often crisp in another) and marked anything unreadable.

## Tier 1 — EXACT (git bytes, fully trustworthy)

- All 265 files from `main`.
- The 24 stash-recovered files, **minus** four WIP typos the collaborator had
  left mid-edit (the stash didn't parse as-is):
  - `drivers/web.js` — `{ width: 1280, 720 }` → `{ width: 1280, height: 720 }`
  - `drivers/har.js` — a garbled `isTextualMime` line → the clean `||` form
  - `drivers/mobile.js` — `uf (…)` → `if (…)`
  - `drivers/mobile-snapshot.js` — duplicate `aidOf` → first renamed `aidAttrOf`

## Tier 2 — RECONSTRUCTED FROM VIDEO (new files; transcribed, then verified)

Per-file confidence from the transcribe+verify pass (1.0 = certain):

| File | conf | notes |
|---|---|---|
| `src/shared/timing.js` | 0.98 | tiny (`AUTOPLAY_MS = 600`) |
| `src/harness/browser.js` | — | OCR came back **byte-identical to git**; kept git's |
| `src/harness/prompts/grader-assert.md` | 0.95 | ~4 lines |
| `src/harness/hooks.js` | 0.86 | full; verify fixed a soft-wrap |
| `src/harness/lint.js` | 0.86 | full |
| `src/harness/axe-source.js` | 0.82 | wrapper only (see gaps re: axe-core blob) |
| `skills/playtest-hooks/SKILL.md` | 0.82 | new skill |
| `skills/playtest-assertions/SKILL.md` | 0.78 | new skill |
| `skills/playtest-ci/SKILL.md` | 0.72 | merged: renamed from `playtest`; a 28-line hole (the four-verdict "App bug" bullet) was bridged from the old `playtest` skill |

## Tier 3 — RECONSTRUCTED WITH INFERRED REGIONS (marked in-file)

These parse and are structurally correct, but contain regions **inferred** (not
read from the video). Each is flagged in-file:

- `src/harness/assertions.js` — conf 0.72; the imports and the discovery-loop
  scaffolding (`for (const name of dirs) { … await import … }`) were never legible;
  inferred from the sibling `loadHooks()` pattern.
- `src/harness/storage-provider.js` — conf 0.55; only `listDir`/`readText` were
  filmed; `stat()`, `createReadStream()` and the class tail are inferred from the
  interface typedef + standard `node:fs` usage.
- `src/schemas/defaults.schema.json` — added the collaborator's `parallel: { total,
  record }` key (their `src/demo/playtest.yaml` uses it and it broke suite
  resolution without it). Shape inferred from the yaml + skill docs; exact wording
  not filmed.

## Tier 4 — TRANSCRIBED FROM VIDEO (slice → stitch → repair)

The 28 JavaScript files the video scrolls through are transcribed from the frames
and now **replace** the git-base versions. Method: the video was cut to 3,574
frames; per file, dense frames within its on-screen windows were fed to overlapping
"slice" agents that transcribed line-anchored spans (using nvim's absolute line
numbers); a deterministic JS stitch reconciled overlaps and inserted explicit
`// [UNREADABLE lines N-M]` markers for any range the scroll skipped; a repair pass
fixed slice-seam artifacts (duplicated/dropped lines, unbalanced braces).

**All 28 parse (`node --check`).** 12,395 lines total, **13% marked as `[UNREADABLE]`
gaps** — no invented code fills them. Where a gap or the file tail left a block open,
the repair added minimal closers tagged `// [reconstruction: …]`.

**17 files transcribed gap-free:** `cli.js`, `clip.js`, `driver.js`, `drivers/api.js`,
`drivers/har.js`, `drivers/mobile-snapshot.js`, `drivers/overlay.js`, `env.js`,
`grader.js`, `llm.js`, `new.js`, `preflight.js`, `prompt.js`, `runs-root.js`,
`snapshot-injected.js`, `trajectory.js`, `shared/movement.js`.

**11 files with gaps** (fast scroll → un-filmed ranges):

| File | lines | gap lines |
|---|---:|---:|
| `src/viewer/app.js` | 1657 | 849 |
| `src/harness/runner.js` | 1227 | 267 |
| `src/harness/drivers/web.js` | 1138 | 190 |
| `src/harness/drivers/mobile.js` | 436 | 109 |
| `src/harness/view-server.js` | 342 | 83 |
| `src/harness/live.js` | 361 | 40 |
| `src/harness/report.js` | 229 | 36 |
| `src/harness/actor.js` | 261 | 26 |
| `src/harness/config.js` | 772 | 7 |
| `gate.js`, `demo.js` | — | 1 each |

`app.js` (the viewer) is the least complete — its 2,400+ lines were scrolled fast,
so ~half is `[UNREADABLE]`. Grep `UNREADABLE` / `[reconstruction:` in any file to
see exactly which lines are missing or inferred.

Because these replace the tested git-base versions, `npm test` is now heavily red
(the transcriptions have OCR-level imperfections and gaps, and diverge from the
older pinned fixtures) — expected and accepted per the "transcribe the JS from the
video" goal. The original working versions remain on `main`.

## Tier 5 — NOT RECOVERABLE (never filmed, binary, or derived)

- ~~`src/harness/models.json` — visible only as a tab, never opened. **Missing.**~~
  **RECOVERED 2026-07-03** from the collaborator's screenshots — see the Addendum below.
- ~~`ROADMAP.md` — in the tree, never opened. **Missing.**~~
  **RECOVERED 2026-07-03** from the collaborator's screenshots — see the Addendum below.
- `changes.patch` — the collaborator's own diff; huge, never opened. **Missing.**
- `assets/` — new top-level dir, never expanded; almost certainly binary. **Missing.**
- `scripts/` — new top-level dir (gitignored `?`), never opened. **Missing.**
- `case.schema.json` additions (`viewport`, `preserve_session`, `visual_regression`)
  and `defaults` `viewport`/`preserve_session` — glimpsed but not fully filmed; only
  `parallel` (which broke resolution) was reconstructed.
- `test-stories/` — new top-level dir (likely the renamed `tests/`), contents not
  filmed; the git `tests/` suite is kept in place instead.
- `src/demo/stories/README.md` — never opened. **Missing.**
- **The collaborator's own updates to `test/*.test.js` and the golden-byte pins** —
  not in the stash, not filmed. This is why some tests fail (below).

## Addendum (2026-07-03) — two Tier-5 gaps recovered from screenshots

After the video pass, the collaborator (still unable to push) sent **still
screenshots** of two files that the video only ever showed as unopened tabs/tree
entries. Stills are far more legible than video frames, so these two are **high
confidence** — closer to Tier 1 than to the rest of this reconstruction:

- `src/harness/models.json` — conf ~0.97. The full 6-key map (`sonnet`, `haiku`,
  `opus`, `gpt5_5`, `gpt5_4`, `gpt5_4_mini` → gateway wire names) was fully visible.
  Verified live: it `JSON.parse`s, all six keys round-trip through
  `resolveModel`/`shortModel`, and each prices non-zero via `estimateCost` on both
  its enum and its qualified wire form (the `PRICING` table in `llm.js` matches
  both). This unblocks `llm.js`, which `readFileSync`s it at import time — its
  absence would crash every code path that imports the LLM client.
- `ROADMAP.md` — conf ~0.95. All 17 checklist items transcribed verbatim, including
  the collaborator's original spelling (`unecessary`). Prose doc; no verification
  surface beyond faithful transcription.

## Test status

`npm test` is **not a meaningful gate on this branch** and is expected to be red,
for three stacked reasons:

1. **Environment** — Playwright browser v1223 isn't installed (`npx playwright
   install`), so browser-launching tests fail on `main` too (32 failures there).
2. **Pin/fixture drift** — the recovered stash edits the actor prompts and the skill
   set; the collaborator's matching updates to `test/*.test.js` and the golden-byte
   pins weren't in the stash and weren't filmed, so those pins mismatch.
3. **Video-transcribed JS** (Tier 4) now replaces the tested git-base source, with
   OCR-level imperfections and `[UNREADABLE]` gaps.

This is the accepted trade-off of "transcribe the JS from the video." The original
green, tested versions are preserved on `main`; diff any file against `main` to see
git-base ↔ video-reconstruction. Runtime sanity still holds: the CLI loads and every
`src/demo`/`tests/` suite resolves.

## Addendum (2026-07-03) — five more screen recordings targeting the weakest files

The collaborator (still unable to push) sent **five more phone screen-recordings**
(`~/Desktop/drive-download/recordings/VID_2026070*.mp4`, ~9.4 min, 1080p), this time
held steady and scrolled slowly over the files this reconstruction was least sure of.
Same pipeline, hardened for handheld footage: frames clustered into distinct "pages"
by a jitter-immune downscaled mean-abs-difference (plain de-dup is defeated by camera
shake); a fan-out of vision agents transcribed each page verbatim (converting the
editor's ligatures — `⇒`→`=>`, `≡`→`===` — back to real source); a **drift-correcting
stitch** snapped each frame's nvim line numbers to the growing consensus before merging
(a raw line-number merge turns per-frame anchor drift into hundreds of false conflicts).
Every file was re-validated live, not just parsed. These **supersede** the Tier-3/4/5
entries above:

| File | was | now |
|---|---|---|
| `src/harness/storage-provider.js` | Tier 3, conf 0.55 (stat/stream inferred) | **transcribed, 61 lines** — the inferred `stat()`/`createReadStream()` were right; only `const s`→`const st` differed. Line 1 + the `/**`\|`* @typedef` split recovered |
| `src/harness/assertions.js` | Tier 3, conf 0.72 (imports/loop inferred) | **transcribed, 134 lines** — recovered the `existsSync` guard, the `mod.default` object-check, reworded error strings. **Caught a shared OCR error**: a faint `!` dropped by every agent flipped the `inheritable` guard `!==`→`===`; restored from logic + baseline |
| `src/schemas/defaults.schema.json` | Tier 3/5, `parallel` inferred, rest "glimpsed" | **228 lines** (was 134) — full `parallel {total,record}`, `visual_regression(_drift)`, `perf`, `app.*`, `actor_model`/`grader_model`. Two spots flagged in the repair notes (`max_ms` default value; `preserve_session` tail, from a ghosted frame) |
| `src/schemas/case.schema.json` | Tier 5, additions "not fully filmed" | **291 lines** (was 183) — full `visual_regression(_drift)`, `preserve_session`, `openapi`, `viewport`, `envs`, per-driver `app.*`; frame-verified end to end |
| `src/schemas/grade.schema.json` | (git base) | **86 lines** (was 62) — `report` block + `a11y` summary. `a11y.top_rules.items` reconstructed from `grader.js`/`app.js` (code-verified keys; descriptions are agent-worded, not verbatim) |
| `src/schemas/step.schema.json` | (git base) | **111 lines** (was 59) — `schema_version` 3→6, new `confused`/`confused_reason`, the flat-`action` + per-verb `allOf` gate, `a11y.violations[]` |
| `src/viewer/app.js` | Tier 4, ~half `[UNREADABLE]` | **2,403 lines, parses** — ~2,000 recovered verbatim from the recording (header/imports/`state`, all render/describe/context/video/a11y/gate logic). ~15 fast-scroll gaps filled from the prior build (tagged inline); the `boot()`/`navigate()`/`loadRun()`/router region (~320 lines) was scrambled in BOTH recordings and is substituted from the prior build; 2 one-line gaps remain |

**Validation of the six non-viewer files** (live, not just `node --check`):
`storage-provider.js` + `assertions.js` parse; the 4 schemas `JSON.parse`, **`Ajv.compile`
cleanly**, `config.js` loads them and derives the correct 9 `BUILTIN_SUCCESS_KINDS` from
`case.schema.json`, and `discoverCases("tests/todos")` still validates all three committed
cases against the new schemas (backward-compatible). They introduce **zero new `npm test`
failures** — the red tests are all the pre-existing WIP breakage noted under *Test status*
(missing `manifestToHistoryEntry`/`DURATION_RATIO_BADGE` exports, a `#fail` syntax error in
the WIP drivers, no Playwright browser), none of which touch these files.

**Contract note:** `case.schema.json`/`defaults.schema.json` now carry the collaborator's
new `visual_regression`/`visual_regression_drift` keys and `step.schema.json` bumps
`schema_version` to 6 — real `alpha-0.4.0` contract changes recovered from the video.
The collaborator's doc edits weren't filmed; these changes are now recorded in
`docs/CONTRACTS.md` §17 ("alpha-0.4.0 reconstructed changes").

## Addendum (2026-07-04) — review repairs after transcription

A full-codebase review found that several confidence claims above were too
strong. In particular, `cli.js` was listed as "transcribed gap-free" and this
report said "the CLI loads"; both were false before the review repair pass.
`cli.js` had an unmarked EOF truncation that dropped the `grade` command tail
and `program.parseAsync()`, so invocations could parse nothing and exit 0.
Likewise, `view-server.js` gaps swallowed helper exports that `runs-root.js`
imports, so viewer/run-root paths could fail despite the file parsing.

The review also repaired multiple OCR/transcription defect classes across the
runtime: flipped equality/null checks, dropped returns, renamed identifiers,
lost baseline writes, missing `buildManifest` tail fields, missing `readHar`,
viewer helper/load/inspector gaps, mock-LLM drift from the new grader loop, and
contract documentation loss. Treat the original confidence tiers as provenance,
not proof of correctness. The review's plan file (`REVIEW-PLAN.md`) was deleted
once every item was verified complete; the file-by-file repair record follows.

### Review repair record (condensed from REVIEW-PLAN.md, all verified 2026-07-04)

Transcription-defect repairs, by file (each verified against `main` or the
code's own consumers; `npm test` 130/130 green, 0 skipped, after the pass):

- `runner.js` — baseline-read guard, success-criterion kind extraction, and
  `willGrade` flips vs main; dropped `acceptBaseline` call in record mode;
  `detectConfusion` arg typo; `buildManifest` tail restored (result/heal/totals/
  setup/healed/baseline/artifacts); actLoop `state_drift` marker branch authored;
  `readHar` and the `recordLoop` body restored into UNREADABLE gaps.
- `cli.js` — unmarked EOF truncation restored (`grade` tail + `parseAsync`);
  `acceptRun` / `isPendingChanged` / `--fail-on-changed` polarity flips; persona
  list crash; cosmetic OCR drops.
- `trajectory.js` — `initialQuietMs` strict-null check made loose (absent
  override was spinning every first settle to the full 10s `max_ms`).
- `drivers/web.js` — ref regex `/^e\d+$/`, `isTextualMime` rename, HAR `headers:`
  key, native-AX null check, dead duplicate `network:` key, drift-reason rewrap.
- `drivers/mobile.js` — `?.()` syntax fix, missing `return` in `get settle()`,
  `consoleErrors()` rename, Appium-path polarity, first-settle NaN.
- `drivers/mobile-snapshot.js` — `decodeEntities` no-op restored, pass-2b text
  polarity, loose null check.
- `drivers/api.js` — three polarity flips + `prettyBody` rename.
- `snapshot-injected.js` — dropped `refCount++`, quote-escaping misread,
  `cursorPointerInteractive` polarity, duplicate line.
- `view-server.js` — four missing helpers authored (`findManifestsVia`,
  `readJson`, `readJsonFile`, `manifestToHistoryEntry`), missing `join` import,
  `changed()` polarity, `openBrowser` dropped assignment.
- `viewer/app.js` + `index.html` — lost foundations (`h()`, `icon()`, guards,
  `fetchJson` body), `loadRun` artifact block, inspector pane construction,
  a11y renderers, missing tabs/sprites in index.html, ~14 mechanical flips.
- `live.js` — undefined `modeW`, duplicated stitch lines.
- `llm.js` — dropped `waitMs` line in the network-retry path, retry-ladder timing.
- `grader.js` — token totals accumulated across the whole tool loop; duplicate call.
- `gate.js` — `matchJsonPath` lost the `==` operator alternation.
- `config.js` — base_url requirement polarity, `parallel` null/undefined check.
- `clip.js`, `demo.js`, `report.js`, `actor.js`, `movement.js`,
  `testing/mock-llm.js` — caption polarity/footage-cap/error-envelope fixes; demo
  case count + real-model predicate (`llmConfig().available`); JUnit/heal-line
  formatting; persona error rewrap; streak polarity + loose null checks + U+FFFF
  sentinel; mock taught the grader's `tool_choice:"auto"` turns and new claim
  format.
- Tests reconciled to intentional 0.4.0 contract bumps (schema v6, prompts v7,
  models.json defaults, renamed `playtest-ci` skill, cache default-on) without
  weakening assertions; `test/reconstruction-regressions.test.js` added.
- Perf: axe source no longer re-shipped per step; dHash + downscale in one
  evaluate; HAR flush batched (forced flush before the gate reads it).
- `axe-core` added to `package.json` dependencies — `axe-source.js` (new in
  0.4.0) resolves `axe-core/axe.min.js` at runtime, but the dependency was never
  declared, so per-step a11y capture silently degraded to `null` on a clean
  install. `webdriverio` stays optional and uninstalled in dev (the mobile
  preflight test pins its absence); `package-lock.json` was regenerated and now
  records the full optional tree (the old lock was incomplete).

After all repairs were verified (offline gate 130/130 with 0 skipped, `playtest
demo` record→act→heal end-to-end, viewer served), the in-code provenance
markers (`[UNREADABLE …]`, `[reconstruction: …]`, `[restored from main: …]`)
were removed: the code now stands alone, and git history preserves both the
markers and this report. Once this state is committed, this file can be
deleted.

## If you can still reach the collaborator

One `changes.patch` (already in their repo), `git bundle create x.bundle --all`, or
a zip of the folder makes all of the above lossless in minutes. The video path
tops out here.
