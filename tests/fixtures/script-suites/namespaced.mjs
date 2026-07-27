// A well-behaved mutating suite: everything it creates carries the run
// namespace, and it deletes what it created
// (docs/contracts/scripts.md#test-data-lifecycle).
export default async function ({ client, check, params }) {
  const health = await client.get("/health");
  check({
    id: "health-ok",
    obligation: "rule:health",
    title: "GET /health answers { ok: true }",
    pass: health.json?.ok === true,
    evidence: { requests: [health.ref] },
  });

  const created = await client.post("/items", { body: { name: client.name("ledger") } });
  const read = await client.get(`/items/${created.json?.id}`);
  check({
    id: "created-item-reads-back",
    obligation: "rule:mutation",
    title: "a created item reads back with the name it was created with",
    pass: read.json?.name === client.name("ledger"),
    expected: `{ name: ${JSON.stringify(client.name("ledger"))} }`,
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

  if (params.tidy !== false) await client.delete(`/items/${created.json?.id}`);
}
