// P0 FIXTURE CORPUS — scrubbed, explicit run-evidence fixtures that freeze the
// findings intake + semantic consolidation behavior described in
// docs/contracts/hosted.md (see tests/core/findings/README.md).
//
// Vocabulary (frozen — see ./README.md):
//   - actor raise      : a structured sticky note on one step (envelope.raises[])
//   - grader finding   : a free-form UX/quality observation in one grade.json
//   - bug candidate    : a grounded, typed claim the app malfunctioned (D3)
//   - platform finding : a durable cross-run defect with identity + evidence
//
// Each fixture carries:
//   - runs[]        : faithful recorded evidence (step envelopes + actor raises +
//                     grade.json grader findings) with run-specific ids/numbers/
//                     timestamps PRESENT so normalization (spec.ts) is exercised.
//   - candidates[]  : the bug candidate(s) the grader is expected to emit (D3
//                     shape). role "finding" marks a candidate already promoted
//                     to a platform finding (the prior run); role "candidate"
//                     marks the incoming, still-unassigned candidate.
//   - expected      : the recorded expected outcome (classification, strict/loose
//                     exact-key match/miss, shortlist neighbors, semantic
//                     grouping, evidence preservation, reviewer label, routing).
//
// The runtime engine does not consume this file. It is fixture + expected data
// for the offline evaluator (./evaluator.ts) and its tests.
import type { FindingItem } from "./spec.ts";

const PROJECT = "proj_shop";

interface Raise {
  kind: string;
  note: string;
  severity: string;
}

interface EnvelopeSpec {
  mode?: string;
  ok?: boolean;
  error?: string | null;
  settle_ms?: number;
  url?: string;
  thought?: string;
  action?: { type: string; summary?: string; [key: string]: unknown };
  expectation?: string;
  raises?: Raise[];
  resolution?: Record<string, unknown>;
  perf?: Record<string, unknown>;
  requests?: Array<Record<string, unknown>>;
  console_errors?: Array<Record<string, unknown>>;
  confusion?: Record<string, unknown>;
}

interface Envelope {
  step: number;
  schema_version: number;
  ts: number;
  mode: string;
  result: { ok: boolean; error: string | null; settle_ms: number; url?: string };
  agent?: { thought?: string; action?: { type: string; summary?: string; [key: string]: unknown }; expectation?: string; raises?: Raise[] };
  raises?: Raise[];
  resolution?: Record<string, unknown>;
  perf?: Record<string, unknown>;
  network?: { requests: Array<Record<string, unknown>> };
  console_errors?: Array<Record<string, unknown>>;
  confusion?: Record<string, unknown>;
}

interface GradeFinding {
  severity: string;
  note: string;
  step: number;
}

interface Grade {
  score: number;
  completion: string;
  efficiency: { assessment: string; wasted_steps: number };
  findings: GradeFinding[];
  summary: string;
  model: string;
  graded_at: string;
  tokens: { in: number; out: number; cache_read: number };
  report?: unknown;
  [key: string]: unknown;
}

export interface CorpusCandidate extends FindingItem {
  run_id: string;
  persona: string;
  severity: string;
  evidence_steps: number[];
  signals: string[];
}

interface CandidateExpectation {
  classification: string;
  reviewer_label: string;
}

interface CorpusExpected {
  per_candidate: Record<string, CandidateExpectation>;
  exact_key: { incoming: string; existing: string; strict: boolean; loose: boolean } | null;
  grouping: string[][];
  evidence_rows: number;
  routing: Record<string, string>;
  shortlist: Array<{ of: string; must_include: string[]; must_exclude: string[] }>;
  ux_only: CandidateExpectation;
  actor_claim_is_evidence: boolean;
  [key: string]: unknown;
}

export interface CorpusFixture {
  id: string;
  description: string;
  seeded: boolean;
  runs: Array<{
    run_id: string;
    project_id: string;
    story_id: string;
    case_id: string;
    persona: string;
    envelopes: Envelope[];
    grade: Grade;
  }>;
  candidates: CorpusCandidate[];
  expected: CorpusExpected;
}

let tsSeed = Date.parse("2026-07-20T09:00:00Z");
function nextTs() {
  tsSeed += 1379; // irregular, run-specific
  return tsSeed;
}

/** Build one faithful step envelope (docs/contracts/artifacts.md#step-envelope). */
function env(step: number, spec: EnvelopeSpec) {
  const e: Envelope = {
    step,
    schema_version: 7,
    ts: nextTs(),
    mode: spec.mode || "agent",
    result: {
      ok: spec.ok !== false,
      error: spec.error ?? null,
      settle_ms: spec.settle_ms ?? 40 + step * 7,
      url: spec.url,
    },
  };
  if (e.mode === "agent") {
    e.agent = {
      thought: spec.thought,
      action: spec.action,
      expectation: spec.expectation,
    };
    if (spec.raises) {
      e.agent.raises = spec.raises;
      e.raises = spec.raises; // normalized copy (artifacts.md)
    }
  }
  if (spec.resolution) e.resolution = spec.resolution;
  e.perf = spec.perf ?? { input_to_paint_ms: 60 + step, long_tasks_ms: 0, requests: (spec.requests || []).length, js_errors: (spec.console_errors || []).length, nav: null };
  e.network = { requests: spec.requests || [] };
  if (spec.console_errors) e.console_errors = spec.console_errors;
  if (spec.confusion) e.confusion = spec.confusion;
  return e;
}

function req(method: string, path: string, status: number, { host = "http://shop.local" }: { host?: string } = {}) {
  return { method, url: `${host}${path}`, path, status, mime_type: "application/json", failed: status >= 500 };
}

