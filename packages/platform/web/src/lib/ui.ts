// Shared widgets (UX: "shared widgets live in packages/platform/web/src/lib/"). Toasts, a confirm
// modal, status chips using the exact core glyph legend + palette, a tiny sparkline,
// and empty/deferred states. Status glyphs and words come from core report.ts and
// are non-negotiable (word + color, never color alone — accessibility).
import { byId, h, mount, clear } from "./dom.js";
import { onPageLeave } from "./router.js";
import { nextRunLabel, nextRunGloss } from "./vocab.js";

// UX status glyph legend: ✓ pass · ✗ fail · ▲ changed · ◇ explored · ⚠ infra · ● running
// Exported because the Runs index renders glyph + count ("✗1") rather than
// glyph + word, and a second copy of this map is a second legend to keep true.
export const GLYPH: WebDynamic = { pass: "✓", fail: "✗", changed: "▲", explored: "◇", infra: "⚠", running: "●", neutral: "○" };

export function statusChip(status: WebDynamic, label: WebDynamic, title?: WebDynamic) {
  const s = status || "neutral";
  return h(`span.status.${s}`, title ? { title } : {}, h("span.glyph", {}, GLYPH[s] || "○"), label || s);
}

export function nextRunChip(next: WebDynamic) {
  const gloss = nextRunGloss(next);
  return h("span.nextrun", gloss ? { title: gloss } : {}, nextRunLabel(next));
}

/**
 * Text for assistive technology only. Anything encoded as colour, a shape, or a
 * `title` needs one of these beside it — `title` is unreachable by keyboard and
 * invisible on touch, so it can never be the only carrier of meaning.
 */
export const srOnly = (text: WebDynamic) => h("span.visually-hidden", {}, text);

export function tag(text: WebDynamic) {
  return h("span.chip.tag", {}, text);
}

export function toast(title: WebDynamic, body?: WebDynamic, kind: WebDynamic = "") {
  const root = byId("toasts");
  const el = h(`div.toast${kind ? "." + kind : ""}`, {}, h("div.t-title", {}, title), body ? h("div.t-body", {}, body) : null);
  root.append(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, kind === "err" ? 7000 : 3500);
}

/** Render an ApiError as a toast, expanding validation details. */
export function toastError(err: WebDynamic, fallback: WebDynamic = "Something went wrong") {
  const details = Array.isArray(err?.details)
    ? err.details.map((d: WebDynamic) => (d.path ? `${d.path}: ${d.message}` : d.message)).join("\n")
    : "";
  toast(err?.message || fallback, details, "err");
}

/**
 * The save bar for the two file editors (suite settings, story). Sticky at the
 * bottom of the scroll viewport and present only while there are unsaved
 * changes, so a clean page carries no buttons at all. The left side names the
 * state ("Unsaved changes", or why Save is disabled); the right side holds
 * Discard and Save. Call `set` whenever the draft or its validity moves.
 */
