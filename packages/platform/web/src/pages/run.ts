// Run detail (UX "Run detail"): a thin platform header — status, provenance,
// actions, pending-review banner — over the existing trajectory viewer embedded
// full-bleed in an iframe. The viewer is served unmodified by the adapter at
// /api/v1/projects/:key/view/ and deep-linked with its own ?run= param, so its
// film strip, captions, diff tab and keyboard bindings all just work.
//
// A run that is still executing streams into that iframe
// (docs/contracts/interfaces.md#live-runs), and the two halves of this screen
// keep themselves up to date over SEPARATE channels, deliberately: the iframe
// owns the live long-poll against the run's own `live` route, and this page
// owns the event feed it already subscribes to. So the header's live badge and
// its one-line "what it is doing" ride the progress events the feed already
// delivers, and the seal arrives as the one `run.status` event the case report
// emits — no second poll, and no repaint on a step counter ticking.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { link, navigate, onPageLeave } from "../lib/router.js";
import { renderFrame, page, refreshReviewBadge, currentTheme } from "../lib/shell.js";
import { state, hasRole } from "../lib/state.js";
import { statusChip, GLYPH, toast, toastError, emptyState, errorState, formModal, confirmModal, copyText, formField, overflowMenu } from "../lib/ui.js";
import { modeLabel, chipStatus, fmtCost, fmtMs, ago, short, clamp } from "../lib/labels.js";
import { didNotRunLabel } from "../lib/vocab.js";
import { findingStateLabel, findingStateTone } from "../lib/finding-buckets.js";
import { runName } from "../lib/run-stats.js";
import { isLiveRun, liveFeedIntent, progressSnapshot, liveDoing, liveAction } from "../lib/run-live.js";
import { subscribeFeed } from "../lib/feed.js";
import { poolPlacementCause } from "../lib/runners.js";
import { launchModal } from "./runs.js";

let live: WebDynamic = null;
function stopLive() {
  if (!live) return;
  live.sub?.stop();
  clearTimeout(live.candidateTimer);
  live = null;
}

