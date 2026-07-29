// Mobile snapshot: an Appium page-source (AX tree) → the SAME `[eN] role "name"`
// text the web driver emits, so the actor barely changes and record→act→heal
// works identically (docs/contracts/engine.md#mobile-driver). The mobile analog of
// snapshot-injected.ts. Zero-dependency, tolerant, never throws: a native app
// exposes no DOM to inject into, so refs are mapped to durable locators
// (accessibility id, else an XPath) computed here and replayed in act mode.
//
// Handles both Appium dialects: iOS XCUITest (<XCUIElementType…> with
// name/label/value + x/y/width/height) and Android UiAutomator2
// (<android.widget.…> with text/content-desc/resource-id + bounds="[x,y][x,y]").

import { stripRefLines } from "./har.ts";

type MobileAttrs = Record<string, string>;

export interface MobileBoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MobileSnapshotElement {
  ref: string;
  role: string;
  name: string;
  value: string;
  locator: string;
  bbox: MobileBoundingBox | null;
  typable: boolean;
  alertButton?: boolean;
}

export interface MobileSnapshot {
  text: string;
  title: string;
  elements: MobileSnapshotElement[];
  refCount: number;
  truncated: boolean;
}

/**
 * One opening tag of a page source, as the shared walk records it. IMMUTABLE
 * once walked: both projections read it and neither writes to it, so one walk
 * can feed the agent snapshot and the debug native tree (and be handed across a
 * settle→capture reuse) without either seeing the other's bookkeeping.
 */
export interface MobileNode {
  tag: string;
  attrs: MobileAttrs;
  tagPos: number;
  scopedPos: number;
  parent: number;
  role: string;
}

/**
 * One walk of a page source: every opening tag in document order, plus the
 * global count per accessibility id (`~aid` is only durable when unique).
 * Produced once by `walkPageSource()` and shared by every projection.
 */
export interface MobilePageSourceWalk {
  nodes: MobileNode[];
  aidCounts: Map<string, number>;
}

/** A node the custom walk surfaced as an `[eN]` element, with that element. */
interface SurfacedMobileNode {
  index: number;
  el: MobileSnapshotElement;
}

interface RenderedLine {
  display: string;
  ref?: string;
  key?: string;
}

type IndexedArray<T> = T[] & Record<number, T>;

// v7: an element renders its HUMAN-READABLE name (iOS `label` over the `name`
// identifier, see nameOf) and any non-empty accessibility value, for every role
// rather than switches alone. Rendered text is the drift/comparability surface,
// so both changes move the pin. Mirrored in trajectory.ts SNAPSHOT_FORMATS.mobile.
export const SNAPSHOT_FORMAT = "ax-tree-v7";

// System-alert locator prefix. An iOS permission/system alert is drawn by
// SpringBoard (a SEPARATE process), so the app session's getPageSource() returns
// only the dimmed app screen behind it — the alert's buttons never appear in the
// page source (custom OR native tree). We surface them from Appium's dedicated
// alert API instead, and tag each button's locator with this prefix so the driver
// routes a tap through `mobile: alert` (accept/dismiss) rather than element
// resolution — the alert has no queryable locator to resolve. Opaque to the rest
// of the harness, like the web Playwright selector and the `~aid`/XPath locators.
export const ALERT_LOCATOR_PREFIX = "alert-button:";

/**
 * Drift comparison surface (docs/contracts/engine.md#act-and-heal): strip the
 * volatile `[eN]` ref prefix (refs
 * renumber every snapshot — not behavioral) and collapse per-line whitespace,
 * dropping blank lines. Shares the web driver's stripRefLines: the AX text has
 * the same `[eN] role "name"` shape. On top of that we drop the ref RANGE a
 * run-collapse continuation carries (`… N more like this (e4-e15)` → `… N more
 * like this`) — those refs renumber too, so they must not read as drift or defeat
 * the `repeated_action` same-state check. Pure; exported for test.
 */
export function normalizeSnapshot(text: unknown): string {
  return stripRefLines(text).replace(/ \(e\d+-e\d+\)$/gm, "");
}

