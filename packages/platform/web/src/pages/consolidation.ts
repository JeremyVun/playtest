// Group duplicate suspected bugs: scope, run, review, apply
// (docs/contracts/hosted.md, "Candidate consolidation").
//
// Two surfaces. `/p/:key/consolidation` shows the deterministic scope of a run
// — how many candidates were routed by score alone, how many clusters need a
// model call, and how many prompt bytes that costs — so the reviewer confirms a
// known spend rather than a mystery. `/p/:key/consolidation/:id` is the review
// screen: every proposed group, its target or proposed title, each candidate's
// claim and all of its evidence links, and accept / edit / leave-unresolved.
//
// Nothing here can mutate a finding: a plan is a proposal until Apply.
//
// Live updates come from the feed (the push channel), never a tight poll, and a
// repaint restores keyboard focus so an update cannot steal the reviewer's place.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { link, navigate } from "../lib/router.js";
import { page } from "../lib/shell.js";
import { hasRole, autoDedupeOn } from "../lib/state.js";
import { statusChip, toast, toastError, emptyState, errorState, confirmModal } from "../lib/ui.js";
import { ago, short, clamp } from "../lib/labels.js";
import { debouncedFeedRefresh, preserveFocus } from "../lib/live-page.js";
import { projectPage } from "../lib/project-page.js";
import {
  applySummary,
  decisionPayload,
  initialDecisions,
  isEdited,
  itemTarget,
  originLabel,
  ranBy,
  requiresModel,
  scopeLine,
  usageLine,
} from "../lib/consolidation.js";

const FEED_TYPES: WebDynamic = ["consolidation.planned", "consolidation.applied", "consolidation.auto_applied", "finding.created"];

let live: WebDynamic = null;
function stopLive() {
  live?.stop();
  live = null;
}

