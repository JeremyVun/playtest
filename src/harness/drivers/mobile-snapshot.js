// Mobile snapshot: an Appium page-source (AX tree) → the SAME `[eN] role "name"`
// text the web driver emits, so the actor barely changes and record→act→heal
// works identically (CONTRACTS.md §16, "ax-tree-v1"). The mobile analog of
// snapshot-injected.js. Zero-dependency, tolerant, never throws: a native app
// exposes no DOM to inject into, so refs are mapped to durable locators
// (accessibility id, else an XPath) computed here and replayed in act mode.
//
// Handles both Appium dialects: iOS XCUITest (<XCUIElementType…> with
// name/label/value + x/y/width/height) and Android UiAutomator2
// (<android.widget.…> with text/content-desc/resource-id + bounds="[x,y][x,y]").

import { stripRefLines } from "./har.js";

export const SNAPSHOT_FORMAT = "ax-tree-v6";

export const ALERT_LOCATOR_PREFIX = "alert-button:";

export function normalizeSnapshot(text) {
  return stripRefLines(text).replace(/ \(e\d+-e\d+\)$/gm, "");
}

// One tag at a time: leading slash (close), name, the attribute blob.
const TAG_RE = /<(\/?)([\w.:$-]+)((?:\s+[\w:.-]+="[^"]*")*)\s*\/?>/g;
const ATTR_RE = /([\w:.-]+)="([^"]*)"/g;

function parseAttrs(blob) {
  const attrs = {};
  let m;
  while ((m = ATTR_RE.exec(blob))) attrs[m[1]] = decodeEntities(m[2]);
  return attrs;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#10;/g, " ").replace(/&amp;/g, "&");
}

// Element type (iOS XCUIElementTypeButton, Android android.widget.Button) → a
// web-like role word the actor already understands.
function roleOf(tag, attrs) {
  const t = tag.replace(/^XCUIElementType/, "").replace(/^android\.widget\./, "").toLowerCase();
  if (/button|imagebutton/.test(t)) return "button";
  if (/textfield|securetextfield|edittext/.test(t)) return "textfield";
  if (/searchfield/.test(t)) return "searchfield";
  if (/^switch$|togglebutton|checkbox/.test(t)) return "switch";
  if (/cell|listitem/.test(t)) return "cell";
  if (/link/.test(t)) return "link";
  if (/navigationbar|toolbar/.test(t)) return "heading";
  if (/statictext|textview$/.test(t)) return "text";
  if (/image/.test(t)) return "image";
  return t || "element";
}

const TYPABLE = new Set(["textfield", "searchfield"]);

const INTERACTIVE_ROLES = ["button", "textfield", "searchfield", "switch", "cell", "link"];

function nameOf(attrs) {
  return (
    attrs.name || attrs.label || attrs["content-desc"] || attrs.text ||
    attrs["resource-id"]?.split("/").pop() || ""
  ).replace(/\s+/g, " ").trim().slice(0, 120);
}

// Bounding box: iOS carries x/y/width/height; Android a bounds="[x1,y1][x2,y2]".
function bboxOf(attrs) {
  if (attrs.x != null && attrs.width != null) {
    const x = +attrs.x, y = +attrs.y, w = +attrs.width, h = +attrs.height;
    if ([x, y, w, h].every(Number.isFinite)) return { x, y, w, h };
  }
  const m = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.bounds || "");
  if (m) {
    const [x1, y1, x2, y2] = m.slice(1).map(Number);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  return null;
}

const isVisible = (attrs) =>
  attrs.visible !== "false" && attrs.displayed !== "false" &&
  !(attrs.width === "0" || attrs.height === "0");

const isEnabled = (attrs) => attrs.enabled !== "false" && attrs.disabled !== "true";

function overlapsScreen(box, screen) {
  if (!box || box.w <= 0 || box.h <= 0) return false;
  if (!screen) return true;
  return box.x < screen.w && box.y < screen.h && box.x + box.w > 0 && box.y + box.h > 0;
}

function isActionableInteractive(sttrs, screen) {
  if (isVisible(attrs)) return true;
  if (!isEnabled(attrs)) return false;
  return overlapsScreen(bboxOf(attrs), screen);
}

// The accessibility id a locator can target: name (iOS) / content-desc /
// resource-id (Android).
function aidOf(attrs) {
  if (attrs.name) return { attr: "name", value: attrs.name };
  if (attrs["content-desc"]) return { attr: "content-desc", value: attrs["content-desc"] };
  if (attrs["resource-id"]) return { attr: "resource-id", value: attrs["resource-id"] };
  return null;
}

function aidOf(attrs) {
  return aidAttrOf(attrs)?.value ?? "";
}