// One tag at a time: leading slash (close), name, the attribute blob.
const TAG_RE = /<(\/?)([\w.:$-]+)((?:\s+[\w:.-]+="[^"]*")*)\s*\/?>/g;
const ATTR_RE = /([\w:.-]+)="([^"]*)"/g;

function parseAttrs(blob: string): MobileAttrs {
  const attrs: MobileAttrs = {};
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(blob))) attrs[m[1] as string] = decodeEntities(m[2] as string);
  return attrs;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#10;/g, " ").replace(/&amp;/g, "&");
}

// Element type (iOS XCUIElementTypeButton, Android android.widget.Button) → a
// web-like role word the actor already understands.
function roleOf(tag: string): string {
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

// roleOf normalizes secure fields to "textfield", so no "securetextfield" role
// ever reaches this set.
const TYPABLE = new Set(["textfield", "searchfield"]);

// The roles the custom snapshot keeps as [eN] interactive elements. Shared by the
// custom walk (parsePageSource) and the debug native walk (nativePageSourceTree)
// so "interactive" means the same thing on both sides of the viewer diff.
const INTERACTIVE_ROLES = ["button", "textfield", "searchfield", "switch", "cell", "link"];

// The RENDERED name: what the actor reads, so it must be the HUMAN-READABLE
// text. On iOS/XCUITest `name` is the accessibility IDENTIFIER whenever the app
// sets one (`label` is the human string), so preferring `name` made every
// identifier-annotated app render testids — `button "todo-row-1"` instead of
// `button "Buy milk"`, the mobile equivalent of showing data-testid as the web
// accessible name. `label` therefore wins, with `name` the fallback for the
// unlabelled case (an iOS TextField reports label="" and only the identifier).
// Android page source carries neither attribute, so its content-desc/text/
// resource-id path is untouched. The identifier stays the LOCATOR surface —
// aidAttrOf/durableLocator deliberately still read `name`.
function nameOf(attrs: MobileAttrs): string {
  return (
    attrs.label || attrs.name || attrs["content-desc"] || attrs.text ||
    attrs["resource-id"]?.split("/").pop() || ""
  ).replace(/\s+/g, " ").trim().slice(0, 120);
}

// Bounding box: iOS carries x/y/width/height; Android a bounds="[x1,y1][x2,y2]".
function bboxOf(attrs: MobileAttrs): MobileBoundingBox | null {
  if (attrs.x != null && attrs.width != null) {
    const x = +attrs.x, y = +attrs.y!, w = +attrs.width, h = +attrs.height!; // SAFETY: the iOS bbox branch historically lets missing y/height become NaN
    if ([x, y, w, h].every(Number.isFinite)) return { x, y, w, h };
  }
  const m = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.bounds || "");
  if (m) {
    const [x1, y1, x2, y2] = m.slice(1).map(Number) as [number, number, number, number];
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  return null;
}

const isVisible = (attrs: MobileAttrs): boolean =>
  attrs.visible !== "false" && attrs.displayed !== "false" &&
  !(attrs.width === "0" || attrs.height === "0");

// enabled is the RELIABLE actionability signal (unlike `visible`, below). Absent
// => enabled (the common case; only a disabled control carries enabled="false").
const isEnabled = (attrs: MobileAttrs): boolean => attrs.enabled !== "false" && attrs.disabled !== "true";

// A box overlaps the screen rect when it has non-zero area AND intersects the
// [0,0 .. screen.w,screen.h] frame. A scrolled-out list row (y past the bottom)
// or an off-safe-area ghost has a real bbox but sits OUTSIDE the screen, so it
// does NOT overlap. With no screen dimensions known (screen null — a defensive
// fallback), any non-zero box counts, preserving the pre-v5 behavior.
function overlapsScreen(box: MobileBoundingBox | null, screen: { w: number; h: number } | null): boolean {
  if (!box || box.w <= 0 || box.h <= 0) return false;
  if (!screen) return true;
  return box.x < screen.w && box.y < screen.h && box.x + box.w > 0 && box.y + box.h > 0;
}

// An interactive control we should surface DESPITE visible="false". XCUITest marks
// on-screen navigation-bar / off-safe-area buttons (a nav-bar "Next"/"Back") as
// visible="false" even though they are genuinely tappable — the classic XCUITest
// hit-point quirk. So an interactive node still earns an [eN] ref when it is
// ENABLED and has a real box that OVERLAPS the screen. The on-screen test is
// load-bearing: XCUITest also reports scrolled-out list rows (a long transaction
// list) and off-safe-area nodes as visible="false" with a real BUT off-screen
// bbox — without the overlap check those flood the snapshot with rows the user
// cannot see (the reported transactionCell spam). Genuinely hidden (no box / zero
// box), off-screen, and disabled controls stay dropped, and this rescue is scoped
// to interactive roles ONLY — text and structural noise (scroll bars, keyboard
// keys, hidden inputViews) keep the plain visible-only gate.
function isActionableInteractive(attrs: MobileAttrs, screen: { w: number; h: number } | null): boolean {
  if (isVisible(attrs)) return true;
  if (!isEnabled(attrs)) return false;
  return overlapsScreen(bboxOf(attrs), screen);
}

// The accessibility id a locator can target, and the source attribute it came
// from: name (iOS) / content-desc / resource-id (Android). The attribute is
// load-bearing for the name-scoped positional locator below — an XPath predicate
// must name the exact attribute it filters on.
function aidAttrOf(attrs: MobileAttrs): { attr: string; value: string } | null {
  if (attrs.name) return { attr: "name", value: attrs.name };
  if (attrs["content-desc"]) return { attr: "content-desc", value: attrs["content-desc"] };
  if (attrs["resource-id"]) return { attr: "resource-id", value: attrs["resource-id"] };
  return null;
}
function aidOf(attrs: MobileAttrs): string {
  return aidAttrOf(attrs)?.value ?? "";
}

// Durable locator, opaque to the rest of the harness (like the web Playwright
// selector). Preference order:
//   1. A GLOBALLY-UNIQUE accessibility id (the mobile testid analog) → `~aid`.
//   2. A NAME-SCOPED positional XPath when the aid repeats but is safe to quote:
//      `(//tag[@attr="aid"])[scopedPos]`, scopedPos counting only same-tag nodes
//      that SHARE this aid. This is stable when UNRELATED controls churn — the
//      failure mode that sank the StepPay run, where a plain global index
//      `(//XCUIElementTypeButton)[7]` pointed at a different button once a
//      virtualized list added/removed rows between snapshot and tap.
//   3. A plain global positional XPath `(//tag)[tagPos]` as the last resort —
//      when there is no aid, or the aid carries a `"` that XPath 1.0 can't quote
//      (no string-literal escape; concat() isn't worth it for this rare case).
// Positional locators stay brittle to reordering — the same "needs semantic
// markup" dependency web has, surfaced as an accessibility finding rather than
// papered over. Replayed verbatim in act mode.
function durableLocator(tag: string, attrs: MobileAttrs, tagPos: number, scopedPos: number, aidIsUnique: boolean): string {
  const aid = aidAttrOf(attrs);
  if (aid && aidIsUnique) return `~${aid.value}`;
  if (aid && !aid.value.includes('"')) return `(//${tag}[@${aid.attr}="${aid.value}"])[${scopedPos}]`;
  return `(//${tag})[${tagPos}]`;
}

/**
 * THE walk: every opening tag of a page source, in document order, as a
 * lightweight TREE (each node carries its parent index). We track three
 * positions/counts per node:
 *   tagPos   — 1-based position among ALL same-tag nodes (the plain
 *            `(//tag)[pos]` fallback locator resolves to it).
 *   scopedPos — 1-based position among same-tag nodes that SHARE this node's
 *            accessibility id (the name-scoped `(//tag[@attr="aid"])[pos]`
 *            locator — stable when UNRELATED controls churn, see durableLocator).
 *   aidCounts — global count per aid, so `~aid` is used only when it's unique.
 * The parent chain lets parsePageSource attach a control's in-cell text (a
 * repayment row's merchant/amount labels) to the control, the way a native list
 * groups them.
 *
 * This regex walk over a multi-megabyte page source is the expensive half of a
 * mobile snapshot, and BOTH projections (the agent text and the debug native
 * tree) need exactly the same nodes — so a caller that wants both walks ONCE and
 * hands the result to each. Never throws: a malformed source degrades to
 * whatever parsed. Pure; the returned nodes are treated as immutable.
 */
export function walkPageSource(xml: string): MobilePageSourceWalk {
  const nodes: IndexedArray<MobileNode> = [];
  const tagSeq = new Map<string, number>();
  const scopedSeq = new Map<string, number>();
  const aidCounts = new Map<string, number>();
  const stack: number[] = []; // indices of currently-open (non-self-closing) ancestors
  try {
    let m: RegExpExecArray | null;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(String(xml ?? "")))) {
      const [full, closing, tag, attrBlob] = m as RegExpExecArray & [string, string, string, string];
      if (closing) { // tolerant: a mismatched close still pops (Appium XML is well-formed)
        stack.pop(); // tolerant: a mismatched close still pops (Appium XML is well-formed)
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
      const parent = stack.length ? stack[stack.length - 1] as number : -1;
      nodes.push({ tag, attrs, tagPos, scopedPos, parent, role: roleOf(tag) });
      if (!/\/>$/.test(full)) stack.push(idx); // a container tag opens a scope; a self-closed leaf does not
    }
  } catch {
    // never throw: a malformed source degrades to whatever was parsed so far
  }
  return { nodes, aidCounts };
}

