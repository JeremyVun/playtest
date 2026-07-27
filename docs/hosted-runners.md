# Self-hosted runners

A **runner** is the machine your suites actually execute on. Playtest's hosted
control plane stores suites, snapshots, runs, and findings; it does not touch
your app. That is what makes a self-hosted runner useful: it runs where the
target already is — your laptop, a build box, a CI job — so a suite can reach an
app on `localhost`, an iOS Simulator or Android emulator, a device, or anything
behind your firewall.

Everything the runner does is **outbound**. It dials the control plane over
HTTPS, advertises labels, and asks for work. Nothing ever connects to it, and
you never open a port, publish a tunnel, or hand out a database credential.

This page is the whole walkthrough: register, start, label, launch — once for a
mobile suite whose app binary is a file on your disk, once for an API suite that
resolves to `http://127.0.0.1:…` on that same machine.

Deployments select pull-based placement with `PLAYTEST_DISPATCH=pool`. The
contract for the claim board, credentials, labels, and loss handling lives in
[`contracts/hosted.md`](./contracts/hosted.md#runner-pool).

## 1. Register the runner

In the console: **Settings → Runners → Register runner**.

- **Name** — how this machine appears in run history (`adas-laptop`). Unique in
  the project.
- **Labels** — what this machine can do (`macos, ios-sim`). Labels are routing,
  not authority: an environment asking for `ios-sim` places its runs on a runner
  advertising `ios-sim`. Leave blank and this runner accepts any of the
  project's runs.

Registering mints a credential and shows it **once**, with the exact command to
start the runner. Playtest stores only a hash of the credential and cannot show
it again; if you lose it, register the runner again and revoke the old one.

## 2. Start it on that machine

Copy the command from the dialog and paste it into a terminal in your Playtest
checkout:

```sh
PLAYTEST_RUNNER_CREDENTIAL='ptr_…' ./node_modules/.bin/runner-agent pool \
  --server https://playtest.example.com --labels macos,ios-sim
```

The credential travels in the environment, never as an argument, so it stays out
of your process list and out of anyone else's `ps`. If you would rather keep it
in a file:

```sh
./node_modules/.bin/runner-agent pool --server https://playtest.example.com \
  --labels macos,ios-sim --credential-file ~/.playtest/runner-credential
```

`npm link --workspace=@playtest/runner-agent` puts `runner-agent` on your PATH if
you prefer the bare command.

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
| `--labels a,b` | What this machine advertises. Also `PLAYTEST_RUNNER_LABELS`. |
| `--isolation process\|container` | `process` runs cases directly (a laptop, an ephemeral CI machine); `container` runs each case in its own container. Runs record which one produced them. |
| `--work-dir <dir>` | Where suites are materialized. Cleaned up after each group. |
| `--credential-file <path>` | Read the credential from a file instead of the environment. Also `PLAYTEST_RUNNER_CREDENTIAL_FILE`. |

A credential passed as an argument is refused, not accepted quietly.

## 3. Point an environment at it

An **environment** is the deployment ring a run happens in: its credentials, its
runner pool, and whether discovery is allowed. Under **Settings → Test targets →
New environment**, set **Runner labels** to the labels that should route work to
this machine (`macos, ios-sim`). A run is placed on a runner advertising *every*
label its environment asks for; an environment with no labels runs anywhere in
the project.

## 4. Mobile: an app binary on your own disk

Build the app as you normally would and note the absolute path of the
`.app`/`.apk`. In the environment's **Advanced → Config JSON**:

```json
{
  "app": {
    "platform": "ios",
    "app": "/Users/ada/build/Todos.app",
    "device": "iPhone 16",
    "appium_url": "http://127.0.0.1:4723"
  }
}
```

That path is read **on the runner**, so it is your own file — nothing is
uploaded, and no size cap applies. Start Appium on that machine, then launch the
suite from the console against this environment: the run executes on your own
simulator and the trajectory lands in the console like any hosted run.

The suite's own **App binary** field is optional and means something narrower: a
small fixture app committed inside the suite. Real builds are far past the
hosted upload caps, which is why the environment (a path on the runner today, an
uploaded artifact in a later phase) is the usual answer.

## 5. Local API: a target on `127.0.0.1`

Start the service on the runner's machine and set the environment's fallback
URL — or the suite's own URL for this environment — to `http://127.0.0.1:4180`.
Launch from the console. The control plane never resolves that address; the
runner does, because it is the one making the request.

The same is true for a web suite pointed at a `localhost` dev server.

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
[`examples/ci-github-actions/playtest.yml`](../examples/ci-github-actions/playtest.yml) —
copy it into `.github/workflows/` and edit the two marked blocks.

### The label is the point

```yaml
env:
  PLAYTEST_LABEL: ci-run-${{ github.run_id }}
```

That label is unique to one pipeline run. The job's runner advertises it, and
the job's launch pins it:

```jsonc
{ "suite_id": "…", "environment_id": "…", "runner_labels": ["ci-run-1234567"] }
```

`runner_labels` on a launch overrides the environment's labels for that run
group only, so one shared CI environment serves every pull request.

**Without it, concurrent pull requests test each other's builds.** Two jobs
running at once, both advertising a shared label like `ci`, are two runners
eligible for both jobs. The board hands each job to whichever runner asks first,
so PR #41's suite can execute on PR #42's machine — against #42's build, on
#42's `localhost`. Nothing errors. The run is green, and it is green about the
wrong code. A per-run label makes each job's work claimable by exactly one
runner: its own.

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

## 7. When it does not work

| What you see | What it means |
|---|---|
| The run sits in `queued`, then fails naming labels | Nothing that advertises those labels checked in. Compare the environment's runner labels with the runner's banner. |
| `no runner has checked in … this project has none registered` | The deployment places runs on self-hosted runners and this project has none. Register one. |
| `runner "…" claimed this run and stopped checking in` | The runner process died, slept, or lost the network mid-group. The story is reported as an infrastructure failure and the remainder is placed once more. |
| `this runner credential is not registered` | The credential was revoked or belongs to another deployment. Register the runner again. |
| The runner is quiet after `waiting for work` | That is the steady state. It prints when it claims something. |
| A CI registration answers `503 not_configured` | The deployment has not named the repository allowed to register runners (`PLAYTEST_POOL_OIDC_REPOSITORY`), or it does not run pool placement at all. |
| `registered for one CI job and that registration expired` | The ephemeral credential outlived its window (`PLAYTEST_POOL_OIDC_TTL_S`). Register again from the job that needs it; a group already running is unaffected. |

## Security notes

- The credential proves identity and nothing else. Claiming assigns work;
  exchanging authorizes it. A credential alone cannot read a snapshot or post a
  report, and it is scoped to one project.
- Labels are untrusted routing input. A runner can only ever reach jobs in the
  project its credential is registered to.
- Revoking a runner refuses its future check-ins and claims immediately; a group
  already in flight finishes under the short-lived token it was already issued.
- An ephemeral CI registration is a smaller blast radius again: it is minted
  from a signed GitHub token rather than a stored secret, it expires with the
  job, and it never appears in the standing runner list. Its verified
  provenance — repository, workflow, ref, commit, run — is recorded beside it.
- Isolation is stated, not laundered. A persistent shared machine running
  `--isolation process` is visible as such on the runs it produced, so a reviewer
  can see what produced the evidence. Use `--isolation container` for a runner
  that serves work from people who should not share a filesystem.
