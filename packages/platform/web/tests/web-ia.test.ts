// The hosted web information architecture frozen by the P1 simplification:
// a four-item project rail, temporary redirects for removed SPA surfaces,
// exactly three Settings sections with role disclosure, and secret masking.
// These modules under packages/platform/web/src are DOM-free on purpose so this offline
// gate can assert the IA without a browser (siblings of web-caseform.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { RAIL, railFor } from "../src/lib/nav.js";
import { redirectFor } from "../src/lib/redirects.js";
import { SETTINGS_SECTIONS, visibleSections } from "../src/lib/settings-sections.js";
import { MASK, maskSecretEnv, literalSecretKeys } from "../src/lib/secret-mask.js";
import {
  FINDING_BUCKETS, DEFAULT_BUCKET, bucketId, bucketCounts, findingStateLabel, findingStateTone,
} from "../src/lib/finding-buckets.js";
import { categoryLabel, signalLabel, criterionLabel, humanize, nextRunLabel } from "../src/lib/vocab.js";
import { CATEGORIES } from "@playtest/core/findings";
import { SUCCESS_KINDS } from "../src/lib/caseform.js";

test("nav: primary project navigation is exactly five items", () => {
  // P1's four, plus Personas: a persona is project-wide and the story editor's
  // picker needs somewhere to send people to make one.
  assert.deepEqual(RAIL.map((i: WebDynamic) => i.nav), ["overview", "runs", "findings", "personas", "settings"]);
  assert.deepEqual(RAIL.map((i: WebDynamic) => i.label), ["Suites", "Runs", "Findings", "Personas", "Settings"]);
  // No separate Review or Insights destination on the rail.
  for (const gone of ["review", "insights"]) {
    assert.ok(!RAIL.some((i: WebDynamic) => i.nav === gone), `rail must not contain ${gone}`);
  }
});

test("nav: every page's nav value lights up exactly one rail item", () => {
  // The authoring surfaces live UNDER a rail item; without the map they
  // rendered with every item inactive and the console never said where you
  // were. This is the full set of `nav:` values the pages pass.
  const items = new Set(RAIL.map((i: WebDynamic) => i.nav));
  for (const nav of ["overview", "runs", "findings", "personas", "settings", "suites", "review"]) {
    assert.ok(items.has(railFor(nav)), `nav "${nav}" must resolve to a rail item, got ${railFor(nav)}`);
  }
  assert.equal(railFor("suites"), "overview", "Suites is the project home");
  assert.equal(railFor("review"), "runs", "a changed story is a run awaiting a decision");
  assert.equal(railFor(null), null, "the project-less frame highlights nothing");
});

test("nav: Suites is the project home; each item deep-links by key", () => {
  assert.equal(RAIL[0].to("acme"), "/p/acme");
  assert.equal(RAIL.find((i: WebDynamic) => i.nav === "runs").to("acme"), "/p/acme/runs");
  assert.equal(RAIL.find((i: WebDynamic) => i.nav === "findings").to("acme"), "/p/acme/findings");
  assert.equal(RAIL.find((i: WebDynamic) => i.nav === "personas").to("acme"), "/p/acme/personas");
  assert.equal(RAIL.find((i: WebDynamic) => i.nav === "settings").to("acme"), "/p/acme/settings");
});

test("redirects: removed SPA surfaces resolve to their surviving home", () => {
  assert.equal(redirectFor("/p/acme/suites"), "/p/acme");
  assert.equal(redirectFor("/p/acme/suites/"), "/p/acme");
  assert.equal(redirectFor("/p/acme/insights"), "/p/acme/findings");
  assert.equal(redirectFor("/p/acme/insights/01HXYZ"), "/p/acme/findings");
  assert.equal(redirectFor("/p/acme/search"), "/p/acme");
  // P2: the standalone assistant is replaced by inline drafting — its link opens
  // New story with the Help-me-draft modal.
  assert.equal(redirectFor("/p/acme/suites/checkout/assistant"), "/p/acme/suites/checkout/new?assist=1");
  assert.equal(redirectFor("/p/acme/suites/checkout/assistant/"), "/p/acme/suites/checkout/new?assist=1");
  // The raw file tree is gone: playtest.yaml is a form on Suite settings, and
  // the code tier (personas/hooks/assertions) travels as a .tar.
  assert.equal(redirectFor("/p/acme/suites/checkout/files"), "/p/acme/suites/checkout/settings");
  assert.equal(redirectFor("/p/acme/suites/checkout/files/"), "/p/acme/suites/checkout/settings");
  // The candidate collapse: the queue is the needs-review filter, and a
  // candidate's id survived as its finding's id — deep links land on the claim.
  assert.equal(redirectFor("/p/acme/candidates"), "/p/acme/findings?filter=review");
  assert.equal(redirectFor("/p/acme/candidates/01HXYZ"), "/p/acme/findings/01HXYZ");
});

