// Rule cards — Level 1 of the invariant ladder as a review surface
// (docs/contracts/hosted.md, "Rule cards"; DESIGN N6, §7.1).
//
// The page a person spends their two minutes on: the four default checks they
// already have, then the rules Playtest drafted from their document, each one
// approve / not-a-rule / edit / note, plus write-your-own. Every word on it
// lives in lib/rule-cards.js, which the offline gate asserts — the copy is
// governed by S0's disposition (assisted authoring, no zero-knowledge claim)
// and is not a thing to improvise per repaint.
//
// Nothing here can enforce anything. The page's only writes are the ordinary
// card endpoints, and the server's approved-only filter is what actually
// governs; this surface just has to be honest about which state a sentence is
// in and what approving one costs.
//
// Live updates come from the feed (the push channel), never a poll, and a
// repaint restores keyboard focus so someone else's approval cannot steal the
// letter you were typing into a note.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { link, onPageLeave } from "../lib/router.js";
import { renderFrame, page } from "../lib/shell.js";
import { state, hasRole } from "../lib/state.js";
import { toast, toastError, emptyState, errorState, confirmModal, formModal, formField, srOnly } from "../lib/ui.js";
import { subscribeFeed } from "../lib/feed.js";
import {
  COPY,
  bucketCards,
  cardPayload,
  formFromCard,
  level0Label,
  provenanceLine,
  specDeclaration,
  summaryLine,
  validateRuleForm,
} from "../lib/rule-cards.js";

const FEED_TYPES: WebDynamic = [
  "rule_card.proposed",
  "rule_card.approved",
  "rule_card.denied",
  "rule_card.edited",
  "rule_card.added",
  "rule_card.removed",
];

let live: WebDynamic = null;
function stopLive() {
  live?.sub?.stop();
  clearTimeout(live?.timer);
  live = null;
}

/** A repaint must not move the cursor out of a note someone is typing into. */
function withFocus(paint: WebDynamic) {
  const key = document.activeElement?.getAttribute?.("data-fk") || null;
  const start = document.activeElement?.selectionStart ?? null;
  paint();
  if (!key) return;
  const next = document.querySelector(`[data-fk="${CSS.escape(key)}"]`);
  if (!next) return;
  next.focus();
  if (start != null && next.setSelectionRange) {
    try { next.setSelectionRange(start, start); } catch { /* not a text control */ }
  }
}

