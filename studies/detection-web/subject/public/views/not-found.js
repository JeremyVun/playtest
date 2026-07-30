// Friendly dead end for an unknown address.

import { el, frag } from "../lib/dom.js";
import { emptyState, pageHead } from "../lib/ui.js";

export async function render(ctx) {
  ctx.setTitle("Page not found");
  return frag([
    pageHead("Page not found", "That address is not part of the lending desk."),
    emptyState(
      "Nothing lives at this address",
      "Check the link, or start again from the desk overview.",
      el("a", { class: "button button--primary", href: "/", text: "Go to desk overview" }),
    ),
  ]);
}
