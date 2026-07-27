# TypeScript migration — master build plan

Implements the "TypeScript migration" item in `docs/ROADMAP.md`: migrate the
maintained first-party codebase and tests from JavaScript to strict
TypeScript in coherent, independently shippable slices, without changing ESM
boundaries, runtime behavior, or public entry points.

This plan is written to be executed by many agents across many sessions. Each
phase is self-contained: an agent given this file plus a phase id has
everything it needs. Orchestration guidance is at the end.

Read first:

- `CLAUDE.md` (root) — migration direction, change rules, test-gate rules.
- `docs/CONTRACTS.md` and the contract file owning whatever you touch.
- This file, fully, before starting any phase.

## Strategy and decision record

Decided 2026-07-27 after a full-repo survey. Do not re-litigate these inside
a phase; if one proves wrong in practice, stop and report to the orchestrator.

1. **Node-side code runs as `.ts` directly via Node's native type
   stripping.** No build step, no `dist/`, no emitted twins for Node code.
   `tsc --noEmit` is the typecheck gate only. Rationale: the repo has
   load-bearing literal file paths everywhere (tests spawn
   `src/cli/cli.js`, `runner.ts` spawns a sibling `child.ts`, package
   `bin`/`exports` point into `src/`), and an emit step would create
   source/output twins that multi-agent work will silently desynchronize.
   With type stripping there is exactly one file per module and failures are
   loud (resolution errors), never silent (stale output).
2. **Engines: Node `>=24.18.0` everywhere** — aligned to the current LTS
   (user decision 2026-07-27; dev machine runs 25.x). Type stripping is on
   by default well below this floor (22.18/23.6), so 24 LTS runs `.ts`
   natively with margin. The control plane already requires `>=22.5` for
   `node:sqlite`, and the supported install is a repository checkout, so
   the bump is safe. All first-party `package.json` `engines` fields align
   in T0.
3. **Erasable syntax only.** `erasableSyntaxOnly: true` in every tsconfig.
   No enums, no namespaces with runtime meaning, no constructor parameter
   properties, no `import x = require()`. Type stripping never transforms;
   stack traces keep their line numbers.
4. **Specifier rule for Node code: imports name the real file.** When
   `x.js` becomes `x.ts`, every importer's specifier changes from `./x.js`
   to `./x.ts` in the same commit — static imports, dynamic `import()`
   with literal arguments, `new URL("./x.js", import.meta.url)` file
   references, and literal paths inside tests. Node resolves the actual
   file; `allowImportingTsExtensions: true` + `noEmit` makes tsc accept it.
5. **Browser-served code is the one place tsc emits, in place.**
   `src/platform/web/` (except `vendor/`), `src/run-viewer/web/`, and
   `src/core/shared/` are served to browsers as static ESM with no bundler.
   These dirs convert to `.ts` sources whose imports **keep `.js`
   specifiers**; `tsc -p tsconfig.web.json` (no `outDir`) emits `x.js`
   beside `x.ts`. Browsers and the existing static servers see exactly the
   same URL space as today — zero server changes. Emitted `.js` in these
   dirs is gitignored; a repository test forbids tracked non-vendor `.js`
   there. Node code that imports one of these modules imports the `.ts`
   source directly (type-stripped), so root `npm test` needs no build; only
   surfaces that *serve* these dirs (viewer tests, browser tests, hosted)
   need `npm run build:web` first.
6. **Slices are import-closed and land bottom-up.** A file may convert only
   when everything it imports is already `.ts`, an emit-dir module, a
   `node:` builtin, or an npm package. If a dependency blocks you, enlarge
   the slice; do not stub with ad-hoc `.d.ts` files.
7. **Behavior freeze.** A migration commit changes type syntax, file
   extensions, and import specifiers — nothing else. No refactors, no
   renames beyond the extension, no dead-code deletion, no dependency
   upgrades. If typing reveals a real bug, record it in
   `docs/backlog/ts_migration/FINDINGS.md` (create on first use: one
   heading per finding, file/line, evidence, suspected impact) and leave
   the behavior exactly as it was. The orchestrator triages findings with
   the user; fixes land as separate, ordinary changes with their own tests.
8. **Types describe validated data; Ajv stays the runtime source of
   truth.** Case/defaults shapes get hand-written interfaces representing
   the *post-validation* shape. No `json-schema-to-ts` or schema codegen —
   `src/core/config.js` clones and mutates schemas at runtime
   (`buildCaseValidator`), which codegen cannot follow. Where data enters
   from YAML/JSON, type it `unknown` and narrow after validation.
