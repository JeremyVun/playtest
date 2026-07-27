# Playtest run viewer

`@playtest/run-viewer` is the read-only UI for Playtest run artifacts. It lets a
person inspect what the actor saw and did, compare a changed journey with its
saved path, read grades and evidence, and move through a case's run history.

The package has two parts:

```text
run directory, runs root, or .ptrun bundle
                    |
                    v
       small read-only HTTP server
                    |
                    v
          static browser viewer
```

The Node server understands Playtest's artifact layout and exposes JSON and
file routes to the browser. The browser app renders whatever evidence is
available; missing optional artifacts become placeholders rather than breaking
the page. The server only accepts `GET` and `HEAD`, binds to loopback by
default, blocks path traversal, and supports range requests for media seeking.

The viewer never changes a baseline or a finding. Those decisions happen
through the CLI locally and authenticated API actions in the hosted product.

## Use it

People normally open the viewer through the CLI:

```sh
playtest view
playtest view --latest
playtest view --changed
playtest view runs/<run-id>/<case-id>
playtest view evidence.ptrun
```

Code that needs the local server can use the supported Node export:

```ts
import { serveRun } from "@playtest/run-viewer/node";

await serveRun("runs", { port: 0, open: true });
```

The hosted web package embeds the completed browser build and supplies the same
URL shape through its control-plane adapter.

## Source map

```text
src/node/index.ts   artifact server, run lists, history, and changed-run lists
src/web/app.ts      viewer state, loading, navigation, and rendering
src/web/index.html  browser shell
src/web/style.css   viewer presentation
src/assets.ts       resolved path to the completed browser build
vite.config.ts      self-contained static build
tests/node/         server and artifact-provider tests
tests/browser/      end-to-end rendering tests
```

`build/` is generated and ignored. Browser source keeps `.js` import specifiers
because Vite resolves and bundles it; Node-side TypeScript imports real `.ts`
files.

## Development

Run these from the repository root:

```sh
npm run build --workspace=@playtest/run-viewer
npm run typecheck --workspace=@playtest/run-viewer
npm test --workspace=@playtest/run-viewer
npm run test:browser --workspace=@playtest/run-viewer
```

The Node tests rebuild the viewer and remain browser-free. The browser suite
uses Playwright and covers recorded, healed, discovery, deep-linked, and bundled
runs. Viewer routes and artifact expectations are defined in
[`docs/contracts/interfaces.md`](../../docs/contracts/interfaces.md) and
[`docs/contracts/artifacts.md`](../../docs/contracts/artifacts.md).
