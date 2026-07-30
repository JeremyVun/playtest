// New loan — a three-step desk flow. The draft lives on the server, so the
// borrower details entered in step 1 survive a reload or a step back.

import { ApiError, get, patch, post } from "../lib/api.js";
import { clear, el, frag } from "../lib/dom.js";
import { dateLong, days, instant, money, units } from "../lib/format.js";
import {
  applyErrors,
  banner,
  emptyState,
  errorSlot,
  field,
  pageHead,
  runAction,
  summaryList,
} from "../lib/ui.js";
import { validateBorrower, validateSchedule } from "../lib/validate.js";

const STEP_NAMES = ["Borrower", "Items and dates", "Review and confirm"];

function stepList(current) {
  return el(
    "ol",
    { class: "steps", "aria-label": "New loan progress" },
    STEP_NAMES.map((name, index) =>
      el("li", { "aria-current": index + 1 === current ? "step" : null }, [
        el("span", { class: "steps__num", text: `${index + 1}.` }),
        name,
      ]),
    ),
  );
}

export async function render(ctx) {
  const requestedStep = Number(ctx.query.step || 1);
  const draftId = ctx.query.draft || null;

  let draft = null;
  let loadError = null;
  if (draftId) {
    try {
      draft = (await get(`/api/loan-drafts/${encodeURIComponent(draftId)}`)).draft;
    } catch (error) {
      loadError = error instanceof ApiError ? error.message : "That draft loan could not be loaded.";
    }
  }

  let step = Number.isInteger(requestedStep) && requestedStep >= 1 && requestedStep <= 3 ? requestedStep : 1;
  if (!draft) step = 1;
  if (step === 3 && (!draft.preview || draft.lines.length === 0)) step = 2;

  ctx.setTitle(`New loan · Step ${step} of 3`);

  const root = el("div");
  root.appendChild(
    pageHead("New loan", "Book equipment out to a borrower in three steps."),
  );
  if (loadError) root.appendChild(banner("error", loadError));
  root.appendChild(stepList(step));

  if (step === 1) root.appendChild(await stepBorrower(ctx, draft));
  else if (step === 2) root.appendChild(await stepSchedule(ctx, draft));
  else root.appendChild(stepReview(ctx, draft));

  return root;
}

// --- step 1 --------------------------------------------------------------

async function stepBorrower(ctx, draft) {
  const departments = ctx.session ? ctx.session.departments : [];
  const existing = draft ? draft.borrower : { name: "", email: "", department: "" };

  const nameInput = el("input", {
    type: "text",
    id: "name",
    name: "name",
    autocomplete: "off",
    value: existing.name || "",
  });
  const emailInput = el("input", {
    type: "text",
    id: "email",
    name: "email",
    autocomplete: "off",
    value: existing.email || "",
  });
  const departmentSelect = el(
    "select",
    { id: "department", name: "department" },
    [
      el("option", { value: "", text: "Choose a department" }),
      ...departments.map((department) =>
        el("option", {
          value: department,
          selected: department === existing.department,
          text: department,
        }),
      ),
    ],
  );
  const purposeInput = el("textarea", {
    id: "purpose",
    name: "purpose",
    value: draft ? draft.purpose : "",
  });
  const feedback = el("div");
  const submitButton = el("button", {
    class: "button button--primary",
    type: "submit",
    text: "Continue to items",
  });

  const form = el(
    "form",
    {
      class: "card",
      "aria-label": "Borrower details",
      onsubmit: async (event) => {
        event.preventDefault();
        clear(feedback);
        const payload = {
          name: nameInput.value,
          email: emailInput.value,
          department: departmentSelect.value,
          purpose: purposeInput.value,
        };
        const fields = ["name", "email", "department", "purpose"];
        const errors = validateBorrower(payload, departments);
        if (applyErrors(form, errors, fields)) return;
        applyErrors(form, {}, fields);

        try {
          const result = draft
            ? await patch(`/api/loan-drafts/${draft.id}`, { step: "borrower", ...payload })
            : await post("/api/loan-drafts", payload);
          ctx.navigate(`/new-loan?draft=${result.draft.id}&step=2`);
        } catch (error) {
          if (error.fields && Object.keys(error.fields).length) {
            applyErrors(form, error.fields, fields);
            feedback.appendChild(banner("error", error.message));
          } else {
            feedback.appendChild(banner("error", error.message));
          }
        }
      },
    },
    [
      el("h2", { text: "Step 1 — who is borrowing?" }),
      field("name", "Borrower name", nameInput),
      field("email", "Borrower email", emailInput, "Must be a fairmont.edu address."),
      field("department", "Department", departmentSelect),
      field(
        "purpose",
        "Purpose (optional)",
        purposeInput,
        "What the kit is for. 200 characters at most.",
      ),
      el("div", { class: "button-row" }, [
        submitButton,
        el("a", { class: "button", href: "/loans", text: "Cancel" }),
      ]),
      feedback,
    ],
  );

  return form;
}