9. **User-authored JavaScript stays supported forever.** The plugin seams
   (`src/core/assertions.js:59`, `src/core/hooks.js:50`,
   `src/core/api-suite-scripts/child.ts:104`) load user `.js`/`.mjs` by
   `pathToFileURL`. The loaders convert; the loaded fixtures do not. Test
   fixtures that model user code stay JavaScript deliberately — they pin
   the product behavior that plain-JS user files keep working.

### Strictness and escape hatches

The base config is `strict: true` plus `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`, `erasableSyntaxOnly`, `skipLibCheck`. Rules for every
phase:

- `@ts-nocheck` and `@ts-ignore` are forbidden.
- `@ts-expect-error` only with a same-line reason and only where the error
  is about third-party types, not our code.
- Prefer `unknown` plus a narrowing guard over `any`. Any intentional unsafe
  compatibility boundary or assertion of a compiler-unrepresentable invariant
  requires a same-line `// SAFETY: <reason>` that states the runtime evidence.
- Keep JSDoc prose comments; delete only JSDoc *type* annotations that the
  TS signature now expresses.
- Type-only imports use `import type` (verbatimModuleSyntax enforces this).

### Scope exclusions — never convert

- `src/platform/web/vendor/` — never touch, never reformat. If web `.ts`
  imports it, add an ambient module declaration in a `.d.ts` under
  `src/platform/web/` instead (T10).
- `examples/`, `studies/`, `tools/`, `skills/` — out-of-band per
  `CLAUDE.md`. `studies/api-probe/` and `studies/archive/` are frozen:
  read-only, even for path-string fixups.
- Test fixtures modeling user-authored code: `tests/fixtures/script-suites/`,
  `tests/fixtures/authoring-api/drafts/`,
  `src/platform/runner-agent/tests/fixtures/script-attacks/`, and any file
  loaded through the plugin seams in rule 9.
- `src/platform/control-plane/migrations/*.sql`, `runs/`, generated
  artifacts.

### Known load-bearing hazards

Every phase re-checks this table for entries it owns. Line numbers are as of
2026-07-27; re-grep, don't trust them blindly.

| # | Hazard | Owner phase |
|---|---|---|
| 1 | `tests/cli/*.test.js` spawn the CLI via literal `path.join(ROOT, "src", "cli", "cli.js")` | T6 |
| 2 | `src/core/api-suite-scripts/runner.ts:50` — `CHILD = fileURLToPath(new URL("./child.ts", import.meta.url))`, spawned as a child process | T5 |
| 3 | Shebang lines must stay line 1: `src/cli/cli.ts`, `src/platform/control-plane/src/index.ts`, `src/platform/runner-agent/src/exec-group.ts` | T6/T8/T9 |
| 4 | Root `package.json` `bin` + 10 `exports` subpaths point at `src/core/public/*.js`, `src/run-viewer/node.js`, `src/cli/cli.js`; subpath **keys** are the public contract and never change, target values change with their files | T6 |
| 5 | `tests/support/hermetic.js` is loaded via `--import` in five npm scripts and re-injects itself into `NODE_OPTIONS` for child processes | T7 |
| 6 | `tests/repository/` boundary/import-hygiene tests dynamically import source files by literal path and pattern-match import specifiers; extension changes must not blind them | every phase touches, T7 verifies |
| 7 | `src/platform/control-plane/tests/integration/exec-helpers.js` spawns control-plane and runner-agent by literal path | T8 |
| 8 | `src/platform/runner-agent/src/mint.ts:42` and `src/platform/control-plane/src/dispatch/local.ts:44` spawn scripts by path | T8+T9 (coordinate) |
| 9 | `tools/ux-lab/plane.mjs` dynamically imports control-plane `config.js`/`app.js` by joined path (out-of-scope dir, in-scope breakage) | T8 |
| 10 | `src/core/shared/movement.js` is dual-use: imported by Node (`src/core/public/analysis.js`) and served raw to browsers by the viewer (`SHARED_DIR`) and control plane (`/api/v1/view/shared/movement.js`, dynamically imported by `src/platform/web/pages/story-history.js:33`) | T10 |
| 11 | Lazy optional-dependency imports must stay dynamic so webdriverio stays optional: `src/core/driver.js:65,69`, `src/core/drivers/mobile.js:42`, `src/cli/preflight.js:102` | T3 |
| 12 | `src/core/findings/ledger.js:255` conditionally imports `node:sqlite`; keep the graceful degradation path | T4 |
| 13 | Ajv schema clone-and-mutate in `src/core/config.js` (`buildCaseValidator`) — see strategy rule 8 | T1 |
| 14 | `src/core/env.js` `execFile`s docker and user init scripts — user paths, do not touch semantics | T4 |

## Phase map

