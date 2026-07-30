// JSON API handlers. Each handler receives { params, query, body } and returns
// { status, body }. Route matching lives in server.js.

import { CATEGORIES, DEPARTMENTS, OPERATOR } from "./data.js";
import { formatMoney } from "./format.js";
import {
  APPROVAL_VALUE_THRESHOLD_CENTS,
  BUNDLE_DISCOUNT_RATE,
  BUNDLE_MIN_UNITS,
  DEPOSIT_RATE,
  DEPOSIT_THRESHOLD_CENTS,
  LATE_FEE_CAP_CENTS,
  LATE_FEE_PER_UNIT_PER_DAY_CENTS,
  LOAN_DAY_OPTIONS,
  approvalRequired,
  availabilityMap,
  computeDueDate,
  dueAt,
  extendedDueDate,
  extensionEligibility,
  indexEquipment,
  isOverdue,
  lateFeeFor,
  latestPickupDate,
  overviewMetrics,
  quoteFor,
} from "./rules.js";
import {
  approvalReasons,
  contextFor,
  draftView,
  equipmentDetail,
  equipmentSummary,
  loanDetail,
  loanSummary,
} from "./present.js";
import * as store from "./store.js";
import { delay, formatDate, nowIso, today } from "./time.js";
import {
  availabilityProblem,
  validateBorrower,
  validateCheckin,
  validateDecline,
  validateSchedule,
} from "./validate.js";

/** Simulated desk-system latency, in milliseconds. Fixed, never random. */
export const LATENCY = {
  bookLoan: 900,
  checkin: 700,
  approvalDecision: 600,
};

const fieldError = (fields) => ({
  status: 400,
  body: { error: { message: "Check the highlighted fields.", fields } },
});

const conflict = (message) => ({ status: 409, body: { error: { message } } });
const notFound = (message) => ({ status: 404, body: { error: { message } } });

function ctx() {
  return contextFor(store.getState(), today());
}

// --- session -------------------------------------------------------------

export function getSession() {
  const now = nowIso();
  const date = today();
  return {
    status: 200,
    body: {
      operator: OPERATOR,
      deskTime: {
        iso: now,
        date,
        time: now.slice(11, 16),
        formatted: `${formatDate(date)}, ${now.slice(11, 16)}`,
      },
      departments: DEPARTMENTS,
      categories: CATEGORIES,
      loanDayOptions: LOAN_DAY_OPTIONS,
      latestPickupDate: latestPickupDate(date),
      policy: {
        bundleMinUnits: BUNDLE_MIN_UNITS,
        bundleDiscountRate: BUNDLE_DISCOUNT_RATE,
        depositThresholdCents: DEPOSIT_THRESHOLD_CENTS,
        depositRate: DEPOSIT_RATE,
        approvalValueThresholdCents: APPROVAL_VALUE_THRESHOLD_CENTS,
        lateFeePerUnitPerDayCents: LATE_FEE_PER_UNIT_PER_DAY_CENTS,
        lateFeeCapCents: LATE_FEE_CAP_CENTS,
      },
    },
  };
}

// --- overview ------------------------------------------------------------

export function getOverview() {
  const state = store.getState();
  const c = ctx();
  const summaries = state.loans.map((loan) => loanSummary(loan, c));

  return {
    status: 200,
    body: {
      metrics: overviewMetrics(state, c.today),
      overdue: summaries
        .filter((loan) => loan.overdue)
        .map((loan) => ({
          ...loan,
          lateFeePreviewCents: lateFeeFor(
            state.loans.find((candidate) => candidate.id === loan.id),
            c.today,
          ),
        }))
        .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1)),
      dueToday: summaries.filter((loan) => loan.status === "out" && loan.dueDate === c.today),
      readyForPickup: summaries
        .filter((loan) => loan.status === "ready")
        .sort((a, b) => (a.pickupDate < b.pickupDate ? -1 : 1)),
      awaitingApproval: summaries.filter((loan) => loan.status === "pending_approval"),
    },
  };
}

// --- equipment -----------------------------------------------------------

