export const id = "f-approvals-empty-action";
export const title = "The emptied approvals queue offers View all loans";

const EMPTY_ACTION = 'text: "View all loans"';

export async function check(c) {
  await c.reset();
  const approved = await c.api("POST", "/api/approvals/L-1044/approve");
  c.assert(approved.status === 200, `approving L-1044 returned ${approved.status}`);
  const declined = await c.api("POST", "/api/approvals/L-1045/decline", {
    reason: "Kit already committed to the open day.",
  });
  c.assert(declined.status === 200, `declining L-1045 returned ${declined.status}`);

  const queue = await c.api("GET", "/api/approvals");
  c.assert(queue.body.count === 0, `the queue still holds ${queue.body.count} requests`);

  const source = await c.asset("/views/approvals.js");
  c.assert(
    source.includes(EMPTY_ACTION),
    "the served approvals module's empty state offers no View all loans button (SPEC §8)",
  );
}
