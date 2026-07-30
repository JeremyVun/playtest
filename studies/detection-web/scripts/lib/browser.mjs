// Real-browser layer for arm C (control agent). Public Playwright APIs only.
// Elements are addressed by refs (`r1`, `r2`, …) that this layer assigns to
// visible interactive elements via a data attribute at snapshot time — the
// same interaction model as browser-agent MCP tooling. The page structure
// section comes from Playwright's ARIA snapshot.

import { chromium } from "playwright";

const REF_ATTR = "data-study-ref";

export async function openBrowser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const consoleLog = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      consoleLog.push({ kind: `console.${msg.type()}`, text: msg.text().slice(0, 500) });
    }
  });
  page.on("pageerror", (err) => consoleLog.push({ kind: "pageerror", text: String(err).slice(0, 500) }));
  page.on("response", (res) => {
    if (res.status() >= 400) consoleLog.push({ kind: "http", text: `${res.status()} ${res.request().method()} ${res.url()}` });
  });
  page.on("requestfailed", (req) => {
    consoleLog.push({ kind: "requestfailed", text: `${req.method()} ${req.url()} ${req.failure()?.errorText ?? ""}` });
  });
  return { browser, context, page, consoleLog };
}

/** Assign refs to visible interactive elements; return their inventory. */
async function indexInteractive(page) {
  return page.evaluate((REF_ATTR) => {
    const win = window;
    win.__studyRefCounter = win.__studyRefCounter || 0;
    const selector = "a[href], button, input, select, textarea, summary, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [role='checkbox'], [role='radio'], [contenteditable='true']";
    const items = [];
    for (const el of document.querySelectorAll(selector)) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.display === "none") continue;
      if (!el.getAttribute(REF_ATTR)) el.setAttribute(REF_ATTR, `r${++win.__studyRefCounter}`);
      const ref = el.getAttribute(REF_ATTR);
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type");
      const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "button" || type === "submit" || type === "button" ? "button" : tag === "select" ? "combobox" : tag === "textarea" ? "textbox" : tag === "input" ? (type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : "textbox") : tag);
      let name = el.getAttribute("aria-label") || "";
      if (!name && el.labels && el.labels.length) name = el.labels[0].textContent.trim();
      if (!name) name = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
      if (!name) name = el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("title") || "";
      const state = [];
      if (el.disabled) state.push("disabled");
      if (el.checked) state.push("checked");
      if (el.required) state.push("required");
      let value = "";
      if (tag === "input" || tag === "textarea") value = (el.value || "").slice(0, 120);
      if (tag === "select") value = el.selectedOptions[0]?.textContent?.trim() || "";
      const options = tag === "select" ? [...el.options].map((o) => o.textContent.trim()).slice(0, 30) : undefined;
      items.push({ ref, role, name, value, state, options });
    }
    return items;
  }, REF_ATTR);
}

/** One text snapshot: url, title, ARIA outline, interactive refs, new console events. */
export async function snapshot(page, consoleLog, sinceIndex) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  const outline = await page.locator("body").ariaSnapshot().catch(() => "(no aria snapshot)");
  const refs = await indexInteractive(page);
  const lines = refs.map((r) => {
    const bits = [`[${r.ref}]`, r.role, r.name ? JSON.stringify(r.name) : "(unnamed)"];
    if (r.value) bits.push(`value=${JSON.stringify(r.value)}`);
    if (r.state.length) bits.push(r.state.join(","));
    if (r.options) bits.push(`options=[${r.options.join(" | ")}]`);
    return "  " + bits.join(" ");
  });
  const events = consoleLog.slice(sinceIndex);
  const eventText = events.length
    ? "\n\nBrowser events since last snapshot:\n" + events.map((e) => `  [${e.kind}] ${e.text}`).join("\n")
    : "";
  return {
    text:
      `URL: ${page.url()}\nTitle: ${await page.title().catch(() => "")}\n\nPage structure:\n${outline}` +
      `\n\nInteractive elements:\n${lines.join("\n") || "  (none)"}${eventText}`,
    consoleIndex: consoleLog.length,
  };
}

const byRef = (page, ref) => page.locator(`[${REF_ATTR}="${ref}"]`).first();

export const actions = {
  async goto(page, url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    return `navigated to ${page.url()}`;
  },
  async click(page, ref) {
    await byRef(page, ref).click({ timeout: 5000 });
    await page.waitForTimeout(300);
    return `clicked ${ref}`;
  },
  async type(page, ref, text) {
    await byRef(page, ref).fill(text, { timeout: 5000 });
    return `typed into ${ref}`;
  },
  async select(page, ref, value) {
    await byRef(page, ref).selectOption({ label: value }, { timeout: 5000 }).catch(async () => {
      await byRef(page, ref).selectOption(value, { timeout: 5000 });
    });
    return `selected ${JSON.stringify(value)} in ${ref}`;
  },
  async press(page, key) {
    await page.keyboard.press(key);
    await page.waitForTimeout(200);
    return `pressed ${key}`;
  },
  async back(page) {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 });
    return `went back to ${page.url()}`;
  },
  async wait(page, ms) {
    const capped = Math.min(Number(ms) || 500, 5000);
    await page.waitForTimeout(capped);
    return `waited ${capped}ms`;
  },
};
