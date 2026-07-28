// Suite settings — the suite's shared defaults (playtest.yaml), the file every
// story in the suite inherits from. This replaced the raw "Edit files" tree: the
// web app authors STORIES and the settings that shape them; personas, hooks and
// assertions are code-tier files that belong to the CLI (import a .tar to bring
// them in, export one to take them out).
//
// The most load-bearing setting is app.base_url. Without it core refuses to
// resolve any case in the suite — so a suite created without one cannot save its
// first story. That is why the New suite dialog asks for it and why this page
// leads with it.
//
// Form and YAML are two views of the identical bytes (the story editor's
// discipline): the form edits the parsed document IN PLACE, so comments, key
// order and unknown keys survive untouched.
import { api } from "../lib/api.js";
import { h, mount, clear } from "../lib/dom.js";
import { link, navigate } from "../lib/router.js";
import { renderFrame, page } from "../lib/shell.js";
import { state, hasRole } from "../lib/state.js";
import { toast, toastError, confirmModal, emptyState, errorState, formField, formModal, enhanceSelect, saveBar } from "../lib/ui.js";
import { parseYaml } from "../lib/caseform.js";
import {
  setAppKey, setViewportDimension, setLimitKey, setParallelValue, setModelKey, setEnvBaseUrl, resolveEnvTarget, baseUrlProblem,
  setEnvCookies, parseCookieList, formatCookieList, resolveEnvCookies,
  DEFAULT_ENV_NAME, ENV_NAME_RE, DRIVERS, driverLabel,
} from "../lib/defaults-form.js";
import { modelField } from "../lib/model-select.js";
import { environmentDriver } from "../lib/env-config.js";
import { getSuiteBySlug, exportSuite, importSuite } from "./suite.js";

const DEFAULTS_PATH = "playtest.yaml";

export async function suiteSettingsPage(projectKey: WebDynamic, slug: WebDynamic) {
  const main = renderFrame({ projectKey, nav: "suites" });
  const project = state.projectByKey.get(projectKey);
  mount(main, page({ title: "Suite settings", body: h("div.dim", {}, "Loading…") }));

  let suite: WebDynamic, st;
  try {
    // The defaults file rides the slug lookup (?include=defaults); an absent
    // file is a new suite's normal empty state, not an error.
    suite = await getSuiteBySlug(projectKey, slug, "defaults");
    if (!suite) return mount(main, page({ title: slug, body: h("div.dim", {}, "No such suite.") }));
    // A reader can still take the suite away as a .tar — reading the tree was
    // never privileged — but the settings themselves are an editor's to change.
    if (!hasRole(project.id, "editor")) {
      return mount(main, page({
        crumbs: [link(`/p/${projectKey}`, "Suites"), " / ", link(`/p/${projectKey}/suites/${slug}`, suite.name || slug), " / ", "Settings"],
        title: "Suite settings",
        actions: [h("button.btn", { onclick: () => exportSuite(suite), title: "Download this suite as a .tar the CLI can run" }, "Export")],
        body: emptyState("Editor only", "Suite settings are changed by editors. You can still export the suite as a .tar."),
      }));
    }
    // Everything below depends only on the suite id, so it loads as one
    // parallel batch, each part keeping its own degrade-don't-block behavior:
    // environments must not error the form for a role that can't read them
    // (the per-env table is then just absent), and without the model
    // vocabulary (tier enums + engine defaults) the model fields still work,
    // they just explain less.
    const file = suite.defaults || { content: "" };
    const [snaps, envs, catalog] = await Promise.all([
      api.get(`/suites/${suite.id}/snapshots?limit=1`).catch(() => ({ items: [] })),
      api.cached(`/projects/${projectKey}/environments`).then((r: WebDynamic) => r.items).catch(() => []),
      api.cached(`/models`, { ttl: Infinity }).catch(() => ({ tiers: [], defaults: {} })),
    ]);
    st = {
      projectKey, slug, suite, project, envs, catalog,
      raw: file.content, savedRaw: file.content,
      baseSeq: snaps.items[0]?.seq ?? null,
      view: "form",
    };
  } catch (err: WebDynamic) {
    return mount(main, page({ title: "Suite settings", body: errorState(err, () => suiteSettingsPage(projectKey, slug)) }));
  }

  render(main, st);
}

