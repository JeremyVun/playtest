// HTTP surface: reads, filters, empty states, validation and the reset hook.

import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { GET, PATCH, POST, SAMPLE_BORROWER, bookLoan, reset, start, stop } from "./helpers.js";

before(start);
after(stop);
beforeEach(reset);

describe("session", () => {
  test("publishes the frozen desk clock and the form choices", async () => {
    const { status, body } = await GET("/api/session");
    assert.equal(status, 200);
    assert.deepEqual(body.operator, { name: "Rowan Ellis", role: "Desk supervisor" });
    assert.deepEqual(body.deskTime, {
      iso: "2026-03-16T09:00:00Z",
      date: "2026-03-16",
      time: "09:00",
      formatted: "Mon 16 Mar 2026, 09:00",
    });
    assert.equal(body.latestPickupDate, "2026-03-30");
    assert.deepEqual(body.loanDayOptions, [1, 3, 7, 14]);
    assert.deepEqual(body.departments, [
      "Architecture",
      "Athletics",
      "Design",
      "Film & Media",
      "Journalism",
      "Music",
      "Student Life",
    ]);
    assert.deepEqual(body.categories, ["Audio", "Cameras", "Computing", "Lighting", "Support"]);
  });
});

describe("desk overview", () => {
  test("reports the seeded counters", async () => {
    const { body } = await GET("/api/overview");
    assert.deepEqual(body.metrics, {
      outCount: 3,
      overdueCount: 1,
      dueTodayCount: 1,
      awaitingApprovalCount: 2,
      readyForPickupCount: 1,
      unitsAvailable: 40,
      unitsTotal: 53,
      chargesBookedTodayCents: 34100,
    });
  });

  test("lists the one overdue loan with its late-fee preview", async () => {
    const { body } = await GET("/api/overview");
    assert.equal(body.overdue.length, 1);
    assert.equal(body.overdue[0].id, "L-1042");
    assert.equal(body.overdue[0].statusLabel, "Overdue");
    assert.equal(body.overdue[0].lateBusinessDays, 3);
    assert.equal(body.overdue[0].lateFeePreviewCents, 4500);
    assert.equal(body.overdue[0].itemsLabel, "Canon C70 Cinema Camera + 2 more");
  });

  test("separates due-today from overdue", async () => {
    const { body } = await GET("/api/overview");
    assert.deepEqual(
      body.dueToday.map((loan) => loan.id),
      ["L-1041"],
    );
    assert.equal(body.dueToday[0].statusLabel, "Out");
    assert.deepEqual(
      body.readyForPickup.map((loan) => loan.id),
      ["L-1043"],
    );
    assert.deepEqual(
      body.awaitingApproval.map((loan) => loan.id),
      ["L-1044", "L-1045"],
    );
  });
});

