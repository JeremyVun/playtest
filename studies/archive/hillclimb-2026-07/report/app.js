const detected = new Set([
  'f-add-cart-silent', 'f-decline-swallowed', 'f-empty-cart-jargon',
  'f-error-text-contrast', 'f-free-shipping-label', 'f-order-history-removed',
  'f-place-order-no-feedback', 'f-postcode-validation', 'f-price-contrast',
  'f-product-crumb-removed', 'f-qty-edit-removed', 'f-save-profile-dead',
  'f-search-removed', 'f-validation-wipes-payment'
]);

const naiveInspection = new Set([
  'f-sort-inert', 'f-card-spaces-validation',
  'f-account-error-swallowed', 'f-account-form-resets'
]);
const policyInspection = new Set([
  'f-sort-inert', 'f-card-spaces-validation', 'f-no-results-jargon',
  'f-clear-search-self-link', 'f-cant-buy-last-unit',
  'f-checkout-empty-guard-gone'
]);
const naiveFixed = new Set([
  'f-account-error-swallowed', 'f-account-form-resets', 'f-add-cart-silent',
  'f-card-spaces-validation', 'f-decline-swallowed', 'f-error-text-contrast',
  'f-free-shipping-label', 'f-order-history-removed', 'f-place-order-no-feedback',
  'f-postcode-validation', 'f-price-contrast', 'f-qty-edit-removed',
  'f-save-profile-dead', 'f-search-removed', 'f-sort-inert',
  'f-validation-wipes-payment'
]);
const policyFixed = new Set([
  'f-add-cart-silent', 'f-cant-buy-last-unit', 'f-card-spaces-validation',
  'f-checkout-empty-guard-gone', 'f-clear-search-self-link',
  'f-decline-swallowed', 'f-empty-cart-jargon', 'f-error-text-contrast',
  'f-free-shipping-label', 'f-no-results-jargon', 'f-order-history-removed',
  'f-place-order-no-feedback', 'f-postcode-validation', 'f-price-contrast',
  'f-product-crumb-removed', 'f-qty-edit-removed', 'f-save-profile-dead',
  'f-search-removed', 'f-sort-inert', 'f-validation-wipes-payment'
]);

const gapByFault = {
  'f-account-error-swallowed': 'coverage',
  'f-account-form-resets': 'coverage',
  'f-card-spaces-validation': 'coverage',
  'f-cant-buy-last-unit': 'coverage',
  'f-checkout-empty-guard-gone': 'coverage',
  'f-no-results-jargon': 'coverage',
  'f-clear-search-self-link': 'coverage',
  'f-continue-shopping-loop': 'coverage',
  'f-sort-inert': 'recognition',
  'f-oos-says-in-stock': 'recognition',
  'f-cart-continue-removed': 'recognition',
  'f-receipt-eta-wrong': 'oracle'
};

