# Hosted product UX study

This discovery study evaluates the hosted Playtest control plane with seeded,
realistic projects, runs, review candidates, findings, suites, and an
application with its rings. It is research material and is not part of any
automated test gate.

## Owned fixtures

- `fixtures/todo-app/` is the zero-dependency app used as the study target.
- `fixtures/todos/` is the self-contained suite imported into the hosted
  product.
- Viewer run bundles come from the frozen research corpus in
  `studies/viewer-self-test/`.

The study does not depend on `examples/` or `tests/`.

## Prepare and run

Start the hosted product and study app from the repository root:

```sh
npm run hosted
PORT=4173 node studies/hosted-ux/fixtures/todo-app/server.js
node studies/hosted-ux/seed.mjs
playtest studies/hosted-ux
```

`seed.mjs` talks to the running control plane over the public API and reads its
data root directly (`PLAYTEST_DATA_DIR`, the same default `npm run hosted`
uses) for the two things with no public path: backdating a run group, and the
explored discovery group. It seeds one application, `todo-web`, with a
`staging` ring pointing at the fixture app on port 4173 and a `production` ring
pointing at a URL nothing answers — noticing which of the two you are about to
launch against is one of the things this study measures.

The seed plays a self-hosted runner for the history it fabricates, and every
seeded launch pins the placement label `study-seed` so the peer runner
`npm run hosted` starts never claims one. The rings themselves carry no labels,
so a launch an actor makes from the console still lands on that peer runner and
really executes against the fixture app.

`seed.mjs` is destructive within its throwaway study project: rerunning it
deletes and recreates that project before loading the fixture data. Do not point
the study at a hosted instance containing a project with the same study key
that must be preserved.

`study-report.md` records prior rounds, conditions, evidence, and unresolved
findings. Re-seed before each measurement batch so one actor cannot consume
another actor's pending review state.