describe("equipment", () => {
  test("lists the whole catalogue A to Z with availability", async () => {
    const { body } = await GET("/api/equipment");
    assert.equal(body.totalCount, 12);
    assert.equal(body.shownCount, 12);
    assert.deepEqual(
      body.items.map((item) => item.name),
      [...body.items.map((item) => item.name)].sort((a, b) => a.localeCompare(b)),
    );
    const c70 = body.items.find((item) => item.id === "cam-c70");
    assert.equal(c70.availableUnits, 1);
    assert.equal(c70.totalUnits, 3);
    assert.equal(c70.dailyRateCents, 1800);
    assert.equal(c70.depositPerUnitCents, 54000);
    const tripod = body.items.find((item) => item.id === "sup-tripod");
    assert.equal(tripod.depositPerUnitCents, 0, "under the $1,000 deposit threshold");
  });

  test("searches name, asset tag and description", async () => {
    const byName = await GET("/api/equipment?q=gimbal");
    assert.deepEqual(
      byName.body.items.map((item) => item.id),
      ["sup-gimbal"],
    );
    const byTag = await GET("/api/equipment?q=AUD-416");
    assert.deepEqual(
      byTag.body.items.map((item) => item.id),
      ["aud-boom"],
    );
    const byDescription = await GET("/api/equipment?q=exFAT");
    assert.deepEqual(
      byDescription.body.items.map((item) => item.id),
      ["com-drive"],
    );
  });

  test("filters by category and by availability, and composes them", async () => {
    const cameras = await GET("/api/equipment?category=Cameras");
    assert.equal(cameras.body.shownCount, 3);
    assert.equal(cameras.body.totalCount, 12);

    const free = await GET("/api/equipment?availableOnly=1");
    assert.equal(free.body.shownCount, 11, "the gimbal is fully booked");

    const both = await GET("/api/equipment?category=Support&availableOnly=1");
    assert.deepEqual(
      both.body.items.map((item) => item.id),
      ["sup-tripod"],
    );
  });

  test("reports an empty result rather than an error", async () => {
    const { status, body } = await GET("/api/equipment?q=submarine");
    assert.equal(status, 200);
    assert.deepEqual(body.items, []);
    assert.equal(body.shownCount, 0);
    assert.equal(body.totalCount, 12);
  });

  test("item detail lists the open loans holding units", async () => {
    const { body } = await GET("/api/equipment/cam-c70");
    assert.equal(body.item.name, "Canon C70 Cinema Camera");
    assert.equal(body.item.availableUnits, 1);
    assert.equal(body.item.specs.length, 4);
    assert.deepEqual(
      body.item.holders.map((holder) => [holder.id, holder.quantity, holder.statusLabel]),
      [
        ["L-1042", 1, "Overdue"],
        ["L-1045", 1, "Awaiting approval"],
      ],
    );
  });

  test("an item with nothing out has no holders", async () => {
    const { body } = await GET("/api/equipment/com-drive");
    assert.deepEqual(body.item.holders, []);
  });

  test("an unknown item is a plain 404", async () => {
    const { status, body } = await GET("/api/equipment/nope");
    assert.equal(status, 404);
    assert.equal(body.error.message, "That equipment item does not exist.");
  });
});

describe("loans list", () => {
  test("returns every loan, newest first", async () => {
    const { body } = await GET("/api/loans");
    assert.equal(body.totalCount, 8);
    assert.deepEqual(
      body.loans.map((loan) => loan.id),
      ["L-1048", "L-1047", "L-1046", "L-1045", "L-1044", "L-1043", "L-1042", "L-1041"],
    );
  });

  test("filters by status, with overdue as a subset of out", async () => {
    const out = await GET("/api/loans?status=out");
    assert.deepEqual(
      out.body.loans.map((loan) => loan.id),
      ["L-1048", "L-1042", "L-1041"],
    );
    const overdue = await GET("/api/loans?status=overdue");
    assert.deepEqual(
      overdue.body.loans.map((loan) => loan.id),
      ["L-1042"],
    );
    const returned = await GET("/api/loans?status=returned");
    assert.deepEqual(
      returned.body.loans.map((loan) => loan.id),
      ["L-1046"],
    );
  });

  test("searches loan number and borrower name, ignoring case", async () => {
    const byName = await GET("/api/loans?q=webb");
    assert.deepEqual(
      byName.body.loans.map((loan) => loan.id),
      ["L-1042"],
    );
    const byId = await GET("/api/loans?q=1047");
    assert.deepEqual(
      byId.body.loans.map((loan) => loan.id),
      ["L-1047"],
    );
  });

  test("returns an empty list when nothing matches", async () => {
    const { status, body } = await GET("/api/loans?status=declined");
    assert.equal(status, 200);
    assert.deepEqual(body.loans, []);
    assert.equal(body.shownCount, 0);
    assert.equal(body.totalCount, 8);
  });
});