export function listEquipment({ query }) {
  const state = store.getState();
  const c = ctx();
  const q = (query.q || "").trim().toLowerCase();
  const category = (query.category || "").trim();
  const availableOnly = query.availableOnly === "1" || query.availableOnly === "true";

  let items = state.equipment.map((item) => equipmentSummary(item, c));
  const totalCount = items.length;

  if (q) {
    items = items.filter((item) =>
      `${item.name} ${item.tag} ${item.description}`.toLowerCase().includes(q),
    );
  }
  if (category && category !== "All") {
    items = items.filter((item) => item.category === category);
  }
  if (availableOnly) {
    items = items.filter((item) => item.availableUnits >= 1);
  }
  items.sort((a, b) => a.name.localeCompare(b.name));

  return {
    status: 200,
    body: {
      items,
      totalCount,
      shownCount: items.length,
      filters: { q: query.q || "", category: category || "All", availableOnly },
    },
  };
}

export function getEquipment({ params }) {
  const state = store.getState();
  const item = store.findEquipment(params.id);
  if (!item) return notFound("That equipment item does not exist.");
  return { status: 200, body: { item: equipmentDetail(item, state, ctx()) } };
}

// --- loans ---------------------------------------------------------------

const LOAN_FILTERS = {
  all: () => true,
  pending_approval: (loan) => loan.status === "pending_approval",
  ready: (loan) => loan.status === "ready",
  out: (loan) => loan.status === "out",
  overdue: (loan) => loan.overdue,
  returned: (loan) => loan.status === "returned",
  cancelled: (loan) => loan.status === "cancelled",
  declined: (loan) => loan.status === "declined",
};

export function listLoans({ query }) {
  const state = store.getState();
  const c = ctx();
  const status = LOAN_FILTERS[query.status] ? query.status : "all";
  const q = (query.q || "").trim().toLowerCase();

  let loans = state.loans.map((loan) => loanSummary(loan, c));
  const totalCount = loans.length;

  loans = loans.filter(LOAN_FILTERS[status]);
  if (q) {
    loans = loans.filter(
      (loan) => loan.id.toLowerCase().includes(q) || loan.borrowerName.toLowerCase().includes(q),
    );
  }
  loans.sort((a, b) => (a.id < b.id ? 1 : -1));

  return {
    status: 200,
    body: { loans, totalCount, shownCount: loans.length, filters: { status, q: query.q || "" } },
  };
}

export function getLoan({ params }) {
  const loan = store.findLoan(params.id);
  if (!loan) return notFound("That loan does not exist.");
  return { status: 200, body: { loan: loanDetail(loan, ctx()) } };
}

export function pickupLoan({ params }) {
  const loan = store.findLoan(params.id);
  if (!loan) return notFound("That loan does not exist.");
  if (loan.status !== "ready") {
    return conflict("Only a loan that is ready for pickup can be marked picked up.");
  }
  if (loan.pickupDate > today()) {
    return conflict(`This loan is scheduled for pickup on ${formatDate(loan.pickupDate)}.`);
  }
  loan.status = "out";
  loan.pickedUpAt = nowIso();
  return {
    status: 200,
    body: {
      loan: loanDetail(loan, ctx()),
      message: `${loan.id} is now out with ${loan.borrower.name}.`,
    },
  };
}

export function extendLoan({ params }) {
  const loan = store.findLoan(params.id);
  if (!loan) return notFound("That loan does not exist.");
  const eligibility = extensionEligibility(loan, today());
  if (!eligibility.allowed) return conflict(eligibility.reason);

  loan.dueDate = extendedDueDate(loan.dueDate);
  loan.extensionsUsed += 1;
  return {
    status: 200,
    body: {
      loan: loanDetail(loan, ctx()),
      message: `Extended. ${loan.id} is now due ${formatDate(loan.dueDate)} at 17:00.`,
    },
  };
}

