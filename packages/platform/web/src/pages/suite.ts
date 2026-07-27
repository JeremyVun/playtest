// Suites index + a suite's stories list. The stories list is the GET /suites/:s/cases
// projection — the one resolver (UX Suite screen). NEXT RUN uses the core list words
// (record/check/explore). LAST and TREND come from the projection's `last`/`recent`
// decoration (one window query server-side, no per-story history reads).
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { link, navigate } from "../lib/router.js";
import { renderFrame, page } from "../lib/shell.js";
import { state, hasRole, hasLlm, LLM_UNAVAILABLE } from "../lib/state.js";
import { toast, toastError, emptyState, errorState, statusChip, nextRunChip, tag, confirmModal, overflowMenu, srOnly } from "../lib/ui.js";
import { clamp, ago } from "../lib/labels.js";
import { didNotRunLabel } from "../lib/vocab.js";
import { parseYaml } from "../lib/caseform.js";
import { storyFindingSummary, findingChipDescriptors } from "../lib/finding-chips.js";
import { newSuiteModal } from "./projects.js";
import { launchModal } from "./runs.js";

/**
 * "Help me draft" — opens the story editor with the drafting modal. On a
 * deployment with no model gateway it is a disabled button that names the
 * reason, rather than a live link into a modal whose first send fails.
 */
function draftAction(projectKey: WebDynamic, slug: WebDynamic) {
  if (!hasLlm()) {
    return h("button.btn", { disabled: true, title: LLM_UNAVAILABLE }, "Help me draft");
  }
  return link(`/p/${projectKey}/suites/${slug}/new?assist=1`, h("span.btn", {}, "Help me draft"));
}

/**
 * Resolve a suite row by its slug within a project (one GET, no list scan).
 * `include` ("cases,defaults") folds those onto the row — see the hosted
 * contract's suite-by-slug include — so a page's first paint is one request.
 */
export async function getSuiteBySlug(projectKey: WebDynamic, slug: WebDynamic, include: WebDynamic = null) {
  try {
    return await api.get(`/projects/${projectKey}/suites/${encodeURIComponent(slug)}${include ? `?include=${include}` : ""}`);
  } catch (err: WebDynamic) {
    if (err.status === 404) return null;
    throw err;
  }
}