describe("loan detail", () => {
  test("shows the stored quote, the derived late fee and the allowed actions", async () => {
    const { body } = await GET("/api/loans/L-1042");
    const loan = body.loan;
    assert.equal(loan.statusLabel, "Overdue");
    assert.equal(loan.overdue, true);
    assert.equal(loan.dueAt, "2026-03-11T17:00:00Z");
    assert.deepEqual(loan.quote, {
      baseChargeCents: 23100,
      bundleDiscountCents: 2310,
      depositCents: 66900,
      totalDueCents: 87690,
      unitCount: 3,
      replacementTotalCents: 723000,
    });
    assert.equal(loan.lateFeePreviewCents, 4500);
    assert.deepEqual(loan.actions, {
      canPickup: false,
      pickupBlockedReason: null,
      canExtend: false,
      extendBlockedReason: "An overdue loan cannot be extended. Check it in first.",
      extendedDueDate: null,
      canCheckin: true,
      canCancel: false,
    });
  });

  test("blocks pickup before the scheduled day and explains when", async () => {
    const { body } = await GET("/api/loans/L-1043");
    assert.equal(body.loan.actions.canPickup, false);
    assert.equal(
      body.loan.actions.pickupBlockedReason,
      "This loan is scheduled for pickup on Tue 17 Mar 2026.",
    );
    assert.equal(body.loan.actions.canCancel, true);
  });

  test("offers the extension date on an on-time loan that is out", async () => {
    const { body } = await GET("/api/loans/L-1048");
    assert.equal(body.loan.actions.canExtend, true);
    assert.equal(body.loan.actions.extendedDueDate, "2026-03-26");
  });

  test("keeps the closed record of a returned loan", async () => {
    const { body } = await GET("/api/loans/L-1046");
    assert.equal(body.loan.statusLabel, "Returned");
    assert.equal(body.loan.conditionLabel, "Good");
    assert.equal(body.loan.lateFeeCents, 0);
    assert.equal(body.loan.depositOutcome, "none");
    assert.deepEqual(body.loan.actions, {
      canPickup: false,
      pickupBlockedReason: null,
      canExtend: false,
      extendBlockedReason: "Only a loan that is out can be extended.",
      extendedDueDate: null,
      canCheckin: false,
      canCancel: false,
    });
  });

  test("an unknown loan is a plain 404", async () => {
    const { status, body } = await GET("/api/loans/L-9999");
    assert.equal(status, 404);
    assert.equal(body.error.message, "That loan does not exist.");
  });
});

describe("borrower validation", () => {
  test("names every missing field at once", async () => {
    const { status, body } = await POST("/api/loan-drafts", {
      name: "",
      email: "",
      department: "",
    });
    assert.equal(status, 400);
    assert.equal(body.error.message, "Check the highlighted fields.");
    assert.deepEqual(body.error.fields, {
      name: "Enter the borrower's full name.",
      email: "Enter the borrower's email address.",
      department: "Choose a department.",
    });
  });

  test("rejects a one-character name", async () => {
    const { body } = await POST("/api/loan-drafts", {
      ...SAMPLE_BORROWER,
      name: "J",
    });
    assert.equal(body.error.fields.name, "Borrower name must be at least 2 characters.");
  });

  test("requires a fairmont.edu address", async () => {
    const { body } = await POST("/api/loan-drafts", {
      ...SAMPLE_BORROWER,
      email: "ivy.cole@gmail.com",
    });
    assert.equal(body.error.fields.email, "Borrower email must be a fairmont.edu address.");
  });

  test("accepts a fairmont.edu address in any case", async () => {
    const { status } = await POST("/api/loan-drafts", {
      ...SAMPLE_BORROWER,
      email: "Ivy.Cole@Fairmont.EDU",
    });
    assert.equal(status, 201);
  });

  test("rejects a department that is not on the list", async () => {
    const { body } = await POST("/api/loan-drafts", {
      ...SAMPLE_BORROWER,
      department: "Physics",
    });
    assert.equal(body.error.fields.department, "Choose a department.");
  });

  test("caps the purpose at 200 characters", async () => {
    const { body } = await POST("/api/loan-drafts", {
      ...SAMPLE_BORROWER,
      purpose: "x".repeat(201),
    });
    assert.equal(body.error.fields.purpose, "Purpose must be 200 characters or fewer.");

    const ok = await POST("/api/loan-drafts", { ...SAMPLE_BORROWER, purpose: "x".repeat(200) });
    assert.equal(ok.status, 201);
  });
});

