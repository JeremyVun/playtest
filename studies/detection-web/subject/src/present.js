// View models. These turn stored state plus the business rules into the exact
// shapes the browser renders. No rule arithmetic lives here.

import { formatMoney } from "./format.js";
import {
  APPROVAL_LONG_LOAN_DAYS,
  APPROVAL_VALUE_THRESHOLD_CENTS,
  DEPOSIT_RATE,
  DEPOSIT_THRESHOLD_CENTS,
  approvalRequired,
  availabilityMap,
  computeDueDate,
  dueAt,
  extendedDueDate,
  extensionEligibility,
  indexEquipment,
  isOverdue,
  lateBusinessDays,
  lateFeeFor,
  quoteFor,
} from "./rules.js";
import { formatDate } from "./time.js";

export const STATUS_LABELS = {
  pending_approval: "Awaiting approval",
  ready: "Ready for pickup",
  out: "Out",
  overdue: "Overdue",
  returned: "Returned",
  cancelled: "Cancelled",
  declined: "Declined",
};

export const CONDITION_LABELS = {
  good: "Good",
  damaged: "Damaged",
  missing_parts: "Missing parts",
};

/** Everything the presenters need, derived once per request. */
export function contextFor(state, today) {
  return {
    today,
    equipmentById: indexEquipment(state.equipment),
    available: availabilityMap(state.equipment, state.loans),
  };
}

export function statusLabel(loan, today) {
  if (isOverdue(loan, today)) return STATUS_LABELS.overdue;
  return STATUS_LABELS[loan.status];
}

export function itemsLabel(loan, equipmentById) {
  if (loan.lines.length === 0) return "No items";
  const first = equipmentById.get(loan.lines[0].equipmentId);
  const firstName = first ? first.name : loan.lines[0].equipmentId;
  if (loan.lines.length === 1) return firstName;
  return `${firstName} + ${loan.lines.length - 1} more`;
}