export async function runDetailPage(projectKey: WebDynamic, groupId: WebDynamic, runId: WebDynamic) {
  stopLive();
  const main = renderFrame({ projectKey, nav: "runs" });
  const project = state.projectByKey.get(projectKey);
  if (!project) {
    return mount(main, h("div.page", {}, page({
      title: "Project not found",
      body: emptyState("No project called that",
        `Nothing here is named "${projectKey}" — either it doesn't exist, or you're not a member of it.`,
        h("div.empty-actions", {}, link("/projects", h("span.btn.primary", {}, "See all projects")))),
    })));
  }
  mount(main, h("div.page", {}, h("div.dim", {}, "Loading…")));

  let run: WebDynamic, group: WebDynamic, environments = [], mine = [];
  try {
    [run, group, { items: environments }, { items: mine }] = await Promise.all([
      api.get(`/runs/${runId}`),
      api.get(`/run-groups/${groupId}`),
      api.cached(`/projects/${projectKey}/environments`),
      // ALL of this run's candidates (any status): pending drives the banner,
      // the newest resolved row is the sign-off receipt — server-derived, so
      // it survives navigation instead of living in page memory.
      api.get(`/projects/${projectKey}/candidates?run_id=${encodeURIComponent(runId)}`),
    ]);
  } catch (err: WebDynamic) {
    // A 404 is a run that doesn't exist. Retrying can never fix that, and
    // "no run 01BBBB…" is an internal string quoting an id the person never
    // typed — say what happened, and give the one step that works.
    if (err.status === 404) {
      return mount(main, h("div.page", {},
        page({
          crumbs: [link(`/p/${projectKey}/runs`, "Runs")],
          title: "Run not found",
          body: emptyState("That run doesn't exist",
            "It may have been removed by the retention policy, or the link may be out of date.",
            h("div.empty-actions", {},
              link(`/p/${projectKey}/runs/${groupId}`, h("span.btn.primary", {}, "See the rest of this run")),
              link(`/p/${projectKey}/runs`, h("span.btn", {}, "All runs")))),
        })));
    }
    return mount(main, h("div.page", {}, errorState(err, () => runDetailPage(projectKey, groupId, runId))));
  }
  const groupRun = (group.runs || []).find((r: WebDynamic) => r.id === runId) || null;
  const environment = environments.find((e: WebDynamic) => e.id === run.environment_id) || null;
  const envName = environment?.name || null;
  const envUrl = environment?.config?.app?.base_url || null;
  const pickCandidates = (items: WebDynamic) => ({
    candidate: items.find((c: WebDynamic) => c.status === "pending") || null,
    resolved: items.find((c: WebDynamic) => c.status === "accepted" || c.status === "rejected") || null,
  });
  // `progress` is the run's own coalesced snapshot — seeded from the row so the
  // header opens knowing what the feed has not yet said, then patched in place
  // by every progress event (never re-fetched, never polled).
  const ctl: WebDynamic = { run, ...pickCandidates(mine), clipping: false, progress: run.progress ?? null };
  // The two nodes the feed writes into after the first paint: the live
  // doing-line, whose words a progress event rewrites in place rather than by
  // rebuilding the header around it, and the viewer frame. Both are declared
  // before the subscription below so an event arriving while this page is still
  // building finds initialised state, not a binding that does not exist yet.
  let liveLineEl: WebDynamic = null;
  let viewerEl: WebDynamic = null;
  let viewerSrc = "";
  let noEvidence = false;
  async function reloadCandidates() {
    const { items } = await api.get(`/projects/${projectKey}/candidates?run_id=${encodeURIComponent(runId)}`);
    Object.assign(ctl, pickCandidates(items));
  }

  const token: WebDynamic = {};
  const current = () => live?.token === token;
  live = {
    token,
    candidateTimer: null,
    sub: subscribeFeed(projectKey, {
      types: ["clip.created", "retention.pruned", "run.status", "run.event", "candidate.created", "candidate.accepted", "candidate.rejected", "candidate.superseded"],
      onEvent: async (e: WebDynamic) => {
        if (!current()) return;
        // This run's own liveness, off the feed and nothing else. A progress
        // snapshot patches the live line where it stands; a status move — the
        // seal included — refetches the run once and repaints the chrome. The
        // iframe hears the same seal on its own live poll and reloads itself
        // into the sealed run, so both halves land within a tick of each other.
        const intent = liveFeedIntent(e, runId);
        if (intent === "progress") {
          ctl.progress = progressSnapshot(e);
          fillLiveLine();
          return retryViewer();
        }
        if (intent === "reload") {
          try { ctl.run = await api.get(`/runs/${runId}`); } catch { return; /* the next event repaints */ }
          if (!current()) return;
          ctl.progress = ctl.run.progress ?? null;
          paintHeader();
          return retryViewer();
        }
        if (e.type === "clip.created" && (e.entity?.run_id === runId || e.payload?.run_id === runId)) {
          // If this page kicked off the export, download automatically; otherwise
          // the clip is now durably ready and the More menu offers Download clip.
          const wasExporting = ctl.clipping;
          ctl.clipping = false;
          try { ctl.run = await api.get(`/runs/${runId}`); } catch { /* keep stale */ }
          if (!current()) return;
          paintHeader();
          if (wasExporting) { toast("Clip ready", "downloading now", "ok"); downloadClip(); }
          else toast("Clip ready", "open More → Download clip", "ok");
        } else if (e.type === "retention.pruned" && (e.entity?.run_id === runId || e.payload?.run_id === runId)) {
          try { ctl.run = await api.get(`/runs/${runId}`); } catch { /* keep stale */ }
          if (current()) paintHeader();
        } else if (e.type === "run.event" && e.entity?.run_id === runId && e.payload?.type === "clip_failed") {
          ctl.clipping = false;
          toast("Clip failed", e.payload?.error || "see run events", "err");
          paintHeader();
        } else if (e.type.startsWith("candidate.")) {
          // The pending banner only cares about THIS run's candidate. Created /
          // accepted / rejected events name a run; superseded names a story
          // batch. While our banner is up, any candidate event may resolve it
          // (an accept elsewhere supersedes same-story siblings silently), so
          // only skip when the event clearly isn't ours AND no banner is shown.
          const mine = e.payload?.candidate?.run_id === runId || e.type === "candidate.superseded";
          if (!mine && ctl.candidate == null) return;
          clearTimeout(live.candidateTimer);
          live.candidateTimer = setTimeout(async () => {
            if (!current()) return;
            try {
              await reloadCandidates();
              if (!current()) return;
              paintHeader();
            } catch { /* banner keeps last known state */ }
          }, 300);
        }
      },
    }),
  };
  onPageLeave(stopLive);

  const headerEl = h("div.run-detail-head.card");
  // ?step=N (finding/evidence deep-links) passes through to the viewer, which
  // opens on that step (docs/contracts/interfaces.md#viewer-url-contract).
  const q = new URLSearchParams(location.search);
  const stepParam = Number(q.get("step"));
  const stepQs = Number.isInteger(stepParam) && stepParam > 0 ? `&step=${stepParam}` : "";
  // ?view=diff (review-queue "open full diff" links) opens the viewer's Diff tab.
  const viewQs = q.get("view") === "diff" ? "&view=diff" : "";
  // embed=1: the viewer hides its own topbar (brand, run title, story pager) —
  // this header is the run's single identity; steps/duration join provenance.
  // The viewer honours ?theme= (interfaces.md, viewer URL contract) but has no
  // other way to learn the host's choice, so a dark console framed a bright
  // white viewer panel. With no explicit theme both sides fall back to
  // prefers-color-scheme and already agree; shell.js re-points this on toggle.
  const themeQs = currentTheme() ? `&theme=${currentTheme()}` : "";
  viewerSrc = `/api/v1/projects/${encodeURIComponent(projectKey)}/view/?run=${encodeURI(`${run.run_id}/${run.case_id}`)}${stepQs}${viewQs}${themeQs}&embed=1`;
  // A run that finished without uploading a bundle has nothing to replay — the
  // embedded viewer would only say "No run found here" in CLI words. Explain
  // instead (the header's error strip carries the why). A run that DID stream is
  // a different case even when it died: its staged evidence outlives it through
  // the retention grace window, and that stream is the only record of what the
  // run saw before it went (docs/contracts/hosted.md, live runs).
  noEvidence = ["infra", "canceled", "lost"].includes(run.status)
    && !(run.artifact || groupRun?.artifact) && !run.live_opened_at;
  viewerEl = noEvidence
    ? h("div.viewer-embed", { style: "display:flex;align-items:center;justify-content:center" },
        emptyState("Nothing to replay",
          run.started_at
            ? "This run ended before its evidence bundle was uploaded."
            : "The runner never started this case, so no steps or screenshots were captured."))
    // Same-origin iframe: hand it keyboard focus on load, or the viewer's
    // bindings (space = play, arrows = step) silently never fire — the page
    // looks interactive but every keypress lands on the parent document.
    : h("iframe.viewer-embed", {
        src: viewerSrc,
        title: `Trajectory viewer — ${run.case_id}`,
        onload: (e: WebDynamic) => { try { e.target.contentWindow.focus(); } catch { /* focus is a nicety */ } },
      });
  mount(main, h("div.run-detail", {}, headerEl, viewerEl));
  paintHeader();

  /**
   * Did the embedded viewer come up empty?
   *
   * There is one window where it can: a run claimed a moment ago has started
   * but has not yet staged its first batch, so the viewer's single load probe
   * finds neither a live run nor a bundle and renders its own "no run here".
   * It never looks again — one probe per load is its contract — so the frame
   * would sit empty for the whole run, under a header that says the run is
   * recording. The frame is same-origin, so this is a DOM read, not a request.
   */
  function viewerFoundNothing() {
    if (noEvidence) return false;
    try { return viewerEl.contentDocument?.querySelector("#fatal")?.hidden === false; } catch { return false; }
  }

  /**
   * Give the empty frame another go — and ONLY an empty one. A viewer that
   * found its run is streaming it (or showing it sealed) and owns that view
   * completely: reloading it under the reader would cost them their selection
   * for nothing. This is not a poll: it rides feed events the page already
   * receives, it does nothing unless the frame is showing an empty state, and
   * it stops the instant the frame has something.
   */
  function retryViewer() {
    if (!viewerFoundNothing()) return;
    viewerEl.src = `${viewerSrc}&t=${Date.now()}`;
  }

  function paintHeader() {
    const r = ctl.run;
    const streaming = isLiveRun(r);
    // The seal repaints the header without a live line; drop the stale handle
    // before the rebuild so a late progress event can't write into a node that
    // no longer belongs to the page.
    if (!streaming) liveLineEl = null;
    const endReason = r.manifest?.result?.end_reason ?? null;
    const limits = r.manifest?.case?.limits ?? null;
    // "changed — tried to heal → passed" packed three terms of art into one
    // chip. Say what happened instead. infra/canceled/lost never wear the mode
    // word either: "recorded" on a run that died before starting reads as work
    // that never happened.
    const headline = endReason === "timeout"
      ? `${modeLabel(r.mode, r)} — timed out`
      : r.healed && r.status === "pass"
      ? "the app changed; the story still worked"
      : ["infra", "canceled", "lost"].includes(r.status)
        ? didNotRunLabel(r.status, { started: !!r.started_at })
        : modeLabel(r.mode, r) + (["pass", "fail"].includes(r.status) ? ` — ${r.status}` : "");
    // Provenance as separate cells rather than one joined string: the dots
    // recede to a hairline colour and each fact becomes its own scan target,
    // which is the whole job of this line.
    const provenance = metaCells([
      envName ? h("span.m.where", {}, envName) : null,
      group.snapshot_id ? h("span.m", {}, "snapshot ", h("span.mono", {}, short(group.snapshot_id))) : null,
      r.started_at ? h("span.m", {}, ago(r.started_at)) : null,
      r.totals?.steps != null ? h("span.m.num", {}, `${r.totals.steps} steps`) : null,
      r.duration_ms != null ? h("span.m.num", {}, fmtMs(r.duration_ms)) : null,
      limits?.max_steps != null ? h("span.m.num", {}, `limit ${limits.max_steps} steps`) : null,
      limits?.timeout_ms != null ? h("span.m.num", {}, `timeout ${fmtMs(limits.timeout_ms)}`) : null,
      // What produced this evidence. A self-hosted fleet makes that a real
      // question — a persistent shared runner without per-case containers is
      // weaker evidence than a fresh one, and the contract's rule is that this
      // is stated, not laundered. Absent for adapters that place work without a
      // registered runner, which is most of them.
      group.placement?.runner?.name
        ? h("span.m", { title: placementTitle(group.placement) }, "ran on ", h("span.mono", {}, group.placement.runner.name))
        : null,
      group.placement?.isolation
        ? h("span.m", { title: ISOLATION_GLOSS[group.placement.isolation] || null }, `${group.placement.isolation} isolation`)
        : null,
      h("span.m", {}, artifactLine(r, groupRun)),
      retentionLine(r) ? h("span.m", {}, retentionLine(r)) : null,
      r.totals?.cost_usd != null ? h("span.m.num", {}, `cost ${fmtCost(Number(r.totals.cost_usd))}`) : null,
    ]);

    const canReview = hasRole(project.id, "reviewer");
    const artifact = r.artifact || groupRun?.artifact || null;
    const hasClip = !!(r.clip || groupRun?.clip);
    const fullAvailable = (r.artifact_tier || artifact?.tier) === "full" && artifact?.tier === "full";
    // Export clip and Bundle are secondary handoffs — they live in the run's
    // More menu, one gesture each. "Export clip" is a single action: it downloads
    // an existing clip, or generates one (burned action captions) and downloads
    // when ready. The state below is server-derived, so a ready clip stays
    // downloadable across reloads.
    const clipItem = hasClip
      ? { label: "Download clip", onclick: downloadClip }
      : ctl.clipping
        ? { label: "Exporting clip…", disabled: true, onclick: () => {} }
        : {
            label: "Export clip",
            disabled: !fullAvailable,
            title: fullAvailable
              ? "Burn action captions into a shareable video and download it"
              : "The full bundle has been pruned; on-demand clips need its screenshots",
            onclick: exportClip,
          };
    // Every row in this menu is a verb — "Bundle" alone read as a heading.
    const bundleItem = artifact
      ? { label: "Download bundle", onclick: downloadBundle }
      : {
          label: "Download bundle",
          disabled: true,
          // A run still executing has not failed to produce a bundle — it has
          // not finished producing one. Same fact, opposite implication.
          title: streaming ? "The evidence bundle is sealed when the run finishes" : "No evidence bundle was uploaded",
          onclick: () => {},
        };
    // Most findings now arrive on their own — assertion failures already file
    // themselves, and grader-found issues land in the triage queue — so filing
    // one by hand is the rare case. It sits in More, worded as the manual act it
    // is, instead of wearing a top-level button that outranks the evidence. A
    // run that never reached the app has nothing to report about the app.
    const fileItem = canReview && !neverRan(r)
      ? {
          label: "File a finding manually…",
          title: "Most findings file themselves; use this for something only a person would spot",
          onclick: () => promoteFindingModal(r),
        }
      : null;
    const more = overflowMenu([clipItem, bundleItem, fileItem], { label: "More ▾", className: ".btn-sm", title: "More run actions" });

    headerEl.className = `run-detail-head card v-${chipStatus(r)}`;
    mount(headerEl,
      h("div.rd-line1", {},
        // Identity: what this run decided, and which story it decided it about.
        h("div.rd-ident", {},
          // A run still executing has no verdict to wear, and the finished-run
          // words are wrong on it ("recorded" while it is still recording). It
          // wears the same ● live badge the embedded viewer wears instead, and
          // the doing-line below says where it has got to. A queued story is not
          // live yet — nothing is streaming until a runner picks it up — so it
          // says the plain truth and takes the badge when it starts.
          streaming
            ? (r.status === "queued" ? statusChip("neutral", "queued") : liveBadge())
            : statusChip(chipStatus(r), headline),
          // The case id is this page's one true heading (the shell page() h1
          // doesn't exist here — the header sits over the full-bleed viewer).
          h("h1.rd-title", {}, r.case_id)),
        // Navigation, kept apart from both identity and metadata: sideways to
        // another story, or up to the run this one belongs to. The parent is
        // named ("launched · 10:31 pm"), not a truncated ULID — short() takes
        // a ULID's leading characters, and those are only its timestamp.
        h("div.rd-nav", {},
          storySwitcher(),
          h("span.rd-up", {}, h("span.dim", {}, "in "), link(`/p/${projectKey}/runs/${groupId}`, runName(group)))),
        h("div.rd-right", {},
          r.score != null
            ? h("span.chip.rd-score", { title: "Grader score — a trend, not a verdict" },
                h("span.k", {}, "score"), h("span.v", {}, String(r.score)))
            : null,
          resolvedFindingsMenu(r),
          findingsMenu(r),
          more),
      ),
      h("div.rd-meta", {}, ...provenance),
      streaming ? liveLine() : null,
      failStrip(r),
      // Sign-off must leave residue: the banner vanishing was the only "proof"
      // of acceptance in round 3, and the reviewer double-checked elsewhere.
      // The receipt is the candidate ROW (who resolved it, when) — it renders
      // for anyone visiting later, not just the reviewer who clicked.
      !ctl.candidate && ctl.resolved
        ? h("div.rd-resolved.dim", {},
            statusChip(ctl.resolved.status === "accepted" ? "pass" : "fail",
              [ctl.resolved.status,
               ctl.resolved.resolved_by_name ? `by ${ctl.resolved.resolved_by_name}` : null,
               ctl.resolved.resolved_at ? ago(ctl.resolved.resolved_at) : null].filter(Boolean).join(" · ")),
            h("span", {}, ctl.resolved.status === "accepted"
              ? " the new path is now this story's saved path "
              : " the old saved path stands "))
        : null,
      ctl.candidate
        ? h("div.rd-banner", {},
            statusChip("changed", "pending review"),
            h("span.dim", {}, " this story reached its goal a different way, and is waiting for a decision "),
            // The decision lives here, beside the evidence — a changed journey is
            // a run awaiting a decision, not a durable object with its own queue.
            canReview ? h("button.btn.btn-sm", { onclick: () => resolveCandidate("reject") }, "Reject") : null,
            canReview ? h("button.btn.btn-sm.primary", { onclick: () => resolveCandidate("accept") }, "Accept ✓") : null)
        : null,
    );
  }

  /**
   * The badge a streaming run wears, in the embedded viewer's own words and
   * colours (run-viewer style.css `.chip.live`): one vocabulary across the
   * seam, so the header and the replay under it never look like two products.
   */
  function liveBadge() {
    return h("span.chip.live", {
      title: "This run is still executing — steps appear in the replay below as they are recorded.",
    }, h("span.live-dot", { "aria-hidden": "true" }), "live");
  }

  /**
   * What the run is doing right now, under the provenance line: the phase and
   * step from the progress snapshot, then the actor's latest action. Patched in
   * place by the feed — a step counter moving must never cost the reader their
   * focus, their scroll, or an open menu.
   */
  function liveLine() {
    liveLineEl = h("div.rd-live", { "aria-live": "polite" },
      h("span.rd-live-doing"),
      h("span.rd-live-action.dim"));
    fillLiveLine();
    return liveLineEl;
  }

  function fillLiveLine() {
    if (!current() || !liveLineEl) return;
    const doing = liveDoing(ctl.run, ctl.progress);
    const action = liveAction(ctl.run, ctl.progress);
    const doingEl = liveLineEl.querySelector(".rd-live-doing");
    const actionEl = liveLineEl.querySelector(".rd-live-action");
    if (doingEl.textContent !== (doing || "")) doingEl.textContent = doing || "";
    const text = action ? `↳ ${action}` : "";
    if (actionEl.textContent !== text) actionEl.textContent = text;
    actionEl.title = action || "";
  }

  /**
   * The findings this run is already evidence in — one affordance, any number.
   *
   * This used to be one chip per finding carrying a truncated title, which was
   * fine at one and ate the whole header line at two. Findings now arrive
   * automatically (every assertion failure files one), so N is only going up.
   * A count is the thing worth saying at a glance; which findings, how bad, and
   * where they stand is a menu away, one click from each finding's own page.
   */
  function findingsMenu(r: WebDynamic) {
    const findings = r.findings || [];
    if (!findings.length) return null;
    const menu = overflowMenu(
      findings.map((f: WebDynamic) => ({
        label: h("span.fx", {},
          h("span.fx-title", {}, clamp(f.title, 78)),
          h("span.fx-meta", {}, severityChip(f.severity), stateChip(f.state))),
        onclick: () => navigate(`/p/${projectKey}/findings/${f.id}`),
      })),
      {
        label: `${findings.length} ${findings.length === 1 ? "finding" : "findings"} ▾`,
        className: ".btn-sm.rd-findings",
        title: "This run is already evidence in Findings — open one",
      },
    );
    menu.classList.add("rd-findings-wrap");
    menu.querySelector("button")?.setAttribute("aria-label",
      `Evidence in ${findings.length} ${findings.length === 1 ? "finding" : "findings"} — open one`);
    return menu;
  }

  /**
   * The findings this run's report closed — the calm receipt that the system
   * saw the fix. Without it a green run under a red pill looks broken: the
   * user fixed the bug, reran, and nothing visibly connected the two. Same
   * count-plus-menu shape as findingsMenu; each row opens the finding, where
   * the provenance line and Reopen live.
   */
  function resolvedFindingsMenu(r: WebDynamic) {
    const resolved = r.resolved_findings || [];
    if (!resolved.length) return null;
    const menu = overflowMenu(
      resolved.map((f: WebDynamic) => ({
        label: h("span.fx", {},
          h("span.fx-title", {}, clamp(f.title, 78)),
          h("span.fx-meta", {}, severityChip(f.severity))),
        onclick: () => navigate(`/p/${projectKey}/findings/${f.id}`),
      })),
      {
        label: `resolved ${resolved.length} ${resolved.length === 1 ? "finding" : "findings"} ▾`,
        className: ".btn-sm.rd-resolved-findings",
        title: "This run demonstrated the fix — these findings were resolved automatically",
      },
    );
    menu.classList.add("rd-findings-wrap");
    menu.querySelector("button")?.setAttribute("aria-label",
      `Resolved ${resolved.length} ${resolved.length === 1 ? "finding" : "findings"} automatically — open one`);
    return menu;
  }

  /**
   * Move between the stories of this run without leaving the replay.
   *
   * This page was a dead end: the only way from one story's evidence to the
   * next was back up to the run and down again, so triaging three failures in a
   * twelve-story run meant six navigations through a table. The siblings are
   * already on the group we fetched, in the same order the run's own page lists
   * them, so this costs no request.
   */
  function storySwitcher() {
    const siblings = group.runs || [];
    const at = siblings.findIndex((s: WebDynamic) => s.id === runId);
    if (siblings.length < 2 || at < 0) return null;
    const go = (i: WebDynamic) => navigate(`/p/${projectKey}/runs/${groupId}/${siblings[i].id}`);
    // Both arrows keep their place when there is nowhere to go: a control that
    // disappears at the ends moves everything beside it as you page along.
    const step = (delta: WebDynamic, what: WebDynamic) => {
      const target = siblings[at + delta];
      const label = target ? `${what}: ${target.case_id}` : `No ${what.toLowerCase()}`;
      return h("button.btn.btn-sm.story-step", {
        disabled: target ? undefined : true,
        "aria-label": label,
        title: target ? label : undefined,
        onclick: () => { if (target) go(at + delta); },
      }, h("span", { "aria-hidden": "true" }, delta < 0 ? "◀" : "▶"));
    };
    const menu = overflowMenu(
      siblings.map((s: WebDynamic, i: WebDynamic) => ({
        label: `${GLYPH[chipStatus(s)] || "○"} ${s.case_id}${i === at ? " — showing" : ""}`,
        disabled: i === at || undefined,
        onclick: () => go(i),
      })),
      {
        label: `story ${at + 1} of ${siblings.length} ▾`,
        className: ".btn-sm",
        title: "Another story in this run",
      },
    );
    menu.querySelector("button")?.setAttribute("aria-label",
      `Story ${at + 1} of ${siblings.length} in this run — pick another`);
    return h("span.story-switch", {}, step(-1, "Previous story"), menu, step(1, "Next story"));
  }

  // The decisive verdict, said out loud above the replay: which check failed
  // and what it saw. Both explain-red-run personas found this text "visually
  // secondary" buried in the viewer's gate panel; the strip also carries the
  // share affordance the handoff stories implied ("Copy failure summary").
  function failStrip(r: WebDynamic) {
    // A run that never produced a verdict gets the amber treatment below, not
    // this one — an ECONNREFUSED wearing the same red banner as a real gate
    // failure sent triagers hunting a bug in an app that was never reached.
    if (neverRan(r)) return didNotRunStrip(r);
    const failed = (r.gate?.checks || []).filter((c: WebDynamic) => c && c.pass === false);
    const endReason = r.manifest?.result?.end_reason ?? null;
    const limits = r.manifest?.case?.limits ?? null;
    if (!failed.length && !(r.status === "fail" && r.error) && endReason !== "timeout") return null;
    const rows: WebDynamic = [
      endReason === "timeout"
        ? h("div.rd-fail-row", {},
            h("span.g", { "aria-hidden": "true" }, "⏱"),
            h("span.spec", {}, "Run timed out"),
            h("span.detail", {},
              `The actor reached its ${limits?.timeout_ms != null ? fmtMs(limits.timeout_ms) : "wall-clock"} limit` +
              `${r.totals?.steps != null ? ` after ${r.totals.steps} steps` : ""}. It stopped before starting another step.`))
        : null,
      ...failed.map((c: WebDynamic) => h("div.rd-fail-row", {},
          h("span.g", { "aria-hidden": "true" }, "✗"),
          h("span.spec", {}, c.spec || c.kind || "check failed"),
          c.detail ? h("span.detail", {}, c.detail) : null)),
      !failed.length && r.error
        ? h("div.rd-fail-row", {}, h("span.g", { "aria-hidden": "true" }, "✗"), h("span.detail", {}, String(r.error)))
        : null,
    ].filter(Boolean);
    return h("div.rd-fail", {},
      h("div.rd-fail-rows", {}, ...rows),
      h("button.btn.btn-sm", { onclick: () => copyFailureSummary(r) }, "Copy failure summary"));
  }

  /**
   * The "it never ran" strip: amber, a plain-English cause instead of a raw
   * errno, the runner's own words behind a disclosure, and the one thing a
   * person actually wants after a connection refusal — run it again.
   */
  function didNotRunStrip(r: WebDynamic) {
    return h("div.rd-didnt-run", {},
      h("div.why", {},
        // The chip above already says "didn't run" — this line says WHY.
        infraCause(r, envUrl, projectKey),
        r.error
          ? h("details.advanced", { style: "margin-top:6px" },
              h("summary", {}, "what the runner reported"),
              h("div.mono", { style: "margin-top:6px;font-size:12px;word-break:break-word" }, String(r.error)))
          : null),
      hasRole(project.id, "editor") && r.status !== "canceled"
        ? h("button.btn.btn-sm.primary", {
            onclick: () => launchModal(projectKey, null, group.suite_id, { ids: [r.case_id] }),
          }, "Run it again")
        : null);
  }

  async function copyFailureSummary(r: WebDynamic) {
    const failed = (r.gate?.checks || []).filter((c: WebDynamic) => c && c.pass === false);
    const lines: WebDynamic = [
      `✗ ${r.case_id} — ${r.status}${r.score != null ? ` (score ${r.score})` : ""}`,
      r.manifest?.result?.end_reason === "timeout"
        ? `Run timed out after ${r.manifest?.case?.limits?.timeout_ms != null ? fmtMs(r.manifest.case.limits.timeout_ms) : "its wall-clock limit"}`
        : null,
      ...failed.map((c: WebDynamic) => `Failed check: ${[c.spec || c.kind, c.detail].filter(Boolean).join(" — ")}`),
      ...(!failed.length && r.error ? [`Error: ${r.error}`] : []),
      [envName, r.totals?.steps != null ? `${r.totals.steps} steps` : null, r.duration_ms != null ? fmtMs(r.duration_ms) : null, r.started_at ? ago(r.started_at) : null].filter(Boolean).join(" · "),
      `Run: ${location.origin}/p/${projectKey}/runs/${groupId}/${runId}`,
    ].filter(Boolean);
    const ok = await copyText(lines.join("\n"));
    if (ok) toast("Failure summary copied", "paste it into chat or a ticket — the link opens this run", "ok");
    else toast("Couldn't copy", "your browser blocked clipboard access", "err");
  }

  async function resolveCandidate(action: WebDynamic) {
    const c = ctl.candidate;
    if (!c) return;
    if (action === "accept") {
      const ok = await confirmModal({
        title: "Accept this story's new path?",
        body: `The path this run took becomes the saved path for "${c.case_id ?? run.case_id}" — future runs check against it instead.`,
        confirmLabel: "Accept",
      });
      if (!ok) return;
    }
    try {
      await api.post(`/candidates/${c.id}/${action}`, {});
      toast(action === "accept" ? "New path accepted" : "New path rejected", c.case_id ?? run.case_id, "ok");
      // Re-read the candidate rows: the receipt is the resolved row itself
      // (who/when from the server), never an in-memory note that a navigation
      // would erase.
      ctl.candidate = null;
      await reloadCandidates().catch(() => { /* the feed event will repaint */ });
      refreshReviewBadge();
      paintHeader();
    } catch (err: WebDynamic) {
      if (err.status === 409) {
        toast("Already resolved", "another reviewer got there first — the banner will update", "ok");
      } else toastError(err);
    }
  }

  function promoteFindingModal(r: WebDynamic) {
    const close = formModal("File a finding", () => {
      const title = h("input", { value: r.error ? String(r.error).slice(0, 120) : `${r.case_id} needs triage` });
      const severity = h("select", {}, ...["info", "minor", "major"].map((s) => h("option", { value: s, selected: s === (r.status === "fail" ? "major" : "minor") }, s)));
      const note = h("textarea", { style: "min-height:90px", placeholder: "what should the next reader know?" });
      return h("form", { onsubmit: submit },
        // A person filing a bug IS its confirmation — this lands as an open,
        // confirmed finding with this run as evidence. It does not accept or
        // reject the journey itself.
        h("p.dim", { style: "font-size:12.5px;margin-bottom:12px" },
          "Files this run as a confirmed finding, with this run as its evidence. It does not accept or reject the journey."),
        formField("Title", title),
        formField("Severity", severity),
        formField("Note", note),
        h("div.modal-actions", {},
          h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"),
          h("button.btn.primary", { type: "submit" }, "File finding")),
      );
      async function submit(e: WebDynamic) {
        e.preventDefault();
        try {
          const finding = await api.post(`/runs/${runId}/promote-finding`, {
            title: title.value.trim(),
            severity: severity.value,
            note: note.value.trim() || undefined,
          });
          close();
          // Land on the finding itself — a durable receipt (state, evidence
          // row, accept/reject) instead of a 3.5s toast the user can miss.
          toast(finding.evidence_count > 1 ? "Evidence added to existing finding" : "Finding created", finding.title, "ok");
          navigate(`/p/${projectKey}/findings/${finding.id}`);
        } catch (err: WebDynamic) { toastError(err); }
      }
    });
  }

  // One "Export clip" action: download an existing clip, or generate one and
  // download when it's ready. Repeated clicks are safe — the server dedupes
  // concurrent generation, so exactly one clip is produced.
  async function exportClip() {
    if (ctl.run.clip || groupRun?.clip) return downloadClip();
    try {
      const res = await api.post(`/runs/${runId}/clip`, { captions: "action", burn: true });
      if (res.ready) {
        ctl.run = await api.get(`/runs/${runId}`);
        paintHeader();
        downloadClip();
      } else {
        ctl.clipping = true;
        toast("Exporting clip", "the video lands here to download when it's ready", "ok");
        paintHeader();
      }
    } catch (err: WebDynamic) { toastError(err); }
  }

  // Downloads change no visible page state, which read as dead buttons in the
  // studies ("clicked Bundle… saw no visible result") — give a receipt.
  function triggerDownload(href: WebDynamic) {
    const a = document.createElement("a");
    a.href = href;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
  }
  function downloadClip() {
    triggerDownload(`/api/v1/runs/${runId}/clip`);
    toast("Clip downloading", "check your browser downloads", "ok");
  }
  function downloadBundle() {
    triggerDownload(`/api/v1/runs/${runId}/download`);
    toast("Bundle downloading", `${artifactLine(ctl.run, groupRun)} — check your browser downloads`, "ok");
  }
}