/** A minimal but real grade.json (docs/contracts/artifacts.md#grade-artifact). */
function grade({ score, completion = "partial", findings = [], summary, report }: {
  score: number;
  completion?: string;
  findings?: GradeFinding[];
  summary: string;
  report?: unknown;
}) {
  const g: Grade = {
    score,
    completion,
    efficiency: { assessment: "reasonable for the task", wasted_steps: 0 },
    findings,
    summary,
    model: "grader-fixture",
    graded_at: "2026-07-20T09:30:00.000Z",
    tokens: { in: 2100, out: 180, cache_read: 1600 },
  };
  if (report) g.report = report;
  return g;
}

// ===========================================================================
// F1 — exact recurrence with noisy ids/numbers. Same story hits the same
// server error twice; run-specific item ids/timestamps must normalize away.
// ===========================================================================
const F1 = {
  id: "exact-recurrence-noisy-ids",
  description: "Same story removes a cart line item and the DELETE 500s on two runs with different item ids.",
  seeded: true,
  runs: [
    {
      run_id: "2026-07-20T0901-a1f0", project_id: PROJECT, story_id: "cart/remove-line-item", case_id: "cart/remove-line-item", persona: "adversarial",
      envelopes: [
        env(1, { url: "http://shop.local/cart", thought: "Cart shows two lines; remove the first.", action: { type: "click", ref: "e7" }, expectation: "the line disappears and the total drops", resolution: { ref: "e7", locator: 'role=button[name="Remove"]', bbox: { x: 610, y: 300, w: 90, h: 30 } } }),
        env(2, { url: "http://shop.local/cart", ok: true, thought: "The remove request failed with a server error and the line stayed.", action: { type: "give_up", reason: "removing a cart line returns a 500 and the item stays" }, expectation: "n/a", requests: [req("DELETE", "/api/cart/items/8842", 500)], console_errors: [{ type: "console", text: "DELETE /api/cart/items/8842 500 (request id 7f3a91c0e5b2)" }], raises: [{ kind: "finding", note: '"Remove" returns a 500 and the item is still in the cart', severity: "major" }] }),
      ],
      grade: grade({ score: 28, completion: "none", summary: "Removing a cart line item failed with a server error.", findings: [{ severity: "major", note: "Remove control on the cart returns a 500 and the line stays", step: 2 }] }),
    },
    {
      run_id: "2026-07-20T1147-b3c8", project_id: PROJECT, story_id: "cart/remove-line-item", case_id: "cart/remove-line-item", persona: "careful-first-timer",
      envelopes: [
        env(1, { url: "http://shop.local/cart", thought: "Try to remove the second line.", action: { type: "click", ref: "e9" }, expectation: "the line goes away", resolution: { ref: "e9", locator: 'role=button[name="Remove"]', bbox: { x: 610, y: 360, w: 90, h: 30 } } }),
        env(2, { url: "http://shop.local/cart", ok: true, thought: "Same failure — server error, line remains.", action: { type: "give_up", reason: "remove line returns 500 again" }, expectation: "n/a", requests: [req("DELETE", "/api/cart/items/91307", 500)], console_errors: [{ type: "console", text: "DELETE /api/cart/items/91307 500 (request id a02bd4419fce)" }], raises: [{ kind: "finding", note: "removing a line still 500s", severity: "major" }] }),
      ],
      grade: grade({ score: 25, completion: "none", summary: "Cart line removal still errors.", findings: [{ severity: "major", note: "Removing a cart line returns a server error", step: 2 }] }),
    },
  ],
  candidates: [
    { id: "f1-existing", role: "finding", run_id: "2026-07-20T0901-a1f0", project_id: PROJECT, story_id: "cart/remove-line-item", persona: "adversarial", kind: "http_error", severity: "major", title: "Removing a cart line item returns a server error", expected: "the cart line is removed and the total decreases", observed: "the DELETE request returned 500 and the line stayed in the cart", evidence_steps: [2], signals: ["http_5xx"], signal_type: "http_error", locus: { route: "/api/cart/items/8842", step_locus: "role=button[name=Remove]", status_class: "5xx" } },
    { id: "f1-incoming", role: "candidate", run_id: "2026-07-20T1147-b3c8", project_id: PROJECT, story_id: "cart/remove-line-item", persona: "careful-first-timer", kind: "http_error", severity: "major", title: "Cart line removal fails with a 500", expected: "the selected cart line is removed", observed: "the delete endpoint returned a 500 and the line remained", evidence_steps: [2], signals: ["http_5xx"], signal_type: "http_error", locus: { route: "/api/cart/items/91307", step_locus: "role=button[name=Remove]", status_class: "5xx" } },
  ],
  expected: {
    per_candidate: {
      "f1-incoming": { classification: "bug_candidate", reviewer_label: "accept" },
    },
    exact_key: { incoming: "f1-incoming", existing: "f1-existing", strict: true, loose: true },
    grouping: [["f1-existing", "f1-incoming"]],
    evidence_rows: 2,
    routing: { "f1-incoming": "append" },
    shortlist: [],
  },
};

