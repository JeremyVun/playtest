// Applications — what this project tests, and where each one is deployed.
//
// The console talks about APPLICATIONS and ENVIRONMENTS. (The schema and the
// API call an environment a `ring`; `lib/rings.ts` explains why the two words
// exist and why only one of them is ever printed.) A person creates an
// application and points an environment at a URL; runner setup is an
// operational task documented separately, so the words "binding", "dispatch
// adapter" and "Appium" appear nowhere on the first-run path.
//
// Two surfaces, because they answer two questions. The INDEX answers "what does
// this project test?" — one scannable row per application, its key, its
// environments and what is bound to it. An APPLICATION PAGE answers "how is
// this one set up?" — its identity, each environment in full, and the suites
// that launch against it.
//
// The forms follow one rule, learned from the version that didn't: A FIELD THAT
// NEEDS A PARAGRAPH IS THE WRONG FIELD. Creating an environment asks one
// question — where do runs point — and derives the rest; everything that used
// to be explained in helper text is now either derived (the key), shown as
// feedback (which runners match these labels, what a cookie string parses to),
// conditional on being relevant (what a loopback URL means, said only under a
// loopback URL), or moved to the settings surface where it is actually used.
//
// Project-wide authorization — the providers that mint sessions and the secrets
// they reference — sits under the index, folded away: it belongs to the
// applications that use it, not to a settings tab, and most projects never open
// it.
//
// Reads are `viewer` (an editor picks an application at suite creation, and the
// launch dialog is a viewer surface); every mutation is `developer`.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { link, navigate } from "../lib/router.js";
import { page } from "../lib/shell.js";
import { hasRole } from "../lib/state.js";
import { projectPage } from "../lib/project-page.js";
import { toast, toastError, confirmModal, formModal, emptyState, errorState, formField } from "../lib/ui.js";
import { MASK, maskSecretEnv, literalSecretKeys } from "../lib/secret-mask.js";
import { parseCookieList, formatCookieList } from "../lib/defaults-form.js";
import { labelProblem, labelsMatch, parseLabels, runnerLabelsText } from "../lib/runners.js";
import {
  DRIVERS, PLATFORMS, driverLabel, driverGist, keyFromName, keyProblem,
  ringUrlProblem, ringConfigProblem, hostOf, isLoopbackUrl, environmentKeyFromUrl,
  BUILD_FROM_RUNNER, RUNNER_GUIDE,
  identityRows, withIdentities, identityProblem, sessionRefOptions,
} from "../lib/rings.js";
import { authProvidersPanel, secretsPanel } from "./application-authorization.js";

// ---------- the index ----------

/**
 * `?new=1` opens the create form on arrival. It exists so a "Create an
 * application" control elsewhere — the first-run checklist — can do what it
 * says instead of landing the reader on a page and leaving them to find the
 * button. Reload after a save drops the parameter, so the form opens once.
 */
export async function applicationsPage(projectKey: WebDynamic, query?: WebDynamic) {
  const context = projectPage(projectKey, { nav: "applications", title: "Applications" });
  if (!context) return;
  const { main, project } = context;

  const canEdit = hasRole(project.id, "developer");
  const canAdmin = hasRole(project.id, "admin");

  let applications: WebDynamic = [], suites: WebDynamic = [];
  try {
    // One request folds the environments in — the shape every picker on this
    // page and in the launch dialog needs. Suites ride along so an application
    // can say what is bound to it before anyone tries to delete it.
    const [apps, suiteList] = await Promise.all([
      api.cached(`/projects/${projectKey}/applications?include=rings`),
      api.cached(`/projects/${projectKey}/suites`, { ttl: 15_000 }).catch(() => ({ items: [] })),
    ]);
    applications = apps.items || [];
    suites = suiteList.items || [];
  } catch (err: WebDynamic) {
    return mount(main, page({ title: "Applications", body: errorState(err, () => applicationsPage(projectKey)) }));
  }

  const reload = () => applicationsPage(projectKey);
  const authSlot = h("div");
  const secretSlot = h("div");

  mount(main, page({
    title: "Applications",
    sub: "one executable surface each — a web app, an HTTP API, or a mobile build — and where each one is deployed",
    actions: canEdit
      ? [h("button.btn.primary", { onclick: () => applicationModal(projectKey, applications, null, reload) }, "+ New application")]
      : [],
    body: h("div", {},
      applications.length
        ? h("div.app-list", {},
            ...applications.map((a: WebDynamic) =>
              applicationRow(projectKey, a, suites.filter((s: WebDynamic) => s.application_id === a.id))))
        : emptyState(
            "No application yet",
            canEdit
              ? "An application is one executable surface; an environment is one deployment of it. A first web run is: create the application, point an environment at its URL, launch."
              : "A developer has to create the first application — what a suite runs against is a decision the platform can't guess.",
            canEdit
              ? h("div.empty-actions", {},
                  h("button.btn.primary", { onclick: () => applicationModal(projectKey, applications, null, reload) }, "New application"))
              : null,
          ),
      // Authorization sits under the applications it belongs to: a provider
      // mints the sessions an environment's identities name, and a secret is
      // what a provider or an environment's `secret_env` references. Folded
      // away — most projects never open either.
      canEdit
        ? h("details.advanced", { style: "margin-top:22px" },
            h("summary", {}, "Sign-in providers"),
            h("p.dim", { style: "font-size:12.5px;margin:8px 0 12px" },
              "A provider mints the short-lived sessions an environment's identities point at. Bind one to an environment and only that environment may use it; leave it unbound to share it across the project."),
            authSlot)
        : null,
      canAdmin
        ? h("details.advanced", { style: "margin-top:8px" },
            h("summary", {}, "Secret references"),
            h("p.dim", { style: "font-size:12.5px;margin:8px 0 12px" },
              "Write-only named secrets that environments and providers reference by name. Values are encrypted at rest and never shown again."),
            secretSlot)
        : null,
    ),
  }));

  if (canEdit) authProvidersPanel(projectKey, applications, authSlot);
  if (canAdmin) secretsPanel(projectKey, secretSlot);
  if (canEdit && query?.get("new")) applicationModal(projectKey, applications, null, reload);
}

