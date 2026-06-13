# Frozen viewer fixtures

Curated copies of real runs, frozen so the self-test suite (`tests/viewer`)
sees deterministic data and never observes its own output. Do not let live
runs leak in here.

Contents:

- **`runs/`** — two case families:
  - `add-todo` (3 runs): `f482` (record), `1b72` (heal, **pending review**),
    `d926` (record, newest). Exercises the diff tab, the changed-review flow
    and the sibling navigator.
  - `todos/add-todo` (6 runs): 5 real passes plus `2026-06-11T0426-0bad`, a
    **synthetic failure** (hand-edited manifest: the POST succeeded but the
    final page lost the todo, so the `element_exists` and `assert` criteria
    fail). Its step screenshots still show the pass they were copied from —
    only the gate verdict was changed. Exercises failure triage and gives the
    history view a red dot.
- **`pending/`** — the heal candidate (`add-todo.healed.jsonl/.json`) that
  keeps run `1b72` permanently "awaiting review". Paths in the meta and in
  `1b72`'s manifest are repo-root-relative: pending detection works when the
  view server runs with the repo root as cwd (the compose file guarantees
  this; from a shell, run `playtest view` from the repo root). There is
  deliberately no `add-todo.yaml` here — `*.healed.*` files are invisible to
  case discovery, and the anchor YAML itself never needs to exist.
