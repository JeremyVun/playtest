// Runs: ONE live surface, fed by the event feed (§4a run.status / run.event) —
// never a poll.
//
// The index is this console's triage surface, so it answers on the row what it
// used to make people click twice for: what each run did, how long it took, what
// it cost, and how far a run in flight has got. Runs section by suite, and a run
// expands IN PLACE to its stories, each of which links straight to its replay —
// the trajectory viewer is the product's core experience and used to sit three
// clicks and two summary screens from the rail, unnamed on every step of the
// path. Counts and words come from lib/run-stats.js and the run vocabulary from
// lib/labels.js (the core report.ts mirror) — never local words.
//
// DENSITY IS THE CONSTRAINT. Several suites with something in flight is the
// ordinary state of a busy console, and the live block that reads beautifully
// for ONE run is half a screen tall — six of them are a page nobody can scan.
// So the index is one table (one sticky header, one card, suites as head rows
// inside it), every run is ONE row whatever it is doing, and a run in flight
// says so ON that row: a two-segment meter in OUTCOME, a clock that ticks,
// cost that climbs, Cancel without expanding, and a single "now" line naming
// the story, its step and the actor's latest action. Nothing expands itself
// into a block any more.
//
// The full live block is still here, one click away on any run: per-story
// vitals, a thin step-budget meter, and the actor's recent actions accumulated
// CLIENT-SIDE from the progress events the feed already delivers — the newest
// in ink, the older ones fading. It is what the "In flight" filter and a run's
// own URL open. That is the watching surface; the default list is the scanning
// one. The separate run dashboard page is gone — "Follow" used to lead to a
// screen whose only life was an elapsed counter, so its narration, Cancel and
// Synthesize now live on the run's row and its expanded block, and a run's old
// URL opens the index with that run expanded.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { link, navigate, onPageLeave } from "../lib/router.js";
import { renderFrame, page } from "../lib/shell.js";
import { state, hasRole } from "../lib/state.js";
import { statusChip, srOnly, GLYPH, toast, toastError, emptyState, errorState, formModal, formField, confirmModal } from "../lib/ui.js";
import { modeDoing, modeLabel, chipStatus, fmtMs, fmtCost, ago, stamp, short, clamp } from "../lib/labels.js";
import { outcomeGloss, didNotRunLabel } from "../lib/vocab.js";
import {
  runStats, outcomeParts, outcomeChip, outcomeWords, progressWords, needsAttention, pipTone,
  runTitle, triggerWord, suiteOrder, soloStory, isFinishedStatus, neverRanStatus, inFlightStatus,
} from "../lib/run-stats.js";
import { subscribeFeed } from "../lib/feed.js";
import { launchLimitPlaceholders } from "../lib/launch-limits.js";
import { canRetryRun, retryableStoryCount } from "../lib/run-retry.js";
import { placementReadiness } from "../lib/runners.js";
import { defaultRingId, isProdRing, launchTargetWords, ringOptionLabel } from "../lib/rings.js";

export async function runsPage(projectKey: WebDynamic, groupId: WebDynamic = null, query: WebDynamic = null) {
  const main = renderFrame({ projectKey, nav: "runs" });
  const project = state.projectByKey.get(projectKey);
  if (!project) return mount(main, page({ title: "Runs", body: emptyState("Not found", "No such project.") }));
  // The run dashboard page is gone: a run's own URL (old links, the launch
  // toast, CLI output) opens the index with that run expanded and in view.
  if (groupId) { expanded.add(groupId); touched.add(groupId); }
  return await runsIndex(main, projectKey, project, query, groupId);
}

// ---------- index: every run, sectioned by suite, expandable to its stories ----------

// One page of runs, and how much deeper "Show older runs" reaches. Story rows
// ride along on the same request (`include=runs`), so expanding a run costs
// nothing — the whole screen is one projection.
const PAGE_SIZE = 25;
const OLDER_SIZE = 100;
// Stories shown inside an expanded run before it says "+N more". Every story
// needing attention is shown regardless of where it falls in the list: a cap
// that can hide the one failure in a 30-story run is worse than no cap.
const VISIBLE_STORIES = 8;
// Actor actions kept per live story. Three is a trail, not a log: enough to
// feel the run moving, few enough that the newest is still the one you read.
const TRAIL_LEN = 3;
// Stories named on an expanded run's one-line queue summary. A queued story has
// no vitals, no evidence and nowhere to go, so N of them used to cost N rows to
// say one thing; they say it on one line now, and the rest are a "+N more".
const QUEUED_NAMED = 5;

/** A run that has not finished: it is spending money and can still be stopped. */
const isActiveGroup = (g: WebDynamic) => ["queued", "running"].includes(g?.status);

// Which runs are expanded, kept across repaints (the feed refetches this page
// whenever a run moves) and across leaving and coming back. `touched` records
// what a PERSON opened or closed, so the automatic expansion below never
// re-opens a run they deliberately shut.
const expanded: WebDynamic = new Set();
const touched: WebDynamic = new Set();
// Suite sections a person collapsed, kept the same way: across repaints and
// across leaving and coming back. A collapsed suite keeps its head — name,
// count, trend, launch — so the shelf still says how the suite is doing.
const collapsedSuites: WebDynamic = new Set();

