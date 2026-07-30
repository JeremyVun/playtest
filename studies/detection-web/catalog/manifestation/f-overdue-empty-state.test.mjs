export const id = "f-overdue-empty-state";
export const title = "Overdue card keeps its empty state when nothing is overdue";

const EMPTY_STATE =
  'emptyState("No overdue loans", "Every loan that is out is still within its due date.")';

export async function check(c) {
  await c.reset();
  const checkin = await c.api("POST", "/api/loans/L-1042/checkin", { condition: "good" });
  c.assert(checkin.status === 200, `checking L-1042 in returned ${checkin.status}`);
  const { body } = await c.api("GET", "/api/overview");
  c.assert(body.overdue.length === 0, "the desk still reports overdue loans after the check-in");

  const source = await c.asset("/views/overview.js");
  c.assert(
    source.includes(EMPTY_STATE),
    "the served overview module no longer renders the 'No overdue loans' empty state (SPEC §4.2)",
  );
}