export function saveBar({ onSave, onDiscard, noun = "changes" }: WebDynamic) {
  const msg = h("span.savebar-msg", {}, "Unsaved changes");
  const saveBtn = h("button.btn.primary", { onclick: onSave }, "Save");
  const el = h("div.savebar", { role: "status", hidden: true },
    msg,
    h("div.savebar-actions", {},
      h("button.btn.ghost", { onclick: onDiscard }, `Discard ${noun}`),
      saveBtn,
    ),
  );
  return {
    el,
    set({ dirty, invalid = false, saving = false }: WebDynamic) {
      el.hidden = !dirty;
      saveBtn.disabled = invalid || saving;
      msg.textContent = invalid ? "Unsaved changes — fix the failing checks to save"
        : saving ? "Saving…"
        : "Unsaved changes";
      msg.classList.toggle("warn", invalid);
    },
  };
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The ONE dialog primitive. Every modal in the console goes through it, so the
 * keyboard contract is the same everywhere: Escape closes, Tab is trapped
 * inside the dialog, focus lands on the first control when it opens and returns
 * to whatever opened it when it closes.
 *
 * `close()` is the single exit path (buttons, scrim click, Escape) so the
 * keydown listener always gets removed — closing via a button used to leak it,
 * and a second stacked modal would then mis-close on the first Escape.
 *
 * @param {{ title: string, dismiss?: () => void, confirmDismiss?: () => boolean | Promise<boolean>,
 *           onClose?: () => void }} opts
 *   `dismiss` runs on Escape and scrim click (the "no decision" exit); omit for
 *   a plain close. `confirmDismiss` gates that exit for the rare dialog whose
 *   content cannot be recovered by reopening it — a false answer leaves the
 *   dialog exactly where it was. Every other modal passes neither and keeps the
 *   plain contract: Escape closes. `onClose` runs on EVERY exit — it is where a
 *   dialog that subscribed to something releases it.
 *
 *   Routing away is an exit too. A dialog can hold a router link (the launch
 *   dialog's "Set up a runner"), and the router only repaints #main — without
 *   the `onPageLeave` below, the new page would render UNDER a live scrim that
 *   swallows every click until the person guesses Escape. A navigation
 *   therefore takes the same exit Escape does, `confirmDismiss` and all.
 * @param {(close: () => void) => Node} build the dialog body
 */
function openModal({ title, dismiss, confirmDismiss, onClose }: WebDynamic, build: WebDynamic) {
  const root = byId("modal-root");
  // Whatever had focus opens the dialog and gets it back — losing your place in
  // a table because you opened and cancelled a dialog is a keyboard dead end.
  const opener: WebDynamic = document.activeElement;
  let closed = false;
  let unregisterLeave = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    unregisterLeave();
    onClose?.();
    clear(root);
    document.removeEventListener("keydown", onKey, true);
    // The opener may have been re-rendered away by a repaint; only restore when
    // it is still on the page.
    if (opener?.isConnected) opener.focus?.();
  };
  const bail = async () => {
    if (closed) return;
    if (confirmDismiss && !(await confirmDismiss())) return;
    dismiss?.();
    close();
  };

  const dialog = h("div.modal", { role: "dialog", "aria-modal": "true", "aria-label": title },
    h("h2.modal-title", {}, title));
  const scrim = h("div.modal-scrim", { onclick: (e: WebDynamic) => { if (e.target === scrim) bail(); } }, dialog);

  function onKey(e: WebDynamic) {
    if (!scrim.isConnected) return;
    if (e.key === "Escape") {
      e.preventDefault();
      void bail();
      return;
    }
    if (e.key !== "Tab") return;
    const items: WebDynamic = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  dialog.append(build(close));
  mount(root, scrim);
  document.addEventListener("keydown", onKey, true);
  // Leave by `bail`, not `close`, so a dialog holding something unrecoverable
  // still gets its say: the credential reveal asks "copy it first?" instead of
  // letting a stray link silently destroy a one-time secret. `bail` is async
  // only when there is a `confirmDismiss`; without one it clears the root
  // synchronously, before the router paints the next page. With one, the answer
  // arrives a microtask late, so the dialog stays up over the page that has
  // already been painted — deliberate: a dialog that cannot be reopened is
  // worth more than a tidy transition, and the guard's own buttons ("Copy it
  // first" / "Close anyway") are the way out. `close` is idempotent, so a
  // dialog dismissed the ordinary way leaves a cleanup that no-ops.
  unregisterLeave = onPageLeave(bail);
  // Autofocus the first real control (a field, if the dialog has one) rather
  // than leaving focus behind on the page under the scrim.
  const target = dialog.querySelector("input:not([type=hidden]):not([disabled]), textarea:not([disabled]), .select-btn:not([disabled])")
    || dialog.querySelector(FOCUSABLE);
  target?.focus?.();
  return close;
}

/** A promise-returning confirm dialog. */
export function confirmModal({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }: WebDynamic) {
  return new Promise((resolve) => {
    // A confirm has no fields, so openModal's autofocus lands on the first
    // focusable — Cancel, deliberately ordered before the action. An Enter
    // keypress still in flight must never be the thing that destroys something.
    openModal({ title, dismiss: () => resolve(false) }, (done: WebDynamic) =>
      h("div", {},
        typeof body === "string" ? h("p.dim", {}, body) : body,
        h("div.modal-actions", {},
          h("button.btn.ghost", { onclick: () => { resolve(false); done(); } }, cancelLabel),
          h(`button.btn.primary${danger ? ".danger" : ""}`, { onclick: () => { resolve(true); done(); } }, confirmLabel),
        ),
      ));
  });
}

/**
 * A modal that hosts an arbitrary form; `render(close)` builds the body.
 * `opts.confirmDismiss` is the one-time-secret escape hatch described on
 * `openModal`; omitting it (which every other call site does) keeps the plain
 * Escape-closes contract.
 */
export function formModal(title: WebDynamic, render: WebDynamic, opts: WebDynamic = {}) {
  return openModal({ title, ...opts }, (close: WebDynamic) => render(close));
}

/**
 * Shared open/close mechanics for a popup anchored to a button. The caller
 * owns the popup's contents and arrow-key behavior; this controller owns the
 * cross-widget contract: toggle, outside click, Escape, focus restoration,
 * navigation teardown, and `aria-expanded`.
 */
function anchoredPopup({ wrap, button, build, focus, closeOnTab = false }: WebDynamic) {
  let popup: WebDynamic = null;
  let unregisterLeave = () => {};
  const away = (e: WebDynamic) => {
    if (!wrap.contains(e.target)) close();
  };
  function close(focusBack = false) {
    if (!popup) return;
    popup.remove();
    popup = null;
    unregisterLeave();
    unregisterLeave = () => {};
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", away, true);
    if (focusBack) button.focus();
  }
  function open() {
    if (popup) {
      close(true);
      return;
    }
    popup = build(close);
    popup.addEventListener("keydown", (e: WebDynamic) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      } else if (closeOnTab && e.key === "Tab") {
        close();
      }
    });
    wrap.append(popup);
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", away, true);
    unregisterLeave = onPageLeave(close);
    focus?.(popup);
  }
  return { close, open };
}

