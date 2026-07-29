// Settings — role-gated project policy. Runners is developer-facing; Runs,
// Models, Team, and Audit are admin-facing. Plugins, Integrations, and
// Retention were removed from the UI in the P1 simplification.
//
// What a project tests, and where each surface is deployed, is NOT here: that
// is Applications, a first-class project section, because creating the first
// application is the first step of the first run rather than a policy tab.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { link, navigate, onPageLeave } from "../lib/router.js";
import { page } from "../lib/shell.js";
import { state, hasRole, loadMe, loadProjects } from "../lib/state.js";
import { toast, toastError, confirmModal, formModal, emptyState, errorState, formField, enhanceSelect, copyText } from "../lib/ui.js";
import { visibleSections } from "../lib/settings-sections.js";
import { modelField } from "../lib/model-select.js";
import { humanize as words, categoryLabel } from "../lib/vocab.js";
import { startCommand, oneShot, runnerLabelsText, runnerPresence, labelProblem, parseLabels } from "../lib/runners.js";
import { RUNNER_GUIDE } from "../lib/rings.js";
import { subscribeFeed } from "../lib/feed.js";
import { ago } from "../lib/labels.js";
import { projectPage } from "../lib/project-page.js";
import { runsSettingsTab } from "./settings-runs.js";

const RENDER: WebDynamic = {
  runners: runnersTab,
  runs: runsSettingsTab,
  models: modelsTab,
  team: membersTab,
  audit: auditTab,
};

