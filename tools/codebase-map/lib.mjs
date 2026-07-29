import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const LANGUAGES = new Map([
  [".cjs", ["JavaScript", "slash", "source"]],
  [".css", ["CSS", "slash", "source"]],
  [".html", ["HTML", "markup", "source"]],
  [".js", ["JavaScript", "slash", "source"]],
  [".jsx", ["JavaScript JSX", "slash", "source"]],
  [".json", ["JSON", "plain", "data"]],
  [".mjs", ["JavaScript", "slash", "source"]],
  [".plist", ["Property List", "markup", "data"]],
  [".sh", ["Shell", "hash", "source"]],
  [".sql", ["SQL", "sql", "source"]],
  [".swift", ["Swift", "slash", "source"]],
  [".ts", ["TypeScript", "slash", "source"]],
  [".tsx", ["TypeScript JSX", "slash", "source"]],
  [".xml", ["XML", "markup", "data"]],
  [".yaml", ["YAML", "hash", "data"]],
  [".yml", ["YAML", "hash", "data"]],
]);

function normalize(file) {
  return file.split(path.sep).join("/");
}

function isEnvFile(file) {
  return normalize(file).split("/").some((part) => part === ".env" || part.startsWith(".env."));
}

export function repositoryFiles(root, { trackedOnly = false } = {}) {
  const args = trackedOnly
    ? ["ls-files", "-z", "--cached"]
    : ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Could not list repository files with git");
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map(normalize)
    .filter((file) => !isEnvFile(file))
    .sort();
}

function fileKind(file) {
  return LANGUAGES.get(path.extname(file).toLowerCase());
}

function classifySlashLine(line, state, lineMarker = "//") {
  let hasCode = false;
  let hasComment = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const current = line[index];
    const next = line[index + 1];

    if (state.blockComment) {
      hasComment = true;
      if (current === "*" && next === "/") {
        state.blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      hasCode = true;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === quote) {
        quote = "";
      }
      continue;
    }
    if ((current === "'" || current === '"' || current === "`")) {
      quote = current;
      hasCode = true;
      continue;
    }
    if (current === "/" && next === "*") {
      state.blockComment = true;
      hasComment = true;
      index += 1;
      continue;
    }
    if (lineMarker === "//" && current === "/" && next === "/") {
      hasComment = true;
      break;
    }
    if (lineMarker === "--" && current === "-" && next === "-") {
      hasComment = true;
      break;
    }
    if (!/\s/.test(current)) hasCode = true;
  }

  return hasCode ? "code" : hasComment ? "comment" : "blank";
}

function classifyMarkupLine(line, state) {
  let remaining = line;
  let hasCode = false;
  let hasComment = false;
  while (remaining.length > 0) {
    if (state.blockComment) {
      hasComment = true;
      const end = remaining.indexOf("-->");
      if (end === -1) break;
      state.blockComment = false;
      remaining = remaining.slice(end + 3);
      continue;
    }
    const start = remaining.indexOf("<!--");
    if (start === -1) {
      if (remaining.trim()) hasCode = true;
      break;
    }
    if (remaining.slice(0, start).trim()) hasCode = true;
    hasComment = true;
    state.blockComment = true;
    remaining = remaining.slice(start + 4);
  }
  return hasCode ? "code" : hasComment ? "comment" : "blank";
}

export function countLines(text, style) {
  const counts = { code: 0, comment: 0, blank: 0, total: 0 };
  const state = { blockComment: false };
  const lines = text === "" ? [] : text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();

  for (const line of lines) {
    let kind;
    if (style === "slash") kind = classifySlashLine(line, state);
    else if (style === "sql") kind = classifySlashLine(line, state, "--");
    else if (style === "markup") kind = classifyMarkupLine(line, state);
    else if (style === "hash") {
      const trimmed = line.trim();
      kind = !trimmed ? "blank" : trimmed.startsWith("#") && !trimmed.startsWith("#!") ? "comment" : "code";
    } else {
      kind = line.trim() ? "code" : "blank";
    }
    counts[kind] += 1;
    counts.total += 1;
  }
  return counts;
}

export function areaForFile(file) {
  const parts = normalize(file).split("/");
  if (parts[0] === "packages" && parts[1]) {
    const rootLength = parts[1] === "platform" && parts[2] ? 3 : 2;
    const packageRoot = parts.slice(0, rootLength);
    if (parts.includes("vendor")) return [...packageRoot, "vendor"].join("/");
    const section = parts[rootLength];
    return ["src", "tests"].includes(section)
      ? [...packageRoot, section].join("/")
      : packageRoot.join("/");
  }
  if (parts[0] === "examples" && parts[1]) {
    const root = parts.slice(0, 2);
    const section = parts[2];
    return ["src", "test", "bench"].includes(section) ? [...root, section].join("/") : root.join("/");
  }
  if (["studies", "tools"].includes(parts[0]) && parts[1]) {
    return parts.slice(0, 2).join("/");
  }
  if (parts[0] === "tests" && parts[1]) return parts.slice(0, 2).join("/");
  return parts.length === 1 ? "(root)" : parts[0];
}

