// Business rules, checked directly against the numbers written in SPEC.md.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { EQUIPMENT, LOANS } from "../src/data.js";
import {
  approvalRequired,
  availabilityMap,
  chargesBookedToday,
  committedUnits,
  computeDueDate,
  dueAt,
  extendedDueDate,
  extensionEligibility,
  indexEquipment,
  isOverdue,
  lateBusinessDays,
  lateFeeFor,
  latestPickupDate,
  overviewMetrics,
  quoteFor,
} from "../src/rules.js";
import {
  addDays,
  businessDaysBetween,
  formatDate,
  isBusinessDay,
  isCalendarDate,
  nextBusinessDay,
  nowIso,
  today,
} from "../src/time.js";
import { formatMoney } from "../src/format.js";

const byId = indexEquipment(EQUIPMENT);
const TODAY = "2026-03-16";

describe("desk clock", () => {
  test("defaults to the frozen reference instant", () => {
    assert.equal(nowIso(), "2026-03-16T09:00:00Z");
    assert.equal(today(), TODAY);
  });

  test("honours SUBJECT_NOW", () => {
    const previous = process.env.SUBJECT_NOW;
    process.env.SUBJECT_NOW = "2026-07-01T12:30:00Z";
    try {
      assert.equal(nowIso(), "2026-07-01T12:30:00Z");
      assert.equal(today(), "2026-07-01");
    } finally {
      if (previous === undefined) delete process.env.SUBJECT_NOW;
      else process.env.SUBJECT_NOW = previous;
    }
    assert.equal(nowIso(), "2026-03-16T09:00:00Z");
  });
});

describe("calendar helpers", () => {
  test("recognises business days", () => {
    assert.equal(isBusinessDay("2026-03-16"), true, "Monday");
    assert.equal(isBusinessDay("2026-03-20"), true, "Friday");
    assert.equal(isBusinessDay("2026-03-21"), false, "Saturday");
    assert.equal(isBusinessDay("2026-03-22"), false, "Sunday");
  });

  test("rolls a weekend date forward to Monday", () => {
    assert.equal(nextBusinessDay("2026-03-21"), "2026-03-23", "Saturday plus two");
    assert.equal(nextBusinessDay("2026-03-22"), "2026-03-23", "Sunday plus one");
    assert.equal(nextBusinessDay("2026-03-23"), "2026-03-23", "Monday unchanged");
  });

  test("counts business days after a date up to and including another", () => {
    assert.equal(businessDaysBetween("2026-03-11", "2026-03-16"), 3);
    assert.equal(businessDaysBetween("2026-03-16", "2026-03-16"), 0);
    assert.equal(businessDaysBetween("2026-03-16", "2026-03-10"), 0);
    assert.equal(businessDaysBetween("2026-03-13", "2026-03-16"), 1);
  });

  test("validates and formats calendar dates", () => {
    assert.equal(isCalendarDate("2026-02-30"), false);
    assert.equal(isCalendarDate("2026-3-1"), false);
    assert.equal(isCalendarDate("2026-03-01"), true);
    assert.equal(formatDate("2026-03-05"), "Thu 5 Mar 2026");
    assert.equal(formatDate("2026-03-16"), "Mon 16 Mar 2026");
    assert.equal(addDays("2026-03-30", 2), "2026-04-01");
  });

  test("money formatting", () => {
    assert.equal(formatMoney(0), "$0.00");
    assert.equal(formatMoney(2310), "$23.10");
    assert.equal(formatMoney(87690), "$876.90");
    assert.equal(formatMoney(900000), "$9,000.00");
  });
});

describe("due dates", () => {
  test("adds the loan period in calendar days", () => {
    assert.equal(computeDueDate("2026-03-16", 1), "2026-03-17");
    assert.equal(computeDueDate("2026-03-16", 3), "2026-03-19");
    assert.equal(computeDueDate("2026-03-16", 7), "2026-03-23");
    assert.equal(computeDueDate("2026-03-16", 14), "2026-03-30");
  });

  test("rolls a weekend due date to the next Monday", () => {
    assert.equal(computeDueDate("2026-03-19", 3), "2026-03-23", "Sunday to Monday");
    assert.equal(computeDueDate("2026-03-18", 3), "2026-03-23", "Saturday to Monday");
    assert.equal(computeDueDate("2026-03-20", 1), "2026-03-23", "Saturday to Monday");
  });

  test("due time is always 17:00 desk time", () => {
    assert.equal(dueAt("2026-03-23"), "2026-03-23T17:00:00Z");
  });

  test("the desk books pickups up to 14 days ahead", () => {
    assert.equal(latestPickupDate(TODAY), "2026-03-30");
  });
});

