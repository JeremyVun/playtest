// Desk overview: the counts a supervisor checks at the start of a shift.

import { get } from "../lib/api.js";
import { el, frag } from "../lib/dom.js";
import { dateLong, instant, money, units } from "../lib/format.js";
import { emptyState, pageHead, statusPill } from "../lib/ui.js";

function tile({ label, value, note, href, alert }) {
  const body = [
    el("span", { class: "tile__label", text: label }),
    el("span", { class: "tile__value", text: value }),
    note ? el("span", { class: "tile__note", text: note }) : null,
  ];
  const className = `tile${alert ? " tile--alert" : ""}`;
  return el("li", {}, [
    href ? el("a", { class: className, href }, body) : el("div", { class: className }, body),
  ]);
}

function loanLink(loan) {
  return el("a", { href: `/loans/${loan.id}`, text: loan.id });
}

function table(caption, headings, rows) {
  return el("table", {}, [
    el("caption", { text: caption }),
    el("thead", {}, [
      el(
        "tr",
        {},
        headings.map((heading) =>
          el("th", { scope: "col", class: heading.numeric ? "numeric" : null, text: heading.label }),
        ),
      ),
    ]),
    el("tbody", {}, rows),
  ]);
}

export async function render(ctx) {
  ctx.setTitle("Desk overview");
  const data = await get("/api/overview");
  const m = data.metrics;
  const deskDate = ctx.session ? ctx.session.deskTime.date : null;

  const head = pageHead(
    "Desk overview",
    deskDate ? `Desk day ${dateLong(deskDate)}` : null,
    [el("a", { class: "button button--primary", href: "/new-loan", text: "Start a new loan" })],
  );

  const tiles = el("ul", { class: "tiles" }, [
    tile({
      label: "Out on loan",
      value: String(m.outCount),
      note: "Currently with borrowers",
      href: "/loans?status=out",
    }),
    tile({
      label: "Overdue",
      value: String(m.overdueCount),
      note: "Past the 17:00 due time",
      href: "/loans?status=overdue",
      alert: m.overdueCount > 0,
    }),
    tile({
      label: "Due back today",
      value: String(m.dueTodayCount),
      note: "Expected at the desk by 17:00",
    }),
    tile({
      label: "Awaiting approval",
      value: String(m.awaitingApprovalCount),
      note: "Needs a supervisor decision",
      href: "/approvals",
    }),
    tile({
      label: "Ready for pickup",
      value: String(m.readyForPickupCount),
      note: "Approved and waiting on the shelf",
      href: "/loans?status=ready",
    }),
    tile({
      label: "Units available",
      value: String(m.unitsAvailable),
      note: `of ${m.unitsTotal} units in the catalogue`,
      href: "/equipment?availableOnly=1",
    }),
    tile({
      label: "Charges booked today",
      value: money(m.chargesBookedTodayCents),
      note: "New loans and late fees",
    }),
  ]);

  const overdueSection = el("section", { class: "card", "aria-labelledby": "overdue-heading" }, [
    el("div", { class: "card__head" }, [
      el("h2", { id: "overdue-heading", text: "Overdue loans" }),
      el("a", { class: "small", href: "/loans?status=overdue", text: "Open in loans" }),
    ]),
    data.overdue.length
      ? table(
          "Late fees shown are what the borrower owes if the kit comes back today.",
          [
            { label: "Loan" },
            { label: "Borrower" },
            { label: "Items" },
            { label: "Due" },
            { label: "Business days late", numeric: true },
            { label: "Late fee today", numeric: true },
          ],
          data.overdue.map((loan) =>
            el("tr", {}, [
              el("td", {}, [loanLink(loan)]),
              el("td", { text: loan.borrowerName }),
              el("td", { text: `${loan.itemsLabel} (${units(loan.unitCount)})` }),
              el("td", { text: dateLong(loan.dueDate) }),
              el("td", { class: "numeric", text: String(loan.lateBusinessDays) }),
              el("td", { class: "numeric", text: money(loan.lateFeePreviewCents) }),
            ]),
          ),
        )
      : emptyState("No overdue loans", "Every loan that is out is still within its due date."),
  ]);

  const dueTodaySection = el("section", { class: "card", "aria-labelledby": "due-today-heading" }, [
    el("div", { class: "card__head" }, [
      el("h2", { id: "due-today-heading", text: "Due back today" }),
    ]),
    data.dueToday.length
      ? table(
          "Expected at the desk before the 17:00 cut-off.",
          [{ label: "Loan" }, { label: "Borrower" }, { label: "Items" }, { label: "Due" }],
          data.dueToday.map((loan) =>
            el("tr", {}, [
              el("td", {}, [loanLink(loan)]),
              el("td", { text: loan.borrowerName }),
              el("td", { text: `${loan.itemsLabel} (${units(loan.unitCount)})` }),
              el("td", { text: instant(loan.dueAt) }),
            ]),
          ),
        )
      : emptyState("Nothing due today", "No loan reaches its due date on this desk day."),
  ]);

  const readySection = el("section", { class: "card", "aria-labelledby": "ready-heading" }, [
    el("div", { class: "card__head" }, [
      el("h2", { id: "ready-heading", text: "Ready for pickup" }),
      el("a", { class: "small", href: "/loans?status=ready", text: "Open in loans" }),
    ]),
    data.readyForPickup.length
      ? table(
          "Approved loans waiting for the borrower to collect.",
          [{ label: "Loan" }, { label: "Borrower" }, { label: "Items" }, { label: "Pickup" }],
          data.readyForPickup.map((loan) =>
            el("tr", {}, [
              el("td", {}, [loanLink(loan)]),
              el("td", { text: loan.borrowerName }),
              el("td", { text: `${loan.itemsLabel} (${units(loan.unitCount)})` }),
              el("td", { text: dateLong(loan.pickupDate) }),
            ]),
          ),
        )
      : emptyState("No loans waiting for pickup", "Nothing is boxed up on the collection shelf."),
  ]);

  const approvalSection = el("section", { class: "card", "aria-labelledby": "approval-heading" }, [
    el("div", { class: "card__head" }, [
      el("h2", { id: "approval-heading", text: "Awaiting approval" }),
      el("a", { class: "small", href: "/approvals", text: "Open approvals queue" }),
    ]),
    data.awaitingApproval.length
      ? table(
          "Requests held until a supervisor decides.",
          [
            { label: "Loan" },
            { label: "Borrower" },
            { label: "Items" },
            { label: "Status" },
            { label: "Total due", numeric: true },
          ],
          data.awaitingApproval.map((loan) =>
            el("tr", {}, [
              el("td", {}, [loanLink(loan)]),
              el("td", { text: `${loan.borrowerName} · ${loan.department}` }),
              el("td", { text: `${loan.itemsLabel} (${units(loan.unitCount)})` }),
              el("td", {}, [statusPill(loan)]),
              el("td", { class: "numeric", text: money(loan.totalDueCents) }),
            ]),
          ),
        )
      : emptyState("Nothing waiting for approval", "Every request has been decided."),
  ]);

  return frag([
    head,
    tiles,
    el("div", { class: "grid-2" }, [overdueSection, dueTodaySection]),
    el("div", { class: "grid-2", style: "margin-top:1.25rem" }, [readySection, approvalSection]),
  ]);
}
