---
name: playtest
description: Close the fix loop on Playtest journey regressions — run the suite, triage each failure with the four-verdict table (app bug / app changed / agent flake / environment flake), fix app bugs, and surface heal diffs for human review. Use after changing UI code, when asked "did I break any journeys?", or when a journey goes red in CI.
---

# Playtest fix loop

Playtest journeys are recorded user paths replayed against the app. When one
goes red, the failure is evidence on disk — a manifest, a trajectory, a
screenshot and an accessibility snapshot per step. Your job is to read that
evidence, call one of four verdicts, and act on it. The expensive part is
knowing the loop; the loop is below.

## Hard rules (read first)

- **Never run `playtest accept` or `playtest reject` autonomously.**
  Acceptance rewrites a versioned baseline and stays a human action. You
  print the command; the human runs it.
- **The YAML is spec, not config.** Never edit a case's `story:` or
  `success:` assertions to make a failure pass. You fix application code;
  weakening the spec is the human's call, and only ever proposed.
- **Exit 2 is infra/config, not a test failure.** Report what broke
  (unreachable `base_url`, bad YAML, missing browser); do not touch app code
  in response to it.

## The loop

1. **Run** the affected suite (or the whole tree) machine-readably:

   ```
   playtest <paths> --json
   ```

   Exit codes: `0` pass, `1` gate failure (a journey is red, or
   `--fail-on-changed` found unreviewed changed journeys), `2` infra/config.
   stdout is one JSON object:
   `{ run_id, runs_root, exit_code, cases: [{ id, status, mode, healed,
   changed, run_dir, duration_ms, steps, cost_usd, score, duration_delta_ms,
   score_delta, status_streak, gate_failures: [{ spec, detail }] }] }`.

2. **Per red or changed case, read the evidence** in `run_dir`:

   - `manifest.json` — `result.status`, `result.end_reason`,
     `result.gate.checks[]` (each `{ kind, spec, pass, detail }`; the failing
     ones are your assertion-level facts), `healed`, `totals`.
   - `trajectory.jsonl` — the tail. The failure lives in the last few
     envelopes: `result.ok: false`, a `confusion` block, or a terminal
     `give_up` action with its reason. Agent envelopes carry
     `agent.thought` — read what it believed it was doing.
   - The failing step's artifacts: `steps/NNN.png` (screenshot) and
     `steps/NNN.a11y.txt` (what the agent actually saw), `NNN` = the
     envelope's `step` zero-padded to 3.
   - On healed runs: `baseline.jsonl` sits next to `trajectory.jsonl`; the
     divergence between their action tracks is the heal diff
     (`playtest view` renders it as the Diff tab).

3. **Classify** with the four-verdict table (docs/playtest-design.md):

   | Verdict | Looks like | Response |
   |---|---|---|
   | App bug | Task genuinely impossible / assertion fails / errors thrown | File it. This is the product working. |
   | App changed | A heal succeeded, or the agent succeeded a new way | Review the heal diff, accept the changed journey. |
   | Agent flake | Agent confused on an unchanged, working page | Re-run; if persistent, tune the case story. |
   | Environment flake | Container/seed/network/health-probe failure | Distinct exit code; never counted as a test failure. |

4. **Act on the verdict:**

   - **App bug** — fix the application code, then rerun exactly that case:
     `playtest <path/to/case>.yaml --json`. Loop until green.
   - **App changed** (`healed: true`, `changed: true`) — summarize the heal
     diff in one or two sentences (which step diverged, what the agent did
     instead), then print the review commands for the human and stop:

     ```
     playtest view --changed
     playtest accept <run_dir>
     ```

     Do not run the accept yourself (hard rule above).
   - **Agent flake** — rerun the case once (`playtest <path/to/case>.yaml
     --json`). If it passes, say so and move on. If it fails the same
     confused way on an unchanged page, propose a clearer `story:` wording
     to the human — proposed, not applied; the spec stays theirs. The
     **playtest-stories** skill owns story craft (goals not click-paths,
     second person, 2-4 lines).
   - **Environment flake / exit 2** — report the infra error verbatim
     (`result.error`, or the `playtest:` stderr line) and which rail broke,
     then stop (hard rule above).

5. **Report** when the loop ends: per case, the verdict, what you did, and
   any commands you left for the human (accepts, story proposals).

## Surface you may use

`playtest <paths> --json` · `playtest <case>.yaml --json` ·
`playtest list [paths]` · `playtest view` / `playtest view --changed` ·
`playtest new <name>` (scaffold; its `playtest.yaml` holds the `app:` block
with `base_url`) · `--fail-on-changed` (CI gating knob). Anything else
(accept/reject/refresh) is the human's.

**Onboarding a new user is not `playtest demo`.** `playtest demo` is a tour of
the bundled todo app for exploration only — never the first step for someone
adopting Playtest for real. To set a real user up, scaffold *their* suite against
*their* app: `playtest new <name>` (add `--driver mobile` or `--driver api` for a
non-web surface). The demo never touches their app.
