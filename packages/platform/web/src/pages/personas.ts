// Personas — who Playtest pretends to be while it works through a story.
//
// A persona is PROJECT-wide: every suite in the project can name it, and the
// story editor's picker offers exactly what this page lists. Two tiers, and the
// difference is visible rather than implied: the three system personas ship with
// the engine and are read-only (their prose is a contract other things assert
// against), while project personas are yours to write, edit and delete.
//
// The description is not a note to your team — it is the text the actor is given
// as its `## Persona` prompt section, verbatim. The form says so, because a
// person who thinks they are writing documentation writes the wrong thing.
//
// SHAPE: a grid of cards, each one a single control, with the prompt CLAMPED to
// a preview. The page used to print every persona's full prompt inline in a
// stack of full-width cards — five slabs of dim grey text, ~2000 words, with a
// row of Edit/Delete/Copy buttons floating in the dead space beside them. You
// could not answer "which personas does this project have" without reading all
// of it, and the loudest thing on the screen was a red Delete on a browse page.
// Now the card is the summary, the dialog is the full text, and every
// destructive action lives behind the dialog you already had to open.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { page } from "../lib/shell.js";
import { hasRole } from "../lib/state.js";
import { toast, toastError, confirmModal, formModal, errorState, formField } from "../lib/ui.js";
import { projectPage } from "../lib/project-page.js";

export async function personasPage(projectKey: WebDynamic) {
  const context = projectPage(projectKey, { nav: "personas", title: "Personas" });
  if (!context) return;
  const { main, project } = context;

  let items;
  try {
    ({ items } = await api.get(`/projects/${projectKey}/personas`));
  } catch (err: WebDynamic) {
    return mount(main, page({ title: "Personas", body: errorState(err, () => personasPage(projectKey)) }));
  }

  const canEdit = hasRole(project.id, "editor");
  const refresh = () => personasPage(projectKey);
  const ctx: WebDynamic = { projectKey, canEdit, refresh };
  const builtin = items.filter((p: WebDynamic) => p.builtin);
  const custom = items.filter((p: WebDynamic) => !p.builtin);

  mount(main, page({
    title: "Personas",
    sub: "Who the actor pretends to be while it works through a story. Every suite in this project can name any of these.",
    actions: canEdit
      ? [h("button.btn.primary", { onclick: () => personaModal(ctx, null) }, "+ New persona")]
      : null,
    body: h("div", {},
      section(
        "Yours",
        custom.length,
        "Written by your team. The text you write is handed to the actor verbatim as its persona prompt.",
        h("div.persona-grid", {},
          ...custom.map((p: WebDynamic) => personaCard(p, ctx)),
          // The add affordance is a CELL of the grid, not a second hero button
          // and not an empty state hanging in a void: it reads the same whether
          // this section has nothing in it or a dozen, and it carries the one
          // sentence that says when writing your own is the right move.
          canEdit ? addCard(ctx) : null,
          canEdit || custom.length ? null : h("p.dim", {}, "None yet — an editor on this project can write one."),
        ),
      ),
      section(
        "Built in",
        builtin.length,
        "Shipped with the engine and identical in every project. They can't be edited — copy one to make a variation.",
        h("div.persona-grid", {}, ...builtin.map((p: WebDynamic) => personaCard(p, ctx))),
      ),
    ),
  }));
}

const section = (title: WebDynamic, count: WebDynamic, gloss: WebDynamic, ...body: WebDynamic) =>
  h("section.persona-section", {},
    h("div.section-head", {},
      h("h2.section-title", {}, title, h("span.count", {}, String(count))),
      h("p.section-gloss", {}, gloss),
    ),
    ...body);

/**
 * One persona, as a single control.
 *
 * The whole card is the button and its accessible name says what opening it
 * does, so there is exactly one tab stop and one unambiguous label per persona —
 * an improvement on the three same-shaped buttons per row this replaced, where
 * "Edit"/"Delete"/"Copy" repeated five times down the page.
 */