/**
 * One application on the index: what it is, where it is deployed, and what
 * launches against it. The whole row is the link — an application's own page is
 * where every control for it lives, so a row with its own buttons would be two
 * places to do the same thing.
 */
function applicationRow(projectKey: WebDynamic, application: WebDynamic, bound: WebDynamic) {
  const rings = application.rings || [];
  const mobile = application.driver === "mobile";
  const a = link(`/p/${projectKey}/applications/${application.key}`, h("div.app-row", {},
    h("div.app-row-head", {},
      h("span.rowtitle", {}, application.name || application.key),
      h("span.chip", {}, driverLabel(application.driver)),
      application.platform ? h("span.chip", {}, application.platform) : null,
      h("span.mono.faint", { style: "font-size:11.5px" }, application.key),
    ),
    h("div.app-row-rings", {},
      rings.length
        ? rings.map((r: WebDynamic) => h("span.app-ring", {},
            h("span.id", {}, r.key),
            h("span.dim", {}, mobile ? BUILD_FROM_RUNNER : hostOf(r.base_url) || "no URL")))
        : h("span.faint", {}, "no environments yet — nowhere to launch"),
    ),
    h("div.app-row-suites.faint", {},
      bound.length
        ? `${bound.length} ${bound.length === 1 ? "suite" : "suites"} bound`
        : "no suites bound yet"),
  ));
  a.className = "quiet-link";
  return a;
}

// ---------- one application ----------

export async function applicationPage(projectKey: WebDynamic, applicationKey: WebDynamic) {
  const context = projectPage(projectKey, { nav: "applications", title: "Applications", loading: false });
  if (!context) return;
  const { main, project } = context;

  const canEdit = hasRole(project.id, "developer");
  const crumbs = [link(`/p/${projectKey}/applications`, "Applications"), " / ", applicationKey];
  mount(main, page({ crumbs, title: applicationKey, body: h("div.dim", {}, "Loading…") }));

  let applications: WebDynamic = [], suites: WebDynamic = [], providers: WebDynamic = [], runners: WebDynamic = [];
  try {
    [applications, suites, providers, runners] = await Promise.all([
      api.cached(`/projects/${projectKey}/applications?include=rings`).then((r: WebDynamic) => r.items || []),
      api.cached(`/projects/${projectKey}/suites`, { ttl: 15_000 }).then((r: WebDynamic) => r.items || []).catch(() => []),
      // Only a developer may read providers, and only a session reference needs
      // them: without the list the identity picker degrades to a typed
      // reference, which is what it stores anyway.
      canEdit
        ? api.cached(`/projects/${projectKey}/auth-providers`).then((r: WebDynamic) => r.items || []).catch(() => [])
        : Promise.resolve([]),
      // The fleet, so the placement field can SHOW which runners a label set
      // matches instead of explaining the matching rule in prose.
      canEdit
        ? api.cached(`/projects/${projectKey}/runners`, { ttl: 15_000 }).then((r: WebDynamic) => r.items || []).catch(() => [])
        : Promise.resolve([]),
    ]);
  } catch (err: WebDynamic) {
    return mount(main, page({ crumbs, title: applicationKey, body: errorState(err, () => applicationPage(projectKey, applicationKey)) }));
  }

  const application = applications.find((a: WebDynamic) => a.key === applicationKey);
  if (!application) {
    return mount(main, page({
      crumbs,
      title: "Application not found",
      body: emptyState(
        "No application called that",
        `Nothing in this project is keyed “${applicationKey}”. A key is permanent, so it was not renamed — it was deleted, or the link is truncated.`,
        h("div.empty-actions", {}, link(`/p/${projectKey}/applications`, h("span.btn.primary", {}, "All applications"))),
      ),
    }));
  }

  const reload = () => applicationPage(projectKey, applicationKey);
  const rings = application.rings || [];
  const bound = suites.filter((s: WebDynamic) => s.application_id === application.id);
  const mobile = application.driver === "mobile";
  const settings = { providers, runners };

  mount(main, page({
    crumbs: [link(`/p/${projectKey}/applications`, "Applications"), " / ", application.name || application.key],
    title: application.name || application.key,
    sub: driverGist(application.driver),
    actions: canEdit
      ? [
          h("button.btn", { onclick: () => applicationModal(projectKey, [], application, () => navigate(`/p/${projectKey}/applications/${application.key}`)) }, "Rename"),
          h("button.btn.danger", { onclick: () => deleteApplication(projectKey, application) }, "Delete"),
        ]
      : [],
    body: h("div", {},
      identityCard(application),

      h("div.section-head", {},
        h("div.label", {}, "Environments"),
        canEdit ? h("button.btn.btn-sm", { onclick: () => newEnvironmentModal(application, reload) }, "+ Add environment") : null,
      ),
      rings.length
        ? h("div.stack", {}, ...rings.map((r: WebDynamic) => ringCard(application, r, canEdit, settings, reload)))
        : emptyState(
            "Nowhere to launch yet",
            mobile
              ? "Name one deployment your runners hold a build for — “local”, “device-lab” — and this application is launchable."
              : "Point one at the URL your app is running at — http://127.0.0.1:4173 for a local one — and this application is launchable.",
            canEdit
              ? h("div.empty-actions", {}, h("button.btn.primary", { onclick: () => newEnvironmentModal(application, reload) }, "Add environment"))
              : null,
          ),
      mobile ? mobileBuildNote() : null,

      h("div.section-head", {}, h("div.label", {}, "Suites")),
      bound.length
        ? h("div.card", {}, h("table.rows", {},
            h("tbody", {}, ...bound.map((s: WebDynamic) => h("tr", {},
              h("td", {}, link(`/p/${projectKey}/suites/${s.slug}`, h("span.rowtitle", {}, s.name || s.slug))),
              h("td.dim", { style: "text-align:right" },
                Number.isFinite(s.story_count) ? `${s.story_count} ${s.story_count === 1 ? "story" : "stories"}` : ""),
            ))),
          ))
        : h("p.faint", { style: "font-size:12.5px;margin:2px 0 0" }, "No suites yet."),
    ),
  }));
}