describe("quotes", () => {
  test("charges daily rate by quantity by loan period", () => {
    const quote = quoteFor([{ equipmentId: "cam-gopro", quantity: 2 }], 3, byId);
    assert.equal(quote.baseChargeCents, 3600, "$6.00 x 2 x 3 days");
    assert.equal(quote.bundleDiscountCents, 0, "only 2 units");
    assert.equal(quote.depositCents, 0, "replacement value under $1,000");
    assert.equal(quote.totalDueCents, 3600);
    assert.equal(quote.replacementTotalCents, 96000);
  });

  test("takes 10% off the base charge from three units", () => {
    const quote = quoteFor(
      [
        { equipmentId: "cam-c70", quantity: 1 },
        { equipmentId: "sup-tripod", quantity: 1 },
        { equipmentId: "lig-aputure", quantity: 1 },
      ],
      7,
      byId,
    );
    assert.equal(quote.unitCount, 3);
    assert.equal(quote.baseChargeCents, 23100, "($18 + $4 + $11) x 7");
    assert.equal(quote.bundleDiscountCents, 2310);
    assert.equal(quote.depositCents, 66900, "$540 + $0 + $129");
    assert.equal(quote.totalDueCents, 87690);
  });

  test("bundle discount starts at exactly three units", () => {
    const two = quoteFor([{ equipmentId: "aud-lav", quantity: 2 }], 1, byId);
    const three = quoteFor([{ equipmentId: "aud-lav", quantity: 3 }], 1, byId);
    assert.equal(two.bundleDiscountCents, 0);
    assert.equal(three.baseChargeCents, 1200);
    assert.equal(three.bundleDiscountCents, 120);
    assert.equal(three.totalDueCents, 1080);
  });

  test("deposit is 10% of replacement value per unit, from $1,000 up", () => {
    const under = quoteFor([{ equipmentId: "sup-tripod", quantity: 2 }], 1, byId);
    assert.equal(under.depositCents, 0, "$540 replacement is below the threshold");

    const over = quoteFor([{ equipmentId: "sup-gimbal", quantity: 2 }], 7, byId);
    assert.equal(over.depositCents, 20400, "$1,020 x 10% x 2 units");
    assert.equal(over.baseChargeCents, 14000);
    assert.equal(over.totalDueCents, 34400);
  });

  test("per-line detail carries the numbers the interface shows", () => {
    const quote = quoteFor([{ equipmentId: "com-mbp", quantity: 1 }], 7, byId);
    assert.deepEqual(quote.lines, [
      {
        equipmentId: "com-mbp",
        name: 'MacBook Pro 16" Edit Laptop',
        tag: "COM-MBP16",
        quantity: 1,
        dailyRateCents: 1500,
        replacementValueCents: 360000,
        lineChargeCents: 10500,
        lineDepositCents: 36000,
      },
    ]);
  });
});

describe("approval rule", () => {
  test("triggers at $2,500 of replacement value", () => {
    assert.equal(approvalRequired(249999, 7), false);
    assert.equal(approvalRequired(250000, 7), true);
    assert.equal(approvalRequired(250001, 7), true);
  });

  test("triggers on a 14-day loan whatever the value", () => {
    assert.equal(approvalRequired(100, 14), true);
    assert.equal(approvalRequired(100, 7), false);
    assert.equal(approvalRequired(100, 1), false);
  });
});

describe("availability", () => {
  test("open loans hold units; closed loans do not", () => {
    const committed = committedUnits(LOANS);
    assert.equal(committed.get("cam-c70"), 2, "one out, one awaiting approval");
    assert.equal(committed.get("aud-h6"), 1, "the returned loan releases its unit");
    assert.equal(committed.get("lig-softbox"), undefined, "the cancelled loan releases its units");
  });

  test("seeded availability matches the catalogue in SPEC.md", () => {
    const available = availabilityMap(EQUIPMENT, LOANS);
    assert.deepEqual(Object.fromEntries(available), {
      "cam-c70": 1,
      "cam-a7iv": 3,
      "cam-gopro": 4,
      "aud-h6": 4,
      "aud-lav": 7,
      "aud-boom": 1,
      "lig-aputure": 3,
      "lig-softbox": 3,
      "sup-tripod": 5,
      "sup-gimbal": 0,
      "com-mbp": 2,
      "com-drive": 7,
    });
  });
});

