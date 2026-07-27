# Monorepo package structure

**Status:** implemented 2026-07-27.

This design replaces the combined root CLI/core package and the partially
isolated platform workspaces with one private npm monorepo whose package
boundaries match the product's actual ownership boundaries.

## Problem

The repository has outgrown its original shape. It began as one CLI backed by
one engine, so the root `package.json` reasonably owned the executable, core
exports, viewer, dependencies, scripts, and lockfile. The hosted product later
added three workspaces under `src/platform/`, but the original root remained a
combined CLI/core/viewer package.

The result looks like a workspace without behaving like one:

- the root manifest is both product package and repository orchestrator;
- CLI, core, and run viewer have no manifests of their own;
- hosted packages import core and viewer through paths outside their package
  directories instead of declared npm dependencies;
- root dependency hoisting makes undeclared dependencies work;
- the control plane serves viewer source and core browser modules directly;
- control-plane tests reach into web, core tests, root fixtures, and repository
  paths;
- package ownership cannot be inferred from the filesystem or manifests.

This is safe only while every component runs from one checkout with the
current directory layout. It makes deployment composition, dependency review,
test ownership, and future extraction unnecessarily fragile.

## Decision

Playtest becomes a six-workspace npm monorepo beneath a private root:

```text
playtest/
  package.json
  package-lock.json
  tsconfig.base.json

  packages/
    core/
      package.json
      tsconfig.json
      src/
      tests/

    cli/
      package.json
      tsconfig.json
      src/
      skills/
      tests/

    run-viewer/
      package.json
      tsconfig.node.json
      tsconfig.web.json
      src/
        node/
        web/
      tests/

    platform/
      control-plane/
        package.json
        tsconfig.json
        migrations/
        src/
        tests/

      runner-agent/
        package.json
        tsconfig.json
        src/
        tests/

      web/
        package.json
        tsconfig.json
        src/
        tests/

  tests/
    fixtures/
    repository/
    support/

  docs/
  examples/
  scripts/
  studies/
  tools/
```

`packages/platform/` is a grouping directory, not a package. There is no
umbrella platform manifest and no platform runtime. Its three children are
independently executable or buildable workspaces.

The root is orchestration only. It is private, has no executable, exports, or
runtime dependencies, and owns the sole lockfile and repository-wide commands.

## Ownership

| Workspace | Owns | Does not own |
|---|---|---|
| `core` | Journey engine, drivers, configuration, grading, artifacts, schemas, prompts, browser-safe domain projections | CLI presentation, HTTP hosting, hosted persistence, hosted UI |
| `cli` | `playtest` executable, Commander wiring, prompts, preflight UX, local scaffolding, shipped agent skills | Engine behavior, viewer implementation, hosted behavior |
| `run-viewer` | Reusable trajectory viewer UI, its browser build, and the read-only local Node host used by the CLI | Hosted authorization, hosted persistence, platform navigation |
| `platform/control-plane` | Hosted API, auth, persistence, dispatch, bundle access, migrations, and permissioned viewer-data endpoints | Viewer UI source and browser builds |
| `platform/runner-agent` | Hosted execution, workspace materialization, isolation, upload, and progress reporting | Engine implementation and control-plane state |
| `platform/web` | Hosted browser application, navigation, viewer embedding, and the complete hosted browser build | Viewer data authorization and artifact storage |

Repository-level documentation, studies, examples, fixtures, and boundary tests
remain at the root because they span packages or describe the whole product.

Agent skills move with the CLI because `playtest install-skill` is their
distribution path. Tests that compare skill content with another package move
to `tests/repository/`; no production package resolves a repository-root
`skills/` directory.

## Dependency direction

Package placement does not imply dependency direction. All six workspaces are
peers in the npm workspace. Allowed production dependencies are:

```text
CLI             -> core
CLI             -> run-viewer
run-viewer      -> core
control-plane   -> core
control-plane   -> platform-web       (built static assets only)
runner-agent    -> core
platform-web    -> core               (browser-safe domain exports only)
platform-web    -> run-viewer         (viewer browser build)
```

There are no reverse edges and no cycles:

- core depends on no first-party workspace;
- run viewer never depends on CLI or platform;
- CLI never depends on platform;
- platform web never depends on control-plane implementation;
- control plane never depends on run-viewer source or Node host;
- runner-agent never depends on CLI, viewer, web, or control plane.

The control plane's dependency on platform web is an asset-packaging edge. It
resolves the completed hosted build through a documented package export; it
does not import browser application modules.

## Package names and manifests

All packages use the `@playtest` scope; the CLI keeps the `playtest` binary:

| Workspace | Package name | Executable |
|---|---|---|
| `packages/cli` | `@playtest/cli` | `playtest` |
| `packages/core` | `@playtest/core` | — |
| `packages/run-viewer` | `@playtest/run-viewer` | — |
| `packages/platform/control-plane` | `@playtest/control-plane` | `playtest-server` |
| `packages/platform/runner-agent` | `@playtest/runner-agent` | `runner-agent` |
| `packages/platform/web` | `@playtest/web` | — |