function addCounts(target, source) {
  for (const key of ["files", "code", "comment", "blank", "total"]) {
    target[key] = (target[key] ?? 0) + (source[key] ?? 0);
  }
}

function sortedTotals(map, key) {
  return [...map.entries()]
    .map(([name, counts]) => ({ name, ...counts }))
    .sort((left, right) => right[key] - left[key] || left.name.localeCompare(right.name));
}

export function inventory(root, options = {}) {
  const files = [];
  for (const file of repositoryFiles(root, options)) {
    const kind = fileKind(file);
    if (!kind) continue;
    if (kind[2] === "data" && !options.includeData) continue;
    const absolute = path.join(root, file);
    let text;
    try {
      text = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    const [language, style] = kind;
    files.push({
      path: file,
      area: areaForFile(file),
      language,
      ...countLines(text, style),
    });
  }

  const totals = { files: 0, code: 0, comment: 0, blank: 0, total: 0 };
  const byArea = new Map();
  const byLanguage = new Map();
  for (const file of files) {
    addCounts(totals, { ...file, files: 1 });
    const area = byArea.get(file.area) ?? {};
    addCounts(area, { ...file, files: 1 });
    byArea.set(file.area, area);
    const language = byLanguage.get(file.language) ?? {};
    addCounts(language, { ...file, files: 1 });
    byLanguage.set(file.language, language);
  }

  return {
    totals,
    areas: sortedTotals(byArea, "code"),
    languages: sortedTotals(byLanguage, "code"),
    files: files.sort((left, right) => right.code - left.code || left.path.localeCompare(right.path)),
  };
}

function moduleTokens(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const current = text[index];
    const next = text[index + 1];
    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      index = text.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (current === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (current === "'" || current === '"') {
      const quote = current;
      let value = "";
      index += 1;
      while (index < text.length) {
        const character = text[index];
        if (character === "\\") {
          if (index + 1 < text.length) value += text[index + 1];
          index += 2;
        } else if (character === quote) {
          index += 1;
          break;
        } else {
          value += character;
          index += 1;
        }
      }
      tokens.push({ type: "string", value });
      continue;
    }
    if (current === "`") {
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") index += 2;
        else if (text[index] === "`") {
          index += 1;
          break;
        } else index += 1;
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(current)) {
      let end = index + 1;
      while (end < text.length && /[\w$]/.test(text[end])) end += 1;
      tokens.push({ type: "word", value: text.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ type: "punctuation", value: current });
    index += 1;
  }
  return tokens;
}

export function importedSpecifiers(text) {
  const tokens = moduleTokens(text);
  const specifiers = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "word") continue;
    if (
      (token.value === "import" || token.value === "require")
      && tokens[index + 1]?.value === "("
      && tokens[index + 2]?.type === "string"
    ) {
      specifiers.add(tokens[index + 2].value);
      continue;
    }
    if (token.value === "import" && tokens[index + 1]?.type === "string") {
      specifiers.add(tokens[index + 1].value);
      continue;
    }
    if (token.value !== "import" && token.value !== "export") continue;
    for (let cursor = index + 1; cursor < Math.min(tokens.length, index + 100); cursor += 1) {
      if (tokens[cursor].value === ";") break;
      if (tokens[cursor].value === "from" && tokens[cursor + 1]?.type === "string") {
        specifiers.add(tokens[cursor + 1].value);
        break;
      }
    }
  }
  return [...specifiers];
}

function packageName(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function exportedPath(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  for (const condition of ["import", "node", "browser", "default", "types"]) {
    const found = exportedPath(value[condition]);
    if (found) return found;
  }
  return undefined;
}

function workspacePackages(root, files) {
  const packages = new Map();
  for (const file of files.filter((candidate) => candidate.endsWith("/package.json"))) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    } catch {
      continue;
    }
    if (typeof manifest.name !== "string" || !file.startsWith("packages/")) continue;
    const packageRoot = path.posix.dirname(file);
    const exports = new Map();
    if (typeof manifest.exports === "string") {
      exports.set(".", normalize(path.posix.join(packageRoot, manifest.exports)));
    } else {
      for (const [key, value] of Object.entries(manifest.exports ?? {})) {
        const target = exportedPath(value);
        if (target) exports.set(key, normalize(path.posix.join(packageRoot, target)));
      }
    }
    packages.set(manifest.name, { root: packageRoot, exports });
  }
  return packages;
}

