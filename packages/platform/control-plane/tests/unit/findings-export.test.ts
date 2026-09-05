// The findings export renderer (src/findings/export.ts) is pure, so the
// hermetic gate can pin what an LLM handout says: absolute links for the
// page, JSON, viewer step, and bundle entries; the scope in words; and the
// reconciliation sentence derived the same way the console derives it.
import test from "node:test";
import assert from "node:assert/strict";
import { exportJson, exportMarkdown, scopeLabel, storyStatus } from "../../src/findings/export.ts";

const input = (over: HostedDynamic = {}) => ({
  origin: "https://playtest.example",
  project: { key: "shop", name: "Shop" },
  exportedAt: new Date("2026-09-05T10:00:00Z"),
  scope: { states: ["new", "reopened", "accepted"], severity: null, fixSuggested: false },
  findings: [finding()],
  ...over,
});

function finding(over: HostedDynamic = {}) {
  return {
    id: "01F1",
    title: "assert: cart total updates",
    state: "accepted",
    severity: "major",
    category: "expectation_violation",
    source: "run_grade",
    external_ref: null,
    reject_reason: null,
    first_seen: "2026-09-01T00:00:00Z",
    last_seen: "2026-09-04T00:00:00Z",
    evidence_count: 2,
    recurrence_count: 1,
    claim: { expected: "the total   shows 20", observed: "the total shows 10", severity: "major", signals: ["gate_assert"] },
    summary: { story_id: "checkout", gate: { spec: "assert: cart total updates", detail: "total stayed 10" }, confirmed_at: "2026-09-02T00:00:00Z" },
    story_health: { status: "fail", finished_at: "2026-09-04T01:00:00Z", run_db_id: "R2", run_group_id: "G2" },
    resolved_by_run: null,
    suggested_fix_run: null,
    suggested_finding_id: null,
    evidence: [
      { id: "E1", case_id: "checkout", story_id: "checkout", run_id: "R1", run_db_id: "R1", core_run_id: "2026-09-04T0000-abcd", run_group_id: "G1",
        run_status: "fail", step_from: 7, step_to: 7, excerpt: "line one\nline two", created_at: "2026-09-04T00:00:00Z",
        viewer_url: "/p/shop/runs/G1/R1?step=7" },
      { id: "E0", case_id: "checkout", story_id: "checkout", run_id: "R0", run_db_id: "R0", core_run_id: "2026-09-01T0000-0000", run_group_id: "G0",
        run_status: "fail", step_from: null, step_to: null, excerpt: null, created_at: "2026-09-01T00:00:00Z",
        viewer_url: "/p/shop/runs/G0/R0" },
    ],
    ...over,
  };
}

test("markdown export carries every verification link on the caller's origin", () => {
  const md = exportMarkdown(input());
  assert.ok(md.startsWith("# Findings export: Shop (shop)\n"));
  assert.ok(md.includes("Scope: new (Needs review), reopened (Open (reopened)), accepted (Open (confirmed)). 1 finding."));
  assert.ok(md.includes("## 1. assert: cart total updates"), "the stored title is kept verbatim: it is what the console's tracker copy says too");
  assert.ok(md.includes("- Finding: https://playtest.example/p/shop/findings/01F1"));
  assert.ok(md.includes("- JSON: https://playtest.example/api/v1/findings/01F1"));
  assert.ok(md.includes("- State: accepted (Open (confirmed))"));
  assert.ok(md.includes("- Provenance: category expectation_violation, filed by run grading"));
  assert.ok(md.includes("- Story status: still failing: the latest run of this story failed, so the finding is current (latest run: https://playtest.example/p/shop/runs/G2/R2)"));
  assert.ok(md.includes("**Expected:** the total shows 20"), "whitespace runs collapse");
  assert.ok(md.includes("**Failing check:** assert: cart total updates: total stayed 10"));
  assert.ok(md.includes("### Evidence (2)"));
  assert.ok(md.includes("1. Run `2026-09-04T0000-abcd` of case `checkout`, step 7, run status fail, seen 2026-09-04T00:00:00.000Z"));
  assert.ok(md.includes("   - Viewer: https://playtest.example/p/shop/runs/G1/R1?step=7"));
  assert.ok(md.includes("   - Trajectory: https://playtest.example/api/v1/projects/shop/view/run/2026-09-04T0000-abcd/checkout/trajectory.jsonl"));
  assert.ok(md.includes("   - Screenshot: https://playtest.example/api/v1/projects/shop/view/run/2026-09-04T0000-abcd/checkout/steps/007.png"));
  assert.ok(md.includes("   - Bundle (.ptrun): https://playtest.example/api/v1/runs/R1/download"));
  assert.ok(md.includes("   > line one\n   > line two"), "multi-line excerpts stay quoted line by line");
  assert.ok(md.includes("2. Run `2026-09-01T0000-0000` of case `checkout`, no step recorded, run status fail"));
  assert.ok(!md.includes("steps/null"), "no screenshot link without a step");
});