// ===========================================================================
// F2 — same defect described differently by two personas. Coupon applies but
// the total never updates. No deterministic signal (a claim from prose), so no
// exact keys; the reworded duplicate must converge via the shortlist.
// ===========================================================================
const F2 = {
  id: "reworded-personas-duplicate",
  description: "Two personas of one story report the same stale-total-after-coupon defect in different words.",
  seeded: true,
  runs: [
    {
      run_id: "2026-07-21T0812-c401", project_id: PROJECT, story_id: "checkout/apply-coupon", case_id: "checkout/apply-coupon", persona: "adversarial",
      envelopes: [
        env(1, { url: "http://shop.local/checkout", thought: "Type the promo code SAVE20 into the coupon box.", action: { type: "type", ref: "e4", text: "SAVE20", submit: true }, expectation: "the discount is applied and the order total drops", resolution: { ref: "e4", locator: "#coupon-code", bbox: { x: 120, y: 210, w: 200, h: 32 } } }),
        env(2, { url: "http://shop.local/checkout", thought: "It says coupon accepted but the total is unchanged at $148.00.", action: { type: "give_up", reason: "coupon accepted yet total unchanged" }, expectation: "n/a", raises: [{ kind: "finding", note: '"Coupon applied" banner shows but the order total is still $148.00', severity: "major" }] }),
      ],
      grade: grade({ score: 34, completion: "partial", summary: "Coupon reported as applied but the total did not change.", findings: [{ severity: "major", note: "Applying SAVE20 shows a success banner but the order total stays the same", step: 2 }] }),
    },
    {
      run_id: "2026-07-21T1533-d927", project_id: PROJECT, story_id: "checkout/apply-coupon", case_id: "checkout/apply-coupon", persona: "careful-first-timer",
      envelopes: [
        env(1, { url: "http://shop.local/checkout", thought: "Enter the discount code in the cart summary panel.", action: { type: "type", ref: "e11", text: "SAVE20", submit: true }, expectation: "the amount due is reduced by the discount", resolution: { ref: "e11", locator: ".cart-summary input.promo", bbox: { x: 720, y: 190, w: 180, h: 30 } } }),
        env(2, { url: "http://shop.local/checkout", thought: "The amount I owe did not go down after the discount.", action: { type: "give_up", reason: "amount due unchanged after discount" }, expectation: "n/a", raises: [{ kind: "finding", note: "the amount due stayed at $148.00 even though the discount registered", severity: "major" }] }),
      ],
      grade: grade({ score: 31, completion: "partial", summary: "Discount registered but the amount due was not recalculated.", findings: [{ severity: "major", note: "The amount due does not recalculate after a discount code is entered", step: 2 }] }),
    },
  ],
  candidates: [
    { id: "f2-adversarial", role: "candidate", run_id: "2026-07-21T0812-c401", project_id: PROJECT, story_id: "checkout/apply-coupon", persona: "adversarial", kind: "data_mismatch", severity: "major", title: "Coupon applied but order total unchanged", expected: "the order total decreases after the coupon discount is applied", observed: "the coupon applied banner appeared but the order total remained unchanged", evidence_steps: [2], signals: [], signal_type: null, locus: null },
    { id: "f2-careful", role: "candidate", run_id: "2026-07-21T1533-d927", project_id: PROJECT, story_id: "checkout/apply-coupon", persona: "careful-first-timer", kind: "expectation_violation", severity: "major", title: "Coupon discount does not update the order total", expected: "the order total drops once the coupon discount is applied", observed: "the coupon registered but the order total did not update", evidence_steps: [2], signals: [], signal_type: null, locus: null },
  ],
  expected: {
    per_candidate: {
      "f2-adversarial": { classification: "bug_candidate", reviewer_label: "accept" },
      "f2-careful": { classification: "bug_candidate", reviewer_label: "accept" },
    },
    exact_key: null, // neither candidate carries a deterministic signal
    grouping: [["f2-adversarial", "f2-careful"]],
    evidence_rows: 2,
    routing: { "f2-adversarial": "cluster", "f2-careful": "cluster" },
    shortlist: [
      { of: "f2-adversarial", must_include: ["f2-careful"], must_exclude: ["f5-giftcard", "f5-password"] },
      { of: "f2-careful", must_include: ["f2-adversarial"], must_exclude: [] },
    ],
  },
};

// ===========================================================================
// F3 — same defect labeled with different categories by two runs. The shipping
// estimate contradicts the address on both runs and the strict key still
// matches because the model-chosen category never enters a key (D4).
// ===========================================================================
const F3 = {
  id: "cross-category-duplicate",
  description: "One shipping-estimate defect labeled data_mismatch on run A and expectation_violation on run B; the exact key ignores the category.",
  seeded: true,
  runs: [
    {
      run_id: "2026-07-22T1005-e55a", project_id: PROJECT, story_id: "checkout/shipping-estimate", case_id: "checkout/shipping-estimate", persona: "adversarial",
      envelopes: [
        env(1, { url: "http://shop.local/checkout/shipping", thought: "Enter a Denver zip and read the shipping estimate.", action: { type: "type", ref: "e2", text: "80202", submit: true }, expectation: "shipping shows a Denver-area estimate", resolution: { ref: "e2", locator: "#ship-zip", bbox: { x: 140, y: 260, w: 160, h: 30 } } }),
        env(2, { url: "http://shop.local/checkout/shipping", thought: "It shows a New York estimate for a Denver zip.", action: { type: "give_up", reason: "shipping estimate does not match the entered address" }, expectation: "n/a", raises: [{ kind: "finding", note: "shipping estimate reads 'New York, 2 days' for zip 80202 (Denver)", severity: "major" }] }),
      ],
      grade: grade({ score: 40, completion: "partial", summary: "Shipping estimate does not match the entered zip.", findings: [{ severity: "major", note: "The shipping estimate ignores the entered address and shows the wrong region", step: 2 }] }),
    },
    {
      run_id: "2026-07-22T1642-f118", project_id: PROJECT, story_id: "checkout/shipping-estimate", case_id: "checkout/shipping-estimate", persona: "careful-first-timer",
      envelopes: [
        env(1, { url: "http://shop.local/checkout/shipping", thought: "Enter a Miami zip.", action: { type: "type", ref: "e2", text: "33101", submit: true }, expectation: "shipping shows a Miami-area estimate", resolution: { ref: "e2", locator: "#ship-zip", bbox: { x: 140, y: 260, w: 160, h: 30 } } }),
        env(2, { url: "http://shop.local/checkout/shipping", thought: "Estimate still says New York regardless of the zip.", action: { type: "give_up", reason: "shipping estimate wrong for the address" }, expectation: "n/a", raises: [{ kind: "finding", note: "estimate shows 'New York, 2 days' for a Miami zip", severity: "major" }] }),
      ],
      grade: grade({ score: 38, completion: "partial", summary: "Shipping estimate wrong for the address again.", findings: [{ severity: "major", note: "Shipping estimate region does not follow the entered zip", step: 2 }] }),
    },
  ],
  candidates: [
    { id: "f3-existing", role: "finding", run_id: "2026-07-22T1005-e55a", project_id: PROJECT, story_id: "checkout/shipping-estimate", persona: "adversarial", kind: "data_mismatch", severity: "major", title: "Shipping estimate does not match the entered address", expected: "the shipping estimate reflects the entered zip region", observed: "the shipping estimate showed the wrong region for the entered zip", evidence_steps: [2], signals: ["expectation_contradiction"], signal_type: "expectation_contradiction", locus: { route: "/checkout/shipping", step_locus: "#ship-zip shipping-estimate", status_class: "ok" } },
    { id: "f3-incoming", role: "candidate", run_id: "2026-07-22T1642-f118", project_id: PROJECT, story_id: "checkout/shipping-estimate", persona: "careful-first-timer", kind: "expectation_violation", severity: "major", title: "Shipping estimate region ignores the zip", expected: "the shipping estimate region follows the entered zip", observed: "the shipping estimate region did not follow the entered zip", evidence_steps: [2], signals: ["expectation_contradiction"], signal_type: "expectation_contradiction", locus: { route: "/checkout/shipping", step_locus: "#ship-zip shipping-estimate", status_class: "ok" } },
  ],
  expected: {
    per_candidate: {
      "f3-incoming": { classification: "bug_candidate", reviewer_label: "accept" },
    },
    // Category differs (data_mismatch vs expectation_violation) but the strict
    // key matches because category never enters the key.
    exact_key: { incoming: "f3-incoming", existing: "f3-existing", strict: true, loose: true },
    grouping: [["f3-existing", "f3-incoming"]],
    evidence_rows: 2,
    routing: { "f3-incoming": "append" },
    shortlist: [{ of: "f3-incoming", must_include: ["f3-existing"], must_exclude: [] }],
  },
};