describe("schedule validation", () => {
  let draftId;

  beforeEach(async () => {
    const created = await POST("/api/loan-drafts", SAMPLE_BORROWER);
    draftId = created.body.draft.id;
  });

  const patchSchedule = (payload) =>
    PATCH(`/api/loan-drafts/${draftId}`, { step: "schedule", ...payload });

  test("requires at least one item", async () => {
    const { status, body } = await patchSchedule({
      lines: [],
      loanDays: 3,
      pickupDate: "2026-03-17",
    });
    assert.equal(status, 400);
    assert.equal(body.error.fields.items, "Add at least one item to this loan.");
  });

  test("refuses more units than the desk has free", async () => {
    const { body } = await patchSchedule({
      lines: [{ equipmentId: "cam-c70", quantity: 2 }],
      loanDays: 3,
      pickupDate: "2026-03-17",
    });
    assert.equal(body.error.fields.items, "Only 1 unit of Canon C70 Cinema Camera is available.");
  });

  test("uses the plural form when more than one unit is free", async () => {
    const { body } = await patchSchedule({
      lines: [{ equipmentId: "com-mbp", quantity: 3 }],
      loanDays: 3,
      pickupDate: "2026-03-17",
    });
    assert.equal(
      body.error.fields.items,
      'Only 2 units of MacBook Pro 16" Edit Laptop are available.',
    );
  });

  test("refuses a fully booked item", async () => {
    const { body } = await patchSchedule({
      lines: [{ equipmentId: "sup-gimbal", quantity: 1 }],
      loanDays: 3,
      pickupDate: "2026-03-17",
    });
    assert.equal(body.error.fields.items, "DJI RS 4 Pro Gimbal has no units available.");
  });

  test("refuses a quantity below one", async () => {
    const { body } = await patchSchedule({
      lines: [{ equipmentId: "cam-gopro", quantity: 0 }],
      loanDays: 3,
      pickupDate: "2026-03-17",
    });
    assert.equal(body.error.fields.items, "Quantity must be at least 1.");
  });

  test("refuses the same item twice", async () => {
    const { body } = await patchSchedule({
      lines: [
        { equipmentId: "cam-gopro", quantity: 1 },
        { equipmentId: "cam-gopro", quantity: 1 },
      ],
      loanDays: 3,
      pickupDate: "2026-03-17",
    });
    assert.equal(body.error.fields.items, "Each item can appear only once on a loan.");
  });

  test("refuses an item that is not in the catalogue", async () => {
    const { body } = await patchSchedule({
      lines: [{ equipmentId: "cam-imaginary", quantity: 1 }],
      loanDays: 3,
      pickupDate: "2026-03-17",
    });
    assert.equal(body.error.fields.items, "That equipment is no longer in the catalogue.");
  });

  test("refuses a loan period that is not offered", async () => {
    const { body } = await patchSchedule({
      lines: [{ equipmentId: "cam-gopro", quantity: 1 }],
      loanDays: 5,
      pickupDate: "2026-03-17",
    });
    assert.equal(body.error.fields.loanDays, "Choose a loan period.");
  });

  test("walks the pickup-date rules in order", async () => {
    const lines = [{ equipmentId: "cam-gopro", quantity: 1 }];
    const cases = [
      ["", "Choose a pickup date."],
      ["17/03/2026", "Enter a pickup date as YYYY-MM-DD."],
      ["2026-03-15", "Pickup date cannot be in the past."],
      ["2026-03-31", "Pickup date must be on or before 2026-03-30."],
      ["2026-03-21", "The desk is closed at weekends. Choose a weekday."],
    ];
    for (const [pickupDate, message] of cases) {
      const { body } = await patchSchedule({ lines, loanDays: 3, pickupDate });
      assert.equal(body.error.fields.pickupDate, message, `pickup date ${pickupDate || "(blank)"}`);
    }
  });

  test("accepts both boundary pickup dates", async () => {
    const lines = [{ equipmentId: "cam-gopro", quantity: 1 }];
    const todayOk = await patchSchedule({ lines, loanDays: 3, pickupDate: "2026-03-16" });
    assert.equal(todayOk.status, 200);
    const latestOk = await patchSchedule({ lines, loanDays: 3, pickupDate: "2026-03-30" });
    assert.equal(latestOk.status, 200);
  });

  test("previews the quote, due date and approval decision", async () => {
    const { body } = await patchSchedule({
      lines: [
        { equipmentId: "cam-a7iv", quantity: 2 },
        { equipmentId: "aud-lav", quantity: 1 },
        { equipmentId: "sup-tripod", quantity: 1 },
      ],
      loanDays: 7,
      pickupDate: "2026-03-18",
    });
    const preview = body.draft.preview;
    assert.equal(preview.quote.unitCount, 4);
    assert.equal(preview.quote.baseChargeCents, 22400);
    assert.equal(preview.quote.bundleDiscountCents, 2240);
    assert.equal(preview.quote.depositCents, 58000);
    assert.equal(preview.quote.totalDueCents, 78160);
    assert.equal(preview.dueDate, "2026-03-25");
    assert.equal(preview.dueAt, "2026-03-25T17:00:00Z");
    assert.equal(preview.approvalRequired, true);
    assert.deepEqual(preview.approvalReasons, [
      "Replacement value $6,700.00 is at or above the $2,500.00 threshold.",
    ]);
  });

  test("a missing draft says so instead of failing silently", async () => {
    const { status, body } = await GET("/api/loan-drafts/D-404");
    assert.equal(status, 404);
    assert.equal(body.error.message, "That draft loan has expired. Start a new loan.");
  });
});

