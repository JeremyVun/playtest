// Applications — what this project tests, and where each one is deployed.
//
// The console talks about APPLICATIONS. A person creates an application target
// and gives each ring a URL; runner setup is an operational task documented
// separately, so the words "binding", "dispatch adapter" and "Appium" appear
// nowhere on the first-run path.
//
// Two surfaces, because they answer two questions. The INDEX answers "what does
// this project test?" — one scannable row per application, its key, its rings
// and what is bound to it. An APPLICATION PAGE answers "how is this one set
// up?" — its identity, each ring in full, and the suites that launch against
// it. Folding both into one page meant a project with three applications and
// nine rings opened on a wall, and the ring detail that matters when you are
// setting one up had nowhere to go.
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
import { renderFrame, page } from "../lib/shell.js";
import { state, hasRole } from "../lib/state.js";
import { toast, toastError, confirmModal, formModal, emptyState, errorState, formField } from "../lib/ui.js";
import { MASK, maskSecretEnv, literalSecretKeys } from "../lib/secret-mask.js";
import { parseCookieList, formatCookieList } from "../lib/defaults-form.js";
import { labelProblem, parseLabels, runnerLabelsText } from "../lib/runners.js";
import {
  DRIVERS, PLATFORMS, driverLabel, driverGist, keyFromName, keyProblem,
  ringUrlProblem, ringConfigProblem, hostOf, KEY_IS_PERMANENT, BUILD_FROM_RUNNER, RUNNER_GUIDE,
  identityRows, withIdentities, identityProblem, sessionRefOptions,
} from "../lib/rings.js";

// ---------- the index ----------