export function unitCountOf(loan) {
  return loan.lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function loanSummary(loan, ctx) {
  return {
    id: loan.id,
    borrowerName: loan.borrower.name,
    department: loan.borrower.department,
    itemsLabel: itemsLabel(loan, ctx.equipmentById),
    unitCount: unitCountOf(loan),
    status: loan.status,
    statusLabel: statusLabel(loan, ctx.today),
    overdue: isOverdue(loan, ctx.today),
    lateBusinessDays: lateBusinessDays(loan, ctx.today),
    loanDays: loan.loanDays,
    pickupDate: loan.pickupDate,
    dueDate: loan.dueDate,
    dueAt: dueAt(loan.dueDate),
    bookedAt: loan.bookedAt,
    totalDueCents: loan.quote.totalDueCents,
  };
}

export function approvalReasonsFor(quote, loanDays) {
  const reasons = [];
  if (quote.replacementTotalCents >= APPROVAL_VALUE_THRESHOLD_CENTS) {
    reasons.push(
      `Replacement value ${formatMoney(quote.replacementTotalCents)} is at or above the ${formatMoney(APPROVAL_VALUE_THRESHOLD_CENTS)} threshold.`,
    );
  }
  if (loanDays === APPROVAL_LONG_LOAN_DAYS) {
    reasons.push(`Loan period is ${APPROVAL_LONG_LOAN_DAYS} days.`);
  }
  return reasons;
}

export function approvalReasons(loan) {
  return approvalReasonsFor(loan.quote, loan.loanDays);
}

function lineDetail(loan, ctx) {
  const quote = quoteFor(loan.lines, loan.loanDays, ctx.equipmentById);
  return quote.lines;
}

export function loanDetail(loan, ctx) {
  const overdue = isOverdue(loan, ctx.today);
  const extension = extensionEligibility(loan, ctx.today);
  const readyEarly = loan.status === "ready" && loan.pickupDate > ctx.today;

  return {
    ...loanSummary(loan, ctx),
    borrower: loan.borrower,
    purpose: loan.purpose,
    lines: lineDetail(loan, ctx),
    quote: loan.quote,
    approvalRequired: loan.approvalRequired,
    approvalReasons: approvalReasons(loan),
    decision: loan.decision,
    pickedUpAt: loan.pickedUpAt,
    extensionsUsed: loan.extensionsUsed,
    returnedAt: loan.returnedAt,
    condition: loan.condition,
    conditionLabel: loan.condition ? CONDITION_LABELS[loan.condition] : null,
    conditionNote: loan.conditionNote,
    lateFeeCents: loan.lateFeeCents,
    depositOutcome: loan.depositOutcome,
    cancelledAt: loan.cancelledAt,
    lateFeePreviewCents: overdue ? lateFeeFor(loan, ctx.today) : 0,
    actions: {
      canPickup: loan.status === "ready" && !readyEarly,
      pickupBlockedReason: readyEarly
        ? `This loan is scheduled for pickup on ${formatDate(loan.pickupDate)}.`
        : null,
      canExtend: extension.allowed,
      extendBlockedReason: extension.reason,
      extendedDueDate: extension.allowed ? extendedDueDate(loan.dueDate) : null,
      canCheckin: loan.status === "out",
      canCancel: loan.status === "pending_approval" || loan.status === "ready",
    },
  };
}

export function equipmentSummary(item, ctx) {
  const availableUnits = ctx.available.get(item.id) || 0;
  return {
    id: item.id,
    tag: item.tag,
    name: item.name,
    category: item.category,
    description: item.description,
    totalUnits: item.totalUnits,
    availableUnits,
    dailyRateCents: item.dailyRateCents,
    replacementValueCents: item.replacementValueCents,
    depositPerUnitCents:
      item.replacementValueCents >= DEPOSIT_THRESHOLD_CENTS
        ? Math.round(item.replacementValueCents * DEPOSIT_RATE)
        : 0,
  };
}

export function equipmentDetail(item, state, ctx) {
  const holders = [];
  for (const loan of state.loans) {
    if (!["pending_approval", "ready", "out"].includes(loan.status)) continue;
    const line = loan.lines.find((candidate) => candidate.equipmentId === item.id);
    if (!line) continue;
    holders.push({
      id: loan.id,
      borrowerName: loan.borrower.name,
      quantity: line.quantity,
      status: loan.status,
      statusLabel: statusLabel(loan, ctx.today),
      overdue: isOverdue(loan, ctx.today),
      dueDate: loan.dueDate,
      pickupDate: loan.pickupDate,
    });
  }
  holders.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { ...equipmentSummary(item, ctx), specs: item.specs, holders };
}

/** The live quote and schedule preview shown on step 3 of the new-loan flow. */
export function draftPreview(draft, ctx) {
  if (!draft.lines.length || !draft.pickupDate || !draft.loanDays) return null;
  const quote = quoteFor(draft.lines, draft.loanDays, ctx.equipmentById);
  const due = computeDueDate(draft.pickupDate, draft.loanDays);
  return {
    quote,
    dueDate: due,
    dueAt: dueAt(due),
    approvalRequired: approvalRequired(quote.replacementTotalCents, draft.loanDays),
    approvalReasons: approvalReasonsFor(quote, draft.loanDays),
  };
}

/** The whole draft as the browser sees it. */
export function draftView(draft, ctx) {
  return {
    id: draft.id,
    borrower: draft.borrower,
    purpose: draft.purpose,
    lines: draft.lines.map((line) => {
      const item = ctx.equipmentById.get(line.equipmentId);
      return {
        equipmentId: line.equipmentId,
        quantity: line.quantity,
        name: item ? item.name : line.equipmentId,
        tag: item ? item.tag : null,
        dailyRateCents: item ? item.dailyRateCents : 0,
        availableUnits: ctx.available.get(line.equipmentId) || 0,
      };
    }),
    loanDays: draft.loanDays,
    pickupDate: draft.pickupDate,
    preview: draftPreview(draft, ctx),
  };
}
