import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { link, navigate } from "../lib/router.js";
import { page } from "../lib/shell.js";
import { hasRole, autoDedupeOn } from "../lib/state.js";
import { statusChip, srOnly, toast, toastError, emptyState, errorState, formModal, copyText, formField } from "../lib/ui.js";
import { ago, short, clamp } from "../lib/labels.js";
import { debouncedFeedRefresh } from "../lib/live-page.js";
import { projectPage } from "../lib/project-page.js";
import { FINDING_BUCKETS, bucketId, bucketCounts, findingStateLabel, findingStateTone, findingStateGloss } from "../lib/finding-buckets.js";
import { categoryLabel } from "../lib/vocab.js";

let live: WebDynamic = null;
function stopLive() {
  live?.stop();
  live = null;
}

// Four disjoint user-facing buckets over the internal states: Needs review =
// new (machine-filed, unjudged), Open = reopened/accepted (a confirmed finding
// is still open work), Resolved, Rejected. The whole lifecycle vocabulary
// lives in lib/finding-buckets.js so it is stated once and the hermetic gate
// can assert it.
const FILTERS = FINDING_BUCKETS;

export async function findingsPage(projectKey: WebDynamic, query: WebDynamic = new URLSearchParams()) {
  stopLive();
  const context = projectPage(projectKey, { nav: "findings", title: "Findings" });
  if (!context) return;
  const { main, project } = context;
  const filter = bucketId(query.get("filter"));

  live = debouncedFeedRefresh(projectKey, {
    // consolidation.auto_applied: the auto-dedupe sweep merges rows without
    // emitting per-finding events, so the list listens for the sweep itself.
    // finding.fix_suggested: the auto-resolve sweep attached a "looks fixed"
    // suggestion; finding.resolved covers its auto-resolutions unchanged.
    types: ["finding.created", "finding.evidence_added", "finding.accepted", "finding.rejected", "finding.resolved", "finding.reopened", "finding.fix_suggested", "consolidation.auto_applied"],
    refresh: load,
  });

  await load();

  async function load() {
    try {
      // The work-bucket counts ride on every view of this page: they are the
      // numbers that tell a person work is waiting behind another tab, and a
      // Confirm visibly moves one from the review tally to the open tally.
      const [{ items }, tallies, suggested] = await Promise.all([
        api.get(`/projects/${projectKey}/findings?state=${encodeURIComponent(FILTERS[filter].state)}&limit=100`),
        api.get(`/projects/${projectKey}/findings/counts`).catch(() => null),
        // A pending "looks fixed" suggestion is review work — the sweep proved
        // a newer pass but the judgment stays human, so the review tab carries
        // these as its second queue.
        filter === "review"
          ? api.get(`/projects/${projectKey}/findings?state=reopened,accepted&fix_suggested=1&limit=100`).then((r: WebDynamic) => r.items).catch(() => [])
          : Promise.resolve([]),
      ]);
      if (!live?.current()) return;
      const counts = tallies ? bucketCounts(tallies.counts) : { [filter]: items.length };
      if (tallies?.fix_suggested) counts.review = (counts.review || 0) + tallies.fix_suggested;
      paint(items, counts, suggested);
    } catch (err: WebDynamic) {
      mount(main, page({ title: "Findings", body: errorState(err, load) }));
    }
  }

  function paint(items: WebDynamic, counts: WebDynamic = {}, suggested: WebDynamic = []) {
    const canReview = hasRole(project.id, "reviewer");
    // A filter is presented as a filter: the seg sits with the content it
    // narrows, not in the header where buttons act (same pattern as Runs).
    // The two WORK buckets always carry their tallies together — zero included,
    // because "Needs review · 0" is the receipt that the queue is clear.
    // Resolved and Rejected are archives; a number on an archive is noise.
    const filterSeg = h("div.seg", { role: "tablist", "aria-label": "Filter findings" },
      ...Object.entries(FILTERS).map(([id, f]: WebDynamic) => h(`button${id === filter ? ".on" : ""}`, {
        role: "tab",
        "aria-selected": String(id === filter),
        title: f.blurb,
        onclick: () => navigate(`/p/${projectKey}/findings?filter=${id}`),
      }, (id === "review" || id === "open") && counts[id] != null ? `${f.label} · ${counts[id]}` : f.label)));

    const reviewBucket = filter === "review";
    // The manual dedupe affordance follows the project's auto-dedupe toggle.
    // Sweep on: duplicate-grouping already happened — obvious duplicates merged
    // when their run reported, weaker matches arrived as "possibly the same bug
    // as" suggestions, and what remains is what the sweep deliberately left for
    // a person. No button (a button that duplicates automation teaches people
    // the automation can't be trusted); a quiet history link keeps the sweep's
    // work inspectable. Sweep off: the manual flow is the only dedupe path, so
    // it returns in full — a sentence next to the list it would act on, never
    // an unexplained header button.
    const auto = autoDedupeOn(project);
    const consolidateLine = reviewBucket && canReview
      ? (auto && items.length >= 1
          ? h("div.dim", {},
              "Duplicates are merged automatically as runs report — anything here needs your judgment. ",
              link(`/p/${projectKey}/consolidation`, "Dedupe history →"))
          : !auto && items.length >= 2
            ? h("div.dim", { style: "display:flex;align-items:center;gap:8px" },
                "Several of these may describe the same bug —",
                h("button.btn.btn-sm", { onclick: () => navigate(`/p/${projectKey}/consolidation`) }, "Find duplicates"),
                h("span.faint", {}, "(uses model calls)"))
            : null)
      : null;

    const listCard = items.length
      ? h("div.card", {}, h("table.rows.findings-index", {},
            h("thead", {}, h("tr", {},
              h("th", {}, "State"), h("th", {}, "Finding"), h("th", {}, "Severity"), h("th", {}, "Evidence"), h("th", {}, "Latest run"), h("th", {}, "Last seen"),
              reviewBucket && canReview ? h("th", {}, srOnly("Review actions")) : null)),
            // The title is a real <a> (keyboard/screen-reader reachable — a
            // tr onclick alone reads as inert text); row click stays for mouse.
            h("tbody", {}, ...items.map((f: WebDynamic) => h("tr", { style: "cursor:pointer", onclick: (e: WebDynamic) => { if (!e.target.closest("a, button")) navigate(`/p/${projectKey}/findings/${f.id}`); } },
              h("td", {}, findingChip(f), autoBadge(f)),
              // A finding's title is an English sentence; it was typeset as code.
              h("td", {}, link(`/p/${projectKey}/findings/${f.id}`, h("span.rowtitle", {}, displayTitle(f.title))),
                f.external_ref ? h("div.desc", {}, f.external_ref) : null,
                // A pre-attached suggestion is the one fact worth surfacing on
                // the row: reviewing a probable duplicate starts on its target.
                f.suggested_finding_id
                  ? h("div.desc", {}, "possibly the same bug as ",
                      link(`/p/${projectKey}/findings/${f.suggested_finding_id}`, displayTitle(f.suggested_finding_title) || short(f.suggested_finding_id)))
                  : null),
              h("td", {}, severityChip(f.severity)),
              h("td.dim", {}, String(f.evidence_count)),
              h("td", {}, storyHealthCell(f)),
              h("td.dim", {}, ago(f.last_seen)),
              // Routine triage is one click from the list; the detail page
              // stays the place to read evidence first. Dismiss keeps its
              // reason dialog — a suppression deserves a stated reason.
              reviewBucket && canReview
                ? h("td.row-actions", {},
                    h("button.btn.btn-sm", { onclick: () => confirmInline(f) }, "Confirm"),
                    h("button.btn.btn-sm", { onclick: () => dismissInline(f) }, "Dismiss"))
                : null,
            ))),
          ))
      : reviewBucket && suggested.length
        ? null // the looks-fixed queue below is the review work; a "nothing needs review" banner over it would lie
        : reviewBucket
          ? emptyState("Nothing needs review",
              "When a discovery run is synthesized or a graded run reports a defect it can cite, it lands here for you to confirm or dismiss. Exact repeats of anything already reviewed are absorbed automatically.")
          : emptyState("No findings", "Failing runs dedupe into findings here; rejected findings stay suppressed.");

    // The review tab's second queue: open findings the sweep believes are
    // fixed (a newer run passed everywhere the bug was seen) but will not
    // close on its own — the call stays with a person, one click either way.
    // Same table language as every findings list — same columns, "looks
    // fixed" spoken by the Latest run cell — only the verbs differ.
    const looksFixed = reviewBucket && suggested.length
      ? h("div", {},
          h("h2.section-title", {}, `Looks fixed (${suggested.length})`),
          h("div.card", {}, h("table.rows.findings-index", {},
            h("thead", {}, h("tr", {},
              h("th", {}, "State"), h("th", {}, "Finding"), h("th", {}, "Severity"), h("th", {}, "Evidence"), h("th", {}, "Latest run"), h("th", {}, "Last seen"),
              canReview ? h("th", {}, srOnly("Suggestion actions")) : null)),
            h("tbody", {}, ...suggested.map((f: WebDynamic) => h("tr", { style: "cursor:pointer", onclick: (e: WebDynamic) => { if (!e.target.closest("a, button")) navigate(`/p/${projectKey}/findings/${f.id}`); } },
              h("td", {}, findingChip(f)),
              h("td", {}, link(`/p/${projectKey}/findings/${f.id}`, h("span.rowtitle", {}, displayTitle(f.title))),
                h("div.desc", {}, f.summary?.auto_resolve?.suggested?.reason || "A newer run passed this story — this may be fixed.")),
              h("td", {}, severityChip(f.severity)),
              h("td.dim", {}, String(f.evidence_count)),
              h("td", {}, storyHealthCell(f)),
              h("td.dim", {}, ago(f.last_seen)),
              canReview
                ? h("td.row-actions", {},
                    h("button.btn.btn-sm", { onclick: () => resolveInline(f) }, "Resolve"),
                    h("button.btn.btn-sm", { onclick: () => notFixedInline(f) }, "Not fixed"))
                : null)))),
          ))
      : null;

    // With two queues on the tab, both wear parallel section titles naming the
    // system's claim about their rows ("New claims" / "Looks fixed"); a lone
    // table needs no title — the tab already names it.
    const body = h("div.stack", {},
      h("div.runs-filter", {}, filterSeg, consolidateLine),
      looksFixed && items.length
        ? h("div", {}, h("h2.section-title", {}, `New claims (${items.length})`), listCard)
        : listCard,
      looksFixed);

    const reviewTotal = items.length + suggested.length;
    mount(main, page({
      title: "Findings",
      // Say what this bucket holds — "Open" alone left people experimenting to
      // find out which tab a confirmed finding was in.
      sub: reviewBucket
        ? `${reviewTotal} finding${reviewTotal === 1 ? "" : "s"} awaiting review — ${FILTERS.review.blurb}`
        : `${items.length} ${FILTERS[filter].label.toLowerCase()} finding${items.length === 1 ? "" : "s"} — ${FILTERS[filter].blurb}`,
      body,
    }));
  }

  async function confirmInline(f: WebDynamic) {
    try {
      await api.post(`/findings/${f.id}/accept`, { severity: f.severity });
      toast("Confirmed", `"${displayTitle(f.title)}" is now an open finding`, "ok");
      load();
    } catch (err: WebDynamic) { toastError(err); }
  }

  function dismissInline(f: WebDynamic) {
    rejectFindingModal(f, () => load());
  }

  // The looks-fixed queue's two verbs, same wire calls as the detail page:
  // Resolve is the ordinary human resolution; Not fixed withdraws the
  // suggestion and remembers the run so it never re-nags.
  async function resolveInline(f: WebDynamic) {
    try {
      await api.post(`/findings/${f.id}/resolve`, {});
      toast("Finding resolved", `"${displayTitle(f.title)}" is resolved`, "ok");
      load();
    } catch (err: WebDynamic) { toastError(err); }
  }

  async function notFixedInline(f: WebDynamic) {
    try {
      await api.post(`/findings/${f.id}/not-fixed`, {});
      toast("Noted", "this run won't be suggested again; a newer passing run may be", "ok");
      load();
    } catch (err: WebDynamic) { toastError(err); }
  }
}


