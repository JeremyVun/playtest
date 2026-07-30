// All loans, filtered by status and borrower search.

import { get } from "../lib/api.js";
import { el, frag } from "../lib/dom.js";
import { dateLong, money, units } from "../lib/format.js";
import { emptyState, pageHead, statusPill } from "../lib/ui.js";

const STATUS_OPTIONS = [
  ["all", "All loans"],
  ["pending_approval", "Awaiting approval"],
  ["ready", "Ready for pickup"],
  ["out", "Out"],
  ["overdue", "Overdue"],
  ["returned", "Returned"],
  ["cancelled", "Cancelled"],
  ["declined", "Declined"],
];

function searchString(values) {
  const params = new URLSearchParams();
  if (values.status && values.status !== "all") params.set("status", values.status);
  if (values.q) params.set("q", values.q);
  const search = params.toString();
  return search ? `?${search}` : "";
}

export async function render(ctx) {
  ctx.setTitle("Loans");

  const current = {
    status: STATUS_OPTIONS.some(([value]) => value === ctx.query.status) ? ctx.query.status : "all",
    q: ctx.query.q || "",
  };
  const data = await get(`/api/loans${searchString(current)}`);

  const statusSelect = el(
    "select",
    { id: "loan-status", name: "status" },
    STATUS_OPTIONS.map(([value, label]) =>
      el("option", { value, selected: value === current.status, text: label }),
    ),
  );

  const searchInput = el("input", {
    type: "text",
    id: "loan-search",
    name: "q",
    value: current.q,
    placeholder: "Loan number or borrower",
  });

  const form = el(
    "form",
    {
      class: "card",
      "aria-label": "Filter loans",
      onsubmit: (event) => {
        event.preventDefault();
        ctx.navigate(
          `/loans${searchString({ status: statusSelect.value, q: searchInput.value.trim() })}`,
        );
      },
    },
    [
      el("div", { class: "filter-bar" }, [
        el("div", { class: "field" }, [
          el("label", { for: "loan-status", text: "Status" }),
          statusSelect,
        ]),
        el("div", { class: "field" }, [
          el("label", { for: "loan-search", text: "Search" }),
          searchInput,
        ]),
        el("button", { class: "button button--primary", type: "submit", text: "Apply filters" }),
        el("a", { class: "button", href: "/loans", text: "Clear filters" }),
      ]),
    ],
  );

  const summary = el("p", {
    class: "muted",
    role: "status",
    text: `Showing ${data.shownCount} of ${data.totalCount} loans.`,
  });

  const results = data.loans.length
    ? el("div", { class: "card" }, [
        el("table", {}, [
          el("caption", { text: "Newest loan first." }),
          el("thead", {}, [
            el("tr", {}, [
              el("th", { scope: "col", text: "Loan" }),
              el("th", { scope: "col", text: "Borrower" }),
              el("th", { scope: "col", text: "Items" }),
              el("th", { scope: "col", text: "Status" }),
              el("th", { scope: "col", text: "Pickup" }),
              el("th", { scope: "col", text: "Due" }),
              el("th", { scope: "col", class: "numeric", text: "Total due" }),
            ]),
          ]),
          el(
            "tbody",
            {},
            data.loans.map((loan) =>
              el("tr", {}, [
                el("td", {}, [el("a", { href: `/loans/${loan.id}`, text: loan.id })]),
                el("td", {}, [
                  el("div", { text: loan.borrowerName }),
                  el("div", { class: "small muted", text: loan.department }),
                ]),
                el("td", { text: `${loan.itemsLabel} (${units(loan.unitCount)})` }),
                el("td", {}, [statusPill(loan)]),
                el("td", { text: dateLong(loan.pickupDate) }),
                el("td", { text: dateLong(loan.dueDate) }),
                el("td", { class: "numeric", text: money(loan.totalDueCents) }),
              ]),
            ),
          ),
        ]),
      ])
    : emptyState(
        "No loans match these filters",
        current.q
          ? `Nothing matches “${current.q}” with the status you picked.`
          : "No loan currently has that status.",
        el("a", { class: "button", href: "/loans", text: "Clear filters" }),
      );

  return frag([
    pageHead("Loans", "Every request the desk has taken, newest first", [
      el("a", { class: "button button--primary", href: "/new-loan", text: "Start a new loan" }),
    ]),
    form,
    el("div", { style: "margin-top:1.25rem" }, [summary, results]),
  ]);
}
