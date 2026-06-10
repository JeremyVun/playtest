// The pruned a11y-text snapshot script ("a11y-text-v1"), evaluated in the page.
// Kept as a real function so `node --check` parses it; exported as a source
// string for page.evaluate(). Page-side rules: zero dependencies, never throw.

function buildSnapshot() {
  try {
    const MAX_ELEMENTS = 200;
    const MAX_CHARS = 6000;
    const vh = window.innerHeight || 800;

    const clean = (s, max) => {
      s = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim().replace(/"/g, "'");
      return s.length > max ? s.slice(0, max - 3) + '...' : s;
    };

    // Fresh ref numbering each call.
    for (const el of document.querySelectorAll('[data-dummy-ref]')) el.removeAttribute('data-dummy-ref');

    // Labels tied to a control contribute the control's name; don't repeat them as text.
    const consumedLabels = new Set();
    for (const l of document.querySelectorAll('label')) if (l.control) consumedLabels.add(l);

    const roleOf = (el) => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit.trim().split(/\s+/)[0];
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return 'combobox';
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
    const accName = (el) => {
      const aria = el.getAttribute('aria-label');
      if (aria && aria.trim()) return clean(aria, 80);
      const ids = el.getAttribute('aria-labelledby');
      if (ids) {
        const t = ids.split(/\s+/).map((id) => {
          const n = document.getElementById(id);
          return n ? n.textContent : '';
        }).join(' ');
        if (t.trim()) return clean(t, 80);
      }
      if (el.labels && el.labels.length) {
        const t = el.labels[0].textContent;
        if (t && t.trim()) return clean(t, 80);
      }
      const ph = el.getAttribute('placeholder');
      if (ph && ph.trim()) return clean(ph, 80);
      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) return clean(alt, 80);
      const title = el.getAttribute('title');
      if (title && title.trim()) return clean(title, 80);
      if (el.tagName === 'INPUT' && el.value && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value, 80);
      return clean(el.innerText || el.textContent, 80);
    };

    const isInteractive = (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' || tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
      if (tag === 'input') return (el.getAttribute('type') || '').toLowerCase() !== 'hidden';
      const role = el.getAttribute('role');
      if (role) {
        const r = role.trim().split(/\s+/)[0];
        if (r && r !== 'presentation' && r !== 'none') return true;
      }
      if (el.hasAttribute('onclick')) return true;
      const ti = el.getAttribute('tabindex');
      if (ti !== null && parseInt(ti, 10) >= 0) return true;
      return false;
    };

    const renderLine = (ref, el) => {
      const role = roleOf(el);
      let line = '[' + ref + '] ' + role + ' "' + accName(el) + '"';
      if (role === 'heading') {
        const m = /^h([1-6])$/i.exec(el.tagName);
        line += ' (level ' + (m ? m[1] : el.getAttribute('aria-level') || '2') + ')';
      } else if (el.tagName === 'SELECT') {
        const opt = el.selectedOptions && el.selectedOptions[0];
        line += ' value="' + clean(opt ? opt.label : '', 80) + '"';
        const opts = Array.prototype.slice.call(el.options, 0, 12).map((o) => '"' + clean(o.label, 40) + '"');
        if (opts.length) line += ' options: [' + opts.join(', ') + ']';
      } else if (role === 'checkbox' || role === 'radio' || role === 'switch') {
        const checked = typeof el.checked === 'boolean' ? el.checked : el.getAttribute('aria-checked') === 'true';
        line += checked ? ' (checked)' : ' (unchecked)';
      } else if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || role === 'slider') {
        line += ' value="' + clean(el.value, 80) + '"';
      }
      if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') line += ' (disabled)';
      return line;
    };

    const lines = [];
    let chars = 0;
    let refCount = 0;
    let truncated = false;
    let belowFold = false;
    let lastText = '';

    const pushLine = (line) => {
      if (chars + line.length > MAX_CHARS) {
        truncated = true;
        return false;
      }
      lines.push(line);
      chars += line.length + 1;
      return true;
    };

    const walk = (parent, suppressText) => {
      if (truncated) return;
      for (const el of parent.children) {
        if (truncated) return;
        const tag = el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'svg') continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;
        let style;
        try { style = getComputedStyle(el); } catch (e) { continue; }
        if (!style || style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        const hasBox = rect.width > 0 && rect.height > 0;
        const inView = rect.top < vh && rect.bottom > 0;

        let included = false;
        if (hasBox && (isInteractive(el) || /^h[1-6]$/.test(tag))) {
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
          let t = '';
          for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
          t = clean(t, 120);
          if (t.length >= 2 && t !== lastText && pushLine('text: "' + t + '"')) lastText = t;
        }

        walk(el, suppressText || included);
      }
    };

    if (document.body) walk(document.body, false);

    const out = ['Page: ' + clean(document.title, 120) + ' — ' + location.href];
    for (const line of lines) out.push(line);
    if (belowFold) out.push('(page continues below the fold — scroll down to see more)');
    if (truncated) out.push('(snapshot truncated)');
    return { text: out.join('\n'), refCount, truncated };
  } catch (e) {
    return { text: 'Page: <snapshot failed: ' + (e && e.message) + '>', refCount: 0, truncated: false };
  }
}

export const SNAPSHOT_SOURCE = `(${buildSnapshot.toString()})()`;