async function runsIndex(main: WebDynamic, projectKey: WebDynamic, project: WebDynamic, query: WebDynamic, focusGroupId: WebDynamic = null) {
  stopLive();
  const attentionOnly = query?.get("attention") === "1";
  // The watching tab. Client-side over the loaded page, deliberately: a run
  // that is still queued or running was launched more recently than anything
  // that has finished since, so it is always on the newest page — and the
  // server's `status` filter takes one status, while "in flight" is two.
  const liveOnly = query?.get("live") === "1";
  const canLaunch = hasRole(project.id, "editor");
  // feedNotes: group-level narration words off the feed ("provisioning"), keyed
  // by group — the cold-start story the stats can't tell yet. tickEls: the
  // elapsed-time spans of in-flight rows, re-registered on every paint and
  // ticked in place each second (no repaint — a repaint costs focus and scroll).
  // trails: the last few actor actions per in-flight run, accumulated from the
  // progress events on the feed (the server keeps only the latest snapshot; the
  // stream is the page's to remember). Newest first, capped at TRAIL_LEN.
  const ctl: WebDynamic = {
    groups: [], suites: [], rings: [], limit: PAGE_SIZE, sig: null, q: "", liveN: null,
    feedNotes: new Map(), tickEls: new Map(), showAll: new Set(), trails: new Map(),
    refsMissing: "",
  };
  mount(main, page({ title: "Runs", body: h("div.dim", {}, "Loading…") }));

  // Identity token: a superseded page instance's async callbacks must do
  // nothing — in particular never tear down the instance that replaced them.
  const token: WebDynamic = {};
  const current = () => live?.token === token;

  // Suite and ring names move at human editing pace; the groups move at run
  // pace. Loading them separately keeps a feed-driven refetch to ONE request
  // where it used to re-download all three collections on every event.
  async function loadRefs(force = false) {
    const [suites, applications] = await Promise.all([
      api.cached(`/projects/${projectKey}/suites`, { ttl: 15_000, force }),
      api.cached(`/projects/${projectKey}/applications?include=rings`, { force }).catch(() => ({ items: [] })),
    ]);
    ctl.suites = suites.items || [];
    // Flattened once, with each ring carrying the application it belongs to: a
    // run names the pair (`todo-web/staging`), never a bare ring key that two
    // applications could both claim.
    ctl.rings = (applications.items || []).flatMap((a: WebDynamic) =>
      (a.rings || []).map((r: WebDynamic) => ({ ...r, application: a })));
  }

  async function loadGroups() {
    const qs = new URLSearchParams({ limit: String(ctl.limit), include: "runs" });
    if (attentionOnly) qs.set("outcome", "attention");
    const [runs, liveProbe] = await Promise.all([
      api.get(`/projects/${projectKey}/run-groups?${qs}`),
      // The attention tab's page holds only attention runs, so the "In flight"
      // count needs its own look at the newest page — where anything still
      // moving always is, having been launched after everything that finished.
      attentionOnly
        ? api.get(`/projects/${projectKey}/run-groups?limit=${PAGE_SIZE}`).catch(() => null)
        : null,
    ]);
    ctl.groups = runs.items || [];
    ctl.liveN = liveProbe ? (liveProbe.items || []).filter(isActiveGroup).length : null;
    // A finished story's trail is over — the replay link is its record now.
    for (const g of ctl.groups) {
      for (const r of g.runs || []) if (isFinishedStatus(r.status)) ctl.trails.delete(r.id);
    }
    // A group naming a suite or target this page has never heard of means the
    // reference data moved under us (a suite created since load). Refresh refs
    // once per distinct gap — a deleted target stays unknown and must not spin.
    const suiteIds: WebDynamic = new Set(ctl.suites.map((s: WebDynamic) => s.id));
    const ringIds: WebDynamic = new Set(ctl.rings.map((r: WebDynamic) => r.id));
    const missing = ctl.suites.length ? [
      ...new Set(ctl.groups.flatMap((g: WebDynamic) => [
        ...(suiteIds.has(g.suite_id) ? [] : [`s:${g.suite_id}`]),
        ...(g.ring_id == null || ringIds.has(g.ring_id) ? [] : [`r:${g.ring_id}`]),
      ])),
    ].join() : "";
    if (missing && missing !== ctl.refsMissing) {
      ctl.refsMissing = missing;
      await loadRefs(true);
    }
  }

  async function load() {
    await Promise.all([loadRefs(), loadGroups()]);
  }

  try {
    await load();
    // A deep link to a run older than the first page widens the net once
    // before giving up — the link probably came from a chat message or a
    // bookmark, and "it's not here" must mean gone, not merely unpaged.
    if (focusGroupId && ctl.limit === PAGE_SIZE && !ctl.groups.some((g: WebDynamic) => g.id === focusGroupId)) {
      ctl.limit = OLDER_SIZE;
      await load();
    }
  } catch (err: WebDynamic) {
    return mount(main, page({
      title: "Runs",
      body: errorState(err, () => runsIndex(main, projectKey, project, query)),
    }));
  }

  // Live: a run.status transition moves a number on this page, so it refetches
  // the groups (debounced) instead of polling — one request, not the reference
  // collections too. The 1 s tick moves only the elapsed-time spans in place;
  // every 15th tick it also refetches while something is running and the tab is
  // visible — the safety net for a missed event or a dead feed.
  const anyActive = () => ctl.groups.some(isActiveGroup);
  const refetch = () => {
    if (!current()) return;
    clearTimeout(live.refetchTimer);
    live.refetchTimer = setTimeout(async () => {
      if (!current()) return;
      try {
        await loadGroups();
        if (current()) paint();
      } catch { /* transient — the next event or tick retries */ }
    }, 250);
  };
  let ticks = 0;
  live = {
    token,
    refetchTimer: null,
    sub: subscribeFeed(projectKey, {
      types: ["run.status", "run.event", "candidate.created"],
      onEvent: (e: WebDynamic) => {
        // Group-level run.status carries the cold-start narration ("provisioning");
        // it has no run_id and its payload.status names the stage, not a verdict.
        if (e.type === "run.status" && e.entity?.run_group_id && !e.entity?.run_id
            && typeof e.payload?.status === "string") {
          ctl.feedNotes.set(e.entity.run_group_id, e.payload.status);
        }
        // Each progress event carries the actor's latest action; remembered
        // here they become the story's visible trail. Consecutive duplicates
        // are the throttle re-sending, not the actor repeating itself.
        if (e.type === "run.event" && e.payload?.type === "progress" && e.entity?.run_id) {
          if (typeof e.payload.action === "string" && e.payload.action) {
            const trail = ctl.trails.get(e.entity.run_id) || [];
            if (trail[0] !== e.payload.action) {
              ctl.trails.set(e.entity.run_id, [e.payload.action, ...trail].slice(0, TRAIL_LEN));
            }
          }
          // The payload IS the row's `progress` projection (§Runner protocol),
          // so patch the row and repaint: a step counter ticking is not a
          // reason to re-download the page. Anything the snapshot can't
          // explain — an unknown run, a row not in flight — falls through to
          // the refetch below, which is also what recovers a stale row.
          const g = ctl.groups.find((x: WebDynamic) => x.id === e.entity.run_group_id);
          const r = (g?.runs || []).find((x: WebDynamic) => x.id === e.entity.run_id);
          if (r && inFlightStatus(r.status)) {
            const { type: _type, case_id: _caseId, ...snap } = e.payload;
            r.progress = snap;
            if (current()) paint();
            return;
          }
        }
        refetch();
      },
    }),
    tick: setInterval(() => {
      if (!current()) return;
      const now = Date.now();
      for (const [el, started] of ctl.tickEls) el.textContent = fmtElapsed(now - started);
      if (++ticks % 15 === 0 && anyActive() && !document.hidden) refetch();
    }, 1000),
  };
  onPageLeave(stopLive);
  // A deep link into a collapsed suite reopens it — the link's promise is
  // "this run, in view", and a shut shelf breaks it silently.
  if (focusGroupId) {
    const target = ctl.groups.find((g: WebDynamic) => g.id === focusGroupId);
    if (target) collapsedSuites.delete(target.suite_id);
  }
  paint(true);
  if (focusGroupId) {
    main.querySelector(`[data-group="${focusGroupId}"]`)?.scrollIntoView({ block: "center" });
    if (!ctl.groups.some((g: WebDynamic) => g.id === focusGroupId)) {
      toast("Run not shown", "It may be older than the loaded list, or removed by retention.");
    }
  }

  function paint(first = false) {
    const suiteById: WebDynamic = new Map(ctl.suites.map((s: WebDynamic) => [s.id, s]));
    const ringName: WebDynamic = new Map(ctl.rings.map((r: WebDynamic) => [r.id, `${r.application.key}/${r.key}`]));
    // Nothing moved ⇒ nothing repaints. These pages rebuild their DOM wholesale,
    // and a rebuild costs the person their scroll position, their focus, and any
    // menu they had open. `progress` is in the signature: a live row's step
    // counter or last action changing IS the page moving.
    const sig = JSON.stringify([[...collapsedSuites], ctl.liveN, ctl.groups.map((g: WebDynamic) => [
      g.id, g.status, g.stats, ctl.feedNotes.get(g.id) ?? null, ctl.showAll.has(g.id),
      (g.runs || []).map((r: WebDynamic) => [r.id, r.status, r.score, r.cost_usd, r.progress, ctl.trails.get(r.id)]),
    ])]);
    if (!first && sig === ctl.sig) return;
    ctl.sig = sig;
    ctl.tickEls = new Map();

    const actions: WebDynamic = [
      canLaunch ? h("button.btn.primary", { onclick: () => launchModal(projectKey, ctl.suites) }, "+ Launch") : null,
    ].filter(Boolean);

    // The story filter: typing a story id narrows the loaded runs to the ones
    // that ran it, and opens them on the matching stories. Client-side over
    // what this page has fetched — "Show older runs" widens the net.
    const q = ctl.q.trim().toLowerCase();
    const matchStory = (r: WebDynamic) => (r.case_id || "").toLowerCase().includes(q);
    // A suite's name reaches the filter too: with hundreds of suites, "gov
    // schemes" is how a person names what they're looking for at least as
    // often as a story id is.
    const matchSuite = (g: WebDynamic) => {
      const s = suiteById.get(g.suite_id);
      return !!s && ((s.name || "").toLowerCase().includes(q) || (s.slug || "").toLowerCase().includes(q));
    };
    const groupMatches = (g: WebDynamic) =>
      !q || (g.runs || []).some(matchStory) || runTitle(g).toLowerCase().includes(q) || matchSuite(g);
    const shownGroups = ctl.groups.filter((g: WebDynamic) => groupMatches(g) && (!liveOnly || isActiveGroup(g)));

    // Triage split. "Needs attention" is server-side (`outcome=attention`), so
    // it reaches the whole history, not this page; the count is what's loaded.
    // "In flight" is the watching tab — the one place runs open themselves into
    // their live blocks, so the dense list never has to.
    const attnCount = attentionOnly
      ? ctl.groups.length
      : ctl.groups.filter((g: WebDynamic) => unresolvedFailure(g)).length;
    const liveCount = attentionOnly ? (ctl.liveN ?? 0) : ctl.groups.filter(isActiveGroup).length;
    const tab = (on: WebDynamic, to: WebDynamic, label: WebDynamic, opts: WebDynamic = {}) => h(`button${on ? ".on" : ""}`, {
      role: "tab", "aria-selected": String(on), "data-fk": opts.fk,
      title: opts.title,
      onclick: () => { if (!on) navigate(to); },
    }, label);
    const filterBar = ctl.groups.length || attentionOnly || liveOnly || q
      ? h("div.runs-filter", {},
          h("div.seg", { role: "tablist", "aria-label": "Filter runs" },
            tab(!attentionOnly && !liveOnly, `/p/${projectKey}/runs`, "All runs", { fk: "flt:all" }),
            tab(attentionOnly, `/p/${projectKey}/runs?attention=1`,
              attnCount ? `Needs attention · ${attnCount}` : "Needs attention",
              { fk: "flt:attn", title: "Runs holding a failed check, or a story that never produced a verdict" }),
            // Hidden when nothing is moving. On the attention tab the count
            // comes from the live probe of the newest unfiltered page, since
            // that tab's own list holds only attention runs.
            liveCount || liveOnly
              ? tab(liveOnly, `/p/${projectKey}/runs?live=1`,
                  `In flight · ${liveCount}`,
                  { fk: "flt:live", title: "Runs still queued or running, each opened to its live stories" })
              : null),
          h("input.runs-story-filter", {
            type: "search", placeholder: "Find a suite or story…", value: ctl.q,
            "aria-label": "Filter runs by suite name or story id", "data-fk": "flt:q",
            oninput: (e: WebDynamic) => { ctl.q = e.target.value; ctl.sig = null; paint(); },
          }),
        )
      : null;

    let body;
    if (!ctl.groups.length) {
      // The attention tab's empty state keeps the filter bar: the tabs are how
      // the person got here, and a clean project must not strand them on a
      // page whose only way back is the sidebar.
      body = attentionOnly
        ? h("div.stack", {}, filterBar,
            emptyState("Nothing needs attention",
              "No run in this project is holding a failed check or a story that never produced a verdict.",
              h("div.empty-actions", {}, link(`/p/${projectKey}/runs`, h("span.btn.primary", {}, "See all runs")))))
        : emptyState("No runs yet", "Launch a suite against one of its application's rings and its stories run here.",
            canLaunch ? h("button.btn.primary", { onclick: () => launchModal(projectKey, ctl.suites) }, "Launch") : null);
    } else if (liveOnly && !shownGroups.length) {
      body = h("div.stack", {}, filterBar,
        emptyState("Nothing in flight",
          "No run in this project is queued or running right now.",
          h("div.empty-actions", {}, link(`/p/${projectKey}/runs`, h("span.btn.primary", {}, "See all runs")))));
    } else if (!shownGroups.length) {
      body = h("div.stack", {}, filterBar,
        emptyState("No matching suite or story",
          `None of the ${ctl.groups.length} loaded runs ran in a suite or story matching “${ctl.q.trim()}”.`
            + (ctl.groups.length >= ctl.limit ? " Older runs aren't searched until they're shown." : ""),
          ctl.groups.length >= ctl.limit
            ? h("div.empty-actions", {}, h("button.btn", { onclick: showOlder }, "Show older runs"))
            : null));
    } else {
      // ONE table for every suite, not one per suite. Repeating the column
      // header down the page cost a header's height per suite and bought
      // nothing — and separate tables cannot align their columns with each
      // other, which is the whole point of a column.
      body = h("div.stack", {}, filterBar,
        h("div.card", {}, h("table.rows.run-index", {},
          // Explicit columns: the layout is fixed (see style.css) so that a long
          // launch note or a live "now" line can never widen the table past the
          // card it sits in.
          h("colgroup", {}, h("col.c-run"), h("col.c-outcome"), h("col.c-target"),
            h("col.c-took"), h("col.c-cost"), h("col.c-started"), h("col.c-actions")),
          h("thead", {}, h("tr", {},
            h("th", {}, "Run"), h("th", {}, "Outcome"), h("th", {}, "Target"),
            h("th", {}, "Took"), h("th", {}, "Cost"), h("th", {}, "Started"),
            h("th", {}, srOnly("Actions")))),
          ...suiteOrder(shownGroups).flatMap((suiteId: WebDynamic) =>
            suiteBlock(suiteId, shownGroups.filter((g: WebDynamic) => g.suite_id === suiteId))),
        )),
        // Paging is deliberately coarse: this is a triage list, not an archive.
        // Story history per suite is where a long tail belongs.
        ctl.groups.length >= ctl.limit
          ? h("div", {},
              h("button.btn", { onclick: showOlder }, "Show older runs"),
              q ? h("span.dim", { style: "margin-left:10px" }, `searching the ${ctl.groups.length} loaded runs`) : null)
          : null,
      );
    }

    const focusKey = document.activeElement?.dataset?.fk || null;
    const scroll = main.scrollTop;
    mount(main, page({
      title: "Runs",
      sub: attentionOnly
        ? "Runs holding a failure or a story that never ran"
        : liveOnly
          ? "Everything still moving, opened to its stories — watch it, or stop it"
          : "Every run, story by story — open a story to replay what happened",
      actions,
      body,
    }));
    // A repaint must not move the page under the reader or drop their place in
    // the keyboard order.
    main.scrollTop = scroll;
    if (focusKey) {
      const el = main.querySelector(`[data-fk="${focusKey}"]`);
      el?.focus();
      // A rebuilt input starts its caret at 0; someone mid-word in the story
      // filter is typing at the end.
      if (el?.tagName === "INPUT") el.setSelectionRange(el.value.length, el.value.length);
    }

    /**
     * One suite inside the single table: a full-width head row carrying the
     * suite's name, run count, trend and launch, then a body of its runs. Two
     * `tbody`s rather than one so the disclosure has something to name in
     * `aria-controls` that isn't the button's own row.
     */
    function suiteBlock(suiteId: WebDynamic, groups: WebDynamic) {
      const suite = suiteById.get(suiteId);
      const name = suite ? suite.name || suite.slug : short(suiteId);
      const to = suite ? `/p/${projectKey}/suites/${suite.slug}` : null;
      // A search overrides collapse: a filter that found the run and then hid
      // it behind a shut suite has only done half the finding.
      const sectionOpen = !collapsedSuites.has(suiteId) || !!q;
      const sectionBodyId = `suite-runs-${suiteId}`;
      const head = h("tbody.suite-block", {}, h("tr", {}, h("td.suite-head-cell", { colspan: "7" },
        h("div.suite-head", {},
          h("button.expander", {
            "aria-expanded": sectionOpen ? "true" : "false",
            "aria-controls": sectionBodyId,
            "aria-label": `${sectionOpen ? "Hide" : "Show"} the runs of ${name}`,
            "data-fk": `suite:${suiteId}`,
            onclick: () => {
              if (collapsedSuites.has(suiteId)) collapsedSuites.delete(suiteId);
              else collapsedSuites.add(suiteId);
              ctl.sig = null; paint();
            },
          }, h("span", { "aria-hidden": "true" }, sectionOpen ? "▾" : "▸")),
          h("h2.suite-name", {},
            to ? link(to, name) : name,
            h("span.count", {}, `${groups.length} ${groups.length === 1 ? "run" : "runs"}`)),
          trendPips(groups),
          canLaunch && suite
            ? h("button.btn.btn-sm.ghost.suite-launch", {
                "aria-label": `Launch a run of ${name}`,
                onclick: () => launchModal(projectKey, ctl.suites, suite.id),
              }, "Run this suite ▶")
            : null,
        ))));
      return [head, h("tbody.suite-runs", { id: sectionBodyId },
        ...(sectionOpen ? groups.flatMap((g: WebDynamic) => runRows(g)) : []))];
    }

    /** One run: its row, plus the story rows it expands to. */
    function runRows(g: WebDynamic) {
      const stats = runStats(g);
      const rows = g.runs || [];
      const active = isActiveGroup(g);
      // A one-story run has no summary worth a screen of its own: its name goes
      // straight to the replay. While it is still running it expands like any
      // other run — the live row and Cancel are here now, not on another page.
      const solo = soloStory(g, stats);
      const note = g.trigger?.note;
      // A one-story run is named by the story it ran: "launched run · 1 story"
      // answered neither what ran nor how to find it again. A written launch
      // note stays the title — a person chose those words — and the story
      // moves to the tag; otherwise the start stamp is the whole tag. A run
      // nobody named leads its tag with the start stamp: the trigger word is
      // the same on every launch, so the stamp is the one thing that tells
      // three bare "launched run" rows apart — in the tag, not the title,
      // because it is a qualifier, not a name a person would say.
      const title = note || (solo ? solo.case_id : runTitle(g));
      const when = !note && g.created_at ? stamp(g.created_at) : null;
      const runHref = `/p/${projectKey}/runs/${g.id}`;
      const href = solo ? `${runHref}/${solo.id}` : runHref;
      const canExpand = rows.length > 0 && !solo;
      const open = canExpand && isOpen(g);
      const bodyId = `stories-${g.id}`;

      // An expandable run's title toggles it, exactly as the rest of the row
      // does. It stays an anchor — the run's own URL is worth a middle-click
      // or a copy — but a plain click on it used to navigate to a page that
      // re-opens this index on the same run, which read as the click doing
      // nothing. The expander button remains the accessible disclosure.
      const name = canExpand
        ? h("a", {
            href: runHref,
            onclick: (e: WebDynamic) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey) return;
              e.preventDefault();
              toggle(g);
            },
          }, h("span.rowtitle", {}, title))
        : link(href, h(solo && !note ? "span.rowtitle.id" : "span.rowtitle", {}, title));
      // Several runs share a trigger note ("nightly regression" three nights
      // running), and a ULID's leading characters are its timestamp — identical
      // for two runs minted in the same millisecond. The start time is the
      // distinguisher a person would actually use.
      name.setAttribute("aria-label", g.created_at
        ? `${title} — started ${new Date(g.created_at).toLocaleString()}`
        : title);

      const row = h(`tr.launch-row${open ? ".open" : ""}`, {
        "data-group": g.id,
        onclick: (e: WebDynamic) => {
          if (e.target.closest("a, button")) return;
          if (canExpand) toggle(g);
          else navigate(href);
        },
      },
        h("td", {},
          h("div.launch-name", {},
            canExpand
              ? h("button.expander", {
                  "aria-expanded": open ? "true" : "false",
                  "aria-controls": bodyId,
                  // Three nights of "nightly regression" put three identically
                  // named disclosures on one page; the time is what tells them
                  // apart, exactly as it does for the row's own link.
                  "aria-label": `${open ? "Hide" : "Show"} the ${stats.total} ${stats.total === 1 ? "story" : "stories"} in ${title}`
                    + (g.created_at ? ` from ${ago(g.created_at)}` : ""),
                  "data-fk": `exp:${g.id}`,
                  onclick: () => toggle(g),
                }, h("span", { "aria-hidden": "true" }, open ? "▾" : "▸"))
              : h("span.expander-spacer", { "aria-hidden": "true" }),
            name,
            // The tag carries whatever the title doesn't: the trigger for a
            // run named by its story, the story for a noted one-story run, and
            // the count — with the story ids on hover — for a multi-story run.
            // A solo row's tag is just the stamp: its title IS the story, so
            // "1 story" restated what the reader can see, and the trigger word
            // is only worth a tag when there is no stamp to wear instead.
            solo && !note
              ? h("span.rowtag", {}, when || triggerWord(g.trigger?.kind))
              : solo
                ? h("span.rowtag.id", {}, solo.case_id)
                : h("span.rowtag", rows.length
                    ? { title: rows.slice(0, 12).map((r: WebDynamic) => r.case_id).join("\n")
                        + (rows.length > 12 ? `\n+${rows.length - 12} more` : "") }
                    : {},
                    `${when ? `${when} · ` : ""}${stats.total || 0} ${stats.total === 1 ? "story" : "stories"}`),
          ),
          // A run in flight that is NOT expanded still has to look alive, and
          // one line is what that costs on a page holding six of them.
          active && !open ? nowLine(g, rows, stats) : null,
        ),
        h("td", {}, outcomeCell(g, stats)),
        h("td.dim", {}, ringName.get(g.ring_id) || "—"),
        // A live run's clock ticks in place (registerTick); a duration that
        // cannot tick reads as a frozen one.
        h("td.dim", {}, active && stats.started_at
          ? registerTick(stats.started_at)
          : stats.duration_ms != null ? fmtMs(stats.duration_ms) : "—"),
        // While the run moves, its cost is the finished stories' totals plus
        // what the in-flight ones have spent so far (their live progress).
        h("td.dim", {}, runCost(g, stats) > 0 ? fmtCost(runCost(g, stats)) : "—"),
        h("td.dim", {}, g.created_at ? ago(g.created_at) : "—"),
        h("td.row-actions", {}, rowAction(g, rows, active)),
      );
      if (!canExpand) row.style.cursor = "pointer";

      const parts: WebDynamic = [row];
      if (open) {
        // While the story filter is on, an open run shows the matches, not its
        // usual first-few — the match is what the person is here to find.
        const filtering = q && rows.some(matchStory);
        const list = filtering ? rows.filter(matchStory) : rows;
        // Queued stories leave the list: they have no vitals, no evidence and
        // nowhere to go, so they get one summary line at the foot instead of a
        // row each — which is what made a 3-story run three screens tall.
        const queued = list.filter((r: WebDynamic) => r.status === "queued");
        const rest = list.filter((r: WebDynamic) => r.status !== "queued");
        const all = ctl.showAll.has(g.id);
        const total = (filtering ? list.length : Math.max(stats.total || 0, list.length)) - queued.length;
        const { shown, hidden } = visibleStories(rest, total, all);
        parts.push(h("tr.story-rows", { id: bodyId }, h("td", { colspan: "7" },
          h("div.story-lines", {},
            runNote(g, stats),
            ...shown.map((r: WebDynamic) => storyLine(projectKey, g, r, registerTick, ctl.trails)),
            queued.length ? queuedLine(queued) : null,
            hidden > 0 && !all
              ? h("button.story-more.story-more-btn", {
                  onclick: () => { ctl.showAll.add(g.id); ctl.sig = null; paint(); },
                  "data-fk": `more:${g.id}`,
                }, `Show all ${Math.max(stats.total || 0, list.length)} stories`)
              : hidden > 0
                ? h("div.story-more", {}, `+${hidden} more not loaded — narrow with the story filter`)
                : null,
          ),
        )));
      }
      return parts;
    }

    /**
     * The one action a run row carries, at its right edge: Cancel while it is
     * spending, Retry when it needs attention, or Synthesize once a discovery
     * run has trajectories to mine.
     *
     * These used to live inside the expanded block, which was fine while every
     * live run expanded itself. Now that none do, "stop this run" cannot be a
     * thing you first have to go looking for — it is the most urgent control on
     * the page and it costs no height on the row.
     */
    function rowAction(g: WebDynamic, rows: WebDynamic, active: WebDynamic) {
      if (!canLaunch) return null;
      // Cancelling kills work in flight — real browser time, real model spend,
      // no undo — so it confirms (cancelGroup) like every delete does.
      if (active) {
        return h("button.row-act.danger", {
          "aria-label": `Cancel ${runTitle(g)}${g.created_at ? ` from ${ago(g.created_at)}` : ""}`,
          "data-fk": `cancel:${g.id}`,
          onclick: () => cancelGroup(projectKey, g.id, rows),
        }, "Cancel");
      }
      const stats = runStats(g);
      if (canRetryRun(g, stats)) {
        return h("button.row-act", {
          "aria-label": `Retry ${runTitle(g)}${g.created_at ? ` from ${ago(g.created_at)}` : ""}`,
          "data-fk": `retry:${g.id}`,
          onclick: (e: WebDynamic) => retryGroup(
            projectKey,
            g,
            ringName.get(g.ring_id),
            e.currentTarget,
          ),
        }, "Retry");
      }
      const exploredCount = rows.filter((r: WebDynamic) => r.status === "explored").length;
      if (!exploredCount) return null;
      return h("button.row-act", {
        "aria-label": `Synthesize findings from ${runTitle(g)}${g.created_at ? ` from ${ago(g.created_at)}` : ""}`,
        onclick: (e: WebDynamic) => synthesizeGroup(projectKey, g.id, exploredCount, e.currentTarget),
      }, "Synthesize");
    }

    /**
     * The one-line sign of life on a collapsed run: the story furthest along,
     * what it is doing, where in its step budget it is, and the actor's latest
     * action. Everything the 100px live block said, minus the room.
     *
     * Only one story is named even when several are moving; the count says so,
     * and the meter in OUTCOME already carries the arithmetic. Naming all of
     * them is how the block got tall in the first place.
     */
    function nowLine(g: WebDynamic, rows: WebDynamic, stats: WebDynamic) {
      const moving = rows.filter((r: WebDynamic) => inFlightStatus(r.status));
      if (!moving.length) {
        // Nothing has started: say what it is waiting for rather than nothing.
        const words = narration(g, ctl.feedNotes.get(g.id), stats);
        return words ? h("div.run-now.dim", { "aria-live": "polite" }, words) : null;
      }
      const r = moving[0];
      const p = r.progress || null;
      // The snapshot seeds a trail the feed hasn't fed yet, exactly as the
      // expanded block does — the two must never disagree about the last action.
      if (!ctl.trails.has(r.id) && p?.action) ctl.trails.set(r.id, [p.action]);
      const action = ctl.trails.get(r.id)?.[0] || null;
      const doing = r.status === "uploading" ? "uploading evidence" : p?.doing || modeDoing(r.mode);
      const others = moving.length - 1;
      // Order is priority order, because the tail is what gets cut: which story
      // (and how many others), where it has got to, and only then what it just
      // did. The action is the one part that can end in an ellipsis without the
      // line losing its point, so it goes last and absorbs all the shrinking.
      return h("div.run-now", { "aria-live": "polite" },
        statusChip("running", doing),
        h("span.run-now-story.id", { title: r.case_id }, r.case_id),
        others > 0 ? h("span.run-now-more", {}, `+${others} more`) : null,
        p?.step != null
          ? h("span.run-now-step", { title: p.max_steps ? `${p.step} of the story's ${p.max_steps}-step budget used` : null },
              `step ${p.step}${p.max_steps ? `/${p.max_steps}` : ""}`)
          : null,
        action ? h("span.run-now-action", { title: action }, `↳ ${action}`) : null,
      );
    }

    /**
     * The narration line inside an expanded run: the cold-start stage while
     * nothing has started, the plain-words verdict once it ends. The mid-run
     * counts it used to state are on the row now (the OUTCOME meter), so this
     * says nothing rather than repeating them.
     */
    function runNote(g: WebDynamic, stats: WebDynamic) {
      const words = narration(g, ctl.feedNotes.get(g.id), stats);
      return words ? h("div.story-note", { "aria-live": "polite" }, words) : null;
    }

    /** An elapsed-time span that the 1 s tick updates in place. */
    function registerTick(startedAt: WebDynamic) {
      const started = new Date(startedAt).getTime();
      const el = h("span", {}, fmtElapsed(Date.now() - started));
      ctl.tickEls.set(el, started);
      return el;
    }

    function trendPips(groups: WebDynamic) {
      // Oldest to newest, left to right — the direction a trend is read.
      const recent = groups.slice(0, 8).reverse();
      const words = recent.map((g: WebDynamic) => pipTone(g, runStats(g)) || "no verdict");
      const counts: WebDynamic = {};
      for (const w of words) counts[w] = (counts[w] || 0) + 1;
      const text = `last ${recent.length} ${recent.length === 1 ? "run" : "runs"}: `
        + Object.entries(counts).map(([w, n]) => `${n} ${w}`).join(" · ");
      return h("span.trend-pips", { title: text },
        srOnly(text),
        ...recent.map((g: WebDynamic) => h(`span.pip${pipTone(g, runStats(g)) ? `.${pipTone(g, runStats(g))}` : ""}`, { "aria-hidden": "true" })),
      );
    }

    async function showOlder() {
      ctl.limit = ctl.limit >= OLDER_SIZE ? ctl.limit + OLDER_SIZE : OLDER_SIZE;
      try {
        await load();
        if (current()) paint(true);
      } catch (err: WebDynamic) { toastError(err); }
    }
  }

  /**
   * Mirrors the server's `outcome=attention`: a failing story is retired once
   * a newer run of the same suite and ring passes it, so attention
   * means the latest verdict is still bad. The page loads newest-first, so any
   * superseding pass is always at least as new as the failure it retires and
   * is therefore already loaded.
   */
  function unresolvedFailure(g: WebDynamic) {
    // A canceled group is a decision the person already made, even about the
    // stories that failed before they pulled the plug.
    if (g.status === "canceled") return false;
    if (!needsAttention(runStats(g))) return false;
    const newer = ctl.groups.filter((x: WebDynamic) => x.suite_id === g.suite_id
      && x.ring_id === g.ring_id && x.created_at > g.created_at);
    return (g.runs || []).some((r: WebDynamic) => ["fail", "infra", "lost"].includes(r.status)
      && !newer.some((x: WebDynamic) => (x.runs || []).some(
        (r2: WebDynamic) => r2.case_id === r.case_id && r2.status === "pass")));
  }

  /**
   * Which runs open by themselves — deliberately few, because an expanded run
   * is worth several collapsed ones in height and this page has to hold a busy
   * week. Only a failure among a suite's three newest FINISHED runs opens on
   * its own: a failure a person has to click to discover is a failure the
   * screen chose not to mention, and no other state has that claim on the room.
   *
   * Finished, not newest outright: a run still in flight has no verdict yet, so
   * letting it take a place in the three would mean four things launched at
   * lunchtime could quietly close last night's failure.
   *
   * The two rules that used to open half the page are gone. The newest run in
   * EVERY suite opened itself, which on a clean week was a screenful of green
   * "▶ Replay" lines saying what the outcome counts already said. And every run
   * in flight opened itself, which is what made a busy console unscannable —
   * that live block is what the "In flight" tab and a run's own URL are for,
   * and a collapsed live run keeps its meter, its clock and its now-line.
   */
  function isOpen(g: WebDynamic) {
    if (touched.has(g.id)) return expanded.has(g.id);
    // A story search opens what it matched — a filter that finds the run but
    // still hides the story inside it has only done half the finding. A run
    // shown only because its SUITE matched keeps the normal rules: the person
    // named a suite, not a story, and a wall of open runs isn't the answer.
    const fq = ctl.q.trim().toLowerCase();
    if (fq) {
      if ((g.runs || []).some((r: WebDynamic) => (r.case_id || "").toLowerCase().includes(fq))
          || runTitle(g).toLowerCase().includes(fq)) return true;
    }
    // Both filters are a person asking for one kind of run and nothing else:
    // having narrowed the page to it, opening it is what they came to do.
    if (attentionOnly || liveOnly) return true;
    const settled = ctl.groups.filter((x: WebDynamic) => x.suite_id === g.suite_id && !isActiveGroup(x));
    const rank = settled.indexOf(g);
    return rank >= 0 && rank < 3 && unresolvedFailure(g);
  }

  function toggle(g: WebDynamic) {
    const wasOpen = isOpen(g);
    touched.add(g.id);
    if (wasOpen) expanded.delete(g.id);
    else expanded.add(g.id);
    ctl.sig = null; // a person's own click always repaints
    paint();
  }
}