const faultSeed = [
  ['f-price-contrast','L1','low-contrast','catalog','minor','Catalog prices are barely legible against the white product cards.'],
  ['f-error-text-contrast','L1','low-contrast','checkout','minor','A user who triggers a form error can barely read what went wrong.'],
  ['f-oos-says-in-stock','L1','misleading-copy','product detail','minor','An out-of-stock product says “In stock” beside a disabled “Out of stock” button.'],
  ['f-free-shipping-label','L1','misleading-copy','checkout','minor','The summary says “Free shipping” while adding $6.00 to the total.'],
  ['f-receipt-eta-wrong','L1','misleading-copy','order receipt','minor','A delivered or shipped order is described as newly confirmed and arriving in 3–5 days.'],
  ['f-empty-cart-jargon','L1','confusing-empty-state','cart','info','An empty cart says “Cart collection returned 0 rows” instead of speaking to the customer.'],
  ['f-no-results-jargon','L1','confusing-empty-state','catalog','info','A search with no matches reports a database-like “no product rows” message.'],
  ['f-sort-inert','L2','dead-control','catalog','minor','Choosing a catalog sort order leaves the products in exactly the same order.'],
  ['f-save-profile-dead','L2','dead-control','account','major','The Save profile control is visible but clicking it does nothing.'],
  ['f-add-cart-silent','L2','action-without-receipt','product detail','major','Add to cart succeeds without updating the badge or showing confirmation.'],
  ['f-place-order-no-feedback','L2','action-without-receipt','checkout','minor','Place order shows no in-progress state while the order is submitted.'],
  ['f-postcode-validation','L2','broken-validation','checkout','major','The shop rejects its own saved four-digit postcode as invalid.'],
  ['f-card-spaces-validation','L2','broken-validation','checkout','minor','A valid 16-digit card number is rejected unless typed with exact spacing.'],
  ['f-decline-swallowed','L2','swallowed-error','checkout','major','A declined card silently returns the button to idle with no error message.'],
  ['f-account-error-swallowed','L2','swallowed-error','account','minor','An invalid profile email is silently dropped with no success or error state.'],
  ['f-validation-wipes-payment','L3','lost-input','checkout','major','Any checkout validation error clears all payment fields.'],
  ['f-account-form-resets','L3','lost-input','account','minor','One invalid account field resets every field to its previous value.'],
  ['f-continue-shopping-loop','L3','misrouted-link','order receipt','minor','Continue shopping goes to checkout, which redirects the empty cart back to cart.'],
  ['f-clear-search-self-link','L3','misrouted-link','catalog','minor','Clear search reloads the same failed query, trapping the empty result.'],
  ['f-cant-buy-last-unit','L3','edge-case-break','product detail','major','An off-by-one stock check prevents a user buying the last available unit.'],
  ['f-checkout-empty-guard-gone','L3','edge-case-break','checkout','minor','An empty checkout displays a live payment form charging $6.00 for nothing.'],
  ['f-search-removed','L4','capability-removed','catalog','major','The catalog has no search input for a customer who knows what they want.'],
  ['f-qty-edit-removed','L4','capability-removed','cart','major','The cart shows quantity as static text with no way to change it.'],
  ['f-order-history-removed','L4','capability-removed','account','major','The account has no order history, receipt, or tracking entry point.'],
  ['f-product-crumb-removed','L4','navigation-removed','product detail','minor','A product page has no contextual route back to its category.'],
  ['f-cart-continue-removed','L4','navigation-removed','cart','minor','The cart has no local Continue shopping route; only global navigation remains.']
];

const faults = faultSeed.map(([id, level, cls, surface, severity, oracle]) => ({
  id, level, cls, surface, severity, oracle,
  detected: detected.has(id),
  gap: gapByFault[id] || null,
  naive: id === 'f-product-crumb-removed'
    ? 'accepted'
    : naiveFixed.has(id)
      ? (naiveInspection.has(id) ? 'undetected-fixed' : 'detected-fixed')
      : 'missed',
  policy: policyFixed.has(id)
    ? (policyInspection.has(id) ? 'undetected-fixed' : 'detected-fixed')
    : 'missed'
}));

const recall = [
  { level: 'L4', kind: 'Absence', value: 80, count: '4 / 5', color: 'var(--green)' },
  { level: 'L2', kind: 'Interaction', value: 62.5, count: '5 / 8', color: 'var(--blue)' },
  { level: 'L1', kind: 'Surface', value: 60, count: '3 / 5', color: 'var(--amber)' },
  { level: 'L3', kind: 'Flow', value: 20, count: '1 / 5', color: 'var(--red)' }
];

const hypotheses = [
  { id: 'H1', status: 'lost', title: 'It converges', text: 'Both arms converged, but detection missed the registered 75% threshold by 21 points.', result: '54% detected' },
  { id: 'H2', status: 'lost', title: 'Breakage beats absence', text: 'The expected scale gradient reversed. Goal-cued absence was easiest; flow was hardest.', result: 'L4 80% · L3 20%' },
  { id: 'H3', status: 'lost', title: 'The panel filters truth', text: 'Diversity lifted coverage, but convergent false positives defeated agreement as a truth filter.', result: '14 panel · 10 best solo' },
  { id: 'H4', status: 'lost', title: 'Policy is faster and cheaper', text: 'It cost 4% more and took the same executed rounds. Its win was safety, not efficiency.', result: '0 vs 11 regressions' },
  { id: 'H5', status: 'open', title: 'Actor and grader tiers split', text: 'Only one model pairing ran. The registered tier comparison remains untested.', result: 'Inconclusive' }
];

