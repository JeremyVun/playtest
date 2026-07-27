// Control-plane web app entry. TypeScript emits browser ESM in place. Boots the
// principal, loads projects, wires the routes, and starts history-API routing. In
// OIDC mode an unauthenticated visitor gets the login screen; dev mode is always
// signed in as the dev admin.
import { initTheme, initScopeGate, lastProject, renderFrame, page } from "./lib/shell.js";
import { route, setNotFound, startRouter, navigate, link } from "./lib/router.js";
import { loadMe, loadProjects, state } from "./lib/state.js";
import { h, mount } from "./lib/dom.js";
import { emptyState } from "./lib/ui.js";
import { loginScreen } from "./pages/login.js";
import { projectsList, projectHome } from "./pages/projects.js";
import { suiteStories } from "./pages/suite.js";
import { storyEditor } from "./pages/story.js";
import { suiteSettingsPage } from "./pages/suite-settings.js";
import { historyPage } from "./pages/history.js";
import { settingsPage } from "./pages/settings.js";
import { personasPage } from "./pages/personas.js";
import { runsPage } from "./pages/runs.js";
import { runDetailPage } from "./pages/run.js";
import { reviewPage } from "./pages/review.js";
import { findingsPage, findingDetailPage } from "./pages/findings.js";
import { consolidationPage, consolidationPlanPage } from "./pages/consolidation.js";
import { storyHistoryPage } from "./pages/story-history.js";
import { ruleCardsPage } from "./pages/rule-cards.js";
import { redirectFor } from "./lib/redirects.js";

function registerRoutes() {
  // Removed SPA surfaces resolve to their surviving home (see lib/redirects.ts).
  const redirect = () => navigate(redirectFor(location.pathname), { replace: true });
  // `/` lands where the person was last working, or on a single project when
  // that is the only choice. It never picks the alphabetically first of several
  // — that dropped returning users into whichever project happened to sort
  // first, usually an empty one.
  route("/", () => {
    const keys = state.projects.map((p: WebDynamic) => p.key);
    const home = lastProject(keys) || (keys.length === 1 ? keys[0] : null);
    if (home) navigate(`/p/${home}`, { replace: true });
    else projectsList();
  });
  route("/login", () => loginScreen());
  route("/projects", () => projectsList());
  route("/p/:key", (p: WebDynamic) => projectHome(p.key));
  // Suites is the project home — the old suites-index URL redirects to it.
  route("/p/:key/suites", redirect);
  route("/p/:key/suites/:slug", (p: WebDynamic) => suiteStories(p.key, p.slug));
  route("/p/:key/suites/:slug/stories/:id", (p: WebDynamic) => storyEditor(p.key, p.slug, p.id));
  route("/p/:key/suites/:slug/stories/:id/history", (p: WebDynamic) => storyHistoryPage(p.key, p.slug, p.id));
  route("/p/:key/suites/:slug/new", (p: WebDynamic, q: WebDynamic) => storyEditor(p.key, p.slug, null, q));
  // The standalone assistant is gone (P2): the old link opens New story with the
  // Help-me-draft modal (redirectFor maps it to /new?assist=1).
  route("/p/:key/suites/:slug/assistant", redirect);
  // The raw file tree is gone (P2 follow-up): the web app authors stories and
  // the suite's defaults; personas, hooks and assertions travel as a .tar and
  // are edited with the CLI. The old link lands on Suite settings.
  route("/p/:key/suites/:slug/files", redirect);
  route("/p/:key/suites/:slug/settings", (p: WebDynamic) => suiteSettingsPage(p.key, p.slug));
  route("/p/:key/suites/:slug/rules", (p: WebDynamic) => ruleCardsPage(p.key, p.slug));
  route("/p/:key/suites/:slug/history", (p: WebDynamic) => historyPage(p.key, p.slug));
  // ?attention=1 keeps only the runs holding a failure or a story that never
  // produced a verdict — a link a person can bookmark or paste into chat.
  route("/p/:key/runs", (p: WebDynamic, q: WebDynamic) => runsPage(p.key, null, q));
  route("/p/:key/runs/:group", (p: WebDynamic) => runsPage(p.key, p.group));
  route("/p/:key/runs/:group/:run", (p: WebDynamic) => runDetailPage(p.key, p.group, p.run));
  // Review is contextual (reached from Suites / a changed run), not on the rail.
  route("/p/:key/review", (p: WebDynamic) => reviewPage(p.key));
  route("/p/:key/findings", (p: WebDynamic, q: WebDynamic) => findingsPage(p.key, q));
  route("/p/:key/findings/:id", (p: WebDynamic) => findingDetailPage(p.key, p.id));
  // The bug-candidate queue collapsed into Findings (needs-review filter);
  // bookmarks keep resolving. A candidate's id survived the collapse as its
  // finding's id, so old deep links land on the same claim.
  route("/p/:key/candidates", redirect);
  route("/p/:key/candidates/:id", redirect);
  // Consolidation is reached from the needs-review view; a plan is a proposal
  // the reviewer applies, so it gets its own reviewable surface.
  route("/p/:key/consolidation", (p: WebDynamic) => consolidationPage(p.key));
  route("/p/:key/consolidation/:id", (p: WebDynamic) => consolidationPlanPage(p.key, p.id));
  // Insights and global search were removed; keep their links working.
  route("/p/:key/insights", redirect);
  route("/p/:key/insights/:id", redirect);
  route("/p/:key/search", redirect);
  // Personas are project-wide: one list, reused by every suite's stories.
  route("/p/:key/personas", (p: WebDynamic) => personasPage(p.key));
  route("/p/:key/settings", (p: WebDynamic) => settingsPage(p.key));
  route("/p/:key/settings/:tab", (p: WebDynamic) => settingsPage(p.key, p.tab));
  // A mistyped sub-path must not eject you from the project you were in: keep
  // the rail whenever the path names one you can see, and always offer a real
  // next step rather than leaving the browser's Back button as the only exit.
  setNotFound(() => {
    const key = /^\/p\/([^/]+)/.exec(location.pathname)?.[1];
    const project = key ? state.projectByKey.get(key) : null;
    const main = renderFrame(project ? { projectKey: project.key } : {});
    mount(main, page({
      title: "Page not found",
      body: emptyState(
        "That link doesn't lead anywhere",
        project
          ? `Nothing in ${project.name} lives at this address — it may have been renamed, or the link may be truncated.`
          : "The address may have been renamed, or the link may be truncated.",
        h("div.empty-actions", {},
          project ? link(`/p/${project.key}`, h("span.btn.primary", {}, `Back to ${project.name}`)) : null,
          link("/projects", h("span.btn", {}, "See all projects")),
        ),
      ),
    }));
  });
}

async function boot() {
  initTheme();
  initScopeGate();
  try {
    await loadMe();
  } catch (e: WebDynamic) {
    if (e.status === 401) return loginScreen();
    throw e;
  }
  await loadProjects();
  registerRoutes();
  startRouter();
}

boot().catch((e) => {
  document.getElementById("app").innerHTML =
    `<div class="boot">Failed to start: ${String(e.message || e)}</div>`;
});
