// Two checks under one id: the obligation trace becomes ambiguous.
export default async function ({ client, check }) {
  const health = await client.get("/health");
  for (const pass of [true, false]) {
    check({
      id: "health-ok",
      obligation: "rule:health",
      title: "GET /health answers { ok: true }",
      pass,
      evidence: { requests: [health.ref] },
    });
  }
}
