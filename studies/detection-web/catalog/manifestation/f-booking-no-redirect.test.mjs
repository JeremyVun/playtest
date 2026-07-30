export const id = "f-booking-no-redirect";
export const title = "A confirmed booking lands on the new loan's page";

const REDIRECT = "ctx.navigate(`/loans/${result.loan.id}`)";

export async function check(c) {
  await c.reset();
  const draft = await c.draft();
  const scheduled = await c.api("PATCH", `/api/loan-drafts/${draft}`, {
    step: "schedule",
    lines: [{ equipmentId: "cam-gopro", quantity: 1 }],
    loanDays: 3,
    pickupDate: "2026-03-17",
  });
  c.assert(scheduled.status === 200, `step 2 returned ${scheduled.status}`);

  const booked = await c.api("POST", `/api/loan-drafts/${draft}/submit`);
  c.assert(booked.status === 201, `confirming returned ${booked.status}`);
  c.assert(
    booked.body.message === "L-1049 booked and ready for pickup on Tue 17 Mar 2026.",
    `the booking message reads "${booked.body.message}"`,
  );

  const source = await c.asset("/views/new-loan.js");
  c.assert(
    source.includes(REDIRECT),
    "the served new-loan module no longer opens the booked loan after confirming (SPEC §7.3)",
  );
  c.assert(
    source.includes('ctx.setFlash("success", result.message);'),
    "the served new-loan module no longer carries the booking success banner (SPEC §7.3)",
  );
}
