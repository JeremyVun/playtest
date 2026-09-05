// A whole findings list as one file for an LLM (or a person) to work through
// offline. Every finding carries the absolute links an agent needs to verify
// it: the console page, the JSON read, each evidence step in the viewer, and
// the run's bundle entries (trajectory, manifest, screenshot). Pure: the route
// gathers rows, this renders them.

const STATE_BUCKET: Record<string, string> = {
  new: "Needs review",
  accepted: "Open (confirmed)",
  reopened: "Open (reopened)",
  resolved: "Resolved",
  rejected: "Rejected",
};

const SOURCE_LABEL: Record<string, string> = {
  synthesis: "discovery synthesis",
  run_grade: "run grading",
  reviewer: "a reviewer filing from a run",
};

export interface ExportScope {
  states: string[];
  severity: string | null;
  fixSuggested: boolean;
  includeFixSuggested?: boolean;
  search?: string;
}

export interface ExportInput {
  origin: string;
  project: { key: string; name: string };
  exportedAt: Date;
  scope: ExportScope;
  findings: HostedDynamic[];
}

const pad3 = (n: number) => String(n).padStart(3, "0");
const iso = (d: HostedDynamic) => (d == null ? null : new Date(d).toISOString());
const clean = (s: HostedDynamic) => String(s ?? "").replace(/\s+/g, " ").trim();

export function scopeLabel(scope: ExportScope) {
  const states = scope.states.length === 5 ? "all states" : scope.states.map((s) => `${s} (${STATE_BUCKET[s]})`).join(", ");
  const parts = [states];
  if (scope.severity) parts.push(`severity ${scope.severity}`);
  if (scope.fixSuggested) parts.push("with a pending looks-fixed suggestion");
  if (scope.includeFixSuggested) parts.push("including open findings with a pending looks-fixed suggestion");
  if (scope.search) parts.push(`matching ${JSON.stringify(scope.search)}`);
  return parts.join(", ");
}

function runLinks(origin: string, projectKey: string, e: HostedDynamic) {
  const entry = `${origin}/api/v1/projects/${encodeURIComponent(projectKey)}/view/run/${e.core_run_id}/${e.case_id}`;
  return {
    viewer: `${origin}${e.viewer_url}`,
    run_json: `${origin}/api/v1/runs/${e.run_db_id}`,
    bundle: `${origin}/api/v1/runs/${e.run_db_id}/download`,
    trajectory: `${entry}/trajectory.jsonl`,
    manifest: `${entry}/manifest.json`,
    grade: `${entry}/grade.json`,
    screenshot: e.step_from != null ? `${entry}/steps/${pad3(e.step_from)}.png` : null,
    a11y: e.step_from != null ? `${entry}/steps/${pad3(e.step_from)}.a11y.txt` : null,
  };
}

function runPageUrl(origin: string, projectKey: string, run: HostedDynamic) {
  return run ? `${origin}/p/${projectKey}/runs/${run.run_group_id}/${run.id}` : null;
}

export function storyStatus(f: HostedDynamic) {
  const sh = f.story_health;
  if (!sh?.status) return null;
  if (sh.status === "fail") return "still failing: the latest run of this story failed, so the finding is current";
  const reRun = !f.last_seen || new Date(sh.finished_at) >= new Date(f.last_seen);
  return reRun
    ? "passing now: a run newer than the last evidence passed, so this may be fixed"
    : "not re-run: the story has not run since this was last seen, so the finding may be stale";
}