export async function applicationsPage(projectKey: WebDynamic) {
  const main = renderFrame({ projectKey, nav: "applications" });
  const project = state.projectByKey.get(projectKey);
  if (!project) return mount(main, page({ title: "Applications", body: emptyState("Not found", "No such project.") }));

  const canEdit = hasRole(project.id, "developer");
  const canAdmin = hasRole(project.id, "admin");
  mount(main, page({ title: "Applications", body: h("div.dim", {}, "Loading…") }));

  let applications: WebDynamic = [], suites: WebDynamic = [];
  try {
    // One request folds the rings in — the shape every picker on this page and
    // in the launch dialog needs. Suites ride along so an application can say
    // what is bound to it before anyone tries to delete it.
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
    sub: "one executable surface each — a web app, an HTTP API, or a mobile build — and the rings it is deployed to",
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
              ? "An application is one executable surface, and a ring is one deployment of it. A first web run is: create the application, give ring “local” its URL, launch."
              : "A developer has to create the first application — what a suite runs against is a decision the platform can't guess.",
            canEdit
              ? h("div.empty-actions", {},
                  h("button.btn.primary", { onclick: () => applicationModal(projectKey, applications, null, reload) }, "New application"))
              : null,
          ),
      // Authorization sits under the applications it belongs to: a provider
      // mints the sessions a ring's identities name, and a secret is what a
      // provider or a ring's `secret_env` references. Folded away — most
      // projects never open either.
      canEdit
        ? h("details.advanced", { style: "margin-top:22px" },
            h("summary", {}, "Sign-in providers"),
            h("p.dim", { style: "font-size:12.5px;margin:8px 0 12px" },
              "A provider mints the short-lived sessions a ring's identities point at. Bind one to a ring and only that ring may use it; leave it unbound to share it across the project."),
            authSlot)
        : null,
      canAdmin
        ? h("details.advanced", { style: "margin-top:8px" },
            h("summary", {}, "Secret references"),
            h("p.dim", { style: "font-size:12.5px;margin:8px 0 12px" },
              "Write-only named secrets that rings and providers reference by name. Values are encrypted at rest and never shown again."),
            secretSlot)
        : null,
    ),
  }));

  if (canEdit) authProvidersPanel(projectKey, applications, authSlot);
  if (canAdmin) secretsPanel(projectKey, secretSlot);
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
        : h("span.faint", {}, "no rings yet — nowhere to launch"),
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
  const main = renderFrame({ projectKey, nav: "applications" });
  const project = state.projectByKey.get(projectKey);
  if (!project) return mount(main, page({ title: "Applications", body: emptyState("Not found", "No such project.") }));

  const canEdit = hasRole(project.id, "developer");
  const crumbs = [link(`/p/${projectKey}/applications`, "Applications"), " / ", applicationKey];
  mount(main, page({ crumbs, title: applicationKey, body: h("div.dim", {}, "Loading…") }));

  let applications: WebDynamic = [], suites: WebDynamic = [], providers: WebDynamic = [];
  try {
    [applications, suites, providers] = await Promise.all([
      api.cached(`/projects/${projectKey}/applications?include=rings`).then((r: WebDynamic) => r.items || []),
      api.cached(`/projects/${projectKey}/suites`, { ttl: 15_000 }).then((r: WebDynamic) => r.items || []).catch(() => []),
      // Only a developer may read providers, and only a session reference needs
      // them: without the list the identity picker degrades to a typed
      // reference, which is what it stores anyway.
      canEdit
        ? api.cached(`/projects/${projectKey}/auth-providers`).then((r: WebDynamic) => r.items || []).catch(() => [])
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
        h("div.label", {}, "Rings"),
        h("span.faint", {},
          mobile
            ? "One deployment each — its routing, its sign-ins, and the build a runner holds for it."
            : "One deployment each — its URL, the runners that may take its work, and whether discovery studies are allowed there."),
        canEdit ? h("button.btn.btn-sm", { onclick: () => ringModal(application, null, providers, reload) }, "+ New ring") : null,
      ),
      rings.length
        ? h("div.stack", {}, ...rings.map((r: WebDynamic) => ringCard(application, r, canEdit, providers, reload)))
        : emptyState(
            "No rings yet",
            mobile
              ? "A mobile ring names one deployment your runners hold a build for — “local”, “device-lab”. Until one exists there is nowhere to launch."
              : "Add “local” with http://127.0.0.1:4173, or “staging” with its URL, and this application is launchable. Until one exists there is nowhere to launch.",
            canEdit
              ? h("div.empty-actions", {}, h("button.btn.primary", { onclick: () => ringModal(application, null, providers, reload) }, "New ring"))
              : null,
          ),
      mobile ? mobileBuildNote() : null,

      h("div.section-head", {}, h("div.label", {}, "Suites"),
        h("span.faint", {}, "the stories that launch against this application, bound at creation and never rebound")),
      bound.length
        ? h("div.card", {}, h("table.rows", {},
            h("tbody", {}, ...bound.map((s: WebDynamic) => h("tr", {},
              h("td", {}, link(`/p/${projectKey}/suites/${s.slug}`, h("span.rowtitle", {}, s.name || s.slug))),
              h("td.dim", { style: "text-align:right" },
                Number.isFinite(s.story_count) ? `${s.story_count} ${s.story_count === 1 ? "story" : "stories"}` : ""),
            ))),
          ))
        : h("p.faint", { style: "font-size:12.5px;margin:2px 0 0" },
            "Nothing is bound to it yet. A suite picks its application when it is created, under Suites."),
    ),
  }));
}

/**
 * The application's identity, presented as identity rather than as fields: this
 * is what a runner's configuration file binds and what every run's evidence
 * records, so the page says the three permanent facts and then says why they are
 * permanent — behind a disclosure, because the answer is only wanted once.
 */
function identityCard(application: WebDynamic) {
  return h("div.card.pad.identity-card", {},
    h("div.identity-grid", {},
      identityFact("Key", h("span.mono", {}, application.key)),
      identityFact("Surface", driverLabel(application.driver)),
      application.platform ? identityFact("Platform", application.platform === "ios" ? "iOS" : "Android") : null,
    ),
    h("details.advanced", { style: "margin-top:12px" },
      h("summary", {}, "Why can't these change?"),
      h("p.dim", { style: "font-size:12.5px;margin:8px 0 0" }, KEY_IS_PERMANENT.application),
      h("p.dim", { style: "font-size:12.5px;margin:6px 0 0" },
        "The surface is permanent for a different reason: it decides the driver every story here runs under. A web app and its iOS build are two applications, not one with two modes."),
    ),
  );
}

