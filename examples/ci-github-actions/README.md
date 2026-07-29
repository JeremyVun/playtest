# Playtest as a pull-request gate (GitHub Actions)

A complete, copyable workflow that runs a hosted Playtest suite against the
build a pull request just produced — with the app on the job's own `localhost`
and nothing reachable from the control plane.

- [`playtest.yml`](./playtest.yml) — copy to `.github/workflows/playtest.yml`.

This directory is a standalone example. Nothing in the product or the test
suites depends on it, and it is not run by CI in this repository.

## How it works

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
                                            against localhost, uploads,
                                            reports
exit 0 / 1 / 2 from exit_code    ◀────────── group complete
```

Two things make it sound:

1. **The OIDC token is the badge.** No long-lived runner secret sits in
   repository settings. The control plane verifies GitHub's signature and the
   repository, workflow and ref it was configured to trust, then mints a
   credential that expires with the job.
2. **The label is unique per pipeline run.** `ci-run-${{ github.run_id }}` is
   advertised by this job's runner and pinned by this job's launch, so two pull
   requests building at the same moment cannot claim each other's work and test
   the wrong build. A shared label like `ci` would do exactly that, silently,
   and the run would look green against someone else's code.

## What you need

**On the deployment** (an operator sets these once, and they are the whole
authorization story for registration). There is no placement mode to select:
the claim board is the only one, so a runner that polls is all a deployment
needs.

| Variable | Meaning |
|---|---|
| `PLAYTEST_POOL_OIDC_REPOSITORY` | The repository whose workflows may register runners, e.g. `acme/storefront`. Until it is set, the registration route answers `503`. |
| `PLAYTEST_POOL_OIDC_WORKFLOW` | Optional: narrow it to one workflow file, e.g. `playtest.yml`. |
| `PLAYTEST_POOL_OIDC_REF` | Optional: narrow it to one branch. |
| `PLAYTEST_POOL_OIDC_TTL_S` | Optional: how long the credential lives (default 3600, ceiling 21600). |

**In the repository** (Settings → Secrets and variables → Actions):

| Name | Kind | Value |
|---|---|---|
| `PLAYTEST_SERVER` | variable | `https://playtest.example.com` |
| `PLAYTEST_PROJECT` | variable | project key |
| `PLAYTEST_SUITE` | variable | suite id |
| `PLAYTEST_RING` | variable | ring id (Applications → your application → your ring) |
| `PLAYTEST_API_TOKEN` | secret | a project API token with the `editor` role |

`PLAYTEST_API_TOKEN` is a real secret and there is no way around it: OIDC
registers a runner, it does not authorize launching a run. Scope the token to
the one project this pipeline gates.

## Editing it for your app

Two blocks are marked in the file:

- **Build and start the app on localhost** — replace with your own build and
  start commands. Keep the health poll: without it the suite races your app's
  startup and reports a product failure that is really a timing bug.
- **Check out the Playtest runner agent** — point it at your Playtest checkout
  and pin the ref you run in production. Registry distribution is descoped, so
  the agent comes from a repository checkout.

The ring this launches against holds your CI target's URL
(`http://127.0.0.1:3000` or whatever your app listens on) — evaluated from the
claiming runner's network position, which in this job is the job's own machine.
The ring's own runner labels do not matter here: the launch pins its own.

## Reading a failure

The job prints one line per story and exits with the group's exit code: `0` all
passed, `1` a story failed its checks, `2` infrastructure. The full trajectory,
diff and findings are in the console at the run-group link the job logs.

If the job hangs at the wait and then times out, the usual cause is that nothing
claimed the work: check the runner log the last step prints, and confirm the
launch and the runner agree on the label.

More: [`docs/guidance/hosted-runners.md`](../../docs/guidance/hosted-runners.md) for the runner
walkthrough and the CI recipe in prose,
[`docs/contracts/hosted-runners.md`](../../docs/contracts/hosted-runners.md#claim-board)
for the
contract.
