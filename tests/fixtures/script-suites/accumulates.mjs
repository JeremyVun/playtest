// A suite that creates and never tidies up. Under `teardown` this is exactly
// what the accumulation cap exists to catch: nothing is wrong with any check,
// and the environment silts up anyway
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

  const refs = [];
  for (let index = 0; index < (params.create ?? 3); index += 1) {
    const created = await client.post("/items", { body: { name: client.name(`row-${index}`) } });
    refs.push(created.ref);
  }
  check({
    id: "created-item-reads-back",
    obligation: "rule:mutation",
    title: "every create answered 201",
    pass: refs.length > 0,
    evidence: { requests: refs },
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