// ===========================================================================
// F4 — same defect reached from two different stories (loose-key case). Search
// returns 500 from both a basic-search story and a filter story: same project +
// signal + normalized locus, different story ⇒ strict miss, loose hit.
// ===========================================================================
const F4 = {
  id: "loose-key-two-stories",
  description: "The search endpoint 500s in a basic-search story and a filter story; strict key misses on story, loose key hits.",
  seeded: true,
  runs: [
    {
      run_id: "2026-07-23T0902-1a2b", project_id: PROJECT, story_id: "search/basic-query", case_id: "search/basic-query", persona: "adversarial",
      envelopes: [
        env(1, { url: "http://shop.local/search", thought: "Search for 'fern'.", action: { type: "type", ref: "e1", text: "fern", submit: true }, expectation: "search results list appears", resolution: { ref: "e1", locator: "#q", bbox: { x: 100, y: 60, w: 300, h: 32 } } }),
        env(2, { url: "http://shop.local/search?q=fern", ok: true, thought: "The results endpoint returned a 500.", action: { type: "give_up", reason: "search results endpoint 500s" }, expectation: "n/a", requests: [req("GET", "/api/search?q=fern&_=1690101731", 500)], console_errors: [{ type: "console", text: "GET /api/search 500 (trace 55aa77cc99bb)" }] }),
      ],
      grade: grade({ score: 30, completion: "none", summary: "Search results failed to load.", findings: [{ severity: "major", note: "The search results endpoint returns a 500", step: 2 }] }),
    },
    {
      run_id: "2026-07-23T1418-3c4d", project_id: PROJECT, story_id: "search/filter-by-price", case_id: "search/filter-by-price", persona: "adversarial",
      envelopes: [
        env(1, { url: "http://shop.local/search", thought: "Open search and apply a price filter.", action: { type: "click", ref: "e6" }, expectation: "filtered results appear", resolution: { ref: "e6", locator: 'role=button[name="Under $25"]', bbox: { x: 200, y: 120, w: 110, h: 30 } } }),
        env(2, { url: "http://shop.local/search?price=lt25", ok: true, thought: "Same 500 from the results endpoint.", action: { type: "give_up", reason: "filtered search 500s" }, expectation: "n/a", requests: [req("GET", "/api/search?price=lt25&_=1690129082", 500)], console_errors: [{ type: "console", text: "GET /api/search 500 (trace 42bd18fe0a71)" }] }),
      ],
      grade: grade({ score: 29, completion: "none", summary: "Filtered search failed to load.", findings: [{ severity: "major", note: "Search endpoint returns a 500 when a filter is applied", step: 2 }] }),
    },
  ],
  candidates: [
    { id: "f4-existing", role: "finding", run_id: "2026-07-23T0902-1a2b", project_id: PROJECT, story_id: "search/basic-query", persona: "adversarial", kind: "http_error", severity: "major", title: "Search results endpoint returns a server error", expected: "the search results list loads", observed: "the search results endpoint returned a 500", evidence_steps: [2], signals: ["http_5xx"], signal_type: "http_error", locus: { route: "/api/search?q=fern&_=1690101731", step_locus: "search-results", status_class: "5xx" } },
    { id: "f4-incoming", role: "candidate", run_id: "2026-07-23T1418-3c4d", project_id: PROJECT, story_id: "search/filter-by-price", persona: "adversarial", kind: "http_error", severity: "major", title: "Filtered search returns a server error", expected: "the filtered search results load", observed: "the search endpoint returned a 500 with a filter applied", evidence_steps: [2], signals: ["http_5xx"], signal_type: "http_error", locus: { route: "/api/search?price=lt25&_=1690129082", step_locus: "search-results", status_class: "5xx" } },
  ],
  expected: {
    per_candidate: {
      "f4-incoming": { classification: "bug_candidate", reviewer_label: "accept" },
    },
    exact_key: { incoming: "f4-incoming", existing: "f4-existing", strict: false, loose: true },
    grouping: [["f4-existing", "f4-incoming"]],
    evidence_rows: 2,
    routing: { "f4-incoming": "suggestion" }, // loose hit ⇒ pre-attached suggestion, never auto-append
    shortlist: [],
  },
};

