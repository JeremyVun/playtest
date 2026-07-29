// Settings → Models. The project's default actor and grader, and the two
// automatic findings passes that spend a model of their own.
//
// Precedence is per key, most specific wins: a story's own value > the suite's
// playtest.yaml > these > the engine defaults. A suite that chose always wins,
// so nothing set here can override it.
//
// The page is organised by JOB, not by control type. A flat column of settings
// reads as that many unrelated questions; the same settings read as three jobs
// — running a story, collapsing duplicates, closing fixed findings — with the
// model that does each job sitting next to the switch that decides whether the
// job runs at all. Each question puts its wording on the left and its answer in
// a column of its own, so "what has this project actually changed?" is one
// vertical scan rather than a page of paragraphs. The one question whose
// answers need a sentence each takes the whole row instead (see the rungs).
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { state } from "../lib/state.js";
import { choiceGroup, choiceList, saveBar, toast, toastError } from "../lib/ui.js";
import { modelField } from "../lib/model-select.js";

const MODEL_KEYS = ["actor_model", "grader_model", "consolidation_model", "auto_resolve_model"];

export async function modelsTab(projectKey: WebDynamic, project: WebDynamic, slot: WebDynamic) {
  let catalog: WebDynamic = { tiers: [], defaults: {} };
  try { catalog = await api.cached(`/models`, { ttl: Infinity }); } catch { /* the dropdowns degrade to text fields; saving still works */ }
  const cap = state.me?.capabilities || {};

  // What the fields currently say, committed together by Save. `null` is
  // inherit — a visible selected state everywhere, never an empty box.
  const pending: WebDynamic = {
    actor_model: project.models?.actor_model || null,
    grader_model: project.models?.grader_model || null,
    consolidation_model: project.models?.consolidation_model || null,
    auto_resolve_model: project.models?.auto_resolve_model || null,
    auto_dedupe: project.auto_dedupe ?? null,
    auto_resolve: project.auto_resolve ?? null,
    auto_resolve_mode: project.auto_resolve_mode ?? null,
  };
  const snapshot = () => ({
    actor_model: project.models?.actor_model || null,
    grader_model: project.models?.grader_model || null,
    consolidation_model: project.models?.consolidation_model || null,
    auto_resolve_model: project.models?.auto_resolve_model || null,
    auto_dedupe: project.auto_dedupe ?? null,
    auto_resolve: project.auto_resolve ?? null,
    auto_resolve_mode: project.auto_resolve_mode ?? null,
  });
  let saved: WebDynamic = snapshot();

  // A policy is stored as on, off, or null — "whatever this deployment does".
  // Null is not a third button: a control offering "Default" has to explain what
  // the default IS, which is a line of text that exists only because of the
  // control. So the deployment's answer is simply the one shown as selected,
  // and null survives underneath: a project that was following the deployment
  // goes on following it unless someone actually moves the switch.
  const deployment: WebDynamic = {
    auto_dedupe: Boolean(cap.auto_dedupe),
    auto_resolve: Boolean(cap.auto_resolve),
    auto_resolve_mode: cap.auto_resolve_mode === "full" ? "full" : "semi",
  };
  const shown = (key: WebDynamic) => pending[key] ?? deployment[key];
  /** Answering with what is already true is an undo, not a decision to pin. */
  const set = (key: WebDynamic, v: WebDynamic) => {
    pending[key] = v === (saved[key] ?? deployment[key]) ? saved[key] : v;
  };
  const answer = (key: WebDynamic) => (v: WebDynamic) => { set(key, v); paint(); };

  // The fixed-findings ladder, read in both directions. What is stored stays
  // what it always was — a tri-state switch and a tri-state mode — so a rung is
  // derived from whatever is currently shown, and choosing one answers both
  // keys through the same undo rule. "Never" leaves the mode untouched: turning
  // the sweep back on should find the answer that was already there rather than
  // a pin nobody chose.
  const rung = () => (!shown("auto_resolve") ? "never"
    : shown("auto_resolve_mode") === "full" ? "verified" : "proven");
  const pickRung = (v: WebDynamic) => {
    set("auto_resolve", v !== "never");
    if (v !== "never") set("auto_resolve_mode", v === "verified" ? "full" : "semi");
    paint();
  };

  // Discard throws the whole draft away, so it repaints from saved state rather
  // than pushing values back through every control — the one place where
  // losing focus is exactly what was asked for.
  const bar = saveBar({ onSave: save, onDiscard: () => modelsTab(projectKey, project, slot) });

  const modelRow = (key: WebDynamic, label: WebDynamic, hint: WebDynamic) => modelField({
    label,
    hint,
    value: pending[key] || "",
    tiers: catalog.tiers || [],
    inheritLabel: catalog.defaults?.[key] ? `Engine default — ${catalog.defaults[key]}` : "Engine default",
    onchange: (v: WebDynamic) => { pending[key] = v; paint(); },
  });

  // ---- running a story ----
  const actorRow = modelRow("actor_model", "Actor model",
    "Drives the app as the user. A cheap actor gets stuck where a capable one recovers.");
  const graderRow = modelRow("grader_model", "Grader model",
    "Grades finished runs and checks each story's assertions.");

  // ---- duplicate findings ----
  const dedupeRow = policyField("Automatic dedupe",
    choiceGroup({ label: "Automatic dedupe", options: ONOFF, value: shown("auto_dedupe"), onchange: answer("auto_dedupe") }),
    "Merges duplicate findings after each run reports.");
  const dedupeModelRow = modelRow("consolidation_model", "Dedupe model",
    "Judges whether two differently worded findings describe the same bug.");

  // ---- fixed findings ----
  // One question with three rungs, not a switch plus a mode. The two knobs on
  // the wire are unchanged; what changed is that the page stops asking two
  // questions whose answers are not independent — "Automatic resolve: On" sat
  // above "Verified fixes: Confirm first" and read as a contradiction, and the
  // mode kept an inert row on screen whenever the switch was off. Read down,
  // the rungs are the scale everyone already has for machinery that does some
  // of the work: by hand, semi-automatic, fully automatic.
  const resolveRow = ladderField(RESOLVE_QUESTION,
    choiceList({ label: RESOLVE_QUESTION, options: RUNGS, value: rung(), onchange: pickRung }));
  const verifyModelRow = modelRow("auto_resolve_model", "Fix verification model",
    "Re-reads a written claim against a newer run's recorded page content. It is what produces “looks fixed”, and what fully automatic acts on.");

  mount(slot, h("div.stack.settings-form", {},
    h("section", {},
      h("h3.section-title", { style: "margin-top:0" }, "Models"),
      h("p.dim.section-caption", {},
        "What every run in this project uses unless a suite — or a single story — chooses its own; the more specific choice always wins."),
      // One statement of a deployment-wide fact, where it explains all four
      // settings below it, instead of the same sentence pasted under each.
      cap.llm === false
        ? h("p.preview-warn", { style: "margin:8px 0 0" },
            "This deployment has no model gateway (", h("span.mono", {}, "PLAYTEST_LLM_BASE_URL"),
            "), so the dedupe and fix-verification passes cannot run whatever they are set to.")
        : null,
    ),
    // The group titles are the explanation: three jobs, each with the model it
    // spends and the switch that decides whether it happens. A caption under
    // each one would only say the title again in a sentence.
    group("Running a story", actorRow, graderRow),
    group("Duplicate findings", dedupeRow, dedupeModelRow),
    group("Fixed findings", resolveRow, verifyModelRow),
    bar.el,
  ));
  paint();

  /**
   * The only two things worth saying under a row, said when they are true: a
   * consequence of switching something on that is not visible from here, and
   * why a row has gone inert. Everything else the controls say themselves.
   */
  function paint() {
    const resolveOn = shown("auto_resolve");

    say(dedupeRow, [
      // Turning the sweep on does something to findings that are already
      // filed, which is not something "on" implies.
      shown("auto_dedupe") && !(saved.auto_dedupe ?? deployment.auto_dedupe)
        ? "Saving this also sweeps the findings already queued." : null,
    ]);
    // What the rungs cannot state without saying it on each of them: which
    // findings the ladder reaches regardless of how they were reviewed, and the
    // one kind it never closes behind somebody's back.
    say(resolveRow, [resolveOn ? EXTERNAL_REF : null]);
    say(verifyModelRow, [resolveOn ? null : NOT_IN_USE]);
    // Dimmed, never disabled: the sweep being off is a reason to stop drawing
    // the eye, not a reason to stop someone configuring it before they enable it.
    verifyModelRow.classList.toggle("inert", !resolveOn);

    bar.set({ dirty: MODEL_KEYS.concat(SWITCH_KEYS).some((k) => pending[k] !== saved[k]) });
  }

  async function save() {
    bar.set({ dirty: true, saving: true });
    const changed = (k: WebDynamic) => pending[k] !== saved[k];
    try {
      if (MODEL_KEYS.some(changed)) {
        const updated = await api.put(`/projects/${projectKey}/models`, {
          actor_model: pending.actor_model,
          grader_model: pending.grader_model,
          consolidation_model: pending.consolidation_model,
          auto_resolve_model: pending.auto_resolve_model,
        });
        // Keep the in-memory project honest: Suite settings' "Project default —
        // …" inherit options read state.projectByKey, not the server, until the
        // next full load.
        project.models = updated.models;
      }
      if (changed("auto_dedupe")) {
        const updated = await api.put(`/projects/${projectKey}/auto-dedupe`, { enabled: pending.auto_dedupe });
        project.auto_dedupe = updated.auto_dedupe;
      }
      if (changed("auto_resolve") || changed("auto_resolve_mode")) {
        const updated = await api.put(`/projects/${projectKey}/auto-resolve`, { enabled: pending.auto_resolve, mode: pending.auto_resolve_mode });
        project.auto_resolve = updated.auto_resolve;
        project.auto_resolve_mode = updated.auto_resolve_mode;
      }
      const said = summarize(pending, saved, deployment);
      // Re-read from the project rather than from the draft: if the server
      // normalised a value, the bar must stay up rather than claim it saved
      // something it didn't.
      saved = snapshot();
      paint();
      toast("Settings saved", said, "ok");
    } catch (err: WebDynamic) {
      toastError(err);
      paint();
    }
  }
}