/**
 * The outcome cell: one compact count per outcome the run produced ("✗1 ⚠1 ✓1"),
 * with the words beside them for anyone who cannot see a glyph or its colour. A
 * run that has not finished says where it is instead.
 *
 * A RUNNING one says it as a meter rather than as the sentence "0 of 3 stories
 * done" — two segments (finished solid, in flight breathing) and "0/3". The
 * sentence is still what a screen reader gets; on a page of live runs the shape
 * is what lets you compare them at a glance, and it is a third of the width.
 */
function outcomeCell(g: WebDynamic, stats: WebDynamic) {
  if (g.status === "running" && stats.total) {
    const words = progressWords(stats) || "running";
    const done = Math.min(stats.done, stats.total);
    const moving = Math.min(stats.running, stats.total - done);
    const pct = (n: WebDynamic) => `${(n / stats.total) * 100}%`;
    return h("span.run-progress", { title: words },
      srOnly(words),
      h("span.rp-meter", { "aria-hidden": "true" },
        done ? h("span.rp-done", { style: `width:${pct(done)}` }) : null,
        moving ? h("span.rp-moving", { style: `width:${pct(moving)}` }) : null),
      h("span.rp-count", { "aria-hidden": "true" }, `${done}/${stats.total}`),
    );
  }
  if (g.status === "queued" || g.status === "running" || g.status === "canceled" || !stats.total) {
    const { tone, label } = outcomeChip(g, stats);
    return statusChip(tone, label);
  }
  const parts = outcomeParts(stats);
  if (!parts.length) return statusChip("neutral", "done");
  // Every outcome word is a term of art; its definition rides on the count
  // itself as a tooltip, where the word appears, instead of a standing legend.
  return h("span.outcome-counts", {},
    srOnly(parts.map((p: WebDynamic) => `${p.n} ${p.word}`).join(", ")),
    ...parts.map((p: WebDynamic) => {
      const gloss = outcomeGloss(p.word);
      return h(`span.status.${p.tone}`, {
        "aria-hidden": "true",
        title: `${p.n} ${p.word}${gloss ? ` — ${gloss}` : ""}`,
      }, h("span.glyph", {}, GLYPH[p.tone] || "○"), String(p.n));
    }),
  );
}