test("redirects: surviving deep links are never redirected", () => {
  for (const p of [
    "/p/acme/suites/checkout",                    // suite detail
    "/p/acme/suites/checkout/stories/add-todo",   // story
    "/p/acme/suites/checkout/stories/add-todo/history",
    "/p/acme/suites/checkout/settings",            // suite defaults (playtest.yaml)
    "/p/acme/runs/g1/r1",                         // run detail
    "/p/acme/findings/f1",                        // finding detail
    "/p/acme/review",                             // contextual batch view survives
    "/p/acme/personas",                           // project-wide persona list
    "/p/acme/settings",
    "/p/acme",
  ]) {
    assert.equal(redirectFor(p), null, `must not redirect ${p}`);
  }
});

test("findings: four disjoint buckets map to internal states; Open is the default", () => {
  // The hosted candidate collapse made triage a STATE: `new` gets its own
  // Needs review bucket instead of a separate page,
  // and the four buckets partition the five states with no overlap.
  assert.deepEqual(Object.keys(FINDING_BUCKETS), ["review", "open", "resolved", "rejected"]);
  assert.deepEqual(Object.values(FINDING_BUCKETS as WebDynamic).map((b: WebDynamic) => b.label),
    ["Needs review", "Open", "Resolved", "Rejected"]);
  assert.equal(FINDING_BUCKETS.review.state, "new");
  assert.equal(FINDING_BUCKETS.open.state, "reopened,accepted");
  assert.equal(FINDING_BUCKETS.resolved.state, "resolved");
  assert.equal(FINDING_BUCKETS.rejected.state, "rejected");
  assert.equal(DEFAULT_BUCKET, "open");
  const covered = Object.values(FINDING_BUCKETS as WebDynamic).flatMap((b: WebDynamic) => b.state.split(","));
  assert.deepEqual(covered.sort(), ["accepted", "new", "rejected", "reopened", "resolved"]);
  // Every bucket says what it holds — "Open" alone left people experimenting to
  // find out which tab a confirmed finding was in.
  for (const [id, b] of Object.entries(FINDING_BUCKETS) as WebDynamic) {
    assert.ok(b.blurb?.length > 10, `bucket "${id}" needs a blurb`);
  }
});

test("findings: bucketCounts folds per-state counts into the bucket partition", () => {
  // The tab tallies count with the same partition the buckets declare —
  // confirming a finding (new → accepted) moves one from review to open.
  assert.deepEqual(bucketCounts({ new: 3, reopened: 1, accepted: 2, resolved: 5, rejected: 4 }),
    { review: 3, open: 3, resolved: 5, rejected: 4 });
  assert.deepEqual(bucketCounts({}), { review: 0, open: 0, resolved: 0, rejected: 0 });
});

test("findings: old filter names still resolve — bookmarks keep working", () => {
  assert.equal(bucketId("dismissed"), "rejected");
  assert.equal(bucketId("rejected"), "rejected");
  assert.equal(bucketId("open"), "open");
  assert.equal(bucketId("new"), "review");
  assert.equal(bucketId("review"), "review");
  assert.equal(bucketId("nonsense"), DEFAULT_BUCKET);
  assert.equal(bucketId(null), DEFAULT_BUCKET);
});

test("findings: the five API states each show as a user-facing word", () => {
  // The console said "new/confirmed" on chips, "Open/Dismissed/Resolved" on
  // filters and "accepted/rejected" in the audit log — three vocabularies for
  // one lifecycle. One mapping now, and this is it.
  const shown = { new: "Needs review", reopened: "Reopened", accepted: "Confirmed", rejected: "Rejected", resolved: "Resolved" };
  for (const [state, word] of Object.entries(shown)) {
    assert.equal(findingStateLabel(state), word);
  }
  // A confirmed finding is acknowledged, not closed; resolved is finished work
  // and wears the pass green, while rejected mutes.
  assert.equal(findingStateTone("accepted"), "state-accepted");
  assert.equal(findingStateTone("new"), "state-new");
  assert.equal(findingStateTone("reopened"), "state-new");
  assert.equal(findingStateTone("rejected"), "state-muted");
  assert.equal(findingStateTone("resolved"), "state-resolved");
});