/** `/p/:key/suites/:slug/rules` */
export async function ruleCardsPage(projectKey: WebDynamic, suiteSlug: WebDynamic) {
  stopLive();
  const main = renderFrame({ projectKey, nav: "suites" });
  const project = state.projectByKey.get(projectKey);
  if (!project) return mount(main, page({ title: COPY.title, body: emptyState("Not found", "No such project.") }));
  mount(main, page({ title: COPY.title, body: h("div.dim", {}, "Loading…") }));

  // Note edits live here so a feed repaint keeps what is being typed.
  const notes: WebDynamic = new Map();
  let suite: WebDynamic = null;
  let data: WebDynamic = null;
  let lastProposal: WebDynamic = null;
  const token: WebDynamic = {};

  live = {
    token,
    timer: null,
    sub: subscribeFeed(projectKey, {
      types: FEED_TYPES,
      onEvent: (event: WebDynamic) => {
        if (live?.token !== token || (suite && event.entity?.suite_id !== suite.id)) return;
        clearTimeout(live.timer);
        live.timer = setTimeout(load, 250);
      },
    }),
  };
  onPageLeave(stopLive);
  await load();

  async function load() {
    try {
      suite = suite ?? (await api.get(`/projects/${projectKey}/suites/${suiteSlug}`));
      data = await api.get(`/suites/${suite.id}/rule-cards`);
      if (live?.token !== token) return;
      withFocus(paint);
    } catch (err: WebDynamic) {
      mount(main, page({ title: COPY.title, body: errorState(err, load) }));
    }
  }

  // ---------------------------------------------------------------- actions

  const canReview = () => hasRole(project.id, "reviewer");
  const canPropose = () => hasRole(project.id, "editor") && data?.can_propose;

  async function act(fn: WebDynamic, message: WebDynamic) {
    try {
      await fn();
      if (message) toast(message);
      await load();
    } catch (err: WebDynamic) {
      toastError(err);
    }
  }

  const approve = (card: WebDynamic) =>
    act(() => api.post(`/rule-cards/${card.id}/approve`, notePatch(card)), `Approved. It will be tested from the next authoring run.`);
  const deny = (card: WebDynamic) => act(() => api.post(`/rule-cards/${card.id}/deny`, notePatch(card)), "Denied. Playtest will not suggest it again.");
  const saveNote = (card: WebDynamic) => act(() => api.patch(`/rule-cards/${card.id}`, notePatch(card)), "Note saved.");

  /** The note the person has typed, if they changed it; otherwise leave it be. */
  function notePatch(card: WebDynamic) {
    if (!notes.has(card.id)) return {};
    return { note: notes.get(card.id) };
  }

  async function remove(card: WebDynamic) {
    if (!(await confirmModal({ title: COPY.form.removeConfirmTitle, body: COPY.form.removeConfirmBody, confirmLabel: COPY.actions.remove, danger: true }))) return;
    await act(() => api.del(`/rule-cards/${card.id}`), "Removed.");
  }

  function openForm(card: WebDynamic) {
    const form: WebDynamic = card ? formFromCard(card) : { statement: "", title: "", applicability: "", exceptions: "", note: "" };
    formModal(card ? COPY.form.editTitle : COPY.form.addTitle, (close: WebDynamic) => {
      const bind = (key: WebDynamic) => ({ value: form[key], oninput: (event: WebDynamic) => { form[key] = event.target.value; } });
      const errors = h("div.dim", { style: "color:var(--fail)" });
      return h("div", {},
        h("p.dim", {}, COPY.form.intro),
        formField(COPY.form.statementLabel, h("textarea", { rows: 3, ...bind("statement") }), COPY.form.statementHint),
        formField(COPY.form.titleLabel, h("input", { type: "text", ...bind("title") })),
        formField(COPY.form.applicabilityLabel, h("textarea", { rows: 2, ...bind("applicability") }), COPY.form.applicabilityHint),
        formField(COPY.form.exceptionsLabel, h("textarea", { rows: 2, ...bind("exceptions") }), COPY.form.exceptionsHint),
        formField(COPY.note.label, h("textarea", { rows: 2, ...bind("note") }), COPY.note.hint),
        h("p.dim", {}, card ? (card.state === "candidate" ? COPY.form.editingIsNotApproving : "") : COPY.form.yoursIsApproved),
        errors,
        h("div.modal-actions", {},
          h("button.btn.ghost", { onclick: close }, "Cancel"),
          h("button.btn.primary", {
            onclick: async () => {
              const problems = validateRuleForm(form);
              if (problems.length) return mount(errors, problems.join(" "));
              const payload = cardPayload(form);
              close();
              await act(
                () => (card ? api.patch(`/rule-cards/${card.id}`, payload) : api.post(`/suites/${suite.id}/rule-cards`, payload)),
                card ? "Saved." : "Added — and approved, because you wrote it.",
              );
            },
          }, card ? COPY.form.submitEdit : COPY.form.submitAdd),
        ),
      );
    });
  }

  function openPropose() {
    const form: WebDynamic = { spec: "", focus: "" };
    formModal(COPY.propose.title, (close: WebDynamic) => {
      const status = h("div.dim");
      const file = h("input", {
        type: "file",
        accept: ".json,.yaml,.yml,application/json,text/yaml",
        onchange: async (event: WebDynamic) => {
          const chosen = event.target.files?.[0];
          if (!chosen) return;
          form.spec = await chosen.text();
          specBox.value = form.spec;
          mount(status, `Loaded ${chosen.name} (${form.spec.length} characters).`);
        },
      });
      const specBox = h("textarea", { rows: 8, spellcheck: "false", oninput: (event: WebDynamic) => { form.spec = event.target.value; } });
      const submit = h("button.btn.primary", {
        onclick: async () => {
          const spec = specDeclaration(form.spec);
          if (!spec) return mount(status, "Paste your OpenAPI document, or choose a file.");
          submit.disabled = true;
          mount(status, COPY.propose.working);
          try {
            lastProposal = await api.post(`/suites/${suite.id}/rule-cards/propose`, { spec, focus: form.focus || undefined });
            close();
            toast(`${lastProposal.cards.length} rule${lastProposal.cards.length === 1 ? "" : "s"} drafted — none approved yet.`);
            await load();
          } catch (err: WebDynamic) {
            submit.disabled = false;
            mount(status, err?.message || "That did not work.");
          }
        },
      }, COPY.propose.submit);
      return h("div", {},
        h("p.dim", {}, COPY.propose.body),
        formField(COPY.propose.specLabel, specBox, COPY.propose.specHint),
        formField("Or choose a file", file),
        formField(COPY.propose.focusLabel, h("input", { type: "text", oninput: (event: WebDynamic) => { form.focus = event.target.value; } }), COPY.propose.focusHint),
        status,
        h("div.modal-actions", {}, h("button.btn.ghost", { onclick: close }, "Cancel"), submit),
      );
    });
  }

  // ----------------------------------------------------------------- render

  function paint() {
    const buckets = bucketCards(data.cards);
    const review = canReview();

    const intro = h("div.card.pad", {},
      h("p", {}, h("strong", {}, COPY.intro.heading), " ", COPY.intro.body),
      h("p.dim", {}, COPY.intro.stakes),
    );

    const level0 = h("div.card.pad", {},
      h("p", {}, h("strong", {}, COPY.level0.heading)),
      h("ul", { style: "margin:6px 0 8px 18px;padding:0" },
        ...data.level_0.map((entry: WebDynamic) => h("li", { title: entry.obligation }, level0Label(entry.policy))),
      ),
      h("p.dim", {}, COPY.level0.limit),
    );

    const proposalNote = lastProposal?.notes
      ? h("div.card.pad", {},
          h("p", {}, h("strong", {}, COPY.propose.notesLabel)),
          h("p.dim", {}, lastProposal.notes),
          ...(lastProposal.warnings ?? []).map((warning: WebDynamic) => h("p.dim", {}, `· ${warning}`)),
        )
      : null;

    const sections: WebDynamic = [];
    for (const key of ["candidate", "approved", "denied"]) {
      const cards = buckets[key];
      if (!cards.length) continue;
      sections.push(
        h("div", {},
          h("h2.section-title", {}, COPY.sections[key].title, " ", h("span.dim", {}, `(${cards.length})`)),
          h("p.dim", {}, COPY.sections[key].blurb),
          h("div.stack", {}, ...cards.map((card: WebDynamic) => ruleCard(card, key, review))),
        ),
      );
    }

    const body = data.cards.length
      ? h("div.stack", {}, intro, level0, proposalNote, ...sections)
      : h("div.stack", {}, intro, level0, proposalNote, emptyState(COPY.empty.title, COPY.empty.body));

    mount(main, page({
      crumbs: [link(`/p/${projectKey}`, "Suites"), " / ", link(`/p/${projectKey}/suites/${suiteSlug}`, suite.name), " / ", COPY.title],
      title: COPY.title,
      sub: summaryLine(data),
      actions: [
        canPropose()
          ? h("button.btn", { "data-fk": "propose", onclick: openPropose }, data.cards.length ? COPY.actions.proposeAgain : COPY.actions.propose)
          : hasRole(project.id, "editor")
            ? h("button.btn", { disabled: true, title: COPY.propose.unavailable }, COPY.actions.propose)
            : null,
        review ? h("button.btn.primary", { "data-fk": "add", onclick: () => openForm(null) }, COPY.actions.add) : null,
      ].filter(Boolean),
      body,
    }));
  }

  function ruleCard(card: WebDynamic, bucket: WebDynamic, review: WebDynamic) {
    const provenance = provenanceLine(card);
    const noteValue = notes.has(card.id) ? notes.get(card.id) : (card.note ?? "");
    const noteChanged = noteValue !== (card.note ?? "");

    const badges = h("div", { style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px" },
      card.origin === "authored" ? h("span.chip", {}, COPY.yoursBadge) : null,
      card.edited ? h("span.chip", { title: `Playtest proposed: ${card.proposed_statement}` }, COPY.editedBadge) : null,
      bucket === "denied" ? h("span.chip.state-muted", {}, COPY.sections.denied.title) : null,
    );

    const noteId = `note-${card.id}`;
    const noteRow = h("div.field", { style: "margin-top:10px" },
      h("label", { for: noteId }, COPY.note.label),
      h("textarea", {
        id: noteId,
        rows: 2,
        "data-fk": `note:${card.id}`,
        value: noteValue,
        disabled: !review,
        oninput: (event: WebDynamic) => notes.set(card.id, event.target.value),
      }),
      h("div.hint", {}, COPY.note.hint),
    );

    const buttons: WebDynamic = [];
    if (review && bucket !== "approved") {
      buttons.push(h("button.btn.primary", {
        "data-fk": `approve:${card.id}`,
        "aria-label": `${bucket === "denied" ? COPY.actions.undeny : COPY.actions.approve}: ${card.statement}`,
        onclick: () => approve(card),
      }, bucket === "denied" ? COPY.actions.undeny : COPY.actions.approve));
    }
    if (review && bucket !== "denied") {
      buttons.push(h("button.btn", {
        "data-fk": `deny:${card.id}`,
        "aria-label": `${COPY.actions.deny}: ${card.statement}`,
        onclick: () => deny(card),
      }, COPY.actions.deny));
    }
    if (review) {
      buttons.push(h("button.btn", { "data-fk": `edit:${card.id}`, "aria-label": `${COPY.actions.edit}: ${card.statement}`, onclick: () => openForm(card) }, COPY.actions.edit));
      if (noteChanged) buttons.push(h("button.btn", { "data-fk": `note-save:${card.id}`, onclick: () => saveNote(card) }, COPY.note.save));
      if (card.origin === "authored") {
        buttons.push(h("button.btn.danger", { "data-fk": `remove:${card.id}`, "aria-label": `${COPY.actions.remove}: ${card.statement}`, onclick: () => remove(card) }, COPY.actions.remove));
      }
    }

    return h("div.card.pad", {},
      badges,
      card.title ? h("p", {}, h("strong", {}, card.title)) : null,
      h("p", {}, card.statement, srOnly(` — ${COPY.sections[bucket].title}`)),
      card.applicability ? h("p.dim", {}, h("strong", {}, "Applies: "), card.applicability) : null,
      card.exceptions ? h("p.dim", {}, h("strong", {}, "Exception: "), card.exceptions) : null,
      provenance ? h("p.dim", { style: "font-size:12.5px" }, provenance) : null,
      review ? noteRow : card.note ? h("p.dim", {}, h("strong", {}, `${COPY.note.label}: `), card.note) : null,
      buttons.length ? h("div", { style: "display:flex;gap:8px;margin-top:10px;flex-wrap:wrap" }, ...buttons) : null,
    );
  }
}
