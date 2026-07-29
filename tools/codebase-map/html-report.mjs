import { collapseDependencyGraph, formatNumber } from "./lib.mjs";

const COLORS = ["#36cfc9", "#7c8cff", "#f5b942", "#e879b9", "#70c475", "#f27c63", "#8c6ee8"];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function percent(value, total) {
  return total === 0 ? 0 : (value / total) * 100;
}

function areaRows(stats) {
  const maximum = Math.max(...stats.areas.map((row) => row.total), 1);
  return stats.areas.map((row) => {
    const width = percent(row.total, maximum);
    const code = percent(row.code, row.total);
    const comments = percent(row.comment, row.total);
    const blank = percent(row.blank, row.total);
    const label = `${row.name}: ${formatNumber(row.code)} code, ${formatNumber(row.comment)} comment, ${formatNumber(row.blank)} blank lines`;
    return `<div class="area-row">
      <div class="area-label">
        <span title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
        <strong>${formatNumber(row.code)}</strong>
      </div>
      <div class="bar-track" role="img" aria-label="${escapeHtml(label)}">
        <div class="bar-total" style="width:${width.toFixed(3)}%">
          <span class="bar-code" style="width:${code.toFixed(3)}%"></span>
          <span class="bar-comment" style="width:${comments.toFixed(3)}%"></span>
          <span class="bar-blank" style="width:${blank.toFixed(3)}%"></span>
        </div>
      </div>
    </div>`;
  }).join("\n");
}

function languageChart(stats) {
  let position = 0;
  const stops = [];
  const legend = [];
  stats.languages.forEach((row, index) => {
    const share = percent(row.code, stats.totals.code);
    const color = COLORS[index % COLORS.length];
    stops.push(`${color} ${position.toFixed(3)}% ${(position + share).toFixed(3)}%`);
    position += share;
    legend.push(`<li>
      <span class="swatch" style="--swatch:${color}"></span>
      <span>${escapeHtml(row.name)}</span>
      <strong>${formatNumber(row.code)}</strong>
      <small>${share.toFixed(1)}%</small>
    </li>`);
  });
  return `<div class="language-layout">
    <div class="donut" style="--segments:${stops.join(",")}">
      <div><strong>${stats.languages.length}</strong><span>languages</span></div>
    </div>
    <ul class="language-legend">${legend.join("\n")}</ul>
  </div>`;
}

function graphLayout(graph) {
  const collapsed = collapseDependencyGraph(graph);
  const nodes = collapsed.nodes;
  const outgoing = new Map(nodes.map((node) => [node, []]));
  const incomingCount = new Map(nodes.map((node) => [node, 0]));
  for (const edge of collapsed.edges) {
    outgoing.get(edge.from).push(edge.to);
    incomingCount.set(edge.to, incomingCount.get(edge.to) + 1);
  }

  const ranks = new Map(nodes.map((node) => [node, 0]));
  const queue = nodes.filter((node) => incomingCount.get(node) === 0);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = queue[cursor];
    for (const target of outgoing.get(node)) {
      ranks.set(target, Math.max(ranks.get(target), ranks.get(node) + 1));
      incomingCount.set(target, incomingCount.get(target) - 1);
      if (incomingCount.get(target) === 0) queue.push(target);
    }
  }

  const unresolved = nodes.filter((node) => incomingCount.get(node) > 0);
  for (const node of unresolved) {
    const inboundRanks = collapsed.edges
      .filter((edge) => edge.to === node && !unresolved.includes(edge.from))
      .map((edge) => ranks.get(edge.from) + 1);
    ranks.set(node, inboundRanks.length ? Math.max(...inboundRanks) : 0);
  }

  const columns = new Map();
  for (const node of nodes) {
    const rank = ranks.get(node);
    const column = columns.get(rank) ?? [];
    column.push(node);
    columns.set(rank, column);
  }
  for (const column of columns.values()) column.sort();

  const width = 1160;
  const nodeWidth = 190;
  const nodeHeight = 48;
  const marginX = 34;
  const marginY = 34;
  const columnCount = Math.max(...columns.keys(), 0) + 1;
  const maximumRows = Math.max(...[...columns.values()].map((column) => column.length), 1);
  const height = Math.max(340, maximumRows * 78 + marginY * 2);
  const columnGap = columnCount === 1
    ? 0
    : (width - marginX * 2 - nodeWidth) / (columnCount - 1);
  const positions = new Map();

  for (const [rank, column] of columns) {
    const available = height - marginY * 2 - nodeHeight;
    const rowGap = column.length === 1 ? 0 : available / (column.length - 1);
    const singleOffset = column.length === 1 ? available / 2 : 0;
    column.forEach((node, index) => {
      positions.set(node, {
        x: marginX + rank * columnGap,
        y: marginY + singleOffset + index * rowGap,
      });
    });
  }

  return { ...collapsed, positions, width, height, nodeWidth, nodeHeight };
}

