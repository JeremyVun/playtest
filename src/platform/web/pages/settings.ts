// Settings — role-gated project policy. Test targets is developer-facing;
// Runs, Models, Team, and Audit are admin-facing. Plugins, Integrations, and
// Retention were removed from the UI in the P1 simplification.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { link, navigate } from "../lib/router.js";
import { renderFrame, page } from "../lib/shell.js";
import { state, hasRole, loadMe, loadProjects } from "../lib/state.js";
import { toast, toastError, confirmModal, formModal, emptyState, formField, enhanceSelect } from "../lib/ui.js";
import { SETTINGS_SECTIONS } from "../lib/settings-sections.js";
import { modelField } from "../lib/model-select.js";
import { MASK, maskSecretEnv, literalSecretKeys } from "../lib/secret-mask.js";
import { parseCookieList, formatCookieList } from "../lib/defaults-form.js";
import { humanize as words, categoryLabel } from "../lib/vocab.js";

const RENDER: WebDynamic = {
  "test-targets": testTargetsTab,
  runs: runsTab,
  models: modelsTab,
  team: membersTab,
  audit: auditTab,
};

export function settingsPage(projectKey: WebDynamic, tab?: WebDynamic) {
  const main = renderFrame({ projectKey, nav: "settings" });
  const project = state.projectByKey.get(projectKey);
  if (!project) return mount(main, page({ title: "Settings", body: emptyState("Not found", "No such project.") }));

  const tabs = SETTINGS_SECTIONS
    .filter((t: WebDynamic) => hasRole(project.id, t.min))
    .map((t: WebDynamic) => ({ ...t, render: RENDER[t.id] }));

  if (!tabs.length) return mount(main, page({ title: "Settings", body: emptyState("No settings access", "Ask a project admin for a role.") }));
  const active = tabs.find((t: WebDynamic) => t.id === tab) || tabs[0];

  const tabBar = h("div.seg", { style: "margin-bottom:16px" },
    ...tabs.map((t: WebDynamic) => h("button", { class: t.id === active.id ? "on" : "", onclick: () => navigate(`/p/${projectKey}/settings/${t.id}`) }, t.label)));

  const slot = h("div", {}, h("div.dim", {}, "Loading…"));
  mount(main, page({ title: "Settings", sub: projectIdentity(project, projectKey), body: h("div", {}, tabBar, slot) }));
  active.render(projectKey, project, slot);
}

// The key is no longer asked for when a project is created, and no longer the
// headline anywhere — but it is still what the URLs, the CLI and the API call
// this project, so it has to stay findable. Read-only: nothing can change it.
const projectIdentity = (project: WebDynamic, projectKey: WebDynamic) =>
  h("span", {},
    project.name || projectKey,
    " · key ",
    h("span.mono", {}, projectKey),
    h("span.faint", {}, " — the name this project goes by in its URLs and in the CLI and API. It can't be changed."),
  );

// ---------- runs ----------
// A predictable project-wide pool, inherited by every suite that does not pin
// its own `parallel` value on Suite settings.
async function runsTab(projectKey: WebDynamic, project: WebDynamic, slot: WebDynamic) {
  const current = project.parallel || { total: 1, record: 1 };
  const total = h("input", { type: "number", min: "1", step: "1", value: current.total });
  const record = h("input", { type: "number", min: "1", step: "1", value: current.record });
  const saveBtn = h("button.btn.primary", { onclick: save }, "Save");
  mount(slot, h("section", {},
    h("h3.section-title", { style: "margin-top:0" }, "Run concurrency"),
    h("p.dim", { style: "font-size:12.5px;margin:-4px 0 12px" },
      "The worker budget every suite inherits. A suite can replace it from Suite settings when its target or model limits need a different pool."),
    h("div.card.pad", {},
      h("div.run-limits-fields", {},
        formField("Concurrent stories", total,
          "Maximum stories in flight across model-driven recordings and baseline checks."),
        formField("Concurrent recordings", record,
          "Maximum model-driven stories in flight. Baseline checks can use the remaining workers."),
      ),
      h("div", { style: "display:flex;justify-content:flex-end;margin-top:14px" }, saveBtn),
    ),
  ));

  async function save() {
    const parallel: WebDynamic = { total: Number(total.value), record: Number(record.value) };
    if (!Number.isSafeInteger(parallel.total) || parallel.total < 1 ||
        !Number.isSafeInteger(parallel.record) || parallel.record < 1) {
      return toast("Use positive whole numbers", "Both concurrency values must be at least 1.", "err");
    }
    if (parallel.record > parallel.total) {
      return toast("Recording cap is too high", "Concurrent recordings cannot exceed concurrent stories.", "err");
    }
    saveBtn.disabled = true;
    try {
      const updated = await api.put(`/projects/${projectKey}/parallel`, parallel);
      project.parallel = updated.parallel;
      toast("Run concurrency saved", `${parallel.total} concurrent · ${parallel.record} recording`, "ok");
    } catch (err: WebDynamic) {
      toastError(err);
    } finally {
      saveBtn.disabled = false;
    }
  }
}

// ---------- test targets ----------
// One section combines environments (the primary target list) with the auth
// providers and secrets they reference. Provider JSON and raw environment JSON
// are advanced disclosure, not sibling tabs. Secret values are never rendered
// (masking lives in lib/secret-mask.ts).
async function testTargetsTab(projectKey: WebDynamic, project: WebDynamic, slot: WebDynamic) {
  const canAdmin = hasRole(project.id, "admin");
  const envSlot = h("div");
  const authSlot = h("div");
  const secretSlot = h("div");
  mount(slot, h("div.stack", {},
    h("section", {},
      h("h3.section-title", { style: "margin-top:0" }, "Environments"),
      h("p.dim", { style: "font-size:12.5px;margin:-4px 0 12px" },
        "A deployment ring suites can run against: its credentials, runner pool, and whether discovery studies are allowed there. Each suite sets its own URL for a ring in Suite settings — where a suite can also add an environment of its own, listed here under the suite that owns it."),
      envSlot,
    ),
    h("details.advanced", { style: "margin-top:8px" },
      h("summary", {}, "Authentication identities"),
      h("p.dim", { style: "font-size:12.5px;margin:8px 0 12px" },
        "Providers mint short-lived sessions for the identities an environment references. Provider config JSON is edited here."),
      authSlot,
    ),
    canAdmin
      ? h("details.advanced", { style: "margin-top:8px" },
          h("summary", {}, "Secret references"),
          h("p.dim", { style: "font-size:12.5px;margin:8px 0 12px" },
            "Write-only named secrets that environments reference by name. Values are encrypted at rest and never shown again."),
          secretSlot,
        )
      : null,
  ));
  environmentsTab(projectKey, project, envSlot);
  authProvidersTab(projectKey, project, authSlot);
  if (canAdmin) secretsTab(projectKey, project, secretSlot);
}