describe("check-in and decline validation", () => {
  test("requires a condition", async () => {
    const { status, body } = await POST("/api/loans/L-1042/checkin", { condition: "" });
    assert.equal(status, 400);
    assert.equal(body.error.fields.condition, "Select the returned condition.");
  });

  test("requires a note when the kit is not in good condition", async () => {
    const short = await POST("/api/loans/L-1042/checkin", { condition: "damaged", note: "bent" });
    assert.equal(short.body.error.fields.note, "Describe the condition in at least 10 characters.");
    const missing = await POST("/api/loans/L-1042/checkin", { condition: "missing_parts" });
    assert.equal(
      missing.body.error.fields.note,
      "Describe the condition in at least 10 characters.",
    );
  });

  test("requires a decline reason of at least five characters", async () => {
    const { status, body } = await POST("/api/approvals/L-1044/decline", { reason: "no" });
    assert.equal(status, 400);
    assert.equal(
      body.error.fields.reason,
      "Give a reason for declining (at least 5 characters).",
    );
  });
});

describe("state conflicts", () => {
  test("a loan that is not ready cannot be marked picked up", async () => {
    const { status, body } = await POST("/api/loans/L-1042/pickup");
    assert.equal(status, 409);
    assert.equal(
      body.error.message,
      "Only a loan that is ready for pickup can be marked picked up.",
    );
  });

  test("a loan cannot be picked up before its scheduled day", async () => {
    const { status, body } = await POST("/api/loans/L-1043/pickup");
    assert.equal(status, 409);
    assert.equal(body.error.message, "This loan is scheduled for pickup on Tue 17 Mar 2026.");
  });

  test("only an out loan can be checked in", async () => {
    const { status, body } = await POST("/api/loans/L-1043/checkin", { condition: "good" });
    assert.equal(status, 409);
    assert.equal(body.error.message, "Only a loan that is out can be checked in.");
  });

  test("a returned loan cannot be cancelled", async () => {
    const { status, body } = await POST("/api/loans/L-1046/cancel");
    assert.equal(status, 409);
    assert.equal(
      body.error.message,
      "Only a loan awaiting approval or ready for pickup can be cancelled.",
    );
  });

  test("a decided request cannot be decided again", async () => {
    await POST("/api/approvals/L-1044/approve");
    const { status, body } = await POST("/api/approvals/L-1044/approve");
    assert.equal(status, 409);
    assert.equal(body.error.message, "This loan is no longer awaiting approval.");
  });
});

