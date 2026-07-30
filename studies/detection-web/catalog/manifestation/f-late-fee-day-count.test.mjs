export const id = "f-late-fee-day-count";
export const title = "Overdue loan L-1042 is 3 business days late for $45.00";

export async function check(c) {
  await c.reset();
  const { body } = await c.api("GET", "/api/overview");
  const loan = body.overdue.find((entry) => entry.id === "L-1042");
  c.assert(loan, "L-1042 is missing from the overdue list");
  c.assert(
    loan.lateBusinessDays === 3,
    `L-1042 reports ${loan.lateBusinessDays} business days late; SPEC R8 works it out as 3`,
  );
  c.assert(
    loan.lateFeePreviewCents === 4500,
    `L-1042 previews a late fee of ${loan.lateFeePreviewCents} cents; SPEC R8 works it out as 4500`,
  );
}
