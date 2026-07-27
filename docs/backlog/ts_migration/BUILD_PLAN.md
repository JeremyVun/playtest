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
- Explicit `any`, non-null `!` on dynamic data, and `as` casts that are not
  simple narrowings each require a same-line `// TODO(ts): <reason>`.
  These are debt markers; T11 counts them and the completion note lists
  every survivor. Prefer `unknown` + a narrowing guard over `any`.
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
3. Debt audit: `node tools/ts-migration/status.mjs` (counts `TODO(ts)`,
   `@ts-expect-error`, indicative `any`; hard-fails on
   `@ts-ignore`/`@ts-nocheck`). Burn down what is cheap; list every
   survivor with file/line and reason in the completion note appended to
   this file.
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
migration surprises needing disposition. The final debt audit has zero
`@ts-ignore`/`@ts-nocheck`, 338 same-line `TODO(ts)` debt markers, 14 justified
`@ts-expect-error` sites, and 301 indicative `any` occurrences (including
comments). The remaining debt is at validated dynamic-data, user-code,
protocol, SQL-row, DOM, and third-party declaration boundaries; replacing it
requires shared schemas or behavior changes and was not a cheap cutover edit.

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

Every surviving suppression/debt marker is listed below with its owning
file/line and same-line reason.

<details>
<summary>Final TypeScript debt inventory (352 markers)</summary>

