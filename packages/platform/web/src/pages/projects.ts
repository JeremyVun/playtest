// Project list + project home. The home is the UX "Project home" screen: health
// tiles (pass rate prominent, score only ever a sparkline), the needs-attention
// list with streak context, and per-suite cards with their latest run group —
// every number deep-links to its evidence (principle 4).
import { api } from "../lib/api.js";
import { h, mount, clear } from "../lib/dom.js";
import { link, navigate } from "../lib/router.js";
import { renderFrame, page } from "../lib/shell.js";
import { state, loadProjects, hasRole } from "../lib/state.js";
import { toast, toastError, emptyState, formModal, statusChip, sparkline, formField, srOnly } from "../lib/ui.js";
import { ago } from "../lib/labels.js";
import { findingStateLabel } from "../lib/finding-buckets.js";
import { initialDefaultsYaml } from "../lib/defaults-form.js";
import {
  DRIVERS, PLATFORMS, driverLabel, driverGist,
  applicationPickerLabel, keyFromName, keyProblem, ringUrlProblem,
} from "../lib/rings.js";
import { projectPage } from "../lib/project-page.js";

export async function projectsList() {
  const main = renderFrame({});
  const body = h("div", {},
    h("div.grid-tiles", {},
      // The name the person chose is the whole tile. The key is derived from
      // that name, so printing it here restated the headline in monospace for
      // every project; it stays where it is actually needed — the URL, the CLI,
      // and (immutably) Settings.
      ...state.projects.map((p: WebDynamic) => {
        // The whole tile is the target, so the name reads as a heading (ink)
        // and the card border carries the hover — a lone accent-blue word in an
        // otherwise empty box read as a stray link.
        const a = link(`/p/${p.key}`, h("div.tile", {}, h("div.v.sm", {}, p.name)));
        a.className = "quiet-link";
        return a;
      }),
    ),
    state.projects.length ? null : emptyState(
      "No projects yet",
      "A project is a team/app and its suites. Create one to get started.",
      h("button.btn.primary", { onclick: () => newProjectModal() }, "New project"),
    ),
  );
  mount(main, page({
    title: "Projects",
    actions: [h("button.btn.primary", { onclick: () => newProjectModal() }, "+ New project")],
    body,
  }));
}

function newProjectModal() {
  const close = formModal("New project", () => {
    const name = h("input", { type: "text", placeholder: "Acme Checkout" });
    const where = urlPreview(name, "acme-checkout", (k: WebDynamic) => `/p/${k}`);
    const submitBtn = h("button.btn.primary", { type: "submit" }, "Create");
    return h("form", { onsubmit: submit },
      field("Name", name, where),
      h("div.modal-actions", {},
        h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"),
        submitBtn,
      ),
    );
    // The key is derived, never asked for: nobody creating their first project
    // has an opinion about their URL slug, and nothing later in the product
    // requires them to know it. It stays visible (and immutable) in Settings.
    async function submit(e: WebDynamic) {
      e.preventDefault();
      submitBtn.disabled = true;
      try {
        const p = await createUnique(slugify(name.value) || "project",
          (key: WebDynamic) => api.post("/projects", { key, name: name.value.trim() }));
        await loadProjects();
        close();
        toast("Project created", p.name, "ok");
        navigate(`/p/${p.key}`);
      } catch (err: WebDynamic) { submitBtn.disabled = false; toastError(err); }
    }
  });
}

/**
 * POST with a derived key, stepping the suffix past anyone who got there first.
 * Uniqueness is the server's to enforce, so the collision is a 409 to walk past
 * — not a field to make a person fill in.
 */
async function createUnique(base: WebDynamic, post: WebDynamic) {
  for (let n = 1; n <= 25; n++) {
    try {
      return await post(n === 1 ? base : `${base}-${n}`);
    } catch (err: WebDynamic) {
      if (err.status !== 409) throw err;
    }
  }
  throw new Error(`couldn't find a free name near "${base}" — try a different one`);
}