/**
 * The stories shown inside an expanded run: the first few, in the same order the
 * run's own page uses, plus every story needing attention — and every story
 * still moving — wherever it falls. `total` is how many belong here (queued ones
 * are summarised elsewhere), so `hidden` also covers stories the server capped
 * out of this page.
 */
function visibleStories(rows: WebDynamic, total = rows.length, showAll = false) {
  const cap = Math.max(total, rows.length);
  if (showAll || rows.length <= VISIBLE_STORIES) return { shown: rows, hidden: cap - rows.length };
  const keep: WebDynamic = new Set(rows
    .filter((r: WebDynamic) => r.status === "fail" || neverRanStatus(r.status) || inFlightStatus(r.status))
    .slice(0, VISIBLE_STORIES));
  for (const r of rows) {
    if (keep.size >= VISIBLE_STORIES) break;
    keep.add(r);
  }
  const shown = rows.filter((r: WebDynamic) => keep.has(r));
  return { shown, hidden: cap - shown.length };
}

/**
 * Every queued story of an expanded run, on one line. A queued story has no
 * vitals, no evidence and nowhere to go — a row each said "not yet" N times and
 * wrapped every long id across two lines doing it.
 */
function queuedLine(queued: WebDynamic) {
  const names = queued.map((r: WebDynamic) => r.case_id);
  const named = names.slice(0, QUEUED_NAMED);
  const rest = names.length - named.length;
  return h("div.story-queued", { title: names.join("\n") },
    statusChip("neutral", `${names.length} queued`),
    h("span.story-queued-ids.id", {},
      named.join(" · ") + (rest ? ` · +${rest} more` : "")),
  );
}

