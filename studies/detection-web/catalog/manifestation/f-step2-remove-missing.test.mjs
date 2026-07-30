export const id = "f-step2-remove-missing";
export const title = "Step 2 offers Remove on every item row";

const REMOVE_BUTTON = 'text: "Remove",';

export async function check(c) {
  await c.reset();
  const draft = await c.draft();
  const scheduled = await c.api("PATCH", `/api/loan-drafts/${draft}`, {
    step: "schedule",
    lines: [{ equipmentId: "cam-gopro", quantity: 1 }],
    loanDays: 3,
    pickupDate: "2026-03-16",
  });
  c.assert(scheduled.status === 200, `step 2 returned ${scheduled.status}`);
  c.assert(scheduled.body.draft.lines.length === 1, "the draft did not keep its item row");

  const source = await c.asset("/views/new-loan.js");
  c.assert(
    source.includes(REMOVE_BUTTON),
    "the served new-loan module renders item rows without a Remove button (SPEC §7.2)",
  );
}