/**
 * The application's identity, presented as identity rather than as fields: what
 * a runner's configuration file binds and what every run's evidence records.
 * These facts are permanent, which the page shows by having no control for them
 * rather than by explaining itself.
 */
function identityCard(application: WebDynamic) {
  return h("div.card.pad.identity-card", {},
    h("div.identity-grid", {},
      identityFact("Key", h("span.mono", {}, application.key)),
      identityFact("Surface", driverLabel(application.driver)),
      application.platform ? identityFact("Platform", application.platform === "ios" ? "iOS" : "Android") : null,
    ),
  );
}

const identityFact = (k: WebDynamic, v: WebDynamic) =>
  h("div", {}, h("div.k", {}, k), h("div.v.sm", {}, v));

/** One environment, in full: where it points, how work reaches it, who it signs in as. */
function ringCard(application: WebDynamic, ring: WebDynamic, canEdit: WebDynamic, settings: WebDynamic, reload: WebDynamic) {
  const mobile = application.driver === "mobile";
  const identities = identityRows(ring.config);
  return h("section.card.pad", {},
    h("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap" },
      h("span.id.env-key", {}, ring.key),
      ring.name && ring.name !== ring.key ? h("span.dim", { style: "font-size:12px" }, ring.name) : null,
      h("div", { style: "flex:1" }),
      canEdit
        ? h("button.btn.btn-sm", { "aria-label": `Edit environment ${application.key}/${ring.key}`, onclick: () => environmentModal(application, ring, settings, reload) }, "Edit")
        : null,
      canEdit
        ? h("button.btn.btn-sm.danger", { "aria-label": `Delete environment ${application.key}/${ring.key}`, onclick: () => deleteRing(application, ring, reload) }, "Delete")
        : null,
    ),
    h("div.ring-facts", {},
      ringFact("Where", mobile
        ? h("span.dim", {}, BUILD_FROM_RUNNER)
        : ring.base_url
          ? h("span.mono", {}, ring.base_url)
          : h("span.faint", {}, "no URL — nothing can launch here"),
        mobile || !isLoopbackUrl(ring.base_url) ? null : "On the claiming runner's own machine."),
      ringFact("Runs on", h("span", {}, runnerLabelsText(ring.runner_labels))),
      ringFact("Signs in as", identities.length
        ? h("span", {}, identities.map((i: WebDynamic) => i.name).join(", "))
        : h("span.faint", {}, "signed out")),
      Object.keys(ring.config?.app?.cookies || {}).length
        ? ringFact("Cookies", h("span.mono", {}, formatCookieList(ring.config.app.cookies)))
        : null,
      secretRefSummary(ring.config)
        ? ringFact("Secret variables", h("span.mono", {}, secretRefSummary(ring.config)))
        : null,
    ),
    h("details.advanced", { style: "margin-top:10px" },
      h("summary", {}, "The logical overlay, as stored"),
      h("p.faint", { style: "font-size:11.5px;margin:8px 0 6px" },
        "What a run against this environment merges in as ", h("span.mono", {}, `app.envs.${ring.key}`), "."),
      h("pre.mono", { style: "background:var(--bg);padding:10px;border-radius:6px;overflow:auto;font-size:12px" },
        JSON.stringify(maskSecretEnv(ring.config) ?? {}, null, 2)),
    ),
  );
}

const ringFact = (k: WebDynamic, v: WebDynamic, why: WebDynamic = null) =>
  h("div.ring-fact", {}, h("div.k", {}, k), h("div", {}, v, why ? h("div.faint", { style: "font-size:11.5px;margin-top:2px" }, why) : null));