function render(main: WebDynamic, st: WebDynamic) {
  const { projectKey, slug, suite } = st;
  const editorSlot = h("div.editor-slot");
  const checksSlot = h("div", {}, h("div.dim", {}, "…"));
  // The one pending decision lives in a sticky bar at the bottom of the
  // viewport, present only while the draft differs from the saved bytes — a
  // clean page shows no Save/Discard at all.
  const bar = saveBar({ onSave: save, onDiscard: discard });
  let checksOk = true;
  const paintBar = () => bar.set({ dirty: st.raw !== st.savedRaw, invalid: !checksOk });

  const toggle = h("div.seg", {},
    h("button", { class: st.view === "form" ? "on" : "", onclick: () => switchView("form") }, "Form"),
    h("button", { class: st.view === "yaml" ? "on" : "", onclick: () => switchView("yaml") }, "YAML"),
  );

  const side = h("div.side", {},
    h("div.card.pad", {}, h("div.label", { style: "margin-bottom:8px" }, "Checks"), checksSlot),
    // No "What changed?" box. Asking someone to narrate an edit they are
    // looking at is a code-review habit, not a web-app one: the version already
    // records who, when, and the bytes. The note is derived on save.
    h("div.card.pad", {},
      h("div.label", { style: "margin-bottom:6px" }, "File"),
      h("div.dim", { style: "font-size:12px" }, h("span.mono", {}, DEFAULTS_PATH)),
      h("div.faint", { style: "font-size:11.5px;margin-top:6px" },
        "Personas, hooks and assertions are code-tier files: bring them in with Import, take them out with Export, and edit them with the CLI."),
    ),
  );

  mount(main, page({
    crumbs: [
      link(`/p/${projectKey}`, "Suites"), " / ",
      link(`/p/${projectKey}/suites/${slug}`, suite.name || slug), " / ",
      "Settings",
    ],
    title: "Suite settings",
    sub: "the defaults every story in this suite inherits",
    actions: [
      toggle,
      link(`/p/${projectKey}/suites/${slug}/history`, h("span.btn", {}, "Versions")),
      h("button.btn", { onclick: () => exportSuite(suite), title: "Download this suite as a .tar the CLI can run" }, "Export"),
      h("button.btn", { onclick: () => importSuite(projectKey, suite, () => suiteSettingsPage(projectKey, slug)), title: "Replace the suite's files from an exported .tar" }, "Import"),
    ],
    body: h("div", {}, h("div.editor", {}, editorSlot, side), bar.el),
  }));

  let debounce: WebDynamic;
  const scheduleChecks = () => { paintBar(); clearTimeout(debounce); debounce = setTimeout(runChecks, 350); };

  function switchView(view: WebDynamic) {
    if (view === st.view) return;
    st.view = view;
    render(main, st);
  }

  function paintEditor() {
    clear(editorSlot);
    if (st.view === "yaml") {
      editorSlot.append(h("textarea.code", {
        spellcheck: "false", value: st.raw,
        "aria-label": "playtest.yaml",
        oninput: (e: WebDynamic) => { st.raw = e.target.value; scheduleChecks(); },
      }));
      return;
    }
    let defaults;
    try { defaults = parseYaml(st.raw); }
    catch (e: WebDynamic) {
      editorSlot.append(h("div.card.pad", {},
        h("div.status.fail", {}, h("span.glyph", {}, "✗"), "This file isn't valid YAML"),
        h("p.dim", { style: "margin-top:6px" }, String(e.message || e)),
        h("button.btn", { style: "margin-top:10px", onclick: () => switchView("yaml") }, "Edit in YAML"),
      ));
      return;
    }
    editorSlot.append(buildForm(defaults));
  }

  /** Write one app.* key into the source document and repaint. */
  function setKey(key: WebDynamic, value: WebDynamic) {
    try { st.raw = setAppKey(st.raw, key, value); }
    catch (err: WebDynamic) { return toastError(err); }
    scheduleChecks();
  }

  function setLimit(key: WebDynamic, value: WebDynamic) {
    try { st.raw = setLimitKey(st.raw, key, value); }
    catch (err: WebDynamic) { return toastError(err); }
    scheduleChecks();
  }

  function setViewport(key: WebDynamic, value: WebDynamic) {
    try { st.raw = setViewportDimension(st.raw, key, value); }
    catch (err: WebDynamic) { return toastError(err); }
    scheduleChecks();
  }

  function setParallel(value: WebDynamic) {
    try { st.raw = setParallelValue(st.raw, value); }
    catch (err: WebDynamic) { return toastError(err); }
    scheduleChecks();
  }

  // No repaint on a model change (unlike the driver select): the dropdown
  // already shows the new state, and a rebuild would cost the person their
  // focus for nothing.
  function setModel(key: WebDynamic, value: WebDynamic) {
    try { st.raw = setModelKey(st.raw, key, value); }
    catch (err: WebDynamic) { return toastError(err); }
    scheduleChecks();
  }

  function buildForm(defaults: WebDynamic) {
    const app = defaults.app || {};
    const driver = app.driver || "web";
    const driverSel = enhanceSelect(h("select", {
      "aria-label": "Driver",
      onchange: (e: WebDynamic) => {
        // Transport decides which of the other keys are even legal, so a driver
        // change repaints the form rather than leaving dead fields behind.
        setKey("driver", e.target.value === "web" ? null : e.target.value);
        paintEditor();
      },
    }, ...DRIVERS.map((d: WebDynamic) => h("option", { value: d, selected: driver === d }, driverLabel(d)))));

    const binInput = h("input", {
      type: "text", value: app.app || "",
      placeholder: "/Users/you/builds/app.apk",
      onchange: (e: WebDynamic) => setKey("app", e.target.value.trim() || null),
    });

    const appCard = h("div.card.pad", {},
      h("div.label", { style: "margin-bottom:10px" }, "App under test"),
      formField("Driver", driverSel, driver === "web"
        ? "A browser app, driven by Chromium."
        : driver === "api" ? "An HTTP API, driven by fetch." : "A native app, driven by Appium."),
      driver === "mobile"
        // Optional: a real .apk exceeds what a suite may hold, so the usual
        // answer is a path on the machine that runs it, set on the environment.
        ? formField("App binary", binInput,
            "Optional. The .app/.ipa/.apk to install — an absolute path on the runner that executes this suite, or a path relative to this file for a small fixture app. Leave blank to provide it from the environment.")
        : null,
    );

    const browserDisplayCard = (() => {
      if (driver !== "web") return null;
      const dimension = (key: WebDynamic, label: WebDynamic, fallback: WebDynamic) => {
        const configured = app.viewport?.[key];
        const input = h("input", {
          type: "number", min: "1", step: "1",
          value: typeof configured === "number" ? configured : "",
          placeholder: String(fallback),
          onchange: (e: WebDynamic) => {
            const raw = e.target.value.trim();
            setViewport(key, raw ? Number(raw) : null);
          },
        });
        const hint = configured === null && key === "height"
          ? "Full-page screenshots are configured. Enter a height to capture only the visible viewport."
          : `CSS pixels. Using the engine default: ${fallback}.`;
        return formField(label, input, hint);
      };
      const configuredScale = app.device_scale_factor;
      const scale = h("input", {
        type: "number", min: "1", step: "0.25",
        value: typeof configuredScale === "number" ? configuredScale : "",
        placeholder: "1",
        onchange: (e: WebDynamic) => {
          const raw = e.target.value.trim();
          setKey("device_scale_factor", raw ? Number(raw) : null);
        },
      });
      return h("div.card.pad", { style: "margin-top:14px" },
        h("div.label", { style: "margin-bottom:6px" }, "Browser display"),
        h("p.dim", { style: "margin-bottom:12px" },
          "Set the responsive layout size and the pixel density of saved screenshots for every story in this suite."),
        h("div.browser-display-fields", {},
          dimension("width", "Viewport width", 1280),
          dimension("height", "Viewport height", 720),
          formField("Resolution factor", scale,
            typeof configuredScale !== "number"
              ? "Using the engine default: 1×. Use 2× for retina-resolution screenshots."
              : `${configuredScale}× screenshot pixels per CSS pixel.`),
        ),
      );
    })();

    const configuredMaxSteps = defaults.limits?.max_steps ?? defaults.max_steps ?? "";
    const configuredTimeout = defaults.limits?.timeout ?? defaults.timeout ?? "";
    const maxSteps = h("input", {
      type: "number", min: "1", step: "1",
      value: configuredMaxSteps,
      placeholder: "50",
      onchange: (e: WebDynamic) => {
        const raw = e.target.value.trim();
        setLimit("max_steps", raw ? Number(raw) : null);
      },
    });
    const timeout = h("input", {
      type: "text",
      value: configuredTimeout,
      placeholder: "4m",
      onchange: (e: WebDynamic) => setLimit("timeout", e.target.value.trim() || null),
    });
    const limitsCard = h("div.card.pad", { style: "margin-top:14px" },
      h("div.label", { style: "margin-bottom:6px" }, "Run limits"),
      h("p.dim", { style: "margin-bottom:12px" },
        "The wall-clock and action budgets each story inherits. You can override both for one launch without changing these defaults."),
      h("div.run-limits-fields", {},
        formField("Maximum steps", maxSteps,
          configuredMaxSteps === ""
            ? "Using the engine default: 50 for journeys, 300 for discovery."
            : "The actor stops after this many actions even when time remains."),
        formField("Timeout per story", timeout,
          configuredTimeout === ""
            ? "Using the engine default: 4m for journeys, 30m for discovery. Accepts values such as 6m, 90s, or milliseconds."
            : "Wall-clock budget including model calls and browser actions. Accepts values such as 6m or 90s."),
      ),
    );

    const concurrencyCard = (() => {
      const configured = defaults.parallel ?? null;
      const projectBudget = st.project?.parallel || { total: 1, record: 1 };
      const automatic = configured === true ||
        (configured && typeof configured === "object" &&
          (configured.total === true || configured.total == null));
      const normalized = typeof configured === "number"
        ? { total: configured, record: configured }
        : configured && typeof configured === "object" && !automatic
          ? { total: configured.total, record: configured.record ?? configured.total }
          : projectBudget;
      const policy = enhanceSelect(h("select", {
        "aria-label": "Concurrency policy",
        onchange: (e: WebDynamic) => {
          if (e.target.value === "project") setParallel(null);
          else if (e.target.value === "automatic") setParallel(true);
          else setParallel({ total: projectBudget.total, record: projectBudget.record });
          paintEditor();
        },
      },
        h("option", { value: "project", selected: configured === null }, "Use project default"),
        h("option", { value: "custom", selected: configured !== null && !automatic }, "Custom for this suite"),
        h("option", { value: "automatic", selected: automatic }, "Automatic pool sizing"),
      ));
      const disabled = configured === null || automatic;
      const total = h("input", {
        type: "number", min: "1", step: "1", disabled,
        value: disabled ? "" : normalized.total,
        placeholder: String(projectBudget.total),
        onchange: (e: WebDynamic) => {
          const nextTotal = Number(e.target.value);
          setParallel({ total: nextTotal, record: Math.min(normalized.record, nextTotal) });
          paintEditor();
        },
      });
      const record = h("input", {
        type: "number", min: "1", step: "1", disabled,
        value: disabled ? "" : normalized.record,
        placeholder: String(projectBudget.record),
        onchange: (e: WebDynamic) => setParallel({ total: normalized.total, record: Number(e.target.value) }),
      });
      const sourceHint = configured === null
        ? `Using the project default: ${projectBudget.total} concurrent, up to ${projectBudget.record} recording.`
        : automatic
          ? "Core sizes the pool from the runner's CPUs. Use YAML for an automatic pool with a separate recording cap."
          : "This suite replaces the project concurrency policy.";
      return h("div.card.pad", { style: "margin-top:14px" },
        h("div.label", { style: "margin-bottom:6px" }, "Concurrency"),
        h("p.dim", { style: "margin-bottom:12px" },
          "Run independent stories together. Keep the recording cap lower when model rate limits or target state cannot support the full pool."),
        formField("Policy", policy, sourceHint),
        h("div.run-limits-fields", {},
          formField("Concurrent stories", total, "Maximum stories in flight across recording and baseline checks."),
          formField("Concurrent recordings", record, "Maximum model-driven stories in flight; baseline checks use the remaining capacity."),
        ),
      );
    })();

    // Which model plays the user and which grades — the suite's say in the
    // per-key precedence chain: a story's own value beats these, these beat
    // the project default (Settings → Models), and the engine default catches
    // whatever nobody chose. The caption under each field states which source
    // is winning RIGHT NOW, so leaving a field blank is an informed choice
    // rather than a mystery (the resolveEnvTarget discipline, for models).
    const modelsCard = (() => {
      const tiers = st.catalog?.tiers || [];
      const projectModels = st.project?.models || {};
      const engine = st.catalog?.defaults || {};
      const field = (key: WebDynamic, label: WebDynamic, role: WebDynamic) => {
        const configured = typeof defaults[key] === "string" && defaults[key].trim() ? defaults[key].trim() : "";
        // Inheriting is the dropdown's FIRST option and it names what it
        // resolves to, so "I didn't choose" reads as the concrete model it
        // means rather than as an empty control.
        const inherit = projectModels[key]
          ? `Project default — ${projectModels[key]}`
          : engine[key]
            ? `Engine default — ${engine[key]}`
            : "Engine default";
        return modelField({
          label,
          hint: `${role} Stories can still pin their own.`,
          value: configured,
          tiers,
          inheritLabel: inherit,
          onchange: (v: WebDynamic) => setModel(key, v),
        });
      };
      return h("div.card.pad", { style: "margin-top:14px" },
        h("div.label", { style: "margin-bottom:6px" }, "Models"),
        h("p.dim", { style: "margin-bottom:12px" },
          "Which models this suite's stories use. A capable actor recovers from friction far more reliably than a cheap one."),
        field("actor_model", "Actor model", "Plays the user against the app."),
        field("grader_model", "Grader model", "Grades finished runs and checks assertions."),
      );
    })();

    // Everything else playtest.yaml can carry — sign-in states and settle
    // windows — has no form yet. Say so and point at the view that does
    // edit it, rather than silently dropping it.
    const restCard = h("div.card.pad", { style: "margin-top:14px" },
      h("div.label", { style: "margin-bottom:6px" }, "Everything else"),
      h("p.dim", { style: "margin-bottom:10px" },
        "Sign-in states, settle windows and report settings live in the same file. The form covers common settings; the YAML view edits all of it."),
      h("button.btn", { onclick: () => switchView("yaml") }, "Edit YAML"),
    );

    return h("div", {}, appCard, browserDisplayCard, limitsCard, concurrencyCard, modelsCard, driver === "mobile" ? null : targetsCard(app), restCard);
  }

  /**
   * Test targets: every place this suite can run, and the URL it uses there.
   *
   * A target is a deployment ring — credentials, runner pool, discovery
   * permission. Some belong to the project and are shared by every suite; some
   * belong to this suite alone (a service only these stories talk to, or a
   * project with no rings configured yet). Either way the URL is the SUITE's and
   * is written into this file, which is why every field here saves with the
   * page: the ring's own URL is only a fallback for suites that declare none.
   *
   * A blank row is not a mystery — each one states the URL it resolves to and
   * which of the three sources won, mirroring the dispatcher's precedence
   * exactly (lib/defaults-form.js resolveEnvTarget).
   */
  function targetsCard(app: WebDynamic) {
    const suiteDriver = app.driver || "web";
    const compatible = st.envs.filter((e: WebDynamic) => environmentDriver(e) === suiteDriver);
    const mine = compatible.filter((e: WebDynamic) => e.suite_id === st.suite.id);
    const shared = compatible.filter((e: WebDynamic) => !e.suite_id && e.name !== DEFAULT_ENV_NAME);
    const defaultTarget = compatible.find((e: WebDynamic) => !e.suite_id && e.name === DEFAULT_ENV_NAME) || null;
    const canManage = hasRole(st.project.id, "developer");
    // Cookies are a web-driver key (set on the browser context before the first
    // navigation) — an api suite's rows stay URL-only.
    const web = (app.driver || "web") === "web";

    // The suite's own base URL, first, because core resolves every case against
    // it and refuses the suite without one. When the project keeps its `default`
    // target this row is also a launchable target under that name; when a
    // project has grown real rings and dropped it, the same URL still serves as
    // the fallback for every target that sets none.
    const defaultRow = row({
      name: defaultTarget ? h("span.id", {}, defaultTarget.name) : h("span.dim", {}, "Suite default"),
      sub: "this suite's own URL",
      chips: defaultTarget?.discovery_allowed ? ["discovery"] : [],
      value: app.base_url || "",
      label: "Default base URL",
      placeholder: "https://staging.example.com",
      onset: (v: WebDynamic) => setKey("base_url", v),
      cookies: web ? {
        value: formatCookieList(app.cookies),
        label: "Default cookies",
        placeholder: "cookies: name=value; name2=value2",
        onset: (v: WebDynamic) => setCookies(null, v),
      } : null,
      why: h("span", {},
        defaultTarget
          ? whyLine(app, defaultTarget)
          : app.base_url
            ? h("span", {}, "Used by any target below that sets no URL of its own.")
            : h("span.warn", {}, "No URL yet — no story in this suite can resolve until this or a target below has one."),
        web ? cookieWhy(app, defaultTarget?.name ?? DEFAULT_ENV_NAME, defaultTarget?.config?.app?.cookies) : null,
      ),
    });

    const sharedRows = shared.map((e: WebDynamic) => row({
      name: h("span.id", {}, e.name),
      chips: e.discovery_allowed ? ["discovery"] : [],
      value: app?.envs?.[e.name]?.base_url || "",
      label: `Base URL for ${e.name}`,
      placeholder: e.config?.app?.base_url || app.base_url || "no URL — runs here will fail",
      onset: (v: WebDynamic) => setEnvUrl(e.name, v),
      cookies: web ? envCookiesField(e) : null,
      why: h("span", {}, whyLine(app, e), web ? cookieWhy(app, e.name, e.config?.app?.cookies) : null),
    }));

    const myRows = mine.map((e: WebDynamic) => row({
      name: h("span.id", {}, e.name),
      chips: e.discovery_allowed ? ["discovery"] : [],
      value: app?.envs?.[e.name]?.base_url || "",
      label: `Base URL for ${e.name}`,
      placeholder: e.config?.app?.base_url || app.base_url || "no URL — runs here will fail",
      onset: (v: WebDynamic) => setEnvUrl(e.name, v),
      cookies: web ? envCookiesField(e) : null,
      why: h("span", {}, whyLine(app, e), web ? cookieWhy(app, e.name, e.config?.app?.cookies) : null),
      action: canManage
        ? h("button.btn.btn-sm.danger", {
            type: "button",
            "aria-label": `Remove environment ${e.name}`,
            onclick: () => removeEnvironment(e),
          }, "Remove")
        : null,
    }));

    return h("div.card.pad", { style: "margin-top:14px" },
      h("div.label", { style: "margin-bottom:6px" }, "Environments"),
      h("p.dim", { style: "margin-bottom:14px" },
        "Where this suite runs. An environment carries the credentials, runner pool and discovery permission for a deployment ring; the URL — and any browser cookies sent with every request — is this suite's own inside that ring. Leave a row blank to accept what it already resolves to."),
      defaultRow,
      shared.length
        ? h("div.env-section", {},
            group("Shared with every suite in this project",
              canManage ? link(`/p/${projectKey}/settings/test-targets`, h("span.btn.btn-sm", {}, "Manage")) : null),
            ...sharedRows)
        : null,
      h("div.env-section", {},
        group("This suite only", canManage
          ? h("button.btn.btn-sm", { type: "button", onclick: () => addEnvironment(suiteDriver) }, "+ Add environment")
          : h("span.faint", { style: "font-size:12px" }, "needs the developer role")),
        ...(myRows.length
          ? myRows
          : [h("p.faint", { style: "font-size:12.5px;margin:2px 0 0" },
              shared.length
                ? "Nothing yet. Add one for a host only these stories use — a local service, a preview deploy — without putting it in front of every other suite."
                : "Nothing yet. Add one for each place these stories should run — a local service, staging, a preview deploy.")]),
      ),
    );

    /** One environment: its name, this suite's URL for it, what that resolves to. */
    function row({ name, sub = null, chips = [], value, label, placeholder, onset, why, cookies = null, action = null }: WebDynamic) {
      const input = h("input", {
        type: "text", value, placeholder,
        "aria-label": label,
        onchange: (ev: WebDynamic) => onset(ev.target.value.trim() || null),
      });
      // A second, quieter field for the ring's cookies — blank accepts what the
      // placeholder says it inherits, exactly like the URL above it.
      const cookieInput = cookies
        ? h("input.env-row-cookies", {
            type: "text", value: cookies.value, placeholder: cookies.placeholder,
            "aria-label": cookies.label,
            onchange: (ev: WebDynamic) => cookies.onset(ev.target.value),
          })
        : null;
      return h("div.env-row", {},
        h("div.env-row-name", {},
          name,
          ...chips.map((c: WebDynamic) => h("span.chip", {}, c)),
          sub ? h("div.env-row-sub.faint", {}, sub) : null),
        action ? h("div.env-row-edit", {}, input, action) : input,
        cookieInput,
        h("div.env-row-why.dim", {}, why),
      );
    }

    /** The cookies column for one project/suite environment's row. */
    function envCookiesField(e: WebDynamic) {
      return {
        value: formatCookieList(app?.envs?.[e.name]?.cookies),
        label: `Cookies for ${e.name}`,
        placeholder: formatCookieList(e.config?.app?.cookies) || formatCookieList(app.cookies) || "cookies: name=value; name2=value2",
        onset: (v: WebDynamic) => setCookies(e.name, v),
      };
    }

    /** What cookies a launch actually carries, appended to the URL's why line. */
    function cookieWhy(app: WebDynamic, envName: WebDynamic, envCookies: WebDynamic) {
      const { cookies, source } = resolveEnvCookies(app, envName, envCookies);
      if (!cookies) return null;
      const list = h("span.mono", {}, formatCookieList(cookies));
      if (source === "suite-env") return h("span", {}, " Sends cookies ", list, " — this suite's own for ", envName, ".");
      if (source === "environment") return h("span", {}, " Sends cookies ", list, " — set on the ", envName, " environment itself.");
      return h("span", {}, " Sends cookies ", list, " — this suite's default.");
    }

    /**
     * Write cookies into the file: the default row edits `app.cookies`, an
     * environment row edits `app.envs.<name>.cookies` (which core applies
     * WHOLESALE over the default — an override, not an addition).
     */
    function setCookies(envName: WebDynamic, text: WebDynamic) {
      let parsed;
      try { parsed = parseCookieList(text); }
      catch (err: WebDynamic) { return toastError(err); }
      try { st.raw = envName ? setEnvCookies(st.raw, envName, parsed) : setAppKey(st.raw, "cookies", parsed); }
      catch (err: WebDynamic) { return toastError(err); }
      paintEditor();
      scheduleChecks();
    }

    /** The dispatcher's precedence, said out loud for one environment. */
    function whyLine(app: WebDynamic, e: WebDynamic) {
      const envUrl = e.config?.app?.base_url || null;
      const { url, source } = resolveEnvTarget(app, e.name, envUrl);
      if (!url) return h("span.warn", {}, "No URL anywhere — a run against this environment can't start.");
      const at = h("span.mono", {}, url);
      if (source === "suite-env") {
        // Only an override that CHANGES the destination is worth the words: the
        // same URL on both sides is a coincidence, not a decision to explain.
        const overrides = envUrl && envUrl !== url;
        return h("span", {}, "Runs against ", at, " — this suite's own URL for ", e.name,
          overrides ? h("span", {}, ", overriding its own ", h("span.mono", {}, envUrl)) : null);
      }
      if (source === "environment") {
        return h("span", {}, "Runs against ", at, " — the URL set on the ", e.name, " environment itself");
      }
      return h("span", {}, "Runs against ", at, " — this suite's default URL");
    }

    function setEnvUrl(name: WebDynamic, value: WebDynamic) {
      try { st.raw = setEnvBaseUrl(st.raw, name, value); }
      catch (err: WebDynamic) { return toastError(err); }
      paintEditor();
      scheduleChecks();
    }
  }

  const group = (title: WebDynamic, action: WebDynamic) => h("div.env-group", {}, h("span", {}, title), action);

  /**
   * Add a target only this suite can launch against. The target itself is a
   * project-level object and is created immediately; its URL belongs to this
   * file and lands with Save, like every other URL on this page. The toast says
   * so, because a half-applied change nobody mentions is how people lose work.
   */
  function addEnvironment(suiteDriver: WebDynamic) {
    const close = formModal("Add an environment", () => {
      const name = h("input", { type: "text", placeholder: "checkout-local" });
      const url = h("input", { type: "text", placeholder: "http://127.0.0.1:4173" });
      const disc = h("input", { type: "checkbox" });
      const problem = h("div.preview-warn", { style: "display:none;margin:-6px 0 10px" });
      return h("form", { onsubmit: submit },
        h("p.dim", { style: "margin:-4px 0 14px" },
          "Only this suite can launch against it, and it carries no credentials. For a deployment ring with sign-in identities and a runner pool, add it under Settings → Test targets instead."),
        formField("Name", name, "How it reads at launch, and the --env name the CLI uses. Letters, digits, dots and dashes."),
        formField("Base URL", url, "Where this suite's app lives inside it."),
        h("label.check", { style: "margin:6px 0 12px" }, disc, "Allow discovery studies against it"),
        h("div.faint", { style: "font-size:11.5px;margin:-6px 0 12px 24px" },
          "Discovery agents really click buy, delete and submit. Leave this off for anything with real data behind it."),
        problem,
        h("div.modal-actions", {},
          h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"),
          h("button.btn.primary", { type: "submit" }, "Add environment"),
        ),
      );
      async function submit(ev: WebDynamic) {
        ev.preventDefault();
        const nm = name.value.trim();
        if (!ENV_NAME_RE.test(nm)) {
          return fail("A name is letters, digits, dots and dashes — no spaces, and it can't start with a dash.");
        }
        const bad = baseUrlProblem(url.value);
        if (bad) return fail(bad);
        try {
          const created = await api.post(`/projects/${projectKey}/environments`, {
            name: nm,
            driver: suiteDriver,
            suite_id: st.suite.id,
            discovery_allowed: disc.checked,
          });
          st.envs = [...st.envs, created];
        } catch (err: WebDynamic) { return fail(String(err.message || err)); }
        try { st.raw = setEnvBaseUrl(st.raw, nm, url.value.trim()); }
        catch (err: WebDynamic) { return toastError(err); }
        close();
        paintEditor();
        scheduleChecks();
        toast("Environment added", `save this page to keep ${nm}'s URL`, "ok");
      }
      function fail(message: WebDynamic) {
        problem.style.display = "";
        problem.textContent = message;
      }
    });
  }

  /** Remove a suite's own target, and the URL this file kept for it. */
  async function removeEnvironment(env: WebDynamic) {
    const ok = await confirmModal({
      title: `Remove ${env.name}?`,
      body: "This suite stops being able to launch against it. Its URL leaves these settings when you save. Runs that already used it keep their history.",
      confirmLabel: "Remove environment",
      cancelLabel: "Keep it",
      danger: true,
    });
    if (!ok) return;
    try { await api.del(`/environments/${env.id}`); }
    catch (err: WebDynamic) { return toastError(err); }
    st.envs = st.envs.filter((e: WebDynamic) => e.id !== env.id);
    try { st.raw = setEnvBaseUrl(st.raw, env.name, null); } catch { /* the key stays; harmless */ }
    paintEditor();
    scheduleChecks();
    toast("Environment removed", env.name, "ok");
  }

  async function runChecks() {
    const changes: WebDynamic = [{ path: DEFAULTS_PATH, content: st.raw }];
    let res;
    try { res = await api.post(`/suites/${st.suite.id}/validate`, { changes }); }
    catch { return mount(checksSlot, h("div.dim", {}, "couldn't run checks")); }
    checksOk = res.ok;
    paintBar();
    if (res.ok) {
      const n = res.cases?.length ?? 0;
      return mount(checksSlot, h("ul.check-list", {},
        h("li.check-item.ok", {}, h("span.g", {}, "✓"), h("span.msg", {},
          n ? `valid — ${n} ${n === 1 ? "story" : "stories"} resolve` : "valid")),
      ));
    }
    mount(checksSlot, h("ul.check-list", {}, ...(res.errors || []).map((e: WebDynamic) =>
      h("li.check-item.err", {}, h("span.g", {}, "✗"), h("span.msg", {}, e.path ? `${e.path}: ${e.message}` : e.message)))));
  }

  /** Put the draft back to the last saved bytes, in place — no navigation. */
  async function discard() {
    const ok = await confirmModal({
      title: "Discard your changes?",
      body: "These settings go back to their last saved version. Nothing else is affected.",
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      danger: true,
    });
    if (!ok) return;
    st.raw = st.savedRaw;
    paintEditor();
    scheduleChecks();
  }

  async function save() {
    bar.set({ dirty: true, saving: true });
    try {
      const res = await api.put(`/suites/${st.suite.id}/files/${DEFAULTS_PATH}`, {
        content: st.raw,
        note: derivedNote(st.savedRaw, st.raw),
        base_seq: st.baseSeq,
      });
      st.baseSeq = res.snapshot.seq;
      st.savedRaw = st.raw;
      toast("Settings saved", `version #${res.snapshot.seq}`, "ok");
      navigate(`/p/${projectKey}/suites/${slug}`);
    } catch (err: WebDynamic) {
      paintBar();
      if (err.status === 409) {
        const reload = await confirmModal({
          title: "Someone else changed this suite",
          body: "Someone else saved a new version since you opened this page. Load theirs? Your unsaved changes will be lost.",
          confirmLabel: "Reload latest",
          danger: true,
        });
        if (reload) return suiteSettingsPage(projectKey, slug);
        return;
      }
      toastError(err);
    }
  }

  paintEditor();
  paintBar();
  runChecks();
}

/**
 * The version note, derived instead of asked for. Naming the settings that
 * actually moved ("changed app.base_url") is both more accurate and more
 * useful than whatever an author would have typed into a box — and it is the
 * one thing the Versions list can't work out for itself, since it shows a
 * suite's history without the file bytes.
 */
function derivedNote(before: WebDynamic, after: WebDynamic) {
  let a, b;
  try { a = flatten(parseYaml(before)); b = flatten(parseYaml(after)); }
  catch { return "edited suite settings"; }
  const keys: WebDynamic = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
  if (!keys.length) return "edited suite settings";
  const head = keys.slice(0, 3).join(", ");
  return `changed ${head}${keys.length > 3 ? ` and ${keys.length - 3} more` : ""}`;
}

/** { app: { envs: { staging: { base_url } } } } -> { "app.envs.staging.base_url": "…" } */
function flatten(obj: WebDynamic, prefix: WebDynamic = "", out: WebDynamic = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    // Arrays compare whole: "changed app.viewport" beats three index entries.
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = JSON.stringify(v);
  }
  return out;
}