export async function checkinLoan({ params, body }) {
  const loan = store.findLoan(params.id);
  if (!loan) return notFound("That loan does not exist.");
  if (loan.status !== "out") return conflict("Only a loan that is out can be checked in.");

  const errors = validateCheckin(body);
  if (Object.keys(errors).length) return fieldError(errors);

  await delay(LATENCY.checkin);

  const lateFeeCents = lateFeeFor(loan, today());
  const condition = body.condition;
  const depositCents = loan.quote.depositCents;
  const depositOutcome =
    depositCents === 0 ? "none" : condition === "good" ? "released" : "held";

  loan.status = "returned";
  loan.returnedAt = nowIso();
  loan.condition = condition;
  loan.conditionNote = condition === "good" ? null : String(body.note).trim();
  loan.lateFeeCents = lateFeeCents;
  loan.depositOutcome = depositOutcome;

  const depositMessage =
    depositOutcome === "none"
      ? "No deposit was held on this loan."
      : depositOutcome === "released"
        ? `Deposit of ${formatMoney(depositCents)} released.`
        : `Deposit of ${formatMoney(depositCents)} held pending inspection.`;

  const feeMessage =
    lateFeeCents > 0
      ? `Late fee of ${formatMoney(lateFeeCents)} charged.`
      : "Returned on time, no late fee.";

  return {
    status: 200,
    body: {
      loan: loanDetail(loan, ctx()),
      lateFeeCents,
      depositOutcome,
      message: `${loan.id} checked in. ${feeMessage} ${depositMessage}`,
    },
  };
}

export function cancelLoan({ params }) {
  const loan = store.findLoan(params.id);
  if (!loan) return notFound("That loan does not exist.");
  if (loan.status !== "pending_approval" && loan.status !== "ready") {
    return conflict("Only a loan awaiting approval or ready for pickup can be cancelled.");
  }
  loan.status = "cancelled";
  loan.cancelledAt = nowIso();
  return {
    status: 200,
    body: {
      loan: loanDetail(loan, ctx()),
      message: `${loan.id} cancelled. ${loan.quote.unitCount === 1 ? "1 unit is" : `${loan.quote.unitCount} units are`} back in stock.`,
    },
  };
}

// --- approvals -----------------------------------------------------------