/**
 * The mobile answer to "where do I set the build?", on the page where the
 * question is asked. Nothing here is a control, deliberately: the platform holds
 * none of these facts, and a field for one would be a field that lies.
 */
const mobileBuildNote = () =>
  h("div.card.pad", { style: "margin-top:14px" },
    h("div.label", { style: "margin-bottom:6px" }, "Where the build comes from"),
    h("p.dim", { style: "font-size:12.5px;margin:0 0 8px" },
      "The build's path on disk, the Appium server that drives it and the device it targets are facts only a runner can know, so no environment holds them and nothing on this page can set them. "
      + "The runner that claims a mobile run reads all three from a file on its own disk, bound to these exact keys:"),
    h("pre.mono", { style: "background:var(--bg2);padding:10px;border-radius:6px;overflow:auto;font-size:12px" },
      "targets:\n  - project: <project key>\n    application: <application key>\n    environment: <environment key>\n    platform: …\n    app: /path/to/your/build\n    backend: …"),
    h("p.faint", { style: "font-size:11.5px;margin:8px 0 0" },
      "Add one explicit target entry per environment, then restart the runner. The full reference — managed or external Appium, devices, credentials — is ",
      h("span.mono", {}, RUNNER_GUIDE), "."),
  );

/** An environment's secret_env references, never their values. */
function secretRefSummary(config: WebDynamic) {
  const entries = Object.entries(config?.secret_env || {});
  if (!entries.length) return null;
  return entries.map(([k, v]: WebDynamic) =>
    typeof v === "object" && v !== null
      ? `${k}=${v.$secret ? `$secret:${v.$secret}` : v.$session ? `$session:${v.$session}` : "ref"}`
      : `${k}=${MASK}`).join(", ");
}

// ---------- application form ----------

/**
 * One application, as a form. Creating asks two questions — what it is called
 * and what surface it drives. The key is derived from the name and never asked:
 * it is a slug of a word already typed, so a field for it was a second field
 * for one answer. Editing asks for the name alone.
 */
export function applicationModal(projectKey: WebDynamic, existing: WebDynamic[], application: WebDynamic, done: WebDynamic) {
  const editing = !!application;
  const close = formModal(editing ? `Rename ${application.key}` : "New application", () => {
    const name = h("input", { type: "text", value: application?.name || "", placeholder: "Todo Web" });
    const driver = h("select", { "aria-label": "Surface", onchange: paintDriver },
      ...DRIVERS.map((d) => h("option", { value: d }, driverLabel(d))));
    const driverHint = h("div.hint", {}, driverGist("web"));
    const platformSlot = h("div");
    const platform = h("select", { "aria-label": "Platform" },
      ...PLATFORMS.map((p) => h("option", { value: p }, p === "ios" ? "iOS" : "Android")));
    const problem = h("div.preview-warn", { role: "alert", style: "display:none;margin:-6px 0 10px" });
    const saveBtn = h("button.btn.primary", { type: "submit" }, editing ? "Save" : "Create");

    paintDriver();
    return h("form", { onsubmit: submit },
      formField("Name", name),
      editing
        ? null
        : h("div", {},
            h("div.field", {}, h("div.field-label", {}, "Surface"), driver, driverHint),
            platformSlot),
      problem,
      h("div.modal-actions", {},
        h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"),
        saveBtn),
    );

    function paintDriver() {
      if (editing) return;
      driverHint.textContent = driverGist(driver.value);
      mount(platformSlot, driver.value === "mobile"
        ? formField("Platform", platform, "Core picks XCUITest or UiAutomator2 from it, so a mobile application names one.")
        : null);
    }

    async function submit(e: WebDynamic) {
      e.preventDefault();
      problem.style.display = "none";
      if (!name.value.trim()) return fail("Name this application — it is how it reads everywhere else.");
      if (editing) {
        saveBtn.disabled = true;
        try {
          await api.put(`/applications/${application.id}`, { name: name.value.trim() });
          close();
          toast("Application saved", name.value.trim(), "ok");
          done();
        } catch (err: WebDynamic) { saveBtn.disabled = false; fail(String(err.message || err)); }
        return;
      }
      const chosenDriver = driver.value;
      // The key is the name, slugged. Nothing on screen says so, so anything
      // wrong with it has to be said about the name a person actually typed.
      const keyValue = keyFromName(name.value);
      if (!keyValue) { name.focus(); return fail("Give this application a name with letters or digits in it."); }
      const bad = keyProblem(keyValue, existing, { kind: "application" });
      if (bad) { name.focus(); return fail(bad); }
      saveBtn.disabled = true;
      try {
        const created = await api.post(`/projects/${projectKey}/applications`, {
          key: keyValue,
          name: name.value.trim(),
          driver: chosenDriver,
          ...(chosenDriver === "mobile" ? { platform: platform.value } : {}),
        });
        close();
        toast("Application created", `${created.key} — add an environment to make it launchable`, "ok");
        // Land on the new application's own page: an environment is the next
        // step, and this is where the control for it is.
        navigate(`/p/${projectKey}/applications/${created.key}`);
      } catch (err: WebDynamic) { saveBtn.disabled = false; fail(String(err.message || err)); }
    }

    function fail(message: WebDynamic) {
      problem.style.display = "";
      problem.textContent = message;
    }
  });
  return close;
}