/**
 * A live "this will live at /p/acme-checkout" line under a name field. Honest
 * without being a question: it shows the address the name produces, and asks
 * for no decision about it.
 */
function urlPreview(nameInput: WebDynamic, placeholderKey: WebDynamic, toPath: WebDynamic) {
  const out = h("span.mono", {}, toPath(placeholderKey));
  const line = h("span", {}, "Lives at ", out);
  nameInput.addEventListener("input", () => {
    out.textContent = toPath(slugify(nameInput.value) || placeholderKey);
  });
  return line;
}

export async function projectHome(projectKey: WebDynamic) {
  const context = projectPage(projectKey, {
    nav: "overview",
    title: "Project not found",
    loading: false,
    missingTitle: "No project called that",
    missingBody: `Nothing here is named "${projectKey}" — either it doesn't exist, or you're not a member of it. A project admin can add you.`,
    missingAction: h("div.empty-actions", {}, link("/projects", h("span.btn.primary", {}, "See all projects"))),
  });
  if (!context) return;
  const { main, project } = context;

  mount(main, page({ title: "Suites", body: h("div.dim", {}, "Loading…") }));

  // One parallel batch of two: suites is the page's spine (its failure is the
  // error path); health carries everything else the dashboard says — tiles,
  // attention, the open majors and the needs-review tally ride it — and
  // degrades to "—" and run/review rows, loudly labeled, never a blank crash.
  let suites: WebDynamic = [];
  const [suitesErr, health] = await Promise.all([
    api.cached(`/projects/${projectKey}/suites`, { ttl: 15_000 })
      .then((r: WebDynamic) => { suites = r.items; return null; }, (err: WebDynamic) => err),
    api.get(`/projects/${projectKey}/health`).catch(() => null),
  ]);
  if (suitesErr) return toastError(suitesErr);

  // Before the first run there is nothing to summarize: a pass rate of "—" and
  // the words "no graded runs this week" told a new project's owner nothing
  // they could act on. The checklist replaces it until a run exists.
  const everRan = (health?.suites || []).length > 0;
  // Health is what knows whether a run ever happened, so its failure is not
  // evidence that none did: a dropped request used to tell a team with a year
  // of runs to go create their first application. No health, no checklist —
  // the suite table alone is the honest degraded page.
  const showChecklist = !!health && !everRan;

  // A compact pass-rate summary, not a wall of equal-weight tiles. Review,
  // runs-today, spend, and storage no longer compete with the run verdict for
  // dashboard space (spend stays visible before launch and in run provenance).
  const passRate = health?.pass_rate_7d;
  const passed = health?.pass_count_7d;
  const graded = health?.graded_count_7d;
  const rateSeries = (health?.pass_rate_daily || []).map((d: WebDynamic) => d.rate).filter((r: WebDynamic) => r != null);
  const hasPassCounts = Number.isFinite(passed) && Number.isFinite(graded);
  const passDetail = !health
    ? "Health unavailable"
    : passRate == null
      ? "No graded stories in the last 7 days"
      : hasPassCounts
        ? `${passed} of ${graded} graded ${graded === 1 ? "story" : "stories"} passed`
        : "Graded story results from the last 7 days";
  // One fact per card: the rate card says the level (number + the sentence
  // that sizes it), the trend card says the direction. The old meter bar was
  // the percentage drawn a second time, and the sparkline crammed beside the
  // number answered a different question than the number does.
  const passSummary = !everRan ? null : h("div.pass-summary", {},
    h("div.k", {}, "7-day pass rate"),
    h("div.v", {}, passRate != null ? `${passRate}%` : "—"),
    h("div.pass-summary-detail", {}, passDetail),
  );
  const passTrend = everRan && rateSeries.length > 1
    ? h("div.pass-summary.pass-trend", {},
        h("div.k", {}, "Daily trend"),
        (() => {
          const s = sparkline(rateSeries, { w: 132, hgt: 30 });
          s.setAttribute("role", "img");
          s.setAttribute("aria-label",
            `Daily pass rate over the last 7 days, most recently ${rateSeries[rateSeries.length - 1]}%`);
          return s;
        })(),
      )
    : null;

  // When several changed journeys are pending, offer the contextual batch view.
  // A single pending candidate is decided on its own run page — no batch trip.
  const reviewAll = (health?.review_pending || 0) >= 2
    ? link(`/p/${projectKey}/review`,
        h("span.btn.btn-sm", {}, `Review all changed stories (${health.review_pending})`))
    : null;

  // Open major findings belong in the attention list: round-3 triagers hunting
  // "the product-problem claim" were misdirected into Review because findings
  // never surfaced here. Only CONFIRMED work rings this bell — an unreviewed
  // machine claim is a quiet count, never an attention row a person didn't
  // vet. Best-effort — the dashboard renders without them.
  const majorFindings = health?.major_findings ?? [];
  // Exact server-side counts — the old page-of-100 fetch silently capped this.
  // Both review queues render as rows in the attention card, same anatomy as
  // the alarm rows, but wearing their own tones: unvetted claims are muted
  // machine output, a looks-fixed suggestion is calm good news. Neither ever
  // wears an alarm tone — the card holds everything awaiting a person, and the
  // chip says with what urgency.
  const needsReview = health?.findings_needs_review ?? 0;
  const fixSuggested = health?.findings_fix_suggested ?? 0;

  const lastBySuite: WebDynamic = new Map((health?.suites || []).map((s: WebDynamic) => [s.suite_id, s]));
  const attention = health?.attention?.length || majorFindings.length || needsReview || fixSuggested
    ? h("div", {},
        h("div.label", { style: "margin:20px 0 8px" }, "Needs attention"),
        h("div.card", {}, h("div.att-list", {},
          ...(health?.attention || []).map((a: WebDynamic) => attentionRow(projectKey, a)),
          ...majorFindings.map((f: WebDynamic) => findingAttentionRow(projectKey, f)),
          fixSuggested ? looksFixedRow(projectKey, fixSuggested) : null,
          needsReview ? reviewQueueRow(projectKey, needsReview) : null)),
      )
    : null;

  const canEdit = hasRole(project.id, "editor");

  // Most-recently-active first. Sorting by suite id put a brand-new empty suite
  // above the one with four stories and a live run, so the project's real work
  // sat below its placeholder.
  const activity = (s: WebDynamic) => lastBySuite.get(s.id)?.created_at || s.updated_at || 0;
  const ordered: WebDynamic = [...suites].sort((a, b) => String(activity(b)).localeCompare(String(activity(a))));

  const suiteCards = suites.length
    ? h("div", {},
        h("div.label", { style: "margin:20px 0 8px" }, "All suites"),
        h("div.card", {}, h("table.rows", {},
          h("thead", {}, h("tr", {}, h("th", {}, "Suite"), h("th", {}, "Stories"), h("th", {}, "Latest result"), h("th", {}, "Findings"), h("th", {}, "Updated"))),
          // story_count and open_findings ride the suites/health projections (no
          // per-suite reads); the row IS the link — same pattern as before.
          h("tbody", {}, ...ordered.map((s: WebDynamic) => h("tr", { style: "cursor:pointer", onclick: (e: WebDynamic) => { if (!e.target.closest("a, button")) navigate(`/p/${projectKey}/suites/${s.slug}`); } },
            h("td", {},
              // Name only — the slug is the URL/CLI id and lives in Suite settings,
              // same rationale as project tiles not reprinting the key.
              link(`/p/${projectKey}/suites/${s.slug}`, h("span.rowtitle", {}, s.name))),
            h("td", {}, storyCountCell(projectKey, s, canEdit)),
            h("td", {}, lastRunCell(projectKey, lastBySuite.get(s.id))),
            h("td", {}, suiteFindingsCell(projectKey, lastBySuite.get(s.id))),
            h("td.dim", {}, fmtDate(s.updated_at)),
          ))),
        )),
      )
    : emptyState("No suites yet", "A suite is a set of user-journey stories for one app.",
        canEdit ? h("button.btn.primary", { onclick: () => newSuiteModal(projectKey) }, "New suite") : null);

  // Step one of the checklist is "create an application", and only the
  // applications list can say whether that happened — suites are a later step,
  // so inferring it from them left the step unticked after the user did it.
  // Only a project that has never run renders the checklist, so the extra read
  // is scoped to exactly those projects; a failure leaves the step unticked
  // rather than the page broken.
  let applications: WebDynamic = [];
  if (showChecklist) {
    applications = await api.cached(`/projects/${projectKey}/applications`, { ttl: 15_000 })
      .then((r: WebDynamic) => r.items || [], () => []);
  }
  const checklist = showChecklist ? firstRunChecklist(projectKey, project, suites, applications, canEdit) : null;

  mount(main, page({
    title: "Suites",
    actions: canEdit && suites.length ? [h("button.btn.primary", { onclick: () => newSuiteModal(projectKey) }, "+ New suite")] : [],
    body: h("div", {},
      passSummary || reviewAll ? h("div.overview-head", {}, passSummary, passTrend, reviewAll) : null,
      checklist,
      attention,
      // The checklist already carries "create a suite"; a second empty state
      // under it would be the third New suite button on one screen.
      checklist && !suites.length ? null : suiteCards),
  }));
}