All workspaces are `"private": true`; registry distribution remains descoped.
Private does not prevent checkout-based execution or `npm link`.

Every workspace manifest owns:

- its direct runtime, optional, and package-specific development dependencies;
- its executable or export map;
- its `typecheck`, `test`, `build`, and `start` scripts when applicable;
- its Node engine constraint;
- only files and assets inside its package directory.

The root manifest owns:

```json
{
  "name": "playtest-monorepo",
  "private": true,
  "workspaces": [
    "packages/core",
    "packages/cli",
    "packages/run-viewer",
    "packages/platform/*"
  ]
}
```

Shared repository tooling such as TypeScript and Node type declarations may
remain root development dependencies. A tool invoked only by one package is
declared by that package; both run-viewer and platform web therefore declare
their browser bundler.

Internal dependencies use normal version ranges matching the workspace
version. The root lockfile must resolve them to workspace links. Workspace
packages never carry their own lockfile.

## Imports and exports

Cross-package relative imports are forbidden in production and test code.
Imports such as:

```ts
import { runCase } from "../../../core/public/run.ts";
```

become:

```ts
import { runCase } from "@playtest/core/run";
```

This rule includes type-only imports. A type needed by another package is part
of an intentional package export; tests may not conceal a private dependency
by writing `import type`.

Core keeps narrow named facades:

```text
@playtest/core/run
@playtest/core/suite
@playtest/core/artifacts
@playtest/core/analysis
@playtest/core/findings
@playtest/core/media
@playtest/core/llm
@playtest/core/reporting
@playtest/core/api-suite-scripts
@playtest/core/browser/movement
```

Required shared types are exported from the facade that owns their behavior
or from a deliberately small `types` entry point. Consumers never import core
implementation files.

Run viewer exposes separate environments:

```text
@playtest/run-viewer/node
@playtest/run-viewer/browser
@playtest/run-viewer/assets
```

`node` is the local read-only host. `browser` is the browser build entry.
`assets` is a server-safe locator for the package's completed local-viewer
build; it exposes no HTTP or platform behavior.

Platform web exposes only its completed build locator to the control plane:

```text
@playtest/web/assets
```

The existing `@jeremyvun/playtest/core/*` and
`@jeremyvun/playtest/run-viewer/node` specifiers are replaced atomically.
There is no compatibility facade in the CLI package: nothing is published,
and preserving the combined package would recreate the boundary this design
removes. The interface contract is updated in the same change.

## Viewer composition

The viewer is shared product UI, so it is neither owned by core nor by the
hosted platform:

- CLI uses the run-viewer's local Node host and browser build.
- Platform web owns the hosted embedding and includes the run-viewer browser
  build in its own completed build.
- Control plane owns authenticated viewer-data and bundle routes.

The iframe interaction and viewer URL contract remain unchanged. Only asset
ownership changes.

### Browser builds

`run-viewer` builds one self-contained browser asset directory. Its browser
entry imports browser-safe core functions through package exports; the bundler
includes them. The local host serves only this completed directory and run
data.

`platform/web` builds the console and places the completed viewer beneath its
own output:

```text
packages/platform/web/build/
  index.html
  app.js
  app.js.map
  style.css
  viewer/
    index.html
    app.js
    app.js.map
    style.css
```

The control plane serves this build through the web package's `assets` export.
It does not calculate paths into `packages/run-viewer` or
`packages/core`, and it does not serve TypeScript source.

The current `/api/v1/view/shared/*` source-serving route disappears after both
browser bundles include the browser-safe core code they use. Public run-viewer
query parameters, project-scoped viewer URLs, bundle routes, Range behavior,
and same-origin authorization remain unchanged.

### Control-plane cleanup

The current viewer adapter is split by responsibility:

- viewer-data projections and routes remain under the control-plane API;
- bundle loading moves to a control-plane run-storage module because grading,
  findings, review, media, and viewer delivery all use it;
- generic static and Range response helpers live under control-plane HTTP
  infrastructure;
- viewer UI assets come only from the platform-web build.

The control plane must have no import from
`@playtest/run-viewer` and no filesystem reference to core or viewer
source directories.

## Source and asset resolution

Node-side TypeScript continues to run directly through Node's native type
stripping. The restructure does not introduce emitted Node twins or a root
`dist/`.

Package-owned schemas, prompts, personas, migrations, skills, HTML, and CSS
are resolved relative to a module in their owning package. Code may not find
assets by walking upward to a presumed repository root.

The existing platform-web vendor directory remains platform-web-owned and
unmodified; moving it does not turn vendored code into maintained source.

Generated browser output is package-local and gitignored. Production code may
resolve another workspace's generated output only through that package's
documented asset export.

## Tests

Tests follow the code they exercise:

```text
packages/core/tests/
packages/cli/tests/
packages/run-viewer/tests/
packages/platform/control-plane/tests/
packages/platform/runner-agent/tests/
packages/platform/web/tests/
```

Root `tests/` contains only:

- repository structure and dependency-boundary tests;
- shared black-box fixtures;
- support used by more than one package;
- true cross-package end-to-end tests.

In particular:

- tests of platform-web modules move out of control-plane tests;
- shared findings corpora move to root test support instead of one package
  importing another package's tests;
- cross-package tests import public package exports;
- black-box tests resolve an executable from its workspace manifest rather
  than hard-coding a source path;
- test-only access to a private implementation uses an owning-package test
  seam, never an undeclared cross-package path.

Repository tests enforce:

1. exactly the six expected workspace manifests and one root lockfile;
2. a private orchestration-only root with no `bin`, `exports`, or runtime
   dependencies;
3. no cross-package relative imports, including type-only imports;
4. every non-relative third-party or first-party import is declared by the
   importing workspace;
5. only the dependency edges listed in this design;
6. no cycles in the first-party workspace graph;
7. no production path traversal to repository-root assets;
8. generated browser files remain ignored;
9. package export maps expose only intentional public entry points.

Hoisting remains an npm implementation detail, never evidence that a
dependency was declared correctly.

## Root workflows

The checkout workflow remains one install and one lockfile:

```sh
npm install
npm test
npm run typecheck
```

Root commands orchestrate package-owned scripts. Ordered browser builds run
run-viewer before platform web:

```text
build:web = run-viewer build, then platform-web build
typecheck = every workspace, then repository tests/types
test      = the existing fast hermetic package suites and repository gate
```

The root `npm test` contract remains offline, Node-only, browser-free, and
zero-skip. Browser and mobile suites remain explicit.

Checkout-based CLI use becomes:

```sh
node packages/cli/src/cli.ts --help
npm link --workspace=@playtest/cli
playtest --help
```

Hosted commands target workspace names, not directory prefixes. The hosted
startup script may install and build from the root, but it must not infer that
dependencies exist by checking a hoisted package path.

No command loads `.env` except the existing explicitly documented hosted
startup path. The restructure does not broaden environment-file access.

## Migration

The change lands in reviewable, green stages:

### 1. Establish semantic package boundaries

- Add manifests for core, CLI, and run-viewer in their current directories.
- Make the root private and orchestration-only.
- Declare every direct dependency.
- Replace production cross-package relative imports with package exports.
- Add dependency and cycle repository tests.
- Keep physical source paths stable during this stage.

### 2. Separate viewer delivery

- Give run-viewer a self-contained browser build.
- Make platform web consume and package that build.
- Bundle browser-safe core modules instead of serving core source.
- Split control-plane viewer data, bundle storage, and static response
  responsibilities.
- Remove control-plane imports and paths into run-viewer source.

### 3. Move packages

- Move source, assets, migrations, and package-owned tests with `git mv`.
- Adopt the final `packages/` layout.
- Update package-local resource resolution and TypeScript configurations.
- Move CLI-distributed skills under the CLI package.
- Keep root fixtures and genuine cross-package tests at the root.

### 4. Cut over workflows and contracts

- Regenerate the single root lockfile.
- Update root scripts, hosted startup, documentation, and test commands.
- Update interface and hosted contracts for package names and viewer asset
  ownership.
- Update repository maps and path references.
- Re-run `npm link` from the CLI workspace and exercise local and hosted
  viewer paths.

No stage introduces a second lockfile, checked-in generated JavaScript, or
temporary compatibility imports across package directories.

## Acceptance criteria

The restructure is complete when:

- `npm query .workspace` reports exactly the six intended workspaces;
- `npm install` from a clean checkout creates one root lockfile and all
  first-party workspace links;
- each workspace's runtime imports are represented in its own manifest;
- moving any package directory without changing its package exports cannot
  break another package through a relative source path;
- the root package has no product identity or runtime dependencies;
- `npm run typecheck`, `npm test`, hosted unit/integration tests, runner tests,
  browser tests, and mobile tests retain their documented behavior;
- `npm link --workspace=@playtest/cli` exposes a working `playtest`;
- local `playtest view` and the hosted run page render the same viewer build;
- the hosted viewer retains authorization, deep links, Range requests,
  history, changed-run review, themes, and keyboard behavior;
- the control plane contains no viewer UI source ownership and no path into
  core or viewer source;
- platform web owns the complete hosted browser artifact;
- package and test ownership can be understood from the directory tree
  without consulting historical context.

## Non-goals

- Publishing packages to a registry.
- Separate lockfiles or independently versioned releases.
- Turning `packages/platform/` into a deployable package.
- Splitting the control plane into more services.
- Changing CLI commands, engine behavior, artifact formats, or hosted product
  behavior.
- Bundling or emitting Node-side TypeScript.
- Making each workspace usable outside the repository without the root
  toolchain and shared test fixtures.
