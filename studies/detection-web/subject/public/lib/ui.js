// Shared interface pieces: banners, form fields, status pills, empty states.

import { el } from "./dom.js";

export function banner(tone, message) {
  return el("p", {
    class: `banner banner--${tone}`,
    role: tone === "error" ? "alert" : "status",
    text: message,
  });
}

export function pending(message) {
  return el("p", { class: "pending", role: "status", text: message });
}

export function statusPill(loan) {
  const key = loan.overdue ? "overdue" : loan.status;
  return el("span", { class: `pill pill--${key}`, text: loan.statusLabel });
}

export function emptyState(title, message, action) {
  return el("div", { class: "empty" }, [
    el("h3", { text: title }),
    el("p", { text: message }),
    action || null,
  ]);
}

/** A labelled control with a hint slot and a live error slot. */
export function field(id, labelText, control, hint) {
  const describedBy = [];
  if (hint) describedBy.push(`${id}-hint`);
  describedBy.push(`${id}-error`);
  control.setAttribute("aria-describedby", describedBy.join(" "));
  return el("div", { class: "field" }, [
    el("label", { for: id, text: labelText }),
    hint ? el("p", { class: "field__hint", id: `${id}-hint`, text: hint }) : null,
    control,
    errorSlot(id),
  ]);
}

/** The error slot for a grouped control (radios, item list). */
export function errorSlot(id) {
  return el("p", { class: "field-error", id: `${id}-error`, hidden: true });
}

/**
 * Paint validation messages onto a form and move focus to the first problem.
 * Fields with no message are cleared.
 */
export function applyErrors(root, errors, fieldIds) {
  let firstBad = null;
  for (const id of fieldIds) {
    const slot = root.querySelector(`#${id}-error`);
    const control = root.querySelector(`#${id}`);
    const message = errors[id];
    if (slot) {
      slot.textContent = message || "";
      slot.hidden = !message;
    }
    if (control) {
      if (message) control.setAttribute("aria-invalid", "true");
      else control.removeAttribute("aria-invalid");
    }
    if (message && !firstBad) firstBad = control || slot;
  }
  if (firstBad && typeof firstBad.focus === "function") firstBad.focus();
  return Boolean(firstBad);
}

/** Runs an async action with a visible pending state on its button. */
export async function runAction(button, pendingLabel, statusHost, statusText, work) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = pendingLabel;
  const note = pending(statusText);
  if (statusHost) statusHost.appendChild(note);
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.textContent = original;
    note.remove();
  }
}

export function summaryList(rows) {
  const node = el("dl", { class: "summary-list" });
  for (const [term, value] of rows) {
    if (value === null || value === undefined) continue;
    node.appendChild(el("dt", { text: term }));
    node.appendChild(el("dd", {}, [value]));
  }
  return node;
}

export function pageHead(title, subtitle, actions) {
  return el("div", { class: "page-head" }, [
    el("div", {}, [el("h1", { text: title }), subtitle ? el("p", { text: subtitle }) : null]),
    actions ? el("div", { class: "button-row", style: "margin-top:0" }, actions) : null,
  ]);
}