/**
 * The path from an empty project to a first run.
 *
 * "Somewhere to point" is a step, and the first one: a new project starts with
 * no application, because what a suite runs against is a decision — "this web
 * app, at this URL" — that the platform cannot guess. It is one step, not
 * three: create the application, give ring `local` its URL, and every suite
 * bound to it is launchable.
 */
function firstRunChecklist(projectKey: WebDynamic, project: WebDynamic, suites: WebDynamic, applications: WebDynamic, canEdit: WebDynamic) {
  const firstSuite = suites[0] || null;
  const stories = suites.reduce((n: WebDynamic, s: WebDynamic) => n + (s.story_count || 0), 0);
  const canManage = hasRole(project.id, "developer");
  const steps: WebDynamic = [
    {
      // The applications list is the only honest answer: a suite proves an
      // application exists, but an application can exist with no suite yet —
      // which is the state the user is in right after doing this step.
      done: applications.length > 0 || suites.length > 0,
      title: "Create an application",
      why: "One executable surface — a web app, an HTTP API, a mobile build — and an environment with the URL its runs point at.",
      // Every control on this list repeats its step's own words, and does that
      // step: `?new=1` opens the create form on arrival, so the button creates
      // an application rather than dropping the reader on a page that has one.
      action: canManage
        ? link(`/p/${projectKey}/applications?new=1`, h("span.btn.btn-sm", {}, "Create an application"))
        : h("span.faint", { style: "font-size:12px" }, "ask a developer on this project"),
    },
    {
      done: suites.length > 0,
      title: "Create a suite",
      why: "A set of user-journey stories, bound to one of those applications.",
      // A step with a blank Do column read as broken. Every step says either
      // how to do it or who can.
      action: canEdit
        ? h("button.btn.btn-sm", { onclick: () => newSuiteModal(projectKey) }, "Create a suite")
        : h("span.faint", { style: "font-size:12px" }, "ask an editor on this project"),
    },
    {
      done: stories > 0,
      title: "Write your first story",
      why: "One thing a user is trying to do, in their words. Playtest works out the clicks.",
      // The hint tells the reader what to do next, not what state the app is
      // in: "after the suite exists" made them infer the instruction.
      action: canEdit && firstSuite
        ? link(`/p/${projectKey}/suites/${firstSuite.slug}/new`, h("span.btn.btn-sm", {}, "Write a story"))
        : canEdit
          ? h("span.faint", { style: "font-size:12px" }, "create a suite first")
          : h("span.faint", { style: "font-size:12px" }, "ask an editor on this project"),
    },
  ];
  const left = steps.filter((s: WebDynamic) => !s.done).length;
  return h("div", {},
    h("div.label", { style: "margin:4px 0 8px" }, "Set up your first run"),
    h("div.card", {}, h("ul.checklist", {}, ...steps.map((s: WebDynamic, i: WebDynamic) =>
      h(`li${s.done ? ".done" : ""}`, {},
        h("span.tick", { "aria-hidden": "true" }, s.done ? "✓" : String(i + 1)),
        h("span.step", {},
          h("div.step-title", {}, s.done ? h("span.visually-hidden", {}, "Done: ") : null, s.title),
          h("div.step-why", {}, s.why)),
        h("span.step-do", {}, s.done ? h("span.faint", { style: "font-size:12px" }, "done") : s.action),
      ))),
    ),
    left === 0
      ? h("div.dim", { style: "margin-top:8px;font-size:12.5px" }, "That's everything — open a suite and press ▶ Run.")
      : null,
    // Sign-in and runner labels used to be answered here, in a footnote under
    // three steps. They belong where they are configured — the application and
    // its environments — not in the way of the first run.
  );
}

