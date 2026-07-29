// Story editor (UX Story editor screen). One canonical YAML string, two views:
//   • Form — schema-shaped fields for the common story keys (story/description/
//     persona/tags/mode/success), preserving unknown keys.
//   • YAML — the exact bytes a CLI user would commit.
// The right rail runs LIVE checks: validation (verbatim core validator messages) and
// lint, plus the commit-with-note flow. base_seq gives optimistic concurrency: a
// concurrent edit returns 409 rather than a silent overwrite.
import { api, ApiError } from "../lib/api.js";
import { h, mount, clear } from "../lib/dom.js";
import { link, navigate } from "../lib/router.js";
import { page } from "../lib/shell.js";
import { hasRole, hasLlm, LLM_UNAVAILABLE } from "../lib/state.js";
import { toast, toastError, confirmModal, errorState, formField, enhanceSelect, formModal, statusChip } from "../lib/ui.js";
import { parseYaml, applyModelToText, toModel, kindsForDriver, NUMERIC_KINDS } from "../lib/caseform.js";
import { criterionLabel, criterionHelp, criterionExample } from "../lib/vocab.js";
import { getSuiteBySlug } from "./suite.js";
import { launchModal } from "./runs.js";
import { projectPage } from "../lib/project-page.js";
import { sourceEditor } from "../lib/source-editor.js";
import { assistantMessageBlocks } from "../lib/assistant-message.js";

// A new story starts EMPTY. The template used to ship its own instructions as
// file content ("Describe what the user is trying to do…", "describe the
// observable outcome…"), which meant the first thing anyone did was select
// prose and delete it — and the first thing anyone who didn't would do is commit
// a story whose text was the prompt. Guidance belongs in placeholders, which
// disappear on their own.
const NEW_TEMPLATE = () => "";

// Core's own default (case.schema.json). Shown as the pre-selected persona so
// the picker never opens on a blank, but not written to the file until the
// author actually chooses something — an unset `persona:` already means tester.
const DEFAULT_PERSONA = "tester";
// What the picker offers if the personas endpoint is unavailable (an older
// control plane, or a request that failed): the engine's built-ins, which are
// resolvable everywhere. Better a short list than an empty dropdown.
const BUILTIN_PERSONAS: WebDynamic = ["tester", "exploratory", "adversarial"]
  .map((slug) => ({ slug, name: slug, builtin: true }));

export async function storyEditor(projectKey: WebDynamic, slug: WebDynamic, caseId: WebDynamic, query?: WebDynamic) {
  const context = projectPage(projectKey, { nav: "suites", title: caseId || "New story" });
  if (!context) return;
  const { main, project } = context;

  let st: WebDynamic;
  try {
    // Editing an existing story needs the resolved case list (path, driver,
    // next_run) — fold it onto the lookup instead of a second request.
    const suite = await getSuiteBySlug(projectKey, slug, caseId ? "cases" : null);
    if (!suite) return mount(main, page({ title: slug, body: h("div.dim", {}, "No such suite.") }));
    if (!hasRole(project.id, "editor")) {
      return mount(main, page({ title: caseId || "New story", body: h("div.dim", {}, "You need the editor role to edit stories.") }));
    }

    // Load current bytes + which case this is (path + driver), and the base seq.
    st = {
      projectKey, slug, suiteId: suite.id, suiteName: suite.name || suite.slug, project, caseId: caseId || null,
      path: null, driver: "web", baseSeq: null, view: "form",
      raw: "", isNew: !caseId,
      // ?assist=1 (the old /assistant link redirects here) opens Help me draft.
      assist: query?.get?.("assist") === "1",
    };
    // One parallel batch — only the file read further down needs anything from
    // these. The persona picker's option set stays fetched per editor open
    // rather than cached: a persona created in another tab should be
    // selectable here without a reload. A persona failure degrades to the
    // built-ins instead of blocking the editor — you can still write the story.
    const [snaps, personas] = await Promise.all([
      api.get(`/suites/${suite.id}/snapshots?limit=1`).catch(() => ({ items: [] })),
      api.get(`/projects/${projectKey}/personas`).catch(() => null),
    ]);
    st.baseSeq = snaps.items[0]?.seq ?? null;
    st.personas = personas?.items?.length ? personas.items : BUILTIN_PERSONAS;

    if (caseId) {
      const cases = suite.cases;
      const c = cases.find((x: WebDynamic) => x.id === caseId);
      if (!c) return mount(main, page({ title: caseId, body: h("div.dim", {}, "No such story.") }));
      st.path = c.path;
      st.driver = c.driver || "web";
      // next_run "check" means an accepted saved path exists — the one input the
      // Playwright export needs (a "record"/"explore" story has nothing to emit).
      st.hasBaseline = c.next_run === "check";
      const file = await api.get(`/suites/${suite.id}/files/${c.path}`);
      st.raw = file.content;
      st.savedRaw = file.content;
    } else {
      // No path yet. A new story's file is DERIVED from what the person writes
      // (see derivedPath) — asking someone answering "what is this user trying
      // to do?" to also choose a filename was the wrong question, and the old
      // default `stories/<suite-slug>.yaml` was the same file for every story
      // in the suite.
      st.path = null;
      st.raw = NEW_TEMPLATE();
      st.savedRaw = st.raw;
    }
  } catch (err: WebDynamic) {
    return mount(main, page({ title: caseId || "Story", body: errorState(err, () => storyEditor(projectKey, slug, caseId)) }));
  }

  renderEditor(main, st);
}

