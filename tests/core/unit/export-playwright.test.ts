// The Playwright exporter (src/core/export-playwright.ts): every verb, every
// gate kind, and the escaping that is the feature's main correctness risk.
//
// The exporter is a pure function, so these tests need no browser, no baseline
// on disk, and no @playwright/test — they assert on emitted TEXT. The structural
// guarantee (the emitted TypeScript actually parses) lives in the integration
// test alongside the golden.
import { test } from "node:test";
import assert from "node:assert/strict";

import { exportSpec, specFilename } from "../../../src/core/export-playwright.ts";

/** A baseline step envelope. `locator: null` is a refless step (scroll/navigate/wait/back). */
function step(n: number, type: string, extra: LegacyTestValue = {}, locator: string | null = null, thought = "because the story says so"): LegacyTestValue {
  return {
    step: n,
    schema_version: 7,
    mode: "agent",
    agent: {
      thought,
      action: { type, ...(locator === null ? {} : { ref: `e${n}` }), ...extra },
      expectation: "it works",
    },
    resolution: locator === null ? { locator: null, bbox: null } : { ref: `e${n}`, locator, bbox: {} },
    result: { ok: true, error: null, settle_ms: 10, url: "http://app.test/" },
  };
}

const webCase = (over: LegacyTestValue = {}): LegacyTestValue => ({
  id: "checkout",
  file: "/suite/stories/checkout.yaml",
  story: "Buy one thing.",
  mode: "journey",
  success: [],
  perf: {},
  env: { driver: "web", base_url: "http://app.test", cookies: null },
  ...over,
});

const emit = (over: LegacyTestValue = {}, envelopes: LegacyTestValue[] = []): LegacyTestValue => exportSpec({ caseCfg: webCase(over), envelopes });

// ---------- verbs ----------

test("click emits page.locator(<saved string>).click()", () => {
  const { code } = emit({}, [step(1, "click", {}, '[data-testid="buy"]')]);
  assert.match(code, /await page\.locator\("\[data-testid=\\"buy\\"\]"\)\.click\(\);/);
});

test("type emits fill; submit adds a separate Enter press", () => {
  const plain = emit({}, [step(1, "type", { text: "milk" }, "#q")]).code;
  assert.match(plain, /await page\.locator\("#q"\)\.fill\("milk"\);/);
  assert.doesNotMatch(plain, /press\("Enter"\)/);

  const submitted = emit({}, [step(1, "type", { text: "milk", submit: true }, "#q")]).code;
  assert.match(submitted, /\.fill\("milk"\);/);
  assert.match(submitted, /await page\.locator\("#q"\)\.press\("Enter"\);/);
});

test("select mirrors the harness's coercion and label-then-value fallback", () => {
  const { code } = emit({}, [step(1, "select", { value: "High" }, "#p")]);
  assert.match(code, /evaluate\(\(el\) => el\.tagName\) !== "SELECT"/);
  assert.match(code, /await page\.locator\("#p"\)\.click\(\);/);
  assert.match(code, /\.selectOption\(\{ label: "High" \}\)/);
  assert.match(code, /\.catch\(\(\) => page\.locator\("#p"\)\.selectOption\("High"\)\);/);
});

test("scroll with a locator walks to the nearest scrollable ancestor, wheel fallback; direction sets the sign", () => {
  const down = emit({}, [step(1, "scroll", { direction: "down" }, "#panel")]).code;
  assert.match(down, /await page\.locator\("#panel"\)\.evaluate\(\(el, d\) => \{/);
  assert.match(down, /for \(let n = el; n; n = n\.parentElement\)/);
  assert.match(down, /n\.scrollBy\(0, d\);/);
  assert.match(down, /\}, 600\)\)\) await page\.mouse\.wheel\(0, 600\);/);
  const up = emit({}, [step(1, "scroll", { direction: "up" }, "#panel")]).code;
  assert.match(up, /\}, -600\)\)\) await page\.mouse\.wheel\(0, -600\);/);
});

