const archive = window.HILLCLIMB_EVIDENCE?.documents ?? {};
const params = new URLSearchParams(window.location.search);
let activeDocument = params.get('doc') || 'full-report';
const sourceIndex = new Map(Object.values(archive).map(item => [item.source, item.id]));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
  })[character]);
}

function formatMoney(value) {
  return Number.isFinite(value) ? `$${value.toFixed(4)}` : '—';
}

function sourceFilename(document) {
  return document.source.split('/').at(-1);
}

function downloadDocument(document) {
  const text = document.kind === 'ledger'
    ? `${JSON.stringify(document.content, null, 2)}\n`
    : document.content;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const link = window.document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = sourceFilename(document);
  link.click();
  URL.revokeObjectURL(link.href);
}

function documentHeader(document, lede, actions = '') {
  return `<header class="evidence-document-header">
    <div><span class="eyebrow">${escapeHtml(document.group)} · Verbatim source snapshot</span><h1>${escapeHtml(document.title)}</h1><p>${escapeHtml(lede)}</p></div>
    <div class="evidence-header-actions">${actions}<button class="evidence-download" type="button" id="download-source">Download original</button></div>
    <div class="source-path"><span>Source path</span><code>${escapeHtml(document.source)}</code></div>
  </header>`;
}

function artifactName(ledger, finding) {
  if (!Number.isInteger(finding.step)) return null;
  const run = (ledger.runs ?? []).find(item => finding.finding_id.startsWith(`${item.run_id}/${item.case_id}#`));
  if (!run) return null;
  const sanitize = value => String(value).replace(/[^A-Za-z0-9_.@-]+/g, '_');
  return `${sanitize(run.run_id)}-${sanitize(run.case_id)}-${String(finding.step).padStart(3, '0')}.png`;
}

function renderLedger(document) {
  const ledger = document.content;
  const findings = ledger.findings ?? [];
  const adjudication = new Map((ledger.adjudication ?? []).map(item => [item.finding_id, item]));
  const cost = (ledger.runs ?? []).reduce((sum, run) => sum + (run.cost_usd ?? 0), 0);
  const appHash = ledger.fingerprint?.fault_set?.app_hash ?? 'not recorded';
  const findingRows = findings.map(finding => {
    const judgment = adjudication.get(finding.finding_id);
    const artifact = artifactName(ledger, finding);
    const image = artifact ? `<button class="finding-image image-button" data-lightbox="assets/${escapeHtml(artifact)}" aria-label="Open step ${finding.step} evidence"><img src="assets/${escapeHtml(artifact)}" alt="Step ${finding.step} evidence for ${escapeHtml(finding.finding_id)}" loading="lazy"></button>` : '';
    return `<tr>
      <td><code>${escapeHtml(finding.finding_id)}</code>${image}</td>
      <td><span class="severity ${escapeHtml(finding.severity ?? 'report')}">${escapeHtml(finding.severity ?? finding.source ?? 'report')}</span></td>
      <td>${escapeHtml(finding.note ?? finding.question ?? finding.answer ?? '')}</td>
      <td><strong class="verdict">${escapeHtml(judgment?.verdict ?? 'not adjudicated')}</strong>${judgment?.fault_id ? `<em class="mapped-fault">${escapeHtml(judgment.fault_id)}</em>` : ''}<small>${escapeHtml(judgment?.rationale ?? '')}</small></td>
    </tr>`;
  }).join('');

  const runRows = (ledger.runs ?? []).map(run => `<tr><td><code>${escapeHtml(run.run_id)}</code></td><td>${escapeHtml(run.case_id)}</td><td>${escapeHtml(run.persona)}</td><td>${run.steps ?? '—'}</td><td>${run.grade_score ?? '—'}</td><td>${formatMoney(run.cost_usd)}</td></tr>`).join('');
  const fixCards = (ledger.fixes ?? []).map(fix => `<article class="evidence-fix"><header><code>${escapeHtml(fix.commit)}</code><span>${escapeHtml(fix.fault_id ?? 'unseeded change')}</span></header><p>${escapeHtml(fix.description)}</p><small>${escapeHtml(fix.regression_story ?? 'No regression story recorded')}</small></article>`).join('') || '<p class="empty-evidence">No fixes were applied in this round.</p>';
  const amendmentCards = (ledger.amendments ?? []).map(item => `<article><time>${escapeHtml(item.at)}</time><p>${escapeHtml(item.note)}</p></article>`).join('') || '<p class="empty-evidence">No ledger amendments.</p>';

  return `${documentHeader(document, `${findings.length} findings from ${(ledger.runs ?? []).length} browser runs, with the original adjudication and app fingerprint.`)}
    <div class="ledger-summary">
      <article><strong>${(ledger.runs ?? []).length}</strong><span>browser runs</span></article>
      <article><strong>${findings.length}</strong><span>raw findings</span></article>
      <article><strong>${(ledger.fixes ?? []).length}</strong><span>fix entries</span></article>
      <article><strong>${ledger.clean_round ? 'Yes' : 'No'}</strong><span>clean-round flag</span></article>
      <article><strong>${formatMoney(cost)}</strong><span>actor / grader cost</span></article>
    </div>
    <div class="ledger-provenance"><div><span>Arm / round</span><strong>${escapeHtml(ledger.arm)} · ${String(ledger.round).padStart(2, '0')}</strong></div><div><span>App hash</span><code>${escapeHtml(appHash)}</code></div><div><span>Repository head</span><code>${escapeHtml(ledger.fingerprint?.repo_head ?? 'not recorded')}</code></div></div>
    <section class="evidence-subsection" id="runs"><div class="evidence-subheading"><span class="label">Execution</span><h2>Runs</h2></div><div class="evidence-table-wrap" tabindex="0"><table><thead><tr><th>Run</th><th>Case</th><th>Persona</th><th>Steps</th><th>Grade</th><th>Cost</th></tr></thead><tbody>${runRows}</tbody></table></div></section>
    <section class="evidence-subsection" id="fixes"><div class="evidence-subheading"><span class="label">App transition</span><h2>Fixes applied</h2></div><div class="evidence-fixes">${fixCards}</div></section>
    <section class="evidence-subsection" id="findings"><div class="evidence-subheading"><span class="label">Trajectory evidence</span><h2>Findings and adjudication</h2><p>These rows preserve the grader claim and the catalog-aware decision separately.</p></div><div class="finding-tools"><label>Filter findings<input type="search" id="finding-search" placeholder="Finding id, note, verdict…"></label><span id="finding-count">${findings.length} findings</span></div><div class="evidence-table-wrap finding-table" tabindex="0"><table><thead><tr><th>Finding</th><th>Severity</th><th>Observed evidence</th><th>Adjudication</th></tr></thead><tbody id="evidence-findings">${findingRows}</tbody></table></div></section>
    <section class="evidence-subsection" id="amendments"><div class="evidence-subheading"><span class="label">Chain of custody</span><h2>Ledger amendments</h2></div><div class="amendment-list">${amendmentCards}</div><details class="fingerprint"><summary>Full environment fingerprint <i>+</i></summary><pre><code>${escapeHtml(JSON.stringify(ledger.fingerprint, null, 2))}</code></pre></details></section>`;
}