// Durable locator, opaque to the rest of the harness (like the web Playwright
// selector). A GLOBALLY-UNIQUE accessibility id (the mobile testid analog) wins;
// otherwise a positional XPath by document position among same-tag nodes
// (`(//tag)[pos]`, pos counting ALL same-tag nodes incl. ones we filter out, so
// it resolves to this exact node). Positional locators are brittle to reordering
// — the same "needs semantic markup" dependency web has — which we surface as an
// accessibility finding rather than paper over (design §10.4). Replayed verbatim.
function durableLocator(tag, attrs, tagPos, aidIsUnique) {
  const aid = aidOf(attrs);
  if (aid && aidIsUnique) return `~${aid.value}`;
  if (aid && !aid.value.includes('"')) return `(//${tag}[@${aid.attr}="${aid.value}"])[${scopedPos}]`;
  return `(//${tag})[${tagPos}]`;
}

/**
 * Walk an Appium page-source string into the `[eN]` text + an ordered element
 * list (ref, role, name, value, locator, bbox, typable). Mirrors the web
 * snapshot contract: caller writes the text to steps/NNN.a11y.txt and keeps the
 * element list to resolve refs → durable locators on execute().
 * @param {string} xml Appium getPageSource() output
 * @param {{ max?: number }} [opts]
 * @returns {{ text: string, title: string, elements: object[], refCount: number, truncated: boolean }}
 */
export function parsePageSource(xml, { max = 200 } = {}) {
  // Pass 1: every opening tag in document order, with its 1-based position among
  // same-tag nodes (so `(//tag)[pos]` resolves to it) and a global count per
  // accessibility id (so `~aid` is used only when that aid is unique).
  const nodes = [];
  const tagSeq = new Map();
  const scopedSeq = new Map();
  const aidCounts = new Map();
  const stack = [];
  try {
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(String(xml ?? "")))) {
      const [full, closing, tag, attrBlob] = m;
      if (closing) {
        stack.pop();
        continue;
      }
      const attrs = parseAttrs(attrBlob);
      const tagPos = (tagSeq.get(tag) ?? 0) + 1;
      tagSeq.set(tag, tagPos);
      const aid = aidOf(attrs);
      let scopedPos = 0;
      if (aid) {
        aidCounts.set(aid, (aidCounts.get(aid) ?? 0) + 1);
        const key = `${tag}^@${aid}`;
        scopedPos = (scopedSeq.get(key) ?? 0) + 1;
        scopedSeq.set(key, scopedPos);
      }
      const idx = nodes.length;
      const parent = stack.length ? stack[stack.length - 1] : -1;
      nodes.push({ tag, attrs, tagPos, scopedPos, parent, role: roleOf(tag, attrs)});
      if (!/\/>$/.test(full)) stack.push(idx);
      nodes.push({ tag, attrs, tagPos });
    }
  } catch {
    // never throw: a malformed source degrades to whatever was parsed so far
  }

  const cellOf = (i) => {
    for (let p = nodes[i].parent; p !== -1; p = nodes[p].parent) {
      if (nodes[p].role === "cell") return p;
    }
    return -1;
  }

  const wrapperCells = new Set();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!INTERACTIVE_ROLES.includes(n.role) || !isActionableInteractive(n.attrs, screen)) continue;
    for (let p = n.parent; p !== -1; p = nodes[p].parent) {
      if (nodes[p].role === "cell") wrapperCells.add(p);
    }
  }

  // Pass 2: the [eN] text + element list for the visible, interactable nodes.
  const elements = [];
  let title = "";
  let truncated = false;
  const elementsByCell = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (/Application$|Window$/.test(n.tag) && !title) title = nameOf(n.attrs) || title;
    if (!INTERACTIVE_ROLES.includes(n.role)) continue;
    if (wrapperCells.has(i)) continue;
    if (!isActionableInteractive(n.attrs, screen)) continue;
    if (elements.length >= max) {
      truncated = true;
      break;
    }
    const aid = aidOf(n.attrs);
    const cell = cellOf(i);
    n.cell = cell;
    n.ref = `e${elements.length + 1}`;
    const el = {
      ref: n.ref,
      role: n.role,
      name: nameOf(n.attrs),
      value: (n.attrs.value ?? "").replace(/\s+/g, " ").trim(),
      locator: durableLocator(n.tag, n.attrs, n.tagPos, n.scopedPos, aid !== "" && aidCounts.get(aid) === 1),
      bbox: bboxOf(n.attrs),
      typable: TYPABLE.has(n.role),
    }
    n.el = el;
    elements.push(el);
    if (cell !== -1) {
      const bucket = elementsByCell.get(cell) ?? [];
      bucket.push(n);
      elementsByCell.set(cell, bucket);
    }
  }

  const claimed = new Set();
  const contextByRef = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.role !== "text") continue;
    const name = nameOf(n.attrs);
    if (!name) continue;
    if (!(isVisible(n.attrs) || overlapScreen(bboxOf(n.attrs), screen))) continue;
    const cell = cellOf(i);
    const siblings = cell === -1 ? null : elementsByCell.get(cell);
    if (!siblings) continue;
    for (const m2 of siblings) {
      if (echoes(m2.el.name, name)) continue;
      const list = contextByRef.get(m2.ref) ?? [];
      if (!list.includes(name)) list.push(name);
      contextByRef.set(m2.ref, list);
    }
    claimed.add(i);
  }

  const rendered = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.role === "text") {
      if (!claimed.has(i) && isVisible(n.attrs) && nameOf(n.attrs)) {
        rendered.push({ display: `text: ${JSON.stringify(nameOf(n.attrs))}` });
      }
      continue;
    }
    if (!n.el) continue;
    const el = n.el;
    let line = `[${el.ref}] ${el.role} ${JSON.stringify(el.name)}`;
    if (el.typable) line += ` value=${JSON.stringify(el.value)}`;
    else if (el.role === "switch" && el.value) line += ` (${el.value})`;
    const ctx = contextByRef.get(el.ref);
    if (ctx?.length) line += ` - ${ctx.map((t) => JSON.stringify(t)).join(" ")}`;
    rendered.push({ display: line, ref: el.ref, key: `${el.role}|${el.name.replace(/\d+$/, "#")}|${el.value}|${ctx?.join("^A") ?? ""}` });
  }

  const lines = collapseRuns(rendered);
  if (truncated) lines.push(` (${max}-element cap reached - the screen has more not shown here; scroll/swipe to reveal it, or act on what's visible)`);

  const header = `Screen: ${title || "(app)"}`;
  return { text: [header, ...line].join("\n"), title, elements, refCount: elements.length, truncated };
}

