// One loan: its record, its charges, and every action the desk can take on it.

import { get, post } from "../lib/api.js";
import { clear, el } from "../lib/dom.js";
import { dateLong, days, instant, money, units } from "../lib/format.js";
import { applyErrors, banner, field, runAction, statusPill, summaryList } from "../lib/ui.js";
import { validateCheckin } from "../lib/validate.js";

const CONDITIONS = [
  ["", "Choose a condition"],
  ["good", "Good — ready to lend again"],
  ["damaged", "Damaged"],
  ["missing_parts", "Missing parts"],
];

export async function render(ctx) {
  const root = el("div");
  await paint(null);
  return root;

  async function paint(feedback) {
    const data = await get(`/api/loans/${encodeURIComponent(ctx.params.id)}`);
    const loan = data.loan;
    ctx.setTitle(`Loan ${loan.id}`);

    clear(root);
    if (feedback) root.appendChild(banner(feedback.tone, feedback.message));

    root.appendChild(
      el("p", { class: "breadcrumb" }, [
        el("a", { href: "/loans", text: "Loans" }),
        " / ",
        el("span", { text: loan.id }),
      ]),
    );

    root.appendChild(
      el("div", { class: "page-head" }, [
        el("div", {}, [
          el("h1", {}, [`Loan ${loan.id} `, statusPill(loan)]),
          el("p", {
            text: `${loan.borrowerName} · ${loan.department} · booked ${instant(loan.bookedAt)}`,
          }),
        ]),
      ]),
    );

    root.appendChild(
      el("div", { class: "grid-2" }, [borrowerCard(loan), scheduleCard(loan)]),
    );
    root.appendChild(itemsCard(loan));
    root.appendChild(chargesCard(loan));

    const outcome = outcomeCard(loan);
    if (outcome) root.appendChild(outcome);

    const actions = actionsCard(loan);
    if (actions) root.appendChild(actions);
  }

  function borrowerCard(loan) {
    return el("section", { class: "card", "aria-labelledby": "borrower-heading" }, [
      el("h2", { id: "borrower-heading", text: "Borrower" }),
      summaryList([
        ["Name", el("span", { text: loan.borrower.name })],
        ["Email", el("a", { href: `mailto:${loan.borrower.email}`, text: loan.borrower.email })],
        ["Department", el("span", { text: loan.borrower.department })],
        [
          "Purpose",
          el("span", { text: loan.purpose || "No purpose recorded." }),
        ],
      ]),
    ]);
  }

  function scheduleCard(loan) {
    const rows = [
      ["Pickup date", el("span", { text: dateLong(loan.pickupDate) })],
      ["Loan period", el("span", { text: days(loan.loanDays) })],
      ["Due back", el("span", { text: instant(loan.dueAt) })],
      [
        "Extension",
        el("span", {
          text: loan.extensionsUsed ? "One 7-day extension used" : "None used (one allowed)",
        }),
      ],
    ];
    if (loan.pickedUpAt) rows.push(["Picked up", el("span", { text: instant(loan.pickedUpAt) })]);
    if (loan.returnedAt) rows.push(["Returned", el("span", { text: instant(loan.returnedAt) })]);
    if (loan.cancelledAt) rows.push(["Cancelled", el("span", { text: instant(loan.cancelledAt) })]);
    return el("section", { class: "card", "aria-labelledby": "schedule-heading" }, [
      el("h2", { id: "schedule-heading", text: "Schedule" }),
      summaryList(rows),
    ]);
  }

  function itemsCard(loan) {
    return el("section", { class: "card", "aria-labelledby": "items-heading" }, [
      el("h2", { id: "items-heading", text: `Items (${units(loan.unitCount)})` }),
      el("table", {}, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { scope: "col", text: "Item" }),
            el("th", { scope: "col", class: "numeric", text: "Units" }),
            el("th", { scope: "col", class: "numeric", text: "Daily rate" }),
            el("th", { scope: "col", class: "numeric", text: `Charge for ${days(loan.loanDays)}` }),
            el("th", { scope: "col", class: "numeric", text: "Deposit" }),
          ]),
        ]),
        el(
          "tbody",
          {},
          loan.lines.map((line) =>
            el("tr", {}, [
              el("td", {}, [
                el("a", { href: `/equipment/${line.equipmentId}`, text: line.name }),
                el("div", { class: "small muted", text: line.tag }),
              ]),
              el("td", { class: "numeric", text: String(line.quantity) }),
              el("td", { class: "numeric", text: money(line.dailyRateCents) }),
              el("td", { class: "numeric", text: money(line.lineChargeCents) }),
              el("td", {
                class: "numeric",
                text: line.lineDepositCents ? money(line.lineDepositCents) : "—",
              }),
            ]),
          ),
        ),
      ]),
    ]);
  }

  function chargesCard(loan) {
    const rows = [
      ["Base charge", money(loan.quote.baseChargeCents)],
    ];
    if (loan.quote.bundleDiscountCents > 0) {
      rows.push(["Bundle discount (3+ units)", `−${money(loan.quote.bundleDiscountCents)}`]);
    }
    rows.push(["Refundable deposit", money(loan.quote.depositCents)]);
    rows.push(["Total due at pickup", money(loan.quote.totalDueCents)]);

    const extra = [];
    if (loan.status === "returned") {
      extra.push(
        el("p", {
          class: "small",
          text:
            loan.lateFeeCents > 0
              ? `Late fee charged on return: ${money(loan.lateFeeCents)}.`
              : "No late fee was charged on return.",
        }),
      );
    }

    return el("section", { class: "card", "aria-labelledby": "charges-heading" }, [
      el("h2", { id: "charges-heading", text: "Charges" }),
      el("table", { class: "totals" }, [
        el(
          "tbody",
          {},
          rows.map(([label, value]) =>
            el("tr", {}, [
              el("th", { scope: "row", text: label }),
              el("td", { class: "numeric", text: value }),
            ]),
          ),
        ),
      ]),
      ...extra,
    ]);
  }

  function outcomeCard(loan) {
    if (loan.status === "returned") {
      return el("section", { class: "card", "aria-labelledby": "return-heading" }, [
        el("h2", { id: "return-heading", text: "Return record" }),
        summaryList([
          ["Checked in", el("span", { text: instant(loan.returnedAt) })],
          ["Condition", el("span", { text: loan.conditionLabel })],
          loan.conditionNote ? ["Note", el("span", { text: loan.conditionNote })] : null,
          ["Late fee", el("span", { text: money(loan.lateFeeCents || 0) })],
          [
            "Deposit",
            el("span", {
              text:
                loan.depositOutcome === "none"
                  ? "No deposit was held on this loan."
                  : loan.depositOutcome === "released"
                    ? `${money(loan.quote.depositCents)} released.`
                    : `${money(loan.quote.depositCents)} held pending inspection.`,
            }),
          ],
        ].filter(Boolean)),
      ]);
    }
    if (loan.status === "declined" && loan.decision) {
      return el("section", { class: "card" }, [
        el("h2", { text: "Declined" }),
        el("p", {
          text: `Declined by ${loan.decision.decidedBy} on ${instant(loan.decision.decidedAt)}.`,
        }),
        el("p", { text: `Reason: ${loan.decision.reason}` }),
      ]);
    }
    if (loan.status === "cancelled") {
      return el("section", { class: "card" }, [
        el("h2", { text: "Cancelled" }),
        el("p", {
          text: `This loan was cancelled on ${instant(loan.cancelledAt)} and its units went back into stock.`,
        }),
      ]);
    }
    return null;
  }

  function actionsCard(loan) {
    if (loan.status === "pending_approval") {
      return el("section", { class: "card", "aria-labelledby": "actions-heading" }, [
        el("h2", { id: "actions-heading", text: "Awaiting supervisor approval" }),
        el("ul", {}, loan.approvalReasons.map((reason) => el("li", { text: reason }))),
        el("div", { class: "button-row" }, [
          el("a", { class: "button button--primary", href: "/approvals", text: "Go to approvals" }),
          cancelControls(loan),
        ]),
      ]);
    }
    if (loan.status === "ready") {
      return el("section", { class: "card", "aria-labelledby": "actions-heading" }, [
        el("h2", { id: "actions-heading", text: "Ready for pickup" }),
        el("p", {
          text: loan.actions.canPickup
            ? `${loan.borrowerName} can collect this loan today.`
            : loan.actions.pickupBlockedReason,
        }),
        el("div", { class: "button-row" }, [pickupButton(loan), cancelControls(loan)]),
      ]);
    }
    if (loan.status === "out") {
      return el("section", { class: "card", "aria-labelledby": "actions-heading" }, [
        el("h2", { id: "actions-heading", text: "Out with the borrower" }),
        extensionBlock(loan),
        el("hr", { style: "border:none;border-top:1px solid var(--line);margin:1.1rem 0" }),
        checkinBlock(loan),
      ]);
    }
    return null;
  }

  function pickupButton(loan) {
    const button = el("button", {
      class: "button button--primary",
      type: "button",
      text: "Mark picked up",
      disabled: !loan.actions.canPickup,
      onclick: async () => {
        try {
          const result = await post(`/api/loans/${loan.id}/pickup`);
          await ctx.refreshChrome();
          await paint({ tone: "success", message: result.message });
        } catch (error) {
          await paint({ tone: "error", message: error.message });
        }
      },
    });
    return button;
  }

  function extensionBlock(loan) {
    const host = el("div");
    const button = el("button", {
      class: "button",
      type: "button",
      text: "Extend by 7 days",
      disabled: !loan.actions.canExtend,
      onclick: async () => {
        try {
          const result = await post(`/api/loans/${loan.id}/extend`);
          await paint({ tone: "success", message: result.message });
        } catch (error) {
          await paint({ tone: "error", message: error.message });
        }
      },
    });
    host.appendChild(el("h3", { text: "Extension" }));
    host.appendChild(
      el("p", {
        class: "small",
        text: loan.actions.canExtend
          ? `One extension is allowed. It would move the due date to ${dateLong(loan.actions.extendedDueDate)}.`
          : loan.actions.extendBlockedReason,
      }),
    );
    host.appendChild(el("div", { class: "button-row" }, [button]));
    return host;
  }

  function checkinBlock(loan) {
    const conditionSelect = el(
      "select",
      { id: "condition", name: "condition" },
      CONDITIONS.map(([value, label]) => el("option", { value, text: label })),
    );
    const noteInput = el("textarea", {
      id: "note",
      name: "note",
      placeholder: "Scratched lens hood, missing battery door…",
    });
    const statusHost = el("div");

    const submitButton = el("button", {
      class: "button button--primary",
      type: "submit",
      text: "Check in",
    });

    const form = el(
      "form",
      {
        "aria-label": "Check in this loan",
        onsubmit: async (event) => {
          event.preventDefault();
          const payload = { condition: conditionSelect.value, note: noteInput.value };
          const errors = validateCheckin(payload);
          if (applyErrors(form, errors, ["condition", "note"])) return;
          applyErrors(form, {}, ["condition", "note"]);
          try {
            const result = await runAction(
              submitButton,
              "Checking in…",
              statusHost,
              "Checking this loan in…",
              () => post(`/api/loans/${loan.id}/checkin`, payload),
            );
            await paint({ tone: "success", message: result.message });
          } catch (error) {
            if (error.fields && Object.keys(error.fields).length) {
              applyErrors(form, error.fields, ["condition", "note"]);
              statusHost.appendChild(banner("error", error.message));
            } else {
              await paint({ tone: "error", message: error.message });
            }
          }
        },
      },
      [
        el("h3", { text: "Check in" }),
        el("p", {
          class: "small",
          text: loan.overdue
            ? `This loan is ${loan.lateBusinessDays} business ${
                loan.lateBusinessDays === 1 ? "day" : "days"
              } late. Checking in today charges a late fee of ${money(loan.lateFeePreviewCents)}.`
            : "Checking in today charges no late fee.",
        }),
        loan.quote.depositCents > 0
          ? el("p", {
              class: "small",
              text: `The ${money(loan.quote.depositCents)} deposit is released when the kit comes back in good condition, and held for inspection otherwise.`,
            })
          : null,
        field("condition", "Returned condition", conditionSelect),
        field(
          "note",
          "Condition note",
          noteInput,
          "Required when the kit is damaged or missing parts (at least 10 characters).",
        ),
        el("div", { class: "button-row" }, [submitButton]),
        statusHost,
      ],
    );
    return form;
  }

  function cancelControls(loan) {
    if (!loan.actions.canCancel) return null;
    const host = el("span");
    const openButton = el("button", {
      class: "button button--danger",
      type: "button",
      text: "Cancel loan",
      onclick: () => {
        openButton.hidden = true;
        host.appendChild(confirmBlock());
      },
    });

    function confirmBlock() {
      const block = el("div", { class: "inline-confirm" }, [
        el("p", {
          text: `Cancel ${loan.id}? Its ${units(loan.unitCount)} go back into stock straight away.`,
        }),
        el("div", { class: "button-row", style: "margin-top:0" }, [
          el("button", {
            class: "button button--danger",
            type: "button",
            text: "Yes, cancel loan",
            onclick: async () => {
              try {
                const result = await post(`/api/loans/${loan.id}/cancel`);
                await ctx.refreshChrome();
                await paint({ tone: "success", message: result.message });
              } catch (error) {
                await paint({ tone: "error", message: error.message });
              }
            },
          }),
          el("button", {
            class: "button",
            type: "button",
            text: "Keep loan",
            onclick: () => {
              block.remove();
              openButton.hidden = false;
              openButton.focus();
            },
          }),
        ]),
      ]);
      return block;
    }

    host.appendChild(openButton);
    return host;
  }
}
