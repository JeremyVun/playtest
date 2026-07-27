/**
 * Durable tests for the home-loan applicant capture fixture.
 * Standalone — not wired into the hermetic root npm test gate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const ISSUES_PATH = path.join(__dirname, "ISSUES.md");

async function readText(filePath) {
  return fs.promises.readFile(filePath, "utf8");
}

test("server boots, serves loan UI, and accepts applications", async (t) => {
  const server = await start({ port: 0, host: "127.0.0.1" });
  t.after(async () => {
    await server.close();
  });

  assert.ok(server.port > 0, "binds an ephemeral port");
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const home = await fetch(server.url + "/");
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Home loan/i, "landing heading present");
  assert.match(html, /first-name|First name/i, "identity control present");
  assert.match(html, /id="start-btn"|start-application/i, "start control present");
  assert.match(html, /form-identity|form-contact|form-property/i, "wizard forms present");

  const css = await fetch(server.url + "/styles.css");
  assert.equal(css.status, 200);
  assert.match(await css.text(), /\*:focus/);

  const js = await fetch(server.url + "/app.js");
  assert.equal(js.status, 200);
  const appJs = await js.text();
  assert.match(appJs, /\/api\/applications/, "client posts applications");
  assert.match(appJs, /showStep\(5\)/, "success step reachable");

  const payload = {
    identity: {
      firstName: "Ada",
      lastName: "Lovelace",
      dob: "12/10/1815",
      ssn: "123-45-6789",
      income: "8000",
    },
    contact: {
      email: "ada@example.com",
      emailConfirm: "ada@example.com",
      phone: "555-0100",
      address: "1 Analytical Engine Way",
      city: "London",
      state: "OR",
      zip: "97201",
    },
    property: {
      propertyValue: "450000",
      loanAmount: "360000",
      purpose: "purchase",
      consent: true,
    },
  };

  const post = await fetch(server.url + "/api/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(post.status, 200);
  const body = await post.json();
  assert.equal(body.ok, true);
  assert.equal(body.message, "received");
  assert.match(String(body.reference), /^HL-/);
  assert.deepEqual(body.echo.identity.firstName, "Ada");

  // Double submit still succeeds (documents LOAN-024 server-side amenability)
  const post2 = await fetch(server.url + "/api/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body2 = await post2.json();
  assert.equal(body2.ok, true);
  assert.notEqual(body2.reference, body.reference);
});

test("static sources contain key planted defect markers", async () => {
  const html = await readText(path.join(PUBLIC, "index.html"));
  const css = await readText(path.join(PUBLIC, "styles.css"));
  const js = await readText(path.join(PUBLIC, "app.js"));
  const all = html + "\n" + css + "\n" + js;

  // LOAN-001 — Mortage/mortage in brand, lede, consent, footer
  assert.match(html, /class="brand-name">Northbridge Mortage</);
  assert.match(html, /residential mortage/);
  assert.match(html, /Northbridge Mortage processing/);
  assert.match(html, /© Northbridge Mortage/);
  // LOAN-002
  assert.match(html, />Click here</);
  // LOAN-003
  assert.match(css, /#d5d0c6/);
  assert.match(css, /left:\s*-9999px/);
  // LOAN-004
  assert.match(html, /id="cancel-btn"[^>]*btn-primary|btn-primary[^>]*id="cancel-btn"/);
  assert.match(html, /id="submit-btn"[^>]*btn-muted|btn-muted[^>]*id="submit-btn"/);
  // LOAN-005
  assert.match(html, /pseudo-label/);
  assert.doesNotMatch(
    html.replace(/\s+/g, " "),
    /<label[^>]*for=["']email["']/,
    "email must not have a proper label for="
  );
  // LOAN-006
  assert.match(css, /\*:focus\s*\{[^}]*outline:\s*none\s*!important/s);
  // LOAN-007 — phone validation only checks non-empty (marker comment + logic)
  assert.match(js, /LOAN-007|phone accepts any non-empty/i);
  // LOAN-008
  assert.match(js, /First name is required/);
  assert.match(js, /setError\(last,\s*"First name is required/);
  // LOAN-009
  assert.match(html, /Monthly income/);
  assert.match(html, /full year salary/);
  // LOAN-010 — first-comma-only strip; multi-comma amounts must NaN
  assert.match(js, /replace\(",",\s*""\)/);
  {
    const m = js.match(/function parseMoney\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    assert.ok(m, "parseMoney function body extractable from app.js");
    const parseMoney = new Function(`${m[0]}; return parseMoney;`)();
    assert.equal(parseMoney("450,000"), 450000);
    assert.equal(parseMoney("450000"), 450000);
    assert.ok(Number.isNaN(parseMoney("1,250,000")));
    assert.ok(Number.isNaN(parseMoney("1,000,000")));
  }

  // LOAN-030 / LOAN-034 — parseDob M/D/YYYY only; year must be <= 2020
  {
    const m = js.match(/function parseDob\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    assert.ok(m, "parseDob function body extractable from app.js");
    const parseDob = new Function(`${m[0]}; return parseDob;`)();
    const iso = parseDob("1988-03-15");
    assert.equal(iso.ok, false);
    assert.match(String(iso.error), /M\/D\/YYYY/);
    const mdY = parseDob("3/15/1988");
    assert.equal(mdY.ok, true);
    const after2020 = parseDob("1/1/2021");
    assert.equal(after2020.ok, false);
    assert.match(String(after2020.error), /2020/);
    const at2020 = parseDob("1/1/2020");
    assert.equal(at2020.ok, true);
  }
  // LOAN-011
  assert.match(js, /form\.reset\(\)/);
  assert.match(js, /LOAN-011|wipes contact/i);
  // LOAN-012
  assert.match(html, /data-step="1"[^>]*>[\s\S]*Contact/i);
  assert.match(js, /activeTarget\s*=\s*Math\.min\(step\s*\+\s*1/);
  // LOAN-013
  assert.match(html, /consent-text/);
  assert.doesNotMatch(html, /<label[^>]*for=["']consent["']/);
  // LOAN-014
  assert.match(js, /setError\(prop,\s*""\)/);
  // LOAN-015
  assert.match(html, /id="zip"[^>]*type="number"|type="number"[^>]*id="zip"/);
  // LOAN-016
  assert.match(html, /id="fake-next"/);
  assert.match(js, /fake-next[\s\S]*focus/);
  // LOAN-017
  assert.match(html, /Application denined/);
  // LOAN-018
  assert.match(css, /140px/);
  assert.match(css, /overflow:\s*hidden/);
  // LOAN-019
  assert.match(html, /id="ssn"[^>]*type="password"|type="password"[^>]*id="ssn"/);
  // LOAN-020
  assert.match(html, /value="TX"/);
  assert.doesNotMatch(html, /value="AK"/);
  assert.doesNotMatch(html, /value="HI"/);
  assert.doesNotMatch(html, /value="DC"/);
  // LOAN-021
  assert.match(js, /must be at least \$0/);
  assert.match(js, /v\s*<\s*50000/);
  // LOAN-022
  assert.match(html, /tabindex="99"/);
  // LOAN-023
  assert.match(css, /income-field[\s\S]*overflow:\s*hidden|overflow:\s*hidden[\s\S]*income/i);
  // LOAN-024
  assert.match(js, /LOAN-024|does NOT disable submit/i);
  // LOAN-025
  assert.match(js, /LOAN-025|never compared to email/i);
  // LOAN-026
  assert.match(html, /<title>Portal<\/title>/);
  // LOAN-027
  assert.match(html, /href="#dead"/);
  // LOAN-028
  assert.match(html, /are optional/);
  // LOAN-029
  assert.match(html, /2 minutes/);
  // LOAN-030 / LOAN-034
  assert.match(js, /M\/D\/YYYY/);
  assert.match(js, /year\s*>\s*2020/);
  // LOAN-031
  const oregonCount = (html.match(/value="OR"/g) || []).length;
  assert.ok(oregonCount >= 2, "duplicate Oregon options");
  // LOAN-032
  assert.match(js, /LOAN-032|omits SSN and phone/i);
  // LOAN-033
  assert.match(html, /bussiness days/);

  // LOAN-035 — Cancel soft-exits without reset
  assert.match(js, /LOAN-035|Cancel only returns to landing/i);
  assert.match(js, /cancel-btn[\s\S]*showStep\(0\)/);

  // Ensure a broad set of LOAN markers appear in sources or ISSUES
  void all;
});

test("ISSUES.md documents at least 15 LOAN defects with categories", async () => {
  const md = await readText(ISSUES_PATH);
  const ids = [...md.matchAll(/##\s+(LOAN-\d+)\b/g)].map((m) => m[1]);
  assert.ok(ids.length >= 15, `expected >= 15 LOAN entries, got ${ids.length}`);
  assert.ok(ids.length >= 20, `aim for 20+; got ${ids.length}`);

  // Unique ids
  assert.equal(new Set(ids).size, ids.length, "LOAN ids should be unique");

  // Each entry should mention a category marker nearby
  let withCategory = 0;
  for (const id of ids) {
    const idx = md.indexOf(`## ${id}`);
    assert.ok(idx >= 0, id);
    const slice = md.slice(idx, idx + 800);
    if (/\*\*Category:\*\*/i.test(slice) || /Category:/i.test(slice)) {
      withCategory += 1;
    }
    assert.match(slice, /\*\*Where:\*\*|\*\*Repro:\*\*|\*\*Wrong behavior:\*\*/i);
  }
  assert.ok(withCategory >= 15, "entries need category fields");

  // Category diversity
  const categories = ["copy", "UX", "a11y", "UI", "form", "CSS"];
  const present = categories.filter((c) => new RegExp(c, "i").test(md));
  assert.ok(present.length >= 4, `expected >=4 categories, saw ${present.join(",")}`);
});

test("README documents start command and default URL", async () => {
  const readme = await readText(path.join(__dirname, "README.md"));
  assert.match(readme, /node tests\/app-fixture\/server\.js/);
  assert.match(readme, /4191/);
  assert.match(readme, /ISSUES\.md/);
});