function personaCard(p: WebDynamic, ctx: WebDynamic) {
  const editable = !p.builtin && ctx.canEdit;
  const cue = editable ? "Edit" : "View";
  return h("button.card.persona-card", {
    type: "button",
    "aria-label": `${cue} the ${p.name} persona`,
    onclick: () => (editable ? personaModal(ctx, p) : readModal(p, ctx)),
  },
    h("div.pc-head", {},
      h("span.pc-name", {}, p.name),
      h("span.pc-cue", { "aria-hidden": "true" }, cue),
    ),
    h("div.pc-meta", {},
      // The slug is what a story's `persona:` key says, so it is the part worth
      // being able to read — shown as the line a story would actually contain
      // rather than as a decorative badge.
      h("span.slug", {}, `persona: ${p.slug}`),
      // Prompt length is a real signal (it is tokens the actor carries on every
      // turn), and it sets expectations for how much the dialog will hold.
      h("span", {}, "·"),
      h("span", {}, `${wordCount(p.description)} words`),
    ),
    h("p.pc-prose", {}, preview(p.description)),
  );
}

function addCard(ctx: WebDynamic) {
  return h("button.card.persona-add", {
    type: "button",
    onclick: () => personaModal(ctx, null),
  },
    h("span.pa-title", {}, "Write a persona"),
    h("span.pa-why", {}, "For a user the built-ins don't describe — a franchise owner with three stores, an admin who lives in the bulk-edit screen, someone on a phone in a warehouse."),
  );
}

/**
 * Read-only view of a built-in: the full prompt, and the one action that is
 * available on it. Built-ins used to offer a lone "Copy" button beside a wall of
 * their own text, which made the text the surface and the action an afterthought.
 */
function readModal(p: WebDynamic, ctx: WebDynamic) {
  formModal(p.name, (close: WebDynamic) =>
    h("div.persona-read", {},
      h("div.pr-meta", {},
        // Also the view a VIEWER gets for a project persona — they can read one
        // but not edit it — so the tier is stated from the data, not assumed.
        p.builtin ? h("span.chip", {}, "built in") : null,
        h("span.slug", {}, `persona: ${p.slug}`),
      ),
      h("div.pr-prose", {}, ...paragraphs(p.description).map((t) => h("p", {}, t))),
      h("div.modal-actions", {},
        h("button.btn.ghost", { onclick: () => close() }, "Close"),
        ctx.canEdit && p.builtin
          ? h("button.btn.primary", {
              title: "Start a new project persona from this one's text",
              onclick: () => {
                close();
                personaModal(ctx, null, { name: `${p.name} (copy)`, description: p.description });
              },
            }, "Make a copy")
          : null,
      ),
    ));
}

/**
 * Create / edit. Three changes from the form this replaces:
 *
 *  - The lead sentence moved ABOVE the fields. Told underneath a 200px textarea,
 *    "this text becomes the prompt" arrives after the person has already decided
 *    what to type.
 *  - The slug stopped being a field. It is derived from the name (the same
 *    bargain the project and suite dialogs strike), so a mandatory-looking third
 *    input sat between the two that matter, asking for an opinion nobody has on
 *    their first persona. It is now a live receipt under Name — and on an
 *    existing persona a fact, not a disabled input, because a control you cannot
 *    operate reads as permissions you don't have and never says why. There is no
 *    override: the server accepts an explicit `slug`, but a dialog offering to
 *    decouple the word stories spell from the name on the card is a way to
 *    confuse yourself, not a feature.
 *  - Delete lives here, not on the browse page.
 */