const gapContent = {
  coverage: {
    label: 'Bridgeable · instrumentation',
    title: 'The story named the behaviour, but never forced the state.',
    body: 'Eight misses were not perception failures. The actor never hit the invalid input, exact boundary, empty state, unmatched query, or recovery click that made the fault observable.',
    faults: ['account-error', 'account-reset', 'card-format', 'last-unit', 'empty-checkout', 'no-results', 'clear-search', 'receipt-continue'],
    fix: 'Seed state explicitly, require each transition, and fail the obligation as “not covered” when the action or postcondition is missing.'
  },
  recognition: {
    label: 'Bridgeable · actor / grader mode',
    title: 'The evidence was visible, but the actor normalised the wrong result.',
    body: 'Three faults were reached: inert sorting, contradictory stock copy, and a missing local cart route. The goal still completed, so the actor rationalised or ignored the inconsistency.',
    faults: ['sort-inert', 'stock-contradiction', 'cart-local-route'],
    fix: 'Add an adversarial semantic pass that compares expected change to observed change and reconciles co-located claims independently of goal completion.'
  },
  oracle: {
    label: 'Not bridgeable by journeys alone',
    title: 'Plausible-but-wrong values require a source of truth.',
    body: '“Arrives in 3–5 days” is believable copy. A journey actor cannot infer that it is wrong for a shipped or delivered order without a status-to-copy contract.',
    faults: ['receipt-eta-wrong'],
    fix: 'Add a deterministic contract oracle. The LLM can explain the user harm, but it should not be responsible for inventing business truth.'
  }
};

const outcomeLabels = {
  'detected-fixed': 'Detected · fixed',
  'undetected-fixed': 'Inspection · fixed',
  accepted: 'Detected · accepted',
  missed: 'Missed · live'
};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
  })[char]);
}

function renderRecall() {
  document.querySelector('#recall-chart').innerHTML = recall.map(item => `
    <div class="recall-row">
      <div class="recall-label"><strong>${item.level} · ${item.kind}</strong><span>${item.count} reachable</span></div>
      <div class="recall-track"><div class="recall-fill" style="--value:${item.value}%;--color:${item.color}"></div></div>
      <div class="recall-value">${Math.round(item.value)}%</div>
    </div>`).join('');
}

function renderHypotheses() {
  document.querySelector('#hypotheses').innerHTML = hypotheses.map(item => `
    <article class="hypothesis-card">
      <div class="hypothesis-top"><span class="hypothesis-id">${item.id}</span><span class="status-pill ${item.status}">${item.status === 'lost' ? 'Refuted' : 'Open'}</span></div>
      <h4>${item.title}</h4><p>${item.text}</p><span class="hypothesis-result">${item.result}</span>
    </article>`).join('');
}

function renderGap(key) {
  const item = gapContent[key];
  document.querySelector('#gap-detail').innerHTML = `
    <div class="gap-detail-top"><span class="label">Root cause</span><span class="bridge-badge">${item.label}</span></div>
    <h3>${item.title}</h3><p>${item.body}</p>
    <div class="fault-chips">${item.faults.map(fault => `<span class="fault-chip">${fault}</span>`).join('')}</div>
    <div class="gap-fix"><span>↳</span><p><strong>Product response:</strong> ${item.fix}</p></div>`;
  document.querySelectorAll('.gap-filter').forEach(button => button.classList.toggle('active', button.dataset.gap === key));
}

function renderPersonas() {
  const personas = [
    ['Cautious first-timer', 10, 1, 'Best single persona'],
    ['Weekend browser', 9, 2, 'Empty state + breadcrumb'],
    ['Returning regular', 9, 1, 'Only order-history signal'],
    ['Gift rusher', 9, 0, 'No unique coverage']
  ];
  document.querySelector('#persona-chart').innerHTML = `
    <span class="label">Distinct detected faults</span><h3>Marginal yield, not raw volume</h3>
    ${personas.map(([name, count, unique, note], index) => `
      <div class="persona-row ${index === 3 ? 'demoted' : ''}">
        <div class="persona-name"><strong>${name}</strong><span>${note}</span></div>
        <div class="persona-bar"><i style="--value:${count * 10}%"></i></div>
        <div class="persona-count">${count}</div>
        <div class="unique-count"><strong>${unique}</strong>unique</div>
      </div>`).join('')}`;
}

let activeLevel = 'all';