describe("transport", () => {
  test("unknown endpoints are 404 and wrong methods are 405", async () => {
    const missing = await GET("/api/nothing");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.message, "No such endpoint.");

    const wrongMethod = await POST("/api/overview");
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.body.error.message, "POST is not allowed on this endpoint.");
  });

  test("application routes serve the page shell, unknown ones serve a 404 shell", async () => {
    for (const path of ["/", "/equipment", "/equipment/cam-c70", "/loans", "/loans/L-1041", "/new-loan", "/approvals"]) {
      const response = await fetch(`${await start()}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-type"), /text\/html/);
    }
    const unknown = await fetch(`${await start()}/nowhere`);
    assert.equal(unknown.status, 404);
    assert.match(unknown.headers.get("content-type"), /text\/html/);
  });

  test("static assets are served with the right content type", async () => {
    const base = await start();
    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);
    const js = await fetch(`${base}/views/overview.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /javascript/);
    const missing = await fetch(`${base}/nope.js`);
    assert.equal(missing.status, 404);
  });

  test("a malformed body is refused politely", async () => {
    const base = await start();
    const response = await fetch(`${base}/api/loan-drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.message, "The request body was not valid JSON.");
  });
});

describe("reset hook", () => {
  test("restores the exact seeded state after heavy use", async () => {
    const before = {
      overview: (await GET("/api/overview")).body,
      equipment: (await GET("/api/equipment")).body,
      loans: (await GET("/api/loans")).body,
      approvals: (await GET("/api/approvals")).body,
      loan: (await GET("/api/loans/L-1042")).body,
    };

    await bookLoan({
      borrower: SAMPLE_BORROWER,
      lines: [{ equipmentId: "cam-gopro", quantity: 2 }],
      loanDays: 3,
      pickupDate: "2026-03-17",
    });
    await POST("/api/approvals/L-1044/approve");
    await POST("/api/approvals/L-1045/decline", { reason: "Committed to the open day." });
    await POST("/api/loans/L-1042/checkin", {
      condition: "damaged",
      note: "Cracked tripod leg lock.",
    });
    await POST("/api/loans/L-1048/extend");

    const changed = (await GET("/api/overview")).body;
    assert.notDeepEqual(changed.metrics, before.overview.metrics, "the desk really did move");

    const { status, body } = await POST("/__reset");
    assert.equal(status, 200);
    assert.deepEqual(body, { reset: true, now: "2026-03-16T09:00:00Z" });

    assert.deepEqual((await GET("/api/overview")).body, before.overview);
    assert.deepEqual((await GET("/api/equipment")).body, before.equipment);
    assert.deepEqual((await GET("/api/loans")).body, before.loans);
    assert.deepEqual((await GET("/api/approvals")).body, before.approvals);
    assert.deepEqual((await GET("/api/loans/L-1042")).body, before.loan);
  });

  test("restores the loan numbering and clears drafts", async () => {
    const first = await bookLoan({
      borrower: SAMPLE_BORROWER,
      lines: [{ equipmentId: "cam-gopro", quantity: 1 }],
      loanDays: 1,
      pickupDate: "2026-03-17",
    });
    assert.equal(first.loan.id, "L-1049");

    const draft = await POST("/api/loan-drafts", SAMPLE_BORROWER);
    assert.equal(draft.body.draft.id, "D-2");

    await POST("/__reset");

    const afterReset = await bookLoan({
      borrower: SAMPLE_BORROWER,
      lines: [{ equipmentId: "cam-gopro", quantity: 1 }],
      loanDays: 1,
      pickupDate: "2026-03-17",
    });
    assert.equal(afterReset.loan.id, "L-1049", "loan numbering starts again");
    assert.equal((await GET("/api/loan-drafts/D-2")).status, 404, "old drafts are gone");
  });

  test("the build hook reports the clean subject and the frozen clock", async () => {
    const response = await fetch(`${await start()}/__build`);
    assert.deepEqual(await response.json(), {
      app: "Loanpoint",
      variant: "clean",
      now: "2026-03-16T09:00:00Z",
    });
  });
});