function resolveCandidate(candidate, moduleSet) {
  const normalized = path.posix.normalize(candidate);
  const attempts = [normalized];
  const extension = path.posix.extname(normalized);
  if (extension === ".js") attempts.push(`${normalized.slice(0, -3)}.ts`, `${normalized.slice(0, -3)}.tsx`);
  if (extension === ".jsx") attempts.push(`${normalized.slice(0, -4)}.tsx`);
  if (!extension) {
    for (const candidateExtension of MODULE_EXTENSIONS) attempts.push(`${normalized}${candidateExtension}`);
    for (const candidateExtension of MODULE_EXTENSIONS) attempts.push(`${normalized}/index${candidateExtension}`);
  }
  return attempts.find((attempt) => moduleSet.has(attempt));
}

function resolveSpecifier(source, specifier, moduleSet, repositorySet, workspaces) {
  const clean = specifier.split(/[?#]/, 1)[0];
  if (clean.startsWith("/")) return "external:file";
  if (clean.startsWith(".")) {
    const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(source), clean));
    const module = resolveCandidate(candidate, moduleSet);
    if (module) return module;
    if (repositorySet.has(candidate)) return `resource:${candidate}`;
    return undefined;
  }
  if (clean.startsWith("node:")) return `external:${clean}`;
  const name = packageName(clean);
  const workspace = workspaces.get(name);
  if (!workspace) return `external:${name}`;
  const subpath = clean === name ? "." : `.${clean.slice(name.length)}`;
  const target = workspace.exports.get(subpath);
  if (!target) return `workspace:${name}${subpath.slice(1)}`;
  const module = resolveCandidate(target, moduleSet);
  if (module) return module;
  return repositorySet.has(target) ? `resource:${target}` : `workspace:${name}${subpath.slice(1)}`;
}

