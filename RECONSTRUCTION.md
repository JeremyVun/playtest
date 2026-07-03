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

## Tier 4 — RECOVERED-TO-BASE (collaborator's newer edits NOT reconstructable)

The video shows these existing files **far larger** than `main`. Those additions
(~4–5k lines total) cannot be faithfully OCR'd from a handheld video without
inventing broken code, so **they are kept at the git-base version** — a coherent,
older, working state. This is the single biggest fidelity gap.

| File | git base | video (friend) | unrecovered delta |
|---|---:|---:|---:|
| `src/viewer/app.js` | 1614 | 2488 | +874 |
| `src/harness/runner.js` | 682 | 1447 | +765 |
| `src/harness/clip.js` | 347 | 765 | +418 |
| `src/harness/grader.js` | 140 | 453 | +313 |
| `src/viewer/style.css` | 784 | 1087 | +303 |
| `src/harness/cli.js` | 641 | 940 | +299 |
| `src/harness/config.js` | 490 | 778 | +288 |
| `src/harness/drivers/web.js` | 1041 | 1290 | +249 |
| `src/harness/snapshot-injected.js` | 175 | 424 | +249 |
| `src/harness/live.js` | 142 | 390 | +248 |
| `src/harness/llm.js` | 230 | 437 | +207 |
| `src/harness/drivers/mobile*.js`, `gate.js`, `new.js`, `report.js`, `trajectory.js`, `demo.js`, `actor.js` | … | … | +30–120 each |

The collaborator's driver WIP in the stash (`web.js`, `mobile.js`) was itself
**syntactically broken** (an undeclared `#screenId`, a brace imbalance), so the
whole `drivers/` dir was reverted to the clean git base rather than ship guesses.

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

`npm test` cannot be green in this environment: **Playwright browser v1223 is not
installed** (`npx playwright install`), so the integration tests that launch a real
browser fail on `main` too.

- `main`: 125 tests, **93 pass / 32 fail** (all 32 environmental).
- this branch: 125 tests, **86 pass / 39 fail**.

The **7 extra failures vs main are pin/fixture drift, not runtime defects**: the
collaborator edited the actor prompts and the skill set in alpha-0.4.0, so the
golden-byte prompt pins, the `install-skill` manifest, and the api/mobile envelope
pins no longer match — and the collaborator's corresponding test updates weren't
recoverable. Verified healthy at runtime: the CLI loads, `--help` works, and every
`src/demo` and `tests/` suite resolves.

## If you can still reach the collaborator

One `changes.patch` (already in their repo), `git bundle create x.bundle --all`, or
a zip of the folder makes all of the above lossless in minutes. The video path
tops out here.
