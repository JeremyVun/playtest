// Walk the surface inventory with a real browser and bring back everything a
// UX review needs to argue from evidence rather than from memory:
//
//   out/<theme>/<surface>.png   full-page screenshot
//   out/report.json             per-surface headings, visible copy, and the
//                               accessible name of every interactive control
//   out/problems.json           console errors, uncaught exceptions, failed
//                               requests, and 4xx/5xx responses, per surface
//
// The control inventory is the adversarial half: unlabelled buttons, two
// controls with the same name on one screen, destructive actions with no
// confirmation, and inputs with no associated label all fall out of it.
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SURFACES } from "./surfaces.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Everything a person can act on, with the name a screen reader would announce. */
const INVENTORY = () => {
  const name = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const t = labelled
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
        .trim();
      if (t) return t;
    }
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab?.textContent.trim()) return lab.textContent.trim();
    }
    const wrapping = el.closest("label");
    if (wrapping?.textContent.trim()) return wrapping.textContent.trim();
    const text = (el.innerText || el.textContent || "").trim();
    if (text) return text.replace(/\s+/g, " ").slice(0, 80);
    if (el.placeholder) return `(placeholder only) ${el.placeholder}`;
    if (el.title) return `(title only) ${el.title}`;
    return "";
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const controls = [...document.querySelectorAll("button, a[href], input, textarea, select, [role=button], [tabindex]")]
    .filter(visible)
    .map((el) => ({
      tag: el.tagName.toLowerCase() + (el.type ? `[${el.type}]` : ""),
      name: name(el),
      cls: el.className && typeof el.className === "string" ? el.className : "",
      disabled: !!el.disabled,
      href: el.getAttribute("href") || undefined,
    }));
  const headings = [...document.querySelectorAll("h1, h2, h3, .label, .page-head .sub")]
    .filter(visible)
    .map((el) => `${el.tagName.toLowerCase()}: ${el.innerText.trim().replace(/\s+/g, " ")}`);
  const main = document.getElementById("main");
  return {
    title: document.title,
    headings,
    controls,
    // Visible prose, collapsed — the raw material for a copy pass.
    text: (main?.innerText || document.body.innerText || "").replace(/\n{2,}/g, "\n").trim().slice(0, 6000),
    modal: [...document.querySelectorAll(".modal")].map((m) => m.innerText.replace(/\n{2,}/g, "\n").trim()),
  };
};

export async function capture({ base, data, only = null, themes = ["dark", "light"], width = 1440, height = 900, headed = false, tag = "" }) {
  const outDir = path.join(HERE, tag ? `out-${tag}` : "out");
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });

  const list = SURFACES.filter((s) => !only || only.some((o) => s.id.includes(o)));
  const browser = await chromium.launch({ headless: !headed });
  const problems = [];
  const report = {};
  let shots = 0;

  for (const theme of themes) {
    await fsp.mkdir(path.join(outDir, theme), { recursive: true });
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    await context.addInitScript((t) => window.localStorage.setItem("pt-theme", t), theme);
    const page = await context.newPage();

    let current = "(boot)";
    const note = (kind, text) => {
      // Leaving a page aborts its held long-polls — the event feed, and the
      // embedded viewer's live stream on an open run. That is the design, not a
      // defect, so neither enters the problem list.
      if (/events\/feed|\/live\?/.test(text) && /ERR_ABORTED/.test(text)) return;
      problems.push({ surface: current, theme, kind, text: String(text).slice(0, 400) });
    };
    page.on("console", (m) => m.type() === "error" && note("console", m.text()));
    page.on("pageerror", (e) => note("pageerror", e.message));
    page.on("requestfailed", (r) => note("requestfailed", `${r.method()} ${r.url()} — ${r.failure()?.errorText}`));
    page.on("response", (r) => {
      if (r.status() >= 400) note("http", `${r.status()} ${r.request().method()} ${r.url().replace(base, "")}`);
    });

    for (const surface of list) {
      const url = surface.path(data);
      if (!url) continue;
      current = surface.id;
      try {
        // Never "networkidle": every project page holds a long-poll on the
        // event feed, so the network is idle only when the feed is broken.
        await page.goto(base + url, { waitUntil: "domcontentloaded", timeout: 20000 });
        // Pages paint after their fetches resolve; #main is the frame's slot.
        await page.waitForSelector("#main, .boot, #scope-gate", { timeout: 10000 }).catch(() => {});
        await page.waitForFunction(() => !document.querySelector(".boot"), null, { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(900);
        // `act` gets the seeded ids too, so a surface can change the SERVER
        // while its page is open — sealing a live run under the run page is the
        // only way to photograph a transition rather than a state.
        if (surface.act) await surface.act(page, data);
        await page.waitForTimeout(200);
      } catch (e) {
        note("navigation", e.message);
      }
      // The pointer keeps whatever position the last click left it in, and a
      // stray :hover in the rail reads as a navigation state in the screenshot.
      // Park it in the bottom-left gutter before shooting.
      await page.mouse.move(4, height - 4).catch(() => {});
      await page.waitForTimeout(120);
      const file = path.join(outDir, theme, `${surface.id}.png`);
      await page.screenshot({ path: file, fullPage: true }).catch((e) => note("screenshot", e.message));
      shots++;
      if (theme === themes[0]) {
        report[surface.id] = {
          title: surface.title,
          url,
          note: surface.note || null,
          ...(await page.evaluate(INVENTORY).catch(() => ({}))),
        };
      }
      process.stdout.write(`  ${theme}  ${surface.id}\n`);
    }
    await context.close();
  }

  await browser.close();
  await fsp.writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  await fsp.writeFile(path.join(outDir, "problems.json"), JSON.stringify(problems, null, 2));
  return { outDir, shots, problems, report };
}