export async function suiteStories(projectKey: WebDynamic, slug: WebDynamic) {
  const main = renderFrame({ projectKey, nav: "suites" });
  const project = state.projectByKey.get(projectKey);

  if (!slug) return renderSuitesIndex(main, projectKey, project);

  mount(main, page({ title: slug, body: h("div.dim", {}, "Loading…") }));
  let suite: WebDynamic, cases, findings = [], defaultsFile = null;
  try {
    // One stage: the suite lookup folds in its cases and defaults file
    // (?include=cases,defaults), and the findings queries are project-scoped,
    // so nothing here waits on anything else. Findings are joined per story:
    // a green LAST chip next to an active major finding was the round-3
    // orient trust-breaker ("the app did not reconcile that contradiction in
    // one place"). Two finding fetches so a long resolved archive can never
    // crowd live work out of the 100-row page. Best-effort: the table must
    // render even if findings fail.
    ([suite, findings] = await Promise.all([
      getSuiteBySlug(projectKey, slug, "cases,defaults"),
      Promise.all([
        api.get(`/projects/${projectKey}/findings?state=new,reopened,accepted&limit=100`),
        // Only auto-resolved closes matter here — the calm receipt chip.
        api.get(`/projects/${projectKey}/findings?state=resolved&limit=100`).catch(() => ({ items: [] })),
      ]).then(
        ([live, closed]) => [...live.items, ...closed.items.filter((f: WebDynamic) => f.auto_resolved_at)],
        () => [],
      ),
    ]));
    if (!suite) {
      return mount(main, page({
        crumbs: [link(`/p/${projectKey}`, "Suites")],
        title: "Suite not found",
        body: emptyState("No suite called that",
          `This project has no suite named "${slug}". It may have been deleted, or the link may be out of date.`,
          h("div.empty-actions", {}, link(`/p/${projectKey}`, h("span.btn.primary", {}, "See this project's suites")))),
      }));
    }
    cases = suite.cases;
    defaultsFile = suite.defaults;
  } catch (err: WebDynamic) {
    return mount(main, page({ title: slug, body: errorState(err, () => suiteStories(projectKey, slug)) }));
  }
  // Where does this suite point? The single most load-bearing fact when a run
  // misbehaves — surface it in the header instead of burying it in Files.
  // Parsed, not regexed: a nested env base_url must never masquerade as the
  // suite's default target (the honesty fix, decisions §5.5).
  let baseUrl: WebDynamic = null, envUrlsOnly = false, driver = "web";
  try {
    const app: WebDynamic = parseYaml(defaultsFile?.content ?? "").app || {};
    driver = typeof app.driver === "string" ? app.driver : "web";
    baseUrl = typeof app.base_url === "string" && app.base_url.trim() ? app.base_url.trim() : null;
    envUrlsOnly = !baseUrl && Object.values(app.envs || {}).some(
      (e: WebDynamic) => e && typeof e.base_url === "string" && e.base_url.trim());
  } catch { /* no defaults file yet, or unparseable — Settings surfaces that */ }
  const findingsByStory: WebDynamic = new Map();
  for (const f of findings) {
    const sid = f.summary?.story_id;
    if (!sid) continue;
    if (!findingsByStory.has(sid)) findingsByStory.set(sid, []);
    findingsByStory.get(sid).push(f);
  }

  const canEdit = hasRole(project.id, "editor");

  async function setArchived(archived: WebDynamic) {
    try {
      await api.patch(`/suites/${suite.id}`, { archived });
      toast(archived ? "Suite archived" : "Suite unarchived", suite.name, "ok");
      suiteStories(projectKey, slug);
    } catch (err: WebDynamic) { toastError(err); }
  }
  async function deleteSuiteFlow() {
    const ok = await confirmModal({
      title: `Delete "${suite.name}"?`,
      body: "Permanently deletes the suite, its stories and all versions. Only possible while the suite has no runs — a suite with run history can only be archived.",
      confirmLabel: "Delete suite",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/suites/${suite.id}`);
      toast("Suite deleted", suite.name, "ok");
      navigate(`/p/${projectKey}`);
    } catch (err: WebDynamic) { toastError(err); }
  }

  // Authoring and launching are the headline actions. Settings joins
  // Export/Import/Versions and lifecycle (archive/delete) in the ⋯ overflow:
  // they are lower-frequency suite management, not the reason people return to
  // this page. "History" next to a per-story "history →" was two meanings of
  // one word, so it reads "Versions". An archived suite is read-only in spirit:
  // no authoring or launching until it's unarchived.
  const actions: WebDynamic = [
    canEdit && !suite.archived ? draftAction(projectKey, slug) : null,
    canEdit && !suite.archived ? link(`/p/${projectKey}/suites/${slug}/new`, h("span.btn", {}, "+ New story")) : null,
    // launch lives here too — personas kept hunting for "run this suite" on the
    // suite page and only found it two hops away on Runs. An empty suite has
    // nothing to run, so the button says so rather than opening a dialog whose
    // preview reads "this selection matches no stories".
    canEdit && !suite.archived
      ? h("button.btn.primary", {
          disabled: cases.length ? undefined : true,
          title: cases.length ? "Launch this suite against an environment" : "Write a story first — there is nothing to run yet",
          onclick: () => launchModal(projectKey, null, suite.id),
        }, "▶ Run")
      : null,
    canEdit ? overflowMenu([
      { label: "Settings", onclick: () => navigate(`/p/${projectKey}/suites/${slug}/settings`) },
      // The rules a suite is judged against are suite state like its defaults,
      // and every suite has some (Level 0 is always on) — so the entry is here
      // rather than gated behind whether anyone has approved a card yet.
      { label: "API rules", onclick: () => navigate(`/p/${projectKey}/suites/${slug}/rules`) },
      { label: "Versions", onclick: () => navigate(`/p/${projectKey}/suites/${slug}/history`) },
      { label: "Export .tar", onclick: () => exportSuite(suite) },
      { label: "Import .tar…", onclick: () => importSuite(projectKey, suite) },
      suite.archived
        ? { label: "Unarchive suite", onclick: () => setArchived(false) }
        : { label: "Archive suite", onclick: () => setArchived(true) },
      { label: "Delete suite…", danger: true, onclick: deleteSuiteFlow },
    ]) : null,
  ].filter(Boolean);

  // No app URL is not cosmetic: core resolves every case against the suite's
  // defaults, so until one exists NO story in this suite can be saved or run.
  // Suites created before Settings existed (and any whose URLs are per-env only)
  // land here, so the banner names the fix instead of waiting for the save to
  // fail with a config error about a file the web app never showed you.
  const needsUrl = canEdit && driver !== "mobile" && !baseUrl;
  const urlBanner = needsUrl
    ? h("div.card.pad", { style: "margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap" },
        h("span.warn", {}, envUrlsOnly
          ? "This suite only declares per-environment URLs — stories need a default app URL to resolve at all."
          : "This suite has no app URL yet — stories can't be saved or run until it does."),
        link(`/p/${projectKey}/suites/${slug}/settings`, h("span.btn.primary.btn-sm", {}, "Set the app URL")))
    : null;

  const archivedBanner = suite.archived
    ? h("div.card.pad", { style: "margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap" },
        h("span.warn", {}, "This suite is archived — hidden from the suites list and the launcher."),
        canEdit ? h("button.btn.btn-sm", { onclick: () => setArchived(false) }, "Unarchive") : null)
    : null;

  // One AUTHORED story is one row. A two-persona discovery study resolves to
  // `study@curious-newcomer` and `study@power-user` — two runs of one file,
  // with identical descriptions — and rendering them as two rows also made the
  // header count ("5 stories") disagree with the four files in Edit files.
  const stories = groupByStory(cases);

  const runnable = canEdit && !suite.archived ? suite.id : null;
  const body = stories.length
    ? h("div.card", {}, h("table.rows", {},
        h("thead", {}, h("tr", {},
          h("th", {}, "Story"), h("th", {}, "Tags"), h("th", {}, "Persona"), h("th", {}, "Next run"), h("th", {}, "Last"), h("th", {}, "Findings"), h("th", {}, "Trend"),
          runnable ? h("th", {}, h("span.visually-hidden", {}, "Run")) : null)),
        h("tbody", {}, ...stories.map((g) => storyRow(projectKey, slug, g, findingsByStory, runnable))),
      ))
    : emptyState("No stories yet", "A story is one thing a user is trying to do. Write one yourself, let the assistant draft one, or import an existing suite.",
        canEdit
          ? h("div.empty-actions", {},
              draftAction(projectKey, slug),
              link(`/p/${projectKey}/suites/${slug}/new`, h("span.btn.primary", {}, "New story")))
          : null);

  mount(main, page({
    crumbs: [link(`/p/${projectKey}`, "Suites"), " / ", suite.name],
    title: suite.name,
    sub: suiteSubtitle(projectKey, slug, suite, stories.length, baseUrl, envUrlsOnly, canEdit),
    actions,
    body: h("div", {}, archivedBanner, urlBanner, body),
  }));
}

/**
 * What this suite is, in one line.
 *
 * Two things used to be wrong here. An empty suite opened with a WARNING ("no
 * app URL configured — stories must each carry their own") as the very first
 * thing a person read after creating it, which is both alarming and untrue: at
 * launch the environment supplies the URL. And a suite WITH a base_url claimed
 * "tests http://app:4173" — the most prominent statement of where the suite
 * points, and the one that loses at run time to whatever environment you
 * launch against. Say the truth: the target is chosen at launch, and the file's
 * URL is the fallback.
 */
function suiteSubtitle(projectKey: WebDynamic, slug: WebDynamic, suite: WebDynamic, storyCount: WebDynamic, baseUrl: WebDynamic, envUrlsOnly: WebDynamic, canEdit: WebDynamic) {
  const count = `${storyCount} ${storyCount === 1 ? "story" : "stories"}`;
  if (!storyCount) return h("span", {}, count, h("span.dim", {}, " · write one to get started"));
  const editLink = canEdit
    ? h("span", {}, " (", link(`/p/${projectKey}/suites/${slug}/settings`, "edit"), ")")
    : null;
  return h("span", {},
    count,
    h("span.dim", {}, " · environment chosen at launch"),
    baseUrl
      ? h("span.dim", { title: "The launch dialog names the URL a run will actually use." },
          ", defaulting to ", h("span.mono", {}, baseUrl), editLink)
      : envUrlsOnly
        ? h("span.dim", {}, " from the suite's per-environment settings")
        : null,
  );
}

/**
 * Collapse the resolved cases into one entry per authored story. `id` is
 * `<storyId>@<persona>` for a discovery fan-out and the plain story id
 * otherwise, so the base id is the file. LAST and TREND merge across the
 * personas — they are runs of the same story.
 */
function groupByStory(cases: WebDynamic) {
  const out: WebDynamic = new Map();
  for (const c of cases) {
    const base = String(c.id).split("@")[0];
    let g = out.get(base);
    if (!g) {
      g = { base, lead: c, cases: [], personas: [], recent: [], last: null };
      out.set(base, g);
    }
    g.cases.push(c);
    if (c.persona) g.personas.push(c.persona);
    if (c.last && (!g.last || String(c.last.started_at) > String(g.last.started_at))) g.last = c.last;
    g.recent.push(...(c.recent || []));
  }
  for (const g of out.values()) g.recent = g.recent.slice(0, 5);
  return [...out.values()];
}

function storyRow(projectKey: WebDynamic, slug: WebDynamic, g: WebDynamic, findingsByStory: WebDynamic, runSuiteId: WebDynamic = null) {
  const c = g.lead;
  const to = `/p/${projectKey}/suites/${slug}/stories/${encodeURIComponent(c.id)}`;
  const storyFindings = g.cases.flatMap((x: WebDynamic) => findingsByStory.get(x.id) || []);
  // Honest pills (lib/finding-chips.ts): "open" counts only confirmed work
  // (with a fresh pass folded in as "· looks fixed"), unreviewed claims ride a
  // quiet "to review", and auto-resolved shows only once the work is clear.
  const summary = storyFindingSummary(storyFindings, g.last);
  const chips = findingChipDescriptors(summary);
  const chipTitle: WebDynamic = {
    open: storyFindings.filter((f: WebDynamic) => f.state === "reopened" || f.state === "accepted").map((f: WebDynamic) => f.title).join("\n")
      + (summary.lookFixed ? "\nthe latest run of this story passed — may be fixed" : ""),
    review: "machine-filed claims awaiting review — not confirmed findings",
    "auto-resolved": "closed automatically by a later passing run",
  };
  // A pill counting exactly one finding is a shortcut to that finding; bigger
  // counts land on the findings list filtered to the pill's bucket.
  const chipTo = (chip: WebDynamic) => chip.ids.length === 1 ? `/p/${projectKey}/findings/${chip.ids[0]}`
    : chip.kind === "review" ? `/p/${projectKey}/findings?filter=review`
    : chip.kind === "auto-resolved" ? `/p/${projectKey}/findings?filter=resolved`
    : `/p/${projectKey}/findings`;
  const toneClass: WebDynamic = { calm: "calm", muted: "state-muted" };
  const findingsCell = chips.length
    ? h("span.chip-row", {}, ...chips.map((chip: WebDynamic) =>
        link(chipTo(chip),
          h(`span.chip.${toneClass[chip.tone] || chip.tone}`, { title: chipTitle[chip.kind] || undefined }, chip.label))))
    : h("span.faint", {}, "—");
  // A changed last run is a decision awaiting a person — open its evidence page
  // at the Diff view (where Accept/Reject live), not just the run overview.
  const lastQs = g.last?.status === "changed" ? "?view=diff" : "";
  const lastLabel = g.last ? `${g.base}: last run ${g.last.status} ${ago(g.last.started_at)}` : null;
  const last = g.last
    ? link(`/p/${projectKey}/runs/${g.last.run_group_id}/${g.last.run_id}${lastQs}`,
        srOnly(lastLabel),
        statusChip(g.last.status, ["infra", "canceled", "lost"].includes(g.last.status)
          ? didNotRunLabel(g.last.status, { short: true })
          : g.last.status),
        h("span.desc", {}, " ", ago(g.last.started_at)))
    : h("span.faint", {}, "—");
  // oldest → newest pips, the story's recent verdicts at a glance; the strip
  // links to the full history page. A `title` is unreachable by keyboard and
  // invisible on touch, so the same sentence also rides as screen-reader text —
  // an amber dot means nothing to someone who hasn't learned the palette.
  const counts: WebDynamic = {};
  for (const s of g.recent) counts[s] = (counts[s] || 0) + 1;
  const trendText = g.recent.length
    ? `last ${g.recent.length} ${g.recent.length === 1 ? "run" : "runs"}: ` +
      Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(" · ")
    : "no runs yet";
  const trend = g.recent.length
    ? link(`${to}/history`, h("span.trend-pips", { title: trendText },
        srOnly(trendText),
        ...g.recent.slice().reverse().map((s: WebDynamic) => h(`span.pip.${s}`, { "aria-hidden": "true" })),
        h("span.desc", {}, "history →")))
    : link(`${to}/history`, h("span.faint", {}, "history →"));
  // The plain-language story is the title; the kebab-case id is a tag beside
  // it. This is a product whose pitch is plain-language user journeys — the
  // journey should not be the caption.
  const prose = c.description || c.story;
  return h("tr", { style: "cursor:pointer", onclick: (e: WebDynamic) => { if (!e.target.closest("a, button")) navigate(to); } },
    h("td", {},
      link(to, h("span.rowtitle", {}, prose ? clamp(prose) : g.base)),
      g.cases.length > 1
        ? h("span.persona-count", { title: g.personas.join(", ") }, `${g.cases.length} personas`)
        : null,
      prose ? h("span.rowtag.block", { title: "this story's id in URLs, runs and the CLI" }, g.base) : null),
    h("td", {}, ...(c.tags?.length ? c.tags.map(tag) : [h("span.faint", {}, "—")])),
    h("td.dim", {}, g.personas.length ? g.personas.join(", ") : "—"),
    h("td", {}, nextRunChip(c.next_run)),
    h("td", {}, last),
    h("td", {}, findingsCell),
    h("td", {}, trend),
    // per-story launch — the same modal, scoped to this story's ids
    // (decisions §5.3). Six identical "▶ Run" buttons on one screen are one
    // control to a screen reader; the label says which story.
    runSuiteId ? h("td", { style: "text-align:right" },
      h("button.btn.btn-sm", {
        title: `Run only ${g.base}`,
        "aria-label": `Run ${g.base}`,
        onclick: () => launchModal(projectKey, null, runSuiteId, { ids: g.cases.map((x: WebDynamic) => x.id) }),
      }, "▶ Run")) : null,
  );
}

async function renderSuitesIndex(main: WebDynamic, projectKey: WebDynamic, project: WebDynamic, archived = false) {
  const title = archived ? "Archived suites" : "Suites";
  mount(main, page({ title, body: h("div.dim", {}, "Loading…") }));
  let suites: WebDynamic = [];
  try { ({ items: suites } = await api.cached(`/projects/${projectKey}/suites${archived ? "?archived=1" : ""}`, { ttl: 15_000 })); }
  catch (err: WebDynamic) { return mount(main, page({ title, body: errorState(err, () => renderSuitesIndex(main, projectKey, project, archived)) })); }
  const canEdit = hasRole(project.id, "editor");
  const body = suites.length
    ? h("div.card", {}, h("table.rows", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Suite"), h("th", {}, "Stories"), h("th", {}, "Updated"))),
        // The row IS the link (name-first; the name link + row click suffice —
        // a third "Open" button was pure noise).
        h("tbody", {}, ...suites.map((s: WebDynamic) => h("tr", { style: "cursor:pointer", onclick: (e: WebDynamic) => { if (!e.target.closest("a, button")) navigate(`/p/${projectKey}/suites/${s.slug}`); } },
          h("td", {},
            // Name only — the slug is the URL/CLI id and lives in Suite settings.
            link(`/p/${projectKey}/suites/${s.slug}`, h("span.rowtitle", {}, s.name))),
          h("td", {}, s.story_count == null ? "—" : String(s.story_count)),
          h("td.dim", {}, ago(s.updated_at)),
        ))),
      ))
    : archived
      ? emptyState("No archived suites", "Suites you archive land here; unarchive them from their page.")
      : emptyState("No suites yet", "Create your first suite of stories.",
          canEdit ? h("button.btn.primary", { onclick: () => newSuiteModal(projectKey) }, "New suite") : null);
  mount(main, page({
    title,
    actions: [
      h("button.btn.ghost", { onclick: () => renderSuitesIndex(main, projectKey, project, !archived) }, archived ? "← Live suites" : "Archived"),
      canEdit && !archived ? h("button.btn.primary", { onclick: () => newSuiteModal(projectKey) }, "+ New suite") : null,
    ].filter(Boolean),
    body,
  }));
}

export async function exportSuite(suite: WebDynamic) {
  try {
    const blob = await api.blob(`/suites/${suite.id}/export`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${suite.slug}.tar`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err: WebDynamic) { toastError(err); }
}

export function importSuite(projectKey: WebDynamic, suite: WebDynamic, onDone: WebDynamic = null) {
  const input: WebDynamic = document.createElement("input");
  input.type = "file";
  input.accept = ".tar";
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    // Import is reversible (every import = one immutable snapshot) — say so,
    // and name the rollback path, before replacing the tree. The promise is
    // real: Versions carries a Restore action per row.
    const ok = await confirmModal({
      title: `Import into "${suite.name}"?`,
      body: `Replaces this suite's files with the contents of ${file.name}. The current files are kept as a version first, so you can restore them from Versions.`,
      confirmLabel: "Import",
    });
    if (!ok) return;
    try {
      await api.postRaw(`/suites/${suite.id}/import`, await file.arrayBuffer(), "application/x-tar");
      toast("Suite imported", file.name, "ok");
      if (onDone) onDone();
      else suiteStories(projectKey, suite.slug);
    } catch (err: WebDynamic) { toastError(err); }
  };
  input.click();
}
