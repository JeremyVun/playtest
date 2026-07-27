// The pruned a11y-text snapshot script ("a11y-text-v6"), evaluated in the page.
// Kept as a real function so `node --check` parses it; exported as a source
// string for page.evaluate(). Page-side rules: zero dependencies, never throw.

// True when every word of `text` already appears in `name` — i.e. the visible
// text merely echoes the accessible name, so child text: lines would be noise.
// False when `text` has at least one token the name lacks (new data/prose).
type SnapshotElement = HTMLElement & {
  labels?: NodeListOf<HTMLLabelElement> | HTMLLabelElement[];
  multiple?: boolean;
  selectedOptions?: HTMLCollectionOf<HTMLOptionElement>;
  options?: HTMLOptionsCollection;
  checked?: boolean;
  value?: string;
  type?: string;
  disabled?: boolean;
  open?: boolean;
};
type SnapshotInlineNode = ChildNode & { innerText?: string };

export function nameEchoesVisibleText(name: unknown, text: unknown): boolean {
  const norm = (s: unknown): string => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const t = norm(text);
  if (!t) return true;                    // nothing visible → suppress
  const n = norm(name);
  if (!n) return false;                   // unnamed container → keep its prose
  const nameWords = new Set(n.split(' '));
  return t.split(' ').every((w) => nameWords.has(w));
}

// True when an element should be treated as interactive SOLELY because the app
// styles it as a button: computed `cursor:pointer` on a leaf-ish element that
// carries its own direct text. Catches the "div-styled-as-button" a11y defect
// (a <div>/<span> with a React click listener but no <button>/role/onclick/
// tabindex).
//
// `cursor` is an INHERITED CSS property, so getComputedStyle().cursor is
// 'pointer' on every text-leaf descendant of any clickable ancestor (a real
// <button>, an <a>, or a div-button). Tagging those leaves double-refs the
// inner label of normal buttons (the e54/e55 duplication bug). So we tag ONLY
// the element that ORIGINATES the pointer cursor — its PARENT must not also
// compute 'pointer'. The genuine div-button is the topmost node in its
// cursor:pointer chain; inherited descendants (incl. a real button's label
// span) all have a pointer parent and are skipped. `parentCursor` is the
// parent's computed cursor ('' when there's no element parent).
//
// `hasDirectText` scopes it to the label-bearing leaf (not a big wrapper).
// `alreadyInteractive` short-circuits real controls so they keep their natural
// role. NOTE: keep this in sync with the inline branch in isInteractive below —
// the export isn't in browser scope, so the logic is inlined there.
export function cursorPointerInteractive(cursor: string, hasDirectText: boolean, alreadyInteractive: boolean, parentCursor: string): boolean {
  if (alreadyInteractive) return false;
  if (cursor !== 'pointer') return false;
  if (parentCursor === 'pointer') return false; // inheriting, not the origin
  return !!hasDirectText;
}

// Render a `<select>`'s option list for the snapshot line, capped so one giant
// dropdown (a 250-country picker) can't consume the whole MAX_CHARS budget and
// starve every interactive element after it of a ref. `labels` are the cleaned
// option labels in DOM order. Up to MAX_OPTIONS are listed; when more exist we
// append a count + the escape hatch telling the actor it may still `select` any
// EXACT label even if it isn't shown (selectOption resolves against the live DOM,
// not this text). NOTE: keep in sync with the inlined branch in renderLine below —
// the export isn't in browser scope.
export function renderSelectOptions(labels: string[], MAX_OPTIONS = 35): string {
  const quoted = labels.map((l) => `"${l}"`);
  if (quoted.length <= MAX_OPTIONS) return 'options: [' + quoted.join(', ') + ']';
  const shown = quoted.slice(0, MAX_OPTIONS);
  const hidden = quoted.length - MAX_OPTIONS;
  return 'options: [' + shown.join(', ') +
    '] (+' + hidden + ' more — select by exact label even if not listed)';
}

