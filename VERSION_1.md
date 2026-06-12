# IMPLEMENT.md — Milestone A Core Package

Implementation brief for the next package of work. Source of truth for design
detail: `IMPROVEMENTS_FOLLOWUP.md` (§N references below point there). This
document selects the subset, fixes the order, records the verified current
state of the code (audited 2026-06-12), and sets acceptance criteria. The
implementing agent should read the referenced § sections in full before
planning each item.

## What this package is

The foundation of Milestone A (the guild-talk milestone): the surface renames,
the self-test that freezes the CLI/JSON contract, and the `playtest demo`
conversion path with its browser preflight. Five items, one coherent unit:

| # | Item | Source | Net effect |
|---|------|--------|-----------|
| 1 | One creation command + `app:` block | §13 | rename/delete |
| 2 | Pre-1.0 cruft removal + README drift | §2 | delete |
| 3 | Harness self-test (`npm test`) | §1 | new tests + fixture refactor |
| 4 | Browser preflight | §3 | new, small |
| 5 | `playtest demo` (three acts) | §4 | new command |

**Why this subset:** §13→§1→§4 is the fixed dependency chain from the
execution order (§13 settles the names §1 freezes; §1 builds the app-mutation
hook §4's heal act needs). §3 is a hard dependency of §4 (demo step 1 is the
preflight). §2 is pulled forward from position 6 in the execution order: its
rationale for being late is talk-date timing, not dependency — but for
*implementation* it edits the same files as §13 (cli.js, config.js, llm.js,
README), and the self-test should freeze the post-cruft surface, not pin
legacy paths that get deleted a week later. Doing §2 with §13 avoids that
churn. The doc's ordering constraint is preserved where it matters: all
renames/deletions land before the self-test is written.

**Why nothing more:** execution-order items 3 (demo-path viewer polish) and 4
(journey clip renderer) are deliberately excluded. Both are audit/timebox
items that need the demo's actual runs in hand ("audit exactly that path on
the runs the talk will show", "verify the per-step-timestamped screencast is
actually implemented first") — they are the natural *next* package, consuming
what this one produces. Milestones B–D are out of scope entirely.

## Current state (verified against the code, 2026-06-12)

The implementing agent should trust this audit but spot-check line numbers
(they drift).

**Not yet done — this package's work:**

- `new` still splits into `suite`/`case`/`persona` subcommands
  (`src/harness/cli.js:343-364`); `newSuite`, `validateSuiteDir`, the
  `--suite` flag, and the "multiple suites found — pass --suite" error all
  exist (`src/harness/new.js:63,89,105,131`). `NO_SUITES_HINT` at
  `cli.js:49` prints `playtest new suite <name>`.
- Config block is still `env:` (`src/harness/config.js:96,147`;
  `tests/playtest.yaml` uses `env:` with `base_url` + `init`).
- `dummy.yaml` legacy read path lives in `config.js:10` (`DEFAULTS_FILES`)
  and `new.js:7` (`SUITE_FILES`).
- `DUMMY_LLM_BASE_URL` / `DUMMY_LLM_API_KEY` fallbacks in
  `src/harness/llm.js:9,13`.
- `playtest list personas` magic-path special case at `cli.js:462-464`.
- No tests at all: no `npm test` script, no test files anywhere.
- `src/todo-app/server.js:245` and `src/harness/testing/mock-llm.js:250`
  both call `listen()` at module top level; no `start({ port })` export.
- The todo app has no UI-variant mutation hook (only `PORT` is read from
  env, `server.js:4`).
- No `demo` command, no browser preflight anywhere in cli.js.
- `package.json` has no `files` allowlist (everything ships by accident).
- README quickstart is multi-terminal (`npm run todo-app`, `npm run
  mock-llm`, then the CLI) — to be replaced per §4's note once demo exists.

**Already done — do not redo:**

- The `bless`/`rebaseline` aliases named in §2 are already gone from cli.js
  (no hits). The hidden `run` alias (`cli.js:280`) stays per §2.
- `computeTrend` exists in cli.js (line ~106) — CLI trend lines have landed.
  Its extraction to a shared module is Milestone C (§5/item 10), **not**
  this package.
- `--json` (`cli.js:295`), `--fail-on-changed` (`cli.js:296`), and the
  exit-code contract (0 pass / 1 gate / 2 infra, `cli.js:328-331`) exist —
  the self-test asserts them, it does not build them.
