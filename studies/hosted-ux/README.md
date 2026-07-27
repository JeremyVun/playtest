# Hosted product UX study

This discovery study evaluates the hosted Playtest control plane with seeded,
realistic projects, runs, review candidates, findings, suites, and
environments. It is research material and is not part of any automated test
gate.

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

`seed.mjs` is destructive within its throwaway study project: rerunning it
deletes and recreates that project before loading the fixture data. Do not point
the study at a hosted instance containing a project with the same study key
that must be preserved.

`study-report.md` records prior rounds, conditions, evidence, and unresolved
findings. Re-seed before each measurement batch so one actor cannot consume
another actor's pending review state.