function renderSource(document) {
  const lineCount = document.content.split('\n').length;
  return `${documentHeader(document, `${lineCount} lines preserved from the study repository.`)}
    <div class="source-summary"><span>${escapeHtml(document.language)}</span><strong>${lineCount} lines</strong><small>Rendered as source to preserve exact wording and syntax.</small></div>
    <pre class="source-code" tabindex="0"><code>${escapeHtml(document.content)}</code></pre>`;
}

function normalizePath(value) {
  const parts = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function resolveMarkdownHref(document, value) {
  const href = String(value ?? '').trim();
  if (!href || href.startsWith('#')) return href || '#';
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^(javascript:|data:|vbscript:)/i.test(href)) return '#';

  const [pathname, ...fragmentParts] = href.split('#');
  const fragment = fragmentParts.length ? `#${fragmentParts.join('#')}` : '';
  const sourceDirectory = document.source.split('/').slice(0, -1).join('/');
  const resolved = normalizePath(`${sourceDirectory}/${pathname}`);
  const bundledId = sourceIndex.get(resolved);
  if (bundledId) return `?doc=${encodeURIComponent(bundledId)}${fragment}`;

  const reportPrefix = 'studies/hillclimb/report/';
  if (resolved.startsWith(reportPrefix)) return `${resolved.slice(reportPrefix.length)}${fragment}`;
  return href;
}