// ===========================================================================
// F5 — same category but different defects. Two http_error candidates on
// unrelated surfaces (gift-card redemption vs password reset) must NOT merge:
// strict miss, loose miss, and the shortlist keeps them apart.
// ===========================================================================
const F5 = {
  id: "same-category-distinct-defects",
  description: "Two http_error candidates on unrelated endpoints must stay separate; category alone is not identity.",
  seeded: true,
  runs: [
    {
      run_id: "2026-07-23T1601-5e6f", project_id: PROJECT, story_id: "account/redeem-gift-card", case_id: "account/redeem-gift-card", persona: "adversarial",
      envelopes: [
        env(1, { url: "http://shop.local/account/gift-cards", thought: "Redeem a gift card balance.", action: { type: "click", ref: "e3" }, expectation: "the gift card balance is credited", resolution: { ref: "e3", locator: 'role=button[name="Redeem"]', bbox: { x: 300, y: 240, w: 100, h: 30 } } }),
        env(2, { url: "http://shop.local/account/gift-cards", ok: true, thought: "Redeem call 500s.", action: { type: "give_up", reason: "gift card redemption 500s" }, expectation: "n/a", requests: [req("POST", "/api/giftcards/redeem", 500)], console_errors: [{ type: "console", text: "POST /api/giftcards/redeem 500 (id bc19af)" }] }),
      ],
      grade: grade({ score: 26, completion: "none", summary: "Gift-card redemption failed.", findings: [{ severity: "major", note: "Gift-card redemption returns a server error", step: 2 }] }),
    },
    {
      run_id: "2026-07-23T1720-7a8b", project_id: PROJECT, story_id: "account/reset-password", case_id: "account/reset-password", persona: "adversarial",
      envelopes: [
        env(1, { url: "http://shop.local/account/reset", thought: "Request a password reset email.", action: { type: "click", ref: "e2" }, expectation: "a reset email is sent", resolution: { ref: "e2", locator: 'role=button[name="Send reset link"]', bbox: { x: 260, y: 200, w: 150, h: 30 } } }),
        env(2, { url: "http://shop.local/account/reset", ok: true, thought: "Reset endpoint 500s.", action: { type: "give_up", reason: "password reset 500s" }, expectation: "n/a", requests: [req("POST", "/api/password/reset", 500)], console_errors: [{ type: "console", text: "POST /api/password/reset 500 (id 4d02fe)" }] }),
      ],
      grade: grade({ score: 24, completion: "none", summary: "Password reset failed.", findings: [{ severity: "major", note: "Password reset link request returns a server error", step: 2 }] }),
    },
  ],
  candidates: [
    { id: "f5-giftcard", role: "candidate", run_id: "2026-07-23T1601-5e6f", project_id: PROJECT, story_id: "account/redeem-gift-card", persona: "adversarial", kind: "http_error", severity: "major", title: "Gift-card redemption returns a server error", expected: "the gift-card balance is credited to the account", observed: "the giftcard redeem endpoint returned a 500", evidence_steps: [2], signals: ["http_5xx"], signal_type: "http_error", locus: { route: "/api/giftcards/redeem", step_locus: "redeem", status_class: "5xx" } },
    { id: "f5-password", role: "candidate", run_id: "2026-07-23T1720-7a8b", project_id: PROJECT, story_id: "account/reset-password", persona: "adversarial", kind: "http_error", severity: "major", title: "Password reset request returns a server error", expected: "a password reset email link is sent", observed: "the password reset endpoint returned a 500", evidence_steps: [2], signals: ["http_5xx"], signal_type: "http_error", locus: { route: "/api/password/reset", step_locus: "sendlink", status_class: "5xx" } },
  ],
  expected: {
    per_candidate: {
      "f5-giftcard": { classification: "bug_candidate", reviewer_label: "accept" },
      "f5-password": { classification: "bug_candidate", reviewer_label: "accept" },
    },
    exact_key: { incoming: "f5-password", existing: "f5-giftcard", strict: false, loose: false },
    grouping: [["f5-giftcard"], ["f5-password"]],
    evidence_rows: 2, // two separate findings, one evidence row each
    routing: { "f5-giftcard": "new", "f5-password": "new" },
    shortlist: [
      { of: "f5-giftcard", must_include: [], must_exclude: ["f5-password"] },
      { of: "f5-password", must_include: [], must_exclude: ["f5-giftcard"] },
    ],
  },
};