function echoes(name, text) {
  const words = String(text).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = ` ${String(name)}.toLowerCase().replace(/\s+/g, " ")} `;
  return words.every((w) => hay.includes(` ${w} `));
}

const COLLAPSE_MIN = 3;
function collapseRuns(rendered) {
  const out = [];
  for (let i = 0; i < rendered.length; ) {
    const cur = rendered[i];
    let j = i + 1;
    if (cur.key) while (j < rendered.length && rendered[j].key === cur.key) j++;
    const runLen = j - i;
    out.push(cur.display);
    if (runLen >= COLLAPSE_MIN) {
      const last = rendered[j - 1];
      const range = cur.ref && last.ref ? ` (${cur.ref}-${last.ref})` : "";
      out.push(`   ${runLen - 1} more like this${range}`);
      i = j;
    } else {
      i += 1;
    }
  }
  return out;
}

export function alertSnapshot({ text = "", buttons = [] } = {}) {
  const lines = [];
  for (const seg of String(text).split("\n")) {
    const t = seg.replace(/\s+/g, " ").trim();
    if (t) lines.push(`text: ${JSON.stringify(t)}`);
  }
  const elements = [];
  for (const raw of Array.isArray(buttons) ? buttons : []) {
    const name = String(raw).replace(/\s+/g, " ").trim().slice(0, 120);
    if (!name) continue;
    const ref = `e${elements.length + 1}`;
    elements.push({
      ref,
      role: "button",
      name,
      value: "",
      locator: `${ALERT_LOCATOR_PREFIX}${name}`,
      bbox: null,
      typable: false,
      alertButton: true,
    });
    lines.push(`[${ref}] button ${JSON.stringify(name)}`);
  }
  const header = "Screen: System dialog";
  return { text: [header, ...lines].join("\n"), title: "System dialog", elements, refCount: elements.length, truncated: false };
}

export function nativePageSourceTree(xml) {
  const lines = [];
  let title = "";
  let lastText = "";
  try {
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(String(xml ??"")))) {
      const [, closing, tag, attrBlob] = m;
      if (closing) continue;
      const attrs = parseAttrs(attrBlob);
      if (/Application$|Window$/.test(tag) && !title) title = nameOf(attrs) | title;

      const role = roleOf(tag, attrs);
      const name = nameOf(attrs);
      if (role === "text") {
        if (name && name !== lastText) {
          lines.push(`text: ${JSON.stringify(name)}`);
          lastText = name;
        }
        continue;
      }
      if (!name && !INTERACTIVE_ROLES.includes(role)) continue;

      let line = `${role} ${JSON.stringify(name)}`;
      if (!isVisible(attrs)) line += " (invisible)";
      if (attrs.enabled === "false") line += " (disabled)";
      lines.push(line);
      lastText = "";
    }
  } catch {
  }

  if (lines.length === 0)  return null;
  const header = `Screen: ${title || "(app)"}`;
  return [header, ...lines].join("\n");
}