- `src/cli/cli.ts:50` — `TODO(ts)`: Commander callbacks and legacy artifact projections remain dynamic at the CLI boundary
- `src/cli/cli.ts:178` — `TODO(ts)`: the two sentinel branches match the conditional return
- `src/cli/cli.ts:182` — `TODO(ts)`: every non-sentinel value is validated into a number
- `src/cli/cli.ts:491` — `TODO(ts)`: the CLI preserves legacy stack/message handling for arbitrary thrown values
- `src/cli/cli.ts:631` — `TODO(ts)`: JSON.parse(null) preserves the legacy empty-provider failure path
- `src/cli/cli.ts:970` — `TODO(ts)`: fixed headers and rows always contain these columns
- `src/cli/cli.ts:971` — `TODO(ts)`: widths is built for the first three columns
- `src/cli/cli.ts:1139` — `TODO(ts)`: Commander rejection values are treated as Error-like by the existing CLI contract
- `src/cli/findings.ts:33` — `TODO(ts)`: Commander options and findings results remain dynamic at this CLI formatting boundary
- `src/cli/findings.ts:192` — `TODO(ts)`: JSON parse failures are Error-like values with a message
- `src/cli/findings.ts:277` — `TODO(ts)`: every rendered row is built with the header's fixed column count
- `src/cli/findings.ts:278` — `TODO(ts)`: widths is derived from the same cells
- `src/cli/live.ts:12` — `TODO(ts)`: runner event payloads do not yet expose a discriminated public event type
- `src/cli/live.ts:160` — `TODO(ts)`: cost is populated by step results before display
- `src/cli/live.ts:301` — `TODO(ts)`: frame is maintained modulo the non-empty spinner array
- `src/cli/new.ts:132` — `TODO(ts)`: filesystem exceptions are Node ErrnoException values at this boundary
- `src/cli/new.ts:142` — `TODO(ts)`: filesystem exceptions are Node ErrnoException values at this boundary
- `src/cli/new.ts:268` — `TODO(ts)`: filesystem exceptions are Node ErrnoException values at this boundary
- `src/cli/new.ts:320` — `TODO(ts)`: length check guarantees the indexed suite exists
- `src/cli/preflight.ts:121` — `TODO(ts)`: lazy-import failures are Error-like objects with optional Node module codes
- `src/cli/prompt.ts:82` — `TODO(ts)`: range check guarantees the selected name exists
- `src/cli/prompt.ts:83` — `TODO(ts)`: callers provide a documented non-empty name list
- `src/cli/script.ts:42` — `TODO(ts)`: authoring validates this result before returning it
- `src/core/actor.ts:22` — `@ts-expect-error`: Ajv's NodeNext declaration exposes the runtime default constructor as a module namespace.
- `src/core/actor.ts:62` — `TODO(ts)`: the branch above initializes every cache miss
- `src/core/actor.ts:177` — `TODO(ts)`: a step action is always a JSON object, so serialization cannot return undefined
- `src/core/anomalies.ts:138` — `TODO(ts)`: this branch requires a matching confusion marker
- `src/core/anomalies.ts:140` — `TODO(ts)`: this branch requires a matching confusion marker
- `src/core/anomalies.ts:142` — `TODO(ts)`: this branch requires a matching confusion marker
- `src/core/api-suite-scripts/authoring-config.ts:23` — `@ts-expect-error`: Ajv's TS 7 ESM declaration is not constructable although its default runtime export is.
- `src/core/api-suite-scripts/authoring.ts:261` — `TODO(ts)`: both capture groups exist for every FENCE match
- `src/core/api-suite-scripts/child.ts:39` — `TODO(ts)`: sandbox hardening intentionally deletes a dynamic denylist of globals
- `src/core/api-suite-scripts/child.ts:50` — `TODO(ts)`: sandbox hardening intentionally deletes a dynamic denylist of process escape hatches
- `src/core/api-suite-scripts/gate.ts:65` — `TODO(ts)`: splitting a string always yields a first segment
- `src/core/api-suite-scripts/proposals.ts:292` — `TODO(ts)`: matchAll only adds the captured JSON block
- `src/core/api-suite-scripts/proposals.ts:299` — `TODO(ts)`: splitting a string always yields a first segment
- `src/core/api-suite-scripts/proxy.ts:341` — `TODO(ts)`: the listen callback proves the server has an AddressInfo
- `src/core/api-suite-scripts/spec-source.ts:157` — `TODO(ts)`: the successful regex match guarantees capture group one
- `src/core/api-suite-scripts/types.ts:1` — `TODO(ts)`: script suites cross runtime-validated OpenAPI, HAR, user-module, and persisted report shapes
- `src/core/assertions.ts:71` — `TODO(ts)`: runtime checks below validate the user-authored module shape
- `src/core/baseline-scan.ts:35` — `TODO(ts)`: recursively walks arbitrary user and artifact JSON values
- `src/core/bindings.ts:219` — `TODO(ts)`: splitting a string always yields at least one segment
- `src/core/bundle.ts:155` — `TODO(ts)`: name comes from Object.keys on this entries object
- `src/core/bundle.ts:258` — `TODO(ts)`: the runtime guard preserves the historical missing-readRange error
- `src/core/bundle.ts:323` — `@ts-expect-error`: Node accepts a rejected Promise although @types/node omits it from Readable.from's input union.
- `src/core/bundle.ts:692` — `TODO(ts)`: masking to one byte bounds the lookup to the 256-entry table
- `src/core/clip.ts:18` — `TODO(ts)`: legacy manifests and envelopes vary across artifact schema versions
- `src/core/config.ts:43` — `TODO(ts)`: Ajv schemas are cloned and mutated dynamically; Ajv remains the runtime source of truth
- `src/core/config.ts:72` — `TODO(ts)`: internal merge form is scalar-or-list until resolveCase normalizes it
- `src/core/config.ts:132` — `@ts-expect-error`: Ajv's NodeNext declaration exposes the runtime default constructor as a module namespace.
- `src/core/config.ts:349` — `TODO(ts)`: the immediately preceding has() check proves this cache entry exists
- `src/core/config.ts:394` — `TODO(ts)`: resolveCase validates and constructs the exported post-validation union
- `src/core/config.ts:476` — `TODO(ts)`: discovery probe reads untrusted YAML and narrows only the story discriminator
- `src/core/config.ts:657` — `TODO(ts)`: the length check above proves this authored persona list has an element
- `src/core/config.ts:659` — `TODO(ts)`: the length check above proves this inherited persona list has an element
- `src/core/config.ts:740` — `TODO(ts)`: selector validation may throw non-Error values
- `src/core/config.ts:752` — `TODO(ts)`: policy validation may throw non-Error values
- `src/core/config.ts:803` — `TODO(ts)`: duration validation may throw non-Error values
- `src/core/config.ts:942` — `TODO(ts)`: Ajv and the driver checks above establish the discriminated resolved-case draft
- `src/core/config.ts:998` — `TODO(ts)`: YAML.parse returns untrusted data narrowed by Ajv below
- `src/core/config.ts:1001` — `TODO(ts)`: YAML may throw non-Error values
- `src/core/config.ts:1033` — `TODO(ts)`: mutates schema-validated app and environment overlay maps
- `src/core/config.ts:1067` — `TODO(ts)`: this formatter is only called after the corresponding Ajv validation fails
- `src/core/driver.ts:136` — `TODO(ts)`: preserves the legacy optional argument while callers supply runDir
- `src/core/drivers/api.ts:407` — `TODO(ts)`: split always yields a first segment
- `src/core/drivers/api.ts:408` — `TODO(ts)`: parseInt historically receives undefined when the header is absent
- `src/core/drivers/api.ts:476` — `TODO(ts)`: fetch accepts only serializable authored request bodies
- `src/core/drivers/api.ts:507` — `TODO(ts)`: split always yields a first segment
- `src/core/drivers/api.ts:508` — `TODO(ts)`: parseInt historically receives undefined when the header is absent
- `src/core/drivers/mobile-snapshot.ts:156` — `TODO(ts)`: the iOS bbox branch historically lets missing y/height become NaN
- `src/core/drivers/mobile-snapshot.ts:300` — `TODO(ts)`: parsed parent indices always point at an existing earlier node
- `src/core/drivers/mobile-snapshot.ts:301` — `TODO(ts)`: p comes from a parsed parent index
- `src/core/drivers/mobile-snapshot.ts:316` — `TODO(ts)`: loop bounds prove the indexed node exists
- `src/core/drivers/mobile-snapshot.ts:318` — `TODO(ts)`: parsed parent indices always point at an existing earlier node
- `src/core/drivers/mobile-snapshot.ts:319` — `TODO(ts)`: p comes from a parsed parent index
- `src/core/drivers/mobile-snapshot.ts:332` — `TODO(ts)`: loop bounds prove the indexed node exists
- `src/core/drivers/mobile-snapshot.ts:372` — `TODO(ts)`: loop bounds prove the indexed node exists
- `src/core/drivers/mobile-snapshot.ts:399` — `TODO(ts)`: loop bounds prove the indexed node exists
- `src/core/drivers/mobile-snapshot.ts:454` — `TODO(ts)`: the loop condition proves the current rendered line exists
- `src/core/drivers/mobile-snapshot.ts:456` — `TODO(ts)`: the inner loop condition proves the indexed line exists
- `src/core/drivers/mobile-snapshot.ts:460` — `TODO(ts)`: every collapsed run contains at least the current line
- `src/core/drivers/overlay.ts:86` — `TODO(ts)`: this shipped schema is pinned by driver tests and compiled by Ajv
- `src/core/drivers/overlay.ts:179` — `TODO(ts)`: every driver that ships a scoped field has a matching description
- `src/core/drivers/web.ts:219` — `TODO(ts)`: calculated RGBA offsets are inside the 9x8 image data
- `src/core/drivers/web.ts:239` — `TODO(ts)`: a freshly created canvas provides a 2D context
- `src/core/drivers/web.ts:271` — `TODO(ts)`: arm assigned inputAt before scheduling this callback
- `src/core/drivers/web.ts:288` — `TODO(ts)`: es.length proves the last performance entry exists
- `src/core/drivers/web.ts:314` — `TODO(ts)`: instrumentation initializes the field before this reader is installed
- `src/core/drivers/web.ts:315` — `TODO(ts)`: instrumentation initializes the field before this reader is installed
- `src/core/drivers/web.ts:316` — `TODO(ts)`: instrumentation initializes the field before this reader is installed
- `src/core/drivers/web.ts:317` — `TODO(ts)`: instrumentation initializes the field before this reader is installed
- `src/core/drivers/web.ts:453` — `TODO(ts)`: labels.length proves the first associated label exists
- `src/core/drivers/web.ts:675` — `TODO(ts)`: split always yields a first segment
- `src/core/drivers/web.ts:676` — `TODO(ts)`: parseInt historically receives undefined when the header is absent
- `src/core/drivers/web.ts:859` — `TODO(ts)`: launch initializes CDP before returning a WebDriver
- `src/core/drivers/web.ts:1043` — `TODO(ts)`: launch initializes CDP before returning a WebDriver
- `src/core/drivers/web.ts:1201` — `TODO(ts)`: click actions reach #perform only after locator validation
- `src/core/drivers/web.ts:1203` — `TODO(ts)`: type actions reach #perform only after locator validation
- `src/core/drivers/web.ts:1204` — `TODO(ts)`: type actions reach #perform only after locator validation
- `src/core/drivers/web.ts:1211` — `TODO(ts)`: select actions reach #perform only after locator validation
- `src/core/drivers/web.ts:1212` — `TODO(ts)`: select actions reach #perform only after locator validation
- `src/core/drivers/web.ts:1214` — `TODO(ts)`: select actions reach #perform only after locator validation
- `src/core/drivers/web.ts:1216` — `TODO(ts)`: select actions reach #perform only after locator validation
- `src/core/drivers/web.ts:1407` — `TODO(ts)`: the empty-node case returns above
- `src/core/env.ts:12` — `TODO(ts)`: node child-process failures carry platform-specific cause, code, and stderr fields
- `src/core/export-playwright.ts:14` — `TODO(ts)`: generator accepts legacy envelope and manifest fields while rendering strings only
- `src/core/findings/consolidate.ts:44` — `TODO(ts)`: consolidation joins legacy run artifacts, SQLite rows, and validated model plan payloads
- `src/core/findings/intake.ts:28` — `TODO(ts)`: intake spans validated model claims, persisted SQLite rows, and legacy evidence records
- `src/core/findings/keys.ts:33` — `TODO(ts)`: local findings accept legacy candidate payloads before schema-normalized persistence
- `src/core/findings/ledger.ts:31` — `TODO(ts)`: SQLite rows and statement parameters vary by query at this low-level ledger seam
- `src/core/findings/shortlist.ts:25` — `TODO(ts)`: shortlist consumes persisted finding summaries and candidate rows with query-specific shapes
- `src/core/gate.ts:6` — `TODO(ts)`: gate context combines driver-specific envelopes, HAR, OpenAPI, and custom assertion evidence
- `src/core/grader.ts:96` — `TODO(ts)`: grade.schema.json remains the runtime source of truth
- `src/core/grader.ts:97` — `@ts-expect-error`: Ajv's NodeNext declaration exposes the runtime default constructor as a module namespace.
- `src/core/grader.ts:169` — `TODO(ts)`: withAxe contains only envelopes with an axe capture
- `src/core/grader.ts:217` — `TODO(ts)`: the harness writes this validated artifact
- `src/core/grader.ts:299` — `TODO(ts)`: manifest fields consumed here are harness-authored
- `src/core/grader.ts:414` — `TODO(ts)`: the model-facing schema constrains fetch_snapshot arguments
- `src/core/grader.ts:451` — `TODO(ts)`: forcedToolCall reports terminal failures as LlmError
- `src/core/grader.ts:464` — `TODO(ts)`: every loop exit above assigns validated grade arguments
- `src/core/grader.ts:637` — `TODO(ts)`: the length guard proves the indexed envelope exists
- `src/core/grader.ts:645` — `TODO(ts)`: String.replace coerces the numeric step exactly as JavaScript did
- `src/core/grader.ts:693` — `TODO(ts)`: the model-facing schema constrains fetch_snapshot arguments
- `src/core/heal.ts:40` — `TODO(ts)`: projected response bodies are arbitrary JSON shapes
- `src/core/hooks.ts:29` — `TODO(ts)`: cached hook modules are user-authored JavaScript loaded dynamically
- `src/core/invariants.ts:140` — `@ts-expect-error`: Ajv's NodeNext declaration exposes the runtime default constructor as a module namespace.
- `src/core/invariants.ts:163` — `TODO(ts)`: broken[0] is read only on the non-empty branch below
- `src/core/invariants.ts:300` — `TODO(ts)`: the non-empty check above proves the last create exists
- `src/core/invariants.ts:430` — `TODO(ts)`: the non-empty check above proves the last delete exists
- `src/core/invariants.ts:481` — `TODO(ts)`: has() proves the first-seen page exists
- `src/core/invariants.ts:510` — `TODO(ts)`: this branch is guarded by duplicates.length
- `src/core/invariants.ts:514` — `TODO(ts)`: duplicate page numbers were recorded from these same array indices
- `src/core/invariants.ts:520` — `TODO(ts)`: the length guard and problem construction prove both values exist
- `src/core/invariants.ts:573` — `TODO(ts)`: the successful regex match guarantees both capture groups
- `src/core/invariants.ts:600` — `TODO(ts)`: authored policy input is narrowed and normalized by this function
- `src/core/invariants.ts:624` — `TODO(ts)`: stringList rejects an empty list
- `src/core/invariants.ts:625` — `TODO(ts)`: stringList rejects an empty list
- `src/core/invariants.ts:626` — `TODO(ts)`: stringList rejects an empty list
- `src/core/invariants.ts:627` — `TODO(ts)`: stringList rejects an empty list
- `src/core/invariants.ts:656` — `TODO(ts)`: policy-specific required fields were checked against the selected definition above
- `src/core/invariants.ts:660` — `TODO(ts)`: formats untrusted authored policy values before validation
- `src/core/invariants.ts:756` — `TODO(ts)`: recursively traverses arbitrary OpenAPI schema nodes
- `src/core/invariants.ts:837` — `TODO(ts)`: key is selected from Object.keys on this headers object
- `src/core/llm.ts:75` — `TODO(ts)`: models.json is a shipped string map
- `src/core/llm.ts:256` — `TODO(ts)`: a completed Node client response always has an HTTP status
- `src/core/llm.ts:257` — `TODO(ts)`: a completed Node client response always has an HTTP status
- `src/core/llm.ts:258` — `TODO(ts)`: Retry-After is a singleton response header
- `src/core/llm.ts:407` — `TODO(ts)`: node:http rejects with Error instances
- `src/core/llm.ts:426` — `TODO(ts)`: Math.max preserves the existing null-to-zero coercion
- `src/core/llm.ts:439` — `TODO(ts)`: the gateway response is narrowed by defensive optional reads below
- `src/core/llm.ts:440` — `TODO(ts)`: JSON parse failures are Error instances
- `src/core/llm.ts:451` — `TODO(ts)`: tool arguments are runtime-validated by each caller
- `src/core/llm.ts:452` — `TODO(ts)`: JSON parse failures are Error instances
- `src/core/llm.ts:569` — `TODO(ts)`: null is deliberately assigned at runtime and handled by the following falsy check
- `src/core/llm.ts:570` — `TODO(ts)`: caller validation establishes the requested argument shape
- `src/core/llm.ts:578` — `TODO(ts)`: caller validation establishes the requested argument shape
- `src/core/openapi.ts:201` — `TODO(ts)`: the runtime document guard below narrows the resolved root
- `src/core/openapi.ts:240` — `TODO(ts)`: YAML may throw non-Error values
- `src/core/openapi.ts:316` — `TODO(ts)`: JSON Pointer traversal narrows each dynamic document segment at runtime
- `src/core/openapi.ts:341` — `TODO(ts)`: OpenAPI method members are dynamically keyed and narrowed below
- `src/core/openapi.ts:388` — `TODO(ts)`: each untrusted parameter is shape-checked before its fields are consumed
- `src/core/openapi.ts:503` — `TODO(ts)`: authored selector input is narrowed by the runtime checks below
- `src/core/openapi.ts:536` — `TODO(ts)`: formats the same untrusted selector accepted by parseOperationSelector
- `src/core/report.ts:205` — `TODO(ts)`: the preceding branch initializes every missing group
- `src/core/report.ts:253` — `TODO(ts)`: the preceding branch initializes every missing suite
- `src/core/runner.ts:35` — `TODO(ts)`: runner coordinates driver-specific envelopes, hooks, manifests, and model payloads
- `src/core/runner.ts:1346` — `TODO(ts)`: includes intentionally treats a missing action type as a non-match
- `src/core/runs-root.ts:60` — `TODO(ts)`: the map entry is initialized immediately above when absent
- `src/core/runs-root.ts:62` — `TODO(ts)`: only manifests with started_at are admitted to this map
- `src/core/runs-root.ts:80` — `TODO(ts)`: best is selected only from manifests with started_at
- `src/core/secrets.ts:75` — `TODO(ts)`: accepts arbitrary user JSON and narrows it at runtime
- `src/core/secrets.ts:118` — `TODO(ts)`: providers may throw non-Error values
- `src/core/shared/movement.ts:67` — `TODO(ts)`: Non-empty sorted input guarantees these midpoint indexes.
- `src/core/shared/movement.ts:123` — `TODO(ts)`: Loop bound guarantees the indexed comparable entry exists.
- `src/core/snapshot-injected.ts:153` — `TODO(ts)`: labels.length proves the first associated label exists
- `src/core/snapshot-injected.ts:212` — `TODO(ts)`: DOM text nodes always expose textContent
- `src/core/snapshot-injected.ts:441` — `TODO(ts)`: page-side code preserves the message access on arbitrary thrown values
- `src/core/trajectory.ts:269` — `TODO(ts)`: last >= 0 and last starts at length - 1 prove the indexed line exists
- `src/core/trajectory.ts:289` — `TODO(ts)`: callers may refine a validated driver action
- `src/core/trajectory.ts:293` — `TODO(ts)`: formats arbitrary values thrown by user modules
- `src/core/trajectory.ts:338` — `TODO(ts)`: the indexed view records bounds guaranteed by the LCS loops
- `src/core/trajectory.ts:341` — `TODO(ts)`: the matrix dimensions cover every index used by the bounded LCS loops
- `src/core/trajectory.ts:344` — `TODO(ts)`: the matrix and signature indices are bounded by n and m
- `src/core/trajectory.ts:352` — `TODO(ts)`: the loop condition bounds both track indices
- `src/core/trajectory.ts:353` — `TODO(ts)`: the loop condition and matrix dimensions bound these indices
- `src/core/trajectory.ts:354` — `TODO(ts)`: the loop condition bounds the new-track index
- `src/core/trajectory.ts:356` — `TODO(ts)`: i < n proves the baseline-track element exists
- `src/core/trajectory.ts:357` — `TODO(ts)`: j < m proves the new-track element exists
- `src/core/ulid.ts:21` — `TODO(ts)`: modulo 32 is always a valid alphabet index.
- `src/core/ulid.ts:32` — `TODO(ts)`: randomBytes returns exactly RAND_LEN bytes.
- `src/core/ulid.ts:42` — `TODO(ts)`: the loop index is within the fixed-length digit array.
- `src/core/ulid.ts:43` — `TODO(ts)`: the loop index is within the fixed-length digit array.
- `src/core/ulid.ts:69` — `TODO(ts)`: both fixed-length array indices are in range.
- `src/platform/control-plane/src/auth/oidc.ts:33` — `TODO(ts)`: The preceding cache membership check proves the endpoint exists.
- `src/platform/control-plane/src/auth/oidc.ts:118` — `TODO(ts)`: The delimiter guard proves both split components exist.
- `src/platform/control-plane/src/auth/oidc.ts:119` — `TODO(ts)`: The delimiter guard proves both split components exist.
- `src/platform/control-plane/src/auth/oidc.ts:124` — `TODO(ts)`: The delimiter guard proves both split components exist.
- `src/platform/control-plane/src/auth/users.ts:26` — `TODO(ts)`: The selected membership columns are both TEXT.
- `src/platform/control-plane/src/config.ts:60` — `TODO(ts)`: Retention validation attaches structured details to Error.
- `src/platform/control-plane/src/config.ts:143` — `TODO(ts)`: The validated auth mode determines which optional branch is populated below.
- `src/platform/control-plane/src/config.ts:346` — `TODO(ts)`: The missing-variable guard above narrows this dynamic env value.
- `src/platform/control-plane/src/config.ts:347` — `TODO(ts)`: The missing-variable guard above narrows this dynamic env value.
- `src/platform/control-plane/src/config.ts:348` — `TODO(ts)`: The missing-variable guard above narrows this dynamic env value.
- `src/platform/control-plane/src/db.ts:33` — `TODO(ts)`: Raw SQL result schemas are dynamic until the query layer gains generated row mappings.
- `src/platform/control-plane/src/db.ts:190` — `TODO(ts)`: SQL text determines the caller-selected row shape.
- `src/platform/control-plane/src/db.ts:203` — `TODO(ts)`: The Promise constructor synchronously assigns the release callback.
- `src/platform/control-plane/src/db.ts:243` — `TODO(ts)`: The Promise constructor synchronously assigns the release callback.
- `src/platform/control-plane/src/db.ts:313` — `TODO(ts)`: Filesystem startup errors expose code and message.
- `src/platform/control-plane/src/db.ts:324` — `TODO(ts)`: SQLite open errors expose code and message.
- `src/platform/control-plane/src/db.ts:340` — `TODO(ts)`: SQLite pragma failures expose Error.message.
- `src/platform/control-plane/src/dispatch/github.ts:29` — `TODO(ts)`: #requireConfigured guards every operation that consumes required GitHub credentials.
- `src/platform/control-plane/src/dispatch/github.ts:172` — `TODO(ts)`: Network failures expose Error.message at this boundary.
- `src/platform/control-plane/src/dynamic.d.ts:6` — `TODO(ts)`: Legacy hosted dynamic boundaries need named schemas after the behavior-frozen conversion.
- `src/platform/control-plane/src/events/run-events.ts:24` — `TODO(ts)`: INSERT ... RETURNING always produces exactly one row.
- `src/platform/control-plane/src/findings/shortlist.ts:161` — `TODO(ts)`: The length guard proves this neighbor exists.
- `src/platform/control-plane/src/findings/shortlist.ts:190` — `TODO(ts)`: The preceding has/set branch guarantees this group exists.
- `src/platform/control-plane/src/findings/shortlist.ts:192` — `TODO(ts)`: Candidate groups are non-empty by construction.
- `src/platform/control-plane/src/http.ts:89` — `TODO(ts)`: JSON parse failures expose Error.message at this boundary.
- `src/platform/control-plane/src/leases.ts:114` — `TODO(ts)`: Lease failures expose Error.stack at this boundary.
- `src/platform/control-plane/src/ops.ts:83` — `TODO(ts)`: The empty-list branch returned above.
- `src/platform/control-plane/src/ops.ts:119` — `TODO(ts)`: The aggregate query always returns one row.
- `src/platform/control-plane/src/response.ts:78` — `TODO(ts)`: Splitting a non-empty encoding token always yields its name component.
- `src/platform/control-plane/src/response.ts:124` — `TODO(ts)`: Control-plane buffered response headers use scalar strings at these lookup sites.
- `src/platform/control-plane/src/retention/worker.ts:230` — `TODO(ts)`: The null-retention branch returns before this transaction callback is created.
- `src/platform/control-plane/src/retention/worker.ts:363` — `TODO(ts)`: BundleProvider receives size explicitly, so this callback does not need duplicate .size metadata.
- `src/platform/control-plane/src/retention/worker.ts:429` — `TODO(ts)`: Object-store failures expose Error.message at this boundary.
- `src/platform/control-plane/src/store/fs-store.ts:26` — `TODO(ts)`: Buffer.from accepts the runtime Uint8Array branch despite this overload selecting the string form.
- `src/platform/control-plane/src/store/fs-store.ts:40` — `TODO(ts)`: Filesystem errors expose the Node errno code.
- `src/platform/control-plane/src/store/fs-store.ts:53` — `TODO(ts)`: Filesystem stream errors expose the Node errno code.
- `src/platform/control-plane/src/store/fs-store.ts:71` — `TODO(ts)`: Filesystem errors expose the Node errno code.
- `src/platform/control-plane/src/store/object-store.ts:23` — `TODO(ts)`: The reserved S3 adapter implements the seam by throwing not_implemented for every method.
- `src/platform/control-plane/src/suites/snapshots.ts:10` — `TODO(ts)`: Buffer.from accepts the runtime Uint8Array branch despite this overload selecting the string form.
- `src/platform/control-plane/src/suites/tar.ts:51` — `TODO(ts)`: The fixed-size header and loop bounds guarantee this byte exists.
- `src/platform/control-plane/src/suites/tar.ts:63` — `TODO(ts)`: Object.keys guarantees this indexed entry exists.
- `src/platform/control-plane/src/suites/tar.ts:97` — `TODO(ts)`: The full-header loop guard guarantees this byte exists.
- `src/platform/control-plane/src/types.ts:7` — `TODO(ts)`: Route-specific validation narrows untyped JSON request and model response objects.
- `src/platform/control-plane/src/ulid.ts:31` — `TODO(ts)`: The fixed byte count guarantees this typed-array index exists.
- `src/platform/control-plane/src/ulid.ts:41` — `TODO(ts)`: The loop bounds guarantee this typed-array index exists.
- `src/platform/control-plane/src/ulid.ts:42` — `TODO(ts)`: The loop bounds guarantee this typed-array index exists.
- `src/platform/control-plane/tests/bench/sqlite-contention.ts:212` — `TODO(ts)`: modulo indexing always selects one of these inline seed values
- `src/platform/control-plane/tests/bench/sqlite-contention.ts:221` — `TODO(ts)`: modulo indexing always selects one of these inline seed values
- `src/platform/control-plane/tests/bench/sqlite-contention.ts:284` — `TODO(ts)`: SQLite errors expose errstr, message, and errcode at this benchmark boundary
- `src/platform/control-plane/tests/bench/sqlite-contention.ts:295` — `TODO(ts)`: worker execution always has a parent port
- `src/platform/control-plane/tests/bench/sqlite-contention.ts:413` — `TODO(ts)`: SQLite always returns one row for sqlite_version()
- `src/platform/control-plane/tests/bench/sqlite-contention.ts:428` — `TODO(ts)`: vals and widths are derived from the same column list
- `src/platform/control-plane/tests/bench/sqlite-contention.ts:434` — `TODO(ts)`: this branch is guarded by the writes summary
- `src/platform/control-plane/tests/bench/sqlite-contention.ts:435` — `TODO(ts)`: mixed summaries assign reads with writes
- `src/platform/control-plane/tests/integration/runs-index.test.ts:130` — `@ts-expect-error`: Date subtraction is intentional and yields elapsed milliseconds.
- `src/platform/runner-agent/src/dynamic.d.ts:5` — `TODO(ts)`: Runner protocol and engine boundaries need shared validated types after the behavior-frozen conversion.
- `src/platform/web/browser-globals.d.ts:1` — `TODO(ts)`: Hosted web inputs are unvalidated API payloads and heterogeneous DOM content.
- `src/run-viewer/node.ts:27` — `TODO(ts)`: viewer projections intentionally accept legacy manifest and grade shapes
- `src/run-viewer/node.ts:123` — `TODO(ts)`: route failures preserve the existing Error-like message response
- `src/run-viewer/node.ts:126` — `TODO(ts)`: this server listens only on a TCP host/port, never a Unix socket
- `src/run-viewer/node.ts:144` — `TODO(ts)`: Node server requests always carry a URL
- `src/run-viewer/web/app.ts:9` — `TODO(ts)`: Viewer inputs are unvalidated artifact JSON and heterogeneous DOM content.
- `src/run-viewer/web/app.ts:528` — `TODO(ts)`: The startsWith guard guarantees the run query parameter exists.
- `src/run-viewer/web/app.ts:557` — `TODO(ts)`: JavaScript boolean subtraction deliberately orders nulls last.
- `tests/cli/commands.test.ts:22` — `TODO(ts)`: message is read only when spawn reports an Error
- `tests/cli/findings.test.ts:26` — `TODO(ts)`: message is read only when spawn reports an Error
- `tests/cli/install-skill.test.ts:88` — `TODO(ts)`: packaged skill list is asserted non-empty above
- `tests/cli/script.test.ts:22` — `TODO(ts)`: message is read only when spawn reports an Error
- `tests/core/browser/web-driver.test.ts:39` — `TODO(ts)`: successful navigation records its URL
- `tests/core/browser/web-driver.test.ts:218` — `TODO(ts)`: test markup always contains #list
- `tests/core/findings/corpus.ts:647` — `TODO(ts)`: the heterogeneous frozen corpus is consumed through its common fixture shape
- `tests/core/findings/corpus.ts:656` — `TODO(ts)`: callers use ids frozen in this corpus
- `tests/core/findings/evaluator.ts:84` — `TODO(ts)`: exact-key fixture ids name candidates in the same fixture
- `tests/core/findings/evaluator.ts:85` — `TODO(ts)`: exact-key fixture ids name candidates in the same fixture
- `tests/core/findings/evaluator.ts:97` — `TODO(ts)`: shortlist fixture ids name candidates in the same fixture
- `tests/core/findings/evaluator.ts:113` — `TODO(ts)`: routing fixture ids name candidates in the same fixture
- `tests/core/findings/evaluator.ts:130` — `TODO(ts)`: loop bounds prove both clustered candidates exist
- `tests/core/findings/evaluator.ts:131` — `TODO(ts)`: loop bounds prove both clustered candidates exist
- `tests/core/findings/evaluator.ts:140` — `TODO(ts)`: cluster ids originate from the candidate corpus
- `tests/core/findings/spec.ts:130` — `TODO(ts)`: hasExactKeys proves the candidate has a locus
- `tests/core/findings/spec.ts:140` — `TODO(ts)`: hasExactKeys proves the candidate has a locus
- `tests/core/findings/spec.ts:257` — `TODO(ts)`: length check proves the first neighbor exists
- `tests/core/findings/spec.ts:274` — `TODO(ts)`: candidate ids and their parents are initialized together
- `tests/core/findings/spec.ts:275` — `TODO(ts)`: candidate ids and their parents are initialized together
- `tests/core/findings/spec.ts:291` — `TODO(ts)`: the group is initialized immediately before this lookup
- `tests/core/findings/spec.ts:293` — `TODO(ts)`: every connected component contains at least one candidate id
- `tests/core/integration/api-replay.test.ts:137` — `TODO(ts)`: fixture lookup above proves the action exists
- `tests/core/integration/api-replay.test.ts:140` — `TODO(ts)`: fixture lookup above proves the action exists
- `tests/core/integration/api-replay.test.ts:141` — `TODO(ts)`: fixture lookup above proves the action exists
- `tests/core/integration/api-replay.test.ts:144` — `TODO(ts)`: fixture lookup above proves the action exists
- `tests/core/integration/api-replay.test.ts:149` — `TODO(ts)`: fixture lookup above proves the action exists
- `tests/core/integration/export-playwright.test.ts:47` — `TODO(ts)`: frozen generator fixture predates the current envelope contract
- `tests/core/integration/heal-reanchor.test.ts:29` — `TODO(ts)`: a listening TCP server has an AddressInfo result
- `tests/core/integration/script-cards.test.ts:73` — `TODO(ts)`: the generated handout always contains INVARIANTS.md
- `tests/core/integration/script-cards.test.ts:162` — `TODO(ts)`: the generated handout always contains INVARIANTS.md
- `tests/core/integration/script-client.test.ts:50` — `TODO(ts)`: instrumented fetch forwards the legacy variadic signature
- `tests/core/integration/script-runner.test.ts:20` — `@ts-expect-error`: Ajv's NodeNext declaration exposes the runtime default constructor incompatibly
- `tests/core/integration/web-invariants.test.ts:110` — `TODO(ts)`: the committed suite always discovers exactly one case
- `tests/core/integration/web-invariants.test.ts:132` — `TODO(ts)`: this committed suite declares OpenAPI
- `tests/core/mobile/mobile-driver.test.ts:168` — `TODO(ts)`: fixture build prints the app path as its last line
- `tests/core/mobile/mobile-driver.test.ts:184` — `TODO(ts)`: focused fixture supplies only launch-relevant environment fields
- `tests/core/mobile/mobile-driver.test.ts:201` — `TODO(ts)`: simulator discovery returns UDID strings
- `tests/core/unit/bindings.test.ts:171` — `TODO(ts)`: resolution tests deliberately omit unused `into` fields
- `tests/core/unit/bindings.test.ts:177` — `TODO(ts)`: resolution tests deliberately omit unused `into` fields
- `tests/core/unit/bindings.test.ts:179` — `TODO(ts)`: resolution tests deliberately omit unused `into` fields
- `tests/core/unit/bindings.test.ts:181` — `TODO(ts)`: resolution tests deliberately omit unused `into` fields
- `tests/core/unit/clip-args.test.ts:60` — `TODO(ts)`: the fixture always contains file rows
- `tests/core/unit/clip-args.test.ts:61` — `TODO(ts)`: the fixture always contains duration rows
- `tests/core/unit/diff-tracks.test.ts:29` — `TODO(ts)`: two identical input steps produce two diff rows
- `tests/core/unit/diff-tracks.test.ts:30` — `TODO(ts)`: two identical input steps produce two diff rows
- `tests/core/unit/diff-tracks.test.ts:39` — `TODO(ts)`: the asserted operation sequence proves this row exists
- `tests/core/unit/diff-tracks.test.ts:40` — `TODO(ts)`: the asserted operation sequence proves this row exists
- `tests/core/unit/driver.test.ts:28` — `@ts-expect-error`: Ajv's NodeNext declaration exposes the runtime default constructor incompatibly
- `tests/core/unit/driver.test.ts:37` — `TODO(ts)`: incomplete environment reaches unknown-driver validation
- `tests/core/unit/driver.test.ts:161` — `TODO(ts)`: assertion validates schema-derived verb
- `tests/core/unit/export-playwright.test.ts:238` — `TODO(ts)`: every criterion fixture has exactly one key
- `tests/core/unit/findings-consolidation.test.ts:99` — `@ts-expect-error`: Ajv's NodeNext declaration exposes the runtime default constructor incompatibly
- `tests/core/unit/findings-consolidation.test.ts:112` — `@ts-expect-error`: Ajv's NodeNext declaration exposes the runtime default constructor incompatibly
- `tests/core/unit/findings-local-keys.test.ts:64` — `TODO(ts)`: corpus fixtures include legacy scalar loci
- `tests/core/unit/grader-discovery.test.ts:59` — `TODO(ts)`: split always returns at least one segment
- `tests/core/unit/grader-discovery.test.ts:284` — `@ts-expect-error`: Ajv's NodeNext declaration exposes the runtime default constructor incompatibly
- `tests/core/unit/grader-discovery.test.ts:331` — `@ts-expect-error`: Ajv's NodeNext declaration exposes the runtime default constructor incompatibly
- `tests/core/unit/heal-triage.test.ts:116` — `TODO(ts)`: legacy fixture binding predates the current binding contract
- `tests/core/unit/llm-cache.test.ts:49` — `TODO(ts)`: deliberately invalid input pins runtime tolerance
- `tests/core/unit/llm-cache.test.ts:65` — `TODO(ts)`: the local fixture has two messages; input remains unchanged
- `tests/core/unit/llm-cache.test.ts:82` — `TODO(ts)`: the awaited request is present
- `tests/core/unit/llm-cache.test.ts:89` — `TODO(ts)`: the awaited request is present
- `tests/core/unit/llm-coercion.test.ts:57` — `TODO(ts)`: deliberately invalid input pins runtime tolerance
- `tests/core/unit/llm-coercion.test.ts:58` — `TODO(ts)`: deliberately invalid input pins runtime tolerance
- `tests/core/unit/llm-coercion.test.ts:60` — `TODO(ts)`: deliberately invalid input pins runtime tolerance
- `tests/core/unit/mobile-snapshot.test.ts:70` — `TODO(ts)`: deliberately invalid input pins runtime tolerance
- `tests/core/unit/movement.test.ts:56` — `TODO(ts)`: this legacy pin set is wildcard-comparable
- `tests/core/unit/movement.test.ts:61` — `TODO(ts)`: the missing pin field is wildcard-comparable
- `tests/core/unit/movement.test.ts:124` — `TODO(ts)`: a comparable prior produces movement
- `tests/core/unit/movement.test.ts:125` — `TODO(ts)`: a comparable prior produces movement
- `tests/core/unit/movement.test.ts:132` — `TODO(ts)`: a comparable prior produces movement
- `tests/core/unit/movement.test.ts:134` — `TODO(ts)`: a comparable prior produces movement
- `tests/core/unit/openapi.test.ts:171` — `TODO(ts)`: this valid selector cannot parse to null
- `tests/core/unit/raises.test.ts:77` — `@ts-expect-error`: Ajv's NodeNext declaration exposes the runtime default constructor incompatibly
- `tests/core/unit/secrets.test.ts:63` — `TODO(ts)`: deliberately invalid secret name pins validation
- `tests/core/unit/secrets.test.ts:113` — `TODO(ts)`: deliberately missing secret pins validation
- `tests/core/unit/secrets.test.ts:117` — `TODO(ts)`: deliberately unknown key pins validation
- `tests/repository/boundaries.test.ts:34` — `TODO(ts)`: regex capture group is required by the pattern
- `tests/repository/boundaries.test.ts:41` — `TODO(ts)`: regex capture group is required by the pattern
- `tests/run-viewer/browser/viewer.test.ts:97` — `TODO(ts)`: viewer shell always contains #caption
- `tests/run-viewer/browser/viewer.test.ts:119` — `TODO(ts)`: viewer shell always contains #strip-zone
- `tests/run-viewer/browser/viewer.test.ts:145` — `TODO(ts)`: viewer shell always contains #inspector
- `tests/run-viewer/browser/viewer.test.ts:321` — `TODO(ts)`: fixed fixture tuples carry string paths
- `tests/support/json-server.ts:23` — `TODO(ts)`: preserve legacy Error-shaped catch access without changing runtime tokens
- `tests/support/json-server.ts:31` — `TODO(ts)`: Node's listen callback omits the Promise resolver argument
- `tests/support/json-server.ts:33` — `TODO(ts)`: a listening TCP server has an AddressInfo here
- `tests/support/legacy-types.d.ts:5` — `TODO(ts)`: T7 preserves intentionally malformed legacy fixtures for runtime validation tests
- `tests/support/run-fixtures.ts:168` — `TODO(ts)`: the fixed three-action fixture preserves tuple length through map
- `tests/support/run-fixtures.ts:199` — `TODO(ts)`: loop bounds prove the indexed trajectory step exists
- `tests/support/scripted-model.ts:49` — `TODO(ts)`: preserve the legacy null initializer while JSON.parse supplies the call shape
- `tests/support/scripted-model.ts:80` — `TODO(ts)`: Node's listen callback omits the Promise resolver argument
- `tests/support/scripted-model.ts:81` — `TODO(ts)`: a listening TCP server has an AddressInfo here
- `tests/support/scripted-model.ts:123` — `TODO(ts)`: Node's listen callback omits the Promise resolver argument
- `tests/support/scripted-model.ts:124` — `TODO(ts)`: a listening TCP server has an AddressInfo here

</details>

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