// ===========================================================================
// F6 — expected action with a contradictory observed result. Add-to-cart
// succeeds visually but the cart badge count never increments.
// ===========================================================================
const F6 = {
  id: "expectation-vs-observed",
  description: "Add-to-cart reports success but the quantity badge stays at zero — a stateable expectation/result contradiction.",
  seeded: true,
  runs: [
    {
      run_id: "2026-07-24T0930-9c0d", project_id: PROJECT, story_id: "cart/add-item", case_id: "cart/add-item", persona: "adversarial",
      envelopes: [
        env(1, { url: "http://shop.local/p/fiddle-leaf-fig", thought: "Add this product to the cart.", action: { type: "click", ref: "e5" }, expectation: "the cart quantity badge increments to 1", resolution: { ref: "e5", locator: 'role=button[name="Add to cart"]', bbox: { x: 500, y: 400, w: 130, h: 40 } } }),
        env(2, { url: "http://shop.local/p/fiddle-leaf-fig", thought: "Toast says 'Added' but the cart badge still reads 0.", action: { type: "give_up", reason: "cart badge did not increment after add" }, expectation: "n/a", raises: [{ kind: "finding", note: '"Added to cart" toast fired but the cart badge still shows 0', severity: "major" }], confusion: { type: "no_effect", note: "add succeeded with no state change" } }),
      ],
      grade: grade({ score: 33, completion: "partial", summary: "Add-to-cart reported success but the badge count did not change.", findings: [{ severity: "major", note: "The cart quantity badge does not increment after adding an item", step: 2 }] }),
    },
  ],
  candidates: [
    { id: "f6-badge", role: "candidate", run_id: "2026-07-24T0930-9c0d", project_id: PROJECT, story_id: "cart/add-item", persona: "adversarial", kind: "expectation_violation", severity: "major", title: "Cart quantity badge does not increment after add", expected: "the cart quantity badge increments after adding an item", observed: "the add-to-cart toast fired but the quantity badge stayed at zero", evidence_steps: [2], signals: ["expectation_contradiction", "no_effect"], signal_type: "expectation_contradiction", locus: { route: "/p/fiddle-leaf-fig", step_locus: "cart-badge", status_class: "ok" } },
  ],
  expected: {
    per_candidate: { "f6-badge": { classification: "bug_candidate", reviewer_label: "accept" } },
    exact_key: null,
    grouping: [["f6-badge"]],
    evidence_rows: 1,
    routing: { "f6-badge": "new" },
    shortlist: [{ of: "f6-badge", must_include: [], must_exclude: ["f5-giftcard", "f5-password"] }],
  },
};

// ===========================================================================
// F7 — contradictory visible claim and control state. A product marked
// "Sold out" still has an enabled Add-to-cart control that succeeds.
// ===========================================================================
const F7 = {
  id: "label-control-contradiction",
  description: 'A "Sold out" product has an enabled Add-to-cart control that adds the item — visible claim contradicts control state.',
  seeded: true,
  runs: [
    {
      run_id: "2026-07-24T1012-2b3e", project_id: PROJECT, story_id: "product/sold-out-guard", case_id: "product/sold-out-guard", persona: "adversarial",
      envelopes: [
        env(1, { url: "http://shop.local/p/rare-orchid", thought: 'The page says "Sold out" but the Add-to-cart button is enabled; click it.', action: { type: "click", ref: "e8" }, expectation: "the control is inert or shows an out-of-stock error", resolution: { ref: "e8", locator: 'role=button[name="Add to cart"]', bbox: { x: 500, y: 410, w: 130, h: 40 } } }),
        env(2, { url: "http://shop.local/cart", thought: 'The "sold out" item was added to the cart anyway.', action: { type: "give_up", reason: "sold-out item can still be added to cart" }, expectation: "n/a", requests: [req("POST", "/api/cart/items", 201)], raises: [{ kind: "finding", note: 'label reads "Sold out" yet the enabled button added the item to the cart', severity: "major" }] }),
      ],
      grade: grade({ score: 36, completion: "full", summary: 'A "Sold out" product can still be added to the cart.', findings: [{ severity: "major", note: 'The "Sold out" label contradicts the enabled Add-to-cart control', step: 1 }] }),
    },
  ],
  candidates: [
    { id: "f7-soldout", role: "candidate", run_id: "2026-07-24T1012-2b3e", project_id: PROJECT, story_id: "product/sold-out-guard", persona: "adversarial", kind: "data_mismatch", severity: "major", title: "Sold-out label contradicts an enabled add control", expected: "a sold-out product cannot be added to the cart", observed: "the sold-out labeled product was added to the cart via an enabled control", evidence_steps: [1, 2], signals: ["expectation_contradiction"], signal_type: "expectation_contradiction", locus: { route: "/p/rare-orchid", step_locus: "add-to-cart soldout-label", status_class: "ok" } },
  ],
  expected: {
    per_candidate: { "f7-soldout": { classification: "bug_candidate", reviewer_label: "accept" } },
    exact_key: null,
    grouping: [["f7-soldout"]],
    evidence_rows: 2, // two cited steps ⇒ two evidence rows
    routing: { "f7-soldout": "new" },
    shortlist: [{ of: "f7-soldout", must_include: [], must_exclude: [] }],
  },
};

// ===========================================================================
// F8 — actor success claim contradicted by recorded evidence. The actor emits
// `done` claiming the order was placed, but no order request fired and the URL
// never changed. Actor conclusions are claims, not evidence.
// ===========================================================================
const F8 = {
  id: "actor-claim-contradicted",
  description: "Actor `done` claims the order was placed, but no POST fired and the page never left the checkout form.",
  seeded: true,
  runs: [
    {
      run_id: "2026-07-24T1105-4f5a", project_id: PROJECT, story_id: "checkout/place-order", case_id: "checkout/place-order", persona: "tester",
      envelopes: [
        env(1, { url: "http://shop.local/checkout/review", thought: "Everything looks filled in; submit the purchase.", action: { type: "click", ref: "e10" }, expectation: "a confirmation screen appears", resolution: { ref: "e10", locator: 'role=button[name="Submit purchase"]', bbox: { x: 520, y: 520, w: 160, h: 44 } } }),
        env(2, { url: "http://shop.local/checkout/review", ok: true, thought: "I believe the purchase went through.", action: { type: "done", summary: "Purchase submitted and confirmed successfully." }, expectation: "n/a", confusion: { type: "no_effect", note: "submit click produced no request and no navigation" } }),
      ],
      grade: grade({ score: 42, completion: "partial", summary: "The actor claimed success but no purchase request fired and the page did not advance.", findings: [{ severity: "major", note: "Submit purchase produced no request and no navigation despite the actor's success claim", step: 2 }] }),
    },
  ],
  candidates: [
    { id: "f8-nofire", role: "candidate", run_id: "2026-07-24T1105-4f5a", project_id: PROJECT, story_id: "checkout/place-order", persona: "tester", kind: "no_effect", severity: "major", title: "Submit purchase does nothing despite a success claim", expected: "submitting the purchase fires an order request and advances to confirmation", observed: "the submit click produced no request and stayed on the review page while the actor reported success", evidence_steps: [1, 2], signals: ["no_effect"], signal_type: "no_effect", locus: { route: "/checkout/review", step_locus: "submit-purchase", status_class: "none" } },
  ],
  expected: {
    per_candidate: { "f8-nofire": { classification: "bug_candidate", reviewer_label: "accept" } },
    // The candidate must NOT trust the actor's `done` summary; classification is
    // driven by the recorded no_effect evidence.
    actor_claim_is_evidence: false,
    exact_key: null,
    grouping: [["f8-nofire"]],
    evidence_rows: 2,
    routing: { "f8-nofire": "new" },
    shortlist: [{ of: "f8-nofire", must_include: [], must_exclude: [] }],
  },
};