export async function findingDetailPage(projectKey: WebDynamic, findingId: WebDynamic) {
  stopLive();
  const context = projectPage(projectKey, { nav: "findings", title: "Finding" });
  if (!context) return;
  const { main, project } = context;

  live = debouncedFeedRefresh(projectKey, {
    types: ["finding.created", "finding.evidence_added", "finding.accepted", "finding.rejected", "finding.resolved", "finding.reopened", "finding.fix_suggested"],
    refresh: load,
    accepts: (event: WebDynamic) => event.entity?.finding_id === findingId,
  });

  let copiedAt: WebDynamic = null; // survives repaints: the tracker-copy receipt must persist (round-3 triage major)

  // Who confirmed this is a person, not a primary key — "confirmed by 01KYC20S"
  // named nobody. Members is a viewer-level read; if it fails the provenance
  // line just falls back to the short id. Loaded alongside the finding, not
  // before it — the two are independent.
  let names: WebDynamic = new Map();
  await Promise.all([
    api.cached(`/projects/${projectKey}/members`)
      .then(({ items }: WebDynamic) => { names = new Map(items.map((m: WebDynamic) => [m.user_id, m.name || m.email])); })
      .catch(() => { /* ids it is */ }),
    load(),
  ]);

  async function load() {
    try {
      const finding = await api.get(`/findings/${findingId}`);
      if (!live?.current()) return;
      paint(finding);
    } catch (err: WebDynamic) {
      mount(main, page({ title: "Finding", body: errorState(err, load) }));
    }
  }

  function paint(f: WebDynamic) {
    const canReview = hasRole(project.id, "reviewer") && !f.merged_into;
    const needsReview = f.state === "new";
    // Confirmation and handoff are one step (P4). An unconfirmed open finding
    // (new/reopened) gets one primary "Confirm and copy" that records the human
    // confirmation and puts the tracker summary on the clipboard; a confirmed
    // (accepted) finding just copies. Copy stays available to any role.
    const unconfirmedOpen: WebDynamic = ["new", "reopened"].includes(f.state);
    const actions: WebDynamic = [
      canReview && unconfirmedOpen
        ? h("button.btn.primary", { onclick: () => confirmAndCopy(f) }, "Confirm and copy")
        : h("button.btn", { onclick: () => copyTracker(f) }, "Copy for tracker"),
      ...(canReview ? [
        // On an unreviewed claim the verb is "Dismiss" — the person is judging
        // a machine report, not overturning a confirmed finding.
        f.state !== "rejected"
          ? h("button.btn", { onclick: () => rejectFindingModal(f, load) }, needsReview ? "Dismiss" : "Reject")
          : null,
        // Both closed states reverse with Reopen. "Resolve" on a rejected
        // finding would mark a judged not-a-bug as fixed — a category error.
        needsReview ? null
          : ["resolved", "rejected"].includes(f.state)
            ? h("button.btn", { onclick: () => simpleAction(f, "reopen") }, "Reopen")
            : h("button.btn", { onclick: () => simpleAction(f, "resolve") }, "Resolve"),
      ] : []),
    ].filter(Boolean);

    // What an unreviewed finding IS, said where the judgment happens: filed by
    // the system, from cited evidence, awaiting exactly this person's call.
    const reviewBanner = needsReview
      ? h("div.card.pad.review-banner", {},
          h("div", {}, h("b", {}, "Filed from run evidence, not yet reviewed. "),
            h("span.dim", {}, `The ${f.source === "synthesis" ? "discovery synthesis" : f.source === "run_grade" ? "run grading" : "system"} filed this claim${f.category ? ` (${categoryLabel(f.category)})` : ""}. It isn't a confirmed finding until you confirm it; dismissing suppresses exact repeats.`)),
          f.suggested_finding_id
            ? h("div", { style: "margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap" },
                h("span.dim", {}, "Possibly the same bug as "),
                link(`/p/${projectKey}/findings/${f.suggested_finding_id}`, displayTitle(f.suggested_finding_title) || short(f.suggested_finding_id)),
                canReview
                  ? h("button.btn.btn-sm", { onclick: () => mergeIntoSuggested(f) }, "Same bug — merge the evidence")
                  : null)
            : null)
      : null;

    const gate = f.summary?.gate;
    const claim = f.summary?.claim || {};
    const summary = h("div.card.pad", {},
      h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" },
        findingChip(f), autoBadge(f), severityChip(f.severity),
        f.external_ref ? h("span.chip", {}, f.external_ref) : null,
        // A UI telling a UI user to go call the API is a dead end; the sentence
        // now just states the fact, and Copy for tracker is right above it.
        copiedAt
          ? h("span.copy-receipt", {}, `✓ copied for your tracker ${ago(copiedAt)} — paste it into a ticket`)
          : f.state === "accepted" && !f.external_ref
            ? h("span.dim", { style: "font-size:12px" }, "not in a tracker yet")
            : null),
      confirmedLine(f),
      claim.expected ? h("p", {}, h("strong", {}, "Expected: "), claim.expected) : null,
      claim.observed ? h("p", {}, h("strong", {}, "Observed: "), claim.observed) : null,
      gate?.spec || gate?.detail
        ? h("div.crit-line", {}, h("span.g", { "aria-hidden": "true" }, "✗"),
            h("span.spec", {}, gate.spec || f.summary?.failure_kind || "check failed"),
            gate.detail ? h("span.detail", {}, gate.detail) : null)
        : null,
      f.summary?.locus && !gate?.detail ? h("p.dim", {}, clamp(f.summary.locus, 360)) : null,
      h("div.dim", {}, `${f.evidence_count} occurrence${f.evidence_count === 1 ? "" : "s"} · first seen ${ago(f.first_seen)} · last seen ${ago(f.last_seen)}`
        + (f.recurrence_count ? ` · ${f.recurrence_count} exact recurrence${f.recurrence_count === 1 ? "" : "s"} absorbed` : "")),
      storyHealthLine(f),
    );
    const evidence = f.evidence.length
      ? h("div.card", {}, h("table.rows", {},
          h("thead", {}, h("tr", {}, h("th", {}, "Run"), h("th", {}, "Step"), h("th", {}, "Excerpt"), h("th", {}, "Seen"))),
          h("tbody", {}, ...f.evidence.map((e: WebDynamic) => h("tr", {},
            h("td", {}, link(e.viewer_url, `${e.case_id} →`), h("div.desc", {}, short(e.run_db_id))),
            h("td.dim", {}, e.step_from != null ? String(e.step_from) : "—"),
            h("td", {}, clamp(e.excerpt || "", 160)),
            h("td.dim", {}, ago(e.created_at)),
          ))),
        ))
      : emptyState("No evidence", "This finding has no evidence rows.");
    mount(main, page({
      crumbs: [link(`/p/${projectKey}/findings`, "Findings"), " / ", short(f.id)],
      title: displayTitle(f.title),
      sub: f.reject_reason ? `Rejected: ${f.reject_reason}` : null,
      actions,
      // "All occurrences" is redundant when there is a single occurrence — the
      // latest-evidence hero already shows it (P4).
      body: h("div.stack", {},
        reviewBanner,
        suggestionBanner(f, canReview),
        summary,
        resolutionSection(f),
        evidenceHero(f),
        ...(f.evidence.length > 1
          ? [h("h2.section-title", {}, `All occurrences (${f.evidence.length})`), evidence]
          : [])),
    }));
  }

  // One-click resolution of a loose-key suggestion: merge this claim's evidence
  // into the finding it duplicates. The merge machinery moves every evidence
  // row and leaves a tombstone, so the old link keeps resolving.
  async function mergeIntoSuggested(f: WebDynamic) {
    try {
      const target = await api.post(`/findings/${f.id}/merge`, { into: f.suggested_finding_id });
      toast("Merged", "its evidence now lives on the finding it duplicated", "ok");
      navigate(`/p/${projectKey}/findings/${target?.id || f.suggested_finding_id}`);
    } catch (err: WebDynamic) { toastError(err); }
  }

  // Auto-resolution as a section of its own, peer to "Latest evidence": the
  // resolution IS the newest fact about a resolved finding and was buried as a
  // provenance sentence inside the summary card (and said twice, once more by
  // the story-health line). One section: which run demonstrated the fix, the
  // sweep's own stated reason, and one click to the replay. No Acknowledge
  // button — a resolved finding is finished work and must not present a
  // pending action; Reopen is the disagreement verb, and suggestion outcomes
  // (resolved vs not-fixed) are the agreement signal. The API verb remains for
  // anyone recording explicit agreement; a recorded receipt still shows.
  function resolutionSection(f: WebDynamic) {
    if (f.state !== "resolved" || !f.auto_resolved_at) return null;
    const ar = f.summary?.auto_resolve || {};
    const run = f.resolved_by_run;
    const who = actorLabel(ar.acknowledged_by, names);
    return h("div", {},
      h("h2.section-title", {}, "Resolution"),
      h("div.card.pad", {},
        h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" },
          statusChip("pass", "auto-resolved"),
          h("span.dim", {}, run
            ? `Resolved automatically ${ago(f.auto_resolved_at)}, demonstrated by a run of ${run.case_id}.`
            : `Resolved automatically ${ago(f.auto_resolved_at)}, demonstrated by a later run.`),
          run ? link(`/p/${projectKey}/runs/${run.run_group_id}/${run.id}`, "view that run →") : null,
          ar.acknowledged_at
            ? h("span.dim", {}, `acknowledged ${ago(ar.acknowledged_at)}${who ? ` by ${who}` : ""}`)
            : null),
        ar.reason ? h("p.dim", { style: "margin:6px 0 0" }, ar.reason) : null));
  }

  // The deterministic "looks fixed" suggestion on a judgment-call (or
  // externally tracked) finding: a newer run passed every affected
  // suite/ring/case, but judging the claim stays with a person —
  // one click either way, and "Not fixed" is remembered so the same run
  // never re-suggests.
  function suggestionBanner(f: WebDynamic, canReview: WebDynamic) {
    const suggested = f.summary?.auto_resolve?.suggested;
    if (!suggested || !["new", "accepted", "reopened"].includes(f.state)) return null;
    const run = f.suggested_fix_run;
    return h("div.card.pad", {},
      h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" },
        statusChip("pass", "looks fixed"),
        // The sweep states its own reason when it stamped one; the generic
        // sentence covers suggestions written before reasons existed.
        h("span.dim", {}, suggested.reason
          || (run
            ? `A newer run of ${run.case_id} passed this story ${ago(run.finished_at)} — this may be fixed.`
            : "A newer run passed this story — this may be fixed.")),
        run ? link(`/p/${projectKey}/runs/${run.run_group_id}/${run.id}`, "view that run →") : null,
        ...(canReview ? [
          h("button.btn.btn-sm.primary", { onclick: () => simpleAction(f, "resolve") }, "Resolve"),
          h("button.btn.btn-sm", { onclick: () => notFixed(f) }, "Not fixed"),
        ] : [])));
  }

  async function notFixed(f: WebDynamic) {
    try {
      await api.post(`/findings/${f.id}/not-fixed`, {});
      toast("Noted", "this run won't be suggested again; a newer passing run may be", "ok");
      load();
    } catch (err: WebDynamic) { toastError(err); }
  }

  // Confirmation provenance (P4): who confirmed and when, from the finding's own
  // summary (stamped durably on accept). The audit log carries it too.
  function confirmedLine(f: WebDynamic) {
    const at = f.summary?.confirmed_at;
    if (f.state !== "accepted" || !at) return null;
    const who = actorLabel(f.summary?.confirmed_by, names);
    return h("div.dim", { style: "font-size:12px;margin-top:2px" }, `confirmed ${ago(at)}${who ? ` by ${who}` : ""}`);
  }

  // The newest evidence, standing on its own: the failing step's screenshot
  // next to the gate/grader excerpt, deep-linked to that exact step (round-2
  // fix-next major: "finding detail too thin as standalone evidence").
  function evidenceHero(f: WebDynamic) {
    const e = f.evidence[0];
    if (!e) return null;
    const shotUrl = e.step_from != null
      ? `/api/v1/projects/${encodeURIComponent(projectKey)}/view/run/${e.core_run_id}/${e.case_id}/steps/${String(e.step_from).padStart(3, "0")}.png`
      : null;
    let shot: WebDynamic;
    if (shotUrl) {
      const img = h("img", { src: shotUrl, alt: `Screenshot of step ${e.step_from} — ${e.case_id}`, loading: "lazy" });
      shot = link(e.viewer_url, img);
      shot.className = "shot";
      shot.setAttribute("aria-label", `Open step ${e.step_from} of ${e.case_id} in the run viewer`);
      img.addEventListener("error", () => {
        shot.replaceChildren(h("div.shot-missing", {}, "screenshot unavailable — this run's bundle may have been pruned"));
      });
    } else {
      shot = h("div.shot.shot-missing", {}, "no step screenshot for this evidence");
    }
    const openLabel = e.step_from != null ? `Open at step ${e.step_from} →` : "Open the run →";
    return h("div", {},
      h("h2.section-title", {}, "Latest evidence"),
      h("div.card.ev-hero", {},
        shot,
        h("div.meta", {},
          h("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" },
            h("span.id", {}, e.case_id),
            e.run_status ? statusChip(["pass", "fail", "infra", "explored"].includes(e.run_status) ? e.run_status : "neutral", e.run_status) : null,
            e.step_from != null ? h("span.chip", {}, `stopped at step ${e.step_from}`) : null),
          e.excerpt ? h("p.excerpt", {}, clamp(e.excerpt, 420)) : null,
          h("div.dim", {}, `seen ${ago(e.created_at)}`),
          h("div", {}, link(e.viewer_url, openLabel)),
        )));
  }

  async function copyTracker(f: WebDynamic) {
    const ok = await copyText(trackerSummary(f));
    if (ok) {
      copiedAt = Date.now();
      toast("Copied for your tracker", "a markdown summary with evidence links is on your clipboard", "ok");
      paint(f); // leave a durable receipt on the page, not just a 3.5s toast
    } else toast("Couldn't copy", "your browser blocked clipboard access", "err");
  }

  function trackerSummary(f: WebDynamic) {
    const gate = f.summary?.gate;
    const lines: WebDynamic = [`# ${f.title}`, ""];
    lines.push(`- Severity: ${f.severity} · state: ${f.state}${f.external_ref ? ` · ref: ${f.external_ref}` : ""}`);
    if (f.summary?.story_id) lines.push(`- Story: ${f.summary.story_id}`);
    if (gate?.spec || gate?.detail) lines.push(`- Failing check: ${[gate.spec, gate.detail].filter(Boolean).join(" — ")}`);
    lines.push(`- Occurrences: ${f.evidence_count} (first seen ${f.first_seen}, last seen ${f.last_seen})`);
    const health = storyHealthOf(f);
    if (health.key === "failing") lines.push(`- Story status: still failing in its latest run`);
    if (health.key === "passing") lines.push(`- Story status: latest run passed — possibly fixed`);
    lines.push("", "Evidence:");
    for (const e of f.evidence.slice(0, 5)) {
      const stepNote = e.step_from != null ? ` (step ${e.step_from})` : "";
      lines.push(`- ${e.case_id}${stepNote} — ${location.origin}${e.viewer_url}${e.excerpt ? ` — ${clamp(e.excerpt, 200)}` : ""}`);
    }
    if (f.evidence.length > 5) lines.push(`- …and ${f.evidence.length - 5} more (see ${location.origin}/p/${projectKey}/findings/${f.id})`);
    return lines.join("\n");
  }

  // Reconciliation against the story's latest run (round-2 orient major:
  // "is this fixed, stale, superseded?" had no answer anywhere). On a resolved
  // finding the resolution already answers that question, so only the
  // contradiction — the story failing again — is worth a line.
  function storyHealthLine(f: WebDynamic) {
    const { key, sh } = storyHealthOf(f);
    if (key === "none") return null;
    if (f.state === "resolved" && key !== "failing") return null;
    // A rejected finding was judged not a bug — "this may be fixed" (or any
    // run reconciliation) answers a question nobody is asking about it.
    if (f.state === "rejected") return null;
    const runLink = sh ? link(`/p/${projectKey}/runs/${sh.run_group_id}/${sh.run_db_id}`, "view that run →") : null;
    if (key === "failing") {
      return h("div.health-line", {}, statusChip("fail", "still failing"),
        h("span.dim", {}, ` the latest run of this story failed ${ago(sh.finished_at)} — this finding is current. `), runLink);
    }
    if (key === "passing") {
      return h("div.health-line", {}, statusChip("pass", "passing now"),
        h("span.dim", {}, ` the latest run of this story passed ${ago(sh.finished_at)} — this may be fixed. `), runLink);
    }
    return h("div.health-line", {}, statusChip("neutral", "not re-run"),
      h("span.dim", {}, " the story hasn't run since this was last seen — the finding may be stale."));
  }

  // Confirm and copy: record the human confirmation (accept), then hand off in
  // the same click by copying the tracker summary. Leaves a durable confirmation
  // (state + provenance) and a visible copy receipt.
  async function confirmAndCopy(f: WebDynamic) {
    let confirmed;
    try {
      confirmed = (await api.post(`/findings/${f.id}/accept`, { severity: f.severity })) || f;
    } catch (err: WebDynamic) {
      return toastError(err);
    }
    const ok = await copyText(trackerSummary(confirmed));
    if (ok) {
      copiedAt = Date.now();
      toast("Confirmed and copied", "confirmation recorded; a markdown summary with evidence links is on your clipboard", "ok");
    } else {
      toast("Confirmed", "confirmation recorded, but your browser blocked the clipboard — use Copy for tracker", "ok");
    }
    load(); // reflect the confirmed state; copiedAt survives the repaint as the receipt
  }

  async function simpleAction(f: WebDynamic, action: WebDynamic) {
    try {
      await api.post(`/findings/${f.id}/${action}`, {});
      toast(action === "resolve" ? "Finding resolved" : "Finding reopened", "", "ok");
      load();
    } catch (err: WebDynamic) { toastError(err); }
  }
}