/**
 * Progressive enhancement over a native <select>. The native element stays the
 * single source of truth — call sites keep reading `sel.value` and their
 * onchange handlers keep firing — but the popup the person sees is ours:
 * native popups (macOS Liquid Glass) fight the theme and can't be styled.
 * The select is hidden inside the returned wrapper; the button mirrors the
 * selected option, and the listbox rebuilds from the live options on every
 * open, so dynamically re-mounted options (the launch modal's rings)
 * just work. Programmatic value changes must dispatch a "change" event.
 */
export function enhanceSelect(sel: WebDynamic) {
  const btn = h("button.select-btn", { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" });
  const wrap = h("span.selectw", {}, sel, btn);
  const syncBtn = () => {
    btn.textContent = "";
    btn.append(
      h("span.select-val", {}, sel.selectedOptions[0]?.textContent ?? ""),
      h("span.select-caret", { "aria-hidden": "true" }, "▾"),
    );
    btn.disabled = sel.disabled;
  };
  syncBtn();
  new MutationObserver(syncBtn).observe(sel, { childList: true, subtree: true, attributes: true });
  sel.addEventListener("change", syncBtn);

  let items: WebDynamic = [];
  const popup = anchoredPopup({
    wrap,
    button: btn,
    closeOnTab: true,
    build: (close: WebDynamic) => {
      const opts: WebDynamic = Array.from(sel.options);
      items = opts.map((o: WebDynamic, i: WebDynamic) =>
        h(`button.select-opt${i === sel.selectedIndex ? ".on" : ""}`, {
          type: "button",
          role: "option",
          "aria-selected": i === sel.selectedIndex ? "true" : "false",
          disabled: o.disabled || undefined,
          onclick: () => {
            close(true);
            if (i === sel.selectedIndex) return;
            sel.selectedIndex = i;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
          },
        }, o.textContent));
      return h("div.select-menu", {
      role: "listbox",
      onkeydown: (e: WebDynamic) => {
        const live = items.filter((el: WebDynamic) => !el.disabled);
        const at = live.indexOf(document.activeElement);
        if (e.key === "ArrowDown") { e.preventDefault(); live[Math.min(at + 1, live.length - 1)]?.focus(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); live[Math.max(at - 1, 0)]?.focus(); }
        else if (e.key === "Home") { e.preventDefault(); live[0]?.focus(); }
        else if (e.key === "End") { e.preventDefault(); live.at(-1)?.focus(); }
      },
    }, ...items);
    },
    focus: () => (items[sel.selectedIndex] || items[0])?.focus(),
  });
  btn.addEventListener("click", popup.open);
  btn.addEventListener("keydown", (e: WebDynamic) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); popup.open(); }
  });
  return wrap;
}

