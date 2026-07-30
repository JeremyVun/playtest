export const id = "f-decline-status-line";
export const title = "A running decline shows Recording your decision…";

const STATUS_LINE = `                confirmButton,
                "Declining…",
                statusHost,
                "Recording your decision…",`;

export async function check(c) {
  await c.reset();
  const declined = await c.api("POST", "/api/approvals/L-1045/decline", {
    reason: "Kit already committed to the open day.",
  });
  c.assert(declined.status === 200, `declining L-1045 returned ${declined.status}`);
  c.assert(
    declined.body.message === "L-1045 declined. 2 units are back in stock.",
    `the decline message reads "${declined.body.message}"`,
  );

  const source = await c.asset("/views/approvals.js");
  c.assert(
    source.includes(STATUS_LINE),
    "the served approvals module never posts the Recording your decision… line while a decline runs (SPEC §8, §9)",
  );
}
