---
name: playtest-ci
description: Close the fix loop on Playtest journey regressions — run the suite, triage each failure with the four-verdict table (app bug / app changed / agent flake / environment flake), fix app bugs, and surface heal diffs for human review. Use after changing UI code, when asked "did I break any journeys?", or when a journey goes red in CI.
---

# Playtest fix loop

Playtest journeys are recorded user paths replayed against the app. When one goes
red, the evidence is on disk — a manifest, a trajectory, a screenshot and an
accessibility snapshot per step. Read the evidence, call one of four verdicts, act.

## Hard rules (read first)

- **Never run `playtest baseline accept` or `playtest baseline reject` yourself.** Acceptance
  rewrites a versioned baseline and stays a human action. Print the command; the
  human runs it.
- **Never edit a case's `story:` or `success:` to make a failure pass.** The YAML
  is spec, not config. You fix application code; weakening the spec is the human's
  call, and only ever proposed.
- **Exit 2 is infra/config, not a test failure.** Report what broke (unreachable
  `base_url`, bad YAML, missing browser); do not touch app code in response to it.

## The loop

1. **Run machine-readably.** If it's ambiguous which suite to run, enumerate with
   `playtest list [paths]` first and ask the user before spending model budget.

   ```
   playtest <paths> --json
   ```

   Exit codes: `0` pass, `1` gate failure (a journey is red, or `--fail-on-changed`
   found unreviewed changed journeys), `2` infra/config. stdout is one JSON object:
   `{ run_id, runs_root, exit_code, cases: [{ id, status, mode, healed, changed,
   run_dir, duration_ms, steps, cost_usd, score, duration_delta_ms, score_delta,
   status_streak, gate_failures: [{ spec, detail, severity }] }] }`.

2. **Read the evidence** for each failed or changed case, in its `run_dir`:
   `manifest.json` → `result.gate.checks[]`, each `{ kind, severity, spec, label?,
   pass, detail, inherited? }`. Failing checks are your assertion-level facts.
   `inherited: true` means the verdict was reused from the baseline on a clean
   replay, not re-evaluated this run. Soft checks (`severity: "soft"` —
   `console_errors` and perf budgets) redden the run but never block baseline
   acceptance, so a soft-only failure is an accept candidate, not a gate.

3. **Call one of four verdicts** (docs/playtest-design.md) and act on it:

   - **App bug** — the task is genuinely impossible, an assertion fails, or errors
     are thrown: Playtest caught an application failure. Fix the application
     code, rerun exactly that case (`playtest <path/to/case>.yaml --json`), and
     loop until green.

   - **App changed** (`healed: true` + `changed: true`) — summarize the heal diff
     in one or two sentences (which step diverged, what the agent did instead),
     then print the review commands for the human and stop:

     For an API heal, read `<run_dir>/drift-report.json` before choosing this
     verdict. Its deterministic `classification` controls triage:
     `regression` is an app bug and must not be offered for baseline acceptance;
     `contract_drift` or `baseline_drift` may be reviewed as an app change.
     Include the report's signals in the summary.

     ```
     playtest view --changed
     playtest baseline accept <run_dir>
     ```

     `baseline accept` requires the exact `run_dir` emitted by the run summary;
     it never resolves a mutable “latest run” alias.

   - **Agent flake** — rerun the case once (`playtest <path/to/case>.yaml --json`).
     If it passes, say so and move on. If it fails the same confused way on an
     unchanged page, propose a clearer `story:` wording to the human — proposed,
     not applied; the spec stays theirs. The playtest-stories skill owns story
     craft (goals not click-paths, second person, 2–4 lines).

   - **Environment flake / exit 2** — report the infra error verbatim
     (`result.error` in the manifest, or the `playtest:` stderr line) and which
     rail broke, then stop (hard rule above).

4. **Report** when the loop ends: per case, the verdict, what you did, and any
   commands you left for the human (accepts, story proposals).

## Running (everyday flags)

`playtest <paths>` runs a suite; the flags you'll actually reach for:

- Scope: `--tag <t>` / `--id <id>` (both repeatable) narrow to a subset; a bare
  study id matches every `<id>@<persona>`.
- Retarget: `--base-url <url>` overrides `app.base_url`; `--env <name>` picks a
  named environment from `app.envs`.
- Speed: `--parallel [n]` runs cases concurrently; `--parallel-record <n>` caps
  how many record at once.
- CI: `--json` (machine summary, above), `--junit <path>` (XML report), and
  `--fail-on-changed` (exit 1 on unreviewed changed journeys). Non-TTY output
  is plain and non-interactive automatically.
- Cheap pass: `--no-grade` skips the grader (deterministic checks only) for a
  fast smoke run; `--fresh` forces a fresh record instead of replaying.

## Surface you may use

`playtest list [paths] [--tag t] [--id i] [--json]` (inventory + `next_run`) ·
`playtest view` + `--changed` / `--failed` / `--latest` / `--case <id>` /
`--changed --json` (machine list of pending changed journeys) ·
`playtest lint [paths]` (offline case-quality warnings, always exits 0) ·
`playtest new <name>` (scaffold).

Baseline lifecycle — all human-run; you diagnose and print the command:
`baseline accept` adopts one changed/healed journey's new path;
`baseline refresh <paths>`
re-records wholesale (needs a model) when a story is legitimately obsolete, not
just changed; `baseline reject` discards a changed candidate. Which to surface — a single
accept vs a whole-suite refresh — is your call.

For a brand-new user, hand off to the playtest-stories skill to scaffold their
real suite (`playtest new <name>`, `--driver web|mobile|api` for their surface).
