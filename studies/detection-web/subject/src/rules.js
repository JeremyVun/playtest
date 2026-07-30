// Business rules for the lending desk. Every function here is pure: it takes
// state and returns derived values. Nothing in this module reads the machine
// clock, the request, or the store.

import { addDays, businessDaysBetween, nextBusinessDay } from "./time.js";

/** Loan statuses that hold units out of the available pool. */
export const COMMITTING_STATUSES = ["pending_approval", "ready", "out"];

/** Loan statuses that no longer hold units. */
export const CLOSED_STATUSES = ["returned", "cancelled", "declined"];

export const LOAN_DAY_OPTIONS = [1, 3, 7, 14];
export const MAX_PICKUP_LEAD_DAYS = 14;
export const DUE_TIME = "17:00";

export const BUNDLE_MIN_UNITS = 3;
export const BUNDLE_DISCOUNT_RATE = 0.1;
export const DEPOSIT_THRESHOLD_CENTS = 100000; // $1,000.00
export const DEPOSIT_RATE = 0.1;

export const APPROVAL_VALUE_THRESHOLD_CENTS = 250000; // $2,500.00
export const APPROVAL_LONG_LOAN_DAYS = 14;

export const LATE_FEE_PER_UNIT_PER_DAY_CENTS = 500; // $5.00
export const LATE_FEE_CAP_CENTS = 15000; // $150.00

export const EXTENSION_DAYS = 7;
export const MAX_EXTENSIONS = 1;

/** Round to a whole cent, halves away from zero. */
function roundCents(value) {
  return Math.round(value);
}

/** Index equipment by id. */
export function indexEquipment(equipment) {
  return new Map(equipment.map((item) => [item.id, item]));
}

/**
 * Units of each equipment id committed by open loans.
 * A loan commits units while it is awaiting approval, ready for pickup, or out.
 */
export function committedUnits(loans) {
  const committed = new Map();
  for (const loan of loans) {
    if (!COMMITTING_STATUSES.includes(loan.status)) continue;
    for (const line of loan.lines) {
      committed.set(line.equipmentId, (committed.get(line.equipmentId) || 0) + line.quantity);
    }
  }
  return committed;
}

/** Availability for one equipment item: total units minus committed units. */
export function availabilityOf(item, loans) {
  const committed = committedUnits(loans).get(item.id) || 0;
  return Math.max(0, item.totalUnits - committed);
}

/** Availability map for the whole catalogue. */
export function availabilityMap(equipment, loans) {
  const committed = committedUnits(loans);
  const available = new Map();
  for (const item of equipment) {
    available.set(item.id, Math.max(0, item.totalUnits - (committed.get(item.id) || 0)));
  }
  return available;
}

/**
 * Due date: pickup date plus the loan period in calendar days, rolled forward
 * off a weekend because the desk is closed then.
 */
export function computeDueDate(pickupDate, loanDays) {
  return nextBusinessDay(addDays(pickupDate, loanDays));
}

/** Due instant, always 17:00 desk time on the due date. */
export function dueAt(dueDate) {
  return `${dueDate}T${DUE_TIME}:00Z`;
}

/**
 * Priced quote for a set of loan lines.
 * base charge  = sum(daily rate x quantity x loan days)
 * bundle       = 10% off the base charge when 3 or more units are on the loan
 * deposit      = 10% of replacement value per unit, for units worth $1,000+
 * total due    = base charge - bundle discount + deposit
 */
export function quoteFor(lines, loanDays, equipmentById) {
  const detail = [];
  let baseChargeCents = 0;
  let depositCents = 0;
  let unitCount = 0;
  let replacementTotalCents = 0;

  for (const line of lines) {
    const item = equipmentById.get(line.equipmentId);
    if (!item) continue;
    const lineChargeCents = item.dailyRateCents * line.quantity * loanDays;
    const perUnitDepositCents =
      item.replacementValueCents >= DEPOSIT_THRESHOLD_CENTS
        ? roundCents(item.replacementValueCents * DEPOSIT_RATE)
        : 0;
    const lineDepositCents = perUnitDepositCents * line.quantity;

    baseChargeCents += lineChargeCents;
    depositCents += lineDepositCents;
    unitCount += line.quantity;
    replacementTotalCents += item.replacementValueCents * line.quantity;

    detail.push({
      equipmentId: item.id,
      name: item.name,
      tag: item.tag,
      quantity: line.quantity,
      dailyRateCents: item.dailyRateCents,
      replacementValueCents: item.replacementValueCents,
      lineChargeCents,
      lineDepositCents,
    });
  }

  const bundleDiscountCents =
    unitCount >= BUNDLE_MIN_UNITS ? roundCents(baseChargeCents * BUNDLE_DISCOUNT_RATE) : 0;

  return {
    lines: detail,
    unitCount,
    baseChargeCents,
    bundleDiscountCents,
    depositCents,
    replacementTotalCents,
    totalDueCents: baseChargeCents - bundleDiscountCents + depositCents,
  };
}