| Phase | Outcome | Depends on |
|---|---|---|
| **T0** | Toolchain: tsconfig base + Node project, typecheck script, engines bump, canary module proves the whole pipeline | — |
| **T1** | Core foundation: `config.js` hub, its leaf deps, hand-written case/defaults types | T0 |
| **T2** | Core model layer: `llm.js`, `actor.js`, `grader.js`, `report.js`, `anomalies.js` and their closure | T1 |
| **T3** | Driver contract: `driver.js`, `drivers/*`, a formal `Driver` interface | T1 |
| **T4** | Engine and artifacts: `runner.js`, trajectory/artifact/findings clusters, remaining `src/core/` except `scripts/`, `shared/`, `public/` | T2, T3 |
| **T5** | Script substrate: `src/core/api-suite-scripts/*` | T4 |
| **T6** | Entry-point cutover: `src/core/public/*`, `src/cli/*`, `src/run-viewer/node.js`, package `bin`/`exports` values | T5 |
| **T7** | Root tests and support: `tests/**` suites + `hermetic` + npm script globs | T6 |
| **T8** | Control plane: `src/platform/control-plane/` src + its tests | T6 |
| **T9** | Runner agent: `src/platform/runner-agent/` src + its tests | T6 |
| **T10** | Browser-served code: `src/platform/web/`, `src/run-viewer/web/`, `src/core/shared/` with in-place emit and `build:web` | T0 (files), T8 (serving checks) |
| **T11** | Cutover: repo-wide guards, debt audit, docs/contracts/ROADMAP/CLAUDE.md updates, full gate matrix | all |

T7, T8, T9 may run in parallel after T6 (disjoint file sets; hazard 8 needs
T8/T9 to coordinate one string). Everything else is sequential. **Do not
start a phase while the previous phase's exit gate is red.**

## Standing rules (every phase)

- Never read any `.env` file. Never touch `src/platform/web/vendor/`.
- `npm test` stays offline, Node-only, zero skipped tests, at every commit —
  not just at phase end. `tsc` (a devDependency, run offline) is the only
  tool a script may add.
- One slice = one commit; the commit message names the phase and slice.
  Use `git mv x.js x.ts` (or plain `mv` + staged rename) so history follows.
- **Use the guardrail toolkit** (`tools/ts-migration/`, see its README —
  built 2026-07-27, before T0):
  - `status.mjs importers <file>` before every rename — finds all
    references by any mechanism (dynamic imports, `new URL()`, spawn
    paths, `bin`/`exports`, docs) and separates fixture hits that must
    not be rewritten.
  - `status.mjs closure <files…>` before starting a slice — verifies
    strategy rule 6.
  - `verify-freeze.mjs --base <pre-slice ref>` before every commit —
    mechanically enforces strategy rule 7 by token-diffing each
    conversion against its stripped-types form. A FAIL is a stop, not a
    suggestion; if you believe the flagged delta is legitimate, that is
    the orchestrator's call, not yours.
  - `tests/repository/specifier-resolution.test.js` runs inside every
    `npm test` and fails on any dangling relative specifier — this is
    what catches a missed rewrite in a not-yet-converted `.js` importer
    that `tsc` cannot see. It already understands the emit-dir
    `.js` -> `.ts` mapping and the viewer's `/shared/` URL mapping
    (hazard 10), so T10 should not need to change it.
- Contract rule from `docs/CONTRACTS.md` applies: if a phase changes
  anything a contract owns (import specifier targets, CLI behavior, viewer
  routes, serving), update the owning contract file in the same change.
  Pure extension renames with stable subpath keys and stable behavior are
  not contract changes, but T6 and T10 do have contract-touching edits.
- If anything in this plan contradicts what you find in the repo, stop and
  report; do not improvise a new strategy mid-phase.

### Per-slice conversion procedure

1. Pick the slice (the phase says which files). Verify it is import-closed:
   `node tools/ts-migration/status.mjs closure <files…>` must pass.
2. For each file, find every reference first:
   `node tools/ts-migration/status.mjs importers <file>`. Then
   `git mv x.js x.ts` and add types top-down (exports first), no runtime
   edits.
3. Update every reference found in step 2 — specifiers in `.js` files not
   yet converted, test literal paths, `new URL(...)` references,
   `bin`/`exports` values when the phase says so. Fixture hits and frozen
   studies are left alone (the tool separates them).
4. `npm run typecheck` — clean, no new suppressions beyond the rules.
5. Full `npm test` — green, zero skipped (includes the
   specifier-resolution gate).
6. `node tools/ts-migration/verify-freeze.mjs --base <pre-slice ref>` —
   every pair OK.
7. Phase-specific gates (listed per phase).
8. Commit.

## Using this doc
If you find any instructions wrong or out of date, update this doc. Any open issues you have not resolved, add them to the open issues section
Mark the phases with your progress appropriately. Example,
- [x] done
- [p] in progress
- [ ] not done

