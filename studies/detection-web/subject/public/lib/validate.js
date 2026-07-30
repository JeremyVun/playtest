// Browser-side validation. Same rules and the same message text as the desk
// server, so a mistake is caught before the request leaves the page.

const LOAN_DAY_OPTIONS = [1, 3, 7, 14];
export const MAX_PURPOSE_LENGTH = 200;
export const MIN_CONDITION_NOTE_LENGTH = 10;
export const MIN_DECLINE_REASON_LENGTH = 5;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === value;
}

function isBusinessDay(value) {
  const day = new Date(`${value}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function unitWord(count) {
  return `${count} ${count === 1 ? "unit" : "units"}`;
}

export function validateBorrower(input, departments) {
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

  if (!department || (departments && !departments.includes(department))) {
    errors.department = "Choose a department.";
  }

  if (purpose.length > MAX_PURPOSE_LENGTH) {
    errors.purpose = `Purpose must be ${MAX_PURPOSE_LENGTH} characters or fewer.`;
  }

  return errors;
}

/** The one item problem worth reporting, or null. Availability is checked last. */
export function itemsProblem(lines, context) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return "Add at least one item to this loan.";
  }
  const seen = new Set();
  for (const line of lines) {
    const item = context.catalogue.get(line.equipmentId);
    if (!item) return "That equipment is no longer in the catalogue.";
    if (seen.has(line.equipmentId)) return "Each item can appear only once on a loan.";
    seen.add(line.equipmentId);
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) return "Quantity must be at least 1.";
  }
  for (const line of lines) {
    const item = context.catalogue.get(line.equipmentId);
    if (Number(line.quantity) > item.availableUnits) {
      return item.availableUnits === 0
        ? `${item.name} has no units available.`
        : `Only ${unitWord(item.availableUnits)} of ${item.name} ${
            item.availableUnits === 1 ? "is" : "are"
          } available.`;
    }
  }
  return null;
}

/**
 * context: { catalogue: Map<id, {name, availableUnits}>, today, latestPickupDate }
 */
export function validateSchedule(input, context) {
  const errors = {};
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const itemsMessage = itemsProblem(lines, context);
  if (itemsMessage) errors.items = itemsMessage;

  if (!LOAN_DAY_OPTIONS.includes(Number(input.loanDays))) {
    errors.loanDays = "Choose a loan period.";
  }

  const pickupDate = text(input.pickupDate);
  if (!pickupDate) {
    errors.pickupDate = "Choose a pickup date.";
  } else if (!isCalendarDate(pickupDate)) {
    errors.pickupDate = "Enter a pickup date as YYYY-MM-DD.";
  } else if (pickupDate < context.today) {
    errors.pickupDate = "Pickup date cannot be in the past.";
  } else if (pickupDate > context.latestPickupDate) {
    errors.pickupDate = `Pickup date must be on or before ${context.latestPickupDate}.`;
  } else if (!isBusinessDay(pickupDate)) {
    errors.pickupDate = "The desk is closed at weekends. Choose a weekday.";
  }

  return errors;
}

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

export function validateDecline(input) {
  const errors = {};
  if (text(input.reason).length < MIN_DECLINE_REASON_LENGTH) {
    errors.reason = `Give a reason for declining (at least ${MIN_DECLINE_REASON_LENGTH} characters).`;
  }
  return errors;
}