test("json export mirrors the markdown with structured links and scope", () => {
  const doc = exportJson(input({ scope: { states: ["new", "accepted", "reopened", "resolved", "rejected"], severity: "major", fixSuggested: true } }));
  assert.equal(doc.format, "playtest.findings-export");
  assert.equal(doc.count, 1);
  assert.equal(doc.scope.label, "all states, severity major, with a pending looks-fixed suggestion");
  assert.equal(doc.project.findings_url, "https://playtest.example/p/shop/findings");
  const f: HostedDynamic = doc.findings[0];
  assert.equal(f.links.page, "https://playtest.example/p/shop/findings/01F1");
  assert.equal(f.expected, "the total   shows 20", "json keeps the claim text untouched");
  assert.equal(f.story_health.run_url, "https://playtest.example/p/shop/runs/G2/R2");
  assert.equal(f.evidence[0].links.a11y, "https://playtest.example/api/v1/projects/shop/view/run/2026-09-04T0000-abcd/checkout/steps/007.a11y.txt");
  assert.equal(f.evidence[1].links.screenshot, null);
  assert.equal(f.evidence[1].links.manifest, "https://playtest.example/api/v1/projects/shop/view/run/2026-09-01T0000-0000/checkout/manifest.json");
});

test("resolution, suggestion, and duplicate provenance each get a line", () => {
  const md = exportMarkdown(input({ findings: [finding({
    state: "resolved",
    auto_resolved_at: "2026-09-05T00:00:00Z",
    resolved_by_run: { id: "R9", run_group_id: "G9", case_id: "checkout" },
    suggested_fix_run: { id: "R8", run_group_id: "G8", case_id: "checkout" },
    suggested_finding_id: "01F0",
    suggested_finding_title: "Cart total wrong",
    summary: { story_id: "checkout", auto_resolve: { reason: "a later run passed everywhere", suggested: { run_id: "R8", reason: "newer pass" } } },
    story_health: { status: "pass", finished_at: "2026-09-05T00:00:00Z", run_db_id: "R9", run_group_id: "G9" },
    evidence: [],
  })] }));
  assert.ok(md.includes("- Resolution: resolved automatically 2026-09-05T00:00:00.000Z. a later run passed everywhere (run: https://playtest.example/p/shop/runs/G9/R9)"));
  assert.ok(md.includes("- Looks fixed (unconfirmed suggestion): newer pass (run: https://playtest.example/p/shop/runs/G8/R8)"));
  assert.ok(md.includes("- Possibly the same bug as: Cart total wrong https://playtest.example/p/shop/findings/01F0"));
  assert.ok(md.includes("- Story status: passing now: a run newer than the last evidence passed, so this may be fixed"));
  assert.ok(md.includes("### Evidence (0)\n\nNo evidence rows."));
});

test("a claim that repeats its title as observed text and excerpt is said once", () => {
  const md = exportMarkdown(input({ findings: [finding({
    title: "Total stayed 10 after adding an item",
    claim: { expected: null, observed: "Total stayed 10  after adding an item", severity: "minor", signals: [] },
    evidence: [{ ...finding().evidence[0], excerpt: "Total stayed 10 after adding an item" }],
  })] }));
  assert.ok(md.includes("## 1. Total stayed 10 after adding an item"));
  assert.ok(!md.includes("**Observed:**"));
  assert.ok(!md.includes("   > Total stayed"));
});

test("story status wording follows the console's reconciliation rules", () => {
  assert.equal(storyStatus({ story_health: null }), null);
  assert.match(String(storyStatus({ story_health: { status: "fail" } })), /^still failing/);
  assert.match(String(storyStatus({ last_seen: "2026-09-04T00:00:00Z", story_health: { status: "pass", finished_at: "2026-09-05T00:00:00Z" } })), /^passing now/);
  assert.match(String(storyStatus({ last_seen: "2026-09-04T00:00:00Z", story_health: { status: "pass", finished_at: "2026-09-03T00:00:00Z" } })), /^not re-run/);
  assert.equal(scopeLabel({ states: ["rejected"], severity: null, fixSuggested: false }), "rejected (Rejected)");
});