/** Field-helper shim: selects get the themed dropdown, everything else passes through. */
export function asControl(input: WebDynamic) {
  return input.tagName === "SELECT" ? enhanceSelect(input) : input;
}

// The one labeled-field builder (pages used to each carry a copy). Selects are
// auto-enhanced; the label's `for` points at the visible control (a11y — the
// tool scores other apps on exactly this), generated when it has no id yet.
let fieldSeq = 0;
export function formField(label: WebDynamic, input: WebDynamic, hint?: WebDynamic) {
  const control = asControl(input);
  const target = control === input ? input : control.querySelector("button");
  if (!target.id) target.id = `field-${++fieldSeq}`;
  return h("div.field", {}, h("label", { for: target.id }, label), control, hint ? h("div.hint", {}, hint) : null);
}

/** Copy text to the clipboard; resolves false when the browser refuses. */
export async function copyText(text: WebDynamic) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to the selection trick.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function emptyState(title: WebDynamic, body: WebDynamic, action?: WebDynamic) {
  return h("div.empty", {}, h("h3", {}, title), h("p", {}, body), action || null);
}

/**
 * A page-level load failure (UX principle 5: degrade loudly, never silently).
 * Mount this where the content would go — never strand the user on "Loading…".
 * `retry` re-runs the page's loader.
 */
export function errorState(err: WebDynamic, retry?: WebDynamic) {
  return h("div.empty", {},
    h("h3", {}, "Couldn't load this"),
    h("p", {}, err?.message || "The server didn't respond."),
    retry ? h("button.btn", { onclick: retry }, "Try again") : null,
  );
}

export function deferred(text: WebDynamic) {
  return h("div.deferred", {}, text);
}

/**
 * A ⋯/More overflow menu (same look as the themed dropdown) for rare or
 * secondary actions. `items` are `{ label, onclick, danger?, disabled?, title? }`.
 * Keyboard- and pointer-dismissable; the menu closes before running an action.
 */
export function overflowMenu(items: WebDynamic, { label = "⋯", title = "More actions", className = "" }: WebDynamic = {}) {
  const wrap = h("span.selectw", { style: "width:auto" });
  const btn = h(`button.btn${className}`, { "aria-haspopup": "menu", "aria-expanded": "false", title }, label);
  const popup = anchoredPopup({
    wrap,
    button: btn,
    build: (close: WebDynamic) => h("div.select-menu.overflow-menu", {
      role: "menu",
    }, ...items.filter(Boolean).map((it: WebDynamic) =>
      h(`button.select-opt${it.danger ? ".danger" : ""}`, {
        type: "button", role: "menuitem", disabled: it.disabled || undefined, title: it.title || undefined,
        onclick: () => { close(); it.onclick(); },
      }, it.label))),
    focus: (menu: WebDynamic) => menu.querySelector("button:not([disabled])")?.focus(),
  });
  btn.addEventListener("click", popup.open);
  wrap.append(btn);
  return wrap;
}

/** A minimal inline sparkline (values 0..100), matching the viewer's quiet tone. */
export function sparkline(values: WebDynamic, { w = 66, hgt = 18 }: WebDynamic = {}) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("width", w); svg.setAttribute("height", hgt); svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  if (!values.length) return svg;
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const range = max - min || 1;
  const pts = values.map((v: WebDynamic, i: WebDynamic) => {
    const x = values.length === 1 ? w / 2 : (i / (values.length - 1)) * (w - 2) + 1;
    const y = hgt - 2 - ((v - min) / range) * (hgt - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const poly = document.createElementNS(ns, "polyline");
  poly.setAttribute("points", pts.join(" "));
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", "var(--accent)");
  poly.setAttribute("stroke-width", "1.5");
  svg.append(poly);
  return svg;
}