function plainInlineText(value) {
  return String(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim();
}

function renderInline(value, document) {
  const tokens = [];
  const hold = html => {
    const token = `\uE000${tokens.length}\uE001`;
    tokens.push(html);
    return token;
  };

  let text = String(value ?? '');
  text = text.replace(/(`+)([\s\S]*?)\1/g, (_match, _ticks, code) => hold(`<code>${escapeHtml(code.trim())}</code>`));
  text = text.replace(/!\[([^\]]*)\]\((\S+?)(?:\s+["']([^"']*)["'])?\)/g, (_match, alt, href, title) => {
    const resolved = resolveMarkdownHref(document, href);
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
    return hold(`<a class="markdown-image" href="${escapeHtml(resolved)}" data-lightbox="${escapeHtml(resolved)}"${titleAttribute}><img src="${escapeHtml(resolved)}" alt="${escapeHtml(alt)}" loading="lazy"></a>`);
  });
  text = text.replace(/\[([^\]]+)\]\((\S+?)(?:\s+["']([^"']*)["'])?\)/g, (_match, label, href, title) => {
    const resolved = resolveMarkdownHref(document, href);
    const external = /^(https?:|mailto:)/i.test(resolved);
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
    const externalAttributes = external ? ' target="_blank" rel="noreferrer"' : '';
    return hold(`<a href="${escapeHtml(resolved)}"${titleAttribute}${externalAttributes}>${renderInline(label, document)}</a>`);
  });

  text = escapeHtml(text)
    .replace(/\\([\\`*_[\]{}()#+.!~-])/g, '$1')
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+?)__/g, '<strong>$1</strong>')
    .replace(/~~([^~]+?)~~/g, '<del>$1</del>')
    .replace(/(^|[\s(])\*([^*\n]+?)\*(?=$|[\s),.;:!?])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+?)_(?=$|[\s),.;:!?])/g, '$1<em>$2</em>');

  return text.replace(/\uE000(\d+)\uE001/g, (_match, index) => tokens[Number(index)]);
}