export function exportFinding(input: ExportInput, f: HostedDynamic) {
  const { origin, project } = input;
  const claim = f.claim || {};
  const gate = f.summary?.gate || null;
  const auto = f.summary?.auto_resolve || null;
  const sh = f.story_health;
  return {
    id: f.id,
    title: f.title,
    state: f.state,
    bucket: STATE_BUCKET[f.state] || f.state,
    severity: f.severity,
    category: f.category,
    source: f.source,
    story_id: f.summary?.story_id ?? null,
    expected: claim.expected ?? null,
    observed: claim.observed ?? null,
    signals: claim.signals || [],
    failing_check: gate?.spec || gate?.detail ? { spec: gate.spec ?? null, detail: gate.detail ?? null } : null,
    locus: f.summary?.locus ?? null,
    external_ref: f.external_ref,
    reject_reason: f.reject_reason,
    confirmed_at: iso(f.summary?.confirmed_at),
    first_seen: iso(f.first_seen),
    last_seen: iso(f.last_seen),
    evidence_count: f.evidence_count,
    recurrence_count: f.recurrence_count ?? 0,
    story_health: sh?.status
      ? { status: sh.status, finished_at: iso(sh.finished_at), run_url: runPageUrl(origin, project.key, { run_group_id: sh.run_group_id, id: sh.run_db_id }), note: storyStatus(f) }
      : null,
    auto_resolution: f.auto_resolved_at
      ? { at: iso(f.auto_resolved_at), reason: auto?.reason ?? null, run_url: runPageUrl(origin, project.key, f.resolved_by_run) }
      : null,
    fix_suggestion: auto?.suggested
      ? { reason: auto.suggested.reason ?? null, run_url: runPageUrl(origin, project.key, f.suggested_fix_run) }
      : null,
    possibly_same_as: f.suggested_finding_id
      ? { id: f.suggested_finding_id, title: f.suggested_finding_title ?? null, url: `${origin}/p/${project.key}/findings/${f.suggested_finding_id}` }
      : null,
    links: {
      page: `${origin}/p/${project.key}/findings/${f.id}`,
      json: `${origin}/api/v1/findings/${f.id}`,
    },
    evidence: (f.evidence || []).map((e: HostedDynamic) => ({
      id: e.id,
      case_id: e.case_id,
      story_id: e.story_id ?? null,
      run_id: e.core_run_id,
      run_status: e.run_status ?? null,
      step: e.step_from ?? null,
      step_to: e.step_to ?? null,
      seen_at: iso(e.created_at),
      excerpt: e.excerpt ?? null,
      links: runLinks(origin, project.key, e),
    })),
  };
}

export function exportJson(input: ExportInput) {
  return {
    format: "playtest.findings-export",
    version: 1,
    exported_at: input.exportedAt.toISOString(),
    origin: input.origin,
    project: { key: input.project.key, name: input.project.name, findings_url: `${input.origin}/p/${input.project.key}/findings` },
    scope: { ...input.scope, label: scopeLabel(input.scope) },
    count: input.findings.length,
    findings: input.findings.map((f) => exportFinding(input, f)),
  };
}