// ---------- models ----------
// The project's default actor and grader — a cost/quality policy set once
// instead of repeated in every suite. Precedence is per key, most specific
// wins: a story's own value > the suite's playtest.yaml > these > the engine
// defaults. A suite that chose always wins, so nothing set here can override
// it; the caption under each field says what a blank field means, so leaving
// one empty is an informed choice.
async function modelsTab(projectKey: WebDynamic, project: WebDynamic, slot: WebDynamic) {
  let catalog: WebDynamic = { tiers: [], defaults: {} };
  try { catalog = await api.cached(`/models`, { ttl: Infinity }); } catch { /* the dropdown degrades to a text field; saving still works */ }
  const saveBtn = h("button.btn.primary", { onclick: save }, "Save");
  // What each field currently says, committed together by Save. null = inherit
  // (the engine default) — the dropdown's first option, never an empty box.
  const pending: WebDynamic = {
    actor_model: project.models?.actor_model || null,
    grader_model: project.models?.grader_model || null,
    consolidation_model: project.models?.consolidation_model || null,
    auto_resolve_model: project.models?.auto_resolve_model || null,
  };
  const field = (key: WebDynamic, label: WebDynamic, role: WebDynamic) => modelField({
    label,
    hint: role,
    value: pending[key] || "",
    tiers: catalog.tiers || [],
    inheritLabel: catalog.defaults?.[key] ? `Engine default — ${catalog.defaults[key]}` : "Engine default",
    onchange: (v: WebDynamic) => { pending[key] = v; },
  });

  // The auto-dedupe sweep toggle lives beside the model that powers it.
  // Tri-state: inherit the deployment default, or pin on/off for this project.
  // The manual "Find duplicates" flow follows this: it exists only when the
  // sweep is off (docs/contracts/hosted.md, "Consolidation").
  const cap = state.me?.capabilities || {};
  let pendingAuto = project.auto_dedupe ?? null;
  const autoSel = h("select", {
    "aria-label": "Automatic dedupe",
    onchange: () => { pendingAuto = autoSel.value === "" ? null : autoSel.value === "on"; },
  },
    h("option", { value: "", selected: pendingAuto == null || undefined },
      `Deployment default — ${cap.auto_dedupe ? "on" : "off"}`),
    h("option", { value: "on", selected: pendingAuto === true || undefined }, "On"),
    h("option", { value: "off", selected: pendingAuto === false || undefined }, "Off"));
  const autoField = formField("Automatic dedupe", autoSel,
    cap.llm === false
      ? "Merges duplicate findings after each run reports. This deployment has no model gateway (PLAYTEST_LLM_BASE_URL), so the sweep cannot run whatever this is set to."
      : "Merges duplicate findings automatically after each run reports — switching it on runs a catch-up pass over the current queue. Off brings back the manual Find duplicates flow.");

  // The auto-resolve pin, beside the dedupe pin it mirrors. Gate and signal
  // checks are deterministic; judgment-call findings are re-verified through
  // the gateway when one is configured.
  let pendingResolve = project.auto_resolve ?? null;
  const resolveSel = h("select", {
    "aria-label": "Automatic resolve",
    onchange: () => { pendingResolve = resolveSel.value === "" ? null : resolveSel.value === "on"; },
  },
    h("option", { value: "", selected: pendingResolve == null || undefined },
      `Deployment default — ${cap.auto_resolve ? "on" : "off"}`),
    h("option", { value: "on", selected: pendingResolve === true || undefined }, "On"),
    h("option", { value: "off", selected: pendingResolve === false || undefined }, "Off"));
  const resolveField = formField("Automatic resolve", resolveSel,
    "Resolves a finding when a later run demonstrates the fix — the same gate check passing again, or the recorded signal gone from a rerun. Judgment-call findings are re-checked against the newer run's page content by the fix verification model.");

  // What a VERIFIED fix of a judgment-call finding may do: suggest ("semi",
  // a person confirms) or resolve outright ("full").
  let pendingMode = project.auto_resolve_mode ?? null;
  const modeSel = h("select", {
    "aria-label": "Verified fixes",
    onchange: () => { pendingMode = modeSel.value === "" ? null : modeSel.value; },
  },
    h("option", { value: "", selected: pendingMode == null || undefined },
      `Deployment default — ${cap.auto_resolve_mode === "full" ? "resolve automatically" : "confirm first"}`),
    h("option", { value: "semi", selected: pendingMode === "semi" || undefined }, "Confirm first (semi)"),
    h("option", { value: "full", selected: pendingMode === "full" || undefined }, "Resolve automatically (full)"));
  const modeField = formField("Verified fixes", modeSel,
    cap.llm === false
      ? "Whether a verified fix of a judgment-call finding resolves it outright or waits for your confirmation. This deployment has no model gateway (PLAYTEST_LLM_BASE_URL), so fixes cannot be verified and only \"looks fixed\" suggestions from graded passing runs appear."
      : "Whether a verified fix of a judgment-call finding resolves it outright or waits for your confirmation. Gate and signal findings always resolve on deterministic evidence; findings linked to an external ticket always wait.");
  mount(slot, h("section", {},
    h("h3.section-title", { style: "margin-top:0" }, "Models"),
    h("p.dim", { style: "font-size:12.5px;margin:-4px 0 12px" },
      "The models every run in this project uses unless a suite — or a single story — chooses its own; the more specific choice always wins."),
    h("div.card.pad", {},
      field("actor_model", "Actor model", "Plays the user against the app. A capable actor recovers from friction far more reliably than a cheap one."),
      field("grader_model", "Grader model", "Grades finished runs and checks assertions."),
      field("consolidation_model", "Dedupe model", "Judges whether differently worded findings describe the same bug — used by the automatic post-run dedupe and by manual Find duplicates."),
      field("auto_resolve_model", "Fix verification model", "Re-checks a judgment-call finding's claim against a newer run's recorded page content — used by the auto-resolve sweep to say fixed, not fixed, or indeterminate."),
      autoField,
      resolveField,
      modeField,
      h("div", { style: "display:flex;justify-content:flex-end" }, saveBtn),
    ),
  ));
  async function save() {
    saveBtn.disabled = true;
    try {
      const updated = await api.put(`/projects/${projectKey}/models`, {
        actor_model: pending.actor_model,
        grader_model: pending.grader_model,
        consolidation_model: pending.consolidation_model,
        auto_resolve_model: pending.auto_resolve_model,
      });
      if (pendingAuto !== (project.auto_dedupe ?? null)) {
        const p2 = await api.put(`/projects/${projectKey}/auto-dedupe`, { enabled: pendingAuto });
        project.auto_dedupe = p2.auto_dedupe;
      }
      if (pendingResolve !== (project.auto_resolve ?? null) || pendingMode !== (project.auto_resolve_mode ?? null)) {
        const p3 = await api.put(`/projects/${projectKey}/auto-resolve`, { enabled: pendingResolve, mode: pendingMode });
        project.auto_resolve = p3.auto_resolve;
        project.auto_resolve_mode = p3.auto_resolve_mode;
      }
      // Keep the in-memory project honest: Suite settings' "Project default —
      // …" inherit options read state.projectByKey, not the server, until the
      // next full load.
      project.models = updated.models;
      const m = updated.models;
      toast("Models saved",
        m.actor_model || m.grader_model || m.consolidation_model || m.auto_resolve_model
          ? [
              m.actor_model && `actor ${m.actor_model}`,
              m.grader_model && `grader ${m.grader_model}`,
              m.consolidation_model && `dedupe ${m.consolidation_model}`,
              m.auto_resolve_model && `verify ${m.auto_resolve_model}`,
            ].filter(Boolean).join(" · ")
          : "engine defaults",
        "ok");
    } catch (err: WebDynamic) { toastError(err); }
    saveBtn.disabled = false;
  }
}