function filteredFaults() {
  const query = document.querySelector('#fault-search').value.trim().toLowerCase();
  const outcome = document.querySelector('#outcome-filter').value;
  return faults.filter(fault => {
    const text = `${fault.id} ${fault.surface} ${fault.cls} ${fault.oracle}`.toLowerCase();
    return (activeLevel === 'all' || fault.level === activeLevel)
      && (outcome === 'all' || fault.policy === outcome)
      && (!query || text.includes(query));
  });
}

function renderFaults() {
  const rows = filteredFaults();
  document.querySelector('#fault-rows').innerHTML = rows.map(fault => `
    <tr tabindex="0" data-fault="${fault.id}" aria-label="Open ${fault.id} details">
      <td><span class="fault-name">${fault.id}</span><span class="fault-class">${fault.cls}</span></td>
      <td><span class="level-badge">${fault.level}</span></td>
      <td>${fault.surface}</td>
      <td><span class="detected-icon ${fault.detected ? 'yes' : 'no'}" title="${fault.detected ? 'Detected by a tester' : 'Never detected'}">${fault.detected ? '✓ yes' : '× no'}</span></td>
      <td><span class="outcome ${fault.naive}">${outcomeLabels[fault.naive]}</span></td>
      <td><span class="outcome ${fault.policy}">${outcomeLabels[fault.policy]}</span></td>
      <td><span class="row-arrow">↗</span></td>
    </tr>`).join('');
  document.querySelector('#result-count').textContent = `${rows.length} fault${rows.length === 1 ? '' : 's'}`;
  document.querySelector('#empty-results').hidden = rows.length > 0;
}

function openFault(id) {
  const fault = faults.find(item => item.id === id);
  if (!fault) return;
  document.querySelector('#fault-dialog-content').innerHTML = `
    <span class="label">Verified seeded fault</span>
    <h2>${fault.id}</h2>
    <div class="fault-meta"><span>${fault.level}</span><span>${fault.severity}</span><span>${fault.surface}</span><span>${fault.cls}</span>${fault.gap ? `<span>${fault.gap} gap</span>` : ''}</div>
    <div class="fault-oracle"><span class="label">Ground-truth oracle</span><p>${escapeHtml(fault.oracle)}</p></div>
    <div class="fault-outcomes">
      <article><span>Tester</span><strong>${fault.detected ? 'Surfaced this fault' : 'Never surfaced this fault'}</strong></article>
      <article><span>Naive arm</span><strong>${outcomeLabels[fault.naive]}</strong></article>
      <article><span>Policy arm</span><strong>${outcomeLabels[fault.policy]}</strong></article>
      <article><span>Bridge class</span><strong>${fault.gap ? gapContent[fault.gap].label : 'Detected by current instrument'}</strong></article>
    </div>`;
  document.querySelector('#fault-dialog').showModal();
}

function setupInteractions() {
  document.querySelectorAll('.gap-filter').forEach(button => button.addEventListener('click', () => renderGap(button.dataset.gap)));
  document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
    activeLevel = button.dataset.level;
    document.querySelectorAll('.filter').forEach(item => item.classList.toggle('active', item === button));
    renderFaults();
  }));
  document.querySelector('#fault-search').addEventListener('input', renderFaults);
  document.querySelector('#outcome-filter').addEventListener('change', renderFaults);
  document.querySelector('#fault-rows').addEventListener('click', event => {
    const row = event.target.closest('tr[data-fault]');
    if (row) openFault(row.dataset.fault);
  });
  document.querySelector('#fault-rows').addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('tr[data-fault]')) {
      event.preventDefault();
      openFault(event.target.dataset.fault);
    }
  });
  document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  }));
  document.querySelectorAll('[data-lightbox]').forEach(button => button.addEventListener('click', () => {
    const dialog = document.querySelector('#lightbox');
    dialog.querySelector('img').src = button.dataset.lightbox;
    dialog.showModal();
  }));

  const navLinks = [...document.querySelectorAll('.nav a')];
  const sections = navLinks.map(link => document.querySelector(link.getAttribute('href'))).filter(Boolean);
  const observer = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    navLinks.forEach(link => link.classList.toggle('active', link.getAttribute('href') === `#${visible.target.id}`));
  }, { rootMargin: '-18% 0px -67% 0px', threshold: [0, .2, .6] });
  sections.forEach(section => observer.observe(section));
}

renderRecall();
renderHypotheses();
renderGap('coverage');
renderPersonas();
renderFaults();
setupInteractions();