- `accept`/`reject` are wired (currently hidden commands, `cli.js:549,555`)
  with candidate/promotion semantics the self-test must exercise.

## Work items

Implement in this order. Items 1+2 can be a single pass; 4 can be built in
parallel with 3; 5 needs 1–4 done.

### 1. One creation command + `app:` block (§13 — read it in full)

Settled design; §13 has the complete spec. Summary of the load-bearing parts:

- `case` becomes the default subcommand of `new` (same `isDefault` routing as
  the top-level `run`): `playtest new guest-checkout ./checkout` works.
  `new persona <name>` keeps its explicit form.
- **Lazy, ancestor-aware scaffolding:** if no dir from target up to repo root
  has a `playtest.yaml` (reuse `findSuiteDir`'s upward walk), write one next
  to the new case. The ancestor check is mandatory — without it, `new` in a
  subtree sprinkles shadowing defaults files.
- The scaffolded `playtest.yaml` uses the `app:` template from §13 (active
  `base_url`, everything else commented).
- `[dir]` omitted: nearest ancestor suite → unique suite below cwd →
  greenfield `./tests/`.
- Delete outright: `newSuite`, `validateSuiteDir`, `--suite` flag, the
  multiple-suites error path, `new suite`'s `--compose` flag, the dead
  `name:` key in the suite scaffold.
- `env:` → `app:` is a **surface-only** rename in config.js; internals
  (resolved-case `.env` field, env.js) may keep their names. No read shim:
  a file using `env:` gets a config error naming the rename, e.g.
  `env: was renamed to app: (update tests/playtest.yaml)`.
- Update `tests/playtest.yaml` itself to `app:`.
- The noun stays "case" (decided — do not revisit).
- Touchpoints to update: `NO_SUITES_HINT`, the workflow help epilogue in
  cli.js, README, `docs/CONTRACTS.md` §12. Do **not** edit
  `docs/playtest-design.md` (stable input — flag divergence in the PR/commit
  message instead).

Acceptance:

- `playtest new my-case` in a fresh dir creates `./tests/my-case.yaml` +
  `./tests/playtest.yaml` (app: template); the same command inside an
  existing suite subtree creates only the case file, no new yaml.
- `playtest new suite x` is gone; `new persona x` still works; a case named
  "persona" requires `new case persona`.
- A `playtest.yaml` containing `env:` produces the rename error verbatim
  (file path included), exit 2.
- No occurrences of `newSuite`, `validateSuiteDir`, `--suite` remain.

### 2. Pre-1.0 cruft removal + doc drift (§2)

Remaining items (aliases already gone, see audit):

- Remove `DUMMY_LLM_*` fallbacks in `llm.js` (keep `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` — provider conventions).
- Remove the `dummy.yaml` read path: `DEFAULTS_FILES` in config.js,
  `SUITE_FILES` in new.js, and the comments referencing the migration.
- Remove the `list personas` magic path (`cli.js:462-464`); `playtest
  personas` is the one way.
- README pass: remove/fix `dummy run`, the removed `diff` command,
  `DUMMY_LLM_*` vars, and the `docs/dummy-design.md` link (file is
  `docs/playtest-design.md`). Full README restructure waits for item 5
  (demo-first quickstart) — fix only drift here to avoid writing it twice.

Acceptance: `grep -ri "dummy.yaml\|DUMMY_LLM\|dummy run\|dummy-design"` over
src/ and README returns nothing (the package name `@jeremyvun/playtest` and
internal `Dummy*` class names are out of scope — surface strings only).

### 3. Harness self-test (§1)

`npm test` using `node:test`, offline, no keys. Prerequisite refactor (shared
with item 5): `src/todo-app/server.js` and `mock-llm.js` each export
`start({ port = 0 })` returning `{ url, close }`, CLI behavior behind a
main-module check (`import.meta.url` vs `process.argv[1]`).

Also build here: the **UI-variant mutation hook** in the todo app — an env
flag (e.g. `TODO_APP_VARIANT=b`) that renames a button label or similar, so
an acted step's locator misses and forces a heal. This hook is item 5's act
three; design it once, in the todo app, controlled at `start()` time.

The test sequence (one suite, sequential — later passes depend on state from
earlier ones):

1. Boot todo-app + mock-llm on ephemeral ports; point the run at them
   (`--base-url` override + `PLAYTEST_LLM_BASE_URL`). Use a temp copy of the
   example suite **without baselines** so the repo's committed baselines are
   untouched.
2. First run → every case records and blesses a baseline, exit 0.
3. Second run → every case acts; assert **zero requests hit the mock**
   during the pass (count requests in the mock, expose via `start()` handle).
4. Flip the variant flag, rerun → a heal happens, run marked changed; then
   assert `accept` and `reject` behave per contract (accept promotes the
   candidate; reject dismisses it).
5. Exit codes: 0 on pass; 1 on gate failure; 2 on infra (point a case at a
   dead URL).
6. `--json` shape asserted on each pass (presence + types of the
   load-bearing fields, not exact snapshots — this freezes the contract
   items B-8/B-9 will parse).

Acceptance: `npm test` passes on a machine with chromium installed and **no
network beyond localhost, no API keys**; total runtime sane (< ~2 min); a
deliberately broken case file makes it fail.

### 4. Browser preflight (§3)

Before any command that launches a browser: resolve chromium
(`chromium.executablePath()` + `existsSync`); if present proceed (zero
happy-path overhead). If missing and stdout is a TTY, offer the one-time
install prompt from §3 and stream `npx playwright install chromium`; on "no"
or non-TTY, exit 2 printing the exact command.

Policy (from §3): pinned chromium for real runs; `channel: "chrome"`
fallback is allowed **only for `playtest demo`** (and optionally `--headed`)
— never for measured runs.

Acceptance: with chromium present, no behavior change and no measurable
startup cost; with the browsers dir moved aside, a non-TTY run exits 2 with
the install command on stderr and no Playwright stack trace.

### 5. `playtest demo` (§4 — read it in full)

One command, zero keys/docker/second terminal: preflight → copy bundled demo
suite (no baselines) to a temp dir → start todo-app + mock-llm in-process via
`start({ port: 0 })` → act one records (live region shows improvisation) →
act two acts with the explicit punchline line ("…0 model calls…") → act
three flips the UI variant, an acted step fails, the agent heals, and the
end-of-run prompt opens the heal diff in the viewer. `--keep` retains the
temp dir, `--headed` shows the browser. Cleanup on exit (including SIGINT).

- Model selection: real key configured → real model; otherwise the mock.
- Relocate the demo suite to `src/demo/` (copy of the tests/ fixture) so the
  published package doesn't depend on the repo's working test tree. The
  self-test may keep using `tests/`.
- Add the `files` allowlist to package.json: src/harness, src/todo-app,
  src/demo, src/viewer, src/schemas, personas, docs as appropriate — make
  shipping deliberate. Verify with `npm pack --dry-run`.
- README rewrite to §4's spec: first lines are the npx demo command, then
  "point it at your own app" with `playtest new <case-name>`.

Acceptance: `node src/harness/cli.js demo` runs the three acts end-to-end
offline and exits 0; a second invocation works (no port/temp-dir collisions);
`--keep` leaves the dir and prints its path; `npm pack --dry-run` lists the
demo suite and todo app; nothing is ever written inside the installed
package directory.

## Cross-cutting constraints

- **Net deletion bias.** Items 1–2 must shrink the codebase. No
  compatibility shims of any kind pre-1.0; clear errors beat compatibility.
- **The self-test is the contract freeze.** After item 3 lands, any change
  to exit codes, `--json` shape, or CLI names must update the tests in the
  same commit — that is the point of building it before the demo.
- **Shared fixtures, built once.** `start({ port })` and the UI-variant hook
  serve both the self-test and the demo. Do not implement them twice.
- **Committed baselines are instrument state.** Tests and demo always work
  on temp copies of the suite; nothing under `tests/` or `src/demo/` is
  mutated by a run.
- **docs/playtest-design.md is read-only** for this package (stable input;
  it documents `new suite` — flag the divergence, don't edit).
- Verify each item with a real invocation, not just code review: the
  self-test run, the demo run (headless), and the preflight failure path.

## Definition of done

`npm test` green offline; `playtest demo` delivers all three acts offline;
`playtest new <name>` is the only creation path with `app:` scaffolding;
no legacy surface strings remain; `npm pack --dry-run` shows a deliberate
file list; README opens with the demo command and contains no drift.