export function settingsPage(projectKey: WebDynamic, tab?: WebDynamic) {
  const context = projectPage(projectKey, { nav: "settings", title: "Settings", loading: false });
  if (!context) return;
  const { main, project } = context;

  const tabs = visibleSections((min: WebDynamic) => hasRole(project.id, min), state.me?.capabilities || {})
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

// ---------- runners ----------
// A self-hosted runner is the machine a run actually happens on. Everything it
// does is outbound (docs/contracts/hosted.md, "Runner pool"), so this surface
// hands out an identity and never reaches back: register → paste one command on
// that machine → give a ring the labels it advertises.
//
// The section is LIVE, and it is live the way the rest of the console is: the
// event feed carries the edges (a runner arriving, coming back, taking a claim,
// being revoked) and this page refetches once when one lands. Nothing here
// polls. Between edges, presence is arithmetic on `last_seen_at` against the
// window the server publishes, re-read on a slow local clock that makes no
// request at all — which is how a laptop that closed its lid goes quiet on this
// page without anything having told anybody.
async function runnersTab(projectKey: WebDynamic, project: WebDynamic, slot: WebDynamic) {
  const ctl: WebDynamic = { items: [], sig: null };
  const windowS = state.me?.capabilities?.runner_check_in_window_s ?? 120;
  const load = async () => { ctl.items = (await api.get(`/projects/${projectKey}/runners`)).items || []; };
  try {
    await load();
  } catch (err: WebDynamic) {
    return mount(slot, errorState(err, () => runnersTab(projectKey, project, slot)));
  }

  // One subscription and one slow repaint clock, both torn down on navigation.
  let debounce: WebDynamic = null;
  const sub = subscribeFeed(projectKey, {
    // `runner.status` is presence and claims; `run.status` is how a claim ENDS —
    // a group finishing releases its runner, and no runner event says so.
    types: ["runner.status", "run.status"],
    onEvent: () => {
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        try { await load(); paint(); } catch { /* the next edge retries */ }
      }, 250);
    },
  });
  // Not a poll: no request, no server. It re-reads the clock so "online" can
  // become "offline" when the truth is that nothing has been heard.
  const tick = setInterval(() => paint(), 15_000);
  const stop = () => { sub.stop(); clearInterval(tick); clearTimeout(debounce); };
  onPageLeave(stop);

  const refresh = async () => { try { await load(); paint(); } catch (err: WebDynamic) { toastError(err); } };
  paint(true);

  function paint(first = false) {
    const now = Date.now();
    const rows = ctl.items.map((r: WebDynamic) => ({ r, presence: runnerPresence(r, { now, windowS }) }));
    // Nothing moved ⇒ nothing repaints: a rebuild costs focus and any menu the
    // person had open, and this paints itself every 15 seconds.
    const sig = JSON.stringify(rows.map(({ r, presence }: WebDynamic) =>
      [r.id, presence.state, r.labels, r.claim?.run_group_id ?? null, r.claim?.foreign ?? null, r.last_seen_at]));
    if (!first && sig === ctl.sig) return;
    ctl.sig = sig;

    const add = h("button.btn.primary", { "data-fk": "runner:add", onclick: () => registerRunnerModal(projectKey, refresh) }, "+ Register runner");
    const here = rows.filter(({ presence }: WebDynamic) => presence.tone !== "off").length;

    const body = rows.length
      ? h("div", { style: "display:flex;flex-direction:column;gap:12px" }, ...rows.map(({ r, presence }: WebDynamic) =>
          h("div.card.pad", {},
            h("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap" },
              h("span.id", {}, r.name),
              presenceChip(presence),
              // A machine the site operator shares with every project. It is
              // listed because this project's runs really do land on it, and it
              // is read-only because retiring it is not this project's call.
              r.scope === "site" ? h("span.chip", { title: "Shared across every project on this deployment — administered by the site operator" }, "shared") : null,
              h("div", { style: "flex:1" }),
              // Every row repeats one verb, so the accessible name carries the runner.
              r.revoked_at || r.managed_here === false
                ? null
                : h("button.btn.btn-sm.danger", {
                    "aria-label": `Revoke runner ${r.name}`,
                    "data-fk": `runner:revoke:${r.id}`,
                    onclick: () => revokeRunner(projectKey, r, refresh),
                  }, "Revoke"),
            ),
            fieldLine("labels", runnerLabelsText(r.labels)),
            fieldLine("last seen", r.last_seen_at
              ? `${ago(r.last_seen_at)} (${new Date(r.last_seen_at).toLocaleString()})`
              : "never — it has not checked in yet"),
            // What it is doing right now, as a link to the run itself: a busy
            // runner without a way to see the run it is busy with is a dead end.
            r.claim?.run_group_id
              ? h("div.dim", { style: "margin-top:6px;font-size:12px" },
                  "running: ",
                  link(`/p/${projectKey}/runs/${r.claim.run_group_id}`, "this run"),
                  r.claim.claimed_at ? h("span.faint", {}, ` · claimed ${ago(r.claim.claimed_at)}`) : null)
              // A shared runner's other tenant is none of this project's
              // business: it is busy, and that is the whole of what is said.
              : r.claim?.foreign
                ? fieldLine("running", `busy in another project${r.claim.claimed_at ? ` · since ${ago(r.claim.claimed_at)}` : ""}`)
                : r.claim
                  ? fieldLine("running", "minting an auth session")
                  : null,
            r.revoked_at ? fieldLine("revoked", new Date(r.revoked_at).toLocaleString()) : null,
          )))
      : emptyState(
          "No runners registered",
          "A self-hosted runner runs your suites on a machine you control — your laptop, a build box, a CI job — so a run can reach an app on localhost, a device simulator, or anything behind your firewall. It dials out to Playtest; nothing ever connects to it.",
        );

    const focusKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.fk || null : null;
    mount(slot, h("div.stack", {},
      h("section", {},
        h("h3.section-title", { style: "margin-top:0" }, "Runners"),
        h("p.dim", { style: "font-size:12.5px;margin:-4px 0 8px" },
          "Machines that execute this project's runs. Register one here, start it with the command shown, then give a ring the same labels under Applications — a run is placed on a runner advertising every label its ring asks for."),
        // What each machine can reach is that machine's own business, so this
        // page holds no target inventory — just where a machine declares one.
        h("p.faint", { style: "font-size:11.5px;margin:0 0 12px" },
          "A runner that tests mobile builds also starts with ", h("span.mono", {}, "--config <file>"),
          ", a file on its own disk naming the build, device and Appium server per application and ring — the format is in ",
          h("span.mono", {}, RUNNER_GUIDE), "."),
        h("div.section-actions", {}, add),
        body,
        rows.length && !here
          ? h("p.faint", { style: "font-size:11.5px;margin-top:12px" },
              `Nothing is checked in. Runs placed on this project wait on the board and then fail with the labels nothing served — start a runner with its command, or check that the process is still up. A runner counts as here if it checked in within ${Math.round(windowS / 60) >= 1 ? `${Math.round(windowS / 60)} minutes` : `${windowS} seconds`}.`)
          : null,
      ),
    ));
    if (focusKey) slot.querySelector(`[data-fk="${focusKey}"]`)?.focus();
  }
}

/** Presence as a dot AND a word — the dot is the scan target, the word is what
    a screen reader (and a person who doesn't know the palette) reads. */
function presenceChip(presence: WebDynamic) {
  return h(`span.runner-presence.${presence.tone}`, { title: presence.detail },
    h("span.runner-dot", { "aria-hidden": "true" }),
    presence.label,
    h("span.visually-hidden", {}, ` — ${presence.detail}`));
}