/** Story count, with the way to fix a zero right in the cell. */
function storyCountCell(projectKey: WebDynamic, s: WebDynamic, canEdit: WebDynamic) {
  if (s.story_count == null) return h("span.faint", {}, "—");
  if (s.story_count > 0) return String(s.story_count);
  return h("span", {}, h("span.faint", {}, "0 "),
    canEdit ? link(`/p/${projectKey}/suites/${s.slug}/new`, h("span.btn.primary.btn-sm", {}, "Add a story")) : null);
}

/**
 * A suite's finding counts from the health projection, as words rather than
 * pills: each number is a link to the findings tab that shows exactly that
 * number. Open counts confirmed work only; "looks fixed" is the auto-resolve
 * sweep's pending suggestions (the review tab's Looks-fixed queue, not a
 * story-health guess); unreviewed machine claims ride a quiet "to review".
 */
function suiteFindingsCell(projectKey: WebDynamic, s: WebDynamic) {
  const open = s?.open_findings || 0;
  const review = s?.needs_review_findings || 0;
  const suggested = s?.fix_suggested_findings || 0;
  if (!open && !review) return h("span.faint", {}, "—");
  const parts: WebDynamic = [];
  if (open) {
    parts.push(link(`/p/${projectKey}/findings`,
      h("span", { title: "confirmed open findings with evidence in this suite" }, `${open} open`)));
    if (suggested) {
      parts.push(link(`/p/${projectKey}/findings?filter=review`,
        h("span", { title: "a newer run passed everywhere these were seen — confirm or reopen under Needs review" },
          `${suggested} look${suggested === 1 ? "s" : ""} fixed`)));
    }
  }
  if (review) {
    parts.push(link(`/p/${projectKey}/findings?filter=review`,
      h("span", { title: "machine-filed claims awaiting review — not confirmed findings" }, `${review} to review`)));
  }
  const cell = h("span", {});
  parts.forEach((p: WebDynamic, i: WebDynamic) => {
    if (i) cell.append(h("span.faint", {}, " · "));
    cell.append(p);
  });
  return cell;
}