/**
 * One story inside an expanded run.
 *
 * Finished, the whole line is the link to its evidence, and it says what that
 * evidence IS — "Replay" for a trajectory, the explanation for a story that
 * never produced one.
 *
 * In flight, the line becomes a live block (liveStoryLine): pulsing mode chip,
 * the name at full width, vitals on the right, a step-budget meter, the actor's
 * recent actions as a fading trail — and, since a run's evidence now streams
 * while it executes (interfaces.md, live runs), a Watch link to the replay
 * itself. This block says what the run is doing; the replay shows what it is
 * seeing, screenshot by screenshot, and used to 404 until the run sealed.
 *
 * Queued stories never reach here: they are summarised on one line by
 * queuedLine, because a row each said "not yet" and nothing else.
 */
function storyLine(projectKey: WebDynamic, g: WebDynamic, r: WebDynamic, registerTick: WebDynamic, trails: WebDynamic) {
  const done = isFinishedStatus(r.status);
  if (!done) return liveStoryLine(projectKey, g, r, registerTick, trails);
  const to = `/p/${projectKey}/runs/${g.id}/${r.id}`;
  const never = neverRanStatus(r.status);
  // One sentence about the story rather than a second set of columns: these
  // lines sit inside a cell of the runs table, and numbers laid out in columns
  // there would sit under headers that mean something else entirely (a story's
  // score under COST).
  const detail = never && r.error ? clamp(String(r.error), 140)
    : [
        r.steps != null ? `${r.steps} steps` : null,
        r.duration_ms != null ? fmtMs(r.duration_ms) : null,
        r.score != null ? `score ${r.score}` : null,
        r.cost_usd ? fmtCost(r.cost_usd) : null,
      ].filter(Boolean).join(" · ");
  const a = link(to, h("div.story-line", {},
    storyChip(r),
    h("span.story-name.id", { title: r.case_id }, r.case_id),
    // The line no longer wraps, so anything longer than its column has to be
    // readable some other way — and an infra error's text is the whole point of
    // the row it is on.
    h("span.story-detail.dim", { title: detail || null }, detail),
    h("span.story-open", {}, never ? "Why it didn't run →" : "▶ Replay"),
  ));
  a.className = "quiet-link";
  return a;
}

/** The live block for a story still moving (see storyLine). */
function liveStoryLine(projectKey: WebDynamic, g: WebDynamic, r: WebDynamic, registerTick: WebDynamic, trails: WebDynamic) {
  const p = r.progress || null;
  // The snapshot's action seeds a trail the feed hasn't fed yet (first paint,
  // or arriving mid-run) so the block never opens emptier than the server knows.
  if (!trails.has(r.id) && p?.action) trails.set(r.id, [p.action]);
  const trail = trails.get(r.id) || [];
  // Vitals on the right, smallest last: step N/M · cost so far · elapsed
  // (ticking in place). Model and token telemetry ride the tooltip — real,
  // but not worth surface on a triage screen.
  const vitals: WebDynamic = [];
  if (p?.step != null) vitals.push(`step ${p.step}${p.max_steps ? `/${p.max_steps}` : ""}`);
  if (p?.cost_usd > 0) vitals.push(fmtCost(p.cost_usd));
  const detail = h("span.story-vitals.dim", {},
    vitals.length ? `${vitals.join(" · ")} · ` : "",
    r.started_at ? registerTick(r.started_at) : "…");
  const hover: WebDynamic = [
    p?.model || null,
    p?.tokens ? ["ctx" in p.tokens && p.tokens.ctx != null ? `ctx ${kfmt(p.tokens.ctx)}` : null,
        p.tokens.in || p.tokens.out ? `↑${kfmt(p.tokens.in || 0)} ↓${kfmt(p.tokens.out || 0)}` : null]
        .filter(Boolean).join(" · ") : null,
  ].filter(Boolean).join(" · ");
  if (hover) detail.title = hover;
  const doing = r.status === "uploading" ? "uploading evidence" : p?.doing || modeDoing(r.mode);
  // Where a story in flight leads. It sits in the same column as a finished
  // story's "▶ Replay" and wears the ● of the live vocabulary the viewer uses,
  // because it is the same destination in a different tense: the replay, filling
  // up as the actor works. A queued story never reaches here, so the link never
  // promises a stream that has not started.
  const watch = link(
    `/p/${projectKey}/runs/${g.id}/${r.id}`,
    h("span.story-watch", {}, h("span.live-dot", { "aria-hidden": "true" }), "Watch"),
  );
  watch.className = "story-watch-link";
  // Several runs of the same suite can have the same story moving at once, so
  // the story id alone would put three identically named links on one screen —
  // the run names them apart, exactly as it does for Cancel.
  watch.setAttribute("aria-label", `Watch ${r.case_id} as it runs, in ${runTitle(g)}`);
  watch.title = "Open the replay and watch the steps arrive";
  return h("div.story-live", {},
    h("div.story-line.story-live-head", {},
      statusChip("running", doing),
      h("span.story-name.id", {}, r.case_id),
      detail,
      watch,
    ),
    // The step-budget meter: budget consumed, not distance to done — a story
    // that passes at step 12 of 100 was quick, not 12% finished, which is why
    // it is a thin gauge with the honest words on hover, never a fat progress
    // bar promising an ETA. The vitals carry the numbers for screen readers.
    p?.step != null && p?.max_steps
      ? h("div.story-meter", {
          "aria-hidden": "true",
          title: `${p.step} of the story's ${p.max_steps}-step budget used`,
        }, h("div.story-meter-fill", {
          style: `width:${Math.min(100, Math.max(1.5, (p.step / p.max_steps) * 100))}%`,
        }))
      : null,
    // The actor's recent actions, newest first and fading with age — the
    // stream left visible, which is what "watch it being recorded" means on a
    // page. One line, not one line each: three stacked lines per story is the
    // single biggest thing that made a run in flight half a screen tall, and a
    // trail reads as well running left from the newest as it does stacked.
    // Post-actor phases clear the snapshot's action (runner-side), and the
    // whole trail dims with it: "clicked Submit" in ink under a "grading" chip
    // would describe work that is not happening.
    trail.length
      ? h("div.story-actions", { title: trail.join("\n") },
          h("span.story-action-arrow", { "aria-hidden": "true" }, "↳ "),
          ...trail.flatMap((a: WebDynamic, i: WebDynamic) => [
            i ? h("span.story-action-sep", { "aria-hidden": "true" }, " · ") : null,
            h(`span.story-action${i || !p?.action ? ".past" : ""}`, {}, a),
          ]))
      : null,
  );
}

