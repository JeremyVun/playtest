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

- `src/harness/models.json` — visible only as a tab, never opened. **Missing.**
- `ROADMAP.md` — in the tree, never opened. **Missing.**
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

## If you can still reach the collaborator

One `changes.patch` (already in their repo), `git bundle create x.bundle --all`, or
a zip of the folder makes all of the above lossless in minutes. The video path
tops out here.