// True when a control's current text should be echoed as a `value="..."` marker.
// textbox/searchbox/spinbutton/slider are always input/textarea-backed, so their
// value is a live string. `combobox` is the ARIA autocomplete pattern and comes in
// two shapes: an editable <input role="combobox"> (its `.value` is the typed/
// selected text the actor MUST see — losing it makes a filled field look empty) and
// a <div role="combobox"> styled as a select (no `.value` — its selection surfaces
// as child text). We gate combobox on the value being an actual string so the input
// form emits its value while the div form doesn't emit a misleading `value=""`.
// (<select> is rendered by its own tagName branch before roles are consulted.)
// NOTE: keep in sync with the inlined branch in renderLine — the export isn't in
// browser scope.
export function rendersValue(role: string, hasStringValue: boolean): boolean {
  if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || role === 'slider') return true;
  if (role === 'combobox') return hasStringValue;
  return false;
}

function buildSnapshot(): { text: string; refCount: number; truncated: boolean } {
  try {
    const MAX_ELEMENTS = 200;
    const MAX_CHARS = 6000;
    const MAX_OPTIONS = 35;
    const vh = window.innerHeight || 800;
    const CONTAINER_ROLES = new Set([
      'radiogroup', 'group', 'listbox', 'menu', 'menubar', 'tablist',
      'tree', 'toolbar', 'grid', 'treegrid', 'row', 'rowgroup', 'region', 'feed',
      // Landmarks: not clickable, and their accessible name is never drawn from
      // contents — a ref line here scoops up child button labels (banner "… Close").
      'banner', 'main', 'navigation', 'complementary', 'contentinfo', 'search', 'form'
    ]);

    // Normalize whitespace + escape quotes for the line format. Deliberately does
    // NOT truncate: the page shows the full string, so a per-string cap made the
    // actor "see" cut-off text (e.g. eligibility copy) the user never saw, and the
    // grader flagged it as a phantom UX issue. The snapshot-level MAX_CHARS cap
    // (pushLine) still bounds total size.
    const clean = (s: unknown): string => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim().replace(/"/g, "'");

    // Fresh ref numbering each call.
    for (const el of document.querySelectorAll('[data-dummy-ref]')) el.removeAttribute('data-dummy-ref');

    // Labels tied to a control contribute the control's name; don't repeat them as text.
    const consumedLabels = new Set<Element>();
    for (const l of document.querySelectorAll('label')) if (l.control) consumedLabels.add(l);

    const roleOf = (el: SnapshotElement): string => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit.trim().split(/\s+/)[0] as string;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'checkbox' || t === 'radio') return t;
        if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image' || t === 'file') return 'button';
        if (t === 'range') return 'slider';
        if (t === 'number') return 'spinbutton';
        return 'textbox';
      }
      return 'button'; // onclick/tabindex elements: clickable is all the agent needs to know
    };

    // Accessible name, simplified, in contract order.
    const accName = (el: SnapshotElement): string => {
      const aria = el.getAttribute('aria-label');
      if (aria && aria.trim()) return clean(aria);
      const ids = el.getAttribute('aria-labelledby');
      if (ids) {
        const t = ids.split(/\s+/).map((id) => {
          const n = document.getElementById(id);
          return n ? n.textContent : '';
        }).join('\n');
        if (t.trim()) return clean(t);
      }
      if (el.labels && el.labels.length) {
        const t = el.labels[0]!.textContent; // TODO(ts): labels.length proves the first associated label exists
        if (t && t.trim()) return clean(t);
      }
      const ph = el.getAttribute('placeholder');
      if (ph && ph.trim()) return clean(ph);
      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) return clean(alt);
      const title = el.getAttribute('title');
      if (title && title.trim()) return clean(title);
      if (el.tagName === 'INPUT' && el.value && ['button', 'submit', 'reset'].includes(el.type as string)) return clean(el.value);
      return clean(el.innerText || el.textContent);
    };

    // Suppress an element's child text only when its visible text just echoes its
    // accessible name (every visible word is already in the name). A container or a
    // named button with extra data (e.g. "LVR 0.00%") keeps its descendant text.
    // NOTE: keep this body in sync with the exported nameEchoesVisibleText helper —
    // the export isn't in browser scope, so the logic is inlined here.
    const nameEchoes = (el: SnapshotElement): boolean => {
      const norm = (s: unknown): string => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      const t = norm(clean(el.innerText || el.textContent || ''));
      if (!t) return true;
      const n = norm(accName(el));
      if (!n) return false;
      const nameWords = new Set(n.split(' '));
      return t.split(' ').every((w) => nameWords.has(w));
    };

