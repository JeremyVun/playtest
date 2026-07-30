export const id = "f-approve-pending-label";
export const title = "A running approval reads Approving…";

const PENDING_LABEL = '"Approving…",';

export async function check(c) {
  await c.reset();
  const approved = await c.api("POST", "/api/approvals/L-1044/approve");
  c.assert(approved.status === 200, `approving L-1044 returned ${approved.status}`);
  c.assert(
    approved.body.message === "L-1044 approved and moved to ready for pickup.",
    `the approval message reads "${approved.body.message}"`,
  );

  const source = await c.asset("/views/approvals.js");
  c.assert(
    source.includes(PENDING_LABEL),
    "the served approvals module labels a running approval with something other than Approving… (SPEC §8, §9)",
  );
}
