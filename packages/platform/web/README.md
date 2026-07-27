# Hosted Playtest web console

`@playtest/web` is the browser interface for hosted Playtest. It is a static
single-page application for managing suites and stories, launching and
reviewing runs, inspecting evidence, triaging findings, and configuring a
project.

The package is a browser client, not a web server:

```text
browser console -- /api/v1 --> control plane
       |
       +-- embeds --> run viewer
```

The control plane serves the completed build and owns authentication,
authorization, persistence, and API behavior. The console derives its
permissions from the signed-in principal and only presents actions that the API
can authorize.

## Main surfaces

- Project and suite lists, suite settings, stories, personas, and rule cards.
- Run launch, live progress, run history, retries, and attention filters.
- Embedded trajectory evidence and changed-journey review.
- Findings, consolidation proposals, and finding history.
- Project targets, models, team access, tokens, secrets, and audit settings.

The application uses the browser history API and talks to same-origin
`/api/v1`. `src/lib/api.ts` turns the server's error envelope into friendly
client errors. There is no independent backend configuration in this package.

## Build

Run the ordered repository build from the repository root:

```sh
npm run build:web
```

This first builds `@playtest/run-viewer`, then builds this package and copies
the viewer into `packages/platform/web/build/viewer/`. The result contains the
HTML, CSS, JavaScript, source map, and embedded viewer needed by the control
plane.

`vite.config.ts` deliberately sets `envDir: false`; the browser build does not
load environment files. `build/` and `.test-build/` are generated and ignored.
Do not edit the vendored YAML implementation below `src/vendor/`.

## Source map

```text
src/app.ts          application boot and route registration
src/pages/          page-level loading, rendering, and actions
src/lib/api.ts      same-origin API client and error handling
src/lib/router.ts   history-API router
src/lib/state.ts    signed-in user and project reference state
src/lib/shell.ts    navigation, page frame, theme, and scope
src/lib/feed.ts     live event feed
src/lib/            reusable forms and presentation logic
src/style.css       application styles
src/assets.ts       resolved path to the completed build
vite.config.ts      static build and run-viewer embedding
tests/              DOM-free behavior tests and build contract
```

The browser code is maintained as TypeScript but keeps browser-facing `.js`
import specifiers for the Vite build. Tests compile into `.test-build/` before
Node runs them.

## Development

Run these from the repository root:

```sh
npm run build:web
npm run typecheck --workspace=@playtest/web
npm test --workspace=@playtest/web
npm run hosted
```

Use `npm run hosted` to exercise the real UI; it builds the browser packages and
starts the complete platform at `http://127.0.0.1:4177`. Shared UI/API
guarantees are defined in
[`docs/contracts/hosted.md`](../../../docs/contracts/hosted.md).