describe("overdue and late fees", () => {
  const overdueLoan = LOANS.find((loan) => loan.id === "L-1042");
  const dueTodayLoan = LOANS.find((loan) => loan.id === "L-1041");
  const readyLoan = LOANS.find((loan) => loan.id === "L-1043");

  test("a loan is overdue only once today is past its due date", () => {
    assert.equal(isOverdue(overdueLoan, TODAY), true);
    assert.equal(isOverdue(dueTodayLoan, TODAY), false, "due today is not yet late");
    assert.equal(isOverdue(readyLoan, TODAY), false, "not out yet");
  });

  test("counts business days late", () => {
    assert.equal(lateBusinessDays(overdueLoan, TODAY), 3, "12, 13 and 16 March");
    assert.equal(lateBusinessDays(dueTodayLoan, TODAY), 0);
  });

  test("charges $5.00 per unit per late business day", () => {
    assert.equal(lateFeeFor(overdueLoan, TODAY), 4500, "3 days x 3 units x $5.00");
    assert.equal(lateFeeFor(dueTodayLoan, TODAY), 0);
  });

  test("caps the late fee at $150.00 per loan", () => {
    const bigLoan = { ...overdueLoan, dueDate: "2026-01-05" };
    assert.equal(lateFeeFor(bigLoan, TODAY), 15000);
  });
});

describe("extensions", () => {
  test("adds seven calendar days and rolls off a weekend", () => {
    assert.equal(extendedDueDate("2026-03-19"), "2026-03-26");
    assert.equal(extendedDueDate("2026-03-14"), "2026-03-23", "Saturday result rolls to Monday");
  });

  test("only an on-time loan that is out and unextended may extend", () => {
    const out = LOANS.find((loan) => loan.id === "L-1048");
    assert.deepEqual(extensionEligibility(out, TODAY), { allowed: true, reason: null });
    assert.deepEqual(extensionEligibility({ ...out, extensionsUsed: 1 }, TODAY), {
      allowed: false,
      reason: "This loan has already used its one extension.",
    });
    assert.deepEqual(extensionEligibility(LOANS.find((l) => l.id === "L-1042"), TODAY), {
      allowed: false,
      reason: "An overdue loan cannot be extended. Check it in first.",
    });
    assert.deepEqual(extensionEligibility(LOANS.find((l) => l.id === "L-1043"), TODAY), {
      allowed: false,
      reason: "Only a loan that is out can be extended.",
    });
  });
});

describe("desk metrics", () => {
  test("charges booked today counts only loans booked today that still stand", () => {
    assert.equal(chargesBookedToday(LOANS, TODAY), 34100, "L-1044 only");
    const withCancelled = LOANS.map((loan) =>
      loan.id === "L-1044" ? { ...loan, status: "cancelled" } : loan,
    );
    assert.equal(chargesBookedToday(withCancelled, TODAY), 0);
  });

  test("charges booked today adds late fees recorded today", () => {
    const withReturn = LOANS.map((loan) =>
      loan.id === "L-1042"
        ? { ...loan, status: "returned", returnedAt: "2026-03-16T10:00:00Z", lateFeeCents: 4500 }
        : loan,
    );
    assert.equal(chargesBookedToday(withReturn, TODAY), 38600);
  });

  test("overview counters match the seeded desk", () => {
    assert.deepEqual(overviewMetrics({ equipment: EQUIPMENT, loans: LOANS }, TODAY), {
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
});

describe("seeded loans agree with the rules", () => {
  for (const loan of LOANS) {
    test(`${loan.id} due date and quote reproduce from the rules`, () => {
      assert.equal(
        computeDueDate(loan.pickupDate, loan.loanDays),
        loan.dueDate,
        "stored due date matches the due-date rule",
      );
      const quote = quoteFor(loan.lines, loan.loanDays, byId);
      assert.deepEqual(
        {
          baseChargeCents: quote.baseChargeCents,
          bundleDiscountCents: quote.bundleDiscountCents,
          depositCents: quote.depositCents,
          totalDueCents: quote.totalDueCents,
          unitCount: quote.unitCount,
          replacementTotalCents: quote.replacementTotalCents,
        },
        loan.quote,
        "stored quote matches the pricing rules",
      );
      assert.equal(
        approvalRequired(quote.replacementTotalCents, loan.loanDays),
        loan.approvalRequired,
        "stored approval flag matches the approval rule",
      );
    });
  }
});