function renderEditor(main: WebDynamic, st: WebDynamic) {
  const checksSlot = h("div", {}, h("div.dim", {}, "…"));
  const pathLine = h("div.dim", { style: "font-size:12px" });

  // Every save is one immutable version — that discipline is worth keeping, but
  // the words don't have to be git's ("Save commit" / "Commit note"), and it no
  // longer asks for one. A free-text "What changed?" on a story editor was a
  // question with no good answer on a first save (nothing changed — the story
  // is new) and a redundant one afterwards, since the version diff already says
  // what changed. Versions carry a written note when it means something: the
  // note lives on the SUITE settings screen, where a defaults change really is
  // invisible in the diff.
  // Save/Discard live in a sticky bar at the bottom of the viewport, present
  // only while the draft differs from the saved bytes (for a new story, from
  // its starting template) — a clean page shows no pending decision.
  const source = sourceEditor({
    state: st,
    parse: (raw: string) => toModel(parseYaml(raw)),
    renderForm: (model: WebDynamic, changed: WebDynamic) =>
      buildForm(st, model, () => { syncFromForm(st, model); changed(); }),
    rerender: () => renderEditor(main, st),
    save,
    check: runChecks,
    yamlLabel: st.path || "Story YAML",
    discardBody: st.isNew
      ? "This story goes back to the blank starting template. Nothing else is affected."
      : "This story goes back to its last saved version. Nothing else is affected.",
    onChange: paintPathLine,
    onDiscard: () => { if (st.isNew) st.path = null; },
  });
  const side = h("div.side", {},
    h("div.card.pad", {}, h("div.label", { style: "margin-bottom:8px" }, "Checks"), checksSlot),
    // Provenance, not a question: where this story will live on disk. The path
    // is derived from what the author writes and there is no override — hand-
    // picking it is a power-user move that mostly produces a story whose file
    // name and name disagree.
    h("div.card.pad", {},
      h("div.label", { style: "margin-bottom:6px" }, "File"),
      pathLine,
    ),
  );
  mount(main, page({
    crumbs: [
      link(`/p/${st.projectKey}`, "Suites"), " / ",
      link(`/p/${st.projectKey}/suites/${st.slug}`, st.suiteName), " / ",
      st.isNew ? "New story" : caseIdFromPath(st.path),
    ],
    title: st.isNew ? "New story" : caseIdFromPath(st.path),
    actions: [
      source.toggle,
      // Disabled with the reason on a deployment that has no model gateway —
      // the modal would otherwise take a goal and fail on send (503).
      h("button.btn", {
        disabled: hasLlm() ? undefined : true,
        onclick: () => helpMeDraft(st, applyDraft),
        title: !hasLlm() ? LLM_UNAVAILABLE
          : st.isNew ? "Describe the journey and let the assistant draft the story"
          : "Describe what to change and let the assistant improve this story",
      }, "Help me draft"),
      st.isNew ? null : link(`/p/${st.projectKey}/suites/${st.slug}/stories/${encodeURIComponent(caseIdFromPath(st.path))}/history`, h("span.btn", {}, "Run history")),
      // One-way escape hatch: the accepted saved path as a runnable Playwright
      // spec. Only for a web story that HAS a saved path — offering it otherwise
      // would promise a file we cannot produce.
      !st.isNew && st.hasBaseline && st.driver === "web"
        ? h("button.btn", {
            title: "Download this story's saved path as a standalone Playwright spec. One-way: Playtest never reads it back and will not heal it.",
            onclick: (e: WebDynamic) => exportPlaywright(st, e.currentTarget),
          }, "Export Playwright")
        : null,
      st.isNew ? null : h("button.btn.danger", { onclick: deleteStory }, "Delete story"),
      // run just this story — the launch modal scoped to its id (decisions §5.3)
      st.isNew ? null : h("button.btn.primary", { onclick: () => launchModal(st.projectKey, null, st.suiteId, { ids: [st.caseId || caseIdFromPath(st.path)] }) }, "▶ Run"),
    ].filter(Boolean),
    body: h("div", {}, h("div.editor", {}, source.editorSlot, side), source.bar.el),
  }));

  /** The file line, live: a new story's path follows what the person writes. */
  function paintPathLine() {
    const derived = currentPath();
    mount(pathLine,
      derived
        ? h("span.mono", {}, derived)
        : h("span.warn", {}, "Give this story a description — it becomes the story's name and its file."),
    );
  }

  async function runChecks() {
    // A new story has no path until it is saved; validation still needs one to
    // report against, so it checks against the path the save will use.
    const changes: WebDynamic = [{ path: currentPath() || "stories/new-story.yaml", content: st.raw }];
    // Validation is the gate (disables save); lint is advisory. Keep them
    // independent so one failing request never hides the other's result.
    const [v, l] = await Promise.allSettled([
      api.post(`/suites/${st.suiteId}/validate`, { changes }),
      api.post(`/suites/${st.suiteId}/lint`, { changes }),
    ]);
    if (v.status !== "fulfilled") {
      mount(checksSlot, h("div.dim", {}, "couldn't run checks"));
      return undefined;
    }
    const findings = l.status === "fulfilled" ? l.value.findings : [];
    mount(checksSlot, renderChecks(v.value, findings, st));
    return Boolean(v.value.ok);
  }

  // Apply an assistant draft to the UNSAVED editor state only — no network
  // write. The person still edits and Saves through the ordinary form (the sole
  // durable path). For a new story the model's path fills the file-path field;
  // for an existing story the server pins the path, so it is left untouched.
  function applyDraft(draft: WebDynamic) {
    st.raw = draft.yaml;
    if (st.isNew && draft.path) st.path = draft.path;
    st.view = "form";
    renderEditor(main, st); // re-render rebuilds the form/YAML and re-runs checks
    toast("Draft applied", "review and edit it, then Save", "ok");
  }

  /** Where this story will be written: an assistant's suggestion if there is
      one, else the path derived from what the person wrote. */
  function currentPath() {
    if (!st.isNew) return st.path;
    return st.path || derivedPath(st);
  }

  async function save() {
    if (st.isNew) {
      st.path = currentPath();
      if (!st.path) {
        return toast("This story needs a name", "add a one-line description — it becomes the story's name and its file", "err");
      }
    }
    source.bar.set({ dirty: true, saving: true });
    try {
      // The note is derived, not asked for. Versions is a shared log, and a
      // permanently blank "What changed" column would be worse than a plain
      // factual line — the diff of a story edit already says the rest.
      const name = caseIdFromPath(st.path);
      const res = await api.post(`/suites/${st.suiteId}/commit`, {
        changes: [{ path: st.path, content: st.raw }],
        note: st.isNew ? `added story ${name}` : `edited story ${name}`,
        base_seq: st.baseSeq,
      });
      st.savedRaw = st.raw;
      toast("Saved", `version #${res.snapshot.seq}`, "ok");
      navigate(`/p/${st.projectKey}/suites/${st.slug}`);
    } catch (err: WebDynamic) {
      source.paintBar();
      if (err.status === 409) return handleConflict(st, err);
      toastError(err);
    }
  }

  async function deleteStory() {
    const name = caseIdFromPath(st.path);
    const ok = await confirmModal({
      title: `Delete "${name}"?`,
      body: "Removes this story from the suite and creates a new version. Existing run history and earlier suite versions remain available." +
        (st.raw !== st.savedRaw ? " Your unsaved changes will be discarded." : ""),
      confirmLabel: "Delete story",
      cancelLabel: "Keep story",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/suites/${st.suiteId}/files/${st.path}`, {
        note: `deleted story ${name}`,
        base_seq: st.baseSeq,
      });
      toast("Story deleted", name, "ok");
      navigate(`/p/${st.projectKey}/suites/${st.slug}`);
    } catch (err: WebDynamic) {
      if (err.status === 409) return handleConflict(st, err);
      toastError(err);
    }
  }

  source.initialize();

  // Deep-linked from the old assistant route (/assistant → /new?assist=1): open
  // the drafting modal once, then clear the flag so a re-render doesn't reopen it.
  if (st.assist) {
    st.assist = false;
    if (hasLlm()) helpMeDraft(st, applyDraft);
    else toast("Story drafting is unavailable", LLM_UNAVAILABLE, "err");
  }
}

// ---------- Help me draft: inline, stateless story drafting ----------
//
// One editor-authorized endpoint (POST /suites/:s/story-draft) drafts one
// story — or a small set, when the goal asks for one — or improves an existing
// story. The transcript is browser-held and resent each turn; nothing is
// persisted server-side. The model asks a clarifying question or returns
// validated draft(s): a single draft Applies into the unsaved form, a set is
// reviewed in place and approved with one Save-all commit.
function helpMeDraft(st: WebDynamic, onApply: WebDynamic) {
  // Browser-held clarification exchange (role/content), resent on every request.
  const transcript: WebDynamic = [];
  let goal = "";
  let busy = false;
  let phase = "goal"; // goal → thinking → clarify → draft | set (→ next, after Save & draft another)
  let reply = "";
  let draft: WebDynamic = null;
  let drafts: WebDynamic[] = []; // a proposed SET (2+): reviewed together, saved with one commit
  let errMsg = "";
  let thinkingStatus = "Drafting";

  const bodyEl = h("div.draft-modal");
  const repaint = () => {
    clear(bodyEl);
    bodyEl.append(build());
    // The transcript scrolls inside a window-capped dialog; keep the newest
    // turn in view rather than leaving the person scrolled to the first reply.
    const log = bodyEl.querySelector(".chat-log");
    if (log) log.scrollTop = log.scrollHeight;
  };
  const close = formModal("Help me draft a story", () => { repaint(); return bodyEl; });

  const inlineAssistantText = (text: string) => {
    const parts = text.split(/(\*\*[^*\n]+\*\*)/g);
    return parts.filter(Boolean).map((part) =>
      part.startsWith("**") && part.endsWith("**")
        ? h("strong", {}, part.slice(2, -2))
        : part,
    );
  };

  const assistantCopy = (content: unknown) =>
    assistantMessageBlocks(content).map((block) => {
      if (block.kind === "unordered-list") {
        return h("ul", {}, ...block.items.map((item) => h("li", {}, inlineAssistantText(item))));
      }
      if (block.kind === "ordered-list") {
        return h("ol", { start: block.start === 1 ? null : block.start },
          ...block.items.map((item) => h("li", {}, inlineAssistantText(item))));
      }
      return h("p", {}, inlineAssistantText(block.text));
    });

  const assistantMessage = (content: unknown) =>
    h("div.msg.assistant.assistant-copy", {}, ...assistantCopy(content));

  function build() {
    // The goal travels as its own request field, not a transcript turn, so the
    // log must render it explicitly or the exchange opens on the assistant.
    const log = h("div.chat-log", { "aria-live": "polite" },
      goal ? h("div.msg.user", {}, goal) : null,
      ...transcript.map((m: WebDynamic) =>
        m.role === "user" ? h("div.msg.user", {}, m.content) : assistantMessage(m.content)),
    );
    if (phase === "thinking") {
      log.append(
        h("div.msg.assistant.thinking", {},
          h("span.drafting-indicator", { role: "status", "aria-label": thinkingStatus },
            h("span", { "aria-hidden": "true" }, thinkingStatus),
            h("span.drafting-dots", { "aria-hidden": "true" },
              h("span", {}),
              h("span", {}),
              h("span", {}),
            ),
          ),
        ),
      );
    }

    // One reviewed story: path + verdict, rationale, verbatim validator/lint
    // findings, and the YAML behind a disclosure. Shared by the single-draft
    // and set views so a story reads the same alone or in a list.
    const draftCard = (d: WebDynamic, lead: WebDynamic = null) => {
      const ok = d.validation?.ok === true;
      return h("div.card.pad", {},
        lead ? h("div.assistant-copy", {}, ...assistantCopy(lead)) : null,
        h("div.draft-head", { style: "display:flex;align-items:center;gap:8px" },
          h("span.mono", {}, d.path),
          ok ? statusChip("pass", "valid") : statusChip("fail", "needs work")),
        d.rationale ? h("div.dim", { style: "margin-top:4px" }, d.rationale) : null,
        !ok && d.validation?.errors?.length
          ? h("ul.check-list", {}, ...d.validation.errors.map((e: WebDynamic) =>
              h("li.check-item.err", {}, h("span.g", {}, "✗"), h("span.msg", {}, e.path ? `${e.path}: ${e.message}` : e.message))))
          : null,
        d.lint?.length
          ? h("ul.check-list", {}, ...d.lint.map((f: WebDynamic) => h("li.check-item.warn", {}, h("span.g", {}, "⚠"), h("span.msg", {}, f.message))))
          : null,
        h("details", {}, h("summary", {}, "YAML"), h("pre.code.draft-yaml", {}, d.yaml)),
      );
    };

    const controls: WebDynamic = [];
    if (phase === "set" && drafts.length) {
      // A proposed SET: review every story, approve once. Save all commits the
      // valid ones as ONE suite version; an adjustments box continues the same
      // conversation instead of forcing a restart when one story misses.
      const valid = drafts.filter((d: WebDynamic) => d.validation?.ok === true);
      const ta = h("textarea#draft-goal", {
        style: "min-height:60px",
        placeholder: 'e.g. "story 2 should use the adversarial persona" — or save the set as is',
        disabled: busy || undefined,
        onkeydown: (e: WebDynamic) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(ta.value); } },
      });
      return h("div.stack", {},
        log,
        reply ? h("div.assistant-copy", {}, ...assistantCopy(reply)) : null,
        ...drafts.map((d: WebDynamic) => draftCard(d)),
        errMsg ? h("div.chat-error", {}, statusChip("fail", "couldn't save"), h("span.dim", {}, ` ${errMsg}`)) : null,
        h("div.field", {}, h("label", { for: "draft-goal" }, "Want changes first?"), ta),
        h("div.modal-actions", {},
          h("button.btn.ghost", { onclick: () => resetToGoal() }, "Start over"),
          h("button.btn", { disabled: busy || undefined, onclick: () => submit(ta.value) }, "Request changes"),
          h("button.btn.primary", {
            disabled: valid.length && !busy ? undefined : true,
            title: valid.length === drafts.length
              ? "Save every story in one suite version"
              : valid.length
                ? "Saves only the valid stories — request fixes first if you want them all"
                : "No story is valid yet — request fixes first",
            onclick: () => saveAll(),
          }, `Save ${valid.length === 1 ? "1 story" : `${valid.length} stories`}`),
        ),
      );
    }
    if (phase === "draft" && draft) {
      const valid = draft.validation?.ok === true;
      controls.push(
        draftCard(draft, reply || null),
        errMsg ? h("div.chat-error", {}, statusChip("fail", "couldn't save"), h("span.dim", {}, ` ${errMsg}`)) : null,
        h("div.modal-actions", {},
          h("button.btn.ghost", { onclick: () => resetToGoal() }, "Start over"),
          // Only for a NEW story: an existing story's editor is pinned to one
          // file, so "another" story has nowhere sensible to go from it.
          st.isNew ? h("button.btn", {
            disabled: valid && !busy ? undefined : true,
            title: valid ? "Save this story to the suite and keep drafting" : "Fix the draft first — only a valid story can be saved",
            onclick: () => saveAndContinue(),
          }, "Save & draft another") : null,
          h("button.btn.primary", {
            disabled: valid ? undefined : true,
            title: valid ? "Fill the form with this draft" : "Fix the draft before applying — the form only takes a valid story",
            onclick: () => { onApply(draft); close(); },
          }, "Apply draft"),
        ),
      );
      return h("div.stack", {}, log, ...controls);
    }

    // goal / clarify / error: an input + send
    const promptLabel = phase === "clarify"
      ? "Answer the assistant"
      : phase === "next" ? "Describe the next story"
      : st.isNew ? "Describe the journey you want to test" : "What should change about this story?";
    const ta = h("textarea#draft-goal", {
      style: `min-height:${phase === "goal" ? "120px" : "88px"}`,
      placeholder: st.isNew
        ? 'e.g. "A new user signs up and lands on their dashboard"'
        : 'e.g. "Add a check that the confirmation email is shown"',
      disabled: busy || undefined,
      onkeydown: (e: WebDynamic) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(ta.value); } },
    });
    if (errMsg) controls.push(h("div.chat-error", {}, statusChip("fail", "couldn't draft"), h("span.dim", {}, ` ${errMsg}`)));
    return h("div.stack", {},
      log,
      h("div.field", {}, h("label", { for: "draft-goal" }, promptLabel), ta),
      h("div.modal-actions", {},
        h("button.btn.ghost", { onclick: () => close() }, "Cancel"),
        h("button.btn.primary", { disabled: busy || undefined, onclick: () => submit(ta.value) },
          phase === "clarify" ? "Send" : "Draft it"),
      ),
    );
  }

  // Commit this draft and keep the conversation open. The draft endpoint is
  // stateless and rebuilds its prompt from live suite state each turn, so the
  // next request's model already sees the saved story under "Existing stories"
  // and can draft the next one to fit alongside it. The commit here IS the
  // ordinary human Save path (POST /commit) — the person pressed the button.
  async function saveAndContinue() {
    if (busy || !draft) return;
    busy = true; errMsg = "";
    repaint();
    try {
      const name = caseIdFromPath(draft.path);
      const res = await api.post(`/suites/${st.suiteId}/commit`, {
        changes: [{ path: draft.path, content: draft.yaml }],
        note: `added story ${name}`,
        base_seq: st.baseSeq,
      });
      // Our commit is now the editor's base: without this, closing the modal
      // and saving the form would 409 against the version we just wrote.
      st.baseSeq = res.snapshot.seq;
      toast("Saved", `${name} — version #${res.snapshot.seq}`, "ok");
      transcript.push({ role: "assistant", content: `Saved ${draft.path}. What should the next story cover?` });
      draft = null; reply = "";
      phase = "next";
    } catch (err: WebDynamic) {
      errMsg = err?.status === 409
        ? "someone else saved a suite version since you opened this editor — apply the draft and save through the form instead"
        : err?.message || "the save didn't go through — try again";
    } finally {
      busy = false;
      repaint();
      if (phase === "next") document.getElementById("draft-goal")?.focus();
    }
  }

  // Approve the whole set once: every valid draft lands in ONE commit (one
  // suite version, one 409 boundary), then the modal closes onto the suite —
  // the same ordinary human Save path, pressed one time instead of N.
  async function saveAll() {
    const valid = drafts.filter((d: WebDynamic) => d.validation?.ok === true);
    if (busy || !valid.length) return;
    busy = true; errMsg = "";
    repaint();
    try {
      const res = await api.post(`/suites/${st.suiteId}/commit`, {
        changes: valid.map((d: WebDynamic) => ({ path: d.path, content: d.yaml })),
        note: valid.length === 1 ? `added story ${caseIdFromPath(valid[0].path)}` : `added ${valid.length} stories`,
        base_seq: st.baseSeq,
      });
      st.baseSeq = res.snapshot.seq;
      toast("Saved", `${valid.length === 1 ? "1 story" : `${valid.length} stories`} — version #${res.snapshot.seq}`, "ok");
      close();
      navigate(`/p/${st.projectKey}/suites/${st.slug}`);
    } catch (err: WebDynamic) {
      errMsg = err?.status === 409
        ? "someone else saved a suite version since you opened this editor — reload the suite and draft again"
        : err?.message || "the save didn't go through — try again";
      busy = false;
      repaint();
    }
  }

  function resetToGoal() {
    transcript.length = 0;
    goal = ""; reply = ""; draft = null; drafts = []; errMsg = ""; phase = "goal";
    repaint();
  }

  async function submit(text: WebDynamic) {
    const value = (text || "").trim();
    if (!value || busy) return;
    if (phase === "goal") goal = value;
    else transcript.push({ role: "user", content: value });
    busy = true; errMsg = ""; phase = "thinking"; thinkingStatus = "Drafting";
    repaint();
    try {
      const payload: WebDynamic = { goal, transcript };
      if (!st.isNew) { payload.existing_path = st.path; payload.existing_yaml = st.raw; }
      const res = await api.postEvents(`/suites/${st.suiteId}/story-draft`, payload, (event) => {
        if (event.event === "retry") {
          const attempt = Number(event.data?.attempt);
          const maxAttempts = Number(event.data?.max_attempts);
          if (Number.isSafeInteger(attempt) && Number.isSafeInteger(maxAttempts)) {
            thinkingStatus = `Retrying ${attempt} of ${maxAttempts}`;
            repaint();
          }
        } else if (event.event === "working" && thinkingStatus !== "Drafting") {
          thinkingStatus = "Drafting";
          repaint();
        }
      });
      reply = res.reply || "";
      if (res.drafts?.length > 1) {
        // A proposed set. The YAMLs live only in `drafts`; the transcript gets
        // the paths so a follow-up turn ("swap story 2 for…") has the context
        // the stateless server will otherwise never see again.
        drafts = res.drafts;
        draft = null;
        phase = "set";
        transcript.push({
          role: "assistant",
          content: [reply, `Proposed ${drafts.length} stories: ${drafts.map((d) => d.path).join(", ")}`].filter(Boolean).join("\n"),
        });
      } else if (res.draft) {
        draft = res.draft;
        drafts = [];
        phase = "draft";
        if (reply) transcript.push({ role: "assistant", content: reply });
      } else {
        // needs_input: hold the question in the transcript and ask again.
        transcript.push({ role: "assistant", content: reply || "Tell me a little more." });
        phase = "clarify";
      }
    } catch (err: WebDynamic) {
      errMsg = err?.message || "the assistant couldn't respond — try again";
      // Fall back to where the person was: a failed adjustment request must not
      // discard the proposed set they were reviewing.
      phase = drafts.length ? "set" : goal ? (transcript.length ? "clarify" : "goal") : "goal";
    } finally {
      busy = false;
      repaint();
      if (phase === "clarify" || phase === "goal") document.getElementById("draft-goal")?.focus();
    }
  }
}

async function handleConflict(st: WebDynamic, _err: WebDynamic) {
  const ok = await confirmModal({
    title: "Someone else changed this story",
    body: "Someone else saved a new version since you started editing. Load theirs? Your unsaved edits will be lost.",
    confirmLabel: "Reload latest",
    danger: true,
  });
  if (ok) storyEditor(st.projectKey, st.slug, st.isNew ? null : caseIdFromPath(st.path));
}

function buildForm(st: WebDynamic, model: WebDynamic, onChange: WebDynamic) {
  const kinds = kindsForDriver(st.driver);
  // Every prompt this form used to ship as file content is a placeholder now:
  // it shows the shape of a good answer and costs nothing to ignore.
  const story = h("textarea", {
    style: "min-height:120px", value: model.story,
    placeholder: "In their words, and at the level of intent — not clicks.\n\ne.g. Order a large pepperoni for delivery tonight, paying with the card already on the account.",
    oninput: (e: WebDynamic) => { model.story = e.target.value; onChange(); },
  });
  const description = h("input", {
    type: "text", value: model.description, placeholder: "Reorder a favourite for delivery",
    oninput: (e: WebDynamic) => { model.description = e.target.value; onChange(); },
  });
  const tags = h("input", { type: "text", value: model.tags, placeholder: "smoke, payments", oninput: (e: WebDynamic) => { model.tags = e.target.value; onChange(); } });
  const personaSlot = h("div");
  const mode = h("select", {
    onchange: (e: WebDynamic) => {
      model.mode = e.target.value;
      // Discovery is the only mode that fans out over several personas, so the
      // picker changes shape with the mode. Going the other way, a journey runs
      // as exactly one persona — drop the rest here rather than leaving a list
      // in the file that core would silently collapse at run time.
      if (model.mode !== "discovery") model.persona = splitPersonas(model.persona)[0] || "";
      paintPersona();
      onChange();
    },
  },
    h("option", { value: "journey", selected: model.mode !== "discovery" }, "journey — a regression check"),
    h("option", { value: "discovery", selected: model.mode === "discovery" }, "discovery — open exploration"),
  );
  const paintPersona = () => mount(personaSlot, personaPicker(st, model, onChange, paintPersona));
  paintPersona();

  const critList = h("div.criteria");
  // `focus` names the row whose value input should hold the caret after a
  // repaint: adding a criterion, or changing one's kind, is always followed by
  // typing its value, and a repaint that dropped focus made you reach for the
  // mouse again to finish the thing you just started.
  const paintCrit = (focus: WebDynamic = null) => {
    clear(critList);
    if (!model.success.length) {
      critList.append(h("div.crit-empty", {}, "No criteria — nothing is checked deterministically, and the grader alone decides whether this story passed."));
    }
    model.success.forEach((row: WebDynamic, i: WebDynamic) => {
      critList.append(criterionRow(row, i, kinds, {
        onChange,
        repaint: paintCrit,
        onRemove: () => { model.success.splice(i, 1); paintCrit(); onChange(); },
      }));
    });
    critList.append(h("button.btn.btn-sm", {
      style: "margin-top:4px",
      onclick: () => {
        model.success.push({ kind: kinds[0], value: "", label: "" });
        paintCrit(model.success.length - 1);
        onChange();
      },
    }, "+ Add criterion"));
    if (focus !== null) critList.querySelector(`[data-crit-value="${focus}"]`)?.focus();
    const fitAll = () => critList.querySelectorAll(".crit-claim").forEach(fitClaim);
    fitAll();
    requestAnimationFrame(fitAll);
  };
  // An empty story opens with one blank criterion rather than none: the row's
  // own help line and example explain what a criterion is, and an empty row is
  // never written to the file (applyModelToText drops criteria with no value).
  if (!model.success.length) model.success.push({ kind: kinds[0], value: "", label: "" });
  paintCrit();

  return h("div.card.pad", {},
    fieldBlock("Story — what is this user trying to do?", story),
    fieldBlock("Description", description, st.isNew
      ? "a one-line summary — it also becomes this story's name and its file"
      : "a one-line summary (optional)"),
    h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start" },
      personaSlot, fieldBlock("Tags", tags)),
    fieldBlock("Mode", mode),
    h("div.field", {},
      h("label", {}, "Success criteria"),
      h("div.hint", { style: "margin:-2px 0 10px" },
        "Checked on every run, on top of the grader's own reading of the story. Every one of them has to hold for this story to pass."),
      critList),
  );
}

