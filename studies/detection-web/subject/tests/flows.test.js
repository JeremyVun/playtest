// End-to-end desk flows and the connections between them.

import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { GET, PATCH, POST, SAMPLE_BORROWER, bookLoan, reset, start, stop } from "./helpers.js";

before(start);
after(stop);
beforeEach(reset);

const availabilityOf = async (id) => {
  const { body } = await GET(`/api/equipment/${id}`);
  return body.item.availableUnits;
};

describe("flow 1 — book a loan in three steps", () => {
  test("carries the borrower across steps and books a ready loan", async () => {
    const created = await POST("/api/loan-drafts", SAMPLE_BORROWER);
    assert.equal(created.status, 201);
    const draftId = created.body.draft.id;
    assert.equal(created.body.draft.borrower.name, "Ivy Cole");
    assert.deepEqual(created.body.draft.lines, []);
    assert.equal(created.body.draft.preview, null, "no quote before items are chosen");

    const scheduled = await PATCH(`/api/loan-drafts/${draftId}`, {
      step: "schedule",
      lines: [{ equipmentId: "cam-gopro", quantity: 2 }],
      loanDays: 3,
      pickupDate: "2026-03-17",
    });
    assert.equal(scheduled.status, 200);
    assert.equal(scheduled.body.draft.borrower.email, "ivy.cole@fairmont.edu");
    assert.equal(scheduled.body.draft.preview.totalDueCents ?? null, null);
    assert.equal(scheduled.body.draft.preview.quote.totalDueCents, 3600);

    const reloaded = await GET(`/api/loan-drafts/${draftId}`);
    assert.equal(reloaded.body.draft.pickupDate, "2026-03-17");
    assert.equal(reloaded.body.draft.lines[0].name, "GoPro Hero 12 Action Kit");
    assert.equal(reloaded.body.draft.preview.dueDate, "2026-03-20");

    const submitted = await POST(`/api/loan-drafts/${draftId}/submit`);
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.loan.id, "L-1049");
    assert.equal(submitted.body.loan.status, "ready");
    assert.equal(
      submitted.body.message,
      "L-1049 booked and ready for pickup on Tue 17 Mar 2026.",
    );
    assert.equal(submitted.body.loan.dueAt, "2026-03-20T17:00:00Z");
    assert.equal(submitted.body.loan.quote.totalDueCents, 3600);

    assert.equal((await GET(`/api/loan-drafts/${draftId}`)).status, 404, "the draft is consumed");
  });

  test("routes a high-value loan into the approvals queue", async () => {
    const booked = await bookLoan({
      borrower: SAMPLE_BORROWER,
      lines: [{ equipmentId: "com-mbp", quantity: 1 }],
      loanDays: 7,
      pickupDate: "2026-03-18",
    });
    assert.equal(booked.loan.status, "pending_approval");
    assert.equal(booked.message, "L-1049 booked and sent for supervisor approval.");
    assert.deepEqual(booked.loan.approvalReasons, [
      "Replacement value $3,600.00 is at or above the $2,500.00 threshold.",
    ]);

    const queue = await GET("/api/approvals");
    assert.equal(queue.body.count, 3);
    assert.ok(queue.body.loans.some((loan) => loan.id === "L-1049"));
  });

  test("routes a 14-day loan into the approvals queue whatever it is worth", async () => {
    const booked = await bookLoan({
      borrower: SAMPLE_BORROWER,
      lines: [{ equipmentId: "com-drive", quantity: 1 }],
      loanDays: 14,
      pickupDate: "2026-03-16",
    });
    assert.equal(booked.loan.status, "pending_approval");
    assert.deepEqual(booked.loan.approvalReasons, ["Loan period is 14 days."]);
    assert.equal(booked.loan.quote.totalDueCents, 2800, "$2.00 x 14 days, no deposit");
    assert.equal(booked.loan.dueDate, "2026-03-30");
  });

  test("booking reduces availability and lifts the desk counters", async () => {
    assert.equal(await availabilityOf("cam-gopro"), 4);
    const before = (await GET("/api/overview")).body.metrics;

    await bookLoan({
      borrower: SAMPLE_BORROWER,
      lines: [{ equipmentId: "cam-gopro", quantity: 2 }],
      loanDays: 3,
      pickupDate: "2026-03-17",
    });

    assert.equal(await availabilityOf("cam-gopro"), 2);
    const after = (await GET("/api/overview")).body.metrics;
    assert.equal(after.unitsAvailable, before.unitsAvailable - 2);
    assert.equal(after.readyForPickupCount, before.readyForPickupCount + 1);
    assert.equal(
      after.chargesBookedTodayCents,
      before.chargesBookedTodayCents + 3600,
      "the new loan is booked today",
    );
  });

  test("refuses to commit a draft whose units have gone since step 2", async () => {
    const first = await POST("/api/loan-drafts", SAMPLE_BORROWER);
    await PATCH(`/api/loan-drafts/${first.body.draft.id}`, {
      step: "schedule",
      lines: [{ equipmentId: "aud-boom", quantity: 1 }],
      loanDays: 3,
      pickupDate: "2026-03-17",
    });

    // Someone else takes the last boom kit while the draft sits on step 3.
    await bookLoan({
      borrower: { ...SAMPLE_BORROWER, name: "Kit Rivera" },
      lines: [{ equipmentId: "aud-boom", quantity: 1 }],
      loanDays: 3,
      pickupDate: "2026-03-17",
    });

    const submitted = await POST(`/api/loan-drafts/${first.body.draft.id}/submit`);
    assert.equal(submitted.status, 409);
    assert.equal(submitted.body.error.message, "Sennheiser MKH-416 Boom Kit has no units available.");
  });

  test("a draft can be sent back to step 1 and corrected", async () => {
    const created = await POST("/api/loan-drafts", SAMPLE_BORROWER);
    const draftId = created.body.draft.id;
    const corrected = await PATCH(`/api/loan-drafts/${draftId}`, {
      step: "borrower",
      name: "Ivy Cole-Barnes",
      email: "ivy.cole@fairmont.edu",
      department: "Journalism",
      purpose: "Newsroom night shift.",
    });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.body.draft.borrower.name, "Ivy Cole-Barnes");
    assert.equal(corrected.body.draft.borrower.department, "Journalism");
  });
});