function nodeClass(label) {
  if (label.startsWith("@playtest/")) return "product";
  if (label.startsWith("tests/")) return "test";
  if (label.startsWith("tools/")) return "tool";
  return "study";
}

function dependencySvg(graph) {
  const layout = graphLayout(graph);
  const paths = layout.edges.map((edge, index) => {
    const from = layout.positions.get(edge.from);
    const to = layout.positions.get(edge.to);
    const startX = from.x + layout.nodeWidth;
    const startY = from.y + layout.nodeHeight / 2;
    const endX = to.x;
    const endY = to.y + layout.nodeHeight / 2;
    const bend = Math.max(42, Math.abs(endX - startX) * 0.48);
    const path = endX >= startX
      ? `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`
      : `M ${startX} ${startY} C ${startX + 35} ${startY + 42}, ${endX - 35} ${endY + 42}, ${endX} ${endY}`;
    return `<path class="dependency-edge" d="${path}" marker-end="url(#arrow)" style="--edge-width:${Math.min(4, 1 + Math.log2(edge.count) * 0.45).toFixed(2)}">
      <title>${escapeHtml(edge.from)} imports ${escapeHtml(edge.to)} ${edge.count} time${edge.count === 1 ? "" : "s"}</title>
    </path>`;
  }).join("\n");
  const nodes = layout.nodes.map((label) => {
    const position = layout.positions.get(label);
    return `<g class="dependency-node ${nodeClass(label)}" transform="translate(${position.x} ${position.y})">
      <rect width="${layout.nodeWidth}" height="${layout.nodeHeight}" rx="9"></rect>
      <text x="14" y="29">${escapeHtml(label)}</text>
      <title>${escapeHtml(label)}</title>
    </g>`;
  }).join("\n");
  return `<div class="graph-scroll">
    <svg class="dependency-graph" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-labelledby="graph-title graph-description">
      <title id="graph-title">Workspace import graph</title>
      <desc id="graph-description">Arrows point from importing areas to their dependencies. Thicker lines represent more imports.</desc>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z"></path>
        </marker>
      </defs>
      <g class="dependency-edges">${paths}</g>
      <g class="dependency-nodes">${nodes}</g>
    </svg>
  </div>
  <div class="graph-key">
    <span><i class="product"></i>Product workspace</span>
    <span><i class="test"></i>Test infrastructure</span>
    <span><i class="study"></i>Study or example</span>
    <span><i class="tool"></i>Developer tool</span>
  </div>`;
}

function fileRows(stats) {
  return stats.files.map((file, index) => `<tr data-file-row data-default="${index < 50 ? "show" : "hide"}"${index >= 50 ? " hidden" : ""}>
    <td><code>${escapeHtml(file.path)}</code></td>
    <td>${escapeHtml(file.area)}</td>
    <td>${escapeHtml(file.language)}</td>
    <td class="number">${formatNumber(file.code)}</td>
    <td class="number muted-cell">${formatNumber(file.comment)}</td>
    <td class="number muted-cell">${formatNumber(file.blank)}</td>
  </tr>`).join("\n");
}

function cycleDetails(graph) {
  if (graph.cycles.length === 0) {
    return `<div class="empty-state"><span>✓</span><p>No circular module dependencies found.</p></div>`;
  }
  return graph.cycles.map((cycle, index) => `<details${index === 0 ? " open" : ""}>
    <summary><span>${cycle.length}-module cycle group</span><small>${index === 0 ? "largest" : `group ${index + 1}`}</small></summary>
    <ul>${cycle.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join("")}</ul>
  </details>`).join("\n");
}