/**
 * One success criterion: WHAT to check, WHAT it must be, and — under the value
 * — one line saying what that kind actually looks at.
 *
 * The row used to be three controls and a placeholder: a picker of sentence
 * fragments, an unlabelled text box, and a ⌫. Nothing on the screen said what
 * `element_exists` matched against, which of the kinds cost a model call, or
 * that the number next to "Console errors at most" was a ceiling — all of it
 * lived in the schema. Each of those is now one short line under the value it
 * explains, so the vocabulary is learned in place and only once.
 *
 * The optional cosmetic `label` is editable here for the same reason: the form
 * has always PRESERVED one (it rides through applyModelToText untouched), but
 * an author who had named a criterion in YAML could neither see nor change the
 * name in the form.
 */
function criterionRow(row: WebDynamic, i: WebDynamic, kinds: WebDynamic, { onChange, repaint, onRemove }: WebDynamic) {
  const numeric = NUMERIC_KINDS.has(row.kind);
  const name = criterionLabel(row.kind);

  const kindSel = h("select", {
    "aria-label": `Criterion ${i + 1} — what to check`,
    onchange: (e: WebDynamic) => {
      const next = e.target.value;
      row.value = valueForKind(row.value, next);
      row.kind = next;
      // The whole row changes with the kind — the input's type, its example,
      // and the line under it — so it is rebuilt rather than patched.
      repaint(i);
      onChange();
    },
  },
    ...kinds.map((k: WebDynamic) => h("option", { value: k, selected: row.kind === k }, criterionLabel(k))),
    // A kind this driver doesn't offer (a suite's custom assertion, or a story
    // authored for another driver) stays selectable and stays selected: the
    // form must never silently rewrite a criterion it doesn't recognise.
    kinds.includes(row.kind) ? null : h("option", { value: row.kind, selected: true }, name),
  );

  // An assertion is a SENTENCE, and a sentence does not fit on one line of a
  // 400px input: a claim like "the results show that the buyer is not eligible
  // for any government home-buying scheme" scrolled out of sight the moment it
  // was written, so the one criterion you most need to re-read was the one you
  // could not see. It grows to its own text instead (fitClaim) — still one
  // value, still one line in the file, just fully visible.
  const prose = row.kind === "assert";
  const val = prose
    ? h("textarea.crit-claim", {
        rows: 1,
        value: row.value,
        placeholder: criterionExample(row.kind),
        "aria-label": `Criterion ${i + 1} — ${name}`,
        "data-crit-value": i,
        // Enter would put a newline in a value the schema types as one string;
        // a pasted paragraph collapses to spaces for the same reason.
        onkeydown: (e: WebDynamic) => { if (e.key === "Enter") e.preventDefault(); },
        oninput: (e: WebDynamic) => {
          if (/[\r\n]/.test(e.target.value)) e.target.value = e.target.value.replace(/\s*[\r\n]+\s*/g, " ");
          row.value = e.target.value;
          fitClaim(e.target);
          onChange();
        },
      })
    // A count is typed as a count: a stepper, a numeric keypad on touch, and no
    // way to type prose into a field the schema types as a number.
    : h(numeric ? "input.crit-num" : "input.crit-text.mono", {
        type: numeric ? "number" : "text",
        min: numeric ? "0" : null,
        step: numeric ? "1" : null,
        inputmode: numeric ? "numeric" : null,
        // Selectors, globs and JSON paths are code — autocorrect only damages them.
        spellcheck: "false",
        autocapitalize: "off",
        autocomplete: "off",
        value: row.value,
        placeholder: criterionExample(row.kind),
        "aria-label": `Criterion ${i + 1} — ${name}`,
        "data-crit-value": i,
        oninput: (e: WebDynamic) => { row.value = e.target.value; onChange(); },
      });
  const valCell = numeric
    ? h("div.crit-val", {}, h("span.crit-affix", { "aria-hidden": "true" }, "at most"), val)
    : h("div.crit-val", {}, val);

  const del = h("button.btn.btn-sm.ghost.crit-del", {
    type: "button",
    title: "remove this criterion",
    "aria-label": `Remove criterion ${i + 1}`,
    onclick: onRemove,
  }, "⌫");

  // The optional name, shown once there is one to show or once someone asks for
  // one. Revealing and collapsing it move the two nodes themselves instead of
  // repainting the list: a blur handler that rebuilt the row would destroy the
  // control the blur was on its way to (the ⌫ next to it, or the row below).
  const nameInput = h("input", {
    type: "text", value: row.label || "",
    placeholder: "e.g. Delivery window shown",
    "aria-label": `Criterion ${i + 1} — name (optional)`,
    oninput: (e: WebDynamic) => { row.label = e.target.value; onChange(); },
    onblur: () => { if (!row.label) hideName(); },
  });
  // Prefixed, and smaller than the value it hangs under: two identical boxes in
  // one column would leave which one is the CHECK to be guessed.
  const nameCell = h("div.crit-name", {}, h("span.crit-affix", { "aria-hidden": "true" }, "Name"), nameInput);
  const nameBtn = h("button.linkish.crit-name-btn", {
    type: "button",
    title: "Give this criterion a short name — it appears in run summaries and burned clips",
    onclick: () => { showName(); nameInput.focus(); },
  }, "Name it");
  const help = h("div.crit-help", {}, criterionHelp(row.kind) || "A check this suite's own assertions define.");

  const el = h("div.criterion", {}, namedSelect(kindSel), valCell, del, help);
  function showName() { row.naming = true; nameBtn.remove(); el.insertBefore(nameCell, help); }
  function hideName() { row.naming = false; nameCell.remove(); help.append(nameBtn); }
  if (row.label || row.naming) showName(); else help.append(nameBtn);
  return el;
}

