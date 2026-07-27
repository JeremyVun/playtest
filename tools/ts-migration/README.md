# ts-migration

Guardrails for agents executing `docs/backlog/ts_migration/BUILD_PLAN.md`.
Read that plan first; these tools enforce its rules, they don't replace it.

A fourth guardrail lives in the test gate itself:
`tests/repository/specifier-resolution.test.ts` verifies every relative
module reference in first-party code resolves to a real file (it understands
the emit-dir `.js` -> `.ts` source mapping and the viewer's `/shared/` URL
mapping). It runs in every `npm test`, so a missed specifier rewrite in a
not-yet-converted `.js` importer — invisible to `tsc` — still fails the gate.

## status.mjs

```sh
node tools/ts-migration/status.mjs                      # progress per area + debt tally
node tools/ts-migration/status.mjs importers src/core/config.ts  # every reference, by any mechanism
node tools/ts-migration/status.mjs closure src/core/clip.js src/core/config.ts ...
```

`importers` is the mandatory step before renaming a module: it greps by bare
filename so it catches dynamic imports, `new URL()` references, spawn paths
in tests, package.json `bin`/`exports` values, and docs. It over-reports on
purpose (same basename in another package also matches) — inspect each hit.
Hits inside fixtures are listed separately: those usually model user-authored
code and must not be rewritten. `studies/` is never scanned; parts of it are
frozen.

`closure` checks strategy rule 6 before a slice starts: exit 1 with the list
of unconverted `.js` dependencies that must join the slice.

The no-argument form reports `@ts-expect-error` and indicative `any` counts,
and hard-fails on `@ts-ignore`/`@ts-nocheck`.

## verify-freeze.mjs

```sh
node tools/ts-migration/verify-freeze.mjs                 # HEAD vs working tree
node tools/ts-migration/verify-freeze.mjs --base <ref>    # e.g. the pre-slice commit
node tools/ts-migration/verify-freeze.mjs --base <a> --head <b>
```

Enforces the behavior freeze (strategy rule 7) mechanically. For each
`.js`/`.mjs` -> `.ts`/`.mts` rename in the range it strips the types from the new file with
`node:module`'s `stripTypeScriptTypes` — the same engine Node uses at
runtime — tokenizes old and new, and compares. Comments, whitespace, type
annotations, and literal file-reference `.js` -> `.ts` rewrites are the only
permitted differences; the latter covers imports and load-bearing paths such as
container entrypoints. Anything else fails with the exact token and line on
both sides. Non-erasable syntax (enums, namespaces, parameter properties)
fails outright. A deleted `.js` with no `.ts` replacement fails; renames git
couldn't detect are re-paired by filename stem and checked anyway.

Renames must be staged (`git mv` does this) to be visible against the
working tree. Agents run it before every commit; the orchestrator runs it
over the whole phase range during review instead of eyeballing hunks.
