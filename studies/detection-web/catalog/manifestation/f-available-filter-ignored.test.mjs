export const id = "f-available-filter-ignored";
export const title = "Available now only drops fully booked items";

export async function check(c) {
  await c.reset();
  const { body } = await c.api("GET", "/api/equipment?availableOnly=1");
  c.assert(
    body.shownCount === 11,
    `availableOnly=1 listed ${body.shownCount} of 12 items; SPEC §3.1 leaves 11 with free units`,
  );
  const booked = body.items.filter((item) => item.availableUnits === 0).map((item) => item.name);
  c.assert(
    booked.length === 0,
    `availableOnly=1 still lists fully booked items: ${booked.join(", ")} (SPEC §5.1)`,
  );
}