## [x] T0 — Toolchain and canary

Scope:

1. Add `typescript` (current stable, caret range) and `@types/node` to root
   `devDependencies`. No other new dependencies.
2. `tsconfig.base.json` at repo root: `strict`, `noUncheckedIndexedAccess`,
   `verbatimModuleSyntax`, `erasableSyntaxOnly`, `skipLibCheck`,
   `module: "nodenext"`, `moduleResolution: "nodenext"`,
   `target: "es2023"`, `allowJs: false`.
3. `tsconfig.json` (root Node project): extends base; `noEmit: true`,
   `allowImportingTsExtensions: true`, `types: ["node"]`; includes
   `src/core`, `src/cli`, `src/run-viewer` (Node host only), `tests`;
   excludes the scope-exclusion dirs, `src/core/shared`,
   `src/run-viewer/web`, and all fixture dirs from "Scope exclusions".
4. Root script `"typecheck": "tsc -p tsconfig.json"`. T8/T9/T10 extend this
   command with their projects; it must always cover every project that
   exists.
5. Bump `engines` to `">=24.18.0"` in the first-party `package.json`
   files (root, control-plane, runner-agent; `examples/ledger-api` may stay
   as-is — it is out of scope; bump only if trivially safe). Update
   `README.md` install prerequisites to name Node 24 LTS.
6. **Canary:** convert one small, low-fan-in leaf module in `src/core/`
   (pick one with ≤3 importers and no in-repo imports, e.g. a pure util)
   end-to-end using the per-slice procedure. This proves: rename, specifier
   rewrite, typecheck, `node --test` executing a `.ts` transitively, and
   `npm link`ed CLI still working (`playtest --help`).

Exit gate: `npm run typecheck` clean; full `npm test` green;
`node src/cli/cli.js --help` works; canary committed.

## [x] T1 — Core foundation

Scope: `src/core/config.js` (the hub — nearly every core file imports
`DummyConfigError` or config helpers from it), plus its import closure and
the small leaf utils imported widely (candidates found by survey:
`secrets.js`, `runs-root.js`, `match.js`, `invariants.js` — confirm by
grepping actual imports; the slice boundary is whatever makes the set
import-closed, **excluding** `src/core/shared/`).

Additional work:

- Create `src/core/types.ts` (or co-locate in `config.ts` if more natural)
  with hand-written interfaces for the resolved case, defaults, and
  persona shapes — the post-validation forms (strategy rule 8). These types
  are the foundation every later phase builds on; invest here. Where the
  schema is driver-parameterized (`buildCaseValidator` injecting
  success-kind properties), model the variance with discriminated unions,
  not `any`.
- `DummyConfigError` keeps its exact name, message behavior, and export
  site — CLI error-surfacing contract depends on it.

Exit gate: typecheck + full `npm test`. Since config feeds everything:
also `npm run test:browser` once (drivers exercise resolved config against
real Chromium).

## [x] T2 — Core model layer

Scope: `src/core/llm.js`, `actor.js`, `grader.js`, `report.js`,
`anomalies.js`, and whatever their closure adds beyond T1. Introduce a
`FetchLike` type for the fetch-injection seams rather than typing them as
bare `Function`.

Exit gate: typecheck + full `npm test`.

## [x] T3 — Driver contract

Scope: `src/core/driver.js` and `src/core/drivers/` (web, mobile, api).

- Turn the prose driver contract at the top of `driver.js` into a formal
  exported `interface Driver` with the optional members
  (`consoleErrorLog`, `stopRecording`, `snapshotProjection`,
  `redactAction`) marked optional. All three implementations must satisfy
  it structurally — if one doesn't, that is a FINDINGS.md entry, not a fix.
- Hazard 11: the dynamic imports of `./drivers/mobile.ts`, `./drivers/api.ts`
  and `webdriverio` stay dynamic. Type webdriverio via `import type` so the
  optional dependency is never loaded eagerly.
- `docs/contracts/engine.md` owns the driver contract; adding the formal
  interface without changing behavior needs at most a one-line note that
  the contract's Driver shape is now also expressed as a TS interface.

Exit gate: typecheck + full `npm test` + `npm run test:browser`. Run
`npm run test:mobile` if the environment has Xcode/Appium (record in the
phase report whether it ran); orchestrator must ensure it runs at least
once before T11.

Phase report (2026-07-27): typecheck, full root test gate, browser suite, and
behavior-freeze verification passed. The mobile suite did not run: Xcode and
Appium are present, but Appium has no installed `xcuitest` driver.

## [x] T4 — Engine and artifacts

