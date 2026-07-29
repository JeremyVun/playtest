// A model choice as a dropdown, not prose. The vocabulary is small and shipped
// (the /models tier list), inheriting is the common case and must be a visible
// selected state — "Project default — sonnet", never an empty text box — and
// the qualified-gateway-name pass-through stays available behind an explicit
// "Custom model name…" option instead of being the whole control. Shared by
// Settings → Models (project) and Suite settings (suite); the callers own what
// "inherit" resolves to and what a change does.
import { h } from "./dom.js";
import { formField } from "./ui.js";

const CUSTOM = "__custom__";

/**
 * One labeled model field: an enhanced dropdown of `[inherit, ...tiers,
 * custom]`, with a name input revealed only while "custom" is chosen.
 * `onchange(value|null)` fires with a tier, a trimmed custom name, or null for
 * "inherit — clear my choice"; picking "custom" alone fires nothing, because an
 * intention is not yet a value. With no tiers (the catalog fetch failed) the
 * field degrades to a plain text input rather than an empty menu.
 * @param {{ label: string, hint: any, value?: string, tiers?: string[],
 *           inheritLabel?: string, onchange: (value: string|null) => void }} opts
 * @returns {HTMLElement} a `div.field`
 */
export function modelField({ label, hint, value = "", tiers = [], inheritLabel = "Default", onchange }: WebDynamic) {
  const current = (value || "").trim();
  if (!tiers.length) {
    // Degraded and SAYS so: a bare text box that looks like the intended UI
    // hides the real problem (the /models catalog didn't load — usually a
    // server running older code, or a failed fetch).
    return formField(label, h("input", {
      type: "text", value: current,
      "aria-label": label,
      onchange: (e: WebDynamic) => onchange(e.target.value.trim() || null),
    }), h("span", {}, hint, " ",
      h("span.warn", {}, "The model list couldn't be loaded from the server, so this is a plain name field — blank inherits the default.")));
  }
  const isCustom = Boolean(current) && !tiers.includes(current);
  const custom = h("input", {
    type: "text",
    value: isCustom ? current : "",
    placeholder: "a qualified gateway model name, e.g. us.anthropic.claude-opus-4-8",
    "aria-label": `${label} — custom gateway model name`,
    style: `margin-top:8px${isCustom ? "" : ";display:none"}`,
    onchange: (e: WebDynamic) => {
      const v = e.target.value.trim();
      if (!v) {
        // An empty custom name is not a choice — fall back to inherit, through
        // the select so its button relabels too.
        sel.value = "";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
      onchange(v);
    },
  });
  const sel = h("select", {
    onchange: () => {
      if (sel.value === CUSTOM) {
        custom.style.display = "";
        custom.focus();
        return; // not a value yet — nothing changes until a name is typed
      }
      custom.style.display = "none";
      custom.value = "";
      onchange(sel.value || null);
    },
  },
    h("option", { value: "", selected: !current || undefined }, inheritLabel),
    ...tiers.map((t: WebDynamic) => h("option", { value: t, selected: t === current || undefined }, t)),
    h("option", { value: CUSTOM, selected: isCustom || undefined }, "Custom model name…"),
  );
  const field = formField(label, sel, hint);
  // The dropdown and the name it may reveal are ONE control, so they are one
  // element: stacked, they look the same as they always did, but a layout that
  // gives the answer a column of its own (Settings → Models) gets a single
  // thing to put there instead of two children to place separately.
  const box = h("div.field-control", {});
  const enhanced = field.querySelector(".selectw");
  field.insertBefore(box, enhanced);
  box.append(enhanced, custom);
  return field;
}