/**
 * Walk an Appium page-source string into the `[eN]` text + an ordered element
 * list (ref, role, name, value, locator, bbox, typable). Mirrors the web
 * snapshot contract: caller writes the text to steps/NNN.a11y.txt and keeps the
 * element list to resolve refs → durable locators on execute().
 *
 * `walk` reuses a walk the caller already made (see walkPageSource); omitted,
 * this walks `xml` itself. When both are given the walk wins — `xml` is then
 * unused, so a caller holding only a walk may pass `""`.
 */
export function parsePageSource(
  xml: string,
  { max = 200, screen = null, walk = null }: { max?: number; screen?: { w: number; h: number } | null; walk?: MobilePageSourceWalk | null } = {}
): MobileSnapshot {
  const { nodes, aidCounts } = walk ?? walkPageSource(xml);

  // The nearest ancestor CELL of a node (the native list-row grouping unit —
// iOS XCUIElementTypeCell / Android listitem, both roleOf->"cell"), or -1. A
// control and its labels are attached to each other ONLY when they share one,
// so top-level text (a stray hidden caption with no row) never leaks onto an
// unrelated control.
const cellOf = (i: number): number => {
  for (let p = nodes[i]!.parent; p !== -1; p = nodes[p]!.parent) { // SAFETY: parsed parent indices always point at an existing earlier node
    if (nodes[p]!.role === "cell") return p; // SAFETY: p comes from a parsed parent index
  }
  return -1;
};

// Wrapper cells: a `cell` that ENCLOSES an actionable interactive control is a
// pure row container (the native list-row `repaymentCell` around a
// `RepaymentTilePayButton`) — its own tap target is redundant with the richer,
// now text-enriched child. We drop its [eN] ref line so a virtualized list reads
// as one ref per row (the button) instead of alternating cell/button lines that
// also block run-collapse. A LEAF cell with no interactive descendant (a plain
// todo row) is NOT a wrapper — it keeps its ref, it's the only affordance. The
// cell still exists as the tree's grouping anchor for text attachment.
const wrapperCells = new Set<number>();
for (let i = 0; i < nodes.length; i++) {
  const n = nodes[i]!; // SAFETY: loop bounds prove the indexed node exists
  if (!INTERACTIVE_ROLES.includes(n.role) || !isActionableInteractive(n.attrs, screen)) continue;
  for (let p = n.parent; p !== -1; p = nodes[p]!.parent) { // SAFETY: parsed parent indices always point at an existing earlier node
    if (nodes[p]!.role === "cell") wrapperCells.add(p); // SAFETY: p comes from a parsed parent index
  }
}

// Pass 2a: decide which interactive nodes are SURFACED (visible, or the
// actionable-though-invisible XCUITest nav-bar quirk), assign refs, and bucket
// them by their enclosing cell. The element cap bounds the ref count; anything
// past it sets `truncated` (surfaced to the actor in the rendered text below).
const elements: MobileSnapshotElement[] = [];
let title = "";
let truncated = false;
const elementsByCell = new Map<number, SurfacedMobileNode[]>(); // cell index -> surfaced element nodes inside it
const surfaced = new Map<number, MobileSnapshotElement>(); // node index -> its [eN] element
for (let i = 0; i < nodes.length; i++) {
  const n = nodes[i]!; // SAFETY: loop bounds prove the indexed node exists
  if (/Application$|Window$/.test(n.tag) && !title) title = nameOf(n.attrs) || title;
  if (!INTERACTIVE_ROLES.includes(n.role)) continue;
  if (wrapperCells.has(i)) continue; // a row container around a real control (see wrapperCells)
  if (!isActionableInteractive(n.attrs, screen)) continue;
  if (elements.length >= max) {
    truncated = true;
    break;
  }
  const aid = aidOf(n.attrs);
  const cell = cellOf(i);
  const el = {
    ref: `e${elements.length + 1}`,
    role: n.role,
    name: nameOf(n.attrs),
    value: (n.attrs.value ?? "").replace(/\s+/g, " ").trim(),
    locator: durableLocator(n.tag, n.attrs, n.tagPos, n.scopedPos, aid !== "" && aidCounts.get(aid) === 1),
    bbox: bboxOf(n.attrs),
    typable: TYPABLE.has(n.role),
  };
  surfaced.set(i, el);
  elements.push(el);
  if (cell !== -1) {
    const bucket: SurfacedMobileNode[] = elementsByCell.get(cell) ?? [];
    bucket.push({ index: i, el });
    elementsByCell.set(cell, bucket);
  }
}

// Pass 2b: attach each surfaced control's in-cell text to it, and remember
// which text nodes were CLAIMED so they don't also render as standalone lines.
// Text is eligible when on-screen (visible OR the invisible-but-on-screen case
// - a native cell often marks its labels visible="false" though they're drawn),
// shares a cell with a surfaced control, and doesn't merely echo that control's
// name. Attached in document order, so a row reads "button → merchant, amount".
const claimed = new Set<number>();
const contextByRef = new Map<string, string[]>(); // ref → [text, …]
for (let i = 0; i < nodes.length; i++) {
  const n = nodes[i]!; // SAFETY: loop bounds prove the indexed node exists
  if (n.role !== "text") continue;
  const name = nameOf(n.attrs);
  if (!name) continue;
  if (!(isVisible(n.attrs) || overlapsScreen(bboxOf(n.attrs), screen))) continue;
  const cell = cellOf(i);
  const siblings = cell === -1 ? null : elementsByCell.get(cell);
  if (!siblings) continue;
  // Attach to every surfaced control in the same cell (a row's info + pay
  // buttons both describe the same item), skipping an echo of the control name.
  for (const m2 of siblings) {
    if (echoes(m2.el.name, name)) continue;
    const list: string[] = contextByRef.get(m2.el.ref) ?? [];
    if (!list.includes(name)) list.push(name);
    contextByRef.set(m2.el.ref, list);
  }
  claimed.add(i);
}

// Pass 2c: render lines in document order. A surfaced control emits its ref
// line (with any attached in-cell context); an unclaimed visible text emits a
// standalone `text:` line (unchanged from before). Then collapse long runs of
// near-identical control lines (a virtualized list of repayment rows) so the
// snapshot doesn't drown the actor in dozens of lines differing only by a
// scrolling index — see collapseRuns.
const rendered: RenderedLine[] = [];
for (let i = 0; i < nodes.length; i++) {
  const n = nodes[i]!; // SAFETY: loop bounds prove the indexed node exists
  if (n.role === "text") {
    if (!claimed.has(i) && isVisible(n.attrs) && nameOf(n.attrs)) {
      rendered.push({ display: `text: ${JSON.stringify(nameOf(n.attrs))}` });
    }
    continue;
  }
  const el = surfaced.get(i);
  if (!el) continue;
  let line = `[${el.ref}] ${el.role} ${JSON.stringify(el.name)}`;
  // A typable control renders its editable contents as `value="…"`. Every OTHER
  // role renders a non-empty accessibility value parenthesized — `button "Buy
  // milk" (completed)`. Value-carries-state is a standard iOS pattern (a row
  // button whose value flips active/completed), and restricting this to `switch`
  // hid those flips from the actor entirely: a real toggle produced a
  // byte-identical snapshot and so read as no_effect.
  if (el.typable) line += ` value=${JSON.stringify(el.value)}`;
  else if (el.value) line += ` (${el.value})`;
  const ctx = contextByRef.get(el.ref);
  if (ctx?.length) line += ` — ${ctx.map((t) => JSON.stringify(t)).join(" ")}`;
  // Collapse key: same role + attached context + value, with the name's trailing
  // index digits folded (RepaymentTilePayButton5/6/7 → one run) so identical rows
  // group even though their testids differ.
  rendered.push({ display: line, ref: el.ref, key: `${el.role}/${el.name.replace(/\d+$/, "#")}/${el.value}/${ctx?.join("^A") ?? ""}` });
}

const lines = collapseRuns(rendered);
if (truncated) lines.push(`… (${max}-element cap reached — the screen has more not shown here; scroll/swipe to reveal it, or act on what's visible)`);

const header = `Screen: ${title || "(app)"}`;
return { text: [header, ...lines].join("\n"), title, elements, refCount: elements.length, truncated };
}