// ===========================================================================
// F9 — contract-required missing affordance VS an unsupported UX wish. Two
// observations from one run: the missing order-history affordance the story
// requires is a bug candidate; the wish for a dark-mode toggle stays UX-only.
// ===========================================================================
const F9 = {
  id: "required-affordance-vs-ux-wish",
  description: "A story-required order-history affordance is missing (candidate); a dark-mode wish is UX-only (grader finding).",
  seeded: true,
  runs: [
    {
      run_id: "2026-07-24T1200-6a7c", project_id: PROJECT, story_id: "account/find-order-history", case_id: "account/find-order-history", persona: "adversarial",
      envelopes: [
        env(1, { url: "http://shop.local/account", thought: "The story requires finding past orders; look for an order history link.", action: { type: "click", ref: "e2" }, expectation: "an order history / past orders view opens", resolution: { ref: "e2", locator: 'role=link[name="Account"]', bbox: { x: 90, y: 40, w: 90, h: 24 } } }),
        env(2, { url: "http://shop.local/account", thought: "No order history anywhere in the account area, though the story says a receipt should be reachable.", action: { type: "give_up", reason: "no order history affordance exists" }, expectation: "n/a", raises: [{ kind: "finding", note: "the account area has no order history or receipt link at all", severity: "major" }, { kind: "finding", note: "would prefer a dark mode toggle here", severity: "info" }] }),
      ],
      grade: grade({ score: 45, completion: "none", summary: "No way to reach past orders; a dark-mode toggle was also wished for.", findings: [{ severity: "major", note: "No order history / receipt affordance exists although the story requires reaching a past order", step: 2 }, { severity: "info", note: "A dark-mode toggle would be nice to have in the account area", step: 2 }] }),
    },
  ],
  candidates: [
    { id: "f9-history", role: "candidate", run_id: "2026-07-24T1200-6a7c", project_id: PROJECT, story_id: "account/find-order-history", persona: "adversarial", kind: "broken_navigation", severity: "major", title: "No order history affordance required by the story", expected: "the account area exposes an order history or receipt affordance the story requires", observed: "no order history or receipt affordance exists anywhere in the account area", evidence_steps: [2], signals: [], signal_type: null, locus: null },
  ],
  // The dark-mode wish is deliberately NOT a candidate; it stays a grader finding.
  ux_only_findings: [{ severity: "info", note: "A dark-mode toggle would be nice to have in the account area" }],
  expected: {
    per_candidate: { "f9-history": { classification: "bug_candidate", reviewer_label: "accept" } },
    ux_only: { count: 1, classification: "grader_finding" },
    exact_key: null,
    grouping: [["f9-history"]],
    evidence_rows: 1,
    routing: { "f9-history": "new" },
    shortlist: [{ of: "f9-history", must_include: [], must_exclude: [] }],
  },
};

// ===========================================================================
// F10 — intended 404 / no-effect behavior that is NOT a bug. The actor pokes a
// deliberately nonexistent URL (a real 404) and clicks a correctly disabled
// Next control (a real no_effect). A deterministic signal exists, but the
// grader must classify it as intended; a reviewer rejects it if it ever queues.
// ===========================================================================
const F10 = {
  id: "intended-404-not-a-bug",
  description: "A deliberate 404 probe and a correctly-disabled control produce deterministic signals that are intended behavior, not defects.",
  seeded: false,
  runs: [
    {
      run_id: "2026-07-24T1245-8b9d", project_id: PROJECT, story_id: "navigation/deadlink-probe", case_id: "navigation/deadlink-probe", persona: "adversarial",
      envelopes: [
        env(1, { url: "http://shop.local/this-page-does-not-exist", ok: true, thought: "Poke a made-up URL to see how the app handles unknown routes.", action: { type: "navigate", url: "/this-page-does-not-exist" }, expectation: "a friendly 404 page", requests: [req("GET", "/this-page-does-not-exist", 404)] }),
        env(2, { url: "http://shop.local/this-page-does-not-exist", thought: "A friendly 404 with a Back to home link — correct.", action: { type: "click", ref: "e1" }, expectation: "the disabled Next control does nothing", resolution: { ref: "e1", locator: 'role=button[name="Next"][disabled]', bbox: { x: 300, y: 300, w: 80, h: 30 } }, confusion: { type: "no_effect", note: "clicked a disabled control" } }),
        env(3, { url: "http://shop.local/", ok: true, thought: "Back to home works.", action: { type: "done", summary: "The 404 page behaved correctly and Back to home worked." }, expectation: "n/a" }),
      ],
      grade: grade({ score: 82, completion: "full", summary: "Unknown routes show a friendly 404 and a working Back to home; the disabled Next control is correctly inert.", findings: [{ severity: "info", note: "The 404 page is clear and offers a Back to home link", step: 2 }] }),
    },
  ],
  // Would-be candidates a naive deterministic extractor might raise; the grader
  // (and a reviewer) reject them as intended behavior.
  candidates: [
    { id: "f10-404", role: "candidate", run_id: "2026-07-24T1245-8b9d", project_id: PROJECT, story_id: "navigation/deadlink-probe", persona: "adversarial", kind: "http_error", severity: "minor", title: "Navigating to an unknown URL returns 404", expected: "n/a — the actor deliberately probed a nonexistent route", observed: "the unknown route returned a 404 with a friendly page", evidence_steps: [1], signals: ["http_4xx"], signal_type: "http_error", locus: { route: "/this-page-does-not-exist", step_locus: "navigate", status_class: "4xx" } },
  ],
  expected: {
    per_candidate: { "f10-404": { classification: "not_a_bug", reviewer_label: "reject:intended" } },
    exact_key: null,
    grouping: [],
    evidence_rows: 0, // rejected: no platform finding, no retained evidence rows
    routing: { "f10-404": "new" },
    shortlist: [{ of: "f10-404", must_include: [], must_exclude: [] }],
  },
};