const identityFact = (k: WebDynamic, v: WebDynamic) =>
  h("div", {}, h("div.k", {}, k), h("div.v.sm", {}, v));

/** One ring, in full: where it points, how work reaches it, who it signs in as. */
function ringCard(application: WebDynamic, ring: WebDynamic, canEdit: WebDynamic, providers: WebDynamic, reload: WebDynamic) {
  const mobile = application.driver === "mobile";
  const identities = identityRows(ring.config);
  return h("section.card.pad", {},
    h("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap" },
      h("span.id", {}, ring.key),
      ring.name && ring.name !== ring.key ? h("span.dim", { style: "font-size:12px" }, ring.name) : null,
      ring.discovery_allowed ? h("span.chip", { title: "Discovery studies may run here" }, "discovery allowed") : null,
      h("div", { style: "flex:1" }),
      canEdit
        ? h("button.btn.btn-sm", { "aria-label": `Edit ring ${application.key}/${ring.key}`, onclick: () => ringModal(application, ring, providers, reload) }, "Edit")
        : null,
      canEdit
        ? h("button.btn.btn-sm.danger", { "aria-label": `Delete ring ${application.key}/${ring.key}`, onclick: () => deleteRing(application, ring, reload) }, "Delete")
        : null,
    ),
    h("div.ring-facts", {},
      ringFact("Where", mobile
        ? h("span.dim", {}, BUILD_FROM_RUNNER)
        : ring.base_url
          ? h("span.mono", {}, ring.base_url)
          : h("span.faint", {}, "no URL — this ring can't be launched against"),
        mobile
          ? "A mobile ring holds no URL. Nothing here stores the build."
          : "Read from the claiming runner's network position, so a loopback URL means that runner's own machine."),
      ringFact("Runs on", h("span", {}, runnerLabelsText(ring.runner_labels)),
        "A run goes to a runner advertising every one of these labels."),
      ringFact("Signs in as", identities.length
        ? h("span", {}, identities.map((i: WebDynamic) => i.name).join(", "))
        : h("span.faint", {}, "signed out"),
        identities.length
          ? "A story picks one of these by name with “auth:”."
          : "No identities declared, so every story here runs signed out."),
      Object.keys(ring.config?.app?.cookies || {}).length
        ? ringFact("Cookies", h("span.mono", {}, formatCookieList(ring.config.app.cookies)),
            "Set before the first navigation on every web run against this ring.")
        : null,
      secretRefSummary(ring.config)
        ? ringFact("Secret variables", h("span.mono", {}, secretRefSummary(ring.config)),
            "Delivered to setup scripts and hooks; values never leave the platform.")
        : null,
    ),
    h("details.advanced", { style: "margin-top:10px" },
      h("summary", {}, "The logical overlay, as stored"),
      h("p.faint", { style: "font-size:11.5px;margin:8px 0 6px" },
        "What a run against this ring merges in as ", h("span.mono", {}, `app.envs.${ring.key}`), "."),
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
      "The build's path on disk, the Appium server that drives it and the device it targets are facts only a runner can know, so no ring holds them and nothing on this page can set them. "
      + "The runner that claims a mobile run reads all three from a file on its own disk, keyed by these exact keys:"),
    h("pre.mono", { style: "background:var(--bg2);padding:10px;border-radius:6px;overflow:auto;font-size:12px" },
      "targets:\n  <application key>:\n    <ring key>:\n      platform: …\n      app: /path/to/your/build\n      backend: …"),
    h("p.faint", { style: "font-size:11.5px;margin:8px 0 0" },
      "Three lines per ring, then restart the runner. The full reference — managed or external Appium, devices, credentials — is ",
      h("span.mono", {}, RUNNER_GUIDE), "."),
  );

/** A ring's secret_env references, never their values. */
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
 * One application, as a form. Creating asks for identity — a name, the key that
 * name suggests, and the surface it drives. Editing asks for the name alone,
 * because everything else is what a runner and a run's evidence call it.
 */