/** `/p/:key/consolidation` — scope, run, and recent plans. */
export async function consolidationPage(projectKey: WebDynamic) {
  stopLive();
  const context = projectPage(projectKey, {
    nav: "findings",
    title: "Group duplicates",
    loading: "Measuring scope…",
  });
  if (!context) return;
  const { main, project } = context;

  live = debouncedFeedRefresh(projectKey, { types: FEED_TYPES, refresh: load });
  await load();

  async function load() {
    try {
      const [preview, plans] = await Promise.all([
        api.get(`/projects/${projectKey}/consolidation/preview`),
        api.get(`/projects/${projectKey}/consolidation-plans?limit=20`),
      ]);
      if (!live?.current()) return;
      preserveFocus(() => paint(preview, plans.items));
    } catch (err: WebDynamic) {
      mount(main, page({ title: "Group duplicates", body: errorState(err, load) }));
    }
  }

  function paint(preview: WebDynamic, plans: WebDynamic) {
    const canReview = hasRole(project.id, "reviewer");
    // The manual flow follows the project's auto-dedupe toggle (see findings.ts):
    // with the sweep on this page is pure history — no run button, because a
    // catch-up sweep fires whenever the toggle turns on, so there is never a
    // backlog only a manual run could clear.
    const auto = autoDedupeOn(project);
    const s = preview.scope || {};
    const nothing = !s.unassigned_candidates;

    // The card leads with what a run would DO, in plain words; the retrieval
    // pins and thresholds are provenance a reviewer rarely needs, folded away
    // rather than deleted (round-2 uplift: the old card read as a debug dump).
    const scope = h("div.card.pad", {},
      h("p", { style: "margin-top:0" }, h("strong", {}, scopeLine(preview))),
      preview.requires_model
        ? h("p.dim", {},
            `Verification asks ${preview.model} whether the clustered reports describe the same bug — ` +
            "claims only, never screenshots, request bodies, or credentials. Typical cost is a cent or two.")
        : h("p.dim", {}, "Everything routes on lexical score alone — this pass is free."),
      h("p.dim", {},
        "Reports are first scored against this project's findings and each other: a single strong match becomes " +
        "a proposed merge, no match at all stands alone, and only the ambiguous middle reaches the model."),
      s.clusters_dropped_by_cap
        ? h("p.dim", {}, `${s.clusters_dropped_by_cap} cluster(s) exceed the per-run cap and are left for the next run.`)
        : null,
      h("details.dim", { style: "font-size:12.5px" },
        h("summary", { style: "cursor:pointer" }, "Technical details"),
        h("div", { style: "margin-top:6px" },
          `thresholds: k=${s.thresholds?.k} · floor=${s.thresholds?.floor} · auto-suggest=${s.thresholds?.auto_suggest}`,
          h("br"),
          `shortlist ${preview.shortlist_version}` +
          (preview.model ? ` · model ${preview.model}` : "") +
          (s.prompt_bytes ? ` · ${s.prompt_bytes} prompt bytes` : ""))),
    );

    const history = plans.length
      ? h("div.card", {}, h("table.rows", {},
          h("thead", {}, h("tr", {},
            h("th", {}, "Plan"), h("th", {}, "Ran by"), h("th", {}, "Status"), h("th", {}, "Groups"),
            h("th", {}, "Cost"), h("th", {}, "When"))),
          h("tbody", {}, ...plans.map((p: WebDynamic) => h("tr", { style: "cursor:pointer", onclick: (e: WebDynamic) => { if (!e.target.closest("a")) navigate(`/p/${projectKey}/consolidation/${p.id}`); } },
            h("td", {}, link(`/p/${projectKey}/consolidation/${p.id}`,
              h("span.id", { "data-fk": `p:${p.id}` }, short(p.id)))),
            h("td.dim", {}, ranBy(p)),
            h("td", {}, statusChip(p.status === "applied" ? "pass" : p.status === "discarded" ? "neutral" : "running", p.status)),
            h("td.dim", {}, `${p.item_count} group${p.item_count === 1 ? "" : "s"}${p.unresolved_count ? ` · ${p.unresolved_count} unresolved` : ""}`),
            h("td.dim", {}, usageLine(p)),
            h("td.dim", {}, ago(p.created_at)),
          ))),
        ))
      : emptyState("No dedupe passes yet",
          auto
            ? "After a run reports, the automatic dedupe sweep files its plan here — obvious duplicates merge on their own, and anything uncertain waits in Needs review."
            : "A consolidation plan is a proposal you review before anything changes.");

    mount(main, page({
      crumbs: [link(`/p/${projectKey}/findings?filter=review`, "Findings — needs review"), " / ",
        auto ? "Dedupe history" : "Find duplicates"],
      title: auto ? "Dedupe history" : "Find duplicates",
      sub: auto
        ? "duplicates merge automatically after each run — every pass is recorded here; uncertain groupings always wait in Needs review"
        : "group duplicate claims into one finding — you review every grouping before it is applied",
      // With the sweep on there is deliberately no run button: the toggle
      // switching on fires a catch-up sweep, so a backlog never strands.
      actions: !auto && canReview && !nothing
        ? [h("button.btn.primary", { "data-fk": "run", onclick: () => run(preview) }, "Find duplicates now")]
        : [],
      body: h("div.stack", {},
        auto
          ? null
          : nothing
            ? emptyState("Nothing waiting to be grouped", "Every report in this project has been reviewed or already grouped.")
            : scope,
        h("h2.section-title", {}, auto ? "Passes" : "Past passes"),
        history),
    }));
  }

  async function run(preview: WebDynamic) {
    const confirmed = await confirmModal({
      title: "Find duplicates now?",
      body: h("div", {},
        h("p", {}, scopeLine(preview)),
        h("p.dim", {}, requiresModel(preview)
          ? `Each group to verify costs one ${preview.model} call carrying claims only — no screenshots, ` +
            "request bodies, or credentials. Nothing changes until you apply the plan."
          : "Everything routes by score alone: this pass makes no model call."),
      ),
      confirmLabel: "Find duplicates",
    });
    if (!confirmed) return;
    try {
      const plan = await api.post(`/projects/${projectKey}/consolidation`, {});
      toast("Plan ready for review", "nothing has changed yet — review the groups and apply", "ok");
      navigate(`/p/${projectKey}/consolidation/${plan.id}`);
    } catch (err: WebDynamic) { toastError(err); }
  }
}

