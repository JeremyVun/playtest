// A script defect AFTER a passing check: the thrown error must not read as a
// check outcome, and the passing check must survive (it was streamed).
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
  void items;
  throw new Error("the fixture threw on purpose");
}