test("scroll without a locator falls back to the wheel and is flagged approximate", () => {
  const { code, notes } = emit({}, [step(1, "scroll", { direction: "down" })]);
  assert.match(code, /await page\.mouse\.wheel\(0, 600\);/);
  assert.match(code, /APPROXIMATE/);
  assert.match(code, /pickScrollTarget/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /step 1: an unanchored scroll is approximated/);
});

test("navigate resolves the url against BASE_URL, like the driver", () => {
  const { code } = emit({}, [step(1, "navigate", { url: "/cart" })]);
  assert.match(code, /await page\.goto\(new URL\("\/cart", BASE_URL\)\.href\);/);
});

test("back emits goBack", () => {
  assert.match(emit({}, [step(1, "back")]).code, /await page\.goBack\(\);/);
});

test("wait converts to ms and clamps to the driver's 0.1s–10s window", () => {
  assert.match(emit({}, [step(1, "wait", { seconds: 0.3 })]).code, /waitForTimeout\(300\);/);
  assert.match(emit({}, [step(1, "wait", { seconds: 99 })]).code, /waitForTimeout\(10000\);/);
  assert.match(emit({}, [step(1, "wait", { seconds: 0 })]).code, /waitForTimeout\(1000\);/);
});

test("terminal done/give_up steps never appear (actionTrack excludes them)", () => {
  const envelopes = [
    step(1, "click", {}, "#a"),
    { step: 2, agent: { thought: "finished", action: { type: "done" } }, result: { ok: true } },
    { step: 3, agent: { thought: "stuck", action: { type: "give_up" } }, result: { ok: true } },
  ];
  const { code } = emit({}, envelopes);
  assert.match(code, /step 1 · click/);
  assert.doesNotMatch(code, /step 2/);
  assert.doesNotMatch(code, /give_up/);
});

test("a failed step is not exported — only the executed path is", () => {
  const failed = { ...step(1, "click", {}, "#a"), result: { ok: false, error: "nope" } };
  const { code } = emit({}, [failed, step(2, "click", {}, "#b")]);
  assert.doesNotMatch(code, /"#a"/);
  assert.match(code, /"#b"/);
});

test("an unknown verb is commented, never silently dropped", () => {
  const { code, notes } = emit({}, [step(1, "teleport", {}, "#a")]);
  assert.match(code, /NOT EXPORTED: unsupported action "teleport"/);
  assert.match(notes[0], /has no Playwright translation/);
});

// ---------- escaping (the main correctness risk) ----------

test("a locator carrying both quote kinds and a backslash survives", () => {
  const nasty = `text="he said \\"hi\\"" >> css=[title='a\\\\b']`;
  const { code } = emit({}, [step(1, "click", {}, nasty)]);
  // The emitted literal must round-trip back to the exact saved string.
  const literal = code.match(/page\.locator\((".*?[^\\]")\)\.click\(\)/)[1];
  assert.equal(JSON.parse(literal), nasty);
});

test("typed text with newlines, backticks and ${} is escaped, not interpolated", () => {
  const text = "line1\nline2 `tick` ${injected}";
  const { code } = emit({}, [step(1, "type", { text }, "#q")]);
  const literal = code.match(/\.fill\((".*?[^\\]")\);/)[1];
  assert.equal(JSON.parse(literal), text);
  // The newline must be escaped INTO the literal, never break the statement
  // across physical lines (which would not parse).
  const fillLines = code.split("\n").filter((l: string) => l.includes(".fill("));
  assert.equal(fillLines.length, 1);
  assert.ok(fillLines[0].includes("\\n"), "the newline is escaped, not literal");
});

test("a thought is flattened to one line and truncated in the step comment", () => {
  const thought = `first\nsecond */ still a comment ${"x".repeat(200)}`;
  const { code } = emit({}, [step(1, "click", {}, "#a", thought)]);
  const commentLine = code.split("\n").find((l: string) => l.includes("step 1 · click"));
  assert.ok(!commentLine.includes("\n"));
  assert.ok(commentLine.length < 160, `comment not truncated: ${commentLine.length}`);
  assert.match(commentLine, /…$/);
});