/** `/p/:key/consolidation/:id` — the review screen. */
export async function consolidationPlanPage(projectKey: WebDynamic, planId: WebDynamic) {
  stopLive();
  const context = projectPage(projectKey, { nav: "findings", title: "Consolidation plan" });
  if (!context) return;
  const { main, project } = context;

  let decisions: WebDynamic = null;
  live = debouncedFeedRefresh(projectKey, {
    types: FEED_TYPES,
    refresh: load,
    accepts: (event: WebDynamic) => event.entity?.plan_id === planId,
  });
  await load();

  async function load() {
    try {
      const plan = await api.get(`/consolidation-plans/${planId}`);
      if (!live?.current()) return;
      // Keep the reviewer's in-progress edits across a live repaint; only seed
      // decisions the first time, or when the plan's items change underneath.
      if (!decisions || [...decisions.keys()].join() !== plan.items.map((i: WebDynamic) => i.id).join()) {
        decisions = initialDecisions(plan);
      }
      preserveFocus(() => paint(plan));
    } catch (err: WebDynamic) {
      mount(main, page({ title: "Consolidation plan", body: errorState(err, load) }));
    }
  }

  function paint(plan: WebDynamic) {
    const canReview = hasRole(project.id, "reviewer") && plan.status === "proposed";
    const summary = applySummary(plan, decisions);

    const autoRan = ranBy(plan) === "auto-dedupe";
    const head = h("div.card.pad", {},
      h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" },
        statusChip(plan.status === "applied" ? "pass" : plan.status === "discarded" ? "neutral" : "running", plan.status),
        autoRan ? h("span.chip", { title: "planned by the automatic post-run dedupe sweep" }, "auto-dedupe") : null,
        h("span.chip", {}, `${plan.item_count} proposed group${plan.item_count === 1 ? "" : "s"}`),
        plan.unresolved_count ? h("span.chip.state-muted", {}, `${plan.unresolved_count} unresolved`) : null,
      ),
      h("p.dim", {}, usageLine(plan)),
      plan.status === "proposed"
        ? h("p.dim", {}, "This is a proposal over ids the server supplied. Nothing has changed yet.")
        : autoRan
          ? h("p.dim", {}, "The sweep applied only high-confidence groups; weaker matches became suggestions or stayed in Needs review.")
          : null,
      h("details.dim", { style: "font-size:12.5px" },
        h("summary", { style: "cursor:pointer" }, "Technical details"),
        h("div", { style: "margin-top:6px" },
          `shortlist ${plan.shortlist_version} · match text ${plan.match_text_version}` +
          (plan.model ? ` · model ${plan.model}` : "") +
          ` · k=${plan.thresholds?.k} floor=${plan.thresholds?.floor} auto-suggest=${plan.thresholds?.auto_suggest}`)),
    );

    const items = plan.items.length
      ? h("div.stack", {}, ...plan.items.map((item: WebDynamic) => itemCard(plan, item, canReview)))
      : emptyState("Nothing proposed", "Retrieval found no grouping to propose.");

    const unresolved = plan.unresolved.length
      ? h("div.card.pad", {},
          h("p", {}, h("strong", {}, "Left unresolved: "), `${plan.unresolved.length} report${plan.unresolved.length === 1 ? "" : "s"}`),
          ...plan.unresolved.map((u: WebDynamic) => h("div.dim", {},
            link(`/p/${projectKey}/findings/${u.candidate_id}`, clamp(u.candidate?.claim?.title || u.candidate?.title || u.candidate_id, 80)),
            ` — ${u.reason}`)))
      : null;

    mount(main, page({
      crumbs: [link(`/p/${projectKey}/findings`, "Findings"), " / ",
        link(`/p/${projectKey}/consolidation`, "Consolidate"), " / ", short(plan.id)],
      title: "Consolidation plan",
      sub: canReview
        ? `${summary.accepted} accepted · ${summary.skipped} left unresolved · ${summary.edited} edited`
        : `proposed ${ago(plan.created_at)}`,
      actions: canReview
        ? [
            h("button.btn.primary", { "data-fk": "apply", onclick: () => apply(plan) },
              `Apply ${summary.accepted} group${summary.accepted === 1 ? "" : "s"}`),
            h("button.btn", { "data-fk": "discard", onclick: () => discard(plan) }, "Discard plan"),
          ]
        : [],
      body: h("div.stack", {}, head, h("h2.section-title", {}, "Proposed groups"), items, unresolved),
    }));
  }

  function itemCard(plan: WebDynamic, item: WebDynamic, canReview: WebDynamic) {
    const d = decisions.get(item.id) || { action: "accept" };
    const target = itemTarget(item);
    const edited = isEdited(item, d);

    const targetRow = target.kind === "existing"
      ? h("div", {}, h("strong", {}, "Merge into existing finding: "),
          link(`/p/${projectKey}/findings/${item.finding_id}`, target.label),
          item.finding?.state ? h("span.dim", {}, ` (${item.finding.state})`) : null)
      : h("div", {}, h("strong", {}, "New finding: "),
          canReview
            ? h("input", {
                "data-fk": `title:${item.id}`,
                value: d.proposed_title ?? "",
                placeholder: "title for the new finding",
                style: "width:min(520px,100%)",
                oninput: (e: WebDynamic) => { d.proposed_title = e.target.value; decisions.set(item.id, d); },
                onchange: () => preserveFocus(() => paint(plan)),
              })
            : h("span", {}, target.label));

    return h("div.card.pad", {},
      h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" },
        statusChip(d.action === "accept" ? "pass" : "neutral", d.action === "accept" ? "accept" : "leave unresolved"),
        h("span.chip", {}, originLabel(item)),
        edited ? h("span.chip", {}, "edited") : null,
      ),
      targetRow,
      item.reason ? h("p.dim", {}, item.reason) : null,
      h("table.rows", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Report"), h("th", {}, "Claim"), h("th", {}, "Evidence"))),
        h("tbody", {}, ...item.candidates.map((c: WebDynamic) => h("tr", {},
          h("td", {}, link(`/p/${projectKey}/findings/${c.id}`, clamp(c.claim?.title || c.title || c.id, 70)),
            h("div.desc", {}, `${c.category}${c.story_id ? ` · ${c.story_id}` : ""}`)),
          h("td", {}, c.claim?.expected ? h("div.dim", {}, `expected: ${clamp(c.claim.expected, 120)}`) : null,
            c.claim?.observed ? h("div.dim", {}, `observed: ${clamp(c.claim.observed, 120)}`) : null),
          h("td", {}, ...(c.evidence || []).map((e: WebDynamic) =>
            h("div", {}, link(e.viewer_url, `${e.case_id}${e.step_from != null ? ` step ${e.step_from}` : ""} →`)))),
        ))),
      ),
      canReview
        ? h("div", { style: "display:flex;gap:8px;margin-top:8px" },
            h("button.btn", {
              "data-fk": `toggle:${item.id}`,
              onclick: () => {
                d.action = d.action === "accept" ? "skip" : "accept";
                decisions.set(item.id, d);
                preserveFocus(() => paint(plan));
              },
            }, d.action === "accept" ? "Leave unresolved" : "Accept this group"),
            target.kind === "existing"
              ? h("button.btn.ghost", {
                  "data-fk": `detach:${item.id}`,
                  onclick: () => {
                    d.finding_id = null;
                    d.proposed_title = item.candidates[0]?.claim?.title || "";
                    decisions.set(item.id, d);
                    preserveFocus(() => paint(plan));
                  },
                }, "Make a new finding instead")
              : null,
          )
        : null,
    );
  }

  async function apply(plan: WebDynamic) {
    let payload;
    try {
      payload = decisionPayload(plan, decisions);
    } catch (err: WebDynamic) { return toastError(err); }
    const summary = applySummary(plan, decisions);
    const confirmed = await confirmModal({
      title: "Apply this plan?",
      body: h("div", {},
        h("p", {}, `${summary.accepted} group(s) covering ${summary.candidates} report(s) will merge into single findings, ` +
          "carrying every cited run and step."),
        h("p.dim", {}, `${summary.skipped} group(s) stay unresolved; those reports remain in Needs review.`)),
      confirmLabel: "Apply",
    });
    if (!confirmed) return;
    try {
      await api.post(`/consolidation-plans/${plan.id}/apply`, { decisions: payload });
      toast("Plan applied", "each accepted group is one finding with all its evidence", "ok");
      navigate(`/p/${projectKey}/findings`);
    } catch (err: WebDynamic) { toastError(err); }
  }

  async function discard(plan: WebDynamic) {
    const confirmed = await confirmModal({
      title: "Discard this plan?",
      body: h("p", {}, "Everything stays in the queue exactly as it is."),
      confirmLabel: "Discard",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.post(`/consolidation-plans/${plan.id}/discard`, {});
      toast("Plan discarded", "nothing changed", "ok");
      navigate(`/p/${projectKey}/consolidation`);
    } catch (err: WebDynamic) { toastError(err); }
  }
}