describe("flow 2 — approvals queue", () => {
  test("approving moves the request onto the pickup shelf", async () => {
    const approved = await POST("/api/approvals/L-1044/approve");
    assert.equal(approved.status, 200);
    assert.equal(approved.body.message, "L-1044 approved and moved to ready for pickup.");
    assert.equal(approved.body.loan.status, "ready");
    assert.deepEqual(approved.body.loan.decision, {
      outcome: "approved",
      decidedAt: "2026-03-16T09:00:00Z",
      decidedBy: "Rowan Ellis",
      reason: null,
    });

    const queue = await GET("/api/approvals");
    assert.equal(queue.body.count, 1);
    const metrics = (await GET("/api/overview")).body.metrics;
    assert.equal(metrics.awaitingApprovalCount, 1);
    assert.equal(metrics.readyForPickupCount, 2);
  });

  test("approving keeps the units committed", async () => {
    assert.equal(await availabilityOf("aud-boom"), 1);
    await POST("/api/approvals/L-1044/approve");
    assert.equal(await availabilityOf("aud-boom"), 1, "still held for the borrower");
  });

  test("declining releases the units and records the reason", async () => {
    assert.equal(await availabilityOf("com-mbp"), 2);
    const declined = await POST("/api/approvals/L-1045/decline", {
      reason: "Kit is committed to the open day.",
    });
    assert.equal(declined.status, 200);
    assert.equal(declined.body.message, "L-1045 declined. 2 units are back in stock.");
    assert.equal(declined.body.loan.status, "declined");
    assert.equal(declined.body.loan.decision.reason, "Kit is committed to the open day.");

    assert.equal(await availabilityOf("com-mbp"), 3);
    assert.equal(await availabilityOf("cam-c70"), 2);
    const declinedList = await GET("/api/loans?status=declined");
    assert.deepEqual(
      declinedList.body.loans.map((loan) => loan.id),
      ["L-1045"],
    );
  });

  test("declining a loan booked today removes it from today's charges", async () => {
    const before = (await GET("/api/overview")).body.metrics;
    assert.equal(before.chargesBookedTodayCents, 34100);
    await POST("/api/approvals/L-1044/decline", { reason: "Chapel booking fell through." });
    const after = (await GET("/api/overview")).body.metrics;
    assert.equal(after.chargesBookedTodayCents, 0);
  });

  test("the queue empties out completely", async () => {
    await POST("/api/approvals/L-1044/approve");
    await POST("/api/approvals/L-1045/approve");
    const queue = await GET("/api/approvals");
    assert.equal(queue.body.count, 0);
    assert.deepEqual(queue.body.loans, []);
  });
});