export function exportMarkdown(input: ExportInput) {
  const { origin, project } = input;
  const out: string[] = [];
  const line = (s = "") => out.push(s);
  const para = (s: string) => { line(s); line(); };
  const items = input.findings.map((f) => exportFinding(input, f));

  line(`# Findings export: ${project.name} (${project.key})`);
  line();
  line(`Exported ${input.exportedAt.toISOString()} from ${origin}/p/${project.key}/findings.`);
  line(`Scope: ${scopeLabel(input.scope)}. ${items.length} finding${items.length === 1 ? "" : "s"}.`);
  line();
  line("## How to read this file");
  line();
  line("Each finding below is a defect claim recorded by Playtest, an AI-driven user-journey test harness. A finding groups the evidence from one or more runs of a story (a plain-language user journey acted out against the application by an actor model).");
  line();
  line("- **State** is the review lifecycle: `new` awaits a human judgment, `accepted` and `reopened` are confirmed open bugs, `resolved` is closed, `rejected` was judged not a bug.");
  line("- **Expected / Observed** is the claim. **Failing check** is the deterministic gate that failed, when one did.");
  line("- **Story status** reconciles the finding against the story's latest finished run.");
  line("- **Evidence** rows cite a run and, when known, the step where the problem was seen.");
  line();
  line("To verify a finding, follow its links. Console pages need a browser session; `/api/v1/` URLs also accept a project API token as `Authorization: Bearer <token>`.");
  line();
  line("- The finding page and its JSON read.");
  line("- The viewer link opens the run at the cited step.");
  line("- The trajectory is `trajectory.jsonl` (one JSON envelope per line: actions, observations, gate checks) and `manifest.json` (run metadata and result). `grade.json` is the grader's verdict. The step screenshot and accessibility text are under `steps/NNN.*`.");
  line("- The bundle link downloads the whole run as one `.ptrun` archive with the same entries.");
  line();

  items.forEach((f, i) => {
    line(`## ${i + 1}. ${clean(f.title)}`);
    line();
    line(`- Finding: ${f.links.page}`);
    line(`- JSON: ${f.links.json}`);
    line(`- Id: \`${f.id}\``);
    line(`- State: ${f.state} (${f.bucket})${f.reject_reason ? `, reason ${f.reject_reason}` : ""}`);
    line(`- Severity: ${f.severity}`);
    const provenance = [f.category ? `category ${f.category}` : null, f.source ? `filed by ${SOURCE_LABEL[f.source] || f.source}` : null].filter(Boolean);
    if (provenance.length) line(`- Provenance: ${provenance.join(", ")}`);
    if (f.story_id) line(`- Story: ${f.story_id}`);
    if (f.external_ref) line(`- External reference: ${f.external_ref}`);
    if (f.confirmed_at) line(`- Confirmed: ${f.confirmed_at}`);
    line(`- Occurrences: ${f.evidence_count}, first seen ${f.first_seen}, last seen ${f.last_seen}${f.recurrence_count ? `, ${f.recurrence_count} exact recurrence${f.recurrence_count === 1 ? "" : "s"} absorbed` : ""}`);
    if (f.story_health) line(`- Story status: ${f.story_health.note}${f.story_health.run_url ? ` (latest run: ${f.story_health.run_url})` : ""}`);
    if (f.auto_resolution) line(`- Resolution: resolved automatically ${f.auto_resolution.at}${f.auto_resolution.reason ? `. ${clean(f.auto_resolution.reason)}` : ""}${f.auto_resolution.run_url ? ` (run: ${f.auto_resolution.run_url})` : ""}`);
    if (f.fix_suggestion) line(`- Looks fixed (unconfirmed suggestion): ${f.fix_suggestion.reason ? clean(f.fix_suggestion.reason) : "a newer run passed this story"}${f.fix_suggestion.run_url ? ` (run: ${f.fix_suggestion.run_url})` : ""}`);
    if (f.possibly_same_as) line(`- Possibly the same bug as: ${f.possibly_same_as.title ? `${clean(f.possibly_same_as.title)} ` : ""}${f.possibly_same_as.url}`);
    line();
    // Grade-filed claims often store the same sentence as title, observed
    // text, and excerpt; say it once.
    if (f.expected) para(`**Expected:** ${clean(f.expected)}`);
    if (f.observed && clean(f.observed) !== clean(f.title)) para(`**Observed:** ${clean(f.observed)}`);
    if (f.failing_check) para(`**Failing check:** ${[f.failing_check.spec, f.failing_check.detail].filter(Boolean).map(clean).join(": ")}`);
    if (f.locus && !f.failing_check?.detail) para(`**Where:** ${clean(f.locus)}`);
    if (f.signals.length) para(`**Signals:** ${f.signals.map((s: HostedDynamic) => clean(typeof s === "string" ? s : JSON.stringify(s))).join("; ")}`);

    line(`### Evidence (${f.evidence.length})`);
    line();
    if (!f.evidence.length) para("No evidence rows. The run bundle may have been pruned.");
    f.evidence.forEach((e: HostedDynamic, j: number) => {
      const where = e.step != null ? `step ${e.step}${e.step_to != null && e.step_to !== e.step ? ` to ${e.step_to}` : ""}` : "no step recorded";
      line(`${j + 1}. Run \`${e.run_id}\` of case \`${e.case_id}\`, ${where}, run status ${e.run_status ?? "unknown"}, seen ${e.seen_at}`);
      line(`   - Viewer: ${e.links.viewer}`);
      line(`   - Trajectory: ${e.links.trajectory}`);
      line(`   - Manifest: ${e.links.manifest}`);
      line(`   - Grade: ${e.links.grade}`);
      if (e.links.screenshot) line(`   - Screenshot: ${e.links.screenshot}`);
      if (e.links.a11y) line(`   - Accessibility text: ${e.links.a11y}`);
      line(`   - Bundle (.ptrun): ${e.links.bundle}`);
      line(`   - Run JSON: ${e.links.run_json}`);
      if (e.excerpt && clean(e.excerpt) !== clean(f.observed) && clean(e.excerpt) !== clean(f.title)) {
        line();
        for (const l of String(e.excerpt).trimEnd().split("\n")) line(`   > ${l}`);
      }
      line();
    });
  });
  return out.join("\n");
}