Scope: everything remaining under `src/core/` except `scripts/`, `shared/`,
and `public/`: `runner.js` (1.9k lines — take it in its own slice),
`trajectory.js`, the artifact cluster (bundle, run-history, baseline-scan,
export-playwright, `storage-provider.js` — its `@typedef` becomes the
`StorageProvider` interface), `findings/` (hazard 12: `node:sqlite` stays a
guarded dynamic import), `assertions.js` + `hooks.js` (hazard: the
user-file loaders — mechanism converts, semantics identical), `clip.js`,
`env.js` (hazard 14), `lint.js`, `openapi.js`, `bindings.js`, and the rest.
Multiple slices; each import-closed and committed green.

Exit gate: typecheck + full `npm test` + `npm run test:browser`.

Phase report (2026-07-27): all T4-scoped modules are TypeScript; typecheck,
the 505-test root gate, the 10-test browser suite, and behavior-freeze
verification across all three slices passed.

## [x] T5 — Script substrate

Scope: `src/core/api-suite-scripts/*`.

- Hazard 2: `runner.js`'s `CHILD` URL changes to `./child.ts` in the same
  slice as the `child.js` rename; the spawned child is type-stripped by
  Node like any entry point. Verify the child-spawn tests pass.
- `child.ts:104` loads user script suites — loader converts, user files
  and fixtures stay `.mjs`.
- The lazy imports in `proposals.js` (`./proxy.js`, `./client.js`,
  `./har.js`) get their specifiers updated like static ones.
- `docs/contracts/scripts.md` owns this substrate; behavior is unchanged,
  so expect no contract edits — verify rather than assume.

Exit gate: typecheck + full `npm test` (script suites and sandbox tests
live in the root gate) + control-plane integration suite if available in
the environment (it exercises scripts through the hosted path); otherwise
flag for T8.

## [x] T6 — Entry-point cutover

Scope: `src/core/public/*.js` → `.ts`, `src/cli/*.js` → `.ts`,
`src/run-viewer/node.js` → `node.ts`.

- Root `package.json`: `bin.playtest` → `./src/cli/cli.ts`; every
  `exports` **value** → the `.ts` path. **Keys do not change** (hazard 4).
- Shebang stays line 1 of `cli.ts` (hazard 3); keep the executable bit.
  Re-run `npm link` and verify `playtest --help` and one real subcommand
  (`playtest lint` against a fixture) from a different cwd.
- Hazard 1: update the literal `CLI` spawn paths in `tests/cli/*.test.js`
  to `cli.ts` in the same commit.
- `docs/contracts/interfaces.md` owns supported-import behavior;
  `package.json` owns the executable specifier list. Update
  interfaces.md only if it hard-codes `.js` target paths (grep it).
- Update `README.md` anywhere it shows `node src/cli/cli.js`.

Exit gate: typecheck + full `npm test` + `npm run test:browser`; linked-CLI
smoke as above.

Phase report (2026-07-27): all public core facades, CLI modules, and the
run-viewer Node host are TypeScript; package entry-point values and all live
references now target `.ts`. Typecheck, the 505-test root gate, the 10-test
browser suite, behavior-freeze verification, and linked-CLI help plus fixture
lint from `/tmp` passed.

## [x] T7 — Root tests and support

Scope: `tests/support/`, `tests/core/{unit,integration,browser,mobile}/`,
`tests/cli/`, `tests/run-viewer/node/` + `browser/`, `tests/repository/`.
Convert suite by suite; fixtures under "Scope exclusions" stay JS.

- Hazard 5: when `tests/support/hermetic.js` becomes `hermetic.ts`, update
  all five `--import ./tests/support/hermetic.js` npm scripts and the
  self-reference inside it (`NODE_OPTIONS` re-injection) in the same
  commit; then run every one of those scripts, not just `npm test`.
- npm test-script globs move from `*.test.js` to `*.test.ts` **in the same
  commit as the directory finishes converting** — an unmatched glob is
  passed literally to `node --test` and fails loudly; convert whole
  directories per slice so each glob flips exactly once.
- Hazard 6: `tests/repository/` hygiene/boundary tests pattern-match
  import specifiers and import source files by path. After converting
  them, prove they still bite: temporarily add a forbidden import locally
  (do not commit it), confirm the test fails, revert.

Exit gate: typecheck (tests are in the root project) + full `npm test` +
`npm run test:browser`; zero skipped tests confirmed in output.

Phase report (2026-07-27): all 85 root test/support files and their direct
test-fixture dependencies are TypeScript. The five hermetic preload scripts,
child-process self-reinjection, and completed-suite globs all target `.ts`.
Typecheck, whole-phase behavior-freeze verification, the 505-test root gate,
and the 10-test browser gate passed with zero skipped tests. A temporary
core-to-CLI import made the repository boundary test fail with its intended
diagnostic; the violation was reverted and the restored suite passed.