// `style` is the element's already-resolved computed style (walk() computes it
// once per element); pass it in to avoid a second getComputedStyle(el).
const isInteractive = (el: SnapshotElement, style: CSSStyleDeclaration): boolean => {
  const tag = el.tagName.toLowerCase();
  if (tag === 'a' || tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
  if (tag === 'input') return (el.getAttribute('type') || '').toLowerCase() !== 'hidden';
  const role = el.getAttribute('role');
  if (role) {
    const r = role.trim().split(/\s+/)[0];
    if (r && r !== 'presentation' && r !== 'none' && !CONTAINER_ROLES.has(r)) return true;
  }
  if (el.hasAttribute('onclick')) return true;
  const ti = el.getAttribute('tabindex');
  if (ti != null && parseInt(ti, 10) >= 0) return true;
    // gave no <button>/role/onclick/tabindex — the div-styled-as-button a11y
    // defect. roleOf falls back to 'button'. `cursor` is INHERITED, so it's
    // 'pointer' on every text-leaf inside any clickable ancestor; tag ONLY
    // the element that ORIGINATES it (parent cursor isn't 'pointer'), else we
    // double-ref the inner label of real buttons. Also require the element
    // carry its OWN direct text (the label-bearing leaf, not a big wrapper) so
    // refs stay scoped to the budget. Keep in sync with cursorPointerInteractive.
    let cursor;
    try { cursor = (style || getComputedStyle(el)).cursor; } catch (e) { cursor = ''; }
    if (cursor === 'pointer') {
      let parentCursor = '';
      if (el.parentElement) {
        try { parentCursor = getComputedStyle(el.parentElement).cursor; } catch (e) { parentCursor = ''; }
      }
      if (parentCursor !== 'pointer') {
        let hasDirectText = false;
        for (const n of el.childNodes) {
          if (n.nodeType === 3 && n.textContent!.trim()) { hasDirectText = true; break; } // TODO(ts): DOM text nodes always expose textContent
        }
        if (hasDirectText) return true;
      }
    }
    return false;
  };

  // A visible element child laid out INLINE (a link/span/em inside a sentence),
  // whose text should be spliced into its parent's prose line rather than torn out.
  // Block-level children own their own line, so they're excluded.
  const isInlineEl = (el: SnapshotElement): boolean => {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    let d;
    try { d = getComputedStyle(el).display; } catch (e) { return false; }
    return d === 'inline' || d === 'inline-block' || d === 'inline-flex' || d === 'contents';
  };

  // For a custom-styled (e.g. display:none) input, the first visible associated
  // <label> — preferring input.labels, falling back to an immediate parent <label>.
  const visibleLabelFor = (input: SnapshotElement): SnapshotElement | null => {
    const visible = (el: SnapshotElement | null): boolean => {
      if (!el) return false;
      try {
        const s = getComputedStyle(el);
        return s && s.display !== 'none' && s.visibility !== 'hidden';
      } catch (e) {
        return false;
      }
    };
    if (input.labels) {
      for (const l of input.labels) if (visible(l)) return l;
    }
    let p = input.parentElement;
    while (p) {
      if (p.tagName === 'LABEL') return visible(p) ? p : null;
      p = p.parentElement;
    }
    return null;
  };

  const renderLine = (ref: string, el: SnapshotElement): string => {
    const role = roleOf(el);
    let line = '[' + ref + '] ' + role + ' "' + accName(el) + '"';
      if (role === 'heading') {
        const m = /^h([1-6])$/i.exec(el.tagName);
        line += ' (level ' + (m ? m[1] : el.getAttribute('aria-level') || '2') + ')';
      } else if (el.tagName === 'SELECT') {
        const picked = Array.prototype.map.call(el.selectedOptions || [], (o: HTMLOptionElement) => o.label) as string[];
        // A multi-select can have several picks — surface them all (joined) so the
        // actor sees its full live selection, not just the first option.
        line += ' value="' + clean(el.multiple ? picked.join(', ') : (picked[0] || '')) + '"';
        // Cap the inlined option list: one giant dropdown (a 250-country picker)
        // would otherwise consume the whole MAX_CHARS budget on this single line and
        // starve every interactive element after it of a ref. List up to MAX_OPTIONS;
        // beyond that, append a count + the escape hatch — the actor can still `select`
        // any EXACT label even if unlisted (selectOption resolves against the live DOM).
        // Keep in sync with the exported renderSelectOptions helper (not in browser scope).
        const opts = Array.prototype.map.call(el.options, (o: HTMLOptionElement) => '"' + clean(o.label) + '"') as string[];
        if (opts.length) {
          if (opts.length <= MAX_OPTIONS) line += ' options: [' + opts.join(', ') + ']';
          else line += ' options: [' + opts.slice(0, MAX_OPTIONS).join(', ') +
            '] (+' + (opts.length - MAX_OPTIONS) + ' more — select by exact label even if not listed)';
        }
      } else if (role === 'checkbox' || role === 'radio' || role === 'switch') {
        const checked = typeof el.checked === 'boolean' ? el.checked : el.getAttribute('aria-checked') === 'true';
        line += checked ? ' (checked)' : ' (unchecked)';
      } else if (
        // Controls whose current text is live state the actor must see. combobox is
        // the ARIA autocomplete pattern: an editable <input role="combobox"> has a
        // string `.value` (typed/selected address) that we surface, while a
        // <div role="combobox"> select has no `.value` and shows its choice as child
        // text — so gate combobox on a real string value, not a misleading "".
        // Keep in sync with the exported rendersValue helper (not in browser scope).
        role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || role === 'slider' ||
        (role === 'combobox' && typeof el.value === 'string')
      ) {
        line += ' value="' + clean(el.value) + '"';
    }
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') line += ' (disabled)';
    // Focus is observable UX state: surface which control currently holds the
    // keyboard (activeElement defaults to <body>, so guard the body sentinel).
    // For a hidden control fronted by a label, `el` is still the input, so the
    // marker tracks the real focus target, not the label.
    if (el === document.activeElement && el !== document.body) line += ' (focused)';
    return line;
  };

  const lines: string[] = [];
  let chars = 0;
  let refCount = 0;
  let truncated = false;
  let belowFold = false;
  let lastText = '';

  const pushLine = (line: string): boolean => {
    if (chars + line.length > MAX_CHARS) {
      truncated = true;
      return false;
    }
    lines.push(line);
    chars += line.length + 1;
    return true;
  };

  const isHideableControl = (el: SnapshotElement): boolean => {
    if (el.tagName !== 'INPUT') return false;
    const t = (el.getAttribute('type') || '').toLowerCase();
    return t === 'radio' || t === 'checkbox';
  };

  // A radio/checkbox <input> that isn't itself a usable click target (hidden, or
  // opacity:0 / zero-box) but is fronted by a visible <label>. Emit a ref line
  // describing the input and put data-dummy-ref on the label (clicking it forwards
  // to the control). Returns true if a ref was emitted.
  const emitViaLabel = (input: SnapshotElement): boolean => {
    if (!isHideableControl(input)) return false;
    const label = visibleLabelFor(input);
    if (!label || label.hasAttribute('data-dummy-ref')) return false;
    const lrect = label.getBoundingClientRect();
    if (!(lrect.width > 0 && lrect.height > 0)) return false;
    if (!(lrect.top < vh && lrect.bottom > 0)) {
      if (lrect.top >= vh) belowFold = true;
      return false;
    }
    if (refCount >= MAX_ELEMENTS) { truncated = true; return false; }
    const ref = 'e' + (refCount + 1);
    if (!pushLine(renderLine(ref, input))) return false;
    refCount++;
    label.setAttribute('data-dummy-ref', ref);
    return true;
  };

  const walk = (parent: SnapshotElement, suppressText: boolean, ancestorName?: string): void => {
    if (truncated) return;
    const parentClosedDetails = parent.tagName && parent.tagName.toLowerCase() === 'details' && !parent.open;
    for (const el of parent.children as HTMLCollectionOf<SnapshotElement>) {
      if (truncated) return;
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'svg') continue;
      // Closed <details>: only the <summary> is rendered; the rest is hidden-until-found
      // content that passes the display/box checks in Chromium but is not clickable.
      // Leaking it gave agents refs to invisible controls (e.g. a confirm button inside
      // a collapsed disclosure) that every click then failed on as "not visible".
      if (parentClosedDetails && tag !== 'summary') continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;
      let style;
      try { style = getComputedStyle(el); } catch (e) { continue; }
      const cssHidden = !style || style.display === 'none' || style.visibility === 'hidden';
      if (cssHidden) {
        // A display:none / visibility:hidden radio/checkbox: try to front it on a
        // visible label (see emitViaLabel). Otherwise the element is gone for good.
        if (tag === 'input') emitViaLabel(el);
        continue;
      }
      const rect = el.getBoundingClientRect();
      const hasBox = rect.width > 0 && rect.height > 0;
      const inView = rect.top < vh && rect.bottom > 0;
      let included = false;
      if (el.hasAttribute('data-dummy-ref')) {
        // Already claimed by the hidden-control branch (a label fronting a
        // hidden radio/checkbox). Don't overwrite its ref or re-emit it.
        included = true;
      } else if (isHideableControl(el) && (!hasBox || style.opacity === '0')) {
        // Custom-styled radio/checkbox kept in the layout but made unclickable
        // (opacity:0 and/or 0x0 box; the visually-hidden pattern). Front it on its
        // visible label so the agent gets a clickable ref.
        included = emitViaLabel(el);
      } else if (hasBox && (isInteractive(el, style) || /^h[1-6]$/.test(tag))) {
        if (!inView) {
          if (rect.top >= vh) belowFold = true;
        } else if (refCount >= MAX_ELEMENTS) {
          truncated = true;
        } else {
          const ref = 'e' + (refCount + 1);
          if (pushLine(renderLine(ref, el))) {
            refCount++;
            el.setAttribute('data-dummy-ref', ref);
            included = true;
          }
        }
      }

        if (!included && !suppressText && hasBox && inView && !consumedLabels.has(el)) {
          // Build the element's own inline text. Direct text nodes are taken verbatim.
          // When those direct text nodes carry actual prose, INLINE element children
          // (a link/span sitting inside the sentence) have their text spliced in where
          // they appear, so "Please <a>book</a> with us" reads as one continuous line
          // instead of "Please with us" with the link torn out. Without surrounding
          // prose we keep the old direct-text-only behavior, so a bare container of
          // links/blocks (e.g. a nav) still emits no text line — its links get refs.
          // TRADEOFF: an inline INTERACTIVE child (e.g. that <a>book</a>) is also
          // reached by the walk recursion below and gets its own [eN] ref, so its
          // label appears both in this prose line and as a ref. That double-surface
          // is intentional — readable prose matters more than the small redundancy,
          // and the actor still gets a working ref for the link.
          let direct = '';
          for (const n of el.childNodes) if (n.nodeType === 3) direct += n.textContent;
          let t = direct;
          if (direct.trim()) {
            t = '';
            for (const n of el.childNodes as NodeListOf<SnapshotInlineNode>) {
              if (n.nodeType === 3) t += n.textContent;
              else if (n.nodeType === 1 && isInlineEl(n as SnapshotElement)) t += (n.innerText || n.textContent || '');
            }
          }
          t = clean(t);
          const anc = ancestorName ?? '';
          const isEcho = anc.length > 0 && t === anc;
          if (t.length >= 2 && t !== lastText && !isEcho && pushLine('text: "' + t + '"')) lastText = t;
        }

        // A label whose control we surface elsewhere (it's in consumedLabels) should
        // not have its inner text echoed as separate text lines — its name already
        // rides on the control's ref (e.g. a custom radio whose text sits in a span).
        const echoes = nameEchoes(el);
        const suppressForChildren = suppressText || (included && echoes) || consumedLabels.has(el);
        const nextAncestorName = (included && !echoes) ? accName(el) : (ancestorName ?? '');
        walk(el, suppressForChildren, nextAncestorName);
      }
    };

    if (document.body) walk(document.body, false);

    const out = ['Page: ' + clean(document.title) + ' — ' + location.href];
    for (const line of lines) out.push(line);
    if (belowFold) out.push('(page continues below the fold — scroll down to see more)');
    if (truncated) out.push('(snapshot truncated)');
    return { text: out.join('\n'), refCount, truncated };
  } catch (e: any) { // TODO(ts): page-side code preserves the message access on arbitrary thrown values
    return { text: 'Page: <snapshot failed: ' + (e && e.message) + '>', refCount: 0, truncated: false };
  }
}

export const SNAPSHOT_SOURCE = `(${buildSnapshot.toString()})()`;
