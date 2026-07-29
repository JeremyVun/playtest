#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  dependencyGraph,
  formatNumber,
  inventory,
  markdownReport,
  renderMermaid,
} from "./lib.mjs";
import { htmlReport } from "./html-report.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

function usage() {
  return `Usage:
  npm run codebase:stats [-- --json] [-- --include-data] [-- --tracked]
  npm run codebase:graph [-- --level workspace|directory|file] [-- --scope PATH]
                         [-- --include-external] [-- --output FILE]
  npm run codebase:report [-- --output FILE.md|FILE.html]

Commands:
  stats   Count physical source, comment, and blank lines by area, language, and file.
  graph   Emit a Mermaid import diagram. Workspace level is the default.
  report  Combine the inventory and workspace graph in Markdown or self-contained HTML.

File-level graphs require --scope. Add --include-data to stats or report to
include JSON, YAML, XML, and property lists. All commands include untracked,
non-ignored files unless --tracked is passed. Environment files are always excluded.
`;
}

function parseArguments(argv) {
  const args = [...argv];
  const command = args.shift() ?? "stats";
  const options = {
    command,
    includeExternal: false,
    includeData: false,
    json: false,
    level: "workspace",
    output: undefined,
    scope: undefined,
    trackedOnly: false,
  };
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--tracked") options.trackedOnly = true;
    else if (argument === "--include-data") options.includeData = true;
    else if (argument === "--include-external") options.includeExternal = true;
    else if (["--level", "--scope", "--output"].includes(argument)) {
      const value = args.shift();
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function table(rows, columns) {
  const widths = columns.map((column) =>
    Math.max(column.title.length, ...rows.map((row) => String(column.value(row)).length)),
  );
  const render = (values) => values.map((value, index) => {
    const column = columns[index];
    return column.align === "right"
      ? String(value).padStart(widths[index])
      : String(value).padEnd(widths[index]);
  }).join("  ");
  return [
    render(columns.map((column) => column.title)),
    render(widths.map((width) => "─".repeat(width))),
    ...rows.map((row) => render(columns.map((column) => column.value(row)))),
  ].join("\n");
}

function countsTable(rows, firstColumn = "Area") {
  return table(rows, [
    { title: firstColumn, value: (row) => row.name },
    { title: "Files", align: "right", value: (row) => formatNumber(row.files) },
    { title: "Code", align: "right", value: (row) => formatNumber(row.code) },
    { title: "Comments", align: "right", value: (row) => formatNumber(row.comment) },
    { title: "Blank", align: "right", value: (row) => formatNumber(row.blank) },
  ]);
}

function statsText(stats) {
  const largest = stats.files.slice(0, 15).map((file) => ({
    name: file.path,
    language: file.language,
    code: file.code,
  }));
  return `Codebase: ${formatNumber(stats.totals.code)} code lines in ${formatNumber(stats.totals.files)} files

By area
${countsTable(stats.areas)}

By language
${countsTable(stats.languages, "Language")}

Largest files
${table(largest, [
    { title: "File", value: (row) => row.name },
    { title: "Language", value: (row) => row.language },
    { title: "Code", align: "right", value: (row) => formatNumber(row.code) },
  ])}
`;
}

function writeResult(content, output) {
  if (!output) {
    process.stdout.write(content);
    return;
  }
  const destination = path.resolve(ROOT, output);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
  process.stdout.write(`${path.relative(ROOT, destination)}\n`);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!["stats", "graph", "report"].includes(options.command)) {
    throw new Error(`Unknown command "${options.command}"\n\n${usage()}`);
  }
  if (options.command === "stats") {
    const stats = inventory(ROOT, options);
    const content = options.json ? `${JSON.stringify(stats, null, 2)}\n` : statsText(stats);
    writeResult(content, options.output);
    return;
  }
  const graph = dependencyGraph(ROOT, options);
  if (options.command === "graph") {
    writeResult(renderMermaid(graph, options), options.output);
    return;
  }
  const stats = inventory(ROOT, options);
  const content = options.output && [".html", ".htm"].includes(path.extname(options.output).toLowerCase())
    ? htmlReport(stats, graph)
    : markdownReport(stats, graph);
  writeResult(content, options.output);
}

try {
  main();
} catch (error) {
  process.stderr.write(`codebase-map: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
