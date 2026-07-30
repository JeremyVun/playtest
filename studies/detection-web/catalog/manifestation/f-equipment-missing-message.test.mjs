export const id = "f-equipment-missing-message";
export const title = "Unknown catalogue item is refused with the equipment sentence";

export async function check(c) {
  await c.reset();
  const result = await c.api("GET", "/api/equipment/no-such-item");
  c.assert(result.status === 404, `unknown item returned ${result.status}, expected 404`);
  c.assert(
    result.body.error.message === "That equipment item does not exist.",
    `unknown item says "${result.body.error.message}"; SPEC §11 requires "That equipment item does not exist."`,
  );
}