function stronglyConnectedComponents(nodes, edges) {
  const outgoing = new Map(nodes.map((node) => [node, []]));
  for (const edge of edges) {
    if (outgoing.has(edge.from) && outgoing.has(edge.to)) outgoing.get(edge.from).push(edge.to);
  }
  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function connect(node) {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of outgoing.get(node)) {
      if (!indices.has(target)) {
        connect(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    const selfCycle = component.length === 1
      && outgoing.get(component[0]).includes(component[0]);
    if (component.length > 1 || selfCycle) components.push(component.sort());
  }

  for (const node of nodes) if (!indices.has(node)) connect(node);
  return components.sort((left, right) => right.length - left.length || left[0].localeCompare(right[0]));
}

export function dependencyGraph(root, options = {}) {
  const repository = repositoryFiles(root, options);
  const repositorySet = new Set(repository);
  const modules = repository.filter((file) => MODULE_EXTENSIONS.includes(path.extname(file).toLowerCase()));
  const moduleSet = new Set(modules);
  const workspaces = workspacePackages(root, repository);
  const edges = [];
  const resources = [];
  const unresolved = [];
  for (const source of modules) {
    const text = fs.readFileSync(path.join(root, source), "utf8");
    for (const specifier of importedSpecifiers(text, source)) {
      const target = resolveSpecifier(source, specifier, moduleSet, repositorySet, workspaces);
      if (target?.startsWith("resource:")) {
        resources.push({ from: source, to: target.slice("resource:".length), specifier });
      } else if (target) edges.push({ from: source, to: target, specifier });
      else unresolved.push({ from: source, specifier });
    }
  }
  return {
    modules,
    edges,
    resources,
    unresolved,
    cycles: stronglyConnectedComponents(
      modules,
      edges.filter((edge) => moduleSet.has(edge.to)),
    ),
    workspaces: Object.fromEntries(
      [...workspaces.entries()].map(([name, workspace]) => [name, workspace.root]),
    ),
  };
}

function workspaceGroup(file, graph) {
  if (file.startsWith("external:")) return file;
  if (file.startsWith("workspace:")) {
    const target = file.slice("workspace:".length);
    return Object.keys(graph.workspaces).find(
      (name) => target === name || target.startsWith(`${name}/`),
    ) ?? target;
  }
  for (const [name, root] of Object.entries(graph.workspaces)) {
    if (file === root || file.startsWith(`${root}/`)) return name;
  }
  return areaForFile(file);
}

function directoryGroup(file, graph) {
  if (file.startsWith("external:") || file.startsWith("workspace:")) return workspaceGroup(file, graph);
  const parts = file.split("/");
  const workspace = workspaceGroup(file, graph);
  const sourceIndex = parts.indexOf("src");
  const testsIndex = parts.indexOf("tests");
  if (sourceIndex !== -1) {
    const child = parts[sourceIndex + 1];
    const suffix = child && child.includes(".") ? "src" : `src/${child}`;
    return `${workspace}/${suffix}`;
  }
  if (testsIndex !== -1) {
    if (testsIndex === 0) return parts.slice(0, 2).join("/");
    const child = parts[testsIndex + 1];
    const suffix = child && child.includes(".") ? "tests" : `tests/${child}`;
    return `${workspace}/${suffix}`;
  }
  return path.posix.dirname(file);
}

function inScope(file, scope) {
  if (!scope) return true;
  const normalized = normalize(scope).replace(/^\.\//, "").replace(/\/$/, "");
  return file === normalized || file.startsWith(`${normalized}/`);
}

export function collapseDependencyGraph(graph, {
  level = "workspace",
  scope,
  includeExternal = false,
} = {}) {
  if (!["workspace", "directory", "file"].includes(level)) {
    throw new Error(`Unknown graph level "${level}"; use workspace, directory, or file`);
  }
  if (level === "file" && !scope) {
    throw new Error("File-level graphs require --scope to avoid an unreadable repository-wide diagram");
  }
  const group = level === "workspace"
    ? (file) => workspaceGroup(file, graph)
    : level === "directory"
      ? (file) => directoryGroup(file, graph)
      : (file) => file;
  const collapsed = new Map();
  for (const edge of graph.edges) {
    if (!inScope(edge.from, scope)) continue;
    const external = edge.to.startsWith("external:");
    if (external && !includeExternal) continue;
    const from = group(edge.from);
    const to = group(edge.to);
    if (from === to) continue;
    const key = `${from}\0${to}`;
    collapsed.set(key, { from, to, count: (collapsed.get(key)?.count ?? 0) + 1 });
  }
  const edges = [...collapsed.values()].sort(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
  const labels = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))].sort();
  return { nodes: labels, edges };
}

export function renderMermaid(graph, options = {}) {
  const { nodes: labels, edges } = collapseDependencyGraph(graph, options);
  const ids = new Map(labels.map((label, index) => [label, `m${index}`]));
  const lines = ["flowchart LR"];
  for (const label of labels) {
    const safe = label.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    lines.push(`  ${ids.get(label)}["${safe}"]`);
  }
  for (const edge of edges) {
    const count = edge.count > 1 ? `|${edge.count} imports|` : "";
    lines.push(`  ${ids.get(edge.from)} -->${count} ${ids.get(edge.to)}`);
  }
  if (edges.length === 0) lines.push("  empty[\"No matching module connections\"]");
  return `${lines.join("\n")}\n`;
}

export function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function markdownReport(stats, graph) {
  const table = (rows) => rows.join("\n");
  const areaRows = stats.areas.map((row) =>
    `| ${row.name} | ${formatNumber(row.files)} | ${formatNumber(row.code)} | ${formatNumber(row.comment)} | ${formatNumber(row.blank)} |`,
  );
  const languageRows = stats.languages.map((row) =>
    `| ${row.name} | ${formatNumber(row.files)} | ${formatNumber(row.code)} | ${formatNumber(row.comment)} | ${formatNumber(row.blank)} |`,
  );
  const fileRows = stats.files.slice(0, 25).map((row) =>
    `| \`${row.path}\` | ${row.language} | ${formatNumber(row.code)} |`,
  );
  const cycleLines = graph.cycles.length === 0
    ? ["No circular module dependencies found."]
    : graph.cycles.slice(0, 20).map(
      (cycle) => `- ${formatNumber(cycle.length)}-module group: ${cycle.map((file) => `\`${file}\``).join(", ")}`,
    );

  return `# Codebase map

${formatNumber(stats.totals.code)} code lines across ${formatNumber(stats.totals.files)} files. ${formatNumber(graph.modules.length)} JavaScript/TypeScript modules have ${formatNumber(graph.edges.length)} import connections.

## Lines by area

| Area | Files | Code | Comments | Blank |
|---|---:|---:|---:|---:|
${table(areaRows)}

## Lines by language

| Language | Files | Code | Comments | Blank |
|---|---:|---:|---:|---:|
${table(languageRows)}

## Largest files

| File | Language | Code |
|---|---|---:|
${table(fileRows)}

## Workspace dependencies

\`\`\`mermaid
${renderMermaid(graph).trimEnd()}
\`\`\`

## Circular dependencies

${cycleLines.join("\n")}

Unresolved relative imports: ${formatNumber(graph.unresolved.length)}.
`;
}
