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

The pool loop also serves authentication-mint claims. A mint provider receives
only its approved inputs in a clean workspace and must return Playwright
storage-state JSON. Secret material is kept out of command arguments and
temporary files are removed after use. During group runs, progress and errors
are redacted before reporting.

The agent is a peer of the control plane, never its child: it dials out, polls
the claim board, and claims work it can execute. The control plane starts no
process in response to a launch and never connects to a runner. It has no
listening port of its own.

## Command entry point

There is one mode — the long-lived pool loop:

```sh
./node_modules/.bin/runner-agent pool \
  --server http://127.0.0.1:4177 \
  --credential-file ~/.playtest/runner-credential \
  --labels macos,ios-sim \
  --config ~/.playtest/runner.yaml
```

The credential comes from runner registration in the console (or, under
`PLAYTEST_AUTH=dev`, from the site-scoped `local` runner the server seeds under
its data root). `--config` names the runner configuration file that binds
mobile applications/rings to builds, devices, and Appium backends on this
machine; web/API-only runners do not need one.

## Source map

```text
src/cli.ts                the `runner-agent` executable (pool mode only)
src/pool.ts               claim-board poll, claim, exchange, and supervision loop
src/runner-config.ts      --config parse, validation, and target bindings
src/exec-group.ts         group exchange, scheduling, progress, and reporting
src/case-runner.ts        child supervision for both isolations, and cancellation
src/case-runner-child.ts  the one-case protocol, in the image and on this machine
src/workspace.ts          snapshot, baseline, ring-overlay, and secret materialization
src/api-client.ts         authenticated runner-protocol client
src/exec-mint.ts          hosted mint-claim lifecycle
src/mint.ts               clean-room provider-script execution
src/appium.ts             managed/external Appium backend lifecycle
src/mobile.ts             mobile preflight and runtime-target assembly
src/live-uploader.ts      in-flight evidence upload for open runs
src/redact.ts             secret redaction
src/janitor.ts            workspace and container cleanup
tests/unit/               isolation, workspace, mint, config, and mobile tests
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