/**
 * Reject/dismiss with a stated reason — shared by the detail page and the
 * needs-review list's inline Dismiss. On an unreviewed (`new`) finding the
 * title says Dismiss; the wire verb is the same reject transition either way,
 * and `duplicate` joined the reason vocabulary with the candidate collapse.
 */
function rejectFindingModal(f: WebDynamic, onDone: WebDynamic) {
  const needsReview = f.state === "new";
  const close = formModal(needsReview ? "Dismiss this report" : "Reject this finding", () => {
    const reason = h("select", {},
      h("option", { value: "not_a_bug" }, "not a bug"),
      h("option", { value: "wont_fix" }, "won't fix"),
      h("option", { value: "duplicate" }, "duplicate"));
    const note = h("textarea", { style: "min-height:80px", placeholder: "optional note" });
    return h("form", { onsubmit: submit },
      fld("Reason", reason),
      fld("Note", note, "Exact repeats are absorbed silently from now on — this never re-enters review."),
      h("div.modal-actions", {},
        h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"),
        h("button.btn.primary", { type: "submit" }, needsReview ? "Dismiss" : "Reject")),
    );
    async function submit(e: WebDynamic) {
      e.preventDefault();
      try {
        await api.post(`/findings/${f.id}/reject`, { reason: reason.value, note: note.value.trim() || undefined });
        close();
        toast(needsReview ? "Dismissed" : "Finding rejected", "future matching evidence is absorbed silently", "ok");
        onDone?.();
      } catch (err: WebDynamic) { toastError(err); }
    }
  });
}