// 8231 → "8.2k" (the CLI live line's token format).
const kfmt = (n: WebDynamic) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

/** A run's cost so far: finished stories' totals plus live progress spend. */
function runCost(g: WebDynamic, stats: WebDynamic) {
  let cost = stats.cost_usd || 0;
  for (const r of g.runs || []) {
    if (inFlightStatus(r.status) && r.progress?.cost_usd > 0) cost += r.progress.cost_usd;
  }
  return cost;
}

/** "43s", "4m 07s" — elapsed wall clock that ticks without jitter. */
function fmtElapsed(ms: WebDynamic) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * A story's status chip, in the run vocabulary the whole console shares. Each
 * outcome word is a term of art, so the chip carries its own definition as a
 * tooltip — where the word appears, instead of a standing legend under the
 * table.
 */
function storyChip(r: WebDynamic) {
  if (inFlightStatus(r.status)) return statusChip("running", modeDoing(r.mode));
  if (r.status === "queued") return statusChip("neutral", "queued");
  if (r.end_reason === "timeout") return statusChip("fail", "timed out", "the story ran out of its time budget before finishing");
  // infra/canceled/lost never wear the mode word: "recorded" on a run that died
  // before it started reads as work that happened.
  const tone = chipStatus(r);
  return statusChip(tone, neverRanStatus(r.status)
    ? didNotRunLabel(r.status, { started: !!r.started_at })
    : modeLabel(r.mode, r), outcomeGloss(r.status === "canceled" ? "canceled" : tone));
}

// ---------- live plumbing ----------

// One live subscription at a time; the router's onPageLeave runs stopLive on
// navigation, and re-invoking the page (e.g. after cancel) stops the old one.
let live: WebDynamic = null;
function stopLive() {
  if (!live) return;
  live.sub?.stop();
  clearInterval(live.tick);
  clearTimeout(live.refetchTimer);
  live = null;
}

/** Plain-words cold-start narration (UX: never a frozen spinner). Words, not a
    node: the row's now-line and the expanded block frame them differently. */
function narration(group: WebDynamic, feedNote: WebDynamic, stats: WebDynamic) {
  if (group.status === "queued" || feedNote === "provisioning") {
    return "provisioning capacity… waiting for a runner to connect";
  }
  if (group.status === "running" && stats.queued === stats.total) {
    return "executor connected — signing in and starting cases…";
  }
  if (group.status === "canceled") return "canceled";
  if (group.status === "done") {
    // Both launch-and-follow personas had to assemble the sign-off verdict
    // from table rows — say it in plain words, and never let "N passed" imply
    // a clean pass while other checks failed or never ran.
    const neverRan = stats.infra + stats.lost + stats.canceled;
    const verdict = !stats.total ? null
      : stats.pass === stats.total ? "a clean pass"
      : stats.fail ? "not a clean pass — at least one journey failed"
      : neverRan ? `not a clean pass — ${neverRan} ${neverRan === 1 ? "check" : "checks"} never ran`
      : null;
    return `finished — ${outcomeWords(stats) || "no cases ran"}${verdict ? ` · ${verdict}` : ""}`;
  }
  return null;
}

const isFinished = (r: WebDynamic) => ["pass", "fail", "infra", "explored"].includes(r.status);

// ---------- launcher + admin ledger ----------

// The launcher previews before it launches: what
// will run (personas fanned out, planned mode per story), an HONEST cost line
// (history-based estimate or "no history yet", never a made-up $0.00), and the
// discovery/staging guardrail surfaced as an explanation, not a server error.

