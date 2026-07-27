// Story run history (UX Suite → TREND): the score/duration trend for one
// story, movement chips vs previous/median, and the regression/improved badge
// — all through the browser-safe core movement export bundled into the app
// (principle 2: the UI must not invent its own judgment).
// History entries come from the viewer adapter's history.json, the same §13
// projection the embedded viewer's sparkline reads.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { link } from "../lib/router.js";
import { renderFrame, page } from "../lib/shell.js";
import { state } from "../lib/state.js";
import { statusChip, emptyState, errorState, sparkline } from "../lib/ui.js";
import { modeLabel, chipStatus, fmtMs, signedMs, fmtCost, ago } from "../lib/labels.js";
import { didNotRunLabel } from "../lib/vocab.js";
import { movement as computeMovement } from "@playtest/core/browser/movement";

/** Name a link for assistive tech; the visible text stays as it is. */
const labelled = (el: WebDynamic, name: WebDynamic) => { el.setAttribute("aria-label", name); return el; };

export async function storyHistoryPage(projectKey: WebDynamic, slug: WebDynamic, storyId: WebDynamic) {
  const main = renderFrame({ projectKey, nav: "suites" });
  const project = state.projectByKey.get(projectKey);
  if (!project) return mount(main, page({ title: storyId, body: emptyState("Not found", "No such project.") }));
  mount(main, page({ title: storyId, body: h("div.dim", {}, "Loading…") }));

  let history, runRows = [];
  try {
    // Runs are story-scoped (case id is `<story>@<persona>` for discovery
    // fan-outs; the runs table keys the shared base story) so the deep-link
    // map can't age out of a recency window on busy projects.
    const baseStory = storyId.split("@")[0];
    [history, { items: runRows }] = await Promise.all([
      api.get(`/projects/${projectKey}/view/history.json?case=${encodeURIComponent(storyId)}`),
      api.get(`/runs?project=${encodeURIComponent(project.id)}&story=${encodeURIComponent(baseStory)}&limit=200`),
    ]);
  } catch (err: WebDynamic) {
    return mount(main, page({ title: storyId, body: errorState(err, () => storyHistoryPage(projectKey, slug, storyId)) }));
  }

  // history.json only knows runs that uploaded a bundle (manifest present).
  // Runs that died first — infra, lost, canceled — exist only as platform run
  // rows, and the suite page's trend pips DO count them; hiding them here made
  // the two surfaces disagree ("trend shows failures, history shows one run").
  const inHistory: WebDynamic = new Set(history.map((e: WebDynamic) => e.run_id));
  const extra = runRows
    .filter((r: WebDynamic) => r.case_id === storyId && !inHistory.has(r.run_id)
      && ["pass", "fail", "infra", "explored", "canceled", "lost"].includes(r.status))
    .map((r: WebDynamic) => ({
      run_id: r.run_id,
      status: r.status,
      mode: r.mode,
      healed: r.healed,
      steps: r.totals?.steps ?? null,
      duration_ms: r.duration_ms ?? null,
      score: r.score ?? null,
      cost_usd: r.totals?.cost_usd ?? null,
      started_at: r.started_at,
      error: r.error || null,
      path: null, // no bundle — nothing for the standalone viewer to replay
    }));
  // Platform run rows map a core run onto its db id + group for deep links;
  // history entries older than the platform (or pruned rows) fall back to the
  // embedded viewer by core path.
  const byCore: WebDynamic = new Map(runRows.map((r: WebDynamic) => [`${r.run_id}|${r.case_id}`, r]));

  // WHEN comes from the platform run row when there is one. history.json carries
  // the bundle MANIFEST's timestamp, which is the trajectory's own clock — for
  // replayed or backdated bundles that is not when the run happened, and this
  // page was the only surface reading it, so it disagreed with the suite table
  // and the runs list about the same run. One source, everywhere.
  for (const e of history) {
    const platformRun = byCore.get(`${e.run_id}|${storyId}`);
    if (platformRun?.started_at) e.started_at = platformRun.started_at;
  }
  history = [...history, ...extra]
    .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));

  const crumbs: WebDynamic = [
    link(`/p/${projectKey}`, "Suites"), " / ",
    link(`/p/${projectKey}/suites/${slug}`, slug), " / ",
    link(`/p/${projectKey}/suites/${slug}/stories/${encodeURIComponent(storyId)}`, storyId), " / ", "Run history",
  ];
  if (!history.length) {
    return mount(main, page({
      crumbs, title: "Run history", sub: storyId,
      body: emptyState("No runs yet", "Launch this story's suite and each run will land here with its trend."),
    }));
  }

  const current = history.at(-1);
  const mv = computeMovement(history, current);

  const graded = history.filter((e) => e.score != null);
  const useScore = graded.length >= 2;
  // Entries without a duration (infra/lost) are omitted, not plotted as 0.
  const series = useScore ? graded.map((e) => e.score) : history.map((e) => e.duration_ms).filter((v) => v != null);

  // The badge judges the SCORE. The chips beside it are duration and steps, and
  // with nothing separating them a run that got 158ms faster read as filed
  // under "regression". Score verdict on one line, movement on the next.
  const verdict: WebDynamic = [];
  if (mv?.badge) {
    verdict.push(h(`span.status.${mv.badge === "regression" ? "fail" : "pass"}`,
      { title: "The grader's score moved. Duration and steps are below." },
      h("span.glyph", {}, mv.badge === "regression" ? "▼" : "▲"), `score ${mv.badge}`));
  }
  if (mv?.scoreVsLastGraded) {
    verdict.push(h("span.chip", { title: "Score vs the last graded comparable run" },
      `${mv.scoreVsLastGraded > 0 ? "+" : "−"}${Math.abs(mv.scoreVsLastGraded)} vs last graded`));
  }
  if (mv?.statusStreak) verdict.push(h("span.chip", {}, mv.statusStreak));

  const movement: WebDynamic = [];
  if (mv?.duration?.prev != null) movement.push(h("span.chip", { title: "Duration vs previous comparable run" }, `${signedMs(mv.duration.prev)} vs prev`));
  if (mv?.duration?.med != null) movement.push(h("span.chip", { title: "Duration vs the median of recent comparable runs" }, `${signedMs(mv.duration.med)} vs median`));
  if (mv?.steps?.prev != null && mv.steps.prev !== 0) movement.push(h("span.chip", {}, `${mv.steps.prev > 0 ? "+" : "−"}${Math.abs(mv.steps.prev)} steps vs prev`));

  const trend = h("div.card.pad", {},
    h("div.label", {}, useScore ? "Score trend" : "Duration trend"),
    h("div", { style: "display:flex;align-items:center;gap:14px;margin-top:8px;flex-wrap:wrap" },
      sparkline(series, { w: 220, hgt: 36 }),
      verdict.length ? h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center" }, ...verdict) : null,
    ),
    movement.length
      ? h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px" },
          h("span.faint", { style: "font-size:11.5px" }, "How it ran:"), ...movement)
      : null,
    useScore ? null : h("div.faint", { style: "font-size:11.5px;margin-top:6px" }, "Scores appear once two or more runs are graded."),
  );

  const rows: WebDynamic = [...history].reverse().map((e) => {
    const platformRun = byCore.get(`${e.run_id}|${storyId}`);
    // infra/canceled/lost never wear the mode word — "recorded" on a run that
    // died before starting reads as work that never happened (same rule as the
    // group dashboard rows).
    const label: WebDynamic = ["canceled", "lost", "infra"].includes(e.status)
      ? didNotRunLabel(e.status, { started: !!e.started_at })
      : modeLabel(e.mode, e);
    // Every row's action is called "Open"; the label says which run. It uses the
    // exact time, not the relative one — four runs on the same day all read
    // "44 d ago", which distinguishes nothing.
    const when = e.started_at ? new Date(e.started_at).toLocaleString() : "an unknown time";
    const open = platformRun
      ? labelled(link(`/p/${projectKey}/runs/${platformRun.run_group_id}/${platformRun.id}`, h("span.btn.btn-sm", {}, "Open")),
          `Open the ${label} run from ${when}`)
      : e.path
        ? h("a.btn.btn-sm", { href: `/api/v1/projects/${encodeURIComponent(projectKey)}/view/?run=${encodeURI(e.path)}`, target: "_blank", rel: "noreferrer" }, "Viewer ↗")
        : null;
    return h("tr", {},
      h("td", {}, statusChip(chipStatus(e), label),
        e.error ? h("div.desc", { title: e.error }, String(e.error).slice(0, 120)) : null),
      h("td.dim", {}, e.steps != null ? String(e.steps) : "—"),
      h("td.dim", {}, e.duration_ms != null ? fmtMs(e.duration_ms) : "—"),
      h("td.dim", { title: "Grader score — a trend, not a verdict" }, e.score != null ? String(e.score) : "—"),
      h("td.dim", {}, e.cost_usd != null ? fmtCost(Number(e.cost_usd)) : "—"),
      h("td.dim", {}, e.started_at ? ago(e.started_at) : "—"),
      h("td", { style: "text-align:right" }, open),
    );
  });

  mount(main, page({
    crumbs,
    title: "Run history",
    sub: `${storyId} · ${history.length} ${history.length === 1 ? "run" : "runs"}`,
    body: h("div.stack", {},
      trend,
      h("div.card", {}, h("table.rows", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Run"), h("th", {}, "Steps"), h("th", {}, "Duration"), h("th", {}, "Score"), h("th", {}, "Cost"), h("th", {}, "When"), h("th", {}))),
        h("tbody", {}, ...rows),
      )),
    ),
  }));
}