/** A run that ended without a verdict — never a product failure. */
const neverRan = (r: WebDynamic) => ["infra", "canceled", "lost"].includes(r.status);

/** What each isolation mode means for how much this evidence is worth. */
const ISOLATION_GLOSS: WebDynamic = {
  process: "a process on the runner's own machine — fine for a developer laptop or a fresh CI job, weaker on a persistent shared runner",
  container: "a fresh container per case",
};

/** Which labels this attempt was placed on, and whose decision that was. */
function placementTitle(placement: WebDynamic) {
  const labels = (placement.labels || []).join(", ");
  if (!labels) return "claimed from the board by this runner — the environment asked for no particular labels";
  return `claimed from the board by this runner, placed on ${labels} (${placement.labels_source === "launch" ? "pinned by the launch" : "the environment's labels"})`;
}

/**
 * Interleave provenance cells with dot separators. The dots are drawn in the
 * hairline colour, so they read as rules between facts rather than as more
 * text to read — the old joined string was one long grey sentence.
 */
function metaCells(cells: WebDynamic) {
  const out: WebDynamic = [];
  for (const cell of cells.filter(Boolean)) {
    if (out.length) out.push(h("span.msep", {}, "·"));
    out.push(cell);
  }
  return out;
}

// Triage severity and state are NOT run statuses (findings.js makes the same
// point): they get word chips, never the ✓/✗ glyph vocabulary.
const severityChip = (s: WebDynamic) =>
  h(`span.chip.sev-${s === "major" ? "major" : s === "minor" ? "minor" : "info"}`, {}, s || "info");