## [x] T8 — Control plane

Scope: `src/platform/control-plane/` — `src/`, then its `tests/`
(unit + integration). ~150 files; slice by subsystem (config/app/server
pipeline, persistence + migrate, dispatch, routes, feed, retention, then
tests). Migrations `*.sql` untouched.

- Own `tsconfig.json` extending the root base (same flags, `noEmit`,
  `allowImportingTsExtensions`); root `typecheck` script gains
  `&& tsc -p src/platform/control-plane/tsconfig.json`.
- `bin` `playtest-server` → `./src/index.ts`; shebang stays (hazard 3).
- Engine imports go through `src/core/public/*.ts` after T6 — this phase
  updates those specifiers if T6 left any `.js` forms behind (it should
  not have; verify).
- Hazard 7: `tests/integration/exec-helpers.js` literal spawn paths.
- Hazard 8: `dispatch/local.js` spawns the runner-agent by path —
  coordinate the string with T9's rename; whichever lands second fixes it
  and both suites run again.
- Hazard 9: update the path strings in `tools/ux-lab/plane.mjs`
  (string-only edit in an out-of-scope dir is allowed) and run the lab's
  own smoke if cheap; note it either way.
- Boundary meta-check (hazard 6) repeated here: confirm the
  hosted-must-import-public boundary test still fails on a deliberate
  local violation with `.ts` extensions.
- An `AppContext` interface for the ctx object threaded through `app.js`
  is in scope; hand-rolled env parsing in `config.js` stays hand-rolled.
  `ServerConfigError` keeps name and message behavior.

Exit gate: control-plane tsconfig in root typecheck, clean; full
`npm test`; `npm run hosted:test`;
`npm --prefix src/platform/control-plane run test:integration` (needs
`PLAYTEST_FFMPEG` for the clip case — environment-gated, must run before
T11); `npm run hosted` boots and serves the web UI (manual smoke: login
page loads).

Phase report (2026-07-27): all 150 control-plane runtime, unit, integration,
and directly imported fixture/load files are strict TypeScript; the final
import-closure and whole-phase behavior-freeze checks pass. `AppContext` now
types the application context, `ServerConfigError` behavior remains pinned by
unit tests, and the executable entrypoint retains its line-1 shebang. The
runner-agent spawn was left for T9, which has since moved it to `exec-group.ts`; UX-lab imports
target `config.ts`/`app.ts` and its boot smoke passes. The repository boundary
scanner was repaired to include TypeScript runtime imports; a temporary hosted
import of private `core/types.ts` failed with the intended diagnostic and was
reverted. Root typecheck, the 505-test root gate, 267 hosted unit tests, all
155 integrations (using `ffmpeg-full`), hosted login/web-shell boot, and UX-lab
boot all pass with zero skipped tests.

## [x] T9 — Runner agent

Scope: `src/platform/runner-agent/` — 14 files, least JSDoc coverage in the
repo, so expect the most from-scratch typing. Own `tsconfig.json`, root
typecheck extended, `bin` → `exec-group.ts`, shebang kept, lazy
`exec-mint` import specifier updated. Hazard 8 coordination with T8.
Attack fixtures under `tests/fixtures/script-attacks/` stay `.mjs`
(they are user-code models and sandbox-escape probes — byte-for-byte).

Exit gate: typecheck; full `npm test`; `npm run runner:test`; re-run
control-plane integration if hazard 8 strings changed here.

Phase report (2026-07-27): all nine runner runtime modules and five unit suites
are strict TypeScript; the executable and both control-plane spawn paths now
target `exec-group.ts`, while attack fixtures remain byte-identical `.mjs`.
Typecheck, behavior-freeze verification, the 505-test root gate, 23 runner
tests, and all 155 control-plane integrations pass with zero skipped tests.
One named `RunnerDynamic` debt marker remains at the validated protocol/engine
boundary for T11's shared-schema audit.

## [x] T10 — Browser-served code

Scope: `src/platform/web/` (except `vendor/`), `src/run-viewer/web/`,
`src/core/shared/`. This is the only emitting phase; re-read strategy
rule 5 before starting.

1. `tsconfig.web.json` at root: extends base but `noEmit: false`, **no
   `outDir`** (emit beside sources), `lib: ["es2023", "dom", "dom.iterable"]`,
   no `types: ["node"]`, `allowImportingTsExtensions` **off**, imports keep
   `.js` specifiers (tsc maps `./x.js` → `x.ts` source and emits `x.js`).
   Include the three dirs; exclude `vendor/`.
2. Vendor imports: add an ambient `.d.ts` (e.g.
   `src/platform/web/vendor-modules.d.ts`) declaring the vendored yaml
   module surface actually used. Do not enable `allowJs`; vendor files must
   never enter the emit set.