/** One needs-attention row — every claim links to its evidence (principle 4). */
function attentionRow(projectKey: WebDynamic, a: WebDynamic) {
  const to = a.kind === "changed" && a.run_group_id && a.run_db_id
    // A changed journey is a run awaiting a decision — land on its evidence page
    // at the Diff view, where Accept/Reject live, not a separate review queue.
    ? `/p/${projectKey}/runs/${a.run_group_id}/${a.run_db_id}?view=diff`
    : a.kind === "fail" && a.run_group_id && a.run_db_id
      ? `/p/${projectKey}/runs/${a.run_group_id}/${a.run_db_id}`
      : a.run_group_id ? `/p/${projectKey}/runs/${a.run_group_id}` : `/p/${projectKey}/runs`;
  const chip = a.kind === "fail" ? statusChip("fail", "fail")
    : a.kind === "changed" ? statusChip("changed", "changed")
    : statusChip("infra", "infra");
  const a2 = link(to, h("div.att-row", {},
    chip,
    h("span.id", {}, a.case_id || (a.run_group_id ? `run ${String(a.run_group_id).slice(0, 8)}` : "")),
    h("span.dim", {}, a.note || ""),
  ));
  a2.className = "quiet-link";
  return a2;
}

/** The looks-fixed queue as one attention row: calm tone — the system is
    reporting good news that still needs a person's click, not an alarm. */