const stateChip = (s: WebDynamic) =>
  h(`span.chip.${findingStateTone(s)}`, { title: `API state: ${s}` }, findingStateLabel(s).toLowerCase());

/**
 * The likely cause of an infra failure, in words a person can act on. The raw
 * errno stays available behind the disclosure; this line says what to check.
 */
function infraCause(r: WebDynamic, envUrl: WebDynamic, projectKey: WebDynamic = null) {
  const err = String(r.error || "");
  const target = envUrl ? h("span.mono", {}, envUrl) : "the app under test";
  if (r.status === "canceled") return h("span", {}, "Someone stopped this run before it finished.");
  // Placement, not the app: nothing ever picked this story up, so nothing here
  // says anything about the software. The remedy is the runner, and it is one
  // click away rather than a sentence about a settings page.
  const pool = poolPlacementCause(err);
  if (pool) {
    const setup = projectKey
      ? link(`/p/${projectKey}/settings/runners`, "Settings → Runners")
      : "Settings → Runners";
    if (pool.kind === "no-runners") {
      return h("span", {},
        "Runs in this deployment execute on self-hosted runners, and this project has none registered — so nothing could take this one. Register one under ",
        setup, " and start it on the machine that can reach the target.");
    }
    if (pool.kind === "unmatched") {
      return h("span", {},
        `Nothing was advertising ${pool.labels.length === 1 ? "the label" : "the labels"} `,
        h("span.mono", {}, pool.labels.join(", ")),
        " that this environment asks for, so this run waited on the board and then gave up. Either give a running runner ",
        pool.labels.length === 1 ? "that label" : "those labels", " under ", setup,
        ", or change the environment's runner labels under Settings → Test targets.");
    }
    if (pool.kind === "idle") {
      return h("span", {},
        "A runner with the right labels is registered, but it was not checking in — the process is probably not running. Start it again with its command from ",
        setup, "; the run can be retried straight after.");
    }
    return h("span", {},
      "The runner took this run and then stopped checking in, so Playtest gave up on it. Check that machine is awake and its runner process is alive (",
      setup, "), then retry.");
  }
  if (r.status === "lost") return h("span", {}, "The runner stopped reporting, so Playtest can't say what happened. Running it again is safe.");
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(err)) {
    return h("span", {}, "Playtest couldn't reach ", target, " — nothing was listening. Check the environment's base URL under Settings, and that the app is up.");
  }
  if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED|EAI_AGAIN/i.test(err)) {
    return h("span", {}, "That host doesn't resolve: ", target, ". Check the environment's base URL for a typo.");
  }
  if (/ETIMEDOUT|ERR_TIMED_OUT|timeout/i.test(err)) {
    return h("span", {}, "The app took too long to answer at ", target, " — it may be starting up, or too slow to reach from the runner.");
  }
  if (/certificate|SSL|ERR_CERT/i.test(err)) {
    return h("span", {}, "The TLS certificate at ", target, " wasn't accepted.");
  }
  if (/401|403|unauthor|forbidden/i.test(err)) {
    return h("span", {}, "The run was refused before it could start — check the environment's auth identity and secrets.");
  }
  if (!r.started_at) return h("span", {}, "The runner never picked this story up, so nothing was captured.");
  return h("span", {}, "The run stopped before it could reach a verdict. Nothing here says anything about your app.");
}