test("vocab: every engine enum a person can see has a plain-English word", () => {
  // The console showed `no_effect`, `expectation_violation`, `element_exists`
  // and friends verbatim. Each of these maps; anything new degrades to a
  // readable phrase rather than a blank.
  for (const c of CATEGORIES) {
    const label = categoryLabel(c);
    assert.ok(label && !label.includes("_"), `category "${c}" still reads as a token: ${label}`);
  }
  for (const k of Object.keys(SUCCESS_KINDS)) {
    const label = criterionLabel(k);
    assert.ok(label && !label.includes("_"), `success kind "${k}" still reads as a token: ${label}`);
  }
  for (const s of ["http_4xx", "http_5xx", "console_exception", "failed_action", "no_effect", "repeated_action", "perf_budget"]) {
    assert.ok(!signalLabel(s).includes("_"), `signal "${s}" still reads as a token`);
  }
  // Unknown tokens (a new engine signal, ahead of a web release) stay usable.
  assert.equal(humanize("some_future_signal"), "some future signal");
  assert.equal(categoryLabel("some_future_thing"), "some future thing");
  assert.equal(signalLabel(null), "an unrecognized signal");
  assert.equal(categoryLabel(""), "Uncategorized");
  // NEXT RUN keeps the CLI's own words (core `list`).
  assert.deepEqual(["record", "check", "explore"].map(nextRunLabel), ["record", "check", "explore"]);
});

test("settings: exactly six sections, no plugins/integrations/retention", () => {
  // Runners joined the five when placement became something a person owns: it
  // says which machine executes a run, next to what a run points at.
  assert.deepEqual(SETTINGS_SECTIONS.map((s: WebDynamic) => s.id), ["test-targets", "runners", "runs", "models", "team", "audit"]);
  assert.deepEqual(SETTINGS_SECTIONS.map((s: WebDynamic) => s.label), ["Test targets", "Runners", "Runs", "Models", "Team", "Audit"]);
  for (const gone of ["plugins", "integrations", "retention", "environments", "secrets"]) {
    assert.ok(!SETTINGS_SECTIONS.some((s: WebDynamic) => s.id === gone), `no ${gone} section`);
  }
});

test("settings: role disclosure — developer sees test targets and runners; runs/models/team/audit are admin", () => {
  const rank: WebDynamic = { viewer: 0, editor: 1, reviewer: 2, developer: 3, admin: 4 };
  const has = (role: WebDynamic) => (min: WebDynamic) => rank[role] >= rank[min];
  // Two gates, not one: the role, and what this DEPLOYMENT can do. Runners
  // exists only where runs are placed on a self-hosted pool.
  const pooled = { pool_dispatch: true };
  assert.deepEqual(visibleSections(has("editor"), pooled).map((s: WebDynamic) => s.id), []);
  assert.deepEqual(visibleSections(has("developer"), pooled).map((s: WebDynamic) => s.id), ["test-targets", "runners"]);
  assert.deepEqual(visibleSections(has("admin"), pooled).map((s: WebDynamic) => s.id), ["test-targets", "runners", "runs", "models", "team", "audit"]);
  assert.deepEqual(visibleSections(has("admin"), {}).map((s: WebDynamic) => s.id), ["test-targets", "runs", "models", "team", "audit"]);
});

test("secret masking: literal values are masked; references stay readable", () => {
  const cfg = {
    app: { base_url: "https://staging.example.com" },
    secret_env: {
      TOKEN: "super-secret-value",
      REF: { $secret: "staging-token" },
      SESS: { $session: "member" },
    },
  };
  const masked = maskSecretEnv(cfg);
  assert.equal(masked.secret_env.TOKEN, MASK);
  assert.deepEqual(masked.secret_env.REF, { $secret: "staging-token" });
  assert.deepEqual(masked.secret_env.SESS, { $session: "member" });
  // Non-secret config is untouched.
  assert.equal(masked.app.base_url, "https://staging.example.com");
  // Only the readable literal is flagged; masking removes it from the flag set.
  assert.deepEqual(literalSecretKeys(cfg), ["TOKEN"]);
  assert.deepEqual(literalSecretKeys(masked), []);
});