describe("flow 3 — pickup and extension", () => {
  test("a loan scheduled for today can be marked picked up", async () => {
    await POST("/api/approvals/L-1044/approve");
    const picked = await POST("/api/loans/L-1044/pickup");
    assert.equal(picked.status, 200);
    assert.equal(picked.body.message, "L-1044 is now out with Theo Lindqvist.");
    assert.equal(picked.body.loan.status, "out");
    assert.equal(picked.body.loan.pickedUpAt, "2026-03-16T09:00:00Z");
    assert.equal(picked.body.loan.dueDate, "2026-03-30", "the due date was fixed at booking");

    const metrics = (await GET("/api/overview")).body.metrics;
    assert.equal(metrics.outCount, 4);
  });

  test("extending moves the due date seven days and spends the one allowance", async () => {
    const extended = await POST("/api/loans/L-1048/extend");
    assert.equal(extended.status, 200);
    assert.equal(extended.body.message, "Extended. L-1048 is now due Thu 26 Mar 2026 at 17:00.");
    assert.equal(extended.body.loan.dueAt, "2026-03-26T17:00:00Z");
    assert.equal(extended.body.loan.extensionsUsed, 1);
    assert.equal(extended.body.loan.actions.canExtend, false);

    const again = await POST("/api/loans/L-1048/extend");
    assert.equal(again.status, 409);
    assert.equal(again.body.error.message, "This loan has already used its one extension.");
  });

  test("extending a loan due today clears it from the due-today list", async () => {
    const before = (await GET("/api/overview")).body;
    assert.deepEqual(
      before.dueToday.map((loan) => loan.id),
      ["L-1041"],
    );
    await POST("/api/loans/L-1041/extend");
    const after = (await GET("/api/overview")).body;
    assert.deepEqual(after.dueToday, []);
    assert.equal(after.metrics.dueTodayCount, 0);
  });
});

describe("flow 4 — check-in", () => {
  test("an on-time return closes the loan with no late fee and frees the units", async () => {
    assert.equal(await availabilityOf("cam-a7iv"), 3);
    const result = await POST("/api/loans/L-1041/checkin", { condition: "good" });
    assert.equal(result.status, 200);
    assert.equal(result.body.lateFeeCents, 0);
    assert.equal(result.body.depositOutcome, "released");
    assert.equal(
      result.body.message,
      "L-1041 checked in. Returned on time, no late fee. Deposit of $290.00 released.",
    );
    assert.equal(result.body.loan.status, "returned");
    assert.equal(result.body.loan.returnedAt, "2026-03-16T09:00:00Z");
    assert.equal(await availabilityOf("cam-a7iv"), 4);
  });

  test("a late damaged return charges the fee and holds the deposit", async () => {
    const result = await POST("/api/loans/L-1042/checkin", {
      condition: "damaged",
      note: "Cracked tripod leg lock.",
    });
    assert.equal(result.body.lateFeeCents, 4500);
    assert.equal(result.body.depositOutcome, "held");
    assert.equal(
      result.body.message,
      "L-1042 checked in. Late fee of $45.00 charged. Deposit of $669.00 held pending inspection.",
    );
    assert.equal(result.body.loan.conditionLabel, "Damaged");
    assert.equal(result.body.loan.conditionNote, "Cracked tripod leg lock.");

    const metrics = (await GET("/api/overview")).body.metrics;
    assert.equal(metrics.overdueCount, 0);
    assert.equal(metrics.chargesBookedTodayCents, 34100 + 4500);
  });

  test("a return with no deposit says so plainly", async () => {
    await POST("/api/approvals/L-1044/approve");
    await POST("/api/loans/L-1044/pickup");
    await POST("/api/loans/L-1041/checkin", { condition: "good" });

    const cheap = await bookLoan({
      borrower: SAMPLE_BORROWER,
      lines: [{ equipmentId: "com-drive", quantity: 1 }],
      loanDays: 1,
      pickupDate: "2026-03-16",
    });
    await POST(`/api/loans/${cheap.loan.id}/pickup`);
    const result = await POST(`/api/loans/${cheap.loan.id}/checkin`, { condition: "good" });
    assert.equal(result.body.depositOutcome, "none");
    assert.match(result.body.message, /No deposit was held on this loan\.$/);
  });

  test("check-in shows up on the equipment record", async () => {
    const before = await GET("/api/equipment/lig-aputure");
    assert.deepEqual(
      before.body.item.holders.map((holder) => holder.id),
      ["L-1042"],
    );
    await POST("/api/loans/L-1042/checkin", {
      condition: "good",
    });
    const after = await GET("/api/equipment/lig-aputure");
    assert.deepEqual(after.body.item.holders, []);
    assert.equal(after.body.item.availableUnits, 4);
  });
});