export function applicationModal(projectKey: WebDynamic, existing: WebDynamic[], application: WebDynamic, done: WebDynamic) {
  const editing = !!application;
  const close = formModal(editing ? `Rename ${application.key}` : "New application", () => {
    const name = h("input", { type: "text", value: application?.name || "", placeholder: "Todo Web" });
    const key = h("input", { type: "text", placeholder: "todo-web" });
    let keyTouched = false;
    key.addEventListener("input", () => { keyTouched = true; });
    name.addEventListener("input", () => { if (!keyTouched) key.value = keyFromName(name.value); });
    const driver = h("select", { "aria-label": "Surface", onchange: paintDriver },
      ...DRIVERS.map((d) => h("option", { value: d }, driverLabel(d))));
    const driverHint = h("div.hint", {}, driverGist("web"));
    const platformSlot = h("div");
    const platform = h("select", { "aria-label": "Platform" },
      ...PLATFORMS.map((p) => h("option", { value: p }, p === "ios" ? "iOS" : "Android")));
    const problem = h("div.preview-warn", { style: "display:none;margin:-6px 0 10px" });
    const saveBtn = h("button.btn.primary", { type: "submit" }, editing ? "Save" : "Create");

    paintDriver();
    return h("form", { onsubmit: submit },
      formField("Name", name, "What people call it here. This one is editable."),
      editing
        ? h("div.field", {},
            h("div.field-label", {}, "Key"),
            h("div.dim", { style: "font-size:12.5px" }, h("span.mono", {}, application.key),
              h("div.faint", { style: "font-size:11.5px;margin-top:2px" }, KEY_IS_PERMANENT.application)))
        : formField("Key", key,
            "How runner configuration and run evidence address it, for good. Lowercase letters, digits and hyphens."),
      editing
        ? h("div.dim", { style: "font-size:12.5px;margin:-4px 0 12px" },
            `${driverLabel(application.driver)}${application.platform ? ` · ${application.platform}` : ""} — the surface an application drives never changes; a web app and an iOS build are two applications.`)
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
      const keyValue = (key.value.trim() || keyFromName(name.value));
      const bad = keyProblem(keyValue, existing, { kind: "application" });
      if (bad) { key.focus(); return fail(bad); }
      saveBtn.disabled = true;
      try {
        const created = await api.post(`/projects/${projectKey}/applications`, {
          key: keyValue,
          name: name.value.trim(),
          driver: chosenDriver,
          ...(chosenDriver === "mobile" ? { platform: platform.value } : {}),
        });
        close();
        toast("Application created", `${created.key} — add a ring to make it launchable`, "ok");
        // Land on the new application's own page: a ring is the next step, and
        // this is where the control for it is.
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
    body: "Only possible while nothing points at it: no rings, no suites, no run groups. Nothing is removed on your behalf.",
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

// ---------- ring form ----------

/**
 * One ring, as a form.
 *
 * The named fields and the overlay document are two views of ONE document, the
 * way the suite-defaults editor treats YAML: every field writes into the JSON,
 * the JSON is what saves, and a key no field knows about survives verbatim.
 * They therefore cannot disagree at save time — which is what lets the sign-in
 * identities be a real editor rather than a paragraph of JSON to hand-write.
 */
export function ringModal(application: WebDynamic, ring: WebDynamic, providers: WebDynamic, done: WebDynamic) {
  const editing = !!ring;
  const mobile = application.driver === "mobile";
  const close = formModal(editing ? `Edit ${application.key}/${ring.key}` : `New ring for ${application.key}`, () => {
    const key = h("input", { type: "text", placeholder: "staging" });
    const name = h("input", { type: "text", value: ring?.name || "", placeholder: "Staging" });
    const url = h("input", { type: "text", value: ring?.base_url || "", placeholder: "https://staging.example.com" });
    const cookies = h("input", {
      type: "text", value: formatCookieList(ring?.config?.app?.cookies),
      placeholder: "slot=blue; feature_x=on", onchange: flush,
    });
    const labels = h("input", { type: "text", value: (ring?.runner_labels || []).join(", "), placeholder: "macos, ios-sim" });
    const disc = h("input", { type: "checkbox", checked: ring?.discovery_allowed || false });
    const config = h("textarea.code", { style: "min-height:130px" },
      JSON.stringify(maskSecretEnv(ring?.config) ?? {}, null, 2));
    const identitySlot = h("div.identity-rows");
    const jsonWarn = h("div.preview-warn", { style: "display:none;margin:-6px 0 10px" });
    const literalWarn = h("div.preview-warn", { style: "display:none;margin:-6px 0 10px" });
    const problem = h("div.preview-warn", { style: "display:none;margin:-6px 0 10px" });
    const saveBtn = h("button.btn.primary", { type: "submit" }, editing ? "Save" : "Create ring");
    const refs = sessionRefOptions(providers || [], ring?.id ?? null);
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
      identities = identityRows(parsed);
      paintIdentities();
      const keys = literalSecretKeys(parsed);
      literalWarn.style.display = keys.length ? "" : "none";
      literalWarn.textContent = keys.length
        ? `${keys.join(", ")}: pasted values are stored readable by anyone with this page. Prefer {"$secret": "name"} — add the name under Secret references.`
        : "";
    });

    paintIdentities();
    return h("form", { onsubmit: submit },
      editing
        ? h("div.field", {},
            h("div.field-label", {}, "Key"),
            h("div.dim", { style: "font-size:12.5px" }, h("span.mono", {}, `${application.key}/${ring.key}`),
              h("div.faint", { style: "font-size:11.5px;margin-top:2px" }, KEY_IS_PERMANENT.ring)))
        : formField("Key", key,
            "Lowercase letters, digits and hyphens — “local”, “staging”, “prod”. Every application may have its own, and it can't be changed later."),
      formField("Name", name, "What it reads as in the launch dialog. Defaults to the key."),
      mobile
        ? h("p.dim", { style: "font-size:12.5px;margin:-4px 0 12px" },
            "A mobile ring holds no URL, build path, device or Appium endpoint. The runner that claims this ring's work reads all four from its own configuration file, keyed by application and ring key.")
        : formField("URL", url,
            "Where this ring's runs point, read from the claiming runner's network position — a loopback URL means that runner's own machine. Routing labels below are how such a ring reaches the right machine."),
      formField("Runner labels", labels,
        "Runs against this ring go to a runner advertising ALL of these labels — that is the whole matching rule. Comma separated; leave blank to let any runner in this project take them."),
      mobile ? null : formField("Cookies", cookies,
        "Browser cookies set before the first navigation, on every web run against this ring — name=value pairs separated by semicolons."),
      h("label.check", { style: "margin:6px 0 4px" }, disc, "Allow discovery studies on this ring"),
      h("div.faint", { style: "font-size:11.5px;margin:0 0 14px 24px" },
        "Discovery agents really click buy, delete and submit. Leave this off for anything with real data behind it."),

      // Identities are the one part of the overlay people author by hand, so
      // they get controls. Everything else stays under Advanced.
      h("div.field-label", {}, "Sign-in identities"),
      h("div.faint", { style: "font-size:11.5px;margin:0 0 8px" },
        "The names a story picks with ", h("span.mono", {}, "auth: member"), ". Each one points at a session a provider mints, or at a stored sign-in state. A story with no ", h("span.mono", {}, "auth:"), " runs signed out."),
      identitySlot,

      h("details.advanced", { style: "margin-top:14px" },
        h("summary", {}, "Advanced — the overlay, as stored"),
        h("div", { style: "margin-top:10px" },
          formField("Logical overlay", config),
          jsonWarn,
          literalWarn,
          h("div.faint", { style: "font-size:11.5px;margin:-6px 0 10px" },
            "The suite merges this in as ", h("span.mono", {}, `app.envs.${editing ? ring.key : "<ring key>"}`), ". "
            + `Secret variables: {"secret_env": {"TOKEN": {"$secret": "name"}}} — stored values show as ${MASK} and are kept unless you replace them. `
            + "A build path, a device or an Appium endpoint cannot go here: the claiming runner resolves those."),
        ),
      ),
      problem,
      h("div.modal-actions", {},
        h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"),
        saveBtn),
    );

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
      catch (err: WebDynamic) { return toast("Cookies don't parse", String(err.message || err), "err"); }
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
      const keyValue = editing ? ring.key : key.value.trim();
      if (!editing) {
        const bad = keyProblem(keyValue, application.rings || [], { kind: "ring", scope: `Application “${application.key}”` });
        if (bad) { key.focus(); return fail(bad); }
      }
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
      const payload: WebDynamic = {
        name: name.value.trim() || keyValue,
        ...(mobile ? {} : { base_url: url.value.trim() }),
        runner_labels: runnerLabels,
        discovery_allowed: disc.checked,
        config: doc,
      };
      saveBtn.disabled = true;
      try {
        if (editing) await api.put(`/rings/${ring.id}`, payload);
        else await api.post(`/applications/${application.id}/rings`, { key: keyValue, ...payload });
        close();
        toast("Ring saved", `${application.key}/${keyValue}${payload.base_url ? ` → ${hostOf(payload.base_url)}` : ""}`, "ok");
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
    confirmLabel: "Delete ring",
    danger: true,
  });
  if (!ok) return;
  try { await api.del(`/rings/${ring.id}`); }
  catch (err: WebDynamic) { return toastError(err); }
  toast("Ring deleted", `${application.key}/${ring.key}`, "ok");
  reload();
}

// ---------- auth providers ----------

async function authProvidersPanel(projectKey: WebDynamic, applications: WebDynamic, slot: WebDynamic) {
  let items: WebDynamic = [];
  try { ({ items } = await api.cached(`/projects/${projectKey}/auth-providers`)); } catch (err: WebDynamic) { return toastError(err); }
  const refresh = () => authProvidersPanel(projectKey, applications, slot);
  const ringName = new Map<string, string>();
  for (const a of applications) for (const r of a.rings || []) ringName.set(r.id, `${a.key}/${r.key}`);
  const add = h("button.btn.primary", { onclick: () => authProviderModal(projectKey, applications, null, refresh) }, "+ New provider");
  const body = items.length
    ? h("div", { style: "display:flex;flex-direction:column;gap:12px" }, ...items.map((p: WebDynamic) => h("div.card.pad", {},
        h("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap" },
          h("span.id", {}, p.name),
          h("span.chip", {}, p.kind.replace(/_/g, " ")),
          h("span.chip", {}, p.ring_id ? ringName.get(p.ring_id) || "one ring" : "project-wide"),
          p.enabled ? null : h("span.chip", {}, "disabled"),
          h("div", { style: "flex:1" }),
          h("button.btn.btn-sm", { "aria-label": `Mint a session for ${p.name}`, onclick: () => mintProvider(p, refresh) }, "Mint"),
          h("button.btn.btn-sm", { "aria-label": `Sessions minted by ${p.name}`, onclick: () => sessionsModal(p) }, "Sessions"),
          h("button.btn.btn-sm", { "aria-label": `Edit auth provider ${p.name}`, onclick: () => authProviderModal(projectKey, applications, p, refresh) }, "Edit"),
          h("button.btn.btn-sm.danger", { "aria-label": `Delete auth provider ${p.name}`, onclick: () => delProvider(p, refresh) }, "Delete"),
        ),
        h("div.dim", { style: "margin-top:6px;font-size:12px" },
          `identities: ${Object.keys(p.identities || {}).join(", ") || "—"} · sessions last ${p.ttl_minutes}m`),
        h("details.advanced", { style: "margin-top:8px" },
          h("summary", {}, "Configuration, as stored"),
          h("pre.mono", { style: "margin-top:8px;background:var(--bg2);padding:10px;border-radius:6px;overflow:auto;font-size:12px" },
            JSON.stringify(p.config, null, 2))),
      )))
    : emptyState("No providers", "A provider mints short-lived sign-in states for the identities a ring names.");
  mount(slot, h("div", {}, h("div", { style: "display:flex;justify-content:flex-end;margin-bottom:12px" }, add), body));
}

function authProviderModal(projectKey: WebDynamic, applications: WebDynamic, existing: WebDynamic, refresh: WebDynamic) {
  const close = formModal(existing ? `Edit ${existing.name}` : "New auth provider", () => {
    const name = h("input", { type: "text", value: existing?.name || "", placeholder: "sso" });
    const kind = h("select", {},
      ...["token_endpoint", "storage_state_secret", "script"].map((k) => h("option", { value: k, selected: existing?.kind === k }, k.replace(/_/g, " "))));
    // A provider binds at most one ring. Unbound stays project-wide: every ring
    // may reference it, and its standalone mints ride the board with no labels.
    const ring = h("select", { "aria-label": "Ring" },
      h("option", { value: "" }, "Project-wide — every ring may use it"),
      ...applications.flatMap((a: WebDynamic) => (a.rings || []).map((r: WebDynamic) =>
        h("option", { value: r.id, selected: existing?.ring_id === r.id || undefined }, `${a.key}/${r.key}`))));
    const config = h("textarea.code", { style: "min-height:120px" }, JSON.stringify(existing?.config || { url: "http://127.0.0.1:0/session" }, null, 2));
    const identities = h("textarea.code", { style: "min-height:110px" }, JSON.stringify(existing?.identities || { member: {} }, null, 2));
    const ttl = h("input", { type: "number", min: "1", max: "1440", value: existing?.ttl_minutes || 60 });
    const enabled = h("input", { type: "checkbox", checked: existing?.enabled !== false });
    return h("form", { onsubmit: submit },
      formField("Name", name, "How a ring's identities refer to it: provider/identity."),
      formField("Kind", kind),
      formField("Ring", ring, "Bound: reachable only from that ring, and its mints carry the ring's routing labels. Project-wide: any ring may name it."),
      formField("Config JSON", config),
      formField("Identities JSON", identities),
      formField("TTL minutes", ttl, "How long a minted session is reused before it is minted again."),
      h("label.check", { style: "margin:6px 0 12px" }, enabled, "Enabled"),
      h("div.modal-actions", {}, h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Save")),
    );
    async function submit(e: WebDynamic) {
      e.preventDefault();
      let cfg, ids;
      try { cfg = JSON.parse(config.value || "{}"); ids = JSON.parse(identities.value || "{}"); }
      catch { return toast("JSON isn't valid", "", "err"); }
      const payload: WebDynamic = {
        name: name.value.trim(), kind: kind.value, config: cfg, identities: ids,
        ttl_minutes: Number(ttl.value), enabled: enabled.checked, ring_id: ring.value || null,
      };
      try {
        if (existing) await api.put(`/auth-providers/${existing.id}`, payload);
        else await api.post(`/projects/${projectKey}/auth-providers`, payload);
        close(); toast("Auth provider saved", payload.name, "ok"); refresh();
      } catch (err: WebDynamic) { toastError(err); }
    }
  });
}

async function mintProvider(provider: WebDynamic, refresh: WebDynamic) {
  try {
    const out = await api.post(`/auth-providers/${provider.id}/mint`, {});
    // `script` providers mint on a runner: the 202 body carries the dispatched
    // claim; the session shows up in the sessions list when the runner lands it.
    if (out.mint) toast("Mint dispatched", "a runner is minting this session — check Sessions shortly", "ok");
    else toast("Session minted", `${out.session.identity} until ${new Date(out.session.expires_at).toLocaleTimeString()}`, "ok");
    refresh();
  } catch (err: WebDynamic) { toastError(err); }
}

async function sessionsModal(provider: WebDynamic) {
  const close = formModal(`${provider.name} sessions`, () => h("div.dim", {}, "Loading…"));
  const root = document.querySelector("#modal-root .modal");
  try {
    const { items } = await api.get(`/auth-providers/${provider.id}/sessions`);
    mount(root, h("h3", {}, `${provider.name} sessions`),
      items.length ? h("table.rows", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Identity"), h("th", {}, "Expires"), h("th", {}, "Minted by"))),
        h("tbody", {}, ...items.map((s: WebDynamic) => h("tr", {}, h("td", {}, s.identity), h("td.dim", {}, new Date(s.expires_at).toLocaleString()), h("td", {}, s.minted_by_job || "—")))),
      ) : emptyState("No sessions", "No derived sessions have been minted yet."),
      h("div.modal-actions", {}, h("button.btn.primary", { onclick: () => close() }, "Close")));
  } catch (err: WebDynamic) { toastError(err); close(); }
}

async function delProvider(provider: WebDynamic, refresh: WebDynamic) {
  if (!(await confirmModal({ title: `Delete ${provider.name}?`, body: "Cached sessions for this provider will be removed.", confirmLabel: "Delete", danger: true }))) return;
  try { await api.del(`/auth-providers/${provider.id}`); toast("Deleted", provider.name, "ok"); refresh(); } catch (err: WebDynamic) { toastError(err); }
}

// ---------- secrets ----------

async function secretsPanel(projectKey: WebDynamic, slot: WebDynamic) {
  let items: WebDynamic = [];
  try { ({ items } = await api.cached(`/projects/${projectKey}/secrets`)); } catch (err: WebDynamic) { return toastError(err); }
  const refresh = () => secretsPanel(projectKey, slot);
  const add = h("button.btn.primary", { onclick: () => secretModal(projectKey, refresh) }, "+ Add secret");
  const body = h("div", {},
    h("div.card.pad", { style: "margin-bottom:12px;color:var(--dim);font-size:12.5px" }, "⚠ Secrets are write-only. Values are encrypted at rest and never shown again after you save them."),
    items.length
      ? h("div.card", {}, h("table.rows", {},
          h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Updated"), h("th", {}))),
          h("tbody", {}, ...items.map((s: WebDynamic) => h("tr", {},
            h("td.mono", {}, s.name),
            h("td.dim", {}, new Date(s.updated_at).toLocaleDateString()),
            h("td", { style: "text-align:right" },
              h("button.btn.btn-sm", { style: "margin-right:6px", "aria-label": `Rotate secret ${s.name}`, onclick: () => secretModal(projectKey, refresh, s.name) }, "Rotate"),
              h("button.btn.btn-sm.danger", { "aria-label": `Delete secret ${s.name}`, onclick: () => delSecret(projectKey, s, refresh) }, "Delete")),
          ))),
        ))
      : emptyState("No secrets", "Add API tokens, storage-state blobs, or cookie values here."),
  );
  mount(slot, h("div", {}, h("div", { style: "display:flex;justify-content:flex-end;margin-bottom:12px" }, add), body));
}

// Saving under an existing name replaces the value (the API is an upsert) —
// "Rotate" on a row opens this dialog with the name locked in.
function secretModal(projectKey: WebDynamic, refresh: WebDynamic, rotateName: WebDynamic = null) {
  const close = formModal(rotateName ? `Rotate ${rotateName}` : "Add secret", () => {
    const name = h("input", { type: "text", value: rotateName || "", placeholder: "staging-seed-token" });
    if (rotateName) name.disabled = true;
    const value = h("textarea", { placeholder: rotateName ? "the new value (the old one is replaced on save)" : "the secret value", style: "min-height:80px" });
    return h("form", { onsubmit: submit },
      formField("Name", name, "letters, digits and _ . -"),
      formField("Value", value),
      h("div.modal-actions", {}, h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, rotateName ? "Rotate" : "Save")),
    );
    async function submit(e: WebDynamic) {
      e.preventDefault();
      try { await api.post(`/projects/${projectKey}/secrets`, { name: name.value.trim(), value: value.value }); close(); toast("Secret saved", name.value.trim(), "ok"); refresh(); }
      catch (err: WebDynamic) { toastError(err); }
    }
  });
}

async function delSecret(projectKey: WebDynamic, s: WebDynamic, refresh: WebDynamic) {
  if (!(await confirmModal({ title: `Delete secret ${s.name}?`, body: "Rings and providers referencing it will fail until it is replaced.", confirmLabel: "Delete", danger: true }))) return;
  try { await api.del(`/projects/${projectKey}/secrets/${encodeURIComponent(s.name)}`); toast("Deleted", s.name, "ok"); refresh(); } catch (err: WebDynamic) { toastError(err); }
}
