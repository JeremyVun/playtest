// Tiny hyperscript DOM helper — no framework (UX: "No component framework").
// h("div.klass#id", { onclick }, ...children). Children may be nodes, strings,
// arrays, or null (skipped). Attribute keys: on* → listeners, else attributes;
// `html` sets innerHTML (used only for our own trusted markup).

export function h(spec: WebDynamic, props: WebDynamic = null, ...children: WebDynamic): WebDynamic {
  const [tag, ...rest] = spec.split(/(?=[.#])/);
  const el = document.createElement(tag || "div");
  for (const token of rest) {
    if (token[0] === "#") el.id = token.slice(1);
    else if (token[0] === ".") el.classList.add(token.slice(1));
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") el.innerHTML = v;
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = !!v;
      else if (k === "class") el.className = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: WebDynamic, children: WebDynamic) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el: WebDynamic): WebDynamic => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

export const mount = (el: WebDynamic, ...children: WebDynamic): WebDynamic => {
  clear(el);
  append(el, children);
  return el;
};

/** Initials for an avatar. */
export const initials = (name: WebDynamic = "") =>
  (name.trim().split(/\s+/).map((w: WebDynamic) => w[0]).join("").slice(0, 2) || "?").toUpperCase();
