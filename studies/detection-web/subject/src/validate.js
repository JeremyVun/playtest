// Input validation. Each validator returns a map of field name -> message.
// An empty map means the input is acceptable. The browser runs the same checks
// with the same messages before it sends anything.

import { DEPARTMENTS } from "./data.js";
import { formatMoney, formatUnits, verbFor } from "./format.js";
import { LOAN_DAY_OPTIONS, latestPickupDate } from "./rules.js";
import { isBusinessDay, isCalendarDate } from "./time.js";

export const MAX_PURPOSE_LENGTH = 200;
export const MIN_CONDITION_NOTE_LENGTH = 10;
export const MIN_DECLINE_REASON_LENGTH = 5;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Step 1 of the new-loan flow: who is borrowing. */
export function validateBorrower(input) {
  const errors = {};
  const name = text(input.name);
  const email = text(input.email);
  const department = text(input.department);
  const purpose = text(input.purpose);

  if (!name) {
    errors.name = "Enter the borrower's full name.";
  } else if (name.length < 2) {
    errors.name = "Borrower name must be at least 2 characters.";
  }

  if (!email) {
    errors.email = "Enter the borrower's email address.";
  } else if (!email.toLowerCase().endsWith("@fairmont.edu")) {
    errors.email = "Borrower email must be a fairmont.edu address.";
  }

  if (!department) {
    errors.department = "Choose a department.";
  } else if (!DEPARTMENTS.includes(department)) {
    errors.department = "Choose a department.";
  }

  if (purpose.length > MAX_PURPOSE_LENGTH) {
    errors.purpose = `Purpose must be ${MAX_PURPOSE_LENGTH} characters or fewer.`;
  }

  return errors;
}

/**
 * The one item problem worth reporting, or null when the item list is fine.
 * Availability is checked last, so a structural mistake is reported first.
 */
export function itemsProblem(lines, context, options = {}) {
  const { equipmentById } = context;
  if (!Array.isArray(lines) || lines.length === 0) {
    return "Add at least one item to this loan.";
  }
  const seen = new Set();
  for (const line of lines) {
    const item = equipmentById.get(line.equipmentId);
    if (!item) return "That equipment is no longer in the catalogue.";
    if (seen.has(line.equipmentId)) return "Each item can appear only once on a loan.";
    seen.add(line.equipmentId);
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) return "Quantity must be at least 1.";
  }
  if (options.checkAvailability === false) return null;
  return availabilityProblem(lines, context);
}

/** Whether the desk still has free units for every line. */
export function availabilityProblem(lines, context) {
  const { equipmentById, available } = context;
  for (const line of lines) {
    const item = equipmentById.get(line.equipmentId);
    if (!item) continue;
    const free = available.get(item.id) || 0;
    if (Number(line.quantity) > free) {
      return free === 0
        ? `${item.name} has no units available.`
        : `Only ${formatUnits(free)} of ${item.name} ${verbFor(free)} available.`;
    }
  }
  return null;
}

/**
 * Step 2 of the new-loan flow: what is going out and when.
 * `context` supplies the catalogue index, current availability and today's date.
 */
export function validateSchedule(input, context, options = {}) {
  const errors = {};
  const { today } = context;
  const lines = Array.isArray(input.lines) ? input.lines : [];

  const itemsMessage = itemsProblem(lines, context, options);
  if (itemsMessage) errors.items = itemsMessage;

  if (!LOAN_DAY_OPTIONS.includes(Number(input.loanDays))) {
    errors.loanDays = "Choose a loan period.";
  }

  const pickupDate = text(input.pickupDate);
  if (!pickupDate) {
    errors.pickupDate = "Choose a pickup date.";
  } else if (!isCalendarDate(pickupDate)) {
    errors.pickupDate = "Enter a pickup date as YYYY-MM-DD.";
  } else if (pickupDate < today) {
    errors.pickupDate = "Pickup date cannot be in the past.";
  } else if (pickupDate > latestPickupDate(today)) {
    errors.pickupDate = `Pickup date must be on or before ${latestPickupDate(today)}.`;
  } else if (!isBusinessDay(pickupDate)) {
    errors.pickupDate = "The desk is closed at weekends. Choose a weekday.";
  }

  return errors;
}

/** Check-in form. */
export function validateCheckin(input) {
  const errors = {};
  const condition = text(input.condition);
  const note = text(input.note);

  if (!["good", "damaged", "missing_parts"].includes(condition)) {
    errors.condition = "Select the returned condition.";
  } else if (condition !== "good" && note.length < MIN_CONDITION_NOTE_LENGTH) {
    errors.note = `Describe the condition in at least ${MIN_CONDITION_NOTE_LENGTH} characters.`;
  }

  return errors;
}

/** Decline form in the approvals queue. */
export function validateDecline(input) {
  const errors = {};
  const reason = text(input.reason);
  if (reason.length < MIN_DECLINE_REASON_LENGTH) {
    errors.reason = `Give a reason for declining (at least ${MIN_DECLINE_REASON_LENGTH} characters).`;
  }
  return errors;
}

/** Money helper re-exported so message text stays in one place. */
export { formatMoney };
