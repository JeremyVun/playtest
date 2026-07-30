// Equipment catalogue with search, category filter and availability filter.

import { get } from "../lib/api.js";
import { el, frag } from "../lib/dom.js";
import { money } from "../lib/format.js";
import { emptyState, pageHead } from "../lib/ui.js";

function searchString(values) {
  const params = new URLSearchParams();
  if (values.q) params.set("q", values.q);
  if (values.category && values.category !== "All") params.set("category", values.category);
  if (values.availableOnly) params.set("availableOnly", "1");
  const search = params.toString();
  return search ? `?${search}` : "";
}

export async function render(ctx) {
  ctx.setTitle("Equipment");

  const current = {
    q: ctx.query.q || "",
    category: ctx.query.category || "All",
    availableOnly: ctx.query.availableOnly === "1",
  };

  const data = await get(`/api/equipment${searchString(current)}`);
  const categories = ctx.session ? ctx.session.categories : [];

  const searchInput = el("input", {
    type: "text",
    id: "equipment-search",
    name: "q",
    value: current.q,
    placeholder: "Name, asset tag or description",
  });

  const categorySelect = el(
    "select",
    { id: "equipment-category", name: "category" },
    ["All", ...categories].map((category) =>
      el("option", { value: category, selected: category === current.category, text: category }),
    ),
  );

  const availableCheckbox = el("input", {
    type: "checkbox",
    id: "equipment-available",
    name: "availableOnly",
    checked: current.availableOnly,
  });

  const form = el(
    "form",
    {
      class: "card",
      "aria-label": "Filter equipment",
      onsubmit: (event) => {
        event.preventDefault();
        ctx.navigate(
          `/equipment${searchString({
            q: searchInput.value.trim(),
            category: categorySelect.value,
            availableOnly: availableCheckbox.checked,
          })}`,
        );
      },
    },
    [
      el("div", { class: "filter-bar" }, [
        el("div", { class: "field" }, [
          el("label", { for: "equipment-search", text: "Search equipment" }),
          searchInput,
        ]),
        el("div", { class: "field" }, [
          el("label", { for: "equipment-category", text: "Category" }),
          categorySelect,
        ]),
        el("div", { class: "field check-row" }, [
          el("label", { for: "equipment-available" }, [availableCheckbox, " Available now only"]),
        ]),
        el("button", { class: "button button--primary", type: "submit", text: "Apply filters" }),
        el("a", { class: "button", href: "/equipment", text: "Clear filters" }),
      ]),
    ],
  );

  const summary = el("p", {
    class: "muted",
    role: "status",
    text: `Showing ${data.shownCount} of ${data.totalCount} equipment items.`,
  });

  let results;
  if (data.items.length === 0) {
    results = emptyState(
      "No equipment matches these filters",
      current.q
        ? `Nothing in the catalogue matches “${current.q}”.`
        : "No catalogue item matches the filters you picked.",
      el("a", { class: "button", href: "/equipment", text: "Clear filters" }),
    );
  } else {
    results = el("div", { class: "card" }, [
      el("table", {}, [
        el("caption", { text: "Daily rate is charged to the borrower's department." }),
        el("thead", {}, [
          el("tr", {}, [
            el("th", { scope: "col", text: "Item" }),
            el("th", { scope: "col", text: "Category" }),
            el("th", { scope: "col", text: "Availability" }),
            el("th", { scope: "col", class: "numeric", text: "Daily rate" }),
            el("th", { scope: "col", class: "numeric", text: "Deposit per unit" }),
          ]),
        ]),
        el(
          "tbody",
          {},
          data.items.map((item) =>
            el("tr", {}, [
              el("td", {}, [
                el("a", { href: `/equipment/${item.id}`, text: item.name }),
                el("div", { class: "small muted", text: item.tag }),
              ]),
              el("td", { text: item.category }),
              el("td", {}, [
                item.availableUnits === 0
                  ? el("span", { class: "pill pill--overdue", text: "Fully booked" })
                  : el("span", { text: `${item.availableUnits} of ${item.totalUnits} available` }),
              ]),
              el("td", { class: "numeric", text: `${money(item.dailyRateCents)} / day` }),
              el("td", {
                class: "numeric",
                text: item.depositPerUnitCents ? money(item.depositPerUnitCents) : "None",
              }),
            ]),
          ),
        ),
      ]),
    ]);
  }

  return frag([
    pageHead("Equipment", "Everything the Kessler desk lends out", [
      el("a", { class: "button button--primary", href: "/new-loan", text: "Start a new loan" }),
    ]),
    form,
    el("div", { style: "margin-top:1.25rem" }, [summary, results]),
  ]);
}
