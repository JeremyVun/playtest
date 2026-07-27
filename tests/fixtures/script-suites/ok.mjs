// A sound, passing suite: both rule obligations covered, evidence cited.
export default async function ({ client, check }) {
  const health = await client.get("/health");
  check({
    id: "health-ok",
    obligation: "rule:health",
    title: "GET /health answers { ok: true }",
    pass: health.json?.ok === true,
    expected: "{ ok: true }",
    observed: health.text,
    evidence: { requests: [health.ref] },
  });
  const items = await client.get("/items");
  check({
    id: "items-list-shape",
    obligation: "rule:items",
    title: "GET /items answers an items array",
    pass: Array.isArray(items.json?.items),
    expected: "{ items: [] }",
    observed: items.text,
    evidence: { requests: [items] },
  });
}