3. Convert each dir wholesale (three slices: shared → run-viewer/web →
   platform/web). In the same commit as each dir's conversion: `git rm` the
   old `.js` sources (the rename does this), add the gitignore rules
   (`src/core/shared/*.js`, `src/run-viewer/web/**/*.js`,
   `src/platform/web/**/*.js` with `!src/platform/web/vendor/**`), and
   confirm `npm run build:web` regenerates byte-plausible `.js` the servers
   can serve.
4. Scripts: add `"build:web": "tsc -p tsconfig.web.json"`, add
   `"prepare": "npm run build:web"` (covers fresh checkout + `npm link`),
   and prepend the build to the suites and entry points that *serve* these
   dirs: `test:viewer`, `test:browser`, and `scripts/hosted-server.sh` (or
   the `hosted`/`hosted:migrate` npm scripts). Root `npm test` includes
   `test:viewer`, so the build runs inside the root gate — it is offline
   and Node-only, which keeps the gate rules intact; state this in the
   commit message.
5. Hazard 10, `src/core/shared/movement.js`: source becomes
   `movement.ts`; Node importers (e.g. `src/core/public/analysis.ts`)
   switch to `./movement.ts` (type-stripped, no build needed for root
   tests); the viewer `SHARED_DIR` and control-plane view route keep
   serving the **emitted** `movement.js` at unchanged URLs — verify
   `/shared/movement.js` (viewer) and `/api/v1/view/shared/movement.js`
   (hosted) both serve post-build, since `story-history.js:33` imports the
   latter at runtime in the browser.
6. Repository guard: add a test asserting no *tracked* non-vendor `.js`
   under the three emit dirs (prevents the edit-the-emitted-file mistake).
7. Contracts: `docs/contracts/hosted.md` owns web invariants and
   `interfaces.md` owns viewer routes — routes and URL space are unchanged,
   but the "checkout must run `build:web` (or `npm install`) before
   serving" requirement is new and belongs in hosted.md; add it.
8. Update `README.md` (install steps) and note the build in
   `CLAUDE.md`'s install section.

Exit gate: typecheck (web project added to root `typecheck` with
`--noEmit`-equivalent check: run `tsc -p tsconfig.web.json --noEmit` in the
typecheck script; emit stays a separate explicit step); full `npm test`;
`npm run test:browser`; hosted boot smoke with a hard-refresh click-through
of the main pages (feed updates, story history — the page with the dynamic
shared import); viewer smoke on a real run dir if one exists locally.

Phase report (2026-07-27): all maintained browser modules in the three emit
directories are strict TypeScript, while browser-facing `.js` specifiers and
URLs remain unchanged. `build:web` emits in place; install, viewer/browser
tests, and hosted startup build before serving. Vendored YAML remains excluded,
and the repository gate rejects tracked generated JavaScript. Shared and hosted
slice freeze checks pass. The viewer check has one reviewed mechanical mismatch:
the source casts two booleans to numbers around the pre-existing subtraction;
the casts erase and the emitted JavaScript retains the original expression.
Root typecheck, the 506-test root gate, 10 browser tests, and 267 hosted unit
tests pass with zero skipped tests. A real-run viewer and an isolated hosted
server both served their emitted applications and shared `movement.js`; hard
refreshes passed across the hosted project, suite, story, and story-history
pages, including the event-feed connection and dynamic shared-module import.

## [x] T11 — Cutover, guards, and docs

Scope, in order:

1. Repo-wide sweep: `find src tests -name "*.js"` (and `.mjs`) — every
   survivor must be a scope exclusion, a fixture, vendor, or gitignored
   emit output. Anything else is unfinished work; finish it or stop.
