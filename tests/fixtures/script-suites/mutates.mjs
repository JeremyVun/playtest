// A mutating suite: it creates a resource and reads it back.
export default async function ({ client, check }) {
  const health = await client.get("/health");
  check({
    id: "health-ok",
    obligation: "rule:health",
    title: "GET /health answers { ok: true }",
    pass: health.json?.ok === true,
    evidence: { requests: [health.ref] },
  });
  const created = await client.post("/items", { body: { name: "ledger" } });
  const read = await client.get(`/items/${created.json?.id}`);
  check({
    id: "created-item-reads-back",
    obligation: "rule:mutation",
    title: "a created item reads back with the name it was created with",
    pass: read.json?.name === "ledger",
    expected: '{ name: "ledger" }',
    observed: read.text,
    evidence: { requests: [created.ref, read.ref] },
  });
  const list = await client.get("/items");
  check({
    id: "items-list-shape",
    obligation: "rule:items",
    title: "GET /items answers an items array",
    pass: Array.isArray(list.json?.items),
    evidence: { requests: [list.ref] },
  });
}
