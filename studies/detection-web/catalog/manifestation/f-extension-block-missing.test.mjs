export const id = "f-extension-block-missing";
export const title = "An out loan carries the Extension block";

const EXTENSION_BLOCK = "extensionBlock(loan),";

export async function check(c) {
  await c.reset();
  const loan = await c.api("GET", "/api/loans/L-1048");
  c.assert(loan.body.loan.status === "out", "L-1048 is not out, so the Extension block is not due");
  c.assert(
    loan.body.loan.actions.canExtend === true,
    "L-1048 is not extendable, so the Extension block cannot be judged",
  );

  const source = await c.asset("/views/loan-detail.js");
  c.assert(
    source.includes(EXTENSION_BLOCK),
    "the served loan module no longer renders the Extension block on an out loan (SPEC §6.2, §12.3)",
  );
}
