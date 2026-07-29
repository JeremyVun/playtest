// Tiny hyperscript DOM helper — no framework (UX: "No component framework").
// h("div.klass#id", { onclick }, ...children). Children may be nodes, strings,
// arrays, or null (skipped). Attribute keys: on* → listeners, else attributes;
// `html` sets innerHTML (used only for our own trusted markup).

/** A required application mount point, with the null check kept in one place. */
export function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required #${id} element`);
  return element;
}

export function h(spec: string, props: Record<string, unknown> | null = null, ...children: unknown[]): WebDynamic {
  const [tag, ...rest] = spec.split(/(?=[.#])/);
  const el = document.createElement(tag || "div");
  for (const token of rest) {
    if (token[0] === "#") el.id = token.slice(1);
    else if (token[0] === ".") el.classList.add(token.slice(1));
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === "html") {
        el.innerHTML = String(v);
      } else if (k === "value" && "value" in el) {
        (el as HTMLInputElement).value = String(v);
      } else if (k === "checked" && el instanceof HTMLInputElement) {
        el.checked = Boolean(v);
      } else if (k === "class") {
        el.className = String(v);
      }
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Element, children: unknown[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el: Element): Element => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

export const mount = (el: Element, ...children: unknown[]): void => {
  clear(el);
  append(el, children);
};

/** Initials for an avatar. */
export const initials = (name = "") =>
  (name.trim().split(/\s+/).map((word) => word[0]).join("").slice(0, 2) || "?").toUpperCase();