const ONOFF = [{ value: true, label: "On" }, { value: false, label: "Off" }];
const SWITCH_KEYS = ["auto_dedupe", "auto_resolve", "auto_resolve_mode"];
const NOT_IN_USE = "Not in use while findings close by hand.";
// Two facts nobody could read off the rungs, and one of them is the one people
// get wrong: confirming a finding is not a lock on it. The exemption is a live
// ticket, because that is the case where closing it here would contradict
// somebody else's record.
const EXTERNAL_REF = "This applies to findings you have confirmed, too. "
  + "A finding linked to a ticket is the exception: it stays semi-automatic whatever is set here, "
  + "arriving as “looks fixed” rather than closing for you.";

// The question the two stored knobs actually answer, and its three answers as
// one familiar scale: by hand, semi-automatic, fully automatic. The labels are
// what the wire already calls them (`auto_resolve_mode` is "semi" or "full"),
// and the analogy carries the right expectation on its own — semi-automatic
// does the work and stops for you at the one point it cannot decide.
//
// Where it stops is the line the sweep actually draws (findings/auto-resolve.ts,
// tierOf): what the finding is GROUNDED in. A finding that points at something
// recorded — the check that failed, the error signal captured at a page — can be
// re-tested by any later run that goes back over that ground, and nobody has to
// read anything. A finding that is only a claim in words has nothing to
// re-test, so it takes either a person or a model that re-read the page. Who
// filed it, and whether anyone has confirmed it, changes none of that, so the
// descriptions name the two kinds of finding rather than leaving "semi" to be
// guessed at.
const RESOLVE_QUESTION = "Closing a finding a later run has fixed";
const RUNGS = [
  {
    value: "never",
    label: "By hand",
    description: "Nothing is re-checked. Every finding waits for a person to close it.",
    said: "close by hand",
  },
  {
    value: "proven",
    label: "Semi-automatic",
    description: "A finding that points at something recorded — the check that failed, or the error captured "
      + "at a page — closes itself once a later run covers the same ground without hitting it. A finding that "
      + "is only a written claim cannot be settled that way, so it stops with you: it arrives as "
      + "“looks fixed”, one click to close.",
    said: "close semi-automatically",
  },
  {
    value: "verified",
    label: "Fully automatic",
    description: "Written claims close themselves too, once the verification model re-reads the newer run's "
      + "recorded pages and reports the issue gone. A passing run on its own is never enough.",
    said: "close fully automatically",
  },
];

