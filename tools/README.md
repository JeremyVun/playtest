# tools/

Developer tools for working *on* Playtest. Nothing here ships in the npm
tarball or runs in a test gate — these are workbenches.

| tool | what it is for |
|---|---|
| [`codebase-map/`](codebase-map/) | Inventory physical lines of code by area, language, and file; emit scoped Mermaid diagrams of workspace, directory, or file-level module dependencies. |
| [`perf/`](perf/baseline.mjs) | Recording-performance workbench: runs short and long hermetic recordings at suite concurrency 1, 2, and 4 against local fixtures and a loopback gateway, then reports p50/p95 per `perf.jsonl` span, peak RSS, and artifact bytes by type. |
| [`ts-migration/`](ts-migration/) | Guardrails for the TypeScript migration (`docs/backlog/ts_migration/BUILD_PLAN.md`): pre-rename reference finder, slice import-closure check, progress/debt audit, and a mechanical behavior-freeze verifier that token-diffs each conversion against its stripped-types form. |
| [`ux-lab/`](ux-lab/) | Boot a disposable, fully-seeded hosted control plane and drive its web console with a real browser: screenshots of every surface in both themes, plus a machine-readable inventory of every visible control. Built for UX/UI review. |