export function listApprovals() {
  const state = store.getState();
  const c = ctx();
  const loans = state.loans
    .filter((loan) => loan.status === "pending_approval")
    .map((loan) => ({
      ...loanSummary(loan, c),
      purpose: loan.purpose,
      quote: loan.quote,
      approvalReasons: approvalReasons(loan),
      lines: quoteFor(loan.lines, loan.loanDays, c.equipmentById).lines,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return { status: 200, body: { loans, count: loans.length } };
}

export async function approveLoan({ params }) {
  const loan = store.findLoan(params.id);
  if (!loan) return notFound("That loan does not exist.");
  if (loan.status !== "pending_approval") {
    return conflict("This loan is no longer awaiting approval.");
  }
  await delay(LATENCY.approvalDecision);

  loan.status = "ready";
  loan.decision = {
    outcome: "approved",
    decidedAt: nowIso(),
    decidedBy: OPERATOR.name,
    reason: null,
  };
  return {
    status: 200,
    body: {
      loan: loanDetail(loan, ctx()),
      message: `${loan.id} approved and moved to ready for pickup.`,
    },
  };
}

export async function declineLoan({ params, body }) {
  const loan = store.findLoan(params.id);
  if (!loan) return notFound("That loan does not exist.");
  if (loan.status !== "pending_approval") {
    return conflict("This loan is no longer awaiting approval.");
  }
  const errors = validateDecline(body);
  if (Object.keys(errors).length) return fieldError(errors);

  await delay(LATENCY.approvalDecision);

  loan.status = "declined";
  loan.decision = {
    outcome: "declined",
    decidedAt: nowIso(),
    decidedBy: OPERATOR.name,
    reason: String(body.reason).trim(),
  };
  return {
    status: 200,
    body: {
      loan: loanDetail(loan, ctx()),
      message: `${loan.id} declined. ${loan.quote.unitCount === 1 ? "1 unit is" : `${loan.quote.unitCount} units are`} back in stock.`,
    },
  };
}

// --- new-loan drafts -----------------------------------------------------

function scheduleContext() {
  const state = store.getState();
  return {
    equipmentById: indexEquipment(state.equipment),
    available: availabilityMap(state.equipment, state.loans),
    today: today(),
  };
}

function normaliseLines(input) {
  if (!Array.isArray(input)) return [];
  return input.map((line) => ({
    equipmentId: String(line.equipmentId),
    quantity: Number(line.quantity),
  }));
}

export function createDraft({ body }) {
  const errors = validateBorrower(body);
  if (Object.keys(errors).length) return fieldError(errors);

  const draft = store.addDraft({
    id: store.nextDraftId(),
    borrower: {
      name: String(body.name).trim(),
      email: String(body.email).trim(),
      department: String(body.department).trim(),
    },
    purpose: body.purpose ? String(body.purpose).trim() : "",
    lines: [],
    loanDays: 3,
    pickupDate: today(),
    createdAt: nowIso(),
  });

  return { status: 201, body: { draft: draftView(draft, ctx()) } };
}

export function getDraft({ params }) {
  const draft = store.findDraft(params.id);
  if (!draft) return notFound("That draft loan has expired. Start a new loan.");
  return { status: 200, body: { draft: draftView(draft, ctx()) } };
}

export function updateDraft({ params, body }) {
  const draft = store.findDraft(params.id);
  if (!draft) return notFound("That draft loan has expired. Start a new loan.");

  if (body.step === "borrower") {
    const errors = validateBorrower(body);
    if (Object.keys(errors).length) return fieldError(errors);
    draft.borrower = {
      name: String(body.name).trim(),
      email: String(body.email).trim(),
      department: String(body.department).trim(),
    };
    draft.purpose = body.purpose ? String(body.purpose).trim() : "";
    return { status: 200, body: { draft: draftView(draft, ctx()) } };
  }

  if (body.step === "schedule") {
    const lines = normaliseLines(body.lines);
    const payload = { lines, loanDays: Number(body.loanDays), pickupDate: body.pickupDate };
    const errors = validateSchedule(payload, scheduleContext());
    if (Object.keys(errors).length) return fieldError(errors);
    draft.lines = lines;
    draft.loanDays = Number(body.loanDays);
    draft.pickupDate = String(body.pickupDate).trim();
    return { status: 200, body: { draft: draftView(draft, ctx()) } };
  }

  return { status: 400, body: { error: { message: "Unknown draft step." } } };
}

export async function submitDraft({ params }) {
  const draft = store.findDraft(params.id);
  if (!draft) return notFound("That draft loan has expired. Start a new loan.");

  const borrowerErrors = validateBorrower({ ...draft.borrower, purpose: draft.purpose });
  if (Object.keys(borrowerErrors).length) return fieldError(borrowerErrors);

  const scheduleErrors = validateSchedule(
    { lines: draft.lines, loanDays: draft.loanDays, pickupDate: draft.pickupDate },
    scheduleContext(),
    { checkAvailability: false },
  );
  if (Object.keys(scheduleErrors).length) return fieldError(scheduleErrors);

  await delay(LATENCY.bookLoan);

  // Availability can move while a draft sits open on the review step.
  const taken = availabilityProblem(draft.lines, scheduleContext());
  if (taken) return conflict(taken);

  const c = ctx();
  const quote = quoteFor(draft.lines, draft.loanDays, c.equipmentById);
  const dueDate = computeDueDate(draft.pickupDate, draft.loanDays);
  const needsApproval = approvalRequired(quote.replacementTotalCents, draft.loanDays);

  const loan = store.addLoan({
    id: store.nextLoanId(),
    borrower: { ...draft.borrower },
    purpose: draft.purpose,
    lines: draft.lines.map((line) => ({ ...line })),
    loanDays: draft.loanDays,
    pickupDate: draft.pickupDate,
    dueDate,
    status: needsApproval ? "pending_approval" : "ready",
    bookedAt: nowIso(),
    quote: {
      baseChargeCents: quote.baseChargeCents,
      bundleDiscountCents: quote.bundleDiscountCents,
      depositCents: quote.depositCents,
      totalDueCents: quote.totalDueCents,
      unitCount: quote.unitCount,
      replacementTotalCents: quote.replacementTotalCents,
    },
    approvalRequired: needsApproval,
    decision: null,
    pickedUpAt: null,
    extensionsUsed: 0,
    returnedAt: null,
    condition: null,
    conditionNote: null,
    lateFeeCents: null,
    depositOutcome: null,
    cancelledAt: null,
  });

  store.removeDraft(draft.id);

  const message = needsApproval
    ? `${loan.id} booked and sent for supervisor approval.`
    : `${loan.id} booked and ready for pickup on ${formatDate(loan.pickupDate)}.`;

  return {
    status: 201,
    body: { loan: loanDetail(loan, ctx()), message, dueAt: dueAt(loan.dueDate) },
  };
}

// --- helpers used by tests ----------------------------------------------

export { isOverdue };
