// A sound suite with a genuine finding: the check fails, nothing is defective.
export default async function ({ client, check }) {
  const health = await client.get("/health");
  check({
    id: "health-ok",
    obligation: "rule:health",
    title: "GET /health answers { ok: true }",
    pass: health.json?.ok === true,
    evidence: { requests: [health.ref] },
  });
  const items = await client.get("/items");
  check({
    id: "items-list-is-never-empty",
    obligation: "rule:items",
    title: "GET /items answers at least one item",
    pass: (items.json?.items ?? []).length > 0,
    expected: "at least one item",
    observed: `${(items.json?.items ?? []).length} items`,
    evidence: { requests: [items.ref] },
  });
}