export function htmlReport(stats, graph) {
  const topArea = stats.areas[0];
  const topLanguage = stats.languages[0];
  const cycleCount = graph.cycles.length;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Playtest codebase map</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0a0d12;
      --panel: #11161e;
      --panel-raised: #151c26;
      --line: #283240;
      --text: #edf2f7;
      --muted: #98a5b5;
      --faint: #6f7b8a;
      --accent: #36cfc9;
      --accent-soft: rgba(54,207,201,.14);
      --blue: #7c8cff;
      --amber: #f5b942;
      --pink: #e879b9;
      --green: #70c475;
      --code: #36cfc9;
      --comment: #7c8cff;
      --blank: #3a4554;
      --shadow: 0 18px 55px rgba(0,0,0,.25);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at 16% -10%, rgba(54,207,201,.12), transparent 29rem),
        radial-gradient(circle at 88% 0%, rgba(124,140,255,.1), transparent 26rem),
        var(--bg);
      color: var(--text);
      font: 14px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    a { color: inherit; }
    code { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .shell { width: min(1440px, calc(100% - 40px)); margin: 0 auto; padding: 48px 0 72px; }
    header { display: grid; grid-template-columns: 1fr auto; gap: 28px; align-items: end; margin-bottom: 28px; }
    .eyebrow {
      display: flex;
      gap: 10px;
      align-items: center;
      color: var(--accent);
      font-size: 11px;
      font-weight: 750;
      letter-spacing: .16em;
      text-transform: uppercase;
    }
    .eyebrow::before { content: ""; width: 18px; height: 2px; background: currentColor; }
    h1 { margin: 10px 0 8px; font-size: clamp(34px, 5vw, 64px); line-height: 1; letter-spacing: -.045em; }
    .lede { max-width: 680px; margin: 0; color: var(--muted); font-size: 16px; }
    .snapshot { color: var(--faint); font: 12px ui-monospace, monospace; text-align: right; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 12px; }
    .metric, .panel {
      border: 1px solid var(--line);
      background: linear-gradient(145deg, rgba(255,255,255,.018), transparent 44%), var(--panel);
      box-shadow: var(--shadow);
    }
    .metric { min-height: 132px; padding: 22px; border-radius: 12px; }
    .metric span { color: var(--muted); font-size: 12px; }
    .metric strong { display: block; margin: 11px 0 6px; font-size: clamp(25px, 3vw, 38px); line-height: 1; letter-spacing: -.035em; }
    .metric small { color: var(--faint); }
    .dashboard { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(330px, .75fr); gap: 12px; }
    .panel { min-width: 0; border-radius: 12px; overflow: hidden; }
    .panel-wide { grid-column: 1 / -1; }
    .panel-head { display: flex; justify-content: space-between; gap: 20px; align-items: start; padding: 22px 24px 17px; border-bottom: 1px solid var(--line); }
    .panel-head h2 { margin: 0 0 4px; font-size: 17px; letter-spacing: -.015em; }
    .panel-head p { margin: 0; color: var(--muted); font-size: 12px; }
    .legend { display: flex; gap: 14px; color: var(--muted); font-size: 11px; white-space: nowrap; }
    .legend span, .graph-key span { display: inline-flex; align-items: center; gap: 6px; }
    .legend i, .graph-key i { width: 8px; height: 8px; border-radius: 2px; background: var(--key); }
    .legend .code { --key: var(--code); }
    .legend .comment { --key: var(--comment); }
    .legend .blank { --key: var(--blank); }
    .area-chart { padding: 17px 24px 24px; }
    .area-row { display: grid; grid-template-columns: minmax(180px, 38%) 1fr; gap: 16px; align-items: center; min-height: 34px; }
    .area-label { display: flex; gap: 12px; min-width: 0; justify-content: space-between; }
    .area-label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #c8d1dc; font: 11px ui-monospace, monospace; }
    .area-label strong { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
    .bar-track { height: 8px; }
    .bar-total { display: flex; height: 100%; min-width: 2px; overflow: hidden; border-radius: 2px; }
    .bar-total span { display: block; height: 100%; }
    .bar-code { background: var(--code); }
    .bar-comment { background: var(--comment); }
    .bar-blank { background: var(--blank); }
    .language-layout { display: grid; place-items: center; gap: 26px; padding: 30px 24px; }
    .donut {
      width: 168px;
      aspect-ratio: 1;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: conic-gradient(var(--segments));
      position: relative;
      box-shadow: 0 0 48px rgba(54,207,201,.08);
    }
    .donut::after { content: ""; position: absolute; inset: 25px; border-radius: inherit; background: var(--panel); border: 1px solid var(--line); }
    .donut div { position: relative; z-index: 1; text-align: center; }
    .donut strong { display: block; font-size: 30px; line-height: 1; }
    .donut span { color: var(--muted); font-size: 11px; }
    .language-legend { width: 100%; margin: 0; padding: 0; list-style: none; }
    .language-legend li { display: grid; grid-template-columns: 10px 1fr auto 40px; gap: 9px; align-items: center; min-height: 31px; border-bottom: 1px solid rgba(128,145,164,.12); }
    .language-legend li:last-child { border-bottom: 0; }
    .swatch { width: 8px; height: 8px; border-radius: 2px; background: var(--swatch); }
    .language-legend strong { font-size: 11px; font-variant-numeric: tabular-nums; }
    .language-legend small { color: var(--faint); text-align: right; font-variant-numeric: tabular-nums; }
    .graph-scroll { padding: 18px 14px 4px; overflow-x: auto; }
    .dependency-graph { display: block; width: 100%; min-width: 900px; height: auto; }
    .dependency-edge { fill: none; stroke: #566477; stroke-width: var(--edge-width); opacity: .62; }
    #arrow path { fill: #728096; }
    .dependency-node rect { fill: var(--panel-raised); stroke: #354252; stroke-width: 1.2; }
    .dependency-node text { fill: #e8edf3; font: 11px ui-monospace, monospace; }
    .dependency-node.product rect { stroke: rgba(54,207,201,.8); fill: rgba(54,207,201,.09); }
    .dependency-node.test rect { stroke: rgba(245,185,66,.65); fill: rgba(245,185,66,.07); }
    .dependency-node.study rect { stroke: rgba(232,121,185,.6); fill: rgba(232,121,185,.06); }
    .dependency-node.tool rect { stroke: rgba(124,140,255,.75); fill: rgba(124,140,255,.08); }
    .graph-key { display: flex; flex-wrap: wrap; gap: 16px; padding: 6px 24px 20px; color: var(--muted); font-size: 11px; }
    .graph-key .product { --key: var(--accent); }
    .graph-key .test { --key: var(--amber); }
    .graph-key .study { --key: var(--pink); }
    .graph-key .tool { --key: var(--blue); }
    .table-tools { display: flex; gap: 8px; align-items: center; }
    input, button {
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #0d1219;
      color: var(--text);
      font: inherit;
    }
    input { width: min(320px, 36vw); padding: 0 11px; outline: none; }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    button { padding: 0 12px; cursor: pointer; }
    button:hover { border-color: #536276; background: #151c25; }
    .table-scroll { max-height: 610px; overflow: auto; }
    table { width: 100%; border-collapse: collapse; }
    th { position: sticky; top: 0; z-index: 1; background: #161d27; color: var(--muted); font-size: 10px; letter-spacing: .06em; text-align: left; text-transform: uppercase; }
    th, td { padding: 11px 14px; border-bottom: 1px solid rgba(128,145,164,.12); }
    tbody tr:hover { background: rgba(124,140,255,.045); }
    td:first-child { width: 43%; }
    td code { color: #d9e2ec; overflow-wrap: anywhere; }
    .number { text-align: right; font-variant-numeric: tabular-nums; }
    .muted-cell { color: var(--muted); }
    .cycle-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; align-items: start; padding: 18px 20px 22px; }
    details { min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,255,255,.012); }
    summary { display: flex; justify-content: space-between; gap: 12px; padding: 13px 14px; cursor: pointer; font-weight: 650; }
    summary small { color: var(--amber); font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    details ul { margin: 0; padding: 0 14px 14px 31px; color: var(--muted); }
    details li { margin: 7px 0; }
    details code { color: #cbd5e1; overflow-wrap: anywhere; }
    .empty-state { display: flex; gap: 10px; align-items: center; padding: 24px; color: var(--green); }
    footer { display: flex; justify-content: space-between; gap: 20px; margin-top: 18px; color: var(--faint); font-size: 11px; }
    [hidden] { display: none !important; }
    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --bg: #f3f5f7; --panel: #fff; --panel-raised: #f7f9fb; --line: #dce2e9;
        --text: #17212d; --muted: #5f6d7d; --faint: #8290a0; --blank: #ccd3db;
        --shadow: 0 16px 44px rgba(32,47,64,.08);
      }
      body { background: radial-gradient(circle at 10% 0, rgba(54,207,201,.1), transparent 26rem), var(--bg); }
      .area-label span, td code { color: #334155; }
      input, button { background: #fff; }
      button:hover, th { background: #f2f5f8; }
      .dependency-node text { fill: #263445; }
      .dependency-edge { stroke: #91a0b1; }
    }
    @media (max-width: 900px) {
      .shell { width: min(100% - 24px, 1440px); padding-top: 28px; }
      header { grid-template-columns: 1fr; }
      .snapshot { text-align: left; }
      .summary { grid-template-columns: repeat(2, 1fr); }
      .dashboard { grid-template-columns: 1fr; }
      .panel-wide { grid-column: auto; }
      .cycle-grid { grid-template-columns: 1fr; }
      .panel-head { align-items: stretch; flex-direction: column; }
      .table-tools { width: 100%; }
      input { width: 100%; }
    }
    @media (max-width: 560px) {
      .summary { grid-template-columns: 1fr; }
      .area-row { grid-template-columns: 1fr; gap: 4px; margin-bottom: 9px; }
      .legend { display: none; }
      td:nth-child(2), th:nth-child(2), td:nth-child(5), th:nth-child(5), td:nth-child(6), th:nth-child(6) { display: none; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <div class="eyebrow">Playtest / engineering</div>
        <h1>Codebase map</h1>
        <p class="lede">A physical source inventory and a map of how JavaScript and TypeScript modules depend on one another.</p>
      </div>
      <div class="snapshot">working-tree snapshot<br>environment files excluded</div>
    </header>

    <section class="summary" aria-label="Codebase summary">
      <article class="metric"><span>Source lines</span><strong>${formatNumber(stats.totals.code)}</strong><small>${formatNumber(stats.totals.files)} files</small></article>
      <article class="metric"><span>Modules</span><strong>${formatNumber(graph.modules.length)}</strong><small>${formatNumber(graph.edges.length)} imports</small></article>
      <article class="metric"><span>Largest area</span><strong>${formatNumber(topArea?.code ?? 0)}</strong><small>${escapeHtml(topArea?.name ?? "none")}</small></article>
      <article class="metric"><span>Cycle groups</span><strong>${formatNumber(cycleCount)}</strong><small>${cycleCount === 0 ? "no circular imports" : `${graph.cycles.reduce((sum, cycle) => sum + cycle.length, 0)} modules involved`}</small></article>
    </section>

    <div class="dashboard">
      <section class="panel">
        <div class="panel-head">
          <div><h2>Lines by area</h2><p>Physical lines, ordered by source LOC.</p></div>
          <div class="legend"><span><i class="code"></i>Code</span><span><i class="comment"></i>Comments</span><span><i class="blank"></i>Blank</span></div>
        </div>
        <div class="area-chart">${areaRows(stats)}</div>
      </section>

      <section class="panel">
        <div class="panel-head"><div><h2>Language mix</h2><p>${escapeHtml(topLanguage?.name ?? "No source")} is ${percent(topLanguage?.code ?? 0, stats.totals.code).toFixed(1)}% of source LOC.</p></div></div>
        ${languageChart(stats)}
      </section>

      <section class="panel panel-wide">
        <div class="panel-head"><div><h2>Workspace dependencies</h2><p>Arrows point from importers to dependencies; line weight reflects import count.</p></div></div>
        ${dependencySvg(graph)}
      </section>

      <section class="panel panel-wide">
        <div class="panel-head">
          <div><h2>File inventory</h2><p>Showing the 50 largest files until you search or expand.</p></div>
          <div class="table-tools">
            <input id="file-filter" type="search" placeholder="Filter path, area, or language" aria-label="Filter file inventory">
            <button id="show-all" type="button">Show all</button>
          </div>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>File</th><th>Area</th><th>Language</th><th class="number">Code</th><th class="number">Comments</th><th class="number">Blank</th></tr></thead>
            <tbody>${fileRows(stats)}</tbody>
          </table>
        </div>
      </section>

      <section class="panel panel-wide">
        <div class="panel-head"><div><h2>Circular dependencies</h2><p>Strongly connected module groups; every module in a group can reach every other.</p></div></div>
        <div class="cycle-grid">${cycleDetails(graph)}</div>
      </section>
    </div>

    <footer>
      <span>Source LOC excludes JSON, YAML, XML, and property lists unless <code>--include-data</code> is used.</span>
      <span>${formatNumber(graph.unresolved.length)} unresolved relative imports</span>
    </footer>
  </main>
  <script>
    const filter = document.querySelector("#file-filter");
    const button = document.querySelector("#show-all");
    const rows = [...document.querySelectorAll("[data-file-row]")];
    let expanded = false;
    function updateRows() {
      const query = filter.value.trim().toLowerCase();
      for (const row of rows) {
        row.hidden = query ? !row.textContent.toLowerCase().includes(query) : !expanded && row.dataset.default === "hide";
      }
      button.textContent = expanded ? "Show top 50" : "Show all";
      button.hidden = Boolean(query);
    }
    filter.addEventListener("input", updateRows);
    button.addEventListener("click", () => { expanded = !expanded; updateRows(); });
  </script>
</body>
</html>
`;
}
