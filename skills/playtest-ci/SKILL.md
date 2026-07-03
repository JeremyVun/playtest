---
name: playtest-ci
description: Close the fix loop on Playtest journey regressions — run the suite, triage each failure with the four-verdict table (app bug / app changed / agent flake / environment flake), fix app bugs, and surface heal diffs for human review. Use after changing UI code, when asked "did I break any journeys?", or when a journey goes red in CI.
---

# Playtest fix loop

Playtest journeys are recorded user paths replayed against the app. When one
goes red, the failure is evidence on disk — a manifest, a trajectory, a
screenshot and an accessibility snapshot per step. Your job is to read that
evidence, call one of four verdicts, and act on it.

## Hard rules (read first)

- Never run `playtest accept` or `playtest reject` autonomously.
  Acceptance rewrites a versioned baseline and stays a human action. You
  print the command; the human runs it.
- The YAML is spec, not config. Never edit a case's `story:` or
  `success:` assertions to make a failure pass. You fix application code;
  weakening the spec is the human's call, and only ever proposed.
- Exit 2 is infra/config, not a test failure. Report what broke
  (unreachable `base_url`, bad YAML, missing browser); do not touch app code
  in response to it.

## The loop

1. Run the affected suite (or the whole tree) machine-readably. If which
   suite is ambiguous, enumerate first with `playtest list [paths]` and, when it
   isn't obvious which to run, ask the user before spending model budget:

   ```
   playtest <paths> --json
   ```

   Exit codes: `0` pass, `1` gate failure (a journey is red, or
   `--fail-on-changed` found unreviewed changed journeys), `2` infra/config.
   stdout is one JSON object:
   `{ run_id, runs_root, exit_code, cases: [{ id, status, mode, healed,
   changed, run_dir, duration_ms, steps, cost_usd, score, duration_delta_ms,
   score_delta, status_streak, gate_failures: [{ spec, detail, severity }] }] }`.

2. For each changed or failed case, read the evidence in `run_dir`:
   `result.gate.checks[]` (each `{ kind, severity, spec, label?, pass, detail,
   inherited? }`); failing ones are your assertion-level facts, and a
   `reused` check means the verdict was reused from the baseline on a clean
   replay, not re-evaluated this run. Soft checks (`console_errors`,
   perf) redden the run but never block baseline acceptance, so a soft-only
   failure is an accept candidate, not a gate.

   The verdict is one of four (docs/playtest-design.md): App bug, App changed,
   Agent flake, Environment flake. Act on it:

   - App bug — the task is genuinely impossible, an assertion fails, or errors
     are thrown: the failure is the product working. Fix the application code,
     then rerun exactly that case (`playtest <path/to/case>.yaml --json`) and
     loop until green.

   - App changed (`healed: true` + `changed: true`) — summarize the heal
     diff in one or two sentences (which step diverged, what the agent did
     instead), then print the review commands for the human and stop:

     ```
     playtest view --changed
     playtest accept <run_dir>
     ```

     Do not run the accept yourself (hard rule above). `accept` also takes a
     case id or suite/case paths (it resolves the latest run of each), so a case
     id from `list --json` is enough — no need to hand-resolve a `run_dir`.
   - Agent flake — rerun the case once (`playtest <path/to/case>.yaml
     --json`). If it passes, say so and move on. If it fails the same
     confused way on an unchanged page, propose a clearer `story:` wording
     to the human — proposed, not applied; the spec stays theirs. The
     playtest-stories skill owns story craft (goals not click-paths,
     second person, 2-4 lines).
   - Environment flake / exit 2 — report the infra error verbatim
     (`result.error`, or the `playtest:` stderr line) and which rail broke,
     then stop (hard rule above).

5. Report when the loop ends: per case, the verdict, what you did, and
   any commands you left for the human (accepts, story proposals).

## Running (everyday flags)

`playtest <paths>` runs a suite; the flags you'll actually reach for:

- Scope: `--tag <t>` / `--id <id>` (both repeatable) narrow to a subset; a
  bare study id runs every `<id>@<persona>`.
- Retarget: `--base-url <url>` overrides `app.base_url`; `--env <name>` picks
  a named environment from `app.envs`.
- Speed: `--parallel [n]` runs cases concurrently; `--parallel-record <n>`
  caps how many record at once.
- CI: `--json` (machine summary, above), `--junit <path>` (XML report),
  `--ci` (non-interactive, plain output), `--fail-on-changed` (exit 1 on
  unreviewed changed journeys).
- Cheap pass: `--no-grade` skips the grader (deterministic checks only) for a
  fast smoke run; `--mode agent` forces a fresh record instead of replaying.

## Surface you may use

`playtest list [paths] [--tag t] [--json]` (inventory + `next_run`) ·
`playtest view` + `--changed` / `--failed` / `--latest` / `--case <id>` /
`--changed --json` (machine list of pending changed journeys) ·
`playtest new <name>` (scaffold).

Baseline lifecycle — both human-run; you diagnose and print the command:
`accept` adopts one changed/healed journey's new path; `refresh <paths>`
re-records wholesale (needs a model) when a story is legitimately obsolete, not
just changed; `reject` discards a changed candidate. Which one — a single accept
vs a whole-suite refresh — is your call to surface.

For a brand-new user, don't reach for `playtest demo` (it only tours the bundled
todo app) — hand off to playtest-stories to scaffold their real suite
(`playtest new <name>`, `--driver mobile|api` for a non-web surface).
