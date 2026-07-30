export const id = "f-bundle-threshold-off-by-one";
export const title = "Three units earn the 10% bundle discount";

export async function check(c) {
  await c.reset();
  const draft = await c.draft();
  const scheduled = await c.api("PATCH", `/api/loan-drafts/${draft}`, {
    step: "schedule",
    lines: [{ equipmentId: "cam-gopro", quantity: 3 }],
    loanDays: 7,
    pickupDate: "2026-03-16",
  });
  c.assert(scheduled.status === 200, `step 2 returned ${scheduled.status}`);

  const quote = scheduled.body.draft.preview.quote;
  c.assert(quote.unitCount === 3, `the draft holds ${quote.unitCount} units, expected 3`);
  c.assert(quote.baseChargeCents === 12600, `base charge ${quote.baseChargeCents}, expected 12600`);
  c.assert(
    quote.bundleDiscountCents === 1260,
    `a 3-unit loan discounts ${quote.bundleDiscountCents} cents; SPEC R4 makes it 1260 (10% of the base charge)`,
  );
  c.assert(
    quote.totalDueCents === 11340,
    `total due ${quote.totalDueCents} cents; SPEC R4 makes it 11340`,
  );
}