/** A titled group of settings. */
const group = (title: WebDynamic, ...rows: WebDynamic[]) =>
  h("section.card.pad", {},
    h("h4.form-section-title", {}, title),
    h("div.setting-rows", {}, ...rows));

/**
 * A policy row. `formField` points a `<label for>` at one control, which a
 * radio group does not have — the group names itself with `aria-label`, so the
 * visible wording is a plain heading rather than a label pointing at nothing.
 */
const policyField = (label: WebDynamic, control: WebDynamic, hint: WebDynamic) =>
  h("div.field", {}, h("div.field-label", {}, label), control, h("div.hint", {}, hint));

/**
 * A policy row whose answers explain themselves. It gives up the answer column
 * — a stacked list of sentences squeezed into a third of the row would be read
 * a word at a time — and runs under the wording instead, which is also the only
 * place the options can sit and still be read in order.
 */
const ladderField = (label: WebDynamic, control: WebDynamic) =>
  h("div.field.field-wide", {}, h("div.field-label", {}, label), control);

/** The consequences under a row: none of them, or all the true ones. */
function say(field: WebDynamic, parts: WebDynamic) {
  const text = parts.filter(Boolean).join(" ");
  let note = field.querySelector(":scope > .field-note");
  if (!note) field.append(note = h("p.field-note", {}));
  note.textContent = text;
  note.hidden = !text;
}