// --- step 2 --------------------------------------------------------------

async function stepSchedule(ctx, draft) {
  const catalogue = (await get("/api/equipment")).items;
  const byId = new Map(catalogue.map((item) => [item.id, item]));
  const today = ctx.session ? ctx.session.deskTime.date : "";
  const latest = ctx.session ? ctx.session.latestPickupDate : "";

  let lines = draft.lines.map((line) => ({
    equipmentId: line.equipmentId,
    quantity: line.quantity,
  }));

  const picker = el("select", { id: "item-picker", name: "item-picker" });
  const addButton = el("button", {
    class: "button",
    type: "button",
    text: "Add item",
    onclick: () => {
      if (!picker.value) return;
      lines.push({ equipmentId: picker.value, quantity: 1 });
      paintLines();
      paintPicker();
    },
  });

  const linesHost = el("div");
  const feedback = el("div");

  function paintPicker() {
    clear(picker);
    const remaining = catalogue.filter(
      (item) => !lines.some((line) => line.equipmentId === item.id),
    );
    if (remaining.length === 0) {
      picker.appendChild(el("option", { value: "", text: "Every item is already on this loan" }));
      picker.disabled = true;
      addButton.disabled = true;
      return;
    }
    picker.disabled = false;
    addButton.disabled = false;
    for (const item of remaining) {
      picker.appendChild(
        el("option", {
          value: item.id,
          disabled: item.availableUnits === 0,
          text:
            item.availableUnits === 0
              ? `${item.name} — fully booked`
              : `${item.name} — ${item.availableUnits} of ${item.totalUnits} available`,
        }),
      );
    }
    const firstFree = remaining.find((item) => item.availableUnits > 0);
    picker.value = firstFree ? firstFree.id : "";
  }

  function paintLines() {
    clear(linesHost);
    if (lines.length === 0) {
      linesHost.appendChild(
        emptyState(
          "No items on this loan yet",
          "Pick equipment from the list above to build the loan.",
        ),
      );
      return;
    }
    linesHost.appendChild(
      el("table", {}, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { scope: "col", text: "Item" }),
            el("th", { scope: "col", text: "Units" }),
            el("th", { scope: "col", class: "numeric", text: "Daily rate" }),
            el("th", { scope: "col", text: "Action" }),
          ]),
        ]),
        el(
          "tbody",
          {},
          lines.map((line, index) => {
            const item = byId.get(line.equipmentId);
            const quantityId = `quantity-${line.equipmentId}`;
            const quantityInput = el("input", {
              type: "number",
              id: quantityId,
              min: "1",
              max: String(item ? item.availableUnits : 1),
              step: "1",
              value: String(line.quantity),
              "aria-label": `Units of ${item ? item.name : line.equipmentId}`,
              oninput: () => {
                lines[index].quantity = Number(quantityInput.value);
              },
            });
            return el("tr", {}, [
              el("td", {}, [
                el("div", { text: item ? item.name : line.equipmentId }),
                el("div", {
                  class: "small muted",
                  text: item ? `${item.availableUnits} of ${item.totalUnits} available` : "",
                }),
              ]),
              el("td", {}, [quantityInput]),
              el("td", {
                class: "numeric",
                text: item ? `${money(item.dailyRateCents)} / day` : "—",
              }),
              el("td", {}, [
                el("button", {
                  class: "button button--link",
                  type: "button",
                  text: "Remove",
                  "aria-label": `Remove ${item ? item.name : line.equipmentId}`,
                  onclick: () => {
                    lines.splice(index, 1);
                    paintLines();
                    paintPicker();
                  },
                }),
              ]),
            ]);
          }),
        ),
      ]),
    );
  }

  const periodOptions = (ctx.session ? ctx.session.loanDayOptions : [1, 3, 7, 14]).map((value) =>
    el("label", { for: `period-${value}` }, [
      el("input", {
        type: "radio",
        id: `period-${value}`,
        name: "loanDays",
        value: String(value),
        checked: Number(draft.loanDays) === value,
      }),
      ` ${days(value)}`,
    ]),
  );

  const pickupInput = el("input", {
    type: "date",
    id: "pickupDate",
    name: "pickupDate",
    min: today,
    max: latest,
    value: draft.pickupDate || today,
  });

  const submitButton = el("button", {
    class: "button button--primary",
    type: "submit",
    text: "Continue to review",
  });

  function chosenPeriod() {
    const checked = form.querySelector('input[name="loanDays"]:checked');
    return checked ? Number(checked.value) : null;
  }

  const form = el(
    "form",
    {
      class: "card",
      "aria-label": "Items and dates",
      onsubmit: async (event) => {
        event.preventDefault();
        clear(feedback);
        const payload = {
          lines: lines.map((line) => ({ ...line })),
          loanDays: chosenPeriod(),
          pickupDate: pickupInput.value,
        };
        const fields = ["items", "loanDays", "pickupDate"];
        const errors = validateSchedule(payload, {
          catalogue: byId,
          today,
          latestPickupDate: latest,
        });
        if (applyErrors(form, errors, fields)) return;
        applyErrors(form, {}, fields);

        try {
          await patch(`/api/loan-drafts/${draft.id}`, { step: "schedule", ...payload });
          ctx.navigate(`/new-loan?draft=${draft.id}&step=3`);
        } catch (error) {
          if (error.fields && Object.keys(error.fields).length) {
            applyErrors(form, error.fields, fields);
          }
          feedback.appendChild(banner("error", error.message));
        }
      },
    },
    [
      el("h2", { text: "Step 2 — what is going out, and when?" }),
      el("p", { class: "small muted", text: `Booking for ${draft.borrower.name}.` }),
      el("fieldset", {}, [
        el("legend", { text: "Equipment" }),
        el("div", { class: "item-line" }, [
          el("label", { for: "item-picker", text: "Add equipment" }),
          picker,
          addButton,
        ]),
        linesHost,
        errorSlot("items"),
      ]),
      el("fieldset", {}, [
        el("legend", { text: "Loan period" }),
        el("div", { class: "radio-row", id: "loanDays" }, periodOptions),
        errorSlot("loanDays"),
      ]),
      field(
        "pickupDate",
        "Pickup date",
        pickupInput,
        `A weekday from ${today} to ${latest}. The due date is confirmed on the next step.`,
      ),
      el("div", { class: "button-row" }, [
        el("a", {
          class: "button",
          href: `/new-loan?draft=${draft.id}&step=1`,
          text: "Back to borrower",
        }),
        submitButton,
      ]),
      feedback,
    ],
  );

  paintLines();
  paintPicker();
  return form;
}