// Mode is a binary, and each option names its consequence directly. The dialog
// used to carry a second, seemingly independent control —
// "Re-record from scratch (ignore saved paths)" — for the wire's `refresh`.
// It was not independent: both dispatcher.js plannedMode and core decideRecord
// short-circuit on refresh BEFORE reading mode, so "Auto + checked" ran exactly
// like "agent + checked" while the select still said Auto. Worse, it was named
// for what it shared with agent mode (re-recording) rather than for what it
// alone did (replacing the saved paths). Agent mode now carries refresh, and
// the four combinations that meant three behaviors are two that mean two.
//
// A binary whose two halves cost different money is the wrong job for a
// dropdown: the alternative stays folded away, so the expensive choice is made
// without ever seeing what the cheap one said. Both options are on the surface,
// each naming what it does, and the chosen one spells out its consequence.
const MODE_OPTIONS: WebDynamic = [
  { value: "auto", name: "Auto", gist: "Replay saved paths" },
  { value: "agent", name: "Agent", gist: "Re-record every story" },
];
const MODE_NOTE: WebDynamic = {
  auto: "Each story replays its saved path. Stories with no path, or whose text changed, are recorded by the agent.",
  agent: "Slower and costlier: the agent drives every story, and each recording replaces that story's saved path — discarding a changed path still waiting for review.",
};
export function launchModal(projectKey: WebDynamic, suites: WebDynamic = null, preselectSuiteId: WebDynamic = null, opts: WebDynamic = {}) {
  const close = formModal("Launch a run", () => {
    // Scope: launched from a story row or the story editor, the run covers just
    // those ids (server `selection.ids`). That is context, not a control — the
    // page you came from chose it, and the dialog used to answer it with a "Run
    // all stories" button that quietly turned a one-story launch into a
    // whole-suite one. Widening is a different launch, one click away.
    // A scoped launch always names its suite: ids from one suite mean nothing
    // in another, so scope without a fixed suite is dropped.
    const suiteFixed = preselectSuiteId != null;
    const onlyIds = suiteFixed && Array.isArray(opts.ids) && opts.ids.length ? [...opts.ids] : null;
    const suiteOption = (s: WebDynamic) => h("option", {
      value: s.id,
      selected: String(s.id) === String(preselectSuiteId) || undefined,
    }, s.name || s.slug);
    const suite = h("select", { onchange: onSuiteChange },
      ...(suites ? suites.map(suiteOption) : [h("option", { value: "" }, "Loading…")]));
    if (suiteFixed && suites) suite.value = String(preselectSuiteId);
    const ring = h("select", { onchange: onRingChange }, h("option", {}, "Loading…"));
    const maxSteps = h("input", {
      type: "number", min: "1", step: "1", placeholder: "Default",
      oninput: onLimitInput,
    });
    const timeoutSeconds = h("input", {
      type: "number", min: "1", step: "1", placeholder: "Default",
      oninput: onLimitInput,
    });
    // A suite/story launcher inherits its suite from the page: say so under the
    // title, where the rest of the console puts context, instead of spending a
    // form control on a value nobody can change.
    const contextSlot = suiteFixed ? h("p.launch-context", {}) : null;
    const targetSlot = h("div.launch-target", {});
    // Where this run would be PLACED, beside where it would point. Under pool
    // placement a run goes to a machine somebody has to have started, and the
    // failure mode this line exists to prevent is a run that sits on the board
    // for ten minutes and then fails naming labels nothing served.
    const placementSlot = h("div.launch-placement", {});
    const modelsSlot = h("p.launch-models", {});
    const warnSlot = h("div.launch-warnings", {});
    const planSlot = h("div.launch-plan", {}, h("span.dim", {}, "sizing this run…"));
    const limitsLabel = h("span", {}, "Limits");
    const launchBtn = h("button.btn.primary", {
      type: "submit",
      disabled: suiteFixed && !suites ? true : undefined,
    }, "Launch");
    let seq = 0;
    let debounce: WebDynamic;
    let rings: WebDynamic = [];
    let groups: WebDynamic = [];
    let ringTouched = false;
    let modeValue = "auto";
    // The fleet, for the placement line. Only on a deployment that HAS a fleet:
    // elsewhere there is no runner to be checked in and the line would be
    // machinery talking about itself. Read through the shared cache, so opening
    // the dialog twice in a minute costs one request, and never polled.
    let runners: WebDynamic = [];

    const modeBtns = MODE_OPTIONS.map((o: WebDynamic) => h("button.launch-mode", {
      type: "button", role: "radio", onclick: () => setMode(o.value), onkeydown: onModeKey,
    }, h("span.launch-mode-name", {}, o.name), h("span.launch-mode-gist", {}, o.gist)));
    const modeGroup = h("div.launch-modes", { role: "radiogroup", "aria-label": "Run mode" }, ...modeBtns);
    const modeNote = h("p.launch-mode-note", {});

    paintContext();
    paintMode();
    paintLimits();
    if (!suites) loadSuites();
    loadRings();
    return h("form.launch-form", { onsubmit: submit },
      contextSlot,
      suiteFixed ? fld("Ring", ring) : h("div.launch-where", {}, fld("Suite", suite), fld("Ring", ring)),
      targetSlot,
      placementSlot,
      h("div.field", {},
        h("div.field-label", {}, "Run mode"),
        modeGroup,
        modeNote,
        modelsSlot,
      ),
      // Per-story budgets are an override of settings that already have an
      // answer. Folded away, with that answer in the summary, so the dialog
      // opens on the two decisions that change what this run costs and touches.
      h("details.advanced.launch-limits", {},
        h("summary", {}, limitsLabel),
        h("div.launch-limits-fields", {},
          fld("Max steps per story", maxSteps),
          fld("Timeout per story (seconds)", timeoutSeconds),
        ),
      ),
      warnSlot,
      h("div.modal-actions.split.launch-actions", {},
        planSlot,
        h("div.right", {},
          h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"),
          launchBtn),
      ),
    );
    function selection() {
      // Mode is the whole story here: recording without keeping what you
      // recorded is a run nobody wants, so agent mode always saves.
      const max: WebDynamic = maxSteps.value === "" ? null : Number(maxSteps.value);
      const timeout: WebDynamic = timeoutSeconds.value === "" ? null : Math.round(Number(timeoutSeconds.value) * 1000);
      return {
        mode: modeValue,
        refresh: modeValue === "agent",
        ...(onlyIds ? { ids: onlyIds } : {}),
        ...(Number.isSafeInteger(max) && max > 0 ? { max_steps: max } : {}),
        ...(Number.isSafeInteger(timeout) && timeout > 0 ? { timeout_ms: timeout } : {}),
      };
    }
    function paintContext() {
      if (!contextSlot) return;
      const found = suites?.find((s: WebDynamic) => String(s.id) === String(preselectSuiteId));
      if (suites && !found) {
        launchBtn.disabled = true;
        return mount(contextSlot, "Suite unavailable");
      }
      mount(contextSlot,
        found ? (found.name || found.slug) : "Loading…",
        onlyIds ? " · only " : null,
        onlyIds ? (onlyIds.length === 1 ? h("span.id", {}, onlyIds[0]) : `${onlyIds.length} stories`) : null);
    }
    function setMode(v: WebDynamic) {
      if (v === modeValue) return;
      modeValue = v;
      paintMode();
      schedulePreview();
    }
    function paintMode() {
      modeBtns.forEach((b: WebDynamic, i: WebDynamic) => {
        const on = MODE_OPTIONS[i].value === modeValue;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
      });
      modeNote.textContent = MODE_NOTE[modeValue];
      modeNote.classList.toggle("costly", modeValue === "agent");
    }
    // Arrow keys move within a radio group; Tab leaves it. Without this the
    // group is reachable but not operable from the keyboard.
    function onModeKey(e: WebDynamic) {
      const at = MODE_OPTIONS.findIndex((o: WebDynamic) => o.value === modeValue);
      const step: WebDynamic = ["ArrowRight", "ArrowDown"].includes(e.key) ? 1
        : ["ArrowLeft", "ArrowUp"].includes(e.key) ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = (at + step + MODE_OPTIONS.length) % MODE_OPTIONS.length;
      setMode(MODE_OPTIONS[next].value);
      modeBtns[next].focus();
    }
    function onLimitInput() {
      paintLimits();
      schedulePreview();
    }
    /** The disclosure says what the folded fields are set to, so a collapsed
        section never hides the budget this run will actually use. */
    function paintLimits() {
      const steps = maxSteps.value || maxSteps.placeholder;
      const secs = timeoutSeconds.value || timeoutSeconds.placeholder;
      const custom = maxSteps.value !== "" || timeoutSeconds.value !== "";
      const known = steps !== "Default" && secs !== "Default";
      limitsLabel.textContent = known
        ? `Limits · ${steps} steps · ${secs}s per story${custom ? " · overridden" : ""}`
        : `Limits · each story's own${custom ? " · overridden" : ""}`;
    }
    function onSuiteChange() {
      // A different suite belongs to a different application, so its rings are
      // different ones. Repaint even when the person has already chosen: their
      // choice can belong to an application that no longer applies.
      paintRings();
      schedulePreview();
    }
    function onRingChange() {
      ringTouched = true;
      schedulePreview();
    }
    async function loadSuites() {
      try {
        ({ items: suites } = await api.cached(`/projects/${projectKey}/suites`, { ttl: 15_000 }));
        mount(suite, ...suites.map(suiteOption));
        if (suiteFixed) {
          suite.value = String(preselectSuiteId);
          paintContext();
        }
        // preview only once the rings are in — before that the ring select's
        // "Loading…" placeholder would ride the request as a ring id
        if (rings.length) {
          if (!ringTouched) paintRings();
          preview();
        }
      } catch (err: WebDynamic) { toastError(err); }
    }
    async function loadRings() {
      try {
        // Recent runs are how we know where this suite usually goes. Best
        // effort: without them the default falls through to the safety rules.
        const [{ items }, recent, fleet] = await Promise.all([
          api.cached(`/projects/${projectKey}/applications?include=rings`),
          api.get(`/projects/${projectKey}/run-groups?limit=50`).catch(() => ({ items: [] })),
          state.me?.capabilities?.pool_dispatch === true
            ? api.cached(`/projects/${projectKey}/runners`, { ttl: 15_000 }).catch(() => ({ items: [] }))
            : Promise.resolve({ items: [] }),
        ]);
        rings = (items || []).flatMap((a: WebDynamic) =>
          (a.rings || []).map((r: WebDynamic) => ({ ...r, application: a })));
        groups = recent.items || [];
        runners = fleet.items || [];
        paintRings();
        preview();
      } catch (err: WebDynamic) { toastError(err); }
    }

    /** The chosen suite's application — its binding, fixed at creation. */
    function suiteApplication() {
      return suites?.find((s: WebDynamic) => String(s.id) === String(suite.value))?.application_id ?? null;
    }

    /**
     * The rings this suite may launch against: its own application's, and only
     * those. Another application's ring is not a choice here — the server
     * refuses it, and offering it would be offering a mistake.
     */
    function visibleRings() {
      const applicationId = suiteApplication();
      if (!applicationId) return [];
      return rings.filter((r: WebDynamic) => r.application_id === applicationId);
    }

    function paintRings() {
      const visible = visibleRings();
      // Keep an explicit choice when the new suite can still use it; otherwise
      // fall back to the safe default rather than leaving a ring selected that
      // belongs to an application this suite has nothing to do with.
      const keep = ringTouched && visible.some((r: WebDynamic) => r.id === ring.value);
      const chosen = keep ? ring.value : defaultRingId(visible, { suiteId: suite.value, groups });
      // Name the host each ring resolves to. Picking "production" when you meant
      // localhost was the silent-wrong-target trap, and a key alone never
      // carried enough to notice it.
      const driver = visible[0]?.application?.driver || "web";
      mount(ring, ...visible.map((r: WebDynamic) =>
        h("option", { value: r.id, selected: r.id === chosen || undefined }, ringOptionLabel(r, driver))));
    }
    function schedulePreview() {
      clearTimeout(debounce);
      debounce = setTimeout(preview, 200);
    }
    async function preview() {
      const mySeq = ++seq;
      if (!suite.value || !ring.value) return;
      try {
        const p = await api.post(`/projects/${projectKey}/run-groups/preview`, {
          suite_id: suite.value,
          ring_id: ring.value,
          selection: selection(),
        });
        if (mySeq === seq) paintPreview(p);
      } catch (err: WebDynamic) {
        if (mySeq !== seq) return;
        // Preview is a nicety — launching still enforces everything server-side.
        // A 400 is the server explaining why this combination cannot run
        // (an uncommitted suite, say), which belongs with the other refusals.
        mount(targetSlot);
        mount(modelsSlot);
        mount(warnSlot, err.status === 400 ? h("div.preview-warn", {}, String(err.message)) : null);
        mount(planSlot, h("span.dim", {}, err.status === 400 ? "nothing to size yet" : "preview unavailable"));
        launchBtn.disabled = false;
      }
    }
    function paintPreview(p: WebDynamic) {
      const PLAN_WORD: WebDynamic = { record: "record", act: "check", explore: "explore" };
      const byMode: WebDynamic = {};
      for (const c of p.cases) byMode[c.mode] = (byMode[c.mode] || 0) + 1;
      const parts = Object.entries(byMode).map(([m, n]) => `${n} to ${PLAN_WORD[m] ?? m}`);
      // Fan-out runs are `story@persona` ids; every case carries a persona
      // field (core defaults journeys to "tester"), so count by id shape.
      const personas = p.cases.filter((c: WebDynamic) => c.id.includes("@")).length;
      const est = p.estimate?.est_total_usd;
      const blocked = p.discovery.runs > 0 && !p.discovery.allowed;
      launchBtn.disabled = blocked || p.total_runs === 0;
      const placeholders = launchLimitPlaceholders(p.cases);
      if (maxSteps.value === "") maxSteps.placeholder = placeholders.maxSteps;
      if (timeoutSeconds.value === "") timeoutSeconds.placeholder = placeholders.timeoutSeconds;
      paintLimits();

      // Where this run points, said immediately under the control that decides
      // it: picking "production" when you meant localhost was the
      // silent-wrong-target trap. The ring owns the URL and the server resolves
      // it, so there is no precedence left to explain — for mobile there is no
      // URL at all, and the honest sentence is who supplies the build.
      const t = p.target || {};
      const chosenRing = rings.find((r: WebDynamic) => String(r.id) === String(ring.value));
      const target = launchTargetWords(t);
      targetSlot.className = `launch-target${t.resolved_base_url || t.build_supplied_by_runner ? "" : " warn"}`;
      mount(targetSlot,
        h("span.preview-key", {}, "Target"),
        h("span.launch-target-main", {},
          h("span.launch-target-url", {}, target.where),
          h("span.launch-source", {}, target.source)),
      );

      // Placement, said out loud before anyone spends money: which labels this
      // run needs, whose decision that was, and whether anything advertising
      // them is actually checked in. All of it from what this dialog already
      // holds — the preview and the runner list — never a new poll.
      const placement = p.placement || null;
      const readiness = placement && state.me?.capabilities?.pool_dispatch === true
        ? placementReadiness({
            labels: placement.runner_labels || [],
            runners,
            windowS: state.me?.capabilities?.runner_check_in_window_s ?? 120,
          })
        : null;
      placementSlot.className = `launch-placement${readiness && readiness.state !== "ready" ? " warn" : ""}`;
      mount(placementSlot, readiness
        ? h("span", {},
            h("span.preview-key", {}, "Runs on"),
            h("span.launch-target-main", {},
              h("span.launch-target-url", {},
                placement.runner_labels?.length
                  ? `a runner advertising ${placement.runner_labels.join(", ")}`
                  : "any runner in this project"),
              h("span.launch-source", {},
                placement.labels_source === "launch" ? "pinned by this launch" : "the ring's labels")))
        : null);

      // Which models the launch will use, and whose choice each one was —
      // server-resolved (suite beats project beats engine default).
      mount(modelsSlot, p.models
        ? ["actor_model", "grader_model"]
            .map((k) => `${k === "actor_model" ? "actor" : "grader"} ${p.models[k].value}${p.models[k].source !== "default" ? ` (${p.models[k].source})` : ""}`)
            .join(" · ") +
          (p.models.actor_model.source === "default" && p.models.grader_model.source === "default" ? " · engine defaults" : "")
        : null);

      // What Launch will do and what it will cost, beside the button that does
      // it — the two facts every launcher checks last.
      const planDetail: WebDynamic = [
        parts.length ? parts.join(" · ") : null,
        personas ? `${personas} persona ${personas === 1 ? "run" : "runs"}` : null,
      ].filter(Boolean).join(" · ");
      const coverage = est != null && p.estimate.known_runs < p.total_runs
        ? ` · from ${p.estimate.known_runs} of ${p.total_runs} past ${p.total_runs === 1 ? "run" : "runs"}`
        : "";
      mount(planSlot,
        h("div.launch-plan-runs", {},
          h("strong", {}, p.total_runs ? `${p.total_runs} ${p.total_runs === 1 ? "run" : "runs"}` : "No stories"),
          planDetail ? ` · ${planDetail}` : null),
        // Never a made-up $0.00: with no history the estimate says so.
        h("div.launch-plan-cost", {}, est != null ? `est. ${fmtCost(est)}${coverage}` : "no cost history yet"),
      );

      // A run nothing can claim is a ten-minute wait ending in a failure, and
      // everything needed to say so is already on this screen. It is a warning,
      // not a block: a runner started thirty seconds from now still takes it.
      const placementWarn = readiness && readiness.state !== "ready" && readiness.state !== "busy"
        ? h("div.preview-warn", {},
            readiness.message, " ",
            hasRole(state.projectByKey.get(projectKey)?.id, "developer")
              ? link(`/p/${projectKey}/settings/runners`, "Set up a runner")
              : null)
        : null;
      mount(warnSlot,
        placementWarn,
        // Discovery is blocked on a non-discovery ring, but a plain journey run
        // against production is allowed — and is worth saying out loud, because
        // these runs really click the buttons they find.
        chosenRing && isProdRing(chosenRing) && !blocked
          ? h("div.preview-warn", {}, `${chosenRing.key} ring — this run uses a real browser and can make real changes.`)
          : null,
        blocked
          ? h("div.preview-warn", {},
              `This selection includes ${p.discovery.runs} discovery ${p.discovery.runs === 1 ? "story" : "stories"}, and this ring doesn't allow discovery. ` +
              `Discovery agents really click buy, delete and submit — pick a staging ring, or enable "Allow discovery studies" for it under Applications. `,
              // one-click way out: both launch-and-follow personas read this
              // warning and then hand-hunted the select for the allowed ring
              ...visibleRings().filter((r: WebDynamic) => r.discovery_allowed && String(r.id) !== ring.value)
                .slice(0, 2)
                // dispatch change (not just set .value) so the enhanced
                // dropdown's button relabels too
                .map((r: WebDynamic) => h("button.btn.btn-sm", { type: "button", style: "margin-left:6px", onclick: () => { ring.value = r.id; ring.dispatchEvent(new Event("change")); preview(); } }, `Use ${r.key}`)))
          : null,
        p.total_runs === 0 ? h("div.preview-warn", {}, "This selection matches no stories.") : null,
      );
    }
    async function submit(e: WebDynamic) {
      e.preventDefault();
      try {
        const out = await api.post(`/projects/${projectKey}/run-groups`, {
          suite_id: suite.value,
          ring_id: ring.value,
          selection: selection(),
        });
        close();
        toast("Run launched", "following it now", "ok");
        navigate(`/p/${projectKey}/runs/${out.run_group.id}`);
      } catch (err: WebDynamic) { toastError(err); }
    }
  });
}