/**
 * What the toast says it did, in the words of the page it did it on. The two
 * resolve keys are reported as the one rung they add up to — saying "automatic
 * resolve on · verified fixes confirm first" would put back exactly the two
 * questions the ladder replaced. Rungs are compared after inheritance, so a
 * change that only swaps a pin for the identical deployment default says
 * nothing.
 */
function summarize(next: WebDynamic, before: WebDynamic, deployment: WebDynamic) {
  const rungOf = (s: WebDynamic) => (!(s.auto_resolve ?? deployment.auto_resolve) ? "never"
    : (s.auto_resolve_mode ?? deployment.auto_resolve_mode) === "full" ? "verified" : "proven");
  const rung = rungOf(next);
  const said = [
    ...MODEL_KEYS.filter((k) => next[k] !== before[k]).map((k) => `${MODEL_WORDS[k]} ${next[k] || "engine default"}`),
    next.auto_dedupe !== before.auto_dedupe ? `automatic dedupe ${switchWord(next.auto_dedupe)}` : null,
    rung !== rungOf(before) ? `fixed findings ${RUNGS.find((r) => r.value === rung)!.said}` : null,
  ].filter(Boolean);
  return said.join(" · ");
}

const MODEL_WORDS: WebDynamic = {
  actor_model: "actor",
  grader_model: "grader",
  consolidation_model: "dedupe",
  auto_resolve_model: "fix verification",
};
const switchWord = (v: WebDynamic) => (v ? "on" : "off");