/**
 * A finding's headline. Gate-failure findings arrive titled with the failing
 * check's own spec ("assert: the results show…") — the mechanical prefix is
 * provenance, not headline, and reads as leaked code in a row title. The
 * stored title is untouched (it is dedupe-adjacent and the tracker copy keeps
 * the exact words); only the display strips it.
 */
function displayTitle(t: WebDynamic) {
  const s: WebDynamic = String(t || "").replace(/^\s*(assert|expect|check|gate)\s*:\s*/i, "");
  return s ? s[0].toUpperCase() + s.slice(1) : String(t || "");
}

// story_health (server decoration): the latest finished pass/fail run of the
// finding's story. Derives the plain-words reconciliation state:
//   failing — the story still fails, the finding is current
//   passing — a run newer than the finding's last evidence passed → maybe fixed
//   stale   — the story hasn't run since the finding was last seen
function storyHealthOf(f: WebDynamic) {
  const sh = f.story_health;
  if (!sh?.status) return { key: "none", sh: null };
  if (sh.status === "fail") return { key: "failing", sh };
  const reRun = !f.last_seen || new Date(sh.finished_at) >= new Date(f.last_seen);
  return { key: reRun ? "passing" : "stale", sh };
}

function storyHealthCell(f: WebDynamic) {
  // One visual vocabulary for the whole column: every value is a run-status
  // word in the ✓/✗ chip family. A pending "looks fixed" suggestion outranks
  // the raw health signal — the sweep verified the pass everywhere the bug
  // was seen — so it takes the cell with the stronger word, same green.
  if (f.summary?.auto_resolve?.suggested && ["new", "accepted", "reopened"].includes(f.state)) {
    return statusChip("pass", "looks fixed",
      f.summary.auto_resolve.suggested.reason || "a newer run passed this story everywhere it was seen — confirm the fix on the finding");
  }
  // Judged not a bug: run reconciliation answers nothing about a rejected row.
  if (f.state === "rejected") return h("span.dim", {}, "—");
  const { key } = storyHealthOf(f);
  if (key === "failing") return statusChip("fail", "still failing");
  if (key === "passing") return statusChip("pass", "passing now");
  if (key === "stale") return statusChip("neutral", "not re-run");
  return h("span.dim", {}, "—");
}