function splitTableRow(line) {
  const value = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cell = '';
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isTableDivider(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function startsMarkdownBlock(lines, index) {
  const line = lines[index] ?? '';
  return /^ {0,3}(#{1,6})\s+/.test(line)
    || /^ {0,3}(```|~~~)/.test(line)
    || /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)
    || /^\s*(?:[-+*]|\d+\.)\s+/.test(line)
    || /^ {0,3}>/.test(line)
    || (line.includes('|') && isTableDivider(lines[index + 1] ?? ''));
}

function slugifyHeading(value, usedSlugs) {
  const base = plainInlineText(value).toLowerCase()
    .replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'section';
  const count = usedSlugs.get(base) ?? 0;
  usedSlugs.set(base, count + 1);
  return count ? `${base}-${count + 1}` : base;
}

function renderMarkdown(document) {
  const lines = document.content.replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  const headings = [];
  const usedSlugs = new Map();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^ {0,3}(```|~~~)\s*([\w+-]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const language = fence[2];
      const code = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker}`).test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      const languageLabel = language ? `<span>${escapeHtml(language)}</span>` : '';
      html.push(`<div class="markdown-code">${languageLabel}<pre><code>${escapeHtml(code.join('\n'))}</code></pre></div>`);
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2];
      const id = slugifyHeading(title, usedSlugs);
      html.push(`<h${level} id="${id}">${renderInline(title, document)}<a class="heading-anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`);
      if (level <= 3) headings.push({ level, id, title: plainInlineText(title) });
      index += 1;
      continue;
    }

    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      html.push('<hr>');
      index += 1;
      continue;
    }

    if (line.includes('|') && isTableDivider(lines[index + 1] ?? '')) {
      const headers = splitTableRow(line);
      const dividers = splitTableRow(lines[index + 1]);
      const alignments = dividers.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      const headerHtml = headers.map((cell, cellIndex) => `<th class="align-${alignments[cellIndex] ?? 'left'}">${renderInline(cell, document)}</th>`).join('');
      const bodyHtml = rows.map(row => `<tr>${headers.map((_cell, cellIndex) => `<td class="align-${alignments[cellIndex] ?? 'left'}">${renderInline(row[cellIndex] ?? '', document)}</td>`).join('')}</tr>`).join('');
      html.push(`<div class="markdown-table-wrap" tabindex="0"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`);
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
        quote.push(lines[index].replace(/^ {0,3}>\s?/, ''));
        index += 1;
      }
      html.push(`<blockquote><p>${renderInline(quote.join(' '), document)}</p></blockquote>`);
      continue;
    }

    const listMatch = line.match(/^(\s*)([-+*]|\d+\.)\s+(.+)/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2]);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      const baseIndent = listMatch[1].length;
      while (index < lines.length) {
        const itemMatch = lines[index].match(/^(\s*)([-+*]|\d+\.)\s+(.+)/);
        if (!itemMatch || itemMatch[1].length !== baseIndent || /\d+\./.test(itemMatch[2]) !== ordered) break;
        const content = [itemMatch[3]];
        index += 1;
        while (index < lines.length && lines[index].trim()) {
          const nextItem = lines[index].match(/^(\s*)([-+*]|\d+\.)\s+(.+)/);
          if (nextItem && nextItem[1].length === baseIndent) break;
          if (startsMarkdownBlock(lines, index) && !/^\s+/.test(lines[index])) break;
          content.push(lines[index].trim());
          index += 1;
        }
        while (index < lines.length && !lines[index].trim()) index += 1;
        items.push(`<li>${renderInline(content.join(' '), document)}</li>`);
      }
      html.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsMarkdownBlock(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p>${renderInline(paragraph.join(' '), document)}</p>`);
  }

  return { html: html.join(''), headings };
}

function renderMarkdownDocument(document) {
  const lineCount = document.content.split('\n').length;
  const rendered = renderMarkdown(document);
  const contents = rendered.headings.filter(heading => heading.level === 2 || heading.level === 3);
  const toc = contents.length ? `<aside class="markdown-toc" aria-label="On this page"><span>On this page</span><nav>${contents.map(heading => `<a class="toc-level-${heading.level}" href="#${heading.id}">${escapeHtml(heading.title)}</a>`).join('')}</nav></aside>` : '';
  const viewToggle = `<div class="reader-toggle" role="group" aria-label="Document view"><button type="button" data-reader-view="rendered" aria-pressed="true">Reading view</button><button type="button" data-reader-view="source" aria-pressed="false">Source</button></div>`;

  return `${documentHeader(document, `${lineCount} lines rendered for reading. Switch to source at any time to inspect the exact Markdown.`, viewToggle)}
    <div class="markdown-layout">
      <div class="markdown-prose" id="markdown-rendered">${rendered.html}</div>
      ${toc}
    </div>
    <pre class="source-code markdown-source" id="markdown-source" tabindex="0" hidden><code>${escapeHtml(document.content)}</code></pre>`;
}

function renderNavigation() {
  const groups = [...new Set(Object.values(archive).map(document => document.group))];
  document.querySelector('#document-total').textContent = `${Object.keys(archive).length} documents`;
  document.querySelector('#evidence-nav').innerHTML = groups.map(group => `<section><span>${escapeHtml(group)}</span>${Object.values(archive).filter(document => document.group === group).map(document => `<a href="?doc=${encodeURIComponent(document.id)}" data-document="${escapeHtml(document.id)}">${escapeHtml(document.title)}</a>`).join('')}</section>`).join('');
}

function setupDocumentInteractions(selectedDocument) {
  document.querySelector('#download-source')?.addEventListener('click', () => downloadDocument(selectedDocument));
  document.querySelectorAll('[data-lightbox]').forEach(button => button.addEventListener('click', event => {
    event.preventDefault();
    const dialog = window.document.querySelector('#lightbox');
    dialog.querySelector('img').src = button.dataset.lightbox;
    dialog.showModal();
  }));
  document.querySelectorAll('[data-reader-view]').forEach(button => button.addEventListener('click', () => {
    const showSource = button.dataset.readerView === 'source';
    document.querySelector('#markdown-rendered').hidden = showSource;
    document.querySelector('.markdown-toc')?.toggleAttribute('hidden', showSource);
    document.querySelector('#markdown-source').hidden = !showSource;
    document.querySelectorAll('[data-reader-view]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }));
  const search = document.querySelector('#finding-search');
  search?.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    const rows = [...document.querySelectorAll('#evidence-findings tr')];
    let visible = 0;
    rows.forEach(row => {
      row.hidden = query && !row.textContent.toLowerCase().includes(query);
      if (!row.hidden) visible += 1;
    });
    document.querySelector('#finding-count').textContent = `${visible} finding${visible === 1 ? '' : 's'}`;
  });
}

function renderDocument(id) {
  const selected = archive[id] ?? archive['full-report'];
  activeDocument = selected.id;
  document.title = `${selected.title} · Playtest evidence`;
  document.querySelector('#evidence-content').innerHTML = selected.kind === 'ledger'
    ? renderLedger(selected)
    : selected.language === 'markdown'
      ? renderMarkdownDocument(selected)
      : renderSource(selected);
  document.querySelectorAll('[data-document]').forEach(link => link.classList.toggle('active', link.dataset.document === selected.id));
  setupDocumentInteractions(selected);
  requestAnimationFrame(() => {
    if (window.location.hash) document.querySelector(window.location.hash)?.scrollIntoView();
    else window.scrollTo(0, 0);
  });
}

document.querySelector('.dialog-close').addEventListener('click', () => document.querySelector('#lightbox').close());
document.querySelector('#lightbox').addEventListener('click', event => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
renderNavigation();
renderDocument(activeDocument);
