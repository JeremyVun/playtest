export const id = "f-out-filter-drops-overdue";
export const title = "The Out filter includes overdue loans";

export async function check(c) {
  await c.reset();
  const { body } = await c.api("GET", "/api/loans?status=out");
  c.assert(
    body.shownCount === 3,
    `status=out listed ${body.shownCount} loans; SPEC §6.1 and §3.3 make it 3`,
  );
  c.assert(
    body.loans.some((loan) => loan.id === "L-1042"),
    "the overdue loan L-1042 is missing from the Out list (SPEC §6.1)",
  );
}