// True when every word of `text` already appears in `name` — the visible text
// merely echoes the control's accessible name, so attaching it is noise. A local
// word-subset check (the mobile analog of snapshot-injected's nameEchoesVisibleText,
// which can't be imported — it runs in a browser page context).
function echoes(name: string, text: string): boolean {
  const words = String(text).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = ` ${String(name).toLowerCase().replace(/\s+/g, " ")} `;
  return words.every((w) => hay.includes(` ${w} `));
}

// Collapse a run of COLLAPSE_MIN+ consecutive control lines that share a
// `key` (same role/label/context, index-insensitive name) into the first line
// plus one indented `… N more like this` continuation carrying the collapsed ref
// range. All refs stay resolvable (the elements list is untouched) — this is a
// DISPLAY compression only, so a long virtualized list reads as one entry with a
// count instead of dozens of near-duplicates. Lines without a key (text,
// truncation note) never collapse. Pure; operates on the rendered-line objects.
const COLLAPSE_MIN = 3;
function collapseRuns(rendered: RenderedLine[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rendered.length; ) {
    const cur = rendered[i]!; // SAFETY: the loop condition proves the current rendered line exists
    let j = i + 1;
    if (cur.key) while (j < rendered.length && rendered[j]!.key === cur.key) j++; // SAFETY: the inner loop condition proves the indexed line exists
    const runLen = j - i;
    out.push(cur.display);
    if (runLen >= COLLAPSE_MIN) {
      const last = rendered[j - 1]!; // SAFETY: every collapsed run contains at least the current line
      const range = cur.ref && last.ref ? ` (${cur.ref}-${last.ref})` : "";
      out.push(`… ${runLen - 1} more like this${range}`);
      i = j;
    } else {
      i += 1;
    }
  }
  return out;
}

