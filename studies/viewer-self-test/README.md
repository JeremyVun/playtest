# Viewer self-test study

This manual regression study asks Playtest actors to use Playtest's own
trajectory viewer. It is research material, not a product test and not part of
`npm test`.

The study exists to evaluate whether people can:

- diagnose a failed journey;
- compare a healed path with its baseline;
- navigate between related runs;
- understand history and stability signals;
- find the pending-review workflow.

## Layout

- `stories/` contains the seven journey prompts.
- `results/` contains their accepted paths.
- `fixtures/runs/` contains curated, frozen trajectories served by the viewer.
- `fixtures/pending/` keeps one healed trajectory awaiting review.
- `docker-compose.yml` serves the frozen data without exposing live `runs/`.

The frozen artifacts include intentional inconsistencies documented in
`fixtures/README.md`. Do not refresh them from live runs without reviewing
those cases.

## Run

Docker and a configured model gateway are required:

```sh
playtest studies/viewer-self-test
```

The related discovery instrument and its completed report live in
`studies/viewer-ux/`.