// Triage state and severity are NOT run statuses — they get text chips, not
// the ✓/✗ glyph vocabulary (an open finding is work, not a failed run). Four
// words, one mapping (lib/finding-buckets.ts); the API state stays in the
// tooltip for anyone correlating with the audit log.
function findingChip(f: WebDynamic) {
  const gloss = findingStateGloss(f.state);
  return h(`span.chip.${findingStateTone(f.state)}`,
    { title: `${gloss ? `${gloss} · ` : ""}API state: ${f.state}` },
    findingStateLabel(f.state).toLowerCase());
}

function severityChip(s: WebDynamic) {
  return h(`span.chip.sev-${s === "major" ? "major" : s === "minor" ? "minor" : "info"}`, {}, s);
}

// The "auto" badge on a system-resolved finding — calm, and quieted by the
// Acknowledge verb only in the sense that the provenance line stops offering
// the button; the badge itself stays honest about who closed it.
function autoBadge(f: WebDynamic) {
  if (f.state !== "resolved" || !f.auto_resolved_at) return null;
  return h("span.chip.calm", {
    title: "resolved automatically — a later run demonstrated the fix",
    style: "margin-left:6px",
  }, "auto");
}

// The audit actor shape ({user_id}|{token_id}|{system}) → a readable label,
// resolved to the person's name when the project's member list knows them.
function actorLabel(actor: WebDynamic, names = new Map()) {
  if (!actor || typeof actor !== "object") return null;
  if (actor.user_id) return names.get(actor.user_id) || short(actor.user_id);
  if (actor.token_id) return `API token ${short(actor.token_id)}`;
  if (actor.system) return actor.system;
  return null;
}

const fld = formField;
