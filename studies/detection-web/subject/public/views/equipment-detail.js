// One catalogue item: what it is, how many units are free, and who holds the rest.

import { get } from "../lib/api.js";
import { el, frag } from "../lib/dom.js";
import { dateLong, money } from "../lib/format.js";
import { emptyState, pageHead, statusPill, summaryList } from "../lib/ui.js";

export async function render(ctx) {
  const data = await get(`/api/equipment/${encodeURIComponent(ctx.params.id)}`);
  const item = data.item;
  ctx.setTitle(item.name);

  const facts = summaryList([
    ["Asset tag", el("span", { text: item.tag })],
    ["Category", el("span", { text: item.category })],
    [
      "Availability",
      el("span", {
        text:
          item.availableUnits === 0
            ? `Fully booked — 0 of ${item.totalUnits} units free`
            : `${item.availableUnits} of ${item.totalUnits} units free`,
      }),
    ],
    ["Daily rate", el("span", { text: `${money(item.dailyRateCents)} per unit per day` })],
    ["Replacement value", el("span", { text: money(item.replacementValueCents) })],
    [
      "Deposit per unit",
      el("span", {
        text: item.depositPerUnitCents
          ? `${money(item.depositPerUnitCents)} (refundable)`
          : "No deposit required",
      }),
    ],
  ]);

  const specs = el("table", {}, [
    el("caption", { text: "What comes in the case." }),
    el(
      "tbody",
      {},
      item.specs.map((spec) =>
        el("tr", {}, [el("th", { scope: "row", text: spec.label }), el("td", { text: spec.value })]),
      ),
    ),
  ]);

  const holders = item.holders.length
    ? el("table", {}, [
        el("caption", { text: "Open loans holding units of this item." }),
        el("thead", {}, [
          el("tr", {}, [
            el("th", { scope: "col", text: "Loan" }),
            el("th", { scope: "col", text: "Borrower" }),
            el("th", { scope: "col", class: "numeric", text: "Units" }),
            el("th", { scope: "col", text: "Status" }),
            el("th", { scope: "col", text: "Due" }),
          ]),
        ]),
        el(
          "tbody",
          {},
          item.holders.map((holder) =>
            el("tr", {}, [
              el("td", {}, [el("a", { href: `/loans/${holder.id}`, text: holder.id })]),
              el("td", { text: holder.borrowerName }),
              el("td", { class: "numeric", text: String(holder.quantity) }),
              el("td", {}, [statusPill(holder)]),
              el("td", { text: dateLong(holder.dueDate) }),
            ]),
          ),
        ),
      ])
    : emptyState("All units are on the shelf", "No open loan is holding this item right now.");

  return frag([
    el("p", { class: "breadcrumb" }, [
      el("a", { href: "/equipment", text: "Equipment" }),
      " / ",
      el("span", { text: item.name }),
    ]),
    pageHead(item.name, item.description, [
      el("a", { class: "button button--primary", href: "/new-loan", text: "Start a new loan" }),
    ]),
    el("div", { class: "grid-2" }, [
      el("section", { class: "card", "aria-labelledby": "facts-heading" }, [
        el("h2", { id: "facts-heading", text: "Desk record" }),
        facts,
      ]),
      el("section", { class: "card", "aria-labelledby": "specs-heading" }, [
        el("h2", { id: "specs-heading", text: "Specification" }),
        specs,
      ]),
    ]),
    el("section", { class: "card", "aria-labelledby": "holders-heading" }, [
      el("h2", { id: "holders-heading", text: "On loan now" }),
      holders,
    ]),
  ]);
}
