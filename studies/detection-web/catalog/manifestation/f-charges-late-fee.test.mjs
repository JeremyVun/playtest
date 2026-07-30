export const id = "f-charges-late-fee";
export const title = "Charges booked today picks up a late fee taken today";

export async function check(c) {
  await c.reset();
  const before = (await c.api("GET", "/api/overview")).body.metrics.chargesBookedTodayCents;
  c.assert(before === 34100, `charges booked today start at ${before} cents; expected 34100`);

  const checkin = await c.api("POST", "/api/loans/L-1042/checkin", { condition: "good" });
  c.assert(checkin.status === 200, `checking L-1042 in returned ${checkin.status}`);
  const fee = checkin.body.lateFeeCents;
  c.assert(fee > 0, `checking the overdue loan in charged no late fee (${fee} cents)`);

  const after = (await c.api("GET", "/api/overview")).body.metrics.chargesBookedTodayCents;
  c.assert(
    after === before + fee,
    `charges booked today is ${after} cents after a ${fee} cent late fee; SPEC R6 makes it ${before + fee}`,
  );
}
