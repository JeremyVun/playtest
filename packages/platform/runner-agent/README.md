# Hosted Playtest runner agent

`@playtest/runner-agent` executes work dispatched by the hosted control plane.
It materializes an immutable suite snapshot in a temporary workspace, resolves
the requested cases with `@playtest/core`, runs them in isolation, uploads
sealed artifact bundles, and reports progress and results over HTTP.

```text
control plane
    |
    | group specification, snapshot, baselines, secrets
    v
runner agent
    |
    +--> temporary suite workspace
    +--> one isolated execution per case --> application under test
    +--> redacted progress and sealed bundles
    |
    v
control plane
```

This package does not decide whether a journey passes and does not maintain a
second engine. Core owns discovery, drivers, replay, healing, gates, grading,
and artifacts. The runner owns hosted execution concerns: authentication,
workspace materialization, isolation, secret handling, upload, cancellation,
and cleanup.

## Execution modes

The agent supports two isolation modes:

- `process` runs cases inside the runner process. It is used by local
  development and tests.
- `container` runs each case in an ephemeral container from the configured job
  image. Persistent hosted runners use this mode.

The agent also runs authentication-mint jobs. A mint provider receives only its
approved inputs in a clean workspace and must return Playwright storage-state
JSON. Secret material is kept out of command arguments and temporary files are
removed after use. During group runs, progress and errors are redacted before
reporting.

In normal use, the control plane starts this package. It is not a standalone
service and has no listening port.

## Command entry points

The executable accepts a dispatched run group or mint claim:

```sh
node packages/platform/runner-agent/src/exec-group.ts exec \
  --group <group-id> \
  --server http://127.0.0.1:4177 \
  --isolation process

node packages/platform/runner-agent/src/exec-group.ts mint \
  --claim <claim-id> \
  --server http://127.0.0.1:4177 \
  --isolation process
```

These commands require a matching control-plane record and runner exchange
credentials. The local hosted launcher supplies them automatically.

## Source map

```text
src/exec-group.ts         group exchange, scheduling, progress, and reporting
src/case-runner.ts        process and container isolation
src/case-runner-child.ts  one-case container protocol
src/workspace.ts          snapshot, baseline, ring-overlay, and secret materialization
src/api-client.ts         authenticated runner-protocol client
src/exec-mint.ts          hosted mint-job lifecycle
src/mint.ts               clean-room provider-script execution
src/redact.ts             secret redaction
src/janitor.ts            workspace and container cleanup
tests/unit/               isolation, workspace, mint, and sandbox-boundary tests
```

## Development

Run these from the repository root:

```sh
npm run typecheck --workspace=@playtest/runner-agent
npm test --workspace=@playtest/runner-agent
```

The unit suite is hermetic and exercises process isolation without requiring a
running control plane or Docker. Hosted behavior and the executor protocol are
specified in
[`docs/contracts/hosted.md`](../../../docs/contracts/hosted.md).