/**
 * Build the snapshot for an on-screen system alert (iOS permission dialog,
 * Android runtime-permission prompt) from Appium's alert API — NOT the page
 * source, which omits it entirely (the alert is a separate SpringBoard process).
 * Renders the alert's title/message as `text:` lines and one `[eN] button` per
 * alert button, each carrying an `alert-button:<label>` locator so the driver
 * taps it through `mobile: alert` rather than element resolution. Mirrors the
 * parsePageSource return shape so captureSnapshot treats the two identically.
 *
 * Pure; exported for test. Never throws. When the alert exposes no buttons
 * (defensive — a real alert always has at least one), returns a bare header so
 * the actor at least sees the dialog text and can `back`/`swipe` to recover.
 */
export function alertSnapshot({ text = "", buttons = [] }: { text?: string; buttons?: string[] } = {}): MobileSnapshot {
  const lines: string[] = [];
  // The alert body: title + message, one `text:` line per non-empty segment,
  // whitespace-collapsed like nameOf so it reads the same as a page-source text.
  for (const seg of String(text).split("\n")) {
    const t = seg.replace(/\s+/g, " ").trim();
    if (t) lines.push(`text: ${JSON.stringify(t)}`);
  }
  const elements: MobileSnapshotElement[] = [];
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
      bbox: null, // SpringBoard alert: no queryable rect (see ALERT_LOCATOR_PREFIX)
      typable: false,
      alertButton: true,
    });
    lines.push(`[${ref}] button ${JSON.stringify(name)}`);
  }
  const header = "Screen: System dialog";
  return { text: [header, ...lines].join("\n"), title: "System dialog", elements, refCount: elements.length, truncated: false };
}