// ---------- environments ----------
async function environmentsTab(projectKey: WebDynamic, project: WebDynamic, slot: WebDynamic) {
  let items: WebDynamic = [];
  try { ({ items } = await api.cached(`/projects/${projectKey}/environments`)); } catch (err: WebDynamic) { return toastError(err); }
  const add = h("button.btn.primary", { onclick: () => envModal(projectKey, null, () => environmentsTab(projectKey, project, slot)) }, "+ New environment");
  const body = items.length
    ? h("div", { style: "display:flex;flex-direction:column;gap:12px" }, ...items.map((e: WebDynamic) => h("div.card.pad", {},
        h("div", { style: "display:flex;align-items:center;gap:10px" },
          h("span.id", {}, e.name),
          e.discovery_allowed ? h("span.chip", {}, "discovery allowed") : null,
          // A suite's own environment is listed here — an admin should see
          // everything the project holds — but never anonymously: only that
          // suite can launch against it, and only its settings page adds one.
          e.suite_id
            ? h("span.chip", {}, e.suite?.name ? `${e.suite.name} only` : "one suite only")
            : null,
          h("div", { style: "flex:1" }),
          // Every row repeats "Edit"/"Delete", so the accessible name has to carry
          // the object — a screen reader must never offer four identical buttons.
          h("button.btn.btn-sm", { "aria-label": `Edit environment ${e.name}`, onclick: () => envModal(projectKey, e, () => environmentsTab(projectKey, project, slot)) }, "Edit"),
          h("button.btn.btn-sm.danger", { "aria-label": `Delete environment ${e.name}`, onclick: () => delEnv(e, () => environmentsTab(projectKey, project, slot)) }, "Delete"),
        ),
        // Readable fields first — the config JSON is an escape hatch behind Advanced.
        envFieldLine("fallback URL", e.config?.app?.base_url || "— suites set their own"),
        Object.keys(e.config?.app?.cookies || {}).length
          ? envFieldLine("cookies", formatCookieList(e.config.app.cookies))
          : null,
        e.suite_id ? envFieldLine("owned by", e.suite?.name || e.suite_id) : null,
        envFieldLine("discovery", e.discovery_allowed ? "allowed" : "not allowed"),
        envFieldLine("runner labels", (e.runner_labels || []).join(", ") || "—"),
        envFieldLine("secret references", secretRefSummary(e.config) || "—"),
        h("details.advanced", { style: "margin-top:8px" },
          h("summary", {}, "Advanced — raw config JSON"),
          h("pre.mono", { style: "margin-top:8px;background:var(--bg2);padding:10px;border-radius:6px;overflow:auto;font-size:12px" }, JSON.stringify(maskSecretEnv(e.config), null, 2)),
        ),
      )))
    : emptyState("No environments", "An environment is a deployment ring — the credentials, runner pool and discovery permission a run uses. Suites declare where their app lives inside it.");
  mount(slot, h("div", {}, h("div", { style: "display:flex;justify-content:flex-end;margin-bottom:12px" }, add), body));
}

const envFieldLine = (k: WebDynamic, v: WebDynamic) => h("div.dim", { style: "margin-top:6px;font-size:12px" }, `${k}: `, h("span.mono", {}, v));

/** Readable one-liner of an environment's secret_env references (never values). */
function secretRefSummary(config: WebDynamic) {
  const entries = Object.entries(config?.secret_env || {});
  if (!entries.length) return null;
  return entries.map(([k, v]: WebDynamic) =>
    typeof v === "object" && v !== null
      ? `${k}=${v.$secret ? `$secret:${v.$secret}` : v.$session ? `$session:${v.$session}` : "ref"}`
      : `${k}=${MASK}`).join(", ");
}

