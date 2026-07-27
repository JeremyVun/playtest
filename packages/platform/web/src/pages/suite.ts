// Suites index + a suite's stories list. The stories list is the GET /suites/:s/cases
// projection — the one resolver (UX Suite screen). NEXT RUN uses the core list words
// (record/check/explore). LAST and TREND come from the projection's `last`/`recent`
// decoration (one window query server-side, no per-story history reads).
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { link, navigate } from "../lib/router.js";
import { renderFrame, page } from "../lib/shell.js";
import { state, hasRole, hasLlm, LLM_UNAVAILABLE } from "../lib/state.js";
import { toast, toastError, emptyState, errorState, statusChip, nextRunChip, tag, confirmModal, overflowMenu, srOnly, formField } from "../lib/ui.js";
import { clamp, ago } from "../lib/labels.js";
import { didNotRunLabel } from "../lib/vocab.js";
import { parseYaml } from "../lib/caseform.js";
import { setAppKey, setEnvBaseUrl, baseUrlProblem, DEFAULT_ENV_NAME } from "../lib/defaults-form.js";
import { PLATFORMS, APP_ARTIFACT_EXTENSIONS, appArtifactProblem, fmtBytes } from "../lib/env-config.js";
import { BINARY_SOURCES, targetQuestion, ringNameProblem, ringPlan, existingRingPlan } from "../lib/suite-target.js";
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
  let suite: WebDynamic, cases, findings = [], defaultsFile = null, environments: WebDynamic = [];
  try {
    // One stage: the suite lookup folds in its cases and defaults file
    // (?include=cases,defaults), and the findings queries are project-scoped,
    // so nothing here waits on anything else. Findings are joined per story:
    // a green LAST chip next to an active major finding was the round-3
    // orient trust-breaker ("the app did not reconcile that contradiction in
    // one place"). Two finding fetches so a long resolved archive can never
    // crowd live work out of the 100-row page. Best-effort: the table must
    // render even if findings fail.
    ([suite, findings, environments] = await Promise.all([
      getSuiteBySlug(projectKey, slug, "cases,defaults"),
      Promise.all([
        api.get(`/projects/${projectKey}/findings?state=new,reopened,accepted&limit=100`),
        // Only auto-resolved closes matter here — the calm receipt chip.
        api.get(`/projects/${projectKey}/findings?state=resolved&limit=100`).catch(() => ({ items: [] })),
      ]).then(
        ([live, closed]) => [...live.items, ...closed.items.filter((f: WebDynamic) => f.auto_resolved_at)],
        () => [],
      ),
      // The rings this suite could run in — the empty-suite target card's
      // choices. Best effort: a role that cannot read them simply gets the
      // "create one" half, and a suite with stories never asks at all.
      api.cached(`/projects/${projectKey}/environments`).then((r: WebDynamic) => r.items, () => []),
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
  let baseUrl: WebDynamic = null, envUrlsOnly = false, driver = "web", appBlock: WebDynamic = {};
  try {
    const app: WebDynamic = parseYaml(defaultsFile?.content ?? "").app || {};
    appBlock = app;
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

  // One AUTHORED story is one row. A two-persona discovery study resolves to
  // `study@curious-newcomer` and `study@power-user` — two runs of one file,
  // with identical descriptions — and rendering them as two rows also made the
  // header count ("5 stories") disagree with the four files in Edit files.
  const stories = groupByStory(cases);

  // Where does this app run? Asked HERE, once, on a suite that has nothing to
  // run yet — not in the dialog that named it. The card is driver-aware, it can
  // make the ring it needs, and it is skippable: the launch dialog states the
  // resolved target and a launch with nothing to point at is refused with the
  // three sources named, so deferring costs a person nothing.
  const targetCard = canEdit && !suite.archived && !stories.length
    ? whereDoesItRunCard({
        projectKey, project, suite, app: appBlock, envs: environments, driver,
        reload: () => suiteStories(projectKey, slug),
      })
    : null;

  // No app URL is not cosmetic: core resolves every case against the suite's
  // defaults, so until one exists NO story in this suite can be saved or run.
  // Suites created before Settings existed (and any whose URLs are per-env only)
  // land here, so the banner names the fix instead of waiting for the save to
  // fail with a config error about a file the web app never showed you. The
  // card above says the same thing better on an empty suite, so it does not
  // also get a banner.
  const needsUrl = canEdit && driver !== "mobile" && !baseUrl && !targetCard;
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
    body: h("div", {}, archivedBanner, urlBanner, targetCard, body),
  }));
}

/**
 * "Where does this app run?" — the card an empty suite opens with.
 *
 * It exists because the New suite dialog stopped asking. The question belongs
 * to a ring, not to a suite's name, and it is a different question per driver:
 * a web suite needs an address, a mobile suite needs a build and the machine
 * holding the device. Both are answered here in one gesture — pick a ring the
 * project already has, or make one — and either answer is skippable, because
 * the launch path states the resolved target and refuses a run with none.
 *
 * Null when the suite already has an answer: a card telling someone to do what
 * they have done is worse than no card.
 */
function whereDoesItRunCard({ projectKey, project, suite, app, envs, driver, reload }: WebDynamic) {
  const mobile = driver === "mobile";
  const overlays = app?.envs || {};
  // Configured means "this suite has an answer", and the bar differs by driver
  // for a reason that is core's, not a preference: a web or API case cannot be
  // resolved — or even saved — without the SUITE's own URL, so a ring's
  // fallback does not answer the question for it. A mobile binary genuinely can
  // come from the ring alone, and usually does.
  const suiteSays = mobile
    ? !!app?.app || Object.values(overlays).some((e: WebDynamic) => e?.app)
    : !!app?.base_url || Object.values(overlays).some((e: WebDynamic) => e?.base_url);
  const ringSays = mobile && envs.some((e: WebDynamic) =>
    (e.app_artifact || e.config?.app?.app) && (!e.suite_id || e.suite_id === suite.id));
  const skipKey = `pt.target-skipped.${suite.id}`;
  let skipped = false;
  try { skipped = sessionStorage.getItem(skipKey) === "1"; } catch { /* private mode: ask again */ }
  if (suiteSays || ringSays || skipped) return null;

  const canManageRings = hasRole(project.id, "developer");
  const pooled = state.me?.capabilities?.pool_dispatch === true;
  const q = targetQuestion(driver);
  const card = h("div.card.pad.target-card", { style: "margin-bottom:14px" });
  // Rings this suite may use: the project's, plus its own. Another suite's is
  // not a choice — the server refuses it, and offering it offers a mistake.
  const usable = envs.filter((e: WebDynamic) => !e.suite_id || e.suite_id === suite.id);
  const NEW = "__new";
  const ring = h("select", { "aria-label": "Environment", onchange: paint },
    ...usable.map((e: WebDynamic) => h("option", { value: e.id }, e.suite_id ? `${e.name} — this suite only` : e.name)),
    canManageRings ? h("option", { value: NEW }, "＋ Create an environment…") : null);
  if (!usable.length && canManageRings) ring.value = NEW;

  const url = h("input", { type: "text", placeholder: "https://staging.example.com" });
  const newName = h("input", { type: "text", placeholder: mobile ? "adas-mac" : "staging" });
  const share = h("input", { type: "checkbox" });
  const labels = h("input", { type: "text", placeholder: "macos, ios-sim" });
  const path = h("input", { type: "text", placeholder: "/Users/you/builds/app-release.apk" });
  const platform = h("select", { "aria-label": "Platform" },
    ...PLATFORMS.map((p: WebDynamic) => h("option", { value: p }, p === "ios" ? "iOS" : "Android")));
  const appium = h("input", { type: "text", placeholder: "http://127.0.0.1:4723" });
  const picker: WebDynamic = h("input", { type: "file", accept: APP_ARTIFACT_EXTENSIONS.join(","), style: "display:none", onchange: paint });
  const problem = h("div.preview-warn", { style: "display:none" });
  const saveBtn = h("button.btn.primary", { type: "submit" }, "Save target");
  let source = "runner-path";

  paint();
  return card;

  function paint() {
    const making = ring.value === NEW;
    const chosen = usable.find((e: WebDynamic) => e.id === ring.value) || null;
    mount(card, h("form", { onsubmit: save },
      h("h3.target-card-title", {}, q.title),
      h("p.dim", { style: "font-size:12.5px;margin:2px 0 14px" }, q.sub),
      usable.length || canManageRings
        ? formField("Environment", ring, making
            ? "A deployment ring: what a run points at, which runners may take it, and whether discovery is allowed there."
            : "This suite's own settings inside that ring — another suite in the same ring can point somewhere else entirely.")
        : h("p.warn", { style: "font-size:12.5px" },
            "This project has no environment you can use, and adding one needs the developer role. Ask a project admin, or skip — you can still write stories."),
      making ? newRingFields() : null,
      mobile ? binaryFields(chosen, making) : urlField(chosen, making),
      problem,
      h("div", { style: "display:flex;gap:8px;align-items:center;margin-top:6px" },
        saveBtn,
        h("button.btn.ghost", { type: "button", onclick: skip }, "Skip for now"),
        h("span.faint", { style: "font-size:11.5px" },
          "You can change this any time on Suite settings."),
      ),
    ));
  }

  function newRingFields() {
    return h("div", {},
      formField("Name", newName,
        "How it reads at launch and as the CLI's --env. Names are unique across the whole project."),
      h("label.check", { style: "margin:2px 0 10px" }, share,
        "Share it with every suite in this project"),
      h("div.faint", { style: "font-size:11.5px;margin:-6px 0 12px 24px" },
        "Off: only this suite can launch against it — the usual answer for a ring made for one suite. On: it joins the project's shared rings under Settings → Test targets."),
      // Labels are pool-only machinery: on a deployment that places runs
      // itself, offering them would be offering a control with nothing behind it.
      pooled
        ? formField("Runner labels", labels,
            "Runs here go to a self-hosted runner advertising ALL of these labels. Leave blank to let any runner in this project take them.")
        : null,
    );
  }

  function urlField(chosen: WebDynamic, making: WebDynamic) {
    const fallback = chosen?.config?.app?.base_url;
    if (!making && fallback) url.placeholder = fallback;
    // The project's `default` ring carries no URL of its own — a suite's value
    // for it IS the suite's own address — so the field is not named after it.
    const isDefault = !making && chosen?.name === DEFAULT_ENV_NAME;
    const label = making ? "URL"
      : isDefault ? "App URL"
      : `This suite's URL in ${chosen?.name || "this environment"}`;
    return h("div", {},
      formField(label, url,
        fallback && !making
          ? `Leave blank to use the environment's own ${fallback}.`
          : isDefault
            ? "Where these stories run. Any environment that sets no URL of its own falls back to it."
            : "Where these stories run. It is this suite's alone — it lands in the suite's playtest.yaml, not on the environment."),
    );
  }

  /** The three sources a mobile binary can come from, as a choice. */
  function binaryFields(chosen: WebDynamic, making: WebDynamic) {
    const file = picker.files?.[0] || null;
    const options = BINARY_SOURCES.map((s: WebDynamic) =>
      h(`button.launch-mode${s.id === source ? ".on" : ""}`, {
        type: "button", role: "radio", "aria-checked": s.id === source ? "true" : "false",
        onclick: () => { source = s.id; paint(); },
      }, h("span.launch-mode-name", {}, s.name), h("span.launch-mode-gist", {}, s.gist)));
    const chose = BINARY_SOURCES.find((s: WebDynamic) => s.id === source);
    return h("div", {},
      h("div.field", {},
        h("div.field-label", {}, "Where the build comes from"),
        h("div.launch-modes", { role: "radiogroup", "aria-label": "Where the build comes from" }, ...options),
        h("p.launch-mode-note", {}, chose?.when),
      ),
      source === "runner-path"
        ? formField("Path on that machine", path,
            "An absolute path on the runner that executes this suite. Nothing is uploaded, and the path is the environment's — it describes that machine's disk.")
        : null,
      source === "suite-file"
        ? formField("Path inside this suite", h("input", { type: "text", value: path.value, placeholder: "builds/fixture.apk", onchange: (e: WebDynamic) => { path.value = e.target.value; } }),
            "Relative to this suite's playtest.yaml, and committed with it. Only a small fixture app fits — real builds are many times the suite upload cap.")
        : null,
      source === "artifact"
        ? h("div.field", {},
            h("div.field-label", {}, "The build"),
            h("div", { style: "display:flex;gap:10px;align-items:center" },
              h("button.btn.btn-sm", { type: "button", onclick: () => picker.click() }, file ? "Choose another…" : "Choose a file…"),
              h("span.dim", { style: "font-size:12px" }, file ? `${file.name} · ${fmtBytes(file.size)}` : "nothing chosen yet"),
              picker),
            h("div.hint", {},
              `Uploaded once and pinned by hash: every run installs exactly these bytes until you replace them. ${APP_ARTIFACT_EXTENSIONS.join(", ")}, up to ${state.me?.capabilities?.app_artifact_max_mb ?? 512} MB — an iOS .app is a directory, so zip it first.`),
          )
        : null,
      !making && chosen
        ? h("p.faint", { style: "font-size:11.5px;margin:-4px 0 10px" },
            source === "suite-file"
              ? "This one is the suite's own file, so nothing changes on the environment."
              : chosen.suite_id
                ? `This sets it on ${chosen.name}, which only this suite uses.`
                : `This sets it on ${chosen.name} — a shared environment, so every suite that runs there gets the same build.`)
        : null,
      h("details.advanced", {},
        h("summary", {}, "Device — platform and Appium server"),
        h("div", { style: "margin-top:10px" },
          formField("Platform", platform, "Which mobile driver core starts."),
          formField("Appium server", appium, "Where Appium listens on that machine. Blank uses core's default."))),
    );
  }

  function fail(message: WebDynamic) {
    problem.style.display = "";
    problem.textContent = message;
    saveBtn.disabled = false;
  }

  function skip() {
    try { sessionStorage.setItem(skipKey, "1"); } catch { /* nothing to remember it with */ }
    toast("Skipped for now", "The launch dialog says where a run would point, and refuses one with nowhere to go.");
    reload();
  }

  async function save(e: WebDynamic) {
    e.preventDefault();
    problem.style.display = "none";
    saveBtn.disabled = true;
    const making = ring.value === NEW;
    const file = picker.files?.[0] || null;
    let target = usable.find((x: WebDynamic) => x.id === ring.value) || null;

    if (!making && !target) return fail("Pick an environment, or create one.");
    if (mobile && source === "artifact" && !file) return fail("Choose the build to upload.");
    if (mobile && source === "artifact" && file) {
      const bad = appArtifactProblem(file, (state.me?.capabilities?.app_artifact_max_mb ?? 512) * 1024 * 1024);
      if (bad) return fail(bad);
    }
    if (mobile && source !== "artifact" && !path.value.trim()) return fail("Say where the build is.");
    if (!mobile && making && baseUrlProblem(url.value)) return fail(baseUrlProblem(url.value));
    if (!mobile && !making && url.value.trim() && baseUrlProblem(url.value)) return fail(baseUrlProblem(url.value));

    const draft: WebDynamic = {
      driver, name: newName.value.trim(), scope: share.checked ? "project" : "suite",
      url: url.value, labels: labels.value.split(",").map((s: WebDynamic) => s.trim()).filter(Boolean),
      source, path: path.value, platform: platform.value, appiumUrl: appium.value,
    };
    if (making) {
      const collision = ringNameProblem(draft.name, envs);
      if (collision) { newName.focus(); return fail(collision); }
    }

    try {
      let write;
      if (making) {
        const plan = ringPlan(draft, { suiteId: suite.id });
        target = await api.post(`/projects/${projectKey}/environments`, plan.environment);
        write = plan.write;
      } else if (mobile) {
        const plan = ringPlan({ ...draft, name: target.name }, { suiteId: suite.id });
        // An existing ring keeps everything it already says; only the keys this
        // card asked about are written.
        const added: WebDynamic = plan.environment?.config || {};
        if (source !== "suite-file") {
          await api.put(`/environments/${target.id}`, {
            name: target.name,
            discovery_allowed: target.discovery_allowed,
            runner_labels: draft.labels.length ? draft.labels : target.runner_labels || [],
            config: { ...target.config, ...added, app: { ...(target.config?.app || {}), ...(added.app || {}) } },
          });
        }
        write = plan.write;
      } else {
        write = existingRingPlan(target.name, url.value);
      }
      if (mobile && source === "artifact" && file) {
        await api.putRaw(
          `/environments/${target.id}/app-artifact?filename=${encodeURIComponent(file.name)}`,
          await file.arrayBuffer(),
          "application/octet-stream",
        );
      }
      await commitTarget(suite, write);
      toast("Target saved", `${suite.name} runs in ${target.name}`, "ok");
      reload();
    } catch (err: WebDynamic) {
      fail(String(err.message || err));
    }
  }
}

/** The card's one write into the suite's own defaults, committed as a version
    like every other change to that file. */
async function commitTarget(suite: WebDynamic, write: WebDynamic) {
  if (!write || write.kind === "none") return;
  const before = suite.defaults?.content ?? "";
  const content = write.kind === "suite-default-url" ? setAppKey(before, "base_url", write.value)
    : write.kind === "suite-app" ? setAppKey(before, "app", write.value)
    : setEnvBaseUrl(before, write.env, write.value);
  await api.put(`/suites/${suite.id}/files/playtest.yaml`, { content, note: "set where this suite's app runs" });
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