/**
 * Debug-only: the FULL, UNFILTERED Appium page-source tree, flattened into the
 * SAME `role "name"` line shape as parsePageSource — the mobile analog of the web
 * driver's native AX tree (web.ts#nativeAxTree). Where parsePageSource keeps only
 * the visible, interactive elements the actor should see, this keeps EVERYTHING:
 * invisible nodes, non-interactive containers, the lot. Rendered beside the custom
 * snapshot in the viewer's Custom|Native diff so a control our filter DROPPED (a
 * top-bar "Next" button the actor never saw) shows up as a native-only row.
 *
 * Ref-less (refs are the custom walk's; the diff aligns on `role "name"`). State
 * markers are added ONLY where they distinguish a row from its custom counterpart:
 * `(invisible)` / `(disabled)` — never `(visible)`, so a visible interactive node
 * renders the bare `role "name"` the custom side does and the two align. Never
 * throws: a malformed source degrades to whatever parsed. Returns the joined text,
 * or null when nothing parsed.
 *
 * `walk` reuses the walk parsePageSource already made for the same source (see
 * walkPageSource) — the two projections are pure functions of the SAME nodes, so
 * a capture that wants both pays for one regex pass. Omitted, this walks `xml`
 * itself; when given, `xml` is unused.
 */
export function nativePageSourceTree(xml: string, walk: MobilePageSourceWalk | null = null): string | null {
  const { nodes } = walk ?? walkPageSource(xml);
  const lines: string[] = [];
  let title = "";
  let lastText = "";
  for (const { tag, attrs, role } of nodes) {
    if (/Application$|Window$/.test(tag) && !title) title = nameOf(attrs) || title;

    const name = nameOf(attrs);
    if (role === "text") {
      // Dedupe against the immediately-preceding text line (the custom renderer
      // and the web native walk both dedupe adjacent text).
      if (name && name !== lastText) {
        lines.push(`text: ${JSON.stringify(name)}`);
        lastText = name;
      }
      continue;
    }
    // Keep any node that carries a name OR is one of the interactive roles —
    // an unnamed structural container is pure noise with no custom counterpart.
    if (!name && !INTERACTIVE_ROLES.includes(role)) continue;

    let line = `${role} ${JSON.stringify(name)}`;
    if (!isVisible(attrs)) line += " (invisible)";
    if (attrs.enabled === "false") line += " (disabled)";
    lines.push(line);
    lastText = "";
  }
  const header = `Screen: ${title || "(app)"}`;
  return lines.length ? [header, ...lines].join("\n") : null;
}