async function retryGroup(
  projectKey: WebDynamic,
  group: WebDynamic,
  ringName: WebDynamic,
  btn: WebDynamic,
) {
  const stories = retryableStoryCount(group);
  const target = ringName ? ` against ${ringName}` : "";
  const ok = await confirmModal({
    title: "Retry this run?",
    body: `Retries the ${stories} ${stories === 1 ? "story" : "stories"} that never started${target}, inside this run. Stories that already produced a verdict stay untouched. Only one retry can be active, and it may incur model cost.`,
    confirmLabel: "Retry in place",
    cancelLabel: "Keep this result",
  });
  if (!ok) return;
  if (btn) { btn.disabled = true; btn.textContent = "Retrying…"; }
  try {
    await api.post(`/run-groups/${group.id}/retry`, {});
    toast("Run retrying", `${stories} ${stories === 1 ? "story" : "stories"} queued`, "ok");
    runsPage(projectKey, group.id);
  } catch (err: WebDynamic) {
    toastError(err);
    if (btn) { btn.disabled = false; btn.textContent = "Retry"; }
  }
}

// Synthesize a finished discovery group into cited findings. New claims land
// in Findings needing review (exact recurrences attach themselves to the
// finding they already belong to); the button hands off to that view.
async function synthesizeGroup(projectKey: WebDynamic, groupId: WebDynamic, exploredCount: WebDynamic, btn: WebDynamic) {
  // This spends model calls. Consolidation states its scope and cost before it
  // runs and this didn't, so it says the same kind of thing: what it reads,
  // what it produces, and that a person still decides.
  const ok = await confirmModal({
    title: "Synthesize findings from this run?",
    body: `Reads the ${exploredCount} discovery ${exploredCount === 1 ? "trajectory" : "trajectories"} in this run and files the defects it can cite as findings needing review. This costs model calls. Nothing becomes a confirmed finding without a person.`,
    confirmLabel: "Synthesize",
  });
  if (!ok) return;
  if (btn) { btn.disabled = true; btn.textContent = "Synthesizing…"; }
  try {
    const out = await api.post(`/run-groups/${groupId}/synthesize-findings`, {});
    const queued = (out?.created || 0) + (out?.suggested || 0);
    const attached = (out?.appended || 0) + (out?.absorbed || 0);
    const detail: WebDynamic = [
      queued ? `${queued} new report${queued === 1 ? "" : "s"} to review` : null,
      attached ? `${attached} recurrence${attached === 1 ? "" : "s"} absorbed by known findings` : null,
    ].filter(Boolean).join(" · ") || "nothing new from this study";
    toast("Synthesis complete", detail, "ok");
    navigate(queued ? `/p/${projectKey}/findings?filter=review` : `/p/${projectKey}/findings`);
  } catch (err: WebDynamic) {
    toastError(err);
    if (btn) { btn.disabled = false; btn.textContent = "Synthesize findings"; }
  }
}

async function cancelGroup(projectKey: WebDynamic, groupId: WebDynamic, rows: WebDynamic = []) {
  const live = rows.filter((r: WebDynamic) => ["queued", "running", "uploading"].includes(r.status)).length;
  const done = rows.filter((r: WebDynamic) => isFinished(r)).length;
  const ok = await confirmModal({
    title: "Cancel this run?",
    body: `${live ? `${live} ${live === 1 ? "story is" : "stories are"} still running and will stop where they are. ` : ""}` +
      `${done ? `The ${done} already finished ${done === 1 ? "keeps its" : "keep their"} evidence. ` : ""}` +
      "Cancelling can't be undone — restarting means paying for the whole run again.",
    confirmLabel: "Cancel the run",
    cancelLabel: "Keep running",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.post(`/run-groups/${groupId}/cancel`, {});
    toast("Run canceled", "", "ok");
    runsPage(projectKey, groupId);
  } catch (err: WebDynamic) { toastError(err); }
}

const fld = formField;