/**
 * Supervisor approval is required when the loan carries $2,500 or more of
 * replacement value, or when the loan period is 14 days.
 */
export function approvalRequired(replacementTotalCents, loanDays) {
  return (
    replacementTotalCents >= APPROVAL_VALUE_THRESHOLD_CENTS || loanDays === APPROVAL_LONG_LOAN_DAYS
  );
}

/** A loan is overdue when it is out and today is past its due date. */
export function isOverdue(loan, today) {
  if (loan.status !== "out") return false;
  return today > loan.dueDate;
}

/** Business days between the due date (exclusive) and today (inclusive). */
export function lateBusinessDays(loan, today) {
  if (loan.status !== "out") return 0;
  return businessDaysBetween(loan.dueDate, today);
}

/**
 * Late fee: $5.00 per unit per late business day, capped at $150.00 per loan.
 */
export function lateFeeFor(loan, today) {
  const days = lateBusinessDays(loan, today);
  if (days <= 0) return 0;
  const units = loan.lines.reduce((sum, line) => sum + line.quantity, 0);
  return Math.min(days * LATE_FEE_PER_UNIT_PER_DAY_CENTS * units, LATE_FEE_CAP_CENTS);
}

/** The extended due date: seven more calendar days, rolled off a weekend. */
export function extendedDueDate(dueDate) {
  return nextBusinessDay(addDays(dueDate, EXTENSION_DAYS));
}

/** Whether a loan may be extended, and why not when it may not. */
export function extensionEligibility(loan, today) {
  if (loan.status !== "out") {
    return { allowed: false, reason: "Only a loan that is out can be extended." };
  }
  if (isOverdue(loan, today)) {
    return { allowed: false, reason: "An overdue loan cannot be extended. Check it in first." };
  }
  if (loan.extensionsUsed >= MAX_EXTENSIONS) {
    return { allowed: false, reason: "This loan has already used its one extension." };
  }
  return { allowed: true, reason: null };
}

/** The latest pickup date the desk will book. */
export function latestPickupDate(today) {
  return addDays(today, MAX_PICKUP_LEAD_DAYS);
}

/**
 * Charges booked today: the total due of every loan booked today that has not
 * been cancelled or declined, plus every late fee recorded today.
 */
export function chargesBookedToday(loans, today) {
  let cents = 0;
  for (const loan of loans) {
    if (
      loan.bookedAt.slice(0, 10) === today &&
      loan.status !== "cancelled" &&
      loan.status !== "declined"
    ) {
      cents += loan.quote.totalDueCents;
    }
    if (loan.returnedAt && loan.returnedAt.slice(0, 10) === today) {
      cents += loan.lateFeeCents || 0;
    }
  }
  return cents;
}

/** Desk overview counters. */
export function overviewMetrics(state, today) {
  const out = state.loans.filter((loan) => loan.status === "out");
  const overdue = out.filter((loan) => isOverdue(loan, today));
  const dueToday = out.filter((loan) => loan.dueDate === today);
  const awaitingApproval = state.loans.filter((loan) => loan.status === "pending_approval");
  const readyForPickup = state.loans.filter((loan) => loan.status === "ready");
  const available = availabilityMap(state.equipment, state.loans);

  let unitsAvailable = 0;
  let unitsTotal = 0;
  for (const item of state.equipment) {
    unitsAvailable += available.get(item.id) || 0;
    unitsTotal += item.totalUnits;
  }

  return {
    outCount: out.length,
    overdueCount: overdue.length,
    dueTodayCount: dueToday.length,
    awaitingApprovalCount: awaitingApproval.length,
    readyForPickupCount: readyForPickup.length,
    unitsAvailable,
    unitsTotal,
    chargesBookedTodayCents: chargesBookedToday(state.loans, today),
  };
}
