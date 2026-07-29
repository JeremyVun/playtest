// The app frame: top bar (wordmark → the project index, project switcher, theme
// icon, user menu), the left project rail (the hosted IA — see lib/nav.ts), and the system
// status bar along the bottom. Pages call renderFrame() to paint the chrome and
// get the #main element to fill. Developer/admin surfaces appear only when the
// role allows.
import { byId, h, mount, initials } from "./dom.js";
import { link, navigate } from "./router.js";
import { state, hasRole, displayName } from "./state.js";
import { enhanceSelect } from "./ui.js";
import { RAIL, railFor } from "./nav.js";
import { statusBar, stopStatusBar } from "./statusbar.js";

const BRAND = h("span.brand", {},
  h("svg", { viewBox: "0 0 16 16", html: '<path d="M4 3l9 5-9 5z"/>' }),
  "Playtest",
);

// Theme icons: each shows the theme the click will GIVE you, so the control
// states its outcome rather than its current state.
const MOON = '<path d="M13.4 9.7A5.7 5.7 0 0 1 6.3 2.6 5.9 5.9 0 1 0 13.4 9.7z"/>';
const SUN = '<circle cx="8" cy="8" r="3.1"/><g stroke="currentColor" stroke-width="1.4" '
  + 'stroke-linecap="round" fill="none"><path d="M8 1.1v1.7M8 13.2v1.7M1.1 8h1.7M13.2 8h1.7'
  + 'M3.2 3.2l1.2 1.2M11.6 11.6l1.2 1.2M12.8 3.2l-1.2 1.2M4.4 11.6l-1.2 1.2"/></g>';

function projectSwitcher(currentKey: WebDynamic) {
  const sel = h("select", {
    onchange: (e: WebDynamic) => navigate(`/p/${e.target.value}`),
    "aria-label": "Switch project",
  }, ...state.projects.map((p: WebDynamic) => h("option", { value: p.key, selected: p.key === currentKey }, p.name)));
  const enhanced = enhanceSelect(sel);
  enhanced.querySelector("button")?.setAttribute("aria-label", "Switch project");
  const wrap = h("div.proj-switch", {}, enhanced);
  return state.projects.length ? wrap : h("span.dim", {}, "no projects");
}

function userMenu() {
  // Plain buttons: an <a> wrapping a <button> is nested interactive content,
  // and assistive tech announces the same item twice. Theme is no longer in
  // here — it is a top-bar icon, because a display preference people flip by
  // time of day should not be two clicks deep behind an avatar.
  const menu = h("div.menu", { hidden: true },
    h("button", { onclick: () => navigate("/projects") }, "All projects"),
    h("button", { onclick: logout }, "Sign out"),
  );
  const btn = h("button", { onclick: () => (menu.hidden = !menu.hidden), "aria-haspopup": "menu" },
    h("span.avatar", {}, initials(displayName())),
  );
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) menu.hidden = true; });
  const wrap = h("div.usermenu", {}, btn, menu);
  return wrap;
}

/**
 * The theme control: a top-bar icon, and a two-state switch.
 *
 * It used to be a "Toggle theme" item in the avatar menu that cycled
 * dark → light → follow-the-OS. On a machine already in dark mode the first
 * click set an explicit "dark" and changed nothing on screen, so the console
 * looked like it needed two clicks to respond. Now every click flips what you
 * can see, because it is decided from the EFFECTIVE theme (the resolved OS
 * preference when nobody has chosen yet), not from the stored one.
 *
 * Following the OS is still the default until someone first clicks; after that
 * the choice is theirs and sticks.
 */