function looksFixedRow(projectKey: WebDynamic, count: WebDynamic) {
  const a = link(`/p/${projectKey}/findings?filter=review`, h("div.att-row", {},
    h("span.chip.calm", {}, "looks fixed"),
    h("span.rowtitle", {}, `${count} open finding${count === 1 ? "" : "s"} may be fixed`),
    h("span.dim", {}, "a newer run passed everywhere it was seen — resolve or reopen"),
  ));
  a.className = "quiet-link";
  return a;
}

/** Unvetted machine claims as one attention row: muted, and the words say the
    system filed them — the human guarantee stays visible in the copy. */
function reviewQueueRow(projectKey: WebDynamic, count: WebDynamic) {
  const a = link(`/p/${projectKey}/findings?filter=review`, h("div.att-row", {},
    h("span.chip.state-muted", {}, "to review"),
    h("span.rowtitle", {}, `${count} report${count === 1 ? "" : "s"} filed from run evidence`),
    h("span.dim", {}, "confirm the real ones, dismiss the rest"),
  ));
  a.className = "quiet-link";
  return a;
}

/** An open major finding in the attention list — the durable product claim,
    distinct from the run rows above it (text chip, not a run glyph). */
function findingAttentionRow(projectKey: WebDynamic, f: WebDynamic) {
  // "accepted" read to a newcomer as CLOSED here, when it means the opposite —
  // a human confirmed the bug is real. One lifecycle vocabulary, one mapping
  // (lib/finding-buckets.ts).
  const a = link(`/p/${projectKey}/findings/${f.id}`, h("div.att-row", {},
    h("span.chip.sev-major", {}, "finding"),
    h("span.rowtitle", {}, f.title),
    h("span.dim", {}, `${f.evidence_count} occurrence${f.evidence_count === 1 ? "" : "s"} · ${findingStateLabel(f.state).toLowerCase()}`),
  ));
  a.className = "quiet-link";
  return a;
}

/** The suite card's latest-group chip line: `✓2 ▲1 · 2 h ago`. */
function lastRunCell(projectKey: WebDynamic, s: WebDynamic) {
  if (!s) return h("span.faint", {}, "—");
  const bits: WebDynamic = [];
  if (s.pass) bits.push(h("span.status.pass", {}, h("span.glyph", {}, "✓"), String(s.pass)));
  if (s.fail) bits.push(h("span.status.fail", {}, h("span.glyph", {}, "✗"), String(s.fail)));
  if (s.changed) bits.push(h("span.status.changed", {}, h("span.glyph", {}, "▲"), String(s.changed)));
  if (!bits.length) bits.push(h("span.dim", {}, s.status));
  const a = link(`/p/${projectKey}/runs/${s.group_id}`,
    h("span", { style: "display:inline-flex;gap:8px;align-items:center" }, ...bits, h("span.faint", {}, ago(s.created_at))));
  a.className = "quiet-link";
  return a;
}

