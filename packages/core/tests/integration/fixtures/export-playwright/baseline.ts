// A deterministic, hand-built web baseline covering every exportable verb and
// every success-criterion kind — the input to the export golden. Hand-built on
// purpose: a recorded baseline would drift with prompts/model changes and make
// the golden untrustworthy as a review artifact.

/** @param {number} n @param {string} type */
function step(n: LegacyTestValue, type: LegacyTestValue, extra: LegacyTestValue, locator: LegacyTestValue, thought: LegacyTestValue) {
  return {
    step: n,
    schema_version: 7,
    ts: `2026-06-10T03:00:0${n}.000Z`,
    mode: "agent",
    agent: {
      thought,
      action: { type, ...(locator === null ? {} : { ref: `e${n}` }), ...extra },
      expectation: "the page moves on",
    },
    resolution: locator === null ? { locator: null, bbox: null } : { ref: `e${n}`, locator, bbox: { x: 4, y: 8, w: 120, h: 32 } },
    result: { ok: true, error: null, settle_ms: 40, url: "http://shop.test/cart" },
  };
}

export const ENVELOPES = [
  step(1, "type", { text: 'Ada "Lovelace"', submit: false }, '[data-testid="name"]',
    "The checkout form needs a name before it will let me continue, so I fill in the customer's name."),
  step(2, "select", { value: "Express" }, "#shipping",
    "The story asks for the fastest option, so I choose Express from the shipping dropdown."),
  step(3, "scroll", { direction: "down" }, '[data-testid="summary"]',
    "The order summary is cut off below the fold and I need to reach the totals, so I scroll the panel."),
  step(4, "scroll", { direction: "up" }, null,
    "Nothing here is anchored to an element, so this scrolls the page itself back toward the form."),
  step(5, "click", {}, 'role=button[name="Place order"]',
    "Everything the story asked for is filled in, so I place the order."),
  step(6, "wait", { seconds: 1.5 }, null,
    "The confirmation is still rendering after the POST, so I give it a moment."),
  step(7, "navigate", { url: "/order/receipt" }, null,
    "The banner links to the receipt, and the story ends on the receipt page."),
  step(8, "back", {}, null,
    "I want to confirm the confirmation page is still reachable behind the receipt."),
  // Excluded from the action track: a failed step and the terminal step.
  {
    step: 9,
    agent: { thought: "That control is gone.", action: { type: "click", ref: "e9" } },
    resolution: { ref: "e9", locator: "#missing", bbox: null },
    result: { ok: false, error: "ref \"e9\" is not visible" },
  },
  {
    step: 10,
    agent: { thought: "The receipt is on screen, so the journey is complete.", action: { type: "done" } },
    result: { ok: true, error: null, url: "http://shop.test/order/receipt" },
  },
];

export const CASE = {
  id: "checkout",
  storyId: "checkout",
  file: "/tmp/suite/stories/checkout.yaml",
  story: 'Order one "Analytical Engine" with express shipping and land on the receipt.',
  mode: "journey",
  success: [
    { url_matches: "/order/receipt*" },
    { element_exists: '[data-testid="receipt-total"]', label: "the receipt shows a total" },
    { api_called: "POST /api/orders" },
    { console_errors: 0 },
    { assert: 'the receipt names the "Analytical Engine" and the express shipping line' },
    { accessibility_violations: 0 },
  ],
  perf: { lcp_ms: "< 2500" },
  env: {
    driver: "web",
    base_url: "http://shop.test",
    cookies: [
      { name: "session", value: "abc123" },
      { name: "consent", value: "all" },
    ],
  },
};

export const META = {
  accepted_at: "2026-06-10T03:04:05.000Z",
  run_id: "2026-06-10T0300-ab12",
  story_hash: "deadbeefcafe0001",
  pins: {
    harness_version: "0.1.0",
    step_schema_version: 7,
    actor_model: "claude-sonnet-4-6",
  },
};
