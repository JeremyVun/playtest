// Suite settings — the suite's shared defaults (playtest.yaml), the file every
// story in the suite inherits from. This replaced the raw "Edit files" tree: the
// web app authors STORIES and the settings that shape them; personas, hooks and
// assertions are code-tier files that belong to the CLI (import a .tar to bring
// them in, export one to take them out).
//
// Where a suite runs is NOT here: a suite belongs to one application and
// launches against one of that application's rings, and the ring owns the URL.
// This page shows those rings read-only and edits only what a suite may
// legitimately say per ring — the logical overlay.
//
// Form and YAML are two views of the identical bytes (the story editor's
// discipline): the form edits the parsed document IN PLACE, so comments, key
// order and unknown keys survive untouched.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { link, navigate } from "../lib/router.js";
import { page } from "../lib/shell.js";
import { hasRole } from "../lib/state.js";
import { toast, toastError, confirmModal, emptyState, errorState, formField, enhanceSelect } from "../lib/ui.js";
import { parseYaml } from "../lib/caseform.js";
import {
  setAppKey, setViewportDimension, setLimitKey, setParallelValue, setModelKey,
  setEnvCookies, parseCookieList, formatCookieList, resolveEnvCookies,
  DRIVERS, driverLabel,
} from "../lib/defaults-form.js";
import { modelField } from "../lib/model-select.js";
import { getSuiteBySlug, exportSuite, importSuite } from "./suite.js";
import { projectPage } from "../lib/project-page.js";
import { sourceEditor } from "../lib/source-editor.js";

const DEFAULTS_PATH = "playtest.yaml";

