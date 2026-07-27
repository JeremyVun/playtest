// The single viewer browser suite. Run artifacts are generated directly; this
// test verifies rendering, not the harness that produced them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

import { serveRun } from "../../../src/run-viewer/node.ts";
import { coreBundleKeepPath, rewriteBundle, writeBundle } from "../../../src/core/bundle.ts";
import { makeRunsFixture } from "../../support/run-fixtures.ts";

let tmpRoot: LegacyTestValue;
let runsRoot: LegacyTestValue;
let server: LegacyTestValue;
let base: LegacyTestValue;
let browser: LegacyTestValue;
let runsByMode: LegacyTestValue; // mode -> /runs.json entry

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-uismoke-"));
  runsRoot = makeRunsFixture(tmpRoot, { healedSameTrack: true }).runsRoot;

  server = await serveRun(runsRoot, { port: 0, open: false });
  base = `http://127.0.0.1:${server.address().port}`;
  const runs = await (await fetch(`${base}/runs.json`)).json();
  runsByMode = Object.fromEntries(runs.map((r: LegacyTestValue) => [r.mode, r]));
  for (const mode of ["record", "heal", "explore"]) assert.ok(runsByMode[mode], `expected a ${mode} run`);

  browser = await chromium.launch();
});

after(async () => {
  await browser?.close().catch(() => {});
  server?.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// The viewer deliberately probes optional artifacts and decides modes by
// 404 (boot's single-run probe, the clip vtt sidecar, ungraded/baseline-less
// runs). Those failed loads surface as console errors in chromium; anything
// else failing is a real regression.
const PROBE_404S = [/\/run\/manifest\.json$/, /\/runs\.json$/, /baseline\.jsonl$/, /grade\.json$/, /har\.json$/, /video\.vtt$/, /video\.webm$/];

/** Open a viewer page and collect non-probe console errors + page errors. */
async function open(query: LegacyTestValue) {
  const page = await browser.newPage();
  const errors: LegacyTestValue = [];
  const notFound = new Set<string>();
  page.on("pageerror", (e: LegacyTestValue) => errors.push(`pageerror: ${e}`));
  page.on("response", (r: LegacyTestValue) => {
    if (r.status() === 404) notFound.add(r.url());
  });
  page.on("console", (msg: LegacyTestValue) => {
    if (msg.type() !== "error") return;
    const url = msg.location()?.url ?? "";
    if (PROBE_404S.some((re) => re.test(url)) && notFound.has(url)) return;
    errors.push(`console: ${msg.text()} (${url})`);
  });
  await page.goto(base + "/" + query);
  const failUnexpected404 = () => {
    const bad = [...notFound].filter((u) => !PROBE_404S.some((re) => re.test(u)));
    assert.deepEqual(bad, [], "only the deliberate optional-artifact probes may 404");
  };
  return { page, errors, failUnexpected404 };
}

const text = (page: LegacyTestValue, sel: LegacyTestValue) => page.locator(sel).innerText();

async function recordedCaptions() {
  const { page, errors, failUnexpected404 } = await open(`?run=${runsByMode.record.path}`);
  await page.waitForSelector("#strip .cell");
  const cells = await page.locator("#strip .cell").count();
  assert.ok(cells >= 3, `film strip should show the recorded steps, got ${cells}`);

  await page.locator("#strip .cell").first().click();
  const firstThought = await text(page, "#cap-thought");
  assert.ok(firstThought.trim().length > 10, `step caption should carry the agent thought, got "${firstThought}"`);
  await page.locator("#strip .cell").last().click();
  const lastThought = await text(page, "#cap-thought");
  assert.notEqual(lastThought, firstThought, "captions must follow the selected step");
  assert.ok((await text(page, "#cap-meta")).toLowerCase().includes("step"), "step meta line renders");

  assert.deepEqual(errors, [], "no console/page errors on the recorded run");
  failUnexpected404();
  await page.close();
}

async function briefLayout() {
  // The user's goal must be the first thing in the left panel — instant context,
  // above the per-step thought (which scrolls in its own region below it).
  const { page, errors } = await open(`?run=${runsByMode.record.path}`);
  await page.waitForSelector("#strip .cell");
  const order = await page.evaluate(() => {
    // the widen control floats over the panel corner — not part of the content flow
    const kids = [...document.querySelector("#caption")!.children] // SAFETY: viewer shell always contains #caption
      .filter((c) => c.tagName !== "BUTTON")
      .map((c) => c.id);
    return { first: kids[0], hasBody: kids.includes("cap-body") };
  });
  assert.equal(order.first, "cap-brief", "the brief is the first content child of the caption panel");
  assert.ok(order.hasBody, "the step body still renders below the brief");
  const brief = await text(page, "#cap-brief");
  assert.match(brief.toLowerCase(), /buy milk/, "the brief shows the story's goal");
  assert.deepEqual(errors, [], "no console/page errors");
  await page.close();
}

async function thoughtOverflow() {
  // The step-through-stills regression: a dense, unscrolled thought grew the
  // caption panel until the film strip was pushed past the bottom of the window.
  const { page } = await open(`?run=${runsByMode.record.path}`);
  await page.waitForSelector("#strip .cell");
  await page.locator("#strip .cell").first().click();
  const m = await page.evaluate(() => {
    const t: LegacyTestValue = document.querySelector("#cap-thought");
    t.textContent = "Lorem ipsum dolor sit amet, consectetur. ".repeat(400); // ~16k chars
    const strip: LegacyTestValue = document.querySelector("#strip-zone")!.getBoundingClientRect(); // SAFETY: viewer shell always contains #strip-zone
    const body: LegacyTestValue = document.querySelector("#cap-body");
    return {
      stripBottom: strip.bottom,
      viewport: window.innerHeight,
      bodyScrolls: body.scrollHeight > body.clientHeight + 1,
    };
  });
  assert.ok(m.stripBottom <= m.viewport + 1,
    `film strip must stay within the viewport (bottom ${m.stripBottom} vs ${m.viewport})`);
  assert.ok(m.bodyScrolls, "the thought body scrolls its overflow instead of growing the panel");
  await page.close();
}

async function stripOverflow() {
  // The locate-divergence regression: the #app grid had no column constraint, so
  // its implicit `auto` column sized to its widest row — a long strip of fixed-
  // width cells stretched the column past the viewport and carried the inspector
  // off the right edge. The strip must scroll horizontally instead.
  const { page } = await open(`?run=${runsByMode.record.path}`);
  await page.waitForSelector("#strip .cell");
  const m = await page.evaluate(() => {
    // Force the many-stills condition regardless of the fixture's step count.
    const strip: LegacyTestValue = document.querySelector("#strip");
    const proto: LegacyTestValue = strip.querySelector(".cell");
    for (let i = 0; i < 40; i++) strip.append(proto.cloneNode(true));
    const insp: LegacyTestValue = document.querySelector("#inspector")!.getBoundingClientRect(); // SAFETY: viewer shell always contains #inspector
    return {
      stripOverflows: strip.scrollWidth > strip.clientWidth + 1,
      inspRight: insp.right,
      docWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    };
  });
  assert.ok(m.stripOverflows, "test precondition: the strip's cells must overflow its width");
  assert.ok(m.inspRight <= m.viewport + 1,
    `inspector must stay within the viewport (right ${m.inspRight} vs ${m.viewport})`);
  assert.ok(m.docWidth <= m.viewport + 1,
    `a long film strip must not widen the document (${m.docWidth} vs ${m.viewport})`);
  await page.close();
}

async function diffFollowsSelection() {
  // The diff pane is step-aware: clicking a track cell selects that step in
  // place (film strip follows), and the per-step panel diffs the selected step
  // against its baseline counterpart. Moving the strip selection re-renders it.
  const { page, errors } = await open(`?run=${runsByMode.heal.path}`);
  await page.waitForSelector("#strip .cell");
  await page.locator("#tab-diff").click();
  await page.waitForSelector("#pane-diff:not([hidden])");

  const cell = page.locator("#diff-body .dcell.clickable[data-step]").first();
  const step = await cell.getAttribute("data-step");
  await cell.click();
  assert.ok(await page.locator("#pane-diff").isVisible(), "the diff pane stays open on a cell click");
  await page.waitForSelector(`#diff-body .dcell.cur[data-step="${step}"]`);
  assert.match(await text(page, "#diff-step .ds-head"), new RegExp(`step ${step}`),
    "the per-step panel names the selected step");

  // strip navigation drives the same panel
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    (s: LegacyTestValue) => !document.querySelector("#diff-step .ds-title")?.textContent.endsWith(` ${s}`),
    step,
  );
  assert.deepEqual(errors, [], "no console/page errors");
  await page.close();
}

async function diffRender() {
  const { page, errors, failUnexpected404 } = await open(`?run=${runsByMode.heal.path}`);
  await page.waitForSelector("#strip .cell");
  const diffTab = page.locator("#tab-diff");
  assert.ok(await diffTab.isVisible(), "diff tab must be offered when a baseline exists");
  await diffTab.click();
  await page.waitForSelector("#pane-diff:not([hidden])");
  const dcells = await page.locator("#diff-body .dcell").count();
  assert.ok(dcells >= 2, `diff should render track cells, got ${dcells}`);
  const head = await text(page, "#diff-body .diff-head");
  assert.match(head, /same/, "diff head summarizes the comparison");

  assert.deepEqual(errors, [], "no console/page errors on the healed run");
  failUnexpected404();
  await page.close();
}

async function diffNoChanges() {
  // A heal that re-took exactly the baseline actions: the diff has zero
  // changes. The tab must read "Diff" with no count — replaceChildren
  // stringifies a literal null child into a "null" text node ("Diffnull").
  // The step caption stays: the diff pane is step-aware now.
  const { page, errors } = await open(`?run=${runsByMode.act.path}`);
  await page.waitForSelector("#strip .cell");
  const diffTab = page.locator("#tab-diff");
  assert.equal((await diffTab.innerText()).trim(), "Diff",
    "a zero-change diff tab carries no count and no stringified null");
  await diffTab.click();
  await page.waitForSelector("#pane-diff:not([hidden])");
  assert.ok(await page.locator("#cap-brief").isVisible(), "the brief stays on the diff view");
  assert.ok(await page.locator("#cap-body").isVisible(), "the step caption body stays on the step-aware diff view");
  assert.match(await text(page, "#diff-body .diff-head"), /0 removed · 0 added/,
    "the diff summarizes an unchanged track");
  assert.deepEqual(errors, [], "no console/page errors");
  await page.close();
}

async function changedList() {
  const { page, errors } = await open("?filter=changed");
  await page.waitForSelector("#picker:not([hidden])");
  const body = await text(page, "#picker");
  assert.match(body, /playtest baseline accept /, "accept command is displayed");
  assert.deepEqual(errors, [], "no console/page errors on the review list");
  await page.close();
}

async function discoveryReport() {
  const { page, errors, failUnexpected404 } = await open(`?run=${runsByMode.explore.path}`);
  await page.waitForSelector("#strip .cell");
  await page.locator('button.itab[data-itab="run"]').click();
  await page.waitForSelector(".report-entry");
  const q = await text(page, ".report-entry .report-q");
  const a = await text(page, ".report-entry .report-a");
  assert.match(q, /Where did the user look first/, "report question renders");
  assert.ok(a.trim().length > 0, "report answer must not be blank");

  // Typed bug candidate renders as a distinct "potential defect", separate from
  // free-form findings (P1).
  await page.waitForSelector(".candidate");
  assert.match(await text(page, ".label-cand"), /potential defect/i, "candidates labeled as potential defects");
  assert.match(await text(page, ".candidate .cand-kind"), /http_error/i, "candidate kind renders");
  assert.match(await text(page, ".candidate .cand-title"), /Save request returns a server error/);
  assert.match(await text(page, ".candidate"), /expected|observed/i, "expected/observed behavior renders");

  assert.deepEqual(errors, [], "no console/page errors on the discovery run");
  failUnexpected404();
  await page.close();
}

// A journey run has no bug_candidates: the grade still renders, with no
// potential-defect section (missing-field backward compatibility).
async function journeyGradeHasNoCandidates() {
  const { page, errors } = await open(`?run=${runsByMode.record.path}`);
  await page.waitForSelector("#strip .cell");
  await page.locator('button.itab[data-itab="run"]').click();
  await page.waitForSelector(".grade-top");
  assert.equal(await page.locator(".candidate").count(), 0, "no candidates rendered for a journey grade");
  assert.equal(await page.locator(".label-cand").count(), 0, "no potential-defect label for a journey grade");
  assert.deepEqual(errors, [], "no console/page errors rendering a candidate-less grade");
  await page.close();
}

async function stepLinks() {
  const run = encodeURIComponent(runsByMode.record.path);
  const cases: LegacyTestValue = [
    [`?run=${run}&step=2`, /^step 2 \//i, 1],
    [`?run=${run}`, /^step 1 \//i, 0],
    [`?run=${run}&step=9999`, /^step 1 \//i, 0],
  ];
  for (const [query, expectedMeta, expectedIndex] of cases) {
    const { page, errors } = await open(query);
    await page.waitForSelector("#strip .cell");
    assert.match(await page.locator("#cap-meta .cap-step").innerText(), expectedMeta);
    const selectedIndex = await page.evaluate(() => {
      const on: LegacyTestValue = document.querySelector("#strip .cell.on");
      return on ? Number(on.dataset.i) : -1;
    });
    assert.equal(selectedIndex, expectedIndex);
    assert.deepEqual(errors, []);
    await page.close();
  }
}

// Step-linked invariant evidence (docs/contracts/engine.md#invariant-policies).
// A cross-layer API violation is only reviewable if the reader can get from
// "POST /api/todos answered 200" to the click that caused it, so the gate row
// renders the citation as a deep link into the step timeline.
async function gateStepCitation() {
  const { page, errors } = await open(`?run=${runsByMode.record.path}`);
  await page.waitForSelector("#strip .cell");
  await page.locator('button.itab[data-itab="run"]').click();
  await page.waitForSelector(".gate-steps");
  const row = page.locator(".gate-row", { has: page.locator(".gate-steps") });
  assert.match(await row.locator(".gate-detail").innerText(), /answered 200, which the spec does not declare/);
  assert.match(await row.locator(".gate-steps").innerText(), /produced by/i);
  const link = row.locator(".gate-steps .f-step");
  assert.equal(await link.count(), 1, "one step cited");
  assert.match(await link.innerText(), /step 2/);

  // The citation is a real jump, not decoration.
  await link.click();
  assert.match(await page.locator("#cap-meta .cap-step").innerText(), /^step 2 \//i);
  assert.deepEqual(errors, [], "no console/page errors rendering step-linked gate evidence");
  await page.close();
}

async function bundleRendering() {
  const runDir = path.join(runsRoot, runsByMode.record.path);
  const full = path.join(tmpRoot, "full.ptrun");
  const core = path.join(tmpRoot, "core.ptrun");
  writeBundle(runDir, full);
  rewriteBundle(full, core, coreBundleKeepPath);

  for (const [tier, bundle] of [["full", full], ["core", core]] as LegacyTestValue) { // SAFETY: fixed fixture tuples carry string paths
    const bundleServer = await serveRun(bundle, { port: 0, open: false });
    const page = await browser.newPage();
    const errors: LegacyTestValue = [];
    page.on("pageerror", (e: LegacyTestValue) => errors.push(String(e)));
    try {
      await page.goto(`http://127.0.0.1:${bundleServer.address().port}/`);
      await page.waitForSelector("#strip .cell");
      assert.equal(await page.locator("#strip .cell").count(), 3, `${tier} bundle renders every step`);
      await page.locator("#strip .cell").first().click();
      assert.match(await page.locator("#cap-thought").innerText(), /buy milk/i);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
      bundleServer.close();
    }
  }
}

test("viewer renders recorded, healed, explored, deep-linked, and bundled runs", async () => {
  await recordedCaptions();
  await briefLayout();
  await thoughtOverflow();
  await stripOverflow();
  await diffFollowsSelection();
  await diffRender();
  await diffNoChanges();
  await changedList();
  await discoveryReport();
  await journeyGradeHasNoCandidates();
  await stepLinks();
  await gateStepCitation();
  await bundleRendering();
});