function envModal(projectKey: WebDynamic, existing: WebDynamic, refresh: WebDynamic) {
  const close = formModal(existing ? `Edit ${existing.name}` : "New environment", () => {
    const name = h("input", { type: "text", value: existing?.name || "", placeholder: "staging" });
    if (existing) name.disabled = true;
    const baseUrl = h("input", { type: "text", value: existing?.config?.app?.base_url || "", placeholder: "https://staging.example.com" });
    // Cookies are first-class ring config: a blue/green slot or feature-flag
    // cookie is often the whole difference between two rings. Folded into
    // config.app.cookies like the URL; untouched, the raw JSON keeps its say.
    const cookiesInitial = formatCookieList(existing?.config?.app?.cookies);
    const cookies = h("input", { type: "text", value: cookiesInitial, placeholder: "slot=blue; feature_x=on" });
    const config = h("textarea.code", { style: "min-height:160px" }, JSON.stringify(maskSecretEnv(existing?.config) || { app: { base_url: "https://staging.example.com" } }, null, 2));
    const labels = h("input", { type: "text", value: (existing?.runner_labels || []).join(", "), placeholder: "self-hosted, playtest" });
    const disc = h("input", { type: "checkbox", checked: existing?.discovery_allowed || false });
    const literalWarn = h("div.preview-warn", { style: "display:none;margin:-6px 0 10px" });
    config.addEventListener("input", () => {
      let keys: WebDynamic = [];
      try { keys = literalSecretKeys(JSON.parse(config.value)); } catch { /* not JSON yet — the submit path reports that */ }
      literalWarn.style.display = keys.length ? "" : "none";
      literalWarn.textContent = keys.length
        ? `${keys.join(", ")}: pasted values are stored readable by anyone with this page. Prefer {"$secret": "name"} — add the name under Settings → Secrets.`
        : "";
    });
    return h("form", { onsubmit: submit },
      fld("Name", name),
      fld("Runner labels", labels),
      fld("Cookies", cookies,
        "Browser cookies set before the first navigation, on every web run against this environment — name=value pairs separated by semicolons. A suite can override them on its own settings page."),
      h("label.check", { style: "margin:6px 0 12px" }, disc, "Allow discovery studies on this environment"),
      // An environment is a RING: credentials, runner pool and discovery
      // permission, shared by every suite in the project. WHERE a given suite's
      // app lives inside that ring belongs to the suite (Suite settings →
      // per-environment URLs), which also outranks this field at dispatch. It
      // survives as the fallback for the common case — one project, one app —
      // but it is no longer the headline question.
      h("details.advanced", {},
        h("summary", {}, "Advanced — fallback URL, auth / secret_env"),
        h("div", { style: "margin-top:10px" },
          fld("Fallback base URL", baseUrl,
            "Used by any suite that doesn't set its own URL for this environment. Leave blank when suites declare their own."),
          fld("Config JSON", config),
          literalWarn,
          h("div.faint", { style: "font-size:11.5px;margin:-6px 0 10px" },
            'Reference stored secrets instead of pasting values: "secret_env": { "TOKEN": { "$secret": "secret-name" } } — add names under Secret references. Stored values show as ' + MASK + " and are kept unless you replace them.",
          ),
        ),
      ),
      h("div.modal-actions", {}, h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Save")),
    );
    async function submit(e: WebDynamic) {
      e.preventDefault();
      let cfg;
      try { cfg = JSON.parse(config.value); } catch { return toast("Config isn't valid JSON", "", "err"); }
      // The Base URL field is the primary control; fold it into config.app.
      const url = baseUrl.value.trim();
      if (url) { cfg.app = { ...(cfg.app || {}), base_url: url }; }
      // The Cookies field owns config.app.cookies once touched; untouched, a
      // cookie map living only in the raw JSON stays exactly as typed there.
      if (cookies.value !== cookiesInitial) {
        let parsed;
        try { parsed = parseCookieList(cookies.value); }
        catch (err: WebDynamic) { return toast("Cookies don't parse", String(err.message || err), "err"); }
        if (parsed) cfg.app = { ...(cfg.app || {}), cookies: parsed };
        else if (cfg.app) delete cfg.app.cookies;
      }
      // An untouched mask keeps the stored value; the browser never round-trips
      // the literal through the textarea.
      for (const [k, v] of Object.entries(cfg?.secret_env || {})) {
        if (v !== MASK) continue;
        const stored = existing?.config?.secret_env?.[k];
        if (stored === undefined) return toast(`"${k}" is ${MASK}`, "that key has no stored value to keep — paste a value or a {\"$secret\": …} reference", "err");
        cfg.secret_env[k] = stored;
      }
      const payload: WebDynamic = { name: name.value.trim(), config: cfg, runner_labels: labels.value.split(",").map((s: WebDynamic) => s.trim()).filter(Boolean), discovery_allowed: disc.checked };
      try {
        if (existing) await api.put(`/environments/${existing.id}`, payload);
        else await api.post(`/projects/${projectKey}/environments`, payload);
        close(); toast("Environment saved", payload.name, "ok"); refresh();
      } catch (err: WebDynamic) { toastError(err); }
    }
  });
}

async function delEnv(env: WebDynamic, refresh: WebDynamic) {
  if (!(await confirmModal({ title: `Delete ${env.name}?`, body: "This can't be undone.", confirmLabel: "Delete", danger: true }))) return;
  try { await api.del(`/environments/${env.id}`); toast("Deleted", env.name, "ok"); refresh(); } catch (err: WebDynamic) { toastError(err); }
}

// ---------- auth providers ----------
async function authProvidersTab(projectKey: WebDynamic, project: WebDynamic, slot: WebDynamic) {
  let items: WebDynamic = [];
  try { ({ items } = await api.cached(`/projects/${projectKey}/auth-providers`)); } catch (err: WebDynamic) { return toastError(err); }
  const add = h("button.btn.primary", { onclick: () => authProviderModal(projectKey, null, () => authProvidersTab(projectKey, project, slot)) }, "+ New provider");
  const body = items.length
    ? h("div", { style: "display:flex;flex-direction:column;gap:12px" }, ...items.map((p: WebDynamic) => h("div.card.pad", {},
        h("div", { style: "display:flex;align-items:center;gap:10px" },
          h("span.id", {}, p.name),
          h("span.chip", {}, p.kind),
          p.enabled ? null : h("span.chip", {}, "disabled"),
          h("div", { style: "flex:1" }),
          // Four verbs per provider, repeated per row — each one names its provider.
          h("button.btn.btn-sm", { "aria-label": `Mint a session for ${p.name}`, onclick: () => mintProvider(p, () => authProvidersTab(projectKey, project, slot)) }, "Mint"),
          h("button.btn.btn-sm", { "aria-label": `Sessions minted by ${p.name}`, onclick: () => sessionsModal(p) }, "Sessions"),
          h("button.btn.btn-sm", { "aria-label": `Edit auth provider ${p.name}`, onclick: () => authProviderModal(projectKey, p, () => authProvidersTab(projectKey, project, slot)) }, "Edit"),
          h("button.btn.btn-sm.danger", { "aria-label": `Delete auth provider ${p.name}`, onclick: () => delProvider(p, () => authProvidersTab(projectKey, project, slot)) }, "Delete"),
        ),
        h("div.dim", { style: "margin-top:6px;font-size:12px" }, `ttl: ${p.ttl_minutes}m · identities: ${Object.keys(p.identities || {}).join(", ") || "—"}`),
        h("pre.mono", { style: "margin-top:8px;background:var(--bg2);padding:10px;border-radius:6px;overflow:auto;font-size:12px" }, JSON.stringify(p.config, null, 2)),
      )))
    : emptyState("No auth providers", "A provider mints short-lived storage-state artifacts for app identities.");
  mount(slot, h("div", {}, h("div", { style: "display:flex;justify-content:flex-end;margin-bottom:12px" }, add), body));
}

function authProviderModal(projectKey: WebDynamic, existing: WebDynamic, refresh: WebDynamic) {
  const close = formModal(existing ? `Edit ${existing.name}` : "New auth provider", () => {
    const name = h("input", { type: "text", value: existing?.name || "", placeholder: "sso" });
    const kind = h("select", {},
      ...["token_endpoint", "storage_state_secret", "script"].map((k) => h("option", { value: k, selected: existing?.kind === k }, k)));
    const config = h("textarea.code", { style: "min-height:120px" }, JSON.stringify(existing?.config || { url: "http://127.0.0.1:0/session" }, null, 2));
    const identities = h("textarea.code", { style: "min-height:110px" }, JSON.stringify(existing?.identities || { member: {} }, null, 2));
    const ttl = h("input", { type: "number", min: "1", max: "1440", value: existing?.ttl_minutes || 60 });
    const enabled = h("input", { type: "checkbox", checked: existing?.enabled !== false });
    return h("form", { onsubmit: submit },
      fld("Name", name),
      fld("Kind", kind),
      fld("Config JSON", config),
      fld("Identities JSON", identities),
      fld("TTL minutes", ttl),
      h("label.check", { style: "margin:6px 0 12px" }, enabled, "Enabled"),
      h("div.modal-actions", {}, h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Save")),
    );
    async function submit(e: WebDynamic) {
      e.preventDefault();
      let cfg, ids;
      try { cfg = JSON.parse(config.value || "{}"); ids = JSON.parse(identities.value || "{}"); }
      catch { return toast("JSON isn't valid", "", "err"); }
      const payload: WebDynamic = { name: name.value.trim(), kind: kind.value, config: cfg, identities: ids, ttl_minutes: Number(ttl.value), enabled: enabled.checked };
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
    // claim; the session shows up in the sessions list when the workflow lands.
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
async function secretsTab(projectKey: WebDynamic, project: WebDynamic, slot: WebDynamic) {
  let items: WebDynamic = [];
  try { ({ items } = await api.cached(`/projects/${projectKey}/secrets`)); } catch (err: WebDynamic) { return toastError(err); }
  const add = h("button.btn.primary", { onclick: () => secretModal(projectKey, () => secretsTab(projectKey, project, slot)) }, "+ Add secret");
  const body = h("div", {},
    h("div.card.pad", { style: "margin-bottom:12px;color:var(--dim);font-size:12.5px" }, "⚠ Secrets are write-only. Values are encrypted at rest and never shown again after you save them."),
    items.length
      ? h("div.card", {}, h("table.rows", {},
          h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Updated"), h("th", {}))),
          h("tbody", {}, ...items.map((s: WebDynamic) => h("tr", {},
            h("td.mono", {}, s.name),
            h("td.dim", {}, new Date(s.updated_at).toLocaleDateString()),
            h("td", { style: "text-align:right" },
              h("button.btn.btn-sm", { style: "margin-right:6px", "aria-label": `Rotate secret ${s.name}`, onclick: () => secretModal(projectKey, () => secretsTab(projectKey, project, slot), s.name) }, "Rotate"),
              h("button.btn.btn-sm.danger", { "aria-label": `Delete secret ${s.name}`, onclick: () => delSecret(projectKey, s, () => secretsTab(projectKey, project, slot)) }, "Delete")),
          ))),
        ))
      : emptyState("No secrets", "Add API tokens, storage-state blobs, or env cookies here."),
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
      fld("Name", name, "letters, digits and _ . -"),
      fld("Value", value),
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
  if (!(await confirmModal({ title: `Delete secret ${s.name}?`, body: "Environments referencing it will fail until replaced.", confirmLabel: "Delete", danger: true }))) return;
  try { await api.del(`/projects/${projectKey}/secrets/${encodeURIComponent(s.name)}`); toast("Deleted", s.name, "ok"); refresh(); } catch (err: WebDynamic) { toastError(err); }
}

// ---------- members ----------
async function membersTab(projectKey: WebDynamic, project: WebDynamic, slot: WebDynamic) {
  let items: WebDynamic = [];
  try { ({ items } = await api.cached(`/projects/${projectKey}/members`)); } catch (err: WebDynamic) { return toastError(err); }
  const ROLES: WebDynamic = ["viewer", "editor", "reviewer", "developer", "admin"];
  const add = h("button.btn.primary", { onclick: () => addMemberModal(projectKey, () => membersTab(projectKey, project, slot)) }, "+ Add member");
  const body = h("div.card", {}, h("table.rows", {},
    h("thead", {}, h("tr", {}, h("th", {}, "Member"), h("th", {}, "Role"), h("th", {}))),
    h("tbody", {}, ...items.map((m: WebDynamic) => h("tr", {},
      h("td", {}, m.name || m.email, h("div.desc", {}, m.email)),
      h("td", {}, roleSelect(m, async (role: WebDynamic) => {
        try { await api.put(`/projects/${projectKey}/members/${m.user_id}`, { role }); toast("Role updated", `${m.email} → ${role}`, "ok"); }
        catch (err: WebDynamic) { toastError(err); }
      }, ROLES)),
      h("td", { style: "text-align:right" }, h("button.btn.btn-sm.danger", { "aria-label": `Remove ${m.email} from this project`, onclick: () => removeMember(projectKey, m, () => membersTab(projectKey, project, slot)) }, "Remove")),
    ))),
  ));
  // Project teardown lives here so Settings stays three sections — Team is
  // already admin-only and is the ownership surface.
  const danger = h("section", { style: "margin-top:28px" },
    h("h3.section-title", {}, "Danger zone"),
    h("div.card.pad", {},
      h("div", { style: "display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap" },
        h("div", { style: "flex:1;min-width:200px" },
          h("div", { style: "font-weight:500" }, "Delete this project"),
          h("p.dim", { style: "font-size:12.5px;margin:4px 0 0" },
            "Permanently removes the project, its suites, runs, findings, environments, secrets, and membership. The key becomes free to reuse."),
        ),
        h("button.btn.danger", { onclick: () => deleteProjectFlow(projectKey, project) }, "Delete project…"),
      ),
    ),
  );
  mount(slot, h("div", {}, h("div", { style: "display:flex;justify-content:flex-end;margin-bottom:12px" }, add), body, danger));
}

// enhanceSelect hides the native <select> behind a <button>, and a button takes
// its accessible name from its own text — which here is just "admin", identical
// on every row. The select's aria-label doesn't reach it (same trick as the
// project switcher in lib/shell.ts), so label the button and keep it in sync so
// the current role is still announced.
function roleSelect(m: WebDynamic, onPick: WebDynamic, roles: WebDynamic) {
  const sel = h("select", { "aria-label": `Role for ${m.email}`, onchange: (e: WebDynamic) => onPick(e.target.value) },
    ...roles.map((r: WebDynamic) => h("option", { value: r, selected: m.role === r }, r)));
  const wrap = enhanceSelect(sel);
  const btn = wrap.querySelector("button");
  const label = () => btn?.setAttribute("aria-label", `Role for ${m.email}: ${sel.value}`);
  sel.addEventListener("change", label);
  label();
  return wrap;
}

function addMemberModal(projectKey: WebDynamic, refresh: WebDynamic) {
  const close = formModal("Add member", () => {
    const email = h("input", { type: "email", placeholder: "person@company.com" });
    const role = h("select", {}, ...["viewer", "editor", "reviewer", "developer", "admin"].map((r) => h("option", { value: r }, r)));
    return h("form", { onsubmit: submit },
      fld("Email", email, "the person must have signed in at least once"),
      fld("Role", role),
      h("div.modal-actions", {}, h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"), h("button.btn.primary", { type: "submit" }, "Add")),
    );
    async function submit(e: WebDynamic) {
      e.preventDefault();
      try {
        const { items } = await api.get(`/users?email=${encodeURIComponent(email.value.trim())}`);
        if (!items.length) return toast("No such user", "They need to sign in once first.", "err");
        await api.put(`/projects/${projectKey}/members/${items[0].id}`, { role: role.value });
        close(); toast("Member added", email.value.trim(), "ok"); refresh();
      } catch (err: WebDynamic) { toastError(err); }
    }
  });
}

async function removeMember(projectKey: WebDynamic, m: WebDynamic, refresh: WebDynamic) {
  if (!(await confirmModal({ title: `Remove ${m.email}?`, body: "They will lose access to this project.", confirmLabel: "Remove", danger: true }))) return;
  try { await api.del(`/projects/${projectKey}/members/${m.user_id}`); toast("Removed", m.email, "ok"); refresh(); } catch (err: WebDynamic) { toastError(err); }
}

/** Permanent project teardown — admin only, under Team with the other
 *  ownership controls so Settings stays three sections. */
async function deleteProjectFlow(projectKey: WebDynamic, project: WebDynamic) {
  const ok = await confirmModal({
    title: `Delete “${project.name}”?`,
    body: h("div", {},
      h("p.dim", {}, "Permanently deletes this project and everything in it: suites, stories, runs, findings, environments, secrets, and membership."),
      h("p.dim", {}, "This cannot be undone. The project key becomes free to use again."),
    ),
    confirmLabel: "Delete project",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/projects/${projectKey}`);
    // Drop the gone project from the switcher before navigating, and refresh
    // /me so roles no longer claim admin of a deleted id.
    await Promise.all([loadMe(), loadProjects()]);
    toast("Project deleted", project.name, "ok");
    navigate("/projects");
  } catch (err: WebDynamic) { toastError(err); }
}

// ---------- audit ----------
// The log stores machine identity — actor ULIDs, entity ULIDs, and a detail
// document that includes fingerprint hashes. None of that is what an admin came
// to read, so this view resolves people to names, says what happened in a
// sentence, and keeps the raw document one click away.
async function auditTab(projectKey: WebDynamic, project: WebDynamic, slot: WebDynamic) {
  let items: WebDynamic = [];
  const names: WebDynamic = new Map();
  // The reader is always an actor in their own log; seed them so a project with
  // one member still names itself.
  if (state.me?.user_id) names.set(state.me.user_id, state.me.name || state.me.email);
  try {
    const [log, members] = await Promise.all([
      api.get(`/projects/${projectKey}/audit?limit=100`),
      // Members is a viewer-level read and this tab is admin-only, so resolving
      // ids costs no new endpoint and no new permission. A failure here only
      // costs names, not the log — fall back to short ids.
      api.cached(`/projects/${projectKey}/members`).catch(() => ({ items: [] })),
    ]);
    items = log.items;
    for (const m of members.items || []) names.set(m.user_id, m.name || m.email);
  } catch (err: WebDynamic) { return toastError(err); }
  const who = (id: WebDynamic) => (id ? names.get(id) || `user ${shortId(id)}` : "someone");
  const body = items.length
    ? h("div.card", {}, h("table.rows", {},
        h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Actor"), h("th", {}, "Action"), h("th", {}, "Entity"), h("th", {}, "Detail"))),
        h("tbody", {}, ...items.map((a: WebDynamic) => h("tr", {},
          h("td.dim", {}, new Date(a.ts).toLocaleString()),
          h("td", { style: "font-size:12.5px", title: actorId(a.actor) }, actorLabel(a.actor, names)),
          h("td", {}, h("span.chip", {}, a.action)),
          h("td", {}, entityCell(projectKey, a)),
          h("td", { style: "max-width:420px" }, detailCell(a, who)),
        ))),
      ))
    : emptyState("No audit entries yet", "Every mutation — edits, commits, role grants — will appear here.");
  mount(slot, body);
}

/** The audit actor shape ({user_id}|{token_id}|{system}) → the person, not the key. */
function actorLabel(actor: WebDynamic, names: WebDynamic) {
  if (!actor || typeof actor !== "object") return "unknown";
  // An id that no longer resolves (a member who was removed) still has to read
  // as something — the short id, never a blank cell.
  if (actor.user_id) return names.get(actor.user_id) || `user ${shortId(actor.user_id)}`;
  if (actor.token_id) return `API token ${shortId(actor.token_id)}`;
  if (actor.system) return SYSTEM_ACTORS[actor.system] || words(actor.system);
  return "unknown";
}

// Playtest's own workers write audit rows too; name them for what they do.
const SYSTEM_ACTORS: WebDynamic = {
  retention: "retention (automatic)",
  findings: "findings engine",
  runner: "run executor",
  reconciler: "dispatch watchdog",
  anonymous: "anonymous",
};

const actorId = (a: WebDynamic) => a?.user_id || a?.token_id || null;

/** Entity ids link only where the UI has a route AND the row carries what it needs. */
function entityCell(projectKey: WebDynamic, a: WebDynamic) {
  const label = h("span.mono", { style: "font-size:11.5px" }, `${a.entity_type}${a.entity_id ? " " + shortId(a.entity_id) : ""}`);
  const to = entityHref(projectKey, a);
  return to ? link(to, label) : label;
}

function entityHref(projectKey: WebDynamic, a: WebDynamic) {
  // The thing is gone — its page is a 404, and a broken link is worse than none.
  if (/\.deleted$/.test(a.action)) return null;
  if (a.entity_id) {
    if (a.entity_type === "finding") return `/p/${projectKey}/findings/${a.entity_id}`;
    // Historical rows: candidates collapsed into findings keeping their ids.
    if (a.entity_type === "bug_candidate") return `/p/${projectKey}/findings/${a.entity_id}`;
    if (a.entity_type === "consolidation_plan") return `/p/${projectKey}/consolidation/${a.entity_id}`;
  }
  // Suites route by slug, not id, so only the rows that record one can link.
  // Runs need their group id (the row has neither), and environments, secrets
  // and providers live on this page — none of those get a link.
  if (a.entity_type === "suite" && a.detail?.slug) return `/p/${projectKey}/suites/${a.detail.slug}`;
  return null;
}

/**
 * A sentence plus the raw document behind a disclosure. Hashes, suppression
 * keys and error dumps stay in the disclosure — the sentence never promotes a
 * value that looks like a secret.
 */
function detailCell(a: WebDynamic, who: WebDynamic) {
  const raw = a.detail && typeof a.detail === "object" && Object.keys(a.detail).length ? a.detail : null;
  return h("div", {},
    h("div", { style: "font-size:12.5px" }, auditSentence(a, who)),
    raw
      ? h("details.advanced", { style: "margin-top:4px" },
          h("summary", { style: "font-size:11px", "aria-label": `Raw detail for ${a.action} at ${new Date(a.ts).toLocaleString()}` }, "raw detail"),
          h("pre.mono", { style: "margin:6px 0 0;background:var(--bg2);padding:8px;border-radius:6px;overflow:auto;font-size:11px;white-space:pre-wrap" }, JSON.stringify(raw, null, 2)),
        )
      : null,
  );
}

function auditSentence(a: WebDynamic, who: WebDynamic) {
  const say = AUDIT_SENTENCES[a.action];
  try {
    if (say) return say(a.detail || {}, who);
  } catch { /* a malformed detail must not blank the row — fall through */ }
  // Unmapped (or newly added) actions still read as English: actions are
  // `<entity>.<verb>`, so "widget.frobbed" on a widget reads "widget frobbed".
  const verb = words(String(a.action).split(".").pop());
  const thing = a.entity_type ? words(a.entity_type) : null;
  return thing ? `${thing} ${verb}` : verb;
}

// One sentence per action. The list is every `action:` passed to audit() in the
// control plane — keep it in step when a new one lands; anything missing falls
// back to the verb above.
const AUDIT_SENTENCES: WebDynamic = {
  // Test targets — this page's own objects. The detail carries the human name.
  "environment.created": (d: WebDynamic) => `created environment ${nameOf(d)}${d.discovery_allowed ? ", discovery allowed" : ""}`,
  "environment.updated": (d: WebDynamic) => `updated environment ${nameOf(d)} — discovery ${d.discovery_allowed ? "allowed" : "not allowed"}`,
  "environment.deleted": (d: WebDynamic) => `deleted environment ${nameOf(d)}`,
  "auth_provider.created": (d: WebDynamic) => `added auth provider ${nameOf(d)}${d.kind ? ` (${words(d.kind)})` : ""}`,
  "auth_provider.updated": (d: WebDynamic) => `updated auth provider ${nameOf(d)}${d.enabled === false ? " — now disabled" : ""}`,
  "auth_provider.deleted": (d: WebDynamic) => `deleted auth provider ${nameOf(d)}`,
  "secret.created": (d: WebDynamic) => `added secret ${nameOf(d)}`,
  "secret.rotated": (d: WebDynamic) => `rotated secret ${nameOf(d)} — the stored value was replaced`,
  "secret.deleted": (d: WebDynamic) => `deleted secret ${nameOf(d)}`,

  // Personas — project-wide, so an edit reaches every suite's next run.
  "persona.created": (d: WebDynamic) => `created persona ${d.slug || nameOf(d)}`,
  "persona.updated": (d: WebDynamic) => `rewrote persona ${d.slug || nameOf(d)} — every story using it runs with the new text`,
  "persona.deleted": (d: WebDynamic) => `deleted persona ${d.slug || nameOf(d)}`,

  // Project, people, API tokens.
  "project.created": (d: WebDynamic) => `created this project${d.name ? ` as ${d.name}` : ""}`,
  "project.deleted": (d: WebDynamic) => `deleted project ${d.name || d.key || "—"}`,
  "member.set": (d: WebDynamic, who: WebDynamic) => `${who(d.user_id)} is now ${d.role || "a member"}`,
  "member.removed": (d: WebDynamic, who: WebDynamic) => `removed ${who(d.user_id)} from this project`,
  "token.created": (d: WebDynamic) => `created API token ${nameOf(d)}${d.role ? ` with the ${d.role} role` : ""}`,
  "token.revoked": (d: WebDynamic) => `revoked API token ${nameOf(d)}`,

  // Suites and the files inside them (every file write is a commit).
  "suite.created": (d: WebDynamic) => `created suite ${d.name || d.slug || "—"}`,
  "suite.deleted": (d: WebDynamic) => `deleted suite ${d.name || d.slug || "—"}`,
  "suite.archived": (d: WebDynamic) => `archived suite ${d.slug || "—"}`,
  "suite.unarchived": (d: WebDynamic) => `took suite ${d.slug || "—"} out of the archive`,
  "suite.committed": (d: WebDynamic) => `committed ${plural(changeCount(d), "change")}${revision(d)}${noteTail(d)}`,
  "suite.imported": (d: WebDynamic) => `replaced this suite's files from an import — ${plural(changeCount(d), "change")}${revision(d)}`,
  "file.saved": (d: WebDynamic) => `saved ${firstPath(d)}${revision(d)}${noteTail(d)}`,
  "file.deleted": (d: WebDynamic) => `deleted ${firstPath(d)}${revision(d)}`,

  // Runs and what happens to their artifacts afterwards.
  "run_group.created": (d: WebDynamic) => `queued a run of ${plural(d.cases, "story", "stories")}${noteTail(d)}`,
  "run_group.canceled": () => "canceled this run",
  "run_group.completed": (d: WebDynamic) => `run finished — ${caseTally(d)}`,
  "run.clip_created": (d: WebDynamic) => `made a video clip of this run${d.captions ? " with captions" : ""}`,
  "retention.pruned": (d: WebDynamic) => `retention dropped ${plural(countOf(d.dropped), "stored file")} from this run, keeping the ${d.tier || "core"} tier${Number.isFinite(d.policy_days) ? ` after ${plural(d.policy_days, "day")}` : ""}`,
  "storage.integrity_failed": () => "a stored artifact no longer matches its checksum",
  "dispatch.dead": (d: WebDynamic) => `gave up on a dispatched job${d.reason ? ` — ${words(d.reason)}` : ""}${d.redispatch ? ", and queued a replacement" : ""}`,

  // Auth sessions minted for the identities an environment references.
  "session.minted": (d: WebDynamic) => `minted a session for ${identityOf(d)}`,
  "session.delivered": (d: WebDynamic) => `handed a session for ${identityOf(d)} to a run`,
  "session.mint_dispatched": (d: WebDynamic) => `asked a runner to mint a session for ${identityOf(d)}`,
  "session.mint_granted": (d: WebDynamic) => `let a runner mint a session for ${identityOf(d)}`,
  "session.mint_failed": (d: WebDynamic) => `could not mint a session for ${identityOf(d)} — the error is in the raw detail`,

  // Findings and the consolidation pass over them. The bug_candidate.*
  // actions are historical — candidates collapsed into findings (2026-07) —
  // but audit rows are forever, so their sentences stay renderable.
  "finding.created": (d: WebDynamic) => `opened this finding${d.promoted_candidate_id ? " from a promoted candidate" : fromStory(d)}`,
  "finding.evidence_added": (d: WebDynamic) => `added ${Number.isFinite(d.evidence_added) ? `${plural(d.evidence_added, "piece", "pieces")} of ` : ""}evidence to this finding${fromStory(d)}`,
  "finding.reopened": (d: WebDynamic) => (d.reason === "recurrence" ? `reopened this finding — ${d.case_id ? `story ${d.case_id}` : "it"} failed again` : "reopened this finding"),
  "finding.accepted": (d: WebDynamic) => `confirmed this finding${d.severity ? ` as ${words(d.severity)}` : ""}`,
  "finding.rejected": (d: WebDynamic) => `dismissed this finding${d.reason ? ` — ${words(d.reason)}` : ""}`,
  "finding.resolved": () => "marked this finding resolved",
  "finding.auto_resolved": (d: WebDynamic) => `resolved this finding automatically — ${d.run_id ? `run ${shortId(d.run_id)}` : "a later run"} demonstrated the fix`,
  "finding.recurred": (d: WebDynamic) => `saw this defect again after it was resolved${d.case_id ? ` — story ${d.case_id} failed` : ""}; returned it to needs review`,
  "finding.acknowledged": () => "acknowledged the automatic resolution as correct",
  "finding.fix_suggested": (d: WebDynamic) => `suggested this finding may be fixed — ${d.run_id ? `run ${shortId(d.run_id)}` : "a newer run"} passed its story`,
  "finding.fix_dismissed": () => "judged the fix suggestion wrong — the defect is still present",
  "finding.merged": (d: WebDynamic) => `merged this finding into ${d.into ? shortId(d.into) : "another one"}`,
  "finding.split": (d: WebDynamic) => `split this finding out of ${d.from ? shortId(d.from) : "another one"}`,
  "bug_candidate.created": (d: WebDynamic) => `logged a suspected bug${d.category ? ` — ${categoryLabel(d.category).toLowerCase()}` : ""}${d.suggested_finding_id ? ", suggested against an existing finding" : ""}`,
  "bug_candidate.evidence_added": (d: WebDynamic) => `added evidence to a suspected bug already on file`,
  "bug_candidate.auto_dismissed": () => "auto-dismissed a suspected bug — it matches one already dismissed",
  "bug_candidate.dismissed": (d: WebDynamic) => `dismissed this suspected bug${d.reason ? ` — ${words(d.reason)}` : ""}`,
  "bug_candidate.promoted": (d: WebDynamic) => `promoted this suspected bug to ${d.created ? "a new finding" : "an existing finding"}`,
  "candidate.accepted": (d: WebDynamic) => `accepted the new baseline for ${d.story_id || "a story"}${d.version ? ` (version ${d.version})` : ""}`,
  "candidate.rejected": (d: WebDynamic) => `rejected the baseline change for ${d.story_id || "a story"}`,
  "consolidation.planned": (d: WebDynamic) => `planned a consolidation of ${plural(d.items, "finding")}`,
  "consolidation.applied": (d: WebDynamic) => `applied a consolidation plan — ${plural(countOf(d.applied), "change")}`,
  "consolidation.discarded": () => "discarded a consolidation plan",
};

const fld = formField;
const shortId = (id: WebDynamic) => (id.length > 10 ? id.slice(-6) : id);
// Machine enums and system names are snake_case; humans are not.
const nameOf = (d: WebDynamic) => (typeof d.name === "string" && d.name ? d.name : "—");
const countOf = (v: WebDynamic) => (Array.isArray(v) ? v.length : Number.isFinite(v) ? v : null);
const plural = (n: WebDynamic, one: WebDynamic, many = `${one}s`) => (Number.isFinite(n) ? `${n} ${n === 1 ? one : many}` : `some ${many}`);
const changeCount = (d: WebDynamic) => countOf(d.changes);
const firstPath = (d: WebDynamic) => (Array.isArray(d.changes) && d.changes[0]?.path) || "a file";
const revision = (d: WebDynamic) => (Number.isFinite(d.seq) ? ` as revision ${d.seq}` : "");
const noteTail = (d: WebDynamic) => (d.note ? ` — ${d.note}` : "");
const fromStory = (d: WebDynamic) => (d.case_id ? ` from story ${d.case_id}` : "");
const identityOf = (d: WebDynamic) => `${d.identity || "an identity"}${d.provider ? ` on ${d.provider}` : ""}`;

// Run statuses are enums; the tally reads them out as outcomes.
const CASE_WORDS: WebDynamic = { pass: "passed", fail: "failed", infra: "infrastructure failures", explored: "explored", canceled: "canceled", lost: "lost" };
function caseTally(d: WebDynamic) {
  const cases = Array.isArray(d.cases) ? d.cases : [];
  if (!cases.length) return `exit code ${d.exit_code ?? "?"}`;
  const by: WebDynamic = new Map();
  for (const c of cases) by.set(c.status, (by.get(c.status) || 0) + 1);
  return [...by].map(([s, n]) => `${n} ${CASE_WORDS[s] || words(s)}`).join(", ");
}