function themeToggle() {
  const btn = h("button.icon-btn.theme-toggle", { onclick: flip });
  btn.repaintTheme = paint;
  paint();
  return btn;

  function paint() {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    const label = `Switch to the ${next} theme`;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    btn.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${next === "dark" ? MOON : SUN}</svg>`;
  }

  function flip() {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
    syncViewerTheme();
    repaintThemeToggles();
  }
}

const THEME_KEY = "pt-theme";
const repaintThemeToggles = () => {
  for (const el of document.querySelectorAll(".theme-toggle")) {
    (el as Element & { repaintTheme?: () => void }).repaintTheme?.();
  }
};

/** The console's theme, or null when it follows the OS preference. */
export const currentTheme = () => document.documentElement.dataset.theme || null;

/** What the person is actually looking at: the explicit choice, or the OS's. */
const prefersDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
const effectiveTheme = () => currentTheme() || (prefersDark() ? "dark" : "light");

/**
 * The embedded trajectory viewer honours `?theme=` (interfaces.md, the viewer
 * URL contract) but has no other way to learn the host's choice, so a dark
 * console used to frame a bright white viewer panel. Re-point any mounted
 * viewer iframe when the theme changes; with no explicit theme both sides fall
 * back to prefers-color-scheme and already agree.
 */
export function syncViewerTheme() {
  for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe.viewer-embed")) {
    const url = new URL(frame.src, location.origin);
    const theme = currentTheme();
    if (theme) url.searchParams.set("theme", theme);
    else url.searchParams.delete("theme");
    if (url.toString() !== frame.src) frame.src = url.toString();
  }
}

/**
 * Rail collapse: the project rail folds to an icon column so wide surfaces
 * (the embedded trajectory viewer above all) get the horizontal space. The
 * choice is a workspace preference, so it persists like the theme does.
 */
const RAIL_KEY = "pt-rail";
const railCollapsed = () => {
  try { return localStorage.getItem(RAIL_KEY) === "min"; } catch { return false; }
};

function railToggle() {
  const btn = h("button.rail-toggle", { onclick: flip });
  paint();
  return btn;

  function paint() {
    const min = railCollapsed();
    // like the theme icon, the chevron shows what the click GIVES you
    const label = min ? "Expand the navigation" : "Collapse the navigation";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    btn.setAttribute("aria-expanded", String(!min));
    btn.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${min ? "M6 3.5 10.5 8 6 12.5" : "M10 3.5 5.5 8l4.5 4.5"}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function flip() {
    const min = !railCollapsed();
    try { localStorage.setItem(RAIL_KEY, min ? "min" : "full"); } catch { /* private mode */ }
    for (const el of document.querySelectorAll(".layout")) el.classList.toggle("rail-min", min);
    paint();
  }
}

async function logout() {
  await fetch("/auth/logout", { method: "POST" });
  location.href = "/login";
}

/**
 * Paint topbar + rail; return the #main element for the page to fill.
 * @param {{ projectKey?: string|null, nav?: string }} opts
 */
export function renderFrame({ projectKey = null, nav = null }: WebDynamic = {}) {
  const app = byId("app");
  app.removeAttribute("aria-busy");
  // Remember where the person was working: `/` used to drop a returning user
  // into whichever project sorts first alphabetically, which for most teams is
  // not the one they use.
  if (projectKey) rememberProject(projectKey);

  // The wordmark goes to the project index, not to `/`: `/` lands you back in
  // the project you were last in, so from inside a project the one control that
  // looks like "home" never took you out of it.
  const brand = link("/projects", BRAND.cloneNode(true));
  brand.className = "brand-link";
  brand.title = "All projects";

  const topbar = h("header#topbar", {},
    brand,
    projectKey ? projectSwitcher(projectKey) : h("span.dim", {}, ""),
    h("div.topbar-spacer"),
    themeToggle(),
    userMenu(),
  );

  const main = h("main#main");
  if (projectKey) {
    // Sub-pages (the story editor, Edit files, Versions, run history, the
    // changed-stories queue) light up the rail item they live under — see
    // nav.js railFor. aria-current names it for assistive tech, which cannot
    // see the .active tint.
    const active = railFor(nav);
    const navIcon = (item: WebDynamic) =>
      h("span.nav-ic", { "aria-hidden": "true", html: `<svg viewBox="0 0 16 16">${item.icon}</svg>` });
    const rail = h("nav#rail", { "aria-label": "Project navigation" },
      ...RAIL.map((item: WebDynamic) =>
        link(item.to(projectKey), h(`div.navlink${active === item.nav ? ".active" : ""}`,
          { title: item.label, ...(active === item.nav ? { "aria-current": "page" } : {}) },
          navIcon(item), h("span.nav-label", {}, item.label)))),
      railToggle(),
    );
    // The status bar is project-scoped (its feed and its ops numbers are), so
    // it lives with the rail: inside a project it is always on screen, and the
    // project index has no system to report on.
    const layout = h(`div.layout${railCollapsed() ? ".rail-min" : ""}`, {}, rail, main);
    mount(app, topbar, layout, statusBar(projectKey, state.projectByKey.get(projectKey)?.id ?? null));
  } else {
    stopStatusBar();
    mount(app, topbar, h("div.layout.no-rail", {}, main));
  }
  return main;
}

/** Standard page scaffold inside #main. */
export function page({ crumbs, title, sub, actions, body }: WebDynamic) {
  return h("div.page", {},
    crumbs ? h("div.crumbs", {}, ...crumbs) : null,
    h("div.page-head", {},
      h("div", {}, h("h1", {}, title), sub ? h("div.sub.dim", {}, sub) : null),
      actions ? h("div.head-actions", {}, ...actions) : null,
    ),
    body,
  );
}

export function initTheme() {
  let saved: WebDynamic = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* private mode */ }
  if (saved) document.documentElement.dataset.theme = saved;
  // Nobody has chosen yet ⇒ we follow the OS, so the icon must follow it too
  // (macOS flips at sunset while the tab is open).
  window.matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener?.("change", () => { if (!currentTheme()) repaintThemeToggles(); });
}

const LAST_PROJECT = "pt-last-project";
const rememberProject = (key: WebDynamic) => { try { localStorage.setItem(LAST_PROJECT, key); } catch { /* private mode */ } };

/** The project this browser was last working in, if it is still visible. */
export function lastProject(keys: WebDynamic) {
  let key: WebDynamic = null;
  try { key = localStorage.getItem(LAST_PROJECT); } catch { /* private mode */ }
  return key && keys.includes(key) ? key : null;
}

/**
 * Wire the sub-900px scope gate's escape hatch. Desktop-first is a defensible
 * decision; presenting it as a wall with no way forward is not.
 */
export function initScopeGate() {
  const btn = document.getElementById("scope-continue");
  if (!btn) return;
  if (localStorage.getItem("pt-scope") === "wide") document.documentElement.dataset.scope = "wide";
  btn.addEventListener("click", () => {
    document.documentElement.dataset.scope = "wide";
    try { localStorage.setItem("pt-scope", "wide"); } catch { /* private mode */ }
  });
}

export { hasRole };
