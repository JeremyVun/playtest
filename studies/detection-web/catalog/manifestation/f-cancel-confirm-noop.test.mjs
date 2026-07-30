export const id = "f-cancel-confirm-noop";
export const title = "Yes, cancel loan sends the cancellation";

const CANCEL_CALL = "post(`/api/loans/${loan.id}/cancel`)";

export async function check(c) {
  await c.reset();
  const loan = await c.api("GET", "/api/loans/L-1043");
  c.assert(
    loan.body.loan.actions.canCancel === true,
    "L-1043 is not cancellable, so the confirmation block cannot be reached",
  );

  const source = await c.asset("/views/loan-detail.js");
  c.assert(
    source.includes(CANCEL_CALL),
    "the served loan module's Yes, cancel loan button no longer posts the cancellation (SPEC §6.2, R12)",
  );
}
