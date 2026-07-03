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

export const SNAPSHOT_FORMAT = "ax-tree-v1";

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

const TYPABLE = new Set(["textfield", "securetextfield", "searchfield"]);

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

// The accessibility id a locator can target: name (iOS) / content-desc /
// resource-id (Android).
function aidOf(attrs) {
  return attrs.name || attrs["content-desc"] || attrs["resource-id"] || "";
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
  if (aid && aidIsUnique) return `~${aid}`;
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
  const aidCounts = new Map();
  try {
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(String(xml ?? "")))) {
      const [, closing, tag, attrBlob] = m;
      if (closing) continue;
      const attrs = parseAttrs(attrBlob);
      const tagPos = (tagSeq.get(tag) ?? 0) + 1;
      tagSeq.set(tag, tagPos);
      const aid = aidOf(attrs);
      if (aid) aidCounts.set(aid, (aidCounts.get(aid) ?? 0) + 1);
      nodes.push({ tag, attrs, tagPos });
    }
  } catch {
    // never throw: a malformed source degrades to whatever was parsed so far
  }

  // Pass 2: the [eN] text + element list for the visible, interactable nodes.
  const elements = [];
  const lines = [];
  let title = "";
  let truncated = false;
  for (const { tag, attrs, tagPos } of nodes) {
    if (/Application$|Window$/.test(tag) && !title) title = nameOf(attrs) || title;
    if (!isVisible(attrs)) continue;

    const role = roleOf(tag, attrs);
    const name = nameOf(attrs);
    const value = (attrs.value ?? "").replace(/\s+/g, " ").trim();
    if (role === "text" && name) {
      lines.push(`text: ${JSON.stringify(name)}`);
      continue;
    }
    if (!["button", "textfield", "searchfield", "switch", "cell", "link"].includes(role)) continue;
    if (elements.length >= max) {
      truncated = true;
      break;
    }
    const aid = aidOf(attrs);
    const ref = `e${elements.length + 1}`;
    const typable = TYPABLE.has(role);
    const el = {
      ref, role, name, value,
      locator: durableLocator(tag, attrs, tagPos, aid !== "" && aidCounts.get(aid) === 1),
      bbox: bboxOf(attrs),
      typable,
    };
    elements.push(el);

    let line = `[${ref}] ${role} ${JSON.stringify(name)}`;
    if (typable) line += ` value=${JSON.stringify(value)}`;
    else if (role === "switch" && value) line += ` (${value})`;
    lines.push(line);
  }

  const header = `Screen: ${title || "(app)"}`;
  return { text: [header, ...lines].join("\n"), title, elements, refCount: elements.length, truncated };
}