/**
 * New suite: what these stories are called, and which application they run
 * against.
 *
 * The application is asked here because a suite belongs to exactly one and the
 * binding is immutable — it decides the suite's driver and the rings it may
 * ever launch against. The URL is NOT asked here: a ring owns that, and hosted
 * execution applies it after the authored merge, so a field for it in this
 * dialog would be a field whose value always loses.
 *
 * Roles split the empty-project case. A developer may create the first
 * application inline — for web that is a name plus a ring URL, nothing more —
 * and an editor is told, in the server's own words, that a developer has to.
 */
export function newSuiteModal(projectKey: WebDynamic) {
  const project = state.projectByKey.get(projectKey);
  const canManage = hasRole(project?.id, "developer");
  const close = formModal("New suite", () => {
    const name = h("input", { type: "text", placeholder: "Checkout journeys" });
    const where = urlPreview(name, "checkout-journeys", (k: WebDynamic) => `/p/${projectKey}/suites/${k}`);
    const NEW = "__new";
    const application = h("select", { "aria-label": "Application", onchange: paintInline },
      h("option", { value: "" }, "Loading…"));
    const inlineSlot = h("div");
    // The application dialog's own questions, asked here in its own words: a
    // person who creates one from this dialog and one from Applications should
    // not have to notice they are two forms.
    const appName = h("input", { type: "text", placeholder: "Todo Web" });
    const appDriver = h("select", { "aria-label": "Surface", onchange: paintAppDriver },
      ...DRIVERS.map((d) => h("option", { value: d }, driverLabel(d))));
    const appDriverHint = h("div.hint", {}, driverGist("web"));
    const appPlatform = h("select", { "aria-label": "Platform" },
      ...PLATFORMS.map((p) => h("option", { value: p }, p === "ios" ? "iOS" : "Android")));
    const appPlatformSlot = h("div");
    const appUrl = h("input", { type: "text", placeholder: "http://127.0.0.1:4173" });
    // The environment question comes last, because it is the one thing the
    // application dialog does NOT ask — a suite created here is launchable, and
    // that costs one field.
    const appUrlField = field("Where do runs point?", appUrl, "Environment “local” gets this URL.");
    // A fieldset, so "Name" inside it is announced as the application's rather
    // than as a second suite name. The legend is for that reader only: the
    // option that opened this block already said it on screen.
    const inlineForm = h("fieldset.subform", {},
      h("legend", {}, srOnly("New application")),
      field("Name", appName),
      h("div.field", {}, h("div.field-label", {}, "Surface"), appDriver, appDriverHint),
      appPlatformSlot,
      appUrlField,
    );
    const err = h("div", { style: "font-size:var(--fs-sm)" });
    const submitBtn = h("button.btn.primary", { type: "submit" }, "Create");
    let applications: WebDynamic = null;

    loadApplications();
    return h("form", { onsubmit: submit },
      field("Name", name, where),
      field("Application", application),
      inlineSlot,
      err,
      h("div.modal-actions", {},
        h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"),
        submitBtn,
      ),
    );

    async function loadApplications() {
      try {
        ({ items: applications } = await api.cached(`/projects/${projectKey}/applications`));
      } catch (loadErr: WebDynamic) { applications = []; toastError(loadErr); }
      mount(application,
        ...applications.map((a: WebDynamic) =>
          h("option", { value: a.id }, applicationPickerLabel(a))),
        canManage ? h("option", { value: NEW }, "＋ Create an application…") : null);
      if (!applications.length && canManage) application.value = NEW;
      paintInline();
    }

    /** Inline creation, or the reason an editor cannot do it. */
    function paintInline() {
      if (!applications) return;
      if (!applications.length && !canManage) {
        // The server's own refusal, said before the request rather than after.
        mount(inlineSlot, h("div.preview-warn", {},
          "This project has no application yet, and a developer has to create the first one — what a suite runs against is a decision, so nothing is guessed for you."));
        submitBtn.disabled = true;
        return;
      }
      submitBtn.disabled = false;
      // Built once and shown or hidden: re-mounting it would take the field
      // being typed into with it.
      paintAppDriver();
      mount(inlineSlot, application.value === NEW ? inlineForm : null);
    }

    /** The surface decides whether there is a platform to name, or a URL to ask for. */
    function paintAppDriver() {
      appDriverHint.textContent = driverGist(appDriver.value);
      mount(appPlatformSlot, appDriver.value === "mobile"
        ? field("Platform", appPlatform, "Core picks XCUITest or UiAutomator2 from it, so a mobile application names one.")
        : null);
      // A mobile environment holds no URL: the claiming runner supplies the build.
      appUrlField.style.display = appDriver.value === "mobile" ? "none" : "";
    }

    async function submit(e: WebDynamic) {
      e.preventDefault();
      if (!name.value.trim()) {
        mount(err, h("span.status.fail", {}, h("span.glyph", {}, "✗"), "Name this suite — it is how it reads everywhere else."));
        return name.focus();
      }
      clear(err);
      submitBtn.disabled = true;
      let applicationId = application.value;
      let driver = applications?.find((a: WebDynamic) => a.id === applicationId)?.driver || "web";
      try {
        if (applicationId === NEW) {
          const created = await createApplicationInline();
          if (!created) return;
          applicationId = created.id;
          driver = created.driver;
        }
        const s = await createUnique(slugify(name.value) || "suite",
          (slug: WebDynamic) => api.post(`/projects/${projectKey}/suites`, {
            slug, name: name.value.trim(), application_id: applicationId,
          }));
        // Only a non-default driver is worth committing here; a web suite with
        // nothing configured yet is better off with NO defaults file than with
        // an empty one, which is exactly what "not set up yet" means to core.
        const content = initialDefaultsYaml({ driver });
        if (content) {
          // The suite exists either way; a failed defaults commit must not read
          // as a failed create, so it lands the person on Settings with the reason.
          try {
            await api.put(`/suites/${s.id}/files/playtest.yaml`, { content, note: "suite created" });
          } catch (commitErr: WebDynamic) {
            close();
            toastError(commitErr);
            return navigate(`/p/${projectKey}/suites/${s.slug}/settings`);
          }
        }
        close();
        toast("Suite created", s.name, "ok");
        navigate(`/p/${projectKey}/suites/${s.slug}`);
      } catch (err2: WebDynamic) { submitBtn.disabled = false; toastError(err2); }
    }

    /** An application and its `local` environment, in one gesture. */
    async function createApplicationInline() {
      const label = appName.value.trim() || name.value.trim();
      const driver = appDriver.value;
      const key = keyFromName(label);
      const keyBad = keyProblem(key, applications || [], { kind: "application" });
      if (keyBad) { submitBtn.disabled = false; appName.focus(); mount(err, h("span.status.fail", {}, h("span.glyph", {}, "✗"), keyBad)); return null; }
      const urlBad = ringUrlProblem(driver === "mobile" ? "" : appUrl.value, driver);
      if (urlBad) { submitBtn.disabled = false; appUrl.focus(); mount(err, h("span.status.fail", {}, h("span.glyph", {}, "✗"), urlBad)); return null; }
      const created = await api.post(`/projects/${projectKey}/applications`, {
        key, name: label, driver,
        ...(driver === "mobile" ? { platform: appPlatform.value } : {}),
      });
      await api.post(`/applications/${created.id}/rings`, {
        key: "local", name: "Local",
        ...(driver === "mobile" ? {} : { base_url: appUrl.value.trim() }),
      });
      return created;
    }
  });
}

const slugify = (s: WebDynamic) => String(s).toLowerCase().normalize("NFKD")
  .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

const field = formField;
const fmtDate = (d: WebDynamic) => (d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—");
