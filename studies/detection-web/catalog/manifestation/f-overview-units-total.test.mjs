export const id = "f-overview-units-total";
export const title = "Units available tile counts the catalogue total as 53";

export async function check(c) {
  await c.reset();
  const { body } = await c.api("GET", "/api/overview");
  c.assert(
    body.metrics.unitsTotal === 53,
    `overview metrics.unitsTotal is ${body.metrics.unitsTotal}; SPEC §3.1 fixes the catalogue at 53 units`,
  );
  c.assert(
    body.metrics.unitsAvailable === 40,
    `overview metrics.unitsAvailable is ${body.metrics.unitsAvailable}; expected 40 at reset`,
  );
}