export async function suiteSettingsPage(projectKey: WebDynamic, slug: WebDynamic) {
  const context = projectPage(projectKey, { nav: "suites", title: "Suite settings" });
  if (!context) return;
  const { main, project } = context;

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
    // the rings must not error the form for a role that can't read them (the
    // ring table is then just absent), and without the model vocabulary (tier
    // enums + engine defaults) the model fields still work, they just explain
    // less.
    const file = suite.defaults || { content: "" };
    const [snaps, rings, catalog] = await Promise.all([
      api.get(`/suites/${suite.id}/snapshots?limit=1`).catch(() => ({ items: [] })),
      suite.application_id
        ? api.cached(`/applications/${suite.application_id}/rings`).then((r: WebDynamic) => r.items).catch(() => [])
        : Promise.resolve([]),
      api.cached(`/models`, { ttl: Infinity }).catch(() => ({ tiers: [], defaults: {} })),
    ]);
    st = {
      projectKey, slug, suite, project, rings, catalog,
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
  const checksSlot = h("div", {}, h("div.dim", {}, "…"));
  // The one pending decision lives in a sticky bar at the bottom of the
  // viewport, present only while the draft differs from the saved bytes — a
  // clean page shows no Save/Discard at all.
  const source = sourceEditor({
    state: st,
    parse: parseYaml,
    renderForm: (defaults: WebDynamic) => buildForm(defaults),
    rerender: () => render(main, st),
    save,
    check: runChecks,
    yamlLabel: DEFAULTS_PATH,
    discardBody: "These settings go back to their last saved version. Nothing else is affected.",
  });
  const { bar, editorSlot, toggle, paintEditor, scheduleChecks } = source;

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

    // The suite's driver has to agree with its application's: a suite has no
    // driver column, its case files do, and a launch refuses a case whose
    // driver is not the application's surface. So the mismatch is said here,
    // beside the control that causes it, rather than at launch.
    const bound = st.suite.application?.driver || null;
    const appCard = h("div.card.pad", {},
      h("div.label", { style: "margin-bottom:10px" }, "App under test"),
      formField("Driver", driverSel, driver === "web"
        ? "A browser app, driven by Chromium."
        : driver === "api" ? "An HTTP API, driven by fetch." : "A native app, driven by Appium."),
      bound && bound !== driver
        ? h("div.preview-warn", { style: "margin-top:-6px" },
            `This suite is bound to ${st.suite.application.key}, a ${bound} surface — a launch refuses stories that drive anything else. `
            + `Set the driver to ${bound}, or move these stories to a suite bound to a matching application.`)
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
      h("button.btn", { onclick: () => source.switchView("yaml") }, "Edit YAML"),
    );

    return h("div", {}, appCard, browserDisplayCard, limitsCard, concurrencyCard, modelsCard, ringsCard(app, driver), restCard);
  }

  /**
   * The rings this suite can run against — its application's, and only those.
   *
   * The ring says where a run points; the suite never does. A ring owns the
   * URL, the credentials, the routing labels and the discovery permission for
   * one deployment, and hosted execution applies that URL as the runtime target
   * after the complete authored merge, replacing anything the suite wrote. So
   * the URL column here is READ-ONLY: there is no per-ring URL to set and no
   * precedence left to explain.
   *
   * What a suite may still say per ring is LOGICAL, and cookies are the one
   * people set: `app.envs.<ring key>.cookies`, which core applies WHOLESALE
   * over the suite default rather than merging into it.
   */
  function ringsCard(app: WebDynamic, driver: WebDynamic) {
    const web = driver === "web";
    const application = st.suite.application || null;
    const rows = st.rings.map((ring: WebDynamic) => {
      const key = ring.key;
      const cookieInput = web
        ? h("input.env-row-cookies", {
            type: "text",
            value: formatCookieList(app?.envs?.[key]?.cookies),
            placeholder: formatCookieList(ring.config?.app?.cookies) || formatCookieList(app.cookies) || "cookies: name=value; name2=value2",
            "aria-label": `Cookies for ${key}`,
            onchange: (ev: WebDynamic) => setCookies(key, ev.target.value),
          })
        : null;
      return h("div.env-row", {},
        h("div.env-row-name", {},
          h("span.id", {}, key),
          ring.discovery_allowed ? h("span.chip", {}, "discovery") : null,
          h("div.env-row-sub.faint", {}, ring.name && ring.name !== key ? ring.name : " ")),
        h("div.dim", {},
          driver === "mobile"
            ? "the claiming runner supplies the build"
            : h("span.mono", {}, ring.base_url || "no URL — set one under Applications")),
        cookieInput,
        h("div.env-row-why.dim", {}, web ? cookieWhy(app, key, ring.config?.app?.cookies) : null),
      );
    });

    return h("div.card.pad", { style: "margin-top:14px" },
      h("div.label", { style: "margin-bottom:6px" }, "Rings"),
      h("p.dim", { style: "margin-bottom:14px" },
        application
          ? h("span", {}, "Where this suite runs, chosen at launch. ", h("span.mono", {}, application.key),
              " owns these rings and their URLs; what this file may say per ring is logical only — the cookies a web run carries there.")
          : "Where this suite runs, chosen at launch from its application's rings."),
      st.rings.length
        ? h("div.env-section", {},
            h("div.env-group", {},
              h("span", {}, application ? `Rings of ${application.name || application.key}` : "Rings"),
              hasRole(st.project.id, "developer")
                ? link(`/p/${projectKey}/applications`, h("span.btn.btn-sm", {}, "Manage"))
                : null),
            ...rows)
        : h("p.faint", { style: "font-size:12.5px;margin:2px 0 0" },
            hasRole(st.project.id, "developer")
              ? h("span", {}, "This application has no ring yet, so there is nowhere to launch. Add one under ",
                  link(`/p/${projectKey}/applications`, "Applications"), ".")
              : "This application has no ring yet, so there is nowhere to launch. A developer adds one under Applications."),
    );

    /** What cookies a launch actually carries, said under the field. */
    function cookieWhy(app: WebDynamic, ringKey: WebDynamic, ringCookies: WebDynamic) {
      const { cookies, source } = resolveEnvCookies(app, ringKey, ringCookies);
      if (!cookies) return null;
      const list = h("span.mono", {}, formatCookieList(cookies));
      if (source === "suite-ring") return h("span", {}, "Sends cookies ", list, " — this suite's own for ", ringKey, ".");
      if (source === "ring") return h("span", {}, "Sends cookies ", list, " — set on the ", ringKey, " ring itself.");
      return h("span", {}, "Sends cookies ", list, " — this suite's default.");
    }

    /**
     * Write cookies into the file: `app.envs.<ring key>.cookies`, which core
     * applies WHOLESALE over the top-level `app.cookies` — an override, not an
     * addition.
     */
    function setCookies(ringKey: WebDynamic, text: WebDynamic) {
      let parsed;
      try { parsed = parseCookieList(text); }
      catch (err: WebDynamic) { return toastError(err); }
      try { st.raw = setEnvCookies(st.raw, ringKey, parsed); }
      catch (err: WebDynamic) { return toastError(err); }
      paintEditor();
      scheduleChecks();
    }
  }

  async function runChecks() {
    const changes: WebDynamic = [{ path: DEFAULTS_PATH, content: st.raw }];
    let res;
    try { res = await api.post(`/suites/${st.suite.id}/validate`, { changes }); }
    catch {
      mount(checksSlot, h("div.dim", {}, "couldn't run checks"));
      return undefined;
    }
    if (res.ok) {
      const n = res.cases?.length ?? 0;
      mount(checksSlot, h("ul.check-list", {},
        h("li.check-item.ok", {}, h("span.g", {}, "✓"), h("span.msg", {},
          n ? `valid — ${n} ${n === 1 ? "story" : "stories"} resolve` : "valid")),
      ));
      return true;
    }
    mount(checksSlot, h("ul.check-list", {}, ...(res.errors || []).map((e: WebDynamic) =>
      h("li.check-item.err", {}, h("span.g", {}, "✗"), h("span.msg", {}, e.path ? `${e.path}: ${e.message}` : e.message)))));
    return false;
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
      source.paintBar();
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

  source.initialize();
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