// ===========================================================================
// F11 — UX friction that must remain a normal grader finding. Checkout works
// correctly but the CVV field label is confusing; no malfunction.
// ===========================================================================
const F11 = {
  id: "ux-friction-stays-grader-finding",
  description: "Checkout succeeds; only the CVV label is confusing. Friction, not a defect — stays a grader finding, no candidate.",
  seeded: false,
  runs: [
    {
      run_id: "2026-07-24T1320-0c1e", project_id: PROJECT, story_id: "checkout/pay", case_id: "checkout/pay", persona: "careful-first-timer",
      envelopes: [
        env(1, { url: "http://shop.local/checkout/pay", thought: 'The field labeled "Security code" is ambiguous but I entered the CVV.', action: { type: "type", ref: "e3", text: "123", submit: false }, expectation: "the payment form accepts the code", raises: [{ kind: "confusion", note: '"Security code" was unclear — took a moment to realize it means CVV', severity: "minor" }], resolution: { ref: "e3", locator: "#cvv", bbox: { x: 400, y: 300, w: 80, h: 30 } } }),
        env(2, { url: "http://shop.local/checkout/confirmation", ok: true, thought: "Payment succeeded and I reached the confirmation page.", action: { type: "done", summary: "Paid successfully and reached the confirmation page." }, expectation: "n/a", requests: [req("POST", "/api/orders", 201)] }),
      ],
      grade: grade({ score: 74, completion: "full", summary: "Payment worked; the only friction was an unclear CVV field label.", findings: [{ severity: "minor", note: 'The CVV field is labeled "Security code", which briefly confused the user', step: 1 }] }),
    },
  ],
  candidates: [],
  expected: {
    per_candidate: {},
    ux_only: { count: 1, classification: "grader_finding" },
    exact_key: null,
    grouping: [],
    evidence_rows: 0,
    routing: {},
    shortlist: [],
  },
};

// ===========================================================================
// F12 — one insufficient-evidence candidate that must remain unresolved. The
// actor speculates a price might be wrong but records nothing that contradicts
// the displayed value; consolidation must leave it unresolved.
// ===========================================================================
const F12 = {
  id: "insufficient-evidence-unresolved",
  description: "A speculative price-mismatch claim has no recorded contradiction; it stays an unresolved candidate.",
  seeded: false,
  runs: [
    {
      run_id: "2026-07-24T1402-2d3f", project_id: PROJECT, story_id: "product/price-check", case_id: "product/price-check", persona: "exploratory",
      envelopes: [
        env(1, { url: "http://shop.local/p/succulent-set", thought: "The price feels high but I have nothing to compare it to.", action: { type: "click", ref: "e4" }, expectation: "product details expand", resolution: { ref: "e4", locator: 'role=button[name="Details"]', bbox: { x: 460, y: 380, w: 90, h: 30 } }, raises: [{ kind: "finding", note: "the $39 price might be wrong but I could not confirm", severity: "info" }] }),
        env(2, { url: "http://shop.local/p/succulent-set", thought: "Details match the listing; nothing actually contradicts the price.", action: { type: "done", summary: "Viewed the product; no confirmed issue." }, expectation: "n/a" }),
      ],
      grade: grade({ score: 68, completion: "full", summary: "Product details are consistent; a vague price concern was raised without evidence.", findings: [{ severity: "info", note: "The actor speculated the price might be wrong but recorded no contradicting evidence", step: 1 }] }),
    },
  ],
  candidates: [
    { id: "f12-price", role: "candidate", run_id: "2026-07-24T1402-2d3f", project_id: PROJECT, story_id: "product/price-check", persona: "exploratory", kind: "data_mismatch", severity: "info", title: "Product price may be incorrect", expected: "the displayed price matches the true product price", observed: "the actor speculated the price might be wrong but recorded no contradicting value", evidence_steps: [1], signals: [], signal_type: null, locus: null },
  ],
  expected: {
    per_candidate: { "f12-price": { classification: "bug_candidate", reviewer_label: "unresolved" } },
    exact_key: null,
    grouping: [], // remains unresolved, not grouped into any finding
    evidence_rows: 0, // not promoted ⇒ no platform-finding evidence rows yet
    routing: { "f12-price": "new" },
    shortlist: [{ of: "f12-price", must_include: [], must_exclude: [] }],
  },
};

export const FIXTURES = [F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12] as unknown as CorpusFixture[]; // SAFETY: the heterogeneous frozen corpus is consumed through its common fixture shape

/** Flat list of every candidate across the corpus (for shortlist pooling). */
export function allCandidates() {
  return FIXTURES.flatMap((f) => f.candidates);
}

/** Index a candidate by id. */
export function candidateById(id: string): CorpusCandidate {
  return allCandidates().find((c) => c.id === id)! || null; // SAFETY: callers use ids frozen in this corpus
}

export { PROJECT };