test("the case id and story reach the file as escaped literals", () => {
  const { code } = emit({ id: 'weird "quoted" id', story: 'a "quoted" story' }, []);
  assert.match(code, /test\("weird \\"quoted\\" id"/);
});

// ---------- gate translation ----------

test("url_matches compiles the same glob the gate does and checks url OR pathname", () => {
  const { code } = emit({ success: [{ url_matches: "/order/*" }] });
  assert.match(code, /function globToRegExp/);
  assert.match(code, /const urlRe1 = globToRegExp\("\/order\/\*"\);/);
  assert.match(code, /urlRe1\.test\(url\) \|\| \(pathname !== null && urlRe1\.test\(pathname\)\)/);
});

test("element_exists mirrors the gate's count() > 0, not visibility", () => {
  const { code } = emit({ success: [{ element_exists: "#done" }] });
  assert.match(code, /await expect\(page\.locator\("#done"\)\)\.not\.toHaveCount\(0\);/);
  assert.doesNotMatch(code, /toBeVisible/);
});

test("api_called matches method + pathname glob against a request collector", () => {
  const { code } = emit({ success: [{ api_called: "post /api/todos" }] });
  assert.match(code, /const requests: \{ method: string; path: string \}\[\] = \[\];/);
  assert.match(code, /const apiRe1 = globToRegExp\("\/api\/todos"\);/);
  assert.match(code, /r\.method\.toUpperCase\(\) === "POST" && apiRe1\.test\(r\.path\)/);
});

test("api_called without a path glob is commented, not compiled to a matching-nothing regex", () => {
  const { code, notes } = emit({ success: [{ api_called: "POST" }] });
  assert.match(code, /NOT EXPORTED: api_called is missing a path glob/);
  assert.match(notes[0], /missing a path glob/);
});

test("console_errors becomes a hard assertion and says so", () => {
  const { code } = emit({ success: [{ console_errors: 2 }] });
  assert.match(code, /let consoleErrors = 0;/);
  assert.match(code, /page\.on\("pageerror"/);
  assert.match(code, /Soft \(advisory\) in Playtest; HARD here/);
  assert.match(code, /expect\(consoleErrors\)\.toBeLessThanOrEqual\(2\);/);
});

test("assert becomes a visible annotation, never a silent drop", () => {
  const claim = 'the basket shows one item';
  const { code, notes } = emit({ success: [{ assert: claim }] });
  assert.match(code, /UNCHECKED — an LLM judges this in Playtest/);
  assert.match(code, /type: "playtest-assert"/);
  assert.match(code, new RegExp(`description: ${JSON.stringify(JSON.stringify(claim)).slice(1, -1)}`));
  assert.match(notes[0], /LLM-judged/);
});

test("accessibility_violations is a comment pointing at axe, plus a note", () => {
  const { code, notes } = emit({ success: [{ accessibility_violations: 0 }] });
  assert.match(code, /NOT EXPORTED: Playtest counts WCAG violations/);
  assert.match(code, /@axe-core\/playwright/);
  assert.match(notes[0], /accessibility_violations/);
});

test("perf thresholds are comments plus notes", () => {
  const { code, notes } = emit({ perf: { lcp_ms: "< 2500" } });
  assert.match(code, /NOT EXPORTED — perf budget.*perf\.lcp_ms < 2500/);
  assert.match(notes[0], /perf\.lcp_ms/);
});

test("a custom assertion key names its owning module", () => {
  const routing = new Map([["inbox_has", { name: "mailbox", assertion: {} }]]);
  const { code, notes } = emit({ success: [{ inbox_has: "welcome" }], _assertions: { routing } });
  assert.match(code, /NOT EXPORTED: custom assertion "inbox_has" — see assertions\/mailbox\//);
  assert.match(notes[0], /module mailbox/);
});

test("every declared criterion appears in the output — zero silent drops", () => {
  const success = [
    { url_matches: "/done" },
    { element_exists: "#x" },
    { api_called: "GET /a" },
    { console_errors: 0 },
    { assert: "it looks right" },
    { accessibility_violations: 1 },
  ];
  const { code } = emit({ success, perf: { lcp_ms: "< 2500" } });
  for (const c of success) {
    const [kind, value] = Object.entries(c)[0]!; // TODO(ts): every criterion fixture has exactly one key
    assert.ok(code.includes(`// ${kind}: ${value}`), `${kind} is missing from the spec`);
  }
  assert.ok(code.includes("perf.lcp_ms"));
});

test("a criterion label rides along as a comment", () => {
  const { code } = emit({ success: [{ url_matches: "/done", label: "lands on the receipt" }] });
  assert.match(code, /\/\/ \(lands on the receipt\)/);
});

// ---------- session setup ----------

test("collectors are only emitted when the gate needs them", () => {
  const bare = emit({ success: [{ element_exists: "#x" }] }).code;
  assert.doesNotMatch(bare, /const requests/);
  assert.doesNotMatch(bare, /let consoleErrors/);
  assert.doesNotMatch(bare, /function globToRegExp/);
  // ...and `context` stays out of the fixture list when there are no cookies,
  // so a strict consumer tsconfig does not flag an unused binding.
  assert.match(bare, /async \(\{ page \}\)/);
});

test("cookies are added to the context before the first navigation", () => {
  const cookies = [{ name: "sid", value: "abc" }, { name: "tz", value: "UTC" }];
  const { code } = emit({ env: { driver: "web", base_url: "http://app.test", cookies } });
  assert.match(code, /async \(\{ page, context \}\)/);
  assert.match(code, /await context\.addCookies\(\[/);
  assert.match(code, /\{ name: "sid", value: "abc", url: BASE_URL \},/);
  // ordering: cookies must precede the goto
  assert.ok(code.indexOf("addCookies") < code.indexOf("await page.goto(BASE_URL)"));
});

test("BASE_URL defaults to the case's base_url and stays env-overridable", () => {
  const { code } = emit();
  assert.match(code, /const BASE_URL = process\.env\.PLAYTEST_BASE_URL \?\? "http:\/\/app\.test";/);
});

// ---------- header and framing ----------

test("the header states the one-way contract unmissably", () => {
  const meta = {
    run_id: "2026-06-10T0300-ab12",
    accepted_at: "2026-06-10T03:04:05.000Z",
    story_hash: "deadbeefcafe0001",
    pins: { prompts_version: "prompts-v9", step_schema_version: 7, actor_model: "sonnet" },
  };
  const { code } = exportSpec({ caseCfg: webCase(), envelopes: [step(1, "click", {}, "#a")], meta, sourcePath: "stories/checkout.yaml" });
  assert.match(code, /GENERATED by `playtest export` — do not edit\./);
  assert.match(code, /ONE-WAY snapshot/);
  assert.match(code, /will NOT heal/);
  assert.match(code, /playtest export stories\/checkout\.yaml/);
  assert.match(code, /Baseline run: 2026-06-10T0300-ab12 \(accepted 2026-06-10T03:04:05\.000Z\)/);
  assert.match(code, /Pins:\s+prompts-v9 · step_schema 7 · actor sonnet/);
  assert.match(code, /Contents:\s+1 recorded step\(s\), 0 success criterion\(a\)/);
});

test("a baseline with no actable steps still emits a valid, honest spec", () => {
  const { code } = emit({ success: [{ url_matches: "/x" }] }, [
    { step: 1, agent: { thought: "already there", action: { type: "done" } }, result: { ok: true } },
  ]);
  assert.match(code, /the actor finished this journey without acting on the page/);
  assert.match(code, /globToRegExp/); // the gate still runs
});

test("a case with no success criteria says so rather than emitting an empty block", () => {
  const { code } = emit({}, [step(1, "click", {}, "#a")]);
  assert.match(code, /this case declares no success criteria/);
});

// ---------- filenames ----------

test("specFilename keeps nested ids as paths and sanitizes the rest", () => {
  assert.equal(specFilename("checkout"), "checkout.spec.ts");
  assert.equal(specFilename("cart/guest-checkout"), "cart/guest-checkout.spec.ts");
  assert.equal(specFilename("signup@impatient"), "signup-impatient.spec.ts");
  // no traversal out of --out, whatever the id looks like
  assert.equal(specFilename("../../etc/passwd"), "etc/passwd.spec.ts");
  assert.equal(specFilename("a b:c"), "a-b-c.spec.ts");
});