function personaModal(ctx: WebDynamic, existing: WebDynamic, seed: WebDynamic = null) {
  formModal(existing ? existing.name : "New persona", (close: WebDynamic) => {
    const name = h("input", { type: "text", value: existing?.name ?? seed?.name ?? "", placeholder: "Warehouse picker" });
    const description = h("textarea.prose-input", {
      placeholder: "You are on your feet in a warehouse, working one-handed on a phone with gloves on. You scan first and read second…",
    }, existing?.description ?? seed?.description ?? "");

    // A live receipt, not a question — the same bargain the project dialog
    // strikes with its URL key. The person picks a display name and this is the
    // word their stories will actually have to spell.
    const slugPreview = h("span.mono", {});
    const paintSlug = () => { slugPreview.textContent = `persona: ${slugify(name.value) || "…"}`; };
    if (!existing) {
      name.addEventListener("input", paintSlug);
      paintSlug();
    }

    const save = h("button.btn.primary", { type: "submit" }, existing ? "Save" : "Create persona");

    return h("form.persona-form", { onsubmit: submit },
      h("p.lead", {},
        "A persona is prose written to the actor in the second person. This exact text becomes its persona prompt, so describe how this user ",
        h("b", {}, "behaves"),
        " — what they notice, what they skip, when they give up — not who they are on an org chart.",
      ),
      formField("Name", name, existing
        // Immutable, so it is stated rather than offered: a greyed-out input
        // reads as permissions you don't have, and never says why.
        ? h("span", {}, "Stories reference it as ", h("span.mono", {}, `persona: ${existing.slug}`),
            " — that word can't change, because stories point at it.")
        // No trailing full stop: the sentence ends in the receipt itself, which
        // reads "persona: …" until a name is typed.
        : h("span", {}, "Stories will reference it as ", slugPreview)),
      formField("Description", description, null),
      h(`div.modal-actions${existing ? ".split" : ""}`, {},
        existing
          ? h("button.btn.danger", { type: "button", onclick: () => { close(); del(existing, ctx); } }, "Delete")
          : null,
        h("div.right", {},
          h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"),
          save,
        ),
      ),
    );

    async function submit(e: WebDynamic) {
      e.preventDefault();
      // No `slug` in the payload: the server derives it from the name with the
      // identical rule slugify() previews. A collision comes back as a 409 whose
      // message already says what to do ("a persona named X already exists",
      // "X is a built-in persona — choose another name").
      const body: WebDynamic = { name: name.value.trim(), description: description.value.trim() };
      if (!body.name) return toast("This persona needs a name", "", "err");
      if (!body.description) {
        return toast("This persona needs a description", "it is the text the actor is given — an empty one describes nobody", "err");
      }
      save.disabled = true;
      try {
        if (existing) await api.put(`/personas/${existing.id}`, body);
        else await api.post(`/projects/${ctx.projectKey}/personas`, body);
        toast(existing ? "Persona saved" : "Persona created", body.name, "ok");
        close();
        ctx.refresh();
      } catch (err: WebDynamic) {
        save.disabled = false;
        toastError(err);
      }
    }
  });
}

/**
 * Deleting a persona can break stories that name it: core resolves `persona:` at
 * RUN time, so a story pointing at a deleted persona keeps validating and then
 * fails when it next runs. Say that plainly — this is the whole content of the
 * warning, not a generic "are you sure".
 */
async function del(p: WebDynamic, ctx: WebDynamic) {
  const ok = await confirmModal({
    title: `Delete the ${p.name} persona?`,
    body: `Any story whose persona: key says "${p.slug}" will keep saving fine and then fail the next time it runs, because the persona won't resolve. Check your stories first if you're not sure.`,
    confirmLabel: "Delete persona",
    cancelLabel: "Keep it",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/personas/${p.id}`);
    toast("Persona deleted", p.name, "ok");
    ctx.refresh();
  } catch (err: WebDynamic) {
    toastError(err);
  }
}

/**
 * Prompt files are hard-wrapped — the three built-ins ship wrapped at ~75
 * columns — so their single newlines are an artifact of the file, not the
 * author's paragraphing. Rendering them with `white-space: pre-wrap` inside a
 * narrower column wrapped already-wrapped text and produced the ragged,
 * unreadable right edge that made this page look broken. Fold single newlines
 * back into spaces for DISPLAY and keep blank lines as the paragraph breaks
 * someone actually meant; the textarea still edits the exact stored bytes.
 */
export function paragraphs(text: WebDynamic) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((para) => para.replace(/\n[ \t]*/g, " ").trim())
    .filter(Boolean);
}

/** The card teaser: one reflowed run of text for the CSS line clamp to cut. */
const preview = (text: WebDynamic) => paragraphs(text).join(" ");

const wordCount = (text: WebDynamic) => (String(text || "").trim().match(/\S+/g) || []).length;

/**
 * Character-for-character the server's `deriveSlug` (control-plane
 * api/personas.ts), including the trailing-hyphen trim AFTER the 50-char cut —
 * a preview that disagrees with what gets saved is worse than no preview.
 */
export const slugify = (s: WebDynamic) => String(s || "").normalize("NFKD")
  .replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/g, "");
