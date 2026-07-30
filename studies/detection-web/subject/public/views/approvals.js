// Supervisor approvals queue: approve or decline the requests the rules held back.

import { get, post } from "../lib/api.js";
import { clear, el } from "../lib/dom.js";
import { dateLong, days, money, units } from "../lib/format.js";
import { applyErrors, banner, emptyState, field, pageHead, runAction } from "../lib/ui.js";
import { validateDecline } from "../lib/validate.js";

export async function render(ctx) {
  const root = el("div");
  await paint(null);
  return root;

  async function paint(feedback) {
    ctx.setTitle("Approvals");
    const data = await get("/api/approvals");

    clear(root);
    if (feedback) root.appendChild(banner(feedback.tone, feedback.message));

    root.appendChild(
      pageHead(
        "Approvals",
        data.count === 1
          ? "1 request is waiting for a supervisor decision"
          : `${data.count} requests are waiting for a supervisor decision`,
      ),
    );

    if (data.count === 0) {
      root.appendChild(
        emptyState(
          "Nothing waiting for approval",
          "Every request has been decided. New requests appear here when a loan is worth $2,500 or more, or runs for 14 days.",
          el("a", { class: "button", href: "/loans", text: "View all loans" }),
        ),
      );
      return;
    }

    for (const loan of data.loans) {
      root.appendChild(requestCard(loan));
    }
  }

  function requestCard(loan) {
    const feedbackHost = el("div");
    const card = el("section", { class: "card", "aria-labelledby": `req-${loan.id}` }, [
      el("div", { class: "card__head" }, [
        el("h2", { id: `req-${loan.id}` }, [
          el("a", { href: `/loans/${loan.id}`, text: loan.id }),
          ` — ${loan.borrowerName}`,
        ]),
        el("span", { class: "small muted", text: loan.department }),
      ]),
      el("p", { text: loan.purpose || "No purpose recorded." }),
      el("ul", {}, [
        ...loan.approvalReasons.map((reason) => el("li", { text: reason })),
        el("li", {
          text: `${units(loan.unitCount)} for ${days(loan.loanDays)}, pickup ${dateLong(loan.pickupDate)}, due ${dateLong(loan.dueDate)}.`,
        }),
        el("li", { text: `Total due at pickup ${money(loan.totalDueCents)}.` }),
      ]),
      el("table", {}, [
        el("caption", { text: "Items on this request." }),
        el("thead", {}, [
          el("tr", {}, [
            el("th", { scope: "col", text: "Item" }),
            el("th", { scope: "col", class: "numeric", text: "Units" }),
            el("th", { scope: "col", class: "numeric", text: "Charge" }),
            el("th", { scope: "col", class: "numeric", text: "Deposit" }),
          ]),
        ]),
        el(
          "tbody",
          {},
          loan.lines.map((line) =>
            el("tr", {}, [
              el("td", { text: line.name }),
              el("td", { class: "numeric", text: String(line.quantity) }),
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

    const approveButton = el("button", {
      class: "button button--primary",
      type: "button",
      text: "Approve",
      onclick: async () => {
        try {
          const result = await runAction(
            approveButton,
            "Approving…",
            feedbackHost,
            "Recording your approval…",
            () => post(`/api/approvals/${loan.id}/approve`),
          );
          await ctx.refreshChrome();
          await paint({ tone: "success", message: result.message });
        } catch (error) {
          clear(feedbackHost);
          feedbackHost.appendChild(banner("error", error.message));
        }
      },
    });

    const declineButton = el("button", {
      class: "button button--danger",
      type: "button",
      text: "Decline",
      onclick: () => {
        declineButton.hidden = true;
        approveButton.disabled = true;
        const form = declineForm();
        actionRow.after(form);
        form.querySelector("textarea").focus();
      },
    });

    const actionRow = el("div", { class: "button-row" }, [approveButton, declineButton]);
    card.appendChild(actionRow);
    card.appendChild(feedbackHost);

    function declineForm() {
      const reasonId = `reason-${loan.id}`;
      const reasonInput = el("textarea", {
        id: reasonId,
        name: "reason",
        placeholder: "Kit already committed to the open day.",
      });
      const confirmButton = el("button", {
        class: "button button--danger",
        type: "submit",
        text: "Confirm decline",
      });
      const statusHost = el("div");

      const form = el(
        "form",
        {
          class: "inline-confirm",
          "aria-label": `Decline ${loan.id}`,
          onsubmit: async (event) => {
            event.preventDefault();
            const payload = { reason: reasonInput.value };
            const errors = validateDecline(payload);
            if (applyErrors(form, { [reasonId]: errors.reason }, [reasonId])) return;
            try {
              const result = await runAction(
                confirmButton,
                "Declining…",
                statusHost,
                "Recording your decision…",
                () => post(`/api/approvals/${loan.id}/decline`, payload),
              );
              await ctx.refreshChrome();
              await paint({ tone: "success", message: result.message });
            } catch (error) {
              if (error.fields && error.fields.reason) {
                applyErrors(form, { [reasonId]: error.fields.reason }, [reasonId]);
              } else {
                clear(statusHost);
                statusHost.appendChild(banner("error", error.message));
              }
            }
          },
        },
        [
          field(
            reasonId,
            `Why is ${loan.id} being declined?`,
            reasonInput,
            "The borrower sees this reason on the loan record.",
          ),
          el("div", { class: "button-row", style: "margin-top:0" }, [
            confirmButton,
            el("button", {
              class: "button",
              type: "button",
              text: "Keep in queue",
              onclick: () => {
                form.remove();
                declineButton.hidden = false;
                approveButton.disabled = false;
                declineButton.focus();
              },
            }),
          ]),
          statusHost,
        ],
      );
      return form;
    }

    return card;
  }
}