describe("flow 5 — cancel", () => {
  test("cancelling a ready loan returns its units to the shelf", async () => {
    assert.equal(await availabilityOf("cam-gopro"), 4);
    const cancelled = await POST("/api/loans/L-1043/cancel");
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.message, "L-1043 cancelled. 2 units are back in stock.");
    assert.equal(cancelled.body.loan.status, "cancelled");
    assert.equal(cancelled.body.loan.cancelledAt, "2026-03-16T09:00:00Z");
    assert.equal(await availabilityOf("cam-gopro"), 6);
    assert.equal((await GET("/api/overview")).body.metrics.readyForPickupCount, 0);
  });

  test("cancelling a request pulls it out of the approvals queue", async () => {
    await POST("/api/loans/L-1045/cancel");
    const queue = await GET("/api/approvals");
    assert.equal(queue.body.count, 1);
    assert.deepEqual(
      queue.body.loans.map((loan) => loan.id),
      ["L-1044"],
    );
  });

  test("a cancelled loan cannot be picked up afterwards", async () => {
    await POST("/api/loans/L-1043/cancel");
    const picked = await POST("/api/loans/L-1043/pickup");
    assert.equal(picked.status, 409);
  });
});

describe("flow 6 — the whole desk day", () => {
  test("book, approve, pick up, extend and check in, and the overview follows", async () => {
    const booked = await bookLoan({
      borrower: SAMPLE_BORROWER,
      lines: [
        { equipmentId: "cam-a7iv", quantity: 2 },
        { equipmentId: "aud-lav", quantity: 1 },
      ],
      loanDays: 7,
      pickupDate: "2026-03-16",
    });
    const id = booked.loan.id;
    assert.equal(booked.loan.status, "pending_approval", "$6,160 of kit needs approval");
    assert.equal(booked.loan.quote.baseChargeCents, 19600);
    assert.equal(booked.loan.quote.bundleDiscountCents, 1960);
    assert.equal(booked.loan.quote.depositCents, 58000);
    assert.equal(booked.loan.quote.totalDueCents, 75640);

    await POST(`/api/approvals/${id}/approve`);
    await POST(`/api/loans/${id}/pickup`);
    const extended = await POST(`/api/loans/${id}/extend`);
    assert.equal(extended.body.loan.dueDate, "2026-03-30", "23 March plus seven days");

    const checkedIn = await POST(`/api/loans/${id}/checkin`, { condition: "good" });
    assert.equal(checkedIn.body.lateFeeCents, 0);

    const metrics = (await GET("/api/overview")).body.metrics;
    assert.equal(metrics.unitsAvailable, 40, "every unit is back where it started");
    assert.equal(metrics.chargesBookedTodayCents, 34100 + 75640);
    assert.equal(metrics.awaitingApprovalCount, 2);
  });
});