/**
 * Register, then reveal — once. The credential is stored hashed, so this dialog
 * is the only place it will ever exist; the second step says so plainly and
 * hands over the exact command rather than a shape to assemble.
 */
function registerRunnerModal(projectKey: WebDynamic, refresh: WebDynamic) {
  const close = formModal("Register runner", () => {
    const name = h("input", { type: "text", placeholder: "adas-laptop" });
    const labels = h("input", { type: "text", placeholder: "macos, ios-sim" });
    const submitBtn = h("button.btn.primary", { type: "submit" }, "Register");
    return h("form", { onsubmit: submit },
      fld("Name", name, "How this machine appears in run history. Unique among this project's live runners — a revoked machine's name is free again."),
      fld("Labels", labels, "What this machine can do — a ring asking for these labels places its runs here. Comma separated, using letters, digits, “.”, “_” and “-”; leave blank to take any of this project's runs."),
      h("div.modal-actions", {}, h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"), submitBtn),
    );
    async function submit(e: WebDynamic) {
      e.preventDefault();
      const payload: WebDynamic = { name: name.value.trim(), labels: parseLabels(labels.value) };
      if (!payload.name) return toast("Name the runner", "Give this machine a name you'll recognize in run history.", "err");
      const problem = labelProblem(payload.labels);
      if (problem) return toast("Check the labels", problem, "err");
      submitBtn.disabled = true;
      try {
        const runner = await api.post(`/projects/${projectKey}/runners`, payload);
        close();
        revealRunnerCredential(runner, refresh);
      } catch (err: WebDynamic) { toastError(err); submitBtn.disabled = false; }
    }
  });
}

/**
 * The one and only sight of a runner credential.
 *
 * It gets its own dialog rather than the generic one because it is the single
 * place in the console where dismissing a modal destroys something: Escape or a
 * stray scrim click would take the only copy of a secret the server cannot
 * reissue. So this dialog — and only this dialog — asks before it goes, and
 * stops asking once the command has been copied somewhere it can be pasted from.
 */
function revealRunnerCredential(runner: WebDynamic, refresh: WebDynamic) {
  // A one-shot box, not a variable: a re-render, a reopened dialog or a stray
  // reference cannot show this twice, because the server itself cannot.
  const secret = oneShot(runner.credential);
  const command = startCommand({ server: location.origin, credential: secret.take() || "", labels: runner.labels || [] });
  let copied = false;
  let copyBtn: WebDynamic = null;
  let leave: WebDynamic = null;
  // Empty until it is needed: an alert built up front would put two hidden
  // buttons ahead of Copy in the dialog's focus order.
  const guard = h("div.preview-warn", { role: "alert", hidden: true, style: "margin:12px 0 0" });

  formModal(`${runner.name} is registered`, (done: WebDynamic) => {
    leave = () => { done(); refresh(); };
    copyBtn = h("button.btn.primary", {
      onclick: async () => {
        const ok = await copyText(command);
        // A successful copy is the only proof we can get cheaply that the
        // credential now exists somewhere else. It is enough to stop nagging.
        copied = copied || ok;
        toast(ok ? "Command copied" : "Couldn't copy", ok ? "Paste it into a terminal on that machine." : "Select the command and copy it manually.", ok ? "ok" : "err");
      },
    }, "Copy command");
    return h("div", {},
      h("p.dim.section-caption", {},
        "Run this on the machine you want your suites to execute on. It is the only time this credential is shown — Playtest stores a hash of it and cannot show it again."),
      h("pre.mono", {
        style: "background:var(--bg2);padding:12px;border-radius:6px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-all",
        // The command is the payload of this dialog; make it selectable as one
        // unit for people who copy with the keyboard rather than the button.
        tabindex: "0",
        "aria-label": "Runner start command",
      }, command),
      h("p.faint", { style: "font-size:11.5px;margin:10px 0 0" },
        "Run it from your Playtest checkout. The credential travels in the process environment, never as an argument, so it stays out of your process list. The runner then waits for work and prints what it is doing."),
      h("p.faint", { style: "font-size:11.5px;margin:6px 0 0" },
        "Pasted this way it also lands in your shell history. On a machine you share, put the credential in a file only you can read and start the runner with ",
        h("span.mono", {}, "--credential-file <path>"), " instead."),
      h("p.faint", { style: "font-size:11.5px;margin:6px 0 0" },
        "For mobile runs, add ", h("span.mono", {}, "--config <file>"),
        " — a file on that machine naming the build it holds, the device and the Appium server, keyed by application and ring. The format is in ",
        h("span.mono", {}, RUNNER_GUIDE), "."),
      h("p.faint", { style: "font-size:11.5px;margin:6px 0 0" },
        `Give a ring the ${(runner.labels || []).length ? `labels ${runnerLabelsText(runner.labels)}` : "runner labels you want"} under Applications to place its runs here.`),
      guard,
      h("div.modal-actions", {}, copyBtn, h("button.btn.ghost", { onclick: leave }, "Done")),
    );
  }, {
    // Escape and scrim-click are the only ways to lose this dialog by accident,
    // and losing it costs a registration. Ask once, and never again once the
    // command has been copied somewhere it can be pasted from.
    confirmDismiss: () => {
      if (copied) return true;
      mount(guard,
        h("div", {}, "This credential cannot be shown again — Playtest stores only a hash of it. Close now and this runner has to be registered over."),
        h("div", { style: "display:flex;gap:8px;margin-top:8px" },
          h("button.btn.btn-sm", { type: "button", onclick: () => { mount(guard); guard.hidden = true; copyBtn?.focus(); } }, "Copy it first"),
          h("button.btn.btn-sm.danger", { type: "button", onclick: leave }, "Close anyway"),
        ),
      );
      guard.hidden = false;
      guard.querySelector("button")?.focus();
      return false;
    },
  });
}

async function revokeRunner(projectKey: WebDynamic, runner: WebDynamic, refresh: WebDynamic) {
  const ok = await confirmModal({
    title: `Revoke ${runner.name}?`,
    body: "Its credential stops working: it can no longer check in or claim work. A run already in flight finishes. To use that machine again, register it and paste the new command.",
    confirmLabel: "Revoke",
    danger: true,
  });
  if (!ok) return;
  try { await api.del(`/projects/${projectKey}/runners/${runner.id}`); toast("Runner revoked", runner.name, "ok"); refresh(); }
  catch (err: WebDynamic) { toastError(err); }
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
    h("p.dim.section-caption", {},
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

const fieldLine = (k: WebDynamic, v: WebDynamic) => h("div.dim", { style: "margin-top:6px;font-size:12px" }, `${k}: `, h("span.mono", {}, v));

// ---------- members ----------
async function membersTab(projectKey: WebDynamic, project: WebDynamic, slot: WebDynamic) {
  let items: WebDynamic = [];
  try {
    ({ items } = await api.cached(`/projects/${projectKey}/members`));
  } catch (err: WebDynamic) {
    return mount(slot, errorState(err, () => membersTab(projectKey, project, slot)));
  }
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
            "Permanently removes the project, its suites, runs, findings, applications, rings, secrets, and membership. The key becomes free to reuse."),
        ),
        h("button.btn.danger", { onclick: () => deleteProjectFlow(projectKey, project) }, "Delete project…"),
      ),
    ),
  );
  mount(slot, h("div", {}, h("div.section-actions", {}, add), body, danger));
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
      h("p.dim", {}, "Permanently deletes this project and everything in it: suites, stories, runs, findings, applications, rings, secrets, and membership."),
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
  } catch (err: WebDynamic) {
    return mount(slot, errorState(err, () => auditTab(projectKey, project, slot)));
  }
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
  // Runs need their group id (the row has neither), and applications, rings,
  // secrets and providers live on Applications — none of those get a link.
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
  // Applications and their rings. Both are addressed by key, which is what
  // runner configuration binds, so the sentence says the key, not the name.
  "application.created": (d: WebDynamic) => `created application ${d.key || nameOf(d)}${d.driver ? ` — a ${[d.driver, d.platform].filter(Boolean).join(" ")} surface` : ""}`,
  "application.updated": (d: WebDynamic) => `renamed application ${d.key || nameOf(d)} to ${nameOf(d)}`,
  "application.deleted": (d: WebDynamic) => `deleted application ${d.key || nameOf(d)}`,
  "ring.created": (d: WebDynamic) => `created ring ${ringOf(d)}${d.base_url ? ` → ${d.base_url}` : ""}${d.discovery_allowed ? ", discovery allowed" : ""}`,
  "ring.updated": (d: WebDynamic) => `updated ring ${ringOf(d)}${d.base_url ? ` → ${d.base_url}` : ""} — discovery ${d.discovery_allowed ? "allowed" : "not allowed"}`,
  "ring.deleted": (d: WebDynamic) => `deleted ring ${ringOf(d)}`,
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

  // Auth sessions minted for the identities a ring references.
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
  "bug_candidate.evidence_added": () => "added evidence to a suspected bug already on file",
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
/** A ring reads as the pair a runner binds: `todo-web/staging`. */
const ringOf = (d: WebDynamic) => [d.application, d.key].filter(Boolean).join("/") || nameOf(d);
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
