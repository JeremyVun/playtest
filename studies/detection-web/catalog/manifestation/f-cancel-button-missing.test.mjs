export const id = "f-cancel-button-missing";
export const title = "Cancel loan is offered on ready and awaiting-approval loans";

export async function check(c) {
  await c.reset();
  const ready = await c.api("GET", "/api/loans/L-1043");
  c.assert(
    ready.body.loan.actions.canCancel === true,
    "L-1043 (ready for pickup) does not offer Cancel loan (SPEC §6.2, R12)",
  );
  const pending = await c.api("GET", "/api/loans/L-1044");
  c.assert(
    pending.body.loan.actions.canCancel === true,
    "L-1044 (awaiting approval) does not offer Cancel loan (SPEC §6.2, R12)",
  );
}