async function deleteApplication(projectKey: WebDynamic, application: WebDynamic) {
  const ok = await confirmModal({
    title: `Delete ${application.key}?`,
    body: "Only possible while nothing points at it: no environments, no suites, no run groups. Nothing is removed on your behalf.",
    confirmLabel: "Delete application",
    danger: true,
  });
  if (!ok) return;
  // A refusal from here NAMES what still refers to it — show the server's own
  // sentence rather than "delete failed".
  try { await api.del(`/applications/${application.id}`); }
  catch (err: WebDynamic) { return toastError(err); }
  toast("Application deleted", application.key, "ok");
  navigate(`/p/${projectKey}/applications`);
}

// ---------- creating an environment ----------

/**
 * A new environment, as ONE question: where do runs point?
 *
 * The form this replaces asked seven, in this order — key, name, URL, runner
 * labels, cookies, a discovery permission, sign-in identities — plus a JSON
 * overlay, and carried three hundred words of helper text to explain them. All
 * seven were optional except two, and the two that weren't asked the same thing
 * twice: a key AND a display name, when the launch picker only ever shows the
 * key.
 *
 * So: the URL is the question, and it already contains the answer to the other
 * one. `staging.acme.com` is called staging; `localhost:4173` is called local
 * (see `environmentKeyFromUrl`). The derived name is SHOWN, never hidden — a
 * guess a person cannot see is a guess they cannot correct — with one control
 * to override it. Everything else is configuration of an environment that
 * exists, and lives on the environment, one Edit away.
 */
export function newEnvironmentModal(application: WebDynamic, done: WebDynamic) {
  const mobile = application.driver === "mobile";
  const taken = application.rings || [];
  const close = formModal(`Add an environment to ${application.name || application.key}`, () => {
    const url = h("input", {
      type: "text", placeholder: "https://staging.example.com", autocomplete: "off", spellcheck: "false",
      oninput: settleNaming,
    });
    const name = h("input", { type: "text", placeholder: "staging", oninput: paintNaming });
    const namingSlot = h("div.env-naming");
    const renameHint = h("div.hint");
    // Mobile has no URL to derive from, so it types the name and watches the
    // pair a runner will have to hold a build for.
    const keyPreview = h("span.mono", {}, "…");
    const problem = h("div.preview-warn", { role: "alert", style: "display:none" });
    const saveBtn = h("button.btn.primary", { type: "submit" }, "Add environment");
    // Until someone opens the rename control the name is the URL's to give, and
    // keeps updating as the URL is typed.
    let renaming = mobile;
    // What the naming line currently reads, so a repaint that would change
    // nothing changes nothing. Not an optimization: re-mounting the line
    // rebuilds the Rename button, and a button replaced between mousedown and
    // mouseup never receives the click that was on its way to it.
    let shown = "";
    let settleTimer: WebDynamic = null;

    paintNaming();
    return h("form", { onsubmit: submit },
      h("div.modal-body", {},
        mobile
          // What supplies the build is answered on the page behind this dialog,
          // where it stays true after the dialog is gone — so this asks the one
          // thing only a person can answer, and shows what it will key.
          ? h("div", {},
              formField("Name", name),
              h("p.field-note", {}, "A runner claiming a run here supplies the build for ",
                h("span.mono", {}, `${application.key}/`), keyPreview, "."))
          : h("div", {},
              formField("Where do runs point?", url),
              namingSlot),
      ),
      h("div.modal-foot", {},
        problem,
        h("div.modal-actions", {},
          h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"),
          saveBtn)),
    );

    /** The derived key, or the one typed over it. */
    function chosenKey(): string {
      if (renaming) return keyFromName(name.value);
      return environmentKeyFromUrl(url.value, taken);
    }

    /**
     * The guess waits for a pause in typing. A half-typed host is a valid URL
     * with a nonsense hostname — `https://sta` parses, names no deployment, and
     * so derives "production" — and watching the word "production" flash up
     * while you type a staging URL is exactly the kind of alarm a form should
     * never raise about itself.
     */
    function settleNaming() {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(paintNaming, 250);
    }

    /**
     * What this environment will be called, said as a fact rather than asked as
     * a field — and only once there is a URL to derive it from. The loopback
     * note is the model's one genuinely surprising rule, so it appears exactly
     * where it is true and nowhere else.
     */
    function paintNaming() {
      const key = chosenKey();
      if (mobile) {
        keyPreview.textContent = key || "…";
        return;
      }
      if (renaming) {
        // The field is built once and then left alone. Re-mounting it would
        // remove the input being typed into, and removing a focused node blurs
        // it — so only the hint under it is repainted.
        if (shown !== "renaming") {
          shown = "renaming";
          mount(namingSlot,
            h("div.field", { style: "margin:14px 0 0" },
              h("label.field-label", { for: nameId() }, "Called"),
              name,
              renameHint));
        }
        return mount(renameHint,
          key && key !== name.value.trim() ? h("span", {}, "Stored as ", h("span.mono", {}, key), ".") : null);
      }
      const line = `${key}|${isLoopbackUrl(url.value)}`;
      if (shown === line) return;
      shown = line;
      if (!key) return mount(namingSlot);
      mount(namingSlot,
        h("div.env-naming-line", {},
          h("span.faint", {}, "Called"),
          h("span.id", {}, key),
          h("button.linkish", {
            type: "button",
            onclick: () => { renaming = true; name.value = key; paintNaming(); name.focus(); name.select(); },
          }, "Rename"),
        ),
        isLoopbackUrl(url.value)
          ? h("p.field-note", {}, "Resolved on the claiming runner's own machine, not here.")
          : null,
      );
    }

    function nameId() {
      if (!name.id) name.id = "env-name";
      return name.id;
    }

    async function submit(e: WebDynamic) {
      e.preventDefault();
      problem.style.display = "none";
      const urlBad = ringUrlProblem(url.value, application.driver);
      if (urlBad) { if (!mobile) url.focus(); return fail(urlBad); }
      const key = chosenKey();
      const bad = keyProblem(key, taken, { kind: "environment", scope: `Application “${application.key}”` });
      if (bad) { if (renaming) name.focus(); return fail(bad); }
      saveBtn.disabled = true;
      try {
        const created = await api.post(`/applications/${application.id}/rings`, {
          key,
          name: renaming && name.value.trim() ? name.value.trim() : key,
          ...(mobile ? {} : { base_url: url.value.trim() }),
        });
        close();
        toast("Environment added", `${application.key}/${created.key}${created.base_url ? ` → ${hostOf(created.base_url)}` : ""}`, "ok");
        done();
      } catch (err: WebDynamic) { saveBtn.disabled = false; fail(String(err.message || err)); }
    }

    function fail(message: WebDynamic) {
      problem.style.display = "";
      problem.textContent = message;
    }
  });
  return close;
}

