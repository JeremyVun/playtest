import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  isDirectRun,
  parseArgs,
  readJson,
  requireArgs,
  runCli,
  writeText
} from './lib/io.mjs';
import { padRound } from './lib/contracts.mjs';
import { buildMatrix, loadLedgerEntries } from './matrix.mjs';

const USAGE = `Usage: node studies/hillclimb/bench/site.mjs --ledger-dir <dir> --faults <faults.json> --runs-root <dir> --out <report-dir>

Builds a self-contained static report site from ledger, matrix, faults, and cited run screenshots.`;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function sanitize(value) {
  return String(value).replace(/[^A-Za-z0-9_.@-]+/g, '_');
}

function stepName(step) {
  return `${String(step).padStart(3, '0')}.png`;
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --bg: #fafafa; --fg: #1b1f24; --muted: #5d6673; --line: #cfd6df; --panel: #ffffff; --accent: #0f766e; }
@media (prefers-color-scheme: dark) { :root { --bg: #101214; --fg: #f1f4f7; --muted: #aab4c0; --line: #39424e; --panel: #171b20; --accent: #5eead4; } }
body { margin: 0; font: 14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--fg); }
main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 56px; }
nav { display: flex; gap: 14px; flex-wrap: wrap; margin: 0 0 28px; }
a { color: var(--accent); }
h1 { font-size: 28px; margin: 0 0 10px; }
h2 { font-size: 18px; margin: 28px 0 10px; }
table { border-collapse: collapse; width: 100%; margin: 10px 0 20px; }
th, td { border: 1px solid var(--line); padding: 7px 8px; text-align: left; vertical-align: top; }
th { background: color-mix(in srgb, var(--panel) 88%, var(--fg)); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
pre { background: var(--panel); border: 1px solid var(--line); padding: 12px; overflow: auto; }
.muted { color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 20px 0; }
.stat { border: 1px solid var(--line); background: var(--panel); padding: 12px; border-radius: 6px; }
.stat strong { display: block; font-size: 24px; }
.bar { display: inline-block; min-width: 130px; height: 9px; background: color-mix(in srgb, var(--line) 80%, transparent); vertical-align: middle; }
.bar span { display: block; height: 100%; background: var(--accent); }
.artifact { max-width: 360px; border: 1px solid var(--line); display: block; margin-top: 6px; }
.placeholder { border: 1px dashed var(--line); padding: 20px; color: var(--muted); margin-top: 6px; display: inline-block; }
@media print { nav { display: none; } body { background: white; color: black; } }
</style>
<main>
<nav><a href="index.html">Overview</a><a href="matrix.html">Matrix</a><a href="accounting.html">Accounting</a></nav>
${body}
</main>
</html>
`;
}

function findRunForFinding(ledger, findingId) {
  return (ledger.runs ?? []).find((run) => findingId.startsWith(`${run.run_id}/${run.case_id}#`)) ?? null;
}

function copyCitedArtifacts(ledgers, runsRoot, outDir) {
  const assetsDir = path.join(outDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  const copied = new Map();

  for (const ledger of ledgers) {
    for (const finding of ledger.findings ?? []) {
      if (!Number.isInteger(finding.step)) continue;
      const run = findRunForFinding(ledger, finding.finding_id);
      if (!run) continue;
      const assetName = `${sanitize(run.run_id)}-${sanitize(run.case_id)}-${stepName(finding.step)}`;
      const source = path.join(runsRoot, run.run_id, run.case_id, 'steps', stepName(finding.step));
      if (existsSync(source)) {
        copyFileSync(source, path.join(assetsDir, assetName));
        copied.set(`${finding.finding_id}:${finding.step}`, { exists: true, name: assetName });
      } else {
        copied.set(`${finding.finding_id}:${finding.step}`, { exists: false, name: assetName });
      }
    }
  }

  return copied;
}

function chart(matrix) {
  const arms = Object.entries(matrix.by_arm);
  if (arms.length === 0) return '<p class="muted">No rounds yet.</p>';
  const width = 720;
  const height = 240;
  const pad = 28;
  const colors = ['#0f766e', '#b45309', '#2563eb', '#be123c'];
  const maxRound = Math.max(1, ...arms.flatMap(([, data]) => data.rounds.map((round) => round.round)));
  const maxFaults = Math.max(1, matrix.faults.length);
  const scaleX = (round) => pad + ((round - 1) / Math.max(1, maxRound - 1)) * (width - pad * 2);
  const scaleY = (remaining) => height - pad - (remaining / maxFaults) * (height - pad * 2);
  const paths = arms.map(([arm, data], index) => {
    const points = data.rounds.map((round) => `${scaleX(round.round)},${scaleY(maxFaults - round.distinct_faults_found)}`).join(' ');
    return `<polyline fill="none" stroke="${colors[index % colors.length]}" stroke-width="3" points="${points}"/><text x="${pad}" y="${18 + index * 18}" fill="${colors[index % colors.length]}">${escapeHtml(arm)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Faults remaining per round" style="max-width:100%;height:auto;border:1px solid var(--line);background:var(--panel)">
<line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="var(--line)"/>
<line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="var(--line)"/>
<text x="${pad}" y="${height - 6}" fill="currentColor">round</text>
<text x="6" y="${pad}" fill="currentColor">faults remaining</text>
${paths}
</svg>`;
}

function renderIndex(matrix) {
  const armCount = Object.keys(matrix.by_arm).length;
  const latestDetected = Math.max(0, ...Object.values(matrix.by_arm).map((arm) => arm.rounds.at(-1)?.distinct_faults_found ?? 0));
  return page('Hill-climb study report', `<h1>Hill-climb study report</h1>
<p class="muted">Study narrative stub. Generated from the ledger; no hand-assembled synthesis.</p>
<div class="grid">
  <div class="stat"><strong>${matrix.faults.length}</strong>catalog faults</div>
  <div class="stat"><strong>${armCount}</strong>arms with rounds</div>
  <div class="stat"><strong>${latestDetected}</strong>distinct faults detected</div>
</div>
<h2>Climb chart</h2>
${chart(matrix)}`);
}

function heat(value, max) {
  const alpha = max === 0 ? 0 : Math.min(0.85, 0.12 + (value / max) * 0.73);
  return `background: rgba(15, 118, 110, ${alpha.toFixed(2)})`;
}

function renderMatrix(matrix) {
  const max = Math.max(0, ...matrix.faults.flatMap((fault) => matrix.personas.map((persona) => matrix.detection_matrix[fault][persona] ?? 0)));
  const rows = matrix.faults.map((fault) => `<tr><th>${escapeHtml(fault)}</th>${matrix.personas.map((persona) => {
    const value = matrix.detection_matrix[fault][persona] ?? 0;
    return `<td style="${heat(value, max)}">${value}</td>`;
  }).join('')}</tr>`).join('\n');

  const recall = Object.entries(matrix.by_arm).flatMap(([arm, data]) => {
    const latest = data.rounds.at(-1);
    if (!latest) return [];
    return Object.entries(latest.recall_by_level).map(([level, value]) => {
      const pct = value.reachable_rate === null ? 0 : Math.round(value.reachable_rate * 100);
      return `<tr><td>${escapeHtml(arm)}</td><td>${level}</td><td><span class="bar"><span style="width:${pct}%"></span></span> ${pct}%</td><td>${value.reachable_found}/${value.reachable_total}</td></tr>`;
    });
  }).join('\n');

  return page('Detection matrix', `<h1>Detection matrix</h1>
<table><thead><tr><th>fault</th>${matrix.personas.map((persona) => `<th>${escapeHtml(persona)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
<h2>Reachable recall by level</h2>
<table><thead><tr><th>arm</th><th>level</th><th>recall</th><th>count</th></tr></thead><tbody>${recall}</tbody></table>`);
}

function renderAccounting(matrix) {
  const summaryBlocks = Object.entries(matrix.by_arm).map(([arm, data]) => {
    const s = data.accounting_summary ?? {};
    const lc = s.label_counts ?? {};
    return `<h2>${escapeHtml(arm)} <span class="muted">(clean definition ${escapeHtml(data.clean_definition ?? '?')})</span></h2>
<div class="grid">
  <div class="stat"><strong>${s.detected ?? 0}</strong>detected (catalog TP)</div>
  <div class="stat"><strong>${s.found_and_fixed ?? 0}</strong>found-and-fixed</div>
  <div class="stat"><strong>${s.fixed_without_detection ?? 0}</strong>fixed without detection</div>
  <div class="stat"><strong>${s.residual ?? 0}</strong>residual live</div>
  <div class="stat"><strong>${s.emergent ?? lc.emergent ?? 0}</strong>emergent findings</div>
  <div class="stat"><strong>${lc['spec-gap'] ?? 0}</strong>spec-gap</div>
  <div class="stat"><strong>${lc['soft-ux'] ?? 0}</strong>soft-ux</div>
  <div class="stat"><strong>${lc['subject-quirk'] ?? 0}</strong>subject-quirk</div>
  <div class="stat"><strong>${lc['harness-artifact'] ?? 0}</strong>harness-artifact</div>
  <div class="stat"><strong>${lc.false ?? 0}</strong>false</div>
</div>
<p class="muted">Do not treat non-TP rows as one “FP” bucket — DESIGN.md §3.2 labels split product signal from catalog precision. v1 arm clean flags are not retro-rewritten under the P3 clean definition.</p>`;
  }).join('\n');

  const tables = Object.entries(matrix.accounting).map(([arm, rows]) => `<h2>${escapeHtml(arm)} — per fault</h2>
<table><thead><tr><th>fault</th><th>status</th><th>findings</th><th>fixes</th></tr></thead><tbody>
${rows.map((row) => `<tr><td>${escapeHtml(row.fault_id)}</td><td>${escapeHtml(row.status)}</td><td>${row.findings.map((finding) => `<code>${escapeHtml(finding.finding_id)}</code>`).join('<br>')}</td><td>${row.fixes.map((fix) => `<code>${escapeHtml(fix.commit)}</code>`).join('<br>')}</td></tr>`).join('\n')}
</tbody></table>`).join('\n');
  return page('Fault accounting', `<h1>Fault accounting</h1>
<p class="muted">Split summary: detected · fixed-without-detection · residual · §3.2 label counts (BUILD_PLAN P3).</p>
${summaryBlocks}
${tables}`);
}

function renderRound(ledger, artifactMap) {
  const judgmentById = new Map((ledger.adjudication ?? []).map((entry) => [entry.finding_id, entry]));
  const runRows = (ledger.runs ?? []).map((run) => `<tr><td><code>${escapeHtml(run.run_id)}</code></td><td>${escapeHtml(run.case_id)}</td><td>${escapeHtml(run.persona)}</td><td>${escapeHtml(run.status)}</td><td>${run.steps}</td><td>${run.cost_usd}</td></tr>`).join('\n');
  const findingRows = (ledger.findings ?? []).map((finding) => {
    const judgment = judgmentById.get(finding.finding_id);
    const artifact = Number.isInteger(finding.step) ? artifactMap.get(`${finding.finding_id}:${finding.step}`) : null;
    const image = artifact
      ? (artifact.exists ? `<img class="artifact" src="../assets/${escapeHtml(artifact.name)}" alt="step ${finding.step} evidence">` : '<span class="placeholder">artifact not on this machine</span>')
      : '';
    return `<tr><td><code>${escapeHtml(finding.finding_id)}</code>${image}</td><td>${escapeHtml(finding.note ?? finding.question ?? '')}</td><td>${escapeHtml(judgment?.verdict ?? '')}</td><td>${escapeHtml(judgment?.rationale ?? '')}</td></tr>`;
  }).join('\n');
  const fixRows = (ledger.fixes ?? []).map((fix) => `<tr><td><code>${escapeHtml(fix.commit)}</code></td><td>${escapeHtml(fix.fault_id ?? '')}</td><td>${escapeHtml(fix.description)}</td><td>${escapeHtml(fix.regression_story)}</td></tr>`).join('\n');

  return page(`${ledger.arm} round ${padRound(ledger.round)}`, `<h1>${escapeHtml(ledger.arm)} round ${padRound(ledger.round)}</h1>
<h2>Fingerprint</h2><pre>${escapeHtml(JSON.stringify(ledger.fingerprint, null, 2))}</pre>
<h2>Runs</h2><table><thead><tr><th>run</th><th>case</th><th>persona</th><th>status</th><th>steps</th><th>cost</th></tr></thead><tbody>${runRows}</tbody></table>
<h2>Findings</h2><table><thead><tr><th>finding</th><th>note</th><th>verdict</th><th>rationale</th></tr></thead><tbody>${findingRows}</tbody></table>
<h2>Fixes</h2><table><thead><tr><th>commit</th><th>fault</th><th>description</th><th>regression story</th></tr></thead><tbody>${fixRows}</tbody></table>`);
}

export function buildSite(options) {
  const ledgers = options.ledgers ?? loadLedgerEntries(options.ledgerDir).map(({ entry }) => entry);
  const faults = options.faults ?? readJson(options.faultsFile);
  const matrix = buildMatrix({
    ledgers: ledgers.map((entry) => ({ file: '<memory>', entry })),
    faults
  });
  const outDir = options.outDir;
  mkdirSync(path.join(outDir, 'rounds'), { recursive: true });
  const artifactMap = copyCitedArtifacts(ledgers, options.runsRoot, outDir);

  writeText(path.join(outDir, 'index.html'), renderIndex(matrix));
  writeText(path.join(outDir, 'matrix.html'), renderMatrix(matrix));
  writeText(path.join(outDir, 'accounting.html'), renderAccounting(matrix));
  for (const ledger of ledgers) {
    writeText(path.join(outDir, 'rounds', `${ledger.arm}-${padRound(ledger.round)}.html`), renderRound(ledger, artifactMap));
  }
  return { ok: true, files: ['index.html', 'matrix.html', 'accounting.html'] };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return { ok: true };
  }
  requireArgs(args, ['ledger-dir', 'faults', 'runs-root', 'out']);

  const result = buildSite({
    ledgerDir: args['ledger-dir'],
    faultsFile: args.faults,
    runsRoot: args['runs-root'],
    outDir: args.out
  });
  console.log(`${args.out}: OK`);
  return result;
}

if (isDirectRun(import.meta.url)) {
  runCli(main);
}