const fmtSize = (n: WebDynamic) => n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`;

function artifactLine(r: WebDynamic, groupRun: WebDynamic) {
  const artifact = r.artifact || groupRun?.artifact || null;
  if (artifact) return `${artifact.tier || r.artifact_tier || "full"} bundle ${fmtSize(artifact.size)}`;
  // "may have been pruned" is only honest when retention actually ran — a run
  // that never uploaded a bundle simply has no evidence.
  if (r.retention_pruned_at) return `${r.artifact_tier || "meta"} tier — evidence may have been pruned`;
  // While the run is still executing there is no bundle YET: what the page is
  // showing came off the live stream, and the sealed bundle is the last thing
  // the run does. Saying "no evidence bundle was uploaded" under a replay that
  // is visibly filling up would read as a fault.
  if (isLiveRun(r)) return "bundle sealed when the run finishes";
  // A run that died mid-case never sealed a bundle, but it did stream: what it
  // saw is below, and it is the only record there will be. Saying only "no
  // bundle" over a replay full of steps reads as a contradiction.
  if (r.live_opened_at) return "no bundle — showing the steps it streamed";
  return r.started_at ? "no evidence bundle was uploaded" : "no evidence — the run never started";
}

function retentionLine(r: WebDynamic) {
  const p = r.retention_provenance || {};
  if (!p.to || !r.retention_pruned_at) return null;
  const date = new Date(r.retention_pruned_at).toLocaleDateString();
  if (p.to === "core") return `heavy media pruned by ${p.policy_days}-day policy on ${date}`;
  if (p.to === "meta") return `bundle pruned by ${p.policy_days}-day policy on ${date}`;
  return null;
}