// ---------- editing an environment ----------

/**
 * One environment's settings, in sections that each answer a question a person
 * actually arrives with: where does it point, who does it sign in as, which
 * machines run it, and what else is in the overlay.
 *
 * The named fields and the overlay document are two views of ONE document, the
 * way the suite-defaults editor treats YAML: every field writes into the JSON,
 * the JSON is what saves, and a key no field knows about survives verbatim.
 * They therefore cannot disagree at save time — which is what lets the sign-in
 * identities be a real editor rather than a paragraph of JSON to hand-write.
 */
export function environmentModal(application: WebDynamic, ring: WebDynamic, settings: WebDynamic, done: WebDynamic) {
  const mobile = application.driver === "mobile";
  const providers = settings?.providers || [];
  const runners = settings?.runners || [];
  const close = formModal(`${application.key} / ${ring.key}`, () => {
    const name = h("input", { type: "text", value: ring.name || ring.key, "aria-label": "Name" });
    const url = h("input", { type: "text", value: ring.base_url || "", placeholder: "https://staging.example.com", oninput: paintUrlNote });
    const urlNote = h("div.field-note-slot");
    const cookies = h("input", {
      type: "text", value: formatCookieList(ring?.config?.app?.cookies),
      placeholder: "slot=blue; feature_x=on", oninput: paintCookies, onchange: flush,
    });
    const cookieNote = h("div.field-note-slot");
    const labels = h("input", {
      type: "text", value: (ring?.runner_labels || []).join(", "), placeholder: "macos, ios-sim",
      oninput: paintPlacement,
    });
    const placementNote = h("div.field-note-slot");
    const config = h("textarea.code", { style: "min-height:130px" },
      JSON.stringify(maskSecretEnv(ring?.config) ?? {}, null, 2));
    const identitySlot = h("div.identity-rows");
    const jsonWarn = h("div.preview-warn", { style: "display:none;margin:-6px 0 10px" });
    const literalWarn = h("div.preview-warn", { style: "display:none;margin:-6px 0 10px" });
    const problem = h("div.preview-warn", { role: "alert", style: "display:none" });
    const saveBtn = h("button.btn.primary", { type: "submit" }, "Save");
    const refs = sessionRefOptions(providers, ring?.id ?? null);
    let identities: WebDynamic = identityRows(ring?.config);

    config.addEventListener("input", () => {
      let parsed: WebDynamic = null;
      try { parsed = JSON.parse(config.value); } catch { /* mid-edit — submit reports it */ }
      jsonWarn.style.display = parsed ? "none" : "";
      jsonWarn.textContent = parsed ? "" : "This isn't valid JSON yet — the fields above can't write into it until it is.";
      if (!parsed) return;
      // The document moved, so the fields re-read it. One direction each way, so
      // neither view can drift from the other.
      cookies.value = formatCookieList(parsed?.app?.cookies);
      paintCookies();
      identities = identityRows(parsed);
      paintIdentities();
      const keys = literalSecretKeys(parsed);
      literalWarn.style.display = keys.length ? "" : "none";
      literalWarn.textContent = keys.length
        ? `${keys.join(", ")}: pasted values are stored readable by anyone with this page. Prefer {"$secret": "name"} — add the name under Secret references.`
        : "";
    });

    paintIdentities();
    paintUrlNote();
    paintCookies();
    paintPlacement();
    return h("form.env-form", { onsubmit: submit },
      h("div.modal-body", {},
        formField("Name", name),
        h("p.field-note", {}, "Runs record this environment as ", h("span.mono", {}, `${application.key}/${ring.key}`),
          " — that never changes."),

        section("Where it points",
          mobile
            ? h("p.dim.section-caption", {},
                "A mobile environment holds no URL, build path, device or Appium endpoint. The runner that claims this environment's work reads all four from its own configuration file, keyed by application and environment key.")
            : h("div", {}, formField("URL", url), urlNote)),

        section("Sign-in",
          h("p.section-caption", {}, "The names a story picks with ", h("span.mono", {}, "auth: member"), ". A story with no ",
            h("span.mono", {}, "auth:"), " runs signed out."),
          identitySlot),

        section("Placement",
          h("div", {}, formField("Runner labels", labels), placementNote)),

        h("details.advanced", { style: "margin-top:18px" },
          h("summary", {}, "Advanced"),
          h("div", { style: "margin-top:12px" },
            mobile ? null : h("div", {}, formField("Cookies", cookies), cookieNote),
            formField("Logical overlay", config),
            jsonWarn,
            literalWarn,
            h("div.faint", { style: "font-size:11.5px;margin:-6px 0 10px" },
              "Merged into a run as ", h("span.mono", {}, `app.envs.${ring.key}`), ". "
              + `Secret variables: {"secret_env": {"TOKEN": {"$secret": "name"}}} — stored values show as ${MASK} and are kept unless you replace them. `
              + "A build path, a device or an Appium endpoint cannot go here: the claiming runner resolves those."),
          ),
        ),
      ),
      h("div.modal-foot", {},
        problem,
        h("div.modal-actions", {},
          h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"),
          saveBtn)),
    );

    /** A titled group of fields — one caption at most, never one per field. */
    function section(title: WebDynamic, ...children: WebDynamic[]) {
      return h("section.form-section", {}, h("h3.form-section-title", {}, title), ...children);
    }

    /** The one genuinely surprising thing about a URL here, said only when true. */
    function paintUrlNote() {
      mount(urlNote, isLoopbackUrl(url.value)
        ? h("p.field-note", {}, "Resolved on the claiming runner's own machine, not here.")
        : null);
    }

    /** What that cookie string actually parses to — shown instead of described. */
    function paintCookies() {
      let parsed: WebDynamic = null;
      try { parsed = parseCookieList(cookies.value); }
      catch (err: WebDynamic) {
        return mount(cookieNote, h("p.field-note.warn", {}, String(err.message || err)));
      }
      const pairs = Object.entries(parsed || {});
      mount(cookieNote, pairs.length
        ? h("p.field-note", {}, "Set before the first navigation: ",
            ...pairs.map(([k, v]: WebDynamic, i: WebDynamic) =>
              h("span", {}, i ? ", " : "", h("span.mono", {}, `${k}=${v}`))))
        : null);
    }

    /**
     * Which runners these labels reach — the matching rule DEMONSTRATED rather
     * than stated. The sentence this replaces ("runs go to a runner advertising
     * ALL of these labels — that is the whole matching rule") was the longest
     * hint in the dialog, and still left a person to work out whether they had
     * such a runner.
     */
    function paintPlacement() {
      const wanted = parseLabels(labels.value);
      const standing = runners.filter((r: WebDynamic) => !r.revoked_at);
      if (!wanted.length) {
        return mount(placementNote, h("p.field-note", {},
          standing.length
            ? `Any of this project's ${standing.length} ${standing.length === 1 ? "runner" : "runners"} can take these runs.`
            : "Any runner in this project can take these runs."));
      }
      const matching = standing.filter((r: WebDynamic) => labelsMatch(wanted, r.labels));
      mount(placementNote, matching.length
        ? h("p.field-note", {}, `Runs here go to ${matching.map((r: WebDynamic) => r.name).filter(Boolean).slice(0, 4).join(", ")}`
            + `${matching.length > 4 ? ` and ${matching.length - 4} more` : ""}.`)
        : h("p.field-note.warn", {},
            standing.length
              ? "No registered runner advertises all of these — runs here would wait, then fail."
              : "This project has no runners registered yet."));
    }

    /** The identity rows, and the one control that adds another. */
    function paintIdentities() {
      mount(identitySlot,
        ...identities.map((row: WebDynamic, i: WebDynamic) => identityRow(row, i)),
        h("button.btn.btn-sm", {
          type: "button", style: "margin-top:8px",
          onclick: () => {
            identities = [...identities, { name: "", kind: refs.length ? "session" : "secret", ref: "", value: null }];
            flush();
            paintIdentities();
            // The row just added, never the first one: the cursor landing in an
            // identity that already has a name renames it as you type.
            const rows = identitySlot.querySelectorAll(".identity-row");
            rows[rows.length - 1]?.querySelector("input")?.focus();
          },
        }, identities.length ? "+ Add identity" : "+ Add an identity"),
      );
    }

    function identityRow(row: WebDynamic, i: WebDynamic) {
      const nameIn = h("input", {
        type: "text", value: row.name, placeholder: "member", "aria-label": `Identity ${i + 1} name`,
        oninput: (e: WebDynamic) => { identities[i].name = e.target.value; flush(); },
      });
      // A custom shape the form cannot represent is SAID, never silently
      // rewritten — the overlay view is where it is edited.
      const value = row.kind === "custom"
        ? h("div.dim", { style: "font-size:12px" }, "a shape this form doesn't edit — see the overlay below")
        : h("div.identity-ref", {},
            kindSelect(row, i),
            refInput(row, i));
      return h("div.identity-row", {},
        nameIn,
        value,
        h("button.btn.btn-sm.danger", {
          type: "button", "aria-label": `Remove identity ${row.name || i + 1}`,
          onclick: () => { identities = identities.filter((_: WebDynamic, n: WebDynamic) => n !== i); flush(); paintIdentities(); },
        }, "Remove"),
      );
    }

    function kindSelect(row: WebDynamic, i: WebDynamic) {
      return h("select", {
        "aria-label": `Identity ${row.name || i + 1} source`,
        onchange: (e: WebDynamic) => { identities[i] = { ...identities[i], kind: e.target.value, ref: "" }; flush(); paintIdentities(); },
      },
        h("option", { value: "session", selected: row.kind === "session" || undefined }, "Minted by a provider"),
        h("option", { value: "secret", selected: row.kind === "secret" || undefined }, "A stored sign-in state"),
        h("option", { value: "path", selected: row.kind === "path" || undefined }, "A file on the runner"));
    }

    function refInput(row: WebDynamic, i: WebDynamic) {
      const set = (v: WebDynamic) => { identities[i].ref = v; flush(); };
      if (row.kind === "session" && refs.length) {
        return h("select", {
          "aria-label": `Identity ${row.name || i + 1} session`,
          onchange: (e: WebDynamic) => set(e.target.value),
        },
          h("option", { value: "" }, "Pick a provider identity…"),
          ...refs.map((r: WebDynamic) => h("option", { value: r, selected: row.ref === r || undefined }, r)));
      }
      const placeholder = row.kind === "session" ? "provider/identity"
        : row.kind === "secret" ? "the secret's name"
        : ".playtest-env/member.json";
      return h("input", {
        type: "text", value: row.ref, placeholder,
        "aria-label": `Identity ${row.name || i + 1} reference`,
        oninput: (e: WebDynamic) => set(e.target.value),
      });
    }

    /** The named fields, written into the one document they are views of. */
    function flush() {
      let doc: WebDynamic;
      try { doc = JSON.parse(config.value || "{}"); } catch { return; }
      let parsed;
      try { parsed = parseCookieList(cookies.value); }
      catch { return; }  // said under the field by paintCookies, not as a toast
      const app: WebDynamic = { ...(doc.app || {}) };
      if (parsed) app.cookies = parsed;
      else delete app.cookies;
      if (Object.keys(app).length) doc.app = app;
      else delete doc.app;
      // Only complete rows reach the document; a half-typed one would write an
      // identity named "" on every keystroke.
      doc = withIdentities(doc, identities.filter((r: WebDynamic) => String(r.name || "").trim()));
      config.value = JSON.stringify(doc, null, 2);
    }

    async function submit(e: WebDynamic) {
      e.preventDefault();
      problem.style.display = "none";
      const identityBad = identityProblem(identities);
      if (identityBad) return fail(identityBad);
      flush();
      let doc;
      try { doc = JSON.parse(config.value || "{}"); } catch { return fail("The overlay isn't valid JSON."); }
      const overlayBad = ringConfigProblem(doc);
      if (overlayBad) return fail(overlayBad);
      const urlBad = ringUrlProblem(url.value, application.driver);
      if (urlBad) { if (!mobile) url.focus(); return fail(urlBad); }
      const runnerLabels = parseLabels(labels.value);
      const labelIssue = labelProblem(runnerLabels);
      if (labelIssue) return fail(labelIssue);
      // An untouched mask keeps the stored value; the browser never round-trips
      // the literal through the textarea.
      for (const [k, v] of Object.entries(doc?.secret_env || {})) {
        if (v !== MASK) continue;
        const stored = ring?.config?.secret_env?.[k];
        if (stored === undefined) return fail(`"${k}" is ${MASK} — that key has no stored value to keep. Paste a value or a {"$secret": …} reference.`);
        doc.secret_env[k] = stored;
      }
      saveBtn.disabled = true;
      try {
        await api.put(`/rings/${ring.id}`, {
          name: name.value.trim() || ring.key,
          ...(mobile ? {} : { base_url: url.value.trim() }),
          runner_labels: runnerLabels,
          config: doc,
        });
        close();
        toast("Environment saved", `${application.key}/${ring.key}`, "ok");
        done();
      } catch (err: WebDynamic) { saveBtn.disabled = false; fail(String(err.message || err)); }
    }

    function fail(message: WebDynamic) {
      problem.style.display = "";
      problem.textContent = message;
    }
  });
  return close;
}

async function deleteRing(application: WebDynamic, ring: WebDynamic, reload: WebDynamic) {
  const ok = await confirmModal({
    title: `Delete ${application.key}/${ring.key}?`,
    body: "Only possible while no run group and no auth provider reference it — run history records where it pointed, and a bound provider would lose its scope.",
    confirmLabel: "Delete environment",
    danger: true,
  });
  if (!ok) return;
  try { await api.del(`/rings/${ring.id}`); }
  catch (err: WebDynamic) { return toastError(err); }
  toast("Environment deleted", `${application.key}/${ring.key}`, "ok");
  reload();
}