2. Add the permanent repository guard test: no first-party `.js`/`.mjs`
   may be added under `src/` or `tests/` outside the allowlist (exclusions
   + emit dirs' generated files + vendor). This is the executable form of
   the roadmap's "remove the remaining first-party JavaScript migration
   paths".
3. Debt audit: `node tools/ts-migration/status.mjs` (counts
   `@ts-expect-error` and indicative `any`; hard-fails on
   `@ts-ignore`/`@ts-nocheck`). Burn down what is cheap and document any
   accepted unsafe boundary at its use site.
4. Review `FINDINGS.md` with the user (orchestrator task): every entry
   gets a disposition — fixed separately, accepted, or ticketed on the
   roadmap.
5. Docs: rewrite the "Technology and migration direction" section of
   `CLAUDE.md` (TS is now the source, `typecheck`/`build:web` commands,
   engines floor); update `README.md` end-to-end (any remaining `.js`
   invocation paths, prerequisites); check `docs/contracts/interfaces.md`
   for stale `.js` target references; mark the roadmap item done by
   removing it from `docs/ROADMAP.md` per its "unfinished work only" rule.
6. Full gate matrix, all green, recorded in the completion note:
   `npm run typecheck`, `npm test`, `npm run test:browser`,
   `npm run test:mobile` (environment permitting — must have run at least
   once since T3 on the mobile driver's final form), `npm run hosted:test`,
   control-plane integration, `npm run runner:test`, linked-CLI smoke,
   hosted boot + click-through.

Exit gate: everything in step 6; completion note appended here with date,
final counts (files converted, debt survivors), and gate evidence.

Phase report (2026-07-27): the maintained codebase and tests are now strict
TypeScript. Across T0–T11, 371 `.js`/`.mjs` files became `.ts`; the repository
contains 387 tracked TypeScript files including 16 new type/config/support
modules. The final sweep found and converted one missed maintained benchmark.
The 104 tracked JavaScript survivors are exactly 73 frozen vendored YAML files
and 31 intentional fixtures that pin plain-JavaScript plugin/external-script
support. The 43 additional JavaScript files present after `build:web` are
gitignored browser emit. A permanent repository test rejects any maintained
first-party `.js`/`.mjs` outside those allowlists and separately rejects tracked
browser emit.

`FINDINGS.md` was never created because T0–T11 recorded no behavior bugs or
migration surprises needing disposition. The final cutover audit had zero
`@ts-ignore`/`@ts-nocheck` and 14 justified `@ts-expect-error` sites.

A follow-up type-safety review removed the migration debt labels. Avoidable
escape hatches were replaced with concrete types and guards. Assertions that
encode a checked invariant, intentionally invalid test input, or compatibility
with unvalidated external data now carry permanent `SAFETY:` explanations
instead of pretending to be unfinished migration work.

Gate evidence on the final-form code:

- `npm run typecheck` passed all four projects.
- `npm test` passed 507 committed tests with zero skipped.
- `npm run test:browser` passed 10 Chromium tests with zero skipped.
- `APPIUM_HOME=/Users/jeremy/.appium npm run test:mobile` passed all 5
  XCUITest simulator tests with zero skipped (`xcuitest` 12.1.0).
- `npm run hosted:test` passed 267 tests with zero skipped.
- `PLAYTEST_FFMPEG=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg npm --prefix
  src/platform/control-plane run test:integration` passed 155 integrations
  with zero skipped; the selected ffmpeg exposes `drawtext` and `subtitles`.
- `npm run runner:test` passed 23 tests with zero skipped.
- `npm link`, then `playtest --help` and `playtest lint
  /Users/jeremy/projects/playtest/tests/fixtures/todos` from `/tmp`, passed.
- An isolated hosted server created a project and suite through the browser,
  clicked through Suites, Runs, Findings, and Settings, hard-refreshed, loaded
  emitted `app.js`, imported `/api/v1/view/shared/movement.js`, and reported no
  page errors.
- `verify-freeze.mjs --base HEAD` passed the final `.mjs` → `.ts` benchmark
  conversion. The guard now supports `.mjs` → `.ts` as well as `.mts`.

## Orchestration notes

- **One agent per phase** (T4 and T8 may be one agent doing several
  sequential slices; do not split a phase across parallel agents — the
  import-closure rule makes parallel slices within a phase collide).
  T7/T8/T9 may run as three parallel agents after T6.
- Every agent gets: this file, its phase id, and the standing instruction
  that `FINDINGS.md` is for bugs and surprises — never silent fixes.
- The orchestrator reviews each phase before green-lighting the next: run
  `node tools/ts-migration/verify-freeze.mjs --base <phase-start> --head <phase-end>`
  over the whole range — every conversion pair must be OK. Files the tool
  reports as `NEW` (no `.js` ancestor, e.g. `types.ts`) have no mechanical
  freeze check; read those by hand, plus any hunk in non-renamed files
  beyond specifier rewrites.
- Suggested model routing (per `~/.claude/CLAUDE.md`): mechanical bulk
  phases (T2, T4 slices after the first, T7, T9) — Sonnet-class at max
  effort; contract-defining and cutover phases (T0, T1, T3, T5, T6, T8,
  T10, T11) — Opus-class. Escalate any phase where the typecheck fight
  produces suppression pressure instead of types. Always specify the model
  explicitly.
- Environment-gated suites (`test:mobile`, control-plane integration with
  ffmpeg) must each run at least once on final-form code before T11 signs
  off; the orchestrator tracks this, not the phase agents.
- If a phase is interrupted, the repo is still shippable: every commit is
  green by construction. Resume by re-running the phase's gates to find
  where it stopped.

## Open issues
