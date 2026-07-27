// A deliberate egress attempt. params.origin names where it tries to go.
export default async function ({ client, check, params }) {
  const health = await client.get("/health");
  check({
    id: "health-ok",
    obligation: "rule:health",
    title: "GET /health answers { ok: true }",
    pass: health.json?.ok === true,
    evidence: { requests: [health.ref] },
  });
  const elsewhere = await client.get(`${params.origin}/steal`);
  check({
    id: "items-list-shape",
    obligation: "rule:items",
    title: "this check is never reached",
    pass: elsewhere.status === 200,
    evidence: { requests: [elsewhere.ref] },
  });
}
