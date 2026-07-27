# Viewer UX discovery study

This study measures how different personas investigate failures, review healed
paths, and assess stability in the trajectory viewer. It is a discovery study,
not an automated regression test.

The suite uses the frozen viewer environment owned by
`studies/viewer-self-test/`; it never reads live run output. Personas and
stories are local to this directory, and `study-report.md` records the completed
July 2026 study and its evidence.

## Run

Docker and a configured model gateway are required:

```sh
playtest studies/viewer-ux
```

New runs are research data. Do not treat their grades as a release gate without
reviewing the trajectories and recording the study conditions.