/**
 * Grow a claim field to the text it holds. `scrollHeight` is only meaningful
 * once the element is in the document, so paintCrit also re-fits every claim on
 * the next frame — the form is built detached and mounted by the editor.
 */
function fitClaim(el: WebDynamic) {
  if (!el?.isConnected) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * The value to carry across a kind change. A criterion's value only means
 * anything under its own kind — "the cart shows three items" is not a ceiling
 * and 0 is not a selector — so a value the new kind could never accept is
 * replaced by that kind's own starting point instead of being left behind for
 * the server to reject. Anything that could plausibly still be meant is kept:
 * retyping a long assert because you looked at a neighbouring kind would be a
 * worse trade than one stale value.
 */
function valueForKind(prev: WebDynamic, kind: WebDynamic) {
  const s = String(prev ?? "").trim();
  if (!s) return prev;
  // A count: keep a count, and start every other value at the ceiling worth
  // asking for — none.
  if (NUMERIC_KINDS.has(kind)) return /^\d+$/.test(s) ? s : "0";
  // A bare number is a real status ("200"), and nothing else here.
  if (kind === "response_status") return prev;
  return /^\d+$/.test(s) ? "" : prev;
}

/**
 * The persona field. A persona used to be a free-text box whose only guidance
 * was the placeholder "tester" — so it was equally easy to type a name that
 * resolves and one that doesn't, and core only finds out at RUN time (personas
 * resolve in the runner, not in validation). A picker of what actually exists
 * makes the invalid case unreachable.
 *
 * Shape follows the mode, because the schema does: a journey runs as exactly
 * one persona, while discovery accepts a list and fans out one run per entry.
 * Returns the whole labeled field so a mode change can swap it wholesale.
 */
function personaPicker(st: WebDynamic, model: WebDynamic, onChange: WebDynamic, repaint: WebDynamic) {
  const multi = model.mode === "discovery";
  const chosen = splitPersonas(model.persona);
  // Nothing chosen means core's default, so the control opens on it rather than
  // on a blank row. The file is only written when the author picks something.
  const rows = chosen.length ? chosen : [DEFAULT_PERSONA];
  const shown = multi ? rows : rows.slice(0, 1);

  const commit = (next: WebDynamic) => {
    // Deduped: the same persona twice would fan out two identical runs and bill
    // for both. Picking one that's already listed collapses the row instead.
    model.persona = [...new Set(next)].join(", ");
    onChange();
    repaint();
  };

  const list = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
  shown.forEach((value, i) => {
    const sel = personaSelect(st, value, multi ? `Persona ${i + 1}` : "Persona", (v: WebDynamic) => {
      const next: WebDynamic = [...shown];
      next[i] = v;
      commit(next);
    });
    list.append(
      h("div", { style: "display:flex;gap:6px;align-items:center" },
        h("div", { style: "flex:1;min-width:0" }, namedSelect(sel)),
        multi && shown.length > 1
          ? h("button.btn.btn-sm.ghost", {
              title: "stop running this story as this persona",
              "aria-label": `Remove persona ${value}`,
              onclick: () => commit(shown.filter((_, j) => j !== i)),
            }, "⌫")
          : null,
      ),
    );
  });

  // Fan-out is a cost multiplier, so say what adding one does before it is
  // added, not in the launch preview afterwards.
  if (multi) {
    const remaining = st.personas.filter((p: WebDynamic) => !shown.includes(p.slug));
    list.append(h("button.btn.btn-sm", {
      style: "margin-top:2px;align-self:flex-start",
      disabled: remaining.length ? undefined : true,
      title: remaining.length ? "Run this story once more as another persona" : "Every persona in this project is already listed",
      onclick: () => commit([...shown, remaining[0].slug]),
    }, "+ add persona"));
  }

  const hintText = multi
    ? h("span", {}, `Each persona runs this story once — ${shown.length} ${shown.length === 1 ? "run" : "runs"}. `, managePersonas(st))
    : h("span", {}, "Who the actor behaves as. ", managePersonas(st));

  return h("div.field", {},
    h("div.label", { style: "text-transform:none;letter-spacing:0;font-size:var(--fs-sm);color:var(--ink);margin-bottom:5px" }, "Persona"),
    list,
    h("div.hint", {}, hintText),
  );
}

/** One persona <select>: the project's list, with the tiers named when both exist. */
function personaSelect(st: WebDynamic, value: WebDynamic, label: WebDynamic, onPick: WebDynamic) {
  const all = st.personas || BUILTIN_PERSONAS;
  const builtin = all.filter((p: WebDynamic) => p.builtin);
  const project = all.filter((p: WebDynamic) => !p.builtin);
  const known = all.some((p: WebDynamic) => p.slug === value);
  const opt = (p: WebDynamic) => h("option", { value: p.slug, selected: p.slug === value }, p.name || p.slug);
  // A disabled option is the group heading: enhanceSelect flattens <optgroup>
  // into a plain list, and skips disabled entries in keyboard navigation.
  const heading = (text: WebDynamic) => h("option", { disabled: true }, `— ${text} —`);
  const grouped = project.length;

  return h("select", {
    "aria-label": label,
    onchange: (e: WebDynamic) => onPick(e.target.value),
  },
    grouped ? heading("this project") : null,
    ...project.map(opt),
    grouped ? heading("built in") : null,
    ...builtin.map(opt),
    // A story can name a persona this project doesn't have — one committed as a
    // suite file by the CLI, or one deleted since. Keep it selectable and say
    // so, rather than silently switching the story to a different actor.
    known ? null : h("option", { value, selected: true }, `${value} — not in this project`),
  );
}

/**
 * enhanceSelect hides the native <select> behind a button, and an aria-label on
 * the select does not travel to that button — so a themed dropdown outside a
 * formField (which labels it via `for`) had no accessible name at all. Carry it
 * across. Anything with a real <label> keeps it and is unaffected.
 */
function namedSelect(sel: WebDynamic) {
  const wrap = enhanceSelect(sel);
  const name = sel.getAttribute("aria-label");
  if (name) wrap.querySelector("button")?.setAttribute("aria-label", name);
  return wrap;
}

const managePersonas = (st: WebDynamic) =>
  h("a", {
    href: `/p/${st.projectKey}/personas`,
    // A new tab on purpose: leaving the editor mid-story would lose the draft.
    target: "_blank", rel: "noopener",
    title: "Opens in a new tab so this draft isn't lost",
  }, "Manage personas ↗");

const splitPersonas = (s: WebDynamic) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

function syncFromForm(st: WebDynamic, model: WebDynamic) {
  st.raw = applyModelToText(st.raw, model);
}

/**
 * A missing app URL is a SUITE setting, not something wrong with this story —
 * core's message ("set it in a playtest.yaml, the case file, or pass
 * --base-url") names three fixes, none of which exist on this screen. Say where
 * it actually lives, and link there.
 */
const NO_BASE_URL = /no app\.base_url configured/;
function baseUrlCheck(st: WebDynamic) {
  return h("li.check-item.err", {}, h("span.g", {}, "✗"), h("span.msg", {},
    "This suite has no app URL, so no story in it can resolve. ",
    link(`/p/${st.projectKey}/suites/${st.slug}/settings`, "Set it in Suite settings"),
    " — under hosted execution the ring supplies it at launch instead."));
}

function renderChecks(validation: WebDynamic, findings: WebDynamic, st: WebDynamic) {
  const items: WebDynamic = [];
  if (validation.ok) items.push(checkItem("ok", "✓", "valid story"));
  else for (const e of validation.errors || []) {
    if (st && NO_BASE_URL.test(e.message || "")) items.push(baseUrlCheck(st));
    else items.push(checkItem("err", "✗", e.path ? `${e.path}: ${e.message}` : e.message));
  }
  for (const f of findings || []) items.push(checkItem("warn", "⚠", `lint: ${f.message}`));
  if (!items.length) items.push(checkItem("ok", "✓", "no issues"));
  return h("ul.check-list", {}, ...items);
}

const checkItem = (cls: WebDynamic, glyph: WebDynamic, msg: WebDynamic) => h(`li.check-item.${cls}`, {}, h("span.g", {}, glyph), h("span.msg", {}, msg));
const fieldBlock = formField;
const caseIdFromPath = (p: WebDynamic) => String(p || "").replace(/\.ya?ml$/, "").replace(/^stories\//, "");

/**
 * A new story's file, derived from what the person actually wrote: the
 * description if there is one, else the first line of the story. The path is
 * the story's ID (core drops a leading `stories/` and the .yaml — see
 * config.ts), so this is really "what is this story called", asked in the only
 * words the author is already using.
 */
function derivedPath(st: WebDynamic) {
  let model;
  try { model = toModel(parseYaml(st.raw)); } catch { return null; }
  const source = (model.description || "").trim()
    || String(model.story || "").split("\n").map((l) => l.trim()).find(Boolean)
    || "";
  const name = storySlug(source);
  return name ? `stories/${name}.yaml` : null;
}

const storySlug = (s: WebDynamic) => String(s).toLowerCase().normalize("NFKD")
  .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);

/**
 * Download this story's accepted saved path as a standalone Playwright spec.
 *
 * A ONE-WAY export (docs/contracts/interfaces.md#playwright-export): the file is
 * an escape hatch and an inspection tool, never something Playtest reads back.
 * The toast says so, and repeats whatever the generator could not assert —
 * finding out about an unchecked criterion by reading the file later is exactly
 * the surprise this feature exists to prevent.
 */
async function exportPlaywright(st: WebDynamic, btn: WebDynamic) {
  const storyId = st.caseId || caseIdFromPath(st.path);
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Exporting…"; }
  try {
    const res = await fetch(`/api/v1/suites/${st.suiteId}/playwright-export?story=${encodeURIComponent(storyId)}`);
    if (!res.ok) {
      const envelope = await res.json().catch(() => ({}));
      throw new ApiError(res.status, envelope);
    }
    // Notes ride in a base64 header so we can report them without re-parsing the
    // spec we just downloaded.
    let notes: WebDynamic = [];
    try {
      const raw = res.headers.get("x-playtest-export-notes");
      if (raw) notes = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0))));
    } catch {}

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${storyId.split("/").pop()}.spec.ts`;
    a.click();
    URL.revokeObjectURL(url);

    // Every note is ALSO a visible comment at that point in the file, so name the
    // count and point there — a long list would outlive the toast that carries it.
    const contract = "One-way: Playtest never reads this file back and will not heal it.";
    const lossy = notes.length
      ? ` ${notes.length} ${notes.length === 1 ? "criterion" : "criteria"} could not be asserted — each is a comment in the file.`
      : "";
    toast(`Exported ${a.download}`, contract + lossy);
  } catch (err: WebDynamic) {
    toastError(err, "Could not export this story");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}
