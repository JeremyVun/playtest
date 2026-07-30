export const id = "f-saturday-roll-short";
export const title = "A Saturday due date rolls forward to the Monday";

export async function check(c) {
  await c.reset();
  const draft = await c.draft();
  const scheduled = await c.api("PATCH", `/api/loan-drafts/${draft}`, {
    step: "schedule",
    lines: [{ equipmentId: "cam-gopro", quantity: 1 }],
    loanDays: 1,
    pickupDate: "2026-03-20",
  });
  c.assert(scheduled.status === 200, `step 2 returned ${scheduled.status}`);

  const preview = scheduled.body.draft.preview;
  c.assert(
    preview.dueDate === "2026-03-23",
    `pickup Fri 20 Mar + 1 day is due ${preview.dueDate}; SPEC R3 rolls Saturday forward to 2026-03-23`,
  );
  c.assert(
    preview.dueAt === "2026-03-23T17:00:00Z",
    `due instant ${preview.dueAt}; SPEC R3 makes it 2026-03-23T17:00:00Z`,
  );
}
