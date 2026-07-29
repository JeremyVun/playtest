# Codebase map

`codebase-map` answers two maintenance questions without adding a dependency:

- Where is the code? It counts physical code, comment, and blank lines by
  repository area, language, and file.
- How is it connected? It scans static imports, re-exports, dynamic imports,
  and `require()` calls, resolves relative and Playtest workspace imports, and
  emits Mermaid diagrams.

```sh
npm run codebase:stats
npm run codebase:stats -- --include-data
npm run codebase:stats -- --json --output .codebase-map/lines.json
npm run codebase:graph -- --output .codebase-map/workspaces.mmd
npm run codebase:graph -- --level directory --scope packages/core/src
npm run codebase:graph -- --level file --scope packages/run-viewer/src
npm run codebase:report -- --output .codebase-map/report.md
npm run codebase:report:html
```

Workspace diagrams are the readable repository overview. Directory diagrams
collapse files into the first directory below `src` or `tests`. File diagrams
require `--scope` because a whole-repository file graph is too large to be
useful. Add `--include-external` to show third-party and `node:` dependencies.

The inventory includes tracked and untracked non-ignored files so it represents
the current working tree. Pass `--tracked` for a committed-code-only view.
JSON, YAML, XML, and property lists are data/configuration rather than source
LOC and are excluded by default; pass `--include-data` to count them.
Environment files are always excluded. Generated reports belong under the
gitignored `.codebase-map/` directory.

The report renderer follows the output extension. Markdown output contains a
Mermaid workspace graph. HTML output is a self-contained, responsive report
with area and language charts, an inline SVG workspace graph, a searchable
file inventory, and circular-dependency details; it loads no remote assets.
