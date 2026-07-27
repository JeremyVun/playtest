// Spends past the ceiling on purpose: the wire stops it, not the script.
export default async function ({ client, check }) {
  const health = await client.get("/health");
  check({
    id: "health-ok",
    obligation: "rule:health",
    title: "GET /health answers { ok: true }",
    pass: health.json?.ok === true,
    evidence: { requests: [health.ref] },
  });
  for (let index = 0; index < 500; index++) await client.get("/items");
}
