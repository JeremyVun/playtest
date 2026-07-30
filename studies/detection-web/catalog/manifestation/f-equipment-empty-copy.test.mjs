export const id = "f-equipment-empty-copy";
export const title = "Empty catalogue result quotes the search term back";

const SEARCH_COPY = "Nothing in the catalogue matches";

export async function check(c) {
  await c.reset();
  const { body } = await c.api("GET", "/api/equipment?q=zeppelin");
  c.assert(body.shownCount === 0, `searching for "zeppelin" matched ${body.shownCount} items`);

  const source = await c.asset("/views/equipment-list.js");
  c.assert(
    source.includes(SEARCH_COPY),
    "the served catalogue module never uses the searched-for empty-state body (SPEC §5.1)",
  );
}