// --- step 3 --------------------------------------------------------------

function stepReview(ctx, draft) {
  const preview = draft.preview;
  const feedback = el("div");
  const statusHost = el("div");

  const confirmButton = el("button", {
    class: "button button--primary",
    type: "button",
    text: "Confirm booking",
    onclick: async () => {
      clear(feedback);
      try {
        const result = await runAction(
          confirmButton,
          "Booking…",
          statusHost,
          "Booking this loan…",
          () => post(`/api/loan-drafts/${draft.id}/submit`),
        );
        ctx.setFlash("success", result.message);
        await ctx.refreshChrome();
        ctx.navigate(`/loans/${result.loan.id}`);
      } catch (error) {
        feedback.appendChild(banner("error", error.message));
      }
    },
  });

  const chargeRows = [["Base charge", money(preview.quote.baseChargeCents)]];
  if (preview.quote.bundleDiscountCents > 0) {
    chargeRows.push(["Bundle discount (3+ units)", `−${money(preview.quote.bundleDiscountCents)}`]);
  }
  chargeRows.push(["Refundable deposit", money(preview.quote.depositCents)]);
  chargeRows.push(["Total due at pickup", money(preview.quote.totalDueCents)]);

  return frag([
    el("section", { class: "card", "aria-labelledby": "review-heading" }, [
      el("h2", { id: "review-heading", text: "Step 3 — review and confirm" }),
      el("div", { class: "grid-2" }, [
        el("div", {}, [
          el("h3", { text: "Borrower" }),
          summaryList([
            ["Name", el("span", { text: draft.borrower.name })],
            ["Email", el("span", { text: draft.borrower.email })],
            ["Department", el("span", { text: draft.borrower.department })],
            ["Purpose", el("span", { text: draft.purpose || "No purpose recorded." })],
          ]),
        ]),
        el("div", {}, [
          el("h3", { text: "Schedule" }),
          summaryList([
            ["Pickup", el("span", { text: dateLong(draft.pickupDate) })],
            ["Loan period", el("span", { text: days(draft.loanDays) })],
            ["Due back", el("span", { text: instant(preview.dueAt) })],
            ["Units", el("span", { text: units(preview.quote.unitCount) })],
          ]),
        ]),
      ]),
    ]),
    el("section", { class: "card", "aria-labelledby": "review-items-heading" }, [
      el("h2", { id: "review-items-heading", text: "Items" }),
      el("table", {}, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { scope: "col", text: "Item" }),
            el("th", { scope: "col", class: "numeric", text: "Units" }),
            el("th", { scope: "col", class: "numeric", text: "Daily rate" }),
            el("th", { scope: "col", class: "numeric", text: "Charge" }),
            el("th", { scope: "col", class: "numeric", text: "Deposit" }),
          ]),
        ]),
        el(
          "tbody",
          {},
          preview.quote.lines.map((line) =>
            el("tr", {}, [
              el("td", { text: line.name }),
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
    ]),
    el("section", { class: "card", "aria-labelledby": "review-charges-heading" }, [
      el("h2", { id: "review-charges-heading", text: "Charges" }),
      el("table", { class: "totals" }, [
        el(
          "tbody",
          {},
          chargeRows.map(([label, value]) =>
            el("tr", {}, [
              el("th", { scope: "row", text: label }),
              el("td", { class: "numeric", text: value }),
            ]),
          ),
        ),
      ]),
      preview.approvalRequired
        ? el("div", { class: "banner banner--warn", style: "margin:1rem 0 0" }, [
            el("strong", { text: "This loan needs supervisor approval before pickup." }),
            el("ul", { style: "margin:0.4rem 0 0" }, preview.approvalReasons.map((reason) => el("li", { text: reason }))),
          ])
        : el("p", {
            class: "small muted",
            style: "margin-top:1rem",
            text: "No approval needed — this loan goes straight to the pickup shelf.",
          }),
      el("div", { class: "button-row" }, [
        el("a", {
          class: "button",
          href: `/new-loan?draft=${draft.id}&step=2`,
          text: "Back to items",
        }),
        confirmButton,
      ]),
      statusHost,
      feedback,
    ]),
  ]);
}
