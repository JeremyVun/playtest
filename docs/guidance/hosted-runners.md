# Self-hosted runners

A **runner** is the machine your suites actually execute on. Playtest's hosted
control plane stores suites, snapshots, runs, and findings; it never touches your
app. That is what makes a self-hosted runner useful: it runs where the target
already is — your laptop, a build box, a CI job — so a suite can reach an app on
`localhost` or anything behind your firewall.

Everything the runner does is **outbound**. It dials the control plane over
HTTPS, advertises labels, and asks for work. Nothing ever connects to it, and you
never open a port, publish a tunnel, or hand out a database credential.

There is exactly **one placement model**, and it is this one. A launch writes a
board entry and stops; a runner claims it. Your laptop, a CI job, and a fleet
machine all arrive the same way, which means the thing you debug locally is the
thing that runs in CI.

```text
launch ──▶ claim board          runner
             (a dispatch row)     │
                    ▲             │ 1. poll   — long-poll for offers
                    └─────────────┤ 2. claim  — exactly one runner wins
                                  │ 3. exchange — credential ⇄ scoped bearer
                                  ▼ 4. execute, report, complete
```

Claiming assigns work; **exchanging** authorizes it. A registration credential on
its own cannot read a suite, a secret, or a snapshot — it can only take a job off
the board and trade that claim for a short-lived bearer scoped to that one job.
The contract for the board, credentials, labels, and loss handling is
[`contracts/hosted-runners.md`](../contracts/hosted-runners.md#claim-board).

## 1. Register the runner

In the console: **Settings → Runners → Register runner**.

- **Name** — how this machine appears in run history (`adas-laptop`). Unique
  among the project's live runners; revoking one frees its name again.
- **Labels** — what this machine can do (`macos, ios-sim`). Labels are routing,
  not authority: an environment asking for `ios-sim` places its runs on a runner
  advertising `ios-sim`. Leave blank and this runner accepts any of the project's
  runs. A label is spelled with letters, digits, `.`, `_` and `-` — the field is
  comma separated, so a comma inside a label would be two labels, and a label
  reaches the agent through a shell.

Registering mints a credential and shows it **once**. Copy it before closing the
dialog: Playtest stores only a hash and cannot show it again, and if you lose it
the remedy is to revoke that runner and register it again under the same name.

A registered runner's row says whether it is here right now — online, running a
job with a link to that run, offline with how long the silence has been, or never
started — kept current by the event feed rather than by a page that reloads
itself.

## 2. Start it on that machine

From a Playtest checkout, with the credential you copied:

```sh
PLAYTEST_RUNNER_CREDENTIAL='ptr_…' ./node_modules/.bin/runner-agent pool \
  --server https://playtest.example.com
```

The runner advertises the labels it was registered with, so the start line does
not repeat them; `--labels` is an override, not a requirement.

The credential travels in the environment, never as an argument, so it stays out
of your process list and out of anyone else's `ps`. Pasted this way it does land
in your shell history, so on a machine other people use, put it in a file only
you can read and point `--credential-file` at that instead:

```sh
umask 077 && printf 'ptr_…' > ~/.playtest/runner-credential
./node_modules/.bin/runner-agent pool --server https://playtest.example.com \
  --credential-file ~/.playtest/runner-credential
```

`npm link --workspace=@playtest/runner-agent` puts `runner-agent` on your PATH,
which is the bare `runner-agent pool …` the console shows. `pool` is the only
mode there is: the agent is a long-lived process, and nothing ever starts it per
job.

The runner states what it is before it does anything:

```text
Playtest runner "adas-laptop" — project acme
  server     https://playtest.example.com
  labels     macos, ios-sim
  isolation  process — cases run directly on this machine
  work dir   /tmp/playtest-runner
waiting for work — launch a run against an environment whose runner labels this runner advertises
```

If that banner names the wrong project, the wrong labels, or never appears, stop
here — everything after this depends on it.

Leave the process running. It executes one run group at a time and goes straight
back to waiting; `Ctrl-C` (or `SIGTERM`) finishes the case in flight, reports it,
and exits. Restarting a runner that was mid-group resumes the same group.

### Flags

| Flag | Meaning |
|---|---|
| `--server <url>` | The control plane to dial. Also `PLAYTEST_SERVER_URL`. |
| `--labels a,b` | Override what this machine advertises; without it the runner advertises the labels it was registered with. Also `PLAYTEST_RUNNER_LABELS`. |
| `--isolation process\|container` | `process` runs cases directly (a laptop, an ephemeral CI machine); `container` runs each case in its own container. Runs record which one produced them. |
| `--work-dir <dir>` | Where suites are materialized. Cleaned up after each group. |
| `--credential-file <path>` | Read the credential from a file instead of the environment. Also `PLAYTEST_RUNNER_CREDENTIAL_FILE`. |
| `--config <path>` | This machine's own facts: mobile builds, Appium backends, devices, and optionally labels ([§7](#7-mobile-the-runner-supplies-the-build)). Also `PLAYTEST_RUNNER_CONFIG`. |

A credential passed as an argument is refused, not accepted quietly.

## 3. Route work to it with environment labels

A **environment** is one deployment of one application — its URL, its authorization, and
its placement. Under **Applications → (your application) → (your environment)**, set
**Runner labels** to the labels that should route work here (`macos, ios-sim`),
using the same alphabet the runner's own labels use. A run is placed on a runner
advertising *every* label its environment asks for; an environment with no labels runs anywhere
in the project.

A web or API environment also carries a **base URL, evaluated from the claiming
runner's network position**. `http://127.0.0.1:4173` therefore means "on the
runner's own machine" — start the service there, point the environment at it, and
launch. The control plane never resolves that address; the runner does, because
it is the one making the request. Nothing about that URL lives on the runner.

## 4. Local development: the peer runner

`npm run hosted` starts the control plane, the console, **and one runner beside
them**. It is not a special mode: it registers, polls, claims, and exchanges like
every other runner on this page. Killing the difference between "how local
placement works" and "how real placement works" is the point.

What it does for you, under `PLAYTEST_AUTH=dev` only:

- the control plane ensures one **site-scoped** runner named `local` at boot and
  writes its credential to `$PLAYTEST_DATA_DIR/local-runner.credential`, mode
  `0600`. It is idempotent — a second boot reuses the same runner;
- `scripts/hosted-server.sh` starts `runner-agent pool` against that credential
  file, restarts it if it stops, and stops it when the server stops. The agent's
  own backoff covers the boot order;
- it seeds `$PLAYTEST_DATA_DIR/runner.yaml` with the runner configuration schema
  commented out, and starts the agent with `--config` pointing at it. Web and API
  runs need nothing in it; uncommenting it is the whole of mobile setup (see
  [Mobile](#7-mobile-the-runner-supplies-the-build)).

A first web run locally is therefore: create an application, create an environment
`local` with `http://127.0.0.1:4173`, launch. No runner file is touched and no
credential is copied anywhere.

For a local iOS Simulator demo, the repository helper builds the checked-in
`TodoFixture.app`, checks Appium and XCUITest, boots the simulator, writes the
site-qualified binding to that same `runner.yaml`, and starts the console plus
its peer runner:

```sh
npm run hosted:ios -- <project-key>
```

The console application must be Mobile/iOS; the helper defaults its immutable
application and environment keys to `todo/local` and its simulator to
`iPhone 16`. `npm run hosted:ios -- --help` lists overrides for all three, an
existing `.app`, and configure-only use. A hand-maintained, non-generated
`runner.yaml` is never replaced unless `--replace` is explicit, and then it is
backed up first.

If a launch sits unclaimed, check that the agent is up: the server's own log
names the credential file it wrote, and the agent prints its banner on the same
terminal.

## 5. Site-scoped runners

Runner scope is a **trust** decision, not a capability one. A claiming runner
receives suite files and secrets and executes suite hooks, so which projects may
reach a machine has to be explicit. Project scope is the default and the only
scope a project developer can grant.

A **site-scoped** runner is one registration with no project: it polls one board
across every project on the deployment and claims under exactly the same rules.
It is a deliberate site-operator grant, never a default, and it exists so a
single-operator deployment — a laptop running `npm run hosted`, above — does not
have to re-register a runner per project.

What stays true whatever the scope:

- the exchanged bearer is scoped to the **claimed dispatch's** project, like any
  other. A site runner executing project A's group cannot read project B's;
- one active claim, globally. Holding project A's group is what stops it taking
  project B's;
- revocation refuses future polls, claims and exchanges in every project at once,
  while a group already exchanged finishes under the bearer it holds;
- a project's Runners page lists applicable site runners **read-only**. A project
  developer cannot revoke one, and a claim belonging to another project shows
  only as busy — never that project's run or dispatch identifiers.

The lifecycle is three routes, gated to a **site administrator** — an authority
above any single project, which today exists only as the `PLAYTEST_AUTH=dev`
admin bypass:

| Route | Meaning |
|---|---|
| `POST /api/v1/site/runners` `{name, labels?}` | Register; returns the one-time credential. |
| `GET /api/v1/site/runners` | List, with what each is working on. |
| `DELETE /api/v1/site/runners/:id` | Revoke. |

A production deployment provisions no site administrator yet, so it has no site
runners: register project-scoped runners there. Console CRUD, per-project grants,
and production site-admin provisioning are the runner-trust follow-up.

Site runners poll across projects on the board's one-second rescan rather than
its per-project wake, so an idle cross-project poll can take up to a second
longer to notice new work. That is an accepted, bounded cost.

## 6. CI: a runner that lives for one pipeline run

A build machine is the same story as a laptop, with one difference: it is gone
when the job ends, so it should not be carrying a credential you minted by hand
in a console three months ago.

A CI job registers itself. It presents the OIDC token GitHub already mints for
it, and gets back a credential that expires with the job:

```text
GitHub Actions job                          Playtest control plane
──────────────────                          ──────────────────────
build the app; start it on localhost
register with the job's OIDC token ───────▶ ephemeral runner, expires with
  (labels: ci-run-<run_id>)                 the job, never listed as standing
start the runner (long-polls) ────────────▶ claim board
launch, pinned to ci-run-<run_id> ────────▶ dispatch posted to the board
wait for the verdict             ─────────▶ (holds)
                                            the runner claims it, executes
                                            against localhost, reports
exit 0 / 1 / 2                   ◀────────── group complete
```

The complete workflow is in
[`examples/ci-github-actions/playtest.yml`](../../examples/ci-github-actions/playtest.yml) —
copy it into `.github/workflows/` and edit the two marked blocks.

### The label is the point

```yaml
env:
  PLAYTEST_LABEL: ci-run-${{ github.run_id }}
```

That label is unique to one pipeline run. The job's runner advertises it, and the
job's launch pins it:

```jsonc
{ "suite_id": "…", "ring_id": "…", "runner_labels": ["ci-run-1234567"] }
```

`runner_labels` on a launch overrides the environment's labels for that run group only,
so one shared CI environment serves every pull request.

**Without it, concurrent pull requests test each other's builds.** Two jobs
running at once, both advertising a shared label like `ci`, are two runners
eligible for both jobs. The board hands each job to whichever runner asks first,
so PR #41's suite can execute on PR #42's machine — against #42's build, on #42's
`localhost`. Nothing errors. The run is green, and it is green about the wrong
code. A per-run label makes each job's work claimable by exactly one runner: its
own.

The pin travels with the group, so a retry of that run is placed the same way
even if the environment changed since.

### What the deployment has to allow

Registration is only open where an operator says which repository may use it:

| Variable | Meaning |
|---|---|
| `PLAYTEST_POOL_OIDC_REPOSITORY` | The repository whose workflows may register runners (`acme/storefront`). Until it is set, the route answers `503` — an unpinned check would accept a token from anyone on GitHub. |
| `PLAYTEST_POOL_OIDC_WORKFLOW` | Optional: narrow it to one workflow file. |
| `PLAYTEST_POOL_OIDC_REF` | Optional: narrow it to one branch. |
| `PLAYTEST_POOL_OIDC_AUDIENCE` | The audience the workflow requests (default `playtest`). |
| `PLAYTEST_POOL_OIDC_TTL_S` | How long the credential lives: default 3600, ceiling 21600 (GitHub's own job limit). |

The pin is deployment-wide. A deployment hosting projects for teams that should
not trust each other leaves it unset.

One secret remains a secret: launching a run needs a project API token with the
`editor` role, because OIDC registers a runner — it does not authorize starting
work. Scope that token to the one project the pipeline gates.

## 7. Mobile: the runner supplies the build

A mobile build's path on disk, the Appium server that drives it, and the device
it targets are facts only the runner can know, and no platform record holds any
of them. An environment for a mobile application therefore carries no URL, no binary and
no device: the claiming runner supplies all three, from a file on its own disk.

That file is the runner configuration file, and `--config` is how the agent finds
it:

```sh
./node_modules/.bin/runner-agent pool --server https://playtest.example.com \
  --credential-file ~/.playtest/runner-credential --config ~/.playtest/runner.yaml
```

`npm run hosted` already passes it: the peer runner reads
`$PLAYTEST_DATA_DIR/runner.yaml`, which is seeded with this schema commented out.
Uncommenting it is the whole of mobile setup.

### The file

```yaml
version: 1

targets:
  - project: acme                    # the project key, from the console URL
    application: todo-ios            # the application key
    environment: local               # the environment key
    platform: ios                    # ios | android
    app: /Users/ada/build/Todo.app   # your build; relative paths resolve here
    backend: local-ios
    device: iPhone 16                # optional — omit for Appium's default

mobile:
  backends:
    local-ios:
      platform: ios
      appium:
        mode: managed
```

The target names all three parts of its identity instead of encoding them in
YAML nesting. `project`, `application`, and `environment` are the **immutable**
keys the console shows, not display names; nothing else in the file is visible
to the platform. Rename an application freely — the binding holds.

`app:` pointing at a path is the whole of v1's provider story: the build is
already on this disk, however it got there — Xcode, a CI artifact download, a
copy from a colleague. Pulling a build from an internal artifactory or registry
by version is the stated v2: a runner-side provider behind the same
application/environment binding, so when it lands nothing changes on the platform, the
environment, or this file's keys.

The runner validates the whole file at startup and refuses to run on a problem it
can see from here: a target naming a backend you never declared, a platform that
disagrees with its backend, a build that is not on this disk, a duplicate entry,
a credential written as a value. Each refusal names the position in the file. Its
banner then states what it bound:

```text
Playtest runner "adas-laptop" — project acme
  server     https://playtest.example.com
  labels     macbook, ios
  isolation  process — cases run directly on this machine
  work dir   /tmp/playtest-runner
  config     /Users/ada/.playtest/runner.yaml
  targets    acme/todo-ios/local — ios via backend "local-ios"
  backends   local-ios — ios, managed Appium (started here)
waiting for work — launch a run against an environment whose runner labels this runner advertises
```

Build paths and devices are deliberately absent from that banner, and from
everything this runner sends. They stay in the file.

### Managed or external Appium

**`mode: managed`** is the default and the one to start with. The runner picks an
unused port, starts Appium on **loopback only**, health-checks it, uses it for
the group, and stops it afterwards. You never hand-start anything. It does check
that Appium and the platform driver are installed, and refuses with the exact
command when they are not:

```sh
npm i -g appium                                     # or use this checkout's copy
APPIUM_HOME="$HOME/.appium" appium driver install xcuitest      # or uiautomator2
```

It never installs them for you. A runner that silently mutates its own toolchain
is a runner nobody can reason about.

**`mode: external`** dials an Appium that already runs — a shared grid, a device
cloud, a server you supervise yourself:

```yaml
mobile:
  backends:
    grid:
      platform: android
      appium:
        mode: external
        url: https://grid.internal:4723
        credential_file: /etc/playtest/grid.credential   # 0600, this user only
```

**Credential values are never written in this file.** A `password:` key, or a
`https://user:pass@grid/` URL, is refused with the indirection to use instead:
`credential_file` names a file, or `credential_env` names an environment variable
already set for the agent. The credential reaches the WebDriver client through a
local-only driver input and appears in no run, manifest, or error — the same
boundary as everything else on this page.

The file's contents (`user:key`, or a bare token) become basic auth or a bearer
header respectively.

### Labels, and how CI interacts with this

A config file may declare the runner's labels:

```yaml
labels: [macbook, ios]
```

Labels then come from **exactly one place**. Declaring them in the file *and*
passing `--labels` (or setting `PLAYTEST_RUNNER_LABELS`) is a startup error, not
a merge — "what does this runner advertise" must never be a question you answer
by reading two files and a shell history.

That matters for the CI recipe in §6, whose whole mechanism is a per-job
`--labels ci-run-<run_id>`: a CI runner with mobile bindings must leave `labels`
out of its config file and keep passing the flag. A standing machine is the
opposite — put its labels in the file beside its bindings, and the start command
stays short.

### What a mobile run does on the runner

After it wins a claim, and before any case starts, the runner checks what only it
can check: the build is on this disk, the Appium client is importable, the
backend answers, the platform driver is installed. A failure ends the group with
one infrastructure error naming the remedy — not a driver stack forty steps into
a story. The message on the run page names the config key to fix; the path itself
stays in the runner's own log.

Two behaviors worth knowing:

- **mobile cases run one at a time**, whatever the suite's `parallel` says. Two
  cases cannot share a simulator.
- **container isolation refuses mobile offers**, with that reason, rather than
  failing strangely: a container reaches neither the device, nor a loopback
  Appium, nor a build outside the workspace. Run mobile on `--isolation process`.

A first mobile run is therefore: create the application and its environment in the
console, add the three lines above to this file, restart the runner, launch.

## 8. Revoking a runner

**Settings → Runners → Revoke** for a project runner;
`DELETE /api/v1/site/runners/:id` for a site one. Either way revocation is a
timestamp, not a delete: the row and its history stay, so a run placed on that
machine still reads.

From that moment its future polls, claims and exchanges are refused. A group it
had **already exchanged** keeps running under the short-lived bearer it holds,
heartbeats included — revoking never kills work you are waiting on.

## 9. When it does not work

| What you see | What it means |
|---|---|
| The run sits in `queued`, then fails naming labels | Nothing that advertises those labels checked in. Compare the environment's runner labels with the runner's banner. |
| `no runner has checked in … this project has none registered` | Nothing is polling for this project. Register and start one — or, locally, check that `npm run hosted` still has its peer runner up. |
| `runner "…" claimed this run and stopped checking in` | The runner process died, slept, or lost the network mid-group. The story is reported as an infrastructure failure and the remainder is placed once more. |
| `this runner credential is not registered` | The credential was revoked, or belongs to another deployment or another data root. Register the runner again. |
| The runner is quiet after `waiting for work` | That is the steady state. It prints when it claims something. |
| `skipping run group …: this runner has no configuration binding …` | The offer needs a machine-local binding this runner does not hold. Add it under `--config`, or let a runner that has it claim the offer — the offer is untouched either way. |
| `skipping run group …: … the Appium backend "…" cannot start here` | Appium or its platform driver is missing, or an external backend is not answering. The reason names which; the install command is in it. |
| `skipping run group …: this runner runs cases in containers` | Mobile needs `--isolation process`. |
| `the app build this runner binds to "…" is not on the runner's disk` | The claim succeeded and the preflight did not. Rebuild, or correct the `app` path in that runner's config file. |
| A CI registration answers `503 not_configured` | The deployment has not named the repository allowed to register runners (`PLAYTEST_POOL_OIDC_REPOSITORY`). |
| `registered for one CI job and that registration expired` | The ephemeral credential outlived its window (`PLAYTEST_POOL_OIDC_TTL_S`). Register again from the job that needs it; a group already running is unaffected. |
| `this action needs a site administrator` | Site-scoped runners exist only under `PLAYTEST_AUTH=dev` today. Register a project-scoped runner instead. |

## Security notes

- The credential proves identity and nothing else. Claiming assigns work;
  exchanging authorizes it. A credential alone cannot read a snapshot or post a
  report, and the bearer it exchanges for opens exactly one run group or mint.
- Labels are untrusted routing input. They route and never authorize: a runner
  can only ever reach the jobs its credential's scope already allows.
- Site scope is a deliberate grant, never a default, because a site runner
  receives every project's suite files and secrets. It is administered above the
  projects, and no project developer can create or revoke one.
- Revoking a runner refuses its future check-ins, claims and exchanges
  immediately; a group already in flight finishes under the token it was already
  issued.
- An ephemeral CI registration is a smaller blast radius again: it is minted from
  a signed GitHub token rather than a stored secret, it expires with the job, and
  it never appears in the standing runner list. Its verified provenance —
  repository, workflow, ref, commit, run — is recorded beside it.
- Isolation is stated, not laundered. A persistent shared machine running
  `--isolation process` is visible as such on the runs it produced, so a reviewer
  can see what produced the evidence. Use `--isolation container` for a runner
  that serves work from people who should not share a filesystem.
